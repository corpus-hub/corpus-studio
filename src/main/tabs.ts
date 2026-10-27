import { PROJECT_LEVEL_ROUTES, type Route } from '../shared/nav'
import { MAX_TAB_DUPLICATES, duplicateKey, tabKey } from '../shared/tabKey'
import type { WindowTabsDTO } from '../shared/contract'

/**
 * The authoritative window → tabs model.
 *
 * MAIN owns it, not the renderer, for three reasons that are all load-bearing:
 * windows have to be able to EXCHANGE tabs, which needs a single arbiter of who
 * holds what; a crashed window's open pages must not be lost, which is only
 * possible if something outside that renderer remembers them; and a dialog or an
 * artifact write has to resolve its parent window from the tab's CURRENT home
 * rather than from whichever window happened to send the request, because a tab
 * can move mid-invoke.
 *
 * This module is deliberately free of `electron`: it is pure state plus one
 * callback, so it can be tested directly and so the IPC layer stays the only
 * place that knows about `BrowserWindow`.
 */

/**
 * How many tabs one window may hold.
 *
 * Not a stylistic limit. Each open tab is a mounted React subtree, a per-tab
 * navigation history and a serialized view state, and the strip has to remain
 * navigable — beyond a few dozen the tabs are narrower than their own labels and
 * the user is worse off than with none. The cap evicts by least-recent use rather
 * than refusing the open, because refusing would make the click the user just
 * made appear to do nothing.
 */
export const MAX_TABS_PER_WINDOW = 24

/** The most characters a tab title may carry across IPC and into the strip. */
export const MAX_TITLE_LEN = 300

export interface TabDescriptor {
  /** Identity, from the shared `tabKey` rules. Unique within a window. */
  key: string
  route: Route
  projectId: number | null
  title: string
  /**
   * Bumped every time this tab is opened INTO rather than created.
   *
   * The renderer's focus handling is one-shot and latched on the id it focused,
   * so following "Evidence →" twice to the same span would appear dead. A
   * changing nonce is what lets those effects re-run for an unchanged id.
   */
  focusNonce: number
  /**
   * Opaque, renderer-authored snapshot: scroll, find query, sub-tab, PDF page.
   *
   * A STRING, not an object, and that is deliberate: it is bounded at the IPC edge
   * by a length the schema can actually check, and main never interprets it. An
   * `unknown` here would be a hole through which a screen could store whatever it
   * liked in the session file.
   */
  viewState?: string | null
  /**
   * Monotonic use counter, for the LRU eviction the cap needs.
   *
   * INTERNAL: `get()` projects it away, because it is not part of what a tab is —
   * it is bookkeeping about how recently the user touched one — and `WindowTabsDTO`
   * does not declare it. A field crossing IPC that the contract does not name is a
   * field the renderer may come to depend on without anything saying so.
   */
  lastUsed: number
  /**
   * Why this tab's target no longer exists, or undefined while it does.
   *
   * MARKED, never auto-closed: silently removing a page the user opened is worse
   * than showing them what happened to it.
   */
  stale?: string
  /**
   * Carried in from a window that DIED, rather than opened here.
   *
   * Ranked ahead of recency by `evict`, and deliberately so: a page from the
   * window that crashed can easily have a newer `lastUsed` than the ones the
   * user has been reading in the window that survived, so recency alone would
   * sometimes delete exactly what they are looking at in order to keep what they
   * are not. INTERNAL — projected away by `get()`, like `lastUsed`.
   */
  rescued?: boolean
  /**
   * This tab is promised to a window that is still opening. See `DetachLease`.
   *
   * While set, the tab is still HELD here — it renders greyed and is not
   * closable — so that a failure at any point in the handover reverts rather
   * than deletes.
   */
  detaching?: DetachLease
}

/**
 * How long a detached tab may sit in limbo before it is given back.
 *
 * It has to cover a cold `new BrowserWindow` through to `ready-to-show` on a
 * loaded machine, and no longer: for that whole span the tab is visibly greyed
 * in its old window and absent from the new one, so an over-generous deadline is
 * time the user spends looking at a tab they cannot use.
 */
