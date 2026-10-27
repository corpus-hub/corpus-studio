import { test, expect, goto, api, selectProject } from './helpers/electron'
import type { Page } from '@playwright/test'
import type { JobDTO } from '../src/shared/contract'

/**
 * A job that REALLY failed, PRODUCED by the test rather than read from the seed.
 *
 * The seed deliberately fabricates no failures: a `failed` row carrying no
 * stage_run_id is a claim about a real paper that nothing ever ran, and the two
 * that used to be here contradicted the pipeline — a red badge sent the user
 * hunting a fault that was never there. So a spec needing a failure must cause
 * one. Importing BYTES that begin `%PDF-` but are not a document passes the
 * import guard and lands a REAL file in the library, so the pipeline runs for
 * real and `extract-text` fails NON-retryably on the first attempt — corrupt
 * bytes are not a transient condition.
 *
 * Three nearer routes do not work, and each is a trap worth naming: an
 * unresolvable DOI is refused synchronously, before any job exists; a title or
 * URL that nothing serves fails RETRYABLY, so the row sits queued through five
 * backed-off attempts; and a PDF PATH that does not exist is SKIPPED by design
 * ("the library simply does not hold these bytes"), never failed.
 */
async function failedJob(
  window: Page,
  projectId: number
): Promise<JobDTO> {
  // Built INSIDE the page: the handler validates `instanceof Uint8Array`, and an
  // array serialised across `evaluate`'s argument boundary arrives as a plain
  // Array and is refused before any job exists.
  await window.evaluate(
    async ([pid, stamp]) => {
      const text = `%PDF-1.7\ne2e not a document ${stamp}`
      await (window as never as { api: { importPdfBytes(i: unknown): Promise<unknown> } }).api
        .importPdfBytes({
          projectId: pid,
          bytes: new TextEncoder().encode(text),
          fileName: `e2e-corrupt-${stamp}.pdf`
        })
    },
    [projectId, Date.now()] as const
  )
  await expect
    .poll(
      async () =>
        (await api<JobDTO[]>(window, 'listJobs', projectId)).some((j) => j.status === 'failed'),
      { timeout: 60_000 }
    )
    .toBe(true)
  const jobs = await api<JobDTO[]>(window, 'listJobs', projectId)
  // The queue groups a paper's jobs into ONE row anchored on its LATEST job,
  // whatever that job's status, and EVERY control on the row — Retry, Cancel,
  // the error — is keyed by that anchor's id. So the id a spec must use is the
  // anchor's, both for the DOM and for `jobs:retry`, which the row's own Retry
  // button calls with exactly that id.
  const anyFailed = jobs.find((j) => j.status === 'failed')!
  const sameWork = jobs.filter((j) => j.work_id === anyFailed.work_id)
  return sameWork.reduce((a, b) => (b.id > a.id ? b : a))
}

test('ingesting a title enqueues a processing job', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'ingest')

  const before = await api<JobDTO[]>(window, 'listJobs', 1)

  // No manual kind chips any more: the identifier sub-tab classifies a pasted
  // string (free text → the 'title' kind). The screen opens on "Search existing
  // papers", so the identifier tab is selected explicitly.
  //
  // ITS OWN TAB, and that is the point of asserting it here: importing by
  // identifier is CORE and works with no plugin at all, while searching the
  // indexes needs one. They were one tab with two sub-tabs, which would have
  // made this test depend on a plugin it has nothing to do with.
  await window.click('[data-testid="ingest-tab-identifier"]')
  await window.fill('[data-testid="ingest-input"]', `E2E ingest ${Date.now()}`)
  await window.click('[data-testid="ingest-submit"]')

  await expect
    .poll(async () => (await api<JobDTO[]>(window, 'listJobs', 1)).length, { timeout: 10_000 })
    .toBeGreaterThan(before.length)

  // A new job row appears in the queue, which is now its own tab.
  await window.click('[data-testid="ingest-tab-queue"]')
  await expect(window.locator('[data-testid^="job-row-"]').first()).toBeVisible()
})

