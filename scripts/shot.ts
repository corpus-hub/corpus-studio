/*
 * Screenshot ANY screen, on demand, without touching the running app.
 *
 * The problem this solves: `scripts/relaunch.sh` always reopens on whatever
 * route the app defaults to, so verifying a change on Extraction or References
 * meant asking a human to navigate there first. This drives its own headless
 * instance to the exact screen instead.
 *
 *   npx tsx scripts/shot.ts extraction
 *   npx tsx scripts/shot.ts extraction --schema 2
 *   npx tsx scripts/shot.ts references --out /tmp/refs.png
 *   npx tsx scripts/shot.ts ingest --tab queue
 *   npx tsx scripts/shot.ts references --click-at 940,520   # canvas: hit a drawn line
 *   npx tsx scripts/shot.ts extraction --hover '[data-testid^="extraction-subrow-"]'
 *   npx tsx scripts/shot.ts ingest --tab queue --type '[data-testid="queue-search-input"]' --text kemp
 *
 * Reads the REAL user DB by default so the screenshot shows the same data the
 * user is looking at; pass --fresh to seed an isolated one instead.
 *
 * IMPORTANT: this launches its OWN instance. It verifies the BUILD, not the
 * window the user has open — those diverge the moment you rebuild without
 * relaunching, and then the screenshots look right while the user sees nothing
 * change. Always run `scripts/relaunch.sh` SEPARATELY after a build the user is
 * meant to look at.
 *
 * Do NOT relaunch from inside this script: it runs under `xvfb-run`, so the app
 * it spawned inherited the virtual display and died with "Failed to shutdown",
 * leaving the user with no window at all.
 *
 * Shoot at the user's REAL viewport (the 1920x1080 default). Verifying at a
 * narrower size produced "fixed" layouts that still overflowed for them.
 *
 * `--hover`/`--click` apply a state before the shot, because a state described
 * in prose is not a state that was checked.
 */
import { _electron as electron, type Page } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'

const ROOT = resolve(__dirname, '..')
const MAIN = resolve(ROOT, 'out', 'main', 'index.js')
const ELECTRON_BIN = resolve(ROOT, 'node_modules', '.bin', 'electron')
const USER_DB = resolve(homedir(), '.config', 'corpus-studio', 'corpus.sqlite')

/** Screens reachable from the in-project sidebar, by their nav testid suffix. */
const IN_PROJECT = new Set([
  'graph',
  'references',
  'ranking',
  'extraction',
  'review',
  'dossier',
  'integrations',
  'ingest'
])

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const has = (name: string): boolean => process.argv.includes(`--${name}`)

