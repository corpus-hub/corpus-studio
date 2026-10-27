// Retrieval benchmark: is hybrid retrieval actually better than the dense-only
// search the app ships today — measured on the USER'S REAL CORPUS, never on
// sample data (hard rule 1: every value here is read from the corpus copy at
// runtime; no domain literal appears in this file).
//
//   ELECTRON_RUN_AS_NODE=1 electron --import tsx scripts/bench-retrieval.ts --stage prepare
//   ELECTRON_RUN_AS_NODE=1 electron --import tsx scripts/bench-retrieval.ts --stage legs
//   ELECTRON_RUN_AS_NODE=1 electron --import tsx scripts/bench-retrieval.ts --stage rerank
//
// Three PROCESSES, on purpose. The legs stage drives the app's real vector
// worker (worker_threads; loads fine under electron-as-node), whose embedder is
// an ONNX session; the rerank stage runs `scorePairs` in-process because the
// app's utilityProcess rerank host cannot fork under electron-as-node — the
// utilityProcess hop the shipped search always waits inside is measured
// SEPARATELY, by a real-electron child (scripts/verify-rerank-host.cjs
// --timing-only) the rerank stage spawns and folds into the report beside the
// in-process numbers. ONNX must never share a process with another ONNX
// session, so the embedder and the reranker each get their own process: the
// legs stage never imports the reranker, the rerank stage never imports the
// vector search. `rrfFuse` and `searchLexical` are pure SQLite/JS and run
// wherever they are needed.
//
// Safety contract for the source database:
//   - it is opened by NOTHING — not by sqlite, not by this script. One byte
//     copy, then the copy is the only file any stage touches.
//   - the copy gate: abort when the source has a NON-EMPTY -wal (unflushed
//     frames — a byte copy would lose committed transactions) or when any
//     process holds the file open. A 0-byte -wal/-shm pair with no holder is a
//     stale artifact of an unclean exit, not a live writer: it is recorded as
//     evidence and the copy proceeds, with a post-copy re-stat proving the
//     source did not change while it was being read. `PRAGMA integrity_check`
//     on the copy is the last line of defence — a torn copy fails it.
//
// Stages write intermediates into tmp/bench-db/ and the rerank stage merges
// everything into tmp/bench-retrieval.json.

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BENCH_DIR = join(ROOT, 'tmp', 'bench-db')
const SOURCE_DB = process.env.CORPUS_BENCH_SOURCE ?? join(homedir(), '.config', 'corpus-studio', 'corpus.sqlite')
const COPY_DB = join(BENCH_DIR, 'corpus.sqlite')
const QUERYSET_JSON = join(BENCH_DIR, 'queryset.json')
const PREPARE_JSON = join(BENCH_DIR, 'prepare-meta.json')
const LEGS_JSON = join(BENCH_DIR, 'legs.json')
const RESULT_JSON = join(ROOT, 'tmp', 'bench-retrieval.json')

const SEED = 42
const N_WORK_QUERIES = 100
const N_TOKEN_PROBES = 20
// The EVALUATION cutoff (Recall@10 / MRR@10) — not the depth the dense leg is
// asked for and not the fusion pool: those are the app's own constants
// (DEFAULT_K, fusionPool(k), RERANK_POOL), imported from
// src/main/search/semantic in the stages, so the measured ranking is the
// ranking the app actually ships rather than a harness-private copy of it.
const K = 10
const MIN_SENTENCE_CHARS = 40
// The shipped search channels bound the query string (QUERY_MAX_LENGTH of
// src/main/ipc/registry/search.ts, imported in stagePrepare below): a longer
// query is rejected by the parse before dispatch, so measuring one would score
// a search the app can never serve. Imported, not copied — the same
// import-don't-duplicate rule the other measured constants follow.

