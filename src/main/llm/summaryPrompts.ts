// The EFFECTIVE writing brief for each of the two summaries, once the user has
// had their say.
//
// Both briefs ship with a built-in default (the text in `prompts.ts`, which is
// the only place either is written). Either can be overridden: the GENERAL brief
// once, for the whole corpus, in Settings; the PROJECT brief per project, on the
// project itself. An unset or blank override means "use the built-in", never
// "use an empty prompt" — a blank system message would hand the model a summary
// task with no instructions and the prose would still arrive, plausibly, wrong.
//
// WHY THIS IS A SEPARATE MODULE. `freshness.ts` has to resolve the same brief
// the runner did, and it is forbidden from importing `repositories.ts` (which
// imports it). So the two reads this needs — one `setting` row and one `project`
// column — are done here in raw SQL, and both callers ask the same function.
//
// THE STAMP is the whole invalidation mechanism, and it is deliberately not a
// new one. `analysis_run.prompt_version` already decides freshness and already
// feeds `doc_input_hash`; a customised brief simply extends that stamp with a
// digest of its own text:
//
//     built-in   ->  "v2"
//     customised ->  "v2+custom-1a2b3c4d"
//
// So a corpus written under the built-in default keeps the byte-identical stamp
// it has today and nothing invalidates on upgrade, while editing a brief moves
// the stamp, which moves the stage fingerprint, the reuse comparison and the
// freshness verdict together. The base version stays at the front so the
// registry lookup that recovers "which brief was this" still succeeds.

import type { DB } from '../db/connection'
import { hashInput } from '../adapters'
import { getPrompt, summaryPromptName, type SummaryPromptName } from './prompts'
import type { SummaryPromptDTO } from '@shared/contract'

/** Which of the two briefs. Mirrors `SummaryKind` in `summary.ts`. */
export type SummaryPromptScope = 'general' | 'project'

/** The `setting` key holding the corpus-wide override of the general brief. */
export const GENERAL_SUMMARY_PROMPT_KEY = 'summary_general_prompt'

export interface EffectiveSummaryPrompt {
  /** The system message actually sent. */
  system: string
  /** The registry version of the brief this overrides or is. */
  baseVersion: string
  /** What `analysis_run.prompt_version` records. */
  stamp: string
  /** Whether the text came from the user rather than from the registry. */
  custom: boolean
}

function registryName(scope: SummaryPromptScope): SummaryPromptName {
  return scope === 'general' ? 'summary-general' : 'summary-project'
}

/**
 * Blank is not an override.
 *
 * Whitespace-only counts as blank: a textarea the user cleared and left holds a
 * newline, and storing that would silently ship an empty system prompt.
 */
function normaliseOverride(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const t = raw.trim()
  return t === '' ? null : t
}

/** The stored override of the general brief, or null for the built-in. */
export function readGeneralOverride(db: DB): string | null {
  const row = db.prepare('SELECT value FROM setting WHERE key = ?').get(GENERAL_SUMMARY_PROMPT_KEY) as
    | { value: string }
    | undefined
  return normaliseOverride(row?.value)
}

/** One project's override of the project brief, or null for the built-in. */
export function readProjectOverride(db: DB, projectId: number): string | null {
  if (projectId <= 0) return null
  const row = db.prepare('SELECT summary_prompt FROM project WHERE id = ?').get(projectId) as
    | { summary_prompt: string | null }
    | undefined
  return normaliseOverride(row?.summary_prompt)
}

export function readOverride(
  db: DB,
  scope: SummaryPromptScope,
  projectId: number
): string | null {
  return scope === 'general' ? readGeneralOverride(db) : readProjectOverride(db, projectId)
}

/**
 * Persist an override. `null` (or blank) REMOVES it and returns the brief to the
 * built-in — which is what makes "restore the default" a real action rather than
 * an instruction to paste the original text back by hand.
 */
export function writeOverride(
  db: DB,
  scope: SummaryPromptScope,
  projectId: number,
  text: string | null
): void {
  const value = normaliseOverride(text)
  const now = new Date().toISOString()
  if (scope === 'general') {
    if (value === null) {
      db.prepare('DELETE FROM setting WHERE key = ?').run(GENERAL_SUMMARY_PROMPT_KEY)
      return
    }
    db.prepare(
      `INSERT INTO setting (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(GENERAL_SUMMARY_PROMPT_KEY, value, now)
    return
  }
  if (projectId <= 0) {
    throw new Error(
      `writeOverride: a project summary prompt needs a real project id (got ${projectId}); 0 is the global sentinel`
    )
  }
  db.prepare('UPDATE project SET summary_prompt = ?, updated_at = ? WHERE id = ?').run(
    value,
    now,
    projectId
  )
}

/**
 * One brief as the editor needs it: what is in force, and what it replaces.
 *
 * Both go over together on every read AND on every write, so the pane never has
 * to hold a stale idea of which of the two it is showing.
 *
 * Resolved from the SCOPE, not from the project id, because `projectId = 0` is
 * ambiguous here in a way it is nowhere else: for `general` it is the sentinel,
 * and for `project` it means "no project yet" — which is exactly what the
 * creation form is asking about, and it must be answered with the PROJECT
 * built-in rather than with the general brief `summaryPromptName(0)` would name.
 */
export function summaryPromptDto(
  db: DB,
  scope: SummaryPromptScope,
  projectId: number
): SummaryPromptDTO {
  const registered = getPrompt(registryName(scope))
  const override = readOverride(db, scope, projectId)
  return {
    scope,
    text: override ?? registered.system,
    builtin: registered.system,
    custom: override !== null,
    stamp: summaryPromptStamp(registered.version, override)
  }
}

/** The digest that distinguishes one custom brief from another. */
function customDigest(text: string): string {
  return hashInput({ summaryPrompt: text }).slice(0, 8)
}

export function summaryPromptStamp(baseVersion: string, custom: string | null): string {
  return custom === null ? baseVersion : `${baseVersion}+custom-${customDigest(custom)}`
}

/**
 * Split a stored stamp back into the registry version and the customisation.
 *
 * `freshness.ts` needs both halves: the base to ask the registry whether the
 * brief is still defined, and the digest to compare against the brief as it
 * stands now. A stamp with no `+custom-` suffix parses to a null digest, which
 * is exactly what a run written under the built-in default should say.
 */
export function parseSummaryPromptStamp(stamp: string): {
  baseVersion: string
  customDigest: string | null
} {
  const at = stamp.indexOf('+custom-')
  if (at === -1) return { baseVersion: stamp, customDigest: null }
  return { baseVersion: stamp.slice(0, at), customDigest: stamp.slice(at + '+custom-'.length) }
}

/**
 * The brief a summary of `projectId` would be written with right now.
 *
 * `projectId` is the STORED project id — 0 for the general summary — so this
 * takes exactly the argument `summaryPromptName` does and cannot disagree with
 * it about which of the two is being resolved.
 */
export function effectiveSummaryPrompt(db: DB, projectId: number): EffectiveSummaryPrompt {
  const name = summaryPromptName(projectId)
  const scope: SummaryPromptScope = name === 'summary-general' ? 'general' : 'project'
  const registered = getPrompt(name)
  const override = readOverride(db, scope, projectId)
  return {
    system: override ?? registered.system,
    baseVersion: registered.version,
    stamp: summaryPromptStamp(registered.version, override),
    custom: override !== null
  }
}
