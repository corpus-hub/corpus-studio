// HOW MANY PAPERS THE APP WORKS ON AT ONCE, and where that number is decided.
//
// ONE module owns it. The number used to be a literal at the scheduler's
// construction site in `index.ts`, so the only way to change it was to edit and
// rebuild, and the limit the user was subject to appeared nowhere they could
// read it. Now it is stored, read here, and the scheduler asks on every dispatch
// decision rather than capturing a value at construction — so a change takes
// effect on the next tick instead of the next launch.
//
// THE LIMIT IS ABSOLUTE, ACROSS THE WHOLE APP. Not per project, not per paper.
// `claim()` selects by priority and id with no project predicate, and the LLM
// gate is a module singleton, so two projects processing at once share this one
// number. A per-project allowance would mean two projects did twice the work of
// one, which is the thing a limit exists to prevent. The UI says so out loud,
// because someone watching two projects move has no way to tell otherwise.
//
// ONLY ONE SETTING LIVES HERE, deliberately. The loop's idle delay, the retry
// budget and the lease timeout are all tunable in principle and none of them is
// a question a user can answer — offering them would fill the pane with numbers
// whose only honest advice is "leave it alone", and that buries the one setting
// that does change what the user experiences.

import type { DB } from '../db/connection'
import { getSetting, setSetting } from '../db/repositories'
import { LLM_GATE } from './gate/llmGate'

export const QUEUE_LLM_KEY = 'queue_llm_concurrency'
export const QUEUE_LOCAL_KEY = 'queue_local_concurrency'

/**
 * TWO limits, because the two kinds of work are limited by different things and
 * a single number could only ever be right for one of them.
 *
 * An AI step waits on a remote model: it uses almost no CPU, and the ceiling is
 * what the gateway will accept and what the user is willing to spend. A local
 * step — reading a PDF, OCR, segmenting, embedding — is the opposite: it is
 * pure CPU on this machine and does not care about the gateway at all. Sharing
 * one number meant raising it to overlap two model calls also started two OCR
 * runs, which is how a laptop ends up unusable while it waits on the network.
 */
export const QUEUE_DEFAULTS = {
  /**
   * AI steps in flight at once, across the whole app.
   *
   * 1 is the shipped value and the conservative one: it is the setting that
   * costs money and hits a rate limit, so the default must not surprise anyone
   * with a bill or a 429. Raising it is a deliberate act.
   */
  llm: 1,
  /**
   * Local steps in flight at once, across the whole app.
   *
   * 2, so a second paper's text extraction can proceed while the first is being
   * OCR'd, without handing the whole machine to the queue.
   */
  local: 2
} as const

/** What a user may choose, and what the UI must therefore refuse outside of. */
export const QUEUE_LIMITS = {
  llm: { min: 1, max: 8 },
  local: { min: 1, max: 8 }
} as const

export interface QueueSettings {
  /** Max AI steps running at once, for the WHOLE app. */
  llm: number
  /** Max local (non-AI) steps running at once, for the WHOLE app. */
  local: number
  /**
   * False once the user has changed either, so the UI can offer a reset.
   *
   * Snake case because this crosses IPC as `QueueSettingsDTO` unchanged; a
   * camelCase field here would need a mapping layer whose only job is to
   * rename one boolean.
   */
  is_default: boolean
}

/** The stored value, or null for "never chosen" — which includes a bad row. */
function readOne(db: DB, key: string, min: number, max: number): number | null {
  const raw = getSetting(db, key)
  if (raw === null) return null
  const n = Number.parseInt(raw, 10)
  // A stored value out of range is treated as absent rather than clamped. It can
  // only arrive from a hand-edited database or an older build with a wider
  // range, and silently running at a bound the user never chose is worse than
  // running at the default a fresh install would get.
  if (!Number.isFinite(n) || n < min || n > max) return null
  return n
}

export function readQueueSettings(db: DB): QueueSettings {
  const llm = readOne(db, QUEUE_LLM_KEY, QUEUE_LIMITS.llm.min, QUEUE_LIMITS.llm.max)
  const local = readOne(db, QUEUE_LOCAL_KEY, QUEUE_LIMITS.local.min, QUEUE_LIMITS.local.max)
  return {
    llm: llm ?? QUEUE_DEFAULTS.llm,
    local: local ?? QUEUE_DEFAULTS.local,
    is_default: llm === null && local === null
  }
}

export function writeQueueSettings(db: DB, next: { llm?: number; local?: number }): QueueSettings {
  const check = (what: string, v: number, min: number, max: number): void => {
    if (!Number.isInteger(v) || v < min || v > max) {
      throw new Error(`${what} must be a whole number between ${min} and ${max}`)
    }
  }
  if (next.llm !== undefined) {
    check('the number of AI steps at once', next.llm, QUEUE_LIMITS.llm.min, QUEUE_LIMITS.llm.max)
    setSetting(db, QUEUE_LLM_KEY, String(next.llm))
  }
  if (next.local !== undefined) {
    check(
      'the number of other steps at once',
      next.local,
      QUEUE_LIMITS.local.min,
      QUEUE_LIMITS.local.max
    )
    setSetting(db, QUEUE_LOCAL_KEY, String(next.local))
  }
  return readQueueSettings(db)
}

/**
 * Forget every choice, so the next read returns the shipped values.
 *
 * The rows are DELETED rather than rewritten with the defaults. "Never chose"
 * and "chose exactly the default" are different facts: a future change to a
 * default should reach an install that never expressed a preference, and
 * writing the number in would freeze it at whatever this version shipped.
 */
export function resetQueueSettings(db: DB): QueueSettings {
  db.prepare('DELETE FROM setting WHERE key IN (?, ?)').run(QUEUE_LLM_KEY, QUEUE_LOCAL_KEY)
  return readQueueSettings(db)
}

/**
 * Push the stored AI limit into the gate that enforces it.
 *
 * The gate is the thing that actually admits calls, and it holds its capacity
 * in memory — so a stored number nobody applied is a setting the user changed
 * and the app ignored. Called at startup and after every write, which are the
 * only two moments the answer can change.
 *
 * The LOCAL limit needs no equivalent: the scheduler reads it per tick straight
 * from the database, so there is nothing to keep in step.
 */
export function applyQueueSettings(db: DB): QueueSettings {
  const s = readQueueSettings(db)
  LLM_GATE.setCapacity(s.llm)
  return s
}
