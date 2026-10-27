// Prove the v14 `processing_job` rebuild against a COPY OF THE REAL USER DB.
//
//   npm run verify:migration            # copies the default user DB
//   npm run verify:migration -- <path>  # a specific DB file
//
// The step this checks has a failure mode that the migration runner's own
// post-assertions cannot see: `DROP TABLE processing_job` fires
// `unresolved_reference`'s `ON DELETE SET NULL` immediately (`defer_foreign_keys`
// defers violation CHECKING, not action CLAUSES), the transaction does not
// error, and `PRAGMA foreign_key_check` comes back EMPTY. So every
// reference-retrieval link would be destroyed on upgrade and nothing would
// report it.
//
// The real DB happens to have zero non-null `retrieval_job_id` values today, so
// running against it unmodified would assert nothing at all. This script
// therefore SEEDS a synthetic link into the pre-v14 copy first, and the
// assertion is genuinely exercised on real-shaped data.

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { runMigrations } from '../src/main/db/migrate'
import { defaultDbPath } from '../src/main/db/paths'
import { SCHEMA_V75_CHUNK_FTS } from '../src/main/db/schema'
import { loadSqliteVec } from '../src/main/db/sqliteVec'
import { unindexedLexical } from '../src/main/embedding/vectors'
import { searchLexical } from '../src/main/db/repos/lexical'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const source = process.argv[2] ?? defaultDbPath()
if (!existsSync(source)) {
  console.error(`no database at ${source}`)
  process.exit(1)
}

const work = join(tmpdir(), `corpus-migration-check-${process.pid}.sqlite`)
rmSync(work, { force: true })
// The same copy gate bench-retrieval.ts runs: the v75 assertions are only as
// good as the snapshot they verify, and a byte copy of a LIVE database is
// either a stale one (committed transactions still sitting in the -wal) or a
// torn one (a checkpoint landing mid-copy) that only fails later, in the
// runner's integrity_check, as a confusing false alarm.
const walSize = existsSync(`${source}-wal`) ? statSync(`${source}-wal`).size : -1
const lsof = spawnSync('lsof', [source], { encoding: 'utf8' })
const holders = lsof.status === 0 && lsof.stdout.trim() ? lsof.stdout.trim().split('\n') : []
if (holders.length > 0) {
  console.error(
    `a process holds the source database open — nothing may have it open during the copy:\n${holders.join('\n')}`
  )
  process.exit(1)
}
if (walSize > 0) {
  console.error(
    `the source has a NON-EMPTY -wal (${walSize} bytes of unflushed frames) — a byte copy now would ` +
      'lose committed transactions. Stop the app cleanly, then rerun.'
  )
  process.exit(1)
}
copyFileSync(source, work)
console.log(`source: ${source}`)

const db = new Database(work)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
db.pragma('busy_timeout = 5000')
// sqlite-vec must be loaded on ANY connection that opens a real user database.
// The extension is per-connection, and a database that holds an embedding space
// also holds `chunk_vec_*` VIRTUAL tables — without the module, `integrity_check`
// answers `malformed database schema … no such module: vec0` and this gate fails
// a perfectly healthy database. It is required, so this throws rather than
// running the gate against a handle that would misread the schema.
loadSqliteVec(db)

const startVersion = db.pragma('user_version', { simple: true }) as number
console.log(`user_version before: ${startVersion}`)

// ---------------------------------------------------------------- pre-state
const before = {
  jobs: (db.prepare('SELECT COUNT(*) AS c FROM processing_job').get() as { c: number }).c,
  jobIds: (db.prepare('SELECT id FROM processing_job ORDER BY id').all() as { id: number }[]).map(
    (r) => r.id
  ),
  works: (db.prepare('SELECT COUNT(*) AS c FROM work').get() as { c: number }).c,
  unresolved: (db.prepare('SELECT COUNT(*) AS c FROM unresolved_reference').get() as { c: number })
    .c
}
console.log(
  `rows: processing_job=${before.jobs} work=${before.works} unresolved_reference=${before.unresolved}`
)

