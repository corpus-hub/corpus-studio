// Abstracts for references, from the two indexes that hold any.
//
// Sibling to `sources.ts` and bound by the same rule its header states: every
// function here is a PURE TRANSLATION of one HTTP reply. No merging across
// sources, no DB. Reconciliation lives elsewhere for the same reason a source
// can be added by writing one function.
//
// OpenCitations is absent on purpose: it returns `{citing, cited}` DOI pairs and
// no metadata at all, so it has no abstract to give. Listing it would imply a
// fallback that does not exist.
//
// The DOI paths are KEYED. An index either holds that identifier or it does not,
// and there is no step in between where the wrong paper's abstract can be
// attached — which in this codebase is the same class of error as fabricating a
// DOI. `bibliographicMatch` is the one path with a matching step in it, and it
// is keyed too, on a coordinate the bibliography itself printed.

import { normalizeDoi } from '../../citations/normalize'
import { getJson, type FetchOptions } from './sources'

/** Which index answered. Provenance, not a ranking. */
export type AbstractSource = 'openalex' | 'crossref'

/**
 * The outcomes, kept apart for the reason `types.ts` keeps its three apart.
 *
 *   - `found`               — text, with the source that held it.
 *   - `absent`              — the index answered and holds no usable abstract
 *                             for this identifier. PERMANENT; retrying asks the
 *                             same question and gets the same answer.
 *   - `unreachable`         — the index did not answer (HTTP error, timeout,
 *                             abort). The only retryable outcome here.
 *   - `nothing-to-ask-with` — we never asked, because there was no usable input.
 *                             A title is as good an input as a DOI, so the name
 *                             is about the missing QUESTION rather than about a
 *                             missing identifier.
 *
 * Flattening `absent` into `unreachable` (or the reverse) is the failure this
 * shape exists to prevent: an offline laptop would otherwise write "no abstract
 * on record" across a whole corpus and nothing would ever retry it.
 *
 *   - `ambiguous`           — the reference printed a volume:page coordinate and
 *                             the paper Crossref chose prints a different one.
 *                             A DIFFERENT fact from `absent`: the paper is very
 *                             probably in the index, and the entry as parsed
 *                             does not pin which one it is. Kept apart so a
 *                             user reading "no abstract on record" is never
 *                             being told that about a reference we could not
 *                             pin.
 *
 * These are the `reference_abstract.outcome` CHECK values verbatim, so a result
 * reaches a row unchanged. A translation layer between two names for one concept
 * is precisely where a later reader collapses two of these facts into one, which
 * is the failure both this type and that column exist to prevent.
 */
export type AbstractOutcome =
  | 'found'
  | 'absent'
  | 'unreachable'
  | 'nothing-to-ask-with'
  | 'ambiguous'

/**
 * Which rule admitted a row, stamped onto every one written.
 *
 * The gate is the only thing between a bibliography entry and the wrong paper's
 * abstract. Changing what it accepts means the rows written under the older rule
 * were admitted on evidence this build would refuse, and they must be
 * distinguishable from the ones it writes. Bump this when the rule changes;
 * never to record an unrelated edit, or it stops meaning anything.
 *
 * 4 is the first version of the coordinate rule. Every earlier row was admitted
 * by a title-similarity threshold that no longer exists, so no row below 4 can
 * be compared with one at 4 on the strength of its evidence.
 *
 * 5 admits a line that prints no volume and page, verified on its TITLE instead.
 * Version 4 opened no socket at all for those and recorded
 * `nothing-to-ask-with`, which was untrue of 250 of this corpus's 308 unasked
 * references: they are complete citations naming a book, a piece of software or
 * a paper whose entry carries no page range. Those rows were never asked, so
 * they are not comparable with a row at 5, which was.
 *
 * 6 accepts a printed page that falls INSIDE the range the index returned, not
 * only one equal to its first page. A bibliography may cite the page a passage
 * is on rather than where the article starts — 35:707 against a record paged
 * 706-724 is the same article — and version 5 called that a different paper and
 * discarded an abstract the index was holding. Rows at 5 were refused on
 * evidence this build accepts, so they must be asked again.
 */
export const ABSTRACT_FETCHER_VERSION = 6

