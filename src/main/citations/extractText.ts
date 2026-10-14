// Deterministic PDF -> plain text extraction for the citation parser.
//
// Runs in the MAIN process (or under `ELECTRON_RUN_AS_NODE=1 electron`), so it
// uses pdfjs' legacy build, which has no DOM/worker requirement. Everything is
// pure: same PDF bytes always yield the same string.

/**
 * One positioned text run, with the span it occupies in its page's text.
 *
 * `charStart`/`charEnd` are what make this useful: geometry alone cannot say
 * WHICH characters were raised, and a consumer that re-found the string would
 * match the wrong occurrence. `page.text.slice(charStart, charEnd) === str`
 * always, by construction — the offsets are recorded as the string is built,
 * never recomputed.
 */
export interface ExtractedItem {
  str: string
  charStart: number
  charEnd: number
  /** Glyph height: |transform[3]|. A superscript is small AND raised. */
  height: number
  /** Baseline y: transform[5]. Compared against the preceding run's. */
  baseline: number
  /**
   * Left edge in PDF user space: transform[4].
   *
   * Kept because a run's vertical band alone cannot bound a REGION of the page.
   * Without x and width a table's columns are unknown, so the table cannot be
   * cropped out and shown to the model as a picture — which is the only reliable
   * way to read values the text layer mangles (`0 . 29 6 0 . 11` is what this
   * corpus stores for `0.29 ± 0.11`).
   */
  x: number
  /** Advance width of the run, in PDF user space, as pdfjs reports it. */
  width: number
}

export interface ExtractedPage {
  page: number
  text: string
  /**
   * Present only when geometry was requested.
   *
   * Optional because the citation parser does not want it and building it for
   * a 40-page paper is thousands of objects it would immediately discard.
   */
  items?: ExtractedItem[]
}

export interface ExtractedDoc {
  pages: ExtractedPage[]
  /** All pages joined with a form feed; the parser works over this. */
  text: string
}

type PdfjsModule = {
  getDocument(src: unknown): { promise: Promise<PdfDocumentLike> }
  GlobalWorkerOptions: { workerSrc: string }
}
interface PdfDocumentLike {
  numPages: number
  getPage(n: number): Promise<PdfPageLike>
  destroy?(): Promise<void>
}
interface PdfPageLike {
  getTextContent(): Promise<{ items: Array<Record<string, unknown>> }>
}

let pdfjsPromise: Promise<PdfjsModule> | null = null

/**
 * pdfjs-dist ships ESM only. The legacy build is the one that works without a
 * browser; loading it lazily keeps the module importable from CommonJS callers
 * (the seed and verify scripts) that never touch PDFs.
 */
async function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const mod = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfjsModule
      // pdfjs falls back to running the worker inline when there is no worker
      // host, but it still insists on a workerSrc to load. Point it at the
      // LOCAL legacy worker bundle — never a CDN.
      const { createRequire } = await import('node:module')
      const req = createRequire(__filename)
      mod.GlobalWorkerOptions.workerSrc = req.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
      return mod
    })()
  }
  return pdfjsPromise
}

/**
 * Join pdfjs text items into a line-oriented string.
 *
 * pdfjs emits one item per positioned text run, with `hasEOL` marking the end
 * of a visual line. Bibliographies are the densest, most hyphenated text in a
 * paper, so the joining rule matters: we insert a space between runs on the
 * same line (they are usually separate words split by kerning) and a newline at
 * `hasEOL`. Line re-joining (de-hyphenation, wrapped entries) happens later in
 * the parser, where it can use reference-entry structure.
 */
function itemsToText(
  items: Array<Record<string, unknown>>,
  geometry?: ExtractedItem[]
): string {
  let out = ''
  for (const item of items) {
    const str = typeof item.str === 'string' ? item.str : ''
    if (str) {
      // A run that already ends in a space, or a previous char that is a space,
      // must not produce a double space — keep whitespace canonical so the
      // parser's offsets and the raw bib text are stable.
      const needsSpace = out.length > 0 && !/\s$/.test(out) && !/^\s/.test(str)
      if (needsSpace) out += ' '
      const charStart = out.length
      out += str
      if (geometry) {
        // Recorded HERE, as the string is built, so the span is exact rather
        // than re-found. `transform` is [a,b,c,d,e,f]: index 3 is the vertical
        // scale (the glyph height) and index 5 is the baseline y.
        const t = item.transform as number[] | undefined
        geometry.push({
          str,
          charStart,
          charEnd: out.length,
          height: Array.isArray(t) ? Math.abs(t[3] ?? 0) : 0,
          baseline: Array.isArray(t) ? (t[5] ?? 0) : 0,
          // The HORIZONTAL half of the same transform, which was being thrown
          // away. Without it a run's vertical band is known and its columns are
          // not, so a region of the page cannot be bounded — and a table cannot
          // be cropped out of it to be read as a picture. Index 4 is the x
          // translation; `width` pdfjs reports directly.
          x: Array.isArray(t) ? (t[4] ?? 0) : 0,
          width: typeof item.width === 'number' ? item.width : 0
        })
      }
    }
    if (item.hasEOL === true) out += '\n'
  }
  return out
}

export async function extractPdfText(
  source: string | Uint8Array,
  opts: { geometry?: boolean } = {}
): Promise<ExtractedDoc> {
  const pdfjs = await loadPdfjs()
  let data: Uint8Array
  if (typeof source === 'string') {
    const { readFile } = await import('node:fs/promises')
    data = new Uint8Array(await readFile(source))
  } else {
    data = source
  }
  const doc = await pdfjs.getDocument({
    data,
    // Deterministic + offline: no system font probing, no eval, no network.
    useSystemFonts: false,
    isEvalSupported: false,
    disableFontFace: true,
    // We only ever read text content, never render glyphs, so the standard font
    // data is genuinely unnecessary — but pdfjs warns once per embedded font
    // without it, burying real output. Silence its logger rather than shipping
    // the font files we would never use.
    verbosity: 0
  }).promise

  const pages: ExtractedPage[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    // The TEXT is byte-identical whether or not geometry was asked for: the
    // same function builds it either way. That is load-bearing — `PARSER_VERSION`
    // and every stored citation parse are keyed to this exact string, so a
    // geometry-only change must not move a single character.
    const geometry = opts.geometry ? ([] as ExtractedItem[]) : undefined
    pages.push({ page: i, text: itemsToText(content.items, geometry), items: geometry })
  }
  await doc.destroy?.()
  return { pages, text: pages.map((p) => p.text).join('\n\f\n') }
}
