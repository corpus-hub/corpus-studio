// Stage 2 — the per-page text layer, published as `text.pages@v2`.
//
// Delegates to `citations/extractText.ts`, which is already the repo's
// deterministic, offline, no-eval pdfjs path (legacy build, no system fonts, no
// standard-font data). Re-implementing extraction here would give the citation
// parser and the pipeline two different ideas of what a page says.
//
// This is the stage that makes the wave's machinery real rather than notional:
// it CONSUMES a capability, does genuinely slow async work, writes bulk rows
// through `ctx.write`, reports progress, honours cancellation between pages,
// and its fingerprint chains off `download`'s file hash — so replacing the PDF
// supersedes it without either stage naming the other.

import type { DocumentFile, TextPage, TextPages } from '../capabilities'
import type { StageDefinition } from '../types'

/** Below this, a page is a scan: there is a text layer but it says nothing. */
const THIN_PAGE_CHARS = 40

const extractText: StageDefinition<{ pageCount: number; chars: number }> = {
  id: 'extract-text',
  label: 'Extract text',
  // 1.1.0: each run now carries `x` and `width` as well as height and baseline.
  // Without the horizontal half of the transform a run's column is unknown, so a
  // REGION of the page cannot be bounded — and a table cannot be cropped out to
  // be read as a picture, which is the only reliable way to recover values the
  // text layer garbles (`0 . 29 6 0 . 11` is what this corpus stores for
  // `0.29 ± 0.11`). Cached runs from 1.0.0 hold items without those fields, so
  // the version has to move or every older document silently produces no crops.
  // 1.2.0: a scan now reports `not-needed` rather than `empty`. That is a
  // change in what this stage CLAIMS about a paper, so it has to supersede the
  // runs made under the old wording — a stored `empty` would otherwise be
  // served from cache forever, and the row would keep saying "Nothing found"
  // about a paper OCR read in full.
  version: '1.2.0',
  rank: 3,
  scope: 'document',
  provides: ['text.pages@v2'],
  requires: ['document.file@v1'],
  usesLlm: false,
  runtime: 'node',
  // pdfjs is ~29 ms/page of synchronous-ish CPU; a 300-page paper would hold
  // main — and with it the database and every IPC reply — for ~9 seconds.
  isolation: 'host',
  weight: 'heavy',

  async execute(ctx) {
    const file = ctx.input<DocumentFile>('document.file@v1')
    if (!file) {
      // The contract, not a special case: a missing required input is a
      // `skipped`, never a throw. `download` skips when the library holds no
      // bytes, and a paper we do not have is not a paper we failed on.
      return { status: 'skipped', reason: 'no document.file@v1 — nothing to extract from' }
    }

    // Lazy, like the citation parser's own loader: pdfjs is ESM-only and heavy,
    // and importing it at module scope would pull it into every CLI script that
    // merely reads the registry.
    const { extractPdfText } = await import('../../citations/extractText')

    let doc: Awaited<ReturnType<typeof extractPdfText>>
    try {
      // Geometry as well as text: superscript citation markers are invisible in
      // a plain string, and 18 of this corpus's 20 papers cite that way. The
      // text is byte-identical either way, so no stored citation parse moves.
      doc = await extractPdfText(file.absPath, { geometry: true })
    } catch (err) {
      // A read that was INTERRUPTED is worth retrying. A file that is broken,
      // absent, or locked is not, and treating it as transient burns all five
      // attempts, then reports the ceiling instead of the cause and badges the
      // job `transient` — which tells the user to wait when the fix is to
      // replace the file. Classified here because only this stage can see the
      // difference; the scheduler derives `error_kind` from `retryable` alone.
      const message = (err as Error).message
      const code = (err as NodeJS.ErrnoException).code
      const permanent =
        code === 'ENOENT' ||
        code === 'EACCES' ||
        code === 'EISDIR' ||
        /invalid pdf structure|no pdf header|password|encrypted|empty file|file is empty|invalid or corrupted/i.test(
          message
        )
      return {
        status: 'failed',
        error: `pdfjs could not read ${file.relativePath}: ${message}`,
        retryable: !permanent
      }
    }
    if (ctx.signal.aborted) return { status: 'failed', error: 'cancelled', retryable: true }

    // Build the canonical string and each page's span in it, in one pass, so
    // the offsets are exact by construction rather than recomputed later.
    const SEPARATOR = '\n\f\n'
    const pages: TextPage[] = []
    let text = ''
    for (const p of doc.pages) {
      if (text.length > 0) text += SEPARATOR
      const charStart = text.length
      text += p.text
      // Item offsets are page-local as pdfjs reports them; rebased ONCE, here,
      // into the canonical document space every downstream anchor uses. Leaving
      // two offset spaces in play is how anchors end up silently off by a page.
      pages.push({
        page: p.page,
        charStart,
        charEnd: text.length,
        text: p.text,
        items: p.items?.map((it) => ({
          str: it.str,
          charStart: charStart + it.charStart,
          charEnd: charStart + it.charEnd,
          height: it.height,
          baseline: it.baseline,
          x: it.x,
          width: it.width
        }))
      })
      ctx.progress((p.page / Math.max(1, doc.pages.length)) * 100, `page ${p.page}`)
      if (ctx.signal.aborted) return { status: 'failed', error: 'cancelled', retryable: true }
    }

    // The exact-slice contract, asserted rather than assumed. A violation is a
    // FAILURE, never an `empty`: an offset bug that presents as "this paper has
    // no prose" would be cached, satisfy every dependent, and leave the paper
    // permanently analysed as blank — the worst outcome this pipeline has.
    for (const p of pages) {
      if (text.slice(p.charStart, p.charEnd) !== p.text) {
        return {
          status: 'failed',
          error: `page ${p.page} violates the exact-slice contract (${p.charStart}..${p.charEnd})`,
          retryable: false
        }
      }
    }

    const meaningful = pages.filter((p) => p.text.trim().length >= THIN_PAGE_CHARS)
    if (meaningful.length === 0) {
      // A SCAN. There is a PDF, its pages are images, and pulling an embedded
      // text layer out of one was never applicable — `ocr` transforms the same
      // capability and reads it instead.
      //
      // `not-needed`, NOT `empty`, and the exact mirror of the case `ocr`
      // already handles from its side ("the PDF already has readable text, so
      // reading the scan would be worse"). One either/or, reported the same way
      // by both stages.
      //
      // It used to be `empty`, which put an amber "Nothing found" on the row
      // and filed the job for review — for a paper OCR then read in full:
      // 4/4 pages, 29,042 characters, 92% confidence, 119 paragraphs stored.
      // A reader sees that dot and concludes the paper has no text, which is
      // the opposite of the truth. A stage that correctly routed work elsewhere
      // has not fallen short of anything.
      //
      // If OCR then CANNOT run, the shortfall is reported by OCR, with the
      // reason that is actually actionable ("no eng.traineddata is packaged in
      // this build") — which is where someone would look for it.
      return {
        status: 'not-needed',
        reason: `This is a scan — its ${pages.length} ${pages.length === 1 ? 'page carries' : 'pages carry'} no text layer, so the text is read by OCR instead`
      }
    }

    const value: TextPages = {
      documentId: ctx.documentId,
      pageCount: pages.length,
      text,
      pages,
      source: 'pdf-text-layer'
    }
    ctx.emit('text.pages@v2', value)

    ctx.write({ contentStatus: 'fulltext', textSource: 'pdf-text-layer' })

    return {
      status: 'succeeded',
      result: { pageCount: pages.length, chars: text.length },
      note: `Read ${pages.length} ${pages.length === 1 ? 'page' : 'pages'}, ${text.length.toLocaleString()} characters`
    }
  },

  applyWrites(db, payload, ctx) {
    // `content_status` is a user-visible claim about what an analysis of this
    // document may be based on, so it follows the bytes actually read rather
    // than anyone's assertion about them.
    //
    // `text_source` is the SEPARATE axis: not how much of the paper we have,
    // but how the characters were obtained. A reader comparing this document
    // with an OCR'd one needs both answers, and `text_source_run_id` is what
    // lets `deleteRunOutput` retract this claim if the run is retired.
    const w = payload as { contentStatus: string; textSource: string }
    db.prepare(
      `UPDATE document
          SET content_status = ?, text_source = ?, text_confidence = NULL,
              text_source_run_id = ?
        WHERE id = ?`
    ).run(w.contentStatus, w.textSource, ctx.stageRunId, ctx.documentId)
  }
}

export default extractText
