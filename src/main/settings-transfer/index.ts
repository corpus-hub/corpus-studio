// Export and import of this install's settings.
//
// THE DECRYPTED PAYLOAD NEVER LEAVES MAIN. `readSettingsFile` decrypts, holds
// the values here against a one-shot handle, and returns the renderer a
// DESCRIPTION — which items the file carries, in the same words the export
// dialog used. That is what lets the import dialog show what it is about to do
// without the gateway key crossing IPC, which `llm/gateway.ts`'s security
// contract forbids and `verify:offline` greps for.

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type {
  SettingsTransferItemDTO,
  SettingsTransferFileDTO,
  SettingsImportResultDTO
} from '@shared/contract'
import type { DB } from '../db/connection'
import { itemById, TRANSFER_ITEMS, TRANSFER_TABS } from './catalog'
import { openSettings, sealSettings, ENVELOPE_VERSION } from './envelope'

/**
 * What this install could export right now.
 *
 * `present` is a mechanical fact — the value exists, or it does not — so an
 * item the user has never configured is shown as unavailable rather than as an
 * empty checkbox that would silently export nothing.
 */
export function exportableItems(db: DB): SettingsTransferItemDTO[] {
  return TRANSFER_ITEMS.map((item) => ({
    id: item.id,
    tab: item.tab,
    tab_label: TRANSFER_TABS.find((t) => t.key === item.tab)?.label ?? item.tab,
    label: item.label,
    description: item.description,
    note: item.note ?? null,
    sensitive: item.sensitive === true,
    present: safeRead(db, item) !== null
  }))
}

function safeRead(db: DB, item: (typeof TRANSFER_ITEMS)[number]): unknown | null {
  try {
    return item.read(db)
  } catch {
    // A reader that throws makes the item unavailable, never the whole dialog:
    // one unreadable setting must not cost the user the export of the other six.
    return null
  }
}

interface FilePayload {
  format: 'corpus-studio-settings'
  version: number
  exported_at: string
  items: Record<string, unknown>
}

/** Build the encrypted bytes for the chosen items. */
export function buildSettingsFile(db: DB, ids: string[]): Buffer {
  const items: Record<string, unknown> = {}
  for (const id of ids) {
    const item = itemById(id)
    if (!item) continue
    const value = safeRead(db, item)
    if (value === null) continue
    items[id] = value
  }
  const payload: FilePayload = {
    format: 'corpus-studio-settings',
    version: ENVELOPE_VERSION,
    exported_at: new Date().toISOString(),
    items
  }
  return sealSettings(payload)
}

/**
 * A decrypted file, waiting for the user to choose what to apply.
 *
 * Keyed by an opaque handle so the renderer can say "apply these ids from that
 * file" without ever holding the values. Only the most recent survives: this is
 * one modal at a time, and keeping older ones would leave decrypted credentials
 * in memory for as long as the app ran.
 */
let pending: { handle: string; items: Record<string, unknown> } | null = null

/** Decrypt a file and describe it. Throws `SettingsFileError` on a bad file. */
export async function readSettingsFile(path: string): Promise<SettingsTransferFileDTO> {
  const raw = await readFile(path)
  const payload = openSettings(raw) as FilePayload

  // The envelope authenticated it, so this can only be a file we wrote — but a
  // shape check still runs, because a FUTURE version's payload would decrypt
  // cleanly and then be read as if its fields meant what they mean today.
  if (
    typeof payload !== 'object' ||
    payload === null ||
    payload.format !== 'corpus-studio-settings' ||
    typeof payload.items !== 'object' ||
    payload.items === null
  ) {
    const { SettingsFileError } = await import('./envelope')
    throw new SettingsFileError()
  }

  const handle = randomUUID()
  pending = { handle, items: payload.items }

  // Described from the CATALOG, not from the file: the file carries values, and
  // what an item is called and covers is this build's business. A file naming an
  // item this build does not have is simply not offered — no partial guess at
  // what an unknown id was for.
  const items: SettingsTransferItemDTO[] = TRANSFER_ITEMS.filter(
    (i) => Object.prototype.hasOwnProperty.call(payload.items, i.id)
  ).map((item) => ({
    id: item.id,
    tab: item.tab,
    tab_label: TRANSFER_TABS.find((t) => t.key === item.tab)?.label ?? item.tab,
    label: item.label,
    description: item.description,
    note: item.note ?? null,
    sensitive: item.sensitive === true,
    present: true
  }))

  const unknown = Object.keys(payload.items).filter((id) => !itemById(id)).length

  return {
    handle,
    exported_at: typeof payload.exported_at === 'string' ? payload.exported_at : null,
    items,
    unrecognised: unknown
  }
}

/**
 * Apply the chosen items from a previously-read file.
 *
 * PER ITEM, and each one on its own. A settings file is not one change but
 * several unrelated ones, so a storage path that no longer exists must not cost
 * the user the model selection in the same file. Every item is therefore either
 * applied whole or reported as skipped WITH the reason, and the result names
 * both lists — an import that half-worked in silence is the outcome this
 * structure exists to make unreachable.
 */
export async function applySettingsFile(
  db: DB,
  handle: string,
  ids: string[]
): Promise<SettingsImportResultDTO> {
  if (!pending || pending.handle !== handle) {
    throw new Error('That settings file is no longer open. Choose it again.')
  }
  const applied: string[] = []
  const skipped: Array<{ label: string; reason: string }> = []

  for (const id of ids) {
    const item = itemById(id)
    if (!item) continue
    if (!Object.prototype.hasOwnProperty.call(pending.items, id)) {
      skipped.push({ label: id, reason: 'not in this file' })
      continue
    }
    const parsed = item.schema.safeParse(pending.items[id])
    if (!parsed.success) {
      skipped.push({ label: item.label, reason: 'the file does not hold a usable value for it' })
      continue
    }
    try {
      await item.write(db, parsed.data)
      applied.push(item.label)
    } catch (err) {
      // The item's own words where it has them. Never the raw error: these
      // strings are rendered, and a value that could contain a credential must
      // not reach the screen through an exception message.
      skipped.push({
        label: item.label,
        reason: err instanceof Error && err.message.length < 120 ? err.message : 'it could not be applied'
      })
    }
  }

  return { applied, skipped }
}

/** Forget the decrypted file. Called when the import modal closes. */
export function closeSettingsFile(): void {
  pending = null
}
