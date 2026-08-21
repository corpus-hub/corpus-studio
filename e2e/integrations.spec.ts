import { test, expect, goto, api, selectProject } from './helpers/electron'
import type {
  ExportOptionDTO,
  OutletActionDTO,
  OutletSettingsDTO,
  OutletStatusDTO
} from '../src/shared/contract'

test('integrations status renders (Zotero/Obsidian)', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'integrations')

  const status = window.locator('[data-testid="integration-status"]')
  await expect(status).toBeVisible()
  await expect(status).toContainText(/Zotero/i)
  await expect(status).toContainText(/Obsidian/i)
})

test('each outlet states its situation in a sentence, not a list of crosses', async ({
  launch
}) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'integrations')

  const outlets = await api<OutletStatusDTO[]>(window, 'listOutlets', 1)
  expect(outlets.map((o) => o.id).sort()).toEqual(['obsidian', 'zotero'])

  for (const o of outlets) {
    // The headline names what was found rather than an abstract "connected".
    await expect(window.locator(`[data-testid="outlet-${o.id}-status"]`)).toContainText(o.headline)

    // The per-probe checklist is deliberately NOT rendered: on an unconfigured
    // machine it filled half the card with crosses restating the one fact the
    // headline already gives. The checks still drive `ready` and the problem
    // line; they are simply not narrated one by one.
    await expect(window.locator(`[data-testid="outlet-${o.id}-checks"]`)).toHaveCount(0)

    // Nor is there a separate problem BOX. Collapsing the checklist to "the
    // first failing check" was worse than the checklist: those labels are
    // phrased as satisfied conditions so they can sit beside a yes/no badge, so
    // alone they assert the opposite of the truth — a user with no Zotero was
    // told "Zotero library found". The state is the headline; what to DO about
    // it is the control beside the thing that is missing.
    await expect(window.locator(`[data-testid="outlet-${o.id}-problem"]`)).toHaveCount(0)
    if (!o.ready) {
      // An outlet that cannot be used is not a dead end: whatever actions it
      // offers are still SHOWN, disabled, each saying why (HARD RULE 0.5) — a
      // control that silently fails to respond reads as a broken app. An outlet
      // may legitimately offer none until it is configured (Zotero's card leads
      // with the chooser instead), so the assertion is about how an action that
      // EXISTS behaves, not about there being one.
      // The headline must NAME the shortfall, not merely report a state. This is
      // the assertion that cannot go vacuous: an outlet may offer no actions
      // until it is configured, so a loop over its actions alone would pass by
      // executing nothing.
      const headline = window.locator(`[data-testid="outlet-${o.id}-status"]`)
      await expect(headline).toContainText(o.headline)
      expect(o.headline.trim().length, `outlet ${o.id} explains itself`).toBeGreaterThan(0)
      await expect(headline).toHaveClass(/is-off/)

      const actions = await api<Array<{ id: string }>>(window, 'listOutletActions', 1, o.id)
      for (const a of actions) {
        const btn = window.locator(`[data-testid="outlet-${o.id}-${a.id}"]`)
        await expect(btn).toBeVisible()
        await expect(btn).toBeDisabled()
        await expect(btn).toHaveAttribute('data-tip', /.+/)
      }
    }
  }
})

test('a fresh install reports "no", not "unknown" — nothing is configured yet', async ({
  launch
}) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'integrations')

  // "Unknown" is reserved for a probe that could not be ANSWERED (a hung mount).
  // "Nothing has been configured" is an answer, and reporting it as unknown
  // drains the meaning from the state that flags genuine uncertainty. This
  // shipped on both outlets before being caught by looking at the screen.
  const outlets = await api<OutletStatusDTO[]>(window, 'listOutlets', 1)
  const obsidian = outlets.find((o) => o.id === 'obsidian')!
  expect(obsidian.checks.every((c) => c.ok !== null)).toBe(true)
})

test('every outlet switch PERSISTS — no switch on this screen is decorative', async ({
  launch
}) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'integrations')

  // The regression guard for the rewrite: this screen used to hold switch
  // positions in React state behind a "not saved" badge. There must be no such
  // badge, and every switch must survive a full reload of the renderer.
  const screen = window.locator('[data-testid="screen-integrations"]')
  await expect(screen).not.toContainText(/not saved/i)
  await expect(screen).not.toContainText(/read-only/i)

  const flipped: Array<[string, boolean]> = []
  for (const testid of [
    'obsidian-toggle-backlinks',
    'obsidian-toggle-auto',
    'zotero-toggle-summary',
    'zotero-toggle-project'
  ]) {
    const sw = window.locator(`[data-testid="${testid}"] button.int-switch`)
    const before = (await sw.getAttribute('aria-checked')) === 'true'
    await sw.click()
    await expect(sw).toHaveAttribute('aria-checked', String(!before))
    flipped.push([testid, !before])
  }

  // The positions must come back from SQLITE, not from component state. Asserted
  // by re-reading through the IPC that main answers from the database, and then
  // by navigating away and back so the components remount from scratch.
  const persisted = await api<OutletSettingsDTO>(window, 'getOutletSettings')
  expect(persisted.obsidian.backlinks).toBe(
    flipped.find(([t]) => t === 'obsidian-toggle-backlinks')![1]
  )
  expect(persisted.obsidian.auto_mirror).toBe(
    flipped.find(([t]) => t === 'obsidian-toggle-auto')![1]
  )
  expect(persisted.zotero.summary_notes).toBe(
    flipped.find(([t]) => t === 'zotero-toggle-summary')![1]
  )

  await goto(window, 'graph')
  await goto(window, 'integrations')
  for (const [testid, expected] of flipped) {
    await expect(
      window.locator(`[data-testid="${testid}"] button.int-switch`),
      `${testid} after remount`
    ).toHaveAttribute('aria-checked', String(expected))
  }
})

