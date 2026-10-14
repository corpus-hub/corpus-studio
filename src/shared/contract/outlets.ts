// Outlet DTOs — where a project's work is mirrored to.
//
// Part of the frozen IPC contract. `contract.ts` re-exports everything here, so
// every existing `@shared/contract` import keeps working; new code may import
// this module directly when it only needs these types.

import type { ExportFileResultDTO } from './export'

// ---------------------------------------------------------------- outlets
/**
 * An OUTLET is somewhere this project's work can be mirrored to (a Zotero
 * library, an Obsidian vault). Corpus Studio keeps its own copy of everything;
 * an outlet describes where that work ALSO goes.
 *
 * Every control these DTOs describe is DB-backed. There is deliberately no shape
 * here for a switch that does not persist — the screen used to be full of them,
 * badged "not saved", which is a control that lies about being a control.
 */
export interface OutletCheckDTO {
  label: string
  /** Tri-state: null = the check could not be answered, NEVER rendered as "no". */
  ok: boolean | null
  /** What was actually looked at, so the user can verify the claim. */
  detail: string
}

export interface OutletStatusDTO {
  id: 'zotero' | 'obsidian'
  name: string
  tagline: string
  /** The strongest thing we can honestly say in one line. */
  headline: string
  /** Configured AND usable right now. */
  ready: boolean
  checks: OutletCheckDTO[]
  /** The last write's failure, surfaced rather than swallowed. */
  last_error: string | null
  last_run_at: string | null
}

/** A button an outlet offers. `disabled_reason` explains an unavailable one. */
export interface OutletActionDTO {
  id: string
  label: string
  description: string
  /** True when running it changes something outside the app. */
  writes: boolean
  disabled_reason: string | null
}

/** What an action actually did. Counts come from the filesystem, not a guess. */
export interface OutletActionResultDTO {
  ok: boolean
  message: string
  paths?: string[]
  error?: string
}

/** The persisted settings for both outlets. Everything here reaches SQLite. */
export interface OutletSettingsDTO {
  zotero: {
    summary_notes: boolean
    project_notes: boolean
    /**
     * Carry the PDFs themselves. The export then becomes a ZIP holding the .rdf
     * and a `files/` tree it links relatively, rather than a single .rdf whose
     * links point at this machine's paths.
     */
    include_pdfs: boolean
    /** Override for the Zotero data directory; null = the conventional place. */
    data_dir: string | null
  }
  obsidian: {
    /** Choosing a folder IS enabling this outlet; there is no separate switch. */
    vault_path: string | null
    folder: string
    backlinks: boolean
    /** Rewrite a note automatically whenever its analysis is regenerated. */
    auto_mirror: boolean
  }
  /**
   * Outlets whose stored configuration could NOT be read, so the values above
   * are this build's defaults rather than anything the user chose.
   *
   * On the DTO because the difference is invisible in the values themselves: a
   * vault path that will not parse and one that was never set both arrive as
   * `null`, and the screen would show an empty form either way. Without this the
   * user learned about it only by touching a switch, which refuses — after they
   * had already been shown their configuration as blank.
   *
   * Empty is the ordinary case and renders nothing. See the badge rule.
   */
  unreadable: Array<'zotero' | 'obsidian'>
}

/**
 * What an unreadable configuration is called, ONCE.
 *
 * On the contract because both sides say it: main throws it from the write that
 * refuses to merge onto defaults, and the screen shows it for a row it read and
 * could not parse. Two copies would drift, and the drift would be invisible —
 * the same fault would be described one way before the user touched anything
 * and another way afterwards. Nothing from the stored bytes appears in it.
 */
export const OUTLET_SETTINGS_UNREADABLE =
  'The saved settings for this integration could not be read and have been reset. '
  + 'Check the options below and set them again.'

/** One Zotero collection, read from the library read-only. */
export interface ZoteroCollectionDTO {
  key: string
  name: string
  /** Full path with parents, e.g. "Projects / Kemp eliminases". */
  path: string
  item_count: number
}

/**
 * One place a RUNNING Zotero will accept papers: a library root or a collection.
 *
 * A DIFFERENT IDENTIFIER FROM `ZoteroCollectionDTO.key`, and the two must never
 * be swapped. This `id` is Zotero's treeViewID (`L1`, `C23`), the only thing its
 * connector accepts as a destination; the other is the sync key read out of
 * `zotero.sqlite` (`CSTEST0001`), the only thing the import path accepts. They
 * name the same collection and are not interchangeable — passing one where the
 * other belongs targets nothing, silently. Hence the separate type.
 */
export interface ZoteroTargetDTO {
  id: string
  name: string
  /** Nesting depth, so a child collection can be indented under its parent. */
  level: number
  /** False when Zotero will not accept files here (a read-only group library). */
  files_editable: boolean
}

/**
 * Whether this project sends new papers to Zotero, and whether that can happen
 * NOW.
 *
 * `connected` is stored and `running` is measured, deliberately kept apart. A
 * user who set this up and then quit Zotero is connected but not running, which
 * is exactly the case the import warning exists for — collapsing them into one
 * boolean would make "you turned this off" and "Zotero is closed" indis-
 * tinguishable, and only one of them is something to complain about.
 */
export interface ZoteroConnectionDTO {
  connected: boolean
  running: boolean
  /** The chosen destination's treeViewID, or null when not connected. */
  target_id: string | null
  /** Its name when connected, for display without a second round trip. */
  target_name: string | null
}

/** Outcome of importing a Zotero collection into a project. */
export interface ZoteroImportResultDTO {
  added: number
  skipped: number
  with_pdf: number
}

/**
 * Outcome of writing the Zotero import file.
 *
 * A save result plus WHAT WENT IN. The counts are here because including the
 * papers themselves makes the export selective — a paper whose file is missing
 * or unreadable is left out whole — and a user handed 40 records from a project
 * of 47 must be told that rather than left to notice it in Zotero later.
 */
export interface ZoteroExportResultDTO extends ExportFileResultDTO {
  /** Papers written into the file. */
  papers: number
  /** Papers left out because their file could not be read. Always 0 with the switch off. */
  omitted: number
  /** True when the file is the zip bundle rather than a bare .rdf. */
  bundled: boolean
}
