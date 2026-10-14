// Turning a scanned PDF page into a bitmap tesseract can read, with NO new
// shipped payload.
//
// The obvious tool is `pdftoppm`, and the research measured it at ~2 s/page.
// It is also a second non-npm executable to fetch, hash, sign and notarize for
// three platforms — for a stage that is already optional. It is not needed:
// measured on this corpus's actual scan (work 16, a 1996 Nature paper), every
// page is a SINGLE full-page image XObject, 4888x6704, `kind = GRAYSCALE_1BPP`,
// 4 096 144 bytes = ceil(4888/8) * 6704 exactly. pdfjs — already a dependency,
// already the offline extraction path — decodes it in pure JS.
//
// So this module reads the page's operator list, takes its largest image,
// unpacks it to 8-bit grayscale, box-downsamples to a target long edge, and
// encodes a BMP. BMP because it is ~40 lines with no dependency and tesseract
// reads it natively; a PNG would mean an encoder (a new dependency) or a
// deflate stream to own, for bytes that live for one call.
//
// The honest limit, stated rather than discovered later: a page whose content
// is VECTOR — a born-digital page with no text layer, which is rare but real —
// has no image to take, and this returns null for it. The stage reports that
// page as unread rather than pretending it was blank.

/** pdfjs's `ImageKind` values. Named here so the unpack switch reads. */
const GRAYSCALE_1BPP = 1
const RGB_24BPP = 2
const RGBA_32BPP = 3

/**
 * The long edge a page is scaled to before OCR.
 *
 * ~300 dpi on a US-Letter page, which is the resolution the research measured
 * at 12.5 s/page and 89 % confidence. The source scan here is 4888x6704 — about
 * 600 dpi — and OCR'ing that costs four times the pixels for no accuracy gain,
 * because tesseract's own models are trained around 300 dpi. Verified on work
 * 16: 11.7 s/page and 89 % confidence at this size.
 */
export const RASTER_LONG_EDGE = 2200

/**
 * How long to wait for one decoded image object before giving up on it.
 *
 * Generous — decoding a 33-megapixel scan is real work — but finite: an object
 * that never resolves must become a reported unreadable page rather than a
 * stage that hangs with no way to say where.
 */
const OBJECT_WAIT_MS = 120_000

/**
 * A PDF transformation matrix `[a, b, c, d, e, f]`, in pdfjs's argument order.
 *
 * Maps `(x, y)` to `(a·x + c·y + e, b·x + d·y + f)`.
 */
export type Matrix = [number, number, number, number, number, number]

export interface PageBitmap {
  width: number
  height: number
  /** An 8-bit grayscale BMP, ready to hand to tesseract. */
  bmp: Buffer
  /**
   * Where this bitmap SITS on the page, in PDF user space.
   *
   * The transform in effect when the image was painted. PDF draws an image into
   * the UNIT SQUARE, so `placement` maps `(u, v) ∈ [0,1]²` — u rightwards, v
   * upwards — onto the page. A raster pixel `(px, py)` (py measured DOWNWARDS,
   * as image rows are stored) therefore sits at `u = px/width`,
   * `v = 1 - py/height`.
   *
   * Carried because the scan is NOT flush with the page. On this corpus's one
   * scanned paper the image occupies user-space x ∈ [0, 586], y ∈ [0, 804]
   * while the crop box is 581.1 wide and starts at y = 10.29 — so assuming the
   * raster fills the rendered page box puts every recognised word 5–10 px off
   * its glyphs at scale 1, and proportionally further out at zoom. Text that
   * selects but sits beside the letters is worse than no text layer, because it
   * looks correct.
   */
  placement: Matrix
}

interface PdfImage {
  width: number
  height: number
  kind?: number
  data?: Uint8Array | Uint8ClampedArray
}

/**
 * Unpack a pdfjs image object to one byte per pixel, 0 = black.
 *
 * Returns null for a kind we cannot read rather than guessing: a
 * misinterpreted buffer produces a plausible-looking bitmap of noise, which
 * tesseract would then read as text. An unreadable page must be REPORTED.
 */
