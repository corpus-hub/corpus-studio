// The vector-search worker: embedding a query and running k-NN, OFF the thread
// that draws the window.
//
// A `worker_threads` Worker rather than a `utilityProcess`, and the reason is
// the opposite of the host pool's. That pool needs `kill()`, because a wedged
// OCR page cannot be interrupted any other way. A search is milliseconds and is
// never wedged; what it needs is a DATABASE, and a utilityProcess deliberately
// has none. A worker thread can open its own connection.
//
// It is READ-ONLY, and that is structural rather than a convention: the
// connection is opened `readonly: true`, so a bug here cannot write to the file
// main is writing to. Main stays the single writer.
//
// Why it is off the main thread at all: better-sqlite3 is synchronous, so a
// k-NN over the corpus plus an ONNX forward pass for the query both run to
// completion before anything else happens. Research measured a 115 ms freeze at
// the 3000-work stress scale — a visibly janky search box.

import { parentPort, workerData } from 'node:worker_threads'
import Database from 'better-sqlite3'
import { loadSqliteVec } from '../db/sqliteVec'
import { embedTexts, disposeExtractor } from '../embedding/model'
import { resolveEmbeddingIdentity } from '../embedding/space'

export interface VectorQueryRequest {
  id: number
  text: string
  k: number
  /** Restrict to these works. Empty = the whole corpus. */
  workIds?: number[]
}

export interface VectorHit {
  chunkId: number
  workId: number
  documentId: number
  page: number | null
  section: string
  text: string
  /** Cosine SIMILARITY in [-1, 1]; higher is nearer. */
  score: number
  /** True when the chunk was too short, or truncated, to be fully trusted. */
  lowConfidence: boolean
}

export interface VectorQueryResponse {
  id: number
  ok: boolean
  error?: string
  hits?: VectorHit[]
  /** Which space answered. A caller comparing two result sets must check it. */
  spaceId?: number
  /**
   * How this result was ranked.
   *
   * `index` — the space's `vec0` k-NN.
   * `exhaustive` — every vector in scope was scored exactly. Two conditions
   *   choose it and both are accuracy arguments: a NARROW scope, which the
   *   global index cannot rank reliably (see `EXHAUSTIVE_SCAN_MAX_CHUNKS`), and
   *   an UNNORMALISED space at ANY scope, where vec0's L2 distance is not a
   *   cosine. So a corpus-wide `exhaustive` is the second condition, not a
   *   shortfall.
   *
   * Two VALUES rather than a boolean, because "scanned a single paper by
   * design" and "the index is missing" are different facts and a caller that
   * cannot tell them apart will report the first as the second.
   */
  strategy?: 'index' | 'exhaustive'
}

interface WorkerData {
  dbPath: string
}

const { dbPath } = workerData as WorkerData

const db = new Database(dbPath, { readonly: true })
db.pragma('busy_timeout = 5000')

// Throws, taking the worker down with an `error` event that the parent turns
// into a failed query naming the extension. A worker that came up without it
// would answer every search by scanning the entire corpus instead.
loadSqliteVec(db)

interface SpaceRow {
  id: number
  dims: number
  vec_table: string
  config_hash: string
  query_prefix: string
  normalized: number
}

function activeSpaceRow(): SpaceRow | null {
  return (
    (db
      .prepare(
        `SELECT id, dims, vec_table, config_hash, query_prefix, normalized
           FROM embedding_space WHERE status = 'active'`
      )
      .get() as SpaceRow | undefined) ?? null
  )
}

/**
 * The cosine between a stored vector and the query.
 *
 * The blob is COPIED into an aligned Float32Array rather than viewed in place.
 * better-sqlite3 hands back Buffers cut from a shared pool, so `byteOffset` is
 * not guaranteed to be a multiple of 4 and a `new Float32Array(buf.buffer,
 * offset, n)` view throws a RangeError on exactly the rows that happen to land
 * badly — an intermittent failure that would look like corrupt data.
 *
 * Divided by both norms rather than assuming unit vectors: `normalized` is a
 * per-space property that CAN be false, and an unnormalised space would
 * otherwise rank by magnitude while looking like it ranked by similarity. For
 * the normalised case the divisor is 1 and this costs nothing that matters.
 */
