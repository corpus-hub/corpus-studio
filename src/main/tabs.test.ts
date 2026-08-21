import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TabModel, MAX_TABS_PER_WINDOW, DETACH_LEASE_MS } from './tabs'
import { TAB_KEY_PATTERN, duplicateKey, parseTabKey, tabKey } from '../shared/tabKey'
import type { Route } from '../shared/nav'

const PAPER = (workId: number): Route => ({ name: 'paper', workId })
const GRAPH: Route = { name: 'graph' }
const PROJECTS: Route = { name: 'projects' }

function fresh(): { m: TabModel; pushes: number[] } {
  const pushes: number[] = []
  const m = new TabModel((windowId) => pushes.push(windowId))
  return { m, pushes }
}

test('a window starts with nothing and is not addressable until registered', () => {
  const { m } = fresh()
  assert.equal(m.get(1), null)
  assert.throws(() => m.open(1, PROJECTS, null), /window/i)
})

test('registering a window seeds exactly one tab, which is the active one', () => {
  const { m } = fresh()
  m.register(1, { route: PROJECTS, projectId: null, title: 'Projects' })
  const s = m.get(1)
  assert.ok(s)
  assert.equal(s.tabs.length, 1)
  assert.equal(s.activeKey, 'projects')
  // The strip must never render zero tabs: the row would collapse and the whole
  // layout would jump.
  assert.ok(s.tabs.length > 0)
})

test('rev advances on every change and only on a change', () => {
  const { m } = fresh()
  m.register(1, { route: PROJECTS, projectId: null, title: 'Projects' })
  const r0 = m.get(1)!.rev
  m.open(1, GRAPH, 3, { title: 'Graph' })
  const r1 = m.get(1)!.rev
  assert.ok(r1 > r0)
  // Re-opening the same key only focuses; it is still a change (the active tab
  // moved) but must not duplicate the tab.
  m.open(1, GRAPH, 3, { title: 'Graph' })
  assert.equal(m.get(1)!.tabs.length, 2)
  // Activating the tab that is already active changes nothing at all.
  const r2 = m.get(1)!.rev
  m.activate(1, 'graph:3')
  assert.equal(m.get(1)!.rev, r2)
})

test('an op with a stale rev is rejected and the model is untouched', () => {
  const { m } = fresh()
  m.register(1, { route: PROJECTS, projectId: null, title: 'Projects' })
  m.open(1, GRAPH, 3, { title: 'Graph' })
  const rev = m.get(1)!.rev
  assert.equal(m.close(1, 'graph:3', { expectedRev: rev - 1 }).ok, false)
  assert.equal(m.get(1)!.tabs.length, 2)
  assert.equal(m.get(1)!.rev, rev)
  // The current rev is accepted.
  assert.equal(m.close(1, 'graph:3', { expectedRev: rev }).ok, true)
})

test('dedupe is PER WINDOW, never across windows', () => {
  const { m } = fresh()
  m.register(1, { route: PROJECTS, projectId: null, title: 'Projects' })
  m.register(2, { route: PROJECTS, projectId: null, title: 'Projects' })
  m.open(1, PAPER(7), 3, { title: 'A' })
  // Two windows exist precisely so the user can compare papers side by side.
  // Stealing focus to another monitor is the worst outcome of a click.
  const r = m.open(2, PAPER(7), 3, { title: 'A' })
  assert.equal(r.windowId, 2)
  assert.equal(m.get(1)!.tabs.filter((t) => t.key === 'paper:3:7').length, 1)
  assert.equal(m.get(2)!.tabs.filter((t) => t.key === 'paper:3:7').length, 1)
  // ...but it is reported, so the strip can hint at it non-blockingly.
  assert.deepEqual(r.alsoOpenIn, [1])
})

test('the same paper in two projects is two tabs', () => {
  const { m } = fresh()
  m.register(1, { route: PROJECTS, projectId: null, title: 'Projects' })
  m.open(1, PAPER(7), 3, { title: 'A in 3' })
  m.open(1, PAPER(7), 4, { title: 'A in 4' })
  assert.equal(m.get(1)!.tabs.length, 3)
  assert.notEqual(tabKey(PAPER(7), 3), tabKey(PAPER(7), 4))
})

