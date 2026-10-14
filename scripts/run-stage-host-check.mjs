// Build `verify-stage-host.ts` and run it under REAL Electron.
//
// Same constraint as `run-host-check.mjs`, for the same reason: this gate exists
// precisely BECAUSE `ELECTRON_RUN_AS_NODE=1 electron --import tsx` cannot reach
// `utilityProcess`, so it must not be run that way — and Electron proper does
// not accept node's `--import` flag (it reads the next argument as the app
// path). Hence bundle first, run the bundle.
//
// It also needs `out/main/stageHost.js`, the BUILT host the app actually loads,
// so it asserts the build exists rather than failing later with a spawn error
// that reads like a pool bug.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const host = join(process.cwd(), 'out', 'main', 'stageHost.js')
if (!existsSync(host)) {
  console.error(`missing ${host} — run \`npm run build\` first`)
  process.exit(1)
}

const out = mkdtempSync(join(tmpdir(), 'corpus-stage-host-build-'))
const entry = join(out, 'verify-stage-host.cjs')

const build = spawnSync(
  'npx',
  [
    'esbuild',
    'scripts/verify-stage-host.ts',
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--external:electron',
    '--external:better-sqlite3',
    `--outfile=${entry}`
  ],
  { stdio: 'inherit' }
)
if (build.status !== 0) {
  rmSync(out, { recursive: true, force: true })
  process.exit(build.status ?? 1)
}

// TIMED OUT deliberately. The failure this gate exists to catch is a dispatch
// that never settles, and a hung run reports as "still going" forever otherwise
// — which in CI is indistinguishable from a slow machine until someone looks.
const run = spawnSync('xvfb-run', ['-a', 'npx', 'electron', entry], {
  stdio: 'inherit',
  timeout: 120_000
})
rmSync(out, { recursive: true, force: true })
if (run.signal === 'SIGTERM') {
  console.error(
    '\nverify:stage-host TIMED OUT — a dispatch never settled, which is the ' +
      'exact failure mode this gate exists to catch.\n'
  )
  process.exit(1)
}
process.exit(run.status ?? 1)
