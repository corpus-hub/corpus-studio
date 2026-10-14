import { join } from 'node:path'
import { mkdirSync, existsSync } from 'node:fs'
import { userDataDir } from '../db/paths'
import { isPackaged, repoRootOrNull, PACKAGED_RESOURCE_DIR } from '../resources'

/**
 * The TWO roots plugins are discovered from, and why there are two rather than
 * one or three.
 *
 *   bundled  <repo>/plugins            (dev)
 *            <resources>/app-resources/plugins   (packaged)
 *   added    <userData>/plugins
 *
 * They are not the same directory because they have different owners. The
 * bundled root is part of the INSTALLATION: on a normal install it is
 * root-owned, a per-user process cannot write to it, and an app that rewrites
 * its own program directory is one that updaters and antivirus software both
 * have opinions about. The added root is per-user and writable, which is where
 * the Add button copies to and where a user dropping a folder in by hand is
 * told to put it.
 *
 * They are not THREE — there is no system-wide added root — because a plugin
 * installed for every user on a machine would be code one user can make another
 * user's session run, and nothing here is worth that.
 *
 * PRECEDENCE: an id present in both is a CONFLICT, not an override. Discovery
 * keeps the bundled one and reports the other as a problem the user can see and
 * remove, because silently shadowing an app-shipped plugin with a folder
 * someone dropped in is the substitution attack this layout would otherwise
 * invite. Installing over an existing id is refused at the install path for the
 * same reason.
 */

/** Where the Add button copies to, and where a dropped-in folder is found. */
export function userPluginsDir(): string {
  const env = process.env.CORPUS_PLUGINS_DIR
  if (env && env.trim()) return env
  return join(userDataDir(), 'plugins')
}

/**
 * The plugins that came with the application, or null when there are none.
 *
 * Null rather than a path that does not exist, so discovery has one shape for
 * "no bundled plugins" whether that is because the folder was deleted (the
 * detachability case: the app must still launch) or because this build shipped
 * without any.
 *
 * `CORPUS_BUNDLED_PLUGINS_DIR` overrides it — set to an empty string to assert
 * "none at all", which is how the detachability test runs the real launch path
 * with the folder absent rather than by deleting files from the checkout.
 */
export function bundledPluginsDir(): string | null {
  const env = process.env.CORPUS_BUNDLED_PLUGINS_DIR
  if (env !== undefined) return env.trim() ? env : null
  const dir = isPackaged()
    ? join(process.resourcesPath, PACKAGED_RESOURCE_DIR, 'plugins')
    : join(repoRootOrNull() ?? '', 'plugins')
  if (!repoRootOrNull() && !isPackaged()) return null
  return existsSync(dir) ? dir : null
}

/**
 * The added root, created if absent.
 *
 * Absent is the ORDINARY case — a fresh install has added no plugins — so
 * discovery treats a missing directory as "none" and never creates it. This is
 * called only on the install path, where one is about to be written.
 */
export function ensureUserPluginsDir(): string {
  const dir = userPluginsDir()
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Where a user-added plugin with this id lives.
 *
 * The id is `[a-z][a-z0-9-]*` by `manifestSchema`, so it can contain neither a
 * separator nor `..` and this join cannot escape the root. A caller holding an
 * id that has NOT been through that schema must not use this function.
 */
export function userPluginDir(id: string): string {
  return join(userPluginsDir(), id)
}

/**
 * Where a folder is assembled before it becomes a plugin.
 *
 * OUTSIDE the plugins root, and that placement is the whole point. Staging
 * inside it means a crash, a power loss or an ENOSPC mid-copy leaves a
 * half-written tree in the directory discovery scans — and discovery matches on
 * "contains a `plugin.json`", not on the folder's name, so a partial copy of a
 * stranger's folder would be found and `require`d at the next launch. A sibling
 * directory on the same filesystem keeps `rename` atomic while keeping the
 * incomplete tree somewhere nothing ever looks.
 */
export function pluginStagingDir(): string {
  return `${userPluginsDir()}-staging`
}

/**
 * A plugin's private directory for its own files.
 *
 * Beside the plugin trees rather than inside them, so uninstalling (which
 * deletes the plugin's folder) does not silently delete the user's data with
 * it, and so a plugin's data survives being removed and added back.
 */
export function pluginDataDir(id: string): string {
  return join(userDataDir(), 'plugin-data', id)
}
