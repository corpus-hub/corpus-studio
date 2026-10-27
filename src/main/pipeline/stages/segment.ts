// The paragraph inventory: `text.pages@v2` -> `text.paragraphs@v1`.
//
// This is the anchor every later stage resolves against. A citation callout at
// character 41 200 is "paragraph p87, methods, page 6" only because this stage
// said so, so its two invariants are worth stating plainly:
//
//   1. `text.slice(charStart, charEnd) === paragraph.text`, ALWAYS. Asserted
//      here, not assumed. A violation is `failed retryable:false` and
//      explicitly NOT `empty`: an offset bug that presented as "this paper has
//      no prose" would be cached, would satisfy every dependent, and would
//      leave the paper permanently analysed as blank.
//   2. `para_id` is POSITIONAL (`p0`, `p1`, …), so a re-segment renumbers
//      everything. That is why the supersede cascade DELETES a superseded run's
//      `document_paragraph` rows rather than leaving them: a stored anchor must
//      never outlive the inventory it was resolved against.

import type { ParagraphKind, ParagraphRecord, Paragraphs, SectionBucket, TextPages } from '../capabilities'
import type { StageDefinition } from '../types'

interface SegmentWrite {
  paragraphs: ParagraphRecord[]
}

/**
 * Heading text -> IMRaD bucket. Ordered: the FIRST match wins, so the more
 * specific patterns come first.
 *
 * `background` and `related-work` are separate from `introduction` because
 * papers in this domain routinely have all three, and a reader looking for
 * "what did they actually do" is not helped by three things called intro.
 */
const SECTION_PATTERNS: Array<[RegExp, SectionBucket]> = [
  [/^abstract\b/, 'abstract'],
  [/^(related\s+works?|prior\s+art)\b/, 'related-work'],
  [/^(background|literature\s+review)\b/, 'background'],
  [/^introduction\b/, 'introduction'],
  [/^(materials?\s+and\s+methods?|methods?|methodology|experimental(\s+section)?|procedures?)\b/, 'methods'],
  [/^(results?\s+and\s+discussions?)\b/, 'results'],
  [/^results?\b/, 'results'],
  [/^discussions?\b/, 'discussion'],
  [/^(conclusions?|summary|concluding\s+remarks)\b/, 'conclusion'],
  [/^(acknowledge?ments?|acknowledgements?)\b/, 'acknowledgements'],
  [/^(references?|bibliography|literature\s+cited|works\s+cited)\b/, 'references'],
  [/^(supplementary|supporting\s+information|appendix|appendices)\b/, 'supplementary']
]

/**
 * Normalise a heading to its bucket, or null if it is not one we know.
 *
 * The leading number is stripped so `"2. MATERIALS AND METHODS"` and
 * `"Materials and Methods"` land in the same bucket — a paper's numbering is a
 * typesetting choice and must not change what section a sentence is in.
 */
function bucketOf(headingText: string): SectionBucket | null {
  const stripped = headingText
    .trim()
    .replace(/^[IVXLCDM]+[.)]\s+/i, '')
    .replace(/^\d+(\.\d+)*[.)]?\s+/, '')
    .replace(/\s+/g, ' ')
  const t = stripped.toLowerCase()
  for (const [re, bucket] of SECTION_PATTERNS) {
    const m = re.exec(t)
    if (!m) continue
    // What FOLLOWS the section word must still read as a heading.
    //
    // `'methods are errorless.'` and `'Methods for experimental details) For
    // each of these eight designs,'` are wrapped prose lines that the shape test
    // already mistook for headings — and a section switch is carried forward, so
    // one of them relabels every paragraph to the end of the paper. Judging the
    // REMAINDER rather than the whole line is what keeps `'Experimental
    // characterization'` and `'Materials and Methods'` (whose own conjunction is
    // inside the matched phrase) working.
    const rest = stripped.slice(m[0].length).trim()
    // Only a LOWERCASE continuation is suspect: it is the same clause carrying
    // on. `'ACKNOWLEDGMENTS. Financial support by…'` and `'Methods | Following
    // the active site design…'` are a heading with its paragraph glued behind
    // it, and the capital (or the full stop) says so.
    if (/^\p{Ll}/u.test(rest)) {
      // A lowercase word may still complete the heading — `'Experimental
      // characterization'`, `'Results and analysis'`. What it may not do is read
      // as a clause: carry prose marks, run long, or end in punctuation.
      if (rest.length > 40 || /[.,;:]$/.test(rest) || PROSE_MARKS_RE.test(rest)) continue
    }
    return bucket
  }
  return null
}

