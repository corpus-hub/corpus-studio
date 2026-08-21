import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { TabDTO } from '@shared/contract'

/**
 * The row of open pages.
 *
 * Deliberately NOT a `role="tablist"`. A tab here is a whole application screen
 * with its own navigation history, its own project and its own scroll position —
 * not a panel switcher over one document. Announcing it as a tablist would
 * promise a screen-reader user a relationship (this tablist controls that
 * tabpanel) that does not exist, and would put the arrow-key semantics of a
 * radio group on a control where Left/Right must not change what is on screen
 * without an explicit press. It is a LIST of buttons with `aria-current`, which
 * is what it actually is, plus a live region because `aria-current` changing is
 * silent.
 */

export interface TabStripProps {
  tabs: TabDTO[]
  activeKey: string
  onActivate: (key: string) => void
  onClose: (key: string) => void
  onReorder: (keys: string[]) => void
  /**
   * Whether a tab is doing work the user should be told about.
   *
   * Asked rather than read off the tab, because "busy" is a fact about the job
   * queue, not about the tab model — main would otherwise have to push a tab
   * change every time a job ticked.
   */
  busyKeys?: ReadonlySet<string>
  failedKeys?: ReadonlySet<string>
  /** Keys also open in ANOTHER window. The one hint rule 0.6 admits here. */
  alsoElsewhere?: ReadonlySet<string>
  /** A tab dragged clean out of the strip, to open in a new window. */
  onDetach?: (key: string, screenX: number, screenY: number) => void
  /** How many more windows may still be opened; 0 disables detach. */
  detachBudget?: number
  /** Open a fresh tab. Its destination is the host's decision, not the strip's. */
  onNewTab?: () => void
  /**
   * Why a new tab cannot be opened, or undefined when it can.
   *
   * A reason rather than a boolean, because a control that is disabled must SAY
   * why (hard rule 0.5) — and on a fresh install, where there are no projects
   * yet, "why" is the whole of what the user needs to know.
   */
  newTabDisabledReason?: string
  /**
   * Chrome at the far right of the strip's row — the window's min/max/close.
   *
   * Passed in rather than rendered here because the strip must not know what a
   * window is: it is a list of pages, and a second window's strip, a test
   * harness or a future embedded view can hand it something else or nothing.
   * Whatever is passed sits in a `no-drag` island (see `.tabstrip-trailing`).
   */
  trailing?: React.ReactNode
}

/**
 * How far BELOW the strip a pointer must travel before a drag becomes a detach.
 *
 * Generous, and one-directional. The strip's row is 34px tall, so a threshold
 * that a brisk horizontal reorder can cross by accident would hand the user a
 * new window they did not ask for — and there is no undo for that.
 */
const DETACH_THRESHOLD_PX = 120

interface DragState {
  key: string
  /** Where in the list the dragged tab currently sits. */
  index: number
  /** Pointer offset within the tab, so it does not jump to the cursor. */
  grabDx: number
  /** True once the pointer has travelled far enough to count as a drag. */
  moved: boolean
  /** True while the pointer is far enough outside the strip to detach. */
  outside: boolean
}

/** The pointer travel below which a press is a click, not a drag. */
const DRAG_SLOP_PX = 4

