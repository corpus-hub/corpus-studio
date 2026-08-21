// Resolves the computed style of EVERY state of the Connectome edge popover's
// occurrence rows and asserts that no two render identically.
//
// This surface exists to answer three DIFFERENT questions about one citation —
// what the row IS (occurrence kind), how the citation is USED (role) and WHERE
// in the paper it sits (section + page) — and it previously answered them with
// two adjacent unlabelled chips that differed only in colour and size, with the
// third dropped entirely. The pairs that must never collide are therefore:
//
//   bibliography  vs  in-text callout   — a printed listing vs the author speaking
//   role set      vs  not classified    — a claim vs the absence of one
//   not classified vs  n/a              — "nobody looked" vs "does not apply"
//   rule          vs  model             — a regex vs a judgement
//   navigable     vs  inert             — a jump that lands vs one that cannot
//
// Reads the BUILT css so the real cascade is exercised rather than a hand-picked
// subset, and refuses to run against a build older than its sources — a check
// that passes on CSS which no longer exists reassures without proving anything.
import { chromium } from '@playwright/test'
import { readFileSync, readdirSync, statSync } from 'node:fs'

const dir = 'out/renderer/assets'
const built = readdirSync(dir).filter((f) => f.startsWith('index-') && f.endsWith('.css'))
let css = built.map((f) => readFileSync(`${dir}/${f}`, 'utf8')).join('\n')

const SOURCES = ['src/renderer/styles.css', 'src/renderer/styles/graph.css']
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

const PROPS = [
  'background-color', 'color', 'font-weight', 'font-size', 'letter-spacing',
  'border-top-color', 'border-top-width', 'border-top-style',
  'border-left-color', 'border-left-width', 'border-left-style',
  'border-bottom-color', 'border-bottom-width', 'border-bottom-style',
  'box-shadow', 'outline-color', 'outline-width', 'outline-style', 'opacity',
  // Underlines, italics and the leading glyph survive grayscale, so they are
  // read alongside the colour rather than left to be assumed.
  'text-decoration-line', 'text-decoration-style', 'text-decoration-color',
  'font-style', 'cursor', 'transform', 'background-image', 'filter',
  '-webkit-line-clamp',
  // A state that arrives instantly is a state that snaps. Read so "nothing
  // snaps" is asserted rather than believed.
  'transition-property', 'transition-duration'
]

