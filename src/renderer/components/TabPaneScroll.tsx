import { useEffect, useRef, type ReactNode } from 'react'

/**
 * Remembers WHERE a tab was scrolled to, and puts it back.
 *
 * The one piece of view state that every screen has and none of them own: the
 * scroll offset of the pane itself. It is worth restoring on its own because it
 * is what makes a suspended heavy tab come back looking like the page the user
 * left rather than the top of it, and because a tab restored from a saved
 * session otherwise reopens at the top of a list the user had scrolled through.
 *
 * Stored as a FRACTION, not a pixel offset. The window may be a different size
 * on the next launch, or on the other monitor the tab was dragged to, and a
 * pixel offset would then land somewhere unrelated — or past the end, which
 * clamps to the bottom and looks like the app lost the user's place entirely.
 */

export interface TabPaneScrollProps {
  /** The serialized snapshot this tab was last saved with. */
  viewState: string | null
  /** Store a new snapshot. Cheap and unordered — see `useTabs.setViewState`. */
  onViewState: (viewState: string) => void
  /** Whether this pane is the one on screen. */
  visible: boolean
  children: ReactNode
}

interface Snapshot {
  /** 0..1 down the scrollable height. */
  frac?: number
}

function read(raw: string | null): Snapshot {
  if (!raw) return {}
  try {
    const v: unknown = JSON.parse(raw)
    if (typeof v !== 'object' || v === null) return {}
    const frac = (v as Snapshot).frac
    return typeof frac === 'number' && frac >= 0 && frac <= 1 ? { frac } : {}
  } catch {
    // Written by an older build, or hand-edited in the session row. A snapshot
    // that cannot be read means starting at the top, which is merely the old
    // behaviour — never a failure to render.
    return {}
  }
}

export function TabPaneScroll({
  viewState,
  onViewState,
  visible,
  children
}: TabPaneScrollProps): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * Restore ONCE per mount.
   *
   * Re-applying on every change of `viewState` would fight the user: they scroll,
   * that writes a snapshot, the snapshot comes back as a prop, and the pane
   * scrolls to where it already is — or, with a push in flight, to where it was.
   */
  const restoredRef = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (restoredRef.current || !el) return
    const { frac } = read(viewState)
    if (frac === undefined) {
      restoredRef.current = true
      return
    }
    // After paint, so the content has a height to be a fraction OF. On the first
    // frame the pane is empty and every fraction of zero is zero.
    const raf = requestAnimationFrame(() => {
      const max = el.scrollHeight - el.clientHeight
      if (max > 0) el.scrollTop = frac * max
      restoredRef.current = true
    })
    return () => cancelAnimationFrame(raf)
  }, [viewState])

  // Captured on the way OUT as well as on scroll: a tab suspended by the live-set
  // policy unmounts without a final scroll event, and would come back at the top.
  useEffect(() => {
    return () => {
      // The pending debounce goes with the component. Left running it would fire
      // against a detached element after the tab was suspended, writing one more
      // snapshot for a pane that no longer exists.
      if (timer.current) clearTimeout(timer.current)
      const el = ref.current
      if (!el) return
      const max = el.scrollHeight - el.clientHeight
      if (max > 0) onViewState(JSON.stringify({ frac: el.scrollTop / max }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      ref={ref}
      className="tab-pane-scroll"
      onScroll={(e) => {
        // Only the VISIBLE pane's scroll is meaningful. A hidden pane can still
        // emit one — a layout change, a restore — and recording that would
        // overwrite the position the user actually left it at.
        if (!visible) return
        const el = e.currentTarget
        // Debounced: a scroll fires per frame, and each write is an IPC message.
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => {
          const max = el.scrollHeight - el.clientHeight
          if (max > 0) onViewState(JSON.stringify({ frac: el.scrollTop / max }))
        }, 250)
      }}
    >
      {children}
    </div>
  )
}
