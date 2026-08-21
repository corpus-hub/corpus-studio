import type { DB } from '../db/connection'

/**
 * The API a plugin is LENT by the host.
 *
 * This interface is the whole of what a plugin may reach for by name. Anything
 * not here it must either bring itself or do without — which is what stops the
 * app's module graph from being a plugin's ambient API surface, and is the
 * difference between "a folder that can be loaded" and "a folder that only
 * works because it happens to sit inside this repository".
 *
 * IT IS NOT A SANDBOX, and calling it a capability set would be flattering it.
 * A plugin's entry module runs in the main process with the full Node API; it
 * can `require('node:fs')` and read anything this user can read. What this
 * interface buys is that the plugin does not have to reach around the host to
 * do its ordinary work, so a plugin that stays inside it is one whose blast
 * radius can be read off this file — and one that survives the app moving its
 * own internals around.
 */
export interface PluginServices {
  /**
   * A private directory for this plugin's own files, created on demand.
   *
   * Per-plugin rather than shared, so two plugins cannot collide on a filename
   * and one cannot read the other's config by guessing its name.
   */
  dataDir(): string

  /**
   * Move a file this plugin used to keep loose in the app's own data directory
   * into its private `dataDir()`, once.
   *
   * A plugin that was previously compiled into the app could write anywhere
   * under userData; one loaded from a folder gets `dataDir()` and nothing else.
   * Without this the move is a SILENT DATA LOSS — the plugin looks in its new
   * directory, finds nothing, and reports itself unconfigured while the user's
   * credential sits orphaned one level up. The user's only symptom is being
   * asked for a password they already gave.
   *
   * The plugin names the file because only the plugin knows what it wrote; the
   * host resolves both locations because only the host knows where they are.
   * A no-op when the old file is absent or the new one already exists, so it is
   * safe to call on every load.
   */
  adoptLegacyFile(fileName: string): void

  /**
   * Declare a value that must never appear in a log, an MCP response or an
   * exported bug report. The callback is polled, so a token that is replaced
   * stays redacted without re-registering.
   */
  registerSecret(label: string, read: () => string | null): void

  /**
   * Create a project row and return its id.
   *
   * Projects are core domain objects with invariants the app owns, so a plugin
   * that needs one asks rather than inserting — a plugin writing the row itself
   * would be a second place those invariants are implemented.
   */
  createProject(input: { name: string; description: string | null }): number

  /**
   * Report a trusted clock's offset from this machine's, in milliseconds.
   *
   * Last-write-wins across machines is decided by timestamps, so a peer whose
   * clock is wrong silently wins or loses every conflict. The host applies this
   * offset when it stamps `updated_at`.
   */
  setClockOffsetMs(ms: number): void

  /**
   * Borrow one of the runtime dependencies the app already ships.
   *
   * An ALLOWLIST, not a general `require`. A plugin loaded from userData cannot
   * resolve the app's `node_modules` on its own, and the alternatives are worse
   * in both directions: making the app's whole dependency tree reachable turns
   * every transitive package into plugin API, and making plugins vendor a
   * second copy of `better-sqlite3` would load a second native binding against
   * the same database file. Anything not on the list, a plugin bundles.
   */
  borrow(name: 'undici'): unknown

  /**
   * The app's own data directory — NOT this plugin's.
   *
   * Deliberately narrow in purpose and deliberately here rather than left to the
   * plugin to compute: a plugin that was previously compiled in wrote under
   * userData, and some of what it wrote is REGISTERED WITH SOMETHING OUTSIDE
   * this app. A browser's native-messaging manifest names an absolute path; a
   * plugin that quietly moved to `dataDir()` would leave every existing install
   * pointing at a file that is no longer there, and the symptom is a browser
   * extension that silently stops connecting.
   *
   * `adoptLegacyFile` covers the case where the plugin may simply move one file.
   * This covers the case where it may not move at all.
   */
  appDataDir(): string

  /**
   * Open a URL in the user's real browser.
   *
   * A plugin CAN reach the network itself; what it cannot reach is the user's
   * browser, which needs Electron. It is a service rather than something a
   * plugin shells out to because `shell.openExternal` refuses a URL that is not
   * http(s), and a plugin spawning `xdg-open` on a string would not.
   */
  openExternal(url: string): Promise<void>
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(cipher: Buffer): string
  getSelectedStorageBackend?(): string
}

export interface PluginCtx {
  /** ALWAYS the one shared connection. A second one would break deferred txns. */
  db: DB
  /** Present only after `app.whenReady()`. Plugins must not touch it earlier. */
  safeStorage: SafeStorageLike
  /** "Something changed, read again" — delivered to every window by the host. */
  notify: () => void
  /** Aborted when the plugin is disabled or the app is quitting. */
  signal: AbortSignal
  /** Everything the host lends. See `PluginServices`. */
  services: PluginServices
}