const results = await p.evaluate(
  ({ INTERACTIONS, PROPS }) => {
    const r = document.getElementById('r')
    const out = {}
    const read = (el) =>
      PROPS.map((k) => `${k}=${getComputedStyle(el).getPropertyValue(k)}`).join('|')
    // ::before carries the kind glyph, which is the differentiator a colourblind
    // reader actually sees. A check that read only the element itself would call
    // two kinds identical while they render a ◆ and a ▤.
    const readWithGlyph = (el) =>
      read(el) +
      '||before:' +
      ['content', 'color', 'font-weight', 'transform']
        .map((k) => `${k}=${getComputedStyle(el, '::before').getPropertyValue(k)}`)
        .join('|')

    // ---- WHAT the row is. The pair the user's complaint turned on: a
    // bibliography line displayed exactly like an in-text sentence. ----
    for (const kind of ['inline', 'bibliography', 'footnote', 'unknown']) {
      r.innerHTML = `<div class="cg-edgecard-marks">
        <span id="x" class="cg-mark-value cg-mark-kind-value" data-kind="${kind}">k</span></div>`
      out[`kind/${kind}`] = readWithGlyph(r.querySelector('#x'))
    }

    // ---- HOW it is used. Three mutually exclusive claims about the SAME slot:
    // a role, no role yet, and no role possible. ----
    r.innerHTML = `<span id="x" class="cg-mark-value cg-role-set" data-role="support">supports</span>`
    out['use/set'] = read(r.querySelector('#x'))
    r.innerHTML = `<span id="x" class="cg-mark-value cg-role-none">not classified yet</span>`
    out['use/none'] = read(r.querySelector('#x'))
    r.innerHTML = `<span id="x" class="cg-mark-value cg-role-na">no argument to classify</span>`
    out['use/na'] = read(r.querySelector('#x'))

    // ---- the three MARK slots must not read as one another. They now sit on
    // ONE line separated only by a hairline, so the burden on their own
    // treatments is higher than when each had a label above it. ----
    r.innerHTML = `<div class="cg-edgecard-marks">
      <span id="x" class="cg-mark-value cg-place-value">results · p.4</span></div>`
    out['slot/place'] = read(r.querySelector('#x'))
    r.innerHTML = `<div class="cg-edgecard-marks">
      <span id="x" class="cg-mark-value cg-role-set">supports</span></div>`
    out['slot/use'] = read(r.querySelector('#x'))
    r.innerHTML = `<div class="cg-edgecard-marks">
      <span id="x" class="cg-mark-value cg-mark-kind-value" data-kind="inline">in-text</span></div>`
    out['slot/kind'] = read(r.querySelector('#x'))

    // ---- the DIVIDER is drawn only BETWEEN marks. A trailing hairline after
    // the last mark reads as a fourth, empty one, so the first mark in the row
    // and a following mark must not render alike. ----
    r.innerHTML = `<div class="cg-edgecard-marks">
      <span class="cg-mark-value cg-place-value">a</span>
      <span id="x" class="cg-mark-value cg-place-value">results · p.4</span></div>`
    out['divider/second'] = readWithGlyph(r.querySelector('#x'))
    r.innerHTML = `<div class="cg-edgecard-marks">
      <span id="x" class="cg-mark-value cg-place-value">results · p.4</span></div>`
    out['divider/first'] = readWithGlyph(r.querySelector('#x'))

    // ---- the passage: a sentence, a bibliography line, and each clamped or
    // expanded. A quote that looks the same open and shut would make the
    // expander read as dead. ----
    for (const bib of [false, true]) {
      for (const open of [false, true]) {
        r.innerHTML = `<div class="cg-edgecard-list"><div class="cg-edgecard-ctx">
          <div id="x" class="cg-edgecard-quote ${bib ? 'cg-edgecard-quote-bib' : ''} ${
            open ? 'is-open' : ''
          }">q</div></div></div>`
        out[`quote/${bib ? 'bib' : 'sentence'}${open ? '+open' : ''}`] = read(r.querySelector('#x'))
      }
    }
    // The placeholder must NOT wear the quote frame: a left rule beside "not
    // parsed yet" reads as evidence that was found.
    r.innerHTML = `<div id="x" class="cg-edgecard-await">none</div>`
    out['quote/await'] = read(r.querySelector('#x'))

    // ---- the jump. THE invariant: a card that can navigate and one that
    // cannot must never render alike, in any interaction state. `inert` is a
    // div and is not focusable, so only the states it can really be in are
    // enumerated — asserting a focus collision no user can reach is how a
    // check stops being believed. ----
    for (const [iName, iCls] of Object.entries(INTERACTIONS)) {
      r.innerHTML = `<div class="cg-edgecard-ctx"><button id="g"
        class="cg-edgecard-goto ${iCls.join(' ')}" data-reach="navigable">go</button></div>`
      out[`goto/navigable/${iName}`] = read(r.querySelector('#g'))
    }
    for (const [iName, iCls] of [['default', []], ['hover', ['S-hover']], ['active', ['S-active', 'S-hover']]]) {
      r.innerHTML = `<div class="cg-edgecard-ctx"><div id="g"
        class="cg-edgecard-goto cg-edgecard-goto-inert ${iCls.join(' ')}"
        data-reach="inert" aria-disabled="true">not locatable</div></div>`
      out[`goto/inert/${iName}`] = read(r.querySelector('#g'))
    }

    // ---- the clamp release. It sits directly under the jump and must not be
    // mistaken for it: one reveals text here, the other leaves this card. ----
    for (const [iName, iCls] of Object.entries(INTERACTIONS)) {
      for (const open of [false, true]) {
        r.innerHTML = `<div class="cg-edgecard-ctx"><button id="e"
          class="cg-edgecard-expand ${iCls.join(' ')}" aria-expanded="${open}">${
            open ? 'show less' : 'show all'
          }</button></div>`
        // The caret is what tells open from shut at a glance, so it is read.
        out[`expand/${open ? 'open' : 'shut'}/${iName}`] = readWithGlyph(r.querySelector('#e'))
      }
    }

    // ---- HOVER ANSWERS. Every mark's meaning lives in a tooltip, and a mark
    // that renders identically under the pointer never tells the reader the
    // tooltip is there — which is how the marks came to need asking about in
    // the first place. So each tip-bearing mark is read default vs hover,
    // INSIDE a pinned card, because the hover card sets `pointer-events: none`
    // and a rule scoped there could never fire. Recorded in its own family so
    // the pairs are compared to each other and not to unrelated marks. ----
    const TIPPED = [
      ['kind', `<span class="cg-mark-value cg-mark-kind-value" data-kind="inline" data-tip="t">k</span>`],
      ['role-set', `<span class="cg-mark-value cg-role-set" data-role="support" data-tip="t">supports</span>`],
      ['role-none', `<span class="cg-mark-value cg-role-none" data-tip="t">not classified yet</span>`],
      ['role-na', `<span class="cg-mark-value cg-role-na" data-tip="t">no argument to classify</span>`],
      ['place', `<span class="cg-mark-value cg-place-value" data-tip="t">results · p.4</span>`]
    ]
    for (const [name, html] of TIPPED) {
      for (const [st, cls] of [['default', ''], ['hover', 'S-hover']]) {
        r.innerHTML = `<div class="cg-edgecard cg-edgecard-pinned"><div class="cg-edgecard-marks">${html.replace(
          'class="',
          `class="${cls} `
        )}</div></div>`
        out[`tip-${name}/${st}`] = read(r.querySelector('[data-tip]'))
      }
    }

    // The inert marker must be FOCUSABLE and must look focused, or the only
    // account of why a passage cannot be opened is available to mouse users.
    for (const [st, cls] of [['default', ''], ['focus', 'S-focus-visible']]) {
      r.innerHTML = `<div id="g" class="cg-edgecard-goto cg-edgecard-goto-inert ${cls}"
        data-reach="inert" tabindex="0" aria-disabled="true">not locatable</div>`
      out[`inertfocus/${st}`] = read(r.querySelector('#g'))
    }

    return out
  },
  { INTERACTIONS, PROPS }
)
await b.close()

// Collisions only mean something WITHIN a family: a kind glyph and a jump
// affordance are never compared by eye, so comparing them proves nothing.
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
      // A control with no press treatment may have `active` match its OWN
      // hover — a deliberate choice about pressability, not a collision.
      if (name.replace('/active', '/hover') === prior) continue
      // The INERT jump is required to be unresponsive. It is not a control: it
      // does not react to hover or press, is not focusable, and says in words
      // why. Its states matching each other IS the design — what must never
      // hold is `inert === navigable`, which the loop still checks because both
      // are in this family. Scoped to the inert triple so a genuine collision
      // between the two reaches is not swallowed with it.
      if (/^goto\/inert\//.test(name) && /^goto\/inert\//.test(prior)) continue
      collisions++
      console.log(`COLLISION [${fam}] ${prior}  ===  ${name}`)
    } else seen.set(style, name)
  }
  console.log(`${fam}: ${entries.length} states, ${seen.size} distinct`)
}

// ---- NOTHING SNAPS. Any state that differs from its default must ease into
// it; a 0s transition on a hover treatment is a jump-cut. ----
for (const [name, style] of Object.entries(results)) {
  if (!/\/(hover|active|focus)/.test(name)) continue
  const base = results[name.replace(/\/[^/]+$/, '/default')]
  if (base === undefined || base === style) continue
  const dur = /transition-duration=([^|]*)/.exec(style)?.[1] ?? ''
  if (dur === '' || /^(0s)(,\s*0s)*$/.test(dur)) {
    collisions++
    console.log(`SNAP [${name}] differs from its default with transition-duration '${dur}'`)
  }
}

// ---- the WORDS, which are the differentiator that survives grayscale ----
const src = readFileSync('src/renderer/screens/GraphScreen.tsx', 'utf8')
const need = [
  // The bare word the user complained about must be gone: every occurrence
  // carried it, including the bibliography lines it was a false claim about.
  [!/>\s*\{?['"]?unclassified['"]?\}?\s*</.test(src), 'no bare "unclassified" chip remains'],
  [src.includes('not classified yet'), 'an unclassified in-text role says so in words'],
  [src.includes('no argument to classify'), 'a bibliography row says a role does not apply'],
  [src.includes('not locatable'), 'an unreachable passage says so rather than offering a jump'],
  // The marks are no longer introduced by a printed question — three stacked
  // label-and-value pairs made one citation four lines tall. The question each
  // answers must still be reachable, so every mark carries BOTH an aria-label
  // naming it and a data-tip spelling it out. A mark with neither is back to
  // being an unlabelled chip.
  [
    (src.match(/className="cg-mark-value/g) ?? []).length ===
      (src.match(/className="cg-mark-value[\s\S]{0,900}?aria-label=/g) ?? []).length,
    'every mark carries an aria-label naming what it answers'
  ],
  [
    (src.match(/className="cg-mark-value/g) ?? []).length ===
      (src.match(/className="cg-mark-value[\s\S]{0,900}?data-tip=/g) ?? []).length,
    'every mark carries a tooltip spelling out what it means'
  ],
  // Which RULE or MODEL decided a role is not shown here. The user asked for
  // it gone; it is still stored and still on the DTO, so the removal must be
  // a display decision and not a quiet data loss.
  [
    !/cg-rolesrc|self-rated|source not recorded/.test(src),
    'no role-provenance chip is rendered in the popover'
  ],
  [
    /role_source/.test(readFileSync('src/shared/contract.ts', 'utf8')) ||
      /role_source/.test(readFileSync('src/shared/types.ts', 'utf8')),
    'role provenance is still carried on the DTO'
  ],
  // The inert marker's REASON is carried by a tooltip, which the tooltip host
  // raises on focus as well as hover — so without a tab stop the explanation is
  // available to pointer users only.
  [
    /cg-edgecard-goto-inert[\s\S]*?tabIndex=\{0\}[\s\S]*?not locatable/.test(src),
    'the inert marker is focusable'
  ]
]
for (const [ok, what] of need) {
  if (!ok) {
    collisions++
    console.log(`COLLISION [words] ${what} — FAILED`)
  }
}

// The role vocabulary must be ONE list. `review` is in the DB CHECK and in the
// classifier prompt, so a UI list missing it renders a legal value as a raw
// enum member — visible, but only by accident.
const types = readFileSync('src/shared/types.ts', 'utf8')
const roles = [...(types.match(/CITATION_ROLES = \[([^\]]+)\]/s)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(
  (m) => m[1]
)
const labelBlock = types.match(/CITATION_ROLE_LABEL[^{]+\{([^}]+)\}/s)?.[1] ?? ''
const labelled = [...labelBlock.matchAll(/'?([a-z-]+)'?:\s*'([^']+)'/g)]
for (const role of roles) {
  if (!labelled.some(([, k]) => k === role)) {
    collisions++
    console.log(`COLLISION [words] role '${role}' has no human label`)
  }
}
const labelValues = labelled.map(([, , v]) => v)
if (new Set(labelValues).size !== labelValues.length) {
  collisions++
  console.log(`COLLISION [words] two citation roles share a label: ${labelValues}`)
}
console.log(`roles: ${roles.length} in the vocabulary, ${labelValues.length} labelled`)

console.log(collisions === 0 ? 'OK: no state collisions' : `FAIL: ${collisions} collision(s)`)
process.exit(collisions === 0 ? 0 : 1)
