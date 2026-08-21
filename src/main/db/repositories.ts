import { join } from 'node:path'
import { homedir } from 'node:os'
import type { DB } from './connection'
import { foldForSearch, relayNow } from './connection'
import { anyReachable, probeDirectory, probeFileExists, probeFileReadable } from './repos/probe'
import { baseDirPathsOfKind } from './repos/baseDirs'
import { preferredDocumentId, readParagraphInventory } from './repos/text'
import { fieldParamHash, recomputeSchemaVersion, schemaVersionFromHashes } from './schemaHash'
import { CHECK_LABELS } from '../llm/review'
import { computeAnalysisFreshness, newFreshnessCache } from './freshness'
import type { FreshnessRunInput } from './freshness'
import { sweepVectorOrphans } from '../embedding/vectors'
import { referenceIdentityKey } from '../citations/normalize'
import { forgetUnresolvedEntry, promoteReferenceEntry } from '../citations/store'
import { bandFor, relevanceBands, type RelevanceBands } from '../references/store'
import { recomputeRanks } from '../rerank/store'
import { hashInput } from '../adapters'
import type {
  ProjectDTO,
  WorkDTO,
  WorkDetailDTO,
  ProjectWorkDTO,
  CitationEdgeDTO,
  AuthorDTO,
  IdentifierDTO,
  CitationContextDTO
} from '@shared/types'
import type {
  GraphDTO,
  GraphNodeDTO,
  GraphEdgeDTO,
  ReferenceTreeDTO,
  ReferenceTreeNodeDTO,
  UnresolvedReferenceNodeDTO,
  ReferenceAbstractDTO,
  ReferenceAbstractOutcome,
  ReferenceAbstractStateDTO,
  RankingRowDTO,
  AnalysisRunDTO,
  AnalysisCheckDTO,
  FactDTO,
  EvidenceSpanDTO,
  MeasurementDTO,
  FoldImprovementDTO,
  DocumentDTO,
  FileLocationDTO,
  ExtractionRowDTO,
  RunOrigin,
  ExtractionStatusSummaryDTO,
  ExtractionQcSampleDTO,
  ExtractionSchemaDTO,
  ExtractionFieldDTO,
  ExtractionFieldType,
  SchemaCoverageDTO,
  SchemaInput,
  FieldInput,
  ReviewItemDTO,
  FactVerdictDTO,
  FactVerdictKind,
  JobDTO,
  DossierEntryDTO,
  DossierSourceDTO,
  DossierStaleWorkDTO,
  DossierStatusDTO,
  DossierBriefingDTO,
  DossierPaperDTO,
  DossierTermGroupDTO,
  DossierContributionDTO,
  WorkSummaryDTO,
  SummaryKind,
  SearchResultDTO,
  SearchFilters,
  SearchSort,
  FacetsDTO,
  FacetBucketDTO,
  SavedSearchDTO,
  SavedFrontierDTO,
  IntegrationsStatusDTO,
  LlmModelDTO,
  StorageProjectDTO,
  StoragePaperDTO,
  UnresolvedReferenceDTO,
  ResolveReferenceTarget,
  ResolveReferenceResultDTO,
  ReferenceRetrievalDTO,
  ReferenceRetrievalStatus,
  RetrieveReferencesResultDTO,
  SchemaBundleDTO
} from '@shared/contract'
import { DOSSIER_LIMIT_SENTENCE, DOSSIER_PAPER_LIMIT } from '@shared/contract'
import { SCHEMA_BUNDLE_FORMAT } from './schemaPresets'

// Shared project projection incl. the dashboard stats (papers / ranked /
// extracted / failed). All counts are DB-derived (seed-only-DB):
//   - work_count     : works linked to the project
//   - ranked_count   : works with a (computed or overridden) relevance score
//   - extracted_count: distinct works with >=1 extracted FACT on a current run.
//     Not measurements: a text-valued field (a variant, a study design, a
//     population) yields facts and no measurement, so a measurement-only count
//     reports a fully extracted paper as un-extracted in any field whose schema
//     is not numeric.
//   - failed_count   : UNDISMISSED failed processing jobs for the project
//   - review_count   : facts the Review screen can actually offer a verdict on.
//     THE SAME PREDICATE THE SCREEN USES, deliberately: it counted parked jobs
//     before, which is a different population and a different question. A stage
//     that REFUSED is parked, and a refusal is an outcome to read, not a
//     decision to make -- so a project whose extraction refused on 26 papers
//     advertised "33 waiting on a decision from you" over a Review screen with
//     nothing in it, because nothing had been extracted to have an opinion
//     about.
//   - unread/undecided/decided_count: the reading state of the corpus, from
//     project_work.inclusion_status. unread → untouched, read+uncertain →
//     looked at but not settled, included+excluded → settled.
//
// THE one definition of "a failure that still needs attention". Every count in
// the app (project card, sidebar badge, Papers tabs) is this predicate — they
// disagreed before, because dismissal lived in renderer state that the SQL
// could not see.
// The `j.` alias is baked in because every caller joins `processing_job AS j`;
// the superseded test needs a second table, so this is no longer a bare column
// predicate and cannot be alias-agnostic.
export const JOB_FAILED_PREDICATE = /* sql */ `
  j.status IN ('failed','error') AND j.dismissed = 0
  -- and its run has NOT been replaced since.
  --
  -- A superseded stage_run is one a later attempt took over from, so its
  -- failure is HISTORY and the stage now holds a current result. Counting it
  -- reported "46 failed" on a corpus where every affected paper had succeeded:
  -- 44 of the 46 named superseded runs, none named a current one, and a single
  -- paper contributed 33 after being retried 33 times.
  --
  -- The number a user acts on is "how many papers still need me". A retry that
  -- eventually worked does not. The attempts are still on the row for anyone
  -- who wants the history; they simply stop being an alarm.
  AND NOT EXISTS (
    SELECT 1 FROM stage_run sr
     WHERE sr.id = j.stage_run_id AND sr.superseded = 1
  )
  -- and it actually RAN. A job with no stage_run never executed: the seed
  -- writes rows pre-baked as failed to populate the queue screen, carrying an
  -- invented error about a paper whose stage has really succeeded. A row
  -- describing work that never happened must not outrank the run that did.
  -- Narrow by construction: a genuine failure always has a run, because the
  -- scheduler opens one before executing and settles the job from its outcome.
  AND j.stage_run_id IS NOT NULL`

const PROJECT_SELECT = /* sql */ `
  SELECT p.id, p.name, p.slug, p.description, p.category, p.tags,
         p.setup_state, p.goal, p.questions,
         p.created_at, p.updated_at,
         (SELECT COUNT(*) FROM project_work pw WHERE pw.project_id = p.id) AS work_count,
         (SELECT COUNT(*) FROM project_work pw
            WHERE pw.project_id = p.id AND pw.relevance IS NOT NULL) AS ranked_count,
         -- What the project's context is built from, so a screen can tell
         -- whether another paper may go in without counting rows it has not
         -- loaded: Ranking paginates at 50 and the Paper screen holds one.
         (SELECT COUNT(*) FROM project_work pw
            WHERE pw.project_id = p.id AND pw.is_reference = 1) AS reference_paper_count,
         (SELECT COUNT(DISTINCT ar.work_id) FROM analysis_run ar
            JOIN fact f ON f.analysis_run_id = ar.id
            WHERE ar.superseded = 0
              AND (ar.project_id = p.id OR ar.project_id = 0)
              AND ar.work_id IN (SELECT work_id FROM project_work WHERE project_id = p.id)
         ) AS extracted_count,
         -- A PLACEHOLDER, and never the answer: withReviewCount overwrites it
         -- per project, because the real count needs a QC sample this select
         -- cannot draw. It is here so the row shape stays whole for callers
         -- that read it before that happens.
         0 AS review_count,
         (SELECT COUNT(*) FROM project_work pw
            WHERE pw.project_id = p.id AND pw.inclusion_status = 'unread') AS unread_count,
         (SELECT COUNT(*) FROM project_work pw
            WHERE pw.project_id = p.id
              AND pw.inclusion_status IN ('read','uncertain')) AS undecided_count,
         (SELECT COUNT(*) FROM project_work pw
            WHERE pw.project_id = p.id
              AND pw.inclusion_status IN ('included','excluded')) AS decided_count,
         -- The SAME set of jobs the project's Queue screen shows: document- and
         -- corpus-scoped stage jobs carry project_id = 0 (the global sentinel),
         -- so counting only p.id would let a failure be visible in the queue
         -- and invisible in the pill that exists to announce it. Restricted to
         -- this project's papers so a global job about someone else's work does
         -- not raise an alarm here.
         -- DISTINCT PAPERS, not jobs. A paper that could not be downloaded also
         -- carries a failed extract, segment and embed behind it, so counting
         -- rows announced "38 failed" over a twenty-paper project — a number
         -- larger than the corpus, which reads as a broken counter before it
         -- reads as a problem to fix. The paper is the unit the pill's own
         -- wording ("failed retrievals") already claims to be counting.
         (SELECT COUNT(DISTINCT j.work_id) FROM processing_job j
            WHERE (j.project_id = p.id
                   OR (j.project_id = 0
                       AND j.work_id IN (SELECT work_id FROM project_work
                                          WHERE project_id = p.id)))
              AND j.work_id IS NOT NULL
              AND ${JOB_FAILED_PREDICATE}) AS failed_count,
         -- PAPERS STILL MOVING THROUGH THE PIPELINE, so several projects being
         -- processed at once can be watched from one screen instead of opening
         -- each project's Queue in turn.
         --
         -- DISTINCT PAPERS, for the reason the failed count sets out directly
         -- above: one paper carries a dozen stage jobs, so counting rows would
         -- report a number larger than the corpus and read as a broken counter.
         --
         -- The same project_id = 0 union, because document- and corpus-scoped
         -- stages store the global sentinel: counting only p.id would show a
         -- paper as idle here while its Queue row was visibly running.
         --
         -- running, queued AND blocked. A job waiting on its upstream is still
         -- this paper's turn in progress, and excluding it would make the count
         -- drop to zero between stages and read as finished. review, failed and
         -- cancelled are excluded: each has its own pill, and a paper stopped
         -- for a human is not a paper being worked on.
         --
         -- AND NOT ALREADY SETTLED. A job carrying an outcome has finished,
         -- whatever its status says: the queue leaves rows at 'queued' with
         -- outcome 'succeeded' — work that ran and completed but was never
         -- re-stamped. Counting those left a project reporting "1 still
         -- loading" forever over a paper whose every stage had succeeded, with
         -- nothing on screen able to say which paper or why. The outcome is
         -- written when a stage actually ends, so it is the honest signal.
         (SELECT COUNT(DISTINCT j.work_id) FROM processing_job j
            WHERE j.status IN ('running','queued','blocked')
              AND j.outcome IS NULL
              AND j.work_id IS NOT NULL
              AND (j.project_id = p.id
                   OR (j.project_id = 0
                       AND j.work_id IN (SELECT work_id FROM project_work
                                          WHERE project_id = p.id)))
         ) AS processing_count
  FROM project p`

interface ProjectRow extends Omit<ProjectDTO, 'tags' | 'questions' | 'setup_state'> {
  tags: string | null
  questions: string | null
  setup_state: string
}

/**
 * Read a JSON array of strings out of a TEXT column.
 *
 * Shared by `tags` and `questions`, which store the same shape for the same
 * reason and were parsed by two copies of this. Anything that is not an array
 * of strings — a corrupted write, a hand-edited row, a null — yields the empty
 * list rather than throwing: a project whose questions cannot be parsed must
 * still open, and the questionnaire is where they get typed again.
 */
function parseStringArray(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}

function mapProject(row: ProjectRow): ProjectDTO {
  return {
    ...row,
    tags: parseStringArray(row.tags),
    questions: parseStringArray(row.questions),
    // Anything but the one other legal value is read as 'done'. The failure
    // that matters here is the opposite one: a project shown as needing setup
    // when it does not has no exit, so an unrecognised value must never be the
    // one that traps someone.
    setup_state: row.setup_state === 'onboarding' ? 'onboarding' : 'done'
  }
}

/**
 * The review count, from the QUEUE ITSELF rather than from parked jobs.
 *
 * `countReviewQueue` is what the Review screen lists, so asking it is what keeps
 * the badge and the screen from disagreeing. It cannot be a subquery in
 * `PROJECT_SELECT`: the queue includes a QC sample drawn per project, which is a
 * query of its own.
 *
 * The cost is one extra pass per project on a screen that lists a handful of
 * them. Counting parked jobs was cheaper and wrong -- it promised a decision
 * over a screen that had nothing to decide.
 */
function withReviewCount(db: DB, row: ProjectRow): ProjectDTO {
  return { ...mapProject(row), review_count: countReviewQueue(db, row.id) }
}

export function listProjects(db: DB): ProjectDTO[] {
  const rows = db
    .prepare(`${PROJECT_SELECT} ORDER BY p.name COLLATE NOCASE ASC`)
    .all() as ProjectRow[]
  return rows.map((r) => withReviewCount(db, r))
}

export function getProject(db: DB, id: number): ProjectDTO | null {
  const row = db.prepare(`${PROJECT_SELECT} WHERE p.id = ?`).get(id) as ProjectRow | undefined
  return row ? withReviewCount(db, row) : null
}

export function getWork(db: DB, id: number): WorkDetailDTO | null {
  const work = db
    .prepare(
      /* sql */ `
      SELECT id, title, work_type, publication_year, venue, abstract, created_at
      FROM work WHERE id = ?
    `
    )
    .get(id) as WorkDTO | undefined
  if (!work) return null

  const authors = db
    .prepare(
      /* sql */ `
      SELECT a.id, a.full_name, wa.position, wa.is_corresponding, af.name AS affiliation
      FROM work_author wa
      JOIN author a ON a.id = wa.author_id
      LEFT JOIN affiliation af ON af.id = wa.affiliation_id
      WHERE wa.work_id = ?
      ORDER BY wa.position ASC
    `
    )
    .all(id) as AuthorDTO[]

  const identifiers = db
    .prepare(
      /* sql */ `
      SELECT id, scheme, value FROM identifier
      WHERE work_id = ? ORDER BY scheme ASC
    `
    )
    .all(id) as IdentifierDTO[]

  return { ...work, authors, identifiers }
}

/** How many papers a project holds, under the same WHERE as `listProjectWorks`. */
export function countProjectWorks(db: DB, projectId: number): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS c
           FROM project_work pw
           JOIN work w ON w.id = pw.work_id
          WHERE pw.project_id = ?`
      )
      .get(projectId) as { c: number }
  ).c
}

/**
 * Which of these papers is ALREADY IN this project, keyed by the caller's own
 * row key.
 *
 * THE SAME TEST THE IMPORT USES — exact DOI on `identifier`, then normalised
 * title — because the two answers have to agree. A looser test would mark a hit
 * as present that importing would go on to add anyway; a stricter one would
 * offer a second copy of a paper the project already holds. Both are the bug
 * this exists to prevent, in opposite directions.
 *
 * Scoped to the PROJECT, not the corpus: a paper another project has been
 * reading is not in this one, and telling the user it is would hide the row
 * they actually meant to add.
 *
 * ONE title scan for the whole batch. Called per search with up to a hundred
 * hits, and `upsertResolvedWork` scans every work per paper — doing that a
 * hundred times over would be a hundred full table reads on the connection the
 * ingest writes through.
 */
export function findPapersInProject(
  db: DB,
  projectId: number,
  papers: readonly { key: string; doi: string | null; title: string }[]
): Map<string, number> {
  const out = new Map<string, number>()
  if (papers.length === 0) return out

  // The project's own papers, and nothing else. Both indexes are built from
  // this set, so a work outside the project can never be matched.
  const mine = db
    .prepare(
      `SELECT w.id, w.title FROM work w
         JOIN project_work pw ON pw.work_id = w.id
        WHERE pw.project_id = ?`
    )
    .all(projectId) as Array<{ id: number; title: string }>
  if (mine.length === 0) return out

  const ids = new Set(mine.map((w) => w.id))
  const byTitle = new Map<string, number>()
  for (const w of mine) byTitle.set(normalizeTitle(w.title), w.id)

  const byDoi = new Map<string, number>()
  for (const row of db
    .prepare(`SELECT work_id, value FROM identifier WHERE scheme = 'doi'`)
    .all() as Array<{ work_id: number; value: string }>) {
    if (ids.has(row.work_id)) byDoi.set(row.value.trim().toLowerCase(), row.work_id)
  }

  for (const p of papers) {
    const viaDoi = p.doi ? byDoi.get(p.doi.trim().toLowerCase()) : undefined
    const hit = viaDoi ?? byTitle.get(normalizeTitle(p.title))
    if (hit !== undefined) out.set(p.key, hit)
  }
  return out
}

/**
 * Take a paper OUT OF ONE PROJECT, leaving the paper itself alone.
 *
 * NOT `deleteWork`, and the distinction is the whole point. A work is stored
 * ONCE globally and imports dedup by DOI, so the paper someone removes from
 * their new project may be the same row another project has been reading for
 * months — erasing it there would take that project's paper, its analyses and
 * its evidence out from under it, to satisfy a click that meant "not this one".
 *
 * So this drops the `project_work` row and nothing else. What goes with it is
 * exactly this project's INTERPRETATION of the paper — relevance, inclusion
 * status, notes, its reference flag — which is the thing being withdrawn.
 * Analyses stay: they are keyed by (work, project) and a re-add finds them
 * again, so removing and re-adding does not silently discard a build.
 *
 * Returns false when the paper was not in the project, so removing twice is not
 * an error.
 */
export function removeWorkFromProject(db: DB, projectId: number, workId: number): boolean {
  return db.transaction((): boolean => {
    const info = db
      .prepare('DELETE FROM project_work WHERE project_id = ? AND work_id = ?')
      .run(projectId, workId)
    // A rank is a position among the papers still here, so removing one moves
    // everything below it. Without this the survivors kept the positions they
    // held while the deleted paper was still counted, and no sweep repairs a
    // project whose scores did not themselves change.
    if (info.changes > 0) recomputeRanks(db, projectId)
    return info.changes > 0
  })()
}

/**
 * Put a paper the library ALREADY HOLDS into a project.
 *
 * The counterpart of `removeWorkFromProject`, and the same distinction applies:
 * this creates only the `project_work` row — this project's INTERPRETATION of a
 * paper that already exists once, globally. It imports nothing and fetches
 * nothing.
 *
 * Every interpretation field starts UNSET rather than at zero: `relevance` and
 * `expansion_priority` are null because nothing here has judged this paper for
 * THIS project's question, and a 0 would draw an empty bar reading "judged, and
 * found irrelevant". A paper's scores in another project are answers to another
 * question and are deliberately not copied.
 *
 * `INSERT OR IGNORE` so adding twice is not an error, and `false` says the
 * paper was already a member — matching `removeWorkFromProject` returning false
 * for a paper that was not one.
 */
export function addWorkToProject(
  db: DB,
  projectId: number,
  workId: number,
  now: string
): boolean {
  return db.transaction((): boolean => {
    const info = db
      .prepare(
        `INSERT OR IGNORE INTO project_work
           (project_id, work_id, relevance, expansion_priority, inclusion_status, reviewed, created_at, updated_at)
         VALUES (?, ?, NULL, NULL, 'unread', 0, ?, ?)`
      )
      .run(projectId, workId, now, now)
    // A rank is a position among the papers now here, so an arrival moves the
    // papers below it exactly as a departure does.
    if (info.changes > 0) recomputeRanks(db, projectId)
    return info.changes > 0
  })()
}

export function listProjectWorks(
  db: DB,
  projectId: number,
  // No LIMIT unless one is asked for: the Project screen draws the whole list,
  // and a default page size here would silently shorten it.
  page: { limit?: number; offset?: number } = {}
): ProjectWorkDTO[] {
  const limitClause = page.limit === undefined ? '' : '\n      LIMIT ? OFFSET ?'
  const limitParams =
    page.limit === undefined ? [] : [Math.max(1, page.limit), Math.max(0, page.offset ?? 0)]

  const rows = db
    .prepare(
      /* sql */ `
      SELECT w.id, w.title, w.work_type, w.publication_year, w.venue, w.abstract, w.created_at,
             pw.relevance, pw.expansion_priority,
             pw.relevance_rank, pw.expansion_rank, pw.inclusion_status,
             pw.ranking_explanation, pw.reviewed
      FROM project_work pw
      JOIN work w ON w.id = pw.work_id
      WHERE pw.project_id = ?
      -- w.id last so the order is TOTAL: two papers can share a title as well as
      -- a relevance, and a tie under LIMIT/OFFSET puts one row on two pages and
      -- another on none.
      ORDER BY pw.relevance DESC, w.title COLLATE NOCASE ASC, w.id ASC${limitClause}
    `
    )
    .all(projectId, ...limitParams) as Array<
    WorkDTO & {
      relevance: number
      expansion_priority: number
      relevance_rank: number | null
      expansion_rank: number | null
      inclusion_status: string
      ranking_explanation: string | null
      reviewed: number
    }
  >

  return rows.map((r) => ({
    work: {
      id: r.id,
      title: r.title,
      work_type: r.work_type,
      publication_year: r.publication_year,
      venue: r.venue,
      abstract: r.abstract,
      created_at: r.created_at
    },
    relevance: r.relevance,
    expansion_priority: r.expansion_priority,
    relevance_rank: r.relevance_rank,
    expansion_rank: r.expansion_rank,
    inclusion_status: r.inclusion_status,
    ranking_explanation: r.ranking_explanation,
    reviewed: r.reviewed
  }))
}

/** How many resolved citation edges touch this paper. Same WHERE as the read. */
export function countCitationEdgesForWork(db: DB, workId: number): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM citation_edge e
          WHERE e.citing_work_id = ? OR e.cited_work_id = ?`
      )
      .get(workId, workId) as { c: number }
  ).c
}

export function getCitationEdgesForWork(
  db: DB,
  workId: number,
  // No LIMIT unless one is asked for: the Paper screen draws every edge. Each
  // edge costs a further contexts query, so a bounded caller wants the bound in
  // SQL rather than after the fan-out has already run.
  page: { limit?: number; offset?: number } = {}
): CitationEdgeDTO[] {
  const limitClause = page.limit === undefined ? '' : '\n      LIMIT ? OFFSET ?'
  const limitParams =
    page.limit === undefined ? [] : [Math.max(1, page.limit), Math.max(0, page.offset ?? 0)]
  const edges = db
    .prepare(
      /* sql */ `
      SELECT e.id, e.citing_work_id, e.cited_work_id, e.edge_type,
             cw.title AS citing_title, dw.title AS cited_title,
             -- Whether either END has text we hold. Carried on the edge because
             -- an endpoint is frequently a work OUTSIDE the caller's project,
             -- and nothing else the caller fetched can answer for one.
             ${HAS_TEXT_SUBQUERY('cw')} AS citing_has_text,
             ${HAS_TEXT_SUBQUERY('dw')} AS cited_has_text
      FROM citation_edge e
      JOIN work cw ON cw.id = e.citing_work_id
      JOIN work dw ON dw.id = e.cited_work_id
      WHERE e.citing_work_id = ? OR e.cited_work_id = ?
      ORDER BY e.id ASC${limitClause}
    `
    )
    .all(workId, workId, ...limitParams) as Array<
    Omit<
      CitationEdgeDTO,
      | 'contexts'
      | 'citing_has_text'
      | 'cited_has_text'
      | 'citing_authors'
      | 'cited_authors'
      | 'citing_identifier'
      | 'cited_identifier'
    > & {
      citing_title: string
      cited_title: string
      // SQLite has no boolean: the predicate above comes back 0 or 1, and the
      // cast has to say so or the mapping below silently ships an integer under
      // a field the contract types as a boolean.
      citing_has_text: number
      cited_has_text: number
    }
  >

  // The callout-site columns (sentence / para_id / callout_offset / page /
  // unresolved_reference_id) arrive with the migration that lands the
  // `citation-contexts` stage. Selecting them unconditionally would make this
  // DAO throw on every older DB, so they are added to the projection ONLY when
  // the table actually has them.
  //
  // The absence is then VISIBLE to the renderer rather than forged: an omitted
  // column reads back as `undefined` ("nothing has analysed callouts"), which
  // the DTO distinguishes from `null` ("analysed, and there is genuinely no
  // sentence here"). Defaulting the missing columns to null would erase that
  // difference and make an unprocessed paper look like an empty result.
  const ctxCols = new Set(
    (db.prepare(`PRAGMA table_info(citation_context)`).all() as Array<{ name: string }>).map(
      (c) => c.name
    )
  )
  const OPTIONAL_CTX_COLS = [
    'sentence',
    'para_id',
    'callout_offset',
    'page',
    'unresolved_reference_id',
    // Role PROVENANCE. `role` was projected without them, so the Connectome
    // popover could show a role but never say whether a regex or a model
    // decided it — which is the distinction `role_source` exists to preserve,
    // and which §3 requires be carried on every AI result.
    'role_source',
    'role_cue'
  ] as const
  const extraCols = OPTIONAL_CTX_COLS.filter((c) => ctxCols.has(c))

  // The VERIFICATION, when the table exists. Guarded on the table rather than on
  // the migration number for the same reason the columns above are: a database
  // older than `verify-citations` must read back `undefined` ("nothing has
  // checked this"), which the DTO distinguishes from `null` ("checked, and no
  // verdict") — collapsing the two would report an unprocessed corpus as one
  // whose citations a model declined to confirm.
  const haveLink =
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'citation_link'`).get() !==
    undefined
  const linkCols = haveLink
    ? `, l.verdict AS link_verdict, l.reason AS link_reason, l.model AS link_model,
       -- ONLY a verified link anchors anything. A rejected verdict has no
       -- target by CHECK, but projecting the columns unconditionally would let a
       -- future verdict leak an anchor into a claim it did not make.
       CASE WHEN l.verdict = 'verified' THEN l.target_text END AS target_sentence,
       CASE WHEN l.verdict = 'verified' THEN l.target_page END AS target_page`
    : ''
  const linkJoin = haveLink ? 'LEFT JOIN citation_link l ON l.citation_context_id = c.id' : ''
  // A REJECTED passage is not a citation context. It is a model's finding that
  // this sentence does not reference that paper, and showing it beside the
  // confirmed ones — which is what happens if the read path merely declines to
  // fill its target — puts back the confidently wrong citation the verification
  // exists to remove. Withheld here, in the one place both callers share.
  const linkFilter = haveLink ? `AND (l.verdict IS NULL OR l.verdict <> 'rejected')` : ''

  const ctxStmt = db.prepare(
    /* sql */ `
    SELECT c.id, c.raw_bib_text, c.section, c.role, c.resolution_confidence,
           c.occurrence_kind${
             extraCols.length ? ', ' + extraCols.map((x) => `c.${x}`).join(', ') : ''
           }${linkCols}
    FROM citation_context c ${linkJoin}
    WHERE c.edge_id = ? ${linkFilter} ORDER BY c.id ASC
  `
  )

  // Authors and identifiers for BOTH ends of every edge, one query each over the
  // distinct endpoint ids. On the edge because the caller's project pool cannot
  // answer for a work outside it; batched because a citation list is hundreds of
  // edges and this must not become two more queries per edge.
  const endpointIds = [...new Set(edges.flatMap((e) => [e.citing_work_id, e.cited_work_id]))]
  const authorsByWork = new Map<number, string[]>()
  const identifierByWork = new Map<number, { scheme: string; value: string }>()
  if (endpointIds.length > 0) {
    const ph = endpointIds.map(() => '?').join(',')
    for (const row of db
      .prepare(
        /* sql */ `
        SELECT wa.work_id, a.full_name
          FROM work_author wa
          JOIN author a ON a.id = wa.author_id
         WHERE wa.work_id IN (${ph})
         ORDER BY wa.work_id ASC, wa.position ASC`
      )
      .all(...endpointIds) as Array<{ work_id: number; full_name: string }>) {
      const list = authorsByWork.get(row.work_id)
      if (list) list.push(row.full_name)
      else authorsByWork.set(row.work_id, [row.full_name])
    }
    for (const row of db
      .prepare(
        /* sql */ `
        SELECT work_id, scheme, value FROM identifier
         WHERE work_id IN (${ph})
         ORDER BY work_id ASC, scheme ASC`
      )
      .all(...endpointIds) as Array<{ work_id: number; scheme: string; value: string }>) {
      if (!identifierByWork.has(row.work_id))
        identifierByWork.set(row.work_id, { scheme: row.scheme, value: row.value })
    }
  }

  return edges.map((e) => ({
    ...e,
    citing_has_text: e.citing_has_text === 1,
    cited_has_text: e.cited_has_text === 1,
    citing_authors: authorsByWork.get(e.citing_work_id) ?? [],
    cited_authors: authorsByWork.get(e.cited_work_id) ?? [],
    citing_identifier: identifierByWork.get(e.citing_work_id) ?? null,
    cited_identifier: identifierByWork.get(e.cited_work_id) ?? null,
    contexts: ctxStmt.all(e.id) as CitationContextDTO[]
  }))
}

/**
 * Every in-text context of a paper's citations — resolved AND unresolved.
 *
 * `getCitationEdgesForWork` is keyed by edge and therefore cannot return the
 * contexts of a reference that resolved to nothing, which on this corpus is
 * most of them (~840 unresolved references). Without this read path the
 * unresolved half would be storable and invisible, which is the same as being
 * dropped as far as a reader is concerned.
 *
 * `target_kind` is computed in SQL rather than inferred by the renderer from
 * "is some id null": edge ids and unresolved ids overlap numerically, so a UI
 * keying off an id would confidently mislabel one as the other.
 *
 * Ordered by READING POSITION, not by id. Insertion order happens to match
 * today because the stage scans forwards, but that is an accident of the
 * writer and a re-run in a different order would silently scramble the panel.
 */
/**
 * The `citation-contexts` stage's own verdict for a paper, or null if it never ran.
 *
 * READ FROM THE RECORD, never inferred from the rows. A `refused` run (the
 * callout numbering could not be trusted, so linking was declined) and an
 * `empty` one (the numbering WAS trusted and nothing linked) leave identical
 * rows — one bibliography row per reference, no in-text rows — so a UI deriving
 * the difference from what it can see would state one of them wrongly on every
 * paper of the other kind.
 *
 * Guarded on the table existing: a DB older than the pipeline migration has no
 * `stage_run` at all, and reporting "no verdict" is honest for it.
 */
export function getCitationOutcomeForWork(
  db: DB,
  workId: number
): { status: string; note: string | null } | null {
  const haveStageRun = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stage_run'`)
    .get()
  if (!haveStageRun) return null
  const row = db
    .prepare(
      /* sql */ `
      SELECT status, outcome_note FROM stage_run
       WHERE stage = 'citation-contexts' AND work_id = ? AND superseded = 0
       ORDER BY id DESC LIMIT 1
    `
    )
    .get(workId) as { status: string; outcome_note: string | null } | undefined
  return row ? { status: row.status, note: row.outcome_note } : null
}

