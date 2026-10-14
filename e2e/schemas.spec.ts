import { test, expect, goto, api, selectProject, chooseOption } from './helpers/electron'
import type { ExtractionSchemaDTO, ExtractionRowDTO } from '../src/shared/contract'

/**
 * SCHEMAS — the extraction-schema definition surface, now APP-LEVEL.
 *
 * These specs pin the abstraction that keeps the app domain-agnostic:
 *   - two REAL schemas come from the seeded DB (never a component literal),
 *   - the screen is reachable with NO PROJECT OPEN (schemas are global, so they
 *     live in the projects-level sidebar, not inside a project),
 *   - a user can create a schema and a field through the UI and both PERSIST
 *     across a full renderer reload (i.e. they are in SQLite, not React state),
 *   - the built-in schemas are delete-protected so seeded data can't be
 *     silently unlinked.
 */

test('Schemas is an APP-LEVEL screen: reachable with no project open', async ({ launch }) => {
  const { window } = await launch()

  // Cold start lands on the projects dashboard with NO project opened. The
  // Schemas item must be right there in the sidebar…
  await expect(window.locator('[data-testid="screen-projects"]')).toBeVisible()
  await expect(window.locator('[data-testid="nav-schemas"]')).toBeVisible()

  // …and clicking it must render the real screen, NOT the "No project selected"
  // guard every project-scoped route falls into.
  await goto(window, 'schemas')
  await expect(window.locator('[data-testid="no-project"]')).toHaveCount(0)
  await expect(window.locator('[data-testid="error-state"]')).toHaveCount(0)
  await expect(window.locator('[data-testid="app-error-boundary"]')).toHaveCount(0)

  // The screen states its global scope rather than leaving the user to guess.
  await expect(window.locator('[data-testid="schema-global-note"]')).toBeVisible()

  // The data really loaded with no project id in play.
  const schemas = await api<ExtractionSchemaDTO[]>(window, 'listSchemas')
  expect(schemas.length).toBeGreaterThanOrEqual(2)
  await expect(window.locator(`[data-testid="schema-item-${schemas[0].id}"]`)).toBeVisible()

  // Schemas is NOT in the in-project sidebar any more: opening a project must
  // swap in the project-scoped nav and drop the Schemas entry.
  await selectProject(window, 1)
  await expect(window.locator('[data-testid="nav-extraction"]')).toBeVisible()
  await expect(window.locator('[data-testid="nav-schemas"]')).toHaveCount(0)
})

test('the app ships two DB-backed extraction schemas with real fields', async ({
  launch
}) => {
  const { window } = await launch()
  await goto(window, 'schemas')

  const schemas = await api<ExtractionSchemaDTO[]>(window, 'listSchemas')
  expect(schemas.length, 'seed defines at least two schemas').toBeGreaterThanOrEqual(2)

  // Every schema in the list is rendered, and its rendered name matches the DTO
  // — proving the list comes from window.api and not from a hardcoded array.
  for (const s of schemas) {
    const item = window.locator(`[data-testid="schema-item-${s.id}"]`)
    await expect(item).toBeVisible()
    await expect(item).toContainText(s.name)
    // A useful schema has fields; each field carries a type from the DB enum.
    expect(s.fields.length, `${s.key} has fields`).toBeGreaterThan(0)
    for (const f of s.fields) {
      expect(['number', 'text', 'enum', 'boolean']).toContain(f.data_type)
      if (f.data_type === 'enum') {
        expect(f.enum_options?.length ?? 0, `${f.key} enum has options`).toBeGreaterThan(0)
      }
    }
  }

  // The detail pane renders the selected schema's fields from the DB rows.
  const first = schemas[0]
  await window.click(`[data-testid="schema-item-${first.id}"]`)
  await expect(window.locator(`[data-testid="schema-detail-${first.id}"]`)).toBeVisible()
  for (const f of first.fields) {
    await expect(window.locator(`[data-testid="field-row-${f.id}"]`)).toBeVisible()
  }
})

