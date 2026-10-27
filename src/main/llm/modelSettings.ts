// WHICH MODEL EACH KIND OF WORK USES, and how much room it is given.
//
// ONE module owns it, for the reason `queueSettings` owns concurrency: these
// were literals scattered across the stages that call the model — the extraction
// took whatever `pickModel` returned, the blind table reading named
// `claude-sonnet-5` in its own file, and the output budgets were two constants
// in two files that had to be found before either could be changed.
//
// TWO ROLES, NOT ONE, and the separation is the point rather than a convenience.
// The extraction reads every paper in the corpus and is the volume cost; the
// review reads a table a second time to disagree with the first reading, and its
// whole value is that it FAILS DIFFERENTLY. Running both on one model would make
// the second reading an echo of the first — it would share its blind spots, and
// a reviewer that shares the extractor's blind spots confirms rather than
// checks. So the two are chosen separately, and the default for review is a
// different, stronger model.
//
// THE CONTEXT WINDOW IS NOT A SETTING THE APP ENFORCES. It is a property of the
// model, and a paper is never trimmed to fit one: this app's rule is that a
// document is split across messages rather than truncated. It is stored and
// shown so the reader knows what they are working within, and so a future
// splitter can consult one number instead of guessing.

import type { DB } from '../db/connection'
import { getSetting, setSetting } from '../db/repositories'

export const EXTRACTION_MODEL_KEY = 'llm_extraction_model'
export const EXTRACTION_MAX_OUTPUT_KEY = 'llm_extraction_max_output'
export const EXTRACTION_CONTEXT_KEY = 'llm_extraction_context'
export const REVIEW_MODEL_KEY = 'llm_review_model'
export const REVIEW_MAX_OUTPUT_KEY = 'llm_review_max_output'
export const REVIEW_CONTEXT_KEY = 'llm_review_context'

/**
 * What the app ships with.
 *
 * BOTH ROLES ARE NAMED, and neither is left to the gateway. `pickModel` chooses
 * the cheapest model on offer, which is a decision about price made where a
 * decision about accuracy belongs — and it is silent, so a gateway that added a
 * cheaper model would change how every paper in the corpus was read without
 * anyone choosing it.
 *
 * Extraction is `claude-sonnet-5`. It was `claude-haiku`, chosen as fast and
 * cheap enough to run on every paper; reading a table off a page image turned
 * out not to be the cheap task it looked like, and the errors it produced were
 * the expensive kind — a value with a real quote beside it, wrong in a way no
 * check downstream can see. Review is `claude-sonnet-5` too. That costs the two
 * readings their independence of MODEL, which was worth having, but a reviewer
 * weaker than the extractor cannot correct it, and correcting is the job.
 *
 * UNDATED where the gateway offers an undated alias, which is not a cosmetic
 * choice. `claude-haiku` resolves to whichever haiku the gateway currently
 * serves, so a model rollover does not strand this app on a name that has been
 * retired. The dated form is accepted too — anything typed here is passed
 * through — but a name the gateway does not resolve fails every call, and
 * `claude-haiku-4-5` is one of those: the alias map has `haiku-4-5` and
 * `claude-haiku`, and nothing in between.
 *
 * The output budgets are generous rather than tuned. The failure is asymmetric:
 * a budget one fact short discards the rest of a table — fifteen extractions in
 * this corpus were filed `partial` for exactly that — while an unused allowance
 * costs nothing, since output is billed by what is produced and not by what was
 * permitted.
 */
export const MODEL_DEFAULTS = {
  extractionModel: 'claude-sonnet-5',
  extractionMaxOutput: 64000,
  extractionContext: 200000,
  reviewModel: 'claude-sonnet-5',
  reviewMaxOutput: 64000,
  reviewContext: 1000000
} as const

/**
 * What a user may choose.
 *
 * The ceilings are the largest any model this app talks to will serve, so a
 * number inside them is refused by the GATEWAY if that particular model cannot
 * honour it — which is a truthful error naming the model, and better than this
 * app second-guessing a limit that changes with every release.
 */
export const MODEL_LIMITS = {
  maxOutput: { min: 1024, max: 128000 },
  context: { min: 8192, max: 2000000 }
} as const

export interface ModelSettings {
  /** Empty means "let the gateway choose", which is what the app has always done. */
  extractionModel: string
  extractionMaxOutput: number
  extractionContext: number
  reviewModel: string
  reviewMaxOutput: number
  reviewContext: number
  /** False once the user has changed anything, so the UI can offer a reset. */
  is_default: boolean
}

