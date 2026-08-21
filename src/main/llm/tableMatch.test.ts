import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  compareReadings,
  foldFigure,
  foldLabel,
  isWordingCandidate,
  marksAbsent,
  sameFigure,
  wordingPair
} from './tableMatch'

/** Named for readability in the notation tests below. */
const sameFigureForTest = sameFigure
import type { Disagreement, ReadCell, StoredCell } from './tableMatch'

// The case this whole mechanism was built for: work 4's R8-2/7A row, where the
// extraction slid three columns across a place the page marks "not measured".
// Two readers who cannot see each other disagree here; one reader shown the
// stored answer agreed with it four times out of four.
const readR8: ReadCell[] = [
  {
    row: 'R8-2/7A',
    column: '5-nitro BI',
    marked: null,
    values: [
      { quantity: 'kcat', value: '5.4 ± 0.8', unit: 's−1' },
      { quantity: 'KM', value: '0.44 ± 0.04', unit: 'mM' },
      { quantity: 'kcat/KM', value: '12,350 ± 774', unit: 'M−1 s−1' }
    ]
  },
  { row: 'R8-2/7A', column: '5,7-dichloro BI', marked: 'not measured', values: [] },
  {
    row: 'R8-2/7A',
    column: '6-chloro BI',
    marked: null,
    values: [
      { quantity: 'kcat', value: '0.0185 ± 0.0001', unit: 's−1' },
      { quantity: 'KM', value: '0.435 ± 0.005', unit: 'mM' },
      { quantity: 'kcat/KM', value: '42.3 ± 0.3', unit: 'M−1 s−1' }
    ]
  },
  {
    row: 'R8-2/7A',
    column: '6-fluoro BI',
    marked: null,
    values: [
      { quantity: 'kcat', value: '0.0060 ± 0.0002', unit: 's−1' },
      { quantity: 'KM', value: '1.03 ± 0.01', unit: 'mM' },
      { quantity: 'kcat/KM', value: '5.84 ± 0.01', unit: 'M−1 s−1' }
    ]
  }
]

const sv = (id: number, quantity: string, value: string): StoredCell['values'][number] => ({
  factId: id,
  measurementId: id,
  quantity,
  value,
  unit: null
})

test('a value stored where the page marks the cell unmeasured is reported', () => {
  const stored: StoredCell[] = [
    { row: 'R8-2/7A', column: '5,7-dichloro BI', values: [sv(1, 'kcat/KM', '42.3')] }
  ]
  const d = compareReadings(stored, readR8)
  assert.equal(d.length, 1)
  // 42.3 IS printed in this row, under 6-chloro — so the finding is the shift,
  // which names where it belongs, not the weaker "not printed here".
  assert.equal(d[0].kind, 'value-belongs-to-another-column')
  assert.equal(d[0].printedUnderColumn, '6-chloro BI')
})

test('the whole R8-2/7A shift is caught, cell by cell', () => {
  const stored: StoredCell[] = [
    {
      row: 'R8-2/7A',
      column: '5-nitro BI',
      values: [sv(1, 'kcat', '5.4 ± 0.8'), sv(2, 'KM', '0.44 ± 0.04'), sv(3, 'kcat/KM', '12,350 ± 774')]
    },
    { row: 'R8-2/7A', column: '5,7-dichloro BI', values: [sv(4, 'kcat/KM', '42.3 ± 0.3')] },
    {
      row: 'R8-2/7A',
      column: '6-chloro BI',
      values: [sv(5, 'kcat', '0.0185 ± 0.0001'), sv(6, 'KM', '1.03 ± 0.01'), sv(7, 'kcat/KM', '5.84 ± 0.01')]
    },
    {
      row: 'R8-2/7A',
      column: '6-fluoro BI',
      values: [sv(8, 'kcat', '0.0060 ± 0.0002'), sv(9, 'KM', '0.435 ± 0.005'), sv(10, 'kcat/KM', '5.84 ± 0.01')]
    }
  ]
  const d = compareReadings(stored, readR8)
  const ids = d.map((x) => x.measurementId).sort((a, b) => (a ?? 0) - (b ?? 0))
  // The correct 5-nitro cell is silent; every misplaced figure is named.
  assert.deepEqual(ids.filter((i) => i !== null && i <= 3), [])
  assert.ok(ids.includes(4), '42.3 under 5,7-dichloro')
  assert.ok(ids.includes(6), 'KM 1.03 under 6-chloro')
  assert.ok(ids.includes(9), 'KM 0.435 under 6-fluoro')
})

