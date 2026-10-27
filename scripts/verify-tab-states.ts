/**
 * Prove that no two tab-strip states render identically.
 *
 * Hard rule 0.5 says every state must be visually DISTINCT from every other,
 * and that where the state space is non-trivial this must be COMPUTED rather
 * than eyeballed. It is non-trivial here: 8 tab flags combine with 4 close-button
 * states, and CSS specificity decides the winner in ways that are not visible by
 * reading the file top to bottom. That is not hypothetical — the first pass had
 * `.tabstrip-close:disabled` (0,2,0) silently losing to
 * `.tabstrip-tab.is-selected .tabstrip-close` (0,2,1), so the last tab's close
 * button looked exactly like one that closes.
 *
 * Run: `npx tsx scripts/verify-tab-states.ts`
 *
 * It parses the stylesheet and resolves cascade order itself rather than driving
 * a browser, because opening a real browser is forbidden in this project and
 * because the question — "which declaration wins for this set of classes" — is
 * answerable from the CSS alone.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const cssPath = resolve(here, '../src/renderer/styles/tabs.css')
const css = readFileSync(cssPath, 'utf8')

/**
 * The properties a state is JUDGED on: what a user can actually see.
 *
 * SHAPE properties (`border-radius`, `transform`, the mark's dimensions) are in
 * here, not only colours. Motion cannot be a state's distinguishing partner —
 * the reduced-motion pass below turns every animation off and re-checks — so a
 * pair that differs only by an animation has to differ by a shape as well.
 */
const VISUAL = [
  'background',
  'color',
  'border-bottom-color',
  'border-bottom-style',
  'border-color',
  'border-style',
  'border-radius',
  'width',
  'height',
  'transform',
  'font-weight',
  'opacity',
  'box-shadow',
  'outline',
  'text-decoration',
  'animation'
]

interface Rule {
  selector: string
  order: number
  specificity: number
  decls: Record<string, string>
}

/**
 * Strip comments, then split into rules.
 *
 * `@keyframes` blocks are dropped — they are not declarations that apply to an
 * element. `prefers-reduced-motion` is NOT dropped: it is INLINED when
 * `reducedMotion` is set, because that branch turns animations off, and a pair
 * of states whose only difference was an animation then becomes a collision that
 * a user with motion disabled would actually see. That is exactly the case this
 * script exists to catch, and skipping the at-rule hid it.
 */
function parseRules(source: string, reducedMotion = false): Rule[] {
  let clean = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules: Rule[] = []
  let order = 0
  const rm = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?\})\s*\}/
  const rmMatch = rm.exec(clean)
  clean = clean.replace(rm, '')
  // Every other at-rule block goes: keyframes are not element declarations.
  let noAt = clean.replace(/@[a-z-]+[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '')
  // Appended LAST so it wins on source order at equal specificity, which is how
  // the cascade actually resolves it in the browser.
  if (reducedMotion && rmMatch) noAt += rmMatch[1]
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(noAt)) !== null) {
    const decls: Record<string, string> = {}
    for (const part of m[2].split(';')) {
      const i = part.indexOf(':')
      if (i < 0) continue
      decls[part.slice(0, i).trim()] = part.slice(i + 1).trim()
    }
    for (const selector of m[1].split(',')) {
      const s = selector.trim()
      if (!s) continue
      rules.push({ selector: s, order: order++, specificity: specificity(s), decls })
    }
  }
  return rules
}

/** Classes + pseudo-classes count 10, elements 1. No ids appear here. */
function specificity(selector: string): number {
  const classes = (selector.match(/\.[a-zA-Z][\w-]*/g) ?? []).length
  const pseudos = (selector.match(/:(?!:)[a-z-]+(?:\([^)]*\))?/g) ?? []).length
  const elements = (selector.match(/(?:^|[\s>+~])[a-z][\w-]*/g) ?? []).length
  return classes * 10 + pseudos * 10 + elements
}

/** One element of the strip, as a set of classes and active pseudo-classes. */
interface Element {
  classes: Set<string>
  pseudos: Set<string>
}

/**
 * Does `selector` match this element, treated as the LAST compound in a
 * descendant chain whose ancestors are supplied?
 */
function matches(selector: string, self: Element, ancestors: Element[]): boolean {
  // Only descendant combinators occur in this sheet.
  const parts = selector.split(/\s+/).filter(Boolean)
  const last = parts[parts.length - 1]
  if (!compoundMatches(last, self)) return false
  // Every earlier compound must match some ancestor, in order.
  let ai = 0
  for (const part of parts.slice(0, -1)) {
    let found = false
    while (ai < ancestors.length) {
      if (compoundMatches(part, ancestors[ai++])) {
        found = true
        break
      }
    }
    if (!found) return false
  }
  return true
}

