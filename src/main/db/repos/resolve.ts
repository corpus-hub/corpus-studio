// Naming a paper the caller already has a reference to: DOI, arXiv id, PMID, or
// a title.
//
// A different question from search. Search ranks guesses; this either identifies
// ONE work in this corpus or refuses. The refusal is the reason the module
// exists: the DOI-then-normalized-title fallback below was written three times
// inside `repositories.ts` (`resolveUnresolvedReference`, `upsertResolvedWork`),
// and every copy ends `candidates.find(...)` — silently taking the FIRST of
// however many titles normalised to the same string. For an importer that is a
// tolerable dedup heuristic. For a caller that is about to write an analysis
// against the returned id it is a wrong answer that looks like a right one, so
// this reports `ambiguous` and lets the caller choose.
//
// `identifier.work_id` is NULLABLE — a row may attach to a DOCUMENT only
// (`schema.ts:67-77`), and the DOI selects this consolidates are `SELECT work_id
// ... LIMIT 1`, which hand such a row back as `{id: null}` for the caller to use
// as a work id. The lookup here JOINs through `work` instead, so a
// document-scoped identifier cannot produce a candidate at all.

import type { DB } from '../connection'
import { foldForSearch } from '../connection'
import type { ResolveWorkDTO, WorkCandidateDTO } from '@shared/contract'
import { parseIdentifier } from '../../search/resolve'

/**
 * One candidate paper. Aliased from the contract DTO — the resolution crosses
 * IPC verbatim, so a second declaration of the same shape could only drift.
 */
export type WorkCandidate = WorkCandidateDTO

/** The result of naming a paper. Aliased, for the same reason. */
export type ResolveWorkResult = ResolveWorkDTO

const MAX_SUGGESTIONS = 5
const MAX_CANDIDATES = 10
/**
 * Longer than any real title or identifier; beyond this the input is something
 * else. EXPORTED so the IPC boundary bounds the string with the SAME number the
 * repository refuses on, rather than a second literal that can drift from it.
 */
export const MAX_WORK_REF = 500

const CANDIDATE_SELECT = /* sql */ `
  SELECT w.id AS work_id, w.title, w.publication_year AS year,
         (SELECT i.value FROM identifier i
           WHERE i.work_id = w.id AND i.scheme = 'doi'
           ORDER BY i.id ASC LIMIT 1) AS doi
    FROM work w
`

type RawCandidate = Omit<WorkCandidate, 'matched_by'>

function tag(rows: RawCandidate[], matched_by: WorkCandidate['matched_by']): WorkCandidate[] {
  return rows.map((r) => ({ ...r, matched_by }))
}

/**
 * An ambiguous result, with the truncation stated.
 *
 * `rows` is fetched one longer than the cap, and that extra row is the ONLY
 * evidence that more exist — discarding it silently would make "exactly ten
 * matches" and "at least eleven" indistinguishable to a caller trying to decide
 * whether narrowing the query could ever help.
 */
function ambiguous(
  rows: RawCandidate[],
  matched_by: WorkCandidate['matched_by']
): ResolveWorkResult {
  return {
    state: 'ambiguous',
    candidates: tag(rows.slice(0, MAX_CANDIDATES), matched_by),
    more: rows.length > MAX_CANDIDATES
  }
}

/**
 * Whether a string carries any letter or digit at all, after folding.
 *
 * The gate on the title path, and it is built on `foldForSearch` rather than on
 * `repositories.ts`'s `normalizeTitle`. That one is `replace(/[^a-z0-9]+/g,' ')`,
 * which DELETES every non-Latin script — so every CJK, Cyrillic or Greek title
 * normalises to the empty string, collides with every other one AND with an
 * empty input, and the `.find(...)` at the end of each existing copy then
 * returns an arbitrary paper. `foldForSearch` is NFD + mark-strip and is
 * Unicode-safe, and `\p{L}` counts a Han character as a letter.
 *
 * Only the GATE strips punctuation. The comparison itself is `search_fold` on
 * both sides, so the two sides always fold identically.
 */
function hasSearchableText(title: string): boolean {
  return /[\p{L}\p{N}]/u.test(foldForSearch(title))
}

/**
 * Resolve a reference to ONE work in this database.
 *
 * `kind` is a HINT, not a filter, and it exists because auto-detection is
 * genuinely ambiguous here: `parseIdentifier` claims any bare 5-9 digit string
 * as a PMID, and `toDoi` matches a DOI ANYWHERE inside a longer string — so a
 * title that happens to quote a DOI resolves as that DOI. A caller that knows it
 * is holding a title says so and gets the title path.
 */