function cosine(blob: Buffer, dims: number, query: Float32Array): number {
  const vec = new Float32Array(dims)
  for (let i = 0; i < dims; i++) vec[i] = blob.readFloatLE(i * 4)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < dims; i++) {
    dot += vec[i] * query[i]
    na += vec[i] * vec[i]
    nb += query[i] * query[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom > 0 ? dot / denom : 0
}

/**
 * Below this many in-scope chunks, a scoped search scans rather than asking the
 * index.
 *
 * Sized so a single paper — tens of chunks, occasionally a few hundred for a
 * thesis — always scans. Above it the scope is broad enough that the index's
 * global ranking plus the over-fetch window is a good approximation, and a scan
 * would be the slow path for no accuracy gained.
 */
const EXHAUSTIVE_SCAN_MAX_CHUNKS = 2000

/**
 * Score EVERY vector in scope, exactly.
 *
 * The accurate path, not the fallback one: it divides by both norms (so an
 * unnormalised space ranks by similarity rather than by magnitude) and it
 * cannot drop a row for sitting outside the library's global top-N.
 */
function exhaustiveScan(
  spaceId: number,
  dims: number,
  query: Float32Array,
  k: number,
  workIds: number[]
): Array<{ chunk_id: number; score: number }> {
  const filter = workIds.length > 0 ? `AND c.work_id IN (${workIds.map(() => '?').join(',')})` : ''
  const rows = db
    .prepare(
      `SELECT c.id AS chunk_id, c.vector AS blob FROM chunk c WHERE c.space_id = ? ${filter}`
    )
    .all(spaceId, ...workIds) as Array<{ chunk_id: number; blob: Buffer }>
  const scored = rows.map((r) => ({ chunk_id: r.chunk_id, score: cosine(r.blob, dims, query) }))
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, k)
}

