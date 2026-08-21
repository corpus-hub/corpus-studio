import { mkdirSync, existsSync, renameSync, copyFileSync, chmodSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { userDataDir } from '../db/paths'
import { getDb, setRelayClockOffsetMs } from '../db/connection'
import { getSetting, setSetting, createProjectRow } from '../db/repositories'
import { registerSecret } from '../mcp/redact'
import type { CorpusPlugin, LoadedPlugin } from './types'
import type { PluginCtx, PluginServices, SafeStorageLike } from './services'
import {
  SHARING_OFF_SENTENCE,
  type PluginDTO,
  type PluginListDTO,
  type PluginCapability,
  type PluginConfigureResultDTO,
  type PluginRunState,
  type PluginSetupActionDTO,
  type PluginStatusDTO,
  type PluginTestResultDTO
} from '../../shared/contract/plugins'
import { discoverPlugins, type BrokenPlugin } from './loader'
import {
  installPluginFolder,
  updatePluginFolder,
  previewPluginFolder,
  uninstallPlugin,
  sweepPluginStaging,
  adoptBundledPlugins
} from './install'
import { pluginDataDir } from './paths'
import { ManifestError } from './manifest'
import { isRepositorySupplied } from './source'

/**
 * The plugin host: discovery, enabled-state persistence, the tick scheduler, and
 * crash isolation.
 *
 * WHY THE HOST OWNS THE TIMER. A plugin that schedules itself owns its own
 * re-entrancy, and overlapping ticks are the failure this design exists to make
 * impossible: better-sqlite3 is synchronous on one shared connection, so a
 * second tick entering a merge while the first is mid-transaction does not
 * interleave — it corrupts the first one's view of what it already decided. One
 * in-flight promise per plugin, and a tick that fires while one is unresolved is
 * DROPPED rather than queued. Queueing would let a slow relay build a backlog
 * that then runs back to back with no idle time at all.
 *
 * Enabled state lives in `setting` under `plugin.<id>.enabled`. ABSENT MEANS
 * DISABLED, so a fresh install needs no seed row and no migration — unlike
 * `llm_model` (v24), where an empty install left nothing selectable at all.
 *
 * NO PLUGIN IS COMPILED IN. The set of plugins is whatever `discoverPlugins`
 * finds in the two roots at startup, so a plugin the user dropped in and one the
 * app shipped travel the identical path — which is the only way the install path
 * is ever actually exercised.
 */

const ENABLED_KEY = (id: string): string => `plugin.${id}.enabled`

/**
 * The record that a plugin was REMOVED, for plugins whose folder cannot be
 * deleted.
 *
 * A bundled folder lives inside the installation, is often root-owned, and is
 * replaced wholesale by an upgrade — so "remove" cannot mean `rm -rf`, and an app
 * that rewrites its own program directory is one updaters and antivirus software
 * both have opinions about. It means this row instead: discovery skips the id
 * BEFORE reading its manifest and therefore before any of its code runs, so a
 * removed plugin is not merely hidden, it is not loaded.
 *
 * IN THE DATABASE, so the decision survives a restart AND an upgrade that
 * re-ships the folder — which is the whole property. A tombstone in the
 * filesystem would be inside the very directory an installer replaces.
 *
 * IT APPLIES TO BOTH ROOTS. Skipping only the bundled root would let the removal
 * be undone by dropping a folder with the same id into `<userData>/plugins`,
 * which is a substitution attack wearing the user's own decision as a disguise.
 */
const REMOVED_KEY = (id: string): string => `plugin.${id}.removed`

/** Whether the user has removed this plugin. Read by discovery and by the pane. */
export function isPluginRemoved(id: string): boolean {
  return getSetting(getDb(), REMOVED_KEY(id)) === '1'
}

interface Slot {
  entry: LoadedPlugin
  plugin: CorpusPlugin
  timer: ReturnType<typeof setInterval> | null
  /** The in-flight tick, or null. One per plugin, never a queue. */
  inFlight: Promise<void> | null
  /**
   * Bumped on every enable/disable. A tick that resolves after its generation
   * was retired must not write status: the user has since turned the plugin off,
   * and a late resolution flipping `off` back to `ok` is a spinner that survives
   * its own cancellation.
   */
  generation: number
  controller: AbortController
  /** Consecutive failures, for the backoff. Reset by any success. */
  failures: number
  /** Ticks to skip, decremented each scheduled fire. The backoff itself. */
  skip: number
  /** Which tick currently holds the latch. See `runTick`. */
  owner: symbol | null
  /** Teardowns in progress. Counted at quit alongside the in-flight tick. */
  draining: number
  /**
   * Capability calls in flight — a search, a retrieval — as opposed to ticks.
   *
   * SEPARATE FROM `inFlight`, and a SET rather than one promise, because these
   * differ from a tick in both directions. There may be several at once (the
   * queue retrieves several papers in parallel, paced by its own gate and not by
   * this host), so a single slot would drop all but one; and they are long — a
   * search runs to five minutes, a retrieval to an hour — so they cannot join
   * `slot.lifecycle`, which is a strict FIFO chain and would leave the user's Off
   * toggle unresponsive for the duration while suppressing every tick.
   *
   * What they DO need is the two things `inFlight` gives a tick: `leaveEnabled`
   * must abort and then await them, or a disable tears the plugin down under a
   * live call; and `pluginsInFlightCount()` must count them, or `will-quit`
   * closes the database while one is mid-write.
   */
  work: Set<Promise<unknown>>
  /**
   * True once this slot has been retired by an uninstall.
   *
   * A slot is removed from the map immediately, but a tick already awaiting
   * inside it is not: it resumes with a `ctx` it captured, against a plugin
   * whose folder has since been deleted. The generation bump stops it writing
   * status, and this flag stops anything else reaching for it.
   */
  retired: boolean
  /**
   * Serialises enable/disable/configure.
   *
   * They are all async IPC handlers with real awaits inside them, and two
   * overlapping calls interleave as leave→leave→enable — which leaves a running
   * timer while the persisted flag says disabled, and leaks the previous
   * interval. A promise chain is enough: these are user gestures, not a hot path.
   */
  lifecycle: Promise<void>
  /**
   * How many lifecycle changes are part-way through.
   *
   * The chain above orders them against EACH OTHER; this is what orders a tick
   * against them. A scheduled tick is covered by the generation check, because
   * the timer that fired it belongs to a generation the change has since
   * retired — but a MANUAL tick reads the generation at the moment it is
   * called, so that check can never fail for it by construction. Without this
   * flag a click landing inside `configure`'s await would run a full cycle
   * against a plugin that is between its old configuration and its new one:
   * `onEnable` may not have built its client yet, or `onDisable` may already
   * have torn it down.
   */
  lifecycleBusy: number
}

const slots = new Map<string, Slot>()
/**
 * Plugins the user has switched ON that are not running, and why in OUR words.
 *
 * The host's own record, never the plugin's. A plugin that threw on enable or
 * whose ticks keep failing cannot be relied on to describe its own condition:
 * `status()` is a method on the same object that just failed, and on the enable
 * path `onEnable` may not have got far enough to have anything to say. So the
 * one fact only the host knows — that it tried and could not — is kept here.
 *
 * The exception is still DISCARDED, for the reason each catch gives: it is a
 * stranger's, and may carry a relay URL or a credential. What is recorded is
 * that it happened and how often, which is ours to know and safe to show.
 */
const stalled = new Map<string, { kind: 'enable' | 'tick'; skipping: boolean }>()
let broken: BrokenPlugin[] = []
/** Removed ids whose folder is still on disk, so Restore can be offered for them. */
let removedPresent: string[] = []
/**
 * Removals whose teardown is still draining, by id.
 *
 * Discovery must treat these as already loaded. The slot leaves `slots` when the
 * removal begins, but the plugin's `onDisable` and its in-flight work are still
 * running against a live database — so a reload in that window would activate a
 * second instance beside the first.
 */
const retiring = new Map<string, Promise<void>>()
let safeStorage: SafeStorageLike | null = null
let notifySink: (() => void) | null = null
/**
 * Electron's `shell.openExternal`, injected rather than imported.
 *
 * For the reason `safeStorage` is: this file imports no Electron, so that the
 * host and everything that loads it can be exercised outside a main process.
 */
let openExternalImpl: ((url: string) => Promise<void>) | null = null

/**
 * What the host lends a plugin. One object per plugin id, so `dataDir()` is
 * private to it and a `registerSecret` label is attributable.
 */
function servicesFor(id: string): PluginServices {
  return {
    dataDir(): string {
      const dir = pluginDataDir(id)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      return dir
    },
    adoptLegacyFile(fileName) {
      // The name is a single path SEGMENT, never a path. A plugin passing
      // `../../corpus.sqlite` would otherwise have the host move the user's
      // database into the plugin's folder — and this is one of the few verbs
      // the host performs on a plugin's behalf with the host's own reach.
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(fileName) || fileName.includes('..')) {
        throw new Error(`plugin ${id}: adoptLegacyFile needs a plain file name`)
      }
      const from = join(userDataDir(), fileName)
      const to = join(pluginDataDir(id), fileName)
      // Never overwrite: if the plugin has already written its new file, that
      // one is current and the legacy copy is stale.
      if (existsSync(to) || !existsSync(from)) return
      mkdirSync(pluginDataDir(id), { recursive: true, mode: 0o700 })
      try {
        renameSync(from, to)
      } catch {
        // `rename` fails across filesystems, and userData and its own
        // subdirectory are only on different ones in exotic setups — but a
        // failure here must not be fatal, because the user's credential is
        // still where it was and asking them to re-enter it is a far smaller
        // harm than refusing to start.
        try {
          copyFileSync(from, to)
          chmodSync(to, 0o600)
          unlinkSync(from)
        } catch {
          /* left in place; the plugin reports itself unconfigured, honestly */
        }
      }
    },
    registerSecret(label, read) {
      // NAMESPACED by plugin id, so one plugin cannot register under another's
      // label and so a leak found in a redacted log names the plugin it came
      // from rather than just the kind of value it was.
      registerSecret(`plugin.${id}.${label}`, read)
    },
    createProject(input) {
      return createProjectRow(
        getDb(),
        { name: input.name, description: input.description ?? '', summaryPrompt: null },
        new Date().toISOString()
      )
    },
    setClockOffsetMs(ms) {
      setRelayClockOffsetMs(ms)
    },
    appDataDir(): string {
      return userDataDir()
    },
    async openExternal(url) {
      // http(s) ONLY, checked HERE rather than trusted to Electron. `file:` and
      // the OS's own schemes reach a local handler, so an unchecked string is a
      // plugin able to open anything on this machine through the app's hand.
      const raw = String(url)
      // Bounded before parsing. A browser's address bar and history are not
      // built for a megabyte, and the length itself is the payload in several
      // display-truncation tricks.
      if (raw.length > 2048) {
        throw new Error(`plugin ${id} asked to open an address far too long to be one`)
      }
      let parsed: URL
      try {
        parsed = new URL(raw)
      } catch {
        throw new Error(`plugin ${id} asked to open something that is not a web address`)
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error(`plugin ${id} asked to open a ${parsed.protocol} address, which is not opened`)
      }
      // `https://accounts.example.org@evil.tld/` reads as the site before the
      // `@` to a person and resolves to the one after it. The app has no
      // legitimate reason to open a URL carrying credentials, so the shape is
      // refused rather than the deception being argued with.
      if (parsed.username !== '' || parsed.password !== '') {
        throw new Error(`plugin ${id} asked to open an address carrying a username or password`)
      }
      if (!openExternalImpl) throw new Error('plugin host used before initPluginHost()')
      await openExternalImpl(parsed.toString())
    },
    borrow(name) {
      // An ALLOWLIST with one entry. A general `require` proxy would make the
      // app's whole transitive dependency tree part of the plugin API, and every
      // future dependency bump a potential plugin break.
      if (name === 'undici') {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require('undici')
      }
      throw new Error(`plugin ${id} asked to borrow "${String(name)}", which is not lent`)
    }
  }
}

