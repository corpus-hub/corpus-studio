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
 * Largest vertical step, in PDF points, still inside one table.
 *
 * Rows are set a line apart — 9 to 12 points in these journals — and a footnote
 * sits a little further. Beyond this is the next block on the page.
 */
const MAX_ROW_GAP = 40

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

    // Walk down while this still looks like the table: data rows, or short
    // label lines between them. Two consecutive lines of prose end it.
    //
    // A VERTICAL GAP ends the table, and that is what actually bounds it. Rows
    // are a line apart; the next block on the page is much further down.
    // Without this the walk ran past the last row into whatever followed —
    // doc8's crop came out 1549x1621, of which the table was the top tenth and
    // the rest was three protein structures and a free-energy map.
    let last = i
    let dataRows = 0
    let proseRun = 0
    let lastBaseline = lines[i].baseline
    for (let j = i + 1; j < lines.length; j++) {
      if (isCaption[j]) break
      const text = lines[j].text
      if (text.length === 0) continue
      // PDF y grows upward, so a later line has a SMALLER baseline.
      if (lastBaseline - lines[j].baseline > MAX_ROW_GAP) break
      lastBaseline = Math.min(lastBaseline, lines[j].baseline)
      if (isNumeric(text)) {
        dataRows++
        proseRun = 0
        last = j
      } else if (text.length <= MAX_LABEL_LEN) {
        // A row or column label. Keeps the region growing across header rows.
        proseRun = 0
        last = j
      } else if (dataRows === 0) {
        // THE CAPTION'S OWN LEGEND, which is prose and belongs to the table.
        //
        // Many journals set the whole legend — what the columns mean, what the
        // errors are, which conditions applied — between the caption and the
        // first data row. The prose rule cannot fire here, because it exists to
        // detect leaving the table BELOW it, and we have not entered it yet.
        // Stopping on this text cut the crop off above every row it was
        // rendered to show: seven of this corpus's tables produced a picture of
        // their own caption and nothing else.
        //
        // Unbounded is safe and deliberately not a budget: the walk is still
        // held by MAX_ROW_GAP, and a caption that never reaches `minRows` data
        // rows yields no region at all, so prose alone can never produce one.
        last = j
      } else {
        proseRun++
        if (proseRun >= 2) break
      }
    }
    if (dataRows < minRows) continue

    const span = lines.slice(i, last + 1)
    out.push({
      page,
      x0: Math.min(...span.map((s) => s.x0)),
      y0: Math.min(...span.map((s) => s.y0)),
      x1: Math.max(...span.map((s) => s.x1)),
      y1: Math.max(...span.map((s) => s.y1)),
      charStart: span[0].charStart,
      charEnd: span[span.length - 1].charEnd,
      label: lines[i].text.slice(0, 120)
    })
    i = last
  }
  return out
}
