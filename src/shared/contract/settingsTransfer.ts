// Settings export/import DTOs — carrying an install's configuration to another.
//
// Part of the frozen IPC contract. `contract.ts` re-exports everything here, so
// every existing `@shared/contract` import keeps working; new code may import
// this module directly when it only needs these types.
//
// NOTHING HERE CARRIES A VALUE. Every type below DESCRIBES a setting — its name,
// which tab it belongs to, whether this install has one — and none of them holds
// what it is set to. That is deliberate and load-bearing: one of these items is
// the gateway API key, and the renderer must be able to draw the whole export
// and import dialogs without the credential ever crossing the IPC boundary.

/**
 * One thing that can be exported or imported, as the dialogs render it.
 *
 * An item is the unit of DEPENDENCY, not of storage: where two values are only
 * meaningful together (the endpoint and the key that authenticates to it) they
 * are one item, with no way to select half. Main owns that grouping, so the UI
 * cannot separate a pair by laying it out differently.
 */
export interface SettingsTransferItemDTO {
  /** Opaque; the renderer echoes it back and never constructs one. */
  id: string
  /** The Settings tab this is configured on — the grouping both dialogs use. */
  tab: string
  /** That tab's display name, resolved in main so the two cannot disagree. */
  tab_label: string
  label: string
  /** What this item covers, in the user's terms. */
  description: string
  /**
   * Named only where the item is MORE than its label implies — the pair that
   * travels together, the paths that are machine-specific. Null is the normal
   * case: a note on every row is a note nobody reads.
   */
  note: string | null
  /** True when the value can carry a credential, so the file must be handled as one. */
  sensitive: boolean
  /**
   * EXPORT: this install has a value to export. IMPORT: the file carries one.
   *
   * A mechanical fact — the value exists or it does not — so an unconfigured
   * setting is shown as unavailable rather than as a checkbox that would
   * silently export nothing.
   */
  present: boolean
}

/** A decrypted settings file, described without disclosing what it holds. */
export interface SettingsTransferFileDTO {
  /**
   * Opaque handle for `applySettings`. The decrypted values stay in main and are
   * reached only through this, so the renderer chooses what to apply without
   * ever holding a credential.
   */
  handle: string
  /** When it was written, or null when the file did not say. */
  exported_at: string | null
  /** What it contains, described from THIS build's catalog. */
  items: SettingsTransferItemDTO[]
  /**
   * How many entries this build has no item for — a file from a newer version.
   * Reported rather than dropped silently, so "I exported nine things and it
   * offers seven" has an answer on screen.
   */
  unrecognised: number
}

/**
 * What an import actually did.
 *
 * Two lists and not a count, because they answer different questions and a
 * number answers neither: `applied` is what changed, `skipped` is what did not
 * and WHY — a storage folder that is not on this machine, a value the file did
 * not hold usably. An import that half-worked in silence is what this shape
 * exists to make unreachable.
 */
export interface SettingsImportResultDTO {
  /** Item labels that were applied, in the order they were applied. */
  applied: string[]
  skipped: Array<{ label: string; reason: string }>
}
