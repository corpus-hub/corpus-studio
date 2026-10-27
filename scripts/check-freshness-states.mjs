// Resolves the computed style of EVERY freshness state × interaction and
// asserts no two render identically. A state that renders the same as another
// state is a lie told to the reader: pointing at an "unproven" verdict and
// having it settle into the "unchanged" treatment is exactly the collision that
// this repo has shipped before (superseded+hover === current).
//
// Reads the BUILT css so the real cascade (specificity + source order across
// styles.css and paper.css) is what gets exercised, not a hand-picked subset.
// Pseudo-classes are rewritten into real classes for the same reason.
import { chromium } from '@playwright/test'
import { readFileSync, readdirSync, statSync } from 'node:fs'

const dir = 'out/renderer/assets'
const built = readdirSync(dir).filter((f) => f.startsWith('index-') && f.endsWith('.css'))
let css = built.map((f) => readFileSync(`${dir}/${f}`, 'utf8')).join('\n')

// A build older than the source it is meant to prove would let this script pass
// on CSS that no longer exists — the same "verified a stale build" failure the
// screenshot tooling has hit before. Refuse rather than reassure.
const SOURCES = ['src/renderer/styles.css', 'src/renderer/styles/paper.css']
const newestSource = Math.max(...SOURCES.map((f) => statSync(f).mtimeMs))
const oldestBuilt = Math.min(...built.map((f) => statSync(`${dir}/${f}`).mtimeMs))
if (built.length === 0 || newestSource > oldestBuilt) {
  console.log(`FAIL: ${dir} predates the stylesheets it should contain — run \`npm run build\` first`)
  process.exit(1)
}

for (const ps of ['hover', 'active', 'focus-visible']) {
  css = css.replaceAll(`:not(:${ps})`, `__KEEP_${ps}__`)
  css = css.replaceAll(`:${ps}`, `.F-${ps}`)
  css = css.replaceAll(`__KEEP_${ps}__`, `:not(:${ps})`)
}

const VERDICTS = ['current', 'stale', 'partially-stale', 'unknown']
// `active` is listed even though the pill is a tooltip target with no onClick:
// including it asserts that the no-press treatment is DELIBERATE. If an :active
// rule is ever added without a matching press affordance elsewhere, this row
// stops matching `default` and the change has to be justified.
const INTERACTIONS = {
  default: [],
  hover: ['F-hover'],
  active: ['F-active', 'F-hover'],
  focus: ['F-focus-visible'],
  'focus+hover': ['F-focus-visible', 'F-hover']
}
// A retired run damps the banner. The four verdicts must STAY distinct inside
// that damping, or a superseded card stops reporting which input moved.
const SHELLS = { live: '', superseded: 'pv-prov-superseded' }

const CONTAINER_PROPS = ['border-top-color', 'border-top-width', 'border-top-style',
  'border-left-width', 'border-left-style', 'background-color', 'filter', 'opacity']
const PILL_PROPS = ['background-color', 'border-top-color', 'border-top-style', 'border-top-width',
  'border-left-color', 'border-left-style', 'color', 'font-weight', 'font-style', 'font-size',
  'text-decoration-line', 'letter-spacing', 'box-shadow', 'outline-color', 'outline-width']

const b = await chromium.launch()
const p = await b.newPage()
await p.setContent(`<style>${css}</style><div id="r"></div>`)

