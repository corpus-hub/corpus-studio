// Reconciling what the PAPER PRINTED with what the INDEXES SAY, without letting
// either impersonate the other.
//
// The printed parse and the index reply are two witnesses to the same
// bibliography, and they fail in opposite directions. The parser sees exactly
// what is on the page — including entries no index holds — but loses entries to
// a bad text layer, a two-column bleed or an unrecognised section heading, and
// it cannot supply a DOI the paper did not print. The indexes never miss an
// entry the publisher deposited and always carry a DOI, but they cannot say
// where on the page anything sat, and for ~8% of entries they hold no DOI
// either.
//
// So the output is not a merge into one list. It is a per-entry statement of
// WHO SAW IT, keeping the printed entry authoritative for everything positional
// and the index authoritative for identity. A reader (or a UI) can always tell
// which of the two is making a given claim.
//
// The dedup ladder is the same one `referenceIdentityKey` already uses, for the
// same reason: DOI, then a normalized title, then nothing. What is added here
// is that a printed entry with no DOI can ACQUIRE one from an index entry it
// matches on title — which is what turns an unresolvable "J. Am. Chem. Soc.
// 2011" into a real handle.

import { contentTokens, normalizeDoi, normalizeLoose, venueSimilarity } from '../../citations/normalize'
import { containment, titleSimilarity } from '../../citations/parseReferences'
import type { ParsedReference } from '../../citations/parseReferences'
import type { ExternalReference, ExternalReferenceResult, ReferenceSource } from './types'
import { adoptIndexTitle, type TitleAdoption } from './adoptTitle'

/**
 * How similar two titles must be to be called the same paper when neither side
 * offers a DOI.
 *
 * Higher than the parser's own `MATCH_THRESHOLD` (0.62), deliberately. That
 * threshold scores a bibliography entry against a corpus work using authors and
 * year as well as title, so title alone carries 0.6 of the weight. Here the
 * title is frequently ALL there is — Crossref's Springer deposits give one
 * surname and no title field, OpenCitations gives nothing — so the title
 * comparison has to stand on its own, and a 0.62 title Dice between two
 * different papers in the same subfield is entirely ordinary ("computational
 * design of Kemp eliminases" vs "computational enzyme design").
 *
 * 0.82 was chosen by running the corpus and reading the pairs it merges and the
 * pairs it separates at 0.7 / 0.75 / 0.82 / 0.9; see `tmp/probe-reconcile.ts`.
 */
export const TITLE_MERGE_THRESHOLD = 0.82

/** The minimum content tokens a title needs before it may be compared at all. */
const MIN_TITLE_TOKENS = 4

export type Witness = 'printed' | ReferenceSource

/**
 * One paper cited by one citing paper, as reconciled from every witness.
 *
 * `printed` being null is the interesting case and the reason the module was
 * written: an index knows about a reference the parser did not recover.
 */
export interface ReconciledReference {
  /** Which witnesses saw this reference. Never empty. */
  witnesses: Witness[]
  /**
   * The parser's entry, when one matched. Carries `raw_bib_text` and the
   * printed offsets, which NOTHING else in this file can supply.
   *
   * NULL MEANS NO PAGE OF THIS PAPER WAS EVER SEEN TO NAME THIS REFERENCE.
   * An index says the citation exists and the app has not corroborated it —
   * usually because the parser missed the entry, sometimes because the index is
   * describing a version of the paper we do not hold, and occasionally because
   * the index is simply wrong. 138 such rows on the KE07 corpus, 103 of them
   * carrying a DOI.
   *
   * These are the LARGEST unverified surface this module produces, larger than
   * anything among the confirmed DOIs, and a caller that turns them into
   * citation edges alongside printed ones erases the distinction the whole
   * module is built to preserve. They are leads to show a reader, not facts. A
   * consumer writing to the citation graph must gate on `printed !== null`.
   */
  printed: ParsedReference | null
  /** Every index entry that reconciled to this same paper. */
  external: ExternalReference[]
  /**
   * The bibliography position, and where it came from.
   *
   * `from: 'printed'` is a measurement — the parser counted entries down the
   * page. `from: 'index'` is a publisher's key that survived `recoverOrdinals`.
   * They are distinguished because only the first is safe to trust when the two
   * disagree, and a disagreement is recorded rather than resolved.
   */
  ordinal: { value: number; from: 'printed' | 'index' } | null
  /** True when printed and index both claim an ordinal and they differ. */
  ordinalConflict: boolean
  /**
   * The DOI, and ONLY when it is established beyond reasonable doubt.
   *
   * Null is a perfectly good answer here and is preferred to a guess. A wrong
   * DOI on a reference is the worst failure this module can produce: it writes
   * a citation edge to a paper nobody cited, it is indistinguishable from a
   * correct one, and every analysis built on the graph inherits it silently. A
   * missing DOI is visible and recoverable; a wrong one is neither.
   *
   * See `confirmDoi` for what "established" requires.
   */
  doi: string | null
  /** Where the DOI came from — the discriminator a UI needs for provenance. */
  doiFrom: Witness | null
  /**
   * DOIs that MIGHT be this paper but were not confirmed, with the reason each
   * fell short.
   *
   * These are not failures and must not be discarded. A candidate is a real
   * lead — usually the right answer — that no independent witness corroborated,
   * and a human looking at the printed line can settle it in a second. Keeping
   * them is what makes the strict confirmation rule affordable: coverage lost
   * to caution is still visible and recoverable, rather than thrown away.
   *
   * A caller may offer these for confirmation. A caller may NOT quietly promote
   * one into `doi`.
   */
  doiCandidates: Array<{ doi: string; source: ReferenceSource; why: string }>
  title: string | null
  /**
   * How the title was established, when it came from an INDEX rather than the
   * page. Null means the title is the printed one (or there is none).
   *
   * One legal value today. It exists because a future rule may add a second
   * witness kind, and a column is what keeps those distinguishable — the same
   * reason `strategy` has two values rather than being a boolean.
   */
  title_from: TitleAdoption | null
  /** Which index supplied an adopted title. Null exactly when `title_from` is. */
  title_source: ReferenceSource | null
  year: number | null
  venue: string | null
  volume: string | null
  pages: string | null
}

