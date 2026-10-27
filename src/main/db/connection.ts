import Database from 'better-sqlite3'
import { canonicaliseMeasurement } from '../llm/units'
import { runMigrations } from './migrate'
import { loadSqliteVec } from './sqliteVec'
import { acquireWriteLock, releaseAllWriteLocks, type WriteLock } from './lock'

export type DB = Database.Database

let singleton: DB | null = null

export interface OpenOptions {
  /**
   * Open WITHOUT taking the single-writer lock and without the ability to
   * write. Audits, exports and the vector-search worker use this: reads do not
   * corrupt a file, so they are never made to wait for the app to close.
   */
  readonly?: boolean
  /** Name for this process in the refusal message another process would see. */
  label?: string
}

/** The write lock a writable connection holds, so `close` can release it. */
const lockFor = new WeakMap<DB, WriteLock>()

/**
 * Open (or reuse) the local SQLite database. WAL + FK + busy_timeout per
 * build-notes. The DB file must live on a LOCAL fs (never NAS) — WAL corrupts
 * on network filesystems.
 *
 * sqlite-vec is loaded HERE, on every connection, because an extension is
 * PER-CONNECTION. Two things need it: creating a space's `vec0` table (without
 * the module the `embed` stage would store vectors with no index), and reading
 * a database that already has one — `PRAGMA integrity_check` on a DB holding a
 * virtual table whose module is absent answers "malformed database schema",
 * which would condemn a perfectly healthy file.
 *
 * MANDATORY, and loud when it fails. There is no degraded mode: a connection
 * without the module cannot build a space's index, cannot read one that exists,
 * and answers `integrity_check` on a healthy file with "malformed database
 * schema". The old best-effort catch turned each of those into a slow or wrong
 * answer far from its cause, so the failure is raised HERE, naming the file we
 * looked for and how to provision it.
 */
export function openDatabase(dbPath: string, opts: OpenOptions = {}): DB {
  // A WRITABLE open takes the single-writer lock FIRST, before the file is
  // touched at all. Two processes writing this database concurrently is what
  // corrupted it; a read-only open takes nothing, because a reader cannot.
  const lock = opts.readonly ? null : acquireWriteLock(dbPath, opts.label)
  let db: DB
  try {
    db = new Database(dbPath, opts.readonly ? { readonly: true } : {})
  } catch (err) {
    lock?.release()
    throw err
  }
  if (lock) lockFor.set(db, lock)
  if (!opts.readonly) db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  // FULL rather than NORMAL. Under NORMAL a WAL checkpoint is not fsynced, so a
  // power loss or kernel panic can leave the WAL and the main file describing
  // different trees — and the damage this database took (B-trees cross-linked,
  // index entry counts disagreeing with their tables) is what a torn checkpoint
  // looks like. The cost is one fsync per commit on a 40 MB local nvme file,
  // which is not measurable next to an LLM call; the corpus runs that dominate
  // write volume commit once per work, not once per row.
  db.pragma('synchronous = FULL')
  try {
    loadSqliteVec(db)
  } catch (err) {
    lockFor.get(db)?.release()
    lockFor.delete(db)
    db.close()
    throw err
  }
  registerSearchFold(db)
  registerCanonicalUnit(db)
  registerRelayNow(db)
  return db
}

/**
 * The offset, in milliseconds, between this machine's wall clock and the sync
 * relay's. Zero until a relay has answered, which is the state of every install
 * that never shares anything.
 *
 * ONE CELL, in the main process, because last-write-wins needs ONE clock. The
 * v44 triggers stamp `updated_at` and the sync client compares those stamps
 * against a peer's; if the trigger used local time while the comparison happened
 * in relay time, a peer whose clock is three minutes fast would win every tie on
 * every row forever, and no local edit could displace it. So the offset is
 * applied at the point of STAMPING and nowhere else.
 */
let relayClockOffsetMs = 0

/**
 * Adopt an offset measured against a relay response.
 *
 * The caller measures elapsed time with a MONOTONIC clock: an NTP step or a
 * resume from sleep moves the wall clock underneath a wall-clock measurement and
 * would be indistinguishable from the relay being that far out.
 */
export function setRelayClockOffsetMs(offsetMs: number): void {
  relayClockOffsetMs = Number.isFinite(offsetMs) ? offsetMs : 0
}

export function relayClockOffset(): number {
  return relayClockOffsetMs
}