/**
 * Installed by `index.ts` after `app.whenReady()`.
 *
 * `safeStorage` is passed in rather than imported for the reason `types.ts`
 * gives: the host must load outside an Electron main process. It is also not
 * available before `whenReady`, and touching it earlier throws.
 *
 * DISCOVERY IS HERE, not at module load, for the same reason: it activates
 * plugins, and a plugin's `activate` may reach for anything the ctx promises.
 * A discovery failure is contained — the app launches with whatever loaded and
 * the rest listed as broken, because a third party's folder must not be able to
 * stop the user opening their own library.
 */
export function initPluginHost(opts: {
  safeStorage: SafeStorageLike
  notify: () => void
  openExternal: (url: string) => Promise<void>
}): void {
  safeStorage = opts.safeStorage
  notifySink = opts.notify
  openExternalImpl = opts.openExternal
  sweepPluginStaging()
  // BEFORE discovery, and at most once per id. This build still bundles its
  // plugins; the next one will not, and an update REPLACES the installation
  // directory — so a copy made after the folder is gone is a copy of nothing.
  // Adopting here is what lets a working install go on working across that
  // change. See `adoptBundledPlugins` for what it declines to touch.
  const adoption = adoptBundledPlugins(isPluginRemoved)
  if (adoption.adopted.length > 0) {
    console.log(`[plugins] adopted into the user folder: ${adoption.adopted.join(', ')}`)
  }
  // NAMED, not swallowed. An id that fails to adopt is one that disappears at
  // the release which stops bundling, and the whole point of adopting early is
  // that there is still time to fix it.
  for (const f of adoption.failed) {
    console.warn(`[plugins] ${f.id} could not be adopted into the user folder: ${f.reason}`)
  }
  reloadPlugins()
}

/**
 * Re-run discovery from disk. Called at startup and after an install/removal.
 *
 * Folders whose id is already live are skipped BEFORE their code runs — see
 * `discoverPlugins`. Re-activating one would run its registrations and its
 * directory creation a second time and then discard the instance, so the side
 * effects would happen and the object would not.
 */
function reloadPlugins(): void {
  // Ids whose teardown has NOT finished count as already loaded. A slot is
  // deleted from the map the moment a removal starts, so without this a restore
  // (or an install) arriving during that drain finds the id absent and activates
  // the plugin a SECOND time while the first instance is still tearing down —
  // two `registerSecret` calls, two clients, and the discarded one's side effects
  // already applied. That is precisely the non-idempotent activation the
  // already-loaded set exists to prevent.
  const live = new Set([...slots.keys(), ...retiring.keys()])
  const result = discoverPlugins(servicesFor, live, isPluginRemoved)
  broken = result.broken
  removedPresent = result.removedPresent
  for (const entry of result.loaded) {
    if (slots.has(entry.manifest.id)) continue
    slots.set(entry.manifest.id, {
      entry,
      plugin: entry.plugin,
      timer: null,
      inFlight: null,
      generation: 0,
      controller: new AbortController(),
      failures: 0,
      skip: 0,
      owner: null,
      draining: 0,
      work: new Set(),
      retired: false,
      lifecycle: Promise.resolve(),
      lifecycleBusy: 0
    })
  }

  // A folder deleted OUTSIDE `removePlugin` — by hand, or by an uninstaller —
  // leaves a live slot with a running timer pointing at code that is no longer
  // on disk. The module is already resident so it keeps ticking, which makes the
  // symptom "a plugin I deleted is still syncing". Torn down here on the same
  // path as any other disable.
  for (const [id, slot] of [...slots]) {
    if (slot.retired || existsSync(slot.entry.dir)) continue
    slots.delete(id)
    setSetting(getDb(), ENABLED_KEY(id), '0')
    const drain = serialised(slot, async () => {
      try {
        await leaveEnabled(slot)
      } finally {
        slot.retired = true
      }
    })
    // Recorded for the same reason `removePlugin` records its own teardown: the
    // slot is gone from the map but the plugin is still unwinding, so a reload
    // arriving now — and one arrives whenever a folder is restored to the disk
    // it was taken from — would activate a second instance beside it.
    // The SETTLED promise is what is both stored and hooked, so a teardown that
    // throws cannot become an unhandled rejection on the way to clearing the map.
    const settled = drain.then(() => undefined, () => undefined)
    retiring.set(id, settled)
    void settled.then(() => retiring.delete(id))
  }
}

function ctxFor(slot: Slot): PluginCtx {
  if (!safeStorage) throw new Error('plugin host used before initPluginHost()')
  return {
    db: getDb(),
    safeStorage,
    notify: () => notifySink?.(),
    signal: slot.controller.signal,
    services: servicesFor(slot.entry.manifest.id)
  }
}

function isEnabled(id: string): boolean {
  return getSetting(getDb(), ENABLED_KEY(id)) === '1'
}

/**
 * Bring every persisted-enabled plugin up. Called once from `startup()`.
 *
 * A plugin that throws on enable is left NOT RUNNING and SAYS SO, and the launch
 * continues: a relay that has moved must not stop the app from opening.
 *
 * THE PERSISTED SETTING IS NOT TOUCHED, and that is the change. Writing '0' here
 * turned a transient fault into a permanent decision the user never made: a
 * laptop opened before the wifi associated found its relay unreachable, and
 * A plugin was switched off — in the database, so it stayed off across
 * every later launch, on a network where it would have worked. Sharing then
 * silently stopped for good, and the only visible trace was a toggle sitting in
 * the position the user last saw it in anyway.
 *
 * An enable flag is a user's standing INTENT. This launch failing to honour it
 * is news about this launch. The plugin is left un-run and listed in `stalled`,
 * so the pane shows it switched on and not working — which is the true state and
 * the one the user can act on, by fixing the network or switching it off
 * themselves.
 */
export async function startEnabledPlugins(): Promise<void> {
  for (const slot of slots.values()) {
    const id = slot.entry.manifest.id
    if (!isEnabled(id)) continue
    try {
      await serialised(slot, () => enterEnabled(slot))
      stalled.delete(id)
    } catch {
      // The thrown value is discarded rather than logged: it is a plugin's own
      // exception and may carry a URL or a credential. That it failed is ours.
      stalled.set(id, { kind: 'enable', skipping: false })
    }
  }
}

