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
 * The work-scope filter is applied IN THE WORKER, not here: filtering after the
 * fact would throw away most of a k-NN's answer and leave a list that looks like
 * a sparse corpus. The worker over-fetches for exactly that reason.
 *
 * Every failure that a user can do something about is returned rather than
 * thrown, with the coverage attached, so the screen can explain itself. A
 * genuine defect (the worker was never bundled, the thread died) still throws —
 * those are not states, they are bugs.
 */
export async function runSemanticSearch(
  db: DB,
  search: VectorSearch,
  query: string,
  k: number = DEFAULT_K,
  scope: CoverageScope = {}
): Promise<SemanticSearchResultDTO> {
  const { projectId, workId } = scope
  const coverage = semanticCoverage(db, scope)

  const text = query.trim()
  if (text.length === 0) {
    return {
      hits: [],
      space_id: coverage.space?.id ?? null,
      strategy: null,
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

  const started = Date.now()
  let raw
  try {
    raw = await search.query(text, k, workIds)
  } catch (err) {
    return {
      hits: [],
      space_id: coverage.space.id,
      strategy: null,
      coverage,
      took_ms: Date.now() - started,
      requested_k: k,
      error: (err as Error).message
    }
  }
  const tookMs = Date.now() - started

  const ids = [...new Set(raw.hits.map((h) => h.workId))]
  const meta = workMeta(db, ids)
  const authors = workAuthors(db, ids)
  const sources = docTextSources(db, [...new Set(raw.hits.map((h) => h.documentId))])
  const active = activeSpace(db)
  const stale = active
    ? staleChunkIds(db, raw.hits.map((h) => h.chunkId), active.configHash)
    : new Set<number>()

  const hits: SemanticHitDTO[] = []
  for (const h of raw.hits) {
    const m = meta.get(h.workId)
    // A hit whose work is gone is a stale vector, not a result. Dropping it is
    // the only option that does not invent a paper; the startup sweep removes
    // the vector itself.
    if (!m) continue
    hits.push({
      chunk_id: h.chunkId,
      work_id: h.workId,
      document_id: h.documentId,
      title: m.title,
      year: m.year,
      venue: m.venue,
      authors: authors.get(h.workId) ?? [],
      page: h.page,
      section: h.section,
      text: h.text,
      score: h.score,
      low_confidence: h.lowConfidence,
      text_source: sources.get(h.documentId)?.source ?? 'unknown',
      text_confidence: sources.get(h.documentId)?.confidence ?? null,
      stale_vector: stale.has(h.chunkId)
    })
  }

  return {
    hits,
    space_id: raw.spaceId,
    strategy: raw.strategy,
    coverage,
    took_ms: tookMs,
    // `k` is a reading budget, not a claim of exhaustiveness. Reported so the
    // renderer can say "the closest N" rather than let a count of what arrived
    // read as a count of what matched.
    requested_k: k,
    error: null
  }
}
