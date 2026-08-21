import type { Database as DB } from 'better-sqlite3'
import type { JobQueue } from './scheduler'

/**
 * Papers in a project that no pipeline has ever been planned for.
 *
 * A work is planned at IMPORT time and only then. Anything that puts a paper in
 * a project by another route — an archive restore, a schema rebuild, a database
 * carried over from a build that planned differently — leaves it with no job and
 * no way back: the queue cannot show what has no row, so the user sees a project
 * of twenty papers and a queue of two, and no button anywhere fixes it.
 *
 * `excluded` is left alone. It is the one inclusion status that records a
 * decision to keep a paper out, and re-queueing it on the next launch would
 * overrule the user silently and repeatedly. Every other status ('unread',
 * 'read', 'uncertain', 'included') describes where a paper is in review, not
 * whether it should be processed.
 *
 * Only works with no PIPELINE job for the project are returned. A work that
 * already has one is left untouched — `planPipeline` re-arms a settled job back
 * to 'queued', so sweeping the healthy ones would re-run the corpus on every
 * launch. The predicate is row existence, which makes the sweep
 * self-terminating: once planned, a work never matches again.
 *
 * A PIPELINE job is one with a `job_key`, and the qualifier is load-bearing.
 * `job_key` is `pipeline:stage:fanout` and is what every part of planning is
 * keyed on — the partial unique index that makes re-planning idempotent is
 * `WHERE job_key IS NOT NULL` — so a keyless row belongs to no pipeline by
 * construction and cannot be re-armed, depended on, or cascaded through. Rows
 * like that do exist: the seed writes three to give the Queue screen something
 * to show. Counting them meant work 2 looked planned on the strength of two
 * ornaments, and stayed the one paper in the corpus with no pipeline at all —
 * no text, no references, no analysis — while the sweep that exists to catch
 * exactly that walked past it on every launch.
 */
export function findUnplannedProjectWorks(
  db: DB
): Array<{ workId: number; projectId: number }> {
  return db
    .prepare(
      `SELECT pw.work_id AS workId, pw.project_id AS projectId
         FROM project_work pw
        WHERE pw.inclusion_status <> 'excluded'
          AND NOT EXISTS (
                SELECT 1 FROM processing_job j
                 WHERE j.work_id = pw.work_id
                   AND j.project_id = pw.project_id
                   AND j.job_key IS NOT NULL)
        ORDER BY pw.project_id, pw.work_id`
    )
    .all() as Array<{ workId: number; projectId: number }>
}

/**
 * Plan every project paper that has no pipeline. Runs once per boot.
 *
 * Never throws: a corpus that cannot be swept is still a corpus the user can
 * read, so a failure here must not keep the window shut.
 */
export function planUnplannedProjectWorks(db: DB, queue: JobQueue): void {
  let rows: Array<{ workId: number; projectId: number }>
  try {
    rows = findUnplannedProjectWorks(db)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[main] could not scan for unplanned project papers:', err)
    return
  }
  if (rows.length === 0) return

  let planned = 0
  let failed = 0
  for (const row of rows) {
    try {
      queue.planForWork(row.workId, row.projectId)
      planned += 1
    } catch (err) {
      failed += 1
      // eslint-disable-next-line no-console
      console.error(
        `[main] could not plan work ${row.workId} for project ${row.projectId}:`,
        err
      )
    }
  }
  // eslint-disable-next-line no-console
  console.log(
    `[main] planned ${planned} project paper(s) that had no pipeline` +
      (failed > 0 ? ` (${failed} failed)` : '')
  )
}