test('opening into an existing tab bumps focusNonce, so focus is re-honoured', () => {
  const { m } = fresh()
  m.register(1, { route: PROJECTS, projectId: null, title: 'Projects' })
  m.open(1, PAPER(7), 3, { title: 'A' })
  const first = m.get(1)!.tabs.find((t) => t.key === 'paper:3:7')!
  const n0 = first.focusNonce
  // Same page, different span. Focus handling in the renderer is latched on the
  // id, so without a changing nonce "Evidence →" would appear dead.
  m.open(1, { name: 'paper', workId: 7, evidenceId: 99 }, 3, { title: 'A' })
  const again = m.get(1)!.tabs.find((t) => t.key === 'paper:3:7')!
  assert.ok(again.focusNonce > n0)
  // The focus params themselves are updated on the existing tab.
  assert.equal((again.route as { evidenceId?: number }).evidenceId, 99)
})

test('ctrl-click forces a second tab for the same page', () => {
  const { m } = fresh()
  m.register(1, { route: PROJECTS, projectId: null, title: 'Projects' })
  m.open(1, PAPER(7), 3, { title: 'A' })
  m.open(1, PAPER(7), 3, { title: 'A', forceNew: true })
  const same = m.get(1)!.tabs.filter((t) => t.key.startsWith('paper:3:7'))
  assert.equal(same.length, 2)
  // Two tabs cannot share a key, or every op would address both.
  assert.equal(new Set(m.get(1)!.tabs.map((t) => t.key)).size, m.get(1)!.tabs.length)
})

test('closing the active tab activates a neighbour, never nothing', () => {
  const { m } = fresh()
  m.register(1, { route: PROJECTS, projectId: null, title: 'Projects' })
  m.open(1, GRAPH, 3, { title: 'Graph' })
  m.open(1, PAPER(7), 3, { title: 'A' })
  assert.equal(m.get(1)!.activeKey, 'paper:3:7')
  m.close(1, 'paper:3:7')
  // The tab to the LEFT, which is where the user's attention already was.
  assert.equal(m.get(1)!.activeKey, 'graph:3')
  assert.ok(m.get(1)!.tabs.some((t) => t.key === m.get(1)!.activeKey))
})

test('the last tab cannot be closed, and says why', () => {
  const { m } = fresh()
  m.register(1, { route: PROJECTS, projectId: null, title: 'Projects' })
  assert.equal(m.close(1, 'projects').ok, false)
  assert.equal(m.get(1)!.tabs.length, 1)
})

test('closing a tab that does not exist is a no-op, not a crash', () => {
  const { m } = fresh()
  m.register(1, { route: PROJECTS, projectId: null, title: 'Projects' })
  const rev = m.get(1)!.rev
  assert.equal(m.close(1, 'graph:99').ok, false)
  assert.equal(m.get(1)!.rev, rev)
  assert.equal(m.activate(1, 'graph:99').ok, false)
})

test('tabs per window are capped', () => {
  const { m } = fresh()
  m.register(1, { route: PROJECTS, projectId: null, title: 'Projects' })
  for (let i = 0; i < MAX_TABS_PER_WINDOW + 10; i++) {
    m.open(1, PAPER(i), 3, { title: `p${i}` })
  }
  assert.equal(m.get(1)!.tabs.length, MAX_TABS_PER_WINDOW)
  // The cap evicts the LEAST recently used, and never the active tab.
  assert.ok(m.get(1)!.tabs.some((t) => t.key === m.get(1)!.activeKey))
})

