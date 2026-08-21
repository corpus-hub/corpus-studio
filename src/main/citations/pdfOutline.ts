// Reading a bibliography from the PDF's OWN STRUCTURE instead of inferring it
// from prose.
//
// A LaTeX document compiled with hyperref records, in the file, exactly what the
// prose parser spends 1700 lines guessing at:
//
//   - one NAMED DESTINATION per bibliography entry, `cite.<key>`, pointing at
//     the page and position where that entry begins;
//   - one LINK ANNOTATION per in-text \cite, with a rectangle on the page and
//     the same `cite.<key>` as its target.
//
// None of it is visible. It survives in the file whatever the typography does —
// unnumbered author-year lists, two-column setting, letterspaced headings,
// hyphenated wrapping — all of which are exactly the cases where reading the
// text defeats us. The destination for `hyvarinen2010estimation` is the same
// object whether the entry prints as `[6]`, as `Hyvärinen et al. (2010)`, or
// with no label at all.
//
// It also carries something the text never can: a STABLE KEY per entry, and a
// link from each in-text citation to the entry it names. The prose path answers
// "which paragraph cites reference 7" by finding the digit 7 in a sentence,
// which matches affiliation lines ("1 Department of Biochemistry, 2 ...") and
// unit noise ("15,800 M 2 1 cm 2 1") often enough to be wrong about one link in
// ten. An annotation rectangle is not a guess.
//
// WHAT THIS IS NOT. Only LaTeX/pdfTeX output carries any of it. Publisher
// pipelines — Adobe Distiller, PDFlib, iText, Ghostscript, pypdf — emit none,
// and neither does a scan. On the embeddings corpus 17 of 26 papers have
// destinations; on the chemistry corpus almost none do. So this REPLACES the
// prose parser where it applies and is absent everywhere else, which is why it
// returns null rather than an empty result when a document has no structure:
// "this PDF does not record its bibliography" and "this PDF records that it has
// no references" must not look the same to the caller.

import type { PDFDocumentProxy } from 'pdfjs-dist'

/** One bibliography entry, as the FILE describes it. */
export interface OutlineEntry {
  /**
   * The BibTeX-ish citation key, minus the `cite.` prefix: `agirre2015semeval`,
   * `yang2019xlnet`, `Spirtes+Glymour:1991`.
   *
   * Not decorative. It is a per-entry identity that survives reformatting, so
   * two runs over different builds of the same paper agree, and an in-text
   * citation can name its entry exactly. Authors write it, so it frequently
   * encodes a surname and a year — useful as a CHECK on what was read at the
   * destination, never as a substitute for reading it.
   */
  key: string
  /** 1-based page the entry starts on. */
  page: number
  /**
   * Position of the entry's first character, in PDF user space.
   *
   * BOTH coordinates where the destination gives both, and x is not optional
   * when it exists. A two-column bibliography puts two different entries at the
   * same y, so matching on y alone picks whichever the text-item order happens
   * to reach first — which resolved destinations onto unrelated body text in
   * the middle of the paper and looked, convincingly, like the destinations
   * were unusable. With x it lands on the right column.
   *
   * NULL for `/FitH` destinations, which name a vertical position only. Those
   * must be placed on y alone; a fabricated x would be worse than none.
   */
  x: number | null
  y: number
}

/** One in-text citation: where it is printed, and which entry it names. */
export interface OutlineCallout {
  key: string
  page: number
  /** The annotation rectangle, PDF user space: [x1, y1, x2, y2]. */
  rect: [number, number, number, number]
}

export interface PdfOutline {
  entries: OutlineEntry[]
  callouts: OutlineCallout[]
}

/**
 * The names publishers give a bibliography destination.
 *
 * `cite.` IS ONLY LATEX'S SPELLING. This module was written against hyperref
 * output and matched that prefix alone, so on a corpus of published papers it
 * found nothing and every one of them silently fell back to prose parsing — not
 * because the structure was absent, but because it was spelled differently.
 * Measured across 21 chemistry papers: zero `cite.*`, but eight carry the same
 * per-entry destinations under a publisher's own naming, and five of those also
 * carry the in-text link annotations, for 619 exactly-placed callouts.
 *
 *   cite.<key>      LaTeX / hyperref
 *   bib<n>, bb<n>   Elsevier
 *   bm_CR<n>        Springer
 *   A<n>_Ref_bib<n> Arbortext
 *
 * ANCHORED AND SHAPED, never a substring test. These destinations sit in a name
 * tree beside `fig1`, `tbl2`, `Equ3` and `af1` (affiliations), and a loose match
 * would turn a figure link into a citation — the same class of fabricated edge
 * that footnote markers produced in the text scanner. Each alternative therefore
 * pins its own prefix AND requires the number that follows it.
 *
 * The KEY that comes back is the whole destination name for the publisher forms.
 * Only LaTeX's is a meaningful identifier; `bib12` means nothing on its own, and
 * inventing a "cleaned" key would imply an authorship this cannot claim. What
 * matters downstream is that the same string identifies the same entry, and the
 * raw name does that.
 */
const CITE_DEST_RE = /^(?:cite\.(?<latex>.+)|(?:bib|bb|bm_CR|bibl?)\d+|A\d+_Ref_bib\d+)$/

/**
 * The entry key a destination name stands for, or null when it names something
 * that is not a bibliography entry.
 */
function citeKeyOf(name: string): string | null {
  const m = CITE_DEST_RE.exec(name)
  if (!m) return null
  return m.groups?.latex ?? name
}

