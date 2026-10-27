// A stage's fan-out SET can change, and runs on keys that left the set are
// orphans that still speak for the stage.
//
// `ux_stage_run_current` is keyed on `fanout_key`, so the ONE-CURRENT-RUN
// guarantee it gives is per key and says nothing about a key nobody plans any
// more. Supersede-then-insert only ever frees the slot it is about to fill, so
// a key that is never planned again is never freed by anything: its run sits at
// `superseded = 0` forever, still asserting whatever it concluded.
//
// That is not merely untidy, because `refused` is a load-bearing answer here. A
// project with no extraction schema attached fans `schema-extract` out to the
// single key `default`, and the stage refuses: there is nothing to extract
// against. The refusal cancels every dependent, which is correct while it
// stands. Attaching schemas then fans the stage out to one key PER SCHEMA — a
// different set — so the new runs collide with nothing, the `default` run stays
// current, and the cancelled `review-records` jobs behind it stay cancelled.
// Measured on a real corpus: `schema-extract` succeeded 44/44 and wrote 2156
// facts while 22 review jobs sat cancelled on a refusal from before the schemas
// existed. The only paper whose review ever ran was the one imported AFTER the
// attach, which never had a `default` run at all.
//
// Schema attachment is one trigger; deleting or renaming a schema is another,
// and any future fanned-out stage brings its own. So this is written against
// the general shape — "the key is not in the set the stage now plans" — and
// names no stage and no key literal.

import type { DB } from '../db/connection'
import { logRearm, summarize } from './rearmLog'
import type { ResolvedRegistry } from './registry'
import { deleteRunOutput } from './stageRun'
import type { StageDefinition, StagePlanContext } from './types'

export interface OrphanedFanout {
  runId: number
  fanoutKey: string
}

/**
 * Retire every current run of `stage` for this subject whose `fanout_key` is
 * not in `keys`.
 *
 * RETIRED, in the same shape `supersedeCascade` retires: `superseded = 1`, the
 * output deleted, `lease_epoch` bumped so an executor still in flight cannot
 * commit onto the row, and a `running` row moved to `failed` because a run
 * cannot both be executing and be over. The row itself is KEPT — it is the
 * provenance of what the stage once concluded, and the partial index only cares
 * about the flag.
 *
 * AN EMPTY `keys` RETIRES NOTHING, deliberately. `planPipeline` reads an empty
 * fan-out as "do not plan this stage right now", which happens when the inputs
 * a stage fans out over are momentarily unavailable — that is an absence of
 * information, not evidence that previously computed keys are gone, and
 * treating it as the latter would destroy good output on a transient read.
 */
export function retireOrphanedFanoutRuns(
  db: DB,
  stage: StageDefinition,
  ctx: StagePlanContext,
  keys: readonly string[],
  now: string
): OrphanedFanout[] {
  if (stage.fanOut === undefined) return []
  if (keys.length === 0) return []
  // Derived from the SCOPE exactly as `keyOf` does, so the rows found here are
  // the rows the index is enforcing on. Reading the caller's ids directly would
  // search a slot a document-scoped stage never writes.
  const workId = stage.scope === 'corpus' ? 0 : ctx.workId
  const documentId = stage.scope === 'corpus' ? 0 : ctx.documentId
  const projectId = stage.scope === 'project' ? ctx.projectId : 0
  const holes = keys.map(() => '?').join(',')
  const orphans = db
    .prepare(
      `SELECT id, fanout_key FROM stage_run
        WHERE stage = ? AND work_id = ? AND document_id = ? AND project_id = ?
          AND superseded = 0 AND fanout_key NOT IN (${holes})`
    )
    .all(stage.id, workId, documentId, projectId, ...keys) as Array<{
    id: number
    fanout_key: string
  }>
  if (orphans.length === 0) return []
  const retire = db.prepare(
    `UPDATE stage_run
        SET superseded = 1, lease_epoch = lease_epoch + 1,
            status = CASE WHEN status = 'running' THEN 'failed' ELSE status END,
            error = CASE WHEN status = 'running'
                         THEN COALESCE(error, 'retired while running: this fan-out key is no longer planned')
                         ELSE error END,
            finished_at = COALESCE(finished_at, ?)
      WHERE id = ? AND superseded = 0`
  )
  const retired: OrphanedFanout[] = []
  for (const o of orphans) {
    if (retire.run(now, o.id).changes === 0) continue
    deleteRunOutput(db, o.id)
    retired.push({ runId: o.id, fanoutKey: o.fanout_key })
  }
  return retired
}

/**
 * Put back the jobs a now-retired refusal took down with it.
 *
 * `cancelDependents` cancels everything downstream of a refusal, and that stays
 * right for as long as the refusal is current. Once the run has been retired
 * the cancellation rests on nothing — so the dependents are revived, and ONLY
 * the ones whose cancellation says `error_kind = 'upstream'`. A job the user
 * cancelled, or one cancelled behind a refusal that is still current, is not in
 * this set and is not touched.
 *
 * ONE ROW PER KEY, AND ONLY THE NEWEST, the rule every other revival in this
 * codebase follows: `job_dependency` edges outlive their jobs, so the recursive
 * walk legitimately reaches older rows on a key whose newest row is already
 * live, and reviving one of those puts two live rows on one key and
 * `ux_processing_job_live` throws.
 */
