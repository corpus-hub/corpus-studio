// Drive the WHOLE seeded corpus through the REAL scheduler and the REAL
// utilityProcess host pool, then report a per-stage outcome table.
//
//   ELECTRON_RUN_AS_NODE=1 electron --import tsx scripts/verify-corpus.ts
//
// This is not a bespoke execution path: it constructs the same `Scheduler` +
// `HostPool` that `src/main/index.ts` constructs, plans every document with the
// same `plan()` the ingest handler uses, and lets the scheduler decide order,
// concurrency, leases and dependencies. The only thing it adds is measurement.

import { existsSync, mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDatabaseReadOnly, type DB } from '../src/main/db/connection'
import { seed } from '../src/main/db/seed'
import { CommunicatorLlmProvider } from '../src/main/llm/provider'
import { selectProvider } from '../src/main/llm/select'
import { LLM_GATE } from '../src/main/pipeline/gate/llmGate'
import { HostPool } from '../src/main/pipeline/host/pool'
import { resolveRegistry } from '../src/main/pipeline/registry'
import { Scheduler } from '../src/main/pipeline/scheduler'
import { STAGES } from '../src/main/pipeline/stages'

const OUT_DIR = join(process.cwd(), 'tmp', 'prod-verify')
mkdirSync(OUT_DIR, { recursive: true })

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function log(line: string): void {
  // eslint-disable-next-line no-console
  console.log(line)
}

