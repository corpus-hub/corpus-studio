import { TabModel } from './tabs'

/**
 * The process's single `TabModel`, and the seam that keeps `src/main/ipc/registry`
 * loadable without Electron.
 *
 * The registry directory is deliberately importable in a plain Node process — that
 * property is what lets `registry.sweep.ts` check every entry — so a registry
 * entry may not reach `BrowserWindow`. It calls in here; `index.ts` supplies the
 * function that actually sends over IPC. Neither half has to know about the other.
 *
 * The model is created eagerly with a no-op sender, so an entry invoked before
 * `setTabPush` runs reads a consistent (empty) model rather than throwing. A push
 * that goes nowhere in that window is harmless: nothing is listening yet, and the
 * first `tabs:state` a renderer asks for is the truth regardless.
 */
let pushImpl: (windowId: number) => void = () => {}

const model = new TabModel((windowId) => pushImpl(windowId))

export function getTabModel(): TabModel {
  return model
}

/**
 * The model, with `windowId` guaranteed tracked.
 *
 * Every `tabs:*` entry goes through this rather than `getTabModel()` directly,
 * because a window can legitimately be alive and untracked: `render-process-gone`
 * re-homes its tabs but does not destroy the window, so a renderer that crashed
 * and reloaded sends its first `tabs:state` into a model that has forgotten it —
 * and the model throws on an unknown window rather than inventing state, which is
 * right for every other caller. Re-seeding here is the ONE place that decision is
 * made, so no entry can forget to make it.
 */
export function tabModelFor(windowId: number): TabModel {
  if (!model.tracks(windowId)) {
    model.register(windowId, { route: { name: 'projects' }, projectId: null, title: 'Projects' })
  }
  return model
}

/** Wire the model's change notification to real IPC. Called once from `index.ts`. */
export function setTabPush(fn: (windowId: number) => void): void {
  pushImpl = fn
}

/**
 * Open a new window holding one tab dragged out of another.
 *
 * A second seam, for the same reason as `setTabPush`: this needs
 * `new BrowserWindow` and a display, and the registry directory must stay
 * loadable in a plain Node process so `registry.sweep.ts` can check every entry.
 *
 * Refuses by default. An unimplemented detach that silently succeeded would
 * take the tab out of the strip and put it nowhere.
 */
let detachImpl: (fromWindowId: number, key: string, screenX: number, screenY: number) => boolean =
  () => false

export function setDetachHandler(fn: typeof detachImpl): void {
  detachImpl = fn
}

export function detachTab(
  fromWindowId: number,
  key: string,
  screenX: number,
  screenY: number
): boolean {
  return detachImpl(fromWindowId, key, screenX, screenY)
}

/**
 * The promise each newly-created window is waiting on.
 *
 * Held in MAIN, keyed by window id, and never sent to a renderer. That is the
 * whole point: `tabs:adopt` takes no arguments, so a window claims a tab by
 * BEING the window that was promised one rather than by naming it — and the
 * nonce means a window that merely inherited a recycled id cannot answer a
 * promise made to its predecessor.
 */
const pendingAdoptions = new Map<number, number>()

export function notePendingAdoption(windowId: number, nonce: number): void {
  pendingAdoptions.set(windowId, nonce)
}

/**
 * The nonce this window may adopt with, consumed on read.
 *
 * Once only: every window calls `tabs:adopt` at startup, and a renderer that
 * reloads calls it again. A second successful adoption would move a second tab
 * into a window that was promised one.
 */
export function takePendingAdoption(windowId: number): number | null {
  const nonce = pendingAdoptions.get(windowId)
  if (nonce === undefined) return null
  pendingAdoptions.delete(windowId)
  return nonce
}

/** Forget a promise whose window has gone, so the map cannot grow. */
export function dropPendingAdoption(windowId: number): void {
  pendingAdoptions.delete(windowId)
}