export interface ReconcileReport {
  references: ReconciledReference[]
  /**
   * Set when NO reconciliation was performed, and null otherwise.
   *
   * Present so a caller cannot mistake a refusal for a result: every count in
   * `stats` is zero either way, and only this field distinguishes "this paper
   * cites nothing" from "we had nothing to compare against".
   */
  unreconciled?: { reason: string; indexReferenceCount: number }
  /** Counts, so a caller can assert on the shape of the outcome. */
  stats: {
    total: number
    printedOnly: number
    indexOnly: number
    both: number
    /** Printed entries that gained a CONFIRMED DOI they did not print. */
    doiGained: number
    /**
     * Printed entries left without a DOI that an index did offer.
     *
     * The price of the confirmation rule, stated rather than hidden. A caller
     * that finds this number high is looking at recoverable coverage sitting in
     * `doiCandidates`, not at references nothing could identify.
     */
    doiUnconfirmed: number
    /** Entries with an ordinal, hence linkable to in-text callouts. */
    withOrdinal: number
    ordinalConflicts: number
  }
  /** Which indexes answered, verbatim, so a failure is not read as a zero. */
  sources: Array<{ source: ReferenceSource; ok: boolean; error: string | null; count: number }>
}

/**
 * A paper's BIBLIOGRAPHIC COORDINATE: venue, year, volume, first page.
 *
 * This exists because a large minority of chemistry journals print no title at
 * all. RSC, ACS, Angewandte and older JACS set a reference as
 * `E. Katchalski-Katzir, Trends Biotechnol., 1993, 11, 471-478.` — the parser
 * recovers every field correctly, and not one of them is a title or a DOI. On
 * the KE07 corpus that is three whole papers (61, 53 and 55 entries) where
 * title matching cannot merge a single row, and the first run of this module
 * reported 0 merges out of 61 for exactly that reason.
 *
 * The coordinate is a real identifier, not a heuristic: a journal issue does
 * not print two different papers starting on the same page. What makes it safe
 * is that all four parts must agree, and the two numeric parts must agree
 * EXACTLY — a same-journal same-year collision is common, and a same-journal
 * same-year same-volume same-first-page collision is not a thing.
 *
 * Returns null unless every part is present. A partial coordinate is not a
 * weaker identifier, it is a different and much larger equivalence class:
 * `Trends Biotechnol. 1993` alone names an entire year of a journal.
 */
interface Coordinate {
  venue: string
  year: number
  volume: string
  firstPage: string
}

/** The leading page of a range, which is the only part both sides always have. */
function firstPage(pages: string | null | undefined): string | null {
  if (!pages) return null
  const m = /\d+/.exec(pages)
  return m ? m[0] : null
}

function coordinate(r: {
  venue?: string | null
  year?: number | null
  volume?: string | null
  pages?: string | null
}): Coordinate | null {
  const venue = r.venue?.trim()
  const volume = r.volume?.trim()
  const fp = firstPage(r.pages)
  if (!venue || !r.year || !volume || !fp) return null
  return { venue, year: r.year, volume, firstPage: fp }
}

/**
 * Coordinates agree when the numbers match exactly and the venues are the same
 * journal.
 *
 * Venue goes through `venueSimilarity`, which the parser already uses and which
 * understands abbreviation — the PDF prints `Trends Biotechnol.` and Crossref
 * deposits `Trends in Biotechnology`, and a string comparison would reject
 * every RSC reference in the corpus. The threshold is the parser's own working
 * value for the same comparison.
 */
const VENUE_SAME_JOURNAL = 0.6

/**
 * Years one apart are the SAME publication, when everything else is exact.
 *
 * A paper published online in December and issued in January carries both
 * years, and the two sides disagree about which is "the" year: the printed
 * entry copies the issue, an index often reports the online date. Measured 11
 * such references, each agreeing exactly on volume and first page — a
 * coordinate that specific does not collide across two different papers, so the
 * year is the least reliable of the four and should not be the one that vetoes.
 *
 * One year only. Two would start admitting genuinely different papers in long
 * running volumes.
 */
