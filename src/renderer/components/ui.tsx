import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from 'react'
import { createPortal } from 'react-dom'
import { DOSSIER_LIMIT_SENTENCE } from '@shared/contract'
import { plainText } from './RichText'

// Status/severity pill.
export function Badge({
  children,
  cls = 'muted',
  title,
  testid
}: {
  children: ReactNode
  cls?: string
  title?: string
  testid?: string
}): JSX.Element {
  return (
    <span className={`badge badge-${cls}`} data-tip={title} data-testid={testid}>
      {children}
    </span>
  )
}

export function Eyebrow({ children }: { children: ReactNode }): JSX.Element {
  return <div className="eyebrow">{children}</div>
}

/**
 * "This result did not come from your machine."
 *
 * Renders NOTHING for a `local` run: a badge on every row would be noise, and
 * the default a reader assumes — that the app computed it — is correct there.
 *
 * NEUTRAL, not a warning. A shipped run is a real model's real reading; the
 * badge exists so nobody assumes their own machine produced it, not to cast
 * doubt on it. The warning treatment belongs to claims that stand on less than
 * they appear to, which this is not.
 *
 * ONE definition, used by every surface that presents a run's output — the
 * Paper provenance block, the Review detail panel and the Extraction
 * provenance panel. It was copied between the first two, and the third simply
 * omitted it, which is how the CSV export ended up more honest than the table
 * it was exported from.
 */
export function RunOriginBadge({
  origin,
  note,
  testid
}: {
  origin: 'local' | 'shipped' | 'imported'
  note: string | null
  testid?: string
}): JSX.Element | null {
  if (origin === 'local') return null
  const shipped = origin === 'shipped'
  return (
    <span
      className="badge badge-muted run-origin-badge"
      data-testid={testid}
      data-origin={origin}
      tabIndex={0}
      aria-label={
        shipped
          ? `Precomputed and shipped with the app, not computed on this machine. ${note ?? ''}`
          : `Imported from another installation, not computed on this machine. ${note ?? ''}`
      }
      data-tip={
        note ??
        (shipped
          ? 'This analysis came bundled with the app rather than being produced on your computer. Re-run it to get a fresh one here.'
          : 'Produced by a real model on another installation and imported here.')
      }
    >
      {shipped ? 'shipped, not run here' : 'imported'}
    </span>
  )
}

/**
 * The design shows the screen title + subtitle in the TOP BAR (see App.tsx
 * `routeMeta`), NOT in the content body. So ScreenHeader now renders ONLY the
 * screen-specific action row. The `eyebrow`/`title`/`sub` props are kept
 * (optional) so every screen keeps compiling without edits; they are no longer
 * rendered in-body. When a screen passes no `actions`, nothing is rendered.
 */
export function ScreenHeader({
  actions,
  testid
}: {
  eyebrow?: string
  title?: string
  sub?: string
  actions?: ReactNode
  testid?: string
}): JSX.Element | null {
  if (!actions) return null
  return (
    <div className="screen-head" data-testid={testid}>
      <div className="screen-head-actions">{actions}</div>
    </div>
  )
}

// Click-anywhere-away popover anchored below its trigger.
export function Popover({
  trigger,
  children,
  testid
}: {
  trigger: (open: () => void, isOpen: boolean) => ReactNode
  children: ReactNode
  testid?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  return (
    <div className="popover-wrap" ref={ref}>
      {trigger(() => setOpen((v) => !v), open)}
      {open && (
        <div className="popover" data-testid={testid} role="dialog">
          {children}
        </div>
      )}
    </div>
  )
}

/**
 * Dismiss a portalled popup when the thing it is anchored to moves away.
 *
 * Shared by `Select` and `MultiSelect` so the two cannot drift apart: they sit
 * side by side on the same filter bars, and a pair of dropdowns that dismiss on
 * different events reads as two different kinds of control.
 *
 * THE SCROLL LISTENER IGNORES SCROLLS FROM INSIDE THE POPUP. It is registered in
 * the CAPTURE phase on `document` — which is required, because scroll does not
 * bubble and the trigger may sit in any one of several scroll containers — and
 * that means it also sees the popup's OWN list scrolling. `.sel-menu` is
 * `max-height: 280px; overflow-y: auto`, so any list longer than about eight
 * options scrolls, and the first wheel notch over it closed the menu instantly:
 * the longer the list, the less usable it was, which is exactly backwards. The
 * popup is positioned relative to the TRIGGER, and scrolling within the list
 * does not move the trigger, so those events are not the ones this guards
 * against.
 */
function useDismissOnAnchorMove(
  open: boolean,
  close: () => void,
  refs: { trigger: RefObject<HTMLElement>; popup: RefObject<HTMLElement> }
): void {
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node
      if (refs.trigger.current?.contains(t) || refs.popup.current?.contains(t)) return
      close()
    }
    const onScroll = (e: Event): void => {
      const t = e.target as Node | null
      // `document` itself is a legitimate scroll target (the page scrolled) and
      // is NOT inside the popup, so this only excludes the list's own scrolling.
      if (t && refs.popup.current?.contains(t)) return
      close()
    }
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('resize', close)
    document.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('resize', close)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [open, close, refs.trigger, refs.popup])
}