const results = await p.evaluate(
  ({ VERDICTS, INTERACTIONS, SHELLS, CONTAINER_PROPS, PILL_PROPS }) => {
    const r = document.getElementById('r')
    const out = {}
    for (const [shellName, shellCls] of Object.entries(SHELLS)) {
      for (const v of VERDICTS) {
        for (const [iName, iCls] of Object.entries(INTERACTIONS)) {
          r.innerHTML = `<div class="pv-prov ${shellCls}">
            <div class="pv-fresh is-${v}">
              <span class="pv-fresh-pill mono ${iCls.join(' ')}" id="pill">
                <span class="pv-fresh-glyph">g</span>label</span>
            </div></div>`
          const box = r.querySelector('.pv-fresh')
          const pill = r.querySelector('#pill')
          const cb = getComputedStyle(box)
          const cp = getComputedStyle(pill)
          out[`${shellName}/${v}/${iName}`] =
            CONTAINER_PROPS.map((k) => `${k}=${cb.getPropertyValue(k)}`).join('|') +
            '||' +
            PILL_PROPS.map((k) => `${k}=${cp.getPropertyValue(k)}`).join('|')
        }
      }
    }
    // Per-input rows: four verdicts, each of which must be distinguishable on
    // its own row without reference to the pill above it.
    for (const v of [...VERDICTS.filter((x) => x !== 'partially-stale'), 'not-applicable']) {
      r.innerHTML = `<li class="pv-fresh-item is-${v}">
        <span class="pv-fresh-item-glyph" id="g">g</span>
        <span class="pv-fresh-item-label mono" id="l">l</span></li>`
      const item = getComputedStyle(r.querySelector('.pv-fresh-item'))
      const g = getComputedStyle(r.querySelector('#g'))
      const l = getComputedStyle(r.querySelector('#l'))
      out[`item/${v}`] = [
        `op=${item.opacity}`,
        `g.color=${g.color}`, `g.weight=${g.fontWeight}`, `g.style=${g.fontStyle}`,
        `l.color=${l.color}`, `l.weight=${l.fontWeight}`, `l.style=${l.fontStyle}`
      ].join('|')
    }
    return out
  },
  { VERDICTS, INTERACTIONS, SHELLS, CONTAINER_PROPS, PILL_PROPS }
)
await b.close()

// Collisions are only meaningful WITHIN a comparable family: a pill state and a
// list-row state are never seen side by side, so comparing them proves nothing.
const families = { banner: [], item: [] }
for (const [name, style] of Object.entries(results)) {
  families[name.startsWith('item/') ? 'item' : 'banner'].push([name, style])
}

let collisions = 0
for (const [fam, entries] of Object.entries(families)) {
  const seen = new Map()
  for (const [name, style] of entries) {
    const prior = seen.get(style)
    if (prior !== undefined) {
      // A pressed state is only required to differ where the control is
      // pressable. This pill is a tooltip target (cursor:help, no onClick), so
      // `active` matching its own `hover` is the intended treatment, not a
      // collision — but it must still match ONLY its own hover.
      if (name.replace('/active', '/hover') === prior) continue
      collisions++
      console.log(`COLLISION [${fam}] ${prior}  ===  ${name}`)
    } else seen.set(style, name)
  }
  console.log(`${fam}: ${entries.length} states, ${seen.size} distinct`)
}

// The glyphs live in TSX, not CSS, and they are the one differentiator that
// survives grayscale intact — so they are asserted here rather than assumed.
// Without this, two verdicts sharing a glyph would pass on a border difference
// alone, which is the weakest of the signals.
const tsx = readFileSync('src/renderer/screens/PaperScreen.tsx', 'utf8')
const region = (start, end) => {
  const a = tsx.indexOf(start)
  if (a < 0) throw new Error(`check-freshness-states: ${start} not found in PaperScreen.tsx`)
  const b = tsx.indexOf(end, a)
  return tsx.slice(a, b < 0 ? undefined : b)
}
for (const [table, text, pattern] of [
  ['FRESHNESS_META', region('const FRESHNESS_META', 'function FreshnessBanner'), /glyph: '(.+?)'/g],
  ['INPUT_GLYPH', region('const INPUT_GLYPH', '\n}'), /: '(.+?)'/g]
]) {
  const glyphs = [...text.matchAll(pattern)].map((m) => m[1])
  const uniq = new Set(glyphs)
  console.log(`${table}: ${glyphs.length} glyphs, ${uniq.size} distinct — ${glyphs.join(' ')}`)
  if (glyphs.length === 0 || uniq.size !== glyphs.length) {
    collisions++
    console.log(`COLLISION [${table}] two verdicts share a glyph`)
  }
}

if (collisions > 0) {
  console.log(`\nFAIL: ${collisions} state collision(s)`)
  process.exit(1)
}
console.log('\nOK: every freshness state is visually distinct from every other')