export function getCitationContextsForWork(
  db: DB,
  workId: number,
  page: { limit?: number; offset?: number } = {}
): CitationContextDTO[] {
  const cols = new Set(
    (db.prepare(`PRAGMA table_info(citation_context)`).all() as Array<{ name: string }>).map(
      (c) => c.name
    )
  )
  // A DB older than the citation-context migration has none of these columns
  // and no way to name a work, so it has nothing to return. Reporting `[]` is
  // honest: nothing has analysed this paper's callouts.
  if (!cols.has('citing_work_id')) return []

  // Same guard, same reasoning, as `getCitationEdgesForWork`: a database
  // predating `verify-citations` reads back `undefined` rather than a forged
  // null, and a REJECTED passage is withheld from both paths identically. Two
  // read paths disagreeing about which citations are real is worse than either
  // answer alone.
  const haveLink =
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'citation_link'`).get() !==
    undefined
  const linkCols = haveLink
    ? `, l.verdict AS link_verdict, l.reason AS link_reason, l.model AS link_model,
       CASE WHEN l.verdict = 'verified' THEN l.target_text END AS target_sentence,
       CASE WHEN l.verdict = 'verified' THEN l.target_page END AS target_page`
    : ''
  const linkJoin = haveLink ? 'LEFT JOIN citation_link l ON l.citation_context_id = c.id' : ''
  const linkFilter = haveLink ? `AND (l.verdict IS NULL OR l.verdict <> 'rejected')` : ''

  // No LIMIT unless one is asked for: the Paper screen renders every callout,
  // and a default page size here would silently drop the tail of a well-cited
  // paper's references — the one thing this app promises never to do.
  const limitClause = page.limit === undefined ? '' : 'LIMIT ? OFFSET ?'
  const limitParams =
    page.limit === undefined ? [] : [Math.max(1, page.limit), Math.max(0, page.offset ?? 0)]

  return db
    .prepare(
      /* sql */ `
      SELECT c.id, c.edge_id, c.unresolved_reference_id,
             CASE WHEN c.edge_id IS NULL THEN 'unresolved' ELSE 'work' END AS target_kind,
             w.title AS target_title, e.cited_work_id,
             c.citing_work_id, c.document_id,
             c.ordinal, c.callout_offset, c.callout_end,
             c.para_id, c.page, c.sentence, c.section, c.raw_bib_text,
             c.role, c.role_source, c.role_cue,
             c.occurrence_kind, c.resolution_confidence${linkCols}
        FROM citation_context c
        LEFT JOIN citation_edge e ON e.id = c.edge_id
        LEFT JOIN work w          ON w.id = e.cited_work_id
        ${linkJoin}
       WHERE c.citing_work_id = ? ${linkFilter}
       -- c.id last so the order is TOTAL. Page, offset and ordinal are all
       -- nullable for an unresolved callout, so ties are real — and a tie under
       -- LIMIT/OFFSET is a row that appears on two pages while another appears
       -- on none.
       ORDER BY c.page ASC, c.callout_offset ASC, c.ordinal ASC, c.id ASC
       ${limitClause}
    `
    )
    .all(workId, ...limitParams) as CitationContextDTO[]
}

/**
 * How many callouts this paper has, under the same filters as the read above.
 *
 * Including the `rejected` exclusion: counting rows the read withholds would
 * tell a caller there are more pages than it can ever fetch. The legacy-schema
 * guard is repeated for the same reason it exists there — an older DB has no
 * `citing_work_id` column and cannot answer the question at all.
 */
export function countCitationContextsForWork(db: DB, workId: number): number {
  const cols = new Set(
    (db.prepare(`PRAGMA table_info(citation_context)`).all() as Array<{ name: string }>).map(
      (c) => c.name
    )
  )
  if (!cols.has('citing_work_id')) return 0
  const haveLink =
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'citation_link'`).get() !==
    undefined
  const linkJoin = haveLink ? 'LEFT JOIN citation_link l ON l.citation_context_id = c.id' : ''
  const linkFilter = haveLink ? `AND (l.verdict IS NULL OR l.verdict <> 'rejected')` : ''
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM citation_context c ${linkJoin}
          WHERE c.citing_work_id = ? ${linkFilter}`
      )
      .get(workId) as { c: number }
  ).c
}

/**
 * A paper's cited-but-absent references, each carrying the state of any
 * retrieval of the paper it names.
 *
 * The rows are reconciled against their jobs FIRST (`settleReferenceRetrievals`)
 * so a retrieval that ended while nobody was watching is reported as ended, and
 * the status is taken from the whole IDENTITY GROUP rather than this row alone:
 * the same paper is parsed once per bibliography that names it, and a fetch
 * started from another paper's reference list is fetching this one too.
 *
 * `retrieval_kind` comes from the same `referenceRetrievalTarget` the enqueue
 * uses, so a button offered here corresponds to work main will really do.
 */
export function getUnresolvedReferences(
  db: DB,
  workId: number,
  // No LIMIT unless one is asked for: the Paper screen lists every unmatched
  // reference. Each row costs an identity-group walk with a query per member, so
  // a bounded caller wants the bound applied before that loop runs.
  page: { limit?: number; offset?: number } = {}
): UnresolvedReferenceDTO[] {
  settleReferenceRetrievals(db)
  const limitClause = page.limit === undefined ? '' : '\n      LIMIT ? OFFSET ?'
  const limitParams =
    page.limit === undefined ? [] : [Math.max(1, page.limit), Math.max(0, page.offset ?? 0)]
  const rows = db
    .prepare(
      /* sql */ `
      SELECT ur.id, ur.citing_work_id, ur.raw_bib_text, ur.guessed_doi, ur.guessed_title,
             ur.index_title, ur.index_title_from,
             ur.section, ur.status, ur.guessed_venue, ur.guessed_year, ur.guessed_authors,
             ur.retrieval_status, ur.retrieval_error,
             -- LEFT JOIN, so an entry nothing has fetched for still appears with
             -- a null score. An INNER join would drop exactly the references the
             -- corpus knows least about, which are the ones most worth listing.
             ra.relevance, ra.scored_on,
             -- The abstract's STATE, never the abstract. The panel needs to
             -- label and explain one button per row; the prose is fetched by
             -- getReferenceAbstract for the one row anybody opens.
             ra.outcome AS abstract_outcome,
             (ra.abstract IS NOT NULL AND TRIM(ra.abstract) <> '') AS has_abstract,
             ra.source AS abstract_source,
             ra.matched_title AS abstract_matched_title
      FROM unresolved_reference ur
      LEFT JOIN reference_abstract ra ON ra.unresolved_reference_id = ur.id
      WHERE ur.citing_work_id = ?
      -- MOST RELEVANT FIRST, and sorted HERE because the list paginates: a
      -- renderer ordering what it was handed would sort each page within itself
      -- and put the best-looking reference at the top of every one of them.
      --
      -- Unscored rows sink to the bottom rather than floating on a NULL. A row
      -- nothing could score is not a row that scored badly, and the panel beside
      -- it has always said so by printing no number — an unscored entry landing
      -- above a measured one would contradict that in the ordering itself.
      --
      -- Ordered by the RAW score, not by the band. The band is three buckets and
      -- would leave the order inside each of them to chance; the score is what
      -- the buckets are cut from, so this is the same ranking at full
      -- resolution. The id last keeps the order total, so a tie cannot put one
      -- row on two pages under LIMIT/OFFSET.
      ORDER BY (ra.relevance IS NULL), ra.relevance DESC, ur.id ASC${limitClause}
    `
    )
    .all(workId, ...limitParams) as Array<
    Omit<UnresolvedReferenceDTO, 'abstract_state'> & AbstractStateColumns
  >
  if (rows.length === 0) return []

  const groupOf = unresolvedGroupByMember(db)
  // Read ONCE for the whole page. The cutoffs are a property of the corpus, not
  // of a row, so recomputing them per reference would scan the table 30 times to
  // reach the same answer.
  const bands = relevanceBands(db)
  const statusOfRow = db.prepare(
    `SELECT retrieval_status, retrieval_error FROM unresolved_reference WHERE id = ?`
  )
  const abstractOfRow = db.prepare(
    `SELECT outcome AS abstract_outcome, (abstract IS NOT NULL AND TRIM(abstract) <> '') AS has_abstract,
            source AS abstract_source, matched_title AS abstract_matched_title
       FROM reference_abstract WHERE unresolved_reference_id = ?`
  )
  // Later = further along, so a max over the members answers "is this paper
  // being fetched, and how did that go?" whichever bibliography named it.
  const rank: Record<string, number> = { none: 0, failed: 1, retrieving: 2, retrieved: 3 }

  return rows.map((r) => {
    const {
      abstract_outcome,
      has_abstract,
      abstract_source,
      abstract_matched_title,
      ...dto
    } = r
    let abstract_state = abstractStateFrom({
      id: dto.id,
      abstract_outcome,
      has_abstract,
      abstract_source,
      abstract_matched_title
    })
    // THE SAME SIBLING WALK the retrieval status below does, and for the same
    // reason. One paper is cited by several of ours and stored once per
    // bibliography, but the fetcher reuses an answer across them — so the row
    // this screen happens to be showing may carry no abstract while an
    // identical row under another paper carries one. Reading only this row told
    // the reader "No abstract found" about a reference the Connectome opens
    // fine.
    if (!abstract_state.has_abstract) {
      for (const m of groupOf.get(dto.id) ?? []) {
        if (m === dto.id) continue
        const other = abstractOfRow.get(m) as AbstractStateColumns | undefined
        if (!other) continue
        const cand = abstractStateFrom({ ...other, id: m })
        if (cand.has_abstract) {
          abstract_state = cand
          break
        }
      }
    }
    let status = dto.retrieval_status
    let error = dto.retrieval_error
    for (const m of groupOf.get(dto.id) ?? []) {
      if (m === dto.id) continue
      const other = statusOfRow.get(m) as
        | { retrieval_status: ReferenceRetrievalStatus; retrieval_error: string | null }
        | undefined
      if (other && (rank[other.retrieval_status] ?? 0) > (rank[status] ?? 0)) {
        status = other.retrieval_status
        error = other.retrieval_error
      }
    }
    const target = referenceRetrievalTarget({
      doi: dto.guessed_doi,
      title: dto.guessed_title,
      venue: dto.guessed_venue,
      year: dto.guessed_year
    })
    return {
      ...dto,
      retrieval_status: status,
      retrieval_error: error,
      retrieval_kind: target?.kind ?? null,
      relevance_band: bandFor(dto.relevance, dto.scored_on, bands),
      abstract_state
    }
  })
}

/**
 * The four columns a `ReferenceAbstractStateDTO` is read from, as SQLite hands
 * them over: `has_abstract` arrives as 0/1 because SQLite has no boolean.
 */
interface AbstractStateColumns {
  id: number
  abstract_outcome: ReferenceAbstractOutcome | null
  has_abstract: number | null
  abstract_source: 'openalex' | 'crossref' | null
  abstract_matched_title: string | null
}

/**
 * The abstract state of one reference, from a LEFT-JOINed `reference_abstract`.
 *
 * NO ROW IS ITS OWN ANSWER. A LEFT JOIN that matched nothing leaves every
 * column null, and that is `outcome: null` — nothing has asked yet — which the
 * UI must not read as 'absent'. Defaulting it to an outcome would turn a sweep
 * still in progress into a permanent claim that these papers have no abstracts.
 */
function abstractStateFrom(c: AbstractStateColumns): ReferenceAbstractStateDTO {
  return {
    unresolved_id: c.id,
    outcome: c.abstract_outcome ?? null,
    has_abstract: c.has_abstract === 1,
    source: c.abstract_source ?? null,
    matched_title: c.abstract_matched_title ?? null
  }
}

/**
 * One reference's abstract, read when a user asks to see it.
 *
 * SEPARATE FROM THE LISTS ON PURPOSE. The lists carry the state so each row can
 * label its own button; only this returns the prose, and only for the row that
 * was opened. Returns null strictly when no such unresolved reference exists —
 * a reference with no `reference_abstract` row comes back with a null outcome,
 * because "nothing has asked" is a state and not an absence of one.
 */
export function getReferenceAbstract(db: DB, unresolvedId: number): ReferenceAbstractDTO | null {
  const exists = db
    .prepare('SELECT id FROM unresolved_reference WHERE id = ?')
    .get(unresolvedId) as { id: number } | undefined
  if (!exists) return null
  const row = db
    .prepare(
      `SELECT abstract, matched_title, doi, source, outcome, fetched_at
         FROM reference_abstract WHERE unresolved_reference_id = ?`
    )
    .get(unresolvedId) as
    | {
        abstract: string | null
        matched_title: string | null
        doi: string | null
        source: 'openalex' | 'crossref' | null
        outcome: ReferenceAbstractOutcome
        fetched_at: string | null
      }
    | undefined
  return {
    unresolved_id: unresolvedId,
    abstract: row?.abstract ?? null,
    matched_title: row?.matched_title ?? null,
    doi: row?.doi ?? null,
    source: row?.source ?? null,
    outcome: row?.outcome ?? null,
    fetched_at: row?.fetched_at ?? null
  }
}

/** How many unmatched references this paper has. Same WHERE as the read. */
export function countUnresolvedReferences(db: DB, workId: number): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS c FROM unresolved_reference WHERE citing_work_id = ?`)
      .get(workId) as { c: number }
  ).c
}

// ============================================ retrieval of absent references
/**
 * The parsed fields a retrieval decision is made from. Deliberately narrow: the
 * decision must be reproducible from what the bibliography actually printed.
 */
interface ReferenceIdentity {
  doi: string | null
  title: string | null
  venue: string | null
  year: number | null
}

/**
 * Pick the best identifier a cited-but-absent paper offers, or null when it
 * offers none.
 *
 * MAXIMALLY PERMISSIVE, in this order:
 *   1. DOI — an exact handle, so nothing else can beat it.
 *   2. Title — what a search engine is built to take.
 *   3. The venue/year tuple as a title-ish query — a reference printed in a
 *      style that omits titles (ACS, Angewandte) still names a real paper, and
 *      "J. Am. Chem. Soc. 2011" is a weak query but an HONEST one.
 *
 * Null is returned ONLY when the entry names nothing at all. That case is real
 * (the parser emits entries it could extract no field from) and it is what
 * makes a selection legitimately un-retrievable.
 */
export function referenceRetrievalTarget(
  ref: ReferenceIdentity
): { kind: 'doi' | 'title'; query: string } | null {
  const doi = ref.doi?.trim()
  if (doi) return { kind: 'doi', query: doi }
  const title = ref.title?.trim()
  if (title) return { kind: 'title', query: title }
  const venue = ref.venue?.trim()
  if (venue) {
    return { kind: 'title', query: [venue, ref.year].filter(Boolean).join(' ') }
  }
  return null
}

/**
 * Every unresolved row, grouped by the PAPER it names.
 *
 * One cited paper produces one row per citing bibliography, so `citing_work_id`
 * is the only thing that differs between a paper's rows. Grouping is done here,
 * in main, rather than in the renderer, because the identity of a reference is a
 * data question and the retrieval is keyed on it: if the two sides derived it
 * independently they could disagree about how many distinct unknowns exist, and
 * the UI would offer a card whose retrieval hits a different set of rows.
 *
 * Returns key -> member row ids, ascending; the FIRST is the representative the
 * DTO and the retrieval both key on.
 */
function unresolvedIdentityGroups(db: DB): Map<string, number[]> {
  const rows = db
    .prepare(
      `SELECT id, guessed_doi AS doi, guessed_title AS title
         FROM unresolved_reference
        WHERE status <> 'abandoned'
        ORDER BY id ASC`
    )
    .all() as Array<{ id: number; doi: string | null; title: string | null }>
  const groups = new Map<string, number[]>()
  for (const r of rows) {
    const key = referenceIdentityKey(r)
    const a = groups.get(key)
    if (a) a.push(r.id)
    else groups.set(key, [r.id])
  }
  return groups
}

/** Row id -> every row naming the same paper (including itself). */
function unresolvedGroupByMember(db: DB): Map<number, number[]> {
  const byMember = new Map<number, number[]>()
  for (const members of unresolvedIdentityGroups(db).values()) {
    for (const id of members) byMember.set(id, members)
  }
  return byMember
}

/**
 * Reconcile stored retrieval state against the jobs it points at, then read it
 * back for `ids`.
 *
 * The row records the ATTEMPT; the `processing_job` records how the attempt is
 * going. Only the job knows when it ended, so the row is brought up to date here
 * rather than by whoever happens to be watching — which is what lets a card stop
 * saying "Retrieving…" after a restart that outlived the job.
 *
 * A finished job is NOT success. The retrieval succeeded only if a document was
 * actually obtained for the created work; the mock/offline stack cannot fetch
 * one, so 'failed' is the expected terminal state and it is reported as such
 * with the job's own error (or a plain statement that nothing was obtained).
 */
/**
 * Move every finished retrieval out of `retrieving`, everywhere.
 *
 * This must NOT depend on a screen being open. Settling used to happen only
 * inside `getReferenceRetrievals`, which the References tree called on a timer —
 * so a retrieval that finished while the user was on another screen (or had the
 * app open but never visited the tree) left its row saying "retrieving"
 * permanently, and the next tree read painted a card stuck mid-flight.
 *
 * `ids` narrows the work to a known set; omitting it settles every outstanding
 * retrieval, which is what the job queue does when a job reaches a terminal
 * state.
 */
export function settleReferenceRetrievals(db: DB, ids?: number[]): number {
  let scope: number[] | null = null
  if (ids && ids.length > 0) {
    // The caller holds the representative id of a merged card, but every row
    // naming that paper shares its job, so settle the whole group. Leaving the
    // others saying "retrieving" would make the next merged read of the tree
    // resurrect a status the job has already left behind.
    const groupOf = unresolvedGroupByMember(db)
    scope = [...new Set(ids.flatMap((id) => groupOf.get(id) ?? [id]))]
    if (scope.length === 0) return 0
  }

  const where =
    scope === null
      ? `u.retrieval_status = 'retrieving'`
      : `u.id IN (${scope.map(() => '?').join(',')}) AND u.retrieval_status = 'retrieving'`

  // A retrieval is the WHOLE PIPELINE for the paper, not one job of it.
  // `retrieval_job_id` names the job the reference is linked to, but that job is
  // only the front of a chain — judging the retrieval by it alone reports
  // "finished, nothing obtained" (and deletes the placeholder work) while the
  // rest of the stages are still queued against that very work. So the status
  // below is derived from the pipeline: live while ANY job of the work is live,
  // and only once none is does the `got_doc` test get to decide.
  const live = db
    .prepare(
      /* sql */ `
      SELECT u.id, u.retrieval_status, u.retrieval_work_id, u.retrieval_job_id,
             CASE
               WHEN j.id IS NULL THEN NULL
               WHEN EXISTS (
                 SELECT 1 FROM processing_job p
                  WHERE p.work_id = u.retrieval_work_id
                    AND p.status IN ('queued','blocked','running','review')
               ) THEN 'running'
               ELSE j.status
             END AS job_status,
             COALESCE(
               (SELECT p.error FROM processing_job p
                 WHERE p.work_id = u.retrieval_work_id AND p.error IS NOT NULL
                 ORDER BY p.id LIMIT 1),
               j.error
             ) AS job_error,
             (SELECT COUNT(*) FROM document d
               WHERE d.work_id = u.retrieval_work_id AND d.retrieval_status = 'retrieved') AS got_doc
        FROM unresolved_reference u
        LEFT JOIN processing_job j ON j.id = u.retrieval_job_id
       WHERE ${where}
    `
    )
    .all(...(scope ?? [])) as Array<{
    id: number
    retrieval_work_id: number | null
    job_status: string | null
    job_error: string | null
    got_doc: number
  }>

  const settle = db.prepare(
    `UPDATE unresolved_reference SET retrieval_status = ?, retrieval_error = ? WHERE id = ?`
  )
  /**
   * Drop the placeholder work a failed retrieval left behind.
   *
   * The work is created up-front so the job has something to fill in. If the
   * fetch fails there is nothing to fill it WITH, and leaving it turns a failed
   * reference into a readable corpus paper whose title is raw bibliography text
   * — the user could open it and find an empty shell. Deleting is safe: every
   * dependent row cascades, and `unresolved_reference.retrieval_work_id` is
   * ON DELETE SET NULL, so the reference itself survives carrying its failure.
   *
   * The guard tests for real CONTENT, not for the existence of an `analysis_run`
   * row: the pipeline runs against the empty placeholder too, producing a run
   * with zero facts and zero evidence over a document that was never fetched.
   * Treating that as "analysed" would keep every failure forever. A work is kept
   * only if it has a retrieved document, or a run that actually yielded
   * something — then it is no longer a placeholder.
   */
  const hasContent = db.prepare(
    /* sql */ `
    SELECT
      (SELECT COUNT(*) FROM document d
        WHERE d.work_id = ? AND d.retrieval_status = 'retrieved')
      + (SELECT COUNT(*) FROM fact f
           JOIN analysis_run r ON r.id = f.analysis_run_id WHERE r.work_id = ?)
      + (SELECT COUNT(*) FROM evidence_span e
           JOIN analysis_run r ON r.id = e.analysis_run_id WHERE r.work_id = ?)
      AS c`
  )
  // The run and its verdicts both RESTRICT their parent, so they are
  // cleared innermost-first. `hasContent` above has already established there is
  // no fact or evidence to lose.
  const dropChecks = db.prepare(
    `DELETE FROM analysis_check
      WHERE analysis_run_id IN (SELECT id FROM analysis_run WHERE work_id = ?)`
  )
  const dropRuns = db.prepare('DELETE FROM analysis_run WHERE work_id = ?')
  const dropWork = db.prepare('DELETE FROM work WHERE id = ?')
  const failWith = (id: number, workId: number | null, error: string): void => {
    settle.run('failed', error, id)
    if (workId === null) return
    if ((hasContent.get(workId, workId, workId) as { c: number }).c > 0) return
    dropChecks.run(workId)
    dropRuns.run(workId)
    dropWork.run(workId)
  }
  let settled = 0
  const tx = db.transaction(() => {
    for (const r of live) {
      // A vanished job cannot be waited on any longer; saying so beats a card
      // that claims to be retrieving forever.
      if (r.job_status === null) {
        failWith(r.id, r.retrieval_work_id, 'the retrieval job is no longer on the queue')
        settled++
        continue
      }
      // Every NON-terminal status, named positively rather than as "not queued
      // and not running": 'blocked' (waiting on a dependency) and 'review' (a
      // result a human should look at) are both live, and treating an unlisted
      // status as finished would report a retrieval that has not concluded as a
      // hard failure and delete the placeholder work it created.
      if (
        r.job_status === 'queued' ||
        r.job_status === 'blocked' ||
        r.job_status === 'running' ||
        r.job_status === 'review'
      ) {
        continue
      }
      if (r.got_doc > 0) {
        settle.run('retrieved', null, r.id)
        settled++
        continue
      }
      failWith(
        r.id,
        r.retrieval_work_id,
        r.job_error ?? 'no document was obtained for this reference (no network access)'
      )
      settled++
    }
  })
  tx()
  return settled
}

/**
 * Current retrieval state for the given references.
 *
 * A pure read: settling is the job queue's business (see
 * `settleReferenceRetrievals`), because a status must not depend on whether
 * anyone happened to be looking at the tree.
 */
export function getReferenceRetrievals(db: DB, ids: number[]): ReferenceRetrievalDTO[] {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(',')
  return db
    .prepare(
      /* sql */ `
      SELECT u.id AS unresolved_id, u.retrieval_status, u.retrieval_error,
             u.retrieval_job_id AS job_id, u.retrieval_work_id AS work_id
        FROM unresolved_reference u
       WHERE u.id IN (${placeholders})
       ORDER BY u.id ASC
    `
    )
    .all(...ids) as ReferenceRetrievalDTO[]
}

/**
 * Queue an ingest for each selected cited-but-absent reference.
 *
 * `enqueue` is injected rather than reached for through the queue singleton so
 * this stays a pure DB function that a headless harness can drive.
 *
 * Skips (never fails the batch): a reference that names nothing retrievable,
 * and one whose retrieval is already in flight. Both are reported back, because
 * "9 of 10 queued" is a different thing to tell the user than "10 queued".
 *
 * Works on the PAPER, not the row. Every row naming the same paper is queued as
 * ONE job and all of them are linked to it, so the paper is fetched once and the
 * single card standing for those rows shows one consistent status. Two ids of
 * the same paper in one batch therefore produce one job, and the second is not
 * reported as a skip — it was never a second thing to do.
 *
 * One transaction per reference, matching `ingest:run`: a work must never be
 * committed without the job that is supposed to fill it in.
 */
export function retrieveUnresolvedReferences(
  db: DB,
  projectId: number,
  unresolvedIds: number[],
  now: string,
  /**
   * Plan the pipeline for a newly created work; returns its job ids in
   * dependency order.
   *
   * Injected rather than reached for through the queue singleton so this stays
   * a pure DB function a headless harness can drive.
   */
  planForWork: (input: { workId: number; projectId: number }) => number[]
): RetrieveReferencesResultDTO {
  const result: RetrieveReferencesResultDTO = { queued: [], skipped: [] }
  if (unresolvedIds.length === 0) return result

  const placeholders = unresolvedIds.map(() => '?').join(',')
  const rows = db
    .prepare(
      /* sql */ `
      SELECT id, guessed_doi AS doi, guessed_title AS title, guessed_venue AS venue,
             guessed_year AS year, raw_bib_text, retrieval_status
        FROM unresolved_reference
       WHERE id IN (${placeholders})
       ORDER BY id ASC
    `
    )
    .all(...unresolvedIds) as Array<
    ReferenceIdentity & {
      id: number
      raw_bib_text: string
      retrieval_status: string
    }
  >

  const link = db.prepare(
    `UPDATE unresolved_reference
        SET retrieval_status = 'retrieving', retrieval_job_id = ?, retrieval_work_id = ?,
            retrieval_error = NULL, retrieval_started_at = ?
      WHERE id = ?`
  )

  const groupOf = unresolvedGroupByMember(db)
  const isRetrieving = db.prepare(
    `SELECT COUNT(*) AS c FROM unresolved_reference
      WHERE id = ? AND retrieval_status = 'retrieving'`
  )
  // A paper asked for twice in one batch is still one paper.
  const done = new Set<number>()

  for (const row of rows) {
    if (done.has(row.id)) continue
    const members = groupOf.get(row.id) ?? [row.id]
    for (const m of members) done.add(m)
    // Any member in flight means the PAPER is in flight — the rows are only
    // different bibliographies naming it.
    const inFlight =
      row.retrieval_status === 'retrieving' ||
      members.some((m) => (isRetrieving.get(m) as { c: number }).c > 0)
    if (inFlight) {
      result.skipped.push({ unresolved_id: row.id, reason: 'already-retrieving' })
      continue
    }
    const target = referenceRetrievalTarget(row)
    if (!target) {
      result.skipped.push({ unresolved_id: row.id, reason: 'not-retrievable' })
      continue
    }
    // The placeholder work is titled by what the bibliography actually printed,
    // so the Papers screen shows the paper the user asked for rather than an
    // opaque "doi:10.xxxx" stub.
    const title = row.title?.trim() || row.raw_bib_text.slice(0, 300)
    const queued = db.transaction(() => {
      const workId = createSeedWork(db, projectId, title, now)
      if (row.year !== null) {
        // `updated_at` explicitly rather than left to v44's trigger, so a row
        // created a statement ago does not read as edited after it was created —
        // but stamped from `relayNow()`, NOT the local `now`. `updated_at` on a
        // synced table is read by the merge as RELAY time, so a machine whose clock
        // runs fast would otherwise win last-write-wins on this row against every
        // peer, on every edit, silently. One clock, one stamping path.
        db.prepare(
          'UPDATE work SET publication_year = ?, venue = ?, updated_at = ? WHERE id = ?'
        ).run(row.year, row.venue, relayNow(), workId)
      }
      // The FIRST planned job, which is the front of the pipeline for this
      // paper. That is what `retrieval_job_id` has always meant to the
      // References screen — "the job whose progress stands for this retrieval"
      // — and the dependency edges make every later stage follow it.
      const jobIds = planForWork({ workId, projectId })
      const jobId = jobIds[0] ?? 0
      for (const m of members) link.run(jobId, workId, now, m)
      return { unresolved_id: row.id, job_id: jobId, work_id: workId }
    })()
    result.queued.push(queued)
  }

  return result
}

/** Normalize a title for dedup: lowercase, strip non-alphanumerics, collapse ws. */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Resolve an unresolved reference into the citation graph, in ONE transaction:
 *   (a) find-or-create the target work — respecting §5 dedup signals (DOI exact
 *       match on the identifier table, then normalized-title match) so we never
 *       duplicate an existing work;
 *   (b) upsert the citation_edge citing_work_id -> target (respecting the
 *       ux_citation_edge unique index via INSERT OR IGNORE + re-select);
 *   (c) delete the unresolved_reference row.
 * Returns which work was linked and how it was matched. (A-M3.)
 */
export function resolveUnresolvedReference(
  db: DB,
  unresolvedId: number,
  target: ResolveReferenceTarget,
  now: string,
  edgeType = 'cites'
): ResolveReferenceResultDTO {
  const tx = db.transaction((): ResolveReferenceResultDTO => {
    const ref = db
      .prepare('SELECT id, citing_work_id FROM unresolved_reference WHERE id = ?')
      .get(unresolvedId) as { id: number; citing_work_id: number } | undefined
    if (!ref) throw new Error(`unresolved_reference ${unresolvedId} not found`)

    let citedWorkId: number
    let createdWork = false
    // Defaults to 'created'; overridden below when an existing work is matched by
    // id / DOI / normalized title. (Definite assignment for the compiler too.)
    let matchedBy: ResolveReferenceResultDTO['matchedBy'] = 'created'

    if ('workId' in target) {
      const exists = db.prepare('SELECT id FROM work WHERE id = ?').get(target.workId) as
        | { id: number }
        | undefined
      if (!exists) throw new Error(`target work ${target.workId} not found`)
      citedWorkId = target.workId
      matchedBy = 'existing-id'
    } else {
      const nw = target.newWork
      // (1) DOI exact match via the identifier table (§5 primary signal).
      let found: { id: number } | undefined
      if (nw.doi) {
        found = db
          .prepare(
            `SELECT work_id AS id FROM identifier WHERE scheme = 'doi' AND value = ? LIMIT 1`
          )
          .get(nw.doi) as { id: number } | undefined
        if (found) matchedBy = 'doi'
      }
      // (2) Normalized-title match (§5 secondary signal).
      if (!found) {
        const norm = normalizeTitle(nw.title)
        const candidates = db
          .prepare('SELECT id, title FROM work')
          .all() as Array<{ id: number; title: string }>
        const hit = candidates.find((c) => normalizeTitle(c.title) === norm)
        if (hit) {
          found = { id: hit.id }
          matchedBy = 'normalized-title'
        }
      }
      if (found) {
        citedWorkId = found.id
      } else {
        // (3) Create the target work (+ DOI identifier when supplied).
        const info = db
          .prepare(
            `INSERT INTO work (title, work_type, publication_year, venue, created_at, updated_at)
             VALUES (?, 'other', ?, ?, ?, ?)`
          )
          .run(nw.title, nw.year ?? null, nw.venue ?? null, now, now)
        citedWorkId = Number(info.lastInsertRowid)
        createdWork = true
        matchedBy = 'created'
        if (nw.doi) {
          db.prepare(
            `INSERT OR IGNORE INTO identifier (work_id, scheme, value, created_at) VALUES (?, 'doi', ?, ?)`
          ).run(citedWorkId, nw.doi, now)
        }
      }
    }

    // Self-cite guard: never materialize a self-loop edge (a work citing
    // itself). The reference is still "resolved" (the row is removed), but no
    // graph edge is created.
    if (citedWorkId === ref.citing_work_id) {
      // The contexts go too, DELIBERATELY and COUNTED, rather than by the
      // cascade nobody would see. A context exists to be evidence FOR an edge;
      // when the edge is refused by policy there is no referent left, and the
      // XOR check states the same thing by making a target-less context
      // unrepresentable. The count is returned so the user who chose this
      // resolve is told what it cost instead of the loss being silent.
      const discarded = db
        .prepare('DELETE FROM citation_context WHERE unresolved_reference_id = ?')
        .run(unresolvedId).changes
      // The parse's published entry list must stop naming this row BEFORE it
      // goes. `unresolved_reference.id` is a bare INTEGER PRIMARY KEY, so
      // SQLite hands a deleted id straight back to the next insert — an
      // artifact still pointing at it would attach a LATER paper's callouts to
      // this entry. Misattributed evidence, not missing evidence, and nothing
      // about the result would look wrong.
      forgetUnresolvedEntry(db, {
        unresolvedReferenceId: unresolvedId,
        citingWorkId: ref.citing_work_id
      })
      db.prepare('DELETE FROM unresolved_reference WHERE id = ?').run(unresolvedId)
      return {
        // `null`, never `0`. A sentinel id that no row has is precisely how a
        // caller comes to fabricate a link to a non-existent edge — one
        // `promoteReferenceEntry(edgeId: 0)` away from attaching this paper's
        // evidence to nothing. The type now forces the caller to handle it.
        edgeId: null,
        citingWorkId: ref.citing_work_id,
        citedWorkId,
        createdWork,
        matchedBy,
        contextsMoved: 0,
        contextsDiscardedSelfCite: discarded
      }
    }

    // Upsert the edge (ux_citation_edge on citing,cited,edge_type). INSERT OR
    // IGNORE then re-select so the returned edgeId is correct whether the edge
    // was newly created or already existed.
    db.prepare(
      `INSERT OR IGNORE INTO citation_edge (citing_work_id, cited_work_id, edge_type, created_at)
       VALUES (?, ?, ?, ?)`
    ).run(ref.citing_work_id, citedWorkId, edgeType, now)
    const edge = db
      .prepare(
        `SELECT id FROM citation_edge WHERE citing_work_id = ? AND cited_work_id = ? AND edge_type = ?`
      )
      .get(ref.citing_work_id, citedWorkId, edgeType) as { id: number }

    // BEFORE the delete, and in this same transaction. `unresolved_reference_id`
    // carries ON DELETE CASCADE, so the good outcome — a reference finally
    // resolving — would otherwise destroy every scrap of evidence about where
    // in the paper it was cited. The repoint touches no key column, so the
    // anchor, the sentence and the raw bibliography text survive on the SAME
    // row rather than being copied to a new one.
    const moved = promoteReferenceEntry(db, {
      unresolvedReferenceId: unresolvedId,
      citingWorkId: ref.citing_work_id,
      citedWorkId,
      edgeType
    }).movedContexts

    // Remove the now-resolved unresolved_reference row.
    db.prepare('DELETE FROM unresolved_reference WHERE id = ?').run(unresolvedId)

    return {
      edgeId: edge.id,
      citingWorkId: ref.citing_work_id,
      citedWorkId,
      createdWork,
      matchedBy,
      contextsMoved: moved,
      contextsDiscardedSelfCite: 0
    }
  })
  return tx()
}