/**
 * Styled single-choice dropdown (WAI-ARIA listbox).
 *
 * Replaces native `<select>`: Chromium renders the OPEN option list as a native
 * OS/GTK widget that CSS cannot reach, so `select option { … }` is ignored on
 * Linux and the popup never matched the app's design. Only a custom listbox can
 * be styled.
 *
 * The popup is PORTALLED to <body> and positioned with fixed coordinates —
 * callers include the ranked-works list, which is a scroll container that would
 * otherwise clip it.
 */
export function Select<T extends string>({
  value,
  options,
  onChange,
  testid,
  ariaLabel,
  className = '',
  format,
  disabled = false,
  disabledTip
}: {
  value: T
  /** `tip` explains what choosing the option MEANS (shown by the app tooltip). */
  options: readonly { value: T; label: string; tip?: string }[]
  onChange: (value: T) => void
  testid?: string
  ariaLabel?: string
  className?: string
  /** Optional label transform for the closed trigger (e.g. "Sort: relevance"). */
  format?: (label: string) => string
  /**
   * Inert because there is nothing to choose between yet. `aria-disabled` and
   * not `disabled`, per the app's convention: a natively disabled button is
   * removed from the tab order and stops firing pointer events, which also
   * silences the tooltip — and a control that neither responds NOR says why is
   * indistinguishable from a broken one.
   */
  disabled?: boolean
  /** Why it is inert, in the user's words. Required in spirit whenever `disabled`. */
  disabledTip?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [activeIdx, setActiveIdx] = useState(0)
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  const typeahead = useRef({ buf: '', at: 0 })
  const listId = useId()

  const selectedIdx = Math.max(
    0,
    options.findIndex((o) => o.value === value)
  )
  const current = options[selectedIdx]

  // Measure AFTER paint so the popup can flip up when it would overflow the
  // viewport bottom (the status selects sit low in a long scrolling list).
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    const h = Math.min(options.length * 34 + 12, 280)
    const below = window.innerHeight - r.bottom
    const top = below < h + 8 && r.top > h + 8 ? r.top - h - 6 : r.bottom + 6
    setPos({ left: r.left, top, width: Math.max(r.width, 168) })
  }, [open, options.length])

  useEffect(() => {
    if (open) setActiveIdx(selectedIdx)
  }, [open, selectedIdx])

  // A list left open over a trigger that has since gone inert is a menu whose
  // choices no longer mean anything — the data behind it is what went away.
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  // Dismiss on outside pointerdown, scroll or resize: a fixed-position popup
  // would otherwise detach from its trigger.
  const close = useCallback(() => setOpen(false), [])
  useDismissOnAnchorMove(open, close, { trigger: btnRef, popup: listRef })

  const commit = (idx: number): void => {
    const opt = options[idx]
    if (opt) onChange(opt.value)
    setOpen(false)
    btnRef.current?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setOpen(true)
      }
      return
    }
    switch (e.key) {
      case 'Escape':
        e.preventDefault()
        setOpen(false)
        btnRef.current?.focus()
        break
      case 'ArrowDown':
        e.preventDefault()
        setActiveIdx((i) => Math.min(options.length - 1, i + 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setActiveIdx((i) => Math.max(0, i - 1))
        break
      case 'Home':
        e.preventDefault()
        setActiveIdx(0)
        break
      case 'End':
        e.preventDefault()
        setActiveIdx(options.length - 1)
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        commit(activeIdx)
        break
      case 'Tab':
        setOpen(false)
        break
      default: {
        // Typeahead: jump to the first option starting with the typed prefix.
        if (e.key.length !== 1) return
        const now = Date.now()
        const t = typeahead.current
        t.buf = now - t.at > 800 ? e.key : t.buf + e.key
        t.at = now
        const hit = options.findIndex((o) => o.label.toLowerCase().startsWith(t.buf.toLowerCase()))
        if (hit >= 0) setActiveIdx(hit)
      }
    }
  }

  const label = current ? (format ? format(current.label) : current.label) : ''

  return (
    <>
      <button
        type="button"
        ref={btnRef}
        className={`sel-trigger ${className}${disabled ? ' is-disabled' : ''}`}
        data-testid={testid}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        aria-disabled={disabled || undefined}
        data-tip={disabled ? disabledTip : undefined}
        onClick={(e) => {
          e.stopPropagation()
          if (disabled) return
          setOpen((v) => !v)
        }}
        onKeyDown={(e) => {
          if (disabled) return
          onKeyDown(e)
        }}
      >
        <span className="sel-value">{label}</span>
        <svg className="sel-caret" width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5 8l5 5 5-5" />
        </svg>
      </button>
      {open &&
        pos &&
        createPortal(
          <ul
            ref={listRef}
            id={listId}
            className="menu sel-menu"
            role="listbox"
            aria-label={ariaLabel}
            tabIndex={-1}
            style={{ left: pos.left, top: pos.top, width: pos.width }}
            onKeyDown={onKeyDown}
          >
            {options.map((o, i) => (
              <li
                key={o.value}
                role="option"
                aria-selected={o.value === value}
                className={`menu-item sel-option${i === activeIdx ? ' is-active' : ''}${
                  o.value === value ? ' is-selected' : ''
                }`}
                data-testid={testid ? `${testid}-option-${o.value}` : undefined}
                data-tip={o.tip}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={(e) => {
                  e.stopPropagation()
                  commit(i)
                }}
              >
                {o.label}
              </li>
            ))}
          </ul>,
          document.body
        )}
    </>
  )
}

