// A post-commit notification for analysis runs.
//
// `runPipeline` announces here AFTER its supersede-then-insert transaction has
// committed. Subscribers (currently the Obsidian auto-mirror) react to a run
// that is definitely durable — never to one that a rollback then erased.
//
// It exists so the pipeline does not import the outlets. The dependency would be
// backwards: the pipeline is the core of the app and outlets are an optional
// edge, and a failing vault write must never be able to break analysis. The
// dispatcher below therefore also SWALLOWS subscriber errors (recording them
// where the outlet's own panel will show them) rather than letting a mirror
// failure propagate into the queue as a failed analysis.

export interface AnalysisCommitted {
  workId: number
  projectId: number
  analysisRunId: number
  analysisType: string
}

type Subscriber = (event: AnalysisCommitted) => void | Promise<void>

const subscribers = new Set<Subscriber>()

/** Register a post-commit subscriber. Returns an unsubscribe function. */
export function onAnalysisCommitted(fn: Subscriber): () => void {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

/**
 * Announce a committed run.
 *
 * Fire-and-forget by design: analysis must not wait on, or fail because of, a
 * mirror. Errors are reported to `onError` (which records them against the
 * outlet) and never rethrown.
 */
export function emitAnalysisCommitted(
  event: AnalysisCommitted,
  onError: (err: unknown) => void = () => undefined
): void {
  for (const fn of subscribers) {
    try {
      const result = fn(event)
      if (result instanceof Promise) result.catch(onError)
    } catch (err) {
      onError(err)
    }
  }
}

/** Drop every subscriber. For tests, so one spec cannot leak into the next. */
export function clearAnalysisSubscribers(): void {
  subscribers.clear()
}
