// The lexical leg of hybrid retrieval: BM25 over `chunk_fts` (migration v75's
// external-content FTS5 index of chunk.text).
//
// The user's string never reaches FTS5's parser as syntax. It is segmented into
// word tokens (`Intl.Segmenter`, the same engine that anchors evidence spans),
// each token is quote-doubled and bound as ONE parameter — so `NEAR(`, column
// filters, comment markers and quotes-in-quotes all degrade into literal search
// terms or vanish, and the worst a hostile input can do is match nothing.
//
// Terms are ORed for recall: BM25's term weighting orders the union, and the
// rerank stage downstream supplies precision. Scoring follows bm25()'s own
// direction — SMALLER is the better match — so the answer is ORDER BY score
// ASC, and the score returned is the value that ordered it. bm25 ties are
// common (OR arms with no overlap score alike) and SQLite's order over tied
// rows is unspecified, so the chunk id breaks them: RRF reads a rank off this
// list's position, and that rank list must be a total order.
import type { DB } from '../connection'

/**
 * The longest OR union one query may build. A pasted document measures ~115 s
 * as ~117k OR terms — a hang, not a slowdown — while far fewer terms than this
 * stop moving the top of a BM25 ranking; everything after is noise the cap
 * removes for free.
 */
export const MAX_MATCH_TOKENS = 64

/**
 * The longest one term may be, measured in UTF-16 code units (`segment.length`):
 * a word of astral-script characters counts two units per character, so 33
 * non-BMP letters drop at this bound — one OR arm lost, and the dense leg
 * carries those queries. The term cap above counts SEGMENTS, and a
 * whitespace-free paste (a base64 blob, a hash, a minified line) is ONE
 * word-like segment however long — it would sail through that cap as a single
 * quoted phrase, and the unicode61 tokenizer would explode it into every query
 * token it holds, rebuilding the 115 s hang this module exists to prevent.
 * Scientific tokens are short, so anything longer than this is the same noise
 * the term cap removes for free — dropped whole, never truncated: a cut token
 * is no longer the word it came from, and FTS5 matches whole tokens only
 * (prefix search needs an explicit *), so a cut arm matches nothing or the
 * wrong word.
 */
export const MAX_TOKEN_CHARS = 64

/**
 * The user's string as an FTS5 MATCH expression, or null when no word token
 * survives (empty input, punctuation only). Null means "no lexical query ran",
 * not "no results" — callers report that absence, never paper over it.
 */
export function ftsMatchQuery(input: string): string | null {
  const seg = new Intl.Segmenter(undefined, { granularity: 'word' })
  const tokens: string[] = []
  const seen = new Set<string>()
  for (const { segment, isWordLike } of seg.segment(input)) {
    if (!isWordLike) continue
    // BEFORE the term cap, so the bound holds regardless of how the input
    // segments: the longest possible MATCH string is now capped on both axes.
    if (segment.length > MAX_TOKEN_CHARS) continue
    // An OR union gains nothing from a repeat — bm25() would sum a second
    // contribution for the same term and skew the order the fusion consumes —
    // so each distinct term appears once, first-occurrence order preserved.
    // The seen-set keys on the fold the index applies before stemming — and
    // that fold is LATIN-ONLY: unicode61 remove_diacritics 2 strips diacritics
    // from Latin characters, and touches no other script. 'Riverbank' and
    // 'riverbank' — or 'café' and 'cafe' — therefore collapse to one OR arm,
    // and the term the MATCH string keeps stays the first occurrence's bytes;
    // stripping marks from every script instead would fold tokens the index
    // keeps distinct (NFD reduces 'мой' — й is и plus a breve — onto 'мои''s
    // base) and silently drop the second one's arm, so outside Latin the key
    // is the plain lowercased token. The fold stops at the stem: the INDEXED
    // term is the porter stem of the folded token, which the seen-set cannot
    // compute, so two morphological variants of one stem ('activated',
    // 'activation') pass this set as distinct and still double-weight that
    // stem in bm25(). The dedup holds for repeats that fold to the same token;
    // removing the stem overlap would take a stemmer here.
    //
    // The index's case fold is Unicode's SIMPLE fold and JS's toLowerCase is
    // the default conversion, so two Latin codepoints need settling by hand:
    // U+017F (long s) carries a simple fold to 's' that toLowerCase leaves
    // alone and NFD cannot produce, so it is mapped here or 'ſ' and 's' would
    // pass the seen-set as distinct and double-weight one indexed term; U+0130
    // (İ) needs no mapping — the NFD mark-strip folds it onto 'i', the same
    // fold the index's remove_diacritics applies to the precomposed character.
    // Both directions are pinned against the live index in lexical.test.ts,
    // not against this reasoning.
    const key = !/[^\P{L}\p{Script=Latin}]/u.test(segment)
      ? segment
          .normalize('NFD')
          .replace(/\p{M}/gu, '')
          .toLowerCase()
          .replaceAll('\u017f', 's')
      : segment.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    tokens.push(segment.replaceAll('"', '""'))
    if (tokens.length === MAX_MATCH_TOKENS) break
  }
  return tokens.length ? tokens.map((t) => `"${t}"`).join(' OR ') : null
}

