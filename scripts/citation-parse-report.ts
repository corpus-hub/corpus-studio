// SECONDARY metric: dedup against the local corpus.
//
//   npm run report:citations
//
// THIS IS NOT THE PARSER'S PRIMARY METRIC. It measures how many referenced
// papers happen to ALREADY be one of the 20 works held locally — a dedup
// question, downstream of extraction. The parser's actual job is to extract
// every referenced paper from every bibliography with enough fields to identify
// it, and that is measured by `npm run report:references` (IDENTIFIABLE %).
//
// The distinction matters because this metric's denominator, the 91
// hand-authored edges below, was independently shown to be WRONG: it asserts
// citations the PDFs demonstrably do not contain (verified with both pdfjs and
// poppler — see the untraceable-edge list this script prints). Optimising
// against it rewards guessing.
//
// What follows is the original per-edge analysis, kept because the dedup
// question is still worth answering honestly.
//
// RAW RECALL (hits / all 91 hand-authored edges) is THE number. It is the one
// comparable to the 67% naive first-author+year baseline, and it is the only one
// quoted as "recall" anywhere.
//
// A second figure, TRACEABLE recall, is printed alongside it. Its denominator
// excludes hand-authored edges whose target leaves NO trace in the citing PDF —
// the target's first-author surname (allowing one substituted character, since
// damaged font cmaps make pdfjs decode "Röthlisberger" as "Rcthlisberger") never
// appears near the target's publication year anywhere in the document, and
// neither does its DOI. That test is deliberately generous: it asks only whether
// the citation is PHYSICALLY PRESENT to be found, not whether it is present in a
// format the parser handles. An edge it rejects cannot be recovered by any
// amount of parser work, because the bytes are not there.
//
// This corpus contains many such edges. Auditing them against a SECOND,
// independent extractor (poppler's pdftotext) confirms the text layer is not at
// fault: e.g. "Alexandrova" appears nowhere in papers 2, 3, 4, 11 or 13 under
// either extractor, and paper 4's printed bibliography — legible in full — does
// not list it. Those hand-authored edges assert citations the documents do not
// make.
//
// The previous version of this metric asked instead whether the author AND >=60%
// of rare title tokens were present, which EXCLUDED every ACS/Angewandte-style
// entry (those print no title at all) — precisely the cases the parser finds
// hardest. It therefore flattered the result and is not used.
import { readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { parseReferences, matchReferences, type CorpusWork } from '../src/main/citations/parseReferences'
import { extractPdfText } from '../src/main/citations/extractText'
import { normalizeDoi, normalizeLoose, foldText } from '../src/main/citations/normalize'

const root = resolve(__dirname, '..')

interface Paper {
  title: string
  authors: Array<{ family: string }>
  doi: string | null
  year: number | null
  venue: string | null
  pdf_path: string
  cites?: string[]
}

const papers: Paper[] = JSON.parse(
  readFileSync(join(root, 'scripts', 'data', 'ke07-corpus.json'), 'utf8')
)
const corpus: CorpusWork[] = papers.map((p, i) => ({
  work_id: i + 1,
  title: p.title,
  year: p.year,
  doi: p.doi,
  venue: p.venue,
  author_surnames: p.authors.map((a) => a.family)
}))
const byDoi = new Map<string, number>()
papers.forEach((p, i) => p.doi && byDoi.set(normalizeDoi(p.doi), i + 1))

/**
 * Every offset at which `needle` occurs in `hay` allowing one substituted
 * character. See the header note on damaged font cmaps.
 */
function fuzzyOffsets(hay: string, needle: string): number[] {
  const out: number[] = []
  if (needle.length < 5) return out
  for (let k = 0; k + needle.length <= hay.length; k++) {
    let d = 0
    for (let j = 0; j < needle.length; j++) {
      if (hay[k + j] !== needle[j]) {
        d++
        if (d > 1) break
      }
    }
    if (d <= 1) {
      out.push(k)
      k += needle.length - 1
    }
  }
  return out
}

/** Is `work` physically findable in `flat` (the folded, lowercased document)? */
function leavesATrace(flat: string, work: CorpusWork, doi: string | null): boolean {
  if (doi && flat.includes(normalizeDoi(doi))) return true
  const first = normalizeLoose(work.author_surnames[0] ?? '')
  if (!first || work.year == null) return false
  const year = String(work.year)
  return fuzzyOffsets(flat, first).some((at) =>
    flat.slice(Math.max(0, at - 120), at + 300).includes(year)
  )
}

// A cached text dir lets the report re-run without 20 pdfjs decodes.
const cacheDir = join(root, 'tmp', 'pdf-text')

async function textFor(i: number, p: Paper): Promise<string> {
  const cached = join(cacheDir, `${String(i + 1).padStart(2, '0')}.txt`)
  if (existsSync(cached)) return readFileSync(cached, 'utf8')
  if (!existsSync(p.pdf_path)) return ''
  return (await extractPdfText(p.pdf_path)).text
}

async function main(): Promise<void> {
  let tp = 0
  let fn = 0
  let extra = 0
  let traceableTruth = 0
  let untraceableTruth = 0
  const notes: string[] = []
  const untraceable: string[] = []

  console.log(
    'work | refs | matched | unresolv | truth | hit | miss | extra | strategy/style      | note'
  )
  console.log(
    '-----|------|---------|----------|-------|-----|------|-------|---------------------|-----'
  )

  for (let i = 0; i < papers.length; i++) {
    const workId = i + 1
    const p = papers[i]
    const text = await textFor(i, p)
    const flat = foldText(text).toLowerCase().replace(/\s+/g, ' ')

    const { references, diagnostics } = parseReferences(text)
    const matches = matchReferences(references, corpus, { excludeWorkId: workId })
    const predicted = new Set(matches.filter((m) => m.work_id != null).map((m) => m.work_id!))

    const truth = new Set<number>()
    for (const d of p.cites ?? []) {
      const t = byDoi.get(normalizeDoi(d))
      if (t) truth.add(t)
    }

    const hits: number[] = []
    const misses: number[] = []
    for (const t of truth) (predicted.has(t) ? hits : misses).push(t)
    const extras = [...predicted].filter((t) => !truth.has(t))

    // Classify each truth edge by whether its target leaves ANY trace in this
    // PDF. A found edge is traceable by construction.
    for (const t of truth) {
      const w = corpus[t - 1]
      if (predicted.has(t) || leavesATrace(flat, w, papers[t - 1].doi)) traceableTruth++
      else {
        untraceableTruth++
        untraceable.push(
          `work ${workId} -> ${t} (${w.author_surnames[0]} ${w.year}, ${w.venue ?? '?'})`
        )
      }
    }

    tp += hits.length
    fn += misses.length
    extra += extras.length

    let note = ''
    if (diagnostics.no_text_layer) note = 'NO TEXT LAYER (scanned image)'
    else if (references.length === 0) note = 'no reference section found'

    if (note) notes.push(`work ${workId} (${p.title.slice(0, 48)}): ${note}`)

    console.log(
      `${String(workId).padStart(4)} | ${String(references.length).padStart(4)} | ` +
        `${String(predicted.size).padStart(7)} | ${String(references.length - predicted.size).padStart(8)} | ` +
        `${String(truth.size).padStart(5)} | ${String(hits.length).padStart(3)} | ` +
        `${String(misses.length).padStart(4)} | ${String(extras.length).padStart(5)} | ` +
        `${(diagnostics.section_strategy + '/' + diagnostics.entry_style).padEnd(19)} | ${note}`
    )
  }

  const rawRecall = tp / (tp + fn)
  const traceableRecall = traceableTruth > 0 ? tp / traceableTruth : 0

  console.log('\n================ CORPUS TOTALS ================')
  console.log(`hand-authored ground-truth edges : ${tp + fn}`)
  console.log(`  leaving a trace in the PDF     : ${traceableTruth}`)
  console.log(`  leaving NO trace in the PDF    : ${untraceableTruth}`)
  console.log(`true positives                   : ${tp}`)
  console.log(`false negatives                  : ${fn}`)
  console.log(`edges found beyond the hand list : ${extra}`)
  console.log(`\nRAW RECALL      (vs all ${tp + fn} edges)  : ${(rawRecall * 100).toFixed(1)}%   <-- headline`)
  console.log(`TRACEABLE RECALL (vs the ${traceableTruth} findable): ${(traceableRecall * 100).toFixed(1)}%`)
  console.log(`baseline to beat (first-author+year): 67.0%`)

  if (notes.length) {
    console.log('\nPapers that could NOT be parsed reliably (disclosed, not hidden):')
    for (const n of notes) console.log('  - ' + n)
  }

  if (untraceable.length) {
    console.log(
      '\nHand-authored edges whose target leaves NO trace in the citing PDF.\n' +
        'The first-author surname (tolerating one substituted character) never\n' +
        'occurs near the target year, and the DOI is absent. Spot-checked against\n' +
        "poppler's pdftotext as a second extractor, so this is not a pdfjs artifact:\n" +
        'these citations are not in the documents, and no parser can recover them.'
    )
    for (const u of untraceable) console.log('  - ' + u)
  }
}

void main()
