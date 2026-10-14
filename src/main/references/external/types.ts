// A reference as an OUTSIDE INDEX reports it, before it is reconciled with what
// the paper printed.
//
// Deliberately NOT `ParsedReference`. The two are different claims and the
// difference is the whole reason this module is separate:
//
//   `ParsedReference` says "this paper PRINTED these characters, at this offset
//   in this document". It carries `raw_bib_text` and `char_start`/`char_end`,
//   and those are what let a citation be pointed at on a page.
//
//   `ExternalReference` says "this index BELIEVES this paper cites that paper".
//   It has no offsets and cannot acquire any, because the index never saw our
//   PDF. Nothing here may be widened into a claim about the document.
//
// Collapsing them would let an index-only reference inherit the affordances of a
// printed one — a "jump to this citation" that lands nowhere, or an evidence
// span anchored to an offset no one measured.

/** Which index answered. Not a ranking; it is provenance. */
export type ReferenceSource = 'crossref' | 'openalex' | 'opencitations'

export interface ExternalReference {
  source: ReferenceSource
  /**
   * The position in the bibliography, when the index states one.
   *
   * NULL far more often than it is set, and null is the honest answer. Crossref
   * encodes it in the opaque `key` field, which publishers format however they
   * like: Springer writes `BFnature06879_CR7` (recoverable), Wiley writes a
   * bare running number, ACS writes a hash, and Elsevier's numbering starts at
   * 5 and runs past 200 because the key counts every XML element rather than
   * every reference. So a number is extracted ONLY from a set of keys that is
   * self-consistently 1..n, and otherwise this stays null — a plausible-looking
   * ordinal that is off by four silently attaches every in-text callout in the
   * paper to the wrong reference.
   */
  ordinal: number | null
  /** Normalized, lowercased, no `https://doi.org/` prefix. */
  doi: string | null
  title: string | null
  /**
   * Whatever the index gives for authorship, verbatim.
   *
   * Untyped as a single string because the three indexes disagree completely —
   * Crossref gives ONE surname (`"A Radzicka"`), OpenAlex gives full records,
   * OpenCitations gives nothing. Normalizing them into a common shape here
   * would mean inventing the parts that are missing.
   */
  authors: string | null
  year: number | null
  venue: string | null
  volume: string | null
  pages: string | null
  /**
   * The index's own rendering of the reference as prose, when it has one.
   *
   * NOT `raw_bib_text` and must never be stored as it. Crossref's
   * `unstructured` is often the publisher's deposited citation string, which
   * frequently DOES match what the PDF printed — but "frequently" is not a
   * contract, and a consumer that treats it as printed text will eventually
   * quote to the user a sentence their paper does not contain.
   */
  unstructured: string | null
}

/**
 * What one index said about one paper, INCLUDING when it said nothing.
 *
 * The three outcomes are distinct and none of them is an error:
 *   - `references: []` with `ok: true` — the index holds this paper and it
 *     deposited no reference list. Common: 10.1021/jo00953a006 (1973) is
 *     genuinely in Crossref with zero references, because reference deposits
 *     did not exist yet.
 *   - `ok: false` — the index does not hold this paper, or did not answer.
 *   - never called at all — the caller had no DOI to ask with.
 *
 * Flattening the first two into "no references" is the failure this shape
 * exists to prevent: a paper whose publisher deposits nothing and a paper the
 * network could not reach are not the same fact, and only the second is worth
 * retrying.
 */
export interface ExternalReferenceResult {
  source: ReferenceSource
  ok: boolean
  /** Why it failed, in a sentence a user could read. Null when `ok`. */
  error: string | null
  /**
   * What the index says the count is, which may exceed `references.length`.
   *
   * Crossref reports `reference-count` from the deposit metadata and returns
   * the list separately; they disagree when a publisher deposits a count but
   * closes the list. That gap is exactly the "we know we are missing some"
   * signal, and it is unrecoverable once the two are merged.
   */
  declaredCount: number | null
  references: ExternalReference[]
}
