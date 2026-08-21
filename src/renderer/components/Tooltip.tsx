import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * ONE app-wide tooltip, mounted once by the shell.
 *
 * It is DELEGATED rather than a per-call wrapper component: it listens on the
 * document and adopts any element carrying `data-tip`, so it applies everywhere
 * without a wrapper at each of the ~85 call sites.
 *
 * `data-tip` is the ONLY source. No element in the app renders a native `title`
 * attribute: native tooltips cannot be styled, sit on a ~1-2s OS-controlled
 * delay and are painted by the window manager (so they escape the app's visual
 * language). Because `data-tip` is not announced by screen readers, any element
 * whose tip carries meaning not already in its visible text also carries an
 * `aria-label`.
 */
const DELAY_MS = 500
const GAP = 8
const MARGIN = 8

interface Tip {
  text: string
  top: number
  left: number
  /** Placement, so the caret can point the right way. */
  below: boolean
  /**
   * Has the measure-then-move pass run?
   *
   * FALSE renders the tip at the left edge, where it has the whole viewport to
   * wrap in; the layout effect measures it there and sets the real `left`. The
   * flag is what stops that effect running again on its own output — it writes
   * `tip`, which is its own dependency, and without a terminator the two would
   * bounce for as long as the tip was open.
   */
  placed: boolean
  /**
   * The width measured at the left edge, PINNED for the final position.
   *
   * Measuring alone does not survive the move: a `position: fixed` box with a
   * `left` and no `right` is shrink-to-fit against whatever remains to its
   * right, so a tip placed back beside an anchor near the edge is squeezed and
   * re-wrapped exactly as before — the measurement is discarded by the very act
   * of using it. Fixing the width is what makes the measured shape the shape
   * that ships.
   */
  width: number
}

/** The element whose tip should be shown, or null. Nearest wins. */
function tipTargetOf(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null
  return node.closest<HTMLElement>('[data-tip]')
}

function tipTextOf(el: HTMLElement): string {
  return (el.dataset.tip ?? '').trim()
}

export function TooltipHost(): JSX.Element | null {
  const [tip, setTip] = useState<Tip | null>(null)
  const tipRef = useRef<HTMLDivElement | null>(null)
  const timer = useRef<number | null>(null)
  /** The element a tip is currently pending or shown for. */
  const anchor = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const clearTimer = (): void => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current)
        timer.current = null
      }
    }
    const hide = (): void => {
      clearTimer()
      anchor.current = null
      setTip(null)
    }

    const show = (el: HTMLElement): void => {
      const text = tipTextOf(el)
      if (!text) return
      const r = el.getBoundingClientRect()
      // Below by default; flip above when the viewport bottom is too close.
      // The real height is unknown until measured, so estimate conservatively
      // and correct in the layout effect below.
      const below = window.innerHeight - r.bottom > 64
      setTip({
        text,
        top: below ? r.bottom + GAP : r.top - GAP,
        left: r.left + r.width / 2,
        below,
        placed: false,
        width: 0
      })
    }

    const onOver = (e: PointerEvent): void => {
      const el = tipTargetOf(e.target)
      if (!el) {
        hide()
        return
      }
      // Moving within the same anchor must not restart the delay.
      if (anchor.current === el) return
      hide()
      anchor.current = el
      timer.current = window.setTimeout(() => show(el), DELAY_MS)
    }

    // Keyboard parity: a tip that only exists on hover is invisible to anyone
    // driving the app from the keyboard.
    const onFocus = (e: FocusEvent): void => {
      const el = tipTargetOf(e.target)
      hide()
      if (el) {
        anchor.current = el
        show(el)
      }
    }

    document.addEventListener('pointerover', onOver)
    document.addEventListener('pointerdown', hide, true)
    document.addEventListener('focusin', onFocus)
    document.addEventListener('focusout', hide)
    // A scroll or resize moves the anchor but not a fixed-position bubble.
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    window.addEventListener('blur', hide)
    return () => {
      document.removeEventListener('pointerover', onOver)
      document.removeEventListener('pointerdown', hide, true)
      document.removeEventListener('focusin', onFocus)
      document.removeEventListener('focusout', hide)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
      window.removeEventListener('blur', hide)
      clearTimer()
    }
  }, [])

  // Clamp horizontally once the real width is known, so a tip anchored near an
  // edge is not half off-screen.
  //
  // The tip is MEASURED at `left: 0` (see the style below) and only then moved
  // here. That order is the whole fix: a `position: fixed` box with a `left`
  // and no `right` is shrink-to-fit against `viewportWidth - left`, so a tip
  // anchored 45px from the right edge was laid out into 45 pixels and wrapped
  // to one word per line — "Jump / to / the / end" — before any max-width could
  // apply. Capping the width did nothing, because the constraint was never the
  // cap; it was the space the box was given to wrap in. Measured at the left
  // edge it has the whole viewport, wraps at its natural width, and is then
  // translated to sit beside its anchor.
  useEffect(() => {
    const node = tipRef.current
    if (!tip || tip.placed || !node) return
    const r = node.getBoundingClientRect()
    const half = r.width / 2
    // Centred on the anchor, then pushed back inside whichever edge it crosses.
    // Clamped rather than flipped: a tip is an annotation on its target and
    // should stay pointing at it, and at these widths sliding is always enough
    // — the only case it is not is a tip WIDER than the viewport, where every
    // placement is equally wrong and the left margin is the readable one.
    const min = MARGIN + half
    const max = Math.max(min, window.innerWidth - MARGIN - half)
    setTip({
      ...tip,
      left: Math.min(Math.max(tip.left, min), max),
      // Ceil, so the pinned box is never a sub-pixel narrower than the text it
      // was measured around — which would re-wrap the last word onto its own
      // line, the very shape this exists to prevent.
      width: Math.ceil(r.width),
      placed: true
    })
  }, [tip])

  // Re-render when the open tip's anchor rewrites its own `data-tip`, so the
  // text above is actually re-read. Nothing else would trigger it: the anchor
  // lives outside this component's tree.
  const [, bumpText] = useState(0)
  useEffect(() => {
    const el = anchor.current
    if (!tip || !el) return
    const mo = new MutationObserver(() => bumpText((n) => n + 1))
    mo.observe(el, { attributes: true, attributeFilter: ['data-tip'] })
    return () => mo.disconnect()
  }, [tip])

  if (!tip) return null
  // Read the anchor's CURRENT text, not the value captured when the tip opened:
  // a control whose label changes while it is hovered — a delete button that
  // arms into "click again to delete" — would otherwise keep describing the
  // state it has just left, which is worse than showing nothing.
  const text = anchor.current ? tipTextOf(anchor.current) || tip.text : tip.text
  return createPortal(
    <div
      ref={tipRef}
      className={`tip ${tip.below ? 'tip-below' : 'tip-above'}`}
      role="tooltip"
      data-testid="tooltip"
      style={
        tip.placed
          ? // `width` PINNED, not just `left`. See the field's own note: without
            // it the box is shrink-to-fit against the space remaining beside
            // the anchor and re-wraps to one word per line.
            { top: tip.top, left: tip.left, width: tip.width }
          : // THE MEASURING PASS. At the left edge the box has the whole
            // viewport to wrap in, so it takes its natural width instead of
            // being squeezed by however little room remains beside its anchor.
            // Hidden rather than merely transparent — `visibility` keeps it
            // out of the accessibility tree for the one frame it is misplaced,
            // so a screen reader never announces a tip from the wrong corner.
            { top: tip.top, left: 0, visibility: 'hidden' }
      }
    >
      {text}
    </div>,
    document.body
  )
}
