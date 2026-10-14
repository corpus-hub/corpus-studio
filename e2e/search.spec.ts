import { test, expect, goto, api, selectProject } from './helpers/electron'
import type { Page } from '@playwright/test'
import type { SearchResultDTO, FacetsDTO } from '../src/shared/contract'

/**
 * Corpus search lives on the PAPERS screen (route `ingest`) — there is no
 * standalone `search` route and no topbar search box any more. Papers is the one
 * place for everything paper-related: the project's papers, the search over
 * them, and the processing queue.
 */
async function gotoPapers(window: Page): Promise<void> {
  await goto(window, 'ingest')
  await window.waitForSelector('[data-testid="papers-finder"]')
}

async function runQuery(window: Page, q: string): Promise<void> {
  const input = window.locator('[data-testid="papers-search-input"]')
  await input.fill(q)
  await input.press('Enter')
}

const resultRows = (window: Page) => window.locator('[data-testid^="search-result-"]')

test('the topbar search box is gone — search is on Papers', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)

  // Negative assertion: a stale topbar box must not creep back in.
  await expect(window.locator('[data-testid="global-search-input"]')).toHaveCount(0)

  await gotoPapers(window)
  await expect(window.locator('[data-testid="papers-search-input"]')).toBeVisible()
})

test('Papers lists the project papers with no query and opens one', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await gotoPapers(window)

  // An empty query is NOT an empty result: it is the whole project.
  const all = await api<SearchResultDTO[]>(window, 'search', '', 1)
  expect(all.length).toBeGreaterThan(0)
  await expect(resultRows(window)).toHaveCount(all.length)
  await expect(window.locator('[data-testid="papers-count"]')).toContainText(
    `All ${all.length} papers`
  )

  // A row opens that paper in Paper detail (the same openWork path the graph
  // and the ranking use).
  await resultRows(window).first().click()
  await expect(window.locator('[data-testid="screen-paper"]')).toBeVisible({ timeout: 15_000 })
})

test('search returns results for a known term', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await gotoPapers(window)

  await runQuery(window, 'Kemp')

  await expect(resultRows(window).first()).toBeVisible({ timeout: 15_000 })
  const results = await api<SearchResultDTO[]>(window, 'search', 'Kemp', 1)
  expect(results.length).toBeGreaterThan(0)
  await expect(resultRows(window)).toHaveCount(results.length)
})

test('facets show buckets with counts', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await gotoPapers(window)

  await expect(window.locator('[data-testid="facet-panel"]')).toBeVisible()
  const facets = await api<FacetsDTO>(window, 'getFacets', 1)
  expect(facets.work_type.length).toBeGreaterThan(0)
  const firstBucket = window.locator('[data-testid="facet-panel"] .facet-row').first()
  await expect(firstBucket).toBeVisible()
  await expect(firstBucket.locator('.badge')).toContainText(/\d/)
})

test('nonsense query shows a no-results state', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await gotoPapers(window)

  await runQuery(window, 'zzznotarealtermxyzq')
  await expect(window.locator('[data-testid="search-no-results"]')).toBeVisible({ timeout: 15_000 })
})

test('a facet chip really filters, is a keyboard toggle, and clears', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await gotoPapers(window)

  const before = await resultRows(window).count()
  expect(before).toBeGreaterThan(1)

  // Pick a work_type bucket that does NOT cover the whole corpus, so pressing it
  // must strictly reduce the result count (a no-op chip would pass a >= check).
  const facets = await api<FacetsDTO>(window, 'getFacets', 1)
  const bucket = facets.work_type.find((b) => b.count < before)
  expect(bucket, 'seed must have a work_type that is not the whole corpus').toBeTruthy()

  const chip = window.locator(`[data-testid="facet-chip-${bucket!.value}"]`)
  await expect(chip).toHaveAttribute('aria-pressed', 'false')

  // Keyboard-operable: focus and press Enter, not just click.
  await chip.focus()
  await chip.press('Enter')

  await expect(chip).toHaveAttribute('aria-pressed', 'true')
  await expect(resultRows(window)).toHaveCount(bucket!.count, { timeout: 15_000 })
  await expect(window.locator('[data-testid="papers-active-filters"]')).toContainText('1 filter')
  await expect(window.locator('[data-testid="papers-count"]')).toContainText(
    `${bucket!.count} of ${before}`
  )

  // The filter runs in SQL, so the API agrees with the UI.
  const filtered = await api<SearchResultDTO[]>(window, 'search', '', 1, {
    work_type: [bucket!.value]
  })
  expect(filtered.length).toBe(bucket!.count)

  await window.click('[data-testid="papers-clear-filters"]')
  await expect(resultRows(window)).toHaveCount(before, { timeout: 15_000 })
  await expect(window.locator('[data-testid="papers-active-filters"]')).toHaveCount(0)
})

test('two facets compose (AND across facets)', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await gotoPapers(window)

  const facets = await api<FacetsDTO>(window, 'getFacets', 1)
  const wt = facets.work_type[0]
  const inc = facets.inclusion_status[0]
  expect(wt && inc).toBeTruthy()

  await window.click(`[data-testid="facet-chip-${wt.value}"]`)
  await window.click(`[data-testid="facet-chip-${inc.value}"]`)

  await expect(window.locator('[data-testid="papers-active-filters"]')).toContainText('2 filters')

  const both = await api<SearchResultDTO[]>(window, 'search', '', 1, {
    work_type: [wt.value],
    inclusion_status: [inc.value]
  })
  // AND, never OR: the intersection cannot exceed either facet on its own.
  expect(both.length).toBeLessThanOrEqual(Math.min(wt.count, inc.count))
  await expect(resultRows(window)).toHaveCount(both.length, { timeout: 15_000 })
})

