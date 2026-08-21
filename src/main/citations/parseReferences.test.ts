// Unit tests for the deterministic reference parser.
//
// Run via `npm run test:citations` (node's built-in test runner under tsx).
// Every input here is a literal string, so these tests pin PARSER BEHAVIOUR
// only — they never touch the DB or a PDF, and they must pass identically on
// every machine.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  locateReferenceSection,
  splitEntries,
  splitSubEntries,
  seriesPart,
  parseEntry,
  parseReferences,
  matchReferences,
  scoreMatch,
  titleSimilarity,
  containment,
  MATCH_THRESHOLD,
  type CorpusWork
} from './parseReferences'
import {
  foldText,
  normalizeDoi,
  findDois,
  venueSimilarity,
  extractSurnames,
  surnamesEqual,
  unwrapLines
} from './normalize'

// ------------------------------------------------------------- normalization

test('foldText folds accents, ligatures and dashes', () => {
  assert.equal(foldText('Röthlisberger'), 'Rothlisberger')
  assert.equal(foldText('ﬁne'), 'fine')
  assert.equal(foldText('190\u2013195'), '190-195')
})

test('foldText rejoins an accent pdfjs emitted as its own run', () => {
  // "Ro ¨ thlisberger" is what the text layer actually produces for several
  // papers in the corpus; it must fold to the same string as the composed form.
  assert.equal(foldText('Ro \u00a8 thlisberger'), 'Rothlisberger')
  assert.equal(foldText('Ro\u00a8thlisberger'), 'Rothlisberger')
})

test('foldText rejoins a ligature pdfjs emitted as its own run', () => {
  // Same defect as the standalone accent above, and the same consequence: an
  // author list is consumed unit by unit, so a name broken by a positioned
  // ligature ENDS the list and the remaining authors are reported as the title.
  // Work 10's reference 16 lost eight authors to "Altho ff" that way.
  assert.equal(foldText('Altho ff , E. A.'), 'Althoff, E. A.')
  assert.equal(foldText('Taw fi k, D. S.'), 'Tawfik, D. S.')
  assert.equal(foldText('e ffi cient'), 'efficient')
  // A word carrying a REAL f-run is untouched: the pattern needs a letter, a
  // space and then the bare ligature standing alone as its own token.
  assert.equal(foldText('off the shelf'), 'off the shelf')
  assert.equal(foldText('affinity'), 'affinity')
})

test('normalizeDoi strips resolvers, prefixes and trailing punctuation', () => {
  assert.equal(normalizeDoi('https://doi.org/10.1038/Nature06879'), '10.1038/nature06879')
  assert.equal(normalizeDoi('doi:10.1038/nature06879.'), '10.1038/nature06879')
})

test('findDois extracts DOIs and dedupes them', () => {
  assert.deepEqual(findDois('see 10.1038/nature06879 and doi:10.1038/nature06879.'), [
    '10.1038/nature06879'
  ])
})

test('venueSimilarity understands abbreviation but not mere prefixing', () => {
  assert.equal(venueSimilarity('J. Mol. Biol.', 'Journal of Molecular Biology'), 1)
  assert.equal(venueSimilarity('Nature', 'Nature'), 1)
  // "Proteins" must NOT be treated as "Protein Science": the bidirectional
  // rule costs the missing "science" token.
  assert.ok(venueSimilarity('Proteins', 'Protein Science') < 0.6)
})

test('unwrapLines de-hyphenates across a line break', () => {
  assert.equal(unwrapLines('biomo-\nlecular recognition'), 'biomolecular recognition')
})

test('extractSurnames pulls surnames out of an author blob', () => {
  const s = extractSurnames('Wolfenden, R. & Snider, M. J.')
  assert.ok(s.includes('wolfenden'))
  assert.ok(s.includes('snider'))
})

// ------------------------------------------------------- section + splitting

const JMB = `
Some body text that goes on for a while so the heading is not in the front matter.
More body text here to push the offset past the front-matter guard used by the
locator, which ignores headings in the first quarter of a document.

References
1. Wolfenden, R. & Snider, M. J. (2001). The depth of
chemical time and the power of enzymes as catalysts.
Acc. Chem. Res. 34 , 938 – 945.
2. Boehr, D. D., Nussinov, R. & Wright, P. E. (2009). The
role of dynamic conformational ensembles in biomo-
lecular recognition. Nat. Chem. Biol. 5 , 789 – 796.
3. Rothlisberger, D., Khersonsky, O., Wollacott, A. M. et al. (2008). Kemp
elimination catalysts by computational enzyme design. Nature 453 , 190 – 195.
`.repeat(1)

test('locateReferenceSection finds an explicit heading', () => {
  const loc = locateReferenceSection(JMB)
  assert.equal(loc.strategy, 'heading')
  assert.ok(JMB.slice(loc.start).startsWith('1. Wolfenden'))
})

