// KEEPING THE PROVIDER SELECTION TRUE WHILE THE APP RUNS.
//
// The pre-flight in `select.ts` is a snapshot, and it used to be taken exactly
// once — at startup, plus whenever the user saved a gateway setting. An app
// launched during an outage therefore showed "no model" and refused every
// analysis for the rest of the session, long after the network came back. The
// user's only remedy was to relaunch, which nothing in the UI told them, and
// the pill they were looking at is the one thing that could have.
//
// So the selection is re-resolved on a timer. What makes that affordable rather
// than chatty is that it is ASYMMETRIC, in the same spirit as the pill itself:
//
//   DOWN  → probe often (RETRY_MS). The user is blocked, and the whole point is
//           to notice the recovery within a few seconds of it happening.
//   LIVE  → probe rarely (CONFIRM_MS), and only to catch a gateway that went
//           away or a credential that lapsed while nothing was running.
//
// A probe is a single HTTP GET to a health route the gateway serves for exactly
// this purpose, so the frequent case is also the cheap one.
//
// It never runs two probes at once and it never runs while the window is
// hidden: a machine asleep for a weekend must not wake to a backlog of them.

import { selectProvider } from './select'
import { getLlmSelection, setLlmSelection } from './current'

/** While no model can be reached. Short: the user is waiting on this. */
const RETRY_MS = 15_000
/** While one can. Long: this is a liveness check, not a poll for work. */
const CONFIRM_MS = 5 * 60_000

let timer: ReturnType<typeof setTimeout> | null = null
let probing = false
let stopped = false

/**
 * Re-resolve the provider NOW, out of turn.
 *
 * For the moments where waiting for the next tick would read as the app
 * ignoring the user: a window regaining focus after they went and fixed
 * something, and the explicit "check again" on the indicator.
 *
 * Returns whether a model can now be reached, so a caller with a button can
 * say. Concurrent calls collapse onto the in-flight probe rather than queueing:
 * a user clicking twice must not open a second socket.
 */
export async function refreshLlmSelection(): Promise<boolean> {
  if (probing) return getLlmSelection()?.live ?? false
  probing = true
  try {
    const next = await selectProvider()
    const prev = getLlmSelection()
    // Set UNCONDITIONALLY, even when `live` has not flipped. The reason string
    // carries the token's remaining minutes and which health field was unhappy,
    // and a selection kept because the boolean matched would show a countdown
    // frozen at whatever it read an hour ago.
    setLlmSelection(next)
    if (prev?.live !== next.live) {
      // eslint-disable-next-line no-console
      console.log(
        `[main] LLM provider now ${next.live ? 'LIVE' : 'UNAVAILABLE'} — ${next.reason}`
      )
    }
    return next.live
  } catch (err) {
    // A THROW HERE LEAVES THE PREVIOUS SELECTION IN PLACE, deliberately.
    // `selectProvider` returns an unavailable selection for every condition it
    // can describe; reaching this branch means the pre-flight itself broke, and
    // replacing a working provider on the strength of a bug in the checker
    // would take the model away from a user whose gateway is fine.
    // eslint-disable-next-line no-console
    console.warn('[main] LLM pre-flight could not be re-run:', err)
    return getLlmSelection()?.live ?? false
  } finally {
    probing = false
  }
}

function schedule(): void {
  if (stopped) return
  if (timer) clearTimeout(timer)
  const live = getLlmSelection()?.live ?? false
  timer = setTimeout(() => {
    void refreshLlmSelection().finally(schedule)
  }, live ? CONFIRM_MS : RETRY_MS)
  // Node keeps the process alive for a pending timer; this one must never be
  // the reason a quit hangs.
  timer.unref?.()
}

/**
 * Begin watching. Call once, AFTER the first selection has been resolved — the
 * interval it picks depends on what that selection said.
 */
export function startLlmWatch(): void {
  stopped = false
  schedule()
}

/** Stop watching, for shutdown. */
export function stopLlmWatch(): void {
  stopped = true
  if (timer) clearTimeout(timer)
  timer = null
}
