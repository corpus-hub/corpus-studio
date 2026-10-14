import { resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { test, expect, selectProject } from './helpers/electron'

const ROOT = resolve(__dirname, '..')

// Acceptance capture for the shell fixes: full-bleed (content reaches all four
// window edges), no topbar model pill, no avatar. Navigates into a project and
// onto the Ranking screen (which has native <select> dropdowns) so the global
// dropdown styling is visible in the shot too.
test('shell fixes: full-bleed, no model pill, no avatar', async ({ launch }) => {
  const { window } = await launch()

  // Removals.
  await expect(window.locator('[data-testid="model-pill"]')).toHaveCount(0)
  await expect(window.locator('.avatar')).toHaveCount(0)

  // Full-bleed: the app-shell fills the whole viewport, flush to every edge.
  const box = await window.locator('.app-shell').boundingBox()
  const vp = await window.evaluate(() => ({
    w: window.innerWidth,
    h: window.innerHeight
  }))
  expect(box).not.toBeNull()
  if (box) {
    expect(box.x).toBeLessThanOrEqual(1)
    expect(box.y).toBeLessThanOrEqual(1)
    expect(box.width).toBeGreaterThanOrEqual(vp.w - 1)
    expect(box.height).toBeGreaterThanOrEqual(vp.h - 1)
  }
  // No body margin.
  const bodyMargin = await window.evaluate(() =>
    getComputedStyle(document.body).margin
  )
  expect(bodyMargin).toBe('0px')

  // Show a screen with native dropdowns (Ranking) for the styled-select proof.
  await selectProject(window, 1)
  await window.click('[data-testid="nav-ranking"]')
  await window.waitForSelector('[data-testid="screen-ranking"]', { timeout: 15_000 })

  mkdirSync(resolve(ROOT, 'tmp', 'acceptance'), { recursive: true })
  await window.screenshot({
    path: resolve(ROOT, 'tmp', 'acceptance', 'shell-fixes.png')
  })
})
