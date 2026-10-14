// Truncation is MEASURED or it is not recorded.
//
// `chunk.truncated` is `NOT NULL CHECK (truncated IN (0,1))`, so the column has
// no room for "we did not check". `false` therefore is not a neutral value: it
// is the claim that this vector stands for the whole of its text, which search
// reads back to decide whether a hit can be trusted. The probe used to return
// it whenever the tokenizer was missing or threw — the optimistic answer, in
// the one function whose entire purpose is not to guess.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { truncationOf, TruncationUnknownError } from './model'

type Ext = Parameters<typeof truncationOf>[0]

const withTokenizer = (fn: Ext['tokenizer']): Ext => ({ tokenizer: fn }) as unknown as Ext

test('a text longer than the limit is reported truncated', async () => {
  const ext = withTokenizer(() => ({ input_ids: { dims: [1, 700] } }))
  assert.deepEqual(await truncationOf(ext, ['x'], 512), [true])
})

test('a text within the limit is reported untruncated', async () => {
  const ext = withTokenizer(() => ({ input_ids: { dims: [1, 12] } }))
  assert.deepEqual(await truncationOf(ext, ['x'], 512), [false])
})

test('no tokenizer at all is refused, never answered "not truncated"', async () => {
  await assert.rejects(
    () => truncationOf({} as unknown as Ext, ['x'], 512),
    TruncationUnknownError
  )
})

test('a throwing tokenizer is refused and the cause travels with it', async () => {
  const ext = withTokenizer(() => {
    throw new Error('onnx session is closed')
  })
  await assert.rejects(() => truncationOf(ext, ['x'], 512), (err: Error) =>
    err instanceof TruncationUnknownError && /onnx session is closed/.test(err.message)
  )
})

test('a tokenizer answering without a length is refused', async () => {
  const ext = withTokenizer(() => ({ input_ids: { dims: [1] } }))
  await assert.rejects(() => truncationOf(ext, ['x'], 512), TruncationUnknownError)
})

test('one unmeasurable text refuses the whole batch rather than half-claiming', async () => {
  let n = 0
  const ext = withTokenizer(() => {
    n++
    if (n === 2) throw new Error('boom')
    return { input_ids: { dims: [1, 10] } }
  })
  await assert.rejects(() => truncationOf(ext, ['a', 'b', 'c'], 512), TruncationUnknownError)
})
