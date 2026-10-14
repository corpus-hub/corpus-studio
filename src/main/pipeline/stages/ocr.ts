// Reading a scanned paper, as a `text.pages@v2` TRANSFORMER.
//
// It runs only when there is nothing to transform, which sounds backwards and
// is exactly right. `extract-text` returns `empty` on a scan ("N pages carry no
// text layer"), and `resolveInput` treats `empty` as a positive claim rather
// than a gap — so `ctx.input('text.pages@v2')` is `undefined` here precisely
// when the paper needs OCR, and holds real pages when it does not. This stage
// therefore reads as:
//
//   input present  -> `skipped`, and the fall-through hands `segment` the text
//                     layer, untouched. No `if (ocred)` anywhere downstream.
//   input absent   -> OCR, and publish the SAME token so every consumer of
//                     `text.pages@v2` is served without knowing this stage
//                     exists.
//
// Being a transformer rather than a second producer is what makes that work:
// the registry orders it after `extract-text` and before `segment`, and
// `dependenciesFor` gives `segment` an edge on BOTH providers, so segmentation
// cannot start until this has had its chance.
//
// The output is MARKED. An OCR'd document is not a lower-quantity document —
// it is the full text, read imperfectly — so `content_status` stays `fulltext`
// and the confidence lives on its own axis, `document.text_source` +
// `text_confidence`. Folding OCR into that closed 5-value enum would make
// "we only have the abstract" and "we have all of it, at 89 % character
// confidence" indistinguishable, and a reader acts on those differently.

import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tessdataDir } from '../../resources'
import { chooseArticle, titlePresence } from '../../ocr/articles'
import { rasterisePage, RASTER_LONG_EDGE, type PageBitmap } from '../../ocr/raster'
// Relative, not the `@shared` alias: this module is bundled into the stage
// HOST, which is loaded by tooling that does not always carry the tsconfig path
// mapping. `licences.ts` imports the contract the same way for the same reason.
import { OCR_LOW_CONFIDENCE } from '../../../shared/contract'
import type {
  DocumentFile,
  OcrPageGeometry,
  OcrWord,
  TextItem,
  TextPage,
  TextPages,
  WordBoxes
} from '../capabilities'
import type { StageDefinition } from '../types'

/**
 * Mean character confidence below which the run is flagged for review.
 *
 * Not a failure: 60 % is poor but readable, and discarding it would leave the
 * paper with no text at all. It is a claim the user may want to check, which is
 * what `review` means here.
 *
 * The SAME number the badge uses to downgrade "OCR" to "OCR, poorly read", so
 * the queue and the paper screen cannot disagree about one document.
 */
const LOW_CONFIDENCE = OCR_LOW_CONFIDENCE

/** Below this a page produced nothing worth calling text. */
const THIN_PAGE_CHARS = 40

interface OcrWrite {
  contentStatus: string
  textSource: string
  confidence: number
}

/**
 * The `eng.traineddata` we will read, identified by size and hash prefix.
 *
 * NEVER THROWS, deliberately: `decideCache` runs outside the stage's own error
 * handling, so an exception here escapes as an unhandled failure instead of the
 * `skipped` this situation deserves.
 *
 * But a failure must not resolve to a CONSTANT either, and that was the flaw in
 * the previous version. `'tessdata|unreadable'` was one cache key for every way
 * the model can be unavailable, so two genuinely different broken states shared
 * a fingerprint — and, worse, a state could persist across a real change: a file
 * whose permissions are fixed but whose bytes also changed still fingerprints
 * differently, while two successive broken states did not, so a plan cached
 * against one unreadable model was reused against another. The fingerprint's
 * whole job is to change when what it identifies changes.
 *
 * So what IS knowable is folded in — the errno, and the size and mtime where
 * `statSync` got that far. None of it identifies the model, and it is not meant
 * to: it identifies the SITUATION, so that a different situation gets a
 * different key and a fixed model necessarily invalidates the cache.
 */
