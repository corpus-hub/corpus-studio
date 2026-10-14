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

/**
 * The floor between two full settle passes.
 *
 * `settleReferenceRetrievals` used to run on EVERY coalesced flush — 6.67 times
 * a second for as long as the queue moved. Its unscoped branch scans every
 * `unresolved_reference` in `retrieving`, each row carrying two correlated
 * `processing_job` subqueries and a `document` count, and it is a WRITE path on
 * the same synchronous connection the scheduler claims through. Main was
 * spending its time re-asking a question whose answer changes at the pace of a
 * network fetch, and every renderer IPC queued behind it.
 *
 * PERIODIC, NOT EVENT-DRIVEN, and the difference is not a style choice. The
 * function judges a retrieval live while ANY job of its work is non-terminal,
 * so the event that settles it is "that work's LAST job went terminal" — not
 * the completion of any nameable stage. Hanging this off a stage id would
 * strand retrievals in `retrieving` forever, which is precisely the bug the
 * sweep was written to cure (see its header in `repositories.ts`). So it keeps
 * running on its own, just far less often.
 */
const SETTLE_MIN_INTERVAL_MS = 5000

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
/** When the last full settle pass ran, so the next can be held off. */
let lastSettleMs = 0
/**
 * A settle the throttle skipped, still owed.
 *
 * Without this the LAST flush of a draining queue is the one most likely to be
 * inside the throttle window — the queue goes quiet immediately afterwards, so
 * nothing arrives to trigger the pass that was deferred, and the retrieval that
 * had just finished sits in `retrieving` until the next launch. The skipped
 * pass is therefore owed, not dropped: a trailing timer pays it, and quit
 * flushes it.
 */
let settleOwedTimer: ReturnType<typeof setTimeout> | null = null

function runSettle(): number {
  lastSettleMs = Date.now()
  if (settleOwedTimer !== null) {
    clearTimeout(settleOwedTimer)
    settleOwedTimer = null
  }
  try {
    return settleReferenceRetrievals(getDb())
  } catch {
    /*
     * A settle failure must never stop the queue reporting progress — and must
     * not CONSUME the pass either.
     *
     * This write shares a connection with the scheduler's claim, so the
     * plausible failure is a transient lock rather than a permanent one. Merely
     * swallowing it spent the attempt: the pass was marked taken at the top of
     * this function, and if the flush that triggered it was the last of a
     * draining queue — exactly when a retrieval has just finished and needs
     * settling — nothing would ever come to try again, and the reference would
     * read `retrieving` until the next launch. Running 6.67 times a second used
     * to hide this; at one pass per window the retry has to be deliberate.
     */
    settleOwedTimer = setTimeout(() => {
      settleOwedTimer = null
      if (runSettle() > 0) sink?.('jobs:changed')
    }, SETTLE_MIN_INTERVAL_MS)
    return 0
  }
}

/**
 * Settle now if it has been long enough, otherwise arrange for it to happen.
 *
 * The deferred pass is scheduled for the moment the window expires rather than
 * for the next broadcast, so a queue that finishes its last job still settles.
 */
function settleThrottled(): void {
  if (settleOwedTimer !== null) return
  const due = lastSettleMs + SETTLE_MIN_INTERVAL_MS - Date.now()
  if (due <= 0) {
    runSettle()
    return
  }
  settleOwedTimer = setTimeout(() => {
    settleOwedTimer = null
    // A deferred pass has to announce ITSELF. The flush that deferred it has
    // already sent its signal, and if the queue then went quiet — the common
    // case, since the last job finishing is what leaves a retrieval to settle —
    // no further signal is coming, and the tree would keep painting a card
    // mid-flight until something unrelated moved.
    if (runSettle() > 0) sink?.('jobs:changed')
  }, due)
}

/**
 * Run the deferred settle pass NOW, because the process is about to go away.
 *
 * The coalescing timer below owns a real DB write; a quit scheduled between the
 * timer being armed and it firing would drop that write silently, and the
 * retrieval it was settling would look stuck on the next launch.
 */
export function flushPendingBroadcast(): void {
  const owed = settleOwedTimer !== null
  if (jobsChangedTimer !== null) {
    clearTimeout(jobsChangedTimer)
    jobsChangedTimer = null
  } else if (!owed) {
    return
  }
  // Unconditionally, ignoring the throttle: the window exists to stop a busy
  // queue re-scanning, and there is no next pass to hold out for.
  runSettle()
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
    // Settle FIRST when it is due, so the state the renderer is about to read
    // is already final and it does not have to be told twice. When the throttle
    // defers it the signal still goes out immediately — the queue's own
    // movement is what the renderer is being told about, and a retrieval that
    // settles a few seconds later raises its own signal then.
    //
    // Inside the timer, not at the call site: `enqueue` runs inside caller
    // transactions (retrieveUnresolvedReferences wraps a whole batch in one),
    // so settling synchronously would nest its writes — including the DELETEs
    // of failed placeholder works — in a transaction that can still roll back,
    // and would repeat the whole pass once per reference in a batch.
    settleThrottled()
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
