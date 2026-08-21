// Rows for what an index said about a reference's abstract.
//
// The fetcher (`external/abstracts.ts`) is a pure translation of one HTTP reply
// and touches no database; this is the other half, and it is the ONLY place a
// `reference_abstract` row is written. The two share one vocabulary — an
// `AbstractOutcome` is a `reference_abstract.outcome` value verbatim — so a
// result crosses this boundary unchanged. There is deliberately no mapping
// function: a translation between two names for one concept is where a later
// reader collapses "the index answered and has nothing" into "we could not
// reach the index", which is the distinction both files exist to keep.
//
// A row is written for EVERY outcome, not only for text. "OpenAlex answered and
// holds no abstract for this DOI" is the difference between never asking again
// and asking forever, and it can only be known from a row that says so.

import type { DB } from '../db/connection'
import {
  ABSTRACT_FETCHER_VERSION,
  type AbstractOutcome,
  type AbstractSource
} from './external/abstracts'

/** What an earlier reference already learned, as the fetcher would have returned it. */
export interface CachedAbstractAnswer {
  doi: string | null
  matchedTitle: string | null
  abstract: string | null
  source: AbstractSource | null
  outcome: AbstractOutcome
}

/**
 * How the abstract was tied to the reference. The DB column is `matched_by`.
 *
 * 'title' is READ-ONLY. Rows written under the withdrawn title-similarity gate
 * really were admitted that way and the corpus must keep saying so, so the
 * CHECK still admits the value; nothing writes it any more.
 */
export type AbstractMatchedBy = 'doi' | 'bibliographic' | 'title'

export interface ReferenceAbstractEntry {
  /**
   * NULL once the reference has been promoted — the FK is `ON DELETE SET NULL`
   * precisely so the row outlives the unresolved row it was fetched for.
   */
  unresolvedReferenceId: number | null
  /** The anchor that survives everything else: the paper whose bibliography this is. */
  citingWorkId: number
  /** Set at promotion, and only there. A fetch never knows a work id. */
  workId?: number | null
  doi?: string | null
  matchedTitle?: string | null
  /** Non-null if and ONLY if `outcome === 'found'`. */
  abstract?: string | null
  source?: AbstractSource | null
  matchedBy?: AbstractMatchedBy | null
  /**
   * Only ever carried by a row from the withdrawn similarity era. Neither
   * current path computes a number: a DOI is the same string or it is not, and
   * a printed coordinate is equal or it is not.
   */
  matchConfidence?: number | null
  outcome: AbstractOutcome
  /** A sentence a user could read. Non-null only when `unreachable`. */
  error?: string | null
  /**
   * The printed identity of the paper this row answers for, from `askKeyFor`.
   *
   * NULL means NOT REUSABLE — the reference printed no coordinate, or no title
   * to tell it from the other papers sharing that coordinate. Never a
   * placeholder for "not computed": `abstractByAskKey` looks up by this column,
   * and a guessed key hands one paper's DOI to another.
   */
  askKey?: string | null
  /**
   * How near the paper this reference names is to a project's question, as the
   * same cross-encoder that ranks the corpus answered it.
   *
   * NULL means NOBODY SCORED IT — no reranker packaged, no research question
   * written down, or a reference offering neither an abstract nor a usable
   * title. Never 0: a 0 reads as "judged, and found irrelevant", which is a
   * claim nothing made, and this number is about to be averaged.
   */
  relevance?: number | null
  /** 'title+abstract' or 'title'. Null exactly when `relevance` is. */
  scoredOn?: string | null
  /**
   * WHOSE question `relevance` answers. Null exactly when `relevance` is.
   *
   * A reference hangs off a citing work, and a work sits in as many projects as
   * the user puts it in. A bare score would therefore read as a fact about the
   * paper and let a second project inherit the first one's ranking.
   */
  scoredForProjectId?: number | null
  /** For tests and re-imports; otherwise now. */
  fetchedAt?: string
}

export interface ReferenceAbstractRow {
  id: number
  unresolvedReferenceId: number | null
  citingWorkId: number
  workId: number | null
  doi: string | null
  matchedTitle: string | null
  abstract: string | null
  source: AbstractSource | null
  matchedBy: AbstractMatchedBy | null
  matchConfidence: number | null
  outcome: AbstractOutcome
  fetcherVersion: number
  fetchedAt: string
  error: string | null
  askKey: string | null
  relevance: number | null
  scoredOn: string | null
  scoredForProjectId: number | null
}

