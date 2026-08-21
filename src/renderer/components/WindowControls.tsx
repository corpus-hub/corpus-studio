import { useEffect, useRef, useState, type JSX } from 'react'

/**
 * Custom window chrome for the FRAMELESS window.
 *
 * The OS title bar is gone (`frame:false` in main), so the app owns the
 * minimize / maximize-restore / close affordances. They live at the far right
 * of the TAB STRIP, which is this window's title bar — one row carrying the
 * pages, the window's grab handle and its controls, costing no extra vertical
 * space and styled purely with the app's design tokens.
 *
 * Everything here is real: the maximize icon reflects the ACTUAL window state,
 * pushed from main on `maximize`/`unmaximize`/`restore`/`resize`/fullscreen
 * transitions (main re-queries `isMaximized()` each time — nothing is cached or
 * guessed), so a WM that refuses the request cannot desync the icon.
 */
/**
 * Real maximized state of the window: seeded from main and kept in sync by the
 * pushed `window:maximizedChanged` events (main re-queries `isMaximized()` on
 * every maximize/unmaximize/restore/resize/fullscreen transition).
 */
function useMaximized(): boolean {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    let alive = true
    /**
     * Whether a PUSHED value has landed, which makes the opening query stale.
     *
     * The query and the events race, and the query is the slower of the two: on
     * launch main maximizes the window as part of `ready-to-show`, so a `false`
     * asked for before that lands can resolve after it and overwrite the `true`
     * that the push already delivered. Main then suppresses re-sends of a value
     * it has already sent, so the wrong icon survives until the NEXT genuine
     * transition — a window that is maximized offering to maximize.
     *
     * The window's state is now also changed by things the renderer never
     * initiates: double-clicking the strip's grab handle is handled entirely in
     * the browser process, as is the window manager's own keybinding. So the
     * push is the authority and the query is only a seed for the gap before the
     * first push.
     */
    let pushed = false
    // Subscribed BEFORE the query is sent, so a transition occurring while it is
    // in flight is not simply missed.
    const off = window.api.window.onMaximizedChanged((m) => {
      pushed = true
      setMaximized(m)
    })
    void window.api.window.isMaximized().then((m) => {
      if (alive && !pushed) setMaximized(m)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  return maximized
}

export function WindowControls(): JSX.Element {
  const maximized = useMaximized()

  // Fire and forget: the resulting state arrives as a pushed event like every
  // other transition, so the icon is driven by ONE source. Writing the resolved
  // value here as well would let a slow reply overwrite a newer push — the
  // window manager, or a double-click on the strip's grab handle, can change the
  // state again while this round trip is still in the air.
  const toggle = (): void => {
    void window.api.window.toggleMaximize()
  }

  return (
    <div className="win-controls" data-testid="window-controls" role="group" aria-label="Window">
      <button
        type="button"
        className="win-btn"
        data-testid="window-minimize"
        aria-label="Minimize window"
        data-tip="Minimize"
        onClick={() => void window.api.window.minimize()}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
          <path d="M2.5 6.5h7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>

      <button
        type="button"
        className="win-btn"
        data-testid="window-maximize"
        // The accessible NAME carries the state (and so does the glyph), so no
        // aria-pressed here — it would make SR announce the state twice.
        aria-label={maximized ? 'Restore window' : 'Maximize window'}
        data-tip={maximized ? 'Restore' : 'Maximize'}
        onClick={toggle}
      >
        {maximized ? (
          // Restore: two offset rectangles. The glyph AND the accessible name
          // both change, so the state is never carried by colour alone.
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
            <rect
              x="2.2"
              y="3.8"
              width="6"
              height="6"
              rx="1.2"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
            />
            <path
              d="M4.4 3.2V2.9A1.2 1.2 0 0 1 5.6 1.7h3.3A1.2 1.2 0 0 1 10.1 2.9v3.3a1.2 1.2 0 0 1-1.2 1.2h-.3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
            <rect
              x="2.2"
              y="2.2"
              width="7.6"
              height="7.6"
              rx="1.4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
            />
          </svg>
        )}
      </button>

      <button
        type="button"
        className="win-btn win-btn-close"
        data-testid="window-close"
        aria-label="Close window"
        data-tip="Close"
        onClick={() => void window.api.window.close()}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
          <path
            d="M3 3l6 6M9 3l-6 6"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  )
}

/** Edges/corners a frameless window can be resized from. */
const EDGES = [
  'n',
  's',
  'e',
  'w',
  'ne',
  'nw',
  'se',
  'sw'
] as const
type Edge = (typeof EDGES)[number]

const EDGE_LABEL: Record<Edge, string> = {
  n: 'top',
  s: 'bottom',
  e: 'right',
  w: 'left',
  ne: 'top right',
  nw: 'top left',
  se: 'bottom right',
  sw: 'bottom left'
}

/**
 * Frameless windows on X11 lose the WM-drawn resize border, so the app paints
 * its own invisible grips along every edge/corner and streams the desired
 * bounds to main (which clamps them to the window's minimum size). Grips are
 * `no-drag` so they never get swallowed by the title bar drag region, and they
 * are inert while maximized (browser screen coords are still valid then, but
 * main ignores setBounds for a maximized window).
 */
export function WindowResizeGrips(): JSX.Element | null {
  const maximized = useMaximized()
  const dragRef = useRef<{ edge: Edge; startX: number; startY: number; rect: DOMRect } | null>(null)

  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const d = dragRef.current
      if (!d) return
      const dx = e.screenX - d.startX
      const dy = e.screenY - d.startY
      let { x, y, width, height } = {
        x: d.rect.x,
        y: d.rect.y,
        width: d.rect.width,
        height: d.rect.height
      }
      if (d.edge.includes('e')) width = d.rect.width + dx
      if (d.edge.includes('s')) height = d.rect.height + dy
      if (d.edge.includes('w')) {
        x = d.rect.x + dx
        width = d.rect.width - dx
      }
      if (d.edge.includes('n')) {
        y = d.rect.y + dy
        height = d.rect.height - dy
      }
      void window.api.window.setBounds({ x, y, width, height })
    }
    const onUp = (): void => {
      dragRef.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [])

  const start = (edge: Edge) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    // screen{X,Y} of the pointer minus its position within the window gives the
    // window's on-screen origin without needing an extra IPC round-trip.
    const rect = new DOMRect(
      e.screenX - e.clientX,
      e.screenY - e.clientY,
      window.innerWidth,
      window.innerHeight
    )
    dragRef.current = { edge, startX: e.screenX, startY: e.screenY, rect }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }

  // A maximized window cannot be resized by dragging (main rejects setBounds
  // while maximized), so the grips are NOT rendered then. That also keeps them
  // off the app's 10px scrollbars and off modal backdrops in the default,
  // maximized-on-launch state.
  if (maximized) return null

  return (
    <div className="win-resize-layer" data-testid="window-resize-grips" aria-hidden="true">
      {EDGES.map((edge) => (
        <div
          key={edge}
          className={`win-resize win-resize-${edge}`}
          data-testid={`window-resize-${edge}`}
          data-edge-label={EDGE_LABEL[edge]}
          onPointerDown={start(edge)}
        />
      ))}
    </div>
  )
}