export const DETACH_LEASE_MS = 10_000

/**
 * A tab promised to a window that does not exist yet.
 *
 * Detach cannot be one IPC. The gap between "removed from window A" and
 * "adopted by window B" spans a window construction and a page load, and if
 * EITHER window dies inside it the tab belongs to nobody — the user's page is
 * simply gone, with no error and nothing to reopen it from. So the tab STAYS in
 * A, marked, and the move commits atomically when B asks to adopt it. Anything
 * that goes wrong is a reversion, not a loss.
 */
export interface DetachLease {
  toWindowId: number
  /**
   * Identifies THIS promise, not merely the window it names.
   *
   * Electron window ids are small integers and are reused. Without a nonce, a
   * window that happens to be assigned a dead lease's id — plausible, since a
   * failed detach destroys a window and the next one created may take its
   * number — would adopt a tab promised to a window that no longer exists,
   * pulling a page out of the window the user is reading it in.
   */
  nonce: number
  /** `Date.now()` past which the reconciler hands the tab back. */
  deadline: number
}

export interface WindowTabs {
  tabs: TabDescriptor[]
  activeKey: string
  /**
   * The version every renderer op must match.
   *
   * Cross-window moves, closes and dedupes interleave with no ordering, and a
   * renderer that mutated its own mirror optimistically would diverge silently.
   * So the renderer NEVER mutates locally: it sends `expectedRev`, a mismatch is
   * rejected, and it resyncs from the pushed model.
   */
  rev: number
}

export interface OpenResult {
  windowId: number
  /**
   * The key that now exists, or null when the op was REJECTED on a stale rev.
   *
   * Explicitly null rather than "the key it would have been": a result that is
   * shape-identical to a successful create would have the renderer draw a tab that
   * does not exist, and its next op on that key would then fail silently.
   */
  key: string | null
  /** The model's rev AFTER the op, so a rejected caller can resync immediately. */
  rev: number
  /** Whether this focused an existing tab rather than creating one. */
  focusedExisting: boolean
  /**
   * Other windows that already hold this key.
   *
   * Reported so the strip can HINT at it. Dedupe is deliberately per-window:
   * two windows exist precisely so the user can read paper A beside paper B, or
   * the same paper in two projects, and yanking focus to another monitor is the
   * worst possible outcome of a click.
   */
  alsoOpenIn: number[]
}

/**
 * The outcome of a tab op, ALWAYS carrying the model's current rev.
 *
 * The rev on a REJECTION is what makes the versioning safe rather than merely
 * strict: without it a renderer whose `tabs:changed` push was dropped — a reload,
 * a destroyed webContents — would hold a stale rev that nothing further would ever
 * correct, since only a mutation pushes. Every op it then made would be rejected
 * forever. Handing back the authoritative rev means any rejection is
 * self-correcting.
 */
export interface OpResult {
  ok: boolean
  rev: number
}

export interface OpenOptions {
  title?: string
  /** Ctrl/Cmd-click: a second tab for the same page, deliberately. */
  forceNew?: boolean
  viewState?: unknown
  expectedRev?: number
}

function clampTitle(title: string | undefined, fallback: string): string {
  const t = typeof title === 'string' && title.trim().length > 0 ? title.trim() : fallback
  return t.length > MAX_TITLE_LEN ? t.slice(0, MAX_TITLE_LEN) : t
}

export class TabModel {
  private windows = new Map<number, WindowTabs>()
  /** One counter for the whole model, so `lastUsed` orders across windows too. */
  private clock = 0
  /** Never reused within a run, unlike the window ids a lease also names. */
  private leaseClock = 0

  /**
   * @param push Called with a window id whose model CHANGED. Never called for a
   *   rejected op: the renderer's mirror is still correct, and a push would make
   *   a no-op look like a change.
   */
  constructor(private readonly push: (windowId: number) => void) {}