export interface AbstractResult {
  /** Normalised, when we had one to ask with. */
  doi: string | null
  outcome: AbstractOutcome
  /** Non-null if and ONLY if `outcome === 'found'`. Never an empty string. */
  abstract: string | null
  /** Null unless an index answered with text. Never defaulted. */
  source: AbstractSource | null
  /** The index's own title for what it matched, for the audit trail. */
  matchedTitle: string | null
  /** A sentence a user could read. Non-null only when `unreachable`. */
  error: string | null
  /**
   * ALWAYS NULL, and the column (`match_confidence`) is therefore never written
   * with a number by this module.
   *
   * A VERIFIED COORDINATE IS NOT A PROBABILITY. The bibliographic path accepts
   * when a printed volume and first page equal the ones that came back, and
   * refuses otherwise; there is no quantity in between for a number to report.
   * Writing `1.0` for every accepted match would put a figure in the audit trail
   * that only restates the outcome, and any badge built on it would be showing
   * the reader a confidence nobody computed — theatre in the one place this
   * codebase most needs a measurement to be real. The field stays on the shape
   * because the column exists and older rows carry values from the similarity
   * era; nothing here adds to them.
   */
  matchConfidence: number | null
}

/**
 * Below this, an "abstract" is noise a reranker would score anyway.
 *
 * Crossref deposits contain literal `Abstract`, `n/a` and `—` in this field —
 * the depositor filled the slot rather than leaving it out. Forty characters is
 * comfortably under any real abstract and comfortably over every one of those.
 */
export const MIN_ABSTRACT_CHARS = 40

/**
 * How much folded title a line must print before its title can verify a match.
 *
 * A short one is not evidence. "Origin (OriginLab, Northampton, MA)" folds to
 * something a dozen characters long that Crossref answers with "Origin 7.5
 * OriginLab Corporation" — plausible, confident, and a different record. The
 * floor is deliberately well above where two real titles still collide, because
 * the cost of the two errors is not symmetric: a reference left without an
 * abstract is scored on its title and stays honest, while a wrong abstract is
 * one paper's words filed under another's name and nothing downstream can tell.
 */
export const MIN_VERIFIABLE_TITLE_CHARS = 25

/**
 * A sparse array sized from a number the network chose is a memory hazard on a
 * main-process fetch loop, so a hostile or malformed index is rejected whole
 * rather than partially reconstructed.
 */
const MAX_ABSTRACT_TOKENS = 20_000

/** OpenAlex documents 50 as the `|` OR-filter limit. */
const OPENALEX_BATCH = 50

/** Long DOIs exist; the batch flushes on whichever bound is hit first. */
const MAX_URL_CHARS = 4000

/** Well inside OpenAlex's 10 req/s, and this is never on an interactive path. */
const OPENALEX_BATCH_DELAY_MS = 120

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function found(
  doi: string | null,
  abstract: string,
  source: AbstractSource,
  matchedTitle: string | null
): AbstractResult {
  return {
    doi,
    outcome: 'found',
    abstract,
    source,
    matchedTitle,
    error: null,
    matchConfidence: null
  }
}

function absent(doi: string | null, matchedTitle: string | null = null): AbstractResult {
  return {
    doi,
    outcome: 'absent',
    abstract: null,
    source: null,
    matchedTitle,
    error: null,
    matchConfidence: null
  }
}

function unreachable(doi: string | null, error: string): AbstractResult {
  return {
    doi,
    outcome: 'unreachable',
    abstract: null,
    source: null,
    matchedTitle: null,
    error,
    matchConfidence: null
  }
}

function nothingToAskWith(): AbstractResult {
  return {
    doi: null,
    outcome: 'nothing-to-ask-with',
    abstract: null,
    source: null,
    matchedTitle: null,
    error: null,
    matchConfidence: null
  }
}

function ambiguous(): AbstractResult {
  return {
    doi: null,
    outcome: 'ambiguous',
    abstract: null,
    source: null,
    matchedTitle: null,
    error: null,
    matchConfidence: null
  }
}

function text(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length > 0 ? t : null
}

/** The junk floor, applied identically to both sources. */
function usable(s: string | null): string | null {
  if (!s) return null
  return s.trim().length >= MIN_ABSTRACT_CHARS ? s.trim() : null
}

// ------------------------------------------------------- inverted index

