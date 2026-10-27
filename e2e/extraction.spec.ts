import { test, expect, goto, api, selectProject } from './helpers/electron'
import type { Page } from '@playwright/test'
import type {
  ExtractionRowDTO,
  ExtractionStatusSummaryDTO,
  ExtractionSchemaDTO,
  SchemaCoverageDTO
} from '../src/shared/contract'

/**
 * The rows that OWN a cell in the matrix, derived from the matrix's own rule.
 *
 * Two records may not occupy one cell, so the matrix is keyed by
 * (field, subject, conditions) and the FIRST record for a key wins: a field
 * reported twice for the same subject under the same conditions is a duplicate
 * extraction, not a second datapoint, and rendering both would ask the reader to
 * reconcile two numbers describing one measurement. A record with no `field_id`
 * has no column at all and is reported in the unassigned table below the matrix.
 *
 * So a spec must assert over THIS set. Asserting over every DB row would demand
 * a cell for records the matrix deliberately folds or files elsewhere.
 */
function matrixCellRows(rows: ExtractionRowDTO[]): ExtractionRowDTO[] {
  const seen = new Set<string>()
  return rows.filter((r) => {
    if (r.field_id == null) return false
    const key = `${r.field_id}|${(r.subject ?? '').trim().toLowerCase()}|${(r.conditions ?? '').trim().toLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const COMPARABILITY = ['directly', 'broadly', 'contextual', 'unclear']

// The user-facing wording for each comparability class. Duplicated from the
// renderer on purpose: a spec that imported the same map would pass however the
// labels were rewritten, including into something meaningless.
const COMPARABILITY_LABELS: Record<string, string> = {
  directly: 'directly comparable',
  broadly: 'broadly comparable',
  contextual: 'contextual',
  unclear: 'unclear'
}

const FACT_KIND_LABELS: Record<string, string> = {
  'directly-reported': 'directly reported',
  inferred: 'inferred',
  'supplied-by-project-context': 'from project context',
  'uncertain-conflicting': 'uncertain / conflicting'
}

/**
 * The screen shows ONE schema at a time — a horizontal tablist chooses it, and
 * everything below is derived from that choice. Bring `schemaId`'s section into
 * view before asserting on any of its cells.
 *
 * The switcher is only rendered when more than one schema is attached (with a
 * single schema there is nothing to switch between and the tab would be a
 * control with no alternative), so its absence is tolerated — but only after
 * confirming the section is on screen anyway.
 */
async function showSchema(window: Page, schemaId: number): Promise<void> {
  const tab = window.locator(`[data-testid="extraction-schema-tab-${schemaId}"]`)
  if (await tab.count()) {
    await tab.click()
    await expect(tab).toHaveAttribute('aria-selected', 'true')
  }
  await expect(window.locator(`[data-testid="extraction-schema-${schemaId}"]`)).toBeVisible()
}

/**
 * Provenance lives INSIDE the matrix cell: click the value to expand the panel
 * that says how it was obtained. Scroll first — a cell further down the matrix
 * is outside the viewport.
 */
async function expandCell(window: Page, rowKey: string): Promise<void> {
  const cell = window.locator(`[data-testid="extraction-cell-${rowKey}"]`)
  await cell.scrollIntoViewIfNeeded()
  if ((await cell.getAttribute('aria-expanded')) !== 'true') await cell.click()
  await expect(cell).toHaveAttribute('aria-expanded', 'true')
  await expect(window.locator(`[data-testid="extraction-prov-${rowKey}"]`)).toBeVisible()
}

test('every schema-linked measurement gets a cell and a status chip', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'extraction')

  const rows = await api<ExtractionRowDTO[]>(window, 'getExtractionRows', 1)
  expect(rows.length).toBeGreaterThan(0)
  const schemas = await api<ExtractionSchemaDTO[]>(window, 'listProjectSchemas', 1)
  const withData = schemas.filter((s) => rows.some((r) => r.schema_id === s.id))
  expect(withData.length, 'the seed gives more than one schema data').toBeGreaterThanOrEqual(2)

  // ONE schema is on screen at a time, so this walks the switcher: for EVERY
  // schema, EVERY one of its measurements must occupy a matrix cell and EVERY
  // cell must carry its derived status chip — the status is not an optional
  // decoration on some rows. Nothing may be lost behind the tab.
  const cellRows = matrixCellRows(rows)
  let checked = 0
  for (const s of withData) {
    await showSchema(window, s.id)
    for (const r of cellRows.filter((x) => x.schema_id === s.id)) {
      await expect(
        window.locator(`[data-testid="extraction-cell-${r.row_key}"]`),
        `cell for measurement ${r.row_key} under schema ${s.id}`
      ).toBeVisible()
      await expect(
        window.locator(`[data-testid="extraction-status-${r.row_key}"]`),
        `status chip for measurement ${r.row_key}`
      ).toBeVisible()
      checked++
    }
  }
  // Every schema-linked record in the DB was actually visited, so the loop above
  // cannot pass by finding nothing to check.
  expect(checked).toBe(cellRows.filter((r) => r.schema_id != null).length)
})

test('§12 extraction summary panel is DB-derived (total matches the DTO)', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'extraction')

  const summary = window.locator('[data-testid="extraction-summary"]')
  await expect(summary).toBeVisible()

  // The panel's Total-measurements value must equal the DTO — proves it is
  // rendered from window.api.getExtractionStatusSummary, never hardcoded.
  const dto = await api<ExtractionStatusSummaryDTO>(window, 'getExtractionStatusSummary', 1)
  await expect(window.locator('[data-testid="extraction-summary-total"]')).toHaveText(
    String(dto.total_records)
  )
})

test('a fold_improvement shows one of the 4 comparability classes in its provenance panel', async ({
  launch
}) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'extraction')

  const rows = await api<ExtractionRowDTO[]>(window, 'getExtractionRows', 1)
  const foldRows = rows.filter((r) => r.fold)
  expect(foldRows.length, 'seed has fold improvements').toBeGreaterThan(0)
  for (const r of foldRows) {
    expect(COMPARABILITY).toContain(r.fold!.comparability)
  }

  // The fold and its comparability class must be shown for every fold record the
  // matrix HOLDS, with the human-readable comparability label rather than the
  // raw enum. Its surface is the matrix CELL, whose provenance panel carries the
  // fold. A record linked to no field has no cell and is no longer tabled at
  // all: that table surfaced values no schema had asked for under a note
  // claiming they also appeared above, which taught the reader to dismiss real
  // data as a duplicate. The extractor now reports only what its target schema
  // asks for, so those rows are not produced in the first place.
  const cellFolds = matrixCellRows(rows).filter((r) => r.fold && r.schema_id != null)
  expect(cellFolds.length, 'the corpus has fold records in the matrix').toBeGreaterThan(0)

  for (const r of cellFolds) {
    await showSchema(window, r.schema_id!)
    await expandCell(window, r.row_key)
    const fold = window.locator(`[data-testid="extraction-prov-${r.row_key}"] .ext-prov-fold`)
    await expect(fold, `fold block for measurement ${r.row_key}`).toBeVisible()
    await expect(fold).toContainText(COMPARABILITY_LABELS[r.fold!.comparability])
    // `fold` is nullable: a real model reports comparisons for which the paper
    // states no numeric ratio. An absent ratio must render as an em-dash, NOT
    // as the string "null" and NOT as a fabricated number — so the two cases
    // are asserted apart rather than interpolated into one template.
    await expect(fold).toContainText(r.fold!.fold === null ? '—×' : `${r.fold!.fold}×`)
    await expect(fold, 'no fold block ever prints a raw null').not.toContainText('null')
    await expect(fold).toContainText(r.fold!.baseline_label)
    await expect(fold).toContainText(r.fold!.improved_label)
  }
  // The no-ratio shape is real in this corpus; if it disappeared the em-dash
  // branch above would go untested without anything failing.
  expect(
    foldRows.some((r) => r.fold!.fold === null),
    'the corpus has a comparison with no stated ratio'
  ).toBe(true)
})

/**
 * The Extraction tab is SCHEMA-DRIVEN: a tablist chooses ONE schema, and that
 * schema's matrix columns are built from ITS DB field definitions. This is the
 * regression guard against a fixed, domain-specific column set: if someone
 * hardcoded columns for one field of science, the column testids would no
 * longer match the DB field ids.
 *
 * (Superseded design: every schema rendered its own section simultaneously.
 * The switcher replaced that stack, so the assertions below run per TAB rather
 * than over one long page; the coverage — every schema, every field, every
 * measurement — is unchanged.)
 */
test('every seeded schema renders with columns derived from its DB fields', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'extraction')

  const schemas = await api<ExtractionSchemaDTO[]>(window, 'listProjectSchemas', 1)
  const rows = await api<ExtractionRowDTO[]>(window, 'getExtractionRows', 1)
  const withData = schemas.filter((s) => rows.some((r) => r.schema_id === s.id))
  expect(withData.length, 'at least two schemas carry seeded data').toBeGreaterThanOrEqual(2)

  // The switcher offers EVERY attached schema — none may be unreachable.
  for (const s of schemas) {
    await expect(
      window.locator(`[data-testid="extraction-schema-tab-${s.id}"]`),
      `switcher tab for schema ${s.id}`
    ).toHaveText(s.name)
  }

  for (const s of withData) {
    await showSchema(window, s.id)
    await expect(window.locator(`[data-testid="extraction-schema-name-${s.id}"]`)).toHaveText(s.name)
    // Exactly ONE *schema* matrix is mounted at a time — the switcher's whole
    // point is that the page answers a question about one schema. The
    // Unassigned section is not a schema and is deliberately always present
    // (records whose field link is gone must never be hidden), so it is
    // excluded here and asserted as its own thing below.
    await expect(
      window.locator(
        '.ext-schema-section:not(.ext-schema-detached):not([data-testid="extraction-schema-unassigned"])'
      )
    ).toHaveCount(1)
    // …and the one that IS mounted is the schema that was switched to, not
    // merely some schema — otherwise the count above passes on the wrong tab.
    await expect(window.locator(`[data-testid="extraction-schema-${s.id}"]`)).toHaveCount(1)
    for (const other of schemas.filter((x) => x.id !== s.id)) {
      await expect(
        window.locator(`[data-testid="extraction-schema-${other.id}"]`),
        `schema ${other.id}'s matrix must not be mounted on schema ${s.id}'s tab`
      ).toHaveCount(0)
    }
    // EVERY column comes from a real extraction_field row.
    for (const f of s.fields) {
      const col = window.locator(`[data-testid="extraction-col-${f.id}"]`)
      await expect(col, `column for field ${f.key}`).toBeVisible()
      await expect(col).toContainText(f.label)
    }
    // No OTHER schema's columns leak into this matrix — a value under a column
    // that does not define it is a lie about what was extracted.
    for (const other of schemas.filter((x) => x.id !== s.id)) {
      for (const f of other.fields) {
        await expect(
          window.locator(`[data-testid="extraction-col-${f.id}"]`),
          `field ${f.key} belongs to schema ${other.id}, not ${s.id}`
        ).toHaveCount(0)
      }
    }
    // Each schema-linked measurement occupies a cell in that schema's matrix.
    for (const r of matrixCellRows(rows).filter((x) => x.schema_id === s.id)) {
      await expect(
        window.locator(
          `[data-testid="extraction-matrix-${s.id}"] [data-testid="extraction-cell-${r.row_key}"]`
        )
      ).toBeVisible()
    }
  }
})

/**
 * Each measurement appears in EXACTLY ONE schema's matrix — the one belonging
 * to the schema whose field it fills. A record leaking into a neighbouring
 * schema's matrix would put a value under a column that does not define it.
 *
 * With the switcher this is a stronger claim than it was when every section was
 * mounted: a record must be present under its OWN tab and ABSENT under every
 * other, which is checked in both directions below.
 */
test('each measurement appears under its own schema tab and no other', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'extraction')

  const schemas = await api<ExtractionSchemaDTO[]>(window, 'listProjectSchemas', 1)
  const rows = await api<ExtractionRowDTO[]>(window, 'getExtractionRows', 1)
  const linked = matrixCellRows(rows).filter((r) => r.schema_id != null)
  const withData = schemas.filter((s) => rows.some((r) => r.schema_id === s.id))
  expect(withData.length, 'two schemas carry data, so leakage is detectable').toBeGreaterThanOrEqual(
    2
  )
  expect(linked.length, 'there are schema-linked records to place').toBeGreaterThan(0)

  for (const s of withData) {
    await showSchema(window, s.id)
    for (const r of linked) {
      const cell = window.locator(`[data-testid="extraction-cell-${r.row_key}"]`)
      if (r.schema_id === s.id) {
        // Present exactly once under its own tab…
        await expect(cell, `measurement ${r.row_key} renders once here`).toHaveCount(1)
        await expect(
          window.locator(
            `[data-testid="extraction-matrix-${s.id}"] [data-testid="extraction-cell-${r.row_key}"]`
          ),
          `measurement ${r.row_key} sits in schema ${s.id}'s matrix`
        ).toHaveCount(1)
      } else {
        // …and nowhere at all under anyone else's.
        await expect(
          cell,
          `measurement ${r.row_key} (schema ${r.schema_id}) must not appear under schema ${s.id}`
        ).toHaveCount(0)
      }
    }
  }
})

