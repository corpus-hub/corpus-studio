// Resolves the computed style of EVERY state of the in-paper find bar's mode
// switch and its by-meaning candidate list, and asserts no two render alike.
//
// The pair this surface must keep apart is NAVIGABLE vs INERT: a candidate that
// looks pressable and then draws nothing in the document is the failure this
// repo treats as production-blocking. Alongside it sits CHECKING, which is a
// WAIT rather than a refusal and must read as neither of the other two.
//
// The switch has its own trap: the option that is already ON is a no-op when
// pressed, so hovering it is easy to leave unstyled — and then the pointer
// lands on pixels that do not move, which reads as a dead control.
//
// Reads the BUILT css so the real cascade across styles.css and paper.css is
// exercised rather than a hand-picked subset. Pseudo-classes are rewritten into
// real classes because a headless page cannot be made to hover.
import { chromium } from '@playwright/test'
import { readFileSync, readdirSync, statSync } from 'node:fs'

const dir = 'out/renderer/assets'
const built = readdirSync(dir).filter((f) => f.startsWith('index-') && f.endsWith('.css'))
let css = built.map((f) => readFileSync(`${dir}/${f}`, 'utf8')).join('\n')

// A build older than the source it is meant to prove would let this pass on CSS
// that no longer exists — the "verified a stale build" failure this repo has hit
// before. Refuse rather than reassure.
const SOURCES = ['src/renderer/styles.css', 'src/renderer/styles/paper.css']
const newestSource = Math.max(...SOURCES.map((f) => statSync(f).mtimeMs))
const oldestBuilt = Math.min(...built.map((f) => statSync(`${dir}/${f}`).mtimeMs))
if (built.length === 0 || newestSource > oldestBuilt) {
  console.log(`FAIL: ${dir} predates the stylesheets it should contain — run \`npm run build\` first`)
  process.exit(1)
}

for (const ps of ['hover', 'active', 'focus-visible', 'focus', 'focus-within']) {
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
  'box-shadow', 'outline-color', 'outline-width', 'outline-style', 'opacity',
  // Underlines and italics survive grayscale, so they are read alongside hue.
  'text-decoration-line', 'text-decoration-color', 'font-style',
  // An animation IS a state: a `checking` row that stopped breathing would read
  // as a settled `inert` one, which is the wrong claim.
  'animation-name', 'cursor', 'transform', 'background-image', 'filter'
]