/**
 * OpenAlex stores an abstract as `token -> [positions]`. Put it back.
 *
 * TWO DETAILS ARE LOAD-BEARING.
 *
 * **A GAP LEAVES NO TRACE, AND THAT IS THE CHOICE.** OpenAlex strips some
 * tokens, so the position sequence has holes. The hole is written as an empty
 * slot and the final `\s+` collapse then erases it, so `{a:[0],b:[2]}` and
 * `{a:[0],b:[1]}` both read `"a b"` — the output does NOT record that something
 * was missing. It cannot: the stripped token is unrecoverable, and every way of
 * marking the hole (`[…]`, a double space, an ellipsis) is a mark the source did
 * not put there, our sentence presented as the paper's. So the missing word is
 * lost silently rather than replaced by a guess, and no word pair is invented by
 * detokenisation either.
 *
 * **DUPLICATE POSITIONS ARE LAST-WRITER-WINS**, in `Object.entries` order, and
 * that is stated rather than defended: OpenAlex emits one token per position, so
 * a collision means the reply is already malformed. Merging the two into
 * "first/second" would be prose neither the paper nor the index ever wrote,
 * which is worse than dropping one.
 *
 * **NO DETOKENISATION.** Joined with single spaces and left alone. Re-attaching
 * punctuation ("word ." -> "word.") is a guess about the tokeniser that will
 * eventually weld one sentence to the next, and buys a reranker nothing.
 */
export function reconstructAbstract(idx: unknown): string | null {
  if (typeof idx !== 'object' || idx === null || Array.isArray(idx)) return null

  const slots: string[] = []
  let max = -1
  let tokens = 0

  for (const [token, positions] of Object.entries(idx as Record<string, unknown>)) {
    if (!Array.isArray(positions)) continue
    for (const p of positions) {
      if (!Number.isInteger(p) || (p as number) < 0) continue
      if ((p as number) > MAX_ABSTRACT_TOKENS) return null
      slots[p as number] = token
      if ((p as number) > max) max = p as number
      tokens++
      if (tokens > MAX_ABSTRACT_TOKENS) return null
    }
  }
  if (max < 0) return null

  const out: string[] = []
  for (let i = 0; i <= max; i++) out.push(slots[i] ?? '')

  const joined = out.join(' ').replace(/\s+/g, ' ').trim()
  return joined.length > 0 ? joined : null
}

// ------------------------------------------------------------------ JATS

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'"
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
}

function safeCodePoint(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return ''
  try {
    return String.fromCodePoint(n)
  } catch {
    return ''
  }
}

/**
 * Crossref's `abstract` is a JATS XML fragment. Flatten it to prose.
 *
 * A regex, not a parser, and deliberately: this is a fragment of a known narrow
 * vocabulary (`jats:p`, `jats:italic`, `jats:sub`, `jats:sup`, `jats:sec`,
 * `jats:title`, `mml:*`) which never reaches a DOM — it is plain text bound for
 * a model and a read-only panel. Sub/superscript formatting is lost, and that is
 * accepted: `kcat` and `k_cat` read the same to a reranker.
 *
 * Order matters three times:
 *   - CDATA and comments are resolved FIRST. A CDATA section's whole point is
 *     that its contents are not markup, so anything that treats `]]>` as a tag
 *     leaves the terminator in the prose and eats the text in front of it. A
 *     comment goes the other way and is removed WITH its contents: it is the
 *     depositor talking to themselves, not a sentence the paper printed.
 *   - paragraph ENDS become breaks BEFORE tags are stripped, or a structured
 *     abstract's sections run into one another as a single sentence.
 *   - `<mml:math>` is DROPPED WITH ITS CONTENTS, not flattened. Flattened
 *     MathML is a run of loose digits and operators — text that reads as
 *     corruption and would poison a relevance score. Losing the formula leaves
 *     the surrounding prose intact, which is the part worth scoring.
 *
 * ONLY THINGS SHAPED LIKE A TAG ARE STRIPPED. A generic `<[^>]*>` reads a bare
 * `<` as a tag opener and deletes everything up to the next `>` — so
 * "Tm < 50 degrees and kcat > 3" becomes "Tm 3", nine words gone, and in a real
 * abstract the survivor still clears the junk floor and nothing downstream ever
 * notices. Inequalities are ordinary prose in the kinetics and stability
 * abstracts this app exists to read, so a lone `<` stays literal text and only a
 * name-led `<tag …>` or `</tag>` is removed.
 */