async function main(): Promise<void> {
  const screen = process.argv[2] ?? 'extraction'
  const out = arg('out') ?? resolve(ROOT, 'tmp', 'shots', `${screen}.png`)
  // Defaults MATCH the user's real window. Verifying at a narrower viewport
  // than they actually use produced "fixed" layouts that still overflowed for
  // them — the screenshot has to be of the thing being judged.
  const width = Number(arg('width') ?? 1920)
  const height = Number(arg('height') ?? 1080)
  mkdirSync(dirname(out), { recursive: true })

  // A fresh DB is isolated and reproducible; the real one shows what the user
  // actually sees. Default to the real one — that is the point of this tool.
  //
  // `--db <path>` shoots a SPECIFIC database, for states the user's own library
  // does not currently contain (an OCR'd scan, a partly embedded corpus). Those
  // otherwise cannot be photographed at all, and a state described in prose is
  // not a state that was checked.
  let dbPath = arg('db') ?? USER_DB
  if (has('fresh')) {
    dbPath = resolve(ROOT, 'test-results', 'db', `shot-${randomUUID()}.sqlite`)
    mkdirSync(dirname(dbPath), { recursive: true })
    execFileSync(ELECTRON_BIN, ['--import', 'tsx', 'scripts/run-seed.ts', '--fresh'], {
      cwd: ROOT,
      stdio: 'pipe',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CORPUS_DB_PATH: dbPath }
    })
  } else {
    // Photograph a SNAPSHOT of the chosen database, never the file itself.
    //
    // This spawns a full second Electron main, which opens its database
    // read-write and migrates it. Pointed at the user's live corpus while the
    // app was also open, that is precisely the two-writers-plus-DDL situation
    // that corrupted the file and cost 33 analysis runs. The single-writer lock
    // would now refuse the launch outright — correct, but it would also make
    // this tool unusable whenever the app is running, which is most of the time.
    //
    // `VACUUM INTO` takes a transactionally consistent copy through a READ-ONLY
    // connection, so it is safe with the app open, and the screenshot is then of
    // a file nothing else can touch mid-render.
    const source = dbPath
    const snap = resolve(ROOT, 'test-results', 'db', `shot-snapshot-${randomUUID()}.sqlite`)
    mkdirSync(dirname(snap), { recursive: true })
    execFileSync(ELECTRON_BIN, ['--import', 'tsx', 'scripts/snapshot-db.ts', source, snap], {
      cwd: ROOT,
      stdio: 'pipe',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })
    dbPath = snap
  }

  const app = await electron.launch({
    args: [MAIN],
    cwd: ROOT,
    env: { ...process.env, CORPUS_DB_PATH: dbPath, NODE_ENV: 'production', CORPUS_NO_CLOSE_GUARD: '1' }
  })
  const win: Page = await app.firstWindow()
  await win.setViewportSize({ width, height })
  await win.waitForSelector('[data-testid="sidebar"]', { timeout: 20000 })

  // Settings is a MODAL rather than a route, so it has no nav destination and no
  // `screen-*` testid. It is still a surface worth photographing, so it is named
  // like a screen here and reached by opening the sidebar's Settings button.
  if (screen === 'settings') {
    await win.click('[data-testid="nav-integrations-settings"]')
    await win.waitForSelector('[data-testid="settings-modal"]', { timeout: 15000 })
  } else if (screen === 'setup') {
    // The creation questionnaire has no sidebar destination — while it is open
    // every project tab is inert, which is the whole point of it. So it is
    // reached the way a user reaches it: by creating a project. That leaves a
    // half-set-up project behind in whatever DB this ran against, which is why
    // it is only ever pointed at the snapshot (the default) and not `--live`.
    await win.click('[data-testid="new-project-card"], [data-testid="first-run-create"]')
    await win.waitForSelector('[data-testid="new-project-wizard"]', { timeout: 15000 })
    await win.fill('[data-testid="wizard-name"]', arg('name') ?? 'Kemp eliminase productivity')
    await win.click('[data-testid="wizard-submit"]')
    await win.waitForSelector('[data-testid="screen-setup"]', { timeout: 20000 })
    // `--answered` fills the two required boxes, which is the only way to see
    // the papers section unlocked and the build step live. Without it the shot
    // shows the page as it opens, which is the other state worth having.
    if (has('answered')) {
      await win.fill('[data-testid="setup-goal"]', 'Explore kemp eliminase chemistry and how mutations affect productivity')
      await win.locator('[data-testid="setup-goal"]').blur()
      await win.fill('[data-testid="setup-question-0"]', 'What is the kinetic rate of the reaction?')
      await win.locator('[data-testid="setup-question-0"]').blur()
      await win.fill('[data-testid="setup-question-1"]', 'Which mutant is the most productive?')
      await win.locator('[data-testid="setup-question-1"]').blur()
    }
  } else if (screen === 'paper') {
    // Paper detail is not a sidebar destination — it is always reached FROM a
    // list, which is what makes it a detail view. `--work <id>` picks which
    // paper, because the states worth photographing (a review with 500 citation
    // contexts, a paper with no PDF) live on specific rows and the first row is
    // not usually one of them.
    await win.locator('[data-testid^="project-card-"]').first().click()
    await win.waitForSelector('[data-testid="screen-graph"]', { timeout: 15000 })
    await win.click('[data-testid="nav-ranking"]')
    await win.waitForSelector('[data-testid="screen-ranking"]', { timeout: 15000 })
    const workId = arg('work')
    const row = workId
      ? win.locator(`[data-testid="ranking-row-${workId}"] .rank-title`)
      : win.locator('[data-testid^="ranking-row-"] .rank-title').first()
    await row.scrollIntoViewIfNeeded()
    await row.click()
    await win.waitForSelector('[data-testid="screen-paper"]', { timeout: 20000 })
  } else if (screen !== 'projects') {
    if (IN_PROJECT.has(screen)) {
      // Every in-project screen is behind a project card; opening one lands on
      // the Connectome, from which the sidebar reaches the rest.
      await win.locator('[data-testid^="project-card-"]').first().click()
      await win.waitForSelector('[data-testid="screen-graph"]', { timeout: 15000 })
    }
    if (screen !== 'graph') {
      await win.click(`[data-testid="nav-${screen}"]`)
      // Most screens are `screen-<name>`, but References is `references-screen`.
      // Accepting either beats failing on a screen that rendered perfectly well.
      await win.waitForSelector(
        `[data-testid="screen-${screen}"], [data-testid="${screen}-screen"]`,
        { timeout: 15000 }
      )
    }
  }

  // Optional drill-downs, so a screenshot can show a specific sub-state rather
  // than only whatever a screen opens on.
  const schema = arg('schema')
  if (schema) {
    await win.click(`[data-testid="extraction-schema-tab-${schema}"]`)
  }
  const tab = arg('tab')
  if (tab) {
    await win.click(`[data-testid="ingest-tab-${tab}"]`)
  }
  // `--click`, `--press` and `--type`/`--text` are applied IN THE ORDER THEY
  // WERE WRITTEN, not in a fixed phase order.
  //
  // Some states are only reachable through a SEQUENCE — Settings → About →
  // Third-party licences is two clicks deep — and some interleave the kinds:
  // the in-paper find bar is Ctrl+F, then type, then Tab, then click a result
  // that did not exist until the three steps before it. Running all the clicks
  // first (which is what this did) makes the last of those impossible, and it
  // fails as a missing selector, which reads as a broken app rather than a
  // mis-ordered script.
  //
  // `--type` consumes the `--text` that follows it, for the same reason the two
  // are separate flags at all: a CSS attribute selector contains '=' itself, so
  // any single-argument split cuts the selector in half.
  //
  // `--sleep <ms>` is a step too, because `--settle` runs after ALL of them: a
  // control that only exists once an async query has answered cannot be clicked
  // by a flag that waits afterwards, and it fails as a missing selector.
  // `--click-at <x,y>` clicks VIEWPORT COORDINATES rather than a selector.
  // Canvas screens draw their own contents — the reference tree's citation
  // curves and the connectome's nodes are pixels, not elements — so there is no
  // locator to aim at and a selector click can only ever hit the canvas centre.
  type Step =
    | { kind: 'click'; sel: string }
    | { kind: 'clickAt'; x: number; y: number }
    | { kind: 'wheel'; x: number; y: number; dy: number; dx: number }
    | { kind: 'moveTo'; x: number; y: number }
    | { kind: 'dragTo'; fromX: number; fromY: number; toX: number; toY: number }
    | { kind: 'press'; key: string }
    | { kind: 'sleep'; ms: number }
    | { kind: 'type'; sel: string; text: string }
  const steps: Step[] = []
  for (let i = 0; i < process.argv.length; i++) {
    const a = process.argv[i]
    const v = process.argv[i + 1]
    if (!v) continue
    if (a === '--click') steps.push({ kind: 'click', sel: v })
    else if (a === '--click-at') {
      const [x, y] = v.split(',').map(Number)
      steps.push({ kind: 'clickAt', x, y })
    } else if (a === '--move-to') {
      // Hover a POINT. Canvas screens track the pointer themselves, so a
      // hover state on a drawn card cannot be reached by a selector.
      const [x, y] = v.split(',').map(Number)
      steps.push({ kind: 'moveTo', x, y })
    } else if (a === '--drag-to') {
      // `x1,y1,x2,y2` — press at the first point, move to the second, and STOP
      // with the button still down. The whole point is to photograph a gesture
      // MID-FLIGHT: a tab being dragged, the insertion caret, the detach hint.
      // Those states exist only while the pointer is held, so no sequence of
      // clicks and hovers can reach them.
      const [fromX, fromY, toX, toY] = v.split(',').map(Number)
      steps.push({ kind: 'dragTo', fromX, fromY, toX, toY })
    } else if (a === '--wheel') {
      // `x,y,dy[,dx]` — a wheel event at a point. Canvas screens zoom on the
      // wheel, and a card drawn at 9% is a few pixels wide: nothing on it can
      // be aimed at until the view is zoomed the way a user would zoom it.
      //
      // `dx` is optional and defaults to 0. It exists because a pane frozen on
      // BOTH axes — a table with a sticky header and a sticky first column —
      // only reveals whether its two frozen edges stack correctly at the corner
      // where they cross, which is unreachable by scrolling one axis.
      const [x, y, dy, dx] = v.split(',').map(Number)
      steps.push({ kind: 'wheel', x, y, dy, dx: dx || 0 })
    }
    else if (a === '--sleep') steps.push({ kind: 'sleep', ms: Number(v) })
    else if (a === '--press') steps.push({ kind: 'press', key: v })
    else if (a === '--type') {
      const ti = process.argv.indexOf('--text', i)
      steps.push({ kind: 'type', sel: v, text: ti >= 0 ? (process.argv[ti + 1] ?? '') : '' })
    }
  }
  for (const step of steps) {
    if (step.kind === 'click') {
      await win.locator(step.sel).first().click()
      await win.waitForTimeout(250)
    } else if (step.kind === 'clickAt') {
      await win.mouse.click(step.x, step.y)
      await win.waitForTimeout(250)
    } else if (step.kind === 'moveTo') {
      await win.mouse.move(step.x, step.y)
      await win.waitForTimeout(400)
    } else if (step.kind === 'dragTo') {
      await win.mouse.move(step.fromX, step.fromY)
      await win.mouse.down()
      // In STEPS, not one jump: a drag handler that ignores the first movement
      // below its slop threshold would never see a second one, and the gesture
      // would read as a click.
      const n = 8
      for (let i = 1; i <= n; i++) {
        await win.mouse.move(
          step.fromX + ((step.toX - step.fromX) * i) / n,
          step.fromY + ((step.toY - step.fromY) * i) / n
        )
      }
      await win.waitForTimeout(300)
      // Deliberately NOT released — see the flag's own note.
    } else if (step.kind === 'wheel') {
      await win.mouse.move(step.x, step.y)
      await win.mouse.wheel(step.dx, step.dy)
      // Zoom is animated/eased on these screens; let it settle before the next
      // step tries to aim at something.
      await win.waitForTimeout(500)
    } else if (step.kind === 'sleep') {
      await win.waitForTimeout(step.ms)
    } else if (step.kind === 'press') {
      await win.keyboard.press(step.key)
      // A keystroke may mount the element the next step is meant for.
      await win.waitForTimeout(300)
    } else {
      // `fill` REPLACES the value in one event. That is right for a filter box,
      // but a field whose behaviour depends on FOCUS — the find bar swallows Tab
      // only while its input holds it — needs the focus that typing implies, so
      // the field is clicked first either way.
      await win.locator(step.sel).first().click()
      await win.locator(step.sel).first().fill(step.text)
      // `--submit` presses Enter afterwards, for the searches that run on submit
      // rather than on every keystroke. Without it those fields can be filled
      // but never queried, so the shot shows a typed box and no result.
      if (has('submit')) await win.locator(step.sel).first().press('Enter')
      await win.waitForTimeout(400)
    }
  }

  // Park the pointer somewhere inert BEFORE settling: the clicks above leave it
  // resting on whatever they hit, which pops that element's tooltip into every
  // screenshot and hides the thing being verified.
  //
  // Unless `--move-to` was asked for. That flag exists to HOLD the pointer on a
  // canvas card, and parking silently threw the hover away — so every shot
  // taken to check a hover state showed the resting state instead, and the
  // state read as "verified, not reproducible".
  // A held gesture must not be disturbed by the pointer being parked.
  const held = steps.some((s) => s.kind === 'moveTo' || s.kind === 'dragTo')
  if (!held) await win.mouse.move(2, 2)
  await win.waitForTimeout(Number(arg('settle') ?? 1200))

  // Hover LAST: any click above would move the pointer off the target.
  const hover = arg('hover')
  if (hover) {
    await win.locator(hover).first().hover()
    await win.waitForTimeout(400)
  }

  /**
   * `--measure <selector>` — the RESOLVED box and layout of one element, to
   * stderr, beside the screenshot.
   *
   * A picture shows that something is wrong; it cannot say why. This element's
   * stage label and spinner stacked into two lines, and three plausible
   * theories about flex sizing were each wrong — the actual cause was a
   * `flex-direction: column` inherited from a DIFFERENT rule 400 lines away
   * that happened to share the class name, which nothing visible could have
   * revealed. Prints the element's own computed layout, its parent's, and its
   * children's widths, which is enough to tell "my rule did not apply" from
   * "my rule applied and is wrong".
   *
   * Written as a STRING rather than a function because tsx's transform injects
   * a `__name` helper into any function passed to `evaluate`, and that helper
   * does not exist in the page.
   */
  const measure = arg('measure')
  if (measure) {
    const info = await win.evaluate(
      'JSON.stringify((() => {' +
        `const el = document.querySelector(${JSON.stringify(measure)});` +
        'if (!el) return "NOT FOUND";' +
        'const b = el.getBoundingClientRect(); const c = getComputedStyle(el);' +
        'const p = el.parentElement; const pb = p ? p.getBoundingClientRect() : null; const pc = p ? getComputedStyle(p) : null;' +
        'return { self: { w: Math.round(b.width), h: Math.round(b.height), disp: c.display, dir: c.flexDirection, wrap: c.flexWrap, flex: c.flex, pos: c.position },' +
        ' parent: p ? { cls: p.className, w: Math.round(pb.width), disp: pc.display, dir: pc.flexDirection, align: pc.alignItems } : null,' +
        ' kids: Array.prototype.map.call(el.children, (k) => { const kb = k.getBoundingClientRect(); return { cls: k.className, w: Math.round(kb.width), h: Math.round(kb.height) }; }) };' +
        '})(), null, 1)'
    )
    // stderr, so `--measure` never pollutes the path on stdout that callers read.
    console.error('[measure]', info)
  }

  await win.screenshot({ path: out })
  // The only line stdout needs: the caller wants the path.
  console.log(out)
  await app.close()
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
