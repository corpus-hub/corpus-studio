import { test, expect, goto, api, selectProject, chooseOption } from './helpers/electron'
import type { Page } from '@playwright/test'
import type { RankingRowDTO } from '../src/shared/contract'

test('relevance and expansion are separate columns with differing values', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'ranking')

  await expect(window.locator('[data-testid^="ranking-row-"]').first()).toBeVisible()

  const rows = await api<RankingRowDTO[]>(window, 'getRanking', 1, 'relevance')
  expect(rows.length).toBeGreaterThan(0)

  // At least one row where relevance != expansion_priority (distinct axes).
  const differing = rows.find(
    (r) => r.relevance !== null && r.expansion_priority !== null && r.relevance !== r.expansion_priority
  )
  expect(differing, 'a row with distinct relevance vs expansion').toBeTruthy()

  const rel = await window.locator(`[data-testid="relevance-${differing!.work_id}"]`).innerText()
  const exp = await window.locator(`[data-testid="expansion-${differing!.work_id}"]`).innerText()
  // The cell renders the design's "REL {n}" / "EXP {n}" label (0–10 scale) plus
  // an inline "edit" override button. Pull the numeric score out of each and
  // assert the two rendered values differ, mirroring the DTO's distinct axes.
  const relNum = rel.replace(/[^0-9]/g, '')
  const expNum = exp.replace(/[^0-9]/g, '')
  expect(relNum.length).toBeGreaterThan(0)
  expect(expNum.length).toBeGreaterThan(0)
  expect(relNum).not.toBe(expNum)
  // The rendered numbers are the RANKS, not the raw scores. The scores are
  // ordinal sigmoids with a median near 0.0004 on a real corpus, so `raw * 10`
  // rounded almost every row to "0" and the screen now draws each paper's
  // position among the papers scored beside it. The raw values still order the
  // list; they are simply not what is printed.
  expect(relNum).toBe(String(Math.round(differing!.relevance_rank! * 10)))
  expect(expNum).toBe(String(Math.round(differing!.expansion_rank! * 10)))
})

test('sort control changes row order', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'ranking')
  await expect(window.locator('[data-testid^="ranking-row-"]').first()).toBeVisible()

  const orderOf = async (): Promise<string[]> =>
    window.$$eval('[data-testid^="ranking-row-"]', (els) =>
      els.map((e) => e.getAttribute('data-testid') || '')
    )

  const byRelevance = await orderOf()
  await chooseOption(window, 'ranking-sort', 'expansion')
  await expect
    .poll(async () => (await orderOf()).join(','), { timeout: 10_000 })
    .not.toBe(byRelevance.join(','))
})

test('excluding a work persists across reload', async ({ launch }) => {
  const { window, app } = await launch()
  await selectProject(window, 1)
  await goto(window, 'ranking')

  const rows = await api<RankingRowDTO[]>(window, 'getRanking', 1, 'relevance')
  const target = rows.find((r) => r.inclusion_status !== 'excluded')!
  expect(target).toBeTruthy()

  // Exclusion opens an in-app confirm modal; confirm it.
  await chooseOption(window, `inclusion-select-${target.work_id}`, 'excluded')
  await window.click('[data-testid="exclude-confirm"]')

  await expect
    .poll(async () => {
      const r = await api<RankingRowDTO[]>(window, 'getRanking', 1, 'relevance')
      return r.find((x) => x.work_id === target.work_id)?.inclusion_status
    }, { timeout: 10_000 })
    .toBe('excluded')

  const win2 = await app.firstWindow()
  await win2.reload()
  await win2.waitForSelector('[data-testid="sidebar"]')
  const after = await win2.evaluate((wid) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any
    return w.api
      .getRanking(1, 'relevance')
      .then((r: RankingRowDTO[]) => r.find((x) => x.work_id === wid)?.inclusion_status)
  }, target.work_id)
  expect(after).toBe('excluded')
})

