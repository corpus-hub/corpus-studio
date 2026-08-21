// Resolves EVERY state of the plugin table, its toggle, its row buttons and its
// fields, and of the sharing modal's mode buttons, project picks, share rows and
// invitation controls — and asserts that no two states of ONE control render
// identically.
//
// The rule (CLAUDE.md §0.5): two states that render the same are a bug, because
// they tell the user their pointer is dead. This surface is where that is
// easiest to get wrong, because almost every control here has a resting fill of
// its own — and a state that carries a fill outranks the generic `:hover` rule,
// so the press or the hover silently does nothing on exactly the states that
// have the most going on. That is not a hypothetical: `.sync-icon.is-failed`
// shipped with its `:active` rule above its `:hover` rule and pressing it
// changed nothing.
//
// SIBLING of `check-sync-states.mjs`, which owns the navbar indicator. Both
// resolve against the BUILT css in a REAL browser, so the genuine cascade —
// specificity, source order, `:has()`, `:not()` — is exercised rather than a
// hand-rolled approximation of it. Run `npm run build` first.
//
// Compared WITHIN a control. Two different controls that resolve alike (Configure
// and Remove are both secondary buttons) is a design; the question rule 0.5 asks
// is whether ONE control's states are told apart.
import { chromium } from '@playwright/test'
import { readFileSync, readdirSync } from 'node:fs'

const dir = 'out/renderer/assets'
let css = readdirSync(dir)
  .filter((f) => f.startsWith('index-') && f.endsWith('.css'))
  .map((f) => readFileSync(`${dir}/${f}`, 'utf8'))
  .join('\n')

// Pseudo-classes become real classes so a state can be APPLIED rather than
// simulated. The `:not(:hover)` guards are preserved: they are a real part of
// the cascade here and rewriting them would invert the rules that use them.
for (const ps of ['hover', 'active', 'focus-visible', 'focus-within', 'focus']) {
  css = css.replaceAll(`:not(:${ps})`, `__KEEP_${ps}__`)
  css = css.replaceAll(`:${ps}`, `.F-${ps}`)
  css = css.replaceAll(`__KEEP_${ps}__`, `:not(:${ps})`)
}

const b = await chromium.launch()
const p = await b.newPage()
await p.setContent(`<style>${css}</style><div id="r"></div>`)

let collisions = 0

/**
 * The ONE identity that is intended, stated as a rule rather than as a list of
 * pairs: a control that is REFUSING (`aria-disabled`) or BUSY must not change
 * under the pointer, because the pointer is dead there. That is the whole
 * signal, and `styles.css` implements it deliberately — every pointer rule on
 * `.btn` and `.settings-switch` is gated on `:not([aria-disabled='true'])`. The
 * explanation arrives as a `data-tip`, not as a surface change.
 *
 * `check-button-states.mjs` already carries the same allowance for the base
 * button variants; this is the same rule, applied to every control here.
 *
 * It is NOT extended to focus. A refusing control is still focusable — that is
 * the entire reason it uses `aria-disabled` rather than `disabled` — so its
 * focus ring is a state a keyboard user lands on and must be visible.
 */
const INERT = /^(refused|busy|stopping|removing|blocked)|\/(busy|blocked)/
const inertPair = (a, b2) => {
  const strip = (n) => n.replace(/\+(hover|active)$/, '')
  return strip(a) === strip(b2) && INERT.test(strip(a)) && !/\+focus$/.test(a + b2)
}

/**
 * Resolve one control's states and compare them.
 *
 * `spec.html` is a function of the state's classes, so each group renders the
 * markup the component actually ships — the ancestors matter (`.plug-row` styles
 * hang off `.plug-table`, the choice option's focus rule is `:has(input…)`), and
 * a flattened stub would resolve rules that never apply and miss rules that do.
 *
 * `probe` names the descendants whose own resolved styles are part of the signal.
 * Rule 0.5 forbids signalling by colour alone, so a state whose only difference
 * is a child's weight or an inset shadow must still be compared on it.
 */
