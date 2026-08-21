// Outlet configuration, persisted in the existing `setting` key/value table
// under an `outlet.<id>.` prefix (the same namespacing `view_pref.` uses).
//
// No new table: these are a handful of single values, and a column per toggle
// would mean a migration every time an outlet grows an option.
//
// EVERYTHING HERE IS PERSISTED. That is the point. The Integrations screen used
// to hold switch positions in React state behind a "not saved" badge, which is a
// control that does not control anything; the DTO below is the whole of what the
// screen can change, and all of it reaches SQLite.

import { z } from 'zod'
// RELATIVE, not the `@shared` alias every other main module uses. This file is
// covered by `npm run test:main`, which runs under plain tsx with no vite alias
// resolution, so the alias would make the whole suite fail to load.
import { OUTLET_SETTINGS_UNREADABLE } from '../../shared/contract/outlets'
import type { DB } from '../db/connection'
import { getSetting, setSetting } from '../db/repositories'
import type { OutletId } from './types'

const PREFIX = 'outlet.'

/**
 * The persisted shape, per outlet.
 *
 * Zod both VALIDATES an incoming patch and supplies the defaults for a database
 * that has never been configured, so "unset" and "set to the default" are the
 * same state and there is no third case to reason about.
 */
export const zoteroSettings = z.object({
  /** Write a short summary note per item. */
  summary_notes: z.boolean().default(true),
  /** Write the project-specific relevance/expansion note. */
  project_notes: z.boolean().default(true),
  /**
   * Carry the PDFs themselves, not just the bibliography.
   *
   * Off by default because it changes what the export IS: a few hundred KB of
   * text becomes a zip of the whole corpus, and a user who wanted a reading
   * list should not be handed a gigabyte without asking.
   */
  include_pdfs: z.boolean().default(false),
  /** Where the user's Zotero library lives, when not in the conventional place. */
  data_dir: z.string().nullable().default(null)
})

export const obsidianSettings = z.object({
  /** Absolute path to the vault root. Null until the user picks one. */
  vault_path: z.string().nullable().default(null),
  /** Folder WITHIN the vault that notes are written to. */
  folder: z.string().default('Corpus Studio'),
  /** Emit [[wiki links]] between works that cite each other. */
  backlinks: z.boolean().default(true),
  /** Rewrite a note automatically whenever its analysis is (re)generated. */
  auto_mirror: z.boolean().default(false)
})

export type ZoteroSettings = z.infer<typeof zoteroSettings>
export type ObsidianSettings = z.infer<typeof obsidianSettings>

export interface OutletSettings {
  zotero: ZoteroSettings
  obsidian: ObsidianSettings
  /** The outlets whose stored row could not be read, so the values are defaults. */
  unreadable: OutletId[]
}

const SCHEMAS = { zotero: zoteroSettings, obsidian: obsidianSettings } as const

/**
 * Read one outlet's settings, saying whether they are the ones on record.
 *
 * Never throws — an Integrations tab that cannot render is worse than one
 * rendering defaults — but `intact` distinguishes two facts that used to be
 * one. A row this build cannot read came back as an outlet that had NEVER been
 * configured, so a user who had already pointed Obsidian at their vault was
 * shown an empty path with no sign anything was wrong, and the next switch they
 * touched wrote the defaults over what was there.
 *
 * An ABSENT row is intact: unconfigured is a real state and the defaults are
 * genuinely what this install holds.
 */
export function readOutletSettingsChecked<K extends OutletId>(
  db: DB,
  id: K
): { settings: z.infer<(typeof SCHEMAS)[K]>; intact: boolean } {
  const raw = getSetting(db, `${PREFIX}${id}`)
  const defaults = SCHEMAS[id].parse({}) as z.infer<(typeof SCHEMAS)[K]>
  if (!raw) return { settings: defaults, intact: true }
  const json = safeJson(raw)
  if (json === CORRUPT) return { settings: defaults, intact: false }
  const parsed = SCHEMAS[id].safeParse(json)
  return parsed.success
    ? { settings: parsed.data as z.infer<(typeof SCHEMAS)[K]>, intact: true }
    : { settings: defaults, intact: false }
}

/**
 * One outlet's settings, defaulted.
 *
 * For the callers that ACT on the configuration (writing a note, revealing a
 * folder) rather than DISPLAYING it — for them a corrupt row and an
 * unconfigured one lead to the same refusal. Anything that shows the user their
 * configuration back must use `readOutletSettingsChecked`.
 */
export function readOutletSettings<K extends OutletId>(
  db: DB,
  id: K
): z.infer<(typeof SCHEMAS)[K]> {
  return readOutletSettingsChecked(db, id).settings
}

/**
 * Both outlets' settings, for the one IPC call the screen makes.
 *
 * CHECKED, because this is the display path. `readOutletSettings` discards
 * `intact`, and doing that here made a corrupt row indistinguishable from an
 * outlet that had never been configured: the user's vault path came back blank
 * as though they had never chosen one, and the only sign anything was wrong was
 * the refusal they hit later on touching an unrelated switch. The flag travels
 * with the values so the screen can say it BEFORE the user acts on a form that
 * is not showing them what is stored.
 */
export function readAllOutletSettings(db: DB): OutletSettings {
  const zotero = readOutletSettingsChecked(db, 'zotero')
  const obsidian = readOutletSettingsChecked(db, 'obsidian')
  return {
    zotero: zotero.settings,
    obsidian: obsidian.settings,
    unreadable: [
      ...(zotero.intact ? [] : (['zotero'] as const)),
      ...(obsidian.intact ? [] : (['obsidian'] as const))
    ]
  }
}

