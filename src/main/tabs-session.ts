import { z } from 'zod/v4'
import type { Route } from '../shared/nav'
import { TAB_KEY_MAX, TAB_KEY_PATTERN, parseTabKey } from '../shared/tabKey'
import { ROUTE_NAMES } from '../shared/nav'
import { MAX_TABS_PER_WINDOW, type TabModel } from './tabs'

/**
 * The most windows a session may restore.
 *
 * Mirrors the cap `createWindow` enforces. Stated here as well because the
 * schema is what a doctored row is checked against, and a session naming a
 * hundred windows should be refused as malformed rather than opening eight and
 * quietly discarding the rest.
 */
const MAX_WINDOWS = 8

/**
 * The open pages, across restarts.
 *
 * Thirty tabs in three windows is authored work: the user assembled that set
 * deliberately, over a session, and losing it to a restart is the same kind of
 * loss as losing a document. So it is persisted — into the `setting` table
 * rather than a file of its own, because it belongs to the corpus it describes
 * and must not outlive it or be restored against a different one.
 *
 * What is NOT persisted, deliberately: per-tab back/forward history. That is a
 * property of a session — restoring someone into a half-remembered trail across
 * a restart is worse than starting them at the page they were on — and it
 * matches the decision `useTabHistories` already documents.
 */

export const TABS_SESSION_KEY = 'tabs.session'

/**
 * The stored shape, validated on the way BACK IN.
 *
 * Parsed rather than trusted even though this app wrote it: the file is a SQLite
 * row a user can edit, it survives across versions in which the route vocabulary
 * has changed, and a half-written value from a crash mid-save would otherwise be
 * handed to the model as if it were a set of tabs. Everything here is bounded,
 * and anything that fails is dropped rather than throwing — a session that
 * cannot be read must start the app empty, never fail to start it.
 */
const storedRoute = z
  .object({
    name: z.enum(ROUTE_NAMES),
    workId: z.number().int().nonnegative().optional(),
    evidenceId: z.number().int().nonnegative().optional(),
    quote: z.string().max(2000).optional(),
    rowKey: z.string().max(200).optional(),
    schemaId: z.number().int().nonnegative().optional(),
    factId: z.number().int().nonnegative().optional()
  })
  .strict()

const storedTab = z
  .object({
    key: z.string().min(1).max(TAB_KEY_MAX).regex(TAB_KEY_PATTERN),
    route: storedRoute,
    projectId: z.number().int().nonnegative().nullable(),
    title: z.string().max(300),
    viewState: z
      .string()
      .max(64 * 1024)
      .nullable()
      .optional()
  })
  .strict()

const storedWindow = z
  .object({
    // PER-TAB tolerance: one unreadable tab must cost that tab, not the whole
    // session. A route name retired between builds, or a `viewState` that grew
    // past its bound, would otherwise fail the array, fail the window, fail the
    // session, and silently discard every OTHER window the user had open.
    // `catch(null)` turns each failure into a hole that `restoreWindow` filters.
    //
    // Bounded at MAX_TABS_PER_WINDOW, the cap the model actually enforces: a
    // larger array would restore and then be immediately LRU-evicted down to it,
    // which is a page vanishing on launch for no reason the user can see.
    tabs: z.array(storedTab.nullable().catch(null)).max(MAX_TABS_PER_WINDOW),
    activeKey: z.string().max(TAB_KEY_MAX),
    bounds: z
      .object({
        x: z.number().int().min(-32_000).max(32_000),
        y: z.number().int().min(-32_000).max(32_000),
        width: z.number().int().min(320).max(32_000),
        height: z.number().int().min(240).max(32_000)
      })
      .strict()
      .optional(),
    maximized: z.boolean().optional()
  })
  .strict()

/** At most eight, matching the window cap a restore must not be able to exceed. */
const storedSession = z
  .object({ windows: z.array(storedWindow.nullable().catch(null)).max(MAX_WINDOWS) })
  .strict()

