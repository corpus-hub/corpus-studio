import { test, expect, goto, api, selectProject } from './helpers/electron'
import type { PdfReadResult } from '../src/shared/contract'

/**
 * The KE07 corpus seeds REAL PDFs on disk: each document's file_location points
 * (via base_dir + relative_path) at an actual downloaded PDF under the KE07
 * corpus root. So window.api.readPdf() returns real bytes and the ported viewer
 * renders the document. This spec asserts BOTH:
 *   1. a seeded document resolves to real PDF bytes and the viewer mounts, and
 *   2. the graceful "no physical file" degradation path is still intact for a
 *      document id that does not resolve to any file (the ported viewer must
 *      never crash on a missing file — CLAUDE.md offline/degradation invariant).
 *
 * `readPdf` answers with a DISCRIMINATED result, not bytes-or-null: an absence
 * carries the `reason` it happened for, because "this paper has no PDF" and
 * "the drive holding it is not connected" are different facts and one null said
 * both. So the failure assertion is on `ok` and on the reason, never on null.
 */
test('a seeded document opens as a real PDF in the viewer', async ({ launch }) => {
  const { window } = await launch()

  // readPdf for a seeded fulltext document (doc 1, work 1 = Rothlisberger 2008)
  // resolves to real bytes on disk (a PDF starts with the "%PDF" magic).
  const read = await api<PdfReadResult>(window, 'readPdf', 1)
  expect(read.ok, 'seeded doc 1 must resolve to real PDF bytes').toBe(true)
  if (!read.ok) throw new Error(`seeded doc 1 unreadable: ${read.reason}`)
  const head = Array.from(read.bytes.slice(0, 4))
  expect(head, 'bytes begin with the %PDF magic number').toEqual([37, 80, 68, 70])

  // Open work 1 and assert the viewer mounts (not the nofile fallback).
  await selectProject(window, 1)
  await goto(window, 'ranking')
  await window.locator('[data-testid="ranking-row-1"] .rank-title').click()
  await window.waitForSelector('[data-testid="screen-paper"]')
  await expect(window.locator('[data-testid="paper-pdf-panel"]')).toBeVisible()
  await expect(window.locator('[data-testid="pdf-viewer"]')).toBeVisible({ timeout: 15_000 })
  // The nofile fallback must NOT be shown for a document backed by real bytes.
  await expect(window.locator('[data-testid="pdf-nofile"]')).toHaveCount(0)
})

test('readPdf reports WHY, not just that there are no bytes', async ({ launch }) => {
  const { window } = await launch()

  // A document id with no row at all: the corpus holds no file for it, which is
  // `none` — the one reason that licenses "this paper has no PDF". A resolution
  // failure must never be reported as this, so the reason is asserted exactly.
  const missing = await api<PdfReadResult>(window, 'readPdf', 999999)
  expect(missing.ok, 'unresolved document id answers, it does not crash').toBe(false)
  if (missing.ok) throw new Error('unresolved document id returned bytes')
  expect(missing.reason, 'no file_location is an absent document, not a broken one').toBe('none')
  expect(missing.sentence.length, 'the absence carries a sentence the UI can show').toBeGreaterThan(0)
})

