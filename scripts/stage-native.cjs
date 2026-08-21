// electron-builder `beforePack` hook: put the TARGET's `better_sqlite3.node`
// in place before the app is packed.
//
// WHY THIS EXISTS. `buildDependenciesFromSource: true` makes electron-builder
// SKIP the native rebuild whenever the target platform differs from the host
// ("platform is different and buildDependenciesFromSource is set to true",
// app-builder-lib/out/packager.js). Nothing then replaces the binary, so a
// Windows or macOS build produced on this Linux host would pack the HOST's
// ELF `better_sqlite3.node` and die on `require` the first time a user opened
// a corpus — an installer that looks fine and cannot open a database.
//
// Compiling for a foreign platform is not possible here, so the binary comes
// from upstream's published prebuilds, matched to Electron's ABI. This is the
// same artifact `prebuild-install` would fetch; it is fetched explicitly so the
// build FAILS LOUDLY when one is missing rather than shipping the wrong file.
//
// BUILD TIME ONLY, like the payloads: nothing here runs in the app, and the
// downloaded binary is a build input, not something the app ever fetches.
//
// On a NATIVE build (target === host) this hook does nothing at all —
// electron-builder's own @electron/rebuild has already compiled the module
// against Electron's ABI, and that locally compiled binary is the better one.

const { createWriteStream } = require('node:fs')
const { mkdir, rm, readdir, copyFile, stat } = require('node:fs/promises')
const { createHash } = require('node:crypto')
const { join } = require('node:path')
const { pipeline } = require('node:stream/promises')
const { createGunzip } = require('node:zlib')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const execFileAsync = promisify(execFile)

const MODULE = 'better-sqlite3'

/** Where the packed app expects the addon to be. */
const ADDON_RELATIVE = join('build', 'Release', 'better_sqlite3.node')

/**
 * The host's own addon, moved aside before a foreign one is staged over it.
 *
 * This backup is why the hook is safe to run in a working tree someone is also
 * developing in. Staging leaves the WRONG binary in `node_modules`, and nothing
 * in electron-builder puts it back: after a `dist:mac` the tree was left with an
 * arm64 Mach-O addon and every local `electron`/`npm run seed`/verify script
 * died on `invalid ELF header` — a broken checkout as the lasting side effect of
 * a successful build. `scripts/prune-packed.cjs` restores it in `afterPack`.
 */
const BACKUP_RELATIVE = join('build', 'Release', 'better_sqlite3.node.host-backup')

/**
 * Electron's ABI, read from `node-abi` rather than hardcoded: it is a property
 * of the Electron version in package.json, and a hardcoded number silently goes
 * stale on the next Electron bump — producing a prebuild that loads on nobody's
 * machine.
 */
function electronAbi(electronVersion) {
  const { getAbi } = require('node-abi')
  return getAbi(electronVersion, 'electron')
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) {
    throw new Error(`[stage-native] GET ${url} → HTTP ${res.status} ${res.statusText}`)
  }
  await pipeline(res.body, createWriteStream(dest))
}

async function sha256(file) {
  const { readFile } = require('node:fs/promises')
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

exports.default = async function stageNativeForTarget(context) {
  const platform = context.electronPlatformName // 'linux' | 'win32' | 'darwin'
  const { Arch } = require('electron-builder')
  const arch = Arch[context.arch] // 'x64' | 'arm64' | ...

  if (platform === process.platform && arch === process.arch) {
    console.log(
      `[stage-native] ${platform}-${arch} is the host — keeping the locally ` +
        'compiled better_sqlite3.node (@electron/rebuild already matched Electron\'s ABI).'
    )
    return
  }

  const projectDir = context.packager.info.projectDir
  const moduleDir = join(projectDir, 'node_modules', MODULE)
  const version = require(join(moduleDir, 'package.json')).version
  const electronVersion = context.packager.info.framework.version
  const abi = electronAbi(electronVersion)

  const name = `${MODULE}-v${version}-electron-v${abi}-${platform}-${arch}.tar.gz`
  const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${version}/${name}`

  const cacheDir = join(projectDir, 'node_modules', '.cache', 'stage-native')
  await mkdir(cacheDir, { recursive: true })
  const archive = join(cacheDir, name)

  let cached = true
  try {
    await stat(archive)
  } catch {
    cached = false
  }

  if (!cached) {
    console.log(`[stage-native] fetching ${name}`)
    await download(url, archive)
  }

  // Unpacked into a scratch dir and then copied, rather than extracted over
  // node_modules: the tarball's own layout is `build/Release/…`, and letting it
  // land directly would also overwrite whatever else upstream chose to ship.
  const scratch = join(cacheDir, `${platform}-${arch}`)
  await rm(scratch, { recursive: true, force: true })
  await mkdir(scratch, { recursive: true })
  await execFileAsync('tar', ['-xzf', archive, '-C', scratch])

  const extracted = join(scratch, ADDON_RELATIVE)
  await stat(extracted).catch(() => {
    throw new Error(
      `[stage-native] ${name} does not contain ${ADDON_RELATIVE} — upstream changed ` +
        'the prebuild layout; this hook must be updated rather than worked around.'
    )
  })

  const target = join(moduleDir, ADDON_RELATIVE)
  const backup = join(moduleDir, BACKUP_RELATIVE)
  await mkdir(join(moduleDir, 'build', 'Release'), { recursive: true })

  // Preserve the host's addon before overwriting it. `copyFile` rather than
  // rename, and only if no backup exists yet: two cross-target packs in one run
  // (mac x64 then arm64) must not let the second overwrite the backup with the
  // FIRST target's foreign binary.
  const hasBackup = await stat(backup).then(
    () => true,
    () => false
  )
  if (!hasBackup) {
    await copyFile(target, backup).catch(() => {
      // No host addon to preserve (a clean checkout that was never rebuilt).
      // Nothing to restore later either, so this is not an error.
    })
  }

  await copyFile(extracted, target)

  console.log(
    `[stage-native] ${platform}-${arch}: staged better_sqlite3.node from ` +
      `${name} (electron ${electronVersion}, ABI ${abi}, sha256 ${(await sha256(target)).slice(0, 16)}…)`
  )
}

exports.ADDON_RELATIVE = ADDON_RELATIVE
exports.BACKUP_RELATIVE = BACKUP_RELATIVE
exports.MODULE = MODULE
