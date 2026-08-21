// Per-style field extraction for a single bibliography entry.
//
// THE OBJECTIVE. For every entry in a bibliography we want the fields that
// IDENTIFY the referenced paper: authors, year, and either a title or a
// venue+volume+pages coordinate. Whether that paper happens to also sit in the
// local corpus is a separate, later question (see `matchReferences`).
//
// WHY A STYLE LAYER. A single set of heuristics cannot serve this corpus,
// because publishers disagree on the two things that matter most:
//
//   author order   "Wolfenden, R. & Snider, M. J."   (surname first)
//                  "A. Warshel, P. K. Sharma"        (initials first)
//   tail shape     "Science 267, 90-93 (1995)."      volume, pages, (year)
//                  "Nature 2008, 453, 190-195."      year, volume, pages
//                  "Chem. Rev. 106 (2006) 3210."     volume, (year), pages
//                  "J Mol Biol 396:1025-1042."       volume:pages
//                  "Acc. Chem. Res. 34, 938-945."    volume, pages
//
// and because SEVERAL of these styles print no title at all (ACS, Angewandte,
// RSC, older JACS). A parser that assumes a title exists returns author debris
// in its place, which is worse than returning nothing.
//
// THE ALGORITHM, uniform across styles once the two axes above are known:
//
//   1. tail   — locate volume/pages/(year) at the END of the entry. This is the
//               most regular part of any citation and it pins down where the
//               "middle" stops.
//   2. authors— consume author units from the FRONT with the document's
//               detected order. This pins down where the middle starts.
//   3. middle — whatever is left is (optional leading year) + (optional title)
//               + (optional venue). The venue is peeled off the END by scanning
//               backwards over venue-shaped words; the remainder is the title,
//               or null when the style prints none.
//
// Everything here is pure: no clock, no randomness, no network, no LLM.

import { foldText } from './normalize'

// ------------------------------------------------------------- style profiles

export type AuthorOrder = 'surname-first' | 'initials-first'

/** The shape of the volume/pages/year coordinate that closes an entry. */
export type TailShape =
  /** "Science 267, 90-93 (1995)." — Nature, Nat. Chem. Biol., ACS Catal. */
  | 'vol-pages-year'
  /** "Nature 2008, 453, 190-195." — ACS, Angewandte, RSC. */
  | 'year-vol-pages'
  /** "Chem. Rev. 106 (2006) 3210-3235." — Elsevier. */
  | 'vol-year-pages'
  /** "J Mol Biol 396:1025-1042." — PNAS, Protein Science. */
  | 'vol-colon-pages'
  /** "Acc. Chem. Res. 34, 938-945." — JMB, year printed earlier. */
  | 'vol-pages'
  | 'none'

/**
 * A named citation style. The name is for reporting and debugging only — all
 * behaviour is driven by `authorOrder` + `tail`, so an unrecognised combination
 * degrades to `generic` and still parses, rather than failing.
 */
export type CitationStyle =
  | 'nature'
  | 'acs'
  | 'angewandte'
  | 'rsc'
  | 'elsevier'
  | 'vancouver'
  | 'pnas'
  | 'jmb'
  | 'author-year'
  | 'generic'

export interface StyleProfile {
  style: CitationStyle
  authorOrder: AuthorOrder
  tail: TailShape
  /** Fraction of sampled entries whose tail agreed with `tail`. */
  confidence: number
}

export const GENERIC_STYLE: StyleProfile = {
  style: 'generic',
  authorOrder: 'surname-first',
  tail: 'none',
  confidence: 0
}

// ------------------------------------------------------------------- 1. tails

const Y = '(?:1[89]\\d{2}|20\\d{2})'
const VOL = '\\d{1,4}'
// Page ranges are not always numeric: Nature prints article ids ("eado5068"),
// FEBS Lett. prints "E4 - E7", and elided ranges print "190-5".
//
// EIGHT digits, not six. PLOS and Scientific Reports article ids run to seven
// (`e1000393`), and a six-digit cap does not fail to match those — it matches a
// TRUNCATED prefix, `e100039`, which reads as a perfectly plausible page number
// and is wrong. Eight such ids in this corpus, each a guaranteed mismatch
// against the full value an index holds. A silent truncation is worse than no
// match, because nothing downstream can tell the difference.
const PG = '[A-Za-z]{0,4}\\d{1,8}(?:\\s*-\\s*[A-Za-z]{0,4}\\d{1,8})?'
// An issue number in parentheses sits between volume and pages in some styles:
// "Chem. Eng. News 1946, 24 (10), 1375-1377".
const ISSUE = '(?:\\s*\\(\\s*\\d{1,4}\\s*\\))?'

