// Finding in-text citation markers, and refusing to when the result would be
// confidently wrong.
//
// Everything here indexes the CANONICAL DOCUMENT TEXT — the per-page strings
// joined with '\n\f\n' that `text.pages@v2` publishes and that
// `text.paragraphs@v1` partitions. One offset space for the whole document; no
// consumer ever re-derives it.

import type { ParagraphRecord, TextItem } from '../pipeline/capabilities'

/** Tunables, together and named, so the fixture that pins them has one target. */
export const CALLOUT_LIMITS = {
  /** Below this many distinct markers, the numbering scheme is not trusted. */
  minMarkers: 5,
  /**
   * Below this fraction of the paper's PRINTED references cited, likewise.
   *
   * The denominator is the count of references the bibliography prints, NOT the
   * number of rows the parser produced — see `printedReferenceCount`. A
   * lettered composite yields a row for itself and one per part, so dividing by
   * rows compared distinct cited ordinals (which can never exceed the printed
   * count) against a larger population, and gave the two ACS papers here a
   * CEILING below this threshold: 44 printed references in 83 rows can reach at
   * most 53 %, so no scan of that paper however good could ever have passed.
   *
   * MEASURED against the 21-paper corpus rather than assumed, by re-running the
   * scanner over every paper's real artifacts (with page geometry — omit it and
   * superscript papers report almost nothing):
   *
   *   declined  9.5 %, 17.6 %, 21.4 %
   *   accepted  59.4 %, 63.6 %, 64.5 %, 72.7 %, 77.8 %, 86.6 %, 88.4 %, 89.1 %,
   *             91.3 %, 95.7 %, 95.9 %, 100 %, 100 %, 100 %, 100 %
   *
   * Nothing falls between 21.4 % and 59.4 %, so every threshold in that 38-point
   * band partitions this corpus identically and the data cannot distinguish
   * them. 0.5 sits inside it, which is the property worth having: the next paper
   * has to be markedly unlike anything seen here before the verdict changes.
   *
   * The band was NARROWER when the row count was the denominator — two papers
   * sat at 38.6 % and 40 %, apparently just below the line, and both were
   * artefacts of that bug rather than poor scans. They now measure 72.7 % and
   * 64.5 %. Their old positions are why a comment describing this threshold as
   * finely balanced against a nearby population should not be trusted without
   * re-measuring: the population was manufactured by the arithmetic.
   */
  minCitedFraction: 0.5,
  /**
   * Widest range a single marker may expand to.
   *
   * An OCR artefact reading `[1-400]` would otherwise write 400 rows for one
   * marker, each a confident claim that this sentence cites that paper.
   */
  maxRangeWidth: 40,
  /** A superscript's glyph height, as a fraction of the body text's. */
  superscriptMaxHeightRatio: 0.86,
  /** How far above the running baseline a superscript must sit. */
  superscriptMinRiseRatio: 0.1
} as const

export interface Callout {
  /** Char offset of the marker's first character, in the canonical text. */
  offset: number
  /** One past its last character. Half-open, matching the repo's convention. */
  end: number
  /** The bibliography entry number this callout names. */
  ordinal: number
  paraId: string
  page: number | null
  section: string
  /** The sentence containing the marker, verbatim. */
  sentence: string | null
  /**
   * Where the marker sits INSIDE `sentence`, so a reader of the passage alone
   * can point at it.
   *
   * `offset` cannot answer this: it indexes the canonical document, and the
   * sentence is a healed, dehyphenated join whose own start is not a document
   * offset at all. A consumer given only the sentence therefore has to re-find
   * the marker by its printed form — and a bare superscript is a bare number,
   * which a scientific sentence is full of. Measured on this corpus, 104 of
   * 1176 passages contain the ordinal more than once and first-match picks the
   * wrong token in 89 of them.
   *
   * Null when the segmenter's slice did not contain the marker.
   */
  markerInSentence: number | null
}

export interface CalloutScan {
  callouts: Callout[]
  /** Markers whose interior did not parse. Counted, never guessed at. */
  malformedMarkers: number
  /** Callouts naming an ordinal the bibliography does not have. */
  danglingCallouts: number
  /** Distinct ordinals cited. Feeds the confidence gate. */
  distinctOrdinals: number
}

/**
 * Dashes pdfjs actually emits for a range.
 *
 * Handling only ASCII `-` silently drops every en-dashed range — which is most
 * of them in a typeset paper — and a dropped range is invisible: the marker
 * simply yields fewer citations than it printed.
 */
const RANGE_DASH = /[-\u2010\u2011\u2012\u2013\u2014\u2015]/

/**
 * Bumped whenever the SHAPE of what this module finds changes.
 *
 * Consumed by the stage fingerprint: a scanner that learns a new marker style
 * is a different scanner, and without this the planner re-queues the work and
 * the cache serves the old answer.
 */
export const CALLOUT_SCANNER_VERSION = '6-printed-entry-regions'

const MARKER_RE = /\[([0-9,;\s\u2010-\u2015-]+)\]/g