test('splitEntries cuts a dot-numbered list into entries', () => {
  const loc = locateReferenceSection(JMB)
  const { entries, style } = splitEntries(JMB.slice(loc.start, loc.end))
  assert.equal(style, 'dot')
  assert.equal(entries.length, 3)
  assert.deepEqual(entries.map((e) => e.ordinal), [1, 2, 3])
})

test('parseReferences is deterministic: same input, identical output', () => {
  const a = parseReferences(JMB)
  const b = parseReferences(JMB)
  assert.deepEqual(a, b)
})

test('each entry reports where it is printed, in the DOCUMENT offset space', () => {
  // The span is what lets the callout scanner exclude a reference printed as a
  // footnote in the middle of the body, where no single section range can. It
  // must therefore index the whole document, not the section slice: an offset
  // measured against the slice places every entry near the top of the paper.
  const { references } = parseReferences(JMB)
  assert.ok(references.length >= 3)
  for (const r of references) {
    assert.ok(r.char_start >= 0, `entry ${r.ordinal} was not located`)
    assert.ok(r.char_end > r.char_start)
    const printed = JMB.slice(r.char_start, r.char_end)
    // The span covers the entry's own text, and stops before the next one's.
    assert.ok(
      printed.startsWith(r.raw_bib_text.slice(0, 12)),
      `entry ${r.ordinal} span starts at ${JSON.stringify(printed.slice(0, 30))}`
    )
  }
  for (let i = 1; i < references.length; i++) {
    assert.ok(
      references[i].char_start >= references[i - 1].char_end,
      'spans must not overlap, or one entry fences off the next callout'
    )
  }
})

test('an entry parsed without a document reports no region, never offset zero', () => {
  // `store.ts` re-hydrates an entry from its stored text to re-match it against
  // a grown corpus; there is no document to locate it in. Reporting 0/0 there
  // would fence off the top of every paper.
  const r = parseEntry('1. Wolfenden, R. (2001). A title. Acc. Chem. Res. 34, 938-945.', 1)
  assert.equal(r.char_start, -1)
  assert.equal(r.char_end, -1)
})

test('parseEntry extracts authors, year, title and preserves raw text', () => {
  const raw =
    '1. Wolfenden, R. & Snider, M. J. (2001). The depth of chemical time and the power of enzymes as catalysts. Acc. Chem. Res. 34 , 938 – 945.'
  const r = parseEntry(raw, 1)
  assert.equal(r.raw_bib_text, raw)
  assert.equal(r.year, 2001)
  assert.match(r.title ?? '', /depth of chemical time/)
  assert.ok(r.surnames.includes('wolfenden'))
})

test('parseEntry keeps raw_bib_text byte-identical to its input', () => {
  const raw = '2. Boehr, D. D. (2009). The role of dynamic\nconformational ensembles. Nat. Chem. Biol. 5 , 789 – 796.'
  assert.equal(parseEntry(raw, 2).raw_bib_text, raw)
})

test('parseEntry finds a DOI when one is printed', () => {
  const r = parseEntry('5. Someone, A. (2015). A title here. J. Foo 1, 2. doi:10.1234/abc.def', 5)
  assert.equal(r.doi, '10.1234/abc.def')
})

test('parseEntry returns no title for a titleless ACS-style entry', () => {
  // ACS prints authors, journal, year, volume, pages — and no title at all.
  // Returning author debris as a "title" would poison the matcher.
  const r = parseEntry(
    '1. Tantillo, D. J.; Jiangang, C.; Houk, K. N., Curr. Opin. Chem. Bio. 1998, 2, 743-750.',
    1
  )
  assert.equal(r.title, null)
  assert.equal(r.year, 1998)
})

test('a bracket-numbered bibliography splits correctly', () => {
  const text = `${'filler line\n'.repeat(40)}
References
[1] A. Warshel, P.K. Sharma, Electrostatic basis for enzyme catalysis, Chem. Rev. 106 (2006) 3210-3235.
[2] R.A. Marcus, On the theory of oxidation-reduction reactions, J. Phys. Chem. 24 (1956) 966.
[3] M. Fuxreiter, A. Warshel, Origin of the catalytic power, J. Am. Chem. Soc. 120 (1998) 183-194.
`
  const { references, diagnostics } = parseReferences(text)
  assert.equal(diagnostics.entry_style, 'bracket')
  assert.equal(references.length, 3)
})

test('numbered body-section headings do not hijack the reference list', () => {
  // "2. Concluding Remarks" / "3. Methods" form a short ascending run; the real
  // bibliography is longer and must win.
  const text = `${'filler\n'.repeat(30)}
1. Introduction
Some introductory prose that runs on for a sentence or two.
2. Concluding Remarks
More prose about the conclusions drawn by the authors here.
3. Methods
A description of the methods used, also spanning a line or two.
${Array.from({ length: 12 }, (_, i) => `${i + 1}. Author${i + 1} A, et al. (200${i % 10}) A study title number ${i + 1} about enzymes. J Foo Bar ${i + 1}:1-10.`).join('\n')}
`
  const { references } = parseReferences(text)
  assert.ok(references.length >= 12, `expected the 12-entry list, got ${references.length}`)
  assert.match(references[0].raw_bib_text, /Author1/)
})

