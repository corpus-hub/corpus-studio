// Resolves the computed style of EVERY state of the Settings "Show additional
// provenance" switch, of the region it reveals on a paper, and of every caveat
// that survives that region being collapsed — then asserts no two states inside
// a comparable family render identically.
//
// Two states that look the same are a lie told to the reader: hovering an
// already-on switch and seeing nothing move says the pointer is dead, and a
// "checks failed" badge that settles into the "output ≠ schema" treatment tells
// a scientist the wrong thing about which part of the run broke.
//
// Reads the BUILT css so the real cascade is exercised: the switch is styled in
// styles.css and the reveal/caveats in the @imported paper.css, and only the
// built bundle puts them in the order the browser actually sees.
import { chromium } from '@playwright/test'
import { readFileSync, readdirSync, statSync } from 'node:fs'

const dir = 'out/renderer/assets'
const built = readdirSync(dir).filter((f) => f.startsWith('index-') && f.endsWith('.css'))
let css = built.map((f) => readFileSync(`${dir}/${f}`, 'utf8')).join('\n')

// A build older than the source it is meant to prove would let this pass on CSS
// that no longer exists. Refuse rather than reassure.
const SOURCES = [
  'src/renderer/styles.css',
  'src/renderer/styles/paper.css',
  'src/renderer/components/settings/ReadingPrefs.tsx'
]
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

const INTERACTIONS = {
  default: [],
  hover: ['F-hover'],
  active: ['F-active', 'F-hover'],
  focus: ['F-focus-visible'],
  'focus+hover': ['F-focus-visible', 'F-hover']
}

// All FOUR edges, not just the top: a state that differs only on its right or
// bottom border is a real difference, and sampling one edge would call it a
// collision (or, worse, let a genuine collision through).
const EDGES = ['top', 'right', 'bottom', 'left'].flatMap((e) => [
  `border-${e}-color`, `border-${e}-width`, `border-${e}-style`
])
const SWITCH_PROPS = [
  'background-color', 'color', 'font-weight', 'font-size', 'opacity', 'filter',
  'letter-spacing', 'transform', ...EDGES,
  'padding-top', 'padding-left', 'box-shadow',
  'outline-color', 'outline-width', 'outline-style', 'transition-duration'
]
// The track and the knob are the switch's NON-COLOUR carriers: the knob slides
// and swaps glyph, the track changes fill, edge AND ring.
const TRACK_PROPS = [
  'background-color', 'box-shadow', 'transform', ...EDGES, 'transition-duration'
]
const KNOB_PROPS = ['transform', 'color', 'opacity', ...EDGES, 'transition-duration']
const CAVEAT_PROPS = [
  'background-color', 'color', 'font-weight', 'font-style',
  'border-top-color', 'border-top-width', 'border-top-style',
  'border-left-color', 'border-left-width', 'border-left-style',
  'box-shadow', 'outline-color', 'outline-width', 'cursor'
]

// Every caveat that can appear in the collapsed strip, with the badge tone the
// TSX pairs it with. The tone is part of the rendering, so it is carried here.
const CAVEATS = [
  ['superseded', 'badge-warn', 'pv-caveat is-superseded'],
  ['basis', 'badge-warn', 'pv-caveat is-basis'],
  ['fresh-stale', '', 'pv-caveat is-fresh-stale'],
  ['fresh-partially-stale', '', 'pv-caveat is-fresh-partially-stale'],
  ['fresh-unknown', '', 'pv-caveat is-fresh-unknown'],
  ['schema-fail', 'badge-danger', 'pv-caveat is-schema-fail'],
  ['checks-failed', 'badge-danger', 'pv-caveat is-checks-failed']
]

const b = await chromium.launch()
const p = await b.newPage()
await p.setContent(`<style>${css}</style><div id="r"></div>`)

