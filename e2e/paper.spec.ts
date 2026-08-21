import { test, expect, goto, selectProject } from './helpers/electron'
import type { AnalysisRunDTO, DocumentDTO } from '../src/shared/contract'
import type { CitationContextDTO } from '../src/shared/types'

/**
 * Turn "Show additional provenance" ON.
 *
 * The build stamps are OPT-IN and default to hidden: how much metadata a reader
 * wants beside a claim is a property of the reader, so the block a spec asserts
 * on stays hidden until the switch in Settings is thrown. Thrown through the
 * REAL control rather than by writing the stored preference, so the spec stays
 * honest about how a reader reaches this state.
 */
async function showProvenance(window: import('@playwright/test').Page): Promise<void> {
  await window.click('[data-testid="nav-integrations-settings"]')
  const sw = window.locator('[data-testid="pref-show-provenance"]')
  await expect(sw).toBeVisible()
  if ((await sw.getAttribute('aria-checked')) !== 'true') await sw.click()
  await expect(sw).toHaveAttribute('aria-checked', 'true')
  await window.keyboard.press('Escape')
  await expect(window.locator('[data-testid="settings-modal"]')).toHaveCount(0)
}

/** Open a paper (in project 1) by clicking its ranking row title button. */
async function openPaperFromRanking(window: import('@playwright/test').Page, workId: number): Promise<void> {
  await selectProject(window, 1)
  await goto(window, 'ranking')
  await window.locator(`[data-testid="ranking-row-${workId}"] .rank-title`).click()
  await window.waitForSelector('[data-testid="screen-paper"]', { timeout: 15_000 })
}

test('provenance block shows model/provider/prompt/schema/timestamp', async ({ launch }) => {
  const { window } = await launch()
  await showProvenance(window)
  // Work 2 has a current + a superseded extraction run in the seed.
  await openPaperFromRanking(window, 2)

  await expect(window.locator('[data-testid="run-tabs"]')).toBeVisible()
  const prov = window.locator('[data-testid^="provenance-"]').first()
  await expect(prov).toBeVisible()
  // The build stamps moved behind a "run details" disclosure — they are read
  // once, while the summary line carries what a scientist scans every session.
  // Open it before asserting they are present.
  await prov.locator('.pv-prov-more > summary').click()
  // innerText() reflects CSS text-transform (labels render uppercase), so match
  // case-insensitively. `provider` no longer has its own cell (it duplicated the
  // MODEL cell, which renders `model · provider`), so assert its VALUE instead.
  const text = (await prov.innerText()).toLowerCase()
  for (const label of ['model', 'prompt / schema']) {
    expect(text, `provenance should mention ${label}`).toContain(label)
  }
  // The provenance VALUES, read from the DB rather than written here as a
  // literal. A hardcoded provider name would assert what produced the seeded
  // analyses, which is a property of whichever model processed the corpus and
  // not of the screen under test — and it is exactly how this spec came to
  // require the string 'mock-provider'.
  const run = await window.evaluate(
    () => (window as any).api.getWorkAnalyses(2, 1) as Promise<AnalysisRunDTO[]>
  )
  const current = run.find((r) => r.superseded === 0 && r.analysis_type === 'extraction')!
  expect(current, 'the seeded corpus carries a current extraction run for work 2').toBeTruthy()
  expect(text).toContain(current.model.toLowerCase())
  expect(text).toContain(current.provider.toLowerCase())
  // No analysis may claim to be a mock's. This is the assertion the literal
  // above should always have been.
  expect(current.provider).not.toContain('mock')
  expect(current.model).not.toContain('mock')
})

test('superseded analysis is visually distinct from current', async ({ launch }) => {
  const { window } = await launch()
  await showProvenance(window)
  await openPaperFromRanking(window, 2)

  const analyses = await window.evaluate(
    () => (window as any).api.getWorkAnalyses(2, 1) as Promise<AnalysisRunDTO[]>
  )
  const superseded = analyses.find((r) => r.superseded === 1)
  const current = analyses.find((r) => r.superseded === 0)
  expect(superseded, 'seed has a superseded run for work 2').toBeTruthy()
  expect(current, 'seed has a current run for work 2').toBeTruthy()

  // Selecting the superseded run tab renders the provenance-superseded modifier.
  await window.click(`[data-testid="run-tab-${superseded!.id}"]`)
  const prov = window.locator(`[data-testid="provenance-${superseded!.id}"]`)
  await expect(prov).toHaveClass(/provenance-superseded/)
})

