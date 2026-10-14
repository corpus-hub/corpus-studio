// The reranker host: a utilityProcess whose only job is to score pairs.
//
// WHY A PROCESS AND NOT A LOCK. `onnxruntime-node` is a native addon, and two
// ONNX sessions living in two V8 ISOLATES of ONE process kill that process:
//
//   FATAL ERROR: HandleScope::HandleScope
//   Entering the V8 API without proper locking in place
//     OrtValueToNapiValue(...) [onnxruntime_binding.node]
//     onnxruntime-node/dist/backend.js:48
//     processImmediate
//
// The app has exactly that shape. The reranker ran inline in main while the
// semantic-search embedder runs in `search/vectorWorker.ts`, a `worker_threads`
// Worker — the SAME process, a DIFFERENT isolate. A JS mutex cannot span them:
// a worker has its own module registry, so it gets its own copy of the lock and
// the two never meet. Measured directly: the reranker alone survives 60 rounds,
// the worker embedder alone survives 60 rounds, and the two together abort
// within about fifteen seconds, every time.
//
// So separation has to be at the PROCESS boundary, where isolates cannot be
// shared by construction. Nothing in main imports `rerank/model` any more; a
// crash in here is a restartable child rather than the window vanishing with no
// error anywhere, which is how this bug presented for days.
//
// It carries NO DATABASE and no gateway credential, exactly like the stage
// host: it is handed a query and passages and answers with numbers.

import { scorePairs } from './model'
import type { RerankHostRequest, RerankHostResponse } from './hostProtocol'

/** The in-flight request, so a cancel can reach the loop between pairs. */
let active: { id: number; abort: AbortController } | null = null

const send = (msg: RerankHostResponse): void => {
  process.parentPort.postMessage(msg)
}

async function run(req: Extract<RerankHostRequest, { kind: 'score' }>): Promise<void> {
  const abort = new AbortController()
  active = { id: req.id, abort }
  try {
    const pairs = await scorePairs(req.query, req.passages, abort.signal)
    send({ kind: 'scored', id: req.id, pairs })
  } catch (err) {
    // The NAME travels with the message. Main rethrows a plain Error, and the
    // callers distinguish "no reranker packaged" from "this pair could not be
    // measured" by what the sentence says — an error class cannot cross a
    // structured-clone boundary, so the name is carried explicitly rather than
    // silently flattened into an indistinguishable failure.
    send({
      kind: 'failed',
      id: req.id,
      name: err instanceof Error ? err.name : 'Error',
      message: err instanceof Error ? err.message : String(err)
    })
  } finally {
    if (active?.id === req.id) active = null
  }
}

process.parentPort.on('message', (e: { data?: RerankHostRequest } | RerankHostRequest) => {
  // `utilityProcess` hands the posted value directly in some Electron versions
  // and wrapped in `{ data }` in others; accept both rather than depending on
  // which one this build ships.
  const msg = ((e as { data?: RerankHostRequest }).data ?? e) as RerankHostRequest
  if (!msg || typeof msg !== 'object') return
  if (msg.kind === 'score') {
    void run(msg)
    return
  }
  if (msg.kind === 'cancel') {
    if (active?.id === msg.id) active.abort.abort()
  }
})

send({ kind: 'ready', pid: process.pid })
