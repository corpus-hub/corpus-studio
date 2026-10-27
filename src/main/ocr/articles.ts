// Which article on a scanned page is THIS work?
//
// A journal page is a sheet of paper, not a paper. `LETTERS TO NATURE` runs the
// tail of one article, the whole of the next and the opening of a third down the
// same four sides, and OCR reads the sheet — every character of every article on
// it. Stored as one document that is a lie about which paper it is: work 16's
// inventory was 62 % the enzyme paper it claims to be, 19 % a photorefractive
// optical correlator and 20 % Quaternary marine productivity, and every
// consumer downstream — extraction, citation contexts, embeddings, search —
// was reading all three as one.
//
// The separation is GEOMETRIC, and that is what makes it general. A title is
// the only thing on a journal page set substantially larger than the body, so
// the display lines found from OCR's own word boxes are the article starts,
// whatever the article is about; the running head repeats on every page and is
// dropped by that repetition, not by naming it. Nothing here knows what a Nature
// page looks like, and nothing here reads the words except to ask which of the
// candidate titles is the one the `work` row already claims.
//
// The refusal matters as much as the split. When the page carries more than one
// article and NONE of the titles is recognisably this work's — or two are
// equally close — this returns `ambiguous`, and the caller fails the stage. A
// document with no text is a visible gap someone can act on; a document holding
// a different paper's text is a confident, invisible, wrong answer.

/** A run of display-sized lines: a candidate article title. */
export interface TitleBlock {
  charStart: number
  charEnd: number
  text: string
}

/** One article's span in the canonical OCR string. */
export interface ArticleSpan {
  charStart: number
  charEnd: number
  /** The title that opened it, or null for the tail of the previous article. */
  title: TitleBlock | null
}

export type ArticleChoice =
  | { kind: 'single' }
  | { kind: 'selected'; span: ArticleSpan; others: TitleBlock[]; score: number }
  | { kind: 'ambiguous'; candidates: Array<{ title: string; score: number }> }

/** Word geometry, narrowed to what this module reads. */
interface Boxed {
  charStart: number
  charEnd: number
  text: string
  y0: number
  y1: number
}

interface GeomPage {
  page: number
  words: Boxed[]
}

/**
 * Words that carry no evidence of which paper a title names.
 *
 * Deliberately short and structural. A longer list starts encoding a domain,
 * and the same code has to separate a marine-sediment article from an enzyme
 * one.
 */
const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'are',
  'was',
  'were',
  'from',
  'its',
  'their',
  'into',
  'via',
  'using',
  'analysis'
])

/** Content tokens of a title, hyphens split so `tailor-made` is two words. */
function tokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (t) => t.length >= 3 && !STOPWORDS.has(t)
  )
}

/**
 * Do two tokens name the same word, allowing for one misread character?
 *
 * OCR sets titles in the largest type on the page and still returns `Mimickinc`
 * for `Mimicking`. Demanding equality would let a single wrong glyph in a title
 * turn a confident match into a refusal — and a refusal is expensive here,
 * because it discards a paper we can actually read.
 */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true
  if (a.length < 5 || b.length < 5) return false
  if (Math.abs(a.length - b.length) > 1) return false
  // One substitution, insertion or deletion — a bounded check, not a general
  // edit distance, because anything looser starts matching different words.
  let i = 0
  let j = 0
  let slack = 1
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++
      j++
      continue
    }
    if (slack-- === 0) return false
    if (a.length === b.length) {
      i++
      j++
    } else if (a.length > b.length) i++
    else j++
  }
  return slack >= 0 || i === a.length || j === b.length
}

/** How much of `want`'s content is present in `have`, 0..1. */
function coverage(want: string[], have: string[]): number {
  if (want.length === 0) return 0
  let hit = 0
  for (const w of want) if (have.some((h) => sameWord(w, h))) hit++
  return hit / want.length
}

/**
 * How much of the work's title appears ANYWHERE in the text, 0..1.
 *
 * The backstop for the case the geometric split cannot see: a scan whose words
 * failed to align carries no boxes, so no title block is found, so the page
 * looks single-article whatever is actually on it. A paper whose own title is
 * absent from its own text is not proof of the wrong paper — a scan can begin
 * on page 2, and OCR can mangle a title outright — but it is the one cheap
 * check that separates "we read this paper badly" from "we read a different
 * paper", and it belongs on the record rather than in nobody's hands.
 */
