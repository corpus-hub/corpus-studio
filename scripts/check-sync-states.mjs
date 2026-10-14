// Resolves EVERY state of the navbar sync control and asserts that no two of
// them render identically.
//
// The rule (CLAUDE.md §0.5): two states that render the same are a bug, because
// they tell the user their pointer is dead. This control is the sharpest case
// in the app, because ONE element in ONE 246px slot is now two different things
// — a passive report in automatic mode and a button in on-demand — and if the
// two look alike then "you must press this to sync" is invisible.
//
// It also checks a WEAKER thing the eye is bad at: that each on-demand state
// still differs from the automatic state it shares a hue with. `failed` amber
// against `needs-sync` amber, `busy` against `syncing`, and so on.
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

/**
 * The GLYPHS, copied from the component's `Glyph`.
 *
 * Rendered rather than stubbed, because the glyph is a state channel: `ok`'s
 * ring eases open, `syncing` turns one arc and `resync` turns two. A harness
 * that emitted an empty span would resolve none of `.sync-ring`, `.sync-arc` or
 * `.sync-arc-2`, and would then report "distinct" for two states whose only
 * difference is the shape inside them.
 */
const GLYPH = {
  ok: '<circle class="sync-ring" cx="10" cy="10" r="7.5"/><path d="M6.4 10.3l2.4 2.4 4.8-5.1"/>',
  syncing: '<circle cx="10" cy="10" r="7.5"/><path class="sync-arc" d="M10 2.5a7.5 7.5 0 0 1 7.5 7.5"/>',
  resync:
    '<path class="sync-arc" d="M10 2.5a7.5 7.5 0 0 1 7.5 7.5"/><path class="sync-arc-2" d="M10 5.5a4.5 4.5 0 0 0-4.5 4.5"/>',
  failed: '<circle cx="10" cy="10" r="7.5"/><path d="M7.3 7.3l5.4 5.4M12.7 7.3l-5.4 5.4"/>',
  'needs-credentials': '<circle cx="7" cy="9" r="3.2"/><path d="M10 10h7M14.5 10v3M16.6 10v2.2"/>',
  idle: '<circle cx="10" cy="10" r="7.5"/><path d="M10 6.4v3.9l2.6 1.6"/>',
  off: '<circle cx="10" cy="10" r="7.5" opacity="0.45"/><rect x="7.4" y="7.4" width="5.2" height="5.2" rx="1"/>',
  // The broken ring, drawn only where the run state is otherwise content-free.
  incomplete:
    '<path class="sync-gap" d="M14.6 4.6a7.5 7.5 0 1 0 2.3 7.7"/><path d="M10 6.6v4.1"/><circle cx="10" cy="13.4" r="0.5"/>'
}

// ---- 1. AUTOMATIC — the passive indicator, every run state ------------------
// A report, so hover/active are faint by design; they must still be legible as
// distinct from rest, because a dead-looking hover on a focusable element reads
// as a broken control. Every one is focusable (`tabIndex={0}`), so every one is
// checked focused as well.
//
// `short` is the PERMANENT SHORTFALL (`declinedRows > 0`), which is orthogonal
// to the run state — a share can be failing and short, or in step and short —
// so it is crossed with every one rather than added as a seventh value. Where
// the run state is content-free (`ok`, `idle`) the component also swaps the
// glyph to the broken ring, which the harness mirrors: comparing the count chip
// alone would report "distinct" for two rows whose real difference is the shape.
const autoStates = {}
// `off` is in the enum and REACHABLE — `shapeRunState` in `main/plugins/host.ts`
// falls back to it for anything malformed — so it is enumerated here rather than
// left to render as an unstyled `.sync-icon`, which is what it did.
for (const s of ['idle', 'ok', 'syncing', 'resync', 'failed', 'needs-credentials', 'off'])
  for (const short of [false, true]) {
    // `ok+short` and `idle+short` are ONE presented state by construction —
    // both content-free run states collapse into `incomplete` — so the harness
    // resolves the one class the component emits rather than two names for it.
    const quiet = s === 'ok' || s === 'idle'
    if (short && quiet && s === 'idle') continue
    const cls = short ? (quiet ? ['is-incomplete'] : [`is-${s}`, 'is-short']) : [`is-${s}`]
    const glyph = short && quiet ? 'incomplete' : s
    const n = short ? (quiet ? 'incomplete' : `${s}+short`) : s
    autoStates[n] = { cls, glyph, short }
    autoStates[`${n}+hover`] = { cls: [...cls, 'F-hover'], glyph, short }
    autoStates[`${n}+active`] = { cls: [...cls, 'F-hover', 'F-active'], glyph, short }
    autoStates[`${n}+focus`] = { cls: [...cls, 'F-focus-visible'], glyph, short }
  }