test('evidence highlights render and align over the PDF text layer', async ({ launch }) => {
  const { window } = await launch()

  // Work 2 has a CURRENT extraction run carrying evidence quotes; opening it
  // must anchor those quotes as highlight boxes over the real PDF text layer
  // (PaperScreen defaults the selected run to a current one WITH evidence).
  await selectProject(window, 1)
  await goto(window, 'ranking')
  await window.locator('[data-testid="ranking-row-2"] .rank-title').click()
  await window.waitForSelector('[data-testid="screen-paper"]')
  await window.waitForSelector('[data-testid="pdf-viewer"]', { timeout: 20_000 })

  // The draw loop runs after the text layer is ready; poll for a highlight box.
  await window.waitForFunction(() => document.querySelectorAll('.pdf-hl').length > 0, null, {
    timeout: 20_000
  })

  // Assert the highlight is positioned (non-zero box) AND overlaps at least one
  // real text-layer span — i.e. it aligns to text, not floating in empty space.
  const aligned = await window.evaluate(() => {
    const hl = document.querySelector('.pdf-hl') as HTMLElement | null
    if (!hl) return { ok: false, w: 0, h: 0, overlaps: 0 }
    const hr = hl.getBoundingClientRect()
    if (hr.width < 4 || hr.height < 4) return { ok: false, w: hr.width, h: hr.height, overlaps: 0 }
    const spans = [...document.querySelectorAll('.pdf-text-layer span')] as HTMLElement[]
    let overlaps = 0
    for (const s of spans) {
      const sr = s.getBoundingClientRect()
      const ox = Math.min(hr.right, sr.right) - Math.max(hr.left, sr.left)
      const oy = Math.min(hr.bottom, sr.bottom) - Math.max(hr.top, sr.top)
      if (ox > 2 && oy > 2) overlaps++
    }
    return { ok: overlaps > 0, w: hr.width, h: hr.height, overlaps }
  })
  expect(aligned.w, 'highlight box has a real width').toBeGreaterThan(4)
  expect(aligned.h, 'highlight box has a real height').toBeGreaterThan(4)
  expect(aligned.overlaps, 'highlight overlaps a real text-layer span').toBeGreaterThan(0)
})

/**
 * The ai-detector evidence-linking workflow, both directions. A claim card whose
 * evidence anchored in the PDF is clickable; clicking it focuses (and scrolls
 * to) that evidence span's band, and clicking the band in the PDF activates the
 * matching claim card back in the analysis column.
 */
test('clicking a claim focuses + scrolls to its evidence span in the PDF', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'ranking')
  await window.locator('[data-testid="ranking-row-2"] .rank-title').click()
  await window.waitForSelector('[data-testid="screen-paper"]')
  await window.waitForSelector('[data-testid="pdf-viewer"]', { timeout: 20_000 })
  // Pages publish their text layer PROGRESSIVELY, so a highlight can exist while
  // later pages are still rendering — and until the last one lands, PaperScreen
  // has no authoritative anchored set and optimistically shows every claim as
  // traceable. Waiting for the viewer to declare itself fully rendered is what
  // makes the anchored/un-anchored assertions below read a settled state
  // instead of that transient one.
  await window.waitForSelector('[data-testid="pdf-viewer"][data-pdf-rendered="yes"]', {
    timeout: 30_000
  })
  await window.waitForFunction(() => document.querySelectorAll('.pdf-hl').length > 0, null, {
    timeout: 20_000
  })

  // Only facts whose evidence ACTUALLY anchored are traceable; the viewer
  // reports the anchored set, so wait for at least one to be marked so.
  const card = window.locator('.pv-claim[data-anchored="yes"]').first()
  await expect(card).toBeVisible({ timeout: 20_000 })
  const aid = await card.getAttribute('data-aid')
  expect(aid, 'a traceable claim exposes its evidence-span id').toBeTruthy()

  await card.click()

  // The claim becomes active AND its band(s) in the PDF gain `.is-focused`.
  await expect(card).toHaveClass(/pv-claim-active/)
  await window.waitForFunction(
    (id) => document.querySelectorAll(`.pdf-hl.is-focused[data-ann-ids~="${id}"]`).length > 0,
    aid,
    { timeout: 10_000 }
  )

  // The focused band is scrolled into the PDF pane's viewport (not off-screen).
  await window.waitForFunction(
    () => {
      const scroller = document.querySelector('.pdf-scroll') as HTMLElement | null
      if (!scroller) return false
      const sr = scroller.getBoundingClientRect()
      return [...document.querySelectorAll('.pdf-hl.is-focused')].some((b) => {
        const r = b.getBoundingClientRect()
        return r.width > 2 && r.bottom > sr.top && r.top < sr.bottom
      })
    },
    null,
    { timeout: 10_000 }
  )
})

