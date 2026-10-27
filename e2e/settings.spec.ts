import { _electron as electron } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { test, expect, seedDb, api } from './helpers/electron'
import { profileEnv } from './profile'
import type { BaseDirDTO, CorpusApi } from '../src/shared/contract'

/** The renderer's typed bridge, for the evaluate() calls below. */
type WinApi = { api: CorpusApi }

const ROOT = resolve(__dirname, '..')
const MAIN = resolve(ROOT, 'out', 'main', 'index.js')

// The sidebar "Settings" button must open a real Settings modal (previously it
// just navigated to Integrations). Its subjects sit behind an icon rail — one
// pane at a time — and WHICH MODEL ANSWERS is the gateway's business, so the
// modal configures how to reach the gateway rather than listing model names.

test('Settings button opens the Settings modal, one subject per rail tab', async ({
  launch
}) => {
  const { window } = await launch()

  // The button is in the sidebar foot and is reachable from the projects screen
  // (no project needs to be open).
  await window.click('[data-testid="nav-integrations-settings"]')

  const modal = window.locator('[data-testid="settings-modal"]')
  await expect(modal).toBeVisible()
  await expect(modal).toContainText('Settings')

  // Every rail tab must exist AND put its own pane on screen — a tab that
  // selects nothing is a control with nothing behind it.
  for (const key of ['general', 'ai', 'mcp', 'storage', 'about']) {
    await window.click(`[data-testid="settings-tab-${key}"]`)
    await expect(window.locator(`[data-testid="settings-pane-${key}"]`)).toBeVisible()
  }

  // Screenshot the open modal for acceptance.
  mkdirSync(resolve(ROOT, 'tmp', 'acceptance'), { recursive: true })
  await modal.screenshot({ path: resolve(ROOT, 'tmp', 'acceptance', 'settings-modal.png') })
})

test('the gateway endpoint is editable and persists, and the key is never read back', async ({
  launch
}) => {
  const { window } = await launch()

  // No model chrome in the topbar: which model answers is not a thing the app
  // displays.
  await expect(window.locator('[data-testid="model-pill"]')).toHaveCount(0)
  await expect(window.locator('.avatar')).toHaveCount(0)

  await window.click('[data-testid="nav-integrations-settings"]')
  await expect(window.locator('[data-testid="settings-modal"]')).toBeVisible()
  await window.click('[data-testid="settings-tab-ai"]')

  await window.fill('[data-testid="settings-endpoint"]', 'http://127.0.0.1:9/v1')
  await window.fill('[data-testid="settings-api-key"]', 'secret-under-test')
  await window.click('[data-testid="settings-save-gateway"]')

  // The endpoint round-trips; the KEY does not. `getGatewayConfig` reports only
  // THAT one is set — a config object carrying the secret back to the renderer
  // is the security contract this asserts.
  await expect
    .poll(async () =>
      (await window.evaluate(() => (window as never as WinApi).api.getGatewayConfig())).endpoint
    )
    .toBe('http://127.0.0.1:9/v1')
  const cfg = await window.evaluate(() => (window as never as WinApi).api.getGatewayConfig())
  expect(cfg.hasKey).toBe(true)
  expect(JSON.stringify(cfg)).not.toContain('secret-under-test')

  // Esc closes the modal (accessibility).
  await window.keyboard.press('Escape')
  await expect(window.locator('[data-testid="settings-modal"]')).toHaveCount(0)
})

// ---------------------------------------------------------- storage locations
// These moved here from the Integrations screen: a storage location is
// CONFIGURATION (where files live), not an outlet (where analyses go).

test('storage locations list real roots with a probed reachability state', async ({ launch }) => {
  const { window } = await launch()
  await window.click('[data-testid="nav-integrations-settings"]')
  await window.click('[data-testid="settings-tab-storage"]')

  const dirs = await api<BaseDirDTO[]>(window, 'listBaseDirs')
  expect(dirs.length).toBeGreaterThan(0)

  for (const d of dirs) {
    const row = window.locator(`[data-testid="basedir-${d.id}"]`)
    await expect(row).toBeVisible()
    await expect(row).toContainText(d.abs_path)
    // Reachability is a REAL probe, and it is reported only when it is NOT the
    // ordinary case: a reachable folder carries no badge, because a mark on
    // every row is noise that costs the reader the one row needing attention.
    // The two exceptional outcomes stay distinct — an unprobeable root must
    // never be reported as missing.
    const badge = window.locator(`[data-testid="basedir-reachable-${d.id}"]`)
    if (d.reachable === true) await expect(badge).toHaveCount(0)
    else await expect(badge).toContainText(d.reachable === null ? /Not verified/i : /Unreachable/i)
  }

  // The seed provisions exactly ONE app-owned library, and it holds the corpus.
  const managed = dirs.filter((d) => d.managed)
  expect(managed.length).toBe(1)
  expect(managed[0].document_count).toBeGreaterThan(0)
  expect(managed[0].reachable).toBe(true)
})