/** Run `fn` after whatever lifecycle change is already in progress. */
function serialised<T>(slot: Slot, fn: () => Promise<T>): Promise<T> {
  // Incremented HERE, in the caller's own synchronous turn, and not inside the
  // chained callback. `.then` schedules a microtask, so a press arriving in the
  // same turn as the `configurePlugin` call that preceded it would find the
  // counter still zero and run a full cycle before the change had begun — which
  // is exactly the race this counter exists to close, and is what the
  // lifecycle-guard test caught.
  slot.lifecycleBusy += 1
  const settle = (): void => {
    slot.lifecycleBusy -= 1
  }
  const next = slot.lifecycle.then(fn, fn)
  next.then(settle, settle)
  slot.lifecycle = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

async function enterEnabled(slot: Slot): Promise<void> {
  // A removal that started while this enable was queued on the lifecycle chain
  // has already torn the plugin down and deleted its slot. Running `onEnable`
  // now would build a client and a timer nothing will ever stop — `runTick`
  // makes exactly this check first, for exactly this reason.
  if (slot.retired) return
  slot.generation += 1
  // A fresh attempt supersedes whatever the last one concluded. Left in place,
  // a plugin the user has just successfully re-enabled would still be described
  // as not running.
  stalled.delete(slot.entry.manifest.id)
  // Cleared unconditionally: an interval left behind by an interrupted
  // enable/disable pair is one this process can never reach again to stop.
  if (slot.timer) {
    clearInterval(slot.timer)
    slot.timer = null
  }
  slot.controller = new AbortController()
  slot.failures = 0
  slot.skip = 0
  await slot.plugin.onEnable(ctxFor(slot))
  const interval = resolveInterval(slot)
  if (slot.plugin.tick && interval && interval > 0) {
    const generation = slot.generation
    slot.timer = setInterval(() => {
      void runTick(slot, generation)
    }, interval)
    // A timer is the only thing this process would otherwise stay alive for
    // during a quit that is waiting on nothing else.
    slot.timer.unref?.()
  }
}

/**
 * How often this plugin wants ticking, asked of it fresh.
 *
 * A THROW here means no timer rather than a failed enable: the interval is a
 * detail of scheduling, and a plugin that cannot say how often it wants running
 * is one that should sit still, not one that stops the user enabling it.
 */
function resolveInterval(slot: Slot): number | null {
  const spec = slot.plugin.tickIntervalMs
  if (typeof spec === 'number') return spec
  if (typeof spec !== 'function') return null
  try {
    return spec(ctxFor(slot))
  } catch {
    return null
  }
}

/**
 * One tick, guarded four ways: the re-entrancy latch, the generation check on
 * entry AND after the await, the retirement flag, and the backoff counter.
 *
 * `manual` skips the BACKOFF only. The backoff exists to stop a broken relay
 * being hammered by a timer nobody asked to fire; a person pressing a button has
 * asked, and telling them "not yet, come back in thirty-two intervals" with no
 * way to see or shorten the wait is a control that does nothing for reasons the
 * user cannot discover. Every other guard — the latch, the generation, the
 * lifecycle flag and the retirement flag — applies exactly as it does to a
 * scheduled tick, because each of those protects the DATABASE rather than the
 * relay.
 */
async function runTick(slot: Slot, generation: number, manual = false): Promise<boolean> {
  if (slot.retired) return false
  if (slot.generation !== generation) return false
  if (slot.inFlight !== null) return false
  // A lifecycle change is part-way through. For a SCHEDULED tick the generation
  // check above has already covered this; for a manual one it cannot, because a
  // manual tick reads the generation at the moment it is called. Both are
  // refused here rather than run against a plugin whose `onEnable` has not
  // finished or whose `onDisable` already has.
  if (slot.lifecycleBusy > 0) return false
  if (slot.skip > 0) {
    if (!manual) {
      slot.skip -= 1
      return false
    }
    slot.skip = 0
  }
  const tick = slot.plugin.tick
  if (!tick) return false
  const ctx = ctxFor(slot)
  // A token, rather than the promise comparing against itself: the `finally`
  // must only clear the latch if THIS tick still owns it. A slow tick clearing
  // a latch a newer one has since taken lets two run at once, which is the one
  // thing this guard exists to prevent.
  const token = Symbol('tick')
  slot.owner = token
  const run = (async (): Promise<void> => {
    // THE FIRST STATEMENT MUST YIELD, and this is why the latch is taken below
    // rather than here. A plugin whose `tick` is a plain function that throws
    // before returning a promise runs try/catch/finally SYNCHRONOUSLY, so the
    // `finally` clears the latch — and then the assignment after this IIFE sets
    // it to an already-settled promise that nothing will ever clear again.
    // Every later tick returns early forever, and `pluginsInFlightCount()`
    // reports work in flight for the rest of the process, which defers
    // `closeDb()` at quit indefinitely. Yielding first puts the whole body
    // after the assignment, whatever the plugin does.
    await Promise.resolve()
    try {
      await tick(ctx)
      if (slot.generation === generation) {
        slot.failures = 0
        stalled.delete(slot.entry.manifest.id)
      }
    } catch {
      // Crash isolation. A throwing tick never reaches the unhandled-rejection
      // path, and the exception is DISCARDED rather than stored: `last_error_code`
      // lives in a database that gets exported and attached to bug reports, and
      // undici's messages carry the request URL and sometimes headers. The
      // plugin's own `status()` reports a mapped enum sentence instead.
      if (slot.generation === generation) {
        slot.failures = Math.min(slot.failures + 1, 6)
        // Exponential in ticks, capped: 1, 2, 4, 8, 16, 32 skipped intervals.
        slot.skip = 2 ** (slot.failures - 1)
        // THE BACKOFF ITSELF IS RECORDED, separately from whatever the plugin
        // says about the failure. At the cap the timer fires once and does
        // nothing thirty-two times, which at a ten-second interval is over five
        // minutes of a plugin the user sees switched on and which is running
        // nothing — and no plugin can report this, because it is the HOST's
        // decision, taken outside the plugin entirely. The plugin's own status
        // is a snapshot of its last attempt and stays whatever it was.
        //
        // Only past the first skip. A single missed interval is a retry, not a
        // condition worth putting on screen; announcing every transient blip
        // would make the notice unreadable by the time it mattered.
        stalled.set(slot.entry.manifest.id, {
          kind: 'tick',
          skipping: slot.failures > 1
        })
      }
    } finally {
      if (slot.owner === token) slot.inFlight = null
      if (slot.generation === generation && !slot.retired) notifySink?.()
    }
  })()
  slot.inFlight = run
  await run
  return true
}

/**
 * Run one tick NOW, because the user asked for it.
 *
 * The SAME `runTick` the timer calls, on the same slot, through the same latch —
 * which is the whole point. A second path that did its own cycle would be a
 * second place re-entrancy could be got wrong, and better-sqlite3 is synchronous
 * on one shared connection: two cycles inside one merge do not interleave, they
 * corrupt the first one's view of what it already decided.
 *
 * `false` means a cycle was already in flight and this call started nothing. It
 * is the ordinary answer to a second click, not a failure, so it is a value
 * rather than a throw — the caller keeps showing the busy control it is already
 * showing.
 *
 * NOT serialised through `slot.lifecycle`. That chain is for enable/disable/
 * configure, and queueing a sync behind one would make a click during a save sit
 * silently until it finished; the latch is the guard that matters here, and it
 * is checked inside `runTick` in the same synchronous turn.
 */
export async function runPluginTickNow(pluginId: string): Promise<boolean> {
  const slot = slotOrThrow(pluginId)
  if (!isEnabled(pluginId)) {
    throw new Error('That plugin is switched off, so there is nothing to sync.')
  }
  if (!slot.plugin.tick) {
    throw new Error('That plugin has nothing to sync.')
  }
  return runTick(slot, slot.generation, true)
}

/**
 * Await or abort whatever is in flight, then tear the plugin down.
 *
 * The await is not optional: the DB handle is closed on quit, and a tick that
 * resumes on a nulled connection throws from a finalized statement — which the
 * user sees as a crash on exit.
 */
async function leaveEnabled(slot: Slot): Promise<void> {
  slot.generation += 1
  if (slot.timer) {
    clearInterval(slot.timer)
    slot.timer = null
  }
  slot.controller.abort()
  // `slot.inFlight` is left SET across this await, and that is the whole of what
  // makes `pluginsInFlightCount()` mean anything at quit. `will-quit` calls
  // `stopPluginsForQuit()` without awaiting it and then, in the same
  // synchronous turn, asks whether anything is still working before closing the
  // database. Clearing the handle first would answer "nothing" while the tick
  // was still mid-transaction — defeating the counter in exactly the case it
  // exists for, and closing the connection under a running merge.
  //
  // Leaving it set also blocks a new tick from starting: `runTick` returns
  // early on a non-null `inFlight`. The tick's own `finally` clears it.
  const pending = slot.inFlight
  if (pending) {
    try {
      await pending
    } catch {
      /* already isolated inside runTick */
    }
  }
  slot.inFlight = null
  // Capability work — a search, a retrieval — is awaited on exactly the same
  // terms and for the same reason. The abort above is what makes this bounded:
  // these calls run to five minutes and an hour respectively and are cancelled
  // through `ctx.signal`, so awaiting them without having aborted first would
  // hang a disable (and a quit) for the whole of it.
  //
  // DRAINED IN A LOOP, not awaited once. A snapshot would be enough only if the
  // enabled flag were always cleared before this ran, and two callers do not
  // clear it at all: `configurePluginInner` tears the plugin down to restart it
  // with new settings, and `stopPluginsForQuit` never touches the flag. So a
  // dispatch can pass its checks between the snapshot and the await, and would
  // then be running against a plugin whose `onDisable` has already returned —
  // uncounted at quit, which is a half-written retrieval on a closed connection.
  //
  // The loop terminates because the signal is aborted above and every dispatch
  // re-reads it, so each pass is strictly shorter than the last.
  while (slot.work.size > 0) await Promise.allSettled([...slot.work])
  // Counted too. `onDisable` awaits the relay client's close and writes share
  // state, so a teardown interrupted by `closeDb()` is the same finalized-
  // statement crash the await above prevents.
  slot.draining += 1
  try {
    await slot.plugin.onDisable(ctxFor(slot))
  } finally {
    slot.draining -= 1
  }
}

/**
 * How long a quit waits for a plugin that will not stop.
 *
 * The abort is COOPERATIVE: `leaveEnabled` fires the signal and then waits, and
 * a plugin that never checks it can hold a retrieval open for an hour. Waiting
 * for that is an app the user cannot close, with no window left to explain
 * itself — so the wait is bounded and the process goes on quitting.
 *
 * Generous, because the ordinary case is not a hostile plugin: it is a socket
 * closing and a transaction committing, which is fast, and cutting a healthy
 * teardown short is the very thing this whole await exists to prevent.
 */
const QUIT_DRAIN_MS = 10_000

/** Called from `will-quit`. Every plugin, in parallel, awaited as a whole. */
export async function stopPluginsForQuit(): Promise<void> {
  await Promise.all(
    [...slots.values()].map(async (slot) => {
      try {
        // The timer is what the race is against, and it is unref'd: it must not
        // by itself keep the process alive once every teardown has finished.
        let timer: ReturnType<typeof setTimeout> | undefined
        const deadline = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, QUIT_DRAIN_MS)
          timer.unref?.()
        })
        try {
          await Promise.race([leaveEnabled(slot), deadline])
        } finally {
          if (timer) clearTimeout(timer)
        }
      } catch {
        /* quitting: a plugin's teardown failure changes nothing */
      }
    })
  )
}

