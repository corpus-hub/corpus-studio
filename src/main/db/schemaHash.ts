import { createHash } from 'node:crypto'
import type { Database } from 'better-sqlite3'

/**
 * CONTENT-DERIVED schema identity.
 *
 * A field's `param_hash` covers exactly the parameters that change what the
 * model is asked to extract and how the value is interpreted: key, label,
 * data_type, unit, required, enum_options and the extraction hint
 * (`description`). Presentation-only attributes are deliberately EXCLUDED —
 * `sort_order` moves a column on screen without changing any recorded value, so
 * reordering must not invalidate a run, and `id`/timestamps are identity of the
 * row, not of its meaning.
 *
 * The schema's version is the hash of the ordered list of its field hashes. That
 * makes versioning INCREMENTAL rather than wholesale: editing one field changes
 * one field hash (and the composite), leaving every other field's hash — and so
 * the provenance of runs that only touched those fields — provably intact.
 */

export interface HashableField {
  key: string
  label: string
  data_type: string
  unit: string | null
  required: number | boolean
  enum_options: string | null
  description: string | null
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

export function fieldParamHash(f: HashableField): string {
  // A JSON array (not an object) so the hash is insensitive to key order but
  // strictly sensitive to VALUE order — and \u0000-free by construction.
  return sha(
    JSON.stringify([
      f.key,
      f.label,
      f.data_type,
      f.unit ?? null,
      f.required === 1 || f.required === true ? 1 : 0,
      f.enum_options ?? null,
      f.description ?? null
    ])
  ).slice(0, 16)
}

/**
 * The schema version string, derived from its fields in display order.
 * Prefixed `s-` so it is recognisable in a provenance row as content-derived
 * rather than a hand-typed 'v1.2'.
 */
export function schemaVersionFromHashes(fieldHashes: string[]): string {
  return `s-${sha(fieldHashes.join('|')).slice(0, 12)}`
}

/**
 * Recompute one schema's version from the hashes currently stored on its fields.
 * Call after ANY field insert/update/delete. A schema with no fields still gets
 * a stable version (the hash of the empty list) rather than a null.
 *
 * The hashes are sorted by VALUE, not read in display order. `fieldParamHash`
 * goes to some trouble to exclude `sort_order` so that dragging a column does
 * not invalidate anyone's extraction — and then joining in `sort_order` put it
 * straight back in through the composite, so a reorder moved
 * `extraction_schema.version`, which `schema-extract.fingerprint` keys on, and
 * re-ran the whole corpus for a cosmetic change. Sorting by the hash makes the
 * version a property of WHICH fields exist and what they say, which is what it
 * has always claimed to be.
 */
export function recomputeSchemaVersion(db: Database, schemaId: number, now: string): string {
  const hashes = (
    db
      .prepare(`SELECT param_hash FROM extraction_field WHERE schema_id = ?`)
      .all(schemaId) as { param_hash: string }[]
  )
    .map((r) => r.param_hash)
    .sort()
  const version = schemaVersionFromHashes(hashes)
  db.prepare('UPDATE extraction_schema SET version = ?, updated_at = ? WHERE id = ?').run(
    version,
    now,
    schemaId
  )
  return version
}

/**
 * Fill in `param_hash` for every field that lacks one and recompute every
 * schema version. Used by the v8 migration; idempotent, so it is also safe to
 * call after a bulk seed.
 */
export function backfillSchemaHashes(db: Database): void {
  const now = new Date().toISOString()
  const fields = db
    .prepare(
      `SELECT id, key, label, data_type, unit, required, enum_options, description
       FROM extraction_field`
    )
    .all() as (HashableField & { id: number })[]
  const set = db.prepare('UPDATE extraction_field SET param_hash = ? WHERE id = ?')
  for (const f of fields) set.run(fieldParamHash(f), f.id)

  const schemas = db.prepare('SELECT id FROM extraction_schema').all() as { id: number }[]
  for (const s of schemas) recomputeSchemaVersion(db, s.id, now)
}