// ============================================================ projects (mutations)
export function createProjectRow(
  db: DB,
  input: {
    name: string
    description: string
    summaryPrompt?: string | null
    onboarding?: boolean
  },
  now: string
): number {
  // Derive a unique slug from the name.
  const base =
    input.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'project'
  let slug = base
  let n = 2
  while (db.prepare('SELECT 1 FROM project WHERE slug = ?').get(slug)) {
    slug = `${base}-${n++}`
  }
  const info = db
    .prepare(
      `INSERT INTO project (name, slug, description, summary_prompt, setup_state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    // NULL unless the user actually wrote a brief. Blank is not a brief: an
    // empty string stored here would resolve as an override and hand the model
    // a summary task with no instructions at all.
    .run(
      input.name,
      slug,
      input.description,
      input.summaryPrompt && input.summaryPrompt.trim() ? input.summaryPrompt.trim() : null,
      // 'done' unless asked otherwise, so the paths that create a project
      // already complete — an archive import, a shared project, a seeded
      // corpus — are not stranded behind a form their contents have answered.
      input.onboarding ? 'onboarding' : 'done',
      now,
      now
    )
  return Number(info.lastInsertRowid)
}

/**
 * The description a model is given, composed from the two halves the user
 * answers in.
 *
 * ONE function, called on every write of either half, so the composed string
 * and its parts cannot drift. The questions are enumerated rather than run
 * together: they are separate asks, and a model handed them as a paragraph
 * answers the last one.
 *
 * A project with a goal and no questions composes to just the goal — the
 * heading below is not printed over an empty list, which would tell the model
 * this project asks nothing in particular and mean it.
 */
export function composeProjectDescription(goal: string, questions: string[]): string {
  const parts: string[] = []
  const g = goal.trim()
  if (g) parts.push(g)
  const qs = questions.map((q) => q.trim()).filter((q) => q !== '')
  if (qs.length > 0) {
    parts.push(
      ['Questions this project asks:', ...qs.map((q) => `- ${q}`)].join('\n')
    )
  }
  return parts.join('\n\n')
}

/**
 * Write whatever the questionnaire has just changed.
 *
 * Every field is optional because this is called on BLUR: one field left is one
 * field written. Whenever either half of the description changes, the composed
 * `description` is rewritten from BOTH — read back from the row rather than
 * taken from the caller, so a blur that sends only the goal still composes
 * against the questions already stored.
 */
export function updateProjectSetupRow(
  db: DB,
  input: { projectId: number; name?: string; goal?: string; questions?: string[] },
  now: string
): void {
  const row = db
    .prepare('SELECT goal, questions FROM project WHERE id = ?')
    .get(input.projectId) as { goal: string | null; questions: string | null } | undefined
  if (!row) throw new Error(`No project with id ${input.projectId}.`)

  const sets: string[] = []
  const args: unknown[] = []

  if (input.name !== undefined) {
    sets.push('name = ?')
    args.push(input.name)
  }
  if (input.goal !== undefined) {
    sets.push('goal = ?')
    args.push(input.goal)
  }
  if (input.questions !== undefined) {
    sets.push('questions = ?')
    // Blank rows are the form's own scaffolding — the trailing empty input that
    // invites the next question — and are not answers to store.
    args.push(JSON.stringify(input.questions.map((q) => q.trim()).filter((q) => q !== '')))
  }
  if (input.goal !== undefined || input.questions !== undefined) {
    const goal = input.goal !== undefined ? input.goal : (row.goal ?? '')
    const questions =
      input.questions !== undefined ? input.questions : parseStringArray(row.questions)
    sets.push('description = ?')
    args.push(composeProjectDescription(goal, questions))
  }
  if (sets.length === 0) return

  sets.push('updated_at = ?')
  args.push(now, input.projectId)
  db.prepare(`UPDATE project SET ${sets.join(', ')} WHERE id = ?`).run(...args)
}

/** Mark setup finished. Called only once the context build has RETURNED. */
export function markProjectSetupDone(db: DB, projectId: number, now: string): void {
  db.prepare(`UPDATE project SET setup_state = 'done', updated_at = ? WHERE id = ?`).run(
    now,
    projectId
  )
}

/** Create a bare work + preferred document + project_work link for a seed title. */
/** Real metadata for a paper named by an identifier, ready to become a work. */
export interface ResolvedPaperInput {
  title: string
  abstract: string
  authors: string[]
  year: number | null
  venue: string | null
  doi: string | null
  /** Other schemes worth recording, e.g. arxiv / pmid. */
  identifiers?: { scheme: 'arxiv' | 'pmid' | 'pmcid'; value: string }[]
}

/**
 * Create — or adopt — the work a resolved identifier names, and link it to the
 * project.
 *
 * Dedup follows the same §5 signals as reference resolution: an exact DOI match
 * on the identifier table first, then a normalized-title match. Skipping this
 * would let the same paper enter the corpus twice under two identifiers, which
 * silently splits its citations and analyses across two rows.
 *
 * An EXISTING work is enriched rather than overwritten: fields it is missing get
 * filled in, fields it already has are left alone. A user may have corrected a
 * title by hand, and an automated lookup must not undo that.
 */
export function upsertResolvedWork(
  db: DB,
  projectId: number,
  paper: ResolvedPaperInput,
  now: string
): { workId: number; created: boolean } {
  return db.transaction(() => {
    let workId: number | undefined
    if (paper.doi) {
      const hit = db
        .prepare(`SELECT work_id AS id FROM identifier WHERE scheme = 'doi' AND value = ? LIMIT 1`)
        .get(paper.doi) as { id: number } | undefined
      workId = hit?.id
    }
    if (workId === undefined) {
      const norm = normalizeTitle(paper.title)
      const candidates = db.prepare('SELECT id, title FROM work').all() as Array<{
        id: number
        title: string
      }>
      workId = candidates.find((c) => normalizeTitle(c.title) === norm)?.id
    }

    const created = workId === undefined
    if (workId === undefined) {
      const info = db
        .prepare(
          `INSERT INTO work (title, work_type, publication_year, venue, abstract, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          paper.title,
          paper.doi?.startsWith('10.1101/') || paper.doi?.startsWith('10.48550/')
            ? 'preprint'
            : 'journal-article',
          paper.year,
          paper.venue,
          paper.abstract || null,
          now,
          now
        )
      workId = Number(info.lastInsertRowid)
      // A resolved paper has real metadata but no file yet — the document is
      // what a later retrieval fills in.
      db.prepare(
        `INSERT INTO document (work_id, version_kind, content_status, retrieval_status, is_preferred, created_at)
         VALUES (?, 'other', ?, 'not-attempted', 1, ?)`
      ).run(workId, paper.abstract ? 'abstract-only' : 'metadata-only', now)
    } else {
      db.prepare(
        `UPDATE work
            SET publication_year = COALESCE(publication_year, ?),
                venue            = COALESCE(venue, ?),
                abstract         = COALESCE(abstract, ?),
                updated_at       = ?
          WHERE id = ?`
      ).run(paper.year, paper.venue, paper.abstract || null, now, workId)
    }

    if (paper.doi) {
      db.prepare(
        `INSERT OR IGNORE INTO identifier (work_id, scheme, value, created_at) VALUES (?, 'doi', ?, ?)`
      ).run(workId, paper.doi, now)
    }
    for (const id of paper.identifiers ?? []) {
      db.prepare(
        `INSERT OR IGNORE INTO identifier (work_id, scheme, value, created_at) VALUES (?, ?, ?, ?)`
      ).run(workId, id.scheme, id.value, now)
    }

    // Authors are only written for a work that has none: re-running a lookup
    // must not append a second copy of the same author list.
    const hasAuthors = (
      db.prepare('SELECT COUNT(*) AS c FROM work_author WHERE work_id = ?').get(workId) as {
        c: number
      }
    ).c
    if (hasAuthors === 0) {
      paper.authors.forEach((name, i) => {
        const existing = db
          .prepare('SELECT id FROM author WHERE full_name = ? LIMIT 1')
          .get(name) as { id: number } | undefined
        const authorId =
          existing?.id ??
          Number(
            db
              .prepare('INSERT INTO author (full_name, created_at) VALUES (?, ?)')
              .run(name, now).lastInsertRowid
          )
        db.prepare(
          `INSERT OR IGNORE INTO work_author (work_id, author_id, position) VALUES (?, ?, ?)`
        ).run(workId, authorId, i)
      })
    }

    db.prepare(
      `INSERT OR IGNORE INTO project_work
         (project_id, work_id, relevance, expansion_priority, inclusion_status, reviewed, created_at, updated_at)
       VALUES (?, ?, NULL, NULL, 'unread', 0, ?, ?)`
    ).run(projectId, workId, now, now)

    return { workId, created }
  })()
}

/**
 * Give a work the identity an index confirmed for it: title, authors, DOI, year.
 *
 * THE WORK IS NAMED, NOT LOOKED UP. `upsertResolvedWork` finds or creates a work
 * from the metadata itself, which is right when an identifier is the starting
 * point and wrong here: this paper already exists — it was created from a file —
 * and its stored title is the FILENAME, so a title-based dedup would fail to
 * match it and mint a SECOND work for a PDF the library already holds.
 *
 * THE TITLE IS OVERWRITTEN, unlike everything else. That is the whole point: a
 * filename is a placeholder, and leaving it would mean the paper stayed named
 * `Charmantray and Hecquet - 2025 - Extending th…` forever. Every other field is
 * COALESCE'd, so a value already on the row — possibly one the user typed —
 * survives. The caller has already verified this record describes this document;
 * `identity/verify.ts` holds the rule that decides that.
 *
 * Returns false when the DOI is already held by a DIFFERENT work: this file is
 * then a second copy of a paper the library has, and nothing is written, because
 * merging two works has consequences this function cannot see.
 */
export function applyResolvedIdentity(
  db: DB,
  workId: number,
  paper: ResolvedPaperInput,
  now: string
): boolean {
  return db.transaction(() => {
    if (paper.doi) {
      const owner = db
        .prepare(`SELECT work_id AS id FROM identifier WHERE scheme = 'doi' AND value = ? LIMIT 1`)
        .get(paper.doi) as { id: number } | undefined
      if (owner && owner.id !== workId) return false
    }

    db.prepare(
      `UPDATE work
          SET title            = ?,
              work_type        = CASE WHEN work_type = 'other' THEN ? ELSE work_type END,
              publication_year = COALESCE(publication_year, ?),
              venue            = COALESCE(venue, ?),
              abstract         = COALESCE(abstract, ?),
              updated_at       = ?
        WHERE id = ?`
    ).run(
      paper.title,
      paper.doi?.startsWith('10.1101/') || paper.doi?.startsWith('10.48550/')
        ? 'preprint'
        : 'journal-article',
      paper.year,
      paper.venue,
      paper.abstract || null,
      now,
      workId
    )

    if (paper.doi) {
      db.prepare(
        `INSERT OR IGNORE INTO identifier (work_id, scheme, value, created_at) VALUES (?, 'doi', ?, ?)`
      ).run(workId, paper.doi, now)
    }
    for (const id of paper.identifiers ?? []) {
      db.prepare(
        `INSERT OR IGNORE INTO identifier (work_id, scheme, value, created_at) VALUES (?, ?, ?, ?)`
      ).run(workId, id.scheme, id.value, now)
    }

    // Only for a work that has none, so a re-run cannot append a second copy of
    // the same list — the guard `upsertResolvedWork` applies, for the reason.
    const hasAuthors = (
      db.prepare('SELECT COUNT(*) AS c FROM work_author WHERE work_id = ?').get(workId) as {
        c: number
      }
    ).c
    if (hasAuthors === 0) {
      paper.authors.forEach((name, i) => {
        const existing = db
          .prepare('SELECT id FROM author WHERE full_name = ? LIMIT 1')
          .get(name) as { id: number } | undefined
        const authorId =
          existing?.id ??
          Number(
            db
              .prepare('INSERT INTO author (full_name, created_at) VALUES (?, ?)')
              .run(name, now).lastInsertRowid
          )
        db.prepare(
          `INSERT OR IGNORE INTO work_author (work_id, author_id, position) VALUES (?, ?, ?)`
        ).run(workId, authorId, i)
      })
    }
    return true
  })()
}

/**
 * Erase a paper and everything derived from it, permanently.
 *
 * Most of the graph cascades from `work`, but the provenance chain deliberately
 * does not: `analysis_run` is ON DELETE RESTRICT precisely so a run can never be
 * lost as a side effect of some unrelated delete. That guard is right for
 * accidents and wrong for a deliberate erase, so the chain is cleared explicitly,
 * innermost-first — checks and verdicts, then facts and evidence, then the runs —
 * because each level RESTRICTs the one above it.
 *
 * One transaction: a half-deleted paper would leave facts pointing at a work
 * that no longer exists, which no screen knows how to render.
 *
 * Returns false when the id names nothing, so a double-click reports honestly
 * rather than throwing.
 */
export function deleteWork(db: DB, workId: number): boolean {
  return db.transaction(() => {
    const exists = db.prepare('SELECT 1 FROM work WHERE id = ?').get(workId)
    if (!exists) return false

    const runIds = (
      db.prepare('SELECT id FROM analysis_run WHERE work_id = ?').all(workId) as { id: number }[]
    ).map((r) => r.id)

    if (runIds.length > 0) {
      const list = runIds.map(() => '?').join(',')
      // fact_verdict hangs off fact, so it must go before the facts it judges.
      db.prepare(
        `DELETE FROM fact_verdict WHERE fact_id IN
           (SELECT id FROM fact WHERE analysis_run_id IN (${list}))`
      ).run(...runIds)
      db.prepare(`DELETE FROM analysis_check WHERE analysis_run_id IN (${list})`).run(...runIds)
      db.prepare(`DELETE FROM fact WHERE analysis_run_id IN (${list})`).run(...runIds)
      db.prepare(`DELETE FROM evidence_span WHERE analysis_run_id IN (${list})`).run(...runIds)
      db.prepare(`DELETE FROM analysis_run WHERE id IN (${list})`).run(...runIds)
    }

    // Jobs reference the work but are not owned by it: a queued job for a paper
    // that no longer exists would fail noisily on its next tick, so they are
    // cancelled rather than left to run against nothing.
    db.prepare(
      `UPDATE processing_job SET status = 'cancelled'
        WHERE work_id = ? AND status IN ('queued','blocked','running')`
    ).run(workId)

    // stage_run's work_id and document_id are FK-free sentinels — the
    // one-current-run index needs 0 to be a value, and SQLite treats NULLs as
    // distinct — so nothing cascades on its own. Both are cleared here, not
    // just work_id: deleting a work cascades its DOCUMENTS, which would strand
    // every document-scoped run whose stage_run rows outlive their subject and
    // keep occupying ux_stage_run_current against any future re-plan. The
    // artifacts each run produced cascade from stage_run_id.
    db.prepare(
      `DELETE FROM stage_run
        WHERE work_id = ?
           OR document_id IN (SELECT id FROM document WHERE work_id = ?)`
    ).run(workId, workId)

    // Everything else — documents, identifiers, authorship, citation edges,
    // project links, measurements — cascades from this row.
    db.prepare('DELETE FROM work WHERE id = ?').run(workId)

    // The chunks just cascaded away; their VECTORS did not.
    //
    // A `vec0` table is VIRTUAL, so it carries no foreign key and no cascade —
    // nothing in the schema removes a vector when its chunk goes. A surviving
    // vector is worse than untidy: a space-correct k-NN still matches it and
    // returns a chunk id that no longer resolves, so the search silently drops
    // that result and the user reads the shorter list as "fewer matches".
    //
    // There is a sweep at startup, but "correct again after the next launch" is
    // not a window a delete gets to open. Swept HERE, inside the same
    // transaction, so the vectors go with the work that owned them.
    sweepVectorOrphans(db)
    return true
  })()
}

export function createSeedWork(
  db: DB,
  projectId: number,
  title: string,
  now: string
): number {
  const w = db
    .prepare(
      `INSERT INTO work (title, work_type, created_at, updated_at) VALUES (?, 'other', ?, ?)`
    )
    .run(title, now, now)
  const workId = Number(w.lastInsertRowid)
  db.prepare(
    `INSERT INTO document (work_id, version_kind, content_status, retrieval_status, is_preferred, created_at)
     VALUES (?, 'other', 'unknown', 'not-attempted', 1, ?)`
  ).run(workId, now)
  db.prepare(
    `INSERT OR IGNORE INTO project_work
       (project_id, work_id, relevance, expansion_priority, inclusion_status, reviewed, created_at, updated_at)
     VALUES (?, ?, NULL, NULL, 'unread', 0, ?, ?)`
  ).run(projectId, workId, now, now)
  return workId
}

// ============================================================ graph

/**
 * SQL predicate selecting the unresolved references that are CITED PAPERS,
 * excluding the container row of a lettered composite entry.
 *
 * ACS and Angewandte print several papers under one number — "(11) (a) … (b) …"
 * — and the parser stores the composite AND one row per part, because the parts
 * are the papers while the composite is what the page printed. Anywhere the
 * question is "how many papers does this one cite that we could not identify",
 * the container is not one of them: its title and year are spliced from
 * different papers and it names nothing on its own.
 *
 * The test is "does this row have lettered siblings" rather than "is this row a
 * part", so an ordinary entry — which has no parts and therefore IS the cited
 * paper — is kept. `u` must be the alias of the row being tested.
 */
const CITED_UNRESOLVED_ONLY = /* sql */ `
  NOT (
    u.part_label IS NULL
    AND EXISTS (
      SELECT 1 FROM unresolved_reference s
       WHERE s.citing_work_id = u.citing_work_id
         AND s.ordinal IS NOT NULL AND s.ordinal = u.ordinal
         AND s.part_label IS NOT NULL
    )
  )`

/**
 * SQL scalar: does this work have TEXT this install actually holds?
 *
 * Reads the SAME preferred document every other projection reads
 * (`is_preferred DESC, id ASC`), so one work cannot be "held" on one screen and
 * not on another. `fulltext` and `abstract-only` count; `metadata-only`,
 * `unknown` and having no document at all do not — those are a citation's worth
 * of bibliographic data with nothing behind it.
 *
 * A PROPERTY OF THE WORK, deliberately with no project in it. Whether a paper
 * has been fetched is global; whether a project contains it is not, and the two
 * are answered separately on purpose.
 *
 * `alias` is the alias of the `work` row being tested.
 */
const HAS_TEXT_SUBQUERY = (alias: string): string => /* sql */ `
  COALESCE((SELECT d.content_status IN ('fulltext','abstract-only')
              FROM document d
             WHERE d.work_id = ${alias}.id
             ORDER BY d.is_preferred DESC, d.id ASC LIMIT 1), 0)`

export function getGraph(
  db: DB,
  projectId: number,
  opts: { limit?: number; minRelevance?: number } = {}
): GraphDTO {
  const limit = opts.limit ?? 200
  const minRel = opts.minRelevance ?? 0

  const totalRow = db
    .prepare('SELECT COUNT(*) AS c FROM project_work WHERE project_id = ?')
    .get(projectId) as { c: number }

  const nodes = db
    .prepare(
      /* sql */ `
      SELECT w.id, w.title, w.work_type, w.publication_year AS year, w.venue,
             pw.relevance, pw.relevance_rank, pw.expansion_priority, pw.expansion_rank, pw.inclusion_status,
             pw.scored_on,
             -- INCOMING: works in this corpus that cite it.
             (SELECT COUNT(*) FROM citation_edge ce WHERE ce.cited_work_id = w.id) AS citation_count,
             -- OUTGOING: its own references that RESOLVED to a corpus work.
             -- The connectome draws these, so it must be able to show them:
             -- a node labelled "0 citations" with eleven outgoing lines reads
             -- as a bug when only the incoming number is exposed.
             (SELECT COUNT(*) FROM citation_edge ce WHERE ce.citing_work_id = w.id) AS reference_count,
             -- Parsed bibliography entries that resolved to nothing. Separate
             -- from reference_count: these are retrieval candidates, not edges.
             -- The container of a lettered entry is excluded: it is not a paper
             -- anyone could retrieve, and counting it told the reader of an ACS
             -- paper that more of its references were unmatched than there were
             -- references.
             (SELECT COUNT(*) FROM unresolved_reference u
               WHERE u.citing_work_id = w.id AND ${CITED_UNRESOLVED_ONLY}) AS unresolved_count,
             (SELECT d.content_status FROM document d
                WHERE d.work_id = w.id ORDER BY d.is_preferred DESC, d.id ASC LIMIT 1) AS content_status
      FROM project_work pw
      JOIN work w ON w.id = pw.work_id
      WHERE pw.project_id = ? AND COALESCE(pw.relevance, 0) >= ?
      ORDER BY pw.relevance DESC, w.id ASC
      LIMIT ?
    `
    )
    .all(projectId, minRel, limit) as Omit<GraphNodeDTO, 'authors' | 'identifier'>[]

  const ids = nodes.map((n) => n.id)

  // Authors and identifiers for the WHOLE page in one query each, not one per
  // node: the graph returns up to `limit` nodes and a per-node query would be
  // hundreds of round trips for a panel that shows one paper at a time.
  const authorsByWork = new Map<number, string[]>()
  const identifierByWork = new Map<number, { scheme: string; value: string }>()
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',')
    for (const row of db
      .prepare(
        /* sql */ `
        SELECT wa.work_id, a.full_name
          FROM work_author wa
          JOIN author a ON a.id = wa.author_id
         WHERE wa.work_id IN (${placeholders})
         ORDER BY wa.work_id ASC, wa.position ASC`
      )
      .all(...ids) as Array<{ work_id: number; full_name: string }>) {
      const list = authorsByWork.get(row.work_id)
      if (list) list.push(row.full_name)
      else authorsByWork.set(row.work_id, [row.full_name])
    }
    for (const row of db
      .prepare(
        /* sql */ `
        SELECT work_id, scheme, value FROM identifier
         WHERE work_id IN (${placeholders})
         ORDER BY work_id ASC, scheme ASC`
      )
      .all(...ids) as Array<{ work_id: number; scheme: string; value: string }>) {
      if (!identifierByWork.has(row.work_id))
        identifierByWork.set(row.work_id, { scheme: row.scheme, value: row.value })
    }
  }
  const fullNodes: GraphNodeDTO[] = nodes.map((n) => ({
    ...n,
    authors: authorsByWork.get(n.id) ?? [],
    identifier: identifierByWork.get(n.id) ?? null
  }))
  let edges: GraphEdgeDTO[] = []
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',')
    edges = db
      .prepare(
        /* sql */ `
        SELECT e.id, e.citing_work_id AS source, e.cited_work_id AS target, e.edge_type
        FROM citation_edge e
        WHERE e.citing_work_id IN (${placeholders}) AND e.cited_work_id IN (${placeholders})
        ORDER BY e.id ASC
      `
      )
      .all(...ids, ...ids) as GraphEdgeDTO[]
  }

  return {
    nodes: fullNodes,
    edges,
    total_works: totalRow.c,
    shown_works: fullNodes.length
  }
}

// ==================================================== reference tree
/** An `unresolved_reference` row as the tree query reads it, before merging. */
type UnresolvedRow = Omit<
  UnresolvedReferenceNodeDTO,
  | 'kind'
  | 'retrieval_kind'
  | 'retrieval_query'
  | 'citing_work_ids'
  | 'member_ids'
  | 'abstract_state'
  // Not selected either: the merge derives it from the raw score and the
  // corpus-wide cutoffs. Leaving it on the cast claimed a column this query
  // does not read, which is the kind of lie that survives until someone trusts
  // it.
  | 'relevance_band'
> & { citing_work_id: number } & AbstractStateColumns

/**
 * Collapse the rows naming the SAME paper into one node.
 *
 * A cited paper is parsed out of every bibliography that names it, so the corpus
 * holds one row per (paper, citing paper). Drawn one-row-one-card, a paper cited
 * by nine works became nine cards, each independently selectable — so the same
 * paper could be queued for retrieval nine times. Known papers were never drawn
 * that way: one node, nine incoming edges. This makes the unknowns agree.
 *
 * The FIRST row (lowest id) is the representative: it supplies the id the UI and
 * the retrieval key on, and the bibliographic fields, so the node is a real row
 * and not a synthesized composite. `citing_work_ids` carries every work that
 * named it — that is what becomes the several incoming links — and `member_ids`
 * every row it stands for. A member whose retrieval has moved further along wins
 * the status, because a paper being fetched is being fetched no matter which
 * bibliography the user reached it through.
 */
function mergeUnresolvedRows(rows: UnresolvedRow[], bands: RelevanceBands): UnresolvedReferenceNodeDTO[] {
  const order: string[] = []
  const groups = new Map<string, UnresolvedRow[]>()
  for (const r of rows) {
    const key = referenceIdentityKey(r)
    const a = groups.get(key)
    if (a) a.push(r)
    else {
      groups.set(key, [r])
      order.push(key)
    }
  }

  // Later = further along, so a max over the members answers "is this paper
  // being fetched, and how did that go?" without caring which row was clicked.
  const rank: Record<string, number> = { none: 0, failed: 1, retrieving: 2, retrieved: 3 }

  return order.map((key) => {
    const members = groups.get(key)!
    const head = members.reduce((a, b) => (a.id <= b.id ? a : b))
    const lead = members.reduce((a, b) =>
      (rank[b.retrieval_status] ?? 0) > (rank[a.retrieval_status] ?? 0) ? b : a
    )
    const target = referenceRetrievalTarget(head)
    const {
      citing_work_id: _citer,
      abstract_outcome,
      has_abstract,
      abstract_source,
      abstract_matched_title,
      ...fields
    } = head
    return {
      ...fields,
      kind: 'unresolved' as const,
      citing_work_ids: [...new Set(members.map((m) => m.citing_work_id))].sort((a, b) => a - b),
      member_ids: members.map((m) => m.id).sort((a, b) => a - b),
      retrieval_status: lead.retrieval_status,
      retrieval_error: lead.retrieval_error,
      retrieval_kind: target?.kind ?? null,
      retrieval_query: target?.query ?? null,
      // The HEAD's score, matching every other bibliographic field here: the
      // representative row is a real row, not a composite, and averaging the
      // members' scores would state a relevance no reference was given.
      relevance_band: bandFor(head.relevance, head.scored_on, bands),
      // NOT the head's, unlike everything above it. The members of a node are
      // the SAME PAPER printed in several bibliographies, and an abstract is a
      // fact about that paper rather than about the line that named it — the
      // fetcher already reuses one member's answer for another through
      // `abstractByAskKey`. Reading only the head would tell the user no
      // abstract exists while one sits on a sibling row, and the button they
      // are refused would open perfectly well from the other paper's panel.
      abstract_state: abstractStateFrom(
        members.find((m) => m.has_abstract === 1) ?? members.find((m) => m.abstract_outcome !== null) ?? head
      )
    }
  })
}

/**
 * Every in-project work + every citation edge BETWEEN in-project works, plus
 * the preferred document id per work (page 1 of that PDF is the node
 * thumbnail).
 *
 * Ordered by publication year ASC (nulls last) so the layout has a stable,
 * chronologically meaningful tie-break; the actual depth is computed in the
 * renderer from the edges. The cap is deliberately high and the true project
 * total is returned alongside so the screen can disclose any shortfall rather
 * than silently drawing a partial tree.
 */