// ---- 2. ON-DEMAND — the button, every state and combination -----------------
// The `glyph` of each is the component's `glyphFor`, not `share.state`.
// The shortfall crosses every one of them here too. The button's WORD never
// changes for it — that word says what pressing will do, and pressing is
// unaffected — so the chip and the dashed edge are the whole difference, which
// is exactly the pair this script exists to prove are actually resolving.
const demandStates = {}
for (const [s, glyph] of [
  ['needs-sync', 'idle'],
  ['busy', 'syncing'],
  ['busy-resync', 'resync'],
  ['failed', 'failed'],
  ['blocked', 'needs-credentials']
])
  for (const short of [false, true]) {
    const base = s === 'busy-resync' ? 'is-busy' : `is-${s}`
    const cls = short ? [base, 'is-short'] : [base]
    const n = short ? `${s}+short` : s
    demandStates[n] = { cls, glyph, short }
    demandStates[`${n}+hover`] = { cls: [...cls, 'F-hover'], glyph, short }
    demandStates[`${n}+active`] = { cls: [...cls, 'F-hover', 'F-active'], glyph, short }
    // `aria-disabled`, not `disabled`, so busy and blocked are STILL FOCUSABLE
    // and their focus ring is a real state a keyboard user will land on.
    demandStates[`${n}+focus`] = { cls: [...cls, 'F-focus-visible'], glyph, short }
  }

/**
 * The ELEMENT, the GLYPH and the CHEVRON are all part of the state.
 *
 * The element matters because the two modes are genuinely different tags — a
 * `<div role="status">` and a `<button>` — and a harness that rendered a button
 * for both would compare the automatic indicator against a shape that never
 * ships, which is exactly the cross-mode comparison this script exists for.
 *
 * Rule 0.5 forbids signalling by colour alone, so the glyph's own resolved
 * styles and the chevron's presence are folded into the signature.
 */
const resolve = async (states, isButton) =>
  p.evaluate(
    ({ states, isButton, GLYPH }) => {
      const r = document.getElementById('r')
      const out = {}
      for (const [name, spec] of Object.entries(states)) {
        const base = isButton ? ['sync-icon', 'sync-icon-btn'] : ['sync-icon']
        // The chevron is rendered only where the component renders it: on the
        // button, and only while it can be pressed.
        const go = isButton && !name.startsWith('busy') && !name.startsWith('blocked')
        const tag = isButton ? 'button' : 'div'
        const attrs = isButton ? 'type="button"' : 'role="status" tabindex="0"'
        // The COUNT CHIP is part of the state and is rendered exactly where the
        // component renders it — never at zero (hard rule 0.6), which is why a
        // healthy row here has no `.sync-icon-short` at all rather than an empty
        // one: an always-present node would make the chip's own styles resolve
        // on states that never show it.
        const short = spec.short === true
        r.innerHTML =
          `<${tag} ${attrs} class="${[...base, ...spec.cls].join(' ')}">` +
          `<span class="sync-icon-glyph"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor">${GLYPH[spec.glyph]}</svg></span>` +
          `<span class="sync-icon-label">x</span>` +
          (short
            ? `<span class="sync-icon-short mono"><span>3</span><span class="sync-icon-short-sr">3 rows not stored</span></span>`
            : '') +
          (go ? `<span class="sync-icon-go"></span>` : '') +
          `</${tag}>`
        const el = r.firstElementChild
        const cs = getComputedStyle(el)
        // The glyph's own resolved styles, per shape, so `ok`'s settling ring
        // and `resync`'s counter-turning second arc are compared rather than
        // assumed.
        const parts = [...el.querySelectorAll('.sync-icon-glyph svg *')].map((n) => {
          const g = getComputedStyle(n)
          return [n.getAttribute('class') ?? '-', g.strokeDasharray, g.opacity, g.animationName, g.animationDirection, g.animationDuration].join(',')
        })
        // The chip's own resolved styles, so the one channel that distinguishes
        // "failing" from "failing and short" is compared rather than assumed.
        const chip = el.querySelector('.sync-icon-short')
        const cc = chip === null ? 'no-chip' : getComputedStyle(chip)
        out[name] = [
          tag,
          cs.backgroundColor,
          cs.borderColor,
          cs.borderStyle,
          cs.borderWidth,
          cs.boxShadow,
          cs.color,
          cs.fontWeight,
          cs.opacity,
          cs.cursor,
          cs.outlineWidth,
          cs.outlineStyle,
          cs.outlineColor,
          cs.outlineOffset,
          go ? 'chevron' : 'no-chevron',
          chip === null
            ? 'no-chip'
            : ['chip', cc.backgroundColor, cc.borderColor, cc.color, cc.opacity, cc.fontWeight].join(','),
          parts.join(' / ')
        ].join(' | ')
      }
      return out
    },
    { states, isButton, GLYPH }
  )

