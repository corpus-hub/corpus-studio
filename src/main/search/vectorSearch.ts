// Main's handle on the vector-search worker.
//
// Owns exactly one worker, started LAZILY on the first query. Lazily because
// the worker loads the embedding model, and an app whose user never searches
// should not pay a second ONNX session for a feature they did not use.

import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { VectorHit, VectorQueryRequest, VectorQueryResponse } from './vectorWorker'

export type { VectorHit } from './vectorWorker'

export interface VectorSearchResult {
  hits: VectorHit[]
  spaceId: number
  /** How the result was ranked — see `VectorQueryResponse.strategy`. */
  strategy: 'index' | 'exhaustive'
}

/**
 * How long a query may take before the caller gives up on it.
 *
 * A search is milliseconds; a minute means the worker is wedged, and a promise
 * that never settles would leave a spinner on screen forever with nothing to
 * click. The worker is replaced on the next query rather than retried in place.
 */
const QUERY_TIMEOUT_MS = 60_000

export class VectorSearch {
  private worker: Worker | null = null
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (r: VectorQueryResponse) => void; reject: (e: Error) => void }
  >()

  constructor(private readonly dbPath: string) {}

  /**
   * The BUILT worker file, or null when it was not bundled.
   *
   * `__dirname` is `out/main` for the built bundle and `src/main/search` under
   * tsx, so both layouts are tried — and in the tsx case the answer is still
   * the file in `out/`, because a worker thread does NOT inherit its parent's
   * module loader: handed a `.ts` path it dies with ERR_UNKNOWN_FILE_EXTENSION.
   * A verification script therefore has to have built once, which `npm run
   * build` already does and which is cheaper than teaching every entry point to
   * register a loader.
   *
   * Null is turned into a thrown error by `ensureWorker`, which reaches the
   * caller as `SemanticSearchResultDTO.error` and is shown as a sentence: a
   * build with no worker cannot answer, and a silent empty result would read as
   * "the corpus holds nothing on this".
   */
  private entryPath(): string | null {
    const candidates = [
      join(__dirname, 'vectorWorker.js'),
      join(__dirname, 'search', 'vectorWorker.js'),
      // Running from source (tsx, a verify script): the built bundle sits at
      // <repo>/out/main, and __dirname is <repo>/src/main/search.
      join(__dirname, '..', '..', '..', 'out', 'main', 'vectorWorker.js')
    ]
    return candidates.find((p) => existsSync(p)) ?? null
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const entry = this.entryPath()
    if (!entry) {
      throw new Error(
        'the vector search worker was not bundled in this build (run `npm run build`)'
      )
    }
    const worker = new Worker(entry, { workerData: { dbPath: this.dbPath } })
    worker.on('message', (msg: VectorQueryResponse) => {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      p.resolve(msg)
    })
    const fail = (err: Error): void => {
      // Every outstanding query belongs to a worker that is gone. Left pending
      // they would hold their callers forever, and a later reply keyed on a
      // reused id would resolve the wrong one.
      for (const [, p] of this.pending) p.reject(err)
      this.pending.clear()
      this.worker = null
    }
    worker.on('error', fail)
    worker.on('exit', (code) => {
      if (code !== 0) fail(new Error(`the vector search worker exited with code ${code}`))
      else this.worker = null
    })
    this.worker = worker
    return worker
  }

  async query(text: string, k: number, workIds?: number[]): Promise<VectorSearchResult> {
    const worker = this.ensureWorker()
    const id = this.nextId++
    const res = await new Promise<VectorQueryResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return
        reject(new Error(`vector search did not answer within ${QUERY_TIMEOUT_MS / 1000}s`))
      }, QUERY_TIMEOUT_MS)
      // Unref'd: a pending search must never be the reason the app cannot quit.
      timer.unref?.()
      worker.postMessage({ id, text, k, workIds } satisfies VectorQueryRequest)
    })
    if (!res.ok) throw new Error(res.error ?? 'vector search failed')
    // A REPLY WITH NO STRATEGY IS A FAULT, not an exhaustive scan. Defaulting it
    // would make this the second place in the stack that answers "which path
    // ran" with a guess, and a guess presented as a measurement is the failure
    // the two-value strategy replaced a boolean to prevent.
    if (res.strategy !== 'index' && res.strategy !== 'exhaustive') {
      throw new Error(
        `the vector worker answered without saying how it ranked (strategy=${String(res.strategy)})`
      )
    }
    return { hits: res.hits ?? [], spaceId: res.spaceId ?? 0, strategy: res.strategy }
  }

  /** Stop the worker. Safe to call twice, and safe when it never started. */
  async shutdown(): Promise<void> {
    const worker = this.worker
    this.worker = null
    if (!worker) return
    worker.postMessage({ kind: 'shutdown' })
    // A worker holding a read-only handle cannot corrupt anything by being
    // terminated, so a wedged one is not waited on indefinitely at quit.
    await Promise.race([
      new Promise<void>((r) => worker.once('exit', () => r())),
      new Promise<void>((r) => setTimeout(r, 2000))
    ])
    await worker.terminate()
  }
}
