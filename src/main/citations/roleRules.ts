// The deterministic half of citation-role classification.
//
// Applied to the SENTENCE containing a callout, never the paragraph: a
// paragraph routinely holds several cues belonging to several callouts, so
// paragraph-level matching would give a method cue's role to a contrast
// callout three sentences away. First match wins, and a rule only ever WRITES
// a role — nothing is overwritten, so a callout is decided by exactly one rule.
//
// ORDERING IS THE INTERESTING PART, and it is not the obvious one. Contrast and
// support come BEFORE comparison, because they are explicit STANCE markers
// ("inconsistent with", "in agreement with") while comparison cues ("exceeds",
// "higher than") are merely RELATIONAL and co-occur with stance markers
// constantly. Ordering comparison first classified "Our results are inconsistent
// with the 3-fold improvement claimed in [14]" as a comparison, because the
// sentence contains a number.
//
// A sentence that is genuinely a comparison is still caught, and NOT because
// comparison is checked first: it is caught because it contains no stance marker
// at all, which is precisely the property that makes it a comparison. Defending
// that through the absence of a cue rather than through rule order is what makes
// the table survive sentences that carry both.

/** The role vocabulary, exactly as the database CHECK spells it. */
export type CitationRole =
  | 'background'
  | 'method'
  | 'comparison'
  | 'support'
  | 'contrast'
  | 'data-source'
  | 'motivation'
  | 'review'
  | 'other'

export interface RoleRule {
  id: string
  role: CitationRole
  cue: RegExp
  /** An extra condition beyond the cue. Only r6 has one. */
  also?: (sentence: string) => boolean
}

/**
 * Ordered; first match wins.
 *
 * r1 before r2 — "as described in the review by [8]" is a review pointer, not a
 * method. r3 before the stance rules — a data-provenance statement is a data
 * source first, whatever else the sentence goes on to say.
 */
export const ROLE_RULES: readonly RoleRule[] = [
  {
    id: 'r1-review',
    role: 'review',
    cue: /(?:reviewed in|for a (?:recent |comprehensive )?review,? see|(?:recent|comprehensive) review (?:of|by)|see .{0,30}for a review)/i
  },
  {
    id: 'r2-method',
    role: 'method',
    cue: /(?:using the (?:method|protocol|procedure)s?\b|as (?:previously )?described (?:in|by)|(?:following|followed) the (?:protocol|procedure|method)|according to (?:the )?(?:method|protocol|procedure)|adapted from|as in ref\.?|(?:were|was) (?:performed|carried out|fitted|assessed|conducted) (?:as|with|using|in|at|following)|purchased from|force field|we used the)/i
  },
  {
    id: 'r3-data-source',
    role: 'data-source',
    cue: /(?:data (?:for [^,.]{0,40})?(?:were |was )?(?:taken|obtained|retrieved|downloaded|drawn) from|datasets? (?:are |is |was |were )?(?:available|deposited|obtained|taken)|(?:training|test|validation) set (?:was |were )?(?:taken|drawn|obtained|curated)|sequences? (?:were |was )?(?:obtained|retrieved|taken) from|structures? (?:were |was )?(?:taken|retrieved|obtained) from|deposited (?:in|at)|PDB (?:entry|ID|code)|accession (?:number|code))/i
  },
  {
    id: 'r4-contrast',
    role: 'contrast',
    cue: /(?:in contrast (?:to|with)|by contrast|unlike|contrary to|disagree(?:s|d|ment)?|inconsisten(?:t|cy) with|contradict(?:s|ed|ory)?|at odds with|fail(?:s|ed)? to reproduce|(?:could|was|were) not (?:be )?reproduced?|we did not observe|whereas .{0,40}reported|however,? .{0,40}reported)/i
  },
  {
    id: 'r5-support',
    role: 'support',
    cue: /(?:consistent with|in (?:good |excellent |close )?agreement with|agrees? with|in line with|similar to (?:that|those) (?:reported|observed|found)|comparable to (?:the|that|those)|as (?:also )?(?:observed|reported|found|shown) (?:by|in)|reproduce[ds]? the .{0,40}(?:reported|observed) in|corroborat(?:e|es|ed|ing)|support(?:s|ing)? (?:the|our|this|these)|confirm(?:s|ing|ed)? (?:the|our|these))/i
  },
  {
    id: 'r6-comparison',
    role: 'comparison',
    cue: /(?:compared (?:to|with)|in comparison (?:to|with)|exceed(?:s|ed|ing)?|outperform(?:s|ed|ing)?|higher than|lower than|greater than|less than|versus|\bvs\.?(?:\s|$)|relative to|-fold (?:higher|lower|improvement|increase)|than (?:that|those|the) reported)/i,
    // A relational word with no number ("relative to previous work") is not a
    // numeric comparison; it falls through to the later rules or the residue.
    //
    // The digits of the CALLOUT ITSELF do not count, and that is the whole
    // subtlety: every sentence this function ever sees contains a citation
    // marker, and a marker is made of digits. Testing the raw sentence made the
    // guard vacuously true for the entire bracket-citing corpus, so
    // "a substantial advance relative to previous work [11]" classified as a
    // numeric comparison on the strength of the 11.
    also: (s) => /\d/.test(withoutMarkers(s))
  },
  {
    id: 'r7-motivation',
    role: 'motivation',
    cue: /(?:remains? (?:a |an )?(?:major |significant |key )?(?:challenge|problem|bottleneck|limitation)|has (?:long )?been limited by|motivat(?:e|es|ed|ing|ion)|to address this|there is (?:a |an )?(?:growing |pressing )?(?:need|demand)|despite (?:considerable|significant|recent|much) (?:progress|advances|effort))/i
  }
]

