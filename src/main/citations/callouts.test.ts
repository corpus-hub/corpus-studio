// Callout detection, pinned where getting it wrong is invisible.
//
// Each group here corresponds to a way the scan can be confidently wrong rather
// than obviously broken: a dropped en-dashed range yields fewer citations than
// the paper printed, an unbounded range writes hundreds of fabricated claims
// from one OCR artefact, and a bibliography scanned as body text produces one
// fake callout per entry — which then SATISFIES the confidence gate that exists
// to catch a mis-detected numbering scheme.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CALLOUT_LIMITS, calloutGate, expandMarker, scanCallouts } from './callouts'
import type { ParagraphRecord } from '../pipeline/capabilities'

test('a marker expands to every ordinal it names', () => {
  assert.deepEqual(expandMarker('17'), [17])
  assert.deepEqual(expandMarker('12,15-17'), [12, 15, 16, 17])
  assert.deepEqual(expandMarker('4; 9'), [4, 9])
})

test('every dash pdfjs emits works as a range separator', () => {
  // Handling only ASCII `-` silently drops most ranges in a typeset paper, and
  // the loss is invisible: the marker just yields fewer citations.
  for (const dash of ['-', '\u2010', '\u2011', '\u2012', '\u2013', '\u2014', '\u2015']) {
    assert.deepEqual(expandMarker(`5${dash}7`), [5, 6, 7], `dash ${dash.charCodeAt(0)}`)
  }
})

test('a malformed or absurdly wide marker is rejected whole, not partly', () => {
  assert.equal(expandMarker('1-400'), null, 'an OCR artefact must not write 400 rows')
  assert.equal(expandMarker('9-4'), null, 'a reversed range names nothing')
  assert.equal(expandMarker('see'), null)
  assert.equal(expandMarker('0'), null, 'bibliographies are 1-based')
  assert.equal(expandMarker(`1-${CALLOUT_LIMITS.maxRangeWidth + 2}`), null)
})

function para(over: Partial<ParagraphRecord> & { paraId: string; text: string; charStart: number }) {
  return {
    page: 1,
    kind: 'body',
    section: 'results',
    charEnd: over.charStart + over.text.length,
    ...over
  } as ParagraphRecord
}

test('the bibliography yields no inline callouts', () => {
  // Both filters are exercised: `kind`/`section` on one entry, and the offset
  // range on another the segmenter mislabelled as body text.
  const body = para({ paraId: 'p0', charStart: 0, text: 'As shown previously [1], the enzyme.' })
  const refsHeading = para({
    paraId: 'p1',
    charStart: 100,
    text: '[1] Smith J. A paper. J. Test 2019.',
    kind: 'reference',
    section: 'references'
  })
  const refsMislabelled = para({
    paraId: 'p2',
    charStart: 200,
    text: '[2] Jones K. Another paper. J. Test 2020.'
  })

  const scan = scanCallouts({
    paragraphs: [body, refsHeading, refsMislabelled],
    knownOrdinals: new Set([1, 2]),
    bibliography: { range: [100, 300], entries: [] }
  })
  assert.equal(scan.callouts.length, 1, 'only the body callout')
  assert.equal(scan.callouts[0].ordinal, 1)
  assert.equal(scan.callouts[0].paraId, 'p0')
})

test('a reference printed as a footnote inside a body paragraph is not a callout', () => {
  // The layout older chemistry journals use: the reference sits at the foot of
  // the page that cites it, so it shares a paragraph with the prose above it.
  // There is no contiguous section to fence off, and fencing off the whole
  // paragraph would take the real callout with the printed one — on work 15 of
  // this corpus that choice filed 33 of 44 stored "citing sentences" as its own
  // bibliography.
  const mixed = para({
    paraId: 'p0',
    charStart: 0,
    text: 'The mechanism is established [1]. (1) A. Quilico, Chem. Heterocycl. 17, 159 (1962).'
  })
  const entryAt = mixed.text.indexOf('(1) A. Quilico')

  const scan = scanCallouts({
    paragraphs: [mixed],
    knownOrdinals: new Set([1]),
    bibliography: { range: [-1, -1], entries: [[entryAt, mixed.text.length]] }
  })
  assert.equal(scan.callouts.length, 1, 'the in-text callout survives')
  assert.equal(scan.callouts[0].offset, mixed.text.indexOf('[1]'))
})

