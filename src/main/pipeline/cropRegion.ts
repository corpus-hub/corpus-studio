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
 * Long edge of a rendered crop, in pixels.
 *
 * A vision model does not read finer than this, so anything larger is paid for
 * and discarded. Table text stays legible because the crop holds only the table
 * — a full-page table at 1000px is the same glyph size as the page itself on
 * screen.
 */
const MAX_EDGE_PX = 1000

export interface RenderedCrop {
  region: PageRegion
  /** PNG bytes. */
  png: Buffer
  widthPx: number
  heightPx: number
  /**
   * How to place a PDF-space rectangle onto this image.
   *
   * Carried so a CALLER can mark a passage on the picture without re-deriving
   * the crop transform: getting it wrong is silent (the box lands plausibly but
   * on the wrong row) and the offsets here are the ones that were already got
   * wrong once — a crop box not flush with the origin slid every crop up the
   * page by 10 to 39 points on two of this corpus's five publishers.
   *
   *   xPx = (xPdf - originX) * scale
   *   yPx = (originY - yPdf) * scale     // PDF y grows UP, canvas y grows DOWN
   */
  scale: number
  originX: number
  originY: number
}

/** The pdfjs page object, narrowed to what rendering needs. */
interface PdfPage {
  getViewport: (o: { scale: number }) => {
    width: number
    height: number
    /**
     * Where the page's own coordinate space begins and ends,
     * `[x0, y0, x1, y1]` in PDF user units.
     *
     * NOT assumed to start at the origin. A publisher's crop box routinely does
     * not: this corpus's scan begins at y = 10.29 and one journal's pages at
     * y = 38.88, so `height - y` is off by exactly that much and every crop made
     * that way sits a few points too high — enough to cut the last row of a
     * table off the bottom while still looking like a plausible picture.
     */
    viewBox: [number, number, number, number]
  }
  render: (o: { canvasContext: unknown; viewport: unknown }) => { promise: Promise<void> }
}

/**
 * Render `region` of `page` to a PNG, or null when it is not worth sending.
 *
 * The caller owns the pdfjs document and must clean the page up afterwards:
 * pdfjs runs its worker in-process under Node, so a decoded page stays on this
 * heap until its object store is cleared.
 */
export async function cropRegion(page: PdfPage, region: PageRegion): Promise<RenderedCrop | null> {
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
  const wPt = region.x1 - region.x0 + PAD * 2
  const hPt = region.y1 - region.y0 + PAD * 2
  if (wPt <= 0 || hPt <= 0) return null
  const scale = Math.min(CROP_SCALE, MAX_EDGE_PX / Math.max(wPt, hPt))
  const viewport = page.getViewport({ scale })
  const w = Math.ceil(wPt * scale)
  const h = Math.ceil(hPt * scale)
  if (w <= 0 || h <= 0) return null

  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  // White, not transparent: a PNG with an alpha channel renders as black in
  // some viewers, and a table read against black is a table not read.
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  // PDF space has y growing UP from the page's own bottom-left; a canvas has y
  // growing DOWN from the top-left. Translating by the region's TOP edge —
  // measured from the page top — is what puts the crop at the canvas origin.
  //
  // Both edges are taken RELATIVE TO THE VIEW BOX, because that is where the
  // rendered page actually starts. Measuring from the origin instead assumes a
  // crop box flush with it, which is false for two of the five publishers here:
  // the offset silently slid every crop up the page by 10 to 39 points, and on
  // a five-row table that is the bottom row gone.
  // pdfjs maps user space to the viewport as `x - boxX0`, `boxY1 - y`, so the
  // region's top-left lands at canvas (0, 0) when the context is translated by
  // the negation of that. `height - y` is the same expression only when the box
  // starts at the origin — which is what made this wrong on two publishers and
  // invisible on the other three.
  const [boxX0, , , boxY1] = viewport.viewBox
  ctx.translate(-(region.x0 - PAD - boxX0) * scale, (region.y1 + PAD - boxY1) * scale)
  await page.render({ canvasContext: ctx, viewport }).promise

  return {
    region,
    png: canvas.toBuffer('image/png'),
    widthPx: w,
    heightPx: h,
    // The same two numbers the translate above is built from, so a caller's box
    // and the rendered page cannot drift apart.
    scale,
    originX: region.x0 - PAD,
    originY: region.y1 + PAD
  }
}
