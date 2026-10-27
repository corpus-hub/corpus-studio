// Re-run named works through the REAL pipeline, scoped to a few papers.
//
//   npm run rerun:works -- 11 12 13
//   npm run rerun:works -- 11 12 13 --stage schema-extract
//   npm run rerun:works -- 13 --schema 1
//   CORPUS_DB_PATH=… npm run rerun:works -- 5
//
// `process-corpus.ts` drives the WHOLE corpus and is the right tool for
// producing the shipped export. It is the wrong tool for repairing three
// papers: it plans every document, so recovering one bad extraction costs a
// full re-processing of the other nineteen — twenty minutes and ~160k tokens
// to redo work that was already correct, with a fresh chance to make it worse.
//
// So this narrows the SCOPE and changes nothing else. Same `selectProvider`
// in live mode, same `HostPool`, same `STAGES` registry, same `Scheduler`,
// same size-1 `LLM_GATE`. The re-run itself goes through `forceRerun`, which
// is the exact entry point the Paper screen's re-run control uses: it runs the
// supersede cascade, re-plans every project the cascade touched, and leaves
// the supersede-then-insert to `runPipeline`. Nothing here writes an
// `analysis_run`, a `fact` or a `measurement` by hand — a repair that
// hand-inserted its results would be indistinguishable from a fabrication.
//
// Runs are left `run_origin = 'local'`, because this machine computed them.

import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { initDatabase, type DB } from '../src/main/db/connection'
import { setTokenLedgerDb } from '../src/main/llm/tokenLedger'
import { setDevLogEnabled } from '../src/main/devlog'
import { getSetting } from '../src/main/db/repositories'
import { defaultDbPath } from '../src/main/db/paths'
import { CommunicatorLlmProvider, UnavailableLlmProvider } from '../src/main/llm/provider'
import { selectProvider } from '../src/main/llm/select'
import { LLM_GATE } from '../src/main/pipeline/gate/llmGate'
import { HostPool } from '../src/main/pipeline/host/pool'
import { Scheduler } from '../src/main/pipeline/scheduler'
import { STAGES } from '../src/main/pipeline/stages'
import { resolveRegistry } from '../src/main/pipeline/registry'
import { VectorSearch } from '../src/main/search/vectorSearch'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const log = (s: string): void => {
  // eslint-disable-next-line no-console
  console.log(s)
}

interface StageRow {
  id: number
  stage: string
  work_id: number
  schema_id: number
  status: string
}

