import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TabModel } from './tabs'
import { captureSession, parseSession, restoreWindow } from './tabs-session'
import { tabKey } from '../shared/tabKey'
import type { Route } from '../shared/nav'

const PAPER = (workId: number): Route => ({ name: 'paper', workId })
const GRAPH: Route = { name: 'graph' }
const PROJECTS: Route = { name: 'projects' }

function model(): TabModel {
  return new TabModel(() => {})
}

/**
 * Read a session that is expected to be wholly intact.
 *
 * Asserts `ok` rather than merely truthy, which is the point of the three-way
 * outcome: `partial` also carries a session, so a check for "did we get one"
 * passes while tabs are quietly going missing.
 */
function readOk(raw: string | null): ReturnType<typeof parseSession> & { outcome: 'ok' } {
  const read = parseSession(raw)
  assert.equal(read.outcome, 'ok', 'what this app just wrote must be readable by it, entire')
  return read as ReturnType<typeof parseSession> & { outcome: 'ok' }
}

/** Save and reload, exactly as a quit and a relaunch would. */
function roundTrip(m: TabModel): TabModel {
  const raw = JSON.stringify(
    captureSession(m, (id) => ({ bounds: { x: 10, y: 20, width: 1280, height: 800 }, maximized: id === 1 }))
  )
  const next = model()
  readOk(raw).session.windows.forEach((w, i) => restoreWindow(next, i + 1, w))
  return next
}

test('a session of several windows and tabs comes back intact', () => {
  const m = model()
  m.register(1, { route: PROJECTS, projectId: null, title: 'Projects' })
  m.open(1, GRAPH, 3, { title: 'Connectome' })
  m.open(1, PAPER(7), 3, { title: 'A paper' })
  m.register(2, { route: GRAPH, projectId: 5, title: 'Other' })

  const back = roundTrip(m)
  const w1 = back.get(1)!
  assert.deepEqual(
    w1.tabs.map((t) => t.title),
    ['Projects', 'Connectome', 'A paper']
  )
  assert.equal(w1.activeKey, tabKey(PAPER(7), 3), 'the page they were reading is the one they come back to')
  assert.equal(back.get(2)!.tabs.length, 1)
})

test('a tab’s view state survives, so a paper reopens where it was left', () => {
  const m = model()
  m.register(1, { route: PAPER(7), projectId: 3 })
  m.setViewState(1, tabKey(PAPER(7), 3), '{"page":12,"scroll":0.4}')
  assert.equal(roundTrip(m).get(1)!.tabs[0].viewState, '{"page":12,"scroll":0.4}')
})

test('deliberate duplicates of one page both come back', () => {
  const m = model()
  m.register(1, { route: PAPER(7), projectId: 3 })
  // Ctrl-clicked: the user wants the same paper twice, side by side.
  m.open(1, PAPER(7), 3, { forceNew: true })
  const back = roundTrip(m)
  assert.equal(back.get(1)!.tabs.length, 2, 'restoring must not dedupe what the user duplicated on purpose')
  assert.equal(new Set(back.get(1)!.tabs.map((t) => t.key)).size, 2)
})

test('a corrupt or absent session starts the app empty rather than failing', () => {
  assert.equal(parseSession('{"windows":').outcome, 'unreadable', 'a crash mid-write must not be fatal')
  assert.equal(parseSession('{"windows":[{"tabs":[],"activeKey":"","extra":1}]}').outcome, 'unreadable')
})

// THE DEFECT THIS FILE EXISTS FOR, at its narrowest.
//
// Every one of these used to answer the same `null`, and the caller turned all
// of them into one blank window with nothing said. A blank window is also what a
// first install looks like, so a user whose thirty tabs had just been discarded
// saw a screen indistinguishable from the one they saw on day one.
test('an EMPTY session and an UNREADABLE one are different answers', () => {
  assert.equal(parseSession(null).outcome, 'none', 'no row is a user who had nothing open')
  assert.equal(parseSession('').outcome, 'none')
  assert.equal(
    parseSession('{"windows":[]}').outcome,
    'none',
    'a session that stored no window lost nothing'
  )
  assert.equal(
    parseSession('not json at all').outcome,
    'unreadable',
    'a session that WAS written and cannot be read back is a loss, not an empty desk'
  )
  assert.equal(
    parseSession('{"windows":[{"tabs":[{"key":"../../etc/passwd"}],"activeKey":"x"}]}').outcome,
    'unreadable',
    'a stored window whose every tab is unreadable is a window that went missing'
  )
})

