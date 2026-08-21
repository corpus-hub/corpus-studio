import { useEffect, useRef } from 'react'
import { useTabVisible } from './visibility'

/**
 * Run `onChange` whenever the job queue changes in main.
 *
 * The queue advances on its own schedule — a job goes queued → running → done
 * with no request from the renderer to hang a response on — so a view that
 * shows job state can only stay truthful by being told. Main pushes a
 * payload-free `jobs:changed` signal and the listener refetches through the
 * ordinary typed IPC, which keeps ONE definition of a job DTO rather than a
 * second, push-shaped copy that could drift from it.
 *
 * Preferred over polling: a poll is either too slow to look live or wasteful
 * when the queue is idle, and "idle" is the normal state.
 *
 * The callback is held in a ref so a caller may pass an inline arrow without
 * re-subscribing on every render — a subscribe/unsubscribe cycle per render
 * would drop signals that arrive in the gap.
 *
 * **A hidden subtree does not refetch.** It records that it missed a signal and
 * fires exactly once when it is revealed, which is indistinguishable from having
 * kept up: the callbacks are refetch-everything, not deltas, so N coalesced
 * signals and one signal reach the same state. This matters because the
 * broadcast coalesces at 150ms — 6.67 signals a second — and each screen fans
 * one signal out into several queries against the single connection the ingest
 * is writing through. With ten screens mounted that measured ~107 IPC
 * round-trips a second for work the user cannot see.
 *
 * There is no provider today, so `useTabVisible()` is `true` everywhere and this
 * is a no-op; it exists so the gate is already the only path when several
 * screens can be mounted at once.
 */
export function useJobsChanged(onChange: () => void): void {
  const visible = useTabVisible()
  const missedRef = useRef(false)
  const ref = useRef(onChange)
  // Assigned in an effect rather than during render: a render that React
  // abandons (it may start one and throw it away) must not install its callback,
  // and only a committed render should decide what a live subscription calls.
  useEffect(() => {
    ref.current = onChange
  }, [onChange])

  // The subscription itself stays up while hidden. Tearing it down and
  // re-establishing it on reveal would mean the reveal has to assume it missed
  // something, so it would refetch on every switch back even when the queue had
  // been idle the whole time.
  const visibleRef = useRef(visible)
  // Assigned in an effect for the same reason the callback is: only a COMMITTED
  // render may decide what a live subscription does. A render React abandons
  // must not be able to make the listener treat a signal as missed.
  useEffect(() => {
    visibleRef.current = visible
  }, [visible])
  useEffect(() => {
    return window.api.onJobsChanged(() => {
      if (!visibleRef.current) {
        missedRef.current = true
        return
      }
      ref.current()
    })
  }, [])

  useEffect(() => {
    if (!visible || !missedRef.current) return
    missedRef.current = false
    ref.current()
  }, [visible])
}
