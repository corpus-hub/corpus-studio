// Unit tests for the RRF fuse.
//
// Pure functions over plain arrays: no DB, no worker, no electron — these run
// under `tsx --test` identically on every machine, like the citation parser's
// tests. What is pinned: the score formula, order preservation, cross-leg
// summing, and the empty/degenerate cases the search assembly relies on when
// a leg did not run.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { RRF_K, rrfFuse } from './rrf'

test('the smoothing constant is the one the design pins', () => {
  assert.equal(RRF_K, 60)
})

test('rank 0 of a single list scores exactly 1/(k+1)', () => {
  assert.equal(rrfFuse([[7]]).get(7), 1 / (RRF_K + 1))
})

test('a single list preserves its order under the scores', () => {
  const scores = rrfFuse([[3, 1, 2]])
  assert.ok((scores.get(3) as number) > (scores.get(1) as number))
  assert.ok((scores.get(1) as number) > (scores.get(2) as number))
})

test('deeper ranks decay strictly monotonically', () => {
  const scores = rrfFuse([[1, 2, 3, 4, 5, 6, 7, 8]])
  let prev = Number.POSITIVE_INFINITY
  for (const id of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const s = scores.get(id) as number
    assert.ok(s < prev, `rank of ${id} must score below the rank above it`)
    prev = s
  }
})

test('a chunk present in both legs sums its contributions', () => {
  const scores = rrfFuse([[9, 4], [4, 9]])
  // 9: 1/(60+1) + 1/(60+2); 4: 1/(60+2) + 1/(60+1) — the same sum, a tie.
  assert.equal(scores.get(9), scores.get(4))
  assert.ok(Math.abs((scores.get(9) as number) - (1 / 61 + 1 / 62)) < 1e-12)
})

test('head of one leg beats tail of another, but both beat absence', () => {
  const scores = rrfFuse([[5], [5, 6]])
  assert.ok((scores.get(5) as number) > (scores.get(6) as number))
  assert.equal(scores.get(99), undefined)
})

test('empty input and empty lists yield an empty map', () => {
  assert.equal(rrfFuse([]).size, 0)
  assert.equal(rrfFuse([[], []]).size, 0)
})

test('fusing one list alone is that list, scored', () => {
  const scores = rrfFuse([[10, 20, 30]])
  assert.deepEqual([...scores.keys()], [10, 20, 30])
})