export function unwrapJats(xml: string | null | undefined): string | null {
  if (typeof xml !== 'string' || xml.trim().length === 0) return null
  let s = xml

  // CDATA down to its contents, comments away entirely — both before any rule
  // below can mistake their delimiters for markup.
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')

  // The literal heading several depositors include. Not part of the abstract.
  // Trailing punctuation is allowed because "ABSTRACT." and "Abstract:" are the
  // same heading, and a match that misses them welds the word onto the body.
  s = s.replace(
    /<(?:[a-zA-Z0-9]+:)?title[^>]*>\s*abstract\s*[.:]?\s*<\/(?:[a-zA-Z0-9]+:)?title>/gi,
    ''
  )

  // MathML, contents and all — before anything else touches the tags.
  s = s.replace(/<(?:[a-zA-Z0-9]+:)?math\b[\s\S]*?<\/(?:[a-zA-Z0-9]+:)?math\s*>/gi, ' ')
  s = s.replace(/<(?:[a-zA-Z0-9]+:)?math\b[^>]*\/>/gi, ' ')
  // An UNCLOSED `<math>` survived the paired rule, and flattening it is exactly
  // the digit soup the paired rule exists to prevent. Drop it to the end of its
  // paragraph rather than the end of the fragment: a fragment-wide cut would
  // discard every later section over one malformed formula, and a paragraph
  // boundary is the smallest unit we can still identify in broken markup.
  s = s.replace(
    /<(?:[a-zA-Z0-9]+:)?math\b[\s\S]*?(?=<\/(?:[a-zA-Z0-9]+:)?p\s*>|$)/gi,
    ' '
  )

  // Paragraph and section ends become breaks while they are still tags. A title
  // end breaks too, or a heading runs straight into the first word of the body.
  s = s.replace(/<\/(?:[a-zA-Z0-9]+:)?(?:p|sec|abstract|title)\s*>/gi, '\n\n')
  s = s.replace(/<(?:[a-zA-Z0-9]+:)?break\s*\/?>/gi, '\n')

  s = s.replace(/<\/?[a-zA-Z][a-zA-Z0-9:.-]*(?:\s[^<>]*)?\/?>/g, '')
  s = decodeEntities(s)

  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return s.length > 0 ? s : null
}

// -------------------------------------------------------------- openalex

/**
 * Abstracts for many DOIs, 50 per request.
 *
 * Returns ONE entry per requested DOI, keyed by its normalised form. A DOI the
 * reply omits is `absent` for OpenAlex — it answered and does not hold that paper
 * with an abstract — and the caller is free to try Crossref for it. A DOI in a
 * batch that FAILED is `unreachable`, which is a different fact and the only one
 * worth retrying.
 *
 * Diverges from `sources.ts` on one point, on purpose: a failed batch there
 * fails the whole call, because a partial reference list becomes a false count
 * the user reads. A partial set of abstracts corrupts no number, so the run
 * continues to the next batch and the failure is recorded per DOI.
 *
 * Results are matched back BY MAP on the normalised DOI, NEVER by array
 * position: OpenAlex returns the works it holds, in its own order, and may
 * return fewer than were asked for. Position-matching would hand one reference
 * another paper's abstract, silently.
 */
