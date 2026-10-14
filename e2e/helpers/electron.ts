import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { test as base, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { DISPLAY_ENV } from '../display'
import { profileEnv } from '../profile'

const ROOT = resolve(__dirname, '..', '..')
const MAIN = resolve(ROOT, 'out', 'main', 'index.js')
const ELECTRON_BIN = resolve(ROOT, 'node_modules', '.bin', 'electron')

export type SeedMode = 'fresh' | 'stress' | 'extraction-bulk' | 'render-paths'

const SEED_SCRIPTS: Record<SeedMode, string> = {
  fresh: 'scripts/run-seed.ts',
  stress: 'scripts/seed-stress.ts',
  'extraction-bulk': 'scripts/seed-extraction-bulk.ts',
  'render-paths': 'scripts/seed-render-paths.ts'
}

export interface LaunchResult {
  app: ElectronApplication
  window: Page
  dbPath: string
  consoleErrors: string[]
}

/**
 * Seed a FRESH SQLite DB at `dbPath` using the electron-as-node invocation so
 * that better-sqlite3's Electron ABI matches the one the app links against.
 * `mode` selects which seed script runs:
 *   - 'fresh'           -> scripts/run-seed.ts --fresh (the canonical demo corpus)
 *   - 'stress'          -> scripts/seed-stress.ts      (thousands of works)
 *   - 'extraction-bulk' -> scripts/seed-extraction-bulk.ts
 *                          (demo corpus + ~95 field-unlinked measurements, the
 *                           only records the Extraction screen paginates)
 *   - 'render-paths'    -> scripts/seed-render-paths.ts
 *                          (demo corpus plus the two provenance shapes it cannot
 *                           reach: a rule-classified and a model-classified
 *                           citation context, and a GLOBAL project-0 run. Both
 *                           render paths are real product code with no demo data)
 */
export function seedDb(dbPath: string, mode: SeedMode = 'fresh'): void {
  mkdirSync(dirname(dbPath), { recursive: true })
  const script = SEED_SCRIPTS[mode]
  const args = ['--import', 'tsx', script]
  if (mode === 'fresh') args.push('--fresh')
  execFileSync(ELECTRON_BIN, args, {
    cwd: ROOT,
    stdio: 'pipe',
    env: profileEnv({
      ELECTRON_RUN_AS_NODE: '1',
      CORPUS_DB_PATH: dbPath
    })
  })
  if (!existsSync(dbPath)) {
    throw new Error(`seed did not create DB at ${dbPath}`)
  }
}

/**
 * Launch the built Electron app against a freshly seeded per-run DB. Waits for
 * the shell sidebar to appear. Console errors are collected into
 * `consoleErrors` so specs can assert on them.
 */
export async function launchApp(
  mode: SeedMode = 'fresh',
  /**
   * Extra environment for the launched app, applied over the profile redirect.
   *
   * For a spec that needs the REAL app to see something only the environment can
   * put there — a plugins root of its own, say. It cannot reach the profile keys
   * `profileEnv` asserts on, which is what keeps the guard in e2e/profile.ts
   * meaningful.
   */
  extraEnv: Record<string, string> = {}
): Promise<LaunchResult> {
  // PRE-FLIGHT. A rebuild that lands WHILE the suite is running deletes and
  // rewrites out/, so a launch can catch the moment when the bundle is absent
  // or half-written. Playwright then reports either "Process failed to launch"
  // or — worse — a 20s "waiting for [data-testid=sidebar]" timeout, which reads
  // like an app bug and sends the reader hunting one. Name the real cause.
  if (!existsSync(MAIN)) {
    throw new Error(
      `E2E cannot launch: ${MAIN} does not exist.\n` +
        'The built bundle is missing or was rewritten mid-run. Run `npm run build`, ' +
        'and do not rebuild while the suite is running.'
    )
  }

  const dbPath = resolve(ROOT, 'test-results', 'db', `${randomUUID()}.sqlite`)
  seedDb(dbPath, mode)

  // The window goes on the display global-setup provisioned, named explicitly
  // rather than inherited: these tests type into the windows they open, so one
  // landing on the user's desktop would steal their keyboard for the whole run.
  const display = process.env[DISPLAY_ENV]
  if (!display) {
    throw new Error(
      `E2E cannot launch: ${DISPLAY_ENV} is unset, so no virtual display was provisioned.\n` +
        'Run the suite through Playwright (globalSetup in playwright.config.ts sets it up); ' +
        'a direct `_electron.launch` outside the suite is not supported.'
    )
  }

  const app = await electron.launch({
    args: [MAIN],
    cwd: ROOT,
    // The app writes far more than a database to the per-user data directory —
    // the gateway credential above all — so the profile is redirected too, and
    // by the helper rather than by each spec. See e2e/profile.ts.
    env: profileEnv({
      DISPLAY: display,
      CORPUS_DB_PATH: dbPath,
      NODE_ENV: 'production',
      // The close prompt would hold `app.close()` open waiting for an answer
      // nobody is there to give; the resulting timeout would be reported as a
      // launch failure rather than as the guard doing its job.
      CORPUS_NO_CLOSE_GUARD: '1',
      // Enables the preload's `corpusTest` idle probe (see settleConsole). Off
      // in a real build, so production pays neither the per-call promise hop
      // nor an extra exposed surface.
      CORPUS_TEST_HOOKS: '1',
      ...extraEnv
    })
  })

  const window = await app.firstWindow()
  const consoleErrors: string[] = []
  window.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  window.on('pageerror', (err) => consoleErrors.push(String(err)))

  await window.waitForSelector('[data-testid="sidebar"]', { timeout: 20_000 })
  return { app, window, dbPath, consoleErrors }
}

export async function closeApp(res: LaunchResult | null): Promise<void> {
  if (!res) return
  try {
    await res.app.close()
  } catch {
    /* already gone */
  }
  for (const suffix of ['', '-wal', '-shm']) {
    const p = res.dbPath + suffix
    try {
      if (existsSync(p)) rmSync(p)
    } catch {
      /* best effort */
    }
  }
}

/**
 * A Playwright fixture that provides a launched, freshly-seeded app per test
 * and tears it down (closing the app + removing the temp DB) afterwards. Also
 * wires up a trace so failing tests retain a `trace.zip` in their output dir.
 */
type Fixtures = {
  launch: (mode?: SeedMode, extraEnv?: Record<string, string>) => Promise<LaunchResult>
}

export const test = base.extend<Fixtures>({
  launch: async ({}, use, testInfo) => {
    const launched: LaunchResult[] = []
    let traceStarted = false

    const launcher = async (
      mode: SeedMode = 'fresh',
      extraEnv: Record<string, string> = {}
    ): Promise<LaunchResult> => {
      const res = await launchApp(mode, extraEnv)
      if (!traceStarted) {
        try {
          await res.window.context().tracing.start({ screenshots: true, snapshots: true })
          traceStarted = true
        } catch {
          /* tracing best-effort for electron contexts */
        }
      }
      launched.push(res)
      return res
    }

    await use(launcher)

    const failed = testInfo.status !== testInfo.expectedStatus
    for (const res of launched) {
      if (traceStarted) {
        try {
          if (failed) {
            await res.window
              .context()
              .tracing.stop({ path: testInfo.outputPath('trace.zip') })
          } else {
            await res.window.context().tracing.stop()
          }
        } catch {
          /* ignore */
        }
        traceStarted = false
      }
      if (failed) {
        try {
          await res.window.screenshot({ path: testInfo.outputPath('failure.png') })
        } catch {
          /* ignore */
        }
      }
      await closeApp(res)
    }
  }
})

export { expect }

/** Convenience: navigate to a screen via its sidebar nav item and wait for it. */
export async function goto(window: Page, screen: string): Promise<void> {
  await window.click(`[data-testid="nav-${screen}"]`)
  await window.waitForSelector(`[data-testid="screen-${screen}"]`, { timeout: 15_000 })
}

/**
 * Open a project via the Projects dashboard. The redesigned shell has no
 * `<select>` switcher — a project is opened by clicking its dashboard card,
 * which lands on the in-project Connectome (graph) screen. Signature is
 * unchanged so specs pin a specific seeded project id exactly as before.
 *
 * Robust to being called while already inside a project: it first returns to
 * the dashboard (via the "Back to projects" / "All projects" nav-projects item)
 * so the target card is present, then clicks it.
 */
export async function selectProject(window: Page, projectId: number): Promise<void> {
  const card = `[data-testid="project-card-${projectId}"]`
  if (!(await window.locator(card).first().isVisible().catch(() => false))) {
    await window.click('[data-testid="nav-projects"]')
    await window.waitForSelector('[data-testid="screen-projects"]', { timeout: 15_000 })
  }
  await window.click(card)
  // Opening a project routes to the Connectome (graph) by default.
  await window.waitForSelector('[data-testid="screen-graph"]', { timeout: 15_000 })
}

/**
 * Choose a value in the app's custom <Select>.
 *
 * Playwright's `selectOption` only drives a native `<select>`, and these are
 * ARIA listboxes: Chromium renders a native `<select>`'s open list as an OS
 * widget that CSS cannot style, so the app uses its own. The popup is portalled
 * to <body> (it would be clipped by the ranked-list scroll container), hence the
 * option is matched globally rather than inside the trigger.
 */
export async function chooseOption(
  window: Page,
  triggerTestId: string,
  value: string
): Promise<void> {
  // `force` because these triggers sit inside the ranked-work CARD, which is
  // itself clickable and can win Playwright's actionability hit-test even though
  // a real user's click lands fine (the trigger stops propagation). Without it
  // the click is silently swallowed and the listbox never opens.
  const trigger = window.locator(`[data-testid="${triggerTestId}"]`)
  await trigger.scrollIntoViewIfNeeded()
  await trigger.click({ force: true })
  const option = `[data-testid="${triggerTestId}-option-${value}"]`
  await window.waitForSelector(option, { timeout: 10_000 })
  await window.click(option)
  // The listbox unmounts on commit; waiting avoids racing the next assertion.
  await window.waitForSelector(option, { state: 'detached', timeout: 10_000 })
}

/**
 * Wait until the renderer has genuinely stopped working: no `window.api` call
 * in flight, and none started for several consecutive frames (the preload's
 * `corpusTest.whenIdle`). Then drain the microtask + task queues once more so a
 * rejection already queued behind the last resolution reaches the console
 * listener before the caller reads `consoleErrors`.
 *
 * This replaces `waitForTimeout(300)` in the console-error specs. A fixed sleep
 * races in the direction that HIDES failures — an error emitted just after it
 * elapses is simply never collected, so the spec reports "no console errors"
 * for a run that had one, and does so MORE often the busier the machine is.
 * Waiting on the app's own work inverts that: the wait grows with the load
 * instead of being outrun by it.
 *
 * It is a much stronger signal than a duration guess, not a proof of total
 * quiescence — an error thrown from a bare `setTimeout` path is still outside
 * what the api counter can see. Said plainly here so nobody later reads this as
 * a guarantee it does not make.
 */
export async function settleConsole(window: Page): Promise<void> {
  await window.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (window as any).corpusTest.whenIdle()
    // A promise that rejected during the final api call reports to the console
    // on the microtask turn AFTER it settles; one macrotask hop guarantees that
    // turn has run. This is bounded work, not a duration guess.
    await new Promise((r) => setTimeout(r, 0))
  })
}

/** Read a value straight from the DB-backed API in the renderer. */
export async function api<T>(
  window: Page,
  fn: string,
  ...args: unknown[]
): Promise<T> {
  return window.evaluate(
    ([f, a]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any
      return w.api[f as string](...(a as unknown[]))
    },
    [fn, args] as const
  )
}