test('reorder is a permutation, and refuses anything that is not', () => {
  const { m } = fresh()
  m.register(1, { route: PROJECTS, projectId: null, title: 'Projects' })
  m.open(1, GRAPH, 3, { title: 'G' })
  m.open(1, PAPER(7), 3, { title: 'A' })
  const keys = m.get(1)!.tabs.map((t) => t.key)
  assert.equal(m.reorder(1, [keys[2], keys[0], keys[1]]).ok, true)
  assert.deepEqual(m.get(1)!.tabs.map((t) => t.key), [keys[2], keys[0], keys[1]])
  // A short list, a duplicate, or an unknown key would silently DROP tabs.
  assert.equal(m.reorder(1, [keys[0]]).ok, false)
  assert.equal(m.reorder(1, [keys[0], keys[0], keys[1]]).ok, false)
  assert.equal(m.reorder(1, [keys[0], keys[1], 'graph:999']).ok, false)
  assert.equal(m.get(1)!.tabs.length, 3)
})

test('a closed window is forgotten and its tabs re-homed, not dropped', () => {
  const { m } = fresh()
  m.register(1, { route: PROJECTS, projectId: null, title: 'Projects' })
  m.register(2, { route: PROJECTS, projectId: null, title: 'Projects' })
  m.open(1, PAPER(7), 3, { title: 'A' })
  m.open(1, GRAPH, 3, { title: 'G' })
  // A CRASH must not silently delete the user's open pages.
  m.rehome(1)
  assert.equal(m.get(1), null)
  const keys = m.get(2)!.tabs.map((t) => t.key)
  assert.ok(keys.includes('paper:3:7'))
  assert.ok(keys.includes('graph:3'))
  // Deduped against what window 2 already had — it also had `projects`.
  assert.equal(keys.filter((k) => k === 'projects').length, 1)
})

test('the LAST window closing drops its tabs rather than inventing a home', () => {
  const { m } = fresh()
  m.register(1, { route: PROJECTS, projectId: null, title: 'Projects' })
  m.open(1, PAPER(7), 3, { title: 'A' })
  m.rehome(1)
  assert.equal(m.get(1), null)
  assert.deepEqual(m.windowIds(), [])
})

test('a deliberate close forgets the window WITHOUT re-homing', () => {
  const { m } = fresh()
  m.register(1, { route: PROJECTS, projectId: null, title: 'Projects' })
  m.register(2, { route: PROJECTS, projectId: null, title: 'Projects' })
  m.open(1, PAPER(7), 3, { title: 'A' })
  // The user closed this window; its tabs went with it on purpose. Re-homing
  // them into another window would resurrect pages they just dismissed.
  m.forget(1)
  assert.equal(m.get(1), null)
  assert.equal(m.get(2)!.tabs.some((t) => t.key === 'paper:3:7'), false)
})

test('which window holds a key is answerable, for parenting a dialog', () => {
  const { m } = fresh()
  m.register(1, { route: PROJECTS, projectId: null, title: 'Projects' })
  m.register(2, { route: PROJECTS, projectId: null, title: 'Projects' })
  m.open(2, PAPER(7), 3, { title: 'A' })
  assert.equal(m.windowHolding('paper:3:7'), 2)
  assert.equal(m.windowHolding('paper:3:404'), null)
})

test('stale marking never auto-closes the tab', () => {
  const { m } = fresh()
  m.register(1, { route: PROJECTS, projectId: null, title: 'Projects' })
  m.open(1, PAPER(7), 3, { title: 'A' })
  m.markStale((key) => key === 'paper:3:7', 'That paper was deleted')
  const t = m.get(1)!.tabs.find((x) => x.key === 'paper:3:7')
  // Silently removing a tab the user opened is worse than showing them what
  // happened.
  assert.ok(t)
  assert.equal(t.stale, 'That paper was deleted')
})

test('a push is emitted for every window a change touched, and no other', () => {
  const { m, pushes } = fresh()
  m.register(1, { route: PROJECTS, projectId: null, title: 'Projects' })
  m.register(2, { route: PROJECTS, projectId: null, title: 'Projects' })
  pushes.length = 0
  m.open(1, GRAPH, 3, { title: 'G' })
  assert.deepEqual(pushes, [1])
  pushes.length = 0
  // A rejected op pushes nothing: the renderer's mirror is still correct.
  m.close(1, 'graph:3', { expectedRev: 0 })
  assert.deepEqual(pushes, [])
})

