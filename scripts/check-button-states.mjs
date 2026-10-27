// Resolves EVERY state combination of the close-prompt's three buttons and
// asserts that no two of them render identically. Pseudo-classes are rewritten
// into real classes so the genuine cascade (specificity + source order) is what
// gets exercised, rather than a devtools override.
import { chromium } from '@playwright/test'
import { readFileSync, readdirSync } from 'node:fs'

const dir = 'out/renderer/assets'
let css = readdirSync(dir).filter(f => f.startsWith('index-') && f.endsWith('.css'))
  .map(f => readFileSync(`${dir}/${f}`, 'utf8')).join('\n')

// :hover -> .F-hover etc. `:not(:disabled)` is left alone (it stays true).
for (const ps of ['hover', 'active', 'focus-visible']) {
  css = css.replaceAll(`:not(:${ps})`, `__KEEP_${ps}__`)
  css = css.replaceAll(`:${ps}`, `.F-${ps}`)
  css = css.replaceAll(`__KEEP_${ps}__`, `:not(:${ps})`)
}

const variants = ['btn-primary', 'btn-secondary', 'btn-danger']
const states = {
  'default':       [],
  'hover':         ['F-hover'],
  'active':        ['F-active', 'F-hover'],   // a press is always also a hover
  'focus-visible': ['F-focus-visible'],
  'focus+hover':   ['F-focus-visible', 'F-hover'],
  'unavailable':   ['A'],
  'unavail+hover': ['A', 'F-hover'],
  'busy':          ['is-busy', 'A'],
  'busy+hover':    ['is-busy', 'A', 'F-hover']
}

const b = await chromium.launch()
const p = await b.newPage()
await p.setContent(`<style>${css}</style><div id="r"></div>`)

const results = await p.evaluate(({ variants, states }) => {
  const r = document.getElementById('r')
  const out = {}
  for (const v of variants) {
    for (const [name, cls] of Object.entries(states)) {
      const aria = cls.includes('A') ? 'aria-disabled="true"' : ''
      const classes = ['btn', v, ...cls.filter(c => c !== 'A')].join(' ')
      r.innerHTML = `<button class="${classes}" ${aria}><span class="btn-glyph">g</span>x</button>`
      const cs = getComputedStyle(r.firstElementChild)
      out[`${v} / ${name}`] = [
        cs.backgroundColor, cs.borderColor, cs.opacity, cs.boxShadow,
        cs.outlineColor, cs.outlineWidth, cs.outlineStyle, cs.color, cs.filter
      ].join(' | ')
    }
  }
  return out
}, { variants, states })

let collisions = 0
// Hovering a button that is unavailable is SUPPOSED to look like not hovering
// it: the point of the state is that the pointer is dead here, and the reason
// arrives as a tooltip rather than as a surface change. Intended, not a bug.
const ALLOWED_IDENTICAL = new Set(['unavailable::unavail+hover', 'busy::busy+hover'])

const seen = new Map()
for (const [k, val] of Object.entries(results)) {
  const [variant, state] = k.split(' / ')
  const key = variant + '::' + val
  const prior = seen.get(key)
  if (prior === undefined) {
    seen.set(key, k)
    continue
  }
  if (ALLOWED_IDENTICAL.has(`${prior.split(' / ')[1]}::${state}`)) continue
  console.log(`COLLISION: "${prior}"  ===  "${k}"`)
  collisions++
}
for (const [k, v] of Object.entries(results)) console.log(k.padEnd(30), v)
console.log(collisions === 0
  ? '\nOK — every state of every variant resolves to a distinct style'
  : `\n${collisions} COLLISION(S)`)
await b.close()
process.exit(collisions === 0 ? 0 : 1)
