import { useSyncExternalStore } from 'react'

/**
 * Application preferences that are the READER's, not any one screen's.
 *
 * "Show additional provenance" is set in Settings and obeyed on the Paper
 * screen — two components that never meet in the tree. A store rather than a
 * prop chain through App: the flag has exactly ONE owner here, so the default
 * cannot drift between the writer and the reader (two `localStorage.getItem`
 * calls with different fallbacks is the classic way that happens), and every
 * subscriber re-renders the moment it changes. No restart, no re-navigation.
 *
 * `useSyncExternalStore` rather than a context provider because the value is a
 * single boolean living outside React: a provider would force the whole shell
 * to re-render to move a leaf, and would still need this module underneath it
 * to survive a page the provider does not wrap.
 */

const PROVENANCE_KEY = 'corpus.showProvenance'

function readStored(): boolean {
  try {
    return localStorage.getItem(PROVENANCE_KEY) === '1'
  } catch {
    // Storage disabled — the preference simply stops persisting. OFF is the
    // safe fallback: the caveats strip is unconditional, so nothing a reader
    // must see depends on this being on.
    return false
  }
}

let showProvenance = readStored()
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

// --------------------------------------------------------------- find mode --
/**
 * How the in-document find bar matches: literally, or by meaning.
 *
 * A reader's habit, not a screen's state. It has to survive closing the bar,
 * navigating to another paper and quitting the app, because a user who works in
 * one mode is asking a different KIND of question and being silently returned
 * to the other one costs them a query every time.
 *
 * `verbatim` is the fallback everywhere — including when storage is unreadable
 * or holds something unrecognised — because it is the mode that needs no model,
 * no vectors and no waiting, and so is the only one that is always honest.
 */
export type FindMode = 'verbatim' | 'meaning'

const FIND_MODE_KEY = 'corpus.findMode'

function readFindMode(): FindMode {
  try {
    return localStorage.getItem(FIND_MODE_KEY) === 'meaning' ? 'meaning' : 'verbatim'
  } catch {
    return 'verbatim'
  }
}

let findMode: FindMode = readFindMode()
const findModeListeners = new Set<() => void>()

function emitFindMode(): void {
  for (const l of findModeListeners) l()
}

function subscribeFindMode(onChange: () => void): () => void {
  findModeListeners.add(onChange)
  return () => {
    findModeListeners.delete(onChange)
  }
}

/**
 * A second app window (or devtools) writing a key must not leave this one
 * showing the opposite of what is stored. `storage` never fires in the tab that
 * did the write, so this only ever handles the foreign case.
 */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === null || e.key === PROVENANCE_KEY) {
      const next = readStored()
      if (next !== showProvenance) {
        showProvenance = next
        emit()
      }
    }
    if (e.key === null || e.key === FIND_MODE_KEY) {
      const next = readFindMode()
      if (next !== findMode) {
        findMode = next
        emitFindMode()
      }
    }
  })
}

// ------------------------------------------------------------- developer view
/**
 * Whether to show the pipeline's own account of itself.
 *
 * The queue can explain, per paper, exactly which stage produced nothing and
 * why. That is invaluable when something IS wrong and noise the rest of the
 * time: a scientist opening the queue wants to know whether their papers are
 * ready, not that `citation-contexts` found no bibliography in a supplement —
 * which is correct behaviour they cannot act on. Multiplied across a corpus it
 * becomes a wall of paragraphs about non-events, and a strip people learn to
 * scroll past is a strip that fails on the day it matters.
 *
 * So the explanations move behind this switch. OFF by default, because the
 * majority of users are never debugging the pipeline. It hides EXPLANATIONS
 * only — a genuine failure still shows its panel and its remedies
 * unconditionally, since that is something the user must act on.
 */
const DEV_VIEW_KEY = 'corpus.devView'

function readDevView(): boolean {
  try {
    return localStorage.getItem(DEV_VIEW_KEY) === '1'
  } catch {
    return false
  }
}

let devView = readDevView()
const devViewListeners = new Set<() => void>()

function emitDevView(): void {
  for (const l of devViewListeners) l()
}

function subscribeDevView(onChange: () => void): () => void {
  devViewListeners.add(onChange)
  return () => {
    devViewListeners.delete(onChange)
  }
}

export function setDevView(next: boolean): void {
  if (next === devView) return
  devView = next
  try {
    localStorage.setItem(DEV_VIEW_KEY, next ? '1' : '0')
  } catch {
    /* storage disabled — the preference holds for this session only */
  }
  emitDevView()
}

/** Whether the reader wants the pipeline's internal explanations shown. */
export function useDevView(): boolean {
  return useSyncExternalStore(
    subscribeDevView,
    () => devView,
    () => devView
  )
}

export function setShowProvenance(next: boolean): void {
  if (next === showProvenance) return
  showProvenance = next
  try {
    localStorage.setItem(PROVENANCE_KEY, next ? '1' : '0')
  } catch {
    /* storage disabled — the preference holds for this session only */
  }
  emit()
}

/** Whether the reader wants the full provenance block beside extracted claims. */
export function useShowProvenance(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => showProvenance,
    () => showProvenance
  )
}

export function setFindMode(next: FindMode): void {
  if (next === findMode) return
  findMode = next
  try {
    localStorage.setItem(FIND_MODE_KEY, next)
  } catch {
    /* storage disabled — the preference holds for this session only */
  }
  emitFindMode()
}

/** The mode the find bar should open in. */
export function useFindMode(): FindMode {
  return useSyncExternalStore(
    subscribeFindMode,
    () => findMode,
    () => findMode
  )
}