test('a PDF with no text layer reports no_text_layer rather than throwing', () => {
  const r = parseReferences('\n\f\n\n\f\n')
  assert.equal(r.diagnostics.no_text_layer, true)
  assert.deepEqual(r.references, [])
})

// ------------------------------------------------------------------ matching

const CORPUS: CorpusWork[] = [
  {
    work_id: 1,
    title: 'Kemp elimination catalysts by computational enzyme design',
    year: 2008,
    doi: '10.1038/nature06879',
    author_surnames: ['Röthlisberger', 'Khersonsky', 'Wollacott'],
    venue: 'Nature'
  },
  {
    work_id: 2,
    title: 'Evolutionary optimization of computationally designed enzymes: Kemp eliminases of the KE07 series',
    year: 2010,
    doi: '10.1016/j.jmb.2009.11.020',
    author_surnames: ['Khersonsky', 'Röthlisberger', 'Dym'],
    venue: 'Journal of Molecular Biology'
  }
]

test('titleSimilarity is symmetric and 1 for identical titles', () => {
  assert.equal(titleSimilarity(CORPUS[0].title, CORPUS[0].title), 1)
  assert.equal(
    titleSimilarity(CORPUS[0].title, CORPUS[1].title),
    titleSimilarity(CORPUS[1].title, CORPUS[0].title)
  )
})

test('containment is asymmetric and finds a title inside a long entry', () => {
  const entry =
    'Rothlisberger D, et al. (2008) Kemp elimination catalysts by computational enzyme design. Nature 453:190-195.'
  assert.equal(containment(CORPUS[0].title, entry), 1)
})

test('a DOI match resolves exactly, at confidence 1', () => {
  const refs = [parseEntry('1. Anyone. A title. Nature 453, 190 (2008). doi:10.1038/nature06879', 1)]
  const [m] = matchReferences(refs, CORPUS)
  assert.equal(m.work_id, 1)
  assert.equal(m.method, 'doi')
  assert.equal(m.confidence, 1)
})

test('an accented author name still matches its unaccented citation', () => {
  const ref = parseEntry(
    '12. Ro \u00a8 thlisberger, D. et al. Kemp elimination catalysts by computational enzyme design. Nature 453, 190-195 (2008).',
    12
  )
  const { score } = scoreMatch(ref, CORPUS[0])
  assert.ok(score >= MATCH_THRESHOLD, `expected >= threshold, got ${score}`)
})

test('an unrelated reference does not match anything', () => {
  const ref = parseEntry(
    '9. Metropolis N, Rosenbluth AW (1953) Equation of state calculations by fast computing machines. J Chem Phys 21:1087-1092.',
    9
  )
  const [m] = matchReferences([ref], CORPUS)
  assert.equal(m.work_id, null)
  assert.equal(m.confidence, 0)
})

test('a titleless entry with a mismatched year is refused', () => {
  // Same authors, same journal, WRONG year — the only separator is the year, so
  // this must not resolve.
  const ref = parseEntry(
    '4. Khersonsky, O.; Röthlisberger, D.; Dym, O., J. Mol. Biol. 2013, 396, 1025-1042.',
    4
  )
  const { score } = scoreMatch(ref, CORPUS[1])
  assert.ok(score < MATCH_THRESHOLD, `expected below threshold, got ${score}`)
})

test('a titleless entry agreeing on author, venue and year resolves', () => {
  const ref = parseEntry(
    '5. Khersonsky, O.; Röthlisberger, D.; Dym, O.; Albeck, S., J. Mol. Biol. 2010, 396, 1025-42.',
    5
  )
  const [m] = matchReferences([ref], CORPUS)
  assert.equal(m.work_id, 2)
})

test('excludeWorkId prevents a paper citing itself', () => {
  const ref = parseEntry(
    '1. Rothlisberger D, et al. (2008) Kemp elimination catalysts by computational enzyme design. Nature 453:190-195.',
    1
  )
  const [m] = matchReferences([ref], CORPUS, { excludeWorkId: 1 })
  assert.equal(m.work_id, null)
})

test('one work is claimed by at most one reference per citing paper', () => {
  const refs = [
    parseEntry('1. Rothlisberger D, et al. (2008) Kemp elimination catalysts by computational enzyme design. Nature 453:190-195.', 1),
    parseEntry('2. Rothlisberger D, et al. (2008) Kemp elimination catalysts by computational enzyme design. Nature 453:190-195.', 2)
  ]
  const ms = matchReferences(refs, CORPUS)
  assert.equal(ms.filter((m) => m.work_id === 1).length, 1)
})

