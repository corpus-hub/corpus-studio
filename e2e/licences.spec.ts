import { test, expect } from './helpers/electron'

/**
 * THIRD-PARTY ATTRIBUTION is a licence obligation, not a feature: this app
 * bundles five Apache-2.0 payloads (qpdf, eng.traineddata, arctic-embed-s,
 * ms-marco-MiniLM-L-6-v2, sqlite-vec) plus its npm closure, and Apache-2.0 §4
 * requires attribution.
 *
 * These assertions are written so that a REGRESSION FAILS THEM. The failure
 * shapes they exist to catch are the ones that would otherwise ship silently:
 * a bundled payload dropping out of the list, a licence pane rendering blank,
 * or the screen fetching a licence over the network.
 */

async function openLicences(window: import('@playwright/test').Page): Promise<void> {
  await window.click('[data-testid="nav-integrations-settings"]')
  await window.waitForSelector('[data-testid="settings-modal"]')
  // Attribution is a licence obligation rather than a feature, so it sits under
  // About, not on the pane the modal opens on. Select that tab first.
  await window.click('[data-testid="settings-tab-about"]')
  await window.click('[data-testid="settings-open-licences"]')
  await window.waitForSelector('[data-testid="licences-modal"]')
}

test('every bundled payload is attributed with its version and SPDX licence', async ({
  launch
}) => {
  const { window } = await launch()
  await openLicences(window)

  // The five shipped binaries/models. Naming them individually means removing
  // one from resources/payloads.json without re-generating fails HERE rather
  // than at a licence audit.
  for (const id of [
    'qpdf',
    'tessdata-eng',
    'embedding-model',
    'reranker-model',
    'sqlite-vec'
  ]) {
    const row = window.locator(`[data-testid="lic-row-payload:${id}"]`)
    await expect(row, `payload ${id} is attributed`).toBeVisible()
    // A version and a licence, not just a name — an attribution without the
    // version does not identify what was actually shipped.
    await expect(row.locator('.lic-version')).not.toBeEmpty()
    await expect(row.locator('.lic-spdx')).toContainText(/Apache-2\.0/)
  }

  // The npm tree is attributed too, and by more than a token handful.
  const all = window.locator('[data-testid^="lic-row-"]')
  expect(await all.count(), 'the whole dependency closure is listed').toBeGreaterThan(50)
})

test('expanding a payload reveals its real licence text, offline', async ({ launch }) => {
  const { window } = await launch()
  // A network request from this screen would be a hard offline violation, so
  // watch for one rather than trusting that none is made.
  const requests: string[] = []
  window.on('request', (r) => {
    if (/^https?:/.test(r.url())) requests.push(r.url())
  })

  await openLicences(window)
  await window.click('[data-testid="lic-toggle-payload:qpdf"]')

  const text = window.locator('[data-testid="lic-text-payload:qpdf"]')
  await expect(text).toBeVisible({ timeout: 10_000 })
  // The ACTUAL Apache-2.0 text, not a placeholder or a licence name.
  const body = await text.innerText()
  expect(body, 'the pane holds the real Apache-2.0 text').toContain('Apache License')
  expect(body).toContain('Version 2.0, January 2004')
  expect(body).toContain('WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND')
  expect(body.length, 'the full text, not a truncated snippet').toBeGreaterThan(5000)

  expect(requests, 'the licences screen fetches nothing').toEqual([])
})

test('a package with no upstream LICENSE file says so rather than showing blank', async ({
  launch
}) => {
  const { window } = await launch()
  await openLicences(window)

  // onnxruntime-node declares MIT in its manifest but ships no LICENSE file.
  // The pane must state that fact: a blank body reads as a broken screen and
  // hides a genuinely missing attribution behind an apparently working one.
  await window.click('[data-testid="lic-toggle-npm:onnxruntime-node"]')
  const note = window.locator('[data-testid="lic-none-npm:onnxruntime-node"]')
  await expect(note).toBeVisible({ timeout: 10_000 })
  await expect(note).toContainText('no LICENSE file')
  await expect(note).toContainText('MIT')
})

test('the filter narrows the list and reports when nothing matches', async ({ launch }) => {
  const { window } = await launch()
  await openLicences(window)

  const all = await window.locator('[data-testid^="lic-row-"]').count()
  await window.fill('[data-testid="lic-filter"]', 'qpdf')
  await expect(window.locator('[data-testid="lic-row-payload:qpdf"]')).toBeVisible()
  const narrowed = await window.locator('[data-testid^="lic-row-"]').count()
  expect(narrowed, 'filtering actually removes rows').toBeLessThan(all)

  // An empty result is stated, never left as a silently blank panel.
  await window.fill('[data-testid="lic-filter"]', 'zzz-no-such-package')
  await expect(window.locator('[data-testid="lic-empty"]')).toBeVisible()
  expect(await window.locator('[data-testid^="lic-row-"]').count()).toBe(0)
})