test('each claim carries its own fact kind, with its definition', async ({ launch }) => {
  const { window } = await launch()
  await openPaperFromRanking(window, 2)
  // The kind is stated ON the claim rather than in a standalone legend, so it
  // describes THIS paper's claims instead of the app's taxonomy. Its definition
  // rides along as a tooltip so the label is never bare jargon.
  const kind = window.locator('[data-testid^="fact-"] .pv-claim-kind').first()
  await expect(kind).toBeVisible()
  await expect(kind).toHaveAttribute('data-tip', /.+/)
})

/**
 * A role's ORIGIN is shown, and reports what the DB actually holds.
 *
 * This is load-bearing rather than cosmetic. A regex match and a model's
 * judgement must never read as the same kind of claim, which is the confusion
 * `role_source` exists to prevent. So the spec asserts against the DTO rather
 * than against whichever mark the screen happened to render.
 */
test('citation contexts show every context, grouped and never truncated', async ({ launch }) => {
  const { window } = await launch()
  // Work 2 cites foundational works with citation contexts + raw bib text.
  await openPaperFromRanking(window, 2)
  const section = window.locator('[data-testid="citation-contexts"]')
  await expect(section).toBeVisible({ timeout: 15_000 })

  const contexts = await window.evaluate(
    () => (window as any).api.getCitationContexts(2) as Promise<CitationContextDTO[]>
  )
  expect(contexts.length, 'work 2 has citation contexts').toBeGreaterThan(0)

  // The header states the true totals. This is where a silent cap would show:
  // the count is read from the DTO list, not from what happens to be rendered.
  const groupKeys = new Set(
    contexts.map((c) => (c.target_kind === 'work' ? `e${c.edge_id}` : `u${c.unresolved_reference_id}`))
  )
  await expect(section.locator('[data-testid="cc-total"]')).toContainText(
    `${contexts.length} context`
  )
  await expect(section.locator('[data-testid="cc-total"]')).toContainText(
    `${groupKeys.size} reference`
  )

  // EVERY group is present — nothing is paged away. Groups are collapsed by
  // default (density is solved by collapsing, not by dropping rows), so the
  // heads are what must all be there.
  await expect(
    section.locator('[data-testid$="-toggle"][data-testid^="cc-group-"]'),
    'every cited reference has a group, with none truncated'
  ).toHaveCount(groupKeys.size)

  // Opening one group reveals ALL of its places, again with no cap.
  const firstKey = [...groupKeys][0]
  const firstGroup = contexts.filter(
    (c) => (c.target_kind === 'work' ? `e${c.edge_id}` : `u${c.unresolved_reference_id}`) === firstKey
  )
  await section.locator(`[data-testid="cc-group-${firstKey}-toggle"]`).click()
  for (const c of firstGroup) {
    await expect(
      section.locator(`[data-testid="cc-place-${c.id}"]`),
      `context ${c.id} is rendered`
    ).toHaveCount(1)
  }

  // The printed bibliography line is preserved verbatim and shown.
  const raw = firstGroup.find((c) => c.raw_bib_text)?.raw_bib_text
  expect(raw, 'the corpus preserves the printed bibliography line').toBeTruthy()
  await expect(section.locator(`[data-testid="cc-group-${firstKey}-raw"] .cite-raw`)).toContainText(
    raw!.slice(0, 40)
  )
})

/**
 * `role_source` is why this exists: a regex match and a calibrated model must
 * never be ranked against each other as though they were the same kind of
 * claim, and a context with NO role must not read as one.
 *
 * Asserted against the DTO rather than against whichever card happened to
 * render first, so both provenance shapes stay tested.
 */
