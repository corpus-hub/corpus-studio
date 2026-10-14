// Run the full-corpus driver inside a REAL Electron main process.
//
//   npm run verify:corpus
//
// Why not `ELECTRON_RUN_AS_NODE=1 electron --import tsx scripts/verify-corpus.ts`
// (the way every other verify script runs)? Under RUN_AS_NODE `require('electron')`
// returns the STRING path to the binary, so `utilityProcess` is `undefined` and
// `HostPool.spawn()` dies with "Cannot read properties of undefined (reading
// 'exports')". Every host-isolated stage — extract-text, ocr, segment, embed,
// optimize — therefore CANNOT run under the harness the gates use. That is the
// coverage hole this file exists to close.

require('tsx/cjs')
const { app } = require('electron')

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  try {
    await require('./verify-corpus.ts').run()
    app.exit(0)
  } catch (err) {
    console.error(err)
    app.exit(1)
  }
})