// ------------------------------------------------------------------- the API

export function listPlugins(): PluginListDTO {
  const out = [...slots.values()].map((slot) => toDto(slot))
  for (const b of broken) {
    // The reason can quote what the folder CLAIMED — an id-mismatch message
    // interpolates the id the plugin's own module returned — so it is shaped
    // like any other plugin-authored sentence. `folder` is a filesystem name and
    // is bounded to a label: it names a directory, not a paragraph.
    const reason = shapeSentence(b.reason) ?? 'That plugin could not be started.'
    const label = shapeLabel(b.id ?? b.folder) ?? 'A plugin'
    // A broken folder gets a ROW rather than being dropped. A plugin the user
    // installed and then cannot find anywhere is indistinguishable from one the
    // app lost, and there would be nothing to click to remove it.
    out.push({
      id: b.id ?? b.folder,
      name: label,
      blurb: '',
      discloses: '',
      enabled: false,
      installed: true,
      // The one row that genuinely cannot be removed, and only when it is
      // bundled: an added folder is deleted whatever state it is in, but a
      // bundled one is removed by tombstoning its id, and this folder's manifest
      // never parsed — so there is no confirmed id to write the record against.
      removable: b.origin === 'added' && !isRepositorySupplied(b.id ?? ''),
      // A folder whose manifest never parsed still has a SUPPLIER: the record is
      // a settings row written when it was installed, and it is read without
      // opening the folder — which is the whole reason the lock lives in the
      // database rather than in the tree it governs.
      supplier: isRepositorySupplied(b.id ?? '')
        ? 'repository'
        : b.origin === 'bundled'
          ? 'bundled'
          : 'user',
      origin: b.origin,
      version: null,
      dir: b.dir,
      params: [],
      values: {},
      secretsSet: {},
      blockers: [reason],
      warnings: [],
      // NOTHING, whatever the folder claims: its module never loaded, so there
      // is no object to ask and no verb that could answer.
      capabilities: [],
      setupActions: [],
      setupHelp: null,
      failedToLoad: reason,
      status: { ...OFF_STATUS }
    })
  }
  const present = new Set(removedPresent)
  // Every tombstone, not only the folders discovery just walked past. A record
  // whose folder is absent still has to be shown: it is a decision the user made
  // that is still in force, and an upgrade re-shipping the folder would silently
  // act on it. `present` is what decides whether Restore can do anything.
  const removed = allRemovedIds()
    .map((id) => ({ id, present: present.has(id) }))
    .sort((a, b2) => a.id.localeCompare(b2.id))
  return { plugins: out.sort((a, b2) => a.name.localeCompare(b2.name)), removed }
}

/**
 * Every id carrying a removal record, read from the settings table.
 *
 * By PREFIX, because the set is not otherwise knowable: a tombstone outlives the
 * folder it was written for, which is the whole point of it, so there is nothing
 * on disk to enumerate. The id is bounded by the manifest's own `[a-z][a-z0-9-]*`
 * shape, so the two fixed affixes cannot be spoofed by a key in the middle.
 */
function allRemovedIds(): string[] {
  const rows = getDb()
    .prepare<[], { key: string }>(
      "SELECT key FROM setting WHERE key LIKE 'plugin.%.removed' AND value = '1'"
    )
    .all()
  const out: string[] = []
  for (const row of rows) {
    const id = row.key.slice('plugin.'.length, -'.removed'.length)
    if (/^[a-z][a-z0-9-]{1,62}$/.test(id)) out.push(id)
  }
  return out
}

/**
 * What the host has to say about a plugin, in the host's own words.
 *
 * Hard rule 0.6 applies: nothing is said about a plugin that is working, and
 * nothing is said about one the user has switched OFF — not running is what off
 * means, and a warning there would be an exception badge on the normal case.
 */
function hostWarnings(id: string, enabled: boolean): string[] {
  if (!enabled) return []
  const s = stalled.get(id)
  if (!s) return []
  if (s.kind === 'enable') {
    return [
      'This plugin is switched on but did not start when the app opened, so it is not doing '
      + 'anything. Switch it off and on again to retry.'
    ]
  }
  return s.skipping
    ? [
        'This plugin is switched on but its recent attempts have failed, so it is waiting '
        + 'longer between them and may not run for several minutes.'
      ]
    : ['This plugin’s last attempt to run failed. It will try again shortly.']
}

function toDto(slot: Slot): PluginDTO {
  const ctx = ctxFor(slot)
  const m = slot.entry.manifest
  const enabled = isEnabled(m.id)
  // ONCE. This runs a stranger's getter, and asking twice invites two different
  // answers for one row.
  const setupActions = pluginSetupActions(m.id)
  const repositorySupplied = isRepositorySupplied(m.id)
  return {
    id: m.id,
    name: m.name,
    blurb: m.blurb,
    discloses: m.discloses,
    enabled,
    installed: true,
    // Every loaded plugin can be removed EXCEPT one the connected repository
    // supplied. A bundled one is tombstoned rather than deleted, which is a
    // difference in what happens on disk and in the sentence the confirmation
    // shows — not in whether the button works. A repository plugin is the one
    // real refusal, and it is released by disconnecting rather than by anything
    // on the row: see `repository.ts`.
    removable: !repositorySupplied,
    supplier: repositorySupplied ? 'repository' : slot.entry.origin === 'bundled' ? 'bundled' : 'user',
    origin: slot.entry.origin,
    version: m.version,
    dir: slot.entry.dir,
    params: [...m.params],
    values: shapeValues(() => slot.plugin.values(ctx), m.params),
    secretsSet: shapeSecretsSet(() => slot.plugin.secretsSet(ctx), m.params),
    blockers: enabled ? [] : sentences(() => slot.plugin.blockers(ctx)),
    // The HOST's warning comes first, and is not a sentence the plugin authored
    // — so it is not passed through `sentences()`, which exists to make a
    // stranger's string safe. It is here because a plugin that failed to start,
    // or whose work the host has backed off, cannot report either: the first
    // never got far enough to have a status, and the second is a decision taken
    // outside it.
    warnings: [...hostWarnings(m.id, enabled), ...sentences(() => slot.plugin.warnings(ctx))],
    capabilities: capabilitiesOf(slot.plugin),
    setupActions,
    // From the MANIFEST, which the loader already bounded and shaped, and only
    // when there is a button for it to introduce — a sentence about controls
    // that are not on screen describes nothing the reader can see.
    setupHelp: setupActions.length > 0 ? (m.setupHelp ?? null) : null,
    failedToLoad: null,
    status: enabled ? shapeStatus(() => slot.plugin.status(ctx)) : { ...OFF_STATUS }
  }
}

/** As long as one of them can be, which is the widest a sentence gets to be. */
const SENTENCE_MAX = 400
/** A label names a machine or a host, not a paragraph. */
const LABEL_MAX = 80
/** A code is a slug the renderer keys styling on, never prose. */
const CODE_MAX = 48

/** Buttons kept. The same bound `sentences()` uses on a list of prose. */
const SETUP_ACTIONS_MAX = 8
/**
 * Entries LOOKED AT, which is the bound that actually terminates.
 *
 * Higher than what is kept, so a list with a few malformed entries among good
 * ones still yields the good ones, and finite, so one that is entirely rubbish
 * still ends.
 */
const SETUP_ACTIONS_MAX_READ = 64

/** Control characters and the bidi overrides, which hide the rest of a line. */
const UNSAFE_CHARS = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/

/**
 * ONE sentence, made safe to render.
 *
 * EVERY string a plugin authors passes through here or through `sentences()`
 * below, because every one of them is rendered verbatim somewhere: a plugin's
 * `status().sentence` and a share's `sentence` are prose in the Plugins pane and
 * the navbar, `relayLabel` is interpolated into a tooltip, `testConnection()`
 * answers a button press, and `configure()`'s rejections sit under the fields
 * they refuse. A plugin is a folder a stranger wrote, so what arrives is
 * arbitrary: an exception message carrying an absolute path (and therefore the
 * OS username), a stack, a URL, a megabyte of text, or a `\r`.
 *
 * SHAPED, not allowlisted, because the whole point of these fields is that the
 * plugin says something only it knows — a closed set would defeat them. So the
 * strings are bounded and control and text-direction characters are refused (the
 * same rule `manifest.ts` applies to every displayed manifest string, so what is
 * stored and what is read stay the same string). Anything failing the shape
 * becomes `null`: rendering nothing is always available, and a caller that
 * cannot say something showable does not thereby get to say something else.
 */
