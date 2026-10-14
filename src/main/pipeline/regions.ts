// Where a TABLE sits on a page, in PDF user space.
//
// WHY THIS EXISTS. A table does not survive text extraction as a table. Its
// cells arrive as runs in reading order with the grid thrown away, its glyphs
// are mangled by the publisher's font encoding — this corpus stores
// `0 . 29 6 0 . 11` for `0.29 ± 0.11`, and `M 1 s 1` for `M⁻¹s⁻¹` — and the
// paragraph segmenter then cuts the remains into fragments. Every text-only
// repair for that is a guess about how the mangling happened, and a guess that
// is wrong INVENTS a number: a rule reading a lone `6` between digits as a
// plus-minus turned `10 3 –10 6 10 7`, a range of exponents, into
// `10 3 –10 ± 10 7`.
//
// The page itself is not ambiguous. Cropping the table and showing it to a
// vision model reads `0.29 ± 0.11` because that is what is printed. So this
// finds the rectangle to crop — nothing more. The extracted TEXT still supplies
// the [pN] a fact cites, so the anchoring contract is untouched: the image is
// how a value is READ, the text is how it is CITED.

import type { TextItem } from './capabilities'

/** A rectangle on one page, in PDF user space (origin bottom-left). */
export interface PageRegion {
  page: number
  x0: number
  y0: number
  x1: number
  y1: number
  /** Char span of the runs inside it, so the caller can name the paragraphs. */
  charStart: number
  charEnd: number
  /** The caption line, when one was found. Used to label the crop. */
  label: string | null
  /**
   * The table this region CONTINUES, on the page before it.
   *
   * A table that runs over a page break prints its caption and column titles
   * once. The rows on the far side are bare numbers — `35` between `4380 ± 350`
   * and a mutation name — and no reader, human or model, can bind one to a
   * column without them. So the continuation is rendered with the earlier region
   * stacked above it, and the two arrive as ONE picture of one table rather than
   * as an orphaned block of digits filed under a different page.
   *
   * The WHOLE earlier region, not a header band sliced off its top. The slice
   * was tried and came out blank on a page whose content is set rotated: a box
   * derived from run baselines is not in general a box pdf.js will draw into,
   * and a picture that is silently empty is worse than one carrying rows the
   * reader has already seen — which are the same table anyway.
   */
  header?: PageRegion
}

/**
 * THE UNIT OF THIS FILE IS A PRINTED LINE, NOT A TEXT RUN.
 *
 * A run is whatever the producer chose to emit, and the two producers disagree
 * completely. pdfjs emits a positioned run — often a whole caption, sometimes a
 * single glyph. Tesseract emits ONE RUN PER WORD, so a scanned page delivers
 * `['TABLE','1','Kinetic','parameters',…]` and no run is ever more than a word.
 *
 * Everything below used to be written against runs, and so it worked on one
 * producer and silently did nothing on the other. On this corpus's 1973 scan
 * the caption never matched, no region was found, no crop was rendered, and the
 * model read the page from OCR text alone — which had dropped the decimal
 * points, so `1.37` reached the reader as `137`. Ten values on one paper, every
 * one wrong by a factor of ten to a hundred, each carrying a verbatim quote and
 * a 92%-confidence OCR badge beside it.
 *
 * Reassembling the line first makes the two producers indistinguishable here,
 * which is the only reason a rule written against one of them can be trusted on
 * the other.
 */
interface PageLine {
  text: string
  x0: number
  y0: number
  x1: number
  y1: number
  /** The lowest baseline in the line — its position down the page. */
  baseline: number
  charStart: number
  charEnd: number
}