/**
 * The sentence with its citation markers removed, for cue tests that ask
 * whether the AUTHOR wrote a number.
 *
 * Superscript callouts survive canonicalisation as bare digit runs, so both
 * shapes are stripped: a bracketed `[11,14]` and a trailing superscript `11`
 * are the same claim printed two ways, and letting one satisfy a numeric test
 * while the other did not would make a rule fire on the journal's typesetting
 * rather than on the sentence.
 *
 * The superscript pattern demands the run sit flush against a WORD, with no
 * space — that adjacency is what distinguishes `esterase17` (a marker whose
 * space the extractor never had) from `of 62.4 °C` (a measurement the author
 * wrote). A looser rule strips the measurement too and turns every genuine
 * comparison into residue.
 *
 * Digits glued into a TOKEN are removed as well, and for the opposite reason:
 * `CYP450`, `H2O2`, `W120F`, `IC50` and `p53` are names, not quantities, and
 * leaving them made the numeric guard vacuous again — a bare relational word
 * plus a gene name satisfied r6. Names and markers are both "digits that are
 * not a measurement", so both go.
 */
function withoutMarkers(sentence: string): string {
  return sentence
    .replace(/\[[0-9,;\s\u2010-\u2015-]+\]/g, ' ')
    .replace(/\bref\.?\s*\d+(?:\s*[,\u2010-\u2015-]\s*\d+)*/gi, ' ')
    // Any token containing a letter loses its digits: an identifier, never a
    // measured value. A measurement is written with a SPACE before its unit
    // (`62.4 °C`, `10 mM`, `4-fold`), so it never matches this.
    .replace(/\b(?=[^\s]*[A-Za-z])[A-Za-z][^\s.,;:)]*\d[^\s.,;:)]*/g, ' ')
}

/** Sections whose uncued citations are, by default, background reading. */
const INTRO_SECTIONS = new Set(['introduction', 'background', 'related-work'])

export interface RoleVerdict {
  role: CitationRole
  /** The rule that fired. */
  cue: string
}

/**
 * Classify one callout, or return null to send it to the LLM residue.
 *
 * `null` is not a failure: it means no deterministic rule is entitled to an
 * opinion, and guessing would produce a confident wrong role indistinguishable
 * from a right one. `role_source` is what tells those apart later, so a rule
 * must never claim a judgement it did not make.
 */
export function classifyRole(sentence: string, section: string): RoleVerdict | null {
  for (const rule of ROLE_RULES) {
    if (!rule.cue.test(sentence)) continue
    if (rule.also && !rule.also(sentence)) continue
    return { role: rule.role, cue: rule.id }
  }
  if (INTRO_SECTIONS.has(section)) return { role: 'background', cue: 'r8-intro-default' }
  return null
}

/**
 * Every (rule id, role) pair this module can emit, including r8's default.
 *
 * Exists so the fixture can assert the whole vocabulary against the database
 * CHECK rather than only the roles the sample sentences happen to reach — a
 * rule whose role the CHECK refuses fails at INSERT, on a real paper, long
 * after the change that introduced it.
 */
export function expandRolesFixture(): Array<{ id: string; role: CitationRole }> {
  return [
    ...ROLE_RULES.map((r) => ({ id: r.id, role: r.role })),
    { id: 'r8-intro-default', role: 'background' as CitationRole }
  ]
}
