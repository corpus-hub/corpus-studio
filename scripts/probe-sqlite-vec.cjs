// Load sqlite-vec the way the application does, in whichever host is running
// this file, and print ONE line of JSON saying what happened.
//
//   electron scripts/probe-sqlite-vec.cjs                    # the Electron app's host
//   ELECTRON_RUN_AS_NODE=1 electron scripts/probe-sqlite-vec.cjs   # the CLI scripts' host
//
// Two hosts, because they are not the same environment and only one of them is
// exercised by an ordinary `npm run verify:*`. Under ELECTRON_RUN_AS_NODE the
// `app` object does not exist and `process.resourcesPath` points at the vendored
// electron's own tree; in the app it points at the installed bundle. The path
// this file prints is therefore the one thing a reader needs to see when a
// verify script passes and the shipped app cannot open a corpus.
//
// It deliberately does NOT call `app.whenReady()`: no window, no GPU, no
// display. The question is whether `better-sqlite3` in THIS process can dlopen
// the extension, and that is answerable before the browser process starts.

require('tsx/cjs')

const out = { host: process.env.ELECTRON_RUN_AS_NODE ? 'run-as-node' : 'electron' }
try {
  const Database = require('better-sqlite3')
  const { loadSqliteVec } = require('../src/main/db/sqliteVec.ts')
  const { sqliteVecPath, platformKey, isPackaged } = require('../src/main/resources.ts')
  out.path = sqliteVecPath()
  out.platformKey = platformKey()
  out.packaged = isPackaged()
  const db = new Database(':memory:')
  loadSqliteVec(db)
  out.vecVersion = db.prepare('select vec_version() as v').get().v
  // The MODULE, not just the symbol: `vec_version()` is a scalar function and
  // resolves even from a partially registered extension, while a virtual table
  // is the thing every embedding space actually needs.
  db.exec('create virtual table probe using vec0(id integer primary key, v float[4])')
  out.vec0Table = true
  db.close()
  out.ok = true
} catch (err) {
  out.ok = false
  out.errorName = err && err.name
  out.error = String((err && err.message) || err)
}
process.stdout.write(JSON.stringify(out) + '\n')
process.exit(out.ok ? 0 : 3)