export async function run(): Promise<void> {
  const dbPath =
    process.env.CORPUS_DB_PATH ?? join(OUT_DIR, 'corpus-run.sqlite')
  for (const s of ['', '-wal', '-shm']) rmSync(`${dbPath}${s}`, { force: true })
  rmSync(join(dirname(dbPath), 'run'), { recursive: true, force: true })

  const db: DB = openDatabaseReadOnly(dbPath)
  seed(db)

  const registry = resolveRegistry(STAGES)
  log(`registry order: ${registry.order.map((r) => r.stage.id).join(' -> ')}`)

  const entryPath = join(process.cwd(), 'out', 'main', 'stageHost.js')
  if (!existsSync(entryPath)) throw new Error(`host entry missing: ${entryPath} (run npm run build)`)

  const hostPool = new HostPool({
    entryPath,
    runDir: join(dirname(dbPath), 'run'),
    instanceId: randomUUID()
  })

  // The SAME selection the app makes. The serialisation guarantee has to be
  // measured against a provider that actually takes time over the network —
  // demonstrating peak 1 against one that answers in the same tick is the
  // easiest possible case for it and proves close to nothing.
  //
  // `CORPUS_LLM_MODE=live` refuses to start without a gateway; the default
  // `auto` proceeds and lets the LLM stages report that none was reachable.
  const selection = await selectProvider()
  const provider = selection.provider
  log(`LLM provider: ${provider.name} (${provider.model}) — ${selection.reason}`)
  const sched = new Scheduler(db, provider, { concurrency: 2, idleMs: 50, hostPool })

  // ------------------------------------------------------------- plan all
  const docs = db
    .prepare('SELECT id, work_id FROM document ORDER BY work_id')
    .all() as Array<{ id: number; work_id: number }>
  log(`documents in corpus: ${docs.length}`)

  let planned = 0
  const t0 = Date.now()
  for (const d of docs) {
    planned += sched.plan({ workId: d.work_id, documentId: d.id, projectId: 1 }).length
  }
  log(`planned ${planned} job(s) across ${docs.length} document(s)`)

  // ------------------------------------------------------- sample the gate
  LLM_GATE.resetStats()
  let peakSeen = 0
  const gateSamples: number[] = []
  const gateTimer = setInterval(() => {
    const p = LLM_GATE.peak()
    if (p > peakSeen) peakSeen = p
    gateSamples.push(p)
  }, 25)

  // memory + process sampling
  const rssSamples: number[] = []
  const memTimer = setInterval(() => {
    rssSamples.push(process.memoryUsage().rss)
  }, 1000)

  sched.start()

  const budgetMs = Number(process.env.CORPUS_BUDGET_MS ?? 45 * 60 * 1000)
  const deadline = Date.now() + budgetMs
  let lastReport = 0
  while (Date.now() < deadline) {
    const live = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM processing_job
            WHERE status IN ('queued','running','blocked')`
        )
        .get() as { c: number }
    ).c
    if (live === 0 && sched.inFlightCount() === 0) break
    if (Date.now() - lastReport > 15_000) {
      lastReport = Date.now()
      const done = (
        db.prepare(`SELECT COUNT(*) AS c FROM processing_job WHERE status='done'`).get() as {
          c: number
        }
      ).c
      log(`  … ${done} done, ${live} live, gate peak ${LLM_GATE.peak()}, waiting ${LLM_GATE.waiting()}`)
    }
    await sleep(200)
  }
  const wall = Date.now() - t0
  clearInterval(gateTimer)
  clearInterval(memTimer)
  sched.stop()
  await sleep(300)
  hostPool.shutdown()

  // ------------------------------------------------------------- report
  const jobRows = db
    .prepare(
      `SELECT stage, status, COUNT(*) AS c FROM processing_job
        GROUP BY stage, status ORDER BY stage, status`
    )
    .all() as Array<{ stage: string; status: string; c: number }>

  const runRows = db
    .prepare(
      `SELECT stage, status, COUNT(*) AS n,
              SUM(duration_ms) AS total_ms, MAX(duration_ms) AS max_ms
         FROM stage_run WHERE superseded = 0
        GROUP BY stage, status ORDER BY stage, status`
    )
    .all() as Array<{
    stage: string
    status: string
    n: number
    total_ms: number | null
    max_ms: number | null
  }>

  const notes = db
    .prepare(
      `SELECT stage, work_id, status, outcome_note FROM stage_run
        WHERE superseded = 0 AND status NOT IN ('succeeded')
        ORDER BY stage, work_id`
    )
    .all() as Array<{ stage: string; work_id: number; status: string; outcome_note: string | null }>

  const failedJobs = db
    .prepare(
      `SELECT id, stage, work_id, status, attempts, error_kind, error FROM processing_job
        WHERE status IN ('failed','review','cancelled') ORDER BY stage, work_id`
    )
    .all() as Array<Record<string, unknown>>

  const counts = (sql: string): number =>
    (db.prepare(sql).get() as { c: number } | undefined)?.c ?? -1

  const summary = {
    wallClockMs: wall,
    documents: docs.length,
    plannedJobs: planned,
    gate: {
      peakInFlight: LLM_GATE.peak(),
      peakSampled: peakSeen,
      samples: gateSamples.length
    },
    // What the batch actually cost. Zero calls against the real provider is a
    // RESULT, not an absence: it means every stage that should have reached a
    // model was served from cache or declined, which is worth seeing.
    llm: {
      provider: provider.name,
      model: provider.model,
      live: selection.live,
      reason: selection.reason,
      usage: provider instanceof CommunicatorLlmProvider ? provider.totals : null
    },
    rss: {
      maxMb: Math.round(Math.max(...rssSamples, 0) / 1e6),
      finalMb: Math.round(process.memoryUsage().rss / 1e6)
    },
    dbSizeMb: Number((statSync(dbPath).size / 1e6).toFixed(2)),
    jobsByStageStatus: jobRows,
    stageRuns: runRows,
    nonSuccessNotes: notes,
    failedJobs,
    tallies: {
      stage_run: counts('SELECT COUNT(*) AS c FROM stage_run'),
      stage_artifact: counts('SELECT COUNT(*) AS c FROM stage_artifact'),
      job_dependency: counts('SELECT COUNT(*) AS c FROM job_dependency'),
      document_paragraph: counts('SELECT COUNT(*) AS c FROM document_paragraph'),
      chunk: counts('SELECT COUNT(*) AS c FROM chunk'),
      unresolved_reference: counts('SELECT COUNT(*) AS c FROM unresolved_reference'),
      citation_edge: counts('SELECT COUNT(*) AS c FROM citation_edge'),
      citation_context: counts('SELECT COUNT(*) AS c FROM citation_context'),
      analysis_run: counts('SELECT COUNT(*) AS c FROM analysis_run'),
      evidence_span: counts('SELECT COUNT(*) AS c FROM evidence_span'),
      fact: counts('SELECT COUNT(*) AS c FROM fact')
    }
  }

  writeFileSync(join(OUT_DIR, 'corpus-run.json'), JSON.stringify(summary, null, 2))

  log('\n=== stage_run (current) ===')
  for (const r of runRows) {
    log(
      `  ${r.stage.padEnd(20)} ${r.status.padEnd(10)} n=${String(r.n).padStart(3)}  total=${r.total_ms ?? 0}ms  max=${r.max_ms ?? 0}ms`
    )
  }
  log('\n=== jobs by stage/status ===')
  for (const r of jobRows) log(`  ${r.stage.padEnd(20)} ${r.status.padEnd(10)} ${r.c}`)
  log('\n=== non-success stage_runs ===')
  for (const n of notes) log(`  ${n.stage} w${n.work_id} ${n.status}: ${n.outcome_note ?? ''}`)
  log('\n=== tallies ===')
  for (const [k, v] of Object.entries(summary.tallies)) log(`  ${k}: ${v}`)
  log(`\nwall=${(wall / 1000).toFixed(1)}s  gatePeak=${LLM_GATE.peak()}  rssMax=${summary.rss.maxMb}MB  db=${summary.dbSizeMb}MB`)
  log(`\nwrote ${join(OUT_DIR, 'corpus-run.json')}`)
}

// Only self-start when invoked directly. When a real Electron main process
// requires this module (tmp/prod-verify/corpus-main.js) it calls `run()` itself,
// after `app.whenReady()` — `utilityProcess` does not exist before then.
if (require.main === module) {
  run().then(
    () => process.exit(0),
    (err) => {
      // eslint-disable-next-line no-console
      console.error(err)
      process.exit(1)
    }
  )
}
