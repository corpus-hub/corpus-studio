import assert from 'node:assert/strict'
import { test } from 'node:test'

import { rewriteLeadingCount } from './extractNote'

test('the count segment is replaced and the shortfall lines survive', () => {
  assert.equal(
    rewriteLeadingCount(
      '138 fact(s), 138 evidence span(s); INCOMPLETE: 3 dropped for citing no findable passage',
      '138 fact(s) from this reading + 106 added by the review = 244 fact(s), 244 evidence span(s)'
    ),
    '138 fact(s) from this reading + 106 added by the review = 244 fact(s), 244 evidence span(s);' +
      ' INCOMPLETE: 3 dropped for citing no findable passage'
  )
})

test('a note with no count is left alone rather than given one', () => {
  assert.equal(
    rewriteLeadingCount('no field of this schema was answered', '5 fact(s), 5 evidence span(s)'),
    null
  )
  assert.equal(rewriteLeadingCount(null, '5 fact(s), 5 evidence span(s)'), null)
})
