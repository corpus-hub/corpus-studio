// WHAT a settings file can contain, and how each part is read and written.
//
// ONE list, in main, used by both directions. Export renders it, import matches
// against it, and the renderer receives only descriptions — so the export dialog
// and the import dialog cannot come to disagree about what an item is called or
// what it covers, and neither can offer an item the other cannot handle.
//
// AN ITEM IS THE UNIT OF DEPENDENCY, not the unit of storage. Where two values
// are only meaningful together they are ONE item with no way to take half:
// exporting an endpoint without its key produces an install that cannot
// authenticate, and there is no reading of the checkbox under which the user
// wanted that. The grouping is therefore in the DATA here, not in the UI's
// layout, where a future pane could quietly separate them again.

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod/v4'
import type { DB } from '../db/connection'
import { storageRootPath } from '../db/paths'
import { getSetting, setSetting } from '../db/repositories'
import { gatewayTransferValues, saveGatewayConfig } from '../llm/gateway'
import { applyMcpTransfer, mcpTransferValues } from '../mcp/index'
import { GENERAL_SUMMARY_PROMPT_KEY } from '../llm/summaryPrompts'
import { readModelSettings, writeModelSettings } from '../llm/modelSettings'
import { readQueueSettings, writeQueueSettings } from '../pipeline/queueSettings'

/** The Settings tab an item is configured on, so the dialogs can group by it. */
export type TransferTab = 'general' | 'ai' | 'queue' | 'mcp' | 'storage'

export const TRANSFER_TABS: Array<{ key: TransferTab; label: string }> = [
  { key: 'general', label: 'General' },
  { key: 'ai', label: 'AI' },
  { key: 'queue', label: 'Queue' },
  { key: 'mcp', label: 'MCP' },
  { key: 'storage', label: 'Storage' }
]

/**
 * One exportable/importable item.
 *
 * `read` returns `null` for "this install has not set it", which is what lets
 * the export dialog say so rather than offering an empty checkbox, and what
 * keeps an unset value from being written into the file as a spurious default.
 */
export interface TransferItem {
  id: string
  tab: TransferTab
  label: string
  /** What this item covers, in the user's terms. Rendered in both dialogs. */
  description: string
  /**
   * Named only when the item is MORE than its label implies — the endpoint+key
   * pair, the machine-specific paths. Silence is the normal case: a note on
   * every row is a note nobody reads, and it would take the two that matter
   * down with it.
   */
  note?: string
  /** True when the value can carry a credential, so the UI can say so ONCE. */
  sensitive?: boolean
  schema: z.ZodType
  read(db: DB): unknown | null
  write(db: DB, value: unknown): void | Promise<void>
}

/**
 * A plain `setting`-table string, for the items that are exactly one row.
 *
 * `null` when absent, so "never set" survives the round trip as "never set"
 * rather than becoming an explicit default the importing install then has to
 * distinguish from a real choice.
 */
function settingItem(opts: {
  id: string
  tab: TransferTab
  key: string
  label: string
  description: string
  schema: z.ZodType
  toStored?: (v: unknown) => string
  fromStored?: (s: string) => unknown
}): TransferItem {
  return {
    id: opts.id,
    tab: opts.tab,
    label: opts.label,
    description: opts.description,
    schema: opts.schema,
    read: (db) => {
      const raw = getSetting(db, opts.key)
      return raw === null ? null : (opts.fromStored ?? ((s: string) => s))(raw)
    },
    write: (db, value) => {
      setSetting(db, opts.key, (opts.toStored ?? String)(value))
    }
  }
}

const gatewayPair = z.object({
  endpoint: z.string().nullable(),
  key: z.string().nullable()
})

const mcpConfig = z.object({
  enabled: z.boolean(),
  port: z.number().int().min(1024).max(65_535),
  bindLan: z.boolean(),
  allowWrite: z.boolean(),
  allowDestructive: z.boolean()
})

const storageLocations = z.array(
  z.object({
    label: z.string().min(1),
    abs_path: z.string().min(1),
    kind: z.enum(['local', 'nas', 'cloud', 'removable'])
  })
)