async function handle(req: VectorQueryRequest): Promise<VectorQueryResponse> {
  const space = activeSpaceRow()
  if (!space) {
    return { id: req.id, ok: false, error: 'no active embedding space; nothing has been embedded' }
  }

  const identity = resolveEmbeddingIdentity()
  if (!identity) {
    return { id: req.id, ok: false, error: 'no embedding model is packaged in this build' }
  }

  // The QUERY side of the prefix, which for some families differs from the
  // document side. Applying the wrong one costs retrieval quality silently, so
  // it comes from the space rather than from this call site — and the space is
  // the one that WROTE the vectors we are about to compare against.
  const { vectors } = await embedTexts(identity, [req.text], 'query')
  const queryVec = new Float32Array(
    vectors[0].buffer,
    vectors[0].byteOffset,
    vectors[0].length / 4
  )

  if (queryVec.length !== space.dims) {
    // REJECTED, not compared. A cosine between two spaces is a number rather
    // than an error, and returning it would be a ranked list of noise that
    // looks exactly like a ranked list of results.
    return {
      id: req.id,
      ok: false,
      error:
        `the packaged model produces ${queryVec.length}-dimensional vectors but the active ` +
        `space is ${space.dims}-dimensional — re-embed before searching`
    }
  }

  const workIds = req.workIds ?? []
  let ranked: Array<{ chunk_id: number; score: number }>
  let strategy: 'index' | 'exhaustive' = 'exhaustive'

  // sqlite-vec is loaded — the worker would not have started otherwise — so an
  // active space with no `vec0` table is a corpus that was embedded without one
  // and would silently scan the whole library on every query. Said out loud,
  // with the remedy, rather than absorbed.
  const haveVecTable =
    space.vec_table !== '' &&
    db.prepare(`SELECT name FROM sqlite_master WHERE name = ?`).get(space.vec_table) !== undefined
  if (!haveVecTable) {
    return {
      id: req.id,
      ok: false,
      error:
        `embedding space ${space.id} has no vector index (${space.vec_table || 'unnamed'}), so ` +
        'every search would scan the whole corpus — re-run the embed stage to rebuild it'
    }
  }

  // vec0 recovers a true cosine from its L2 distance ONLY for unit vectors
  // (d² = 2 − 2·cos). An unnormalised space would be silently mis-scored, so it
  // is scored exhaustively instead, dividing by both norms. Correct and slower
  // beats fast and wrong.
  // A NARROW scope is scanned exhaustively even when the index is available.
  //
  // vec0 ranks the whole space and the work filter is applied to its answer, so
  // a scope holding few chunks can be missed entirely: every one of a paper's
  // passages may sit outside the library's global top-N while still being the
  // best answer *in that paper*. Over-fetching only widens the window — it
  // cannot close it — and the surface asking a one-paper question then prints
  // "no passage in this paper came close", which is a confident claim built on
  // discarded rows rather than on a comparison.
  //
  // Scanning them instead is exact and cheap precisely BECAUSE the scope is
  // narrow: a paper is tens of vectors, and the cost is bounded by the same
  // count that makes the index unreliable here. The threshold is on chunks, not
  // on how many works were named, because ten short papers are less work than
  // one long one.
  const scopedChunks =
    workIds.length > 0
      ? (
          db
            .prepare(
              `SELECT COUNT(*) AS c FROM chunk
                WHERE space_id = ? AND work_id IN (${workIds.map(() => '?').join(',')})`
            )
            .get(space.id, ...workIds) as { c: number }
        ).c
      : Infinity
  const exhaustive = scopedChunks <= EXHAUSTIVE_SCAN_MAX_CHUNKS

  if (space.normalized === 1 && !exhaustive) {
    // `k` must be a bound parameter on the vec0 constraint, and the ids come
    // back as BigInt under safeIntegers — which is mandatory, because
    // better-sqlite3 binds a plain number to a vec0 INTEGER column as a float
    // and the match silently returns nothing.
    //
    // OVER-FETCHED when the search is scoped to particular works. vec0 ranks
    // the WHOLE space and the work filter is applied afterwards, so asking for
    // exactly k and then filtering routinely returns two hits for a k of
    // twenty — a short list that looks like "the corpus holds little on this"
    // rather than "we threw most of the answer away". The ceiling stops a
    // large scope from degenerating into a full scan; a scope small enough for
    // that ceiling to still lose rows took the exhaustive path above.
    const fetchK = workIds.length > 0 ? Math.min(req.k * 20, 1000) : req.k
    const stmt = db.prepare(
      `SELECT chunk_id, distance FROM ${space.vec_table}
        WHERE v MATCH ? AND k = ? ORDER BY distance`
    )
    stmt.safeIntegers(true)
    const raw = stmt.all(
      Buffer.from(queryVec.buffer, queryVec.byteOffset, space.dims * 4),
      BigInt(fetchK)
    ) as Array<{ chunk_id: bigint; distance: number }>
    ranked = raw.map((r) => ({
      chunk_id: Number(r.chunk_id),
      score: 1 - (r.distance * r.distance) / 2
    }))
    strategy = 'index'
    if (workIds.length > 0) {
      const allowed = new Set(workIds)
      const kept = db.prepare(
        `SELECT id, work_id FROM chunk WHERE id IN (${ranked.map(() => '?').join(',') || 'NULL'})`
      ).all(...ranked.map((r) => r.chunk_id)) as Array<{ id: number; work_id: number }>
      const keep = new Set(kept.filter((r) => allowed.has(r.work_id)).map((r) => r.id))
      ranked = ranked.filter((r) => keep.has(r.chunk_id)).slice(0, req.k)
    }
  } else {
    ranked = exhaustiveScan(space.id, space.dims, queryVec, req.k, workIds)
  }

  if (ranked.length === 0) return { id: req.id, ok: true, hits: [], spaceId: space.id, strategy }

  const rows = db
    .prepare(
      `SELECT id, work_id, document_id, page, section, text, low_confidence, truncated
         FROM chunk WHERE id IN (${ranked.map(() => '?').join(',')})`
    )
    .all(...ranked.map((r) => r.chunk_id)) as Array<{
    id: number
    work_id: number
    document_id: number
    page: number | null
    section: string
    text: string
    low_confidence: number
    truncated: number
  }>
  const byId = new Map(rows.map((r) => [r.id, r]))

  const hits: VectorHit[] = []
  for (const r of ranked) {
    const row = byId.get(r.chunk_id)
    // A ranked id with no chunk is an orphan vector. Skipped rather than
    // reported as a hit with empty text: `sweepVectorOrphans` removes these at
    // startup, and between sweeps a search must not invent a result.
    if (!row) continue
    hits.push({
      chunkId: row.id,
      workId: row.work_id,
      documentId: row.document_id,
      page: row.page,
      section: row.section,
      text: row.text,
      score: r.score,
      lowConfidence: row.low_confidence === 1 || row.truncated === 1
    })
  }
  return { id: req.id, ok: true, hits, spaceId: space.id, strategy }
}

parentPort?.on('message', (msg: VectorQueryRequest | { kind: 'shutdown' }) => {
  if ('kind' in msg && msg.kind === 'shutdown') {
    void disposeExtractor().finally(() => {
      db.close()
      process.exit(0)
    })
    return
  }
  const req = msg as VectorQueryRequest
  void handle(req)
    .then((res) => parentPort?.postMessage(res))
    .catch((err: Error) =>
      parentPort?.postMessage({ id: req.id, ok: false, error: err.message } satisfies VectorQueryResponse)
    )
})