const autoResults = await resolve(autoStates, false)
const demandResults = await resolve(demandStates, true)

let collisions = 0
function check(label, results) {
  const seen = new Map()
  for (const [k, val] of Object.entries(results)) {
    const prior = seen.get(val)
    if (prior === undefined) {
      seen.set(val, k)
      continue
    }
    console.log(`COLLISION [${label}]: "${prior}"  ===  "${k}"`)
    collisions++
  }
}

check('automatic', autoResults)
check('on-demand', demandResults)

// ---- 3. THE TWO MODES AGAINST EACH OTHER ------------------------------------
// The whole point of the feature: a person glancing at the sidebar must be able
// to tell "this is working on its own" from "you must press this". A collision
// here is the feature failing silently.
const cross = new Map()
for (const [k, v] of Object.entries(autoResults)) cross.set(v, `automatic/${k}`)
for (const [k, v] of Object.entries(demandResults)) {
  const prior = cross.get(v)
  if (prior !== undefined) {
    console.log(`COLLISION [across modes]: "${prior}"  ===  "on-demand/${k}"`)
    collisions++
  }
  cross.set(v, `on-demand/${k}`)
}

// ---- 4. The `choice` param's radio group ------------------------------------
// The real `<input type="radio">` is present and visually hidden, because
// `.plug-choice-opt:has(input:focus-visible)` is the ONLY focus rule here — a
// harness with no input can never match it, so it would report a focus state
// that does not exist. `is-rejected` is on the surrounding field, so it is
// applied there too rather than to the option.
const choiceStates = {
  off: { opt: [], field: [] },
  'off+hover': { opt: ['F-hover'], field: [] },
  'off+active': { opt: ['F-hover', 'F-active'], field: [] },
  'off+focus': { opt: [], field: [], focus: true },
  on: { opt: ['is-on'], field: [] },
  'on+hover': { opt: ['is-on', 'F-hover'], field: [] },
  'on+active': { opt: ['is-on', 'F-hover', 'F-active'], field: [] },
  'on+focus': { opt: ['is-on'], field: [], focus: true },
  rejected: { opt: [], field: ['is-rejected'] },
  'rejected+on': { opt: ['is-on'], field: ['is-rejected'] }
}
const choiceResults = await p.evaluate((states) => {
  const r = document.getElementById('r')
  const out = {}
  for (const [name, spec] of Object.entries(states)) {
    r.innerHTML =
      `<div class="${['set-field', 'plug-field', 'plug-choice', ...spec.field].join(' ')}"><div class="plug-choice-options">` +
      `<label class="${['plug-choice-opt', ...spec.opt].join(' ')}">` +
      `<input type="radio"${spec.focus ? ' class="F-focus-visible"' : ''}>` +
      `<span class="plug-choice-mark"></span><span class="plug-choice-text">x</span></label></div></div>`
    const opt = r.querySelector('.plug-choice-opt')
    const mark = r.querySelector('.plug-choice-mark')
    const co = getComputedStyle(opt)
    const cm = getComputedStyle(mark)
    out[name] = [
      co.backgroundColor,
      co.borderColor,
      co.boxShadow,
      co.outlineWidth,
      co.outlineColor,
      cm.borderColor,
      cm.boxShadow
    ].join(' | ')
  }
  return out
}, choiceStates)
check('choice', choiceResults)

for (const [k, v] of Object.entries(autoResults)) console.log('auto'.padEnd(10), k.padEnd(26), v)
for (const [k, v] of Object.entries(demandResults)) console.log('on-demand'.padEnd(10), k.padEnd(26), v)
for (const [k, v] of Object.entries(choiceResults)) console.log('choice'.padEnd(10), k.padEnd(26), v)

console.log(
  collisions === 0
    ? '\nOK — every sync-control state resolves to a distinct style'
    : `\n${collisions} COLLISION(S)`
)
await b.close()
process.exit(collisions === 0 ? 0 : 1)
