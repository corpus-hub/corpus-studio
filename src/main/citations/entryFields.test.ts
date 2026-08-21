// Unit tests for the per-style field extractor.
//
// EVERY entry string below is VERBATIM from a real PDF's text layer in this
// corpus, including its defects — the spaced-out hyphen in "Celebi - Olcum",
// the lowercase initial in "Althoff, E. a.", the page footer spliced into the
// middle of an ACS Catalysis entry. Synthetic inputs would pass while the real
// ones failed, which is how the previous parser scored zero titles on five
// papers while its own tests were green.
//
// Run via `npm run test:citations`.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  detectStyle,
  extractFields,
  findTail,
  findAuthorEnd,
  splitMiddle,
  GENERIC_STYLE,
  type StyleProfile
} from './entryFields'
import { foldText, unwrapLines } from './normalize'

/** Prepare an entry exactly as `parseReferences` does before extraction. */
function body(raw: string): string {
  return unwrapLines(foldText(raw))
    .replace(/^\s*(?:\[\d{1,3}\]|\(\d{1,3}\)|\d{1,3}\.)\s*/, '')
    .replace(/^\s*\d{1,3}\s+/, '')
}

function profileFor(...raws: string[]): StyleProfile {
  return detectStyle(raws.map(body))
}

// ------------------------------------------------------------------ the tails

test('findTail reads Nature\u2019s volume, pages and parenthesised year', () => {
  const t = findTail(body('1. Radzicka, A. & Wolfenden, R. A proficient enzyme. Science 267, 90 \u2013 93 (1995).'))
  assert.equal(t?.shape, 'vol-pages-year')
  assert.equal(t?.volume, '267')
  assert.equal(t?.pages, '90-93')
  assert.equal(t?.year, 1995)
})

test('findTail reads the ACS year-volume-pages order', () => {
  const t = findTail(body('1. Tantillo, D. J.; Jiangang, C.; Houk, K. N., Curr. Opin. Chem. Bio. 1998, 2, 743-750.'))
  assert.equal(t?.shape, 'year-vol-pages')
  assert.equal(t?.year, 1998)
  assert.equal(t?.volume, '2')
  assert.equal(t?.pages, '743-750')
})

test('findTail reads the Elsevier volume-(year)-pages order', () => {
  const t = findTail(
    body(
      '[1] A. Warshel, P.K. Sharma, M. Kato, Y. Xiang, H. Liu, M.H. Olsson, Electrostatic basis\nfor enzyme catalysis, Chem. Rev. 106 (2006) 3210 \u2013 3235.'
    )
  )
  assert.equal(t?.shape, 'vol-year-pages')
  assert.equal(t?.volume, '106')
  assert.equal(t?.year, 2006)
  assert.equal(t?.pages, '3210-3235')
})

test('findTail reads a volume-(year)-pages tail that abbreviates its pages "pp."', () => {
  // Comptes Rendus Chimie, and Elsevier's older house style. The shape is the
  // one above exactly, with the publisher's abbreviation in front of the page
  // range — and without this the whole coordinate was swept into the title
  // instead, which is what printed "(2013), pp. 116-128" on a reference card.
  const t = findTail(
    body('[2] S. H. Cho, J. Y. Kim, J. Kwak and S. Chang, Chem. Soc. Rev.\n40 (2011), pp. 5068\u20135083.')
  )
  assert.equal(t?.shape, 'vol-year-pages')
  assert.equal(t?.volume, '40')
  assert.equal(t?.year, 2011)
  assert.equal(t?.pages, '5068-5083')
})

test('findTail still reads that shape when the pages carry no "pp."', () => {
  // The abbreviation is OPTIONAL, not required: the Elsevier entry above prints
  // none, and both must keep working off the same pattern.
  const t = findTail(
    body('[1] S. Van de Vyver and Y. Roman-Leshkov, Angew. Chem., Int.\nEd. 54 (2015), pp. 12554\u201312561.')
  )
  assert.equal(t?.shape, 'vol-year-pages')
  assert.equal(t?.volume, '54')
  assert.equal(t?.pages, '12554-12561')
})

test('findTail reads the PNAS volume:pages colon form', () => {
  const t = findTail(
    body('1. Kirby AJ (1996) Enzyme mechanisms, models, and mimics. Angew Chem Int Ed Engl\n35:707 \u2013 724.')
  )
  assert.equal(t?.shape, 'vol-colon-pages')
  assert.equal(t?.volume, '35')
  assert.equal(t?.pages, '707-724')
})

