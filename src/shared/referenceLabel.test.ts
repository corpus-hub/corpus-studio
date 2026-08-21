// What to CALL a cited paper this corpus does not hold.
//
// Every string below is VERBATIM from a real PDF's text layer in this corpus,
// including its defects — the entry that prints no title at all, the one whose
// author list the text layer dropped entirely, the one whose "title" is really
// its own volume and page range. A constructed input would pass here while the
// real one put "untitled reference" on a card.
//
// Run via `npm run test:references`.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { referenceLabel } from './referenceLabel'

test('a real title is used exactly as printed', () => {
  assert.equal(
    referenceLabel({
      title: 'Electrostatic Basis for Enzyme Catalysis',
      authors: 'Warshel, A.',
      year: 2006,
      venue: 'Chem. Rev.',
      raw_bib_text: 'x'
    }),
    'Electrostatic Basis for Enzyme Catalysis'
  )
})

test('authors and year name a reference whose style printed no title', () => {
  // ACS, RSC, Angewandte and older JACS print no title at all. 200 of the 206
  // title-less references in this corpus carry an author list, and the card said
  // "untitled reference" while it sat unused.
  assert.equal(
    referenceLabel({
      title: null,
      authors: 'Kiss, G.; Celebi - Olcum, N.; Moretti, R.; Baker, D.; Houk, K.',
      year: 2012,
      venue: null,
      raw_bib_text: 'x'
    }),
    'Kiss, G.; Celebi - Olcum, N.; Moretti, R.; Baker, D.; Houk, K. (2012)'
  )
})

test('authors with no year carry no empty parenthesis', () => {
  assert.equal(
    referenceLabel({ title: null, authors: 'Latombe, J.', year: null, venue: null, raw_bib_text: 'x' }),
    'Latombe, J.'
  )
})

test('the year can be suppressed for a caller that prints it separately', () => {
  // The references canvas draws the year on its own line above the title slot;
  // without this the year appears twice in a 96px column.
  assert.equal(
    referenceLabel(
      { title: null, authors: 'M. Muller, G. A. Sprenger and M. Pohl', year: 2013, venue: null, raw_bib_text: 'x' },
      { withYear: false }
    ),
    'M. Muller, G. A. Sprenger and M. Pohl'
  )
})

test('the venue names a reference with neither title nor authors', () => {
  assert.equal(
    referenceLabel({
      title: null,
      authors: null,
      year: 1998,
      venue: 'Curr. Opin. Chem. Bio.',
      raw_bib_text: 'x'
    }),
    'Curr. Opin. Chem. Bio. (1998)'
  )
})

test('the printed line is the last resort, never a placeholder', () => {
  // 6 references in this corpus carry no title, no authors and no venue. The
  // printed line is still real evidence and is what the reader can act on;
  // "untitled reference" tells them nothing they did not already see.
  assert.equal(
    referenceLabel({
      title: null,
      authors: null,
      year: null,
      venue: null,
      raw_bib_text: '20. . Nature 358, 209-215 (1992)'
    }),
    '20. . Nature 358, 209-215 (1992)'
  )
})

test('a stored title that is really a citation coordinate is not used', () => {
  // "Chem. Soc. Rev. 40 (2011), pp. 5068-5083" reached the title field on every
  // one of one paper's 85 entries. The parser no longer produces these, but rows
  // stored before that fix do not re-parse themselves.
  assert.equal(
    referenceLabel({
      title: 'Chem. Soc. Rev. 40 (2011), pp. 5068-5083',
      authors: 'S. H. Cho, J. Y. Kim, J. Kwak and S. Chang',
      year: 2011,
      venue: null,
      raw_bib_text: 'x'
    }),
    'S. H. Cho, J. Y. Kim, J. Kwak and S. Chang (2011)'
  )
})

test('an author list that is really a citation coordinate is not used', () => {
  // Verbatim from a card in this corpus: the text layer mangled the entry, so
  // the parser put the rest of the citation in the author slot and the card
  // read "J. Amer. Chem. Soc., 90, 2598 (1968); W. T. Fo…" as if it were a name.
  assert.equal(
    referenceLabel({
      title: null,
      authors: 'J. Amer. Chem. Soc., 90, 2598 (1968); W. T. Forbes',
      year: 1968,
      venue: 'J. Amer. Chem. Soc.',
      raw_bib_text: 'x'
    }),
    'J. Amer. Chem. Soc. (1968)'
  )
})