async function group(label, states, html, probe = []) {
  const results = await p.evaluate(
    ({ states, htmlSrc, probe }) => {
      // eslint-disable-next-line no-new-func
      const render = new Function('return ' + htmlSrc)()
      const r = document.getElementById('r')
      const out = {}
      // EVERY channel the CSS here actually signals on, not just colour.
      // `backgroundImage` is load-bearing: the busy row's whole signal is a
      // hatch over whatever fill it already had, so a signature without it
      // reports "busy" and "not busy" as the same style. `filter` is likewise
      // how `.btn-primary:active` differs from `:hover`, and `animationName` is
      // the only difference a pulsing glyph has.
      const sig = (el) => {
        const c = getComputedStyle(el)
        return [
          el.tagName,
          c.backgroundColor,
          c.backgroundImage,
          c.borderColor,
          c.borderStyle,
          c.borderWidth,
          c.boxShadow,
          c.color,
          c.filter,
          c.fontWeight,
          c.fontStyle,
          c.textDecorationLine,
          c.opacity,
          c.cursor,
          c.outlineWidth,
          c.outlineStyle,
          c.outlineColor,
          c.outlineOffset,
          c.animationName,
          c.animationDuration,
          c.transform
        ].join(',')
      }
      for (const [name, spec] of Object.entries(states)) {
        r.innerHTML = render(spec)
        const target = r.querySelector('[data-probe]')
        const parts = [sig(target)]
        for (const sel of probe) {
          const el = r.querySelector(sel)
          parts.push(el ? `${sel}=${sig(el)}` : `${sel}=absent`)
        }
        out[name] = parts.join(' | ')
      }
      return out
    },
    { states, htmlSrc: html.toString(), probe }
  )

  const seen = new Map()
  for (const [k, v] of Object.entries(results)) {
    const prior = seen.get(v)
    if (prior === undefined) {
      seen.set(v, k)
      continue
    }
    if (inertPair(prior, k)) continue
    console.log(`COLLISION [${label}]: "${prior}"  ===  "${k}"`)
    collisions++
  }
  for (const [k, v] of Object.entries(results)) console.log(label.padEnd(12), k.padEnd(34), v)
  console.log('')
  return results
}

/** The pointer/keyboard states every control owes, as class suffixes. */
const POINTER = [
  ['', []],
  ['+hover', ['F-hover']],
  ['+active', ['F-hover', 'F-active']],
  ['+focus', ['F-focus-visible']]
]

// ---- 1. The plugin table's ROW -----------------------------------------------
// Four independent flags, all of which can be true at once: enabled, broken,
// something in flight, and — new — a row-level failure sentence. Every
// combination is reachable, so every combination is resolved.
const rowStates = {}
for (const on of [false, true])
  for (const failed of [false, true])
    for (const busy of [false, true])
      for (const [pn, pc] of [
        ['', []],
        ['+hover', ['F-hover']],
        ['+focus-within', ['F-focus-within']]
      ]) {
        const name = `${on ? 'on' : 'off'}${failed ? '+broken' : ''}${busy ? '+busy' : ''}${pn}`
        rowStates[name] = {
          cls: [
            ...(on ? ['is-on'] : []),
            ...(failed ? ['is-failed'] : []),
            ...(busy ? ['is-busy'] : []),
            ...pc
          ]
        }
      }
await group(
  'plug-row',
  rowStates,
  (s) =>
    `<div class="plug-table"><div class="plug-row ${s.cls.join(' ')}" data-probe role="row">` +
    `<div class="plug-cell plug-cell-name"><span class="plug-name">n</span><span class="plug-blurb">b</span></div>` +
    `<div class="plug-cell plug-cell-status"><span class="plug-state plug-state-idle"><span class="plug-state-word">w</span></span></div>` +
    `</div></div>`,
  ['.plug-name', '.plug-blurb']
)

// ---- 2. The enable TOGGLE ----------------------------------------------------
// `aria-disabled`, never `disabled` — a disabled control dispatches no pointer or
// focus event, so its explanation would be readable by nobody. Which means busy
// and blocked are still hoverable and focusable, and therefore still owe those
// states a look of their own.
const toggleStates = {}
for (const on of [false, true])
  for (const mode of ['live', 'busy', 'blocked'])
    for (const [pn, pc] of POINTER) {
      toggleStates[`${on ? 'on' : 'off'}/${mode}${pn}`] = {
        cls: [...(on ? ['is-on'] : []), ...(mode === 'busy' ? ['is-busy'] : []), ...pc],
        refusing: mode !== 'live'
      }
    }