// Seed synthetic retrieval links so the assertion has something to protect.
// The real DB has none today (nothing has been retrieved yet), and a check that
// compares 0 against 0 would pass on the very migration that destroys the data
// — which is exactly the bug this script exists to catch. Rows are INSERTED
// when the table is empty rather than only updated.
// UNCONDITIONAL on the version, deliberately. It was originally gated on
// `startVersion < 14`, which quietly stopped exercising anything the moment the
// user's DB reached v14 — so the check reported "0 before, 0 after" and passed
// on a migration that could have destroyed every link. The links are what v15,
// v16 and v17 must ALSO leave alone, and there is no version at which that stops
// being worth proving.
if (before.jobs > 0) {
  const targetJob = (db.prepare('SELECT MIN(id) AS id FROM processing_job').get() as { id: number })
    .id
  if (before.unresolved === 0) {
    const citing = db.prepare('SELECT MIN(id) AS id FROM work').get() as { id: number | null }
    if (citing.id != null) {
      const ins = db.prepare(
        `INSERT INTO unresolved_reference
           (citing_work_id, raw_bib_text, status, retrieval_status, retrieval_job_id, created_at)
         VALUES (?, ?, 'unresolved', 'retrieving', ?, '2026-01-01T00:00:00Z')`
      )
      for (let i = 1; i <= 3; i++) ins.run(citing.id, `synthetic bibliography entry ${i}`, targetJob)
    }
  } else {
    const targets = db
      .prepare('SELECT id FROM unresolved_reference ORDER BY id LIMIT 3')
      .all() as { id: number }[]
    const upd = db.prepare(
      `UPDATE unresolved_reference SET retrieval_status = 'retrieving', retrieval_job_id = ?
        WHERE id = ?`
    )
    for (const t of targets) upd.run(targetJob, t.id)
  }
  const n = (
    db
      .prepare('SELECT COUNT(*) AS c FROM unresolved_reference WHERE retrieval_job_id IS NOT NULL')
      .get() as { c: number }
  ).c
  console.log(`seeded ${n} synthetic retrieval link(s) -> processing_job ${targetJob}`)
}
const linksBefore = db
  .prepare(
    'SELECT id, retrieval_job_id FROM unresolved_reference WHERE retrieval_job_id IS NOT NULL ORDER BY id'
  )
  .all() as Array<{ id: number; retrieval_job_id: number }>

// ---------------------------------------------------------------- v17 pre-state
// The real DB carries 145 `citation_context` rows, ALL of them with a `role` and
// a `role_confidence` and none with a `role_source` — which the v17 CHECKs
// forbid. That is the shape most likely to abort the rebuild, so it is captured
// here in full and compared row by row afterwards.
const contextsBefore = db
  .prepare(
    `SELECT id, edge_id, raw_bib_text, section, occurrence_kind,
            resolution_confidence, created_at
       FROM citation_context ORDER BY id`
  )
  .all() as Array<Record<string, unknown>>
console.log(`citation_context rows before: ${contextsBefore.length}`)
// The migration's most VISIBLE effect is one it does not preserve: a pre-v17
// role has no `role_source`, and every way of keeping it is a fabricated
// provenance claim, so the role is dropped. Counted here rather than assumed,
// because "the rows survived byte for byte" is checked above and would read as
// covering this when it does not.
//
// Counted SPLIT BY provenance rather than as one total. Once the source DB has
// itself reached v17+, its roles were written by the current pipeline and DO
// carry a `role_source`; dropping those would destroy good data. The invariant
// is not "no role survives", it is "no role survives WITHOUT a statable origin",
// and a bare total cannot tell those apart — asserting the total reached zero
// held only while every available source DB predated v17.
const roleCounts = (): { unsourced: number; sourced: number } => ({
  unsourced: (
    db
      .prepare(
        'SELECT COUNT(*) AS c FROM citation_context WHERE role IS NOT NULL AND role_source IS NULL'
      )
      .get() as { c: number }
  ).c,
  sourced: (
    db
      .prepare(
        'SELECT COUNT(*) AS c FROM citation_context WHERE role IS NOT NULL AND role_source IS NOT NULL'
      )
      .get() as { c: number }
  ).c
})
const rolesBefore = roleCounts()
const analysisBefore = {
  total: (db.prepare('SELECT COUNT(*) AS c FROM analysis_run').get() as { c: number }).c,
  current: (
    db.prepare('SELECT COUNT(*) AS c FROM analysis_run WHERE superseded = 0').get() as { c: number }
  ).c
}

