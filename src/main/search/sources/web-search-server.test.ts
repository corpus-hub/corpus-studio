// A SOURCE THAT COULD NOT BE READ IS NOT A SOURCE THAT FOUND NOTHING.
//
// `readToolJson` used to answer `null` for every unreadable reply, and the
// caller turned that into an empty array. The registry then saw a FULFILLED
// promise, counted the source a success, and merged its nothing into the
// results — so a search whose only source was returning prose, or an error page,
// or half a JSON document, told the user there were no papers on their topic.
//
// That is the worst available answer. The registry already has the right
// machinery: a rejected source becomes a `SourceFailure`, appears in the failure
// banner, and — if EVERY source failed — makes the whole search raise rather
// than render zero rows as a conclusion. All this file asserts is that a
// malformed reply actually reaches it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readToolJson, type McpEnvelope } from './web-search-server'

/** An envelope carrying one text part, as MCP really returns tool output. */
const envelope = (text: string | undefined): McpEnvelope => ({
  result: { content: text === undefined ? [] : [{ type: 'text', text }] }
})

test('a well-formed reply is returned as the object it is', () => {
  assert.deepEqual(readToolJson(envelope('{"results":[{"title":"x"}]}'), 'paper_search_mode'), {
    results: [{ title: 'x' }]
  })
})

test('an EMPTY result list is a real answer and is not refused', () => {
  // The distinction the whole change rests on: this source ran, looked, and
  // found nothing. It must not be turned into a failure — that would put a
  // banner on a search that worked perfectly.
  assert.deepEqual(readToolJson(envelope('{"results":[]}'), 'paper_search_mode'), { results: [] })
})

test('a reply that is not JSON is a FAILURE, never an empty result', () => {
  assert.throws(
    () => readToolJson(envelope('<html>502 Bad Gateway</html>'), 'paper_search_mode'),
    /cannot read/,
    'prose where JSON was promised means the source did not answer'
  )
})

test('a truncated reply is a failure', () => {
  assert.throws(() => readToolJson(envelope('{"results":[{"title"'), 'paper_search_mode'))
})

test('a reply with no content at all is a failure', () => {
  assert.throws(() => readToolJson(envelope(undefined), 'paper_search_mode'), /no result content/)
})

test('valid JSON of the wrong SHAPE is a failure', () => {
  // `[]` and `"ok"` both parse. Neither is a tool result, and both would have
  // read back as a source with no hits.
  assert.throws(() => readToolJson(envelope('[]'), 'paper_search_mode'), /unexpected shape/)
  assert.throws(() => readToolJson(envelope('"ok"'), 'paper_search_mode'), /unexpected shape/)
  assert.throws(() => readToolJson(envelope('null'), 'paper_search_mode'), /unexpected shape/)
})

test('the failure names the tool, and never the reply itself', () => {
  // The reply is upstream-controlled text and this message is rendered to the
  // user verbatim in the failure banner.
  const secret = '{"leak":"https://internal.example/token/abc123"'
  try {
    readToolJson(envelope(secret), 'paper_search_mode')
    assert.fail('should have thrown')
  } catch (e) {
    const msg = (e as Error).message
    assert.match(msg, /paper_search_mode/)
    assert.ok(!msg.includes('abc123'), 'the malformed body must not reach the screen')
    assert.ok(!msg.includes('internal.example'))
  }
})
