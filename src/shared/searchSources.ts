/**
 * HOW TO NAME AN INDEX A SEARCH ACTUALLY REACHED.
 *
 * The app does not decide WHICH indexes are queried — a search plugin does — so
 * every sentence about them is DERIVED from what came back rather than promised
 * in advance. This file spells those ids the way a reader writes them and joins
 * them into English.
 *
 * The derivation is the point, and it is paid for. A hand-typed sentence in the
 * renderer said "Searching CrossRef, PubMed Central, arXiv and bioRxiv…" while
 * the code doing the searching read its list from somewhere else entirely; they
 * drifted, and the app told the reader it was searching an index it never asked.
 *
 * `SERVER_SEARCH_SOURCES` is the one fixed list here, mirroring `ACADEMIC_SOURCES`
 * in `src/main/search/sources/web-search-server.ts` — app code, so the app may
 * legitimately state what it does.
 */

/** The indexes the search server fans out to, when one is configured. */
export const SERVER_SEARCH_SOURCES = ['crossref', 'pubmed', 'arxiv', 'biorxiv'] as const

/**
 * How each index is written for a reader.
 *
 * A bare id is what the machines exchange; `pubmed` and `biorxiv` are not how
 * anyone writes them. An id with no entry here falls back to itself rather than
 * being dropped — a source the reader has never heard of is still a source that
 * was searched, and hiding it would misreport the work done.
 */
const DISPLAY_NAME: Record<string, string> = {
  ssrn: 'SSRN',
  arxiv: 'arXiv',
  pubmed: 'PubMed',
  biorxiv: 'bioRxiv',
  crossref: 'CrossRef',
  openalex: 'OpenAlex',
  europepmc: 'Europe PMC',
  semanticscholar: 'Semantic Scholar',
  // A hit the extension marked as a preprint without naming the server it sits on.
  preprint: 'preprint'
}

// The preprint servers a row can be attributed to, spelled the way they spell themselves.
//
// These are not indexes and never appear in the arrays above — nothing queries chemRxiv
// directly. They arrive as the `source` of an individual HIT, because a paper Crossref
// returned may live on a preprint server, and "chemRxiv" tells a reader the thing
// "CrossRef" does not: that it has not been peer-reviewed.
//
// The extension already sends them in this exact form, so this map only exists for the
// casing that would otherwise be lost. Anything absent falls through to itself.
for (const name of [
  'chemRxiv', 'Research Square', 'Preprints.org', 'PsyArXiv', 'OSF Preprints',
  'EarthArXiv', 'SocArXiv', 'AfricArXiv', 'TechRxiv', 'Authorea', 'F1000Research',
  'PeerJ Preprints', 'SciELO', 'Zenodo', 'ESSOAr'
]) {
  DISPLAY_NAME[name.toLowerCase()] = name
  DISPLAY_NAME[name] = name
}

export function searchSourceName(id: string): string {
  return DISPLAY_NAME[id] ?? id
}

/**
 * "SSRN, arXiv, PubMed and bioRxiv" — an English list, not a comma dump.
 *
 * The final "and" matters at a glance: a run of four commas reads as a fragment,
 * and this string sits mid-sentence in a status line the reader scans while
 * waiting.
 */
export function listSearchSources(ids: readonly string[]): string {
  const names = ids.map(searchSourceName)
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

