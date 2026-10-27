import { useEffect, useState, useSyncExternalStore } from 'react'
import { useTabVisible } from './visibility'

/**
 * "A summary changed somewhere" — as one number every screen can depend on.
 *
 * THE PROBLEM THIS REPLACES. A summary write used to be announced by an
 * `onWritten` prop threaded from the modal to whichever screen happened to
 * render it. Ranking wired it and refreshed its row; the Paper screen never
 * passed one; the reference-tree card had no reload path at all. So the same
 * write updated one surface and left the others showing yesterday's answer
 * until the user navigated away and back. Worse, the omission was invisible: a
 * new screen that shows summaries is correct only if whoever wrote it
 * remembered to opt in, and nothing fails when they do not.
 *
 * A store inverts that. Readers subscribe; the write does not need to know who
 * is listening, and a screen added later gets the behaviour by depending on the
 * version rather than by being wired to the writer.
 *
 * WHY A NUMBER, NOT THE SUMMARIES THEMSELVES. `useSyncExternalStore` compares
 * snapshots with `Object.is`, so a `getSnapshot` that builds a fresh object or
 * Set on every call re-renders forever. `prefs.ts` sidesteps this by storing
 * primitives; the same trick works here and is better than a cache, because the
 * data every reader wants differs (one paper's prose, a whole page's
 * has-a-summary flags) and no single cached shape would serve them all. A
 * monotonic counter says only "what you have is stale", which is the entire
 * message — each listener already knows how to read what it needs.
 *
 * The counter never resets. Wrapping is not a concern at one increment per
 * deliberate user action.
 */
let version = 0
const listeners = new Set<() => void>()

function emit(): void {
  version += 1
  for (const l of listeners) l()
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

/**
 * The main-process signal, subscribed ONCE for the whole renderer.
 *
 * At module scope rather than inside the hook: every component using the hook
 * would otherwise open its own IPC listener, so a Ranking page showing fifty
 * rows would hold fifty subscriptions to a channel that fires the same
 * payload-free signal at all of them.
 *
 * Guarded because this module is imported by components that also run under the
 * screenshot harness and the test fixtures, where `window.api` may not be
 * installed yet. A missing bridge must not break the module's import — the
 * store still works for local writes, which is what a renderer-only test
 * exercises.
 */
if (typeof window !== 'undefined' && window.api?.onSummariesChanged) {
  window.api.onSummariesChanged(() => emit())
}

/**
 * Re-render when any summary is written. Returns an opaque version to be used
 * as an effect/`useAsync` dependency — its VALUE means nothing, only that it
 * changed.
 *
 * **Held still while the caller's subtree is hidden**, then advanced once on
 * reveal if it moved. The single IPC listener is not the cost — the readers are:
 * every dependent refetches, and once several screens are mounted at once a
 * write refetches all of them including the ones nobody can see. Because the
 * value carries no information beyond "you are stale", releasing one bump for
 * many is exactly equivalent to having kept up.
 */
export function useSummaryVersion(): number {
  const visible = useTabVisible()
  // Subscribed only while visible, rather than subscribed always and filtered.
  // Filtering would still re-render every mounted consumer on every write — and
  // the consumers are Ranking's fifty rows, the paper profile card and the
  // summary buttons — for a value they would then be told had not changed.
  //
  // `subscribe` is passed as `null` when hidden, which `useSyncExternalStore`
  // does not accept, so an inert subscriber that registers nothing is passed
  // instead. It must be a STABLE identity per visibility state or the store
  // would resubscribe on every render.
  const subscribeWhenVisible = visible ? subscribe : subscribeNever
  const live = useSyncExternalStore(subscribeWhenVisible, () => version, () => version)
  // While hidden `live` is frozen at whatever it was, so a write during that time
  // is invisible until the reveal re-subscribes and the fresh `getSnapshot` reads
  // the counter's real value. That is exactly the intended behaviour: the value
  // carries no information beyond "what you have is stale", so many missed bumps
  // and one bump lead the reader to the same refetch.
  return live
}

/** A subscriber that never fires, for a consumer that is not currently listening. */
function subscribeNever(): () => void {
  return () => {}
}

/**
 * Announce a write made by this renderer, without waiting for the round trip.
 *
 * Main broadcasts too, and a double bump is harmless — a reader refetches twice
 * at worst. This exists so the surface the user is looking at updates on the
 * same tick as the modal that wrote it, rather than after an IPC hop.
 */
export function notifySummaryWritten(): void {
  emit()
}

/**
 * Does THIS paper already have a general / project summary — for dimming the
 * two summary buttons.
 *
 * `undefined` UNTIL KNOWN, AND ON FAILURE. The dim means "there is nothing here
 * to read". Guessing `false` while the query is in flight, or after it threw,
 * greys a button over a summary that exists and tells the reader their work is
 * gone — a worse answer than not dimming at all. So an unknown answer renders
 * both buttons at full strength, which is merely uninformative.
 *
 * Backed by the whole-project query rather than a per-work one: it is a single
 * indexed read, and the Ranking list already pays for it, so the two surfaces
 * agree by construction.
 */
export function useSummariesWritten(
  projectId: number,
  workId: number | undefined
): { general: boolean; project: boolean } | undefined {
  const version = useSummaryVersion()
  const [have, setHave] = useState<{ general: number[]; project: number[] } | null>(null)

  useEffect(() => {
    if (workId === undefined) return
    let alive = true
    setHave(null)
    window.api
      .getWorksWithSummaries(projectId)
      .then((h) => {
        if (alive) setHave(h)
      })
      .catch(() => {
        if (alive) setHave(null)
      })
    return () => {
      alive = false
    }
  }, [projectId, workId, version])

  if (workId === undefined || have === null) return undefined
  return { general: have.general.includes(workId), project: have.project.includes(workId) }
}
