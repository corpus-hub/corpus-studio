// Picture the tables on a paper, for any stage that must READ their values.
//
// WHY THIS IS SHARED. The extractor reads values off a page image because the
// text layer is not a faithful record of a table — this corpus stores
// `0 . 29 6 0 . 11` for `0.29 ± 0.11`, and a cell that spans two printed lines
// vanishes from all but the first, so a reading that counts entries
// left-to-right lands in the wrong column. Anything that AUDITS such a reading
// needs the same picture: a reviewer handed only the flattened text is asked to
// find a fault in the one artefact where the fault is invisible.
//
// The HUMAN reviewer is one of those auditors, which is why `cropsForWork` sits
// here rather than in an IPC handler: the Review screen must show the picture
// the extraction was read off, and a second implementation that merely rendered
// a similar-looking region would be a lookalike, not the evidence.

import { join } from 'node:path'
import type { DB } from '../db/connection'
import type { DocumentFile, TextPages } from './capabilities'
import { findTableRegions } from './regions'
import { cropRegion } from './cropRegion'
import { readArtifact } from './artifacts'
import { currentRunsOfStage } from './stageRun'
import { resolveRegistry } from './registry'
import { STAGES } from './stages/index'
import { canonQuote } from '../llm/pipeline'

/**
 * How many table crops one request may carry.
 *
 * Each is an image in the prompt, and images dominate a request's size. Four
 * covers every paper in this corpus (the most any one has is five regions, and
 * the fifth is a supplementary duplicate) while keeping the worst case bounded.
 */
export const MAX_CROPS = 4

/**
 * What the attempt to picture this paper's tables produced.
 *
 * The COUNTS travel with the images because "no crop" has several causes and
 * they are not equally benign. A paper with no tables needs no picture. A paper
 * whose tables were located and could not be rendered was read from text the
 * architecture does not trust for values — and that must not look the same.
 */
export interface TableCrops {
  /**
   * `page` and `label` are carried alongside the caption because the caption is
   * PROMPT text — a paragraph of instructions to a model — and a caller showing
   * the same picture to a person needs to say which table it is without
   * printing that paragraph at them.
   */
  images: Array<{
    png: Buffer
    caption?: string
    page: number
    label: string | null
    widthPx: number
    heightPx: number
    region: { page: number; x0: number; y0: number; x1: number; y1: number }
    scale: number
    originX: number
    originY: number
    /** Where a requested passage sits ON THIS IMAGE, in its own pixels. */
    marks?: Array<{ x: number; y: number; w: number; h: number }>
  }>
  /** Table regions the text layer located. */
  found: number
  /**
   * The page(s) a requested passage was found on, in document order, at most
   * two — a sentence legitimately breaks across a page and the reader needs both
   * halves. Empty when no passage was asked for or none matched.
   */
  quotePages: number[]
  /** Why the located tables could not be pictured, when that is the answer. */
  unavailable: string | null
}

/**
 * Render the paper's tables, so the model can READ values the text layer
 * garbles.
 *
 * Returns no image when the paper has no tables, when the page carries no
 * geometry, or when the PDF cannot be opened. In every one of those cases the
 * caller proceeds on text alone — the pictures are an ADDITION to the evidence,
 * never a precondition for it — but it is told which case it was, because on a
 * scan the difference is the difference between `1.37` and `137`.
 *
 * `caption` is the CALLER's, because what the picture is for differs by stage:
 * the extractor is told to read values out of it, the reviewer to check one
 * already-stored value against it.
 */
export async function renderTableCrops(
  file: DocumentFile | undefined,
  pages: TextPages | undefined,
  log: (m: string) => void,
  caption: (region: { page: number; label?: string | null }) => string
): Promise<TableCrops> {
  // `absPath` is DERIVED, not trusted: an artifact written before the field
  // existed carries only `baseDir` + `relativePath`, and reading the absent one
  // silently disables every crop on an older document.
  const absPath =
    file?.absPath ??
    (file?.baseDir && file?.relativePath ? join(file.baseDir, file.relativePath) : null)
  if (!absPath || !pages?.pages) {
    return { images: [], found: 0, unavailable: null, quotePages: [] }
  }
  const regions = pages.pages.flatMap((p) => findTableRegions(p.page, p.items))
  if (regions.length === 0) return { images: [], found: 0, unavailable: null, quotePages: [] }

  const { createRequire } = await import('node:module')
  const { readFileSync } = await import('node:fs')
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const mod = pdfjs as unknown as { GlobalWorkerOptions: { workerSrc: string } }
  if (!mod.GlobalWorkerOptions.workerSrc) {
    mod.GlobalWorkerOptions.workerSrc = createRequire(import.meta.url).resolve(
      'pdfjs-dist/legacy/build/pdf.worker.mjs'
    )
  }
  const out: TableCrops['images'] = []
  let doc: { getPage: (n: number) => Promise<unknown>; destroy?: () => Promise<void> } | null = null
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(readFileSync(absPath)),
      useSystemFonts: false,
      isEvalSupported: false,
      disableFontFace: true,
      verbosity: 0
    }).promise
    for (const region of regions.slice(0, MAX_CROPS)) {
      const page = (await doc.getPage(region.page)) as Parameters<typeof cropRegion>[0] & {
        cleanup?: () => void
      }
      try {
        const crop = await cropRegion(page, region)
        if (crop)
          out.push({
            png: crop.png,
            caption: caption(region),
            page: region.page,
            label: region.label ?? null,
            widthPx: crop.widthPx,
            heightPx: crop.heightPx,
            region,
            scale: crop.scale,
            originX: crop.originX,
            originY: crop.originY
          })
      } finally {
        // pdfjs runs its worker in-process here, so a decoded page stays on this
        // heap until its object store is cleared.
        page.cleanup?.()
      }
    }
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    log(`table crops unavailable: ${why}`)
    return { images: [], found: regions.length, unavailable: why, quotePages: [] }
  } finally {
    await doc?.destroy?.()
  }
  return {
    images: out,
    found: regions.length,
    unavailable: out.length === 0 ? 'every located table failed to render' : null,
    quotePages: []
  }
}

