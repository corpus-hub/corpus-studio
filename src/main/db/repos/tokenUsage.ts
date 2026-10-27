import type { Database } from 'better-sqlite3'
import type { TokenUsageQuery, TokenUsageSeriesDTO } from '@shared/contract'
import { isDevLogEnabled } from '../../devlog'

/**
 * Token spend per calendar day, filtered.
 *
 * Aggregated HERE rather than in the renderer: the ledger is one row per LLM
 * call, so a corpus run puts thousands across the IPC boundary to draw a few
 * dozen points.
 */
export function getTokenUsage(db: Database, q: TokenUsageQuery): TokenUsageSeriesDTO {
  const where: string[] = []
  const args: unknown[] = []
  // DATE() over the stored ISO string, so a bucket is a calendar day rather
  // than a 24-hour window measured from whenever the first call happened.
  if (q.from) {
    where.push('DATE(at) >= ?')
    args.push(q.from)
  }
  if (q.to) {
    where.push('DATE(at) <= ?')
    args.push(q.to)
  }
  if (q.model) {
    where.push('model = ?')
    args.push(q.model)
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const buckets = db
    .prepare(
      // THE THREE INPUT COLUMNS STAY APART.
      //
      // They were summed into one `promptTokens`, on the reasoning that
      // `prompt_tokens` alone under-reports a large prompt — true, and the sum
      // over-reports far worse. The counts are disjoint: `prompt_tokens` is
      // input the model PROCESSED, the cache halves are input written to or
      // served from the cache. A conversation that re-reads one cached document
      // across twenty turns adds that document twenty times to the total while
      // processing it once. Measured on this corpus: 40 tokens of fresh input
      // against 301,746 re-read, summed and shown as though 300k of work had
      // happened.
      //
      // Charted apart, a cache-heavy run is legible as what it is — a small
      // amount of new work over a large reused prefix — instead of alarming.
      `SELECT DATE(at) AS day,
              SUM(prompt_tokens) AS promptTokens,
              SUM(cache_creation_tokens) AS cacheWriteTokens,
              SUM(cache_read_tokens) AS cacheReadTokens,
              SUM(completion_tokens) AS completionTokens
         FROM llm_token_usage
         ${clause}
        GROUP BY DATE(at)
        ORDER BY day`
    )
    .all(...args) as Array<{
      day: string
      promptTokens: number
      cacheWriteTokens: number
      cacheReadTokens: number
      completionTokens: number
    }>

  // EVERY model in the ledger, deliberately unfiltered. Built from the filtered
  // rows instead, selecting a model would remove every other option and strand
  // the reader with no way back.
  const models = (
    db.prepare('SELECT DISTINCT model FROM llm_token_usage ORDER BY model').all() as Array<{
      model: string
    }>
  ).map((r) => r.model)

  // Also unfiltered: this is what tells "nothing has been recorded yet" apart
  // from "your filters exclude everything", which are different problems with
  // different remedies.
  const totalRows = (db.prepare('SELECT COUNT(*) AS n FROM llm_token_usage').get() as { n: number })
    .n

  return { buckets, models, collecting: isDevLogEnabled(), totalRows }
}