test('a role names its source, and an unclassified context reads as unclassified', async ({
  launch
}) => {
  // The DEMO seed ships no roles at all — a role belongs to an inline
  // occurrence, a sentence at an offset in a PDF, which only the
  // citation-contexts stage reading the document can produce. So the two
  // classified render paths are exercised against the `citation-roles` fixture,
  // which classifies contexts the demo seed ALREADY created (no invented work,
  // edge or citation text) in exactly the two shapes the real stage writes.
  const { window } = await launch('render-paths')
  await openPaperFromRanking(window, 2)
  const section = window.locator('[data-testid="citation-contexts"]')
  await expect(section).toBeVisible({ timeout: 15_000 })

  const contexts = await window.evaluate(
    () => (window as any).api.getCitationContexts(2) as Promise<CitationContextDTO[]>
  )
  const byRule = contexts.find((c) => c.role_source === 'rule')
  const byLlm = contexts.find((c) => c.role_source === 'llm')
  expect(byRule, 'the corpus has a rule-derived role').toBeTruthy()
  expect(byLlm, 'and a model-judged one').toBeTruthy()

  const openFor = async (c: CitationContextDTO): Promise<void> => {
    const key = c.target_kind === 'work' ? `e${c.edge_id}` : `u${c.unresolved_reference_id}`
    const toggle = section.locator(`[data-testid="cc-group-${key}-toggle"]`)
    await toggle.scrollIntoViewIfNeeded()
    if ((await section.locator(`[data-testid="cc-place-${c.id}"]`).count()) === 0) {
      await toggle.click()
    }
    await expect(section.locator(`[data-testid="cc-place-${c.id}"]`)).toHaveCount(1)
  }

  // A rule match shows its CUE, so a reader can see why it was labelled.
  await openFor(byRule!)
  const cue = section.locator(`[data-testid="cc-cue-${byRule!.id}"]`)
  await expect(cue, 'a rule-derived role names its source').toBeVisible()
  if (byRule!.role_cue) await expect(cue).toContainText(byRule!.role_cue)
  await expect(cue).not.toContainText('%')

  // A model judgement is marked as such.
  await openFor(byLlm!)
  const llm = section.locator(`[data-testid="cc-llm-${byLlm!.id}"]`)
  await expect(llm, 'a model-judged role names its source').toBeVisible()

  // An unclassified context reads as an ABSENCE, never as the `other` role,
  // which is a positive class meaning a classifier looked and found no fit.
  //
  // Asserted, not guarded by an `if`. The seed deliberately leaves a share of
  // callouts unclassified because the real stage does — on the parsed corpus
  // it is the MAJORITY case — and an `if (none)` here would let that fixture
  // disappear without anything noticing.
  const none = contexts.find((c) => !c.role)
  expect(none, 'the corpus has an unclassified context to render').toBeTruthy()
  await openFor(none!)
  await expect(section.locator(`[data-testid="cc-role-none-${none!.id}"]`)).toHaveText(
    'not classified'
  )
  await expect(section.locator(`[data-testid="cc-place-${none!.id}"]`)).not.toContainText(
    /\bother\b/
  )
})

/**
 * The counterpart to the test above, and the one that guards the rule the mock
 * removal was for: the SHIPPED seed must claim no roles it did not earn.
 *
 * Roles used to be derived from arithmetic on edge ids and stamped
 * `role_source:'rule'` — a fabricated judgement wearing the provenance of a
 * deterministic one. Nothing but an assertion on the demo DB stops that coming
 * back, because a fabricated role renders indistinguishably from a real one.
 */
test('the shipped seed claims no citation role it did not earn', async ({ launch }) => {
  const { window } = await launch()
  await openPaperFromRanking(window, 2)
  const section = window.locator('[data-testid="citation-contexts"]')
  await expect(section).toBeVisible({ timeout: 15_000 })

  const contexts = await window.evaluate(
    () => (window as any).api.getCitationContexts(2) as Promise<CitationContextDTO[]>
  )
  expect(contexts.length, 'the seed does create citation contexts').toBeGreaterThan(0)
  for (const c of contexts) {
    expect(c.role, `context ${c.id} carries a role no stage produced`).toBeNull()
    expect(c.role_source, `context ${c.id} claims a role source`).toBeNull()
    expect(c.role_cue).toBeNull()
  }
  // …and the screen SAYS so rather than rendering an empty slot the reader must
  // interpret. The place-level detail lives inside a collapsed group, so open
  // the one holding the first context before asserting on it.
  const first = contexts[0]
  const key = first.target_kind === 'work' ? `e${first.edge_id}` : `u${first.unresolved_reference_id}`
  await section.locator(`[data-testid="cc-group-${key}-toggle"]`).scrollIntoViewIfNeeded()
  await section.locator(`[data-testid="cc-group-${key}-toggle"]`).click()
  await expect(section.locator(`[data-testid="cc-role-none-${first.id}"]`)).toHaveText(
    'not classified'
  )
})

/**
 * The anchoring invariant, which this repo treats as production-blocking: a card
 * that LOOKS navigable must navigate and draw a band; a card that cannot must be
 * visibly inert and be no kind of button at all. There is no third state.
 */