function compoundMatches(compound: string, el: Element): boolean {
  // `:not(:disabled)` is the one functional pseudo in the sheet.
  const nots = [...compound.matchAll(/:not\(([^)]*)\)/g)].map((m) => m[1])
  const rest = compound.replace(/:not\([^)]*\)/g, '')
  for (const n of nots) {
    if (n.startsWith(':') && el.pseudos.has(n.slice(1))) return false
    if (n.startsWith('.') && el.classes.has(n.slice(1))) return false
  }
  for (const c of rest.match(/\.[a-zA-Z][\w-]*/g) ?? []) {
    if (!el.classes.has(c.slice(1))) return false
  }
  for (const p of rest.match(/:(?!:)[a-z-]+/g) ?? []) {
    if (!el.pseudos.has(p.slice(1))) return false
  }
  // A bare element name (`.route-area`, `ul`) — the sheet only uses classes for
  // the tab itself, so anything left that is not a class or pseudo fails.
  const bare = rest.replace(/\.[a-zA-Z][\w-]*/g, '').replace(/:(?!:)[a-z-]+/g, '').trim()
  return bare === '' || bare === '*'
}

function resolve_(rules: Rule[], self: Element, ancestors: Element[]): Record<string, string> {
  const winners: Record<string, { rule: Rule }> = {}
  for (const rule of rules) {
    if (!matches(rule.selector, self, ancestors)) continue
    for (const prop of Object.keys(rule.decls)) {
      if (!VISUAL.includes(prop)) continue
      const cur = winners[prop]
      if (
        !cur ||
        rule.specificity > cur.rule.specificity ||
        (rule.specificity === cur.rule.specificity && rule.order > cur.rule.order)
      ) {
        winners[prop] = { rule }
      }
    }
  }
  const out: Record<string, string> = {}
  for (const [prop, w] of Object.entries(winners)) out[prop] = w.rule.decls[prop]
  return out
}

// ---------------------------------------------------------------- the matrix

/**
 * The tab's own states, as the MARKUP actually emits them.
 *
 * Generated from the same combinations `TabStrip.tsx` can produce, not from a
 * tidier space: `is-detaching` is only ever applied ALONGSIDE `is-dragging`
 * (a tab is dragged out, it is not detached from rest), and `is-stale` can
 * co-occur with `is-failed` — a paper whose analysis failed and which was then
 * deleted is one tab in both states. Checking a space the component cannot reach
 * proves nothing about the one it can.
 *
 * `is-busy` is not a tab class: busy is carried entirely by the mark, so the
 * mark is folded into the signature below.
 */
const TAB_STATES: { name: string; classes: string[]; pseudos: string[]; mark: string | null }[] = []
for (const selected of [false, true]) {
  for (const status of ['', 'busy', 'failed', 'stale', 'stale+failed']) {
    // `is-leaving` (promised to a window that is still opening) is exclusive
    // with the user's own drag: the strip refuses to pick up a tab already in
    // flight, so the pair is unreachable.
    for (const drag of ['', 'is-dragging', 'is-dragging is-detaching', 'is-leaving']) {
      for (const pointer of ['', 'hover', 'active', 'focus-visible']) {
        // A tab under the pointer capture of a drag is not simultaneously being
        // hovered or pressed as a separate state — those pairs are unreachable.
        // A tab under pointer capture is not separately hovered or pressed.
        // A LEAVING tab can still be hovered — it is sitting in the strip — so
        // that combination is generated and must be distinct.
        if (drag !== '' && drag !== 'is-leaving' && pointer !== '') continue
        if (drag === 'is-leaving' && (pointer === 'active' || pointer === 'focus-visible')) continue
        const classes = [
          'tabstrip-tab',
          ...(selected ? ['is-selected'] : []),
          ...(status.includes('failed') ? ['is-failed'] : []),
          ...(status.includes('stale') ? ['is-stale'] : []),
          ...drag.split(' ').filter(Boolean)
        ]
        TAB_STATES.push({
          name: [
            selected ? 'selected' : 'default',
            status,
            drag.replace('is-dragging ', '').replace('is-', ''),
            pointer
          ]
            .filter(Boolean)
            .join('+'),
          classes,
          pseudos: pointer ? [pointer] : [],
          // Failed beats busy in the markup, so a tab never shows both marks.
          mark: status.includes('failed') ? 'is-failed' : status === 'busy' ? 'is-busy' : null
        })
      }
    }
  }
}

const CLOSE_STATES: { name: string; pseudos: string[] }[] = [
  { name: 'rest', pseudos: [] },
  { name: 'hover', pseudos: ['hover'] },
  { name: 'active', pseudos: ['hover', 'active'] },
  { name: 'focus-visible', pseudos: ['focus-visible'] },
  { name: 'disabled', pseudos: ['disabled'] }
]

let failures = 0