test('CRUD: a created schema + field persist across a full reload', async ({ launch }) => {
  const { window } = await launch()
  await goto(window, 'schemas')

  const before = await api<ExtractionSchemaDTO[]>(window, 'listSchemas')

  // ---- create a schema through the UI -------------------------------------
  // The form asks ONLY for a name: the stable `key` is DERIVED from it by
  // `uniqueSchemaKey` in main, so a user cannot mint a duplicate or a key that
  // disagrees with the name they typed. The spec asserts the derivation rather
  // than supplying a key (there is no input for one, and asking for a slug is
  // asking the user to do the database's job).
  await window.click('[data-testid="schema-create"]')
  await window.fill('[data-testid="schema-new-name"]', 'Directed Evolution Campaign')
  await window.click('[data-testid="schema-create-submit"]')

  await expect
    .poll(async () => (await api<ExtractionSchemaDTO[]>(window, 'listSchemas')).length)
    .toBe(before.length + 1)

  const afterCreate = await api<ExtractionSchemaDTO[]>(window, 'listSchemas')
  const created = afterCreate.find((s) => s.name === 'Directed Evolution Campaign')
  expect(created, 'created schema is in the DB').toBeTruthy()
  expect(created!.key, 'the key is slugified from the name').toBe('directed-evolution-campaign')
  expect(created!.is_builtin, 'user schemas are not built-in').toBe(false)
  // A schema is born with no fields — the version is the hash of an EMPTY field
  // list, a real value rather than a placeholder to be bumped later.
  expect(created!.fields, 'a new schema starts empty').toHaveLength(0)
  await expect(window.locator(`[data-testid="schema-item-${created!.id}"]`)).toBeVisible()

  // ---- add a field to it --------------------------------------------------
  await window.click(`[data-testid="schema-item-${created!.id}"]`)
  await window.click('[data-testid="field-add"]')
  // Like the schema key, a field's `key` is DERIVED from its label by
  // `normalizeKey` in main (lowercased, non-[a-z0-9_] runs collapsed to '-').
  // The form therefore asks for a LABEL only, and the spec asserts the slug the
  // derivation produces — 'Library size' -> 'library-size'.
  await window.fill('[data-testid="field-label-input"]', 'Library size')
  await chooseOption(window, 'field-type-select', 'number')
  await window.fill('[data-testid="field-unit-input"]', 'variants')
  await window.click('[data-testid="field-save"]')

  await expect
    .poll(async () => {
      const list = await api<ExtractionSchemaDTO[]>(window, 'listSchemas')
      return list.find((s) => s.id === created!.id)?.fields.length ?? 0
    })
    .toBe(1)

  // ---- RELOAD: the definition must survive (it lives in SQLite) -----------
  await window.reload()
  await window.waitForSelector('[data-testid="sidebar"]')
  await goto(window, 'schemas')

  const reloaded = await api<ExtractionSchemaDTO[]>(window, 'listSchemas')
  const persisted = reloaded.find((s) => s.key === 'directed-evolution-campaign')
  expect(persisted, 'schema survived the reload').toBeTruthy()
  const field = persisted!.fields.find((f) => f.key === 'library-size')
  expect(field, 'field survived the reload with its derived key').toBeTruthy()
  expect(field!.label, 'and with the label the user actually typed').toBe('Library size')
  expect(field!.data_type).toBe('number')
  expect(field!.unit).toBe('variants')

  await window.click(`[data-testid="schema-item-${persisted!.id}"]`)
  await expect(window.locator(`[data-testid="field-row-${field!.id}"]`)).toBeVisible()

  // ---- delete the field, then the schema ---------------------------------
  await window.click(`[data-testid="field-delete-${field!.id}"]`)
  await expect
    .poll(async () => {
      const list = await api<ExtractionSchemaDTO[]>(window, 'listSchemas')
      return list.find((s) => s.id === persisted!.id)?.fields.length ?? -1
    })
    .toBe(0)

  await window.click(`[data-testid="schema-delete-${persisted!.id}"]`)
  // Deleting is GLOBAL, so it is confirmed in a second step whose warning quotes
  // the real attached-project / measurement counts.
  await expect(
    window.locator(`[data-testid="schema-delete-confirm-${persisted!.id}"]`)
  ).toBeVisible()
  await window.click(`[data-testid="schema-delete-confirm-btn-${persisted!.id}"]`)
  await expect
    .poll(async () => {
      const list = await api<ExtractionSchemaDTO[]>(window, 'listSchemas')
      return list.some((s) => s.key === 'directed-evolution-campaign')
    })
    .toBe(false)
})

test('built-in schemas are delete-protected and keep their measurement links', async ({
  launch
}) => {
  const { window } = await launch()
  await goto(window, 'schemas')

  const schemas = await api<ExtractionSchemaDTO[]>(window, 'listSchemas')
  const builtin = schemas.filter((s) => s.is_builtin)
  expect(builtin.length, 'seed ships built-in schemas').toBeGreaterThanOrEqual(2)

  // The delete control for a built-in is disabled in the UI …
  await window.click(`[data-testid="schema-item-${builtin[0].id}"]`)
  await expect(window.locator(`[data-testid="schema-delete-${builtin[0].id}"]`)).toBeDisabled()

  // … and the main-process repository rejects it too (defence in depth).
  const rejected = await window.evaluate(async (id: number) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (window as any).api.deleteSchema(id)
      return false
    } catch {
      return true
    }
  }, builtin[0].id)
  expect(rejected, 'deleting a built-in schema is rejected').toBe(true)

  // Seeded measurements are linked to built-in schema FIELDS (this is what makes
  // the Extraction tab schema-driven rather than enzyme-hardcoded).
  const rows = await api<ExtractionRowDTO[]>(window, 'getExtractionRows', 1)
  const linked = rows.filter((r) => r.schema_id != null && r.field_id != null)
  expect(linked.length, 'seeded rows are schema-linked').toBeGreaterThan(0)
  const linkedSchemaIds = new Set(linked.map((r) => r.schema_id))
  expect(linkedSchemaIds.size, 'more than one schema carries data').toBeGreaterThanOrEqual(2)
})