/**
 * Read the bibliography structure a PDF records about itself, or null when it
 * records none.
 *
 * Null is the honest answer for every file without usable structure and must not
 * be conflated with an empty bibliography — the caller falls back to prose
 * parsing on null, and would wrongly report "no references" if the two were
 * merged.
 *
 * THE TWO HALVES ARE INDEPENDENT. A file can record where each in-text citation
 * is printed without recording where each entry begins — every Elsevier and
 * Springer paper in this corpus does exactly that, with per-marker link
 * rectangles and page-level entry destinations that locate nothing. So `entries`
 * being empty is not a reason to discard `callouts`: the first is a bibliography
 * this cannot read, the second is 619 citation sites this can.
 */
export async function readPdfOutline(doc: PDFDocumentProxy): Promise<PdfOutline | null> {
  const entries = await readEntries(doc)
  const callouts = await readCallouts(doc)
  if (entries.length === 0 && callouts.length === 0) return null
  return { entries, callouts }
}

/**
 * Where a destination points, whatever KIND of destination it is.
 *
 * The array's shape depends on its type name, and reading a fixed index is a
 * silent, total failure rather than a noisy one:
 *
 *   [page, /XYZ,  left, top, zoom]        -> x = [2], y = [3]
 *   [page, /FitH, top]                    -> y = [2], NO x
 *   [page, /FitBH, top]                   -> y = [2], NO x
 *   [page, /FitR, left, bottom, right, top] -> x = [2], y = top
 *   [page, /Fit]                          -> no position at all
 *
 * An earlier version indexed `[3]` unconditionally. Against a `/FitH` document
 * that reads the missing zoom slot as the position, every destination came back
 * with a null coordinate, all 34 were discarded, and the paper was reported as
 * having NO recorded structure — indistinguishable from a publisher PDF that
 * genuinely has none. The whole bibliography quietly fell back to prose.
 *
 * `x` is null for the horizontal-fit types, and null is correct: those
 * destinations really do not name a column. A caller must then place the entry
 * on y alone and accept the ambiguity rather than invent an x.
 */
function destPosition(d: unknown[]): { x: number | null; y: number } | null {
  const kind = (d[1] as { name?: string } | undefined)?.name
  if (kind === 'XYZ') {
    const x = d[2]
    const y = d[3]
    return typeof y === 'number' ? { x: typeof x === 'number' ? x : null, y } : null
  }
  if (kind === 'FitH' || kind === 'FitBH') {
    const y = d[2]
    return typeof y === 'number' ? { x: null, y } : null
  }
  // /FitR IS A RECTANGLE, AND ON THIS CORPUS IT DOES NOT LOCATE THE ENTRY.
  //
  // It is tempting: every publisher here uses it, and reading `top` as the y
  // makes eight papers appear to gain recorded structure. Measured against the
  // text, that structure is wrong. Elsevier writes the SAME rectangle for every
  // entry — `[page, /FitR, 0, 842, 596, 842]`, the page's top edge, 43 times —
  // so it names the page and not the line. Springer's y does vary and still
  // resolved onto neighbouring prose: work 6's first "entry" came out as a
  // data-availability note, work 2's as body text about model building.
  //
  // Admitting it is worse than skipping it, because the resulting parse looks
  // COMPLETE — no key-sequence gaps — and `outlineIsShort` therefore prefers it
  // over the prose parse that was right. A confident wrong bibliography beats a
  // correct one, which is the failure this whole module exists to avoid.
  //
  // The IN-TEXT LINK ANNOTATIONS from the same files are unaffected and remain
  // valuable: a link's rectangle is where the marker is printed, which is a
  // measurement rather than a scroll target.
  //
  // /Fit and /FitV name a page or a column, not a line. Same conclusion.
  return null
}

async function readEntries(doc: PDFDocumentProxy): Promise<OutlineEntry[]> {
  let dests: Record<string, unknown[]>
  try {
    dests = (await doc.getDestinations()) as Record<string, unknown[]>
  } catch {
    // A malformed name tree is a document without usable structure, not a crash.
    return []
  }

  const out: OutlineEntry[] = []
  for (const name of Object.keys(dests)) {
    const key = citeKeyOf(name)
    if (key === null) continue
    const d = dests[name]
    if (!Array.isArray(d) || d.length < 3) continue
    const pos = destPosition(d)
    if (!pos) continue
    const { x, y } = pos
    let page: number
    try {
      page = (await doc.getPageIndex(d[0] as never)) + 1
    } catch {
      continue
    }
    out.push({ key, page, x, y })
  }

  // Reading order: down each page, and within a page the destinations are
  // ordered by position. Columns are handled by the caller when it maps these
  // to text, because only the text layout knows where the column boundary is.
  out.sort((a, b) => a.page - b.page || b.y - a.y)
  return out
}

async function readCallouts(doc: PDFDocumentProxy): Promise<OutlineCallout[]> {
  const out: OutlineCallout[] = []
  for (let page = 1; page <= doc.numPages; page++) {
    let annots: unknown[]
    try {
      annots = await (await doc.getPage(page)).getAnnotations()
    } catch {
      continue
    }
    for (const a of annots as Array<Record<string, unknown>>) {
      if (a.subtype !== 'Link') continue
      // `dest` is the destination NAME for a named destination, which is what
      // hyperref and the publisher pipelines emit for an in-text citation. An
      // array destination points directly at a page object and carries no key,
      // so it cannot be attributed to an entry.
      const dest = a.dest
      if (typeof dest !== 'string') continue
      const key = citeKeyOf(dest)
      if (key === null) continue
      const rect = a.rect
      if (!Array.isArray(rect) || rect.length < 4) continue
      const [x1, y1, x2, y2] = rect as number[]
      if ([x1, y1, x2, y2].some((n) => typeof n !== 'number')) continue
      out.push({ key, page, rect: [x1, y1, x2, y2] })
    }
  }
  return out
}