export async function rerunWorks(argv: string[] = process.argv.slice(2)): Promise<void> {
  const stageIdx = argv.indexOf('--stage')
  const stageId = stageIdx >= 0 ? argv[stageIdx + 1] : 'schema-extract'
  // Narrowing to ONE schema matters when a paper extracted well under one
  // schema and badly under another: re-running the pair would put the good
  // result back through the model for a fresh chance to come back worse.
  const schemaIdx = argv.indexOf('--schema')
  const schemaFilter = schemaIdx >= 0 ? Number(argv[schemaIdx + 1]) : null
  const flagValues = new Set([stageIdx, schemaIdx].filter((i) => i >= 0).map((i) => i + 1))
  const workIds = argv
    .filter((a, i) => /^\d+$/.test(a) && !flagValues.has(i))
    .map(Number)
    .filter((n, i, xs) => xs.indexOf(n) === i)
  if (workIds.length === 0) {
    throw new Error('name at least one work id, e.g. `npm run rerun:works -- 11 12 13`')
  }

  const dbPath = process.env.CORPUS_DB_PATH ?? defaultDbPath()
  if (!existsSync(dbPath)) throw new Error(`no database at ${dbPath}`)
  const db: DB = initDatabase(dbPath)
  // WHAT THIS RUN COST, recorded against the paper and stage that spent it.
  //
  // The ledger holds its own handle and is set in `src/main/index.ts` for the
  // app — so every token this CLI spent went unrecorded, which is most of the
  // corpus. A run here is exactly when the question is asked: it is the one
  // that processes twenty papers at once.
  //
  // Attribution is gated on the developer log (see `tokenLedger.ts`), so a row
  // is only written when the log is armed; without that the columns naming the
  // paper and stage would all be null, which is worse than no row.
  //
  // THE STORED SETTING COUNTS HERE TOO. `CORPUS_DEV_LOG=1` arms it at import,
  // but the app ALSO honours `dev_log_enabled` from the database, and a user who
  // turned recording on in Settings has asked for it everywhere — not only in
  // the window. Reading it only from the environment meant every terminal run
  // wrote nothing while the setting said `1`: a whole evening of work was
  // missing from Analytics, and the gap read as a broken ledger rather than an
  // unset variable.
  setTokenLedgerDb(db)
  if (process.env.CORPUS_DEV_LOG !== '1' && getSetting(db, 'dev_log_enabled') === '1') {
    setDevLogEnabled(true)
  }
  log(`db: ${dbPath}`)

  // Refuse rather than half-run, for the same reason `process-corpus.ts` does:
  // discovering there is no model after the cascade has already retired the
  // old analyses would leave the paper with nothing where it had something.
  const selection = await selectProvider({ mode: 'live' })
  const provider = selection.provider
  if (provider instanceof UnavailableLlmProvider) {
    throw new Error(`refusing to re-run: ${provider.why}`)
  }
  log(`provider: ${provider.name} (${provider.model}) — ${selection.reason}`)

  const entryPath = join(process.cwd(), 'out', 'main', 'stageHost.js')
  if (!existsSync(entryPath)) {
    throw new Error(`host entry missing: ${entryPath} (run \`npm run build\`)`)
  }
  const runDir = join(dirname(dbPath), 'run')
  mkdirSync(runDir, { recursive: true })
  const hostPool = new HostPool({ entryPath, runDir, instanceId: randomUUID() })

  resolveRegistry(STAGES)
  // WITHOUT this, `verify-citations` refuses with "semantic search is not
  // available in this build" — the exact misdiagnosis `process-corpus.ts`
  // documents, on a machine where search works perfectly. This script is how a
  // verification is repaired for a few papers, so it must be able to run the
  // one stage that needs the cited side.
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

  const holes = workIds.map(() => '?').join(',')
  const targets = (
    db
      .prepare(
        `SELECT id, stage, work_id, schema_id, status
           FROM stage_run
          WHERE stage = ? AND superseded = 0 AND work_id IN (${holes})
          ORDER BY work_id, schema_id`
      )
      .all(stageId, ...workIds) as StageRow[]
  ).filter((t) => schemaFilter == null || t.schema_id === schemaFilter)

  // A corpus sweep whose run was already retired has no CURRENT row to name,
  // and refusing there is wrong: the sweep is exactly the thing that still
  // needs running. Work 0 asks for the sweep itself, so it is a valid target
  // whether or not a run survives to point at.
  const corpusSweep = workIds.includes(0) && STAGES.some((s) => s.id === stageId && s.scope === 'corpus')

  // A stage that has NEVER RUN on these papers has no current row to name, and
  // refusing there is the failure this branch exists to end. A stage added after
  // a corpus was processed is in exactly that state for every paper in it: there
  // is nothing to re-run, only something to run for the first time. The old
  // refusal made a new stage unreachable through the one supported entry point,
  // and `review-records` sat at zero verdicts across the whole corpus because of
  // it — the check it replaced had been deleted and nothing ever wrote the
  // answer that was meant to take its place.
  //
  // Planning is the SAME door the app uses. `plan()` is idempotent and inserts
  // only the jobs whose keys are not already held, so a paper that has run every
  // other stage gets exactly the one job it is missing.
  // A FAILED JOB IS NOT A MISSING ONE. `plan()` inserts only jobs whose key is
  // not already held, and a job that exhausted its attempts still holds its key
  // — so a stage whose last attempt failed planned nothing, forced nothing, and
  // reported "0 job(s)" as though there were no work to do. That is exactly the
  // state a re-run is for: the previous try is why you are here. Retried
  // through the scheduler's own path, which resets the attempt budget the same
  // way the user's Retry button does.
  const stuck = db
    .prepare(
      `SELECT id FROM processing_job
        WHERE stage = ? AND work_id IN (${holes})
          AND status IN ('failed', 'cancelled')`
    )
    .all(stageId, ...workIds) as Array<{ id: number }>
  for (const j of stuck) {
    sched.retry(j.id)
    log(`  retried failed job ${j.id} (${stageId})`)
  }

  const firstRun = !corpusSweep && targets.length === 0 && STAGES.some((s) => s.id === stageId)
  if (targets.length === 0 && !corpusSweep && !firstRun) {
    throw new Error(`no current \`${stageId}\` stage_run for work(s) ${workIds.join(', ')}`)
  }

  LLM_GATE.resetStats()
  const t0 = Date.now()
  let planned = 0
  for (const t of targets) {
    const n = sched.forceRerun(t.id)
    planned += n
    log(`  forceRerun stage_run ${t.id} (work ${t.work_id} schema ${t.schema_id}, was ${t.status}) → ${n} job(s)`)
  }

  // A CORPUS-scoped stage is keyed to work 0 and has no per-work job to plan,
  // so `forceRerun` retires its run and enqueues nothing — the script reported
  // "0 job(s)" and exited having undone the answer without redoing it. Corpus
  // sweeps are armed by `plan()`, which re-arms a settled sweep job, so a
  // documented target is asked for through the same door the app uses.
  // A stage that has not run on these papers is planned per paper, through the
  // ordinary project pipeline, so it is filed under the same (work, document,
  // project) key the app would use.
  if (firstRun) {
    for (const workId of workIds) {
      const doc = db
        .prepare('SELECT id FROM document WHERE work_id = ? ORDER BY id LIMIT 1')
        .get(workId) as { id: number } | undefined
      if (doc === undefined) {
        log(`  work ${workId} has no document; nothing to plan`)
        continue
      }
      const projects = db
        .prepare('SELECT project_id FROM project_work WHERE work_id = ?')
        .all(workId) as Array<{ project_id: number }>
      for (const p of projects) {
        if (p.project_id <= 0) continue
        // NARROWED to the named stage. A full plan re-arms every settled job of
        // the pipeline, and those re-run their models: asking for one missing
        // stage over 20 papers re-extracted the whole corpus and superseded 40
        // analyses that were correct.
        const n = sched.plan({
          workId,
          documentId: doc.id,
          projectId: p.project_id,
          onlyStages: [stageId]
        }).length
        planned += n
        log(`  plan work ${workId} project ${p.project_id} → ${n} job(s)`)
      }
    }
  }

  if (corpusSweep || targets.some((t) => t.work_id === 0)) {
    const anyWork = db.prepare('SELECT MIN(id) AS id FROM work').get() as { id: number | null }
    const anyProject = db.prepare('SELECT MIN(id) AS id FROM project').get() as { id: number | null }
    const anyDoc = db
      .prepare('SELECT id FROM document WHERE work_id = ? ORDER BY id LIMIT 1')
      .get(anyWork.id) as { id: number } | undefined
    if (anyWork.id != null && anyProject.id != null && anyDoc) {
      const armed = sched.plan({
        workId: anyWork.id,
        documentId: anyDoc.id,
        projectId: anyProject.id
      }).length
      planned += armed
      log(`  re-armed corpus sweep(s) → ${armed} job(s)`)
    }
  }
  log(`planned ${planned} job(s) over ${targets.length} stage run(s)`)

  sched.start()

  // PER WORK, not for the whole invocation.
  //
  // A flat total is the wrong shape for a run whose length is set by how many
  // papers were asked for: thirty minutes is generous for one paper and stops a
  // twenty-paper corpus a quarter of the way through, which it did — the run
  // ended mid-corpus with fourteen papers untouched and nothing saying why. The
  // budget now scales with the work asked of it, so the ceiling stays a
  // safeguard against a wedged queue rather than a limit on corpus size.
  const perWorkMs = Number(process.env.CORPUS_BUDGET_MS ?? 60 * 60 * 1000)
  const budgetMs = perWorkMs * Math.max(1, workIds.length)
  const deadline = Date.now() + budgetMs
  log(
    `budget ${Math.round(perWorkMs / 60000)} min per work × ${workIds.length} = ` +
      `${Math.round(budgetMs / 60000)} min`
  )
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
      log(`  … ${live} live, gate peak ${LLM_GATE.peak()}`)
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

  log('\n=== what the model produced ===')
  log(`  wall clock            ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  log(`  gate peak in flight   ${LLM_GATE.peak()}`)
  if (provider instanceof CommunicatorLlmProvider) {
    log(`  LLM calls             ${provider.totals.calls}`)
    // FOUR COUNTS, NEVER THEIR SUM.
    //
    // The gateway passes Anthropic's counts through unchanged and they are
    // disjoint: `prompt_tokens` is input that was PROCESSED, the cache halves
    // are input written to or served from the cache. Adding them is arithmetic
    // about how much context moved, and it reads as a bill — one review of one
    // paper summed to 2.2M and was reported as its cost, when a probe of the
    // same shape showed 20 turns costing 40 tokens of fresh input against
    // 301,746 re-read from cache. Nothing was reprocessed; the headline was
    // three orders of magnitude out.
    //
    // Fresh input and output are what a request actually works on. The cache
    // halves say how large the prefix was and how often it was reused, which is
    // a different question and gets its own line.
    log(`  fresh input           ${provider.totals.promptTokens}`)
    log(`  output                ${provider.totals.completionTokens}`)
    log(`  cache written         ${provider.totals.cacheCreationTokens}`)
    log(`  cache read            ${provider.totals.cacheReadTokens}`)
  }
  for (const w of workIds) {
    const rows = db
      .prepare(
        `SELECT r.id, r.schema_id, r.verifier_result, r.run_origin,
                (SELECT COUNT(*) FROM fact f WHERE f.analysis_run_id = r.id) AS facts,
                (SELECT COUNT(*) FROM measurement m JOIN fact f ON f.id = m.fact_id
                  WHERE f.analysis_run_id = r.id) AS meas,
                (SELECT COUNT(*) FROM evidence_span e WHERE e.analysis_run_id = r.id) AS spans
           FROM analysis_run r
          WHERE r.work_id = ? AND r.superseded = 0
          ORDER BY r.schema_id`
      )
      .all(w) as Array<Record<string, number | string>>
    for (const r of rows) {
      log(
        `  work ${w} schema ${r.schema_id}: run ${r.id} ${r.verifier_result} ` +
          `(${r.run_origin}) facts=${r.facts} meas=${r.meas} spans=${r.spans}`
      )
    }
  }
}

if (require.main === module) {
  rerunWorks().then(
    () => process.exit(0),
    (err) => {
      // eslint-disable-next-line no-console
      console.error(String((err as Error)?.message ?? err))
      process.exit(1)
    }
  )
}
