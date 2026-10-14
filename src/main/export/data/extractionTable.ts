// Turn one extraction schema's extracted values into a table.
//
// PURE: no filesystem, no dialog, no serialization format. It answers "what are
// the columns and rows" so that CSV and XLSX are two renderings of one table
// rather than two implementations that drift.
//
// SHAPE — one row per MEASUREMENT, not per paper.
// The obvious design is a wide table (one row per variant, one column per
// field), and it is wrong here: `fact` does not group a schema's fields into a
// record. The data is long-format — a fact carries one field's value, and often
// several measurements of the SAME field (six `tm` rows under one fact in the
// seed corpus). There is no key to pivot on, so a wide table would have to
// invent one and would silently drop repeats. Long format loses nothing and
// pivots cleanly in the spreadsheet the user opens it in.
//
// Every row carries its PROVENANCE — which model produced it, under which
// prompt version, when, and whether a second reading contradicted it. An
// extracted number without that is a claim with no author, and the whole point
// of this app is that a claim is traceable to the run that made it.

import type { DB } from '../../db/connection'
import { getExtractionRows, getExtractionSchema, getProject } from '../../db/repositories'
import { plainText } from '../../../shared/markup'

export interface TableColumn {
  key: string
  header: string
  /** Drives cell typing in XLSX and quoting in CSV. */
  type: 'text' | 'number'
}

export interface ExtractionTable {
  schemaName: string
  schemaKey: string
  schemaVersion: string
  projectName: string
  columns: TableColumn[]
  /** Cell values, aligned to `columns` by key. */
  rows: Array<Record<string, string | number | null>>
}

/** The columns every table starts with: which paper the value came from. */
const WORK_COLUMNS: TableColumn[] = [
  { key: 'work_title', header: 'Paper', type: 'text' },
  { key: 'work_year', header: 'Year', type: 'number' },
  { key: 'work_venue', header: 'Venue', type: 'text' },
  { key: 'work_doi', header: 'DOI', type: 'text' }
]

/**
 * The columns describing the extracted value itself.
 *
 * `value` and `value_raw` are BOTH present and that is deliberate: the raw
 * as-reported text ('>95', '~86') is preserved beside the parsed number,
 * because a paper writing "greater than 95" did not measure 95 and a table that
 * showed only the number would launder an upper bound into a data point.
 */
const VALUE_COLUMNS: TableColumn[] = [
  { key: 'field_label', header: 'Field', type: 'text' },
  { key: 'value', header: 'Value', type: 'number' },
  { key: 'value_raw', header: 'Value (as reported)', type: 'text' },
  { key: 'unit', header: 'Unit', type: 'text' },
  { key: 'quantity', header: 'Quantity (as reported)', type: 'text' },
  { key: 'conditions', header: 'Conditions', type: 'text' },
  { key: 'fact_kind', header: 'Fact kind', type: 'text' },
  { key: 'status', header: 'Status', type: 'text' },
  { key: 'evidence_quote', header: 'Evidence quote', type: 'text' },
  { key: 'evidence_page', header: 'Evidence page', type: 'number' },
  // A record a reading WITHDREW (migration v52), with the reason it gave. The
  // row is still here: an export in this app never drops extracted data, and a
  // spreadsheet silently short by three rows is worse than one with a column
  // saying why those three should not be used. Empty on everything else, which
  // is what makes the filled cell mean something.
  { key: 'retraction', header: 'Withdrawn by review', type: 'text' }
]

/** Provenance: who made this claim, with what, and when. */
const PROVENANCE_COLUMNS: TableColumn[] = [
  { key: 'run_model', header: 'Model', type: 'text' },
  { key: 'run_provider', header: 'Provider', type: 'text' },
  { key: 'run_prompt_version', header: 'Prompt version', type: 'text' },
  { key: 'run_timestamp', header: 'Extracted at', type: 'text' },
  { key: 'run_origin', header: 'Run origin', type: 'text' },
  { key: 'run_verifier', header: 'Verifier', type: 'text' }
]

interface ProvenanceRow {
  fact_id: number
  model: string | null
  provider: string | null
  prompt_version: string | null
  run_timestamp: string | null
  run_origin: string | null
  verifier_result: string | null
  /** The reason of the review verdict that withdrew this record, or null. */
  retraction: string | null
}

/**
 * Every schema's rows in ONE table, with a Schema column telling them apart.
 *
 * For places that can carry a single file rather than a sheet per schema — the
 * Zotero export, where the data rides along beside the bibliography. A user
 * receiving that collection should get all of the extracted values, not the one
 * schema whoever exported it happened to pick.
 *
 * Columns are the union across schemas, which is exactly right here: the tables
 * already share every column but `Field`, since the shape is one row per
 * measurement rather than one column per field.
 */
