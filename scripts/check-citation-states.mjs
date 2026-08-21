// Resolves the computed style of EVERY state of the citation-context surface
// and asserts that no two render identically.
//
// Two states that look the same are a lie told to the pointer. The pair this
// screen most needs to keep apart is NAVIGABLE vs INERT: a card that looks
// pressable and then draws nothing in the document is the failure this repo
// treats as production-blocking, and the only defence at the CSS level is that
// the two never resolve to the same pixels — including through their
// combinations (`selected+hover` collapsing back into `selected` would tell the
// reader their pointer is dead over the one card that IS live).
//
// Reads the BUILT css so the real cascade (specificity and source order across
// styles.css, paper.css and citations.css) is exercised rather than a
// hand-picked subset. Pseudo-classes are rewritten into real classes for the
// same reason, and `:has()` alongside them because the group shell's focus ring
// is driven by its header button.
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
  'src/renderer/styles/citations.css',
  'src/renderer/styles/paper.css'
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
css = css.replaceAll(':has(.cc-group-head.S-focus-visible)', '.S-within')

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
  // Underlines and italics are differentiators that survive grayscale, so they
  // are read alongside the colour rather than left to be assumed.
  'text-decoration-line', 'text-decoration-color', 'font-style',
  // An animation IS a state. A `checking` card that stopped breathing would
  // otherwise read as a settled `inert` one, which is exactly the wrong claim.
  'animation-name', 'cursor', 'transform', 'background-image', 'filter'
]

