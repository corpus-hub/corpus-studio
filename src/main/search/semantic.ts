// The user-facing side of vector search: coverage, and hits joined to the papers
// they came from.
//
// `vectorSearch.ts` owns the WORKER; `vectors.ts` owns the SQL. This module owns
// the honesty. Everything here exists because a semantic search over a partly
// embedded corpus is the most convincingly wrong thing this app can do: it
// returns a short, plausible, ranked list and no error whatsoever, and the user
// has no way to tell that from "the library holds little on this". So every
// answer carries the coverage that produced it, every hit carries the passage
// that matched and how that passage's characters were obtained, and the states
// that are the USER'S business — no model packaged, nothing embedded yet, a
// model swapped under the existing vectors — come back as a sentence rather than
// a thrown error.

import type { DB } from '../db/connection'
import { activeSpace } from '../embedding/space'
import { spaceCoverage, countWorksWithTextScoped, type CoverageScope } from '../embedding/vectors'
import { ftsMatchQuery, searchLexicalMatched, type LexicalHit, type LexicalScope } from '../db/repos/lexical'
import { rrfFuse } from './rrf'
import { scorePairsHosted } from '../rerank/hostClient'
import { resolveRerankerIdentity } from '../rerank/identity'
import type { PairScore } from '../rerank/model'
import type { VectorSearch } from './vectorSearch'
import type {
  SemanticCoverageDTO,
  SemanticHitDTO,
  SemanticSearchResultDTO
} from '@shared/contract'

/**
 * How many passages a search asks the index for.
 *
 * Passages, not papers — several strong hits routinely come from one paper, and
 * capping at the number of papers we want to show would return one paper's worth
 * of results. The renderer groups them; this is the reading budget.
 */
export const DEFAULT_K = 30

/**
 * How many candidates the fusion stage over-fetches to before rerank narrows
 * them.
 *
 * A floor, not a multiplier: a small `k` must still leave the reranker
 * something it can reorder, while a `k` above the floor passes through so a
 * wide reading budget is not silently narrowed before the last stage. The
 * fusion itself over-fetches to this pool for the same reason the k-NN
 * over-fetches: the best passage after rescoring routinely sat outside the
 * fused top-k.
 */
export const FUSION_POOL_FLOOR = 50

/**
 * The pool a search of `k` results actually fuses over — the shipped
 * expression, in this one function because the benchmark harness must measure
 * the pool the app produces: `runSemanticSearch` and `scripts/bench-retrieval.ts`
 * both call this, so the measured pool cannot drift from the shipped one the
 * way a harness re-derivation would the day either constant moves.
 */
export function fusionPool(k: number): number {
  return Math.max(FUSION_POOL_FLOOR, k)
}

/**
 * How many of the fused candidates the rerank stage actually scores — the top
 * of the fused order. The rest keep the fusion order and fusion scores, and
 * `rerank.scored` tells the renderer which is which.
 *
 * MEASURED, not guessed, on a copy of the user's corpus (147 works / 3197
 * chunks, seed 42, 208 queries, batch=1; tmp/bench-rerank-pool.json — the
 * sweep helper that wrote it was deleted with the experiment, so the pool
 * table it measured lives in commit 29bd959's message, findable with
 * `git log -S bench-rerank-pool`), where one scored pair costs ~240-250 ms —
 * so the pool IS the budget. Scoring
 * deeper into the same fused pool plateaus on quality and explodes on time:
 * pools 10/15/20/30 land within 0.01 MRR of one another (0.9613 / 0.9619 /
 * 0.9615 / 0.9647) and buy +0.005 Recall@10 at most, while the scoring leg
 * alone runs p95 3.2 / 4.8 / 6.2 / 9.3 s (100% / 97.6% / 62% / 13% of
 * queries inside 5 s). Pool 10 is the deepest prefix whose slowest query
 * (3.54 s) fits an interactive budget; the ordering the deeper pools buy is
 * not reachable inside one.
 */
export const RERANK_POOL = 10

/**
 * How long the rerank stage may hold an answer before the list ships without
 * it. Bounded because a search that is seconds slow is worse than one that is
 * ordered by fusion alone — and the DTO says which happened, so the shorter
 * answer is never mistaken for the better-ordered one.
 *
 * 4000 against the measured leg: the bench's current artifact — the shipped
 * constants on the same corpus copy, tmp/bench-retrieval.json — has the
 * scoring leg alone at p50 2.61 s / p95 3.27 s with a 3.71 s slowest query,
 * and all 202 of its queries (208 built; the six over the shipped query bound
 * are excluded, recorded in the artifact) finished inside the budget. A host
 * that cannot answer in 4 s is stuck, not slow — the fusion order ships and
 * the DTO says so.
 *
 * That benchmark timed the scoring leg IN-PROCESS, without the utilityProcess
 * hop the shipped search always pays. The hop is measured, and it is noise:
 * the bench's first scored leg took 2259 ms in-process (perQuery[0].rerankMs
 * in the same artifact), and one pool-10 request posted-to-scored through the
 * real host — scripts/verify-rerank-host.cjs --timing-only — took
 * 2030/2021/1994 ms across its three runs, so the RPC round trip and pipe
 * serialisation sit inside run-to-run variance rather than on top of it, and
 * the shipped slowest query keeps the benchmark's margin. The bench records
 * the hosted number beside
 * the in-process p50/p95 (perLeg.rerankHostedP50/rerankHostedMax). This
 * window starts when the request is posted, ahead of the host's serialisation
 * queue — shared with the reference sweeps' back-to-back one-pair requests,
 * and just as shared with ANOTHER search's in-flight ten-pair one. IPC
 * handlers run to completion with no cancellation, so a second overlapping
 * search (the Search screen while an agent calls papers_search_by_meaning,
 * or two quick successive searches) can spend most of its budget queueing
 * behind the first's seconds of scoring and answer `rerank: null` with the
 * fusion order on a perfectly healthy host. That is the same
 * queueing-not-stuck reading as a sweep — the DTO reports which path ran
 * either way.
 */
