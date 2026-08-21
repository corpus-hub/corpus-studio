// What an OUTLET is: somewhere the work in this app can be mirrored to.
//
// Corpus Studio keeps its own copy of every analysis; an outlet describes where
// that work ALSO goes — a note in a Zotero library, a markdown file in an
// Obsidian vault. Each is a module under `outlets/` registered once in
// `registry.ts`, so adding one is a new folder rather than a new branch in the
// screen, and the UI renders whatever is registered.
//
// THE HONESTY RULE THIS INTERFACE EXISTS TO ENFORCE. Every control an outlet
// declares is DB-BACKED: `settings` is persisted and `actions` really do the
// thing they are named after. There is deliberately no way to declare a switch
// that only looks settable — the previous screen was full of them, badged "not
// saved", which is a control that lies about being a control.

import type { DB } from '../db/connection'

/** The registered outlets. A union rather than a string so a typo cannot compile. */
export type OutletId = 'zotero' | 'obsidian'

/**
 * One thing that was CHECKED about the outlet on this machine.
 *
 * Tri-state, always: `ok === null` means the check could not be answered (an
 * unresponsive mount, a directory we may not read), which is genuinely UNKNOWN
 * and must never be rendered as "no". `detail` says what was actually looked at
 * so a user can verify the claim rather than take it on faith.
 */
export interface OutletCheck {
  label: string
  ok: boolean | null
  detail: string
}

/** Where an outlet stands right now, as data. */
export interface OutletStatus {
  /** One line: the strongest thing we can honestly say. */
  headline: string
  /** True only when the outlet is configured AND usable right now. */
  ready: boolean
  checks: OutletCheck[]
  /** Set when the last write failed; surfaced rather than swallowed. */
  lastError: string | null
  /** ISO timestamp of the last successful write, or null if it never ran. */
  lastRunAt: string | null
}

/** What an action did. Counts are REAL — they come from the filesystem. */
export interface OutletActionResult {
  ok: boolean
  /** One line for the user, e.g. "12 notes written, 3 unchanged". */
  message: string
  /** Files actually created/updated, for a "show in folder" affordance. */
  paths?: string[]
  /** Set when `ok` is false. */
  error?: string
}

/**
 * A button an outlet offers.
 *
 * `run` performs a REAL side effect. An action that cannot run right now says so
 * through `disabledReason` — a disabled control must explain itself, never just
 * fail to respond.
 */
export interface OutletAction {
  id: string
  label: string
  description: string
  /** Whether this action changes something outside the app (needs confirming). */
  writes: boolean
  disabledReason(db: DB, projectId: number): string | null
  run(db: DB, projectId: number): Promise<OutletActionResult>
}

/** One outlet module. */
export interface Outlet {
  id: OutletId
  name: string
  /** Short line under the name explaining what mirroring here means. */
  tagline: string
  status(db: DB, projectId: number): Promise<OutletStatus>
  actions: OutletAction[]
}
