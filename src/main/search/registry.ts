// The pluggable search registry: sources can be added and removed at runtime,
// and the studio's search semantics are applied CENTRALLY to whatever they
// return.
//
// Why centrally: scoring, filtering-before-capping, sorting and dedup are
// contracts the UI depends on. If each source implemented them, adding a source
// would silently change what "top 20" or "min citations" means — and a source
// that filtered AFTER its own cap would drop matches the user asked for, which
// is exactly the bug the DB-side search comments warn about.

import type { RetrievalProvider, WebSearchOptions, WebSearchRecord } from '../adapters'
import { authorNeedles, queryAlternatives, scoreRecord } from '../adapters'
import { dedupeRecords } from './normalize'
import { PAPER_SEARCH_OFF_SENTENCE } from '../../shared/contract/plugins'
import type { SearchSource, SourceFailure } from './types'

/**
 * How many raw hits to pull from EACH source before merging.
 *
 * Deliberately larger than the user's limit: filters and dedup run after the
 * fetch, so fetching exactly `limit` per source would leave fewer than `limit`
 * rows the moment anything is filtered or merged away.
 */
const OVERFETCH = 3

/**
 * Longest a single source may hold up a search before it is abandoned.
 *
 * This is the timeout that BINDS for search, and intentionally so. The bridge client allows
 * an hour, but that budget exists for PDF retrieval, where a tab is open and a human may be
 * solving a challenge.
 *
 * Five minutes, not the 25s this used to be. One "source" here is the extension, and one
 * call to it fans out to every index it knows; the reply comes back only when the SLOWEST
 * has answered or given up. PubMed and Crossref both rate-limit an unkeyed caller into
 * multi-second waits, so a query that was working perfectly well routinely crossed 25s and
 * was reported to the user as "timed out" — a failure message about a search that would
 * have succeeded. The deadline exists to stop a permanently hung socket, not to express an
 * opinion about how fast an index ought to be.
 */
const SOURCE_TIMEOUT_MS = 5 * 60 * 1000

export class SearchSourceRegistry implements RetrievalProvider {
  readonly name = 'search-registry'
  /** Failures from the most recent search, for diagnostics. */
  private lastFailures: SourceFailure[] = []

  /**
   * Where the sources come from, ASKED EACH TIME rather than held.
   *
   * The set of sources is the set of enabled plugins that can search, and that
   * changes under the app's feet: a plugin can be switched off, reconfigured or
   * removed between one search and the next. A registry holding its own
   * registrations would be a second copy of the enabled state, and the way it
   * fails is a search still reaching a plugin the user has switched off.
   *
   * A FUNCTION, injected, so this class still knows nothing about plugins and
   * can be constructed with a fixed list by a test.
   */
  constructor(private readonly sourcesOf: () => SearchSource[]) {}

  list(): { id: string; label: string }[] {
    return this.active().map((s) => ({ id: s.id, label: s.label }))
  }

  failures(): SourceFailure[] {
    return this.lastFailures
  }

  private active(): SearchSource[] {
    return this.sourcesOf()
  }