test('retry on a failed job changes status and persists', async ({ launch }) => {
  const { window, app } = await launch()
  await selectProject(window, 1)
  await goto(window, 'ingest')

  const projectId = 1
  const failed = await failedJob(window, projectId)

  // The queue is its own tab; inside it the default filter is "All", so narrow
  // to Failed to put the retry control unambiguously in view before clicking.
  //
  // The row is found through the control the user actually presses rather than
  // by computing its id: the queue collapses a paper's jobs into ONE row keyed
  // by whichever of them is latest, so an id derived here names the right row
  // only by luck. Filtering to Failed leaves exactly the rows that have one.
  await window.click('[data-testid="ingest-tab-queue"]')
  await window.click('[data-testid="ingest-filter-failed"]')
  const retry = window.locator('[data-testid^="job-retry-"]').first()
  await expect(retry).toBeVisible()
  const rowJobId = Number(
    (await retry.getAttribute('data-testid'))!.replace('job-retry-', '')
  )
  await retry.click()

  await expect
    .poll(async () => {
      const list = await api<JobDTO[]>(window, 'listJobs', projectId)
      return list.find((j) => j.id === rowJobId)?.status
    }, { timeout: 10_000 })
    .not.toBe('failed')

  // Persist across reload.
  const win2 = await app.firstWindow()
  await win2.reload()
  await win2.waitForSelector('[data-testid="sidebar"]')
  const persisted = await win2.evaluate(
    ([pid, jid]) =>
      (window as any).api
        .listJobs(pid)
        .then((l: JobDTO[]) => l.find((j) => j.id === jid)?.status),
    [projectId, rowJobId] as const
  )
  expect(persisted).not.toBe('failed')
})

// Cancel stops OUTSTANDING work, so it is enabled only while a row still has a
// queued or running job — a failed row has nothing left to stop, and its button
// is disabled and says so. The worker drains queued jobs on startup, so to get a
// stably-queued job we PAUSE the queue first and then retry a failed job: that
// is the real cancellable state, rather than cancelling a terminal row.
test('cancel control moves a cancellable job to cancelled', async ({ launch }) => {
  const { window } = await launch()

  await selectProject(window, 1)
  await goto(window, 'ingest')
  await window.click('[data-testid="ingest-tab-queue"]')

  const failed = await failedJob(window, 1)

  // A failed row has no outstanding work: the control must be present (a button
  // that vanishes reads as a missing feature) but disabled AND self-explaining.
  // Reached through the filter rather than by a computed id, because the queue
  // keys a row by whichever of a paper's jobs is latest.
  await window.click('[data-testid="ingest-filter-failed"]')
  const retry = window.locator('[data-testid^="job-retry-"]').first()
  await expect(retry).toBeVisible()
  const rowJobId = Number(
    (await retry.getAttribute('data-testid'))!.replace('job-retry-', '')
  )
  const cancelBtn = window.locator(`[data-testid="job-cancel-${rowJobId}"]`)
  await expect(cancelBtn).toBeDisabled()
  // The reason names the CONDITION rather than enumerating the queue's internal
  // states — a reader does not have to know what `blocked` means to understand
  // that there is nothing left to stop.
  await expect(cancelBtn).toHaveAttribute(
    'data-tip',
    /nothing is in progress here, so there is nothing to stop/i
  )

  // Pause so the retried job stays queued instead of being drained instantly.
  // Retry through the BUTTON: the row's testid names its anchor job, but the
  // handler behind it retries the job that actually failed, and those are
  // different rows of `processing_job`.
  await api(window, 'pauseQueue')
  await retry.click()
  await expect
    .poll(async () => {
      const list = await api<JobDTO[]>(window, 'listJobs', 1)
      // The job the row's Retry acted on is the one that FAILED, not the anchor
      // its testid names — those are different rows of `processing_job`, and
      // asserting on the anchor would report the state of a job nothing touched.
      return list.find((j) => j.id === failed.id)?.status
    }, { timeout: 10_000 })
    .toBe('queued')

  // Now it IS cancellable, and the same button becomes live.
  await window.click('[data-testid="ingest-filter-all"]')
  await expect(cancelBtn).toBeEnabled()
  await cancelBtn.click()
  await expect
    .poll(async () => {
      const list = await api<JobDTO[]>(window, 'listJobs', 1)
      return list.find((j) => j.id === failed.id)?.status
    }, { timeout: 10_000 })
    .toBe('cancelled')
})

