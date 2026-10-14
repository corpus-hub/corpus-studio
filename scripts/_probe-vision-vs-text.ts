// A/B on ONE document: same prompt, same text, with and without the crops.
import { openDatabaseReadOnly } from '../src/main/db/connection'
import { defaultDbPath } from '../src/main/db/paths'
import { selectProvider } from '../src/main/llm/select'
import { getPrompt, tagParagraphs } from '../src/main/llm/prompts'
import { extractJson } from '../src/main/llm/provider'
import { locateQuoteForTest } from '../src/main/llm/pipeline'
import { readFileSync } from 'node:fs'
const DOCID = Number(process.argv[process.argv.indexOf('--doc') + 1] || 1)
const db = openDatabaseReadOnly(defaultDbPath())
const canon = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{Nd}]+/gu, '')
async function main(): Promise<void> {
  const sel = await selectProvider({ mode: 'live' })
  // Segment FRESH, exactly as the stage would: measuring against stored
  // paragraphs from an older segmenter compares the model's answer to a
  // document it was never shown.
  const { extractPdfText } = await import('../src/main/citations/extractText')
  const { join } = await import('node:path')
  const fl = db.prepare(`SELECT b.abs_path AS base, l.relative_path AS rel
      FROM file_location l JOIN base_dir b ON b.id=l.base_dir_id WHERE l.document_id=${DOCID}`).get() as {base:string;rel:string}
  const xdoc = await extractPdfText(join(fl.base, fl.rel), { geometry: true })
  const segMod = await import('../src/main/pipeline/stages/segment')
  const segStage = (segMod as { default: { execute: (c: unknown) => Promise<unknown> } }).default
  const segOut: Array<{ text: string; kind: string }> = []
  await segStage.execute({
    input: (cap: string) => cap === 'text.pages@v2' ? { pageCount: xdoc.pages.length, text: xdoc.text, pages: xdoc.pages } : undefined,
    emit: (_c: string, v: { paragraphs: Array<{ text: string; kind: string }> }) => segOut.push(...v.paragraphs),
    write: () => {}, progress: () => {}, log: () => {}, signal: { aborted: false }
  } as never)
  const paras = segOut.filter((p) => p.kind !== 'reference').map((p) => p.text)
  const sys = getPrompt('extraction').system
  const user = tagParagraphs(paras.join('\n\n'))
  const { findTableRegions } = await import('../src/main/pipeline/regions')
  const { cropRegion } = await import('../src/main/pipeline/cropRegion')
  const { createRequire } = await import('node:module')
  const pdfjsMod = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const gm = pdfjsMod as unknown as { GlobalWorkerOptions: { workerSrc: string } }
  if (!gm.GlobalWorkerOptions.workerSrc) gm.GlobalWorkerOptions.workerSrc = createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
  const regions = xdoc.pages.flatMap((pg) => findTableRegions(pg.page, pg.items as never))
  const pdoc = await pdfjsMod.getDocument({ data: new Uint8Array(readFileSync(join(fl.base, fl.rel))), useSystemFonts: false, isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise
  const images: Array<{ png: Buffer; caption: string }> = []
  for (const r of regions.slice(0, 4)) {
    const pg = await pdoc.getPage(r.page)
    const c = await cropRegion(pg as never, r)
    if (c) images.push({ png: c.png, caption: `Image: ${r.label ?? 'table'} (page ${r.page}). Read VALUES from it; cite [pN] from the text.` })
  }
  console.log(`doc${DOCID}: ${regions.length} region(s), ${images.length} crop(s)`)

  for (const mode of ['text+images'] as const) {
    const raw = await sel.provider.callLLM(
      [{ role: 'system', content: sys }, { role: 'user', content: user, images: mode === 'text+images' ? images : undefined }],
      { maxTokens: 16384 }
    )
    const facts = ((extractJson(raw) as { facts?: Array<Record<string, unknown>> } | null)?.facts) ?? []
    let anchored = 0
    const kinetics: string[] = []
    for (const f of facts) {
      const ids = (Array.isArray(f.paragraph) ? f.paragraph : [f.paragraph]).map((v) => Number(String(v ?? '').replace(/\D/g,''))).filter(Number.isFinite)
      const q = String(f.quote ?? '')
      const pobjs = paras.map((t, i) => ({ text: t, index: i }))
      if (ids.length && q && locateQuoteForTest(q, pobjs, ids) !== null) anchored++
      const v = String(f.value_text ?? '')
      if (/kcat|k_?m|catalytic/i.test(String(f.predicate ?? '')) && v) kinetics.push(v)
    }
    console.log(`${mode}: ${facts.length} facts, ${anchored} anchored (${Math.round(100*anchored/Math.max(facts.length,1))}%)`)
    console.log(`   kinetic values: ${kinetics.slice(0,4).join(' | ')}`)
    // Why did the rest fail?
    for (const f of facts) {
      const ids = (Array.isArray(f.paragraph) ? f.paragraph : [f.paragraph]).map((v) => Number(String(v ?? '').replace(/\D/g,''))).filter(Number.isFinite)
      const q = String(f.quote ?? '')
      const inRange = ids.length > 0 && ids.every((i) => i >= 0 && i < paras.length)
      const pobjs2 = paras.map((t, i) => ({ text: t, index: i }))
      const ok = ids.length > 0 && q !== '' && locateQuoteForTest(q, pobjs2, ids) !== null
      if (ok) continue
      const anywhere = paras.findIndex((t) => canon(t).includes(canon(q)))
      // When "ABSENT", say how much of it DID match — a quote that matches
      // nothing is a fabrication; one that matches 90% is a wording slip.
      let pref = 0
      if (anywhere < 0) {
        const full = canon(paras.join('\n'))
        const cq = canon(q)
        let lo = 0, hi = cq.length
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (full.includes(cq.slice(0, mid))) lo = mid; else hi = mid - 1 }
        pref = Math.round((100 * lo) / Math.max(cq.length, 1))
      }
      console.log(`   MISS said=[${ids.join(',')}] ${!inRange ? 'OUT-OF-RANGE' : anywhere >= 0 ? `really p${anywhere}` : `ABSENT (${pref}% of it matches somewhere)`}: ${q.slice(0,140)}`)
    }
  }
  db.close()
}
void main()
