import { useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import { getSharedPdfWorker } from '../lib/pdfWorker'
import { pdfUnavailableLabel, pdfUnavailableSentence } from '../lib/pdfAvailability'
import type { PdfUnavailableReason } from '@shared/contract'

/** Bounded raster cache. ~80 * 96*128*4B ≈ 4 MB worst case. */
const CACHE_MAX = 80
/** pdf.js is single-worker; more concurrent loads just queue behind each other. */
const MAX_INFLIGHT = 3

/**
 * What became of a thumbnail request.
 *
 * `none` used to carry two different facts — "this paper has no PDF" and "the
 * PDF is there and something threw" — and the glyph drawn for it asserted the
 * first. A row whose file sits on a disconnected drive therefore read as a row
 * that never had a document. `failed` is now its own answer, and it says so.
 */
type ThumbState =
  | { kind: 'pending' }
  | { kind: 'ready' }
  | { kind: 'absent'; reason: PdfUnavailableReason }
  | { kind: 'failed' }

/**
 * Page-1 rasters shared by every list that wants a paper's cover, keyed by
 * document.
 *
 * Each job loads the PDF, renders page 1 onto an offscreen canvas and then
 * DESTROYS the pdf.js document: only the small raster is retained, so neither
 * the source bytes nor a worker-side document lingers. On eviction the canvas
 * is shrunk to 0x0, which is what actually releases the backing store in
 * Chromium.
 *
 * The same document rendered in two rows is loaded once — the cache is keyed by
 * document, and later requests for a raster already in flight simply subscribe.
 */
class ThumbStore {
  private lru = new Map<number, HTMLCanvasElement>()
  private status = new Map<number, ThumbState>()
  private inflight = new Set<number>()
  private waiting: number[] = []
  private listeners = new Set<(documentId: number) => void>()

  subscribe(fn: (documentId: number) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  get(documentId: number): HTMLCanvasElement | null {
    const c = this.lru.get(documentId)
    if (!c) return null
    this.lru.delete(documentId)
    this.lru.set(documentId, c)
    return c
  }

  stateOf(documentId: number): ThumbState | undefined {
    return this.status.get(documentId)
  }

  request(documentId: number, px: { w: number; h: number }): void {
    if (this.status.has(documentId)) return
    this.status.set(documentId, { kind: 'pending' })
    if (this.inflight.size >= MAX_INFLIGHT) {
      this.waiting.push(documentId)
      return
    }
    void this.run(documentId, px)
  }

  private async run(documentId: number, px: { w: number; h: number }): Promise<void> {
    this.inflight.add(documentId)
    try {
      const read = await window.api.readPdf(documentId)
      if (!read.ok) {
        this.finish(documentId, { kind: 'absent', reason: read.reason })
        return
      }
      const bytes = read.bytes
      const data = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes)
      // The SHARED worker, not a private one: this scheduler opens up to three
      // documents at a time and a list of fifty papers walks through all of them,
      // so a thread per document is a thread per paper in the list.
      const task = pdfjs.getDocument({ data, worker: getSharedPdfWorker() } as unknown as Parameters<
        typeof pdfjs.getDocument
      >[0])
      const doc = await task.promise
      try {
        const page = await doc.getPage(1)
        const base = page.getViewport({ scale: 1 })
        const viewport = page.getViewport({
          scale: Math.min(px.w / base.width, px.h / base.height)
        })
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(viewport.width))
        canvas.height = Math.max(1, Math.round(viewport.height))
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          this.finish(documentId, { kind: 'failed' })
          return
        }
        await page.render({ canvasContext: ctx, viewport }).promise
        this.put(documentId, canvas)
        this.finish(documentId, { kind: 'ready' })
      } finally {
        // The raster is all that is kept, and the document goes on EVERY path.
        // A `finally` rather than a call per outcome: a malformed page that throws
        // out of `getPage` or `render` would otherwise leave the document alive
        // inside the SHARED worker, whose heap then grows once per failed thumbnail
        // for the life of the renderer.
        void doc.destroy()
      }
    } catch {
      // The bytes WERE had; pdf.js would not turn them into a page. That is a
      // broken or unsupported file, not a paper without one.
      this.finish(documentId, { kind: 'failed' })
    }
  }

  private finish(documentId: number, state: ThumbState): void {
    this.inflight.delete(documentId)
    this.status.set(documentId, state)
    for (const fn of this.listeners) fn(documentId)
    const next = this.waiting.shift()
    if (next !== undefined) {
      this.status.delete(next)
      this.request(next, { w: THUMB_PX_W, h: THUMB_PX_H })
    }
  }

  private put(documentId: number, canvas: HTMLCanvasElement): void {
    this.lru.set(documentId, canvas)
    while (this.lru.size > CACHE_MAX) {
      const oldest = this.lru.keys().next().value as number | undefined
      if (oldest === undefined) break
      const dead = this.lru.get(oldest)
      this.lru.delete(oldest)
      this.status.delete(oldest)
      if (dead) {
        dead.width = 0
        dead.height = 0
      }
    }
  }
}