const COORDINATE_YEAR_SLACK = 1

function sameCoordinate(a: Coordinate, b: Coordinate): boolean {
  if (Math.abs(a.year - b.year) > COORDINATE_YEAR_SLACK) return false
  if (a.volume !== b.volume) return false
  if (a.firstPage !== b.firstPage) return false
  return venueSimilarity(a.venue, b.venue) >= VENUE_SAME_JOURNAL
}

/** A title usable for comparison, or null when it is too thin to compare. */
function comparableTitle(t: string | null | undefined): string | null {
  if (!t) return null
  const n = normalizeLoose(t)
  return contentTokens(n).length >= MIN_TITLE_TOKENS ? n : null
}

/**
 * Titles from an index entry, in the order they are worth trying.
 *
 * `unstructured` is included as a LAST resort and never as the entry's title.
 * Springer's deposits put the whole citation there and no `article-title` at
 * all, so refusing to look at it would leave a third of Crossref's entries
 * unmatchable — but it is a citation string, not a title, so it is only ever
 * used as a haystack for containment, never quoted and never stored.
 */
function externalTitles(x: ExternalReference): { title: string | null; haystack: string | null } {
  return { title: comparableTitle(x.title), haystack: x.unstructured ? normalizeLoose(x.unstructured) : null }
}

/**
 * Do these two entries name the same paper?
 *
 * DOI first and alone: two entries with DOIs that differ are different papers,
 * full stop, and no title similarity may overrule that. This matters more than
 * it looks — a paper and its own erratum, or a preprint and its published
 * version, have near-identical titles and distinct DOIs, and merging them would
 * collapse two rows the corpus needs to keep apart.
 */
interface MatchProbe {
  doi: string | null
  title: string | null
  haystack?: string | null
  coord?: Coordinate | null
  pages?: string | null
}

/**
 * Two comparable titles that are NOT the same paper.
 *
 * The veto, and the reason it exists rather than the coordinate simply winning.
 *
 * A coordinate is four fields that agree, which feels like stronger evidence
 * than a similarity score — and that reasoning attached a wrong DOI to real
 * references. `10.1021/ja00782a004` landed on
 * `Kemp & Casey, Physical organic chemistry of benzisoxazoles, JACS 95 (1973) 20`
 * because OpenAlex holds a paper at JACS 95:20-27, 1973 titled "Primary
 * processes in the photochemistry of 1-pyrazoline". Both are real papers and
 * both really begin on page 20 of that volume, so the coordinate did not lie;
 * the printed entry's own title said plainly this was a different paper, and
 * nothing was reading it.
 *
 * So a coordinate match is REBUTTABLE: it stands unless both sides offer a
 * title and those titles are unlike each other. Titleless chemistry references
 * keep merging — having no title, they have nothing to contradict with, which
 * is the case the coordinate rule was added for — while the cases where
 * contradicting evidence existed are refused.
 *
 * The threshold sits far BELOW `TITLE_MERGE_THRESHOLD` on purpose. This does
 * not ask "are these the same paper"; the coordinate already answered that. It
 * asks whether there is positive evidence they are DIFFERENT, so only a near
 * total absence of shared vocabulary counts. The pair above scores 0.0. A title
 * the parser truncated mid-entry, scored against its full form, scores well
 * above 0.3 and must not be vetoed.
 */
const TITLE_VETO_THRESHOLD = 0.3

/**
 * WHAT IT TAKES TO ATTACH A DOI TO A PRINTED REFERENCE.
 *
 * The governing rule of this module, and deliberately harder to satisfy than
 * the rule for MERGING two rows. Those are different questions with different
 * costs: grouping two entries that turn out to be distinct papers shows the
 * user a slightly wrong list, which they can see and correct. Stamping a DOI
 * onto a bibliography line makes a machine-readable assertion that this paper
 * cited that paper — it becomes a citation edge, it looks exactly like a
 * correct one, and nothing downstream can ever question it.
 *
 * So a DOI is CONFIRMED only when one of these holds:
 *
 *   1. THE PAPER PRINTED IT. Nothing to establish; it is not a match decision.
 *
 *   2. AN INDEX ASSERTS IT AND ITS OWN METADATA AGREES WITH THE PAGE. The
 *      index must state a title that matches the printed title, or a full
 *      bibliographic coordinate that matches the printed one. This is a single
 *      witness, but a witness that has shown its work: it told us what the DOI
 *      IS, and that description matches what the paper printed.
 *
 *   3. TWO INDEPENDENT INDEXES ASSERT THE SAME DOI. Corroboration across
 *      sources that do not share a pipeline. OpenCitations is built partly from
 *      Crossref, so those two agreeing is weaker than either agreeing with
 *      OpenAlex — but a bare DOI is still an assertion about this reference,
 *      and two of them landing on the same value is not coincidence.
 *
 * A LONE BARE DOI — an index that names a DOI and says nothing else about it —
 * is NOT enough, and this is the case the rule exists for. Crossref returns
 * many such entries, they cannot be checked against anything, and the merge
 * that placed them was decided by whatever other rung happened to fire. That is
 * precisely how `10.1002/anie.200700710` reached a paper it had nothing to do
 * with. Those become `doiCandidates`.
 */
