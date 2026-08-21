// Resolves EVERY state combination of the Third-party licences modal's
// interactive elements against the REAL built CSS, and asserts that no two
// states of the same element render identically.
//
// CLAUDE.md §0.5: two states that look the same are a bug — hovering a control
// that does not visibly respond tells the reader their pointer is dead. Prose
// cannot check that; this can. The precedent is scripts/check-button-states.mjs,
// check-provenance-states.mjs, check-stage-states.mjs, check-freshness-states.mjs.
//
// Pseudo-classes are rewritten into real classes so the genuine cascade
// (specificity + source order) is exercised, not a devtools override.

import { chromium } from '@playwright/test'
import { readFileSync, readdirSync } from 'node:fs'

const dir = 'out/renderer/assets'
let css = readdirSync(dir)
  .filter((f) => f.startsWith('index-') && f.endsWith('.css'))
  .map((f) => readFileSync(`${dir}/${f}`, 'utf8'))
  .join('\n')

for (const ps of ['hover', 'active', 'focus-visible']) {
  css = css.replaceAll(`:not(:${ps})`, `__KEEP_${ps}__`)
  css = css.replaceAll(`:${ps}`, `.F-${ps}`)
  css = css.replaceAll(`__KEEP_${ps}__`, `:not(:${ps})`)
}

const b = await chromium.launch()
const p = await b.newPage()
await p.setContent(`<style>${css}</style><div id="r"></div>`)

const PROPS = [
  'backgroundColor',
  'borderColor',
  'borderWidth',
  'boxShadow',
  'outlineColor',
  'outlineWidth',
  'color',
  'fontWeight',
  'opacity',
  'transform'
]

const groups = await p.evaluate((PROPS) => {
  const r = document.getElementById('r')
  const read = (el) => {
    const cs = getComputedStyle(el)
    return PROPS.map((k) => cs[k]).join(' | ')
  }

  const out = {}

  // ---- the expandable row HEAD (the primary control) ----
  // Row-level `is-open` and head-level pointer state are independent, so every
  // COMBINATION is checked, not just each axis on its own. `open+hover` looking
  // like plain `open` was the exact collision this technique has caught before.
  const headStates = {
    default: { row: [], head: [] },
    hover: { row: [], head: ['F-hover'] },
    active: { row: [], head: ['F-active', 'F-hover'] },
    'focus-visible': { row: [], head: ['F-focus-visible'] },
    'focus+hover': { row: [], head: ['F-focus-visible', 'F-hover'] },
    open: { row: ['is-open'], head: [] },
    'open+hover': { row: ['is-open'], head: ['F-hover'] },
    'open+active': { row: ['is-open'], head: ['F-active', 'F-hover'] },
    'open+focus': { row: ['is-open'], head: ['F-focus-visible'] }
  }
  out['lic-head'] = {}
  out['lic-row'] = {}
  out['lic-caret'] = {}
  out['lic-name'] = {}
  for (const [name, s] of Object.entries(headStates)) {
    r.innerHTML =
      `<div class="lic-row ${s.row.join(' ')}">` +
      `<button class="lic-head ${s.head.join(' ')}">` +
      `<span class="lic-caret ${s.row.includes('is-open') ? 'open' : ''}">R</span>` +
      `<span class="lic-name">n</span><span class="lic-version mono">1</span>` +
      `<span class="lic-spdx mono">MIT</span></button></div>`
    out['lic-row'][name] = read(r.firstElementChild)
    out['lic-head'][name] = read(r.querySelector('.lic-head'))
    out['lic-caret'][name] = read(r.querySelector('.lic-caret'))
    out['lic-name'][name] = read(r.querySelector('.lic-name'))
  }

  // ---- the SPDX pill: a bundled binary must not look like an npm package ----
  out['lic-spdx'] = {}
  for (const [name, cls] of Object.entries({ npm: '', payload: 'is-payload' })) {
    r.innerHTML = `<span class="lic-spdx mono ${cls}">MIT</span>`
    out['lic-spdx'][name] = read(r.firstElementChild)
  }

  // ---- the copy button, including its transient acknowledgement ----
  out['lic-copy'] = {}
  for (const [name, cls] of Object.entries({
    default: [],
    hover: ['F-hover'],
    active: ['F-active', 'F-hover'],
    'focus-visible': ['F-focus-visible'],
    copied: ['is-copied'],
    'copied+hover': ['is-copied', 'F-hover'],
    'copied+focus': ['is-copied', 'F-focus-visible']
  })) {
    r.innerHTML = `<button class="btn btn-secondary lic-copy ${cls.join(' ')}">c</button>`
    out['lic-copy'][name] = read(r.firstElementChild)
  }

  // ---- the filter input ----
  out['lic-filter'] = {}
  for (const [name, cls] of Object.entries({
    default: [],
    hover: ['F-hover'],
    'focus-visible': ['F-focus-visible'],
    'focus+hover': ['F-focus-visible', 'F-hover']
  })) {
    r.innerHTML = `<input class="lic-filter ${cls.join(' ')}">`
    out['lic-filter'][name] = read(r.firstElementChild)
  }

  // ---- the modal's own ✕ ----
  //
  // In scope because `Modal` AUTO-FOCUSES it on open (ui.tsx), so it is the
  // first thing a keyboard reader lands on in this screen. It is not a `.btn`,
  // so none of the shared button state rules reach it and it had to be styled
  // on its own terms.
  out['modal close'] = {}
  for (const [name, cls] of Object.entries({
    default: [],
    hover: ['F-hover'],
    active: ['F-active', 'F-hover'],
    'focus-visible': ['F-focus-visible'],
    'focus+hover': ['F-focus-visible', 'F-hover']
  })) {
    r.innerHTML = `<div class="modal-head"><button class="btn-icon ${cls.join(' ')}">x</button></div>`
    out['modal close'][name] = read(r.querySelector('.btn-icon'))
  }

  // ---- the note pane ----
  //
  // `.lic-note` is worn by THREE different situations — busy, "upstream ships
  // no text", and "nothing matches your filter" — and only the sentence used to
  // differ. Two of those are settled outcomes and one is work in progress; a
  // reader who cannot tell them apart does not know whether to keep waiting.
  // Checking the class alone would have declared this fine, so the busy variant
  // is resolved with its indicator.
  out['lic-note'] = {}
  for (const [name, cls] of Object.entries({
    note: '',
    busy: 'is-busy',
    'empty result': 'is-empty',
    failed: 'is-failed'
  })) {
    r.innerHTML = `<div class="lic-note mono ${cls}">m</div>`
    out['lic-note'][name] = read(r.firstElementChild)
  }
  // The busy indicator must exist AND move; a note with no indicator is the
  // settled state, so its presence is part of what distinguishes them.
  r.innerHTML = `<div class="lic-note is-busy mono"><span class="lic-spin"></span>m</div>`
  const spin = r.querySelector('.lic-spin')
  out['lic-note']['busy(indicator)'] = read(spin) + ' | ' + getComputedStyle(spin).animationName

  return out
}, PROPS)