interface TailPattern {
  shape: TailShape
  re: RegExp
  /** Index of the year capture group, or 0 when the shape carries no year. */
  yearGroup: number
  volGroup: number
  pageGroup: number
}

/**
 * Ordered most-specific first. `vol-pages` is LAST because it is a suffix of
 * `vol-pages-year` and would otherwise shadow it.
 */
const TAIL_PATTERNS: TailPattern[] = [
  {
    shape: 'vol-pages-year',
    re: new RegExp(`(?:^|[\\s,.;:)])(${VOL})${ISSUE}\\s*,\\s*(${PG})\\s*\\(\\s*(${Y})\\s*\\)`, 'g'),
    volGroup: 1,
    pageGroup: 2,
    yearGroup: 3
  },
  {
    shape: 'year-vol-pages',
    re: new RegExp(`(?:^|[\\s,.;:)])(${Y})\\s*,\\s*(${VOL})${ISSUE}\\s*,\\s*(${PG})`, 'g'),
    yearGroup: 1,
    volGroup: 2,
    pageGroup: 3
  },
  {
    shape: 'vol-year-pages',
    // `pp?\.?` — Comptes Rendus and Elsevier's older style print "40 (2011),
    // pp. 5068-5083"; the shape is otherwise this one exactly. Optional rather
    // than a sixth pattern, because a separate one would have to be ordered
    // against this one and the two could never disagree about what they matched.
    // Non-capturing, so the group numbers below are unaffected.
    re: new RegExp(`(?:^|[\\s,.;:])(${VOL})\\s*\\(\\s*(${Y})\\s*\\)\\s*,?\\s*(?:pp?\\.?\\s*)?(${PG})`, 'g'),
    volGroup: 1,
    yearGroup: 2,
    pageGroup: 3
  },
  {
    shape: 'vol-colon-pages',
    re: new RegExp(`(?:^|[\\s,.;)])(${VOL})${ISSUE}\\s*:\\s*(${PG})`, 'g'),
    volGroup: 1,
    pageGroup: 2,
    yearGroup: 0
  },
  {
    shape: 'vol-pages',
    re: new RegExp(`(?:^|[\\s,.;:)])(${VOL})${ISSUE}\\s*,\\s*(${PG})`, 'g'),
    volGroup: 1,
    pageGroup: 2,
    yearGroup: 0
  }
]

export interface TailMatch {
  shape: TailShape
  /** Offset in the searched string at which the coordinate begins. */
  start: number
  volume: string | null
  pages: string | null
  year: number | null
}

/**
 * Locate the volume/pages/year coordinate, searching `body` from `from`.
 *
 * The LAST match wins. Entries routinely carry trailing furniture that the text
 * layer splices in — "Page 18 of 21 / ACS Paragon Plus Environment" and a column
 * of line numbers, in this corpus — and a first-match rule would happily lock
 * onto a number inside the title instead.
 *
 * When `preferred` is supplied (the document's detected shape) it is tried
 * first, so a per-document decision beats the generic precedence order.
 */
export function findTail(body: string, from = 0, preferred?: TailShape): TailMatch | null {
  const ordered = preferred
    ? [
        ...TAIL_PATTERNS.filter((p) => p.shape === preferred),
        ...TAIL_PATTERNS.filter((p) => p.shape !== preferred)
      ]
    : TAIL_PATTERNS

  for (const pat of ordered) {
    pat.re.lastIndex = 0
    let last: RegExpExecArray | null = null
    let m: RegExpExecArray | null
    while ((m = pat.re.exec(body))) {
      if (m.index >= from) last = m
      if (pat.re.lastIndex === m.index) pat.re.lastIndex++
    }
    if (!last) continue
    // The capture begins after the leading boundary character the pattern ate.
    const lead = last[0].length - last[0].replace(/^[\s,.;:)]/, '').length
    const yr = pat.yearGroup ? Number(last[pat.yearGroup]) : null
    return {
      shape: pat.shape,
      start: last.index + lead,
      volume: last[pat.volGroup] ?? null,
      pages: last[pat.pageGroup] ? last[pat.pageGroup].replace(/\s+/g, '') : null,
      year: yr && yr >= 1800 && yr <= 2100 ? yr : null
    }
  }
  return null
}