export const RERANK_TIMEOUT_MS = 4_000

/**
 * Works with extracted text but no vector in the active space.
 *
 * The list, not the count, because the point is to be able to NAME them: "5 not
 * searchable yet" is a number a user can only worry about, whereas the titles
 * are something they can act on. Bounded to the ids; the caller resolves titles
 * for however many it chooses to show.
 *
 * BOUNDED at `UNEMBEDDED_LIST_CAP`, and the true count is reported separately.
 * On the 3000-work stress corpus with nothing embedded this returned three
 * thousand rows through a structured clone on EVERY coverage read — and coverage
 * is read on every mount of the Papers screen, in both modes. Naming the first
 * few and stating the real total is what the user needs; shipping the whole
 * table is what makes the screen slow.
 */
export const UNEMBEDDED_LIST_CAP = 200

/**
 * The fused candidate order: RRF score desc, ties broken dense-rank-first,
 * then chunk id — a total order, so the answer is deterministic whatever the
 * corpus — sliced to the fusion pool. Exported because the benchmark harness
 * and the verify gate must run THIS assembly, not a copy of it that can drift.
 */
export function fuseCandidates(
  fused: ReadonlyMap<number, number>,
  denseRank: ReadonlyMap<number, number>,
  pool: number
): Array<[number, number]> {
  return [...fused.entries()]
    .sort(
      (a, b) =>
        b[1] - a[1] ||
        (denseRank.get(a[0]) ?? Number.POSITIVE_INFINITY) -
          (denseRank.get(b[0]) ?? Number.POSITIVE_INFINITY) ||
        a[0] - b[0]
    )
    .slice(0, pool)
}

/**
 * The reranked order: the scored head re-sorts by logit desc, with the fusion
 * score, the dense rank and the chunk id standing behind only where the model
 * produced an exact tie; every unscored candidate keeps the fusion order it
 * was in. Exported for the same reason `fuseCandidates` is — one ordering,
 * run by the app, the benchmark and the verify gate alike.
 */
export function rerankOrder(
  ordered: readonly number[],
  logits: ReadonlyMap<number, number>,
  fusedScores: ReadonlyMap<number, number>,
  denseRank: ReadonlyMap<number, number>
): number[] {
  const head = ordered.filter((id) => logits.has(id))
  head.sort(
    (a, b) =>
      (logits.get(b) as number) - (logits.get(a) as number) ||
      (fusedScores.get(b) as number) - (fusedScores.get(a) as number) ||
      (denseRank.get(a) ?? Number.POSITIVE_INFINITY) -
        (denseRank.get(b) ?? Number.POSITIVE_INFINITY) ||
      a - b
  )
  return [...head, ...ordered.filter((id) => !logits.has(id))]
}

/**
 * How many LEADING ids still carry a logit. The stage reorders only the scored
 * head, and hit-building can drop rows deleted mid-search — a drop preserves
 * relative order, so a fusion score can only ever sit BEHIND the scored
 * survivors. `rerank.scored` is therefore the length of this prefix, not the
 * count sent to the model: reporting the send count would present a fusion
 * score to the renderer as the model's logit, one position inside the head.
 * Exported because the verify gate must count with THIS loop, not a copy that
 * can drift from what ships.
 */
export function leadingScoredCount(
  ids: readonly number[],
  logits: ReadonlyMap<number, number>
): number {
  let n = 0
  for (const id of ids) {
    if (!logits.has(id)) break
    n += 1
  }
  return n
}

/**
 * One attempt of the rerank stage: select the scored head, drop candidates
 * whose text has vanished, refuse to compare fewer than two, put the bounded
 * wait around the scorer, and name what happened.
 *
 * Exported because the benchmark harness must run THIS gating — the head rule,
 * the missing-text drop, the two-scoreable gate, the budget and the
 * short-answer refusal — not a copy of it that can drift from what ships.
 * `runSemanticSearch` and `scripts/bench-retrieval.ts` call it with their own
 * scorer, so a new rerank-null cause or a different head rule moves the app
 * and the measurement together.
 *
 * Everything the DTO needs AROUND the stage stays with the caller: the
 * reranker's identity (resolved and logged before this runs, and the only
 * source of `rerank.model_id`), the `candidates.length >= 2` gate, and the
 * hit-building that recounts `scored` against the returned hits.
 */