function externalDescribesPrinted(printed: ParsedReference, x: ExternalReference): boolean {
  const t = comparableTitle(x.title)
  const pt = comparableTitle(printed.title)
  if (t && pt && titleSimilarity(t, pt) >= TITLE_MERGE_THRESHOLD) return true

  const pc = coordinate(printed)
  const xc = coordinate(x)
  if (pc && xc && sameCoordinate(pc, xc) && !pagesContradict(printed, x)) return true

  return false
}

interface DoiVerdict {
  doi: string | null
  from: Witness | null
  candidates: Array<{ doi: string; source: ReferenceSource; why: string }>
}

/**
 * A printed entry that is not ONE reference.
 *
 * ACS and Angewandte pack several papers into a single numbered entry:
 *
 *   (13) (a) Casey, Kemp, Paul, Cox. J. Org. Chem. 1973, 38, 2294-2301.
 *        (b) Kemp, D. S.; Casey, M. L. J. Am. Chem. Soc. 1973, 95, 6670-6680.
 *
 * The parser emits ONE row for that, and its fields are drawn from whichever
 * sub-entry each pattern happened to reach — so the venue/volume/pages can
 * describe (b) while a reader looking at the row sees (a). An index coordinate
 * then matches (b) perfectly and the DOI is stamped on the row. Measured: four
 * such rows in work 8, each confirmed against the WRONG member of its own
 * entry (`10.1021/ja00801a024`, `10.1021/jp066478s`, `10.1021/ct0500287`,
 * `10.1021/ct700078b`).
 *
 * No amount of evidence-weighing fixes this, because the premise is false: the
 * row is not a single paper, so there is no single correct DOI to find. The
 * title veto cannot fire either — these entries print no title at all.
 *
 * So a compound entry gets NO confirmed DOI. Its candidates are still recorded,
 * and they are real: a human reading the entry can see which sub-citation each
 * belongs to, which is exactly the judgement this code cannot make. Nine such
 * rows exist corpus-wide, so the rule costs four DOIs and closes the class.
 *
 * The signature is a bracketed lower-case letter OTHER than `(a)`: an entry
 * containing `(b)` has a second member by construction, while `(a)` alone could
 * be an artefact of a lettered list that never continued.
 */
const SUB_ENUMERATION = /\(\s*[b-e]\s*\)/i

function isCompoundEntry(printed: ParsedReference): boolean {
  // A LETTERED PART NAMES EXACTLY ONE PAPER, so it is the opposite of a
  // compound and may take a DOI like any ordinary entry — this is the whole
  // reason the parser splits composites in the first place. It has to be said
  // explicitly because the test below reads raw text, and a part's text can
  // still contain a bracketed letter from the sibling that followed it, which
  // would veto a DOI for the one row whose identity is least ambiguous.
  if (printed.part_label !== null) return false
  return SUB_ENUMERATION.test(printed.raw_bib_text)
}

function confirmDoi(printed: ParsedReference, external: ExternalReference[]): DoiVerdict {
  if (printed.doi) {
    return { doi: normalizeDoi(printed.doi), from: 'printed', candidates: [] }
  }

  // A witness that contradicts the page cannot confirm anything — but it is
  // still a LEAD, and dropping it here is how a DOI went missing with nothing
  // recorded at all. Three of the four rows this used to discard held the RIGHT
  // paper, vetoed on a year the bibliography itself printed wrong. They belong
  // in `candidates`, where a human can see the disagreement and settle it.
  const contradicted = external.filter((x) => x.doi && contradictsPrinted(printed, x))
  const withContradicted = (
    extra: DoiVerdict['candidates']
  ): DoiVerdict['candidates'] => [
    ...extra,
    ...contradicted.map((x) => ({
      doi: x.doi as string,
      source: x.source,
      why: 'this index described a different paper than the entry printed'
    }))
  ]

  if (isCompoundEntry(printed)) {
    return {
      doi: null,
      from: null,
      candidates: withContradicted(
        external
          .filter((x) => x.doi && !contradicted.includes(x))
          .map((x) => ({
            doi: x.doi as string,
            source: x.source,
            why: 'the printed entry lists several papers, so no single DOI describes it'
          }))
      )
    }
  }

  // Only witnesses that do not contradict the page get a say at all.
  const usable = external.filter((x) => x.doi && !contradictsPrinted(printed, x))

  const describing = usable.filter((x) => externalDescribesPrinted(printed, x))
  if (describing.length > 0) {
    // Rule 2. Where several qualify they agree in practice; if they ever do
    // not, that is a disagreement about identity and no DOI is confirmed.
    const values = new Set(describing.map((x) => x.doi as string))
    if (values.size === 1) {
      return { doi: describing[0].doi, from: describing[0].source, candidates: [] }
    }
    return {
      doi: null,
      from: null,
      candidates: withContradicted(
        describing.map((x) => ({
          doi: x.doi as string,
          source: x.source,
          why: 'two indexes described this reference and named different DOIs'
        }))
      )
    }
  }

  // Rule 3. Count DISTINCT sources per DOI, not entries: one index returning
  // the same DOI twice corroborates nothing.
  const bySources = new Map<string, Set<ReferenceSource>>()
  for (const x of usable) {
    const set = bySources.get(x.doi as string) ?? new Set<ReferenceSource>()
    set.add(x.source)
    bySources.set(x.doi as string, set)
  }
  for (const [doiValue, sources] of bySources) {
    // Two sources, AND one of them OpenAlex.
    //
    // "Independent" was doing unexamined work here. OpenCitations COCI is built
    // largely FROM Crossref's open references, so a crossref+opencitations pair
    // can be one source wearing two hats — corroboration that only looks like
    // corroboration. OpenAlex has its own ingest, so requiring it makes the
    // second witness genuinely second.
    //
    // Measured before adopting: all 11 rule-3 rows on this corpus already carry
    // all three sources, and there is not one crossref+opencitations-only pair.
    // So this costs nothing today and closes the hole before a corpus arrives
    // where it would not.
    if (sources.size >= 2 && sources.has('openalex')) {
      return { doi: doiValue, from: [...sources][0], candidates: [] }
    }
  }

  return {
    doi: null,
    from: null,
    candidates: withContradicted(
      [...bySources.entries()].map(([doiValue, sources]) => ({
        doi: doiValue,
        source: [...sources][0],
        why: 'one index named this DOI without describing the paper, and nothing corroborated it'
      }))
    )
  }
}

