import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { profileEnv } from './profile'

/**
 * REAL-LAUNCH SMOKE TEST — guards the DB-path regression.
 *
 * Every OTHER spec injects `CORPUS_DB_PATH` pointing at a per-test temp DB, so
 * the app's REAL default-path resolution (src/main/db/paths.ts `defaultDbPath()`)
 * is never exercised by them. That is exactly how the "npm start shows a blank
 * UI" bug hid: the app opened `userData/corpus.sqlite` while `seed:fresh` wrote
 * to a different directory.
 *
 * A FRESH INSTALL IS EMPTY BY DESIGN, so "the dashboard shows projects" is no
 * longer the signal. A scientist's install must contain their work and nobody
 * else's; launch seeds nothing. The regression this guards is therefore a WRONG
 * PATH, not an empty screen, and it is caught in two halves:
 *   1. Launch with NO CORPUS_DB_PATH and only XDG_CONFIG_HOME redirected to a
 *      throwaway dir. The app must reach its FIRST-RUN state and must have
 *      opened, migrated and be answering from exactly defaultDbPath() — an
 *      empty DB whose tables exist, never a row count.
 *   2. Seed THAT SAME path and relaunch. The data must now be on screen. This
 *      is what proves the seed runner and the app agree on the path: if they
 *      diverged, step 2 would still show nothing.
 */

const ROOT = resolve(__dirname, '..')
const MAIN = resolve(ROOT, 'out', 'main', 'index.js')
const ELECTRON_BIN = resolve(ROOT, 'node_modules', '.bin', 'electron')

let app: ElectronApplication | null = null
let window: Page | null = null
let xdgDir: string | null = null

test.afterEach(async () => {
  if (app) {
    try {
      await app.close()
    } catch {
      /* already gone */
    }
    app = null
    window = null
  }
  if (xdgDir) {
    try {
      rmSync(xdgDir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
    xdgDir = null
  }
})

test('real launch (no CORPUS_DB_PATH) opens defaultDbPath(), empty, then shows what is seeded into it', async () => {
  // Redirect the per-user config dir so defaultDbPath() lands in a temp path we
  // fully control — NEVER the developer's real ~/.config/corpus-studio.
  xdgDir = mkdtempSync(join(tmpdir(), 'corpus-smoke-xdg-'))
  const expectedDbPath = join(xdgDir, 'corpus-studio', 'corpus.sqlite')

  const launchEnv = profileEnv({
    XDG_CONFIG_HOME: xdgDir,
    NODE_ENV: 'production',
    CORPUS_NO_CLOSE_GUARD: '1',
    CORPUS_DB_PATH: undefined
  })

  // --- 1) FIRST RUN. Nothing has been seeded, so the app must create, migrate
  //        and open the default DB and show its first-run state. -------------
  app = await electron.launch({ args: [MAIN], cwd: ROOT, env: launchEnv })
  window = await app.firstWindow()

  const consoleErrors: string[] = []
  window.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  window.on('pageerror', (e) => consoleErrors.push(String(e)))

  await window.waitForSelector('[data-testid="sidebar"]', { timeout: 20_000 })
  await window.waitForSelector('[data-testid="first-run"]', { timeout: 15_000 })

  // The app opened EXACTLY defaultDbPath() — the regression is a wrong path, so
  // this is asserted on the path itself, never on a row count.
  expect(
    existsSync(expectedDbPath),
    `launch must create the app default DB at ${expectedDbPath}`
  ).toBe(true)

  // And it MIGRATED it: the schema is present and answering, which is what
  // distinguishes "correctly empty" from "opened something broken". An empty
  // list is the right answer here and must not throw.
  const emptyProjects = await window.evaluate(() =>
    (window as never as { api: { listProjects(): Promise<unknown[]> } }).api.listProjects()
  )
  expect(emptyProjects, 'a fresh install starts with no projects').toEqual([])

  await app.close()
  app = null

  // --- 2) Seed THAT path, relaunch, and the data must be there. -------------
  // This is the half that proves the seed runner and the app agree: if they
  // resolved different paths, the screen would still be empty.
  const seedEnv = profileEnv({
    XDG_CONFIG_HOME: xdgDir,
    ELECTRON_RUN_AS_NODE: '1',
    CORPUS_DB_PATH: undefined
  })
  execFileSync(ELECTRON_BIN, ['--import', 'tsx', 'scripts/run-seed.ts', '--fresh'], {
    cwd: ROOT,
    stdio: 'pipe',
    env: seedEnv
  })

  app = await electron.launch({ args: [MAIN], cwd: ROOT, env: launchEnv })
  window = await app.firstWindow()
  window.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  window.on('pageerror', (e) => consoleErrors.push(String(e)))
  await window.waitForSelector('[data-testid="sidebar"]', { timeout: 20_000 })

  const projects = await window.evaluate(() =>
    (
      window as never as {
        api: { listProjects(): Promise<Array<{ id: number; name: string; work_count: number }>> }
      }
    ).api.listProjects()
  )
  expect(projects.length, 'the seeded DB is the one the app opened').toBeGreaterThan(0)

  // The dashboard renders one card per project, so the data reached the SCREEN
  // and not merely the IPC boundary.
  await window.waitForSelector('[data-testid="screen-projects"]', { timeout: 15_000 })
  await expect(window.locator('[data-testid="first-run"]')).toHaveCount(0)
  const cardCount = await window.locator('[data-testid^="project-card-"]').count()
  expect(cardCount, 'one card per seeded project, read from the DB').toBe(projects.length)
  for (const p of projects) {
    await expect(window.locator(`[data-testid="project-card-${p.id}"]`)).toContainText(p.name)
    await expect(window.locator(`[data-testid="project-work-count-${p.id}"]`)).toHaveText(
      String(p.work_count)
    )
  }

  // No renderer console errors on either launch.
  expect(consoleErrors, `console errors on real launch: ${consoleErrors.join(' | ')}`).toEqual([])
})