test('findTail accepts an article id in place of a page range', () => {
  const t = findTail(
    body('2. Du, S. et al. Conformational ensembles reveal the origins of serine\nprotease catalysis. Science 387 , eado5068 (2025).')
  )
  assert.equal(t?.pages, 'eado5068')
  assert.equal(t?.year, 2025)
})

test('findTail skips an issue number between volume and pages', () => {
  const t = findTail(body('[2] L. Pauling, Chem. Eng. News 1946 , 24 (10), 1375 \u2013 1377.'))
  assert.equal(t?.volume, '24')
  assert.equal(t?.pages, '1375-1377')
  assert.equal(t?.year, 1946)
})

test('findTail takes the LAST coordinate, past spliced-in page furniture', () => {
  const raw =
    '2. Kiss, G.; \u00c7elebi \u2010 \u00d6l\u00e7\u00fcm, N.; Moretti, R.; Baker, D.; Houk, K., Angew. Chem. Int. Ed.\n2013, 52, 5700-5725.\nPage 18 of 21\nACS Paragon Plus Environment'
  const t = findTail(body(raw))
  assert.equal(t?.year, 2013)
  assert.equal(t?.volume, '52')
  assert.equal(t?.pages, '5700-5725')
})

// --------------------------------------------------------------- author lists

test('findAuthorEnd stops before an abbreviated journal name', () => {
  const b = body('3 M. Casey and D. Kemp, J. Org. Chem. , 1973, 58 , 33\u201334.')
  assert.equal(b.slice(0, findAuthorEnd(b, 'initials-first')).replace(/[\s,]+$/, ''), 'M. Casey and D. Kemp')
})

test('findAuthorEnd consumes a fourteen-author titleless ACS list whole', () => {
  const b = body(
    '3. R\u00f6thlisberger, D.; Khersonsky, O.; Wollacott, A. M.; Jiang, L.; DeChancie, J.; Betker, J.;\nGallaher, J. L.; Althoff, E. a.; Zanghellini, A.; Dym, O.; Albeck, S.; Houk, K. N.; Tawfik, D. S.;\nBaker, D., Nature 2008, 453, 190-5.'
  )
  const authors = b.slice(0, findAuthorEnd(b, 'surname-first'))
  assert.match(authors, /^Rothlisberger, D\./)
  // The lowercase "E. a." is a text-layer defect, not a list terminator.
  assert.match(authors, /Althoff, E\. a\.; Zanghellini/)
  assert.match(authors, /Baker, D\.\s*,?\s*$/)
})

test('findAuthorEnd terminates at "et al."', () => {
  const b = body(
    '3. Privett, H. K. et al. Iterative approach to computational enzyme design. Proc. Natl\nAcad. Sci. USA 109, 3790\u20133795 (2012).'
  )
  assert.equal(b.slice(0, findAuthorEnd(b, 'surname-first')).trim(), 'Privett, H. K. et al.')
})

test('findAuthorEnd reads the unpunctuated PNAS initials form', () => {
  const b = body(
    '3. Hollfelder F, Kirby AJ, Tawfik DS, Kikuchi K, Hilvert D (2000) Characterization of pro-\nton-transfer catalysis by serum albumins. J Am Chem Soc 122:1022 \u2013 1029.'
  )
  assert.equal(
    b.slice(0, findAuthorEnd(b, 'surname-first')).trim(),
    'Hollfelder F, Kirby AJ, Tawfik DS, Kikuchi K, Hilvert D'
  )
})

test('findAuthorEnd rejoins a surname whose hyphen was spaced out', () => {
  const b = body(
    '2. Kiss, G.; \u00c7elebi \u2010 \u00d6l\u00e7\u00fcm, N.; Moretti, R.; Baker, D.; Houk, K., Angew. Chem. Int. Ed.\n2013, 52, 5700-5725.'
  )
  assert.match(b.slice(0, findAuthorEnd(b, 'surname-first')), /Celebi - Olcum, N\./)
})

// ------------------------------------------------------------ title vs. venue

test('splitMiddle keeps a multi-word abbreviated venue intact', () => {
  const r = splitMiddle('Critical analysis of antibody catalysis. Annu. Rev. Biochem. ')
  assert.equal(r.title, 'Critical analysis of antibody catalysis')
  assert.equal(r.venue, 'Annu. Rev. Biochem.')
})

test('splitMiddle returns a null title when the style prints none', () => {
  assert.deepEqual(splitMiddle(' Nature '), { title: null, venue: 'Nature' })
})

// ----------------------------------------------------- whole-entry extraction

