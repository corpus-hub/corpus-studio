/**
 * Assert no two states of the Updates card render identically.
 *
 * Eight phases times the control states is exactly the space where two states
 * quietly resolve to the same appearance — and a card that looks the same
 * before and after a click tells the user their pointer is dead. Eyeballing has
 * missed this class of collision in this codebase before, so it is computed.
 *
 * It reads what each phase SAYS and OFFERS, checks that no two are the same,
 * and checks that every class the card names actually exists in the stylesheet.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const repo = join(import.meta.dirname, '..')
const css = readFileSync(join(repo, 'src/renderer/styles.css'), 'utf8')

const PHASES = [
  'idle',
  'checking',
  'uptodate',
  'available',
  'downloading',
  'ready',
  'ready-manual',
  'error'
] as const

const failures: string[] = []

// --- the base classes every control relies on actually existing -----------
//
// `className="btn ghost"` shipped once and rendered an invisible button,
// because `.ghost` is not a class this stylesheet defines. A name that does not
// resolve is indistinguishable from a name that does, until someone looks.
const component = readFileSync(
  join(repo, 'src/renderer/components/settings/Updates.tsx'),
  'utf8'
)
// Every class-shaped literal in the file, including the ones inside a template
// expression — `${busy ? ' is-busy' : ''}` is exactly where a typo hides, and
// stopping the scan at `$` made those invisible.
const used = new Set<string>()
for (const m of component.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
  // Two shapes of interpolation, and they must be told apart.
  //
  // `is-${state.phase}` names a FAMILY — the prefix is not a class and the
  // phase check below covers it, so the whole fragment goes.
  //
  // `btn-primary${busy ? ' is-busy' : ''}` is a class followed by a separate
  // expression that yields more classes. Only the `${...}` is unwrapped, and
  // the strings inside it are then scanned like any other — which is precisely
  // where a typo would otherwise be invisible.
  const withoutFamilies = (m[1] ?? m[2]).replace(/[A-Za-z][\w-]*-\$\{[^}]*\}/g, ' ')

  // OUTSIDE the expressions, every word is a class and is checked as one —
  // including a dashless one. `className="btn ghost"` is the exact bug this
  // exists for, and `ghost` has no dash, so a dash rule here would skip it.
  const plain = withoutFamilies.replace(/\$\{[^}]*\}/g, ' ')
  for (const cls of plain.trim().split(/\s+/)) if (cls) used.add(cls)

  // INSIDE them, the class is what the expression YIELDS — the branch results —
  // not what it tests against. `state.phase === 'checking' ? ' is-busy' : ''`
  // contains two string literals and only one of them is a class; taking both
  // reports every phase name as a missing style.
  for (const expr of withoutFamilies.matchAll(/\$\{([^}]*)\}/g)) {
    for (const branch of expr[1].matchAll(/[?:]\s*'([^']*)'/g)) {
      for (const cls of branch[1].trim().split(/\s+/)) if (cls) used.add(cls)
    }
  }
}
// Classes that reach a `className` INDIRECTLY, through the phase table
// (`className={`badge ${meta.badge.cls}`}`). The interpolation holds no literal,
// so scanning `className=` alone never sees them — which is the same
// invisible-name bug as `btn ghost`, one indirection further away. Any string
// literal in the file shaped like a class of ours is therefore checked too.
for (const m of component.matchAll(/'((?:badge|btn|upd|is)-[\w-]+)'/g)) used.add(m[1])

for (const cls of used) {
  if (!new RegExp(`\\.${cls}[\\s{,:.\\[]`).test(css)) {
    failures.push(`class "${cls}" is used by the card but defined nowhere in styles.css`)
  }
}

// --- the component must actually reach every phase -----------------------
//
// Styling eight phases proves nothing if the card never renders their classes,
// or never renders a control for one of them. Checked against the source rather
// than assumed, so gutting the component fails here rather than passing quietly.
if (!/is-\$\{state\.phase\}/.test(component)) {
  failures.push('the card does not put its phase on the section, so the phase styles never apply')
}
const PHASE_TABLE = /const PHASES = \{([\s\S]*?)\n\} as const/.exec(component)?.[1] ?? ''
for (const phase of PHASES) {
  if (!new RegExp(`['"]?${phase}['"]?:`).test(PHASE_TABLE)) {
    failures.push(`phase "${phase}" is missing from the card's phase table`)
  }
}
const ACTIONS: Record<string, string> = {
  available: 'download',
  downloading: 'cancel',
  ready: 'install',
  'ready-manual': 'reveal'
}
for (const [phase, handler] of Object.entries(ACTIONS)) {
  const offered = new RegExp(`phase === '${phase}'[\\s\\S]{0,600}onClick=\\{${handler}\\}`)
  if (!offered.test(component)) {
    failures.push(`phase "${phase}" offers no working ${handler} control`)
  }
}

// --- each phase must READ differently -------------------------------------
//
// The section is styled like every other one in Settings, so the phase is
// carried by what the card SAYS and OFFERS — its badge, its sentence, its
// action. Distinctness has to be checked there: two phases that word themselves
// identically and offer the same control leave the user unable to tell that
// anything happened.
const readings = new Map<string, string[]>()
for (const phase of PHASES) {
  const entry = new RegExp(`['"]?${phase}['"]?: \\{([\\s\\S]*?)\\n  \\}`).exec(PHASE_TABLE)
  if (!entry) continue
  const label = `${entry[1].replace(/\s+/g, ' ').trim()}|${ACTIONS[phase] ?? 'none'}`
  readings.set(label, [...(readings.get(label) ?? []), phase])
}
for (const [, phases] of readings) {
  if (phases.length > 1) {
    failures.push(`phases ${phases.join(' and ')} say and offer exactly the same thing`)
  }
}

// --- busy must be distinct from disabled, and must MOVE -------------------
if (!/\.btn\.is-busy\s*\{/.test(css)) {
  failures.push('.btn.is-busy is not styled, so a busy control looks merely disabled')
}
if (!/\.btn\.is-busy\s+\.btn-glyph\s*\{[^}]*animation/.test(css)) {
  failures.push('the busy state has no motion')
}
if (!/btn-glyph/.test(component)) {
  failures.push('no control renders a .btn-glyph, so its busy state cannot animate')
}

// --- nothing snaps --------------------------------------------------------
if (!/\.upd-progress-bar\s*\{[^}]*transition/.test(css)) {
  failures.push('the progress bar jumps rather than easing')
}

if (failures.length > 0) {
  console.error('Update card state check FAILED:\n')
  for (const f of failures) console.error(`  · ${f}`)
  process.exit(1)
}
console.log(`Update card: ${PHASES.length} phases, all distinct; every class resolves.`)
