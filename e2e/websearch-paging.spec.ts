/*
 * PAGING THE WEB SEARCH, in both places it appears.
 *
 * The panel is one component (`WebSearchPanel`) mounted twice — on the Papers
 * screen and inside the project-creation form — so the two are asserted against
 * the same expectations rather than one being assumed from the other. They are
 * genuinely two mounts with two lifetimes, and the failure this guards (a page
 * index surviving a remount, or a fetch appended to the wrong list) is exactly
 * the kind that shows up in one and not the other.
 *
 * WHAT IS BEING PROVEN, in the user's terms:
 *   1. a page holds 30 papers, not the 100 that were fetched;
 *   2. no paper appears on two pages — even though the source deliberately
 *      re-offers papers across fetches, which is what real indexes do;
 *   3. Back and Next land where they say, and Back returns the page it left;
 *   4. the first page's Back and an exhausted list's Next are refused;
 *   5. a new search puts the reader back on page 1.
 *
 * The search source is `e2e/fixtures/plugins/paging-search`, a plugin with a
 * generated corpus whose papers are numbered in their titles. Numbers are what
 * make (2) assertable: two rows that merely look alike prove nothing.
 */
import { test, expect, goto, api, selectProject } from './helpers/electron'
import type { Page } from '@playwright/test'
import { resolve } from 'node:path'
import type { ProjectDTO } from '@shared/contract'

const FIXTURE_PLUGINS = resolve(__dirname, 'fixtures', 'plugins')

/** What the panel shows one page of. Mirrors `PAGE_SIZE` in IngestScreen.tsx. */
const PAGE_SIZE = 30

/**
 * Launch with the fixture search plugin as the ONLY bundled plugins root, and
 * switch it on.
 *
 * Replacing the root rather than adding to it: a bundled plugin may also offer
 * `paper-search`, and with both loaded the results would be a merge of a known
 * list and whatever a browser extension that is not installed reports.
 * `CORPUS_BUNDLED_PLUGINS_DIR` is the supported way to say which
 * folder the bundled root is; `CORPUS_PLUGINS_DIR` moves the user-added root off
 * the throwaway profile's default for the same reason.
 */
async function launchWithFixture(
  launch: (mode?: 'fresh', extra?: Record<string, string>) => Promise<{ window: Page }>
): Promise<Page> {
  const { window } = await launch('fresh', {
    CORPUS_BUNDLED_PLUGINS_DIR: FIXTURE_PLUGINS,
    CORPUS_PLUGINS_DIR: resolve(FIXTURE_PLUGINS, '..', 'no-added-plugins')
  })
  await api(window, 'setPluginEnabled', 'paging-search', true)
  return window
}

/** The paper numbers on the page currently shown, in the order they appear. */
async function pageNumbers(window: Page): Promise<string[]> {
  const titles = await window
    .locator('[data-testid^="websearch-result-"] .ing-web-title')
    .allTextContents()
  return titles.map((t) => {
    const m = /Paging fixture paper (\d+)/.exec(t)
    if (!m) throw new Error(`a result row is not a fixture paper: ${JSON.stringify(t)}`)
    return m[1]
  })
}

/** Run a search in whichever panel is on screen and wait for its first page. */
async function search(window: Page, query: string): Promise<void> {
  await window.fill('[data-testid="websearch-input"]', query)
  await window.click('[data-testid="websearch-submit"]')
  await window.waitForSelector('[data-testid="websearch-pager"]', { timeout: 60_000 })
  await expect
    .poll(async () => (await pageNumbers(window)).length, { timeout: 60_000 })
    .toBe(PAGE_SIZE)
}

/**
 * Turn to `n` and wait until the pager agrees that is where we are.
 *
 * By its NUMBER when the pager offers one, and by Next when it does not. That is
 * not a convenience: the numbers name pages that have been retrieved, and a page
 * beyond them is reached by asking the indexes for more — which is what Next is.
 * A number for a page nobody has fetched would be a promise the app cannot make.
 */
