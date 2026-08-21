import type { Page } from '@playwright/test'
import { test, expect, goto, api, selectProject } from './helpers/electron'
import type {
  ReviewItemDTO,
  ProjectDTO,
  AnalysisRunDTO,
  ExtractionStatusSummaryDTO
} from '../src/shared/contract'

// The review queue surfaces every fact that needs human verification: uncertain
// or conflicting, inferred, a failed/partial verifier, a record a second reading
// contradicted, or §12's random spot-check of auto-validated records. It must
// NEVER surface a clean directly-reported fact for no reason at all.
// (Confirmed against getReviewQueue in repositories.ts.)
const REVIEW_KINDS = ['uncertain-conflicting', 'inferred']

/** Mirrors ReviewScreen's PAGE_SIZE. */
const PAGE_SIZE = 40

/** The fact ids of the rows currently mounted, in rendered order. */
const renderedIds = (window: Page): Promise<number[]> =>
  window
    .locator('[data-testid^="review-item-"]')
    .evaluateAll((els) =>
      els.map((e) => Number((e.getAttribute('data-testid') ?? '').replace('review-item-', '')))
    )

/**
 * Click "Show more" until the whole (filtered) queue is mounted.
 *
 * BOUNDED, and each click must actually reveal rows. An unbounded `while` here
 * would let a control that stays but stops revealing anything spin until the
 * test timeout, reporting a hang instead of the real fault.
 */
async function showAll(window: Page, total: number): Promise<void> {
  const more = window.locator('[data-testid="review-show-more"]')
  const rows = window.locator('[data-testid^="review-item-"]')
  const maxClicks = Math.ceil(total / PAGE_SIZE) + 1
  for (let i = 0; (await more.count()) > 0; i++) {
    expect(i, 'paging terminates within one click per page').toBeLessThan(maxClicks)
    const before = await rows.count()
    await more.click()
    await expect
      .poll(() => rows.count(), { message: 'each Show more click reveals rows' })
      .toBeGreaterThan(before)
  }
}

test('review queue surfaces only facts that need verification', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'review')

  const items = await api<ReviewItemDTO[]>(window, 'getReviewQueue', 1)
  expect(items.length, 'seed has review-queue facts for project 1').toBeGreaterThan(0)

  // The ONLY way a clean, directly-reported fact may appear is as
  // §12's random spot-check — so that escape hatch is checked against the
  // sampler's own list rather than being accepted on trust.
  const summary = await api<ExtractionStatusSummaryDTO>(window, 'getExtractionStatusSummary', 1)
  const qcSampleIds = new Set(summary.qc_sample.map((q) => q.fact_id))

  // Every surfaced item is a flagged kind OR justified by a failed verifier /
  // contradicted by a second reading — or is a sampled record.
  for (const it of items) {
    const flaggedKind = REVIEW_KINDS.includes(it.kind)
    const badVerifier = it.verifier_result === 'partial' || it.verifier_result === 'failed'
    const failedCheck = it.failed_checks.length > 0
    const sampled = qcSampleIds.has(it.fact_id)
    expect(
      flaggedKind || badVerifier || failedCheck || sampled,
      `item kind=${it.kind} verifier=${it.verifier_result} checks=${it.failed_checks.length} must justify review`
    ).toBe(true)
    // A spot-check item is exactly that: it must carry the sampler's reason,
    // never be mislabelled as a fault it does not have.
    if (!flaggedKind && !badVerifier && !failedCheck) {
      expect(it.reason, `sampled fact ${it.fact_id} reads as a spot-check`).toBe(
        'Spot-check of an auto-validated record'
      )
    }
  }

  // The list PAGINATES (40 at a time) — the real corpus escalates hundreds of
  // facts and mounting them all would be a DOM the reviewer cannot use. What
  // must never happen is the queue quietly SHRINKING to the page, so the header
  // states the full count and "Show more" walks to the end without loss.
  const cards = window.locator('[data-testid^="review-item-"]')
  await expect(cards).toHaveCount(Math.min(PAGE_SIZE, items.length))
  await expect(window.locator('[data-testid="review-count"]')).toContainText(String(items.length))

  await showAll(window, items.length)
  const seen = new Set(await renderedIds(window))
  // Every queued fact is reachable by paging — nothing is dropped, and no row
  // is invented that the DTO does not contain.
  expect(seen.size, 'paging to the end reaches every queued fact').toBe(items.length)
  expect([...seen].every((id) => items.some((i) => i.fact_id === id))).toBe(true)
})