/**
 * Write what one index said about one reference, replacing what it said before.
 *
 * A re-fetch must REPLACE. `unreachable` is the retryable outcome, and a retry
 * that appended would leave the corpus holding both "could not be fetched" and
 * "here is the abstract" for the same reference, with nothing but `fetched_at`
 * to say which is current — a reader that picked the wrong one would be
 * reporting a failure that has since succeeded, or an abstract that was later
 * withdrawn.
 *
 * TWO UPSERT PATHS, because the unique index is PARTIAL. `ux_reference_abstract_ref`
 * covers `unresolved_reference_id` only WHERE NOT NULL, which is what lets many
 * promoted rows share NULL — SQLite would otherwise treat one promotion as
 * colliding with every other. So `ON CONFLICT` can only fire while the reference
 * is still unresolved. A promoted row (id NULL) has no index to conflict on, and
 * an unguarded INSERT there would silently accumulate one row per re-fetch. It is
 * matched instead on `(citing_work_id, work_id)` — the pair that identifies a
 * promoted reference once its unresolved row is gone — by an UPDATE first, with
 * the INSERT run only when that changed nothing.
 *
 * `fetcher_version` is stamped from the fetcher's own constant rather than
 * passed in, so no caller can claim a gate strictness it did not run under.
 */
export function recordReferenceAbstract(db: DB, entry: ReferenceAbstractEntry): number {
  const now = entry.fetchedAt ?? new Date().toISOString()
  const v = ABSTRACT_FETCHER_VERSION

  const cols = {
    citing: entry.citingWorkId,
    work: entry.workId ?? null,
    doi: entry.doi ?? null,
    title: entry.matchedTitle ?? null,
    abstract: entry.abstract ?? null,
    source: entry.source ?? null,
    matchedBy: entry.matchedBy ?? null,
    conf: entry.matchConfidence ?? null,
    outcome: entry.outcome,
    error: entry.error ?? null,
    askKey: entry.askKey ?? null,
    // The three move TOGETHER or not at all. A score with no project beside it
    // is a number nobody can attribute, and a `scored_on` without a score
    // describes a reading that did not happen — so a caller that omits the
    // relevance clears the other two rather than leaving them pointing at a
    // score that is gone.
    relevance: entry.relevance ?? null,
    scoredOn: entry.relevance == null ? null : (entry.scoredOn ?? null),
    scoredForProject: entry.relevance == null ? null : (entry.scoredForProjectId ?? null)
  }

  if (entry.unresolvedReferenceId === null) {
    const updated = db
      .prepare(
        `UPDATE reference_abstract
            SET doi = ?, matched_title = ?, abstract = ?, source = ?, matched_by = ?,
                match_confidence = ?, outcome = ?, fetcher_version = ?, fetched_at = ?,
                error = ?, ask_key = ?, relevance = ?, scored_on = ?,
                scored_for_project_id = ?
          WHERE unresolved_reference_id IS NULL
            AND citing_work_id = ?
            AND work_id IS ?`
      )
      .run(
        cols.doi,
        cols.title,
        cols.abstract,
        cols.source,
        cols.matchedBy,
        cols.conf,
        cols.outcome,
        v,
        now,
        cols.error,
        cols.askKey,
        cols.relevance,
        cols.scoredOn,
        cols.scoredForProject,
        cols.citing,
        cols.work
      )
    if (updated.changes > 0) {
      const row = db
        .prepare(
          `SELECT id FROM reference_abstract
            WHERE unresolved_reference_id IS NULL AND citing_work_id = ? AND work_id IS ?`
        )
        .get(cols.citing, cols.work) as { id: number }
      return row.id
    }
  }

  const info = db
    .prepare(
      `INSERT INTO reference_abstract (
         unresolved_reference_id, citing_work_id, work_id, doi, matched_title, abstract,
         source, matched_by, match_confidence, outcome, fetcher_version, fetched_at, error,
         ask_key, relevance, scored_on, scored_for_project_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(unresolved_reference_id) WHERE unresolved_reference_id IS NOT NULL
       DO UPDATE SET
         work_id          = excluded.work_id,
         doi              = excluded.doi,
         matched_title    = excluded.matched_title,
         abstract         = excluded.abstract,
         source           = excluded.source,
         matched_by       = excluded.matched_by,
         match_confidence = excluded.match_confidence,
         outcome          = excluded.outcome,
         fetcher_version  = excluded.fetcher_version,
         fetched_at       = excluded.fetched_at,
         error            = excluded.error,
         ask_key          = excluded.ask_key,
         relevance        = excluded.relevance,
         scored_on        = excluded.scored_on,
         scored_for_project_id = excluded.scored_for_project_id`
    )
    .run(
      entry.unresolvedReferenceId,
      cols.citing,
      cols.work,
      cols.doi,
      cols.title,
      cols.abstract,
      cols.source,
      cols.matchedBy,
      cols.conf,
      cols.outcome,
      v,
      now,
      cols.error,
      cols.askKey,
      cols.relevance,
      cols.scoredOn,
      cols.scoredForProject
    )

  if (info.changes > 0 && info.lastInsertRowid) return Number(info.lastInsertRowid)
  const row = db
    .prepare('SELECT id FROM reference_abstract WHERE unresolved_reference_id = ?')
    .get(entry.unresolvedReferenceId) as { id: number }
  return row.id
}