export function buildCombinedExtractionTable(
  db: DB,
  projectId: number,
  schemaIds: number[]
): ExtractionTable {
  const tables = schemaIds.map((id) => buildExtractionTable(db, projectId, id))
  if (tables.length === 0) throw new Error('no extraction schemas to export')

  const schemaColumn: TableColumn = { key: 'schema', header: 'Schema', type: 'text' }
  return {
    schemaName: 'All extracted data',
    schemaKey: 'all-data',
    schemaVersion: tables.map((t) => `${t.schemaKey}@${t.schemaVersion}`).join(' + '),
    projectName: tables[0].projectName,
    columns: [schemaColumn, ...tables[0].columns],
    rows: tables.flatMap((t) => t.rows.map((r) => ({ schema: t.schemaName, ...r })))
  }
}

/**
 * Build the table for one schema within one project.
 *
 * Rows are ordered by paper then field then measurement id, so the same corpus
 * always exports byte-identically — a diffable export is worth more than one
 * ordered by whatever the query planner chose.
 */
export function buildExtractionTable(
  db: DB,
  projectId: number,
  schemaId: number
): ExtractionTable {
  const project = getProject(db, projectId)
  if (!project) throw new Error(`project ${projectId} not found`)
  const schema = getExtractionSchema(db, schemaId)
  if (!schema) throw new Error(`extraction schema ${schemaId} not found`)

  const rows = getExtractionRows(db, projectId).filter((r) => r.schema_id === schemaId)

  // Provenance is joined separately rather than widening ExtractionRowDTO: that
  // DTO feeds the Extraction screen, which does not show run metadata, and
  // growing it for one consumer would push these columns into every screen.
  const provenance = new Map<number, ProvenanceRow>()
  if (rows.length > 0) {
    const ids = rows.map((r) => r.fact_id)
    const placeholders = ids.map(() => '?').join(',')
    const provRows = db
      .prepare(
        `SELECT f.id AS fact_id, r.model, r.provider, r.prompt_version,
                r.run_timestamp, r.run_origin, r.verifier_result,
                rc.reason AS retraction
           FROM fact f
           JOIN analysis_run r ON r.id = f.analysis_run_id
      LEFT JOIN analysis_check rc ON rc.id = f.retracted_by_check_id
          WHERE f.id IN (${placeholders})`
      )
      .all(...ids) as ProvenanceRow[]
    for (const p of provRows) provenance.set(p.fact_id, p)
  }

  // Papers are looked up once for the work columns; `getExtractionRows` carries
  // only the title.
  const works = new Map<number, { year: number | null; venue: string | null; doi: string | null }>()
  const workRows = db
    .prepare(
      `SELECT w.id, w.publication_year AS year, w.venue,
              (SELECT i.value FROM identifier i
                WHERE i.work_id = w.id AND i.scheme = 'doi' LIMIT 1) AS doi
         FROM work w
         JOIN project_work pw ON pw.work_id = w.id
        WHERE pw.project_id = ?`
    )
    .all(projectId) as Array<{ id: number; year: number | null; venue: string | null; doi: string | null }>
  for (const w of workRows) works.set(w.id, { year: w.year, venue: w.venue, doi: w.doi })

  const columns = [...WORK_COLUMNS, ...VALUE_COLUMNS, ...PROVENANCE_COLUMNS]

  const out = rows.map((r) => {
    const w = works.get(r.work_id)
    const p = provenance.get(r.fact_id)
    return {
      // plainText: a spreadsheet cell has no formatting to carry the
      // publisher's markup, so a raw title would put `<i>` in a column the
      // user sorts and pastes elsewhere.
      work_title: plainText(r.work_title),
      work_year: w?.year ?? null,
      work_venue: w?.venue ?? null,
      work_doi: w?.doi ?? null,
      field_label: r.field_label ?? r.field_key ?? null,
      value: r.value_num,
      // Only when it says something the number does not: repeating "76" beside
      // 76 is noise, while ">95" beside 95 is the whole caveat.
      value_raw:
        r.value_text !== null && r.value_text !== String(r.value_num ?? '') ? r.value_text : null,
      unit: r.unit ?? r.field_unit ?? null,
      quantity: r.quantity,
      conditions: r.conditions,
      fact_kind: r.fact_kind,
      status: r.status,
      evidence_quote: r.evidence?.quote ?? null,
      evidence_page: r.evidence?.page ?? null,
      run_model: p?.model ?? null,
      run_provider: p?.provider ?? null,
      run_prompt_version: p?.prompt_version ?? null,
      run_timestamp: p?.run_timestamp ?? null,
      run_origin: p?.run_origin ?? null,
      run_verifier: p?.verifier_result ?? null,
      retraction: p?.retraction ?? null
    }
  })

  out.sort(
    (a, b) =>
      String(a.work_title).localeCompare(String(b.work_title)) ||
      String(a.field_label ?? '').localeCompare(String(b.field_label ?? '')) ||
      String(a.quantity).localeCompare(String(b.quantity))
  )

  return {
    schemaName: schema.name,
    schemaKey: schema.key,
    schemaVersion: schema.version,
    projectName: project.name,
    columns,
    rows: out
  }
}
