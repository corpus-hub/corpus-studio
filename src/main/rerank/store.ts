// What a relevance sweep needs to read, and what it writes back.
//
// Beside `identity.ts` and `model.ts` rather than in `db/repositories.ts`
// because both halves are about ONE question — how near is this paper to what
// this project asked — and the read and the write are two ends of the same
// claim. Split across a general repository they would age apart: the reader
// would start returning a field the writer never stores, and nothing would say
// so.
//
// The reader deliberately returns EVERY project, not one. The stage that uses
// it is a corpus sweep (see `stages/rerank.ts` for why), so "which projects" is
// not something its caller knows.

import type { DB } from '../db/connection'

/** One paper of one project, with everything a pair score needs. */
export interface ScoringWork {
  workId: number
  title: string
  abstract: string | null
  inclusionStatus: string
  /**
   * How many of this paper's references the app could not match to a paper it
   * already holds — the literature following this bibliography would OPEN.
   *
   * Resolved references are deliberately not counted. A reference that already
   * resolves to a work in the library opens nothing: following it imports a
   * paper the user has. Expansion priority is a claim about unexplored
   * territory, so a paper whose whole bibliography is already in the corpus has
   * nothing left to expand into however good those papers are.
   *
   * COMPOSITES EXCLUDED. ACS and Angewandte print several papers under one
   * number as "(11) (a) … (b) …", and the parser stores the whole entry AND one
   * row per lettered part. Counting both asks the same bibliography twice: one
   * paper in this corpus prints 44 references and yields 83 rows.
   */
  unmatchedReferences: number
  /**
   * Every relevance the reference-abstract sweep recorded for this paper's
   * unmatched references AGAINST THIS PROJECT'S question.
   *
   * Only scored rows are here. A reference nobody could score — no abstract
   * found and no usable printed title — is absent rather than present as a 0,
   * because it is not a reference that scored badly; nothing looked at it. And
   * only rows whose `scored_for_project_id` is this project: a score answers
   * one research question, and averaging another project's answers would rank
   * this project's papers by somebody else's interests.
   */
  referenceRelevances: number[]
}

/**
 * How relevant a paper's reading list is ON AVERAGE, or null when nothing in it
 * could be judged.
 *
 * THE MEAN REPLACES A COUNT, and that is the whole point. Bibliography size
 * counted references without caring what they were, so a paper with 200
 * off-topic references outranked one with 30 on-topic ones — it measured how
 * much a paper cites, not how much of what it cites is worth following. The mean
 * asks the second question and is independent of length, which is what "how much
 * relevant territory would following these citations open" actually means. A SUM
 * would reward length again and reintroduce exactly the bias being removed.
 *
 * NULL, NOT 0, when the list is empty. A paper whose references could none of
 * them be scored has an UNDEFINED mean, and 0 would draw a bar reading "followed
 * this bibliography and found nothing worth having" — a verdict nothing reached.
 * The two are told apart everywhere else in this pipeline and are told apart
 * here.
 *
 * No smoothing and no minimum count: a paper with three scored references gives
 * a noisier mean than one with eighty, and that is a real property of the
 * evidence rather than something a constant should hide.
 */
export function meanReferenceRelevance(values: readonly number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((a, b) => a + b, 0) / values.length
}

/** One project, and the papers held under it. */
export interface ScoringSet {
  projectId: number
  /**
   * The project's own statement of what it is for, composed by
   * `composeProjectDescription` from the onboarding goal and questions.
   *
   * Null or blank when the questionnaire has not been answered. That is not a
   * project whose papers are all irrelevant — it is a project that has not said
   * what relevance would mean, and a caller must decline rather than score
   * against an empty question.
   */
  description: string | null
  works: ScoringWork[]
}

/**
 * Every project's papers, shaped for scoring.
 *
 * The reference relevances are read as their own rows rather than averaged in
 * SQL, because `AVG` over an empty set and `AVG` over a set of zeros are both a
 * number to SQLite and only one of them is a mean. The caller has to see the
 * COUNT to tell "nothing could be judged" from "everything was judged and scored
 * low", and that distinction is what keeps a NULL expansion priority out of the
 * 0 that means a verdict.
 *
 * The unmatched count is a correlated subquery rather than a join for the reason
 * it always was: joined against the relevance rows, a paper with 40 of each
 * would produce 1600 rows and its own count would be squared.
 */
