import { useCallback, useState } from 'react'
import type { NavEntry } from '@shared/nav'

export type { NavEntry }

/**
 * Session-only back/forward history for the shell.
 *
 * An entry is the WHOLE navigation state, not just the route name: opening a
 * project changes `projectId` too, and going back to a paper inside a project
 * the user has since left must restore that project as well. Keeping them in
 * one record makes every step reversible by construction.
 *
 * Deliberately NOT persisted — history is a property of the current session,
 * and restoring someone into a half-remembered trail across restarts is worse
 * than starting them at the top.
 */
export const HISTORY_LIMIT = 100

export interface NavHistory {
  current: NavEntry
  navigate: (entry: NavEntry) => void
  back: () => void
  forward: () => void
  canGoBack: boolean
  canGoForward: boolean
}

/** Stack and cursor are ONE state value: they must never be updated apart. */
interface Stack {
  entries: NavEntry[]
  index: number
}

export function useNavHistory(initial: NavEntry): NavHistory {
  const [{ entries, index }, setStack] = useState<Stack>({
    entries: [initial],
    index: 0
  })

  const navigate = useCallback((entry: NavEntry) => {
    setStack((prev) => {
      // The forward branch is discarded on a new navigation — standard browser
      // semantics; keeping it would make "forward" jump somewhere the user
      // never went from here.
      let next = [...prev.entries.slice(0, prev.index + 1), entry]
      if (next.length > HISTORY_LIMIT) next = next.slice(next.length - HISTORY_LIMIT)
      return { entries: next, index: next.length - 1 }
    })
  }, [])

  const back = useCallback(
    () => setStack((p) => ({ ...p, index: Math.max(0, p.index - 1) })),
    []
  )
  const forward = useCallback(
    () => setStack((p) => ({ ...p, index: Math.min(p.entries.length - 1, p.index + 1) })),
    []
  )

  return {
    current: entries[index],
    navigate,
    back,
    forward,
    canGoBack: index > 0,
    canGoForward: index < entries.length - 1
  }
}
