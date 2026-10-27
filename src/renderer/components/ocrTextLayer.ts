// Building a SELECTABLE text layer over a scanned page, from OCR word boxes.
//
// A scanned PDF carries no text layer, so pdf.js's `getTextContent()` returns
// nothing and the page renders as a bare image: no selection, no find-bar
// matches, no highlight targets. This module draws the missing layer from the
// geometry the `ocr` stage recovered — one absolutely-positioned span per
// recognised word, over the glyphs it was read from.
//
// The spans are built to be INDISTINGUISHABLE IN STRUCTURE from the ones pdf.js
// emits (a `.pdf-text-layer` containing transparent absolutely-positioned
// spans), because everything downstream — the whole-document index, the find
// bar, `locate()`, the band builder — walks that DOM and must not learn that
// two kinds of page exist. What it must NOT be is indistinguishable in ORIGIN:
// these characters were recognised at ~88 % confidence, not read from the
// publisher's font, so every span is marked `data-ocr` and the layer carries the
// recognition's mean confidence for anything that needs to say so.
//
// The honest limits, stated rather than discovered later:
//
//  - This is WORD geometry. A selection lands on word boundaries exactly and
//    interpolates within a word, so dragging through the middle of a long word
//    selects from a proportional position rather than from the true glyph edge.
//    Tesseract does report symbol boxes, but they are per-CHARACTER guesses on a
//    300 dpi raster, and storing four times the geometry to place a caret inside
//    a word it may have misread is precision this data does not have.
//
//  - TEXT COPIED TO THE CLIPBOARD CARRIES NO STYLING, so the warm selection
//    tint that marks these characters as recognised does not survive the copy.
//    A reader who pastes a passage from a scan into their notes holds a machine
//    reading that looks exactly like a quotation. Nothing here can fix that —
//    the clipboard has no channel for it — so the provenance is instead carried
//    where it can be: the document's OCR badge and its mean confidence, which
//    are on screen the whole time the selection is being made.

/** One recognised word, as the pipeline stored it. Raster pixels, y downwards. */
export interface OcrWordBox {
  charStart: number
  charEnd: number
  text: string
  /** The characters separating this word from the next, so a COPY keeps them. */
  gap: string
  x0: number
  y0: number
  x1: number
  y1: number
  confidence: number
}

export interface OcrPageBoxes {
  page: number
  rasterWidth: number
  rasterHeight: number
  placement: [number, number, number, number, number, number]
  words: OcrWordBox[]
}

export interface OcrBoxes {
  documentId: number
  meanConfidence: number
  pages: OcrPageBoxes[]
}

/** The part of a pdfjs viewport this module needs. */
export interface ViewportLike {
  width: number
  height: number
  scale: number
  convertToViewportPoint: (x: number, y: number) => number[]
}

/**
 * Below this a word is marked as poorly read, so a reader can see WHERE the
 * recognition struggled rather than only being told the page average.
 *
 * 70, not the run-level 60 that downgrades the whole badge: a per-word threshold
 * is answering a different question ("should I check this one against the
 * image?") and a word tesseract is only 65 % sure of is worth checking even on a
 * page whose mean is comfortable.
 */
export const WORD_LOW_CONFIDENCE = 70

/**
 * Map a raster pixel to page-viewport coordinates.
 *
 * PDF paints an image into the UNIT SQUARE, so `placement` maps `(u, v)` — u
 * rightwards, v UPWARDS — onto user space, and the viewport then maps user space
 * to rendered pixels (applying the crop box, rotation and the reader's zoom).
 * Going through both is what keeps the layer correct at every scale and on a
 * scan that is not flush with its page box; on this corpus's scanned paper the
 * image covers 586x804 while the page box is 581.1x793.71, so assuming the
 * raster fills the page puts every word off its glyphs.
 */
function mapPoint(
  page: OcrPageBoxes,
  vp: ViewportLike,
  px: number,
  py: number
): [number, number] {
  const [a, b, c, d, e, f] = page.placement
  const u = px / page.rasterWidth
  const v = 1 - py / page.rasterHeight
  const ux = a * u + c * v + e
  const uy = b * u + d * v + f
  const [vx, vy] = vp.convertToViewportPoint(ux, uy)
  return [vx, vy]
}