await group(
  'toggle',
  toggleStates,
  (s) =>
    `<div class="plug-cell plug-cell-toggle"><button type="button" data-probe ` +
    `class="settings-switch plug-switch ${s.cls.join(' ')}"${s.refusing ? ' aria-disabled="true"' : ''}>` +
    `<span class="settings-switch-knob"></span></button></div>`,
  ['.settings-switch-knob']
)

// ---- 3. The row's BUTTONS ----------------------------------------------------
// Configure, Remove, its confirmation, Keep, Test and Save. Each is its own
// group: they are deliberately allowed to look like one another, and only their
// OWN states must differ.
const btnGroup = (label, base, variants) => {
  const states = {}
  for (const [vn, v] of Object.entries(variants))
    for (const [pn, pc] of POINTER)
      states[`${vn}${pn}`] = { cls: [...base, ...v.cls, ...pc], refusing: v.refusing }
  return group(
    label,
    states,
    (s) =>
      `<div class="plug-cell plug-cell-actions"><button type="button" data-probe ` +
      `class="${s.cls.join(' ')}"${s.refusing ? ' aria-disabled="true"' : ''}>x</button></div>`
  )
}
await btnGroup('configure', ['btn', 'btn-secondary', 'btn-sm'], {
  idle: { cls: [] },
  'refused(broken)': { cls: [], refusing: true }
})
await btnGroup('remove', ['btn', 'btn-sm'], {
  idle: { cls: ['btn-secondary'] },
  'refused(bundled)': { cls: ['btn-secondary'], refusing: true },
  confirming: { cls: ['btn-danger'] },
  removing: { cls: ['btn-danger', 'plug-busy'], refusing: true }
})
await btnGroup('test', ['btn', 'btn-secondary'], {
  idle: { cls: [] },
  'refused(blocked)': { cls: [], refusing: true },
  busy: { cls: ['plug-busy'], refusing: true }
})
await btnGroup('save', ['btn', 'btn-primary'], {
  idle: { cls: [] },
  'refused(unchanged)': { cls: [], refusing: true },
  busy: { cls: ['plug-busy'], refusing: true }
})

// ---- 4. A parameter FIELD ----------------------------------------------------
// `is-rejected` sets its own border AND fill, which is precisely why its hover
// and focus are stated separately in the CSS: without them a pointer over the
// one field the user has to correct looks like a pointer over nothing.
const fieldStates = {}
for (const rejected of [false, true])
  for (const [pn, pc] of [
    ['', []],
    ['+hover', ['F-hover']],
    ['+focus', ['F-focus']]
  ])
    fieldStates[`${rejected ? 'rejected' : 'idle'}${pn}`] = { rejected, pc }
await group(
  'field',
  fieldStates,
  (s) =>
    `<div class="set-fields plug-fields"><label class="set-field plug-field${s.rejected ? ' is-rejected' : ''}">` +
    `<span class="set-label">l</span><input data-probe class="input ${s.pc.join(' ')}"/></label></div>`
)

// ---- 5. The sharing modal's MODE buttons -------------------------------------
const modeStates = {}
for (const on of [false, true])
  for (const [pn, pc] of POINTER)
    modeStates[`${on ? 'selected' : 'unselected'}${pn}`] = {
      cls: [...(on ? ['is-on'] : []), ...pc],
      on
    }
await group(
  'share-mode',
  modeStates,
  (s) =>
    `<div class="share-modes" role="tablist"><button type="button" role="tab" data-probe ` +
    `aria-selected="${s.on}" class="share-mode ${s.cls.join(' ')}">x</button></div>`
)

// ---- 6. The project PICKS ----------------------------------------------------
// The tick is part of the state and is compared: selection here is signalled on
// two channels (fill and glyph), which is what keeps it legible without colour.
const pickStates = {}
for (const on of [false, true])
  for (const [pn, pc] of POINTER)
    pickStates[`${on ? 'picked' : 'unpicked'}${pn}`] = { cls: [...(on ? ['is-on'] : []), ...pc], on }
await group(
  'share-pick',
  pickStates,
  (s) =>
    `<div class="share-picks"><button type="button" data-probe aria-pressed="${s.on}" ` +
    `class="share-pick ${s.cls.join(' ')}">` +
    `<span class="share-pick-check">${s.on ? '✓' : ''}</span>` +
    `<span class="share-pick-name">n</span><span class="share-pick-size mono">1 paper</span></button></div>`,
  ['.share-pick-check', '.share-pick-name']
)

