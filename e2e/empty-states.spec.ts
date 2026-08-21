import { test, expect, goto, api, selectProject } from './helpers/electron'
import type { ProjectDTO } from '../src/shared/contract'

/**
 * A brand-new project has no works/analyses. Every data screen must render its
 * EMPTY state (not crash, not a silent blank). This also exercises the loading
 * skeleton class `.sk` which the shared States component renders while async
 * data is in flight.
 */
test('a fresh empty project renders empty states across screens', async ({ launch }) => {
  const { window } = await launch()

  const created = await api<ProjectDTO>(window, 'createProject', {
    name: `empty-${Date.now()}`,
    description: 'no works'
  })
  expect(created.work_count).toBe(0)

  // Reload so the dashboard lists the new project, then open it via its card.
  await window.reload()
  await window.waitForSelector('[data-testid="sidebar"]')
  await selectProject(window, created.id)

  // Graph: empty state, no crash. (Opening the project already lands on graph.)
  await goto(window, 'graph')
  await expect(window.locator('[data-testid="screen-graph"] .empty-state')).toBeVisible()

  // Ranking: empty state.
  await goto(window, 'ranking')
  await expect(window.locator('[data-testid="screen-ranking"] .empty-state')).toBeVisible()

  // Extraction: empty state.
  await goto(window, 'extraction')
  await expect(window.locator('[data-testid="screen-extraction"] .empty-state')).toBeVisible()

  // Review: dedicated empty testid.
  await goto(window, 'review')
  await expect(window.locator('[data-testid="review-empty"]')).toBeVisible()
})

test('loading skeleton component (.sk) is defined and reachable', async ({ launch }) => {
  const { window } = await launch()
  // The skeleton markup uses the `.sk` class family (sk-stack / sk-row). Assert
  // the CSS class is present in the built stylesheet so skeletons can render.
  const hasSkeletonCss = await window.evaluate(() => {
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList | null = null
      try {
        rules = sheet.cssRules
      } catch {
        continue
      }
      if (!rules) continue
      for (const rule of Array.from(rules)) {
        if (rule.cssText.includes('.sk')) return true
      }
    }
    return false
  })
  expect(hasSkeletonCss).toBe(true)
})
