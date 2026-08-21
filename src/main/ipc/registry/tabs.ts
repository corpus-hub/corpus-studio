import { z } from 'zod/v4'
import { e, type Entry } from '../types'
import { ROUTE_NAMES } from '../../../shared/nav'
import { TAB_KEY_MAX, TAB_KEY_PATTERN } from '../../../shared/tabKey'
import { detachTab, getTabModel, tabModelFor, takePendingAdoption } from '../../tabs-service'

/**
 * Tabs — which pages each window has open.
 *
 * EVERY entry here is `tool: null`, permanently. Two independent reasons, either
 * of which alone would be sufficient:
 *
 * 1. `Ctx.sender` is ALWAYS null over MCP — there is no window — so the source
 *    window of every op would be unresolvable and the op refused anyway.
 * 2. More importantly, a tool here would let a remote agent open windows, steal
 *    the user's focus and rearrange the pages they are reading. No reading of the
 *    corpus requires it, and "the agent moved my tabs" is not a failure mode this
 *    app is going to have.
 *
 * The SOURCE window is never a parameter. It is always
 * `BrowserWindow.fromWebContents(e.sender)`, resolved by the registry into
 * `ctx.sender` — a forgeable window id would let one renderer close another
 * window's tabs.
 */

/**
 * A tab key, validated against the SHARED pattern rather than a local copy.
 *
 * The generator, this validator and `parseTabKey` are one rule — the pattern is
 * derived from `ROUTE_NAMES`, so adding a route cannot leave them disagreeing. A
 * second, hand-written regex here would accept keys the generator can never emit
 * (`foo:1`, `projects:7`, `graph:3:7`) and would make the shared one dead code.
 */
const tabKeyArg = z.string().min(1).max(TAB_KEY_MAX).regex(TAB_KEY_PATTERN)

const projectIdArg = z.number().int().nonnegative().nullable()

/**
 * A route, re-validated in main rather than trusted.
 *
 * `.strict()` so an unexpected property is refused rather than carried into the
 * model as opaque state, and every focus field is bounded — `quote` in particular
 * is free text from a citation context and is the one field here a caller could
 * otherwise use to store a megabyte per tab.
 */
const routeArg = z
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

const expectedRev = z.number().int().nonnegative().optional()

/**
 * The serialized per-tab view state.
 *
 * Opaque to main — the renderer authors it and is the only thing that reads it —
 * but BOUNDED, because it is stored per tab and will be persisted: a screen that
 * decided to stash its whole result set here would grow the session file without
 * limit. Carried as a JSON string rather than as an object so the bound is a
 * length that can actually be checked.
 */
const viewStateArg = z
  .string()
  .max(64 * 1024)
  .nullable()
  .optional()