const results = await p.evaluate(
  ({ INTERACTIONS, PROPS }) => {
    const r = document.getElementById('r')
    const out = {}
    const read = (el) =>
      PROPS.map((k) => `${k}=${getComputedStyle(el).getPropertyValue(k)}`).join('|')

    // ---- the mode switch: on/off x interaction ----
    // BOTH options are enumerated in both positions. The on-option's hover and
    // press are the ones most easily left unstyled, and they are exactly the
    // ones a user meets when they press the mode they are already in.
    for (const on of [false, true]) {
      for (const [iName, iCls] of Object.entries(INTERACTIONS)) {
        r.innerHTML = `<div class="pv-find"><div class="pv-find-modes"><button id="m"
          class="pv-find-mode ${iCls.join(' ')}" ${on ? 'data-on="1"' : ''}>Verbatim</button></div></div>`
        out[`mode/${on ? 'on' : 'off'}/${iName}`] = read(r.querySelector('#m'))
      }
    }
    // The group shell, which carries the focus ring for whichever option holds
    // focus. Without it a keyboard user sees the ring on a 3px-tall segment.
    for (const [iName, iCls] of [['default', []], ['within', ['S-focus-within']]]) {
      r.innerHTML = `<div class="pv-find"><div id="g" class="pv-find-modes ${iCls.join(' ')}">
        <button class="pv-find-mode">V</button></div></div>`
      out[`modes/x/${iName}`] = read(r.querySelector('#g'))
    }

    // ---- a candidate row: reach x picked x interaction ----
    // `inert` and `checking` are rendered as DISABLED buttons, so only the
    // states the browser will really put them in are enumerated — asserting a
    // focus collision on an element that cannot take focus reports a problem no
    // user can reach, and that is how a check stops being believed.
    //
    // `picked` is enumerated for the non-pressable reaches too: a zoom rebuilds
    // the text index and re-probes the row whose band is currently on screen,
    // so a picked row CAN find itself checking or inert. One whose selection
    // signal vanished would tell the reader nothing is shown while a band sits
    // in the document.
    for (const reach of ['navigable', 'inert', 'checking']) {
      const pressable = reach === 'navigable'
      for (const picked of [false, true]) {
        for (const cursor of [false, true]) {
          // The non-pressable reaches get focus states too, because
          // `aria-disabled` leaves them in the tab order — the price of a
          // refusal that can explain itself is that it is a real focus target.
          // Only `active` is withheld: they never depress.
          const inters = pressable
            ? Object.entries(INTERACTIONS)
            : Object.entries(INTERACTIONS).filter(([n]) => n !== 'active')
          for (const [iName, iCls] of inters) {
            // `aria-disabled`, NOT the `disabled` attribute. A truly disabled
            // button takes no pointer events and no focus, so its `data-tip`
            // could never be shown — the refusal would not explain itself. That
            // also means the non-pressable rows ARE hoverable and focusable, so
            // their hover treatment below is a state a user really reaches
            // rather than one only this script can see.
            r.innerHTML = `<div class="pv-meaning-panel"><ul class="pv-meaning-list"><li><button id="c"
              class="pv-meaning-row ${iCls.join(' ')}" data-reach="${reach}"
              ${picked ? 'data-picked="1"' : ''} ${cursor ? 'data-cursor="1"' : ''}
              ${pressable ? '' : 'aria-disabled="true"'}>
              <span class="pv-meaning-rank">1</span>
              <span class="pv-meaning-main"><span class="pv-meaning-quote">q</span>
              <span class="pv-meaning-meta"><span class="pv-meaning-reach">r</span></span></span>
              <span class="pv-meaning-side"><span class="pv-meaning-score">0.81</span></span>
              </button></li></ul></div>`
            const tag = `${reach}${picked ? '+picked' : ''}${cursor ? '+cursor' : ''}`
            out[`row/${tag}/${iName}`] = read(r.querySelector('#c'))
          }
        }
      }
    }

    // ---- the quote and the score INSIDE the row ----
    // These are the words the reader actually reads, so the reach has to be
    // legible in them and not only in the row's frame.
    for (const reach of ['navigable', 'inert', 'checking']) {
      r.innerHTML = `<div class="pv-meaning-row" data-reach="${reach}">
        <span id="q" class="pv-meaning-quote">q</span>
        <span id="s" class="pv-meaning-score">0.81</span></div>`
      out[`quote/${reach}/default`] = read(r.querySelector('#q'))
      out[`score/${reach}/default`] = read(r.querySelector('#s'))
    }

    // ---- the reach words themselves: "locating…" vs "not locatable" ----
    // A wait and a refusal must not be the same treatment: one asks for
    // patience, the other says patience will not help.
    r.innerHTML = `<span id="x" class="pv-meaning-reach">locating…</span>`
    out['reachword/checking'] = read(r.querySelector('#x'))
    r.innerHTML = `<span id="x" class="pv-meaning-reach pv-meaning-reach-bad">not locatable</span>`
    out['reachword/inert'] = read(r.querySelector('#x'))

    // ---- the panel's notes: an ordinary hint vs one that reports a problem ----
    r.innerHTML = `<p id="n" class="pv-meaning-note">x</p>`
    out['note/plain'] = read(r.querySelector('#n'))
    r.innerHTML = `<p id="n" class="pv-meaning-note pv-meaning-note-bad">x</p>`
    out['note/bad'] = read(r.querySelector('#n'))

    // ---- busy: the sweeping mark that says a forward pass is running ----
    r.innerHTML = `<span id="x" class="pv-meaning-spark"></span>`
    out['busy/spark'] = read(r.querySelector('#x'))

    // ---- the verbatim step buttons, unchanged but still verified: this change
    // moved them into a branch, and a control that lost its cascade would look
    // fine in the mode nobody screenshots. ----
    for (const dis of [false, true]) {
      const inters = dis ? [['default', []], ['hover', ['S-hover']]] : Object.entries(INTERACTIONS)
      for (const [iName, iCls] of inters) {
        r.innerHTML = `<div class="pv-find"><button id="s"
          class="pv-find-step ${iCls.join(' ')}" ${dis ? 'disabled' : ''}>x</button></div>`
        out[`step/${dis ? 'disabled' : 'enabled'}/${iName}`] = read(r.querySelector('#s'))
      }
    }

    // ---- close, which is on the bar in BOTH modes and was never enumerated ----
    for (const [iName, iCls] of Object.entries(INTERACTIONS)) {
      r.innerHTML = `<div class="pv-find"><button id="c"
        class="pv-find-close ${iCls.join(' ')}">x</button></div>`
      out[`close/x/${iName}`] = read(r.querySelector('#c'))
    }

    // ---- the two things that occupy the SAME slot in the two modes ----
    // A stepper and a key hint standing in one place must not be mistaken for
    // one another mid-swap.
    r.innerHTML = `<div class="pv-find"><span id="k" class="pv-find-keys"><kbd id="kb">x</kbd></span></div>`
    out['slot/keys'] = read(r.querySelector('#k'))
    out['kbd/x/default'] = read(r.querySelector('#kb'))
    r.innerHTML = `<div class="pv-find"><button id="k" class="pv-find-step">x</button></div>`
    out['slot/step'] = read(r.querySelector('#k'))

    // ---- the header's explanatory hint, which is hoverable (cursor:help) ----
    for (const [iName, iCls] of [['default', []], ['hover', ['S-hover']]]) {
      r.innerHTML = `<div class="pv-meaning-head"><span id="h"
        class="pv-meaning-head-hint ${iCls.join(' ')}">passages, not phrases</span></div>`
      out[`hint/x/${iName}`] = read(r.querySelector('#h'))
    }

    // ---- the panel, which scrolls: an edge cue or the list just looks ended ----
    r.innerHTML = `<div id="p" class="pv-meaning-panel"></div>`
    out['panel/x/default'] = read(r.querySelector('#p'))

    // ---- the input, which changes placeholder but must not change identity ----
    for (const [iName, iCls] of [
      ['default', []], ['hover', ['S-hover']], ['focus', ['S-focus']],
      ['focus+hover', ['S-focus', 'S-hover']]
    ]) {
      r.innerHTML = `<div class="pv-find"><input id="i" class="pv-find-input ${iCls.join(' ')}"></div>`
      out[`input/x/${iName}`] = read(r.querySelector('#i'))
    }

    return out
  },
  { INTERACTIONS, PROPS }
)

