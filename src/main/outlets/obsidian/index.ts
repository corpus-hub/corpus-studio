// The Obsidian outlet: mirror this project's analyses into a vault as markdown.
//
// Everything the panel offers is real. The vault path is chosen with a native
// folder picker and stored; the toggles persist; and "Write notes" writes files
// and reports the paths it wrote. Nothing here is a preview of a feature that
// does not exist.

import { rm } from 'node:fs/promises'
import type { DB } from '../../db/connection'
import type { Outlet, OutletActionResult, OutletStatus } from '../types'
import { readOutletRun, readOutletSettings, recordOutletRun } from '../settings'
import { looksLikeVault, vaultProblem } from './vault'
import { buildProjectNotes } from './build'
import { orphanNotes, writeNotes, type WriteOutcome } from './write'

/** Human summary of a write, naming every outcome that actually occurred. */
function summarise(o: WriteOutcome): string {
  const parts: string[] = []
  if (o.created.length) parts.push(`${o.created.length} created`)
  if (o.updated.length) parts.push(`${o.updated.length} updated`)
  if (o.unchanged.length) parts.push(`${o.unchanged.length} already up to date`)
  if (o.conflicted.length) parts.push(`${o.conflicted.length} left alone (edited by hand)`)
  if (o.failed.length) parts.push(`${o.failed.length} failed`)
  // "Nothing to do" is a real outcome and says so, rather than reporting a
  // success that involved no work.
  return parts.length > 0 ? parts.join(' · ') : 'nothing to write'
}

async function status(db: DB, projectId: number): Promise<OutletStatus> {
  const s = readOutletSettings(db, 'obsidian')
  const problem = await vaultProblem(s.vault_path)
  const isVault = s.vault_path && !problem ? await looksLikeVault(s.vault_path) : false
  const noteCount = buildProjectNotes(db, projectId).length
  const run = readOutletRun(db, 'obsidian')

  return {
    // Choosing a folder IS enabling this outlet — there was also an "enabled"
    // switch, which claimed to gate writing ("Write notes when you ask, below")
    // and gated nothing: the button wrote files with the switch off. A second
    // opt-in that the primary action ignores is worse than no switch, so the
    // folder is the only state. Automatic mirroring keeps its own toggle,
    // because that one really is a separate decision.
    headline: !s.vault_path
      ? 'No vault chosen yet'
      : problem
        ? problem
        : `Writing notes to ${s.vault_path}`,
    ready: Boolean(s.vault_path) && !problem,
    checks: [
      {
        label: 'Vault folder chosen',
        ok: Boolean(s.vault_path),
        detail: s.vault_path ?? 'no folder chosen yet'
      },
      {
        // A DEFINITE no when nothing has been chosen: "unknown" is for a check
        // that could not be answered, and "there is no folder to test" is an
        // answer. Reserving null for genuine uncertainty keeps it meaningful.
        label: 'Folder is writable',
        ok: s.vault_path ? problem === null : false,
        detail: problem ?? 'this app can create files there'
      },
      {
        // Reported, not required: writing markdown into a plain folder is a
        // legitimate thing to want, so this informs rather than blocks.
        label: 'Looks like an Obsidian vault',
        ok: !s.vault_path || problem ? false : isVault,
        detail: isVault ? 'a .obsidian folder is present' : 'no .obsidian folder was found here'
      },
      {
        label: 'Papers ready to mirror',
        ok: noteCount > 0,
        detail: `${noteCount} paper${noteCount === 1 ? '' : 's'} in this project`
      }
    ],
    // A previous run is only worth reporting while it still describes the
    // CURRENT configuration. Without this guard the card said "Last written
    // 7/27/2026, 8:45 PM" on a machine with no vault chosen — a claim about
    // files that, as far as this configuration goes, were never written.
    lastError: s.vault_path ? run.error : null,
    lastRunAt: s.vault_path ? run.at : null
  }
}

