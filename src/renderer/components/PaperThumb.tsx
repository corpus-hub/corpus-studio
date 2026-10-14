import { useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import { getSharedPdfWorker } from '../lib/pdfWorker'
import { pdfUnavailableLabel, pdfUnavailableSentence } from '../lib/pdfAvailability'
import type { PdfUnavailableReason } from '@shared/contract'
import { plainText } from './RichText'

/**
 * Page-1 preview of a paper, as the reference tree draws beside every node.
 *
 * Rasterising a PDF page is expensive and the same paper is shown repeatedly
 * (a popover reopened on the same edge, the same work on both sides of two
 * different edges), so finished rasters are cached MODULE-WIDE rather than per
 * component instance — a URL survives unmount, which a detached <canvas> held in
 * component state would not.
 *
 * BOUNDED, and as blob URLs rather than data URLs. Both matter now that many
 * screens stay mounted at once: an unbounded map of base-64 strings grew without
 * limit for the life of the session — a large `lg` raster is ~60-110 KB of
 * string heap, so browsing a few hundred works retained tens of megabytes that
 * nothing could ever release. A data URL is a string and cannot be freed while
 * referenced; a blob URL can be revoked, which is what makes eviction actually
 * return the memory rather than merely forget about it.
 *
 * A `url: null` entry is a REMEMBERED FAILURE — no document, or a PDF that
 * would not render. Without it every remount retries a load that is already
 * known to fail, which on a metadata-only work is every time. It is cached as
 * a RESULT rather than as a bare `null` so the remembered answer still carries
 * WHY, and a remounted thumbnail explains itself as well as the first one did.
 */
/**
 * What a rasterisation produced.
 *
 * `problem` is why there is no picture, and it is NOT collapsed into "no PDF":
 * `none` is the paper genuinely having no document, `render` is a file that
 * pdf.js would not open, and the rest are the file being missing from its
 * drive, unreadable, or at a rejected path. One "?" for all of them told the
 * reader a paper on a disconnected drive had no document.
 *
 * `fault` is the sixth and says NOTHING about the file: something on this side
 * threw — the IPC never answered, the document list failed, pdf.js crashed —
 * so nothing was learned about the PDF at all. It used to be folded into
 * `render`, which announces a damaged document, so a dropped IPC call told the
 * user their file was broken and sent them to replace a PDF that is fine.
 */
type ThumbResult =
  | { url: string; problem: null }
  | { url: null; problem: PdfUnavailableReason | 'render' | 'fault' }

const cache = new Map<string, ThumbResult>()
const inflight = new Map<string, Promise<ThumbResult>>()

/**
 * How many rasters are kept.
 *
 * Sized for a working set — the nodes around one subtree of the reference
 * tree — not for a whole corpus. Insertion order is the eviction order (a Map
 * iterates oldest-first) and a re-read refreshes an entry's position, which is
 * an LRU close enough for a cache whose miss costs a re-render, not a re-fetch.
 */
const CACHE_MAX = 120

function cacheGet(key: string): ThumbResult | undefined {
  const v = cache.get(key)
  if (v === undefined) return undefined
  // Re-inserted, so recency is position: touching an entry moves it to the back
  // of the iteration order and out of the way of the next eviction.
  cache.delete(key)
  cache.set(key, v)
  return v
}

/**
 * How many components are currently rendering each key's URL.
 *
 * Eviction must never revoke a URL that is on screen: a revoked blob URL in an
 * `<img src>` is a broken image, so capping the cache would have turned the
 * oldest visible thumbnails into broken icons — the one failure mode worse than
 * the leak being fixed. Entries in use are skipped and collected on the next
 * pass, once the last component showing them has unmounted.
 */
const inUse = new Map<string, number>()

function retain(key: string): void {
  inUse.set(key, (inUse.get(key) ?? 0) + 1)
}

function release(key: string): void {
  const n = (inUse.get(key) ?? 0) - 1
  if (n > 0) inUse.set(key, n)
  else inUse.delete(key)
}

function cacheSet(key: string, result: ThumbResult): void {
  cache.set(key, result)
  if (cache.size <= CACHE_MAX) return
  let over = cache.size - CACHE_MAX
  for (const k of [...cache.keys()]) {
    if (over <= 0) break
    if (k === key || inUse.has(k)) continue
    const evicted = cache.get(k)
    cache.delete(k)
    // REVOKED, not merely dropped. Without this the blob stays alive for as
    // long as the document does, and the bound would limit the size of the map
    // rather than the memory it exists to cap.
    if (evicted && evicted.url !== null) URL.revokeObjectURL(evicted.url)
    over--
  }
}

/** Rendered width in CSS px. The raster is 2× for retina, then scaled down. */
const THUMB_W = 34
const THUMB_H = 44
/**
 * The `large` variant, for the profile card that opens on a tree node.
 *
 * A SEPARATE raster, not the small one upscaled: a 34px-wide page blown up to
 * 132px is a smear, and the point of showing the first page at that size is
 * that it is legible. Cached under its own key so the two sizes never evict
 * each other.
 */
const LARGE_W = 132
const LARGE_H = 171

async function rasterise(workId: number, w: number, h: number): Promise<ThumbResult> {
  const docs = await window.api.getWorkDocuments(workId)
  // Prefer the same document the rest of the app treats as canonical, so the
  // preview and the reader never show different files for one paper.
  const doc = docs.find((d) => d.is_preferred) ?? docs[0]
  if (!doc) return { url: null, problem: 'none' }
  const read = await window.api.readPdf(doc.id)
  if (!read.ok) return { url: null, problem: read.reason }
  const bytes = read.bytes
  const data = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes)
  // The SHARED worker. Without it every thumbnail spins up a private worker
  // thread with its own copy of the font and cmap machinery, and the reference
  // tree opens them by the dozen.
  const task = pdfjs.getDocument({ data, worker: getSharedPdfWorker() })
  const pdf = await task.promise
  try {
    const page = await pdf.getPage(1)
    const base = page.getViewport({ scale: 1 })
    const scale = Math.min((w * 2) / base.width, (h * 2) / base.height)
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(viewport.width))
    canvas.height = Math.max(1, Math.round(viewport.height))
    const ctx = canvas.getContext('2d')
    if (!ctx) return { url: null, problem: 'render' }
    await page.render({ canvasContext: ctx, viewport }).promise
    // A blob URL, so eviction can actually revoke it. `toDataURL` returns a
    // base-64 string that is ~33% larger than the raster and cannot be freed.
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))
    // The canvas backing store goes now either way — it is the largest thing
    // here, and holding it until GC is what makes a scroll through the tree
    // allocate faster than it collects.
    canvas.width = 0
    canvas.height = 0
    // A canvas that will not encode is a rendering failure, not an absent
    // document: the bytes were had and page 1 was drawn.
    return blob ? { url: URL.createObjectURL(blob), problem: null } : { url: null, problem: 'render' }
  } finally {
    // The raster is all we keep; the document and its bytes go now.
    void pdf.destroy()
  }
}

