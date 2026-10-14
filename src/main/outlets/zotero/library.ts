// Read a Zotero library.
//
// STRICTLY READ-ONLY, and deliberately so. Zotero's `zotero.sqlite` is its
// private store: it is locked while Zotero runs, its schema changes between
// versions, and writing to it behind Zotero's back is the documented way to
// corrupt somebody's entire reference library. We read, and we hand anything we
// want Zotero to know back through a file Zotero imports itself.
//
// The connection uses `immutable=1`, which is what makes reading a LIVE library
// safe: SQLite then treats the file as unchanging and never takes a lock, so we
// cannot block Zotero and Zotero's own WAL activity cannot make us fail. The
// trade-off is that we may observe a slightly stale snapshot — correct for a
// list of collections, and vastly preferable to holding a lock on it.

import Database from 'better-sqlite3'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'

/** One Zotero collection, as the mapping UI needs it. */
export interface ZoteroCollection {
  key: string
  name: string
  /** Full path with parents, e.g. "Projects / Kemp eliminases". */
  path: string
  itemCount: number
}

/** One item, reduced to what an import would create. */
export interface ZoteroItem {
  key: string
  title: string
  doi: string | null
  year: number | null
  publication: string | null
  creators: string[]
  /** Absolute path of a linked/stored PDF attachment, when resolvable. */
  attachmentPath: string | null
  /**
   * The attachment's path RELATIVE to the Zotero data directory, for a stored
   * attachment (`storage/<key>/<file>`); null for a linked file that lives
   * outside it.
   *
   * Carried separately because the import records ONE base_dir — the data
   * directory — with this as the relative path. Deriving a base dir from the
   * file's own parent instead would create a storage location per item, since
   * every stored attachment sits in its own `storage/<key>/` folder.
   */
  attachmentRelPath: string | null
}

/**
 * The conventional Zotero data directory.
 *
 * `$ZOTERO_DATA_DIR` wins, else the platform default `~/Zotero`. We do NOT parse
 * Zotero's prefs file to discover a relocated directory: reading another app's
 * config to make a confident claim is the sort of guess this code avoids. If it
 * is elsewhere the user points us at it, and the UI shows the path we looked in.
 */
export function defaultZoteroDir(): string {
  const env = process.env.ZOTERO_DATA_DIR
  if (env && env.trim()) return env.trim()
  return join(homedir(), 'Zotero')
}

export function zoteroSqlitePath(dataDir: string): string {
  return join(dataDir, 'zotero.sqlite')
}

/**
 * Run `fn` against a SNAPSHOT of the library.
 *
 * The file is copied to a temp path and the copy is opened; the original is only
 * ever read by `copyFile`. This is what makes reading a LIVE library safe: we
 * take no SQLite lock on the user's file, so we can neither block Zotero nor
 * fail because Zotero holds a write lock, and there is no path by which a bug
 * here could modify a reference library that may represent years of work.
 *
 * The alternative — SQLite's `immutable=1` URI — is not available: better-sqlite3
 * accepts no `uri` option and passes the whole string to the OS as a filename,
 * so `file:…?immutable=1` fails with "directory does not exist". That is exactly
 * how this shipped, silently broken, until a probe exercised it.
 *
 * The cost is copying the file (tens of MB for a large library). Acceptable for
 * an explicit, occasional action, and it buys a guarantee that is worth more.
 */
function withLibrary<T>(dataDir: string, fn: (db: Database.Database) => T): T {
  const source = zoteroSqlitePath(dataDir)
  if (!existsSync(source)) throw new Error(`no zotero.sqlite in ${dataDir}`)

  const snapshot = join(mkdtempSync(join(tmpdir(), 'corpus-zotero-')), 'zotero.sqlite')
  try {
    copyFileSync(source, snapshot)
    // A live Zotero keeps recent commits in the -wal sidecar; without it the
    // snapshot would be silently stale, hiding collections created today.
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(source + suffix)) copyFileSync(source + suffix, snapshot + suffix)
    }
    const db = new Database(snapshot, { readonly: true, fileMustExist: true })
    try {
      return fn(db)
    } finally {
      db.close()
    }
  } finally {
    rmSync(dirname(snapshot), { recursive: true, force: true })
  }
}

/**
 * Every collection, with its full path and item count.
 *
 * Zotero's schema is stable in this corner across the versions in use (7.x and
 * late 6.x): `collections` carries `collectionName` and `parentCollectionID`.
 * A schema change surfaces as a thrown SqliteError, which the caller reports as
 * "could not read the library" rather than as "no collections" — an empty list
 * would be a fabricated fact about somebody's library.
 */
