// The Zotero outlet: send this project's papers to a running library, and hand
// notes back as an importable file.
//
// NOTHING HERE TOUCHES `zotero.sqlite`. That file is locked while Zotero runs,
// its schema shifts between versions, and a bad write corrupts a reference
// library that may represent years of work — so papers go over Zotero's own
// local HTTP server, which performs every write itself, and notes leave through
// an RDF file Zotero imports with its own code.
//
// The outlet's STATUS is therefore about the connection, not about a folder:
// a user sending papers to a running Zotero was previously told "No Zotero
// library found" because their data directory was somewhere this app no longer
// needs to look.

import type { DB } from '../../db/connection'
import type { Outlet, OutletStatus } from '../types'
import { readOutletRun, readOutletSettings, readZoteroConnection } from '../settings'
import { defaultZoteroDir } from './library'
import { ping } from './connector'
import { buildProjectNotes } from '../obsidian/build'
import { planAttachments } from './attachments'

/** The directory to read: the user's override, else the convention. */
export function zoteroDir(db: DB): string {
  return readOutletSettings(db, 'zotero').data_dir ?? defaultZoteroDir()
}

async function status(db: DB, projectId: number): Promise<OutletStatus> {
  // WHAT THIS OUTLET IS NOW MEASURED BY: whether this project has somewhere to
  // send papers, and whether Zotero is up to receive them. It used to be judged
  // on a FOLDER — `zotero.sqlite` present and parseable in `~/Zotero` — which
  // was right while importing read that file, and became misleading the moment
  // everything moved to the connector: a user sending papers to a running
  // Zotero was told "No Zotero library found", because their data directory was
  // somewhere this app never needed to look.
  const conn = readZoteroConnection(db, projectId)
  const running = conn === null ? false : await ping()

  const run = readOutletRun(db, 'zotero')
  const notes = buildProjectNotes(db, projectId)
  // Counted the way the export will count. With `include_pdfs` on this is a
  // question about the DISK, not about the project — a paper whose file is on
  // an unmounted drive is not going in — so the panel must ask it the same way
  // rather than promising a number the export then quietly fails to meet.
  const settings = readOutletSettings(db, 'zotero')
  const plan = await planAttachments(notes, settings.include_pdfs)
  const noteCount = plan.exportable.length

  return {
    headline:
      conn === null
        ? 'Not connected'
        : running
          ? `Sending papers to ${conn.targetName}`
          : `Connected to ${conn.targetName} · Zotero is not running`,
    // READY MEANS "papers can reach Zotero right now" — connected AND up. The
    // panel's actions are gated on this, and a destination nobody is listening
    // at cannot receive anything.
    ready: conn !== null && running,
    checks: [
      {
        label: 'Connected to a collection',
        ok: conn !== null,
        detail:
          conn === null
            ? 'this project has not chosen where to send papers'
            : `papers go to ${conn.targetName}`
      },
      {
        label: 'Zotero is running',
        ok: conn === null ? false : running,
        detail:
          conn === null
            ? 'nothing to reach until a collection is chosen'
            : running
              ? 'answering on its local connector port'
              : 'start Zotero and leave it open — papers are added while it runs'
      },
      {
        label: 'Papers ready to send',
        ok: noteCount > 0,
        detail:
          `${noteCount} paper${noteCount === 1 ? '' : 's'} would be written to the import file` +
          // Named only when there IS a shortfall: on a project where every paper
          // has its file, "0 left out" is a line that appears on everything and
          // stops being read.
          (plan.skipped > 0
            ? ` · ${plan.skipped} left out, no readable PDF`
            : '')
      }
    ],
    lastError: run.error,
    lastRunAt: run.at
  }
}

export const zoteroOutlet: Outlet = {
  id: 'zotero',
  name: 'Zotero',
  tagline: 'Read your library, and hand notes back as a file Zotero imports.',
  status,
  // The two real actions (export RDF, import a collection) need a save dialog
  // and a collection argument respectively, so they are their own IPC endpoints
  // rather than argument-free `run()`s. This list stays empty rather than
  // holding buttons that would have to lie about what they can do.
  actions: []
}