/**
 * `relay_now()` — the timestamp every synced table's `updated_at` is stamped
 * with, callable from SQL so the v44 triggers can use it.
 *
 * The format is SQLite's own `%Y-%m-%dT%H:%M:%fZ`, so a corpus that has never
 * synced (offset 0) is byte-identical to one written by `strftime('now')` and
 * nothing about the existing data changes shape.
 *
 * NOT deterministic, and deliberately not marked so: it reads a clock. Telling
 * SQLite otherwise would let it hoist the call out of a statement, which is
 * harmless here but is a lie the next reader would build on.
 *
 * Registered per CONNECTION for the reason `search_fold` and `canonical_unit`
 * are: a user-function does not outlive the handle that defined it, and a
 * trigger calling a missing function FAILS THE WRITE. A connection that skipped
 * this would make every UPDATE to a synced table throw "no such function" —
 * including the read-only connections, which install it too because
 * `integrity_check` on a schema naming an absent function is not something to
 * find out about in an audit.
 */
export function registerRelayNow(db: DB): void {
  db.function('relay_now', { deterministic: false, varargs: false }, () => relayNow())
}

/**
 * `relay_now()` from Node — the SAME clock the triggers stamp with.
 *
 * Exists because a handful of writers set `updated_at` EXPLICITLY (to keep it
 * equal to the `created_at` of the same transaction, so a freshly created row does
 * not read as edited). Those writes are legal — v44's `IS NOT` guard lets them
 * through — but they must not use the local wall clock: `updated_at` on a synced
 * table is read by the merge as relay time, so a machine whose clock is a few
 * minutes fast would win last-write-wins on those rows against every peer, for
 * every edit, silently. One clock, one stamping path.
 */
export function relayNow(): string {
  // NEVER GOES BACKWARDS. The offset is re-measured against every relay response,
  // so a relay stepping its own clock back — NTP correcting it, a restart onto a
  // different host — retracts this stamp by that much. Last-write-wins reads the
  // stamp as an ORDER, so an edit made after another would then compare as older
  // and lose to it, permanently and with nothing recording that it happened.
  //
  // Held at the last value instead, which real time overtakes within one step and
  // which at worst makes two edits tie — and a tie is settled deterministically by
  // the row-hash tie-break rather than being silently mis-ordered.
  const ms = Math.max(Date.now() + relayClockOffsetMs, lastRelayNowMs)
  lastRelayNowMs = ms
  return new Date(ms).toISOString().replace(/\.(\d{3})\d*Z$/, '.$1Z')
}

let lastRelayNowMs = 0

/**
 * `canonical_unit(unit)` and `canonical_value(value, unit)` — the derivation of
 * `measurement.unit_canonical` / `value_canonical`, callable from SQL.
 *
 * They exist so the TRIGGERS installed by v35 can derive both columns inside
 * the database, on every insert and on every update of the raw pair, whoever
 * the writer is. Three code paths write measurements today (the LLM pipeline,
 * the shipped-analyses loader, the project-archive restore) and only the first
 * two derived anything; a fourth will be written by someone who has never read
 * this file. A column any caller can forget will be forgotten, so the rule is
 * enforced where no caller can route around it.
 *
 * Registered per CONNECTION for the same reason `search_fold` is: a SQLite
 * user-function does not outlive the handle that defined it, and a trigger that
 * calls a missing function fails the write. Every writable connection therefore
 * has to install them, which `openDatabase` does for all of them.
 *
 * DETERMINISTIC: the parser is a pure function of its arguments, with no clock,
 * no randomness and no database access.
 */
export function registerCanonicalUnit(db: DB): void {
  db.function('canonical_unit', { deterministic: true, varargs: false }, (unit: unknown) =>
    canonicaliseMeasurement(null, typeof unit === 'string' ? unit : null).unit
  )
  db.function(
    'canonical_value',
    { deterministic: true, varargs: false },
    (value: unknown, unit: unknown) =>
      canonicaliseMeasurement(
        typeof value === 'number' ? value : null,
        typeof unit === 'string' ? unit : null
      ).value
  )
}