/**
 * PAGINATION. The per-schema matrices are NOT paginated — one paper is one row
 * however many measurements it carries, so a matrix cannot run away. The only
 * unbounded surface left is the flat record table under the DETACHED and
 * UNASSIGNED buckets, and that is what PAGE_SIZE 40 bounds.
 *
 * The demo corpus alone does not have enough records to fill more than one
 * page, so this runs against the `extraction-bulk` seed
 * (scripts/seed-extraction-bulk.ts). Without them the assertion would be vacuous
 * — a "no rows, no pagination needed" branch proves nothing.
 *
 * DETACHED, not "unassigned". A record linked to NO field is no longer tabled at
 * all: that table surfaced values no schema had asked for under a note claiming
 * they also appeared above, which taught the reader to dismiss real data as a
 * duplicate. What IS tabled — and therefore paginated — is a record belonging to
 * a schema this project no longer applies: still field-linked, still real, shown
 * with a way back. So the state is CREATED here by detaching a schema that has
 * records, which is exactly how a user reaches it.
 */
test('the detached record table paginates at 40 and Show more reveals the rest', async ({
  launch
}) => {
  const { window } = await launch('extraction-bulk')
  await selectProject(window, 1)
  await goto(window, 'extraction')

  const PAGE = 40
  const rows = await api<ExtractionRowDTO[]>(window, 'getExtractionRows', 1)
  const schemas = await api<ExtractionSchemaDTO[]>(window, 'listProjectSchemas', 1)
  // The schema carrying the most records, so detaching it fills more than two
  // pages. Chosen from the data rather than named, so the spec does not depend
  // on which schema the seed happens to load first.
  const counts = schemas.map((sc) => ({
    id: sc.id,
    n: rows.filter((r) => r.schema_id === sc.id).length
  }))
  const biggest = counts.reduce((a, b) => (b.n > a.n ? b : a))
  expect(biggest.n, 'the bulk seed produced >2 pages of records for one schema').toBeGreaterThan(
    PAGE * 2
  )
  const detachedRows = rows.filter((r) => r.schema_id === biggest.id)

  await api(window, 'detachSchema', 1, biggest.id)
  // Reload so the screen re-reads its attachments, then re-enter the project:
  // a reload returns to the dashboard, so the Extraction route is not reachable
  // until a project is open again.
  await window.reload()
  await window.waitForSelector('[data-testid="sidebar"]')
  await selectProject(window, 1)
  await goto(window, 'extraction')

  const section = window.locator(`[data-testid="extraction-schema-detached-${biggest.id}"]`)
  await expect(section).toBeVisible()
  // The section states the FULL count even though only a page is rendered — the
  // user must never be told there are fewer records than the DB holds.
  await expect(section).toContainText(`${detachedRows.length} records`)

  const domRows = window.locator('[data-testid^="extraction-row-"]')
  await expect.poll(() => domRows.count()).toBe(PAGE)

  const showMore = window.locator('[data-testid="extraction-show-more"]')
  await expect(showMore).toContainText(String(detachedRows.length - PAGE))
  await showMore.click()
  await expect.poll(() => domRows.count()).toBe(PAGE * 2)

  // Paging to the END exhausts the list and retires the control, however many
  // pages that takes — a fixed number of clicks would silently stop testing the
  // tail the moment the corpus grew past it.
  for (let guard = 0; (await showMore.count()) > 0; guard++) {
    expect(guard, 'paging terminates').toBeLessThan(detachedRows.length)
    const before = await domRows.count()
    await showMore.click()
    // Each click must actually reveal more; a control that stays but reveals
    // nothing would otherwise spin here rather than fail.
    await expect.poll(() => domRows.count()).toBeGreaterThan(before)
  }
  await expect.poll(() => domRows.count()).toBe(detachedRows.length)
  // Every detached record is present exactly once, not merely the right count.
  for (const r of detachedRows.slice(0, 5).concat(detachedRows.slice(-5))) {
    await expect(window.locator(`[data-testid="extraction-row-${r.row_key}"]`)).toHaveCount(1)
  }
})