test('clicking a highlighted span in the PDF activates its claim card', async ({ launch }) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'ranking')
  await window.locator('[data-testid="ranking-row-2"] .rank-title').click()
  await window.waitForSelector('[data-testid="screen-paper"]')
  await window.waitForSelector('[data-testid="pdf-viewer"]', { timeout: 20_000 })
  // Pages publish their text layer PROGRESSIVELY, so a highlight can exist while
  // later pages are still rendering — and until the last one lands, PaperScreen
  // has no authoritative anchored set and optimistically shows every claim as
  // traceable. Waiting for the viewer to declare itself fully rendered is what
  // makes the anchored/un-anchored assertions below read a settled state
  // instead of that transient one.
  await window.waitForSelector('[data-testid="pdf-viewer"][data-pdf-rendered="yes"]', {
    timeout: 30_000
  })
  await window.waitForFunction(() => document.querySelectorAll('.pdf-hl').length > 0, null, {
    timeout: 20_000
  })
  await expect(window.locator('.pv-claim[data-anchored="yes"]').first()).toBeVisible({
    timeout: 20_000
  })

  // Nothing is active to begin with.
  await expect(window.locator('.pv-claim-active')).toHaveCount(0)

  // Click the centre of a highlight band (the viewer hit-tests boxes against
  // the click point, so dispatch at real page coordinates).
  const bandIds = await window.evaluate(() => {
    const band = document.querySelector('.pdf-hl') as HTMLElement | null
    if (!band) return null
    const r = band.getBoundingClientRect()
    document.querySelector('.pdf-scroll')!.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2
      })
    )
    return (band.dataset.annIds ?? band.dataset.annId ?? '').split(' ').filter(Boolean)
  })
  expect(bandIds, 'the band carries at least one evidence-span id').toBeTruthy()
  expect(bandIds!.length).toBeGreaterThan(0)

  // The claim card owning that span becomes the active one.
  const active = window.locator('.pv-claim-active')
  await expect(active).toHaveCount(1, { timeout: 10_000 })
  await expect(active).toHaveAttribute('data-aid', new RegExp(`^(${bandIds!.join('|')})$`))
})

test('facts whose evidence could not be anchored are marked, not silently dead', async ({
  launch
}) => {
  const { window } = await launch()
  await selectProject(window, 1)
  await goto(window, 'ranking')
  await window.locator('[data-testid="ranking-row-2"] .rank-title').click()
  await window.waitForSelector('[data-testid="screen-paper"]')
  await window.waitForSelector('[data-testid="pdf-viewer"]', { timeout: 20_000 })
  // Pages publish their text layer PROGRESSIVELY, so a highlight can exist while
  // later pages are still rendering — and until the last one lands, PaperScreen
  // has no authoritative anchored set and optimistically shows every claim as
  // traceable. Waiting for the viewer to declare itself fully rendered is what
  // makes the anchored/un-anchored assertions below read a settled state
  // instead of that transient one.
  await window.waitForSelector('[data-testid="pdf-viewer"][data-pdf-rendered="yes"]', {
    timeout: 30_000
  })
  await window.waitForFunction(() => document.querySelectorAll('.pdf-hl').length > 0, null, {
    timeout: 20_000
  })
  await expect(window.locator('.pv-claim[data-anchored="yes"]').first()).toBeVisible({
    timeout: 20_000
  })

  // Every claim declares its anchored state, and the un-anchored ones are
  // rendered inert with a visible marker rather than a dead "evidence →" link.
  const claims = window.locator('.pv-claim')
  expect(await claims.count()).toBeGreaterThan(0)
  for (const c of await claims.all()) {
    const anchored = await c.getAttribute('data-anchored')
    expect(['yes', 'no']).toContain(anchored)
    if (anchored === 'yes') {
      await expect(c).toHaveAttribute('role', 'button')
      await expect(c.locator('.pv-claim-trace')).toHaveCount(1)
    } else {
      await expect(c).toHaveClass(/pv-claim-inert/)
      await expect(c.locator('.pv-claim-unanchored')).toHaveCount(1)
      await expect(c.locator('.pv-claim-trace')).toHaveCount(0)
    }
  }
  // The seeded corpus exercises BOTH states on this work. A retrying matcher,
  // not a one-shot `count()`: the anchored set settles asynchronously, and a
  // bare count read a frame early would report 0 and fail for timing reasons
  // rather than because the app got the state wrong.
  await expect(window.locator('.pv-claim[data-anchored="no"]')).not.toHaveCount(0)
})