/**
 * The same marker, printed in ROUND brackets: `(14)`, `(16, 26)`, `(3–5)`.
 *
 * Five of this corpus's papers cite this way and every one of them was refused
 * at the confidence gate — the bibliography side already recognised the style
 * (`entry_style = 'paren'`) while the callout side scanned only square
 * brackets, so their 20–45 distinct ordinals were invisible and the paper
 * reported ~15% of entries cited.
 *
 * DANGEROUS in a way brackets are not: prose is full of parenthesised numbers
 * that cite nothing — `(1)` opening a list, `(pH 7.4)`, `(25 °C)`, `(n = 3)`,
 * a chemical `(2)`. So this is only ever used when the paper HAS a numbered
 * bibliography, and every ordinal is checked against its length before being
 * emitted. On w15 the raw scan reaches 900; the bound is what makes the
 * difference between finding its citations and inventing them.
 */
const PAREN_MARKER_RE = /\(([0-9]{1,3}(?:\s*[,;\u2010-\u2015-]\s*[0-9]{1,3})*)\)/g

/**
 * A parenthesised run that is a UNIT, not a citation — the parenthesis carries
 * a measurement or a label, so its digits are data.
 *
 * Checked on the text immediately before the marker, because that is where the
 * quantity sits: `at pH (7.4)`, `n = (3)`, `Figure (2)`.
 */
const NON_CITATION_LEAD_RE =
  /(?:\b(?:p\s?H|n|N|eq|ref|fig(?:ure)?|table|scheme|entry|step|no|volume|vol|chapter|eqn|equation)\s*[=.:]?\s*|[\u00b0]C\s*|[=<>~±]\s*)$/i

/** A run that is entirely a citation number, possibly a list or a range. */
const NUMERIC_RUN_RE = /^[0-9]+(\s*[,;\u2010-\u2015-]\s*[0-9]+)*[,.]?$/

/**
 * A BLOCK whose raised numbers are footnote markers, not citations.
 *
 * The other guards here judge the token immediately before a marker, which is
 * the right question for `10 5` or `Figure (2)`. This one cannot be asked that
 * way: an affiliation list is a run of raised numbers each followed by an
 * institution, and every marker in it has an innocent-looking word to its left.
 * What gives it away is the BLOCK — nothing else in a paper reads "1 Department
 * of Biochemistry, 2 Biomolecular Structure and Design, 3 Howard Hughes".
 *
 * MEASURED, not supposed: 33 stored contexts on this corpus matched a
 * non-citation signature and 22 of them had been given a role — a citation edge
 * to a paper nobody cited, with a confident label on it. Two thirds sat
 * MID-SENTENCE, where nothing looks wrong to a reader. Affiliations accounted
 * for 19, equation numbering for 14.
 *
 * THE NUMBER IS PART OF THE PATTERN, not just the institution word. Matching
 * the word alone cost a real citation on this corpus — "the center of recent
 * excitements (15, 16)" was rejected because `Institute` appeared in the
 * author block 60 characters earlier. What identifies the block is a small
 * number IMMEDIATELY BEFORE an institution word, which is the shape of a
 * footnote marker and is not the shape of prose naming a university.
 */
const AFFILIATION_BLOCK_RE =
  /(?:^|[\s,;])\d{1,2}\s+(?:department|division|institute|universit(?:y|à|é|ät)|laborator(?:y|ies)|faculty|school\s+of|centre|center|hospital|academy|college)\b/i

/**
 * An EQUATION reference, whose number labels a formula rather than a paper.
 *
 * `NON_CITATION_LEAD_RE` already refuses `eqn (5)` where the word leads the
 * marker. It does not catch a display equation's own trailing number — the
 * `(13)` in `ΔH‡ = ⟨ΔH‡⟩ + … (13)` — nor a marker elsewhere in a sentence whose
 * subject is the equation. Judged on the marker's own line rather than the
 * whole paragraph, so a sentence that merely mentions an equation in passing
 * keeps its real citations.
 */
