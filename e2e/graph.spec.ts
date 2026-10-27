import { test, expect, goto, api, selectProject } from './helpers/electron'
import type { Page } from '@playwright/test'
import type { GraphDTO, SavedFrontierDTO, ProjectDTO } from '../src/shared/contract'
import type { CitationEdgeDTO } from '../src/shared/types'

/**
 * The Connectome explores ONE paper at a time. It boots with an EMPTY canvas
 * and a papers rail; picking a paper roots the graph on it and pulls that
 * paper's citation neighbourhood in, and "Expand citations" grows the graph
 * from any node already on the canvas without reloading it.
 *
 * (Superseded design: every work was drawn at once behind a node-count slider
 * and a "X of Y works shown" line. Those specs are gone; each assertion they
 * made has an equivalent here against the surface that replaced it.)
 */

/**
 * Root the exploration on `workId`, waiting until the canvas actually holds
 * nodes — the expansion is an async `getCitations` round-trip, so asserting
 * straight after the click would race it.
 */
async function focusPaper(window: Page, workId: number): Promise<void> {
  await window.click(`[data-testid="graph-paper-${workId}"]`)
  await expect(window.locator(`[data-testid="graph-paper-${workId}"]`)).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect
    .poll(() => window.locator('[data-testid="graph-svg"] circle.cg-ring-c').count(), {
      timeout: 15_000
    })
    .toBeGreaterThan(0)
}

/** The rail lists every work in the project, so its first row is a real id. */
async function firstRailWorkId(window: Page): Promise<number> {
  const id = await window
    .locator('[data-testid^="graph-paper-"]')
    .first()
    .getAttribute('data-testid')
  const n = Number((id ?? '').replace('graph-paper-', ''))
  expect(Number.isFinite(n) && n > 0, `rail yielded a real work id (got ${id})`).toBe(true)
  return n
}

/** Every node endpoint reachable from `workId`'s citations, plus itself. */
function neighbourhood(workId: number, edges: CitationEdgeDTO[]): Set<number> {
  const ids = new Set<number>([workId])
  for (const e of edges) {
    ids.add(e.citing_work_id)
    ids.add(e.cited_work_id)
  }
  return ids
}

test('the canvas starts empty and the rail lists every work in the project', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'graph')

  await expect(window.locator('[data-testid="graph-svg"]')).toBeVisible()

  // NOTHING is drawn before a paper is chosen, and the screen SAYS so rather
  // than presenting a blank canvas as a finished answer.
  await expect(window.locator('[data-testid="graph-canvas-empty"]')).toBeVisible()
  await expect(window.locator('[data-testid="graph-count"]')).toHaveText('No paper selected')
  await expect(window.locator('[data-testid="graph-svg"] circle.cg-ring-c')).toHaveCount(0)

  // The rail is the entry point, and it is DB-derived: one row per graph node,
  // each addressed by its real work id and carrying its real title.
  const g = await api<GraphDTO>(window, 'getGraph', 1, { limit: 1000, minRelevance: 0 })
  expect(g.nodes.length, 'the seeded project has works to explore').toBeGreaterThan(0)
  const rows = window.locator('[data-testid^="graph-paper-"]')
  await expect(rows).toHaveCount(g.nodes.length)
  for (const n of g.nodes) {
    await expect(
      window.locator(`[data-testid="graph-paper-${n.id}"]`),
      `rail row for work ${n.id}`
    ).toContainText(n.title.slice(0, 30))
  }
})

test('picking a paper roots the graph on its citation neighbourhood', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'graph')

  const workId = await firstRailWorkId(window)
  await focusPaper(window, workId)

  // The empty state retires the moment there is something to look at.
  await expect(window.locator('[data-testid="graph-canvas-empty"]')).toHaveCount(0)

  // What is drawn is EXACTLY that paper's citation neighbourhood, cross-checked
  // against the DB-backed API rather than against the screen's own arithmetic.
  const edges = await api<CitationEdgeDTO[]>(window, 'getCitations', workId)
  expect(edges.length, 'the rail is sorted by relevance, so its top paper has citations')
    .toBeGreaterThan(0)
  const ids = neighbourhood(workId, edges)

  const drawn = window.locator('[data-testid="graph-svg"] circle.cg-ring-c')
  await expect.poll(() => drawn.count(), { timeout: 15_000 }).toBe(ids.size)
  // One line per citation, likewise exact.
  await expect(window.locator('[data-testid="graph-svg"] line.cg-edge')).toHaveCount(edges.length)

  // The count line reports the same three numbers in the app's own words — it
  // is derived, never a guess.
  await expect(window.locator('[data-testid="graph-count"]')).toHaveText(
    `${ids.size} works · ${edges.length} citations · 1 expanded`
  )
})

