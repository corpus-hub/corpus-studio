// Render one REGION of a PDF page to a PNG.
//
// The text layer is not a faithful record of a table. This corpus stores
// `0 . 29 6 0 . 11` where the page prints `0.29 ± 0.11`, and `M 1 s 1` where it
// prints `M⁻¹s⁻¹` — the publisher's font encoding, flattened. Every text-only
// repair for that is a guess about how it was flattened, and a wrong guess
// INVENTS a value: a rule reading a lone `6` between digits as a plus-minus
// turned the exponent range `10 3 –10 6 10 7` into `10 3 –10 ± 10 7`.
//
// The page itself is unambiguous. Cropping the table and showing it to the model
// reads `0.29 ± 0.11` because that is what is drawn. The extracted TEXT still
// supplies the [pN] a fact cites, so the anchoring contract is unchanged: the
// image is how a value is READ, the text is how it is CITED.
//
// Only the region is rendered, never the page. A full page is mostly prose the
// model already has in better form, and paying for it in tokens on every
// extraction would be a cost with no answer attached.

import type { PageRegion } from './regions'

/**
 * Rendering scale. Table cells are set small — 7pt is common — and a
 * plus-minus, a superscript minus and a decimal point are exactly the marks
 * that vanish first when a raster is too coarse. 3x puts a 7pt glyph at ~29px,
 * which is legible without paying for a page-sized image.
 */
export const CROP_SCALE = 3

/** Breathing room so a glyph at the edge is not clipped mid-stroke. */
const PAD = 6

/**
 * Scale of the MEASURING pass, in pixels per PDF point.
 *
 * The trim is measured on a rendered bitmap rather than on the run boxes the
 * region was derived from, because the two disagree: a run's baseline box is
 * not what pdf.js paints, and on a rotated page — this corpus has pages at
 * `rot: 90` — it is not even the same axis. One point per pixel is enough to
 * place an edge within a point, which the margin below absorbs.
 */
const MEASURE_SCALE = 1

/**
 * A pixel is INK when any channel falls this far below white.
 *
 * Anti-aliasing and a scanner's paper tone both sit within a few levels of
 * white; a table's hairline rule does not.
 */
const INK_THRESHOLD = 246

/**
 * Quiet edge left around the ink, in PDF points.
 *
 * Not flush: a table's outer rule and a superscript sit at the very edge of the
 * ink, and a measuring pass that places an edge within a point would clip them.
 * Small, because blank paper in a crop is paid for on every extraction and
 * shrinks the glyphs that the crop exists to make readable.
 */
const TRIM_PAD = 2

/**
 * Share of a band's extent that must be inked before a line counts as CONTENT.
 *
 * A page carries furniture as well as a table: this corpus's journal prints its
 * running head rotated down the outer margin and its folio in the corner, so a
 * band that ends a third of the way up the picture still has a few dark pixels
 * on every row below it. A bounding box drawn around ANY ink therefore reports
 * the crop as tight while 29% of it is blank paper — measured on
 * `table 2 (continued)`, 318px of 1088.
 *
 * A rule, a folio and a rotated title are one to four pixels across; the
 * shortest real line of table text is an order of magnitude wider. Two percent
 * sits between them without knowing anything about either.
 */
const CONTENT_INK_FRAC = 0.02

/**
 * Below this share of the extent, a line is FURNITURE and counts as blank.
 *
 * The running head that motivated all this is unbroken down the whole margin,
 * so a gap measured in lines with NO ink never arrives and the span grows to the
 * page edge regardless. What separates it from text is width, not presence: it
 * is one or two pixels across at every scale this measures at, while the
 * narrowest glyph a line of prose can consist of is several times that.
 *
 * Kept well under CONTENT_INK_FRAC so the two thresholds cannot cross and turn
 * the growth below into a second seeding pass.
 */
const FURNITURE_INK_FRAC = 0.005

/**
 * Blank run, in PDF points, that separates content from furniture.
 *
 * Density alone would cut a genuinely sparse last line — a one-clause footnote,
 * a single trailing value. So density only SEEDS the span, which then grows
 * outwards over anything above the furniture level until it meets a run this
 * long with nothing in it. A footnote sits a line below its table; a folio sits
 * a third of a page away.
 */