test('matchReferences is deterministic across repeated runs', () => {
  const refs = parseReferences(JMB).references
  assert.deepEqual(matchReferences(refs, CORPUS), matchReferences(refs, CORPUS))
})

// --------------------------------------- real strings from the corpus' PDFs
//
// Every literal below is copied verbatim out of a text layer in
// scripts/data/ke07-corpus.json's PDFs, damage included, so these tests pin the
// parser against what the files actually contain rather than against tidy prose.

test('surnamesEqual tolerates exactly one substituted character', () => {
  // Paper 18's font cmap decodes "ö" as "c", so pdfjs emits "Rcthlisberger".
  assert.ok(surnamesEqual('rcthlisberger', 'rothlisberger'))
  // ...but two differences, or a short name, must NOT be conflated.
  assert.ok(!surnamesEqual('rcthlasberger', 'rothlisberger'))
  assert.ok(!surnamesEqual('kemp', 'kamp'))
  assert.ok(!surnamesEqual('casey', 'cosey'))
})

test('a cmap-damaged first author still matches its corpus work', () => {
  // Paper 18, reference 171 — a titleless Angewandte entry whose ONLY
  // discriminating signal is the (damaged) lead surname.
  const ref = parseEntry(
    '[171] D. Rcthlisberger, O. Khersonsky, A. M. Wollacott, L. Jiang, J. DeChancie, J. Betker, J. L. Gallaher, E. A. Althoff, A. Zanghellini, O. Dym, S. Albeck, K. N. Houk, D. S. Tawfik, D. Baker, Nature 2008 , 453 , 190 - 195.',
    171
  )
  const [m] = matchReferences([ref], CORPUS)
  assert.equal(m.work_id, 1)
})

test('a hanging bare marker spliced behind a running head still starts an entry', () => {
  // Paper 12 (PCCP) sets reference numbers as hanging digits, and the page
  // footer flows into the text layer directly ahead of entry 2.
  const section = `1 L. Jiang, E. A. Althoff and D. Baker, Science , 2008, 319 , 1387-1391.
This journal is the Owner Societies 2016 Phys. Chem. Chem. Phys. 2 D. Ro \u00a8thlisberger, O. Khersonsky, A. M. Wollacott and D. Baker, Nature , 2008, 453 , 190-195.
3 M. Casey and D. Kemp, J. Org. Chem. , 1973, 58 , 33-34.
4 A. N. Alexandrova, D. Ro \u00a8thlisberger and D. Baker, J. Am. Chem. Soc. , 2008, 130 , 15907-15915.`
  const { entries } = splitEntries(section)
  assert.deepEqual(entries.map((e) => e.ordinal), [1, 2, 3, 4])
  assert.match(entries[1].raw, /^2 D\. Ro/)
})

test('a lettered ACS entry yields one reference per part', () => {
  // Paper 8, reference 13 — two different papers under one number.
  const body =
    '(a) Casey, M. L.; Kemp, D. S.; Paul, K. G.; Cox, D. D. J. Org. Chem. 1973 , 38 , 2294-2301. (b) Kemp, D. S.; Casey, M. L. J. Am. Chem. Soc. 1973 , 95 , 6670-6680 .'
  const parts = splitSubEntries(body)
  assert.equal(parts.length, 2)
  assert.match(parts[0].text, /^Casey, M\. L\./)
  assert.match(parts[1].text, /^Kemp, D\. S\./)
  // The LETTER as printed, carried with the part. Every consumer that needs to
  // tell a part from the composite it came out of reads this; deriving it from
  // the array index instead breaks as soon as a part is dropped for length.
  assert.deepEqual(parts.map((p) => p.label), ['a', 'b'])
})

test('splitSubEntries reports an ordinary single-part entry as no parts', () => {
  // EMPTY, not `[body]`: the caller's question is "is this a composite", and an
  // entry that is not one has no parts to add beside itself. Answering with the
  // body made the caller compare lengths to find out.
  const body = 'Na, J.; Houk, K. N.; Hilvert, D. J. Am. Chem. Soc. 1996 , 118 , 6462- 6471 .'
  assert.deepEqual(splitSubEntries(body), [])
})

test('a part carries its letter and an ordinary entry carries none', () => {
  // The distinction every count downstream has to make: the composite stands
  // for what the page printed, the parts for the papers under it. Both share
  // the ordinal, so the ordinal cannot separate them and the label must.
  const whole = parseEntry('Na, J.; Houk, K. N. J. Am. Chem. Soc. 1996 , 118 , 6462-6471 .', 11)
  assert.equal(whole.part_label, null, 'an entry that is not part of a composite has no label')

  const part = parseEntry(
    'Kemp, D. S.; Casey, M. L. J. Am. Chem. Soc. 1973 , 95 , 6670-6680 .',
    11,
    undefined,
    undefined,
    'b'
  )
  assert.equal(part.part_label, 'b')
  assert.equal(part.ordinal, 11, 'a part keeps the parent ordinal it was printed under')
})