export async function openAlexAbstracts(
  dois: string[],
  opts: FetchOptions = {}
): Promise<Map<string, AbstractResult>> {
  const out = new Map<string, AbstractResult>()

  const wanted: string[] = []
  const seen = new Set<string>()
  for (const raw of dois) {
    const d = text(raw) ? normalizeDoi(raw) : null
    if (!d) continue
    if (seen.has(d)) continue
    seen.add(d)
    wanted.push(d)
  }
  if (wanted.length === 0) return out

  // The URL is not just the DOIs. Base, `select`, `per-page` and `mailto` are
  // ~180 characters that a server counts and a budget measured only over DOIs
  // does not, which is how a batch sized to fit lands over the limit. The
  // accumulator therefore starts at the assembled prefix's real length.
  const fixedUrlChars = (() => {
    const u = new URL('https://api.openalex.org/works')
    u.searchParams.set('filter', 'doi:')
    u.searchParams.set('per-page', String(OPENALEX_BATCH))
    u.searchParams.set('select', 'id,doi,title,publication_year,abstract_inverted_index')
    if (opts.mailto) u.searchParams.set('mailto', opts.mailto)
    return u.toString().length
  })()

  let batch: string[] = []
  const batches: string[][] = []
  let urlLen = fixedUrlChars
  for (const d of wanted) {
    // A DOI containing `|` would split the OR-filter and silently ask about two
    // identifiers that do not exist. Rare, but it is asked alone rather than
    // corrupting its neighbours' request.
    if (d.includes('|')) {
      batches.push([d])
      continue
    }
    const cost = encodeURIComponent(d).length + 1
    if (batch.length >= OPENALEX_BATCH || urlLen + cost > MAX_URL_CHARS) {
      if (batch.length > 0) batches.push(batch)
      batch = []
      urlLen = fixedUrlChars
    }
    batch.push(d)
    urlLen += cost
  }
  if (batch.length > 0) batches.push(batch)

  for (let i = 0; i < batches.length; i++) {
    if (i > 0) await sleep(OPENALEX_BATCH_DELAY_MS)
    const group = batches[i]

    const u = new URL('https://api.openalex.org/works')
    u.searchParams.set('filter', `doi:${group.join('|')}`)
    u.searchParams.set('per-page', String(OPENALEX_BATCH))
    u.searchParams.set('select', 'id,doi,title,publication_year,abstract_inverted_index')
    if (opts.mailto) u.searchParams.set('mailto', opts.mailto)

    const r = await getJson(u.toString(), opts)
    if (!r.ok) {
      for (const d of group) out.set(d, unreachable(d, r.error))
      continue
    }

    const results = (r.body as { results?: unknown }).results
    const rows = Array.isArray(results) ? (results as Array<Record<string, unknown>>) : []

    const byDoi = new Map<string, Record<string, unknown>>()
    for (const w of rows) {
      const d = text(w.doi) ? normalizeDoi(w.doi as string) : null
      if (d && !byDoi.has(d)) byDoi.set(d, w)
    }

    for (const d of group) {
      const w = byDoi.get(d)
      if (!w) {
        out.set(d, absent(d))
        continue
      }
      const title = text(w.title)
      const abs = usable(reconstructAbstract(w.abstract_inverted_index))
      out.set(d, abs ? found(d, abs, 'openalex', title) : absent(d, title))
    }
  }

  return out
}

// -------------------------------------------------------------- crossref

/**
 * One DOI, one request. Crossref has no keyed multi-DOI read — `filter=doi:a,…`
 * on `/works` is comma-AND'd and paginates — so batching it would mean adopting
 * a scored search in place of an identifier lookup.
 */
export async function crossrefAbstract(
  doi: string,
  opts: FetchOptions = {}
): Promise<AbstractResult> {
  const d = text(doi) ? normalizeDoi(doi) : null
  if (!d) return nothingToAskWith()

  const u = new URL(`https://api.crossref.org/works/${encodeURIComponent(d)}`)
  if (opts.mailto) u.searchParams.set('mailto', opts.mailto)

  const r = await getJson(u.toString(), opts)
  if (!r.ok) return unreachable(d, r.error)

  const msg = (r.body as { message?: Record<string, unknown> }).message
  if (!msg) return unreachable(d, 'reply had no message')

  const titles = Array.isArray(msg.title) ? (msg.title as unknown[]) : []
  const title = text(titles[0])
  const abs = usable(unwrapJats(typeof msg.abstract === 'string' ? msg.abstract : null))
  return abs ? found(d, abs, 'crossref', title) : absent(d, title)
}

// ------------------------------------------- the bibliographic gate

/**
 * The longest bibliography line worth sending. Crossref's matcher reads the
 * whole string; past the title, authors, journal and coordinate there is only
 * a DOI URL and a publisher note left to send, and a request whose length is
 * set by how verbose a depositor's style guide is is a request that fails on
 * URL length for reasons nothing about the reference explains.
 */
const MAX_BIBLIOGRAPHIC_QUERY_CHARS = 500

export interface BibliographicQuery {
  /**
   * The bibliography entry AS PRINTED. Unlike a title search, sending the whole
   * line is the point: Crossref's reference matcher is built for exactly this
   * string, and the answer is checked against something printed in the same
   * string rather than against the matcher's own opinion of the fit.
   */
  rawBibText: string
  /**
   * The title the bibliography parser read off this same line, when it read
   * one. It is the VERIFIER for a line that prints no volume and page.
   *
   * Nothing new is parsed here: this is the value already stored on the
   * reference row, passed in so the check can be made against what the paper
   * printed rather than against the matcher's confidence.
   */
  guessedTitle?: string | null
}

/**
 * volume and first page as the BIBLIOGRAPHY PRINTED THEM.
 *
 * "108:6823-6827" and "34, 938-945" are the same fact in two house styles, and
 * both dash conventions and both en/em dashes appear in real text layers. What
 * makes this parse safe to verify against is that it is read out of the
 * reference itself: nothing about the answer influences what we are comparing
 * it to, so there is no way to widen the rule until a match appears.
 */