export function shapeSentence(raw: unknown, max = SENTENCE_MAX): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (s.length === 0 || s.length > max || UNSAFE_CHARS.test(s)) return null
  return s
}

/** A label for a peer or a relay — the same shape, bounded far shorter. */
export function shapeLabel(raw: unknown): string | null {
  return shapeSentence(raw, LABEL_MAX)
}

/**
 * An enum code, bounded to what a code can be.
 *
 * Stricter than a sentence because the renderer keys STYLING on this: it is
 * matched, put into class names and data attributes, and never read as prose. A
 * slug is the whole of what that use needs, so anything else is refused rather
 * than truncated.
 */
export function shapeCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!/^[a-z][a-z0-9-]*$/.test(s) || s.length > CODE_MAX) return null
  return s
}

/**
 * Blockers and warnings: a LIST of sentences, capped.
 *
 * A throw is an empty list — a plugin that cannot say why it is blocked is not
 * thereby entitled to crash the pane that lists it.
 */
function sentences(read: () => string[]): string[] {
  let raw: unknown
  try {
    raw = read()
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  return raw
    .map((s) => shapeSentence(s))
    .filter((s): s is string => s !== null)
    .slice(0, 8)
}

const RUN_STATES: readonly PluginRunState[] = [
  'off',
  'idle',
  'syncing',
  'ok',
  'resync',
  'failed',
  'needs-credentials'
]

const OFF_STATUS: PluginStatusDTO = { state: 'off', sentence: null, code: null, lastOkAt: null }

/**
 * A run state, checked against the enum.
 *
 * The state selects a badge colour and an icon, and an unknown member falls
 * through every branch to whatever the last `else` renders — which is a plugin
 * choosing its own appearance. Anything else reads as `off`.
 */
export function shapeRunState(raw: unknown): PluginRunState {
  return RUN_STATES.includes(raw as PluginRunState) ? (raw as PluginRunState) : 'off'
}

/**
 * A plugin's `status()`, shaped whole. A throw reads as `off`: a plugin that
 * cannot say how it is doing does not thereby get to blank the pane.
 */
export function shapeStatus(read: () => PluginStatusDTO): PluginStatusDTO {
  let raw: unknown
  try {
    raw = read()
  } catch {
    return OFF_STATUS
  }
  if (typeof raw !== 'object' || raw === null) return OFF_STATUS
  const r = raw as Record<string, unknown>
  return {
    state: shapeRunState(r.state),
    sentence: shapeSentence(r.sentence),
    code: shapeCode(r.code),
    lastOkAt: shapeIso(r.lastOkAt)
  }
}

/**
 * The stored values of the DECLARED params, made safe to put in a form field.
 *
 * Keyed against the manifest rather than trusted from the returned record: a key
 * the form never declared has no field to appear in, and a plugin answering with
 * one is describing a parameter it never disclosed. Strings are shaped like any
 * other — this record is rendered straight into `<input value>`, which is where
 * the user reads their own relay address back, so a bidi run or a megabyte of
 * text lands in the one place they would trust it least.
 *
 * A THROW is an empty record, not a broken pane. Unlike a sentence, an escaping
 * exception here rejects `plugins:list` itself, so one hostile folder would
 * leave Settings stuck on "Reading…" for EVERY plugin.
 */
function shapeValues(
  read: () => Record<string, unknown>,
  params: readonly { key: string }[]
): Record<string, string | number | boolean | null> {
  let raw: unknown
  try {
    raw = read()
  } catch {
    return {}
  }
  if (typeof raw !== 'object' || raw === null) return {}
  const r = raw as Record<string, unknown>
  const out: Record<string, string | number | boolean | null> = {}
  for (const p of params) {
    const v = r[p.key]
    if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[p.key] = v
    else if (typeof v === 'string') out[p.key] = shapeSentence(v)
    else out[p.key] = null
  }
  return out
}

/** Whether each declared secret is set. Booleans only, and only declared keys. */
function shapeSecretsSet(
  read: () => Record<string, unknown>,
  params: readonly { key: string }[]
): Record<string, boolean> {
  let raw: unknown
  try {
    raw = read()
  } catch {
    return {}
  }
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const out: Record<string, boolean> = {}
  for (const p of params) out[p.key] = r[p.key] === true
  return out
}

/** An ISO-8601 instant, or null. Rendered as a relative time, so it must parse. */
export function shapeIso(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 40) return null
  const t = Date.parse(raw)
  return Number.isNaN(t) ? null : raw
}

/**
 * The verbs a capability requires, ALL of them.
 *
 * A capability is what the app opens a SURFACE for, and the sharing surface
 * calls all four — so a plugin offering three of them would get an entry point
 * whose Stop button throws. Requiring the whole set is what makes the entry
 * point's presence mean that the calls behind it exist.
 *
 * IT IS ALSO WHAT DISPATCH RESOLVES AGAINST. `pluginsWithCapability` below
 * answers "which folder can do this?" at call time, so the sharing handlers in
 * `main/index.ts` name no id at all: a second plugin offering these verbs is
 * routed to on the same path the in-tree one is, and the entry point the
 * renderer gates on this capability can no longer light up over a call that
 * would be refused.
 */
const CAPABILITY_VERBS: Record<PluginCapability, readonly string[]> = {
  'project-sharing': ['sharesFor', 'shareProject', 'joinProject', 'unshareProject'],
  // ONE verb each, and they are two capabilities rather than one because they
  // gate two different surfaces and a plugin can honestly offer either alone: an
  // index reachable from Node can search without being able to defeat the JS
  // challenge a publisher serves in front of a PDF. Fusing them would put a
  // "Search for new papers" tab on screen for a plugin that only retrieves.
  'paper-search': ['searchPapers'],
  'paper-retrieval': ['retrievePdf'],
  // `setupActions` as well as `runSetup`, because a button needs a WORD and the
  // app has none to offer: it does not know whether the step installs something,
  // registers something or opens a browser. A plugin offering the action without
  // being able to name it would get a button reading whatever the app guessed.
  'plugin-setup': ['runSetup', 'setupActions']
}

/**
 * DERIVED FROM THE LOADED OBJECT, never from the manifest.
 *
 * `plugin.json` is read before any of the plugin's code runs, which is exactly
 * why it cannot be trusted with this: a manifest may declare anything, and a
 * declared-but-unimplemented capability would put a button on screen that fails
 * on its first press. Asking the object is the same question `pluginVerb` asks
 * at call time, so the two can never disagree.
 */
function capabilitiesOf(plugin: CorpusPlugin): PluginCapability[] {
  const bag = plugin as unknown as Record<string, unknown>
  // A property READ on a stranger's object can run a getter, which can throw or
  // do work. This is asked on every `listPlugins` and on every dispatch, so an
  // unguarded read is a plugin able to reject the whole Plugins pane — and the
  // shares list with it — by defining one accessor.
  const has = (verb: string): boolean => {
    try {
      return typeof bag[verb] === 'function'
    } catch {
      return false
    }
  }
  return (Object.keys(CAPABILITY_VERBS) as PluginCapability[]).filter((cap) =>
    CAPABILITY_VERBS[cap].every(has)
  )
}

/**
 * Every LOADED plugin offering a capability, in id order.
 *
 * The order is deterministic so that a machine with two such folders behaves the
 * same on every launch: discovery order follows the filesystem, and a dispatch
 * that changed which plugin it reached because a directory listing came back
 * differently would be the kind of fault nobody can reproduce.
 */
export function pluginsWithCapability(cap: PluginCapability): string[] {
  return [...slots.values()]
    .filter((slot) => !slot.retired && capabilitiesOf(slot.plugin).includes(cap))
    .map((slot) => slot.entry.manifest.id)
    .sort()
}

/** The same, narrowed to the ones the user has actually switched on. */
export function enabledPluginsWithCapability(cap: PluginCapability): string[] {
  return pluginsWithCapability(cap).filter((id) => isEnabled(id))
}

function slotOrThrow(pluginId: string): Slot {
  const slot = slots.get(pluginId)
  if (!slot || slot.retired) throw new Error('That plugin is not installed.')
  return slot
}

export async function setPluginEnabled(pluginId: string, enabled: boolean): Promise<PluginDTO> {
  const slot = slotOrThrow(pluginId)
  return serialised(slot, () => setPluginEnabledInner(slot, enabled))
}

async function setPluginEnabledInner(slot: Slot, enabled: boolean): Promise<PluginDTO> {
  const pluginId = slot.entry.manifest.id
  const already = isEnabled(pluginId)
  if (enabled === already) return toDto(slot)
  if (enabled) {
    // Re-checked in MAIN, not trusted from the renderer. The toggle is already
    // disabled up there; this is the check that holds when it is not.
    //
    // SHAPED, because this one crosses IPC as a rejection and a rejection is
    // rendered somewhere: a blocker good enough to display in the row is good
    // enough to throw, and one that is not shows a sentence of ours instead.
    const blockers = sentences(() => slot.plugin.blockers(ctxFor(slot)))
    if (blockers.length > 0) throw new Error(blockers[0])
    setSetting(getDb(), ENABLED_KEY(pluginId), '1')
    try {
      await enterEnabled(slot)
    } catch (err) {
      setSetting(getDb(), ENABLED_KEY(pluginId), '0')
      throw err
    }
  } else {
    setSetting(getDb(), ENABLED_KEY(pluginId), '0')
    await leaveEnabled(slot)
  }
  notifySink?.()
  return toDto(slot)
}

