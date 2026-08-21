import { defineConfig } from '@playwright/test'

/**
 * Playwright config for the Corpus Studio Electron E2E suite.
 *
 * Everything runs against the BUILT app (out/main/index.js) launched via
 * `_electron.launch`. These tests open real windows and type into them, so
 * `globalSetup` provisions a VIRTUAL display (spawning Xvfb unless DISPLAY is
 * already virtual) and every launch is pinned to it — no invocation, npm script
 * or not, can put a window on the user's screen. Set `CORPUS_E2E_HEADED=1`
 * (i.e. `npm run test:e2e:headed`) to watch it drive the app for real.
 *
 * Each test seeds a FRESH SQLite DB in a per-test temp path (see
 * e2e/helpers/electron.ts) so tests never share mutable state.
 *
 * Artefacts on failure: traces, videos and screenshots are retained only for
 * failing tests and land under test-results/ ; the HTML report lands under
 * playwright-report/ (both gitignored). Open the report with
 *   npx playwright show-report
 */
export default defineConfig({
  testDir: './e2e',
  // Runs BEFORE any test and before the workers are forked, so the display it
  // publishes reaches every `launchApp` no matter how the run was started.
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  // Electron apps are heavy and share ONE display: two concurrent
  // `_electron.launch` calls reliably time out waiting for the first window,
  // producing failures that look like app bugs but are pure contention.
  // The suite is serial by mandate — see CLAUDE.md.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  outputDir: 'test-results',
  use: {
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    {
      name: 'electron'
    }
  ]
})