const CONTENT_GAP_PT = 14

/**
 * First and last index that belong to the content, or null when none do.
 *
 * `counts` is ink per line, `extent` the length of a line. Seeded by density,
 * grown over faint-but-real lines, stopped by a run of furniture or nothing —
 * see the three constants above.
 */
function contentSpan(counts: number[], extent: number, gap: number): [number, number] | null {
  const dense = extent * CONTENT_INK_FRAC
  const faint = extent * FURNITURE_INK_FRAC
  let first = -1
  let last = -1
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] <= dense) continue
    if (first < 0) first = i
    last = i
  }
  if (first < 0) return null
  let lo = first
  for (let i = first - 1, blank = 0; i >= 0 && blank <= gap; i--) {
    if (counts[i] > faint) {
      lo = i
      blank = 0
    } else blank++
  }
  let hi = last
  for (let i = last + 1, blank = 0; i < counts.length && blank <= gap; i++) {
    if (counts[i] > faint) {
      hi = i
      blank = 0
    } else blank++
  }
  return [lo, hi]
}

/**
 * Long edge of a rendered crop, in pixels.
 *
 * A vision model does not read finer than this, so anything larger is paid for
 * and discarded. Table text stays legible because the crop holds only the table
 * — a full-page table at 1000px is the same glyph size as the page itself on
 * screen.
 */
const MAX_EDGE_PX = 1000

/**
 * Tallest a STACKED crop may be, in pixels.
 *
 * A stack is a table and its continuation, so two page-heights is its ceiling
 * and this only ever binds when both halves are page-tall. It exists so that
 * fitting a stack on its WIDTH cannot produce an image whose height is paid for
 * without limit.
 */
const MAX_STACK_PX = 2600

export interface RenderedCrop {
  region: PageRegion
  /** PNG bytes. */
  png: Buffer
  widthPx: number
  heightPx: number
  /**
   * Where a PDF-space POINT of the last part's page lands on this image.
   *
   * A FUNCTION rather than an origin and a sign, because the mapping is not in
   * general a translation: the page may be painted rotated, and then a step
   * along the page's x runs DOWN the picture. Two offsets can only express the
   * unrotated case, and expressed it for every case — see ViewRect.
   *
   * Carried so a caller can mark a passage without re-deriving the crop
   * transform. Getting that wrong is silent: the box lands plausibly, on the
   * wrong row.
   */
  place: (x: number, y: number) => [number, number]
  /** Pixels per point of the page as painted — a LENGTH's scale, not a point's. */
  scale: number
}

/** The pdfjs page object, narrowed to what rendering needs. */
interface PdfPage {
  getViewport: (o: { scale: number }) => PdfViewport
  render: (o: { canvasContext: unknown; viewport: unknown }) => { promise: Promise<void> }
}

/**
 * The mapping from PDF user space onto the pixels pdf.js actually paints.
 *
 * ASKED FOR, never reconstructed. Two things live inside it that no formula over
 * `width`/`height`/`viewBox` recovers without already knowing which case it is
 * in. The crop box need not begin at the origin — this corpus's scan starts at
 * y = 10.29 and one journal's pages at y = 38.88 — and a page may carry
 * `/Rotate`, which pdf.js honours by turning the page, so the axes of what is
 * painted are not the axes the region was measured in.
 */
interface PdfViewport {
  width: number
  height: number
  convertToViewportPoint: (x: number, y: number) => [number, number]
}

/**
 * A rectangle on the RENDERED page: origin top-left, y growing DOWN, in the
 * viewport's own units. Everything from measuring to drawing is in these.
 *
 * NOT PDF space, and the two are not interchangeable. They were used as if they
 * were, and this corpus's Elsevier journal sets its wide tables landscape, at
 * `rot: 90`. The crop was then sized from the region's PDF-space extent while
 * pdf.js painted the page turned through a right angle: a table 678 points wide
 * got a box 543 points wide — the extent of the OTHER axis — and every column
 * past that point fell outside the picture. Two whole columns of measured values
 * never reached the model, on a crop whose ink ran flush to its right edge and
 * so looked correctly tight.
 */
