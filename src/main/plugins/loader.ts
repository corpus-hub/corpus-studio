import { readdirSync, lstatSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import type { CorpusPlugin, LoadedPlugin, PluginActivate } from './types'
import type { PluginServices } from './services'
import {
  ManifestError,
  entryPathWithin,
  looksLikePlugin,
  readManifest,
  type PluginManifest
} from './manifest'
import { bundledPluginsDir, userPluginsDir } from './paths'

/**
 * Discovery and loading: turning folders on disk into `LoadedPlugin`s.
 *
 * THE ORDER MATTERS AND IS THE POINT. For each candidate folder:
 *   1. read and validate `plugin.json`  — no code has run;
 *   2. resolve `entry` inside the folder — still no code has run;
 *   3. `require` the entry and call its default export.
 * Steps 1 and 2 are what make step 3 a decision rather than an accident. A
 * loader that required first and validated after would have executed every
 * folder in the directory in order to find out which ones it should not have.
 *
 * Step 3 is nonetheless FULL TRUST — see the boundary statement in
 * `manifest.ts`. Nothing here sandboxes the module; the validation before it
 * bounds mistakes, not adversaries who have already got a folder installed.
 */

/** A folder that could not be loaded, kept so the UI can SAY so. */
export interface BrokenPlugin {
  dir: string
  origin: 'bundled' | 'added'
  /** The folder's own name — the only identity a broken plugin has. */
  folder: string
  /** The manifest id, when the manifest at least parsed. */
  id: string | null
  /** A whole sentence, written for a user. Never an exception message. */
  reason: string
  code: string
}

export interface DiscoveryResult {
  loaded: LoadedPlugin[]
  broken: BrokenPlugin[]
  /**
   * Ids whose folder is on disk but which discovery skipped because the user
   * removed them.
   *
   * Reported so the pane can offer Restore only for a plugin that is actually
   * there. A tombstone whose folder is gone — an added plugin deleted by hand, a
   * bundled one dropped by a later release — must not render a button that would
   * clear the record and produce nothing.
   */
  removedPresent: string[]
}

/**
 * Every plugin folder name under both roots, whether or not it loads.
 *
 * By NAME, because that is all a tombstoned folder is allowed to cost: the whole
 * point of a removal is that the folder is never read again, so asking whether
 * one is present must not open its manifest. Discovery already requires the
 * folder name to equal the manifest id, which is what makes a name a usable
 * identity here.
 */
export function pluginFolderNames(): Set<string> {
  const out = new Set<string>()
  for (const root of [bundledPluginsDir(), userPluginsDir()]) {
    if (!root) continue
    for (const dir of candidateFolders(root)) out.add(dir.slice(root.length + 1))
  }
  return out
}

/**
 * Every plugin folder under both roots.
 *
 * A MISSING ROOT IS NOT AN ERROR. The bundled root is absent when `plugins/`
 * has been deleted — the detachability case, which must launch normally — and
 * the added root is absent on every fresh install. Both return nothing and the
 * app carries on with no plugins at all.
 */
export function discoverPlugins(
  services: (id: string) => PluginServices,
  /**
   * Ids the host already holds a live instance of.
   *
   * ACTIVATION IS NOT IDEMPOTENT. `activate` registers secrets, creates
   * directories and may hold a client; running it again on every install or
   * removal would produce a second instance whose side effects have already
   * happened by the time the host discards it as a duplicate. These folders are
   * skipped before their code runs, not after.
   */
  alreadyLoaded: ReadonlySet<string> = new Set(),
  /**
   * Ids the user has REMOVED, which are skipped before their manifest is read
   * and therefore before any of their code runs.
   *
   * A PREDICATE on the folder name rather than a set of loaded ids, and that is
   * the whole of why the skip is trustworthy: discovery requires the folder name
   * to equal the manifest id (below), so the removal can be honoured without
   * opening the folder at all. Consulting the manifest first would let a removed
   * plugin escape its own tombstone by editing the id it claims.
   */
  isRemoved: (id: string) => boolean = () => false
): DiscoveryResult {
  const loaded: LoadedPlugin[] = []
  const broken: BrokenPlugin[] = []
  const removedPresent: string[] = []
  /**
   * Which folder owns each id so far — including ids the host already holds,
   * which is why this is a directory and not a `LoadedPlugin`. A second folder
   * declaring a live id must still be reported as a duplicate rather than
   * quietly sitting beside the running instance.
   */
  const seen = new Map<string, string>()

  // ADDED FIRST, and the order is the whole rule: the user's own copy of an id
  // WINS over the one the application ships.
  //
  // It was bundled-first, and a same-id folder in the user root was reported as a
  // `duplicate-id` conflict, so that nothing dropped in could shadow a shipped
  // plugin. That made a bundled plugin a privileged class — the one thing in the
  // app a user could not replace — and it is what Update exists to end: a bundled
  // folder cannot be written to (it is inside the installation, often root-owned,
  // and replaced wholesale by an upgrade), so updating one can only mean writing
  // the new tree to the user root and having it win.
  //
  // THE COST IS REAL AND IS NOT ANNOUNCED: a folder that reaches
  // `<userData>/plugins` by any means now overrides a shipped plugin of the same
  // id, and goes on overriding it when a later release ships a newer one. Remove
  // deletes the user-root copy and the shipped one loads again, so it is
  // undoable; nothing marks it while it is in force.
  const roots: [string | null, 'bundled' | 'added'][] = [
    [userPluginsDir(), 'added'],
    [bundledPluginsDir(), 'bundled']
  ]

  for (const [root, origin] of roots) {
    if (!root) continue
    for (const dir of candidateFolders(root)) {
      const folder = dir.slice(root.length + 1)
      if (isRemoved(folder)) {
        removedPresent.push(folder)
        continue
      }
      let manifest: PluginManifest
      try {
        manifest = readManifest(dir)
      } catch (err) {
        // A folder with no manifest at all is SKIPPED SILENTLY rather than
        // reported: `plugins/` legitimately holds a README, a shared tsconfig
        // and whatever a developer left there, and a permanent red row for each
        // is a warning nobody can clear. Anything that HAS a manifest and still
        // failed is a real problem and is reported.
        if (err instanceof ManifestError && err.code === 'no-manifest') continue
        broken.push({
          dir,
          origin,
          folder,
          id: null,
          reason: err instanceof ManifestError ? err.message : 'That folder could not be read as a plugin.',
          code: err instanceof ManifestError ? err.code : 'unreadable'
        })
        continue
      }

      if (folder !== manifest.id) {
        // The FOLDER NAME must be the id. Discovery otherwise identifies a
        // plugin only by what its manifest claims, so any directory anywhere
        // under the root is a candidate — which is what would make an
        // interrupted copy, or a folder a user renamed to park it, load anyway.
        broken.push({
          dir,
          origin,
          folder,
          id: manifest.id,
          reason: `That folder is named “${folder}” but the plugin inside it is “${manifest.id}”. Rename the folder to match, or remove it.`,
          code: 'name-mismatch'
        })
        continue
      }

      // FIRST WINS, and with the user root first that means the second copy is
      // the shipped one being overridden. Skipped SILENTLY, not reported: it is
      // no longer a conflict but the ordinary outcome of updating a plugin the
      // app shipped, and a permanent red row describing the app's own folder is
      // a warning about a thing the user did on purpose and cannot clear.
      //
      // The folder name must equal the id, so two folders sharing one id are
      // necessarily in different roots — there is no same-root case here.
      if (seen.has(manifest.id)) continue

      if (alreadyLoaded.has(manifest.id)) {
        seen.set(manifest.id, dir)
        continue
      }

      let plugin: CorpusPlugin
      try {
        plugin = activate(manifest, dir, services(manifest.id))
      } catch (err) {
        broken.push({
          dir,
          origin,
          folder,
          id: manifest.id,
          // The thrown value is NOT shown. It is a third party's exception and
          // may carry an absolute path, a URL or a credential; it is also, at
          // this point, a stack trace, which is not something a user acts on.
          reason:
            err instanceof ManifestError
              ? err.message
              : 'That plugin failed to start. It may have been built for a different version of this app.',
          code: err instanceof ManifestError ? err.code : 'activate-failed'
        })
        continue
      }

      seen.set(manifest.id, dir)
      loaded.push({ manifest, plugin, dir, origin })
    }
  }

  return { loaded, broken, removedPresent }
}

/** Immediate subdirectories of `root` that hold a `plugin.json`. */
function candidateFolders(root: string): string[] {
  let entries: Dirent<string>[]
  try {
    entries = readdirSync(root, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    // Absent or unreadable. Absent is the ordinary case on a fresh install and
    // the whole detachability case, so it cannot be a failure.
    return []
  }
  const out: string[] = []
  for (const ent of entries) {
    // A symlinked plugin FOLDER is refused here as it is in the installer: a
    // link in the plugins directory is code loaded from somewhere the user
    // cannot see when they look at what is installed.
    if (!ent.isDirectory()) continue
    const dir = join(root, ent.name)
    if (looksLikePlugin(dir)) out.push(dir)
  }
  return out.sort()
}

/**
 * Load the entry module and call its default export.
 *
 * `require`, not `import()`: the host's lifecycle is synchronous from the
 * caller's point of view, and this whole path runs once at startup where an
 * await buys nothing. The built main bundle is CJS, so `require` is what
 * actually exists at runtime.
 */
function activate(manifest: PluginManifest, dir: string, services: PluginServices): CorpusPlugin {
  const entry = entryPathWithin(dir, manifest.entry)
  try {
    lstatSync(entry)
  } catch {
    throw new ManifestError(
      'no-entry',
      `That plugin’s starting file (${manifest.entry}) is missing from its folder, so it may have been copied incompletely.`
    )
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(entry) as { default?: unknown } | undefined
  const fn = (mod && typeof mod === 'object' ? mod.default : undefined) as PluginActivate | undefined
  if (typeof fn !== 'function') {
    throw new ManifestError(
      'no-activate',
      'That plugin’s starting file does not export a plugin, so there is nothing to run.'
    )
  }

  const plugin = fn(services)
  assertShape(plugin)
  if (plugin.id !== manifest.id) {
    // The manifest is what the user was shown and what the folder is named
    // after; a module claiming a different id would be enabled under one name
    // and configured under another.
    throw new ManifestError(
      'id-mismatch',
      `That plugin’s code calls itself “${plugin.id}” while its ${'plugin.json'} says “${manifest.id}”. It was not started.`
    )
  }
  return plugin
}

/**
 * Every method the host will later call, checked ONCE at load.
 *
 * Without this the first missing method is a `TypeError` from inside the tick
 * scheduler, hours later, attributed to the host. Failing at load names the
 * plugin and leaves it visibly broken in the table instead.
 */
const REQUIRED_METHODS = [
  'blockers',
  'warnings',
  'values',
  'secretsSet',
  'onEnable',
  'onDisable',
  'configure',
  'testConnection',
  'status'
] as const

function assertShape(plugin: unknown): asserts plugin is CorpusPlugin {
  if (!plugin || typeof plugin !== 'object') {
    throw new ManifestError('bad-shape', 'That plugin’s starting file did not return a plugin.')
  }
  const p = plugin as Record<string, unknown>
  if (typeof p.id !== 'string') {
    throw new ManifestError('bad-shape', 'That plugin did not say what it is called, so it was not started.')
  }
  for (const m of REQUIRED_METHODS) {
    if (typeof p[m] !== 'function') {
      throw new ManifestError(
        'bad-shape',
        `That plugin is missing something this app needs from it (${m}), so it was not started.`
      )
    }
  }
  if (p.tick !== undefined && typeof p.tick !== 'function') {
    throw new ManifestError('bad-shape', 'That plugin declared repeating work but did not supply any.')
  }
}
