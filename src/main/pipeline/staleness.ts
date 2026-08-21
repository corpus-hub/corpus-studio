// Which papers would re-run if the pipeline were planned again right now.
//
// "Stale" is not a stored flag and must never become one: a flag written when
// an input changed is a second opinion that drifts from the cache the scheduler
// actually consults, and the two disagreeing is indistinguishable — from the
// user's side — from the refresh button doing nothing. So this asks the ONE
// authority, `computeFingerprint`, exactly the question `decideCache` asks at
// claim time, and reports the difference.

import type { DB } from '../db/connection'
import { computeFingerprint, keyOf } from './stageRun'
import type { ResolvedRegistry } from './registry'
import type { FanOutKey, StageDefinition, StagePlanContext } from './types'

/** Terminal outcomes `decideCache` is willing to serve from cache. */
const CACHEABLE = new Set(['succeeded', 'empty', 'skipped', 'refused'])

/**
 * Upstream outcomes that mean "the pipeline may proceed past this provider".
 *
 * `refused` is deliberately absent even though it IS cacheable: a refusal
 * cancels everything downstream of it on purpose, so the absence of a
 * downstream run there is the pipeline working, not work left undone.
 */
const SATISFYING = new Set(['succeeded', 'empty', 'skipped'])

/**
 * Job statuses that mean the queue is still the one speaking about this stage.
 *
 * `failed` and `cancelled` are shown in the Queue in their own words, and
 * adding "needs refresh" on top would put a second, softer name on a state the
 * user is already being told about in a harder one.
 *
 * `review` is NOT among them, and it used to be. It is a TERMINAL state — an
 * `empty` or `refused` the stage will never revisit on its own — and holding it
 * here made a paper in review permanently unrefreshable: staleness skipped the
 * stage, so no version bump and no prompt edit could ever reach it. That is not
 * hypothetical. `review-records` went 1.1.0 -> 1.2.0 precisely so a cached
 * "nothing outstanding" would reopen and settle as `not-needed` instead of
 * parking the paper; thirteen papers took the new version and the five actually
 * in review kept the old one, because those five were the only ones the bump
 * was written for. The queue does not own a stage it has stopped working on.
 */
const QUEUE_OWNS = new Set(['queued', 'blocked', 'running', 'failed', 'cancelled'])

/**
 * Memoize the `fingerprint()` hooks that take no arguments, FOR ONE SWEEP.
 *
 * A hook declaring zero parameters cannot vary by paper: `optimize` shells out
 * to `qpdf --version` and `embed` resolves the packaged embedding model, and
 * both answer the same thing for every work in the corpus. `decideCache` calls
 * each once, so paying for the probe there is right; a sweep calls them once
 * per paper and measured 941 ms in `embed` plus 237 ms in `optimize` across 20
 * papers — 88% of the whole scan, all of it recomputing one constant.
 *
 * Scoped to the CALL, never module-level: the whole point of a tool-identity
 * fingerprint is that installing qpdf must re-run what its absence cached, and
 * a process-lifetime cache would hold "absent" until the app was restarted.
 *
 * Hooks that DO take `(ctx, fan)` are called normally. Deciding by arity rather
 * than by a list of stage ids means a new stage is covered — or correctly not
 * covered — without anyone editing this file.
 */
function memoizeConstantHooks(registry: ResolvedRegistry): Map<string, StageDefinition> {
  const wrapped = new Map<string, StageDefinition>()
  for (const { stage } of registry.order) {
    const hook = stage.fingerprint
    if (!hook || hook.length > 0) {
      wrapped.set(stage.id, stage)
      continue
    }
    let memo: string | undefined
    wrapped.set(stage.id, {
      ...stage,
      fingerprint: (ctx, fan) => (memo ??= hook(ctx, fan))
    })
  }
  return wrapped
}

export interface StaleWork {
  work_id: number
  /** Labels of the stages that would re-run, in registry order, deduplicated. */
  stages: string[]
  /**
   * The same stages as IDS, so a refresh can re-run exactly what was named.
   *
   * Without this the Queue's refresh had no way to say which stages it meant,
   * so it called `reprocessWork(force)` — which discards EVERY current run of
   * the paper, from `retrieve` down. A prompt edit that invalidated one model
   * stage therefore re-fetched the PDF, re-OCR'd it, re-segmented it and re-ran
   * every other model stage on ten papers. The cascade from these ids reaches
   * everything genuinely downstream anyway, so nothing is left half-updated.
   */
  stage_ids: string[]
}