interface ViewRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** Where a PDF-space region lands on the page as painted, in viewport units. */
function viewRect(viewport: PdfViewport, region: PageRegion): ViewRect {
  const a = viewport.convertToViewportPoint(region.x0, region.y0)
  const b = viewport.convertToViewportPoint(region.x1, region.y1)
  return {
    x0: Math.min(a[0], b[0]),
    y0: Math.min(a[1], b[1]),
    x1: Math.max(a[0], b[0]),
    y1: Math.max(a[1], b[1])
  }
}

/**
 * Render `region` of `page` to a PNG, or null when it is not worth sending.
 *
 * The caller owns the pdfjs document and must clean the page up afterwards:
 * pdfjs runs its worker in-process under Node, so a decoded page stays on this
 * heap until its object store is cleared.
 */
export async function cropRegion(page: PdfPage, region: PageRegion): Promise<RenderedCrop | null> {
  return cropStack([{ page, region }])
}

/**
 * Render one or more regions into a SINGLE picture, stacked in the order given.
 *
 * Stacking exists for a table that runs over a page break. Its caption and
 * column titles are printed once, on the first page; what follows the break is
 * bare rows — a `35` between an error-bearing rate and a mutation name. Two
 * separate images do not repair that: a model asked to bind that `35` to a
 * column binds it to whichever column it can see. Drawn one above the other the
 * halves are a table again.
 *
 * ONE scale and one shared width for every part, because that is what makes the
 * columns of the two halves line up; sized independently the picture argues that
 * the rows sit under different headings.
 *
 * EACH PART IS RENDERED ON ITS OWN CANVAS and composited. `render` paints the
 * whole page through whatever transform the context carries, so rendering two
 * parts into one context paints the second over the first, and clipping the
 * destination does not help — pdf.js composites its own layers against it and
 * the result came back a solid dark rectangle with the text gone. Compositing
 * finished images keeps every part on exactly the path a single crop takes.
 *
 * The returned transform is the LAST part's, which is the one a caller marks a
 * passage on, with `originY` raised by the points stacked above it.
 */
/**
 * Where the CONTENT lies inside `region`, as a rectangle ON THE RENDERED PAGE,
 * or null when the band came back blank.
 *
 * Rendered, not derived. See MEASURE_SCALE. Content rather than ink, because a
 * page's marginal furniture is ink too — see CONTENT_INK_FRAC. Viewport units
 * rather than PDF ones, because that is the space the measurement was taken in
 * and converting back would have to undo a rotation — see ViewRect.
 */
async function inkBox(
  createCanvas: (w: number, h: number) => ReturnType<typeof import('@napi-rs/canvas').createCanvas>,
  page: PdfPage,
  region: PageRegion
): Promise<ViewRect | null> {
  const s = MEASURE_SCALE
  const viewport = page.getViewport({ scale: s })
  const band = viewRect(viewport, region)
  const w = Math.ceil(band.x1 - band.x0 + PAD * 2 * s)
  const h = Math.ceil(band.y1 - band.y0 + PAD * 2 * s)
  if (w <= 0 || h <= 0) return null
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  // The viewport already places the page; the band's top-left only has to be
  // slid to the canvas origin, with the pad left showing around it.
  ctx.translate(-(band.x0 - PAD * s), -(band.y0 - PAD * s))
  await page.render({ canvasContext: ctx, viewport }).promise
  const { data } = ctx.getImageData(0, 0, w, h)
  const inked = (x: number, y: number): boolean => {
    const i = (y * w + x) * 4
    return !(
      data[i] > INK_THRESHOLD &&
      data[i + 1] > INK_THRESHOLD &&
      data[i + 2] > INK_THRESHOLD
    )
  }
  const gap = Math.max(1, Math.round(CONTENT_GAP_PT * s))
  const tally = (
    outer: number,
    inner0: number,
    inner1: number,
    at: (o: number, i: number) => boolean
  ): number[] => {
    const counts = new Array<number>(outer).fill(0)
    for (let o = 0; o < outer; o++) {
      let n = 0
      for (let i = inner0; i <= inner1; i++) if (at(o, i)) n++
      counts[o] = n
    }
    return counts
  }
  const ySpan = contentSpan(tally(h, 0, w - 1, (y, x) => inked(x, y)), w, gap)
  if (!ySpan) return null
  const [minY, maxY] = ySpan
  // The x-extent is measured over the CONTENT ROWS ONLY, and by the same rule. A
  // margin's furniture is what the row span just excluded; reading x from any
  // ink over the full height would let it back in through a column.
  const xSpan = contentSpan(
    tally(w, minY, maxY, (x, y) => inked(x, y)),
    maxY - minY + 1,
    gap
  )
  if (!xSpan) return null
  const [minX, maxX] = xSpan
  // Back to viewport units, relative to the same padded band that was drawn.
  return {
    x0: band.x0 - PAD * s + minX,
    x1: band.x0 - PAD * s + maxX + 1,
    y0: band.y0 - PAD * s + minY,
    y1: band.y0 - PAD * s + maxY + 1
  }
}