export function scoringSets(db: DB): ScoringSet[] {
  const projects = db
    .prepare('SELECT id, description FROM project ORDER BY id')
    .all() as Array<{ id: number; description: string | null }>

  const worksOf = db.prepare(
    `SELECT pw.work_id      AS workId,
            w.title         AS title,
            w.abstract      AS abstract,
            pw.inclusion_status AS inclusionStatus,
            (SELECT COUNT(*) FROM unresolved_reference ur
              WHERE ur.citing_work_id = w.id AND ur.part_label IS NULL)
                            AS unmatchedReferences
       FROM project_work pw
       JOIN work w ON w.id = pw.work_id
      WHERE pw.project_id = ?
      ORDER BY pw.work_id`
  )

  // STILL UNMATCHED, which is not the same as "has a score". A promoted
  // reference KEEPS its row — `adoptReferenceAbstract` preserves the abstract
  // and the FK goes NULL rather than the row being deleted — so selecting on
  // `citing_work_id` alone would leave a resolved paper's score in the average
  // for ever. That contradicts the count beside it, which reads live
  // `unresolved_reference` rows, and the two disagreeing is what would print
  // "the 44 of its 30 unmatched references" into a sentence a reader is shown.
  //
  // It also breaks the measure itself: expansion priority asks what following
  // this paper's citations would OPEN, and a reference already in the library
  // opens nothing.
  const relevancesOf = db.prepare(
    `SELECT relevance FROM reference_abstract
      WHERE citing_work_id = ? AND relevance IS NOT NULL
        AND scored_for_project_id = ?
        AND unresolved_reference_id IS NOT NULL
        AND work_id IS NULL`
  )

  return projects.map((p) => ({
    projectId: p.id,
    description: p.description,
    works: (worksOf.all(p.id) as Array<Omit<ScoringWork, 'referenceRelevances'>>).map((w) => ({
      ...w,
      referenceRelevances: (
        relevancesOf.all(w.workId, p.id) as Array<{ relevance: number }>
      ).map((r) => r.relevance)
    }))
  }))
}

/**
 * The research question a job is running under, and whose it is.
 *
 * WHICH PROJECT, for a job that names none. A document-scoped stage carries
 * `project_id = 0`, and the paper it is working on may sit in several projects
 * with several different questions — so "the relevance of this paper's
 * references" is not well-formed until one of them is chosen. The choice is the
 * LOWEST project id holding the paper, which is not a preference so much as a
 * determinism: whatever is picked must be the same on every run, or a re-fetch
 * would silently restate a bibliography's relevance against a different question
 * and the stored `scored_for_project_id` would be the only trace.
 *
 * That is a real limitation and it is recorded here rather than hidden: a paper
 * in two projects gets its references scored for ONE of them, and the other
 * project's expansion priority sees no reference relevances at all and is
 * therefore NULL — unmeasured, not zero. The honest fix is a score per
 * (reference, project), which is a table rather than a column; this function is
 * where that change would land.
 *
 * Null when the job belongs to no project that has said what it is for. A blank
 * description is null and not an empty string, because scoring against nothing
 * produces confident-looking numbers measuring nothing.
 */
export function projectQuestion(
  db: DB,
  jobProjectId: number,
  workId: number
): { projectId: number; question: string } | null {
  const row = (
    jobProjectId > 0
      ? db.prepare('SELECT id, description FROM project WHERE id = ?').get(jobProjectId)
      : db
          .prepare(
            `SELECT p.id AS id, p.description AS description
               FROM project_work pw
               JOIN project p ON p.id = pw.project_id
              WHERE pw.work_id = ?
              ORDER BY p.id
              LIMIT 1`
          )
          .get(workId)
  ) as { id: number; description: string | null } | undefined
  const question = (row?.description ?? '').trim()
  if (!row || question === '') return null
  return { projectId: row.id, question }
}

/** One paper's two scores, as the sweep decided them. */
export interface ScoreRow {
  workId: number
  /**
   * NULL when nothing scored this paper — never 0. A 0 draws an empty bar that
   * reads as "judged, and found irrelevant", which is a claim no model made.
   */
  relevance: number | null
  /** Which text the model was shown, or null when it was not run. */
  scoredOn: string | null
  /**
   * The mean relevance of this paper's unmatched references, or NULL when none
   * of them could be judged.
   *
   * NULL is a real answer here and is WRITTEN rather than skipped — see
   * `recordScores`, where it is the one column whose null does not mean "leave
   * it alone".
   */
  expansionPriority: number | null
  /**
   * The sentence a reader sees under "Why this rank", written by whoever
   * decided the numbers beside it.
   *
   * Stored rather than composed at render time because it must describe THE RUN
   * THAT WROTE THE ROW — which model looked, which text it was shown, what the
   * bibliography counted against. A sentence rebuilt later from the columns
   * alone could not say any of that, and a corpus scored by an older reranker
   * would silently be explained in terms of the current one.
   */
  explanation: string
}