export interface LexicalHit {
  chunkId: number
  /** bm25() score — SMALLER is the better match; the value the answer was ordered by. */
  score: number
}

/**
 * The set one lexical query searches. `spaceId` is REQUIRED, and it is the
 * same space the dense leg searches — the active one: a model swap RETIRES the
 * old space without deleting its chunks, and 'comparison' spaces persist by
 * design, so their rows stay in the chunk table and in this index, and a
 * space-free MATCH would answer with passages the fusion can never pair with
 * a dense hit. The narrowings compose with AND.
 */
export interface LexicalScope {
  spaceId: number
  projectId?: number
  workId?: number
}

/**
 * BM25-ranked chunks matching `query`, narrowed by the SAME scope semantics as
 * the dense leg (the named embedding space, project membership via
 * project_work, optionally one work — the narrowings compose with AND). The
 * MATCH expression is built here; a caller that already gated the leg with
 * `ftsMatchQuery` passes the built string to {@link searchLexicalMatched}
 * instead, so one search segments its query once.
 */
export function searchLexical(
  db: DB,
  query: string,
  scope: LexicalScope,
  limit: number
): LexicalHit[] {
  const match = ftsMatchQuery(query)
  return match === null ? [] : searchLexicalMatched(db, match, scope, limit)
}

/**
 * The BM25 query itself, over a MATCH expression ALREADY built by
 * {@link ftsMatchQuery} — same scope semantics, same answer, no second
 * segmentation of a query the caller has already gated.
 */
export function searchLexicalMatched(
  db: DB,
  match: string,
  scope: LexicalScope,
  limit: number
): LexicalHit[] {
  if (!match || limit <= 0) return []
  const args: Array<string | number> = []
  let join = ''
  if (scope.projectId !== undefined) {
    join = 'JOIN project_work pw ON pw.work_id = c.work_id AND pw.project_id = ?'
    args.push(scope.projectId)
  }
  args.push(match)
  let where = 'AND c.space_id = ?'
  args.push(scope.spaceId)
  if (scope.workId !== undefined) {
    where += ' AND c.work_id = ?'
    args.push(scope.workId)
  }
  args.push(limit)
  return db
    .prepare(
      `SELECT c.id AS chunkId, bm25(chunk_fts) AS score
         FROM chunk_fts
         JOIN chunk c ON c.id = chunk_fts.rowid
         ${join}
        WHERE chunk_fts MATCH ? ${where}
        ORDER BY score, c.id ASC
        LIMIT ?`
    )
    .all(...args) as LexicalHit[]
}
