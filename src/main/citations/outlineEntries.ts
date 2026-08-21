// Turning the PDF's recorded structure into references with CHAR OFFSETS.
//
// `pdfOutline.ts` reads what the file says: a key and a page position per
// entry. Everything downstream — highlights in the viewer, evidence spans,
// reconciliation against the indexes — speaks canonical char offsets. This is
// the join, and it is done against `text.pages@v2`'s own items rather than by
// re-opening the PDF, so the offsets are the same ones every other anchor uses
// by construction rather than by coincidence.

import type { TextItem, TextPage, TextPages } from '../pipeline/capabilities'
import type { OutlineCallout, OutlineEntry } from './pdfOutline'
import { parseEntry } from './parseReferences'
import type { ParsedReference } from './parseReferences'

/**
 * How far below a destination the entry's first line may sit.
 *
 * A destination is placed at the top of the line box and the text baseline sits
 * below it, so the gap is one line's ascent — 11pt for the 10pt bodies here.
 * The window has to admit that without reaching the NEXT line, which is why it
 * is a bound and not a tolerance either side.
 */
const MAX_BELOW = 18

/** How far ABOVE the destination a baseline may be and still be the same line. */
const MAX_ABOVE = 2

/**
 * Same-column test, in points.
 *
 * The failure this prevents is silent and total. Two-column bibliographies put
 * a different entry at the same y in each column, so without an x test the
 * nearest-baseline search returns whichever item comes first in the content
 * stream — which for the papers here meant destinations resolving onto body
 * text in the middle of the document, at a 0% hit rate that looked exactly like
 * the destinations being unusable rather than the query being wrong.
 *
 * 60pt is far wider than the jitter between a destination's x and the first
 * glyph's x (observed: under 2pt) and far narrower than a column gap
 * (observed: 235pt).
 */
const SAME_COLUMN = 60

/** The text item beginning the line a destination points at, or null. */
function itemAt(page: TextPage, x: number | null, y: number): TextItem | null {
  if (!page.items) return null
  let best: TextItem | null = null
  let bestScore = Infinity
  for (const it of page.items) {
    if (typeof it.x !== 'number') continue
    const dy = y - it.baseline
    if (dy < -MAX_ABOVE || dy > MAX_BELOW) continue
    // A `/FitH` destination names no column, so every column is admissible and
    // the line search falls back to y alone — correct, and weaker: on a
    // two-column page it can pick the wrong column. That is the destination's
    // own limitation, not something to paper over with a guessed x.
    if (x !== null && Math.abs(it.x - x) > SAME_COLUMN) continue
    // Prefer the highest line in the window, then the leftmost item on it: the
    // entry starts at the beginning of its first line, not at whichever glyph
    // happens to sit nearest the destination's own x.
    const score = dy * 1000 + it.x
    if (score < bestScore) {
      bestScore = score
      best = it
    }
  }
  return best
}

/**
 * Reference entries with real spans, derived from the file's own structure.
 *
 * Each entry runs from its own destination to the NEXT one in reading order,
 * which is what makes the spans exact where the prose parser had to infer them.
 * The last entry has no successor and is bounded by the end of its page's text
 * — deliberately not by the end of the document, which would swallow every
 * appendix that follows the bibliography.
 */
/**
 * Does the recorded key sequence have HOLES in it?
 *
 * A PDF's own record is evidence, not ground truth, and this is how it admits
 * so. Where a producer numbers its destinations — `b1`, `b2`, `ref_7` — the
 * numbers should run unbroken. A gap means the file records fewer entries than
 * the bibliography contains: one paper here carries `b1`..`b108` with 8
 * missing, so reading its destinations gave 99 references for a bibliography
 * that Crossref independently reports as 104 — and the prose parser had already
 * found all 104.
 *
 * Worth detecting rather than absorbing, because it inverts which source to
 * believe for that one document. Preferring a recorded boundary over a guessed
 * one is right in general and wrong when the record is missing entries.
 *
 * Returns 0 when the keys are not a numbered scheme at all. `agirre2015semeval`
 * and `AbeHazRak08` have no sequence to be missing from, and treating an
 * unnumbered scheme as one enormous gap would reject every ACL paper in the
 * corpus — which is most of where this reader earns its keep.
 */
export function keySequenceGaps(entries: OutlineEntry[]): number {
  const nums: number[] = []
  for (const e of entries) {
    // The whole key must be a short stem plus trailing digits. `arora2016simple`
    // embeds a YEAR and is not a sequence number, so requiring the digits to end
    // the key keeps author-year schemes out of this test entirely.
    const m = /^([A-Za-z_]{1,4})(\d{1,4})$/.exec(e.key)
    if (m) nums.push(Number(m[2]))
  }
  // Below half, the numbered keys are incidental rather than the scheme.
  if (nums.length < 4 || nums.length < entries.length * 0.5) return 0
  const seen = new Set(nums)
  const lo = Math.min(...nums)
  const hi = Math.max(...nums)
  let gaps = 0
  for (let i = lo; i <= hi; i++) if (!seen.has(i)) gaps++
  return gaps
}