test('seriesPart reads the roman part number of a multi-part series', () => {
  assert.equal(
    seriesPart('Physical organic chemistry of benzisoxazoles. I. Mechanism of the base-catalyzed decomposition'),
    '1'
  )
  assert.equal(
    seriesPart('Physical organic chemistry of benzisoxazoles II. Linearity of the bronsted free energy relationship'),
    '2'
  )
  assert.equal(seriesPart('Kemp elimination catalysts by computational enzyme design'), null)
})

test('part II of a series does not resolve onto part I', () => {
  // Papers 9, 10 and 19 all cite Kemp & Casey's part II. Its title shares almost
  // every token with part I, and the authors and year agree, so only the part
  // number separates them.
  const series: CorpusWork[] = [
    {
      work_id: 3,
      title:
        'Physical organic chemistry of benzisoxazoles. I. Mechanism of the base-catalyzed decomposition of benzisoxazoles',
      year: 1973,
      doi: null,
      author_surnames: ['Casey', 'Kemp', 'Paul', 'Cox'],
      venue: 'The Journal of Organic Chemistry'
    }
  ]
  const partTwo = parseEntry(
    '14. Kemp DS, Casey ML (1973) Physical organic chemistry of benzisoxazoles II. Linearity of the bronsted free energy relationship for the base-catalyzed decomposition of benzisoxazoles. J Am Chem Soc 95:6670 - 6680.',
    14
  )
  assert.equal(matchReferences([partTwo], series)[0].work_id, null)

  const partOne = parseEntry(
    '20. Casey M, Kemp D, Paul K, Cox D (1973) Physical organic chemistry of benzisoxazoles. I. Mechanism of the base-catalyzed decomposition of benzisoxazoles. J Org Chem 38:2294 - 2301.',
    20
  )
  assert.equal(matchReferences([partOne], series)[0].work_id, 3)
})

test('a republication with the same title but a different year AND venue is refused', () => {
  // Hollfelder/Kirby/Tawfik published "Off-the-shelf proteins ..." in Nature
  // 1996 and again in J. Org. Chem. 2001. Title and authors agree perfectly, so
  // only the year and venue together separate them.
  const nature: CorpusWork[] = [
    {
      work_id: 4,
      title: 'Off-the-shelf proteins that rival tailor-made antibodies as catalysts',
      year: 1996,
      doi: null,
      author_surnames: ['Hollfelder', 'Kirby', 'Tawfik'],
      venue: 'Nature'
    }
  ]
  const jorgchem = parseEntry(
    '15. Hollfelder F, Kirby AJ, Tawfik DS (2001) Off-the-shelf proteins that rival tailor-made antibodies as catalysts. J Org Chem 66:5866 - 5874.',
    15
  )
  assert.equal(matchReferences([jorgchem], nature)[0].work_id, null)

  const real = parseEntry(
    '13. Hollfelder, F., Kirby, A. J. & Tawfik, D. S. (1996). Offthe-shelf proteins that rival tailor-made antibodies as catalysts. Nature , 383 , 60 - 62.',
    13
  )
  assert.equal(matchReferences([real], nature)[0].work_id, 4)
})

test('a short generic title does not match by whole-entry containment', () => {
  // "Computational Enzyme Design" is three tokens, all of them ubiquitous in
  // this field, so containment against a whole entry is meaningless.
  const review: CorpusWork[] = [
    {
      work_id: 5,
      title: 'Computational Enzyme Design',
      year: 2013,
      doi: null,
      author_surnames: ['Kiss', 'Celebi-Olcum', 'Moretti'],
      venue: 'Angewandte Chemie International Edition'
    }
  ]
  // Paper 19, reference 47 — a DIFFERENT Baker-lab design paper. All three of
  // the review's title tokens appear in it, so whole-entry containment scores it
  // near-perfect...
  const unrelated = parseEntry(
    '47. Siegel JB, Zanghellini A, Lovick H, Kiss G, Lambert A (2010) Computational Design of an Enzyme Catalyst for a Stereoselective Bimolecular Diels-Alder Reaction. Science 329:309-313.',
    47
  )
  assert.ok(
    containment(review[0].title, unrelated.raw_bib_text) >= 0.99,
    'precondition: containment alone would rate this a perfect match'
  )
  // ...and the guard is what stops that from becoming a match.
  assert.equal(matchReferences([unrelated], review)[0].work_id, null)

  const real = parseEntry(
    '20. Kiss, G., Celebi-Olcum, N., Moretti, R., Baker, D. & Houk, K. N. Computational enzyme design. Angew. Chem. Int. Ed. 52 , 5700 - 5725 (2013).',
    20
  )
  assert.equal(matchReferences([real], review)[0].work_id, 5)
})

