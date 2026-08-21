/**
 * What to CALL a cited paper this corpus does not hold.
 *
 * A reference is named by whatever it actually carries, in descending order of
 * how much it tells a reader. The order matters more than it looks: 200 of the
 * 206 title-less references in one real corpus carried a full author list while
 * the card said "untitled reference" — a placeholder standing in front of
 * evidence the app already had.
 *
 * There is no "unknown" branch. A bibliography entry that named nothing at all
 * could not have been parsed out of the page in the first place, so the printed
 * line is always available and is always more use than a placeholder.
 */
export interface LabelledReference {
  /**
   * A title an outside index supplied, when one was accepted for this row.
   *
   * OPTIONAL, and declared here from the start rather than added later: every
   * object literal built for this function would otherwise stop compiling the
   * day the index stage lands.
   *
   * It outranks `title` and there is no conflict in that, because a row only
   * ever carries one: an index title is stored ONLY where the printed side had
   * no usable title of its own.
   */
  index_title?: string | null
  title: string | null
  authors: string | null
  year: number | null
  venue: string | null
  raw_bib_text: string
}

export interface LabelOptions {
  /**
   * Append `(year)` to an authors- or venue-derived label. Default true.
   *
   * A caller that already prints the year in its own slot passes false — the
   * references canvas draws it on the line above, and without this the year
   * appears twice inside a 96px column.
   */
  withYear?: boolean
}

/**
 * Is this string a citation coordinate rather than a title?
 *
 * Narrow, but NOT infallible: any title containing "… 12 (2019) 3…" is rejected
 * by it. Measured over 757 stored titles it fires on 25, all of them genuine
 * debris and none a clean title — so the risk is latent rather than present, and
 * it is accepted because the alternative is printing a page range where a
 * paper's name belongs.
 *
 * It exists for rows STORED before the parser stopped producing them; new rows
 * do not need it, and it should be deleted once no corpus carries such a row.
 */
function isCoordinate(title: string): boolean {
  // Two orders, because a coordinate prints its year on either side of the
  // volume/page pair. Missing the second let a card read
  // "J . Amer. Chem. S o c . , 90, 2598 (1968); W. T. Fo…" as a paper's name.
  return (
    // "40 (2011), pp. 5068-5083" — volume, year, then pages.
    /\b\d{1,4}\s*\(\s*(?:19|20)\d{2}\s*\)\s*,?\s*(?:pp?\.?\s*)?\d/.test(title) ||
    // "90, 2598 (1968)" — volume, first page, then the year.
    /\b\d{1,4}\s*,\s*\d{2,6}\s*\(\s*(?:19|20)\d{2}\s*\)/.test(title) ||
    // A coordinate the entry BEGINS with, having lost its volume to a mis-split:
    // "(2013), pp. 116-128" and "pp. 5068-5083. [3] K. Faber, …". Both forms
    // demand a page range right there, so prose that merely opens with a year
    // ("(2017) was a landmark year…") is untouched.
    /^\s*\(\s*(?:19|20)\d{2}\s*\)\s*,?\s*(?:pp?\.?\s*)?\d/.test(title) ||
    /^\s*pp?\.?\s*\d+\s*[-\u2013]\s*\d+/.test(title)
  )
}

/**
 * Is this author list really a citation coordinate?
 *
 * The same defect as `isCoordinate`, in the field next door: when the text layer
 * mangles an entry the parser puts the rest of the citation in the author slot,
 * so a card fell back from a coordinate-shaped title to "J. Amer. Chem. Soc.,
 * 90, 2598 (1968); W. T. Fo…" — which is not a name and reads as one.
 *
 * Also catches the volume/page pair a coordinate carries WITHOUT a parenthesised
 * year ("Nature 358, 209-215"), which `isCoordinate` alone does not: a name list
 * has no reason to contain a bare "358, 209" either.
 *
 * 5 stored rows in one corpus display this. They fall through to the venue or
 * the printed line, both of which are honest.
 */
function authorsAreCoordinate(authors: string): boolean {
  return isCoordinate(authors) || /\b\d{1,4}\s*,\s*\d{2,6}\b/.test(authors)
}

function withYearSuffix(s: string, year: number | null, opts: LabelOptions | undefined): string {
  if (year === null || opts?.withYear === false) return s
  return `${s} (${year})`
}

export function referenceLabel(ref: LabelledReference, opts?: LabelOptions): string {
  const indexTitle = ref.index_title?.trim()
  if (indexTitle) return indexTitle

  const title = ref.title?.trim()
  if (title && !isCoordinate(title)) return title

  const authors = ref.authors?.trim()
  if (authors && !authorsAreCoordinate(authors)) return withYearSuffix(authors, ref.year, opts)

  const venue = ref.venue?.trim()
  if (venue) return withYearSuffix(venue, ref.year, opts)

  return ref.raw_bib_text.trim()
}