export function printedCoordinate(
  rawBibText: string
): { volume: string; firstPage: string } | null {
  const s = text(rawBibText)
  if (!s) return null
  const m = /\b(\d{1,4})\s*[:,]\s*(\d{1,6})\s*[-–—]\s*\d{1,6}/.exec(s.replace(/\s+/g, ' '))
  return m ? { volume: m[1], firstPage: m[2] } : null
}

/**
 * The identity of the paper a reference names, for deciding which references
 * are asking the SAME question. Null when the reference cannot be reused.
 *
 * THE COORDINATE IS THE VERIFIER, AND ALMOST THE IDENTITY. `bibliographicMatch`
 * accepts an answer when the volume and first page it returns equal the ones the
 * line printed, so the coordinate is already the thing that says which paper
 * this is — within one journal. Across journals it is not: volume 66 page 5866
 * is two different papers in this corpus, and a cache keyed on the coordinate
 * alone would serve the first one's DOI to the second. That is attaching an
 * identifier to a paper that does not have it.
 *
 * SO THE TITLE QUALIFIES IT. `guessedTitle` is what the bibliography parser
 * already read off the same line — nothing new is parsed here and no similarity
 * is computed. Folding case, accents and punctuation absorbs the ways one text
 * layer differs from another for the same title; what survives the fold is
 * either the same string or a different one, which is the only kind of
 * comparison this subsystem makes.
 *
 * NULL RATHER THAN A WEAKER KEY when either half is missing. A reference with no
 * coordinate has no question to ask at all, and one with no title cannot be told
 * apart from its coordinate-mates. Both must ask for themselves; falling back to
 * the bare coordinate is exactly the collision above.
 */
/**
 * A title reduced to what survives being printed twice.
 *
 * Case, accents and punctuation are the ways one text layer differs from
 * another for the same title — "How protein stability and new functions trade
 * off" against Crossref's "How Protein Stability and New Functions Trade Off"
 * is one paper. What survives the fold is either the same string or a different
 * one, which is the only kind of comparison this subsystem makes: no similarity
 * score, no threshold, no "close enough".
 */
/**
 * A title with the trailing venue, publisher or preprint note cut off.
 *
 * A bibliography prints more on the title's line than the title: "Enzymatic
 * Reaction Mechanisms; Oxford University Press: New York, 2007", "…by ensemble
 * refinement. eLife", "…catalytic motif scaffolding. Preprint at bioRxiv…".
 * None of that is the title, and none of it appears in the index's record, so
 * comparing the whole string would refuse a correct answer.
 *
 * Cut at the first `;` or ` — ` or a `. ` that starts a new capitalised or
 * bracketed segment. A `. ` INSIDE a title ("Physical organic chemistry of
 * benzisoxazoles. IV. Origins…") keeps its tail, because a series numeral is
 * exactly the thing that must survive to be compared: dropping it is how one
 * part of a series answers for another.
 */
export function titleHead(title: string | null): string | null {
  const t = text(title)
  if (!t) return null
  const cut = t.search(/\s*(?:;|\s—\s|\.\s+(?:Preprint\b|In:|[A-Z][a-z]+\s+(?:University|Press)\b))/)
  const head = cut > 0 ? t.slice(0, cut) : t
  return text(head) ?? null
}

export function foldTitle(title: string | null): string | null {
  const folded = text(title)
    ?.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
  return folded && folded.length > 0 ? folded : null
}

export function askKeyFor(rawBibText: string, guessedTitle: string | null): string | null {
  // THE SAME HEAD THE GATE COMPARES. A key built from a different string than
  // the verifier uses is a second, weaker rule: the cache would serve an answer
  // the gate itself would have refused.
  const folded = foldTitle(titleHead(guessedTitle))
  if (!folded) return null
  const c = printedCoordinate(rawBibText)
  // NO COORDINATE, SO THE TITLE IS THE WHOLE KEY — and only when it is long
  // enough to have verified the answer in the first place. `bibliographicMatch`
  // now asks for these lines, and without a key here every bibliography naming
  // the same book would ask again for an answer another already holds.
  //
  // NOT TRUNCATED. The coordinate branch below can bound its title because the
  // volume and first page carry the identity and the title only qualifies them;
  // here the title IS the identity, and two works whose titles agree for sixty
  // characters — "…part one: the wild type" against "…part two: the R23K
  // variant" — would share a key and one would be served the other's abstract
  // without the gate ever running.
  if (!c) {
    return folded.length >= MIN_VERIFIABLE_TITLE_CHARS ? `title|${folded}` : null
  }
  // Bounded so one runaway title cannot make a key that will not index; 60 folded
  // characters is well past where two real titles still agree.
  return `${c.volume}:${c.firstPage}|${folded.slice(0, 60)}`
}

