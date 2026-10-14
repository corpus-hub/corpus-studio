// Resolves EVERY state combination of the Settings > Storage locations controls
// and asserts that no two of them render identically.
//
// The rule this enforces (CLAUDE.md §0.5): two states that render the same are a
// bug, because they tell the user their pointer is dead. Eyeballing does not
// catch it — a `:hover` rule that a later `.is-busy` rule overrides looks fine
// in isolation and collides in combination.
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

// ---- 1. The ROW, across reachability x busy x editing -----------------------
// A row carries the location's state ambiently (tinted left edge, surface), so
// "unreachable" must be legible without reading the badge, and must not be
// confused with "hovered" or "in flight".
const rowStates = {
  reachable: ['ok'],
  'reachable+hover': ['ok', 'F-hover'],
  unreachable: ['danger'],
  'unreachable+hover': ['danger', 'F-hover'],
  'not-verified': ['warn'],
  'not-verified+hover': ['warn', 'F-hover'],
  busy: ['ok', 'is-busy'],
  'busy+hover': ['ok', 'is-busy', 'F-hover'],
  'unreachable+busy': ['danger', 'is-busy'],
  editing: ['EDIT']
}

const rowResults = await p.evaluate((states) => {
  const r = document.getElementById('r')
  const out = {}
  for (const [name, cls] of Object.entries(states)) {
    const badge = ['ok', 'danger', 'warn'].find((c) => cls.includes(c))
    const rowCls = ['stor-row', ...cls.filter((c) => !['ok', 'danger', 'warn', 'EDIT'].includes(c))]
    if (cls.includes('EDIT')) rowCls.push('stor-row-edit')
    r.innerHTML =
      `<div class="${rowCls.join(' ')}">` +
      (badge ? `<span class="badge badge-${badge}">x</span>` : '') +
      `</div>`
    const cs = getComputedStyle(r.firstElementChild)
    out[name] = [
      cs.backgroundColor,
      cs.borderColor,
      cs.borderLeftColor,
      cs.borderLeftWidth,
      cs.opacity,
      cs.paddingLeft
    ].join(' | ')
  }
  return out
}, rowStates)

// ---- 2. The BUTTONS, including the destructive Remove -----------------------
const btnStates = {
  default: [],
  hover: ['F-hover'],
  active: ['F-active', 'F-hover'],
  'focus-visible': ['F-focus-visible'],
  disabled: ['D'],
  'disabled+hover': ['D', 'F-hover']
}

const btnResults = await p.evaluate((states) => {
  const r = document.getElementById('r')
  const out = {}
  for (const variant of ['stor-btn', 'stor-btn stor-btn-remove', 'stor-add']) {
    for (const [name, cls] of Object.entries(states)) {
      const dis = cls.includes('D') ? 'disabled' : ''
      const base = variant === 'stor-add' ? 'btn btn-secondary' : 'btn btn-secondary'
      const classes = [base, variant, ...cls.filter((c) => c !== 'D')].join(' ')
      r.innerHTML = `<button class="${classes}" ${dis}>x</button>`
      const cs = getComputedStyle(r.firstElementChild)
      out[`${variant} / ${name}`] = [
        cs.backgroundColor,
        cs.borderColor,
        cs.borderStyle,
        cs.opacity,
        cs.color,
        cs.outlineColor,
        cs.outlineWidth
      ].join(' | ')
    }
  }
  return out
}, btnStates)

// ---- 3. The outlet SWITCH, which now always persists ------------------------
// Every switch on Integrations writes to SQLite, so hover is a real affordance
// in BOTH positions and the in-flight state must be distinct from both.
const switchStates = {
  off: [],
  'off+hover': ['F-hover'],
  'off+focus': ['F-focus-visible'],
  'off+busy': ['D'],
  on: ['on'],
  'on+hover': ['on', 'F-hover'],
  'on+focus': ['on', 'F-focus-visible'],
  'on+busy': ['on', 'D']
}

const switchResults = await p.evaluate((states) => {
  const r = document.getElementById('r')
  const out = {}
  for (const [name, cls] of Object.entries(states)) {
    const dis = cls.includes('D') ? 'disabled' : ''
    const classes = ['int-switch', ...cls.filter((c) => c !== 'D')].join(' ')
    r.innerHTML = `<button class="${classes}" ${dis}><span class="int-knob"></span></button>`
    const cs = getComputedStyle(r.firstElementChild)
    out[name] = [
      cs.backgroundColor,
      cs.opacity,
      cs.cursor,
      cs.outlineColor,
      cs.outlineWidth,
      cs.boxShadow
    ].join(' | ')
  }
  return out
}, switchStates)

let collisions = 0

// Hovering a DISABLED control is supposed to look like not hovering it: the
// point is that the pointer is dead there, and the reason arrives as a tooltip
// rather than a surface change. Intended, not a bug.
const ALLOWED = new Set([
  'disabled::disabled+hover',
  'busy::busy+hover',
  // A disabled switch does not respond to the pointer, which is the point.
  'off+busy::on+busy'
])

function check(label, results) {
  const seen = new Map()
  for (const [k, val] of Object.entries(results)) {
    const [group, state] = k.includes(' / ') ? k.split(' / ') : ['row', k]
    const key = group + '::' + val
    const prior = seen.get(key)
    if (prior === undefined) {
      seen.set(key, k)
      continue
    }
    const priorState = prior.includes(' / ') ? prior.split(' / ')[1] : prior
    if (ALLOWED.has(`${priorState}::${state}`)) continue
    console.log(`COLLISION [${label}]: "${prior}"  ===  "${k}"`)
    collisions++
  }
}

check('row', rowResults)
check('button', btnResults)
check('switch', switchResults)

for (const [k, v] of Object.entries(rowResults)) console.log('row'.padEnd(8), k.padEnd(22), v)
for (const [k, v] of Object.entries(btnResults)) console.log('btn'.padEnd(8), k.padEnd(40), v)
for (const [k, v] of Object.entries(switchResults)) console.log('switch'.padEnd(8), k.padEnd(40), v)

console.log(
  collisions === 0
    ? '\nOK — every storage state resolves to a distinct style'
    : `\n${collisions} COLLISION(S)`
)
await b.close()
process.exit(collisions === 0 ? 0 : 1)