export function TabStrip({
  tabs,
  activeKey,
  onActivate,
  onClose,
  onReorder,
  busyKeys,
  failedKeys,
  alsoElsewhere,
  onDetach,
  detachBudget = 0,
  onNewTab,
  newTabDisabledReason,
  trailing
}: TabStripProps): JSX.Element {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  /** Which end(s) have content scrolled out of view, for the fade masks. */
  const [overflow, setOverflow] = useState<{ left: boolean; right: boolean }>({
    left: false,
    right: false
  })
  /**
   * The tab the keyboard is on, which is NOT necessarily the active one.
   *
   * A roving tabindex: the strip is one tab stop, and Left/Right move focus
   * within it without switching the page. Making arrow keys switch pages would
   * mean a user tabbing through the app could not pass the strip without
   * loading every screen in it.
   */
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')

  /**
   * The tab that holds the strip's single tab stop.
   *
   * Resolved rather than stored, so it can never name a tab that has gone. A
   * stored `focusKey` pointing at a closed tab left EVERY tab at `tabIndex=-1`,
   * which drops the whole strip out of the keyboard tab order — the user's Tab
   * key simply skips past their open pages with nothing to indicate why.
   */
  const rovingKey =
    (focusKey !== null && tabs.some((t) => t.key === focusKey) ? focusKey : null) ??
    (tabs.some((t) => t.key === activeKey) ? activeKey : (tabs[0]?.key ?? null))

  const measure = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    const max = el.scrollWidth - el.clientWidth
    setOverflow({
      // A 1px tolerance: fractional layout leaves scrollLeft a hair off zero at
      // rest, and a fade that never fully clears reads as a rendering fault.
      left: el.scrollLeft > 1,
      right: el.scrollLeft < max - 1
    })
  }, [])

  useLayoutEffect(measure, [measure, tabs])
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [measure])

  // Wheel over the strip scrolls it HORIZONTALLY. A 38px row has no vertical
  // travel, so a vertical wheel there does nothing at all by default — the
  // gesture the user reaches for first is the one that appears broken.
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      // The larger axis wins, so a trackpad's genuine horizontal swipe is passed
      // through untouched rather than being re-derived from its smaller deltaY.
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
      if (delta === 0) return
      // Only when there is somewhere to go: preventing default on a strip that
      // cannot scroll would swallow the wheel from the page behind it.
      if (el.scrollWidth <= el.clientWidth) return
      e.preventDefault()
      el.scrollLeft += delta
    }
    // Not passive: the whole point is to preventDefault.
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Keep the active tab in view. It can be scrolled out by another window moving
  // a tab in, by a close collapsing the row, or by Ctrl+Tab landing past the
  // edge — in none of which did the user scroll it away themselves.
  const firstScrollRef = useRef(true)
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-tab-key="${cssEscape(activeKey)}"]`)
    if (!el) return
    // Reduced motion is honoured here in JS because `scrollIntoView`'s behaviour
    // is an argument, not a style — the CSS branch cannot reach it.
    const reduced =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollIntoView({
      // Instant on the FIRST pass only: animating a scroll the user never asked
      // for, before they have even seen the strip, is motion with no referent.
      behavior: firstScrollRef.current || reduced ? 'auto' : 'smooth',
      block: 'nearest',
      inline: 'nearest'
    })
    firstScrollRef.current = false
  }, [activeKey, tabs.length])

  // `aria-current` changing is silent, so a keyboard or screen-reader user gets
  // no confirmation that their Ctrl+Tab did anything. Politely announced.
  useEffect(() => {
    const i = tabs.findIndex((t) => t.key === activeKey)
    if (i < 0) return
    setAnnouncement(`${tabs[i].title}, tab ${i + 1} of ${tabs.length}`)
  }, [activeKey, tabs])

  const dragRef = useRef<DragState | null>(null)
  dragRef.current = drag
  /**
   * The CURRENT tab list, readable from a handler that outlives its render.
   *
   * A drag spans an arbitrary amount of time, during which another window can
   * move a tab in and a close can land. The drop must be computed against what
   * is on screen when the pointer is released, not against what was on screen
   * when it went down.
   */
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs

  const startDrag = useCallback(
    (e: React.PointerEvent, key: string, index: number) => {
      // Left button only: a middle-click is a close and a right-click is a menu.
      if (e.button !== 0) return
      const el = e.currentTarget as HTMLElement
      const rect = el.getBoundingClientRect()
      const startX = e.clientX
      const startY = e.clientY
      const next: DragState = {
        key,
        index,
        grabDx: startX - rect.left,
        moved: false,
        outside: false
      }
      setDrag(next)
      dragRef.current = next

      const stripRect = () => scrollerRef.current?.getBoundingClientRect() ?? null

      const onMove = (ev: PointerEvent): void => {
        const cur = dragRef.current
        if (!cur) return
        const dx = ev.clientX - startX
        const dy = ev.clientY - startY
        // Below the slop this is still a click. Committing to a drag on the
        // first stray pixel makes a tab impossible to activate on a trackpad.
        if (!cur.moved && Math.abs(dx) < DRAG_SLOP_PX && Math.abs(dy) < DRAG_SLOP_PX) return

        const r = stripRect()
        // DOWNWARD only, and far. Detaching upward would fight the window's own
        // title-bar region, and — more importantly — a fast horizontal reorder
        // on a trackpad easily overshoots a 34px row by 70px vertically, so a
        // symmetric threshold turned ordinary reordering into an accidental new
        // window. Pulling a tab decisively DOWN into the page is a gesture
        // nobody makes while shuffling the strip.
        const outside = r !== null && ev.clientY > r.bottom + DETACH_THRESHOLD_PX

        // Reordering happens against what the pointer is OVER, not against
        // accumulated deltas: the tabs have different widths, so integrating a
        // delta would drift away from the row the user can see.
        let index = cur.index
        if (!outside) {
          // Queried by `[data-tab-key]` rather than taken as the list's
          // children: the new-tab button is a list item too, and counting it
          // would let a tab be dropped past the end of the tabs — an index the
          // reorder then rejects, so the drag would simply do nothing.
          const items = [
            ...(listRef.current?.querySelectorAll<HTMLElement>('[data-tab-key]') ?? [])
          ]
          index = items.length - 1
          for (let i = 0; i < items.length; i++) {
            const b = items[i].getBoundingClientRect()
            if (ev.clientX < b.left + b.width / 2) {
              index = i
              break
            }
          }
        }
        const updated = { ...cur, moved: true, outside, index }
        dragRef.current = updated
        setDrag(updated)
      }

      /**
       * ONE teardown, called from every exit path.
       *
       * Written once rather than repeated per handler because the version that
       * repeated it leaked: `onUp` removed three of the four listeners and left
       * `keydown` attached, so every click on a tab — not every drag, every
       * CLICK — added a permanent window listener holding that render's whole
       * tab array. Escape then ran all of them.
       */
      const teardown = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onCancel)
        window.removeEventListener('keydown', onKey)
        window.removeEventListener('blur', onCancel)
        dragRef.current = null
        setDrag(null)
      }

      const onUp = (ev: PointerEvent): void => {
        const cur = dragRef.current
        teardown()
        if (!cur) return
        if (!cur.moved) {
          onActivate(key)
          return
        }
        if (cur.outside) {
          // Only when a detach is actually possible. Falling through to the
          // reorder below would take a tab the user flung away to detach and
          // silently move it two places along instead.
          //
          // And only while the tab is still HERE. A drag spans an arbitrary
          // amount of time, in which another window can rehome this tab or a
          // close can land; detaching a key this strip no longer holds would ask
          // main to move a page out of a window that is not showing it.
          const here = tabsRef.current.some((t) => t.key === key)
          if (here && onDetach && detachBudget > 0) onDetach(key, ev.screenX, ev.screenY)
          return
        }
        // Read from the LIVE tab list, not the array this handler closed over:
        // another window can rehome a tab in, or a close can land, while the
        // pointer is down. A permutation of a list that no longer exists is
        // rejected by main on length, so the drag would appear to do nothing.
        const live = tabsRef.current
        const from = live.findIndex((t) => t.key === key)
        if (from < 0 || from === cur.index) return
        const keys = live.map((t) => t.key)
        keys.splice(from, 1)
        keys.splice(Math.min(cur.index, keys.length), 0, key)
        onReorder(keys)
      }

      // Escape ABANDONS the drag rather than committing it — the standard escape
      // hatch for a gesture the user has changed their mind about mid-flight.
      // `blur` is here for the same reason: alt-tabbing away, or a native menu
      // opening, delivers NEITHER pointerup nor pointercancel, and the drag would
      // otherwise stay live so that the next press ran two move handlers at once.
      const onCancel = (): void => teardown()
      const onKey = (ev: KeyboardEvent): void => {
        if (ev.key === 'Escape') onCancel()
      }

      // Capture pins the gesture to this element, so the pointer leaving the
      // window (which is exactly what a detach drag does) still delivers moves.
      try {
        el.setPointerCapture(e.pointerId)
      } catch {
        /* Capture is an optimisation; the window listeners below are the
           mechanism, and they work without it. */
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onCancel)
      window.addEventListener('keydown', onKey)
      window.addEventListener('blur', onCancel)
    },
    [onActivate, onReorder, onDetach, detachBudget]
  )

  const onStripKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const i = tabs.findIndex((t) => t.key === rovingKey)
      if (i < 0) return
      const move = (to: number): void => {
        e.preventDefault()
        const clamped = Math.min(tabs.length - 1, Math.max(0, to))
        const key = tabs[clamped].key
        setFocusKey(key)
        listRef.current
          ?.querySelector<HTMLElement>(`[data-tab-key="${cssEscape(key)}"]`)
          ?.focus()
      }
      if (e.key === 'ArrowLeft') move(i - 1)
      else if (e.key === 'ArrowRight') move(i + 1)
      else if (e.key === 'Home') move(0)
      else if (e.key === 'End') move(tabs.length - 1)
    },
    [tabs, rovingKey]
  )

  const canClose = tabs.length > 1

  return (
    <div
      className={`tabstrip ${overflow.left ? 'is-overflow-l' : ''} ${
        overflow.right ? 'is-overflow-r' : ''
      }`}
      data-testid="tabstrip"
    >
      <div className="tabstrip-scroller" ref={scrollerRef} onScroll={measure}>
        <ul className="tabstrip-list" ref={listRef} onKeyDown={onStripKeyDown}>
          {tabs.map((t, i) => {
            const selected = t.key === activeKey
            const dragging = drag?.moved === true && drag.key === t.key
            const busy = busyKeys?.has(t.key) === true
            const failed = failedKeys?.has(t.key) === true
            const elsewhere = alsoElsewhere?.has(t.key) === true
            const stale = typeof t.stale === 'string'
            // Promised to a window that is still opening. It is HELD here so the
            // move can be reverted, so it must read as leaving without reading
            // as gone — and it must not be closable.
            const leaving = t.detaching === true
            // The insertion caret sits in the GAP, never as a tint on a tab: a
            // tinted drop target and a selected tab would be the same picture.
            const caretBefore = drag?.moved === true && !drag.outside && drag.index === i
            const cls = [
              'tabstrip-tab',
              selected ? 'is-selected' : '',
              dragging ? 'is-dragging' : '',
              dragging && drag?.outside ? 'is-detaching' : '',
              // Busy is carried by the MARK alone, not by a tint on the tab: the
              // accent already means "this is the one you selected", and tinting
              // a working tab made it look chosen — and, beside a failure's red,
              // like a warning.
              failed ? 'is-failed' : '',
              stale ? 'is-stale' : '',
              leaving ? 'is-leaving' : '',
            ]
              .filter(Boolean)
              .join(' ')
            return (
              // The caret marks the GAP, so it belongs on the item — the
              // positioned box — rather than on the tab inside it.
              <li
                key={t.key}
                className={`tabstrip-item ${caretBefore ? 'is-caret-before' : ''}`}
              >
                <div
                  className={cls}
                  data-tab-key={t.key}
                  data-testid={`tab-${t.key}`}
                  role="button"
                  tabIndex={t.key === rovingKey ? 0 : -1}
                  aria-current={selected ? 'page' : undefined}
                  // The tip names the WHOLE title (the label is truncated) and,
                  // when there is one, the exception the badge is signalling.
                  // The tip names the whole title (the label truncates) and the
                  // exception, if there is one. "Also open in another window" is
                  // told HERE rather than by a mark: the user is not required to
                  // do anything about it, so under rule 0.6 it does not earn a
                  // dot on the row — but it is worth knowing when they ask.
                  data-tip={
                    stale
                      ? `${t.title}\n${t.stale}`
                      : elsewhere
                        ? `${t.title}\nAlso open in another window`
                        : t.title
                  }
                  // A tab already promised to another window must not be picked
                  // up again: a second gesture on it would either promise it
                  // twice or reorder a tab that is on its way out.
                  onPointerDown={(e) => {
                    if (leaving) return
                    startDrag(e, t.key, i)
                  }}
                  onFocus={() => setFocusKey(t.key)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onActivate(t.key)
                      return
                    }
                    // Delete closes the focused tab. The close BUTTON is
                    // deliberately out of the tab order — putting it there would
                    // make Tab alternate tab, close, tab, close across the whole
                    // strip — so without this a keyboard user has no way to
                    // close anything but the active tab (Ctrl+W).
                    if ((e.key === 'Delete' || e.key === 'Backspace') && canClose && !leaving) {
                      e.preventDefault()
                      onClose(t.key)
                    }
                  }}
                  onAuxClick={(e) => {
                    // Middle-click closes, as in every browser.
                    if (e.button === 1 && canClose && !leaving) {
                      e.preventDefault()
                      onClose(t.key)
                    }
                  }}
                >
                  {/* The exceptions, and only the exceptions (rule 0.6): there
                      is no badge for a tab that is simply open and fine. */}
                  {failed ? (
                    <span className="tabstrip-mark is-failed" aria-hidden="true" />
                  ) : busy ? (
                    <span className="tabstrip-mark is-busy" aria-hidden="true" />
                  ) : null}
                  <span className="tabstrip-label">{t.title}</span>
                  <button
                    type="button"
                    className="tabstrip-close"
                    tabIndex={-1}
                    aria-label={`Close ${t.title}`}
                    data-tip={
                      leaving
                        ? 'Moving to a new window…'
                        : canClose
                          ? 'Close'
                          : 'The last tab stays open — a window always shows something'
                    }
                    disabled={!canClose || leaving}
                    // Kept off the tab's own pointerdown, or every attempt to
                    // close would begin a drag of the tab underneath it.
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      onClose(t.key)
                    }}
                  >
                    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
                      <path
                        d="M3 3l6 6M9 3l-6 6"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </div>
              </li>
            )
          })}
          {/* The strip must never be an EMPTY row: it would collapse to nothing
              and the whole layout below it would jump, which reads as the window
              breaking rather than as its last tab having left. This holds the
              height and says NOTHING — the pane below is already explaining what
              happened, in the house empty-state card, and saying it twice in one
              window makes the reader check whether they are two different
              messages. */}
          {tabs.length === 0 && <li className="tabstrip-item tabstrip-spacer" aria-hidden="true" />}
          {onNewTab && (
            <li className="tabstrip-item">
              <button
                type="button"
                className="tabstrip-new"
                data-testid="tab-new"
                aria-label="New tab"
                // Disabled must EXPLAIN itself, never merely fail to respond —
                // and on a fresh install, with no projects yet, the explanation
                // is the only thing standing between the user and a dead button.
                data-tip={newTabDisabledReason ?? 'New tab'}
                disabled={newTabDisabledReason !== undefined}
                onClick={onNewTab}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                  <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
            </li>
          )}
        </ul>
      </div>

      {/* THE WINDOW'S GRAB HANDLE.
          A sibling of the scroller, never its ancestor: a `-webkit-app-region:
          drag` ancestor is subtracted rectangle by rectangle for each `no-drag`
          descendant, which leaves the GAPS between tabs draggable — a comb the
          user cannot reliably grab or click — and swallows the wheel the strip
          needs for horizontal scrolling. As a sibling it owns a solid rectangle
          and nothing inside the scroller has to opt out of anything.

          It has a MINIMUM width and the scroller yields to it, so a strip full
          enough to overflow still leaves a handle. The alternative — letting the
          tabs consume the row — takes the window's only grab surface away at
          exactly the moment the user has the most open and is most likely to
          want to move the window.

          Double-click to maximize is NOT wired here. On a drag region the
          browser process hit-tests to HTCAPTION and handles the gesture itself
          (toggling maximize, or whatever the desktop's own titlebar action is
          set to); the renderer never sees the click. A JS handler would either
          be dead code or, if it did fire, toggle a second time and undo the
          native one. */}
      <div className="tabstrip-drag" data-testid="tabstrip-drag" aria-hidden="true" />

      {trailing !== undefined && (
        // ONE `no-drag` island around the whole group rather than one per
        // button: the drag region is a union of rectangles with no notion of the
        // gaps between them, so opting the buttons out individually leaves the
        // 2px between them draggable and the pointer crossing that sliver fires
        // a spurious leave on the button it just left.
        <div className="tabstrip-trailing">{trailing}</div>
      )}

      {/* Says what the gesture is ABOUT to do, before it does it.
          Without this the only feedback was the tab's own dimming — 120px away
          from where the user is looking, at the moment they are looking at the
          cursor — and detaching has no undo. It also names Escape, which is the
          only way out and is otherwise undiscoverable. */}
      {drag?.moved === true && drag.outside && (
        <div className="tabstrip-detach-hint" role="status" data-testid="tab-detach-hint">
          Release to open in a new window · Esc to cancel
        </div>
      )}
      <div className="tabstrip-live" role="status" aria-live="polite">
        {announcement}
      </div>
    </div>
  )
}

/**
 * A tab key, safe to put inside an attribute selector.
 *
 * Keys carry `:` and `#`, both of which are selector syntax, so an unescaped key
 * silently matches nothing — which would make scroll-into-view and roving focus
 * quietly stop working rather than fail.
 */
function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`)
}
