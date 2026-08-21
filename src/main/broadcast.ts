import { getDb } from './db/connection'
import { settleReferenceRetrievals } from './db/repositories'

/**
 * "Something changed, read again" signals, in ONE module that anything may
 * import.
 *
 * They used to live in `index.ts`, which meant every caller had to be in
 * `index.ts` too. The IPC registry entries are not: they are plain functions in
 * `src/main/ipc/registry/*` that must run identically whether the caller is the
 * renderer or an MCP client, and importing `index.ts` from them would be a cycle
 * through the whole app.
 *
 * IMPORTS NO ELECTRON, on purpose. The registry's testability rests on being
 * loadable outside an Electron main process, and it reaches this module for
 * `work:delete` and `jobs:setDismissed`. So delivery is a SINK registered by
 * `index.ts` at startup — the same pattern `setQuitFlush` already uses in
 * `closeGuard.ts` — rather than a direct `BrowserWindow.getAllWindows()` walk.
 * A signal raised before the sink is installed is dropped, which is correct:
 * every screen reads once on mount, so there is nothing for it to tell.
 */

/**
 * How long changes are gathered before one signal goes out.
 *
 * A tick-level window (`setImmediate`) only collapses notifications raised in
 * the SAME macrotask, and each job's completion lands in its own — so a bulk
 * ingest produced roughly two broadcasts per job, each triggering a full job
 * list refetch in every window. A short timer bounds the traffic by elapsed
 * time instead of by job count, and 150ms is far below the ~400ms at which a
 * change stops feeling immediate.
 */
const JOBS_CHANGED_COALESCE_MS = 150

/** Deliver a payload-free signal to every live window. Installed by `index.ts`. */
type Sink = (channel: 'jobs:changed' | 'summaries:changed') => void

let sink: Sink | null = null
/** Re-push the close prompt's live count. Installed by `index.ts`. */
let onJobsSettled: (() => void) | null = null

export function setBroadcastSink(next: Sink, settled: () => void): void {
  sink = next
  onJobsSettled = settled
}

let jobsChangedTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Run the deferred settle pass NOW, because the process is about to go away.
 *
 * The coalescing timer below owns a real DB write; a quit scheduled between the
 * timer being armed and it firing would drop that write silently, and the
 * retrieval it was settling would look stuck on the next launch.
 */
export function flushPendingBroadcast(): void {
  if (jobsChangedTimer === null) return
  clearTimeout(jobsChangedTimer)
  jobsChangedTimer = null
  try {
    settleReferenceRetrievals(getDb())
  } catch {
    /* the DB may already be closing; the settle pass re-runs on next launch */
  }
}

/**
 * Tell every window the job queue moved.
 *
 * Carries no payload: it is a "something changed, read again" signal, so the
 * renderer refetches through the ordinary typed IPC and there is no second,
 * push-shaped copy of the job DTO to keep in sync.
 *
 * Deferring also matters for correctness, not just volume: `enqueue` is called
 * inside `db.transaction(...)` in places, so a synchronous send could have a
 * renderer read the queue before that transaction committed.
 */
export function broadcastJobsChanged(): void {
  if (jobsChangedTimer !== null) return
  jobsChangedTimer = setTimeout(() => {
    jobsChangedTimer = null
    // Settle FIRST, so the state the renderer is about to read is already
    // final and it does not have to be told twice.
    //
    // Inside the timer, not at the call site: `enqueue` runs inside caller
    // transactions (retrieveUnresolvedReferences wraps a whole batch in one),
    // so settling synchronously would nest its writes — including the DELETEs
    // of failed placeholder works — in a transaction that can still roll back,
    // and would repeat the whole pass once per reference in a batch.
    try {
      settleReferenceRetrievals(getDb())
    } catch {
      /* a settle failure must never stop the queue from reporting progress */
    }
    sink?.('jobs:changed')
    // The close prompt shows a live count of what is still being read, and the
    // queue moving is exactly when that count changes.
    try {
      onJobsSettled?.()
    } catch {
      /* a prompt refresh failure must never stop the queue reporting progress */
    }
  }, JOBS_CHANGED_COALESCE_MS)
}

/**
 * Tell every window that a summary was written.
 *
 * Its OWN broadcaster rather than a reuse of `broadcastJobsChanged`, which
 * carries two side effects a summary has no business triggering: it settles
 * reference retrievals and it refreshes the quit prompt's count of work in
 * flight. Borrowing it would make writing a summary run a DB pass over
 * unrelated rows.
 *
 * NOT COALESCED, for the same reason that one is. The job queue moves
 * continuously and a timer keeps a busy import from flooding the renderer;
 * writing a summary is a deliberate act a user performs once, and delaying its
 * echo by 150ms would only make the screen feel late.
 *
 * Sent from MAIN rather than echoed locally by the component that asked for the
 * write. That is what makes every OTHER surface update — the Ranking row behind
 * the modal, a reference-tree card in another part of the app, a second window —
 * rather than only the one that happened to make the call.
 */
export function broadcastSummariesChanged(): void {
  sink?.('summaries:changed')
}