// ---------------------------------------------------------------- v75 pre-state
// The 'rebuild' backfill is the one thing v75 does on every REAL install: chunk
// rows written BEFORE the triggers existed must be indexed by the migration
// itself, not by any later writer. Captured here, BEFORE the run, so the
// post-migration assertions cannot be satisfied by a trigger that never saw
// these rows. That premise holds only while the source sits BELOW v75 — the
// same anti-vacuousness trap the link seeding above records, this direction:
// once an app on this branch has launched once, the copy is already migrated,
// no backfill runs, and a green result below proves the triggers and the
// coverage detector, not the backfill. The assertions say which proof they are.
const v75BackfillRan = startVersion < 75
const chunkTableBefore = db
  .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chunk'`)
  .get()
const chunksBeforeV75 = chunkTableBefore
  ? (db.prepare('SELECT COUNT(*) AS c FROM chunk').get() as { c: number }).c
  : 0
// The OLDEST chunk: the row most certainly written before the migration ran.
// Its own space_id scopes the probe — a corpus that swapped models carries
// chunks in retired spaces, and searchLexical answers only the space it is
// given.
const v75Sample = chunkTableBefore
  ? (db.prepare('SELECT id, work_id, space_id, text FROM chunk ORDER BY id LIMIT 1').get() as
      | { id: number; work_id: number; space_id: number; text: string }
      | undefined)
  : undefined
const v75Word = v75Sample
  ? ((v75Sample.text.match(/[A-Za-z][A-Za-z0-9]{3,}/g) ?? [])[0] ?? null)
  : null

// ---------------------------------------------------------------- migrate
// `work` is a private temp COPY, opened by nobody else, so this process
// genuinely is its sole writer and no lock file is needed to prove it.
const reached = runMigrations(db, { hasExclusiveLock: true })
check('migration reached the head version', reached >= 14, `user_version = ${reached}`)

// ---------------------------------------------------------------- assertions
const linksAfter = db
  .prepare(
    'SELECT id, retrieval_job_id FROM unresolved_reference WHERE retrieval_job_id IS NOT NULL ORDER BY id'
  )
  .all() as Array<{ id: number; retrieval_job_id: number }>
check(
  'unresolved_reference.retrieval_job_id links survived the rebuild',
  JSON.stringify(linksAfter) === JSON.stringify(linksBefore),
  `${linksBefore.length} before, ${linksAfter.length} after`
)
// A zero-vs-zero comparison would pass on the very migration that destroys the
// data, so the check above is only meaningful if there was something to lose.
check('the link check was not vacuous', linksBefore.length > 0, `${linksBefore.length} link(s)`)
const dangling = linksAfter.filter(
  (l) => !db.prepare('SELECT 1 FROM processing_job WHERE id = ?').get(l.retrieval_job_id)
)
check('every restored link still names a real job', dangling.length === 0)

const after = {
  jobs: (db.prepare('SELECT COUNT(*) AS c FROM processing_job').get() as { c: number }).c,
  jobIds: (db.prepare('SELECT id FROM processing_job ORDER BY id').all() as { id: number }[]).map(
    (r) => r.id
  ),
  works: (db.prepare('SELECT COUNT(*) AS c FROM work').get() as { c: number }).c
}
check('processing_job row ids preserved', JSON.stringify(after.jobIds) === JSON.stringify(before.jobIds), `${after.jobs} rows`)
check('work rows untouched', after.works === before.works)

// The FK clause must still point at `processing_job`, not at the temp name.
const fkList = db.pragma('foreign_key_list(unresolved_reference)') as Array<{ table: string }>
check(
  'unresolved_reference still has an FK to processing_job',
  fkList.some((f) => f.table === 'processing_job'),
  fkList.map((f) => f.table).join(', ')
)