/**
 * Merge a partial patch into one outlet's settings and persist it.
 *
 * Returns the FULL new state so the renderer updates from the write's own
 * result — no read-after-write, and no chance of the UI showing a position the
 * database does not hold.
 */
export function writeOutletSettings<K extends OutletId>(
  db: DB,
  id: K,
  patch: unknown
): z.infer<(typeof SCHEMAS)[K]> {
  const { settings: current, intact } = readOutletSettingsChecked(db, id)
  if (!intact) {
    // A PARTIAL patch merges onto whatever is already there, and here that is
    // not the stored configuration — it is the defaults standing in for one
    // that could not be read. Merging would write those defaults into the row
    // as though the user had chosen them: a vault path they had set, silently
    // cleared by their toggling something unrelated.
    //
    // The unreadable row is DISCARDED first, so this refusal is not permanent:
    // nothing recoverable is in it, and the next attempt merges onto honest
    // defaults and succeeds. The user gets one sentence saying what happened
    // rather than a configuration that quietly reverted.
    setSetting(db, `${PREFIX}${id}`, '')
    throw new Error(OUTLET_SETTINGS_UNREADABLE)
  }
  // `.partial()` so a patch may carry one key; unknown keys are REJECTED rather
  // than stored, which keeps the row parseable by the schema above forever.
  const delta = (SCHEMAS[id] as z.AnyZodObject).partial().strict().parse(patch)
  const next = SCHEMAS[id].parse({ ...current, ...delta })
  setSetting(db, `${PREFIX}${id}`, JSON.stringify(next))
  return next as z.infer<(typeof SCHEMAS)[K]>
}

/**
 * Record the outcome of a write so the panel can report it later.
 *
 * `at` is nullable so "this outlet has never run" is expressible — which is what
 * a caller restoring a previous state needs, and what the panel renders as no
 * last-run line at all rather than as a run at the epoch.
 */
export function recordOutletRun(
  db: DB,
  id: OutletId,
  outcome: { at: string | null; error: string | null }
): void {
  setSetting(db, `${PREFIX}${id}.lastRun`, JSON.stringify(outcome))
}

/**
 * The last recorded outcome, or nulls when the outlet has never run.
 *
 * A row that cannot be read answers with an ERROR rather than with the
 * never-run nulls: "this outlet has never written anything" and "what it last
 * did is unknown" are different, and only the first is a reason for the panel
 * to show nothing. Phrased here, so no stored bytes reach the screen.
 */
export function readOutletRun(db: DB, id: OutletId): { at: string | null; error: string | null } {
  const raw = getSetting(db, `${PREFIX}${id}.lastRun`)
  if (!raw) return { at: null, error: null }
  const parsed = z
    .object({ at: z.string().nullable(), error: z.string().nullable() })
    .safeParse(safeJson(raw))
  return parsed.success
    ? parsed.data
    : { at: null, error: 'The record of this outlet’s last run could not be read.' }
}

/** Per-project Zotero collection mapping (a real collection key, not a slug). */
export function readCollectionMap(db: DB, projectId: number): string | null {
  return getSetting(db, `${PREFIX}zotero.collection.${projectId}`)
}

export function writeCollectionMap(db: DB, projectId: number, key: string | null): void {
  setSetting(db, `${PREFIX}zotero.collection.${projectId}`, key ?? '')
}

/**
 * Where this project SENDS new papers: a live Zotero destination.
 *
 * A SEPARATE KEY from the collection map above, and that separation is the
 * point. Both name a Zotero collection, but by different identifiers for
 * different directions — the map holds a `collections.key` read out of
 * zotero.sqlite for importing FROM a library, this holds a treeViewID the
 * connector accepts for sending TO one. Sharing a slot would let choosing an
 * import source silently repoint the push destination at an id its endpoint
 * cannot resolve, and nothing would report it: papers would simply stop
 * arriving.
 *
 * The NAME is stored beside the id so the panel can say where papers go without
 * requiring Zotero to be running to find out.
 */
export interface ZoteroConnection {
  targetId: string
  targetName: string
}

export function readZoteroConnection(db: DB, projectId: number): ZoteroConnection | null {
  const raw = getSetting(db, `${PREFIX}zotero.push.${projectId}`)
  if (!raw) return null
  const parsed = z
    .object({ targetId: z.string().min(1), targetName: z.string() })
    .safeParse(safeJson(raw))
  // An unreadable row is treated as NOT CONNECTED. The alternative — pushing to
  // a destination we could not parse — would file papers somewhere the user did
  // not choose.
  return parsed.success ? parsed.data : null
}

export function writeZoteroConnection(
  db: DB,
  projectId: number,
  conn: ZoteroConnection | null
): void {
  setSetting(db, `${PREFIX}zotero.push.${projectId}`, conn === null ? '' : JSON.stringify(conn))
}

/**
 * The answer when a stored value is not JSON at all.
 *
 * A SENTINEL, not `{}`. Returning an empty object made unparseable bytes
 * indistinguishable from an object with no keys, and every schema here has a
 * default for every field — so a corrupt row parsed cleanly into the defaults
 * and the caller was told the outlet had simply never been set up.
 */
const CORRUPT = Symbol('corrupt-outlet-setting')

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return CORRUPT
  }
}