test('expanding a second node GROWS the graph instead of replacing it', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'graph')

  const workId = await firstRailWorkId(window)
  await focusPaper(window, workId)

  const drawn = window.locator('[data-testid="graph-svg"] circle.cg-ring-c')
  const before = await drawn.count()

  // Rooting a paper also expands it, so its own button must refuse to run
  // again — a control that re-ran would claim work it is not doing.
  await expect(window.locator('[data-testid="graph-expand-citations"]')).toBeDisabled()

  const edges = await api<CitationEdgeDTO[]>(window, 'getCitations', workId)
  const neighbourId = [...neighbourhood(workId, edges)].find((id) => id !== workId)
  expect(neighbourId, 'the root paper has at least one citation neighbour').toBeTruthy()

  const neighbourEdges = await api<CitationEdgeDTO[]>(window, 'getCitations', neighbourId!)
  const grown = new Set([...neighbourhood(workId, edges), ...neighbourhood(neighbourId!, neighbourEdges)])
  expect(grown.size, 'expanding the neighbour really adds nodes').toBeGreaterThan(before)

  // Select the neighbour by its TITLE: node <g>s carry `data-title`, and the
  // force sim re-orders the DOM as they move, so an index-based handle would
  // resolve to a different node between the read and the click.
  const g = await api<GraphDTO>(window, 'getGraph', 1, { limit: 1000, minRelevance: 0 })
  const neighbourTitle = g.nodes.find((n) => n.id === neighbourId)!.title
  const node = await window.waitForSelector(
    `[data-testid="graph-svg"] g.gnode[data-title="${neighbourTitle.replace(/"/g, '\\"')}"]`
  )
  await node.dispatchEvent('click')

  const expandBtn = window.locator('[data-testid="graph-expand-citations"]')
  await expect(expandBtn).toBeEnabled()
  await expandBtn.click()

  // GROWTH, not a reload: the canvas ends up holding the UNION of both
  // neighbourhoods, so nothing that was on screen was thrown away.
  await expect.poll(() => drawn.count(), { timeout: 15_000 }).toBe(grown.size)
  await expect(window.locator('[data-testid="graph-count"]')).toContainText('2 expanded')
  // Having expanded it, the control says so and refuses to run twice.
  await expect(expandBtn).toBeDisabled()
  await expect(expandBtn).toHaveText('Citations expanded')
})

/**
 * REGRESSION: the graph must never paint its nodes stacked at SVG coordinate
 * 0,0 (the canvas top-left) before jumping to their laid-out positions.
 *
 * The original cause was NOT the force simulation: d3 wrote the correct
 * `transform="translate(x,y)"` attribute from the first tick, but the node
 * groups also carried the global `nodePop` class whose keyframe animates a CSS
 * `transform: scale()`. On SVG elements a CSS transform OVERRIDES the transform
 * presentation attribute, so for the animation's full 300ms every node computed
 * to `matrix(.4,0,0,.4,0,0)` — scaled and parked on the origin.
 *
 * The fix computes the layout synchronously before appending any element and
 * uses an opacity-only fade. This samples real frames while the graph is first
 * ROOTED and again while it GROWS — growth being the second data join, which
 * the incremental-expansion redesign added and which reuses the live
 * simulation. It fails if any frame shows a CLUSTER of nodes at the origin, a
 * computed transform that is not a plain translate, or a layout collapsed onto
 * a point.
 */