// The relevance cell exposes an inline override trigger (button.btn-mini) that
// opens an in-app override modal. We assert that trigger is present, then drive
// the override through its DB-backed API (window.api.overrideScore) so the test
// stays deterministic, and assert the new score renders + persists + shows the
// override badge. Scores render on the design's 0–10 scale (x/10), so 0.7 → "7"
// is an unambiguous rendered value.
test('manual override changes shown score and persists', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'ranking')

  const rows = await api<RankingRowDTO[]>(window, 'getRanking', 1, 'relevance')
  const target = rows[0]

  // The UI override trigger exists inside the relevance cell.
  await expect(
    window.locator(`[data-testid="relevance-${target.work_id}"] button.btn-mini`)
  ).toBeVisible()

  // 0.7 → rendered "REL 7" (7/10), unambiguous; persisted as user_overrides JSON.
  await api(window, 'overrideScore', 1, target.work_id, 'relevance', 0.7, 'e2e override')

  await expect
    .poll(async () => {
      const r = await api<RankingRowDTO[]>(window, 'getRanking', 1, 'relevance')
      return r.find((x) => x.work_id === target.work_id)?.user_overrides
    }, { timeout: 10_000 })
    .toContain('0.7')

  // Reload so the ranking screen re-fetches; the overridden score + badge show.
  await window.reload()
  await window.waitForSelector('[data-testid="sidebar"]')
  await selectProject(window, 1)
  await goto(window, 'ranking')
  // The relevance cell now reflects the override (0.7 → "REL 7") …
  await expect(window.locator(`[data-testid="relevance-${target.work_id}"]`)).toContainText('7')
  // … and the override badge is shown for the row.
  await expect(window.locator(`[data-testid="override-badge-${target.work_id}"]`)).toBeVisible()
})

// ------------------------------------------------------------------ reordering
// The ranked list (when sorted by relevance) is reordered with a POINTER-driven
// drag: pointerdown on the row's drag handle, pointermove to shift the live
// order (the DOM order is frozen and cards are translated with CSS transforms),
// pointerup to commit + persist. The rendered rank (the `data-rank` attribute)
// is therefore the source of truth for the LIVE order, while `data-testid`
// order stays frozen during a drag.

/** DOM order of the rendered rows (frozen while a drag is in flight). */
const domOrder = (window: Page): Promise<number[]> =>
  window.$$eval('[data-testid^="ranking-row-"]', (els) =>
    els.map((e) => Number((e.getAttribute('data-testid') || '').replace('ranking-row-', '')))
  )

/** LIVE order: rows sorted by the rank badge they currently render. */
const liveOrder = (window: Page): Promise<number[]> =>
  window.$$eval('[data-testid^="ranking-row-"]', (els) =>
    els
      .map((e) => ({
        id: Number((e.getAttribute('data-testid') || '').replace('ranking-row-', '')),
        rank: Number(e.getAttribute('data-rank'))
      }))
      .sort((a, b) => a.rank - b.rank)
      .map((x) => x.id)
  )

test('pointer drag reorders the list live and persists across reload', async ({ launch }) => {
  const { window, app } = await launch()
  await selectProject(window, 1)
  await goto(window, 'ranking')
  await expect(window.locator('[data-testid^="ranking-row-"]').first()).toBeVisible()

  const before = await domOrder(window)
  expect(before.length).toBeGreaterThan(2)
  // Drag the THIRD row up above the first.
  const srcId = before[2]
  const dstId = before[0]

  const handle = window.locator(`[data-testid="drag-handle-${srcId}"]`)
  const hb = (await handle.boundingBox())!
  const dst = window.locator(`[data-testid="ranking-row-${dstId}"]`)
  const db = (await dst.boundingBox())!

  await window.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
  await window.mouse.down()
  // Multiple intermediate moves so the pointermove handler sees the travel.
  await window.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 - 10, { steps: 3 })
  await window.mouse.move(hb.x + hb.width / 2, db.y + 4, { steps: 12 })

  // LIVE: the order updates BEFORE the drop — the dragged row already ranks 1st
  // and the chart's dot for it has moved (its relevance preview is the top slot).
  await expect
    .poll(async () => (await liveOrder(window))[0], { timeout: 5_000 })
    .toBe(srcId)
  // The DOM order is deliberately frozen during the drag (transform-only moves).
  expect(await domOrder(window)).toEqual(before)
  // The dragged card is lifted (translated) rather than re-mounted.
  const lifted = await window
    .locator(`[data-testid="ranking-row-${srcId}"]`)
    .evaluate((el) => getComputedStyle(el).transform)
  expect(lifted).not.toBe('none')
  // The frontier dot for the dragged work is live-highlighted during the drag.
  await expect(window.locator(`[data-testid="frontier-node-${srcId}"]`)).toHaveClass(/is-live/)

  await window.mouse.up()

  // After the drop the committed DOM order puts srcId ahead of dstId.
  await expect
    .poll(async () => {
      const o = await domOrder(window)
      return o.indexOf(srcId) < o.indexOf(dstId)
    }, { timeout: 10_000 })
    .toBe(true)

  // Persistence: the DB-backed getRanking (relevance sort) yields the new order.
  await expect
    .poll(async () => {
      const rows = await api<RankingRowDTO[]>(window, 'getRanking', 1, 'relevance')
      const ids = rows.map((r) => r.work_id)
      return ids.indexOf(srcId) < ids.indexOf(dstId)
    }, { timeout: 10_000 })
    .toBe(true)

  // Survives a full reload of the renderer.
  const win2 = await app.firstWindow()
  await win2.reload()
  await win2.waitForSelector('[data-testid="sidebar"]')
  const persisted = await win2.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any
    return w.api.getRanking(1, 'relevance').then((r: RankingRowDTO[]) => r.map((x) => x.work_id))
  })
  expect(persisted.indexOf(srcId)).toBeLessThan(persisted.indexOf(dstId))
})

