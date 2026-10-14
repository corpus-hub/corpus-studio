// Spreadsheet exports of extracted values.
//
// `table` is one schema as one file (CSV or XLSX); `workbook` is every attached
// schema as one XLSX with a sheet each. Both are built from
// `buildExtractionTable`, so the CSV, the sheet and the workbook can never
// disagree about what a schema's data is.
//
// The options are DERIVED from the project's attached schemas, which is what
// keeps any particular domain format out of the code: a project that attaches
// three schemas offers three table exports, named after those schemas, and the
// renderer never learns any of their names.

import type { DB } from '../../db/connection'
import { listProjectSchemas } from '../../db/repositories'
import { buildExtractionTable } from '../data/extractionTable'
import { toCsv } from '../serialize/csv'
import { toXlsx } from '../serialize/xlsx'
import type { ExportFormat } from '../types'
import { projectStem } from './structural'

/** Filesystem-safe stem combining the project and the schema. */
function tableStem(db: DB, projectId: number, schemaKey: string): string {
  return `${projectStem(db, projectId, 'data')}-${schemaKey}`
}

export const tableFormat: ExportFormat<{
  kind: 'table'
  schemaId: number
  format: 'csv' | 'xlsx'
}> = {
  kind: 'table',
  options: (db, projectId) =>
    listProjectSchemas(db, projectId).flatMap((schema) =>
      (['xlsx', 'csv'] as const).map((format) => ({
        spec: { kind: 'table' as const, schemaId: schema.id, format },
        option: {
          id: `table:${schema.id}:${format}`,
          group: schema.name,
          format: format.toUpperCase(),
          label: `${schema.name} · ${format.toUpperCase()}`,
          description:
            format === 'xlsx'
              ? `Every ${schema.name} value with its evidence and the model that extracted it.`
              : `The same table as plain text, for a script or another tool.`,
          extension: format
        }
      }))
    ),
  build: async (db, projectId, spec) => {
    const table = buildExtractionTable(db, projectId, spec.schemaId)
    return {
      data: spec.format === 'csv' ? toCsv(table) : toXlsx([table]),
      extension: spec.format,
      filenameStem: tableStem(db, projectId, table.schemaKey)
    }
  }
}

export const workbookFormat: ExportFormat<{ kind: 'workbook' }> = {
  kind: 'workbook',
  options: (db, projectId) => {
    const schemas = listProjectSchemas(db, projectId)
    // Offered only when it says something a single-schema export does not.
    // With one schema it would be a second button producing an identical file.
    if (schemas.length < 2) return []
    return [
      {
        spec: { kind: 'workbook' },
        option: {
          id: 'workbook',
          group: 'All extracted data',
          format: 'XLSX',
          label: 'All extracted data · XLSX',
          description: `One workbook with a sheet per schema (${schemas.length}).`,
          extension: 'xlsx'
        }
      }
    ]
  },
  build: async (db, projectId) => {
    const schemas = listProjectSchemas(db, projectId)
    if (schemas.length === 0) throw new Error('this project has no extraction schemas attached')
    const tables = schemas.map((s) => buildExtractionTable(db, projectId, s.id))
    return {
      data: toXlsx(tables),
      extension: 'xlsx',
      filenameStem: projectStem(db, projectId, 'data')
    }
  }
}
