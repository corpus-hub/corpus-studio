import type { DB } from '../db/connection'

/**
 * THE COUNT A READER SEES, RECOMPUTED FROM THE ROWS IT CLAIMS TO COUNT.
 *
 * `schema-extract` writes `N fact(s), M evidence span(s)` at the moment it
 * finishes, and it is right when it writes it. `review-records` then runs
 * against the SAME `analysis_run` and inserts the values the first reading
 * missed — 106 of them on one paper of this corpus — and nothing rewrote the
 * sentence the user reads. The stage said 138 while 244 rows existed, on 11 of
 * 44 current runs.
 *
 * A frozen number is only safe while nothing else may write to what it counts,
 * and that stopped being true when the reviewer gained the ability to add. So
 * the segment is rebuilt from `fact` and `evidence_span` whenever the reviewer
 * commits, in the same transaction as the write that invalidated it.
 *
 * THE TWO CONTRIBUTIONS STAY APART. `origin_run_id` is what distinguishes a
 * value the extraction read from one the second reading added, and the ontology
 * this app is built on does not merge claims of different provenance into one
 * figure. One number would also be strictly less informative: "the reading found
 * 138 and the review added 106" says which reader to argue with, and the total
 * is still there to be counted against the table.
 *
 * Only the leading segment is touched. Everything after the first `;` is the
 * extraction's own INCOMPLETE lines, which are facts about what that stage
 * discarded and are not the reviewer's to restate.
 */
export function restampExtractNote(db: DB, analysisRunId: number): void {
  const counts = db
    .prepare(
      `SELECT
         SUM(CASE WHEN origin_run_id IS NULL THEN 1 ELSE 0 END) AS extracted,
         SUM(CASE WHEN origin_run_id IS NOT NULL THEN 1 ELSE 0 END) AS added
       FROM fact WHERE analysis_run_id = ?`
    )
    .get(analysisRunId) as { extracted: number | null; added: number | null } | undefined
  const extracted = counts?.extracted ?? 0
  const added = counts?.added ?? 0
  const spans = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM evidence_span WHERE analysis_run_id = ?`)
      .get(analysisRunId) as { n: number }
  ).n
  const segment =
    added > 0
      ? `${extracted} fact(s) from this reading + ${added} added by the review = ` +
        `${extracted + added} fact(s), ${spans} evidence span(s)`
      : `${extracted} fact(s), ${spans} evidence span(s)`

  const rows = db
    .prepare(
      `SELECT id, outcome_note FROM stage_run
        WHERE stage = 'schema-extract' AND analysis_run_id = ?`
    )
    .all(analysisRunId) as Array<{ id: number; outcome_note: string | null }>
  const setRun = db.prepare(`UPDATE stage_run SET outcome_note = ? WHERE id = ?`)
  // The job carries its own copy of the note, and that copy is what the Ingest
  // screen renders. Updating one of the two would leave the user's window
  // showing the number this function exists to correct.
  const setJob = db.prepare(
    `UPDATE processing_job SET outcome_note = ? WHERE stage_run_id = ? AND outcome_note IS NOT NULL`
  )
  for (const r of rows) {
    const rewritten = rewriteLeadingCount(r.outcome_note, segment)
    if (rewritten === null || rewritten === r.outcome_note) continue
    setRun.run(rewritten, r.id)
    setJob.run(rewritten, r.id)
  }
}

/**
 * Replace the leading `… fact(s) …` segment, and only when one is there.
 *
 * A note that does not open with a count belongs to a run that reported
 * something else entirely (a refusal, a shortfall with no rows), and inventing
 * a count for it would put a number where the stage deliberately gave none.
 */
export function rewriteLeadingCount(note: string | null, segment: string): string | null {
  if (note === null) return null
  const cut = note.indexOf(';')
  const head = cut === -1 ? note : note.slice(0, cut)
  if (!/^\s*\d+ fact\(s\)/.test(head)) return null
  return cut === -1 ? segment : segment + note.slice(cut)
}