/**
 * A line that IS the bibliography heading, rather than one that merely begins
 * with the word.
 *
 * Whole-line, because the switch it controls is one-way and reclassifies
 * everything after it: `'Reference -3.6'` (a table cell) and
 * `'Methods Enzymol. 383, 66–93.'` (a citation) both satisfy a prefix match.
 * A section number or a trailing colon is allowed; anything else is not a
 * heading, it is text that happens to start with the word.
 */
const IS_BIBLIOGRAPHY_HEADING =
  /^(?:\d+(?:\.\d+)*|[IVXLCDM]+)?[.)]?\s*(references?|bibliography|literature\s+cited|works\s+cited|references?\s+and\s+notes?)\s*:?\s*$/i

/** A figure/table caption. Excluded from prose consumers, kept as evidence. */
const CAPTION_RE = /^\s*(fig(ure)?\.?|table|scheme|chart|supplementary\s+(fig|table))\s*\.?\s*\d/i

interface RawParagraph {
  charStart: number
  charEnd: number
  text: string
  kind: ParagraphKind
}

/** Junk a paragraph must never be: rules, dot leaders, bare page numbers. */
const JUNK_RE = /^[\s.\u2026·•\-–—_]+$/
const PAGE_NUMBER_RE = /^\d{1,4}$/

/**
 * A heading NAMES A SECTION. It is not merely a short line.
 *
 * The old test — under 90 characters, 14 words or fewer, no terminal
 * punctuation, starts with a capital — describes almost every line of a
 * two-column paper, because pdfjs emits one unit per rendered line and a
 * column line is short and rarely ends in a full stop. Measured on this
 * corpus: 4 243 units were classified `heading` and 4 149 of them (97%) name no
 * section at all — `'Mimickinc the efficiency of enzyme catalysis is a daunting
 * chal-'`, `'University Chemical Laboratory, Cambridge CB2 1EW, UK'`.
 *
 * That is not a cosmetic mislabel. A heading is flushed as its own paragraph on
 * BOTH sides, so every false positive severs a real paragraph in two, and 89%
 * of all boundaries in the inventory came from this branch. The result was a
 * paragraph inventory with a median length of 55 characters of which only 14%
 * ended in terminal punctuation — units that cannot hold a whole sentence,
 * which is what made the evidence contract unsatisfiable however the prompt was
 * worded: the model quotes a sentence, and no single "paragraph" contains one.
 *
 * A heading must therefore look like one on its own terms: it names a known
 * section, or it is short AND titled AND free of the marks running prose
 * carries. Prose that merely wrapped stays prose.
 */
const HEADING_WORD_RE =
  /^(abstract|introduction|background|results?|discussion|conclusions?|methods?|materials(\s+and\s+methods)?|experimental(\s+section|\s+procedures?)?|theory|references?|bibliography|acknowledge?ments?|supporting\s+information|supplementary(\s+\w+)?|author\s+contributions?|competing\s+interests?|data\s+availability|funding|abbreviations)\b/i

/** Marks and words that running prose carries and a title does not. */
const PROSE_MARKS_RE = /[,;:]|\b(the|of|and|in|to|for|that|with|which|we|were|was|is|are)\b/i

/**
 * Running heads, copyright lines and volume/issue rules.
 *
 * These sit between columns in the text layer and are short, capitalised and
 * unpunctuated — indistinguishable from a section title by shape alone, and
 * each one accepted cuts the paragraph it landed in.
 */
const FURNITURE_RE =
  /(publishing group|all rights reserved|©|\(c\)\s*\d{4}|wiley|elsevier|springer|american chemical society|www\.|https?:|doi:|vol\.?\s*\d|no\.?\s*\d|\bpp?\.\s*\d|issn|isbn|downloaded (from|by)|paragon plus|nature\s*[-|]|proc\.?\s+natl)/i