  /**
   * The window's tabs AS THE RENDERER SEES THEM.
   *
   * Projected rather than handed over: the internal descriptors carry `lastUsed`,
   * which `WindowTabsDTO` does not declare, and a live reference would let a
   * caller mutate the authority. The copy is shallow apart from the array, which
   * is enough — every field is a primitive or the opaque `viewState` string.
   */
  get(windowId: number): WindowTabsDTO | null {
    const state = this.windows.get(windowId)
    if (!state) return null
    return {
      activeKey: state.activeKey,
      rev: state.rev,
      tabs: state.tabs.map((t) => ({
        key: t.key,
        route: t.route,
        projectId: t.projectId,
        title: t.title,
        focusNonce: t.focusNonce,
        viewState: t.viewState ?? null,
        ...(t.stale === undefined ? {} : { stale: t.stale }),
        // A BOOLEAN, not the lease: the renderer needs to know that this tab is
        // leaving, so it can grey it and refuse to close it. The target window
        // id and the deadline are main's business, and handing a renderer
        // another window's id is a fact about the app it has no use for.
        ...(t.detaching === undefined ? {} : { detaching: true })
      }))
    }
  }

  /** The internal state, for this module's own callers. */
  private state(windowId: number): WindowTabs | null {
    return this.windows.get(windowId) ?? null
  }

  windowIds(): number[] {
    return [...this.windows.keys()]
  }

  /**
   * Begin tracking a window, with the ONE tab it opens showing.
   *
   * A window always has at least one tab. An empty strip would collapse its own
   * row and make the whole layout jump, and there would be nothing on screen to
   * open a first tab from.
   */
  register(
    windowId: number,
    seed: { route: Route; projectId: number | null; title?: string; viewState?: string | null }
  ): void {
    // Already tracked: the seed is IGNORED rather than applied. A second
    // registration for a live window would replace the pages the user has open
    // with a fresh single tab, and there is no caller for whom that is the intent.
    if (this.windows.has(windowId)) return
    const key = tabKey(seed.route, seed.projectId)
    const state: WindowTabs = {
      tabs: [
        {
          key,
          route: seed.route,
          projectId: PROJECT_LEVEL_ROUTES.has(seed.route.name) ? null : seed.projectId,
          title: clampTitle(seed.title, seed.route.name),
          focusNonce: 0,
          lastUsed: ++this.clock,
          viewState: seed.viewState
        }
      ],
      activeKey: key,
      rev: 1
    }
    this.windows.set(windowId, state)
    this.push(windowId)
  }

  /**
   * Stop tracking a window and let its tabs go with it.
   *
   * A deliberate close: the user closed this window and its pages went with it
   * on purpose. The ONE exception is a tab mid-handover — not a page they
   * dismissed, but one they asked to MOVE, held here only so the move could be
   * reverted. Closing the source window during that second or two would
   * otherwise destroy it, which is exactly the loss the two-phase lease exists
   * to prevent, and which `close` already refuses one tab at a time.
   */
  forget(windowId: number): void {
    const dying = this.windows.get(windowId)
    this.windows.delete(windowId)
    if (!dying) return
    for (const tab of dying.tabs) {
      const lease = tab.detaching
      if (!lease) continue
      const target = this.windows.get(lease.toWindowId)
      if (!target) continue
      if (target.tabs.some((t) => t.key === tab.key)) continue
      delete tab.detaching
      tab.lastUsed = ++this.clock
      // A window created FOR this handover holds one placeholder tab, which the
      // arriving page replaces rather than sitting beside.
      const seeded = target.tabs.length === 1 && target.tabs[0].key !== tab.key
      target.tabs = seeded ? [tab] : [...target.tabs, tab]
      target.activeKey = tab.key
      target.rev++
      this.push(lease.toWindowId)
    }
  }