export function getReferenceTree(
  db: DB,
  projectId: number,
  opts: { limit?: number; unresolvedPerWork?: number } = {}
): ReferenceTreeDTO {
  const limit = opts.limit ?? 5000
  const unresolvedPerWork = opts.unresolvedPerWork ?? 0

  const totalRow = db
    .prepare('SELECT COUNT(*) AS c FROM project_work WHERE project_id = ?')
    .get(projectId) as { c: number }

  const workRows = db
    .prepare(
      /* sql */ `
      SELECT w.id, w.title, w.work_type, w.publication_year AS year, w.venue,
             pw.relevance, pw.relevance_rank, pw.expansion_priority, pw.expansion_rank, pw.inclusion_status,
             (SELECT COUNT(*) FROM citation_edge ce WHERE ce.cited_work_id = w.id) AS citation_count,
             (SELECT d.content_status FROM document d
                WHERE d.work_id = w.id ORDER BY d.is_preferred DESC, d.id ASC LIMIT 1) AS content_status,
             (SELECT d.id FROM document d
                WHERE d.work_id = w.id ORDER BY d.is_preferred DESC, d.id ASC LIMIT 1) AS document_id
      FROM project_work pw
      JOIN work w ON w.id = pw.work_id
      WHERE pw.project_id = ?
      ORDER BY (w.publication_year IS NULL), w.publication_year ASC, w.id ASC
      LIMIT ?
    `
    )
    .all(projectId, limit) as Array<Omit<ReferenceTreeNodeDTO, 'kind'>>

  // `kind` is a DTO-level discriminator, not a stored column.
  const nodes: ReferenceTreeNodeDTO[] = workRows.map((n) => ({ ...n, kind: 'work' as const }))
  const ids = nodes.map((n) => n.id)
  let edges: GraphEdgeDTO[] = []
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',')
    edges = db
      .prepare(
        /* sql */ `
        SELECT e.id, e.citing_work_id AS source, e.cited_work_id AS target, e.edge_type
        FROM citation_edge e
        WHERE e.citing_work_id IN (${placeholders}) AND e.cited_work_id IN (${placeholders})
          AND e.citing_work_id <> e.cited_work_id
        ORDER BY e.id ASC
      `
      )
      .all(...ids, ...ids) as GraphEdgeDTO[]
  }

  // Cited-but-unknown references. Counted over the WHOLE project regardless of
  // the per-work cap, so the UI can disclose how many it is not drawing.
  let totalUnresolved = 0
  let unresolved: UnresolvedReferenceNodeDTO[] = []
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',')
    // Excludes the container of a lettered entry, so this total describes the
    // same population as the nodes drawn below it. Counting containers made the
    // disclosure line claim the app was hiding references it was not hiding —
    // the nodes are already deduplicated by `mergeUnresolvedRows`, so an
    // undeduplicated total beside them had the screen contradicting itself.
    totalUnresolved = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM unresolved_reference u
            WHERE u.citing_work_id IN (${placeholders})
              AND ${CITED_UNRESOLVED_ONLY}`
        )
        .get(...ids) as { c: number }
    ).c

    if (unresolvedPerWork > 0) {
      // ROW_NUMBER partitioned by citing work applies the cap PER PAPER, so a
      // paper with 200 references cannot crowd out every other paper's nodes.
      // Ordered by ordinal so the entries drawn are the ones printed first.
      const rawUnresolved = db
        .prepare(
          /* sql */ `
          SELECT id, citing_work_id, guessed_title AS title, guessed_year AS year,
                 guessed_venue AS venue, guessed_authors AS authors,
                 -- A title an INDEX supplied, for an entry whose style printed
                 -- none. Carried BESIDE the printed title, never merged into it:
                 -- the renderer prefers it, and a reader may need to tell "what
                 -- the page says" from "what an index says".
                 index_title, index_title_from,
                 guessed_doi AS doi, ordinal, raw_bib_text, status,
                 retrieval_status, retrieval_error, relevance, scored_on,
                 abstract_outcome, has_abstract, abstract_source, abstract_matched_title
            FROM (
              SELECT u.*,
                     -- The score the reference-abstracts stage left, so the
                     -- cluster panel can order 200 entries by what they are
                     -- about rather than by where they were printed. A LEFT
                     -- join: a reference nobody has scored keeps its row and
                     -- carries null, which the panel prints as nothing.
                     (SELECT ra.relevance FROM reference_abstract ra
                       WHERE ra.unresolved_reference_id = u.id) AS relevance,
                     (SELECT ra.scored_on FROM reference_abstract ra
                       WHERE ra.unresolved_reference_id = u.id) AS scored_on,
                     -- The abstract's STATE, four correlated reads rather than
                     -- a join, matching the two above: this subquery is already
                     -- keyed on the partial unique index, and a join would
                     -- multiply the ROW_NUMBER window's input.
                     (SELECT ra.outcome FROM reference_abstract ra
                       WHERE ra.unresolved_reference_id = u.id) AS abstract_outcome,
                     -- TRIMMED, not merely non-null. A stored empty string is
                     -- not an abstract, and it would light a pressable button
                     -- that opens a panel with nothing in it.
                     (SELECT ra.abstract IS NOT NULL AND TRIM(ra.abstract) <> ''
                        FROM reference_abstract ra
                       WHERE ra.unresolved_reference_id = u.id) AS has_abstract,
                     (SELECT ra.source FROM reference_abstract ra
                       WHERE ra.unresolved_reference_id = u.id) AS abstract_source,
                     (SELECT ra.matched_title FROM reference_abstract ra
                       WHERE ra.unresolved_reference_id = u.id) AS abstract_matched_title,
                     -- BY RELEVANCE, so the cap keeps a paper's most relevant
                     -- references rather than whichever it printed first. Under
                     -- the old ordering the panel sorted by relevance a set that
                     -- had already been chosen by page order, so a paper's best
                     -- reference could be cut before the sort ever saw it.
                     ROW_NUMBER() OVER (
                       PARTITION BY u.citing_work_id
                       ORDER BY ((SELECT ra.relevance FROM reference_abstract ra
                                   WHERE ra.unresolved_reference_id = u.id) IS NULL),
                                (SELECT ra.relevance FROM reference_abstract ra
                                  WHERE ra.unresolved_reference_id = u.id) DESC,
                                (u.ordinal IS NULL), u.ordinal ASC, u.id ASC
                     ) AS rn
                FROM unresolved_reference u
               WHERE u.citing_work_id IN (${placeholders})
                 AND u.status <> 'abandoned'
                 -- The SAME population the total above counts. Drawing the
                 -- container of a lettered entry put a card on the screen whose
                 -- title and year belong to two different papers, next to the
                 -- cards for the papers themselves — and offered it for
                 -- retrieval, which could only ever fail.
                 AND ${CITED_UNRESOLVED_ONLY}
            )
           WHERE rn <= ?
           ORDER BY citing_work_id ASC, (relevance IS NULL), relevance DESC,
                    (ordinal IS NULL), ordinal ASC, id ASC
        `
        )
        .all(...ids, unresolvedPerWork) as UnresolvedRow[]

      unresolved = mergeUnresolvedRows(rawUnresolved, relevanceBands(db))
    }
  }

  return {
    nodes,
    edges,
    total_works: totalRow.c,
    shown_works: nodes.length,
    unresolved,
    total_unresolved: totalUnresolved
  }
}

// ============================================================ ranking
export function getRanking(
  db: DB,
  projectId: number,
  sortBy: 'relevance' | 'expansion' | 'year' | 'citations' = 'relevance',
  // `workId` narrows to ONE paper IN SQL. It is a predicate, not a slice: it
  // composes with the WHERE, so it cannot interact with a LIMIT the way a JS
  // filter over a page would.
  page: { limit?: number; offset?: number; workId?: number } = {}
): RankingRowDTO[] {
  const orderBy =
    sortBy === 'expansion'
      ? 'pw.expansion_priority DESC'
      : sortBy === 'year'
        ? 'w.publication_year DESC'
        : sortBy === 'citations'
          ? 'citation_count DESC'
          : 'pw.relevance DESC'

  // Absent `limit`, no LIMIT clause at all — the screen has always received the
  // whole ranking and paginates it itself, and a default page size here would
  // silently shorten it. `offset` alone is meaningless in SQLite without a
  // LIMIT, so it is ignored unless `limit` is given rather than compiled into a
  // `LIMIT -1` that reads as a bug.
  const limitClause = page.limit === undefined ? '' : 'LIMIT ? OFFSET ?'
  const limitParams =
    page.limit === undefined
      ? []
      : [Math.max(1, page.limit), Math.max(0, page.offset ?? 0)]

  return db
    .prepare(
      /* sql */ `
      SELECT w.id AS work_id, w.title, w.publication_year AS year, w.work_type,
             pw.relevance, pw.relevance_rank, pw.expansion_priority, pw.expansion_rank, pw.inclusion_status,
             pw.is_reference, pw.scored_on, pw.ranking_explanation, pw.reviewed,
             pw.user_overrides,
             (SELECT COUNT(*) FROM citation_edge ce WHERE ce.cited_work_id = w.id) AS citation_count
      FROM project_work pw
      JOIN work w ON w.id = pw.work_id
      WHERE pw.project_id = ?${page.workId === undefined ? '' : ' AND pw.work_id = ?'}
      -- w.id last so the order is TOTAL: two papers can share a title as well
      -- as a score, and a tie under LIMIT/OFFSET puts one row on two pages and
      -- another on none.
      ORDER BY ${orderBy}, w.title COLLATE NOCASE ASC, w.id ASC
      ${limitClause}
    `
    )
    .all(projectId, ...(page.workId === undefined ? [] : [page.workId]), ...limitParams)
    .map((r) => {
      const row = r as Omit<RankingRowDTO, 'is_reference'> & { is_reference: number }
      return { ...row, is_reference: row.is_reference === 1 }
    })
}

/**
 * How many rows the ranking has in total.
 *
 * The companion to `getRanking`'s `limit`, and it carries the SAME `WHERE` as
 * that query — a bare project count would be a different number the moment a
 * filter is added, and `total` reported as `items.length` is the conflation the
 * pagination exists to avoid.
 */
/**
 * ONE ranking row, by work id, in exactly the shape the list returns.
 *
 * `getRanking(...).find(...)` answers the same question by building the WHOLE
 * project's ranking first — a 3000-row synchronous scan with a per-row
 * citation-count subquery, on the thread that draws the window, to report one
 * row.
 */
export function getRankingRow(
  db: DB,
  projectId: number,
  workId: number
): RankingRowDTO | null {
  return getRanking(db, projectId, 'relevance', { workId })[0] ?? null
}

/** How many papers a project marks as dossier reference papers. */
export function countReferencePapers(db: DB, projectId: number): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM project_work pw
          WHERE pw.project_id = ? AND pw.is_reference = 1`
      )
      .get(projectId) as { c: number }
  ).c
}

export function countRanking(db: DB, projectId: number): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS c
           FROM project_work pw
           JOIN work w ON w.id = pw.work_id
          WHERE pw.project_id = ?`
      )
      .get(projectId) as { c: number }
  ).c
}

export function setInclusionStatus(
  db: DB,
  projectId: number,
  workId: number,
  status: string,
  reason: string | undefined,
  now: string
): void {
  db.prepare(
    `UPDATE project_work
       SET inclusion_status = ?, exclusion_reason = ?, reviewed = 1, updated_at = ?
       WHERE project_id = ? AND work_id = ?`
  ).run(status, reason ?? null, now, projectId, workId)
}

export function overrideScore(
  db: DB,
  projectId: number,
  workId: number,
  field: 'relevance' | 'expansion_priority',
  value: number,
  reason: string | undefined,
  now: string
): void {
  const row = db
    .prepare(
      `SELECT relevance, expansion_priority, user_overrides FROM project_work
       WHERE project_id = ? AND work_id = ?`
    )
    .get(projectId, workId) as
    | { relevance: number | null; expansion_priority: number | null; user_overrides: string | null }
    | undefined
  if (!row) throw new Error(`project_work (${projectId},${workId}) not found`)

  let overrides: Record<string, unknown> = {}
  if (row.user_overrides) {
    try {
      overrides = JSON.parse(row.user_overrides)
    } catch {
      overrides = {}
    }
  }
  const was = field === 'relevance' ? row.relevance : row.expansion_priority
  overrides[field] = { was, now: value, by: 'user', reason: reason ?? null }

  // ONE TRANSACTION over the score AND the positions derived from it. This is
  // called straight from an IPC handler, which has no ambient transaction, so
  // a throw between the two writes would commit a score while every rank in
  // the project still described the previous order — and no sweep would repair
  // it, because an overridden score is exactly what the sweep declines to
  // touch.
  db.transaction(() => {
    db.prepare(
      `UPDATE project_work
         SET ${field} = ?, user_overrides = ?, reviewed = 1, updated_at = ?
         WHERE project_id = ? AND work_id = ?`
    ).run(value, JSON.stringify(overrides), now, projectId, workId)
    recomputeRanks(db, projectId)
  })()
}

// ============================================================ documents
export function getWorkDocuments(db: DB, workId: number): DocumentDTO[] {
  const docs = db
    .prepare(
      /* sql */ `
      SELECT id, work_id, version_kind, title, content_status, retrieval_status,
             is_preferred, source_url, text_source, text_confidence
      FROM document WHERE work_id = ?
      ORDER BY is_preferred DESC, id ASC
    `
    )
    .all(workId) as Array<Omit<DocumentDTO, 'file'>>

  const fileStmt = db.prepare(
    /* sql */ `
    SELECT fl.id, bd.label AS base_dir_label, bd.kind AS base_dir_kind,
           fl.relative_path, fl.hash, fl.size_bytes, fl.role
    FROM file_location fl
    JOIN base_dir bd ON bd.id = fl.base_dir_id
    WHERE fl.document_id = ?
    ORDER BY fl.id ASC LIMIT 1
  `
  )

  return docs.map((d) => ({
    ...d,
    file: (fileStmt.get(d.id) as FileLocationDTO | undefined) ?? null
  }))
}

// ============================================================ analyses / facts
/**
 * Batch-load fold_improvement rows for a set of measurement ids and return a
 * `measurementId -> FoldImprovementDTO` map (first fold per measurement). One
 * `WHERE measurement_id IN (...)` query instead of one-per-measurement — the
 * same batch-and-stitch pattern used by getGraph (C-M2 / C-m4 N+1 fix).
 */
function loadFoldsByMeasurementIds(db: DB, measurementIds: number[]): Map<number, FoldImprovementDTO> {
  const byMeasurement = new Map<number, FoldImprovementDTO>()
  if (measurementIds.length === 0) return byMeasurement
  const placeholders = measurementIds.map(() => '?').join(',')
  const rows = db
    .prepare(
      /* sql */ `
      SELECT id, measurement_id, baseline_label, improved_label, fold, comparability
      FROM fold_improvement WHERE measurement_id IN (${placeholders})
      ORDER BY measurement_id ASC, id ASC
    `
    )
    .all(...measurementIds) as Array<FoldImprovementDTO & { measurement_id: number }>
  for (const r of rows) {
    // Keep the first fold per measurement (id ASC) to match the prior LIMIT 1.
    if (!byMeasurement.has(r.measurement_id)) {
      const { measurement_id: _m, ...fold } = r
      byMeasurement.set(r.measurement_id, fold)
    }
  }
  return byMeasurement
}

/**
 * Batch-load measurements (with their folds stitched in) for a set of fact ids.
 * Returns a `factId -> MeasurementDTO` map (first measurement per fact, matching
 * the prior LIMIT 1). Two queries total (measurements, then folds) regardless of
 * fact count — replaces the previous per-fact + per-measurement N+1.
 */
function loadMeasurementsByFactIds(db: DB, factIds: number[]): Map<number, MeasurementDTO> {
  const byFact = new Map<number, MeasurementDTO>()
  if (factIds.length === 0) return byFact
  const placeholders = factIds.map(() => '?').join(',')
  const rows = db
    .prepare(
      /* sql */ `
      SELECT id, fact_id, quantity, value_num, value_text, unit, error_num, conditions
      FROM measurement WHERE fact_id IN (${placeholders})
      ORDER BY fact_id ASC, id ASC
    `
    )
    .all(...factIds) as Array<Omit<MeasurementDTO, 'fold'> & { fact_id: number }>
  const foldByMeasurement = loadFoldsByMeasurementIds(
    db,
    rows.map((r) => r.id)
  )
  for (const r of rows) {
    // First measurement per fact (id ASC) mirrors the prior LIMIT 1.
    if (!byFact.has(r.fact_id)) {
      const { fact_id: _f, ...measurement } = r
      byFact.set(r.fact_id, { ...measurement, fold: foldByMeasurement.get(r.id) ?? null })
    }
  }
  return byFact
}

/** How many analysis runs this paper has in this project. Same WHERE as the read. */
export function countWorkAnalyses(db: DB, workId: number, projectId: number): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM analysis_run ar
          WHERE ar.work_id = ? AND (ar.project_id = ? OR ar.project_id = 0)`
      )
      .get(workId, projectId) as { c: number }
  ).c
}

export function getWorkAnalyses(
  db: DB,
  workId: number,
  projectId: number,
  // No LIMIT unless one is asked for: the Paper screen shows the whole run
  // history. Each run drags its evidence, facts, measurements and checks behind
  // it, so a bounded caller wants the bound before that batch load, not after.
  page: { limit?: number; offset?: number } = {}
): AnalysisRunDTO[] {
  const limitClause = page.limit === undefined ? '' : '\n      LIMIT ? OFFSET ?'
  const limitParams =
    page.limit === undefined ? [] : [Math.max(1, page.limit), Math.max(0, page.offset ?? 0)]
  const runs = db
    .prepare(
      /* sql */ `
      SELECT ar.id, ar.work_id, ar.project_id, ar.analysis_type, ar.schema_id, ar.model,
             ar.provider, ar.prompt_version, ar.schema_version, ar.run_timestamp,
             ar.verifier_result, ar.deterministic_validation,
             ar.supplied_project_context, ar.user_corrections, ar.superseded,
             ar.doc_input_hash, ar.prompt_input_hash, ar.schema_input_hash,
             ar.dossier_input_hash, ar.created_at,
             -- WHERE the run happened. Carried on every run rather than derived
             -- app-side, because a database can legitimately hold shipped and
             -- locally-computed analyses side by side and only the row knows
             -- which it is.
             ar.run_origin, ar.origin_note,
             -- The schema's NAME, not only its id. schema_id joined the
             -- one-current-run key at v15, so two CURRENT runs of one
             -- analysis_type legitimately coexist and differ ONLY by it — and an
             -- integer is not something a reader can tell apart on a tab strip.
             -- LEFT JOIN: schema_id = 0 is the generic, schema-less run.
             es.name AS schema_name
      FROM analysis_run ar
      LEFT JOIN extraction_schema es ON es.id = ar.schema_id
      WHERE ar.work_id = ? AND (ar.project_id = ? OR ar.project_id = 0)
      ORDER BY ar.superseded ASC, ar.run_timestamp DESC, ar.id DESC${limitClause}
    `
    )
    .all(workId, projectId, ...limitParams) as Array<
    Omit<AnalysisRunDTO, 'facts' | 'evidence' | 'checks' | 'freshness'>
  >
  if (runs.length === 0) return []

  // Batch-load evidence + facts + measurements + folds across ALL runs by the
  // run-id list, then stitch in JS — mirrors getGraph, eliminates the per-run /
  // per-fact N+1 (C-m4). Bounded by one work, but keeps the shape identical.
  const runIds = runs.map((r) => r.id)
  const runPlaceholders = runIds.map(() => '?').join(',')

  const evidenceRows = db
    .prepare(
      /* sql */ `
      SELECT id, analysis_run_id, document_id, page, section, paragraph, sentence, figure,
             "table" AS "table", "row" AS "row", caption, quote, verbatim
      FROM evidence_span WHERE analysis_run_id IN (${runPlaceholders}) ORDER BY id ASC
    `
    )
    // SQLite has no boolean: `verbatim` arrives as the integer 0/1, so map it
    // before it reaches the DTO — otherwise `verbatim: boolean` would be a 0
    // masquerading as false only under truthiness, and `=== true` would fail.
    .all(...runIds)
    .map((r) => {
      const row = r as Omit<EvidenceSpanDTO, 'verbatim'> & {
        analysis_run_id: number
        verbatim: number
      }
      return { ...row, verbatim: row.verbatim === 1 }
    }) as Array<EvidenceSpanDTO & { analysis_run_id: number }>

  const factRows = db
    .prepare(
      /* sql */ `
      SELECT id, analysis_run_id, evidence_span_id, kind, predicate, subject, object, value_text
      FROM fact WHERE analysis_run_id IN (${runPlaceholders}) ORDER BY id ASC
    `
    )
    .all(...runIds) as Array<{
    id: number
    analysis_run_id: number
    evidence_span_id: number | null
    kind: string
    predicate: string
    subject: string | null
    object: string | null
    value_text: string | null
  }>

  const measByFact = loadMeasurementsByFactIds(
    db,
    factRows.map((r) => r.id)
  )

  const evidenceByRun = new Map<number, EvidenceSpanDTO[]>()
  const evById = new Map<number, EvidenceSpanDTO>()
  for (const e of evidenceRows) {
    const { analysis_run_id, ...span } = e
    evById.set(span.id, span)
    const list = evidenceByRun.get(analysis_run_id)
    if (list) list.push(span)
    else evidenceByRun.set(analysis_run_id, [span])
  }

  const factsByRun = new Map<number, FactDTO[]>()
  for (const r of factRows) {
    const fact: FactDTO = {
      id: r.id,
      kind: r.kind,
      predicate: r.predicate,
      subject: r.subject,
      object: r.object,
      value_text: r.value_text,
      evidence: r.evidence_span_id != null ? (evById.get(r.evidence_span_id) ?? null) : null,
      measurement: measByFact.get(r.id) ?? null
    }
    const list = factsByRun.get(r.analysis_run_id)
    if (list) list.push(fact)
    else factsByRun.set(r.analysis_run_id, [fact])
  }

  // The verdicts behind each run's `deterministic_validation`
  // bit. Batched by run-id list like everything else here.
  const checkRows = db
    .prepare(
      /* sql */ `
      SELECT id, analysis_run_id, check_key, status, reason, fact_id, measurement_id,
             model, prompt_version
      FROM analysis_check WHERE analysis_run_id IN (${runPlaceholders}) ORDER BY id ASC
    `
    )
    .all(...runIds) as Array<Omit<AnalysisCheckDTO, 'label'> & { analysis_run_id: number }>
  const checksByRun = new Map<number, AnalysisCheckDTO[]>()
  for (const c of checkRows) {
    const { analysis_run_id, ...rest } = c
    // The label is resolved HERE from the engine's own registry, so the renderer
    // never has to keep a parallel copy of the check vocabulary in sync.
    const dto: AnalysisCheckDTO = { ...rest, label: CHECK_LABELS[rest.check_key] ?? rest.check_key }
    const list = checksByRun.get(analysis_run_id)
    if (list) list.push(dto)
    else checksByRun.set(analysis_run_id, [dto])
  }

  // ONE cache across every run of this work: the dossier build and the document
  // bodies depend on the work, not on which run is being judged, so recomputing
  // them per run would repeat the same JOIN and text scan for an answer that
  // cannot differ — reintroducing the N+1 this function was cleaned of.
  const freshnessCache = newFreshnessCache()
  return runs.map((r) => ({
    ...r,
    evidence: evidenceByRun.get(r.id) ?? [],
    facts: factsByRun.get(r.id) ?? [],
    checks: checksByRun.get(r.id) ?? [],
    // Derived HERE, not in the renderer: answering it means rehashing source
    // text out of the DB, which the renderer has no access to. Read-only — no
    // run is reprocessed or rewritten by asking the question.
    freshness: computeAnalysisFreshness(db, r, { currentDossierInputHash }, freshnessCache)
  }))
}

// ============================================================ extraction rows
/**
 * Single source of truth for a measurement/extraction record's derived status.
 * Reused by getExtractionRows AND getExtractionStatusSummary (A-M4) so the
 * summary counts always agree with the per-row chips.
 */
function deriveExtractionStatus(
  factKind: string,
  verifierResult: string | null,
  reviewFailed: boolean
): ExtractionRowDTO['status'] {
  if (factKind === 'uncertain-conflicting') return 'conflict'
  // `verifier_result` describes the RUN — whether the model's answer parsed and
  // survived validation as a whole. `partial` is the ORDINARY outcome of a long
  // extraction: the reply was truncated and salvaged, or some claims were
  // dropped for citing evidence that could not be located. Reading it per row
  // condemned every other record in the same run along with them. One run here
  // holds 17 measurements, 6 of which actually failed a check, and all 17 were
  // badged "needs interpretation" — which empties the badge of meaning exactly
  // where it should be doing its work.
  //
  // The per-record verdicts are already in `analysis_check`, keyed to the fact
  // and the measurement they judged, so each row now answers for itself.
  if (verifierResult === 'failed') return 'invalid'
  if (reviewFailed) return 'review'
  return 'validated'
}

// Row shape shared by getExtractionRows and getExtractionStatusSummary. Both
// select the same columns so their statuses are computed identically.
interface ExtractionRawRow {
  measurement_id: number | null
  work_id: number
  work_title: string
  quantity: string
  value_num: number | null
  value_text: string | null
  unit: string | null
  conditions: string | null
  fact_kind: string
  subject: string | null
  fact_id: number
  evidence_span_id: number | null
  verifier_result: string | null
  row_review_failed: number
  run_origin: string
  origin_note: string | null
  // evidence_span columns, LEFT-JOINed (null when the fact has no span).
  es_id: number | null
  es_document_id: number | null
  es_page: number | null
  es_section: string | null
  es_paragraph: number | null
  es_sentence: number | null
  es_figure: string | null
  es_table: string | null
  es_row: string | null
  es_caption: string | null
  es_quote: string | null
  es_verbatim: number | null
  // Schema linkage, resolved from measurement.field_id when there is a
  // measurement, else from the fact's predicate against the run's own schema.
  // Null when neither resolves to a field.
  field_id: number | null
  field_key: string | null
  field_label: string | null
  field_unit: string | null
  field_type: string | null
  field_sort_order: number | null
  schema_id: number | null
  schema_key: string | null
  schema_name: string | null
  run_schema_id: number | null
  run_schema_name: string | null
}

// SELECT list + JOINs shared by the extraction queries. evidence_span is folded
// in via LEFT JOIN (was a per-row point lookup — the C-M2 N+1). fold_improvement
// is batch-loaded separately (a measurement can have >1 fold row; a JOIN would
// fan out rows).
//
// The driving table is FACT, not measurement. A measurement quantifies a NUMBER;
// a text/enum field (variant, mutations, substrate, buffer, method) is carried by
// the fact alone, with no measurement row to hang it on. Driving from measurement
// therefore made every text field in every schema unreachable by this table — the
// values were extracted and stored, and the only screen meant to show them could
// not see them. The measurement is now LEFT-JOINed: it supplies the numeric value
// when there is one, and its absence is a value shape rather than an exclusion.
//
// Field linkage resolves from `fact.field_id` — the ONE binding site (v41) — and
// falls back to `measurement.field_id` for rows written before the fact carried
// one. The former third step, matching the fact's PREDICATE against the run's
// schema, is gone: it was a synonym rule, and a lossy one, since it could bind
// `variant` but never `enzyme variant` or `Enzyme variant name`. The model is now
// asked for the key and refused if it does not give a declared one, so a NULL
// here means the value genuinely names no field.
//
// A fact is in scope when it HAS a measurement (whatever the run type — this is
// exactly the previous row set, so nothing that used to show can stop showing) OR
// it belongs to an extraction run. Summary/classification runs also produce
// measurement-less facts, and those are prose, not table records.
const EXTRACTION_SELECT = (): string => /* sql */ `
  SELECT m.id AS measurement_id, w.id AS work_id, w.title AS work_title,
         COALESCE(m.quantity, f.predicate) AS quantity,
         m.value_num,
         -- f.object is the third fallback because a TEXT field arrives as a
         -- triple, not as a value: the model answers
         -- (subject "KE07", predicate "has_variant", object "Round 2 11/10D")
         -- and the object IS the value. Reading only value_text rendered 64 of
         -- this corpus's 452 records — every variant, substrate, mutation and
         -- buffer — as an em dash meaning "never reported", while the datum sat
         -- one column away. A cell that denies having data it holds is worse
         -- than a missing feature.
         COALESCE(m.value_text, f.value_text, f.object) AS value_text,
         m.unit, m.conditions,
         f.kind AS fact_kind, f.id AS fact_id, f.evidence_span_id,
         f.subject,
         ar.verifier_result, ar.run_origin, ar.origin_note,
         -- Which reviewed verdicts contradicted THIS record. analysis_check
         -- records every verdict against the fact and the measurement it
         -- judged, so the answer is per-row and need not be inferred from the
         -- run.
         EXISTS (
           SELECT 1 FROM analysis_check c
            WHERE c.status = 'failed'
              AND (c.fact_id = f.id OR (m.id IS NOT NULL AND c.measurement_id = m.id))
         ) AS row_review_failed,
         es.id AS es_id, es.document_id AS es_document_id, es.page AS es_page,
         es.section AS es_section, es.paragraph AS es_paragraph, es.sentence AS es_sentence,
         es.figure AS es_figure, es."table" AS es_table, es."row" AS es_row,
         es.caption AS es_caption, es.quote AS es_quote, es.verbatim AS es_verbatim,
         ef.id AS field_id, ef.key AS field_key, ef.label AS field_label,
         ef.unit AS field_unit, ef.data_type AS field_type,
         ef.sort_order AS field_sort_order,
         xs.id AS schema_id, xs.key AS schema_key, xs.name AS schema_name,
         rxs.id AS run_schema_id, rxs.name AS run_schema_name
  FROM fact f
  JOIN analysis_run ar ON ar.id = f.analysis_run_id
  JOIN work w ON w.id = ar.work_id
  LEFT JOIN measurement m ON m.fact_id = f.id
  LEFT JOIN evidence_span es ON es.id = f.evidence_span_id
  LEFT JOIN extraction_field ef ON ef.id = COALESCE(f.field_id, m.field_id)
  LEFT JOIN extraction_schema xs ON xs.id = ef.schema_id
  -- The schema the RUN was aimed at, which is NOT the schema the value landed
  -- in and may exist where the latter does not. A paper extracted under two
  -- schemas yields two runs over the same text, so the same number can be
  -- reported twice: once mapped, once left over from the run that was looking
  -- for something else. Naming the run is what tells those two apart.
  LEFT JOIN extraction_schema rxs ON rxs.id = ar.schema_id
  WHERE ar.superseded = 0 AND (ar.project_id = ? OR ar.project_id = 0)
    AND (m.id IS NOT NULL OR ar.analysis_type = 'extraction')
`

/**
 * Stable identity for one extraction row.
 *
 * Not `measurement_id`: a text record has no measurement. Not `fact_id` alone
 * either — a fact MAY carry several measurements (the schema permits it), and
 * the LEFT JOIN then yields one row per measurement, so the fact id would
 * collide. The pair is unique by construction and is what React keys on and what
 * the screen addresses an expanded cell by. The Review queue is unaffected: it
 * still works in `fact_id`, which every row carries.
 */
function extractionRowKey(factId: number, measurementId: number | null): string {
  return measurementId == null ? `f${factId}` : `f${factId}m${measurementId}`
}

/** Reconstruct an EvidenceSpanDTO from the LEFT-JOINed es_* columns (or null). */
function evidenceFromRow(r: ExtractionRawRow): EvidenceSpanDTO | null {
  if (r.es_id == null) return null
  return {
    id: r.es_id,
    document_id: r.es_document_id,
    page: r.es_page,
    section: r.es_section,
    paragraph: r.es_paragraph,
    sentence: r.es_sentence,
    figure: r.es_figure,
    table: r.es_table,
    row: r.es_row,
    caption: r.es_caption,
    quote: r.es_quote,
    // 0/1 from SQLite -> boolean, so callers cannot accidentally treat the
    // integer 0 as "present" via a truthiness check.
    verbatim: r.es_verbatim === 1
  }
}

/**
 * How many extraction rows this project has.
 *
 * The same SELECT, counted. Not `COUNT(DISTINCT f.id)`: the LEFT JOIN to
 * `measurement` legitimately yields one row per measurement of a fact, and the
 * table shows every one of them — a count that collapsed them would tell the
 * caller there are fewer rows than it will receive.
 */
export function countExtractionRows(db: DB, projectId: number, workId?: number): number {
  // `w.id = ?` goes INSIDE the select, beside the project predicate, not into a
  // WHERE wrapped around it: outside, SQLite must materialise every row of the
  // project — five LEFT JOINs and two correlated EXISTS apiece — before
  // discarding all but one paper's, on the thread that draws the window.
  const workClause = workId === undefined ? '' : '\n    AND w.id = ?'
  return (
    db
      .prepare(`SELECT COUNT(*) AS c FROM (${EXTRACTION_SELECT()}${workClause})`)
      .get(projectId, ...(workId === undefined ? [] : [workId])) as { c: number }
  ).c
}

export function getExtractionRows(
  db: DB,
  projectId: number,
  // `workId` narrows to ONE paper IN SQL, before any LIMIT. Filtering afterwards
  // returns an empty page — and a confident "this paper has no extracted values"
  // — for any paper whose title sorts past the page boundary.
  page: { limit?: number; offset?: number; workId?: number } = {}
): ExtractionRowDTO[] {
  // Paged over the EXISTING order, never over `row_key`. The order below is
  // `title, measurement id, fact id` and the export is byte-stable under it;
  // `row_key` is `f{id}m{id}`, a different ordering, so paging by it would
  // reshuffle the table and an export assembled page by page would no longer
  // match one taken in a single read.
  const limitClause = page.limit === undefined ? '' : '\n      LIMIT ? OFFSET ?'
  const limitParams =
    page.limit === undefined ? [] : [Math.max(1, page.limit), Math.max(0, page.offset ?? 0)]
  const workClause = page.workId === undefined ? '' : '\n    AND w.id = ?'
  const workParams = page.workId === undefined ? [] : [page.workId]

  const rows = db
    .prepare(
      EXTRACTION_SELECT() +
        workClause +
        // Ties on measurement id (every text row has none) fall through to
        // fact id, so the order is total and the export stays byte-stable.
        '\n      ORDER BY w.title COLLATE NOCASE ASC, m.id ASC, f.id ASC' +
        limitClause
    )
    .all(projectId, ...workParams, ...limitParams) as ExtractionRawRow[]

  // Batch-load all folds for these measurements in ONE query (mirrors getGraph).
  const foldByMeasurement = loadFoldsByMeasurementIds(
    db,
    rows.map((r) => r.measurement_id).filter((id): id is number => id != null)
  )

  return rows.map((r) => ({
    row_key: extractionRowKey(r.fact_id, r.measurement_id),
    measurement_id: r.measurement_id,
    fact_id: r.fact_id,
    work_id: r.work_id,
    work_title: r.work_title,
    quantity: r.quantity,
    value_num: r.value_num,
    value_text: r.value_text,
    unit: r.unit,
    conditions: r.conditions,
    subject: r.subject,
    fact_kind: r.fact_kind,
    fold: r.measurement_id == null ? null : foldByMeasurement.get(r.measurement_id) ?? null,
    evidence: evidenceFromRow(r),
    status: deriveExtractionStatus(
      r.fact_kind,
      r.verifier_result,
      r.row_review_failed === 1
    ),
    // Where the run came from. Carried so the screen can say that a value was
    // shipped with the app rather than computed here — the CSV export already
    // did, which made the file more honest than the table it came from.
    run_origin: r.run_origin as RunOrigin,
    origin_note: r.origin_note,
    // Schema linkage — LEFT JOINed to at most one field (`extraction_field` is
    // UNIQUE(schema_id, key)), so the row COUNT is unchanged by it and the A-M4
    // invariant (summary.total === rows.length) holds.
    field_id: r.field_id,
    field_key: r.field_key,
    field_label: r.field_label,
    field_unit: r.field_unit,
    field_type: (r.field_type as ExtractionFieldType | null) ?? null,
    field_sort_order: r.field_sort_order,
    schema_id: r.schema_id,
    schema_key: r.schema_key,
    schema_name: r.schema_name,
    run_schema_id: r.run_schema_id,
    run_schema_name: r.run_schema_name
  }))
}