function titlesContradict(a: MatchProbe, b: MatchProbe): boolean {
  if (!a.title || !b.title) return false
  return titleSimilarity(a.title, b.title) < TITLE_VETO_THRESHOLD
}

/**
 * A page range both sides state, and disagree about.
 *
 * `sameCoordinate` compares only the FIRST page, because that is the part every
 * style prints and Crossref deposits alone. When both sides happen to carry a
 * last page too, that is extra evidence and it was being discarded — the
 * `10.1002/anie.200700710` misattachment had `venueSimilarity` 1.0 and a
 * matching first page while the printed range and the index range differed.
 *
 * Only a stated disagreement rebuts. One side lacking a last page proves
 * nothing and must not.
 */
function lastPage(pages: string | null | undefined): string | null {
  if (!pages) return null
  const m = /\d+\D+(\d+)\s*$/.exec(pages)
  return m ? m[1] : null
}

function firstPageOf(pages: string | null | undefined): string | null {
  if (!pages) return null
  const m = /\d+/.exec(pages)
  return m ? m[0] : null
}

/**
 * ELIDED PAGE RANGES: `190-5` and `190-195` are the same range.
 *
 * Nature, PNAS, JACS and most ACS titles print only the digits of the last page
 * that CHANGE — `16869-74`, `14111-5`, `1025-42`. Crossref deposits the full
 * form. Comparing the tails naively reads `74` against `16874` and calls every
 * such reference a contradiction, which is backwards: these agree, and the veto
 * was rejecting them precisely because they agree in an abbreviated notation.
 *
 * Measured: 12 references, all in work 5 (an ACS Catalysis paper), each with a
 * correct DOI, venue similarity 1.00 and an exact volume and first-page match,
 * refused on this alone.
 *
 * Expansion is anchored on the FIRST page, which both sides always state in
 * full: the short form replaces that many trailing digits. `16869` + `74` =>
 * `16874`. Only if the expansion still disagrees is this a real contradiction.
 */
function expandElided(first: string, short: string): string | null {
  if (short.length >= first.length) return null
  return first.slice(0, first.length - short.length) + short
}

function pagesContradict(
  a: { pages?: string | null },
  b: { pages?: string | null }
): boolean {
  const la = lastPage(a.pages)
  const lb = lastPage(b.pages)
  if (!la || !lb) return false
  if (la === lb) return false

  // Expand whichever side is written short, against its own first page.
  const fa = firstPageOf(a.pages)
  const fb = firstPageOf(b.pages)
  if (fa && la.length < lb.length && expandElided(fa, la) === lb) return false
  if (fb && lb.length < la.length && expandElided(fb, lb) === la) return false

  return true
}