export type StoredSession = z.infer<typeof storedSession>
export type StoredWindow = z.infer<typeof storedWindow>

/**
 * A session that has been READ, with the holes already taken out.
 *
 * Distinct from `StoredSession`, whose `windows` are nullable because that is
 * what the tolerant schema produces on the way in. Once `parseSession` has
 * counted the holes and reported them, a caller has no business seeing them —
 * and if it can, it will silently skip them a second time, which is precisely
 * the loss this whole read was rewritten to stop being silent.
 */
export interface RestorableSession {
  windows: StoredWindow[]
}

/**
 * Snapshot every window's tabs, for writing at quit.
 *
 * Geometry is supplied by the caller because this module deliberately does not
 * know about `BrowserWindow` — the same separation the model itself keeps.
 */
/**
 * The most a whole session may occupy.
 *
 * The per-tab `viewState` bound (64 KiB) is not enough on its own: eight windows
 * of twenty-four tabs each is ~12 MB of JSON, written SYNCHRONOUSLY into one
 * SQLite row during quit and parsed in full before the first window appears next
 * launch. Both of those are visible pauses. Past this size the snapshots are
 * dropped — the tabs themselves are kept, because which pages were open is the
 * part worth restoring and a scroll offset is not.
 */
const MAX_SESSION_BYTES = 1024 * 1024

export function captureSession(
  model: TabModel,
  geometry: (windowId: number) => { bounds?: StoredWindow['bounds']; maximized?: boolean }
): RestorableSession {
  const windows: StoredWindow[] = []
  for (const id of model.windowIds()) {
    const state = model.get(id)
    // A window with no tabs is not worth restoring: it would come back as an
    // empty shell the user has to close, which is not a state anyone chose to
    // leave the app in — they detached its last tab into another window that IS
    // being saved.
    if (!state || state.tabs.length === 0) continue
    const geo = geometry(id)
    windows.push({
      tabs: state.tabs.map((t) => ({
        key: t.key,
        route: t.route,
        projectId: t.projectId,
        title: t.title,
        viewState: t.viewState ?? null
      })),
      activeKey: state.activeKey,
      ...(geo.bounds ? { bounds: geo.bounds } : {}),
      ...(geo.maximized === undefined ? {} : { maximized: geo.maximized })
    })
  }
  const session = { windows }
  if (JSON.stringify(session).length <= MAX_SESSION_BYTES) return session
  // Over budget. The view snapshots go first and, in practice, only: they are
  // the whole of the size and the least of the value. A restored tab then opens
  // at the top of its page, which is what it did before any of this existed.
  return {
    windows: windows.map((w) => ({
      ...w,
      // The `null` arm is unreachable — this function BUILDS these tabs and
      // never produces a hole — but `StoredWindow` is the tolerant READ type, so
      // the compiler is right that one could be there. Preserved rather than
      // filtered: dropping a tab here would silently lose a page for being over
      // a size budget, which is the opposite of what this branch is for.
      tabs: w.tabs.map((t) => (t === null ? null : { ...t, viewState: null }))
    }))
  }
}

/**
 * What became of the stored session.
 *
 * THREE outcomes, not two, because the two that used to be one are opposite
 * facts about the user's work. `none` is an install that had nothing open —
 * a first launch, or a quit from a single blank window. `unreadable` is a
 * session that WAS written and could not be read back: a crash mid-write, a
 * hand-edited row, a build whose route vocabulary moved. Both used to answer
 * `null`, so thirty tabs in three windows were dropped on the floor and the app
 * opened one blank window as though the user had left it that way.
 *
 * `partial` is the same loss at a smaller scale, and is reported for the same
 * reason: the per-tab and per-window `catch(null)` tolerance is what stops one
 * bad entry costing the whole session, but a hole it leaves behind is still a
 * page the user had open and does not have back. `lostTabs`/`lostWindows` count
 * them so the app can say how much rather than merely that something happened.
 */
