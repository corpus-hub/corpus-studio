// May an index's title stand in for the one the page printed?
//
// Many chemistry and physics styles print NO title — ACS, RSC, Angewandte and
// older JACS set a reference as authors, journal, year, volume, pages and
// nothing else. The indexes hold a real title for most of those papers, and this
// decides whether it may be adopted as the reference's name.

/** What the decision is allowed to look at on the printed side. */
export interface PrintedWitness {
  /** The title as parsed off the page, or null when the style printed none. */
  title: string | null
  /** Surnames harvested from the printed author list, folded and lowercased. */
  surnames: string[]
  /** The venue as parsed, used to recognise a mangled author slot. */
  venue: string | null
}

/** What the decision is allowed to look at on the index side. */
export interface IndexWitness {
  title: string | null
  /** Whatever the index gives for authorship, verbatim and free-form. */
  authors: string | null
}

/**
 * Two outcomes, and only the first stores anything.
 *
 * An earlier design had a third, `coordinate-only`, which adopted a title that
 * nothing independent vouched for and marked it as weaker. Exhaustive
 * verification of all 146 rows it accepted found 145 correct, 0 wrong and 1
 * UNVERIFIABLE — and the unverifiable one was exactly such a row. Keeping the
 * bucket bought one reference a name and cost the corpus the guarantee that
 * every stored title has a witness. It was dropped.
 */
export type TitleAdoption = 'corroborated' | 'refused'

/**
 * Bumped whenever the rule below changes, and stamped onto every row it writes.
 *
 * This is what makes a bad vintage targetable: `UPDATE … WHERE
 * index_title_rule_version <= N` undoes one rule's output without touching a
 * later one's. Same reason `analysis_run` carries `prompt_version`.
 */
export const TITLE_RULE_VERSION = 1

/**
 * A title that announces a NOTICE about a paper, not a paper.
 *
 * Anchored at the start and closed by a separator, because the words themselves
 * are ordinary English: "Correction of a genetic defect in vivo" and
 * "Addendum-free synthesis of rare hexoses" are real papers and must survive. A
 * hyphen is deliberately not a separator for that second reason.
 *
 * This is the one demonstrated break in the author witness. An erratum shares
 * its authors, venue, volume AND first page with the paper it corrects — by
 * definition — so every other test here passes it and the stored title becomes
 * "Corrigendum: …" for the paper itself.
 */
const NOTICE_TITLE_RE =
  /^\s*(?:(?:publisher'?s?\s+)?(?:erratum|errata|corrigendum|corrigenda|correction)|retraction|retracted(?:\s+article)?|addendum|addenda|publisher'?s?\s+note|editorial\s+expression\s+of\s+concern|withdrawn)\s*(?:$|[:.\u2014]|\s+(?:to|for|of\s+the\s+article)\b)/i

/**
 * Is this printed "title" really the entry's own citation coordinate?
 *
 * Such a row has no title at all, whatever the field holds, so the index may
 * name it. Two orders, because the year prints on either side of the
 * volume/page pair.
 */
function isCoordinate(title: string): boolean {
  return (
    /\b\d{1,4}\s*\(\s*(?:19|20)\d{2}\s*\)\s*,?\s*(?:pp?\.?\s*)?\d/.test(title) ||
    /\b\d{1,4}\s*,\s*\d{2,6}\s*\(\s*(?:19|20)\d{2}\s*\)/.test(title)
  )
}

function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Surnames that could actually witness anything.
 *
 * When the text layer drops an author list the parser does not return an empty
 * array — it returns the VENUE in the author slot. "20. . Nature 358, 209-215
 * (1992)" parses to `surnames: ["nature"]`, and treated as a real surname that
 * matches nothing, which silently turns "no evidence" into "the evidence
 * disagrees". Those are different answers.
 */
function usableSurnames(p: PrintedWitness): string[] {
  const venue = p.venue ? fold(p.venue) : ''
  return p.surnames
    .map((s) => fold(s))
    .filter((s) => s.length > 2 && (venue === '' || (s !== venue && !venue.split(' ').includes(s))))
}

/**
 * Does this surname appear in the index's author string as a WHOLE WORD?
 *
 * A substring test lets "Kim" match "Kimura". Not observed in the corpus this
 * was measured on, but the hazard is free to close.
 */
function namesAuthor(surname: string, authors: string): boolean {
  return ` ${authors} `.includes(` ${surname} `)
}

/**
 * THE AUTHORS, AND NOT THE COORDINATE.
 *
 * `reconcile` pairs a printed row to an index row BY the coordinate, so checking
 * the coordinate afterwards re-asks the question that formed the pair — on one
 * real corpus 137 of 150 "confirmations" were exactly that, and the one row
 * where the coordinate agreed on the WRONG paper was a row holding two spliced
 * references. The authors are the only witness here that the pairing did not
 * already assume.
 *
 * Two surnames, or one of five characters or more. 25 of 151 adoptions under a
 * looser rule rested on a single short surname, and a common one (`Kim`, `Wang`,
 * `Lee`, `Cho`) appears by chance in a large author list. The stricter rule
 * costs a few true titles and buys the guarantee.
 */
export function adoptIndexTitle(p: PrintedWitness, x: IndexWitness): TitleAdoption {
  const indexTitle = x.title?.trim()
  if (!indexTitle) return 'refused'
  if (NOTICE_TITLE_RE.test(indexTitle)) return 'refused'

  // A printed "title" is not one when it is the entry's own coordinate, or when
  // it is an author list the parser could not split off — two or more semicolons
  // is how ACS separates authors and how prose almost never reads. The parser
  // already uses that exact test in `looksLikeTitle`; it simply is not applied
  // where the title is finally accepted.
  const printedTitle = p.title?.trim()
  const printedIsReal =
    !!printedTitle && !isCoordinate(printedTitle) && (printedTitle.match(/;/g) ?? []).length < 2
  if (printedIsReal) return 'refused'

  const surnames = usableSurnames(p)
  if (surnames.length === 0) return 'refused'

  const authors = x.authors ? fold(x.authors) : ''
  if (!authors) return 'refused'

  const hits = surnames.filter((s) => namesAuthor(s, authors))
  if (hits.length >= 2) return 'corroborated'
  if (hits.length === 1 && hits[0].length >= 5) return 'corroborated'
  return 'refused'
}
