// Resolves the computed style of EVERY state of the semantic-search controls
// and asserts that no two render identically.
//
// Two states that look the same are a lie told to the pointer: hovering the
// selected search mode and having it settle into exactly the selected treatment
// says the control is dead. This repo has shipped that collision twice
// (`picked+hover === picked`, `superseded+hover === current`), which is why it
// is asserted mechanically instead of eyeballed.
//
// Reads the BUILT css so the real cascade (specificity and source order across
// styles.css, ingest.css and semantic.css) is exercised rather than a
// hand-picked subset. Pseudo-classes are rewritten into real classes for the
// same reason, and `:has()` is rewritten alongside them because the hit row's
// hover is driven by its overlay button.
import { chromium } from '@playwright/test'
import { readFileSync, readdirSync, statSync } from 'node:fs'

const dir = 'out/renderer/assets'
const built = readdirSync(dir).filter((f) => f.startsWith('index-') && f.endsWith('.css'))
let css = built.map((f) => readFileSync(`${dir}/${f}`, 'utf8')).join('\n')

// A build older than the source it is meant to prove would let this pass on CSS
// that no longer exists — the "verified a stale build" failure this repo has hit
// before. Refuse rather than reassure.
const SOURCES = [
  'src/renderer/styles.css',
  'src/renderer/styles/semantic.css',
  'src/renderer/styles/ingest.css'
]
const newestSource = Math.max(...SOURCES.map((f) => statSync(f).mtimeMs))
const oldestBuilt = Math.min(...built.map((f) => statSync(`${dir}/${f}`).mtimeMs))
if (built.length === 0 || newestSource > oldestBuilt) {
  console.log(`FAIL: ${dir} predates the stylesheets it should contain — run \`npm run build\` first`)
  process.exit(1)
}

for (const ps of ['hover', 'active', 'focus-visible']) {
  css = css.replaceAll(`:not(:${ps})`, `__KEEP_${ps}__`)
  css = css.replaceAll(`:${ps}`, `.S-${ps}`)
  css = css.replaceAll(`__KEEP_${ps}__`, `:not(:${ps})`)
}

const INTERACTIONS = {
  default: [],
  hover: ['S-hover'],
  active: ['S-active', 'S-hover'],
  focus: ['S-focus-visible'],
  'focus+hover': ['S-focus-visible', 'S-hover']
}

const b = await chromium.launch()
const p = await b.newPage()
await p.setContent(`<style>${css}</style><div id="r"></div>`)

const BUTTON_PROPS = [
  'background-color', 'color', 'font-weight', 'font-size', 'letter-spacing',
  'border-top-color', 'border-top-width', 'border-top-style',
  'box-shadow', 'outline-color', 'outline-width', 'outline-style', 'opacity',
  // Underlines and italics are differentiators that survive grayscale, so they
  // are read alongside the colour rather than left to be assumed.
  'text-decoration-line', 'text-decoration-color', 'font-style',
  // An animation IS a state. Two rows that differ only by one being animated
  // would otherwise read as a collision-free duplicate, and a lost animation
  // would go unnoticed entirely.
  'animation-name', 'background-image', 'background-size', 'transform', 'filter'
]
const ROW_PROPS = [
  'background-color', 'border-top-color', 'border-left-color', 'border-left-width',
  'border-left-style', 'box-shadow', 'outline-color', 'outline-width', 'opacity'
]