await b.close()

// A row's visual identity is the row + head + caret + name TOGETHER: `open`
// differs from `default` partly on the caret's rotation and the name's weight,
// which is exactly the point — the state does not rely on background alone.
const COMPOSITE = { 'expandable row': ['lic-row', 'lic-head', 'lic-caret', 'lic-name'] }

let failures = 0
const report = (label, map) => {
  const seen = new Map()
  for (const [state, sig] of Object.entries(map)) {
    if (seen.has(sig)) {
      console.error(`FAIL  ${label}: "${state}" is identical to "${seen.get(sig)}"`)
      console.error(`        ${sig}`)
      failures++
    } else seen.set(sig, state)
  }
  console.log(`ok    ${label} — ${Object.keys(map).length} states, all distinct`)
}

for (const [label, parts] of Object.entries(COMPOSITE)) {
  const states = Object.keys(groups[parts[0]])
  const merged = {}
  for (const s of states) merged[s] = parts.map((pt) => groups[pt][s]).join(' ‖ ')
  report(label, merged)
}
for (const [el, map] of Object.entries(groups)) {
  if (Object.values(COMPOSITE).some((parts) => parts.includes(el))) continue
  report(`.${el}`, map)
}

// A state must not be inert either: a transition of `all 0s` means it snaps.
const noTransition = await (async () => {
  const b2 = await chromium.launch()
  const p2 = await b2.newPage()
  await p2.setContent(`<style>${css}</style><div id="r"></div>`)
  const bad = await p2.evaluate(() => {
    const r = document.getElementById('r')
    const out = []
    for (const [cls, html] of [
      ['lic-row', '<div class="lic-row"></div>'],
      ['lic-head', '<button class="lic-head"></button>'],
      ['lic-caret', '<span class="lic-caret"></span>'],
      ['lic-filter', '<input class="lic-filter">'],
      ['lic-copy', '<button class="btn btn-secondary lic-copy"></button>']
    ]) {
      r.innerHTML = html
      const d = getComputedStyle(r.firstElementChild).transitionDuration
      if (!d || /^0s(,\s*0s)*$/.test(d)) out.push(`${cls} (${d})`)
    }
    return out
  })
  await b2.close()
  return bad
})()
if (noTransition.length) {
  console.error(`FAIL  these elements snap instead of easing: ${noTransition.join(', ')}`)
  failures++
} else {
  console.log('ok    every interactive element eases rather than snapping')
}

if (failures) {
  console.error(`\n${failures} state collision(s).`)
  process.exit(1)
}
console.log('\nall licence-screen states are mutually distinct and animated.')