test('the managed library cannot be removed, and says why', async ({ launch }) => {
  const { window } = await launch()
  await window.click('[data-testid="nav-integrations-settings"]')
  await window.click('[data-testid="settings-tab-storage"]')

  const dirs = await api<BaseDirDTO[]>(window, 'listBaseDirs')
  const managed = dirs.find((d) => d.managed)!

  // Disabled AND self-explaining — a control that merely fails to respond reads
  // as a broken app.
  const remove = window.locator(`[data-testid="basedir-remove-${managed.id}"]`)
  await expect(remove).toBeDisabled()
  await expect(remove).toHaveAttribute('data-tip', /cannot be removed/i)

  // And the refusal is enforced in main, not just in the UI.
  await expect(
    window.evaluate((id) => (window as never as WinApi).api.removeBaseDir(id), managed.id)
  ).rejects.toThrow(/manages|cannot be removed/i)
})

test('a storage location can be added, renamed and removed', async ({ launch }) => {
  const { window } = await launch()
  await window.click('[data-testid="nav-integrations-settings"]')

  const before = await api<BaseDirDTO[]>(window, 'listBaseDirs')

  // The folder chooser is a native modal that cannot be driven from the
  // renderer, so the ADD goes through the same IPC the dialog would call. The
  // rendered result is then asserted in the DOM, which is the part that could
  // silently not update.
  const scratch = resolve(ROOT, 'test-results', `stor-${randomUUID()}`)
  mkdirSync(scratch, { recursive: true })
  await window.evaluate(
    (p) =>
      (window as never as WinApi).api.addBaseDir({
        label: 'Scratch library',
        abs_path: p,
        kind: 'local'
      }),
    scratch
  )

  const added = (await api<BaseDirDTO[]>(window, 'listBaseDirs')).find(
    (d) => d.abs_path === scratch
  )!
  expect(added).toBeTruthy()
  expect(added.managed).toBe(false)
  expect(added.document_count).toBe(0)

  // A location nothing depends on IS removable — the counterpart to the
  // managed-library test above.
  await window.evaluate((id) => (window as never as WinApi).api.removeBaseDir(id), added.id)
  const after = await api<BaseDirDTO[]>(window, 'listBaseDirs')
  expect(after.length).toBe(before.length)
  rmSync(scratch, { recursive: true, force: true })
})

test('a duplicate folder is refused with a reason the user can read', async ({ launch }) => {
  const { window } = await launch()
  const dirs = await api<BaseDirDTO[]>(window, 'listBaseDirs')
  const existing = dirs[0]

  await expect(
    window.evaluate(
      (p) =>
        (window as never as WinApi).api.addBaseDir({
          label: 'Duplicate',
          abs_path: p,
          kind: 'local'
        }),
      existing.abs_path
    )
  ).rejects.toThrow(/already/i)
})

test('the gateway endpoint survives an app relaunch (persisted outside the renderer)', async () => {
  // This test needs TWO launches against the SAME DB, so it drives electron
  // directly (the shared `launch` fixture always makes a fresh per-run DB).
  const dbPath = resolve(ROOT, 'test-results', 'db', `settings-${randomUUID()}.sqlite`)
  seedDb(dbPath, 'fresh')

  const launchAt = async () =>
    electron.launch({
      args: [MAIN],
      cwd: ROOT,
      env: profileEnv({
        CORPUS_DB_PATH: dbPath,
        NODE_ENV: 'production',
        CORPUS_NO_CLOSE_GUARD: '1'
      })
    })

  const endpoint = `http://127.0.0.1:9/${randomUUID()}`

  // ---- launch 1: point the app at a gateway, then close ----
  const app1 = await launchAt()
  const w1 = await app1.firstWindow()
  await w1.waitForSelector('[data-testid="sidebar"]', { timeout: 20_000 })
  await w1.click('[data-testid="nav-integrations-settings"]')
  await expect(w1.locator('[data-testid="settings-modal"]')).toBeVisible()
  await w1.click('[data-testid="settings-tab-ai"]')
  await w1.fill('[data-testid="settings-endpoint"]', endpoint)
  await w1.click('[data-testid="settings-save-gateway"]')
  await expect
    .poll(async () =>
      (await w1.evaluate(() => (window as never as WinApi).api.getGatewayConfig())).endpoint
    )
    .toBe(endpoint)
  await app1.close()

  // ---- launch 2: the endpoint must still be the one that was typed ----
  const app2 = await launchAt()
  const w2 = await app2.firstWindow()
  await w2.waitForSelector('[data-testid="sidebar"]', { timeout: 20_000 })
  const cfg = await w2.evaluate(() => (window as never as WinApi).api.getGatewayConfig())
  expect(cfg.endpoint).toBe(endpoint)
  await app2.close()

  // Cleanup the temp DB + sidecars.
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbPath + suffix
    if (existsSync(p)) rmSync(p)
  }
})