test('a volume-and-page pair in the author slot is caught without a year', () => {
  // "Nature 358, 209-215" carries no parenthesised year, so the title-side test
  // alone would miss it. A name list has no reason to contain "358, 209" either.
  assert.equal(
    referenceLabel({
      title: null,
      authors: '. Nature 358, 209-215',
      year: 1992,
      venue: null,
      raw_bib_text: '20. . Nature 358, 209-215 (1992)'
    }),
    '20. . Nature 358, 209-215 (1992)'
  )
})

test('a coordinate that prints its year AFTER the pages is caught too', () => {
  // Verbatim from a card in this corpus, spaced-out letters and all: the
  // title-shaped test originally matched only "vol (year) pages" and missed
  // "vol, page (year)", so this rendered as the paper's name. The authors here
  // are perfectly good and are what the card should show.
  assert.equal(
    referenceLabel({
      title: 'J . Amer. Chem. S o c . , 90, 2598 (1968); W. T. Ford and D. J. Cram, zbzd., 90, 2606 (1968)',
      authors: 'D. J. Cram, W. T. Ford, and L. Gosser',
      year: 1968,
      venue: null,
      raw_bib_text: 'x'
    }),
    'D. J. Cram, W. T. Ford, and L. Gosser (1968)'
  )
})

test('a coordinate the entry BEGINS with is caught, volume and all lost', () => {
  // Verbatim from cards in this corpus. A mis-split bibliography leaves an entry
  // holding one citation's tail: the volume belongs to the previous fragment, so
  // the earlier tests — which all require a volume before the year — matched
  // nothing and the card read "(2013), pp. 116-128" as a paper's name.
  assert.equal(
    referenceLabel({
      title: '(2013), pp. 116-128',
      authors: null,
      year: 2013,
      venue: null,
      raw_bib_text: '355 (2013), pp. 116\u2013128.\n[40] G. Garg, S. S. Dhiman'
    }),
    '355 (2013), pp. 116\u2013128.\n[40] G. Garg, S. S. Dhiman'
  )
  assert.equal(
    referenceLabel({
      title: 'pp. 5068-5083. [3] K. Faber, W. D. Fessner and N. J. Turner, Biocatalysis',
      authors: null,
      year: 2011,
      venue: 'Chem. Soc. Rev.',
      raw_bib_text: 'x'
    }),
    'Chem. Soc. Rev. (2011)'
  )
})

test('prose that merely opens with a year is not a coordinate', () => {
  // The leading-form test demands a page range immediately after the year, so a
  // title that begins with one survives.
  assert.equal(
    referenceLabel({
      title: '(2017) was a landmark year for computational protein design',
      authors: 'Baker, D.',
      year: 2017,
      venue: null,
      raw_bib_text: 'x'
    }),
    '(2017) was a landmark year for computational protein design'
  )
})

test('a real title containing a parenthesised year survives', () => {
  // The coordinate test must not reject prose. A version number or a year inside
  // a genuine title is ordinary — this is the shape that would be misread.
  assert.equal(
    referenceLabel({
      title: 'Attention Is All You Need (2017) revisited: ten lessons',
      authors: 'Vaswani, A.',
      year: 2021,
      venue: null,
      raw_bib_text: 'x'
    }),
    'Attention Is All You Need (2017) revisited: ten lessons'
  )
})

test('an index title outranks the printed one, and only where there is no printed title', () => {
  // `index_title` is written ONLY for rows whose printed side had no usable
  // title, so the two can never contend for the same row.
  assert.equal(
    referenceLabel({
      index_title: 'Theozymes and compuzymes: theoretical models for biological catalysis',
      title: null,
      authors: 'Tantillo, D. J.; Jiangang, C.; Houk, K. N.',
      year: 1998,
      venue: 'Curr. Opin. Chem. Bio.',
      raw_bib_text: 'x'
    }),
    'Theozymes and compuzymes: theoretical models for biological catalysis'
  )
})
