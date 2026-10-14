import type { JobDTO } from '@shared/contract'

/**
 * THE renderer-side definition of "a failure that still needs attention",
 * mirroring `JOB_FAILED_PREDICATE` in the repository (`status IN
 * ('failed','error') AND dismissed = 0`).
 *
 * It exists so the sidebar badge and the Papers tabs cannot drift from the
 * project card's SQL — they did, when dismissal was renderer-only state the
 * query could not see and the same corpus reported 1 and 2 failures at once.
 */
export const isOutstandingFailure = (j: JobDTO): boolean =>
  (j.status === 'failed' || j.status === 'error') &&
  !j.dismissed &&
  // NOT a failure whose run has since been SUPERSEDED.
  //
  // A superseded run is one a later attempt replaced — so its failure is
  // history, and the stage it belongs to has a current result. Counting it
  // reported "46 failed" on a corpus where every affected paper had succeeded:
  // 44 of those 46 pointed at superseded runs and none at a current one. One
  // paper alone contributed 33, having been retried 33 times.
  //
  // The number a user acts on is "how many papers still need me", and a retry
  // that eventually worked does not. The history is not hidden — the row still
  // shows its earlier attempts — it simply stops being an alarm.
  j.stage_run_superseded !== true &&
  // NOT a job that names no run at all.
  //
  // `stage_run_id IS NULL` means nothing was ever executed for it: the seed
  // writes such rows pre-baked as `failed` to populate the queue screen, and
  // they carry an invented error ("PDF text layer missing; OCR not enabled")
  // about a paper whose references stage has in fact succeeded — 213 parsed,
  // 11 matched. A row describing work that never ran cannot outrank the run
  // that did.
  //
  // This is narrow on purpose: a REAL failure always has a run behind it,
  // because the scheduler opens one before executing and settles the job from
  // its outcome. So nothing genuine is hidden by this test.
  j.stage_run_id !== null