function traineddataIdentity(): string {
  const path = join(tessdataDir(), 'eng.traineddata')
  let size: number | null = null
  let mtimeMs: number | null = null
  try {
    if (!existsSync(path)) return 'tessdata|absent'
    const stat = statSync(path)
    size = stat.size
    mtimeMs = Math.trunc(stat.mtimeMs)
    // Size plus a hash of the FIRST 64 KB, read with an explicit file handle so
    // the rest of the 4 MB is never touched: this runs on every plan of every
    // document, and a re-trained model matching both the size and the opening
    // block would be a remarkable coincidence.
    const fd = openSync(path, 'r')
    try {
      const head = Buffer.alloc(Math.min(65_536, stat.size))
      readSync(fd, head, 0, head.length, 0)
      return `tessdata|${stat.size}|${createHash('sha256').update(head).digest('hex').slice(0, 16)}`
    } finally {
      closeSync(fd)
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? 'unknown'
    // Whatever was learned before the failure. `stat` alone changing is enough
    // to re-plan, which is the case that matters: a model replaced while still
    // unreadable is a different model.
    return `tessdata|unreadable|${code}|${size ?? '?'}|${mtimeMs ?? '?'}`
  }
}

/** Tesseract's per-word output, as much of it as this stage reads. */
interface TessWord {
  text?: string
  confidence?: number
  bbox?: { x0: number; y0: number; x1: number; y1: number }
}

/** The nested block/paragraph/line/word tree `output.blocks` returns. */
interface TessBlock {
  paragraphs?: Array<{ lines?: Array<{ words?: TessWord[] }> }>
}

/**
 * Give every recognised word its span in the page text, by a FORWARD SCAN.
 *
 * The page text is taken exactly as tesseract rendered it and is never rebuilt
 * from the words. That is the whole point: `data.text` is what the canonical
 * document string is assembled from, and every stored anchor in the database
 * indexes into it, so re-joining words with our own spacing would move
 * characters under evidence spans and citation contexts that already point at
 * them. Verified on this corpus's scan: requesting `blocks` leaves `data.text`
 * byte-identical to the run that stored no geometry.
 *
 * The scan works because `blocks` walks the page in the same reading order that
 * produced `text`; a cursor that only ever moves forward therefore cannot match
 * an earlier occurrence of a repeated word. A word that does not appear at or
 * after the cursor is DROPPED rather than placed approximately — a box over the
 * wrong glyphs is worse than a gap in the layer, because it reads as correct.
 */
function alignWords(
  blocks: TessBlock[] | null | undefined,
  pageText: string
): { words: OcrWord[]; dropped: number } {
  const out: OcrWord[] = []
  let cursor = 0
  let dropped = 0
  for (const b of blocks ?? []) {
    for (const p of b.paragraphs ?? []) {
      for (const l of p.lines ?? []) {
        for (const w of l.words ?? []) {
          const t = w.text ?? ''
          const box = w.bbox
          if (!t || !box) continue
          const at = pageText.indexOf(t, cursor)
          // A match far past the cursor means the traversal and the serialised
          // text have diverged — which happens on a multi-column or table-heavy
          // page, where tesseract's block order need not equal the order it
          // wrote `text` in. Left unchecked the cursor overshoots and EVERY
          // later word attaches to a subsequent duplicate, drifting for the rest
          // of the page with nothing to reveal it. Anything but whitespace
          // between the cursor and the match is therefore refused. Measured on
          // this corpus's scan the largest legitimate gap is a single character,
          // so the guard rejects nothing that was working.
          if (at < 0 || pageText.slice(cursor, at).trim().length > 0) {
            dropped++
            continue
          }
          const gapStart = cursor
          cursor = at + t.length
          if (out.length > 0) out[out.length - 1].gap = pageText.slice(gapStart, at)
          out.push({
            charStart: at,
            charEnd: cursor,
            text: t,
            gap: '',
            x0: box.x0,
            y0: box.y0,
            x1: box.x1,
            y1: box.y1,
            confidence: w.confidence ?? 0
          })
        }
      }
    }
  }
  return { words: out, dropped }
}

const ocr: StageDefinition<{ pages: number; chars: number; confidence: number }> = {
  id: 'ocr',
  label: 'Read scanned pages',
  version: '1.3.0',
  // Between extract-text (3) and segment (4). `rank` breaks ties WITHIN a
  // topological layer only; the real ordering comes from the token.
  rank: 3.5,
  scope: 'document',
  provides: ['text.pages@v2', 'text.wordboxes@v1'],
  requires: ['text.pages@v2', 'document.file@v1'],
  transforms: 'text.pages@v2',
  usesLlm: false,
  runtime: 'node',
  // ~12 s/page. In main this would freeze the database, the IPC and the window
  // for the length of the whole paper.
  isolation: 'host',
  weight: 'heavy',
  // KILL-ONLY, and now honoured rather than declared: tesseract's recognition
  // runs in a nested worker and cannot be interrupted mid-page, so a cancel
  // that waits politely is a cancel that does not happen for twelve seconds.
  cancelGraceMs: 0,

  // Tool identity, which is what makes a cached `skipped` safe. Without it
  // "no traineddata" would be cached forever: the user provisions the payload
  // and nothing ever re-runs, because from the cache's point of view no input
  // changed. The raster parameters are in here too — changing them changes the
  // characters recognised, so it must supersede the run.
  fingerprint() {
    // `geom=1` is part of the identity because a cached run from before word
    // geometry produced the same characters and no boxes at all. Without it the
    // cache would answer "nothing changed" and the scanned paper would keep its
    // textless run forever, which is the state this stage was fixed to leave.
    return `${traineddataIdentity()}|raster=${RASTER_LONG_EDGE}|geom=1`
  },

  async execute(ctx) {
    const existing = ctx.input<TextPages>('text.pages@v2')
    if (existing) {
      // `not-needed`, not `skipped`. Nothing is absent here: the PDF has real
      // embedded text, and OCR would REPLACE it with a worse transcription. So
      // declining is this stage succeeding, and it is reported as a success —
      // the alternative put a paragraph of explanation under every born-digital
      // paper in the corpus, which is most of them, for a non-event.
      return {
        status: 'not-needed',
        reason: `Not needed — the PDF already has readable text on all ${existing.pageCount} pages, and reading the scan would be worse`
      }
    }

    const file = ctx.input<DocumentFile>('document.file@v1')
    if (!file) return { status: 'skipped', reason: 'no document.file@v1 — nothing to read' }

    if (!existsSync(join(tessdataDir(), 'eng.traineddata'))) {
      // `skipped`, not `failed`. A missing optional payload is a fact about
      // this build, not a broken paper — and the fingerprint above carries it,
      // so shipping the payload re-runs this.
      return {
        status: 'skipped',
        reason: 'no eng.traineddata is packaged in this build; the scan cannot be read'
      }
    }

    const { createWorker, PSM } = await import('tesseract.js')
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')

    // pdfjs runs its worker in-process under Node, but STILL refuses to load a
    // document without a workerSrc — it throws `No "GlobalWorkerOptions.
    // workerSrc" specified` before reading a byte. `extractText.ts` has always
    // set it; this stage did not, so every OCR attempt on the corpus's one
    // scanned paper failed 15 times over, the paper never gained a paragraph
    // inventory, and the extraction that followed had nothing to anchor
    // against. Point it at the LOCAL legacy worker bundle — never a CDN.
    const pdfjsMod = pdfjs as unknown as { GlobalWorkerOptions: { workerSrc: string } }
    if (!pdfjsMod.GlobalWorkerOptions.workerSrc) {
      const req = createRequire(import.meta.url)
      pdfjsMod.GlobalWorkerOptions.workerSrc = req.resolve(
        'pdfjs-dist/legacy/build/pdf.worker.mjs'
      )
    }

    // langPath IS the offline story. Left unset, tesseract.js defaults it to a
    // cdn.jsdelivr.net URL and downloads eng.traineddata on first use —
    // reproduced twice during the research. With it local and the file absent
    // it fails with ENOENT instead: loud, not degraded. `cacheMethod: 'none'`
    // additionally stops it writing a copy beside the process cwd, and
    // `gzip: false` selects the plain file we actually ship.
    // `eng` ALONE, and deliberately so.
    //
    // `equ` — tesseract's mathematical model — looks like the obvious addition
    // here, and it is a trap: it ships LEGACY components only (`inttemp`, no
    // `lstm`). Loading `eng+equ` therefore drags the whole recognition off the
    // LSTM engine and onto the 2016 shape classifier, which reads a scan far
    // worse than the model it replaced. Tesseract says so and carries on:
    // `LSTM requested, but not present!! Loading tesseract.` — a warning on
    // stderr, not an error, so the run completes and simply gets worse output.
    //
    // What DID move the needle is the model itself: `tessdata_best` rather than
    // `tessdata_fast`. Scientific notation is exactly where the fast model
    // loses — this corpus's 1973 scan returned `0.71 ± 0.04` as `0.7140.04`,
    // the sign gone and the numbers fused into one run of digits.
    const worker = await createWorker('eng', 1, {
      langPath: tessdataDir(),
      cachePath: tessdataDir(),
      cacheMethod: 'none',
      gzip: false,
      logger: () => {}
    })

    // Detect the page LAYOUT before reading it. Tesseract's own default is
    // PSM 6, "assume a single uniform block of text", and tesseract.js only
    // overrides that transiently for `rotateAuto` — so a two-column journal
    // scan is read straight across the gutter. On this corpus's one scan that
    // joined the left and right columns of every LINE into a single sentence:
    // "a diffraction efficiency (a few tens with different phase masks, and
    // their comparison with a corre-". Every character was recognised (94%
    // confidence, 28 672 of them) and every sentence was gibberish, so the
    // paper segmented into 27 unreadable paragraphs and extraction found
    // nothing in it — a silent, confident, whole-paper loss.
    //
    // PSM 3 runs page-layout analysis first and returns the columns as
    // separate blocks in reading order. Measured on page 1 of that scan:
    // 1 block spanning the full 1406px width becomes 14 blocks of ~675px, and
    // the prose reads down each column as written.
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.AUTO,
      // KEEP THE SPACES. Tesseract collapses runs of whitespace by default, and
      // in a table that is not cosmetic: `0.71 ± 0.04` reduced to `0.7140.04`
      // is two numbers and a sign welded into one token, and `1.37 ± 0.12` to
      // `1374012`. Where the spacing survived on the same page, so did the
      // symbol — `2.07+0.49` kept both. The two failures compound, so the
      // cheapest half of the fix is to stop discarding the separator that says
      // where one number ends.
      preserve_interword_spaces: '1'
    })

    let doc: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']> | null = null
    try {
      doc = await pdfjs.getDocument({
        data: new Uint8Array(readFileSync(file.absPath)),
        // The same offline, no-eval settings the citation extractor uses. Under
        // our CSP `isEvalSupported` must be off, and system fonts must not be
        // consulted for a document nobody is rendering.
        isEvalSupported: false,
        useSystemFonts: false,
        disableFontFace: true
      }).promise

      const SEPARATOR = '\n\f\n'
      const pages: TextPage[] = []
      const geometry: OcrPageGeometry[] = []
      const confidences: number[] = []
      let text = ''
      let unreadable = 0

      for (let n = 1; n <= doc.numPages; n++) {
        if (ctx.signal.aborted) return { status: 'failed', error: 'cancelled', retryable: true }

        const page = await doc.getPage(n)
        let pageText = ''
        let confidence = 0
        let pageWords: OcrWord[] = []
        let pageRaster: PageBitmap | null = null
        try {
          const bitmap = await rasterisePage(pdfjs as never, page as never)
          if (!bitmap) {
            // No image on the page and no text layer either. REPORTED, not
            // silently blank: a born-digital vector page is rare but real, and
            // a paper that quietly lost a page is the failure this pipeline is
            // most careful about.
            unreadable++
            ctx.log(`page ${n} carries no readable image`)
          } else {
            // `blocks` must be asked for: tesseract.js v6 defaults `output` to
            // `{ text: true }` and throws the word tree away, which is why the
            // earlier run recovered 28 672 characters and no geometry at all —
            // leaving the scan rendered as a bare image with nothing to select.
            // `text` stays on and stays AUTHORITATIVE; the boxes are aligned to
            // it rather than the other way round.
            const { data } = await worker.recognize(bitmap.bmp, {}, { text: true, blocks: true })
            pageText = data.text ?? ''
            confidence = data.confidence ?? 0
            if (pageText.trim().length >= THIN_PAGE_CHARS) confidences.push(confidence)
            const aligned = alignWords(data.blocks as TessBlock[] | null, pageText)
            pageWords = aligned.words
            pageRaster = bitmap
            // REPORTED, never silent. A page whose words mostly failed to align
            // still renders a text layer, and one that covers 40 % of the page
            // while looking complete is the failure mode this stage is most
            // careful about elsewhere — so the coverage is on the record.
            if (aligned.dropped > 0) {
              ctx.log(
                `page ${n}: ${aligned.dropped} of ${aligned.dropped + pageWords.length} ` +
                  'recognised word(s) could not be placed and carry no selectable text'
              )
            }
          }
        } finally {
          // pdfjs runs its worker IN-PROCESS in Node, so the decoded ~32 MB
          // bitmap lives in this heap until the page's object store is cleared.
          // `cleanup()` returns false without throwing when an operator list is
          // still open, so the result is CHECKED — a silent false on a 300-page
          // scan is an out-of-memory in a host that outlives this job.
          if (page.cleanup() === false) ctx.log(`page ${n} could not be released`)
        }

        if (text.length > 0) text += SEPARATOR
        const charStart = text.length
        text += pageText
        // `items` FROM THE WORD BOXES, because tesseract does report geometry —
        // it is the placement that was missing, not the boxes.
        //
        // Leaving this empty cost the scans the one thing they needed most: a
        // table is located from item boxes, so `findTableRegions` returned
        // nothing for an OCR'd page, no crop was rendered, and the model read
        // the paper from OCR text ALONE. That is backwards — a scan is exactly
        // where the text is least trustworthy and the picture matters most. This
        // corpus's 1973 scan stores `474 ± 14` as `47414`, and with no image
        // beside it the digits were split wrongly into `47 ± 14`.
        //
        // The conversion is the placement matrix recorded just below, applied
        // exactly as `PageBitmap.placement` documents it: PDF paints an image
        // into the UNIT SQUARE, so a raster pixel `(px, py)` — py DOWNWARDS, as
        // image rows are stored — sits at `u = px/width`, `v = 1 - py/height`,
        // and the matrix carries `(u, v)` to user space. Scaling the pixels
        // directly by the matrix would be wrong by the raster's whole size.
        //
        // `baseline` is the box's BOTTOM edge in user space, which is what a
        // baseline means for a recognised word, and `height` its true height —
        // so a consumer cannot tell these items from a born-digital page's.
        const items: TextItem[] = []
        if (pageRaster && pageWords.length > 0) {
          const [a, b, c, d, e, f] = pageRaster.placement
          const toUser = (px: number, py: number): { x: number; y: number } => {
            const u = px / pageRaster.width
            const v = 1 - py / pageRaster.height
            return { x: a * u + c * v + e, y: b * u + d * v + f }
          }
          for (const w of pageWords) {
            const tl = toUser(w.x0, w.y0)
            const br = toUser(w.x1, w.y1)
            const left = Math.min(tl.x, br.x)
            const right = Math.max(tl.x, br.x)
            const bottom = Math.min(tl.y, br.y)
            const top = Math.max(tl.y, br.y)
            items.push({
              str: w.text,
              charStart: charStart + w.charStart,
              charEnd: charStart + w.charEnd,
              height: top - bottom,
              baseline: bottom,
              x: left,
              width: right - left
            })
          }
        }
        pages.push({
          page: n,
          charStart,
          charEnd: text.length,
          text: pageText,
          ...(items.length > 0 ? { items } : {})
        })

        // Word spans are rebased onto the CANONICAL document string here, once,
        // rather than left page-relative. Every other anchor in the database is
        // a document offset, so a consumer holding a page-relative one would
        // have to re-derive `charStart` to compare them — and the first consumer
        // that forgot would silently highlight page 1 for a quote on page 4.
        if (pageRaster && pageWords.length > 0) {
          geometry.push({
            page: n,
            rasterWidth: pageRaster.width,
            rasterHeight: pageRaster.height,
            placement: pageRaster.placement,
            words: pageWords.map((w) => ({
              ...w,
              charStart: charStart + w.charStart,
              charEnd: charStart + w.charEnd
            }))
          })
        }

        ctx.progress((n / doc.numPages) * 100, `page ${n} of ${doc.numPages}`)
      }

      // The exact-slice contract, asserted rather than assumed — the same
      // discipline `extract-text` applies, and for the same reason: a violation
      // presenting as "this paper has no prose" would be cached, would satisfy
      // every dependent, and would leave the paper permanently blank.
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

      // NOTHING WAS EVEN RASTERISED. That is a failure of this stage — an image
      // format we cannot unpack, or a pdfjs API that moved — and NOT a claim
      // about the paper. Reporting it as `empty` would cache it, satisfy every
      // dependent, and leave the document permanently and silently blank while
      // looking like a considered answer. Retryable, because the next build may
      // simply understand the format.
      if (unreadable === pages.length && pages.length > 0) {
        return {
          status: 'failed',
          error:
            `none of ${pages.length} page(s) yielded an image this stage can read; ` +
            'the pages were never rasterised, so nothing was OCR\'d',
          retryable: true
        }
      }

      if (meaningful.length === 0) {
        // Now a real, checkable claim: pages WERE rasterised and nothing legible
        // came back. Terminal and cached, and the job lands in `review` rather
        // than red, because a blank or purely pictorial scan is a fact about the
        // paper rather than a fault in the reader.
        return {
          status: 'empty',
          reason:
            `${pages.length} page(s) were rasterised and none yielded readable text ` +
            `(${unreadable} carried no image at all)`
        }
      }

      const meanConfidence =
        confidences.reduce((s, c) => s + c, 0) / Math.max(1, confidences.length)

      // WHICH ARTICLE ON THE SHEET IS THIS PAPER.
      //
      // A journal page carries several articles and OCR reads all of them, so
      // up to here `text` is the SHEET rather than the paper. Keeping the whole
      // sheet stored a different paper's prose under this work's name — 38 % of
      // work 16's inventory was two unrelated articles — and everything
      // downstream read it as one document.
      const workTitle = ctx.db.work()?.title ?? ''
      const choice = chooseArticle(geometry, text, workTitle)
      if (choice.kind === 'ambiguous') {
        // REFUSED, loudly, rather than served. This page has several articles
        // on it and none of them is recognisably the one this work claims to
        // be, so any span we picked would be a guess — and a document holding
        // the wrong paper's text reads as correct everywhere it is used, which
        // is far worse than a document with no text at all. Terminal: another
        // attempt reads the same sheet and reaches the same fork.
        return {
          status: 'failed',
          error:
            `this scan carries ${choice.candidates.length} articles and none matches ` +
            `"${workTitle}" well enough to tell them apart ` +
            `(${choice.candidates
              .map((c) => `${(c.score * 100).toFixed(0)}% "${c.title}"`)
              .join('; ')}) — storing one of them would attribute another paper's ` +
            'text to this work',
          retryable: false
        }
      }
      if (choice.kind === 'selected') {
        const { charStart, charEnd } = choice.span
        text = text.slice(charStart, charEnd)
        for (const p of pages) {
          const s = Math.min(Math.max(p.charStart, charStart), charEnd) - charStart
          const e = Math.min(Math.max(p.charEnd, charStart), charEnd) - charStart
          p.charStart = s
          p.charEnd = e
          p.text = text.slice(s, e)
        }
        for (const g of geometry) {
          g.words = g.words
            .filter((w) => w.charStart >= charStart && w.charEnd <= charEnd)
            .map((w) => ({ ...w, charStart: w.charStart - charStart, charEnd: w.charEnd - charStart }))
        }
        ctx.log(
          `this page carries ${choice.others.length + 1} articles; kept the one titled ` +
            `"${choice.span.title?.text ?? ''}" (${(choice.score * 100).toFixed(0)}% of the ` +
            `work's title) and dropped ${choice.others.length} neighbour(s): ` +
            choice.others.map((o) => `"${o.text}"`).join(', ')
        )
      }

      // The exact-slice contract again, because the trim above MOVED every
      // offset. A page whose span no longer slices to its own text would leave
      // every downstream anchor pointing at characters that shifted, which is
      // the failure the first assertion exists to catch and the trim is the
      // only thing in this stage that can cause it.
      for (const p of pages) {
        if (text.slice(p.charStart, p.charEnd) !== p.text) {
          return {
            status: 'failed',
            error: `page ${p.page} violates the exact-slice contract after the article trim`,
            retryable: false
          }
        }
      }

      const value: TextPages = {
        documentId: ctx.documentId,
        pageCount: pages.length,
        text,
        pages,
        source: 'ocr'
      }
      ctx.emit('text.pages@v2', value)
      // Emitted even when EMPTY, so the difference between "this run captured no
      // geometry" and "this run predates geometry entirely" stays visible: the
      // artifact's absence is what tells the viewer there is nothing to draw,
      // and an absent artifact that might equally mean an old run would leave it
      // guessing.
      ctx.emit('text.wordboxes@v1', {
        documentId: ctx.documentId,
        meanConfidence,
        pages: geometry
      } satisfies WordBoxes)
      ctx.write({
        contentStatus: 'fulltext',
        textSource: 'ocr',
        confidence: meanConfidence
      } satisfies OcrWrite)

      const flags: string[] = []
      if (meanConfidence < LOW_CONFIDENCE) flags.push('LOW CONFIDENCE')
      if (unreadable > 0) flags.push(`${unreadable} page(s) unreadable`)
      // The backstop for a split that could not run. Without word geometry no
      // title block is findable, so a multi-article sheet looks single-article
      // and passes through whole — silently, which is the one thing this stage
      // must not do about the wrong paper. It is a FLAG rather than a failure
      // because a scan legitimately beginning after the title page would fail
      // the same test, and refusing a paper we can read over a check that
      // cannot tell those apart trades a silent error for a loud one.
      const presence = workTitle.length > 0 ? titlePresence(text, workTitle) : 1
      if (presence < 0.5) {
        flags.push(
          `the work's title is ${(presence * 100).toFixed(0)}% present in this text — ` +
            'check this is the right paper'
        )
      }

      return {
        status: 'succeeded',
        result: { pages: pages.length, chars: text.length, confidence: meanConfidence },
        note:
          `${pages.filter((p) => p.text.trim().length >= THIN_PAGE_CHARS).length}/` +
          `${pages.length} page(s) read, ${text.length} characters, ` +
          `${meanConfidence.toFixed(0)}% mean confidence` +
          (flags.length > 0 ? ` — ${flags.join('; ')}` : '')
      }
    } finally {
      // Both in a `finally`, both best-effort: this host is REUSED across
      // jobs, so a leaked tesseract worker (~300 MB) or an undestroyed pdfjs
      // document accumulates until the process is killed for the wrong reason.
      try {
        await worker.terminate()
      } catch {
        /* already gone; the host's exit is the backstop */
      }
      try {
        await doc?.destroy()
      } catch {
        /* nothing further to release */
      }
    }
  },

  applyWrites(db, payload, ctx) {
    const w = payload as OcrWrite
    // `text_source_run_id` is what makes this claim RETRACTABLE. These are
    // DOCUMENT columns, so they outlive the run that wrote them and
    // `deleteRunOutput` would otherwise have no way to reach them — leaving a
    // superseded or cancelled OCR run's badge asserting a confidence nothing
    // currently stands behind.
    db.prepare(
      `UPDATE document
          SET content_status = ?, text_source = ?, text_confidence = ?, text_source_run_id = ?
        WHERE id = ?`
    ).run(w.contentStatus, w.textSource, w.confidence, ctx.stageRunId, ctx.documentId)
  }
}

export default ocr