/**
 * Fill `container` with one transparent, selectable span per recognised word.
 *
 * Returns the number of spans drawn. Zero means the page had no geometry, and
 * the caller should leave the page as the image it already is rather than
 * showing an empty layer that swallows the pointer.
 */
export function renderOcrTextLayer(
  container: HTMLElement,
  page: OcrPageBoxes,
  vp: ViewportLike,
  meanConfidence: number
): number {
  if (page.words.length === 0) return 0

  const frag = document.createDocumentFragment()
  let drawn = 0

  for (const w of page.words) {
    const text = w.text
    if (!text) continue

    // Both corners are mapped rather than one corner plus a size scaled from
    // the raster, which would be right only at scale 1 and rotation 0.
    //
    // The axis-aligned box of the two mapped corners is EXACT for a placement
    // that preserves the axes or turns them by a multiple of 90° — the two
    // points stay opposite corners — which covers every page rotation a PDF can
    // declare and every scan this is built for. An arbitrary-angle placement
    // would give the box of the diagonal, which under-covers; that is a limit
    // of this layer, not a case it silently handles.
    const [x0, y0] = mapPoint(page, vp, w.x0, w.y0)
    const [x1, y1] = mapPoint(page, vp, w.x1, w.y1)
    const left = Math.min(x0, x1)
    const top = Math.min(y0, y1)
    const width = Math.abs(x1 - x0)
    const height = Math.abs(y1 - y0)
    if (!(width > 0) || !(height > 0)) continue

    const span = document.createElement('span')
    span.textContent = text
    span.dataset.ocr = 'true'
    if (w.confidence < WORD_LOW_CONFIDENCE) span.dataset.ocrLow = 'true'
    span.style.left = `${left}px`
    span.style.top = `${top}px`
    // The font is sized to the box and then stretched to it horizontally, so the
    // invisible glyphs cover the same area as the ink beneath them. Without the
    // stretch the selection rectangle of a wide word ends well before the word
    // does, and the reader sees a highlight that stops mid-phrase.
    span.style.fontSize = `${height}px`
    span.style.lineHeight = '1'
    span.style.width = `${width}px`
    span.style.height = `${height}px`
    span.style.transformOrigin = '0 0'
    span.style.transform = `scaleX(${width / Math.max(1, measureWidth(container, text, height))})`
    frag.appendChild(span)
    // The separator that followed this word in the document, as a bare text
    // node between the spans. Absolutely positioned spans put nothing between
    // themselves, so without this a copied selection comes back as
    // `Thereactionshownin…` — a layer that reads correctly on screen and is
    // useless on the clipboard. The node is unpositioned and so occupies no
    // space; it exists only for the selection to pick up.
    if (w.gap) frag.appendChild(document.createTextNode(w.gap))
    drawn++
  }

  if (drawn === 0) return 0
  // Marked only once something was actually drawn, so the OCR styling and the
  // `data-ocr` contract never describe an empty layer.
  container.dataset.ocr = 'true'
  container.dataset.ocrConfidence = meanConfidence.toFixed(0)
  container.appendChild(frag)
  return drawn
}

/**
 * Approximate the rendered width of `text` at `fontSizePx`, for the horizontal
 * stretch.
 *
 * A shared offscreen canvas rather than a DOM measure per word: measuring in the
 * document would force a layout for every one of the ~1000 words on a page, four
 * times over on a four-page scan, on the same main thread that is rasterising
 * the pages. The font is the one the text layer actually uses, so the ratio is
 * measured rather than assumed.
 */
let measureCtx: CanvasRenderingContext2D | null = null
let measureFont: string | null = null
function measureWidth(container: HTMLElement, text: string, fontSizePx: number): number {
  if (!measureCtx) {
    const canvas = document.createElement('canvas')
    measureCtx = canvas.getContext('2d')
  }
  if (!measureCtx) return fontSizePx * text.length * 0.5
  // The family is read from the LIVE layer rather than named here. The spans
  // inherit the app's `--sans` stack, so measuring against generic `sans-serif`
  // computed every stretch from the metrics of a font that is not the one being
  // drawn — and a theme change would have silently reintroduced the error.
  if (measureFont === null) {
    measureFont = getComputedStyle(container).fontFamily || 'sans-serif'
  }
  measureCtx.font = `${fontSizePx}px ${measureFont}`
  return measureCtx.measureText(text).width || fontSizePx * text.length * 0.5
}