function toGray(img: PdfImage): Uint8Array | null {
  const { width: w, height: h, data, kind } = img
  if (!data) return null
  const out = new Uint8Array(w * h)
  switch (kind) {
    case GRAYSCALE_1BPP: {
      // Packed MSB-first, one row padded to a byte boundary. In pdfjs's
      // 1-bpp output a set bit is WHITE.
      const rowBytes = Math.ceil(w / 8)
      if (data.length < rowBytes * h) return null
      for (let y = 0; y < h; y++) {
        const rowOff = y * rowBytes
        const dst = y * w
        for (let x = 0; x < w; x++) {
          out[dst + x] = (data[rowOff + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0
        }
      }
      return out
    }
    case RGB_24BPP: {
      if (data.length < w * h * 3) return null
      for (let i = 0, p = 0; i < w * h; i++, p += 3) {
        // Rec. 601 luma. A flat mean shifts the contrast of coloured stamps and
        // marginalia enough to change what tesseract reads on a poor scan.
        out[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8
      }
      return out
    }
    case RGBA_32BPP: {
      if (data.length < w * h * 4) return null
      for (let i = 0, p = 0; i < w * h; i++, p += 4) {
        const a = data[p + 3] / 255
        const luma = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8
        // Composited onto WHITE: a transparent region of a scan is paper, and
        // compositing onto black would make every margin a solid ink block.
        out[i] = Math.round(luma * a + 255 * (1 - a))
      }
      return out
    }
    default:
      return null
  }
}

/** `a` then `b`, i.e. the matrix that applies `b` in `a`'s coordinate space. */
function concat(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5]
  ]
}

/** Box-downsample. Averaging, not nearest-neighbour: dropping pixels from a
 * 1-bpp scan destroys thin strokes and costs real recognition accuracy. */
function downsample(
  src: Uint8Array,
  w: number,
  h: number,
  dw: number,
  dh: number
): Uint8Array {
  if (dw === w && dh === h) return src
  const out = new Uint8Array(dw * dh)
  const bx = w / dw
  const by = h / dh
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * by)
    const y1 = Math.min(h, Math.max(y0 + 1, Math.floor((y + 1) * by)))
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * bx)
      const x1 = Math.min(w, Math.max(x0 + 1, Math.floor((x + 1) * bx)))
      let sum = 0
      let n = 0
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * w
        for (let xx = x0; xx < x1; xx++) {
          sum += src[row + xx]
          n++
        }
      }
      out[y * dw + x] = n > 0 ? Math.round(sum / n) : 255
    }
  }
  return out
}

/**
 * An 8-bit grayscale BMP: BITMAPINFOHEADER plus a 256-entry gray palette.
 *
 * Rows are BOTTOM-UP and padded to a 4-byte boundary — both are the BMP format,
 * not choices, and getting either wrong yields an image that decodes as a
 * sheared or vertically mirrored page which tesseract reads as gibberish.
 */
function grayBmp(width: number, height: number, gray: Uint8Array): Buffer {
  const rowStride = (width + 3) & ~3
  const pixelBytes = rowStride * height
  const paletteBytes = 256 * 4
  const offset = 14 + 40 + paletteBytes
  const buf = Buffer.alloc(offset + pixelBytes)

  buf.write('BM', 0, 'ascii')
  buf.writeUInt32LE(buf.length, 2)
  buf.writeUInt32LE(offset, 10)
  buf.writeUInt32LE(40, 14)
  buf.writeInt32LE(width, 18)
  buf.writeInt32LE(height, 22)
  buf.writeUInt16LE(1, 26)
  buf.writeUInt16LE(8, 28)
  buf.writeUInt32LE(pixelBytes, 34)
  // ~72 dpi in pixels/metre. Cosmetic for tesseract, which uses the pixel
  // dimensions, but a zero here makes some readers reject the file outright.
  buf.writeUInt32LE(2835, 38)
  buf.writeUInt32LE(2835, 42)
  buf.writeUInt32LE(256, 46)
  buf.writeUInt32LE(256, 50)
  for (let i = 0; i < 256; i++) {
    const p = 54 + i * 4
    buf[p] = i
    buf[p + 1] = i
    buf[p + 2] = i
  }
  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y) * width
    const dstRow = offset + y * rowStride
    for (let x = 0; x < width; x++) buf[dstRow + x] = gray[srcRow + x]
  }
  return buf
}

/**
 * Rasterise one page, or null when it carries no readable image.
 *
 * `page.cleanup()` is called by the CALLER, after this returns, because pdfjs
 * runs its worker in-process in Node: the decoded 32 MB bitmap lives in this
 * process's heap and is released only when the page's object store is cleared.
 * On a 300-page scan in a reused host, skipping that is an out-of-memory.
 */
