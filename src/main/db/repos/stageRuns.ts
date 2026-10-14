// Reading the `stage_run` table — the pipeline's own record of what ran.
//
// `stage_run` is the EXECUTION record (which stage, over which inputs, with
// which fingerprint); `analysis_run` stays the PROVENANCE record for LLM output.
// This module only reads. Every write to `stage_run` belongs to the scheduler,
// which owns the supersede-then-insert invariant.
//
// WHY IDS ARE RESOLVED HERE AND NEVER ACCEPTED FROM A CALLER.
// `Scheduler.forceRerun(stageRunId)` looks a row up by id and then cascades on
// its KEY, with no `superseded` check — so an id that was current when it was
// read, and has since been retired, retires whatever now holds that key
// INSTEAD. A caller holding an id across two calls is therefore holding a way
// to destroy a run it never saw. `currentStageRunIds` exists so that resolution
// and use happen inside ONE synchronous call, and every row this module returns
// carries `superseded` and `status` so nothing downstream can mistake a retired
// row for a live one.

import type { DB } from '../connection'
import type { StageRunDTO, StageRunPageDTO } from '@shared/contract'

/**
 * One execution of one stage. Aliased from the contract DTO rather than
 * redeclared: this shape crosses IPC verbatim, and two hand-kept copies drift.
 */
export type StageRunRow = StageRunDTO

type RawStageRun = Omit<StageRunRow, 'superseded'> & { superseded: number }

const STAGE_RUN_SELECT = /* sql */ `
  SELECT sr.id, sr.stage, sr.stage_version, sr.work_id, sr.document_id,
         sr.project_id, sr.schema_id, sr.fanout_key, sr.status,
         sr.outcome_note, sr.error, sr.model, sr.prompt_version, sr.schema_version,
         sr.analysis_run_id, sr.superseded, sr.superseded_by, sr.duration_ms,
         sr.created_at, sr.finished_at
    FROM stage_run sr
`

function toRow(r: RawStageRun): StageRunRow {
  // 0/1 -> boolean, so a caller cannot read the integer 0 as "present" through a
  // truthiness check and treat a live run as retired.
  return { ...r, superseded: r.superseded === 1 }
}

/** The most rows one listing returns. */
export const STAGE_RUNS_MAX_LIMIT = 200

/** A page of stage runs. `total` is a true COUNT(*), never `items.length`. */
export type ListStageRunsResult = StageRunPageDTO

/**
 * Every stage run matching a filter, newest first.
 *
 * `currentOnly` defaults to FALSE. The history is the point of this read — a
 * caller asking "why does this paper have no text" needs to see the failed run
 * that was later superseded by a skip, and a listing that showed only current
 * rows would answer "nothing ever ran".
 *
 * `projectId` filters on the stored `project_id` EXACTLY as stored, including
 * the 0 sentinel: a work-scoped stage (`download`, `segment`) writes 0, so
 * filtering a project id against those rows correctly returns none of them.
 * `includeGlobal` is how a caller asks for both — it is opt-in rather than
 * implied, because "runs for project 3" and "runs this project can see" are
 * different questions and conflating them is how a global run gets attributed
 * to a project.
 */
export function listStageRuns(
  db: DB,
  filter: {
    workId?: number
    documentId?: number
    projectId?: number
    stage?: string
    status?: string
    currentOnly?: boolean
    includeGlobal?: boolean
    limit?: number
    offset?: number
  } = {}
): ListStageRunsResult {
  const where: string[] = []
  const params: unknown[] = []
  if (filter.workId !== undefined) {
    where.push('sr.work_id = ?')
    params.push(filter.workId)
  }
  if (filter.documentId !== undefined) {
    where.push('sr.document_id = ?')
    params.push(filter.documentId)
  }
  if (filter.projectId !== undefined) {
    if (filter.includeGlobal) {
      where.push('sr.project_id IN (?, 0)')
      params.push(filter.projectId)
    } else {
      where.push('sr.project_id = ?')
      params.push(filter.projectId)
    }
  }
  if (filter.stage !== undefined) {
    where.push('sr.stage = ?')
    params.push(filter.stage)
  }
  if (filter.status !== undefined) {
    where.push('sr.status = ?')
    params.push(filter.status)
  }
  if (filter.currentOnly) where.push('sr.superseded = 0')

  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const limit = Math.min(Math.max(1, filter.limit ?? 50), STAGE_RUNS_MAX_LIMIT)
  const offset = Math.max(0, filter.offset ?? 0)

  const total = (
    db.prepare(`SELECT COUNT(*) AS c FROM stage_run sr ${clause}`).get(...params) as { c: number }
  ).c

  const items = (
    db
      .prepare(`${STAGE_RUN_SELECT} ${clause} ORDER BY sr.id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as RawStageRun[]
  ).map(toRow)

  return { items, total, limit, offset }
}

/** One run by id, or null. Carries `superseded` like every other read here. */
export function getStageRunById(db: DB, stageRunId: number): StageRunRow | null {
  const row = db.prepare(`${STAGE_RUN_SELECT} WHERE sr.id = ?`).get(stageRunId) as
    | RawStageRun
    | undefined
  return row ? toRow(row) : null
}

/**
 * ALL current runs of one stage for one work — plural, deliberately.
 *
 * `schema-extract` fans out one stage run per attached extraction schema, and
 * `forceRerun` takes a single id. Resolving a stage NAME to one id would re-run
 * one schema, leave the others stale, and report success. So this returns the
 * whole set and the caller acts on all of it.
 *
 * `projectId` is REQUIRED, and required rather than optional on purpose. Omitted,
 * this would return every project's current runs of that stage, and a caller
 * feeding that set to `forceRerun` would cascade a re-run across projects that
 * merely consumed the same output — without having stated which project it was
 * acting for. The scheduler already re-plans across projects; the caller must
 * name one.
 *
 * It is the project the caller is ACTING FOR, not a filter on the rows. A stage's `project_id` is written from its SCOPE — `planner.ts:174`
 * stores the project id for a project-scoped stage and 0 for every other — so a
 * caller passing a real project id and filtering strictly would match none of
 * the work-scoped stages and silently re-run nothing. Matching `IN (projectId, 0)`
 * is what makes "re-run `segment` for this paper, on behalf of project 3" mean
 * what it says.
 */
export function currentStageRunIds(
  db: DB,
  workId: number,
  stage: string,
  projectId: number
): StageRunRow[] {
  return (
    db
      .prepare(
        `${STAGE_RUN_SELECT}
          WHERE sr.work_id = ? AND sr.stage = ? AND sr.superseded = 0
            AND sr.project_id IN (?, 0)
          ORDER BY sr.id ASC`
      )
      .all(workId, stage, projectId) as RawStageRun[]
  ).map(toRow)
}
