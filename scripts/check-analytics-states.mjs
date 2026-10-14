// Resolves EVERY state combination of the Settings > Analytics controls and
// asserts that no two of them render identically.
//
// The rule this enforces (CLAUDE.md §0.5): two states that render the same are a
// bug, because they tell the user their pointer is dead. Eyeballing does not
// catch it — a `:hover` rule that a later `:disabled` rule overrides looks fine
// in isolation and collides in combination.
//
// The chart's two BANDS are checked here too. They are the one pair in this pane
// that must not be told apart by hue alone: input and output are both drawn from
// the accent ramp, so if the only difference between them were colour the stack
// would be unreadable to a colourblind reader and in greyscale.
//
// Pseudo-classes are rewritten into real classes so the GENUINE cascade
// (specificity + source order) is exercised, rather than a devtools override.
import { chromium } from '@playwright/test'
import { readFileSync, readdirSync } from 'node:fs'

const dir = 'out/renderer/assets'
let css = readdirSync(dir)
  .filter((f) => f.startsWith('index-') && f.endsWith('.css'))
  .map((f) => readFileSync(`${dir}/${f}`, 'utf8'))
  .join('\n')

for (const ps of ['hover', 'active', 'focus-visible', 'focus']) {
  css = css.replaceAll(`:not(:${ps})`, `__KEEP_${ps}__`)
  css = css.replaceAll(`:${ps}`, `.F-${ps}`)
  css = css.replaceAll(`__KEEP_${ps}__`, `:not(:${ps})`)
}

const b = await chromium.launch()
const p = await b.newPage()
await p.setContent(`<style>${css}</style><div id="r"></div>`)

let collisions = 0

// ---- 1. The date inputs and the model select --------------------------------
// `disabled` is a real attribute rather than a class, because that is how the
// component renders it and `:disabled` does not match a class.
const fieldStates = {
  default: [],
  hover: ['F-hover'],
  'focus-visible': ['F-focus-visible'],
  active: ['F-active'],
  disabled: ['DISABLED'],
  // The combination that matters: a disabled control the pointer is over must
  // still look disabled, not hovered.
  'disabled+hover': ['DISABLED', 'F-hover']
}

const dateResults = await p.evaluate((states) => {
  const r = document.getElementById('r')
  const out = {}
  for (const [name, cls] of Object.entries(states)) {
    const dis = cls.includes('DISABLED')
    const c = ['input', 'tok-date', ...cls.filter((x) => x !== 'DISABLED')]
    r.innerHTML = `<input class="${c.join(' ')}" ${dis ? 'disabled' : ''}>`
    const cs = getComputedStyle(r.firstElementChild)
    out[name] = [
      cs.backgroundColor,
      cs.borderColor,
      cs.borderStyle,
      cs.boxShadow,
      cs.opacity,
      cs.color
    ].join(' | ')
  }
  return out
}, fieldStates)

// The model dropdown is the shared `.sel-trigger` listbox, not a native select:
// a BUTTON, disabled through `aria-disabled` (so it keeps the tooltip that says
// why it is inert), and carrying `open` as a state of its own via
// `aria-expanded`. Enumerated here in the shape it actually renders, because a
// check written against markup the app no longer emits proves nothing.
const selectStates = {
  ...fieldStates,
  disabled: ['is-disabled'],
  'disabled+hover': ['is-disabled', 'F-hover'],
  open: ['OPEN'],
  'open+hover': ['OPEN', 'F-hover']
}

const selectResults = await p.evaluate((states) => {
  const r = document.getElementById('r')
  const out = {}
  for (const [name, cls] of Object.entries(states)) {
    const open = cls.includes('OPEN')
    const c = ['sel-trigger', 'tok-select', ...cls.filter((x) => x !== 'OPEN')]
    r.innerHTML = `<button class="${c.join(' ')}" aria-expanded="${open}"><span class="sel-value">x</span></button>`
    const cs = getComputedStyle(r.firstElementChild)
    out[name] = [
      cs.backgroundColor,
      cs.borderColor,
      cs.borderStyle,
      cs.boxShadow,
      cs.opacity,
      cs.color
    ].join(' | ')
  }
  return out
}, selectStates)

// ---- 2. The two chart bands, and their legend swatches ----------------------
// Compared on fill, stroke AND dash so a difference that is ONLY hue fails.
const bandResults = await p.evaluate(() => {
  const r = document.getElementById('r')
  const out = {}
  for (const band of ['tok-band-in', 'tok-band-out']) {
    r.innerHTML = `<svg><path class="tok-band ${band}"></path></svg>`
    const cs = getComputedStyle(r.querySelector('path'))
    out[band] = [cs.fill, cs.fillOpacity, cs.stroke, cs.strokeDasharray].join(' | ')
  }
  for (const sw of ['tok-swatch-in', 'tok-swatch-out']) {
    r.innerHTML = `<span class="tok-swatch ${sw}"></span>`
    const cs = getComputedStyle(r.firstElementChild)
    out[sw] = [cs.backgroundColor, cs.borderStyle, cs.borderColor].join(' | ')
  }
  return out
})

// A band pair differing ONLY in colour passes the equality test below while
// still failing the rule, so the dash pattern is asserted explicitly.
const inDash = bandResults['tok-band-in'].split(' | ')[3]
const outDash = bandResults['tok-band-out'].split(' | ')[3]
if (inDash === outDash) {
  console.log(
    `COLOUR-ONLY [band]: input and output share stroke-dasharray "${inDash}" — ` +
      'the two bands would be distinguishable by hue alone'
  )
  collisions++
}
const swInStyle = bandResults['tok-swatch-in'].split(' | ')[1]
const swOutStyle = bandResults['tok-swatch-out'].split(' | ')[1]
if (swInStyle === swOutStyle) {
  console.log(
    `COLOUR-ONLY [swatch]: both legend swatches use border-style "${swInStyle}" — ` +
      'the legend would be distinguishable by hue alone'
  )
  collisions++
}

const ALLOWED = new Set([
  // A disabled control does not respond to the pointer, which is the POINT: it
  // says "this does nothing" and explains itself through `data-tip` instead.
  // Reacting to hover would promise an interaction that is not available.
  'disabled::disabled+hover'
])

function check(label, results) {
  const seen = new Map()
  for (const [k, val] of Object.entries(results)) {
    const prior = seen.get(val)
    if (prior === undefined) {
      seen.set(val, k)
      continue
    }
    if (ALLOWED.has(`${prior}::${k}`)) continue
    console.log(`COLLISION [${label}]: "${prior}"  ===  "${k}"`)
    collisions++
  }
}

check('date', dateResults)
check('select', selectResults)
check('band', bandResults)

for (const [k, v] of Object.entries(dateResults)) console.log('date'.padEnd(8), k.padEnd(18), v)
for (const [k, v] of Object.entries(selectResults)) console.log('select'.padEnd(8), k.padEnd(18), v)
for (const [k, v] of Object.entries(bandResults)) console.log('band'.padEnd(8), k.padEnd(18), v)

console.log(
  collisions === 0
    ? '\nOK — every analytics state resolves to a distinct style'
    : `\n${collisions} COLLISION(S)`
)
await b.close()
process.exit(collisions === 0 ? 0 : 1)
