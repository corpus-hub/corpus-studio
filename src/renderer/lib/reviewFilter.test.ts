import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReviewReasonKey } from '@shared/contract'
import { filterByReasons, itemSeverity, reasonCounts, sortBySeverity } from './reviewFilter'

const it = (fact_id: number, ...reasons: ReviewReasonKey[]): { fact_id: number; reasons: ReviewReasonKey[] } => ({
  fact_id,
  reasons
})

test('an item is as serious as its MOST serious reason', () => {
  assert.ok(itemSeverity(it(1, 'inferred', 'contradicted')) === itemSeverity(it(2, 'contradicted')))
  assert.ok(itemSeverity(it(1, 'contradicted')) < itemSeverity(it(2, 'uncertain')))
  assert.ok(itemSeverity(it(1, 'uncertain')) < itemSeverity(it(2, 'inferred')))
  // An item naming no reason at all is the least serious thing the list can hold.
  assert.ok(itemSeverity(it(1, 'inferred')) < itemSeverity(it(2)))
})

test('sorts most serious first, ties by fact id, and is stable across reads', () => {
  const items = [
    it(9, 'inferred'),
    it(3, 'contradicted'),
    it(7, 'uncertain'),
    it(1, 'inferred'),
    it(8, 'inferred', 'contradicted')
  ]
  const order = sortBySeverity(items).map((x) => x.fact_id)
  assert.deepEqual(order, [3, 8, 7, 1, 9])
  // Same input in a different arrival order must produce the same list.
  assert.deepEqual(sortBySeverity([...items].reverse()).map((x) => x.fact_id), order)
})

test('a multi-reason fact survives losing one of its reasons', () => {
  const items = [it(1, 'inferred', 'contradicted'), it(2, 'inferred')]
  const kept = filterByReasons(items, new Set(['contradicted', 'uncertain']))
  assert.deepEqual(kept.map((x) => x.fact_id), [1])
  // ...and appears under EITHER of its reasons, never only the most serious.
  assert.deepEqual(
    filterByReasons(items, new Set(['inferred'])).map((x) => x.fact_id),
    [1, 2]
  )
})

test('an empty selection is no restriction, not an empty list', () => {
  const items = [it(1, 'inferred'), it(2, 'contradicted')]
  assert.equal(filterByReasons(items, new Set()).length, 2)
})

test('counts are per reason over the whole queue, one per item per reason', () => {
  const c = reasonCounts([
    it(1, 'inferred', 'contradicted'),
    it(2, 'inferred'),
    it(3, 'uncertain')
  ])
  assert.equal(c.inferred, 2)
  assert.equal(c.contradicted, 1)
  assert.equal(c.uncertain, 1)
})