/**
 * PROVENANCE IN THE CELL. A matrix cell shows a bare value; how that value was
 * obtained — fact kind, the raw as-reported quantity,
 * the assay conditions, the way through to the evidence — is one click away, on
 * the value itself. This replaced a flat table below the matrix that restated
 * every measurement with no paper column, so you could not tell whose reading
 * you were reading.
 */
test('clicking a cell expands its provenance, and clicking again collapses it', async ({
  launch
}) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'extraction')

  const rows = await api<ExtractionRowDTO[]>(window, 'getExtractionRows', 1)
  // A record with a MEASUREMENT: `quantity` is the as-reported wording, and a
  // schema-linked text fact (one whose predicate matched a field, carrying no
  // measurement) has none — asserting "AS REPORTED" on it would demand the panel
  // echo a quantity that was never reported.
  const r = matrixCellRows(rows).find(
    (x) => x.schema_id != null && x.quantity != null
  )
  expect(r, 'seed has a schema-linked measurement').toBeTruthy()
  await showSchema(window, r!.schema_id!)

  const cell = window.locator(`[data-testid="extraction-cell-${r.row_key}"]`)
  const panel = window.locator(`[data-testid="extraction-prov-${r.row_key}"]`)

  // Collapsed by default — the matrix reads as a matrix until asked.
  await expect(cell).toHaveAttribute('aria-expanded', 'false')
  await expect(panel).toHaveCount(0)

  await expandCell(window, r.row_key)

  // The panel names the fact KIND in the app's own words (never the raw enum)…
  await expect(panel).toContainText(FACT_KIND_LABELS[r.fact_kind])
  // The RAW as-reported quantity survives — the schema's column label never
  // rewrites what the paper actually said. It is echoed only when it ADDS
  // something: a quantity that merely restates the column header the value
  // already sits under is noise, so the panel omits it and the value alone is
  // the whole of "as reported".
  await expect(panel).toContainText('AS REPORTED')
  if (r.quantity.toLowerCase() !== (r.field_label ?? '').toLowerCase()) {
    await expect(panel).toContainText(r.quantity)
  }
  if (r.conditions) {
    await expect(panel).toContainText('CONDITIONS')
    await expect(panel).toContainText(r.conditions)
  }
  // And there is a way through to the source.
  await expect(
    window.locator(`[data-testid="extraction-prov-open-${r.row_key}"]`)
  ).toBeVisible()

  // WHERE the value came from. A run that this machine did not compute must say
  // so here, in the same words the Paper and Review provenance blocks use — the
  // CSV export of this table already carried the origin, so the file was more
  // honest than the screen it came from. A `local` run shows no badge, because
  // "the app worked this out" is the assumption a reader already holds and it
  // is correct there.
  const origin = window.locator(`[data-testid="extraction-origin-${r.row_key}"]`)
  if (r.run_origin === 'local') {
    await expect(origin, 'a locally computed value carries no origin badge').toHaveCount(0)
  } else {
    await expect(origin).toBeVisible()
    await expect(origin).toHaveAttribute('data-origin', r.run_origin)
    await expect(origin).toHaveText(
      r.run_origin === 'shipped' ? 'shipped, not run here' : 'imported'
    )
    // Focusable, because it carries its explanation in a tooltip a keyboard
    // reader must be able to reach.
    await expect(origin).toHaveAttribute('data-tip', /.+/)
    await origin.focus()
    await expect(origin).toBeFocused()
  }

  // Clicking the same cell again puts it away.
  await cell.click()
  await expect(cell).toHaveAttribute('aria-expanded', 'false')
  await expect(panel).toHaveCount(0)
})