// The point of the rebuild: the job_type CHECK is gone (the registry is the enum).
let acceptedNewType = false
try {
  db.prepare(
    `INSERT INTO processing_job (job_type, stage, status, project_id, created_at, updated_at)
     VALUES ('extract-text', 'extract-text', 'blocked', 0, '2026-01-01', '2026-01-01')`
  ).run()
  acceptedNewType = true
  db.prepare(`DELETE FROM processing_job WHERE job_type = 'extract-text'`).run()
} catch (err) {
  console.log(`   insert of a registry stage name threw: ${String(err)}`)
}
check('a new stage name is insertable without a migration', acceptedNewType)

// project_id is a NOT NULL sentinel now — a NULL must be refused loudly rather
// than silently landing outside every `IN (?, 0)` predicate.
let refusedNull = false
try {
  db.prepare(
    `INSERT INTO processing_job (job_type, status, project_id, created_at, updated_at)
     VALUES ('ingest', 'queued', NULL, '2026-01-01', '2026-01-01')`
  ).run()
} catch {
  refusedNull = true
}
check('project_id NULL is refused', refusedNull)

const newTables = ['stage_run', 'stage_artifact', 'job_dependency', 'document_paragraph']
for (const t of newTables) {
  const found = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(t)
  check(`${t} exists`, Boolean(found))
}

// ---------------------------------------------------------------- v15
check(
  'analysis_run rows and current-run count are unchanged by v15',
  (db.prepare('SELECT COUNT(*) AS c FROM analysis_run').get() as { c: number }).c ===
    analysisBefore.total &&
    (db.prepare('SELECT COUNT(*) AS c FROM analysis_run WHERE superseded = 0').get() as {
      c: number
    }).c === analysisBefore.current,
  `${analysisBefore.total} rows / ${analysisBefore.current} current`
)
check(
  'the v15 index keys on schema_id',
  ((db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'ux_analysis_run_current'`).get() as {
    sql: string
  } | undefined)?.sql ?? '').includes('schema_id')
)

// ---------------------------------------------------------------- v17
const contextsAfter = db
  .prepare(
    `SELECT id, edge_id, raw_bib_text, section, occurrence_kind,
            resolution_confidence, created_at
       FROM citation_context ORDER BY id`
  )
  .all() as Array<Record<string, unknown>>
check(
  'every citation_context row survived the v17 rebuild byte for byte',
  JSON.stringify(contextsAfter) === JSON.stringify(contextsBefore),
  `${contextsBefore.length} before, ${contextsAfter.length} after`
)
{
  // The role goes, and it goes for EVERY pre-v17 row, not most of them. A
  // partial drop would mean some rows kept a role whose origin the schema now
  // demands and cannot supply — the exact unfalsifiable provenance the
  // `role_source` CHECK exists to forbid.
  const rolesAfter = roleCounts()
  check(
    'v17 drops every role that had no statable origin',
    rolesAfter.unsourced === 0,
    `${rolesBefore.unsourced} unsourced before, ${rolesAfter.unsourced} after`
  )
  // The other half of the same invariant: a role that CAN state its origin is
  // good data and must survive. Without this, a migration that simply nulled
  // every role would pass the check above.
  check(
    'and keeps every role that can state one',
    rolesAfter.sourced === rolesBefore.sourced,
    `${rolesBefore.sourced} sourced before, ${rolesAfter.sourced} after`
  )
}
// Zero-vs-zero would pass on the very rebuild that loses the table.
check(
  'the citation_context check was not vacuous',
  contextsBefore.length > 0,
  `${contextsBefore.length} row(s)`
)
check(
  'no citation_context row points at a missing edge',
  (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM citation_context c
           LEFT JOIN citation_edge e ON e.id = c.edge_id
          WHERE c.edge_id IS NOT NULL AND e.id IS NULL`
      )
      .get() as { c: number }
  ).c === 0
)

// The XOR is the point of the rebuild, so both halves are probed rather than
// assumed from the DDL: a CHECK that was written but not enforced would look
// identical in `sqlite_master`.
const edgeId = (db.prepare('SELECT MIN(id) AS id FROM citation_edge').get() as { id: number | null })
  .id
