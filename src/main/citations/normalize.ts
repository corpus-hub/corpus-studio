// Text normalization shared by the reference parser and the corpus matcher.
// Everything here is a pure function: identical input always yields identical
// output, which is what makes the citation parse reproducible and cacheable.

/**
 * Fold the typographic noise a PDF text layer introduces: ligatures, smart
 * quotes, the several dash characters journals use interchangeably, and
 * combining accents (Röthlisberger vs Ro¨thlisberger — pdfjs emits BOTH forms
 * across our corpus, so accent folding is not cosmetic, it decides matches).
 */
export function foldText(s: string): string {
  return (
    s
      // BEFORE NFKD. pdfjs often emits a diacritic as its own positioned run, so
      // "Röthlisberger" arrives as "Ro ¨ thlisberger". This must be repaired
      // first: NFKD expands a standalone U+00A8 into "space + combining
      // diaeresis", after which the letters are no longer adjacent and no
      // amount of later cleanup rejoins the word.
      .replace(/([A-Za-z])\s*[\u00a8\u02da\u02dc\u00b4\u0060\u02c6\u02dd\u00af]\s*([A-Za-z])/g, '$1$2')
      .normalize('NFKD')
      // strip combining marks left behind by NFKD (é -> e)
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[\u2010-\u2015\u2212]/g, '-')
      .replace(/[\u2018\u2019\u201b\u02bc]/g, "'")
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/\u00a0/g, ' ')
      .replace(/\ufb00/g, 'ff')
      .replace(/\ufb01/g, 'fi')
      .replace(/\ufb02/g, 'fl')
      .replace(/\ufb03/g, 'ffi')
      .replace(/\ufb04/g, 'ffl')
      // A ligature POSITIONED AS ITS OWN RUN, which is the same defect as the
      // standalone diacritic above and needs the same repair. pdfjs emits the
      // f-ligatures of some embedded fonts as separate text items, so
      // "Althoff" arrives as "Altho ff " and "Tawfik" as "Taw fi k" — 627
      // occurrences across this corpus, in 5 of its 20 papers.
      //
      // Not cosmetic. An author list is consumed unit by unit and a unit must
      // look like a name, so the list STOPS at the broken one: w10's entry 16
      // reported seven authors and gave "Altho ff , E. A., Zanghellini, A., …
      // Kemp Elimination Catalysts by" as the TITLE, which then scored 0.35
      // against the paper it names and left a resolvable reference unresolved
      // with its three in-text callouts hanging off an `unresolved_reference`
      // row.
      //
      // The ligature is glued BACKWARDS unconditionally and forwards only when
      // a letter follows, because the fragment it belongs to is always the one
      // BEFORE it — "Altho"+"ff" ends at a comma, "Taw"+"fi"+"k" continues.
      // Requiring a letter on both sides would leave every word-final case
      // broken, which is the one that cost a citation.
      //
      // `ff`, `fi` and `fl` are not English words, so a standalone run of them
      // between a letter and a space is a broken ligature and nothing else.
      // Where the preceding space was REAL the join is too eager ("the fi rst"
      // becomes "thefirst"), and that is the accepted cost: this output is only
      // ever tokenised for comparison, so an over-joined token fails to match
      // where two would have matched — it can never invent an agreement.
      .replace(/([A-Za-z])\s+(ffi|ffl|ff|fi|fl)(?![A-Za-z])\s*/g, '$1$2')
      // any diacritic that survived on its own is noise, not payload
      .replace(/[\u00a8\u02da\u02dc\u00b4\u0060\u02c6\u02dd\u00af]/g, '')
  )
}

/** Lowercase, fold, collapse to single-spaced alphanumerics. */
export function normalizeLoose(s: string): string {
  return foldText(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Tokens of `normalizeLoose`, minus tokens too short/common to discriminate. */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into',
  'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'to', 'with', 'via',
  'we', 'this', 'these', 'their', 'can', 'not', 'but', 'has', 'have'
])

export function contentTokens(s: string): string[] {
  return normalizeLoose(s)
    .split(' ')
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
}

