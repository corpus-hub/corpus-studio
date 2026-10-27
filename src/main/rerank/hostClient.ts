// `scorePairs`, as main is allowed to call it: over a pipe, never in-process.
//
// The whole reason is in `hostEntry.ts` — an ONNX session in main plus the ONNX
// session already living in the search worker thread is a V8 fatal, and no
// JS-side lock can span two isolates. This module is the ONLY way the pipeline
// reaches the reranker, and `verify:offline` bans importing `rerank/model` from
// anywhere in main outside this file and the host entry.
//
// ONE HOST, spawned lazily and reused. Loading the int8 session costs about a
// second, so a per-call process would dominate a 21-paper sweep; and one host
// means one ONNX session in one isolate, which is the property being bought.
//
// REQUESTS ARE SERIALISED. The host runs one `scorePairs` at a time anyway (a
// call yields no event-loop tick), so overlapping them would only queue inside
// the child while making a cancel ambiguous about which request it meant.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { UtilityProcess } from 'electron'
import { hostEnv } from '../pipeline/host/protocol'
import type { PairScore } from './model'
import type { RerankHostRequest, RerankHostResponse } from './hostProtocol'

/** How long a cold host may take to load its session before we give up. */
const READY_TIMEOUT_MS = 30_000

/**
 * How long a posted request may sit unanswered before the host is presumed
 * wedged and killed.
 *
 * Killing IS the settle — the same answer the READY path gives a start that
 * never posts: the child's 'exit' fails every pending request and the next
 * caller spawns a fresh host. Without it, a host stuck inside a native call
 * (the exact case a timeout exists for) answers neither 'scored' nor 'failed'
 * and never exits, so its pending entry holds the serialisation chain — and
 * every later search's rerank — forever, one never-settling link per query.
 *
 * The bound is far above anything a healthy host needs: the search leg caps
 * itself and aborts, a cancelled request is answered between pairs (one pair
 * measures ~250 ms), and every other caller scores one pair — so the watchdog
 * only ever fires on a host that cannot answer at all.
 */
const SCORE_WATCHDOG_MS = 30_000
/** How long a cancelled request may take to answer before the host is killed. */
const CANCEL_GRACE_MS = 2_000

interface Pending {
  resolve: (pairs: PairScore[]) => void
  reject: (err: Error) => void
}

let proc: UtilityProcess | null = null
let starting: Promise<UtilityProcess> | null = null
let nextId = 1
const pending = new Map<number, Pending>()
/** The tail of the request chain — see the serialisation note above. */
let turn: Promise<unknown> = Promise.resolve()
/**
 * Set by {@link shutdownRerankHost}. A dispatch still QUEUED on `turn` runs
 * only after the shutdown has returned — the chain advances one microtask at
 * a time, and a ten-pair search can hold the head of it for seconds — so
 * without this flag each queued dispatch would `ensureHost()` a replacement
 * utilityProcess during app quit. Self-exiting via its parentPort handler,
 * but a host forked on the way down all the same.
 */
let stopped = false

/**
 * Where the built host entry lands.
 *
 * CANDIDATES, not one join, and that is not defensiveness: this module is
 * bundled into a SHARED CHUNK, so its `__dirname` is `out/main/chunks` while
 * the emitted entry sits one level up in `out/main`. A single
 * `join(__dirname, 'rerankHost.js')` therefore resolved to
 * `out/main/chunks/rerankHost.js` and the packaged app failed every score with
 * ERR_MODULE_NOT_FOUND — the same trap `search/vectorSearch.ts` documents, and
 * the same answer. The stage host escapes it only because its path is built in
 * `index.ts`, which is an entry and not a chunk.
 */
function entryPath(): string {
  const candidates = [
    join(__dirname, 'rerankHost.js'),
    join(__dirname, '..', 'rerankHost.js'),
    // Running from source (tsx, a verify script): the built bundle sits at
    // <repo>/out/main.
    join(__dirname, '..', '..', '..', 'out', 'main', 'rerankHost.js')
  ]
  const found = candidates.find((p) => existsSync(p))
  if (!found) {
    throw new Error(
      'the reranker host was not bundled in this build (run `npm run build`), so no ' +
        'reference or paper can be scored'
    )
  }
  return found
}

function payloadOf(e: unknown): RerankHostResponse | null {
  const wrapped = (e as { data?: unknown } | null)?.data
  const raw = wrapped ?? e
  return raw && typeof raw === 'object' ? (raw as RerankHostResponse) : null
}