  /**
   * Stop tracking a window, moving its tabs into another live one.
   *
   * For a window that went away WITHOUT the user closing it — a crash, a
   * `render-process-gone`. Those pages are authored work: the user assembled
   * them, and dropping them because a renderer died is silent data loss. A
   * deliberate close uses `forget`, because tabs the user dismissed must not
   * reappear somewhere else.
   *
   * With no other window there is nowhere to put them and nothing to show them
   * on, so they go — this is the app shutting down.
   */
  rehome(windowId: number): void {
    const dying = this.windows.get(windowId)
    this.windows.delete(windowId)
    if (!dying) return
    const [heirId] = this.windows.keys()
    if (heirId === undefined) return
    const heir = this.windows.get(heirId)!
    let moved = false
    for (const tab of dying.tabs) {
      // Deduped against what the heir already holds — two tabs with one key would
      // make every op address both.
      if (heir.tabs.some((t) => t.key === tab.key)) continue
      // MARKED as rescued, which is what eviction ranks on before it looks at
      // recency. `lastUsed` alone is not enough and would sometimes be exactly
      // backwards: a page opened in the window that crashed can easily be more
      // recent than the ones the user has been reading in the window that
      // survived, so the LRU would delete what they are looking at in order to
      // keep what they were not.
      // The LEASE does not travel. It named a handover out of a window that no
      // longer exists; carried across, the promised window would later yank the
      // tab out of the heir the user is now reading it in, and the eviction
      // exemption above would be pinned on a promise nobody can fulfil.
      const { detaching: _lapsed, ...carried } = tab
      heir.tabs.push({ ...carried, rescued: true })
      moved = true
    }
    if (!moved) return
    // NOT evicted here, deliberately, even past the cap.
    //
    // Every candidate for eviction is a page the user opened: the heir's own, which
    // they are looking at now, or the rescued ones, which are the whole reason this
    // method exists. Choosing between them means deleting authored work to satisfy
    // a limit that exists to stop a strip growing without bound through repeated
    // clicks — which a crash is not. The overshoot is bounded by
    // `MAX_TABS_PER_WINDOW` (a window can only inherit from windows that were
    // themselves capped), rare, and self-correcting: the next `open` runs `evict`
    // and trims the least-recently-used, which by the ranking above is a rescued
    // tab and not one in use.
    heir.rev++
    this.push(heirId)
  }

  /** Which window currently holds `key`, for parenting a dialog or a save. */
  windowHolding(key: string): number | null {
    for (const [id, state] of this.windows) {
      if (state.tabs.some((t) => t.key === key)) return id
    }
    return null
  }

  open(
    windowId: number,
    route: Route,
    projectId: number | null,
    opts: OpenOptions = {}
  ): OpenResult {
    const state = this.require(windowId)
    // Computed BEFORE anything is mutated, so a project-scoped route with no
    // project throws without having half-applied an open.
    const baseKey = tabKey(route, projectId)
    const scopedProjectId = PROJECT_LEVEL_ROUTES.has(route.name) ? null : projectId

    // Matched on where a tab currently IS, not on the key it was created with.
    // A tab opened on the Connectome and then steered to paper 7 is showing
    // paper 7, and opening paper 7 must find it — keying on origin would put a
    // second tab on screen for the page the user is already reading.
    const alsoOpenIn = [...this.windows.entries()]
      .filter(([id, s]) => id !== windowId && s.tabs.some((t) => this.currentKey(t) === baseKey))
      .map(([id]) => id)

    if (opts.expectedRev !== undefined && opts.expectedRev !== state.rev) {
      // `alsoOpenIn` is reported even here: it describes the OTHER windows, which
      // this rejection says nothing about, and a caller resyncing on `rev` can use
      // it without a second round trip.
      return { windowId, key: null, rev: state.rev, focusedExisting: false, alsoOpenIn }
    }

    const existing = opts.forceNew
      ? undefined
      : state.tabs.find((t) => this.currentKey(t) === baseKey)
    if (existing) {
      // The focus params — evidenceId, quote, rowKey, factId — say where to look
      // WITHIN the page, so they update the tab in place. The nonce is what makes
      // the renderer act on them even when they are unchanged.
      existing.route = route
      existing.focusNonce++
      existing.lastUsed = ++this.clock
      if (opts.title !== undefined) existing.title = clampTitle(opts.title, existing.title)
      state.activeKey = baseKey
      state.rev++
      this.push(windowId)
      return { windowId, key: baseKey, rev: state.rev, focusedExisting: true, alsoOpenIn }
    }

    // Two tabs may never share a key, or every op would address both. Suffixed
    // through the shared `duplicateKey`, so the model, the IPC validator and
    // `parseTabKey` cannot disagree about a key main has to be able to read back.
    //
    // Checked UNCONDITIONALLY, not only under `forceNew`: a tab created as
    // `paper:1:7` and since navigated to the Connectome still OWNS that key, so
    // opening paper 7 now finds no current match and would otherwise mint a
    // second tab with a key already in use.
    let key = baseKey
    let n = 1
    while (state.tabs.some((t) => t.key === key)) {
      // Unreachable in practice — the per-window cap is far below this — but the
      // suffix is BOUNDED by the shared pattern, so running out has to fail
      // loudly rather than mint a key nothing can validate or parse.
      if (n >= MAX_TAB_DUPLICATES) throw new Error(`too many copies of ${baseKey}`)
      key = duplicateKey(baseKey, ++n)
    }

    state.tabs.push({
      key,
      route,
      projectId: scopedProjectId,
      title: clampTitle(opts.title, route.name),
      focusNonce: 0,
      lastUsed: ++this.clock,
      viewState: opts.viewState
    })
    state.activeKey = key
    this.evict(state)
    state.rev++
    this.push(windowId)
    return { windowId, key, rev: state.rev, focusedExisting: false, alsoOpenIn }
  }

