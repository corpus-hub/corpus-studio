// Plan a pipeline: turn the stage registry into processing_job rows plus their
// dependency edges, in ONE transaction.

import type { DB } from '../db/connection'
import { logRearm } from './rearmLog'
import type { ResolvedRegistry } from './registry'
import type { FanOutKey, StagePlanContext } from './types'

/**
 * Legacy `job_type` values kept for the stages that have one.
 *
 * The Queue screen still orders by `job_type`, so the familiar names keep
 * sorting correctly while new stages sort last — degraded, not broken. When the
 * renderer reads `stage` instead, this map goes.
 */
const LEGACY_JOB_TYPE: Record<string, string> = {
  download: 'ingest',
  references: 'citation-parse',
  'schema-extract': 'extraction',
  'resolve-references': 'retrieval'
}

/**
 * Enqueue every corpus-scoped stage as a SINGLETON.
 *
 * Separate from `planPipeline` because these jobs have no subject: a sweep is
 * about the corpus, not about a paper, so planning one per work would enqueue
 * one re-match of everything per ingested paper. `job_key` carries no pipeline
 * id for the same reason, and `ux_processing_job_live` then guarantees at most
 * one live instance — the insert is a no-op while one is queued or running.
 *
 * General over `scope === 'corpus'` rather than named per stage, so adding a
 * second sweep later is still one file plus one line.
 */
export function planCorpusSweeps(db: DB, registry: ResolvedRegistry, now: string): number[] {
  return db.transaction((): number[] => {
    const ids: number[] = []
    // A sweep is a pass over the corpus, and there is no pass to make over an
    // empty one. Enqueuing it anyway meant a user who had just created their
    // first project opened the queue to a green "Completed · Resolve references
    // · whole corpus" for work they never asked for and no paper to have done
    // it to — a report of activity in a library with nothing in it.
    const corpus = db.prepare('SELECT COUNT(*) AS c FROM work').get() as { c: number }
    if (corpus.c === 0) return ids
    const insert = db.prepare(
      `INSERT INTO processing_job
         (job_type, stage, status, work_id, document_id, project_id, schema_id,
          fanout_key, pipeline_id, job_key, priority, attempts, created_at, updated_at)
       VALUES (?, ?, 'queued', NULL, NULL, 0, 0, '', 'sweep', ?, ?, 0, ?, ?)
       ON CONFLICT(job_key)
         WHERE job_key IS NOT NULL
           AND status NOT IN ('done','failed','cancelled','review')
         DO NOTHING`
    )
    // Same look-before-insert as the per-paper planner, and for the same
    // reason: the unique index exempts terminal rows, so a key held by a
    // finished sweep does not conflict and each wake minted another. This
    // corpus had 319 rows for sweep:resolve-references, which needs exactly one.
    // NEWEST row per key. Databases written before this fix hold many rows for
    // one sweep key, and re-arming an arbitrary one of them would make a second
    // row live and violate `ux_processing_job_live`. The newest is the one that
    // reflects the corpus as it last stood.
    const findSweep = db.prepare(
      `SELECT id, status, outcome FROM processing_job WHERE job_key = ? ORDER BY id DESC LIMIT 1`
    )
    const rearmSweep = db.prepare(
      `UPDATE processing_job
          SET status = 'queued', attempts = 0, error = NULL, error_kind = NULL,
              lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ?`
    )
    for (const { stage } of registry.order) {
      if (stage.scope !== 'corpus') continue
      const held = findSweep.get(`sweep:${stage.id}`) as
        | { id: number; status: string }
        | undefined
      if (held) {
        // A sweep is woken when the corpus changed, so re-arming it is the
        // point — but only from a settled state, never from a live one.
        if (held.status === 'done' || held.status === 'review') {
          const info = rearmSweep.run(now, held.id)
          logRearm('plan:sweep', info.changes, {
            stage: stage.id,
            jobId: held.id,
            why: `was=${held.status}`
          })
          ids.push(held.id)
        }
        continue
      }
      const info = insert.run(
        LEGACY_JOB_TYPE[stage.id] ?? stage.id,
        stage.id,
        `sweep:${stage.id}`,
        // Behind per-paper work: a sweep that pre-empted the parse whose output
        // it exists to consume would run against the corpus as it was.
        200,
        now,
        now
      )
      if (info.changes > 0) ids.push(Number(info.lastInsertRowid))
    }
    return ids
  }).immediate()
}

