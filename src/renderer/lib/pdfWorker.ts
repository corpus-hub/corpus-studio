import * as pdfjs from 'pdfjs-dist'

// Resolved to a BUNDLED asset URL, never a CDN: the app must run with networking
// disabled, and the strict CSP (`script-src 'self'`) would refuse a remote
// worker script anyway.
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString()

/**
 * ONE pdfjs worker thread for the whole renderer.
 *
 * `getDocument()` with no `worker` spins up a private `PDFWorker` per call — a
 * whole thread plus its own copy of the font and cmap machinery for every
 * document that is open. The reference screen's thumbnail scheduler opens them
 * by the dozen, and several paper viewers can be mounted at once, so that is a
 * thread each for work that parallelises poorly regardless: the worker parses
 * and builds operator lists, while rasterization happens on the main thread,
 * which was already the serializing step.
 *
 * An EXPLICIT worker is also what makes `destroy()` safe to call per document.
 * pdfjs tears down only a worker it created for itself — it records that on the
 * loading task — so destroying one document releases its parsed heap and leaves
 * the thread every other document is using alone.
 *
 * Lazy because this module is imported by components that also run under the
 * screenshot harness and the test fixtures, where no worker script can be
 * fetched; nothing is spawned until a document is actually opened.
 *
 * Re-created once the previous one reports `destroyed`. A worker can die — a
 * crash, a port error — and a memoized dead one would refuse every subsequent
 * document in the renderer with no way back short of reloading the app.
 */
type SharedPdfWorker = { destroyed?: boolean }
let sharedWorker: SharedPdfWorker | null = null

export function getSharedPdfWorker(): SharedPdfWorker {
  if (!sharedWorker || sharedWorker.destroyed) {
    const W = (pdfjs as unknown as { PDFWorker: new (o: { name: string }) => SharedPdfWorker })
      .PDFWorker
    sharedWorker = new W({ name: 'corpus-pdf-worker' })
  }
  return sharedWorker
}
