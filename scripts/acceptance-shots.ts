/* eslint-disable no-console */
// Screenshot-instrumented acceptance harness (permanent).
//
// Launches the BUILT app against a freshly-seeded temp DB, walks every screen +
// key state, captures a screenshot per step to tmp/acceptance/round-<N>/<step>.png,
// and records a machine-readable manifest (with a few DOM probes) to
// tmp/acceptance/round-<N>/manifest.json. A human/agent then cross-checks each
// shot against the design screenshots (aspect B) and the engineered acceptance
// criteria.
//
// Run under xvfb:  xvfb-run -a ./node_modules/.bin/electron --import tsx \
//                    scripts/acceptance-shots.ts <round>
// (better-sqlite3 native ABI matches because we launch electron-as-node to seed,
//  then Playwright launches the real electron for the app.)

import { _electron as electron, type Page } from 'playwright'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve, join } from 'node:path'

const ROOT = resolve(__dirname, '..')
const MAIN = resolve(ROOT, 'out', 'main', 'index.js')
const ELECTRON_BIN = resolve(ROOT, 'node_modules', '.bin', 'electron')

const round = process.argv[2] ?? '1'
const OUT = resolve(ROOT, 'tmp', 'acceptance', `round-${round}`)

interface StepResult {
  step: string
  screenshot: string
  probes: Record<string, unknown>
  ok: boolean
  note?: string
}

async function shot(win: Page, name: string): Promise<string> {
  const file = join(OUT, `${name}.png`)
  // Let the screenIn fade/slide animation settle so screenshots reflect the
  // final rendered state (not a mid-animation low-opacity frame).
  await win.waitForTimeout(650)
  await win.screenshot({ path: file, fullPage: false })
  return file
}

async function count(win: Page, selector: string): Promise<number> {
  return win.locator(selector).count()
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true })

  // --- seed a fresh temp DB via electron-as-node -----------------------------
  const dbPath = resolve(ROOT, 'test-results', 'db', `acceptance-${randomUUID()}.sqlite`)
  mkdirSync(resolve(ROOT, 'test-results', 'db'), { recursive: true })
  execFileSync(ELECTRON_BIN, ['--import', 'tsx', 'scripts/run-seed.ts', '--fresh'], {
    cwd: ROOT,
    stdio: 'pipe',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CORPUS_DB_PATH: dbPath }
  })

  const app = await electron.launch({
    args: [MAIN],
    cwd: ROOT,
    env: { ...process.env, CORPUS_DB_PATH: dbPath, NODE_ENV: 'production', CORPUS_NO_CLOSE_GUARD: '1' }
  })
  const win = await app.firstWindow()
  const consoleErrors: string[] = []
  win.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  win.on('pageerror', (e) => consoleErrors.push(String(e)))
  await win.setViewportSize({ width: 1440, height: 900 })
  await win.waitForSelector('[data-testid="sidebar"]', { timeout: 20_000 })

  const results: StepResult[] = []
  const rec = async (
    step: string,
    probes: Record<string, unknown>,
    ok = true,
    note?: string
  ): Promise<void> => {
    const screenshot = await shot(win, step)
    results.push({ step, screenshot, probes, ok, note })
    console.log(`[shot] ${step} -> ${screenshot}  ${ok ? 'OK' : 'CHECK'}${note ? ' (' + note + ')' : ''}`)
  }

  // 1) DASHBOARD (no project) --------------------------------------------------
  await win.waitForSelector('[data-testid="screen-projects"]', { timeout: 15_000 })
  const projectCards = await count(win, '[data-testid^="project-card-"]')
  await rec('01-dashboard', {
    project_cards: projectCards,
    has_topbar: (await count(win, '[data-testid="topbar"]')) === 1,
    has_sidebar: (await count(win, '[data-testid="sidebar"]')) === 1
  })

  // open the first project (KE07) by clicking its card
  const firstCard = win.locator('[data-testid^="project-card-"]').first()
  await firstCard.click()
  await win.waitForSelector('[data-testid="screen-graph"]', { timeout: 15_000 })

  // 2) CONNECTOME / GRAPH ------------------------------------------------------
  await rec('02-graph', {
    svg: (await count(win, '[data-testid="graph-svg"]')) >= 1,
    nodes: await count(win, '[data-testid="graph-svg"] circle, [data-testid="graph-svg"] .node')
  })

  // 3) RANKING -----------------------------------------------------------------
  const navAndShot = async (route: string, screenTid: string, step: string): Promise<void> => {
    const nav = win.locator(`[data-testid="nav-${route}"]`)
    if ((await nav.count()) > 0) {
      await nav.first().click()
      try {
        await win.waitForSelector(`[data-testid="${screenTid}"]`, { timeout: 12_000 })
      } catch {
        /* capture whatever is there */
      }
    }
    await rec(step, { reached: (await count(win, `[data-testid="${screenTid}"]`)) > 0 })
  }
  await navAndShot('ranking', 'screen-ranking', '03-ranking')
  await navAndShot('ingest', 'screen-ingest', '04-ingest')
  await navAndShot('extraction', 'screen-extraction', '05-extraction')
  await navAndShot('review', 'screen-review', '06-review')
  await navAndShot('dossier', 'screen-dossier', '07-dossier')
  await navAndShot('integrations', 'screen-integrations', '08-integrations')

  // 9) PAPER DETAIL — open the first ranking row's title -----------------------
  const rnav = win.locator('[data-testid="nav-ranking"]')
  if ((await rnav.count()) > 0) {
    await rnav.first().click()
    await win.waitForSelector('[data-testid="screen-ranking"]', { timeout: 12_000 }).catch(() => {})
    const title = win.locator('[data-testid^="ranking-row-"] .rank-title').first()
    if ((await title.count()) > 0) {
      await title.click()
      await win.waitForSelector('[data-testid="screen-paper"]', { timeout: 12_000 }).catch(() => {})
    }
  }
  await rec('09-paper', {
    reached: (await count(win, '[data-testid="screen-paper"]')) > 0,
    run_tabs: (await count(win, '[data-testid="run-tabs"]')) > 0,
    pdf_panel: (await count(win, '[data-testid="paper-pdf-panel"]')) > 0
  })

  // 10) SEARCH (topbar) --------------------------------------------------------
  const search = win.locator('[data-testid="global-search-input"]')
  if ((await search.count()) > 0) {
    await search.first().fill('kemp')
    await search.first().press('Enter')
    await win.waitForSelector('[data-testid="screen-search"]', { timeout: 12_000 }).catch(() => {})
  }
  await rec('10-search', { reached: (await count(win, '[data-testid="screen-search"]')) > 0 })

  // finalize -------------------------------------------------------------------
  const manifest = {
    round,
    dbPath,
    generated_at: new Date().toISOString(),
    console_errors: consoleErrors,
    steps: results
  }
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2))
  console.log(`\n[acceptance] ${results.length} shots -> ${OUT}`)
  console.log(`[acceptance] console_errors: ${consoleErrors.length}`)
  if (consoleErrors.length) console.log(consoleErrors.map((e) => '  - ' + e).join('\n'))

  await app.close()
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbPath + suffix
    try {
      if (existsSync(p)) rmSync(p)
    } catch {
      /* best effort */
    }
  }
}

main().catch((err) => {
  console.error('acceptance-shots crashed:', err)
  process.exit(1)
})