/**
 * Words whose hyphen is REAL, not a syllable break introduced by wrapping.
 *
 * A line-final hyphen is ambiguous: "biomo-\nlecular" is one word split by the
 * typesetter, but "ring-\nopening", "X-\nray" and "off-\nthe-shelf" are printed
 * with that hyphen. Dropping it unconditionally produced "ringopening",
 * "Xray" and "physicochemical" in real titles, which then fail to match the
 * same paper cited elsewhere without the wrap.
 *
 * The second element is checked as a whole word, so this stays a small, honest
 * list of compounds this literature actually uses rather than an attempt to
 * model English hyphenation.
 */
const HYPHEN_KEEP_SECOND = new Set([
  'aided', 'assisted', 'based', 'bond', 'bonded', 'bonding', 'catalysed',
  'catalyzed', 'chemical', 'coupled', 'dependent', 'derived', 'designed',
  'directed', 'driven', 'energy', 'guided', 'independent', 'induced', 'like',
  'made', 'mediated', 'opening', 'promoted', 'ray', 'related', 'shelf',
  'specific', 'state', 'the', 'transfer', 'type'
])

/** Words whose ending marks the first half of a real compound. */
const HYPHEN_KEEP_FIRST = new Set([
  'computer', 'cross', 'ground', 'high', 'ligand', 'low', 'multi', 'non',
  'off', 'on', 'physico', 'pre', 'post', 'ring', 'self', 'semi', 'small',
  'solid', 'structure', 'sub', 'transition', 'well', 'x'
])

/**
 * Rejoin the hard line wrapping of a PDF text layer.
 *
 * A hyphen at end-of-line is dropped when it is syllabic and KEPT when the
 * compound is genuinely hyphenated; any other newline becomes a space. Doing
 * this BEFORE entry splitting would destroy the line-start anchors the splitter
 * needs, so callers apply it per-entry, after splitting.
 */
export function unwrapLines(s: string): string {
  return s
    // A DOI that wraps after one of its own periods must close up with NO
    // space: "10.1101/2024.08.02.\n606416" otherwise became the DOI
    // "10.1101/2024.08.02", which resolves to nothing at all.
    .replace(/(10\.\d{4,9}\/[^\s]*\.)\s*\n\s*(\d[^\s]*)/g, '$1$2')
    .replace(/([A-Za-z]+)-\s*\n\s*([a-z]+)/g, (_whole, a: string, b: string) => {
      const keep =
        HYPHEN_KEEP_SECOND.has(b.toLowerCase()) || HYPHEN_KEEP_FIRST.has(a.toLowerCase())
      return keep ? `${a}-${b}` : `${a}${b}`
    })
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** Canonical DOI form for equality tests (DOIs are case-insensitive). */
export function normalizeDoi(doi: string): string {
  return doi
    .trim()
    .replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .replace(/[.,;)\]]+$/, '')
    .toLowerCase()
}

/**
 * DOIs as printed in a bibliography. Deliberately conservative on the trailing
 * boundary: a DOI may legally contain almost anything, but a sentence-final
 * period or a closing bracket is punctuation, not payload.
 */
export const DOI_RE = /\b10\.\d{4,9}\/[^\s"<>]*[^\s".,;:)\]}<>]/g

export function findDois(s: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  DOI_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = DOI_RE.exec(s))) {
    const d = normalizeDoi(m[0])
    if (!seen.has(d)) {
      seen.add(d)
      out.push(d)
    }
  }
  return out
}

/**
 * The identity of a CITED-BUT-ABSENT paper, as a string key.
 *
 * A paper with no work row has no id, yet the same paper is parsed out of every
 * bibliography that names it — one `unresolved_reference` row per CITING paper.
 * Treating those rows as distinct papers is what let one paper be selected, and
 * retrieved, several times over. This key is what collapses them.
 *
 * The ladder is strict-to-weak and stops at the first identifier that actually
 * identifies:
 *   doi   — an exact global identifier; nothing else can improve on it.
 *   title — normalized to survive the typography of a PDF text layer. Year is
 *           deliberately NOT part of the key: bibliographies disagree about
 *           preprint vs issue year, and half the entries print no year at all,
 *           so folding it in would split a paper from itself far more often
 *           than it would separate two same-titled papers.
 *   row   — an entry naming NEITHER a doi nor a title (an "ibid.", or a
 *           venue-only entry) identifies no paper at all, so it stands alone.
 *           Merging those on venue+year would fuse two unrelated papers from
 *           the same journal and year into one card.
 */