test('every citation card is either navigable-and-anchoring or visibly inert', async ({
  launch
}) => {
  const { window } = await launch()
  await openPaperFromRanking(window, 2)
  const section = window.locator('[data-testid="citation-contexts"]')
  await expect(section).toBeVisible({ timeout: 15_000 })

  // Open every group so the whole state space of cards is on screen.
  const toggles = section.locator('[data-testid$="-toggle"][data-testid^="cc-group-"]')
  const n = await toggles.count()
  for (let i = 0; i < n; i++) await toggles.nth(i).click()

  const cards = section.locator('[data-testid^="cc-place-"]')
  const total = await cards.count()
  expect(total, 'the paper renders citation cards').toBeGreaterThan(0)

  const shapes = await cards.evaluateAll((els) =>
    els.map((el) => ({
      reach: el.getAttribute('data-reach'),
      tag: el.tagName,
      disabled: el.getAttribute('aria-disabled'),
      tip: el.getAttribute('data-tip') ?? ''
    }))
  )
  for (const s of shapes) {
    expect(['navigable', 'inert', 'checking'], 'no fourth reachability state').toContain(s.reach)
    if (s.reach === 'navigable') {
      expect(s.tag, 'a navigable card is a real button').toBe('BUTTON')
      expect(s.disabled, 'and is not disabled').toBeNull()
    } else {
      expect(s.tag, 'an unreachable card is NOT a button').not.toBe('BUTTON')
      expect(s.disabled, 'and says so to assistive tech').toBe('true')
      expect(s.tip.length, 'and explains why it cannot navigate').toBeGreaterThan(0)
    }
  }

  // Pressing a navigable card must actually draw a band in the document. If it
  // does not, the card is not allowed to remain pressable — the screen drops the
  // selection and the card goes inert, so the two can never disagree.
  const nav = section.locator('[data-testid^="cc-place-"][data-reach="navigable"]').first()
  if (await nav.count()) {
    const id = (await nav.getAttribute('data-testid'))!.replace('cc-place-', '')
    await nav.scrollIntoViewIfNeeded()
    await nav.click()
    await window.waitForTimeout(600)
    const band = window.locator(`.pdf-hl[data-ann-ids~="cc-${id}"], .pdf-hl[data-ann-id="cc-${id}"]`)
    const stillNavigable =
      (await section.locator(`[data-testid="cc-place-${id}"][data-reach="navigable"]`).count()) > 0
    if (stillNavigable) {
      expect(
        await band.count(),
        'a card still offering to navigate has drawn a band in the document'
      ).toBeGreaterThan(0)
    } else {
      await expect(
        section.locator(`[data-testid="cc-place-${id}"]`),
        'a card the viewer refused goes inert rather than staying pressable'
      ).toHaveAttribute('data-reach', 'inert')
    }
  }
})

/**
 * Contexts whose reference resolved to nothing are FIRST CLASS (§3): they are
 * shown, they keep their printed line, they are marked as not being in the
 * corpus, and they reuse the ONE "Resolve & Import" affordance.
 */
test('unresolved citation targets are distinguishable and reuse Resolve & Import', async ({
  launch
}) => {
  const { window } = await launch()
  await openPaperFromRanking(window, 2)
  const section = window.locator('[data-testid="citation-contexts"]')
  await expect(section).toBeVisible({ timeout: 15_000 })

  const contexts = await window.evaluate(
    () => (window as any).api.getCitationContexts(2) as Promise<CitationContextDTO[]>
  )
  // Every context declares which side of the resolve split it is on, and the UI
  // must key off that rather than off "is some id null".
  for (const c of contexts) {
    expect(['work', 'unresolved'], 'target_kind is computed, never guessed').toContain(
      c.target_kind
    )
  }

  const resolved = contexts.find((c) => c.target_kind === 'work')
  if (resolved) {
    const key = `e${resolved.edge_id}`
    await expect(section.locator(`[data-testid="cc-group-${key}"]`)).toHaveClass(/cc-group-in/)
    await expect(section.locator(`[data-testid="cc-group-${key}-toggle"]`)).toContainText(
      'in corpus'
    )
  }

  // The unresolved arm has no fixture in the seeded DB: `unresolved_reference`
  // rows are produced by the reference parser reading the real PDFs
  // (`npm run parse:citations`), which the e2e fixture does not run, and the
  // seed deliberately writes none rather than literals the parser would delete.
  // Skipping LOUDLY beats an `if (unresolved)` that quietly never runs and lets
  // the spec keep its name while testing nothing it is named for.
  const unresolved = contexts.find((c) => c.target_kind === 'unresolved')
  test.skip(
    unresolved === undefined,
    'the seeded corpus has no unresolved references (they come from `npm run parse:citations` against the real PDFs), so this arm has no fixture here'
  )
  const key = `u${unresolved!.unresolved_reference_id}`
  await expect(section.locator(`[data-testid="cc-group-${key}"]`)).toHaveClass(/cc-group-out/)
  await expect(section.locator(`[data-testid="cc-group-${key}-toggle"]`)).toContainText(
    'not in corpus'
  )
  await section.locator(`[data-testid="cc-group-${key}-toggle"]`).click()
  // The SAME control the unresolved-references list offers, not a second one.
  await expect(section.locator(`[data-testid="cc-group-${key}-retrieve"]`)).toHaveClass(
    /pv-ref-retrieve/
  )
})