export interface RerankStageAttempt {
  /** The chunks selected for scoring, with the text actually sent, in send
   * order — empty when nothing reached the scorer. The benchmark's
   * hosted-window measurement scores exactly these. */
  scoreable: Array<{ chunkId: number; text: string }>
  outcome:
    | {
        cause: 'ran'
        /** The pool order after rescoring: scored head by logit, fusion order
         * behind. */
        ordered: number[]
        logits: ReadonlyMap<number, number>
        truncated: ReadonlyMap<number, { query: boolean; passage: boolean }>
        tookMs: number
      }
    | { cause: 'too-few' }
    | { cause: 'over-budget'; waitMs: number }
    | { cause: 'short'; waitMs: number; answered: number }
    | { cause: 'failed'; waitMs: number; message: string }
}

export async function attemptRerank(
  db: DB,
  query: string,
  candidates: ReadonlyArray<readonly [number, number]>,
  fused: ReadonlyMap<number, number>,
  denseRank: ReadonlyMap<number, number>,
  rerank: (query: string, passages: readonly string[], signal?: AbortSignal) => Promise<PairScore[]>
): Promise<RerankStageAttempt> {
  // Only the top of the fused order is scored (`RERANK_POOL`, measured);
  // the unscored tail keeps the fusion order and fusion scores, and
  // `rerank.scored` tells the renderer which is which. Fetching only the
  // head's text keeps the leg's cost at what it actually scores.
  const headIds = candidates.slice(0, RERANK_POOL).map(([id]) => id)
  const texts = new Map(
    (
      db
        .prepare(`SELECT id, text FROM chunk WHERE id IN (${headIds.map(() => '?').join(',')})`)
        .all(...headIds) as Array<{ id: number; text: string }>
    ).map((r) => [r.id, r.text])
  )
  // A candidate whose chunk row vanished between fusion and this SELECT
  // has no passage to read. Substituting '' would put a real logit on a
  // pair that never read any passage — ranked among genuine logits, the
  // exact failure model.ts's overflow refusal exists to prevent — so the
  // candidate leaves the scored head, it is never padded.
  const scoredIds = headIds.filter((id) => texts.has(id))
  const scoreable = scoredIds.map((id) => ({ chunkId: id, text: texts.get(id) as string }))
  const poolTexts = scoreable.map((s) => s.text)

  // Fewer than two survivors is the same gate the stage opens under —
  // "fewer than two candidates existed to compare" is a named `rerank:
  // null` cause in the contract.
  if (scoredIds.length < 2) {
    return { scoreable, outcome: { cause: 'too-few' } }
  }

  // Bounded wait. Losing the race is not a leak: the abort reaches the
  // host, which stops BETWEEN pairs and answers with the scores it took
  // (never padded), and that late reply resolves an entry nobody is
  // awaiting. The handlers below are attached before the race can lose,
  // so a rejection after a timeout is never an unhandled one.
  const rerankStarted = Date.now()
  const ac = new AbortController()
  let failure: string | null = null
  const scoredPromise = rerank(query, poolTexts, ac.signal)
  const winner = await new Promise<PairScore[] | 'timeout'>((resolve) => {
    // True once the race has an outcome; a scoredPromise settlement after
    // it is a reply nobody is awaiting any more.
    let settled = false
    const handle = setTimeout(() => {
      settled = true
      ac.abort()
      resolve('timeout')
    }, RERANK_TIMEOUT_MS)
    scoredPromise.then(
      (pairs) => {
        // A reply the timeout outran must be as visible in the log as a late
        // failure: "answered at 4.2s" and "wedged until the watchdog killed
        // it" name two different hosts behind a streak of `rerank: null`, and
        // without this line the log cannot tell them apart. An EMPTY
        // resolution is not a reply: a dispatch still queued on the host's
        // serialisation chain, or behind a host that was still starting,
        // bails before posting once the abort lands and resolves [] — so it
        // must not claim the host answered anything.
        if (settled) {
          console.log(
            pairs.length === 0
              ? '[search] rerank returned nothing after the stage was already reported as not run (the request never posted, or nothing was scored)'
              : `[search] rerank host answered ${pairs.length} of ${poolTexts.length} pairs after the stage was already reported as not run`
          )
          return
        }
        settled = true
        clearTimeout(handle)
        resolve(pairs)
      },
      (err: Error) => {
        // The late rejection IS the wedge case: the timeout's abort
        // reached a host stuck inside a native call, the watchdog killed
        // it, and this message is the only record of why. One line keeps
        // a wedge-kill-reload streak — every search after it paying a
        // cold host — diagnosable from the log the way the timeout is.
        if (settled) {
          console.log(
            `[search] rerank host failed after the stage was already reported as not run: ${err.message}`
          )
          return
        }
        settled = true
        clearTimeout(handle)
        failure = err.message
        resolve('timeout')
      }
    )
  })

  if (winner === 'timeout') {
    const waitMs = Date.now() - rerankStarted
    console.log(
      failure !== null
        ? `[search] rerank stage failed and is reported as not run: ${failure}`
        : `[search] rerank stage exceeded ${RERANK_TIMEOUT_MS}ms and is reported as not run — the list keeps the fusion order`
    )
    return failure !== null
      ? { scoreable, outcome: { cause: 'failed', waitMs, message: failure } }
      : { scoreable, outcome: { cause: 'over-budget', waitMs } }
  }
  if (winner.length !== poolTexts.length) {
    // A short answer cannot be aligned to the candidates positionally:
    // zipping what arrived would reorder on a partial measurement while
    // `rerank` claimed the whole stage ran. A request was posted and a
    // real wait was paid, so the wait ships — `rerank_wait_ms` is null
    // only where the leg skipped before any request was sent.
    const waitMs = Date.now() - rerankStarted
    console.log(
      `[search] rerank stage answered ${winner.length} of ${poolTexts.length} pairs and is reported as not run`
    )
    return { scoreable, outcome: { cause: 'short', waitMs, answered: winner.length } }
  }

  const logits = new Map<number, number>()
  const truncated = new Map<number, { query: boolean; passage: boolean }>()
  scoredIds.forEach((chunkId, i) => {
    logits.set(chunkId, winner[i].logit)
    truncated.set(chunkId, {
      query: winner[i].queryTokensDropped > 0,
      passage: winner[i].passageTokensDropped > 0
    })
  })
  // Sort the scored HEAD by logit desc; the fusion score, the dense
  // rank and the chunk id stand behind it only where the model
  // produced an exact tie — the order the user sees must still be
  // total and deterministic. The unscored tail stays in fusion order:
  // it has no logit to sort by, and the fusion order is already what
  // ordered it.
  const ordered = rerankOrder(
    candidates.map(([id]) => id),
    logits,
    fused,
    denseRank
  )
  return {
    scoreable,
    outcome: { cause: 'ran', ordered, logits, truncated, tookMs: Date.now() - rerankStarted }
  }
}

