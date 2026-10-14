// `npm run verify:hybrid` — the hybrid search assembly is honest.
//
//   npm run verify:hybrid
//
// What is pinned here, and why each pin earns its place:
//
// - The fuse really fuses: a chunk the dense leg is CONSTRUCTIVELY denied
//   (a stub dense answer that cannot contain it) still lands high through the
//   lexical leg, at exactly the position an independent RRF recomputation
//   predicts. This is the same negative-control shape verify:vector uses for
//   the vec0 over-fetch window.
// - The reported fields are what happened: `lexical: 'fts5'` when a MATCH
//   query ran (even when it matched nothing), `lexical: null` when the query
//   segments to no word tokens at all; `rerank: null` when no rerank host can
//   run — under electron-as-node the utilityProcess host cannot fork, which
//   is the plan's "spawning blocked" arm — with the fusion order preserved
//   and the fusion scores on the hits.
// - A vector-leg failure keeps today's error answer (a returned sentence, not
//   a throw) while still reporting the legs that DID run. Hiding them would
//   give `null` a second meaning, the exact one-flag-two-meanings failure the
//   `strategy` field's history warns about.
// - An empty query names no strategy and no legs, and a small `k` still
//   over-fetches to the pool floor while `requested_k` stays the budget asked
//   for.
// - The rerank ORDERING itself: no host can fork here, so the pure assembly
//   runSemanticSearch orders a scored answer with is exercised directly —
//   scored head by logit desc, fusion order behind, and `scored` counting the
//   returned hits that still carry a logit after a mid-search row deletion.
// - The scored path's hit.score, through the SHIPPED score assembly: with the
//   scorer injected (fixed logits, reversed against the fused order) the
//   leading `rerank.scored` hits must carry exactly those logits in hit.score
//   and the tail must still carry the RRF fusion scores. A dropped logit
//   overwrite would order by logits while the hits present fusion scores
//   under a 'logit' label — the mislabeled-score failure this gate exists to
//   make impossible — and neither the pins above (the ordering helpers alone)
//   nor the rerank-absent score pin would see it.
// - The arms that decide `rerank: null` after a request went out: a scorer
//   that rejects, and one that answers short of the pairs it was sent. Both
//   must ship `rerank: null` WITH `rerank_wait_ms` measured and the fusion
//   order and scores untouched — the wait-paid half of the contract no other
//   arm here exercises.
//
// It runs under ELECTRON_RUN_AS_NODE (better-sqlite3 is Electron-ABI) against
// a FRESH throwaway DB in a temp dir — the user's real database is never
// opened. No build is needed: unlike verify:vector, no worker thread is
// started — the dense leg is a stub BY CONSTRUCTION, which is what makes the
// lexical-catches-what-dense-misses assertion deterministic.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { closeDb, initDatabase, setDb } from '../src/main/db/connection'
import { seed } from '../src/main/db/seed'
import { searchLexical } from '../src/main/db/repos/lexical'
import { RRF_K, rrfFuse } from '../src/main/search/rrf'
import {
  DEFAULT_K,
  fuseCandidates,
  leadingScoredCount,
  RERANK_POOL,
  rerankOrder,
  runSemanticSearch
} from '../src/main/search/semantic'
import type { PairScore } from '../src/main/rerank/model'
import type { VectorHit, VectorSearch, VectorSearchResult } from '../src/main/search/vectorSearch'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

interface ChunkRow {
  id: number
  work_id: number
  document_id: number
  page: number | null
  section: string
  text: string
}

/** Word-ish tokens, long enough to be stable under the FTS tokenizer. */
function tokenize(text: string): string[] {
  return text.match(/[\p{L}\p{N}]{6,}/gu) ?? []
}

function stubDenseResult(chunks: ChunkRow[], spaceId: number): VectorSearchResult {
  const hits: VectorHit[] = chunks.map((c, i) => ({
    chunkId: c.id,
    workId: c.work_id,
    documentId: c.document_id,
    page: c.page,
    section: c.section,
    text: c.text,
    score: 0.9 - i * 0.001,
    lowConfidence: false
  }))
  return { hits, spaceId, strategy: 'index' }
}

