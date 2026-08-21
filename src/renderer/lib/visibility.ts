import { createContext, useContext, useEffect, useRef, useState } from 'react'

/**
 * A `window` event listener that is only attached while the caller is visible.
 *
 * THE reason this exists: several screens bind a global shortcut — Paper's
 * Ctrl+F, Papers' Ctrl+K, the Connectome's and Ranking's and References' own
 * keys — by reaching past React to `window`. With one screen mounted that is
 * fine and it is how those shortcuts were written. With a tab per screen, every
 * mounted screen's handler is on the same `window`, so ONE keypress runs all of
 * them: the user presses Ctrl+F to search the paper they are reading and focus
 * lands in a find box belonging to a tab that is not on screen, four screens
 * deep. Nothing about that is recoverable by the user, and nothing about it is
 * visible either — the keystroke simply appears to do the wrong thing.
 *
 * Gating on visibility makes the invisible tabs' handlers not exist, which is
 * the only formulation that is correct no matter how many are mounted or in what
 * order they registered.
 */
export function useVisibleWindowListener<K extends keyof WindowEventMap>(
  type: K,
  handler: (ev: WindowEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions
): void {
  const visible = useTabVisible()
  // The handler is held in a ref so a caller may pass an inline arrow — which
  // every one of these call sites does — without detaching and reattaching the
  // listener on every render. A reattach is not merely wasteful here: it changes
  // the listener's ORDER relative to other handlers on `window` each time.
  const ref = useRef(handler)
  useEffect(() => {
    ref.current = handler
  }, [handler])
  // Options are captured once too, for the same reason: an object literal is a
  // new identity per render and would restart the effect forever.
  const optsRef = useRef(options)
  useEffect(() => {
    if (!visible) return
    const listener = (ev: Event): void => ref.current(ev as WindowEventMap[K])
    window.addEventListener(type, listener, optsRef.current)
    return () => window.removeEventListener(type, listener, optsRef.current)
  }, [visible, type])
}

/**
 * Whether the subtree the caller is in is the one the user is looking at.
 *
 * Once several screens are mounted at once, "is this component on screen" stops
 * being answerable from React state alone — a screen can be fully mounted, fully
 * subscribed and fully invisible. Every live cost a screen carries (a poll, a
 * clock, a refetch on a pushed signal) has to be able to ask.
 *
 * The default is `true`, deliberately: a screen rendered OUTSIDE any provider —
 * which is every screen today, and the screenshot harness, and the tests — is by
 * definition the only thing on screen, so nothing changes for it. A provider
 * narrowing this is what makes the saving, and it can only ever narrow.
 */
const TabVisibilityContext = createContext<boolean>(true)

export const TabVisibilityProvider = TabVisibilityContext.Provider

/**
 * Is this WINDOW on screen at all?
 *
 * Distinct from being the active tab, and both are required. A minimised or
 * fully-occluded window's active tab is still "visible" as far as React is
 * concerned, so with several windows open the hidden ones went on refetching on
 * every `jobs:changed` — during an ingest that is ~6.7 signals a second, times
 * a handful of queries per screen, times every window, all against the single
 * SQLite connection the queue is writing through, for pixels nobody can see.
 *
 * `document.visibilityState` is what Chromium reports for a minimised or hidden
 * window, and it needs no new IPC to observe.
 */
function useWindowVisible(): boolean {
  const [visible, setVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden'
  )
  useEffect(() => {
    const onChange = (): void => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])
  return visible
}

/**
 * Is the caller's subtree currently the visible one?
 *
 * BOTH conditions: this must be the active tab AND its window must be on screen.
 * Either alone leaves a class of invisible work running.
 */
export function useTabVisible(): boolean {
  const inTab = useContext(TabVisibilityContext)
  const inWindow = useWindowVisible()
  return inTab && inWindow
}

/**
 * `setInterval` that only runs while the caller's subtree is visible.
 *
 * A hidden screen's timer is pure waste twice over: it recomputes strings nobody
 * can read, and — for the polls that fetch — it competes for the single
 * better-sqlite3 connection the ingest pipeline is writing through. With several
 * screens mounted the polls add up while the user watches one of them.
 *
 * `periodMs <= 0` disables the timer, matching `useNow`'s existing contract for
 * a view with nothing live in it.
 *
 * Fires IMMEDIATELY on becoming visible, then on the cadence. Waiting a full
 * period first would mean a revealed screen shows whatever was true when it was
 * hidden — which for a status that has moved on is worse than not polling at
 * all, because it is a stale answer presented as a live one.
 */
export function useVisibleInterval(fn: () => void, periodMs: number): void {
  const visible = useTabVisible()
  // Held in a ref so a caller may pass an inline arrow without restarting the
  // timer on every render — a restart per render would push the next tick out
  // indefinitely and the interval would appear to never fire.
  const ref = useRef(fn)
  useEffect(() => {
    ref.current = fn
  }, [fn])
  useEffect(() => {
    if (!visible || periodMs <= 0) return
    ref.current()
    const h = setInterval(() => ref.current(), periodMs)
    return () => clearInterval(h)
  }, [visible, periodMs])
}

/**
 * A clock that ticks only while the caller's subtree is visible.
 *
 * Returns a fresh `Date.now()` on every reveal, not the value the timer last
 * wrote: a screen that was hidden for ten minutes must not come back showing
 * "2 min ago" for the ten minutes it takes the next tick to arrive.
 */
export function useVisibleNow(periodMs = 1000): number {
  const visible = useTabVisible()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!visible || periodMs <= 0) return
    setNow(Date.now())
    const h = setInterval(() => setNow(Date.now()), periodMs)
    return () => clearInterval(h)
  }, [visible, periodMs])
  return now
}