const EQUATION_CONTEXT_RE = /\b(?:eqn|eqns|eq|eqs|equation|equations)\b\s*\.?\s*\(?\s*\d/i

/**
 * Text that a raised BARE number CONTINUES rather than cites.
 *
 * A superscript citation and a scientific exponent are the same glyph in the
 * same position: `esterase⁵` and `10⁵` are both a small raised digit, and a PDF
 * text layer flattens both to `… 5`. Geometry cannot separate them — the
 * exponent really is raised. The preceding TOKEN can, and it is the only thing
 * that can.
 *
 * A citation attaches to a CLAIM, so what precedes it is a word, a closing
 * quote, or punctuation. An exponent attaches to a NUMBER: `10 5`,
 * `1.6 x 10 4`, `≤ 5 × 10 4`. So a raised digit run whose preceding token is a
 * bare standalone number is continuing that number's notation — an exponent, or
 * a shattered table row where the column to the left is also a figure — and is
 * refused. A closing bracket is treated the same way: `(1) 2` is a variable
 * index or a numbered species, not a citation of entry 2.
 *
 * "Standalone" is doing the work, and is why the lead class excludes `.` and
 * letters as well as digits. `Lys222 9` cites entry 9 — `222` is glued to a
 * residue name, not a mantissa. `GROMACS 5.1.4 45` and `Qtools 0.5.10 62` cite
 * their software papers — a dotted version string is not a number either. Both
 * survive; only a token that could genuinely be the base of a power does not.
 *
 * This is deliberately not a rule about the literal `10`. Any number can carry
 * an exponent, and a table cell can end in any number at all.
 */
const CONTINUES_A_NUMBER_RE = /(?:^|[^\p{L}\p{N}_.])[0-9]+(?:\.[0-9]+)?\s*$/u

/**
 * A closing bracket whose group is MATHEMATICAL, so a raised digit after it is
 * a power of that group rather than a citation of the sentence.
 *
 * `(Δr)²` is squared; `(Trp50)²⁴` cites entry 24. Both are a raised digit after
 * `)`, so the bracket alone cannot decide — a blanket "closing bracket means
 * exponent" was measured on this corpus and traded five real callouts on works
 * 6 and 10 for the five false ones on work 3, which is not a fix.
 *
 * What separates them is what the bracket CONTAINS. Mathematical notation is
 * operators, Greek and single-letter variables: `(Δr)`, `(k/K)`, `(x+1)`. A
 * parenthetical that a citation can follow is a LABEL — a residue, an
 * abbreviation, a clause — and a label is a Latin word: `Trp50`, `HSA`,
 * `collision frequency`, `velocity-rescaling thermostat`. So the group must
 * carry no run of three or more Latin letters, and must be short enough to be
 * notation rather than an aside.
 */
const MATH_GROUP_BEFORE_RE = /\(([^()]{0,8})\)\s*$/

/**
 * Find superscript citation markers, in the CANONICAL text's offset space.
 *
 * Necessary rather than a refinement: 18 of this corpus's 20 papers cite by
 * superscript, so a bracket-only scan finds nothing in a Nature or JMB paper
 * and the confidence gate then reports that as low confidence — which is true
 * but useless, and would leave the entire citation-context feature dark for the
 * journals the user actually reads.
 *
 * BOTH conditions are required, and each rules out a specific false positive:
 * small-and-level is a footnote or a font change, large-and-raised is nothing,
 * and only small-AND-raised is a superscript. The body height is the median of
 * runs CONTAINING A LETTER, because taking it over all runs would let a page
 * dense with superscripts drag the baseline down and hide them.
 */
function findSuperscriptRuns(items: TextItem[]): TextItem[] {
  const lettered = items.filter((it) => /[A-Za-z]/.test(it.str) && it.height > 0)
  if (lettered.length < 20) return []
  const heights = lettered.map((it) => it.height).sort((a, b) => a - b)
  const bodyHeight = heights[Math.floor(heights.length / 2)]
  if (!(bodyHeight > 0)) return []

  const out: TextItem[] = []
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    const s = it.str.trim()
    if (s === '' || !NUMERIC_RUN_RE.test(s)) continue
    if (it.height <= 0 || it.height > bodyHeight * CALLOUT_LIMITS.superscriptMaxHeightRatio) continue
    // The run it is raised RELATIVE TO. A page's absolute baseline means
    // nothing; what identifies a superscript is sitting above the text it
    // interrupts.
    const prev = items[i - 1]
    if (!prev || prev.height <= 0) continue
    if (it.baseline - prev.baseline < bodyHeight * CALLOUT_LIMITS.superscriptMinRiseRatio) continue
    // `10^3` and `x2`: a digit or a closing bracket immediately before makes
    // this an exponent or a variable index, not a citation. Necessary but NOT
    // sufficient — see `CONTINUES_A_NUMBER_RE`, which repeats the judgement on
    // the characters, where the mantissa cannot hide behind a whitespace item.
    // Kept here as well because a producer may emit a raised run with no
    // preceding text run at all in the paragraph slice.
    if (/[0-9)\]]$/.test(prev.str)) continue
    out.push(it)
  }
  return out
}

/** Expand a marker's interior to ordinals, or null if it is not one. */
export function expandMarker(interior: string): number[] | null {
  const parts = interior.split(/[,;]/)
  const out: number[] = []
  for (const raw of parts) {
    const part = raw.trim()
    if (part === '') continue
    const dash = part.search(RANGE_DASH)
    if (dash > 0) {
      const a = Number(part.slice(0, dash).trim())
      const b = Number(part.slice(dash + 1).trim())
      if (!Number.isInteger(a) || !Number.isInteger(b)) return null
      if (b < a || b - a > CALLOUT_LIMITS.maxRangeWidth) return null
      for (let i = a; i <= b; i++) out.push(i)
      continue
    }
    const n = Number(part)
    if (!Number.isInteger(n) || n <= 0) return null
    out.push(n)
  }
  return out.length > 0 ? out : null
}

/**
 * Below this many characters a "sentence" is a fragment, not a claim.
 *
 * A superscript citation arrives from pdf.js as a bare number glued between two
 * sentences, and `Intl.Segmenter` — correctly, by Unicode rules — treats the
 * digit followed by a space and a capital as a sentence boundary. So the
 * sentence containing callout `9` came out as `"9"`, or `"9 In"`, and that is
 * what the Connectome popover then showed as the reason one paper cites
 * another. It also starves the rule-based role classifier, which has no cue
 * phrase to match and returns "not classified" — which is why so many contexts
 * carried no role.
 */
