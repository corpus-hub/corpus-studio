// MAY THIS RECORD BE ATTACHED TO THIS FILE?
//
// All of the wrong-identity risk in file import is concentrated here, so the
// rule is written once and every caller goes through it.
//
// THE STANDING RULE: attaching a DOI that is not this paper's is the worst bug
// this app can produce. It is worse than attaching nothing, because nothing is
// visibly missing and asks to be fixed, while a wrong DOI is carried silently
// into the citation graph, the exports, the Zotero push and every downstream
// analysis, all of which then agree with each other about the wrong paper. So
// every ambiguity here resolves to REFUSAL, and refusing is an ordinary outcome
// rather than a failure.
//
// AN INDEX ALWAYS ANSWERS. Crossref asked about "Gaussian 03, revision C.02"
// replies "Raman Spectroscopy of Siderite with q-Gaussian…" — confident, and
// the wrong paper. A search result is therefore a CANDIDATE and never an
// identification; what makes it one is agreement with what the file already
// told us.

import type { WebSearchRecord } from '../search/types'
import { titleHead } from '../references/external/abstracts'

/**
 * Bump when the rule below changes.
 *
 * Stamped into the stage fingerprint, so tightening the gate reopens papers
 * admitted by a looser vintage instead of leaving them standing on evidence
 * this build would refuse.
 */
export const IDENTITY_RULE_VERSION = 2

/**
 * SUPPORTING INFORMATION IS NOT THE PAPER, and it is deposited under the
 * paper's OWN TITLE — so it passes every word test here perfectly, and a search
 * ranks it first as readily as the article. Observed: a filename naming Otten
 * 2018 resolved to `10.1021/acs.biochem.8b00274.s001`, the supplement, whose
 * title is the article's title.
 *
 * Publishers mark it in the DOI suffix rather than in the metadata: ACS appends
 * `.s001`, Wiley `-sup-0001`, others `.supplement`/`.supp`. Matching the SHAPE
 * of that suffix is what catches it without a per-publisher list — and a paper
 * whose real DOI happens to look like one is refused rather than misattached,
 * which is the right way round.
 */
const SUPPLEMENT_DOI_RE = /(?:[.\-_](?:s|si|sd|supp?(?:lement(?:ary)?)?|sup)[-_]?\d{1,4}|[.\-_]supp?(?:lement(?:ary)?)?)$/i

/**
 * A notice is not the paper. An erratum shares its title stem, authors, venue,
 * volume and first page with the article it corrects, so every other test here
 * passes it. Mirrors the reference path's rule.
 */
const NOTICE_TITLE_RE =
  /^\s*(?:(?:publisher'?s?\s+)?(?:erratum|errata|corrigendum|corrigenda|correction)|retraction|retracted(?:\s+article)?|addendum|addenda|publisher'?s?\s+note|editorial\s+expression\s+of\s+concern|withdrawn)\s*(?:$|[:.\u2014]|\s+(?:to|for|of\s+the\s+article)\b)/i

export type IdentityVerdict =
  | { accepted: true; record: WebSearchRecord; why: string }
  | { accepted: false; why: string }

const refuse = (why: string): IdentityVerdict => ({ accepted: false, why })

/** Content words of a string, folded, with the short ones dropped. */
function words(s: string): string[] {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4)
}

/**
 * Agreement between a record's title and a filename, 0..1.
 *
 * MEASURED OVER WHICHEVER IS SHORTER, and that asymmetry is the whole design.
 * Filenames come in two shapes and a single direction is wrong for one of them:
 *
 *  - a TRUNCATED TITLE (`… - Extending the toolbox for enzymatic carboligati`)
 *    holds most of the record's words but stops early, so measuring against the
 *    filename's words is right and measuring against the record's punishes the
 *    truncation this exists to serve;
 *  - a KEYWORD NAME (`Rothlisberger2008_Nature_KE07_design`) holds four words
 *    of a fifteen-word title, so measuring against the record's words refuses
 *    every correctly-found paper, while measuring against the filename's asks
 *    the answerable question: is what this name says actually in that title?
 *
 * Taking the better of the two directions covers both without a rule that
 * inspects the filename and guesses which kind it is — and a genuinely
 * different paper scores low in BOTH directions, which is what keeps it safe.
 */
