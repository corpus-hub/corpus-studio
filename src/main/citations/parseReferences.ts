// Deterministic reference-section parser + corpus matcher.
//
// Contract: `parseReferences(text)` is a PURE function. The same extracted PDF
// text always yields byte-identical output — no randomness, no LLM, no network,
// no clock. That is what makes the result safe to pre-bake into the DB and
// re-derive on demand.
//
// The pipeline is three stages, each independently testable:
//
//   1. locateReferenceSection  — find where the bibliography starts and ends
//   2. splitEntries            — cut that span into individual numbered entries
//   3. parseEntry              — pull authors / year / title / venue / DOI out
//
// and then `matchReferences` scores each parsed entry against known corpus
// works.

import {
  contentTokens,
  extractSurnames,
  findDois,
  foldText,
  normalizeDoi,
  normalizeLoose,
  surnamesEqual,
  unwrapLines,
  venueSimilarity
} from './normalize'
import {
  detectStyle,
  extractFields,
  GENERIC_STYLE,
  type CitationStyle,
  type StyleProfile
} from './entryFields'

// ---------------------------------------------------------------- data types

export interface ParsedReference {
  /** 1-based position within the reference list, as printed when numbered. */
  ordinal: number
  /** The entry EXACTLY as it appeared, newlines and all. Ontology requires it. */
  raw_bib_text: string
  /**
   * Where this entry is PRINTED, in the document's own offset space.
   *
   * Carried because a bibliography is not always one block. Older journals set
   * each reference at the foot of the page that cites it, so the entries are
   * scattered through the body and no single range describes them — and a
   * callout scanner given only a range either excludes the whole paper or
   * excludes nothing, both of which are wrong. Per-entry spans say exactly
   * where the printed notes are, wherever they are.
   *
   * -1/-1 when the entry could not be located, which every consumer must read
   * as "no region", never as offset zero. A sub-entry of a lettered composite
   * is one such case, but NOT the only one, so -1 does not identify a part —
   * `part_label` does.
   */
  char_start: number
  char_end: number
  /**
   * Which lettered part of a composite entry this is: `'a'`, `'b'`, … — or
   * NULL for an entry that is not part of one.
   *
   * ACS and Angewandte print several distinct papers under one number, as
   * `(11) (a) … (b) … (c) …`, and `splitSubEntries` emits one reference per
   * part BESIDE the composite so each cited paper can be matched on its own.
   * All of them share the parent's `ordinal`, so the ordinal cannot tell them
   * apart, and the row count is therefore NOT the number of references the
   * paper printed — work 21 of the KE07 corpus prints 44 and yields 83 rows.
   *
   * WITHOUT THIS FIELD EVERY CONSUMER GUESSES, and nine of them guessed wrong:
   * a confidence gate divided distinct ordinals (max 44) by rows (83) and
   * refused a paper whose citations had in fact been located, the reference
   * tree drew deduplicated nodes beside an undeduplicated total, and the
   * outline-vs-prose comparison that exists to catch over-splitting was itself
   * fooled by it. The letter is captured at the split, where it is printed
   * fact, rather than re-derived downstream from position — parts under the
   * minimum length are dropped, so counting them afterwards mislabels the rest.
   *
   * The COMPOSITE carries null, not `'a'`: it stands for the whole printed
   * entry, and its `raw_bib_text` is what the page shows.
   */
  part_label: string | null
  authors: string | null
  /** Surnames harvested from `authors`, folded and lowercased. */
  surnames: string[]
  year: number | null
  title: string | null
  venue: string | null
  /**
   * Volume and page range. For styles that print NO title (ACS, Angewandte,
   * RSC, older JACS) these two plus venue+year are the entire identity of the
   * referenced paper, so they are first-class fields rather than debris left in
   * `raw_bib_text`. They also sharpen matching: two papers by the same group in
   * the same journal and year differ in their volume/page coordinate.
   */
  volume: string | null
  pages: string | null
  doi: string | null
}

/**
 * How many references the paper PRINTED, as opposed to how many rows the parse
 * produced.
 *
 * THE TWO ARE NOT THE SAME NUMBER and the difference is not small: a lettered
 * composite contributes one row for itself plus one per part, so work 21 of the
 * KE07 corpus prints 44 references and parses to 83 rows. Use THIS wherever the
 * answer is a statement about the bibliography — a count shown to the reader, a
 * denominator, a comparison against another source's entry count. Use
 * `references.length` only when the question really is "how many rows do I
 * have", which is what resolution and retrieval want, since every part is a
 * distinct paper to look up.
 *
 * Counting the non-parts rather than the distinct ordinals is deliberate: an
 * unnumbered bibliography (author-year) has no ordinals to count, and a
 * mis-split numbered one can print the same ordinal twice — this corpus has a
 * paper that prints ordinal 22 five times — so distinct-ordinal counting would
 * silently undercount exactly the papers whose parse is already shaky.
 */
export function printedReferenceCount(references: ParsedReference[]): number {
  return references.reduce((n, r) => (r.part_label === null ? n + 1 : n), 0)
}

export interface ParseDiagnostics {
  /** How the section was located, for debugging a bad parse. */
  section_strategy: 'heading' | 'numbered-tail' | 'none'
  /** Which numbering style the splitter locked onto. */
  entry_style: 'dot' | 'bracket' | 'paren' | 'bare' | 'author-year' | 'none'
  /** The per-document citation style the field extractor detected. */
  citation_style: CitationStyle
  /** Fraction of entries whose tail agreed with the detected style. */
  style_confidence: number
  section_char_start: number
  section_char_end: number
  /** Set when the PDF has no usable text layer at all (e.g. a scan). */
  no_text_layer: boolean
}

export interface ParseResult {
  references: ParsedReference[]
  diagnostics: ParseDiagnostics
}

// ------------------------------------------------------ 1. locate the section

/**
 * Headings that introduce a bibliography. Matched at a line start so a mid-
 * sentence "references" never triggers.
 *
 * `BIBLIOGRAPHICAL REFERENCES` is here because one paper prints exactly that
 * ("8. Bibliographical References"), and the section was not found at all.
 */
const HEADING_RE =
  /^[\s\d.]*(?:REFERENCES?\s+AND\s+NOTES?|REFERENCES?\s+CITED|LITERATURE\s+CITED|BIBLIOGRAPHICAL\s+REFERENCES?|REFERENCES?|BIBLIOGRAPHY|NOTES\s+AND\s+REFERENCES)\s*:?\s*$/i

/**
 * A heading line with LETTERSPACING undone, or null when it is not that shape.
 *
 * LaTeX `\textsc{References}` and letterspaced display headings extract as
 * `R EFERENCES`: the large first glyph is a separate text run, so pdfjs emits a
 * space after it. `HEADING_RE` is anchored `^...$`, so that one space is enough
 * to lose the entire bibliography — three papers in the embeddings corpus (26,
 * 29, 32) found NO section at all and reported zero references for this reason.
 *
 * Deliberately narrow. It closes up spacing ONLY for a line that is entirely
 * capitals, spaces and punctuation, so it can never join words in a normal
 * sentence — `R EFERENCES` becomes `REFERENCES`, while `See References` (mixed
 * case) is left untouched and a body line is never considered. The result is
 * only ever fed back through `HEADING_RE`, so a false positive here still has
 * to look like a heading to have any effect.
 */
function unspacedHeading(line: string): string | null {
  if (!/^[A-Z\s.:\d]+$/.test(line)) return null
  const closed = line.replace(/\s+/g, '')
  return closed.length >= 8 ? closed : null
}

/**
 * Locate the reference section.
 *
 * Strategy A (`heading`): scan lines for a standalone REFERENCES-style heading.
 * We take the LAST such heading in the back half of the document — front matter
 * and running heads produce spurious early hits, and supplementary material can
 * add a second, later list which is still references.
 *
 * Strategy B (`numbered-tail`): several publishers in this corpus (Nature, PNAS,
 * JACS) print no heading at all in the text layer, or set it as a graphic. For
 * those we search backwards for the longest run of consecutive ascending
 * reference numbers ("1." ... "2." ... "3." ...) and take its start. This is
 * what recovers the ~8 headingless papers.
 *
 * End of section: the document end, unless a clearly post-bibliography heading
 * (Supplementary, Acknowledgements, Author information) starts a line
 * afterwards.
 */
export function locateReferenceSection(text: string): {
  start: number
  end: number
  strategy: 'heading' | 'numbered-tail' | 'none'
} {
  const lineStarts = computeLineStarts(text)

  // ---- Strategy A: explicit heading
  let headingAt = -1
  for (let i = lineStarts.length - 1; i >= 0; i--) {
    const s = lineStarts[i]
    const e = i + 1 < lineStarts.length ? lineStarts[i + 1] : text.length
    const line = text.slice(s, e).replace(/[\n\f\r]/g, '').trim()
    if (!line) continue
    const unspaced = unspacedHeading(line)
    if (HEADING_RE.test(line) || (unspaced !== null && HEADING_RE.test(unspaced))) {
      // Guard against a table of contents / running head near the front — but
      // only when the text that FOLLOWS does not read like a bibliography.
      //
      // A flat position cutoff is wrong for combined manuscript+supplement PDFs:
      // one Science paper here puts "References and Notes" early, with 25 pages
      // of supplementary figures and crystallography tables after it, so the
      // real reference list sits at 8% of the document and was rejected outright
      // — that paper parsed ZERO references. Asking whether citations actually
      // follow the heading decides it on evidence rather than on position.
      if (s < text.length * 0.25) {
        const probe = text.slice(e, Math.min(text.length, e + 4000))
        const marks = ascendingChain(collectMarkers(probe))
        if (marks.length < 4 || !looksBibliographic(probe, marks)) continue
      }
      headingAt = e
      break
    }
  }

  if (headingAt >= 0) {
    return { start: headingAt, end: findSectionEnd(text, headingAt), strategy: 'heading' }
  }

  // ---- Strategy B: longest ascending numbered run
  const runStart = findNumberedRunStart(text)
  if (runStart >= 0) {
    return { start: runStart, end: findSectionEnd(text, runStart), strategy: 'numbered-tail' }
  }

  return { start: -1, end: -1, strategy: 'none' }
}

function computeLineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1)
  }
  return starts
}

/**
 * Headings that END a reference list.
 *
 * Getting this wrong is the single most destructive failure in the parser: with
 * no terminator, the LAST entry absorbs everything that follows it. One Nature
 * paper produced a 21,916-character "reference" that began correctly and then
 * swallowed the Supplementary Information, the Acknowledgements, the page
 * footer and the entire Methods section — and that blob is what gets matched
 * against other papers.
 *
 * Matched with a trailing colon or nothing, so a sentence merely mentioning
 * "methods" cannot cut the list short.
 */
