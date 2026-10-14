// WHICH FIELDS of an extraction schema changed since a stored run was made.
//
// The schema's `version` answers only "did anything change", which is the
// question that costs a whole corpus of model calls when the answer is "one
// field's hint was reworded". Every field already carries its own `param_hash`,
// and a run now records the map of the hashes it was produced under
// (`analysis_run.field_hashes`), so the finer question is answerable: name the
// fields whose definitions moved, and re-ask the model about those alone.
//
// The answer is deliberately CONSERVATIVE in one direction only. A run with no
// recorded map — every run made before this existed — is `unknown`, and unknown
// means redo the whole schema. Being wrong that way costs model calls; being
// wrong the other way leaves a value on screen that the user's edit was meant
// to change, under a schema that no longer describes it.

import type { Database } from 'better-sqlite3'

export interface SchemaFieldDiff {
  /** Fields whose `param_hash` differs from the one the run was made under. */
  changed: string[]
  /** Fields that exist now and did not when the run was made. */
  added: string[]
  /** Fields the run covered that no longer exist. */
  removed: string[]
  /**
   * Can this be re-extracted PARTIALLY, or must the whole schema be redone?
   *
   * False when the run recorded no field map, which is the only honest answer
   * about a run whose covered fields are unknown.
   */
  partial: boolean
}

/** The `{ key: param_hash }` map of a schema's fields as they stand now. */
export function currentFieldHashes(db: Database, schemaId: number): Record<string, string> {
  const rows = db
    .prepare(`SELECT key, param_hash FROM extraction_field WHERE schema_id = ?`)
    .all(schemaId) as Array<{ key: string; param_hash: string }>
  const out: Record<string, string> = {}
  for (const r of rows) out[r.key] = r.param_hash
  return out
}

/** Parse a stored map, treating anything unreadable as absent rather than throwing. */
function readStoredHashes(raw: string | null): Record<string, string> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  } catch {
    return null
  }
}

/**
 * Compare a schema's fields NOW against the map the given run recorded.
 *
 * `removed` alone is not a reason to re-extract: the remaining values were
 * produced under definitions that have not moved, and the dead field's
 * measurements are already unlinked by `measurement.field_id ON DELETE SET
 * NULL`. So deleting a column costs nothing, where today it re-runs everything.
 */
export function schemaFieldDiff(
  db: Database,
  schemaId: number,
  storedHashesJson: string | null
): SchemaFieldDiff {
  const now = currentFieldHashes(db, schemaId)
  const before = readStoredHashes(storedHashesJson)
  if (before === null) {
    return { changed: [], added: Object.keys(now), removed: [], partial: false }
  }
  const changed: string[] = []
  const added: string[] = []
  for (const [key, hash] of Object.entries(now)) {
    const prev = before[key]
    if (prev === undefined) added.push(key)
    else if (prev !== hash) changed.push(key)
  }
  const removed = Object.keys(before).filter((k) => now[k] === undefined)
  return { changed: changed.sort(), added: added.sort(), removed: removed.sort(), partial: true }
}

/**
 * The fields a re-extraction must ask about, or null for "ask about all of them".
 *
 * Null is returned whenever the diff cannot be trusted to be complete, and for
 * the case where the changed set is the whole schema anyway — narrowing to
 * every field is the same request with worse provenance.
 */
export function fieldsToReextract(diff: SchemaFieldDiff, totalFields: number): string[] | null {
  if (!diff.partial) return null
  const targets = [...diff.changed, ...diff.added]
  if (targets.length === 0) return []
  if (targets.length >= totalFields) return null
  return targets
}

/**
 * The field map of the CURRENT run for one (work, project, schema), or null.
 *
 * Only a current run is consulted: a superseded one describes an answer the app
 * no longer shows, and diffing against it would report changes to values that
 * are not on screen.
 */
export function currentRunFieldHashes(
  db: Database,
  workId: number,
  projectId: number,
  schemaId: number
): { runId: number; fieldHashes: string | null } | null {
  const row = db
    .prepare(
      `SELECT id, field_hashes FROM analysis_run
        WHERE work_id = ? AND project_id = ? AND analysis_type = 'extraction'
          AND schema_id = ? AND superseded = 0`
    )
    .get(workId, projectId, schemaId) as
    | { id: number; field_hashes: string | null }
    | undefined
  if (!row) return null
  return { runId: row.id, fieldHashes: row.field_hashes }
}