function classify(text: string): ParagraphKind {
  const t = text.trim()
  if (/^\s*([-*•]|\d+[.)])\s+/.test(t)) return 'list'

  // Strip a leading section number so "3.2 Results" is judged on "Results".
  const bare = t.replace(/^(\d+(\.\d+)*|[IVXLCDM]+)[.)]?\s+/, '')

  // A named section is a heading at any plausible length.
  if (bare.length <= 120 && HEADING_WORD_RE.test(bare)) return 'heading'

  // Otherwise it must be SHORT, unpunctuated and read as a title rather than a
  // clause. A trailing hyphen is a wrapped word, which only prose does.
  //
  // The exclusions below are what separates a title from the two things that
  // look most like one in a text layer: a TABLE CELL (`'K m'`, `'(mM)'`,
  // `'(M 2 1 s 2 1 )'`, `'BSA 6.8 1.37+40.12'`) and PAGE FURNITURE
  // (`'Nature Publishing Group ©2008'`, `'62 NATURE - VOL 383 - 5 SEPTEMBER
  // 1996'`). Both are short, capitalised and unpunctuated, so length alone
  // admits them — and each one admitted severs a real paragraph in two.
  const words = bare.split(/\s+/)
  const digits = (bare.match(/\d/g) ?? []).length
  const letters = (bare.match(/\p{L}/gu) ?? []).length
  // `words.length >= 2` keeps a lone table cell (`'Base'`, `'(mM)'`) from
  // becoming a heading — but a real section heading is very often ONE word
  // ("References", "Methods", "Discussion"), and those are handled above by
  // HEADING_WORD_RE. Anything else standing alone is a cell, not a title.
  if (
    bare.length <= 60 &&
    words.length >= 2 &&
    words.length <= 8 &&
    letters >= 6 &&
    // Mostly numbers means a datum, not a title.
    digits <= letters / 3 &&
    !/[.!?;:,]$/.test(bare) &&
    !/[-\u2010\u00ad]$/.test(bare) &&
    !PROSE_MARKS_RE.test(bare) &&
    !FURNITURE_RE.test(bare) &&
    !looksTabular(bare) &&
    /^[A-Z(]/.test(bare)
  ) {
    return 'heading'
  }
  return 'prose'
}



/**
 * Does this read as a row of a table rather than a title?
 *
 * The remaining false headings are almost all table rows: `'Gly202 Arg Arg Arg
 * Arg Arg Arg Arg'`, `'Val12 Met Leu Met'`, `'Base Hydrogen-bond'`. They are
 * short, capitalised and unpunctuated, so every shape test above admits them —
 * and each one admitted is a flush on BOTH sides, which is precisely what cuts
 * a table into the scattered fragments the extractor then cannot anchor a value
 * in. 258 of the 352 non-section headings look like this.
 *
 * What separates them from a title is REPETITION and residue-shaped tokens: a
 * title does not say the same word four times, and does not consist of
 * three-letter amino-acid codes or a residue number glued to one.
 */
const RESIDUE_RE =
  /^(?:ala|arg|asn|asp|cys|gln|glu|gly|his|ile|leu|lys|met|phe|pro|ser|thr|trp|tyr|val)\d*$/i

function looksTabular(bare: string): boolean {
  const words = bare.split(/\s+/).filter(Boolean)
  if (words.length < 2) return false
  // A repeated word is a column of identical cells, never a section title.
  const uniq = new Set(words.map((w) => w.toLowerCase()))
  if (uniq.size < words.length) return true
  // Mostly amino-acid codes: a mutation table row.
  const residues = words.filter((w) => RESIDUE_RE.test(w.replace(/[^A-Za-z0-9]/g, ''))).length
  return residues >= 2
}

/**
 * Is this the first entry of a bibliography that carries NO heading?
 *
 * Nature-family papers print the reference list straight after the text with no
 * "References" line to switch on — ten of the twenty papers here, and each one
 * handed its whole bibliography to the model as prose, which is exactly what
 * `kind='reference'` exists to prevent.
 *
 * The evidence is the RUN, not the single paragraph: one numbered, dated,
 * author-shaped line is a sentence a paper might well contain, whereas three of
 * them in ascending order is a reference list.
 */
/**
 * The ordinal a bibliography entry opens with, in either convention: `12.` /
 * `12)` and the bracketed `[12]` that Wiley and the IEEE style use. Omitting the
 * bracketed form left one 28-page review's entire 200-entry reference list read
 * as body prose.
 */
const BIB_ENTRY_RE = /^\s*(?:\[(\d{1,3})\]|(\d{1,3})[.)])\s+\S/

/** A four-digit year — the mark a citation carries and a recipe step does not. */
const YEAR_RE = /\b(1[89]|20)\d{2}\b/

/**
 * An author list, in either of the two conventions a bibliography uses.
 *
 * `Privett, H. K.` puts the initials after a comma and full-stops them;
 * `Debler EW, et al.` runs them together with no stop at all. Testing only for
 * the first missed every PNAS/Cell-style list, which is what let a whole
 * bibliography ride out the `acknowledgements` section it happened to follow.
 */
const AUTHOR_SHAPE_RE = /([A-Z]\.[\s,)]|,\s*[A-Z]\.|\b[A-Z][a-z]{2,}\s+[A-Z]{1,3}[,\s])/