/**
 * Every abstract fetched for one paper's bibliography, resolved or not.
 *
 * Scoped by `citing_work_id` because that is the only key that holds across a
 * promotion: `unresolved_reference_id` goes NULL and `work_id` is filled, but
 * the paper whose reference list this was does not change. A reranker asking
 * "what do I know about what this paper cites" gets the same set before and
 * after its references resolve.
 */
/**
 * The answer an earlier reference already got for the same paper, if there is
 * one, keyed by `askKeyFor`.
 *
 * ONE PAPER IS CITED BY MANY OF OURS, and it is stored once per bibliography.
 * Measured here: 571 reference lines that print a coordinate name only 405
 * distinct papers, and the most-cited appears in ten of twenty-three
 * bibliographies. Without this the corpus asks a public index the same question
 * ten times — slow, and spending a rate limit shared with every paper the user
 * will ever import.
 *
 * SCOPED TO A FETCHER VERSION. A row admitted under a different rule is not
 * evidence about what the current rule would decide, so reuse would carry a
 * withdrawn gate's mistakes into every later bibliography.
 *
 * ONLY `found` ROWS. `unreachable` is the retryable outcome and `absent` is
 * cheap to re-ask; serving either from cache would freeze one afternoon's
 * network trouble into a permanent fact about a paper.
 */
export function abstractByAskKey(
  db: DB,
  askKey: string,
  fetcherVersion: number
): ReferenceAbstractRow | null {
  const r = db
    .prepare(
      `SELECT id, unresolved_reference_id, citing_work_id, work_id, doi, matched_title,
              abstract, source, matched_by, match_confidence, outcome, fetcher_version,
              fetched_at, error, ask_key, relevance, scored_on, scored_for_project_id
         FROM reference_abstract
        WHERE ask_key = ? AND fetcher_version = ?
          AND outcome = 'found' AND abstract IS NOT NULL
        ORDER BY id LIMIT 1`
    )
    .get(askKey, fetcherVersion) as Record<string, unknown> | undefined
  if (!r) return null
  return {
    id: r.id as number,
    unresolvedReferenceId: (r.unresolved_reference_id as number | null) ?? null,
    citingWorkId: r.citing_work_id as number,
    workId: (r.work_id as number | null) ?? null,
    doi: (r.doi as string | null) ?? null,
    matchedTitle: (r.matched_title as string | null) ?? null,
    abstract: (r.abstract as string | null) ?? null,
    source: (r.source as AbstractSource | null) ?? null,
    matchedBy: (r.matched_by as AbstractMatchedBy | null) ?? null,
    matchConfidence: (r.match_confidence as number | null) ?? null,
    outcome: r.outcome as AbstractOutcome,
    fetcherVersion: r.fetcher_version as number,
    fetchedAt: r.fetched_at as string,
    error: (r.error as string | null) ?? null,
    askKey: (r.ask_key as string | null) ?? null,
    relevance: (r.relevance as number | null) ?? null,
    scoredOn: (r.scored_on as string | null) ?? null,
    scoredForProjectId: (r.scored_for_project_id as number | null) ?? null
  }
}

export function referenceAbstractsFor(db: DB, citingWorkId: number): ReferenceAbstractRow[] {
  const rows = db
    .prepare(
      `SELECT id, unresolved_reference_id, citing_work_id, work_id, doi, matched_title,
              abstract, source, matched_by, match_confidence, outcome, fetcher_version,
              fetched_at, error, ask_key, relevance, scored_on, scored_for_project_id
         FROM reference_abstract
        WHERE citing_work_id = ?
        ORDER BY id`
    )
    .all(citingWorkId) as Array<Record<string, unknown>>

  return rows.map((r) => ({
    id: r.id as number,
    unresolvedReferenceId: (r.unresolved_reference_id as number | null) ?? null,
    citingWorkId: r.citing_work_id as number,
    workId: (r.work_id as number | null) ?? null,
    doi: (r.doi as string | null) ?? null,
    matchedTitle: (r.matched_title as string | null) ?? null,
    abstract: (r.abstract as string | null) ?? null,
    source: (r.source as AbstractSource | null) ?? null,
    matchedBy: (r.matched_by as AbstractMatchedBy | null) ?? null,
    matchConfidence: (r.match_confidence as number | null) ?? null,
    outcome: r.outcome as AbstractOutcome,
    fetcherVersion: r.fetcher_version as number,
    fetchedAt: r.fetched_at as string,
    error: (r.error as string | null) ?? null,
    askKey: (r.ask_key as string | null) ?? null,
    relevance: (r.relevance as number | null) ?? null,
    scoredOn: (r.scored_on as string | null) ?? null,
    scoredForProjectId: (r.scored_for_project_id as number | null) ?? null
  }))
}