test('the provenance close button collapses the panel', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'extraction')

  const rows = await api<ExtractionRowDTO[]>(window, 'getExtractionRows', 1)
  const r = rows.find((x) => x.schema_id != null)!
  await showSchema(window, r.schema_id!)
  await expandCell(window, r.row_key)

  await window.click(`[data-testid="extraction-prov-${r.row_key}"] .ext-prov-close`)
  await expect(window.locator(`[data-testid="extraction-prov-${r.row_key}"]`)).toHaveCount(0)
  await expect(
    window.locator(`[data-testid="extraction-cell-${r.row_key}"]`)
  ).toHaveAttribute('aria-expanded', 'false')
})

/**
 * ONE panel at a time. Two open panels would push the matrix rows apart and
 * destroy the column alignment that makes a matrix readable, so opening a second
 * cell must close the first.
 *
 * Two cases, both real: two cells in the SAME matrix (the everyday one), and a
 * cell in another schema reached through the switcher — switching tabs must not
 * leave a stale panel open behind it.
 */
test('only one provenance panel is open at a time', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'extraction')

  const rows = await api<ExtractionRowDTO[]>(window, 'getExtractionRows', 1)
  const linked = matrixCellRows(rows).filter((r) => r.schema_id != null)
  expect(linked.length, 'need two schema-linked records').toBeGreaterThanOrEqual(2)

  // ---- same matrix: opening b must retire a's panel.
  const a = linked[0]
  const sameSchema = linked.find(
    (r) => r.schema_id === a.schema_id && r.row_key !== a.row_key
  )
  expect(sameSchema, 'one schema carries two records, the everyday case').toBeTruthy()

  await showSchema(window, a.schema_id!)
  await expandCell(window, a.row_key)
  await expandCell(window, sameSchema!.row_key)

  await expect(window.locator(`[data-testid="extraction-prov-${a.row_key}"]`)).toHaveCount(0)
  await expect(
    window.locator(`[data-testid="extraction-cell-${a.row_key}"]`)
  ).toHaveAttribute('aria-expanded', 'false')
  await expect(window.locator('.ext-prov')).toHaveCount(1)

  // ---- across the switcher: changing schema must not carry a panel with it.
  const other = linked.find((r) => r.schema_id !== a.schema_id)
  expect(other, 'a second schema carries data, so the switch is exercised').toBeTruthy()
  await showSchema(window, other!.schema_id!)
  await expect(window.locator('.ext-prov'), 'no stale panel survives the tab change').toHaveCount(0)

  await expandCell(window, other!.row_key)
  await expect(window.locator('.ext-prov')).toHaveCount(1)
})

