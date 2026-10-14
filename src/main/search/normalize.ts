// Turning arbitrary upstream paper metadata into the ONE shape the studio uses.
//
// This lives in the studio, not in the search server, on purpose: the canonical
// shape is a property of Corpus Studio's data model (`WebSearchRecord` feeds
// `WebSearchResultDTO`, which feeds ingest). A generic search server has no
// business knowing it, and every consumer of that server would otherwise be
// coupled to our schema.

import { plainText, unescapeMarkup } from '../../shared/markup'
import type { WebSearchRecord } from '../adapters'
import { cleanAbstract, latexToText } from '../../shared/latex'

/** Loosely-typed upstream row: every field is suspect until proven otherwise. */
export type RawHit = Record<string, unknown>

/**
 * Control characters and the bidi overrides, which make what is STORED and what
 * is READ differ: `\r` hides everything before it in a terminal, and U+202E
 * reverses the rest of a line on screen while leaving the bytes alone.
 */
const UNSAFE_CHARS = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g


/** Longest each field may be. */
const CAPS = { title: 1000, abstract: 40_000, venue: 300, type: 100, author: 200, id: 200 }

/**
 * THIS IS A TRUST BOUNDARY, and the bounds below are what makes it one.
 *
 * Every field here arrives from a SEARCH PLUGIN — a folder a stranger wrote —
 * and lands in the database, in a dedup key, and rendered verbatim in a result
 * row. So each is length-bounded and stripped of the characters that make a
 * rendered string differ from a stored one.
 *
 * TRUNCATED rather than refused, unlike `manifest.ts`, and the difference is the
 * subject. A plugin's name is an identity claim, so silently shortening it means
 * the plugin the user sees is not the one on disk. This is upstream metadata of
 * unknown quality: a paper whose abstract is a megabyte is still that paper, and
 * dropping the row would lose a real result over a field nobody reads to the end.
 *
 * It bounds a MISTAKE as much as an attack, which is the commoner case — an index
 * answering a bad query with its own error page in the `title` field puts a wall
 * of markup in a result row.
 */
const str = (v: unknown, max: number = CAPS.title): string | null => {
  if (typeof v === 'string') {
    // MARKUP IS KEPT, deliberately.
    //
    // It was stripped here for one commit, which was a mistake: `<i>` around a
    // species name and `<sub>` in a formula are information the publisher
    // encoded, and `T<sub>m</sub>` flattened to `Tm` is a different string from
    // the one the paper prints. The renderer formats it (`RichText`) and the
    // plain-text consumers — dedup keys, exports, prompts — strip it for
    // themselves, so the stored value stays faithful to the source.
    const t = v.replace(UNSAFE_CHARS, ' ').trim().slice(0, max)
    return t.length > 0 ? t : null
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return null
}

/**
 * Coerce a year from the several shapes upstreams use: a number, a string, or a
 * full date ("2024-03-11", "2024/03/11"). Anything outside a plausible range is
 * rejected rather than displayed — a year of 0 or 20240311 is worse than none.
 */
export function toYear(v: unknown): number | null {
  if (v === null || v === undefined) return null
  let n: number | null = null
  if (typeof v === 'number') n = Math.trunc(v)
  else if (typeof v === 'string') {
    const m = v.match(/\d{4}/)
    if (m) n = Number.parseInt(m[0], 10)
  }
  if (n === null || !Number.isFinite(n)) return null
  // Upper bound is deliberately loose: papers legitimately carry a "next year"
  // publication date, and rejecting those would hide the newest work.
  return n >= 1400 && n <= new Date().getUTCFullYear() + 2 ? n : null
}

/**
 * Normalize an author list. Upstreams variously give an array of strings, an
 * array of `{given, family}` objects, or one delimited string.
 *
 * bioRxiv is the reason for the semicolon split: it returns authors as
 * "Rakibova, Y.; Dunham, D. T.; Seed, K." — splitting on commas alone turned
 * three authors into six fragments like "Y." and " Dunham".
 */
/**
 * At most this many authors on one record.
 *
 * A real paper can genuinely have a thousand (the ATLAS collaboration does), and
 * this row is a search RESULT: it shows three and "+N more". Keeping every name
 * to store them is a list nobody reads and an unbounded array from a stranger.
 */
const MAX_AUTHORS = 250

export function toAuthors(v: unknown): string[] {
  const out: string[] = []
  const push = (s: string | null): void => {
    if (out.length >= MAX_AUTHORS) return
    if (s && !out.includes(s)) out.push(s)
  }

  if (Array.isArray(v)) {
    for (const a of v) {
      if (typeof a === 'string') {
        // An array element may itself be a delimited run of names.
        if (a.includes(';')) a.split(';').forEach((p) => push(str(p, CAPS.author)))
        else push(str(a, CAPS.author))
      } else if (a && typeof a === 'object') {
        const o = a as Record<string, unknown>
        const given = str(o.given) ?? str(o.first) ?? ''
        const family = str(o.family) ?? str(o.last) ?? ''
        push(str(`${given} ${family}`, CAPS.author) ?? str(o.name, CAPS.author))
      }
    }
  } else if (typeof v === 'string') {
    v.split(';').forEach((p) => push(str(p)))
  }
  return out
}

/** Strip the markup and boilerplate prefixes upstream abstracts arrive wrapped in. */
export function toAbstract(v: unknown): string {
  const s = str(v, CAPS.abstract)
  if (s === null) return ''
  // Same escaped-markup resolution as the title. `cleanAbstract` strips tags,
  // and it can only strip the ones it can see: an abstract whose JATS arrived
  // encoded kept its `<sub>`s as visible text through every consumer.
  return cleanAbstract(unescapeMarkup(s))
}

/**
 * Extract a bare DOI from whatever carries it — a raw DOI, a doi.org URL, or a
 * prefixed "doi:10.x" string. Lowercased because DOIs are case-insensitive and
 * this value is a dedup key.
 */
export function toDoi(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    const s = str(c)
    if (s === null) continue
    // BOUNDED. `[^\s"<>]+` is unbounded, and a DOI is a dedup key and a lookup
    // handle -- a 4 KB "DOI" is not one, whatever it matched.
    const m = s.match(/10\.\d{4,9}\/[^\s"<>]{1,180}/)
    if (m) return m[0].toLowerCase().replace(/[.,;)]+$/, '')
  }
  return null
}

/**
 * An id fit to be half of an `external_id`.
 *
 * The separator is `:`, so anything that could BE a separator is replaced rather
 * than allowed through — see the note at the call site. Whitespace goes for the
 * same reason a key with a newline in it is not a key.
 */
function slugId(raw: string | null): string | null {
  if (raw === null) return null
  const s = raw.replace(/[^A-Za-z0-9._/-]+/g, '-').replace(/^-+|-+$/g, '')
  return s.length > 0 ? s : null
}

const toCount = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseInt(v, 10) : NaN
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
}

