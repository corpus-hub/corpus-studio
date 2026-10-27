// The three refusals that replaced three silent substitutions.
//
// Each of these used to return a plausible value that was then STAMPED INTO
// PROVENANCE as if it had been the thing asked for: a generic summary brief
// wearing the requested prompt version, a model the gateway happened to serve
// standing in for the one that was requested, and an extraction schema that
// never reached the model. All three produced runs a scientist would read as
// successful, so nothing but a test of the refusal itself can hold them.
//
// The reads must survive: `hasPrompt` is how a stored run written under a
// retired prompt stays VIEWABLE, and if it started throwing too, the history
// screens would go from "instructions no longer recoverable" to broken.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getPrompt, hasPrompt } from './prompts'
import { pickModel, ModelUnavailableError } from './select'

test('an unregistered version is refused, not served under its own name', () => {
  assert.throws(
    () => getPrompt('extraction', 'v3'),
    (err: Error) => /no prompt registered for 'extraction@v3'/.test(err.message)
  )
})

test('the refusal names the versions this build actually defines', () => {
  try {
    getPrompt('extraction', 'v3')
    assert.fail('expected a refusal')
  } catch (err) {
    assert.match((err as Error).message, /versions this build defines for 'extraction' are .*v4\d/)
  }
})

test('an analysis type the registry knows nothing about says so', () => {
  assert.throws(
    () => getPrompt('haruspicy', 'v1'),
    (err: Error) => /defines no prompt at all for 'haruspicy'/.test(err.message)
  )
})

test('a registered version still resolves, and carries its own stamp', () => {
  const p = getPrompt('extraction', 'v45')
  assert.equal(p.version, 'v45')
  assert.equal(p.name, 'extraction')
})

test('reading history does not throw: hasPrompt answers for a retired version', () => {
  assert.equal(hasPrompt('extraction', 'v3'), false)
  assert.equal(hasPrompt('extraction', 'v45'), true)
})

test('an explicitly requested model the gateway does not serve is refused', () => {
  assert.throws(
    () => pickModel('claude-opus-4-6', ['claude-haiku-4-5-20251001']),
    ModelUnavailableError
  )
})

test('the model refusal names both what was asked for and what is on offer', () => {
  try {
    pickModel('gpt-4.1', ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'])
    assert.fail('expected a refusal')
  } catch (err) {
    const msg = (err as Error).message
    assert.match(msg, /gpt-4\.1/)
    assert.match(msg, /claude-haiku-4-5-20251001, claude-sonnet-4-6/)
  }
})

test('an empty model list is not a licence to honour the request unchecked', () => {
  assert.throws(() => pickModel('gpt-4.1', []), ModelUnavailableError)
})

test('an explicitly requested model that IS served is used verbatim', () => {
  assert.equal(pickModel('claude-sonnet-4-6', ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6']), 'claude-sonnet-4-6')
})

// An empty model setting is a real choice — "let the gateway decide" — and the
// stages send `undefined` for it deliberately. So nothing requested defers to
// what the gateway lists FIRST. What must never happen is this file naming a
// model of its own: it used to walk a hardcoded preference list led by a cheap
// id, so a caller that passed nothing ran on a different model from the rest of
// the app and stamped that one onto the run as provenance.
test('nothing requested takes the gateway\u2019s first offer, not a name of our own', () => {
  assert.equal(
    pickModel(undefined, ['claude-opus-4-6', 'claude-haiku-4-5-20251001']),
    'claude-opus-4-6'
  )
})

test('a lone offered model is what deferring to the gateway means', () => {
  assert.equal(pickModel(undefined, ['some-local-model']), 'some-local-model')
})

// Deferring needs something to defer TO. With no list there is nothing to run
// on and nothing to attribute the analysis to, which is a different situation
// from the user having declined to choose.
test('nothing requested and nothing served is refused', () => {
  assert.throws(() => pickModel(undefined, []), /gateway lists none/)
})
