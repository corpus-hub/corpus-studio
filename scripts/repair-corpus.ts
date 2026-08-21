// Bring papers the pipeline never finished up to date, through the app's own doors.
//
//   npm run repair:corpus
//
// This is `rerun-works.ts`'s sibling and shares its whole rationale: a real
// Electron main process, the same `selectProvider`, the same `HostPool`, the
// same `STAGES` registry, the same `Scheduler`, the same size-1 `LLM_GATE`.
// Nothing here writes an `analysis_run`, a `fact` or a `citation_context` by
// hand — a repair that hand-inserted its results would be indistinguishable
// from a fabrication.
//
// WHAT IT REPAIRS, and why neither existing script could:
//
//   1. A project paper with NO PIPELINE AT ALL. `rerun:works` re-runs a named
//      stage; a paper with no stage anywhere needs all of them, and the only
//      thing that produces "all of them" is `planForWork` — the same call the
//      startup sweep makes.
//
//   2. A job left `failed` or `cancelled` by a bug that has since been fixed.
//      The queue deliberately never re-arms those on its own: they are the
//      user's to retry, precisely so a paper that failed four times does not
//      turn into an endless retry loop. `scheduler.retry` is the button behind
//      that decision, and this calls it rather than reaching past it with SQL.
//
//   3. A stage whose stored answer was produced under inputs that have since
//      changed — a bumped stage version, an edited prompt. `staleWorks` is the
//      one authority on that and `forceRerunStages` is the one door, which is
//      the pair the Queue's own refresh button uses.
//
// All three are found by ASKING THE DATABASE, never by naming ids: an id list
// would be a snapshot of one machine's corpus and would silently repair nothing
// on anyone else's.

import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { initDatabase, type DB } from '../src/main/db/connection'
import { defaultDbPath } from '../src/main/db/paths'
import { CommunicatorLlmProvider, UnavailableLlmProvider } from '../src/main/llm/provider'
import { selectProvider } from '../src/main/llm/select'
import { LLM_GATE } from '../src/main/pipeline/gate/llmGate'
import { HostPool } from '../src/main/pipeline/host/pool'
import { findUnplannedProjectWorks } from '../src/main/pipeline/plan-missing'
import { Scheduler } from '../src/main/pipeline/scheduler'
import { STAGES } from '../src/main/pipeline/stages'
import { resolveRegistry } from '../src/main/pipeline/registry'
import { staleWorks } from '../src/main/pipeline/staleness'
import { VectorSearch } from '../src/main/search/vectorSearch'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const log = (s: string): void => {
  // eslint-disable-next-line no-console
  console.log(s)
}