/**
 * The number in front is a SECTION number, not a bibliography ordinal.
 *
 * A review numbers its sections (`1. Introduction`, `2.1.3. Aldol Reaction`),
 * and its opening section is dense enough with names and years to satisfy every
 * other test here. One paper's entire 28-page body — 31 of its 50 chunks —
 * was filed as bibliography by that route and thereby excluded from prose
 * consumers and from anchoring alike.
 */
function startsWithSectionName(afterNumber: string): boolean {
  return HEADING_WORD_RE.test(afterNumber.trim())
}

/**
 * Does this line open a bibliography entry — number, authors, year, in that
 * order and close together?
 *
 * The window matters: a year and an initial ANYWHERE in a 3 000-character block
 * of prose says nothing, whereas both inside the first 200 characters after the
 * ordinal is the shape of a citation and very little else.
 */
function isBibEntryLine(block: string, lineStart = 0): number | null {
  const m = BIB_ENTRY_RE.exec(block.slice(lineStart).split('\n')[0])
  if (!m) return null
  // The window runs into the BLOCK, not to the end of the line. A wrapped entry
  // puts its journal and year on the following line, so a line-bounded window
  // rejected every reference that did not fit on one — which is most of them.
  const from = lineStart + m[0].length - 1
  const after = block.slice(from, from + 200)
  if (startsWithSectionName(after)) return null
  if (!YEAR_RE.test(after)) return null
  if (!AUTHOR_SHAPE_RE.test(after)) return null
  return Number(m[1] ?? m[2])
}

function looksLikeBibliographyStart(raw: RawParagraph[], at: number): boolean {
  const firstOrdinal = isBibEntryLine(raw[at]?.text ?? '')
  // The paragraph must itself BE an entry. Opening the switch on a paragraph
  // that merely contains one somewhere would hand the switch to any sentence
  // quoting a reference list.
  if (firstOrdinal === null) return false
  // The list need NOT open at `1.`. A two-column layout puts entry 1 in the
  // column beside the acknowledgements and the switch then never fires at all,
  // which is how a whole bibliography came to be filed as `acknowledgements` —
  // and acknowledgements are excluded from anchoring, so those references were
  // both mislabelled and invisible. What identifies the list is the run; the
  // year-and-author test inside `isBibEntryLine` is what a numbered procedure
  // fails, and it does not depend on the list starting at one.

  // Count entries by their NUMBER, wherever they fall, requiring only that the
  // numbers ASCEND. Consecutiveness was too strict twice over: two entries often
  // share one paragraph (a Nature bibliography whose `1.` and `2.` are one
  // block), and a two-column layout interleaves them so that the list reads
  // 2, 6, 7, 11 in paragraph order while every one of those IS an entry. What
  // identifies a bibliography is a run of ascending, dated, author-shaped
  // entries — not the typesetter's packing.
  let seen = 1
  let last = firstOrdinal
  for (let i = at; i < raw.length && i < at + 12 && seen < 3; i++) {
    const block = raw[i].text
    for (const m of block.matchAll(/\n/g)) {
      const n = isBibEntryLine(block, m.index + 1)
      if (n === null || n <= last) continue
      last = n
      seen++
      if (seen >= 3) break
    }
  }
  return seen >= 3
}

/**
 * Words that running prose is built from. The RATIO of these to all words is
 * what separates a paragraph of argument from a byline, an affiliation block, a
 * keyword list or a column of kinetic constants — all of which are long enough
 * to pass a length test and contain almost none of these.
 */
const FUNCTION_WORD_RE =
  /\b(the|of|and|in|to|for|that|with|which|we|were|was|is|are|this|these|by|from|as|on|at|have|has|been|it|its|their|but|not|can|be|than|when|such|our|also|more|between|during|other|would|could|may|both|each)\b/gi

/**
 * Front matter that is NOT the title block and can appear anywhere the
 * typesetter put it — author contributions, correspondence, funding notes,
 * keyword and abbreviation lists, publisher boilerplate.
 *
 * These are matched by NAME rather than by shape, because their shape is
 * ordinary prose. That is the whole reason a shape test alone cannot bound the
 * front matter.
 */
const FRONT_MATTER_MARKER_RE =
  /(author\s+contributions?|designed\s+research|performed\s+research|analy[sz]ed\s+data|wrote\s+the\s+paper|the\s+authors?\s+declare|conflict\s+of\s+interest|competing\s+(financial\s+)?interests?|direct\s+submission|data\s+(deposition|availability)|present\s+address|corresponding\s+author|correspondence|reprints?\s+and\s+permissions|e-?mail\s*:|just\s+accepted|peer.?reviewed|accepted\s+for\s+publication)/i