test('global-scoped analysis is labelled distinctly from project analyses', async ({ launch }) => {
  // `project_id = 0` is the GLOBAL sentinel: an analysis about the paper itself,
  // made with no project context. No stage emits one today (every stage is
  // document-, project- or corpus-scoped), so the demo corpus has none and the
  // branch is exercised against the `render-paths` fixture. The branch is not
  // dead code to delete: the sentinel is why project_id is 0 rather than NULL,
  // and presenting a context-free result as a project-informed one would
  // misrepresent what was asked of the model.
  const { window } = await launch('render-paths')
  await showProvenance(window)
  await openPaperFromRanking(window, 1)
  const analyses = await window.evaluate(
    () => (window as any).api.getWorkAnalyses(1, 1) as Promise<AnalysisRunDTO[]>
  )
  const globalRun = analyses.find((r) => r.project_id === 0)
  const projectRun = analyses.find((r) => r.project_id === 1)
  expect(globalRun, 'the fixture supplies a global (project 0) run').toBeTruthy()
  expect(projectRun, 'and a project run to contrast it against').toBeTruthy()

  await window.click(`[data-testid="run-tab-${globalRun!.id}"]`)
  const prov = window.locator(`[data-testid="provenance-${globalRun!.id}"]`)
  await expect(prov).toBeVisible()
  await expect(prov).toContainText(/global/i)
  // DISTINCTLY: the two scopes must not render the same. A label that appears on
  // both proves nothing about the distinction the test is named for.
  await expect(prov).toHaveAttribute('data-scope', 'global')

  await window.click(`[data-testid="run-tab-${projectRun!.id}"]`)
  const projProv = window.locator(`[data-testid="provenance-${projectRun!.id}"]`)
  await expect(projProv).toBeVisible()
  await expect(projProv).toHaveAttribute('data-scope', 'project')
  await expect(projProv, 'a project run is never labelled global').not.toContainText(/\bglobal\b/i)
})

/**
 * Regression: the paper screen must NEVER create a page-level scrollbar. A
 * scrollbar that appeared/disappeared on `.route-area` while the user scrolled
 * the PDF shifted the whole layout mid-scroll. Both columns scroll internally,
 * so the route area's scroll height must stay equal to its client height at
 * every PDF scroll depth.
 */
test('paper screen never gains a page-level scrollbar while scrolling the PDF', async ({
  launch
}) => {
  const { window } = await launch()
  await openPaperFromRanking(window, 2)
  await window.waitForSelector('[data-testid="pdf-viewer"]', { timeout: 20_000 })

  for (const y of [0, 900, 2600, 5200, 12000]) {
    await window.evaluate((top) => {
      const s = document.querySelector('.pdf-scroll') as HTMLElement | null
      if (s) s.scrollTop = top
    }, y)
    // let any late layout / scrollbar change settle
    await window.waitForTimeout(200)
    const probe = await window.evaluate(() => {
      const ra = document.querySelector('.route-area') as HTMLElement
      return {
        overflowY: getComputedStyle(ra).overflowY,
        scrollH: ra.scrollHeight,
        clientH: ra.clientHeight,
        docOverflows: document.documentElement.scrollHeight > window.innerHeight + 1
      }
    })
    expect(probe.overflowY, `route-area clamped at scrollTop ${y}`).toBe('hidden')
    expect(
      probe.scrollH,
      `route-area must not overflow at pdf scrollTop ${y} (${probe.scrollH} vs ${probe.clientH})`
    ).toBeLessThanOrEqual(probe.clientH + 1)
    expect(probe.docOverflows, `document must not scroll at pdf scrollTop ${y}`).toBe(false)
  }

  // Both columns are independently scrollable and full height.
  const cols = await window.evaluate(() => {
    const pdf = document.querySelector('.pdf-scroll') as HTMLElement
    const an = document.querySelector('[data-testid="paper-analysis"]') as HTMLElement
    return {
      pdfScrollable: pdf.scrollHeight > pdf.clientHeight,
      pdfH: pdf.clientHeight,
      anH: an.clientHeight,
      anOverflow: getComputedStyle(an).overflowY
    }
  })
  expect(cols.pdfScrollable, 'the PDF pane scrolls internally').toBe(true)
  expect(cols.anOverflow, 'the analysis column scrolls internally').toBe('auto')
  expect(cols.pdfH, 'the PDF pane is full height').toBeGreaterThan(300)
  expect(cols.anH, 'the analysis column is full height').toBeGreaterThan(300)
})