test('viewState is stored per tab and survives a re-home', () => {
  const { m } = fresh()
  m.register(1, { route: PROJECTS, projectId: null, title: 'Projects' })
  m.register(2, { route: PROJECTS, projectId: null, title: 'Projects' })
  m.open(1, PAPER(7), 3, { title: 'A' })
  m.setViewState(1, 'paper:3:7', JSON.stringify({ page: 4, find: 'kemp' }))
  m.rehome(1)
  const t = m.get(2)!.tabs.find((x) => x.key === 'paper:3:7')!
  assert.deepEqual(JSON.parse(t.viewState!), { page: 4, find: 'kemp' })
})

test('a title is bounded, so a tab cannot carry a megabyte of text', () => {
  const { m } = fresh()
  m.register(1, { route: PROJECTS, projectId: null, title: 'Projects' })
  m.open(1, PAPER(7), 3, { title: 'x'.repeat(5000) })
  const t = m.get(1)!.tabs.find((x) => x.key === 'paper:3:7')!
  assert.ok(t.title.length <= 300)
})

test('a project-scoped route with no project is refused, not keyed as null', () => {
  const { m } = fresh()
  m.register(1, { route: PROJECTS, projectId: null, title: 'Projects' })
  assert.throws(() => m.open(1, GRAPH, null, { title: 'G' }), /project/i)
  assert.equal(m.get(1)!.tabs.length, 1)
})

test('a rejected open reports no key, and the rev to resync to', () => {
  const { m } = fresh()
  m.register(1, { route: PROJECTS, projectId: null, title: 'Projects' })
  const r = m.open(1, GRAPH, 3, { title: 'G', expectedRev: 999 })
  // A result shape-identical to a successful create would have the renderer draw
  // a tab that does not exist.
  assert.equal(r.key, null)
  assert.equal(r.rev, m.get(1)!.rev)
  assert.equal(m.get(1)!.tabs.length, 1)
})

test('every rejection carries the authoritative rev, so it is self-correcting', () => {
  const { m } = fresh()
  m.register(1, { route: PROJECTS, projectId: null, title: 'Projects' })
  m.open(1, GRAPH, 3, { title: 'G' })
  const real = m.get(1)!.rev
  for (const r of [
    m.activate(1, 'graph:3', { expectedRev: 1 }),
    m.close(1, 'graph:3', { expectedRev: 1 }),
    m.reorder(1, ['graph:3', 'projects'], { expectedRev: 1 })
  ]) {
    assert.equal(r.ok, false)
    // Without this a renderer whose push was dropped would be rejected forever.
    assert.equal(r.rev, real)
  }
})

test('a duplicate key is one the shared vocabulary can read back', () => {
  const { m } = fresh()
  m.register(1, { route: PROJECTS, projectId: null, title: 'Projects' })
  m.open(1, PAPER(7), 3, { title: 'A' })
  m.open(1, PAPER(7), 3, { title: 'A', forceNew: true })
  const dup = m.get(1)!.tabs.map((t) => t.key).find((k) => k.includes('#'))!
  assert.equal(dup, 'paper:3:7#2')
  // Main recovers a route from a key when it re-homes a crashed window and when it
  // restores a session, so a key it can emit but not parse is a page that silently
  // fails to come back.
  assert.match(dup, TAB_KEY_PATTERN)
  const parsed = parseTabKey(dup)
  assert.ok(parsed)
  assert.equal(parsed.duplicate, 2)
  assert.equal(parsed.workId, 7)
  assert.equal(duplicateKey(tabKey(parsed.route, parsed.projectId), parsed.duplicate), dup)
})

