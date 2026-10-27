import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'

/**
 * Render only the rows that are on screen, for a list whose rows are not all the
 * same height.
 *
 * WHY IT MEASURES RATHER THAN ASSUMING. The rows this exists for — the queue's
 * per-paper pipelines — disagree wildly about their own height: a plain row is a
 * single grid line, one carrying a failure grows an error paragraph and a strip
 * of actions, and any row can be expanded to a per-stage step list. So there is
 * no row height to multiply by. Every mounted row is observed, its height is
 * remembered by KEY, and rows never yet seen are estimated from the average of
 * the ones that have been. The estimate is only ever used for rows outside the
 * window, where being wrong costs a scrollbar that shifts slightly as you travel
 * — not a misplaced row.
 *
 * WHY IT DOES NOT OWN A SCROLLBAR. It windows against an ANCESTOR scroller
 * (`.tab-pane-scroll`, which also persists each tab's scroll position) rather
 * than introducing one of its own. A list with its own scrollbar nested inside
 * the page's scrollbar is the two-bars bug this app has already had once; it
 * also strips the pane's gutter and breaks the saved scroll fraction. So this
 * finds the nearest scrollable ancestor, follows it, and reports where it sits
 * inside it.
 *
 * WHAT IT COSTS. Rows outside the window are UNMOUNTED. That is the entire
 * point — it is why 200 papers cost the same as 20 — but it means anything that
 * expects every row to exist in the DOM stops working: a `document.querySelector`
 * for a row, the browser's own find-in-page, a measurement over all rows. Row
 * state must be keyed by identity rather than by DOM position, which the queue's
 * already is (everything hangs off `anchorId`). `revealKey` exists for the one
 * case that genuinely has to reach an unmounted row.
 */

export interface VirtualListProps<T> {
  /** The full list. Only a window of it is rendered. */
  items: readonly T[]
  /** Stable identity per item — the React key AND the height memo's key. */
  itemKey: (item: T) => string | number
  /** Render one item. Called only for items inside the window. */
  children: (item: T, index: number) => ReactNode
  /**
   * Height to assume for a row that has never been measured, in px. Only needs
   * to be the right order of magnitude; it is replaced by the real average as
   * soon as anything has been on screen.
   */
  estimatedHeight?: number
  /**
   * Extra rows to keep mounted above and below the window. Absorbs a fast
   * scroll: without any, a flick outruns the next paint and shows blank space.
   */
  overscan?: number
  /** Gap between rows in px, so the arithmetic matches the CSS that draws them. */
  gap?: number
  /**
   * Bring this item into view, even if it is not currently mounted.
   *
   * A row that is not rendered cannot be found by selector or scrolled to, so
   * the reveal is done here where the offsets are known. Set it to a key and the
   * list scrolls the ancestor so that row is centred; set it back to null when
   * done. Each key is honoured once, so a list that refetches on every job
   * transition cannot keep yanking the viewport back.
   */
  revealKey?: string | number | null
  className?: string
  'data-testid'?: string
}

/**
 * Below this, a reported height is treated as "not laid out yet" rather than as
 * a very short row. Any real row here is a bordered card with padding, so a box
 * of a few pixels is always a row mid-commit, never a row.
 */
const MIN_CREDIBLE_HEIGHT = 8

/** The nearest ancestor that actually scrolls, or the document scroller. */
function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let p = el?.parentElement ?? null
  while (p) {
    const o = getComputedStyle(p).overflowY
    if (o === 'auto' || o === 'scroll') return p
    p = p.parentElement
  }
  return null
}