if (edgeId != null) {
  let refusedBoth = false
  try {
    db.prepare(
      `INSERT INTO citation_context (edge_id, unresolved_reference_id, created_at)
       VALUES (?, 1, '2026-01-01')`
    ).run(edgeId)
  } catch {
    refusedBoth = true
  }
  check('a context naming BOTH an edge and an unresolved reference is refused', refusedBoth)

  let refusedNeither = false
  try {
    db.prepare(
      `INSERT INTO citation_context (edge_id, unresolved_reference_id, created_at)
       VALUES (NULL, NULL, '2026-01-01')`
    ).run()
  } catch {
    refusedNeither = true
  }
  check('a context naming NEITHER target is refused', refusedNeither)

  // The role vocabulary gained exactly one value, and provenance is mandatory.
  let acceptedReview = false
  try {
    db.prepare(
      `INSERT INTO citation_context
         (edge_id, document_id, callout_offset, ordinal, role, role_source, role_cue, created_at)
       VALUES (?, 1, 999999, 999, 'review', 'rule', 'r1-review', '2026-01-01')`
    ).run(edgeId)
    acceptedReview = true
    db.prepare('DELETE FROM citation_context WHERE callout_offset = 999999').run()
  } catch (err) {
    console.log(`   review-role insert threw: ${String(err)}`)
  }
  check(`the role vocabulary accepts 'review'`, acceptedReview)

  let refusedUnsourcedRole = false
  try {
    db.prepare(
      `INSERT INTO citation_context (edge_id, role, created_at)
       VALUES (?, 'method', '2026-01-01')`
    ).run(edgeId)
  } catch {
    refusedUnsourcedRole = true
  }
  check('a role with no role_source is refused', refusedUnsourcedRole)

  // NEGATIVE CONTROL. Every assertion above would also pass on a table that
  // enforced nothing, so one INSERT must be proved to succeed — otherwise
  // "everything was refused" is indistinguishable from a healthy schema.
  let acceptedValid = false
  try {
    db.prepare(
      `INSERT INTO citation_context
         (edge_id, document_id, callout_offset, callout_end, ordinal, occurrence_kind, created_at)
       VALUES (?, 1, 888888, 888892, 42, 'inline', '2026-01-01')`
    ).run(edgeId)
    acceptedValid = true
  } catch (err) {
    console.log(`   valid insert threw: ${String(err)}`)
  }
  check('NEGATIVE CONTROL: a well-formed context row IS accepted', acceptedValid)

  // The site index must reject a duplicate at the same (document, offset,
  // ordinal) while accepting a second ordinal at the SAME offset — a range
  // marker like [12-15] is one site naming four entries.
  let refusedDuplicateSite = false
  try {
    db.prepare(
      `INSERT INTO citation_context
         (edge_id, document_id, callout_offset, callout_end, ordinal, occurrence_kind, created_at)
       VALUES (?, 1, 888888, 888892, 42, 'inline', '2026-01-01')`
    ).run(edgeId)
  } catch {
    refusedDuplicateSite = true
  }
  check('a duplicate (document, offset, ordinal) is refused', refusedDuplicateSite)

  let acceptedRangeSibling = false
  try {
    db.prepare(
      `INSERT INTO citation_context
         (edge_id, document_id, callout_offset, callout_end, ordinal, occurrence_kind, created_at)
       VALUES (?, 1, 888888, 888892, 43, 'inline', '2026-01-01')`
    ).run(edgeId)
    acceptedRangeSibling = true
  } catch (err) {
    console.log(`   range sibling threw: ${String(err)}`)
  }
  check('a second ordinal at the SAME offset is accepted (a range marker)', acceptedRangeSibling)
  db.prepare('DELETE FROM citation_context WHERE callout_offset = 888888').run()
}

// ---------------------------------------------------------------- v75
// The backfill label is honest about which proof each check is: on a source
// already at v75+ the migration had no backfill to run, so these exercise the
// triggers and the coverage detector alone, and the label says so instead of
// letting a green re-run read as proof of the backfill. Point the script at a
// pre-v75 copy to exercise the backfill itself.
const v75Label = (assertion: string): string =>
  v75BackfillRan
    ? assertion
    : `${assertion} (confirmatory — the source already sat at v${startVersion}; the backfill itself was not exercised)`
