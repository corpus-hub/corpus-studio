// EVERY path that puts a settled job back on the queue, named out loud.
//
// A job going from `done` back to `queued` is the single most expensive event
// in this app: it re-runs a stage, and for the AI stages that is a model call
// per paper. It happened repeatedly without anyone being able to say what
// caused it — the queue simply refilled, and the only way to find out was to
// read timestamps afterwards and guess.
//
// There are seven such writes across three files (`planner.ts` x2,
// `scheduler.ts` x5). Each is legitimate on its own; what was missing was any
// record of WHICH one fired, for how many jobs, and why. So they all report
// through here, in one shape, and the reason is a required argument — a caller
// cannot re-arm anonymously.
//
// Deliberately `console.log` and not the dev-log file: this must be visible in
// the ordinary terminal output the user already watches, without a setting to
// discover first. It is low-volume by nature — a re-arm is an event, not a
// tick.

/** Where a re-arm came from. One per call site, so a log line names the code. */
export type RearmSource =
  /** `planPipeline` adopted a finished job for a stage being planned again. */
  | 'plan:adopt'
  /** `planCorpusSweeps` woke a library-wide sweep. */
  | 'plan:sweep'
  /** `resumePending` recovered a job whose worker died mid-run. */
  | 'resume:orphan'
  /** The user pressed Retry on a failed job. */
  | 'user:retry'
  /** A cascade retired the run a job owned, so the job must run again. */
  | 'cascade:owner'
  /** An upstream was cancelled and has since been revived. */
  | 'cascade:upstream'
  /** A stage threw or reported a retryable failure, so `settle` re-queued it. */
  | 'stage:transient'

/**
 * Report a re-arm. Call AFTER the write, with the number of rows it changed.
 *
 * `count` of zero is not logged: a no-op re-arm is not an event, and logging it
 * would bury the real ones under the ordinary planning traffic that adopts
 * jobs without changing them.
 */
export function logRearm(
  source: RearmSource,
  count: number,
  detail: { workId?: number | null; stage?: string | null; jobId?: number | null; why?: string }
): void {
  if (count <= 0) return
  const bits: string[] = [`${count} job${count === 1 ? '' : 's'}`]
  if (detail.workId != null) bits.push(`work=${detail.workId}`)
  if (detail.stage) bits.push(`stage=${detail.stage}`)
  if (detail.jobId != null) bits.push(`job=${detail.jobId}`)
  if (detail.why) bits.push(detail.why)
  console.log(`[rearm ${source}] ${bits.join(' · ')}`)
}

/**
 * Condense the subjects of a bulk re-arm into one field.
 *
 * A bulk write covers many rows and the identifying columns repeat, so listing
 * them raw turns one event into a wall of the same value. Distinct values only,
 * and past four the tail becomes a count — enough to name what was hit without
 * the line wrapping. Returns null (which `logRearm` then omits) when there is
 * nothing to say, so an unknown subject prints no empty `stage=`.
 */
export function summarize(values: Array<string | number | null | undefined>): string | null {
  const seen: string[] = []
  for (const v of values) {
    if (v == null || v === '') continue
    const s = String(v)
    if (!seen.includes(s)) seen.push(s)
  }
  if (seen.length === 0) return null
  if (seen.length <= 4) return seen.join(',')
  return `${seen.slice(0, 4).join(',')}+${seen.length - 4}`
}
