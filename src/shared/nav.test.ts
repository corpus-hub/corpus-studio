import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ROUTE_NAMES,
  PROJECT_LEVEL_ROUTES,
  isRouteName,
  needsProject,
  type Route
} from './nav'
import { TAB_KEY_PATTERN, tabKey, parseTabKey, isSameTarget } from './tabKey'

test('every route name is enumerated exactly once', () => {
  assert.equal(new Set(ROUTE_NAMES).size, ROUTE_NAMES.length)
  // The 11 screens the shell can show. A route added without a key rule would
  // otherwise silently collide with another route's tab.
  assert.equal(ROUTE_NAMES.length, 11)
})

test('isRouteName rejects anything not in the enumeration', () => {
  for (const n of ROUTE_NAMES) assert.equal(isRouteName(n), true)
  for (const n of ['', 'Paper', 'papers', '__proto__', 'constructor', 'toString']) {
    assert.equal(isRouteName(n), false, n)
  }
})

test('only projects and schemas are reachable without a project', () => {
  assert.deepEqual([...PROJECT_LEVEL_ROUTES].sort(), ['projects', 'schemas'])
  for (const n of ROUTE_NAMES) {
    assert.equal(needsProject(n), !PROJECT_LEVEL_ROUTES.has(n), n)
  }
})

test('a project-scoped key always carries the project', () => {
  // The same paper read inside two projects is two different pages: relevance,
  // inclusion status and overrides all live in project_work. A key without the
  // project would make one of those readings silently replace the other.
  assert.equal(tabKey({ name: 'paper', workId: 7 }, 3), 'paper:3:7')
  assert.equal(tabKey({ name: 'paper', workId: 7 }, 4), 'paper:4:7')
  assert.notEqual(
    tabKey({ name: 'paper', workId: 7 }, 3),
    tabKey({ name: 'paper', workId: 7 }, 4)
  )
  for (const name of ROUTE_NAMES) {
    if (PROJECT_LEVEL_ROUTES.has(name)) continue
    const key = tabKey({ name } as Route, 12)
    assert.match(key, /:12(:|$)/, `${name} -> ${key}`)
  }
})

test('an app-level route is a singleton with no project in its key', () => {
  assert.equal(tabKey({ name: 'projects' }, 3), 'projects')
  assert.equal(tabKey({ name: 'schemas' }, null), 'schemas')
  // The project the sidebar happens to be showing must not fork the tab.
  assert.equal(tabKey({ name: 'projects' }, 3), tabKey({ name: 'projects' }, 99))
})

test('a paper with no work selected is one tab per project', () => {
  assert.equal(tabKey({ name: 'paper' }, 3), 'paper:3:new')
  assert.equal(tabKey({ name: 'paper', workId: undefined }, 3), 'paper:3:new')
  assert.notEqual(tabKey({ name: 'paper' }, 3), tabKey({ name: 'paper' }, 4))
})

test('focus params are position, not identity', () => {
  // Opening the same paper at a different quote must land in the SAME tab and
  // move within it, not open a second copy of the page.
  const base = tabKey({ name: 'paper', workId: 7 }, 3)
  assert.equal(tabKey({ name: 'paper', workId: 7, evidenceId: 12 }, 3), base)
  assert.equal(tabKey({ name: 'paper', workId: 7, quote: 'anything' }, 3), base)
  assert.equal(
    tabKey({ name: 'extraction', rowKey: 'r1', schemaId: 2 }, 3),
    tabKey({ name: 'extraction' }, 3)
  )
  assert.equal(tabKey({ name: 'review', factId: 9 }, 3), tabKey({ name: 'review' }, 3))
})

test('a project-scoped route without a project is refused, not silently keyed', () => {
  // `graph:null` or `graph:undefined` would be a real, openable tab pointing at
  // no project, and every query it fired would be for project NaN.
  for (const name of ROUTE_NAMES) {
    if (PROJECT_LEVEL_ROUTES.has(name)) continue
    assert.throws(() => tabKey({ name } as Route, null), /project/i, name)
  }
})

test('a non-integer or negative project id is refused', () => {
  for (const bad of [1.5, -1, NaN, Infinity]) {
    assert.throws(() => tabKey({ name: 'graph' }, bad), /project/i, String(bad))
  }
})

test('a non-integer or negative workId is refused', () => {
  for (const bad of [1.5, -1, NaN, Infinity]) {
    assert.throws(() => tabKey({ name: 'paper', workId: bad }, 3), /work/i, String(bad))
  }
})

test('every generated key matches the pattern main validates against', () => {
  const keys = [
    tabKey({ name: 'projects' }, null),
    tabKey({ name: 'schemas' }, null),
    tabKey({ name: 'paper' }, 3),
    tabKey({ name: 'paper', workId: 7 }, 3),
    ...ROUTE_NAMES.filter((n) => !PROJECT_LEVEL_ROUTES.has(n)).map((n) =>
      tabKey({ name: n } as Route, 3)
    )
  ]
  for (const k of keys) assert.match(k, TAB_KEY_PATTERN, k)
})

test('the pattern refuses free text, traversal and injection shapes', () => {
  for (const bad of [
    '',
    'paper',
    'paper:',
    'paper:3:',
    'paper:3:7:8',
    'paper:-1:7',
    'paper:3:new:1',
    'PAPER:3:7',
    'paper:3:7 ',
    ' paper:3:7',
    'paper:3:7\n',
    '../../etc/passwd',
    '__proto__:3',
    'paper:3:7; DROP TABLE work',
    `paper:3:${'9'.repeat(300)}`
  ]) {
    assert.equal(TAB_KEY_PATTERN.test(bad), false, JSON.stringify(bad))
  }
})

test('parseTabKey round-trips every generated key', () => {
  const cases: { route: Route; projectId: number | null }[] = [
    { route: { name: 'projects' }, projectId: null },
    { route: { name: 'schemas' }, projectId: null },
    { route: { name: 'paper' }, projectId: 3 },
    { route: { name: 'paper', workId: 7 }, projectId: 3 },
    { route: { name: 'graph' }, projectId: 3 },
    { route: { name: 'extraction' }, projectId: 88 }
  ]
  for (const c of cases) {
    const key = tabKey(c.route, c.projectId)
    const parsed = parseTabKey(key)
    assert.ok(parsed, key)
    assert.equal(parsed.name, c.route.name)
    assert.equal(parsed.projectId, PROJECT_LEVEL_ROUTES.has(c.route.name) ? null : c.projectId)
    assert.equal(parsed.workId, c.route.name === 'paper' ? (c.route.workId ?? null) : null)
    // Parsing then re-keying must be the identity, or main and the renderer could
    // disagree about which tab a key names.
    assert.equal(tabKey(parsed.route, parsed.projectId), key)
  }
})

test('parseTabKey rejects what the pattern rejects, and never throws', () => {
  for (const bad of ['', 'nope:1', 'paper:3:7:8', 'graph', '__proto__:1', 'paper:3:new:1']) {
    assert.equal(parseTabKey(bad), null, JSON.stringify(bad))
  }
})

test('isSameTarget ignores focus but not identity', () => {
  const a: Route = { name: 'paper', workId: 7, evidenceId: 1 }
  const b: Route = { name: 'paper', workId: 7, evidenceId: 2 }
  const c: Route = { name: 'paper', workId: 8 }
  assert.equal(isSameTarget(a, 3, b, 3), true)
  assert.equal(isSameTarget(a, 3, a, 4), false)
  assert.equal(isSameTarget(a, 3, c, 3), false)
})