/**
 * `search_fold(text)` — the shape a search compares in.
 *
 * Registered per CONNECTION, like the extension above, because a SQLite
 * user-function does not outlive the handle that defined it. Every connection
 * that runs a query therefore has to install it, or the query fails with "no
 * such function" rather than degrading.
 *
 * WHY IT MUST BE JS AND NOT SQL. Accent-folding needs Unicode decomposition:
 * `Röthlisberger` has to compare equal to `Rothlisberger`, and SQLite's own
 * `lower()`/`LIKE` are ASCII-only by design — they leave every accented letter
 * untouched, so a reader who cannot type an umlaut cannot find the paper. A
 * `replace()` chain could hard-code the handful of accented characters in
 * today's corpus, but the next imported paper brings its own, and a search that
 * silently fails on names it has never seen is worse than one that never
 * folded. NFD + stripping combining marks handles the whole class.
 *
 * The steps, in order, and why each:
 *   - NFD, then drop `\p{M}`: separates a base letter from its accent and
 *     removes the accent. Leaves `×` and `≤` alone — those are mathematical
 *     symbols, not decorated letters, and flattening them would merge distinct
 *     strings.
 *   - hyphen/dash/underscore -> space: "off the shelf" must find
 *     "off-the-shelf". Which separator a compound uses is the house style of
 *     whoever printed it.
 *   - collapse runs of whitespace: a typed double space, and the newlines that
 *     arrive inside extracted abstracts, must not defeat a match.
 *   - lowercase: so callers need no separate COLLATE, and the folding is the
 *     same on both sides of every comparison.
 *
 * DETERMINISTIC: same input, same output, no clock or randomness — which is
 * what lets SQLite use it safely and what would let an expression index be
 * built on it later if this corpus ever outgrows a scan.
 */
export function registerSearchFold(db: DB): void {
  db.function('search_fold', { deterministic: true, varargs: false }, (v: unknown) => {
    if (typeof v !== 'string') return v === null || v === undefined ? null : String(v)
    return v
      .normalize('NFD')
      .replace(/\p{M}+/gu, '')
      .replace(/[-\u2013\u2014_]/g, ' ')
      .replace(/\s+/g, ' ')
      .toLowerCase()
  })
}

/**
 * The same folding, in JS, for the QUERY side of a comparison.
 *
 * Callers must fold the query themselves rather than wrapping the bound
 * parameter in `search_fold(?)`: the LIKE pattern is built by escaping `\ % _`,
 * and folding after that turns an escaped `\_` into `\ ` — a backslash and a
 * space, which is not an escape, so the underscore reverts to a wildcard.
 * (Measured: a query of "_" then matched every paper.) Folding here, before the
 * pattern is assembled, keeps the two sides identical and the escaping intact.
 */
export function foldForSearch(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[-\u2013\u2014_]/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

/**
 * Open + migrate. Used by the main process at startup and by every CLI script.
 *
 * Always writable, and therefore always exclusive: migrations run here, and
 * migration DDL concurrent with another process's writes is the mechanism that
 * destroyed 33 analysis runs. If another process holds the file this throws
 * `DatabaseLockedError`, whose message names the holder and the two ways out.
 *
 * A read-only consumer must call `openDatabaseReadOnly()` instead — it will
 * never be refused, and it never migrates.
 */
export function initDatabase(dbPath: string, opts: { label?: string } = {}): DB {
  const db = openDatabase(dbPath, { label: opts.label })
  try {
    runMigrations(db, { hasExclusiveLock: true })
  } catch (err) {
    closeDatabase(db)
    throw err
  }
  return db
}

/**
 * Open for READING ONLY: no lock, no migration, and the file cannot be written
 * even by a bug. This is the correct open for audits, exports and reports, and
 * it is the reason the single-writer guard does not make the app and the CLI
 * mutually exclusive — everything that only looks at the corpus can look at it
 * while the app is open.
 *
 * The schema is whatever is on disk. A database older than this build is not
 * migrated forward here (that needs exclusivity); a caller that requires a
 * newer column should check `user_version` and say so.
 */
export function openDatabaseReadOnly(dbPath: string): DB {
  return openDatabase(dbPath, { readonly: true })
}

/** Close a connection and release the write lock it holds, if any. */
export function closeDatabase(db: DB): void {
  try {
    db.close()
  } finally {
    lockFor.get(db)?.release()
    lockFor.delete(db)
  }
}

export function getDb(): DB {
  if (!singleton) throw new Error('Database not initialised. Call setDb() first.')
  return singleton
}

export function setDb(db: DB): void {
  singleton = db
}

export function closeDb(): void {
  if (singleton) {
    closeDatabase(singleton)
    singleton = null
  }
  // Belt and braces for a process that opened more than the singleton: the
  // kernel would release these on exit anyway, but a long-lived process that
  // closed its DB and kept running must not keep the next writer out.
  releaseAllWriteLocks()
}

