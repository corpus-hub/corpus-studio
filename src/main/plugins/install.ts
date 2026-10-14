import {
  copyFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  existsSync,
  chmodSync,
  lstatSync,
  readdirSync
} from 'node:fs'
import { join, resolve, sep, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  LIMITS,
  ManifestError,
  entryPathWithin,
  looksLikePlugin,
  readManifest,
  walkPluginTree,
  type PluginManifest
} from './manifest'
import {
  bundledPluginsDir,
  ensureUserPluginsDir,
  pluginStagingDir,
  userPluginDir,
  userPluginsDir
} from './paths'

/**
 * Installing a plugin folder the user chose in a file picker.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT INSTALLING MEANS, AND WHAT IT DOES NOT.
 *
 * Installing a plugin is running a program. The entry module is `require`d into
 * the Electron main process with this application's full privileges: the whole
 * Node API, the network, the user's files, and the same database handle the app
 * uses — every paper, note and analysis in it. There is NO sandbox, and the
 * install dialog says so in those words rather than implying one.
 *
 * The checks below are therefore not a security review of the plugin. They are:
 *   (a) a guard on the INSTALL ITSELF, so that merely inspecting and copying an
 *       untrusted folder cannot be the exploit — nothing is written outside the
 *       destination, no symlink is followed, no special file is opened;
 *   (b) a bound, so a pathological or mis-chosen folder cannot fill the disk or
 *       spend forever being walked;
 *   (c) a mistake filter, so choosing the wrong folder fails with a sentence
 *       instead of half-installing something that breaks later.
 *
 * The order is: validate the manifest, walk and bound the tree, copy to a
 * TEMPORARY directory in the destination root, then rename into place. Nothing
 * partially copied is ever visible under the plugin's real name, because
 * discovery runs over that directory at every launch and a half-copied folder
 * that is discoverable is one the app will try to load.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface InstallOutcome {
  id: string
  name: string
  dir: string
}

/**
 * Validate `source` and copy it to `<userData>/plugins/<id>`.
 *
 * Throws `ManifestError` — whose message is a whole sentence written for the
 * user — for every refusal. Never throws a raw filesystem error at the caller.
 */
export function installPluginFolder(
  source: string,
  opts: { installedIds?: ReadonlySet<string> } = {}
): InstallOutcome {
  const src = resolve(source)

  // Refusing to install a folder that is ALREADY one of the plugin roots, or
  // inside one. Copying `<userData>/plugins` into `<userData>/plugins/<id>`
  // either recurses or silently duplicates a plugin under a second path, and
  // "install the folder you are already running from" is never what was meant.
  for (const root of [userPluginsDir(), bundledPluginsDir()]) {
    if (!root) continue
    const r = resolve(root)
    if (src === r) {
      throw new ManifestError(
        'is-root',
        'That is the folder plugins are kept in, not a plugin. Choose one of the folders inside it.'
      )
    }
    if (src.startsWith(r + sep)) {
      throw new ManifestError(
        'already-installed',
        'That plugin is already installed — it is in this app’s own plugins folder.'
      )
    }
  }

  const manifest = readManifest(src)

  // The entry is checked BEFORE anything is copied. A folder whose starting file
  // is missing is one that would install cleanly and then sit in the table
  // permanently broken, and the user would have no way to tell that from a bug.
  const entry = entryPathWithin(src, manifest.entry)
  if (!existsSync(entry)) {
    throw new ManifestError(
      'no-entry',
      `That folder’s ${'plugin.json'} points at a starting file (${manifest.entry}) that is not there, so the plugin is incomplete.`
    )
  }

  // ADDING over an existing id is still a REFUSAL, because Add is not Update.
  //
  // Overwriting from THIS path would make "install this folder" a way to replace
  // code the user already trusts and already enabled, when what they said was
  // "add a plugin". `updatePluginFolder` is the verb that replaces, it is reached
  // from the row of the plugin being replaced, and it refuses a folder whose id is
  // not that row's — so the id being overwritten is one the user pointed at rather
  // than one a manifest claimed.
  //
  // A BUNDLED id is no longer refused here. The app's own folder is not writable,
  // so a copy in the user root is the only form an updated bundled plugin can
  // take, and discovery now prefers it.
  const dest = userPluginDir(manifest.id)
  if (existsSync(dest) || opts.installedIds?.has(manifest.id)) {
    throw new ManifestError(
      'id-taken',
      `A plugin with the id “${manifest.id}” is already installed. Use Update on its row to replace it with this folder.`
    )
  }

  const staging = stagePluginTree(src)
  try {
    renameSync(staging, dest)
  } catch {
    discardStaging(staging)
    throw new ManifestError(
      'copy-failed',
      'That plugin could not be copied into this app’s folder. Check there is free space and that you can read every file in it.'
    )
  }

  return { id: manifest.id, name: manifest.name, dir: dest }
}

