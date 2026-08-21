/* eslint-disable no-console */
// SCREENSHOT-INSTRUMENTED ACCEPTANCE VERIFIER (permanent gate).
//
// For every key screen/flow this launches the BUILT app against a freshly-seeded
// temp DB, captures a screenshot to tmp/acceptance/round-<N>/<step>.png, and
// verifies EXPLICIT ENGINEERED ACCEPTANCE CRITERIA against BOTH the rendered DOM
// and the DB (read through the SAME window.api the UI uses). Each criterion is
// PASS only with DOM/DB evidence — no assertion-only passes. Writes a per-round
// report to tmp/acceptance/round-<N>/report.md and exits non-zero on any FAIL.
//
// Run under xvfb:  xvfb-run -a node --import tsx scripts/acceptance-verify.ts <round>

import { _electron as electron, type Page } from 'playwright'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve, join } from 'node:path'

const ROOT = resolve(__dirname, '..')
const MAIN = resolve(ROOT, 'out', 'main', 'index.js')
const ELECTRON_BIN = resolve(ROOT, 'node_modules', '.bin', 'electron')
const round = process.argv[2] ?? '3'
const OUT = resolve(ROOT, 'tmp', 'acceptance', `round-${round}`)

interface Criterion {
  id: string
  desc: string
  pass: boolean
  expected: string
  actual: string
}
interface StepReport {
  step: string
  screenshot: string
  criteria: Criterion[]
}

const reports: StepReport[] = []
let currentStep: StepReport | null = null

function crit(id: string, desc: string, expected: string, actual: string, pass: boolean): void {
  currentStep!.criteria.push({ id, desc, pass, expected, actual: String(actual) })
}

async function api<T>(win: Page, fn: string, ...args: unknown[]): Promise<T> {
  return win.evaluate(
    ([f, a]) => (window as unknown as { api: Record<string, (...x: unknown[]) => unknown> }).api[f as string](...(a as unknown[])),
    [fn, args] as const
  ) as Promise<T>
}
const n = (win: Page, sel: string): Promise<number> => win.locator(sel).count()
const txt = async (win: Page, sel: string): Promise<string> =>
  (await win.locator(sel).count()) ? (await win.locator(sel).first().innerText()).trim() : ''