test('nature style: authors, title, venue, volume, pages and year', () => {
  const raw = '1. Radzicka, A. & Wolfenden, R. A proficient enzyme. Science 267, 90 \u2013 93 (1995).'
  assert.deepEqual(extractFields(body(raw), profileFor(raw)), {
    authors: 'Radzicka, A. & Wolfenden, R.',
    year: 1995,
    title: 'A proficient enzyme',
    venue: 'Science',
    volume: '267',
    pages: '90-93'
  })
})

test('ACS style prints NO title, and none is invented', () => {
  const raw = '1. Tantillo, D. J.; Jiangang, C.; Houk, K. N., Curr. Opin. Chem. Bio. 1998, 2, 743-750.'
  const f = extractFields(body(raw), profileFor(raw))
  assert.equal(f.title, null)
  assert.equal(f.authors, 'Tantillo, D. J.; Jiangang, C.; Houk, K. N.')
  assert.equal(f.venue, 'Curr. Opin. Chem. Bio.')
  assert.equal(f.volume, '2')
  assert.equal(f.pages, '743-750')
  assert.equal(f.year, 1998)
})

test('angewandte style: initials-first authors, no title', () => {
  const raw = '[4] C. C. Blake, D. F. Koenig, G. A. Mair, A. C. North, D. C.\nPhillips, V. R. Sarma, Nature 1965 , 206 , 757 \u2013 761.'
  const f = extractFields(body(raw), profileFor(raw))
  assert.equal(f.authors, 'C. C. Blake, D. F. Koenig, G. A. Mair, A. C. North, D. C. Phillips, V. R. Sarma')
  assert.equal(f.title, null)
  assert.equal(f.venue, 'Nature')
  assert.equal(f.year, 1965)
  assert.equal(f.volume, '206')
})

test('elsevier style: initials-first authors, comma-delimited title', () => {
  const raw =
    '[1] A. Warshel, P.K. Sharma, M. Kato, Y. Xiang, H. Liu, M.H. Olsson, Electrostatic basis\nfor enzyme catalysis, Chem. Rev. 106 (2006) 3210 \u2013 3235.'
  const f = extractFields(body(raw), profileFor(raw))
  assert.equal(f.authors, 'A. Warshel, P.K. Sharma, M. Kato, Y. Xiang, H. Liu, M.H. Olsson')
  assert.equal(f.title, 'Electrostatic basis for enzyme catalysis')
  assert.equal(f.venue, 'Chem. Rev.')
  assert.equal(f.year, 2006)
})

test('RSC style: "and"-joined initials-first authors, no title', () => {
  const raw = '3 M. Casey and D. Kemp, J. Org. Chem. , 1973, 58 , 33\u201334.'
  const f = extractFields(body(raw), profileFor(raw))
  assert.equal(f.authors, 'M. Casey and D. Kemp')
  assert.equal(f.title, null)
  assert.equal(f.venue, 'J. Org. Chem.')
  assert.equal(f.year, 1973)
  assert.equal(f.pages, '33-34')
})

test('PNAS style: parenthesised year between authors and title', () => {
  const raw =
    '2. Khersonsky O, et al. (2010) Evolutionary optimization of computationally designed\nenzymes: Kemp eliminases of the KE07 series. J Mol Biol 396:1025 \u2013 1042.'
  const f = extractFields(body(raw), profileFor(raw))
  assert.equal(f.authors, 'Khersonsky O, et al.')
  assert.equal(f.year, 2010)
  assert.equal(
    f.title,
    'Evolutionary optimization of computationally designed enzymes: Kemp eliminases of the KE07 series'
  )
  assert.equal(f.venue, 'J Mol Biol')
  assert.equal(f.pages, '1025-1042')
})

test('JMB style: parenthesised year, then volume and pages', () => {
  const raw =
    '1. Wolfenden, R. & Snider, M. J. (2001). The depth of\nchemical time and the power of enzymes as catalysts.\nAcc. Chem. Res. 34 , 938 \u2013 945.'
  const f = extractFields(body(raw), profileFor(raw))
  assert.equal(f.authors, 'Wolfenden, R. & Snider, M. J.')
  assert.equal(f.year, 2001)
  assert.equal(f.title, 'The depth of chemical time and the power of enzymes as catalysts')
  assert.equal(f.venue, 'Acc. Chem. Res.')
  assert.equal(f.volume, '34')
  assert.equal(f.pages, '938-945')
})