const results = await p.evaluate(
  ({ INTERACTIONS, BUTTON_PROPS, ROW_PROPS }) => {
    const r = document.getElementById('r')
    const out = {}
    const read = (el, props) =>
      props.map((k) => `${k}=${getComputedStyle(el).getPropertyValue(k)}`).join('|')

    // ---- the mode switch: selected x BUSY x interaction ----
    // Busy is a real axis here, not a hypothetical: an ONNX query takes most of
    // a second and the button stays clickable throughout, so "a search is
    // running" must not render the same as "nothing is happening".
    for (const on of [false, true]) {
      for (const busy of [false, true]) {
        // Only the meaning button can be busy, and only while it is selected.
        if (busy && !on) continue
        for (const [iName, iCls] of Object.entries(INTERACTIONS)) {
          r.innerHTML = `<div class="sem-modes"><div class="sem-mode-group">
            <button id="m" class="sem-mode ${on ? 'is-on' : ''} ${busy ? 'is-busy' : ''} ${iCls.join(' ')}">By meaning</button>
          </div></div>`
          out[`mode/${on ? 'on' : 'off'}${busy ? '+busy' : ''}/${iName}`] = read(
            r.querySelector('#m'), BUTTON_PROPS
          )
        }
      }
    }

    // ---- the coverage verdict: four states plus LOADING, all in one slot ----
    // Loading belongs in the same family: it occupies the same place and must
    // not be mistaken for "no papers are searchable", which is a settled answer
    // rather than a wait.
    for (const [v, cls] of [
      ['full', 'ok'], ['partial', 'warn'], ['none', 'muted'], ['unavailable', 'danger']
    ]) {
      r.innerHTML = `<span class="sem-cov is-${v}">
        <span id="bg" class="badge badge-${cls} sem-cov-badge">label</span></span>`
      out[`cov/${v}`] = read(r.querySelector('#bg'), BUTTON_PROPS)
    }
    // The WRAPPER is deliberately uniform across the four settled verdicts — the
    // badge inside carries the state, and that is measured above. What the
    // wrapper must distinguish is SETTLED from LOADING, because a wait sitting
    // in the same slot as an answer is the one pair that would mislead.
    r.innerHTML = `<span class="sem-cov is-partial"><span class="badge badge-warn sem-cov-badge">x</span></span>`
    out['covbox/settled'] = read(r.querySelector('.sem-cov'), BUTTON_PROPS)
    r.innerHTML = `<span class="sem-cov is-loading"><span class="sk sem-cov-skel"></span>x</span>`
    out['covbox/loading'] = read(r.querySelector('.sem-cov'), BUTTON_PROPS)

    // ---- a hit row: similarity band x interaction ----
    // The band is what tells a close match from a weak one at a glance, so two
    // bands that render alike defeat the ranking the whole feature exists for.
    for (const band of ['close', 'related', 'weak']) {
      for (const [iName, iCls] of Object.entries(INTERACTIONS)) {
        r.innerHTML = `<div class="sem-list"><div class="sem-hit" data-band="${band}" id="h">
          <button class="sem-hit-open ${iCls.join(' ')}"></button>
          <div class="sem-hit-main"></div><div class="sem-hit-side"></div>
        </div></div>`
        out[`hit/${band}/${iName}`] = read(r.querySelector('#h'), ROW_PROPS)
      }
    }

    // ---- the band badge itself ----
    for (const [band, cls] of [['close', 'ok'], ['related', 'warn'], ['weak', 'danger']]) {
      r.innerHTML = `<span id="bb" class="badge badge-${cls} sem-hit-band">${band}</span>`
      out[`band/${band}`] = read(r.querySelector('#bb'), BUTTON_PROPS)
    }

    // ---- the unembedded disclosure: open x interaction ----
    for (const open of [false, true]) {
      for (const [iName, iCls] of Object.entries(INTERACTIONS)) {
        r.innerHTML = `<div class="sem-unembedded ${open ? 'is-open' : ''}">
          <button id="u" class="sem-unembedded-toggle ${iCls.join(' ')}">
            <span class="sem-unembedded-caret">c</span>3 papers</button></div>`
        out[`unemb/${open ? 'open' : 'closed'}/${iName}`] = read(
          r.querySelector('#u'), BUTTON_PROPS
        )
      }
    }

    // ---- "show the rest" on a clamped passage ----
    for (const [iName, iCls] of Object.entries(INTERACTIONS)) {
      r.innerHTML = `<div class="sem-hit-quote-wrap">
        <blockquote class="sem-hit-quote is-clamped">q</blockquote>
        <button id="mo" class="btn-link sem-hit-more ${iCls.join(' ')}">show the rest</button>
      </div>`
      out[`more/x/${iName}`] = read(r.querySelector('#mo'), BUTTON_PROPS)
    }

    // ---- a title in the unembedded list: a real navigation target ----
    for (const [iName, iCls] of Object.entries(INTERACTIONS)) {
      r.innerHTML = `<ul class="sem-unembedded-list"><li class="sem-unembedded-li">
        <button id="ui" class="btn-link sem-unembedded-item ${iCls.join(' ')}">A paper</button>
        <span class="sem-unembedded-why">no text yet</span></li></ul>`
      out[`unembitem/x/${iName}`] = read(r.querySelector('#ui'), BUTTON_PROPS)
    }

    // ---- the per-paper reason pill ----
    // A non-focusable <span> whose only job is to carry a tooltip, so only the
    // states it can actually be in are asserted. Enumerating `focus` for an
    // element the browser will never focus would report a collision that no
    // user can reach, and that is how a check stops being believed.
    for (const [iName, iCls] of [['default', []], ['hover', ['S-hover']]]) {
      r.innerHTML = `<span id="wy" class="sem-unembedded-why ${iCls.join(' ')}">no text yet</span>`
      out[`why/x/${iName}`] = read(r.querySelector('#wy'), BUTTON_PROPS)
    }

    // ---- the text-source badge, which must not collapse into one grey pill ----
    for (const [src, cls] of [
      ['text-layer', 'ok'], ['ocr', 'warn'], ['ocr-poor', 'danger'], ['unknown', 'muted']
    ]) {
      r.innerHTML = `<span id="t" class="badge badge-${cls} ing-pipe-textsrc">${src}</span>`
      out[`textsrc/${src}`] = read(r.querySelector('#t'), BUTTON_PROPS)
    }

    return out
  },
  { INTERACTIONS, BUTTON_PROPS, ROW_PROPS }
)
await b.close()