function sameReference(a: MatchProbe, b: MatchProbe): boolean {
  if (a.doi && b.doi) return a.doi === b.doi
  // The coordinate outranks the title, but does not overrule evidence that
  // actively contradicts it. See `titlesContradict` and `pagesContradict`.
  if (a.coord && b.coord && sameCoordinate(a.coord, b.coord)) {
    return !titlesContradict(a, b) && !pagesContradict(a, b)
  }
  const ta = a.title
  const tb = b.title
  if (ta && tb) {
    if (titleSimilarity(ta, tb) >= TITLE_MERGE_THRESHOLD) return true
    // BOOKS, SOFTWARE AND THESES, which no coordinate can describe.
    //
    // These have no volume and no page range, so `sameCoordinate` is
    // inapplicable and the title carries the whole decision — at a threshold
    // tuned for journal articles. It fails them for a reason that is not about
    // identity: the printed entry appends the publisher and place, which the
    // index's title never has. `"Structure and Mechanism in Protein Science"`
    // vs `"Structure and Mechanism in Protein Science. W.H. Freeman and
    // Company, New York"` scores 0.76 — a Dice penalty for extra words the
    // parser failed to strip, not evidence of a different book. 23 references
    // sit in 0.6-0.82 purely on this.
    //
    // Containment asks the right question instead: is the index's title present
    // in full inside the printed one? It is directional and requires NEAR-TOTAL
    // coverage, so a short title cannot be swallowed by a long unrelated one the
    // way a symmetric score would allow.
    if (!a.coord && !b.coord) {
      const short = ta.length <= tb.length ? ta : tb
      const long = ta.length <= tb.length ? tb : ta
      if (contentTokens(short).length >= MIN_TITLE_TOKENS && containment(short, long) >= 0.95) {
        return true
      }
    }
    return false
  }
  // One side has no isolated title. Compare whichever title exists against the
  // other side's full citation string, which is what `containment` is for in
  // the parser — but require the SAME threshold rather than a looser one,
  // because a citation string contains venue and author words that inflate any
  // overlap measure.
  const t = ta ?? tb
  const h = ta ? b.haystack : a.haystack
  if (t && h) return titleSimilarity(t, h) >= TITLE_MERGE_THRESHOLD
  return false
}



/** Years this far apart are a different paper; one apart is online-vs-issue. */
const YEAR_SLACK = 1

/**
 * Does this index entry contradict what the paper PRINTED?
 *
 * Applied by `confirmDoi` before a witness is allowed to count towards a DOI at
 * all, and by `consolidateByDoi` before folding one row into another. A test
 * that lives on only one of those routes is a test the other route walks
 * around: `10.1002/anie.200700710` was once vetoed on the title route and then
 * folded straight back in on the DOI route.
 *
 * Two independent grounds, both requiring the index to have STATED something:
 *   - a title with almost no vocabulary in common with the printed entry
 *   - a year several years off one the printed entry states
 * A bare DOI entry asserts neither and is never rejected here.
 */
function contradictsPrinted(printed: ParsedReference, x: ExternalReference): boolean {
  const t = comparableTitle(x.title)
  if (!t) return false

  // ONLY an isolated printed title may contradict. A titleless entry —
  // `[5] A. Warshel, J. Biol. Chem. 1998, 273, 27035-27038.` — states no title
  // at all, so scoring a real index title against its raw text yields ~0 and
  // means nothing except that the paper prints no titles. Treating that as
  // contradiction rejected 213 correct merges in work 18 alone, i.e. it turned
  // the veto into a wrecking ball aimed precisely at the titleless chemistry
  // references the coordinate rule exists to serve. Silence is not disagreement.
  const printedTitle = comparableTitle(printed.title)
  if (printedTitle && titleSimilarity(t, printedTitle) < TITLE_VETO_THRESHOLD) return true

  if (printed.year && x.year && Math.abs(printed.year - x.year) > YEAR_SLACK) return true
  return false
}

/**
 * A SECOND pass that merges rows which became mergeable only after the first.
 *
 * The first pass is order-dependent in a way that cannot be fixed by reordering
 * the sources, and this is the fix rather than a tidy-up.
 *
 * What happens: Crossref returns many entries carrying a DOI and NOTHING else —
 * no title, no venue, no year — because the publisher deposited only the DOI.
 * Such an entry cannot match a printed entry that itself has no DOI (the
 * printed side has a title, the Crossref side has none, and there is no shared
 * field). So it seeds a new row. OpenAlex then arrives with the SAME paper,
 * fully hydrated, and matches the printed entry on title — giving that printed
 * row a DOI for the first time. At that moment the bare Crossref row and the
 * printed row are provably the same paper, but the first pass has already
 * walked past both.
 *
 * Measured on the KE07 corpus: 335 of 544 apparent "index-only" references were
 * this artefact, i.e. 62% of the module's headline finding was a bug in its own
 * bookkeeping. Papers 18 (188), 9 (29) and 17 (27) were almost entirely this.
 *
 * Only DOI equality merges here, deliberately. By this point every row that
 * could carry a DOI does, so a title or coordinate rule would add nothing but
 * the chance of a false merge on the rows that legitimately have no identifier.
 */