export function reviveDependentsOfRetired(
  db: DB,
  rootJobIds: readonly number[],
  now: string,
  why: string
): number {
  if (rootJobIds.length === 0) return 0
  const holes = rootJobIds.map(() => '?').join(',')
  const predicate = `status = 'cancelled' AND error_kind = 'upstream'
          AND id IN (
            WITH RECURSIVE downstream(id) AS (
              SELECT id FROM processing_job WHERE id IN (${holes})
              UNION
              SELECT d.job_id FROM job_dependency d
                JOIN downstream ON d.depends_on_job_id = downstream.id
            )
            SELECT id FROM downstream
          )
          AND (processing_job.job_key IS NULL
               OR processing_job.id =
                  (SELECT MAX(k.id) FROM processing_job k
                    WHERE k.job_key = processing_job.job_key))`
  const rows = db
    .prepare(`SELECT id, stage, work_id FROM processing_job WHERE ${predicate}`)
    .all(...rootJobIds) as Array<{ id: number; stage: string | null; work_id: number | null }>
  if (rows.length === 0) return 0
  const revived = db
    .prepare(
      `UPDATE processing_job
          SET status = 'queued', attempts = 0, error = NULL, error_kind = NULL,
              stage_run_id = NULL, lease_owner = NULL, lease_expires_at = NULL,
              lease_epoch = lease_epoch + 1,
              started_at = NULL, finished_at = NULL, updated_at = ?
        WHERE ${predicate}`
    )
    .run(now, ...rootJobIds)
  logRearm('cascade:upstream', revived.changes, {
    workId: rows[0]?.work_id ?? null,
    stage: summarize(rows.map((r) => r.stage)),
    why
  })
  return revived.changes
}

/**
 * Retire the orphans of one stage and revive what its refusal had cancelled.
 *
 * The two halves are one act: retiring the run without reviving the dependents
 * leaves the queue exactly as stuck as before, and reviving without retiring
 * would send the dependents back into a refusal that is still current.
 */
export function reconcileFanout(
  db: DB,
  stage: StageDefinition,
  ctx: StagePlanContext,
  keys: readonly string[],
  pipelineId: string,
  now: string
): OrphanedFanout[] {
  const retired = retireOrphanedFanoutRuns(db, stage, ctx, keys, now)
  if (retired.length === 0) return retired
  // The job that OWNED each retired run, found by the key it was planned under
  // — `stage_run_id` is cleared on several paths, so the job key is the durable
  // link between a run and the job that stands for it.
  const jobIds: number[] = []
  const findJob = db.prepare('SELECT id FROM processing_job WHERE job_key = ? ORDER BY id DESC LIMIT 1')
  for (const r of retired) {
    const row = findJob.get(`${pipelineId}:${stage.id}:${r.fanoutKey}`) as { id: number } | undefined
    if (row) jobIds.push(row.id)
  }
  reviveDependentsOfRetired(
    db,
    jobIds,
    now,
    `stage '${stage.id}' no longer fans out to ${summarize(retired.map((r) => r.fanoutKey))}`
  )
  return retired
}

/**
 * Sweep every planned pipeline for orphaned fan-out keys, once per boot.
 *
 * WHY A SWEEP AND NOT A MIGRATION. The orphan is defined by comparing a stored
 * key against the set the stage's `fanOut` returns TODAY, and that function is
 * code with a database behind it — a migration cannot call it and cannot
 * reconstruct its answer from SQL, so it could only hardcode the one key this
 * bug was found on and would miss the next trigger entirely.
 *
 * WHY A SWEEP AND NOT "the next re-plan fixes it". Re-planning a paper is not
 * something that happens on its own: the boot-time plan sweep deliberately
 * touches only papers with NO pipeline at all, precisely so that launching the
 * app does not re-run the corpus. A damaged install therefore has no path back
 * — the user would have to re-import or re-attach a schema to each paper, with
 * nothing in the UI telling them to. This sweep is cheap (one `fanOut` call per
 * stage per pipeline, no model calls) and self-terminating: once a key is
 * retired it is superseded, and the next boot finds nothing.
 *
 * Never throws: an install that cannot be reconciled is still one the user can
 * read, so a failure here must not keep the window shut.
 */
export function sweepOrphanedFanouts(db: DB, registry: ResolvedRegistry, now: string): number {
  let retired = 0
  try {
    const fanned = registry.order.filter((r) => r.stage.scope !== 'corpus' && r.stage.fanOut)
    if (fanned.length === 0) return 0
    const pipelines = db
      .prepare(
        `SELECT DISTINCT work_id AS workId, document_id AS documentId, project_id AS projectId
           FROM processing_job
          WHERE job_key IS NOT NULL AND work_id IS NOT NULL AND document_id IS NOT NULL`
      )
      .all() as Array<{ workId: number; documentId: number; projectId: number }>
    for (const p of pipelines) {
      const ctx: StagePlanContext = {
        db,
        workId: p.workId,
        documentId: p.documentId,
        projectId: p.projectId
      }
      for (const { stage } of fanned) {
        try {
          const keys = (stage.fanOut as (c: StagePlanContext) => Array<{ key: string }>)(ctx).map(
            (k) => k.key
          )
          retired += db
            .transaction(
              () =>
                reconcileFanout(
                  db,
                  stage,
                  ctx,
                  keys,
                  `w${p.workId}:d${p.documentId}:p${p.projectId}`,
                  now
                ).length
            )
            .immediate()
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(
            `[main] could not reconcile fan-out of '${stage.id}' for work ${p.workId}:`,
            err
          )
        }
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[main] could not sweep orphaned fan-out keys:', err)
    return retired
  }
  if (retired > 0) {
    // eslint-disable-next-line no-console
    console.log(`[main] retired ${retired} stage run(s) on fan-out keys that are no longer planned`)
  }
  return retired
}