export async function configurePlugin(
  pluginId: string,
  values: Record<string, string | number | boolean>
): Promise<PluginConfigureResultDTO> {
  const slot = slotOrThrow(pluginId)
  return serialised(slot, () => configurePluginInner(slot, values))
}

async function configurePluginInner(
  slot: Slot,
  values: Record<string, string | number | boolean>
): Promise<PluginConfigureResultDTO> {
  const pluginId = slot.entry.manifest.id
  // Only DECLARED keys reach the plugin. The IPC layer validates shape; this is
  // what stops a renderer (or a compromised one) from smuggling a key the
  // configuration form never showed into a plugin's `configure` — which is
  // exactly how a hidden parameter would be set without ever being displayed.
  const declared = new Map(slot.entry.manifest.params.map((p) => [p.key, p]))
  const filtered: Record<string, string | number | boolean> = {}
  for (const [k, v] of Object.entries(values)) {
    const param = declared.get(k)
    if (!param) continue
    // A `choice` IS ITS OPTIONS, and the closed set is enforced HERE rather
    // than left to each plugin. The manifest declares the alternatives, so the
    // host is the layer that knows them; a plugin that forgot to re-check would
    // otherwise receive an arbitrary string through a field whose whole
    // contract is that it cannot be one — and then write it wherever it writes
    // its configuration.
    if (param.kind === 'choice' && !param.options?.some((o) => o.value === String(v))) continue
    filtered[k] = v
  }

  const outcome = await slot.plugin.configure(ctxFor(slot), filtered)
  // Config that changes WHERE the plugin points invalidates whatever it was
  // doing there. Restarting rather than reconfiguring in place is what stops a
  // tick begun against the old address finishing against the new one's state.
  if (isEnabled(pluginId)) {
    await leaveEnabled(slot)
    const blockers = sentences(() => slot.plugin.blockers(ctxFor(slot)))
    if (blockers.length > 0) {
      // The new config made the plugin unrunnable — clearing the password, say.
      // Turned off rather than left in a state whose only symptom is silence.
      setSetting(getDb(), ENABLED_KEY(pluginId), '0')
    } else {
      await enterEnabled(slot)
    }
  }
  notifySink?.()
  // The rejections are rendered under the fields they refuse, so they are shaped
  // like every other plugin-authored string — and keyed back against the
  // DECLARED params, because a key the form never showed has no field to sit
  // under and would be a message with no context at all.
  const rejected: Record<string, string> = {}
  const rawRejected = outcome?.rejected
  if (typeof rawRejected === 'object' && rawRejected !== null) {
    for (const [k, v] of Object.entries(rawRejected as Record<string, unknown>)) {
      if (!declared.has(k)) continue
      const sentence = shapeSentence(v)
      if (sentence) rejected[k] = sentence
    }
  }
  return { plugin: toDto(slot), rejected }
}

/**
 * Probe the connection, and shape what comes back.
 *
 * A THROW is an answer here, not a failure to answer: the button's whole job is
 * to say whether the far end is reachable, and a plugin whose probe raised is a
 * plugin that could not reach it. The exception itself is discarded — undici's
 * messages carry the request URL — and replaced by a sentence of ours, which is
 * the same trade the tick's crash isolation makes.
 */
export async function testPluginConnection(pluginId: string): Promise<PluginTestResultDTO> {
  const slot = slotOrThrow(pluginId)
  let raw: unknown
  try {
    raw = await slot.plugin.testConnection(ctxFor(slot))
  } catch {
    return { ok: false, sentence: 'That plugin could not be reached.', code: null }
  }
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    ok: r.ok === true,
    sentence: shapeSentence(r.sentence) ?? 'That plugin gave no answer this app can show.',
    code: shapeCode(r.code)
  }
}

// --------------------------------------------------------------- install/remove

/**
 * Validate and copy a chosen folder in, then load it — WITHOUT a relaunch.
 *
 * The new plugin arrives disabled, as every plugin does: installing is the user
 * saying "I want this available", and enabling is the separate, consented act
 * that lets it start doing anything.
 */
export function installPlugin(source: string): PluginDTO {
  // A FOLDER CARRYING A REMOVED ID IS REFUSED BEFORE ANYTHING IS COPIED.
  //
  // Discovery skips a tombstoned id in BOTH roots, so copying one in would land
  // a folder that never loads: no slot, no broken row, nothing in the table and
  // nothing to remove it with. The user's decision is undone from the "Removed"
  // section, which is where the id they took out is actually named.
  if (isPluginRemoved(previewPluginFolder(source).id)) {
    throw new ManifestError(
      'removed',
      'You removed that plugin. Put it back from the Removed list in Settings → Plugins.'
    )
  }
  const outcome = installPluginFolder(source, { installedIds: new Set(slots.keys()) })
  reloadPlugins()
  const slot = slots.get(outcome.id)
  if (!slot) {
    const b = broken.find((x) => x.id === outcome.id)
    // Copied fine and then would not load. The folder is left in place rather
    // than rolled back so the row explains itself and the user can remove it;
    // deleting it here would leave them with a message about a plugin that is
    // no longer anywhere, and nothing to act on.
    throw new ManifestError(
      b?.code ?? 'load-failed',
      b?.reason ?? 'That plugin was copied in but could not be started.'
    )
  }
  notifySink?.()
  return toDto(slot)
}

/**
 * Replace a plugin's code with a folder the user chose, keeping everything else.
 *
 * WHAT CONTINUITY MEANS HERE, and why it is not "preserve the configuration".
 * Configuration was never at risk: it lives in `plugin-data/<id>` and in `setting`
 * rows, both outside the folder, and neither the swap nor `uninstallPlugin` so
 * much as opens them. What remove-and-add actually costs is that the plugin
 * VANISHES and comes back OFF — `removePlugin` writes `enabled=0` and nothing
 * turns it back on. So this exists to keep an enabled plugin enabled across a
 * code change, and that is the only state it restores.
 *
 * THE TEARDOWN COMES FIRST, and it is the same drain a disable performs. The old
 * module stays resident in `require`'s cache either way — Node has no unload —
 * but its timer must be stopped and its in-flight work aborted before its files
 * move, or a tick begun against the old tree finishes against the new one's.
 *
 * NEW CODE THAT REPORTS A BLOCKER IS LEFT OFF, with the blocker on the row. That
 * is `configure`'s rule, reused rather than reinvented: a plugin that cannot run
 * is turned off visibly instead of left on and silent.
 */
export async function updatePlugin(pluginId: string, source: string): Promise<PluginDTO> {
  const slot = slots.get(pluginId)
  const brokenEntry = slot ? undefined : broken.find((x) => (x.id ?? x.folder) === pluginId)
  if (!slot && !brokenEntry) {
    throw new ManifestError('not-installed', 'That plugin is not installed.')
  }
  // A BROKEN FOLDER whose manifest never parsed cannot be updated by id: the id
  // here is a folder name discovery could not confirm names the plugin inside it,
  // so `updatePluginFolder`'s id check would be comparing against a guess.
  if (!slot && brokenEntry?.id === null) {
    throw new ManifestError(
      'unidentified',
      'That folder is too damaged to identify, so there is nothing to update. Remove it and add the new folder instead.'
    )
  }
  if (isPluginRemoved(pluginId)) {
    throw new ManifestError(
      'removed',
      'You removed that plugin. Put it back from the Removed list in Settings → Plugins.'
    )
  }

  const wasEnabled = isEnabled(pluginId)

  if (slot) {
    // THE FLAG IS CLEARED, not just the runtime. `setPluginEnabled` returns early
    // when the stored flag already equals the value asked for, so re-enabling
    // below would no-op against a flag left at 1 and the new code would never be
    // entered — a plugin the table shows as on, doing nothing. It is also what a
    // crash between here and the re-enable should leave behind: off, and visibly
    // so, rather than on with nothing running.
    setSetting(getDb(), ENABLED_KEY(pluginId), '0')
    const drain = serialised(slot, async () => {
      try {
        await leaveEnabled(slot)
      } finally {
        slot.retired = true
      }
    })
    // Registered BEFORE the await, exactly as removal does: a reload racing this
    // teardown must treat the id as live rather than activate a second instance
    // beside the draining one.
    retiring.set(pluginId, drain.then(() => undefined, () => undefined))
    slots.delete(pluginId)
    try {
      await drain
    } catch {
      // THE UPDATE STILL HAPPENS. A plugin whose `onDisable` threw has been
      // aborted and retired; refusing to replace code because its teardown was
      // untidy would leave the user unable to install the very fix for it.
    } finally {
      retiring.delete(pluginId)
    }
  }

  try {
    updatePluginFolder(pluginId, source)
  } catch (err) {
    // NOTHING WAS REPLACED — `updatePluginFolder` puts the old tree back before
    // it throws. The plugin is loaded again and returned to the state it was in,
    // so a refused folder costs the user nothing but the message.
    reloadPlugins()
    if (wasEnabled) {
      try {
        await setPluginEnabled(pluginId, true)
      } catch {
        // Reported as the refusal below; the enable failing on unchanged code is
        // a second fault and the first one is the one the user asked about.
      }
    }
    notifySink?.()
    throw err
  }

  reloadPlugins()
  const fresh = slots.get(pluginId)
  if (!fresh) {
    const b = broken.find((x) => x.id === pluginId)
    // Copied in and would not load. The folder is LEFT IN PLACE, as it is after a
    // failed install: the row then explains itself and can be removed, whereas
    // restoring the old tree would leave a message about a plugin that is fine.
    throw new ManifestError(
      b?.code ?? 'load-failed',
      b?.reason ?? 'That plugin was copied in but could not be started.'
    )
  }
  if (wasEnabled) await setPluginEnabled(pluginId, true)
  notifySink?.()
  const after = slots.get(pluginId)
  return toDto(after ?? fresh)
}