/**
 * Normalize a title for dedup: case-folded, punctuation stripped, whitespace
 * collapsed. Two records agreeing here are the same paper for our purposes even
 * when their DOIs differ (a preprint and its published version often do).
 *
 * MARKUP IS REMOVED FIRST, and it has to be. Titles are stored with the
 * publisher's inline formatting intact — that is information, and the renderer
 * shows it — but a TAG NAME IS NOT PART OF THE TITLE. Folding punctuation
 * turned `<i>trans</i>` into the words `i trans i`, so the same paper keyed
 * differently depending on which index answered: Crossref's copy (with JATS)
 * and PubMed's (without) were two papers, splitting their citations and
 * analyses across two rows — exactly what this function exists to prevent.
 */
export function normalizeTitle(title: string): string {
  return plainText(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Build a canonical record from one upstream hit, or `null` if it is unusable.
 *
 * A hit with no title is dropped: the title is the only field the UI cannot
 * render a row without, and a placeholder row is worse than a missing one — it
 * is selectable, importable, and becomes a junk work in the corpus.
 *
 * `external_id` prefers the DOI (stable and globally unique), then an
 * upstream-native id, then the source-scoped normalized title. It is the
 * renderer's row key and its in-flight-import handle, so it must be stable
 * across repeated identical searches.
 *
 * `sourceLabel` is what the USER is shown as the origin of the row, so it is the bare
 * index name ("arxiv", "pubmed") rather than `sourceId`, which is namespaced by the
 * transport that fetched it. Which of our adapters made the call is our plumbing and
 * means nothing to a reader deciding where a paper can be downloaded from.
 */
export function normalizeHit(
  raw: RawHit,
  sourceId: string,
  sourceLabel: string = sourceId
): WebSearchRecord | null {
  // Titles carry LaTeX exactly as abstracts do — "Maximizing $H$-colorings"
  // appears verbatim in arXiv and CrossRef metadata. Cleaning here rather than
  // at render time means the STORED title and the dedup key are clean too,
  // so "$k$-colorings" and "k-colorings" from two indexes match each other.
  // `unescapeMarkup` FIRST, and at ingest rather than at render. Europe PMC
  // HTML-encodes the JATS in a title, so the field arrives as
  // `&lt;i&gt;…&lt;/i&gt;` — markup the renderer cannot see and therefore prints
  // verbatim. Resolving it here means the STORED value has one shape whichever
  // way an index spells it, so the dedup key, the export and the text handed to
  // a model all agree, and the same paper from two indexes matches itself.
  const rawTitle = str(raw.title)
  const title = rawTitle === null ? null : latexToText(unescapeMarkup(rawTitle))
  if (title === null || title.length === 0) return null

  const doi = toDoi(raw.doi, raw.DOI, raw.url, raw.link)
  // SLUGGED, and that is the whole of the namespacing's guarantee. `external_id`
  // is `<source>:<id>`, so an upstream id that itself contains a colon lets a row
  // claim another source's key -- and `dedupeRecords` below prefers the LONGER
  // title, so the impostor wins the merge against the honest index it collided
  // with. A separator that the id may contain is not a separator.
  const nativeId = slugId(
    str(raw.arxiv_id, CAPS.id) ?? str(raw.pmc_id, CAPS.id) ?? str(raw.pmid, CAPS.id) ?? str(raw.id, CAPS.id)
  )
  const external_id = doi ?? (nativeId ? `${sourceId}:${nativeId}` : `${sourceId}:${normalizeTitle(title)}`)

  return {
    external_id,
    title: title.replace(/\s+/g, ' '),
    abstract: toAbstract(raw.abstract ?? raw.summary ?? raw.description),
    authors: toAuthors(raw.authors ?? raw.author),
    year: toYear(raw.year ?? raw.published ?? raw.date ?? raw.publication_year),
    venue: str(raw.journal ?? raw.venue ?? raw.container_title ?? raw.source_title, CAPS.venue),
    doi,
    citation_count: toCount(raw.citations ?? raw.citation_count ?? raw.is_referenced_by_count),
    sources: [sourceLabel],
    // Read ONLY from fields the upstream actually populated. There is deliberately no
    // fallback that derives a type from the title, the venue or the source name: a paper
    // whose index said nothing must reach the UI with null so the UI can stay silent.
    type: str(raw.type ?? raw.work_type ?? raw.publication_type, CAPS.type)
  }
}

/**
 * Collapse records describing the same paper, keeping the RICHEST version.
 *
 * Cross-source overlap is the norm, not the exception: a paper indexed by both
 * CrossRef and PubMed arrives twice with disjoint fields (one has the DOI and
 * citation count, the other the PDF link). Preferring whichever arrived first
 * would discard real data, so fields are merged field-by-field, each taking the
 * first non-empty value.
 *
 * Matching is by DOI first, then by normalized title, because a preprint and
 * its published version share a title but not a DOI.
 */
export function dedupeRecords(records: WebSearchRecord[]): WebSearchRecord[] {
  // Each record is indexed under BOTH its DOI and its normalized title, and
  // both keys point at the same merged row.
  //
  // Keying on "DOI if present, else title" looked equivalent and was not: the
  // richest real case is one index knowing the DOI while another does not (a
  // CrossRef record and an arXiv record of the same paper), and those two land
  // under different keys and never meet. Indexing under every identifier a
  // record carries is what makes them collide.
  const groups: WebSearchRecord[] = []
  const keyToGroup = new Map<string, number>()
  const keysOf = (r: WebSearchRecord): string[] => {
    const keys = [`title:${normalizeTitle(r.title)}`]
    if (r.doi !== null) keys.push(`doi:${r.doi}`)
    return keys
  }

  for (const rec of records) {
    const keys = keysOf(rec)
    const hit = keys.map((k) => keyToGroup.get(k)).find((i) => i !== undefined)
    if (hit === undefined) {
      const idx = groups.length
      groups.push(rec)
      for (const k of keys) keyToGroup.set(k, idx)
      continue
    }
    const prev = groups[hit]
    const merged: WebSearchRecord = {
      // Keep the surviving row's identity stable, but upgrade it to a DOI if
      // this duplicate is the one that knew it.
      external_id: prev.doi !== null ? prev.external_id : (rec.doi ?? prev.external_id),
      title: prev.title.length >= rec.title.length ? prev.title : rec.title,
      abstract: prev.abstract || rec.abstract,
      authors: prev.authors.length > 0 ? prev.authors : rec.authors,
      year: prev.year ?? rec.year,
      venue: prev.venue ?? rec.venue,
      doi: prev.doi ?? rec.doi,
      // Counts come from different indexes and are not additive; the larger is
      // the better-informed one.
      citation_count: Math.max(prev.citation_count, rec.citation_count),
      // The UNION, not the first: this merge is the only place that knows a paper was
      // returned by more than one index, and that is precisely the fact the user asked
      // to see. Every other field here narrows to one value; this one must not.
      sources: [...prev.sources, ...rec.sources.filter((s) => !prev.sources.includes(s))],
      // First non-null wins, and a disagreement is not resolved by preferring the more
      // interesting answer -- ranking type vocabularies against each other would be us
      // deciding that "review" beats "journal-article", which no index asked for.
      type: prev.type ?? rec.type
    }
    groups[hit] = merged
    // The merge may have taught this group a DOI it did not have, so re-index
    // it under every key it now answers to — otherwise a THIRD record carrying
    // only that DOI would start a new group.
    for (const k of keysOf(merged)) keyToGroup.set(k, hit)
  }
  return groups
}
