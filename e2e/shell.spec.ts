import { test, expect, goto, selectProject, settleConsole } from './helpers/electron'

// Every screen the shell can route to. The redesigned sidebar shows the
// in-project nav only once a project is open, so specs open a project first
// (via its dashboard card) before visiting the project-scoped screens. The set
// of reachable screens — and the invariant that each renders — is unchanged.
const SCREENS = [
  'graph',
  'ranking',
  'ingest',
  'extraction',
  'review',
  'dossier',
  'integrations',
  'projects'
]

// Screens reachable WITHOUT a project open. 'schemas' moved here: an extraction
// schema is a global definition shared by every project, so it now lives in the
// projects-level sidebar. Both loops below end on 'projects' (which closes the
// project), so these are visited straight after — same total coverage.
const PROJECT_LEVEL_SCREENS = ['schemas']

test('app launches with sidebar and correct title', async ({ launch }) => {
  const { window } = await launch()
  await expect(window.locator('[data-testid="sidebar"]')).toBeVisible()
  // The title now lives in the topbar; the window/document title is unchanged.
  await expect(window.locator('[data-testid="topbar"]')).toBeVisible()
  expect(await window.title()).toBe('Corpus Studio')
})

test('can navigate to every screen', async ({ launch }) => {
  const { window } = await launch()
  // Open a project so the project-scoped nav items are present.
  await selectProject(window, 1)
  for (const screen of SCREENS) {
    await goto(window, screen)
    await expect(window.locator(`[data-testid="screen-${screen}"]`)).toBeVisible()
  }
  for (const screen of PROJECT_LEVEL_SCREENS) {
    await goto(window, screen)
    await expect(window.locator(`[data-testid="screen-${screen}"]`)).toBeVisible()
  }
})

// The `search` route was folded into Papers, so the "every route renders" loop
// above no longer covers the search surface. This replaces that coverage: on
// Papers, the search surface AND the processing queue must both render — one
// must not have displaced the other.
test('Papers reaches the search surface, an importer and the queue by tab', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'ingest')

  // The tabs are mutually exclusive surfaces, so each is asserted on its own —
  // they are no longer stacked on one page.
  await expect(window.locator('[data-testid="papers-finder"]')).toBeVisible()
  await expect(window.locator('[data-testid="papers-search-input"]')).toBeVisible()
  await expect(window.locator('[data-testid="facet-panel"]')).toBeVisible()

  // The IDENTIFIER tab, which is always here. Searching the indexes is a
  // separate tab and a separate question -- it exists only when a plugin can
  // answer it, and this fixture installs none.
  await window.click('[data-testid="ingest-tab-identifier"]')
  await expect(window.locator('[data-testid="ingest-input"]')).toBeVisible()

  await window.click('[data-testid="ingest-tab-queue"]')
  await expect(window.locator('[data-testid="ingest-filters"]')).toBeVisible()
})

// Known-benign, non-functional console noise. The app bundles fonts as base64
// data: URLs but ships a CSP with `font-src 'self'`, so Chromium refuses the
// embedded fonts and falls back — a cosmetic CSP mismatch, NOT a JS/app error.
// (Reported as a product finding by the e2e harness; filtered here so the test
// still fails hard on any GENUINE runtime error.)
const BENIGN = [
  /Content Security Policy directive: "font-src/i,
  /Refused to load the font/i,
  // CSP `frame-ancestors` delivered via <meta> is ignored by Chromium — a
  // cosmetic warning about where the (harmless) directive lives, not an error.
  /frame-ancestors' is ignored when delivered via a <meta> element/i
]

function realErrors(errors: string[]): string[] {
  return errors.filter((e) => !BENIGN.some((re) => re.test(e)))
}

test('no genuine console errors while navigating the shell', async ({ launch }) => {
  const { window, consoleErrors } = await launch()
  await selectProject(window, 1)
  for (const screen of SCREENS) {
    await goto(window, screen)
  }
  for (const screen of PROJECT_LEVEL_SCREENS) {
    await goto(window, screen)
  }
  await settleConsole(window)
  const errs = realErrors(consoleErrors)
  expect(errs, `console errors: ${errs.join('\n')}`).toEqual([])
})