/** One work's staleness, in both the reader's terms and the scheduler's. */
export interface StaleDetail {
  /** For the UI. `schema-extract` is not a thing a scientist has a name for. */
  labels: string[]
  /**
   * For the re-run. Stage IDS, in registry order.
   *
   * The two lists are computed in the SAME pass on purpose. A refresh that
   * re-derived "which stages" separately from the count it showed could act on
   * a different set from the one the user was told about, and the whole reason
   * this exists is that the button used to act on far more than it named.
   */
  stageIds: string[]
}

/**
 * Every current stage run of one work, in one query.
 *
 * `computeFingerprint` re-queries per provider per capability, which is correct
 * and cheap for the single stage a claim is deciding about — but the queue asks
 * about every stage of every paper, so the same rows would be read hundreds of
 * times per screen load. Read once, indexed by the key the fingerprint uses.
 */
interface RunIndex {
  /** `stage|schemaId|fanoutKey` -> the current run for that exact key. */
  byKey: Map<string, { status: string; input_fingerprint: string }>
  /** stage id -> its current runs, whatever their fan-out. */
  byStage: Map<string, Array<{ status: string }>>
}

function indexRuns(db: DB, workId: number, projectId: number): RunIndex {
  const rows = db
    .prepare(
      `SELECT stage, project_id, schema_id, fanout_key, status, input_fingerprint
         FROM stage_run
        WHERE work_id = ? AND superseded = 0 AND project_id IN (0, ?)`
    )
    .all(workId, projectId) as Array<{
    stage: string
    project_id: number
    schema_id: number
    fanout_key: string
    status: string
    input_fingerprint: string
  }>
  const byKey = new Map<string, { status: string; input_fingerprint: string }>()
  const byStage = new Map<string, Array<{ status: string }>>()
  for (const r of rows) {
    byKey.set(`${r.stage}|${r.project_id}|${r.schema_id}|${r.fanout_key}`, {
      status: r.status,
      input_fingerprint: r.input_fingerprint
    })
    const list = byStage.get(r.stage) ?? []
    list.push({ status: r.status })
    byStage.set(r.stage, list)
  }
  return { byKey, byStage }
}

/**
 * The STAGES of this work's pipeline the queue is still responsible for.
 *
 * Stage ids, not fan-out slots. A fanned-out stage is one unit of work to the
 * user — `schema-extract` is "Extract", one label on one row — but it has one
 * job per attached schema, and those slots finish at different times. Keying
 * this by slot meant work 1 was reported "Needs invalidation · Extract" while
 * job 28920 (`enzyme-kinetics`) was RUNNING, because the sibling slot
 * (`protein-thermostability`) had already settled with an out-of-date
 * fingerprint. The label named a stage the queue was executing at that moment.
 *
 * Any live slot therefore silences the whole stage: the stage as a whole is
 * mid-flight, and whatever the settled siblings say about it is a reading taken
 * halfway through a wave that has not landed yet.
 */
function heldStages(db: DB, workId: number, projectId: number): Set<string> {
  const rows = db
    .prepare(
      `SELECT stage, status FROM processing_job
        WHERE work_id = ? AND project_id IN (0, ?) AND stage IS NOT NULL`
    )
    .all(workId, projectId) as Array<{ stage: string; status: string }>
  const held = new Set<string>()
  for (const r of rows) {
    if (!QUEUE_OWNS.has(r.status)) continue
    held.add(r.stage)
  }
  return held
}

/**
 * Would this stage have been able to run by now?
 *
 * A missing run is only evidence of staleness when everything the stage reads
 * already exists. Without this test every paper whose pipeline has not reached
 * the end yet reports as stale — the queue would announce "needs refresh" over
 * work it is at that moment performing.
 *
 * `requires` ONLY, never `inputsOf`, and this is the one place in the pipeline
 * where the two must not be conflated. An optional input's absence is a fact
 * about the paper the stage is meant to run and REPORT — a paywalled paper has
 * no file to crop tables out of, and it still has records that need auditing.
 * Asking for it here would delete that paper from the sweep, so its queue row
 * would show nothing pending: a review that never happens, presented exactly
 * like one that happened and found nothing wrong.
 */
function upstreamSatisfied(
  registry: ResolvedRegistry,
  index: number,
  requires: readonly string[],
  runs: RunIndex
): boolean {
  for (const cap of requires) {
    const chain = registry.providersFor(cap, index)
    const ok = chain.some((p) =>
      (runs.byStage.get(p.id) ?? []).some((r) => SATISFYING.has(r.status))
    )
    if (!ok) return false
  }
  return true
}