// ============================================================ extraction schemas
// First-class, user-editable definitions of WHAT to extract. The Extraction
// screen derives its columns from these rows, the LLM prompt is built from them,
// and exports resolve their format name from `export_alias`. No domain literal
// lives here — every schema/field below is read from (or written to) SQLite.

interface SchemaRawRow {
  id: number
  // No project_id: schemas are global (migration v5). The column still exists in
  // SQLite as a constant-0 vestige but is never selected or read.
  key: string
  name: string
  description: string | null
  version: string
  is_builtin: number
  export_alias: string | null
}
interface FieldRawRow {
  id: number
  schema_id: number
  key: string
  label: string
  data_type: string
  unit: string | null
  required: number
  enum_options: string | null
  description: string | null
  param_hash: string
  sort_order: number
}

/** Parse the stored enum_options JSON defensively (never throws to the caller). */
function parseEnumOptions(raw: string | null): string[] | null {
  if (raw == null) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) return parsed.map((v) => String(v))
  } catch {
    /* malformed row → treat as unconstrained */
  }
  return null
}

function fieldFromRow(r: FieldRawRow): ExtractionFieldDTO {
  return {
    id: r.id,
    schema_id: r.schema_id,
    key: r.key,
    label: r.label,
    data_type: r.data_type as ExtractionFieldType,
    unit: r.unit,
    required: r.required === 1,
    enum_options: parseEnumOptions(r.enum_options),
    description: r.description,
    param_hash: r.param_hash,
    sort_order: r.sort_order
  }
}

/**
 * GLOBAL measurement count per schema: every measurement linked to one of the
 * schema's fields, from any non-superseded run in any project. Global because
 * the schema itself is — the Schemas screen is reachable with no project open,
 * so a project-scoped number would have nothing to scope to. The per-project
 * figures the Extraction screen shows come from `getSchemaCoverage`.
 *
 * A RETRACTED fact is not counted. A reader with the paper in front of it said
 * the record should not exist (migration v52), and a number claiming "this
 * schema has collected 3 962 values" must not include the ones a reading
 * withdrew. The row itself survives and still exports — this is a count, not a
 * filter on the data.
 */
function schemaMeasurementCounts(db: DB): Map<number, number> {
  const rows = db
    .prepare(
      /* sql */ `
      SELECT ef.schema_id AS schema_id, COUNT(*) AS c
      FROM measurement m
      JOIN fact f ON f.id = m.fact_id
      JOIN analysis_run ar ON ar.id = f.analysis_run_id
      JOIN extraction_field ef ON ef.id = m.field_id
      WHERE ar.superseded = 0 AND f.retracted_by_check_id IS NULL
      GROUP BY ef.schema_id
    `
    )
    .all() as { schema_id: number; c: number }[]
  return new Map(rows.map((r) => [r.schema_id, r.c]))
}

/** How many projects currently attach each schema (drives the delete warning). */
function schemaAttachmentCounts(db: DB): Map<number, number> {
  const rows = db
    .prepare('SELECT schema_id, COUNT(*) AS c FROM project_schema GROUP BY schema_id')
    .all() as { schema_id: number; c: number }[]
  return new Map(rows.map((r) => [r.schema_id, r.c]))
}

/** Shared field + count hydration for a set of raw schema rows (ONE query each). */
function hydrateSchemas(db: DB, schemas: SchemaRawRow[]): ExtractionSchemaDTO[] {
  if (schemas.length === 0) return []
  const ids = schemas.map((s) => s.id)
  const fields = db
    .prepare(
      `SELECT id, schema_id, key, label, data_type, unit, required, enum_options, description, param_hash, sort_order
       FROM extraction_field
       WHERE schema_id IN (${ids.map(() => '?').join(',')})
       ORDER BY sort_order ASC, id ASC`
    )
    .all(...ids) as FieldRawRow[]

  const byShema = new Map<number, ExtractionFieldDTO[]>()
  for (const f of fields) {
    const list = byShema.get(f.schema_id) ?? []
    list.push(fieldFromRow(f))
    byShema.set(f.schema_id, list)
  }
  const counts = schemaMeasurementCounts(db)
  const attached = schemaAttachmentCounts(db)

  return schemas.map((s) => ({
    id: s.id,
    key: s.key,
    name: s.name,
    description: s.description,
    version: s.version,
    is_builtin: s.is_builtin === 1,
    export_alias: s.export_alias,
    fields: byShema.get(s.id) ?? [],
    measurement_count: counts.get(s.id) ?? 0,
    attached_project_count: attached.get(s.id) ?? 0
  }))
}

/**
 * EVERY schema in the app. Schemas are global (migration v5): there is one
 * definition list, shared by all projects, so this takes no project id. Fields
 * are batch-loaded in ONE query and ordered by (sort_order, id) — the id
 * tiebreak keeps column order stable when two fields share a sort_order, which
 * the e2e column assertions depend on.
 */
export function listExtractionSchemas(db: DB): ExtractionSchemaDTO[] {
  const schemas = db
    .prepare(
      /* sql */ `
      SELECT id, key, name, description, version, is_builtin, export_alias
      FROM extraction_schema
      ORDER BY is_builtin DESC, id ASC
    `
    )
    .all() as SchemaRawRow[]
  return hydrateSchemas(db, schemas)
}

/**
 * The schemas a project APPLIES in its Extraction view, in attachment order.
 * Detaching a schema removes only this row — never the definition, never a
 * measurement.
 */
export function listProjectSchemas(db: DB, projectId: number): ExtractionSchemaDTO[] {
  const schemas = db
    .prepare(
      /* sql */ `
      SELECT s.id, s.key, s.name, s.description, s.version, s.is_builtin, s.export_alias
      FROM project_schema ps
      JOIN extraction_schema s ON s.id = ps.schema_id
      WHERE ps.project_id = ?
      ORDER BY ps.sort_order ASC, s.id ASC
    `
    )
    .all(projectId) as SchemaRawRow[]
  return hydrateSchemas(db, schemas)
}

/**
 * Attach a global schema to a project's Extraction view. Idempotent (INSERT OR
 * IGNORE on the composite PK) so a double-click can't error or duplicate.
 */
export function attachProjectSchema(
  db: DB,
  projectId: number,
  schemaId: number,
  now: string
): ExtractionSchemaDTO[] {
  const exists = db
    .prepare('SELECT 1 AS ok FROM extraction_schema WHERE id = ?')
    .get(schemaId) as { ok: number } | undefined
  if (!exists) throw new Error(`extraction schema ${schemaId} not found`)
  const next = (
    db
      .prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM project_schema WHERE project_id = ?')
      .get(projectId) as { n: number }
  ).n
  db.prepare(
    `INSERT OR IGNORE INTO project_schema (project_id, schema_id, sort_order, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(projectId, schemaId, next, now)
  return listProjectSchemas(db, projectId)
}

/**
 * DETACH — stop applying a schema in this project's Extraction view. The schema
 * definition is untouched (other projects keep using it) and so is every
 * measurement already extracted with it; those rows keep rendering in their own
 * section on the Extraction screen. This is deliberately NOT a delete.
 */
export function detachProjectSchema(
  db: DB,
  projectId: number,
  schemaId: number
): ExtractionSchemaDTO[] {
  db.prepare('DELETE FROM project_schema WHERE project_id = ? AND schema_id = ?').run(
    projectId,
    schemaId
  )
  return listProjectSchemas(db, projectId)
}

/**
 * REAL extraction coverage per attached schema, for one project.
 *
 * Denominator: the works LINKED TO THE PROJECT (`project_work`) — "N of this
 * project's papers". Numerator: works with AT LEAST ONE measurement on any of
 * the schema's fields, from a non-superseded run scoped to this project or to
 * the global sentinel (the same run predicate the Extraction rows use). Partial
 * extraction therefore counts as "has values", which is exactly why the UI says
 * "has at least one value" and never "complete".
 *
 * A RETRACTED fact contributes to neither number (v52): a paper whose only value
 * for a schema was withdrawn by a reading does not "have at least one value" for
 * it, and saying otherwise would hide the gap the retraction opened.
 */
export function getSchemaCoverage(db: DB, projectId: number): SchemaCoverageDTO[] {
  const worksTotal = (
    db
      .prepare('SELECT COUNT(*) AS c FROM project_work WHERE project_id = ?')
      .get(projectId) as { c: number }
  ).c

  const rows = db
    .prepare(
      /* sql */ `
      SELECT ps.schema_id                       AS schema_id,
             COUNT(DISTINCT pw.work_id)         AS works_with_values,
             -- Only measurements that survived BOTH the run predicate and the
             -- project_work join count; the LEFT JOINs otherwise leak rows whose
             -- work is not in this project.
             COUNT(DISTINCT CASE WHEN pw.work_id IS NOT NULL THEN m.id END)
                                                AS measurement_count
      FROM project_schema ps
      LEFT JOIN extraction_field ef ON ef.schema_id = ps.schema_id
      LEFT JOIN measurement m       ON m.field_id = ef.id
      -- The retraction predicate rides on the JOIN, not in the WHERE: there it
      -- would drop the schema's whole row rather than that one measurement, so
      -- a schema every one of whose values was withdrawn would vanish from the
      -- coverage list instead of reporting zero.
      LEFT JOIN fact f              ON f.id = m.fact_id
                                    AND f.retracted_by_check_id IS NULL
      LEFT JOIN analysis_run ar     ON ar.id = f.analysis_run_id
                                    AND ar.superseded = 0
                                    AND (ar.project_id = ps.project_id OR ar.project_id = 0)
      LEFT JOIN project_work pw     ON pw.work_id = ar.work_id
                                    AND pw.project_id = ps.project_id
      WHERE ps.project_id = ?
      GROUP BY ps.schema_id
      ORDER BY ps.sort_order ASC, ps.schema_id ASC
    `
    )
    .all(projectId) as { schema_id: number; works_with_values: number; measurement_count: number }[]

  // `works_with_values` can never exceed `works_total`: COUNT(DISTINCT …)
  // ignores the NULLs the LEFT JOINs produce, and ux_project_work(project_id,
  // work_id) makes the project_work join 1:1. So the subtraction below is exact
  // — no clamp, which would only mask a future regression rather than fix one.
  return rows.map((r) => ({
    schema_id: r.schema_id,
    works_total: worksTotal,
    works_with_values: r.works_with_values,
    works_without_values: worksTotal - r.works_with_values,
    measurement_count: r.measurement_count
  }))
}

/** One schema with its fields + counts. Throws if the id does not exist. */
export function getExtractionSchema(db: DB, schemaId: number): ExtractionSchemaDTO {
  const rows = db
    .prepare(
      `SELECT id, key, name, description, version, is_builtin, export_alias
       FROM extraction_schema WHERE id = ?`
    )
    .all(schemaId) as SchemaRawRow[]
  const [dto] = hydrateSchemas(db, rows)
  if (!dto) throw new Error(`extraction schema ${schemaId} not found`)
  return dto
}

/**
 * Slugify a human name into a stable machine identifier. Underscores are
 * PRESERVED (the seeded field keys use them — kcat_km, half_life, buffer_ph),
 * so a key that already matches what the seed writes round-trips unchanged.
 */
function normalizeKey(raw: string): string {
  const k = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
  if (!k) throw new Error('name must contain at least one alphanumeric character')
  return k
}

/**
 * A key is DERIVED from the display name, so two schemas named alike would
 * collide on the global UNIQUE(key). Rather than reject the name (the user
 * never chose the key and cannot fix a conflict they cannot see), disambiguate
 * with a numeric suffix.
 */
function uniqueSchemaKey(db: DB, name: string, excludeId?: number): string {
  const base = normalizeKey(name)
  const taken = db.prepare(
    `SELECT 1 FROM extraction_schema WHERE key = ? AND id IS NOT ?`
  )
  let key = base
  for (let n = 2; taken.get(key, excludeId ?? null) !== undefined; n++) key = `${base}-${n}`
  return key
}

export function createExtractionSchema(
  db: DB,
  input: SchemaInput,
  now: string
): ExtractionSchemaDTO {
  const info = db
    .prepare(
      // project_id is written as the LITERAL 0. Schemas are global; the column
      // survives only as a vestige (migration v5) and must stay constant so the
      // global UNIQUE(key) can never be reintroduced-around.
      `INSERT INTO extraction_schema
         (project_id, key, name, description, version, is_builtin, export_alias, created_at, updated_at)
       VALUES (0, ?, ?, ?, ?, 0, NULL, ?, ?)`
    )
    .run(
      uniqueSchemaKey(db, input.name),
      input.name,
      input.description ?? null,
      // A schema is born with no fields, so its version is the hash of the
      // empty field list — a real value, not a placeholder to be bumped later.
      schemaVersionFromHashes([]),
      now,
      now
    )
  return getExtractionSchema(db, Number(info.lastInsertRowid))
}

export function updateExtractionSchema(
  db: DB,
  schemaId: number,
  input: SchemaInput,
  now: string
): ExtractionSchemaDTO {
  const row = db
    .prepare('SELECT id FROM extraction_schema WHERE id = ?')
    .get(schemaId) as { id: number } | undefined
  if (!row) throw new Error(`extraction schema ${schemaId} not found`)
  // `version` is NOT written here: renaming a schema changes no field, so it
  // must not invalidate a single run made against it.
  db.prepare(
    `UPDATE extraction_schema
       SET key = ?, name = ?, description = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    uniqueSchemaKey(db, input.name, schemaId),
    input.name,
    input.description ?? null,
    now,
    schemaId
  )
  return getExtractionSchema(db, schemaId)
}

/**
 * Delete a user schema GLOBALLY. Built-ins are RESTRICTED: they back the seeded
 * corpus and the DB-resolved export aliases, so one click must not silently
 * unlink all seeded extraction data. Fields cascade and `project_schema`
 * attachments cascade (there is nothing left to attach), but linked measurements
 * SURVIVE with field_id -> NULL (ON DELETE SET NULL) — extraction data and its
 * provenance are never destroyed by a definition change. Those now-unlinked rows
 * keep rendering in the Extraction screen's "Unassigned" section, so a global
 * delete never makes a project's data disappear without trace.
 */
export function deleteExtractionSchema(db: DB, schemaId: number): ExtractionSchemaDTO[] {
  const row = db
    .prepare('SELECT is_builtin FROM extraction_schema WHERE id = ?')
    .get(schemaId) as { is_builtin: number } | undefined
  if (!row) throw new Error(`extraction schema ${schemaId} not found`)
  if (row.is_builtin === 1) throw new Error('built-in schemas cannot be deleted')
  db.prepare('DELETE FROM extraction_schema WHERE id = ?').run(schemaId)
  return listExtractionSchemas(db)
}

/** Serialize enum options; enforced non-null for data_type='enum' (DB CHECK). */
function serializeEnumOptions(input: FieldInput): string | null {
  if (input.data_type !== 'enum') return null
  const opts = (input.enum_options ?? []).map((o) => o.trim()).filter((o) => o.length > 0)
  if (opts.length === 0) throw new Error("data_type 'enum' requires at least one option")
  return JSON.stringify(opts)
}

export function createExtractionField(
  db: DB,
  schemaId: number,
  input: FieldInput,
  now: string
): ExtractionSchemaDTO {
  const owner = db
    .prepare('SELECT id FROM extraction_schema WHERE id = ?')
    .get(schemaId) as { id: number } | undefined
  if (!owner) throw new Error(`extraction schema ${schemaId} not found`)
  // Append to the end of the ordered field list unless a position is supplied.
  const next =
    input.sort_order ??
    ((
      db
        .prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM extraction_field WHERE schema_id = ?')
        .get(schemaId) as { n: number }
    ).n)
  // The key is derived from the label unless one is supplied (the seed passes
  // its own so the seeded keys — kcat_km, buffer_ph — stay byte-identical).
  const params = {
    key: normalizeKey(input.key ?? input.label),
    label: input.label,
    data_type: input.data_type,
    unit: input.unit ?? null,
    required: input.required ? 1 : 0,
    enum_options: serializeEnumOptions(input),
    description: input.description ?? null
  }
  db.prepare(
    `INSERT INTO extraction_field
       (schema_id, key, label, data_type, unit, required, enum_options, description, param_hash, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    schemaId,
    params.key,
    params.label,
    params.data_type,
    params.unit,
    params.required,
    params.enum_options,
    params.description,
    fieldParamHash(params),
    next,
    now,
    now
  )
  recomputeSchemaVersion(db, schemaId, now)
  return getExtractionSchema(db, schemaId)
}

export function updateExtractionField(
  db: DB,
  fieldId: number,
  input: FieldInput,
  now: string
): ExtractionSchemaDTO {
  const row = db
    .prepare('SELECT schema_id, sort_order FROM extraction_field WHERE id = ?')
    .get(fieldId) as { schema_id: number; sort_order: number } | undefined
  if (!row) throw new Error(`extraction field ${fieldId} not found`)
  const params = {
    key: normalizeKey(input.key ?? input.label),
    label: input.label,
    data_type: input.data_type,
    unit: input.unit ?? null,
    required: input.required ? 1 : 0,
    enum_options: serializeEnumOptions(input),
    description: input.description ?? null
  }
  db.prepare(
    `UPDATE extraction_field
       SET key = ?, label = ?, data_type = ?, unit = ?, required = ?,
           enum_options = ?, description = ?, param_hash = ?, sort_order = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    params.key,
    params.label,
    params.data_type,
    params.unit,
    params.required,
    params.enum_options,
    params.description,
    fieldParamHash(params),
    input.sort_order ?? row.sort_order,
    now,
    fieldId
  )
  // Only THIS field's hash moved; the composite is re-derived from the whole
  // ordered list, so every other field's identity is untouched.
  recomputeSchemaVersion(db, row.schema_id, now)
  return getExtractionSchema(db, row.schema_id)
}

/**
 * Rewrite the display order of one schema's fields, in ONE transaction.
 *
 * `fieldIds` must be a permutation of the schema's current field ids. That is a
 * mechanical fact — set equality of two id lists — not a judgement, and it is
 * checked because the alternatives are both silent: a SHORT list would leave the
 * unnamed fields at whatever `sort_order` they held, interleaving them through
 * the new order at positions nobody chose, and a FOREIGN id would move another
 * schema's column while this one's caller believed it had reordered its own.
 *
 * `recomputeSchemaVersion` is NOT called, and must not be. `sort_order` is
 * excluded from `fieldParamHash`, and the version is the sorted composite of
 * those hashes, so no hash this touches can move — recomputing would be a no-op
 * at best and, if the version derivation ever drifted, would re-run the corpus
 * for a cosmetic change. Only `updated_at` moves, which is the row's own
 * bookkeeping and feeds nothing that decides staleness.
 */
export function reorderExtractionFields(
  db: DB,
  schemaId: number,
  fieldIds: number[],
  now: string
): ExtractionSchemaDTO {
  const owner = db
    .prepare('SELECT id FROM extraction_schema WHERE id = ?')
    .get(schemaId) as { id: number } | undefined
  if (!owner) throw new Error(`extraction schema ${schemaId} not found`)

  const current = (
    db.prepare('SELECT id FROM extraction_field WHERE schema_id = ?').all(schemaId) as {
      id: number
    }[]
  ).map((r) => r.id)
  const currentSet = new Set(current)
  const givenSet = new Set(fieldIds)
  if (givenSet.size !== fieldIds.length) {
    throw new Error('field order lists the same field twice')
  }
  if (givenSet.size !== currentSet.size || fieldIds.some((id) => !currentSet.has(id))) {
    const missing = current.filter((id) => !givenSet.has(id))
    const foreign = fieldIds.filter((id) => !currentSet.has(id))
    throw new Error(
      `field order must name every field of schema ${schemaId} exactly once` +
        (missing.length ? `; missing ${missing.join(', ')}` : '') +
        (foreign.length ? `; not in this schema: ${foreign.join(', ')}` : '')
    )
  }

  const stmt = db.prepare(
    'UPDATE extraction_field SET sort_order = ?, updated_at = ? WHERE id = ? AND schema_id = ?'
  )
  db.transaction(() => {
    fieldIds.forEach((id, i) => stmt.run(i, now, id, schemaId))
  })()
  return getExtractionSchema(db, schemaId)
}

/** Delete a field. Measurements that filled it survive (field_id -> NULL). */
export function deleteExtractionField(db: DB, fieldId: number): ExtractionSchemaDTO {
  const row = db
    .prepare('SELECT schema_id FROM extraction_field WHERE id = ?')
    .get(fieldId) as { schema_id: number } | undefined
  if (!row) throw new Error(`extraction field ${fieldId} not found`)
  db.prepare('DELETE FROM extraction_field WHERE id = ?').run(fieldId)
  recomputeSchemaVersion(db, row.schema_id, new Date().toISOString())
  return getExtractionSchema(db, row.schema_id)
}

/**
 * One schema as a portable bundle — what Share puts on the clipboard.
 *
 * Deliberately DROPS the id, the content hash, the built-in flag, the export
 * alias and every count. All of them describe this schema's place in THIS
 * database, and a bundle that carried them would let a paste assert an identity
 * in a database it has never seen: an id that means a different schema, a hash
 * that would make the recipient's runs look current against fields they were
 * never run on. The receiving app derives all of that itself on import.
 */
export function exportSchemaBundle(db: DB, schemaId: number): SchemaBundleDTO {
  const s = getExtractionSchema(db, schemaId)
  return {
    format: SCHEMA_BUNDLE_FORMAT,
    name: s.name,
    description: s.description,
    fields: s.fields.map((f) => ({
      key: f.key,
      label: f.label,
      data_type: f.data_type,
      unit: f.unit,
      required: f.required,
      enum_options: f.enum_options,
      description: f.description
    }))
  }
}

/**
 * Create a schema and its fields from a bundle, in ONE transaction.
 *
 * ONE transaction because a paste that fails on field seven must leave nothing
 * behind: a half-built schema is worse than a rejected one, since it looks like
 * a complete definition and would silently under-extract.
 *
 * NEVER an overwrite, even when the name matches an existing schema. A shared
 * definition is a colleague's opinion; rewriting the recipient's schema of the
 * same name would change what every one of their existing runs is measured
 * against. `uniqueSchemaKey` suffixes the derived key, so the import arrives
 * alongside rather than on top, and the user resolves the duplicate themselves.
 *
 * Field keys are carried from the bundle rather than re-slugified from labels,
 * so two labs sharing a schema agree on the column identity their exports
 * print. They are still normalised — the key is app machinery and the sender's
 * database does not get to choose the recipient's identifiers.
 */
export function importSchemaBundle(
  db: DB,
  bundle: SchemaBundleDTO,
  now: string
): ExtractionSchemaDTO {
  const tx = db.transaction((): number => {
    const created = createExtractionSchema(
      db,
      { name: bundle.name, description: bundle.description },
      now
    )
    for (const [i, f] of bundle.fields.entries()) {
      createExtractionField(
        db,
        created.id,
        {
          key: f.key,
          label: f.label,
          data_type: f.data_type,
          unit: f.unit,
          required: f.required,
          enum_options: f.enum_options,
          description: f.description,
          sort_order: i
        },
        now
      )
    }
    return created.id
  })
  return getExtractionSchema(db, tx())
}

/**
 * Resolve an export format name to a schema via its DB-backed `export_alias`.
 * This is what keeps every domain format name OUT of the code: the alias is a
 * row a user set, not a literal. Returns null for unknown aliases. Global, like
 * the schemas themselves — `export_alias` is uniquely indexed app-wide, so there
 * is exactly one candidate.
 */
export function findSchemaByExportAlias(db: DB, alias: string): ExtractionSchemaDTO | null {
  const row = db
    .prepare('SELECT id FROM extraction_schema WHERE export_alias = ?')
    .get(alias) as { id: number } | undefined
  if (!row) return null
  return getExtractionSchema(db, row.id)
}

/**
 * Deterministic seeded PRNG (mulberry32). Used to pick a STABLE QC sample so the
 * same seed corpus always yields the same sampled records (§12 requires a random
 * sample, but tests/reproducibility require it not to jitter between calls).
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return (): number => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * §12 extraction-status summary: total extracted RECORDS + counts per derived
 * status (auto-validated / needs-interpretation / conflicting /
 * structurally-invalid), plus a small deterministic random QC sample drawn from
 * the OTHERWISE-validated records (the ones that would never enter the
 * uncertainty-first review queue).
 * Counts are derived from the SAME status logic as getExtractionRows. (A-M4.)
 *
 * A record is not necessarily a measurement: a text field (variant, substrate)
 * is one extracted record carrying no measurement at all. The count must equal
 * `getExtractionRows().length`, so it counts what that returns.
 */
/**
 * How many auto-validated records to spot-check.
 *
 * A PROPORTION, not a flat count: with a fixed 5 and a small corpus the sample
 * equalled the population, so it "sampled" every record and demonstrated
 * nothing. A share keeps the audit meaningful as the corpus grows, with a floor
 * so a handful of records still gets checked and a cap so a large project does
 * not hand the reviewer hundreds of items.
 */
function qcSampleCount(validated: number): number {
  if (validated === 0) return 0
  return Math.max(Math.min(3, validated), Math.min(10, Math.ceil(validated * 0.1)))
}

export function getExtractionStatusSummary(
  db: DB,
  projectId: number,
  opts: { qcSampleSize?: number } = {}
): ExtractionStatusSummaryDTO {
  const rows = db
    .prepare(EXTRACTION_SELECT() + '\n      ORDER BY m.id ASC, f.id ASC')
    .all(projectId) as ExtractionRawRow[]

  let auto_validated = 0
  let needs_interpretation = 0
  let conflicting = 0
  let structurally_invalid = 0
  const validated: ExtractionQcSampleDTO[] = []
  for (const r of rows) {
    const status = deriveExtractionStatus(
      r.fact_kind,
      r.verifier_result,
      r.row_review_failed === 1
    )
    if (status === 'validated') {
      auto_validated++
      validated.push({
        row_key: extractionRowKey(r.fact_id, r.measurement_id),
        measurement_id: r.measurement_id,
        fact_id: r.fact_id,
        work_id: r.work_id,
        work_title: r.work_title,
        quantity: r.quantity,
        value_num: r.value_num,
        value_text: r.value_text,
        unit: r.unit
      })
    } else if (status === 'review') needs_interpretation++
    else if (status === 'conflict') conflicting++
    else if (status === 'invalid') structurally_invalid++
  }

  // Deterministic sample: seed the PRNG from projectId + validated count so it is
  // stable for a given corpus but still spreads across the validated records.
  const rng = mulberry32(projectId * 2654435761 + validated.length)
  const pool = validated.slice()
  // Fisher–Yates using the seeded RNG, then take the first N.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  // One FACT can carry several measurements (kcat and KM of the same claim), so
  // a sample drawn over records repeats facts — and the review queue, which
  // these feed, is keyed by fact. Take the first record per distinct fact so a
  // sample of N really is N things to check.
  const seenFacts = new Set<number>()
  const size = opts.qcSampleSize ?? qcSampleCount(validated.length)
  const qc_sample: ExtractionQcSampleDTO[] = []
  for (const m of pool) {
    if (qc_sample.length >= size) break
    if (seenFacts.has(m.fact_id)) continue
    seenFacts.add(m.fact_id)
    qc_sample.push(m)
  }

  return {
    total_records: rows.length,
    auto_validated,
    needs_interpretation,
    conflicting,
    structurally_invalid,
    qc_sample
  }
}

/**
 * The fact ids behind the QC sample, so the review queue can fold them in.
 *
 * §12 lists the quality-control sample under what "the user should mainly
 * review", and asks for errors to be concentrated into one queue — so the
 * sampled records have to reach the same screen (and the same accept/correct
 * verdicts) as everything else, not sit in a read-only list.
 */
export function getQcSampleFactIds(db: DB, projectId: number): Set<number> {
  return new Set(
    getExtractionStatusSummary(db, projectId).qc_sample.map((q) => q.fact_id)
  )
}

// ============================================================ review queue
/**
 * Stable identity for a CLAIM (as opposed to a fact ROW). A re-run supersedes the
 * old analysis_run and inserts brand-new fact rows with new ids, so a verdict
 * keyed on fact_id alone would silently disappear from the reviewer's view the
 * moment the extraction is regenerated. This digest lets the queue find the
 * verdict a human recorded on the PREVIOUS run of the same claim and say so.
 *
 * Deliberately coarse and normalized (case/whitespace-folded): it is used only to
 * ASK "did you already judge this claim?", never to auto-resolve anything — so a
 * false positive costs a confirmation prompt, not a silent wrong resolution.
 */
function factFingerprint(input: {
  workId: number
  analysisType: string
  predicate: string
  subject: string | null
  valueText: string | null
}): string {
  const norm = (s: string | null): string => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  return [
    input.workId,
    norm(input.analysisType),
    norm(input.predicate),
    norm(input.subject),
    norm(input.valueText)
  ].join('\u001f')
}

function mapVerdictRow(r: VerdictRow, stale: boolean): FactVerdictDTO {
  return {
    id: r.id,
    fact_id: r.fact_id,
    project_id: r.project_id,
    verdict: r.verdict as FactVerdictKind,
    corrected_value: r.corrected_value,
    note: r.note,
    reviewer: r.reviewer,
    created_at: r.created_at,
    stale,
    analysis_run_id: r.analysis_run_id
  }
}

interface VerdictRow {
  id: number
  fact_id: number
  project_id: number
  analysis_run_id: number
  fact_fingerprint: string
  verdict: string
  corrected_value: string | null
  note: string | null
  reviewer: string
  created_at: string
}

/**
 * The queue's FROM+WHERE, shared by the read and its count.
 *
 * Factored out rather than copied because the two must select the same
 * population: a `total` computed from a different predicate is a number the list
 * can never reach, and this predicate is eight clauses long. The QC sample ids
 * are interpolated as PLACEHOLDERS only — the ids themselves are bound.
 */
function reviewQueueFrom(qcIds: Set<number>): string {
  return /* sql */ `
      FROM fact f
      JOIN analysis_run ar ON ar.id = f.analysis_run_id
      JOIN work w ON w.id = ar.work_id
      WHERE ar.superseded = 0 AND (ar.project_id = ? OR ar.project_id = 0)
        AND (f.kind = 'uncertain-conflicting'
             OR f.kind = 'inferred'
             OR ar.verifier_result IN ('partial','failed')
             -- A verdict that CONTRADICTED the record is the strongest reason to
             -- look at it: unlike the signals above, a reader with the paper in
             -- front of them said so. It must NAME the record, though. A check
             -- with no fact id used to escalate the whole run on the reasoning
             -- that the finding belonged to no single row — but the queue is a
             -- list of stored values to look at, and that pulled every fact of
             -- the run into it, 114 of them for four findings about values the
             -- table does not hold. The queue then disagreed with itself: this
             -- predicate admitted the rows, and the reason-building step had
             -- nothing to say about them.
             OR EXISTS (SELECT 1 FROM analysis_check ac
                        WHERE ac.analysis_run_id = ar.id AND ac.status = 'failed'
                          AND ac.fact_id = f.id)
             -- §12 also asks the user to review a small random sample of the
             -- AUTO-VALIDATED records. Those pass every check above, so without
             -- this they could never reach the queue — and a validator mistake
             -- would stay invisible precisely because it validated.
             OR f.id IN (${qcIds.size > 0 ? [...qcIds].map(() => '?').join(',') : 'NULL'}))`
}