/**
 * A table caption, matched against a whole printed LINE.
 *
 * `Table 1` and its title arrive as SEPARATE runs — the `|` that separates them
 * in print is drawn, not encoded — and on a scan every word is its own run. So
 * the delimiter cannot be required and neither can the label be required to
 * occupy the run alone: both of those tested a property of the PRODUCER rather
 * than of the page.
 *
 * What separates a caption from a cross-reference is what FOLLOWS the number.
 * A caption is a label and then a title: either the line ends there
 * (`"Table 2."`), or a delimiter introduces the title (`"Table 1 | Kinetic
 * parameters…"`), or the title simply begins — and a title begins with a
 * capital, a bracket or a symbol (`"Table 1 Arrhenius parameters"`).
 *
 * A cross-reference cannot pass, because prose continues in lower case or with
 * punctuation that closes the reference: `"Table 1). The evolved variants…"`,
 * `"Table 1 summarizes the results of…"`, `"Table 3, the designed KE70…"`. Over
 * this corpus that distinction accepts every one of the 41 real captions and
 * rejects all 23 cross-references, without consulting geometry at all.
 */
const CAPTION_RE =
  /^\s*(?:[Tt][Aa][Bb][Ll][EeAa]|[Tt][Aa][Bb][Ll][Ee][Aa][Uu])\s*\.?\s*(?:\d+|[IVXLCDM]+)(?![A-Za-z0-9])\s*(?:$|[|.:]\s*(?:\S.*)?$|\s*[A-Z(\[\u0370-\u03ff\u2206].*$)/

/**
 * Largest vertical step, in PDF points, still inside one table SET AT A NORMAL
 * ROW PITCH.
 *
 * Rows are set a line apart — 9 to 12 points in these journals — and a footnote
 * sits a little further. Beyond this is the next block on the page.
 *
 * This is a FLOOR, not the whole rule: `rowGapLimit` widens it to what the table
 * itself is doing. A table whose rows are set far apart is not a different kind
 * of object, and a fixed step cut the bottom off one.
 */
const MAX_ROW_GAP = 40

/**
 * How much wider than the table's OWN row pitch a step may be and still be a row.
 *
 * The gap that ends a table is the gap to the NEXT BLOCK, and on every page that
 * is several times the row pitch — a figure below a table sits a paragraph away,
 * not a line and a half. Measuring the pitch from the rows already accepted is
 * what lets a widely-spaced table run to its last row without re-admitting the
 * failure the fixed step was added for: doc8's crop once came out 1549x1621, of
 * which the table was the top tenth and the rest was three protein structures
 * and a free-energy map.
 */
const ROW_GAP_TOLERANCE = 2.5

/**
 * Horizontal gap, in multiples of the type size, that ends a printed line.
 *
 * Below this is the space between words; above it is the gutter between columns
 * or between a table's cells. Getting this wrong in either direction breaks the
 * line reconstruction the caption test depends on: too small and a caption is
 * cut in half, too large and two columns of body text are welded into one line
 * that matches nothing.
 */
const COLUMN_GUTTER = 2.5

/** Longest line still readable as a label rather than as prose. */
const MAX_LABEL_LEN = 40

/**
 * Consecutive lines of prose that mean the table is behind us.
 *
 * Not one and not two: a footnote set BETWEEN rows is prose of exactly that
 * length, and stopping on it cut the crop off above every row below it. The
 * region never grows over the trailing prose in any case — `last` advances on a
 * row or a label, never on a prose line — so a run this long costs nothing but
 * the scan, and buys back the bottom of every table with a note inside it.
 */
const PROSE_RUN_END = 4

/**
 * A line that OPENS with a footnote marker — `a`, `b`, `*`, `†`, `1)`.
 *
 * A TABLE'S FOOTNOTES ARE PART OF THE TABLE, and for some rows they are the only
 * part that says what the row holds. Khersonsky 2010's Table 1 prints a row
 * labelled `Temperature dependency^f`, and note f reads "the ratio of enzymatic
 * activity (initial rates) at 60 versus 20 °C" — dimensionless ratios. The
 * heading alone is genuinely ambiguous and matches a temperature field by name,
 * so a reader shown the rows without the notes has no way to know the column is
 * not temperatures.
 *
 * This is a NECESSARY condition and never a sufficient one — `isTableNote`
 * decides, on where the line is SET. A numbered list item, a reference marker in
 * body prose and a figure caption's `(A)` all match this pattern, and admitting
 * one of them is what carried four crops into the next column.
 */
const FOOTNOTE_RE = /^\s*(?:[a-z]|[ivx]{1,3}|\d{1,2}|[*†‡§¶#])\s*[).]?\s+\S/i

/**
 * How far a note may sit outside the block the table's rows occupy.
 *
 * A note is set to the table's own measure — flush with its left edge, never
 * wider than it. A line that starts outside that block is a different column,
 * and on a two-column page that is the body text printed beside the table.
 */
const NOTE_X_SLACK = 12

/**
 * Whether `line` is a note BELONGING to the block the table's rows occupy.
 *
 * The marker is only the cheapest half of the test. What decides is WHERE the
 * line is set:
 *
 *  - BELOW the lowest line accepted so far. Lines come back in reading order, so
 *    on a two-column page the right column restarts at the top of the page and
 *    its step is NEGATIVE — which the row-gap limit passes, because it bounds a
 *    gap downward and a column wrap is not one. Every other rule ends the walk
 *    before that matters; this is the one that must say it itself.
 *  - INSIDE the block's measure. A note is set to the table's own width and does
 *    not resume the body's, so a line reaching past the rows' right edge or
 *    starting left of them is a different column.
 *  - NOT TALLER than the rows. Notes are set smaller; body text is not.
 */
function isTableNote(
  line: PageLine,
  step: number,
  block: { x0: number; x1: number; height: number }
): boolean {
  if (step <= 0) return false
  if (line.x0 < block.x0 - NOTE_X_SLACK) return false
  if (line.x1 > block.x1 + NOTE_X_SLACK) return false
  if (line.y1 - line.y0 > block.height + 0.5) return false
  return FOOTNOTE_RE.test(line.text)
}

/** Lines whose text is mostly digits — a row of a data table. */
function isNumeric(s: string): boolean {
  const t = s.trim()
  if (t.length === 0) return false
  const digits = (t.match(/\d/g) ?? []).length
  return digits > 0 && digits >= t.replace(/\s/g, '').length * 0.4
}

/**
 * Reassemble the page's printed lines from its positioned runs.
 *
 * Runs are taken in the producer's own order, which is reading order for both
 * producers, and a line ends where the next run leaves the baseline or where a
 * column-sized gap opens. Sorting by position instead would be worse, not
 * better: on a two-column page it interleaves the columns, so a table's rows
 * come back spliced with the body text printed beside them.
 */
function buildLines(items: TextItem[]): PageLine[] {
  const geo = items.filter(
    (it) =>
      typeof it.x === 'number' && typeof it.width === 'number' && it.str.trim().length > 0
  )
  if (geo.length === 0) return []
  // The page's own type size, so the thresholds below are in ems rather than in
  // points. A 7pt table and a 12pt one otherwise need different constants.
  const heights = geo.map((it) => it.height).sort((a, b) => a - b)
  const median = heights[heights.length >> 1] || 8

  const lines: PageLine[] = []
  let run: TextItem[] = []
  const flush = (): void => {
    if (run.length === 0) return
    let text = ''
    let prev: TextItem | null = null
    for (const r of run) {
      if (
        prev !== null &&
        (r.x as number) - ((prev.x as number) + (prev.width as number)) >
          0.12 * Math.max(r.height, prev.height)
      ) {
        text += ' '
      }
      text += r.str
      prev = r
    }
    lines.push({
      text: text.trim(),
      x0: Math.min(...run.map((r) => r.x as number)),
      x1: Math.max(...run.map((r) => (r.x as number) + (r.width as number))),
      y0: Math.min(...run.map((r) => r.baseline)),
      y1: Math.max(...run.map((r) => r.baseline + r.height)),
      baseline: Math.min(...run.map((r) => r.baseline)),
      charStart: Math.min(...run.map((r) => r.charStart)),
      charEnd: Math.max(...run.map((r) => r.charEnd))
    })
    run = []
  }
  for (const it of geo) {
    if (run.length > 0) {
      const prev = run[run.length - 1]
      const sameBaseline =
        Math.abs(prev.baseline - it.baseline) <= 0.5 * Math.max(prev.height, it.height, median)
      const gap = (it.x as number) - ((prev.x as number) + (prev.width as number))
      const adjacent = gap >= -0.5 * median && gap <= COLUMN_GUTTER * Math.max(prev.height, it.height, median)
      if (!(sameBaseline && adjacent)) flush()
    }
    run.push(it)
  }
  flush()
  return lines
}

/**
 * Find the table regions on one page.
 *
 * Anchored on the CAPTION, because that is the one part of a table that says in
 * words what it is. From there the region extends down through the lines that
 * belong to it and stops where the table does: at the next caption, at a
 * vertical gap, or where the data rows give way to prose.
 *
 * Returns nothing when the page carries no geometry, which is correct — there
 * is no rectangle to name.
 */
export function findTableRegions(
  page: number,
  items: TextItem[] | undefined,
  opts: { minRows?: number } = {}
): PageRegion[] {
  if (!items || items.length === 0) return []
  const lines = buildLines(items)
  if (lines.length === 0) return []
  const minRows = opts.minRows ?? 3

  const isCaption = lines.map((l) => CAPTION_RE.test(l.text))
  const out: PageRegion[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!isCaption[i]) continue
    const walked = walkTable(lines, isCaption, i, minRows)
    if (!walked) continue
    out.push({
      ...boxOf(page, lines.slice(i, walked.last + 1)),
      label: lines[i].text.slice(0, 120)
    })
    i = walked.last
  }
  return out
}

/**
 * How far down the page a table starting at `start` reaches.
 *
 * Walks while this still looks like the table: data rows, or short label lines
 * between them. A long run of prose ends it.
 *
 * A VERTICAL GAP ends the table, and that is what actually bounds it. Rows are a
 * pitch apart; the next block on the page is several pitches down. Without this
 * the walk ran past the last row into whatever followed — doc8's crop came out
 * 1549x1621, of which the table was the top tenth and the rest was three protein
 * structures and a free-energy map.
 *
 * Null when fewer than `minRows` data rows were reached, which is the whole
 * defence against a region made of prose: nothing here counts a paragraph.
 */
function walkTable(
  lines: PageLine[],
  isCaption: boolean[],
  start: number,
  minRows: number
): { last: number; firstRow: number } | null {
  const i = start
  let last = i
  let dataRows = 0
  let proseRun = 0
  let firstRow = isNumeric(lines[i].text) ? i : -1
  let lastBaseline = lines[i].baseline
  // The table's OWN row pitch, learned from the steps already accepted, so the
  // gap that ends it is measured against how this table is set rather than
  // against a constant that fits the tightest one in the corpus.
  const steps: number[] = []
  // The measure and type size of the ROWS, which is what a note of this table is
  // set to. The caption is excluded: it spans the page in some journals, so
  // including it would licence a note the width of the page.
  const block = { x0: Infinity, x1: -Infinity, height: 0 }
  const widen = (l: PageLine): void => {
    block.x0 = Math.min(block.x0, l.x0)
    block.x1 = Math.max(block.x1, l.x1)
    block.height = Math.max(block.height, l.y1 - l.y0)
  }
  for (let j = i + 1; j < lines.length; j++) {
    if (isCaption[j]) break
    const text = lines[j].text
    if (text.length === 0) continue
    // PDF y grows upward, so a later line has a SMALLER baseline.
    const step = lastBaseline - lines[j].baseline
    if (step > rowGapLimit(steps)) break
    if (step > 0) steps.push(step)
    lastBaseline = Math.min(lastBaseline, lines[j].baseline)
    if (isNumeric(text)) {
      dataRows++
      if (firstRow === -1) firstRow = j
      widen(lines[j])
      proseRun = 0
      last = j
    } else if (text.length <= MAX_LABEL_LEN) {
      // A row or column label. Keeps the region growing across header rows.
      widen(lines[j])
      proseRun = 0
      last = j
    } else if (dataRows > 0 && isTableNote(lines[j], step, block)) {
      // THE TABLE'S OWN FOOTNOTES, below its last row.
      //
      // `last` advances here — unlike on ordinary prose — because these lines
      // are the table's, and a crop that stops above them shows the model a
      // column heading whose meaning is printed just off the bottom of the
      // picture.
      //
      // Only AFTER a data row, so the caption's legend cannot be read as a note
      // and drag a region out of a page that never became a table.
      proseRun = 0
      last = j
    } else if (dataRows === 0) {
      // THE CAPTION'S OWN LEGEND, which is prose and belongs to the table.
      //
      // Many journals set the whole legend — what the columns mean, what the
      // errors are, which conditions applied — between the caption and the
      // first data row. The prose rule cannot fire here, because it exists to
      // detect leaving the table BELOW it, and we have not entered it yet.
      // Stopping on this text cut the crop off above every row it was rendered
      // to show: seven of this corpus's tables produced a picture of their own
      // caption and nothing else.
      //
      // Unbounded is safe and deliberately not a budget: the walk is still held
      // by the row-gap limit, and a caption that never reaches `minRows` data
      // rows yields no region at all, so prose alone can never produce one.
      last = j
    } else {
      proseRun++
      if (proseRun >= PROSE_RUN_END) break
    }
  }
  if (dataRows < minRows) return null
  return { last, firstRow }
}

/**
 * The table CONTINUED from the previous page, when this page opens with one.
 *
 * A table that outruns its page prints its caption and column titles once, on
 * the first page; what follows the break is bare rows. Anchoring on the caption
 * therefore found nothing here, and the continuation reached the model as
 * unlabelled integers — a `35` sitting between `4380 ± 350` and a mutation name,
 * with the word "Fold" in a different paragraph entirely. Half a table is not a
 * smaller table: it is a set of numbers with no columns.
 *
 * The evidence that a page OPENS with one is positional, not lexical: the block
 * begins at the page's first printed lines and is table-shaped by the same walk
 * every other region uses. A page that starts with a paragraph cannot produce
 * one, because prose never reaches `minRows` data rows.
 *
 * Which table it continues is a fact about the PAIR of pages and so is not
 * decided here — the caller carries the header across.
 */
export function findContinuedTable(
  page: number,
  items: TextItem[] | undefined,
  opts: { minRows?: number } = {}
): PageRegion | null {
  if (!items || items.length === 0) return null
  const lines = buildLines(items)
  if (lines.length === 0) return null
  const isCaption = lines.map((l) => CAPTION_RE.test(l.text))
  if (isCaption[0]) return null
  const walked = walkTable(lines, isCaption, 0, opts.minRows ?? 3)
  if (!walked) return null
  // A continuation is the TOP of the page. A block that only becomes table-like
  // several lines in is a table set below prose, and such a table has its own
  // caption here or is not one.
  if (walked.firstRow > 2) return null
  return { ...boxOf(page, lines.slice(0, walked.last + 1)), label: null }
}

/** The rectangle a run of printed lines occupies, with their char span. */
function boxOf(page: number, span: PageLine[]): Omit<PageRegion, 'label'> {
  return {
    page,
    x0: Math.min(...span.map((s) => s.x0)),
    y0: Math.min(...span.map((s) => s.y0)),
    x1: Math.max(...span.map((s) => s.x1)),
    y1: Math.max(...span.map((s) => s.y1)),
    charStart: span[0].charStart,
    charEnd: span[span.length - 1].charEnd
  }
}

/**
 * The largest vertical step still inside this table, given the steps it has
 * already taken.
 *
 * The median is used rather than the mean because a table legitimately contains
 * one or two larger steps — a rule, a subheading — and a mean drags the limit up
 * behind them until the walk leaves the table. Below `MAX_ROW_GAP` the limit
 * never tightens: an early run of tight header lines must not be allowed to
 * declare a normal row pitch out of bounds.
 */
function rowGapLimit(steps: number[]): number {
  if (steps.length < 3) return MAX_ROW_GAP
  const sorted = [...steps].sort((a, b) => a - b)
  const median = sorted[sorted.length >> 1]
  return Math.max(MAX_ROW_GAP, median * ROW_GAP_TOLERANCE)
}