export async function rasterisePage(
  pdfjs: { OPS: Record<string, number> },
  page: {
    getOperatorList: () => Promise<{ fnArray: number[]; argsArray: unknown[][] }>
    objs: { get: (name: string, cb: (v: unknown) => void) => unknown }
  },
  longEdge: number = RASTER_LONG_EDGE
): Promise<PageBitmap | null> {
  const ops = await page.getOperatorList()
  const { OPS } = pdfjs
  const names: Array<{ name: string; ctm: Matrix }> = []
  // Replay ONLY the operators that touch the current transformation matrix, so
  // each image is captured with the transform actually in effect where it was
  // painted. Anything less is a guess: `save`/`restore` nest, and a page that
  // wraps its scan in a `q … cm … Q` block would otherwise be read against the
  // identity.
  let ctm: Matrix = [1, 0, 0, 1, 0, 0]
  const ctmStack: Matrix[] = []
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i]
    if (fn === OPS.save) {
      ctmStack.push([...ctm] as Matrix)
    } else if (fn === OPS.restore) {
      ctm = ctmStack.pop() ?? [1, 0, 0, 1, 0, 0]
    } else if (fn === OPS.transform) {
      const m = ops.argsArray[i] as unknown as Matrix
      if (m && m.length === 6) ctm = concat(ctm, m)
    } else if (fn === OPS.paintFormXObjectBegin) {
      // A form XObject is a save PLUS its own matrix, and pdf.js emits it as one
      // operator rather than as `save` + `transform`. Scanner producers commonly
      // wrap the page image in one, so ignoring it would leave the placement
      // computed against the wrong transform — and the resulting text layer
      // would sit somewhere plausible and wrong, which is the outcome this
      // module is most careful to avoid.
      ctmStack.push([...ctm] as Matrix)
      const m = ops.argsArray[i]?.[0] as Matrix | undefined
      if (m && m.length === 6) ctm = concat(ctm, m)
    } else if (fn === OPS.paintFormXObjectEnd) {
      ctm = ctmStack.pop() ?? [1, 0, 0, 1, 0, 0]
    } else if (fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat) {
      // Only the ops whose first argument is an object-store NAME. Image MASKS
      // are excluded: pdfjs passes those as inline objects rather than names, and
      // a mask is a stencil for another image, not the page's content — reading
      // one as if it were the scan would OCR a silhouette.
      const arg = ops.argsArray[i]?.[0]
      if (typeof arg === 'string') names.push({ name: arg, ctm: [...ctm] as Matrix })
    }
  }
  if (names.length === 0) return null

  // The LARGEST image, because a scanned page is one full-page bitmap and
  // anything else on it is a logo or a rule. Picking the first would take a
  // publisher's header graphic and OCR that instead of the paper.
  let best: PdfImage | null = null
  let bestCtm: Matrix = [1, 0, 0, 1, 0, 0]
  for (const { name, ctm: placedAt } of names) {
    let img: PdfImage | null = null
    try {
      img = await new Promise<PdfImage | null>((resolve) => {
        // pdfjs's object store is callback-or-value depending on whether the
        // object has already resolved, so both shapes are handled. The timeout
        // is the third case: an object that never resolves at all — a mask
        // reference, or a decode that failed inside the worker — would
        // otherwise leave this awaiting forever, and a stage that hangs cannot
        // even report which page it hung on. Resolving null makes it a
        // COUNTED unreadable page instead.
        const timer = setTimeout(() => resolve(null), OBJECT_WAIT_MS)
        const settle = (v: unknown): void => {
          clearTimeout(timer)
          resolve((v as PdfImage) ?? null)
        }
        const value = page.objs.get(name, settle)
        if (value) settle(value)
      })
    } catch {
      img = null
    }
    if (!img || !img.width || !img.height) continue
    if (!best || img.width * img.height > best.width * best.height) {
      best = img
      bestCtm = placedAt
    }
  }
  if (!best) return null

  const gray = toGray(best)
  if (!gray) return null

  const scale = Math.min(1, longEdge / Math.max(best.width, best.height))
  const dw = Math.max(1, Math.round(best.width * scale))
  const dh = Math.max(1, Math.round(best.height * scale))
  const small = downsample(gray, best.width, best.height, dw, dh)
  return { width: dw, height: dh, bmp: grayBmp(dw, dh, small), placement: bestCtm }
}