/**
 * Walk, bound and copy `src` into a fresh staging directory; return its path.
 *
 * SHARED BY INSTALL AND UPDATE, and shared rather than copied because every line
 * of it is a refusal — the symlink check, the hard-link check, the re-accumulated
 * byte total, the copy-time `lstat`. A second implementation of this for the
 * update path would be a second place for one of those to be dropped, and the
 * one that was dropped would be discovered by someone exploiting it.
 *
 * The caller owns the result: `rename` it into place, or `discardStaging` it.
 */
function stagePluginTree(src: string): string {
  // The walk is what enforces the symlink refusal, the file count, the total
  // size and the depth cap. It runs to completion BEFORE any copying starts, so
  // a folder that fails a bound leaves nothing behind at all.
  const tree = walkPluginTree(src)

  ensureUserPluginsDir()
  // A SIBLING of the plugins root, not a temp name inside it. `rename` is atomic
  // within a filesystem either way, but a staging directory inside the root is
  // one discovery walks: it matches on "contains a `plugin.json`", never on the
  // folder's name, so a copy interrupted by a crash or a full disk would be
  // found and `require`d at the next launch — a stranger's code, half written.
  const staging = join(pluginStagingDir(), randomBytes(8).toString('hex'))
  try {
    mkdirSync(staging, { recursive: true, mode: 0o700 })
    for (const rel of tree.dirs) {
      mkdirSync(join(staging, ...rel.split('/')), { recursive: true, mode: 0o700 })
    }
    // Re-accumulated over what is ACTUALLY WRITTEN, not carried over from the
    // walk. The walk and the copy are two passes over a directory another
    // process can change in between, so a bound computed in the first pass
    // bounds only what was measured — a file that grew afterwards is copied at
    // its new size and the disk-fill limit turns out to have been advisory.
    let copiedBytes = 0
    for (const rel of tree.files) {
      const from = join(src, ...rel.split('/'))
      const to = join(staging, ...rel.split('/'))
      // Re-checked at COPY TIME for the same reason. Swapping a plain file for
      // a symlink in that window is the classic time-of-check-to-time-of-use
      // race: `lstat` sees the link, and `copyFileSync` would have followed it.
      const st = lstatSync(from)
      if (!st.isFile() || st.nlink > 1) {
        throw new ManifestError(
          'changed-while-copying',
          'That folder changed while it was being copied, so nothing was installed. Try again.'
        )
      }
      copiedBytes += st.size
      if (st.size > LIMITS.fileBytes || copiedBytes > LIMITS.totalBytes) {
        throw new ManifestError(
          'changed-while-copying',
          'That folder grew while it was being copied, so nothing was installed. Try again.'
        )
      }
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 })
      copyFileSync(from, to)
      // The COPY's mode is set here rather than inherited: a source file that is
      // group- or world-writable would otherwise stay that way inside the app's
      // own directory, where anyone able to write it could change what the app
      // executes at next launch.
      chmodSync(to, 0o600)
    }
  } catch (err) {
    discardStaging(staging)
    if (err instanceof ManifestError) throw err
    throw new ManifestError(
      'copy-failed',
      'That plugin could not be copied into this app’s folder. Check there is free space and that you can read every file in it.'
    )
  }
  return staging
}

function discardStaging(staging: string): void {
  try {
    rmSync(staging, { recursive: true, force: true })
  } catch {
    // The staging directory is unreachable; the destination was never created,
    // which is the property that matters. A leftover staged tree is skipped by
    // discovery because it is not under a plugins root at all.
  }
}

/**
 * Replace the folder behind `id` with the contents of `source`.
 *
 * WHAT THIS IS ALLOWED TO ASSUME. The caller has already torn the plugin down —
 * `updatePlugin` in `host.ts` drains it before calling this — so nothing here
 * unloads code. This is the filesystem half only, and it is written so that
 * every outcome leaves a COMPLETE tree at the destination: the new one, or the
 * one that was there before.
 *
 * THE ID IS CHECKED AGAINST THE ROW, not merely against itself. Update is reached
 * from one plugin's row, so a folder declaring a different id is the wrong folder
 * — or a substitution wearing an update as a disguise — and neither is something
 * to guess about. The refusal names both ids, because the user's next question is
 * "which folder did I pick".
 *
 * A BUNDLED PLUGIN IS UPDATED THE SAME WAY: the new tree goes to the user root,
 * where discovery now prefers it. The bundled folder is not touched, because it
 * cannot be — it is inside the installation and often root-owned.
 */
