/**
 * How much analysis work is in progress RIGHT NOW, across every source.
 *
 * The job queue is not the only thing that runs the LLM pipeline: `analysis:run`,
 * `ingest:run` and `dossier:build` await it directly inside their IPC handlers,
 * so `JobQueue.inFlightCount()` reads 0 while those are mid-flight. The quit
 * guard asks "is a paper being read right now", and answering that with the
 * queue alone would wave the user straight through a close that discards the
 * analysis they are watching.
 *
 * Counted, not booleaned: several can overlap.
 */
let active = 0
/**
 * How much of `active` each window is responsible for.
 *
 * Needed because closing ONE window of several is not a quit: the work keeps
 * running behind the remaining windows and nothing is lost. But work the CLOSING
 * window started is a different matter — it is what that window's user is
 * watching, and it has to be possible to ask "is this window's work at risk"
 * rather than only "is anything running anywhere".
 *
 * Keyed by window id, with a bucket for work that has no window: the job queue
 * runs on its own schedule and an MCP tool has no window at all, so that work
 * belongs to the app and is at risk only when the app itself is going.
 */
const byWindow = new Map<number, number>()
const listeners = new Set<() => void>()

function announce(): void {
  for (const l of listeners) {
    try {
      l()
    } catch {
      /* a listener failure must never break analysis work */
    }
  }
}

/**
 * Run `fn` while counted as busy. The count is released on both outcomes.
 *
 * `windowId` attributes the work to the window that asked for it, so closing that
 * one window can warn about it. Omitted for work no window owns — a queue job, an
 * MCP tool call — which is at risk only when the app itself quits.
 */
export async function trackBusy<T>(fn: () => Promise<T>, windowId?: number | null): Promise<T> {
  active++
  if (windowId != null) byWindow.set(windowId, (byWindow.get(windowId) ?? 0) + 1)
  announce()
  try {
    return await fn()
  } finally {
    active--
    if (windowId != null) {
      const left = (byWindow.get(windowId) ?? 1) - 1
      // Deleted at zero rather than left as a 0, so `forgetWindow` is not the
      // only thing keeping this map from growing once per window ever opened.
      if (left > 0) byWindow.set(windowId, left)
      else byWindow.delete(windowId)
    }
    announce()
  }
}

/** How many direct (non-queue) analyses are in progress. */
export function busyCount(): number {
  return active
}

/** How many of those a specific window asked for. */
export function busyCountForWindow(windowId: number): number {
  return byWindow.get(windowId) ?? 0
}

/**
 * Drop a closed window's attribution.
 *
 * The in-flight work itself is NOT cancelled — it has no cancellation point and
 * abandoning it mid-analysis is precisely what this module exists to prevent. It
 * simply stops being anyone's, which is correct: the window that was watching it
 * is gone.
 */
export function forgetWindow(windowId: number): void {
  byWindow.delete(windowId)
}

/** Subscribe to busy-count changes; returns an unsubscribe. */
export function onBusyChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