test('queue is prioritised most-uncertain-first and bucket chips partition it', async ({
  launch
}) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'review')

  const items = await api<ReviewItemDTO[]>(window, 'getReviewQueue', 1)

  // Severity precedence must mirror getReviewQueue's `reason` chain and
  // ReviewScreen's BUCKETS exactly. A contradicted record outranks every
  // epistemic hedge: it is a demonstrated defect, not the model hedging.
  const rank = (it: ReviewItemDTO): number => {
    if (it.failed_checks.length > 0) return 0
    if (it.kind === 'uncertain-conflicting') return 1
    if (it.verifier_result === 'failed' || it.verifier_result === 'partial') return 2
    if (it.kind === 'inferred') return 3
    // §12 spot-check: tripped no criterion, so it sorts last.
    return 4
  }

  // Read the rendered order straight off the DOM and assert it is sorted by
  // severity bucket — i.e. genuinely uncertainty-first.
  // The list paginates, so page to the end first: asserting only the first page
  // would leave the ordering of everything past row 40 unchecked.
  await showAll(window, items.length)
  const ids = await renderedIds(window)
  expect(ids.length).toBe(items.length)

  const byId = new Map(items.map((i) => [i.fact_id, i]))
  for (let i = 1; i < ids.length; i++) {
    const prev = byId.get(ids[i - 1])!
    const cur = byId.get(ids[i])!
    const rp = rank(prev)
    const rc = rank(cur)
    expect(rp, `row ${i} must not be less severe than row ${i - 1}`).toBeLessThanOrEqual(rc)
  }

  // Chip counts must partition the queue: every item is in exactly one bucket,
  // so the visible bucket chips sum to the "All" count.
  const allCount = Number(
    (await window.locator('[data-testid="chip-all"] .chip-count').textContent()) ?? '0'
  )
  expect(allCount).toBe(items.length)

  const bucketCounts = await window
    .locator('.rv-chips .chip:not([data-testid="chip-all"]) .chip-count')
    .evaluateAll((els) => els.map((e) => Number(e.textContent ?? '0')))
  expect(bucketCounts.length, 'at least one bucket chip is rendered').toBeGreaterThan(0)
  expect(bucketCounts.reduce((a, b) => a + b, 0)).toBe(items.length)
})

test('detail panel shows the escalation reason, evidence and real provenance', async ({
  launch
}) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'review')

  const items = await api<ReviewItemDTO[]>(window, 'getReviewQueue', 1)

  // The top-priority item is auto-selected, so the panel is never a dead state.
  const panel = window.locator('[data-testid="review-detail"]')
  await expect(panel).toBeVisible()
  await expect(window.locator('[data-testid="review-panel-empty"]')).toHaveCount(0)

  const selectedId = Number(
    (await window
      .locator('[data-testid^="review-item-"][aria-selected="true"]')
      .getAttribute('data-testid'))!.replace('review-item-', '')
  )
  const selected = items.find((i) => i.fact_id === selectedId)!

  // "Why" block restates the DB-supplied reason verbatim (no invented copy).
  await expect(window.locator('[data-testid="review-why"]')).toContainText(selected.reason)

  // Provenance is read from the run that OWNS this fact — not "the first run".
  const runs = await api<AnalysisRunDTO[]>(window, 'getWorkAnalyses', selected.work_id, 1)
  const owning = runs.find((r) => r.facts.some((f) => f.id === selected.fact_id))
  expect(owning, 'the escalated fact belongs to a real analysis run').toBeTruthy()

  const prov = window.locator(`[data-testid="review-provenance-${owning!.id}"]`)
  await expect(prov).toBeVisible()
  await expect(prov).toContainText(owning!.model)
  await expect(prov).toContainText(owning!.provider)
  await expect(prov).toContainText(owning!.prompt_version)
  await expect(prov).toContainText(owning!.schema_version)

  // Evidence: either the real quote, or an HONEST "no span anchored" note —
  // never a fabricated stand-in.
  const fact = owning!.facts.find((f) => f.id === selected.fact_id)!
  if (fact.evidence?.quote) {
    await expect(window.locator('[data-testid="review-evidence"]')).toContainText(
      fact.evidence.quote.slice(0, 40)
    )
  } else {
    await expect(window.locator('[data-testid="review-no-evidence"]')).toBeVisible()
  }

  // Resolve affordances are present and labelled.
  await expect(window.locator('[data-testid="review-actions"]')).toBeVisible()
})