  async searchWeb(query: string, opts: WebSearchOptions = {}): Promise<WebSearchRecord[]> {
    const {
      limit = 20,
      page = 1,
      yearFrom,
      yearTo,
      minCitations,
      author,
      sources: onlySources,
      sort = 'relevance'
    } = opts
    const alternatives = queryAlternatives(query)
    if (alternatives.length === 0) return []

    const sources = this.active()
    // No source to ask is not "no papers exist" — it is a search that never
    // happened, and it must not be presented as an answer.
    if (sources.length === 0) {
      // The CONTRACT-OWNED sentence, matched by identity by the renderer, which
      // draws its "nothing here can search" state rather than an error. Those
      // are different things and looked identical while this was its own prose:
      // an install with no search plugin was told its search had failed.
      throw new Error(PAPER_SEARCH_OFF_SENTENCE)
    }

    // One source failing must not fail the search: a partial result from the
    // sources that answered is strictly more useful than an error page, and the
    // failure is recorded rather than swallowed.
    const settled = await Promise.allSettled(
      sources.map((s) => this.fetchFrom(s, query, limit * OVERFETCH, page, { yearFrom, yearTo, author }))
    )
    const failures: SourceFailure[] = []
    const raw: WebSearchRecord[] = []
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') raw.push(...r.value)
      else {
        failures.push({
          sourceId: sources[i].id,
          message: r.reason instanceof Error ? r.reason.message : String(r.reason)
        })
      }
    })
    this.lastFailures = failures

    // Every source failed: there is no result to report, and reporting none is
    // a lie. "Nothing found" and "we could not ask" look identical in a list of
    // zero rows, and the first tells the user their query was answered — so a
    // total failure is raised, and the UI renders its error state with a retry
    // instead of an empty-results conclusion the search never reached.
    if (failures.length === sources.length) {
      // UNLESS what every source said is that it is no longer there. A plugin
      // switched off mid-search leaves the install in exactly the state the
      // branch above describes, and wrapping the sentence in "Search
      // unavailable — " defeats the identity match that draws the "nothing here
      // can search" state — turning it back into the error page this sentence
      // exists to avoid.
      if (failures.every((f) => f.message === PAPER_SEARCH_OFF_SENTENCE)) {
        throw new Error(PAPER_SEARCH_OFF_SENTENCE)
      }
      throw new Error(
        failures.length === 1
          ? `Search unavailable — ${failures[0].message}`
          : `Search unavailable — every source failed: ${failures.map((f) => `${f.sourceId}: ${f.message}`).join('; ')}`
      )
    }

    const needles = authorNeedles(author)
    // Lower-cased once: the extension spells a preprint server the way it spells
    // itself (`chemRxiv`), while an index id arrives bare (`arxiv`), so a
    // caller's casing must not decide whether their filter matches anything.
    const wantedSources = new Set((onlySources ?? []).map((s) => s.toLowerCase()))
    const scored = dedupeRecords(raw)
      .map((rec) => ({
        rec,
        // Each OR-alternative scored on its own, best wins. The union semantics
        // live HERE rather than in any source, so adding or removing an upstream
        // cannot change how a query is interpreted.
        score: Math.max(...alternatives.map((tokens) => scoreRecord(rec, tokens)))
      }))
      // Upstreams already matched the query their own way; a record they
      // returned that scores zero locally (e.g. the terms are in the full text,
      // not the title or abstract we can see) is still a legitimate hit, so it
      // is kept and simply ranks last.
      .filter(({ rec }) => {
        if (yearFrom !== undefined && (rec.year === null || rec.year < yearFrom)) return false
        if (yearTo !== undefined && (rec.year === null || rec.year > yearTo)) return false
        if (minCitations !== undefined && rec.citation_count < minCitations) return false
        // ANY of the wanted indexes, not all: a paper several returned is the
        // best-attested hit there is, and an "every" rule would drop it first.
        if (
          wantedSources.size > 0 &&
          !rec.sources.some((s) => wantedSources.has(s.toLowerCase()))
        ) {
          return false
        }
        if (
          needles.length > 0 &&
          !rec.authors.some((a) => needles.some((n) => a.toLowerCase().includes(n)))
        ) {
          return false
        }
        return true
      })

    const byTitle = (a: { rec: WebSearchRecord }, b: { rec: WebSearchRecord }): number =>
      a.rec.title.localeCompare(b.rec.title)
    scored.sort((a, b) => {
      if (sort === 'year') return (b.rec.year ?? 0) - (a.rec.year ?? 0) || byTitle(a, b)
      // Undated papers sort LAST either way. Treating a missing year as 0 would
      // float them to the top of an oldest-first list, where they would look
      // like the earliest work rather than papers of unknown date.
      if (sort === 'year-asc') {
        return (a.rec.year ?? Infinity) - (b.rec.year ?? Infinity) || byTitle(a, b)
      }
      if (sort === 'citations') return b.rec.citation_count - a.rec.citation_count || byTitle(a, b)
      return b.score - a.score || byTitle(a, b)
    })

    return scored.slice(0, limit).map((r) => r.rec)
  }

  /** Run one source under its own timeout so a hung upstream cannot pin the search. */
  private async fetchFrom(
    source: SearchSource,
    query: string,
    limit: number,
    page: number,
    filters: { yearFrom?: number; yearTo?: number; author?: string } = {}
  ): Promise<WebSearchRecord[]> {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), SOURCE_TIMEOUT_MS)
    try {
      // The filters go DOWN as well as being applied locally below. A source that ignores
      // them stays correct because the local pass still runs; one that honours them returns
      // a full page of useful rows instead of a page that is mostly discarded.
      return await source.search(query, { limit, page, signal: ctl.signal, ...filters })
    } catch (e) {
      // Report a timeout as a timeout. The raw abort surfaces as the opaque
      // "This operation was aborted", which reads like a bug rather than a slow
      // upstream.
      if (ctl.signal.aborted) throw new Error(`${source.label} timed out`)
      throw e
    } finally {
      clearTimeout(timer)
    }
  }
}