test('graph paints already laid out — no 0,0 flash on first root or on growth', async ({
  launch
}) => {
  const { window } = await launch()

  const probe = `(() => {
    const svg = document.querySelector('[data-testid="graph-svg"]');
    if (!svg) return { present: false };
    const gs = Array.from(svg.querySelectorAll('g.gnode'));
    const box = svg.getBoundingClientRect();
    const pts = gs.map((g) => {
      const b = g.getBoundingClientRect();
      return { x: b.x - box.x, y: b.y - box.y, ct: getComputedStyle(g).transform };
    });
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    return {
      present: true,
      n: gs.length,
      atOrigin: pts.filter((p) => p.x < 60 && p.y < 60).length,
      scaled: pts.filter((p) => /matrix\\(0?\\.\\d/.test(p.ct)).length,
      // Bounding-box extent of the node cloud — guards against a degenerate
      // "everything stacked on one point" layout passing the origin checks.
      spreadX: pts.length ? Math.round(Math.max.apply(null, xs) - Math.min.apply(null, xs)) : 0,
      spreadY: pts.length ? Math.round(Math.max.apply(null, ys) - Math.min.apply(null, ys)) : 0
    };
  })()`

  type Frame = {
    present: boolean
    n?: number
    atOrigin?: number
    scaled?: number
    spreadX?: number
    spreadY?: number
  }
  const frames: Frame[] = []
  const sampleBurst = async (count: number): Promise<void> => {
    for (let i = 0; i < count; i++) {
      frames.push((await window.evaluate(probe)) as Frame)
      await window.waitForTimeout(15)
    }
  }

  // Opening the project card routes straight to the Connectome, but the canvas
  // is empty until a paper roots it — so the FIRST painted frames of the graph
  // are the ones right after the rail click, and sampling starts there.
  await selectProject(window, 1)
  const workId = await firstRailWorkId(window)
  await window.click(`[data-testid="graph-paper-${workId}"]`)
  await sampleBurst(25)

  const edges = await api<CitationEdgeDTO[]>(window, 'getCitations', workId)
  const neighbourId = [...neighbourhood(workId, edges)].find((id) => id !== workId)
  expect(neighbourId, 'the root paper has a neighbour to expand').toBeTruthy()
  const g = await api<GraphDTO>(window, 'getGraph', 1, { limit: 1000, minRelevance: 0 })
  const neighbourTitle = g.nodes.find((n) => n.id === neighbourId)!.title
  const node = await window.waitForSelector(
    `[data-testid="graph-svg"] g.gnode[data-title="${neighbourTitle.replace(/"/g, '\\"')}"]`
  )
  await node.dispatchEvent('click')
  await window.click('[data-testid="graph-expand-citations"]')
  await sampleBurst(20)

  const withNodes = frames.filter((f) => f.present && (f.n ?? 0) > 0)
  expect(withNodes.length, 'frames that actually contained nodes').toBeGreaterThan(15)
  // A single node may legitimately settle near a corner; the artifact is a
  // CLUSTER sharing the untranslated origin.
  const bad = withNodes.filter((f) => (f.atOrigin ?? 0) >= 3 || (f.scaled ?? 0) > 0)
  expect(bad, `frames with nodes clustered at 0,0: ${JSON.stringify(bad)}`).toHaveLength(0)

  // Every sampled frame must show a genuinely SPREAD OUT layout — i.e. the graph
  // was already laid out when it was first painted, not collapsed onto a point
  // (which would otherwise satisfy the origin checks above).
  const collapsed = withNodes.filter((f) => (f.spreadX ?? 0) < 100 || (f.spreadY ?? 0) < 100)
  expect(collapsed, `frames with a collapsed layout: ${JSON.stringify(collapsed)}`).toHaveLength(0)
})

test('color-by legend present', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'graph')
  await expect(window.locator('[data-testid="graph-legend"]')).toBeVisible()
  await expect(window.locator('[data-testid="graph-legend"] .legend-item').first()).toBeVisible()
})