export async function repairCorpus(argv: string[] = process.argv.slice(2)): Promise<void> {
  const dryRun = argv.includes('--dry-run')

  const dbPath = process.env.CORPUS_DB_PATH ?? defaultDbPath()
  if (!existsSync(dbPath)) throw new Error(`no database at ${dbPath}`)
  const db: DB = initDatabase(dbPath)
  log(`db: ${dbPath}`)

  // Refuse rather than half-run, for the same reason `rerun-works.ts` does:
  // discovering there is no model after the queue has already been re-armed
  // would leave every repaired job failing on a missing provider.
  const selection = await selectProvider({ mode: 'live' })
  const provider = selection.provider
  if (provider instanceof UnavailableLlmProvider) {
    throw new Error(`refusing to repair: ${provider.why}`)
  }
  log(`provider: ${provider.name} (${provider.model}) — ${selection.reason}`)

  const entryPath = join(process.cwd(), 'out', 'main', 'stageHost.js')
  if (!existsSync(entryPath)) {
    throw new Error(`host entry missing: ${entryPath} (run \`npm run build\`)`)
  }
  const runDir = join(dirname(dbPath), 'run')
  mkdirSync(runDir, { recursive: true })
  const hostPool = new HostPool({ entryPath, runDir, instanceId: randomUUID() })

  const registry = resolveRegistry(STAGES)
  const vectorSearch = new VectorSearch(dbPath)
  const sched = new Scheduler(db, provider, {
    concurrency: 2,
    idleMs: 50,
    hostPool,
    semantic: async (text, k, workIds) => {
      const res = await vectorSearch.query(text, k, workIds)
      return { blocks: res.hits, spaceId: res.spaceId, strategy: res.strategy }
    }
  })

  // A paper the user has EXCLUDED is out of scope for every repair below, not
  // just for planning. `findUnplannedProjectWorks` already honours that; a
  // failed job or a bumped stage version on the same paper is the same
  // decision seen from a different table, and re-arming it would spend the
  // user's tokens overruling them.
  const excluded = new Set(
    (
      db
        .prepare(`SELECT work_id FROM project_work WHERE inclusion_status = 'excluded'`)
        .all() as Array<{ work_id: number }>
    ).map((r) => r.work_id)
  )
  if (excluded.size > 0) log(`excluded by the user, left alone: ${[...excluded].join(', ')}`)

  // --- 1. papers with no pipeline ------------------------------------------
  const unplanned = findUnplannedProjectWorks(db)
  log(`\npapers with no pipeline: ${unplanned.length}`)
  for (const row of unplanned) {
    const title = (
      db.prepare('SELECT title FROM work WHERE id = ?').get(row.workId) as { title: string }
    ).title
    log(`  work ${row.workId} (project ${row.projectId}) — ${title.slice(0, 60)}`)
  }

  // --- 2. jobs a fixed bug left settled unhappily ---------------------------
  const broken = (db
    .prepare(
      `SELECT id, stage, work_id, status, attempts, error
         FROM processing_job
        WHERE status IN ('failed','cancelled') AND job_key IS NOT NULL
        ORDER BY work_id, id`
    )
    .all() as Array<{
    id: number
    stage: string | null
    work_id: number | null
    status: string
    attempts: number
    error: string | null
  }>).filter((j) => j.work_id == null || !excluded.has(j.work_id))
  log(`\njobs settled failed/cancelled: ${broken.length}`)
  for (const j of broken) {
    log(`  job ${j.id} ${j.stage} work ${j.work_id} ${j.status} (${j.attempts} attempts) — ${j.error ?? 'no error recorded'}`)
  }

  // --- 3. stages whose stored answer is out of date ------------------------
  //
  // Read BEFORE anything is armed. Planning work 1 changes what is stale for
  // work 1, and a set gathered afterwards would be a reading taken halfway
  // through a wave that has not landed.
  const projects = db.prepare('SELECT id FROM project ORDER BY id').all() as Array<{ id: number }>
  const stale: Array<{ workId: number; projectId: number; stageIds: string[]; labels: string[] }> = []
  for (const p of projects) {
    for (const [workId, detail] of staleWorks(db, registry, p.id)) {
      if (excluded.has(workId)) continue
      stale.push({ workId, projectId: p.id, stageIds: detail.stageIds, labels: detail.labels })
    }
  }
  log(`\npapers with an out-of-date stage: ${stale.length}`)
  for (const s of stale) log(`  work ${s.workId} (project ${s.projectId}) — ${s.labels.join(', ')}`)

  if (dryRun) {
    log('\n--dry-run: nothing was changed')
    hostPool.shutdown()
    return
  }

  LLM_GATE.resetStats()
  const t0 = Date.now()
  let planned = 0
  for (const row of unplanned) {
    const n = sched.planForWork(row.workId, row.projectId).length
    planned += n
    log(`  planned work ${row.workId} → ${n} job(s)`)
  }
  for (const j of broken) {
    sched.retry(j.id)
    planned += 1
    log(`  retried job ${j.id} (${j.stage}, work ${j.work_id})`)
  }
  for (const s of stale) {
    // A paper this run has only just planned from nothing is skipped: its whole
    // pipeline is already queued, and re-running a stage of it would retire a
    // run that does not exist yet.
    if (unplanned.some((u) => u.workId === s.workId && u.projectId === s.projectId)) continue
    const out = sched.forceRerunStages(s.workId, s.stageIds, s.projectId)
    planned += out.allJobIds.length
    log(
      `  re-ran work ${s.workId}: ${s.stageIds.join(', ')} → ` +
        `${out.supersededRunIds.length} run(s) retired, ${out.allJobIds.length} job(s)`
    )
  }
  log(`\narmed ${planned} job(s)`)

  sched.start()

  const budgetMs = Number(process.env.CORPUS_BUDGET_MS ?? 60 * 60 * 1000)
  const deadline = Date.now() + budgetMs
  let lastReport = 0
  while (Date.now() < deadline) {
    const live = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM processing_job WHERE status IN ('queued','running','blocked')`
        )
        .get() as { c: number }
    ).c
    if (live === 0 && sched.inFlightCount() === 0) break
    if (Date.now() - lastReport > 20_000) {
      lastReport = Date.now()
      const running = db
        .prepare(
          `SELECT stage, work_id FROM processing_job WHERE status = 'running' ORDER BY id`
        )
        .all() as Array<{ stage: string | null; work_id: number | null }>
      log(
        `  … ${live} live, gate peak ${LLM_GATE.peak()}` +
          (running.length > 0
            ? ` — running: ${running.map((r) => `${r.stage}(w${r.work_id})`).join(', ')}`
            : '')
      )
    }
    await sleep(250)
  }
  sched.stop()
  await sleep(300)
  try {
    hostPool.shutdown()
  } catch (err) {
    log(`host pool shutdown: ${(err as Error).message}`)
  }

  const outstanding = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM processing_job WHERE status IN ('queued','running','blocked')`
      )
      .get() as { c: number }
  ).c
  if (outstanding > 0) log(`\nINCOMPLETE: ${outstanding} job(s) outstanding — re-run to continue.`)

  log('\n=== where the corpus stands ===')
  log(`  wall clock            ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  log(`  gate peak in flight   ${LLM_GATE.peak()}`)
  if (provider instanceof CommunicatorLlmProvider) {
    log(`  LLM calls             ${provider.totals.calls}`)
    log(`  tokens                ${provider.totals.totalTokens}`)
  }
  for (const p of db.prepare('SELECT id FROM project ORDER BY id').all() as Array<{ id: number }>) {
    const remaining = [...staleWorks(db, registry, p.id)].filter(([workId]) => !excluded.has(workId))
    log(`  project ${p.id}: ${remaining.length} paper(s) with a stage that would re-run`)
    for (const [workId, detail] of remaining) log(`    work ${workId}: ${detail.labels.join(', ')}`)
  }
  const byStatus = db
    .prepare(
      `SELECT status, COUNT(*) AS c FROM processing_job GROUP BY status ORDER BY status`
    )
    .all() as Array<{ status: string; c: number }>
  log(`  jobs: ${byStatus.map((r) => `${r.status}=${r.c}`).join(' ')}`)
}

if (require.main === module) {
  repairCorpus().then(
    () => process.exit(0),
    (err) => {
      // eslint-disable-next-line no-console
      console.error(String((err as Error)?.message ?? err))
      process.exit(1)
    }
  )
}