  activate(windowId: number, key: string, opts: { expectedRev?: number } = {}): OpResult {
    const state = this.require(windowId)
    if (opts.expectedRev !== undefined && opts.expectedRev !== state.rev) {
      return { ok: false, rev: state.rev }
    }
    const tab = state.tabs.find((t) => t.key === key)
    if (!tab) return { ok: false, rev: state.rev }
    // Already active: nothing changed, so nothing is pushed. A rev bump here
    // would invalidate every renderer's in-flight op for no reason.
    if (state.activeKey === key) {
      tab.lastUsed = ++this.clock
      return { ok: true, rev: state.rev }
    }
    state.activeKey = key
    tab.lastUsed = ++this.clock
    state.rev++
    this.push(windowId)
    return { ok: true, rev: state.rev }
  }

  close(windowId: number, key: string, opts: { expectedRev?: number } = {}): OpResult {
    const state = this.require(windowId)
    if (opts.expectedRev !== undefined && opts.expectedRev !== state.rev) {
      return { ok: false, rev: state.rev }
    }
    // The last tab stays. Closing it would collapse the strip's row and leave the
    // window with no surface to open anything from; `Ctrl+W` on the last tab is
    // handled as closing the WINDOW, which is a different decision made
    // elsewhere.
    if (state.tabs.length <= 1) return { ok: false, rev: state.rev }
    const i = state.tabs.findIndex((t) => t.key === key)
    if (i < 0) return { ok: false, rev: state.rev }
    // A tab mid-handover is not closable. It is held here only so the move can
    // be reverted, and destroying it now is the one action that would turn a
    // recoverable failure into a lost page.
    if (state.tabs[i].detaching) return { ok: false, rev: state.rev }
    state.tabs.splice(i, 1)
    if (state.activeKey === key) {
      // The tab to the LEFT, which is where the user's attention already was —
      // and where the strip's remaining tabs slide to fill the gap.
      state.activeKey = state.tabs[Math.max(0, i - 1)].key
    }
    state.rev++
    this.push(windowId)
    return { ok: true, rev: state.rev }
  }

  /**
   * Set the whole tab order.
   *
   * Accepts only a genuine PERMUTATION of the current keys. A short list, a
   * duplicate or an unknown key would each silently drop tabs — a drag that ends
   * badly must fail, not delete the user's pages.
   */
  reorder(windowId: number, keys: string[], opts: { expectedRev?: number } = {}): OpResult {
    const state = this.require(windowId)
    const no = { ok: false as const, rev: state.rev }
    if (opts.expectedRev !== undefined && opts.expectedRev !== state.rev) return no
    if (keys.length !== state.tabs.length) return no
    if (new Set(keys).size !== keys.length) return no
    const byKey = new Map(state.tabs.map((t) => [t.key, t]))
    const next: TabDescriptor[] = []
    for (const k of keys) {
      const tab = byKey.get(k)
      if (!tab) return no
      next.push(tab)
    }
    state.tabs = next
    state.rev++
    this.push(windowId)
    return { ok: true, rev: state.rev }
  }