const results = await p.evaluate(
  ({ INTERACTIONS, PROPS }) => {
    const r = document.getElementById('r')
    const out = {}
    const read = (el) =>
      PROPS.map((k) => `${k}=${getComputedStyle(el).getPropertyValue(k)}`).join('|')

    // ---- a citation card: reachability x selected x interaction ----
    // The whole point of the surface. `inert` and `checking` are not pressable,
    // so only the states they can really be in are enumerated — asserting a
    // `focus` collision on an element the browser will never focus reports a
    // problem no user can reach, and that is how a check stops being believed.
    // `selected` is enumerated for the NON-pressable reaches too, because both
    // are reachable: a zoom rebuilds the text index and re-checks a card that
    // is currently showing its band, and the viewer can refuse a card that was
    // already selected. A selected card whose selection signal vanishes tells
    // the reader nothing is on screen while a band sits in the document.
    for (const reach of ['navigable', 'inert', 'checking']) {
      const pressable = reach === 'navigable'
      for (const sel of [false, true]) {
        const inters = pressable ? Object.entries(INTERACTIONS) : [['default', []], ['hover', ['S-hover']]]
        for (const [iName, iCls] of inters) {
          const tag = pressable ? 'button' : 'div'
          r.innerHTML = `<div class="cc-places"><${tag} id="c"
            class="cc-place cc-place-${reach} ${sel ? 'is-selected' : ''} ${iCls.join(' ')}">
            <span class="cc-place-quote">q</span>
            <span class="cc-place-foot"><span class="cc-place-jump">j</span></span>
          </${tag}></div>`
          out[`place/${reach}${sel ? '+sel' : ''}/${iName}`] = read(r.querySelector('#c'))
        }
      }
    }

    // ---- the words in the card's footer, which is what a reader actually
    // reads. Colour alone would not survive grayscale. ----
    // A navigable card carries `cc-place-jump` (revealed on hover, held open by
    // selection); the two reaches that CANNOT be pressed carry `cc-place-blocked`
    // instead, and say so without being asked. Different elements, so each is
    // read from the card it belongs on.
    for (const reach of ['navigable', 'inert', 'checking']) {
      const word = reach === 'navigable' ? 'cc-place-jump' : 'cc-place-blocked'
      for (const sel of [false, true]) {
        for (const [iName, iCls] of [['default', []], ['hover', ['S-hover']]]) {
          r.innerHTML = `<div class="cc-place cc-place-${reach} ${sel ? 'is-selected' : ''} ${iCls.join(' ')}">
            <span class="cc-place-foot"><span id="j" class="${word}">j</span></span></div>`
          out[`jump/${reach}${sel ? '+sel' : ''}/${iName}`] = read(r.querySelector('#j'))
        }
      }
    }

    // ---- a filter dropdown: filtering vs at rest x open x interaction ----
    // A dropdown that is HIDING rows must not look like one at rest — a filter
    // that silently shrinks the list is the failure mode of this control.
    //
    // The trigger is a BUTTON carrying `.sel-trigger`, the shared listbox from
    // ui.tsx, so this exercises the same rules as every sort dropdown in the
    // app rather than a per-screen copy of them. OPEN is a state of its own
    // here because it is expressed on the trigger, through `aria-expanded`.
    for (const on of [false, true]) {
      for (const open of [false, true]) {
        for (const [iName, iCls] of Object.entries(INTERACTIONS)) {
          r.innerHTML = `<div class="cc-filters"><button id="c" aria-expanded="${open}"
            class="sel-trigger cc-select ${on ? 'is-narrowed' : ''} ${iCls.join(' ')}"
            ><span class="sel-value">any</span></button></div>`
          out[`select/${on ? 'on' : 'off'}${open ? '+open' : ''}/${iName}`] = read(
            r.querySelector('#c')
          )
        }
      }
    }

    // ---- the group header button, OPEN and closed ----
    // The shell itself is a hairline separator with no states of its own: every
    // state a group can be in is carried by this header, which is the element
    // the pointer is actually over.
    // An open group already carries the panel fill, so its header's hover has
    // to go further than a closed one's or `open+hover === open` and the
    // pointer reads as dead over the row the reader is working in.
    for (const open of [false, true]) {
      for (const [iName, iCls] of Object.entries(INTERACTIONS)) {
        r.innerHTML = `<div class="cc-group ${open ? 'is-open' : ''}"><button id="h"
          class="cc-group-head ${iCls.join(' ')}"><span class="cc-caret">c</span></button></div>`
        out[`head/${open ? 'open' : 'closed'}/${iName}`] = read(r.querySelector('#h'))
      }
    }

    // ---- the caret, which must ROTATE rather than swap glyphs ----
    for (const open of [false, true]) {
      for (const [iName, iCls] of [['default', []], ['hover', ['S-hover']]]) {
        r.innerHTML = `<div class="cc-group ${open ? 'is-open' : ''}"><button
          class="cc-group-head ${iCls.join(' ')}"><span id="c" class="cc-caret">▸</span></button></div>`
        out[`caret/${open ? 'open' : 'closed'}/${iName}`] = read(r.querySelector('#c'))
      }
    }

    // ---- the role mark: set vs NOT SET ----
    // The one pair that must never collide: a role is a claim, no role is the
    // absence of one, and `other` is a THIRD thing (a positive class).
    r.innerHTML = `<span id="x" class="cc-role cc-role-set">background</span>`
    out['role/set'] = read(r.querySelector('#x'))
    r.innerHTML = `<span id="x" class="cc-role cc-role-none">not classified</span>`
    out['role/none'] = read(r.querySelector('#x'))

    // ---- role provenance: a MODEL's judgement, which carries a probability,
    // must not read as the role label it sits beside. A cue rule carries no
    // number and answers on the role's own tooltip, so it has no mark here. ----
    r.innerHTML = `<span class="cc-role-wrap"><span id="s" class="cc-role cc-role-set">background</span>
      <span id="x" class="cc-rolesrc cc-rolesrc-llm">model</span></span>`
    out['rolesrc/llm'] = read(r.querySelector('#x'))
    out['rolesrc/role'] = read(r.querySelector('#s'))

    // ---- the shortfall pill: a reference the corpus does NOT hold ----
    // Its counterpart renders nothing, so this is compared against the title it
    // sits inside rather than against an "in corpus" twin.
    r.innerHTML = `<span id="t" class="cc-group-title">title<span id="x" class="cc-out">not in corpus</span></span>`
    out['out/pill'] = read(r.querySelector('#x'))
    out['out/title'] = read(r.querySelector('#t'))

    // ---- Import, as it appears INSIDE a citation group ----
    // Reused from the unresolved-references list, but no check script had ever
    // rendered it, so its 25 states were unverified by accident rather than by
    // decision.
    for (const [state, mod] of [
      ['none', ''], ['retrieving', 'is-busy'], ['failed', 'is-failed'],
      ['retrieved', 'is-done'], ['unretrievable', 'is-unretrievable']
    ]) {
      for (const [iName, iCls] of Object.entries(INTERACTIONS)) {
        r.innerHTML = `<div class="cc-group"><button id="s"
          class="pv-ref-open pv-ref-retrieve ${mod} ${iCls.join(' ')}">label</button></div>`
        out[`retrieve/${state}/${iName}`] = read(r.querySelector('#s'))
      }
    }

    // ---- "Read →" on a resolved group ----
    for (const [iName, iCls] of Object.entries(INTERACTIONS)) {
      r.innerHTML = `<div class="cc-group"><button id="o"
        class="pv-ref-open ${iCls.join(' ')}">Read</button></div>`
      out[`read/x/${iName}`] = read(r.querySelector('#o'))
    }

    // ---- the notes that explain why the surface is inert or filtered ----
    // These occupy the same slot and make opposite claims: one says a mode is
    // holding the viewer, the other that a filter is hiding rows.
    r.innerHTML = `<div id="n" class="cc-mode-note">x</div>`
    out['note/mode'] = read(r.querySelector('#n'))
    r.innerHTML = `<div id="n" class="cc-filter-note">x</div>`
    out['note/filter'] = read(r.querySelector('#n'))

    // ---- a context read from ANOTHER version of the paper ----
    r.innerHTML = `<span id="x" class="cc-place-otherdoc">other version</span>`
    out['where/otherdoc'] = read(r.querySelector('#x'))
    r.innerHTML = `<span id="x" class="cc-place-where">Results</span>`
    out['where/same'] = read(r.querySelector('#x'))
    // Only the EXCEPTIONAL occurrence kinds render, and one of them
    // ("bibliography entry") sits in the same footer slot as the section.
    r.innerHTML = `<span id="x" class="cc-place-kind">bibliography entry</span>`
    out['where/kind'] = read(r.querySelector('#x'))

    // ---- clear filters ----
    for (const [iName, iCls] of Object.entries(INTERACTIONS)) {
      r.innerHTML = `<div class="cc-filter-note"><button id="c"
        class="btn-link cc-filter-clear ${iCls.join(' ')}">clear filters</button></div>`
      out[`clear/x/${iName}`] = read(r.querySelector('#c'))
    }

    return out
  },
  { INTERACTIONS, PROPS }
)
await b.close()