test('queue is keyboard-operable: arrow keys move the selection', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'review')

  const items = await api<ReviewItemDTO[]>(window, 'getReviewQueue', 1)
  // ASSERTED, not skipped. A `test.skip(items.length < 2)` here would silently
  // vacate the entire keyboard contract the moment the seed stopped producing a
  // second escalated fact — the test would go green by never running. The demo
  // seed deterministically escalates several facts for project 1, so a queue
  // shorter than two is a seed regression and must fail loudly.
  expect(items.length, 'seed escalates at least two facts for project 1').toBeGreaterThanOrEqual(2)

  const rows = window.locator('[data-testid^="review-item-"]')
  const first = rows.nth(0)
  await expect(first).toHaveAttribute('aria-selected', 'true')

  await first.focus()
  await window.keyboard.press('ArrowDown')
  await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true')
  await expect(first).toHaveAttribute('aria-selected', 'false')

  await window.keyboard.press('ArrowUp')
  await expect(first).toHaveAttribute('aria-selected', 'true')

  // End goes to the last MOUNTED row. The list paginates, so that is the end of
  // the loaded page, not of the queue — a listbox must not jump the selection
  // onto a row the user cannot see.
  const loaded = await rows.count()
  expect(loaded, 'the first page is mounted').toBe(Math.min(PAGE_SIZE, items.length))
  await window.keyboard.press('End')
  await expect(rows.nth(loaded - 1)).toHaveAttribute('aria-selected', 'true')

  await window.keyboard.press('Home')
  await expect(first).toHaveAttribute('aria-selected', 'true')

  // …and after paging, End reaches the newly loaded rows: the keyboard must
  // follow the list as it grows, not stay pinned to the first page.
  await showAll(window, items.length)
  const all = await rows.count()
  expect(all).toBe(items.length)
  await rows.nth(0).focus()
  await window.keyboard.press('End')
  await expect(rows.nth(all - 1)).toHaveAttribute('aria-selected', 'true')
  await window.keyboard.press('Home')
  await expect(first).toHaveAttribute('aria-selected', 'true')

  // The list is an accessible listbox, not a bare div soup.
  await expect(window.locator('[data-testid="review-list"]')).toHaveAttribute('role', 'listbox')

  // Filter chips are a single-select radiogroup, and selection state is exposed
  // to assistive tech rather than being signalled by colour alone.
  await expect(window.locator('.rv-chips')).toHaveAttribute('role', 'radiogroup')
  await expect(window.locator('[data-testid="chip-all"]')).toHaveAttribute('aria-checked', 'true')
})