  /** Store the renderer's opaque snapshot for one tab. */
  setViewState(windowId: number, key: string, viewState: string | null): boolean {
    const state = this.require(windowId)
    const tab = state.tabs.find((t) => t.key === key)
    if (!tab) return false
    tab.viewState = viewState
    // No rev bump and no push: the renderer is the author of this value, so
    // telling it what it just said would be a pointless resync — and a bump would
    // reject its next op.
    return true
  }

  /**
   * Move a tab to a different page, IN PLACE.
   *
   * A tab's key is its identity and never changes, but what it SHOWS does: the
   * user follows a citation from the Connectome into a paper, and that is one
   * tab moving, not a new one. Main has to be told, because main is what answers
   * "is this page already open" — a model that still believed the tab held the
   * Connectome would open a second tab for the paper the user is already reading,
   * and would mark the wrong tab stale when that paper was deleted.
   *
   * The key deliberately does NOT follow the route. Re-keying a tab mid-session
   * would break every op the renderer has in flight against it, and would make a
   * tab's identity depend on where the user happened to navigate — so two tabs
   * could collide onto one key simply by being steered to the same page.
   */
  setRoute(
    windowId: number,
    key: string,
    route: Route,
    projectId: number | null,
    opts: { title?: string } = {}
  ): boolean {
    const state = this.require(windowId)
    const tab = state.tabs.find((t) => t.key === key)
    if (!tab) return false
    tab.route = route
    tab.projectId = PROJECT_LEVEL_ROUTES.has(route.name) ? null : projectId
    tab.lastUsed = ++this.clock
    if (opts.title !== undefined) tab.title = clampTitle(opts.title, tab.title)
    // Whatever the tab was showing is gone, and so is any reason to believe its
    // NEW target is missing. Staleness is re-decided by the next validation pass
    // against the page it now holds.
    delete tab.stale
    // A snapshot describes the page that was there, not this one. Restoring a
    // Connectome's viewport into a paper is worse than restoring nothing.
    tab.viewState = null
    // No rev bump: this changes what a tab shows, not which tabs exist, so it
    // must not reject an op the user has in flight. Pushed, because the strip's
    // label and every dedupe answer depend on it.
    this.push(windowId)
    return true
  }

  /**
   * Where a tab currently IS, which is not necessarily where it was opened.
   *
   * The dedupe key for "is this page already open here" — it has to be computed
   * from the tab's CURRENT route, or a tab the user navigated somewhere would
   * never be found again.
   */
  private currentKey(tab: TabDescriptor): string {
    try {
      return tabKey(tab.route, tab.projectId)
    } catch {
      // A route whose project has gone. It cannot match anything a caller is
      // opening, and its own key is the honest answer.
      return tab.key
    }
  }

  /**
   * Rename one tab.
   *
   * Separate from `open` because a title arrives LATER than the tab does: the
   * strip has to draw something the instant a paper is clicked, but its title is
   * only known once the work has loaded. Routing that through `open` would work
   * and would be wrong — it bumps `focusNonce`, so every paper would re-run its
   * scroll-to-evidence the moment its own title arrived, and it bumps `rev`,
   * invalidating whatever op the user had in flight.
   *
   * Pushes but does NOT bump `rev` for the same reason: a rename changes what
   * the strip draws, not which tabs exist, so it must not reject a concurrent op.
   */
  setTitle(windowId: number, key: string, title: string): boolean {
    const state = this.require(windowId)
    const tab = state.tabs.find((t) => t.key === key)
    if (!tab) return false
    const next = clampTitle(title, tab.title)
    if (next === tab.title) return true
    tab.title = next
    this.push(windowId)
    return true
  }

  // ------------------------------------------------------------- detach ----