// The grabbing cursor must hold DOCUMENT-WIDE for the whole gesture (the drag
// is driven by window-level listeners, so the pointer leaves the handle at
// once), and must never get stuck on afterwards — neither after a normal drop
// nor after an Escape-cancel.
test('drag applies a document-wide grabbing cursor and always clears it', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'ranking')
  await expect(window.locator('[data-testid^="ranking-row-"]').first()).toBeVisible()

  const rootDragging = (): Promise<boolean> =>
    window.evaluate(() => document.documentElement.classList.contains('is-dragging-row'))
  /** Computed cursor on an element far from the handle (the chart). */
  const cursorOn = (sel: string): Promise<string> =>
    window.locator(sel).evaluate((el) => getComputedStyle(el).cursor)

  expect(await rootDragging()).toBe(false)

  const ids = await domOrder(window)
  const srcId = ids[2]
  const handle = window.locator(`[data-testid="drag-handle-${srcId}"]`)
  // Resting affordance: the handle offers `grab`.
  expect(await cursorOn(`[data-testid="drag-handle-${srcId}"]`)).toBe('grab')

  const hb = (await handle.boundingBox())!
  const startDrag = async (): Promise<void> => {
    await window.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
    await window.mouse.down()
    await window.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 - 40, { steps: 6 })
  }

  // --- 1. mid-drag: class set, grabbing forced even over the chart + titles.
  await startDrag()
  await expect.poll(rootDragging, { timeout: 5_000 }).toBe(true)
  expect(await cursorOn('[data-testid="frontier-map"]')).toBe('grabbing')
  expect(await cursorOn(`[data-testid="ranking-row-${ids[0]}"] .rank-title`)).toBe('grabbing')
  // The dragged row is visibly lifted: raised stacking + a drop indicator.
  await expect(window.locator('[data-testid="drop-indicator"]')).toBeVisible()
  const lifted = await window
    .locator(`[data-testid="ranking-row-${srcId}"]`)
    .evaluate((el) => getComputedStyle(el).zIndex)
  expect(lifted).toBe('5')

  // --- 2. after the drop it is gone.
  await window.mouse.up()
  await expect.poll(rootDragging, { timeout: 10_000 }).toBe(false)
  await expect(window.locator('[data-testid="drop-indicator"]')).toHaveCount(0)
  expect(await cursorOn('[data-testid="frontier-map"]')).not.toBe('grabbing')

  // --- 3. after an Escape-cancel it is gone too (the stuck-cursor case).
  const hb2 = (await window.locator(`[data-testid="drag-handle-${srcId}"]`).boundingBox())!
  await window.mouse.move(hb2.x + hb2.width / 2, hb2.y + hb2.height / 2)
  await window.mouse.down()
  await window.mouse.move(hb2.x + hb2.width / 2, hb2.y + hb2.height / 2 - 40, { steps: 6 })
  await expect.poll(rootDragging, { timeout: 5_000 }).toBe(true)
  await window.keyboard.press('Escape')
  await expect.poll(rootDragging, { timeout: 5_000 }).toBe(false)
  await window.mouse.up()
  await expect.poll(rootDragging, { timeout: 5_000 }).toBe(false)
  expect(await cursorOn('[data-testid="frontier-map"]')).not.toBe('grabbing')
})

