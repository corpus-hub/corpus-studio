import type { PluginParamDTO, PluginStatusDTO } from '@shared/contract/plugins'
import type { PluginCtx, PluginServices, SafeStorageLike } from './services'
import type { PluginManifest } from './manifest'

/**
 * What a plugin is, from the host's point of view.
 *
 * IMPORTS NO ELECTRON, matching `src/main/ipc/types.ts`, so the host and every
 * plugin that implements this can be loaded and exercised outside an Electron
 * main process. Anything a plugin needs from Electron arrives through
 * `PluginCtx` rather than being imported.
 *
 * The host owns the TIMER. A plugin exposes `tick`; it does not schedule itself.
 * Two plugins each running their own interval is two places re-entrancy can be
 * got wrong, and the one already-shipped bug class here is overlapping ticks.
 *
 * DESCRIPTION IS NOT BEHAVIOUR. Name, blurb, disclosure and parameters come
 * from `plugin.json` (`PluginManifest`), never from this object: the installer
 * must render a plugin's identity and configuration form BEFORE deciding
 * whether to load its code, and a plugin that could describe itself only by
 * running is one that gets to run before it is trusted.
 */

export type { PluginCtx, PluginServices, SafeStorageLike }

export type PluginParam = PluginParamDTO

/** What a plugin returns from `configure`: which values it refused, and why. */
export interface ConfigureOutcome {
  rejected: Record<string, string>
}

export interface CorpusPlugin {
  /** MUST equal the manifest's id. The loader refuses the pair if they differ. */
  id: string
  /**
   * Why this cannot be enabled right now, in the user's words. Non-empty means
   * the toggle is disabled with the first entry as its `data-tip`.
   */
  blockers(ctx: PluginCtx): string[]
  /** True whether or not the plugin is on. Exceptions only — an empty array is normal. */
  warnings(ctx: PluginCtx): string[]
  /** Non-secret values for the UI, keyed by param key. */
  values(ctx: PluginCtx): Record<string, string | number | boolean | null>
  /** Whether each `secret` param has a value stored. NEVER the value. */
  secretsSet(ctx: PluginCtx): Record<string, boolean>

  onEnable(ctx: PluginCtx): Promise<void>
  /** Must await or abort any in-flight work before returning. */
  onDisable(ctx: PluginCtx): Promise<void>
  configure(
    ctx: PluginCtx,
    values: Record<string, string | number | boolean>
  ): Promise<ConfigureOutcome>
  testConnection(ctx: PluginCtx): Promise<{ ok: boolean; sentence: string; code: string | null }>

  /** One cycle of whatever this plugin does. The HOST calls it; never a self-timer. */
  tick?(ctx: PluginCtx): Promise<void>
  /**
   * How often the host should call `tick`, or `null`/`0` for never. Read at
   * every enable, and the host re-enables after every `configure`.
   *
   * A FUNCTION when the answer depends on the user's configuration. A plugin the
   * user has told to work only when asked must have NO TIMER at all, not a timer
   * whose handler returns immediately: the latter still wakes the process on
   * every interval for the life of the app, which is not what a setting reading
   * "only when I ask" promises.
   */
  tickIntervalMs?: number | ((ctx: PluginCtx) => number | null)

  status(ctx: PluginCtx): PluginStatusDTO
}

/**
 * The one export a plugin's entry module must have.
 *
 * A FUNCTION rather than the object itself, so the host hands over its services
 * before any of the plugin's code can look for them — with a bare object export
 * there is a window in which the module is evaluated but nothing is injected,
 * and the top-level statement that reads a path during that window fails in a
 * way that has nothing to do with paths.
 */
export type PluginActivate = (services: PluginServices) => CorpusPlugin

/** A plugin as the host holds it: where it came from, what it says, what it does. */
export interface LoadedPlugin {
  manifest: PluginManifest
  plugin: CorpusPlugin
  /** The folder it was loaded from — shown in the UI so "which one is this?" has an answer. */
  dir: string
  /** `bundled` came with the app and cannot be removed; `added` the user installed. */
  origin: 'bundled' | 'added'
}