/**
 * The bug this family guards: the `paper` route can be built with no `workId`,
 * PaperScreen would call `window.api.getWork(undefined)`, the main-process zod
 * handler would reject it and the renderer would show "Something went wrong".
 * `paper` is no longer a sidebar destination, so the guard's precondition must
 * now be UNREACHABLE — and that is what this asserts, from every entry point.
 *
 * (This test previously navigated via `goto(window, 'paper')`, i.e. a click on
 * `[data-testid="nav-paper"]`. That testid has not existed since the sidebar
 * item was removed, and `cold-nav.spec.ts` asserts it never comes back — so the
 * test could only ever time out on a selector that is guaranteed absent. It
 * never exercised the Paper screen at all.)
 */
test('every entry point lands on a LOADED paper, never the no-selection guard', async ({
  launch
}) => {
  const { window } = await launch()
  await selectProject(window, 1)

  const landsOnAPaper = async (where: string): Promise<void> => {
    await expect(window.locator('[data-testid="screen-paper"]')).toBeVisible({ timeout: 15_000 })
    // A real paper, not the guiding empty state and not a crash surface.
    await expect(
      window.locator('[data-testid="paper-no-selection"]'),
      `${where} must supply a work id`
    ).toHaveCount(0)
    await expect(window.locator('[data-testid="error-state"]'), `${where} must not error`).toHaveCount(
      0
    )
    await expect(
      window.locator('[data-testid="app-error-boundary"]'),
      `${where} must not crash`
    ).toHaveCount(0)
    // The screen is genuinely populated: its analysis column carries the run
    // tabs, which only exist for a work that resolved.
    await expect(window.locator('[data-testid="run-tabs"]')).toBeVisible({ timeout: 15_000 })
  }

  await goto(window, 'ranking')
  await window.locator('[data-testid^="ranking-row-"]').first().locator('.rank-title').click()
  await landsOnAPaper('ranking')

  await goto(window, 'ingest')
  await window.locator('[data-testid^="search-open-"]').first().click()
  await landsOnAPaper('papers list')

  await goto(window, 'graph')
  await window.locator('[data-testid^="graph-paper-"]').first().click()
  await window.locator('[data-testid="graph-node-detail"] .cg-btn-open').click()
  await landsOnAPaper('connectome inspector')

  // And the screen fills its fixed-height layout rather than collapsing — the
  // property the old empty-state assertion was reaching for, checked on the
  // state a user can actually get to.
  const analysis = window.locator('[data-testid="paper-analysis"]')
  const box = await analysis.boundingBox()
  expect(box, 'the analysis column has a real box').toBeTruthy()
  expect(box!.height, 'the analysis column is not collapsed').toBeGreaterThan(300)
})

test('an abstract-only content-status badge exists in the corpus', async ({ launch }) => {
  const { window } = await launch()
  // Work 4's preferred document is abstract-only in the seed.
  await openPaperFromRanking(window, 4)
  const docs = await window.evaluate(
    () => (window as any).api.getWorkDocuments(4) as Promise<DocumentDTO[]>
  )
  const abs = docs.find((d) => d.content_status === 'abstract-only')
  expect(abs, 'work 4 has an abstract-only document').toBeTruthy()
  // The badge rides the evidence-basis line beside the work type. That is the
  // one that carries the guarantee — an abstract-only analysis must never read
  // as full-text-backed — so it is what this asserts.
  await expect(window.locator('[data-testid="paper-content-basis"]')).toContainText(/abstract/i)
})