// The detector first: on a populated DB, `null` means the docsize shadow table
// counts exactly the chunk rows — the index's own honest opinion of its size,
// the one counter an external-content FTS table cannot fake.
const v75Coverage = unindexedLexical(db)
check(
  v75Label('v75 backfill left chunk_fts covering every chunk'),
  v75Coverage === null,
  JSON.stringify(v75Coverage)
)
// Zero-vs-zero would pass on a backfill that indexed nothing, so the coverage
// detector alone is not the assertion: the oldest chunk — under the backfill
// premise, a row the triggers never saw — must answer a query on its own word.
check(
  v75Label('the v75 check was not vacuous'),
  chunksBeforeV75 > 0 && v75Word !== null,
  `${chunksBeforeV75} chunk(s), word="${v75Word ?? ''}"`
)
check(
  v75Label('a pre-migration chunk answers a lexical query on its own word'),
  v75Word !== null &&
    v75Sample !== undefined &&
    // Scoped to the chunk's own work with the limit above any per-work chunk
    // count, so BM25 ranking over a corpus-common word cannot hide the row:
    // the query is about the index HOLDING the row's text, not about it
    // ranking well.
    searchLexical(
      db,
      v75Word,
      { workId: v75Sample.work_id, spaceId: v75Sample.space_id },
      10_000
    ).some(
      (h) => h.chunkId === v75Sample.id
    )
)

// The tokenizer convergence: `convergeChunkFtsDefinition` runs on every
// writable open of a database at 75+, and its EXACT-equality check is
// load-bearing — a table drifted to `unicode61 remove_diacritics 2` CONTAINS
// that substring yet has lost the porter stemmer, so a substring check passes
// it forever while stemmed queries silently miss, row counts stay equal and
// the coverage detector stays quiet. The drift is staged here on the copy,
// converged by a real `runMigrations` open, and required to land on the
// SHIPPED option exactly. The option is extracted here independently of the
// migration's own helper, so a regression in that helper cannot hide behind
// the very function it broke.
const ftsSql = (): string =>
  (
    db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chunk_fts'`)
      .get() as { sql: string } | undefined
  )?.sql ?? ''
const tokenizeOption = (sql: string): string | null => {
  const m = /tokenize\s*=\s*'([^']*)'/.exec(sql)
  return m === null ? null : (m[1] ?? null)
}
const shippedTokenize = tokenizeOption(SCHEMA_V75_CHUNK_FTS)
check('the shipped chunk_fts statement names a tokenize option', shippedTokenize !== null)
db.exec('DROP TABLE chunk_fts')
db.exec(
  `CREATE VIRTUAL TABLE chunk_fts USING fts5(text, content='chunk', content_rowid='id', ` +
    `tokenize='unicode61 remove_diacritics 2')`
)
check(
  'the staged drift is the case a substring check would pass',
  ftsSql().includes('remove_diacritics 2') && !ftsSql().includes('porter'),
  tokenizeOption(ftsSql()) ?? '(none)'
)
runMigrations(db, { hasExclusiveLock: true })
check(
  'a drifted chunk_fts converges on the shipped tokenizer option',
  tokenizeOption(ftsSql()) === shippedTokenize,
  `${tokenizeOption(ftsSql()) ?? '(none)'} vs shipped ${shippedTokenize ?? '(none)'}`
)

// Idempotency: the runner walks every version on every open.
const healthyFtsSql = ftsSql()
const secondPass = runMigrations(db, { hasExclusiveLock: true })
check('re-running the migration is a no-op', secondPass === reached)
check('a healthy chunk_fts is untouched by the second pass', ftsSql() === healthyFtsSql)
const coverageAfterPasses = unindexedLexical(db)
check(
  'chunk_fts still covers every chunk after the passes',
  coverageAfterPasses === null,
  JSON.stringify(coverageAfterPasses)
)
const linksAfterSecond = (
  db
    .prepare(
      'SELECT id, retrieval_job_id FROM unresolved_reference WHERE retrieval_job_id IS NOT NULL ORDER BY id'
    )
    .all() as Array<{ id: number; retrieval_job_id: number }>
).length
check('links still intact after the second pass', linksAfterSecond === linksBefore.length)

