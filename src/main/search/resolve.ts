// Resolving a paper the user ALREADY has an identifier for.
//
// This is a different question from search: the user is not exploring, they are
// naming one specific paper. So it takes a DOI / arXiv id / PMID and returns
// that paper's real metadata, rather than a ranked list of guesses.
//
// It matters that this is a lookup and not a search. Feeding a DOI to a
// free-text index returns nonsense — querying CrossRef's search endpoint for
// "10.1038/nature17946" came back with a 1993 article titled "Membership
// Applications Received". The identifier endpoints below address a record
// directly, so they either return the right paper or nothing.

import { normalizeHit, toDoi } from './normalize'
import type { WebSearchRecord } from '../adapters'

/** The kinds of identifier a paper can be named by. */
export type IdentifierKind = 'doi' | 'arxiv' | 'pmid'

export interface ParsedIdentifier {
  kind: IdentifierKind
  /** The bare identifier, stripped of any prefix or URL wrapper. */
  value: string
}

/**
 * Recognise an identifier in whatever form it was pasted.
 *
 * Users paste what they copied — a bare DOI, a doi.org link, an arXiv abs page,
 * "PMID: 27096365". All of those name a paper, so all of them are accepted;
 * anything unrecognised returns null and is treated as a title instead.
 */
export function parseIdentifier(raw: string): ParsedIdentifier | null {
  const v = raw.trim()
  if (v.length === 0) return null

  const doi = toDoi(v)
  if (doi !== null) return { kind: 'doi', value: doi }

  const arxiv = v.match(/arxiv\.org\/(?:abs|pdf)\/([^\s?#]+?)(?:\.pdf)?$/i) ?? v.match(/^arxiv:\s*(.+)$/i)
  if (arxiv) return { kind: 'arxiv', value: arxiv[1].trim() }
  // A bare modern arXiv id (2301.00001v2) or a legacy one (cond-mat/0207270).
  if (/^\d{4}\.\d{4,5}(v\d+)?$/i.test(v)) return { kind: 'arxiv', value: v }
  if (/^[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?$/i.test(v)) return { kind: 'arxiv', value: v }

  const pmid = v.match(/^pmid:?\s*(\d{1,9})$/i) ?? v.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d{1,9})/i)
  if (pmid) return { kind: 'pmid', value: pmid[1] }
  if (/^\d{5,9}$/.test(v)) return { kind: 'pmid', value: v }

  return null
}

/** Resolves an identifier to real metadata, or null when nothing has it. */
export interface IdentifierResolver {
  resolve(id: ParsedIdentifier, signal?: AbortSignal): Promise<WebSearchRecord | null>
}

const UA = 'CorpusStudio/1.0 (local research tool)'

async function getJson(url: string, signal?: AbortSignal): Promise<unknown | null> {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal })
  // 404 is a legitimate answer — that identifier is simply not in this index —
  // so it is null rather than an error the caller has to special-case.
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`lookup failed (HTTP ${res.status})`)
  return res.json()
}

/**
 * Resolve against the public academic APIs directly.
 *
 * These are plain metadata lookups over HTTPS with no scraping, so they do not
 * need the web-search server's browser machinery. Going direct also means an
 * identifier still resolves when that server is not running.
 */
export class AcademicIdentifierResolver implements IdentifierResolver {
  async resolve(id: ParsedIdentifier, signal?: AbortSignal): Promise<WebSearchRecord | null> {
    if (id.kind === 'doi') return this.byDoi(id.value, signal)
    if (id.kind === 'arxiv') return this.byArxiv(id.value, signal)
    return this.byPmid(id.value, signal)
  }

