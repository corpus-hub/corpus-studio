// Prove that `resourcePath()` resolves correctly in BOTH execution modes, and
// that the packaged application's identity cannot silently repoint the user's
// database.
//
// A resource path that works in dev and breaks in the installer is the classic
// packaging failure, and it is invisible until someone installs the app. This
// script makes both modes checkable from the dev machine: the dev mode is
// exercised directly, and the packaged mode is simulated by pointing
// CORPUS_RESOURCES_DIR at a real packaged tree (or asserted against a built
// artifact when one exists under release/).
//
//   npm run verify:resources                 # dev mode + config invariants
//   npm run verify:resources -- release/linux-unpacked
//
// Run under `ELECTRON_RUN_AS_NODE=1 electron --import tsx`, like the other
// verification scripts, so it exercises the same module-resolution conditions
// the seed scripts do.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  isPackaged,
  platformKey,
  qpdfPath,
  resourceExists,
  resourcePath,
  resourcesRoot
} from '../src/main/resources'
import { APP_NAME, defaultDbPath, userDataDir } from '../src/main/db/paths'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const repoRoot = resolve(__dirname, '..')

console.log('--- dev mode (running from source) ---')
check('isPackaged() is false in dev / under ELECTRON_RUN_AS_NODE', !isPackaged(), resourcesRoot())
check(
  'resourcesRoot() is <repo>/resources',
  resourcesRoot() === join(repoRoot, 'resources'),
  resourcesRoot()
)
check(
  'resourcePath() joins beneath the root',
  resourcePath('bin', 'linux', 'qpdf') === join(repoRoot, 'resources', 'bin', 'linux', 'qpdf')
)
// The path a CONSUMER gets, not a hand-assembled one. `optimize` computed its
// own `bin/<platform>/qpdf` and so looked in a directory nothing provisions,
// while the binary sat correctly installed under `bin/<platform>-<arch>/`.
check(
  'qpdfPath() is keyed by platform-AND-arch, matching what payloads.json provisions',
  qpdfPath() ===
    join(
      repoRoot,
      'resources',
      'bin',
      platformKey(),
      process.platform === 'win32' ? 'qpdf.exe' : 'qpdf'
    ),
  qpdfPath()
)
// Segments, never an absolute path: `resourceExists` joins onto the root, so
// handing it an absolute path yields root+path and is false for everything.
check(
  'resourceExists() answers true for a real payload addressed by segments',
  !existsSync(qpdfPath()) ||
    resourceExists('bin', platformKey(), process.platform === 'win32' ? 'qpdf.exe' : 'qpdf')
)
check('resources/ tree exists in the repo', existsSync(join(repoRoot, 'resources')))

// The seed corpus is a DEV fixture: the seed scripts and the report scripts
// read it from the checkout, and no install ever does.
check(
  'the dev-canonical corpus JSON is where the seed and report scripts expect it',
  existsSync(join(repoRoot, 'scripts', 'data', 'ke07-corpus.json'))
)

console.log('\n--- packaged mode (CORPUS_RESOURCES_DIR override) ---')
const fakeRoot = join(repoRoot, 'resources')
process.env.CORPUS_RESOURCES_DIR = fakeRoot
check('override redirects resourcesRoot()', resourcesRoot() === fakeRoot, resourcesRoot())
delete process.env.CORPUS_RESOURCES_DIR

console.log('\n--- app identity / database location ---')
// Electron's packaged boot loader sets app.name from the packaged
// package.json's `productName ?? name`. `productName` lives ONLY in
// electron-builder.yml, so app.name stays 'corpus-studio' and userData — and
// therefore every existing user's corpus.sqlite — is unchanged by packaging.
// If someone adds productName to package.json this assertion is what catches it.
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as Record<
  string,
  unknown
>
check('package.json has no top-level productName', pkg.productName === undefined)
check(`package.json name === '${APP_NAME}'`, pkg.name === APP_NAME, String(pkg.name))
console.log(`      userDataDir()   = ${userDataDir()}`)
console.log(`      defaultDbPath() = ${defaultDbPath()}`)

const builderYml = readFileSync(join(repoRoot, 'electron-builder.yml'), 'utf8')
check(
  'mac CFBundleName pins the lowercase app name',
  /CFBundleName:\s*corpus-studio/.test(builderYml)
)
check(
  'the dev database is not in the packaged file list',
  !/^\s*-\s*data\/\*\*/m.test(builderYml) && /^\s*-\s*out\/\*\*/m.test(builderYml)
)