export function listCollections(dataDir: string): ZoteroCollection[] {
  return withLibrary(dataDir, (db) => {
    const rows = db
      .prepare(
        `SELECT c.collectionID AS id, c.collectionName AS name,
                c.key AS key, c.parentCollectionID AS parent,
                (SELECT COUNT(*) FROM collectionItems ci
                  WHERE ci.collectionID = c.collectionID) AS itemCount
           FROM collections c
          ORDER BY c.collectionName COLLATE NOCASE ASC`
      )
      .all() as Array<{
      id: number
      name: string
      key: string
      parent: number | null
      itemCount: number
    }>

    const byId = new Map(rows.map((r) => [r.id, r]))
    const pathOf = (r: (typeof rows)[number]): string => {
      const parts = [r.name]
      let cur = r.parent
      // Bounded: a corrupt parent cycle must not hang the app.
      for (let i = 0; i < 32 && cur !== null; i++) {
        const p = byId.get(cur)
        if (!p) break
        parts.unshift(p.name)
        cur = p.parent
      }
      return parts.join(' / ')
    }

    return rows.map((r) => ({
      key: r.key,
      name: r.name,
      path: pathOf(r),
      itemCount: r.itemCount
    }))
  })
}

/**
 * Items in one collection.
 *
 * Zotero stores field values in a normalised triple (`itemData` →
 * `itemDataValues`), keyed by `fieldID` from `fields`. Joining by field NAME
 * rather than by a hardcoded id is what keeps this working across versions,
 * where the numeric ids differ.
 */
export function listCollectionItems(dataDir: string, collectionKey: string): ZoteroItem[] {
  return withLibrary(dataDir, (db) => {
    const col = db
      .prepare(`SELECT collectionID AS id FROM collections WHERE key = ?`)
      .get(collectionKey) as { id: number } | undefined
    if (!col) return []

    const items = db
      .prepare(
        `SELECT i.itemID AS id, i.key AS key
           FROM collectionItems ci
           JOIN items i ON i.itemID = ci.itemID
           LEFT JOIN deletedItems d ON d.itemID = i.itemID
          WHERE ci.collectionID = ? AND d.itemID IS NULL`
      )
      .all(col.id) as Array<{ id: number; key: string }>
    if (items.length === 0) return []

    const ids = items.map((i) => i.id)
    const ph = ids.map(() => '?').join(',')

    const fields = new Map<number, Record<string, string>>()
    for (const r of db
      .prepare(
        `SELECT idata.itemID AS id, f.fieldName AS name, v.value AS value
           FROM itemData idata
           JOIN fields f ON f.fieldID = idata.fieldID
           JOIN itemDataValues v ON v.valueID = idata.valueID
          WHERE idata.itemID IN (${ph})`
      )
      .all(...ids) as Array<{ id: number; name: string; value: string }>) {
      const rec = fields.get(r.id) ?? {}
      rec[r.name] = r.value
      fields.set(r.id, rec)
    }

    const creators = new Map<number, string[]>()
    for (const r of db
      .prepare(
        `SELECT ic.itemID AS id, c.lastName AS last, c.firstName AS first
           FROM itemCreators ic
           JOIN creators c ON c.creatorID = ic.creatorID
          WHERE ic.itemID IN (${ph})
          ORDER BY ic.itemID, ic.orderIndex ASC`
      )
      .all(...ids) as Array<{ id: number; last: string | null; first: string | null }>) {
      const list = creators.get(r.id) ?? []
      list.push([r.first, r.last].filter(Boolean).join(' ').trim())
      creators.set(r.id, list)
    }

    // A stored attachment lives under storage/<key>/<filename>; a linked one
    // records an absolute path. Both are reported as an absolute path or null —
    // never a guess.
    const attachments = new Map<number, { abs: string; rel: string | null }>()
    for (const r of db
      .prepare(
        `SELECT ia.parentItemID AS parent, ia.path AS path, i.key AS key
           FROM itemAttachments ia
           JOIN items i ON i.itemID = ia.itemID
          WHERE ia.parentItemID IN (${ph}) AND ia.contentType = 'application/pdf'`
      )
      .all(...ids) as Array<{ parent: number; path: string | null; key: string }>) {
      if (!r.path || attachments.has(r.parent)) continue
      if (r.path.startsWith('storage:')) {
        // A STORED attachment: Zotero keeps it under storage/<itemKey>/<file>
        // inside the data directory. The relative half is what the import
        // records, so all of them share one storage location.
        const rel = `storage/${r.key}/${r.path.slice('storage:'.length)}`
        attachments.set(r.parent, { abs: join(dataDir, rel), rel })
      } else if (r.path.startsWith('attachments:')) {
        // A linked attachment under a base directory Zotero knows and we do
        // not. Reported as absent rather than guessed at.
        continue
      } else {
        // An absolute link to a file anywhere on disk. It has no meaningful
        // path relative to the data directory, so it gets its own location.
        attachments.set(r.parent, { abs: r.path, rel: null })
      }
    }

    return items.map((it) => {
      const f = fields.get(it.id) ?? {}
      const dateRaw = f.date ?? ''
      const yearMatch = dateRaw.match(/\b(1[5-9]\d{2}|20\d{2})\b/)
      return {
        key: it.key,
        title: f.title ?? '(untitled)',
        doi: f.DOI ?? null,
        year: yearMatch ? Number(yearMatch[1]) : null,
        publication: f.publicationTitle ?? null,
        creators: creators.get(it.id) ?? [],
        attachmentPath: attachments.get(it.id)?.abs ?? null,
        attachmentRelPath: attachments.get(it.id)?.rel ?? null
      }
    })
  })
}