function stubSearch(result: VectorSearchResult): VectorSearch {
  return { query: async () => result } as unknown as VectorSearch
}

function failingSearch(message: string): VectorSearch {
  return {
    query: async () => {
      throw new Error(message)
    }
  } as unknown as VectorSearch
}

/**
 * The fused order the answer must reproduce — the SHIPPED assembly itself
 * (`fuseCandidates`), not a private copy of the comparator: a future change to
 * the shipped tie-break must move this gate with it, not leave it asserting an
 * order nothing produces. Unbounded pool here; the call site applies the k the
 * answer was asked for.
 */
function expectedOrder(denseIds: number[], lexicalIds: number[]): number[] {
  const denseRank = new Map(denseIds.map((id, i) => [id, i] as const))
  return fuseCandidates(rrfFuse([denseIds, lexicalIds]), denseRank, Number.POSITIVE_INFINITY).map(
    ([id]) => id
  )
}

const tmp = mkdtempSync(join(tmpdir(), 'corpus-hybrid-verify-'))
const dbFile = join(tmp, 'corpus.sqlite')

async function main(): Promise<void> {
try {
  const db = initDatabase(dbFile, { label: 'verify:hybrid' })
  setDb(db)
  seed(db)

  // seed() ships works with abstracts and a document each — the chunk table
  // itself is the embed stage's output, and this verify deliberately does not
  // run it: the dense leg is stubbed, so the chunks only need to EXIST for
  // the lexical leg and the FTS mirror. Chunk text is therefore slices of the
  // seeded abstracts (data-derived; no literal in this file), written through
  // the same columns insertChunks uses, with an active space row so coverage
  // answers.
  const abstracts = db
    .prepare(
      `SELECT w.id AS work_id, d.id AS document_id, w.abstract AS text
         FROM work w JOIN document d ON d.work_id = w.id
        WHERE w.abstract IS NOT NULL AND length(w.abstract) >= 400
        ORDER BY w.id LIMIT 40`
    )
    .all() as Array<{ work_id: number; document_id: number; text: string }>
  const chunkTexts: Array<{ work_id: number; document_id: number; text: string }> = []
  for (const a of abstracts) {
    for (let off = 0; off + 200 <= a.text.length && chunkTexts.length < 60; off += 450) {
      chunkTexts.push({ work_id: a.work_id, document_id: a.document_id, text: a.text.slice(off, off + 400) })
    }
  }
  check(
    'the seeded corpus carries abstracts to derive chunks from',
    chunkTexts.length >= 31,
    `${chunkTexts.length} chunk texts from ${abstracts.length} abstracts`
  )

  db.exec(`
INSERT INTO embedding_space (id, model_id, model_revision, model_file, dims, quantization,
  stored_quantization, pooling, normalized, query_prefix, doc_prefix, chunking_version,
  max_seq_length, text_extraction_version, runtime, config_hash, vec_table, status, created_at)
VALUES (1, 'test-model', 'rev-1', 'm.onnx', 4, 'none', 'none', 'mean', 1, '', '',
  'test-1', 512, 'test-1', 'test', 'verify-hybrid-hash', 'chunks_vec_verify', 'active',
  '2026-01-01T00:00:00Z');
INSERT INTO stage_run (id, stage, stage_version, status, input_fingerprint, created_at)
VALUES (1, 'embed', 'test-1', 'succeeded', 'verify-hybrid-fp', '2026-01-01T00:00:00Z');
`)
  const insertChunk = db.prepare(
    `INSERT INTO chunk (stage_run_id, space_id, document_id, work_id, idx, para_ids,
       char_start, char_end, page, section, text, token_estimate, input_hash, config_hash,
       vector, embedded_at)
     VALUES (1, 1, ?, ?, ?, '[]', 0, 10, 1, '', ?, 10, 'verify-hybrid', 'verify-hybrid-hash',
       x'00000000', '2026-01-01T00:00:00Z')`
  )
  const insertMany = db.transaction(() => {
    chunkTexts.forEach((c, i) => insertChunk.run(c.document_id, c.work_id, i + 1, c.text))
  })
  insertMany()

  const chunks = db
    .prepare('SELECT id, work_id, document_id, page, section, text FROM chunk ORDER BY id')
    .all() as ChunkRow[]
  check('the corpus now has chunks to search', chunks.length >= 31, `${chunks.length} chunks`)

  // A token appearing in EXACTLY one chunk — derived from the data at
  // runtime, never a literal in this file.
  const df = new Map<string, number>()
  const tokenChunk = new Map<string, number>()
  for (const c of chunks) {
    for (const t of new Set(tokenize(c.text))) {
      df.set(t, (df.get(t) ?? 0) + 1)
      if (!tokenChunk.has(t)) tokenChunk.set(t, c.id)
    }
  }
  const rareToken = [...df.entries()].find(([, n]) => n === 1)?.[0]
  check('a df=1 rare token exists in the corpus', rareToken !== undefined)
  if (rareToken === undefined) throw new Error('no rare token to verify with')
  const rareChunkId = tokenChunk.get(rareToken) as number

  // The dense stub answers with DEFAULT_K real chunks that CANNOT include the
  // one carrying the rare token — dense misses it by construction.
  const denseChunks = chunks.filter((c) => c.id !== rareChunkId).slice(0, DEFAULT_K)
  const denseIds = denseChunks.map((c) => c.id)
  const spaceId = (db.prepare('SELECT id FROM embedding_space LIMIT 1').get() as { id: number })
    .id
  const denseResult = stubDenseResult(denseChunks, spaceId)

  // ---- the lexical leg alone really finds the rare chunk
  const lexical = searchLexical(db, rareToken, { spaceId }, 10)
  check(
    'searchLexical ranks the df=1 chunk first, alone',
    lexical.length >= 1 && lexical[0].chunkId === rareChunkId,
    `token "${rareToken}" → ${lexical.length} hit(s)`
  )

  // ---- hybrid: lexical catches what dense was denied
  const r = await runSemanticSearch(db, stubSearch(denseResult), rareToken)
  const expected = expectedOrder(denseIds, [rareChunkId]).slice(0, DEFAULT_K)
  const actual = r.hits.map((h) => h.chunk_id)
  check('the hybrid answer carries no error', r.error === null, r.error ?? '')
  check('the lexical stage reports that it ran', r.lexical === 'fts5', `lexical=${r.lexical}`)
  check(
    'the rerank stage reports that it did NOT run (no host can fork here)',
    r.rerank === null,
    `rerank=${JSON.stringify(r.rerank)}`
  )
  check('the vector stage reports its own strategy', r.strategy === 'index', `strategy=${r.strategy}`)
  check(
    'the rare-token chunk lands inside top-k',
    actual.includes(rareChunkId),
    `position ${actual.indexOf(rareChunkId)} of ${actual.length}`
  )
  check(
    'the fused order equals the independently computed RRF order',
    JSON.stringify(actual) === JSON.stringify(expected),
    `first 6 actual ${actual.slice(0, 6)} vs expected ${expected.slice(0, 6)}`
  )
  const fusedScores = rrfFuse([denseIds, [rareChunkId]])
  const scoresHonest = r.hits.every(
    (h) => Math.abs(h.score - (fusedScores.get(h.chunk_id) as number)) < 1e-9
  )
  check(
    'with rerank absent, every hit.score is the fusion score that ordered it',
    scoresHonest,
    `k=${RRF_K}`
  )

  // ---- the rerank ordering, run directly. No rerank host can fork under
  // electron-as-node, so the ORDERING half of the stage is pinned through the
  // same pure assembly runSemanticSearch uses — the code a scored answer is
  // ordered by must not drift from what the benchmark measures.
  {
    const poolIds = [11, 12, 13, 14, 15, 16, 17, 18]
    const fusedScores = new Map(poolIds.map((id, i) => [id, 1 / (RRF_K + 1 + i)] as const))
    const denseRank = new Map(poolIds.map((id, i) => [id, i] as const))
    // 14 highest; 11 and 13 tie exactly (the higher fusion score wins the
    // tie); 16 scored lowest; 12/15/17/18 never scored.
    const logits = new Map([
      [11, 0.5],
      [13, 0.5],
      [14, 2.0],
      [16, -1.0]
    ] as const)
    const ordered = rerankOrder(poolIds, logits, fusedScores, denseRank)
    check(
      'the scored head sorts by logit desc (exact ties by fusion score); the tail keeps fusion order',
      JSON.stringify(ordered) === JSON.stringify([14, 11, 13, 16, 12, 15, 17, 18]),
      `got ${JSON.stringify(ordered)}`
    )
    // A row deleted mid-search drops hits; the scored survivors keep the head,
    // so `scored` is the count of LEADING hits still carrying a logit — here
    // 3, not the 4 pairs the model was sent. The SHIPPED helper computes this,
    // not a private copy of the loop, for the same reason expectedOrder runs
    // fuseCandidates: a future change to the shipped count must move this gate
    // with it, not leave it asserting a number nothing produces.
    const surviving = ordered.filter((id) => id !== 13)
    const scoredShown = leadingScoredCount(surviving, logits)
    check(
      'a dropped scored hit moves `scored` with the returned hits, not the send count',
      scoredShown === 3 && logits.size === 4,
      `leading-with-logit=${scoredShown} sent=${logits.size}`
    )
  }

  // ---- the SCORED path's hit.score, through the SHIPPED assembly. No rerank
  // host can fork here, so the scorer is injected: fixed logits handed back
  // positionally, reversed against the fused order, so the answer can only
  // come out right if runSemanticSearch itself overwrote the scored
  // candidates' fusion scores with the logits AND sorted the head by them.
  {
    const textToId = new Map(chunks.map((c) => [c.text, c.id] as const))
    const headIds = expectedOrder(denseIds, [rareChunkId]).slice(0, RERANK_POOL)
    // The i-th fused head candidate scores LOWEST and the last HIGHEST, so a
    // correct run visibly reverses the head and every score is distinguishable
    // from both the fusion score and every other logit.
    const fixedLogits = new Map<number, number>(
      headIds.map((id, i) => [id, -(headIds.length - i)] as const)
    )
    const stubScorer = async (
      _query: string,
      passages: readonly string[]
    ): Promise<PairScore[]> =>
      passages.map((t) => {
        const id = textToId.get(t)
        if (id === undefined) throw new Error('stub scorer handed a passage with no chunk row')
        return {
          logit: fixedLogits.get(id) as number,
          score: 0,
          queryTokensDropped: 0,
          passageTokensDropped: 0
        }
      })
    const rScored = await runSemanticSearch(
      db,
      stubSearch(denseResult),
      rareToken,
      DEFAULT_K,
      {},
      stubScorer
    )
    const head = rScored.hits.slice(0, RERANK_POOL)
    check(
      'the injected scorer opens the shipped rerank stage',
      rScored.rerank !== null &&
        rScored.rerank.scored === RERANK_POOL &&
        rScored.rerank_wait_ms === null &&
        rScored.error === null,
      rScored.rerank === null ? `rerank=null error=${rScored.error ?? ''}` : `scored=${rScored.rerank.scored}`
    )
    check(
      'the scored head is ordered by the injected logits — the fused order, reversed',
      JSON.stringify(head.map((h) => h.chunk_id)) === JSON.stringify([...headIds].reverse()),
      `first 3 got ${head.slice(0, 3).map((h) => h.chunk_id)} want ${[...headIds].reverse().slice(0, 3)}`
    )
    check(
      'every scored hit.score IS its logit, not the fusion score that ordered the pool',
      head.every((h) => Math.abs(h.score - (fixedLogits.get(h.chunk_id) as number)) < 1e-9),
      head
        .slice(0, 3)
        .map((h) => `${h.chunk_id}:${h.score}`)
        .join(' ')
    )
    check(
      'the unscored tail keeps the RRF fusion score — no logit invented for it',
      rScored.hits
        .slice(RERANK_POOL)
        .every((h) => Math.abs(h.score - (fusedScores.get(h.chunk_id) as number)) < 1e-9)
    )
  }

  // ---- the arms that decide `rerank: null` AFTER a request went out, through
  // the same injected seam: a host that rejects, and a host that answers short
  // of the pairs it was sent. Both paid a real wait after the stage began, so
  // both must ship `rerank: null` WITH `rerank_wait_ms` measured — the
  // null-means-no-wait-was-paid half of the contract, which only these arms
  // exercise — and the fusion order and scores untouched. Each stub settles in
  // milliseconds, so the gate stays fast; the full budget-elapse path stays
  // unpinned rather than costing 4 s here.
  {
    const rejectingScorer = async (): Promise<PairScore[]> => {
      await new Promise((r) => setTimeout(r, 5))
      throw new Error('stub rerank host rejected')
    }
    const rReject = await runSemanticSearch(
      db,
      stubSearch(denseResult),
      rareToken,
      DEFAULT_K,
      {},
      rejectingScorer
    )
    check(
      'a rejecting rerank host reports the stage as not run, not a search error',
      rReject.rerank === null && rReject.error === null,
      `rerank=${JSON.stringify(rReject.rerank)} error=${rReject.error ?? ''}`
    )
    check(
      'a rejecting host ships the wait the stage was paid',
      rReject.rerank_wait_ms !== null && rReject.rerank_wait_ms > 0,
      `rerank_wait_ms=${rReject.rerank_wait_ms}`
    )
    check(
      'a rejecting host leaves the fusion order and fusion scores',
      JSON.stringify(rReject.hits.map((h) => h.chunk_id)) === JSON.stringify(expected) &&
        rReject.hits.every((h) => Math.abs(h.score - (fusedScores.get(h.chunk_id) as number)) < 1e-9)
    )
    const shortScorer = async (
      _query: string,
      passages: readonly string[]
    ): Promise<PairScore[]> => {
      // A real wait, so the measured rerank_wait_ms is nonzero and the pin
      // cannot pass on a 0ms fluke.
      await new Promise((r) => setTimeout(r, 5))
      return passages.slice(0, Math.max(1, passages.length - 1)).map(() => ({
        logit: 9,
        score: 0,
        queryTokensDropped: 0,
        passageTokensDropped: 0
      }))
    }
    const rShort = await runSemanticSearch(
      db,
      stubSearch(denseResult),
      rareToken,
      DEFAULT_K,
      {},
      shortScorer
    )
    check(
      'a short rerank answer reports the stage as not run with its wait measured',
      rShort.rerank === null &&
        rShort.error === null &&
        rShort.rerank_wait_ms !== null &&
        rShort.rerank_wait_ms > 0,
      `rerank=${JSON.stringify(rShort.rerank)} wait=${rShort.rerank_wait_ms}`
    )
    check(
      'a short answer leaves the fusion order — no partial logit is zipped in',
      JSON.stringify(rShort.hits.map((h) => h.chunk_id)) === JSON.stringify(expected) &&
        rShort.hits.every((h) => Math.abs(h.score - (fusedScores.get(h.chunk_id) as number)) < 1e-9)
    )
  }

  // ---- a small k still over-fetches to the pool, and stays the asked budget
  const rSmall = await runSemanticSearch(db, stubSearch(denseResult), rareToken, 5)
  check(
    'requested_k is the budget asked for, not the pool fetched',
    rSmall.requested_k === 5 && rSmall.hits.length <= 5,
    `requested_k=${rSmall.requested_k} hits=${rSmall.hits.length}`
  )
  check(
    'the rare-token chunk survives a small k too',
    rSmall.hits.slice(0, 5).some((h) => h.chunk_id === rareChunkId)
  )

  // ---- a query with no word tokens ran no lexical leg, and says so
  const rPunct = await runSemanticSearch(db, stubSearch(denseResult), '!!! ??? ...')
  check(
    'a token-free query reports lexical: null',
    rPunct.lexical === null,
    `lexical=${rPunct.lexical}`
  )
  check(
    'with only the dense leg, the order is that leg alone',
    JSON.stringify(rPunct.hits.map((h) => h.chunk_id)) === JSON.stringify(denseIds),
    ''
  )
  check(
    'single-leg fusion scores start at 1/(k+1)',
    rPunct.hits.length > 0 &&
      Math.abs(rPunct.hits[0].score - 1 / (RRF_K + 1)) < 1e-9,
    `score[0]=${rPunct.hits[0]?.score}`
  )

  // ---- a MATCH query that matches NOTHING still ran, and says so. 'fts5'
  // means the leg executed, not that it found anything — null means it did not
  // run — so a regression reporting null (or omitting the leg) on a zero-match
  // query would break the null-means-did-not-run contract and must fail here.
  // The probe token is derived at runtime and proven absent through the leg
  // itself, never assumed from a string comparison.
  const absentToken = rareToken + 'zz'
  check(
    'the zero-match probe matches no chunk lexically',
    searchLexical(db, absentToken, { spaceId }, 10).length === 0,
    `token "${absentToken}"`
  )
  const rMiss = await runSemanticSearch(db, stubSearch(denseResult), absentToken)
  check(
    'a zero-match MATCH query still reports lexical: fts5',
    rMiss.lexical === 'fts5' && rMiss.error === null,
    `lexical=${rMiss.lexical} error=${rMiss.error ?? ''}`
  )
  check(
    'with a zero-match lexical leg, the order is the dense leg alone',
    JSON.stringify(rMiss.hits.map((h) => h.chunk_id)) === JSON.stringify(denseIds),
    ''
  )

  // ---- the vector leg failing keeps the error answer, and reports what ran
  const rDenseFail = await runSemanticSearch(db, failingSearch('worker unbundled — stub'), rareToken)
  check(
    'a dense failure returns the error sentence instead of throwing',
    rDenseFail.error === 'worker unbundled — stub',
    rDenseFail.error ?? ''
  )
  check(
    'the error answer still reports the lexical leg that RAN',
    rDenseFail.lexical === 'fts5' && rDenseFail.hits.length === 0,
    `lexical=${rDenseFail.lexical}`
  )
  const rBoth = await runSemanticSearch(
    db,
    failingSearch('worker unbundled — stub'),
    '!!! ??? ...'
  )
  check(
    'with no leg runnable, the error answer reports both as not run',
    rBoth.lexical === null && rBoth.rerank === null && rBoth.strategy === null
  )

  // ---- an empty query names nothing
  const rEmpty = await runSemanticSearch(db, stubSearch(denseResult), '   ')
  check(
    'an empty query runs no leg and names no strategy',
    rEmpty.hits.length === 0 &&
      rEmpty.lexical === null &&
      rEmpty.rerank === null &&
      rEmpty.strategy === null,
    ''
  )

  // ---- a project scope that resolves to ZERO works must narrow BOTH legs to
  // the same empty set. The dense worker reads an empty id list as NO
  // narrowing — a library-wide answer to a question asked inside a project —
  // while the lexical leg would answer the same scope with [], so the fusion
  // would compare unlike sets. The dense stub below THROWS if it is
  // dispatched, so a passing check proves no leg ran for the empty scope —
  // whichever early answer the assembly produces it with.
  {
    db.exec(`
INSERT INTO project (id, name, slug, created_at, updated_at)
VALUES (900001, 'verify empty project', 'verify-empty-project',
  '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`)
    const rNoPapers = await runSemanticSearch(
      db,
      failingSearch('dense leg dispatched over an empty project scope'),
      rareToken,
      DEFAULT_K,
      { projectId: 900001 }
    )
    check(
      'a project scope with no papers answers empty without dispatching a leg',
      rNoPapers.hits.length === 0 &&
        rNoPapers.lexical === null &&
        rNoPapers.rerank === null &&
        rNoPapers.strategy === null &&
        rNoPapers.error !== null &&
        rNoPapers.error !== 'dense leg dispatched over an empty project scope',
      `hits=${rNoPapers.hits.length} lexical=${rNoPapers.lexical} strategy=${rNoPapers.strategy}`
    )
  }

  closeDb()
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
}

main()
  .then(() => {
    console.log(
      failures === 0 ? '\nverify:hybrid — all checks passed' : `\nverify:hybrid — ${failures} FAILED`
    )
    process.exitCode = failures === 0 ? 0 : 1
  })
  .catch((err: Error) => {
    console.error(`verify:hybrid could not run: ${err.message}`)
    process.exitCode = 1
  })
