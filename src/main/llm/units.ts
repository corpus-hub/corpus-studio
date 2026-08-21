// Canonical form of a UNIT as a paper printed it.
//
// WHY THIS EXISTS. The same quantity arrives spelled a dozen ways: `s^-1`,
// `1/s`, `s⁻¹`, `s−1` (a real minus, U+2212), `s 2 1` (a PDF text layer that
// lost the superscript). Stored as opaque strings they do not compare, so a
// corpus-wide question — is this value in range, is this field reported in one
// unit — silently answers on spelling rather than on physics. Worse, `mM` and
// `µM` are a thousandfold apart and pooled as bare numbers one of them always
// reads as an outlier.
//
// WHAT IT DOES NOT DO. It never rewrites what the paper said. The ontology
// requires the raw value and unit to be preserved (CLAUDE.md §3), so this
// produces an ADDITIONAL canonical pair stored alongside the raw one
// (`measurement.unit_canonical`, `measurement.value_canonical`); the raw
// columns are untouched and remain what every reader is shown.
//
// DOMAIN-AGNOSTIC. Nothing here knows about kcat, KM or melting points. It
// knows SI prefixes, the units of time, amount-concentration, temperature and
// molar energy, and how a PDF mangles an exponent. Any domain reporting in SI
// gets the same treatment; a unit it does not recognise is returned unchanged
// with a factor of 1, which is honest rather than wrong.

/** A unit reduced to a comparable form, and how to move a value into it. */
export interface CanonicalUnit {
  /** The canonical spelling, e.g. `s^-1`, `M^-1 s^-1`, `M`, `°C`. */
  unit: string
  /** value_canonical = value * scale + offset. */
  scale: number
  offset: number
  /** False when no component was recognised — the spelling is passed through. */
  recognised: boolean
}

/**
 * Dimensionless quantities, each keyed to the TAG it reduces to.
 *
 * They carry no unit, but they are not one quantity. A percentage, a fold
 * change, a bare ratio and a pH are mutually unconvertible: pH is a negative
 * logarithm, a percentage is a hundredth, a fold change is a quotient of two
 * measurements. Collapsing them all to "" made every pair of them compare
 * EQUAL, so a field declared in `%` accepted a pH without a murmur. Distinct
 * tags keep them apart; `dimensionsCompatible` then declines to affirm across
 * two different tags rather than accusing, because which of these words a paper
 * uses for a quotient is a labelling convention, not physics.
 */
const DIMENSIONLESS: Record<string, string> = {
  dimensionless: '1',
  unitless: '1',
  none: '1',
  count: '1',
  fold: 'fold',
  foldchange: 'fold',
  foldincrease: 'fold',
  x: 'fold',
  ratio: 'ratio',
  ph: 'pH',
  phunit: 'pH',
  phunits: 'pH',
  '%': '%',
  percent: '%'
}

/**
 * Base units, keyed by their canonical spelling.
 *
 * `symbols` are matched WITH CASE. SI makes case carry meaning in both halves
 * of a symbol — the prefix (`m` milli vs `M` mega, `n` nano vs `N` newton, `p`
 * pico vs `P` peta) and the unit (`s` second vs `S` siemens, `m` metre vs `M`
 * molar) — so a case-insensitive match does not widen tolerance, it invents
 * facts: `mm` read as `mM` is a millimetre stored as a millimolar, and the
 * resulting `value_canonical` is wrong by a factor no reader can see.
 *
 * `words` are matched WITHOUT case, because a spelled-out name has no case
 * convention to violate: `Fold`, `fold` and `FOLD` are one word, and no other
 * quantity is spelled the same letters in another case. Sentence-cased words at
 * the start of a table cell are common, and rejecting them would cost accuracy
 * for nothing.
 */