/**
 * How many items the review queue holds.
 *
 * `qcIds` may be supplied by a caller that has already drawn the sample, and a
 * caller reading the queue AND its size should do so. Drawing it costs a full
 * pass over the extraction select with two correlated EXISTS per row; drawing it
 * twice for one request pays that twice and, because the sample is redrawn, can
 * also make the count disagree with the list it is counting.
 */
export function countReviewQueue(db: DB, projectId: number, qcIds?: Set<number>): number {
  const ids = qcIds ?? getQcSampleFactIds(db, projectId)
  return (
    db.prepare(`SELECT COUNT(*) AS c ${reviewQueueFrom(ids)}`).get(projectId, ...ids) as {
      c: number
    }
  ).c
}

/**
 * The queue and its true size, from ONE draw of the QC sample.
 *
 * The pairing exists because the two reads are only consistent when they share a
 * sample: drawn separately, `total` describes a population the returned items
 * were not taken from — so a queue could report 41 items and hand back 40 with
 * `limit` unset, which reads as data loss.
 */
export function getReviewQueuePage(
  db: DB,
  projectId: number,
  page: { limit?: number } = {}
): { items: ReviewItemDTO[]; total: number } {
  const qcIds = getQcSampleFactIds(db, projectId)
  return {
    items: getReviewQueue(db, projectId, page, qcIds),
    total: countReviewQueue(db, projectId, qcIds)
  }
}

/**
 * The review queue. `limit` ONLY — there is deliberately no `offset`.
 *
 * The queue is a sample-topped list: `getQcSampleFactIds` draws a random sample
 * of the auto-validated records and folds them in, so the POPULATION differs
 * between two calls. An `OFFSET` over that is not a second page of one list, it
 * is an arbitrary slice of a different list, and a caller paging through would
 * see some items twice and never see others. A caller that wants more asks for a
 * larger `limit` and re-reads.
 */
export function getReviewQueue(
  db: DB,
  projectId: number,
  page: { limit?: number } = {},
  suppliedQcIds?: Set<number>
): ReviewItemDTO[] {
  const qcIds = suppliedQcIds ?? getQcSampleFactIds(db, projectId)
  const rows = db
    .prepare(
      /* sql */ `
      SELECT f.id AS fact_id, w.id AS work_id, w.title AS work_title, f.kind,
             f.predicate, f.subject, f.value_text,
             ar.verifier_result, ar.analysis_type, ar.id AS run_id
      ${reviewQueueFrom(qcIds)}
      ORDER BY f.id ASC
      ${page.limit === undefined ? '' : 'LIMIT ?'}
    `
    )
    .all(projectId, ...qcIds, ...(page.limit === undefined ? [] : [Math.max(1, page.limit)])) as Array<{
    fact_id: number
    work_id: number
    work_title: string
    kind: string
    predicate: string
    subject: string | null
    value_text: string | null
    verifier_result: string | null
    analysis_type: string
    run_id: number
  }>

  // Failed checks for every run in play, loaded once. Keyed by run so a
  // run-level failure (fact_id NULL) attaches to each of that run's items.
  const failedByFact = new Map<number, AnalysisCheckDTO[]>()
  if (rows.length > 0) {
    const runIds = [...new Set(rows.map((r) => r.run_id))]
    // A CHECK THAT NAMES NO RECORD IS NOT A ROW OF THIS QUEUE.
    //
    // The queue reviews the extraction TABLE: every row is a stored value, and
    // its reason is why that value needs a second look. A check about something
    // the table does not hold — a reader reporting that the paper states a value
    // nobody recorded — answers a different question, and there is no row for a
    // value that does not exist.
    //
    // Such a check used to be spread over every fact of its run, so one paper's
    // four findings labelled all 114 of its facts "contradicted by the paper",
    // including the ones that were right, and overwrote whatever each row's own
    // reason had been. Filtered in SQL rather than after the fact, so the count
    // and the rows cannot disagree about what the queue holds.
    const failedRows = db
      .prepare(
        `SELECT id, analysis_run_id, check_key, status, reason, fact_id, measurement_id,
                model, prompt_version
         FROM analysis_check
         WHERE status = 'failed' AND fact_id IS NOT NULL
           AND analysis_run_id IN (${runIds.map(() => '?').join(',')})
         ORDER BY id ASC`
      )
      .all(...runIds) as Array<Omit<AnalysisCheckDTO, 'label'> & { analysis_run_id: number }>
    for (const c of failedRows) {
      const { analysis_run_id: _runId, ...rest } = c
      const dto: AnalysisCheckDTO = {
        ...rest,
        label: CHECK_LABELS[rest.check_key] ?? rest.check_key
      }
      const l = failedByFact.get(dto.fact_id as number)
      if (l) l.push(dto)
      else failedByFact.set(dto.fact_id as number, [dto])
    }
  }

  // Verdicts are scoped to the CALLING project, so the same global (project_id=0)
  // fact judged by project A is still unresolved for project B. Loading the
  // history in one pass avoids an N+1 over what can be a few thousand facts.
  const history = db
    .prepare(
      `SELECT * FROM fact_verdict WHERE project_id = ? ORDER BY id ASC`
    )
    .all(projectId) as VerdictRow[]
  const byFact = new Map<number, VerdictRow[]>()
  const byFingerprint = new Map<string, VerdictRow[]>()
  for (const v of history) {
    const a = byFact.get(v.fact_id)
    if (a) a.push(v)
    else byFact.set(v.fact_id, [v])
    const b = byFingerprint.get(v.fact_fingerprint)
    if (b) b.push(v)
    else byFingerprint.set(v.fact_fingerprint, [v])
  }

  return rows.map((r) => {
    const failedChecks = failedByFact.get(r.fact_id) ?? []
    let reason: string
    // A contradicted verdict outranks every epistemic hedge below it: a reader
    // with the paper in front of them said the record is wrong, where
    // 'inferred' only says the model was unsure while producing it.
    if (failedChecks.length > 0) {
      reason = `Contradicted by the paper: ${failedChecks[0].label}`
    }
    else if (r.kind === 'uncertain-conflicting') reason = 'Fact is uncertain or conflicting'
    else if (r.verifier_result === 'failed')
      reason = "The model's response did not parse against the output schema"
    else if (r.verifier_result === 'partial')
      reason = "Only part of the model's response matched the output schema"
    else if (r.kind === 'inferred') reason = 'Inferred (not directly reported)'
    else reason = 'Spot-check of an auto-validated record'

    // Exact fact_id match first — that is a verdict on THIS row, not a guess.
    // Only if none exists do we look for a verdict on a previous run of the same
    // claim, and that one is flagged `stale` so the UI asks for confirmation
    // instead of silently resolving a freshly re-extracted value.
    const exact = byFact.get(r.fact_id) ?? []
    const fp = factFingerprint({
      workId: r.work_id,
      analysisType: r.analysis_type,
      predicate: r.predicate,
      subject: r.subject,
      valueText: r.value_text
    })
    const stale = exact.length === 0 ? (byFingerprint.get(fp) ?? []) : []
    const rowsForItem = exact.length > 0 ? exact : stale
    const isStale = exact.length === 0 && stale.length > 0
    const current = rowsForItem.length > 0 ? rowsForItem[rowsForItem.length - 1] : null

    return {
      fact_id: r.fact_id,
      work_id: r.work_id,
      work_title: r.work_title,
      kind: r.kind,
      predicate: r.predicate,
      value_text: r.value_text,
      verifier_result: r.verifier_result,
      failed_checks: failedChecks,
      reason,
      // A retraction ('unresolved') is a real row but NOT a resolution — the
      // item is back in the queue, so the current verdict reads as null.
      verdict:
        current && current.verdict !== 'unresolved' ? mapVerdictRow(current, isStale) : null,
      verdict_history: rowsForItem.map((v) => mapVerdictRow(v, isStale))
    }
  })
}

/**
 * Append a human verdict for one fact, in one project.
 *
 * PROVENANCE IS UNTOUCHED: this function only ever INSERTs into `fact_verdict`.
 * It never updates `fact`, `evidence_span` or `analysis_run` — the model's value
 * and the run that produced it remain exactly as extracted, and the human's
 * corrected value is stored beside them.
 *
 * The fact must be reachable from this project (its run is either project-scoped
 * or the project_id=0 global sentinel); judging another project's private run is
 * rejected rather than silently accepted.
 */
