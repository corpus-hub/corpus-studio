// Run the corpus processor inside a REAL Electron main process.
//
//   npm run corpus:process
//
// Same reason as `run-corpus-verify.cjs`: under `ELECTRON_RUN_AS_NODE=1`,
// `require('electron')` returns the STRING path to the binary, so
// `utilityProcess` is undefined and `HostPool.spawn()` cannot start a single
// host-isolated stage — which is most of the pipeline (extract-text, ocr,
// segment, embed, optimize). The corpus must be processed by the same stages a
// user's machine would run, so it runs under a real main process.

require('tsx/cjs')
const { app } = require('electron')

// This process never opens a window, so it needs no GPU at all.
//
// `disableHardwareAcceleration()` alone does NOT stop Chromium launching a GPU
// process; it only stops it using one for compositing. Under xvfb that launch
// fails (`error_code=1002`), Chromium retries it six times, and then takes the
// whole process down with `FATAL: GPU process isn't usable. Goodbye.` — killing
// a corpus run mid-flight three times in a row, each after ~20 minutes of work,
// with the surviving jobs left queued and no error attributable to any stage.
//
// Switching the GPU off outright removes the process that cannot start. The
// software rasteriser goes with it: it is the fallback Chromium reaches for
// when the GPU is unavailable, and it is equally pointless with no window.
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-software-rasterizer')
app.commandLine.appendSwitch('disable-gpu-compositing')

app.whenReady().then(async () => {
  try {
    await require('./process-corpus.ts').processCorpus()
    app.exit(0)
  } catch (err) {
    console.error(String((err && err.message) || err))
    app.exit(1)
  }
})