export interface PlanInput {
  workId: number
  documentId: number
  /** 0 = global. */
  projectId: number
  priority?: number
  /**
   * Plan ONLY these stages, leaving every other stage of this pipeline alone.
   *
   * For the one case a full plan cannot serve: a stage that was ADDED after a
   * corpus was already processed has no job and no run anywhere, so the only way
   * to reach it is to plan it — but a full plan also re-arms every settled job
   * beside it, and those re-run their models and supersede analyses that were
   * correct. Asking for one paper's missing stage cost a re-extraction of the
   * whole corpus exactly once, which is what this exists to prevent.
   *
   * The stages left out are NOT skipped, cancelled or marked absent: their jobs
   * simply are not touched, so whatever the queue already says about them
   * remains true. Dependency edges are built only among the stages planned, and
   * that is correct here — an unplanned upstream has already run, and its output
   * is read from its stored artifact rather than from a job.
   */
  onlyStages?: readonly string[]
}

/**
 * The stages a paper needs to be USABLE, and no more.
 *
 * Fetch the bytes, make the text readable, index it. That is everything the
 * setup questionnaire shows and everything the project-context build reads —
 * it takes each paper's paragraph inventory, which `segment` is what produces.
 *
 * WHAT IS LEFT OUT is every stage that calls a model or reads the whole corpus:
 * summaries, extraction, the review queue, citation work. Measured on this
 * corpus, `schema-extract` averages 79 seconds and once took 17 minutes, and
 * `review-records` 53 — against roughly ten seconds for the four below. A user
 * adding their starting papers waits at a form watching each row, and making
 * them wait for analyses the form never shows is the difference between an
 * import that feels instant and one that looks hung.
 *
 * `ocr` is IN, though it is the expensive one here: a scanned paper has no text
 * layer at all, so without it the project context would be built from nothing
 * for exactly the papers that most need reading.
 */
export const ONBOARDING_STAGES: readonly string[] = [
  'retrieve',
  'download',
  'optimize',
  'extract-text',
  'ocr',
  'segment',
  'embed'
]

/**
 * `ONBOARDING_STAGES` while this project is still being set up, otherwise
 * undefined — which plans everything, exactly as before.
 *
 * Asked of the PROJECT rather than passed in by callers: six call sites reach
 * `planForWork`, and a flag threaded through all of them is a flag one of them
 * eventually forgets. The project row already knows whether its questionnaire
 * is unfinished, and that is precisely the condition.
 *
 * `project_id = 0` is the global sentinel, never a real project, so it plans in
 * full.
 */
export function onboardingStages(db: DB, projectId: number): readonly string[] | undefined {
  if (projectId <= 0) return undefined
  const row = db.prepare('SELECT setup_state FROM project WHERE id = ?').get(projectId) as
    | { setup_state: string }
    | undefined
  return row?.setup_state === 'onboarding' ? ONBOARDING_STAGES : undefined
}

export interface PlanResult {
  pipelineId: string
  /** Newly inserted jobs only. */
  jobIds: number[]
  /**
   * Every job this pipeline now consists of, in dependency order, whether this
   * call created it or adopted a live one.
   *
   * Distinct from `jobIds` because a caller asking "which job represents this
   * paper" needs an answer even when re-planning inserted nothing. Returning
   * only the new ids gave `[]` on the common re-plan path, and a caller
   * defaulting that to `0` then wrote a link to a job that does not exist.
   */
  allJobIds: number[]
  /** Jobs the partial unique index rejected because one is already live. */
  skipped: number
}