test('an outlet action is disabled with a REASON, never silently inert', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'integrations')

  // No vault is configured on a fresh DB, so both write actions must be
  // unavailable AND say why — a control that merely fails to respond reads as
  // a broken app.
  const actions = await api<OutletActionDTO[]>(window, 'listOutletActions', 1, 'obsidian')
  expect(actions.length).toBeGreaterThan(0)
  for (const a of actions) {
    expect(a.disabled_reason).toBeTruthy()
    const btn = window.locator(`[data-testid="outlet-obsidian-${a.id}"]`)
    await expect(btn).toBeDisabled()
    await expect(btn).toHaveAttribute('data-tip', a.disabled_reason!)
  }

  // ...and main ENFORCES it rather than trusting the UI to have disabled it.
  const res = await api<{ ok: boolean }>(window, 'runOutletAction', 1, 'obsidian', 'write')
  expect(res.ok).toBe(false)
})

test('the note preview is rendered by the same code that writes the file', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'integrations')

  const works = await api<Array<{ work: { id: number } }>>(window, 'listProjectWorks', 1)
  const md = await api<string | null>(window, 'previewOutletNote', 1, works[0].work.id)
  expect(md).toBeTruthy()
  // A preview computed by different code than the writer is a promise the app
  // may not keep, so the panel renders the writer's own output verbatim.
  const preview = window.locator('[data-testid="obsidian-preview"]')
  await expect(preview).toBeVisible()
  await expect(preview).toContainText('corpus_work_id')
})

// Storage locations and per-project space are asserted in settings.spec.ts —
// they live in Settings now, because where files live is configuration rather
// than an outlet.

test('the screen no longer carries storage configuration', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'integrations')
  await expect(window.locator('[data-testid^="basedir-"]')).toHaveCount(0)
  await expect(window.locator('[data-testid="storage-usage"]')).toHaveCount(0)
})

test('the export list is derived from the project, naming no format in the UI', async ({
  launch
}) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'integrations')

  // Export is its own tab: it is a different errand from configuring an outlet,
  // and sitting below both outlet cards put the most commonly wanted thing on
  // the screen off the bottom of the page.
  await window.click('[data-testid="integrations-tab-export"]')

  const options = await api<ExportOptionDTO[]>(window, 'listExportOptions', 1)
  // Two structural formats, plus CSV+XLSX per attached schema, plus the
  // all-schemas workbook once there is more than one.
  expect(options.length).toBeGreaterThanOrEqual(4)
  for (const o of options) {
    await expect(window.locator(`[data-testid="export-${o.id}"]`)).toBeVisible()
  }

  // Every schema the project attaches is offered as a spreadsheet, by NAME —
  // and no format the project does not have is offered at all. This is the
  // regression guard for the removed hardcoded domain-format button.
  const schemas = await api<Array<{ id: number; name: string }>>(window, 'listProjectSchemas', 1)
  for (const s of schemas) {
    expect(options.some((o) => o.id === `table:${s.id}:xlsx` && o.label.includes(s.name))).toBe(
      true
    )
    expect(options.some((o) => o.id === `table:${s.id}:csv`)).toBe(true)
  }
})

test('export reports what was actually produced (no fake file path)', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'integrations')

  await window.click('[data-testid="integrations-tab-export"]')
  await window.click('[data-testid="export-json"]')
  const msg = window.locator('[data-testid="export-msg"]')
  await expect(msg).toBeVisible()
  // Export now WRITES a file, so it opens a native save dialog. That dialog is
  // modal and cannot be driven from the renderer, so this test asserts the
  // pre-dialog state only: the UI reports work in progress and, crucially,
  // never claims a file was saved before one exists.
  await expect(msg).toContainText(/choose where to save|working|building/i)
  await expect(msg).not.toContainText(/saved to|Exported json →/)

  // The document itself is still produced correctly and is DB-backed.
  const json = await api<string>(window, 'exportProject', 1, 'json')
  expect(json.length).toBeGreaterThan(0)
  expect(() => JSON.parse(json)).not.toThrow()
})

test('exportProject returns a non-empty parseable JSON string', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'integrations')

  const json = await api<string>(window, 'exportProject', 1, 'json')
  expect(typeof json).toBe('string')
  expect(json.length).toBeGreaterThan(0)
  const parsed = JSON.parse(json)
  expect(parsed).toBeTruthy()
})