export function recordFactVerdict(
  db: DB,
  input: {
    projectId: number
    factId: number
    verdict: FactVerdictKind
    correctedValue?: string
    note?: string
    reviewer: string
  }
): FactVerdictDTO {
  if (input.projectId <= 0) {
    throw new Error('a verdict is always recorded FOR a real project, never globally')
  }
  const owner = db
    .prepare(
      /* sql */ `
      SELECT f.id AS fact_id, f.predicate, f.subject, f.value_text,
             ar.id AS run_id, ar.project_id, ar.work_id, ar.analysis_type
      FROM fact f JOIN analysis_run ar ON ar.id = f.analysis_run_id
      WHERE f.id = ?`
    )
    .get(input.factId) as
    | {
        fact_id: number
        predicate: string
        subject: string | null
        value_text: string | null
        run_id: number
        project_id: number
        work_id: number
        analysis_type: string
      }
    | undefined
  if (!owner) throw new Error(`fact ${input.factId} not found`)
  if (owner.project_id !== 0 && owner.project_id !== input.projectId) {
    throw new Error(`fact ${input.factId} does not belong to project ${input.projectId}`)
  }

  const corrected = input.verdict === 'corrected' ? (input.correctedValue ?? '').trim() : null
  if (input.verdict === 'corrected' && !corrected) {
    throw new Error("verdict 'corrected' requires a corrected value")
  }
  if (input.verdict !== 'corrected' && (input.correctedValue ?? '').trim()) {
    throw new Error(`a corrected value is only meaningful for verdict 'corrected'`)
  }

  const note = (input.note ?? '').trim() || null
  const fingerprint = factFingerprint({
    workId: owner.work_id,
    analysisType: owner.analysis_type,
    predicate: owner.predicate,
    subject: owner.subject,
    valueText: owner.value_text
  })
  const now = new Date().toISOString()
  const info = db
    .prepare(
      `INSERT INTO fact_verdict
         (fact_id, project_id, analysis_run_id, fact_fingerprint, verdict,
          corrected_value, note, reviewer, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.factId,
      input.projectId,
      owner.run_id,
      fingerprint,
      input.verdict,
      corrected,
      note,
      input.reviewer,
      now
    )

  const row = db
    .prepare(`SELECT * FROM fact_verdict WHERE id = ?`)
    .get(info.lastInsertRowid as number) as VerdictRow
  return mapVerdictRow(row, false)
}

// ============================================================ dossier
// Kinds included in the topic dossier. Beyond the two "settled" kinds we now
// INCLUDE 'uncertain-conflicting' and 'inferred' — the §8 anti-anchoring
// requirement that the dossier surface contrary findings/disagreements rather
// than hide them. (A-M1.)
const DOSSIER_KINDS = [
  'directly-reported',
  'supplied-by-project-context',
  'uncertain-conflicting',
  'inferred'
] as const
const CONTRARY_KINDS = new Set(['uncertain-conflicting', 'inferred'])

/**
 * The works whose facts feed a project's dossier: the ones the user MARKED as
 * reference papers, and only those.
 *
 * NO FALLBACK. When nothing is marked this returns the empty set, the dossier is
 * empty, and no background reaches the model.
 *
 * It used to substitute the top 8 works by relevance so a fresh project would
 * never show an empty dossier. That put eight papers the user never chose into
 * the prompt of every analysis in the project, as BACKGROUND CLAIMS — the thing
 * the dossier exists to make deliberate. Ranking is the app's guess; marking a
 * reference paper is the user's decision, and substituting the first for the
 * second is exactly the "assumed rather than stated" move the fact-kind rules
 * forbid one layer down. The screen had to carry a notice admitting it, which is
 * the tell: a feature that needs a disclaimer next to it is doing something the
 * user did not ask for.
 *
 * An empty dossier is also the honest state. A project with no reference papers
 * HAS no background, and saying so is what makes the Dossier screen's empty
 * state mean something.
 */
function dossierSourceWorkIds(db: DB, projectId: number): { ids: Set<number>; areReferences: boolean } {
  const refs = db
    .prepare(
      `SELECT work_id FROM project_work
       WHERE project_id = ? AND is_reference = 1`
    )
    .all(projectId) as Array<{ work_id: number }>
  // `areReferences` is now always true: every id here IS a marked reference.
  // Kept in the shape because `DossierEntryDTO.from_reference` is part of the
  // frozen contract and its callers still read it.
  return { ids: new Set(refs.map((r) => r.work_id)), areReferences: true }
}

/**
 * Build the project topic dossier: grounded facts drawn PREFERENTIALLY from the
 * user-marked reference papers (falling back to top-relevance works). Includes
 * contrary/uncertain findings and flags them (is_contrary) so the UI can label
 * disagreements. Contrary items are ordered to the front within each work.
 */
/**
 * How many dossier claims a project has, under the same source set and kind
 * filter as `getDossier`.
 *
 * `dossierSourceWorkIds` is a read of its own, so a caller wanting BOTH numbers
 * should use `getDossierPage`, which resolves the source set once.
 */
export function countDossier(db: DB, projectId: number, sourceIds?: Set<number>): number {
  const ids = sourceIds ?? dossierSourceWorkIds(db, projectId).ids
  if (ids.size === 0) return 0
  const workPlaceholders = [...ids].map(() => '?').join(',')
  const kindPlaceholders = DOSSIER_KINDS.map(() => '?').join(',')
  return (
    db
      .prepare(
        /* sql */ `
      SELECT COUNT(*) AS c
      FROM fact f
      JOIN analysis_run ar ON ar.id = f.analysis_run_id
      JOIN work w ON w.id = ar.work_id
      WHERE ar.superseded = 0 AND (ar.project_id = ? OR ar.project_id = 0)
        AND ar.work_id IN (${workPlaceholders})
        AND f.kind IN (${kindPlaceholders})
        -- The same exclusion the page below applies, in the same place. A count
        -- and a page that disagree about the population is a list that never
        -- reaches its own total.
        AND f.retracted_by_check_id IS NULL
    `
      )
      .get(projectId, ...ids, ...DOSSIER_KINDS) as { c: number }
  ).c
}

/**
 * A page of the dossier and its true size, resolving the source-work set ONCE.
 *
 * `dossierSourceWorkIds` is itself a query (and falls back to the top-relevance
 * works when nothing is marked), so reading the page and the count separately
 * runs it twice — on the main thread, where every millisecond is a frozen UI.
 */
export function getDossierPage(
  db: DB,
  projectId: number,
  page: { limit?: number; offset?: number } = {}
): { items: DossierEntryDTO[]; total: number } {
  const source = dossierSourceWorkIds(db, projectId)
  return {
    items: getDossier(db, projectId, page, source),
    total: countDossier(db, projectId, source.ids)
  }
}

export function getDossier(
  db: DB,
  projectId: number,
  // No LIMIT unless one is asked for: the Dossier screen renders every claim.
  page: { limit?: number; offset?: number } = {},
  suppliedSource?: { ids: Set<number>; areReferences: boolean }
): DossierEntryDTO[] {
  const { ids, areReferences } = suppliedSource ?? dossierSourceWorkIds(db, projectId)
  if (ids.size === 0) return []
  const workPlaceholders = [...ids].map(() => '?').join(',')
  const kindPlaceholders = DOSSIER_KINDS.map(() => '?').join(',')
  const limitClause = page.limit === undefined ? '' : '\n      LIMIT ? OFFSET ?'
  const limitParams =
    page.limit === undefined ? [] : [Math.max(1, page.limit), Math.max(0, page.offset ?? 0)]

  const rows = db
    .prepare(
      /* sql */ `
      SELECT f.id, ar.work_id, w.title AS work_title, w.publication_year AS work_year,
             f.predicate, f.subject,
             -- A fact is a TRIPLE, and which of the two columns carries the
             -- value depends on how the model phrased it: an entity-valued
             -- claim arrives as (subject, predicate, object) and the OBJECT is
             -- the value, while a quantity arrives with value_text set. The
             -- extraction table already reads it this way (EXTRACTION_SELECT);
             -- reading value_text alone here published dossier entries whose
             -- value was NULL, and a background claim with no value is not
             -- background — it is a predicate with nothing after it.
             COALESCE(f.value_text, f.object) AS value_text,
             f.kind,
             es.quote AS quote, es.verbatim AS evidence_verbatim,
             es.page AS evidence_page, es.section AS evidence_section,
             ed.version_kind AS evidence_version, ar.analysis_type,
             ar.run_origin, ar.origin_note
      FROM fact f
      JOIN analysis_run ar ON ar.id = f.analysis_run_id
      -- work is 1:1 with analysis_run.work_id (PK join on a NOT NULL FK), so
      -- this can neither fan out nor drop rows.
      JOIN work w ON w.id = ar.work_id
      -- The anchored passage, when the fact has one. LEFT JOIN is mandatory:
      -- fact.evidence_span_id is nullable (ON DELETE SET NULL) and kinds like
      -- supplied-by-project-context legitimately have no span at all — an inner
      -- join would silently delete exactly those claims. The run-equality guard
      -- makes a span belonging to another run degrade to NULL instead of
      -- attributing someone else's evidence to this fact.
      LEFT JOIN evidence_span es
             ON es.id = f.evidence_span_id
            AND es.analysis_run_id = f.analysis_run_id
      -- A page number is only meaningful against a specific DOCUMENT (a work can
      -- have a preprint and a published version paginated differently), so the
      -- concrete version is carried alongside the locator instead of letting
      -- "p. 4" read as a property of the work. Still a PK join: at most one row.
      LEFT JOIN document ed ON ed.id = es.document_id
      WHERE ar.superseded = 0 AND (ar.project_id = ? OR ar.project_id = 0)
        AND ar.work_id IN (${workPlaceholders})
        AND f.kind IN (${kindPlaceholders})
        -- A WITHDRAWN CLAIM IS NOT BACKGROUND (v52). The dossier is what the app
        -- tells the next model about this collection, so a record a reader with
        -- the paper in front of it said should not exist would be laundered into
        -- context for every analysis that follows — the one place a retracted
        -- value does real damage rather than sitting in a table someone can see
        -- the retraction on.
        AND f.retracted_by_check_id IS NULL
      ORDER BY ar.work_id ASC,
               CASE WHEN f.kind IN ('uncertain-conflicting','inferred') THEN 0 ELSE 1 END,
               f.id ASC${limitClause}
    `
    )
    .all(projectId, ...ids, ...DOSSIER_KINDS, ...limitParams) as Array<{
    id: number
    work_id: number
    work_title: string
    work_year: number | null
    predicate: string
    subject: string | null
    value_text: string | null
    kind: string
    quote: string | null
    evidence_verbatim: number | null
    evidence_page: number | null
    evidence_section: string | null
    evidence_version: string | null
    analysis_type: string
    run_origin: string
    origin_note: string | null
  }>

  return rows.map((r) => ({
    id: r.id,
    work_id: r.work_id,
    work_title: r.work_title,
    work_year: r.work_year,
    predicate: r.predicate,
    subject: r.subject && r.subject.trim() ? r.subject : null,
    value_text: r.value_text,
    kind: r.kind,
    is_contrary: CONTRARY_KINDS.has(r.kind),
    from_reference: areReferences,
    // Never synthesised: a blank/whitespace quote is reported as absent rather
    // than rendered as an empty passage.
    quote: r.quote && r.quote.trim() ? r.quote : null,
    // Whether that quote was actually located in the document. False here means
    // the model asserted the wording — the dossier must not present it as a
    // passage the paper contains.
    evidence_verbatim: r.evidence_verbatim === 1,
    evidence_page: r.evidence_page,
    evidence_section: r.evidence_section && r.evidence_section.trim() ? r.evidence_section : null,
    evidence_version: r.evidence_version,
    analysis_type: r.analysis_type,
    // Where the run that produced this claim happened. A dossier reads as the
    // app's own synthesis, which makes it the surface where "this arrived in
    // the download" is easiest to miss and most misleading.
    run_origin: r.run_origin as RunOrigin,
    origin_note: r.origin_note
  }))
}

/**
 * Mark (or unmark) a work as a project reference paper, feeding the topic
 * dossier. Writes `project_work.is_reference` and NOTHING else. (A-B2.)
 */
export function markReferencePaper(
  db: DB,
  projectId: number,
  workId: number,
  isReference: boolean,
  now: string
): void {
  // REFUSED HERE, not only in the button. The renderer disables the control,
  // but MCP reaches this too, and a limit the UI merely draws is not a limit.
  //
  // SYNC DOES NOT COME THROUGH HERE and is deliberately not capped: a plugin
  // that syncs a project between libraries upserts `is_reference` straight from
  // a peer's row, and refusing it would make two libraries disagree about which
  // papers a shared project is built from — a divergence neither side could
  // see. The limit governs what THIS user adds;
  // a project arriving over it is treated like any other project already over
  // it, which the branch below already allows.
  //
  // Only ADDING is checked, and only when this paper is not already one: a
  // project over the limit — built before it existed, or by a setup that
  // imported more — stays exactly as its owner left it, and taking papers out
  // is always allowed.
  if (isReference) {
    const already = (
      db
        .prepare('SELECT is_reference AS r FROM project_work WHERE project_id = ? AND work_id = ?')
        .get(projectId, workId) as { r: number } | undefined
    )?.r
    if (already !== 1 && countReferencePapers(db, projectId) >= DOSSIER_PAPER_LIMIT) {
      throw new Error(DOSSIER_LIMIT_SENTENCE)
    }
  }
  const info = db
    .prepare(
      `UPDATE project_work
         SET is_reference = ?, updated_at = ?
         WHERE project_id = ? AND work_id = ?`
    )
    .run(isReference ? 1 : 0, now, projectId, workId)
  if (info.changes === 0) {
    throw new Error(`project_work (${projectId},${workId}) not found`)
  }
}

/** Lowercase alphanumeric tokens (>=3 chars) for lightweight lexical overlap. */
function tokenize(text: string | null | undefined): Set<string> {
  const out = new Set<string>()
  if (!text) return out
  for (const tok of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (tok.length >= 3) out.add(tok)
  }
  return out
}

/** Count shared tokens between two token sets (Jaccard numerator). */
function overlapCount(a: Set<string>, b: Set<string>): number {
  let n = 0
  for (const t of a) if (b.has(t)) n++
  return n
}

/**
 * Build a compact, deterministic dossier-context string for a TARGET work, to be
 * fed to the PROJECT SUMMARY (and to the dossier build itself) as
 * `suppliedProjectContext`. Extraction is NOT a consumer: it reads the paper
 * alone, so nothing it reports is anchored on what the collection already
 * believes. Selects the reference
 * dossier facts most lexically relevant to the target work (term overlap between
 * the target title/abstract and each fact subject+predicate+value), so the model
 * sees "only the relevant portions of the topic dossier" (§8).
 * Offline/deterministic.
 * Returns an empty string when there is nothing relevant (caller then supplies
 * no context). (A-B2.)
 *
 * AN ENTRY WITH NO VALUE IS NOT BACKGROUND, and is dropped rather than sent.
 * `{"predicate":"has_tm","value":null}` states nothing the reader can relate a
 * paper to, but it still LOOKS like a populated collection — and a model handed
 * eight of them wrote about what "the collection already records" by inventing
 * it. Excluding them is what lets the caller's emptiness check be true: a
 * context is either something to read the paper against, or it is absent and
 * says so.
 */
export function buildDossierContext(
  db: DB,
  projectId: number,
  forWorkId: number,
  opts: { maxEntries?: number } = {}
): string {
  const maxEntries = opts.maxEntries ?? 8
  const dossier = getDossier(db, projectId)
  if (dossier.length === 0) return ''

  // Do not feed the target work's OWN facts back to it as "context", and do not
  // send a claim that carries no value — see the header.
  const entries = dossier.filter(
    (d) => d.work_id !== forWorkId && (d.value_text ?? '').trim() !== ''
  )
  if (entries.length === 0) return ''

  const target = db
    .prepare('SELECT title, abstract FROM work WHERE id = ?')
    .get(forWorkId) as { title: string | null; abstract: string | null } | undefined
  const targetTokens = tokenize([target?.title, target?.abstract].filter(Boolean).join(' '))

  // Score each entry by lexical overlap with the target; always surface contrary
  // material (anti-anchoring) by giving it a small ranking bonus.
  const scored = entries
    .map((d) => {
      const factTokens = tokenize(`${d.subject ?? ''} ${d.predicate} ${d.value_text ?? ''}`)
      const overlap = overlapCount(targetTokens, factTokens)
      const score = overlap + (d.is_contrary ? 0.5 : 0)
      return { d, score }
    })
    // Stable, deterministic ordering: score desc, contrary first, then id asc.
    .sort((a, b) => b.score - a.score || Number(b.d.is_contrary) - Number(a.d.is_contrary) || a.d.id - b.d.id)

  // The SUBJECT travels with the claim: without it a value is unattributed, and
  // "the collection records 79" reads as a property of the whole collection
  // rather than of the one thing the claim was about.
  const picked = scored.slice(0, maxEntries).map(({ d }) => ({
    subject: d.subject,
    predicate: d.predicate,
    value: d.value_text,
    kind: d.kind,
    contrary: d.is_contrary,
    work_id: d.work_id
  }))
  if (picked.length === 0) return ''

  // THE NOTE SAYS THAT THIS IS A SELECTION, AND THAT THE SELECTION IS THE LIMIT.
  //
  // `entries` is the top `maxEntries` by relevance out of a dossier that is
  // routinely an order of magnitude larger, and a model can see that: eight
  // claims is visibly not a whole collection. Told only "background", it fills
  // the gap it correctly infers is there — writing "the collection records
  // Round 2 11/10D as 66 ± 2" for values that appear in neither the entries nor
  // the paper. The invention is a reasonable response to a context that looks
  // partial and does not say what to do about being partial.
  //
  // So the note states both halves: more exists, AND the unshown part is not
  // available to be guessed at. That converts the model's true inference into
  // the right behaviour — attribute only these, and say the rest is unknown —
  // instead of leaving it to invent a plausible remainder.
  return JSON.stringify({
    note:
      'Reference-paper dossier (background only; do not override values the document itself reports). ' +
      'These entries are a RELEVANCE-SELECTED EXTRACT: the collection holds more claims than are ' +
      'shown here. You have not been shown them and cannot infer them. Attribute to the collection ' +
      'ONLY what appears in these entries; where you need something the collection would have to ' +
      'say and it is not here, say that it is not recorded rather than supplying a value.',
    entries: picked
  })
}

/**
 * WHY a work has no dossier context, when it has none.
 *
 * `'ready'` there is background to read this paper against.
 * `'self-only'` the project HAS a dossier and every claim in it came from this
 *              paper, which `buildDossierContext` correctly removes.
 * `'empty'` the project has no usable dossier at all.
 *
 * The distinction exists because the two shortfalls have different remedies and
 * the wrong one is actively misleading: telling a user to build a dossier they
 * have already built, on the paper that IS their reference, describes their
 * project as empty when it is full. Resolved through the same function the
 * runner calls, with the same arguments, so a message can never disagree with
 * the refusal it explains.
 */
export function dossierContextState(
  db: DB,
  projectId: number,
  forWorkId: number
): 'ready' | 'self-only' | 'empty' {
  if (buildDossierContext(db, projectId, forWorkId).trim()) return 'ready'
  // 0 is the global sentinel and belongs to no work, so nothing is excluded and
  // this asks "does the project have a dossier at all".
  return buildDossierContext(db, projectId, 0).trim() ? 'self-only' : 'empty'
}

/**
 * The dossier-context hash a work WOULD be analysed against right now — the same
 * value `runPipeline` stamps into `analysis_run.dossier_input_hash`. Computed by
 * the same expression in both places so a comparison is meaningful; an empty
 * context hashes to NULL, exactly as the pipeline records it.
 */
export function currentDossierInputHash(
  db: DB,
  projectId: number,
  workId: number
): string | null {
  const ctx = buildDossierContext(db, projectId, workId)
  return ctx ? hashInput({ dossier: ctx }) : null
}

/**
 * WHICH PAPERS the dossier is drawn from — the part of it a person decided.
 *
 * `currentDossierInputHash` covers the dossier's CONTENT, which is right for
 * provenance ("this analysis was produced against exactly these background
 * values") and catastrophic for cache invalidation, because that content is
 * itself extraction output. Marking work 1 as a reference puts work 1's
 * extracted values into every other paper's prompt, so re-extracting work 1
 * moved all nineteen other fingerprints, which re-extracted them, which moved
 * work 1's — a corpus that rebuilds itself forever with nobody touching it.
 * This is the loop behind "again every paper re-processed".
 *
 * So the CACHE keys on the dossier's MEMBERSHIP instead: the set of works
 * feeding it, and how each is included. Marking or unmarking a reference paper
 * is a decision the user made and still invalidates immediately. The app
 * re-reading a paper it had already read is not a decision, and no longer does.
 *
 * Ordered by work id so the string is a property of the SET, not of the order
 * rows happened to come back in.
 */
export function dossierMembershipHash(db: DB, projectId: number, workId: number): string {
  // THE REFERENCE PAPERS, which are what actually feed the dossier — not every
  // paper that happens to carry an inclusion_status.
  //
  // The comment above already states the rule ("the set of works feeding it");
  // the query did not implement it. `inclusion_status IS NOT NULL` is true of
  // every paper the moment it is imported, because import writes `unread`. So
  // importing ONE paper changed this hash for every other paper in the project
  // and invalidated all their summaries — the corpus-rebuilds-itself failure
  // this function exists to prevent, arriving through the door left open beside
  // it. Measured: project 2 had 33 rows feeding this hash and ZERO reference
  // papers, so its dossier was empty while its hash moved on every import.
  //
  // `is_reference` is the user's deliberate decision and the exact input
  // `projectContextEntries` reads, so marking or unmarking one still
  // invalidates immediately — which is the behaviour that was wanted.
  const rows = db
    .prepare(
      `SELECT work_id, inclusion_status FROM project_work
        WHERE project_id = ? AND work_id <> ? AND is_reference = 1
        ORDER BY work_id ASC`
    )
    .all(projectId, workId) as Array<{ work_id: number; inclusion_status: string | null }>
  if (rows.length === 0) return 'none'
  return hashInput({ members: rows.map((r) => `${r.work_id}:${r.inclusion_status ?? ''}`) })
}

/**
 * Works whose CURRENT project-scoped analysis was produced against a different
 * project dossier than the one they would receive today (§21).
 *
 * Only PROJECT-scoped runs are considered: a global run (project_id = 0) was
 * never made against this project's dossier, so calling it "stale against the
 * dossier" would be a fabricated complaint. Dossier BUILD runs are excluded too
 * — they are the dossier, and comparing them to themselves says nothing.
 *
 * And only the project SUMMARY is given the dossier at all. Extraction reads the
 * paper alone, so measuring an extraction against a dossier it was never handed
 * would report a whole corpus as stale over an input that cannot have affected
 * it — the loudest possible way to say nothing.
 *
 * NOTHING is reprocessed here. This function only reports the discrepancy.
 */
export function getDossierStaleWorks(db: DB, projectId: number): DossierStaleWorkDTO[] {
  const runs = db
    .prepare(
      /* sql */ `
      SELECT ar.work_id, w.title, ar.analysis_type, ar.run_timestamp, ar.dossier_input_hash
      FROM analysis_run ar
      JOIN work w ON w.id = ar.work_id
      WHERE ar.project_id = ? AND ar.superseded = 0 AND ar.analysis_type = 'summary'
      ORDER BY ar.work_id ASC, ar.analysis_type ASC
    `
    )
    .all(projectId) as Array<{
    work_id: number
    title: string
    analysis_type: string
    run_timestamp: string
    dossier_input_hash: string | null
  }>

  // One context build per work, not per run: buildDossierContext depends on the
  // work, not on which analysis was run over it.
  const currentByWork = new Map<number, string | null>()
  const out: DossierStaleWorkDTO[] = []
  for (const r of runs) {
    if (!currentByWork.has(r.work_id)) {
      currentByWork.set(r.work_id, currentDossierInputHash(db, projectId, r.work_id))
    }
    const current = currentByWork.get(r.work_id) ?? null
    if (current === r.dossier_input_hash) continue
    out.push({
      work_id: r.work_id,
      title: r.title,
      analysis_type: r.analysis_type,
      run_timestamp: r.run_timestamp,
      built_against: r.dossier_input_hash,
      current
    })
  }
  return out
}

/** Title/year/claim-count/build-time for a set of works feeding the dossier. */
function dossierSources(
  db: DB,
  projectId: number,
  workIds: number[],
  claimsByWork: Map<number, number>
): DossierSourceDTO[] {
  if (workIds.length === 0) return []
  const ph = workIds.map(() => '?').join(',')
  const rows = db
    .prepare(
      /* sql */ `
      SELECT w.id AS work_id, w.title, w.publication_year AS year,
             (SELECT ar.run_timestamp FROM analysis_run ar
               WHERE ar.work_id = w.id AND ar.project_id = ?
                 AND ar.analysis_type = 'dossier' AND ar.superseded = 0) AS built_at
      FROM work w
      WHERE w.id IN (${ph})
      ORDER BY w.publication_year ASC, w.title COLLATE NOCASE ASC
    `
    )
    .all(projectId, ...workIds) as Array<{
    work_id: number
    title: string
    year: number | null
    built_at: string | null
  }>
  return rows.map((r) => ({ ...r, claim_count: claimsByWork.get(r.work_id) ?? 0 }))
}

/**
 * Whether this work has any text a summary could be written from.
 *
 * The cheap YES/NO half of `llm/summary.ts`'s `resolveSourceText`, which
 * assembles the actual body. It is duplicated as a predicate rather than shared
 * because the read path must not import the runner (the runner imports THIS
 * module, and the cycle would be real), and because answering "is there
 * anything?" needs neither the 120k-char body nor the artifact JSON parse.
 *
 * The two must agree on the ANSWER, and both reduce to the same rule: a
 * paragraph inventory from a live stage run, or an abstract. A title alone is
 * not a paper — a summary written from one is entirely the model's prior, and
 * it reads exactly like a summary of a paper that was actually read.
 */
function canSummariseWork(db: DB, workId: number): 'yes' | 'no' | 'text-unreadable' {
  // Counts paragraphs that are NOT bibliography, because that is what the
  // runner actually joins into the body. Testing only that an artifact EXISTS
  // would answer yes for a document whose inventory is entirely references —
  // the runner would then find an empty body, fall through to the abstract, and
  // either write from far less than the button implied or refuse outright.
  //
  // `IS NOT 'reference'` rather than `!=`, so a paragraph with a missing or
  // NULL `kind` counts as prose. That matches the runner's `p.kind !==
  // 'reference'` exactly; `!=` yields NULL against a NULL and would silently
  // drop those paragraphs. Verified against SQLite for both cases.
  //
  // Wrapped because `json_each` THROWS on a malformed artifact, and the runner
  // catches its own parse failure and falls through to the abstract. Without
  // this, one corrupt row would turn a graceful degradation into a failed read
  // of the whole summary.
  //
  // But the throw is REMEMBERED rather than discarded. Falling straight through
  // to the abstract check answered "yes, from the abstract" for a paper whose
  // full text is extracted and unreadable — so a work WITH full text was gated
  // as abstract-only, and the one thing that would fix it (extract again) was
  // named nowhere. `text-unreadable` is that fact, and it outranks an abstract:
  // a paper is not abstract-only merely because this app cannot open its text.
  let textUnreadable = false
  let hasProse: unknown
  try {
    hasProse = db
      .prepare(
        /* sql */ `
        SELECT 1
          FROM stage_artifact sa
          JOIN stage_run sr ON sr.id = sa.stage_run_id
          JOIN document d ON d.id = sr.document_id
         WHERE sa.key = 'text.paragraphs@v1'
           AND d.work_id = ?
           AND sr.superseded = 0
           AND sr.status = 'succeeded'
           AND EXISTS (
             SELECT 1 FROM json_each(sa.json, '$.paragraphs') p
              WHERE json_extract(p.value, '$.kind') IS NOT 'reference'
                AND trim(COALESCE(json_extract(p.value, '$.text'), '')) != ''
           )
         LIMIT 1
      `
      )
      .get(workId)
  } catch {
    hasProse = undefined
    textUnreadable = true
  }
  if (hasProse) return 'yes'
  if (textUnreadable) return 'text-unreadable'

  // The query SUCCEEDED and found no prose. That can still mean an artifact
  // exists and will not parse — `json_each` throws only on malformed JSON, and
  // a valid document with an unusable shape returns no rows — so the artifact
  // is asked directly before the abstract is accepted as the whole story.
  const documentId = preferredDocumentId(db, workId)
  if (documentId !== null && readParagraphInventory(db, documentId).corrupt) {
    return 'text-unreadable'
  }

  const w = db.prepare('SELECT abstract FROM work WHERE id = ?').get(workId) as
    | { abstract: string | null }
    | undefined
  return (w?.abstract ?? '').trim() !== '' ? 'yes' : 'no'
}

/**
 * The CURRENT summary of one work at one scope, or an honest account of why
 * there is none. Read-only; never calls a model.
 *
 * The two scopes are told apart by `project_id` alone — 0 for the general
 * summary, the real project for the project summary — which is why one function
 * serves both and why they can never be confused for each other at the storage
 * level.
 *
 * Provenance comes from `getWorkAnalyses` rather than a second hand-written
 * SELECT: that function already assembles freshness, run_origin and the schema
 * name, and a parallel query here would be a second definition of the same run
 * that could drift from it.
 */
/**
 * Which works in a project already have prose, per scope. One query for a whole
 * list screen — see the contract for why this exists beside `getWorkSummary`.
 *
 * Joins `work_summary` rather than testing `analysis_run` alone: a run that
 * failed produced no prose, and reporting it as "has a summary" would tint a
 * button for something the reader cannot read.
 */
export function getWorksWithSummaries(
  db: DB,
  projectId: number
): { general: number[]; project: number[] } {
  const rows = db
    .prepare(
      /* sql */ `
      SELECT ar.work_id, ar.project_id
        FROM analysis_run ar
        JOIN work_summary ws ON ws.analysis_run_id = ar.id
       WHERE ar.analysis_type = 'summary'
         AND ar.schema_id = 0
         AND ar.superseded = 0
         AND ar.project_id IN (0, ?)
    `
    )
    .all(projectId) as Array<{ work_id: number; project_id: number }>

  const general: number[] = []
  const project: number[] = []
  for (const r of rows) {
    // project_id = 0 is the global sentinel: that is the GENERAL summary, and
    // the distinction is the same one the whole feature rests on.
    if (r.project_id === 0) general.push(r.work_id)
    else project.push(r.work_id)
  }
  return { general, project }
}

export function getWorkSummary(
  db: DB,
  workId: number,
  projectId: number,
  kind: SummaryKind
): WorkSummaryDTO {
  const scopeProjectId = kind === 'general' ? 0 : projectId

  const row = db
    .prepare(
      /* sql */ `
      -- schema_id = 0 names the full current-run key rather than three
      -- quarters of it. Since v15 that column is part of the partial unique
      -- index, so several current runs of one analysis_type can legally
      -- coexist; without it this LIMIT 1 would pick one of them arbitrarily.
      -- A summary targets no extraction schema, so 0 is the only value the
      -- writer ever uses.
      SELECT ar.id AS run_id, ws.body, ws.source_scope
        FROM analysis_run ar
        LEFT JOIN work_summary ws ON ws.analysis_run_id = ar.id
       WHERE ar.work_id = ? AND ar.project_id = ? AND ar.analysis_type = 'summary'
         AND ar.schema_id = 0 AND ar.superseded = 0
       LIMIT 1
    `
    )
    .get(workId, scopeProjectId) as
    | { run_id: number; body: string | null; source_scope: string | null }
    | undefined

  const base = { kind, work_id: workId, project_id: scopeProjectId }
  if (!row) {
    // No run yet — so say WHETHER ONE COULD BE MADE, rather than offering a
    // button that will refuse. The same two conditions `generateSummary`
    // enforces are checked here, cheaply, so the modal explains the obstacle
    // before the user presses anything.
    const source = canSummariseWork(db, workId)
    if (source !== 'yes') {
      // `text-unreadable` is reported ahead of everything else this branch can
      // say, including the dossier states below: a paper whose extracted text
      // will not open cannot be summarised at either scope, and telling a user
      // to build a dossier would send them to fix the wrong thing entirely.
      return {
        ...base,
        body: null,
        state: source === 'text-unreadable' ? 'text-unreadable' : 'no-source',
        source_scope: null,
        run: null
      }
    }
    if (kind === 'project') {
      // Resolved through the one function that knows WHY there is no context, so
      // the modal offers the remedy that actually applies rather than telling a
      // user with a built dossier to build one.
      const ctxState = dossierContextState(db, scopeProjectId, workId)
      if (ctxState !== 'ready') {
        return {
          ...base,
          body: null,
          state: ctxState === 'self-only' ? 'dossier-self-only' : 'no-dossier',
          source_scope: null,
          run: null
        }
      }
    }
    return { ...base, body: null, state: 'missing', source_scope: null, run: null }
  }

  // `getWorkAnalyses` returns the global runs alongside the project's, so the
  // run is picked by id — matching on analysis_type alone would find the other
  // scope's summary whenever this one is the project scope.
  const run = getWorkAnalyses(db, workId, scopeProjectId).find((r) => r.id === row.run_id) ?? null

  // A run with no prose is a FAILED attempt, not an absent one. The distinction
  // is the difference between "press the button" and "the button just failed",
  // and only the row can tell them apart.
  if (!row.body) {
    return { ...base, body: null, state: 'failed', source_scope: row.source_scope, run }
  }
  return { ...base, body: row.body, state: 'ready', source_scope: row.source_scope, run }
}

/**
 * Authoring + provenance state of a project's topic dossier: what the user
 * marked, what is actually feeding it, when it was last BUILT, and what has gone
 * stale against it. Read-only.
 */
export function getDossierStatus(db: DB, projectId: number): DossierStatusDTO {
  const refIds = (
    db
      .prepare(
        `SELECT work_id FROM project_work WHERE project_id = ? AND is_reference = 1`
      )
      .all(projectId) as Array<{ work_id: number }>
  ).map((r) => r.work_id)

  const entries = getDossier(db, projectId)
  const claimsByWork = new Map<number, number>()
  for (const e of entries) claimsByWork.set(e.work_id, (claimsByWork.get(e.work_id) ?? 0) + 1)

  const { ids: sourceIdSet, areReferences } = dossierSourceWorkIds(db, projectId)

  const builds = db
    .prepare(
      /* sql */ `
      SELECT work_id, run_timestamp, model, prompt_version
      FROM analysis_run
      WHERE project_id = ? AND analysis_type = 'dossier' AND superseded = 0
      ORDER BY run_timestamp DESC, work_id ASC
    `
    )
    .all(projectId) as Array<{
    work_id: number
    run_timestamp: string
    model: string
    prompt_version: string
  }>

  return {
    references: dossierSources(db, projectId, refIds, claimsByWork),
    fallback: !areReferences,
    sources: dossierSources(db, projectId, [...sourceIdSet], claimsByWork),
    built_at: builds.length > 0 ? builds[0].run_timestamp : null,
    built_model: builds.length > 0 ? builds[0].model : null,
    built_prompt_version: builds.length > 0 ? builds[0].prompt_version : null,
    built_work_ids: builds.map((b) => b.work_id).sort((a, b) => a - b),
    stale: getDossierStaleWorks(db, projectId),
    current: dossierBuildIsCurrent(db, projectId, refIds)
  }
}

/**
 * Would a rebuild read exactly what the stored build read?
 *
 * ONLY the build's own inputs are consulted, and they are the ones
 * `buildDossier` names for itself: the set of reference papers, the text each
 * of them still holds, the dossier prompt version, and the model. The project
 * description is absent on purpose — the build never opens it. It is the
 * reranker's query, and the two freshnesses are separate on purpose, so a user
 * rewording their goal is told their RANKING moved, not that a dossier they
 * have not touched went out of date.
 *
 * The three checks, and why each is needed:
 *  - MEMBERSHIP. A reference the build never covered means a rebuild would read
 *    a paper this one did not — unless that paper still has no stored text, in
 *    which case the rebuild would skip it exactly as this one did, and nothing
 *    would change. A covered work that is no longer a reference is the mirror
 *    case and is equally a difference.
 *  - EACH RUN'S OWN INPUTS, through `computeAnalysisFreshness` — the same
 *    machinery the Paper screen uses, so the document text, the prompt version
 *    and the output schema are judged by one expression rather than by a second
 *    copy that could disagree with it. Anything short of a proven `current`
 *    verdict — including `unknown` — is NOT current here: the button's quiet
 *    style is a claim that a rebuild is pointless, and an unprovable input is
 *    not grounds for making it.
 *  - THE MODEL. A user who changed models in Settings is asking for different
 *    output from the same papers, which is the commonest reason to rebuild at
 *    all. Read through `getSetting` rather than `readModelSettings` for two
 *    reasons: that module imports THIS one, and an unset value means "whatever
 *    the gateway offers", which names no model to compare against and therefore
 *    cannot make anything stale.
 */
function dossierBuildIsCurrent(db: DB, projectId: number, refIds: number[]): boolean {
  const runs = db
    .prepare(
      /* sql */ `
      SELECT id, work_id, project_id, analysis_type, prompt_version, schema_version,
             schema_id, model, doc_input_hash, prompt_input_hash, schema_input_hash,
             dossier_input_hash
        FROM analysis_run
       WHERE project_id = ? AND analysis_type = 'dossier' AND superseded = 0
    `
    )
    .all(projectId) as Array<
    FreshnessRunInput & { model: string }
  >
  if (runs.length === 0) return false

  const covered = new Set(runs.map((r) => r.work_id))
  const refs = new Set(refIds)
  for (const workId of covered) if (!refs.has(workId)) return false
  for (const workId of refs) {
    if (covered.has(workId)) continue
    if (workHasStoredText(db, workId)) return false
  }

  const model = (getSetting(db, 'llm_extraction_model') ?? '').trim()
  const cache = newFreshnessCache()
  for (const run of runs) {
    if (model !== '' && run.model !== model) return false
    const freshness = computeAnalysisFreshness(db, run, { currentDossierInputHash }, cache)
    if (freshness.verdict !== 'current') return false
  }
  return true
}

/** Whether any paragraph of this work's text is stored — what a build can read. */
function workHasStoredText(db: DB, workId: number): boolean {
  const row = db
    .prepare(
      /* sql */ `
      SELECT 1 AS hit
        FROM document_paragraph dp
        JOIN document d ON d.id = dp.document_id
       WHERE d.work_id = ?
       LIMIT 1
    `
    )
    .get(workId) as { hit: number } | undefined
  return row !== undefined
}

/**
 * THE BRIEFING — the durable background a model is given before it reads any one
 * paper, assembled from what the project already holds.
 *
 * NOT a view of `fact`. Extracted values are what the corpus KNOWS; a briefing
 * is what a reader needs in order to understand what the corpus is TALKING
 * ABOUT — the project's statement, the terms it has defined, which papers matter
 * and why, and what each contributes. A measurement is quoted to a model when it
 * reads the paper that reported it, and is not background.
 *
 * ONE function over five tables, because the five sizes are one budget: read
 * separately they would land on screen at five different moments, each briefly
 * disagreeing with the total beside it.
 */
export function getDossierBriefing(db: DB, projectId: number): DossierBriefingDTO {
  const project = db.prepare('SELECT description FROM project WHERE id = ?').get(projectId) as
    | { description: string | null }
    | undefined
  // TRIMMED, not merely tested for content: the size below is counted over
  // exactly this string, and leading whitespace a user never sees would be
  // billed to them as briefing they are paying for.
  const about = project?.description?.trim() || null

  // --- the terms this project has defined ---------------------------------
  // Through `project_schema`, so an unattached global schema does not put terms
  // in a briefing for a project that never adopted it.
  const schemaRows = db
    .prepare(
      /* sql */ `
      SELECT es.id, es.name, es.description
        FROM project_schema ps
        JOIN extraction_schema es ON es.id = ps.schema_id
       WHERE ps.project_id = ?
       ORDER BY es.id ASC
    `
    )
    .all(projectId) as Array<{ id: number; name: string; description: string | null }>

  const fieldRows =
    schemaRows.length === 0
      ? []
      : (db
          .prepare(
            /* sql */ `
      SELECT schema_id, label, unit, data_type, description
        FROM extraction_field
       WHERE schema_id IN (${schemaRows.map(() => '?').join(',')})
       ORDER BY schema_id ASC, sort_order ASC, id ASC
    `
          )
          .all(...schemaRows.map((s) => s.id)) as Array<{
          schema_id: number
          label: string
          unit: string | null
          data_type: string
          description: string | null
        }>)

  const terms: DossierTermGroupDTO[] = schemaRows.map((s) => ({
    schema_id: s.id,
    name: s.name,
    description: s.description,
    terms: fieldRows
      .filter((f) => f.schema_id === s.id)
      .map((f) => ({
        label: f.label,
        unit: f.unit,
        data_type: f.data_type,
        description: f.description
      }))
  }))

  // --- every paper, with how much text a build would have to read ----------
  // Resolved IN SQL for the whole project at once. The per-work helpers
  // (`preferredDocumentId` + `currentTextRun`) would be two queries per paper,
  // which on a corpus-sized project is the difference between one read and
  // several hundred on the main thread.
  //
  // THE COUNT MUST MATCH WHAT A BUILD ACTUALLY READS, because the screen prints
  // it as the cost of choosing the paper. `resolveSourceText` — the resolver
  // `buildDossier` now calls — drops `reference` paragraphs and blank ones, so
  // this does too. Counting the raw inventory instead overstated the corpus by
  // a third (1874 paragraphs against the 1393 a build would see), which is a
  // bill for work nobody does.
  //
  // `is_preferred DESC, d.id ASC` mirrors `preferredDocumentId` exactly, so the
  // rail counts the same document the reader is shown, and the `WHERE d.id =`
  // filter keeps a work with a preprint AND a published version from counting
  // both. The stage-run subquery takes the NEWEST live run publishing
  // `text.paragraphs@v1` — which is what the summary and build paths read
  // (`currentTextRun.newestRunId`), NOT the stricter `stageRunId` the in-paper
  // viewer uses, since that one refuses outright when two live runs exist. A
  // work with no document, no run or no rows yields 0: a real answer meaning
  // "nothing to read", never a missing measurement.
  const paperRows = db
    .prepare(
      /* sql */ `
      SELECT pw.work_id, w.title, w.publication_year AS year,
             pw.is_reference, pw.relevance, pw.relevance_rank,
             COALESCE(t.paras, 0) AS paragraphs,
             COALESCE(t.chars, 0) AS chars
        FROM project_work pw
        JOIN work w ON w.id = pw.work_id
        LEFT JOIN (
          SELECT d.work_id,
                 COUNT(dp.id) AS paras,
                 COALESCE(SUM(LENGTH(dp.text)), 0) AS chars
            FROM document d
            JOIN document_paragraph dp ON dp.stage_run_id = (
                   SELECT sr.id
                     FROM stage_artifact sa
                     JOIN stage_run sr ON sr.id = sa.stage_run_id
                    WHERE sa.key = 'text.paragraphs@v1'
                      AND sr.document_id = d.id
                      AND sr.superseded = 0
                      AND sr.status = 'succeeded'
                    ORDER BY sr.id DESC
                    LIMIT 1
                 )
           WHERE d.id = (
                   SELECT d2.id FROM document d2
                    WHERE d2.work_id = d.work_id
                    ORDER BY d2.is_preferred DESC, d2.id ASC
                    LIMIT 1
                 )
             AND COALESCE(dp.kind, '') <> 'reference'
             AND TRIM(COALESCE(dp.text, '')) <> ''
           GROUP BY d.work_id
        ) t ON t.work_id = pw.work_id
       WHERE pw.project_id = ? AND pw.removed_at IS NULL
       ORDER BY pw.is_reference DESC, COALESCE(pw.relevance, 0) DESC, w.title ASC
    `
    )
    .all(projectId) as Array<{
    work_id: number
    title: string
    year: number | null
    is_reference: number
    relevance: number | null
    relevance_rank: number | null
    paragraphs: number
    chars: number
  }>

  const papers: DossierPaperDTO[] = paperRows.map((r) => ({
    work_id: r.work_id,
    title: r.title,
    year: r.year,
    is_reference: r.is_reference === 1,
    relevance: r.relevance,
    relevance_rank: r.relevance_rank,
    paragraphs: r.paragraphs,
    chars: r.chars
  }))

  // --- what each paper adds, in prose --------------------------------------
  // PROJECT-scoped summaries only (`ar.project_id = ?`, never the 0 sentinel):
  // a general summary describes the paper, while a project summary describes
  // what it means HERE, which is the only one that belongs in this project's
  // background.
  const summaryRows = db
    .prepare(
      /* sql */ `
      SELECT ar.work_id, w.title, ws.body, ws.source_scope
        FROM work_summary ws
        JOIN analysis_run ar ON ar.id = ws.analysis_run_id
        JOIN work w ON w.id = ar.work_id
       WHERE ar.superseded = 0
         AND ar.project_id = ?
         AND ar.analysis_type = 'summary'
       ORDER BY ar.work_id ASC
    `
    )
    .all(projectId) as Array<{
    work_id: number
    title: string
    body: string | null
    source_scope: string | null
  }>

  const contributions: DossierContributionDTO[] = []
  for (const r of summaryRows) {
    // The first PARAGRAPH — the unit the summary prompt writes in. A sentence
    // split would cut mid-claim on prose that routinely opens with a
    // semicolon-joined comparison.
    const opening = (r.body ?? '').split(/\n\n+/)[0]?.trim() ?? ''
    if (!opening) continue
    contributions.push({
      work_id: r.work_id,
      title: r.title,
      opening,
      source_scope: r.source_scope
    })
  }

  // --- what a BUILD has produced -------------------------------------------
  // Facts from `analysis_type = 'dossier'` runs, and nothing else. This is the
  // one section the briefing cannot assemble for itself, so its size is the
  // honest measure of whether a build has ever happened.
  const compiled = (
    db
      .prepare(
        /* sql */ `
      SELECT COALESCE(SUM(
               LENGTH(COALESCE(f.predicate, '')) +
               LENGTH(COALESCE(f.subject, '')) +
               LENGTH(COALESCE(f.value_text, f.object, ''))
             ), 0) AS c
        FROM fact f
        JOIN analysis_run ar ON ar.id = f.analysis_run_id
       WHERE ar.superseded = 0
         AND ar.project_id = ?
         AND ar.analysis_type = 'dossier'
    `
      )
      .get(projectId) as { c: number }
  ).c

  // Sizes are counted over exactly the strings above — the payload, not the
  // rendering. A section the screen collapses costs a model the same.
  const termsChars = terms.reduce(
    (a, g) =>
      a +
      g.name.length +
      (g.description?.length ?? 0) +
      g.terms.reduce(
        (b, t) => b + t.label.length + (t.unit?.length ?? 0) + (t.description?.length ?? 0),
        0
      ),
    0
  )
  const papersChars = papers.reduce(
    (a, p) => a + p.title.length + String(p.year ?? '').length,
    0
  )
  const contribChars = contributions.reduce((a, c) => a + c.opening.length, 0)

  return {
    about,
    terms,
    papers,
    contributions,
    sizes: {
      about: about?.length ?? 0,
      terms: termsChars,
      papers: papersChars,
      contributions: contribChars,
      compiled
    }
  }
}

// ============================================================ jobs
/**
 * Every job the project can see, carrying the stage-system columns the Queue
 * needs to state what actually happened rather than guess at it.
 *
 * The joins that earn their place:
 *  - `stage_run` (`sr`) — the run THIS JOB executed, by `j.stage_run_id`.
 *    Deliberately the job's own run and not "the current run for the key":
 *    `duration_ms` must be how long THIS job took, and `superseded` must answer
 *    "is what this job produced still current?". Reading the key's current run
 *    would answer a different question and, for a job whose work has since been
 *    re-run, would attribute the replacement's duration to the original.
 *    A NULL `stage_run_id` (never claimed, or reset by a retry) yields nulls,
 *    which the DTO documents as "no duration recorded" rather than zero.
 *  - `job_dependency` — aggregated to the stage ids this job is still waiting
 *    on. Only UNSATISFIED edges are collected, matching the scheduler's own
 *    `DEP_SATISFIED = ('done','review')`, so a satisfied upstream never leaves
 *    a job claiming to be blocked. A dependency that is `failed` or `cancelled`
 *    will never satisfy, so it is reported separately: "waiting on" a dead
 *    blocker is a wait that will not end, and saying so is the whole point.
 *  - `identifier` / `document`, unchanged, for search-by-DOI and the thumbnail.
 *
 * The blocker lists are group_concats rather than second queries because the
 * Queue refetches this whole list on every `jobs:changed` push, and an N+1 over
 * a corpus-sized queue would make the live update the slowest thing on screen.
 */
const JOB_SELECT = /* sql */ `
      SELECT j.id, j.job_type, j.stage, j.fanout_key, j.status,
             j.outcome, j.outcome_note, j.error_kind,
             j.progress_pct, j.progress_note,
             j.work_id, w.title AS work_title,
             (SELECT i.value FROM identifier i
                WHERE i.work_id = w.id AND i.scheme = 'doi'
                ORDER BY i.id ASC LIMIT 1) AS work_doi,
             j.error, j.attempts, j.dismissed, j.updated_at, j.created_at,
             j.started_at, j.finished_at,
             j.stage_run_id,
             sr.duration_ms AS stage_run_duration_ms,
             sr.superseded AS stage_run_superseded,
             (SELECT group_concat(COALESCE(b.stage, b.job_type), CHAR(31))
                FROM job_dependency jd
                JOIN processing_job b ON b.id = jd.depends_on_job_id
               WHERE jd.job_id = j.id
                 AND b.status NOT IN ('done','review')
                 AND b.status NOT IN ('failed','cancelled')) AS blocked_by,
             (SELECT group_concat(COALESCE(b.stage, b.job_type), CHAR(31))
                FROM job_dependency jd
                JOIN processing_job b ON b.id = jd.depends_on_job_id
               WHERE jd.job_id = j.id
                 AND b.status IN ('failed','cancelled')) AS dead_blockers,
             td.id AS document_id,
             -- How that same document's text was obtained. Read off the JOINED
             -- row rather than by a third copy of the resolution expression, so
             -- the badge can only ever describe the document the thumbnail shows.
             td.text_source, td.text_confidence
      FROM processing_job j
      LEFT JOIN work w ON w.id = j.work_id
      LEFT JOIN stage_run sr ON sr.id = j.stage_run_id
      -- The job's OWN document when it has one. A job processes a specific
      -- version; falling back to the work's preferred document unconditionally
      -- would show a page-1 thumbnail of a different PDF than the one the stage
      -- actually read.
      LEFT JOIN document td ON td.id = COALESCE(j.document_id,
               (SELECT d.id FROM document d
                  WHERE d.work_id = w.id
                  ORDER BY d.is_preferred DESC, d.id ASC LIMIT 1))
`

type JobRawRow = Omit<
  JobDTO,
  'dismissed' | 'blocked_by' | 'dead_blockers' | 'stage_run_superseded'
> & {
  dismissed: number
  blocked_by: string | null
  dead_blockers: string | null
  stage_run_superseded: number | null
}

function toJobDto(r: unknown): JobDTO {
  const row = r as JobRawRow
  // Unit separator, not a comma: a stage id is author-chosen text and a
  // comma in one would split a single blocker into two phantom ones.
  const split = (s: string | null): string[] => (s === null ? [] : s.split('\u001f'))
  return {
    ...row,
    dismissed: row.dismissed === 1,
    blocked_by: split(row.blocked_by),
    dead_blockers: split(row.dead_blockers),
    stage_run_superseded:
      row.stage_run_superseded === null ? null : row.stage_run_superseded === 1
  }
}

/**
 * WHICH JOBS A PROJECT MAY SEE. Takes the project id TWICE.
 *
 * `project_id = 0` is the GLOBAL sentinel, not "unset" — the column is NOT NULL,
 * so an `IS NULL` branch would match nothing.
 *
 * But "global" describes the ANALYSIS, not the paper: a stage filed at 0 still
 * runs on somebody's work, and that work belongs to whoever holds it. The
 * predicate was `j.project_id IN (?, 0)`, which showed every global job in every
 * project's queue — a corpus with an enzyme project and an embeddings project
 * listed all 21 enzyme papers under the embeddings one, which reads as the app
 * having mixed up the user's research. Measured on the real corpus: 21 papers
 * that are not in project 2 were visible there.
 *
 * So a global job is admitted only where its work is a member. A global job with
 * NO work — a corpus-wide sweep — has no owner to check and still shows
 * everywhere, which is right: it is one unit of work about the whole install,
 * not about anybody's paper.
 */
const JOB_IN_PROJECT = /* sql */ `(
  j.project_id = ?
  OR (j.project_id = 0
      AND (j.work_id IS NULL
           OR EXISTS (SELECT 1 FROM project_work pw
                       WHERE pw.work_id = j.work_id AND pw.project_id = ?)))
)`

export function listJobs(
  db: DB,
  projectId: number,
  // No LIMIT unless one is asked for: the Ingest screen's queue tab draws them all.
  page: { limit?: number; offset?: number } = {}
): JobDTO[] {
  const limitClause = page.limit === undefined ? '' : '\n      LIMIT ? OFFSET ?'
  const limitParams =
    page.limit === undefined ? [] : [Math.max(1, page.limit), Math.max(0, page.offset ?? 0)]
  return db
    .prepare(
      JOB_SELECT +
        `\n      WHERE ${JOB_IN_PROJECT}
      ORDER BY j.updated_at DESC, j.id DESC${limitClause}`
    )
    .all(projectId, projectId, ...limitParams)
    .map(toJobDto)
}

/** How many jobs the project has, under the same WHERE as `listJobs`. */
export function countJobs(db: DB, projectId: number): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS c FROM processing_job j WHERE ${JOB_IN_PROJECT}`)
      .get(projectId, projectId) as { c: number }
  ).c
}

/**
 * ONE job, by id, in the same shape the list returns.
 *
 * Not scoped to a project, and deliberately: a job id is already the answer to
 * "which job", so a project filter could only turn a legitimate lookup of a
 * global (`project_id = 0`) job into a null. The row names its own project.
 */
export function getJobById(db: DB, jobId: number): JobDTO | null {
  const row = db.prepare(JOB_SELECT + `\n      WHERE j.id = ?`).get(jobId)
  return row === undefined ? null : toJobDto(row)
}

/**
 * Mark a failed job as seen (or un-see it). Nothing about the FAILURE changes —
 * the row keeps its status and error — only whether it still counts as
 * outstanding. Returns the updated job list so the caller renders from the
 * write's result rather than a re-read.
 */
export function setJobDismissed(
  db: DB,
  jobId: number,
  dismissed: boolean,
  projectId: number,
  // The refreshed list the caller paints from. Unpaged by default, because the
  // acting window repaints its whole queue from this return value.
  page: { limit?: number; offset?: number } = {}
): JobDTO[] {
  db.prepare('UPDATE processing_job SET dismissed = ? WHERE id = ?').run(dismissed ? 1 : 0, jobId)
  return listJobs(db, projectId, page)
}

// ============================================================ search
//
// Filtering runs in SQL, never as a post-filter in the renderer: the LIMIT below
// would otherwise be applied BEFORE the filter and silently hide matches.
//
// Composition rule: OR *within* a facet (a facet is a multi-select), AND
// *across* facets and the free-text query.
//
// Every clause is built from a fixed column literal plus `?` placeholders whose
// COUNT is derived from the array length — user values are only ever bound, so
// no filter value can reach the SQL text.

/** One composable WHERE fragment plus its bound parameters. */
type Clause = { sql: string; params: unknown[] }

/** Which facet a clause came from, so facet counts can exclude their own. */
type FacetKey = keyof SearchFilters

/** `col IN (?,?,…)`, or null when the facet is unset (an empty `IN ()` is a syntax error). */
function inClause(col: string, values: string[] | undefined): Clause | null {
  const v = (values ?? []).filter((s) => typeof s === 'string' && s.length > 0)
  if (v.length === 0) return null
  return { sql: `${col} IN (${v.map(() => '?').join(',')})`, params: v }
}

/**
 * The year facet is presented either as exact years ("1998") or, when the
 * corpus spans many years, as DECADE labels the renderer builds with an EN DASH
 * ("1990–1999"). Both forms are accepted and compiled to real numeric SQL, so a
 * decade chip filters the whole decade rather than matching a literal string.
 */
function yearClause(values: string[] | undefined): Clause | null {
  const exact: number[] = []
  const ranges: [number, number][] = []
  for (const raw of values ?? []) {
    const m = /^\s*(\d{1,4})\s*[-–—]\s*(\d{1,4})\s*$/.exec(raw)
    if (m) {
      const a = Number(m[1])
      const b = Number(m[2])
      ranges.push(a <= b ? [a, b] : [b, a])
      continue
    }
    const y = Number(raw.trim())
    if (Number.isInteger(y)) exact.push(y)
  }
  const parts: string[] = []
  const params: unknown[] = []
  if (exact.length > 0) {
    parts.push(`w.publication_year IN (${exact.map(() => '?').join(',')})`)
    params.push(...exact)
  }
  for (const [a, b] of ranges) {
    parts.push(`w.publication_year BETWEEN ? AND ?`)
    params.push(a, b)
  }
  if (parts.length === 0) return null
  return { sql: `(${parts.join(' OR ')})`, params }
}

/**
 * Content status lives on the work's PREFERRED document. EXISTS (not a JOIN) so
 * a work is never duplicated in the result set if the one-preferred-document
 * invariant is ever relaxed. Works with no preferred document match no bucket —
 * they are reachable only with the content facet cleared.
 */
function contentStatusClause(values: string[] | undefined): Clause | null {
  const inner = inClause('d.content_status', values)
  if (!inner) return null
  return {
    sql: `EXISTS (SELECT 1 FROM document d WHERE d.work_id = w.id AND d.is_preferred = 1 AND ${inner.sql})`,
    params: inner.params
  }
}

/**
 * Free-text clause over title/abstract/venue, or null for an empty query.
 *
 * `|` separates ALTERNATIVES: `a | b` matches a paper containing either, as the
 * bar does in any search box. Empty alternatives (`a || b`, a trailing bar) are
 * dropped — an empty LIKE would be `%%`, which matches every row and would
 * silently widen the search instead of narrowing it.
 */
function queryClause(query: string): Clause | null {
  const parts = query
    .split('|')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  if (parts.length === 0) return null

  const params: unknown[] = []
  const ors = parts.map((q) => {
    params.push(...Array<string>(3).fill(likePattern(q)))
    return (
      `search_fold(w.title) LIKE ? ESCAPE '\\' OR ` +
      `search_fold(w.abstract) LIKE ? ESCAPE '\\' OR ` +
      `search_fold(w.venue) LIKE ? ESCAPE '\\'`
    )
  })
  return { sql: `(${ors.join(' OR ')})`, params }
}

/**
 * A user's words as a LIKE pattern, folded to the same shape as the column.
 *
 * ORDER IS LOAD-BEARING: fold FIRST, escape SECOND. Folding a pattern that has
 * already been escaped rewrites the escape sequences themselves — `\_` becomes
 * `\ `, which is not an escape, so the underscore reverts to a single-character
 * wildcard and a query of "_" matches every row. That regression was measured
 * here, not imagined.
 *
 * `\ % _` are escaped so a user searching for a literal percent finds papers
 * containing one instead of receiving the whole corpus.
 */
function likePattern(query: string): string {
  return `%${foldForSearch(query).replace(/[\\%_]/g, (c) => '\\' + c)}%`
}


/**
 * All facet clauses, tagged with their facet so a facet's own clause can be
 * dropped when counting that facet (standard faceted-search counting).
 *
 * `inclusion_status` is a PROJECT interpretation, so it only exists when scoped.
 * Unscoped, `getFacets` offers no inclusion buckets, so the UI cannot present
 * such a chip — but a saved search could still carry one. Rather than silently
 * widening the result (returning MORE papers than the restored chips claim), an
 * unscoped inclusion filter matches nothing.
 */
function facetClauses(
  filters: SearchFilters | undefined,
  scoped: boolean
): { key: FacetKey; clause: Clause }[] {
  if (!filters) return []
  const out: { key: FacetKey; clause: Clause }[] = []
  const push = (key: FacetKey, clause: Clause | null): void => {
    if (clause) out.push({ key, clause })
  }
  push('work_type', inClause('w.work_type', filters.work_type))
  push('venue', inClause('w.venue', filters.venue))
  push('year', yearClause(filters.year))
  push('content_status', contentStatusClause(filters.content_status))
  if (scoped) {
    push('inclusion_status', inClause('pw.inclusion_status', filters.inclusion_status))
  } else if ((filters.inclusion_status ?? []).length > 0) {
    push('inclusion_status', { sql: '0', params: [] })
  }
  return out
}

/**
 * Range / text narrowing that is NOT a facet chip: year bounds, a citation-count
 * floor and an author substring.
 *
 * Kept separate from `facetClauses` because facet counts are computed by
 * re-running the query with one facet dropped — these are not facets and must
 * never be dropped from that computation. Returned as plain clauses so BOTH
 * `search` and `countSearch` include them; applying a filter to only one of the
 * two would make the count contradict the list it labels.
 */
function rangeClauses(filters: SearchFilters | undefined): Clause[] {
  if (!filters) return []
  const out: Clause[] = []
  // A work with no year cannot satisfy a year bound. Excluding it is honest;
  // treating NULL as in-range would assert a date the corpus does not hold.
  if (filters.yearFrom !== undefined) {
    out.push({
      sql: '(w.publication_year IS NOT NULL AND w.publication_year >= ?)',
      params: [filters.yearFrom]
    })
  }
  if (filters.yearTo !== undefined) {
    out.push({
      sql: '(w.publication_year IS NOT NULL AND w.publication_year <= ?)',
      params: [filters.yearTo]
    })
  }
  if (filters.minCitations !== undefined) {
    out.push({
      sql: '(SELECT COUNT(*) FROM citation_edge ce WHERE ce.cited_work_id = w.id) >= ?',
      params: [filters.minCitations]
    })
  }
  // Comma-separated names mean ANY of them: "work from any of these groups" is
  // the question being asked, and requiring all of them returns nothing for
  // almost every pair.
  const names = (filters.author ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter((a) => a.length > 0)
  if (names.length > 0) {
    // Folded like every other text comparison, and for the sharper reason:
    // author names are exactly where accents and hyphens live. "Rothlisberger"
    // found nothing while "Röthlisberger" found seven papers, and
    // "Head Gordon" found nothing while "Head-Gordon" found two — a reader
    // cannot be asked to reproduce diacritics they may not have on the
    // keyboard. `search_fold` also lowercases, so the COLLATE NOCASE this
    // carried is subsumed rather than dropped.
    const ors = names.map(() => `search_fold(a.full_name) LIKE ? ESCAPE '\\'`).join(' OR ')
    out.push({
      sql: `EXISTS (SELECT 1 FROM work_author wa JOIN author a ON a.id = wa.author_id
                     WHERE wa.work_id = w.id AND (${ors}))`,
      params: names.map(likePattern)
    })
  }
  return out
}

/** ORDER BY for the corpus search. `relevance` needs a project to be meaningful. */
function orderBy(sort: SearchSort | undefined, scoped: boolean): string {
  const cites = '(SELECT COUNT(*) FROM citation_edge ce WHERE ce.cited_work_id = w.id)'
  // Every order ends in a title tiebreak, so equal keys never reshuffle between
  // two identical searches — and then in `w.id`, which makes the order TOTAL.
  // Two papers really can share a title, and a tie under LIMIT/OFFSET puts one
  // row on two pages and another on none.
  const tie = 'w.title COLLATE NOCASE ASC, w.id ASC'
  switch (sort) {
    case 'year':
      // Undated works sort last rather than leading a "newest first" list.
      return `w.publication_year IS NULL, w.publication_year DESC, ${tie}`
    case 'citations':
      return `${cites} DESC, ${tie}`
    case 'title':
      return tie
    default:
      return scoped ? `pw.relevance DESC, ${tie}` : tie
  }
}

/** Assemble `WHERE …` + params from a clause list (always non-empty via 1=1). */
function whereOf(clauses: Clause[]): { where: string; params: unknown[] } {
  if (clauses.length === 0) return { where: '1=1', params: [] }
  return {
    where: clauses.map((c) => c.sql).join(' AND '),
    params: clauses.flatMap((c) => c.params)
  }
}

/**
 * Cap on returned ROWS. `countSearch` is deliberately uncapped, so the UI can
 * say "showing 300 of 3128" rather than pretending the corpus is 300 papers.
 */
export const SEARCH_LIMIT = 300

/**
 * Corpus search. An empty query is NOT an empty result: with no filters it is
 * "every paper in the project" (the Papers list), and with filters set it is the
 * filter-only result. A filter that matches nothing yields zero rows — an honest
 * empty state, never a silently-widened query.
 */
export function search(
  db: DB,
  query: string,
  projectId?: number,
  filters?: SearchFilters,
  // A window WITHIN the `SEARCH_LIMIT` matched rows. The renderer passes nothing
  // and gets the same 300 it always did; a paging caller gets its window without
  // the 300-row author fan-out being paid for rows it will discard.
  page: { limit?: number; offset?: number } = {}
): SearchResultDTO[] {
  const scoped = projectId != null && projectId > 0
  const clauses: Clause[] = []
  const q = queryClause(query)
  if (q) clauses.push(q)
  for (const { clause } of facetClauses(filters, scoped)) clauses.push(clause)
  clauses.push(...rangeClauses(filters))

  // The citation count is SELECTed as well as sorted on, so the row can show the
  // number the ordering is based on rather than asking the user to trust it.
  const cols = /* sql */ `
    w.id AS work_id, w.title, w.publication_year AS year, w.venue,
    w.work_type, substr(w.abstract, 1, 200) AS snippet,
    (SELECT COUNT(*) FROM citation_edge ce WHERE ce.cited_work_id = w.id) AS citation_count`

  const { where, params } = whereOf(clauses)
  // The window never reaches past `SEARCH_LIMIT`: the cap is on the MATCHED rows,
  // so a page is a slice of those 300 and not a way to walk the whole corpus 200
  // rows at a time. An offset at or past the cap yields nothing, which is what
  // slicing the 300-row array did too.
  const offset = Math.max(0, page.offset ?? 0)
  const windowSize =
    page.limit === undefined
      ? SEARCH_LIMIT - Math.min(offset, SEARCH_LIMIT)
      : Math.max(0, Math.min(Math.max(1, page.limit), SEARCH_LIMIT - Math.min(offset, SEARCH_LIMIT)))
  if (windowSize === 0) return []
  // BOUND, not interpolated: the statement text is then identical for every
  // page, so better-sqlite3's prepared-statement cache holds one entry for this
  // query instead of one per distinct window.
  const windowParams = [windowSize, Math.min(offset, SEARCH_LIMIT)]

  const rows = (
    scoped
      ? db
          .prepare(
            /* sql */ `
        SELECT ${cols}
        FROM project_work pw
        JOIN work w ON w.id = pw.work_id
        WHERE pw.project_id = ? AND ${where}
        ORDER BY ${orderBy(filters?.sort, true)}
        LIMIT ? OFFSET ?
      `
          )
          .all(projectId, ...params, ...windowParams)
      : db
          .prepare(
            /* sql */ `
      SELECT ${cols}
      FROM work w
      WHERE ${where}
      ORDER BY ${orderBy(filters?.sort, false)}
      LIMIT ? OFFSET ?
    `
          )
          .all(...params, ...windowParams)
  ) as Omit<SearchResultDTO, 'authors'>[]

  if (rows.length === 0) return []
  // Authors in ONE query for the whole page rather than one per row: the search
  // returns up to SEARCH_LIMIT rows, and a per-row query would be 300 round
  // trips for a list the user scrolls past.
  const ids = rows.map((r) => r.work_id)
  const authorRows = db
    .prepare(
      /* sql */ `
      SELECT wa.work_id, a.full_name
        FROM work_author wa
        JOIN author a ON a.id = wa.author_id
       WHERE wa.work_id IN (${ids.map(() => '?').join(',')})
       ORDER BY wa.work_id ASC, wa.position ASC`
    )
    .all(...ids) as Array<{ work_id: number; full_name: string }>
  const byWork = new Map<number, string[]>()
  for (const a of authorRows) {
    const list = byWork.get(a.work_id)
    if (list) list.push(a.full_name)
    else byWork.set(a.work_id, [a.full_name])
  }
  return rows.map((r) => ({ ...r, authors: byWork.get(r.work_id) ?? [] }))
}

/**
 * How many papers match — counted in SQL and NOT capped by SEARCH_LIMIT, so the
 * result line can state the true total instead of the size of the page it got.
 */
export function countSearch(
  db: DB,
  query: string,
  projectId?: number,
  filters?: SearchFilters
): number {
  const scoped = projectId != null && projectId > 0
  const clauses: Clause[] = []
  const q = queryClause(query)
  if (q) clauses.push(q)
  for (const { clause } of facetClauses(filters, scoped)) clauses.push(clause)
  // The SAME range narrowing the row query applies, so "N papers match" counts
  // the rows the user is actually looking at.
  clauses.push(...rangeClauses(filters))
  const { where, params } = whereOf(clauses)

  const row = scoped
    ? (db
        .prepare(
          `SELECT COUNT(*) AS n FROM project_work pw JOIN work w ON w.id = pw.work_id
           WHERE pw.project_id = ? AND ${where}`
        )
        .get(projectId, ...params) as { n: number })
    : (db.prepare(`SELECT COUNT(*) AS n FROM work w WHERE ${where}`).get(...params) as {
        n: number
      })
  return row.n
}

/**
 * Facet buckets for the current query + filters. Each facet is counted with the
 * query and ALL OTHER facets applied but NOT its own, so the numbers stay true
 * while a facet remains multi-selectable (the classic faceted-count rule). An
 * unfiltered count would visibly lie the moment any chip is pressed.
 */
export function getFacets(db: DB, projectId: number, query = '', filters?: SearchFilters): FacetsDTO {
  const scoped = projectId != null && projectId > 0
  const q = queryClause(query)
  const facets = facetClauses(filters, scoped)

  // Applied to EVERY facet count. The "leave out its own facet" rule exists so a
  // multi-select chip can still show what it would add; the range filters are
  // not facets and are never the one being counted, so leaving them out would
  // print chip numbers larger than the result list they sit beside.
  const ranges = rangeClauses(filters)

  /** WHERE for a facet's own count: everything except that facet's clause. */
  const context = (self: FacetKey): { where: string; params: unknown[] } =>
    whereOf([
      ...(q ? [q] : []),
      ...facets.filter((f) => f.key !== self).map((f) => f.clause),
      ...ranges
    ])

  // Positional `?` throughout (never mixed with named params): the project id
  // binds first, then each clause's params in clause order.
  const source = scoped
    ? `FROM project_work pw JOIN work w ON w.id = pw.work_id WHERE pw.project_id = ? AND`
    : `FROM work w WHERE`

  const bucket = (self: FacetKey, col: string): FacetBucketDTO[] => {
    const { where, params } = context(self)
    return db
      .prepare(
        `SELECT ${col} AS value, COUNT(*) AS count ${source} ${where}
         AND ${col} IS NOT NULL GROUP BY ${col} ORDER BY count DESC, value ASC`
      )
      .all(...(scoped ? [projectId] : []), ...params) as FacetBucketDTO[]
  }

  const work_type = bucket('work_type', 'w.work_type')
  const venue = bucket('venue', 'w.venue')

  const yearCtx = context('year')
  const year = db
    .prepare(
      `SELECT CAST(w.publication_year AS TEXT) AS value, COUNT(*) AS count ${source} ${yearCtx.where}
       AND w.publication_year IS NOT NULL GROUP BY w.publication_year ORDER BY w.publication_year DESC`
    )
    .all(...(scoped ? [projectId] : []), ...yearCtx.params) as FacetBucketDTO[]

  const csCtx = context('content_status')
  const content_status = db
    .prepare(
      `SELECT d.content_status AS value, COUNT(DISTINCT w.id) AS count
       ${
         scoped
           ? 'FROM project_work pw JOIN work w ON w.id = pw.work_id JOIN document d ON d.work_id = w.id AND d.is_preferred = 1 WHERE pw.project_id = ? AND'
           : 'FROM work w JOIN document d ON d.work_id = w.id AND d.is_preferred = 1 WHERE'
       } ${csCtx.where}
       AND d.content_status IS NOT NULL
       GROUP BY d.content_status ORDER BY count DESC`
    )
    .all(...(scoped ? [projectId] : []), ...csCtx.params) as FacetBucketDTO[]

  const incCtx = context('inclusion_status')
  const inclusion_status = scoped
    ? (db
        .prepare(
          `SELECT pw.inclusion_status AS value, COUNT(*) AS count
           FROM project_work pw JOIN work w ON w.id = pw.work_id
           WHERE pw.project_id = ? AND ${incCtx.where}
           AND pw.inclusion_status IS NOT NULL
           GROUP BY pw.inclusion_status ORDER BY count DESC`
        )
        .all(projectId, ...incCtx.params) as FacetBucketDTO[])
    : []

  return { work_type, venue, year, inclusion_status, content_status }
}

/** How many past searches are kept per project. */
export const SEARCH_HISTORY_LIMIT = 25

/**
 * Past searches, MOST RECENT FIRST.
 *
 * Ordered by `updated_at` rather than by name: this is a history, so recency is
 * the only ordering that matches how it is read. Capped, because an unbounded
 * list of every search ever run stops being navigable.
 */
export function listSearchHistory(db: DB, projectId: number): SavedSearchDTO[] {
  return db
    .prepare(
      `SELECT id, project_id, name, query, filters FROM saved_search
       WHERE project_id = ? OR project_id IS NULL
       ORDER BY updated_at DESC, id DESC
       LIMIT ${SEARCH_HISTORY_LIMIT}`
    )
    .all(projectId) as SavedSearchDTO[]
}

/**
 * Record an executed search, keeping the WHOLE parameter set.
 *
 * Re-running the same search must not grow the list: an identical
 * query+parameters row is bumped to the top rather than duplicated, which is
 * what makes the history usable after a session of tweaking one filter.
 * `filters` is compared as its stored JSON, so the renderer must serialize it
 * consistently — it builds both sides from the same `SearchFilters` object.
 *
 * Trimming happens here, not on read: the cap is a property of what is kept.
 */
export function recordSearch(
  db: DB,
  input: { projectId: number; name: string; query: string; filters?: string },
  now: string
): SavedSearchDTO {
  const filters = input.filters ?? null
  return db.transaction(() => {
    const existing = db
      .prepare(
        `SELECT id FROM saved_search
          WHERE project_id = ? AND query = ? AND IFNULL(filters, '') = IFNULL(?, '')`
      )
      .get(input.projectId, input.query, filters) as { id: number } | undefined

    const id = existing
      ? (db
          .prepare(`UPDATE saved_search SET name = ?, updated_at = ? WHERE id = ?`)
          .run(input.name, now, existing.id),
        existing.id)
      : Number(
          db
            .prepare(
              `INSERT INTO saved_search (project_id, name, query, filters, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)`
            )
            .run(input.projectId, input.name, input.query, filters, now, now).lastInsertRowid
        )

    db.prepare(
      `DELETE FROM saved_search
        WHERE project_id = ? AND id NOT IN (
          SELECT id FROM saved_search WHERE project_id = ?
           ORDER BY updated_at DESC, id DESC LIMIT ${SEARCH_HISTORY_LIMIT})`
    ).run(input.projectId, input.projectId)

    return db
      .prepare(`SELECT id, project_id, name, query, filters FROM saved_search WHERE id = ?`)
      .get(id) as SavedSearchDTO
  })()
}

export function listFrontiers(db: DB, projectId: number): SavedFrontierDTO[] {
  return db
    .prepare(
      `SELECT id, project_id, name, graph_state FROM saved_frontier
       WHERE project_id = ? OR project_id IS NULL ORDER BY name COLLATE NOCASE ASC`
    )
    .all(projectId) as SavedFrontierDTO[]
}

export function saveFrontier(
  db: DB,
  input: { projectId: number; name: string; graphState: string },
  now: string
): SavedFrontierDTO {
  const info = db
    .prepare(
      `INSERT INTO saved_frontier (project_id, name, graph_state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(input.projectId, input.name, input.graphState, now, now)
  return db
    .prepare(`SELECT id, project_id, name, graph_state FROM saved_frontier WHERE id = ?`)
    .get(Number(info.lastInsertRowid)) as SavedFrontierDTO
}

// ============================================================ pdf read
/** Resolve document_id -> abs path (validated inside base_dir) or null. */
export function resolvePdfPath(
  db: DB,
  documentId: number
): { baseDir: string; relativePath: string } | null {
  const row = db
    .prepare(
      `SELECT bd.abs_path AS base_dir, fl.relative_path AS relative_path
       FROM file_location fl
       JOIN base_dir bd ON bd.id = fl.base_dir_id
       WHERE fl.document_id = ?
       ORDER BY fl.id ASC LIMIT 1`
    )
    .get(documentId) as { base_dir: string; relative_path: string } | undefined
  if (!row) return null
  return { baseDir: row.base_dir, relativePath: row.relative_path }
}

/**
 * The word geometry of an OCR'd document, or null when it has none.
 *
 * Keyed off the CURRENT `ocr` stage run rather than the document, because a
 * superseded run's artifact is still in the table: `deleteRunOutput` clears
 * artifacts on retirement, but a run superseded by a re-OCR is retained as
 * provenance, and answering from it would draw the previous recognition's boxes
 * over the current recognition's text.
 *
 * Null for every text-layer document, which is correct and is the common case:
 * pdf.js already supplies their glyph geometry, and the viewer only synthesises
 * a layer when there is nothing else to draw.
 */
export function readOcrWordBoxes(db: DB, documentId: number): unknown | null {
  const row = db
    .prepare(
      `SELECT sa.json AS json
         FROM stage_artifact sa
         JOIN stage_run sr ON sr.id = sa.stage_run_id
        WHERE sr.document_id = ?
          AND sr.stage = 'ocr'
          AND sr.status = 'succeeded'
          AND sr.superseded = 0
          AND sa.key = 'text.wordboxes@v1'
        ORDER BY sr.id DESC LIMIT 1`
    )
    .get(documentId) as { json: string } | undefined
  if (!row) return null
  try {
    return JSON.parse(row.json)
  } catch {
    // A corrupt artifact must read as "no geometry", not crash the viewer: the
    // page still renders as an image, which is exactly the pre-existing
    // behaviour and an honest one.
    return null
  }
}

// ============================================================ integrations
// Everything below is a REAL local filesystem probe or an explicit "unknown".
// No network call is made anywhere in this section — the app must run with
// networking disabled, so a status that could only be learned over the wire is
// reported as undetermined rather than guessed.

/**
 * The conventional Zotero data directory. Zotero honours `$ZOTERO_DATA_DIR`;
 * otherwise its default on every desktop platform is `~/Zotero`. We do NOT try
 * to read Zotero's own prefs file to find a relocated directory — parsing
 * another app's config to make a confident claim is the sort of guess this code
 * is meant to avoid; if it is somewhere else we simply report not found, and the
 * UI shows the path we looked at so the user can see why.
 */
function zoteroDataDir(): string {
  const fromEnv = process.env.ZOTERO_DATA_DIR
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  return join(homedir(), 'Zotero')
}

export async function getIntegrationsStatus(db: DB): Promise<IntegrationsStatusDTO> {
  const dataDir = zoteroDataDir()
  const sqlitePath = join(dataDir, 'zotero.sqlite')
  const dirOk = await probeDirectory(dataDir)

  // The two Zotero checks are genuinely INDEPENDENT, not one boolean printed
  // twice: `installed` is "a zotero.sqlite is there at all" (stat), while
  // `accessible` additionally requires that THIS process may read it (R_OK). A
  // library owned by another user, or one under a directory we may traverse but
  // not read, makes them disagree — exactly the case worth surfacing.
  //
  // A timed-out probe stays `null` all the way to the UI. Collapsing an
  // unanswered probe into `false` would assert "no Zotero library" about a
  // machine we simply failed to inspect — the fabricated negative this whole
  // surface exists to prevent.
  const exists =
    dirOk === null ? null : dirOk === false ? false : await probeFileExists(sqlitePath)
  const readable =
    exists === null ? null : exists === false ? false : await probeFileReadable(sqlitePath)

  // Obsidian: a local base_dir row is not enough — it must actually be there.
  // Same tri-state discipline: if no root answered true but some timed out, the
  // answer is UNKNOWN, not "no vault root".
  const localProbes = await Promise.all(
    baseDirPathsOfKind(db, 'local').map((p) => probeDirectory(p))
  )
  const obsidian = anyReachable(localProbes)

  return {
    zotero_installed: exists,
    // UNKNOWN, deliberately. The only local signals for "is it running" are the
    // -wal/-shm sidecar files, and those survive a crash and are absent while a
    // cleanly-idle Zotero runs — so reading them as "running" would be a guess.
    zotero_running: null,
    zotero_accessible: readable,
    // Reported unless we positively know the directory is absent, so the user
    // can always see WHERE the claim (or the non-claim) came from.
    zotero_data_path: dirOk === false ? null : dataDir,
    obsidian_enabled: obsidian
  }
}

// Storage locations live in `repos/baseDirs.ts` — re-exported here so the
// existing import site keeps working while new code imports the module directly.
export {
  listBaseDirs,
  addBaseDir,
  updateBaseDir,
  removeBaseDir,
  removalBlocker
} from './repos/baseDirs'

// ============================================================ settings
// Generic key/value setting store (app-owned config, DB-backed per the
// seed-only-DB rule). Small helpers used by the model-selection accessors.
export function getSetting(db: DB, key: string): string | null {
  const row = db.prepare(`SELECT value FROM setting WHERE key = ?`).get(key) as
    | { value: string }
    | undefined
  return row ? row.value : null
}

export function setSetting(db: DB, key: string, value: string): void {
  db.prepare(
    `INSERT INTO setting (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value, new Date().toISOString())
}

const SELECTED_MODEL_KEY = 'selected_model_id'

/** The selectable analysis models, seeded as real rows (never hardcoded). */
export function listModels(db: DB): LlmModelDTO[] {
  return db
    .prepare(
      `SELECT id, label, sub, provider FROM llm_model ORDER BY sort_order ASC, id ASC`
    )
    .all() as LlmModelDTO[]
}

/**
 * The currently-selected analysis model. Reads `setting.selected_model_id` and
 * resolves it to a model row. Falls back to the lowest-sort_order model when the
 * setting is missing or dangles (e.g. the selected id was removed) so the UI
 * always has a valid selection. Returns null only when there are NO models.
 */
export function getSelectedModel(db: DB): LlmModelDTO | null {
  const id = getSetting(db, SELECTED_MODEL_KEY)
  if (id) {
    const row = db
      .prepare(`SELECT id, label, sub, provider FROM llm_model WHERE id = ?`)
      .get(id) as LlmModelDTO | undefined
    if (row) return row
  }
  // Missing/dangling selection: fall back to the first model by sort order.
  const first = db
    .prepare(
      `SELECT id, label, sub, provider FROM llm_model ORDER BY sort_order ASC, id ASC LIMIT 1`
    )
    .get() as LlmModelDTO | undefined
  return first ?? null
}

/**
 * Persist the selected analysis model. REJECTS an unknown id (validation lives
 * here, not just at the IPC boundary) and RETURNS the newly-selected model so
 * the caller updates from the return value (no read-after-write race).
 */
export function setSelectedModel(db: DB, id: string): LlmModelDTO {
  const row = db
    .prepare(`SELECT id, label, sub, provider FROM llm_model WHERE id = ?`)
    .get(id) as LlmModelDTO | undefined
  if (!row) throw new Error(`unknown model id: ${id}`)
  setSetting(db, SELECTED_MODEL_KEY, id)
  return row
}

/**
 * Per-project storage roll-up for the Settings modal. Sums the REAL
 * file_location.size_bytes across each project's works (via project_work →
 * work → document → file_location); files of unknown size contribute 0. Only
 * papers that actually have stored files are listed, largest first.
 */
export function getStorageUsage(db: DB): StorageProjectDTO[] {
  const projects = db
    .prepare(`SELECT id, name FROM project ORDER BY id ASC`)
    .all() as Array<{ id: number; name: string }>

  const paperStmt = db.prepare(
    `SELECT w.id AS work_id, w.title AS title,
            COALESCE(SUM(fl.size_bytes), 0) AS size_bytes
       FROM project_work pw
       JOIN work w        ON w.id = pw.work_id
       JOIN document d    ON d.work_id = w.id
       JOIN file_location fl ON fl.document_id = d.id
      WHERE pw.project_id = ?
      GROUP BY w.id, w.title
     HAVING SUM(fl.size_bytes) > 0
      ORDER BY size_bytes DESC, w.title ASC`
  )

  return projects.map((p) => {
    const papers = paperStmt.all(p.id) as StoragePaperDTO[]
    const size_bytes = papers.reduce((sum, pp) => sum + pp.size_bytes, 0)
    return { project_id: p.id, name: p.name, size_bytes, papers }
  })
}

// ============================================================ export
/**
 * Export a project. 'json' and 'graph' are the two STRUCTURAL formats; ANY other
 * string is resolved as an `extraction_schema.export_alias` row and rendered
 * generically from that schema's DB-defined field list.
 *
 * No domain format name appears in code: the format name, the field list and the
 * units are all DB rows, so adding an export format is a CRUD operation on a
 * schema rather than a code change.
 */
export function exportProject(db: DB, projectId: number, format: string): string {
  const project = getProject(db, projectId)
  if (!project) throw new Error(`project ${projectId} not found`)

  if (format === 'graph') {
    const g = getGraph(db, projectId, { limit: 1000 })
    return JSON.stringify(g, null, 2)
  }

  const works = listProjectWorks(db, projectId)

  if (format !== 'json') {
    const schema = findSchemaByExportAlias(db, format)
    if (!schema) throw new Error(`unknown export format '${format}'`)
    // Only the records that actually fill THIS schema's fields.
    const rows = getExtractionRows(db, projectId).filter((r) => r.schema_id === schema.id)
    return JSON.stringify(
      {
        name: project.name,
        description: project.description,
        schema: {
          key: schema.key,
          name: schema.name,
          version: schema.version,
          fields: schema.fields.map((f) => ({
            key: f.key,
            label: f.label,
            data_type: f.data_type,
            unit: f.unit,
            required: f.required,
            enum_options: f.enum_options
          }))
        },
        // `records`, not `measurements`: a text field (variant, substrate) is an
        // extracted record that carries no measurement at all, and calling the
        // list measurements told the consumer of the file something false.
        records: rows.map((r) => ({
          work_id: r.work_id,
          work: r.work_title,
          field: r.field_key,
          // Raw, as-reported label/value/unit preserved alongside the field ref.
          quantity: r.quantity,
          value: r.value_num ?? r.value_text,
          unit: r.unit,
          conditions: r.conditions,
          fold: r.fold,
          kind: r.fact_kind,
          status: r.status
        }))
      },
      null,
      2
    )
  }

  // default: json — full project snapshot from DB
  return JSON.stringify(
    {
      project,
      works: works.map((pw) => ({
        work: pw.work,
        relevance: pw.relevance,
        expansion_priority: pw.expansion_priority,
        inclusion_status: pw.inclusion_status
      })),
      dossier: getDossier(db, projectId),
      extraction: getExtractionRows(db, projectId)
    },
    null,
    2
  )
}