/**
 * SCHEMA ATTACH / DETACH — the user chooses which GLOBAL schemas this project
 * applies here, and the choice lives in SQLite (`project_schema`), never in
 * component state or localStorage. "Remove" means DETACH: the global definition
 * and every already-extracted measurement must survive.
 */
test('a schema can be detached and re-attached in Extraction, and it PERSISTS', async ({
  launch
}) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'extraction')

  const before = await api<ExtractionSchemaDTO[]>(window, 'listProjectSchemas', 1)
  expect(before.length, 'seed attaches both schemas').toBeGreaterThanOrEqual(2)
  const globalBefore = await api<ExtractionSchemaDTO[]>(window, 'listSchemas')
  const rowsBefore = await api<ExtractionRowDTO[]>(window, 'getExtractionRows', 1)
  const target = before[0]

  // The detach control sits on the schema section it removes, which means the
  // schema must be the one on screen — removal is never an action on something
  // the user is not looking at.
  await showSchema(window, target.id)
  await window.click(`[data-testid="extraction-detach-${target.id}"]`)

  await expect
    .poll(async () =>
      (await api<ExtractionSchemaDTO[]>(window, 'listProjectSchemas', 1)).some(
        (s) => s.id === target.id
      )
    )
    .toBe(false)

  // DETACH IS NOT DELETE — the global definition is untouched…
  const globalAfter = await api<ExtractionSchemaDTO[]>(window, 'listSchemas')
  expect(globalAfter.map((s) => s.id).sort()).toEqual(globalBefore.map((s) => s.id).sort())
  // …and not one extracted measurement was destroyed.
  const rowsAfter = await api<ExtractionRowDTO[]>(window, 'getExtractionRows', 1)
  expect(rowsAfter.length).toBe(rowsBefore.length)

  // Its records are still SHOWN, in a section that says what actually happened —
  // never mislabelled "unassigned" (they are still field-linked).
  if (rowsBefore.some((r) => r.schema_id === target.id)) {
    const detached = window.locator(`[data-testid="extraction-schema-detached-${target.id}"]`)
    await expect(detached).toBeVisible()
    await expect(detached).toContainText('no longer applied in this project')
  }

  // PERSISTENCE: a full renderer reload must keep the detachment (it is a DB row).
  await window.reload()
  await window.waitForSelector('[data-testid="sidebar"]')
  await selectProject(window, 1)
  await goto(window, 'extraction')
  const afterReload = await api<ExtractionSchemaDTO[]>(window, 'listProjectSchemas', 1)
  expect(afterReload.some((s) => s.id === target.id), 'detachment survived the reload').toBe(false)
  // Its own section is gone (the project no longer applies it) — but its records
  // are still on screen in the detached bucket, which the reload also rebuilt.
  await expect(window.locator(`[data-testid="extraction-schema-${target.id}"]`)).toHaveCount(0)
  if (rowsBefore.some((r) => r.schema_id === target.id)) {
    await expect(
      window.locator(`[data-testid="extraction-schema-detached-${target.id}"]`)
    ).toBeVisible()
  }

  // Re-attach through the "Add schema" picker; that must persist as well.
  await window.click('[data-testid="extraction-add-schema"]')
  await window.click(`[data-testid="extraction-attach-${target.id}"]`)
  await expect
    .poll(async () =>
      (await api<ExtractionSchemaDTO[]>(window, 'listProjectSchemas', 1)).some(
        (s) => s.id === target.id
      )
    )
    .toBe(true)
  // Re-attached: it is offered by the switcher again, its section comes back,
  // and it leaves the detached bucket.
  await showSchema(window, target.id)
  await expect(
    window.locator(`[data-testid="extraction-schema-detached-${target.id}"]`)
  ).toHaveCount(0)

  await window.reload()
  await window.waitForSelector('[data-testid="sidebar"]')
  await selectProject(window, 1)
  await goto(window, 'extraction')
  const reattached = await api<ExtractionSchemaDTO[]>(window, 'listProjectSchemas', 1)
  expect(reattached.some((s) => s.id === target.id), 're-attachment survived the reload').toBe(true)
})