test('re-homing never evicts the surviving window to make room', () => {
  const { m } = fresh()
  m.register(1, { route: PROJECTS, projectId: null, title: 'Projects' })
  m.register(2, { route: PROJECTS, projectId: null, title: 'Projects' })
  // Fill the heir to the cap with pages the user IS looking at.
  const heirKeys: string[] = []
  for (let i = 0; i < MAX_TABS_PER_WINDOW - 1; i++) {
    heirKeys.push(m.open(2, PAPER(100 + i), 9, { title: `h${i}` }).key!)
  }
  for (let i = 0; i < 5; i++) m.open(1, PAPER(200 + i), 9, { title: `d${i}` })
  m.rehome(1)
  const surviving = new Set(m.get(2)!.tabs.map((t) => t.key))
  // The live window's pages are not sacrificed for a crashed one's.
  for (const k of heirKeys) assert.ok(surviving.has(k), `lost heir tab ${k}`)
  // Nor is the crashed window's work deleted to satisfy the cap: every candidate is
  // a page the user opened, so the overshoot is tolerated and trimmed by the next
  // ordinary open — which takes a rescued tab, not one in use.
  for (let i = 0; i < 5; i++) assert.ok(surviving.has(`paper:9:${200 + i}`))
  m.open(2, GRAPH, 9, { title: 'G' })
  assert.equal(m.get(2)!.tabs.length, MAX_TABS_PER_WINDOW)
  const after = new Set(m.get(2)!.tabs.map((t) => t.key))
  for (const k of heirKeys) assert.ok(after.has(k), `trim took an in-use tab ${k}`)
})

test('a re-homed but still-live window can be tracked again', () => {
  const { m } = fresh()
  m.register(1, { route: PROJECTS, projectId: null, title: 'Projects' })
  m.register(2, { route: PROJECTS, projectId: null, title: 'Projects' })
  // A renderer can crash and be reloaded into the SAME window, which leaves that
  // window alive and untracked; its next op must not throw.
  m.rehome(1)
  assert.equal(m.tracks(1), false)
  m.register(1, { route: PROJECTS, projectId: null, title: 'Projects' })
  assert.equal(m.tracks(1), true)
  assert.doesNotThrow(() => m.open(1, GRAPH, 3, { title: 'G' }))
})

test('registering a tracked window does not wipe its tabs', () => {
  const { m } = fresh()
  m.register(1, { route: PROJECTS, projectId: null, title: 'Projects' })
  m.open(1, PAPER(7), 3, { title: 'A' })
  m.register(1, { route: PROJECTS, projectId: null, title: 'Projects' })
  assert.equal(m.get(1)!.tabs.length, 2)
})

test('the DTO carries no field the contract does not declare', () => {
  const { m } = fresh()
  m.register(1, { route: PROJECTS, projectId: null, title: 'Projects' })
  m.open(1, PAPER(7), 3, { title: 'A' })
  const t = m.get(1)!.tabs[0] as Record<string, unknown>
  // `lastUsed` is LRU bookkeeping, not part of what a tab is; a field crossing IPC
  // that the contract does not name is one the renderer may come to depend on with
  // nothing saying so.
  assert.equal('lastUsed' in t, false)
  assert.deepEqual(
    Object.keys(t).sort(),
    ['focusNonce', 'key', 'projectId', 'route', 'title', 'viewState'].sort()
  )
})

test('the projection cannot be used to mutate the authority', () => {
  const { m } = fresh()
  m.register(1, { route: PROJECTS, projectId: null, title: 'Projects' })
  const snapshot = m.get(1)!
  snapshot.tabs.length = 0
  snapshot.activeKey = 'nonsense'
  assert.equal(m.get(1)!.tabs.length, 1)
  assert.equal(m.get(1)!.activeKey, 'projects')
})

// ---------------------------------------------------------------- setRoute --
// A tab's KEY is its identity and never moves; what it SHOWS does. Everything
// below is about main staying correct about the second without disturbing the
// first, because main is what answers "is this page already open here" and
// "which tab did that deleted paper belong to".

