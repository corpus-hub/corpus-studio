import { useCallback, useEffect, useRef, useState } from 'react'

// pdfjs-dist is ESM; resolve the worker asset to a bundled URL (offline, no CDN).
import * as pdfjs from 'pdfjs-dist'
import { getSharedPdfWorker } from '../lib/pdfWorker'
import type { PdfUnavailableReason } from '@shared/contract'
import { isContentAbsence, pdfUnavailableSentence } from '../lib/pdfAvailability'
import { canon, findScoped } from './locateInParagraph'
import {
  renderOcrTextLayer,
  type OcrBoxes,
  type ViewportLike
} from './ocrTextLayer'

/**
 * 1:1 document viewer ported from ai-detector's PdfDocView. Renders a PDF with
 * pdfjs onto canvas pages plus a selectable text layer, tracks the current page
 * from scroll, and draws evidence-span highlight boxes over matched passages
 * using a whole-document canonical text index + span-ownership band merge.
 *
 * Only change from the source: PDF bytes are sourced from
 * `window.api.readPdf(documentId)` (a `PdfReadResult`) instead of an HTTP url.
 * When it answers `ok:false` the viewer renders the state that REASON names —
 * only `none` is a fact about the paper; the other three are facts about this
 * machine and must never be shown as "abstract only".
 */
export type PdfHighlight = {
  annId: string
  /** normalized plain text of the flagged passage to locate in the page */
  text: string
  severity: string
  domain: string // "issue" | "style"
  /** CSS color for the highlight tint */
  color?: string
  /** Minimum canonical needle length required to attempt a match. Default 12. */
  minMatch?: number
  /**
   * Text of the paragraph this quote was extracted from. When present the
   * locator searches ONLY inside that paragraph, and `minMatch` is not
   * consulted: the guard exists because an unscoped short needle matches
   * everywhere, which is not true of a scoped one. This is what lets a table
   * cell of eight canonical characters anchor at all.
   */
  scopeText?: string
  /** Expected fractional position in the document (0..1) to disambiguate repeats. */
  frac?: number
  /** Geometric region anchor (page-number glyph) — bypasses the text index. */
  region?: { band: 'top' | 'bottom'; align?: 'left' | 'center' | 'right' }
}

/**
 * One line's worth of highlight geometry, before the lines of a single evidence
 * are merged into one shape.
 */
interface LineBand {
  left: number
  top: number
  right: number
  bottom: number
  ids: Set<string>
  sev: string
  sevRank: number
  color?: string
  domain: string
  primary: string
}

/**
 * `canon` of a SINGLE code point, memoised.
 *
 * The text indexes canonicalise character by character (they must: each
 * canonical character has to keep a pointer back to the glyph that produced
 * it), and running the regex per character built and threw away one string for
 * every character of every span — ~11ms per index build on a 27-page paper,
 * paid again on every progressive-publish bump, competing with the
 * rasterization it was waiting on.
 *
 * A cache rather than a cheaper approximation: `canon(ch)` is NOT simply
 * `ch.toLowerCase()`. `İ` lowercases to `i` plus a combining dot, which canon
 * then strips, so guessing the length desynchronises the offset arrays from
 * `globalText`. A document draws on a few hundred distinct code points, so the
 * map is warm almost immediately and stays correct by construction.
 */
const canonCharCache = new Map<string, string>()
function canonChar(ch: string): string {
  let c = canonCharCache.get(ch)
  if (c === undefined) {
    c = canon(ch)
    canonCharCache.set(ch, c)
  }
  return c
}

/** Horizontal breathing room so the tint clears the glyph edges. */
const HL_PAD_X = 4
/** Corner rounding of the merged outline. Clamped per-corner below. */
const HL_RADIUS = 5

/**
 * Render ONE evidence passage as ONE shape.
 *
 * A quote almost never respects line breaks, so drawing a rectangle per line
 * was wrong twice over: it read as several separate findings, and — because the
 * layer composites with `mix-blend-mode: multiply` — every overlapping edge
 * multiplied twice and left a dark seam across the passage.
 *
 * The lines are instead traced as a SINGLE closed polygon (down the right-hand
 * edges, back up the left), so the fill is painted exactly once and the
 * staircase between lines of differing length is preserved rather than being
 * flattened into one big box that would cover untouched text. Corners are
 * rounded by whichever is smaller: the radius, or half the edge it sits on —
 * so a short final line cannot produce a malformed curve.
 */
function emitShape(
  pi: number,
  run: LineBand[],
  bandsForId: Map<string, HTMLElement[]>,
  getLayer: (pi: number) => HTMLElement
): void {
  // The strongest severity in the run owns the colour and the primary id, so a
  // merged shape is never tinted weaker than its most severe line.
  let head = run[0]
  const ids = new Set<string>()
  for (const b of run) {
    for (const id of b.ids) ids.add(id)
    if (b.sevRank > head.sevRank) head = b
  }

  // Vertically ADJOIN the lines (meet at the midpoint of the leading) instead
  // of padding each one: padding is what made consecutive lines overlap.
  const rects = run.map((b, i) => {
    const prev = run[i - 1]
    const next = run[i + 1]
    const top = prev ? (prev.bottom + b.top) / 2 : b.top - 1
    const bottom = next ? (b.bottom + next.top) / 2 : b.bottom + 1
    return {
      left: Math.max(0, b.left - HL_PAD_X),
      right: b.right + HL_PAD_X,
      top,
      bottom
    }
  })

  const minLeft = Math.min(...rects.map((r) => r.left))
  const minTop = Math.min(...rects.map((r) => r.top))
  const maxRight = Math.max(...rects.map((r) => r.right))
  const maxBottom = Math.max(...rects.map((r) => r.bottom))
  const w = maxRight - minLeft
  const h = maxBottom - minTop

  // Trace the outline: right edges top-to-bottom, then left edges bottom-to-top.
  const pts: { x: number; y: number }[] = []
  for (const r of rects) {
    pts.push({ x: r.right - minLeft, y: r.top - minTop })
    pts.push({ x: r.right - minLeft, y: r.bottom - minTop })
  }
  for (let i = rects.length - 1; i >= 0; i--) {
    const r = rects[i]
    pts.push({ x: r.left - minLeft, y: r.bottom - minTop })
    pts.push({ x: r.left - minLeft, y: r.top - minTop })
  }

  // Drop duplicate AND collinear points. Without this, lines of equal width
  // leave a redundant vertex mid-edge, and the corner-rounding below would try
  // to curve a straight run — so two equal lines must collapse to a plain
  // rectangle, not a 6-point path with a nick in each side.
  const dedup: { x: number; y: number }[] = []
  for (const p of pts) {
    const last = dedup[dedup.length - 1]
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue
    dedup.push(p)
  }
  if (
    dedup.length > 1 &&
    Math.abs(dedup[0].x - dedup[dedup.length - 1].x) < 0.01 &&
    Math.abs(dedup[0].y - dedup[dedup.length - 1].y) < 0.01
  ) {
    dedup.pop()
  }
  const clean = dedup.filter((p, i) => {
    const prev = dedup[(i - 1 + dedup.length) % dedup.length]
    const next = dedup[(i + 1) % dedup.length]
    // Cross product of the incoming and outgoing edges: ~0 means p sits on a
    // straight run and contributes nothing to the outline.
    const cross = (p.x - prev.x) * (next.y - p.y) - (p.y - prev.y) * (next.x - p.x)
    return Math.abs(cross) > 0.01
  })

  const n = clean.length
  let d = ''
  for (let i = 0; i < n; i++) {
    const prev = clean[(i - 1 + n) % n]
    const p = clean[i]
    const next = clean[(i + 1) % n]
    const inLen = Math.hypot(p.x - prev.x, p.y - prev.y)
    const outLen = Math.hypot(next.x - p.x, next.y - p.y)
    const r = Math.min(HL_RADIUS, inLen / 2, outLen / 2)
    if (r < 0.5) {
      d += `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)} `
      continue
    }
    const t1 = { x: p.x + ((prev.x - p.x) / inLen) * r, y: p.y + ((prev.y - p.y) / inLen) * r }
    const t2 = { x: p.x + ((next.x - p.x) / outLen) * r, y: p.y + ((next.y - p.y) / outLen) * r }
    d += `${i === 0 ? 'M' : 'L'}${t1.x.toFixed(2)},${t1.y.toFixed(2)} `
    d += `Q${p.x.toFixed(2)},${p.y.toFixed(2)} ${t2.x.toFixed(2)},${t2.y.toFixed(2)} `
  }
  d += 'Z'

  const layer = getLayer(pi)
  // The host stays a plain positioned div so the existing hit-test, focus and
  // scroll-into-view logic (which read .pdf-hl bounding rects and dataset ids)
  // keep working unchanged.
  const box = document.createElement('div')
  box.className = 'pdf-hl'
  box.dataset.annId = head.primary
  box.dataset.annIds = [...ids].join(' ')
  box.dataset.sev = head.sev
  box.dataset.domain = head.domain
  if (head.color) box.style.setProperty('--hl-color', head.color)
  box.style.left = `${minLeft}px`
  box.style.top = `${minTop}px`
  box.style.width = `${w}px`
  box.style.height = `${h}px`

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', `0 0 ${w.toFixed(2)} ${h.toFixed(2)}`)
  svg.setAttribute('preserveAspectRatio', 'none')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', d.trim())
  svg.appendChild(path)
  box.appendChild(svg)

  layer.appendChild(box)
  for (const id of ids) {
    const a = bandsForId.get(id)
    if (a) a.push(box)
    else bandsForId.set(id, [box])
  }
}

/** Zoom bounds/step shared with the toolbar that drives the `scale` prop. */
/**
 * One hit from an in-document text search.
 *
 * `annId` is a synthetic id in the same namespace the highlight machinery
 * already uses, so a find result is drawn and scrolled to by exactly the same
 * code path as an evidence span — there is no second highlighting engine to
 * keep consistent with the first.
 */
export type PdfFindHit = {
  annId: string
  /** 1-based page the hit starts on, for the "3 of 17 · page 4" readout. */
  page: number
  /** The matched text as it appears in the document, for the result list. */
  text: string
  /**
   * Where this hit sits in the document (0..1), handed back to the viewer as
   * `PdfHighlight.frac`. A query whose text repeats — a running header, a
   * recurring phrase — otherwise resolves against the locator's running cursor,
   * so several hits would collapse onto the same occurrence.
   */
  frac: number
}

/**
 * Search the rendered document for a literal string.
 *
 * Matching runs over the SAME canonical index the evidence-span locator uses
 * (case- and punctuation-insensitive, whitespace collapsed), so a query pasted
 * out of a PDF still matches when the source has a line break or a ligature
 * where the query does not.
 */