/**
 * The crops for a WORK, for a caller that is not a stage — i.e. the Review
 * screen, which must show the reviewer the picture the extraction was read off.
 *
 * Resolves `document.file@v1` and `text.pages@v2` from the CURRENT runs of the
 * stages that publish them, nearest provider last, which is the same answer a
 * consumer stage's `ctx.input` would give it. Deliberately not a new query over
 * `document`: a transformer (OCR) legitimately republishes the page text, and a
 * document-keyed read would pick whichever row it met first and could hand back
 * the pre-OCR layer for a scan — the one case where the picture matters most.
 *
 * Returns the empty result rather than throwing when a paper has no PDF, no
 * geometry or no tables. That is not an error: pictures are an ADDITION to the
 * evidence, and the caller is told which case it was via `found`/`unavailable`.
 */
export async function cropsForWork(
  db: DB,
  workId: number,
  log: (m: string) => void = () => {},
  /**
   * A passage to MARK on the pictures — the wording an extraction cited.
   *
   * Matched against the positioned text runs of the page, not against the
   * paragraph string: the runs are what carry `x`/`width`/`baseline`, and the
   * text layer's own spacing is unreliable (`27 u C`, `0 . 29 6 0 . 11`), so the
   * needle is compared with whitespace collapsed on BOTH sides. Runs recovered
   * by OCR have no geometry at all and simply do not match — silently, because
   * "we could not draw a box" must never read as "the paper does not say this".
   */
  quote?: string | null
): Promise<TableCrops> {
  const doc = db
    .prepare(
      `SELECT id FROM document WHERE work_id = ?
         ORDER BY (content_status = 'fulltext') DESC, id ASC LIMIT 1`
    )
    .get(workId) as { id: number } | undefined
  if (!doc) return { images: [], found: 0, unavailable: null, quotePages: [] }

  const registry = resolveRegistry(STAGES)
  const ctx = { db, workId, documentId: doc.id, projectId: 0 }

  // `providersFor(cap, index)` is the chain visible to a consumer AT `index`,
  // nearest first. Asking as of the end of the pipeline gives every provider,
  // and taking the first that actually published is exactly `resolveInput`'s
  // rule — so an OCR rewrite of the page text wins over the original layer.
  const latest = <T,>(cap: 'document.file@v1' | 'text.pages@v2'): T | undefined => {
    for (const provider of registry.providersFor(cap, registry.order.length)) {
      for (const run of currentRunsOfStage(db, provider.id, ctx, provider.scope)) {
        const v = readArtifact<T>(db, run.id, cap)
        if (v !== undefined) return v
      }
    }
    return undefined
  }

  const pages = latest<TextPages>('text.pages@v2')
  const file = latest<DocumentFile>('document.file@v1')
  const crops = await renderTableCrops(
    file,
    pages,
    log,
    (region) => `${region.label ?? 'Table'} (page ${region.page})`
  )
  if (!quote?.trim() || !pages?.pages) return crops

  return {
    ...crops,
    quotePages: pagesHolding(pages, quote),
    images: crops.images.map((img) => ({ ...img, marks: marksFor(img, pages, quote) }))
  }
}

/**
 * Which pages carry `quote`, at most two.
 *
 * Two because a sentence legitimately breaks across a page and the reader needs
 * both halves; more than two would mean the needle matched something far too
 * common to be evidence of anything. Uses the SAME canonical form the mark is
 * located with, so the page named here is the page the highlight lands on.
 */
