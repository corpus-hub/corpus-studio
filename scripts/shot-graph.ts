/* One-off Playwright screenshot of the Connectome screen against a freshly
   seeded KE07 DB. Not part of the e2e suite — run manually:
     xvfb-run -a npx tsx scripts/shot-graph.ts
   Screenshots land in tmp/acceptance/. */
import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const ROOT = resolve(__dirname, '..')
const MAIN = resolve(ROOT, 'out', 'main', 'index.js')
const ELECTRON_BIN = resolve(ROOT, 'node_modules', '.bin', 'electron')

async function main(): Promise<void> {
  const dbPath = resolve(ROOT, 'test-results', 'db', `shot-${randomUUID()}.sqlite`)
  mkdirSync(dirname(dbPath), { recursive: true })
  mkdirSync(resolve(ROOT, 'tmp', 'acceptance'), { recursive: true })
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
  await win.setViewportSize({ width: 1280, height: 900 })
  await win.waitForSelector('[data-testid="sidebar"]', { timeout: 20000 })

  // Open the (single) KE07 project card — this auto-routes to the Connectome.
  const card = win.locator('[data-testid^="project-card"]').first()
  await card.click()
  await win.waitForSelector('[data-testid="screen-graph"]', { timeout: 15000 })
  await win.waitForSelector('[data-testid="graph-svg"] circle', { timeout: 20000 })
  await win.waitForTimeout(2500) // let the force sim settle

  await win.screenshot({ path: resolve(ROOT, 'tmp', 'acceptance', 'graph-current-empty.png') })

  // Select the largest node (most citations) so the inspector fills like the design.
  const circles = win.locator('[data-testid="graph-svg"] g.gnode circle')
  const n = await circles.count()
  let bestIdx = 0
  let bestR = -1
  for (let i = 0; i < n; i++) {
    const r = Number((await circles.nth(i).getAttribute('r')) ?? '0')
    if (r > bestR) {
      bestR = r
      bestIdx = i
    }
  }
  await circles.nth(bestIdx).click({ force: true })
  await win.waitForSelector('.cg-btn-open', { timeout: 10000 })
  await win.waitForTimeout(600)
  await win.screenshot({ path: resolve(ROOT, 'tmp', 'acceptance', 'graph-current-selected.png') })

  await app.close()
  console.log('WROTE tmp/acceptance/graph-current-empty.png + graph-current-selected.png')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