test('a correct cell produces no disagreement', () => {
  const stored: StoredCell[] = [
    {
      row: 'R8-2/7A',
      column: '6-chloro BI',
      values: [sv(1, 'kcat', '0.0185 ± 0.0001'), sv(2, 'KM', '0.435 ± 0.005'), sv(3, 'kcat/KM', '42.3 ± 0.3')]
    }
  ]
  assert.deepEqual(compareReadings(stored, readR8), [])
})

test('a cell the blind reading never covered is not a disagreement', () => {
  const stored: StoredCell[] = [
    { row: 'R13-3/11H', column: '6-chloro BI', values: [sv(1, 'kcat', '2.11 ± 0.31')] }
  ]
  assert.deepEqual(compareReadings(stored, readR8), [])
})

test('the page printing a figure nothing was stored for is reported', () => {
  const stored: StoredCell[] = [
    { row: 'R8-2/7A', column: '6-chloro BI', values: [sv(1, 'kcat', '0.0185 ± 0.0001')] }
  ]
  const d = compareReadings(stored, readR8)
  assert.equal(d.length, 2)
  assert.ok(d.every((x) => x.kind === 'value-not-stored'))
})

test('figures fold across the ways two readers write them', () => {
  assert.equal(foldFigure('1,833 ± 75'), foldFigure('1833+-75'))
  assert.equal(foldFigure('0.0060 ± 0.0002'), foldFigure('0.0060±0.0002'))
  // An uncertainty is part of the reading, not decoration.
  assert.notEqual(foldFigure('0.98 ± 0.16'), foldFigure('0.98 ± 0.02'))
  // A bound is not the bare number.
  assert.notEqual(foldFigure('> 95'), foldFigure('95'))
})

test('labels fold across case, spacing and dash, but not across substrates', () => {
  assert.equal(foldLabel('6-chloro BI'), foldLabel('6\u2010chloro  bi'))
  assert.notEqual(foldLabel('6-chloro BI'), foldLabel('5,7-dichloro BI'))
})

// The three causes of a FALSE disagreement, each measured on work 4 before it
// was fixed: 14 of 27 were an absence mark reported as a figure, 4 were one
// number written two ways, 3 were the same place seen twice through two crops.
test('an absence mark reported as a VALUE is still absence', () => {
  // The blind reader is asked to put figures in `values` and marks in `marked`,
  // and reasonably does neither: `ND†` is what is printed at that place, so it
  // arrives as a value with the quantity it belongs to.
  const read: ReadCell[] = [
    {
      row: 'R2-4/3D',
      column: '6-chloro BI',
      marked: null,
      values: [
        { quantity: 'kcat', value: 'ND†', unit: null },
        { quantity: 'KM', value: 'ND†', unit: null },
        { quantity: 'kcat/KM', value: '5.7 ± 0.7', unit: 'M−1 s−1' }
      ]
    }
  ]
  const stored: StoredCell[] = [
    { row: 'R2-4/3D', column: '6-chloro BI', values: [sv(1, 'kcat/KM', '5.7 ± 0.7')] }
  ]
  // The extraction correctly stored nothing for the two ND quantities.
  assert.deepEqual(compareReadings(stored, read), [])
})