/** CSS size of a list thumbnail, and the 2x device-pixel size it is baked at. */
export const THUMB_W = 34
export const THUMB_H = 44
const THUMB_PX_W = THUMB_W * 2
const THUMB_PX_H = THUMB_H * 2

const store = new ThumbStore()

/**
 * A paper's page-1 cover at list size.
 *
 * `documentId === null` (no work yet, or a work with no stored PDF) is a real
 * and common state, not an error: it renders a labelled page glyph rather than
 * an empty box, so a row without a PDF still reads as a row.
 */
export function PdfThumb({
  documentId,
  alt
}: {
  documentId: number | null
  alt: string
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [, bump] = useState(0)

  useEffect(() => {
    if (documentId === null) return
    return store.subscribe((id) => {
      if (id === documentId) bump((n) => n + 1)
    })
  }, [documentId])

  useEffect(() => {
    if (documentId === null) return
    if (store.stateOf(documentId) === undefined) {
      store.request(documentId, { w: THUMB_PX_W, h: THUMB_PX_H })
    }
    const src = store.get(documentId)
    const dst = canvasRef.current
    if (!src || !dst) return
    dst.width = src.width
    dst.height = src.height
    dst.getContext('2d')?.drawImage(src, 0, 0)
  })

  const state: ThumbState =
    documentId === null
      ? { kind: 'absent', reason: 'none' }
      : (store.stateOf(documentId) ?? { kind: 'pending' })

  if (state.kind === 'ready') {
    return (
      <span className="pdf-thumb is-ready" role="img" aria-label={`First page of ${alt}`}>
        <canvas ref={canvasRef} className="pdf-thumb-canvas" />
      </span>
    )
  }

  // Only a document the corpus does not have is a quiet placeholder. Everything
  // else went wrong on this machine, and the tile says which — a warning glyph
  // and a warning tint, so the row does not read as a paper without a PDF.
  const broken = state.kind === 'failed' || (state.kind === 'absent' && state.reason !== 'none')
  const label =
    state.kind === 'pending'
      ? `Rendering first page of ${alt}`
      : state.kind === 'failed'
        ? `PDF for ${alt} could not be opened`
        : state.reason === 'none'
          ? `No PDF for ${alt}`
          : `${pdfUnavailableLabel(state.reason)} for ${alt}`
  const tip =
    state.kind === 'pending'
      ? 'Rendering the first page…'
      : state.kind === 'failed'
        ? 'This paper’s PDF is stored, but it could not be opened as a document.'
        : pdfUnavailableSentence(state.reason)
  return (
    <span
      className={`pdf-thumb ${state.kind === 'pending' ? 'is-loading' : broken ? 'is-broken' : 'is-absent'}`}
      role="img"
      aria-label={label}
      data-tip={tip}
    >
      {broken ? (
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <path d="M10 2.6L18 16.6H2z" />
          <path d="M10 8v3.6" />
          <path d="M10 14.1v.1" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M5 2.6h6.2L15.4 7v10.4H5z" />
          <path d="M11.2 2.6V7h4.2" />
        </svg>
      )}
    </span>
  )
}
