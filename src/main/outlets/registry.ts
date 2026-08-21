// The one place that knows which outlets exist.
//
// Adding one is: write a module under `outlets/`, add it to the array below. The
// Integrations screen renders whatever this returns, so a new outlet appears in
// the UI without the UI changing.

import type { DB } from '../db/connection'
import type { Outlet, OutletId } from './types'
import { obsidianOutlet } from './obsidian'
import { zoteroOutlet } from './zotero'

const OUTLETS: Outlet[] = [zoteroOutlet, obsidianOutlet]

export function listOutlets(): Outlet[] {
  return OUTLETS
}

export function getOutlet(id: OutletId): Outlet {
  const found = OUTLETS.find((o) => o.id === id)
  if (!found) throw new Error(`unknown outlet '${id}'`)
  return found
}

/** Every outlet's status, probed in PARALLEL so one slow mount cannot stall the rest. */
export async function outletStatuses(
  db: DB,
  projectId: number
): Promise<Array<{ id: OutletId; name: string; tagline: string; status: Awaited<ReturnType<Outlet['status']>> }>> {
  return Promise.all(
    OUTLETS.map(async (o) => ({
      id: o.id,
      name: o.name,
      tagline: o.tagline,
      status: await o.status(db, projectId)
    }))
  )
}

/** The actions an outlet offers, with the reason each is unavailable right now. */
export function outletActions(
  db: DB,
  projectId: number,
  id: OutletId
): Array<{ id: string; label: string; description: string; writes: boolean; disabledReason: string | null }> {
  return getOutlet(id).actions.map((a) => ({
    id: a.id,
    label: a.label,
    description: a.description,
    writes: a.writes,
    disabledReason: a.disabledReason(db, projectId)
  }))
}

/**
 * Run one action.
 *
 * The disabled reason is re-checked HERE rather than trusted from the UI: the
 * vault may have been unmounted since the screen rendered, and a button that was
 * enabled a minute ago is not permission to write.
 */
export async function runOutletAction(
  db: DB,
  projectId: number,
  outletId: OutletId,
  actionId: string
): Promise<Awaited<ReturnType<Outlet['actions'][number]['run']>>> {
  const action = getOutlet(outletId).actions.find((a) => a.id === actionId)
  if (!action) throw new Error(`unknown action '${actionId}' for outlet '${outletId}'`)
  const blocked = action.disabledReason(db, projectId)
  if (blocked) return { ok: false, message: blocked, error: blocked }
  return action.run(db, projectId)
}