// ---- 7. The already-shared ROWS ----------------------------------------------
// The four sync states are mutually exclusive; a STOP THAT FAILED is not — it can
// be true of a row in any of them, which is why it is carried on its own channel
// (a dashed edge) rather than as a fifth value.
//
// INCOMPLETE is a THIRD orthogonal channel — rows this version can never store
// is a fact about the corpus, so it composes with any sync state and with a stop
// that failed. It is crossed with all of them because that is where the edges
// run out: the left border already carries the sync state and is dashed by
// `is-stop-failed`, so the shortfall had to find one of its own.
const shareRowStates = {}
for (const sync of ['in-step', 'out-of-step', 'failed', 'syncing'])
  for (const short of [false, true])
    for (const stopFailed of [false, true])
      for (const [pn, pc] of [
        ['', []],
        ['+hover', ['F-hover']]
      ]) {
        // UNREACHABLE, so not enumerated: `outOfSync` in the component is false
        // whenever the row is resting-short, because the shortfall is then the
        // whole reason `inSync` is false. Resolving it anyway would pad the
        // count with eight states that never ship — coverage the script claims
        // and the UI does not have.
        if (sync === 'out-of-step' && short) continue
        const cls = {
          'in-step': [],
          'out-of-step': ['is-out-of-sync'],
          failed: ['is-failed'],
          syncing: ['is-syncing']
        }[sync]
        shareRowStates[`${sync}${short ? '+short' : ''}${stopFailed ? '+stop-failed' : ''}${pn}`] = {
          cls: [
            ...(short ? ['is-incomplete'] : []),
            ...cls,
            ...(stopFailed ? ['is-stop-failed'] : []),
            ...pc
          ],
          stopFailed,
          short,
          sync
        }
      }
await group(
  'share-row',
  shareRowStates,
  (s) =>
    `<div class="share-list"><div class="share-row ${s.cls.join(' ')}" data-probe>` +
    `<span class="share-row-name">n</span><span class="share-row-role">r</span>` +
    // The CHIPS the component actually renders, so the badge row is part of the
    // signature rather than an assumption. None is rendered on the ordinary
    // case (hard rule 0.6), so a healthy row has no node here at all.
    (s.sync === 'out-of-step' ? `<span class="badge badge-warn">Not in sync</span>` : '') +
    (s.sync === 'failed' ? `<span class="badge badge-danger">Sync failed</span>` : '') +
    (s.short
      ? `<span class="badge badge-warn" tabindex="0"><span>3 rows not stored</span>` +
        `<span class="share-row-sr">s</span></span>`
      : '') +
    `<button type="button" class="btn btn-secondary share-stop">Stop sharing</button>` +
    (s.stopFailed ? `<span class="share-row-error">e</span>` : '') +
    `</div></div>`,
  ['.share-row-name', '.share-row-role', '.share-row-error', '.badge-warn', '.badge-danger']
)

// ---- 7b. The shortfall BADGE itself ------------------------------------------
// It is `tabIndex={0}` — the sentence saying a retry will not help is in its
// tooltip, which a pointer reaches and a keyboard does not — so it owes a focus
// ring, and that ring must differ from its resting and hovered looks.
await group(
  'share-declined-badge',
  {
    idle: { cls: [] },
    hover: { cls: ['F-hover'] },
    focus: { cls: ['F-focus-visible'] }
  },
  (s) =>
    `<div class="share-list"><div class="share-row is-incomplete">` +
    `<span class="badge badge-warn ${s.cls.join(' ')}" tabindex="0" data-probe>` +
    `<span>3 rows not stored</span><span class="share-row-sr">s</span></span></div></div>`
)

// ---- 8. The Stop button ------------------------------------------------------
// Refusing here has TWO causes with different sentences — this row is stopping,
// or another one is — but one look, deliberately: they are the same instruction
// (wait), and the tooltip carries the difference.
// `failed` is PRESSABLE — trying again is exactly what the user should do — so
// unlike the refusing states it owes a distinct hover, press and focus.
await btnGroup('share-stop', ['btn', 'btn-secondary', 'share-stop'], {
  idle: { cls: [] },
  'refused(another)': { cls: [], refusing: true },
  stopping: { cls: ['plug-busy'], refusing: true },
  failed: { cls: ['is-failed'] }
})