test('search history records a run and round-trips its whole parameter set', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await gotoPapers(window)

  const facets = await api<FacetsDTO>(window, 'getFacets', 1)
  const bucket = facets.work_type[0]

  await runQuery(window, 'Kemp')
  await window.click(`[data-testid="facet-chip-${bucket.value}"]`)
  await expect(resultRows(window).first()).toBeVisible({ timeout: 15_000 })
  const narrowed = await resultRows(window).count()

  // No Save button any more: EXECUTING the search is what records it, so the
  // history entry must already exist without any further action.
  const historyRow = window.locator('.saved-searches button', { hasText: 'Kemp' })
  await expect(historyRow.first()).toBeVisible({ timeout: 15_000 })

  // It persisted the FULL parameter set, not just the query text.
  const list = await api<{ name: string; query: string; filters: string | null }[]>(
    window,
    'listSearchHistory',
    1
  )
  const row = list.find((s) => s.query === 'Kemp')
  expect(row, 'the executed search is in the history').toBeTruthy()
  expect(JSON.parse(row?.filters ?? '{}').work_type).toEqual([bucket.value])

  // Clear everything, then restore from history: BOTH halves must come back.
  await window.click('[data-testid="papers-clear-filters"]')
  await expect(window.locator('[data-testid="papers-active-filters"]')).toHaveCount(0)

  await historyRow.first().click()
  await expect(window.locator('[data-testid="papers-search-input"]')).toHaveValue('Kemp')
  await expect(window.locator('[data-testid="papers-active-filters"]')).toContainText('1 filter')
  await expect(resultRows(window)).toHaveCount(narrowed, { timeout: 15_000 })
})


/**
 * Semantic search on a corpus with NOTHING embedded.
 *
 * The seed runs no pipeline, so this is the state a fresh install is genuinely
 * in — and it is the state where this feature is most dangerous. An empty
 * ranked list with no explanation is indistinguishable from "your library holds
 * nothing on this", so every assertion here is about the app SAYING so.
 */
test('a meaning search with nothing embedded says so, and names what it cannot see', async ({
  launch
}) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await gotoPapers(window)

  // Keyword is the default: the mode with the weaker warranty is never the one
  // a user lands in without choosing it.
  await expect(window.locator('[data-testid="search-mode-keyword"]')).toHaveAttribute(
    'aria-pressed',
    'true'
  )

  await window.click('[data-testid="search-mode-meaning"]')
  await expect(window.locator('[data-testid="search-mode-meaning"]')).toHaveAttribute(
    'aria-pressed',
    'true'
  )

  // The coverage verdict is on the SWITCH, before any search is run.
  const coverage = window.locator('[data-testid="semantic-coverage"]')
  await expect(coverage).toBeVisible({ timeout: 15_000 })
  await expect(coverage).toHaveAttribute('data-verdict', 'none')

  await runQuery(window, 'mutations far from the active site that change turnover')

  // An EXPLANATION, not an empty list.
  await expect(window.locator('[data-testid="semantic-unavailable"]')).toBeVisible({
    timeout: 20_000
  })

  // And the papers it cannot see are NAMED rather than silently omitted, which
  // is what would otherwise make the library look smaller than it is.
  const unembedded = window.locator('[data-testid="semantic-unembedded"]')
  await expect(unembedded).toBeVisible()
  await window.click('[data-testid="semantic-unembedded-toggle"]')
  await expect(window.locator('[data-testid^="semantic-unembedded-"]').nth(1)).toBeVisible()
})

test('switching modes does not disturb the keyword search', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await gotoPapers(window)

  await runQuery(window, 'Kemp')
  await expect(resultRows(window).first()).toBeVisible({ timeout: 15_000 })
  const before = await resultRows(window).count()

  // The facet rail belongs to the keyword search; it goes away with it and
  // comes back intact, with the query and its results unchanged.
  await window.click('[data-testid="search-mode-meaning"]')
  await expect(window.locator('[data-testid="facet-panel"]')).toHaveCount(0)

  await window.click('[data-testid="search-mode-keyword"]')
  await expect(window.locator('[data-testid="facet-panel"]')).toBeVisible()
  await expect(window.locator('[data-testid="papers-search-input"]')).toHaveValue('Kemp')
  await expect(resultRows(window)).toHaveCount(before, { timeout: 15_000 })
})

/**
 * The text-provenance contract, asserted at the API boundary.
 *
 * The seed's documents are all `unknown` — no stage has claimed their text —
 * and `unknown` must survive as `unknown` rather than being rounded up to a
 * text layer, which would assert something no run stands behind.
 */
test('a document reports how its text was obtained, and never guesses', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)

  const docs = await api<Array<{ text_source: string; text_confidence: number | null }>>(
    window,
    'getWorkDocuments',
    1
  )
  expect(docs.length).toBeGreaterThan(0)
  for (const d of docs) {
    expect(['unknown', 'pdf-text-layer', 'ocr']).toContain(d.text_source)
    // A confidence without OCR would be a number standing behind nothing.
    if (d.text_source !== 'ocr') expect(d.text_confidence).toBeNull()
  }
})