function report(group: string, seen: Map<string, string>, name: string, style: Record<string, string>): void {
  const sig = JSON.stringify(Object.entries(style).sort())
  const prior = seen.get(sig)
  if (prior !== undefined) {
    console.error(`COLLISION [${group}] "${name}" renders identically to "${prior}"\n  ${sig}`)
    failures++
  } else {
    seen.set(sig, name)
  }
}

/**
 * Check the whole matrix under one rendering condition.
 *
 * Run twice: once as the sheet is written, and once with the
 * `prefers-reduced-motion` branch inlined. The second pass is the one that
 * matters most for the status marks, because it turns off the breathing that
 * would otherwise be doing the work of telling "working" apart from "failed".
 */
function checkAll(rules: Rule[], condition: string): void {
  // --- the tab itself
  //
  // The signature includes the STATUS MARK, because for `busy` the mark IS the
  // whole signal: the tab body is deliberately untinted so that "this is
  // working" does not compete with "this is the one you selected" for the same
  // accent. Judging the body alone would report a false collision between busy
  // and plain, and would hide a real one if the mark were ever dropped.
  {
    const seen = new Map<string, string>()
    for (const s of TAB_STATES) {
      const self: Element = { classes: new Set(s.classes), pseudos: new Set(s.pseudos) }
      const style = resolve_(rules, self, [])
      if (s.mark) {
        const mark: Element = {
          classes: new Set(['tabstrip-mark', s.mark]),
          pseudos: new Set()
        }
        for (const [k, v] of Object.entries(resolve_(rules, mark, [self]))) {
          style[`mark:${k}`] = v
        }
      }
      report(`tab ${condition}`, seen, s.name, style)
    }
  }

  // --- the close button, compared WITHIN one tab context at a time
  //
  // Scoped per tab context deliberately. The requirement is that a user can tell
  // this button's states apart WHERE THEY ARE LOOKING; it is not that the button
  // on a selected tab must differ from the button on a hovered default one,
  // because in that comparison the tab itself already differs and carries the
  // distinction. Both are a 75%-opacity glyph, which is intended.
  //
  // `close:hover`/`close:active` are only generated under a hovered tab: the
  // pointer cannot be on the button without being on the tab containing it, so
  // the other half of that matrix is unreachable rather than colliding.
  for (const tabSel of [false, true]) {
    for (const tabHover of [false, true]) {
      const seen = new Map<string, string>()
      const tab: Element = {
        classes: new Set(['tabstrip-tab', ...(tabSel ? ['is-selected'] : [])]),
        pseudos: new Set(tabHover ? ['hover'] : [])
      }
      const ctx = `${tabSel ? 'selected' : 'default'}${tabHover ? '+tabhover' : ''}`
      for (const c of CLOSE_STATES) {
        if (c.pseudos.includes('hover') && !tabHover) continue
        const self: Element = { classes: new Set(['tabstrip-close']), pseudos: new Set(c.pseudos) }
        const style = resolve_(rules, self, [tab])
        // An invisible button is an invisible button: the glyph is deliberately
        // hidden on an unhovered, unselected tab, so two states that are both
        // fully transparent being one picture is the intent.
        if (style.opacity === '0') continue
        report(`close ${condition}`, seen, `${ctx} close:${c.name}`, style)
      }
    }
  }

  // --- the new-tab button
  {
    const seen = new Map<string, string>()
    for (const c of CLOSE_STATES) {
      const self: Element = { classes: new Set(['tabstrip-new']), pseudos: new Set(c.pseudos) }
      report(`new ${condition}`, seen, `new:${c.name}`, resolve_(rules, self, []))
    }
  }

  // --- the window controls, which share this row and therefore this sheet
  //
  // Checked per KIND rather than across kinds: minimize and maximize are meant
  // to look alike at rest — they differ by their glyph, which is markup, not
  // style — while close deliberately diverges once the pointer is on it. The
  // requirement is that a user can tell ONE button's states apart, which is the
  // comparison below.
  //
  // There is no disabled state: these three are the user's way out of a window
  // and always answer, so the reachable space is rest/hover/active/focus.
  for (const kind of ['plain', 'close']) {
    const seen = new Map<string, string>()
    for (const c of CLOSE_STATES) {
      if (c.pseudos.includes('disabled')) continue
      const self: Element = {
        classes: new Set(['win-btn', ...(kind === 'close' ? ['win-btn-close'] : [])]),
        pseudos: new Set(c.pseudos)
      }
      report(`win-${kind} ${condition}`, seen, `${kind}:${c.name}`, resolve_(rules, self, []))
    }
  }
}

checkAll(parseRules(css), 'normal')
checkAll(parseRules(css, true), 'reduced-motion')
console.log(`tab states checked: ${TAB_STATES.length} × 2 conditions`)

if (failures > 0) {
  console.error(`\n${failures} state collision(s).`)
  process.exit(1)
}
console.log('no two states render identically.')