export function referenceIdentityKey(ref: {
  id: number
  doi?: string | null
  title?: string | null
}): string {
  const doi = ref.doi?.trim()
  if (doi) return `doi:${normalizeDoi(doi)}`
  const title = ref.title ? normalizeLoose(ref.title) : ''
  if (title.length >= 8) return `title:${title}`
  return `row:${ref.id}`
}

/**
 * Journal-name similarity that understands ABBREVIATION.
 *
 * Bibliographies print "J. Mol. Biol.", "J. Mol. Bio.", "Journal of Molecular
 * Biology" and "JMB" for the same venue. Token equality scores all of those at
 * zero, yet venue is the decisive signal for citation styles that print no
 * title (ACS, Angewandte, Nature), where authors+year alone cannot separate two
 * papers by the same group in the same year.
 *
 * Rule: every content token of the SHORTER (more abbreviated) name must find a
 * token in the longer name that it prefixes. Score = fraction that do. Prefix
 * matching is exactly the relation abbreviation creates ("mol" -> "molecular"),
 * and it is asymmetric-safe because we always abbreviate the shorter side.
 */
export function venueSimilarity(a: string, b: string): number {
  const ta = normalizeLoose(a).split(' ').filter((t) => t.length >= 1 && !['of', 'the', 'and', 'a', 'in'].includes(t))
  const tb = normalizeLoose(b).split(' ').filter((t) => t.length >= 1 && !['of', 'the', 'and', 'a', 'in'].includes(t))
  if (!ta.length || !tb.length) return 0
  // Score BOTH directions and take the smaller. A one-sided score treats
  // "Proteins" as a perfect match for "Protein Science" — the single token
  // prefixes the first token and there is nothing left to check — which is how
  // an unrelated Proteins paper gets matched to a Protein Science one. Scoring
  // the reverse direction too costs the missing "science" token and drops that
  // pair to 0.5, while genuine abbreviations ("J Mol Biol" vs "Journal of
  // Molecular Biology") stay at 1.0 in both directions.
  const cover = (from: string[], to: string[]): number => {
    let hit = 0
    for (const s of from) if (to.some((l) => l.startsWith(s) || s.startsWith(l))) hit++
    return hit / from.length
  }
  return Math.min(cover(ta, tb), cover(tb, ta))
}

/**
 * Surname equality that tolerates ONE substituted character.
 *
 * When a PDF's embedded font has a damaged cmap, pdfjs decodes the odd glyph to
 * the wrong codepoint: the Angewandte review in this corpus prints
 * "Röthlisberger" but its text layer says "Rcthlisberger" — the o-umlaut maps to
 * a `c`. Exact comparison silently zeroes the author signal for the single most
 * cited author in the corpus, and for a titleless (ACS/Angewandte) entry the
 * author IS the discriminator, so the citation becomes unrecoverable.
 *
 * The tolerance is deliberately narrow — same length, exactly one differing
 * character, and only for names of >=8 characters — so that a one-character
 * coincidence between two genuinely different surnames stays implausible.
 */
export function surnamesEqual(a: string, b: string): boolean {
  if (a === b) return true
  if (a.length !== b.length || a.length < 8) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      diff++
      if (diff > 1) return false
    }
  }
  return diff === 1
}

/**
 * Surname extraction from an author blob.
 *
 * Bibliographies print names in at least four orders across our corpus
 * ("Wolfenden, R.", "R. Wolfenden", "Wolfenden R", "Khersonsky O,"), so rather
 * than parse the order we take every capitalised word of >=3 letters that is
 * not an initial group. Over-collecting is safe: surnames are only ever used as
 * a set-overlap signal, never as a sole discriminator.
 */
export function extractSurnames(s: string): string[] {
  const folded = foldText(s)
  const out: string[] = []
  const seen = new Set<string>()
  const re = /\b([A-Z][a-z]{2,}(?:'[A-Za-z]+)?(?:\s+[A-Z][a-z]{2,})?)\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(folded))) {
    const w = m[1].toLowerCase()
    if (!seen.has(w)) {
      seen.add(w)
      out.push(w)
    }
  }
  return out
}