const results = await p.evaluate(
  ({ INTERACTIONS, SWITCH_PROPS, TRACK_PROPS, KNOB_PROPS, CAVEAT_PROPS, CAVEATS }) => {
    const r = document.getElementById('r')
    const out = {}
    const read = (el, props) => {
      const c = getComputedStyle(el)
      return props.map((k) => `${k}=${c.getPropertyValue(k)}`).join('|')
    }

    // switch: off/on × every interaction
    for (const onName of ['off', 'on']) {
      for (const [iName, iCls] of Object.entries(INTERACTIONS)) {
        r.innerHTML = `<div class="settings-pref-row">
          <div class="settings-pref-text"><div class="settings-pref-label">l</div>
          <div class="settings-pref-help">h</div></div>
          <button class="settings-switch ${onName === 'on' ? 'is-on' : ''} ${iCls.join(' ')}" id="t">
            <span class="settings-switch-track" id="k"><span class="settings-switch-knob" id="n">x</span></span>
            <span class="settings-switch-word">w</span></button></div>`
        out[`switch/${onName}/${iName}`] =
          read(r.querySelector('#t'), SWITCH_PROPS) +
          '||' + read(r.querySelector('#k'), TRACK_PROPS) +
          '||' + read(r.querySelector('#n'), KNOB_PROPS)
      }
    }

    // The reveal region in both states. Shut must be inert AND animated: a
    // `display:none` here would pass "distinct" while cutting the grow short
    // and leaving nothing for aria-controls to point at.
    for (const open of ['shut', 'open']) {
      r.innerHTML = `<div class="pv-prov-reveal ${open === 'open' ? 'is-open' : ''}" id="v"><div></div></div>`
      const c = getComputedStyle(r.querySelector('#v'))
      out[`reveal/${open}`] = ['grid-template-rows', 'opacity', 'visibility', 'display',
        'transition-duration'].map((k) => `${k}=${c.getPropertyValue(k)}`).join('|')
    }

    // caveats: every kind × every interaction
    for (const [name, tone, cls] of CAVEATS) {
      for (const [iName, iCls] of Object.entries(INTERACTIONS)) {
        r.innerHTML = `<div class="pv-caveats">
          <span class="badge ${tone} ${cls} ${iCls.join(' ')}" id="x">
            <span class="pv-caveat-glyph">g</span>label</span></div>`
        out[`caveat/${name}/${iName}`] = read(r.querySelector('#x'), CAVEAT_PROPS)
      }
    }
    return out
  },
  { INTERACTIONS, SWITCH_PROPS, TRACK_PROPS, KNOB_PROPS, CAVEAT_PROPS, CAVEATS }
)
await b.close()

let failures = 0

// A `<button role="switch">` inherits the user-agent button styling unless the
// rules reach it. If the reset lost, the control would be a grey system button
// and none of the state work below would be visible.
const swOff = Object.fromEntries(
  results['switch/off/default'].split('||')[0].split('|').map((s) => s.split('='))
)
if (swOff['transition-duration'] === '0s') {
  failures++
  console.log('SNAP [switch] no transition — the pointer feedback jumps')
}
if (swOff['border-top-style'] === 'outset' || swOff['background-color'] === 'rgb(239, 239, 239)') {
  failures++
  console.log('CASCADE [switch] the user-agent button styling is still showing through')
}

// The knob is the switch's non-colour carrier: if it does not slide, the on/off
// state rests on fill alone and dies in grayscale.
const knob = (k) => results[`switch/${k}/default`].split('||')[2]
if (knob('off') === knob('on')) {
  failures++
  console.log('COLLISION [knob] the on state does not move the knob — state rests on colour alone')
}

