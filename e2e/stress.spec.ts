import { test, expect, goto, api, selectProject } from './helpers/electron'
import type { GraphDTO, RankingRowDTO } from '../src/shared/contract'
import type { CitationEdgeDTO } from '../src/shared/types'

const STRESS_PROJECT_ID = 900

/**
 * Scale test: the app is launched against a DB seeded with thousands of works +
 * tens of thousands of edges (see scripts/seed-stress.ts). Proves the app does
 * NOT try to render everything — it bounds the graph and virtualises/paginates
 * the ranking list — and stays responsive.
 */
test.describe('stress / scale', () => {
  test('graph renders a BOUNDED node count against thousands of works', async ({ launch }) => {
    const { window } = await launch('stress')
    await selectProject(window, STRESS_PROJECT_ID)
    await goto(window, 'graph')

    await expect(window.locator('[data-testid="graph-svg"]')).toBeVisible({ timeout: 20_000 })

    // The Connectome explores ONE paper at a time, so on a 3000-work corpus the
    // canvas starts EMPTY rather than attempting a 3000-node force layout. That
    // is the strongest form of the bound this test exists to enforce.
    await expect(window.locator('[data-testid="graph-canvas-empty"]')).toBeVisible()
    await expect(window.locator('[data-testid="graph-svg"] circle.cg-ring-c')).toHaveCount(0)

    const g = await api<GraphDTO>(window, 'getGraph', STRESS_PROJECT_ID, {
      limit: 60,
      minRelevance: 0
    })
    expect(g.total_works, 'the stress seed really is thousands of works').toBeGreaterThanOrEqual(
      3000
    )

    // Rooting a paper draws only its citation neighbourhood. The bound is
    // asserted against the neighbourhood the DB actually holds, NOT against a
    // loose "<= 300" ceiling: on this seed a single paper's neighbourhood is a
    // few dozen nodes, so a ceiling test would pass even with every clamp
    // removed. Exact equality is the only version that can fail.
    const rail = window.locator('[data-testid^="graph-paper-"]')
    await expect.poll(() => rail.count(), { timeout: 20_000 }).toBeGreaterThan(0)
    const railId = await rail.first().getAttribute('data-testid')
    const rootId = Number((railId ?? '').replace('graph-paper-', ''))
    await rail.first().click()

    const edges = await api<CitationEdgeDTO[]>(window, 'getCitations', rootId)
    const expected = new Set<number>([rootId])
    for (const e of edges) {
      expected.add(e.citing_work_id)
      expected.add(e.cited_work_id)
    }
    const drawn = window.locator('[data-testid="graph-svg"] circle.cg-ring-c')
    await expect.poll(() => drawn.count(), { timeout: 20_000 }).toBe(expected.size)

    // …and that neighbourhood is orders of magnitude smaller than the corpus,
    // which is the property this test exists to defend at scale.
    expect(expected.size, 'a rooted neighbourhood is a tiny fraction of 3000+ works').toBeLessThan(
      g.total_works / 10
    )
  })

  // RankingScreen paginates (page size 50 + "show more"), so a 3000-work project
  // renders only a bounded window of DOM rows rather than all rows.
  test('ranking does not render thousands of DOM rows', async ({ launch }) => {
    const { window } = await launch('stress')
    await selectProject(window, STRESS_PROJECT_ID)
    await goto(window, 'ranking')

    await expect(window.locator('[data-testid^="ranking-row-"]').first()).toBeVisible({
      timeout: 20_000
    })

    const rows = await api<RankingRowDTO[]>(window, 'getRanking', STRESS_PROJECT_ID, 'relevance')
    expect(rows.length).toBeGreaterThanOrEqual(3000)

    // The DOM must contain far fewer rows than the full dataset (pagination /
    // virtualisation). Guard against a runaway render of every work.
    const domRows = await window.locator('[data-testid^="ranking-row-"]').count()
    expect(domRows).toBeLessThan(rows.length)
    expect(domRows).toBeLessThanOrEqual(1000)
  })

  test('navigation stays responsive on a large corpus', async ({ launch }) => {
    const { window } = await launch('stress')
    await selectProject(window, STRESS_PROJECT_ID)

    // 'ingest' (Papers) replaces the old standalone 'search' route: the corpus
    // search now lives there, so this still exercises the search path at scale.
    for (const screen of ['ranking', 'extraction', 'ingest', 'graph']) {
      const start = Date.now()
      await goto(window, screen)
      await expect(window.locator(`[data-testid="screen-${screen}"]`)).toBeVisible({
        timeout: 20_000
      })
      expect(Date.now() - start, `${screen} navigation`).toBeLessThan(20_000)
    }
  })
})