export const TAB_ENTRIES: Entry[] = [
  e({
    channel: 'tabs:state',
    tool: null,
    access: 'read',
    summary: "The calling window's own tabs and which one is active.",
    returns: 'WindowTabsDTO | null',
    params: z.object({}).strict(),
    run: (ctx) => (ctx.sender ? tabModelFor(ctx.sender.id).get(ctx.sender.id) : null)
  }),

  e({
    channel: 'tabs:open',
    tool: null,
    access: 'write',
    summary:
      'Open a page as a tab in the calling window, or focus the tab that already ' +
      'shows it. Dedupe is per WINDOW: a sibling window holding the same page is ' +
      'reported, not focused.',
    returns: 'TabOpenResultDTO | null',
    params: z
      .object({
        route: routeArg,
        projectId: projectIdArg,
        title: z.string().max(300).optional(),
        forceNew: z.boolean().optional(),
        viewState: viewStateArg,
        expectedRev
      })
      .strict(),
    run: (ctx, a) => {
      if (!ctx.sender) return null
      const model = tabModelFor(ctx.sender.id)
      try {
        return model.open(ctx.sender.id, a.route, a.projectId, {
          title: a.title,
          forceNew: a.forceNew,
          viewState: a.viewState ?? undefined,
          expectedRev: a.expectedRev
        })
      } catch {
        // A project-scoped route with no project, or a page duplicated past the
        // suffix bound. REFUSED with the current rev rather than thrown: a throw
        // crosses IPC as a rejected invoke the renderer would have to special-case,
        // and the answer is the same either way — the tab was not opened, and here
        // is the state that is true.
        const state = model.get(ctx.sender.id)
        return {
          windowId: ctx.sender.id,
          key: null,
          rev: state?.rev ?? 0,
          focusedExisting: false,
          alsoOpenIn: []
        }
      }
    }
  }),

  e({
    channel: 'tabs:activate',
    tool: null,
    access: 'write',
    summary: 'Make one of the calling window’s tabs the active one.',
    returns: 'TabOpResultDTO',
    params: z.object({ key: tabKeyArg, expectedRev }).strict(),
    run: (ctx, a) =>
      ctx.sender
        ? tabModelFor(ctx.sender.id).activate(ctx.sender.id, a.key, { expectedRev: a.expectedRev })
        : { ok: false, rev: 0 }
  }),

  e({
    channel: 'tabs:close',
    tool: null,
    access: 'write',
    summary:
      'Close one of the calling window’s tabs. Refused for the LAST tab — a window ' +
      'always shows something.',
    returns: 'TabOpResultDTO',
    params: z.object({ key: tabKeyArg, expectedRev }).strict(),
    run: (ctx, a) =>
      ctx.sender
        ? tabModelFor(ctx.sender.id).close(ctx.sender.id, a.key, { expectedRev: a.expectedRev })
        : { ok: false, rev: 0 }
  }),

  e({
    channel: 'tabs:reorder',
    tool: null,
    access: 'write',
    summary:
      'Set the calling window’s tab order. Accepts only a permutation of the keys ' +
      'it already holds, so a drag that ends badly cannot drop a tab.',
    returns: 'TabOpResultDTO',
    params: z
      .object({
        // Bounded by the per-window cap: a longer list cannot be a permutation of
        // anything this model holds, so accepting one only to reject it later is an
        // allocation with no purpose.
        keys: z.array(tabKeyArg).max(64),
        expectedRev
      })
      .strict(),
    run: (ctx, a) =>
      ctx.sender
        ? tabModelFor(ctx.sender.id).reorder(ctx.sender.id, a.keys, { expectedRev: a.expectedRev })
        : { ok: false, rev: 0 }
  }),

  e({
    channel: 'tabs:detach',
    tool: null,
    access: 'write',
    summary:
      'Drag a tab out into a NEW window, positioned at the cursor. The tab stays ' +
      'here, marked, until the new window claims it, so a window that fails to ' +
      'open reverts the move instead of destroying the page.',
    returns: 'boolean',
    params: z
      .object({
        key: tabKeyArg,
        // SCREEN coordinates, so the new window opens under the pointer that
        // dragged it there. Bounded well past any real display arrangement but
        // far short of what would let a caller fling a window out of reach —
        // and clamped to a work area in main regardless.
        screenX: z.number().int().min(-32_000).max(32_000),
        screenY: z.number().int().min(-32_000).max(32_000)
      })
      .strict(),
    run: (ctx, a) =>
      ctx.sender ? detachTab(ctx.sender.id, a.key, a.screenX, a.screenY) : false
  }),

  e({
    channel: 'tabs:adopt',
    tool: null,
    access: 'write',
    summary:
      'Claim the tab this window was created to receive. Takes no key: main knows ' +
      'what it promised, so a window cannot claim a page merely by naming it.',
    returns: 'boolean',
    params: z.object({}).strict(),
    run: (ctx) => {
      if (!ctx.sender) return false
      // Consumed, so a renderer that reloads cannot adopt a second time.
      const nonce = takePendingAdoption(ctx.sender.id)
      return nonce === null ? false : getTabModel().adopt(ctx.sender.id, nonce)
    }
  }),

  e({
    channel: 'tabs:setRoute',
    tool: null,
    access: 'write',
    summary:
      'Move a tab to a different page in place, after a navigation inside it. ' +
      'Does not bump the rev — the tab still exists, it is just showing something ' +
      'else — but main must be told, because main answers “is this page already open”.',
    returns: 'boolean',
    params: z
      .object({ key: tabKeyArg, route: routeArg, projectId: projectIdArg, title: z.string().max(300).optional() })
      .strict(),
    run: (ctx, a) => {
      if (!ctx.sender) return false
      try {
        return tabModelFor(ctx.sender.id).setRoute(ctx.sender.id, a.key, a.route, a.projectId, {
          title: a.title
        })
      } catch {
        // A project-scoped route with no project. Refused rather than thrown:
        // the answer the renderer needs is "the tab did not move", and a
        // rejected invoke would only make that harder to act on.
        return false
      }
    }
  }),

  e({
    channel: 'tabs:setTitle',
    tool: null,
    access: 'write',
    summary:
      'Rename a tab once its subject has loaded. Does not bump the rev — a title ' +
      'changes what the strip draws, not which tabs exist.',
    returns: 'boolean',
    params: z.object({ key: tabKeyArg, title: z.string().max(300) }).strict(),
    run: (ctx, a) =>
      ctx.sender ? tabModelFor(ctx.sender.id).setTitle(ctx.sender.id, a.key, a.title) : false
  }),

  e({
    channel: 'tabs:setViewState',
    tool: null,
    access: 'write',
    summary:
      'Store a tab’s opaque view snapshot (scroll, find query, sub-tab), so it can ' +
      'be restored after a suspend or carried to another window.',
    returns: 'boolean',
    params: z.object({ key: tabKeyArg, viewState: viewStateArg }).strict(),
    run: (ctx, a) =>
      ctx.sender
        ? tabModelFor(ctx.sender.id).setViewState(ctx.sender.id, a.key, a.viewState ?? null)
        : false
  })
]