  /**
   * Promise a tab to a window that is about to be created.
   *
   * PHASE ONE of two. The tab does not move: it is marked, and the caller then
   * builds the window. Only the new window's own `adopt` completes the move.
   *
   * Refused for the last tab in a window? No — deliberately allowed. A window
   * left with nothing renders its first-run surface and stays open; the user
   * moved a tab, they did not ask to quit. What IS refused is detaching a tab
   * that is already promised somewhere, which would hand one page to two windows.
   */
  beginDetach(
    windowId: number,
    key: string,
    toWindowId: number,
    now = Date.now()
  ): DetachLease | null {
    const state = this.require(windowId)
    const tab = state.tabs.find((t) => t.key === key)
    if (!tab || tab.detaching) return null
    const lease: DetachLease = { toWindowId, nonce: ++this.leaseClock, deadline: now + DETACH_LEASE_MS }
    tab.detaching = lease
    // No rev bump: the tab has not left, so the set of tabs is unchanged and an
    // op the user has in flight must still be accepted. Pushed, because the
    // strip has to show that this tab is on its way out.
    this.push(windowId)
    return lease
  }

  /**
   * Complete a detach: the new window claims the tab it was promised.
   *
   * PHASE TWO, and the only place the move actually happens — atomically, from
   * the point of view of everything else, because it is synchronous. Refuses
   * anything it was not promised, so a renderer cannot adopt an arbitrary tab
   * out of a sibling window by asking for it.
   */
  adopt(toWindowId: number, nonce: number, now = Date.now()): boolean {
    for (const [fromId, state] of this.windows) {
      if (fromId === toWindowId) continue
      // Found by the PROMISE, not by a key the caller supplied. Main is what
      // made the promise, so main is what knows which tab this window is owed —
      // and a window then cannot claim a page merely because it can name it.
      const i = state.tabs.findIndex(
        (t) =>
          t.detaching !== undefined &&
          t.detaching.toWindowId === toWindowId &&
          t.detaching.nonce === nonce
      )
      if (i < 0) continue
      const tab = state.tabs[i]
      const key = tab.key
      const lease = tab.detaching!
      // Not expired. An expired lease is refused rather than honoured late: the
      // reconciler may already have handed the tab back, and the user may
      // already be reading it where it came from.
      if (lease.deadline < now) return false

      const target = this.windows.get(toWindowId)
      if (!target) return false

      state.tabs.splice(i, 1)
      delete tab.detaching
      tab.lastUsed = ++this.clock

      if (state.tabs.length === 0) {
        // A window with no tabs. It stays OPEN, showing its first-run surface:
        // the user moved a page out, which is not a request to close anything.
        state.activeKey = ''
      } else if (state.activeKey === key) {
        state.activeKey = state.tabs[Math.max(0, i - 1)].key
      }
      state.rev++
      this.push(fromId)

      // The new window is seeded with exactly one tab, so whatever `register`
      // gave it is replaced rather than added to — otherwise every detach would
      // arrive alongside a stray Projects tab nobody asked for.
      const seeded = target.tabs.length === 1 && target.tabs[0].key !== key
      target.tabs = seeded ? [tab] : [...target.tabs.filter((t) => t.key !== key), tab]
      target.activeKey = key
      target.rev++
      this.push(toWindowId)
      return true
    }
    return false
  }

  /**
   * Give back every tab whose promised window never came, or has gone.
   *
   * The reconciler. Without it a window that failed to open — a crash during
   * load, a user closing it before it painted — would leave its tab greyed and
   * unusable in the window it came from, forever, with no way to recover it
   * short of restarting the app.
   *
   * @param isLive Whether a window id still names a window that could adopt.
   */
  reconcileDetaches(isLive: (windowId: number) => boolean, now = Date.now()): void {
    for (const [id, state] of this.windows) {
      let changed = false
      for (const tab of state.tabs) {
        const lease = tab.detaching
        if (!lease) continue
        if (lease.deadline >= now && isLive(lease.toWindowId)) continue
        delete tab.detaching
        changed = true
      }
      // Pushed without a rev bump, matching `beginDetach`: the tab never left,
      // so this restores an appearance rather than changing the set of tabs.
      if (changed) this.push(id)
    }
  }

  /** Is any tab anywhere still waiting on a handover? */
  hasPendingDetach(): boolean {
    for (const state of this.windows.values()) {
      if (state.tabs.some((t) => t.detaching)) return true
    }
    return false
  }