// ----------------------------------------------------------------- 2. authors

const PARTICLE =
  "(?:(?:van|von|der|den|del|della|de|di|du|da|dos|le|la|ten|ter|St\\.)\\s+)?"
// Hyphenated names may arrive with the hyphen spaced out — pdfjs emits
// "Çelebi-Ölçüm" as "Celebi - Olcum" once folded — so the joiner tolerates
// surrounding whitespace.
const NAME = "[A-Z][A-Za-z'\\u00c0-\\u024f]+(?:\\s*-\\s*[A-Z]?[A-Za-z'\\u00c0-\\u024f]+)*"
const SUFFIX = "(?:\\s*,?\\s*(?:Jr|Sr|II|III|IV)\\b\\.?)?"

/** "Wolfenden, R." / "Kirby AJ" / "van der Waals, J. D." */
const SURNAME_HEAD_RE = new RegExp(`^\\s*(${PARTICLE}${NAME})\\s*(,\\s*|\\s+)`)
/**
 * "A. Warshel" / "P.K. Sharma" / "C. F. Barbas".
 *
 * The trailing `(?![A-Za-z.])` is what stops an abbreviated journal name from
 * reading as one more author: in "M. Casey and D. Kemp, J. Org. Chem., 1973"
 * the fragment "J. Org." has exactly the initial-plus-name shape, and without
 * the guard the author list swallows the venue. A real surname is followed by a
 * separator or the end of the list, never by its own period.
 */
const INITIALS_HEAD_RE = new RegExp(
  `^\\s*((?:[A-Z]\\.[-\\s]*){1,5})(${PARTICLE}${NAME})${SUFFIX}(?![A-Za-z.])`
)
/** PNAS-style unpunctuated initials: "Kirby AJ", "Khersonsky O" */
const BARE_INITIALS_RE = /^([A-Z]{1,4})(?![a-z])/
/** A separator between two author units. */
const AUTHOR_SEP_RE = /^\s*(?:,\s*(?:and\s+|&\s+)?|;\s*(?:and\s+|&\s+)?|\s+and\s+|\s*&\s*)/
const ET_AL_RE = /^\s*(?:,\s*)?et\.?\s*al\.?,?/i
/**
 * An abbreviated word: a capital, at most six lowercase letters, then a period.
 * Its role is to stop an author's initials from swallowing the first letter of
 * an abbreviated journal name — "Borhan, B. J. Am. Chem. Soc." must yield the
 * initials "B." and the venue "J. Am. Chem. Soc.", not the initials "B. J.".
 * An initial is only accepted when what FOLLOWS it is not such a word, because
 * a genuine initial is followed by another initial, a surname, or a separator.
 */
const ABBREV_AHEAD_RE = /^[A-Z][a-z]{1,6}\.(?:\s|$)/

/**
 * Consume dotted initials, honouring the abbreviated-word lookahead above.
 *
 * A LOWERCASE initial is accepted too. It is not a real style — it is a text-
 * layer defect, and a common one: this corpus contains "Althoff, E. a.;" where
 * the small-caps A decoded to a lowercase glyph. Refusing it ends the author
 * list mid-way and the remaining fourteen authors are reported as the title.
 */
function consumeDottedInitials(s: string, at: number): number {
  let i = at
  let taken = 0
  while (taken < 6) {
    const m = /^([A-Za-z])\.[-\s]*/.exec(s.slice(i))
    if (!m) break
    const after = s.slice(i + m[0].length)
    if (ABBREV_AHEAD_RE.test(after)) break
    i += m[0].length
    taken++
  }
  return taken ? i : at
}

/**
 * Consume an author list written surname-first, returning the offset just past
 * it. Handles "Surname, A. B.", "Surname AB", "Surname, A. B., Jr." and
 * terminates on "et al.".
 */