export function titlePresence(text: string, workTitle: string): number {
  return coverage(tokens(workTitle), tokens(text))
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

/**
 * Display-sized lines on the page, merged into blocks.
 *
 * A "line" is a run of words sharing a baseline within a tolerance derived from
 * the body height itself, so the test does not assume a scan resolution. A
 * block is display-sized when it is at least half again the body height, holds
 * at least two words, and is mostly letters — the last of which is what keeps a
 * table's giant axis label (`Keat/Km`, `20° 10"`) out.
 */
export function findTitleBlocks(pages: GeomPage[]): TitleBlock[] {
  const heights = pages.flatMap((p) => p.words.map((w) => w.y1 - w.y0))
  const body = median(heights)
  if (body <= 0) return []
  const blocks: TitleBlock[] = []
  for (const page of pages) {
    const words = [...page.words].sort((a, b) => a.charStart - b.charStart)
    const lines: Boxed[][] = []
    let cur: Boxed[] = []
    for (const w of words) {
      if (cur.length > 0 && Math.abs(w.y0 - cur[cur.length - 1].y0) > body * 0.55) {
        lines.push(cur)
        cur = []
      }
      cur.push(w)
    }
    if (cur.length > 0) lines.push(cur)

    for (const line of lines) {
      const h = median(line.map((w) => w.y1 - w.y0))
      const text = line.map((w) => w.text).join(' ')
      const letters = (text.match(/\p{L}/gu) ?? []).length
      const dense = text.replace(/\s+/g, '').length
      if (h < body * 1.5) continue
      if (line.length < 2 || letters < 8 || letters < dense * 0.6) continue
      const start = line[0].charStart
      const end = line[line.length - 1].charEnd
      const last = blocks[blocks.length - 1]
      // A title wraps over two or three display lines. Adjacent means adjacent
      // in the TEXT, so a title broken across a column is joined and two titles
      // separated by a column of body text are not.
      if (last && start - last.charEnd <= 6) {
        last.charEnd = end
        last.text = `${last.text} ${text}`
      } else {
        blocks.push({ charStart: start, charEnd: end, text })
      }
    }
  }
  return blocks
}

/**
 * A BYLINE: the author list that follows an article title.
 *
 * Structural, not domain-specific — initials, and either an ampersand or a
 * comma separating names — which is what a byline is in every journal. The
 * year-in-parentheses exclusion is what keeps a bibliography entry out, since
 * one is author-shaped by construction.
 */
const BYLINE_RE = /^[^\n]{10,220}$/
function looksLikeByline(line: string): boolean {
  const s = line.trim()
  if (!BYLINE_RE.test(s)) return false
  if (!/\b[A-Z]\./.test(s)) return false
  if (!/[&,]/.test(s)) return false
  if (/\(\s*(1[89]|20)\d{2}\s*\)/.test(s)) return false
  if (/^\s*\d{1,3}[.)]\s/.test(s)) return false
  const letters = (s.match(/\p{L}/gu) ?? []).length
  return letters >= s.replace(/\s+/g, '').length * 0.7
}

/** How far past a title its byline may sit before it is somebody else's. */
const BYLINE_WINDOW = 400

/**
 * Title blocks that OPEN AN ARTICLE, rather than large type that does not.
 *
 * Two filters, both structural:
 *
 * The running head is set large and appears on every page, so it is removed by
 * being REPEATED — no list of publisher strings, which would only ever cover the
 * journals someone thought of.
 *
 * Everything else large is separated by what an article title is FOR: it
 * introduces a byline. A scan's per-word heights are noisy enough that a line of
 * body text or an acknowledgement fragment can measure 1.7× the median —
 * `'Molecular Assemblies (CAMP),'`, `'that differences'` both did, and each one
 * accepted cuts this paper's text short at a boundary that is not one. A title
 * with no author list under it is not an article start, and requiring one costs
 * nothing where a real title exists.
 */
function articleTitles(blocks: TitleBlock[], text: string): TitleBlock[] {
  const counts = new Map<string, number>()
  for (const b of blocks) {
    const k = tokens(b.text).join(' ')
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return blocks.filter((b) => {
    if ((counts.get(tokens(b.text).join(' ')) ?? 0) !== 1) return false
    // A title is a whole noun phrase. A fragment of a sentence that happened to
    // measure large — `'Molecular Assemblies (CAMP),'`, lifted out of the
    // previous article's acknowledgements — ends mid-clause, and a title never
    // does. Cheap, and it is the shape rather than the subject.
    if (/[,;:]$/.test(b.text.trim())) return false
    const after = text.slice(b.charEnd, b.charEnd + BYLINE_WINDOW)
    return after.split('\n').some(looksLikeByline)
  })
}

/** Split the document at each article title. */
export function articleSpans(titles: TitleBlock[], textLength: number): ArticleSpan[] {
  const spans: ArticleSpan[] = []
  if (titles.length === 0) return [{ charStart: 0, charEnd: textLength, title: null }]
  if (titles[0].charStart > 0) {
    spans.push({ charStart: 0, charEnd: titles[0].charStart, title: null })
  }
  for (let i = 0; i < titles.length; i++) {
    spans.push({
      charStart: titles[i].charStart,
      charEnd: i + 1 < titles.length ? titles[i + 1].charStart : textLength,
      title: titles[i]
    })
  }
  return spans
}

/**
 * At least this much of the work's title must be found in an article's title
 * for it to be that article.
 */
const MATCH_FLOOR = 0.55
/** And it must beat the next-best candidate by this much, or it is a guess. */
const MATCH_MARGIN = 0.25

/**
 * Which article on this page is the work — or an honest refusal.
 *
 * `single` when the page carries one article: nothing to choose, and the text
 * is passed through untouched. That is the case for every born-digital paper
 * and for most scans, so the common path costs one geometry pass and no
 * decision at all.
 */
export function chooseArticle(
  pages: GeomPage[],
  text: string,
  workTitle: string
): ArticleChoice {
  const textLength = text.length
  const titles = articleTitles(findTitleBlocks(pages), text)
  if (titles.length <= 1) return { kind: 'single' }

  const want = tokens(workTitle)
  const scored = titles.map((t) => ({ title: t, score: coverage(want, tokens(t.text)) }))
  const ranked = [...scored].sort((a, b) => b.score - a.score)
  const best = ranked[0]
  const next = ranked[1]

  if (best.score < MATCH_FLOOR || best.score - next.score < MATCH_MARGIN) {
    return {
      kind: 'ambiguous',
      candidates: ranked.map((r) => ({ title: r.title.text, score: r.score }))
    }
  }

  const span = articleSpans(titles, textLength).find((s) => s.title === best.title)
  if (!span) {
    return {
      kind: 'ambiguous',
      candidates: ranked.map((r) => ({ title: r.title.text, score: r.score }))
    }
  }
  return {
    kind: 'selected',
    span,
    others: titles.filter((t) => t !== best.title),
    score: best.score
  }
}