test('an author block’s footnote markers are not citations', () => {
  // MEASURED on this corpus: 33 stored contexts were footnote or equation
  // markers rather than citations, and 22 of them had been given a role — a
  // citation edge to a paper nobody cited, labelled with confidence. Two thirds
  // sat mid-sentence, where nothing looks wrong to a reader.
  //
  // Text extraction routinely glues the author block onto the abstract that
  // follows it, so this paragraph carries both, and the real citation in the
  // prose must survive alongside the rejection of the markers above it.
  const glued = para({
    paraId: 'p0',
    charStart: 0,
    section: 'introduction',
    text:
      '1 Department of Biochemistry, University of Washington, 2 Division of Chemistry. ' +
      'The reaction has been studied before [3].'
  })
  const scan = scanCallouts({
    paragraphs: [glued],
    knownOrdinals: new Set([1, 2, 3]),
    bibliography: { range: [-1, -1], entries: [] }
  })
  assert.deepEqual(
    scan.callouts.map((c) => c.ordinal),
    [3],
    'only the prose citation; the affiliation markers name departments'
  )
})

test('an equation’s own number is not a citation of that entry', () => {
  // `Eq. (5)` and `Eqs. (9) and (10)` label formulae. Admitted as citations they
  // produce an edge to whichever bibliography entry happens to share the number.
  //
  // The rejection is judged on the SENTENCE, so this fixture is a real display
  // equation as extraction delivers one — its own line, the formula around it —
  // rather than an equation reference sharing a sentence with a citation. That
  // shape does occur ("...using Eq. (5). Activity improved [7]."), and there the
  // whole sentence reads as an equation line and both are refused; erring that
  // way loses a citation, while the other way invents one.
  const eqn = para({
    paraId: 'p0',
    charStart: 0,
    text: 'A mapping potential (Eq. (3)) is used to simulate the reaction pathway.'
  })
  const scan = scanCallouts({
    paragraphs: [eqn],
    knownOrdinals: new Set([3]),
    bibliography: { range: [-1, -1], entries: [] }
  })
  assert.deepEqual(scan.callouts.map((c) => c.ordinal), [], 'the equation number is refused')
})

test('prose that merely names a university keeps its citations', () => {
  // The first version of the affiliation guard matched the institution word
  // alone and cost a real callout — "the center of recent excitements (15, 16)"
  // was rejected because `Institute` stood 60 characters earlier. What marks an
  // author block is a small number IMMEDIATELY BEFORE the institution word.
  const prose = para({
    paraId: 'p0',
    charStart: 0,
    section: 'introduction',
    text: 'Work at the Weizmann Institute has been the center of recent excitements (15, 16).'
  })
  const scan = scanCallouts({
    paragraphs: [prose],
    knownOrdinals: new Set([15, 16]),
    bibliography: { range: [-1, -1], entries: [] }
  })
  assert.deepEqual(scan.callouts.map((c) => c.ordinal), [15, 16])
})

test('a site the FILE recorded is found where the text scan misses it', () => {
  // A link annotation's rectangle is where the typesetter printed the marker.
  // Here the prose gives the scanner nothing to match — the marker is a bare
  // raised digit with no bracket and no geometry supplied — and the file's own
  // record supplies it anyway.
  const body = para({
    paraId: 'p0',
    charStart: 0,
    text: 'Catalysis improves with preorganization 7 as shown by earlier work.'
  })
  const at = body.text.indexOf('7')
  const scan = scanCallouts({
    paragraphs: [body],
    knownOrdinals: new Set([7]),
    bibliography: { range: [-1, -1], entries: [] },
    nativeSites: [{ charStart: at, charEnd: at + 1 }]
  })
  assert.deepEqual(scan.callouts.map((c) => c.ordinal), [7])
  assert.equal(scan.callouts[0].offset, at, 'the marker’s own offset, not the line’s')
})

test('a line-wide recorded site is trimmed to the marker it contains', () => {
  // Some producers give pdf.js one item per LINE, so the rectangle around a
  // single `[5]` resolves to the whole line. Left untrimmed that span is longer
  // than the real markers beside it, and the overlap dedup — which prefers the
  // longer match — swallowed them: work 11 lost the ordinals 20 and 21 to one
  // such site while appearing to gain native coverage.
  const body = para({
    paraId: 'p0',
    charStart: 0,
    text: 'as reported [20] and confirmed [21] in later work.'
  })
  const scan = scanCallouts({
    paragraphs: [body],
    knownOrdinals: new Set([20, 21]),
    bibliography: { range: [-1, -1], entries: [] },
    // One line-wide site covering BOTH markers, as the failing case produced.
    nativeSites: [{ charStart: 0, charEnd: body.text.length }]
  })
  assert.deepEqual(
    scan.callouts.map((c) => c.ordinal).sort((a, b) => a - b),
    [20, 21],
    'both markers survive; the wide site does not stand in for them'
  )
})