async function goPage(window: Page, n: number): Promise<void> {
  // Next advances by ONE, so reaching a page several beyond what is retrieved
  // takes several presses — each one a fetch. The loop is bounded so a pager
  // that stopped advancing fails here rather than spinning to the timeout with
  // nothing to say about why.
  for (let i = 0; i < n; i++) {
    const num = window.locator(`[data-testid="websearch-page-${n}"]`)
    if (await num.count()) {
      await num.click()
      break
    }
    await window.click('[data-testid="websearch-page-next"]')
    // Settle before the next press: the button is disabled while the fetch runs,
    // and Playwright would otherwise wait out its actionability timeout.
    await expect(window.locator('[data-testid="websearch-page-next"]')).toBeEnabled({
      timeout: 60_000
    })
  }
  await expect(window.locator(`[data-testid="websearch-page-${n}"]`)).toHaveAttribute(
    'aria-current',
    'page',
    { timeout: 60_000 }
  )
}

/** Open the fixture-backed web search on the Papers screen. */
async function openPapersWebSearch(window: Page): Promise<void> {
  const projects = await api<ProjectDTO[]>(window, 'listProjects')
  await selectProject(window, projects[0].id)
  await goto(window, 'ingest')
  await window.click('[data-testid="ingest-tab-web"]')
  await window.waitForSelector('[data-testid="websearch-panel"]', { timeout: 15_000 })
}

test('Papers: results are paged 30 at a time, with no paper on two pages', async ({ launch }) => {
  const window = await launchWithFixture(launch)
  await openPapersWebSearch(window)
  await search(window, 'paging')

  // A page is 30 — NOT the 100 the app fetches. The two numbers are different
  // on purpose (one round trip fills several pages), and a regression that fused
  // them would show up here as a page of 100.
  const p1 = await pageNumbers(window)
  expect(p1.length, 'page 1 holds one page of papers').toBe(PAGE_SIZE)

  // Walk far enough to cross a FETCH boundary (100 fetched / 30 per page), so
  // the assertion covers papers the source re-offered rather than only the ones
  // it returned once.
  const seen = new Map<string, number>()
  for (const n of p1) seen.set(n, 1)
  for (let page = 2; page <= 5; page++) {
    await goPage(window, page)
    const rows = await pageNumbers(window)
    expect(rows.length, `page ${page} holds one page of papers`).toBe(PAGE_SIZE)
    for (const n of rows) {
      const prior = seen.get(n)
      expect(
        prior,
        `paper ${n} is on page ${page} and was already on page ${prior}`
      ).toBeUndefined()
      seen.set(n, page)
    }
  }
  expect(seen.size, 'five pages of thirty distinct papers').toBe(5 * PAGE_SIZE)
})

test('Papers: Back and Next land where they say, and the ends are refused', async ({ launch }) => {
  const window = await launchWithFixture(launch)
  await openPapersWebSearch(window)
  await search(window, 'paging')

  // On page 1 there is nowhere back to go, and the control says so rather than
  // silently doing nothing.
  const back = window.locator('[data-testid="websearch-page-prev"]')
  await expect(back).toBeDisabled()
  await expect(back).toHaveAttribute('data-tip', /first page/i)

  const p1 = await pageNumbers(window)
  await window.click('[data-testid="websearch-page-next"]')
  await expect(window.locator('[data-testid="websearch-page-2"]')).toHaveAttribute(
    'aria-current',
    'page',
    { timeout: 60_000 }
  )
  const p2 = await pageNumbers(window)
  expect(p2, 'Next shows a different page').not.toEqual(p1)
  await expect(back).toBeEnabled()

  // Back RETURNS the page it left — the same papers in the same order, not a
  // re-fetch that happens to be about the same query.
  await window.click('[data-testid="websearch-page-prev"]')
  await expect(window.locator('[data-testid="websearch-page-1"]')).toHaveAttribute(
    'aria-current',
    'page',
    { timeout: 60_000 }
  )
  expect(await pageNumbers(window), 'Back restores page 1 exactly').toEqual(p1)

  // A numbered jump goes where the number says.
  await goPage(window, 3)
  const p3 = await pageNumbers(window)
  await goPage(window, 2)
  expect(await pageNumbers(window), 'jumping back to 2 restores page 2').toEqual(p2)
  await goPage(window, 3)
  expect(await pageNumbers(window), 'jumping forward to 3 restores page 3').toEqual(p3)
})