const MIN_SENTENCE_CHARS = 40

/**
 * The most a sentence may grow while healing a bad boundary.
 *
 * Absorbing backwards is bounded so a paragraph whose author never wrote a
 * full stop — a table caption, a run of headings glued together by the text
 * extractor — cannot walk the whole paragraph into one "sentence".
 */
const MAX_SENTENCE_CHARS = 600

/**
 * Whether `index` is a place an English sentence can actually begin.
 *
 * `Intl.Segmenter` applies Unicode rules to text that a PDF extractor has
 * already mangled, and two of its splits land inside a word:
 *  - a line-broken word (`effectively break-\ning up the salt bridge`) — the
 *    hyphen-newline reads as a terminator, so the "sentence" begins `ing up`;
 *  - a superscript or spaced numeral (`rate enhancements of up to 10 5 and`) —
 *    a digit, space and capital is a boundary by the rules, and is not one here.
 *
 * A real start is preceded by terminal punctuation (allowing closing quotes and
 * brackets after it) or by nothing at all. Anything else is the middle of a
 * clause, and the caller absorbs backwards until this holds.
 *
 * A full stop that ends a common ABBREVIATION does not count: scientific prose
 * is full of `Fig. 3 shows`, `ref. 12 reports`, `et al. showed`, and treating
 * the stop as terminal accepts a start that is still mid-sentence — the very
 * defect this exists to catch.
 */
