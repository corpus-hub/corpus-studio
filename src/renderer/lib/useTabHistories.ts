import { useCallback, useMemo, useState } from 'react'
import type { NavEntry } from '@shared/nav'

/**
 * Back/forward history, one stack PER TAB, held in one place.
 *
 * Why not a `useNavHistory` inside each pane, which would be the obvious shape:
 * the back and forward buttons are window chrome. They sit in the topbar, above
 * the panes, and they have to drive whichever tab is active. A hook inside the
 * pane puts its state below the thing that needs to read it, and there is no
 * legal way to call a hook once per tab from above — the count changes as tabs
 * open and close. So the stacks live together, addressed by tab key.
 *
 * Session-only, like the single-shell history it replaces: restoring someone
 * into a half-remembered trail across restarts is worse than starting them at
 * the page they were on.
 */

/**
 * Entries kept per tab.
 *
 * Down from the shell's 100 because there are now up to two dozen of these at
 * once. A hundred each would retain thousands of entries, every one pinning a
 * `projectId` and a route the user left long ago, for a depth no one walks back
 * through. Thirty is past the point anyone reaches by hand.
 */
export const TAB_HISTORY_LIMIT = 30

interface Stack {
  /** Stack and cursor are ONE value: they must never be updated apart. */
  entries: NavEntry[]
  index: number
}

export interface TabHistory {
  current: NavEntry | null
  canGoBack: boolean
  canGoForward: boolean
}

export interface TabHistories {
  /** The entry a tab is showing, or null if it has no stack yet. */
  get: (key: string) => TabHistory
  /** Seed a tab's stack, once. A tab that already has one is left alone. */
  ensure: (key: string, initial: NavEntry) => void
  navigate: (key: string, entry: NavEntry) => void
  back: (key: string) => void
  forward: (key: string) => void
  /** Drop the stacks of tabs that no longer exist. */
  prune: (liveKeys: readonly string[]) => void
}

const NO_HISTORY: TabHistory = { current: null, canGoBack: false, canGoForward: false }

export function useTabHistories(): TabHistories {
  const [stacks, setStacks] = useState<Record<string, Stack>>({})

  const ensure = useCallback((key: string, initial: NavEntry) => {
    setStacks((prev) =>
      // Re-seeding a live stack would silently throw away the trail the user
      // walked inside that tab, and this runs on every render of the pane.
      prev[key] ? prev : { ...prev, [key]: { entries: [initial], index: 0 } }
    )
  }, [])

  const navigate = useCallback((key: string, entry: NavEntry) => {
    setStacks((prev) => {
      const cur = prev[key] ?? { entries: [], index: -1 }
      // The forward branch is discarded, as in every browser: keeping it would
      // make "forward" jump somewhere the user never went from here.
      let entries = [...cur.entries.slice(0, cur.index + 1), entry]
      if (entries.length > TAB_HISTORY_LIMIT) {
        entries = entries.slice(entries.length - TAB_HISTORY_LIMIT)
      }
      return { ...prev, [key]: { entries, index: entries.length - 1 } }
    })
  }, [])

  const step = useCallback((key: string, delta: number) => {
    setStacks((prev) => {
      const cur = prev[key]
      if (!cur) return prev
      const index = Math.min(cur.entries.length - 1, Math.max(0, cur.index + delta))
      // No new object when nothing moved: at either end of the stack this fires
      // on every keypress, and a fresh record would re-render every pane.
      if (index === cur.index) return prev
      return { ...prev, [key]: { ...cur, index } }
    })
  }, [])

  const back = useCallback((key: string) => step(key, -1), [step])
  const forward = useCallback((key: string) => step(key, 1), [step])

  const prune = useCallback((liveKeys: readonly string[]) => {
    setStacks((prev) => {
      const live = new Set(liveKeys)
      const keys = Object.keys(prev)
      if (keys.every((k) => live.has(k))) return prev
      const next: Record<string, Stack> = {}
      for (const k of keys) if (live.has(k)) next[k] = prev[k]
      return next
    })
  }, [])

  const get = useCallback(
    (key: string): TabHistory => {
      const s = stacks[key]
      if (!s) return NO_HISTORY
      return {
        current: s.entries[s.index] ?? null,
        canGoBack: s.index > 0,
        canGoForward: s.index < s.entries.length - 1
      }
    },
    [stacks]
  )

  return useMemo(
    () => ({ get, ensure, navigate, back, forward, prune }),
    [get, ensure, navigate, back, forward, prune]
  )
}
