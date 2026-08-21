// Take a consistent copy of a database that another process may be writing.
//
//   ELECTRON_RUN_AS_NODE=1 electron --import tsx scripts/snapshot-db.ts <src> <dest>
//
// `VACUUM INTO` runs inside a read transaction on a READ-ONLY connection, so it
// never contends with the writer and never needs the single-writer lock. A
// plain file copy would not do: the source is in WAL mode, so the committed
// state is split between the database file and a `-wal` sidecar that is being
// appended to as the copy runs, and the result can be a file whose pages come
// from two different transactions.

import { mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { openDatabaseReadOnly } from '../src/main/db/connection'

function main(): void {
  const [src, dest] = process.argv.slice(2)
  if (!src || !dest) {
    console.error('usage: snapshot-db.ts <source.sqlite> <dest.sqlite>')
    process.exit(1)
  }
  mkdirSync(dirname(dest), { recursive: true })
  for (const suffix of ['', '-wal', '-shm']) rmSync(dest + suffix, { force: true })

  const db = openDatabaseReadOnly(src)
  try {
    db.prepare('VACUUM INTO ?').run(dest)
  } finally {
    db.close()
  }
  // eslint-disable-next-line no-console
  console.log(`[snapshot] ${src} -> ${dest}`)
}

main()