/**
 * Whether the document's text is answerable yet, and whether it ever will be.
 *
 * `pending` is a WAIT — pages are still rasterizing, and a question asked now
 * would be answered from a prefix of the document. `ready` means the whole
 * text layer is indexed and an answer is final. `unavailable` is a settled NO:
 * the bytes are missing or the render failed, so waiting will not help.
 */
export type PdfTextState = 'pending' | 'ready' | 'unavailable'

export type PdfFindApi = {
  find: (query: string) => PdfFindHit[]
  /**
   * Locate MANY candidate passages against ONE index build.
   *
   * Exists because a caller with hundreds of candidate passages (the citation
   * contexts of a paper) has to know which of them are actually reachable
   * BEFORE it renders them: a card that offers to jump somewhere and then draws
   * nothing is the failure this repo treats as production-blocking. Calling
   * `find` in a loop would answer the same question, but it rebuilds the whole
   * text index per call — 1200 walks of every span in the document.
   *
   * Returns null for a passage that cannot be found, and otherwise its
   * fractional position, which the caller hands straight back as
   * `PdfHighlight.frac`. That round trip is what makes the highlight land on
   * the occurrence the probe actually found: a bibliography line or a stock
   * sentence can appear several times, and without it the locator resolves
   * whichever copy follows its running cursor — a different one depending on
   * which analysis run happens to be selected.
   *
   * `near` is the 1-based page the caller believes the passage sits on. When
   * given, the nearest occurrence to that page wins, so the stored page is used
   * for what it is good for (disambiguation) without being trusted as an anchor
   * in its own right.
   */
  probe: (queries: Array<{ text: string; near?: number | null }>) => Array<number | null>
}

export const PDF_MIN_SCALE = 0.6
export const PDF_MAX_SCALE = 2.5
export const PDF_SCALE_STEP = 0.2
export const PDF_DEFAULT_SCALE = 1.35

/**
 * How much canvas backing store one open document may hold, in bytes.
 *
 * Canvas memory is a hard, process-wide limit, and running into it does not
 * throw: `getContext('2d')` returns null and the page is left an empty white
 * sheet. So the resident set has to be BUDGETED rather than trusted to be small,
 * and the budget has to be in bytes rather than in pages — a letter page is
 * ~13 MB at scale 1 and DPR 2, but ~48 MB at the 2.5 maximum zoom, so a
 * fixed page count means an eightfold difference in what a document actually
 * holds depending on how far the reader has zoomed in.
 *
 * 160 MB is roughly five pages at the default zoom and three at the maximum,
 * which is enough for the reader to always be looking at a painted page while
 * leaving room for several documents to be open at once.
 */
const PAINT_BUDGET_BYTES = 160 * 1024 * 1024

/**
 * The most pages either side of the reading position that may hold a canvas.
 *
 * The budget above decides how many pages fit; this caps how far the band
 * reaches even when they are small, because a page more than two away is one the
 * reader cannot reach before it can be painted.
 */
const PAINT_BAND_MAX = 2

type PdfDocumentProxy = {
  numPages: number
  getPage: (n: number) => Promise<{
    getViewport: (o: { scale: number }) => {
      width: number
      height: number
      scale: number
      convertToViewportPoint: (x: number, y: number) => number[]
    }
    render: (o: { canvasContext: CanvasRenderingContext2D; viewport: unknown }) => {
      promise: Promise<void>
      cancel: () => void
    }
    getTextContent: () => Promise<unknown>
  }>
  /** Releases the parsed document heap in both this thread and the worker. */
  destroy: () => Promise<void>
  /** Drops pdfjs's own cache of already-parsed page objects. */
  cleanup: () => void
}

