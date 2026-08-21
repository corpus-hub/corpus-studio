// The adversarial boundary of unit canonicalisation.
//
// Two failure modes pull in OPPOSITE directions and this file pins both.
//
// Too tolerant: SI symbols differ by case (`m` metre / `M` molar, `n` nano /
// `N` newton, `s` second / `S` siemens), so a case-insensitive lookup turns a
// millimetre into a millimolar and writes a `value_canonical` wrong by a
// thousandfold that nothing reports. It also read `nm` and `nM` as different
// DIMENSIONS, which badged a correct record structurally invalid.
//
// Too strict: this module exists to forgive a PDF text layer, and `m  1 s  1`
// is `M^-1 s^-1` with the superscripts destroyed — 13 rows of the live corpus.
// A fix that makes case significant must not start rejecting it.
//
// The safe answer to an ambiguous spelling is NEITHER reading: `recognised:
// false`, which makes the dimension check return `null` and the canonicaliser
// store NULL.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalUnit, canonicaliseMeasurement, dimensionsCompatible } from './units'

const canon = (u: string): string | null => {
  const c = canonicalUnit(u)
  return c.recognised ? c.unit : null
}

test('symbols that differ only by case are different quantities', () => {
  assert.equal(canon('nM'), 'M')
  assert.equal(canonicalUnit('nM').scale, 1e-9)
  assert.equal(canon('nm'), 'Å')
  assert.equal(canonicalUnit('nm').scale, 10)
  assert.equal(canon('mM'), 'M')
  assert.equal(canonicalUnit('mM').scale, 1e-3)
  assert.equal(canon('pM'), 'M')
  assert.equal(canon('pm'), 'Å')
})

test('an ambiguous case-damaged symbol ABSTAINS rather than guessing', () => {
  // Each of these previously resolved by case-folding to a unit it is not.
  for (const u of ['um', 'Ml', 'MS', 'H', 'PM', 'NM', 'MM', 'Nm', 'FM', 'S']) {
    assert.equal(canonicalUnit(u).recognised, false, `${u} must not be recognised`)
    assert.equal(canonicaliseMeasurement(1, u).value, null, `${u} must store no canonical value`)
  }
})

test('an unrecognised unit never states a dimension mismatch', () => {
  assert.equal(dimensionsCompatible('mM', 'MM'), null)
  assert.equal(dimensionsCompatible('M', 'um'), null)
  assert.equal(dimensionsCompatible('s^-1', ''), null)
})

test('a millimetre is not admitted as a millimolar', () => {
  assert.notEqual(canon('mM'), canon('mm'))
  assert.notEqual(dimensionsCompatible('mM', 'mm'), true)
})

test('dimensionless quantities are not mutually convertible', () => {
  assert.notEqual(canon('%'), canon('pH'))
  assert.notEqual(canon('fold'), canon('ratio'))
  assert.notEqual(canon('%'), canon('fold'))
  // …but the disagreement is a labelling convention, so the check abstains
  // rather than badging the row structurally invalid.
  assert.equal(dimensionsCompatible('%', 'pH'), null)
  assert.equal(dimensionsCompatible('fold', 'ratio'), null)
  assert.equal(dimensionsCompatible('fold', 'Fold change'), true)
  assert.equal(dimensionsCompatible('%', 'percent'), true)
})

test('a dimensionless tag is not compatible with a dimensioned unit', () => {
  assert.equal(dimensionsCompatible('%', 'mM'), false)
  assert.equal(dimensionsCompatible('pH', 's^-1'), false)
})

test('THE FORGIVING CASES: text-layer damage still canonicalises', () => {
  const rate = 'M^-1 s^-1'
  assert.equal(canon(rate), 'M^-1 s^-1')
  // Term order.
  assert.equal(canon('s^-1 M^-1'), canon(rate))
  // Superscripts destroyed, sign lost, gap left behind — the 13-row case.
  assert.equal(canon('m  1 s  1'), canon(rate))
  assert.equal(canon('M  1 s  1'), canon(rate))
  assert.equal(canon('M 2 1 s 2 1'), canon(rate))
  assert.equal(canon('M⁻¹ s⁻¹'), canon(rate))
  assert.equal(canon('M−1 s−1'), canon(rate))
  assert.equal(canon('M⁻¹s⁻¹'), canon(rate))
  assert.equal(canon('s^-1 ∙ M^-1'), canon(rate))
  assert.equal(canon('M ‒ 1 s ‒ 1'), canon(rate))
  assert.equal(canon('m⁻¹ s⁻¹'), canon(rate))
  assert.equal(dimensionsCompatible(rate, 'm  1 s  1'), true)
})

test('the three micro glyphs are one unit', () => {
  assert.equal(canonicalUnit('μM').scale, 1e-6)
  assert.equal(canonicalUnit('µM').scale, 1e-6)
  assert.equal(canonicalUnit('uM').scale, 1e-6)
  assert.equal(dimensionsCompatible('μM', 'µM'), true)
  assert.equal(dimensionsCompatible('uM', 'µM'), true)
})

test('temperature: °C, C, K and the spelled-out names', () => {
  assert.equal(canon('°C'), '°C')
  assert.equal(canon('C'), '°C')
  assert.equal(dimensionsCompatible('C', '°C'), true)
  assert.equal(canonicalUnit('K').offset, -273.15)
  assert.equal(canonicalUnit('Kelvin').offset, -273.15)
  assert.equal(canonicalUnit('celsius').offset, 0)
})

test('spelled-out names stay case-insensitive', () => {
  // A word has no case convention to violate: no other quantity is these same
  // letters in another case.
  assert.equal(canon('Minutes'), 's')
  assert.equal(canonicalUnit('MIN').scale, 60)
  assert.equal(canon('Angstrom'), 'Å')
  assert.equal(canon('kJ/mol'), 'kcal/mol')
})

test('canonical values move the number, and only where the unit resolved', () => {
  assert.equal(canonicaliseMeasurement(5, 'mM').value, 5e-3)
  assert.equal(canonicaliseMeasurement(5, 'nm').value, 50)
  assert.equal(canonicaliseMeasurement(5, 'nM').value, 5e-9)
  assert.deepEqual(canonicaliseMeasurement(5, 'MM'), { unit: null, value: null })
})
