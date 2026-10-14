// Resolves EVERY state of the Queue's stage dot and row verdict pill — and
// every pointer/keyboard combination on top of each — and asserts no two of
// them render identically.
//
// It exists because the stage system gave the dot TWELVE states, three of which
// (`empty`, `skipped`, `refused`) are correct zero-output results that must not
// be mistakable for the failure they sit next to. Twelve states times four
// interaction combinations is more than anyone verifies by eye, and this repo
// has already shipped two collisions that eyeballing missed.
//
// Pseudo-classes are rewritten into real classes so the GENUINE cascade
// (specificity + source order) decides, rather than a devtools override.
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

// The state list is READ from the source of truth, never re-typed here: a hand
// copy is a list that silently stops covering the state somebody just added,
// which is the exact failure this script exists to prevent.
const stageStateSrc = readFileSync('src/renderer/lib/stageState.ts', 'utf8')
const unionBlock = stageStateSrc.match(/export type StageState =([\s\S]*?)\n\n/)
const STATES = [...unionBlock[1].matchAll(/\|\s*'([a-z]+)'/g)].map((m) => m[1])
if (STATES.length === 0) throw new Error('could not read the StageState union')

const INTERACTIONS = {
  default: [],
  hover: ['F-hover'],
  // A press is always also a hover, so it is tested as the pair — testing
  // `:active` alone would exercise a combination a pointer cannot produce.
  active: ['F-active', 'F-hover'],
  'focus-visible': ['F-focus-visible'],
  'focus+hover': ['F-focus-visible', 'F-hover']
}

const b = await chromium.launch()
const p = await b.newPage()
await p.setContent(`<style>${css}</style><div class="ingest"><div id="r"></div></div>`)

const measure = async (base, glyphClass, interactions = INTERACTIONS) =>
  p.evaluate(
    ({ base, glyphClass, STATES, INTERACTIONS }) => {
      const r = document.getElementById('r')
      const out = {}
      for (const s of STATES) {
        for (const [name, cls] of Object.entries(INTERACTIONS)) {
          r.innerHTML = `<span class="${[base, `is-${s}`, ...cls].join(
            ' '
          )}"><span class="${glyphClass}">g</span></span>`
          const cs = getComputedStyle(r.firstElementChild)
          out[`${s} / ${name}`] = [
            cs.backgroundColor,
            cs.borderColor,
            cs.borderStyle,
            cs.borderWidth,
            cs.color,
            cs.opacity,
            cs.boxShadow,
            cs.outlineColor,
            cs.outlineWidth,
            cs.outlineStyle,
            cs.outlineOffset,
            cs.transform,
            cs.textDecorationLine,
            cs.animationName
          ].join(' | ')
        }
      }
      return out
    },
    { base, glyphClass, STATES, INTERACTIONS: interactions }
  )

// The glyph is the other half of every state, and it is what carries the state
// for a colourblind reader — so it is checked for distinctness separately.
const glyphBlock = stageStateSrc.match(/STAGE_GLYPH: Record<StageState, string> = \{([^}]*)\}/s)
const glyphs = Object.fromEntries(
  [...glyphBlock[1].matchAll(/(\w+):\s*'(.+?)'/g)].map((m) => [m[1], m[2]])
)

let failures = 0

const report = (title, results, allowedIdentical = new Set()) => {
  console.log(`\n=== ${title} ===`)
  const seen = new Map()
  for (const [k, val] of Object.entries(results)) {
    const [state, inter] = k.split(' / ')
    const prior = seen.get(val)
    if (prior === undefined) {
      seen.set(val, k)
      continue
    }
    const [pState, pInter] = prior.split(' / ')
    // Two INTERACTIONS of one state colliding, and two STATES colliding, are
    // both bugs — the first means the pointer looks dead, the second means the
    // user cannot tell an empty result from a crash.
    if (allowedIdentical.has(`${pState}/${pInter}::${state}/${inter}`)) continue
    console.log(`COLLISION: "${prior}"  ===  "${k}"`)
    failures++
  }
  for (const [k, v] of Object.entries(results)) console.log(k.padEnd(28), v)
}

report('stage dot', await measure('ing-stage', 'ing-stage-glyph'))
// The verdict pill is a LABEL, not a control: it takes no pointer or keyboard
// focus, so it is checked across states only. Giving it hover feedback would
// promise an interaction it does not have.
report(
  'row verdict pill',
  await measure('ing-verdict', 'ing-verdict-glyph', { default: [] })
)

// The row's left edge is its margin cue, and the row DOES take hover — so it is
// checked in both. Only a subset of states can be a rollup, but measuring all
// of them is free and catches a state whose edge was never styled.
report('row left edge', await measure('ing-pipe', 'ing-pipe-title', {
  default: [],
  hover: ['F-hover']
}))

// The notice strip only exists for the non-failure outcomes, and its whole
// point is that those read differently from each other AND survive the row
// hover that once flattened them all to white.
const NOTICE_STATES = ['empty', 'refused', 'blocked', 'superseded', 'skipped']
const noticeResults = await p.evaluate(
  ({ NOTICE_STATES }) => {
    const r = document.getElementById('r')
    const out = {}
    for (const s of NOTICE_STATES) {
      for (const hovered of [false, true]) {
        r.innerHTML = `<div class="ing-pipe ${hovered ? 'F-hover' : ''}"><div class="ing-note is-${s}"><span class="ing-note-glyph">g</span><span class="ing-note-text">t</span></div></div>`
        const el = r.querySelector('.ing-note')
        const cs = getComputedStyle(el)
        const gs = getComputedStyle(r.querySelector('.ing-note-glyph'))
        out[`${s} / ${hovered ? 'row-hover' : 'default'}`] = [
          cs.backgroundColor,
          cs.borderColor,
          cs.borderStyle,
          cs.borderWidth,
          cs.boxShadow,
          gs.color
        ].join(' | ')
      }
    }
    return out
  },
  { NOTICE_STATES }
)
report('outcome notice strip', noticeResults)

console.log('\n=== glyphs ===')
const byGlyph = new Map()
for (const s of STATES) {
  const g = glyphs[s]
  if (g === undefined) {
    console.log(`MISSING GLYPH: ${s}`)
    failures++
    continue
  }
  const prior = byGlyph.get(g)
  if (prior !== undefined) {
    console.log(`GLYPH COLLISION: ${prior} and ${s} both use "${g}"`)
    failures++
  }
  byGlyph.set(g, s)
  console.log(s.padEnd(12), g)
}

console.log(
  failures === 0
    ? '\nOK — every stage state, every verdict state and every glyph is distinct, in every interaction combination'
    : `\n${failures} COLLISION(S)`
)
await b.close()
process.exit(failures === 0 ? 0 : 1)