/** "6823-6827" -> "6823". A single page is already its own first page. */
function firstPageOf(page: unknown): string | null {
  const p = text(page)
  if (!p) return null
  const head = p.split(/[-–—]/)[0]?.trim()
  return head && head.length > 0 ? head : null
}

/**
 * Does the page the bibliography printed fall INSIDE the range the index
 * returned?
 *
 * A citation does not always print an article's first page. "Enzyme mechanisms,
 * models, and mimics", cited at 35:707, is the record Crossref pages 706-724 —
 * the same article, cited at the page the passage being referred to is on. An
 * exact first-page comparison called that a different paper and threw away an
 * abstract the index was holding.
 *
 * CONTAINMENT IS STILL A COORDINATE CHECK, not a loosening into similarity. The
 * volume must match exactly, as before, and the page must land within an
 * interval the record itself printed — "707 is inside 706-724" is as checkable
 * as "707 equals 707", and a wrong paper has to match the volume AND straddle
 * the page to pass. An open-ended or reversed range is refused rather than
 * guessed at.
 */
function pageWithinRange(printedPage: string, page: unknown): boolean {
  const p = text(page)
  if (!p) return false
  const parts = p.split(/[-–—]/).map((x) => x.trim())
  if (parts.length !== 2) return false
  const lo = Number.parseInt(parts[0], 10)
  const hi = Number.parseInt(parts[1], 10)
  const want = Number.parseInt(printedPage, 10)
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !Number.isFinite(want)) return false
  // Elsevier prints "88e-88" and similar; a range that does not ascend is not a
  // range this can reason about.
  if (hi < lo) return false
  return want >= lo && want <= hi
}

/**
 * An abstract for a reference that has no DOI, verified on the coordinate the
 * bibliography printed.
 *
 * A BIBLIOGRAPHY PRINTS A COORDINATE, AND THAT IS WHAT MAKES THIS CHECKABLE.
 * "Proc Natl Acad Sci USA 108:6823-6827" names volume 108, first page 6823. We
 * hand the whole printed line to Crossref's own reference matcher and compare
 * the volume and first page it returns against the two numbers the reference
 * already printed. They are equal or they are not. There is no threshold, no
 * window, no weighting — nothing that can be nudged until a stubborn example
 * passes, which is the failure the similarity gate this replaces was built
 * entirely out of.
 *
 * AN ABSENT VOLUME IS NOT A DISAGREEING VOLUME. Book chapters — Methods in
 * Enzymology, a Rosetta chapter in a Springer volume — are deposited with no
 * volume at all while the page range matches exactly. Treating null as a
 * mismatch throws away a whole publication type on the strength of a field the
 * publisher never filled in. A volume that came back and DISAGREES is a
 * different fact and is a rejection: the same distinction `ExternalReferenceResult`
 * draws between "the index answered and holds nothing" and "the index did not
 * answer", one level finer.
 *
 * A REFERENCE THAT PRINTS NO COORDINATE IS NEVER ASKED. Books, theses, "(in
 * press)" and "(submitted)" — about one entry in ten — carry nothing that could
 * falsify an answer, so any candidate would be accepted on the matcher's own
 * confidence in itself. `nothing-to-ask-with` says exactly that: there WAS no
 * question, so no socket opens.
 *
 * CROSSREF'S `score` IS READ FOR NOTHING. It is an opaque relevance number that
 * every reply carries, always non-zero, comparable to nothing — precisely the
 * kind of dial this rewrite exists to remove. It is not requested for use; it
 * is not consulted.
 *
 * A MATCH NEVER WRITES BACK A DOI TO THE REFERENCE. The DOI is returned so the
 * abstract can be fetched and so the row can record what was fetched against,
 * and the caller stores it on `reference_abstract` as provenance only. The
 * reference's identity is not established here, and the worst case of this path
 * must remain a wrong paragraph rather than a wrong identity.
 */
