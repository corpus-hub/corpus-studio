/**
 * Locating a quote INSIDE the paragraph its evidence span already names.
 *
 * The document-wide locator needs a long needle, because a short one matches in
 * many places and it has the whole paper to match in. Scoping removes that
 * ambiguity instead of hoping the needle is long: a table cell such as
 * `0.528 ± 0.002` canonicalises to eight characters and can never clear that
 * bar, so before this existed every numeric cell in a kinetics table went
 * unhighlighted while the mutation list beside it — long enough by accident of
 * notation — did not. Measured on the shipped corpus, every one of the 294
 * evidence quotes the length guard dropped is unique inside its own paragraph.
 *
 * Every stage refuses rather than guesses. An unlocatable paragraph, a repeated
 * paragraph, an absent needle and a needle occurring twice within the scope all
 * return null, because a band drawn in the wrong place asserts the paper says
 * something it does not — which in a provenance tool is worse than no band.
 */

/**
 * The one canonical form every text index agrees on: lowercased, with
 * everything that is not a letter or a decimal digit removed.
 *
 * It exists so a quote still matches when the PDF has a line break, a hyphen,
 * a ligature or doubled spacing where the stored text does not.
 *
 * `\p{N}` rather than `\p{Nd}` would keep characters that LOOK like punctuation
 * to a reader: this corpus's PDFs encode `=` as `¼` (VULGAR FRACTION ONE
 * QUARTER, a `\p{No}`), so `k cat ¼ 0.02` canonicalised to `kcat¼002` while the
 * stored quote `kcat = 0.02` canonicalised to `kcat002`. The verbatim match
 * then failed mid-quote and the span fell through to the word-window fallback,
 * which anchors a looser, longer region. Only DECIMAL digits are meaning-
 * bearing here; every other numeric form is layout noise and is dropped
 * alongside the punctuation it stands in for.
 *
 * It lives here rather than in PdfDocView so the locator, its tests and the
 * coverage verifier all share ONE definition. A second copy would be exercised
 * only by the tests and the verifier, leaving both to attest to behaviour the
 * app does not run.
 */
export const canon = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{Nd}]+/gu, '')

/**
 * How much of a paragraph identifies it. Long enough that no two paragraphs of
 * a paper share it — measured across the corpus, a 60-character canonical
 * prefix is unique for 539 of the 544 paragraphs long enough to have one — and
 * short enough to survive the two text extractions disagreeing about where the
 * paragraph ends.
 */
const PARA_KEY_LEN = 60

/**
 * Find `canonNeedle` within the region of `canonDoc` occupied by `canonPara`.
 *
 * All three arguments are already canonical: the caller holds the document's
 * canonical text and its offset arrays, so canonicalising here would desync
 * the index it is about to look up.
 *
 * @returns absolute index into `canonDoc`, or null when anything is ambiguous.
 */
export function findScoped(
  canonDoc: string,
  canonPara: string,
  canonNeedle: string
): number | null {
  if (!canonPara || !canonNeedle) return null

  const key = canonPara.length >= PARA_KEY_LEN ? canonPara.slice(0, PARA_KEY_LEN) : canonPara
  const first = canonDoc.indexOf(key)
  if (first === -1) return null
  // A paragraph printed twice cannot say which copy the span meant.
  if (canonDoc.indexOf(key, first + 1) !== -1) return null

  // The window must never extend past where the paragraph actually ends. The
  // two extractions disagree about paragraph boundaries — that disagreement is
  // why this function exists — so sizing the window by `canonPara.length` alone
  // can run into the following text and match a needle this paragraph does not
  // contain. The tail is located the same way the head was, and only when that
  // fails does the stored length become the bound.
  const tail = canonPara.length >= PARA_KEY_LEN ? canonPara.slice(-PARA_KEY_LEN) : null
  let end = Math.min(first + canonPara.length, canonDoc.length)
  if (tail) {
    const tailAt = canonDoc.indexOf(tail, first)
    if (tailAt !== -1) end = Math.min(tailAt + tail.length, end)
  }
  const window = canonDoc.slice(first, end)

  const at = window.indexOf(canonNeedle)
  if (at === -1) return null
  // Twice inside one paragraph is as unknowable as twice inside the paper.
  if (window.indexOf(canonNeedle, at + 1) !== -1) return null

  return first + at
}