test('a tab that navigates keeps its key but reports its new page', () => {
  const { m } = fresh()
  m.register(1, { route: GRAPH, projectId: 3, title: 'Connectome' })
  const key = tabKey(GRAPH, 3)
  assert.equal(m.setRoute(1, key, PAPER(7), 3, { title: 'A paper' }), true)
  const s = m.get(1)!
  // The key is untouched — re-keying would break every op the renderer has in
  // flight against this tab, and would let two tabs collide onto one key simply
  // by being steered to the same page.
  assert.equal(s.tabs[0].key, key)
  assert.deepEqual(s.tabs[0].route, PAPER(7))
  assert.equal(s.tabs[0].title, 'A paper')
})

test('navigating does not bump the rev, so it cannot reject an op in flight', () => {
  const { m, pushes } = fresh()
  m.register(1, { route: GRAPH, projectId: 3 })
  const before = m.get(1)!.rev
  m.setRoute(1, tabKey(GRAPH, 3), PAPER(7), 3)
  assert.equal(m.get(1)!.rev, before)
  // Still PUSHED: the strip's label and every dedupe answer depend on it.
  assert.equal(pushes.at(-1), 1)
})

test('opening a page finds the tab that has NAVIGATED to it, rather than duplicating', () => {
  const { m } = fresh()
  m.register(1, { route: GRAPH, projectId: 3 })
  m.setRoute(1, tabKey(GRAPH, 3), PAPER(7), 3)
  const res = m.open(1, PAPER(7), 3)
  assert.equal(res.focusedExisting, true, 'the page is already on screen; a second tab for it is the bug')
  assert.equal(m.get(1)!.tabs.length, 1)
})

test('a tab navigated AWAY frees its page, and re-opening it makes a new tab', () => {
  const { m } = fresh()
  m.register(1, { route: PAPER(7), projectId: 3 })
  const key = tabKey(PAPER(7), 3)
  m.setRoute(1, GRAPH, 3)
  m.setRoute(1, key, GRAPH, 3)
  const res = m.open(1, PAPER(7), 3)
  assert.equal(res.focusedExisting, false)
  // The original key is still OWNED by the first tab even though it no longer
  // shows that page, so the new tab must be suffixed rather than collide.
  assert.notEqual(res.key, key)
  assert.equal(new Set(m.get(1)!.tabs.map((t) => t.key)).size, 2, 'two tabs may never share a key')
})

test('staleness is judged on where a tab IS, not where it was opened', () => {
  const { m } = fresh()
  m.register(1, { route: GRAPH, projectId: 3 })
  m.setRoute(1, tabKey(GRAPH, 3), PAPER(7), 3)
  m.markStale((key) => key === tabKey(PAPER(7), 3), 'This paper was deleted')
  assert.equal(m.get(1)!.tabs[0].stale, 'This paper was deleted')
})

test('navigating clears a stale mark and the view state of the page that went', () => {
  const { m } = fresh()
  m.register(1, { route: PAPER(7), projectId: 3 })
  const key = tabKey(PAPER(7), 3)
  m.setViewState(1, key, '{"page":4}')
  m.markStale((k) => k === key, 'gone')
  assert.equal(m.get(1)!.tabs[0].stale, 'gone')
  m.setRoute(1, key, GRAPH, 3)
  const t = m.get(1)!.tabs[0]
  assert.equal(t.stale, undefined, 'the new page is not missing just because the old one was')
  assert.equal(t.viewState, null, 'a Connectome viewport restored into a paper is worse than nothing')
})

test('a sibling window holding a navigated-to page is reported, never focused', () => {
  const { m } = fresh()
  m.register(1, { route: GRAPH, projectId: 3 })
  m.register(2, { route: GRAPH, projectId: 3 })
  m.setRoute(2, tabKey(GRAPH, 3), PAPER(7), 3)
  const res = m.open(1, PAPER(7), 3)
  assert.deepEqual(res.alsoOpenIn, [2])
  assert.equal(res.windowId, 1, 'dedupe is per WINDOW: focus must not jump to another monitor')
  assert.equal(res.focusedExisting, false)
})