/**
 * Disable, tear down, forget — and then either delete the folder or record that
 * it must never be loaded again.
 *
 * A PLUGIN IS A PLUGIN. There is no such thing here as a native part of the app
 * the user may not take out; what differs between an added plugin and a bundled
 * one is only what removal can physically mean. An added folder is under the
 * writable root and is deleted. A bundled folder is inside the installation, is
 * often root-owned, and is replaced wholesale by an upgrade — so it is
 * TOMBSTONED instead, and discovery skips the id from then on. Deleting it would
 * be an app rewriting its own program directory, and would in any case be undone
 * by the next update, which is the one outcome a removal may not have.
 *
 * The ORDER is the whole of the rest. `leaveEnabled` aborts the signal and AWAITS
 * the in-flight tick and every capability call before anything is deleted, so a
 * merge or a retrieval mid-flight finishes against a database that is still open
 * rather than resuming to find its own module unloaded.
 *
 * The TOMBSTONE IS WRITTEN LAST, in the `finally` after the teardown, and that
 * placement is load-bearing: written first, a crash in between would leave a
 * plugin whose `onDisable` never ran and which discovery then skips forever, so
 * whatever it had half-applied could never be finished or undone.
 *
 * The enabled FLAG is cleared FIRST, before any await, so nothing new can be
 * dispatched to a plugin that is going away — and so a plugin removed while on,
 * then restored, does not start working again the moment it comes back without
 * anyone having consented to it a second time.
 */
export async function removePlugin(pluginId: string): Promise<void> {
  const slot = slots.get(pluginId)
  const brokenEntry = slot ? undefined : broken.find((x) => (x.id ?? x.folder) === pluginId)
  const origin = slot?.entry.origin ?? brokenEntry?.origin
  if (!slot && origin === undefined) {
    throw new ManifestError('not-installed', 'That plugin is not installed.')
  }
  // THE REMOVAL LOCK, ENFORCED HERE RATHER THAN BY A MISSING BUTTON.
  //
  // A repository is a SET, and connecting to one was consent to take the set —
  // so a plugin it supplies is not the user's to take out one at a time, and the
  // next cycle would install it again in any case. A row that merely hides the
  // button would be a UI rule; this is a real one, in main, where every caller
  // passes — the same reason `uninstallPlugin` recomputes its path from the id
  // rather than trusting what it was handed.
  //
  // What the user keeps is authority over what EXECUTES: the Off toggle is
  // untouched, so this plugin can be installed, kept current and running
  // nothing. The way out is disconnecting, which releases every lock at once.
  if (isRepositorySupplied(pluginId)) {
    throw new ManifestError(
      'repository-supplied',
      'That plugin comes from the repository this app is connected to. Disconnect the repository, '
        + 'in Settings → Plugins, in order to remove it — or switch it off to stop it running.'
    )
  }
  // A BROKEN BUNDLED folder is the one thing that cannot be removed, and the
  // sentence says the actual reason rather than the old blanket refusal. Its
  // manifest never parsed, so `pluginId` here is a folder name that discovery
  // could not confirm names the plugin inside it — a tombstone written against
  // it would skip whatever folder happened to share the name, and would not
  // reliably skip this one.
  if (!slot && origin === 'bundled') {
    throw new ManifestError(
      'not-removable',
      'That plugin came with the app and is too damaged to identify, so it cannot be removed. Reinstalling the app replaces it.'
    )
  }

  setSetting(getDb(), ENABLED_KEY(pluginId), '0')
  if (slot) {
    const drain = serialised(slot, async () => {
      try {
        await leaveEnabled(slot)
      } finally {
        slot.retired = true
      }
    })
    // Registered BEFORE the await, so a reload racing this teardown treats the
    // id as live and does not activate a second instance beside the draining one.
    retiring.set(pluginId, drain.then(() => undefined, () => undefined))
    slots.delete(pluginId)
    try {
      await drain
    } catch {
      // THE REMOVAL STILL HAPPENS. A plugin whose `onDisable` threw has been
      // aborted, retired and taken out of the map; leaving the record unwritten
      // because its teardown was untidy would give the user a plugin that has
      // vanished from the pane and comes back at the next launch as though
      // nothing was asked. The exception is a stranger's and is discarded, as
      // everywhere else here.
    } finally {
      retiring.delete(pluginId)
    }
  }

  // The FOLDER NAME, not the id the manifest claimed. A broken folder is
  // identified in the pane by `id ?? folder`, but only its folder name says
  // where it actually is — and `name-mismatch` is precisely the failure where
  // the two differ, so deleting by id would leave the real directory in place
  // and the row back after a reload.
  if (origin === 'added') uninstallPlugin(brokenEntry?.folder ?? pluginId)
  else setSetting(getDb(), REMOVED_KEY(pluginId), '1')
  reloadPlugins()
  notifySink?.()
}

/**
 * Undo a removal: clear the record and load the folder again.
 *
 * ONLY EVER CLEARS A RECORD. It cannot bring back a folder that was deleted, and
 * does not pretend to — an added plugin's removal deletes its tree, so there is
 * nothing to restore and no tombstone was ever written for it. This exists
 * because the alternative to a Restore is a decision that outlives every trace
 * of what it was about: a bundled plugin the app silently refuses to load
 * forever, which no reinstall and no update can undo.
 *
 * The plugin comes back DISABLED, whatever it was before. Removing it was the
 * user withdrawing their consent, and restoring is the separate, smaller act of
 * making it available again.
 */
export async function restorePlugin(pluginId: string): Promise<void> {
  if (!isPluginRemoved(pluginId)) {
    throw new ManifestError('not-removed', 'That plugin has not been removed.')
  }
  // A restore arriving while the removal's teardown is still draining would
  // re-discover the folder and activate a second instance beside the first.
  const drain = retiring.get(pluginId)
  if (drain) await drain
  setSetting(getDb(), REMOVED_KEY(pluginId), '0')
  setSetting(getDb(), ENABLED_KEY(pluginId), '0')
  reloadPlugins()
  notifySink?.()
}

/**
 * Every loaded plugin's id and manifest version.
 *
 * For the repository cycle, which has to answer "is what is offered newer than
 * what is here" WITHOUT reading a folder itself. Read from the loaded slot
 * rather than from disk: a folder whose manifest will not parse has no version
 * this app is entitled to act on, and reporting it as absent would have the
 * repository install over it on every cycle, forever.
 */
export function installedPluginVersions(): Map<string, string> {
  const out = new Map<string, string>()
  for (const slot of slots.values()) out.set(slot.entry.manifest.id, slot.entry.manifest.version)
  return out
}

/**
 * Whether ANY plugin is part-way through a lifecycle change.
 *
 * The repository cycle is skipped entirely while this is true: it swaps a
 * plugin's tree on disk, and doing that under an enable whose `onEnable` has not
 * returned — or a disable whose teardown is still draining — is the one ordering
 * an unattended background sync must not be able to reach. It is the question
 * `pluginCapabilityVerb` asks about one plugin, asked about all of them, because
 * a cycle is addressed to no single row.
 */
export function anyPluginLifecycleBusy(): boolean {
  for (const slot of slots.values()) if (slot.lifecycleBusy > 0) return true
  return retiring.size > 0
}

/**
 * How many plugin ticks are mid-flight.
 *
 * `will-quit` in `index.ts` defers `closeDb()` while anything is working, and a
 * plugin tick is in none of the other counters it consults. A tick that resumes
 * after its inter-chunk yield on a closed connection throws from a finalized
 * statement — and the host swallows that, so the symptom is a silently
 * half-applied merge rather than anything visible.
 */
export function pluginsInFlightCount(): number {
  let n = 0
  for (const slot of slots.values()) {
    if (slot.inFlight !== null) n += 1
    n += slot.draining
    // Capability work counts for the same reason a tick does, and more sharply:
    // a retrieval writes bytes into the library and a row into the database, so
    // a `closeDb()` landing mid-call is a finalized-statement throw the host
    // swallows, leaving a half-stored document nothing reports.
    n += slot.work.size
  }
  return n
}

/** The plugin instance, for the IPC handlers that reach past the generic API. */
export function pluginById(pluginId: string): CorpusPlugin | null {
  const slot = slots.get(pluginId)
  return slot && !slot.retired ? slot.plugin : null
}

/** The ctx a non-generic handler needs. Throws before `initPluginHost()`. */
export function pluginCtx(pluginId: string): PluginCtx {
  return ctxFor(slotOrThrow(pluginId))
}

// --------------------------------------------------------- plugin-offered verbs

/**
 * Call a verb a plugin offers beyond `CorpusPlugin`.
 *
 * Looked up on the object the plugin's `activate` returned, so a folder
 * installed anywhere offers it identically. An IPC handler that instead
 * imported the function from a path could only ever reach a plugin AT that
 * path — which is not a plugin, it is a compiled-in module.
 *
 * Throws a sentence rather than a TypeError when the plugin is absent or offers
 * no such verb, because "the plugin that answers this is not installed" is a
 * thing a user can be told and a `undefined is not a function` is not.
 */
