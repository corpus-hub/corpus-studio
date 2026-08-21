import { test, expect, goto, api, selectProject } from './helpers/electron'
import type { DossierBriefingDTO, DossierStatusDTO } from '../src/shared/contract'

/**
 * The Topic Dossier's contract with the user is EPISTEMIC, not cosmetic, so
 * these specs assert honesty properties rather than pixels:
 *  - everything rendered traces back to a DB row (window.api.getDossierBriefing),
 *  - the screen carries BACKGROUND — the project's statement, its defined terms,
 *    which papers matter and what each adds — and never extracted measurements,
 *  - the sizes shown are the PAYLOAD's, not the rendering's, so they do not move
 *    when a disclosure is opened,
 *  - a paper chosen for the dossier but holding no text says so, because a build
 *    would read nothing from it,
 */

const openDossier = async (window: import('@playwright/test').Page): Promise<void> => {
  await selectProject(window, 1)
  await goto(window, 'dossier')
  await window.waitForSelector('[data-testid="dossier-rail"]', { timeout: 15_000 })
}

const briefingOf = (window: import('@playwright/test').Page): Promise<DossierBriefingDTO> =>
  api<DossierBriefingDTO>(window, 'getDossierBriefing', 1)

test('every paper in the project is listed in the rail, exactly once', async ({ launch }) => {
  const { window } = await launch()
  await openDossier(window)

  const b = await briefingOf(window)
  expect(b.papers.length).toBeGreaterThan(0)

  for (const p of b.papers) {
    await expect(window.locator(`[data-testid="dossier-paper-${p.work_id}"]`)).toHaveCount(1)
  }
  await expect(window.locator('[data-testid^="dossier-paper-"]')).toHaveCount(b.papers.length)
})

test('the briefing renders the DB’s own strings, never literals', async ({ launch }) => {
  const { window } = await launch()
  await openDossier(window)

  const b = await briefingOf(window)
  const body = await window.locator('[data-testid="screen-dossier"]').innerText()

  if (b.about) expect(body).toContain(b.about.slice(0, 60))
  // Every defined term, with the schema that carries it.
  for (const g of b.terms) {
    expect(body).toContain(g.name)
    for (const t of g.terms) expect(body).toContain(t.label)
  }
  // Titles come from the DB, so a paper the corpus does not hold cannot appear.
  for (const p of b.papers.slice(0, 5)) expect(body).toContain(p.title.slice(0, 40))
})

test('no extracted measurement reaches this screen', async ({ launch }) => {
  const { window } = await launch()
  await openDossier(window)

  // The dossier is BACKGROUND: terminology, definitions, which papers matter. A
  // measurement is quoted to a model when it reads the paper that reported it.
  // This is the property the redesign exists to guarantee, so it is asserted
  // against the fact rows themselves rather than against a list of words.
  const rows = await api<Array<{ value_text: string | null }>>(window, 'getDossier', 1)
  const values = rows
    .map((r) => (r.value_text ?? '').trim())
    // Values short enough to collide with ordinary prose prove nothing.
    .filter((v) => v.length >= 6)
  const body = await window.locator('[data-testid="screen-dossier"]').innerText()
  for (const v of values.slice(0, 40)) expect(body).not.toContain(v)
})

test('each section states its size, and the size is the payload’s not the screen’s', async ({
  launch
}) => {
  const { window } = await launch()
  await openDossier(window)

  for (const id of ['about', 'terms', 'papers', 'adds', 'compiled']) {
    await expect(window.locator(`[data-testid="dossier-section-${id}"]`)).toHaveCount(1)
  }

  const sizes = (): Promise<string[]> =>
    window.locator('[data-testid^="dossier-section-"] .ds-sec-size').allTextContents()
  const before = await sizes()

  // Opening a disclosure puts more text on screen and changes nothing about
  // what a model would be sent. A size that moved here would be measuring the
  // UI rather than the payload.
  const first = window.locator('.ds-add').first()
  if ((await first.count()) > 0) {
    await first.locator('.ds-add-h').click()
    await expect(first).toHaveAttribute('open', '')
    expect(await sizes()).toEqual(before)
  }
})

test('a chosen paper with no stored text says a build cannot read it', async ({ launch }) => {
  const { window } = await launch()
  await openDossier(window)

  const b = await briefingOf(window)
  for (const p of b.papers) {
    const row = window.locator(`[data-testid="dossier-paper-${p.work_id}"]`)
    // Exactly the shortfall: in the dossier, but with nothing to read.
    await expect(row.locator('.ds-row-warn')).toHaveCount(
      p.is_reference && p.paragraphs === 0 ? 1 : 0
    )
  }
})