test('entry tabs are Search / Import from file, and it shows a clickable drop area', async ({
  launch
}) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'ingest')

  // Sidebar label is "Papers"; the route testid stays nav-ingest.
  await expect(window.locator('[data-testid="nav-ingest"]')).toContainText('Papers')

  // The sources that need NOTHING installed, plus the queue — which is a
  // destination rather than a source and so trails them behind a divider.
  //
  // "Search for new papers" is deliberately NOT among them, and its absence is
  // the assertion. Searching the outside world is a plugin capability and this
  // fixture installs no plugin, so the tab is absent rather than present and
  // failing when pressed — while importing by identifier and from a file keep
  // working, because both are plain core ingest.
  const tabs = window.locator('[data-testid="ingest-kind-tabs"] [role="tab"]')
  await expect(tabs).toHaveCount(4)
  await expect(tabs.nth(0)).toHaveText('Search existing papers')
  await expect(tabs.nth(1)).toHaveText('By identifier')
  await expect(tabs.nth(2)).toHaveText('Import from file')
  await expect(tabs.nth(3)).toContainText('Queue')
  await expect(window.locator('[data-testid="ingest-project"]')).toHaveCount(0)
  await expect(window.locator('[data-testid="ingest-modules"]')).toHaveCount(0)
  await expect(window.locator('[data-testid="ingest-kinds"]')).toHaveCount(0)

  // Drop area only on the "Import from file" tab, labelled, with a keyboard route.
  await expect(window.locator('[data-testid="ingest-drop"]')).toHaveCount(0)
  await window.click('[data-testid="ingest-tab-file"]')
  const drop = window.locator('[data-testid="ingest-drop"]')
  await expect(drop).toBeVisible()
  await expect(drop).toContainText(/drop pdfs or folders here/i)
  // The zone is a pure drop target rather than a role=button: it now contains a
  // real "Choose file or folder" button, and a button nested inside a widget
  // with role=button is invalid and unreachable for a screen reader. The drop
  // gesture has no keyboard equivalent, so that button IS the keyboard route
  // and must genuinely be focusable — otherwise browsing is mouse-only.
  await expect(drop).not.toHaveAttribute('role', 'button')
  const pick = window.locator('[data-testid="ingest-pick-file"]')
  await expect(pick).toBeVisible()
  await expect(pick).toBeEnabled()
  await pick.focus()
  await expect(pick).toBeFocused()
  // Click-to-browse goes through MAIN, not a hidden <input type=file>: ingest
  // needs an ABSOLUTE path and Electron 33 removed File.path, so only
  // dialog.showOpenDialog / webUtils can supply one. The dialog is modal and
  // cannot be driven from the renderer, so assert the bridges exist — including
  // the folder expansion, without which a dropped directory queues nothing.
  const bridged = await window.evaluate(() => {
    const api = (window as unknown as { api: Record<string, unknown> }).api
    return [typeof api.pickIngestFiles, typeof api.expandIngestPaths, typeof api.getDroppedPath]
  })
  expect(bridged).toEqual(['function', 'function', 'function'])
  await expect(window.locator('[data-testid="ingest-pick-file"]')).toHaveCount(1)

  // The queue and its controls survive the simplification, on their own tab.
  await expect(window.locator('[data-testid="ingest-filters"]')).toHaveCount(0)
  await window.click('[data-testid="ingest-tab-queue"]')
  await expect(window.locator('[data-testid="ingest-filters"]')).toBeVisible()
  await window.click('[data-testid="ingest-filter-failed"]')
  await failedJob(window, 1)
  const retry = window.locator('[data-testid^="job-retry-"]').first()
  await expect(retry).toBeVisible()
  const rowJobId = Number(
    (await retry.getAttribute('data-testid'))!.replace('job-retry-', '')
  )
  await expect(window.locator(`[data-testid="job-error-${rowJobId}"]`)).toBeVisible()
  await expect(window.locator(`[data-testid="job-cancel-${rowJobId}"]`)).toBeVisible()
})