/** Shared by the write actions; `force` overwrites hand-edited notes. */
async function doWrite(db: DB, projectId: number, force: boolean): Promise<OutletActionResult> {
  const s = readOutletSettings(db, 'obsidian')
  const problem = await vaultProblem(s.vault_path)
  if (problem || !s.vault_path) {
    return { ok: false, message: problem ?? 'No vault chosen.', error: problem ?? 'no vault' }
  }

  const notes = buildProjectNotes(db, projectId)
  try {
    const outcome = await writeNotes(s.vault_path, s.folder, notes, {
      backlinks: s.backlinks,
      force
    })
    const orphans = await orphanNotes(s.vault_path, s.folder, notes)
    // A partial failure is a FAILURE, and names the first reason: reporting
    // "24 created" while three threw would be a success the user did not get.
    const failed = outcome.failed.length > 0
    const message =
      summarise(outcome) +
      (orphans.length > 0
        ? ` · ${orphans.length} note${orphans.length === 1 ? '' : 's'} here no longer match a paper (left in place)`
        : '')

    recordOutletRun(db, 'obsidian', {
      at: new Date().toISOString(),
      error: failed ? outcome.failed[0].error : null
    })
    return {
      ok: !failed,
      message,
      paths: [...outcome.created, ...outcome.updated],
      error: failed ? outcome.failed[0].error : undefined
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    recordOutletRun(db, 'obsidian', { at: new Date().toISOString(), error })
    return { ok: false, message: `Could not write notes — ${error}`, error }
  }
}

function notReady(db: DB, projectId: number): string | null {
  const s = readOutletSettings(db, 'obsidian')
  if (!s.vault_path) return 'Choose a vault folder first.'
  if (buildProjectNotes(db, projectId).length === 0) {
    return 'This project has no papers to mirror yet.'
  }
  return null
}

/**
 * Delete notes WE wrote that no longer correspond to a paper in the project.
 *
 * Offered as its own explicit, confirmed action rather than folded into the
 * write: a paper removed from a project might mean "delete the note" or might
 * mean the user moved it deliberately, and the app does not get to decide that
 * inside somebody's vault. Only files carrying our stamp are candidates — the
 * user's own markdown in that folder is never touched.
 */
async function doCleanup(db: DB, projectId: number): Promise<OutletActionResult> {
  const s = readOutletSettings(db, 'obsidian')
  if (!s.vault_path) return { ok: false, message: 'No vault chosen.', error: 'no vault' }
  try {
    const orphans = await orphanNotes(s.vault_path, s.folder, buildProjectNotes(db, projectId))
    if (orphans.length === 0) {
      return { ok: true, message: 'Nothing to remove — every note here matches a paper.' }
    }
    const removed: string[] = []
    const failed: string[] = []
    for (const path of orphans) {
      try {
        await rm(path)
        removed.push(path)
      } catch (e) {
        failed.push(`${path}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return {
      ok: failed.length === 0,
      message:
        `${removed.length} note${removed.length === 1 ? '' : 's'} removed` +
        (failed.length > 0 ? ` · ${failed.length} could not be deleted` : ''),
      paths: removed,
      error: failed[0]
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    return { ok: false, message: `Could not tidy the folder — ${error}`, error }
  }
}

export const obsidianOutlet: Outlet = {
  id: 'obsidian',
  name: 'Obsidian',
  tagline: 'Mirror this project as markdown notes in a vault.',
  status,
  actions: [
    {
      id: 'write',
      label: 'Write notes',
      description:
        'Creates or updates one note per paper. Notes you have edited by hand are left alone.',
      writes: true,
      disabledReason: notReady,
      run: (db, projectId) => doWrite(db, projectId, false)
    },
    {
      id: 'overwrite',
      label: 'Overwrite hand-edited notes',
      description:
        'Same, but also replaces notes you have edited since they were written. Your edits are lost.',
      writes: true,
      disabledReason: notReady,
      run: (db, projectId) => doWrite(db, projectId, true)
    },
    {
      id: 'cleanup',
      label: 'Remove notes for deleted papers',
      description:
        'Deletes notes in this folder that no longer match a paper in the project. Only notes Corpus Studio wrote are touched.',
      writes: true,
      disabledReason: (db) =>
        readOutletSettings(db, 'obsidian').vault_path ? null : 'Choose a vault folder first.',
      run: doCleanup
    }
  ]
}
