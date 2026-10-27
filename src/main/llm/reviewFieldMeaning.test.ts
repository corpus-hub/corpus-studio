// What a field DECLARES reaches the reviewer, and the reviewer is held to the
// same quantity-kind rule as the extraction.
//
// The failure this guards: eight facts asserting an assay temperature no paper
// printed, written by the REVIEWER over a column the page heads as a ratio of
// activities at two temperatures. The reviewer was shown the bare label
// "Temperature" and carried no rule about derived quantities, so nothing it had
// could distinguish the two.

import assert from 'node:assert/strict'
import test from 'node:test'

import { describeField } from './review'
import { getPrompt } from './prompts'

test('a field is described by what it declares, not by its label alone', () => {
  assert.equal(
    describeField({
      id: 1,
      label: 'Temperature',
      description: 'Assay temperature in degrees Celsius.',
      unit: 'C'
    }),
    'Temperature — Assay temperature in degrees Celsius.; unit: C'
  )
  // A schema that declares neither reads exactly as it did before.
  assert.equal(
    describeField({ id: 2, label: 'Variant', description: null, unit: null }),
    'Variant'
  )
  assert.equal(
    describeField({ id: 3, label: 'KM', description: null, unit: 'mM' }),
    'KM — unit: mM'
  )
})

test('the reviewer and the extraction are held to ONE quantity-kind rule', () => {
  const review = getPrompt('record-review').system
  const extraction = getPrompt('extraction').system
  for (const rule of [
    'YOU REPORT WHAT IS PRINTED. YOU DO NOT CALCULATE.',
    'A DIFFERENCE IS NOT THE QUANTITY. A CHANGE IS NOT THE LEVEL.',
    'an activity ratio between two temperatures is not a temperature'
  ]) {
    assert.ok(extraction.includes(rule), `extraction lost: ${rule}`)
    assert.ok(review.includes(rule), `reviewer never got: ${rule}`)
  }
  // The `fold` output key belongs to the extraction's answer shape and to no
  // other prompt. Sent to the reviewer it would invite an answer nothing reads.
  assert.ok(extraction.includes('"fold" is a sibling of "value_num"'))
  assert.ok(!review.includes('"fold" is a sibling of "value_num"'))
})

test('the reviewer prompt the stage pins is the registered default', () => {
  // REGISTRY and DEFAULT_VERSION diverging once ran a whole corpus through the
  // wrong prompt. `getPrompt` with no version resolves the default and throws
  // when the registry has no entry for it.
  assert.equal(getPrompt('record-review').version, 'v12')
})