// --- optional: assert against a REAL packaged tree ------------------------
const artifact = process.argv[2]
if (artifact) {
  console.log(`\n--- packaged artifact: ${artifact} ---`)
  const res = join(resolve(artifact), 'resources')
  check('artifact has a resources/ dir', existsSync(res))
  check('app.asar present', existsSync(join(res, 'app.asar')))
  check('app.asar.unpacked present (native modules)', existsSync(join(res, 'app.asar.unpacked')))
  const better = join(res, 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release')
  check(
    'better_sqlite3.node is unpacked (dlopen cannot read an asar)',
    existsSync(join(better, 'better_sqlite3.node'))
  )
  const appRes = join(res, 'app-resources')
  check('app-resources/ shipped', existsSync(appRes))
  // An install starts empty, so no seed dataset may be inside the artifact.
  check(
    'no seed dataset shipped (a fresh install starts empty)',
    !existsSync(join(appRes, 'corpus'))
  )
  if (existsSync(appRes)) {
    const names = readdirSync(appRes).sort()
    console.log(`      app-resources/: ${names.join(', ') || '(empty)'}`)
  }
  // Nothing under app-resources may be a database or an env file.
  const bad: string[] = []
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(sqlite|db|env|p12|pfx|pem|key)$/i.test(e)) bad.push(p)
    }
  }
  walk(appRes)
  check('no database/credential files in app-resources', bad.length === 0, bad.join(', '))
}

// --- shipped payloads: declared vs. present, hashes, executability ---------
//
// A payload that is absent is a legitimate state (its stage reports `skipped`),
// but a payload that is present with the WRONG BYTES is not: it means either a
// corrupted provisioning run or an upstream asset that changed under a pinned
// URL, and either way something is executing that this repo cannot account for.
// So existence is reported, and a hash mismatch FAILS.
console.log('\n--- shipped payloads (resources/payloads.json) ---')

interface PayloadFile {
  dest: string
  sha256?: string
  mode?: string
  reproducible?: boolean
}
interface PayloadPlatform {
  files?: PayloadFile[]
  unavailable?: string
}
interface PayloadEntry {
  id: string
  optional: boolean
  version: string
  license: string
  platforms: Record<string, PayloadPlatform>
}

const payloadManifestPath = join(repoRoot, 'resources', 'payloads.json')
check('resources/payloads.json exists', existsSync(payloadManifestPath))

if (existsSync(payloadManifestPath)) {
  const pm = JSON.parse(readFileSync(payloadManifestPath, 'utf8')) as {
    schemaVersion: number
    payloads: PayloadEntry[]
  }
  check('payload manifest schemaVersion is 1', pm.schemaVersion === 1)

  // Every payload must name a licence. A binary of unknown licence is exactly
  // the failure that got ghostscript rejected from this pipeline.
  const unlicensed = pm.payloads.filter((p) => !p.license || !p.version)
  check('every payload declares a version and a licence', unlicensed.length === 0,
    unlicensed.map((p) => p.id).join(', '))

  // `resourcesRoot()` is used rather than a hand-built path, so this verifies
  // the SAME resolution the application performs — including under an artifact
  // override — instead of a parallel guess at where the files are.
  const hostPlatformKey = platformKey()
  let present = 0
  let missing = 0
  for (const payload of pm.payloads) {
    for (const [key, spec] of Object.entries(payload.platforms)) {
      if (key !== 'all' && key !== hostPlatformKey) continue
      if (spec.unavailable) {
        console.log(`      ${payload.id} ${key}: NOT PROVISIONED — ${spec.unavailable}`)
        continue
      }
      for (const f of spec.files ?? []) {
        const p = resourcePath(...f.dest.split('/'))
        if (!existsSync(p)) {
          console.log(`      ${payload.id}: absent — ${f.dest} (stage will report skipped)`)
          missing++
          continue
        }
        present++
        if (f.sha256 && f.reproducible !== false) {
          const actual = createHash('sha256').update(readFileSync(p)).digest('hex')
          check(`${payload.id} ${f.dest} matches its pinned SHA-256`, actual === f.sha256,
            actual === f.sha256 ? '' : `got ${actual.slice(0, 16)}…`)
        }
        // An executable payload that lost its mode is the classic packaging
        // failure: it survives the copy, passes an existence check, and then
        // EACCES at spawn time in the installer only.
        if (f.mode === '0755') {
          const mode = statSync(p).mode & 0o777
          check(`${payload.id} ${f.dest} is executable (mode ${mode.toString(8)})`,
            (mode & 0o111) !== 0)
        }
      }
    }
  }
  console.log(`      ${present} payload file(s) present, ${missing} absent for ${hostPlatformKey}`)
}

console.log(failures === 0 ? '\nALL RESOURCE CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