export function PdfDocView({
  documentId,
  scrollRef,
  scale = PDF_DEFAULT_SCALE,
  pages,
  highlights = [],
  active,
  onHighlightClick,
  onAnchoredIds,
  onFindApi,
  onTextState
}: {
  documentId: number
  scrollRef: React.RefObject<HTMLDivElement>
  /** pdfjs render scale. Changing it re-renders every page AND re-locates every
   *  highlight (the geometry index is keyed by the render generation). */
  scale?: number
  /**
   * Render ONLY these page numbers, in document order.
   *
   * For a caller showing WHERE a value came from: the rest of the paper is not
   * evidence of anything and a reader handed twenty pages has to find the one
   * that matters. Omit for the whole document, which is what the paper viewer
   * wants.
   */
  pages?: number[]
  highlights?: PdfHighlight[]
  active?: string | null
  onHighlightClick?: (annIds: string[], rect: DOMRect) => void
  /** Reports the set of annIds that ACTUALLY resolved to a drawn box. */
  onAnchoredIds?: (ids: Set<string>) => void
  /**
   * Hands the parent a search function once the document text is readable, and
   * null when it is not (still loading, or a document with no text layer).
   *
   * A callback rather than a ref handle so the parent is TOLD when searching
   * becomes possible: a find bar that silently returns nothing while the PDF is
   * still rendering is indistinguishable from one that is broken.
   */
  onFindApi?: (api: PdfFindApi | null) => void
  /**
   * Whether the document's text can be reasoned about YET, and whether it ever
   * will be.
   *
   * `onFindApi(null)` conflates two very different answers — "still rendering"
   * and "there is nothing here to search" — and a caller that has to decide
   * between an honest wait and an honest refusal cannot tell them apart. A
   * document whose bytes are missing, or that failed to render, reports
   * `unavailable` and stays there; anything else resolves to `ready`. Without
   * this a broken PDF left every card that depends on the text in a permanent
   * "locating…" state, which is a wait that never ends.
   */
  onTextState?: (state: PdfTextState) => void
}): JSX.Element {
  const pagesHostRef = useRef<HTMLDivElement | null>(null)
  const [doc, setDoc] = useState<PdfDocumentProxy | null>(null)
  // Word geometry for a SCANNED document, or null when the PDF has a real text
  // layer (the common case) or was OCR'd before geometry was captured.
  const [ocr, setOcr] = useState<OcrBoxes | null>(null)
  const [numPages, setNumPages] = useState(0)
  /** Stable identity for `pages` — the array is rebuilt on every parent render. */
  const pagesKey = pages?.join(',') ?? ''
  const [currentPage, setCurrentPage] = useState(1)
  const currentPageRef = useRef(1)
  const [error, setError] = useState<string | null>(null)
  /**
   * WHY there are no bytes, when there are none.
   *
   * Separate from `error`, which describes a document that arrived and would
   * not render. This one says whether the corpus has a document at all — and
   * only `none` licenses the "metadata / abstract only" claim.
   */
  const [unavailable, setUnavailable] = useState<PdfUnavailableReason | null>(null)
  /**
   * Bumped by "Try again". A retry is only offered for the reasons that name a
   * condition on THIS machine — a reconnected drive, a fixed permission — so
   * the read has to be able to run a second time for the same document id.
   */
  const [reloadNonce, setReloadNonce] = useState(0)
  const [loading, setLoading] = useState(true)
  const [textReady, setTextReady] = useState(0)
  // Bumped after every band build. The expensive draw effect no longer depends
  // on `active` (that used to re-locate every span on each selection change and
  // recreate the boxes under the focus/scroll effects); instead the cheap focus
  // + scroll effects below re-run on [active, bandsVersion] and simply toggle
  // classes on the bands that already exist.
  const [bandsVersion, setBandsVersion] = useState(0)
  // True once the document is fully rendered AND the anchored set has been
  // reported, i.e. the traceable/un-traceable state of every claim is final.
  // These are two distinct moments: `loading` goes false when the last page
  // rasterizes, but the locator then runs a chunked rAF pass before it can say
  // which quotes were found. Anything reasoning about the FINAL state has to
  // wait for the second, so it gets its own flag rather than reusing `loading`.
  const [settled, setSettled] = useState(false)

  // ---- load the document ONCE per documentId (zoom must not re-read bytes) ----
  useEffect(() => {
    let cancelled = false
    // The loading TASK, not the document: destroying the task both aborts a
    // load still in flight and releases a completed one, so the unmount path is
    // the same whether the bytes had finished parsing or not.
    let task: { promise: Promise<unknown>; destroy: () => Promise<void> } | null = null
    setDoc(null)
    setOcr(null)
    setLoading(true)
    setError(null)
    setUnavailable(null)

    void (async () => {
      try {
        // Fetched WITH the bytes, not after them, so a scan never renders a
        // frame without its text layer: arriving late would mean the whole-
        // document index is built from empty pages, every quote reports as
        // un-anchorable, and the reader watches the evidence appear a second
        // later. Null for every ordinary document, which costs one cheap query.
        const [read, boxes] = await Promise.all([
          window.api.readPdf(documentId),
          window.api.readOcrWordBoxes(documentId).catch(() => null)
        ])
        if (cancelled) return
        setOcr(boxes as OcrBoxes | null)
        if (!read.ok) {
          setUnavailable(read.reason)
          setLoading(false)
          return
        }
        const bytes = read.bytes
        // Copy into a fresh ArrayBuffer pdfjs can take ownership of.
        const data = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes)
        task = pdfjs.getDocument({
          data,
          worker: getSharedPdfWorker()
        } as unknown as Parameters<typeof pdfjs.getDocument>[0]) as unknown as typeof task
        const loaded = (await task!.promise) as unknown as PdfDocumentProxy
        // A cancel that lands between the await resolving and the state write
        // would otherwise leak the whole parsed document: the cleanup below has
        // already run, so nothing else will ever destroy it.
        if (cancelled) {
          void task!.destroy()
          return
        }
        setDoc(loaded)
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e))
          setLoading(false)
        }
      }
    })()

    return () => {
      cancelled = true
      // The render pass is stopped BEFORE the document goes, because destroying
      // it leaves the pass's outstanding worker requests unsettled — the loop
      // would hang mid-await, retaining its host element and every page built so
      // far for the life of the renderer.
      abandonPassRef.current?.()
      // Destroying the loading task releases the parsed document in both this
      // thread and the worker: page trees, font programs, decoded images. The
      // shared worker survives it, because pdfjs only tears down a worker it
      // created for itself.
      if (task) void task.destroy()
    }
  }, [documentId, reloadNonce])

  /**
   * Per-page render bookkeeping for the band.
   *
   * Held in a ref rather than state because painting and releasing a canvas is a
   * DOM mutation on elements this component builds imperatively — routing it
   * through React would mean re-rendering the viewer on every scroll tick.
   */
  type PageRec = {
    /** The page box, which carries the paint-failure attribute for the reader. */
    el: HTMLElement
    canvas: HTMLCanvasElement
    page: Awaited<ReturnType<PdfDocumentProxy['getPage']>>
    viewport: { width: number; height: number; scale: number }
    dpr: number
    /** Bytes of backing store this page costs while it holds one. */
    bytes: number
    /** Non-null while a paint is in flight, so a release can cancel it. */
    task: { promise: Promise<void>; cancel: () => void } | null
    painted: boolean
  }
  /**
   * Abandons the render pass currently in flight, if there is one.
   *
   * Reachable from OUTSIDE that effect because the load effect has to be able to
   * call it: when `documentId` changes, React runs the load effect's cleanup —
   * which destroys the document — while the render effect's deps (`doc`) are
   * still unchanged, so its cleanup has not run and its loop is mid-await on a
   * worker that is about to stop answering.
   */
  const abandonPassRef = useRef<(() => void) | null>(null)
  const pagesRef = useRef<Map<number, PageRec>>(new Map())
  /** Bumped by every full re-render pass; stale paints check it and bail. */
  const paintGenRef = useRef(0)

  /**
   * Free page `n`'s backing store, cancelling a paint that is still running.
   *
   * Zeroing both dimensions is what actually returns the memory: a canvas
   * bitmap is external to the JS heap, so dropping the element merely makes it
   * garbage the collector is in no hurry to reach. pdfjs's own viewer does the
   * same thing for the same reason. The element and its CSS box stay, so the
   * document's scroll height never changes and no highlight moves.
   *
   * `page.cleanup()` releases what the canvas is only half of: the page's
   * operator list and its decoded images, which on a figure-heavy paper are the
   * larger share. It is safe to call repeatedly and the page re-parses on the
   * next render.
   */
  const releasePage = useCallback((n: number): void => {
    const rec = pagesRef.current.get(n)
    if (!rec) return
    rec.task?.cancel()
    rec.task = null
    rec.painted = false
    rec.canvas.width = 0
    rec.canvas.height = 0
    delete rec.el.dataset.paintFailed
    try {
      rec.page.cleanup()
    } catch {
      // cleanup() throws if the page is already destroyed, which is exactly the
      // case where there is nothing left to release.
    }
  }, [])

  /**
   * Allocate the backing store and rasterize page `n`, unless it already holds
   * pixels or a paint for it is already in flight.
   *
   * `gen` is the render pass that asked. A zoom or a new document bumps the
   * generation, and a paint that resolves afterwards is writing into a canvas
   * that has been detached — it must not mark the record painted, or the page
   * the reader is actually looking at would stay blank while claiming to be
   * drawn.
   */
  const paintPage = useCallback(async (n: number, gen: number): Promise<void> => {
    const rec = pagesRef.current.get(n)
    if (!rec || rec.painted || rec.task) return
    const { canvas, viewport, dpr } = rec
    canvas.width = Math.floor(viewport.width * dpr)
    canvas.height = Math.floor(viewport.height * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      // Canvas memory is exhausted. There is nothing to retry and nothing to
      // draw, so the page is MARKED: an unannounced empty sheet is
      // indistinguishable from a genuinely blank page, and a reader comparing a
      // quote against it would conclude the passage is not there.
      canvas.width = 0
      canvas.height = 0
      rec.el.dataset.paintFailed = ''
      return
    }
    // Explicit rather than `ctx.scale`, which COMPOSES: a retry after a cancelled
    // paint re-assigns the same width and height, and whether that resets the
    // context is a detail of the spec this does not need to depend on.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    delete rec.el.dataset.paintFailed
    const task = rec.page.render({ canvasContext: ctx, viewport })
    rec.task = task
    try {
      await task.promise
      if (paintGenRef.current !== gen) return
      rec.painted = true
    } catch {
      // A cancelled render rejects; the record stays unpainted and is retried
      // the next time the page enters the band.
    } finally {
      if (rec.task === task) rec.task = null
    }
  }, [])

  /**
   * Which pages should hold a canvas right now, nearest the reader first and
   * stopping at the byte budget.
   *
   * Nearest-first matters when the budget binds: at maximum zoom it admits three
   * pages rather than five, and the three it must admit are the one being read
   * and its immediate neighbours.
   */
  const bandPages = useCallback((cur: number): Set<number> => {
    const keep = new Set<number>()
    let bytes = 0
    for (let d = 0; d <= PAINT_BAND_MAX; d++) {
      for (const n of d === 0 ? [cur] : [cur - d, cur + d]) {
        const rec = pagesRef.current.get(n)
        if (!rec) continue
        if (bytes + rec.bytes > PAINT_BUDGET_BYTES && keep.size > 0) return keep
        bytes += rec.bytes
        keep.add(n)
      }
    }
    return keep
  }, [])

  // ---- render every page at the CURRENT scale ----
  // Re-runs on zoom. Because `textReady` is bumped at the end, the highlight
  // draw effect's geometry index + locate cache (both keyed by `textReady`)
  // are invalidated and every band is re-measured against the new layout —
  // this is what keeps evidence highlights anchored across a zoom.
  useEffect(() => {
    if (!doc) return
    let cancelled = false
    const host = pagesHostRef.current
    if (!host) return
    const scroll = scrollRef.current
    // preserve the reading position across the re-render
    const prevFrac =
      scroll && scroll.scrollHeight > scroll.clientHeight
        ? scroll.scrollTop / (scroll.scrollHeight - scroll.clientHeight)
        : 0
    host.replaceChildren()
    // Every record points at elements that were just detached, and any paint
    // still running would draw into an orphan canvas. Each one is RELEASED
    // rather than merely dropped: a detached canvas still holds its bitmap, so
    // stepping the zoom from 1.35 to 2.5 would queue six passes' worth of
    // backing store as garbage the collector has no pressure to reach.
    const gen = ++paintGenRef.current
    for (const n of [...pagesRef.current.keys()]) releasePage(n)
    pagesRef.current.clear()
    setLoading(true)
    // A new document (or a zoom) invalidates the previous verdict: every band
    // is about to be re-measured, so nothing may claim to be settled until that
    // finishes. Without this a reader — or a spec — would act on the OLD
    // document's anchoring while the new one is still rendering.
    setSettled(false)

    /**
     * Rejects when this pass is abandoned, so every worker await can be raced
     * against it.
     *
     * Destroying a document does NOT settle the requests already in flight to
     * the worker — pdfjs clears its pending map without resolving or rejecting
     * them. So a `getPage` or `getTextContent` outstanding at that moment would
     * never return, this loop would never reach its next statement, and its
     * closure would pin the host element, the document and every page built so
     * far for as long as the renderer lived. One retained pass per document
     * switch is the same leak this file's `destroy()` exists to close.
     */
    // Captured from the executor rather than read back off the ref, and this is
    // not a style choice. The Promise executor runs synchronously so the ref IS
    // assigned by the next line — but its type is `(() => void) | null`, so the
    // cleanup below was calling a value the compiler could not prove was there,
    // and the day something reassigns the ref between these two statements the
    // cleanup throws INSIDE React's unmount: the pass is never abandoned, its
    // closure pins the document and every page rendered so far, and the reader
    // is left with a half-torn-down view. Naming the function first makes it a
    // value, not a lookup.
    let rejectPass: (err: Error) => void = () => {}
    const abandoned = new Promise<never>((_, reject) => {
      rejectPass = reject
    })
    const abandon = (): void => {
      rejectPass(new Error('__abandoned__'))
    }
    abandonPassRef.current = abandon
    // Nothing awaits `abandoned` on its own, and an unobserved rejection would be
    // reported as unhandled the moment the pass finishes normally.
    abandoned.catch(() => {})
    const until = <T,>(p: Promise<T>): Promise<T> => Promise.race([p, abandoned])

    void (async () => {
      try {
        setNumPages(doc.numPages)
        const dpr = Math.min(2, window.devicePixelRatio || 1)
        const RENDER_SCALE = scale
        // Long enough that the republish cost stays a small fraction of render
        // time on a long document, short enough that a reader scrolling ahead
        // of the renderer never waits noticeably for the next band to appear.
        const PUBLISH_INTERVAL_MS = 400
        let lastPublish = 0

        const wanted = pages && pages.length > 0 ? pages.filter((n) => n >= 1 && n <= doc.numPages) : null
        for (const n of wanted ?? Array.from({ length: doc.numPages }, (_, i) => i + 1)) {
          if (cancelled) return
          const page = await until(doc.getPage(n))
          const viewport = page.getViewport({ scale: RENDER_SCALE })

          const pageEl = document.createElement('div')
          pageEl.className = 'pdf-page'
          pageEl.dataset.page = String(n)
          pageEl.style.width = `${viewport.width}px`
          pageEl.style.height = `${viewport.height}px`

          // Sized in CSS pixels only. The BACKING store (`canvas.width/height`)
          // is allocated by `paintPage` when the page enters the band and freed
          // when it leaves, so the page keeps its box — and therefore the
          // document's scroll height and every highlight's geometry — whether or
          // not it currently holds pixels.
          const canvas = document.createElement('canvas')
          canvas.className = 'pdf-canvas'
          canvas.style.width = `${viewport.width}px`
          canvas.style.height = `${viewport.height}px`
          pageEl.appendChild(canvas)
          // A pass that has been superseded must not write into the map: the new
          // pass has already cleared it and may have registered its own record
          // for this page, and overwriting that would leave the map pointing at a
          // DETACHED canvas — which the band would then dutifully paint while the
          // page the reader is looking at stayed blank.
          if (paintGenRef.current !== gen) return
          pagesRef.current.set(n, {
            el: pageEl,
            canvas,
            page,
            viewport,
            dpr,
            bytes: Math.floor(viewport.width * dpr) * Math.floor(viewport.height * dpr) * 4,
            task: null,
            painted: false
          })

          const textLayer = document.createElement('div')
          textLayer.className = 'pdf-text-layer'
          textLayer.style.width = `${viewport.width}px`
          textLayer.style.height = `${viewport.height}px`
          textLayer.style.setProperty('--scale-factor', String(viewport.scale))
          // The page box, for the ROTATED-page rules in the stylesheet.
          //
          // On a /Rotate 90 page (page 4 of the KE07 series paper is one) pdf.js
          // positions the text spans in UNROTATED page space and expects CSS to
          // turn the layer upright — so the layer must be sized with width and
          // height SWAPPED relative to the page box it sits in, then rotated.
          // These two properties are the only way the stylesheet can know that
          // box: the element's own width/height are what the rule overrides.
          textLayer.style.setProperty('--rot-w', `${viewport.width}px`)
          textLayer.style.setProperty('--rot-h', `${viewport.height}px`)
          pageEl.appendChild(textLayer)

          // Present but invisible until the page actually fails to paint, so the
          // notice does not have to be created at the moment memory is scarcest.
          // `role="status"` rather than `alert`: this is a condition of one page in
          // a long document, not an interruption.
          const paintNotice = document.createElement('div')
          paintNotice.className = 'pdf-paint-failed'
          paintNotice.setAttribute('role', 'status')
          paintNotice.textContent =
            'This page could not be drawn — the viewer is out of image memory. ' +
            'Its text is still selectable and searchable. Zooming out, or closing ' +
            'another paper, frees enough memory to draw it.'
          pageEl.appendChild(paintNotice)

          host.appendChild(pageEl)

          // Only the band is rasterized, and through `bandPages` so the BYTE budget
          // applies here too — at maximum zoom five pages exceed it, and painting
          // them anyway during the first pass would run the allocator dry in exactly
          // the situation the budget exists for.
          //
          // The text layer below is built for EVERY page regardless: the
          // whole-document canonical index, `locate()` and find all read the text
          // spans, and an index over a subset of pages would report every quote
          // outside the band as un-anchorable.
          if (bandPages(currentPageRef.current).has(n)) {
            await until(paintPage(n, gen))
          }
          if (cancelled) return

          try {
            const textContent = await until(page.getTextContent())
            const { TextLayer } = pdfjs as unknown as {
              TextLayer: new (o: {
                textContentSource: unknown
                container: HTMLElement
                viewport: unknown
              }) => { render: () => Promise<void> }
            }
            const tl = new TextLayer({ textContentSource: textContent, container: textLayer, viewport })
            await until(tl.render())
          } catch (e) {
            // The text layer is a progressive enhancement, so a page whose text
            // cannot be built still renders as an image — but an ABANDONED pass
            // is not a text-layer failure, and swallowing it here would let the
            // loop carry on building pages into a detached host.
            if (e instanceof Error && e.message === '__abandoned__') throw e
          }

          // A SCANNED page has no text layer to render, so pdf.js just left the
          // container empty. Draw one from the OCR geometry instead — but only
          // when pdf.js genuinely produced nothing, so a document that has both
          // (a scan with a publisher-added text layer) keeps the authoritative
          // characters rather than the recognised ones.
          if (ocr && textLayer.childElementCount === 0) {
            const geom = ocr.pages.find((p) => p.page === n)
            if (geom) {
              try {
                renderOcrTextLayer(
                  textLayer,
                  geom,
                  viewport as unknown as ViewportLike,
                  ocr.meanConfidence
                )
              } catch {
                // Same contract as above: the page still renders as an image.
              }
            }
          }

          // Publish the pages rendered SO FAR. The highlight draw effect keys
          // its geometry index off `textReady`, so bumping it lets evidence on
          // page 1 anchor while page 18 is still rasterizing. Bumping only once
          // at the end made the wait for the FIRST highlight scale with the
          // length of the WHOLE document: on the 18-page seeded paper that was
          // ~10s, and on a slower machine long enough that a reader — and the
          // e2e suite — sees an apparently evidence-less paper. It is now ~0.9s.
          //
          // THROTTLED, because each bump rebuilds the whole-document index and
          // re-locates every highlight. Bumping on every page would make that
          // O(pages²) of main-thread layout competing with the rasterization it
          // is waiting on — trading the stall for a slower render, which is not
          // a trade worth making. The first page publishes immediately (that is
          // the whole point), then at most one republish per interval; the final
          // one is unconditional, below.
          //
          // Anchoring is NOT declared settled here: `onAnchoredIds` fires only
          // once `loading` is false, because a partial index would report the
          // not-yet-rendered spans as un-anchorable and flash every later fact
          // as untraceable.
          const nowMs = performance.now()
          if (!cancelled && (n === 1 || nowMs - lastPublish >= PUBLISH_INTERVAL_MS)) {
            lastPublish = nowMs
            setTextReady((v) => v + 1)
          }
        }
        if (!cancelled) {
          setLoading(false)
          // Restore the reading position proportionally after a zoom re-render.
          if (scroll && prevFrac > 0) {
            requestAnimationFrame(() => {
              const max = scroll.scrollHeight - scroll.clientHeight
              if (max > 0) scroll.scrollTop = prevFrac * max
            })
          }
          // Invalidates the geometry index + locate cache in the draw effect,
          // forcing every highlight band to be re-measured at the new scale.
          setTextReady((v) => v + 1)
        }
      } catch (e) {
        // An abandoned pass is not a failure of the document. Reporting it would
        // put this file's own sentinel — or pdfjs's "Page was destroyed." — in
        // front of the reader for a pass nobody is waiting on any more, and it
        // arrives on the ORDINARY path every time the reader zooms or opens
        // another paper while a render is still running.
        const abandonedPass = e instanceof Error && e.message === '__abandoned__'
        if (!cancelled && !abandonedPass) {
          setError(e instanceof Error ? e.message : String(e))
          setLoading(false)
          // The pages rendered before the failure are still in the DOM, so the
          // draw effect is about to run over them with `loading` false — i.e.
          // treat a PREFIX of the document as the whole of it. Publishing here
          // rebuilds the index over exactly what exists, so a quote on a page
          // that never rendered is reported un-anchorable (correct: it cannot
          // be shown) rather than being located against stale offsets.
          setTextReady((v) => v + 1)
        }
      }
    })()

    return () => {
      cancelled = true
      abandon()
      if (abandonPassRef.current === abandon) abandonPassRef.current = null
    }
  }, [doc, ocr, scale, scrollRef, releasePage, paintPage, bandPages, pagesKey])

  /**
   * Paint the pages within `PAINT_BAND` of the reading position and free the
   * rest. Idempotent, so it is safe to call on every scroll frame.
   */
  const syncBand = useCallback(
    (centre?: number): void => {
      const gen = paintGenRef.current
      const keep = bandPages(centre ?? currentPageRef.current)
      // Released FIRST, so the budget the new pages are about to claim is
      // actually free when they ask for it: allocating before releasing is how a
      // zoom hits the exhausted-allocator path while holding pages it is on the
      // point of discarding.
      for (const n of pagesRef.current.keys()) if (!keep.has(n)) releasePage(n)
      for (const n of keep) void paintPage(n, gen)
    },
    [bandPages, paintPage, releasePage]
  )

  // ---- track current page from scroll position, and follow it with the band --
  useEffect(() => {
    const scroll = scrollRef.current
    const host = pagesHostRef.current
    if (!scroll || !host) return
    let raf = 0
    const onScroll = (): void => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        const pages = host.querySelectorAll<HTMLElement>('.pdf-page')
        const mid = scroll.scrollTop + scroll.clientHeight / 2
        let cur = 1
        for (const el of pages) {
          if (el.offsetTop <= mid) cur = Number(el.dataset.page)
          else break
        }
        if (cur !== currentPageRef.current) {
          currentPageRef.current = cur
          setCurrentPage(cur)
          // The band follows the reader. Only on a page CHANGE: within one page
          // the resident set is already correct, and re-walking it every frame
          // would compete with the rasterization it is scheduling.
          syncBand()
        }
      })
    }
    scroll.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scroll.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [scrollRef, numPages, syncBand])

  // A finished render pass, or a restored reading position, can leave the band
  // centred somewhere other than page 1 — reconcile once the pass settles.
  useEffect(() => {
    if (loading) return
    syncBand()
  }, [loading, textReady, syncBand])

  // Releasing every canvas on unmount is not merely tidy: a suspended tab keeps
  // this component's DOM alive, and the backing stores are the bulk of its cost.
  useEffect(() => {
    const pages = pagesRef.current
    const release = releasePage
    return () => {
      for (const n of [...pages.keys()]) release(n)
      pages.clear()
    }
  }, [releasePage])

  type LocatedSpan = {
    span: HTMLElement
    pi: number
    left: number
    top: number
    width: number
    height: number
  }
  /**
   * A resolved highlight: the boxes it owns, and where it ENDED in the
   * canonical document.
   *
   * `end` is stored rather than recomputed because the document-order cursor is
   * an ABSOLUTE offset. Re-deriving it as `cursor + needle.length` is only
   * correct when the match happened to start exactly at the cursor; on any
   * redraw with a warm cache (stepping find hits, picking a citation place,
   * switching runs) it instead rewinds the cursor to near the start of the
   * document, and every later un-cached highlight then binds to an EARLIER
   * occurrence of its text.
   *
   * A `null` result means the quote was not found; a null `end` means the
   * highlight does not participate in document order at all (a geometric
   * `region` anchor, which is found by page position rather than by text).
   * Both leave the cursor where it was.
   */
  type LocateResult = { spans: LocatedSpan[]; end: number | null } | null
  const locateCacheRef = useRef<{ key: number; map: Map<string, LocateResult> }>({
    key: -1,
    map: new Map()
  })
  /**
   * The cache key for a resolved highlight: everything `locate` READS to decide
   * where the band goes, rather than the id the highlight is addressed by.
   *
   * An `annId` is a name, and only some callers give the same name to the same
   * text. `ev-<id>` does — it is a database row. But the find bar mints
   * `find:<canonical offset>`, and a reader types a query one character at a
   * time: "des", "desi" and "designed" all match at the SAME offset, all arrive
   * as `find:2234`, and the last two were then served the first one's
   * three-character band. That is the reported bug — searching "designed" and
   * seeing "des" tinted. It is not a cross-span defect (`locate` already walks
   * `globalSpan` per canonical character and unions the covered slice of every
   * span the match touches, which is why "muta-|tions" bands correctly); the
   * band was simply a stale answer to an older, shorter question.
   *
   * The same trap is set for `meaning-focus` and `cite-focus`, which are
   * deliberately FIXED ids over changing passages: picking a second semantic
   * candidate reused the first one's band.
   *
   * Keying on the resolution inputs makes a cache hit mean "this exact question
   * has already been answered", which is the only thing a cache may claim.
   *
   * `annId` REMAINS in the key wherever the answer is not a pure function of
   * the text:
   * - a `region` anchor is resolved by page position alone, so its identity is
   *   all that distinguishes two of them;
   * - a highlight with no `frac` is resolved against the running document-order
   *   cursor, so two evidence spans quoting the same sentence twice legitimately
   *   resolve to two DIFFERENT places. Sharing a key there would stack both
   *   bands on the first occurrence.
   * A `frac`-carrying highlight — every find hit, every by-meaning pick — is
   * positioned absolutely. Its `annId` is kept anyway: `frac` is a ratio
   * rendered to six places, and adjacent occurrences of one query differ by
   * `1/documentLength`, so past a million canonical characters two hits round
   * to the same key and the second band would land on the first. Retaining the
   * id costs nothing — sharing an entry between two ids was a nicety, never a
   * requirement — and keeps the key unique per occurrence at any length.
   */
  const locateKey = (hl: PdfHighlight): string =>
    hl.region
      ? `r|${hl.annId}|${hl.region.band}|${hl.region.align ?? ''}`
      : // A scoped highlight is positioned absolutely inside one paragraph, so
        // like `region` its identity and its scope are all that distinguish it.
        // The scope's LENGTH stands in for its text: a whole paragraph in every
        // key would be megabytes of string comparison per draw, and two
        // paragraphs of a document sharing both an id and a length is the case
        // the locator already refuses as ambiguous.
        hl.scopeText
        ? `s|${hl.annId}|${hl.scopeText.length}|${hl.text}`
        : typeof hl.frac === 'number'
          ? `f|${hl.annId}|${hl.minMatch ?? ''}|${hl.frac.toFixed(6)}|${hl.text}`
          : `c|${hl.annId}|${hl.minMatch ?? ''}|${hl.text}`
  type DocIndex = {
    pageEls: HTMLElement[]
    globalText: string
    globalSpan: HTMLElement[]
    globalPage: number[]
    /**
     * Where each canonical character came from in its span's RAW text, as a
     * half-open [start, end) offset into `span.textContent`.
     *
     * The canonical string drops spaces, punctuation and ligature padding, so
     * canonical position is NOT proportional to rendered position: a canonical
     * index cannot be turned back into an x-coordinate by arithmetic. Keeping
     * the raw offsets lets the highlight be measured from the glyphs themselves
     * (a DOM Range) instead of estimated.
     */
    globalRawStart: number[]
    globalRawEnd: number[]
  }
  const docIndexRef = useRef<{ key: number; idx: DocIndex | null }>({ key: -1, idx: null })
  const drawTokenRef = useRef(0)

  // ---- draw evidence-span highlight boxes over matched passages ----
  useEffect(() => {
    const host = pagesHostRef.current
    if (!host || textReady === 0) return

    const myToken = ++drawTokenRef.current
    const aborted = (): boolean => drawTokenRef.current !== myToken

    host.querySelectorAll('.pdf-hl-layer').forEach((n) => n.remove())
    host
      .querySelectorAll<HTMLElement>(".pdf-text-layer span[style*='--sel-color']")
      .forEach((s) => s.style.removeProperty('--sel-color'))

    if (docIndexRef.current.key !== textReady || !docIndexRef.current.idx) {
      const pageEls = [...host.querySelectorAll<HTMLElement>('.pdf-page')]
      let globalText = ''
      const globalSpan: HTMLElement[] = []
      const globalPage: number[] = []
      const globalRawStart: number[] = []
      const globalRawEnd: number[] = []
      pageEls.forEach((pageEl, pi) => {
        const tl = pageEl.querySelector<HTMLElement>('.pdf-text-layer')
        const spans = tl
          ? [...tl.querySelectorAll<HTMLElement>('span')].filter(
              (s) => s.textContent && s.textContent.length
            )
          : []
        for (const s of spans) {
          const raw = s.textContent || ''
          // Walk the RAW text so each canonical character keeps a pointer back
          // to the glyph that produced it. Code points are iterated (not UTF-16
          // units) so a surrogate pair stays whole; a code point that lowercases
          // to several units (or is astral, and so occupies two) claims one
          // index slot per unit, all pointing at its full raw extent — that is
          // what keeps these arrays in step with `globalText`.
          let at = 0
          for (const ch of raw) {
            const c = canonChar(ch)
            if (c) {
              for (let k = 0; k < c.length; k++) {
                globalSpan.push(s)
                globalPage.push(pi)
                globalRawStart.push(at)
                globalRawEnd.push(at + ch.length)
              }
              globalText += c
            }
            at += ch.length
          }
        }
      })
      docIndexRef.current = {
        key: textReady,
        idx: { pageEls, globalText, globalSpan, globalPage, globalRawStart, globalRawEnd }
      }
      locateCacheRef.current = { key: textReady, map: new Map() }
    }
    const { pageEls, globalText, globalSpan, globalPage, globalRawStart, globalRawEnd } =
      docIndexRef.current.idx!

    /**
     * The rectangle the canonical range [from, to) actually occupies inside its
     * span, measured from the glyphs.
     *
     * A pdf.js text-layer span is one laid-out run — often a whole line — and a
     * quote usually starts or ends partway into one. Estimating that offset by
     * treating canonical characters as evenly spaced is wrong twice: the
     * canonical string has had spaces and punctuation REMOVED (so the character
     * counts on the two sides do not correspond), and glyphs are not equal
     * width. On the seeded corpus that put the left edge of a band up to ~11px
     * inside its first word and the right edge ~28px past its last one, which a
     * reader sees as a highlight that begins and ends mid-phrase.
     *
     * A DOM Range over the raw characters asks the layout engine where those
     * glyphs are instead of guessing, so the band is exact at any zoom, in any
     * font, and for a line whose punctuation density differs from its
     * neighbours. Returns null when the span is not a simple text node — the
     * caller then keeps the whole-span box, which is a superset of the truth
     * rather than a shifted guess.
     */
    const measureRange = (
      span: HTMLElement,
      rawFrom: number,
      rawTo: number
    ): DOMRect | null => {
      const node = span.firstChild
      if (!node || node.nodeType !== Node.TEXT_NODE || span.childNodes.length !== 1) return null
      const len = node.textContent?.length ?? 0
      const from = Math.max(0, Math.min(rawFrom, len))
      const to = Math.max(from, Math.min(rawTo, len))
      if (to <= from) return null
      try {
        const range = document.createRange()
        range.setStart(node, from)
        range.setEnd(node, to)
        const r = range.getBoundingClientRect()
        range.detach()
        return r.width > 0 && r.height > 0 ? r : null
      } catch {
        return null
      }
    }

    if (locateCacheRef.current.key !== textReady) {
      locateCacheRef.current = { key: textReady, map: new Map() }
    }
    const cache = locateCacheRef.current.map

    /**
     * Where a page currently sits in the VIEWPORT, read fresh each frame.
     *
     * Band geometry is page-relative, and the only way to get there from a
     * `getBoundingClientRect()` — which is viewport-relative — is to subtract
     * the page's own rect. Both must therefore be read at the SAME scroll
     * position. Capturing the origins once for the whole pass broke that: the
     * pass is chunked across animation frames (`BUDGET_MS` below), and stepping
     * to a find hit scrolls it into view with `behavior: 'smooth'`, so the
     * origins were captured before the animation and the span rects during it.
     * Every band located on such a frame was then drawn displaced by however
     * far the document had scrolled — a stable 37-81px in the sweep, which puts
     * a highlight squarely over the WRONG LINE. In a provenance tool that is
     * the worst possible failure: it asserts the paper says something it does
     * not, and the reader has no way to tell.
     *
     * Re-reading per frame is correct because a frame is synchronous: no scroll
     * can land part-way through one. Memoised within the frame so a pass over
     * many highlights on one page still costs a single layout read.
     */
    let originFrame = new Map<number, { left: number; top: number }>()
    const pageOrigin = {
      get: (pi: number): { left: number; top: number } => {
        let o = originFrame.get(pi)
        if (!o) {
          const r = pageEls[pi].getBoundingClientRect()
          o = { left: r.left, top: r.top }
          originFrame.set(pi, o)
        }
        return o
      },
      invalidate: (): void => {
        originFrame = new Map()
      }
    }
    const layerFor = new Map<number, HTMLElement>()
    const getLayer = (pi: number): HTMLElement => {
      let l = layerFor.get(pi)
      if (!l) {
        const pageEl = pageEls[pi]
        l = pageEl.querySelector<HTMLElement>('.pdf-hl-layer') ?? undefined!
        if (!l) {
          l = document.createElement('div')
          l.className = 'pdf-hl-layer'
          pageEl.appendChild(l)
        }
        layerFor.set(pi, l)
      }
      return l
    }

    /**
     * The located spans covering a canonical [start, end) range of the document.
     *
     * Which RAW characters of each span the match actually covers.
     *
     * A span is a whole run of text laid out by pdf.js — often an entire line —
     * so highlighting the span WHOLE is right for a sentence-long evidence
     * quote but wildly wrong for a short one: searching "enzyme" tinted 700px
     * of line for a word needing 73px. The covered slice is tracked in the
     * span's OWN text offsets (not canonical ones) because that is the only
     * space a DOM Range can be built in, and a Range is what makes the clip
     * exact rather than estimated.
     *
     * The caller owns the cache entry and the cursor: the two paths that call
     * this disagree about both, and folding either in here is what would let a
     * scoped match advance a cursor it never read.
     */
    const spansForRange = (start: number, end: number): LocatedSpan[] => {
      const covered = new Map<HTMLElement, { from: number; to: number }>()
      const seen = new Set<HTMLElement>()
      const out: LocatedSpan[] = []
      for (let i = start; i < end; i++) {
        const span = globalSpan[i]
        if (!span) continue
        const c = covered.get(span)
        if (c) {
          if (globalRawStart[i] < c.from) c.from = globalRawStart[i]
          if (globalRawEnd[i] > c.to) c.to = globalRawEnd[i]
        } else covered.set(span, { from: globalRawStart[i], to: globalRawEnd[i] })
        if (seen.has(span)) continue
        seen.add(span)
        const pi = globalPage[i]
        const r = span.getBoundingClientRect()
        const o = pageOrigin.get(pi)
        out.push({
          span,
          pi,
          left: r.left - o.left,
          top: r.top - o.top,
          width: r.width,
          height: r.height
        })
      }
      // Clip each box to the glyphs that matched, measured rather than derived.
      // A span whose text the match covers END TO END keeps its own box: the
      // Range would return the same rectangle, and skipping it avoids a layout
      // flush per fully-covered line of a long quote.
      for (const ls of out) {
        const c = covered.get(ls.span)
        if (!c) continue
        const rawLen = (ls.span.textContent || '').length
        if (c.from <= 0 && c.to >= rawLen) continue
        const o = pageOrigin.get(ls.pi)
        const r = measureRange(ls.span, c.from, c.to)
        if (!r) continue
        ls.left = r.left - o.left
        ls.width = r.width
        // Clip VERTICALLY from the same measurement. A span's box is not always
        // one line tall: these papers lay tables out with ROTATED header cells
        // 100-139px high, and inheriting such a span's own height gave a
        // one-word match a band down the whole column — up to 810px of table
        // rows the reader never searched for, tinted identically to a real hit.
        // The Range already reports the matched glyphs' true height, so the
        // clip costs nothing beyond the layout read that was happening anyway.
        ls.top = r.top - o.top
        ls.height = r.height
      }
      return out
    }

    const locate = (
      hl: PdfHighlight,
      cursor: number
    ): { spans: LocatedSpan[] | null; nextCursor: number } => {
      const ck = locateKey(hl)
      const cached = cache.get(ck)
      if (cached !== undefined) {
        // The cached END is absolute, so a warm cache advances the cursor to
        // exactly where a cold one would have left it.
        const nextCursor =
          cached && typeof hl.frac !== 'number' && cached.spans.length && cached.end !== null
            ? cached.end
            : cursor
        return { spans: cached ? cached.spans : null, nextCursor }
      }

      if (hl.region) {
        const { band, align } = hl.region
        for (let pi = 1; pi < pageEls.length; pi++) {
          const pageEl = pageEls[pi]
          const tl = pageEl.querySelector<HTMLElement>('.pdf-text-layer')
          if (!tl) continue
          const pr = pageEl.getBoundingClientRect()
          const pageH = pr.height
          const pageW = pr.width
          if (pageH <= 0 || pageW <= 0) continue
          const o = pageOrigin.get(pi)
          const spans = [...tl.querySelectorAll<HTMLElement>('span')]
          let best: LocatedSpan | null = null
          let bestDist = Infinity
          for (const span of spans) {
            const txt = (span.textContent || '').trim()
            if (!/^\d{1,3}$/.test(txt)) continue
            const r = span.getBoundingClientRect()
            if (r.width <= 0 || r.height <= 0) continue
            const relTop = r.top - o.top
            const inBand = band === 'top' ? relTop < 0.12 * pageH : relTop > 0.88 * pageH
            if (!inBand) continue
            const relCenterX = r.left - o.left + r.width / 2
            const centerDist = Math.abs(relCenterX - pageW / 2)
            if (align === 'center' && centerDist > 0.15 * pageW) continue
            if (centerDist < bestDist) {
              bestDist = centerDist
              best = {
                span,
                pi,
                left: r.left - o.left,
                top: relTop,
                width: r.width,
                height: r.height
              }
            }
          }
          if (best) {
            const out = [best]
            // A region anchor is located geometrically, so it has no place in
            // the document-order cursor.
            cache.set(ck, { spans: out, end: null })
            return { spans: out, nextCursor: cursor }
          }
        }
        cache.set(ck, null)
        return { spans: null, nextCursor: cursor }
      }

      const needle = canon(hl.text)

      // A quote scoped to its paragraph is disambiguated by WHERE it may match,
      // so the length guard below does not apply to it: that guard exists only
      // because an unscoped short needle matches everywhere in a paper. This is
      // what lets a table cell such as `0.528 ± 0.002` — eight canonical
      // characters — anchor at all, and without it every numeric cell of a
      // kinetics table went unhighlighted while the mutation list beside it,
      // long enough by accident of notation, did not.
      //
      // The cursor is neither read nor advanced, exactly as the `region` path
      // above. It orders highlights resolved RELATIVE to one another, while a
      // scoped match is absolute; evidence spans arrive in fact order rather
      // than document order, so letting one move the cursor would relocate the
      // unscoped highlights after it. `end: null` says the same to the warm
      // cache, which advances to `cached.end` whenever it is non-null — without
      // it a highlight would move the cursor on its second paint and not its
      // first.
      if (hl.scopeText) {
        const at = findScoped(globalText, canon(hl.scopeText), needle)
        if (at === null) {
          cache.set(ck, null)
          return { spans: null, nextCursor: cursor }
        }
        // No outward growth: `findScoped` matched the needle whole, so
        // `globalText.slice(at, at + needle.length) === needle` by construction.
        const out = spansForRange(at, at + needle.length)
        cache.set(ck, { spans: out, end: null })
        return { spans: out, nextCursor: cursor }
      }

      const minLen = hl.minMatch ?? 12
      if (needle.length < minLen) {
        cache.set(ck, null)
        return { spans: null, nextCursor: cursor }
      }
      let idx = -1
      const probeMin = Math.min(minLen, 8)
      // Each probe carries WHERE inside the needle it was cut from. A probe
      // locates the quote; it does not measure it. Without the offset, a hit on
      // the tail probe was treated as the quote's START, so the band began at
      // the quote's last words and ran a further `needle.length` characters over
      // whatever followed — text no quote contained.
      const mid = Math.floor(needle.length / 2)
      const probes = [
        { at: 0, s: needle.slice(0, 60) },
        { at: 0, s: needle.slice(0, 30) },
        { at: mid, s: needle.slice(mid, mid + 40) },
        { at: Math.max(0, needle.length - 50), s: needle.slice(-50) },
        { at: 0, s: needle }
      ]
      /** Offset into the needle of the probe that matched, once one has. */
      let probeAt = 0
      let probeLen = 0
      const take = (p: { at: number; s: string }, hit: number): void => {
        idx = hit
        probeAt = p.at
        probeLen = p.s.length
      }
      if (typeof hl.frac === 'number') {
        const expected = Math.round(hl.frac * globalText.length)
        for (const p of probes) {
          if (p.s.length < probeMin) continue
          let best = -1
          let bestDist = Infinity
          let from = 0
          for (;;) {
            const at = globalText.indexOf(p.s, from)
            if (at === -1) break
            // Compare where the QUOTE would start, not where the probe matched,
            // so a tail probe is not scored as if it were the quote's head.
            const d = Math.abs(at - p.at - expected)
            if (d < bestDist) {
              bestDist = d
              best = at
            }
            from = at + 1
          }
          if (best !== -1) {
            take(p, best)
            break
          }
        }
      } else {
        for (const p of probes) {
          if (p.s.length < probeMin) continue
          let hit = globalText.indexOf(p.s, Math.max(0, cursor - p.at))
          if (hit === -1) hit = globalText.indexOf(p.s)
          if (hit !== -1) {
            take(p, hit)
            break
          }
        }
      }
      // The exact/substring probes above anchor VERBATIM quotes (the ai-detector
      // contract, where the extractor emits literal spans). A quote none of them
      // finds is NOT anchored: `locate` returns null, the id is left out of
      // `onAnchoredIds`, and the finding renders visibly inert. There are only
      // these two outcomes — the right text highlighted, or nothing offered.
      //
      // Approximating the third is what produced the reported bug. A quote that
      // is only near-verbatim has no contiguous match, and a word-cluster
      // anchor happily spans from its first matching word to its last, painting
      // every glyph between: on the seeded corpus a 66-character quote took a
      // band over a table header it shares two words with, and a quote about
      // "catalytic antibodies 34E4 and 13G5" highlighted a citation marker
      // sitting between them. Drawn in the same tint as a verbatim span, that
      // asserts the paper says something it does not — which in a provenance
      // tool is strictly worse than the card simply not offering to jump.
      //
      // `probe()` never replicated this fallback, so citation-context cards
      // were already answering on the exact/substring ladder alone. The locator
      // now agrees with them instead of drawing bands for places the cards
      // report as unreachable.

      if (idx === -1) {
        cache.set(ck, null)
        return { spans: null, nextCursor: cursor }
      }
      // The extent the band will cover. A probe proves only that ITS OWN slice
      // is present; the rest of the quote is a hypothesis until checked. So the
      // quote is aligned at `idx - probeAt` and then grown outward from the
      // proven slice for exactly as long as the document still agrees with it,
      // character for character. A quote that is verbatim grows to its full
      // length; one that diverges (a paraphrase, a differently-hyphenated line,
      // a figure caption the extractor stitched on) stops at the divergence
      // instead of painting the difference. Previously the full `needle.length`
      // was taken on the strength of a 30-character prefix, so a 51-character
      // quote could own a 209-character band — 158 characters of text it does
      // not contain, rendered indistinguishably from evidence it does.
      let matchStart = idx
      let matchEnd = Math.min(idx + probeLen, globalText.length)
      const anchor = idx - probeAt
      while (
        matchStart > anchor &&
        matchStart > 0 &&
        globalText[matchStart - 1] === needle[matchStart - anchor - 1]
      )
        matchStart--
      while (
        matchEnd - anchor < needle.length &&
        matchEnd < globalText.length &&
        globalText[matchEnd] === needle[matchEnd - anchor]
      )
        matchEnd++
      // How much of the quote the document actually reproduced. A short probe
      // is a cheap way to FIND a candidate, not a licence to accept it: the
      // 8-character floor let `HG3 K50Q: 8.4 and 9.7 μM` anchor on the bare
      // fragment `m` shared with a units list elsewhere in the methods, and the
      // reader got a band over three unrelated characters. Requiring most of
      // the quote to be present keeps a passage the PDF hyphenates or spaces
      // differently (which still agrees for the great majority of its length)
      // while refusing one that merely shares a fragment.
      if (matchEnd - matchStart < Math.max(probeMin, Math.ceil(needle.length * 0.7))) {
        cache.set(ck, null)
        return { spans: null, nextCursor: cursor }
      }
      const out = spansForRange(matchStart, matchEnd)
      cache.set(ck, { spans: out, end: matchEnd })
      return { spans: out, nextCursor: matchEnd }
    }

    const SEV_RANK: Record<string, number> = { info: 0, low: 1, medium: 2, high: 3 }
    type Owned = {
      ls: LocatedSpan
      ids: string[]
      sev: string
      sevRank: number
      color?: string
      domain: string
      primary: string
    }
    const owned = new Map<HTMLElement, Map<string, Owned>>()
    const idsWithSpans = new Set<string>()

    const registerOne = (hl: PdfHighlight, spans: LocatedSpan[]): void => {
      const selColor = hl.color ? `color-mix(in srgb, ${hl.color} 75%, transparent)` : null
      const rank = SEV_RANK[hl.severity] ?? 0
      for (const ls of spans) {
        const span = ls.span
        if (selColor) span.style.setProperty('--sel-color', selColor)
        idsWithSpans.add(hl.annId)
        // Keyed by span AND by the SLICE of it that matched, because one pdf.js
        // span is often a whole line carrying several findings side by side —
        // "…9.7 μM; HG3 M84C: 16.9" is one span holding the tail of one quote
        // and the head of the next. Keying on the span alone made the second
        // finding adopt the FIRST one's already-clipped box, so both were drawn
        // over the same few characters and neither sat on its own text. The
        // clip is per-highlight, so the geometry must be too.
        const key = `${ls.left.toFixed(1)}:${ls.width.toFixed(1)}`
        let bySlice = owned.get(span)
        if (!bySlice) {
          bySlice = new Map()
          owned.set(span, bySlice)
        }
        const prev = bySlice.get(key)
        if (prev) {
          if (!prev.ids.includes(hl.annId)) prev.ids.push(hl.annId)
          if (rank > prev.sevRank) {
            prev.sev = hl.severity
            prev.sevRank = rank
            prev.color = hl.color
            prev.domain = hl.domain
            prev.primary = hl.annId
          }
        } else {
          bySlice.set(key, {
            ls,
            ids: [hl.annId],
            sev: hl.severity,
            sevRank: rank,
            color: hl.color,
            domain: hl.domain,
            primary: hl.annId
          })
        }
      }
    }

    const buildBands = (): void => {
      const byPage = new Map<number, Owned[]>()
      for (const bySlice of owned.values()) {
        for (const o of bySlice.values()) {
          const arr = byPage.get(o.ls.pi)
          if (arr) arr.push(o)
          else byPage.set(o.ls.pi, [o])
        }
      }
      const bandsForId = new Map<string, HTMLElement[]>()
      for (const [pi, list] of byPage) {
        list.sort((a, b) => a.ls.top - b.ls.top || a.ls.left - b.ls.left)
        // PASS 1 — per-LINE geometry. Spans are merged into a line band while
        // they share a baseline AND belong to the same set of evidence.
        //
        // The id set is part of the key because a line can carry two DIFFERENT
        // findings — table rows quoted separately, two claims cited from one
        // sentence. Merging purely by baseline spanned the band from the first
        // to the last of them and unioned their ids, so the shape covered every
        // glyph BETWEEN them: on the seeded corpus a quote ending at "…F)"
        // produced a band running 103px further, over a table value no quote
        // contained. Under `mix-blend-mode: multiply` that reads exactly like a
        // highlight of the neighbouring text — a silent misattribution of
        // evidence, which is worse than no highlight at all.
        //
        // A span genuinely owned by several findings still carries all of their
        // ids and merges with its like-owned neighbours, so overlapping
        // evidence is unaffected; only the fusion of DISJOINT findings is
        // broken up. This is also what PASS 2's grouping already assumes.
        const lines: LineBand[] = []
        let cur: LineBand | null = null
        let curKey = ''
        const flush = (): void => {
          if (cur) lines.push(cur)
          cur = null
        }
        for (const o of list) {
          const ls = o.ls
          const key = [...o.ids].sort().join(' ')
          let sameLine = false
          if (cur !== null && key === curKey) {
            const sTop = ls.top
            const sBot = ls.top + ls.height
            const ov = Math.min(sBot, cur.bottom) - Math.max(sTop, cur.top)
            const minH = Math.min(ls.height, cur.bottom - cur.top)
            sameLine = ov >= Math.max(2, minH * 0.35)
          }
          if (!sameLine) {
            curKey = key
            flush()
            cur = {
              left: ls.left,
              top: ls.top,
              right: ls.left + ls.width,
              bottom: ls.top + ls.height,
              ids: new Set(o.ids),
              sev: o.sev,
              sevRank: o.sevRank,
              color: o.color,
              domain: o.domain,
              primary: o.primary
            }
          } else {
            cur!.left = Math.min(cur!.left, ls.left)
            cur!.top = Math.min(cur!.top, ls.top)
            cur!.right = Math.max(cur!.right, ls.left + ls.width)
            cur!.bottom = Math.max(cur!.bottom, ls.top + ls.height)
            for (const id of o.ids) cur!.ids.add(id)
            if (o.sevRank > cur!.sevRank) {
              cur!.sev = o.sev
              cur!.sevRank = o.sevRank
              cur!.color = o.color
              cur!.domain = o.domain
              cur!.primary = o.primary
            }
          }
        }
        flush()

        // PASS 2 — merge the lines of ONE evidence into ONE shape.
        //
        // Grouping key is the exact id set: consecutive lines quoting the SAME
        // evidence become a single outlined region, while a neighbouring but
        // DIFFERENT evidence stays its own shape (merging those would assert a
        // continuity the data does not have).
        const groups = new Map<string, LineBand[]>()
        const order: string[] = []
        for (const b of lines) {
          const key = [...b.ids].sort().join(' ')
          const g = groups.get(key)
          if (g) g.push(b)
          else {
            groups.set(key, [b])
            order.push(key)
          }
        }

        for (const key of order) {
          const band = groups.get(key)!
          band.sort((a, b) => a.top - b.top)
          // A gap much larger than the line height is a real discontinuity — a
          // column break or a skipped paragraph. Joining across it would paint
          // over text the evidence never covered, so each run is its own shape.
          let run: LineBand[] = [band[0]]
          const runs: LineBand[][] = [run]
          for (let i = 1; i < band.length; i++) {
            const prev = band[i - 1]
            const gap = band[i].top - prev.bottom
            if (gap > Math.max(prev.bottom - prev.top, band[i].bottom - band[i].top) * 1.4) {
              run = [band[i]]
              runs.push(run)
            } else run.push(band[i])
          }
          for (const r of runs) emitShape(pi, r, bandsForId, getLayer)
        }
      }

      for (const id of idsWithSpans) {
        const bands = bandsForId.get(id)
        if (!bands || !bands.length) continue
        if (bands.some((b) => b.dataset.annId === id)) continue
        bands[0].dataset.annId = id
      }
      // NOTE: focus (`is-focused`) is intentionally NOT applied here. `active`
      // is no longer a dependency of this effect, so reading it from this
      // closure would be stale. The dedicated focus effect below owns it.
    }

    let i = 0
    let cursor = 0
    const BUDGET_MS = 7
    // This pass is about to replace every band, so the previous pass's verdict
    // no longer describes what is on screen. Without this, switching the
    // selected run, picking a citation or opening the find bar left
    // `data-pdf-rendered="yes"` asserting the OLD highlight set was anchored
    // while the new one had not been looked at yet — a settled answer to a
    // question nobody has asked yet.
    setSettled(false)
    const step = (): void => {
      if (aborted()) return
      // A new frame may sit at a new scroll position, so last frame's page
      // origins no longer describe where the pages are.
      pageOrigin.invalidate()
      const start = performance.now()
      while (i < highlights.length) {
        const hl = highlights[i++]
        const { spans, nextCursor } = locate(hl, cursor)
        if (typeof hl.frac !== 'number') cursor = nextCursor
        if (spans && spans.length) registerOne(hl, spans)
        if (performance.now() - start >= BUDGET_MS) break
      }
      if (i < highlights.length) {
        requestAnimationFrame(step)
      } else if (!aborted()) {
        buildBands()
        setBandsVersion((v) => v + 1)
        // Only a COMPLETE document may settle the anchored set. While pages are
        // still rendering the index covers a prefix of the document, so a quote
        // living on a later page has legitimately not been found yet — reporting
        // it now would mark that fact untraceable and then silently flip it back,
        // which reads to the user as the app changing its mind about the evidence.
        if (!loading) {
          if (onAnchoredIds) onAnchoredIds(new Set(idsWithSpans))
          setSettled(true)
        }
      }
    }
    requestAnimationFrame(step)

    return () => {
      drawTokenRef.current++
    }
  }, [highlights, textReady, loading, onAnchoredIds])

  // ---- in-document find (Ctrl+F) ----
  //
  // Reads the SAME text layers the evidence locator indexes, and returns hits as
  // synthetic highlights, so find results are drawn and scrolled to by the one
  // existing highlight path rather than a parallel engine that would drift from
  // it. Rebuilt on `textReady` so it follows re-renders and zoom changes.
  useEffect(() => {
    if (!onFindApi) return
    const host = pagesHostRef.current
    if (!host || textReady === 0) {
      onFindApi(null)
      return
    }

    const find = (query: string): PdfFindHit[] => {
      const needle = canon(query)
      // Below two characters every page matches, which is noise rather than a
      // result — the caller shows nothing instead.
      if (needle.length < 2) return []

      // Build a fresh index: pages may have re-rendered since the last search,
      // and a stale span reference would highlight the wrong place.
      const pageEls = [...host.querySelectorAll<HTMLElement>('.pdf-page')]
      let globalText = ''
      const globalPage: number[] = []
      const rawChars: string[] = []
      pageEls.forEach((pageEl, pi) => {
        const tl = pageEl.querySelector<HTMLElement>('.pdf-text-layer')
        const spans = tl ? [...tl.querySelectorAll<HTMLElement>('span')] : []
        for (const s of spans) {
          const raw = s.textContent || ''
          for (const ch of raw) {
            const c = canonChar(ch)
            if (!c) continue
            // One entry per CANONICAL character, not per code point. An astral
            // character canonicalises to two UTF-16 units, so pushing once
            // would leave these arrays a slot short of `globalText` from the
            // first such character onward — and every page number and excerpt
            // after it would be read from the wrong offset.
            for (let k = 0; k < c.length; k++) {
              globalPage.push(pi)
              rawChars.push(ch)
            }
          }
          globalText += canon(raw)
        }
      })

      const hits: PdfFindHit[] = []
      let from = 0
      for (;;) {
        const at = globalText.indexOf(needle, from)
        if (at === -1) break
        hits.push({
          // Keyed by the OFFSET, not by ordinal. The locator caches a resolved
          // position per annId for as long as the index lives, so a positional
          // `find:0` made every later query reuse the FIRST query's location:
          // the band simply never moved off the first thing the reader searched
          // for. An offset-keyed id is unique per query and per occurrence.
          annId: `find:${at}`,
          page: (globalPage[at] ?? 0) + 1,
          // Where this hit sits in the document, so the band anchors to THIS
          // occurrence rather than to whichever copy the locator's running
          // cursor happens to reach first.
          frac: globalText.length > 0 ? at / globalText.length : 0,
          // The document's OWN characters, not the canonical form, so the
          // readout shows the text as printed rather than stripped of spacing.
          text: rawChars.slice(at, at + needle.length).join('')
        })
        // Advance past this hit so overlapping self-similar text ("aaa" in
        // "aaaa") cannot loop forever or report the same offset twice.
        from = at + needle.length
        if (hits.length >= 500) break
      }
      return hits
    }

    /**
     * Batched reachability, over ONE index build.
     *
     * The ladder of prefix/middle/suffix probes is the same one the highlight
     * locator tries first, so a `true` here means the locator's cheapest path
     * already succeeds. The locator has a further word-window fallback which is
     * NOT replicated: it is quadratic in occurrences and would make a 500-query
     * probe pathological. That makes this answer CONSERVATIVE — it can say "not
     * reachable" about a paraphrase the locator would still have anchored. In
     * this repo that is the only acceptable direction to be wrong in: a card
     * marked inert that could have worked is a missed affordance, whereas a card
     * that offers to jump and then draws nothing is a lie.
     */
    const probe = (
      queries: Array<{ text: string; near?: number | null }>
    ): Array<number | null> => {
      const pageEls = [...host.querySelectorAll<HTMLElement>('.pdf-page')]
      let globalText = ''
      // Where each page's text begins, so an offset can be turned back into a
      // page and a `near` hint can pick between repeated occurrences.
      const pageStart: number[] = []
      for (const pageEl of pageEls) {
        pageStart.push(globalText.length)
        const tl = pageEl.querySelector<HTMLElement>('.pdf-text-layer')
        if (!tl) continue
        for (const s of tl.querySelectorAll<HTMLElement>('span')) {
          globalText += canon(s.textContent || '')
        }
      }
      const total = globalText.length
      if (total === 0) return queries.map(() => null)

      return queries.map((q) => {
        const needle = canon(q.text)
        // Matches the locator's default `minMatch`: below it the locator
        // refuses to look at all, so claiming reachability would be false.
        if (needle.length < 12) return null
        const mid = Math.floor(needle.length / 2)
        const ladder = [
          needle.slice(0, 60),
          needle.slice(0, 30),
          needle.slice(mid, mid + 40),
          needle.slice(-50),
          needle
        ]
        // The caller's page hint, expressed in the same offsets everything else
        // uses. Absent, position 0 is the reference point, which makes the
        // FIRST occurrence win — a stable answer either way, never one that
        // depends on where an unrelated cursor happened to stop.
        const expected =
          q.near && q.near >= 1 && q.near <= pageStart.length ? pageStart[q.near - 1] : 0
        for (const p of ladder) {
          if (p.length < 8) continue
          let best = -1
          let bestDist = Infinity
          let from = 0
          for (;;) {
            const at = globalText.indexOf(p, from)
            if (at === -1) break
            const d = Math.abs(at - expected)
            if (d < bestDist) {
              bestDist = d
              best = at
            }
            from = at + 1
          }
          if (best !== -1) return best / total
        }
        return null
      })
    }

    onFindApi({ find, probe })
    return () => onFindApi(null)
  }, [textReady, onFindApi])

  // Say WHICH of the two "no answer yet" cases the caller is in. Gated on
  // `loading` for the same reason `onAnchoredIds` is: while pages are still
  // rasterizing the index covers a prefix of the document, so a definitive
  // "not found" about a passage on a later page would be wrong and would then
  // silently flip — which reads as the app changing its mind.
  useEffect(() => {
    if (!onTextState) return
    if (error !== null || unavailable !== null) onTextState('unavailable')
    else if (!loading && textReady > 0) onTextState('ready')
    // Finished rendering with no text layer at all — a scan that was never
    // OCR'd. There is nothing to search and no amount of waiting will change
    // that, so it is a settled NO rather than a wait.
    else if (!loading) onTextState('unavailable')
    else onTextState('pending')
  }, [error, unavailable, loading, textReady, onTextState])

  // ---- report an EMPTY anchored set when there is nothing to anchor into ----
  // The draw effect above returns early while the text layer is not ready, so
  // on the no-file / render-error paths it would never call onAnchoredIds and
  // the caller would keep its optimistic "everything is traceable" set forever.
  // Settling explicitly lets the caller mark every fact as un-anchored.
  useEffect(() => {
    // A render error settles the document too — there is nothing further to
    // anchor into — so the flag is set whether or not anyone asked for the ids.
    const dead = error !== null || unavailable !== null
    if (dead) setSettled(true)
    if (!onAnchoredIds) return
    if (dead) {
      onAnchoredIds(new Set())
      setSettled(true)
    } else if (!loading && textReady > 0 && highlights.length === 0) {
      onAnchoredIds(new Set())
      setSettled(true)
    }
  }, [error, unavailable, loading, textReady, highlights, onAnchoredIds])

  // ---- focus the active span's bands (cheap; no re-location) ----
  // Matches on `data-ann-ids~=` so EVERY band of a multi-line / multi-page
  // evidence span lights up, not just the one holding the primary id.
  useEffect(() => {
    const host = pagesHostRef.current
    if (!host) return
    host.querySelectorAll('.pdf-hl.is-focused').forEach((b) => b.classList.remove('is-focused'))
    if (!active) return
    const esc = window.CSS && CSS.escape ? CSS.escape(active) : active
    host
      .querySelectorAll<HTMLElement>(`.pdf-hl[data-ann-ids~="${esc}"], .pdf-hl[data-ann-id="${esc}"]`)
      .forEach((b) => b.classList.add('is-focused'))
  }, [active, bandsVersion])

  // click anywhere on a highlighted passage -> open its popover
  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll || !onHighlightClick) return
    const onClick = (e: MouseEvent): void => {
      if (window.getSelection()?.toString()) return
      const host = pagesHostRef.current
      if (!host) return
      const boxes = [...host.querySelectorAll<HTMLElement>('.pdf-hl')]
      const TOL = 4
      const NEAR = 14
      let hitIds: string[] | null = null
      let hitRect: DOMRect | null = null
      let bestDist = Infinity
      let nearIds: string[] | null = null
      let nearRect: DOMRect | null = null
      for (const b of boxes) {
        const r = b.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue
        const ids = (b.dataset.annIds ?? b.dataset.annId ?? '').split(' ').filter(Boolean)
        if (!ids.length) continue
        const inside =
          e.clientX >= r.left - TOL &&
          e.clientX <= r.right + TOL &&
          e.clientY >= r.top - TOL &&
          e.clientY <= r.bottom + TOL
        if (inside) {
          if (!hitIds) hitIds = []
          for (const id of ids) if (!hitIds.includes(id)) hitIds.push(id)
          hitRect = r
        }
        const cx = Math.max(r.left, Math.min(e.clientX, r.right))
        const cy = Math.max(r.top, Math.min(e.clientY, r.bottom))
        const d = Math.hypot(e.clientX - cx, e.clientY - cy)
        if (d < bestDist) {
          bestDist = d
          nearIds = ids
          nearRect = r
        }
      }
      if ((!hitIds || !hitIds.length) && bestDist <= NEAR) {
        hitIds = nearIds
        hitRect = nearRect
      }
      if (hitIds && hitIds.length && hitRect) {
        e.stopPropagation()
        onHighlightClick(hitIds, hitRect)
      }
    }
    scroll.addEventListener('click', onClick)
    return () => scroll.removeEventListener('click', onClick)
  }, [scrollRef, onHighlightClick, textReady, highlights])

  // scroll the active highlight into view when it changes
  useEffect(() => {
    const host = pagesHostRef.current
    const scroll = scrollRef.current
    if (!host || !scroll || !active) return
    let cancelled = false
    const esc = window.CSS && CSS.escape ? CSS.escape(active) : active
    // An evidence span can own bands on SEVERAL pages; `data-ann-id` may have
    // been assigned to a later-page band, so gather every band the id owns and
    // scroll to the FIRST one in document order.
    const findBox = (): HTMLElement | null => {
      const boxes = [
        ...host.querySelectorAll<HTMLElement>(
          `.pdf-hl[data-ann-ids~="${esc}"], .pdf-hl[data-ann-id="${esc}"]`
        )
      ]
      if (!boxes.length) return null
      const keyOf = (b: HTMLElement): number => {
        const pageEl = b.closest<HTMLElement>('.pdf-page')
        return (pageEl ? pageEl.offsetTop : 0) + b.offsetTop
      }
      return boxes.reduce((best, b) => (keyOf(b) < keyOf(best) ? b : best), boxes[0])
    }
    const deadline = performance.now() + 2500
    const scrollTo = (box: HTMLElement): void => {
      const pageEl = box.closest<HTMLElement>('.pdf-page')
      if (pageEl) {
        // Paint the DESTINATION before the smooth scroll starts, rather than
        // waiting for the scroll handler to notice the reader arrived. A jump
        // from page 2 to page 14 crosses every page in between, and each of
        // those page changes would move the band — so the target would be
        // requested last, after a dozen pointless allocate-and-free pairs, and
        // the reader would watch their evidence highlighted on a white sheet.
        const target = Number(pageEl.dataset.page)
        if (Number.isFinite(target)) syncBand(target)
        const top = pageEl.offsetTop + box.offsetTop - scroll.clientHeight / 3
        scroll.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
      }
    }
    const tick = (): void => {
      if (cancelled) return
      const box = findBox()
      if (box) {
        scrollTo(box)
        return
      }
      if (performance.now() > deadline) return
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    return () => {
      cancelled = true
    }
  }, [active, scrollRef, textReady, bandsVersion, syncBand])

  // No bytes. WHICH of the four reasons decides whether this is a statement
  // about the paper or about this computer — and only the first is an empty
  // state at all; the rest are failures, and are drawn as failures.
  if (unavailable !== null) {
    const absence = isContentAbsence(unavailable)
    return (
      <div
        className={`pdf-col pdf-nofile${absence ? '' : ' pdf-nofile--failed'}`}
        data-testid="pdf-nofile"
        data-pdf-unavailable={unavailable}
      >
        <div className="pdf-loading-box" role={absence ? undefined : 'alert'}>
          {!absence && (
            <span className="badge badge-danger pdf-nofile-badge">
              PDF could not be opened
            </span>
          )}
          <span className="pdf-loading-label" data-testid="pdf-nofile-label">
            {pdfUnavailableSentence(unavailable)}
          </span>
          {!absence && (
            <button
              type="button"
              className="btn btn-secondary pdf-nofile-retry"
              data-testid="pdf-nofile-retry"
              data-tip="Look for the file again — useful once a drive is reconnected."
              onClick={() => setReloadNonce((n) => n + 1)}
            >
              Try again
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    // `data-pdf-rendered` flips to "yes" only once every page has rendered AND
    // the locator has finished its chunked pass, so the anchored set is final.
    // Since pages now publish progressively, the presence of a highlight no
    // longer implies the document is complete — anything that must reason about
    // the FINAL set of anchored facts (the e2e specs, most of all) waits on
    // this, or it reads PaperScreen's optimistic "everything is traceable"
    // state. It is `settled`, not `!loading`, precisely because those are two
    // different moments.
    <div className="pdf-col" data-testid="pdf-viewer" data-pdf-rendered={settled ? 'yes' : 'no'}>
      {numPages > 0 && (
        <div className="pdf-pagebadge" aria-hidden="true">
          {currentPage} / {numPages}
        </div>
      )}
      <div
        className={'paper-scroll pdf-scroll' + (loading || error ? ' is-locked' : '')}
        ref={scrollRef}
      >
        <div className="pdf-pages" ref={pagesHostRef} />
      </div>
      {loading && (
        <div className="pdf-loading-overlay" role="status" aria-live="polite">
          <div className="pdf-loading-box">
            <span className="pdf-spinner" aria-hidden="true" />
            <span className="pdf-loading-label">Loading document…</span>
          </div>
        </div>
      )}
      {error && error !== '__nofile__' && (
        <div className="pdf-loading-overlay pdf-loading-overlay--error" role="alert">
          <div className="pdf-loading-box">
            <span className="pdf-loading-label">Could not render PDF: {error}</span>
          </div>
        </div>
      )}
    </div>
  )
}