function overlap(recordTitle: string, fileName: string): number {
  const a = new Set(words(recordTitle))
  const b = new Set(words(fileName))
  if (a.size === 0 || b.size === 0) return 0
  let hit = 0
  for (const w of a) if (b.has(w)) hit++
  return Math.max(hit / a.size, hit / b.size)
}

/**
 * Enough agreement to be this paper rather than a neighbouring one.
 *
 * Not 1.0: a truncated filename cannot contain a whole title, and demanding it
 * would refuse every Zotero export. Not low: a paper and its own companion
 * paper share most of their words. Held against a real 121-file library, the
 * correct answers sit above this and the wrong ones fall well below.
 */
const MIN_TITLE_OVERLAP = 0.6

/**
 * Below this many shared words a ratio is not evidence.
 *
 * A two-word filename matching a two-word title is 100% agreement and means
 * nothing — this is what stops a short name being "confirmed" by a short title.
 */
const MIN_SHARED_WORDS = 3

/** Content words the two strings have in common. */
function sharedWords(recordTitle: string, fileName: string): number {
  const b = new Set(words(fileName))
  let hit = 0
  for (const w of new Set(words(recordTitle))) if (b.has(w)) hit++
  return hit
}

/** With this few words in common, a share is not evidence of anything. */
const MIN_TITLE_WORDS = 4

/**
 * Does this record describe the file it was found for?
 *
 * `trusted` is for a record fetched BY AN IDENTIFIER the filename printed
 * literally. That is a much stronger start than a search hit — the file states
 * the DOI and an index confirmed a paper exists under it — so the title is
 * corroboration rather than the whole case, and a filename that carries a DOI
 * and nothing else (`10.1021_acscatal.9b01339.pdf`) is accepted on the DOI. A
 * SEARCH hit has no such backing and must earn its identity from the words.
 */
export function verifyIdentity(
  record: WebSearchRecord | null,
  fileName: string,
  opts: { trusted: boolean }
): IdentityVerdict {
  if (!record) return refuse('no index holds a record for what this file is named')
  const title = record.title ?? ''
  if (title.trim().length === 0) return refuse('the index returned a record with no title')

  // A notice shares everything with the article it corrects, so it passes every
  // other test here and must be named explicitly.
  if (NOTICE_TITLE_RE.test(title)) {
    return refuse(`that identifier names a correction or notice, not the article itself`)
  }
  // Likewise the supplement, which carries the article's own title.
  if (record.doi && SUPPLEMENT_DOI_RE.test(record.doi)) {
    return refuse(
      `${record.doi} is the supporting information for that paper, not the paper itself`
    )
  }

  const share = overlap(titleHead(title) ?? title, fileName)
  const titleWords = words(titleHead(title) ?? title).length

  if (opts.trusted) {
    // The filename printed this DOI. A disagreement is still worth reporting —
    // a DOI can be mistyped into a filename — but only when the name carried
    // enough words to disagree WITH. A pure-DOI filename has none, and refusing
    // it would refuse the clearest case there is.
    const nameWords = words(fileName).filter((w) => !/^\d+$/.test(w)).length
    if (nameWords >= MIN_TITLE_WORDS && titleWords >= MIN_TITLE_WORDS && share < 0.34) {
      return refuse(
        `the DOI in this filename belongs to "${title.slice(0, 60)}", which is not what the ` +
          'rest of the name says this file is'
      )
    }
    return { accepted: true, record, why: 'the DOI printed in the filename resolved to this paper' }
  }

  // A SEARCH HIT. Nothing but the words backs it.
  if (titleWords < MIN_TITLE_WORDS) {
    return refuse(
      `the index answered with a title too short (${titleWords} words) to tell one paper from another`
    )
  }
  const shared = sharedWords(titleHead(title) ?? title, fileName)
  if (share < MIN_TITLE_OVERLAP || shared < MIN_SHARED_WORDS) {
    return refuse(
      `the index answered with "${title.slice(0, 60)}", which shares too little with this ` +
        `file's name to be the same paper (${shared} word(s), ${Math.round(share * 100)}%)`
    )
  }
  return {
    accepted: true,
    record,
    why: `the filename carries ${Math.round(share * 100)}% of the words this paper is titled with`
  }
}

export { overlap as titleOverlapForTest }
