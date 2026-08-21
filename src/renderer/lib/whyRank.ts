/**
 * Reading `project_work.ranking_explanation` back into the two axes it names.
 *
 * SHARED, because two screens draw this sentence — the Connectome's inspector
 * and the Ranking screen's popover — and a parser copied into both drifts. The
 * Ranking screen printed the stored paragraph verbatim for exactly as long as
 * this lived privately in the other file, so the same row read as two labelled
 * scores in one place and as a run-on in the other.
 */

/** One axis: the figure the writer printed, and the sentence explaining it. */
export type WhyRankSide = {
  /** Null when the axis was not scored, which is not the same as scoring zero. */
  score: string | null
  reason: string
}

/**
 * `notes` are the clauses belonging to neither axis by position — "you set
 * relevance by hand, so this run left it alone". They are shown UNATTRIBUTED:
 * the sentence orders its clauses by when they were decided, not by which score
 * they concern, so filing one under the row it happens to follow would be this
 * parser inventing an attribution the text does not carry.
 */
export type WhyRankParts = {
  relevance: WhyRankSide
  expansion: WhyRankSide
  notes: string[]
}

/**
 * "relevance 0.94 — a model compared its title and abstract against …" and
 * "expansion priority — its bibliography names 39 papers, against 214 …", the
 * two clauses the rerank stage writes, joined by "; ". The score is optional
 * because both axes have an unmeasured wording ("relevance not scored — …").
 */
const WHY_RANK_SEGMENT =
  /^(relevance|expansion[-_ ]priority)(?:\s+(not scored|[\d.]+))?\s*[—–-]\s*(.+)$/i

/**
 * Split the stored sentence into the structure a panel draws, or return null.
 *
 * NULL IS A REAL ANSWER, and every caller prints the raw paragraph on it. A
 * corpus holds rows written by older scorers whose shape this does not know,
 * and giving an unrecognised sentence a relevance heading and a score column
 * would be the UI asserting a reading of provenance it never obtained.
 */
export function parseWhyRank(raw: string): WhyRankParts | null {
  const clean = (s: string): string => s.replace(/\s+/g, ' ').trim().replace(/[.;]+$/, '')
  let relevance: WhyRankSide | null = null
  let expansion: WhyRankSide | null = null
  const notes: string[] = []
  for (const segment of raw.split(';')) {
    const text = clean(segment)
    if (!text) continue
    const m = text.match(WHY_RANK_SEGMENT)
    if (!m) {
      notes.push(text)
      continue
    }
    const rawScore = m[2] ? clean(m[2]) : ''
    const side: WhyRankSide = {
      score: rawScore === '' || rawScore.toLowerCase() === 'not scored' ? null : rawScore,
      reason: clean(m[3])
    }
    if (m[1].toLowerCase() === 'relevance') relevance = side
    else expansion = side
  }
  if (!relevance || !expansion) return null
  return { relevance, expansion, notes }
}