/** Which of the two columns a person has set by hand on one row. */
function overriddenFields(raw: string | null): { relevance: boolean; expansion: boolean } {
  if (!raw) return { relevance: false, expansion: false }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      relevance: Object.prototype.hasOwnProperty.call(parsed, 'relevance'),
      expansion: Object.prototype.hasOwnProperty.call(parsed, 'expansion_priority')
    }
  } catch {
    // Unparseable JSON is not evidence that nobody overrode anything — it is a
    // row whose overrides cannot be read. Treating both as set is the reading
    // that cannot destroy a human judgement.
    return { relevance: true, expansion: true }
  }
}

/**
 * Store one project's scores.
 *
 * `expansion_priority` is written unconditionally and `relevance` only where a
 * score exists, because the two halves fail independently: bibliography size
 * needs no model, so a build with no reranker packaged still has a real answer
 * for it. Overwriting a stored relevance with NULL on such a build would erase a
 * measurement a better-provisioned run had made.
 *
 * A COLUMN A PERSON SET BY HAND IS NEVER OVERWRITTEN, per column rather than
 * per row: someone who corrected a relevance has said nothing about how much
 * following the bibliography would be worth, and refusing to update the other
 * number would freeze it against a corpus that has moved. The explanation is
 * still refreshed on such a row, and says which number is theirs — a sentence
 * describing a computation beside a score a human replaced is the staleness
 * this column has already been through once.
 *
 * `expansion_rank` and `relevance_rank` are derived HERE and nowhere else,
 * because a rank needs the whole project in one hand and this is the only place
 * that holds it. The Ranking screen paginates at 50, so a renderer normalising
 * what it had been given would rank each page against itself and put a 1.0 at
 * the top of every one of them. Both come out of the SAME `rankByValue` in the
 * same transaction, so the two cannot start disagreeing about what a tie or a
 * null means.
 */
/**
 * Where each scored row sits in its project's order, 1 highest and 0 lowest.
 *
 * ONE helper for both scores rather than the same twenty lines twice, because
 * the two ranks are read side by side on the same card and any drift between
 * how they treat a tie or a null shows up as one paper outranking another on a
 * screen and not on the next.
 *
 * TIES SHARE A RANK. Sorting alone would order two identical values by
 * whichever happened to come first and print them a whole step apart, which is
 * a distinction the numbers do not make — and on a corpus where many papers
 * score alike, that is a lot of invented precision. Equal values therefore take
 * the position of the first of their group.
 *
 * Unscored rows are excluded outright rather than sorted to the bottom: a NULL
 * is "nothing could be judged", and giving it the last rank would state that
 * this is the least worthwhile paper in the project.
 *
 * THE RESULT IS FOR DISPLAY ONLY. It measures ORDER, not distance, and it moves
 * when a neighbour is added even though nothing about the paper changed.
 */
function rankByValue<T>(
  rows: readonly T[],
  key: (r: T) => number,
  value: (r: T) => number | null
): Map<number, number> {
  const ordered = rows.filter((r) => value(r) !== null)
  ordered.sort((a, b) => (value(b) as number) - (value(a) as number))
  const ranks = new Map<number, number>()
  // A single scored paper is the whole order, and (n-1) would divide by zero.
  // It is neither first nor last of anything, so it takes the top of the scale.
  const span = ordered.length - 1
  ordered.forEach((r, i) => {
    const tied = i > 0 && value(r) === value(ordered[i - 1])
    const position = tied ? (ranks.get(key(ordered[i - 1])) as number) : span === 0 ? 1 : 1 - i / span
    ranks.set(key(r), position)
  })
  return ranks
}