test('selecting a node fills the inspector and offers Open paper detail', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'graph')

  // The inspector is always present. With no paper rooted it holds a prompt,
  // never a half-filled panel nor an action that would open nothing.
  const inspector = window.locator('[data-testid="graph-node-detail"]')
  await expect(inspector).toBeVisible()
  await expect(inspector.locator('.cg-btn-open')).toHaveCount(0)

  const workId = await firstRailWorkId(window)
  await focusPaper(window, workId)

  // Each node is a <g class="gnode"> (which carries the click handler). The
  // node title lives on a `data-title` attribute, NOT an SVG <title> — an SVG
  // <title> renders a native OS tooltip that would overlap our styled
  // hovercard, so it was removed. The force sim re-orders the DOM as nodes
  // move, so pin ONE element handle and use it for BOTH the title read and the
  // click — otherwise `.first()` can resolve to different nodes across calls.
  const nodeHandle = await window.waitForSelector('[data-testid="graph-svg"] g.gnode')
  const nodeTitle = (
    (await nodeHandle.evaluate((g) => g.getAttribute('data-title') ?? '')) as string
  ).trim()
  expect(nodeTitle, 'every node carries its title for the inspector and hovercard').not.toBe('')
  // dispatchEvent fires the group's click listener on exactly THIS node,
  // regardless of any overlapping node painted on top by the live force layout.
  await nodeHandle.dispatchEvent('click')
  await expect(inspector).toContainText(nodeTitle)

  // The two rankings stay SEPARATE (never fused into one score), and BOTH
  // citation directions are stated — a paper that cites eleven others and is
  // cited by none must not read as a bare "0".
  await expect(inspector).toContainText('TOPIC RELEVANCE')
  await expect(inspector).toContainText('EXPANSION PRIORITY')
  await expect(inspector).toContainText('CITED BY')
  await expect(inspector).toContainText('REFERENCES')

  await expect(inspector.locator('.cg-btn-open')).toBeVisible()
})

/**
 * Clicking an edge pins a draggable card holding that citation's EVIDENCE. This
 * is the connectome's reason to exist — it answers "where does this citation
 * come from", not merely "how big is this project".
 */
test('clicking an edge pins a citation-evidence card that can be dismissed', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'graph')

  const workId = await firstRailWorkId(window)
  await focusPaper(window, workId)

  const edges = await api<CitationEdgeDTO[]>(window, 'getCitations', workId)
  expect(
    edges.every((e) => e.contexts.length > 0),
    'the seed gives every edge at least one stored occurrence'
  ).toBe(true)

  // The painted line is 1px; an invisible fat line owns the pointer events, so
  // that is the one carrying the click handler.
  const hits = window.locator('[data-testid="graph-svg"] line.cg-edge-hit')
  await expect(hits).toHaveCount(edges.length)
  await hits.first().dispatchEvent('click')

  const card = window.locator('[data-testid="graph-edgecard-pinned"]')
  await expect(card).toBeVisible()

  // The card must describe the edge that was ACTUALLY clicked. The force layout
  // decides which line ends up first in the DOM, so the edge is identified from
  // the card's own contents and then cross-checked against the DB row: both
  // paper titles and the exact occurrence count. Asserting a bare /\d+
  // occurrences/ would pass on any edge, including one the user did not click.
  const cardText = await card.innerText()
  const shown = edges.filter(
    (e) => cardText.includes(e.citing_title) && cardText.includes(e.cited_title)
  )
  expect(shown, `the pinned card names exactly one real edge:\n${cardText}`).toHaveLength(1)
  const edge = shown[0]
  const n = edge.contexts.length
  await expect(card).toContainText(`${n} ${n === 1 ? 'occurrence' : 'occurrences'}`)

  // Every occurrence gets its OWN way through to the passage: a single button
  // per card could only ever open one of several, silently choosing for the
  // user. The citing side is the one the seed fills.
  await expect(card.locator('[data-testid^="edgecard-goto-"]')).toHaveCount(n)
  const first = edge.contexts[0]
  const quote = first.sentence ?? first.raw_bib_text
  expect(quote, 'the occurrence carries a real passage or bib line').toBeTruthy()
  await expect(card, 'the card shows the stored passage verbatim').toContainText(
    quote!.slice(0, 40)
  )

  // Dragging is offered, and closing puts it away.
  await expect(window.locator('[data-testid="edgecard-drag"]')).toBeVisible()
  await window.click('[data-testid="edgecard-close"]')
  await expect(card).toHaveCount(0)
})

/**
 * The high-relevance chip is a CLIENT-side filter over the rooted sub-graph. It
 * gets its own test because the old suite only ever used it incidentally (as a
 * "second data join" for the 0,0-flash probe), so nothing actually checked that
 * it filters.
 */