const BASE: Array<{ canonical: string; symbols?: Record<string, number>; words?: Record<string, number> }> = [
  {
    canonical: 's',
    symbols: { s: 1, h: 3600, ms: 1e-3, ns: 1e-9 },
    words: { sec: 1, secs: 1, second: 1, seconds: 1, min: 60, mins: 60, minute: 60, minutes: 60, hr: 3600, hour: 3600, hours: 3600 }
  },
  {
    canonical: 'M',
    symbols: { M: 1, mM: 1e-3, uM: 1e-6, µM: 1e-6, μM: 1e-6, nM: 1e-9, pM: 1e-12, fM: 1e-15 },
    words: { molar: 1, 'mol/l': 1, moll: 1 }
  },
  { canonical: 'kcal/mol', words: { 'kcal/mol': 1, kcalmol: 1, 'kcal mol': 1, 'kj/mol': 0.239006, kjmol: 0.239006 } },
  { canonical: 'g/mol', words: { 'g/mol': 1, gmol: 1, da: 1, dalton: 1, kda: 1000 } },
  { canonical: 'Å', symbols: { 'Å': 1, nm: 10, pm: 0.01 }, words: { angstrom: 1 } },
  {
    canonical: 'L',
    symbols: { L: 1, l: 1, mL: 1e-3, ml: 1e-3, uL: 1e-6, µL: 1e-6, μL: 1e-6 },
    words: { litre: 1, liter: 1 }
  }
]

/**
 * Temperature is the one quantity here whose conversion is not a scale factor.
 * Celsius is canonical because it is what this corpus overwhelmingly reports
 * and because it keeps assay temperatures readable.
 */
const TEMPERATURE_SYMBOLS: Record<string, { scale: number; offset: number }> = {
  C: { scale: 1, offset: 0 },
  '°C': { scale: 1, offset: 0 },
  '°K': { scale: 1, offset: -273.15 },
  K: { scale: 1, offset: -273.15 }
}
const TEMPERATURE_WORDS: Record<string, { scale: number; offset: number }> = {
  degc: { scale: 1, offset: 0 },
  celsius: { scale: 1, offset: 0 },
  centigrade: { scale: 1, offset: 0 },
  degk: { scale: 1, offset: -273.15 },
  kelvin: { scale: 1, offset: -273.15 }
}

/** Exact-case symbols. */
const symbolLookup = new Map<string, { canonical: string; factor: number }>()
/** Lowercased spelled-out names. */
const wordLookup = new Map<string, { canonical: string; factor: number }>()
for (const b of BASE) {
  for (const [form, factor] of Object.entries(b.symbols ?? {})) {
    symbolLookup.set(form, { canonical: b.canonical, factor })
  }
  for (const [form, factor] of Object.entries(b.words ?? {})) {
    wordLookup.set(form.toLowerCase(), { canonical: b.canonical, factor })
  }
}

/**
 * Spellings whose case a text layer destroyed and whose intent is nonetheless
 * certain, because the OTHER reading names a quantity this module does not
 * know.
 *
 * `m` is the whole list. Length here is carried by `Å`, `nm` and `pm`; the
 * metre has no entry and no route to one, so a lone `m` cannot be a metre in
 * this vocabulary — while `M^-1 s^-1` printed as `m  1 s  1` is 13 rows of a
 * real corpus, produced by the same text layer that eats superscripts. This
 * list may only grow for a spelling whose alternative reading is likewise
 * absent: the moment the metre is added, `m` must move to the ambiguous side.
 */
const CASE_DAMAGE_TOLERATED: Record<string, string> = { m: 'M' }

/**
 * Undo the ways a PDF text layer prints an exponent.
 *
 * Superscript digits survive as `⁻¹`; a real minus arrives as U+2212; and when
 * the superscript is lost entirely the layer emits `s 2 1` (the `⁻` glyph
 * mapped to `2`) or `M  1 s  1` (the sign dropped, leaving a gap). Only the
 * first two are unambiguous, so the last two are recognised solely in the
 * position where an exponent can stand: directly after a unit letter.
 */