  /**
   * Mark every tab whose target has gone.
   *
   * `isDead` is asked per key by the caller, which is the only thing that can
   * consult the database. Marking rather than closing is the point: a paper that
   * was deleted from under an open tab must SAY so, in the place the user left it.
   */
  markStale(isDead: (key: string, tab: TabDescriptor) => boolean, reason: string): void {
    for (const [id, state] of this.windows) {
      let changed = false
      for (const tab of state.tabs) {
        // Asked about where the tab IS, not where it was opened. Deleting a
        // paper must mark the tab actually displaying it, and must not mark one
        // that merely started there and has since moved on.
        //
        // ADDITIVE: a predicate that says no is saying "not this one", not "this
        // one is fine". Callers know about one deletion each — the work that was
        // just removed — so clearing on a `false` would have every delete wipe
        // the marks left by every other, and a tab would announce its paper was
        // gone only until the next unrelated deletion.
        if (isDead(this.currentKey(tab), tab) && tab.stale !== reason) {
          tab.stale = reason
          changed = true
        }
      }
      if (changed) {
        // Bumped, unlike the other in-place edits: a stale tab is not closable
        // in the same way and the renderer must not act on a model that predates
        // finding out. This is rare — a deletion — so the rejection it may cause
        // costs one resync.
        state.rev++
        this.push(id)
      }
    }
  }

  /**
   * Clear the stale mark from tabs whose target has come back.
   *
   * The counterpart to `markStale`, and separate from it precisely because they
   * are asymmetric: marking is driven by a deletion, which names one thing,
   * while un-marking needs someone who can say a specific target EXISTS again —
   * a restored project, a re-imported paper.
   */
  clearStale(isAlive: (key: string, tab: TabDescriptor) => boolean): void {
    for (const [id, state] of this.windows) {
      let changed = false
      for (const tab of state.tabs) {
        if (tab.stale === undefined) continue
        if (!isAlive(this.currentKey(tab), tab)) continue
        delete tab.stale
        changed = true
      }
      if (changed) {
        state.rev++
        this.push(id)
      }
    }
  }

  private require(windowId: number): WindowTabs {
    const state = this.windows.get(windowId)
    if (!state) throw new Error(`window ${windowId} is not tracked`)
    return state
  }

  /**
   * Is this window tracked? For a caller that must not throw.
   *
   * `render-process-gone` does not necessarily destroy the window — a renderer can
   * crash and be reloaded into the same `BrowserWindow` — so a window whose tabs
   * were re-homed is alive and untracked, and the first IPC from the reloaded
   * renderer would hit `require` and throw. The IPC layer asks this and
   * re-registers rather than letting that happen.
   */
  tracks(windowId: number): boolean {
    return this.windows.has(windowId)
  }

  /**
   * Bring a window back under the cap by dropping least-recently-used tabs.
   *
   * Never the ACTIVE one, whatever its counter says: evicting the page the user is
   * looking at is the one outcome that is always wrong.
   */
  private evict(state: WindowTabs): void {
    while (state.tabs.length > MAX_TABS_PER_WINDOW) {
      let victim = -1
      for (let i = 0; i < state.tabs.length; i++) {
        const t = state.tabs[i]
        if (t.key === state.activeKey) continue
        // NEVER a tab mid-handover. It is not the active one — the user just
        // dragged it away — and its `lastUsed` is not refreshed by the promise,
        // which makes it the LRU's first choice at exactly the moment losing it
        // is unrecoverable: the new window then finds no lease and the page is
        // gone with no error. This is the loss the two-phase design exists to
        // prevent, and the cap is the lesser concern.
        if (t.detaching) continue
        if (victim < 0) {
          victim = i
          continue
        }
        const best = state.tabs[victim]
        // Rescued first, then least-recently-used within each group.
        if (t.rescued !== best.rescued) {
          if (t.rescued) victim = i
          continue
        }
        if (t.lastUsed < best.lastUsed) victim = i
      }
      if (victim < 0) return
      state.tabs.splice(victim, 1)
    }
  }
}