/**
 * Fail every outstanding request when the host goes away, and forget it.
 *
 * Left pending they would hold their callers forever, and a later reply keyed
 * on a reused id would resolve the wrong one. The stage sees an ordinary
 * failure and retries, which is what a restartable child is for.
 *
 * `starting` is deliberately NOT cleared here. This runs on a child's 'exit',
 * which can fire long after that child died — a READY-timeout kill, for one —
 * and by the time it does, a dispatch queued on the turn chain may already be
 * forking the replacement. Erasing its slot from under it would send the next
 * caller after a SECOND concurrent host, and whichever assigned `proc` last
 * would leave the other unreferenced until quit — the one-host property this
 * module exists for, gone. An attempt clears its own slot on rejection, under
 * an identity check; a successful one retires the slot by publishing `proc`.
 */
function failAll(err: Error): void {
  for (const [, p] of pending) p.reject(err)
  pending.clear()
  proc = null
}

async function ensureHost(): Promise<UtilityProcess> {
  if (proc) return proc
  if (starting) return starting
  const attempt = (async () => {
    const { utilityProcess } = await import('electron')
    const child = utilityProcess.fork(entryPath(), [], {
      env: hostEnv(),
      // 'inherit' for the same reason the stage host uses it: a piped stdio
      // nobody drains fills and blocks the child mid-inference.
      stdio: 'inherit',
      serviceName: 'corpus-rerank-host'
    })
    child.on('message', (e: unknown) => {
      const msg = payloadOf(e)
      if (!msg) return
      if (msg.kind === 'scored') {
        const p = pending.get(msg.id)
        if (!p) return
        pending.delete(msg.id)
        p.resolve(msg.pairs)
        return
      }
      if (msg.kind === 'failed') {
        const p = pending.get(msg.id)
        if (!p) return
        pending.delete(msg.id)
        const err = new Error(msg.message)
        err.name = msg.name
        p.reject(err)
      }
    })
    child.on('exit', () => {
      // Only the published host may be torn down. An exit can fire long
      // after the child died — a READY-timeout kill wedged in a native
      // call, for one — and by then a replacement may be published with
      // requests of its own in `pending`; every entry there necessarily
      // belongs to whichever child ensureHost published (dispatch posts
      // through it and nothing else drains the map wholesale), so a dying
      // child that is no longer `proc` owns none of them. failAll-ing
      // anyway would reject the replacement's live request and unpublish
      // it while it still runs — a leaked second host `shutdownRerankHost`
      // can never reach, and one search's rerank spuriously not run.
      if (proc === child) {
        failAll(new Error('the reranker host exited while a request was in flight'))
      }
    })
    await new Promise<void>((resolve, reject) => {
      const onReady = (e: unknown): void => {
        if (payloadOf(e)?.kind !== 'ready') return
        clearTimeout(timer)
        child.off('message', onReady as never)
        child.off('exit', onExit)
        resolve()
      }
      const onExit = (): void => {
        clearTimeout(timer)
        reject(new Error('the reranker host exited before it was ready'))
      }
      const timer = setTimeout(() => {
        child.off('message', onReady as never)
        child.off('exit', onExit)
        // Killing IS the settle. A host wedged during the onnxruntime import
        // posts neither 'ready' nor 'exit'; left alive it holds an
        // ONNX-capable session forever, and since every dispatch serialises
        // on this module's turn chain, each later search would queue behind a
        // fresh 30 s attempt and leak another process.
        child.kill()
        reject(new Error(`the reranker host did not start within ${READY_TIMEOUT_MS / 1000}s`))
      }, READY_TIMEOUT_MS)
      child.on('message', onReady as never)
      child.once('exit', onExit)
    })
    // Publish the child and retire the slot in the same breath. The slot must
    // not outlive the attempt: failAll (the exit path) clears only `proc`, so
    // a resolved `starting` still holding this child would be handed to a
    // caller the day the child dies — a dead host answered with silence, its
    // request wedged until the watchdog fires on a process that can no longer
    // exit. Callers already awaiting the attempt hold the promise itself.
    proc = child
    starting = null
    return child
  })()
  starting = attempt
  try {
    return await attempt
  } catch (err) {
    // Only the attempt that failed may clear its own slot, and only here:
    // failAll (the exit path) deliberately does not touch `starting`, because
    // by the time a dying child's exit fires, a dispatch queued on the turn
    // chain may already be forking the replacement — clearing unconditionally
    // here would erase that in-flight host, the next caller would fork a
    // second one, and the one-host/one-session property is gone.
    if (starting === attempt) starting = null
    throw err
  }
}

