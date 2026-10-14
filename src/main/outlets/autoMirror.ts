// Auto-mirror: rewrite a paper's note whenever its analysis is (re)generated.
//
// Subscribes to the pipeline's post-commit event rather than being called from
// it, so the pipeline knows nothing about outlets and a vault problem can never
// fail an analysis.
//
// DEBOUNCED. Analysing a project fans out over every paper, and each commit
// would otherwise trigger its own vault write — hundreds of writes and hundreds
// of filesystem round-trips for a result that only needs to be correct once the
// batch settles. Runs coalesce per project into a single write a short pause
// after the last commit.

import type { DB } from '../db/connection'
import { onAnalysisCommitted } from '../llm/events'
import { readOutletSettings, recordOutletRun } from './settings'
import { buildProjectNotes } from './obsidian/build'
import { writeNotes } from './obsidian/write'
import { vaultProblem } from './obsidian/vault'

/**
 * How long to wait for a batch to settle.
 *
 * Long enough that a fan-out over a corpus collapses into one write, short
 * enough that a single re-analysis feels immediate.
 */
const DEBOUNCE_MS = 1500

const pending = new Map<number, NodeJS.Timeout>()

/**
 * Start auto-mirroring. Returns an unsubscribe function.
 *
 * `getDb` is a getter rather than a handle because the database is opened after
 * this is wired up, and may be replaced (tests swap it per case).
 */
export function startAutoMirror(getDb: () => DB): () => void {
  const unsubscribe = onAnalysisCommitted((event) => {
    // The global sentinel is not a project with a vault; only real projects
    // mirror.
    if (event.projectId <= 0) return

    const settings = readOutletSettings(getDb(), 'obsidian')
    if (!settings.auto_mirror || !settings.vault_path) return

    const existing = pending.get(event.projectId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      pending.delete(event.projectId)
      void mirrorProject(getDb(), event.projectId)
    }, DEBOUNCE_MS)
    // Never hold the process open for a pending mirror; a run that has not
    // fired by shutdown is simply not owed.
    timer.unref?.()
    pending.set(event.projectId, timer)
  })

  return () => {
    for (const timer of pending.values()) clearTimeout(timer)
    pending.clear()
    unsubscribe()
  }
}

/**
 * Write the project's notes, recording the outcome for the panel.
 *
 * NEVER passes `force`: an automatic job must not overwrite a note the user has
 * edited by hand. Those are reported as conflicts and left alone, and the user
 * can resolve them deliberately from the panel.
 */
async function mirrorProject(db: DB, projectId: number): Promise<void> {
  const settings = readOutletSettings(db, 'obsidian')
  if (!settings.vault_path) return
  try {
    const problem = await vaultProblem(settings.vault_path)
    if (problem) {
      recordOutletRun(db, 'obsidian', { at: new Date().toISOString(), error: problem })
      return
    }
    const notes = buildProjectNotes(db, projectId)
    const outcome = await writeNotes(settings.vault_path, settings.folder, notes, {
      backlinks: settings.backlinks
    })
    recordOutletRun(db, 'obsidian', {
      at: new Date().toISOString(),
      error: outcome.failed.length > 0 ? outcome.failed[0].error : null
    })
  } catch (e) {
    // Recorded, not thrown: the panel shows it, and analysis is unaffected.
    recordOutletRun(db, 'obsidian', {
      at: new Date().toISOString(),
      error: e instanceof Error ? e.message : String(e)
    })
  }
}