const POST_REF_HEADING_RE =
  /^\s*(?:supplementary\s+(?:information|material|data|methods|note)s?|appendix(?:\s*[A-Z\d][.:]?)?|appendices|author\s+(?:information|contributions?)|acknowledge?ments?|competing\s+(?:financial\s+)?interests?|about\s+the\s+authors?|methods?|online\s+methods?|experimental\s+(?:section|procedures?)|materials\s+and\s+methods|conflicts?\s+of\s+interest|funding|data\s+availability|abbreviations|summary|conclusions?)\s*:?\s*$/i

/**
 * A heading that ends the list but is PREFIXED or SUFFIXED by its own title,
 * so it is not a standalone line.
 *
 * Preprints append their supplement to the same PDF and title the break
 * "Appendix: All-but-the-Top: Simple and Effective postprocessing" or
 * "Supplementary Material: <paper title>" — a heading with a colon and then
 * prose, which `POST_REF_HEADING_RE` cannot match because it is anchored to end
 * the line. Three papers in the embeddings corpus run their located section
 * straight through the bibliography into proofs, tables and figure captions
 * because of this; work 26's section is 43,000 characters of which only the
 * first 12,000 are references.
 *
 * Kept separate from the anchored pattern rather than relaxing it: a heading
 * that continues into prose is far weaker evidence, so it is only consulted
 * once the list is known to have started, and only for these few words that do
 * not appear as ordinary sentence openers in a bibliography.
 */
const POST_REF_PREFIX_RE =
  /^\s*(?:appendix|appendices|supplementary\s+(?:material|information|note)s?|supplement)\s*[:.]\s*\S/i

/**
 * A numbered supplementary heading: `S1 Definitions`, `S2 Proofs`, `S3 Results`.
 *
 * arXiv preprints bind their supplement into the same file and number its
 * sections in an S-series, which is neither a standalone terminator word nor a
 * prefixed one. Work 34's bibliography really ends 4,000 characters in and the
 * remaining 39,000 are `S1 Definitions` onward — correctly not parsed as
 * references, but carried inside the section, which makes every measure of
 * "how much did we cover" meaningless and leaves appendix prose inside the
 * span consumers treat as bibliography.
 *
 * The letter is required to be `S` and the number short, so an ordinary
 * sentence cannot match; a bibliography entry never begins this way.
 */
const POST_REF_SUPP_SECTION_RE = /^\s*S\s?\d{1,2}\.?\s+[A-Z][A-Za-z]/

/**
 * Where the reference list stops.
 *
 * A terminator only counts once the list has actually STARTED producing
 * references. Two-column extraction interleaves a paper's own abstract and
 * section headings with the reference text, so an unguarded match on "Methods"
 * or "Summary" fired before the first citation and cut a 50-entry list down to
 * 17. Requiring citations before the cut means the heading has to appear after
 * the list, which is the only place a real terminator can be.
 */
function findSectionEnd(text: string, from: number): number {
  const lineStarts = computeLineStarts(text).filter((s) => s > from)
  for (const s of lineStarts) {
    const nl = text.indexOf('\n', s)
    const line = text.slice(s, nl < 0 ? text.length : nl).trim()
    const anchored = POST_REF_HEADING_RE.test(line)
    const prefixed =
      !anchored && (POST_REF_PREFIX_RE.test(line) || POST_REF_SUPP_SECTION_RE.test(line))
    if (!anchored && !prefixed) continue
    if (!listHasStarted(text.slice(from, s))) continue
    return s
  }
  return text.length
}

/**
 * Has the reference list actually begun by this point?
 *
 * The terminator guard exists because two-column extraction interleaves a
 * paper's own headings with the reference text, so an unguarded match on
 * "Methods" fired before the first citation and cut a 50-entry list to 17. The
 * original test was a chain of MIN_RUN ascending markers — which is sound for a
 * numbered bibliography and UNSATISFIABLE for an unnumbered one, where no
 * markers exist at all. So for author-year lists the guard could never pass,
 * no terminator was ever honoured, and the section ran to the end of the
 * document: work 26 swallowed 31,000 characters of appendix, proofs and table
 * captions, and work 35 a 7,000-character derivation that parsed as a single
 * reference.
 *
 * Either kind of evidence now counts. Citation-shaped lines are what a
 * bibliography is made of whether or not anyone numbered them, so several of
 * them is the same claim the marker chain was making, expressed in a way an
 * unnumbered list can satisfy.
 */
function listHasStarted(before: string): boolean {
  if (ascendingChain(collectMarkers(before)).length >= MIN_RUN) return true
  const opener = before
    .split('\n')
    .filter((l) => opensAnEntry(foldText(l.trim())))
    .length
  return opener >= MIN_RUN
}

/**
 * Find where a printed reference list begins, by numbering alone.
 *
 * We collect every line that opens with a reference marker, then look for the
 * longest chain whose numbers ascend by one starting from 1. A bibliography is
 * the only place in a paper with 8+ such lines in strict sequence — figure
 * captions and equation numbers do not sustain the run — so a MIN_RUN of 8 is
 * both safe and generous.
 */
const MIN_RUN = 8

const MARKER_RES: Array<{ style: ParseDiagnostics['entry_style']; re: RegExp }> = [
  { style: 'dot', re: /^\s*(\d{1,3})\.\s+(?=\S)/ },
  { style: 'bracket', re: /^\s*\[\s*(\d{1,3})\s*\]\s*(?=\S)/ },
  // Spaces INSIDE the delimiters ("( 8 )") are common in older typography and
  // in text layers that separate every glyph run; without them the entry is
  // merged into its predecessor and its number goes missing from the list.
  { style: 'paren', re: /^\s*\(\s*(\d{1,3})\s*\)\s+(?=\S)/ },
  { style: 'bare', re: /^\s*(\d{1,3})\s+(?=[A-Z(\[])/ }
]

interface Marker {
  offset: number
  num: number
  style: ParseDiagnostics['entry_style']
}

function collectMarkers(text: string, style?: ParseDiagnostics['entry_style']): Marker[] {
  const out: Marker[] = []
  const starts = computeLineStarts(text)
  const candidates = style ? MARKER_RES.filter((r) => r.style === style) : MARKER_RES
  for (const s of starts) {
    const nl = text.indexOf('\n', s)
    const line = text.slice(s, nl < 0 ? text.length : nl)
    let matched = false
    for (const { style: st, re } of candidates) {
      const m = re.exec(line)
      if (m) {
        out.push({ offset: s, num: Number(m[1]), style: st })
        matched = true
        break
      }
    }
    if (matched) continue
    // MID-LINE MARKERS. A running head or a stray table caption gets spliced
    // into the text layer ahead of an entry, so the entry's own marker no
    // longer starts a line: "... Biochemistry ARTICLE (2) Khersonsky, O., ...".
    // A line-start-only rule silently merges that entry into its predecessor,
    // and the merged blob then matches on the WRONG paper's title. Accept a
    // marker mid-line when it is followed by something that looks like the
    // start of an author list (Capital + initial or Capital + comma).
    for (const { style: st } of candidates) {
      const mid = midLineMarkerRe(st)
      if (!mid) continue
      mid.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = mid.exec(line))) {
        if (m.index === 0) continue
        out.push({ offset: s + m.index, num: Number(m[1]), style: st })
      }
    }
  }
  // Offsets must stay ascending for the chain walk to be meaningful.
  out.sort((a, b) => a.offset - b.offset)
  return out
}

/**
 * Mid-line form of each marker style, deliberately stricter than the
 * line-start form: it must be preceded by whitespace and followed by a
 * capitalised surname plus an initial or comma, which is the shape every
 * bibliography entry opens with. Without that guard, "(4)" inside a sentence or
 * a chemical formula would split entries at random.
 */
