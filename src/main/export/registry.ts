// The one place that knows which export formats exist.
//
// Adding a format is: write a module in `formats/`, add it to the array below.
// Nothing else changes — not the IPC handler, not the preload, not the
// renderer, which asks `listExportOptions()` what is available and echoes back
// an opaque id. That is why no domain-specific format name can be hardcoded in
// the UI: the UI cannot name a format at all.

import type { DB } from '../db/connection'
import { structuralFormats } from './formats/structural'
import { tableFormat, workbookFormat } from './formats/table'
import { archiveFormat } from './formats/archive'
import type { ExportFormat, ExportOptionDTO, ExportSpec } from './types'

const FORMATS: Array<ExportFormat<never>> = [
  // First in the menu: the only export that is not a VIEW of the project but
  // the project itself, and the only one that can be imported back.
  archiveFormat as unknown as ExportFormat<never>,
  ...(structuralFormats as unknown as Array<ExportFormat<never>>),
  tableFormat as unknown as ExportFormat<never>,
  workbookFormat as unknown as ExportFormat<never>
]

/**
 * Every export available for a project, in menu order, each with the spec that
 * produces it.
 *
 * The spec is kept SERVER-SIDE, keyed by the option id: the renderer receives
 * ids and labels only, so a page script cannot hand main a hand-built spec
 * naming an arbitrary schema.
 */
export function listExportOptions(
  db: DB,
  projectId: number
): Array<{ spec: ExportSpec; option: ExportOptionDTO }> {
  return FORMATS.flatMap((f) => f.options(db, projectId)) as Array<{
    spec: ExportSpec
    option: ExportOptionDTO
  }>
}

/** The options alone, for the renderer. */
export function exportOptions(db: DB, projectId: number): ExportOptionDTO[] {
  return listExportOptions(db, projectId).map((o) => o.option)
}

/**
 * Resolve an option id back to its spec.
 *
 * Returns null for an id this project does not offer — including one that is
 * valid for a DIFFERENT project, so an id cannot be used to read another
 * project's data.
 */
export function specForOption(db: DB, projectId: number, optionId: string): ExportSpec | null {
  return listExportOptions(db, projectId).find((o) => o.option.id === optionId)?.spec ?? null
}

/** Produce the bytes for one export. Never touches the filesystem. */
export async function buildExport(
  db: DB,
  projectId: number,
  spec: ExportSpec
): ReturnType<ExportFormat['build']> {
  const format = FORMATS.find((f) => f.kind === spec.kind)
  if (!format) throw new Error(`unknown export kind '${spec.kind}'`)
  return (format as ExportFormat).build(db, projectId, spec)
}