function consolidateByDoi(rows: ReconciledReference[]): ReconciledReference[] {
  const byDoi = new Map<string, ReconciledReference>()
  const out: ReconciledReference[] = []

  for (const r of rows) {
    // An UNCONFIRMED row has no DOI to consolidate on, by construction. Rows
    // carrying only candidates stay separate rather than being merged on a
    // value this module has already declined to assert.
    if (!r.doi) {
      out.push(r)
      continue
    }
    const prior = byDoi.get(r.doi)
    if (!prior) {
      byDoi.set(r.doi, r)
      out.push(r)
      continue
    }
    // Fold into the row that already exists. The PRINTED row wins the identity
    // whichever order they arrived in, because it is the one holding offsets.
    const keep = prior.printed ? prior : r.printed ? r : prior
    const drop = keep === prior ? r : prior
    if (keep !== prior) {
      byDoi.set(r.doi, keep)
      out[out.indexOf(prior)] = keep
    } else {
      const i = out.indexOf(r)
      if (i >= 0) out.splice(i, 1)
    }

    // Fold only what does not contradict the printed entry. DOI equality is a
    // strong signal but it is the INDEX's assertion, and an index that has
    // already been shown to disagree with the page does not get to import its
    // disagreement under a matching DOI.
    const folding = keep.printed
      ? drop.external.filter((x) => !contradictsPrinted(keep.printed!, x))
      : drop.external
    const refused = drop.external.filter((x) => !folding.includes(x))

    keep.external.push(...folding)
    for (const wit of new Set(folding.map((x) => x.source))) {
      if (!keep.witnesses.includes(wit)) keep.witnesses.push(wit)
    }
    for (const x of refused) {
      out.push({
        witnesses: [x.source],
        printed: null,
        external: [x],
        ordinal: x.ordinal === null ? null : { value: x.ordinal, from: 'index' },
        ordinalConflict: false,
        doi: x.doi,
        doiFrom: x.doi ? x.source : null,
        title: x.title,
        title_from: null,
        title_source: null,
        year: x.year,
        venue: x.venue,
        volume: x.volume,
        pages: x.pages
      })
    }
    keep.title ??= drop.title
    keep.year ??= drop.year
    keep.venue ??= drop.venue
    keep.volume ??= drop.volume
    keep.pages ??= drop.pages
    if (!keep.ordinal && drop.ordinal) keep.ordinal = drop.ordinal
    else if (keep.ordinal && drop.ordinal && keep.ordinal.value !== drop.ordinal.value) {
      // Only a printed-vs-index disagreement is a conflict worth reporting; two
      // indexes differing about a publisher key says nothing about the page.
      if (keep.ordinal.from !== drop.ordinal.from) keep.ordinalConflict = true
    }
    keep.ordinalConflict ||= drop.ordinalConflict
  }
  return out
}


/**
 * Reconcile one paper's printed bibliography against every index reply.
 *
 * Order of operations is deliberate: printed entries are seeded FIRST and index
 * entries are folded into them, so a printed entry always keeps its own
 * identity and offsets even when three indexes also describe it. Doing it the
 * other way — seeding from the richest index — would silently drop printed
 * entries that no index holds, which on this corpus is between 2 and 9 entries
 * per paper and includes every book, thesis and patent.
 */
