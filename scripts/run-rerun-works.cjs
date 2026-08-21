// Run the scoped work re-runner inside a REAL Electron main process.
//
//   npm run rerun:works -- 11 12 13
//
// Same reason as `run-corpus-process.cjs`: under `ELECTRON_RUN_AS_NODE=1`,
// `require('electron')` returns the STRING path to the binary, so
// `utilityProcess` is undefined and `HostPool.spawn()` cannot start a
// host-isolated stage. A repair must run the same stages the user's machine
// runs, so it runs under a real main process.

require('tsx/cjs')
const { app } = require('electron')

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  try {
    await require('./rerun-works.ts').rerunWorks(process.argv.slice(2))
    app.exit(0)
  } catch (err) {
    console.error(String((err && err.message) || err))
    app.exit(1)
  }
})