/**
 * Papers in `projectId` whose stored results were produced under inputs that
 * have since changed, and the LABELS of the stages that would re-run.
 *
 * Labels, never stage ids: this reaches the Queue screen, and `schema-extract`
 * is not a thing a scientist has a name for.
 *
 * Corpus-scoped stages are excluded. They are keyed to work 0 and are about the
 * library, not about any one paper, so attributing one to a row would put a
 * refresh button on a paper that cannot cause it to run.
 *
 * A paper with NO current runs at all is silent. It has not been processed, and
 * "its results were made under inputs that have since changed" is a statement
 * about results it does not have — that paper's state belongs to the queue's
 * pending rows, not to a staleness report.
 */
export function staleWorks(
  db: DB,
  registry: ResolvedRegistry,
  projectId: number
): Map<number, StaleDetail> {
  const works = db
    .prepare(
      `SELECT pw.work_id AS work_id,
              (SELECT d.id FROM document d
                WHERE d.work_id = pw.work_id
                ORDER BY d.is_preferred DESC, d.id LIMIT 1) AS document_id
         FROM project_work pw
        WHERE pw.project_id = ?
        ORDER BY pw.work_id`
    )
    .all(projectId) as Array<{ work_id: number; document_id: number | null }>

  const out = new Map<number, StaleDetail>()
  const memoized = memoizeConstantHooks(registry)

  for (const w of works) {
    const runs = indexRuns(db, w.work_id, projectId)
    if (runs.byKey.size === 0) continue
    const held = heldStages(db, w.work_id, projectId)

    const ctx: StagePlanContext = {
      db,
      workId: w.work_id,
      documentId: w.document_id ?? 0,
      projectId
    }
    const labels: string[] = []
    const stageIds: string[] = []

    for (const { stage: defined, index } of registry.order) {
      if (defined.scope === 'corpus') continue
      // The memoized copy, which carries the same id, scope and version — so
      // `keyOf` and `computeFingerprint`'s `registry.byId` resolve identically
      // and only the probe is skipped.
      const stage = memoized.get(defined.id) ?? defined

      // The SAME fan-out the planner uses, so a schema attached since the last
      // run produces a key here exactly as it would produce a job there. That
      // key has no run at all, which is the most common real staleness and the
      // one a per-run scan would miss entirely.
      // ALREADY BEING DEALT WITH — whether or not runs exist, and for EVERY
      // fan-out slot of this stage, not only the ones with a live job.
      //
      // This test used to guard only the missing-run branch, so a stage that
      // HAD a stale run and a queued job to replace it still reported stale.
      // The consequence was a button that counted work already scheduled:
      // pressing "20 papers" found 18 of them mid-refresh with nothing left to
      // supersede, and truthfully reported "2 redone; 18 already up to date" —
      // which reads as the button not working. The count also fell (20 → 11 →
      // 9) as the queue drained, so the label was a snapshot of a moving
      // number.
      //
      // A paper the queue is already fixing does not need the user to ask.
      if (held.has(stage.id)) continue

      // Nor does one the queue has a claim on but no job row for: a run left
      // `running` is a lease in flight, and the same argument applies to its
      // siblings — the wave has not landed, so no slot of it can be judged.
      if ((runs.byStage.get(stage.id) ?? []).some((r) => !CACHEABLE.has(r.status))) continue

      let fans: Array<FanOutKey | null> = [null]
      if (stage.fanOut) fans = stage.fanOut(ctx)

      let stale = false
      for (const fan of fans) {
        const key = keyOf(stage, ctx, fan)
        const run = runs.byKey.get(
          `${key.stage}|${key.projectId}|${key.schemaId}|${key.fanoutKey}`
        )

        if (run === undefined) {
          if (!upstreamSatisfied(registry, index, stage.requires, runs)) continue
          stale = true
          continue
        }
        if (run.input_fingerprint !== computeFingerprint(db, registry, stage, ctx, fan)) {
          stale = true
        }
      }
      if (stale) {
        labels.push(stage.label)
        stageIds.push(stage.id)
      }
    }

    if (labels.length > 0) {
      out.set(w.work_id, { labels: [...new Set(labels)], stageIds: [...new Set(stageIds)] })
    }
  }

  return out
}

/** The IPC shape: the same answer as a list, so it survives structured clone. */
export function staleWorkList(
  db: DB,
  registry: ResolvedRegistry,
  projectId: number
): StaleWork[] {
  return [...staleWorks(db, registry, projectId)].map(([work_id, d]) => ({
    work_id,
    stages: d.labels,
    stage_ids: d.stageIds
  }))
}
