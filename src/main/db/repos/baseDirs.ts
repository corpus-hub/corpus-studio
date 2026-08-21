// Storage locations (`base_dir`) — the roots under which document files live.
//
// A document's bytes are addressed as `base_dir.abs_path + relative_path`, and
// that indirection is the whole point: when a library moves, or the same corpus
// is opened on a machine that mounts the share somewhere else, ONE row changes
// and every document is findable again. So these rows are edited, not seeded and
// forgotten — this module is that editing.
//
// One location is APP-OWNED (`MANAGED_STORAGE_LABEL`, created by
// `ensureStorageRoot()`): Corpus Studio put files there itself. The rest are the
// user's, and we only ever read them. The distinction is computed from the path
// rather than stored, so it cannot go stale against wherever the managed root
// actually resolves on this machine.

import type { DB } from '../connection'
import type { BaseDirDTO } from '@shared/contract'
import { resolve } from 'node:path'
import { storageRootPath } from '../paths'
import { probeDirectory } from './probe'

/** The `base_dir.kind` values the schema's CHECK constraint allows. */
export const BASE_DIR_KINDS = ['local', 'nas', 'cloud', 'removable'] as const
export type BaseDirKind = (typeof BASE_DIR_KINDS)[number]

/** True when this row is the library Corpus Studio manages itself. */
function isManaged(absPath: string): boolean {
  return resolve(absPath) === resolve(storageRootPath())
}

type BaseDirRow = Omit<BaseDirDTO, 'reachable' | 'managed' | 'document_count'>

/**
 * Every storage location, each with a REAL reachability probe and the number of
 * files that depend on it.
 *
 * Probes run in PARALLEL: one hung network mount must not delay the answer for
 * the local roots, and each is independently time-boxed.
 */
export async function listBaseDirs(db: DB): Promise<BaseDirDTO[]> {
  const rows = db
    .prepare(
      `SELECT bd.id, bd.label, bd.abs_path, bd.kind,
              (SELECT COUNT(*) FROM file_location fl WHERE fl.base_dir_id = bd.id) AS document_count
         FROM base_dir bd
        ORDER BY bd.id ASC`
    )
    .all() as Array<BaseDirRow & { document_count: number }>
  const reach = await Promise.all(rows.map((r) => probeDirectory(r.abs_path)))
  return rows.map((r, i) => ({
    ...r,
    reachable: reach[i],
    managed: isManaged(r.abs_path)
  }))
}

/** Absolute paths of every location of a given kind, in row order. */
export function baseDirPathsOfKind(db: DB, kind: BaseDirKind): string[] {
  const rows = db
    .prepare(`SELECT abs_path FROM base_dir WHERE kind = ? ORDER BY id ASC`)
    .all(kind) as Array<{ abs_path: string }>
  return rows.map((r) => r.abs_path)
}

/**
 * Normalize a user-supplied path into the form stored on the row.
 *
 * Stored paths are absolute and resolved, because `isManaged` and the duplicate
 * check both compare paths textually: `/srv/pdfs` and `/srv/./pdfs/` are one
 * location, and storing both would let a user add the "same" root twice and then
 * see two rows disagree about reachability.
 */
function normalizePath(absPath: string): string {
  const trimmed = absPath.trim()
  if (!trimmed) throw new Error('A storage location needs a path.')
  return resolve(trimmed)
}

/** Reject a label that would render as an empty row. */
function normalizeLabel(label: string): string {
  const trimmed = label.trim()
  if (!trimmed) throw new Error('A storage location needs a name.')
  return trimmed
}

/**
 * Add a storage location.
 *
 * Does NOT probe: a user may legitimately add a share that is not mounted right
 * now, and refusing it would make the app unusable exactly when the network is
 * down. The list reports reachability separately and continuously, which is the
 * honest place for it.
 */
export function addBaseDir(
  db: DB,
  input: { label: string; abs_path: string; kind: BaseDirKind },
  now = new Date().toISOString()
): number {
  const abs = normalizePath(input.abs_path)
  const label = normalizeLabel(input.label)
  const existing = db.prepare(`SELECT id FROM base_dir WHERE abs_path = ?`).get(abs) as
    | { id: number }
    | undefined
  if (existing) {
    throw new Error(`That folder is already a storage location.`)
  }
  const res = db
    .prepare(
      `INSERT INTO base_dir (label, abs_path, kind, created_at) VALUES (@label, @abs, @kind, @now)`
    )
    .run({ label, abs, kind: input.kind, now })
  return Number(res.lastInsertRowid)
}

/**
 * Rename a storage location, or repoint it at a different folder.
 *
 * Repointing is the NAS-remap case the base-dir abstraction exists for: the
 * files did not change, the mount did. Every `file_location` under this row
 * follows automatically because none of them stores an absolute path.
 */
export function updateBaseDir(
  db: DB,
  id: number,
  patch: { label?: string; abs_path?: string; kind?: BaseDirKind }
): void {
  const row = db.prepare(`SELECT id, abs_path FROM base_dir WHERE id = ?`).get(id) as
    | { id: number; abs_path: string }
    | undefined
  if (!row) throw new Error(`No storage location with id ${id}.`)

  const label = patch.label === undefined ? undefined : normalizeLabel(patch.label)
  const abs = patch.abs_path === undefined ? undefined : normalizePath(patch.abs_path)

  if (abs !== undefined && abs !== row.abs_path) {
    const clash = db.prepare(`SELECT id FROM base_dir WHERE abs_path = ? AND id <> ?`).get(abs, id)
    if (clash) throw new Error(`Another storage location already points at that folder.`)
  }

  db.prepare(
    `UPDATE base_dir
        SET label = COALESCE(@label, label),
            abs_path = COALESCE(@abs, abs_path),
            kind = COALESCE(@kind, kind)
      WHERE id = @id`
  ).run({ id, label: label ?? null, abs: abs ?? null, kind: patch.kind ?? null })
}

/** Why a storage location may not be removed, or null when it may. */
export function removalBlocker(db: DB, id: number): string | null {
  const row = db.prepare(`SELECT abs_path FROM base_dir WHERE id = ?`).get(id) as
    | { abs_path: string }
    | undefined
  if (!row) return null
  if (isManaged(row.abs_path)) {
    return 'This is the library Corpus Studio manages; it cannot be removed.'
  }
  const { n } = db
    .prepare(`SELECT COUNT(*) AS n FROM file_location WHERE base_dir_id = ?`)
    .get(id) as { n: number }
  if (n > 0) {
    return `${n} document file${n === 1 ? '' : 's'} would become unopenable.`
  }
  return null
}

/**
 * Remove a storage location.
 *
 * Refuses while any `file_location` still points at it, and says how many —
 * dropping the row would leave those documents addressing a base dir that does
 * not exist, which is a broken viewer rather than a deletion the user asked for.
 * The caller is expected to have surfaced `removalBlocker` already; this is the
 * enforcement, not the message.
 */
export function removeBaseDir(db: DB, id: number): void {
  const blocker = removalBlocker(db, id)
  if (blocker) throw new Error(blocker)
  db.prepare(`DELETE FROM base_dir WHERE id = ?`).run(id)
}