interface BenchQuery {
  qid: number
  kind: 'work-title' | 'work-sentence' | 'rare-token'
  text: string
  goldChunkIds: number[]
  goldWorkIds: number[]
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function seededShuffle<T>(items: T[], rng: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function pctl(values: number[], p: number): number {
  if (values.length === 0) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  const idx = p <= 0.5 ? Math.floor(p * sorted.length) : Math.ceil(p * sorted.length) - 1
  return sorted[Math.min(Math.max(idx, 0), sorted.length - 1)]
}

function round(n: number, digits = 4): number {
  const f = 10 ** digits
  return Math.round(n * f) / f
}

const sentenceSeg = new Intl.Segmenter(undefined, { granularity: 'sentence' })

function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const parts = [...sentenceSeg.segment(flat)].map((s) => s.segment.trim())
  return (parts.find((p) => p.length >= MIN_SENTENCE_CHARS) ?? parts.find((p) => p.length >= 20) ?? parts[0] ?? '').trim()
}

interface RecallMrr {
  recallAt5: number
  recallAt10: number
  mrrAt10: number
}

/** Metrics over gold WORKS: hits are mapped to work ids before comparing. */
function scoreAgainstGold(top10: number[], goldWorkIds: number[]): RecallMrr {
  const gold = new Set(goldWorkIds)
  const uniq = (ids: number[]): Set<number> => new Set(ids)
  const at5 = uniq(top10.slice(0, 5))
  const at10 = uniq(top10)
  let mrr = 0
  for (let i = 0; i < top10.length; i++) {
    if (gold.has(top10[i])) {
      mrr = 1 / (i + 1)
      break
    }
  }
  return {
    recallAt5: gold.size === 0 ? 0 : [...at5].filter((w) => gold.has(w)).length / gold.size,
    recallAt10: gold.size === 0 ? 0 : [...at10].filter((w) => gold.has(w)).length / gold.size,
    mrrAt10: mrr,
  }
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length
}

// ---------------------------------------------------------------------------
// stage: prepare — gate, copy, verify, migrate (timed), build the query set
// ---------------------------------------------------------------------------

async function stagePrepare(): Promise<void> {
  const { initDatabase, openDatabaseReadOnly, closeDatabase } = await import('../src/main/db/connection')
  const { QUERY_MAX_LENGTH } = await import('../src/main/ipc/registry/search')

  if (!existsSync(SOURCE_DB)) {
    throw new Error(`source database not found at ${SOURCE_DB}`)
  }
  const srcStat = statSync(SOURCE_DB)
  const walPath = `${SOURCE_DB}-wal`
  const shmPath = `${SOURCE_DB}-shm`
  const walSize = existsSync(walPath) ? statSync(walPath).size : -1
  const shmExists = existsSync(shmPath)

  // Who, if anyone, holds the source open right now.
  const lsof = spawnSync('lsof', [SOURCE_DB], { encoding: 'utf8' })
  const holders = lsof.status === 0 && lsof.stdout.trim() ? lsof.stdout.trim().split('\n') : []

  console.log(`[prepare] source: ${SOURCE_DB}`)
  console.log(`[prepare] source size: ${srcStat.size} bytes, mtime ${srcStat.mtime.toISOString()}`)
  console.log(`[prepare] wal: ${walSize < 0 ? 'absent' : `${walSize} bytes`}, shm: ${shmExists ? 'present' : 'absent'}, holders: ${holders.length}`)

  if (holders.length > 0) {
    throw new Error(`a process holds the source database open — nothing may have it open during the copy:\n${holders.join('\n')}`)
  }
  if (walSize > 0) {
    throw new Error(
      `the source has a NON-EMPTY -wal (${walSize} bytes of unflushed frames) — a byte copy now would ` +
        'lose committed transactions. Stop the app cleanly, then rerun.'
    )
  }
  const staleArtifacts = walSize === 0 || shmExists
  if (staleArtifacts) {
    console.log(
      '[prepare] 0-byte -wal / -shm with NO live holder: a stale artifact of an unclean exit, not a ' +
        'live writer (evidence recorded). Copying; a post-copy re-stat and the copy’s integrity_check guard this.'
    )
  }

  rmSync(BENCH_DIR, { recursive: true, force: true })
  mkdirSync(BENCH_DIR, { recursive: true })
  copyFileSync(SOURCE_DB, COPY_DB)
  const copyStat = statSync(COPY_DB)
  if (copyStat.size !== srcStat.size) {
    throw new Error(`copy size mismatch: source ${srcStat.size}, copy ${copyStat.size}`)
  }
  const srcAfter = statSync(SOURCE_DB)
  if (srcAfter.mtimeMs !== srcStat.mtimeMs || srcAfter.size !== srcStat.size) {
    rmSync(COPY_DB)
    throw new Error('the source changed WHILE it was being copied — copy discarded, nothing was written to the source')
  }
  console.log(`[prepare] copy verified: ${COPY_DB} (${copyStat.size} bytes, sizes equal, source unchanged)`)

  // Prove the copy opens and is coherent BEFORE anything migrates it.
  const before = openDatabaseReadOnly(COPY_DB)
  const integrity = before.pragma('integrity_check', { simple: true })
  if (integrity !== 'ok') {
    before.close()
    throw new Error(`the copy failed integrity_check: ${String(integrity)}`)
  }
  const userVersionBefore = before.pragma('user_version', { simple: true }) as number
  const counts = before
    .prepare(
      `SELECT (SELECT count(*) FROM work) AS works,
              (SELECT count(*) FROM chunk) AS chunks,
              (SELECT count(DISTINCT c.work_id) FROM chunk c) AS worksWithChunks`
    )
    .get() as { works: number; chunks: number; worksWithChunks: number }
  const spaceBefore = before
    .prepare(
      `SELECT id, model_id, model_revision, dims, normalized, config_hash, vec_table
         FROM embedding_space WHERE status = 'active'`
    )
    .get() as { id: number; model_id: string; model_revision: string; dims: number; normalized: number; config_hash: string; vec_table: string } | undefined
  before.close()
  console.log(`[prepare] copy ok: works=${counts.works} chunks=${counts.chunks} worksWithChunks=${counts.worksWithChunks} user_version=${userVersionBefore}`)
  // Every gold set below is scoped to the ACTIVE space — the only space the
  // measured legs search (the dense worker and searchLexical({spaceId}) both
  // do) — so a work or token living only in a retired space can never enter a
  // gold set no arm could satisfy and deflate the absolute numbers.
  if (!spaceBefore) {
    throw new Error(
      'no active embedding space in the copy — the measured legs search only the active space, so there is nothing to measure'
    )
  }
  console.log(`[prepare] active embedding space: ${spaceBefore.model_id} rev=${spaceBefore.model_revision.slice(0, 12)}… dims=${spaceBefore.dims} hash=${spaceBefore.config_hash.slice(0, 12)}…`)

  // Migration on the copy IS a measurement: v75 backfills chunk_fts from
  // every chunk's text. Timed end to end. COUNT(*) FROM chunk_fts would
  // delegate to the content table and print the chunk count however much the
  // index had actually built — the docsize shadow table is the index's own
  // honest size, the same counter unindexedLexical reads.
  const migStart = performance.now()
  const migrated = initDatabase(COPY_DB, { label: 'bench-retrieval' })
  const migrationMs = performance.now() - migStart
  const userVersionAfter = migrated.pragma('user_version', { simple: true }) as number
  const ftsRows = (migrated.prepare(`SELECT count(*) AS n FROM chunk_fts_docsize`).get() as { n: number }).n
  closeDatabase(migrated)
  console.log(`[prepare] migration on the 128 MB copy: ${round(migrationMs, 0)} ms → user_version ${userVersionBefore} → ${userVersionAfter}, chunk_fts indexed rows=${ftsRows}`)

  // ---- query set: everything derived from the copy, seed recorded ----
  const rng = mulberry32(SEED)
  const db = openDatabaseReadOnly(COPY_DB)

  const queries: BenchQuery[] = []
  let qid = 0

  const workRows = db
    .prepare(
      `SELECT w.id, w.title FROM work w
        WHERE EXISTS (SELECT 1 FROM chunk c WHERE c.work_id = w.id AND c.space_id = ?) AND w.title <> ''`
    )
    .all(spaceBefore.id) as Array<{ id: number; title: string }>
  const chosenWorks = seededShuffle(workRows, rng).slice(0, N_WORK_QUERIES)

  const chunkIdsStmt = db.prepare(`SELECT id FROM chunk WHERE work_id = ? AND space_id = ?`)
  const chunkTextStmt = db.prepare(`SELECT text FROM chunk WHERE id = ?`)
  for (const w of chosenWorks) {
    const chunkIds = (chunkIdsStmt.all(w.id, spaceBefore.id) as Array<{ id: number }>).map((r) => r.id)
    if (chunkIds.length === 0) continue
    const picked = chunkIds[Math.floor(rng() * chunkIds.length)]
    const text = (chunkTextStmt.get(picked) as { text: string } | undefined)?.text ?? ''
    qid += 1
    queries.push({
      qid,
      kind: 'work-title',
      text: w.title,
      goldChunkIds: chunkIds,
      goldWorkIds: [w.id],
    })
    qid += 1
    queries.push({
      qid,
      kind: 'work-sentence',
      text: firstSentence(text),
      goldChunkIds: chunkIds,
      goldWorkIds: [w.id],
    })
  }

  // Rare-token probes: candidates harvested from a seeded sample of chunk
  // text; the FTS index itself decides the true document frequency (≤ 3)
  // WITHIN THE ACTIVE SPACE — the space the measured legs search — and
  // answers the gold set there, so the probe and the lexical leg agree on
  // tokens and on what a match means.
  const allChunkIds = (db.prepare(`SELECT id FROM chunk`).all() as Array<{ id: number }>).map((r) => r.id)
  const sample = seededShuffle(allChunkIds, rng).slice(0, 4000)
  const sampleTextStmt = db.prepare(`SELECT text FROM chunk WHERE id = ?`)
  const df = new Map<string, number>()
  for (const id of sample) {
    const row = sampleTextStmt.get(id) as { text: string } | undefined
    if (!row) continue
    const seen = new Set<string>()
    for (const m of row.text.toLowerCase().matchAll(/[^\W_]+/gu)) {
      const tok = m[0]
      if (tok.length < 5 || tok.length > 24 || !/[a-z]/.test(tok) || seen.has(tok)) continue
      seen.add(tok)
      df.set(tok, (df.get(tok) ?? 0) + 1)
    }
  }
  const candidates = seededShuffle(
    [...df.entries()].filter(([, n]) => n >= 1 && n <= 3).map(([tok]) => tok),
    rng
  )
  const ftsCount = db.prepare(
    `SELECT count(*) AS n FROM chunk_fts JOIN chunk c ON c.id = chunk_fts.rowid WHERE chunk_fts MATCH ? AND c.space_id = ?`
  )
  const ftsGold = db.prepare(
    `SELECT c.id AS chunkId, c.work_id AS workId FROM chunk_fts JOIN chunk c ON c.id = chunk_fts.rowid WHERE chunk_fts MATCH ? AND c.space_id = ?`
  )
  let probes = 0
  for (const tok of candidates) {
    if (probes >= N_TOKEN_PROBES) break
    const n = (ftsCount.get(`"${tok}"`, spaceBefore.id) as { n: number }).n
    if (n < 1 || n > 3) continue
    const gold = ftsGold.all(`"${tok}"`, spaceBefore.id) as Array<{ chunkId: number; workId: number }>
    qid += 1
    probes += 1
    queries.push({
      qid,
      kind: 'rare-token',
      text: tok,
      goldChunkIds: gold.map((g) => g.chunkId),
      goldWorkIds: [...new Set(gold.map((g) => g.workId))],
    })
  }
  db.close()

  // The IPC's own query bound: a work-sentence probe can exceed it, and the
  // shipped parse rejects those before dispatch — dropping them here keeps
  // every measured row a search the app can actually serve. Recorded, never
  // silently dropped.
  const overLong = queries.filter((q) => q.text.length > QUERY_MAX_LENGTH)
  const served = queries.filter((q) => q.text.length <= QUERY_MAX_LENGTH)

  writeFileSync(QUERYSET_JSON, JSON.stringify({ seed: SEED, k: K, queries: served }, null, 1))
  writeFileSync(
    PREPARE_JSON,
    JSON.stringify(
      {
        source: SOURCE_DB,
        sourceSize: srcStat.size,
        sourceMtime: srcStat.mtime.toISOString(),
        staleWalArtifacts: staleArtifacts,
        liveHolders: holders.length,
        copy: COPY_DB,
        copySize: copyStat.size,
        integrityCheck: integrity,
        counts,
        userVersionBefore,
        userVersionAfter,
        migrationMs: round(migrationMs, 0),
        chunkFtsIndexedRows: ftsRows,
        space: spaceBefore,
        queryCount: served.length,
        probeCount: probes,
        queriesOverMaxLength: overLong.map((q) => ({ qid: q.qid, kind: q.kind, chars: q.text.length })),
      },
      null,
      1
    )
  )
  console.log(
    `[prepare] query set: ${served.length} queries (${served.length - probes} work-derived + ${probes} rare-token)` +
      `${overLong.length > 0 ? `, ${overLong.length} dropped over the shipped ${QUERY_MAX_LENGTH}-char query bound` : ''} → ${QUERYSET_JSON}`
  )
}

// ---------------------------------------------------------------------------
// stage: legs — arms (a) dense-only and (b) hybrid RRF, per-leg timings,
// plus the top-of-fused-pool arm (c) will rerank in its own process
// ---------------------------------------------------------------------------

interface QueryLegs {
  qid: number
  kind: BenchQuery['kind']
  strategy: 'index' | 'exhaustive' | null
  denseMs: number | null
  /** Works of the top-K dense CHUNKS, rank order, duplicates kept — the same
   *  unit armB's `fusedWorkIds` is scored on, so every arm's top-10 cut covers
   *  the same number of candidates (the scorer dedupes). */
  denseWorkIds: number[] | null
  lexicalMs: number | null
  fusedWorkIds: number[] | null
  pool: Array<{ chunkId: number; workId: number; score: number; denseRank: number }> | null
  error: string | null
}

async function stageLegs(): Promise<void> {
  const { openDatabaseReadOnly } = await import('../src/main/db/connection')
  const { searchLexical } = await import('../src/main/db/repos/lexical')
  const { rrfFuse } = await import('../src/main/search/rrf')
  const { VectorSearch } = await import('../src/main/search/vectorSearch')
  // The app's OWN assembly constants and candidate ordering — the measured
  // ranking must be the shipped one (module import is safe under
  // electron-as-node: the rerank host's electron import is lazy).
  const { DEFAULT_K, fusionPool, fuseCandidates } = await import('../src/main/search/semantic')

  const { queries } = JSON.parse(readFileSync(QUERYSET_JSON)) as { queries: BenchQuery[] }
  const db = openDatabaseReadOnly(COPY_DB)
  const vs = new VectorSearch(COPY_DB)

  // The lexical leg searches the ACTIVE space — the one the dense leg's worker
  // resolves — so the measured fusion is the shipped one. With no active space
  // the shipped app answers "nothing embedded" and there is nothing to measure.
  const activeSpaceId = (
    db.prepare(`SELECT id FROM embedding_space WHERE status = 'active'`).get() as
      | { id: number }
      | undefined
  )?.id
  if (activeSpaceId === undefined) {
    throw new Error(
      'no active embedding space in the copy — the shipped lexical leg searches the active space, so there is nothing to measure'
    )
  }

  // Warm both legs once so cold model loads and cold page cache do not land
  // in the first timed query.
  await vs.query(queries[0].text, DEFAULT_K)
  searchLexical(db, queries[0].text, { spaceId: activeSpaceId }, fusionPool(DEFAULT_K))

  const chunkWork = new Map<number, number>()
  for (const r of db.prepare(`SELECT id, work_id FROM chunk`).all() as Array<{ id: number; work_id: number }>) {
    chunkWork.set(r.id, r.work_id)
  }

  const legs: QueryLegs[] = []
  const strategies = { index: 0, exhaustive: 0 }
  let denseFails = 0
  let lexicalFails = 0

  for (const q of queries) {
    const leg: QueryLegs = { qid: q.qid, kind: q.kind, strategy: null, denseMs: null, denseWorkIds: null, lexicalMs: null, fusedWorkIds: null, pool: null, error: null }
    let denseChunkIds: number[] = []
    let lexicalChunkIds: number[] = []

    try {
      const t0 = performance.now()
      // The app's default dense depth, not the evaluation cutoff — the two are
      // different numbers and conflating them measured a fusion the app never
      // produces (ranks 11..30 contribute to the fused order).
      const res = await vs.query(q.text, DEFAULT_K)
      leg.denseMs = performance.now() - t0
      leg.strategy = res.strategy
      strategies[res.strategy] += 1
      denseChunkIds = res.hits.map((h) => h.chunkId)
      // Cut to the evaluation depth BEFORE mapping to works, so armA is scored
      // on the same unit as armB's fusedWorkIds and armC's rerankWorkIds: the
      // top-K chunks, works with duplicates kept (scoreAgainstGold dedupes).
      // Deduplicating across the whole dense depth first would hand armA a
      // wider distinct-work window than the other arms' top-10 covers whenever
      // one paper holds several of the dense top ranks.
      leg.denseWorkIds = denseChunkIds.slice(0, K).map((c) => chunkWork.get(c) ?? -1)
    } catch (err) {
      denseFails += 1
      leg.error = `dense: ${(err as Error).message}`
    }

    try {
      const t0 = performance.now()
      const hits = searchLexical(db, q.text, { spaceId: activeSpaceId }, fusionPool(DEFAULT_K))
      leg.lexicalMs = performance.now() - t0
      lexicalChunkIds = hits.map((h) => h.chunkId)
    } catch (err) {
      lexicalFails += 1
      leg.error = `${leg.error ? leg.error + '; ' : ''}lexical: ${(err as Error).message}`
    }

    // The shipped runSemanticSearch answers a dense failure with the error
    // sentence and NO fusion list, whatever the lexical leg did — so armB
    // scores only queries that carry a dense order. Fusing a lexical-only
    // list here would credit a ranking the app cannot produce.
    if (leg.denseWorkIds !== null) {
      // The app's assembly, verbatim: rrfFuse over the two ranked chunk lists
      // and the shared fuseCandidates ordering at the app's fusion pool — the
      // rerank arm then sees exactly the pool runSemanticSearch dispatches.
      const denseRank = new Map(denseChunkIds.map((id, i) => [id, i] as const))
      const scores = rrfFuse([denseChunkIds, lexicalChunkIds])
      leg.pool = fuseCandidates(scores, denseRank, fusionPool(DEFAULT_K)).map(([chunkId, score]) => ({
        chunkId,
        workId: chunkWork.get(chunkId) ?? -1,
        score,
        denseRank: denseRank.get(chunkId) ?? Number.POSITIVE_INFINITY,
      }))
      leg.fusedWorkIds = leg.pool.slice(0, K).map((p) => p.workId)
    }

    legs.push(leg)
    if (legs.length % 20 === 0) console.log(`[legs] ${legs.length}/${queries.length}`)
  }

  await vs.shutdown()
  db.close()

  const dense = legs.filter((l) => l.denseWorkIds !== null)
  const hybrid = legs.filter((l) => l.fusedWorkIds !== null)
  const metricsFor = (ls: QueryLegs[], pick: (l: QueryLegs) => number[] | null) => {
    const per = ls.map((l) => scoreAgainstGold(pick(l) ?? [], queryGold.get(l.qid) ?? []))
    return {
      recallAt5: round(mean(per.map((m) => m.recallAt5))),
      recallAt10: round(mean(per.map((m) => m.recallAt10))),
      mrrAt10: round(mean(per.map((m) => m.mrrAt10))),
    }
  }
  const queryGold = new Map(queries.map((q) => [q.qid, q.goldWorkIds]))
  const denseTook = dense.map((l) => l.denseMs ?? 0)
  const lexTook = legs.filter((l) => l.lexicalMs !== null).map((l) => l.lexicalMs ?? 0)

  writeFileSync(
    LEGS_JSON,
    JSON.stringify(
      {
        armA: { name: 'dense-only', ran: dense.length, failed: denseFails, ...metricsFor(dense, (l) => l.denseWorkIds), denseTookP50: round(pctl(denseTook, 0.5), 1), denseTookP95: round(pctl(denseTook, 0.95), 1), strategies },
        armB: {
          name: 'hybrid-rrf',
          ran: hybrid.length,
          failed: lexicalFails,
          ...metricsFor(hybrid, (l) => l.fusedWorkIds),
          denseTookP50: round(pctl(denseTook, 0.5), 1),
          lexicalTookP50: round(pctl(lexTook, 0.5), 1),
          lexicalTookP95: round(pctl(lexTook, 0.95), 1),
        },
        legs,
      },
      null,
      1
    )
  )
  console.log(`[legs] done: dense ${dense.length}/${legs.length} (failed ${denseFails}), lexical failed ${lexicalFails}, strategies=${JSON.stringify(strategies)} → ${LEGS_JSON}`)
}

// ---------------------------------------------------------------------------
// stage: rerank — arm (c) in its OWN process (the reranker is the only ONNX
// session here), then merge everything into tmp/bench-retrieval.json
// ---------------------------------------------------------------------------

async function stageRerank(): Promise<void> {
  const { openDatabaseReadOnly } = await import('../src/main/db/connection')
  const { resolveRerankerIdentity, rerankerConfigHash } = await import('../src/main/rerank/identity')
  const { scorePairs } = await import('../src/main/rerank/model')
  // The shipped pool size, the shipped budget and the shipped RERANK STAGE
  // ITSELF — the timed arm is `attemptRerank`, the same gating runSemanticSearch
  // runs (head rule, missing-text drop, two-scoreable gate, bounded wait,
  // short-answer refusal), so a change to a rerank-null cause moves this arm
  // with it instead of leaving the bench timing a stage the user never runs.
  const { DEFAULT_K, fusionPool, RERANK_POOL, RERANK_TIMEOUT_MS, attemptRerank } =
    await import('../src/main/search/semantic')
  // The fusion constant the legs stage actually fused with, from its source —
  // every shipped constant in the report is imported, so a change moves the
  // measurement and the report together.
  const { RRF_K } = await import('../src/main/search/rrf')

  const { queries } = JSON.parse(readFileSync(QUERYSET_JSON)) as { queries: BenchQuery[] }
  const legsData = JSON.parse(readFileSync(LEGS_JSON)) as {
    armA: Record<string, unknown>
    armB: Record<string, unknown>
    legs: QueryLegs[]
  }
  const goldByQid = new Map(queries.map((q) => [q.qid, q.goldWorkIds]))
  const db = openDatabaseReadOnly(COPY_DB)
  const textCache = new Map<number, string>()
  const chunkText = db.prepare(`SELECT text FROM chunk WHERE id = ?`)

  const identity = resolveRerankerIdentity()
  if (!identity) throw new Error('no reranker model is packaged — arm (c) cannot run')
  console.log(`[rerank] identity: ${identity.modelId} rev=${identity.modelRevision.slice(0, 12)}… maxSeq=${identity.maxSeqLength} side=${identity.truncationSide}`)

  // The shipped gate is TWO candidates — runSemanticSearch reranks only at
  // candidates.length >= 2 — so the harness admits the same pools or it times
  // a stage the app would never open.
  const withPool = legsData.legs.filter((l) => l.pool !== null && l.pool.length >= 2)

  // Chunk text, for warming the model only — the stage itself fetches and
  // filters the head's text inside attemptRerank, the way the app does.
  const textOf = (chunkId: number): string | null => {
    let t: string | null = textCache.get(chunkId) ?? null
    if (t === null) {
      t = (chunkText.get(chunkId) as { text: string } | undefined)?.text ?? null
      if (t !== null) textCache.set(chunkId, t)
    }
    return t
  }

  // Warm the reranker once; cold ONNX load must not land in a timed query.
  const warmTexts = ((withPool[0]?.pool as Array<{ chunkId: number }> | undefined) ?? [])
    .slice(0, 2)
    .map((p) => textOf(p.chunkId))
    .filter((t): t is string => t !== null)
  if (warmTexts.length > 0) await scorePairs(queries[0].text, warmTexts)

  const rerankLegs: Array<{ qid: number; rerankMs: number; rerankWorkIds: number[]; queriesDropped: number } | { qid: number; overBudget: true; rerankMs: number } | { qid: number; shortAnswer: true; rerankMs: number } | { qid: number; tooFewScoreable: true } | { qid: number; error: string; errorMs: number }> = []
  // The first leg that produced a real scoreable pool: its passages become the
  // ones the hosted-window measurement scores, so the hosted number is taken
  // on the same corpus text the in-process numbers were.
  let hostedPassages: string[] | null = null
  let fails = 0
  const textByQid = new Map(queries.map((q) => [q.qid, q.text] as const))
  for (const leg of withPool) {
    const pool = leg.pool as NonNullable<QueryLegs['pool']>
    // The SHIPPED stage runs here — head selection, the missing-text drop,
    // the two-scoreable gate, the bounded wait, the short-answer refusal and
    // the rescoring order are attemptRerank's, not a private copy — with the
    // in-process scorer in the rerank parameter's injection seam.
    const attempt = await attemptRerank(
      db,
      textByQid.get(leg.qid) ?? '',
      pool.map((p) => [p.chunkId, p.score] as const),
      new Map(pool.map((p) => [p.chunkId, p.score] as const)),
      new Map(pool.map((p) => [p.chunkId, p.denseRank] as const)),
      scorePairs
    )
    const workOf = new Map(pool.map((p) => [p.chunkId, p.workId] as const))
    switch (attempt.outcome.cause) {
      case 'ran':
        rerankLegs.push({
          qid: leg.qid,
          rerankMs: attempt.outcome.tookMs,
          rerankWorkIds: attempt.outcome.ordered.slice(0, K).map((id) => workOf.get(id) ?? -1),
          queriesDropped: [...attempt.outcome.truncated.values()].filter((t) => t.query).length,
        })
        if (hostedPassages === null) hostedPassages = attempt.scoreable.map((s) => s.text)
        break
      // The waitMs on every rerank-null cause below is the stage's OWN
      // measured wait (rerank_wait_ms in the app), already ended by the timer
      // the app bounds — armC's latency carries it, never a free failure or a
      // free timeout.
      case 'over-budget':
        rerankLegs.push({ qid: leg.qid, overBudget: true, rerankMs: attempt.outcome.waitMs })
        break
      case 'failed':
        fails += 1
        rerankLegs.push({
          qid: leg.qid,
          error: attempt.outcome.message,
          errorMs: attempt.outcome.waitMs,
        })
        break
      case 'short':
        rerankLegs.push({ qid: leg.qid, shortAnswer: true, rerankMs: attempt.outcome.waitMs })
        break
      // Fewer than two scoreable passages: the stage did not run, and the
      // harness must not DROP the query either. armB scores it via
      // fusedWorkIds, and the app answers it with the fusion order and
      // `rerank: null`, so armC is credited the same way the other rerank-null
      // arms are (same principle, same reason: dropping it would shrink
      // armC's denominator against armB's).
      case 'too-few':
        rerankLegs.push({ qid: leg.qid, tooFewScoreable: true })
        break
    }
    if (rerankLegs.length % 10 === 0) console.log(`[rerank] ${rerankLegs.length}/${withPool.length}`)
  }
  db.close()

  const okLegs = new Map(rerankLegs.filter((r) => 'rerankWorkIds' in r).map((r) => [r.qid, r]))
  const overBudgetMs = new Map(
    rerankLegs.filter((r) => 'overBudget' in r).map((r) => [r.qid, r.rerankMs] as const)
  )
  const errorByQid = new Map(
    rerankLegs.filter((r) => 'error' in r).map((r) => [r.qid, r] as const)
  )
  const shortMs = new Map(
    rerankLegs.filter((r) => 'shortAnswer' in r).map((r) => [r.qid, r.rerankMs] as const)
  )
  const tooFewQids = new Set(
    rerankLegs.filter((r) => 'tooFewScoreable' in r).map((r) => r.qid)
  )
  const perQuery = legsData.legs.map((leg) => {
    const gold = goldByQid.get(leg.qid) ?? []
    const rer = okLegs.get(leg.qid)
    const rerankError = errorByQid.get(leg.qid)
    const denseMs = leg.denseMs ?? 0
    const lexicalMs = leg.lexicalMs ?? 0
    const legMax = Math.max(denseMs, lexicalMs)
    return {
      qid: leg.qid,
      kind: leg.kind,
      strategy: leg.strategy,
      denseMs,
      lexicalMs,
      rerankMs: rer ? rer.rerankMs : null,
      // stageLegs' denominators, carried through: a dense failure means the
      // app answered with the error sentence and NO list (armB has no fused
      // order without a dense one), so the row is not-scored, not zero-recall
      // — counting it would skew exactly the dense-vs-hybrid comparison.
      armA:
        leg.denseWorkIds === null
          ? { e2eMs: null, recallAt5: null, recallAt10: null, mrrAt10: null, error: 'dense failed' }
          : { e2eMs: round(denseMs, 1), ...scoreAgainstGold(leg.denseWorkIds, gold) },
      armB:
        leg.fusedWorkIds === null
          ? { e2eMs: null, recallAt5: null, recallAt10: null, mrrAt10: null, error: 'dense failed' }
          : { e2eMs: round(legMax, 1), ...scoreAgainstGold(leg.fusedWorkIds, gold) },
      // Every rerank-null cause the shipped stage produces, armC answers with
      // the FUSION order — exactly what the app ships — and its latency
      // carries the stage's own measured wait (`rerank_wait_ms` in the app,
      // bounded by the shipped timer), never the withheld rerank ordering and
      // never a free failure. Each row names the cause that dropped the
      // rerank ordering. Dropping such a query from armC altogether would
      // shrink its denominator against armB's.
      armC: rer
        ? { e2eMs: round(legMax + rer.rerankMs, 1), ...scoreAgainstGold(rer.rerankWorkIds, gold) }
        : overBudgetMs.has(leg.qid)
          ? {
              e2eMs: round(legMax + (overBudgetMs.get(leg.qid) as number), 1),
              ...scoreAgainstGold(leg.fusedWorkIds ?? [], gold),
              rerankShipped: 'fusion (over budget)'
            }
          : rerankError !== undefined
            ? {
                e2eMs: round(legMax + rerankError.errorMs, 1),
                ...scoreAgainstGold(leg.fusedWorkIds ?? [], gold),
                rerankShipped: 'fusion (rerank failed)',
                rerankError: rerankError.error
              }
            : shortMs.has(leg.qid)
              ? {
                  e2eMs: round(legMax + (shortMs.get(leg.qid) as number), 1),
                  ...scoreAgainstGold(leg.fusedWorkIds ?? [], gold),
                  rerankShipped: 'fusion (short answer)'
                }
              : tooFewQids.has(leg.qid)
                ? {
                    e2eMs: round(legMax, 1),
                    ...scoreAgainstGold(leg.fusedWorkIds ?? [], gold),
                    rerankShipped: 'fusion (too few scoreable)'
                  }
                : { e2eMs: null, recallAt5: null, recallAt10: null, mrrAt10: null, error: 'no pool' },
    }
  })

  const agg = (vals: Array<number | null>): Array<number> => vals.filter((v): v is number => v !== null)
  const metrics = (pick: (p: (typeof perQuery)[number]) => { recallAt5: number | null; recallAt10: number | null; mrrAt10: number | null; e2eMs: number | null }) => {
    const rows = perQuery.map(pick)
    return {
      recallAt5: round(mean(agg(rows.map((r) => r.recallAt5)))),
      recallAt10: round(mean(agg(rows.map((r) => r.recallAt10)))),
      mrrAt10: round(mean(agg(rows.map((r) => r.mrrAt10)))),
      tookP50: round(pctl(agg(rows.map((r) => r.e2eMs)), 0.5), 1),
      tookP95: round(pctl(agg(rows.map((r) => r.e2eMs)), 0.95), 1),
      ran: rows.filter((r) => r.recallAt10 !== null).length,
    }
  }
  const armA = metrics((p) => p.armA)
  const armB = metrics((p) => p.armB)
  const armC = metrics((p) => p.armC)

  const prepare = JSON.parse(readFileSync(PREPARE_JSON)) as Record<string, unknown>
  const rerankTook = agg(perQuery.map((p) => p.rerankMs))
  const droppedQueries = rerankLegs.filter((r) => 'queriesDropped' in r && r.queriesDropped > 0).length

  // The hop the shipped window pays and the leg above cannot measure: it times
  // scorePairs IN-PROCESS (this stage runs under electron-as-node, where the
  // app's utilityProcess host cannot fork), while the shipped search posts
  // through scorePairsHosted and waits on the RPC round trip and the host's
  // serialisation queue too. A dedicated real-electron child — fresh virtual
  // display, ELECTRON_RUN_AS_NODE stripped — times one pool-10 request end to
  // end through that host, warmed, against an idle queue, so the report
  // carries the number the shipped RERANK_TIMEOUT_MS window actually covers
  // beside the in-process p50/p95. Recorded as an error rather than omitted
  // when the child cannot run: an absent field reads as a measurement never
  // taken, and one that failed is a different fact.
  const HOSTED_JSON = join(BENCH_DIR, 'rerank-hosted.json')
  let hosted: { poolSize: number; requests: number[]; maxMs: number; budgetMs: number } | {
    error: string
  }
  if (hostedPassages === null) {
    hosted = { error: 'no query produced a scoreable pool to time the host with' }
  } else {
    const hostedPassagesJson = join(BENCH_DIR, 'rerank-hosted-passages.json')
    writeFileSync(hostedPassagesJson, JSON.stringify(hostedPassages))
    const hostedEnv = { ...process.env }
    delete hostedEnv.ELECTRON_RUN_AS_NODE
    const res = spawnSync(
      'xvfb-run',
      [
        '-a',
        process.execPath,
        join(ROOT, 'scripts', 'verify-rerank-host.cjs'),
        '--timing-only',
        '--passages',
        hostedPassagesJson,
        '--out',
        HOSTED_JSON
      ],
      { env: hostedEnv, stdio: 'inherit', timeout: 300_000 }
    )
    hosted =
      res.status === 0 && existsSync(HOSTED_JSON)
        ? (JSON.parse(readFileSync(HOSTED_JSON, 'utf8')) as {
            poolSize: number
            requests: number[]
            maxMs: number
            budgetMs: number
          })
        : {
            error: `verify-rerank-host --timing-only exited ${res.status ?? `on signal ${String(res.signal)}`}${
              res.error ? ` (${String(res.error)})` : ''
            }`
          }
  }

  const report = {
    seed: SEED,
    k: K,
    denseDepth: DEFAULT_K,
    fusionPool: fusionPool(DEFAULT_K),
    rerankPool: RERANK_POOL,
    rrfK: RRF_K,
    densePath: 'the app’s built vector worker (out/main/vectorWorker.js) via worker_threads',
    rerankPath: 'scorePairs from src/main/rerank/model.ts in this dedicated process (single ONNX session; the app’s utilityProcess host cannot fork under electron-as-node), dispatched by the shipped attemptRerank gating from src/main/search/semantic.ts',
    rerankHosted:
      hostedPassages === null
        ? hosted
        : {
            // The pool ACTUALLY timed — the first scoreable leg's passages,
            // which can fall short of RERANK_POOL when chunk text is missing or
            // the fused pool came up small. Naming the true count rather than
            // the shipped constant is what stops a narrower window from being
            // reported as the shipped one; the summary's own poolSize says the
            // same from the child's side.
            path: `one pool-${hostedPassages.length} request posted-to-scored through the REAL utilityProcess host (scripts/verify-rerank-host.cjs --timing-only: warmed, idle serialisation queue — queueing from concurrent sweeps sits on top of this)`,
            ...hosted
          },
    prepare,
    rerankIdentity: { ...identity, configHash: rerankerConfigHash(identity) },
    arms: { 'dense-only': armA, 'hybrid-rrf': armB, 'hybrid+rerank': armC },
    perLeg: {
      denseP50: (legsData.armA as { denseTookP50: number }).denseTookP50,
      denseP95: (legsData.armA as { denseTookP95: number }).denseTookP95,
      lexicalP50: (legsData.armB as { lexicalTookP50: number }).lexicalTookP50,
      lexicalP95: (legsData.armB as { lexicalTookP95: number }).lexicalTookP95,
      rerankP50: round(pctl(rerankTook, 0.5), 1),
      rerankP95: round(pctl(rerankTook, 0.95), 1),
      // The hosted numbers are what the shipped RERANK_TIMEOUT_MS window
      // actually covers — the in-process ones above are the scoring leg alone.
      rerankHostedP50: 'requests' in hosted ? round(pctl(hosted.requests, 0.5), 1) : null,
      rerankHostedMax: 'requests' in hosted ? hosted.maxMs : null,
    },
    sanity: {
      queries: perQuery.length,
      denseFailed: (legsData.armA as { failed: number }).failed,
      lexicalFailed: (legsData.armB as { failed: number }).failed,
      rerankFailed: fails,
      rerankQueriesDroppedAny: droppedQueries,
      // Queries the shipped RERANK_TIMEOUT_MS would cut off, scored by armC
      // with the fusion order the app actually answers with. Non-zero means
      // armC's numbers are a mixture of rerank-ordered and fusion-ordered
      // results — the verdict must be read with that in mind, and the
      // measured-pool claim "every query inside budget" no longer holds here.
      rerankOverBudget: overBudgetMs.size,
      // Queries whose scorer answered short of the pairs it was sent within
      // the budget: refused by the shipped stage (a partial measurement must
      // not be zipped into the order), answered with the fusion order, wait
      // paid.
      rerankShortAnswer: shortMs.size,
      // Queries the shipped two-scoreable-passage gate skipped: answered with
      // the fusion order and `rerank: null`, exactly what armC scores them
      // with — so the gate is why armC's numbers are a mixture only in the
      // same sense the over-budget count above is.
      rerankTooFewScoreable: tooFewQids.size,
      strategies: (legsData.armA as { strategies: Record<string, number> }).strategies,
    },
    perQuery,
  }
  writeFileSync(RESULT_JSON, JSON.stringify(report, null, 1))

  // The app dispatches the dense leg to its worker BEFORE running the
  // synchronous lexical query on the main handle (runSemanticSearch), so the
  // two legs overlap and an arm's end-to-end latency is the slower leg, not
  // their sum; the rerank arm adds the rerank leg on top of that.
  const row = (name: string, a: ReturnType<typeof metrics>, ran: number, failed: number): string =>
    `${name.padEnd(16)} ${String(a.recallAt5.toFixed(3)).padStart(9)} ${String(a.recallAt10.toFixed(3)).padStart(10)} ${String(a.mrrAt10.toFixed(3)).padStart(8)} ${String(a.tookP50).padStart(11)} ${String(a.tookP95).padStart(7)} ${`${ran}/${failed}`.padStart(8)}`
  const pct = (n: number): string => `${(n * 100).toFixed(1)}% of queries`
  const warn = (failed: number): string => (failed / Math.max(perQuery.length, 1) > 0.05 ? '  NOT MEASURED — error rate above 5%' : '')

  console.log('\n=== retrieval benchmark (user corpus copy, seed 42, k=10) ===')
  console.log(`${'arm'.padEnd(16)} ${'Recall@5'.padStart(9)} ${'Recall@10'.padStart(10)} ${'MRR@10'.padStart(8)} ${'took p50'.padStart(11)} ${'p95'.padStart(7)} ${'run/fail'.padStart(8)}`)
  console.log(row('dense-only', armA, armA.ran, report.sanity.denseFailed) + warn(report.sanity.denseFailed))
  console.log(row('hybrid-rrf', armB, armB.ran, report.sanity.lexicalFailed) + warn(report.sanity.lexicalFailed))
  console.log(row('hybrid+rerank', armC, armC.ran, report.sanity.rerankFailed) + warn(report.sanity.rerankFailed))
  console.log(`\nper-leg took_ms p50/p95: dense ${report.perLeg.denseP50}/${report.perLeg.denseP95} · lexical ${report.perLeg.lexicalP50}/${report.perLeg.lexicalP95} · rerank ${report.perLeg.rerankP50}/${report.perLeg.rerankP95}`)
  console.log(
    'requests' in hosted
      ? `hosted rerank (real utilityProcess host, the shipped window): ${hosted.requests.join(' / ')} ms (max ${hosted.maxMs}, budget ${hosted.budgetMs} ms)`
      : `hosted rerank NOT MEASURED — ${hosted.error}`
  )
  console.log(`dense strategies: ${JSON.stringify(report.sanity.strategies)} · queries with a truncated rerank query: ${droppedQueries}`)
  console.log(`rerank legs over the shipped ${RERANK_TIMEOUT_MS}ms budget (armC keeps the fusion order for them): ${overBudgetMs.size}`)
  console.log(`output: ${RESULT_JSON}`)

  if (armA.recallAt10 === armB.recallAt10 && armB.recallAt10 === armC.recallAt10) {
    console.log(`\nVERDICT: tie on Recall@10 (${armA.recallAt10}); MRR@10 decides — ${armA.mrrAt10 >= armB.mrrAt10 && armA.mrrAt10 >= armC.mrrAt10 ? 'dense-only' : armB.mrrAt10 >= armC.mrrAt10 ? 'hybrid-rrf' : 'hybrid+rerank'} leads`)
  } else {
    const best = armA.recallAt10 >= armB.recallAt10 && armA.recallAt10 >= armC.recallAt10 ? 'a' : armB.recallAt10 >= armC.recallAt10 ? 'b' : 'c'
    const name = best === 'a' ? 'dense-only' : best === 'b' ? 'hybrid-rrf' : 'hybrid+rerank'
    const win = best === 'a' ? armA : best === 'b' ? armB : armC
    console.log(`\nVERDICT: ${name} wins on Recall@10 (${win.recallAt10} vs ${Math.max(...[armA, armB, armC].filter((x) => x !== win).map((x) => x.recallAt10))}); MRR@10 ${win.mrrAt10} (dense ${armA.mrrAt10}, hybrid ${armB.mrrAt10}, rerank ${armC.mrrAt10})`)
    if (best === 'a') console.log('VERDICT: the dense-only baseline the app ships today is the better retriever on this corpus.')
  }
}

const stage = process.argv[process.argv.indexOf('--stage') + 1]
const run: Record<string, () => Promise<void>> = { prepare: stagePrepare, legs: stageLegs, rerank: stageRerank }
if (!stage || !run[stage]) {
  console.error('usage: bench-retrieval.ts --stage prepare|legs|rerank')
  process.exit(2)
}
run[stage]().catch((err) => {
  console.error(`[${stage}] FAILED: ${(err as Error).message}`)
  process.exit(1)
})
