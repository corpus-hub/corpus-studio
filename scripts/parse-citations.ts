// Parse the reference section of every seeded PDF and persist the resulting
// citation edges + unresolved references.
//
//   npm run parse:citations              # parse everything
//   npm run parse:citations -- --stale   # only what is stale (see findStaleParses)
//
// Runs under `ELECTRON_RUN_AS_NODE=1 electron` because better-sqlite3 is built
// against Electron's ABI.
import { initDatabase, setDb } from '../src/main/db/connection'
import { defaultDbPath } from '../src/main/db/paths'
import { parseAllWorks } from '../src/main/citations/parseWork'
import { findStaleParses, rematchUnresolved, PARSER_VERSION } from '../src/main/citations/store'

async function main(): Promise<void> {
  const dbPath = process.env.CORPUS_DB_PATH ?? defaultDbPath()
  const db = initDatabase(dbPath)
  setDb(db)
  console.log(`db: ${dbPath}`)
  console.log(`parser: ${PARSER_VERSION}`)

  const staleOnly = process.argv.includes('--stale')
  const stale = findStaleParses(db)

  // RE-MATCH FIRST, and unconditionally. Adding a paper can turn an unresolved
  // reference into a real edge in every paper that cited it, and that costs no
  // PDF read at all: the parsed rows are already stored.
  //
  // This used to run only when EVERY stale row said `corpus` — a reason
  // `findStaleParses` no longer reports, because corpus growth is not a fact
  // about a parse. While it was reported, `--stale` re-read every PDF in the
  // library after each import; now the cheap sweep always runs and the
  // expensive one runs only when the PARSER changed.
  const promoted = rematchUnresolved(db)
  if (promoted > 0) {
    console.log(`re-matched stored references: promoted ${promoted} to real edge(s).`)
  }

  if (staleOnly && stale.length === 0) {
    console.log('no parse is stale; up to date.')
    return
  }

  const ids = staleOnly ? stale.map((s) => s.work_id) : undefined
  console.log('work | refs | matched | unresolved | strategy/style | note')
  const results = await parseAllWorks(db, {
    workIds: ids,
    onProgress: (r) => {
      console.log(
        `${String(r.work_id).padStart(4)} | ${String(r.reference_count).padStart(4)} | ` +
          `${String(r.matched_count).padStart(7)} | ${String(r.unresolved_count).padStart(10)} | ` +
          `${r.section_strategy}/${r.entry_style} | ${r.skipped_reason ?? (r.no_text_layer ? 'NO TEXT LAYER' : '')}`
      )
    }
  })

  const refs = results.reduce((n, r) => n + r.reference_count, 0)
  const matched = results.reduce((n, r) => n + r.matched_count, 0)
  console.log(`\nparsed ${results.length} works: ${refs} references, ${matched} resolved to corpus works.`)

  const failures = results.filter((r) => r.reference_count === 0)
  if (failures.length) {
    console.log(`\n${failures.length} work(s) yielded NO references — disclosed, not hidden:`)
    for (const f of failures) {
      console.log(`  work ${f.work_id}: ${f.skipped_reason ?? (f.no_text_layer ? 'PDF has no text layer' : 'no reference section found')}`)
    }
  }
}

void main()
