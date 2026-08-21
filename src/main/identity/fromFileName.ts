// WHAT THE FILE IS CALLED — the only thing a file import knows about a paper,
// and enough to ask an index with.
//
// A person's PDF library is named by people and by the tools they use, so the
// filename usually IS the citation: `10.1021_acscatal.9b01339.pdf`,
// `Charmantray and Hecquet - 2025 - Extending the toolbox….pdf`,
// `Rothlisberger2008_Nature_KE07_design.pdf`. That is a query, not a puzzle to
// solve — the index does the identifying, and this module only has to hand it
// something reasonable.
//
// DELIBERATELY BROAD, AND IT MUST STAY THAT WAY. Every rule here is one that
// holds across naming conventions nobody has seen yet; nothing keys off a
// particular exporter's layout. When a filename does not reduce to something
// worth asking about, the answer is null and the paper keeps its filename —
// never a narrower rule bolted on for one more case.

import { DOI_RE, normalizeDoi } from '../citations/normalize'

/**
 * A DOI written into a filename.
 *
 * Filesystems forbid `/`, so every tool that names a file after a DOI
 * substitutes something: `10.1021_acscatal.9b01339`, `10.1021@acscatal`,
 * `10.1021 acscatal`. The prefix (`10.` + 4-9 digits) is fixed by the DOI
 * standard and is what makes this recognisable without knowing the convention;
 * the separator is whatever the tool chose, so ONE character of anything is
 * accepted there and the suffix is taken as-is.
 */
export function doisFromFileName(name: string): string[] {
  const stem = stripExtension(name)
  const out: string[] = []
  const add = (d: string): void => {
    const v = normalizeDoi(d)
    if (v && !out.includes(v)) out.push(v)
  }

  // Already a well-formed DOI somewhere in the name (a URL-ish filename, or a
  // tool that kept the slash by encoding it).
  const direct = stem.replace(/%2f/gi, '/').match(DOI_RE)
  if (direct && direct[0]) add(direct[0])

  // The `/` replaced by SOME single character. Anchored on the standard prefix
  // rather than on the separator, so a convention this was never shown still
  // works.
  const m = stem.match(/\b(10\.\d{4,9})[^A-Za-z0-9]([A-Za-z0-9][A-Za-z0-9._;()\-]*)/)
  if (m) {
    add(`${m[1]}/${m[2]}`)
    // A TRAILING `-1` MAY BE A COPY MARKER OR PART OF THE DOI, and nothing in
    // the name says which: `…j.jmb.2011.01.041-1` is Zotero's second copy,
    // while `978-3-031-08848-3` genuinely ends that way. Guessing either way
    // truncates real identifiers or keeps dead ones, so BOTH are offered and
    // the index decides — the full form first, because it is the literal
    // reading of what the file says.
    const trimmed = m[2].replace(/(?:\s*\(\d{1,2}\)|-\d{1,2})$/, '')
    if (trimmed !== m[2] && trimmed.length > 0) add(`${m[1]}/${trimmed}`)
  }
  return out
}

const stripExtension = (name: string): string => name.replace(/\.[A-Za-z0-9]{1,5}$/, '')

/**
 * The filename as a BIBLIOGRAPHIC QUERY: what a person would type to find it.
 *
 * Not "the title" — this makes no claim to have found one. It is the filename
 * with the things no index can use taken out, handed to a search that ranks
 * against its own corpus and answers with a record the caller must still
 * verify. Getting this slightly wrong costs a miss; the verification is what
 * stops it costing a wrong identity.
 *
 * The cleaning is only what is true of filenames in general: separators are
 * word breaks, extensions and copy markers are not words, and a bare year or a
 * hash is not a search term. Zotero's `Author - Year - Title` needs no special
 * case — its punctuation falls out as word breaks and the authors and year are
 * legitimate query terms.
 */
export function queryFromFileName(name: string): string | null {
  const cleaned = stripExtension(name)
    // A DOI inside the name is handled by `doiFromFileName`; leaving it in a
    // text query only adds noise.
    .replace(/\b10\.\d{4,9}\S*/g, ' ')
    // Separators every tool uses between words.
    .replace(/[_+]+/g, ' ')
    .replace(/\s*-\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  // A content hash, a bare id, a copy marker: nothing to ask with. `download`
  // names files by sha256, and asking an index about 64 hex characters returns
  // a confident, wrong paper.
  if (/^[0-9a-f]{32,}$/i.test(cleaned.replace(/\s/g, ''))) return null

  // A LEADING ORDINAL is shelf order, not a search term: `01_Rothlisberger…`,
  // `12 - Smith…`. It is dropped only at the start and only when short, so a
  // year or a quantity inside the name survives.
  const words = cleaned
    .split(' ')
    .filter((w, i) => w.length > 0 && !(i === 0 && /^\d{1,3}$/.test(w)))
  const query = words.join(' ').trim()
  // Too little to identify anything. The verifier would refuse whatever came
  // back, so the request is not worth making.
  return query.length >= MIN_QUERY_CHARS ? query : null
}

/**
 * Below this a query cannot pick one paper out of an index.
 *
 * Matches the floor the reference path uses on printed titles: an index always
 * returns something, and a shorter query gets a confident answer about a
 * different paper.
 */
const MIN_QUERY_CHARS = 20