export function resolveWorkRef(
  db: DB,
  ref: string,
  opts: { kind?: 'doi' | 'arxiv' | 'pmid' | 'title' | 'auto'; projectId?: number } = {}
): ResolveWorkResult {
  const raw = typeof ref === 'string' ? ref.trim() : ''
  if (raw.length === 0) return { state: 'invalid', reason: 'No DOI, identifier or title was given.' }
  if (raw.length > MAX_WORK_REF) {
    return { state: 'invalid', reason: `That reference is too long (${raw.length} characters).` }
  }

  const kind = opts.kind ?? 'auto'

  // ---- identifier ------------------------------------------------------
  // `ux_identifier_scheme_value` is UNIQUE(scheme, value) GLOBALLY, so an
  // identifier match can never be ambiguous: at most one row exists.
  if (kind !== 'title') {
    // An explicit `kind` selects the SCHEME; it does not mean the caller pasted
    // a bare value. `parseIdentifier` unwraps every form a user actually holds —
    // a doi.org link, an arXiv abs page, "PMID: 27096365" — and skipping it for
    // the explicit kinds made the hint strictly worse than `'auto'`: the same
    // pubmed URL resolved unhinted and failed when the caller correctly said
    // `'pmid'`. So it is always tried first, and the raw string is the fallback
    // for a value already bare.
    const detected = parseIdentifier(raw)
    const parsed =
      kind === 'auto'
        ? detected
        : { kind, value: detected?.kind === kind ? detected.value : raw }
    if (parsed) {
      const hit = db
        .prepare(
          CANDIDATE_SELECT +
            `JOIN identifier i2 ON i2.work_id = w.id
              WHERE i2.scheme = ? AND i2.value = ?
              LIMIT 1`
        )
        .get(parsed.kind, parsed.value) as RawCandidate | undefined
      if (hit) {
        const matched_by = parsed.kind === 'doi' ? 'doi' : 'identifier'
        const candidate: WorkCandidate = { ...hit, matched_by }
        return { state: 'resolved', work_id: hit.work_id, matched_by, candidate }
      }
      // An identifier that names no work in this corpus is NOT a title. Falling
      // through would search for "10.1038/nature17946" as prose and either find
      // nothing or, worse, match a paper that merely cites it.
      //
      // Only a DOI is claimed this confidently under `'auto'`. `parseIdentifier`
      // reads any bare 5-9 digit string as a PMID, so a paper titled with a
      // number would otherwise be unreachable by title — under `'auto'` those
      // fall through, and a caller that meant the identifier says so.
      if (kind !== 'auto' || parsed.kind === 'doi') {
        return { state: 'not-found', suggestions: [] }
      }
    }
  }

  // ---- title -----------------------------------------------------------
  if (!hasSearchableText(raw)) {
    // Punctuation, emoji, or a string of marks. Matching it against every title
    // whose key is also empty would return an arbitrary slice of the corpus.
    return { state: 'invalid', reason: 'That does not look like a title or an identifier.' }
  }

  const exact = db
    .prepare(CANDIDATE_SELECT + `WHERE w.title = ? ORDER BY w.id ASC LIMIT ?`)
    .all(raw, MAX_CANDIDATES + 1) as RawCandidate[]
  if (exact.length === 1) {
    const candidate: WorkCandidate = { ...exact[0], matched_by: 'exact-title' }
    return { state: 'resolved', work_id: exact[0].work_id, matched_by: 'exact-title', candidate }
  }
  if (exact.length > 1) {
    return ambiguous(exact, 'exact-title')
  }

  // Normalized comparison. `search_fold` is a per-connection SQLite function
  // (`connection.ts:80`) applying the SAME folding as `foldForSearch`, so both
  // sides of the comparison fold identically and the rows never leave SQLite.
  // Still a full scan of `work` — an app-registered function cannot be indexed —
  // but it stops at `MAX_CANDIDATES + 1` rows, where the existing copies in
  // `repositories.ts` materialise every title in the corpus into a JS array
  // first.
  const normed = db
    .prepare(
      CANDIDATE_SELECT +
        `WHERE search_fold(w.title) = search_fold(?) ORDER BY w.id ASC LIMIT ?`
    )
    .all(raw, MAX_CANDIDATES + 1) as RawCandidate[]
  if (normed.length === 1) {
    const candidate: WorkCandidate = { ...normed[0], matched_by: 'normalized-title' }
    return { state: 'resolved', work_id: normed[0].work_id, matched_by: 'normalized-title', candidate }
  }
  if (normed.length > 1) {
    return ambiguous(normed, 'normalized-title')
  }

  // ---- suggestions -----------------------------------------------------
  // A substring match, offered and never auto-resolved: "Kinetics" is a
  // legitimate prefix of forty papers, and picking one would be a guess.
  const like = `%${foldForSearch(raw).replace(/[\\%_]/g, (c) => '\\' + c)}%`
  const suggestions = db
    .prepare(
      CANDIDATE_SELECT +
        `WHERE search_fold(w.title) LIKE ? ESCAPE '\\'
          ORDER BY length(w.title) ASC, w.id ASC
          LIMIT ?`
    )
    .all(like, MAX_SUGGESTIONS) as RawCandidate[]

  return { state: 'not-found', suggestions: tag(suggestions, 'title-search') }
}

/**
 * Whether a resolved work is actually in a project.
 *
 * Separate from the resolution because a work is GLOBAL and a project's reading
 * of it is not: an agent that resolves a title and then writes relevance against
 * it in a project the paper was never added to would be writing project
 * interpretation for a paper that project does not hold.
 */
export function workIsInProject(db: DB, workId: number, projectId: number): boolean {
  return (
    db
      .prepare('SELECT 1 FROM project_work WHERE project_id = ? AND work_id = ? LIMIT 1')
      .get(projectId, workId) !== undefined
  )
}
