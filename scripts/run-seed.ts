// Seed runner. Runs in a plain Node/tsx context (NOT electron) so it can use the
// SAME better-sqlite3 native module the app uses. Honors CORPUS_DB_PATH and
// CORPUS_FAKE_NOW. `--fresh` deletes the DB (and WAL sidecars) first.

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { initDatabase, setDb, closeDb } from '../src/main/db/connection'
import { seed } from '../src/main/db/seed'
import { defaultDbPath } from '../src/main/db/paths'

function main(): void {
  const fresh = process.argv.includes('--fresh')
  const dbPath = defaultDbPath()
  mkdirSync(dirname(dbPath), { recursive: true })

  if (fresh) {
    // `.lock` and `.lock.json` go too: they belong to the file being deleted,
    // and a leftover pair describing a database that no longer exists is a
    // confusing thing to find beside a brand-new one.
    for (const suffix of ['', '-wal', '-shm', '.lock', '.lock-journal', '.lock.json']) {
      const p = dbPath + suffix
      if (existsSync(p)) rmSync(p)
    }
  }

  const db = initDatabase(dbPath) // migrate (creates schema on fresh DB)
  setDb(db)
  seed(db, { now: process.env.CORPUS_FAKE_NOW })
  closeDb()

  // eslint-disable-next-line no-console
  console.log(`[seed] ok -> ${dbPath} (fresh=${fresh})`)
}

main()
