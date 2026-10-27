import test from 'node:test'
import assert from 'node:assert/strict'
import { canon, findScoped } from './locateInParagraph'

test('canon strips punctuation, spaces and math signs', () => {
  assert.equal(canon('0.528 ± 0.002'), '05280002')
  assert.equal(canon('R5-11/5F'), 'r5115f')
})

test('canon drops the ¼ this corpus encodes `=` as', () => {
  assert.equal(canon('k cat ¼ 0.02'), canon('kcat = 0.02'))
})

test('a short needle resolves when scoped to its paragraph', () => {
  const doc = 'intro 36 ± 3 elsewhere. TABLE ROW 36 ± 3 here.'
  const para = 'TABLE ROW 36 ± 3 here.'
  const hit = findScoped(canon(doc), canon(para), canon('36 ± 3'))
  // The occurrence inside the paragraph, not the first one in the document.
  assert.equal(hit, canon(doc).indexOf(canon(para)) + canon(para).indexOf('363'))
})

test('an unlocatable paragraph yields null rather than a document-wide guess', () => {
  const doc = 'alpha beta gamma'
  const hit = findScoped(canon(doc), canon('not present at all'), canon('beta'))
  assert.equal(hit, null)
})

test('a needle absent from its paragraph yields null', () => {
  const doc = 'alpha beta gamma'
  const hit = findScoped(canon(doc), canon('alpha beta'), canon('gamma'))
  assert.equal(hit, null)
})

test('a needle ambiguous INSIDE its paragraph yields null', () => {
  const doc = 'x 5 ± 1 and 5 ± 1 y'
  const hit = findScoped(canon(doc), canon(doc), canon('5 ± 1'))
  assert.equal(hit, null)
})

test('a paragraph appearing twice is refused, not guessed', () => {
  const para = 'repeated paragraph text'
  const doc = `${para} middle ${para}`
  const hit = findScoped(canon(doc), canon(para), canon('middle'))
  assert.equal(hit, null)
})

// THE OVERSHOOT CASE. The two text extractions disagree about where a paragraph
// ends — the premise of the whole scoped-locator design — so a window sized by
// the paragraph's own length can run past it. A needle that is NOT in the
// paragraph but sits just after it must not be matched.
test('a needle just past the paragraph end is refused', () => {
  const para = 'the paragraph body that is long enough to key on reliably here'
  const doc = `${para} TAIL 99 ± 9 after`
  const hit = findScoped(canon(doc), canon(para), canon('99 ± 9'))
  assert.equal(hit, null)
})

// The real shape of the bug this exists to fix: a kinetics cell, eight
// canonical characters, far below the document-wide locator's 12-char guard.
test('a kinetics cell anchors inside its table paragraph', () => {
  const para = 'R2-4/3D 0.528 ± 0.002 ND ND ND 0.29 ± 0.01 1,833 ± 75'
  const doc = `abstract mentions 0.29 elsewhere entirely. ${para} and then more prose.`
  const hit = findScoped(canon(doc), canon(para), canon('0.528 ± 0.002'))
  assert.equal(hit, canon(doc).indexOf('05280002'))
  assert.notEqual(hit, null)
})
