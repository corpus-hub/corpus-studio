import { useCallback, useEffect, useRef, useState } from 'react'
import type { Route } from '@shared/nav'
import type { TabDTO, WindowTabsDTO } from '@shared/contract'

/**
 * The renderer's MIRROR of the window→tabs model main owns.
 *
 * "Mirror" is the whole design and the reason this is a hook rather than a piece
 * of state: it is never written locally. Every mutation goes to main, main
 * decides, and the answer arrives back either as a push or as the rev on the
 * op's own result. Optimistic local mutation would be wrong here in a way it is
 * not in most UIs — a tab can be moved into this window by ANOTHER window, so
 * the renderer is not the only writer and cannot predict the next state even for
 * its own actions.
 *
 * Every rejection is a RESYNC, never a retry. A retry would loop against a
 * disagreement it cannot resolve; re-reading is the only thing that ends it.
 */

export interface TabsMirror {
  /** Null only before the first read has landed — a window always has tabs. */
  state: WindowTabsDTO | null
  tabs: TabDTO[]
  activeKey: string
  active: TabDTO | null
  /** Re-read from main. Safe to call at any time; the last read wins. */
  resync: () => void
  open: (route: Route, projectId: number | null, opts?: OpenOpts) => Promise<void>
  activate: (key: string) => Promise<void>
  close: (key: string) => Promise<void>
  reorder: (keys: string[]) => Promise<void>
  setViewState: (key: string, viewState: string | null) => void
  /** Drag a tab out into a new window at the given SCREEN coordinates. */
  detach: (key: string, screenX: number, screenY: number) => Promise<void>
}

export interface OpenOpts {
  title?: string
  /** Ctrl/Cmd-click: a second tab on the same page, deliberately. */
  forceNew?: boolean
  viewState?: string | null
}

const EMPTY: TabDTO[] = []

export function useTabs(): TabsMirror {
  const [state, setState] = useState<WindowTabsDTO | null>(null)
  /**
   * The read generation, so a slow answer cannot overwrite a newer one.
   *
   * Reads are fired from a push, from a rejection and from mount, and IPC does
   * not promise they resolve in order. Without this a stale read landing late
   * would install an older model and the next op would be rejected against it —
   * a resync that causes the very desync it exists to fix.
   */
  const genRef = useRef(0)
  /**
   * The live rev, readable synchronously.
   *
   * `state` cannot be used for this: an op fired from an event handler would see
   * the rev from the render it was created in, which a push arriving in between
   * has already superseded, and the op would be rejected on arrival every time.
   */
  const revRef = useRef(0)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  /**
   * Advance the known rev, NEVER rewind it.
   *
   * Op results and state reads both carry a rev, and they can land in any
   * order — an op that resolves late would otherwise write back a rev the model
   * has already moved past, and the next op would be rejected against a version
   * that no longer exists. Revs only ever increase in main, so taking the
   * maximum is both safe and sufficient.
   */
  const noteRev = useCallback((rev: number) => {
    if (rev > revRef.current) revRef.current = rev
  }, [])

  const resync = useCallback(() => {
    const gen = ++genRef.current
    void window.api
      .tabsState()
      .then((s) => {
        // Dropped if a newer read has been issued, or if the component has gone.
        if (!aliveRef.current || gen !== genRef.current || !s) return
        noteRev(s.rev)
        setState(s)
      })
      .catch(() => {
        /* The push that follows any real change will bring us back into step;
           there is nothing useful to show the user about a failed mirror read. */
      })
  }, [noteRev])

  useEffect(() => {
    resync()
    return window.api.onTabsChanged(resync)
  }, [resync])

  const open = useCallback(
    async (route: Route, projectId: number | null, opts: OpenOpts = {}) => {
      const res = await window.api.tabsOpen({
        route,
        projectId,
        title: opts.title,
        forceNew: opts.forceNew,
        viewState: opts.viewState,
        expectedRev: revRef.current
      })
      if (!res) {
        resync()
        return
      }
      // Every result carries the AUTHORITATIVE rev, and taking it here is what
      // makes rapid input work at all. Without it the renderer only learns the
      // new rev via the `tabs:changed` round trip, so a second op fired inside
      // that window still carries the rev the first one superseded and is
      // rejected — holding Ctrl+Tab dropped roughly every other press, which
      // reads as a dead keyboard rather than as a race.
      noteRev(res.rev)
      // A null key means REJECTED — a stale rev, or a route main refused. The
      // mirror is behind, so read the truth rather than sending the same op
      // again into the same disagreement.
      if (res.key === null) resync()
    },
    [resync, noteRev]
  )

  const op = useCallback(
    async (run: () => Promise<{ ok: boolean; rev: number }>) => {
      const res = await run()
      noteRev(res.rev)
      if (!res.ok) resync()
    },
    [resync, noteRev]
  )

  const activate = useCallback(
    (key: string) =>
      op(() => window.api.tabsActivate({ key, expectedRev: revRef.current })),
    [op]
  )
  const close = useCallback(
    (key: string) => op(() => window.api.tabsClose({ key, expectedRev: revRef.current })),
    [op]
  )
  const reorder = useCallback(
    (keys: string[]) => op(() => window.api.tabsReorder({ keys, expectedRev: revRef.current })),
    [op]
  )

  const setViewState = useCallback((key: string, viewState: string | null) => {
    // Deliberately NOT awaited and NOT rev-checked. A view snapshot is written
    // on scroll and on typing, so making it an ordered op would put a rejection
    // path on the hottest interaction in the app; and it carries no rev in main
    // either, precisely so storing it cannot invalidate a real op in flight.
    void window.api.tabsSetViewState({ key, viewState }).catch(() => {})
  }, [])

  const detach = useCallback(
    async (key: string, screenX: number, screenY: number) => {
      const ok = await window.api.tabsDetach({
        key,
        // Rounded because main validates integers: a fractional coordinate from
        // a scaled display would be refused by the schema, and the drag would
        // read as having done nothing.
        screenX: Math.round(screenX),
        screenY: Math.round(screenY)
      })
      // Either way the model moved — the tab is now marked as leaving, or the
      // detach was refused (the window cap, the rate limit) and it is not.
      if (!ok) resync()
    },
    [resync]
  )

  // Claim the tab this window was opened to receive, if it was opened for one.
  //
  // Fired ONCE, as soon as this renderer is live. It names no key: main knows
  // what it promised this window, and asking the renderer to name it would mean
  // getting the key into the renderer first — which under `contextIsolation` and
  // `sandbox` means another channel, and would let a window claim a page it was
  // told about rather than one it was promised.
  //
  // A window that was NOT created by a detach simply gets `false` and carries on;
  // this is the whole cost of the handshake for the ordinary case.
  const adoptedRef = useRef(false)
  useEffect(() => {
    if (adoptedRef.current) return
    adoptedRef.current = true
    void window.api.tabsAdopt().then((ok) => {
      // The tab arrived, so what this window holds is no longer what it read at
      // startup. Nothing else would tell it: the push for the adopting window is
      // sent as part of the same op it is still awaiting.
      if (ok) resync()
    })
  }, [resync])

  const tabs = state?.tabs ?? EMPTY
  const activeKey = state?.activeKey ?? ''
  return {
    state,
    tabs,
    activeKey,
    active: tabs.find((t) => t.key === activeKey) ?? null,
    resync,
    open,
    activate,
    close,
    reorder,
    setViewState,
    detach
  }
}