export function entriesFromOutline(
  outline: { entries: OutlineEntry[]; callouts: OutlineCallout[] },
  pages: TextPages
): { references: ParsedReference[]; unplaced: string[] } {
  const byPage = new Map<number, TextPage>()
  for (const p of pages.pages) byPage.set(p.page, p)

  // Place every destination first, then cut. A destination that cannot be
  // placed must not silently take its neighbour's text.
  const placed: Array<{ key: string; offset: number }> = []
  const unplaced: string[] = []
  for (const e of outline.entries) {
    const page = byPage.get(e.page)
    const item = page ? itemAt(page, e.x, e.y) : null
    if (!page || !item) {
      unplaced.push(e.key)
      continue
    }
    placed.push({ key: e.key, offset: item.charStart })
  }

  placed.sort((a, b) => a.offset - b.offset)

  const references: ParsedReference[] = []
  for (let i = 0; i < placed.length; i++) {
    const start = placed[i].offset
    const end = i + 1 < placed.length ? placed[i + 1].offset : endOfPageAt(pages, start)
    if (end <= start) {
      unplaced.push(placed[i].key)
      continue
    }
    const slice = pages.text.slice(start, end)
    const raw = slice.trim()
    if (!raw) {
      unplaced.push(placed[i].key)
      continue
    }
    // Trimming moved the text, so the OFFSET has to move with it. Keeping the
    // untrimmed `start` while storing the trimmed string breaks the exact-slice
    // contract by however much whitespace was in front — one character here,
    // which is enough to shift every highlight in the entry by one glyph and to
    // make `text.slice(char_start, char_end) === raw_bib_text` false.
    const lead = slice.length - slice.trimStart().length
    const entryStart = start + lead
    // The FIELDS still come from reading the entry — the file records where a
    // reference is, never what it says. `parseEntry` is the audited extractor
    // and is reused exactly; only the boundaries it is given have changed, from
    // guessed to recorded.
    const parsed = parseEntry(raw, i + 1)
    references.push({
      ...parsed,
      raw_bib_text: raw,
      char_start: entryStart,
      char_end: entryStart + raw.length
    })
  }

  return { references, unplaced }
}

/** Where the page containing `offset` ends. */
function endOfPageAt(pages: TextPages, offset: number): number {
  for (const p of pages.pages) {
    if (offset >= p.charStart && offset < p.charEnd) return p.charEnd
  }
  return pages.text.length
}

/**
 * In-text citations, as char offsets, keyed to the entry each one names.
 *
 * This is the part the prose path cannot do at all. It answers "which sentence
 * cites this reference" from an annotation rectangle the typesetter placed,
 * rather than by finding a digit in a sentence — a test that also matches
 * `1 Department of Biochemistry, 2 Biomolecular Structure` and
 * `15,800 M 2 1 cm 2 1`, and was measured wrong on roughly one link in ten.
 */
export function calloutsFromOutline(
  outline: { callouts: OutlineCallout[] },
  pages: TextPages
): Array<{ key: string; charStart: number; charEnd: number; page: number }> {
  const byPage = new Map<number, TextPage>()
  for (const p of pages.pages) byPage.set(p.page, p)

  const out: Array<{ key: string; charStart: number; charEnd: number; page: number }> = []
  for (const c of outline.callouts) {
    const page = byPage.get(c.page)
    if (!page?.items) continue
    const [x1, y1, x2, y2] = c.rect
    // Items the rectangle covers, judged on HORIZONTAL OVERLAP as a fraction of
    // the item's own width rather than on any overlap at all.
    //
    // A citation marker is narrow — one raised digit — and the items around it
    // are whole words. Admitting an item because its box merely touches the
    // rectangle's edge pulled in the entire body line: work 2's `bib1` came back
    // as "of forces and factors to achieve extreme" instead of the `1` after
    // "accelerations.". Requiring the rectangle to cover most of an item keeps
    // the marker and drops the neighbours it happens to abut.
    //
    // The vertical test stays generous because a SUPERSCRIPT's baseline is
    // raised several points above the line it belongs to, and the annotation is
    // drawn around the glyph rather than the line — so a tight baseline window
    // would find nothing at all on exactly the papers this serves.
    // TWO PRODUCERS, TWO ANSWERS, and the item granularity decides which.
    //
    // Measured on this corpus: some files give pdf.js one item PER GLYPH, so the
    // rectangle covers the marker's own items almost exactly (f≈1.00) while the
    // words beside it are barely touched (f≤0.17) — there the marker can be
    // isolated. Others give one item PER LINE (width 251pt), so the marker has
    // no item of its own and the best available answer is the line that contains
    // it (f≈0.04); demanding isolation there found nothing at all and cost work
    // 11 all but one of its 40 links.
    //
    // So: prefer well-covered items, and fall back to whatever the rectangle
    // touches when nothing is well covered. The fallback is a WIDER span, not a
    // wrong one — the citation really is inside it.
    const touched: Array<{ charStart: number; charEnd: number; f: number }> = []
    for (const it of page.items) {
      if (typeof it.x !== 'number') continue
      if (it.baseline < y1 - 2 || it.baseline > y2 + 2) continue
      const w = it.width ?? 0
      const overlap = Math.min(it.x + w, x2) - Math.max(it.x, x1)
      if (overlap <= 0) continue
      // A zero-width item is a space pdf.js reports with no advance: it has no
      // fraction to take, and admitting it would let a space decide the span.
      touched.push({ charStart: it.charStart, charEnd: it.charEnd, f: w > 0 ? overlap / w : 0 })
    }
    if (touched.length === 0) continue
    const isolated = touched.filter((t) => t.f >= 0.6)
    const use = isolated.length > 0 ? isolated : touched
    const lo = Math.min(...use.map((t) => t.charStart))
    const hi = Math.max(...use.map((t) => t.charEnd))
    out.push({ key: c.key, charStart: lo, charEnd: hi, page: c.page })
  }
  return out
}

/**
 * Bump when the outline reader's behaviour changes, so stored parses supersede.
 *
 * Separate from `PARSER_VERSION`: the two producers advance independently, and
 * folding them into one number would either re-run every prose parse for an
 * outline fix or, worse, leave outline parses stale because the prose version
 * did not move.
 */
export const OUTLINE_VERSION = '1.1.0'