test('a superscript that opens a sentence is attributed to the claim before it', () => {
  // The defect this pins, in the user's own words and from their own paper:
  //
  //   "...used as a probe for studying medium effects in catalysis. 10–12
  //    Several enzyme-like systems that catalyze this reaction..."
  //
  // `10–12` supports the medium-effects claim. pdf.js flattens the raised digits
  // into the stream after the full stop, and a digit followed by a space and a
  // capital is a sentence boundary by Unicode rules — so the marker opened the
  // NEXT sentence and the citation was filed against a claim it says nothing
  // about. Measured: 71 of 1161 contexts, 20 with a role describing the wrong
  // claim, including a `support` label taken from the following clause.
  const body = para({
    paraId: 'p0',
    charStart: 0,
    text:
      'Kemp elimination has been used as a probe for studying medium effects in catalysis. ' +
      '[10] Several enzyme-like systems that catalyze this reaction have been explored.'
  })
  const scan = scanCallouts({
    paragraphs: [body],
    knownOrdinals: new Set([10]),
    bibliography: { range: [-1, -1], entries: [] }
  })
  assert.equal(scan.callouts.length, 1)
  const s = scan.callouts[0].sentence ?? ''
  assert.ok(
    s.includes('medium effects in catalysis'),
    `the supported claim must be in the passage, got: ${JSON.stringify(s)}`
  )
})

test('a marker in the middle of a sentence keeps that sentence', () => {
  // The 94% that were already right. The absorb above must not reach them: on
  // this corpus 1090 of 1161 contexts have the marker mid-sentence, and they
  // carry every role a model ever assigned.
  const body = para({
    paraId: 'p0',
    charStart: 0,
    text: 'The reaction is catalysed by a base [7] in a hydrophobic active site.'
  })
  const scan = scanCallouts({
    paragraphs: [body],
    knownOrdinals: new Set([7]),
    bibliography: { range: [-1, -1], entries: [] }
  })
  assert.equal(scan.callouts.length, 1)
  assert.equal(scan.callouts[0].sentence, body.text, 'unchanged — one sentence, marker inside it')
})

test('an entry that could not be located contributes no region', () => {
  // -1/-1 means "no region", never offset zero — which would fence off the top
  // of the paper and silently drop every callout on its first page.
  const body = para({ paraId: 'p0', charStart: 0, text: 'As shown previously [1], the enzyme.' })
  const scan = scanCallouts({
    paragraphs: [body],
    knownOrdinals: new Set([1]),
    bibliography: { range: [-1, -1], entries: [[-1, -1]] }
  })
  assert.equal(scan.callouts.length, 1)
})

test('a range marker yields one row per ordinal at one site', () => {
  const scan = scanCallouts({
    paragraphs: [para({ paraId: 'p0', charStart: 0, text: 'Prior work [12,15-17] agrees.' })],
    knownOrdinals: new Set([12, 15, 16, 17]),
    bibliography: { range: [-1, -1], entries: [] }
  })
  assert.deepEqual(
    scan.callouts.map((c) => c.ordinal),
    [12, 15, 16, 17]
  )
  const offsets = new Set(scan.callouts.map((c) => c.offset))
  assert.equal(offsets.size, 1, 'one printed marker is one site; the ordinal disambiguates')
})

test('a callout naming an absent entry is dropped and counted, never invented', () => {
  // Turning it into an unresolved_reference would put a blank reference in
  // front of the user with an invitation to go and fetch it — there is no
  // bibliography entry to copy any text from.
  const scan = scanCallouts({
    paragraphs: [para({ paraId: 'p0', charStart: 0, text: 'See [99] for details.' })],
    knownOrdinals: new Set([1, 2]),
    bibliography: { range: [-1, -1], entries: [] }
  })
  assert.equal(scan.callouts.length, 0)
  assert.equal(scan.danglingCallouts, 1)
})

test('the confidence gate refuses a mapping it cannot trust', () => {
  const thin = { callouts: [], malformedMarkers: 0, danglingCallouts: 0, distinctOrdinals: 2 }
  assert.equal(calloutGate(thin, 60).ok, false, 'too few distinct markers')

  const sparse = { callouts: [], malformedMarkers: 0, danglingCallouts: 0, distinctOrdinals: 6 }
  assert.equal(calloutGate(sparse, 60).ok, false, 'under 50% of entries cited')

  const good = { callouts: [], malformedMarkers: 0, danglingCallouts: 0, distinctOrdinals: 40 }
  assert.equal(calloutGate(good, 60).ok, true)
})
