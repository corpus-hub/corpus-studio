// electron-builder `afterPack` hook: drop the foreign-PLATFORM onnxruntime-node
// binaries from the packed app.
//
// onnxruntime-node ships `bin/napi-v3/<platform>/<arch>/` for every platform it
// supports. Any one installer needs exactly one of those directories; the rest
// is ~35 MB of dead weight, and on macOS a pile of foreign binaries for the
// notarizer to walk.
//
// WHY A HOOK AND NOT THE `files` ALLOWLIST. The allowlist can drop the foreign
// ARCHES, because `${arch}` is expanded per target. It cannot drop the foreign
// PLATFORMS:
//
//   - `${platform}` expands to `process.platform` — the HOST, not the target
//     (app-builder-lib/out/util/macroExpander.js). It is simply wrong whenever
//     a build cross-compiles, which is the entire point of the win/mac targets.
//   - Moving the rule into a per-platform `files:` block, the obvious fix, is
//     WORSE than wrong: `getFileMatchers` merges root and platform `files` into
//     one matcher, and a platform block containing only exclusions makes that
//     matcher `containsOnlyIgnore()`. electron-builder then discards `out/**`
//     and `package.json` and packs the ENTIRE working tree instead. That was
//     observed, not theorised — the build failed on a venv symlink in `tmp/`.
//
// So the prune happens after packing, against the app's own copy, where the
// target platform is known and `node_modules` is not at risk.

// It also puts the HOST's `better_sqlite3.node` back. `scripts/stage-native.cjs`
// overwrites it with the target's prebuild before packing, and by this point the
// packed app has its own copy — so leaving the foreign binary in `node_modules`
// only breaks the developer's checkout. It did: after a `dist:mac` every local
// `electron` invocation died on `invalid ELF header`.

const { rm, readdir, stat, copyFile } = require('node:fs/promises')
const { join } = require('node:path')
const { MODULE, ADDON_RELATIVE, BACKUP_RELATIVE } = require('./stage-native.cjs')

/** Directory sizes, for a log line that shows the saving is real. */
async function dirSize(dir) {
  let total = 0
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    total += (await stat(join(entry.parentPath ?? entry.path, entry.name))).size
  }
  return total
}

/**
 * Put the host's own `better_sqlite3.node` back into `node_modules`.
 *
 * Safe to call on a native build too, where no backup was ever made — the
 * absence of the backup file is exactly the signal that nothing was staged.
 */
async function restoreHostAddon(projectDir) {
  const moduleDir = join(projectDir, 'node_modules', MODULE)
  const backup = join(moduleDir, BACKUP_RELATIVE)
  try {
    await stat(backup)
  } catch {
    return false
  }
  await copyFile(backup, join(moduleDir, ADDON_RELATIVE))
  await rm(backup, { force: true })
  return true
}

exports.default = async function prunePackedForTarget(context) {
  const platform = context.electronPlatformName // 'linux' | 'win32' | 'darwin'
  const { appOutDir } = context

  if (await restoreHostAddon(context.packager.info.projectDir)) {
    console.log(`[prune-packed] restored this host's better_sqlite3.node in node_modules`)
  }

  // The app dir differs per platform; find the ORT tree wherever it landed
  // rather than hardcoding `resources/app.asar.unpacked/...` three ways.
  const roots = [
    join(appOutDir, 'resources', 'app.asar.unpacked'),
    join(appOutDir, 'resources', 'app'),
    // macOS keeps everything inside the bundle
    join(appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'app.asar.unpacked')
  ]

  let pruned = 0
  const removed = []

  for (const root of roots) {
    const ortBin = join(root, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3')
    let entries
    try {
      entries = await readdir(ortBin, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === platform) continue
      const victim = join(ortBin, entry.name)
      pruned += await dirSize(victim).catch(() => 0)
      await rm(victim, { recursive: true, force: true })
      removed.push(entry.name)
    }
  }

  if (removed.length > 0) {
    console.log(
      `[prune-packed] ${platform}: removed onnxruntime-node binaries for ` +
        `${removed.join(', ')} — ${(pruned / 1024 / 1024).toFixed(0)} MB`
    )
  }

  // STRICTLY LAST, and the reason these two steps share one hook: a code
  // signature covers the bundle's contents, so deleting files from a signed
  // bundle invalidates it. Signing has to happen after the prune, and
  // electron-builder allows only ONE afterPack.
  await require('./adhoc-sign-mac.cjs').default(context)
}
