// Storage-location DTOs — the roots documents are addressed under.
//
// Part of the frozen IPC contract. `contract.ts` re-exports everything here, so
// every existing `@shared/contract` import keeps working; new code may import
// this module directly when it only needs these types.

export interface BaseDirDTO {
  id: number
  label: string
  abs_path: string
  kind: string
  /**
   * REAL probe result: true = the directory exists and is readable from this
   * machine; false = it does not; null = the probe did not answer in time
   * (a hung network mount), i.e. genuinely UNKNOWN — never rendered as "no".
   */
  reachable: boolean | null
  /**
   * True for the ONE library Corpus Studio creates and fills itself. It cannot
   * be removed — the app would have nowhere to put the files it downloads — so
   * the UI must be able to tell it apart from the roots the user added.
   */
  managed: boolean
  /**
   * How many document files resolve through this root. This is what removing it
   * would cost, so the number is shown rather than a bare refusal.
   */
  document_count: number
}

/** A new storage location. `kind` matches the base_dir CHECK enum. */
export interface BaseDirInputDTO {
  label: string
  abs_path: string
  kind: 'local' | 'nas' | 'cloud' | 'removable'
}

/** Fields of an existing storage location that may be changed. */
export interface BaseDirPatchDTO {
  label?: string
  /** Repointing a root is the NAS-remap case: the mount moved, the files did not. */
  abs_path?: string
  kind?: 'local' | 'nas' | 'cloud' | 'removable'
}