// The reveal must animate rather than switch, and must be inert when shut.
const revealShut = Object.fromEntries(results['reveal/shut'].split('|').map((s) => s.split('=')))
if (revealShut.display === 'none') {
  failures++
  console.log('SNAP [reveal] shut uses display:none — the 250ms grow cannot run')
}
if (revealShut.visibility !== 'hidden') {
  failures++
  console.log('A11Y [reveal] shut region is not visibility:hidden — it stays focusable while closed')
}
if (revealShut['transition-duration'] === '0s') {
  failures++
  console.log('SNAP [reveal] no transition — the card jumps')
}

// Collisions only count WITHIN a family: a toggle state and a caveat state are
// different objects and are never mistaken for each other.
const families = { switch: [], caveat: [] }
for (const [name, style] of Object.entries(results)) {
  const fam = name.split('/')[0]
  if (families[fam]) families[fam].push([name, style])
}
for (const [fam, entries] of Object.entries(families)) {
  const seen = new Map()
  for (const [name, style] of entries) {
    const prior = seen.get(style)
    if (prior !== undefined) {
      // The caveats are tooltip targets (cursor:help, no onClick), so a pressed
      // state matching its OWN hover is the intended treatment. It must match
      // only its own hover, never another caveat's.
      if (name.replace('/active', '/hover') === prior) continue
      failures++
      console.log(`COLLISION [${fam}] ${prior}  ===  ${name}`)
    } else seen.set(style, name)
  }
  console.log(`${fam}: ${entries.length} states, ${seen.size} distinct`)
}

// The switch's own glyph pair lives in TSX, and is what a grayscale reader is
// left with when the knob position is ambiguous at a glance.
const prefs = readFileSync('src/renderer/components/settings/ReadingPrefs.tsx', 'utf8')
const swGlyphs = [...prefs.matchAll(/\{on \? '(\S+)' : '(\S+)'\}/g)]
if (swGlyphs.length === 0 || swGlyphs.some(([, a, bb]) => a === bb)) {
  failures++
  console.log('COLLISION [switch glyphs] the on and off glyphs are not distinct')
}
if (!prefs.includes('role="switch"') || !prefs.includes('aria-checked')) {
  failures++
  console.log('A11Y [switch] not exposed as a switch with a checked state')
}
if (!prefs.includes('aria-labelledby')) {
  failures++
  console.log('A11Y [switch] has no accessible name')
}
// The markup below is hand-built, so a class renamed in the TSX would leave
// this script proving the states of an element that no longer exists.
for (const cls of [
  'settings-pref-row', 'settings-pref-text', 'settings-switch',
  'settings-switch-track', 'settings-switch-knob', 'settings-switch-word'
]) {
  if (!prefs.includes(cls)) {
    failures++
    console.log(`DRIFT [switch] ReadingPrefs.tsx no longer uses .${cls} \u2014 this script is testing dead markup`)
  }
}

// The glyphs live in TSX, not CSS, and are the differentiator that survives
// grayscale intact — so they are asserted rather than assumed.
const tsx = readFileSync('src/renderer/screens/PaperScreen.tsx', 'utf8')
const caveatBlock = tsx.slice(
  tsx.indexOf('function RunCaveats'),
  tsx.indexOf('function didOutputFailSchema')
)
const glyphs = [...caveatBlock.matchAll(/pv-caveat-glyph" aria-hidden="true">\s*(\S+)\s*</g)].map(
  (m) => m[1]
)
// The freshness caveats render {freshMeta.glyph}, which check-freshness-states
// already proves distinct; only the literal glyphs are compared here.
const literal = glyphs.filter((g) => !g.startsWith('{'))
const uniq = new Set(literal)
console.log(`caveat glyphs: ${literal.length} literal, ${uniq.size} distinct — ${literal.join(' ')}`)
if (literal.length === 0 || uniq.size !== literal.length) {
  failures++
  console.log('COLLISION [glyphs] two caveats share a glyph')
}

if (failures > 0) {
  console.log(`\nFAIL: ${failures} problem(s)`)
  process.exit(1)
}
console.log('\nOK: every provenance-switch and caveat state is visually distinct from every other')