// ---------------------------------------------------------------------------
// Regressions found by reading the 20 real PDFs in the corpus and comparing
// the parser's output against what is printed on the page. Each of these was a
// live defect, not a hypothetical.
// ---------------------------------------------------------------------------

test('a numbered run of figure captions is not mistaken for a bibliography', () => {
  // A 1973 chemistry paper numbered its figures in strict sequence, and that
  // run was longer than its reference list — so the section was located at 5%
  // of the document and 47,000 characters of body text were parsed as
  // references. Captions carry no year+author/page signature; citations do.
  const captions = Array.from(
    { length: 12 },
    (_, i) =>
      `${i + 1}. Variation of pseudo-first-order rate constant for decomposition as a function of concentration.`
  ).join('\n')
  const loc = locateReferenceSection(captions)
  assert.equal(loc.strategy, 'none', 'figure captions must not be located as a reference section')
})

test('a real numbered bibliography is still located without a heading', () => {
  const refs = Array.from(
    { length: 10 },
    (_, i) =>
      `${i + 1}. Radzicka, A. & Wolfenden, R. A proficient enzyme. Science 267, 90-93 (199${i % 10}).`
  ).join('\n')
  const loc = locateReferenceSection(refs)
  assert.equal(loc.strategy, 'numbered-tail')
})

test('an entry does not run past the end of its citation', () => {
  // One Nature paper produced a 21,916-character "reference": a real citation
  // followed by the Acknowledgements, a page footer and the whole Methods
  // section. That blob then gets matched against other papers.
  // The runaway is the LAST entry, which is where it happens in practice: with
  // no following marker to stop it, the slice runs to the end of the section.
  const body = 'The enzyme was purified as described. '.repeat(80)
  const section =
    '1. Kries, H. De novo enzymes. Curr. Opin. Chem. Biol. 17, 221-228 (2013).\n' +
    '2. Lassila, J. K. Origins of catalysis. Annu. Rev. Biochem. 79, 471-505 (2010).\n' +
    '3. Blomberg, R. & Hilvert, D. Precision is essential. Nature 503, 418-421 (2013).\n' +
    body
  const { entries } = splitEntries(section)
  const last = entries.find((e) => e.ordinal === 3)
  assert.ok(last, 'the last entry must still be found')
  assert.ok(
    last.raw.length < 400,
    `entry should stop at its citation tail, got ${last.raw.length} chars`
  )
  assert.ok(last.raw.includes('418-421'), 'the citation itself must be kept intact')
  assert.ok(!last.raw.includes('purified as described'), 'body text must not be absorbed')
})

test('a reference list is not cut short by a heading that precedes it', () => {
  // Two-column extraction interleaves the paper's own section headings with the
  // reference text. An unguarded terminator fired before the first citation and
  // cut a 50-entry list down to 17.
  const section = [
    'Summary',
    'We report a computational design.',
    ...Array.from(
      { length: 12 },
      (_, i) => `${i + 1}. Author, A. B. Title of the work. J. Am. Chem. Soc. 130, ${100 + i}-${120 + i} (200${i % 10}).`
    ),
    'Acknowledgements',
    'We thank the funders.'
  ].join('\n')
  const loc = locateReferenceSection(section)
  const kept = section.slice(loc.start, loc.end)
  const { entries } = splitEntries(kept)
  assert.ok(entries.length >= 10, `expected the full list, got ${entries.length} entries`)
})

test('a wrapped author list does not start a new reference', () => {
  // A long author list wraps, and its continuation line also begins with a
  // surname — so a "line starts with a surname" rule split single references in
  // half, leaving stubs with no title and no year while the real citation lost
  // its first authors. One Protein Science paper turned 27 references into 32.
  const section = [
    'Berman, H.M., Battistuz, T., Bhat, T.N., Bluhm, W.F., Bourne, P.E.,',
    'Burkhardt, K., Feng, Z., Gilliland, G.L., Iype, L., Jain, S., et al.',
    '2002. The Protein Data Bank. Acta Crystallogr D 58: 899-907.',
    'Kuhlman, B. and Baker, D. 2000. Native protein sequences are close to',
    'optimal for their structures. Proc Natl Acad Sci 97: 10383-10388.'
  ].join('\n')
  const { entries } = splitEntries(section)
  assert.equal(entries.length, 2, `expected 2 references, got ${entries.length}`)
  assert.ok(entries[0].raw.includes('Berman'), 'first entry keeps its first author')
  assert.ok(entries[0].raw.includes('899-907'), 'first entry keeps its page range')
  assert.ok(entries[1].raw.includes('Kuhlman'), 'second entry starts at the next reference')
})