/**
 * The three bands a reference's relevance is shown as.
 *
 * A WORD RATHER THAN THE NUMBER, because the number cannot be read. These are
 * sigmoids from a decisive cross-encoder: on a real 678-reference corpus the
 * median is 0.00044 and the 90th percentile 0.027, so the information lives in
 * the leading zeros. `0.0038` looks like nothing and is in fact the top fifth
 * of the bibliography; `0.33` looks middling and is the top 2%. Printed to two
 * significant figures the column was honest and unreadable at the same time.
 */
export type RelevanceBand = 'high' | 'medium' | 'low'

/**
 * Where the band boundaries sit, per scoring scale.
 *
 * BY PERCENTILE, NEVER BY A FIXED CUTOFF ON THE SCORE. A sigmoid off a
 * cross-encoder is ordinal — the model's own docs and this codebase both say it
 * may be ranked and never thresholded — so `> 0.5 is high` would be a claim the
 * number does not support, and on this corpus it would put 3 of 678 references
 * in "high" and everything else in "low". A percentile makes the bands mean what
 * a reader assumes they mean: high is the top of THIS corpus's bibliography.
 *
 * TWO SEPARATE SCALES, and this is the part that would be a bug if skipped. A
 * reference scored from its title alone averages 0.0093 against 0.0377 for one
 * scored with an abstract — four times lower for a reason that is about OUR
 * fetching, not about the paper. Pooled, the title-only rows would take nearly
 * every "low" band and the badge beside them would be reporting our own
 * coverage as the paper's worth. So each scale is ranked within itself: "high"
 * means high among the references scored the same way.
 *
 * CORPUS-WIDE, not per page and not per paper. A 30-row page has no business
 * defining what "high" is, and one paper's bibliography of 24 uniformly weak
 * references would otherwise report its best as "high relevancy".
 */
export interface RelevanceBands {
  /** `[highCutoff, mediumCutoff]` for abstract-backed scores. */
  withAbstract: [number, number]
  /** `[highCutoff, mediumCutoff]` for title-only scores. */
  titleOnly: [number, number]
}

/** The top 20% is high, the next 30% medium, the rest low. */
const HIGH_PERCENTILE = 0.2
const MEDIUM_PERCENTILE = 0.5

function cutoffsFor(values: number[]): [number, number] {
  // Nothing scored on this scale: cutoffs no value can clear, so a later score
  // is not silently promoted by an empty population.
  if (values.length === 0) return [Infinity, Infinity]
  const sorted = [...values].sort((a, b) => b - a)
  const at = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
  return [at(HIGH_PERCENTILE), at(MEDIUM_PERCENTILE)]
}

/**
 * Read the band cutoffs from every scored reference in the corpus.
 *
 * Cheap enough to do per request — one indexed scan of a table with hundreds of
 * rows — and deliberately not cached: a cached cutoff would drift out of step
 * with the scores it classifies and label a reference against a corpus that no
 * longer exists.
 */
export function relevanceBands(db: DB): RelevanceBands {
  const rows = db
    .prepare(
      `SELECT relevance, scored_on FROM reference_abstract
        WHERE relevance IS NOT NULL AND scored_on IS NOT NULL`
    )
    .all() as Array<{ relevance: number; scored_on: string }>
  return {
    withAbstract: cutoffsFor(rows.filter((r) => r.scored_on !== 'title').map((r) => r.relevance)),
    titleOnly: cutoffsFor(rows.filter((r) => r.scored_on === 'title').map((r) => r.relevance))
  }
}

/** Which band one score falls in, on the scale it was measured with. */
export function bandFor(
  relevance: number | null,
  scoredOn: string | null,
  bands: RelevanceBands
): RelevanceBand | null {
  if (relevance === null) return null
  const [high, medium] = scoredOn === 'title' ? bands.titleOnly : bands.withAbstract
  if (relevance >= high) return 'high'
  if (relevance >= medium) return 'medium'
  return 'low'
}
