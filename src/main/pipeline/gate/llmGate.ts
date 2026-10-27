// The LLM gate: this process ISSUES at most `capacity` LLM requests at a time,
// across the whole app.
//
// ACROSS THE WHOLE APP, and that is the load-bearing half. The gate is a module
// singleton, so the limit is absolute rather than per project or per paper —
// two projects being processed at once share it. A per-project allowance would
// mean two projects cost twice as much and hit a rate limit twice as fast,
// which is the thing a limit exists to prevent.
//
// The capacity defaults to 1 and the user may raise it (Settings → Queue). One
// is the conservative default because this is the setting that spends money and
// meets a 429; raising it is a deliberate act.
//
// "Issues", precisely — not "N generations are running upstream". The gateway
// guards its own abort on `!ctx.req.complete`, already true for a fully-read
// non-streaming body, so aborting a call (on cancel, or when the wall-clock cap
// fires) frees OUR slot while the model keeps generating. In that window
// `peak()` honestly reads the capacity while one more generation is alive at
// Anthropic. That is a property of the gateway rather than a flaw here, but the
// guarantee this module can keep is about requests WE start, and phrasing it as
// "N requests in flight anywhere" would promise something it does not control.
//
// Not a counter. A semaphore that increments on release and decrements in the
// woken waiter has a window between those two steps in which the count reads as
// free while the waiter has not yet taken it, so a fresh `acquire()` takes the
// fast path and one holder too many exists. So a slot is a TOKEN handed
// directly from the releaser to the head waiter, membership is a set of live
// tokens, and there is no count to desynchronise.
//
// Four independent barriers stop a future stage author bypassing it (§6.2 of
// the design). Three are live in this wave:
//   - `StageContext` exposes `ctx.llm` and no network primitive at all;
//   - a build gate bans fetch/undici/node:http/axios and any read of
//     CORPUS_LLM_* under src/main/pipeline/stages/**;
//   - the `inFlight === 0` assertion below, evaluated INSIDE the critical
//     section rather than on entry (asserting on entry fires on the very first
//     fan-out, where a second call waiting is precisely the point).
// The fourth (a host process spawned without the credential in its env)
// arrives with the host pool; until then main is the only process in play and
// this module is the only code that reads the gateway credential.

/**
 * Wall-clock cap on a single call.
 *
 * `headersTimeout: 0` alone is a deadlock: the gateway container force-exits
 * ~15 s into shutdown, killing in-flight requests, and with no client timeout
 * the socket hangs and a size-1 mutex is never released — every LLM job in the
 * app stops with no error surface.
 */
export const LLM_CALL_TIMEOUT_MS = 15 * 60 * 1000

export class LlmGateAbortError extends Error {
  constructor() {
    super('LLM call aborted while waiting for the gate')
    this.name = 'LlmGateAbortError'
  }
}

export class LlmGateTimeoutError extends Error {
  constructor(ms: number) {
    super(`LLM call exceeded the ${Math.round(ms / 1000)}s wall-clock cap`)
    this.name = 'LlmGateTimeoutError'
  }
}

interface Waiter {
  resolve: (token: symbol) => void
  reject: (err: Error) => void
  /**
   * Set SYNCHRONOUSLY by the abort path, before its rejection is delivered.
   *
   * Without it `release()` can hand the slot to a waiter whose promise has
   * already settled: `resolve()` on a settled promise is a silent no-op, so the
   * slot is held by nobody, forever, and every subsequent call queues behind a
   * holder that does not exist.
   */
  settled: boolean
  detach: () => void
}