// A SECOND pass with reduced motion forced on.
//
// `checking` and `inert` are partly told apart by the breathe animation, and
// `prefers-reduced-motion` removes it — so a reader who has asked for less
// motion could be shown a wait and a refusal as the same pixels. That is the
// user this repo is most obliged to, and it is invisible to a pass that only
// ever runs with animation enabled.
const rm = await b.newPage()
await rm.emulateMedia({ reducedMotion: 'reduce' })
await rm.setContent(`<style>${css}</style><div id="r"></div>`)
const reduced = await rm.evaluate(
  ({ PROPS }) => {
    const r = document.getElementById('r')
    const out = {}
    const read = (el) =>
      PROPS.map((k) => `${k}=${getComputedStyle(el).getPropertyValue(k)}`).join('|')
    for (const reach of ['navigable', 'inert', 'checking']) {
      for (const [iName, iCls] of [['default', []], ['hover', ['S-hover']]]) {
        r.innerHTML = `<div class="pv-meaning-panel"><ul class="pv-meaning-list"><li><button id="c"
          class="pv-meaning-row ${iCls.join(' ')}" data-reach="${reach}"
          ${reach === 'navigable' ? '' : 'aria-disabled="true"'}>
          <span class="pv-meaning-quote">q</span></button></li></ul></div>`
        out[`reduced/${reach}/${iName}`] = read(r.querySelector('#c'))
      }
    }
    return out
  },
  { PROPS }
)
Object.assign(results, reduced)

await b.close()

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
      // OWN hover — a deliberate choice about pressability, not a collision.
      if (name.replace('/active', '/hover') === prior) continue
      collisions++
      console.log(`COLLISION [${fam}] ${prior}  ===  ${name}`)
    } else seen.set(style, name)
  }
  console.log(`${fam}: ${entries.length} states, ${seen.size} distinct`)
}

// The WORDS are the differentiator that survives grayscale, and two of them
// carry the honesty of the whole feature.
const src = readFileSync('src/renderer/components/FindByMeaning.tsx', 'utf8')
// A cosine is not a confidence. A `%` anywhere near the score would convert a
// distance into a certainty the model never expressed.
if (/fmtSimilarity[^\n]*%|score[^\n]*toFixed\([^)]*\)\s*\}?\s*%/.test(src)) {
  collisions++
  console.log('COLLISION [words] a similarity is rendered as a percentage')
}
// Ten is a reading budget. A bare count would read as a count of what exists in
// the paper, which the search cannot know.
if (!src.includes('The closest')) {
  collisions++
  console.log('COLLISION [words] a full candidate list does not say it is the CLOSEST n')
}
// "This paper is not embedded" and "nothing in it matched" are opposite claims
// and must be different sentences.
if (!src.includes('pdf-find-meaning-unavailable') || !src.includes('pdf-find-meaning-empty')) {
  collisions++
  console.log('COLLISION [words] unembedded and no-matches are not separately rendered')
}

console.log(collisions === 0 ? 'OK: no state collisions' : `FAIL: ${collisions} collision(s)`)
process.exit(collisions === 0 ? 0 : 1)