// ---- 9. The invitation's COPY button -----------------------------------------
// `is-copied` is a two-second acknowledgement, so it must read as different from
// the resting button at a glance AND still respond to a second press.
const copyStates = {}
for (const copied of [false, true])
  for (const [pn, pc] of POINTER)
    copyStates[`${copied ? 'copied' : 'idle'}${pn}`] = { cls: [...(copied ? ['is-copied'] : []), ...pc] }
await group(
  'invite-copy',
  copyStates,
  (s) =>
    `<div class="share-pane share-invite"><div class="form-actions">` +
    `<button type="button" data-probe class="btn btn-primary ${s.cls.join(' ')}">x</button></div></div>`
)

// ---- 10. The `choice` param's radio group ------------------------------------
// The real `<input type="radio">` is present and visually hidden, because
// `.plug-choice-opt:has(input:focus-visible)` is the ONLY focus rule here — a
// harness with no input can never match it and would report a focus state that
// does not exist.
const choiceStates = {}
for (const on of [false, true])
  for (const rejected of [false, true])
    for (const [pn, pc] of [
      ['', []],
      ['+hover', ['F-hover']],
      ['+active', ['F-hover', 'F-active']],
      ['+focus', ['__focus__']]
    ])
      choiceStates[`${on ? 'on' : 'off'}${rejected ? '+rejected' : ''}${pn}`] = {
        opt: [...(on ? ['is-on'] : []), ...pc.filter((c) => c !== '__focus__')],
        field: rejected ? ['is-rejected'] : [],
        focus: pc.includes('__focus__')
      }
await group(
  'choice',
  choiceStates,
  (s) =>
    `<div class="set-field plug-field plug-choice ${s.field.join(' ')}"><div class="plug-choice-options">` +
    `<label class="plug-choice-opt ${s.opt.join(' ')}" data-probe>` +
    `<input type="radio"${s.focus ? ' class="F-focus-visible"' : ''}/>` +
    `<span class="plug-choice-mark"></span>` +
    `<span class="plug-choice-text"><span class="plug-choice-label">l</span>` +
    `<span class="plug-choice-help">h</span></span></label></div></div>`,
  ['.plug-choice-mark', '.plug-choice-label']
)

// ---- 11. Dangling classes ----------------------------------------------------
// A className with no rule behind it is a state that was written and never
// styled — the failure this whole file exists to catch, one step earlier.
const SOURCES = [
  'src/renderer/components/settings/Plugins.tsx',
  'src/renderer/components/SharingModal.tsx',
  'src/renderer/components/SyncStatusIcon.tsx'
]
const rawCss = ['src/renderer/styles.css', 'src/renderer/styles/plugins.css']
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n')
let dangling = 0
for (const src of SOURCES) {
  const tsx = readFileSync(src, 'utf8')
  // Only tokens that are UNAMBIGUOUSLY class names: whitespace-separated words
  // inside a `className` value, plus the `' is-x'` fragments the conditional
  // concatenations append. A bare identifier out of a ternary (`busy`, `on`) is
  // not a class and reporting it as one made the check something to ignore.
  const tokens = new Set()
  const addAll = (s) => {
    for (const t of s.split(/[\s${}]+/)) if (/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(t)) tokens.add(t)
  }
  for (const m of tsx.matchAll(/className=(?:\{`|"|\{')([^"`']*)/g)) addAll(m[1])
  for (const m of tsx.matchAll(/'\s(is-[\w-]+|[\w-]+-[\w-]+)'/g)) addAll(m[1])
  const missing = [...tokens].filter((t) => !new RegExp(`\\.${t}(?![\\w-])`).test(rawCss))
  if (missing.length) {
    console.log(`DANGLING in ${src}: ${missing.join(', ')}`)
    dangling += missing.length
  }
}
if (dangling === 0) console.log('no dangling classes\n')

console.log(
  collisions === 0
    ? 'OK — every plugin and sharing control state resolves to a distinct style'
    : `${collisions} COLLISION(S)`
)
await b.close()
process.exit(collisions === 0 && dangling === 0 ? 0 : 1)