test('setRoute refuses a tab this window does not hold', () => {
  const { m } = fresh()
  m.register(1, { route: PROJECTS, projectId: null })
  assert.equal(m.setRoute(1, 'graph:99', GRAPH, 99), false)
})

test('a title arriving late renames without disturbing focus or the rev', () => {
  const { m } = fresh()
  m.register(1, { route: PAPER(7), projectId: 3 })
  const key = tabKey(PAPER(7), 3)
  const rev = m.get(1)!.rev
  const nonce = m.get(1)!.tabs[0].focusNonce
  assert.equal(m.setTitle(1, key, 'Evolutionary Optimization…'), true)
  assert.equal(m.get(1)!.tabs[0].title, 'Evolutionary Optimization…')
  assert.equal(m.get(1)!.rev, rev, 'a rename must not reject an op the user has in flight')
  assert.equal(
    m.get(1)!.tabs[0].focusNonce,
    nonce,
    'routing this through open() would re-run every scroll-to-evidence when a title landed'
  )
})

// ------------------------------------------------------------------ detach --
// The whole point of the two-phase lease is that NOTHING is ever lost. Every
// test below kills something in the gap and asserts the tab comes back.

test('a detach promises the tab without moving it', () => {
  const { m } = fresh()
  m.register(1, { route: GRAPH, projectId: 3 })
  m.open(1, PAPER(7), 3)
  const key = tabKey(PAPER(7), 3)
  const rev = m.get(1)!.rev
  assert.ok(m.beginDetach(1, key, 2))
  const s = m.get(1)!
  assert.equal(s.tabs.length, 2, 'the tab stays until the new window claims it')
  assert.equal(s.tabs.find((t) => t.key === key)!.detaching, true)
  assert.equal(s.rev, rev, 'nothing has left, so no op in flight may be rejected')
})

test('a tab in flight cannot be closed', () => {
  const { m } = fresh()
  m.register(1, { route: GRAPH, projectId: 3 })
  m.open(1, PAPER(7), 3)
  const key = tabKey(PAPER(7), 3)
  m.beginDetach(1, key, 2)
  assert.equal(m.close(1, key).ok, false, 'closing mid-handover is the one way to lose the page')
  assert.equal(m.get(1)!.tabs.length, 2)
})

test('one tab cannot be promised to two windows', () => {
  const { m } = fresh()
  m.register(1, { route: GRAPH, projectId: 3 })
  m.open(1, PAPER(7), 3)
  const key = tabKey(PAPER(7), 3)
  assert.ok(m.beginDetach(1, key, 2))
  assert.equal(m.beginDetach(1, key, 3), null)
})

test('adoption moves the tab atomically and replaces the new window’s seed', () => {
  const { m } = fresh()
  m.register(1, { route: GRAPH, projectId: 3 })
  m.open(1, PAPER(7), 3)
  const key = tabKey(PAPER(7), 3)
  m.beginDetach(1, key, 2)
  m.register(2, { route: PROJECTS, projectId: null })
  assert.equal(m.adopt(2, 1), true)

  assert.deepEqual(m.get(1)!.tabs.map((t) => t.key), [tabKey(GRAPH, 3)])
  const s2 = m.get(2)!
  assert.deepEqual(s2.tabs.map((t) => t.key), [key], 'the seed goes; a stray Projects tab was not asked for')
  assert.equal(s2.activeKey, key)
  assert.equal(s2.tabs[0].detaching, undefined)
})

test('a window with no promise adopts nothing, however many are in flight', () => {
  const { m } = fresh()
  m.register(1, { route: GRAPH, projectId: 3 })
  m.open(1, PAPER(7), 3)
  m.register(2, { route: PROJECTS, projectId: null })
  // Nothing promised anywhere: every window calls adopt at startup, so the
  // ordinary case must be a clean no.
  assert.equal(m.adopt(2, 1), false)
  // A tab promised to a DIFFERENT window. Window 2 must not receive it — that
  // is the whole reason the promise, not the caller, names the tab.
  m.beginDetach(1, tabKey(PAPER(7), 3), 3)
  assert.equal(m.adopt(2, 1), false)
  assert.equal(m.get(1)!.tabs.length, 2, 'and the tab is still where it was')
  assert.equal(m.get(1)!.tabs.find((t) => t.key === tabKey(PAPER(7), 3))!.detaching, true)
})

