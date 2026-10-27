import { test, expect, goto, selectProject, settleConsole } from './helpers/electron'
import type { Page } from '@playwright/test'

/**
 * COLD-NAV REGRESSION — every in-project sidebar item must be clickable from a
 * cold state without crashing.
 *
 * The bug this guards: "Paper detail" (route `paper`) was a standalone sidebar
 * item, but the `paper` route needs a `workId`. A cold click built the route
 * with `workId: undefined`, PaperScreen called `window.api.getWork(undefined)`,
 * the main-process `works:get` zod handler rejected the non-number id, and the
 * renderer showed the "Something went wrong" error card. Every OTHER spec only
 * reached `paper` via `openWork(id)` (from graph/ranking) with a real id, so the
 * cold sidebar click was never exercised.
 *
 * This spec opens a freshly-seeded project and clicks EACH in-project nav item
 * one-by-one from a cold state (never via openWork), asserting for each that:
 *   - the expected `screen-<route>` testid is present, and
 *   - NEITHER the async error card (`error-state`) NOR the top-level render
 *     boundary (`app-error-boundary`) is showing.
 *
 * It FAILS against the pre-fix code (the `paper` click renders `error-state`)
 * and PASSES after the fix (the `paper` click renders the `paper-no-selection`
 * empty state instead).
 */

// The in-project sidebar nav, keyed by ROUTE (the testids are `nav-<route>`),
// in the order they appear in IN_PROJECT_NAV.
const IN_PROJECT_NAV_ROUTES = [
  'graph',
  'ranking',
  // NOTE: 'paper' is deliberately NOT here any more. Paper detail is no longer a
  // sidebar destination — it is opened from the Connectome, the Ranking list or
  // the Papers list. Its cold-entry safety is covered by its own test below.
  'ingest',
  // NOTE: 'schemas' is deliberately NOT here any more. It moved to the
  // PROJECTS-level sidebar (schemas are global definitions shared by every
  // project), so it is covered by its own cold-click test below — from the
  // dashboard, with no project open.
  'extraction',
  'review',
  'dossier',
  'integrations'
] as const

// The projects-level sidebar nav (visible when NO project is open).
const PROJECT_LEVEL_NAV_ROUTES = ['projects', 'schemas'] as const

/** Assert no crash surface is visible anywhere in the app right now. */
async function expectNoCrash(window: Page, where: string): Promise<void> {
  await expect(
    window.locator('[data-testid="error-state"]'),
    `async error card must be absent on "${where}"`
  ).toHaveCount(0)
  await expect(
    window.locator('[data-testid="app-error-boundary"]'),
    `render error boundary must be absent on "${where}"`
  ).toHaveCount(0)
}

test('cold sidebar navigation never crashes any in-project screen', async ({ launch }) => {
  const { window } = await launch()

  // Open the canonical seeded project (id 1). This lands on the Connectome.
  await selectProject(window, 1)

  for (const route of IN_PROJECT_NAV_ROUTES) {
    // Click the sidebar item cold and wait for its screen node. `goto` waits for
    // `screen-<route>`, which is present even if the screen were to crash inside
    // it — so a crash would be caught by the assertions below, not by a timeout.
    await goto(window, route)

    // The expected screen must be present...
    await expect(
      window.locator(`[data-testid="screen-${route}"]`),
      `screen-${route} must render on a cold click`
    ).toBeVisible()

    // ...and no crash surface may be showing.
    await expectNoCrash(window, `nav-${route}`)
  }
})

test('cold sidebar navigation never crashes any PROJECTS-LEVEL screen', async ({ launch }) => {
  const { window } = await launch()

  // No project is opened at all — this is the state the app boots into, and the
  // state 'schemas' must now survive (it used to require a project).
  await expect(window.locator('[data-testid="screen-projects"]')).toBeVisible()

  for (const route of PROJECT_LEVEL_NAV_ROUTES) {
    await goto(window, route)
    await expect(
      window.locator(`[data-testid="screen-${route}"]`),
      `screen-${route} must render on a cold click with no project open`
    ).toBeVisible()
    // The "No project selected" guard must NOT swallow a project-level route.
    await expect(
      window.locator('[data-testid="no-project"]'),
      `${route} must not fall into the no-project guard`
    ).toHaveCount(0)
    await expectNoCrash(window, `nav-${route} (no project)`)
  }
})

