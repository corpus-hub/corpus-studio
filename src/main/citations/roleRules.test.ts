// The cue table, pinned against realistic sentences.
//
// This fixture exists because the table's ORDERING is counter-intuitive and was
// wrong twice before it was right. The two cases that matter most are adjacent
// and look alike:
//
//   "Our Tm of 62.4 °C exceeds the 54 °C reported for [17]"  -> comparison
//   "Our results are inconsistent with the 3-fold ... [14]"  -> contrast
//
// Exceeding a prior value is not disagreement, and a sentence carrying a stance
// marker is not a comparison merely because it also carries a number. Both
// failed under comparison-first ordering. Deleting a row here without a reason
// re-opens a class of confidently-wrong roles that a reader cannot detect by
// looking at the output.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyRole, expandRolesFixture } from './roleRules'

const CASES: Array<{ sentence: string; section: string; expect: string | null }> = [
  {
    sentence: 'Our Tm of 62.4 °C exceeds the 54 °C reported for the homologous esterase [17].',
    section: 'results',
    expect: 'r6-comparison'
  },
  {
    sentence: 'Our results are inconsistent with the 3-fold improvement claimed in [14].',
    section: 'results',
    expect: 'r4-contrast'
  },
  {
    sentence: 'In agreement with the values reported by [12], our variant exceeded 60 °C.',
    section: 'results',
    expect: 'r5-support'
  },
  {
    sentence: 'Data were obtained from [12], which reported values higher than ours.',
    section: 'methods',
    expect: 'r3-data-source'
  },
  {
    sentence: 'These results corroborate the findings of [8].',
    section: 'discussion',
    expect: 'r5-support'
  },
  {
    sentence: 'Mutagenesis was performed as described in [4].',
    section: 'methods',
    expect: 'r2-method'
  },
  { sentence: 'For a recent review see [3].', section: 'introduction', expect: 'r1-review' },
  {
    sentence: 'In contrast to [17], we did not observe any thermal stabilisation.',
    section: 'results',
    expect: 'r4-contrast'
  },
  {
    sentence: 'Thermostability remains a major challenge for industrial biocatalysis [1,2].',
    section: 'introduction',
    expect: 'r7-motivation'
  },
  {
    sentence: 'Directed evolution has been widely applied to esterases [5].',
    section: 'introduction',
    expect: 'r8-intro-default'
  },
  {
    sentence: 'The variant showed a 4-fold higher kcat than the wild type [9].',
    section: 'results',
    expect: 'r6-comparison'
  },
  {
    sentence: 'Sequences were retrieved from UniProt [21].',
    section: 'methods',
    expect: 'r3-data-source'
  },
  {
    sentence: 'We could not reproduce the 12-fold improvement reported in [14].',
    section: 'results',
    expect: 'r4-contrast'
  },
  // The residue: no rule is entitled to an opinion, and guessing would produce
  // a confident wrong role indistinguishable from a right one.
  {
    sentence: 'Crystals were grown at 291 K, a condition also used in [30].',
    section: 'methods',
    expect: null
  },
  {
    sentence: 'Activity was measured with the assay of [7] at pH 7.5.',
    section: 'methods',
    expect: null
  },
  // A relational word with NO number is not a numeric comparison. The `11` is
  // the citation marker, not a quantity the author reported.
  {
    sentence: 'This is a substantial advance relative to previous work [11].',
    section: 'discussion',
    expect: null
  },
  // ...and the same sentence cited by superscript, which reaches us as a bare
  // digit run flush against the preceding word.
  {
    sentence: 'This is a substantial advance relative to previous work11.',
    section: 'discussion',
    expect: null
  },
  // The measurement must survive the marker-stripping. If it does not, every
  // genuine comparison in the corpus silently becomes residue.
  {
    sentence: 'Our Tm of 62.4 °C exceeds the 54 °C reported for the homologous esterase17.',
    section: 'results',
    expect: 'r6-comparison'
  },

  // ---- cases a sentence audit over this domain's prose found wrong ----------
  // A CONCESSIVE clause carries an explicit method or stance cue AND a relation
  // AND a number. The relation is the least informative of the three, so it
  // must not win — the same reasoning that already put stance ahead of
  // comparison, extended to method, which it had never been.
  {
    sentence: 'Although the trend agrees with [4], the absolute values are 5-fold lower.',
    section: 'results',
    expect: 'r5-support'
  },
  {
    sentence: 'Although we followed the protocol of [5], our yields were 10-fold lower.',
    section: 'results',
    expect: 'r2-method'
  },
  // Digits that are a NAME, not a quantity. Leaving them made r6's numeric
  // guard vacuous a second way: a bare relational word plus a gene name.
  {
    sentence: 'This is a substantial advance relative to previous work in CYP450 systems [11].',
    section: 'discussion',
    expect: null
  },
  {
    sentence: 'The W120F variant behaves differently relative to the parent [6].',
    section: 'results',
    expect: null
  },
  // Real method and data-source prose the first cue lists did not reach.
  {
    sentence: 'Site-directed mutagenesis followed the protocol of [2].',
    section: 'methods',
    expect: 'r2-method'
  },
  {
    sentence: 'The CHARMM36m force field [24] was applied to all systems.',
    section: 'methods',
    expect: 'r2-method'
  },
  {
    sentence: 'Kinetic parameters were fitted with the model of [25].',
    section: 'methods',
    expect: 'r2-method'
  },
  {
    sentence: 'Thermostability data for the 214 homologues were taken from [18].',
    section: 'methods',
    expect: 'r3-data-source'
  },
  {
    sentence: 'The training set was drawn from the ProThermDB entries curated in [29].',
    section: 'methods',
    expect: 'r3-data-source'
  },
  {
    sentence: 'The half-life at 60 °C (42 min) is comparable to the 39 min reported in [12].',
    section: 'results',
    expect: 'r5-support'
  }
]

test('the cue table classifies every fixture sentence as intended', () => {
  for (const c of CASES) {
    const verdict = classifyRole(c.sentence, c.section)
    assert.equal(
      verdict?.cue ?? null,
      c.expect,
      `${JSON.stringify(c.sentence)} -> ${verdict?.cue ?? 'residue'} (wanted ${c.expect ?? 'residue'})`
    )
  }
})

test('every rule id maps to a role the database CHECK accepts', () => {
  const ALLOWED = new Set([
    'background',
    'method',
    'comparison',
    'support',
    'contrast',
    'data-source',
    'motivation',
    'review',
    'other'
  ])
  for (const { id, role } of expandRolesFixture()) {
    assert.ok(ALLOWED.has(role), `${id} emits '${role}', which the CHECK would reject`)
  }
})

test('a rule never overwrites an earlier one — first match wins', () => {
  // Carries a data-source cue AND a comparison cue AND a number. r3 is checked
  // first, so a provenance statement is a data source whatever else it says.
  const v = classifyRole('Data were obtained from [12], 3-fold higher than ours.', 'results')
  assert.equal(v?.cue, 'r3-data-source')
})