test('a session that came back SHORT says how much of it went', () => {
  const good = '{"key":"graph:1","route":{"name":"graph"},"projectId":1,"title":"Connectome"}'
  const bad = '{"key":"graph:2","route":{"name":"telepathy"},"projectId":1,"title":"x"}'
  const read = parseSession(
    `{"windows":[{"tabs":[${good},${bad},${bad}],"activeKey":"graph:1"},{"tabs":[${bad}],"activeKey":"x"}]}`
  )
  assert.equal(read.outcome, 'partial', 'tabs were dropped, so this is not a clean restore')
  if (read.outcome !== 'partial') return
  assert.equal(read.lostTabs, 3, 'both holes in the first window AND the whole of the second')
  assert.equal(read.lostWindows, 1, 'a window with nothing readable in it did not come back')
  assert.equal(read.session.windows.length, 1, 'what could be restored still is')
})

test('an unreadable key or an oversized payload costs that TAB, not the session', () => {
  const good = '{"key":"graph:1","route":{"name":"graph"},"projectId":1,"title":"Connectome"}'
  const badKey = '{"key":"../../etc/passwd","route":{"name":"graph"},"projectId":1,"title":"x"}'
  const huge = `{"key":"ranking:1","route":{"name":"ranking"},"projectId":1,"title":"x","viewState":"${'a'.repeat(70 * 1024)}"}`

  const read = parseSession(
    `{"windows":[{"tabs":[${badKey},${good},${huge}],"activeKey":"graph:1"}]}`
  )
  assert.equal(read.outcome, 'partial', 'one bad tab must not discard the window, but IS a loss')
  if (read.outcome !== 'partial') return
  const m = model()
  restoreWindow(m, 1, read.session.windows[0])
  assert.deepEqual(
    m.get(1)!.tabs.map((t) => t.key),
    ['graph:1'],
    'the readable tab comes back; the two that could not be read are dropped'
  )
})

test('a tab naming a route this build does not have is dropped, not fatal', () => {
  const good = '{"key":"graph:1","route":{"name":"graph"},"projectId":1,"title":"Connectome"}'
  const retired = '{"key":"graph:1","route":{"name":"telepathy"},"projectId":1,"title":"x"}'
  const read = parseSession(`{"windows":[{"tabs":[${retired},${good}],"activeKey":"graph:1"}]}`)
  assert.equal(read.outcome, 'partial', 'a session written by another build must still open the app')
  if (read.outcome !== 'partial') return
  const m = model()
  restoreWindow(m, 1, read.session.windows[0])
  assert.equal(m.get(1)!.tabs.length, 1)
})

test('a window naming more tabs than the cap allows is refused as malformed', () => {
  const tab = (i: number) =>
    `{"key":"paper:1:${i}","route":{"name":"paper","workId":${i}},"projectId":1,"title":"p"}`
  const many = Array.from({ length: 80 }, (_, i) => tab(i)).join(',')
  assert.equal(
    parseSession(`{"windows":[{"tabs":[${many}],"activeKey":"paper:1:0"}]}`).outcome,
    'unreadable',
    'restoring past the cap would only have the model evict on launch — and it is still a loss'
  )
})

test('an empty window is not saved: it is not a state anyone chose to leave', () => {
  const m = model()
  m.register(1, { route: PAPER(7), projectId: 3 })
  m.beginDetach(1, tabKey(PAPER(7), 3), 2)
  m.register(2, { route: PROJECTS, projectId: null })
  m.adopt(2, 1)
  assert.equal(m.get(1)!.tabs.length, 0)
  const saved = captureSession(m, () => ({}))
  assert.equal(saved.windows.length, 1, 'only the window that actually holds the page comes back')
})
