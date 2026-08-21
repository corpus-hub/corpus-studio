// Verification: open the seeded DB read-only and print key counts. Also asserts
// the partial-unique index (one current run per work/project/type) holds and that
// exactly one superseded + one current run exist for (work=2, project=1, extraction).
//
// Uses the SHARED defaultDbPath() so it inspects EXACTLY the file `seed:fresh`
// wrote and `npm start` opens (CORPUS_DB_PATH still overrides for isolation).
//
// IT EXITS NON-ZERO WHEN A CHECK FAILS. A verifier whose whole output is prose
// is a verifier nothing can gate on: this script printed `INDEX CHECK: FAILED —
// duplicate current run was allowed!` and still exited 0, so any caller — a
// shell `&&`, a CI step, a person reading the last line — saw a pass.
import Database from 'better-sqlite3'
import { copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultDbPath } from '../src/main/db/paths'
import { openDatabaseReadOnly } from '../src/main/db/connection'
import { loadSqliteVec } from '../src/main/db/sqliteVec'

let failures = 0
function fail(what: string, why: string): void {
  failures++
  console.log(`FAIL  ${what}\n      ${why}`)
}

const dbPath = defaultDbPath()
const db = openDatabaseReadOnly(dbPath)

const tables = [
  'base_dir', 'project', 'work', 'author', 'affiliation', 'work_author',
  'identifier', 'document', 'file_location', 'citation_edge', 'citation_context',
  'unresolved_reference', 'project_work', 'analysis_run', 'evidence_span', 'fact',
  'measurement', 'fold_improvement', 'saved_search', 'saved_frontier',
  'processing_job', 'stage_run', 'stage_artifact', 'job_dependency'
]
const counts: Record<string, number> = {}
for (const t of tables) {
  counts[t] = (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c
}
console.log('TABLE COUNTS:')
for (const t of tables) console.log(`  ${t.padEnd(22)} ${counts[t]}`)

// Superseded/current invariant for (work=2, project=1, extraction).
const runs = db
  .prepare(`SELECT superseded, COUNT(*) c FROM analysis_run WHERE work_id=2 AND project_id=1 AND analysis_type='extraction' GROUP BY superseded ORDER BY superseded`)
  .all() as Array<{ superseded: number; c: number }>
console.log('ANALYSIS_RUN (w2,p1,extraction) by superseded:', JSON.stringify(runs))

// Current runs (superseded=0) must be unique per (work,project,type).
const dupes = db
  .prepare(`SELECT work_id, project_id, analysis_type, COUNT(*) c FROM analysis_run WHERE superseded=0 GROUP BY work_id, project_id, analysis_type HAVING c>1`)
  .all()
console.log('DUPLICATE CURRENT RUNS (must be []):', JSON.stringify(dupes))
if (dupes.length > 0) {
  fail(
    'a work/project/analysis_type has more than one CURRENT run',
    `${JSON.stringify(dupes)}\n      ` +
      'The one-current-run guarantee is broken IN THE DATA, whatever the index says. ' +
      'Find the writer that inserted without superseding the prior run (src/main/llm/pipeline.ts ' +
      'is the only place allowed to) before trusting any analysis this corpus shows.'
  )
}

// Fact kinds present. EMPTY on a seeded-but-unprocessed database, which is the
// expected state: the seed creates no analyses, so there are no facts until
// `npm run corpus:process` has run a real model over the corpus.
const kinds = db.prepare(`SELECT DISTINCT kind FROM fact ORDER BY kind`).all() as Array<{ kind: string }>
console.log('FACT KINDS:', kinds.length === 0 ? '(none — corpus not yet processed)' : kinds.map((k) => k.kind).join(', '))

// Works without a DOI (optionality proof).
const noDoi = db
  .prepare(`SELECT COUNT(*) c FROM work w WHERE NOT EXISTS (SELECT 1 FROM identifier i WHERE i.work_id=w.id AND i.scheme='doi')`)
  .get() as { c: number }
console.log('WORKS WITHOUT DOI:', noDoi.c)

// Try to violate the partial unique index: inserting a 2nd current run must throw.
// The probe runs against a THROWAWAY COPY, never the real database. Asking
// whether a constraint holds by attempting to violate it is a WRITE, and this
// script's whole remit is to look. Writing to the live file here would also
// bypass the single-writer lock, which is the hazard that destroyed 33 analysis
// runs — a verifier must not be the one process still able to cause it. A copy
// answers the same question, and the DELETE that used to clean up after the
// insert is unnecessary once nothing durable was touched.
//
// EVERY WAY OUT OF THIS BLOCK IS A VERDICT, and exactly one of them is a pass.
// The probe used to swallow its own infrastructure errors into `INDEX CHECK
// skipped` and carry on to exit 0 — so a copy that failed, an extension that
// would not load, or a renamed table reported the same overall result as a
// constraint that held. The guarantee this asks about is the one that stops a
// regeneration leaving two current runs behind; not being able to ask is a
// failure of the gate, not an absence of a problem.
const probePath = join(tmpdir(), `corpus-index-probe-${process.pid}.sqlite`)
let indexHolds = false
try {
  rmSync(probePath, { force: true })
  copyFileSync(dbPath, probePath)
  const w = new Database(probePath)
  w.pragma('foreign_keys = ON')
  // A copy of a real corpus holds that corpus's `chunk_vec_*` virtual tables,
  // and their module is per-connection. Without it any statement SQLite has to
  // re-read the schema for answers `malformed database schema`, which would
  // read here as the constraint under test being broken.
  loadSqliteVec(w)
  try {
    w.prepare(
      `INSERT INTO analysis_run (work_id, project_id, analysis_type, model, provider, prompt_version, schema_version, run_timestamp, superseded, created_at)
       VALUES (2, 1, 'extraction', 'x', 'x', 'v9', 's9', '2026-01-01T00:00:00Z', 0, '2026-01-01T00:00:00Z')`
    ).run()
    fail(
      'the partial-unique index did NOT stop a second current run',
      'inserting a duplicate (work=2, project=1, extraction, superseded=0) succeeded. ' +
        'The index `UNIQUE(work_id, project_id, analysis_type) WHERE superseded=0` is missing or ' +
        'was created without its WHERE clause — check the migration that owns it and re-migrate.'
    )
  } catch (e) {
    // Only a CONSTRAINT violation proves the index held. Counting ANY error as
    // a pass lets a renamed table, a schema change or an unloadable extension
    // report the very guarantee this probe exists to check.
    const msg = String((e as Error)?.message ?? e)
    indexHolds = /constraint/i.test(msg)
    if (!indexHolds) {
      fail(
        'the partial-unique index could not be tested',
        `the probe insert failed for a reason that is not a constraint violation: ${msg}\n      ` +
          'That is an inconclusive gate, not a pass. Likely a schema change, a renamed column, or ' +
          'sqlite-vec failing to load into the probe copy.'
      )
    }
  } finally {
    w.close()
  }
} catch (e) {
  fail(
    'the partial-unique index could not be tested',
    `the throwaway probe copy could not be prepared: ${String(e)}\n      ` +
      `Copying ${dbPath} → ${probePath} or opening it is what broke; fix that (disk space in ` +
      `${tmpdir()}, permissions, a missing sqlite-vec build) and run this again. ` +
      'The guarantee is UNCHECKED until it can run.'
  )
} finally {
  rmSync(probePath, { force: true })
}
console.log('PARTIAL-UNIQUE SUPERSEDED INDEX HOLDS:', indexHolds)

db.close()

console.log(failures === 0 ? '\nALL SEED CHECKS PASSED' : `\n${failures} SEED CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