function readInt(db: DB, key: string, min: number, max: number): number | null {
  const raw = getSetting(db, key)
  if (raw === null) return null
  const n = Number.parseInt(raw, 10)
  // Out of range is treated as ABSENT rather than clamped. Such a value can
  // only arrive from a hand-edited database or an older build with a wider
  // range, and silently running at a bound the user never chose is worse than
  // running at the default a fresh install would get.
  if (!Number.isFinite(n) || n < min || n > max) return null
  return n
}

export function readModelSettings(db: DB): ModelSettings {
  const em = getSetting(db, EXTRACTION_MODEL_KEY)
  const rm = getSetting(db, REVIEW_MODEL_KEY)
  const eo = readInt(db, EXTRACTION_MAX_OUTPUT_KEY, MODEL_LIMITS.maxOutput.min, MODEL_LIMITS.maxOutput.max)
  const ec = readInt(db, EXTRACTION_CONTEXT_KEY, MODEL_LIMITS.context.min, MODEL_LIMITS.context.max)
  const ro = readInt(db, REVIEW_MAX_OUTPUT_KEY, MODEL_LIMITS.maxOutput.min, MODEL_LIMITS.maxOutput.max)
  const rc = readInt(db, REVIEW_CONTEXT_KEY, MODEL_LIMITS.context.min, MODEL_LIMITS.context.max)
  return {
    extractionModel: em ?? MODEL_DEFAULTS.extractionModel,
    extractionMaxOutput: eo ?? MODEL_DEFAULTS.extractionMaxOutput,
    extractionContext: ec ?? MODEL_DEFAULTS.extractionContext,
    reviewModel: rm ?? MODEL_DEFAULTS.reviewModel,
    reviewMaxOutput: ro ?? MODEL_DEFAULTS.reviewMaxOutput,
    reviewContext: rc ?? MODEL_DEFAULTS.reviewContext,
    is_default:
      em === null && rm === null && eo === null && ec === null && ro === null && rc === null
  }
}

export function writeModelSettings(
  db: DB,
  next: Partial<Omit<ModelSettings, 'is_default'>>
): ModelSettings {
  const num = (what: string, v: number, min: number, max: number): void => {
    if (!Number.isInteger(v) || v < min || v > max) {
      throw new Error(`${what} must be a whole number between ${min} and ${max}`)
    }
  }
  if (next.extractionModel !== undefined) {
    setSetting(db, EXTRACTION_MODEL_KEY, next.extractionModel.trim())
  }
  if (next.reviewModel !== undefined) {
    setSetting(db, REVIEW_MODEL_KEY, next.reviewModel.trim())
  }
  if (next.extractionMaxOutput !== undefined) {
    num('the reading budget', next.extractionMaxOutput, MODEL_LIMITS.maxOutput.min, MODEL_LIMITS.maxOutput.max)
    setSetting(db, EXTRACTION_MAX_OUTPUT_KEY, String(next.extractionMaxOutput))
  }
  if (next.extractionContext !== undefined) {
    num('the reading context window', next.extractionContext, MODEL_LIMITS.context.min, MODEL_LIMITS.context.max)
    setSetting(db, EXTRACTION_CONTEXT_KEY, String(next.extractionContext))
  }
  if (next.reviewMaxOutput !== undefined) {
    num('the checking budget', next.reviewMaxOutput, MODEL_LIMITS.maxOutput.min, MODEL_LIMITS.maxOutput.max)
    setSetting(db, REVIEW_MAX_OUTPUT_KEY, String(next.reviewMaxOutput))
  }
  if (next.reviewContext !== undefined) {
    num('the checking context window', next.reviewContext, MODEL_LIMITS.context.min, MODEL_LIMITS.context.max)
    setSetting(db, REVIEW_CONTEXT_KEY, String(next.reviewContext))
  }
  return readModelSettings(db)
}

/**
 * Forget every choice, so the next read returns what the app ships with.
 *
 * The rows are DELETED rather than rewritten with the defaults. "Never chose"
 * and "chose exactly the default" are different facts: a later change to a
 * default should reach an install that never expressed a preference, and
 * writing the number in would freeze it at whatever this version shipped.
 */
export function resetModelSettings(db: DB): ModelSettings {
  db.prepare(
    `DELETE FROM setting WHERE key IN (?, ?, ?, ?, ?, ?)`
  ).run(
    EXTRACTION_MODEL_KEY,
    EXTRACTION_MAX_OUTPUT_KEY,
    EXTRACTION_CONTEXT_KEY,
    REVIEW_MODEL_KEY,
    REVIEW_MAX_OUTPUT_KEY,
    REVIEW_CONTEXT_KEY
  )
  return readModelSettings(db)
}