// Collisions only mean something WITHIN a family: a filter chip and a group
// shell are never compared by eye, so comparing them proves nothing.
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

// The WORDS are the differentiator that survives grayscale, so they are checked
// rather than assumed. "not classified" must be its own phrase and must not be
// the word `other` — `other` is a positive class meaning a classifier looked
// and found none of the named uses to fit, and collapsing the two would turn
// 1000 unanswered callouts into 1000 confident answers.
const src = readFileSync('src/renderer/components/CitationContexts.tsx', 'utf8')
if (!/not classified/i.test(src)) {
  collisions++
  console.log('COLLISION [words] the unclassified case does not read "not classified"')
}
if (/CITATION_ROLE_LABEL\[[^\]]+\]\s*\?\?\s*'other'/.test(src)) {
  collisions++
  console.log('COLLISION [words] an unclassified context falls back to the `other` ROLE')
}
const types = readFileSync('src/shared/types.ts', 'utf8')
const labels = [...types.matchAll(/^ {2}'?([a-z-]+)'?: '([^']+)'/gm)].map((m) => m[2])
const roleLabels = labels.slice(0, 8)
if (new Set(roleLabels).size !== roleLabels.length) {
  collisions++
  console.log(`COLLISION [words] two citation roles share a label: ${roleLabels}`)
}

console.log(collisions === 0 ? 'OK: no state collisions' : `FAIL: ${collisions} collision(s)`)
process.exit(collisions === 0 ? 0 : 1)