export const TRANSFER_ITEMS: TransferItem[] = [
  // ------------------------------------------------------------------ general
  settingItem({
    id: 'dev_log',
    tab: 'general',
    key: 'dev_log_enabled',
    label: 'Developer log',
    description: 'Whether the app writes its diagnostic log.',
    schema: z.boolean(),
    toStored: (v) => (v ? '1' : '0'),
    fromStored: (s) => s === '1'
  }),

  // ----------------------------------------------------------------------- ai
  {
    // THE NAMED DEPENDENCY. One item, never two checkboxes.
    id: 'gateway',
    tab: 'ai',
    label: 'Where this app sends its requests',
    description: 'Where this app sends its requests, and its credentials.',
    sensitive: true,
    schema: gatewayPair,
    read: () => {
      const v = gatewayTransferValues()
      return v.endpoint === null && v.key === null ? null : v
    },
    write: (_db, value) => {
      const v = gatewayPair.parse(value)
      // `?? ''` and not `?? undefined`: an item the user chose to import states
      // BOTH halves, so an export taken before a key was set must clear the
      // key here rather than leaving the old one pointed at the new endpoint —
      // the mix `envSource` exists to prevent.
      saveGatewayConfig({ endpoint: v.endpoint ?? '', key: v.key ?? '' })
    }
  },
  {
    // ONE ITEM, NOT SIX. A model and the room it is given are one decision: a
    // model imported without its output budget can be asked for more than it
    // serves, and a budget imported without its model applies to whatever the
    // gateway happened to choose. The two roles travel together for the same
    // reason — the whole point of the reviewer is that it runs on a DIFFERENT
    // model from the extractor, and importing one half of that pair silently
    // makes the second reading an echo of the first.
    id: 'models',
    tab: 'ai',
    label: 'Which models do the work',
    description: 'The model each kind of work uses, and how much room it is given.',
    schema: z.object({
      extractionModel: z.string(),
      extractionMaxOutput: z.number().int(),
      extractionContext: z.number().int(),
      reviewModel: z.string(),
      reviewMaxOutput: z.number().int(),
      reviewContext: z.number().int()
    }),
    read: (db) => {
      const m = readModelSettings(db)
      // An install that never chose exports NOTHING, so importing it does not
      // pin the receiving install to this version's defaults.
      if (m.is_default) return null
      return {
        extractionModel: m.extractionModel,
        extractionMaxOutput: m.extractionMaxOutput,
        extractionContext: m.extractionContext,
        reviewModel: m.reviewModel,
        reviewMaxOutput: m.reviewMaxOutput,
        reviewContext: m.reviewContext
      }
    },
    write: (db, value) => {
      writeModelSettings(db, value as Parameters<typeof writeModelSettings>[1])
    }
  },
  {
    // Also one item: the two budgets are a single statement about how hard this
    // machine works, and importing the AI half without the local half describes
    // a machine nobody configured.
    id: 'queue_limits',
    tab: 'queue',
    label: 'How much runs at once',
    description: 'How many AI and local pipeline stages may run at the same time.',
    schema: z.object({ llm: z.number().int(), local: z.number().int() }),
    read: (db) => {
      const q = readQueueSettings(db)
      if (q.is_default) return null
      return { llm: q.llm, local: q.local }
    },
    write: (db, value) => {
      writeQueueSettings(db, value as { llm: number; local: number })
    }
  },
  settingItem({
    id: 'summary_prompt_general',
    tab: 'ai',
    key: GENERAL_SUMMARY_PROMPT_KEY,
    label: 'How papers are summarised',
    description: 'Your own instructions for the general summary.',
    schema: z.string().min(1)
  }),

  // ---------------------------------------------------------------------- mcp
  {
    // The port is not a setting on its own: importing it without the enabled
    // flag either moves a running server the user did not ask to move, or
    // records a port on a stopped one — and the same for the two permission
    // opt-ins, where `allowDestructive` alone is meaningless (it is a widening
    // of `allowWrite`, which may not have come with it).
    id: 'mcp',
    tab: 'mcp',
    label: 'MCP server',
    description: 'Whether the server runs, its port, and what agents may do through it.',
    schema: mcpConfig,
    read: () => mcpTransferValues(),
    write: async (_db, value) => {
      await applyMcpTransfer(mcpConfig.parse(value))
    }
  },

  // ------------------------------------------------------------------ storage
  {
    id: 'storage_locations',
    tab: 'storage',
    label: 'Storage locations',
    description: 'The folders this app looks for document files under.',
    // THE HONEST WARNING, and the reason this item is offered at all rather
    // than either silently included or silently dropped. See `write`.
    note: 'A folder is added only if it exists on the other machine.',
    schema: storageLocations,
    read: (db) => {
      const rows = db
        .prepare(
          `SELECT label, abs_path, kind FROM base_dir ORDER BY id ASC`
        )
        .all() as Array<{ label: string; abs_path: string; kind: string }>
      // The MANAGED library is excluded. It is created by `ensureStorageRoot()`
      // at whatever userData resolves to on the machine it runs on, so carrying
      // its path would either duplicate a root the receiving install already
      // has under a different path, or point a second row at the first one's
      // files. It is not a choice the user made and so is not theirs to move.
      const user = rows.filter((r) => !isManagedPath(r.abs_path))
      return user.length === 0 ? null : user
    },
    write: (db, value) => {
      const wanted = storageLocations.parse(value)
      // ADDITIVE, AND ONLY WHERE THE FOLDER EXISTS.
      //
      // A storage location is the one setting here whose value is a claim about
      // the machine rather than a preference, and the failure is asymmetric: a
      // location silently repointed at a path that is not there detaches every
      // document under it, and the user discovers it as papers that will not
      // open. So an imported path that does not resolve on THIS machine is
      // reported as skipped, and nothing existing is ever repointed or removed
      // — the import can only widen where the app looks, never move it.
      const existing = new Set(
        (db.prepare(`SELECT abs_path FROM base_dir`).all() as Array<{ abs_path: string }>).map(
          (r) => resolve(r.abs_path)
        )
      )
      const now = new Date().toISOString()
      for (const loc of wanted) {
        const abs = resolve(loc.abs_path)
        if (existing.has(abs)) continue
        if (!existsSync(abs)) continue
        db.prepare(
          `INSERT INTO base_dir (label, abs_path, kind, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`
        ).run(loc.label, abs, loc.kind, now, now)
        existing.add(abs)
      }
    }
  }
]

/** True for the ONE library the app creates and fills itself. */
function isManagedPath(absPath: string): boolean {
  return resolve(absPath) === resolve(storageRootPath())
}

export function itemById(id: string): TransferItem | undefined {
  return TRANSFER_ITEMS.find((i) => i.id === id)
}