test('the high-relevance chip narrows the drawn graph and toggles back off', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'graph')

  const workId = await firstRailWorkId(window)
  await focusPaper(window, workId)

  const drawn = window.locator('[data-testid="graph-svg"] circle.cg-ring-c')
  const all = await drawn.count()
  expect(all, 'there is a graph to narrow').toBeGreaterThan(1)

  const chip = window.locator('[data-testid="graph-high-relevance"]')
  await chip.click()
  await expect(chip).toHaveClass(/cg-chip-active/)
  // A filter that removes nothing is not a filter. The seeded neighbourhood
  // spans a wide relevance range, so this must be a strict narrowing.
  await expect.poll(() => drawn.count(), { timeout: 10_000 }).toBeLessThan(all)

  // Clicking the active chip again clears it and restores the full sub-graph —
  // the filter is never a one-way door.
  await chip.click()
  await expect(chip).not.toHaveClass(/cg-chip-active/)
  await expect.poll(() => drawn.count(), { timeout: 10_000 }).toBe(all)
})

/**
 * SAVED FRONTIERS. The graph screen no longer offers save/resume controls — the
 * connectome grows from a rooted paper instead of from a persisted node set, so
 * the buttons went with the redesign. The IPC and the `saved_frontier` table did
 * NOT: `saveFrontier`/`listFrontiers` are still in the frozen contract, the
 * preload bridge, the main handlers and the repositories.
 *
 * So the round-trip keeps its test, moved down to the API that still exists.
 * Without this, deleting a backend feature and deleting its coverage would look
 * identical from the suite's point of view.
 */
test('a saved frontier round-trips through the DB and survives a reload', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'graph')

  const before = await api<SavedFrontierDTO[]>(window, 'listFrontiers', 1)
  const name = `frontier-${Date.now()}`
  const graphState = '{"ids":[1,2,3]}'
  const saved = await api<SavedFrontierDTO>(window, 'saveFrontier', {
    projectId: 1,
    name,
    graphState
  })
  expect(saved.name).toBe(name)
  expect(saved.project_id, 'a frontier belongs to the project that saved it').toBe(1)

  // It is in the list, exactly once, with its state preserved byte for byte —
  // the graph state is opaque JSON and must not be reformatted in transit.
  const after = await api<SavedFrontierDTO[]>(window, 'listFrontiers', 1)
  expect(after.length).toBe(before.length + 1)
  const mine = after.filter((f) => f.name === name)
  expect(mine, 'saved exactly once').toHaveLength(1)
  expect(mine[0].graph_state).toBe(graphState)

  // It is a DB row, not renderer state: a full reload must find it again.
  await window.reload()
  await window.waitForSelector('[data-testid="sidebar"]')
  const reloaded = await api<SavedFrontierDTO[]>(window, 'listFrontiers', 1)
  expect(reloaded.some((f) => f.name === name && f.graph_state === graphState)).toBe(true)

  // And it is scoped: another project does not see it.
  const other = await api<ProjectDTO>(window, 'createProject', {
    name: `frontier-scope-${Date.now()}`,
    description: 'scope check'
  })
  const theirs = await api<SavedFrontierDTO[]>(window, 'listFrontiers', other.id)
  expect(theirs.some((f) => f.name === name), 'frontiers do not leak across projects').toBe(false)
})

/**
 * The rail's filter narrows by TITLE against the same list the DB returned, and
 * says so honestly when nothing matches — it never silently falls back to
 * showing everything, which would misreport the corpus.
 */
test('the papers rail filters by title and states an empty result', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'graph')

  const g = await api<GraphDTO>(window, 'getGraph', 1, { limit: 1000, minRelevance: 0 })
  const rows = window.locator('[data-testid^="graph-paper-"]')
  await expect(rows).toHaveCount(g.nodes.length)

  // The probe term is drawn from REAL titles, so the expected count is computed
  // from the DB rather than guessed — and it must be a genuine narrowing, else
  // "filtered" would be indistinguishable from "showed everything".
  const term = 'kemp'
  const expected = g.nodes.filter((n) => n.title.toLowerCase().includes(term))
  expect(expected.length, 'the seed has titles containing the probe term').toBeGreaterThan(0)
  expect(expected.length, 'the probe term is a genuine narrowing').toBeLessThan(g.nodes.length)

  await window.fill('[data-testid="graph-papers-search"]', term)
  await expect(rows).toHaveCount(expected.length)
  for (const n of expected) {
    await expect(window.locator(`[data-testid="graph-paper-${n.id}"]`)).toBeVisible()
  }

  await window.fill('[data-testid="graph-papers-search"]', 'zzzz-no-such-paper')
  await expect(rows).toHaveCount(0)
  await expect(window.locator('.cg-papers-none')).toBeVisible()
})