export function reconcile(
  printed: ParsedReference[],
  results: ExternalReferenceResult[]
): ReconcileReport {
  // NO PRINTED BIBLIOGRAPHY AT ALL, while indexes answer with dozens of
  // references, is not a reconciliation and must not be reported as one.
  //
  // Work 7 of the KE07 corpus is the case: the document the app holds for it is
  // the SUPPLEMENTARY INFORMATION pdf, which ends in primer tables and has no
  // bibliography. The first version of this function happily returned "83
  // references, 83 of them index-only, 0 printed" — every number true, and the
  // whole a claim about a paper whose reference list this app has never seen.
  // A reader would take it as "the parser missed everything", which is a defect
  // report against the parser for doing exactly the right thing with an SI pdf.
  //
  // The distinction that makes this safe: there is a real difference between a
  // paper with no bibliography (an editorial, a comment) and a paper we hold
  // the wrong file for, and NEITHER is a reconciliation. Both are refusals, and
  // the caller can tell them apart by whether the indexes returned anything.
  if (printed.length === 0) {
    return {
      references: [],
      unreconciled: {
        reason: 'no printed bibliography to reconcile against',
        indexReferenceCount: results.reduce((n, r) => n + r.references.length, 0)
      },
      stats: {
        total: 0,
        printedOnly: 0,
        indexOnly: 0,
        both: 0,
        doiGained: 0,
        doiUnconfirmed: 0,
        withOrdinal: 0,
        ordinalConflicts: 0
      },
      sources: results.map((r) => ({
        source: r.source,
        ok: r.ok,
        error: r.error,
        count: r.references.length
      }))
    }
  }

  const out: ReconciledReference[] = []

  for (const p of printed) {
    out.push({
      witnesses: ['printed'],
      printed: p,
      external: [],
      ordinal: { value: p.ordinal, from: 'printed' },
      ordinalConflict: false,
      doi: null,
      doiFrom: null,
      doiCandidates: [],
      title: p.title,
      title_from: null,
      title_source: null,
      year: p.year,
      venue: p.venue,
      volume: p.volume,
      pages: p.pages
    })
  }

  for (const res of results) {
    if (!res.ok) continue
    for (const x of res.references) {
      const { title, haystack } = externalTitles(x)
      const probe: MatchProbe = {
        doi: x.doi,
        title,
        haystack,
        coord: coordinate(x),
        pages: x.pages
      }

      const hit = out.find((r) => {
        const rTitle = comparableTitle(r.title)
        const rHaystack = r.printed ? normalizeLoose(r.printed.raw_bib_text) : null
        // A printed row's DOI is `null` until confirmed, so it matches on what
        // the PAGE says. That is the point: the DOI rung must not be reachable
        // through a value this module itself supplied a moment earlier.
        return sameReference(
          {
            doi: r.printed ? (r.printed.doi ? normalizeDoi(r.printed.doi) : null) : r.doi,
            title: rTitle,
            haystack: rHaystack,
            coord: coordinate(r),
            pages: r.pages
          },
          probe
        )
      })

      if (!hit) {
        out.push({
          witnesses: [x.source],
          printed: null,
          external: [x],
          // An index-only reference gets an ordinal ONLY when the publisher's
          // key survived recovery. It cannot be assigned one from position:
          // there is no printed entry to count against.
          ordinal: x.ordinal === null ? null : { value: x.ordinal, from: 'index' },
          ordinalConflict: false,
          doi: x.doi,
          doiFrom: x.doi ? x.source : null,
          doiCandidates: [],
          title: x.title,
          title_from: null,
          title_source: null,
          year: x.year,
          venue: x.venue,
          volume: x.volume,
          pages: x.pages
        })
        continue
      }

      hit.external.push(x)
      if (!hit.witnesses.includes(x.source)) hit.witnesses.push(x.source)

      // The DOI is deliberately NOT decided here. This loop only gathers
      // witnesses; `confirmDoi` weighs all of them together once the row is
      // complete. Assigning on first-match was what let a lone bare DOI win
      // simply by arriving before the entry that would have contradicted it.
      // Metadata is filled only where the printed entry has a HOLE. An index
      // value never overwrites a printed one, even when the printed one looks
      // worse: the printed value is what the reader will see on the page, and a
      // corrected title that does not match the paper is a different kind of
      // wrong from a scruffy one that does.
      //
      // The TITLE is the exception, and only in one direction: where the printed
      // side has no title at all — ACS, RSC and Angewandte print none — an index
      // title may be ADOPTED, but only when the printed authors independently
      // vouch for it. `adoptTitle.ts` holds that decision and the reasoning.
      if (hit.printed && adoptIndexTitle(
        { title: hit.printed.title, surnames: hit.printed.surnames, venue: hit.printed.venue },
        { title: x.title, authors: x.authors ?? null }
      ) === 'corroborated') {
        hit.title = x.title
        hit.title_from = 'corroborated'
        hit.title_source = x.source
      }
      hit.title ??= x.title
      hit.year ??= x.year
      hit.venue ??= x.venue
      hit.volume ??= x.volume
      hit.pages ??= x.pages

      if (hit.ordinal && x.ordinal !== null && hit.ordinal.from === 'printed') {
        if (hit.ordinal.value !== x.ordinal) hit.ordinalConflict = true
      } else if (!hit.ordinal && x.ordinal !== null) {
        hit.ordinal = { value: x.ordinal, from: 'index' }
      }
    }
  }

  // Decide every printed row's DOI ONCE, from all of its witnesses together.
  //
  // Deciding LATE is the safety property. Assigning a DOI during the matching
  // loop meant the first witness to arrive won, so a lone bare DOI could take a
  // reference simply by being early, and every later attempt to correct it was
  // a patch on a decision already made. One decision point is also one place to
  // audit, which matters more here than anywhere else in the module.
  for (const r of out) {
    if (!r.printed) continue
    const verdict = confirmDoi(r.printed, r.external)
    r.doi = verdict.doi
    r.doiFrom = verdict.from
    r.doiCandidates = verdict.candidates
  }

  const merged = consolidateByDoi(out)

  // The CONTAINER of a lettered entry is excluded from `printedOnly`. No index
  // holds a record for "reference 11" as a unit — it is five papers under one
  // number — so it can never match one, and counting it reported a witness
  // disagreement that is really just how the page was typeset. Its parts are
  // counted, and they are the rows an index can actually confirm.
  const container = (r: ReconciledReference): boolean =>
    r.printed !== null &&
    r.printed.part_label === null &&
    merged.some((s) => s.printed?.part_label != null && s.printed.ordinal === r.printed?.ordinal)
  const printedOnly = merged.filter(
    (r) => r.printed !== null && r.external.length === 0 && !container(r)
  ).length
  const indexOnly = merged.filter((r) => r.printed === null).length

  return {
    references: merged,
    unreconciled: undefined,
    stats: {
      total: merged.length,
      printedOnly,
      indexOnly,
      both: merged.length - printedOnly - indexOnly,
      doiGained: merged.filter((r) => r.printed && r.doi && r.doiFrom !== 'printed').length,
      doiUnconfirmed: merged.filter((r) => r.printed && !r.doi && r.doiCandidates.length > 0)
        .length,
      withOrdinal: merged.filter((r) => r.ordinal !== null).length,
      ordinalConflicts: merged.filter((r) => r.ordinalConflict).length
    },
    sources: results.map((r) => ({
      source: r.source,
      ok: r.ok,
      error: r.error,
      count: r.references.length
    }))
  }
}