test('bucket chip filters the queue to that escalation reason only', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'review')

  const items = await api<ReviewItemDTO[]>(window, 'getReviewQueue', 1)

  // A fact can trip several criteria at once, and the chips are a PARTITION:
  // each item is filed under its highest-precedence reason only. So the
  // expected membership is computed with the same first-match precedence the
  // screen uses (`BUCKETS` in ReviewScreen), not by kind alone — filtering by
  // `kind === 'uncertain-conflicting'` predicted a set the app rightly never
  // shows, because those facts were ALSO contradicted by a second reading and belong
  // under "Check failed".
  const bucketOf = (it: ReviewItemDTO): string => {
    if (it.failed_checks.length > 0) return 'check-failed'
    if (it.kind === 'uncertain-conflicting') return 'conflicting'
    if (it.verifier_result === 'failed' || it.verifier_result === 'partial')
      return 'malformed-output'
    if (it.kind === 'inferred') return 'inferred'
    return 'quality-control'
  }
  const members = new Map<string, ReviewItemDTO[]>()
  for (const it of items) {
    const k = bucketOf(it)
    members.set(k, [...(members.get(k) ?? []), it])
  }
  // ASSERTED, not skipped, and PROPER-SUBSET: with an empty or whole-queue
  // bucket every assertion below degenerates to a tautology that would pass
  // even if the filter were hardwired to render nothing (or everything).
  const narrow = [...members.entries()]
    .filter(([, v]) => v.length > 0 && v.length < items.length)
    .sort((a, b) => a[1].length - b[1].length)
  expect(narrow.length, 'the corpus escalates for more than one distinct reason').toBeGreaterThan(0)
  const [key, expected] = narrow[0]

  await window.click(`[data-testid="chip-${key}"]`)
  const rows = window.locator('[data-testid^="review-item-"]')
  await showAll(window, items.length)
  await expect(rows).toHaveCount(expected.length)
  // The status line reports the filtered count from real data, not a guess.
  await expect(window.locator('[data-testid="review-status"]')).toContainText(
    `showing ${expected.length} of ${items.length}`
  )
  for (const c of expected) {
    await expect(window.locator(`[data-testid="review-item-${c.fact_id}"]`)).toBeVisible()
  }
  // …and NOTHING from another bucket leaked in: "filtered to that reason only"
  // is only proven by the exclusions.
  for (const other of items.filter((i) => bucketOf(i) !== key)) {
    await expect(
      window.locator(`[data-testid="review-item-${other.fact_id}"]`),
      `fact ${other.fact_id} belongs to ${bucketOf(other)}, not ${key}`
    ).toHaveCount(0)
  }

  await window.click('[data-testid="chip-all"]')
  await showAll(window, items.length)
  await expect(rows).toHaveCount(items.length)
})

test('empty-state copy renders for a project with no review items', async ({ launch }) => {
  const { window } = await launch()

  // Create a brand-new empty project (no analyses -> no review facts).
  const created = await api<ProjectDTO>(window, 'createProject', {
    name: `empty-review-${Date.now()}`,
    description: 'no facts'
  })
  const items = await api<ReviewItemDTO[]>(window, 'getReviewQueue', created.id)
  expect(items.length).toBe(0)

  // Reload so the dashboard lists the new project, then open it via its card.
  await window.reload()
  await window.waitForSelector('[data-testid="sidebar"]')
  await selectProject(window, created.id)
  await window.click('[data-testid="nav-review"]')
  await window.waitForSelector('[data-testid="screen-review"]')
  await expect(window.locator('[data-testid="review-empty"]')).toBeVisible()
  // A project with no papers has had nothing read, and the screen says THAT
  // rather than "nothing needs review" — those are opposite claims, and
  // reporting a clean queue for a corpus nobody has extracted is the wrong one.
  await expect(window.locator('[data-testid="review-empty"]')).toContainText(
    /Nothing has been extracted yet/i
  )
  // The empty state must EXPLAIN why nothing is here, not just say "empty", and
  // offer the action that would change it.
  await expect(window.locator('[data-testid="review-empty"]')).toContainText(
    /claims a model made about your papers/i
  )
  await expect(window.locator('[data-testid="review-empty"]')).toContainText(/Add papers/i)
  // No triage chrome when there is nothing to triage.
  await expect(window.locator('[data-testid="review-detail"]')).toHaveCount(0)
})
