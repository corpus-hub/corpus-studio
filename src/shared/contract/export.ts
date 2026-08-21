// Export DTOs — the files a project can be saved as.
//
// Part of the frozen IPC contract. `contract.ts` re-exports everything here, so
// every existing `@shared/contract` import keeps working; new code may import
// this module directly when it only needs these types.

// ----------------------------------------------------------------- export
/**
 * One export the user can ask for.
 *
 * The renderer renders these and echoes `id` back — it never constructs a
 * format name. That is what keeps a domain-specific interchange format from
 * being baked into a button: the list is derived in main from the format
 * registry plus the project's own attached extraction schemas, so which exports
 * exist is a property of the user's data rather than of the code.
 */
export interface ExportOptionDTO {
  /** Opaque; the renderer passes it to `exportProjectToFile` unchanged. */
  id: string
  /**
   * WHAT is being exported — "Enzyme Kinetics", "Citation graph".
   *
   * Options sharing a `group` are the same content in different formats, and the
   * UI renders them as one row with a format choice. Without this the renderer
   * could only lay out a flat list, which repeated a long schema name once per
   * format and read as two unrelated exports.
   */
  group: string
  /** The format within the group, e.g. 'XLSX'. */
  format: string
  /** `group · format`, for the accessible name and for tests. */
  label: string
  /** One line describing what the file will contain. */
  description: string
  /** File extension without the dot, e.g. 'json', 'csv', 'xlsx'. */
  extension: string
}

/**
 * Result of writing an export to disk. `canceled` is a first-class outcome so
 * the UI can never render a dismissed save dialog as a success. `bytes` is the
 * real byte length written (not the JS string length — those differ under UTF-8).
 * A write FAILURE rejects the call instead of returning here, so there is no
 * shape in which this DTO describes a file that was not actually saved.
 */
export interface ExportFileResultDTO {
  canceled: boolean
  path: string | null
  bytes: number
  /**
   * Opaque handle for `revealExport`. Main keeps the path→id mapping so the
   * renderer never hands a filesystem path back across the boundary (which would
   * turn "reveal" into an arbitrary-path opener). Null when nothing was written.
   */
  export_id: string | null
}