export class LlmGate {
  /**
   * The tokens currently holding a slot.
   *
   * A SET of live tokens rather than a count, for the reason the header gives:
   * a counter that increments on release and decrements in the woken waiter has
   * a window in which it reads as free while the waiter has not yet taken it,
   * so a fresh `acquire()` takes the fast path and one too many holders exist.
   * Membership is decided by the token itself, so there is nothing to
   * desynchronise. A stale release — the wall-clock cap force-releasing, then
   * the original call's `finally` — is a token that is no longer in the set,
   * and deleting it a second time is a no-op.
   */
  private readonly owners = new Set<symbol>()
  /**
   * How many may hold at once. Settable at runtime, because the user chooses it
   * in Settings and a value fixed at construction would need a relaunch.
   *
   * Lowering it never interrupts a call already in flight: the surplus holders
   * finish normally and the gate simply admits nobody new until it is back
   * under the limit.
   */
  private capacity = 1
  private readonly waiters: Waiter[] = []
  /**
   * Calls executing inside the critical section. Asserted to be 0 at the moment
   * a holder enters it — this is the runtime proof of the one-in-flight rule.
   */
  private inFlight = 0
  private peakInFlight = 0
  private grantOrder: number[] = []

  /** How many callers are waiting for a slot. Diagnostics only. */
  waiting(): number {
    return this.waiters.length
  }

  /**
   * Set how many calls may be in flight at once.
   *
   * Raising it wakes waiters immediately, so a user who increases the limit
   * mid-run does not have to wait for the current call to finish before the
   * extra capacity is used.
   */
  setCapacity(n: number): void {
    if (!Number.isInteger(n) || n < 1) throw new Error(`LLM capacity must be >= 1, got ${n}`)
    this.capacity = n
    while (this.owners.size < this.capacity && this.promote()) {
      /* admit waiters up to the new limit */
    }
  }

  capacityNow(): number {
    return this.capacity
  }

  /** The most concurrent calls ever observed. Never exceeds the capacity. */
  peak(): number {
    return this.peakInFlight
  }

  /** The order tickets were granted in, for asserting FIFO in tests. */
  grants(): readonly number[] {
    return this.grantOrder
  }

  resetStats(): void {
    this.peakInFlight = 0
    this.grantOrder = []
  }

