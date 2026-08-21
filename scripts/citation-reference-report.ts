// PRIMARY metric for the citation parser: how many REFERENCED PAPERS we can
// extract from each bibliography, with enough fields to identify them.
//
//   npm run report:references
//
// IDENTIFIABLE is the headline. A reference is identifiable when it carries a
// year AND authors AND (a title OR a venue). That is the minimum needed to look
// the paper up — an entry with a year and a venue but no author names could be
// any of a hundred papers, and an entry with authors and a year but neither a
// title nor a journal names a paper we cannot distinguish from its neighbours.
//
// TITLE COVERAGE IS NOT A DEFECT MEASURE. ACS, Angewandte, RSC and older JACS
// print NO title at all — "Tantillo, D. J.; Jiangang, C.; Houk, K. N., Curr.
// Opin. Chem. Bio. 1998, 2, 743-750." is the complete, correct entry. For those
// documents identity is authors + year + venue + volume + pages, which is why
// volume and pages are extracted and reported here. A parser that invented a
// title for such an entry would be fabricating, so the title column is expected
// to read near zero for those files and that is reported, not hidden.
//
// DOI coverage is likewise low BY PERIOD, not by defect: most of these
// bibliographies predate the routine printing of DOIs.
//
// The dedup-against-corpus numbers (how many references resolve onto one of the
// 20 works we happen to hold locally) are a SECONDARY, different question and
// live in `npm run report:citations`.
import { readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { parseReferences, matchReferences, type CorpusWork } from '../src/main/citations/parseReferences'
import { extractPdfText } from '../src/main/citations/extractText'
import { normalizeDoi } from '../src/main/citations/normalize'

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

const cacheDir = join(root, 'tmp', 'pdf-text')

async function textFor(i: number, p: Paper): Promise<string> {
  const cached = join(cacheDir, `${String(i + 1).padStart(2, '0')}.txt`)
  if (existsSync(cached)) return readFileSync(cached, 'utf8')
  if (!existsSync(p.pdf_path)) return ''
  return (await extractPdfText(p.pdf_path)).text
}

interface Row {
  work: number
  refs: number
  year: number
  authors: number
  title: number
  venue: number
  volume: number
  pages: number
  doi: number
  identifiable: number
  style: string
  conf: number
  note: string
}

function pad(n: number | string, w: number): string {
  return String(n).padStart(w)
}

async function main(): Promise<void> {
  const rows: Row[] = []
  const totals = {
    refs: 0, year: 0, authors: 0, title: 0, venue: 0,
    volume: 0, pages: 0, doi: 0, identifiable: 0
  }
  // Dedup-against-corpus, kept but clearly secondary.
  let tp = 0
  let truthTotal = 0
  const irreducible: string[] = []

  for (let i = 0; i < papers.length; i++) {
    const workId = i + 1
    const p = papers[i]
    const text = await textFor(i, p)
    const { references, diagnostics } = parseReferences(text)

    const row: Row = {
      work: workId, refs: references.length,
      year: 0, authors: 0, title: 0, venue: 0, volume: 0, pages: 0, doi: 0,
      identifiable: 0,
      style: diagnostics.citation_style,
      conf: diagnostics.style_confidence,
      note: ''
    }

    for (const r of references) {
      if (r.year != null) row.year++
      if (r.authors) row.authors++
      if (r.title) row.title++
      if (r.venue) row.venue++
      if (r.volume) row.volume++
      if (r.pages) row.pages++
      if (r.doi) row.doi++
      if (r.year != null && r.authors && (r.title || r.venue)) row.identifiable++
    }

    if (diagnostics.no_text_layer) row.note = 'NO TEXT LAYER (scanned image)'
    else if (references.length === 0) row.note = 'no reference section found'
    if (row.note) irreducible.push(`work ${workId} (${p.title.slice(0, 52)}): ${row.note}`)

    rows.push(row)
    totals.refs += row.refs
    totals.year += row.year
    totals.authors += row.authors
    totals.title += row.title
    totals.venue += row.venue
    totals.volume += row.volume
    totals.pages += row.pages
    totals.doi += row.doi
    totals.identifiable += row.identifiable

    const matches = matchReferences(references, corpus, { excludeWorkId: workId })
    const predicted = new Set(matches.filter((m) => m.work_id != null).map((m) => m.work_id!))
    const truth = new Set<number>()
    for (const d of p.cites ?? []) {
      const t = byDoi.get(normalizeDoi(d))
      if (t) truth.add(t)
    }
    truthTotal += truth.size
    for (const t of truth) if (predicted.has(t)) tp++
  }

  console.log('=========== PRIMARY: REFERENCED-PAPER FIELD COMPLETENESS ===========')
  console.log('work | refs | year | auth | title | venue |  vol | pages | doi | IDENT | ident% | style        | conf | note')
  console.log('-----|------|------|------|-------|-------|------|-------|-----|-------|--------|--------------|------|-----')
  for (const r of rows) {
    const pct = r.refs ? ((r.identifiable / r.refs) * 100).toFixed(0) + '%' : '-'
    console.log(
      `${pad(r.work, 4)} | ${pad(r.refs, 4)} | ${pad(r.year, 4)} | ${pad(r.authors, 4)} | ` +
        `${pad(r.title, 5)} | ${pad(r.venue, 5)} | ${pad(r.volume, 4)} | ${pad(r.pages, 5)} | ` +
        `${pad(r.doi, 3)} | ${pad(r.identifiable, 5)} | ${pad(pct, 6)} | ` +
        `${r.style.padEnd(12)} | ${pad(r.conf.toFixed(2), 4)} | ${r.note}`
    )
  }

  const pctOf = (n: number): string =>
    totals.refs ? `${n} (${((n / totals.refs) * 100).toFixed(1)}%)` : String(n)

  console.log('\n---------------------------- CORPUS TOTALS ----------------------------')
  console.log(`referenced papers extracted : ${totals.refs}`)
  console.log(`  with year                 : ${pctOf(totals.year)}`)
  console.log(`  with authors              : ${pctOf(totals.authors)}`)
  console.log(`  with title                : ${pctOf(totals.title)}   (absent BY CONVENTION in ACS/Angewandte/RSC)`)
  console.log(`  with venue                : ${pctOf(totals.venue)}`)
  console.log(`  with volume               : ${pctOf(totals.volume)}`)
  console.log(`  with pages                : ${pctOf(totals.pages)}`)
  console.log(`  with DOI                  : ${pctOf(totals.doi)}   (these bibliographies mostly predate printed DOIs)`)
  console.log(
    `\nIDENTIFIABLE (year AND authors AND (title OR venue)) : ` +
      `${totals.identifiable}/${totals.refs} = ` +
      `${totals.refs ? ((totals.identifiable / totals.refs) * 100).toFixed(1) : '0.0'}%   <-- headline`
  )

  console.log('\n------- SECONDARY: dedup against the 20-work local corpus -------')
  console.log('Not a measure of extraction quality. It asks the different question')
  console.log('"does this referenced paper happen to already be one of the 20 works')
  console.log('we hold locally?", against a hand-authored edge list independently')
  console.log('shown to assert citations the PDFs do not contain. See')
  console.log('`npm run report:citations` for the full breakdown.')
  console.log(`references resolved onto a corpus work : ${tp} of ${truthTotal} hand-authored edges`)

  if (irreducible.length) {
    console.log('\nIRREDUCIBLE (disclosed, not faked):')
    for (const n of irreducible) console.log('  - ' + n)
  }
}

void main()