function normaliseGlyphs(raw: string): string {
  return (
    raw
      // The superscript minus first, so `⁻¹` becomes one exponent rather than a
      // sign and a separate power.
      .replace(/⁻\s*([⁰¹²³⁴⁵⁶⁷⁸⁹]+)/g, (_, d: string) =>
        '^-' + [...d].map((c) => '⁰¹²³⁴⁵⁶⁷⁸⁹'.indexOf(c)).join('')
      )
      .replace(/([⁰¹²³⁴⁵⁶⁷⁸⁹]+)/g, (d) => '^' + [...d].map((c) => '⁰¹²³⁴⁵⁶⁷⁸⁹'.indexOf(c)).join(''))
      .replace(/[·∙*×✕⋅]/g, ' ')
      .replace(/[\u2212\u2010-\u2015]/g, '-')
      // An exponent whose minus glyph the text layer dropped outright, leaving
      // only the space it occupied: `M  1 s  1`. Read before the whitespace
      // collapse below, because the DOUBLE space is the entire evidence — a
      // single space is ordinary spacing, and a rule that reached into it would
      // read the `24 h` of `mutants per 24 h` as an exponent.
      .replace(/([A-Za-zÅåµμ]) {2,}(\d)\b/g, '$1^-$2')
      .replace(/\s+/g, ' ')
      // `kcal mol^-1` is the same unit as `kcal/mol`; naming its two halves
      // separately would canonicalise the two spellings differently.
      .replace(/\b(kcal|kj)\s*(?:\/\s*mol|mol\s*\^-1)/gi, (_, e: string) => `${e}/mol`)
      // An exponent the text layer printed away from its unit: `s -1`, `s − 1`.
      // Only directly after a unit letter, where nothing else can stand.
      .replace(/([A-Za-zÅåµμ])\s*\^?\s*-\s*(\d)\b/g, '$1^-$2')
      // The same, with the minus glyph mapped to `2` — the artefact this
      // corpus's PDFs produce for a lost superscript minus (`s 2 1`).
      .replace(/([A-Za-zÅåµμ])\s+2\s+(\d)\b/g, '$1^-$2')
      // `M^-1s^-1` — the printed unit ran two terms together with no space.
      .replace(/(\^-?\d+)(?=[A-Za-zÅåµμ])/g, '$1 ')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

/** One `unit^exponent` term. */
interface Term {
  unit: string
  exp: number
}

/**
 * Split a normalised unit string into terms, honouring `/` as an inversion of
 * everything after it (`1/s`, `mol/L/s`) and `^` / a bare trailing signed
 * integer as an exponent.
 */
function parseTerms(s: string): Term[] | null {
  const terms: Term[] = []
  // `kcal/mol` and `mol/l` are single units whose slash is part of the name.
  let text = s
  for (const compound of ['kcal/mol', 'kJ/mol', 'g/mol', 'mol/L', 'mol/l']) {
    text = text.replace(new RegExp(compound.replace('/', '\\s*/\\s*'), 'gi'), compound.replace('/', '\u0001'))
  }
  let sign = 1
  for (const chunk of text.split('/')) {
    const piece = chunk.trim()
    if (piece === '' || piece === '1') {
      // A leading `1/` only flips what follows.
      if (sign === 1 && terms.length === 0) sign = -1
      else sign = -sign
      continue
    }
    for (const tok of piece.split(' ')) {
      const t = tok.trim().replace(/\u0001/g, '/')
      if (t === '') continue
      const m = /^([A-Za-zÅåµμ°%][A-Za-z/µμ°%]*)(?:\^?\s*(-?\d+))?$/.exec(t)
      if (!m) return null
      const exp = m[2] === undefined ? 1 : Number(m[2])
      if (!Number.isFinite(exp) || exp === 0) return null
      terms.push({ unit: m[1], exp: exp * sign })
    }
    if (sign === 1 && terms.length > 0) sign = -1
  }
  return terms.length > 0 ? terms : null
}

/**
 * Resolve one term's unit, ABSTAINING wherever case leaves it ambiguous.
 *
 * Order: exact symbol, then spelled-out word (case-folded), then the one
 * tolerated case-damaged spelling. Anything else is undefined, which the caller
 * turns into `recognised: false` — and `recognised: false` makes every consumer
 * silent: the dimension check returns `null` instead of `false`, and the
 * canonicaliser stores NULL instead of a number. Silence is the only safe
 * answer to an ambiguous symbol, because both ways of guessing are worse than
 * saying nothing: guessing one way accuses a correct record of being
 * structurally invalid, guessing the other writes a `value_canonical` that is
 * wrong by three or six orders of magnitude and looks perfectly clean.
 */
function lookupBase(u: string): { canonical: string; factor: number } | undefined {
  const direct = symbolLookup.get(u)
  if (direct) return direct
  const word = wordLookup.get(u.toLowerCase())
  if (word) return word
  const repaired = CASE_DAMAGE_TOLERATED[u]
  if (repaired !== undefined) return symbolLookup.get(repaired)
  return undefined
}

const passthrough = (unit: string): CanonicalUnit => ({
  unit,
  scale: 1,
  offset: 0,
  recognised: false
})

/**
 * Reduce a unit as printed to a canonical spelling plus the affine transform
 * that carries a value reported in it into that spelling.
 *
 * Returns `recognised: false` for anything it cannot decompose, echoing the
 * input — an unknown unit must not silently become a known one.
 */
export function canonicalUnit(rawUnit: string | null | undefined): CanonicalUnit {
  const raw = (rawUnit ?? '').trim()
  if (raw === '') return { unit: '', scale: 1, offset: 0, recognised: false }

  const flat = raw.toLowerCase().replace(/[\s.]/g, '')
  const tag = DIMENSIONLESS[flat]
  if (tag !== undefined) return { unit: tag, scale: 1, offset: 0, recognised: true }

  const norm = normaliseGlyphs(raw)

  const temp =
    TEMPERATURE_SYMBOLS[norm] ?? TEMPERATURE_WORDS[norm.toLowerCase().replace(/[\s°.]/g, '')]
  if (temp) return { unit: '°C', scale: temp.scale, offset: temp.offset, recognised: true }

  const terms = parseTerms(norm)
  if (terms === null) return passthrough(raw)

  const byCanonical = new Map<string, number>()
  let scale = 1
  for (const t of terms) {
    const base = lookupBase(t.unit)
    if (base === undefined) return passthrough(raw)
    scale *= Math.pow(base.factor, t.exp)
    byCanonical.set(base.canonical, (byCanonical.get(base.canonical) ?? 0) + t.exp)
  }

  const parts = [...byCanonical.entries()]
    .filter(([, e]) => e !== 0)
    // Sorted so `M^-1 s^-1` and `s^-1 M^-1` are one unit, not two.
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([u, e]) => (e === 1 ? u : `${u}^${e}`))

  // Every exponent cancelled: `M/M` is a bare ratio.
  if (parts.length === 0) return { unit: '1', scale, offset: 0, recognised: true }
  return { unit: parts.join(' '), scale, offset: 0, recognised: true }
}

/**
 * Can a quantity reported in `measuredUnit` stand in a field declared in
 * `declaredUnit`?
 *
 * This is a question about DIMENSIONS, not about magnitudes or about the
 * domain: `kcal/mol` is an energy and `s^-1` is a rate, and no factor carries
 * one into the other. Canonicalisation already answers it, because reducing a
 * unit strips exactly the things that are allowed to differ — the SI prefix
 * (`mM` and `µM` both reduce to `M`), the spelling (`1/s`, `s⁻¹`, `min^-1` all
 * reduce to `s^-1`), the term order — and keeps exactly the things that are
 * not. So two units are interchangeable iff they reduce to the same canonical
 * spelling.
 *
 * Returns `null`, not `false`, when either side cannot be reduced: an unknown
 * spelling is not evidence of a mismatch, and refusing a value because we
 * failed to parse its unit would be a worse error than the one being caught.
 * The same abstention covers two DIFFERENT dimensionless tags — `%` against
 * `fold`, `ratio` against `pH`. Neither converts into the other, but which of
 * those words a paper puts on a bare number is a labelling convention rather
 * than physics, and this function's `false` is wired to a STRUCTURAL badge.
 */
export function dimensionsCompatible(
  declaredUnit: string | null | undefined,
  measuredUnit: string | null | undefined
): boolean | null {
  const declared = (declaredUnit ?? '').trim()
  const measured = (measuredUnit ?? '').trim()
  // A field that declares no unit imposes no dimension; a value that carries
  // none makes no claim about one.
  if (declared === '' || measured === '') return null
  const a = canonicalUnit(declared)
  const b = canonicalUnit(measured)
  if (!a.recognised || !b.recognised) return null
  if (a.unit === b.unit) return true
  if (DIMENSIONLESS_TAGS.has(a.unit) && DIMENSIONLESS_TAGS.has(b.unit)) return null
  return false
}

/** The tags a dimensionless quantity can reduce to; see `DIMENSIONLESS`. */
const DIMENSIONLESS_TAGS: ReadonlySet<string> = new Set(Object.values(DIMENSIONLESS))

/**
 * A comparator the PDF text layer destroyed, recovered from the text it left.
 *
 * The glyphs for `>` and `<` survive extraction in this corpus as the letters
 * `N` and `b`, so `>95 °C` arrives as `N 95`. Read literally that is a bare
 * figure, and a bare figure is a point measurement — a limit silently becomes
 * a result that can be averaged, ranked and compared with real ones.
 *
 * Deliberately narrow. It fires only where the whole text is a lone letter
 * followed by a figure, so a subject called `N 95` or a note that mentions a
 * letter cannot reach it; and the caller is expected to confirm the figure is
 * the one being stored as the value.
 *
 * Returns the comparator the letter stands for, or `null` for anything else.
 */
export function mangledComparator(valueText: string | null | undefined): string | null {
  const t = (valueText ?? '').trim()
  // `N`/`b` only, case-sensitive: those are the substitutions this text layer
  // makes, and widening to any letter would swallow `n = 3` and unit prefixes.
  const m = /^([Nb])\s*[~≈]?\s*(\d[\d.,]*)\s*([^\s\d]*[^\d]*)$/.exec(t)
  if (m === null) return null
  // What follows the figure may only be a unit — anything else is prose, and
  // prose means the letter was a word, not a comparator.
  const tail = m[3].trim()
  if (tail !== '' && canonicalUnit(tail).recognised === false) return null
  return m[1] === 'N' ? '>' : '<'
}

/**
 * The figure inside a mangled bound, so a caller can confirm it is the number
 * that was about to be stored as a point value.
 */
export function mangledBoundFigure(valueText: string | null | undefined): number | null {
  if (mangledComparator(valueText) === null) return null
  const m = /(\d[\d.,]*)/.exec((valueText ?? '').trim())
  if (m === null) return null
  const n = Number(m[1].replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

/**
 * The canonical pair to store for one measurement: the unit reduced, and the
 * value moved into it. `null` where there is nothing to canonicalise, so a
 * consumer can tell "not comparable" from "comparable and equal to zero".
 */
export function canonicaliseMeasurement(
  value: number | null | undefined,
  rawUnit: string | null | undefined
): { unit: string | null; value: number | null } {
  const c = canonicalUnit(rawUnit)
  if (!c.recognised) return { unit: null, value: null }
  const unit = c.unit === '' ? '' : c.unit
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return { unit, value: null }
  }
  return { unit, value: value * c.scale + c.offset }
}
