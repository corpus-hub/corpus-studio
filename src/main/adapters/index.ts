// The shared vocabulary of paper retrieval: the record shape every search
// source normalises to, the options a search is narrowed by, and the query
// tokenising and scoring the registry applies to whatever the sources return.
//
// Nothing here fabricates a result. Every record the studio shows came from an
// upstream index over the wire, so a title, a DOI or a citation count on screen
// is attributable to a real publisher record rather than to this repository.

import { createHash } from 'node:crypto'

// ---------------------------------------------------------------- interfaces

/**
 * One record as returned by the external literature search. These papers are by
 * definition NOT in the corpus — they are what an upstream index handed back,
 * before anything is imported.
 */
export interface WebSearchRecord {
  external_id: string
  title: string
  abstract: string
  authors: string[]
  year: number | null
  venue: string | null
  doi: string | null
  citation_count: number
  /**
   * EVERY index that returned this paper, in the order they were merged.
   *
   * A list rather than a single value because cross-source overlap is the norm, and
   * which indexes hold a paper is a fact about its AVAILABILITY that the user wants —
   * a paper on arXiv as well as in PubMed can be fetched without a paywall. Dedup used
   * to collapse these to one silently; keeping the list is the whole point.
   */
  sources: string[]
  /**
   * What KIND of document, verbatim from whichever index stated one, or null.
   *
   * Null is the honest answer for an index that says nothing. Nothing downstream may
   * infer this from a title or a venue — a guess is indistinguishable from a fact once
   * it is in the field.
   */
  type: string | null
}

/**
 * How a web search is narrowed and ordered.
 *
 * Filters are applied BEFORE the cap, so "the top 20" means the top 20 of what
 * the user actually asked for rather than the top 20 overall, filtered down to
 * whatever happened to survive.
 */
export interface WebSearchOptions {
  limit?: number
  /** 1-based page, paged at the upstream index rather than by local slicing. */
  page?: number
  yearFrom?: number
  yearTo?: number
  minCitations?: number
  /** Substring match against any author's name, case-insensitive. */
  author?: string
  /**
   * Keep only records at least ONE of these indexes returned. Empty = no filter.
   *
   * Matched against `WebSearchRecord.sources`, so the ids are the individual
   * indexes a hit is attributed to, not the registry's source ids.
   */
  sources?: string[]
  sort?: WebSearchSort
}

export type WebSearchSort = 'relevance' | 'year' | 'year-asc' | 'citations'

export interface RetrievalProvider {
  readonly name: string
  /** Free-text search over the abstracts of papers outside the corpus. */
  searchWeb(query: string, opts?: WebSearchOptions): Promise<WebSearchRecord[]>
}

// ---------------------------------------------------------------- hashing

export function hashInput(parts: Record<string, unknown>): string {
  const h = createHash('sha256')
  h.update(JSON.stringify(parts))
  return h.digest('hex').slice(0, 32)
}

// ------------------------------------------------- query tokenising & scoring

/** Words carrying no discriminating signal in a literature query. */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is',
  'of', 'on', 'or', 'the', 'to', 'with'
])

const tokenize = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t))

/**
 * Split a query on `|` into alternatives, each tokenized on its own.
 *
 * `a | b` means "a OR b", as it does in every search box: a paper matching one
 * side strongly must not be penalised for scoring zero on the other, so the
 * alternatives are scored SEPARATELY and the best score wins. Tokenizing the
 * whole string at once would silently turn OR into AND-ish soup.
 *
 * Empty alternatives (`a || b`, a trailing bar) are dropped rather than
 * matching everything.
 */
export function queryAlternatives(query: string): string[][] {
  return query
    .split('|')
    .map(tokenize)
    .filter((t) => t.length > 0)
}

/**
 * Split a comma-separated author filter into names.
 *
 * Any of them may match — "work from any of these groups" is the question being
 * asked, and requiring all of them returns nothing for almost every pair.
 */
export function authorNeedles(author: string | undefined): string[] {
  return (author ?? '')
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .filter((a) => a.length > 0)
}

/**
 * Score one record against the query tokens. Title hits weigh more than
 * abstract hits (a term in the title is what the paper is ABOUT), and repeated
 * abstract occurrences add with diminishing weight so a single term repeated
 * five times cannot outrank a record matching every term once.
 */
export function scoreRecord(rec: WebSearchRecord, queryTokens: string[]): number {
  const titleTokens = new Set(tokenize(rec.title))
  const abstractTokens = tokenize(rec.abstract)
  const abstractCounts = new Map<string, number>()
  for (const t of abstractTokens) abstractCounts.set(t, (abstractCounts.get(t) ?? 0) + 1)

  let score = 0
  for (const q of new Set(queryTokens)) {
    if (titleTokens.has(q)) score += 3
    const n = abstractCounts.get(q) ?? 0
    if (n > 0) score += 1 + Math.log2(n)
  }
  return score
}