test('"Paper detail" is not a sidebar item but stays reachable', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)

  // Paper detail is a paper you OPEN, not a destination you pick — so it has no
  // sidebar entry.
  //
  // Asserted POSITIVELY, against the nav that is actually rendered, rather than
  // as `toHaveCount(0)` on `nav-paper`. That negative could never fail: the
  // sidebar builds its testids as `nav-<route>` from IN_PROJECT_NAV, and
  // `paper` has never been a member of that list, so the selector has never
  // matched anything in any version of this app. Enumerating the real nav
  // instead means adding `paper` to the sidebar breaks this test, which is the
  // regression the assertion was reaching for.
  // `.side-nav-item` scopes this to the nav BUTTONS. Their descendants also
  // carry `nav-` testids (the Papers failure badge is `nav-ingest-badge`), and
  // a bare prefix match would fold those into the route list.
  const navRoutes = await window.$$eval('.sidebar-nav .side-nav-item[data-testid^="nav-"]', (els) =>
    els.map((e) => (e.getAttribute('data-testid') ?? '').replace('nav-', ''))
  )
  // The WHOLE in-project sidebar, in order. Papers leads because it is the
  // project's CONTENT; the Connectome, References and Ranking are views over
  // it. `schemas` is absent by design (global, one level up) and so is `paper`.
  expect(navRoutes, 'the in-project sidebar is exactly this, in this order').toEqual([
    'projects',
    'ingest',
    'graph',
    'references',
    'ranking',
    'extraction',
    'review',
    'dossier',
    'integrations'
  ])

  // ALL THREE documented entry points are exercised, because "stays reachable"
  // is only true if each of them actually works.

  // 1. The Ranking list. The card BODY selects — it carries inline status and
  //    dossier controls that would be unusable if the whole card navigated
  //    away — and the TITLE is the control that opens the paper.
  await goto(window, 'ranking')
  const card = window.locator('[data-testid^="ranking-row-"]').first()
  await card.click()
  await expect(card, 'clicking the card body selects it rather than navigating').toHaveClass(
    /is-selected/
  )
  await expect(
    window.locator('[data-testid="screen-ranking"]'),
    'selecting must not leave the ranking screen'
  ).toBeVisible()
  await card.locator('.rank-title').click()
  await expect(window.locator('[data-testid="screen-paper"]')).toBeVisible({ timeout: 15_000 })
  await expectNoCrash(window, 'paper opened from ranking')

  // 2. The Papers list, whose open control is a button stretched over the row
  //    (the row itself is a grid, not the click target).
  await goto(window, 'ingest')
  await window.locator('[data-testid^="search-open-"]').first().click()
  await expect(window.locator('[data-testid="screen-paper"]')).toBeVisible({ timeout: 15_000 })
  await expectNoCrash(window, 'paper opened from papers')

  // 3. The Connectome inspector, which only offers the action once a paper is
  //    rooted — so rooting one is part of the path.
  await goto(window, 'graph')
  await window.locator('[data-testid^="graph-paper-"]').first().click()
  await window.locator('[data-testid="graph-node-detail"] .cg-btn-open').click()
  await expect(window.locator('[data-testid="screen-paper"]')).toBeVisible({ timeout: 15_000 })
  await expectNoCrash(window, 'paper opened from the connectome inspector')
})

test('no genuine console errors during a full cold sidebar sweep', async ({ launch }) => {
  const { window, consoleErrors } = await launch()
  await selectProject(window, 1)
  for (const route of IN_PROJECT_NAV_ROUTES) {
    await goto(window, route)
  }
  await settleConsole(window)

  // Known-benign, non-functional console noise (mirrors shell.spec.ts): the app
  // bundles fonts but ships a strict `font-src 'self'` CSP, so Chromium refuses
  // the embedded fonts and falls back — cosmetic, not a JS/app error.
  const BENIGN = [
    /Content Security Policy directive: "font-src/i,
    /Refused to load the font/i,
    /frame-ancestors' is ignored when delivered via a <meta> element/i
  ]
  const real = consoleErrors.filter((e) => !BENIGN.some((re) => re.test(e)))
  expect(real, `console errors during cold sweep:\n${real.join('\n')}`).toEqual([])
})