// Collisions only mean something WITHIN a family: a mode button and a hit row
// are never seen side by side, so comparing them proves nothing.
const families = {}
for (const [name, style] of Object.entries(results)) {
  const fam = name.split('/')[0]
  ;(families[fam] ??= []).push([name, style])
}

let collisions = 0
for (const [fam, entries] of Object.entries(families)) {
  const seen = new Map()
  for (const [name, style] of entries) {
    const prior = seen.get(style)
    if (prior !== undefined) {
      // A control with no press treatment is allowed to have `active` match its
      // OWN hover — that is a deliberate choice about pressability, not a
      // collision. It must match only its own hover, never another state's.
      if (name.replace('/active', '/hover') === prior) continue
      collisions++
      console.log(`COLLISION [${fam}] ${prior}  ===  ${name}`)
    } else seen.set(style, name)
  }
  console.log(`${fam}: ${entries.length} states, ${seen.size} distinct`)
}

// The WORDS are the differentiator that survives grayscale, so they are checked
// rather than assumed: a coverage verdict or a similarity band that reused
// another's label would pass on a border colour alone, which is the weakest of
// the signals and the one a colourblind reader loses.
const src = readFileSync('src/renderer/lib/format.ts', 'utf8')
const bandLabels = [...src.matchAll(/label: '(close|related|weak)'/g)].map((m) => m[1])
if (new Set(bandLabels).size !== 3) {
  collisions++
  console.log(`COLLISION [band-words] similarity bands do not carry 3 distinct labels: ${bandLabels}`)
}
const ingest = readFileSync('src/renderer/screens/IngestScreen.tsx', 'utf8')
const verdictWords = [...ingest.matchAll(/key: '(full|partial|none|unavailable)'/g)].map((m) => m[1])
if (new Set(verdictWords).size !== 4) {
  collisions++
  console.log(`COLLISION [cov-words] coverage verdicts are not 4 distinct keys: ${verdictWords}`)
}

console.log(collisions === 0 ? 'OK: no state collisions' : `FAIL: ${collisions} collision(s)`)
process.exit(collisions === 0 ? 0 : 1)