/**
 * Rewrite both ranks for a project from the values CURRENTLY STORED.
 *
 * A rank is a pure function of the scores beside it, so it is derived from the
 * table rather than from whatever a caller happens to be holding. That is what
 * makes it impossible to go stale: any path that changes a score — a sweep, a
 * user override, a paper joining or leaving — calls this afterwards and the
 * positions are correct again.
 *
 * A HAND-SET SCORE RANKS LIKE ANY OTHER. Freezing the rank of an overridden row
 * was the alternative, and it is wrong: a person who sets relevance to 1.0 has
 * said this paper is the most relevant one, and a card that goes on showing the
 * position the model gave it contradicts the number printed beside it. The
 * override protects the SCORE from being recomputed; it does not entitle the
 * paper to a position its score does not have.
 */
export function recomputeRanks(db: DB, projectId: number): void {
  const rows = db
    .prepare(
      `SELECT work_id AS workId, relevance, expansion_priority AS expansionPriority,
              relevance_rank AS relevanceRank, expansion_rank AS expansionRank
         FROM project_work WHERE project_id = ?`
    )
    .all(projectId) as Array<{
    workId: number
    relevance: number | null
    expansionPriority: number | null
    relevanceRank: number | null
    expansionRank: number | null
  }>

  const relevanceRankOf = rankByValue(rows, (r) => r.workId, (r) => r.relevance)
  const expansionRankOf = rankByValue(rows, (r) => r.workId, (r) => r.expansionPriority)
  const write = db.prepare(
    `UPDATE project_work SET relevance_rank = ?, expansion_rank = ?
      WHERE project_id = ? AND work_id = ?`
  )

  // ONE TRANSACTION. A score and the positions derived from it must land
  // together: a throw between them would leave every card in the project
  // describing an order that no longer exists, and nothing would repair it.
  db.transaction(() => {
    for (const r of rows) {
      const rel = relevanceRankOf.get(r.workId) ?? null
      const exp = expansionRankOf.get(r.workId) ?? null
      // UNCHANGED ROWS ARE NOT WRITTEN. Moving one paper usually moves a
      // handful of positions, not the project; rewriting all of them made a
      // drag-reorder O(N^2) over a list that rebalances in bulk.
      if (rel === r.relevanceRank && exp === r.expansionRank) continue
      write.run(rel, exp, projectId, r.workId)
    }
  })()
}

export function recordScores(db: DB, projectId: number, rows: readonly ScoreRow[], now: string): void {
  const readOverrides = db.prepare(
    'SELECT user_overrides FROM project_work WHERE project_id = ? AND work_id = ?'
  )
  // EXPANSION IS NOT COALESCED, and relevance still is. The two columns now
  // disagree about what a null means. A null relevance is "nothing looked", and
  // a build with no reranker packaged must not erase a score a better-provisioned
  // run made — so it is left alone. A null expansion is a MEASURED answer: this
  // paper's references could none of them be judged, and the mean is undefined.
  // Coalescing that would leave the previous run's number sitting under a
  // bibliography that no longer supports it. So a flag says whether to write at
  // all, and it is the user's override rather than the value that decides.
  const write = db.prepare(
    `UPDATE project_work
        SET relevance = COALESCE(?, relevance),
            scored_on = COALESCE(?, scored_on),
            expansion_priority = CASE WHEN ? THEN expansion_priority ELSE ? END,
            ranking_explanation = ?, updated_at = ?
      WHERE project_id = ? AND work_id = ?`
  )

  for (const r of rows) {
    const held = readOverrides.get(projectId, r.workId) as { user_overrides: string | null } | undefined
    const overridden = overriddenFields(held?.user_overrides ?? null)
    // NULL means "leave the column as it stands", which covers both a score
    // nothing produced and a score a person owns. They are different reasons
    // for the same write, and the sentence beside them is what tells them apart.
    const relevance = overridden.relevance ? null : r.relevance
    const scoredOn = overridden.relevance || r.relevance === null ? null : r.scoredOn

    const notes = [r.explanation]
    if (overridden.relevance) notes.push('you set relevance by hand, so this run left it alone')
    if (overridden.expansion) {
      notes.push('you set expansion priority by hand, so this run left it alone')
    }
    write.run(
      relevance,
      scoredOn,
      overridden.expansion ? 1 : 0,
      r.expansionPriority,
      notes.join('; '),
      now,
      projectId,
      r.workId
    )
  }

  // LAST, and read back from the table rather than from `rows`: the ranks are a
  // property of the scores as they now stand, including any this run
  // deliberately left alone because a person owns them.
  recomputeRanks(db, projectId)
}
