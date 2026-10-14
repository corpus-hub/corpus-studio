import { z } from 'zod/v4'
import type { Access, Entry } from '../types'
import { PROJECT_ENTRIES } from './projects'
import { WORK_ENTRIES } from './works'
import { SEARCH_ENTRIES } from './search'
import { GRAPH_ENTRIES } from './graph'
import { JOB_ENTRIES } from './jobs'
import { EXTRACTION_ENTRIES } from './extraction'
import { REVIEW_ENTRIES } from './review'
import { SUMMARY_ENTRIES } from './summary'
import { RANKING_ENTRIES } from './ranking'
import { READONLY_MISC_ENTRIES } from './readonlyMisc'
import { RERUN_ENTRIES } from './rerun'
import { TEXT_ENTRIES } from './text'
import { INGEST_ENTRIES } from './ingest'
import { TAB_ENTRIES } from './tabs'

/**
 * The definition of the agent-reachable IPC surface — which happens to also
 * serve the UI.
 *
 * THIS IS NOT "THE NEW HOME OF ALL IPC", and the migration into it is
 * deliberately PARTIAL. Do not try to finish it. Three reasons it stops where
 * it stops:
 *
 * 1. `window:setBounds` uses `safeParse` ON PURPOSE — the renderer fires it from
 *    `pointermove` and `void`s the promise, so a throw becomes an unhandled
 *    rejection. A uniform `.parse` loop would reintroduce a bug the comment
 *    there exists to record.
 * 2. A `misc` domain would have to import `dialog`, `shell` and `screen`,
 *    destroying the property that makes this directory loadable — and therefore
 *    checkable — without Electron.
 * 3. Some 27 channels (`settings:*` bar two, `storage:*`, `pdf:*`, `frontier:*`,
 *    `archive:*`, `paperBridge:*`) have no MCP tool and no reason to move.
 *
 * Channels not here stay as inline `ipcMain.handle` calls in `src/main/index.ts`,
 * unchanged. `registry.sweep.ts` asserts the two sets partition the preload's
 * channels exactly — no channel unreachable, none registered twice.
 *
 * TWO RULES FOR EVERY ENTRY BODY, both of which are correctness and not style:
 * - **Never open a second DB connection.** `ctx.db` is always `getDb()`. Several
 *   existing deferred-transaction sites are correct only because exactly one
 *   connection exists in this process.
 * - **No `await` inside a `db.transaction()` callback.** better-sqlite3
 *   transactions are synchronous; an await inside one is a corrupted invariant
 *   waiting for load.
 */
export const ENTRIES: Entry[] = [
  ...PROJECT_ENTRIES,
  ...WORK_ENTRIES,
  ...SEARCH_ENTRIES,
  ...GRAPH_ENTRIES,
  ...JOB_ENTRIES,
  ...EXTRACTION_ENTRIES,
  ...REVIEW_ENTRIES,
  ...SUMMARY_ENTRIES,
  ...RANKING_ENTRIES,
  ...READONLY_MISC_ENTRIES,
  ...RERUN_ENTRIES,
  ...TEXT_ENTRIES,
  ...INGEST_ENTRIES,
  ...TAB_ENTRIES
  // Workstreams B, C and D append their domains here, one import + one spread
  // each, so four parallel branches conflict on adjacent lines rather than on a
  // shared count.
]

/** Channel → entry. Built once; the loop and the sweep both read it. */
export const byChannel: ReadonlyMap<string, Entry> = (() => {
  const m = new Map<string, Entry>()
  const tools = new Set<string>()
  for (const entry of ENTRIES) {
    if (entry.tool !== null) {
      // A duplicate TOOL name does not throw anywhere on its own: `toolEntry`
      // resolves by `find`, so one of the two would simply become unreachable
      // and the agent would call the other one believing it called this. Silent
      // shadowing across a four-workstream merge is exactly what this whole
      // file exists to make impossible.
      if (tools.has(entry.tool)) throw new Error(`duplicate registry tool: ${entry.tool}`)
      tools.add(entry.tool)
    }
    if (m.has(entry.channel)) {
      // Two entries for one channel means `ipcMain.handle` would throw at
      // startup on the second — but only in a build where both domains landed,
      // which is precisely the merge a parallel workstream produces. Fail here
      // instead, where the message names the channel.
      throw new Error(`duplicate registry channel: ${entry.channel}`)
    }
    m.set(entry.channel, entry)
  }
  return m
})()

const ACCESS_RANK: Record<Access, number> = { read: 0, write: 1, destructive: 2 }

/** The permission levels a user can grant, in the order the Settings UI shows them. */
export type PermissionLevel = 'read' | 'write' | 'delete'

const LEVEL_RANK: Record<PermissionLevel, number> = { read: 0, write: 1, delete: 2 }

/**
 * The entries an agent at `level` may call.
 *
 * Applied at BOTH list time and dispatch time. List-time alone would let a
 * session that listed `delete` tools keep calling them after the user lowered
 * the level; dispatch-time alone would show an agent tools it will then be
 * refused, and it would plan around them.
 */
export function mcpTools(level: PermissionLevel): Entry[] {
  const max = LEVEL_RANK[level]
  return ENTRIES.filter(
    (entry) =>
      entry.tool !== null &&
      ACCESS_RANK[entry.access] <= max &&
      // Asked FRESH on every list, because the answer changes while the app is
      // running: a plugin backing a tool can be switched off between one
      // `tools/list` and the next.
      safeAvailable(entry)
  )
}

/**
 * Whether an entry is backed right now. Absent means always, which is nearly all.
 *
 * A THROW COUNTS AS UNAVAILABLE. This can reach a plugin, and a plugin's getters
 * are a stranger's code — an escaping exception here would reject `tools/list`
 * whole, so one broken plugin would leave an agent with no tools at all.
 */
function safeAvailable(entry: Entry): boolean {
  if (entry.available === undefined) return true
  try {
    return entry.available() === true
  } catch {
    return false
  }
}

/** The entry backing a tool name at this level, or undefined if it is out of reach. */
export function toolEntry(name: string, level: PermissionLevel): Entry | undefined {
  const max = LEVEL_RANK[level]
  return ENTRIES.find(
    (entry) => entry.tool === name && ACCESS_RANK[entry.access] <= max
  )
}

/**
 * The JSON Schema an agent is shown for an entry.
 *
 * `toolParams` when present, because that is the narrowed value space the tool
 * actually accepts; `params` otherwise.
 *
 * `.refine()` IS SILENTLY DROPPED by `toJSONSchema` — verified: the emitted
 * schema for a refined object is the unrefined one. The refinement still runs at
 * dispatch, so the call is still rejected; what the agent loses is any way to
 * know why. Every refined entry therefore states its rule in `summary`, in
 * words. A rule enforced but undocumented produces an agent that retries the
 * same invalid call forever.
 */
export function inputSchemaOf(entry: Entry): Record<string, unknown> {
  return z.toJSONSchema(entry.toolParams ?? entry.params, {
    io: 'input',
    // An agent cannot resolve a `$ref` against a registry it was never given, so
    // every shared node is inlined into the one schema it is shown.
    reused: 'inline'
  }) as Record<string, unknown>
}