test('choosing a paper writes to the DB and the rail follows the stored value', async ({
  launch
}) => {
  const { window } = await launch()
  await openDossier(window)

  const before = await briefingOf(window)
  const target = before.papers.find((p) => !p.is_reference)
  expect(target).toBeTruthy()
  const id = target!.work_id

  await window.click(`[data-testid="dossier-toggle-${id}"]`)
  await expect(window.locator(`[data-testid="dossier-paper-${id}"]`)).toHaveClass(/is-on/)

  const after = await briefingOf(window)
  expect(after.papers.find((p) => p.work_id === id)?.is_reference).toBe(true)

  // Put it back, so the fixture DB is left as it was found.
  await window.click(`[data-testid="dossier-toggle-${id}"]`)
  await expect(window.locator(`[data-testid="dossier-paper-${id}"]`)).not.toHaveClass(/is-on/)
})

test('membership uses the app’s shared control, not a local copy', async ({ launch }) => {
  const { window } = await launch()
  await openDossier(window)

  // `DossierToggle` is the one control for this decision — Ranking rows, the
  // Paper header and here — so the same fact cannot end up in two colours one
  // tab apart. A local switch on this screen is the drift it exists to prevent.
  const b = await briefingOf(window)
  await expect(window.locator('.ds-row .dossier-toggle')).toHaveCount(b.papers.length)
  await expect(window.locator('[data-testid^="dossier-toggle-"]').first()).toHaveClass(
    /dossier-toggle/
  )
})

test('the rail can be searched and scoped to the chosen papers', async ({ launch }) => {
  const { window } = await launch()
  await openDossier(window)

  const b = await briefingOf(window)
  const chosen = b.papers.filter((p) => p.is_reference).length

  await window.click('[data-testid="dossier-scope-in"]')
  await expect(window.locator('[data-testid^="dossier-paper-"]')).toHaveCount(chosen)

  await window.click('[data-testid="dossier-scope-all"]')
  await expect(window.locator('[data-testid^="dossier-paper-"]')).toHaveCount(b.papers.length)

  // A query matching nothing must SAY so, rather than leaving an empty rail
  // that is indistinguishable from a project with no papers.
  await window.fill('[data-testid="dossier-rail-search"]', 'zzzz-no-such-paper')
  await expect(window.locator('.cg-papers-none')).toHaveCount(1)
  await window.fill('[data-testid="dossier-rail-search"]', '')
  await expect(window.locator('[data-testid^="dossier-paper-"]')).toHaveCount(b.papers.length)
})

test('a never-compiled dossier says so, and the state matches the DB', async ({ launch }) => {
  const { window } = await launch()
  await openDossier(window)

  const status = await api<DossierStatusDTO>(window, 'getDossierStatus', 1)
  const built = await window.locator('[data-testid="dossier-built-at"]').innerText()
  if (status.built_at === null) {
    expect(built).toContain('never compiled')
    // §5 is the one part a model must write, and it must not present itself as
    // done while it holds nothing.
    await expect(window.locator('[data-testid="dossier-section-compiled"]')).not.toHaveClass(
      /is-done/
    )
  } else {
    expect(built).toContain('compiled')
  }
})

test('rail rows are keyboard reachable and keep a visible focus ring', async ({ launch }) => {
  const { window } = await launch()
  await openDossier(window)

  const b = await briefingOf(window)
  // A CHOSEN row: its tint is declared after the focus rule and used to
  // override it, so this is the case worth asserting rather than the default.
  const chosen = b.papers.find((p) => p.is_reference) ?? b.papers[0]
  const title = window.locator(`[data-testid="dossier-paper-${chosen.work_id}"] .ds-row-main`)
  // Enter keyboard-interaction mode first: Chromium only matches
  // :focus-visible on a programmatically focused button when the most recent
  // input was a keypress (navigation above uses clicks).
  await window.keyboard.press('Tab')
  await title.focus()
  await expect(title).toBeFocused()
  const outline = await title.evaluate((el) => getComputedStyle(el).outlineWidth)
  expect(parseFloat(outline)).toBeGreaterThan(0)
  await expect(title).toHaveAttribute('aria-label', /Open paper/)
})