export function consumeSurnameFirst(body: string): number {
  let i = 0
  let units = 0
  for (;;) {
    const rest = body.slice(i)
    const et = ET_AL_RE.exec(rest)
    if (et && units > 0) return i + et[0].length
    const head = SURNAME_HEAD_RE.exec(rest)
    if (!head) break
    let j = i + head[0].length
    const afterInitials = consumeDottedInitials(body, j)
    if (afterInitials > j) {
      j = afterInitials
    } else {
      // Unpunctuated form. Only accepted after a SPACE separator ("Kirby AJ"),
      // never after a comma, and only when a separator or a parenthesised year
      // follows — otherwise "Enzyme DNA" inside a title would read as an author.
      const bare = head[2].trim() === '' ? BARE_INITIALS_RE.exec(body.slice(j)) : null
      if (!bare) break
      const after = body.slice(j + bare[0].length)
      if (!/^\s*(?:[,;)]|and\b|&|\(|$)/.test(after)) break
      j += bare[0].length
    }
    const suf = new RegExp(`^${SUFFIX}`).exec(body.slice(j))
    if (suf) j += suf[0].length
    i = j
    units++
    const et2 = ET_AL_RE.exec(body.slice(i))
    if (et2) return i + et2[0].length
    const sep = AUTHOR_SEP_RE.exec(body.slice(i))
    if (!sep) break
    // Peek: the separator only counts if another unit really follows it.
    const next = body.slice(i + sep[0].length)
    if (!SURNAME_HEAD_RE.test(next)) break
    i += sep[0].length
  }
  return units > 0 ? i : 0
}

/** Consume an author list written initials-first ("A. Warshel, P. K. Sharma"). */
export function consumeInitialsFirst(body: string): number {
  let i = 0
  let units = 0
  for (;;) {
    const m = INITIALS_HEAD_RE.exec(body.slice(i))
    if (!m) break
    i += m[0].length
    units++
    const et = ET_AL_RE.exec(body.slice(i))
    if (et) return i + et[0].length
    const sep = AUTHOR_SEP_RE.exec(body.slice(i))
    if (!sep) break
    if (!INITIALS_HEAD_RE.test(body.slice(i + sep[0].length))) break
    i += sep[0].length
  }
  return units > 0 ? i : 0
}

/**
 * Where the author list ends, using the document's detected order and falling
 * back to the other order when the primary consumes nothing. Returns 0 when no
 * author list could be read.
 *
 * `limit` is the offset of the volume/pages coordinate. Author consumption is
 * bounded by it because an author list can never legitimately run into the
 * volume number, and because the fraction-of-the-entry guard below has to be
 * measured against the PRE-TAIL region: a titleless ACS entry naming fourteen
 * authors legitimately IS ~90% of its own body, and a guard measured on the
 * whole entry rejects exactly the entries this parser exists to read.
 */
export function findAuthorEnd(body: string, order: AuthorOrder, limit = body.length): number {
  const head = body.slice(0, limit)
  const primary = order === 'initials-first' ? consumeInitialsFirst : consumeSurnameFirst
  const secondary = order === 'initials-first' ? consumeSurnameFirst : consumeInitialsFirst
  let end = primary(head)
  if (end === 0) end = secondary(head)
  // A runaway consumption means the entry is not an author list at all (a book
  // title set in title case reads exactly like one), and reporting it as authors
  // would be a confident lie.
  if (end >= head.length) return 0
  return end
}

// ------------------------------------------------------------------ 3. middle

/**
 * A leading year, as printed by author-year and PNAS styles.
 *
 * A PARENTHESISED year needs no trailing punctuation — "(2010) Evolutionary
 * optimization of ..." is the complete PNAS form — because the brackets already
 * mark it unambiguously. A BARE year does need it ("Wolfson, H. 1993. A computer
 * vision ..."), since without the period any four-digit number opening the
 * middle region would be eaten.
 */
const LEADING_YEAR_RE = /^\s*(?:\(\s*(\d{4})[a-z]?\s*\)\s*[.,:]?|(\d{4})[a-z]?\s*[.,:])\s*/

/**
 * Words that may appear inside a journal name without being capitalised.
 * Everything else lowercase ends the venue, because a title's final word is
 * almost always lowercase ("... enzyme design." / "... for enzyme catalysis,").
 */
const VENUE_CONNECTORS = new Set([
  'of', 'the', 'and', 'for', 'in', 'on', 'de', 'der', 'und', 'et', 'a', 'des', 'la'
])

interface Tok {
  text: string
  start: number
  end: number
}

function tokenize(s: string): Tok[] {
  const out: Tok[] = []
  const re = /\S+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) out.push({ text: m[0], start: m.index, end: m.index + m[0].length })
  return out
}