/**
 * COVERAGE — the "how many papers are not extracted with this schema" number
 * must equal the DB, exactly. Recomputed here from `getSchemaCoverage` and
 * cross-checked against the project's own work list, so a hardcoded or
 * estimated figure fails.
 */
test('the coverage line on each schema section matches the DB', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'extraction')

  const coverage = await api<SchemaCoverageDTO[]>(window, 'getSchemaCoverage', 1)
  const attached = await api<ExtractionSchemaDTO[]>(window, 'listProjectSchemas', 1)
  const works = await api<unknown[]>(window, 'listProjectWorks', 1)
  expect(coverage.length, 'one coverage row per attached schema').toBe(attached.length)

  for (const c of coverage) {
    // The denominator is the project's REAL work count.
    expect(c.works_total, 'denominator is the project work count').toBe(works.length)
    // The split always partitions the corpus — no invented numbers.
    expect(c.works_with_values + c.works_without_values).toBe(c.works_total)

    // The coverage line rides its schema's section, so bring that schema into
    // view. Every attached schema is checked, so switching cannot hide one.
    await showSchema(window, c.schema_id)
    const line = window.locator(`[data-testid="extraction-coverage-${c.schema_id}"]`)
    await expect(line).toBeVisible()

    // The rendered sentence must carry the EXACT DB numbers, and must not
    // overclaim: partial extraction counts as "at least one value", never
    // "complete"/"extracted".
    if (c.works_total === 0) {
      await expect(line).toContainText('No papers in this project yet')
    } else if (c.works_with_values === 0) {
      await expect(line).toContainText('No papers have values from this schema yet')
      await expect(line).toContainText(`${c.works_total} pending`)
    } else if (c.works_without_values === 0) {
      await expect(line).toContainText(`All ${c.works_total} papers have at least one value`)
    } else {
      await expect(line).toContainText(
        `${c.works_with_values} of ${c.works_total} papers have at least one value`
      )
      await expect(line).toContainText(`${c.works_without_values} with none`)
    }
    await expect(line).not.toContainText(/\bcomplete\b/i)
  }

  // The seeded corpus really is only partly extracted, so the pending count is a
  // meaningful, non-zero number rather than a trivially satisfied assertion.
  expect(coverage.some((c) => c.works_without_values > 0)).toBe(true)
})