/**
 * The `work w` narrowing for one scope, as a JOIN plus a WHERE fragment.
 *
 * Shared by the list and its count so the two can never disagree about which
 * papers they are describing — a capped list and a total computed over
 * different sets is exactly the kind of quietly-wrong pair this module exists
 * to prevent.
 */
function workScopeSql(scope: CoverageScope): { join: string; where: string; args: number[] } {
  const args: number[] = []
  let join = ''
  let where = ''
  if (scope.projectId !== undefined) {
    join = 'JOIN project_work pw ON pw.work_id = w.id AND pw.project_id = ?'
    args.push(scope.projectId)
  }
  if (scope.workId !== undefined) {
    where = 'AND w.id = ?'
  }
  return { join, where, args }
}

function unembeddedWorks(
  db: DB,
  spaceId: number | null,
  scope: CoverageScope
): SemanticCoverageDTO['unembedded'] {
  // EVERY work without a vector, not only the ones that got as far as having
  // text. A paper whose extraction has not run is every bit as absent from the
  // results as one whose embedding has not, and listing only the second would
  // account for part of the gap while presenting it as the whole of it.
  const s = workScopeSql(scope)
  const tail: number[] = scope.workId !== undefined ? [scope.workId] : []
  const rows = db
    .prepare(
      `SELECT w.id AS work_id, w.title AS title,
              EXISTS (
                SELECT 1 FROM document_paragraph p
                  JOIN stage_run r ON r.id = p.stage_run_id
                  JOIN document d ON d.id = p.document_id
                 WHERE d.work_id = w.id AND r.superseded = 0
              ) AS has_text
         FROM work w
         ${s.join}
        WHERE NOT EXISTS (
          SELECT 1 FROM chunk c WHERE c.work_id = w.id AND c.space_id = ?
        )
        ${s.where}
        ORDER BY w.title ASC
        LIMIT ?`
    )
    .all(...s.args, spaceId ?? -1, ...tail, UNEMBEDDED_LIST_CAP) as Array<{
    work_id: number
    title: string
    has_text: number
  }>
  return rows.map((r) => ({
    work_id: r.work_id,
    title: r.title,
    reason: r.has_text === 1 ? ('not-embedded' as const) : ('no-text' as const)
  }))
}