/** Front matter recognised by how the block OPENS. */
const FRONT_MATTER_HEAD_RE =
  /^\s*(keywords?|key\s+words?|abbreviations?|received|revised|accepted|edited\s+by|communicated\s+by|running\s+(head|title)|subscriber\s+access)\b/i

/**
 * Is this paragraph body prose — the paper actually saying something?
 *
 * This is the test that bounds the front matter, and it is deliberately about
 * SHAPE rather than position: a 2 755-character block of flowing sentences
 * beginning "The first step in our protocol for designing new enzymes is to
 * choose…" is not a title under any definition, however early in the document it
 * sits. The old classifier had no such test — `title` simply ran from the first
 * paragraph until the first heading it recognised, so a paper whose headings are
 * topical ("Computational design method") filed its abstract AND its opening
 * body as title block. Once front matter became ineligible as a citation anchor,
 * that mislabel turned into permanent unanchorability for exactly the papers
 * everyone cites.
 *
 * Length, sentence count and function-word density together are what a byline,
 * an affiliation list, a keyword line and a table of constants all fail — and
 * they are properties of writing, not of this corpus or this field.
 */
function isBodyProse(text: string): boolean {
  const t = text.trim()
  if (t.length < 250) return false
  const words = t.split(/\s+/).filter(Boolean).length
  if (words < 40) return false
  const sentences = (t.match(/[.!?]["')\]]?(?:\s|$)/g) ?? []).length
  if (sentences < 2) return false
  const fn = (t.match(FUNCTION_WORD_RE) ?? []).length
  if (fn / words < 0.15) return false

  const head = t.slice(0, 300)
  if (FRONT_MATTER_MARKER_RE.test(head) || FRONT_MATTER_HEAD_RE.test(head)) return false
  // Past this length the block is dominated by whatever prose it holds, whoever
  // glued a copyright line to its front. A text layer routinely merges the
  // running head, the title, the byline AND the abstract into one unit, and
  // judging that unit by its first line would file the abstract as furniture.
  if (t.length >= 1200) return true
  if (FURNITURE_RE.test(head)) return false
  return true
}

/**
 * A section heading the text layer glued to the top of the paragraph below it.
 *
 * The first line must BE the heading and nothing else. Accepting a first line
 * that merely STARTS with a section word switched the section on wrapped prose
 * — `'Results for the KE07 series were obtained by…'` — and a section switch is
 * carried forward, so one such line relabels the rest of the paper. The
 * whole-line test is the same discipline `IS_BIBLIOGRAPHY_HEADING` already
 * applies to the one-way references switch, for the same reason.
 */
const WHOLE_HEADING_LINE_RE =
  /^(?:\d+(?:\.\d+)*|[IVXLCDM]+)?[.)]?\s*([A-Za-z][A-Za-z\s/&-]{2,45}?)\s*[.:]?\s*$/

function leadingHeadingBucket(text: string): SectionBucket | null {
  const firstLine = text.split('\n')[0].trim()
  const m = WHOLE_HEADING_LINE_RE.exec(firstLine)
  if (!m) return null
  return bucketOf(m[1])
}

/**
 * A front-matter aside, wherever it appears.
 *
 * Bounded by length: these notes are short. A long block that merely MENTIONS
 * correspondence is prose about correspondence.
 */
function isFrontMatterAside(text: string): boolean {
  const t = text.trim()
  if (t.length > 600) return false
  const head = t.slice(0, 200)
  return FRONT_MATTER_MARKER_RE.test(head) || FRONT_MATTER_HEAD_RE.test(head)
}

/**
 * Build paragraphs from a PDF's text layer, preserving exact offsets.
 *
 * NOT `llm/segment.ts`'s `segment()`, and the difference matters. That function
 * splits on BLANK LINES, which is right for prose a human typed — but pdfjs
 * emits one `\n` per rendered LINE and no blank lines at all, so on a real
 * paper it returns exactly one paragraph per page. (Measured: an 8-page,
 * 54 721-character Nature article segmented to 8 paragraphs, one section, and
 * therefore no usable anchor anywhere in the document.) `segment()` is left
 * alone because `llm/pipeline.ts` still uses it on model-facing prose.
 *
 * Here a paragraph break is inferred from the LAYOUT signals a text layer
 * actually carries: a line that ends a sentence followed by one that starts
 * like a new one, a short line (the ragged end of a paragraph), a blank line
 * where there is one, or a heading. Offsets index the original string
 * throughout, so the exact-slice contract holds by construction rather than by
 * reconstruction — the stage asserts it anyway.
 */
function buildParagraphs(text: string): RawParagraph[] {
  const out: RawParagraph[] = []
  // Line spans over the ORIGINAL string, so no offset is ever recomputed.
  const lines: Array<{ start: number; end: number; text: string }> = []
  let cursor = 0
  for (const raw of text.split('\n')) {
    lines.push({ start: cursor, end: cursor + raw.length, text: raw })
    cursor += raw.length + 1
  }

  // The width of a full line, from the body itself rather than a constant: a
  // two-column paper's lines are half as wide as a single-column one's, and a
  // fixed threshold would call every line in a two-column layout "short" and
  // break the paragraph at each one.
  const widths = lines.map((l) => l.text.trim().length).filter((n) => n > 0)
  widths.sort((a, b) => a - b)
  const median = widths.length > 0 ? widths[Math.floor(widths.length * 0.75)] : 80
  const shortLine = Math.max(20, Math.round(median * 0.6))

  let group: Array<{ start: number; end: number; text: string }> = []
  const flush = (): void => {
    if (group.length === 0) return
    const start = group[0].start
    const end = group[group.length - 1].end
    const body = text.slice(start, end)
    const lead = body.length - body.trimStart().length
    const trail = body.length - body.trimEnd().length
    const s = start + lead
    const e = end - trail
    group = []
    if (e <= s) return
    const slice = text.slice(s, e)
    if (JUNK_RE.test(slice) || PAGE_NUMBER_RE.test(slice.trim())) return
    out.push({ charStart: s, charEnd: e, text: slice, kind: classify(slice) })
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const t = line.text.trim()
    if (t === '') {
      flush()
      continue
    }
    // A heading DEMOTED by its neighbours.
    //
    // `'Base Hydrogen-bond'` is a column header: two capitalised words, no
    // punctuation, no repetition, no residue codes — every shape test says
    // heading. What gives it away is the company it keeps. A real section
    // heading is preceded by the end of a sentence; a column header sits in the
    // middle of a table, between runs of cells. Flushing on it split this
    // paper's Table 1 header away from its twenty data rows, so the model cited
    // the headers it could see and missed the block holding the numbers.
    let isHeading = classify(t) === 'heading'
    if (isHeading) {
      const prev = lines[i - 1]?.text.trim() ?? ''
      const next = lines[i + 1]?.text.trim() ?? ''
      // Table-ish means: short, and not ending a sentence. Prose around a real
      // heading does neither.
      const tabular = (x: string): boolean =>
        x.length > 0 && x.length <= 60 && !/[.!?]["')\]]?$/.test(x)
      if (tabular(prev) && tabular(next)) isHeading = false
    }
    // A heading is its own paragraph on both sides — it is the thing the
    // section lookup keys on, so merging it into the prose around it would lose
    // the boundary entirely.
    if (isHeading) {
      flush()
      group.push(line)
      flush()
      continue
    }
    group.push(line)
    const next = lines[i + 1]
    if (!next || next.text.trim() === '') {
      flush()
      continue
    }
    const endsSentence = /[.!?]["')\]]?$/.test(t)
    const nextStartsNew = /^[A-Z(\u2022\-\d]/.test(next.text.trim())
    const isShort = t.length < shortLine
    if ((endsSentence && nextStartsNew && isShort) || (isShort && endsSentence)) flush()
  }
  flush()
  return out
}

const segment: StageDefinition<{ paragraphs: number; sections: number }> = {
  id: 'segment',
  label: 'Segment text',
  // 2.0.0: `classify()` no longer calls every short line a heading, and the
  // bibliography switch requires a whole-line heading. Both change which
  // characters land in which paragraph, and paragraph ids are POSITIONAL — so a
  // cached run from the old rule would leave every downstream anchor pointing
  // at text that has moved. The version is what makes the cache miss.
  version: '2.5.0',
  rank: 4,
  scope: 'document',
  provides: ['text.paragraphs@v1'],
  requires: ['text.pages@v2'],
  usesLlm: false,
  runtime: 'node',
  isolation: 'host',
  weight: 'heavy',

  async execute(ctx) {
    const pages = ctx.input<TextPages>('text.pages@v2')
    if (!pages) {
      return { status: 'skipped', reason: 'no text.pages@v2 — nothing to segment' }
    }

    const raw = buildParagraphs(pages.text)
    if (raw.length === 0) {
      return {
        status: 'empty',
        reason: `${pages.pageCount} ${pages.pageCount === 1 ? 'page' : 'pages'} of text, but no usable paragraphs in it`
      }
    }

    // Page resolution is by CONTAINMENT of the paragraph's start offset in a
    // page's span — exact, not a proportional guess. `page` is the thing that
    // makes a page number real rather than "whatever a model claimed", so it
    // must not itself be a heuristic.
    const pageAt = (offset: number): number | null => {
      for (const p of pages.pages) if (offset >= p.charStart && offset < p.charEnd) return p.page
      return null
    }

    // One pass, carrying the nearest PRECEDING heading's bucket forward.
    //
    // 'title' is the FRONT MATTER bucket — the title block, authors and
    // affiliations that precede the paper's first heading. It is a real place in
    // the paper, and it ENDS. The carry-forward used to run it to the end of the
    // document whenever no IMRaD heading was ever recognised, which on a review
    // whose headings are topical ("Computational Enzyme Design") meant 587
    // paragraphs deep — every sentence in the body labelled as sitting in the
    // title block. That is not a title-block artifact, it is a carry-forward
    // failure: 'title' was silently doing duty as "unknown", which is precisely
    // what 'other' is for, and the difference matters because one states a
    // location and the other admits to having none.
    //
    // So the front matter is bounded by the thing that actually bounds it on the
    // page: it cannot outlive page 1. Past that, with no recognised heading yet
    // seen, the section is genuinely undetermined and says so.
    let current: SectionBucket = 'title'
    let sawHeading = false
    // The front matter has been left behind. Once true it never goes back:
    // `title` names a place at the START of a paper, and a paper does not return
    // to its own byline.
    let leftFrontMatter = false
    // The abstract is claimed ONCE. The first body prose of a paper that never
    // says "Abstract" is its abstract; the second is not a second abstract.
    let claimedAbstract = false
    // Where an aside interrupted, so the section RESUMES rather than restarting.
    let resumeAfterAside: SectionBucket | null = null
    // Characters filed under an INFERRED abstract — one the paper never labelled.
    //
    // An abstract is a bounded thing: a summary, a few hundred words, at the
    // front. Carrying an inferred one forward until the next recognised heading
    // put 26 and 28 chunks of body under it in two papers here, which is the
    // same carry-forward failure as the `title` overrun and just as wrong. Past
    // the budget, with still no heading, the paper is simply into its body.
    let inferredAbstractChars: number | null = null
    const ABSTRACT_BUDGET = 2500
    const paragraphs: ParagraphRecord[] = []
    for (let ri = 0; ri < raw.length; ri++) {
      const p = raw[ri]
      const page = pageAt(p.charStart)
      if (current === 'title' && !sawHeading && page !== null && page > 1) {
        current = 'other'
      }

      // Front matter ends where the paper starts SPEAKING, not where the first
      // recognised heading happens to be. A paper whose headings are topical has
      // no recognised heading for pages, and running `title` to meet it filed
      // the abstract and the opening body as front matter — which, since front
      // matter is excluded from citation anchors, made the most-cited papers in
      // a library permanently unanchorable.
      if (
        current === 'title' &&
        resumeAfterAside === null &&
        !leftFrontMatter &&
        p.kind !== 'heading' &&
        isBodyProse(p.text)
      ) {
        // A block that OPENS with a section name carries its own answer. Text
        // layers routinely glue a heading to the paragraph beneath it, and
        // "1. Introduction | Life depends on protein catalysts…" says plainly
        // where it is.
        const own = bucketOf(p.text.split('\n')[0])
        if (own && own !== 'title') {
          current = own
          sawHeading = true
        } else {
          current = claimedAbstract ? 'introduction' : 'abstract'
          if (current === 'abstract') inferredAbstractChars = 0
        }
        claimedAbstract = true
        leftFrontMatter = true
      } else if (
        current !== 'title' &&
        current !== 'references' &&
        current !== 'acknowledgements' &&
        isFrontMatterAside(p.text)
      ) {
        // Correspondence, funding notes and author contributions that the
        // typesetter parked mid-column. Named as what they are so the anchor
        // filter still excludes them — the point of this change is to stop
        // calling prose front matter, not to start admitting front matter.
        resumeAfterAside = current
        current = 'title'
        leftFrontMatter = false
      } else if (resumeAfterAside !== null && current === 'title') {
        // The aside is over, but only once real prose resumes. A publisher
        // stacks its notes — contributions, then the conflict-of-interest line,
        // then three present addresses — and resuming on the paragraph AFTER the
        // first one made the section alternate title/body/title/body down the
        // whole stack, filing half the notes as body prose.
        if (isBodyProse(p.text) || p.kind === 'heading') {
          current = resumeAfterAside
          resumeAfterAside = null
          leftFrontMatter = true
        }
      } else if (inferredAbstractChars !== null) {
        inferredAbstractChars += p.text.length
        if (inferredAbstractChars > ABSTRACT_BUDGET) {
          current = 'introduction'
          inferredAbstractChars = null
        }
      }

      // A heading the text layer GLUED to the paragraph beneath it.
      //
      // pdfjs emits no blank line after a heading, so `'1. Introduction'` and
      // the paragraph under it arrive as one unit and no heading is ever
      // detected. On a review whose other headings are topical this cost every
      // section switch in the document: 122 paragraphs sat in `other` while
      // their own first line said where they were. Only the FIRST line is
      // consulted, and only when it is short enough to be a heading rather than
      // a sentence that opens with the word.
      if (p.kind !== 'heading') {
        const led = leadingHeadingBucket(p.text)
        if (led && led !== 'title' && led !== 'references') {
          current = led
          sawHeading = true
          inferredAbstractChars = null
        }
      }

      let kind: ParagraphKind = p.kind
      if (p.kind === 'heading') {
        const bucket = bucketOf(p.text)
        // ENTERING `references` is a one-way switch that reclassifies every
        // paragraph after it, so it demands more than a prefix match. A table
        // cell reading `'Reference -3.6'` satisfied `^references?` and took the
        // remaining 37% of one paper — including its kinetics table — out of
        // every prompt, because reference paragraphs are filtered from the
        // model's view. The heading must BE the word, not merely start with it.
        if (bucket === 'references' && !IS_BIBLIOGRAPHY_HEADING.test(p.text.trim())) {
          // Not a bibliography heading. Fall through as ordinary prose.
        } else if (bucket) {
          current = bucket
          sawHeading = true
          inferredAbstractChars = null
        }
      } else if (current !== 'references' && looksLikeBibliographyStart(raw, ri)) {
        // A bibliography with NO heading. Nature-family papers print the list
        // straight after the text, so there is no "References" line to switch
        // on — ten of twenty papers here, and every one of them fed its whole
        // bibliography to the model as prose. The run of numbered, dated,
        // author-shaped entries IS the heading in that layout.
        current = 'references'
        kind = 'reference'
      } else if (CAPTION_RE.test(p.text)) {
        kind = 'caption'
      } else if (current === 'references') {
        // Bibliography entries are prose-shaped and are NOT prose. Marking them
        // keeps them out of LLM prompts, which is what stops an extraction
        // summarising a reference list as if it were findings.
        kind = 'reference'
      }
      paragraphs.push({
        paraId: `p${paragraphs.length}`,
        index: paragraphs.length,
        charStart: p.charStart,
        charEnd: p.charEnd,
        page,
        kind,
        section: current,
        text: p.text
      })
      if (ctx.signal.aborted) return { status: 'failed', error: 'cancelled', retryable: true }
    }

    // Invariant 1, checked rather than trusted.
    for (const p of paragraphs) {
      if (pages.text.slice(p.charStart, p.charEnd) !== p.text) {
        return {
          status: 'failed',
          error:
            `paragraph ${p.paraId} violates the exact-slice contract ` +
            `(${p.charStart}..${p.charEnd}) — every downstream anchor would be wrong`,
          retryable: false
        }
      }
    }

    const value: Paragraphs = {
      documentId: ctx.documentId,
      text: pages.text,
      paragraphs
    }
    ctx.emit('text.paragraphs@v1', value)
    ctx.write({ paragraphs } satisfies SegmentWrite)

    const sections = new Set(paragraphs.map((p) => p.section))
    return {
      status: 'succeeded',
      result: { paragraphs: paragraphs.length, sections: sections.size },
      note: `${paragraphs.length} paragraph(s) across ${sections.size} section(s)`
    }
  },

  applyWrites(db, payload, ctx) {
    const w = payload as SegmentWrite
    // No delete-first: `beginRun` superseded the previous run and the cascade
    // deleted its rows, so the slot is already clear. Deleting by document_id
    // here would additionally destroy a CONCURRENT run's inventory.
    const insert = db.prepare(
      `INSERT INTO document_paragraph
         (stage_run_id, document_id, para_id, idx, char_start, char_end, page, kind, section, text, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const now = new Date().toISOString()
    for (const p of w.paragraphs) {
      insert.run(
        ctx.stageRunId,
        ctx.documentId,
        p.paraId,
        p.index,
        p.charStart,
        p.charEnd,
        p.page,
        p.kind,
        p.section,
        p.text,
        now
      )
    }
  }
}

export default segment