// NEGATIVE CONTROL: the downgrade guard is the only thing standing between an
// older build and a database a newer one migrated — a schema the old build
// cannot know. It must THROW, by name, and the copy must open again once the
// version is restored; a silent clamp here would be invisible to every
// healthy-path assertion above.
const head = secondPass
db.pragma(`user_version = ${head + 1}`)
let downgradeMessage: string | null = null
try {
  runMigrations(db, { hasExclusiveLock: true })
} catch (err) {
  downgradeMessage = (err as Error).message
}
check(
  'a newer-than-app user_version is refused, not clamped',
  downgradeMessage !== null && /Refusing to downgrade/.test(downgradeMessage),
  downgradeMessage ?? 'no throw'
)
db.pragma(`user_version = ${head}`)
check('restored, the copy opens again', runMigrations(db, { hasExclusiveLock: true }) === head)

check('integrity_check', (db.pragma('integrity_check', { simple: true }) as string) === 'ok')
check('foreign_key_check empty', (db.pragma('foreign_key_check') as unknown[]).length === 0)

// ------------------------------------------------- the DAMAGE negative control
// Everything above reports "no FK link was lost". Without this section that
// sentence is unfalsifiable: a detector that can never fire says the same thing
// about a healthy schema and about one it is simply blind to. The v14 rebuild
// really did silently NULL `unresolved_reference.retrieval_job_id`, and BOTH
// `foreign_key_check` and `integrity_check` reported clean while it happened —
// `defer_foreign_keys` defers violation CHECKING, not `ON DELETE SET NULL`
// ACTION clauses, so the child is rewritten before anything looks at it.
//
// So: build the failure on purpose, in a scratch DB, and require the same
// rowid-diff method used above to CATCH it. If this ever stops failing, the
// method has gone blind and every clean result above is worthless.
{
  const probe = new Database(':memory:')
  probe.pragma('foreign_keys = ON')
  probe.exec(`
    CREATE TABLE parent (id INTEGER PRIMARY KEY, v TEXT);
    CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER
      REFERENCES parent(id) ON DELETE SET NULL);
    INSERT INTO parent (id, v) VALUES (1, 'a');
    INSERT INTO child (id, parent_id) VALUES (1, 1), (2, 1), (3, 1);
  `)
  const linked = (): number =>
    (probe.prepare('SELECT COUNT(*) AS c FROM child WHERE parent_id IS NOT NULL').get() as {
      c: number
    }).c
  const linksBeforeRebuild = linked()

  // The naive rebuild, exactly as it would be written by someone who trusts
  // `defer_foreign_keys` to cover this.
  probe.exec('BEGIN')
  probe.pragma('defer_foreign_keys = ON')
  probe.exec(`
    CREATE TABLE parent_new (id INTEGER PRIMARY KEY, v TEXT, extra TEXT);
    INSERT INTO parent_new (id, v) SELECT id, v FROM parent;
    DROP TABLE parent;
    ALTER TABLE parent_new RENAME TO parent;
  `)
  probe.exec('COMMIT')

  const linksAfterRebuild = linked()
  const fkClean = (probe.pragma('foreign_key_check') as unknown[]).length === 0
  const integrityClean = (probe.pragma('integrity_check', { simple: true }) as string) === 'ok'

  check(
    'NEGATIVE CONTROL: a naive rebuild really does silently null its children',
    linksAfterRebuild < linksBeforeRebuild,
    `${linksBeforeRebuild} -> ${linksAfterRebuild} link(s)`
  )
  check(
    'NEGATIVE CONTROL: and neither standard pragma notices, which is why we count rows',
    fkClean && integrityClean,
    `foreign_key_check clean=${fkClean} integrity=ok=${integrityClean}`
  )
  probe.close()
}

db.close()
rmSync(work, { force: true })
rmSync(`${work}-wal`, { force: true })
rmSync(`${work}-shm`, { force: true })

console.log(failures === 0 ? '\nALL MIGRATION CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
