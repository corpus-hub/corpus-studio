// The single-writer guard.
//
// WHY THIS EXISTS. `initDatabase()` is called by the app AND by ~15 CLI scripts,
// each on `defaultDbPath()`, each read-write, and each running `runMigrations()`
// opportunistically on whatever it found. WAL makes concurrent WRITERS safe;
// it makes concurrent SCHEMA CHANGES nothing of the sort. Migration v34 was
// applied by the running app while a detached corpus runner was inserting into
// `analysis_run`, and the file came back with rowids out of order across six
// B-trees, ~15 indexes with wrong entry counts, and two trees cross-linked so a
// query on one table returned rows of another. 33 analysis runs were lost.
//
// THE MECHANISM: a SECOND SQLite file beside the database, held open in
// `locking_mode=EXCLUSIVE` for the lifetime of the writing process.
//
// A pid-file was the obvious alternative and is worse in the way that matters:
// its correctness rests on a liveness heuristic (is pid 1234 alive? is it still
// the SAME process 1234?), and every heuristic has a hole that ends with a
// developer deleting a lock file by hand — after which the guard is gone and
// nobody notices. Here the lock is a POSIX fcntl lock on a file descriptor. The
// kernel owns it. It cannot be stale: when the holder exits, crashes, is
// SIGKILLed, or is OOM-killed, the descriptor is closed by the kernel and the
// lock is released in the same instant. There is no reclaim path to get wrong
// because there is nothing to reclaim.
//
// WHY NOT `locking_mode=EXCLUSIVE` ON THE DATABASE ITSELF — which would need no
// second file at all: it would also refuse every READ-ONLY connection, and
// read-only connections are both safe and constant here (the vector-search
// worker thread, the audit and export scripts, `verify-seed`). Reads are not
// what corrupts a database. Putting the lock on a separate file makes the guard
// exactly as wide as the hazard.
//
// The lock file is derived from the database path, so two processes on two
// different `CORPUS_DB_PATH` values contend for nothing — which is what keeps
// parallel e2e specs and `--fresh` screenshots working.

import Database from 'better-sqlite3'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { hostname } from 'node:os'

/** Thrown when another live process already holds the write lock. */
export class DatabaseLockedError extends Error {
  readonly dbPath: string
  readonly holder: HolderInfo | null
  constructor(message: string, dbPath: string, holder: HolderInfo | null) {
    super(message)
    this.name = 'DatabaseLockedError'
    this.dbPath = dbPath
    this.holder = holder
  }
}

export interface HolderInfo {
  pid: number
  label: string
  host: string
  since: string
}

export interface WriteLock {
  readonly dbPath: string
  readonly lockPath: string
  release(): void
}

interface Held {
  lock: Database.Database
  lockPath: string
  refs: number
}

/** Locks held by THIS process, keyed by the resolved database path. */
const held = new Map<string, Held>()

function lockPathFor(dbPath: string): string {
  return `${resolve(dbPath)}.lock`
}
function infoPathFor(dbPath: string): string {
  return `${resolve(dbPath)}.lock.json`
}

/**
 * A human label for whoever is holding the lock, so the refusal can NAME the
 * process to close rather than leaving the reader to guess between the app, a
 * corpus run and a forgotten probe.
 */
function selfLabel(explicit?: string): string {
  if (explicit) return explicit
  const script = process.argv.slice(1).find((a) => /\.(ts|js|cjs|mjs)$/.test(a))
  if (script) return basename(script)
  return basename(process.argv[0] ?? 'unknown')
}

/**
 * Best-effort identity of the holder, written as a PLAIN sidecar rather than
 * into the lock database. The lock database is unreadable while it is held —
 * that is the whole point of an exclusive lock — so the diagnostic has to live
 * somewhere a blocked process can still read. It is advisory only: nothing
 * decides anything from it, so a leftover copy naming a dead pid is harmless,
 * and it is labelled as unverified where it is shown.
 */
function readHolderInfo(dbPath: string): HolderInfo | null {
  try {
    const raw = readFileSync(infoPathFor(dbPath), 'utf8')
    const v = JSON.parse(raw) as Partial<HolderInfo>
    if (typeof v.pid !== 'number') return null
    return {
      pid: v.pid,
      label: String(v.label ?? 'unknown'),
      host: String(v.host ?? 'unknown'),
      since: String(v.since ?? 'unknown')
    }
  } catch {
    return null
  }
}

function describeHolder(h: HolderInfo | null): string {
  if (!h) return 'another process'
  const sameHost = h.host === hostname()
  return `${h.label} (pid ${h.pid}${sameHost ? '' : ` on ${h.host}`}, since ${h.since})`
}

/**
 * What a PERSON is told when they open the app twice.
 *
 * Written for whoever double-clicked the icon, not for whoever wrote this file.
 * The previous text opened with "the database is already open for writing",
 * printed the file path, explained that concurrent writes had corrupted it once,
 * and offered an environment variable — a post-mortem of a locking design, put
 * in front of a scientist whose only mistake was clicking twice. Nothing in it
 * was untrue and nothing in it helped.
 *
 * What helps is the one fact they can act on: the app is already running, look
 * for the window they have. Everything else — the pid, the path, the mechanism —
 * belongs in the log, where it is written anyway.
 */
