// Loading the sqlite-vec extension onto a connection — the ONE place that does
// it, so every context that opens this database agrees on what "loaded" means
// and on what to say when it is not.
//
// An SQLite extension is PER-CONNECTION, not per-process, so this is called on
// each connection rather than once at startup: the app's writable handle, the
// read-only vector-search worker thread, and the electron-as-node scripts
// (`repair:corpus`, seed, verify) each open their own.
//
// It THROWS. There is deliberately no degraded path, because every one of them
// is worse than a stop:
//   - `embed` would write chunks with no `vec0` row, so the corpus would look
//     indexed while nothing was;
//   - `PRAGMA integrity_check` on a database holding a `chunk_vec_*` virtual
//     table whose module is absent answers "malformed database schema", which
//     condemns a healthy file;
//   - search would scan every vector in the corpus and return the same rows,
//     correct and arbitrarily slow, with the cost visible only as a log line
//     nobody reads.
// Each of those surfaces the fault far from its cause. A missing extension is a
// PROVISIONING fault with one fix (`npm run payloads`), so it is raised here,
// naming the file that was looked for.

import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { isPackaged, platformKey, sqliteVecPath } from '../resources'

/**
 * What the reader can actually DO about it, which is not the same sentence in
 * both places this can happen. `npm run payloads` is the fix in a checkout and
 * is meaningless to a scientist running an installer, who has no repository and
 * no npm — telling them to run it would be a dead end dressed as a remedy.
 */
function remedy(): string {
  return isPackaged()
    ? 'This installer was built incomplete. Reinstall Corpus Studio from a complete build; ' +
        'your corpus is not affected.'
    : `Run \`npm run payloads\` to provision it for ${platformKey()}.`
}

/**
 * A sqlite-vec that will not load. Its own class so a caller that can present
 * an install-repair action to the user can tell it from a database error.
 */
export class SqliteVecUnavailableError extends Error {
  constructor(
    message: string,
    /** The extension file this host looked for. */
    readonly path: string
  ) {
    super(message)
    this.name = 'SqliteVecUnavailableError'
  }
}

/**
 * Load sqlite-vec onto `db`, or throw `SqliteVecUnavailableError`.
 *
 * The two failures are distinguished because they have different fixes: an
 * ABSENT file means the resources tree was never provisioned, while a file that
 * is present and will not `dlopen` means it is the wrong build for this host or
 * for this ABI — better-sqlite3 is rebuilt for Electron by `electron-rebuild`,
 * and an extension built against a different SQLite fails only at load.
 */
export function loadSqliteVec(db: BetterSqlite3Database): void {
  const path = sqliteVecPath()
  if (!existsSync(path)) {
    throw new SqliteVecUnavailableError(
      `sqlite-vec is missing from this build: no extension at ${path}. ` +
        `Vector search, indexing and integrity checks all require it. ${remedy()}`,
      path
    )
  }
  try {
    db.loadExtension(path)
  } catch (err) {
    throw new SqliteVecUnavailableError(
      `sqlite-vec at ${path} would not load into this build of better-sqlite3 ` +
        `(${(err as Error).message}). The extension is present but not usable on ` +
        `${platformKey()}, which means it was built for a different ABI. ${remedy()}`,
      path
    )
  }
}