  private async byDoi(doi: string, signal?: AbortSignal): Promise<WebSearchRecord | null> {
    // An arXiv DOI is NOT in CrossRef, and asking CrossRef for one 404s — which
    // this resolver reads as "no index has it" and the import refuses, telling
    // the user their identifier is unrecognised. arXiv registers its DOIs with
    // DataCite instead, so `10.48550/arXiv.2411.17538` was rejected by an app
    // that had just returned that very DOI from its own search.
    //
    // The id is embedded in the DOI, so the fix is to ask the arXiv resolver we
    // already have rather than to add a DataCite client: it returns the richer
    // record (abstract, authors, the published DOI when one exists) and it is
    // the same path a bare `arxiv:2411.17538` takes, so one paper cannot resolve
    // two different ways depending on which identifier the caller happened to
    // hold. Case-insensitive because `toDoi` lowercases and arXiv writes `arXiv`.
    const arxivDoi = doi.match(/^10\.48550\/arxiv\.(.+)$/i)
    if (arxivDoi) return this.byArxiv(arxivDoi[1], signal)

    const body = (await getJson(
      `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
      signal
    )) as { message?: Record<string, unknown> } | null
    const m = body?.message
    if (!m) return null

    // CrossRef nests the year inside published.date-parts[0][0], and titles and
    // container-titles are arrays even when there is only one.
    const dateParts = (m.published as { 'date-parts'?: number[][] } | undefined)?.['date-parts']
    return normalizeHit(
      {
        title: Array.isArray(m.title) ? m.title[0] : m.title,
        doi: m.DOI,
        year: dateParts?.[0]?.[0],
        journal: Array.isArray(m['container-title']) ? m['container-title'][0] : undefined,
        authors: m.author,
        citations: m['is-referenced-by-count'],
        // CrossRef abstracts are JATS XML; normalizeHit strips the tags.
        abstract: m.abstract
      },
      'crossref'
    )
  }

  private async byArxiv(arxivId: string, signal?: AbortSignal): Promise<WebSearchRecord | null> {
    const res = await fetch(
      `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`,
      { headers: { 'User-Agent': UA }, signal }
    )
    if (!res.ok) throw new Error(`arXiv lookup failed (HTTP ${res.status})`)
    const xml = await res.text()

    const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/)?.[1]
    if (!entry) return null
    // arXiv reports a bad id as an entry titled "Error" rather than an HTTP
    // error, so a malformed id would otherwise become a paper called "Error".
    const tag = (name: string): string | null =>
      entry.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1].replace(/\s+/g, ' ').trim() ?? null
    const title = tag('title')
    if (title === null || title === 'Error') return null

    const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => m[1].trim())
    return normalizeHit(
      {
        title,
        abstract: tag('summary'),
        authors,
        published: tag('published'),
        // arXiv links a published DOI when one exists, which lets the record
        // merge with the same paper from CrossRef.
        doi: entry.match(/<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/)?.[1].trim(),
        arxiv_id: arxivId,
        journal: entry.match(/<arxiv:journal_ref[^>]*>([\s\S]*?)<\/arxiv:journal_ref>/)?.[1].trim()
      },
      'arxiv'
    )
  }

  private async byPmid(pmid: string, signal?: AbortSignal): Promise<WebSearchRecord | null> {
    const body = (await getJson(
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${encodeURIComponent(pmid)}&retmode=json`,
      signal
    )) as { result?: Record<string, Record<string, unknown>> } | null
    const rec = body?.result?.[pmid]
    // esummary answers an unknown id with a record carrying an `error` field
    // instead of a 404.
    if (!rec || rec.error !== undefined) return null

    const ids = (rec.articleids as { idtype?: string; value?: string }[] | undefined) ?? []
    return normalizeHit(
      {
        title: rec.title,
        doi: ids.find((x) => x.idtype === 'doi')?.value,
        pmid,
        year: rec.pubdate,
        journal: rec.fulljournalname,
        authors: (rec.authors as { name?: string }[] | undefined)?.map((a) => a.name)
      },
      'pubmed'
    )
  }
}

/**
 * Find a paper by a BIBLIOGRAPHIC STRING — a filename, a printed citation line,
 * anything a person would recognise the paper from.
 *
 * Crossref's `query.bibliographic` is built for exactly this: an unstructured
 * string it matches against its own corpus. It ALWAYS answers, and its answer
 * is a ranked guess rather than an identification, so the single result is a
 * CANDIDATE the caller must verify against what it already knows. Returning the
 * whole record rather than a DOI is what lets the caller do that.
 *
 * `mailto` puts the request in Crossref's polite pool, which is a real and
 * measurable difference in how quickly it answers.
 */
export async function searchByBibliographic(
  query: string,
  opts: { mailto?: string; signal?: AbortSignal } = {}
): Promise<WebSearchRecord | null> {
  const u = new URL('https://api.crossref.org/works')
  u.searchParams.set('query.bibliographic', query.slice(0, 512))
  u.searchParams.set('rows', '1')
  u.searchParams.set('select', 'DOI,title,author,issued,container-title,abstract,is-referenced-by-count')
  if (opts.mailto) u.searchParams.set('mailto', opts.mailto)

  const body = (await getJson(u.toString(), opts.signal)) as {
    message?: { items?: Record<string, unknown>[] }
  } | null
  const m = body?.message?.items?.[0]
  if (!m) return null

  const issued = (m.issued as { 'date-parts'?: number[][] } | undefined)?.['date-parts']
  return normalizeHit(
    {
      title: Array.isArray(m.title) ? m.title[0] : m.title,
      doi: m.DOI,
      year: issued?.[0]?.[0],
      journal: Array.isArray(m['container-title']) ? m['container-title'][0] : undefined,
      authors: m.author,
      citations: m['is-referenced-by-count'],
      abstract: m.abstract
    },
    'crossref'
  )
}