/**
 * The same dropdown, but the choice is a SET.
 *
 * Shares `Select`'s trigger, portalled popup and dismissal rules on purpose: two
 * dropdowns sitting on one filter bar that open differently, sit at different
 * heights or dismiss on different events read as two different kinds of control,
 * and the user has no way to know which one they are about to get.
 *
 * EMPTY MEANS ALL, and that is the whole semantics. A filter nobody has touched
 * must not hide anything, and a filter the user has emptied by unticking the last
 * box must not show them a blank list they did not ask for — in both cases the
 * honest reading of "no restriction stated" is "no restriction".
 */
export function MultiSelect({
  picked,
  options,
  onChange,
  allLabel,
  testid,
  ariaLabel,
  className = ''
}: {
  /** Empty = unrestricted. Never a list of everything. */
  picked: ReadonlySet<string>
  /**
   * `disabled` marks an option that exists but has nothing behind it. It is
   * SHOWN rather than omitted so the absence is stated — a missing row and an
   * empty one say different things — and `disabledNote` is why, in the user's
   * words, because a greyed row that does not explain itself is just broken.
   */
  options: readonly { value: string; label: string; disabled?: boolean; disabledNote?: string }[]
  onChange: (picked: Set<string>) => void
  /** What the trigger says when nothing is restricted, e.g. "All sources". */
  allLabel: string
  testid?: string
  ariaLabel?: string
  className?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  const listId = useId()

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    const h = Math.min(options.length * 34 + 12, 280)
    const below = window.innerHeight - r.bottom
    const top = below < h + 8 && r.top > h + 8 ? r.top - h - 6 : r.bottom + 6
    setPos({ left: r.left, top, width: Math.max(r.width, 168) })
  }, [open, options.length])

  const close = useCallback(() => setOpen(false), [])
  useDismissOnAnchorMove(open, close, { trigger: btnRef, popup: listRef })

  const choosable = options.filter((o) => !o.disabled)

  const toggle = (value: string): void => {
    const next = new Set(picked)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    // Ticking every AVAILABLE box is the same statement as ticking none, and
    // storing it as a full set would make the trigger read "4 sources" about a
    // filter that filters nothing. Counted against the choosable rows only: the
    // disabled ones can never be ticked, so requiring them would make the
    // all-selected case unreachable.
    onChange(next.size === choosable.length ? new Set() : next)
  }

  const chosen = options.filter((o) => picked.has(o.value))
  const label =
    chosen.length === 0
      ? allLabel
      : chosen.length <= 2
        ? chosen.map((o) => o.label).join(', ')
        : `${chosen.length} selected`

  return (
    <>
      <button
        type="button"
        ref={btnRef}
        className={`sel-trigger ${className}${picked.size > 0 ? ' is-narrowed' : ''}`}
        data-testid={testid}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        disabled={choosable.length === 0}
        data-tip={choosable.length === 0 ? 'Nothing has been returned to narrow yet.' : undefined}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false)
          if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setOpen(true)
          }
        }}
      >
        <span className="sel-value">{label}</span>
        <svg className="sel-caret" width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5 8l5 5 5-5" />
        </svg>
      </button>
      {open &&
        pos &&
        createPortal(
          <ul
            ref={listRef}
            id={listId}
            className="menu sel-menu"
            role="listbox"
            aria-multiselectable
            aria-label={ariaLabel}
            tabIndex={-1}
            style={{ left: pos.left, top: pos.top, width: pos.width }}
          >
            {options.map((o) => {
              // A disabled row is never "on", whatever the set says: it has
              // nothing behind it, and a ticked box next to an empty index
              // would promise results that are not there.
              const on = !o.disabled && (picked.size === 0 || picked.has(o.value))
              return (
                <li
                  key={o.value}
                  role="option"
                  aria-selected={on}
                  aria-disabled={o.disabled || undefined}
                  className={`menu-item sel-option sel-option-multi${on ? ' is-selected' : ''}${
                    o.disabled ? ' is-disabled' : ''
                  }`}
                  data-testid={testid ? `${testid}-option-${o.value}` : undefined}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (o.disabled) return
                    toggle(o.value)
                  }}
                >
                  <span className={`sel-tick${on ? ' is-on' : ''}`} aria-hidden="true">
                    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M2.5 6.2l2.4 2.4L9.5 3.9" />
                    </svg>
                  </span>
                  <span className="sel-option-label">{o.label}</span>
                  {o.disabled && o.disabledNote && (
                    <span className="sel-option-note">{o.disabledNote}</span>
                  )}
                </li>
              )
            })}
          </ul>,
          document.body
        )}
    </>
  )
}