test('a window that never opens gives the tab back', () => {
  const { m } = fresh()
  m.register(1, { route: GRAPH, projectId: 3 })
  m.open(1, PAPER(7), 3)
  const key = tabKey(PAPER(7), 3)
  m.beginDetach(1, key, 2)
  // The promised window died before it could adopt.
  m.reconcileDetaches(() => false)
  assert.equal(m.get(1)!.tabs.find((t) => t.key === key)!.detaching, undefined)
  assert.equal(m.get(1)!.tabs.length, 2, 'the page is back where the user left it')
  assert.equal(m.close(1, key).ok, true, 'and is usable again')
})

test('an expired lease is reverted, and a late adoption is refused', () => {
  const { m } = fresh()
  m.register(1, { route: GRAPH, projectId: 3 })
  m.open(1, PAPER(7), 3)
  const key = tabKey(PAPER(7), 3)
  m.beginDetach(1, key, 2, 0)
  m.register(2, { route: PROJECTS, projectId: null })
  // Past the deadline the tab may already be back in use where it came from, so
  // honouring the handover now would move a page out from under the reader.
  assert.equal(m.adopt(2, 1, DETACH_LEASE_MS + 1), false)
  m.reconcileDetaches(() => true, DETACH_LEASE_MS + 1)
  assert.equal(m.get(1)!.tabs.find((t) => t.key === key)!.detaching, undefined)
})

test('detaching the LAST tab leaves the window open and empty', () => {
  const { m } = fresh()
  m.register(1, { route: PAPER(7), projectId: 3 })
  const key = tabKey(PAPER(7), 3)
  m.beginDetach(1, key, 2)
  m.register(2, { route: PROJECTS, projectId: null })
  assert.equal(m.adopt(2, 1), true)
  const s = m.get(1)!
  assert.equal(s.tabs.length, 0)
  assert.equal(s.activeKey, '', 'the user moved a page out; they did not ask to quit')
})

test('hasPendingDetach reports whether anything is still in flight', () => {
  const { m } = fresh()
  m.register(1, { route: GRAPH, projectId: 3 })
  m.open(1, PAPER(7), 3)
  assert.equal(m.hasPendingDetach(), false)
  m.beginDetach(1, tabKey(PAPER(7), 3), 2)
  assert.equal(m.hasPendingDetach(), true)
  m.reconcileDetaches(() => false)
  assert.equal(m.hasPendingDetach(), false)
})

test('stale marks are ADDITIVE: one deletion does not clear another’s mark', () => {
  const { m } = fresh()
  m.register(1, { route: PAPER(7), projectId: 3 })
  m.open(1, PAPER(8), 3)
  // Paper 7 goes. Its tab is marked.
  m.markStale((k) => k === tabKey(PAPER(7), 3), 'This paper was deleted')
  assert.equal(m.get(1)!.tabs[0].stale, 'This paper was deleted')
  // Now paper 8 goes, in a separate call that knows nothing about paper 7.
  m.markStale((k) => k === tabKey(PAPER(8), 3), 'This paper was deleted')
  const tabs = m.get(1)!.tabs
  assert.equal(tabs[0].stale, 'This paper was deleted', 'paper 7 is still gone')
  assert.equal(tabs[1].stale, 'This paper was deleted')
})

test('a target that comes back clears its mark, and only its own', () => {
  const { m } = fresh()
  m.register(1, { route: PAPER(7), projectId: 3 })
  m.open(1, PAPER(8), 3)
  m.markStale(() => true, 'gone')
  m.clearStale((k) => k === tabKey(PAPER(7), 3))
  const tabs = m.get(1)!.tabs
  assert.equal(tabs[0].stale, undefined)
  assert.equal(tabs[1].stale, 'gone')
})