function midLineMarkerRe(style: ParseDiagnostics['entry_style']): RegExp | null {
  switch (style) {
    case 'paren':
      return /\s\(\s*(\d{1,3})\s*\)\s+(?=[A-Z][A-Za-z'\u00c0-\u024f-]{1,}\s*,)/g
    case 'bracket':
      return /\s\[\s*(\d{1,3})\s*\]\s+(?=[A-Z][A-Za-z'\u00c0-\u024f-]{1,}\s*,)/g
    case 'dot':
      return /\s(\d{1,3})\.\s+(?=[A-Z][A-Za-z'\u00c0-\u024f-]{2,}\s*,\s*[A-Z]\.)/g
    case 'bare':
      // An unpunctuated marker ("2 D. Röthlisberger, ...") is the weakest shape
      // there is, so mid-line it is only accepted when followed by the
      // initials-first author form (`D. Surname`) that this style always uses.
      // Journals that set the marker as a hanging number let a running head or a
      // page footer flow into the text layer directly ahead of it — "Phys. Chem.
      // Chem. Phys. 2 D. Röthlisberger, ..." — and without this the whole entry
      // is swallowed by its predecessor and scores against the wrong paper.
      // The surname pattern tolerates an embedded space+diacritic run because
      // that is exactly how pdfjs emits an accented name here: the very entry
      // this rule exists to rescue reads "2 D. Ro ¨thlisberger, O. Khersonsky".
      return /\s(\d{1,3})\s+(?=[A-Z]\.\s*(?:[A-Z]\.\s*)?[A-Z][A-Za-z'\u00c0-\u024f-]*(?:\s*[\u00a8\u00b4\u0060\u02c6\u02dc\u02da\u02dd\u00af]\s*[A-Za-z'\u00c0-\u024f-]+)?[A-Za-z'\u00c0-\u024f-]*\s*,)/g
    default:
      return null
  }
}

/**
 * Longest ascending chain of markers, per numbering style.
 *
 * GAP TOLERANCE MATTERS. An exactly-consecutive rule looks right but fails in
 * practice: the text layer drops the occasional marker when an entry starts
 * mid-line after a column break, so a real 44-entry list reads
 * "1, 3, 4, 5, ..." and a strict rule sees a chain of length 1. We therefore
 * accept any marker that is greater than the last accepted one by at most
 * MAX_GAP. Numbers must still ASCEND, which is what keeps volume numbers and
 * page numbers (which jump around) out of the chain.
 */
const MAX_GAP = 3

function ascendingChain(markers: Marker[]): Marker[] {
  return bestChainFrom(markers)
}

/**
 * Longest ascending chain, searched from EVERY plausible start.
 *
 * Anchoring naively on the first small number is wrong, and wrongly in a way
 * that is easy to miss: papers number their body sections too ("2. Concluding
 * Remarks", "3. Methods"), so a chain started at the first "1." swallows the
 * whole back half of the paper and the real bibliography ends up merged into a
 * handful of giant pseudo-entries. Searching all starts and keeping the LONGEST
 * chain picks the bibliography, because a reference list has an order of
 * magnitude more consecutive markers than a section outline.
 *
 * Ties go to the LATER start: a bibliography sits at the end of a document, and
 * the equal-length alternative is invariably the section outline above it.
 */
function bestChainFrom(markers: Marker[]): Marker[] {
  let best: Marker[] = []
  for (let i = 0; i < markers.length; i++) {
    if (markers[i].num > MAX_GAP) continue
    const chain: Marker[] = [markers[i]]
    for (let j = i + 1; j < markers.length; j++) {
      const last = chain[chain.length - 1].num
      if (markers[j].num > last && markers[j].num - last <= MAX_GAP) chain.push(markers[j])
    }
    if (chain.length >= best.length) best = chain
  }
  return best
}

/**
 * Does this run of numbered lines actually read like a bibliography?
 *
 * An ascending numbered chain is NOT enough on its own. Papers number figures,
 * tables, equations and schemes, and those captions run in strict sequence too:
 * on a 1973 chemistry paper the chain starting at "Figure 1.-Variation of
 * pseudo-first-order rate constant..." was longer than the real reference list,
 * so the section was located at 5% of the document and 47,000 characters of body
 * text were parsed as references. Four of twenty papers failed exactly this way.
 *
 * The discriminator is content, not numbering: a reference carries a year, and
 * usually author initials or a page range. Captions carry none of those.
 */
function looksBibliographic(text: string, markers: Marker[]): boolean {
  let scored = 0
  const sample = markers.slice(0, 12)
  for (let i = 0; i < sample.length; i++) {
    const from = sample[i].offset
    const to = i + 1 < sample.length ? sample[i + 1].offset : Math.min(text.length, from + 400)
    const entry = text.slice(from, to)
    const hasYear = /\b(1[89]\d{2}|20\d{2})\b/.test(entry)
    // "Smith, J." / "Smith JA" / "J. Smith" — an initial next to a surname.
    const hasInitials = /[A-Z][a-z]+,?\s+[A-Z]\.|[A-Z]\.\s*[A-Z]?\.?\s+[A-Z][a-z]+/.test(entry)
    const hasPages = /\b\d{1,4}\s*[–—-]\s*\d{1,4}\b/.test(entry)
    const hasDoi = /\b10\.\d{4,9}\//.test(entry)
    if (hasYear && (hasInitials || hasPages || hasDoi)) scored++
  }
  // A majority of the sampled entries must look like citations. Captions
  // occasionally mention a year, so a lone hit must not carry the whole run.
  return sample.length > 0 && scored >= Math.max(3, Math.ceil(sample.length * 0.5))
}

/**
 * Offset of the first marker of the longest ascending BIBLIOGRAPHIC chain.
 *
 * Chains are considered longest-first, but a chain that does not read like
 * citations is skipped rather than accepted — otherwise the longest run of
 * figure captions in the paper wins.
 */
function findNumberedRunStart(text: string): number {
  const chains: Marker[][] = []
  for (const { style } of MARKER_RES) {
    const chain = ascendingChain(collectMarkers(text, style))
    if (chain.length >= MIN_RUN) chains.push(chain)
  }
  chains.sort((a, b) => b.length - a.length)
  for (const chain of chains) {
    if (!looksBibliographic(text, chain)) continue
    // A BIBLIOGRAPHY IS A TAIL. This returns the start of the longest chain
    // that reads like citations, wherever it begins — and on two papers here
    // that was a numbered list near the front, so the "bibliography" was
    // declared to be 80% and 86% of the whole document. Everything inside it is
    // excluded from citation scanning, which left 11 body paragraphs of 71 and
    // 9 of 119: both papers reported almost no citations and were refused at
    // the confidence gate, looking like a citation-style problem rather than
    // this.
    //
    // The heading path already guards its early matches by probing the text
    // that follows; the numbered path had no such check. A run starting in the
    // first half AND swallowing most of the paper is not a reference list —
    // real ones here start at 80-90% and span 10-20%. Rejected rather than
    // trimmed: guessing a different start would be inventing a boundary the
    // evidence does not support, and `strategy: 'none'` is honest.
    // Where the chain actually STARTS being a bibliography.
    //
    // The first marker of the longest citation-like chain is not always the
    // first reference: an early numbered list in the body — a numbered protocol,
    // a compound list — continues the same ascending sequence, so the chain
    // begins there and the "bibliography" was declared to be 80% and 86% of two
    // of these papers. Everything inside it is excluded from citation scanning,
    // which left 11 body paragraphs of 71 and 9 of 119.
    //
    // Rejecting such a chain outright is worse: measured, it cost four papers
    // their entire reference list (34, 22, 47 and 50 references), because on
    // those the chain is the real bibliography and merely starts earlier than a
    // ratio expects. So the chain is TRIMMED instead. A reference list is dense
    // and contiguous, so the answer is the longest run of markers with no large
    // prose gap between them — the gap is the body text that separates a stray
    // early list from the real tail.
    const trimmed = denseTail(chain)
    return trimmed[0].offset
  }
  return -1
}

/**
 * The largest gap between consecutive entries inside one reference list.
 *
 * A bibliography is dense: entries follow one another with a few hundred
 * characters between them at most. A gap far larger than that is body text, and
 * the markers before it belong to a different list.
 */
const MAX_ENTRY_GAP = 3000

/**
 * The last dense run of a marker chain — the bibliography, without any earlier
 * numbered list that happens to continue the same ascending sequence.
 *
 * Trimming rather than rejecting, because on four of this corpus's papers the
 * chain IS the reference list and merely starts earlier than a position ratio
 * expects; rejecting them cost 34, 22, 47 and 50 references outright.
 */
function denseTail(chain: Marker[]): Marker[] {
  let start = 0
  for (let i = 1; i < chain.length; i++) {
    if (chain[i].offset - chain[i - 1].offset > MAX_ENTRY_GAP) start = i
  }
  // A tail of one or two markers is not a bibliography; keep the whole chain
  // rather than trusting a split that leaves nothing behind it.
  return chain.length - start >= MIN_RUN ? chain.slice(start) : chain
}

/**
 * Are this paper's references FOOTNOTES scattered through the body, rather than
 * a list at the end?
 *
 * Older journals print each reference at the foot of the page that cites it, so
 * the markers really do run from the first page to the last and no trimming can
 * find a tail — there is not one. Treating that span as "the bibliography"
 * excludes the whole paper from citation scanning: on one paper here it hid 60
 * of 71 paragraphs, including `Experimental Section` and the Materials
 * paragraph, and the paper then reported almost no citations.
 *
 * When the span covers most of the document, the honest answer is that there is
 * no reference SECTION to exclude. The entries are still parsed — they are
 * really there — but nothing is fenced off from the callout scanner, which is
 * what `[-1, -1]` means everywhere else in this module.
 */
export function isFootnoteStyle(start: number, end: number, textLength: number): boolean {
  if (start < 0 || textLength <= 0) return false
  return (end - start) / textLength > MAX_BIB_SPAN
}

/** Above this share of the document, a "reference section" is the paper. */
const MAX_BIB_SPAN = 0.5

// ----------------------------------------------------------- 2. split entries

/**
 * Cut the located span into entries.
 *
 * Numbered lists dominate this corpus, so we pick the numbering style with the
 * longest ascending chain inside the span and slice between consecutive
 * markers. Only markers that continue the ascending sequence are cut points —
 * that is what stops a page number, a volume number or an interleaved
 * running-head line from splitting an entry in half.
 *
 * Unnumbered author-year bibliographies (paper 17 in this corpus, Protein
 * Science style) fall back to a line-start heuristic: a new entry begins at a
 * line that starts with a capitalised surname followed by initials, and ends
 * where the next such line begins.
 */
export function splitEntries(
  section: string,
  runningHead?: RegExp | null
): {
  entries: SplitEntry[]
  style: ParseDiagnostics['entry_style']
} {
  let best: { style: ParseDiagnostics['entry_style']; chain: Marker[] } | null = null

  for (const { style } of MARKER_RES) {
    const markers = collectMarkers(section, style)
    const chain = ascendingChain(markers)
    if (chain.length >= 3 && (!best || chain.length > best.chain.length)) {
      best = { style, chain }
    }
  }

  if (best) {
    const entries: SplitEntry[] = []
    for (let i = 0; i < best.chain.length; i++) {
      const start = best.chain[i].offset
      const end = i + 1 < best.chain.length ? best.chain[i + 1].offset : section.length
      // Furniture FIRST: a running head sitting mid-entry would otherwise be
      // read as the citation's own title, year, venue or DOI.
      const raw = trimRunaway(stripFurniture(section.slice(start, end).trim(), runningHead))
      entries.push({ ordinal: best.chain[i].num, raw, ...printedSpan(section, start, end, raw) })
    }

    // A chain wins on LENGTH, which says nothing about whether it explains the
    // section. Where it plainly does not, the unnumbered split gets to compete:
    // a three-numeral chain that leaves 90% of the text in two oversized slabs
    // loses to a split that carves the same text into ninety entry-shaped ones.
    //
    // The comparison is deliberately lopsided. The marker split is kept unless
    // it covers less than half the section AND the alternative covers
    // substantially more — so a numbered bibliography, where the chain covers
    // nearly everything, is never even compared, and the KE07 corpus cannot
    // change behaviour. Only a chain that has already failed on its own terms
    // is at risk of being replaced.
    const markerCoverage = splitCoverage(entries, section.length)
    if (markerCoverage < 0.5) {
      const alt = splitAuthorYearEntries(section, runningHead)
      if (splitCoverage(alt, section.length) > markerCoverage * 1.5 && alt.length > entries.length) {
        return { entries: alt, style: 'author-year' }
      }
    }

    return { entries, style: best.style }
  }

  return { entries: splitAuthorYearEntries(section, runningHead), style: 'author-year' }
}

/**
 * How much of the section a split actually ACCOUNTS FOR.
 *
 * A marker chain is chosen by its length, which asks "how many numbers ascend
 * here" and never "do those numbers explain this text". Those come apart badly
 * when a bibliography carries no markers at all: three stray numerals in
 * 36,000 characters form a chain of three, the chain wins because nothing
 * compares it against the alternative, and the section is cut into two
 * 5,000-character slabs and a 45-character stub. Each slab is then parsed as
 * ONE reference, so a paper citing ninety works reports three.
 *
 * Coverage is the honest comparison because both strategies produce entries
 * over the same text. A real bibliography is almost entirely made of entries,
 * so a split that leaves most of the section outside any plausible entry has
 * not found the entries — whatever its internal chain looks like.
 *
 * Entries longer than this are not references. The longest genuine entry in
 * either corpus is ~1,200 characters (a fifteen-author paper with a long title
 * and a DOI); 2,000 leaves generous headroom while still catching a slab that
 * is really several references fused together.
 */
const MAX_PLAUSIBLE_ENTRY = 2000

function splitCoverage(entries: SplitEntry[], sectionLength: number): number {
  if (sectionLength <= 0) return 0
  let covered = 0
  for (const e of entries) {
    if (e.raw.length <= MAX_PLAUSIBLE_ENTRY) covered += e.raw.length
  }
  return covered / sectionLength
}

/** One cut of the reference list, with where it was cut FROM. */
interface SplitEntry {
  ordinal: number
  raw: string
  charStart: number
  charEnd: number
}

/**
 * How far the entry that produced `raw` actually reaches on the page.
 *
 * The slice between two markers is an UPPER bound and a bad one where the
 * references are footnotes: there the next marker sits a page away, so the slice
 * between them is mostly body text that this entry does not occupy. `raw` is the
 * same slice with furniture removed, runaway prose trimmed and whitespace runs
 * collapsed — every one of those makes it SHORTER than what was printed, never
 * longer — so its length is a lower bound on the entry's printed extent.
 *
 * The lower bound is the one to take. A consumer treats this as ground it must
 * not read as body text, and a span that stops early leaves a little of the
 * entry exposed, while a span that over-reaches swallows the author's own
 * sentences. Under-reaching costs precision; over-reaching costs the reader a
 * citation that was really there.
 */
function printedSpan(
  section: string,
  start: number,
  end: number,
  raw: string
): { charStart: number; charEnd: number } {
  const slice = section.slice(start, end)
  const lead = slice.length - slice.trimStart().length
  return { charStart: start, charEnd: start + Math.min(end - start, lead + raw.length) }
}

/**
 * Cut an entry back to where the CITATION ends.
 *
 * The section terminator handles a list that ends at a heading, but not a list
 * whose last entry is followed by prose with no heading of its own — a page
 * footer, a floating table caption, or a Methods section whose title did not
 * survive extraction. Those cases produced entries of 5,000 to 22,000
 * characters: a real reference followed by kilobytes of unrelated text, which
 * then gets matched against other papers and mis-links them.
 *
 * A journal citation ends at its year-and-pages tail. Everything after the LAST
 * such tail is not part of the reference, so it is dropped. When no tail is
 * found the entry is left alone rather than guessed at — an over-long entry is
 * bad, but truncating a legitimate one is worse.
 */
const CITATION_TAIL_RE =
  /(?:\((?:1[89]\d{2}|20\d{2})\)\s*\.?|\b(?:1[89]\d{2}|20\d{2})\s*[.;]|\d{1,4}\s*[–—-]\s*\d{1,4}\s*\.?|\b10\.\d{4,9}\/\S+)/g

/** Length past which an entry is certainly not a single citation. */
const RUNAWAY_CHARS = 1200

/**
 * Page furniture: what a publisher prints AROUND the text, not in it.
 *
 * A reference that straddles a page break has the running head, footer and
 * copyright line spliced into its middle by text extraction, so this text ends
 * up inside `raw_bib_text` and inside the extracted TITLE. Worse, the footer
 * carries the CITING article's own DOI, which the entry then claims as its own
 * — and a DOI short-circuits matching, so the citation is mis-linked.
 *
 * Every pattern here is anchored to publisher boilerplate rather than to
 * ordinary words, so a reference whose title happens to contain "Nature" or
 * "Article" is untouched.
 */
const FURNITURE_RES: RegExp[] = [
  // Copyright / rights lines.
  /\b(?:©|\(c\)\s?)\s?\d{4}\s?[^.\n]{0,60}?(?:Publishing Group|Wiley-VCH|American Chemical Society|Elsevier|Macmillan Publishers[^.\n]{0,40})/gi,
  /\bMacmillan Publishers Limited\.?\s*All rights reserved\.?\s*©?\s*\d{0,4}\s?\d?/gi,
  /\bNature Publishing Group\b\s*©?\s*\d{0,4}/gi,
  /\b\d{4}\s+Wiley-VCH\s+Verlag[^.\n]{0,60}/gi,
  // Journal running heads with volume/issue/date.
  /\bNATURE\s*\|\s*Vol\s*\d+[^\n]{0,40}/gi,
  /\bJ\.\s*AM\.\s*CHEM\.\s*SOC\.\s*\S?\s*VOL\.\s*\d+[^\n]{0,40}/gi,
  /\bAngew\.\s*Chem\.\s*Int\.\s*Ed\.\s*\d{4}\s*,\s*\d+\s*,\s*\d+\s*[–—-]\s*\d+/gi,
  /\bNature Communications\s*\|\s*\(?\d{4}\)?[^\n]{0,30}/gi,
  /\bProtein Science,?\s*vol\.?\s*\d+/gi,
  /\bBiochimica et Biophysica Acta\s*\d+\s*\(\d{4}\)\s*\d+\s*[–—-]\s*\d+/gi,
  // Section banners printed in the margin.
  /\bA\s+R\s+T\s+I\s+C\s+L\s+E\s+S?\b/g,
  /\bRESEARCH\s+LETTER\b/g,
  /\bBIOPHYSICS AND\s+COMPUTATIONAL BIOLOGY\b/gi,
  /\bThese are not the final page numbers!/gi,
  // Publisher web/DOI footers — the source of the stolen DOI.
  /\bwww\.pnas\.org\/cgi\/doi\/10\.\d{4,9}\/\S+/gi,
  /\bdx\.doi\.org\/10\.\d{4,9}\/\S+\s*\|[^\n]{0,60}/gi,
  /\bArticle\s+https?:\/\/doi\.org\/10\.\d{4,9}\/\S+/gi,
  /\bdoi:10\.\d{4,9}\/\S+\s*(?=Nature Publishing|$)/gi,
  /\bACS Paragon Plus Environment\b/gi,
  // The ACS line-number gutter: a run of ascending integers set in the margin,
  // which text extraction drops straight into whichever reference sits beside
  // it. Left in, "ACS Catalysis 1 2 3 4 5 ... 60" becomes a reference title.
  // Anchored on the RUN (six or more ascending single numbers), so a page range
  // or a volume number is untouched.
  /(?:\b\d{1,3}\b[ \t\n]+){6,}\d{1,3}\b/g,
  /\bPage\s+\d+\s+of\s+\d+\b/gi,
  /\bPublished on \d{1,2} \w+ \d{4}\.?(?:\s*Downloaded by [^.\n]{0,60}\.)?/gi,
  /\bDownloaded by [^.\n]{0,60}on \d{2}\/\d{2}\/\d{4}[^.\n]{0,20}\./gi,
  /\bView Article Online\b/gi,
  /\bwww\.proteinscience\.org\b/gi,
  /\bwww\.angewandte\.org\b/gi,
  // Journal-specific footers found by reading the corpus. Each is anchored on
  // publisher boilerplate, never on a word a title could contain.
  /\bNATURE COMMUNICATIONS\s*\|\s*(?:DOI:)?\s*[^\n]{0,80}/gi,
  /\bPROTEINSCIENCE\.ORG\b[^\n]{0,60}/gi,
  /\bPROTEIN SCIENCE VOL[^\n]{0,40}/gi,
  /\b[A-Z][A-Za-z]+ et al\.\s*(?:PROTEIN SCIENCE|PNAS|Nature)[^\n]{0,60}/gi,
  /\bPublished on Web \d{2}\/\d{2}\/\d{4}\b/gi,
  /\b10\.\d{4,9}\/\S+\s+CCC:\s*\$[\d.]+/gi,
  /\b©?\s*\d{4}\s+American Chemical Society\b[^\n]{0,60}/gi,
  /\bComputational Enzyme Design\s+A\s*ngewandte[^\n]{0,80}/gi,
  /\bAngewandte\s+Reviews\b[^\n]{0,60}/gi,
  // A figure/scheme caption that follows a footnote reference on a body page.
  /\b(?:Figure|Scheme|Table)\s+\d+\.\s+[A-Z][^\n]{0,120}/g
]

/**
 * Remove publisher furniture from an entry.
 *
 * Applied to the raw entry text before any field is read from it, so the
 * furniture cannot become a title, a venue, a year or a DOI.
 */
export function stripFurniture(raw: string, runningHead?: RegExp | null): string {
  let out = raw
  for (const re of FURNITURE_RES) {
    re.lastIndex = 0
    out = out.replace(re, ' ')
  }
  if (runningHead) {
    runningHead.lastIndex = 0
    out = out.replace(runningHead, ' ')
  }
  return out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+\n/g, '\n')
    .trim()
}

/**
 * Build a matcher for THIS document's running head.
 *
 * Journals print a short form of the article's own title at the top of every
 * page ("1041 Designed KE07 and Its Evolved Variants", "411 In-Silico-Designed
 * Kemp Eliminase KE70"). It cannot be listed as a generic pattern because it is
 * different in every paper — but it is highly repetitive WITHIN a paper, which
 * is exactly what identifies it: a line of the same few words recurring on most
 * pages, usually with a page number attached.
 *
 * Returns null when no such line repeats often enough, so a document without a
 * running head is left untouched.
 */
export function detectRunningHead(text: string): RegExp | null {
  const counts = new Map<string, number>()
  for (const rawLine of text.split('\n')) {
    // Drop a leading/trailing page number: it changes per page, the words do not.
    const line = rawLine.replace(/^\s*\d{1,5}\s+/, '').replace(/\s+\d{1,5}\s*$/, '').trim()
    if (line.length < 12 || line.length > 90) continue
    if (!/[A-Za-z]/.test(line)) continue
    // A citation contains a year or a page range; a running head does not.
    if (/\b(1[89]\d{2}|20\d{2})\b/.test(line)) continue
    counts.set(line, (counts.get(line) ?? 0) + 1)
  }
  let best: string | null = null
  let bestN = 0
  for (const [line, n] of counts) {
    if (n > bestN) {
      bestN = n
      best = line
    }
  }
  // Must recur across pages to be a head rather than a coincidence.
  if (!best || bestN < 3) return null
  const escaped = best.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  // Match with or without the page number that rides alongside it.
  return new RegExp(`\\s*\\d{0,5}\\s*${escaped}\\s*\\d{0,5}`, 'gi')
}

function trimRunaway(raw: string): string {
  if (raw.length <= RUNAWAY_CHARS) return raw
  CITATION_TAIL_RE.lastIndex = 0
  let lastEnd = -1
  let m: RegExpExecArray | null
  while ((m = CITATION_TAIL_RE.exec(raw))) {
    // Only tails within the plausible span of one citation — a year appearing
    // 8,000 characters in belongs to the body text, not to this reference.
    if (m.index > RUNAWAY_CHARS) break
    lastEnd = m.index + m[0].length
  }
  return lastEnd > 40 ? raw.slice(0, lastEnd).trim() : raw
}

/**
 * The shapes an UNNUMBERED entry can open with.
 *
 * There is no marker to split on in these bibliographies — the only signal that
 * a new reference has begun is that a line starts with something that looks
 * like the head of an author list. Which is why this is a SET: the corpus holds
 * at least four house styles for that, and a parser carrying only one of them
 * reports zero references for the other three while claiming the document has
 * no bibliography.
 *
 *   surname-first   `Altschul, S.F., Madden, T.L., ... 1997. Gapped BLAST`
 *   given-first     `Jeffrey Pennington, Richard Socher, and Christopher`
 *   initials-first  `S. Amari. Information Geometry and Its Applications`
 *   bracket-label   `[Chickering, 2002] Chickering, D. M. (2002). Learning`
 *
 * Measured: surname-first alone left six papers at zero references and three
 * more at one-to-three entries out of forty-plus (works 27, 28, 44 and 34, 35,
 * 53 in the embeddings corpus). Every one of them located its section
 * correctly and then found nothing inside it.
 *
 * Each alternative is deliberately anchored and narrow, because breadth here is
 * paid for by the guard below rather than by the pattern: a shape that matches
 * a continuation line costs a reference split in half. The four are disjoint in
 * practice — a bibliography is set in one style throughout — so admitting all
 * of them cannot make a document match more than one of them per line.
 */
const NAME = "[A-Z][A-Za-z'\u00c0-\u024f-]{1,}"

const ENTRY_OPENERS: RegExp[] = [
  // `Altschul, S.F.,` / `Abernethy, J., Hazan, E.` — surname then initials.
  new RegExp(`^(${NAME},\\s*[A-Z]\\.)`),
  // `[Chickering, 2002] Chickering, D. M. (2002).` — a bracketed author-year
  // label. Anchored on the bracket so it cannot match prose.
  new RegExp(`^(\\[\\s*${NAME}[^\\]]{0,60}\\d{4}[a-z]?\\s*\\])`),
  // `S. Amari.` / `G. Arvanitidis, L. K. Hansen,` — initials then surname.
  new RegExp(`^((?:[A-Z]\\.\\s*){1,3}${NAME}[,.])`),
  // `Jeffrey Pennington, Richard Socher, and Christopher` — given name first,
  // no initials at all. TWO capitalised words then a comma or a period is the
  // narrowest thing that catches it; requiring the comma keeps it off ordinary
  // capitalised sentence starts, which do not comma after two words.
  new RegExp(`^(${NAME}\\s+(?:[A-Z]\\.\\s+)?${NAME}\\s*[,.])`)
]

function opensAnEntry(line: string): boolean {
  return ENTRY_OPENERS.some((re) => re.test(line))
}

function splitAuthorYearEntries(section: string, runningHead?: RegExp | null): SplitEntry[] {
  const starts = computeLineStarts(section)
  const cuts: number[] = []
  for (const s of starts) {
    const nl = section.indexOf('\n', s)
    const line = section.slice(s, nl < 0 ? section.length : nl)
    if (!opensAnEntry(foldText(line))) continue
    // A long author list WRAPS, and its continuation also begins with a
    // surname — so "line starts with a surname" alone split single references
    // in half, leaving stubs like "Berman, H.M., Battistuz, T., Bourne, P.E.,"
    // with no title and no year, while the real citation lost its first
    // authors. A new entry can only begin where the previous one FINISHED:
    // after a year, a page range, or a closing period. A line that continues
    // an author list is preceded by a dangling comma or "and".
    if (cuts.length > 0) {
      const prev = section.slice(cuts[cuts.length - 1], s)
      const tail = foldText(prev).trimEnd()
      if (!tail) continue
      const ended =
        /[.)]$/.test(tail) &&
        (/\b(1[89]\d{2}|20\d{2})[a-z]?\b/.test(tail) || /\d{1,4}\s*[–—-]\s*\d{1,4}/.test(tail))
      if (!ended) continue
    }
    cuts.push(s)
  }
  const entries: SplitEntry[] = []
  for (let i = 0; i < cuts.length; i++) {
    const end = i + 1 < cuts.length ? cuts[i + 1] : section.length
    const raw = trimRunaway(stripFurniture(section.slice(cuts[i], end).trim(), runningHead))
    if (raw) {
      entries.push({ ordinal: i + 1, raw, ...printedSpan(section, cuts[i], end, raw) })
    }
  }
  return entries
}

// ------------------------------------------------------------ 3. parse fields

/**
 * A plausible publication year. Bounded below by the birth of the modern
 * journal article and above by "next year" relative to nothing — we use a
 * fixed upper bound rather than `new Date()` so the parser stays a pure
 * function (a clock read would make output non-reproducible).
 */
const YEAR_MIN = 1800
const YEAR_MAX = 2100

function pickYear(s: string): number | null {
  // Prefer a parenthesised year — that is the citation's own year, whereas a
  // bare 4-digit number is very often a page or volume.
  const paren = /\((\d{4})[a-z]?\)/g
  const cands: number[] = []
  let m: RegExpExecArray | null
  while ((m = paren.exec(s))) {
    const y = Number(m[1])
    if (y >= YEAR_MIN && y <= YEAR_MAX) cands.push(y)
  }
  if (cands.length) return cands[0]

  const bare = /\b(1[89]\d{2}|20\d{2})\b/g
  const all: number[] = []
  while ((m = bare.exec(s))) all.push(Number(m[1]))
  if (!all.length) return null
  // With no parentheses to disambiguate, the LAST plausible year wins: styles
  // that omit parens (Nature, ACS) put the year at the very end of the entry.
  return all[all.length - 1]
}

/** Strip the leading "12.", "[12]" or "(12)" marker from an entry. */
function stripMarker(entry: string): string {
  return entry
    .replace(/^\s*(?:\[\s*\d{1,3}\s*\]|\(\s*\d{1,3}\s*\)|\d{1,3}\.)\s*/, '')
    .replace(/^\s*\d{1,3}\s+/, '')
}

/**
 * Split an entry into author-blob / rest.
 *
 * Author lists end at the first year, or (for styles with no year up front) at
 * the first sentence-terminating period that follows an initial. Both shapes
 * occur in this corpus, so we try year-first and fall back.
 */
function splitAuthorsAndRest(body: string): { authors: string | null; rest: string } {
  const yearParen = body.match(/^(.*?)\(\s*(\d{4})[a-z]?\s*\)\s*[.,:]?\s*/)
  if (yearParen && yearParen[1].trim().length > 3) {
    return { authors: yearParen[1].replace(/[,;.\s]+$/, '').trim(), rest: body.slice(yearParen[0].length) }
  }
  // "Fersht AR (2002)" handled above; here: "Wolfenden, R. & Snider, M. J. The
  // depth of ..." — authors end at the period after the last initial.
  const initialEnd = body.match(/^((?:[^.]|\.(?=\s*[A-Z]\.)|[A-Z]\.)*?[A-Z]\.)\s+(?=[A-Z(])/)
  if (initialEnd && initialEnd[1].length < body.length * 0.8) {
    let authors = initialEnd[1]
    let rest = body.slice(initialEnd[0].length)
    // A LAST author joined by "and"/"&" sits past that period, so the split
    // landed mid-author-list and the remaining name became the title:
    // "Bolon, D.N. and Mayo, S.L. 2001. Enzyme-like proteins..." yielded the
    // title "and Mayo, S.L. 2001. Enzyme-like proteins...". Consume any
    // conjunction-joined names that follow, repeatedly — three-author lists
    // chain them.
    for (;;) {
      const more = rest.match(/^(?:and|&)\s+([A-Z][A-Za-z'\u00c0-\u024f-]+,?(?:\s*[A-Z]\.){1,3},?)\s*/)
      if (!more) break
      authors += ` ${more[0].trim()}`
      rest = rest.slice(more[0].length)
    }
    // Author-year styles print the year AFTER the names; leaving it in front of
    // the title made the year part of the title text.
    const lead = rest.match(/^\(?(\d{4})[a-z]?\)?\s*[.,]\s*/)
    if (lead) rest = rest.slice(lead[0].length)
    return { authors: authors.replace(/[,;\s]+$/, '').trim(), rest }
  }
  // Numeric/ACS style ("Tantillo, D. J.; Jiangang, C.; Houk, K. N., Curr. Opin.")
  const semi = body.match(/^((?:[^;]+;){1,}[^,;]+),\s+/)
  if (semi) {
    return { authors: semi[1].trim(), rest: body.slice(semi[0].length) }
  }
  return { authors: null, rest: body }
}

/**
 * Journal-name-ish tail: a run of abbreviated words with periods, followed by
 * volume and pages. Used both to end the title and to report a venue.
 */
const VENUE_RE =
  /((?:[A-Z][A-Za-z&]*\.?\s+){0,6}?(?:J|Proc|Nat|Nature|Science|Angew|Chem|Biochem|Biol|Acta|PLOS|PLoS|Annu|Curr|Methods|Protein|Genetics|Mol|Phys|ACS|Adv|Rev|Trends|Cell|EMBO|FEBS|Bioinformatics|Nucleic)[A-Za-z.\s&]*?)\s*,?\s*(?:\d{1,4}\s*(?:\(\d{4}\))?\s*[,:]|\d{1,4}\s*,)/

/**
 * Does this string look like a TITLE rather than leftover author names?
 *
 * The author/title split is the parser's most error-prone step: styles that
 * print "Surname, A. B.; Surname, C. D., Journal 2008, 453, 190" have NO title
 * at all, and a naive splitter happily returns "J.; Jiangang, C.; Houk, K. N.,
 * Curr" as the title. Feeding that to the matcher is worse than returning null,
 * because it scores a spurious partial similarity against every corpus work.
 *
 * A real title is prose: mostly lowercase words, few initials, few semicolons.
 * We reject a candidate when initials or name-separators dominate.
 */
function looksLikeTitle(s: string): boolean {
  const t = s.trim()
  if (t.length < 12) return false
  const words = t.split(/\s+/)
  if (words.length < 3) return false
  // Initials like "J.;" "K. N.," — a title has almost none.
  const initials = (t.match(/\b[A-Z]\.\s*/g) ?? []).length
  if (initials >= Math.max(2, words.length * 0.25)) return false
  // Semicolons separate authors in ACS style; prose titles rarely have several.
  if ((t.match(/;/g) ?? []).length >= 2) return false
  // A title is mostly lowercase words. Author debris is mostly capitalised.
  const lower = words.filter((w) => /^[a-z]/.test(w)).length
  if (lower / words.length < 0.3) return false
  return true
}

function splitTitleAndVenue(rest: string): { title: string | null; venue: string | null } {
  const trimmed = rest.trim()
  if (!trimmed) return { title: null, venue: null }

  // ANCHOR ON THE VENUE FIRST, working BACKWARDS from the journal name.
  //
  // Splitting forwards at the first sentence period breaks whenever a title
  // ends in a proper noun: "Macromolecular modeling with Rosetta. Annu. Rev.
  // Biochem." yielded the title "Macromolecular modeling with" and the venue
  // "Rosetta. Annu. Rev. Biochem.". The journal name is the reliable landmark —
  // everything before it is the title — so it is located first and the title is
  // whatever precedes it.
  const venueAnchor = VENUE_RE.exec(trimmed)
  if (venueAnchor && venueAnchor.index > 0) {
    let venue = venueAnchor[1].trim().replace(/[,.\s]+$/, '')
    let cut = venueAnchor.index
    // VENUE_RE may absorb a capitalised word that belongs to the TITLE, since it
    // allows several leading capitalised tokens before the journal abbreviation:
    // "Macromolecular modeling with Rosetta. Annu. Rev. Biochem." captured
    // "Rosetta. Annu. Rev. Biochem." and left the title as "Macromolecular
    // modeling with". A journal name starts at its first ABBREVIATED token (a
    // capitalised word ending in a period) or at a known one-word title, so
    // anything before that belongs to the title and is given back.
    // Anchored on the journal WORDS this literature actually uses, not on
    // "capital followed by a period" — a title's own proper noun ("Rosetta.")
    // has exactly that shape and would be swallowed again.
    const abbrev =
      /\b(?:J|Proc|Nat|Nature|Science|Angew|Chem|Biochem|Biol|Acta|PLOS|PLoS|Annu|Curr|Methods|Protein|Genetics|Biochemistry|Mol|Phys|ACS|Adv|Rev|Trends|Cell|EMBO|FEBS|Bioinformatics|Nucleic|Synthesis|Tetrahedron)\b/.exec(venue)
    if (abbrev && abbrev.index > 0) {
      cut += abbrev.index
      venue = venue.slice(abbrev.index).trim()
    }
    const before = trimmed.slice(0, cut).replace(/[\s,.;]+$/, '')
    if (looksLikeTitle(before) && venue.length >= 3) {
      return { title: before, venue }
    }
  }

  // Most styles terminate the title with a period before the journal name.
  // Take the first period that is NOT part of an abbreviation/initial, and
  // that leaves a title of a plausible length.
  const periods: number[] = []
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] !== '.') continue
    const prev = trimmed[i - 1] ?? ''
    const next = trimmed[i + 1] ?? ''
    // "R." initial, "e.g.", "5'-" etc. — a single capital before the dot means
    // an initial, not a sentence end.
    if (/[A-Z]/.test(prev) && !/[a-z]/.test(trimmed[i - 2] ?? '')) continue
    if (next && !/\s/.test(next)) continue
    periods.push(i)
  }
  for (const p of periods) {
    const candidate = trimmed.slice(0, p).trim()
    if (looksLikeTitle(candidate)) {
      const venue = extractVenue(trimmed.slice(p + 1))
      return { title: candidate, venue }
    }
  }

  // No usable period: ACS/Angewandte number-only styles print no title at all
  // ("Tantillo, D. J.; ... Curr. Opin. Chem. Bio. 1998, 2, 743-750."). Report
  // the venue and leave the title null rather than inventing one.
  const vm = VENUE_RE.exec(trimmed)
  if (vm) return { title: null, venue: vm[1].trim().replace(/[,.\s]+$/, '') }
  const whole = trimmed.replace(/[.,\s]+$/, '')
  return { title: looksLikeTitle(whole) ? whole : null, venue: null }
}

function extractVenue(tail: string): string | null {
  const t = tail.trim()
  if (!t) return null
  const vm = VENUE_RE.exec(t)
  if (vm) return vm[1].trim().replace(/[,.\s]+$/, '')
  // Fall back to the words before the first number (volume).
  const upToNumber = t.match(/^([^0-9]{3,80})/)
  return upToNumber ? upToNumber[1].trim().replace(/[,.\s]+$/, '') || null : null
}

/**
 * ACS and Angewandte pack SEVERAL distinct papers into one numbered entry,
 * lettering them "(a) ... (b) ... (c) ...". Each part is a full citation with
 * its own authors, journal, year and pages.
 *
 * Treating the entry as one reference is actively wrong: the parts are then
 * concatenated, so `pickYear` returns the LAST part's year while the surnames
 * come from the first, and the composite matches neither paper. Splitting on the
 * letter markers lets each part be scored on its own.
 *
 * Only "(a)" at the very start qualifies an entry for splitting — that is the
 * marker of a genuinely multi-part entry, whereas a lone "(b)" mid-text is
 * ordinary prose or a compound name.
 */
const SUBENTRY_LEAD_RE = /^\s*\(a\)\s+/i
const SUBENTRY_SPLIT_RE = /\s\((?=[b-h]\)\s)/gi

/** One lettered part: the letter as printed, and the citation under it. */
export interface SubEntry {
  /** `'a'`, `'b'`, … exactly as the entry printed it, lowercased. */
  label: string
  text: string
}

/**
 * Split a lettered composite into its parts, KEEPING each part's letter.
 *
 * The letter is read off the text here rather than inferred from position
 * later, because the length filter below drops a part that is too short to be
 * a citation — so the surviving parts are not necessarily `a, b, c…` in
 * sequence, and numbering them after the fact would attach the wrong letter to
 * every part after a gap.
 *
 * Returns an empty array when this is not a composite, so the caller's
 * "is it one?" test is `length > 0` rather than a comparison against the input.
 */
export function splitSubEntries(body: string): SubEntry[] {
  if (!SUBENTRY_LEAD_RE.test(body)) return []
  // The lead `(a)` is consumed by the replace, so the first fragment carries no
  // letter of its own and is known to be 'a'; each later fragment still starts
  // with the letter that opened it, because the split looks ahead rather than
  // consuming it.
  const fragments = body.replace(SUBENTRY_LEAD_RE, '').split(SUBENTRY_SPLIT_RE)
  const parts: SubEntry[] = []
  fragments.forEach((fragment, i) => {
    const letter = i === 0 ? 'a' : /^([b-h])\)/i.exec(fragment)?.[1]?.toLowerCase()
    const text = fragment.replace(/^[b-h]\)\s*/i, '').trim()
    // Same minimum as before: a fragment this short is punctuation or a stray
    // parenthesis, not a citation. A fragment whose letter did not parse is
    // dropped for the same reason it would have been mislabelled.
    if (letter && text.length >= 20) parts.push({ label: letter, text })
  })
  return parts.length > 1 ? parts : []
}

/**
 * Parse one entry into identifying fields.
 *
 * `profile` is the citation style detected for the WHOLE document. It is
 * optional so a single entry can still be parsed in isolation (tests, and the
 * re-hydration path in `store.ts`), in which case the extractor falls back to
 * per-entry shape detection.
 *
 * The style-aware extractor is authoritative. The older heuristics survive as a
 * FALLBACK for fields it declines to report: a book chapter or a thesis has no
 * volume/pages coordinate to anchor on, and for those the loose scan still finds
 * a year or a title.
 */
export function parseEntry(
  rawEntry: string,
  ordinal: number,
  profile: StyleProfile = GENERIC_STYLE,
  /**
   * Where this entry is printed. Omitted when the caller has no document to
   * locate it in — a test, or `store.ts` re-hydrating an entry from its stored
   * text — and then the span is the "no region" sentinel rather than offset
   * zero, which would fence off the top of the paper.
   */
  span?: { charStart: number; charEnd: number },
  /**
   * The lettered part this entry is, when it came out of a composite. Omitted
   * — and therefore null — for an ordinary entry and for the composite itself.
   */
  partLabel?: string
): ParsedReference {
  const raw_bib_text = rawEntry.trim()
  const flat = unwrapLines(foldText(raw_bib_text))
  const body = stripMarker(flat)

  // Search the UNWRAPPED text: a DOI that wrapped mid-token
  // ("https://doi.org/10.1101/2024.08.02.\n606416") was otherwise truncated at
  // the break, yielding a DOI that resolves to nothing — or worse, to a
  // different record. `flat` has the wrap already closed up.
  const dois = findDois(flat)
  const f = extractFields(body, profile)

  let { authors, title, venue } = f
  if (!authors) {
    const loose = splitAuthorsAndRest(body)
    authors = loose.authors
    if (!title && !venue) {
      const tv = splitTitleAndVenue(loose.rest)
      title = tv.title
      venue = tv.venue
    }
  }

  return {
    ordinal,
    raw_bib_text,
    char_start: span?.charStart ?? -1,
    char_end: span?.charEnd ?? -1,
    part_label: partLabel ?? null,
    authors,
    surnames: authors ? extractSurnames(authors) : [],
    year: f.year ?? pickYear(body),
    // Software titles are legitimately short ("XDS", "AMBER 10"); the
    // eight-character floor exists to reject author debris, which is never
    // all-caps and never this short.
    title: title && (title.length >= 8 || /^[A-Z0-9][A-Z0-9 .-]{1,9}$/.test(title)) ? title : null,
    venue,
    volume: f.volume,
    pages: f.pages,
    doi: dois.length ? dois[0] : null
  }
}

// -------------------------------------------------------------- orchestration

/**
 * Bibliographic entries are long. A "reference" shorter than this is almost
 * always a splitting artifact (an orphan page number, a stray table row), and
 * emitting it would inflate the reference count and pollute the unresolved
 * list shown in the UI.
 */
const MIN_ENTRY_CHARS = 30

/**
 * Shortest an entry may be when it holds a POSITION in the numbering.
 *
 * Older papers mix citations and explanatory notes in one numbered list:
 * "(21) Reference 16, p 678." and "(31) Compare, for example, imidazole, pK =
 * 7.0 ..." are short, and the first fell under the general minimum — so a 1973
 * paper reported 32 references where 35 are printed, with gaps at 21 and 31.
 * A numbered slot is evidence in itself: the author put something there, and
 * dropping it silently misrepresents the bibliography. Below this a fragment
 * really is a splitting artifact.
 */
const MIN_NUMBERED_ENTRY_CHARS = 12

export function parseReferences(text: string): ParseResult {
  const noTextLayer = foldText(text).replace(/[\s\f]/g, '').length < 500
  if (noTextLayer) {
    return {
      references: [],
      diagnostics: {
        section_strategy: 'none',
        entry_style: 'none',
        citation_style: 'generic',
        style_confidence: 0,
        section_char_start: -1,
        section_char_end: -1,
        no_text_layer: true
      }
    }
  }

  const { start, end, strategy } = locateReferenceSection(text)
  if (start < 0) {
    return {
      references: [],
      diagnostics: {
        section_strategy: 'none',
        entry_style: 'none',
        citation_style: 'generic',
        style_confidence: 0,
        section_char_start: -1,
        section_char_end: -1,
        no_text_layer: false
      }
    }
  }

  const runningHead = detectRunningHead(text)
  let section = text.slice(start, end)
  let { entries, style } = splitEntries(section, runningHead)
  // Into the DOCUMENT's offset space, which is the only one a consumer of this
  // result has. `splitEntries` measures against the string it was handed, and
  // that string is a slice — so an entry at section offset 0 is at document
  // offset `start`, and publishing the section-relative number would place
  // every footnote at the top of the paper.
  let entryBase = start

  // FOOTNOTE-STYLE PAPERS have no contiguous reference section at all: JACS and
  // older chemistry journals print references at the foot of each page, so the
  // list is scattered through the document — ref 1 at 7% and ref 17 at 24% in
  // one paper here. A section span necessarily truncates that (50 references
  // became 17), so when the span holds only a fraction of the numbering the
  // whole document is used instead. The span is still preferred: it is what
  // keeps body text out of the entries for every normally-formatted paper.
  const wholeChain = ascendingChain(collectMarkers(text))
  if (wholeChain.length >= entries.length * 1.5 && wholeChain.length >= MIN_RUN) {
    const wide = splitEntries(text, runningHead)
    if (wide.entries.length > entries.length) {
      section = text
      entries = wide.entries
      style = wide.style
      entryBase = 0
    }
  }

  // CONTINUATION BLOCKS. Nature-family papers print the main reference list,
  // then keep NUMBERING into a "Methods References" block at the very end of
  // the document — refs 30-34 of one paper here sit at 98-100% while the
  // located section ends at 66%. Those references are real and cited, so
  // stopping at the section boundary silently loses them.
  //
  // The block is found by its NUMBERING: entries continuing the sequence the
  // section ended on. Requiring continuity is what keeps this from collecting
  // an unrelated numbered list (a figure legend, a table) that happens to sit
  // after the bibliography.
  const continued = findContinuationEntries(text, end, entries, runningHead)
  entries = entries
    .map((e) => ({ ...e, charStart: e.charStart + entryBase, charEnd: e.charEnd + entryBase }))
    .concat(continued)

  // TWO PASSES. The first prepares every entry body and votes on the document's
  // citation style; the second extracts fields with that style in hand. A
  // one-pass parser cannot do this — the evidence for "this bibliography prints
  // no titles and puts the year before the volume" is spread across all of its
  // entries, and reading it per-entry is exactly how a title-shaped fragment of
  // an author list gets reported as a title.
  const kept: Array<SplitEntry & { body: string }> = []
  for (const e of entries) {
    const len = e.raw.replace(/\s+/g, ' ').trim().length
    const floor = style === 'author-year' ? MIN_ENTRY_CHARS : MIN_NUMBERED_ENTRY_CHARS
    if (len < floor) continue
    kept.push({ ...e, body: stripMarker(unwrapLines(foldText(e.raw))) })
  }
  const profile = detectStyle(kept.map((k) => k.body))

  const references: ParsedReference[] = []
  for (const e of kept) {
    references.push(parseEntry(e.raw, e.ordinal, profile, e))
    // A lettered multi-part entry additionally yields one reference per part, so
    // each cited paper can be resolved independently. The composite is KEPT: its
    // raw_bib_text is what the bibliography actually printed, which the ontology
    // requires us to preserve.
    //
    // The PART carries no span of its own: it is a substring of a body that has
    // already been unwrapped and folded, so its offsets into the document cannot
    // be recovered without re-deriving a mapping the fold destroyed. The
    // composite's span already covers the same printed ground, so nothing is
    // lost by the part saying "no region" rather than guessing one.
    for (const part of splitSubEntries(e.body)) {
      references.push(parseEntry(part.text, e.ordinal, profile, undefined, part.label))
    }
  }

  dropHostDoi(references)

  return {
    references,
    diagnostics: {
      section_strategy: strategy,
      entry_style: style,
      citation_style: profile.style,
      style_confidence: Number(profile.confidence.toFixed(3)),
      section_char_start: start,
      section_char_end: end,
      no_text_layer: false
    }
  }
}

/**
 * References that continue the list's numbering AFTER the section ended.
 *
 * Only entries that pick up where the section stopped are taken, and only while
 * they keep ascending — so a "Methods References" block reading 30, 31, 32 is
 * collected, while a numbered figure legend starting again at 1 is not.
 */
function findContinuationEntries(
  text: string,
  sectionEnd: number,
  existing: SplitEntry[],
  runningHead?: RegExp | null
): SplitEntry[] {
  if (existing.length === 0 || sectionEnd >= text.length) return []
  const highest = Math.max(...existing.map((e) => e.ordinal))
  const seen = new Set(existing.map((e) => e.ordinal))

  const rest = text.slice(sectionEnd)
  const markers = collectMarkers(rest).sort((a, b) => a.offset - b.offset)

  const chain: Marker[] = []
  let want = highest + 1
  for (const m of markers) {
    if (m.num !== want) continue
    chain.push(m)
    want++
  }
  if (chain.length === 0) return []

  const out: SplitEntry[] = []
  for (let i = 0; i < chain.length; i++) {
    const from = chain[i].offset
    const to = i + 1 < chain.length ? chain[i + 1].offset : Math.min(rest.length, from + 1200)
    const raw = trimRunaway(stripFurniture(rest.slice(from, to).trim(), runningHead))
    // The block must READ like citations; a numbered procedure would not.
    if (!/\b(1[89]\d{2}|20\d{2})\b/.test(raw)) continue
    if (seen.has(chain[i].num)) continue
    const span = printedSpan(rest, from, to, raw)
    out.push({
      ordinal: chain[i].num,
      raw,
      // `rest` starts at `sectionEnd`, so its offsets are the document's minus
      // that. Rebased here rather than by the caller, because this is the only
      // place that knows the slice was taken.
      charStart: span.charStart + sectionEnd,
      charEnd: span.charEnd + sectionEnd
    })
  }
  return out
}

/**
 * Remove a DOI that belongs to the CITING paper, not to the reference.
 *
 * Publishers stamp the article's own DOI into the page furniture — footers like
 * "10.1021/ja804040s CCC: $40.75" or "Article https://doi.org/10.1038/s41467-…"
 * — which lands inside whichever reference happens to sit at the foot of that
 * page. The reference then carries a DOI resolving to a completely different
 * paper, and a DOI is the matcher's strongest signal: it short-circuits scoring
 * entirely, so one stray footer silently mis-links a citation.
 *
 * A genuine reference DOI is unique to its entry. The same DOI appearing on
 * more than one reference can only be furniture, so every copy is dropped —
 * dropping is safe, since the entry is still matched on title, authors and year.
 */
function dropHostDoi(references: ParsedReference[]): void {
  const counts = new Map<string, number>()
  for (const r of references) {
    if (r.doi) counts.set(r.doi, (counts.get(r.doi) ?? 0) + 1)
  }
  for (const r of references) {
    if (r.doi && (counts.get(r.doi) ?? 0) > 1) r.doi = null
  }
}

// ------------------------------------------------------------ corpus matching

export interface CorpusWork {
  work_id: number
  title: string
  year: number | null
  doi: string | null
  /** Lowercased surnames of the work's authors, first author FIRST. */
  author_surnames: string[]
  /** Journal/venue name as recorded for the work; may be abbreviated. */
  venue?: string | null
}

export type MatchMethod = 'doi' | 'scored'

export interface ReferenceMatch {
  reference: ParsedReference
  work_id: number | null
  confidence: number
  method: MatchMethod | null
  /** Human-readable score breakdown, stored for provenance/debugging. */
  explanation: string
}

/**
 * MATCH THRESHOLD.
 *
 * A reference resolves to a corpus work only at score >= 0.62.
 *
 * Why 0.62. The score is a weighted sum of three independent signals (title
 * 0.60, surnames 0.25, year 0.15), each in [0,1]. 0.62 is the lowest score
 * reachable WITHOUT strong title agreement: e.g. perfect surnames + perfect
 * year contribute only 0.40, so a match must additionally carry ~0.37/0.60 =
 * 0.62 title similarity. Conversely a strong title alone (0.85 similarity =
 * 0.51) still needs corroboration from the year or an author. In other words
 * the threshold enforces "two independent signals agree", which is exactly the
 * property that keeps precision high on a 20-work corpus where several papers
 * share authors, year and topic. Measured on this corpus it yields no false
 * positives while admitting the noisy-title entries that pdfjs mangles.
 */
export const MATCH_THRESHOLD = 0.62

const W_TITLE = 0.6
const W_AUTHORS = 0.25
const W_YEAR = 0.15

/**
 * Weight of the venue signal, which REPLACES the title weight when the citation
 * style prints no title. See `scoreMatch`.
 */
const W_VENUE_TITLELESS = 0.3

/**
 * Token-level Dice coefficient over content words. Chosen over edit distance
 * because PDF text layers reorder and drop characters (ligatures, hyphenation,
 * column bleed) far more often than they reorder words, and because it is
 * O(n) and symmetric.
 */
export function titleSimilarity(a: string, b: string): number {
  const ta = new Set(contentTokens(a))
  const tb = new Set(contentTokens(b))
  if (!ta.size || !tb.size) return 0
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter++
  return (2 * inter) / (ta.size + tb.size)
}

/**
 * How much of `needle` appears in `haystack` (asymmetric containment).
 *
 * Used when the reference has no isolated title and we must score the corpus
 * work's title against the WHOLE raw entry. Dice is wrong there: the raw entry
 * is many times longer than the title, so even a perfect containment scores
 * low and the true match is lost. Containment asks the right question — "are
 * this work's title words present in the entry?" — and is what recovers the
 * ACS/Angewandte/Nature number-only bibliographies (papers 5, 8, 18).
 */
export function containment(needle: string, haystack: string): number {
  const tn = new Set(contentTokens(needle))
  if (!tn.size) return 0
  const th = new Set(contentTokens(haystack))
  let inter = 0
  for (const t of tn) if (th.has(t)) inter++
  return inter / tn.size
}

function surnameScore(ref: ParsedReference, work: CorpusWork): number {
  if (!work.author_surnames.length) return 0
  // Fold the WORK's surnames here rather than trusting the caller: the corpus
  // stores names as published ("Röthlisberger") while a PDF text layer may emit
  // "Rothlisberger" or "Ro ¨ thlisberger". Comparing unfolded strings silently
  // zeroes the author signal for exactly the most-cited authors in the corpus.
  const workSurnames = work.author_surnames.map((s) => normalizeLoose(s)).filter(Boolean)
  if (!workSurnames.length) return 0
  // The reference's own surname list is over-collected on purpose (see
  // extractSurnames), so we ask "does the work's FIRST author appear?" — the
  // single most stable signal — and top it up with overall overlap.
  // "Rothlisberger D, et al." names ONE author; the work has fourteen. Scoring
  // overlap against the full author list would cap such a reference at ~0.07
  // even though it is a perfect citation, so when the entry is elided we judge
  // it on the first author alone (see `elided` below).
  const elided = /\bet\s+al\b/i.test(foldText(ref.raw_bib_text))
  const refList = (ref.surnames.length ? ref.surnames : extractSurnames(ref.raw_bib_text)).map((s) =>
    normalizeLoose(s)
  )
  const has = (name: string): boolean => refList.some((r) => surnamesEqual(r, name))
  const first = workSurnames[0]
  const firstHit = first && has(first) ? 1 : 0
  let overlap = 0
  for (const s of workSurnames) if (has(s)) overlap++
  const overlapFrac = overlap / workSurnames.length
  if (elided) return firstHit ? 1 : Math.min(1, overlapFrac * 2)
  return Math.min(1, 0.7 * firstHit + 0.3 * Math.min(1, overlapFrac * 2))
}

/** Does the work's lead author appear among the reference's surnames? */
function firstAuthorPresent(ref: ParsedReference, work: CorpusWork): boolean {
  const first = normalizeLoose(work.author_surnames[0] ?? '')
  if (!first) return false
  const pool = ref.surnames.length ? ref.surnames : extractSurnames(ref.raw_bib_text)
  return pool.some((s) => surnamesEqual(normalizeLoose(s), first))
}

function yearScore(ref: ParsedReference, work: CorpusWork): number {
  if (ref.year == null || work.year == null) return 0
  const d = Math.abs(ref.year - work.year)
  // Exact is the norm; ±1 happens with online-first vs issue year, so it is
  // worth partial credit rather than zero.
  if (d === 0) return 1
  if (d === 1) return 0.5
  return 0
}

/**
 * Score a single (reference, work) pair. Exported so the unit tests can pin the
 * scoring surface independently of the search loop.
 */
/**
 * The part designator of a multi-part paper series.
 *
 * Chemistry journals publish "Physical organic chemistry of benzisoxazoles. I.
 * Mechanism of ..." and "... benzisoxazoles. II. Linearity of ..." — different
 * papers, sometimes different journals and always different content, whose
 * titles nonetheless share almost every content token. Token-set similarity
 * cannot tell them apart (it scores ~0.75), and the authors and year agree too,
 * so part II reliably resolves onto part I. The part number is the ONLY thing
 * that separates them, so it is extracted and compared explicitly.
 *
 * The designator must stand alone as its own word and be followed by a period or
 * colon — "benzisoxazoles. I. Mechanism", "benzisoxazoles II. Linearity". The
 * preceding period is optional because journals set the same series both ways,
 * but the TRAILING one is required, which is what keeps oxidation states
 * ("Cu(II) complexes") and ordinary capital-I words out.
 */
const SERIES_PART_RE = /(?:^|[\s.:;])(?:part\s+)?((?:IX|IV|V?I{1,3})|\d{1,2})\s*[.:](?:\s|$)/

export function seriesPart(title: string): string | null {
  const m = SERIES_PART_RE.exec(foldText(title))
  if (!m) return null
  const raw = m[1].toUpperCase()
  const roman: Record<string, string> = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6', VII: '7', VIII: '8', IX: '9' }
  return roman[raw] ?? raw
}

export function scoreMatch(
  ref: ParsedReference,
  work: CorpusWork
): { score: number; explanation: string } {
  // SERIES VETO, before any scoring: a different part of the same series is a
  // different paper no matter how well everything else agrees.
  if (ref.title) {
    const rp = seriesPart(ref.title)
    const wp = seriesPart(work.title)
    if (rp && wp && rp !== wp) {
      return { score: 0, explanation: `series part mismatch (ref part ${rp} vs work part ${wp})` }
    }
  }

  const t = ref.title ? titleSimilarity(ref.title, work.title) : 0
  // When the parser could not isolate a title (number-only ACS/Angewandte
  // styles print none), score the work's title for CONTAINMENT in the whole raw
  // entry instead. Capped below 1 because it is a weaker signal than a
  // title-to-title comparison: the entry contains authors and venue too, so a
  // topically-adjacent work can pick up incidental overlap.
  // Only when the parser could NOT isolate a title. Applying it as a general
  // top-up lets a work's title words be found scattered through an entry that
  // states a DIFFERENT title, which is how the review titled "Computational
  // Enzyme Design" — three tokens, all ubiquitous in this field — collects a
  // perfect containment score against "Computational Design of an Enzyme
  // Catalyst for a Stereoselective ...". Where the entry does state its own
  // title, that title is the evidence, and disagreement with it is meaningful.
  const tRaw = ref.title ? 0 : Math.min(0.92, containment(work.title, unwrapLines(ref.raw_bib_text)))
  const title = Math.max(t, tRaw)
  const authors = surnameScore(ref, work)
  const year = yearScore(ref, work)

  // TITLELESS STYLES. ACS, Angewandte and Nature-letters bibliographies print
  // authors, journal, year, volume, pages — and no title whatsoever. For those
  // entries the title term is structurally unavailable, not merely weak, so
  // scoring them on the title scale guarantees they never reach threshold no
  // matter how perfectly authors and year agree.
  //
  // When we detect that case we substitute VENUE for TITLE at a lower weight.
  // Venue is a genuinely independent signal (two same-author same-year papers
  // in different journals separate cleanly), but it is far lower-entropy than a
  // title, hence 0.30 rather than 0.60 — a venue match alone can never carry an
  // entry over the bar; it must still be joined by authors and year.
  const titleless = ref.title == null && title < 0.35
  let score: number
  let explanation: string
  if (titleless && ref.venue && work.venue) {
    const venue = venueSimilarity(ref.venue, work.venue)
    // YEAR IS MANDATORY HERE. Without a title, the remaining signals are
    // authors and venue — and prolific groups in this field publish several
    // papers in the SAME journal, so those two alone cannot tell KE07 from
    // KE70. The year is the only thing that separates them, so a titleless
    // entry whose year disagrees is refused outright rather than allowed to
    // coast on a strong author match.
    if (year === 0) {
      return {
        score: 0,
        explanation: `titleless rejected: year mismatch (ref=${ref.year ?? '?'} work=${work.year ?? '?'})`
      }
    }
    // Likewise the venue must actually agree. Venue is the ONLY content signal
    // in this path; letting a mismatched journal through leaves author+year,
    // which two papers by the same lab in the same year both satisfy.
    if (venue < 0.6) {
      return {
        score: 0,
        explanation: `titleless rejected: venue mismatch (${venue.toFixed(2)}) ref=${ref.venue} work=${work.venue}`
      }
    }
    // And the FIRST author must appear. Venue+year alone still admits the many
    // papers this field publishes in the same journal and year by different
    // groups (e.g. Smith et al. JACS 2008 matching Alexandrova et al. JACS
    // 2008). Note this is a check on the first author SPECIFICALLY, not on the
    // aggregate author score: an entry that lists all fourteen authors scores
    // below 1.0 by construction, so thresholding the aggregate would throw away
    // correct matches that name the right lead author.
    if (!firstAuthorPresent(ref, work)) {
      return { score: 0, explanation: 'titleless rejected: first author absent' }
    }
    score = W_VENUE_TITLELESS * venue + W_AUTHORS * authors + W_YEAR * year
    // Renormalize onto the same [0,1] scale the threshold was chosen against,
    // so one threshold governs both paths.
    score = score / (W_VENUE_TITLELESS + W_AUTHORS + W_YEAR)
    explanation = `titleless venue=${venue.toFixed(2)} authors=${authors.toFixed(2)} year=${year.toFixed(2)} => ${score.toFixed(3)}`
  } else {
    // DOUBLE-CONTRADICTION VETO. A title can agree perfectly and still name a
    // DIFFERENT paper: authors republish, and this corpus contains
    // "Off-the-shelf proteins that rival tailor-made antibodies as catalysts"
    // twice — Hollfelder/Kirby/Tawfik, Nature 1996 and again J. Org. Chem. 2001.
    // Title similarity is 1.0 and the authors are identical, so the title-led
    // path resolves the 2001 paper onto the 1996 work. Neither the year nor the
    // venue disagreeing is damning on its own (issue-vs-online years differ;
    // venue parsing is noisy), but BOTH disagreeing means the entry is
    // positively describing a different publication, not a noisy record of this
    // one.
    if (ref.year != null && work.year != null && Math.abs(ref.year - work.year) > 1 && ref.venue && work.venue) {
      const v = venueSimilarity(ref.venue, work.venue)
      if (v < 0.5) {
        return {
          score: 0,
          explanation: `rejected: year AND venue both contradict (ref=${ref.year}/${ref.venue} work=${work.year}/${work.venue})`
        }
      }
    }
    score = W_TITLE * title + W_AUTHORS * authors + W_YEAR * year
    explanation = `title=${title.toFixed(2)} authors=${authors.toFixed(2)} year=${year.toFixed(2)} => ${score.toFixed(3)}`
  }
  return { score, explanation }
}

/**
 * Resolve every parsed reference against the corpus.
 *
 * DOI first — a DOI is an identifier, not a guess, so a DOI hit short-circuits
 * scoring at confidence 1.0. Otherwise take the best-scoring work above
 * MATCH_THRESHOLD. A work may only be claimed once per citing paper (a
 * bibliography does not list the same paper twice), which removes the main
 * source of false positives: two near-identical entries from the same authors
 * both grabbing the same work.
 */
export function matchReferences(
  references: ParsedReference[],
  corpus: CorpusWork[],
  opts: { threshold?: number; excludeWorkId?: number } = {}
): ReferenceMatch[] {
  const threshold = opts.threshold ?? MATCH_THRESHOLD
  const byDoi = new Map<string, CorpusWork>()
  for (const w of corpus) {
    if (w.doi) byDoi.set(normalizeDoi(w.doi), w)
  }

  interface Candidate {
    refIndex: number
    work: CorpusWork
    score: number
    method: MatchMethod
    explanation: string
  }
  const candidates: Candidate[] = []

  references.forEach((ref, refIndex) => {
    if (ref.doi) {
      const w = byDoi.get(ref.doi)
      if (w && w.work_id !== opts.excludeWorkId) {
        candidates.push({
          refIndex,
          work: w,
          score: 1,
          method: 'doi',
          explanation: `doi exact match ${ref.doi}`
        })
        return
      }
    }
    for (const w of corpus) {
      if (w.work_id === opts.excludeWorkId) continue
      const { score, explanation } = scoreMatch(ref, w)
      if (score >= threshold) {
        candidates.push({ refIndex, work: w, score, method: 'scored', explanation })
      }
    }
  })

  // Greedy assignment, best score first, one work per citing paper and one
  // work per reference. Deterministic: ties break on refIndex then work_id.
  candidates.sort(
    (a, b) => b.score - a.score || a.refIndex - b.refIndex || a.work.work_id - b.work.work_id
  )
  const takenWork = new Set<number>()
  const takenRef = new Set<number>()
  const assigned = new Map<number, Candidate>()
  for (const c of candidates) {
    if (takenWork.has(c.work.work_id) || takenRef.has(c.refIndex)) continue
    takenWork.add(c.work.work_id)
    takenRef.add(c.refIndex)
    assigned.set(c.refIndex, c)
  }

  return references.map((reference, i) => {
    const c = assigned.get(i)
    if (!c) return { reference, work_id: null, confidence: 0, method: null, explanation: 'no candidate above threshold' }
    return {
      reference,
      work_id: c.work.work_id,
      confidence: Number(c.score.toFixed(4)),
      method: c.method,
      explanation: c.explanation
    }
  })
}

/** Convenience: parse + match in one deterministic call. */
export function parseAndMatch(
  text: string,
  corpus: CorpusWork[],
  opts: { threshold?: number; excludeWorkId?: number } = {}
): { diagnostics: ParseDiagnostics; matches: ReferenceMatch[] } {
  const { references, diagnostics } = parseReferences(text)
  return { diagnostics, matches: matchReferences(references, corpus, opts) }
}

export { normalizeLoose }
