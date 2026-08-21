// May an index's title stand in for the one the page printed?
//
// Every printed line below is VERBATIM from a real PDF's text layer in this
// corpus, and every index record is the authoritative Crossref record for the
// DOI that entry resolves to. The cases that matter here are the ones a
// constructed input cannot produce: an entry holding two spliced references, an
// entry whose author list the text layer destroyed, an erratum wearing the
// authors of the paper it corrects.
//
// Run via `npm run test:references`.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { adoptIndexTitle } from './adoptTitle'

/** A printed entry, reduced to what the decision is allowed to look at. */
function printed(p: {
  title?: string | null
  surnames?: string[]
  venue?: string | null
}): { title: string | null; surnames: string[]; venue: string | null } {
  return { title: p.title ?? null, surnames: p.surnames ?? [], venue: p.venue ?? null }
}

test('a real printed title always wins', () => {
  // The printed line is what the reader sees on the page. A scruffy title that
  // matches the paper beats a clean one that might not.
  assert.equal(
    adoptIndexTitle(
      printed({ title: 'Kemp elimination catalysts by computational enzyme design', surnames: ['rothlisberger'] }),
      { title: 'Kemp Elimination Catalysts by Computational Enzyme Design', authors: 'Rothlisberger' }
    ),
    'refused'
  )
})

test('a titleless entry whose authors vouch for the index record is adopted', () => {
  // ACS prints no title at all. Two surnames agree, so an independent witness
  // exists and the index title is this paper's name.
  assert.equal(
    adoptIndexTitle(
      printed({ title: null, surnames: ['tantillo', 'houk'], venue: 'Curr. Opin. Chem. Bio.' }),
      {
        title: 'Theozymes and compuzymes: theoretical models for biological catalysis',
        authors: 'Dean J. Tantillo; Chakka Jiangang; K. N. Houk'
      }
    ),
    'corroborated'
  )
})

test('one long surname is enough; one short one is not', () => {
  // A common short surname turns up by chance in a large author list, and
  // reconcile paired the row on a coordinate that cannot corroborate itself.
  assert.equal(
    adoptIndexTitle(printed({ surnames: ['warshel'] }), {
      title: 'Energetics of enzyme catalysis',
      authors: 'A. Warshel'
    }),
    'corroborated'
  )
  assert.equal(
    adoptIndexTitle(printed({ surnames: ['ro'] }), {
      title: 'Production of the antimalarial drug precursor artemisinic acid in engineered yeast',
      authors: 'Dae-Kyun Ro; Eric M. Paradise; Mario Ouellet'
    }),
    'refused'
  )
})

test('an index title is refused when the printed authors name a different paper', () => {
  // Ref 1984: the row holds TWO references spliced together by a page header,
  // so the coordinate agrees while the authors do not. Coordinate agreement is
  // not independent evidence — reconcile paired the row on it.
  assert.equal(
    adoptIndexTitle(printed({ surnames: ['dahiyat', 'mayo'] }), {
      title: 'Bayesian statistical analysis of protein side-chain rotamer preferences',
      authors: 'Roland L. Dunbrack; Fred E. Cohen'
    }),
    'refused'
  )
})

test('an index title is refused when the printed entry has no usable authors', () => {
  // "20. . Nature 358, 209-215 (1992)" — the text layer dropped the author list,
  // so the parser yields the VENUE in the author slot. That is not a witness.
  // The title is very probably right; "probably right" and "vouched for" must
  // not be stored as the same thing.
  assert.equal(
    adoptIndexTitle(printed({ surnames: ['nature'], venue: 'Nature' }), {
      title: 'Atomic structure and chemistry of human serum albumin',
      authors: 'Xiao Min He; Daniel C. Carter'
    }),
    'refused'
  )
})

test('a notice about a paper is never adopted as the paper', () => {
  // An erratum shares its authors, venue, volume AND first page with the paper
  // it corrects, so the author witness is structurally blind to it.
  for (const notice of [
    'Errata',
    'Erratum: Kemp elimination catalysts by computational enzyme design',
    'Corrigendum to "Enzymatic synthesis of rare sugars"',
    'Publisher Correction: Precision is essential for efficient catalysis',
    'Retraction: Structural evidence for evolution'
  ]) {
    assert.equal(
      adoptIndexTitle(printed({ surnames: ['rothlisberger', 'baker'] }), {
        title: notice,
        authors: 'Rothlisberger; Baker'
      }),
      'refused',
      notice
    )
  }
})

test('a title that merely begins with an ordinary word is not a notice', () => {
  // "Correction of a genetic defect in vivo" is a real paper.
  assert.equal(
    adoptIndexTitle(printed({ surnames: ['smith', 'jones'] }), {
      title: 'Correction of a genetic defect in vivo',
      authors: 'Smith; Jones'
    }),
    'corroborated'
  )
})

test('an index record with no title cannot be adopted', () => {
  assert.equal(
    adoptIndexTitle(printed({ surnames: ['warshel'] }), { title: null, authors: 'A. Warshel' }),
    'refused'
  )
})

test('a printed title that is really a citation coordinate does not block adoption', () => {
  // The parser used to sweep the coordinate into the title. Such a row has no
  // real printed title, so the index may name it.
  assert.equal(
    adoptIndexTitle(
      printed({ title: 'Chem. Soc. Rev. 40 (2011), pp. 5068-5083', surnames: ['cho', 'chang'] }),
      {
        title: 'Recent advances in the transition metal-catalyzed twofold oxidative C-H bond activation',
        authors: 'Seung Hwan Cho; Jun Yong Kim; Sukbok Chang'
      }
    ),
    'corroborated'
  )
})