// Disabled reordering must keep its `not-allowed` handle and offer no drag.
test('disabled handles keep not-allowed and start no drag', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'ranking')
  await chooseOption(window, 'ranking-sort', 'expansion')
  const handle = window.locator('[data-testid^="drag-handle-"]').first()
  await expect(handle).toBeDisabled()
  expect(await handle.evaluate((el) => getComputedStyle(el).cursor)).toBe('not-allowed')

  const hb = (await handle.boundingBox())!
  await window.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
  await window.mouse.down()
  await window.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 - 40, { steps: 6 })
  expect(
    await window.evaluate(() => document.documentElement.classList.contains('is-dragging-row'))
  ).toBe(false)
  await window.mouse.up()
})

// Keyboard alternative to dragging (a11y): the drag handle is a real button and
// ArrowUp moves its row one slot up, persisting exactly like a drag.
test('keyboard reorder moves a row and persists', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'ranking')
  await expect(window.locator('[data-testid^="ranking-row-"]').first()).toBeVisible()

  const before = await domOrder(window)
  const srcId = before[1]
  const dstId = before[0]

  await window.focus(`[data-testid="drag-handle-${srcId}"]`)
  await window.keyboard.press('ArrowUp')

  await expect
    .poll(async () => {
      const rows = await api<RankingRowDTO[]>(window, 'getRanking', 1, 'relevance')
      const ids = rows.map((r) => r.work_id)
      return ids.indexOf(srcId) < ids.indexOf(dstId)
    }, { timeout: 10_000 })
    .toBe(true)
})

// Complaint (4): only the ranked-works list scrolls, not the whole page — the
// header and the frontier chart stay put.
test('scrolling is contained in the ranked list, not the page', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'ranking')
  await expect(window.locator('[data-testid="ranked-list"]')).toBeVisible()

  const list = window.locator('[data-testid="ranked-list"]')
  const metrics = await list.evaluate((el) => ({
    overflowY: getComputedStyle(el).overflowY,
    scrollable: el.scrollHeight > el.clientHeight + 4
  }))
  expect(metrics.overflowY).toBe('auto')
  expect(metrics.scrollable).toBe(true)

  // Let the initial layout SETTLE before taking the baseline. Web fonts land a
  // few frames after mount and reflow the screen header by ~5px; measuring
  // across that reflow would be misread as the page having scrolled. Wait for
  // fonts, then for two consecutive identical measurements.
  await window.evaluate(() => document.fonts.ready)
  const chartY = (): Promise<number> =>
    window.locator('[data-testid="frontier-map"]').evaluate((el) => el.getBoundingClientRect().y)
  let last = await chartY()
  await expect
    .poll(
      async () => {
        const now = await chartY()
        const stable = Math.abs(now - last) < 0.5
        last = now
        return stable
      },
      { timeout: 5_000, intervals: [120] }
    )
    .toBe(true)

  // The chart's on-screen position must not move when the list is scrolled.
  const chartBefore = (await window.locator('[data-testid="frontier-map"]').boundingBox())!
  await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await expect.poll(async () => list.evaluate((el) => el.scrollTop > 0)).toBe(true)
  const chartAfter = (await window.locator('[data-testid="frontier-map"]').boundingBox())!
  expect(Math.abs(chartAfter.y - chartBefore.y)).toBeLessThan(2)

  // …and the page scroller itself never moved.
  const pageScroll = await window.locator('[data-testid="route-area"]').evaluate((el) => el.scrollTop)
  expect(pageScroll).toBe(0)
})

// Reordering is only offered on the relevance axis; under any other sort the
// handles are disabled so the two distinct rankings can never be conflated.
test('reorder handles are disabled when not sorted by relevance', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'ranking')
  await expect(window.locator('[data-testid^="drag-handle-"]').first()).toBeEnabled()

  await chooseOption(window, 'ranking-sort', 'expansion')
  await expect(window.locator('[data-testid^="drag-handle-"]').first()).toBeDisabled()
})