test("a reference does not inherit the citing paper's own DOI", () => {
  // Publishers stamp the article's DOI into the page footer, which lands inside
  // whichever reference sits at the foot of that page. A DOI short-circuits
  // matching entirely, so one stray footer silently mis-links a citation.
  const section = [
    '(1) Bolon, D. N.; Mayo, S. L. Proc. Natl. Acad. Sci. 2001, 98, 14274-14279.',
    '10.1021/ja804040s CCC: $40.75',
    '(2) Hilvert, D. Annu. Rev. Biochem. 2000, 69, 751-793.',
    '10.1021/ja804040s CCC: $40.75',
    '(3) Kemp, D. S.; Casey, M. L. J. Am. Chem. Soc. 1973, 95, 6670-6680.'
  ].join('\n')
  const { references } = parseReferences(section)
  const repeated = references.filter((r) => r.doi === '10.1021/ja804040s')
  assert.equal(repeated.length, 0, 'a DOI repeated across references is page furniture')
})

test('references continuing after the section are still captured', () => {
  // Nature-family papers print the main list, then keep NUMBERING into a
  // "Methods References" block at the very end of the document. In one paper
  // here refs 30-34 sit at 98-100% while the located section ends at 66%, so
  // stopping at the section boundary silently lost five real references.
  const main = Array.from(
    { length: 12 },
    (_, i) => `${i + 1}. Author, A. B. A study of things. J. Biol. Chem. 27${i}, 90-93 (199${i % 10}).`
  ).join('\n')
  const filler = 'Methods\nProteins were expressed and purified as described. '.repeat(30)
  const cont = [13, 14, 15]
    .map((n) => `${n}. Later, C. D. A methods citation. Acta Crystallogr. 50, 760-763 (1994).`)
    .join('\n')
  const { references } = parseReferences(`${main}\n${filler}\n${cont}`)
  const ords = references.map((r) => r.ordinal)
  for (const n of [13, 14, 15]) {
    assert.ok(ords.includes(n), `reference ${n} from the continuation block must be captured`)
  }
})

test('a renumbered list after the references is not treated as a continuation', () => {
  // Only entries CONTINUING the sequence are taken. A numbered figure legend or
  // procedure that restarts at 1 must not be swept in.
  const main = Array.from(
    { length: 10 },
    (_, i) => `${i + 1}. Author, A. B. A study. J. Biol. Chem. 27${i}, 90-93 (199${i % 10}).`
  ).join('\n')
  const legend = [
    '1. Schematic of the reaction in 2005 conditions.',
    '2. Variation of rate constant measured in 2005.',
    '3. Structure of the active site solved in 2005.'
  ].join('\n')
  const { references } = parseReferences(`${main}\n\nFigure legends\n${legend}`)
  assert.equal(references.length, 10, `expected only the 10 real references, got ${references.length}`)
})

/**
 * `parseReferences` locates a section by finding an ascending run of at least
 * MIN_RUN (8) markers, so a fixture with two or three entries has no section at
 * all. `pad` appends plain filler citations continuing the numbering, letting a
 * test state only the entries it cares about.
 */
function pad(lines: string[], from: number, style: 'dot' | 'paren' = 'dot'): string {
  const out = [...lines]
  for (let n = from; n < from + 8; n++) {
    const mark = style === 'paren' ? `( ${n} )` : `${n}.`
    out.push(`${mark} Filler, A. B. A perfectly ordinary study of things. J. Mol. Biol. 300, ${n}-${n + 9} (200${n % 10}).`)
  }
  return out.join('\n')
}

test('a real hyphen survives a line break, a syllable break does not', () => {
  // "ring-\nopening" is printed with that hyphen; "biomo-\nlecular" is one word
  // the typesetter split. Dropping every line-final hyphen produced titles like
  // "ringopening", "Xray" and "physicochemical", which then fail to match the
  // same paper cited elsewhere without the wrap.
  const section = pad([
    '1. Na, J. & Houk, K. N. Transition state of the base-promoted ring-',
    'opening of isoxazoles. J. Am. Chem. Soc. 118, 6462-6471 (1996).',
    '2. Someone, A. B. A study of biomo-',
    'lecular assemblies. J. Mol. Biol. 300, 1-10 (2000).',
    '3. Third, C. D. Processing of X-',
    'ray diffraction data. Methods Enzymol. 276, 307-326 (1997).'
  ], 4)
  const { references } = parseReferences(section)
  const all = references.map((r) => `${r.title ?? ''}`).join(' | ')
  assert.ok(all.includes('ring-opening'), `real hyphen must survive: ${all}`)
  assert.ok(all.includes('biomolecular'), `syllable break must close up: ${all}`)
  assert.ok(all.includes('X-ray'), `real hyphen must survive: ${all}`)
})