const ABBREV_BEFORE_STOP =
  /(?:^|[\s([])(?:e\.g|i\.e|cf|vs|fig|figs|eq|eqs|ref|refs|no|nos|approx|ca|et al|al|pp|vol|ed|eds|min|max|sec|wt|mol|conc)\.$/i

function isSentenceStart(text: string, index: number): boolean {
  let j = index - 1
  while (j >= 0 && /\s/.test(text[j])) j--
  if (j < 0) return true
  while (j >= 0 && /["'”’)\]]/.test(text[j])) j--
  if (j < 0) return true
  if (!/[.!?]/.test(text[j])) return false
  if (text[j] === '.' && ABBREV_BEFORE_STOP.test(text.slice(Math.max(0, j - 12), j + 1))) return false
  return true
}

/**
 * Rejoin what the page layout broke, so the passage reads as the author wrote it.
 *
 * A word split across a line arrives as `break-\ning`; a sentence split across
 * lines arrives with the newline still in it. Both are artefacts of the column,
 * not of the prose. The document locator canonicalises to letters and digits
 * before matching, so healing here cannot make a passage unfindable.
 */
const dehyphenate = (s: string): string =>
  s
    .replace(/(\p{L})[-\u2010\u00ad]\s*\n\s*(\p{Ll})/gu, '$1$2')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')

/**
 * The sentence containing `offset`, from a paragraph's own text.
 *
 * Fragments are healed by absorbing neighbouring segments: the citation is
 * attached to a real claim, and the reader gets the sentence the author wrote
 * rather than the number the typesetter raised.
 */
/**
 * A character that cannot occur in extracted text, used to CARRY the marker's
 * position through healing.
 *
 * `dehyphenate` rejoins broken words and collapses runs of whitespace, so it
 * shortens the string by an amount that depends on what precedes the marker.
 * Re-deriving the position afterwards would mean re-finding the marker, which
 * is exactly the ambiguous search this offset exists to replace. Planting a
 * sentinel and reading back where it landed is exact by construction, and the
 * result is checked against the marker's own first character before being
 * trusted.
 */
const MARKER_PIN = '\u0000'

function sentenceAt(
  para: ParagraphRecord,
  offset: number
): { text: string; markerInSentence: number | null } {
  const local = offset - para.charStart
  const heal = (raw: string, markerAt: number | null): { text: string; markerInSentence: number | null } => {
    if (markerAt == null || markerAt < 0 || markerAt > raw.length) {
      return { text: dehyphenate(raw), markerInSentence: null }
    }
    const pinned = dehyphenate(`${raw.slice(0, markerAt)}${MARKER_PIN}${raw.slice(markerAt)}`)
    const at = pinned.indexOf(MARKER_PIN)
    const text = pinned.replace(MARKER_PIN, '')
    if (at === -1 || text[at] !== raw[markerAt]) return { text, markerInSentence: null }
    return { text, markerInSentence: at }
  }

  const Seg = (Intl as unknown as { Segmenter?: typeof Intl.Segmenter }).Segmenter
  if (Seg) {
    const seg = new Seg('en', { granularity: 'sentence' })
    const parts = [...seg.segment(para.text)]
    const hit = parts.findIndex(
      (p) => local >= p.index && local < p.index + p.segment.length
    )
    if (hit !== -1) {
      const join = (lo: number, hi: number): string =>
        parts
          .slice(lo, hi + 1)
          .map((p) => p.segment)
          .join('')
          .trim()

      // Grow outward until the text is long enough to BE a claim, preferring
      // the sentence the marker leans on: a superscript belongs to the clause
      // that precedes it, so absorb backwards first.
      let lo = hit
      let hi = hit
      let text = join(lo, hi)
      while (text.length < MIN_SENTENCE_CHARS && (lo > 0 || hi < parts.length - 1)) {
        if (lo > 0) lo--
        else if (hi < parts.length - 1) hi++
        else break
        text = join(lo, hi)
        if (text.length >= MIN_SENTENCE_CHARS) break
        if (hi < parts.length - 1) {
          hi++
          text = join(lo, hi)
        }
      }

      // Then keep absorbing backwards while the passage would OPEN mid-clause.
      // Length alone is not enough: the segmenter's bad boundaries land inside
      // words, so a 67-character fragment beginning `ing up the salt bridge` is
      // long enough to pass the test above and still is not a sentence.
      while (lo > 0 && !isSentenceStart(para.text, parts[lo].index)) {
        const grown = join(lo - 1, hi)
        if (grown.length > MAX_SENTENCE_CHARS) break
        lo--
        text = grown
      }

      // A MARKER THAT OPENS ITS SENTENCE SUPPORTS THE SENTENCE BEFORE IT.
      //
      // This is the one case the two loops above cannot reach, because it fails
      // neither of their tests: the passage is long enough and it begins at a
      // real sentence boundary. It is nonetheless the wrong passage.
      //
      //   "...used as a probe for studying medium effects in catalysis. 10–12
      //    Several enzyme-like systems that catalyze this reaction..."
      //
      // `10–12` supports the medium-effects claim. pdf.js flattens the raised
      // digits into the stream after the full stop, and a digit followed by a
      // space and a capital is a sentence boundary by Unicode rules — so the
      // marker opens the NEXT sentence and the citation is attributed to a claim
      // it says nothing about. Measured on this corpus: 71 of 1161 stored
      // contexts, 20 of which had a role assigned describing the wrong claim,
      // including a `support` label whose cue word came from the following
      // clause ("42 This supports the reasoning of Khersonsky").
      //
      // The GEOMETRY settles it independently of the words: across work 2's 64
      // superscripts the gap before the marker is 0.16pt and the gap after is
      // 3.25pt — twenty times larger — and not one of them begins a line. The
      // marker is glued to what precedes it. So absorbing backwards here follows
      // the page, not a guess about the prose.
      //
      // Bounded by MAX_SENTENCE_CHARS like every other absorb, and skipped when
      // there is nothing before it — a paper may legitimately open a section
      // with a citation.
      if (lo > 0) {
        const rawStart = parts[lo].index
        const markerAt = local - rawStart
        const beforeMarker = para.text.slice(rawStart, local).trim()
        // "Opens the sentence" means nothing but whitespace or an opening
        // bracket stands between the sentence's first character and the marker.
        if (markerAt >= 0 && /^[\s([]*$/.test(beforeMarker)) {
          const grown = join(lo - 1, hi)
          if (grown.length <= MAX_SENTENCE_CHARS) {
            lo--
            text = grown
          }
        }
      }
      // The marker's index in `text`. `join` slices from `parts[lo].index` and
      // then TRIMS, so the leading whitespace it removed has to come off too —
      // without that the pin lands a few characters late and every consumer
      // marks the wrong token, silently.
      const rawJoin = parts
        .slice(lo, hi + 1)
        .map((p) => p.segment)
        .join('')
      const lead = rawJoin.length - rawJoin.trimStart().length
      return heal(text, local - parts[lo].index - lead)
    }
  }
  const whole = para.text
  return heal(whole.trim(), local - (whole.length - whole.trimStart().length))
}

/**
 * Overlapping spans folded into a sorted, disjoint list.
 *
 * Sorted so membership is a binary search, and disjoint so that search has one
 * answer: two overlapping spans would let a marker fall inside the later one
 * while the search settled on the earlier, which is a miss that looks like a
 * find.
 */
function mergeSpans(spans: Array<[number, number]>): Array<[number, number]> {
  const usable = spans
    .filter(([a, b]) => a >= 0 && b > a)
    .sort((x, y) => x[0] - y[0])
  const out: Array<[number, number]> = []
  for (const [a, b] of usable) {
    const last = out[out.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

/** Is `offset` inside any of the (sorted, disjoint) spans? */
function inSpans(spans: Array<[number, number]>, offset: number): boolean {
  let lo = 0
  let hi = spans.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (offset < spans[mid][0]) hi = mid - 1
    else if (offset >= spans[mid][1]) lo = mid + 1
    else return true
  }
  return false
}

/**
 * Where the bibliography's own text sits, so the scanner does not read it as
 * body text.
 *
 * `range` is the contiguous section, which is what a modern paper has. NOT
 * sufficient on its own: an older journal prints each reference at the foot of
 * the page that cites it, so the "section" spans the whole document and fencing
 * it off excludes the paper. That case used to disable the exclusion entirely,
 * and the printed footnote lines were then scanned as prose — 33 of one paper's
 * 44 stored citing sentences were its own reference list, `(1) A. Quilico in
 * "The Chemistry of Heterocyclic Compounds"` filed as a `motivation` for citing
 * entry 1.
 *
 * `entries` is where each entry is ACTUALLY printed, which describes both
 * layouts and needs no judgement about which one this is. A -1 span means the
 * entry could not be located and contributes no region; a range and a set of
 * entry spans are both honoured, because a paper with a normal bibliography also
 * benefits from the entry spans covering a stray continuation block.
 */
export interface BibliographyRegions {
  /** The contiguous section, or [-1,-1] when there is none to fence off. */
  range: [number, number]
  /** Every entry's printed span. -1/-1 entries are ignored. */
  entries: Array<[number, number]>
}

/**
 * Scan a document's paragraphs for numeric bracket callouts.
 *
 * `bibliography` excludes the reference text, and that exclusion is NOT
 * optional: every entry in a numbered list literally begins `[17]`, so without
 * it the scan finds one fake callout per entry — and those fakes would then
 * satisfy the confidence gate below, turning a precision guard into a rubber
 * stamp for exactly the documents it exists to catch.
 */
export function scanCallouts(input: {
  paragraphs: ParagraphRecord[]
  knownOrdinals: Set<number>
  bibliography: BibliographyRegions
  /** Per-page geometry, when the producer had any. Enables superscripts. */
  items?: TextItem[]
  /**
   * Citation sites the FILE recorded, as char spans — a link annotation's
   * rectangle resolved onto the text.
   *
   * A MEASUREMENT RATHER THAN AN INFERENCE, so where these exist they are
   * emitted alongside what the text scan finds and the two are merged by
   * position. On the five papers here that carry them the file records 619
   * sites against the scan's ~220, and each one is a rectangle the typesetter
   * placed rather than a digit that looked like a citation.
   *
   * Only the SPAN is taken. The entry each site names is read from the digits
   * inside it by the same code that reads the scan's, because the destination
   * key it came from is not an ordinal in any portable sense.
   */
  nativeSites?: Array<{ charStart: number; charEnd: number }>
}): CalloutScan {
  const callouts: Callout[] = []
  const seen = new Set<number>()
  /** (offset|ordinal) already emitted — the stored unique key. */
  const emitted = new Set<string>()
  let malformedMarkers = 0
  let danglingCallouts = 0
  const [bibStart, bibEnd] = input.bibliography.range
  // Merged and sorted once, so the membership test below is a binary search
  // rather than a scan of every entry per marker. On a 50-reference paper with
  // 400 markers that is the difference between 20 000 comparisons and 3 400.
  const printed = mergeSpans(input.bibliography.entries)

  // Superscript runs first, indexed by the paragraph that contains them, so the
  // paragraph loop below can attribute each to a section and a sentence with
  // the same code the bracket path uses.
  const superByPara = new Map<string, TextItem[]>()
  if (input.items && input.items.length > 0) {
    const supers = findSuperscriptRuns(input.items)
    // Sorted once and walked with a cursor: a linear scan per superscript would
    // be O(items x paragraphs), which on a 700-paragraph paper is real time.
    const paras = [...input.paragraphs].sort((a, b) => a.charStart - b.charStart)
    let cursor = 0
    for (const run of supers.sort((a, b) => a.charStart - b.charStart)) {
      while (cursor < paras.length && paras[cursor].charEnd <= run.charStart) cursor++
      const para = paras[cursor]
      if (!para || run.charStart < para.charStart) continue
      const list = superByPara.get(para.paraId) ?? []
      list.push(run)
      superByPara.set(para.paraId, list)
    }
  }

  // The file's own sites, indexed the same way and by the same walk.
  const nativeInPara = new Map<string, Array<{ charStart: number; charEnd: number }>>()
  if (input.nativeSites && input.nativeSites.length > 0) {
    const paras = [...input.paragraphs].sort((a, b) => a.charStart - b.charStart)
    let cursor = 0
    for (const site of [...input.nativeSites].sort((a, b) => a.charStart - b.charStart)) {
      while (cursor < paras.length && paras[cursor].charEnd <= site.charStart) cursor++
      const para = paras[cursor]
      if (!para || site.charStart < para.charStart || site.charEnd > para.charEnd) continue
      const list = nativeInPara.get(para.paraId) ?? []
      list.push(site)
      nativeInPara.set(para.paraId, list)
    }
  }

  for (const para of input.paragraphs) {
    // Filter 1: a paragraph the segmenter identified as bibliography or as a
    // caption. Filter 2 (the offset range) is the belt to this one's braces —
    // it holds even when segmentation mislabels a paragraph, and when the
    // parser found no section at all (-1) the range is empty and filter 1
    // stands alone.
    if (para.kind === 'reference' || para.kind === 'caption') continue
    if (para.section === 'references') continue
    if (bibStart >= 0 && para.charStart >= bibStart && para.charStart < bibEnd) continue

    // Both marker shapes, through ONE emit path: a paper may use brackets in
    // its body and superscripts in its captions, and attributing them by
    // different rules would give the same citation two different sections.
    const found: Array<{ offset: number; end: number; interior: string }> = []
    MARKER_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = MARKER_RE.exec(para.text)) !== null) {
      found.push({
        offset: para.charStart + m.index,
        end: para.charStart + m.index + m[0].length,
        interior: m[1]
      })
    }
    // ROUND-bracket markers, admitted only where they can be checked.
    //
    // Every ordinal must name a bibliography entry this paper actually has.
    // That bound is what separates a citation from the parenthesised numbers
    // prose is full of: on one paper here the unbounded scan reaches "900",
    // which no 34-entry bibliography can explain. Requiring `knownOrdinals` to
    // vouch for each one costs nothing where the style is real — the five
    // affected papers cite 20-45 distinct entries, all inside their range —
    // and refuses the rest.
    if (input.knownOrdinals.size > 0) {
      PAREN_MARKER_RE.lastIndex = 0
      while ((m = PAREN_MARKER_RE.exec(para.text)) !== null) {
        // A quantity in brackets is data, not a reference. Judged on what comes
        // BEFORE the marker, which is where the unit or the label sits.
        if (NON_CITATION_LEAD_RE.test(para.text.slice(0, m.index))) continue
        const ords = expandMarker(m[1])
        if (!ords || ords.length === 0) continue
        if (!ords.every((o) => input.knownOrdinals.has(o))) continue
        found.push({
          offset: para.charStart + m.index,
          end: para.charStart + m.index + m[0].length,
          interior: m[1]
        })
      }
    }
    // SITES THE FILE RECORDED, read the same way as everything else.
    //
    // Added to `found` rather than emitted directly so they pass through the
    // printed-reference exclusion, the author-block and equation guards, the
    // overlap dedup and the ordinal bound below — a rectangle is evidence about
    // POSITION and says nothing about whether the thing at that position is a
    // citation of an entry this bibliography has. The dedup then prefers the
    // longer span where a native site and a scanned marker cover the same text,
    // so the two sources reinforce rather than duplicate.
    for (const site of nativeInPara.get(para.paraId) ?? []) {
      const text = para.text.slice(site.charStart - para.charStart, site.charEnd - para.charStart)
      // The digits inside the rectangle ARE the marker. A site whose text holds
      // no number is a link to something else — a figure, a footnote — that
      // survived the name filter, and is dropped rather than guessed at.
      const m = /[0-9]+(?:\s*[,;\u2010-\u2015-]\s*[0-9]+)*/.exec(text)
      if (!m) continue
      // A SITE MUST BE MARKER-SIZED TO BE A MARKER POSITION.
      //
      // Some producers give pdf.js one item per LINE, so a rectangle around a
      // single `[5]` resolves to the whole line that contains it — 66 characters
      // on work 11. That span is not wrong about where the citation is, but it
      // is useless as a position and actively harmful as a marker: the dedup
      // below prefers the longer match, so one line-wide site swallowed the two
      // real `[20]` and `[21]` beside it and emitted only its first number,
      // costing that paper two ordinals it already had.
      //
      // So the span is trimmed to the digits it contains. Where the producer was
      // per-glyph the trim changes nothing; where it was per-line it turns an
      // unusable span into the marker's own offsets.
      const start = site.charStart + m.index
      found.push({ offset: start, end: start + m[0].length, interior: m[0] })
    }

    for (const run of superByPara.get(para.paraId) ?? []) {
      // Judged on the CANONICAL TEXT before the marker, not on the previous
      // text item. The geometric scanner sees a stream in which the run before
      // a raised digit is very often a lone `" "` — pdf.js emits the inter-word
      // space as an item of its own — so an item-level test for a preceding
      // digit reads that space, finds no digit, and passes every `10 5` in the
      // paper. The characters do not have that hole.
      const lead = para.text.slice(0, run.charStart - para.charStart)
      if (CONTINUES_A_NUMBER_RE.test(lead)) continue
      const group = MATH_GROUP_BEFORE_RE.exec(lead)
      if (group && !/\p{L}{3}/u.test(group[1])) continue
      found.push({
        offset: run.charStart,
        end: run.charEnd,
        // A trailing `.` or `,` belongs to the sentence, not to the citation.
        interior: run.str.trim().replace(/[.,]$/, '')
      })
    }

    // A marker standing inside a PRINTED REFERENCE is that reference's own
    // number, not a callout to it. Applied per marker rather than per paragraph
    // because a footnote block shares its paragraph with the body text above it:
    // dropping the whole paragraph would take the real callouts with the fake
    // ones, and keeping the whole paragraph is what filed a paper's bibliography
    // as its citing sentences.
    for (let i = found.length - 1; i >= 0; i--) {
      if (inSpans(printed, found[i].offset)) found.splice(i, 1)
    }

    // A marker inside an AUTHOR BLOCK or an EQUATION is not a citation either,
    // and unlike the two above it cannot be judged from the token to its left.
    //
    // Scoped to a WINDOW around the marker rather than the paragraph, for the
    // same reason the printed-reference test is per marker: extraction routinely
    // glues an affiliation block onto the abstract that follows it, and judging
    // the paragraph would drop that abstract's real citations along with the
    // footnote markers. The window is wide enough to contain the institution
    // name that follows a marker and the equation number that precedes one, and
    // narrow enough that a paragraph mentioning a university in passing keeps
    // its citations.
    // JUDGED ON THE SENTENCE THE CALLOUT WILL BE STORED WITH, which is the same
    // text a reader sees and a role classifier reads.
    //
    // Three narrower scopes were tried against the corpus and each failed on
    // real data. A symmetric character window rejected a genuine `[7]` standing
    // 25 characters after an `Eq. (5)`. Asymmetric lead/ahead windows let 15
    // markers back in, because an author block is a RUN — `1 Department of
    // Biochemistry, 2 Biomolecular Structure and Design, 3 Howard Hughes` — and
    // only its first marker has the institution word within reach. A line test
    // failed both ways: paragraphs here keep their newlines (35-41 per
    // paragraph), so a display equation's `(7)` sits alone on its line with
    // `eqn (5)` on the next.
    //
    // The sentence has none of those seams, and it is the unit that matters:
    // if the passage stored beside a citation is an author block or an equation
    // line, the callout is wrong however the marker looked in isolation.
    for (let i = found.length - 1; i >= 0; i--) {
      const s = sentenceAt(para, found[i].offset).text
      if (AFFILIATION_BLOCK_RE.test(s) || EQUATION_CONTEXT_RE.test(s)) found.splice(i, 1)
    }

    // ONE marker per span of text, whatever found it.
    //
    // Three scanners write into `found` — square brackets, round brackets and
    // superscript geometry — and they overlap: a superscript run and a round
    // -bracket match can cover the same characters, so the same (document,
    // offset, ordinal) was emitted twice and the store's unique index rejected
    // the whole paper's contexts. Sorted by position, then by the LONGER match
    // first, so `(16, 26)` wins over a bare `16` that starts at the same place.
    found.sort((a, b) => a.offset - b.offset || b.end - a.end)
    let lastEnd = -1
    const unique = found.filter((f) => {
      if (f.offset < lastEnd) return false
      lastEnd = f.end
      return true
    })

    for (const marker of unique) {
      const { offset, end } = marker
      const ordinals = expandMarker(marker.interior)
      if (!ordinals) {
        malformedMarkers++
        continue
      }
      const sentence = sentenceAt(para, offset)
      for (const ordinal of ordinals) {
        if (!input.knownOrdinals.has(ordinal)) {
          // DROPPED, not manufactured into an entity. Turning a dangling
          // callout into an `unresolved_reference` row would put a blank
          // reference — there is no bibliography entry to copy text from — in
          // front of the user with an invitation to go and fetch it.
          danglingCallouts++
          continue
        }
        // The STORED key is (document, offset, ordinal), and two scanners can
        // reach the same one: a superscript run and a round-bracket match cover
        // overlapping characters, so the same citation was emitted twice and
        // the store's unique index rejected the paper's entire context set.
        // One marker yielding SEVERAL ordinals is still fine — that is `(16,
        // 26)`, two citations at one offset — so the guard is per (offset,
        // ordinal), not per offset.
        const emitKey = `${offset}|${ordinal}`
        if (emitted.has(emitKey)) continue
        emitted.add(emitKey)
        seen.add(ordinal)
        callouts.push({
          offset,
          end,
          ordinal,
          paraId: para.paraId,
          page: para.page,
          section: para.section,
          sentence: sentence.text,
          markerInSentence: sentence.markerInSentence
        })
      }
    }
  }

  return {
    callouts,
    malformedMarkers,
    danglingCallouts,
    distinctOrdinals: seen.size
  }
}

/**
 * Whether the callout -> ordinal mapping may be trusted at all.
 *
 * A mis-detected numbering scheme produces confidently wrong role/sentence
 * pairs attached to the WRONG papers, which is worse than having none: a user
 * cannot tell a wrong citation context from a right one by looking at it. So
 * the stage DECLINES — `refused`, with the numbers — rather than writing them.
 *
 * `refused`, not `empty`: the paper is full of citations, and the stage found
 * some. What it will not do is claim it knows which entry each one names. A UI
 * that renders that as "there was genuinely nothing here" tells the reader a
 * paper has no citation contexts when what happened is that the app declined to
 * guess — and on this corpus that is 6 of 20 papers.
 */
export function calloutGate(
  scan: CalloutScan,
  /**
   * How many references the paper PRINTED — not how many rows its parse made.
   *
   * The numerator is distinct cited ordinals, which is bounded by the printed
   * count, so a row count here compares two different populations and can put
   * the maximum achievable fraction below the threshold. See
   * `minCitedFraction`.
   */
  printedCount: number
): { ok: true } | { ok: false; reason: string } {
  if (scan.distinctOrdinals < CALLOUT_LIMITS.minMarkers) {
    return {
      ok: false,
      reason:
        `callout mapping below the confidence gate: ${scan.distinctOrdinals} distinct marker(s), ` +
        `fewer than ${CALLOUT_LIMITS.minMarkers}`
    }
  }
  const fraction = printedCount > 0 ? scan.distinctOrdinals / printedCount : 0
  if (fraction < CALLOUT_LIMITS.minCitedFraction) {
    return {
      ok: false,
      reason:
        `callout mapping below the confidence gate: ${Math.round(fraction * 100)}% of ` +
        `${printedCount} references cited, under ` +
        `${Math.round(CALLOUT_LIMITS.minCitedFraction * 100)}%`
    }
  }
  return { ok: true }
}