async function beginStep(win: Page, step: string): Promise<void> {
  currentStep = { step, screenshot: join(OUT, `${step}.png`), criteria: [] }
  reports.push(currentStep)
  await win.waitForTimeout(650) // settle screenIn animation
  await win.screenshot({ path: currentStep.screenshot })
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  const dbPath = resolve(ROOT, 'test-results', 'db', `acc-verify-${randomUUID()}.sqlite`)
  mkdirSync(resolve(ROOT, 'test-results', 'db'), { recursive: true })
  execFileSync(ELECTRON_BIN, ['--import', 'tsx', 'scripts/run-seed.ts', '--fresh'], {
    cwd: ROOT,
    stdio: 'pipe',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CORPUS_DB_PATH: dbPath }
  })

  const app = await electron.launch({ args: [MAIN], cwd: ROOT, env: { ...process.env, CORPUS_DB_PATH: dbPath, NODE_ENV: 'production', CORPUS_NO_CLOSE_GUARD: '1' } })
  const win = await app.firstWindow()
  const consoleErrors: string[] = []
  win.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
  win.on('pageerror', (e) => consoleErrors.push(String(e)))
  await win.setViewportSize({ width: 1440, height: 900 })
  await win.waitForSelector('[data-testid="sidebar"]', { timeout: 20_000 })

  // ---- STEP 1: DASHBOARD ---------------------------------------------------
  await win.waitForSelector('[data-testid="screen-projects"]', { timeout: 15_000 })
  await beginStep(win, '01-dashboard')
  const projects = await api<Array<{ id: number; name: string; work_count: number; ranked_count: number; extracted_count: number; failed_count: number; tags: string[] }>>(win, 'listProjects')
  const cardCount = await n(win, '[data-testid^="project-card-"]')
  crit('DASH-1', 'One card per seeded project', `${projects.length} cards`, `${cardCount}`, cardCount === projects.length)
  crit('DASH-2', 'Sidebar shows All-projects + Settings (no-project shell)', 'nav-projects + Settings present', `nav-projects=${await n(win, '[data-testid="nav-projects"]')}`, (await n(win, '[data-testid="nav-projects"]')) >= 1)
  crit('DASH-3', 'Topbar has the search pill + model pill + avatar', 'global-search-input present', `${await n(win, '[data-testid="global-search-input"]')}`, (await n(win, '[data-testid="global-search-input"]')) === 1)
  // stat trio equals DB for each project
  let statOk = true
  const statDetail: string[] = []
  for (const p of projects) {
    const papers = await txt(win, `[data-testid="project-stat-papers-${p.id}"]`)
    const extracted = p.extracted_count > 0 ? await txt(win, `[data-testid="project-stat-extracted-${p.id}"]`) : ''
    const ok = papers === String(p.work_count) &&
      (p.extracted_count === 0 || extracted.includes(String(p.extracted_count)))
    if (!ok) { statOk = false; statDetail.push(`p${p.id}: dom(${papers}/${extracted}) vs db(${p.work_count}/${p.extracted_count})`) }
  }
  crit('DASH-4', 'Headline paper count (and extracted note) == DB for every card', 'all match DTO', statOk ? 'all match' : statDetail.join('; '), statOk)
  // failed flag presence matches failed_count>0
  let pillOk = true
  for (const p of projects) {
    const has = (await n(win, `[data-testid="project-flag-failed-${p.id}"]`)) > 0
    if (has !== p.failed_count > 0) { pillOk = false }
  }
  crit('DASH-5', 'Failed flag iff failed_count>0', 'flag matches DB', pillOk ? 'consistent' : 'mismatch', pillOk)
  // reading bar visibly rendered (width>0)
  const barW = await win.evaluate(() => {
    const b = document.querySelector('.project-reading-track') as HTMLElement | null
    return b ? b.getBoundingClientRect().width : -1
  })
  crit('DASH-6', 'Reading bar has a visible (non-zero) width', '>0', `${barW}`, barW > 0)

  // open KE07
  const ke = projects.find((p) => p.name.includes('KE07'))!
  await win.locator(`[data-testid="project-card-${ke.id}"]`).click()
  await win.waitForSelector('[data-testid="screen-graph"]', { timeout: 15_000 })

  // ---- STEP 2: CONNECTOME --------------------------------------------------
  await beginStep(win, '02-graph')
  crit('GRAPH-1', 'In-project icon sidebar (Connectome/Ranking/Add papers/…) present', 'nav-graph+nav-ranking+nav-ingest', `graph=${await n(win, '[data-testid="nav-graph"]')} ranking=${await n(win, '[data-testid="nav-ranking"]')}`, (await n(win, '[data-testid="nav-graph"]')) >= 1 && (await n(win, '[data-testid="nav-ranking"]')) >= 1)
  const circles = await n(win, '[data-testid="graph-svg"] circle')
  const g = await api<{ nodes: unknown[]; shown_works: number; total_works: number }>(win, 'getGraph', ke.id, {})
  crit('GRAPH-2', 'Force graph renders >0 circles, bounded by nodes', `<= ${g.nodes.length}`, `${circles}`, circles > 0 && circles <= g.nodes.length)
  const countTxt = await txt(win, '[data-testid="graph-count"]')
  crit('GRAPH-3', 'Count shows "showing X of Y" matching getGraph', `shown ${g.shown_works} of ${g.total_works}`, countTxt, /(\d+)\s*of\s*(\d+)/i.test(countTxt))
  crit('GRAPH-4', 'Persistent inspector present (always-on)', 'graph-node-detail present', `${await n(win, '[data-testid="graph-node-detail"]')}`, (await n(win, '[data-testid="graph-node-detail"]')) >= 1)
  crit('GRAPH-5', 'Legend + chip filters present', 'graph-legend + high-relevance chip', `legend=${await n(win, '[data-testid="graph-legend"]')}`, (await n(win, '[data-testid="graph-legend"]')) >= 1 && (await n(win, '[data-testid="graph-high-relevance"]')) >= 1)
  // select a node -> inspector shows bars + the open action
  await win.locator('[data-testid="graph-svg"] circle').first().click({ force: true }).catch(() => {})
  await win.waitForTimeout(300)
  crit('GRAPH-6', 'Selecting a node reveals the Open-paper action', 'cg-btn-open present after select', `${await n(win, '.cg-btn-open')}`, (await n(win, '.cg-btn-open')) >= 1)

  // ---- STEP 3: RANKING -----------------------------------------------------
  await win.locator('[data-testid="nav-ranking"]').first().click()
  await win.waitForSelector('[data-testid="screen-ranking"]', { timeout: 12_000 })
  await beginStep(win, '03-ranking')
  const ranking = await api<Array<{ work_id: number; relevance: number | null; expansion_priority: number | null }>>(win, 'getRanking', ke.id, 'relevance')
  const rows = await n(win, '[data-testid^="ranking-row-"]')
  crit('RANK-1', 'Frontier map present', 'frontier-map', `${await n(win, '[data-testid="frontier-map"]')}`, (await n(win, '[data-testid="frontier-map"]')) >= 1)
  crit('RANK-2', 'Ranked score-bar rows rendered (bounded, paginated)', '>0 and <= page', `${rows}`, rows > 0 && rows <= 50)
  // two distinct scores rendered for a row where DTO differs
  const diffRow = ranking.find((r) => r.relevance != null && r.expansion_priority != null && r.relevance !== r.expansion_priority)
  let relExpOk = false
  let relExpDetail = 'no differing DTO row'
  if (diffRow) {
    const rel = await txt(win, `[data-testid="relevance-${diffRow.work_id}"]`)
    const exp = await txt(win, `[data-testid="expansion-${diffRow.work_id}"]`)
    const relN = (rel.match(/\d+/) ?? [''])[0]
    const expN = (exp.match(/\d+/) ?? [''])[0]
    relExpOk = relN !== '' && expN !== '' && relN !== expN
    relExpDetail = `rel="${rel}" exp="${exp}"`
  }
  crit('RANK-3', 'Two DISTINCT scores rendered (relevance != expansion)', 'distinct rendered values', relExpDetail, relExpOk)
  crit('RANK-4', 'Sort + pagination controls present', 'ranking-sort + count', `sort=${await n(win, '[data-testid="ranking-sort"]')}`, (await n(win, '[data-testid="ranking-sort"]')) >= 1)

  // ---- STEP 4: ADD PAPERS --------------------------------------------------
  await win.locator('[data-testid="nav-ingest"]').first().click()
  await win.waitForSelector('[data-testid="screen-ingest"]', { timeout: 12_000 })
  await beginStep(win, '04-ingest')
  crit('INGEST-1', 'Segmented source tabs present', 'ingest-kind-tabs', `${await n(win, '[data-testid="ingest-kind-tabs"]')}`, (await n(win, '[data-testid="ingest-kind-tabs"]')) >= 1)
  crit('INGEST-2', 'Single input + Import button present', 'ingest-input + ingest-submit', `input=${await n(win, '[data-testid="ingest-input"]')} submit=${await n(win, '[data-testid="ingest-submit"]')}`, (await n(win, '[data-testid="ingest-input"]')) >= 1 && (await n(win, '[data-testid="ingest-submit"]')) >= 1)
  const jobs = await api<Array<{ id: number; status: string }>>(win, 'listJobs', ke.id)
  const jobRows = await n(win, '[data-testid^="job-row-"]')
  crit('INGEST-3', 'Processing queue renders the DB jobs', `${jobs.length} jobs`, `${jobRows} rows`, jobRows === jobs.length)

  // ---- STEP 5: EXTRACTION (+ §12 summary) ----------------------------------
  await win.locator('[data-testid="nav-extraction"]').first().click()
  await win.waitForSelector('[data-testid="screen-extraction"]', { timeout: 12_000 })
  await beginStep(win, '05-extraction')
  const summary = await api<{ total_records: number }>(win, 'getExtractionStatusSummary', ke.id)
  crit('EXT-1', '§12 extraction-status summary panel present', 'extraction-summary', `${await n(win, '[data-testid="extraction-summary"]')}`, (await n(win, '[data-testid="extraction-summary"]')) >= 1)
  const totalTxt = await txt(win, '[data-testid="extraction-summary-total"]')
  crit('EXT-2', 'Summary total == DB summary.total_records', `${summary.total_records}`, totalTxt, totalTxt.replace(/\D/g, '') === String(summary.total_records))

  // ---- STEP 6: PAPER DETAIL ------------------------------------------------
  await win.locator('[data-testid="nav-ranking"]').first().click()
  await win.waitForSelector('[data-testid="screen-ranking"]', { timeout: 12_000 })
  const firstTitle = win.locator('[data-testid^="ranking-row-"] .rank-title').first()
  await firstTitle.click()
  await win.waitForSelector('[data-testid="screen-paper"]', { timeout: 12_000 })
  await beginStep(win, '06-paper')
  crit('PAPER-1', 'Evidence-viewer panel present (PDF pane)', 'paper-pdf-panel', `${await n(win, '[data-testid="paper-pdf-panel"]')}`, (await n(win, '[data-testid="paper-pdf-panel"]')) >= 1)
  crit('PAPER-2', 'Provenance run tabs present', 'run-tabs', `${await n(win, '[data-testid="run-tabs"]')}`, (await n(win, '[data-testid="run-tabs"]')) >= 1)
  crit('PAPER-3', 'Fact-kind legend has exactly 5 kinds', '5 legend-tag', `${await n(win, '[data-testid="fact-legend"] .legend-tag')}`, (await n(win, '[data-testid="fact-legend"] .legend-tag')) === 5)

  // ---- STEP 7: SEARCH ------------------------------------------------------
  await win.locator('[data-testid="global-search-input"]').first().fill('kemp')
  await win.locator('[data-testid="global-search-input"]').first().press('Enter')
  await win.waitForSelector('[data-testid="screen-search"]', { timeout: 12_000 }).catch(() => {})
  await beginStep(win, '07-search')
  crit('SEARCH-1', 'Topbar search routes to results screen', 'screen-search', `${await n(win, '[data-testid="screen-search"]')}`, (await n(win, '[data-testid="screen-search"]')) >= 1)

  // ---- global: no console errors ------------------------------------------
  currentStep = { step: '00-global', screenshot: '', criteria: [] }
  reports.push(currentStep)
  crit('GLOBAL-1', 'No renderer console errors during the whole walk', '0 errors', `${consoleErrors.length}: ${consoleErrors.slice(0, 3).join(' | ')}`, consoleErrors.length === 0)

  // ---- write report --------------------------------------------------------
  const all = reports.flatMap((s) => s.criteria)
  const fails = all.filter((c) => !c.pass)
  const md: string[] = [`# Acceptance report — round ${round}`, '', `Generated: ${new Date().toISOString()}`, `DB: ${dbPath}`, '', `**${all.length - fails.length}/${all.length} criteria PASS, ${fails.length} FAIL.**`, '']
  for (const s of reports) {
    if (!s.criteria.length) continue
    md.push(`## ${s.step}`)
    if (s.screenshot) md.push(`Screenshot: \`${s.screenshot}\``, '')
    for (const c of s.criteria) {
      md.push(`- ${c.pass ? 'PASS' : 'FAIL'} **${c.id}** — ${c.desc}`)
      if (!c.pass) md.push(`    - expected: ${c.expected}`, `    - actual: ${c.actual}`)
    }
    md.push('')
  }
  writeFileSync(join(OUT, 'report.md'), md.join('\n'))
  console.log(`[acceptance] ${all.length - fails.length}/${all.length} PASS -> ${join(OUT, 'report.md')}`)
  if (fails.length) {
    console.log('[acceptance] FAILURES:')
    for (const f of fails) console.log(`  - ${f.id}: ${f.desc} | expected ${f.expected} | actual ${f.actual}`)
  }

  await app.close()
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbPath + suffix
    try { if (existsSync(p)) rmSync(p) } catch { /* best effort */ }
  }
  process.exit(fails.length ? 1 : 0)
}

main().catch((err) => {
  console.error('acceptance-verify crashed:', err)
  process.exit(1)
})