// Modal dialog (used by wizards / confirms / Settings). Adds accessibility that
// every caller inherits: Esc closes, an aria-label from the title, initial
// focus moved into the dialog, and a Tab focus trap that keeps focus within the
// dialog while open. All additive — existing callers keep their markup.
export function Modal({
  title,
  onClose,
  children,
  testid,
  initialFocusRef,
  hideDismiss = false,
  role = 'dialog'
}: {
  title: string
  onClose: () => void
  children: ReactNode
  testid?: string
  /**
   * Element to focus on open, instead of the first focusable one.
   *
   * The first focusable is the header's ✕, which is the right default for a
   * modal you are reading. It is the wrong one for a modal that ASKS something:
   * there the safe answer should be under the user's finger, and pressing Enter
   * out of habit must not be the destructive choice.
   */
  initialFocusRef?: RefObject<HTMLElement>
  /**
   * Hide the header's ✕ and make the backdrop inert.
   *
   * For a modal that asks a question, a bare ✕ is ambiguous — in the close
   * prompt it sits next to three explicit answers and reads as a fourth one.
   * Escape still dismisses, so the modal is never a trap.
   */
  hideDismiss?: boolean
  /** `alertdialog` for a modal that interrupts to ask something. */
  role?: 'dialog' | 'alertdialog'
}): JSX.Element {
  const dialogRef = useRef<HTMLDivElement | null>(null)

  /**
   * Whatever had focus when the dialog OPENED — almost always the control the
   * user pressed to open it. Focus is returned there on close; without that it
   * falls to `<body>`, and a keyboard user who opened a dialog from row 34 of a
   * list is put back at the top of the document with no way to resume.
   *
   * Captured in its OWN mount-only effect, and this is load-bearing. The main
   * effect below depends on `onClose`, and almost every call site passes an
   * inline arrow — so it re-runs on each parent render. Capturing there would
   * re-read `document.activeElement` while the dialog already holds focus,
   * recording an element INSIDE the dialog; on close that node is detached, the
   * `isConnected` guard rejects it, and focus lands on `<body>` after all. The
   * close-guard modal is the extreme case: it re-renders on a live elapsed-time
   * tick, so it would re-capture several times a second.
   */
  const openerRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    openerRef.current = document.activeElement as HTMLElement | null
    return () => {
      const opener = openerRef.current
      // `isConnected`: the opener may itself have been removed while the dialog
      // was up (a row deleted, a list reloaded), and focusing a detached node
      // silently sends focus to `<body>` anyway.
      if (opener && opener.isConnected) opener.focus()
    }
  }, [])

  useEffect(() => {
    const dialog = dialogRef.current
    // Move focus into the dialog (first focusable, else the dialog itself).
    const focusables = (): HTMLElement[] =>
      dialog
        ? Array.from(
            dialog.querySelectorAll<HTMLElement>(
              'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
            )
          )
        : []
    const first = initialFocusRef?.current ?? focusables()[0]
    if (first) first.focus()
    else dialog?.focus()

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key === 'Tab') {
        const items = focusables()
        if (items.length === 0) {
          e.preventDefault()
          dialog?.focus()
          return
        }
        const firstEl = items[0]
        const lastEl = items[items.length - 1]
        const active = document.activeElement as HTMLElement | null
        if (e.shiftKey && active === firstEl) {
          e.preventDefault()
          lastEl.focus()
        } else if (!e.shiftKey && active === lastEl) {
          e.preventDefault()
          firstEl.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, initialFocusRef])

  // PORTALLED TO `<body>`, like the popovers above and for the same reason.
  // `position: fixed` resolves against the nearest ancestor that establishes a
  // containing block — any `transform`, `filter`, `contain` or `will-change` on
  // a parent does that — so rendered in place the backdrop covered only the
  // panel it was opened from and the dialog was clipped by that panel's
  // `overflow`. The References tree is exactly such a parent, and its abstract
  // opened as a half-visible card over a shaded strip.
  //
  // At `<body>` there is no ancestor to resolve against, so one rule covers the
  // window whichever screen opened the dialog.
  return createPortal(
    <div className="modal-backdrop" onMouseDown={hideDismiss ? undefined : onClose}>
      <div
        className="modal"
        data-testid={testid}
        role={role}
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={dialogRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div className="card-title">{title}</div>
          {!hideDismiss && (
            <button className="btn-icon" onClick={onClose} aria-label="Close">
              ✕
            </button>
          )}
        </div>
        {children}
      </div>
    </div>,
    document.body
  )
}

// Filter chip row.
export function ChipRow({
  options,
  value,
  onChange,
  testid
}: {
  options: { key: string; label: string; count?: number }[]
  value: string
  onChange: (k: string) => void
  testid?: string
}): JSX.Element {
  return (
    <div className="chip-row" data-testid={testid}>
      {options.map((o) => (
        <button
          key={o.key}
          className={`chip ${o.key === value ? 'chip-active' : ''}`}
          onClick={() => onChange(o.key)}
          data-testid={`chip-${o.key}`}
        >
          {o.label}
          {o.count !== undefined && <span className="chip-count">{o.count}</span>}
        </button>
      ))}
    </div>
  )
}

/**
 * Place a floating card at the pointer, flipping it back over the cursor when
 * it would otherwise run off the right/bottom edge of the window. Without this
 * a card spawned near the edge is half off-screen — the fixed positioning that
 * frees it from a canvas clip also removes any container to bump against.
 *
 * THE CARD MUST BE PORTALLED TO `<body>`. `position: fixed` resolves against
 * the nearest ancestor carrying a transform/filter/perspective, NOT the
 * viewport — and both `.screen` and `.cg-grid` run keyframes that set
 * `transform`. That silently makes them the containing block, so viewport
 * coordinates get re-based against their origin and every card appears offset
 * down and to the right of the cursor. Shared here because BOTH charts hit this
 * (the connectome first, then the ranking frontier map) and a second copy would
 * mean fixing it twice.
 */
export function cardStyle(
  x: number,
  y: number,
  w: number,
  h: number
): { left: number; top: number; transform: string } {
  const GAP = 14
  const flipX = x + GAP + w > window.innerWidth - 8
  const flipY = y + GAP + h > window.innerHeight - 8
  return {
    left: x,
    top: y,
    transform: `translate(${flipX ? `calc(-100% - ${GAP}px)` : `${GAP}px`}, ${
      flipY ? `calc(-100% - ${GAP}px)` : `${GAP}px`
    })`
  }
}

/**
 * A labelled on/off switch, in the app's one switch idiom.
 *
 * Lifted out of Settings so the References tree and the Connectome use the SAME
 * control, states and animation rather than each growing a lookalike. The
 * visual language is unchanged (`settings-switch`): a track, a knob that slides,
 * and — crucially — the state as a WORD, so it never rests on colour or knob
 * position alone.
 *
 * `onWord`/`offWord` are the state, not the action: the button is a switch, so
 * it reports what IS, and `aria-checked` carries the same fact to assistive
 * tech. The words are hidden from it to avoid a spoken name like "Unknown
 * papers Shown", which no voice-control user would say.
 */
export function SwitchField({
  label,
  on,
  onWord,
  offWord,
  tip,
  testid,
  onToggle
}: {
  /** What the switch governs. Rendered beside it and used as the a11y name. */
  label: string
  on: boolean
  onWord: string
  offWord: string
  /** Why a reader would want either position. Shown on hover/focus. */
  tip: string
  testid: string
  onToggle: (next: boolean) => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      data-tip={tip}
      data-testid={testid}
      className={`settings-switch switch-field${on ? ' is-on' : ''}`}
      onClick={() => onToggle(!on)}
    >
      <span className="settings-switch-track" aria-hidden="true">
        <span className="settings-switch-knob">{on ? '✓' : '✕'}</span>
      </span>
      <span className="switch-field-label" aria-hidden="true">
        {label}
      </span>
      <span className="settings-switch-word" aria-hidden="true">
        {on ? onWord : offWord}
      </span>
    </button>
  )
}

/**
 * Mark a paper as project background for the topic dossier.
 *
 * ONE component for every place this decision is offered (Ranking rows, the
 * Paper header) so the label, the wording and the states cannot drift apart —
 * they already had, as a bare "☆ reference" chip that read as a status badge
 * rather than as something pressable.
 *
 * The label names a DESTINATION the user can actually see — the Topic dossier
 * tab in the sidebar — rather than a mechanism. "Reference" collided with the
 * bibliography sense of the word used everywhere else in this app, and
 * "background" described an internal role that means nothing without context.
 * "Add to dossier" can be understood from a standing start.
 */
export function DossierToggle({
  on,
  title,
  testid,
  size = 'md',
  atLimit = false,
  onToggle
}: {
  on: boolean
  /** The paper's title, for the accessible name only. */
  title: string
  testid: string
  /** `sm` fits inside a dense list row; `md` stands alone in a header. */
  size?: 'sm' | 'md'
  /**
   * The project already holds `DOSSIER_PAPER_LIMIT` papers, so no more may go
   * in. Only ever blocks ADDING: a paper already in the context can always be
   * taken out, which is how the reader gets back under the limit.
   */
  atLimit?: boolean
  onToggle: (next: boolean) => void
}): JSX.Element {
  const blocked = atLimit && !on
  return (
    <button
      type="button"
      className={`btn dossier-toggle dossier-toggle-${size}${on ? ' is-on' : ''}${
        blocked ? ' is-blocked' : ''
      }`}
      data-testid={testid}
      aria-pressed={on}
      // `aria-disabled`, not `disabled`: a disabled button is removed from the
      // tab order and stops firing the hover that carries its own explanation,
      // so the one control that has something to say would say nothing.
      aria-disabled={blocked || undefined}
      data-tip={
        blocked
          ? DOSSIER_LIMIT_SENTENCE
          : on
            ? 'On: this paper’s facts are in the Project context and are treated as known when other papers are read. Press to take it out.'
            : 'Add this paper’s facts to the Project context, so they count as known when other papers are read.'
      }
      aria-label={`${on ? 'Remove from' : 'Add to'} the project context: ${plainText(title)}`}
      onClick={(e) => {
        // Rows are themselves clickable; toggling must not also open the paper.
        e.stopPropagation()
        if (blocked) return
        onToggle(!on)
      }}
    >
      <svg width="13" height="13" viewBox="0 0 20 20" aria-hidden="true"
        fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.6"
        strokeLinejoin="round">
        <path d="M10 2.6l2.3 4.7 5.2.75-3.75 3.65.9 5.15L10 14.4l-4.65 2.45.9-5.15L2.5 8.05l5.2-.75z" />
      </svg>
      {on ? 'In context' : 'Add to context'}
    </button>
  )
}