export async function cropStack(
  parts: Array<{ page: PdfPage; region: PageRegion }>
): Promise<RenderedCrop | null> {
  if (parts.length === 0) return null
  // Imported HERE, not at module scope.
  //
  // `@napi-rs/canvas` is a native addon, and a static import puts it in the
  // chunk every main-process module shares — including the one the STAGE HOST
  // loads. The host is a utilityProcess with a different loader, and the addon
  // died there on `dlopen` with `/lib/x86_64-linux-gnu/libc.so: invalid ELF
  // header`, taking the host down before it could report ready. Every
  // host-isolated stage then failed: segment, extract-text, ocr, embed,
  // optimize — nine of twenty papers stopped segmenting at all, which read as
  // nine unrelated per-paper bugs. Only this function needs the addon, and it
  // never runs in a host.
  const { createCanvas } = await import('@napi-rs/canvas')
  // The scale FOLLOWS the region, rather than being fixed.
  //
  // A fixed 3x is right for a four-row table and wasteful for a full-page one:
  // this corpus produced crops from 752px to 3007px on the long edge, and the
  // large ones cost tokens for detail no reader of the image needs. Fitting the
  // long edge to MAX_EDGE_PX makes the cost of a crop roughly constant, while
  // the cap at CROP_SCALE keeps a small table from being blown up past the
  // resolution it was drawn at.
  // WHAT IS DRAWN is the ink, not the rectangle the runs predicted.
  //
  // A region derived from line runs routinely reaches well past the marks the
  // page actually carries — measured over this corpus, between a tenth and two
  // thirds of a crop was blank paper. That is paid for in tokens on every
  // extraction, and worse, the fit below divides the pixel budget by the padded
  // box, so the glyphs the crop exists to make readable were being drawn
  // smaller than the same budget allows.
  //
  // ONE x-extent for every part, the union of theirs, because a stack's halves
  // only read as one table while their columns line up; trimmed independently
  // the continuation would slide sideways under its own header.
  //
  // MEASURED ONE AT A TIME, deliberately. Each measurement drives pdf.js onto a
  // `@napi-rs/canvas` surface — a native addon, reached from the main process
  // while the queue is running other document stages that drive pdf.js too.
  // Measuring the parts concurrently killed the app outright with `Fatal error
  // in V8: HandleScope::HandleScope Entering the V8 API without proper locking
  // in place`, four `references` jobs in flight at the time. A stack has two
  // parts, so concurrency here wins nothing and can lose the process.
  const measured: (ViewRect | null)[] = []
  for (const p of parts) {
    measured.push((await inkBox(createCanvas, p.page, p.region)) ?? null)
  }
  //
  // Sized in the PAGE'S OWN PAINTED AXES, at MEASURE_SCALE, so a picture's width
  // is the table's width as a reader sees it. Sizing it from the region's PDF
  // extent instead is what cut the right-hand columns off every landscape-set
  // table here — see ViewRect.
  const boxes = parts.map(({ page, region }, i) => {
    const ink = measured[i]
    const band = viewRect(page.getViewport({ scale: MEASURE_SCALE }), region)
    const pad = PAD * MEASURE_SCALE
    const fallback = {
      x0: band.x0 - pad,
      x1: band.x1 + pad,
      y0: band.y0 - pad,
      y1: band.y1 + pad
    }
    if (!ink) return fallback
    const trim = TRIM_PAD * MEASURE_SCALE
    return {
      x0: Math.max(fallback.x0, ink.x0 - trim),
      x1: Math.min(fallback.x1, ink.x1 + trim),
      y0: Math.max(fallback.y0, ink.y0 - trim),
      y1: Math.min(fallback.y1, ink.y1 + trim)
    }
  })
  const drawX0 = Math.min(...boxes.map((b) => b.x0))
  const drawX1 = Math.max(...boxes.map((b) => b.x1))
  const draws = boxes.map((b) => ({ x0: drawX0, x1: drawX1, y0: b.y0, y1: b.y1 }))
  // Back to points of the painted page, which is what `scale` is per.
  const wPt = (drawX1 - drawX0) / MEASURE_SCALE
  const hPt = draws.reduce((t, d) => t + (d.y1 - d.y0), 0) / MEASURE_SCALE
  if (wPt <= 0 || hPt <= 0) return null
  // A STACK is fitted on its WIDTH, not its long edge.
  //
  // Stacking two page-tall regions doubles the height, so a long-edge fit halves
  // the scale and the glyphs with it — the picture that was added to make a
  // column readable came back at half the size of the one that was not. Width is
  // what sets glyph size, and it is the same for both halves by construction.
  // The height is still bounded, by MAX_STACK_PX, because a stack is at most two
  // regions and neither can exceed a page.
  const longEdge = parts.length > 1 ? wPt : Math.max(wPt, hPt)
  const scale = Math.min(CROP_SCALE, MAX_EDGE_PX / longEdge, MAX_STACK_PX / hPt)
  const w = Math.ceil(wPt * scale)
  const h = Math.ceil(hPt * scale)
  if (w <= 0 || h <= 0) return null

  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  // White, not transparent: a PNG with an alpha channel renders as black in
  // some viewers, and a table read against black is a table not read.
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)

  let yPx = 0
  let last: { region: PageRegion; place: RenderedCrop['place'] } | null = null
  const k = scale / MEASURE_SCALE
  for (const [i, { page, region }] of parts.entries()) {
    const draw = draws[i]
    const viewport = page.getViewport({ scale })
    const bandPx = Math.ceil((draw.y1 - draw.y0) * k)
    const part = createCanvas(w, bandPx)
    const pctx = part.getContext('2d')
    pctx.fillStyle = '#ffffff'
    pctx.fillRect(0, 0, w, bandPx)
    // The viewport already carries the page's crop-box offset AND its rotation,
    // so drawing a band is only a translation WITHIN it: slide the band's
    // top-left corner to this canvas's origin.
    //
    // Building that offset by hand out of `viewBox` instead was wrong twice
    // over. It slid every crop up the page by 10 to 39 points on the two
    // publishers whose crop box does not start at the origin, and it assumed the
    // page's axes were the picture's — which the landscape tables are not.
    const offX = draw.x0 * k
    const offY = draw.y0 * k
    pctx.translate(-offX, -offY)
    await page.render({ canvasContext: pctx, viewport }).promise
    ctx.drawImage(part, 0, yPx)
    const stacked = yPx
    last = {
      region,
      // Through the SAME viewport the band was painted through, then shifted by
      // the band's own offset and by whatever is stacked above it.
      place: (x, y) => {
        const [vx, vy] = viewport.convertToViewportPoint(x, y)
        return [vx - offX, vy - offY + stacked]
      }
    }
    yPx += bandPx
  }
  if (!last) return null

  return {
    region: last.region,
    png: canvas.toBuffer('image/png'),
    widthPx: w,
    heightPx: h,
    place: last.place,
    scale
  }
}