export async function bibliographicMatch(
  query: BibliographicQuery,
  opts: FetchOptions = {}
): Promise<AbstractResult> {
  const line = text(query.rawBibText)?.replace(/\s+/g, ' ').trim() ?? null
  const printed = line ? printedCoordinate(line) : null
  // The TITLE is the second verifier, and it is what lets this ask at all for a
  // line that prints no volume and page. 250 of this corpus's 308 unasked
  // references are complete, well-formed citations that simply name a book, a
  // piece of software or a pre-1990 paper whose entry carries no page range —
  // and the coordinate gate refused to open a socket for any of them, under an
  // outcome named `nothing-to-ask-with` that was untrue of them.
  //
  // A SHORT TITLE IS NOT A VERIFIER. Crossref always returns something: asked
  // about "Gaussian 03, revision C.02" it answers "Raman Spectroscopy of
  // Siderite with q-Gaussian…", and asked about "Numerical Recipes in C" it
  // answers "Numerical Recipes Book (PASCAL)". Both are confident, both are the
  // wrong paper, and a fold shorter than this would start matching them.
  const printedTitle = foldTitle(titleHead(query.guessedTitle ?? null))
  const verifiableTitle = printedTitle && printedTitle.length >= MIN_VERIFIABLE_TITLE_CHARS
    ? printedTitle
    : null
  if (!line || (!printed && !verifiableTitle)) {
    // No socket opens. Whatever came back could not be checked against
    // anything, so the request would buy a candidate we would have to refuse.
    return nothingToAskWith()
  }

  const u = new URL('https://api.crossref.org/works')
  u.searchParams.set('query.bibliographic', line.slice(0, MAX_BIBLIOGRAPHIC_QUERY_CHARS))
  u.searchParams.set('rows', '1')
  u.searchParams.set('select', 'DOI,title,volume,page,container-title,abstract')
  if (opts.mailto) u.searchParams.set('mailto', opts.mailto)

  const r = await getJson(u.toString(), opts)
  if (!r.ok) return unreachable(null, r.error)

  const items = (r.body as { message?: { items?: unknown } }).message?.items
  const item = Array.isArray(items) ? (items[0] as Record<string, unknown> | undefined) : undefined
  if (!item) return absent(null)

  const titles = Array.isArray(item.title) ? (item.title as unknown[]) : []
  const matchedTitle = text(titles[0])

  // WHICHEVER THE LINE PRINTED, and the coordinate wins when both exist: it is
  // the stronger evidence, because a volume and a first page are two
  // independent numbers a wrong paper has to match by accident.
  if (printed) {
    const gotVolume = item.volume != null ? text(String(item.volume)) : null
    const gotFirstPage = firstPageOf(item.page)
    // The printed page is either this record's first page or a page inside it.
    // Both are the coordinate agreeing; only a page outside the record's own
    // range says the line is naming something else.
    const pageAgrees =
      gotFirstPage === printed.firstPage || pageWithinRange(printed.firstPage, item.page)
    if (!pageAgrees) return ambiguous()
    if (gotVolume !== null && gotVolume !== printed.volume) return ambiguous()
  } else {
    // EQUALITY AFTER FOLDING, never a similarity score and never a prefix.
    //
    // A PREFIX IS NOT AN IDENTITY, and the counter-example is in this corpus:
    // a line printing "On the theory of oxidation-reduction reactions involving
    // electron transfer" is a prefix of Marcus Part I, Part II and Part III
    // alike, because folding strips the punctuation around the numeral and
    // leaves a bare "i", "ii", "iii" hanging off the end. Which part came back
    // would be decided by Crossref's ranking rather than by anything the
    // bibliography printed — a different paper, silently. The same hole admits
    // a book against a chapter of it, and a paper against its own erratum.
    //
    // What the bibliography prints AFTER the title is not part of the title,
    // so it is cut before comparing rather than tolerated afterwards: a venue,
    // a publisher, or a "Preprint at bioRxiv…" tail is punctuation-separated
    // from the title and identifies the same work. `titleHead` takes only the
    // first such segment, so the comparison is still an equality between two
    // titles and not a prefix between a title and whatever follows it.
    const gotTitle = foldTitle(titleHead(matchedTitle))
    if (!gotTitle || gotTitle !== verifiableTitle) return ambiguous()
  }

  const doi = text(item.DOI) ? normalizeDoi(item.DOI as string) : null
  if (!doi) return absent(null, matchedTitle)

  const abs = usable(unwrapJats(typeof item.abstract === 'string' ? item.abstract : null))
  return abs ? found(doi, abs, 'crossref', matchedTitle) : absent(doi, matchedTitle)
}
