// Build `verify-host.ts` and run it under REAL Electron.
//
// It cannot use the `ELECTRON_RUN_AS_NODE=1 electron --import tsx` pattern the
// other verifiers use, for the reason it is testing: `utilityProcess` exists
// only in Electron proper, and Electron proper does not accept node's
// `--import` flag (it treats the next argument as the app path). So the script
// is bundled first and the bundle is what Electron runs.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = mkdtempSync(join(tmpdir(), 'corpus-host-build-'))
const entry = join(out, 'verify-host.cjs')

const build = spawnSync(
  'npx',
  [
    'esbuild',
    'scripts/verify-host.ts',
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

const run = spawnSync('xvfb-run', ['-a', 'npx', 'electron', entry], { stdio: 'inherit' })
rmSync(out, { recursive: true, force: true })
process.exit(run.status ?? 1)