function refusalMessage(dbPath: string, holder: HolderInfo | null): string {
  return (
    'Corpus Studio is already running on this computer.\n\n' +
    'Switch to the window that is already open — your work is there. If you ' +
    'cannot find it, close Corpus Studio and start it again.'
  )
}

/**
 * The same refusal, for a TERMINAL.
 *
 * A script that is refused has a different reader with a different remedy: they
 * can point the command at another file, which a person clicking an icon cannot.
 * Keeping the two apart is what lets the dialog stay one sentence.
 */
export function refusalDetail(dbPath: string, holder: HolderInfo | null): string {
  return (
    `The database is already open for writing by ${describeHolder(holder)}.\n` +
    `  database: ${dbPath}\n` +
    'Two processes writing this file at once is what corrupted it before, so ' +
    'this one will not open it.\n' +
    'Close Corpus Studio (or stop the corpus run) and try again, or work ' +
    'against a separate database:  CORPUS_DB_PATH=/tmp/scratch.sqlite <command>\n' +
    'Read-only access is never blocked.' +
    (holder ? '\n(The holder is recorded beside the database and is not verified.)' : '')
  )
}

/**
 * Take the write lock for `dbPath`. Throws `DatabaseLockedError` if another
 * process holds it. Re-entrant within one process: nested calls share the one
 * lock and are released when the last is released.
 */
export function acquireWriteLock(dbPath: string, label?: string): WriteLock {
  const key = resolve(dbPath)
  const existing = held.get(key)
  if (existing) {
    existing.refs += 1
    return makeHandle(key, existing)
  }

  const lockPath = lockPathFor(key)
  let lock: Database.Database
  try {
    lock = new Database(lockPath)
  } catch (err) {
    throw new Error(`Could not create the database lock file ${lockPath}: ${String(err)}`)
  }

  try {
    // Rollback-journal mode deliberately: `locking_mode=EXCLUSIVE` has crisp,
    // documented semantics there (an exclusive fcntl lock taken on the first
    // write and held until the connection closes). WAL would use a shared-memory
    // file instead and give a different, weaker guarantee.
    lock.pragma('journal_mode = DELETE')
    lock.pragma('locking_mode = EXCLUSIVE')
    // Zero, not the usual 5000: the answer to "somebody else has it" is to say
    // so immediately. Waiting five seconds only delays a message the caller has
    // to act on, and a caller who wants to wait can retry.
    lock.pragma('busy_timeout = 0')
    // The write is what promotes the connection to the held exclusive lock.
    lock.exec(
      'CREATE TABLE IF NOT EXISTS write_lock (id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER NOT NULL, label TEXT NOT NULL, host TEXT NOT NULL, since TEXT NOT NULL)'
    )
    lock
      .prepare(
        'INSERT INTO write_lock (id, pid, label, host, since) VALUES (1, ?, ?, ?, ?) ' +
          'ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, label = excluded.label, host = excluded.host, since = excluded.since'
      )
      .run(process.pid, selfLabel(label), hostname(), new Date().toISOString())
  } catch (err) {
    try {
      lock.close()
    } catch {
      /* the handle is already unusable; nothing to salvage */
    }
    const code = (err as { code?: string }).code ?? ''
    if (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_PROTOCOL')) {
      const holder = readHolderInfo(key)
      // The pid, the path and the mechanism go to the LOG, unconditionally.
      // They are what a bug report needs and what a terminal caller acts on;
      // they are not what the dialog says, because the person reading that only
      // needs to know the app is already running.
      // eslint-disable-next-line no-console
      console.error(`[db] refused to open for writing\n${refusalDetail(dbPath, holder)}`)
      throw new DatabaseLockedError(refusalMessage(dbPath, holder), dbPath, holder)
    }
    throw err
  }

  try {
    writeFileSync(
      infoPathFor(key),
      JSON.stringify(
        { pid: process.pid, label: selfLabel(label), host: hostname(), since: new Date().toISOString() },
        null,
        2
      )
    )
  } catch {
    /* diagnostic only; a lock that cannot describe itself is still a valid lock */
  }

  const entry: Held = { lock, lockPath, refs: 1 }
  held.set(key, entry)
  return makeHandle(key, entry)
}

function makeHandle(key: string, entry: Held): WriteLock {
  let released = false
  return {
    dbPath: key,
    lockPath: entry.lockPath,
    release(): void {
      if (released) return
      released = true
      entry.refs -= 1
      if (entry.refs > 0) return
      held.delete(key)
      try {
        entry.lock.close()
      } catch {
        /* closing a lock we are abandoning anyway */
      }
      for (const p of [infoPathFor(key)]) {
        try {
          if (existsSync(p)) rmSync(p)
        } catch {
          /* leftover diagnostics are advisory and harmless */
        }
      }
    }
  }
}

/** Does THIS process hold the write lock for `dbPath`? */
export function holdsWriteLock(dbPath: string): boolean {
  return held.has(resolve(dbPath))
}

/** Release every lock this process holds. Called on shutdown paths. */
export function releaseAllWriteLocks(): void {
  for (const key of [...held.keys()]) {
    const entry = held.get(key)
    if (!entry) continue
    entry.refs = 1
    makeHandle(key, entry).release()
  }
}
