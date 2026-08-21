import type { Database } from 'better-sqlite3'
import { currentDevLogScope, isDevLogEnabled } from '../devlog'

/** What one completion cost, and whether its answer turned out to be usable. */
export interface TokenRecord {
  model: string
  provider: string
  attempt: number
  ok: boolean
  /** Why the answer was unusable, when it was. */
  failure?: 'truncated' | 'invalid' | null
  /**
   * Input billed at the BASE RATE ONLY — not the whole prompt.
   *
   * The other two thirds are below. They are separate because they are priced
   * differently, so summing them here would destroy the only thing that lets
   * this table be turned back into a cost.
   */
  promptTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  completionTokens: number
  totalTokens: number
  durationMs: number
}

/**
 * How the ledger reaches a database without `provider.ts` learning about one.
 *
 * `provider.ts` is the one file every LLM call passes through and it
 * deliberately knows nothing about works, documents or storage — that ignorance
 * is why it can be the choke point. Importing `getDb` there would end it. So the
 * handle is pushed in from startup instead.
 *
 * Left null in the electron-as-node scripts and anywhere no corpus is open,
 * where a write would otherwise fail for want of a handle this module has no
 * business opening for itself.
 */
let db: Database | null = null
export function setTokenLedgerDb(handle: Database | null): void {
  db = handle
}

/**
 * Record one completion's cost against the paper and stage that spent it.
 *
 * GATED ON DEVELOPER MODE, because the ATTRIBUTION is. `currentDevLogScope()`
 * reads an `AsyncLocalStorage` frame that `withDevLogScope` only establishes
 * when the diagnostic log is on; with it off, every column that says WHAT the
 * tokens were spent on is null. Recording anyway would fill the table with rows
 * naming no paper and no stage — which is the one thing it exists to say — and
 * those rows would be indistinguishable from a genuine attribution failure.
 *
 * NEVER THROWS. This runs inside the LLM call path, and a bookkeeping write that
 * failed a completion the user has already paid for would turn an accounting
 * problem into an outage.
 */
export function recordTokenUsage(rec: TokenRecord): void {
  if (!isDevLogEnabled() || !db) return
  try {
    const s = currentDevLogScope() ?? {}
    db.prepare(
      `INSERT INTO llm_token_usage
         (at, model, provider, stage, purpose, work_id, document_id, project_id,
          schema_id, analysis_run_id, stage_run_id, job_id, attempt, ok, failure,
          prompt_tokens, cache_creation_tokens, cache_read_tokens,
          completion_tokens, total_tokens, duration_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      new Date().toISOString(),
      rec.model,
      rec.provider,
      s.stage ?? null,
      s.purpose ?? null,
      s.workId ?? null,
      s.documentId ?? null,
      s.projectId ?? null,
      s.schemaId ?? null,
      s.analysisRunId ?? null,
      s.stageRunId ?? null,
      s.jobId ?? null,
      rec.attempt,
      rec.ok ? 1 : 0,
      rec.failure ?? null,
      rec.promptTokens,
      rec.cacheCreationTokens,
      rec.cacheReadTokens,
      rec.completionTokens,
      rec.totalTokens,
      rec.durationMs
    )
  } catch {
    // Deliberately silent: see above.
  }
}