/**
 * Could this token belong to a journal name?
 *
 * Venue names abbreviate ("J. Mol. Biol.", "Angew. Chem. Int. Ed.") or run in
 * title case ("Nucleic Acids Res.", "Nature", "Biochemistry"). What they never
 * do is start lowercase or be a bare number.
 *
 * The capital-initial requirement is the whole boundary test, and it is enough
 * because journals set titles in SENTENCE case in every style here: the word
 * immediately before the journal name is lowercase ("... for enzyme catalysis.
 * J. Am. Chem. Soc."), so the backwards scan stops exactly there. Adding a
 * "long word closed by a period is a title ending" rule on top looks like a
 * useful second signal and is not — "Biochem." and "Crystallogr." are long
 * words closed by a period, and the rule truncates the venue at them.
 */
function isVenueToken(text: string): boolean {
  const core = text.replace(/^[^A-Za-z0-9(]+/, '').replace(/[^A-Za-z0-9.)]+$/, '')
  if (!core) return false
  if (/[?!"]$/.test(text)) return false
  const bare = core.replace(/\.$/, '')
  if (VENUE_CONNECTORS.has(bare.toLowerCase())) return true
  if (!/^[A-Z(]/.test(core)) return false
  if (/^\(?\d/.test(core)) return false
  return true
}

/** Longest venue name we will peel off the end of the middle region. */
const MAX_VENUE_TOKENS = 8

/**
 * Split the middle region into (title, venue) by peeling venue-shaped words off
 * its END. Styles that print no title (ACS, Angewandte, RSC) leave nothing in
 * front of the venue, and this correctly returns a null title rather than
 * inventing one out of author debris.
 */


/**
 * Words that really do open a journal name.
 *
 * The stop rule above cannot fire on these: "Annu." in "... antibody catalysis.
 * Annu. Rev. Biochem." is preceded by lowercase prose exactly like a title's
 * final proper noun is, so without this list the venue is truncated to
 * "Rev. Biochem." on ordinary references.
 */
const JOURNAL_HEAD_WORDS = new Set([
  'acc', 'acs', 'acta', 'adv', 'angew', 'annu', 'appl', 'biochem', 'biochemistry',
  'bioinformatics', 'biochim', 'biol', 'biophys', 'bmc', 'cell', 'chem', 'comput',
  'crystallogr', 'curr', 'elife', 'embo', 'enzymol', 'eur', 'febs', 'genetics',
  'graph', 'int', 'j', 'jacs', 'khirn', 'model', 'mol', 'nat', 'nature',
  'nucleic', 'org', 'phys', 'plos', 'proc', 'protein', 'proteins', 'res', 'rev',
  'sci', 'science', 'sect', 'soc', 'struct', 'synthesis', 'tetrahedron',
  'trends', 'zh'
])

function isJournalWord(text: string): boolean {
  const core = text.replace(/[^A-Za-z]/g, '').toLowerCase()
  return core.length > 0 && JOURNAL_HEAD_WORDS.has(core)
}

/** A token that closes a sentence: a word followed by a period. */
function endsSentence(text: string): boolean {
  return /[A-Za-z0-9]\.$/.test(text.replace(/[^A-Za-z0-9.]+$/, ''))
}

/** The nearest preceding word with letters in it, or null. */
function previousWord(
  toks: Array<{ text: string }>,
  from: number
): string | null {
  for (let i = from - 1; i >= 0; i--) {
    const core = toks[i].text.replace(/[^A-Za-z]/g, '')
    if (core) return core
  }
  return null
}

export function splitMiddle(middle: string): { title: string | null; venue: string | null } {
  const toks = tokenize(middle)
  if (!toks.length) return { title: null, venue: null }

  let hi = toks.length - 1
  while (hi >= 0 && !/[A-Za-z0-9]/.test(toks[hi].text)) hi--
  if (hi < 0) return { title: null, venue: null }

  let lo = hi
  let taken = 0
  while (lo >= 0 && taken < MAX_VENUE_TOKENS) {
    if (!/[A-Za-z0-9]/.test(toks[lo].text)) {
      lo--
      continue
    }
    if (!isVenueToken(toks[lo].text)) break
    // A one-word SOFTWARE title ("Kabsch, W. XDS. Acta Crystallogr. D 66, 125")
    // is all-caps and closed by a period, so it reads as a venue token and the
    // title came out null. It only counts as a title when a venue was already
    // taken and what precedes it is an author initial — the shape of "Author,
    // W. NAME. Journal".
    if (taken > 0 && /^[A-Z0-9]{2,6}\.$/.test(toks[lo].text)) {
      const prev = previousWord(toks, lo)
      if (prev && prev.length === 1) break
    }
    // A capitalised word ending the TITLE looks exactly like a venue token, so
    // the backwards scan ran straight through it: "Macromolecular modeling with
    // Rosetta. Annu. Rev. Biochem." peeled "Rosetta." into the venue and left
    // the title as "Macromolecular modeling with". Stop when the word before is
    // lowercase prose — that is the title's last word, and the capitalised word
    // is its final proper noun, not the start of the journal name.
    if (taken > 0 && endsSentence(toks[lo].text) && !isJournalWord(toks[lo].text)) {
      const prev = previousWord(toks, lo)
      if (prev && /^[a-z]/.test(prev)) break
    }
    lo--
    taken++
  }

  if (taken === 0) {
    return { title: cleanTitle(middle), venue: null }
  }
  // Skip back over punctuation that separated the title from the venue.
  let venueStartTok = lo + 1
  while (venueStartTok <= hi && !/[A-Za-z0-9]/.test(toks[venueStartTok].text)) venueStartTok++
  const venue = cleanVenue(middle.slice(toks[venueStartTok].start, toks[hi].end))
  const title = cleanTitle(middle.slice(0, toks[venueStartTok].start))
  return { title, venue }
}

function cleanVenue(s: string): string | null {
  const v = s
    .replace(/\s+/g, ' ')
    .replace(/^[^A-Za-z(]+/, '')
    // A trailing author initial that leaked into the venue. "Bolon, D. N.;
    // Mayon, S. L. Proc. Natl. Acad. Sci." is genuinely ambiguous — "L." and
    // the "J." of "J. Am. Chem. Soc." have identical shape — so the author scan
    // stops one initial early and the venue starts one token late. "J" is the
    // sole exception because it abbreviates "Journal", which is how a large
    // fraction of venue names begin.
    .replace(/^(?!J\.)[A-Z]\.\s+(?=[A-Z])/, '')
    .replace(/[,;:\s]+$/, '')
    .trim()
  return v.length >= 2 ? v : null
}

/**
 * A title is prose. Once the structural split has isolated the region, the only
 * remaining job is to reject the leftovers of a titleless entry — a stray
 * initial, a lone connective — so the check is deliberately light.
 */
function cleanTitle(s: string): string | null {
  const t = s
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:.]+/, '')
    .replace(/[\s,;:]+$/, '')
    .replace(/\.$/, '')
    .trim()
  if (t.length < 12) return null
  const words = t.split(/\s+/)
  if (words.length < 3) return null
  const initials = (t.match(/\b[A-Z]\.(?:\s|$)/g) ?? []).length
  if (initials >= Math.max(2, words.length * 0.3)) return null
  return t
}

// ------------------------------------------------------------ style detection

/**
 * Decide, for a WHOLE document, which author order and tail shape its
 * bibliography uses.
 *
 * Per-document rather than per-entry because the signal is far stronger in
 * aggregate: an individual entry may be truncated, may be a book with no volume,
 * or may have a running head spliced through it, but a bibliography as a whole
 * is set in exactly one style. Ties and thin evidence fall back to `generic`,
 * which parses with the same machinery and merely loses the preference hints.
 */
export function detectStyle(bodies: string[]): StyleProfile {
  if (!bodies.length) return GENERIC_STYLE

  let surnameVotes = 0
  let initialsVotes = 0
  const tailVotes = new Map<TailShape, number>()
  let leadingYear = 0
  let parenLeadingYear = 0
  let semicolons = 0

  for (const body of bodies) {
    // Vote on the region BEFORE any volume/pages coordinate, for the same
    // reason `extractFields` bounds its author scan: an unbounded scan lets a
    // title's capitalised words read as more authors and skews the vote.
    const head = body.slice(0, findTail(body, 0)?.start ?? body.length)
    const s = consumeSurnameFirst(head)
    const ini = consumeInitialsFirst(head)
    // Whichever order explains more of the entry's opening wins its vote. A tie
    // (both zero) abstains.
    if (s > ini) surnameVotes++
    else if (ini > s) initialsVotes++

    const authorEnd = Math.max(s, ini)
    const tail = findTail(body, authorEnd)
    if (tail) tailVotes.set(tail.shape, (tailVotes.get(tail.shape) ?? 0) + 1)

    const ly = LEADING_YEAR_RE.exec(body.slice(authorEnd))
    if (ly) {
      leadingYear++
      if (ly[1]) parenLeadingYear++
    }
    if (body.includes(';')) semicolons++
  }

  const authorOrder: AuthorOrder = initialsVotes > surnameVotes ? 'initials-first' : 'surname-first'

  let tail: TailShape = 'none'
  let best = 0
  for (const [shape, n] of tailVotes) {
    if (n > best || (n === best && shape < tail)) {
      best = n
      tail = shape
    }
  }
  const confidence = bodies.length ? best / bodies.length : 0
  // Thin evidence is not evidence. Below a third of entries agreeing, we decline
  // to name a shape and let each entry find its own.
  if (confidence < 0.34) tail = 'none'

  const yearFirst = leadingYear / bodies.length >= 0.5
  const style = nameStyle(authorOrder, tail, yearFirst, parenLeadingYear / bodies.length >= 0.5, semicolons / bodies.length >= 0.5)

  return { style, authorOrder, tail, confidence }
}

function nameStyle(
  order: AuthorOrder,
  tail: TailShape,
  yearAfterAuthors: boolean,
  parenYear: boolean,
  semicolonAuthors: boolean
): CitationStyle {
  if (order === 'initials-first') {
    if (tail === 'vol-year-pages') return 'elsevier'
    if (tail === 'year-vol-pages') return semicolonAuthors ? 'rsc' : 'angewandte'
    if (tail === 'vol-colon-pages') return 'vancouver'
    return 'generic'
  }
  if (tail === 'year-vol-pages') return 'acs'
  if (tail === 'vol-pages-year') return 'nature'
  if (yearAfterAuthors) {
    if (tail === 'vol-colon-pages') return parenYear ? 'pnas' : 'author-year'
    if (tail === 'vol-pages') return parenYear ? 'jmb' : 'author-year'
    return parenYear ? 'jmb' : 'author-year'
  }
  return 'generic'
}

// ------------------------------------------------------------- the entry pass

export interface EntryFields {
  authors: string | null
  year: number | null
  title: string | null
  venue: string | null
  volume: string | null
  pages: string | null
}

/**
 * Extract every identifying field from one entry body (marker already stripped,
 * lines already unwrapped, text already folded).
 */
export function extractFields(body: string, profile: StyleProfile): EntryFields {
  const preferred = profile.tail === 'none' ? undefined : profile.tail
  // The tail is located TWICE. The first pass, unbounded, only supplies a
  // ceiling for author consumption; the second, anchored past the authors, is
  // the one whose volume/pages/year we keep. Doing it in one pass is impossible
  // in either order — authors bound the tail search and the tail bounds the
  // author search — and doing it only once from offset 0 would let a page range
  // inside an author's own name space win.
  const ceiling = findTail(body, 0, preferred)?.start ?? body.length
  const authorEnd = findAuthorEnd(body, profile.authorOrder, ceiling)
  const authors = authorEnd > 0 ? tidyAuthors(body.slice(0, authorEnd)) : null

  const tail = findTail(body, authorEnd, preferred)
  const middleEnd = tail ? tail.start : body.length
  let middle = body.slice(authorEnd, middleEnd)

  let year = tail?.year ?? null
  const ly = LEADING_YEAR_RE.exec(middle)
  if (ly) {
    const y = Number(ly[1] ?? ly[2])
    if (y >= 1800 && y <= 2100 && year == null) year = y
    middle = middle.slice(ly[0].length)
  }

  const { title, venue } = tail
    ? splitMiddle(middle)
    : { title: cleanTitle(middle), venue: null }

  return {
    authors,
    year,
    title,
    venue,
    volume: tail?.volume ?? null,
    pages: tail?.pages ?? null
  }
}

function tidyAuthors(s: string): string | null {
  const a = s
    .replace(/\s+/g, ' ')
    .replace(/[\s,;&]+$/, '')
    .trim()
  return a.length >= 2 ? a : null
}

/** Volume/pages re-derived from a raw entry, for callers holding only the text. */
export function volumeAndPages(raw: string): { volume: string | null; pages: string | null } {
  const t = findTail(foldText(raw).replace(/\s+/g, ' '))
  return { volume: t?.volume ?? null, pages: t?.pages ?? null }
}