/** How many papers are unsearchable, uncapped. Pairs with the capped list. */
function countUnembedded(db: DB, spaceId: number | null, scope: CoverageScope): number {
  const s = workScopeSql(scope)
  const tail: number[] = scope.workId !== undefined ? [scope.workId] : []
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM work w ${s.join}
          WHERE NOT EXISTS (
            SELECT 1 FROM chunk c WHERE c.work_id = w.id AND c.space_id = ?
          )
          ${s.where}`
      )
      .get(...s.args, spaceId ?? -1, ...tail) as { c: number }
  ).c
}

/**
 * What semantic search can and cannot currently answer.
 *
 * Returns a fully populated shape even when NOTHING is embedded — a null
 * `space` with zeroed counts is the honest answer, and is what lets the UI say
 * "not available yet" instead of rendering an empty result list that looks like
 * "no matches".
 */
export function semanticCoverage(db: DB, scope: CoverageScope = {}): SemanticCoverageDTO {
  const { projectId, workId } = scope
  // EVERY paper in scope, not only the ones a stage has finished reading. On a
  // library of 20 where 3 have text, "all papers with text are searchable" is
  // simultaneously true and badly misleading; this is the denominator the user
  // actually has in mind when they ask whether the search saw everything.
  //
  // Scoped to one paper the denominator is 1 — or 0 if the work is gone, which
  // is the honest way for a deleted paper to report itself rather than a
  // hardcoded 1 that would claim a row exists.
  const worksTotal = (
    (workId !== undefined
      ? db.prepare('SELECT COUNT(*) AS c FROM work WHERE id = ?').get(workId)
      : projectId === undefined
        ? db.prepare('SELECT COUNT(*) AS c FROM work').get()
        : db
            .prepare('SELECT COUNT(*) AS c FROM project_work WHERE project_id = ?')
            .get(projectId)) as { c: number }
  ).c

  const space = activeSpace(db)
  const unembedded = unembeddedWorks(db, space?.id ?? null, scope)
  // The COUNT is not capped even though the list is: the number is the part a
  // user must never be handed a rounded-down version of.
  const unembeddedTotal = countUnembedded(db, space?.id ?? null, scope)

  if (!space) {
    return {
      space: null,
      works_embedded: 0,
      // COUNTED, not assumed zero. Papers can be fully extracted before any
      // model is packaged, and reporting 0 here made the UI tell the user that
      // none of their papers had been read — a confidently wrong statement
      // about work they can watch succeed in the Queue.
      works_with_text: countWorksWithTextScoped(db, scope),
      works_total: worksTotal,
      chunks: 0,
      stale_chunks: 0,
      works_stale_only: 0,
      indexed: false,
      unembedded,
      unembedded_total: unembeddedTotal
    }
  }
  const c = spaceCoverage(db, space, scope)
  return {
    space: {
      id: space.id,
      model_id: space.modelId,
      dims: space.dims,
      status: space.status,
      created_at: space.createdAt
    },
    works_embedded: c.worksEmbedded,
    works_with_text: c.worksWithText,
    works_total: worksTotal,
    chunks: c.chunks,
    stale_chunks: c.stale,
    works_stale_only: c.worksStaleOnly,
    indexed: c.indexed,
    unembedded,
    unembedded_total: unembeddedTotal
  }
}

interface WorkMeta {
  title: string
  year: number | null
  venue: string | null
}

/** Titles for the hits, in one query rather than one per hit. */
function workMeta(db: DB, ids: number[]): Map<number, WorkMeta> {
  if (ids.length === 0) return new Map()
  const rows = db
    .prepare(
      `SELECT id, title, publication_year AS year, venue FROM work
        WHERE id IN (${ids.map(() => '?').join(',')})`
    )
    .all(...ids) as Array<{ id: number } & WorkMeta>
  return new Map(rows.map((r) => [r.id, { title: r.title, year: r.year, venue: r.venue }]))
}

function workAuthors(db: DB, ids: number[]): Map<number, string[]> {
  const out = new Map<number, string[]>()
  if (ids.length === 0) return out
  const rows = db
    .prepare(
      `SELECT wa.work_id, a.full_name FROM work_author wa
         JOIN author a ON a.id = wa.author_id
        WHERE wa.work_id IN (${ids.map(() => '?').join(',')})
        ORDER BY wa.work_id, wa.position ASC`
    )
    .all(...ids) as Array<{ work_id: number; full_name: string }>
  for (const r of rows) {
    const list = out.get(r.work_id) ?? []
    list.push(r.full_name)
    out.set(r.work_id, list)
  }
  return out
}

/** How each hit's document obtained its characters, and how well. */
function docTextSources(
  db: DB,
  ids: number[]
): Map<number, { source: SemanticHitDTO['text_source']; confidence: number | null }> {
  if (ids.length === 0) return new Map()
  const rows = db
    .prepare(
      `SELECT id, text_source, text_confidence FROM document
        WHERE id IN (${ids.map(() => '?').join(',')})`
    )
    .all(...ids) as Array<{
    id: number
    text_source: SemanticHitDTO['text_source']
    text_confidence: number | null
  }>
  return new Map(
    rows.map((r) => [r.id, { source: r.text_source, confidence: r.text_confidence }])
  )
}

/**
 * Which of these chunks were written under a config the active space no longer
 * uses.
 *
 * The k-NN returns them regardless — nothing in the query filters on
 * `config_hash` — so without this a result built from an older reading of the
 * paper is indistinguishable from a current one.
 */
function staleChunkIds(db: DB, chunkIds: number[], configHash: string): Set<number> {
  if (chunkIds.length === 0) return new Set()
  const rows = db
    .prepare(
      `SELECT id FROM chunk
        WHERE id IN (${chunkIds.map(() => '?').join(',')}) AND config_hash <> ?`
    )
    .all(...chunkIds, configHash) as Array<{ id: number }>
  return new Set(rows.map((r) => r.id))
}

/**
 * Run one semantic query and dress the hits with the paper they came from.
 *
 * The answer is a three-stage pipeline: the dense ranking and a BM25 lexical
 * ranking are fused by RRF, the fused candidates are rescored by the local
 * cross-encoder when it can run, and every stage reports whether it RAN
 * (`lexical`, `rerank`) — a stage that did not run is named as absent, never
 * silently absorbed into the ordering.
 *
 * The work-scope filter is applied IN THE WORKER, not here: filtering after the
 * fact would throw away most of a k-NN's answer and leave a list that looks like
 * a sparse corpus. The worker over-fetches for exactly that reason.
 *
 * Every failure that a user can do something about is returned rather than
 * thrown, with the coverage attached, so the screen can explain itself. A
 * genuine defect (the worker was never bundled, the thread died) still throws —
 * those are not states, they are bugs.
 *
 * `rerank` is the scorer the stage calls, `scorePairsHosted` in production.
 * The last parameter exists for the gate: `verify:hybrid` cannot fork the real
 * host, so it injects fixed logits and runs THIS assembly — the same code that
 * writes `hit.score` and orders the list — rather than recomputing the scored
 * path beside it and hoping the two stay identical.
 */
export async function runSemanticSearch(
  db: DB,
  search: VectorSearch,
  query: string,
  k: number = DEFAULT_K,
  scope: CoverageScope = {},
  rerank: (
    query: string,
    passages: readonly string[],
    signal?: AbortSignal
  ) => Promise<PairScore[]> = scorePairsHosted
): Promise<SemanticSearchResultDTO> {
  const { projectId, workId } = scope
  const coverage = semanticCoverage(db, scope)

  const text = query.trim()
  if (text.length === 0) {
    return {
      hits: [],
      space_id: coverage.space?.id ?? null,
      strategy: null,
      lexical: null,
      rerank: null,
      rerank_wait_ms: null,
      coverage,
      took_ms: 0,
      requested_k: k,
      error: null
    }
  }
  if (coverage.space === null || coverage.chunks === 0) {
    return {
      hits: [],
      space_id: null,
      strategy: null,
      lexical: null,
      rerank: null,
      rerank_wait_ms: null,
      coverage,
      took_ms: 0,
      requested_k: k,
      // Three different waits, three different remedies. Telling a reader to run
      // a stage that cannot run is worse than saying nothing, so the no-space
      // case is answered FIRST and answered about the library: with no space
      // there are no vectors anywhere, and pointing at this paper's embed stage
      // would blame the paper for the absence of a model.
      //
      // It stops short of asserting WHICH of the two no-space causes holds — no
      // model packaged, or a model that has simply never run — because this
      // function cannot tell them apart, and naming the wrong one sends the user
      // to a setting that is not the problem.
      //
      // Scoped to one paper the library-wide sentence is otherwise false — the
      // library may be almost entirely embedded while THIS paper is not — and a
      // reader standing in that paper would go looking for a problem that is
      // not theirs.
      error:
        coverage.space === null
          ? 'Nothing in this library has been embedded, so there is no meaning to search ' +
            'anywhere yet — this paper is not the exception. Verbatim search is unaffected.'
          : workId === undefined
            ? 'Nothing in this library has been embedded yet, so there is no meaning to search. ' +
              'Papers become searchable by meaning once their embed stage finishes.'
            : coverage.unembedded[0]?.reason === 'no-text'
              ? 'No text has been extracted from this paper yet, so it has nothing to search by meaning. ' +
                'Run its extract stage first; embedding follows from the text.'
              : 'This paper has not been embedded yet, so it cannot be searched by meaning. ' +
                'It becomes searchable once its embed stage finishes — other papers may already be.'
    }
  }

  // Scoped to the project's works so a search inside a project cannot answer
  // with a paper the project does not contain — which would look like a result
  // the user could open and then could not find anywhere. A `workId` narrows it
  // the whole way to one paper, and takes precedence: it is the more specific
  // of the two, and intersecting is pointless when the caller has named the
  // single paper it will display results in.
  const workIds =
    workId !== undefined
      ? [workId]
      : projectId === undefined
        ? undefined
        : (
            db
              .prepare('SELECT work_id FROM project_work WHERE project_id = ?')
              .all(projectId) as Array<{ work_id: number }>
          ).map((r) => r.work_id)

  // A project scope that resolves to ZERO works is the one narrowing that can
  // come out empty, and the dense worker reads an empty id list as NO
  // narrowing — a library-wide answer to a question asked inside a project,
  // exactly what the resolution above exists to prevent — while the lexical
  // leg answers the same scope with []. The fusion would compare unlike sets,
  // so the empty scope is answered here, before either leg is dispatched:
  // both legs searched the same — empty — set, no query ran, and nothing is
  // reported as having run. The coverage early-return above already catches
  // this state through the scoped chunk count, but the parity of the two legs
  // must not depend on that counting coincidence.
  if (workIds !== undefined && workIds.length === 0) {
    return {
      hits: [],
      space_id: coverage.space.id,
      strategy: null,
      lexical: null,
      rerank: null,
      rerank_wait_ms: null,
      coverage,
      took_ms: 0,
      requested_k: k,
      error:
        'This project holds no papers, so there is nothing to search by meaning. ' +
        'Add papers to it first; verbatim search is unaffected.'
    }
  }

  // The dense leg is DISPATCHED first — the worker starts scanning while the
  // synchronous lexical query below runs on this handle — and only awaited
  // after it, so the two legs of one search overlap. The lexical outcome is
  // still settled before the awaited vector call resolves — or rejects — and
  // can be reported as what actually happened, including on the vector-error
  // answer. Hiding a leg that ran behind an error would hand `null` a second
  // meaning ("ran, and the answer failed"), which is precisely the
  // one-flag-two-meanings failure the `strategy` field's own history warns
  // about.
  const pool = fusionPool(k)
  // The space both legs search. The dense leg's worker resolves the ACTIVE
  // space, and the coverage above already names it; a model swap retires the
  // old space without deleting its chunks, and 'comparison' spaces persist by
  // design, so a lexical query without this narrowing would MATCH passages the
  // dense leg can never return.
  const spaceId = coverage.space.id
  const denseStarted = Date.now()
  const denseQuery = search.query(text, k, workIds)

  const lexicalHits: LexicalHit[] = []
  let lexicalStage: SemanticSearchResultDTO['lexical'] = null
  let lexicalMs = 0
  // A query that segments to no word tokens builds no MATCH query at all —
  // there was no lexical leg to run, and `lexical: null` says exactly that.
  // An empty RESULT is the different case: the query ran and found nothing,
  // which is `'fts5'`. The built string is what runs, so the query is
  // segmented once — not once to gate the leg and again inside it.
  const match = ftsMatchQuery(text)
  if (match !== null) {
    const lexicalStarted = Date.now()
    try {
      // The same set the dense leg is searching: the active space resolved
      // above, and a named `workId` takes precedence there (the project
      // narrowing is dropped), so handing the raw scope to the lexical leg
      // would make it stricter than the dense one when a project does not hold
      // the work — both legs of one query must search the identical set or the
      // fusion compares unlike things.
      const lexicalScope: LexicalScope =
        workId !== undefined ? { workId, spaceId } : { ...scope, spaceId }
      lexicalHits.push(...searchLexicalMatched(db, match, lexicalScope, pool))
      lexicalStage = 'fts5'
    } catch (err) {
      console.log(
        `[search] lexical leg failed after ${Date.now() - lexicalStarted}ms and is reported as not run: ${
          (err as Error).message
        }`
      )
    }
    lexicalMs = Date.now() - lexicalStarted
  }

  let raw
  try {
    raw = await denseQuery
  } catch (err) {
    return {
      hits: [],
      space_id: coverage.space.id,
      strategy: null,
      lexical: lexicalStage,
      rerank: null,
      rerank_wait_ms: null,
      coverage,
      took_ms: Date.now() - denseStarted,
      requested_k: k,
      error: (err as Error).message
    }
  }
  const tookMs = Date.now() - denseStarted

  // Fuse the ranked lists. The dense list is the k-NN's order; the lexical
  // list is bm25's. Either may be empty — fusing one list is that list's own
  // order, which is the honest degradation when the other leg did not run.
  const denseRank = new Map(raw.hits.map((h, i) => [h.chunkId, i] as const))
  const fused = rrfFuse([raw.hits.map((h) => h.chunkId), lexicalHits.map((h) => h.chunkId)])

  // Top-POOL candidates. Ties broken dense-rank-first, then by chunk id — the
  // total order keeps the answer deterministic whatever the corpus.
  const candidates = fuseCandidates(fused, denseRank, pool)

  // The rerank stage. The identity is resolved BEFORE the host is asked to
  // score: a list the model cannot be named for must not be reordered at all
  // (an undescribed reranker is refused, not run on a guess), and `rerank` is
  // only ever present when the whole stage — scores AND the name of what
  // produced them — exists.
  let rerankStage: SemanticSearchResultDTO['rerank'] = null
  // The wait a stage that ultimately did NOT run was paid — the budget
  // elapsing, the host failing, or answering short of the pairs it was sent —
  // after the wait began. Measured, and shipped
  // on `rerank_wait_ms`: the timing header counts only the retrieval stage, so
  // without this the user reads a wait smaller than the one they sat through.
  let rerankWaitMs: number | null = null
  // The logits the stage produced, kept past the block: the hit-building below
  // can drop rows that vanished mid-search, and `scored` must then be the
  // number of hits that STILL carry a logit, not the number sent to the host.
  let rerankLogits: ReadonlyMap<number, number> | null = null
  // What the model ACTUALLY read for each scored pair, kept for the same
  // reason: a hit whose logit was computed against a shortened question or a
  // partly-read passage ships that fact beside the score, per hit, the way the
  // vector leg ships `low_confidence` — the stage measured it per pair, so it
  // is reported per hit and never flattened into one list-wide caveat.
  let rerankTruncated: ReadonlyMap<number, { query: boolean; passage: boolean }> = new Map()
  let ordered = candidates.map(([chunkId]) => chunkId)
  // Fusion scores first; a scored candidate's logit overwrites its entry, so
  // unscored candidates keep the fusion number that ordered them rather than
  // an invented logit.
  const finalScores: Map<number, number> = new Map(candidates)

  if (candidates.length >= 2) {
    let rerankerModelId: string | null = null
    try {
      rerankerModelId = resolveRerankerIdentity()?.modelId ?? null
    } catch (err) {
      console.log(
        `[search] rerank stage skipped — the packaged reranker could not be described: ${
          (err as Error).message
        }`
      )
    }
    if (rerankerModelId !== null) {
      const attempt = await attemptRerank(db, text, candidates, fused, denseRank, rerank)
      if (attempt.outcome.cause === 'ran') {
        rerankLogits = attempt.outcome.logits
        rerankTruncated = attempt.outcome.truncated
        ordered = attempt.outcome.ordered
        for (const [chunkId, logit] of attempt.outcome.logits) finalScores.set(chunkId, logit)
        rerankStage = {
          model_id: rerankerModelId,
          took_ms: attempt.outcome.tookMs,
          scored: attempt.outcome.logits.size
        }
      } else if (
        attempt.outcome.cause === 'over-budget' ||
        attempt.outcome.cause === 'short' ||
        attempt.outcome.cause === 'failed'
      ) {
        rerankWaitMs = attempt.outcome.waitMs
      }
    }
  }

  const topIds = ordered.slice(0, k)
  const byChunk = new Map(
    topIds.length > 0
      ? (
          db
            .prepare(
              `SELECT id, work_id, document_id, page, section, text, low_confidence
                 FROM chunk WHERE id IN (${topIds.map(() => '?').join(',')})`
            )
            .all(...topIds) as Array<{
            id: number
            work_id: number
            document_id: number
            page: number | null
            section: string
            text: string
            low_confidence: number
          }>
        ).map((r) => [r.id, r] as const)
      : []
  )

  const ids = [
    ...new Set(
      topIds
        .map((id) => byChunk.get(id)?.work_id)
        .filter((v): v is number => v !== undefined)
    )
  ]
  const meta = workMeta(db, ids)
  const authors = workAuthors(db, ids)
  const sources = docTextSources(
    db,
    topIds
      .map((id) => byChunk.get(id)?.document_id)
      .filter((v): v is number => v !== undefined)
      .filter((v, i, arr) => arr.indexOf(v) === i)
  )
  const active = activeSpace(db)
  const stale = active ? staleChunkIds(db, topIds, active.configHash) : new Set<number>()

  const hits: SemanticHitDTO[] = []
  for (const chunkId of topIds) {
    const c = byChunk.get(chunkId)
    const m = c ? meta.get(c.work_id) : undefined
    // A hit whose work is gone is a stale vector, not a result. Dropping it is
    // the only option that does not invent a paper; the startup sweep removes
    // the vector itself.
    if (!c || !m) continue
    hits.push({
      chunk_id: chunkId,
      work_id: c.work_id,
      document_id: c.document_id,
      title: m.title,
      year: m.year,
      venue: m.venue,
      authors: authors.get(c.work_id) ?? [],
      page: c.page,
      section: c.section,
      text: c.text,
      score: finalScores.get(chunkId) ?? 0,
      low_confidence: c.low_confidence === 1,
      text_source: sources.get(c.document_id)?.source ?? 'unknown',
      text_confidence: sources.get(c.document_id)?.confidence ?? null,
      stale_vector: stale.has(chunkId),
      // Null, not false, on an unscored hit: false would claim the model read
      // the whole pair, and no model ever saw this hit at all.
      rerank_query_truncated: rerankTruncated.get(chunkId)?.query ?? null,
      rerank_passage_truncated: rerankTruncated.get(chunkId)?.passage ?? null
    })
  }

  // A chunk or work row deleted while the legs ran makes the hit-building above
  // drop an entry and every later one shift up, so the honest `scored` is the
  // leading-logit prefix of what is RETURNED — leadingScoredCount's doc carries
  // the full reasoning.
  if (rerankStage !== null && rerankLogits !== null) {
    rerankStage.scored = leadingScoredCount(hits.map((h) => h.chunk_id), rerankLogits)
  }

  console.log(
    `[search] hybrid query — retrieval: ${tookMs}ms (vector strategy=${raw.strategy}), ` +
      `lexical: ${lexicalStage === null ? 'did not run' : `${lexicalMs}ms`}, ` +
      `pool: ${candidates.length}, ` +
      `rerank: ${
        rerankStage === null
          ? 'did not run'
          : `${rerankStage.took_ms}ms via ${rerankStage.model_id}, scored ${rerankStage.scored}`
      }`
  )

  return {
    hits,
    space_id: raw.spaceId,
    strategy: raw.strategy,
    lexical: lexicalStage,
    rerank: rerankStage,
    rerank_wait_ms: rerankWaitMs,
    coverage,
    took_ms: tookMs,
    // `k` is a reading budget, not a claim of exhaustiveness. Reported so the
    // renderer can say "the closest N" rather than let a count of what arrived
    // read as a count of what matched.
    requested_k: k,
    error: null
  }
}