/**
 * The pipeline id for a subject.
 *
 * DERIVED, not minted. `job_key` is `pipeline:stage:fanout` and the partial
 * unique index on it is the only thing that makes re-planning idempotent — with
 * a random id per call, every re-plan would produce a fresh key that collides
 * with nothing and the queue would fill with duplicate jobs for the same paper.
 * Re-planning happens on every ingest, on `forceRerun`, and on attaching a
 * schema, so this is the common path rather than an edge case.
 */
function pipelineIdFor(input: PlanInput): string {
  return `w${input.workId}:d${input.documentId}:p${input.projectId}`
}

export function planPipeline(
  db: DB,
  registry: ResolvedRegistry,
  input: PlanInput,
  now: string
): PlanResult {
  const pipelineId = pipelineIdFor(input)
  const planCtx: StagePlanContext = {
    db,
    workId: input.workId,
    documentId: input.documentId,
    projectId: input.projectId
  }

  // A DOCUMENT ID THE `document` TABLE DOES NOT HOLD MUST BE WRITTEN AS NULL.
  //
  // Callers pass `documentId ?? 0` when a work has no preferred document —
  // `preferredDocument` in the scheduler returns 0 for "none". Zero is a
  // sentinel in the planning context, but `processing_job.document_id` carries
  // a real FOREIGN KEY to `document(id)`, and no row has id 0. So the insert
  // died with a bare "FOREIGN KEY constraint failed", which surfaced to the
  // user as `Could not invalidate:` with no indication of which id was wrong.
  //
  // The column is nullable and corpus sweeps already store NULL there, so NULL
  // is the shape the schema already expects for "no document". Resolved once,
  // here, rather than at each of the three call sites that build a PlanInput —
  // a fourth would otherwise reintroduce it.
  const documentId =
    input.documentId > 0 &&
    db.prepare('SELECT 1 FROM document WHERE id = ?').get(input.documentId) !== undefined
      ? input.documentId
      : null

  // The work must EXIST. `processing_job.work_id` is the other foreign key on
  // this insert, and planning for a work that has been deleted fails the same
  // opaque way. Refused with a sentence naming the id, because that is a caller
  // bug — a deleted paper has no pipeline — and it should not read as a
  // database fault.
  if (db.prepare('SELECT 1 FROM work WHERE id = ?').get(input.workId) === undefined) {
    throw new Error(`cannot plan: work ${input.workId} does not exist`)
  }

  // A PIPELINE WITHOUT A DOCUMENT IS NOT A PIPELINE, and nulling the job column
  // above is not enough on its own.
  //
  // `planCtx.documentId` stays 0 either way, and every document-scoped stage is
  // keyed on it — so a plan for a non-existent document minted a SECOND full
  // pipeline for the paper, thirteen jobs keyed `w3:d0:p1:*` alongside the
  // paper's real `w3:d3:p1:*` ones. `retrieve` then executed with
  // `ctx.documentId = 0` and its writes died on `FOREIGN KEY constraint failed`,
  // four attempts deep, which the user saw as "Fetch PDF · Failed" on a paper
  // whose PDF was already fetched.
  //
  // Refused rather than silently skipped: reaching here means a caller resolved
  // a document it should have checked, and the pairs it planned are wrong. The
  // one legitimate case — a work that genuinely has no document yet — is a
  // pipeline with nothing to do, and saying so beats queueing thirteen jobs
  // that cannot run.
  if (documentId === null) {
    throw new Error(
      `cannot plan: work ${input.workId} has no document (was given id ${input.documentId})`
    )
  }

  return db.transaction((): PlanResult => {
    const jobIds: number[] = []
    const allJobIds: number[] = []
    let skipped = 0
    // stage id -> the job ids planned for it (more than one when it fans out).
    const jobsByStage = new Map<string, number[]>()

    // ONE JOB PER KEY, FOR THE LIFE OF THE KEY.
    //
    // `ux_processing_job_live` is partial — terminal rows are exempt, so that
    // `forceRerun` can insert against a key a finished job still holds. The
    // consequence nobody had closed: a key held by a `done` job also does not
    // conflict on the ORDINARY path, so every replan inserted a fresh
    // duplicate. Measured on a 20-paper corpus: 206 distinct job keys across
    // 26,505 rows — the same job re-created up to 149 times, each round
    // re-running the pipeline it stood for. That is the "my whole corpus is
    // rebuilt again" loop, and the docstring on `plan()` promising "idempotent:
    // re-planning is a no-op" described an intent the SQL never implemented.
    //
    // Fixed by LOOKING FIRST rather than by widening the index, which would
    // need a migration and would break `forceRerun`'s only insertion path.
    //
    // Re-running a finished stage never needed a second row. The job is the
    // standing intent to keep that stage current; whether it EXECUTES is
    // `decideCache`'s decision, taken from the input fingerprint at claim time.
    // So re-arming a `done` job costs nothing when nothing changed — the claim
    // sees an unchanged fingerprint and settles it straight back to done
    // without running the stage — and carries the re-run when something did.
    // NEWEST row per key. A database written before this fix holds up to 149
    // rows for one key; re-arming an arbitrary one would make a second row live
    // and violate `ux_processing_job_live`. The newest is the current one.
    const findHeld = db.prepare(
      `SELECT id, status, outcome FROM processing_job WHERE job_key = ? ORDER BY id DESC LIMIT 1`
    )
    const rearm = db.prepare(
      `UPDATE processing_job
          SET status = 'queued', attempts = 0, error = NULL, error_kind = NULL,
              lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ?`
    )
    const insert = db.prepare(
      `INSERT INTO processing_job
         (job_type, stage, status, work_id, document_id, project_id, schema_id,
          fanout_key, pipeline_id, job_key, priority, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(job_key)
         WHERE job_key IS NOT NULL
           AND status NOT IN ('done','failed','cancelled','review')
         DO NOTHING`
    )

    const only = input.onlyStages === undefined ? null : new Set(input.onlyStages)
    for (const { stage } of registry.order) {
      if (stage.scope === 'corpus') continue
      if (only !== null && !only.has(stage.id)) continue

      let fans: Array<FanOutKey | null> = [null]
      if (stage.fanOut) {
        const keys = stage.fanOut(planCtx)
        // Duplicate keys would collide on `job_key` and be silently dropped by
        // the ON CONFLICT, so the fan-out would quietly produce fewer jobs than
        // the stage asked for. Fail at plan time, where the author can see it.
        const dupes = keys.map((k) => k.key).filter((k, i, a) => a.indexOf(k) !== i)
        if (dupes.length > 0) {
          throw new Error(`stage '${stage.id}' fanOut returned duplicate key(s): ${dupes.join(', ')}`)
        }
        fans = keys.length > 0 ? keys : []
      }

      const planned: number[] = []
      // Counted per stage rather than per fan-out: a schema-extract with 12
      // schemas would otherwise emit 12 lines saying the same thing, and the
      // question being answered is "which stage refilled", not "which key".
      let rearmed = 0
      const rearmedFrom = new Set<string>()
      for (const fan of fans) {
        const fanoutKey = fan?.key ?? ''
        const jobKey = `${pipelineId}:${stage.id}:${fanoutKey}`

        // LOOK BEFORE INSERTING. `ux_processing_job_live` exempts terminal
        // rows, so an INSERT against a key held by a finished job succeeds and
        // mints a duplicate — the replan loop. Adopting the existing row is
        // what makes planning genuinely idempotent.
        const held = findHeld.get(jobKey) as
          | { id: number; status: string; outcome: string | null }
          | undefined
        if (held) {
          // `failed` and `cancelled` are the USER's to retry. Silently
          // re-queueing them would turn a paper that failed four times into an
          // endless retry, and hide the failure the Queue exists to show.
          //
          // A job carrying an OUTCOME has FINISHED, whatever its status says.
          // The queue leaves settled rows at `status='queued'` with
          // `outcome='succeeded'` — work that ran and completed but was never
          // re-stamped — and testing status alone matched neither branch: not
          // re-armed here, and not re-run by the claim loop, which sees a
          // status it believes is already pending. Such a job was frozen for
          // good. Observed: a paper whose project summary declined for want of
          // a project context kept that refusal after the context was built,
          // while its neighbours (whose jobs happened to read `done`) were
          // re-armed and got real summaries.
          // `failed` IS SETTLED, and leaving it out was a hole with a user
          // path straight through it: `retrieve` reports a paper it could not
          // fetch as failed, the screen tells the reader to supply the PDF
          // themselves, and attaching one re-plans the paper — but a job left
          // out of this test is never re-armed, so the retrieve stayed failed
          // and every dependent revived behind it sat `queued` forever waiting
          // on a dependency that can never satisfy them.
          //
          // A failure is NOT cacheable, so a re-armed one really does run
          // again. That is the point — it is how attaching a file gets the
          // fetch reconsidered — and it is bounded because this runs on a
          // deliberate act (an import, an attach, a retry), never on a timer
          // or a sweep. `retryable: false` still governs the automatic
          // retries inside one run; this is the user asking again.
          const settled =
            held.status === 'done' ||
            held.status === 'review' ||
            held.status === 'failed' ||
            (held.outcome !== null && held.status === 'queued')
          if (settled) {
            rearmed += rearm.run(now, held.id).changes
            rearmedFrom.add(held.status)
          }
          planned.push(held.id)
          allJobIds.push(held.id)
          skipped++
          continue
        }

        const info = insert.run(
          LEGACY_JOB_TYPE[stage.id] ?? stage.id,
          stage.id,
          // Everything starts `queued`; the claim query itself refuses a job
          // whose dependencies are unsatisfied. Writing `blocked` here would
          // surface a status the Queue screen has no styling for, and this wave
          // is backend-only.
          'queued',
          input.workId,
          documentId,
          stage.scope === 'project' ? input.projectId : 0,
          fan?.schemaId ?? 0,
          fanoutKey,
          pipelineId,
          jobKey,
          input.priority ?? 100,
          now,
          now
        )
        if (info.changes === 0) {
          // A live job raced us to this key between the lookup above and the
          // insert. Adopt it, for the same reason: a downstream job inserted
          // without a dependency row against a live upstream becomes
          // immediately claimable and runs against an input that does not
          // exist yet.
          const live = db
            .prepare(
              `SELECT id FROM processing_job
                WHERE job_key = ? AND status NOT IN ('done','failed','cancelled','review')`
            )
            .get(jobKey) as { id: number } | undefined
          if (live) {
            planned.push(live.id)
            allJobIds.push(live.id)
          }
          skipped++
          continue
        }
        const id = Number(info.lastInsertRowid)
        planned.push(id)
        jobIds.push(id)
        allJobIds.push(id)
      }
      logRearm('plan:adopt', rearmed, {
        workId: input.workId,
        stage: stage.id,
        why: `was=${[...rearmedFrom].join('/')} pipeline=${pipelineId}`
      })
      jobsByStage.set(stage.id, planned)
    }

    // Edges come from the SAME positional resolution `ctx.input` uses, so the
    // order a stage is scheduled in and the provider it reads can never
    // disagree. Deriving them from the raw provider map instead would let a
    // consumer be claimed before a transformer had rewritten its token.
    const edge = db.prepare(
      `INSERT INTO job_dependency (job_id, depends_on_job_id) VALUES (?, ?)
         ON CONFLICT DO NOTHING`
    )
    for (const { stage } of registry.order) {
      const mine = jobsByStage.get(stage.id) ?? []
      if (mine.length === 0) continue
      for (const depStageId of registry.dependenciesFor(stage.id)) {
        for (const depJobId of jobsByStage.get(depStageId) ?? []) {
          for (const jobId of mine) edge.run(jobId, depJobId)
        }
      }
    }

    return { pipelineId, jobIds, allJobIds, skipped }
  }).immediate()
}
