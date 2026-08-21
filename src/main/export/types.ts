// The export contract: what a format IS, so adding one is a new file rather
// than a new arm in a switch.
//
// Every format the app can produce implements `ExportFormat` and is listed once
// in `registry.ts`. Nothing else — not the IPC handler, not the renderer — may
// name a format, which is how a domain-specific format name (a particular
// interchange standard, say) can no longer be baked into the UI: the button list
// is DERIVED from the registry plus the project's own schemas.

import type { DB } from '../db/connection'

/**
 * WHICH export to produce.
 *
 * A discriminated union rather than a bare string: a table export needs to know
 * its schema and whether the caller wants CSV or XLSX, and encoding that into a
 * format string ('table:3:csv') would put a parser in every consumer.
 */
export type ExportSpec =
  | { kind: 'json' }
  | { kind: 'graph' }
  | { kind: 'table'; schemaId: number; format: 'csv' | 'xlsx' }
  | { kind: 'workbook' }
  /** The whole project, restorable — see `project-archive/`. */
  | { kind: 'archive' }

/** What a format produced, ready to be written to disk verbatim. */
export interface ExportArtifact {
  /**
   * The bytes to write.
   *
   * A string for the text formats and a Buffer for XLSX. Kept as a union rather
   * than normalised to Buffer so the byte count reported to the user is the
   * REAL encoded length — a UTF-8 string's byte length differs from its JS
   * string length, and reporting the latter would misstate what was saved.
   */
  data: string | Buffer
  /** File extension WITHOUT the dot, e.g. 'json', 'csv', 'xlsx'. */
  extension: string
  /** Default filename stem offered in the save dialog (no extension). */
  filenameStem: string
}

/** One export the user can ask for, as offered to the renderer. */
export interface ExportOptionDTO {
  /** Opaque id the renderer echoes back; it never constructs a spec itself. */
  id: string
  /** WHAT is exported. Options sharing a group are one row with format choices. */
  group: string
  /** The format within the group, e.g. 'XLSX'. */
  format: string
  /** `group · format`. */
  label: string
  /** One line describing what the file will contain. */
  description: string
  extension: string
}

/**
 * A producible export format.
 *
 * `build` is given the DB and must be PURE with respect to the filesystem: it
 * returns bytes and never writes them. Writing is `writeFile.ts`'s single job,
 * so the atomic tmp→fsync→rename protocol exists in exactly one place and every
 * format inherits it.
 */
export interface ExportFormat<S extends ExportSpec = ExportSpec> {
  kind: S['kind']
  /**
   * The exports of this kind available for a project, in menu order.
   *
   * A kind may offer NONE (a project with no attached schemas offers no table
   * exports) or MANY (one per schema), which is why this returns a list rather
   * than the format describing itself as a single fixed option.
   */
  options(db: DB, projectId: number): Array<{ spec: S; option: ExportOptionDTO }>
  build(db: DB, projectId: number, spec: S): Promise<ExportArtifact>
}