test('publisher furniture does not become a title, venue or DOI', () => {
  // A reference straddling a page break has the running head, footer and
  // copyright line spliced into its middle. The footer carries the CITING
  // article's DOI, which a DOI-first matcher would then act on.
  const section = pad([
    '1. Abecassis, V., Pompon, D. & Truan, G. High efficiency family shuffling based on',
    'multi-step PCR and in vivo DNA recombination in yeast: statistical and functional',
    'ARTICLES NATURE | Vol 453 | 8 May 2008',
    '194',
    'Nature Publishing Group ©2008',
    'analysis of a combinatorial library. Nucleic Acids Res. 28, E88 (2000).',
    '2. Barlow, M. & Hall, B. G. Predicting evolutionary potential. Genetics 160, 823-832 (2002).',
    'doi:10.1038/nature06879',
    'Nature Publishing Group ©2008'
  ], 3)
  const { references } = parseReferences(section)
  const first = references.find((r) => r.ordinal === 1)
  assert.ok(first, 'the reference must still be found')
  assert.ok(!/Nature Publishing Group/i.test(String(first.title)), `furniture in title: ${first.title}`)
  assert.ok(!/NATURE \| Vol/i.test(String(first.title)), `running head in title: ${first.title}`)
  const second = references.find((r) => r.ordinal === 2)
  assert.ok(second, 'the second reference must be found')
  assert.notEqual(second.doi, '10.1038/nature06879', "must not adopt the citing paper's DOI")
})

test('a title ending in a proper noun is not truncated at it', () => {
  // "Macromolecular modeling with Rosetta. Annu. Rev. Biochem." split forwards
  // at the first sentence period gave the title "Macromolecular modeling with"
  // and the venue "Rosetta. Annu. Rev. Biochem.".
  const section = pad([
    '1. Das, R. & Baker, D. Macromolecular modeling with Rosetta. Annu. Rev. Biochem. 77, 363-382 (2008).',
    '2. Rohl, C. A. & Baker, D. Protein structure prediction using Rosetta. Methods Enzymol. 383, 66-93 (2004).',
    '3. Other, A. B. Something entirely different here. J. Mol. Biol. 300, 1-10 (2000).'
  ], 4)
  const { references } = parseReferences(section)
  const first = references.find((r) => r.ordinal === 1)
  assert.ok(first, 'reference found')
  assert.ok(
    String(first.title).includes('Rosetta'),
    `title must keep the trailing proper noun, got ${JSON.stringify(first.title)}`
  )
})

test('a short numbered note is kept, because the slot is evidence', () => {
  // Older papers mix citations and notes in one numbered list. "(21) Reference
  // 16, p 678." fell under the general minimum entry length, so the paper
  // reported gaps where the author had printed something.
  const section = pad([
    '(1) Jencks, W. P. Catalysis in Chemistry and Enzymology, McGraw-Hill, 1969, p 480.',
    '(2) Bordwell, F. G. and Boyle, W. J. J. Am. Chem. Soc. 1972, 94, 3907.',
    '(3) Reference 16, p 678.',
    '(4) Saloman, P. and Long, F. A. J. Org. Chem. 1973, 38, 2294.',
    '(5) Kemp, D. S. and Casey, M. L. J. Am. Chem. Soc. 1973, 95, 6670.',
    '(6) Casey, M. L. and Cox, D. D. J. Org. Chem. 1973, 38, 2301.',
    '(7) Hilvert, D. Annu. Rev. Biochem. 2000, 69, 751.',
    '(8) Thorn, S. N. Nature 1995, 373, 228.'
  ], 9, 'paren')
  const { references } = parseReferences(section)
  assert.ok(
    references.some((r) => r.ordinal === 3),
    `the numbered note must be kept: got ${references.map((r) => r.ordinal).join(',')}`
  )
})

test('a marker with spaces inside its parentheses is recognised', () => {
  // Older typography and glyph-run text layers print "( 8 )" rather than "(8)";
  // the entry was otherwise merged into its predecessor and its number vanished.
  const section = pad([
    '( 1 ) Kemp, D. S. and Casey, M. L. J. Am. Chem. Soc. 1973, 95, 6670-6680.',
    '( 2 ) Shelton, J. R. and Liang, C. K. Synthesis 1971, 4, 204-206.',
    '( 3 ) Jencks, W. P. Catalysis in Chemistry 1969, 12, 480-490.',
    '( 4 ) "Inorganic Synthesis," Vol. 5, McGraw-Hill, New York, 1957, p 122-130.',
    '( 5 ) Bordwell, F. G. J. Am. Chem. Soc. 1972, 94, 3907-3911.',
    '( 6 ) Zemplen, G. Acta Chem. 1960, 83, 449-455.',
    '( 7 ) Long, F. A. J. Org. Chem. 1973, 38, 2294-2300.',
    '( 8 ) Miller, B. I. J. Chem. Soc. 1969, 91, 468-475.'
  ], 9, 'paren')
  const { references } = parseReferences(section)
  assert.ok(
    references.some((r) => r.ordinal === 4),
    `spaced marker must be recognised: got ${references.map((r) => r.ordinal).join(',')}`
  )
})