export function PaperThumb({
  workId,
  title,
  size = 'sm'
}: {
  workId: number
  title?: string
  /** `lg` renders the page at a size it can actually be read at. */
  size?: 'sm' | 'lg'
}): JSX.Element {
  const key = `${workId}:${size}`
  const [result, setResult] = useState<ThumbResult | null>(() => cacheGet(key) ?? null)
  const [settled, setSettled] = useState(() => cache.has(key))
  // Guards a setState after unmount when the user closes the card mid-render.
  const aliveRef = useRef(true)

  // Held for as long as this component may render the URL, so the LRU cannot
  // revoke a blob that is on screen.
  useEffect(() => {
    retain(key)
    return () => release(key)
  }, [key])

  useEffect(() => {
    aliveRef.current = true
    const hit = cacheGet(key)
    if (hit !== undefined) {
      setResult(hit)
      setSettled(true)
      return
    }
    setSettled(false)
    // One in-flight rasterisation per work, shared by every component asking
    // for it — both sides of a popover can name the same paper.
    const existing = inflight.get(key)
    const job: Promise<ThumbResult> =
      existing ??
      rasterise(workId, size === 'lg' ? LARGE_W : THUMB_W, size === 'lg' ? LARGE_H : THUMB_H)
        // A THROW IS NOT A VERDICT ON THE FILE. `readPdf` resolves `{ok:false}`
        // for a document that is missing, unreadable or at a rejected path, and
        // a page pdf.js declines to draw is returned as `render` inside
        // `rasterise` — so everything that reaches here is something else going
        // wrong on this side: the IPC rejecting, `getWorkDocuments` failing, the
        // worker dying. Calling that a damaged PDF accuses a file nothing
        // managed to look at.
        .catch((): ThumbResult => ({ url: null, problem: 'fault' }))
        .then((res) => {
          // A fault is NOT remembered. Every other answer here is a settled
          // fact about the paper — it has no document, or its file is gone —
          // and re-asking would fail identically, which is what the cache is
          // for. A fault is a fact about this moment on this side, so caching it
          // would turn one dropped call into a paper that never shows its page
          // again for the life of the session.
          if (res.problem !== 'fault') cacheSet(key, res)
          inflight.delete(key)
          return res
        })
    if (!existing) inflight.set(key, job)
    void job.then((res) => {
      if (!aliveRef.current) return
      setResult(res)
      setSettled(true)
    })
    return () => {
      aliveRef.current = false
    }
  }, [workId, key, size])

  if (result && result.url !== null) {
    return (
      <img
        className="paper-thumb"
        src={result.url}
        alt=""
        aria-hidden="true"
        data-testid={`paper-thumb-${workId}`}
      />
    )
  }

  const of = title === undefined ? 'this paper' : plainText(title)
  // A paper with no document is the ORDINARY answer and stays quiet: a dashed
  // frame with "?", the same vocabulary the reference tree uses. Everything else
  // is a file the corpus HAS and this computer could not open, which is the
  // exception the reader can act on — so it is drawn differently, tinted, and
  // carries a warning glyph rather than the neutral "?".
  const broken = settled && result !== null && result.problem !== null && result.problem !== 'none'
  // A FAULT ON THIS SIDE, drawn apart from both neighbours: it is not the quiet
  // "?" of a paper with no document, and it is not the danger frame that says
  // this file is unopenable — nothing looked at the file. Warn rather than
  // danger, its own glyph, and a solid frame, so the three are told apart by
  // shape as well as by hue.
  const faulted = broken && result !== null && result.problem === 'fault'
  const tip = !settled
    ? undefined
    : result === null || result.problem === null || result.problem === 'none'
      ? `No PDF for ${of}`
      : result.problem === 'render'
        ? `This paper’s PDF is stored, but it could not be opened as a document.`
        : result.problem === 'fault'
          ? // NOTHING is claimed about the file. The preview did not run, and
            // the only honest thing to report is that — saying the PDF is
            // damaged would send the user to replace a file nobody read.
            `The preview of ${of} could not be produced — the app failed while reading it, so nothing is known about the file itself. Reopening this may work.`
          : pdfUnavailableSentence(result.problem)
  const label =
    result !== null && result.problem !== null && result.problem !== 'none'
      ? result.problem === 'render'
        ? `PDF for ${of} could not be opened`
        : result.problem === 'fault'
          ? `Preview of ${of} failed`
          : `${pdfUnavailableLabel(result.problem)} for ${of}`
      : undefined

  return (
    <span
      className={`paper-thumb paper-thumb-empty${settled ? '' : ' paper-thumb-loading'}${
        broken ? (faulted ? ' paper-thumb-faulted' : ' paper-thumb-broken') : ''
      }`}
      data-testid={`paper-thumb-${workId}`}
      data-tip={tip}
      role={broken ? 'img' : undefined}
      aria-label={broken ? label : undefined}
      aria-hidden={broken ? undefined : 'true'}
    >
      {broken ? (
        <svg
          className="paper-thumb-glyph"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {faulted ? (
            // A CIRCLED "!", not the warning triangle. The triangle is this
            // app's mark for a document that is wrong; a circle says the attempt
            // failed and carries no claim about the file — a reader who has
            // learned the triangle would otherwise read this as a damaged PDF
            // from the shape alone, before any tooltip.
            <>
              <circle cx="10" cy="10" r="7.4" />
              <path d="M10 6.4v4.2" />
              <path d="M10 13.4v.1" />
            </>
          ) : (
            <>
              <path d="M10 2.6L18 16.6H2z" />
              <path d="M10 8v3.6" />
              <path d="M10 14.1v.1" />
            </>
          )}
        </svg>
      ) : settled ? (
        '?'
      ) : (
        ''
      )}
    </span>
  )
}
