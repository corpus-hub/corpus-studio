/**
 * Can every extracted value be pointed at in the document it came from?
 *
 * A highlight in the Paper screen means "this text became a cell in the
 * extraction table", so a value with no highlight says nothing was extracted
 * there. That reading is only trustworthy if the highlight is present whenever
 * the evidence is — and it was not: the document-wide locator dropped any quote
 * under twelve canonical characters as unplaceable, which is every numeric
 * table cell in the corpus (`0.528 ± 0.002` canonicalises to eight), so 52% of
 * extracted facts showed as unextracted.
 *
 * The invariant this checks is the one the scoped locator depends on: EVERY
 * evidence quote resolves to exactly ONE place inside the paragraph its span
 * names. Ambiguity there is what would put a band on the wrong cell.
 *
 * WHICH TEXT SPACE THIS MEASURES, and what it therefore cannot prove.
 * It reads `document_paragraph` — MAIN's extracted text. The renderer searches
 * the pdf.js text layer, which is a DIFFERENT string: for document 4 the stored
 * paragraphs span 44 625 characters while the viewer builds its own index from
 * text-layer spans. So this proves each quote is unambiguous relative to its
 * paragraph; it cannot prove the paragraph key survives the crossing. Only the
 * running app can answer that, and `npm run shot paper -- --work <id>` is how.
 * A number here is not a statement about what the user sees.
 *
 *   npm run verify:highlights
 */
import { existsSync } from 'node:fs'
import { openDatabaseReadOnly, closeDatabase } from '../src/main/db/connection'
import { defaultDbPath } from '../src/main/db/paths'
import { canon, findScoped } from '../src/renderer/components/locateInParagraph'

const dbPath = process.env.CORPUS_DB_PATH ?? defaultDbPath()
if (!existsSync(dbPath)) {
  console.error(`No corpus at ${dbPath}. Run \`npm run seed\` first.`)
  process.exit(1)
}

// READ-ONLY, so this runs against the corpus the user is looking at while they
// are looking at it. Taking the write lock would make the check and the app
// mutually exclusive, and a coverage report that cannot be run without closing
// the app is one nobody runs.
const db = openDatabaseReadOnly(dbPath)

interface Row {
  span_id: number
  document_id: number | null
  paragraph: number | null
  quote: string | null
  verbatim: number
  work_id: number
  run_id: number
}

const spans = db
  .prepare(
    /* sql */ `
    SELECT es.id AS span_id, es.document_id, es.paragraph, es.quote, es.verbatim,
           r.work_id, r.id AS run_id
      FROM evidence_span es
      JOIN analysis_run r ON r.id = es.analysis_run_id
     WHERE r.analysis_type = 'extraction'
       AND r.superseded = 0
     ORDER BY es.id
  `
  )
  .all() as Row[]

/** Canonical paragraph text per document, from the live inventory. */
const paraCache = new Map<number, Map<number, string>>()
function paragraphsOf(documentId: number): Map<number, string> {
  let m = paraCache.get(documentId)
  if (!m) {
    m = new Map()
    const rows = db
      .prepare(
        /* sql */ `
        SELECT dp.idx, dp.text
          FROM document_paragraph dp
          JOIN stage_artifact sa ON sa.stage_run_id = dp.stage_run_id
          JOIN stage_run sr ON sr.id = dp.stage_run_id
         WHERE dp.document_id = ?
           AND sa.key = 'text.paragraphs@v1'
           AND sr.superseded = 0
           AND sr.status = 'succeeded'
         ORDER BY dp.idx
      `
      )
      .all(documentId) as Array<{ idx: number; text: string }>
    for (const r of rows) m.set(r.idx, canon(r.text))
    paraCache.set(documentId, m)
  }
  return m
}

/** The whole-document canonical text, as the concatenation of its paragraphs. */
const docCache = new Map<number, string>()
function documentOf(documentId: number): string {
  let s = docCache.get(documentId)
  if (s === undefined) {
    const paras = paragraphsOf(documentId)
    s = [...paras.keys()].sort((a, b) => a - b).map((k) => paras.get(k)!)
      .join('')
    docCache.set(documentId, s)
  }
  return s
}

let quoteless = 0
let nonVerbatim = 0
let resolved = 0
let unlocatable = 0
/**
 * A span the pipeline itself could not place, and said so.
 *
 * `verbatim = 0` with no paragraph means `locateQuote` found the model's
 * wording nowhere in the text it was attributed to. Nothing downstream can
 * anchor that, and nothing should: it is the provenance layer working. It is
 * counted and named, never counted as coverage, and never a failure.
 */
const recordedNonLocations: string[] = []
const failures: string[] = []

for (const s of spans) {
  if (!s.quote || s.quote.trim().length === 0) {
    quoteless++
    continue
  }
  if (s.verbatim === 0) nonVerbatim++

  const para =
    s.document_id !== null && s.paragraph !== null
      ? paragraphsOf(s.document_id).get(s.paragraph)
      : undefined
  const at =
    para !== undefined && s.document_id !== null
      ? findScoped(documentOf(s.document_id), para, canon(s.quote))
      : null

  if (at !== null) {
    resolved++
    continue
  }

  // A quote that never verified cannot be required to anchor — asking it to
  // would be asking the app to point at text the paper does not contain.
  if (s.verbatim === 0) {
    unlocatable++
    recordedNonLocations.push(
      `span ${s.span_id} (work ${s.work_id}): ${JSON.stringify(s.quote.slice(0, 60))}`
    )
    continue
  }

  failures.push(
    `span ${s.span_id} (work ${s.work_id}, p${s.paragraph ?? '—'}): ` +
      `${JSON.stringify(s.quote.slice(0, 60))} verified once but does not resolve to one place`
  )
}

const withQuote = spans.length - quoteless
console.log(`db                 ${dbPath}`)
console.log(`measured in        MAIN's extracted text, NOT the renderer's pdf.js layer`)
console.log(`evidence spans     ${spans.length}`)
console.log(`  no quote         ${quoteless}  (image-only readings; nothing to point at)`)
console.log(`  with a quote     ${withQuote}`)
console.log(`    verbatim=0     ${nonVerbatim}`)
console.log(`    resolve to 1   ${resolved}`)
console.log(`    unlocatable    ${unlocatable}  (verbatim=0 and absent from the text; expected)`)
console.log(`    FAILURES       ${failures.length}`)

if (recordedNonLocations.length > 0) {
  console.log('\nRecorded non-locations — the pipeline could not find these and said so:')
  for (const r of recordedNonLocations) console.log(`  ${r}`)
}

closeDatabase(db)

if (failures.length > 0) {
  console.error('\nA quote that verified against the document must resolve to one place in it.')
  for (const f of failures.slice(0, 40)) console.error(`  ${f}`)
  if (failures.length > 40) console.error(`  … and ${failures.length - 40} more`)
  process.exit(1)
}
console.log('\nOK — every anchorable extraction quote resolves inside its paragraph.')