test('Papers: the pager does not claim the fetched pages are all there are', async ({
  launch
}) => {
  const window = await launchWithFixture(launch)
  await openPapersWebSearch(window)
  await search(window, 'paging')

  // THE DEFECT THIS PINS. One fetch fills four pages, and a row of numbers
  // ending in a bare "4" is a claim that the search has four pages — for a
  // fixture holding 400 papers. The reader who wants the fifth is told, in the
  // one place that addresses the question, that it does not exist.
  //
  // Asserted as PRESSABLE NUMBERS rather than as an ellipsis: "I must always see
  // more pages if there are more" is a claim about what is on the row, and a
  // symbol standing in for the numbers is what this shipped as and was rejected.
  await expect(
    window.locator('[data-testid="websearch-page-5"]'),
    'a page past what has been fetched is offered as a number'
  ).toBeVisible()
  await expect(window.locator('[data-testid="websearch-page-6"]')).toBeVisible()
  await expect(window.locator('[data-testid="websearch-page-next"]')).toBeEnabled()

  // And the count does not pass "fetched so far" off as "found".
  const count = await window.textContent('[data-testid="websearch-count"]')
  expect(count ?? '', 'the count is hedged while more can be fetched').toContain('so far')
  expect(count ?? '', 'and does not claim to be the total').not.toContain('found')

  // Walking forward really does reach papers beyond that third page, which is
  // what makes the open end a promise the app keeps rather than decoration.
  // THE ROW GROWS AS YOU WALK. The complaint that produced this test was "only
  // 3 pages always": the count of offered numbers stayed put however far the
  // reader went, because each step both added a page and left a new remainder
  // that could not be filled. Whatever the arithmetic, the observable promise is
  // that walking forward reveals more pages than were on offer before.
  // The HIGHEST number offered, not how many are rendered: past seven pages the
  // row windows down to "1 … 6 7 8", so a count of buttons saturates while the
  // pages themselves keep growing. What the reader is promised is that the row
  // reaches further than it did, and that is the furthest number on it.
  const furthest = async (): Promise<number> => {
    const labels = await window.locator('.ing-web-page-num').allTextContents()
    return Math.max(...labels.map((t) => Number(t.trim())))
  }
  const before = await furthest()
  await goPage(window, 6)
  expect(
    await furthest(),
    'the row reaches further after walking forward'
  ).toBeGreaterThan(before)

  const p6 = await pageNumbers(window)
  expect(p6.length, 'page 6 is a full page of papers').toBe(PAGE_SIZE)
  expect(
    Number(p6[0]),
    'page 6 holds papers past the first five pages'
  ).toBeGreaterThan(5 * PAGE_SIZE)
})

test('Papers: a new search returns to page 1', async ({ launch }) => {
  const window = await launchWithFixture(launch)
  await openPapersWebSearch(window)
  await search(window, 'paging')
  await goPage(window, 3)

  await search(window, 'paging again')
  await expect(window.locator('[data-testid="websearch-page-1"]')).toHaveAttribute(
    'aria-current',
    'page',
    { timeout: 60_000 }
  )
})

test('Project creation: the same pager works in the setup form', async ({ launch }) => {
  const window = await launchWithFixture(launch)
  await goto(window, 'projects')
  await window.click('[data-testid="new-project-card"]')
  await window.fill('[data-testid="wizard-name"]', `E2E paging ${Date.now()}`)
  await window.click('[data-testid="wizard-submit"]')
  // Creating an onboarding project lands on the setup form.
  await window.waitForSelector('[data-testid="screen-setup"]', { timeout: 20_000 })

  await window.click('[data-testid="setup-source-web"]')
  await window.waitForSelector('[data-testid="websearch-panel"]', { timeout: 15_000 })
  await search(window, 'paging')

  const p1 = await pageNumbers(window)
  expect(p1.length, 'the setup form pages at the same size').toBe(PAGE_SIZE)

  await goPage(window, 2)
  const p2 = await pageNumbers(window)
  expect(p2.length).toBe(PAGE_SIZE)
  expect(
    p2.filter((n) => p1.includes(n)),
    'no paper is on both pages'
  ).toEqual([])

  await window.click('[data-testid="websearch-page-prev"]')
  await expect(window.locator('[data-testid="websearch-page-1"]')).toHaveAttribute(
    'aria-current',
    'page',
    { timeout: 60_000 }
  )
  expect(await pageNumbers(window), 'Back restores page 1 exactly').toEqual(p1)
})