export function updatePluginFolder(id: string, source: string): InstallOutcome {
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(id)) {
    throw new ManifestError('bad-id', 'That is not a plugin this app can update.')
  }
  const src = resolve(source)

  for (const root of [userPluginsDir(), bundledPluginsDir()]) {
    if (!root) continue
    const r = resolve(root)
    if (src === r) {
      throw new ManifestError(
        'is-root',
        'That is the folder plugins are kept in, not a plugin. Choose one of the folders inside it.'
      )
    }
    if (src.startsWith(r + sep)) {
      throw new ManifestError(
        'already-installed',
        'That folder is already one of this app’s plugins. Choose the folder you want to update it from.'
      )
    }
  }

  const manifest = readManifest(src)
  if (manifest.id !== id) {
    throw new ManifestError(
      'id-mismatch',
      `That folder holds “${manifest.id}”, not “${id}”. Choose the folder that holds the plugin you are updating, or add it as a new plugin instead.`
    )
  }

  const entry = entryPathWithin(src, manifest.entry)
  if (!existsSync(entry)) {
    throw new ManifestError(
      'no-entry',
      `That folder’s ${'plugin.json'} points at a starting file (${manifest.entry}) that is not there, so the plugin is incomplete.`
    )
  }

  const dest = userPluginDir(id)
  const staging = stagePluginTree(src)

  // THE OLD TREE IS MOVED ASIDE, NEVER DELETED FIRST.
  //
  // `rename` onto a non-empty directory fails, so the old one has to go — and
  // deleting it before the new one is in place is the window where a failure
  // leaves the user with no plugin at all, having asked to update a working one.
  // Moved aside, that failure is recoverable: the old tree goes back and the
  // caller re-enables it.
  const hadOld = existsSync(dest)
  const aside = hadOld ? join(pluginStagingDir(), `old-${randomBytes(8).toString('hex')}`) : null
  try {
    if (aside) renameSync(dest, aside)
  } catch {
    discardStaging(staging)
    throw new ManifestError(
      'update-failed',
      'That plugin’s current folder could not be moved, so nothing was changed. Close anything using it and try again.'
    )
  }
  try {
    renameSync(staging, dest)
  } catch {
    // Put it back exactly as it was. If THIS fails there is nothing further to
    // try, and the sentence says so rather than reporting a success.
    try {
      if (aside) renameSync(aside, dest)
    } catch {
      discardStaging(staging)
      throw new ManifestError(
        'update-broken',
        `“${id}” could not be updated and its previous folder could not be put back. Remove it and add it again.`
      )
    }
    discardStaging(staging)
    throw new ManifestError(
      'update-failed',
      'That plugin could not be updated, so it was left as it was. Check there is free space and that you can read every file in the folder you chose.'
    )
  }
  if (aside) discardStaging(aside)

  return { id: manifest.id, name: manifest.name, dir: dest }
}

/**
 * Delete an installed plugin's folder.
 *
 * ONLY under the user root, and the path is recomputed from the id rather than
 * taken from the caller — an "uninstall this directory" verb reachable over IPC
 * is a delete-arbitrary-directory verb with an extra step. A bundled plugin has
 * no path under that root and so cannot be reached by this at all, which is the
 * enforcement behind the table's non-removable rows rather than a UI rule.
 *
 * The plugin's DATA is left behind (`pluginDataDir`), so removing and adding a
 * plugin back does not silently destroy a credential or its bookkeeping.
 */
export function uninstallPlugin(id: string): void {
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(id)) {
    throw new ManifestError('bad-id', 'That is not a plugin this app installed.')
  }
  const dir = userPluginDir(id)
  const root = resolve(userPluginsDir())
  const target = resolve(dir)
  if (target === root || !target.startsWith(root + sep)) {
    throw new ManifestError('outside-root', 'That is not a plugin this app installed.')
  }
  if (!existsSync(target)) {
    throw new ManifestError('not-installed', 'That plugin is no longer installed.')
  }
  rmSync(target, { recursive: true, force: true })
}