export function VirtualList<T>({
  items,
  itemKey,
  children,
  estimatedHeight = 120,
  overscan = 6,
  gap = 0,
  revealKey = null,
  className,
  'data-testid': testid
}: VirtualListProps<T>): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const scrollerRef = useRef<HTMLElement | null>(null)
  /**
   * Measured heights, by item key — NOT by index. The queue reorders (it sorts
   * by `updated_at`, which changes as jobs run), and against an index a row
   * would inherit the height of whatever previously sat in its slot and the list
   * would twitch on every refetch.
   */
  const heights = useRef(new Map<string | number, number>()).current
  /**
   * Bumped whenever a measurement CHANGES `heights`, and used as the dependency
   * that lets the offsets below be recomputed.
   *
   * It has to be the state VALUE, not the setter. The setter's identity is
   * stable for the life of the component, so depending on it is the same as
   * depending on nothing: the offsets would be computed once and then keep
   * their first, all-estimated values however often a row was measured. That is
   * the whole bug this counter exists to avoid, and it is invisible in a list
   * whose rows happen to be near the estimate.
   */
  const [measureNonce, setMeasureNonce] = useState(0)
  const repaint = useCallback(() => setMeasureNonce((n) => n + 1), [])

  /** Window bounds, in item indices. */
  const [range, setRange] = useState({ start: 0, end: Math.min(items.length, 30) })

  /**
   * Keyed off `items` ALONE, deliberately.
   *
   * `itemKey` is nearly always written inline (`itemKey={(p) => p.key}`), which
   * is a new function on every render — so including it here would recompute
   * this on every render and quietly defeat the memo, while looking correct.
   * Requiring every caller to wrap it in `useCallback` would work until the
   * first one forgot, and the symptom would be a slow list rather than an
   * error. So the function is read through a ref and the LIST is what says the
   * keys changed, which is the thing that is actually true: the same item maps
   * to the same key, or the caller has bigger problems.
   */
  const itemKeyRef = useRef(itemKey)
  itemKeyRef.current = itemKey
  const keys = useMemo(() => items.map((it) => itemKeyRef.current(it)), [items])

  /**
   * The running total before each row, and the total height.
   *
   * Recomputed on every pass rather than kept incrementally: a prefix sum over a
   * few hundred numbers is far cheaper than one row's render, and an incremental
   * version has to be invalidated correctly on reorder, resize and refetch at
   * once — which is where this kind of code goes wrong.
   */
  const { offsets, total, average } = useMemo(() => {
    let seen = 0
    let sum = 0
    for (const k of keys) {
      const h = heights.get(k)
      if (h !== undefined) {
        sum += h
        seen += 1
      }
    }
    const avg = seen > 0 ? sum / seen : estimatedHeight
    const offs = new Array<number>(keys.length + 1)
    let acc = 0
    for (let i = 0; i < keys.length; i++) {
      offs[i] = acc
      acc += (heights.get(keys[i]) ?? avg) + gap
    }
    offs[keys.length] = acc
    return { offsets: offs, total: Math.max(0, acc - gap), average: avg }
    // `heights` is a mutable ref map, so it cannot be a dependency itself;
    // `measureNonce` is what says its contents changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, estimatedHeight, gap, measureNonce])

  /** Which rows the scroller is currently over. */
  const recompute = useCallback(() => {
    const host = hostRef.current
    const scroller = scrollerRef.current
    if (!host || !scroller) return
    // An empty list must RESET the window rather than leave the last one
    // standing: a filter that empties the list and is then refilled to the same
    // length would otherwise keep a range describing rows that are gone.
    if (keys.length === 0) {
      setRange((cur) => (cur.start === 0 && cur.end === 0 ? cur : { start: 0, end: 0 }))
      return
    }
    // Where the list starts INSIDE the scroller's content, which is not the same
    // as its offset in the page: there is a header above it that changes height
    // (the filters wrap at narrow widths, the message bar comes and goes).
    const hostTop =
      host.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
    const viewTop = scroller.scrollTop - hostTop
    const viewBottom = viewTop + scroller.clientHeight

    // Binary search the prefix sums rather than walking them: this runs on every
    // scroll frame, and a walk over a few hundred rows per frame is exactly the
    // kind of cost this component exists to remove.
    let lo = 0
    let hi = keys.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (offsets[mid + 1] <= viewTop) lo = mid + 1
      else hi = mid - 1
    }
    /*
     * `lo` is the answer, and it is read AFTER the loop rather than recorded
     * inside it. Recording it in the else branch only leaves it at 0 when no
     * probe ever takes that branch — which is precisely the case where the
     * viewport is entirely PAST the end of the list, as happens for the frame
     * between a filter shrinking the list and the scroller clamping its offset.
     * `first` then stayed 0 while the walk below ran to the end, so the window
     * became every row in the list: one synchronous render of everything, which
     * is the exact cost this component exists to avoid.
     */
    const first = Math.min(lo, keys.length - 1)
    let last = first
    while (last < keys.length && offsets[last] < viewBottom) last++

    const start = Math.max(0, first - overscan)
    const end = Math.min(keys.length, last + overscan)
    setRange((cur) => (cur.start === start && cur.end === end ? cur : { start, end }))
  }, [keys.length, offsets, overscan])

  /**
   * The CURRENT `recompute`, for the long-lived listeners below.
   *
   * They are attached once and must not capture the render that attached them:
   * `recompute` closes over `offsets` and `keys.length`, and on the first paint
   * that is an empty list. A listener holding that closure for the life of the
   * component would forever recompute against zero rows — i.e. never window
   * anything again after the first frame.
   */
  const recomputeRef = useRef(recompute)
  recomputeRef.current = recompute

  // Find the scroller once mounted, and follow it. `passive` because this never
  // calls preventDefault and a non-passive scroll listener blocks the compositor
  // — which would trade the jank this removes for a different one.
  useLayoutEffect(() => {
    const scroller = findScrollParent(hostRef.current)
    scrollerRef.current = scroller
    if (!scroller) {
      // Nothing above this scrolls, so there is no window to compute and every
      // row must be drawn — a windowed list with no scroller would hide every
      // row past the initial range behind a spacer, silently and with no error.
      setRange({ start: 0, end: items.length })
      return
    }
    const onScroll = (): void => recomputeRef.current()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    const ro = new ResizeObserver(() => recomputeRef.current())
    ro.observe(scroller)
    recomputeRef.current()
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      ro.disconnect()
    }
    // Attached ONCE. `recompute` is reached through the ref above, so this must
    // not re-run on its identity or the listeners would churn every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length])

  useLayoutEffect(() => {
    recompute()
  }, [recompute, items.length])

  /**
   * Measure what is mounted.
   *
   * A row's height is not knowable until it has been laid out, and it CHANGES
   * while mounted — expanding the step list is an animated height change, and an
   * error message rewraps when the window narrows. So each rendered row is
   * observed for as long as it is on screen, and a real change repaints the
   * spacers. Sub-pixel noise is ignored: `getBoundingClientRect` is fractional
   * and a half-pixel difference would otherwise loop measure → repaint → measure
   * forever.
   */
  const measuredRef = useRef(new Map<string | number, HTMLElement>()).current
  const observerRef = useRef<ResizeObserver | null>(null)

  /**
   * Record a height, and say so.
   *
   * Returns whether anything actually changed, because a measurement that is
   * kept but not announced is worse than one not taken: the offsets memo would
   * hold values derived from the ESTIMATE while the real height sat in the map,
   * and every row below would be placed against a number nobody believes.
   *
   * The 0.5px band is for `getBoundingClientRect`'s fractional pixels. Without
   * it a height that alternates between n and n+0.4 would repaint, remeasure and
   * repaint again for as long as the list was on screen.
   */
  const record = useCallback(
    (key: string | number, h: number): boolean => {
      /*
       * A COLLAPSED box is not a measurement.
       *
       * A row reports a height of 0 — or a few px of padding — in the frames
       * before its content exists: the commit that inserts it, a thumbnail with
       * no intrinsic size yet, a subtree still suspended. Storing that is worse
       * than storing nothing, because it is indistinguishable from a genuinely
       * short row: it drags the average every unmeasured row is estimated from,
       * and it never corrects itself for a row the user scrolls past before it
       * settles. Measured here: rows that really are 220px tall pulled the
       * average to 37px and the list claimed 10622px against a true 28713.
       *
       * Below this the estimate is the better answer, and the observer will
       * deliver a real height as soon as there is one.
       */
      if (!(h > MIN_CREDIBLE_HEIGHT)) return false
      const prev = heights.get(key)
      if (prev !== undefined && Math.abs(prev - h) <= 0.5) return false
      heights.set(key, h)
      return true
    },
    [heights]
  )

  /*
   * The observer is created in an EFFECT, not during render.
   *
   * Under StrictMode React mounts, unmounts and remounts every component to
   * surface exactly this kind of setup; an observer built during render and
   * guarded by `!== null` is disconnected by the simulated unmount and then
   * never rebuilt, because the guard sees a non-null value. Built here it is
   * torn down and recreated with the rest of the effect, which is what the
   * lifecycle is for.
   */
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      let changed = false
      for (const entry of entries) {
        const key = (entry.target as HTMLElement).dataset.vkey
        if (key === undefined) continue
        if (record(key, entry.target.getBoundingClientRect().height)) changed = true
      }
      if (changed) {
        repaint()
        recomputeRef.current()
      }
    })
    observerRef.current = ro
    // Anything already mounted when this runs — everything, on the first pass —
    // has to be picked up here, or its height would only ever be noticed if it
    // later changed.
    for (const el of measuredRef.values()) ro.observe(el)
    return () => {
      ro.disconnect()
      observerRef.current = null
    }
  }, [record, repaint, measuredRef])

  /**
   * ONE ref callback for every row, rather than one per key per render.
   *
   * A `useCallback` that takes the key and returns a closure produces a new
   * function for every row on every render, so React detaches and reattaches
   * all of them — eleven `unobserve`/`observe` pairs and eleven forced layouts
   * per render, several times a second while the queue moves. The key travels
   * on the element instead, as `data-vkey`, which the observer already reads.
   */
  const attach = useCallback(
    (el: HTMLDivElement | null): void => {
      if (el === null) return
      const key = el.dataset.vkey
      if (key === undefined) return
      measuredRef.set(key, el)
      /*
       * OBSERVED, not measured here.
       *
       * A ref callback runs during the commit, before the row has finished
       * laying out — its thumbnail has no intrinsic size yet and its text has
       * not wrapped — so `getBoundingClientRect` at this moment returns a height
       * far below the truth. Recording that number would be worse than
       * recording nothing: `record` would then treat the observer's first,
       * CORRECT measurement as a change to be applied, but only if it differed,
       * and the estimate the whole list is built from would meanwhile have been
       * poisoned by a value no row ever really had. Measured this way the
       * average came out at 46px against a true 140px, and the scrollbar claimed
       * a third of the real list.
       *
       * The observer fires immediately on `observe()` with a laid-out box, so
       * nothing is lost by waiting for it.
       */
      observerRef.current?.observe(el)
    },
    [measuredRef]
  )

  /**
   * Reveal a row that may be outside the window.
   *
   * Two passes on purpose. The first scrolls to where the row is ESTIMATED to
   * be, which mounts it; once mounted it is measured, and the second pass
   * corrects to where it actually is. Doing it in one pass lands near the row
   * but not on it, by however much the estimate was wrong.
   */
  const revealedRef = useRef<string | number | null>(null)
  const offsetsRef = useRef(offsets)
  offsetsRef.current = offsets
  const keysRef = useRef(keys)
  keysRef.current = keys
  useEffect(() => {
    // Cleared when the caller withdraws the request, so the SAME row can be
    // revealed again later. Held forever, importing the same paper twice
    // scrolled to it the first time and did nothing the second.
    if (revealKey === null || revealKey === undefined) {
      revealedRef.current = null
      return
    }
    if (revealedRef.current === revealKey) return
    const scroller = scrollerRef.current
    const host = hostRef.current
    if (!scroller || !host) return
    const idx = keysRef.current.indexOf(revealKey)
    if (idx < 0) return
    revealedRef.current = revealKey
    const hostTop =
      host.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
    const target = hostTop + offsetsRef.current[idx] - scroller.clientHeight / 2
    scroller.scrollTo({ top: Math.max(0, target), behavior: 'smooth' })
    const raf = requestAnimationFrame(() => {
      const el = measuredRef.get(revealKey)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
    return () => cancelAnimationFrame(raf)
    // Keyed on the REQUEST alone. `keys` and `offsets` are read through refs
    // because including them re-ran this on every measurement, and the cleanup
    // then cancelled the correcting frame before it could run — leaving the
    // reveal permanently on its first, estimated guess.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealKey, measuredRef])

  const start = Math.min(range.start, Math.max(0, keys.length - 1))
  const end = Math.min(range.end, keys.length)
  const padTop = keys.length === 0 ? 0 : offsets[start]
  /*
   * The gap AFTER the last rendered row belongs to the spacer, not to the rows.
   *
   * `offsets[end]` is the position where row `end` would START, so it counts the
   * separation that follows row `end - 1`. In the DOM that separation does not
   * exist: the margin only falls BETWEEN two rendered rows, so the last one has
   * none. Subtracting it from the spacer instead keeps the rendered total equal
   * to `total` for every window — otherwise the list ran one gap short of what
   * the scrollbar promised, and every row below the window sat 9px off.
   */
  const tailGap = end > start && end < keys.length ? gap : 0
  const padBottom = Math.max(
    0,
    total - (keys.length === 0 ? 0 : offsets[end]) + tailGap
  )

  return (
    <div ref={hostRef} className={className} data-testid={testid}>
      {/* Spacers stand in for the rows that are not rendered, so the scrollbar
          describes the whole list rather than the handful in view. Height only —
          they are never a layout parent, so nothing inside a row resolves
          against them. */}
      <div style={{ height: padTop }} aria-hidden />
      {items.slice(start, end).map((item, i) => {
        const key = keys[start + i]
        return (
          <div key={key} ref={attach} data-vkey={key}>
            {children(item, start + i)}
          </div>
        )
      })}
      <div style={{ height: padBottom }} aria-hidden />
    </div>
  )
}
