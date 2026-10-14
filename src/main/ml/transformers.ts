// The ONE place `@huggingface/transformers` is imported, so the offline
// settings exist in exactly one place and cannot drift between the models that
// use them.
//
// The model ROOT IS AN ARGUMENT, and that is the whole point of this module.
// `env.localModelPath` is a mutable global shared by every model in the
// process, so a caller that sets it and a caller that forgets are
// indistinguishable until one of them reads from the other's tree — and with
// `local_files_only` on, the symptom is a missing-file error naming a path
// nobody expected rather than an obvious bug. Asking for the root at the call
// makes forgetting impossible.
//
// THREE SETTINGS ARE THE WHOLE OFFLINE STORY, and none of them is optional:
//
//   env.allowRemoteModels = false   any missing file becomes a hard error
//                                   naming the path, instead of a silent fetch
//                                   from huggingface.co on a user's machine
//   env.allowLocalModels  = true    read from disk at all
//   env.localModelPath    = <dir>   the ROOT above `<org>/<model>`; the library
//                                   appends the rest itself
//
// plus `local_files_only: true` at the call site, which closes the same door
// from the other side. `getModelFile` only reaches the network after passing
// BOTH checks, so either alone is sufficient and both together is deliberate:
// deleting one is otherwise a green build that phones home in the field.
//
// This module must NEVER be imported from the renderer. `@huggingface/
// transformers` statically imports both onnxruntime-node and
// onnxruntime-web/webgpu; the package's `node` export condition resolves the
// Node build in main and in a utilityProcess, but a stray renderer import
// resolves the WEB build, which needs `wasm-unsafe-eval` and fetches its wasm
// from a CDN. `verify:offline` bans that import in renderer source.

type Transformers = typeof import('@huggingface/transformers')

/** The library, pointed at `root` as its local model tree. */
export async function transformersFor(root: string): Promise<Transformers> {
  const t = await import('@huggingface/transformers')
  t.env.allowRemoteModels = false
  t.env.allowLocalModels = true
  t.env.localModelPath = root
  return t
}

/**
 * Session options every model in this process is built with.
 *
 * ONE INTRA-OP THREAD, and that is a crash fix rather than a tuning choice.
 * Serialising the CALLS was not enough: `onnxruntime-node` runs its own thread
 * pool — sized to the host's core count, twelve here — and `backend.js` invokes
 * the synchronous native `run()` from inside a `setImmediate`. Those worker
 * threads re-enter the V8 API without holding the isolate lock, which the
 * engine answers by killing the process:
 *
 *   FATAL ERROR: HandleScope::HandleScope
 *   Entering the V8 API without proper locking in place
 *     1: onnxruntime-node/dist/backend.js:48
 *     2: processImmediate
 *
 * No JS-side gate can prevent that, because the offending entry is not made
 * from JS. Holding the runtime to a single thread removes the second thread
 * that could enter, which is the only lever available from this side.
 *
 * The cost is bounded and already paid: `runExclusive` below means one
 * inference runs at a time anyway, so the pool's parallelism was never
 * shortening the queue — it was only widening the window in which two threads
 * could touch the isolate at once.
 */
export const ML_SESSION_OPTIONS = { intraOpNumThreads: 1, interOpNumThreads: 1 } as const

/**
 * ONE inference at a time, across every model this process runs.
 *
 * IT DOES NOT SPAN ISOLATES, and that limit is why the models now live in
 * separate processes. A `worker_threads` worker gets its OWN module registry
 * and therefore its own copy of `mlTurn`, so the reranker in main and the
 * embedder in the search worker each held a lock the other could not see and
 * entered the runtime together anyway. Measured: either alone survives 60
 * rounds; the two together abort in about fifteen seconds. Separation had to
 * move to the process boundary — see `rerank/hostEntry.ts`. This gate remains
 * for the models that share ONE isolate.
 *
 * `onnxruntime-node` is a native addon reached from the main process, and both
 * models here say the same thing in their own comments: a call yields ZERO
 * event-loop ticks and holds the JS thread until it returns. Two of them
 * entered together and killed the app outright —
 *
 *   Fatal error in V8: v8::HandleScope::CreateHandle()
 *   Cannot create a handle without a HandleScope
 *
 * — with `reference-abstracts` (the reranker) and `embed` (the embedder) both
 * in flight, which the queue plans in parallel because nothing stopped it. The
 * process dies inside the engine, so there is no exception to catch and nothing
 * in the app's own log: it simply vanishes.
 *
 * SERIALISED HERE rather than in each caller, for the reason this module exists
 * at all: it is the one place the library is reached, so a model added later
 * cannot forget to take the lock. And ACROSS models, not per model — two
 * different networks in one runtime is exactly the case that crashed.
 *
 * This costs no throughput that was real. A call already occupies the whole
 * thread, so a second one was never running alongside the first; it was only
 * interleaving badly enough to corrupt the runtime's handle state.
 */
let mlTurn: Promise<unknown> = Promise.resolve()

export function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  // The queue is the tail of the chain, and every waiter appends to it. The
  // `catch` keeps a rejected call from poisoning the ones behind it — the
  // rejection still reaches ITS caller through the promise returned below.
  const mine = mlTurn.then(fn, fn)
  mlTurn = mine.catch(() => undefined)
  return mine
}