/**
 * Delete anything left in the staging directory.
 *
 * Called once at startup. A staged tree only survives a crash or a power loss
 * mid-install, so it is never something the user chose to keep — and left alone
 * it accumulates a full copy of every install that was interrupted.
 *
 * Failure is IGNORED. This is housekeeping, and a permissions problem in a temp
 * directory is not a reason to refuse to start.
 */
export function sweepPluginStaging(): void {
  try {
    rmSync(pluginStagingDir(), { recursive: true, force: true })
  } catch {
    /* housekeeping only */
  }
}

/** Read a folder's manifest without installing, for the confirmation step. */
export function previewPluginFolder(source: string): PluginManifest {
  return readManifest(resolve(source))
}

/**
 * Copy every bundled plugin into the user root, once, so it survives the build
 * that stops shipping it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS, AND WHY IT CANNOT BE DONE LATER.
 *
 * Plugins are moving out of the installer: they will be distributed by a
 * repository, behind a key, instead of travelling inside a public artifact.
 * The moment a build ships without `app-resources/plugins/`, an install that
 * was relying on a bundled plugin loses it — and an UPDATE REPLACES THE
 * INSTALLATION DIRECTORY, so the build that drops the folder cannot copy
 * anything out of it. There is nothing left to copy from by the time it runs.
 *
 * So the adoption has to happen in the build BEFORE the one that stops
 * bundling, which is this one. Sequence:
 *   this release  — still bundles, and adopts on launch;
 *   next release  — drops the mapping, and every install that ran this keeps
 *                   its plugins as ordinary user plugins.
 *
 * IT IS DELIBERATELY NOT MARKED AS REPOSITORY-SUPPLIED. An adopted plugin is
 * the USER'S: removable, updatable from a folder, and not locked by a
 * repository the user has not connected. Connecting one later takes ownership
 * of the ids it offers by the ordinary path.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every outcome is a no-op or a complete tree, and NOTHING here can stop the
 * app launching: a failure leaves the bundled folder exactly where it was, and
 * this build still loads from it.
 *
 * Skipped, and each for a reason that is not an error:
 *   - the id already exists in the user root — the user's copy WINS, because
 *     discovery already prefers it and overwriting it would silently undo an
 *     update they made from a folder;
 *   - the id is one the user REMOVED — adopting it would resurrect a decision
 *     they made, which is the one thing the removal record exists to prevent.
 *
 * A FAILURE IS REPORTED, NEVER SWALLOWED. This is a rescue with a deadline: an
 * id that fails to adopt is one that DISAPPEARS at the next release, and a
 * silent `continue` is how that is discovered by the user losing a plugin
 * rather than by whoever could still fix it. It is exactly what happened in
 * development — a plugin folder carrying its own `server/node_modules` was 37.5
 * MB against the walk's 32 MB bound, so it was skipped without a word and only
 * turned up because the repository later reported one plugin fewer than
 * expected. The launch log names the id and the reason.
 *
 * Returns the ids adopted and the ones that could not be.
 */
export function adoptBundledPlugins(isRemoved: (id: string) => boolean): {
  adopted: string[]
  failed: { id: string; reason: string }[]
} {
  const adopted: string[] = []
  const failed: { id: string; reason: string }[] = []

  const bundled = bundledPluginsDir()
  if (!bundled) return { adopted, failed }

  let entries: string[]
  try {
    entries = readdirSync(bundled, { withFileTypes: true, encoding: 'utf8' })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch {
    return { adopted, failed }
  }

  for (const folder of entries) {
    const src = join(bundled, folder)
    if (!looksLikePlugin(src)) continue

    let manifest: PluginManifest
    try {
      manifest = readManifest(src)
    } catch {
      // A bundled folder that does not validate is already reported as broken
      // by discovery, with a sentence. Copying it would only move the problem.
      continue
    }

    if (isRemoved(manifest.id)) continue
    const dest = userPluginDir(manifest.id)
    if (existsSync(dest)) continue

    let staging: string
    try {
      staging = stagePluginTree(src)
    } catch (err) {
      failed.push({
        id: manifest.id,
        reason: err instanceof ManifestError ? err.message : 'its folder could not be copied'
      })
      continue
    }
    try {
      renameSync(staging, dest)
      adopted.push(manifest.id)
    } catch {
      discardStaging(staging)
      failed.push({ id: manifest.id, reason: 'its folder could not be moved into place' })
    }
  }
  return { adopted, failed }
}