test('author-year style: unnumbered, bare year, volume:pages', () => {
  const raw =
    'Bachar, O., Fischer, D., Nussinov, R., and Wolfson, H. 1993. A computer vision\nbased technique for 3-D sequence-independent structural comparison of\nproteins. Protein Eng. 6: 279\u2013288.'
  const f = extractFields(body(raw), profileFor(raw))
  assert.equal(f.authors, 'Bachar, O., Fischer, D., Nussinov, R., and Wolfson, H.')
  assert.equal(f.year, 1993)
  assert.equal(
    f.title,
    'A computer vision based technique for 3-D sequence-independent structural comparison of proteins'
  )
  assert.equal(f.venue, 'Protein Eng.')
})

test('a leading author initial is not mistaken for the start of the venue', () => {
  const raw = '(2) Bolon, D. N.; Mayon, S. L. Proc. Natl. Acad. Sci. U.S.A. 2001 , 98 ,\n14274\u201314279 .'
  const f = extractFields(body(raw), profileFor(raw))
  assert.equal(f.venue, 'Proc. Natl. Acad. Sci. U.S.A.')
  assert.equal(f.year, 2001)
})

// ------------------------------------------------------------ style detection

test('detectStyle names ACS from a sample of its entries', () => {
  const p = profileFor(
    '1. Tantillo, D. J.; Jiangang, C.; Houk, K. N., Curr. Opin. Chem. Bio. 1998, 2, 743-750.',
    '4. Khersonsky, O.; Kiss, G.; R\u00f6thlisberger, D.; Dym, O.; Albeck, S.; Houk, K. N.; Baker, D.;\nTawfik, D. S., Proc. Natl. Acad. Sci. USA 2012, 109, 10358-63.'
  )
  assert.equal(p.style, 'acs')
  assert.equal(p.authorOrder, 'surname-first')
  assert.equal(p.tail, 'year-vol-pages')
})

test('detectStyle names Angewandte from initials-first, year-first entries', () => {
  const p = profileFor(
    '[2] L. Pauling, Chem. Eng. News 1946 , 24 (10), 1375 \u2013 1377.',
    '[4] C. C. Blake, D. F. Koenig, G. A. Mair, A. C. North, D. C.\nPhillips, V. R. Sarma, Nature 1965 , 206 , 757 \u2013 761.'
  )
  assert.equal(p.style, 'angewandte')
  assert.equal(p.authorOrder, 'initials-first')
})

test('detectStyle names Nature from volume-pages-(year) entries', () => {
  const p = profileFor(
    '1. Radzicka, A. & Wolfenden, R. A proficient enzyme. Science 267, 90 \u2013 93 (1995).',
    '2. Bolon, D. N. & Mayo, S. L. Enzyme-like proteins by computational design. Proc.\nNatl Acad. Sci. USA 98, 14274 \u2013 14279 (2001).'
  )
  assert.equal(p.style, 'nature')
  assert.equal(p.tail, 'vol-pages-year')
})

test('detectStyle names Elsevier from volume-(year)-pages entries', () => {
  const p = profileFor(
    '[1] A. Warshel, P.K. Sharma, M. Kato, Y. Xiang, H. Liu, M.H. Olsson, Electrostatic basis\nfor enzyme catalysis, Chem. Rev. 106 (2006) 3210 \u2013 3235.',
    '[3] M. Fuxreiter, A. Warshel, Origin of the catalytic power of acetylcholineesterase.\nComputer simulation studies, J. Am. Chem. Soc. 120 (1998) 183 \u2013 194.'
  )
  assert.equal(p.style, 'elsevier')
  assert.equal(p.tail, 'vol-year-pages')
})

test('detectStyle falls back to generic on thin, disagreeing evidence', () => {
  const p = profileFor('Some prose that is not a citation at all.', 'Nor is this one.')
  assert.equal(p.style, 'generic')
  assert.equal(p.tail, 'none')
})

test('detectStyle is deterministic: same entries, identical profile', () => {
  const raws = [
    '1. Radzicka, A. & Wolfenden, R. A proficient enzyme. Science 267, 90 \u2013 93 (1995).',
    '2. Bolon, D. N. & Mayo, S. L. Enzyme-like proteins by computational design. Proc.\nNatl Acad. Sci. USA 98, 14274 \u2013 14279 (2001).'
  ]
  assert.deepEqual(profileFor(...raws), profileFor(...raws))
})

test('extractFields never fabricates a field it cannot read', () => {
  assert.deepEqual(extractFields('Unpublished results.', GENERIC_STYLE), {
    authors: null,
    year: null,
    title: null,
    venue: null,
    volume: null,
    pages: null
  })
})
