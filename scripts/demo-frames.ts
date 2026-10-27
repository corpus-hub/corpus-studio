/* eslint-disable no-console */
// Produces a smooth demo of the built app by capturing a burst of REAL page
// screenshots while walking the main screens, then leaves them as a numbered
// frame sequence for ffmpeg to encode. Runs headless under xvfb (screenshots
// capture the actual rendered page regardless of the host compositor, so this
// is far more reliable than x11grab of a GPU-composited Electron window).
//
// Usage: xvfb-run -a node --import tsx scripts/demo-frames.ts <outDir>
// then:  ffmpeg -framerate 12 -i <outDir>/f_%05d.png ... corpus-final-demo.mp4

import { _electron as electron, type Page } from 'playwright'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve, join } from 'node:path'

const ROOT = resolve(__dirname, '..')
const MAIN = resolve(ROOT, 'out', 'main', 'index.js')
const ELECTRON_BIN = resolve(ROOT, 'node_modules', '.bin', 'electron')
const OUT = process.argv[2] ? resolve(process.argv[2]) : resolve(ROOT, 'tmp', 'demo-frames')

let frame = 0
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function hold(win: Page, ms: number, fps = 12): Promise<void> {
  // Capture `fps` frames per second for `ms` so the video holds on this view.
  const n = Math.max(1, Math.round((ms / 1000) * fps))
  for (let i = 0; i < n; i++) {
    frame++
    await win.screenshot({ path: join(OUT, `f_${String(frame).padStart(5, '0')}.png`) }).catch(() => {})
    await sleep(1000 / fps)
  }
}

async function nav(win: Page, route: string, screen: string, ms = 1800): Promise<void> {
  const el = win.locator(`[data-testid="nav-${route}"]`)
  if ((await el.count()) > 0) {
    await el.first().click()
    await win.waitForSelector(`[data-testid="${screen}"]`, { timeout: 12_000 }).catch(() => {})
  }
  await hold(win, ms)
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  // clean old frames
  for (const suffix of ['']) void suffix
  const dbPath = resolve(ROOT, 'test-results', 'db', `demof-${randomUUID()}.sqlite`)
  mkdirSync(resolve(ROOT, 'test-results', 'db'), { recursive: true })
  execFileSync(ELECTRON_BIN, ['--import', 'tsx', 'scripts/run-seed.ts', '--fresh'], {
    cwd: ROOT,
    stdio: 'pipe',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CORPUS_DB_PATH: dbPath }
  })

  const app = await electron.launch({ args: [MAIN], cwd: ROOT, env: { ...process.env, CORPUS_DB_PATH: dbPath, NODE_ENV: 'production', CORPUS_NO_CLOSE_GUARD: '1' } })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1440, height: 900 })
  await win.waitForSelector('[data-testid="sidebar"]', { timeout: 20_000 })

  // Dashboard
  await win.waitForSelector('[data-testid="screen-projects"]', { timeout: 12_000 }).catch(() => {})
  await hold(win, 2600)

  // Open KE07
  const projects = await win.evaluate(() =>
    (window as unknown as { api: { listProjects(): Promise<Array<{ id: number; name: string }>> } }).api.listProjects()
  )
  const ke = projects.find((p) => p.name.includes('KE07')) ?? projects[0]
  await win.locator(`[data-testid="project-card-${ke.id}"]`).click()
  await win.waitForSelector('[data-testid="screen-graph"]', { timeout: 12_000 }).catch(() => {})
  await hold(win, 2000)
  const circle = win.locator('[data-testid="graph-svg"] circle').first()
  if ((await circle.count()) > 0) {
    await circle.click({ force: true }).catch(() => {})
    await hold(win, 2200) // inspector populated
  }

  await nav(win, 'ranking', 'screen-ranking', 2600)
  await nav(win, 'ingest', 'screen-ingest', 2400)
  await nav(win, 'extraction', 'screen-extraction', 2200)
  await nav(win, 'dossier', 'screen-dossier', 2000)

  // Paper detail
  await nav(win, 'ranking', 'screen-ranking', 900)
  const title = win.locator('[data-testid^="ranking-row-"] .rank-title').first()
  if ((await title.count()) > 0) {
    await title.click()
    await win.waitForSelector('[data-testid="screen-paper"]', { timeout: 12_000 }).catch(() => {})
    await hold(win, 2800)
  }
  await nav(win, 'integrations', 'screen-integrations', 2000)

  // Back to dashboard
  const back = win.locator('[data-testid="nav-projects"]').first()
  if ((await back.count()) > 0) {
    await back.click()
    await win.waitForSelector('[data-testid="screen-projects"]', { timeout: 12_000 }).catch(() => {})
    await hold(win, 1800)
  }

  await app.close()
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbPath + suffix
    try { if (existsSync(p)) rmSync(p) } catch { /* best effort */ }
  }
  console.log(`[demo-frames] captured ${frame} frames -> ${OUT}`)
}

main().catch((err) => {
  console.error('demo-frames crashed:', err)
  process.exit(1)
})