export type SessionRead =
  | { outcome: 'none' }
  | { outcome: 'unreadable' }
  | { outcome: 'ok'; session: RestorableSession }
  | { outcome: 'partial'; session: RestorableSession; lostWindows: number; lostTabs: number }

/** Read a stored session back, saying WHY when there is not a usable one. */
export function parseSession(raw: string | null): SessionRead {
  if (!raw) return { outcome: 'none' }
  let parsed: ReturnType<typeof storedSession.safeParse>
  try {
    parsed = storedSession.safeParse(JSON.parse(raw))
  } catch {
    // Truncated or not JSON at all — a crash mid-write. The app still starts,
    // which is recoverable; refusing to start is not. It does not pretend the
    // user left it empty.
    return { outcome: 'unreadable' }
  }
  if (!parsed.success) return { outcome: 'unreadable' }

  // Holes are windows and tabs the schema refused, one at a time. Counted
  // BEFORE they are filtered, because after the filter they are indistinguishable
  // from a session that never held them.
  let lostTabs = 0
  let lostWindows = 0
  const windows: StoredWindow[] = []
  for (const w of parsed.data.windows) {
    if (w === null) {
      lostWindows += 1
      continue
    }
    const holes = w.tabs.filter((t) => t === null).length
    if (w.tabs.length === holes) {
      // Every tab in it was unreadable, so nothing of it survives.
      lostWindows += 1
      lostTabs += holes
      continue
    }
    lostTabs += holes
    windows.push(w)
  }

  if (windows.length === 0) {
    // A stored session that yields nothing is only "no session" when it held
    // nothing to begin with. Anything else lost work.
    return lostWindows > 0 || lostTabs > 0 ? { outcome: 'unreadable' } : { outcome: 'none' }
  }
  const session = { windows }
  return lostWindows > 0 || lostTabs > 0
    ? { outcome: 'partial', session, lostWindows, lostTabs }
    : { outcome: 'ok', session }
}

/**
 * Put one restored window's tabs back into the model.
 *
 * Tabs whose target no longer parses are DROPPED here rather than restored and
 * marked: a key this build cannot read is not a page it can render or a tab the
 * user could act on, and drawing it would only be a strip entry that does
 * nothing. Targets that parse but have since been deleted are a different case —
 * those restore normally and are marked stale by the usual validation.
 */
export function restoreWindow(model: TabModel, windowId: number, win: StoredWindow): void {
  // Holes are tabs this build could not read (see `storedTab.catch`), and keys
  // it cannot parse are pages it could not render or act on. Both are dropped
  // here rather than restored as strip entries that do nothing.
  const usable = win.tabs.filter(
    (t): t is NonNullable<typeof t> => t !== null && parseTabKey(t.key) !== null
  )
  if (usable.length === 0) return
  const first = usable[0]
  model.register(windowId, {
    route: first.route as Route,
    projectId: first.projectId,
    title: first.title,
    viewState: first.viewState ?? null
  })
  // Keyed by the tab's POSITION, not by the key it was stored under. A restored
  // key is re-derived from the route, so a duplicate can come back with a
  // different `#n` suffix than it had — and then activating by the stored key
  // would silently restore the wrong tab, or none.
  const restoredKeys: (string | null)[] = [model.get(windowId)?.tabs[0]?.key ?? null]
  for (const t of usable.slice(1)) {
    const res = model.open(windowId, t.route as Route, t.projectId, {
      title: t.title,
      viewState: t.viewState ?? undefined,
      // Every restored tab is its own tab. Deduping here would silently merge
      // two pages the user had deliberately open side by side — including the
      // `#2` duplicates they asked for with a modifier.
      forceNew: true
    })
    restoredKeys.push(res.key)
  }
  const i = usable.findIndex((t) => t.key === win.activeKey)
  const active = i >= 0 ? restoredKeys[i] : null
  if (active) model.activate(windowId, active)
}