test('a cell whose only entries are marks reads as absent', () => {
  const read: ReadCell[] = [
    {
      row: 'R1-7/10H',
      column: '5,7-dichloro BI',
      marked: null,
      values: [{ quantity: 'kcat', value: 'not measured', unit: null }]
    }
  ]
  assert.equal(marksAbsent(read[0]), true)
  assert.deepEqual(compareReadings([], read), [])
})

test('one number written two ways is one reading', () => {
  // `∼ 160*` on the page, `~160` from one reader, `160` from the other.
  assert.ok(sameFigureForTest('∼ 160*', '~160'))
  assert.ok(sameFigureForTest('0.0060 ± 0.0002', '6.0e-3'))
  assert.ok(sameFigureForTest('1,833 ± 75', '1833'))
  // A BOUND is part of the claim and is not folded away.
  assert.equal(sameFigureForTest('> 95', '95'), false)
  assert.equal(sameFigureForTest('42.3', '5.84'), false)
})

test('the same place seen through two crops is not a disagreement', () => {
  // The second crop caught only a header fragment and saw no figures there.
  const read: ReadCell[] = [
    {
      row: 'R8-2/7A',
      column: '6-chloro BI',
      marked: null,
      values: [{ quantity: 'kcat/KM', value: '42.3 ± 0.3', unit: 'M−1 s−1' }]
    },
    { row: 'R8-2/7A', column: '6-chloro BI', marked: 'blank', values: [] }
  ]
  const stored: StoredCell[] = [
    { row: 'R8-2/7A', column: '6-chloro BI', values: [sv(1, 'kcat/KM', '42.3')] }
  ]
  // The reading that found figures wins, so the correct extraction stands.
  assert.deepEqual(compareReadings(stored, read), [])
})

// WHICH disagreements are worth a wording question, and which must never be.
// Asking about a value difference invites the model to explain a real error
// away, so only a same-figure-different-column-name case is offered.
test('only a column-name difference is a wording question', () => {
  const shifted: Disagreement = {
    kind: 'value-belongs-to-another-column',
    row: 'R8-2/7A',
    column: '6-Cl BI',
    quantity: 'kcat/KM',
    stored: '42.3',
    printed: '42.3 ± 0.3',
    printedUnderColumn: '6-chloro BI',
    factId: 1,
    measurementId: 1
  }
  assert.equal(isWordingCandidate(shifted), true)
  assert.deepEqual(wordingPair(shifted), { a: '6-Cl BI', b: '6-chloro BI' })

  // A figure stored where the page prints nothing is about WHAT IS PRINTED, so
  // no wording answer can dissolve it.
  const absent: Disagreement = {
    kind: 'stored-where-page-marks-absent',
    row: 'R1-7/10H',
    column: '6-chloro BI',
    quantity: 'kcat/KM',
    stored: '16.4 ± 0.4',
    printed: 'below detection limit',
    factId: 2,
    measurementId: 2
  }
  assert.equal(isWordingCandidate(absent), false)
  assert.equal(wordingPair(absent), null)

  // Likewise a value the page prints that nothing was stored for.
  const missing: Disagreement = {
    kind: 'value-not-stored',
    row: 'R8-2/7A',
    column: '6-chloro BI',
    quantity: 'kcat/KM',
    stored: null,
    printed: '42.3 ± 0.3',
    factId: 3,
    measurementId: null
  }
  assert.equal(isWordingCandidate(missing), false)
})

test('every way a page says "no figure here" reads as absent', () => {
  for (const m of ['ND', 'n.d.', 'not measured', 'not determined', 'below detection limit', '—', '', null]) {
    assert.ok(marksAbsent({ row: 'r', column: 'c', marked: m, values: [] }), `${m}`)
  }
  assert.equal(
    marksAbsent({ row: 'r', column: 'c', marked: null, values: [{ quantity: 'k', value: '1', unit: null }] }),
    false
  )
})