export function pluginVerb<T>(pluginId: string, verb: string): (...args: unknown[]) => T {
  const slot = slots.get(pluginId)
  if (!slot || slot.retired) {
    throw new ManifestError('not-installed', 'That feature comes from a plugin that is not installed.')
  }
  const fn = (slot.plugin as unknown as Record<string, unknown>)[verb]
  if (typeof fn !== 'function') {
    throw new ManifestError(
      'no-verb',
      'That feature comes from a plugin that does not offer it. It may be an older version.'
    )
  }
  return (fn as (...args: unknown[]) => T).bind(slot.plugin)
}

/**
 * Call a verb that ACTS, with the enabled check and the lifecycle serialised.
 *
 * `pluginVerb` alone leaves a race the read-only verbs do not have: a handler
 * resolves the plugin, the user turns it off, and the call then runs against a
 * plugin whose `onDisable` has already aborted its client and cleared its timer
 * — producing a share that exists and never syncs, the failure whose only
 * symptom is silence. The check is re-read INSIDE the lifecycle chain, so a
 * disable arriving mid-call either completes before the verb starts or waits
 * for it, rather than interleaving with it.
 *
 * Reads (`sharesFor`) deliberately do NOT come through here: what is shared is
 * in the database whether or not anything is polling, and a list that emptied
 * itself when the user switched syncing off would look like the shares had gone.
 */
export async function pluginActingVerb<T>(
  pluginId: string,
  verb: string,
  ...args: unknown[]
): Promise<T> {
  const slot = slotOrThrow(pluginId)
  return serialised(slot, async () => {
    if (!isEnabled(pluginId)) throw new Error(SHARING_OFF_SENTENCE)
    return pluginVerb<Promise<T>>(pluginId, verb)(...args)
  })
}

/**
 * Call a LONG-RUNNING verb the app reaches through a capability.
 *
 * NOT `serialised`, and that is the whole difference from `pluginActingVerb`.
 * That chain is strict FIFO over enable/disable/configure, which is right for a
 * gesture that finishes in milliseconds and wrong for these: a search runs to
 * five minutes and a retrieval to an hour, so queueing one there would leave the
 * user's Off toggle unresponsive for the duration, hold `lifecycleBusy` above
 * zero the whole time (suppressing every tick), and serialise the queue's
 * parallel retrievals against each other — work `RETRIEVAL_GATE` already paces,
 * on its own terms, one layer down.
 *
 * So the guarantees are rebuilt from the two pieces that actually matter:
 *
 *   - the enabled flag and the retirement flag are read in THIS synchronous
 *     turn, before the verb is entered, so a disable that has already committed
 *     cannot be raced past;
 *   - the promise is parked in `slot.work`, which `leaveEnabled` aborts and then
 *     awaits and `pluginsInFlightCount()` counts — so a disable arriving DURING
 *     the call cancels it through `ctx.signal` and waits for it to unwind,
 *     rather than tearing the plugin down underneath it.
 *
 * Cancellation is therefore cooperative, and the callers are built for it: the
 * retrieval stage checks `ctx.signal.aborted` both while queued for the gate and
 * while holding it.
 */
export async function pluginCapabilityVerb<T>(
  pluginId: string,
  verb: string,
  offSentence: string,
  ...args: unknown[]
): Promise<T> {
  const slot = slots.get(pluginId)
  if (!slot || slot.retired) throw new Error(offSentence)
  if (!isEnabled(pluginId)) throw new Error(offSentence)
  // THE ABORTED SIGNAL IS THE GATE, not the enabled flag alone. Two teardowns do
  // not clear that flag — `configurePluginInner` restarts the plugin with new
  // settings, and the quit path never writes settings at all — so a call
  // arriving during either would pass the check above and run against a plugin
  // that has already been torn down. It is also what makes `leaveEnabled`'s
  // drain terminate: with this, no new work can join the set it is emptying.
  if (slot.controller.signal.aborted) throw new Error(offSentence)
  // A lifecycle change is part-way through — `onEnable` may not have built the
  // plugin's client yet, or `onDisable` may already have torn it down. Refused
  // rather than run against a plugin between two configurations, which is the
  // same judgement `runTick` makes for a manual tick.
  if (slot.lifecycleBusy > 0) throw new Error(offSentence)
  const call = pluginVerb<Promise<T>>(pluginId, verb)(...args)
  // Wrapped so a plugin returning a non-promise, or throwing synchronously
  // before this line, cannot put a value into the set that `allSettled` would
  // treat as already done while the work carries on elsewhere.
  const tracked = Promise.resolve(call)
  slot.work.add(tracked)
  try {
    return await tracked
  } finally {
    slot.work.delete(tracked)
  }
}

/**
 * The signal a capability call must honour, so the app can pass it down.
 *
 * The plugin's own abort controller, which `leaveEnabled` fires. Handed to the
 * CALLER rather than left for the plugin to consult, because the work that has
 * to stop is often the app's — the search registry's per-source fetch, the
 * retrieval stage's wait for its gate — and those cannot reach into a slot.
 */
export function pluginSignal(pluginId: string): AbortSignal | null {
  const slot = slots.get(pluginId)
  return slot && !slot.retired ? slot.controller.signal : null
}

/**
 * Run a plugin's setup step, and say what happened in ONE sentence.
 *
 * Shaped like `testPluginConnection`, and for the same reasons. A throw is an
 * ANSWER — the step did not complete — rather than a failure to answer, so this
 * resolves rather than rejecting; and the thrown value is DISCARDED and replaced
 * with a sentence of ours, because a plugin's own exception carries paths, URLs
 * and sometimes credentials, and this string is rendered verbatim.
 *
 * `pluginActingVerb` rather than a bare call: this WRITES — it registers with the
 * operating system — so a disable arriving mid-call must order against it rather
 * than interleave with it.
 */
export async function runPluginSetup(
  pluginId: string,
  actionId: string
): Promise<PluginTestResultDTO> {
  const slot = slotOrThrow(pluginId)
  // CHECKED AGAINST THE LIST THE PLUGIN IS OFFERING RIGHT NOW, not against
  // whatever the renderer last drew. The button's existence and this call's
  // acceptance then derive from one read of one object, the way a capability
  // does — so an id from a stale pane, or from a renderer that made one up,
  // cannot reach a plugin as an instruction it never advertised.
  if (!pluginSetupActions(pluginId).some((a) => a.id === actionId)) {
    return { ok: false, sentence: 'That step is no longer offered.', code: null }
  }
  try {
    await pluginActingVerb<void>(pluginId, 'runSetup', ctxFor(slot), actionId)
  } catch (err) {
    // The off-sentence is OURS and is safe to show; anything else is a
    // stranger's and is not.
    const sentence =
      err instanceof Error && err.message === SHARING_OFF_SENTENCE
        ? err.message
        : 'That step could not be completed on this computer.'
    return { ok: false, sentence, code: null }
  }
  return { ok: true, sentence: 'Done. Anything still needed is listed below.', code: null }
}

/**
 * The setup buttons, from the PLUGIN, each shaped.
 *
 * EMPTY when there is no such step, or when the plugin cannot name one — and the
 * renderer draws no button for an empty list. The app has no word of its own to
 * fall back on: it does not know whether a step installs something, registers
 * something or opens a browser, and a button whose label the app invented is one
 * whose effect the user cannot predict before pressing it.
 *
 * Shaped ENTRY BY ENTRY, and an entry that fails is DROPPED rather than repaired.
 * The id is a `shapeCode` slug because the renderer keys a React key and a test
 * id on it; the label is a `shapeLabel` because it is prose on a control. Reads
 * are individually guarded: these are a stranger's getters, and one that throws
 * must cost that one button rather than the pane that lists every plugin.
 */
export function pluginSetupActions(pluginId: string): PluginSetupActionDTO[] {
  const slot = slots.get(pluginId)
  if (!slot || slot.retired) return []
  if (!capabilitiesOf(slot.plugin).includes('plugin-setup')) return []
  let raw: unknown
  try {
    raw = (slot.plugin as unknown as Record<string, () => unknown>).setupActions()
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: PluginSetupActionDTO[] = []
  const seen = new Set<string>()
  try {
    // INDEXED, not iterated. `for…of` calls the value's own `Symbol.iterator`,
    // and `Array.isArray` is true of a Proxy over an array — so iterating runs a
    // stranger's traps, outside any guard, on a path that reaches `listPlugins`.
    //
    // The bound counts entries LOOKED AT rather than entries kept, for the same
    // reason: a list whose every member is rejected must still end. Counting
    // only what was accepted let an iterator yielding rubbish forever spin
    // here — and main is synchronous, so that is the whole app stopped by a
    // folder someone dropped in.
    const limit = Math.min(raw.length, SETUP_ACTIONS_MAX_READ)
    for (let i = 0; i < limit && out.length < SETUP_ACTIONS_MAX; i += 1) {
      let id: string | null
      let label: string | null
      try {
        const entry: unknown = raw[i]
        if (typeof entry !== 'object' || entry === null) continue
        id = shapeCode((entry as { id?: unknown }).id)
        label = shapeLabel((entry as { label?: unknown }).label)
      } catch {
        continue
      }
      // BOTH or neither. A button with no word on it is the thing the app has no
      // way to name, and one with no id is a press that cannot be dispatched.
      if (id === null || label === null) continue
      // FIRST WINS. Two entries under one id are one dispatchable step, so the
      // second is a second button that silently does what the first does.
      if (seen.has(id)) continue
      seen.add(id)
      out.push({ id, label })
    }
  } catch {
    // `raw.length` is itself a read on a stranger's object. Whatever was shaped
    // before the throw stands: it is already safe, and discarding it would let a
    // hostile last entry suppress honest earlier ones.
    return out
  }
  return out
}
