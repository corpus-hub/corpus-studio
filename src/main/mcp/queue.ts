/**
 * The admission queue: how many agent calls may be in progress at once.
 *
 * better-sqlite3 is synchronous on the main thread, so a call is not something
 * that happens "in the background" — it is a window freeze for its duration. And
 * `await new Promise(setImmediate)` between dequeues does NOT yield during a
 * synchronous query; it only spaces the calls out. Saying otherwise would imply
 * a guarantee that is not there. What actually protects the UI is `clampArgs`
 * and the response budget; this queue bounds how many things can be piled up
 * waiting to do it.
 */

/** Total calls in progress. */
const MAX_CONCURRENT = 3
/**
 * Of those, at most one may be a model-calling tool.
 *
 * `LLM_GATE` is a ONE-in-flight mutex with a runtime assertion (not two, whatever
 * the transport memo says), and `LLM_CALL_TIMEOUT_MS` is fifteen minutes. So
 * three model-calling tools admitted at once would consume all three slots while
 * two of them sat *inside* `LLM_GATE.acquire()` making no progress — and every
 * plain read would then be blocked for up to half an hour behind work that is
 * itself blocked. Reserving the other two slots for reads is what keeps the
 * agent able to look at anything at all while one extraction runs.
 */
const MAX_CONCURRENT_SLOW = 1
/** Callers waiting for a slot. Past this, calls are refused rather than pooled. */
const MAX_DEPTH = 32
/** Per-call wall clock. Long enough for an extraction, short enough to notice a hang. */
const CALL_TIMEOUT_MS = 10 * 60_000

export class McpBusyError extends Error {
  readonly retryAfterMs: number
  constructor(retryAfterMs: number) {
    super('the app is busy; too many agent calls are already queued')
    this.name = 'McpBusyError'
    this.retryAfterMs = retryAfterMs
  }
}

export class McpTimeoutError extends Error {
  constructor() {
    super('this call exceeded its time limit; the work may still be running — read the state back before retrying')
    this.name = 'McpTimeoutError'
  }
}

interface Waiter {
  opts: { slow: boolean; mutating: boolean }
  admit: () => void
}

let running = 0
let runningSlow = 0
/**
 * Calls that could be MID-WRITE.
 *
 * Separate from `running` because the quit path reads it, and a polling agent's
 * reads must not be able to hold `closeDb()` off forever — the exact
 * hostage-taking the close guard already refuses to allow for semantic search.
 */
let runningMutating = 0
const waiters: Waiter[] = []

export function mcpInFlight(): number {
  return runningMutating
}

export function mcpInFlightTotal(): number {
  return running
}

export function mcpQueueDepth(): number {
  return waiters.length
}

/** Take a slot. Always paired with `release`, and always SYNCHRONOUS with the decision to admit. */
function reserve(opts: { slow: boolean; mutating: boolean }): void {
  running++
  if (opts.slow) runningSlow++
  if (opts.mutating) runningMutating++
}

function release(opts: { slow: boolean; mutating: boolean }): void {
  running--
  if (opts.slow) runningSlow--
  if (opts.mutating) runningMutating--
}

function canAdmit(opts: { slow: boolean }): boolean {
  return running < MAX_CONCURRENT && (!opts.slow || runningSlow < MAX_CONCURRENT_SLOW)
}

function pump(): void {
  for (let i = 0; i < waiters.length; ) {
    const w = waiters[i]
    if (!canAdmit(w.opts)) {
      // Skip rather than stop: a slow call blocked on its own sub-limit must not
      // hold the reads behind it, which is the whole point of the reservation.
      i++
      continue
    }
    // Reserve HERE, not in the woken continuation. `admit` is a `resolve`, and
    // the awakened `await` resumes a microtask later — so a pump that resolved
    // first and counted later would see the same stale `running` for every
    // waiter and admit the whole backlog at once, cap and all.
    reserve(w.opts)
    waiters.splice(i, 1)
    w.admit()
  }
}

/**
 * Run `fn` under the queue.
 *
 * The slot is released when the PROMISE SETTLES, not when the response is sent.
 * A call that has timed out from the caller's point of view is still executing —
 * releasing its slot at the timeout would mean the cap is not a cap, and a stuck
 * LLM call would leak concurrency one call at a time until nothing is bounded.
 */
export async function admit<T>(
  opts: { slow: boolean; mutating: boolean },
  fn: () => Promise<T>
): Promise<T> {
  if (canAdmit(opts)) {
    reserve(opts)
  } else {
    // Depth is checked only when the call would have to WAIT. Refusing a call
    // that could have run immediately, because unrelated slow work is backed up
    // behind its own sub-limit, would make the queue refuse reads it has room
    // for.
    if (waiters.length >= MAX_DEPTH) throw new McpBusyError(2_000)
    await new Promise<void>((resolve) => {
      waiters.push({ opts, admit: resolve })
    })
    // The slot was reserved by `pump` before it woke us.
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  let work: Promise<T>
  try {
    work = fn()
  } catch (err) {
    // A slot reserved and never released is a slot gone for the life of the
    // process. `fn` is always `async` today, so this cannot fire — which is
    // exactly why it would be missed on the day someone makes it not.
    release(opts)
    pump()
    throw err
  }
  // Settlement, not response: see the note above.
  //
  // `then(f, f)` and not `finally(f)`: `finally` returns a NEW promise that
  // rejects with the same reason and has nothing attached to it, so every
  // ordinary tool failure — a missing row, a schema refusal — would surface as
  // an unhandled rejection in the main process log.
  const onSettled = (): void => {
    release(opts)
    if (timer) clearTimeout(timer)
    pump()
  }
  void work.then(onSettled, onSettled)

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new McpTimeoutError()), CALL_TIMEOUT_MS)
  })

  return Promise.race([work, timeout])
}

/**
 * Wait for everything in flight to finish, up to `ms`.
 *
 * Used by the toggle-off path, which is async and can afford to wait. In-flight
 * calls are NOT aborted: a half-aborted supersede-then-insert leaves rows that
 * nothing owns, which is strictly worse than a late shutdown.
 */
export async function drain(ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (running > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50))
  }
  return running === 0
}
