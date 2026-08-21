import { test, expect, goto, api } from './helpers/electron'
import type { ProjectDTO } from '../src/shared/contract'

test('project cards render and match listProjects', async ({ launch }) => {
  const { window } = await launch()
  await goto(window, 'projects')

  // Header copy matches the design.
  await expect(window.locator('.dash-title')).toHaveText('Research projects')

  const projects = await api<ProjectDTO[]>(window, 'listProjects')
  // The corpus seeds EXACTLY one project: KE07 Kemp Eliminase Engineering.
  expect(projects.length).toBe(1)
  expect(projects[0].name).toBe('KE07 Kemp Eliminase Engineering')

  const cards = window.locator('[data-testid="project-grid"] [data-testid^="project-card-"]')
  await expect(cards).toHaveCount(projects.length)

  // Each DB project has a matching card.
  for (const p of projects) {
    await expect(window.locator(`[data-testid="project-card-${p.id}"]`)).toBeVisible()
  }
})

test('card figures are derived from the DB, not hardcoded', async ({ launch }) => {
  const { window } = await launch()
  await goto(window, 'projects')

  const projects = await api<ProjectDTO[]>(window, 'listProjects')
  expect(projects.length).toBe(1)

  // The design's mock numbers (342 / 128 / 47) must never appear as our data —
  // guard so a future regression that hardcodes them would fail here.
  for (const p of projects) {
    const papers = window.locator(`[data-testid="project-stat-papers-${p.id}"]`)
    await expect(papers).toHaveText(String(p.work_count))

    // The extracted note is an ASIDE on the headline and, like every other
    // secondary figure on this card, is absent when there is nothing to report.
    const extracted = window.locator(`[data-testid="project-stat-extracted-${p.id}"]`)
    if (p.extracted_count > 0) await expect(extracted).toContainText(String(p.extracted_count))
    else await expect(extracted).toHaveCount(0)

    // The reading bar accounts for every paper exactly once.
    expect(p.decided_count + p.undecided_count + p.unread_count).toBe(p.work_count)

    // work-count stays reachable at its dedicated testid for other specs/smoke.
    await expect(window.locator(`[data-testid="project-work-count-${p.id}"]`)).toHaveText(
      String(p.work_count)
    )
  }
})

test('failed flag renders only when failed_count > 0', async ({ launch }) => {
  const { window } = await launch()
  await goto(window, 'projects')

  // The failure is CAUSED here, not read from the seed, which fabricates none:
  // a `failed` row that nothing ever executed is a claim about a real paper, and
  // the invented ones sent the user hunting a fault that was never there. Bytes
  // that begin `%PDF-` but are not a document pass the import guard, land a real
  // file, and then fail extraction for the honest reason.
  await window.evaluate(async (stamp) => {
    await (
      window as never as { api: { importPdfBytes(i: unknown): Promise<unknown> } }
    ).api.importPdfBytes({
      projectId: 1,
      bytes: new TextEncoder().encode(`%PDF-1.7\ne2e not a document ${stamp}`),
      fileName: `e2e-corrupt-${stamp}.pdf`
    })
  }, Date.now())
  await expect
    .poll(
      async () =>
        (await api<ProjectDTO[]>(window, 'listProjects')).some((p) => p.failed_count > 0),
      { timeout: 60_000 }
    )
    .toBe(true)
  await window.reload()
  await window.waitForSelector('[data-testid="sidebar"]')

  const projects = await api<ProjectDTO[]>(window, 'listProjects')
  const withFailed = projects.find((p) => p.failed_count > 0)!

  const failedPill = window.locator(`[data-testid="project-flag-failed-${withFailed!.id}"]`)
  await expect(failedPill).toBeVisible()
  await expect(failedPill).toContainText(String(withFailed!.failed_count))
  await expect(failedPill).toContainText('failed')

  // The "ONLY when > 0" half of the contract needs a project that has NO
  // failures, and the seed ships exactly one project — which has some. So the
  // zero case is CREATED here rather than looked for: iterating
  // `projects.filter(p => p.failed_count === 0)` over the seeded list gave an
  // empty loop, so the half of the assertion this test is named for never ran.
  const clean = await api<ProjectDTO>(window, 'createProject', {
    name: `no-failures-${Date.now()}`,
    description: 'a project with nothing failed'
  })
  await window.reload()
  await window.waitForSelector('[data-testid="sidebar"]')
  await goto(window, 'projects')

  const after = await api<ProjectDTO[]>(window, 'listProjects')
  expect(
    after.find((p) => p.id === clean.id)!.failed_count,
    'a brand-new project has no failed retrievals'
  ).toBe(0)

  // Its card is on screen…
  await expect(window.locator(`[data-testid="project-card-${clean.id}"]`)).toBeVisible()
  // …and carries NO pill, while the failing project still does.
  await expect(window.locator(`[data-testid="project-flag-failed-${clean.id}"]`)).toHaveCount(0)
  await expect(window.locator(`[data-testid="project-flag-failed-${withFailed!.id}"]`)).toBeVisible()

  // Counted DB-side across the whole list, so a pill on the wrong card fails.
  const expectedPills = after.filter((p) => p.failed_count > 0).length
  expect(expectedPills, 'exactly one project has failures, so the count discriminates').toBe(1)
  await expect(window.locator('[data-testid^="project-flag-failed-"]')).toHaveCount(expectedPills)
})

test('creating a project adds a card and persists across reload', async ({ launch }) => {
  const { window, app } = await launch()
  await goto(window, 'projects')

  const before = await api<ProjectDTO[]>(window, 'listProjects')

  const name = `E2E Project ${Date.now()}`
  await window.click('[data-testid="new-project-card"]')
  await window.fill('[data-testid="wizard-name"]', name)
  await window.fill('[data-testid="wizard-description"]', 'created by e2e')
  await window.click('[data-testid="wizard-submit"]')

  // The wizard opens the new project (graph screen); go back to projects.
  await goto(window, 'projects')

  const after = await api<ProjectDTO[]>(window, 'listProjects')
  expect(after.length).toBe(before.length + 1)
  const created = after.find((p) => p.name === name)
  expect(created, 'new project persisted in DB').toBeTruthy()
  await expect(window.locator(`[data-testid="project-card-${created!.id}"]`)).toBeVisible()

  // Reload the renderer: the project is still there (DB-backed, not in-memory).
  const win2 = await app.firstWindow()
  await win2.reload()
  await win2.waitForSelector('[data-testid="sidebar"]')
  await win2.click('[data-testid="nav-projects"]')
  await win2.waitForSelector('[data-testid="screen-projects"]')
  await expect(win2.locator(`[data-testid="project-card-${created!.id}"]`)).toBeVisible()
})