/**
 * Score each passage against the query, in the host process.
 *
 * Signature-compatible with `scorePairs` in `./model` on purpose: the callers
 * changed one import line and nothing else, so the two cannot drift apart in
 * what they promise. An aborted run returns what the host actually took —
 * never a partial array padded with invented scores.
 */
export async function scorePairsHosted(
  query: string,
  passages: readonly string[],
  signal?: AbortSignal
): Promise<PairScore[]> {
  const mine = turn.then(
    () => dispatch(query, passages, signal),
    () => dispatch(query, passages, signal)
  )
  turn = mine.catch(() => undefined)
  return mine
}

async function dispatch(
  query: string,
  passages: readonly string[],
  signal?: AbortSignal
): Promise<PairScore[]> {
  // The stopped check comes FIRST: it is what a dispatch queued behind the
  // in-flight request sees when shutdownRerankHost ran while it waited, and
  // reaching ensureHost() past it would fork a replacement host during quit.
  // [] is the aborted answer's shape — nothing scored, so the stage reports
  // itself as not run.
  if (stopped) return []
  if (signal?.aborted) return []
  const host = await ensureHost()
  // The caller's budget may have elapsed while a cold or restarting host was
  // starting — the pre-start guard above cannot see that far. Returning here
  // keeps a caller that has already shipped its answer from leaving a score
  // request occupying the host's serialisation chain behind it.
  if (signal?.aborted) return []
  const id = nextId++
  const req: RerankHostRequest = { kind: 'score', id, query, passages: [...passages] }

  return new Promise<PairScore[]>((resolve, reject) => {
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const armWatchdog = (ms: number): void => {
      clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        // Killing IS the settle: the 'exit' handler fails every pending
        // request, which rejects this one and frees the serialisation chain
        // for whoever is queued behind it.
        host.kill()
      }, ms)
    }
    const onAbort = (): void => {
      // A cancel, not a kill — not yet. The host checks the signal BETWEEN
      // pairs and answers with the scores it took; killing immediately would
      // throw those away and pay a cold session load on the next request.
      // A cancel that is never answered is a host wedged inside its native
      // call rather than a slow one, and the grace below is what turns that
      // wedge into the restartable-child failure an exit already produces.
      host.postMessage({ kind: 'cancel', id } satisfies RerankHostRequest)
      armWatchdog(CANCEL_GRACE_MS)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const done = (): void => {
      signal?.removeEventListener('abort', onAbort)
      clearTimeout(watchdog)
    }
    pending.set(id, {
      resolve: (pairs) => {
        done()
        resolve(pairs)
      },
      reject: (err) => {
        done()
        reject(err)
      }
    })
    host.postMessage(req)
    armWatchdog(SCORE_WATCHDOG_MS)
  })
}

/**
 * Load the session before the first search needs it.
 *
 * The search stage's timeout is set from WARMED timings, and its window starts
 * when `scorePairsHosted` is called. 'ready' is posted before any model load —
 * loading is lazy, inside the first `scorePairs` — so a host that is merely
 * ready is a host that has not paid the session load, and a warm-up that
 * stopped at 'ready' would leave the shipped first query colder than every
 * query the budget was measured on. One discarded two-pair request makes the
 * load run here, at startup, off any search's budget. Fire-and-forget: a
 * prewarm that cannot start or score is not a startup error — the first real
 * search surfaces the same condition and reports its stage as not run.
 */
export function prewarmRerankHost(): void {
  void ensureHost()
    .then(() => scorePairsHosted('warm', ['one', 'two']))
    .then(
      () => undefined,
      () => undefined
    )
}

/**
 * Stop the host. Called on quit. Also sets the module-level `stopped` flag, so
 * a dispatch queued on the turn chain dies with the shutdown instead of forking
 * a replacement host during quit — the one thing the shutdown alone cannot
 * reach, since it does not wait for the chain to drain.
 */
export function shutdownRerankHost(): void {
  stopped = true
  const held = proc
  proc = null
  starting = null
  failAll(new Error('the reranker host was shut down'))
  held?.kill()
}