  private acquire(signal?: AbortSignal): Promise<symbol> {
    if (signal?.aborted) return Promise.reject(new LlmGateAbortError())
    if (this.owners.size < this.capacity) {
      const token = Symbol('llm-slot')
      this.owners.add(token)
      return Promise.resolve(token)
    }
    return new Promise<symbol>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        settled: false,
        detach: () => {
          /* replaced below */
        }
      }
      const onAbort = (): void => {
        // Splice out of the FIFO on abort. A cancelled job that never got the
        // slot must not later be handed one and hold it until someone notices
        // its host is gone.
        waiter.settled = true
        const i = this.waiters.indexOf(waiter)
        if (i >= 0) this.waiters.splice(i, 1)
        reject(new LlmGateAbortError())
      }
      waiter.detach = () => signal?.removeEventListener('abort', onAbort)
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }

  /**
   * Hand one free slot to the head of the queue. True if anyone took it.
   *
   * Loops rather than shifting once: a waiter can have settled (aborted)
   * between joining the queue and reaching its head, and handing the slot to a
   * settled promise loses it silently.
   */
  private promote(): boolean {
    while (this.waiters.length > 0) {
      const next = this.waiters.shift() as Waiter
      if (next.settled) continue
      next.detach()
      const token = Symbol('llm-slot')
      this.owners.add(token)
      next.resolve(token)
      return true
    }
    return false
  }

  private release(token: symbol): void {
    // A stale token is a release from a caller that already lost its slot — the
    // wall-clock cap force-releases, and the original call's `finally` then
    // releases again. Ignoring it is what stops the cap CREATING the
    // concurrency it exists to prevent.
    if (!this.owners.delete(token)) return
    // Only if there is still room. The capacity can have been LOWERED while
    // this call was in flight, and promoting unconditionally would keep the
    // surplus alive forever — every release handing the slot straight on.
    if (this.owners.size < this.capacity) this.promote()
  }

  /**
   * Run `fn` holding the single slot.
   *
   * `ticket` is an opaque caller id recorded in grant order, so a test can
   * assert the queue is FIFO rather than merely bounded.
   */
  async run<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    opts: { signal?: AbortSignal; ticket?: number } = {}
  ): Promise<T> {
    const token = await this.acquire(opts.signal)
    let timer: ReturnType<typeof setTimeout> | null = null
    // Aborting the REQUEST is the point of the cap, not merely giving up on it.
    // Releasing the slot while the socket is still open would hand the next
    // waiter a turn alongside a call that is still upstream — the cap would
    // manufacture exactly the concurrency it exists to prevent.
    const capAbort = new AbortController()
    const relayOuter = (): void => capAbort.abort()
    opts.signal?.addEventListener('abort', relayOuter, { once: true })
    try {
      // INSIDE the critical section, after the slot is held. On entry this
      // would fire on the normal fan-out path, where a second call waiting is
      // the FIFO doing its job.
      //
      // Against the CAPACITY, not against zero. The gate admits as many as the
      // user allows, so the invariant is "never more than were permitted" —
      // which is still the runtime proof that the gate is doing its job, and
      // still catches a caller that reached the network around it.
      if (this.inFlight >= this.capacity) {
        throw new Error(
          `LLM gate invariant violated: ${this.inFlight} call(s) already in flight with a ` +
            `capacity of ${this.capacity}`
        )
      }
      this.inFlight++
      if (this.inFlight > this.peakInFlight) this.peakInFlight = this.inFlight
      if (opts.ticket !== undefined) this.grantOrder.push(opts.ticket)

      const capped = new Promise<never>((_r, reject) => {
        timer = setTimeout(() => {
          capAbort.abort()
          reject(new LlmGateTimeoutError(LLM_CALL_TIMEOUT_MS))
        }, LLM_CALL_TIMEOUT_MS)
      })
      return await Promise.race([fn(capAbort.signal), capped])
    } finally {
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', relayOuter)
      // Decrement BEFORE handing the slot on: `release()` resolves the next
      // waiter, which asserts against this counter, and it must not see the
      // outgoing holder.
      this.inFlight--
      this.release(token)
    }
  }
}

/**
 * The process-wide gate. A module singleton and not an injectable, because
 * "exactly one in flight PROCESS-WIDE" is not a property a second instance can
 * have — passing it around would let a caller construct their own.
 */
export const LLM_GATE = new LlmGate()

/**
 * ONE PDF RETRIEVAL AT A TIME, process-wide.
 *
 * Retrieval is filed under the LOCAL budget because it does not call the model,
 * but it is not local work at all: it goes out to Unpaywall, OpenAlex and a
 * publisher or repository, through one browser extension and one native-message
 * bridge. The local budget defaults to 2 so a second paper's OCR can overlap the
 * first's — sound for CPU work, and wrong here, because the two "local" slots
 * become two simultaneous callers hitting the same third-party APIs.
 *
 * MEASURED, and it is why this exists: eight papers re-queued together all
 * settled within ONE SECOND with `TypeError: Failed to fetch` and
 * `TimeoutError: signal timed out` from Unpaywall and OpenAlex. Every one of
 * those DOIs then fetched perfectly when asked for on its own, seconds later —
 * so the papers were retrievable and the burst was the whole fault. A user
 * reading that log sees "no source produced a valid pdf" and concludes the
 * paper is unavailable.
 *
 * A SEPARATE gate rather than lowering the local budget to 1: that would
 * serialise OCR, text extraction and embedding as well, halving throughput on
 * exactly the CPU work the second slot was added for. The two limits answer
 * different questions, which is the same argument `QUEUE_DEFAULTS` already makes
 * for splitting AI work from local work — applied one level further down.
 *
 * Capacity is deliberately NOT user-settable. It is not a performance dial: a
 * politeness limit on somebody else's free API is the app's obligation, not a
 * preference, and the failure it prevents reads as "this paper does not exist".
 */
export const RETRIEVAL_GATE = new LlmGate()