function pagesHolding(pages: TextPages, quote: string): number[] {
  const needle = canonQuote(quote)
  if (needle.length < 2) return []
  const out: number[] = []
  for (const p of pages.pages) {
    if (!p.items) continue
    if (canonQuote(p.items.map((i) => i.str).join(' ')).includes(needle)) out.push(p.page)
    if (out.length === 2) break
  }
  if (out.length > 0) return out
  // The sentence may straddle a break, so no single page holds all of it.
  for (let i = 0; i < pages.pages.length - 1; i++) {
    const a = pages.pages[i]
    const b = pages.pages[i + 1]
    if (!a.items || !b.items) continue
    if (canonQuote([...a.items, ...b.items].map((x) => x.str).join(' ')).includes(needle))
      return [a.page, b.page]
  }
  return []
}

/**
 * Where `quote` sits on one rendered crop, in that image's own pixels.
 *
 * Walks the page's positioned runs and keeps those whose text falls inside the
 * needle, then groups them into lines by baseline. Returns [] rather than a
 * guess whenever the run geometry is absent (OCR pages) or the wording cannot be
 * found — an approximate box drawn over a table would assert that the model
 * cited a cell it did not.
 */
function marksFor(
  img: { region: { page: number; x0: number; y0: number; x1: number; y1: number }; scale: number; originX: number; originY: number },
  pages: TextPages,
  quote: string
): Array<{ x: number; y: number; w: number; h: number }> {
  const page = pages.pages.find((p) => p.page === img.region.page)
  if (!page?.items) return []
  const needle = canonQuote(quote)
  if (needle.length < 2) return []

  // WHERE THE NEEDLE IS — the same index PdfDocView builds to place a highlight.
  //
  // That component canonicalises CHARACTER BY CHARACTER, each canonical
  // character keeping a pointer back to the glyph that produced it, and its
  // comment says why it must: guessing the mapping desynchronises the offsets.
  // The same shape is built here over text runs instead of DOM spans.
  //
  // Matching whole runs cannot work, which is what two earlier versions of this
  // got wrong: `needle.includes(runText)` lit up every run reading "0" in a
  // kinetics table, and requiring a window of whole runs to EQUAL the needle
  // matched nothing at all — the text layer splits mid-phrase, so `27 u C`
  // arrives as `…plate reader at 27` + ` ` + `u` + `C in at least three`.
  const owner: number[] = []
  let canonPage = ''
  for (let i = 0; i < page.items.length; i++) {
    const c = canonQuote(page.items[i].str)
    canonPage += c
    for (let k = 0; k < c.length; k++) owner.push(i)
  }
  const at = canonPage.indexOf(needle)
  // Not found is NOT "mark something near it": an approximate box would assert
  // the model cited a passage it did not.
  if (at === -1) return []
  const firstRun = owner[at]
  const lastRun = owner[at + needle.length - 1]
  const hits = page.items
    .slice(firstRun, lastRun + 1)
    .filter((it) => it.x !== undefined && it.width !== undefined)
    // Only runs inside the rendered region — for a table crop that is the table,
    // for a whole page it is everything.
    .filter(
      (it) =>
        (it.x as number) + (it.width as number) > img.region.x0 &&
        (it.x as number) < img.region.x1 &&
        it.baseline > img.region.y0 &&
        it.baseline < img.region.y1
    )
  if (hits.length === 0) return []

  // One box per LINE: adjacent runs on a shared baseline are a phrase, and a box
  // per glyph run would draw a row of disconnected rectangles across a number.
  const byLine = new Map<number, typeof hits>()
  for (const h of hits) {
    const k = Math.round(h.baseline)
    const l = byLine.get(k)
    if (l) l.push(h)
    else byLine.set(k, [h])
  }
  // Geometry follows PdfDocView's highlight renderer, which solved this once:
  // horizontal breathing room so the tint clears the glyph edges, and lines that
  // ADJOIN at the midpoint of the leading rather than each padding vertically —
  // padding every line independently is what made consecutive ones overlap and
  // leave a dark seam down the passage.
  const HL_PAD_X = 4 / img.scale
  const lines = [...byLine.entries()]
    .sort(([a], [b]) => b - a) // PDF y grows UP, so a larger baseline is higher
    .map(([, line]) => ({
      x0: Math.min(...line.map((h) => h.x as number)) - HL_PAD_X,
      x1: Math.max(...line.map((h) => (h.x as number) + (h.width as number))) + HL_PAD_X,
      top: Math.max(...line.map((h) => h.baseline + h.height)),
      bot: Math.min(...line.map((h) => h.baseline))
    }))

  const out: Array<{ x: number; y: number; w: number; h: number }> = []
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const prev = lines[i - 1]
    const next = lines[i + 1]
    const top = prev ? (prev.bot + l.top) / 2 : l.top
    const bot = next ? (l.bot + next.top) / 2 : l.bot
    out.push({
      x: (l.x0 - img.originX) * img.scale,
      y: (img.originY - top) * img.scale,
      w: (l.x1 - l.x0) * img.scale,
      h: (top - bot) * img.scale
    })
  }
  return out
}
