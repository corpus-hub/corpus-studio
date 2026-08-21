// Drive real jobs through the real scheduler against a real seeded DB.
//
//   npm run verify:pipeline
//
// Every claim the foundation wave makes is asserted here against behaviour, not
// against the design document: the graph resolves and rejects what it should,
// a planned pipeline runs in dependency order, re-running hits the cache, a
// fingerprint change supersedes, a cancel mid-stage leaves nothing behind, a
// simulated kill resumes, and — the rule the whole gate exists for — two
// concurrent LLM-using stages never overlap.

import { appendFileSync, copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initDatabase, type DB } from '../src/main/db/connection'
import { seed } from '../src/main/db/seed'
import { extractPdfText } from '../src/main/citations/extractText'
import { GLOBAL_LLM_SEMAPHORE } from '../src/main/llm/provider'
import { UnavailableLlmProvider } from '../src/main/llm/provider'
import { LLM_GATE } from '../src/main/pipeline/gate/llmGate'
import { resolveRegistry, StageGraphError } from '../src/main/pipeline/registry'
import { keyOf, supersedeCascade } from '../src/main/pipeline/stageRun'
import { sweepVectorOrphans } from '../src/main/embedding/vectors'
import { Scheduler } from '../src/main/pipeline/scheduler'
import { staleWorks } from '../src/main/pipeline/staleness'
import { STAGES } from '../src/main/pipeline/stages'
import type { StageDefinition } from '../src/main/pipeline/types'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
function section(name: string): void {
  console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 58 - name.length))}`)
}

/**
 * A section that could not run, and what it would take to run it.
 *
 * The three end-to-end sections depend on things a checkout does not carry — a
 * real PDF on disk, a scanned paper with no text layer, a packaged embedding
 * model — so they cannot simply be `check(false)`: a machine that legitimately
 * has no corpus would then report a broken pipeline. But they are also the only
 * sections that put real input through the real stages, and they used to print
 * one indented `skipped:` line and leave the run ending in ALL PIPELINE CHECKS
 * PASSED. That is precisely the failure this file's own rule names at the
 * `download` stage: a check that skips is a check that is not running.
 *
 * So a skip is COUNTED, restated at the end with its reason and its remedy, and
 * decides the EXIT CODE — 2, distinct from the 1 a real failure gives, because
 * "the pipeline is broken" and "nobody asked the pipeline anything" call for
 * different responses from whoever reads it. What a skip may never be is 0.
 */
const skipped: Array<{ section: string; why: string; remedy: string }> = []
function skip(name: string, why: string, remedy: string): void {
  console.log(`SKIP  ${name} — ${why}`)
  skipped.push({ section: name, why, remedy })
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  const dbPath = join(tmpdir(), `corpus-pipeline-check-${process.pid}.sqlite`)
  for (const s of ['', '-wal', '-shm']) rmSync(`${dbPath}${s}`, { force: true })
  const db: DB = initDatabase(dbPath)
  seed(db)

  /**
   * Wait until the given jobs are all terminal.
   *
   * Scoped to specific ids rather than "every stage job": each section below
   * builds its own throwaway registry and leaves its jobs behind, so a global
   * predicate would make every later section wait on an earlier one's residue.
   *
   * The budget covers a COLD `embed`, which is the slowest thing here by a wide
   * margin: the first call loads an ONNX model and its tokenizer from disk
   * before a single vector is produced, and 30 s was not enough for it on a
   * machine doing anything else. It fitted before only because the LLM stages
   * beside it answered from a table in the same tick — a budget calibrated
   * against a fixture, not against the work.
   */
  async function drain(sched: Scheduler, ids: number[], budgetMs = 180_000): Promise<void> {
    const deadline = Date.now() + budgetMs
    const list = ids.map(() => '?').join(',')
    while (Date.now() < deadline) {
      const live = (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM processing_job
              WHERE id IN (${list}) AND status IN ('queued','running','blocked')`
          )
          .get(...ids) as { c: number }
      ).c
      if (live === 0 && sched.inFlightCount() === 0) return
      await sleep(25)
    }
    // NAME the jobs that did not finish. "did not drain within the budget" sends
    // the reader hunting a scheduler deadlock when the cause is usually one
    // stage stuck in one state, which this prints directly.
    const stuck = db
      .prepare(
        `SELECT id, stage, status, attempts, substr(COALESCE(error,''), 1, 80) AS error
           FROM processing_job
          WHERE id IN (${list}) AND status IN ('queued','running','blocked')
          ORDER BY id`
      )
      .all(...ids) as Array<Record<string, unknown>>
    throw new Error(
      `pipeline did not drain within the budget; in flight ${sched.inFlightCount()}, ` +
        `outstanding: ${JSON.stringify(stuck)}`
    )
  }

  // ---------------------------------------------------------------- graph
  section('registry: the graph validates itself at boot')
  const registry = resolveRegistry(STAGES)
  check(
    'the shipped registry resolves',
    registry.order.length === STAGES.length,
    registry.order.map((r) => r.stage.id).join(' -> ')
  )
  check(
    'ordering is derived from tokens, not declaration order',
    (registry.byId('download')?.index ?? 9) < (registry.byId('extract-text')?.index ?? 0)
  )

  const base = (over: Partial<StageDefinition>): StageDefinition => ({
    id: 'x',
    label: 'X',
    version: '1',
    scope: 'document',
    provides: [],
    requires: [],
    usesLlm: false,
    runtime: 'node',
    async execute() {
      return { status: 'succeeded', result: null }
    },
    ...over
  })
  const rejects = (label: string, stages: StageDefinition[], expect: RegExp): void => {
    let msg = '(did not throw)'
    try {
      resolveRegistry(stages)
    } catch (err) {
      msg = err instanceof StageGraphError ? err.message : `wrong error type: ${String(err)}`
    }
    check(`rejects ${label}`, expect.test(msg), msg.slice(0, 110))
  }
  rejects(
    'an unprovided token',
    [base({ id: 'a', requires: ['nope@v1'] })],
    /requires 'nope@v1'/
  )
  rejects(
    'a version mismatch, naming the near miss',
    [base({ id: 'a', provides: ['t@v2'] }), base({ id: 'b', requires: ['t@v1'] })],
    /did you mean t@v2/
  )
  rejects(
    'two non-transformer providers of one token',
    [base({ id: 'a', provides: ['t@v1'] }), base({ id: 'b', provides: ['t@v1'] })],
    /non-transformer providers/
  )
  rejects(
    'a duplicate stage id',
    [base({ id: 'a' }), base({ id: 'a' })],
    /duplicate stage id/
  )
  rejects(
    'a transforms it does not both require and provide',
    [base({ id: 'a', provides: ['t@v1'] }), base({ id: 'b', provides: ['t@v1'], transforms: 't@v1' })],
    /does not both require and provide/
  )
  rejects(
    'a cycle',
    [
      base({ id: 'a', requires: ['u@v1'], provides: ['t@v1'] }),
      base({ id: 'b', requires: ['t@v1'], provides: ['u@v1'] })
    ],
    /cycle/
  )

  section('registry: positional resolution + transformer transparency')
  const producer = base({ id: 'producer', rank: 1, provides: ['t@v1'] })
  const transformer = base({ id: 'transformer', rank: 2, requires: ['t@v1'], provides: ['t@v1'], transforms: 't@v1' })
  const consumer = base({ id: 'consumer', rank: 3, requires: ['t@v1'] })
  const triple = resolveRegistry([consumer, transformer, producer])
  check(
    'a transformer is ordered between its producer and its consumer',
    triple.order.map((r) => r.stage.id).join(',') === 'producer,transformer,consumer',
    triple.order.map((r) => r.stage.id).join(',')
  )
  const forTransformer = triple.providersFor('t@v1', triple.byId('transformer')?.index ?? 0)
  check(
    'a transformer never resolves its own unwritten output',
    forTransformer.length === 1 && forTransformer[0].id === 'producer',
    forTransformer.map((s) => s.id).join(',')
  )
  const forConsumer = triple.providersFor('t@v1', triple.byId('consumer')?.index ?? 0)
  check(
    'a consumer sees the whole chain, nearest first',
    forConsumer.map((s) => s.id).join(',') === 'transformer,producer',
    forConsumer.map((s) => s.id).join(',')
  )
  check(
    'a consumer depends on EVERY earlier provider, not just the nearest',
    [...triple.dependenciesFor('consumer')].sort().join(',') === 'producer,transformer'
  )
  const gate = base({ id: 'gate', before: ['t@v1'] })
  const gated = resolveRegistry([producer, gate])
  check(
    'a before: gate is ordered first',
    gated.order[0].stage.id === 'gate',
    gated.order.map((r) => r.stage.id).join(',')
  )
  check(
    'a before: gate is a real dependency, so its refusal can cancel',
    gated.dependenciesFor('producer').includes('gate')
  )

  // ---------------------------------------------------------- optional inputs
  //
  // An enrichment must behave EXACTLY like a required token everywhere except
  // the staleness gate. Every property below was load-bearing when the crops
  // were declared under `requires`, so a fix that dropped any of them would
  // trade a silent gap for a silent staleness bug — the two positive checks are
  // what stop `enriches` from becoming a way to leave a token out of
  // invalidation.
  const optProducer = base({ id: 'opt-producer', rank: 1, provides: ['o@v1'] })
  const optConsumer = base({
    id: 'opt-consumer',
    rank: 2,
    requires: ['t@v1'],
    enriches: ['o@v1']
  })
  const opt = resolveRegistry([producer, optProducer, optConsumer])
  check(
    'an optional input still ORDERS its consumer after the provider',
    (opt.byId('opt-producer')?.index ?? 9) < (opt.byId('opt-consumer')?.index ?? 0),
    opt.order.map((r) => r.stage.id).join(',')
  )
  check(
    'an optional input is a real job_dependency, so the stage waits rather than racing',
    opt.dependenciesFor('opt-consumer').includes('opt-producer'),
    opt.dependenciesFor('opt-consumer').join(',')
  )
  rejects(
    'an unprovided OPTIONAL token — "optional" is about the value, not the spelling',
    [base({ id: 'a', enriches: ['nope@v1'] })],
    /enriches 'nope@v1'/
  )
  rejects(
    'a token declared BOTH required and optional',
    [base({ id: 'a', provides: ['t@v1'] }), base({ id: 'b', requires: ['t@v1'], enriches: ['t@v1'] })],
    /both requires and enriches/
  )
  // THE WHOLE POINT, stated as an assertion rather than as a comment: an
  // enrichment that no provider has produced must NOT remove its consumer from
  // the staleness sweep. It did, and a paywalled paper's extracted records went
  // unaudited while its queue row showed nothing pending — a review that never
  // happened, drawn exactly like one that happened and found nothing.
  {
    // Its OWN database, because the fixture is a pipeline that settled the way a
    // paywalled paper's really does — `retrieve` refused, so nothing downstream
    // of the bytes ever ran — and the shared corpus below holds a paper with a
    // PDF, which is the case that never had the bug.
    const nopdfPath = join(tmpdir(), `corpus-nopdf-check-${process.pid}.sqlite`)
    rmSync(nopdfPath, { force: true })
    rmSync(`${nopdfPath}-wal`, { force: true })
    rmSync(`${nopdfPath}-shm`, { force: true })
    const nopdf: DB = initDatabase(nopdfPath)
    const t = new Date().toISOString()
    nopdf
      .prepare(`INSERT INTO project (id, name, slug, created_at, updated_at) VALUES (1,'P','p',?,?)`)
      .run(t, t)
    nopdf
      .prepare(`INSERT INTO work (id, title, created_at, updated_at) VALUES (1,'Paywalled',?,?)`)
      .run(t, t)
    nopdf
      .prepare(`INSERT INTO project_work (project_id, work_id, created_at, updated_at) VALUES (1,1,?,?)`)
      .run(t, t)
    const runRow = nopdf.prepare(
      `INSERT INTO stage_run (stage, stage_version, work_id, document_id, project_id, schema_id,
                              fanout_key, status, input_fingerprint, created_at)
         VALUES (?,?,1,0,?,0,'',?,?,?)`
    )
    runRow.run('retrieve', '1.0.0', 0, 'refused', 'fp-retrieve', t)
    runRow.run('segment', '1.0.0', 0, 'succeeded', 'fp-seg', t)
    runRow.run('schema-extract', '1.0.0', 1, 'succeeded', 'fp-ext', t)
    const swept = staleWorks(nopdf, resolveRegistry(STAGES), 1)
    check(
      'a paper with no PDF is still swept for Review records',
      (swept.get(1)?.labels ?? []).includes('Review records'),
      (swept.get(1)?.labels ?? []).join(', ')
    )
    nopdf.close()
    rmSync(nopdfPath, { force: true })
    rmSync(`${nopdfPath}-wal`, { force: true })
    rmSync(`${nopdfPath}-shm`, { force: true })
  }

  // ---------------------------------------------------------------- run
  section('scheduler: plan and drain a real pipeline')
  // The UNAVAILABLE provider — what the app itself selects when no gateway
  // answers. So this drains the pipeline under exactly the conditions an
  // offline machine runs it, and proves the scheduler handles a refusing model
  // without wedging.
  //
  // Not a scripted one. The subject here is the plan/lease/dependency
  // machinery, and canned model output would add a variable irrelevant to it —
  // while an EMPTY script starves the LLM stages into a drain timeout that
  // reads like a scheduler deadlock. That misdiagnosis is what this comment
  // exists to stop someone re-introducing.
  const provider = new UnavailableLlmProvider('verify:pipeline runs with no gateway by design')
  const sched = new Scheduler(db, provider, { concurrency: 2, idleMs: 20 })
  const doc = db.prepare('SELECT id, work_id FROM document ORDER BY id LIMIT 1').get() as {
    id: number
    work_id: number
  }
  const planned = sched.plan({ workId: doc.work_id, documentId: doc.id, projectId: 1 })
  // Every registered stage that is not corpus-scoped, plus one job per schema
  // for the stage that fans out. Derived from the registry rather than written
  // as a literal, so adding a stage does not make this assertion wrong.
  const perSubject = registry.order.filter((r) => r.stage.scope !== 'corpus').length
  check(
    'planning wrote at least one job per document-scoped stage',
    planned.length >= perSubject,
    `${planned.length} job(s) for ${perSubject} stage(s)`
  )
  const edges = (
    db.prepare('SELECT COUNT(*) AS c FROM job_dependency').get() as { c: number }
  ).c
  check('dependency edges were written', edges > 0, `${edges} edge(s)`)

  const replanned = sched.plan({ workId: doc.work_id, documentId: doc.id, projectId: 1 })
  check('re-planning the same work is idempotent', replanned.length === 0)

  sched.start()
  await drain(sched, planned)
  sched.stop()

  const runs = db
    .prepare(
      `SELECT stage, status, outcome_note, duration_ms, input_fingerprint
         FROM stage_run
        WHERE superseded = 0 AND work_id IN (?, 0) ORDER BY id`
    )
    .all(doc.work_id) as Array<{
    stage: string
    status: string
    outcome_note: string | null
    duration_ms: number | null
    input_fingerprint: string
  }>
  for (const r of runs) console.log(`   ${r.stage}: ${r.status} — ${r.outcome_note ?? ''}`)
  check(
    'every planned stage produced a current stage_run',
    new Set(runs.map((r) => r.stage)).size >= perSubject,
    `${runs.length} run(s) over ${new Set(runs.map((r) => r.stage)).size} stage(s)`
  )
  check(
    'every run is terminal',
    runs.every((r) => r.status !== 'running')
  )
  check(
    'every run recorded a duration',
    runs.every((r) => r.duration_ms !== null && r.duration_ms >= 0)
  )

  // Scoped to the jobs THIS section planned. The seeder writes its own stage
  // jobs for queue-screen variety, and judging them here would assert against
  // fixture rows rather than against anything this run did.
  const jobs = db
    .prepare(
      `SELECT stage, status, outcome, outcome_note, started_at, finished_at
         FROM processing_job WHERE id IN (${planned.map(() => '?').join(',')}) ORDER BY id`
    )
    .all(...planned) as Array<{
    stage: string
    status: string
    outcome: string | null
    outcome_note: string | null
    started_at: string | null
    finished_at: string | null
  }>
  check(
    'every stage job carries BOTH timing stamps',
    jobs.every((j) => j.started_at !== null && j.finished_at !== null),
    jobs.map((j) => `${j.stage}:${j.started_at ? 'S' : '-'}${j.finished_at ? 'F' : '-'}`).join(' ')
  )
  check(
    'every terminal job records WHY, not just that it ended',
    jobs.every((j) => j.outcome !== null && (j.outcome === 'succeeded' || Boolean(j.outcome_note)))
  )
  // BOTH abstaining outcomes, not just `empty`.
  //
  // `refused` belongs here for exactly the reason `empty` does: it is a claim
  // about the paper that a person should see, and filing it `done` makes it
  // green in the queue. The biconditional is the point in both directions — an
  // abstention must reach review, and nothing else may sit there wearing the
  // same badge.
  const ABSTAINED = new Set(['empty', 'refused'])
  check(
    'an empty or refused outcome lands in review, never silently green',
    jobs.every((j) => ABSTAINED.has(j.outcome ?? '') === (j.status === 'review')),
    jobs
      .filter((j) => ABSTAINED.has(j.outcome ?? '') !== (j.status === 'review'))
      .map((j) => `${j.stage}:${j.outcome}/${j.status}`)
      .join(' ')
  )

  // ---------------------------------------------------------------- cache
  section('cache: a re-run hits, a fingerprint change supersedes')
  // Same subject filter as `runs` above: the seeder's own stage jobs run
  // against OTHER works, and counting them here would make the cache assertion
  // report someone else's fresh run as this one's miss.
  const runIdsBefore = (
    db
      .prepare('SELECT id FROM stage_run WHERE superseded = 0 AND work_id IN (?, 0) ORDER BY id')
      .all(doc.work_id) as { id: number }[]
  ).map((r) => r.id)

  // A fresh pipeline over the same subject must reuse the stored runs rather than
  // redo the work: `stage_run` identity is (stage, work, document, project,
  // schema, fanout), not (job).
  db.prepare(
    `UPDATE processing_job SET status = 'queued', outcome = NULL, started_at = NULL,
            finished_at = NULL, attempts = 0, stage_run_id = NULL
      WHERE id IN (${planned.map(() => '?').join(',')})`
  ).run(...planned)
  sched.start()
  await drain(sched, planned)
  sched.stop()
  const runIdsAfter = (
    db
      .prepare('SELECT id FROM stage_run WHERE superseded = 0 AND work_id IN (?, 0) ORDER BY id')
      .all(doc.work_id) as { id: number }[]
  ).map((r) => r.id)
  check(
    'a re-run was a cache hit — no new stage_run was inserted',
    JSON.stringify(runIdsAfter) === JSON.stringify(runIdsBefore),
    `${runIdsBefore.join(',')} vs ${runIdsAfter.join(',')}`
  )

  // Change an input the fingerprint covers. `download` keys on the BYTES, so
  // rewriting the file must invalidate it AND everything downstream — without
  // either stage naming the other.
  //
  // The corpus lives in a read-only shared directory, so THIS DOCUMENT is
  // repointed at a scratch copy first: a verification script that mutates the
  // user's library to prove a point is not a verification script.
  //
  // A NEW base_dir row, with only THIS document's `file_location` moved onto
  // it. Every paper in the corpus shares one base dir, so relocating that row
  // would move all twenty into a scratch directory holding a single file, and
  // every later section wanting a different PDF would find nothing and quietly
  // skip — a check that skips is a check that is not running.
  const loc = db
    .prepare(
      `SELECT bd.id AS base_dir_id, bd.abs_path AS abs_path, fl.relative_path AS rel
         FROM file_location fl JOIN base_dir bd ON bd.id = fl.base_dir_id
        WHERE fl.document_id = ? LIMIT 1`
    )
    .get(doc.id) as { base_dir_id: number; abs_path: string; rel: string }
  const scratchDir = join(tmpdir(), `corpus-pipeline-corpus-${process.pid}`)
  mkdirSync(scratchDir, { recursive: true })
  copyFileSync(join(loc.abs_path, loc.rel), join(scratchDir, loc.rel))
  const scratchBaseDirId = Number(
    db
      .prepare(
        `INSERT INTO base_dir (label, abs_path, created_at)
         VALUES ('pipeline-check scratch', ?, ?)`
      )
      .run(scratchDir, new Date().toISOString()).lastInsertRowid
  )
  db.prepare('UPDATE file_location SET base_dir_id = ? WHERE document_id = ?').run(
    scratchBaseDirId,
    doc.id
  )
  appendFileSync(join(scratchDir, loc.rel), '\n% a byte that was not there before\n')
  db.prepare(
    `UPDATE processing_job SET status = 'queued', outcome = NULL, started_at = NULL,
            finished_at = NULL, attempts = 0, stage_run_id = NULL
      WHERE id IN (${planned.map(() => '?').join(',')})`
  ).run(...planned)
  sched.start()
  await drain(sched, planned)
  sched.stop()
  const afterChange = db
    .prepare(
      `SELECT id, stage, input_fingerprint FROM stage_run
        WHERE superseded = 0 AND work_id IN (?, 0) ORDER BY stage`
    )
    .all(doc.work_id) as Array<{ id: number; stage: string; input_fingerprint: string }>
  check(
    'an input change superseded every DOCUMENT-scoped run and inserted new ones',
    afterChange
      .filter((r) => registry.byId(r.stage)?.stage.scope !== 'corpus')
      .every((r) => !runIdsBefore.includes(r.id)),
    afterChange.map((r) => `${r.stage}#${r.id}`).join(' ')
  )
  // A CORPUS sweep is keyed on work_id = 0, so a change to one document is not
  // an input change for it. Superseding it here would mean the cascade reached
  // across subjects, which is exactly what the key exists to prevent.
  check(
    'a corpus-scoped run is NOT superseded by a per-document change',
    afterChange.some(
      (r) => registry.byId(r.stage)?.stage.scope === 'corpus' && runIdsBefore.includes(r.id)
    )
  )
  check(
    'the change cascaded DOWNSTREAM without either stage naming the other',
    (afterChange.find((r) => r.stage === 'extract-text')?.input_fingerprint ?? '') !==
      (runs.find((r) => r.stage === 'extract-text')?.input_fingerprint ?? 'unchanged')
  )
  // Every run that WAS superseded must still exist; the corpus one that was not
  // touched is exempt because there was nothing to supersede it.
  const stillThere = runIdsBefore.filter((id) => {
    const row = db.prepare('SELECT superseded FROM stage_run WHERE id = ?').get(id) as
      | { superseded: number }
      | undefined
    return row !== undefined
  })
  check(
    'the old runs were superseded, not deleted — the history is still diffable',
    stillThere.length === runIdsBefore.length,
    `${stillThere.length}/${runIdsBefore.length} preserved`
  )
  const currentKeys = db
    .prepare(
      `SELECT stage, work_id, document_id, project_id, schema_id, fanout_key, COUNT(*) AS c
         FROM stage_run WHERE superseded = 0
        GROUP BY stage, work_id, document_id, project_id, schema_id, fanout_key HAVING c > 1`
    )
    .all() as unknown[]
  check('exactly one current run per key survives the unique index', currentKeys.length === 0)

  // ---------------------------------------------------------------- cancel
  section('cancel mid-stage leaves nothing behind')
  const slowStage: StageDefinition = base({
    id: 'slow',
    label: 'Slow',
    provides: ['slow.out@v1'],
    applyWrites(wdb, payload, wctx) {
      wdb
        .prepare('UPDATE work SET title = ? WHERE id = ?')
        .run((payload as { title: string }).title, wctx.workId)
    },
    async execute(ctx) {
      ctx.emit('slow.out@v1', { should: 'never be committed' })
      ctx.write({ title: 'CANCEL LEAKED' })
      for (let i = 0; i < 200; i++) {
        if (ctx.signal.aborted) return { status: 'failed', error: 'cancelled', retryable: true }
        await sleep(10)
      }
      return { status: 'succeeded', result: null }
    }
  })
  const cancelReg = resolveRegistry([slowStage])
  const cancelSched = new Scheduler(db, provider, { concurrency: 1, idleMs: 10, registry: cancelReg })
  const cancelJobs = cancelSched.plan({ workId: doc.work_id, documentId: doc.id, projectId: 1 })
  const titleBefore = (
    db.prepare('SELECT title FROM work WHERE id = ?').get(doc.work_id) as { title: string }
  ).title
  cancelSched.start()
  await sleep(200)
  const runningRun = db
    .prepare(`SELECT id FROM stage_run WHERE stage = 'slow' AND status = 'running'`)
    .get() as { id: number } | undefined
  check('the slow stage really was running when cancelled', runningRun !== undefined)
  cancelSched.cancel(cancelJobs[0])
  await sleep(300)
  cancelSched.stop()

  const cancelled = db
    .prepare('SELECT status, error_kind FROM processing_job WHERE id = ?')
    .get(cancelJobs[0]) as { status: string; error_kind: string | null }
  check('the cancelled job is terminal', cancelled.status === 'cancelled', cancelled.status)
  check('and is distinguishable from a failure', cancelled.error_kind === 'cancelled')
  check(
    'the cancelled run does not hold the current-run slot against its own retry',
    (
      db
        .prepare(`SELECT COUNT(*) AS c FROM stage_run WHERE stage = 'slow' AND superseded = 0`)
        .get() as { c: number }
    ).c === 0
  )
  check(
    'no artifact from the cancelled run survived',
    (
      db
        .prepare('SELECT COUNT(*) AS c FROM stage_artifact WHERE stage_run_id = ?')
        .get(runningRun?.id ?? -1) as { c: number }
    ).c === 0
  )
  check(
    'a queued bulk write never reached the database',
    (db.prepare('SELECT title FROM work WHERE id = ?').get(doc.work_id) as { title: string }).title ===
      titleBefore
  )

  // ---------------------------------------------------------------- resume
  section('resume after a simulated kill')
  // A kill is a process that stops between the claim and the terminal write: the
  // row stays 'running', stamped with a generation that no longer exists.
  db.prepare(
    `UPDATE processing_job SET status = 'running', lease_owner = 'dead-generation',
            attempts = 1, error = NULL, cancel_requested = 0, finished_at = NULL
      WHERE id = ?`
  ).run(cancelJobs[0])
  const orphanRun = Number(
    db
      .prepare(
        `INSERT INTO stage_run (stage, stage_version, work_id, document_id, project_id,
                                schema_id, fanout_key, status, lease_epoch,
                                input_fingerprint, created_at)
         VALUES ('slow', '1', ?, ?, 1, 0, '', 'running', 1, 'orphan', ?)`
      )
      .run(doc.work_id, doc.id, new Date().toISOString()).lastInsertRowid
  )
  db.prepare('UPDATE processing_job SET stage_run_id = ? WHERE id = ?').run(orphanRun, cancelJobs[0])
  db.prepare('INSERT INTO stage_artifact (stage_run_id, key, json) VALUES (?, ?, ?)').run(
    orphanRun,
    'slow.out@v1',
    '{"partial":true}'
  )

  const resumeSched = new Scheduler(db, provider, { concurrency: 1, idleMs: 10, registry: cancelReg })
  const requeued = resumeSched.resumePending()
  check('the abandoned job was re-queued', requeued === 1, `${requeued} row(s)`)
  check(
    'its attempt was refunded — the process died, the job did not fail',
    (db.prepare('SELECT attempts FROM processing_job WHERE id = ?').get(cancelJobs[0]) as {
      attempts: number
    }).attempts === 0
  )
  check(
    'its orphaned stage_run was superseded in the same transaction',
    (db.prepare('SELECT superseded FROM stage_run WHERE id = ?').get(orphanRun) as {
      superseded: number
    }).superseded === 1
  )
  check(
    'and its partial output was collected',
    (
      db.prepare('SELECT COUNT(*) AS c FROM stage_artifact WHERE stage_run_id = ?').get(orphanRun) as {
        c: number
      }
    ).c === 0
  )

  // A job THIS process is running must not be re-queued by the same call — the
  // close guard restarts the scheduler while stages are still in flight.
  db.prepare(
    `UPDATE processing_job SET status = 'running', lease_owner = 'dead-generation' WHERE id = ?`
  ).run(cancelJobs[0])
  const liveSched = new Scheduler(db, provider, { concurrency: 1, idleMs: 10, registry: cancelReg })
  liveSched.start()
  await sleep(60)
  const claimedByLive = db
    .prepare('SELECT status, lease_owner FROM processing_job WHERE id = ?')
    .get(cancelJobs[0]) as { status: string; lease_owner: string | null }
  const beforeSecondResume = claimedByLive.lease_owner
  liveSched.resumePending()
  const afterSecondResume = db
    .prepare('SELECT status, lease_owner FROM processing_job WHERE id = ?')
    .get(cancelJobs[0]) as { status: string; lease_owner: string | null }
  check(
    'resumePending does NOT re-queue a job this process is executing',
    claimedByLive.status !== 'running' || afterSecondResume.lease_owner === beforeSecondResume,
    `${claimedByLive.status} owner=${String(afterSecondResume.lease_owner)}`
  )
  liveSched.stop()
  await sleep(2500)

  // ---------------------------------------------------------------- the gate
  section('the single-LLM-slot rule')
  LLM_GATE.resetStats()
  let observedConcurrent = 0
  let peakObserved = 0
  const llmStage = (id: string, rank: number): StageDefinition =>
    base({
      id,
      label: id,
      rank,
      usesLlm: true,
      provides: [`${id}.out@v1`],
      async execute(ctx) {
        // Two INDEPENDENT witnesses: the gate's own counter, and one kept out
        // here by the callers. A gate that only asserts against itself proves
        // nothing about what a stage author actually experiences.
        await ctx.llm.call([{ role: 'user', content: `hello from ${id}` }])
        return { status: 'succeeded', result: null }
      }
    })
  // Acquires the gate the same way every real provider does. The gate lives in
  // the provider layer, so a stand-in that skipped it would be testing nothing.
  const witnessedProvider = {
    name: 'witness',
    model: 'witness',
    async callLLM(): Promise<string> {
      return GLOBAL_LLM_SEMAPHORE.run(async () => {
        observedConcurrent++
        if (observedConcurrent > peakObserved) peakObserved = observedConcurrent
        await sleep(60)
        observedConcurrent--
        return '{}'
      })
    }
  }
  const llmStages = [llmStage('llm-a', 1), llmStage('llm-b', 2), llmStage('llm-c', 3)]
  const llmReg = resolveRegistry(llmStages)
  // Concurrency 3 so all three stages are genuinely dispatched at once: the point
  // is that the GATE serializes them, not that the scheduler never fans out.
  const llmSched = new Scheduler(db, witnessedProvider, {
    concurrency: 3,
    idleMs: 10,
    registry: llmReg
  })
  const llmJobs = llmSched.plan({ workId: doc.work_id, documentId: doc.id, projectId: 1 })
  check('three LLM stages were dispatched concurrently', llmJobs.length === 3)
  llmSched.start()
  await drain(llmSched, llmJobs)
  llmSched.stop()
  check(
    'the gate never let two calls overlap (its own counter)',
    LLM_GATE.peak() === 1,
    `peak = ${LLM_GATE.peak()}`
  )
  check(
    'and no caller ever observed an overlap either',
    peakObserved === 1,
    `peak observed = ${peakObserved}`
  )
  check(
    'all three calls completed',
    (
      db
        .prepare(`SELECT COUNT(*) AS c FROM processing_job WHERE stage LIKE 'llm-%' AND status = 'done'`)
        .get() as { c: number }
    ).c === 3
  )

  // Direct hammering: 20 concurrent callers, FIFO order, aborts spliced out.
  LLM_GATE.resetStats()
  let liveNow = 0
  let livePeak = 0
  const tickets = Array.from({ length: 20 }, (_, i) => i)
  await Promise.all(
    tickets.map((t) =>
      LLM_GATE.run(
        async () => {
          liveNow++
          if (liveNow > livePeak) livePeak = liveNow
          await sleep(5)
          liveNow--
        },
        { ticket: t }
      )
    )
  )
  check('20 concurrent callers never overlapped', livePeak === 1, `peak = ${livePeak}`)
  check(
    'and were served strictly FIFO',
    LLM_GATE.grants().join(',') === tickets.join(','),
    LLM_GATE.grants().slice(0, 6).join(',') + '…'
  )

  // An aborted waiter must be spliced out, not handed a slot it will never release.
  const holder = new AbortController()
  const abortee = new AbortController()
  let released = false
  const held = LLM_GATE.run(async () => {
    await sleep(120)
    released = true
  }, { signal: holder.signal })
  const waiting = LLM_GATE.run(async () => sleep(5), { signal: abortee.signal })
  await sleep(20)
  abortee.abort()
  const abortOutcome = await waiting.then(() => 'resolved').catch((e) => (e as Error).name)
  check('an aborted waiter rejects rather than silently holding the slot', abortOutcome === 'LlmGateAbortError', abortOutcome)
  await held
  check('the holder still finished normally', released)
  let afterAbort = false
  await LLM_GATE.run(async () => {
    afterAbort = true
  })
  check('the slot was not leaked by the abort', afterAbort)

  section('regressions the code audits caught')

  // The gate is a mutex, not a re-entrant lock. A stage's ctx.llm must NOT
  // acquire it a second time on top of the provider's own acquire, or the inner
  // wait queues behind the outer holder — the same call — and neither proceeds.
  const reentrantReg = resolveRegistry([
    base({
      id: 'reentrancy',
      usesLlm: true,
      provides: ['reentrancy.out@v1'],
      async execute(ctx) {
        await ctx.llm.call([{ role: 'user', content: 'ping' }])
        return { status: 'succeeded', result: null }
      }
    })
  ])
  const reentrantSched = new Scheduler(db, provider, {
    concurrency: 1,
    idleMs: 10,
    registry: reentrantReg
  })
  const reentrantJobs = reentrantSched.plan({
    workId: doc.work_id,
    documentId: doc.id,
    projectId: 1
  })
  reentrantSched.start()
  let reentrantDone = false
  try {
    await drain(reentrantSched, reentrantJobs, 4000)
    reentrantDone = true
  } catch {
    reentrantDone = false
  }
  reentrantSched.stop()
  check('an LLM stage does not deadlock against its own provider', reentrantDone)
  // SETTLED, and settled for the right reason.
  //
  // The subject is re-entrancy, not the answer: what must not happen is the
  // stage waiting forever on a gate it already holds. So the assertion is that
  // the job reached a TERMINAL state — and, specifically, the one that names
  // the refusal, since this gate runs with no gateway and the provider declines
  // every call. Asserting `done` would demand the stage succeed at reaching a
  // model that is deliberately absent, and asserting merely "not queued" would
  // pass on a job that failed for an unrelated reason.
  const reentrantRow = db
    .prepare('SELECT status, outcome FROM processing_job WHERE id = ?')
    .get(reentrantJobs[0]) as { status: string; outcome: string | null }
  check(
    'and settled as a refusal, rather than merely stopping',
    reentrantRow.status === 'review' && reentrantRow.outcome === 'refused',
    `${reentrantRow.status}/${reentrantRow.outcome}`
  )

  // Re-planning while an upstream job is still live must still yield an edge:
  // a fresh downstream job with no dependency row is claimable immediately and
  // would run against an input that does not exist yet.
  const upStage = base({ id: 'up', rank: 1, provides: ['re.tok@v1'] })
  const downStage = base({ id: 'down', rank: 2, requires: ['re.tok@v1'] })
  const partialReg = resolveRegistry([upStage])
  const fullReg = resolveRegistry([upStage, downStage])
  const partialSched = new Scheduler(db, provider, {
    concurrency: 1,
    idleMs: 10,
    registry: partialReg
  })
  const upJobs = partialSched.plan({ workId: doc.work_id, documentId: doc.id, projectId: 1 })
  const fullSched = new Scheduler(db, provider, { concurrency: 1, idleMs: 10, registry: fullReg })
  const bothJobs = fullSched.plan({ workId: doc.work_id, documentId: doc.id, projectId: 1 })
  const downJob = bothJobs.find((id) => !upJobs.includes(id))
  const adoptedEdge = (
    db
      .prepare('SELECT COUNT(*) AS c FROM job_dependency WHERE job_id = ? AND depends_on_job_id = ?')
      .get(downJob ?? -1, upJobs[0]) as { c: number }
  ).c
  check(
    'a re-plan wires a NEW job to the LIVE job it already skipped',
    adoptedEdge === 1,
    `${adoptedEdge} edge(s) from ${String(downJob)} to ${upJobs[0]}`
  )

  // A stage that queued writes and then reported it had nothing is
  // contradicting itself; dropping the rows silently would hide it.
  const contradictoryReg = resolveRegistry([
    base({
      id: 'contradictory',
      provides: ['contradictory.out@v1'],
      applyWrites(wdb, payload, wctx) {
        wdb
          .prepare('UPDATE work SET title = ? WHERE id = ?')
          .run((payload as { title: string }).title, wctx.workId)
      },
      async execute(ctx) {
        ctx.write({ title: 'SKIP LEAKED' })
        return { status: 'skipped', reason: 'not applicable, allegedly' }
      }
    })
  ])
  const titleBeforeContradiction = (
    db.prepare('SELECT title FROM work WHERE id = ?').get(doc.work_id) as { title: string }
  ).title
  const contradictorySched = new Scheduler(db, provider, {
    concurrency: 1,
    idleMs: 10,
    registry: contradictoryReg
  })
  const contradictoryJobs = contradictorySched.plan({
    workId: doc.work_id,
    documentId: doc.id,
    projectId: 1
  })
  contradictorySched.start()
  await drain(contradictorySched, contradictoryJobs)
  contradictorySched.stop()
  const contradictoryJob = db
    .prepare('SELECT status, error FROM processing_job WHERE id = ?')
    .get(contradictoryJobs[0]) as { status: string; error: string | null }
  // `skipped` means "I did not run", so rows and that claim cannot both be
  // true. `empty` is different and is asserted separately below: a stage may
  // legitimately have produced output AND have nothing to report.
  check(
    'writing and then claiming it did not run FAILS rather than silently dropping rows',
    contradictoryJob.status === 'failed',
    contradictoryJob.error ?? contradictoryJob.status
  )
  check(
    'and the contradictory write never landed',
    (db.prepare('SELECT title FROM work WHERE id = ?').get(doc.work_id) as { title: string })
      .title === titleBeforeContradiction
  )

  // The other side of that rule, and it is a real case rather than a symmetry
  // argument: `citation-contexts` writes one bibliography row per reference —
  // the ONLY surviving home for a resolved reference's printed text — and then
  // reports `empty` because no in-text callout could be linked. Both halves are
  // true. Dropping the rows would destroy the raw text; refusing the `empty`
  // would misreport the linking as successful.
  const emptyWriterReg = resolveRegistry([
    base({
      id: 'empty-writer',
      provides: ['empty-writer.out@v1'],
      applyWrites(wdb, payload, wctx) {
        wdb
          .prepare('UPDATE work SET title = ? WHERE id = ?')
          .run((payload as { title: string }).title, wctx.workId)
      },
      async execute(ctx) {
        ctx.write({ title: 'PARTIAL RESULT KEPT' })
        return { status: 'empty', reason: 'part of the answer is that there is nothing' }
      }
    })
  ])
  const emptyWriterSched = new Scheduler(db, provider, {
    concurrency: 1,
    idleMs: 10,
    registry: emptyWriterReg
  })
  const emptyWriterJobs = emptyWriterSched.plan({
    workId: doc.work_id,
    documentId: doc.id,
    projectId: 1
  })
  emptyWriterSched.start()
  await drain(emptyWriterSched, emptyWriterJobs)
  emptyWriterSched.stop()
  check(
    'an EMPTY stage still commits the rows it did produce',
    (db.prepare('SELECT title FROM work WHERE id = ?').get(doc.work_id) as { title: string })
      .title === 'PARTIAL RESULT KEPT'
  )
  check(
    'and it still lands in review, never silently green',
    (db.prepare('SELECT status FROM processing_job WHERE id = ?').get(emptyWriterJobs[0]) as {
      status: string
    }).status === 'review'
  )
  db.prepare('UPDATE work SET title = ? WHERE id = ?').run(titleBeforeContradiction, doc.work_id)

  // A stage with an `empty` and no reason is indistinguishable from a swallowed
  // bug, and `empty` is cached and satisfies dependents.
  const unexplainedReg = resolveRegistry([
    base({
      id: 'unexplained',
      provides: ['unexplained.out@v1'],
      async execute() {
        return { status: 'empty', reason: '   ' }
      }
    })
  ])
  const unexplainedSched = new Scheduler(db, provider, {
    concurrency: 1,
    idleMs: 10,
    registry: unexplainedReg
  })
  const unexplainedJobs = unexplainedSched.plan({
    workId: doc.work_id,
    documentId: doc.id,
    projectId: 1
  })
  unexplainedSched.start()
  await drain(unexplainedSched, unexplainedJobs)
  unexplainedSched.stop()
  check(
    'an unexplained empty is a failure, not a cached blank',
    (
      db.prepare('SELECT status FROM processing_job WHERE id = ?').get(unexplainedJobs[0]) as {
        status: string
      }
    ).status === 'failed'
  )

  // ------------------------------------------------------------- real corpus
  // Everything above drives the MACHINERY. This drives a real paper through
  // every stage that was built, against the PDFs on disk, because a state
  // machine that is provably correct on synthetic stages tells you nothing
  // about whether `segment` finds a paragraph in a two-column Nature article.
  section('a real paper, end to end')
  const realDoc = db
    .prepare(
      `SELECT d.id, d.work_id, bd.abs_path || '/' || fl.relative_path AS path
         FROM document d
         JOIN file_location fl ON fl.document_id = d.id AND fl.role = 'canonical'
         JOIN base_dir bd ON bd.id = fl.base_dir_id
        ORDER BY d.id LIMIT 1`
    )
    .get() as { id: number; work_id: number; path: string } | undefined

  if (!realDoc || !existsSync(realDoc.path)) {
    skip(
      'a real paper, end to end',
      `no readable PDF on disk (${realDoc?.path ?? 'no canonical file_location in the seeded DB'})`,
      'Seed a corpus whose canonical file_location points at PDFs this host can read ' +
        '(CORPUS_DB_PATH=… npm run seed:fresh against a checkout that has scripts/data), then re-run. ' +
        'Until then NOTHING in this run has put a real two-column paper through segment/extract.'
    )
  } else {
    console.log(`   ${realDoc.path.split('/').pop()}`)
    const realSched = new Scheduler(db, provider, { concurrency: 2, idleMs: 20 })
    const realJobs = realSched.plan({
      workId: realDoc.work_id,
      documentId: realDoc.id,
      projectId: 1
    })
    realSched.start()
    await drain(realSched, realJobs, 180_000)
    realSched.stop()

    const realRuns = db
      .prepare(
        `SELECT stage, status, outcome_note FROM stage_run
          WHERE work_id = ? AND document_id = ? AND superseded = 0 ORDER BY id`
      )
      .all(realDoc.work_id, realDoc.id) as Array<{
      stage: string
      status: string
      outcome_note: string | null
    }>
    for (const r of realRuns) {
      console.log(`   ${r.stage.padEnd(19)} ${r.status.padEnd(10)} ${r.outcome_note ?? ''}`)
    }
    // Scoped to the SHIPPED registry: earlier sections deliberately ran
    // throwaway stages (a stage that fails on purpose, one that contradicts
    // itself) against this same subject, and counting those as real-paper
    // failures would make this assertion permanently red for the wrong reason.
    const shipped = realRuns.filter((r) => registry.byId(r.stage) !== undefined)
    check(
      'no SHIPPED stage FAILED on a real paper',
      shipped.every((r) => r.status !== 'failed'),
      shipped.filter((r) => r.status === 'failed').map((r) => r.stage).join(', ')
    )

    // `segment` is the one every anchor depends on, and the one most likely to
    // be quietly wrong: a blank-line splitter returns exactly one paragraph per
    // page on a real text layer and looks like it worked.
    const paraRows = db
      .prepare(
        `SELECT p.para_id, p.char_start, p.char_end, p.text, p.section
           FROM document_paragraph p JOIN stage_run r ON r.id = p.stage_run_id
          WHERE p.document_id = ? AND r.superseded = 0 ORDER BY p.idx`
      )
      .all(realDoc.id) as Array<{
      para_id: string
      char_start: number
      char_end: number
      text: string
      section: string
    }>
    check('segment produced a real paragraph inventory', paraRows.length > 50, `${paraRows.length} paragraph(s)`)
    const sections = new Set(paraRows.map((p) => p.section))
    check('it resolved more than one IMRaD section', sections.size > 1, [...sections].join(','))

    // The exact-slice contract, re-checked against what actually LANDED in the
    // table rather than against what the stage believed it emitted.
    const realText = (await extractPdfText(realDoc.path)).pages.map((p) => p.text).join('\n\f\n')
    const violations = paraRows.filter((p) => realText.slice(p.char_start, p.char_end) !== p.text)
    check(
      'every STORED paragraph still satisfies the exact-slice contract',
      violations.length === 0,
      violations.length > 0 ? `${violations.length} bad, first ${violations[0].para_id}` : ''
    )

    const refCount =
      (
        db
          .prepare('SELECT reference_count AS c FROM work_citation_parse WHERE work_id = ?')
          .get(realDoc.work_id) as { c: number } | undefined
      )?.c ?? 0
    check('references parsed a real bibliography', refCount > 10, `${refCount} entries`)

    const ctxRows = db
      .prepare(
        `SELECT occurrence_kind, role_source, COUNT(*) AS c FROM citation_context
          WHERE citing_work_id = ? AND stage_run_id IS NOT NULL
          GROUP BY occurrence_kind, role_source`
      )
      .all(realDoc.work_id) as Array<{ occurrence_kind: string; role_source: string | null; c: number }>
    console.log(
      `   contexts: ${ctxRows.map((r) => `${r.occurrence_kind}/${r.role_source ?? 'none'}=${r.c}`).join(' ') || 'none'}`
    )
    // The bibliography rows are UNCONDITIONAL: they are the only surviving home
    // for a resolved reference's printed text, so they must exist even when the
    // callout mapping was refused by the confidence gate.
    const bibRows = ctxRows
      .filter((r) => r.occurrence_kind === 'bibliography')
      .reduce((n, r) => n + r.c, 0)
    check(
      'every bibliography entry got a raw-text home',
      bibRows >= refCount,
      `${bibRows} bibliography row(s) for ${refCount} entries`
    )

    // A bibliography that mis-splits prints the same entry number twice — one
    // real paper here printed ordinal 22 five times. Keying the bibliography
    // rows on the ordinal made those rows collide on `ux_citation_context_site`
    // and took the WHOLE stage down with a UNIQUE constraint failure, losing
    // the 49 entries that had parsed correctly. So: no stage-7 run may end in
    // `failed`, corpus-wide, and the reason is stated rather than left to be
    // rediscovered.
    const failedCtxRuns = db
      .prepare(
        `SELECT work_id, error FROM stage_run
          WHERE stage = 'citation-contexts' AND superseded = 0 AND status = 'failed'`
      )
      .all() as Array<{ work_id: number; error: string | null }>
    check(
      'no citation-contexts run failed anywhere in the corpus',
      failedCtxRuns.length === 0,
      failedCtxRuns.map((r) => `work ${r.work_id}: ${r.error}`).join('; ')
    )

    // Every stored context names exactly one target. The XOR is a DB CHECK, so
    // a violation cannot be stored — this asserts the CHECK is still ON the
    // table, which a future rebuild could silently drop.
    const xorBad = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM citation_context
            WHERE (edge_id IS NULL) = (unresolved_reference_id IS NULL)`
        )
        .get() as { c: number }
    ).c
    check('every citation_context names exactly one target', xorBad === 0, `${xorBad} violation(s)`)

    // The unresolved arm is the POINT of the nullable pair: most of this
    // corpus's references resolve to nothing, and their in-text evidence is
    // exactly as real. A run where only the resolved arm has rows would mean
    // the feature regressed to what it could store before the pair existed.
    const arms = db
      .prepare(
        `SELECT CASE WHEN edge_id IS NULL THEN 'unresolved' ELSE 'resolved' END AS target,
                COUNT(*) AS c
           FROM citation_context WHERE stage_run_id IS NOT NULL GROUP BY 1`
      )
      .all() as Array<{ target: string; c: number }>
    const unresolvedArm = arms.find((a) => a.target === 'unresolved')?.c ?? 0
    check(
      'contexts are stored for UNRESOLVED references too, not only resolved ones',
      unresolvedArm > 0,
      arms.map((a) => `${a.target}=${a.c}`).join(' ')
    )

    // Provenance completeness, read back from the rows rather than trusted from
    // the writer: a role whose origin is unstatable is the one thing
    // `role_source` exists to prevent.
    const unsourced = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM citation_context
            WHERE role IS NOT NULL AND role_source IS NULL`
        )
        .get() as { c: number }
    ).c
    check('no stored role lacks a stated origin', unsourced === 0, `${unsourced} row(s)`)

    const idsBefore = (
      db
        .prepare(
          'SELECT id FROM stage_run WHERE work_id = ? AND document_id = ? AND superseded = 0 ORDER BY id'
        )
        .all(realDoc.work_id, realDoc.id) as { id: number }[]
    ).map((r) => r.id)
    const requeue = (): void => {
      db.prepare(
        `UPDATE processing_job SET status = 'queued', outcome = NULL, attempts = 0,
                started_at = NULL, finished_at = NULL, stage_run_id = NULL
          WHERE id IN (${realJobs.map(() => '?').join(',')})`
      ).run(...realJobs)
    }

    requeue()
    realSched.start()
    await drain(realSched, realJobs, 180_000)
    realSched.stop()
    const idsAfterReplan = (
      db
        .prepare(
          'SELECT id FROM stage_run WHERE work_id = ? AND document_id = ? AND superseded = 0 ORDER BY id'
        )
        .all(realDoc.work_id, realDoc.id) as { id: number }[]
    ).map((r) => r.id)
    check(
      'every real-paper stage was a cache hit on the second pass',
      JSON.stringify(idsAfterReplan) === JSON.stringify(idsBefore),
      `${idsBefore.length} run(s)`
    )

    // Supersede on a real input change: touching the PDF's mtime changes
    // `download`'s fingerprint, which must cascade through every stage
    // downstream without any of them naming another.
    const { utimesSync } = await import('node:fs')
    const t = new Date(Date.now() + 5_000)
    utimesSync(realDoc.path, t, t)
    requeue()
    realSched.start()
    await drain(realSched, realJobs, 180_000)
    realSched.stop()
    const shippedIds = (ids: number[]): number[] =>
      ids.filter((id) => {
        const row = db.prepare('SELECT stage FROM stage_run WHERE id = ?').get(id) as
          | { stage: string }
          | undefined
        return row !== undefined && registry.byId(row.stage) !== undefined
      })
    const idsAfterTouch = (
      db
        .prepare(
          'SELECT id FROM stage_run WHERE work_id = ? AND document_id = ? AND superseded = 0 ORDER BY id'
        )
        .all(realDoc.work_id, realDoc.id) as { id: number }[]
    ).map((r) => r.id)
    const beforeShipped = shippedIds(idsBefore)
    check(
      'touching the PDF superseded every downstream run',
      shippedIds(idsAfterTouch).every((id) => !beforeShipped.includes(id)),
      `${shippedIds(idsAfterTouch).length} new shipped run(s)`
    )
    // The superseded inventory must be GONE, not merely marked: the cascade
    // UPDATEs `stage_run`, which fires no ON DELETE CASCADE, so a stale
    // inventory would survive with positional ids naming different text.
    const orphanParas = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM document_paragraph p
             JOIN stage_run r ON r.id = p.stage_run_id
            WHERE r.superseded = 1 AND p.document_id = ?`
        )
        .get(realDoc.id) as { c: number }
    ).c
    check('a superseded run left NO paragraph rows behind', orphanParas === 0, `${orphanParas} row(s)`)
    const orphanCtx = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM citation_context c
             JOIN stage_run r ON r.id = c.stage_run_id WHERE r.superseded = 1`
        )
        .get() as { c: number }
    ).c
    check('and NO citation_context rows behind', orphanCtx === 0, `${orphanCtx} row(s)`)
  }

  // ------------------------------------------------------- the scanned paper
  //
  // The corpus contains a REAL scan — a 1996 Nature paper whose pages carry no
  // text layer at all — and it is the only thing that proves `ocr` rather than
  // merely exercising it. Everything above runs against papers that have text,
  // where `ocr` correctly does nothing.
  section('a scanned paper, read by OCR')
  // The scan is found by the PROPERTY being tested — a PDF with no usable text
  // layer — by probing each candidate with the same extractor the pipeline
  // uses. Matching on a filename would tie this check to one corpus and, worse,
  // would silently skip on any other, and a check that skips is a check that is
  // not running.
  const candidates = db
    .prepare(
      `SELECT d.id, d.work_id, bd.abs_path || '/' || fl.relative_path AS path
         FROM document d
         JOIN file_location fl ON fl.document_id = d.id AND fl.role = 'canonical'
         JOIN base_dir bd ON bd.id = fl.base_dir_id
        WHERE d.id NOT IN (SELECT document_id FROM document_paragraph)
        ORDER BY d.id`
    )
    .all() as Array<{ id: number; work_id: number; path: string }>

  let scan: { id: number; work_id: number; path: string } | undefined
  for (const c of candidates) {
    if (!existsSync(c.path)) continue
    try {
      const probe = await extractPdfText(c.path)
      const chars = probe.pages.reduce((n, p) => n + p.text.trim().length, 0)
      if (chars < 40 * probe.pages.length) {
        scan = c
        break
      }
    } catch {
      /* unreadable here is not the scan we are looking for */
    }
  }

  if (!scan) {
    skip(
      'OCR scan',
      `no PDF without a text layer among ${candidates.length} candidate(s)`,
      'The OCR path needs a scanned paper to run against. Add one to the seeded corpus ' +
        '(any PDF whose pages carry under ~40 characters each) and re-run. ' +
        'Until then the OCR fallback and its text_source recording are UNTESTED by this gate.'
    )
  } else {
    console.log(`   ${scan.path.split('/').pop()}`)
    const scanSched = new Scheduler(db, provider, { concurrency: 1, idleMs: 20 })
    const scanJobs = scanSched.plan({ workId: scan.work_id, documentId: scan.id, projectId: 1 })
    scanSched.start()
    // OCR is ~12 s/page and this paper is 4 pages; the budget is generous
    // because a machine under load takes considerably longer than a idle one.
    await drain(scanSched, scanJobs, 600_000)
    scanSched.stop()

    const scanRuns = db
      .prepare(
        `SELECT stage, status, outcome_note FROM stage_run
          WHERE work_id = ? AND document_id = ? AND superseded = 0 ORDER BY id`
      )
      .all(scan.work_id, scan.id) as Array<{ stage: string; status: string; outcome_note: string | null }>
    for (const r of scanRuns) {
      console.log(`   ${r.stage.padEnd(19)} ${r.status.padEnd(10)} ${r.outcome_note ?? ''}`)
    }

    // `extract-text` must report `empty` — a real claim about the paper — and
    // NOT `failed`. This is the corpus's own instance of the distinction the
    // outcome union exists for.
    const extract = scanRuns.find((r) => r.stage === 'extract-text')
    check(
      'extract-text reports `empty` on a scan, not `failed`',
      extract?.status === 'empty',
      `${extract?.status} — ${extract?.outcome_note ?? ''}`
    )
    const ocrRun = scanRuns.find((r) => r.stage === 'ocr')
    check('ocr read the scan', ocrRun?.status === 'succeeded', ocrRun?.outcome_note ?? 'no run')

    // The whole point of the transformer shape: `segment` consumed OCR'd text
    // through the SAME token, without knowing `ocr` exists.
    const scanParas = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM document_paragraph p JOIN stage_run r ON r.id = p.stage_run_id
            WHERE p.document_id = ? AND r.superseded = 0`
        )
        .get(scan.id) as { c: number }
    ).c
    check('segment built an inventory from OCR text', scanParas > 20, `${scanParas} paragraph(s)`)

    // OCR-derived text is MARKED. `content_status` stays `fulltext` because it
    // IS the full text; the confidence is the separate axis, so a reader can
    // tell an OCR'd paper from a publisher's text layer.
    const scanDoc = db
      .prepare('SELECT content_status, text_source, text_confidence FROM document WHERE id = ?')
      .get(scan.id) as { content_status: string; text_source: string; text_confidence: number | null }
    check(
      'the document is badged as OCR-derived, with its confidence',
      scanDoc.text_source === 'ocr' && (scanDoc.text_confidence ?? 0) > 0,
      `${scanDoc.content_status} / ${scanDoc.text_source} / ${scanDoc.text_confidence?.toFixed(1) ?? '-'}%`
    )
    const textPaper = db
      .prepare(`SELECT text_source FROM document WHERE text_source = 'pdf-text-layer' LIMIT 1`)
      .get() as { text_source: string } | undefined
    check(
      'and a text-layer paper is distinguishable from it',
      textPaper !== undefined,
      textPaper?.text_source ?? 'none recorded'
    )
  }

  // -------------------------------------------------------------- embeddings
  section('embeddings are stored in a named space, and are searchable')
  const space = db
    .prepare(`SELECT id, dims, vec_table, config_hash, status FROM embedding_space`)
    .get() as { id: number; dims: number; vec_table: string; config_hash: string; status: string } | undefined

  if (!space) {
    skip(
      'embeddings',
      'no embedding_space row — no model is packaged in this build',
      'Package the embedding model (see src/main/embedding/model.ts for the path it resolves) ' +
        'and re-run. Until then chunking, the vector table and semantic search are UNTESTED, ' +
        'and a build that ships without a model would look identical to one that ships with a broken one.'
    )
  } else {
    check('exactly one space is active', space.status === 'active', `space ${space.id}`)
    const chunkCount = (db.prepare('SELECT COUNT(*) AS c FROM chunk').get() as { c: number }).c
    check('chunks were written', chunkCount > 0, `${chunkCount} chunk(s)`)

    // Every chunk names the space that produced it and carries its config hash,
    // so a stale vector is detectable with one comparison rather than by
    // wondering why search got worse.
    const mismatched = (
      db
        .prepare('SELECT COUNT(*) AS c FROM chunk WHERE space_id <> ? OR config_hash <> ?')
        .get(space.id, space.config_hash) as { c: number }
    ).c
    check('every chunk names the space and config that produced it', mismatched === 0, `${mismatched} stray`)

    // The vector is stored on the ROW as well as in the index, so search still
    // works where sqlite-vec cannot load — and so a vector cannot outlive its
    // chunk.
    const badWidth = (
      db
        .prepare('SELECT COUNT(*) AS c FROM chunk WHERE LENGTH(vector) <> ?')
        .get(space.dims * 4) as { c: number }
    ).c
    check('every stored vector has the space\'s dimensionality', badWidth === 0, `${badWidth} wrong-width`)

    // Not tolerated when it cannot be read: sqlite-vec is required on every
    // connection, so a `vec0` table this cannot count is a failure to report
    // and not a platform to excuse.
    const indexed = (db
      .prepare(`SELECT COUNT(*) AS c FROM ${space.vec_table}`)
      .get() as { c: number }).c
    check('the vec0 index holds one row per chunk', indexed === chunkCount, `${indexed}/${chunkCount}`)

    // A vector must never outlive its chunk: a space-correct k-NN would return
    // it, naming a chunk id that no longer exists, which is a confidently wrong
    // neighbour rather than an error.
    check('no vector outlives its chunk', sweepVectorOrphans(db) === 0)

    // A SPACE CHANGE supersedes every embed run through the ordinary cascade —
    // no special code path — and takes the vectors with it.
    const embedStage = registry.byId('embed')
    if (embedStage && chunkCount > 0) {
      const owner = db
        .prepare('SELECT work_id, document_id FROM chunk LIMIT 1')
        .get() as { work_id: number; document_id: number }
      supersedeCascade(
        db,
        registry,
        keyOf(
          embedStage.stage,
          { db, workId: owner.work_id, documentId: owner.document_id, projectId: 1 },
          null
        ),
        new Date().toISOString()
      )
      const leftChunks = (
        db.prepare('SELECT COUNT(*) AS c FROM chunk WHERE work_id = ?').get(owner.work_id) as { c: number }
      ).c
      check(
        'superseding an embed run took its chunks AND its vectors with it',
        leftChunks === 0 && sweepVectorOrphans(db) === 0,
        `${leftChunks} chunk(s) left`
      )
    }
  }

  // ---------------------------------------------------------------- integrity
  section('database integrity after everything')
  check('integrity_check', (db.pragma('integrity_check', { simple: true }) as string) === 'ok')
  check('foreign_key_check empty', (db.pragma('foreign_key_check') as unknown[]).length === 0)

  db.close()
  for (const s of ['', '-wal', '-shm']) rmSync(`${dbPath}${s}`, { force: true })
  rmSync(scratchDir, { recursive: true, force: true })
  if (skipped.length > 0) {
    console.log(`\n${'!'.repeat(62)}`)
    console.log(`${skipped.length} SECTION(S) DID NOT RUN — this run did NOT verify the pipeline`)
    for (const s of skipped) {
      console.log(`\n  ${s.section}\n    why:    ${s.why}\n    to fix: ${s.remedy}`)
    }
    console.log(`${'!'.repeat(62)}`)
  }
  if (failures > 0) {
    console.log(`\n${failures} CHECK(S) FAILED`)
  } else if (skipped.length > 0) {
    console.log('\nevery check that RAN passed — but see the skipped sections above')
  } else {
    console.log('\nALL PIPELINE CHECKS PASSED')
  }
  // 1 = something is broken. 2 = nothing is known to be broken and the sections
  // that would have told us never ran. Never 0 for the second: the whole defect
  // being fixed here is a green gate that exercised none of the real pipeline.
  process.exit(failures > 0 ? 1 : skipped.length > 0 ? 2 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
