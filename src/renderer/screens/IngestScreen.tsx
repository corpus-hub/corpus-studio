import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  StaleWorkDTO,
  JobDTO,
  StageDefDTO,
  FacetsDTO,
  SearchFilters,
  SearchResultDTO,
  SavedSearchDTO,
  SemanticCoverageDTO,
  SemanticHitDTO,
  SemanticSearchResultDTO,
  WebSearchResultDTO,
  WebSearchFilters,
  WebSearchSort,
  SearchSort
} from '@shared/contract'
import { decadeLabel, OCR_LOW_CONFIDENCE } from '@shared/contract'
import { PAPER_SEARCH_OFF_SENTENCE } from '@shared/contract/plugins'
import { listSearchSources, searchSourceName } from '@shared/searchSources'
import { fmtSimilarity, similarityBand, textSourceMeta } from '../lib/format'
import { workTypeLabel } from '../lib/workType'
import { useAsync } from '../lib/useAsync'
import { DataView, EmptyState } from '../components/States'
import { MultiSelect, Select } from '../components/ui'
import { isOutstandingFailure } from '../lib/jobs'
import {
  STAGE_LABEL,
  STAGE_MEANING,
  STAGE_FAILURE_MEANING,
  isTerminalStage,
  legacyLabel,
  rollupState,
  stageCells,
  stageProgress,
  UNMAPPED_MEANING,
  type StageCell,
  type StageState
} from '../lib/stageState'
import { phaseCells, PHASE_MEANING, type PhaseCell } from '../lib/stagePhases'
import { useJobsChanged } from '../lib/useJobsChanged'
import { PdfThumb } from '../components/PdfThumb'
import { PdfDropZone } from '../components/PdfDropZone'
import { StageIcon } from '../components/StageIcon'
import { ZoteroOfflineModal } from '../components/ZoteroOfflineModal'
import { formatDuration, formatRelative, parseStamp } from '../lib/time'
import { useVisibleInterval, useVisibleNow, useVisibleWindowListener } from '../lib/visibility'
import { useDevView } from '../lib/prefs'
import { RichText, plainText } from '../components/RichText'

/**
 * A paper whose stored results were produced from inputs that have since
 * changed, and the human-readable names of the work that has to be redone.
 * Main resolves stage ids into labels, so nothing here decodes them.
 */

// ------------------------------------------------------------------ source tabs
// The segment switches the whole screen body between mutually exclusive jobs.
// Two of them are ingest sources (each maps to an ingest `kind` understood by
// window.api.ingest):
//  - "Search existing papers": query the corpus already in the project. Shows
//    the facet panel + results INSTEAD of the import input and the queue.
//  - "Search for new papers": ask the academic indexes for papers this corpus
//    does not have, either by query or by a pasted identifier. PRESENT ONLY
//    WHEN SOMETHING CAN ANSWER — see below.
//  - "Import from file": a local PDF or a folder of PDFs, addressed by ABSOLUTE
//    PATH (that is what the ingest IPC takes; see the note on the drop zone
//    below).
//  - "Queue": what happened to the papers already added.
type Kind = 'doi' | 'pmid' | 'arxiv' | 'title' | 'url' | 'pdf' | 'folder'

const LIBRARY_KEY = 'library'
/**
 * The queue is its own destination, NOT an ingest source: the other tabs answer
 * "where does a paper come from", this one answers "what happened to the ones I
 * already added". It is separated in the switch for that reason.
 */
const QUEUE_KEY = 'queue'
/**
 * Asking the outside world for papers, which REQUIRES A PLUGIN.
 *
 * Searching the indexes happens inside the user's own browser, through a plugin
 * — publishers and several indexes refuse a server outright. So this tab is not
 * part of the app: it appears because something installed can answer, and goes
 * when that is switched off or removed.
 *
 * The tab is ABSENT rather than disabled, because absence is what is true. A
 * greyed tab on every fresh install would be a permanent chip announcing the
 * ordinary state of a feature the user has not asked for (hard rule 0.6); the
 * screen's empty state is where the offer belongs, and it says what to do.
 */
const WEB_KEY = 'web'

type SourceTab = {
  key: string
  label: string
  kind?: Kind
  placeholder?: string
}

/** The tabs that are always here. The web tab is spliced in when it can work. */
const SOURCE_TABS: SourceTab[] = [
  { key: LIBRARY_KEY, label: 'Search existing papers' },
  {
    key: 'file',
    label: 'Import from file',
    kind: 'pdf',
    placeholder: '/abs/path/to/file.pdf  or  /abs/path/to/folder'
  },
  { key: QUEUE_KEY, label: 'Queue' }
]

const WEB_TAB: SourceTab = {
  key: WEB_KEY,
  label: 'Search for new papers',
  kind: 'doi',
  placeholder: '10.1021/acscatal…  ·  PMID  ·  arXiv  ·  title  ·  publisher URL'
}

/**
 * Asking by query, or by a pasted identifier: two ways to name a paper the
 * corpus does not have, inside the one tab that goes when the plugin does.
 */
type SubTab = 'query' | 'identifier'
const SUB_TABS: { key: SubTab; label: string }[] = [
  { key: 'query', label: 'By query' },
  { key: 'identifier', label: 'By identifier' }
]

/**
 * The tabs to show, given whether anything can search the outside world.
 *
 * Second, right after the corpus search, because that is the order of the
 * question a reader is asking: what do I already have, then what else is there.
 */
function sourceTabs(canSearchWeb: boolean): SourceTab[] {
  if (!canSearchWeb) return SOURCE_TABS
  return [SOURCE_TABS[0], WEB_TAB, ...SOURCE_TABS.slice(1)]
}

/**
 * Author credit for a result row.
 *
 * Truncated with "et al.", because a full list is not what the row is for: one
 * seeded paper has 20 authors and rendered three lines of names, which pushed
 * every other row off the screen and buried the title it belonged to.
 */
function authorLine(authors: string[]): string {
  if (authors.length <= 3) return authors.join(', ')
  return `${authors.slice(0, 3).join(', ')} +${authors.length - 3} more`
}

const CORPUS_SORTS: readonly { value: SearchSort; label: string; tip: string }[] = [
  {
    value: 'relevance',
    label: 'relevance',
    tip: "This project's stored relevance ranking — how closely each paper bears on the project's question."
  },
  { value: 'year', label: 'newest first', tip: 'Most recently published first. Undated papers sort last.' },
  {
    value: 'citations',
    label: 'most cited',
    tip: 'How many papers IN THIS CORPUS cite it — not the world-wide figure.'
  },
  { value: 'title', label: 'title A–Z', tip: 'Alphabetical by title.' }
]

/**
 * Papers fetched per round trip to the indexes.
 *
 * The indexes hold far more than anyone reads, so this is a reading budget, not
 * a capacity limit: enough that a good hit is likely on the first screen,
 * bounded so one search does not hammer four public APIs for results nobody
 * scrolls to.
 *
 * DISTINCT from `PAGE_SIZE` below, which is what the reader is shown. One fetch
 * therefore fills several pages, and turning to page 2 or 3 costs no round trip
 * at all — the indexes are only asked again when the reader walks off the end of
 * what is already in hand.
 */
const FETCH_SIZE = 120

/**
 * Papers per PAGE of the web-search results the reader is turning through.
 *
 * `FETCH_SIZE` is a WHOLE MULTIPLE of this, and that is not tidiness: 100
 * fetched at 30 a page is three pages and ten papers stranded in a fourth that
 * cannot be filled without another round trip. The reader then sees "1 2 3"
 * however far they walk, because every step forward both adds a page and leaves
 * a new remainder. Four exact pages per fetch means the numbers grow by four
 * each time, visibly.
 */
const PAGE_SIZE = 30

/**
 * Page numbers offered BEYOND what has been fetched, while the indexes still
 * have more to give.
 *
 * The reader must be able to SEE that there are more pages, not infer it. An
 * ellipsis says "more exist" and gives them nothing to press; these are real
 * numbers, and pressing one fetches what it needs and goes there — the same
 * contract as `goToPage` has always had for a page in hand.
 *
 * Two, not twenty: the app genuinely does not know how many pages the indexes
 * hold, so a long run of speculative numbers would be the "1 2 3" lie again with
 * bigger digits. Two is enough to show the row is open-ended, and the row grows
 * as they walk.
 */
const PAGES_AHEAD = 2

/**
 * Placeholder rows shown while a web search runs.
 *
 * Shaped like the real results — title, authors, meta line, two lines of
 * abstract, and the Import button's footprint — so the list does not lurch when
 * they are replaced. A spinner would say only "wait"; this says what is coming
 * and how much of it, and reserves the space so nothing shifts on arrival.
 *
 * The staggered `--i` makes the shimmer sweep down the list rather than pulsing
 * as one block, which reads as progress instead of a stuck screen.
 */
function WebSearchSkeleton({ rows = 6 }: { rows?: number }): JSX.Element {
  return (
    <div className="ing-web-skel" data-testid="websearch-loading" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div className="ing-web-skel-row" key={i} style={{ '--i': i } as React.CSSProperties}>
          <div className="ing-web-skel-main">
            {/* Varying widths: uniform bars read as a table, not as papers. */}
            <div className="sk ing-web-skel-title" style={{ width: `${86 - (i % 3) * 13}%` }} />
            <div className="sk ing-web-skel-authors" style={{ width: `${44 - (i % 2) * 9}%` }} />
            <div className="sk ing-web-skel-meta" />
            <div className="sk ing-web-skel-abs" />
            <div className="sk ing-web-skel-abs" style={{ width: '62%' }} />
          </div>
          <div className="sk ing-web-skel-btn" />
        </div>
      ))}
    </div>
  )
}

/**
 * Which upstreams a search is waiting on, and for how long.
 *
 * These searches take seconds — four public indexes, sequentially rate-limited —
 * which is long enough that silence reads as a hang. Naming the sources also
 * explains WHY it is slow, so the wait is legible rather than suspicious.
 */
function SearchProgress(): JSX.Element {
  const [elapsed, setElapsed] = useState(0)
  // The START is a ref, not state, so it survives the timer stopping and
  // restarting: the elapsed time is measured from when the search began, not
  // from when the user last looked at it.
  const startedRef = useRef(Date.now())
  // 10 Hz, and gated on visibility. A search left running in a background tab
  // would otherwise re-render this subtree ten times a second for as long as it
  // took, to update a number nobody can see.
  useVisibleInterval(() => {
    setElapsed(Math.round((Date.now() - startedRef.current) / 100) / 10)
  }, 100)
  return (
    <div className="ing-web-progress" data-testid="websearch-progress" role="status">
      <span className="ing-web-progress-bar" aria-hidden="true" />
      <span className="ing-web-progress-text">
        {/* NAMES NO INDEX. Which indexes are queried is the search plugin's
            decision, so a list promised here before any result arrives is the
            app describing behaviour it does not control. The results say which
            indexes actually answered. */}
        Searching the academic indexes…
        {/* Only after the point where a wait starts to feel broken — showing
            "0.1s" immediately would draw attention to speed we do not control. */}
        {elapsed >= 1.5 && <span className="ing-web-progress-time mono"> {elapsed.toFixed(1)}s</span>}
      </span>
    </div>
  )
}

/**
 * Stable empty list for "no results yet".
 *
 * A fresh `[]` on every render is a NEW reference, which would re-run the
 * memoized merge each time and defeat it.
 */
const EMPTY_RESULTS: WebSearchResultDTO[] = []

/**
 * Document kinds that are the ORDINARY answer, and so are shown as nothing at all.
 *
 * Almost every hit from a literature index is a journal article. Rendering that on every
 * row would spend the meta line's width to tell the reader what they already assumed, and
 * it would drag the rows that say "preprint" or "review" down with it — a qualifier only
 * carries force while it is rare (HARD RULE 0.6).
 *
 * The vocabulary is the INDEXES' own, lowercased and hyphenated on arrival, not ours: the
 * point of this set is to name what is unremarkable, not to classify science.
 */
const ORDINARY_TYPES = new Set(['journal-article', 'article', 'article-journal', 'research-article'])

/**
 * The type to display for a result, or null to say nothing.
 *
 * Null in, null out — an index that stated no type gets silence, exactly like a plain
 * article, because we will not guess one from a title or a venue.
 */
function noteworthyType(type: string | null): string | null {
  if (type === null) return null
  const t = type.trim().toLowerCase()
  if (t.length === 0 || ORDINARY_TYPES.has(t)) return null
  return t.replace(/-/g, ' ')
}

const WEB_SORTS: readonly { value: WebSearchSort; label: string; tip: string }[] = [
  {
    value: 'relevance',
    label: 'relevance',
    tip: 'How well the paper matches your words. Title matches count for more than abstract matches.'
  },
  { value: 'year', label: 'newest first', tip: 'Most recently published first.' },
  {
    value: 'year-asc',
    label: 'oldest first',
    tip: 'Earliest published first — the foundational work in a field rather than the latest.'
  },
  {
    value: 'citations',
    label: 'most cited',
    tip: 'Most-cited first. Older papers have had longer to accrue citations.'
  }
]

// A path ending in .pdf is a single document; anything else is treated as a
// folder of PDFs. Keeps ONE input for the merged "Import from file" tab.
const kindForPath = (p: string): Kind => (/\.pdf$/i.test(p.trim()) ? 'pdf' : 'folder')

// ---------------------------------------------------------------- queue filters
type FilterKey = 'all' | 'active' | 'review' | 'failed' | 'done'
const FILTERS: { key: FilterKey; label: string; tone?: 'danger' }[] = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'review', label: 'Review' },
  { key: 'failed', label: 'Failed', tone: 'danger' },
  { key: 'done', label: 'Done' }
]

/**
 * Whether ONE job belongs under a status tab.
 *
 * Takes the job, not just its status string, because "failed" is not a property
 * of the status alone: a failure whose run was later superseded is history, and
 * the Failed tab must agree with the badge that counts it. They were two
 * definitions and they disagreed — the tab listed rows the badge had counted
 * while every one of those papers had since succeeded.
 */
function matchesFilter(job: JobDTO, f: FilterKey): boolean {
  const status = job.status
  switch (f) {
    case 'all':
      return true
    case 'active':
      // `blocked` is active work: the paper is in the pipeline and will move on
      // its own once its upstream finishes. Excluding it would make a paper
      // vanish from Active for exactly as long as it is waiting, which is the
      // period a user is most likely to go looking for it.
      return status === 'queued' || status === 'running' || status === 'blocked'
    case 'review':
      return status === 'review'
    case 'failed':
      // Same rule as `isOutstandingFailure`, so the tab and the badge cannot
      // report different corpora.
      return isOutstandingFailure(job)
    case 'done':
      // `cancelled` belongs here rather than nowhere: it is terminal and it is
      // not a failure, and the tabs must PARTITION the queue — every status the
      // schema permits lands in exactly one tab besides All, so no paper is
      // reachable only by scrolling the full list.
      return status === 'done' || status === 'cancelled'
  }
}

/**
 * Fold a string to the form the queue's text search compares on.
 *
 * NFD + stripping combining marks so "Muller" finds "Müller": the user types
 * what is on their keyboard, and a corpus of European author names is full of
 * diacritics they cannot easily reproduce. `toLowerCase` after the fold, since
 * decomposition can expose uppercase base letters.
 */
function foldText(s: string): string {
  return (
    s
      .normalize('NFD')
      .replace(/\p{M}+/gu, '')
      // Runs of whitespace collapse to one, because a title pasted out of a PDF
      // text layer routinely carries doubled spaces and line breaks the user
      // cannot see — matching on the literal run would silently find nothing.
      .replace(/\s+/g, ' ')
      .toLowerCase()
  )
}

/**
 * Canonical DOI form for substring comparison, mirroring main's `normalizeDoi`.
 *
 * Applied to BOTH sides so the same paper is found whether the user pastes
 * `https://doi.org/10.1038/Nature06879`, `doi:10.1038/nature06879` or the bare
 * `10.1038/nature06879` — those are three spellings of one identifier, and a
 * user who copied a link from a browser must not get an empty result.
 *
 * It is NOT duplicated logic that could drift silently: the renderer cannot
 * import from `src/main`, and this compares for DISPLAY filtering only — the
 * authoritative dedup comparison stays in main.
 */
function foldDoi(s: string): string {
  return s
    .trim()
    .replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .replace(/[.,;)\]]+$/, '')
    .toLowerCase()
}

/**
 * Does this pipeline match the queue's text filter?
 *
 * Title and DOI are tried INDEPENDENTLY rather than against one concatenated
 * haystack: a query is either a fragment of a name or a fragment of an
 * identifier, and joining them would let a match straddle the boundary and
 * report a paper that contains the query in neither field.
 *
 * A row with no DOI, or with a placeholder title, still matches on whatever it
 * does have — absence of a DOI is normal here, not a reason to hide the row
 * from every search.
 */
function matchesQuery(p: Pipeline, foldedQuery: string, doiQuery: string): boolean {
  if (foldedQuery === '') return true
  if (foldText(p.title).includes(foldedQuery)) return true
  // A query that folds away to nothing on the DOI side — pure punctuation like
  // "." — must NOT fall through to an empty needle, which `includes` answers
  // true for and would show every paper that happens to have a DOI.
  if (doiQuery !== '' && p.doi !== null && foldDoi(p.doi).includes(doiQuery)) return true
  return false
}

// `failed` is the only failure status the schema's CHECK permits. Matching
// extra spellings would be dead code that quietly implies the DB might produce
// them.
const isFailed = (s: string): boolean => s === 'failed'

/**
 * Where a stage sits in the pipeline, for ordering jobs by the sequence they
 * RUN in rather than by the order their rows were written.
 *
 * A job id says when the row was created, which matches the pipeline only while
 * every stage has existed since the corpus was imported. Add a stage later and
 * its jobs carry the highest ids in the table, so id order runs the new step
 * after the steps that come after it.
 *
 * An unknown stage sorts LAST rather than first: a job the registry does not
 * name is one this build cannot place, and guessing it belongs at the front
 * would have it revive steps it knows nothing about.
 */
function stageRank(stage: string | null, defs: readonly StageDefDTO[]): number {
  if (stage === null) return defs.length
  const at = defs.find((d) => d.id === stage)
  return at ? at.index : defs.length
}

// ------------------------------------------------------------- pipeline rows
/**
 * One paper's jobs, drawn as one row — or one CORPUS-SCOPED stage's runs.
 *
 * `key` is the work when there is one, the corpus stage when the job is a sweep,
 * and the job itself otherwise: a job that never resolved to a paper (a
 * retrieval that failed before it found anything) has nothing to group WITH, so
 * it stands alone rather than being lumped into a meaningless "no paper" row.
 */
interface Pipeline {
  /**
   * What this row IS about.
   *
   * `corpus` rows are not papers and must not be counted, filtered or drawn as
   * if they were. A corpus-scoped stage sweeps the whole corpus rather than one
   * document — it has no `work_id` BY DESIGN — and it is a repeating singleton,
   * so its runs accumulate without bound. Every run is grouped into ONE row.
   *
   * Grouped, not hidden: this is real work with a real result, and the row
   * states how many runs it stands for.
   */
  kind: 'paper' | 'corpus'
  /**
   * How many runs this row stands for, and how many of them failed. Only a
   * corpus row has more than one; a paper's row is a single pipeline.
   *
   * Carried rather than derived from `jobs`, because `jobs` is narrowed to the
   * latest run so that the state, tab and duration all describe one execution
   * — and dropping the count with it would silently shrink 111 real runs to
   * "1", which is the kind of quiet arithmetic this screen must not do.
   */
  runCount: number
  failedRuns: number
  key: string
  /**
   * The row's STABLE identity: the lowest job id in the pipeline.
   *
   * Every other candidate moves. `work_id` is null until an ingest resolves,
   * and the "lead" job — the one the action buttons address — advances from
   * stage to stage as the pipeline runs. Keying off either made React unmount
   * and remount the row mid-flight (killing its entry animation and any hover
   * or focus on it) and silently disarmed a Delete the user had just armed,
   * because the id the arm was recorded under no longer existed.
   *
   * The lowest job id is fixed from the moment the paper enters the queue and
   * survives the work resolving, so it is what the row is keyed, tested and
   * scrolled by.
   */
  anchorId: number
  workId: number | null
  title: string
  /** The paper's DOI, for searching by identifier. Null when it has none. */
  doi: string | null
  documentId: number | null
  /**
   * How the row's document obtained its text, and how well.
   *
   * On the pipeline rather than left to the Paper screen because the Queue is
   * where a user watches a paper being read: "that one came in as a scan" is a
   * fact about the result arriving in front of them, and it changes how much of
   * the downstream extraction they should take on faith.
   */
  textSource: JobDTO['text_source']
  textConfidence: number | null
  jobs: JobDTO[]
}

/**
 * Group jobs into rows.
 *
 * `stages` is the registry, and it decides which jobs are corpus-scoped — read
 * from the same source the stage dots are laid out against, never by naming
 * `resolve-references` here. A hardcoded stage id would mean the SEVENTH stage
 * is harder to add than the sixth, which is the property the pipeline is built
 * to keep, and it is why the main-process planner generalises over
 * `scope === 'corpus'` too.
 */
function buildPipelines(list: JobDTO[], stages: readonly StageDefDTO[]): Pipeline[] {
  const corpusStages = new Set(stages.filter((s) => s.scope === 'corpus').map((s) => s.id))
  const byKey = new Map<string, Pipeline>()
  for (const j of list) {
    const isCorpus = j.stage !== null && corpusStages.has(j.stage)
    const key = isCorpus
      ? `corpus:${j.stage}`
      : j.work_id === null
        ? `job:${j.id}`
        : `work:${j.work_id}`
    const existing = byKey.get(key)
    if (existing) {
      existing.jobs.push(j)
      existing.anchorId = Math.min(existing.anchorId, j.id)
      if (existing.documentId === null) existing.documentId = j.document_id
      if (existing.doi === null) existing.doi = j.work_doi
      // A row's jobs all resolve to the same document, but a job that resolved
      // to none carries a null claim. Taking the first NON-null keeps the badge
      // from disappearing depending on which job happened to be first.
      if (existing.textSource === null) {
        existing.textSource = j.text_source
        existing.textConfidence = j.text_confidence
      }
    } else {
      byKey.set(key, {
        key,
        kind: isCorpus ? 'corpus' : 'paper',
        runCount: 1,
        failedRuns: 0,
        anchorId: j.id,
        workId: j.work_id,
        title: isCorpus
          ? (stages.find((s) => s.id === j.stage)?.label ?? j.stage ?? 'Corpus sweep')
          : (j.work_title ?? `Job #${j.id} · no paper yet`),
        doi: j.work_doi,
        documentId: j.document_id,
        textSource: j.text_source,
        textConfidence: j.text_confidence,
        jobs: [j]
      })
    }
  }
  // Jobs are ordered by id only. The PIPELINE's order comes from the registry
  // (`stageCells`), so this ordering decides nothing the user sees about
  // sequence — it only keeps a fan-out's jobs stable within one stage.
  for (const p of byKey.values()) p.jobs.sort((a, b) => a.id - b.id)

  // A corpus row reports ITS LATEST RUN, and says separately how many runs it
  // stands for and how many of them failed.
  //
  // A paper's jobs are one pipeline, so every job of the row belongs to the
  // state the row shows. A sweep's are not: they are N independent executions
  // of the same singleton over time. Handing all N to `stageCells` collapses
  // them into one cell whose state is the WORST of them, so a single failure
  // from days ago would pin the row to "Failed" through fifty later successes,
  // offer Retry on that long-dead job, and make the status tabs disagree with
  // the pill (shown under Done because a run succeeded, reading Failed because
  // an older one did not). It would also let `pipelineDuration` span from the
  // first run's start to the last one's finish and call the result a duration.
  //
  // Narrowing to the latest run makes the state, the tab, the timestamp, the
  // duration and the Retry target all describe the SAME execution. The earlier
  // runs are not hidden — `runCount` and `failedRuns` are rendered — but they
  // are reported as history rather than impersonating the current result.
  for (const p of byKey.values()) {
    if (p.kind !== 'corpus') continue
    p.runCount = p.jobs.length
    p.failedRuns = p.jobs.filter((j) => isFailed(j.status)).length
    const latest = p.jobs[p.jobs.length - 1]
    p.jobs = [latest]
    p.anchorId = latest.id
  }
  // ORDER: newest paper first, by the number the row shows as `#20`.
  //
  // That number is the paper's id, so counting down is counting backwards
  // through the order they were added — the paper someone just imported is at
  // the top, where they are looking for it. The previous order was arrival
  // order within a bucket, which put the newest arrival at the BOTTOM of a
  // twenty-row list.
  //
  // Sorting on a STABLE key rather than on status also means a row does not
  // jump while being watched: a paper that finishes mid-glance keeps its place
  // instead of leaping to a different part of the list.
  //
  // Corpus rows still sort after every paper. They are standing maintenance
  // rather than something the user just asked for, so they belong at the foot
  // of the list — and `workId` is null on them, so they have no number to sort
  // by in the first place.
  return [...byKey.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'corpus' ? 1 : -1
    if (a.kind === 'corpus') return b.anchorId - a.anchorId
    // A row that never resolved to a paper has no number; it sorts to the top,
    // where an unresolved import is the thing most likely to need attention.
    return (b.workId ?? Number.MAX_SAFE_INTEGER) - (a.workId ?? Number.MAX_SAFE_INTEGER)
  })
}

/**
 * How long the pipeline actually WORKED on this paper: the wall-clock time
 * during which at least one of its jobs was running.
 *
 * Each job contributes the interval [started_at, finished_at]; the intervals
 * are then MERGED, so time is counted once however many jobs occupied it.
 *
 * Two wrong answers this sits between, both of which were live at some point:
 *
 *   First-claim to last-finish produced "26:21:46" for papers the pipeline had
 *   spent nine minutes on. A row's jobs are not one continuous effort — a paper
 *   analysed today and re-analysed tomorrow is two bursts with a night between
 *   — and that measure billed the night. Measured on this corpus: 5009 hours of
 *   span against 9 minutes of work, because re-runs attach to jobs first queued
 *   long before.
 *
 *   Summing each job's span independently fixes the idle time but counts
 *   concurrency twice: the queue runs several stages at once, so a paper that
 *   took a minute of wall time could report three.
 *
 * Merging gives the figure a meaning that survives both: how long this paper
 * was being worked on. Overlaps collapse, gaps are excluded.
 *
 * A live row extends its running jobs to `nowMs`, so the figure ticks while
 * work is happening rather than jumping when it stops.
 */
function pipelineDuration(
  jobs: JobDTO[],
  nowMs: number
): { ms: number; live: boolean } | null {
  const spans: Array<[number, number]> = []
  let live = false

  for (const j of jobs) {
    const started = parseStamp(j.started_at)
    if (started === null) continue
    if (j.status === 'running') {
      live = true
      spans.push([started, Math.max(started, nowMs)])
      continue
    }
    const finished = parseStamp(j.finished_at)
    if (finished === null) continue
    // Clamped: a clock adjustment between the two stamps must not produce a
    // negative interval, which would eat into a neighbour once merged.
    spans.push([started, Math.max(started, finished)])
  }

  // Nothing in the row was ever claimed — rows written before the stamps
  // existed. The row says so rather than inventing a duration.
  if (spans.length === 0) return null

  spans.sort((a, b) => a[0] - b[0])
  let ms = 0
  let [openStart, openEnd] = spans[0]
  for (let i = 1; i < spans.length; i++) {
    const [s, e] = spans[i]
    if (s <= openEnd) {
      // Overlapping or touching: extend the open interval rather than closing
      // it, so the shared time is counted once.
      openEnd = Math.max(openEnd, e)
    } else {
      ms += openEnd - openStart
      openStart = s
      openEnd = e
    }
  }
  ms += openEnd - openStart

  return { ms, live }
}

/**
 * States that owe the user an explanation which is NOT a failure.
 *
 * `skipped` is NOT among them. A precondition being absent is the pipeline
 * working exactly as designed — "the PDF already has a text layer, so OCR would
 * be worse" is a decision the user would have wanted made, and telling them
 * about it puts a notice strip under a paper where nothing went wrong and
 * nothing is theirs to do. Multiplied across a corpus it is a wall of paragraphs
 * announcing non-events, which teaches people to stop reading the strip — and
 * then the states that DO need them (nothing found, refused, waiting on a dead
 * upstream) are lost in it. The state itself is not hidden: the stage dot still
 * shows it and its tooltip still explains it, for the reader who wants to know
 * why a step did not run.
 */
const NOTICE_STATES = ['empty', 'refused', 'blocked', 'superseded'] as const

/**
 * The one non-failure state a row should explain in full, and the stage it
 * belongs to — or null when the row has nothing to explain.
 *
 * Keyed off the ROLLUP so the strip agrees with the headline pill: showing a
 * "nothing found" note under a row whose verdict says "Failed" would be two
 * answers to one question. Failure has its own panel with its own remedies, so
 * a failed row returns null here rather than getting both.
 */
function rowNotice(
  cells: readonly StageCell[],
  roll: StageState
): { state: (typeof NOTICE_STATES)[number]; cell: StageCell } | null {
  const match = NOTICE_STATES.find((s) => s === roll)
  if (match === undefined) return null
  const cell = cells.find((c) => c.state === match)
  return cell === undefined ? null : { state: match, cell }
}

/**
 * The name of the stage an action will act on. Resolved through the registry so
 * the button says what the pipeline calls that step, falling back to the job's
 * own `job_type` only for a row that predates the registry.
 */
function leadLabel(job: JobDTO, stages: readonly StageDefDTO[]): string {
  const def = job.stage === null ? undefined : stages.find((s) => s.id === job.stage)
  return def?.label ?? legacyLabel(job)
}

/**
 * What one stage dot says when you hover it.
 *
 * THE RULE THAT SHAPES THIS: say the specific thing, or say nothing.
 *
 * It used to concatenate everything it knew, which read as:
 *
 *   "Locate PDF · Completed. Either it produced a result, or there was
 *    correctly nothing to do — reading a PDF that already has text, say.
 *    07_Otten2020_Science_energy_landscape.pdf Took 00:03."
 *
 * Three separate faults. The generic sentence is a hedge covering every stage
 * at once, so it tells you nothing about THIS one — and it is the same words on
 * every green dot in the row, which is how a tooltip trains people not to read
 * tooltips. The note is dumped in raw, so a filename lands mid-paragraph as
 * though it were prose. And "Took 00:03." tacked on the end turns the whole
 * thing into a list wearing the punctuation of a sentence.
 *
 * So: a SUCCESSFUL stage says what it did — the note, which is the only part
 * specific to this paper ("22 pages, 81,280 characters") — and nothing else.
 * The generic explanation appears only for the states where the reader
 * genuinely might not know what they are looking at: nothing found, declined,
 * waiting, out of date, failed. Those are the ones that provoke the question.
 */
function stageTip(c: StageCell, stages: readonly StageDefDTO[]): string {
  // `blockedBy` and `deadBlockers` carry stage IDS — `extract-text`,
  // `citation-contexts` — which were printed verbatim. Those are names for the
  // code; resolved to the label the dot itself shows so the sentence names
  // something visible on screen.
  const named = (ids: readonly string[]): string =>
    ids.map((id) => stages.find((s) => s.id === id)?.label ?? id).join(', ')

  const lines: string[] = [`${c.stage.label} · ${STAGE_LABEL[c.state]}`]

  // The state's own explanation, ONLY where it adds something. On a plain
  // success it is a hedge repeated across every dot in the row; on the states
  // below it is the answer to "why is this one not green?".
  if (c.state !== 'succeeded' && c.state !== 'running') {
    lines.push(STAGE_MEANING[c.state])
  }
  if (c.unmapped) lines.push(UNMAPPED_MEANING)
  if (c.blockedBy.length > 0) lines.push(`Waiting for ${named(c.blockedBy)}.`)
  if (c.deadBlockers.length > 0) {
    lines.push(`${named(c.deadBlockers)} did not finish, so this will not start on its own.`)
  }
  // The stage's own account of what it did with THIS paper — "22 page(s),
  // 81280 characters", "already optimal (1763695 bytes)". The most useful line
  // in the tooltip and the only one that differs between dots.
  if (c.note !== null && c.note !== '') lines.push(capitalise(c.note))
  if (c.stage.uses_llm && (c.state === 'queued' || c.state === 'blocked')) {
    lines.push('Steps that use AI run one at a time, so a wait here is normal.')
  }
  const err = c.lead?.error
  if (err) lines.push(err)

  // Timing LAST and only when it is worth knowing. Sub-second is noise on a
  // step nobody waited for, and `attempts` matters only when there was more
  // than one. Joined onto one closing line so the tooltip ends with a fact
  // rather than two stray fragments.
  const tail: string[] = []
  if (c.durationMs !== null && c.durationMs >= 1000) tail.push(formatDuration(c.durationMs))
  if (c.attempts > 1) tail.push(`${c.attempts} attempts`)
  if (tail.length > 0) lines.push(tail.join(' · '))

  return lines.join('\n')
}

/** What a phase chip says on hover: what it is for, then how far its stages got. */
function phaseTip(p: PhaseCell, stages: readonly StageDefDTO[]): string {
  const lines: string[] = [`${p.label} · ${STAGE_LABEL[p.state]}`]
  const meaning = PHASE_MEANING[p.id]
  if (meaning !== undefined) lines.push(meaning)
  if (p.ungrouped) {
    // A stage no phase claims. Saying so is the difference between "a step you
    // have not seen before" and "the app is drawing something odd".
    lines.push('This step is not part of a named phase, so it is shown on its own.')
    if (p.cells[0].note !== null && p.cells[0].note !== '') {
      lines.push(capitalise(p.cells[0].note))
    }
  }
  // The chip carries no label of its own, so the tooltip is where the phase's
  // steps are named — each with its own state, in the order they run.
  if (!p.ungrouped) {
    for (const c of p.cells) {
      lines.push(`· ${c.stage.label}: ${STAGE_LABEL[c.state]}`)
    }
  }
  // The failing step is named again at the PHASE level, because "Read the text
  // failed" without saying which of its three steps broke is a phase that has
  // hidden the very thing grouping must not hide.
  const bad = p.cells.filter((c) => c.state === 'failed')
  if (bad.length > 0) {
    lines.push(`Failed: ${bad.map((c) => c.stage.label).join(', ')}.`)
  }
  lines.push('Click to see each step, and what it did with this paper.')
  void stages
  return lines.join('\n')
}

/**
 * One paper's pipeline, grouped into phases.
 *
 * SEVEN dots instead of fourteen, drawn in the same mini-graph the row has
 * always used: round chips joined by a connector that fills in behind the
 * pipeline as it advances. The fourteen stages exist for caching and scope
 * reasons the reader has no use for, so what a dot stands for is now something
 * a scientist already has a word for — "Get the PDF" rather than the
 * difference between `retrieve` and `download`.
 *
 * The phase's name is in its tooltip and its `aria-label`, not on the chip:
 * seven labels written into the row would take the width the paper's title
 * needs, and the row is read at a glance for how far a paper has got.
 *
 * Clicking restores every stage EXACTLY as it was drawn before — its own dot,
 * its own state, its own `outcome_note`. That detail is how every pipeline bug
 * this week was diagnosed and it is not allowed to be lost to the grouping; it
 * is one click away rather than always on screen.
 */
function StagePhases({
  phases,
  stages,
  anchorId,
  open,
  onToggle
}: {
  phases: readonly PhaseCell[]
  stages: readonly StageDefDTO[]
  /**
   * The ROW's identity — `QueuePaper.anchorId`, the lowest job id of the group.
   *
   * A number, which is what every caller passes. Declared `string` it typed the
   * one value that identifies the row as something it is not: harmless inside a
   * template literal, and a lie any later comparison would have inherited.
   */
  anchorId: number
  open: string | null
  onToggle: (id: string) => void
}): JSX.Element {
  return (
    <div
      className="ing-stages"
      data-testid={`job-stages-${anchorId}`}
      role="list"
      aria-label="Pipeline stages"
    >
      {phases.map((p, i) => {
        const isOpen = open === p.id
        return (
          <Fragment key={p.id}>
            {i > 0 && (
              <span
                className={`ing-stage-link ${
                  phases[i - 1].cells.every((c) => isTerminalStage(c.state)) ? 'is-passed' : ''
                }`}
                aria-hidden="true"
              />
            )}
            <button
              type="button"
              role="listitem"
              className={`ing-stage is-${p.state} ${isOpen ? 'is-open' : ''}`}
              data-testid={`job-phase-${p.id}-${anchorId}`}
              data-phase={p.id}
              data-state={p.state}
              aria-expanded={isOpen}
              aria-label={`${p.label}: ${STAGE_LABEL[p.state]}`}
              data-tip={phaseTip(p, stages)}
              onClick={() => onToggle(p.id)}
            >
              <span className="ing-stage-glyph" aria-hidden="true">
                {/* Sized to the dot. The default 11px was drawn for a 22px chip
                    and left the state unreadable at a glance, which is the one
                    thing this row exists to convey. */}
                <StageIcon state={p.state} size={15} />
              </span>
            </button>
          </Fragment>
        )
      })}
    </div>
  )
}

/**
 * The open phase's stages, drawn FULL WIDTH beneath the row rather than inside
 * the chip column. Nested in the grid the panel forced its column wide enough
 * for the longest outcome note and the paper's title lost half its width, so
 * opening a phase silently truncated the one thing identifying the row.
 */
function PhaseSteps({
  phase,
  stages,
  anchorId
}: {
  phase: PhaseCell
  stages: readonly StageDefDTO[]
  /** The row's identity. A number, as `StagePhases` documents. */
  anchorId: number
}): JSX.Element {
  return (
    <div
      className="ing-phase-steps"
      data-testid={`job-phase-steps-${phase.id}-${anchorId}`}
    >
      {phase.cells.map((c) => (
        <span
          key={c.stage.id}
          className={`ing-step is-${c.state}`}
          data-testid={`job-stage-${c.stage.id}`}
          data-stage={c.stage.id}
          data-state={c.state}
          tabIndex={0}
          aria-label={`${c.stage.label}: ${STAGE_LABEL[c.state]}`}
          data-tip={stageTip(c, stages)}
        >
          <span className="ing-stage-glyph" aria-hidden="true">
            <StageIcon state={c.state} />
          </span>
          <span className="ing-step-label">{c.stage.label}</span>
          <span className="ing-step-state">{STAGE_LABEL[c.state]}</span>
          {/* The stage's OWN account of what it did with this paper. It is the
              line that diagnoses things, so it is on screen when the phase is
              open, not only in a tooltip. */}
          {c.note !== null && c.note !== '' && (
            <span className="ing-step-note">{capitalise(c.note)}</span>
          )}
        </span>
      ))}
    </div>
  )
}

/** Notes are written lower-case by the stages; a tooltip line is a sentence. */
function capitalise(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1)
}

/**
 * Where to look by hand when automatic retrieval could not get the PDF.
 *
 * THESE ARE THE SOURCES THE EXTENSION ITSELF TRIED, so the list is the same one
 * that just failed rather than a separate set of guesses. Taken from the
 * bridge's own ladder (`resources/paper-bridge/extension/`): the open-access
 * resolvers in `OA_SOURCES` — unpaywall, openalex, pmc, core — and the mirrors
 * in `mirror-sources.js` — libgen, annas, scihub. The extension runs them
 * automatically; this offers the same doors for a person to open, because a
 * human with a browser can solve a captcha, use an institutional login and read
 * a landing page that an automated fetch cannot.
 *
 * ORDER is deliberate and fixed: Sci-Hub, then Anna's Archive, then the rest
 * alphabetically. The first two are where a paywalled paper is most often
 * actually found, so they lead; ordering the remainder alphabetically means the
 * list does not imply a ranking it cannot justify.
 *
 * DOI-ADDRESSED WHERE POSSIBLE. Most of these resolve a DOI directly and only
 * fall back to a title search without one — a title search on Sci-Hub is close
 * to useless, so a row with no DOI simply offers fewer, weaker doors rather
 * than pretending they are equivalent.
 *
 * Opened in the user's own browser; nothing here is fetched in-app, so the CSP
 * and the offline guarantee are untouched.
 */
interface RecoverySource {
  id: string
  label: string
  url: string
  /** Why this one is worth a try, in one clause. */
  tip: string
}

function recoverySources(job: JobDTO): RecoverySource[] {
  const doi = job.work_doi?.trim() ?? ''
  // plainText: this becomes a SEARCH QUERY on an external index, and a tag
  // name in it searches for the letters 'i' and 'sub'.
  const title = plainText((job.work_title ?? '').trim())
  const q = encodeURIComponent(title || doi)
  const encDoi = encodeURIComponent(doi)
  const out: RecoverySource[] = []

  // The two mirrors first — where a paywalled paper is most often found.
  if (doi) {
    out.push({
      id: 'scihub',
      label: 'Sci-Hub',
      url: `https://sci-hub.se/${doi}`,
      tip: 'Mirror the app already tried. Opening it yourself can get past a check it could not.'
    })
  }
  out.push({
    id: 'annas',
    label: "Anna's Archive",
    // `/scidb/<doi>` is the paper-specific page the extension uses; without a
    // DOI only a title search is possible, which is a weaker but real fallback.
    url: doi ? `https://annas-archive.org/scidb/${doi}` : `https://annas-archive.org/search?q=${q}`,
    tip: 'Mirror the app already tried, with a wider catalogue behind a login.'
  })

  // Then the open-access resolvers, alphabetically. Each is the SAME service
  // the extension queried, as a page a person can read.
  if (doi) {
    out.push({
      id: 'core',
      label: 'CORE',
      url: `https://core.ac.uk/search?q=${encDoi}`,
      tip: 'Aggregates open-access repositories, including author-deposited copies.'
    })
    out.push({
      id: 'libgen',
      label: 'Library Genesis',
      url: `https://libgen.is/scimag/?q=${encDoi}`,
      tip: 'Mirror the app already tried.'
    })
    out.push({
      id: 'openalex',
      label: 'OpenAlex',
      url: `https://openalex.org/works?filter=doi:${encDoi}`,
      tip: 'Shows every open copy it knows of, including ones behind a different link.'
    })
    out.push({
      id: 'pmc',
      label: 'PubMed Central',
      url: `https://www.ncbi.nlm.nih.gov/pmc/?term=${encDoi}`,
      tip: 'Free full text for anything with a PMC deposit.'
    })
    out.push({
      id: 'unpaywall',
      label: 'Unpaywall',
      url: `https://api.unpaywall.org/v2/${doi}?email=unpaywall@impactstory.org`,
      tip: 'The open-access index the app checks first; its record shows where a legal copy sits.'
    })
    out.push({
      id: 'publisher',
      label: 'Publisher',
      url: `https://doi.org/${doi}`,
      tip: 'The journal itself. Works when you have an institutional subscription.'
    })
  } else if (title) {
    // No DOI: only the search-by-words doors are honest.
    out.push({
      id: 'scholar',
      label: 'Google Scholar',
      url: `https://scholar.google.com/scholar?q=${q}`,
      tip: 'Finds copies posted elsewhere when there is no DOI to resolve.'
    })
  }
  return out
}

// Infer which ingest `kind` a pasted string is. This replaces the old manual
// "or paste [title] [PMID] [arXiv]" chip row: the user just pastes, we classify.
function inferKind(raw: string): Kind {
  const v = raw.trim()
  if (/^https?:\/\//i.test(v)) return 'url'
  if (/^(doi:)?10\.\d{4,9}\//i.test(v)) return 'doi'
  if (/^(arxiv:)?\d{4}\.\d{4,5}(v\d+)?$/i.test(v)) return 'arxiv'
  if (/^(pmid:?\s*)?\d{5,8}$/i.test(v)) return 'pmid'
  return 'title'
}

/**
 * The absolute filesystem path behind a dropped File, or null.
 *
 * The ingest IPC takes a PATH string, not bytes. Electron 33 removed
 * `File.path`, so the path comes from `webUtils.getPathForFile` bridged through
 * the preload. Null means the runtime refused to locate the File, which the
 * caller reports rather than silently dropping.
 */
/**
 * "Add or drop the PDF manually" — the surface a paper with no file offers.
 *
 * DELIBERATELY THE SAME SHAPE AS THE "Import from file" DROP ZONE (`.ing-drop`),
 * because it is the same act aimed at one paper instead of the library: a dashed
 * region that says what it takes, holds its own button, and answers a drag by
 * changing its border, background AND its wording. Two controls that both accept
 * a dropped PDF should not have to be learned twice.
 *
 * It sits BELOW the error container and spans the row. Inside it, it was a chip
 * competing for width with a paragraph of retriever log, so the remedy read as
 * one more piece of the error text — on the one row where it is the only thing
 * the user can actually do.
 *
 * A <label> over a hidden <input type=file>, and the input comes FIRST so the
 * label is its adjacent sibling: focus lands on the input while the label is the
 * only visible part, so the ring is drawn through `:focus-visible + …`.
 */
function AddPdfManually({
  id,
  busy,
  over,
  onPick
}: {
  id: string
  busy: boolean
  /** A file is being dragged over the ROW this belongs to. */
  over: boolean
  onPick: (file: File | undefined) => void
}): JSX.Element {
  return (
    <div
      className={`ing-attach${over ? ' is-over' : ''}${busy ? ' is-busy' : ''}`}
      data-testid={`job-attach-${id}`}
    >
      <svg
        className="ing-attach-icon"
        width="20"
        height="20"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        aria-hidden="true"
      >
        <path d="M10 13V3.5M6.5 7L10 3.5 13.5 7" />
        <path d="M3.5 12.5V15A1.5 1.5 0 0 0 5 16.5h10a1.5 1.5 0 0 0 1.5-1.5v-2.5" />
      </svg>
      <span className="ing-attach-title">
        {busy
          ? 'Saving the PDF into the library…'
          : over
            ? 'Release to attach it to this paper'
            : 'No PDF could be fetched — add it yourself'}
      </span>
      <input
        id={id}
        className="ing-attach-file"
        type="file"
        accept="application/pdf"
        disabled={busy}
        data-testid={id}
        onChange={(e) => {
          onPick(e.target.files?.[0])
          // CLEARED, so choosing the same file twice fires again: after a failed
          // attach the value is unchanged, `change` would not fire, and the
          // retry would look inert.
          e.target.value = ''
        }}
      />
      <label className="ing-attach-btn" htmlFor={id}>
        {busy ? 'Attaching…' : 'Add or drop the PDF manually'}
      </label>
    </div>
  )
}

function filePath(f: File): string | null {
  const p = window.api.getDroppedPath(f)
  return p.length > 0 ? p : null
}

// ============================================================ papers finder
//
// The Papers screen is the ONE place for everything paper-related: the project's
// papers, the search over them, and the processing queue. There is no separate
// search route and no topbar search box.
//
// The paper LIST and the search RESULTS are the same surface: an empty query
// with no filters is "every paper in this project" (ordered by relevance), and
// typing or pressing a facet chip narrows THAT list. Two competing lists would
// leave the user guessing which one is authoritative.

/** The five facets, in rail order. Labels are UI copy, not domain data. */
const FACET_KEYS = [
  { key: 'work_type', label: 'Work type' },
  { key: 'venue', label: 'Venue' },
  { key: 'year', label: 'Year' },
  { key: 'inclusion_status', label: 'Inclusion' },
  { key: 'content_status', label: 'Content' }
] as const satisfies readonly { key: keyof SearchFilters; label: string }[]

type FacetKey = (typeof FACET_KEYS)[number]['key']

const EMPTY_FILTERS: SearchFilters = {}

const facetValues = (f: SearchFilters, k: FacetKey): string[] => f[k] ?? []

const activeCount = (f: SearchFilters): number =>
  FACET_KEYS.reduce((n, { key }) => n + facetValues(f, key).length, 0) +
  (f.yearFrom !== undefined ? 1 : 0) +
  (f.yearTo !== undefined ? 1 : 0) +
  (f.minCitations !== undefined ? 1 : 0) +
  (f.author ? 1 : 0)

/** Toggle one value in one facet, dropping the key entirely when it empties. */
function toggleFilter(f: SearchFilters, k: FacetKey, value: string): SearchFilters {
  const cur = facetValues(f, k)
  const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value]
  const out = { ...f }
  if (next.length === 0) delete out[k]
  else out[k] = next
  return out
}

/**
 * Filters as persisted in `saved_search.filters`. Parsing is defensive: the
 * column is free-form JSON that older rows (and the seed) may not have written
 * in this shape, so anything unrecognised degrades to "no filters" rather than
 * throwing inside the click handler.
 */
function parseFilters(raw: string | null): SearchFilters {
  if (!raw) return EMPTY_FILTERS
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return EMPTY_FILTERS
  }
  if (typeof parsed !== 'object' || parsed === null) return EMPTY_FILTERS
  const rec = parsed as Record<string, unknown>
  const out: SearchFilters = {}
  for (const { key } of FACET_KEYS) {
    const v = rec[key]
    if (!Array.isArray(v)) continue
    const vals = v.filter((x): x is string => typeof x === 'string' && x.length > 0)
    if (vals.length > 0) out[key] = vals
  }
  // Same defensiveness for the range narrowing: a saved row written before these
  // existed simply has none of them.
  const int = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : undefined
  out.yearFrom = int(rec.yearFrom)
  out.yearTo = int(rec.yearTo)
  out.minCitations = int(rec.minCitations)
  if (typeof rec.author === 'string' && rec.author.trim()) out.author = rec.author
  if (
    rec.sort === 'relevance' ||
    rec.sort === 'year' ||
    rec.sort === 'citations' ||
    rec.sort === 'title'
  ) {
    out.sort = rec.sort
  }
  return out
}

/** Stable key so `useAsync` re-runs whenever the filter selection changes. */
// EVERY narrowing the query depends on, not just the chips: a key that ignored
// the range filters would leave the results stale when one of them changed.
const filtersKey = (f: SearchFilters): string =>
  [
    ...FACET_KEYS.map(({ key }) => `${key}:${[...facetValues(f, key)].sort().join('|')}`),
    `yf:${f.yearFrom ?? ''}`,
    `yt:${f.yearTo ?? ''}`,
    `mc:${f.minCitations ?? ''}`,
    `au:${f.author ?? ''}`,
    `so:${f.sort ?? ''}`
  ].join(';')

/**
 * What fraction of the papers on screen semantic search can actually see.
 *
 * The single number that decides whether a short result list means "the library
 * holds little on this" or "most of the library was not searched". Returns null
 * when there is nothing with text at all, because a ratio over zero papers is
 * not 0 % coverage — it is no question yet.
 */
function coverageRatio(c: SemanticCoverageDTO): number | null {
  if (c.works_total === 0) return null
  return c.works_embedded / c.works_total
}

/**
 * The verdict on that ratio, in the same spirit as the analysis freshness card:
 * four named states, one of which admits to knowing nothing.
 *
 * `none` is not "0 % coverage" dressed up — it is the state where semantic
 * search cannot answer at all, and it reads differently because the user's next
 * action is different (wait for the embed stage, versus widen the query).
 */
/**
 * Returns null when every paper is searchable — the state that needs no words.
 *
 * A badge asserting that nothing is wrong is on screen for the whole life of a
 * healthy project, which is exactly how a reader learns to stop reading it; the
 * one time it changes to say a paper is MISSING from the search, it has already
 * been trained into furniture. So the affirmative case is silent and only a
 * shortfall speaks.
 */
function coverageVerdict(
  c: SemanticCoverageDTO
): { key: 'partial' | 'none' | 'unavailable'; label: string; cls: string; detail: string } | null {
  if (c.space === null || c.chunks === 0) {
    return {
      key: 'none',
      label: 'no papers searchable by meaning',
      cls: 'muted',
      detail:
        c.works_with_text === 0
          ? `None of the ${c.works_total} paper(s) here have had their text extracted yet, so there is nothing to embed and a meaning search can return nothing.`
          : `None of the ${c.works_with_text} paper(s) with text have been embedded yet, out of ${c.works_total} in the project. They become searchable by meaning when their embed stage finishes.`
    }
  }
  // Every vector answering queries predates the settings currently in force.
  // A REACHABLE state, unlike a non-active space — the registry only ever hands
  // back the active one — and the one that actually misleads: the k-NN does not
  // filter on `config_hash`, so these chunks rank normally while describing an
  // older reading of the papers.
  if (c.works_stale_only > 0 && c.works_stale_only >= c.works_embedded) {
    return {
      key: 'unavailable',
      label: 'all results come from indexed with older settingss',
      cls: 'danger',
      detail:
        `Every embedded paper here was indexed under settings ${c.space.model_id} no longer ` +
        'uses, so results describe an older reading of the corpus. They will be replaced as ' +
        'the embed stage re-runs.'
    }
  }
  const ratio = coverageRatio(c)
  if (ratio === null) {
    return {
      key: 'unavailable',
      label: 'coverage unknown',
      cls: 'muted',
      detail:
        'Vectors exist but the project reports no papers, so how much of the library they cover cannot be established.'
    }
  }
  // Measured against EVERY paper in the project, not only the ones with text.
  // "All papers with text are searchable" is true of a library where 3 of 20
  // have been read, and it is exactly the reassurance a user must not be given.
  // "Current" excludes the stale-only works: they answer queries, but from an
  // older reading, so counting them towards a green "everything is covered"
  // would be the reassurance this whole surface exists to withhold.
  const current = c.works_embedded - c.works_stale_only
  const staleNote =
    c.works_stale_only > 0
      ? ` ${c.works_stale_only} paper(s) still answer from indexed with older settingss and are re-embedded as the stage re-runs.`
      : ''

  if (current >= c.works_total) return null
  const gap = c.works_total - current
  const noText = c.works_total - c.works_with_text
  return {
    key: 'partial',
    // Names what is MISSING, not what is present: the number a reader has to
    // act on is the papers a short result list may have silently omitted.
    label: `${gap} paper${gap === 1 ? '' : 's'} can't be searched`,
    cls: 'warn',
    detail:
      `${gap} paper(s) are not fully searchable — ` +
      (noText > 0 ? `${noText} have no extracted text yet. ` : '') +
      'A short list may mean the search did not see them rather than that nothing matches.' +
      staleNote
  }
}

/**
 * Words or meaning, plus the coverage that decides whether the second is worth
 * trusting.
 *
 * The coverage sits ON the switch, not buried in the results: "should I use
 * this" is asked before the first search, and an answer that only appears
 * afterwards arrives too late to inform the choice.
 */
function SearchModeSwitch({
  mode,
  onChange,
  coverage,
  coverageLoading,
  busy
}: {
  mode: 'keyword' | 'meaning'
  onChange: (m: 'keyword' | 'meaning') => void
  coverage: SemanticCoverageDTO | null
  coverageLoading: boolean
  /**
   * A meaning search is in flight.
   *
   * The switch stays CLICKABLE — going back to keyword search mid-query is a
   * legitimate thing to want, and taking the escape hatch away during the only
   * slow operation on the screen would be the worst possible moment for it. It
   * is marked BUSY instead, so the wait is visible rather than a control that
   * silently keeps accepting clicks.
   */
  busy: boolean
}): JSX.Element {
  const verdict = coverage ? coverageVerdict(coverage) : null
  return (
    <div className="sem-modes" data-testid="search-modes">
      <div className="sem-mode-group" role="group" aria-label="How to search">
        <button
          type="button"
          className={`sem-mode ${mode === 'keyword' ? 'is-on' : ''}`}
          data-testid="search-mode-keyword"
          aria-pressed={mode === 'keyword'}
          data-tip="Find papers that CONTAIN your words. Exhaustive over every paper in the project, and exact — a paper that never uses your wording will not appear."
          onClick={() => onChange('keyword')}
        >
          By words
        </button>
        <button
          type="button"
          className={`sem-mode ${mode === 'meaning' ? 'is-on' : ''} ${busy ? 'is-busy' : ''}`}
          data-testid="search-mode-meaning"
          aria-pressed={mode === 'meaning'}
          aria-busy={busy}
          data-tip={
            busy
              ? 'A meaning search is running. Switching back to words will abandon it.'
              : 'Find PASSAGES that mean something similar to what you describe, even in different words. Only searches papers that have been embedded — see the coverage beside this.'
          }
          onClick={() => onChange('meaning')}
        >
          By meaning
        </button>
      </div>

      {coverageLoading && coverage === null ? (
        <span className="sem-cov is-loading" data-testid="semantic-coverage">
          <span className="sk sem-cov-skel" aria-hidden="true" />
          Checking what is searchable by meaning…
        </span>
      ) : (
        verdict &&
        coverage && (
          <span
            className={`sem-cov is-${verdict.key}`}
            data-testid="semantic-coverage"
            data-verdict={verdict.key}
            data-tip={verdict.detail}
          >
            {/* The word carries the state, the colour only reinforces it, so a
                colourblind reader can still tell a shortfall from an outage. */}
            <span className={`badge badge-${verdict.cls} sem-cov-badge`}>{verdict.label}</span>
            {/* The passage COUNT is deliberately absent: it measures the
                index, not the answer, and a reader cannot act on it. What
                remains are the two states that change what a result means. */}
            {coverage.space !== null && (!coverage.indexed || coverage.stale_chunks > 0) && (
              <span className="sem-cov-meta mono">
                {!coverage.indexed && (
                  <span
                    className="badge badge-danger"
                    data-tip="These papers were embedded without a search index, so searching across them fails outright — only a search narrowed to a single paper still answers. Re-run the embed stage to rebuild it."
                  >
                    no search index
                  </span>
                )}
                {!coverage.indexed && coverage.stale_chunks > 0 && ' · '}
                {coverage.stale_chunks > 0 && `${coverage.stale_chunks} stale`}
              </span>
            )}
          </span>
        )
      )}
    </div>
  )
}

/**
 * The papers a meaning search cannot see, named.
 *
 * Collapsed by default because on a healthy corpus it is empty and on a
 * mid-ingest one it is long — but never hidden: a result list that quietly
 * excludes papers is the specific way this feature misleads.
 */
function UnembeddedList({
  works,
  total,
  onOpenWork
}: {
  works: SemanticCoverageDTO['unembedded']
  /** The REAL count. `works` is capped, so it may be smaller. */
  total: number
  onOpenWork: (workId: number) => void
}): JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (total === 0) return null
  return (
    <div className={`sem-unembedded ${open ? 'is-open' : ''}`} data-testid="semantic-unembedded">
      <button
        type="button"
        className="sem-unembedded-toggle"
        data-testid="semantic-unembedded-toggle"
        aria-expanded={open}
        data-tip="These papers have not been indexed for meaning search yet, so it cannot return them. Searching by words still finds them."
        onClick={() => setOpen((v) => !v)}
      >
        <span className="sem-unembedded-caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        {total} paper{total === 1 ? '' : 's'} not searchable by meaning yet
      </button>
      {open && (
        <ul className="sem-unembedded-list">
          {works.map((w) => (
            <li key={w.work_id} className="sem-unembedded-li">
              <button
                type="button"
                className="btn-link sem-unembedded-item"
                data-testid={`semantic-unembedded-${w.work_id}`}
                onClick={() => onOpenWork(w.work_id)}
              >
                <RichText text={w.title} />
              </button>
              {/* WHY, per paper: waiting on text extraction and waiting on the
                  embed stage are different waits with different remedies, and
                  one label for both would tell half of them to be patient about
                  a stage that is not the one holding them up. */}
              <span
                className="sem-unembedded-why"
                data-tip={
                  w.reason === 'no-text'
                    ? 'The text has not been read out of this PDF yet, so there is nothing to index.'
                    : 'The text has been read, but this paper has not been indexed for meaning search yet.'
                }
              >
                {w.reason === 'no-text' ? 'no text yet' : 'not embedded'}
              </span>
            </li>
          ))}
          {/* The list is capped so a 3000-paper library does not cross IPC on
              every mount. Saying how many are NOT shown is what keeps the cap
              from reading as the whole set. */}
          {total > works.length && (
            <li className="sem-unembedded-rest" data-testid="semantic-unembedded-rest">
              and {total - works.length} more, not listed here
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

/**
 * The matching passage — THE REASON THE ROW IS ON SCREEN.
 *
 * Two decisions, both about not asking the user to take the ranking on trust:
 *
 * 1. Long passages are CLAMPED with an explicit "show the rest", never
 *    ellipsised into silence. A chunk can run past a full screen, so an
 *    unclamped list showed one result and buried the other twenty-nine; but
 *    truncating with no way back would hide the half of the evidence that
 *    decides whether the match is real. Clamped-with-a-handle is the only option
 *    that is both scannable and honest.
 * 2. The line breaks a PDF's text layer leaves mid-sentence are re-flowed for
 *    DISPLAY. They are extraction artifacts of the page's column width, not the
 *    author's paragraphing, and rendering them verbatim turned a paragraph into
 *    forty ragged lines. Only whitespace is touched — no word, number or
 *    punctuation mark is altered, so the quote still says exactly what the
 *    paper says. A blank line (a real paragraph break) survives.
 */
function reflow(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((para) => para.replace(/\s*\n\s*/g, ' ').trim())
    .filter((para) => para.length > 0)
    .join('\n\n')
}

function SemanticQuote({ chunkId, text }: { chunkId: number; text: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const body = reflow(text)
  // Measured in characters rather than by clamping alone, because the toggle
  // must only appear when there IS more — a "show the rest" button that reveals
  // nothing is worse than no button.
  const long = body.length > 420
  return (
    <div className="sem-hit-quote-wrap">
      <blockquote
        className={`sem-hit-quote ${long && !expanded ? 'is-clamped' : ''}`}
        data-testid={`semantic-quote-${chunkId}`}
      >
        {body}
      </blockquote>
      {long && (
        <button
          type="button"
          className="btn-link sem-hit-more"
          data-testid={`semantic-quote-more-${chunkId}`}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'show less' : `show the rest (${body.length} characters)`}
        </button>
      )}
    </div>
  )
}

/** One matching passage, with the paper it belongs to and every caveat on it. */
function SemanticHit({
  hit,
  onOpenWork
}: {
  hit: SemanticHitDTO
  onOpenWork: (workId: number) => void
}): JSX.Element {
  const band = similarityBand(hit.score)
  // The document's OWN confidence, so a passage recognised at 41 % is badged
  // "OCR · poorly read" and one at 95 % is not. Passing null here rendered both
  // identically and made the danger state unreachable in search results.
  const ts = textSourceMeta(hit.text_source, hit.text_confidence, OCR_LOW_CONFIDENCE)
  return (
    <div className="sem-hit" data-testid={`semantic-hit-${hit.chunk_id}`} data-band={band.label}>
      <button
        type="button"
        className="sem-hit-open"
        data-testid={`semantic-open-${hit.work_id}`}
        aria-label={`Open ${hit.title}`}
        onClick={() => onOpenWork(hit.work_id)}
      />
      <div className="sem-hit-main">
        <div className="sem-hit-title">{hit.title}</div>
        <div className="sem-hit-meta">
          {hit.authors.length > 0 && (
            <span className="sem-hit-authors">{authorLine(hit.authors)}</span>
          )}
          <span className="sem-hit-venue">{hit.venue ?? 'no venue'}</span>
          <span className="sem-hit-year mono">{hit.year ?? '—'}</span>
          {hit.page !== null && <span className="sem-hit-page mono">p.{hit.page}</span>}
          {hit.section && <span className="sem-hit-section">{hit.section}</span>}
        </div>
        <SemanticQuote chunkId={hit.chunk_id} text={hit.text} />
        <div className="sem-hit-flags">
          {hit.low_confidence && (
            <span
              className="badge badge-warn"
              data-testid={`semantic-lowconf-${hit.chunk_id}`}
              data-tip="Only part of this passage was compared — it was very short, or too long to read in full — so the match is less reliable than the quote suggests."
            >
              partial passage
            </span>
          )}
          {ts && hit.text_source !== 'pdf-text-layer' && (
            <span
              className={`badge badge-${ts.cls}`}
              data-testid={`semantic-textsrc-${hit.chunk_id}`}
              data-tip={ts.hint}
            >
              {ts.label}
              {hit.text_source === 'ocr' && hit.text_confidence !== null && (
                <span className="sem-hit-flag-num mono">
                  {hit.text_confidence.toFixed(0)}%
                </span>
              )}
            </span>
          )}
          {/* The k-NN does not filter on config_hash, so a vector written under
              older settings ranks here looking exactly like a current one. Said
              per hit, because a total in the header cannot tell the user WHICH
              result it applies to. */}
          {hit.stale_vector && (
            <span
              className="badge badge-danger"
              data-testid={`semantic-stale-${hit.chunk_id}`}
              data-tip="This passage was indexed with older settings, so the match may be off. It refreshes next time the paper is re-indexed."
            >
              indexed with older settings
            </span>
          )}
        </div>
      </div>
      <div className="sem-hit-side">
        {/* A cosine, shown as a cosine. Never a percentage — 0.81 is not "81 %
            confident", and a % sign would convert a distance into a certainty
            the model never expressed. */}
        <span
          className="sem-hit-score mono"
          data-testid={`semantic-score-${hit.chunk_id}`}
          data-tip="How close this passage is in meaning to what you typed, from -1 to 1. It is a closeness score, not a confidence that the passage answers your question."
        >
          {fmtSimilarity(hit.score)}
        </span>
        <span className={`badge badge-${band.cls} sem-hit-band`} data-tip={band.hint}>
          {band.label}
        </span>
      </div>
    </div>
  )
}

function SemanticResults({
  state,
  query,
  coverage,
  onOpenWork
}: {
  state: ReturnType<typeof useAsync<SemanticSearchResultDTO | null>>
  query: string
  coverage: SemanticCoverageDTO | null
  onOpenWork: (workId: number) => void
}): JSX.Element {
  const res = state.data

  if (state.loading) {
    return (
      <div className="sem-body" data-testid="semantic-results">
        <div className="sem-status" role="status">
          <span className="sem-progress-bar" aria-hidden="true" />
          Reading the query and comparing it with every embedded passage…
        </div>
        <WebSearchSkeleton rows={4} />
      </div>
    )
  }

  if (state.error) {
    return (
      <div className="sem-body" data-testid="semantic-results">
        <EmptyState
          title="The meaning search could not run."
          hint={state.error}
          testid="semantic-error"
        />
      </div>
    )
  }

  if (query.trim().length === 0) {
    return (
      <div className="sem-body" data-testid="semantic-results">
        <EmptyState
          title="Describe what you are looking for."
          hint="A meaning search compares your sentence with every embedded passage, so a phrase or a whole question works far better than one keyword."
          testid="semantic-idle"
        />
        {coverage && <UnembeddedList works={coverage.unembedded} total={coverage.unembedded_total} onOpenWork={onOpenWork} />}
      </div>
    )
  }

  // A state the USER can act on, not a bug: nothing embedded, no model, a model
  // swapped under the existing vectors. Explained rather than thrown.
  if (res && res.error !== null) {
    return (
      <div className="sem-body" data-testid="semantic-results">
        <EmptyState
          title="Nothing here can answer a meaning search yet."
          hint={res.error}
          testid="semantic-unavailable"
        />
        <UnembeddedList works={res.coverage.unembedded} total={res.coverage.unembedded_total} onOpenWork={onOpenWork} />
      </div>
    )
  }

  const hits = res?.hits ?? []
  return (
    <div className="sem-body" data-testid="semantic-results">
      <div className="sem-status">
        <span className="sem-count" aria-live="polite" data-testid="semantic-count">
          {hits.length === 0
            ? 'No passage was close enough to return.'
            : /* "the closest N" when the budget was filled, because a count of
                 what arrived would otherwise read as a count of what matched —
                 and the list IS capped. */
              `${res && hits.length >= res.requested_k ? 'the closest ' : ''}${hits.length} passage${
                hits.length === 1 ? '' : 's'
              } from ${new Set(hits.map((h) => h.work_id)).size} paper${
                new Set(hits.map((h) => h.work_id)).size === 1 ? '' : 's'
              }`}
        </span>
        {res && hits.length >= res.requested_k && (
          <span
            className="sem-capped"
            data-testid="semantic-capped"
            data-tip={`A search returns the ${res.requested_k} nearest passages, not every passage above some threshold. More may match — refine the query to see different ones.`}
          >
            list is capped
          </span>
        )}
        {/* Only when a query actually reached the index. A null strategy means
            nothing was searched, and naming either path would describe work
            that was never done. */}
        {res && res.strategy !== null && (
          <span
            className="sem-timing mono"
            data-testid="semantic-timing"
            data-tip={
              res.strategy === 'exhaustive'
                ? 'The search was narrow enough to compare every passage in it exactly, rather than asking the index for its best guess.'
                : 'Answered from the vector index, on a background thread so the window stayed responsive.'
            }
          >
            {res.took_ms} ms
          </span>
        )}
      </div>

      {hits.length === 0 ? (
        <EmptyState
          title="No passage was close enough."
          hint="Try describing the idea in a fuller sentence. A meaning search compares whole passages, so it has little to work with from one or two words."
          testid="semantic-no-results"
        />
      ) : (
        <div className="sem-list">
          {hits.map((h) => (
            <SemanticHit key={h.chunk_id} hit={h} onOpenWork={onOpenWork} />
          ))}
        </div>
      )}

      {res && <UnembeddedList works={res.coverage.unembedded} total={res.coverage.unembedded_total} onOpenWork={onOpenWork} />}
    </div>
  )
}

function PapersFinder({
  projectId,
  onOpenWork,
  onFindNew,
  onFromFile
}: {
  projectId: number
  onOpenWork: (workId: number) => void
  /**
   * Switch to the sibling tab that searches the literature, or NULL when there
   * is no such tab because nothing installed can search.
   *
   * Null rather than an absent prop, so the empty state can refuse the button
   * and say why rather than quietly dropping the offer.
   */
  onFindNew: (() => void) | null
  /** Switch to the sibling tab that takes PDFs off this machine. */
  onFromFile: () => void
}): JSX.Element {
  // `draft` is what is typed; `query` is what has been submitted. Chips apply
  // immediately (they are a selection, not free text) — only the text field
  // waits for Enter/Search so every keystroke is not a query.
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState<SearchFilters>(EMPTY_FILTERS)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const fkey = filtersKey(filters)

  /**
   * Words or meaning — a MODE, not a blend.
   *
   * The two searches answer different questions and are wrong in different ways.
   * Keyword search finds the papers containing your words and can be trusted to
   * be exhaustive over what it indexes; semantic search finds passages that mean
   * something similar and is bounded by what has been EMBEDDED, which is
   * routinely less than the whole library. Merging them into one ranked list
   * would put results with those two very different warranties side by side with
   * no way to tell which was which, and would let a partly embedded corpus
   * silently degrade a keyword search that was fine.
   *
   * The facets, ranges and history belong to the keyword search — they narrow by
   * stored fields, which is not what a vector query does — so the mode switches
   * the rail too rather than leaving controls that do nothing.
   */
  const [mode, setMode] = useState<'keyword' | 'meaning'>('keyword')

  const results = useAsync<SearchResultDTO[]>(
    () => window.api.search(query, projectId, filters),
    [query, projectId, fkey]
  )

  // The semantic query runs only in its own mode: it costs an ONNX forward pass
  // per query, and paying that for a keyword search nobody asked to be semantic
  // would be work the user never requested.
  const semantic = useAsync<SemanticSearchResultDTO | null>(
    () => (mode === 'meaning' ? window.api.semanticSearch(query, projectId) : Promise.resolve(null)),
    [query, projectId, mode]
  )

  // Coverage is loaded in BOTH modes: whether semantic search can be trusted is
  // the thing that decides whether to switch to it, so the answer has to be
  // visible on the switch itself rather than only after using it.
  const coverage = useAsync<SemanticCoverageDTO>(
    () => window.api.semanticCoverage(projectId),
    [projectId]
  )

  // Counts follow the query + the OTHER facets (computed in SQL), so a chip's
  // number always states how many papers it would ADD to the current view.
  const facets = useAsync<FacetsDTO>(
    () => window.api.getFacets(projectId, query, filters),
    [query, projectId, fkey]
  )
  const saved = useAsync<SavedSearchDTO[]>(
    () => window.api.listSearchHistory(projectId),
    [projectId]
  )
  /** The last search ran but was not filed into the history below. */
  const [historyUnwritten, setHistoryUnwritten] = useState(false)
  // Counts come from SQL COUNT(*), NOT from `results.length`: the result query
  // is capped at a page of rows, so counting the rows we happened to receive
  // would report the cap as if it were the corpus.
  const matched = useAsync<number>(
    () => window.api.countSearch(query, projectId, filters),
    [query, projectId, fkey]
  )
  const total = useAsync<number>(() => window.api.countSearch('', projectId), [projectId])

  // Ctrl/Cmd+K focuses the search field. Deleting the topbar box removed the
  // app's only keyboard route to search; this restores one. Gated on
  // visibility: a Papers tab that is mounted but not on screen must not answer,
  // or the keystroke focuses a field in a tab the user is not looking at.
  useVisibleWindowListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  })

  const nActive = activeCount(filters)
  const isNarrowed = nActive > 0 || query.trim().length > 0
  // The whole apparatus of this tab — the field, the mode switch, the facet
  // rail, the ranges, the history — exists to NARROW a set of papers. With no
  // papers there is nothing to narrow, and rendering it anyway produced five
  // facet headings each over a lone em-dash: scaffolding that reads as a report
  // that failed rather than as a library nobody has filled yet.
  const nothingToSearch = total.data === 0

  // Draft text for the range fields. Kept separate from `filters` so a partly
  // typed year ("20") does not run a search for year 20 on every keystroke; the
  // committed value is written into `filters` on Enter or blur.
  const [yearFrom, setYearFrom] = useState('')
  const [yearTo, setYearTo] = useState('')
  const [minCites, setMinCites] = useState('')
  const [author, setAuthor] = useState('')

  const num = (s: string): number | undefined => {
    const n = Number.parseInt(s.trim(), 10)
    return Number.isFinite(n) ? n : undefined
  }

  /** The range fields as they are typed right now, merged onto `base`. */
  const withRanges = (base: SearchFilters): SearchFilters => ({
    ...base,
    yearFrom: num(yearFrom),
    yearTo: num(yearTo),
    minCitations: num(minCites),
    author: author.trim() || undefined
  })

  const commitRanges = (): void => setFilters(withRanges)

  /**
   * Run the search and record it.
   *
   * The committed filters are computed HERE rather than read back from state:
   * `setFilters` has not applied yet at this point, so recording from state
   * would file the search under the PREVIOUS set of filters.
   */
  const runSearch = (): void => {
    const next = withRanges(filters)
    setFilters(next)
    setQuery(draft)
    record(draft, next)
  }

  /**
   * Toggle one facet value AND record the search it produces.
   *
   * Narrowing re-runs the search exactly as pressing the button does, so it is
   * every bit as much "a search the user ran" — without this the history keeps
   * only the bare query text and restoring an entry silently drops the chips it
   * claims to store. `recordSearch` dedupes on (query, filters), so the
   * intermediate steps of a narrowing collapse rather than flooding the list.
   */
  const narrow = (key: FacetKey, value: string): void => {
    // Computed outside the updater: `setFilters` may re-invoke its callback, and
    // recording from in there would file the same search twice.
    const next = toggleFilter(filters, key, value)
    setFilters(next)
    record(query, next)
  }

  const setSort = (sort: SearchSort): void => setFilters((f) => ({ ...f, sort }))

  const clearAll = (): void => {
    setFilters(EMPTY_FILTERS)
    setQuery('')
    setDraft('')
    setYearFrom('')
    setYearTo('')
    setMinCites('')
    setAuthor('')
  }

  /** Re-run a past search exactly as it was: query, chips, ranges and sort. */
  const restore = (s: SavedSearchDTO): void => {
    const f = parseFilters(s.filters)
    setFilters(f)
    // The range fields are draft state, so restoring the filters alone would
    // apply them while the boxes still showed the previous search's text.
    setYearFrom(f.yearFrom !== undefined ? String(f.yearFrom) : '')
    setYearTo(f.yearTo !== undefined ? String(f.yearTo) : '')
    setMinCites(f.minCitations !== undefined ? String(f.minCitations) : '')
    setAuthor(f.author ?? '')
    setDraft(s.query)
    setQuery(s.query)
  }

  /**
   * A human label for a history entry, derived from what was actually searched.
   *
   * The whole parameter set is stored in `filters`; this is only what the row
   * shows. A search with no words is described by its narrowing instead of
   * being listed as a blank line.
   */
  const describe = (q: string, f: SearchFilters): string => {
    const text = q.trim()
    if (text) return text
    const bits: string[] = []
    for (const { key, label } of FACET_KEYS) {
      const vals = facetValues(f, key)
      if (vals.length > 0) bits.push(`${label}: ${vals.join(', ')}`)
    }
    if (f.yearFrom !== undefined || f.yearTo !== undefined) {
      bits.push(`${f.yearFrom ?? '…'}–${f.yearTo ?? '…'}`)
    }
    if (f.minCitations !== undefined) bits.push(`${f.minCitations}+ cited`)
    if (f.author) bits.push(f.author)
    return bits.join(' · ') || 'all papers'
  }

  /**
   * Record what was just run. Fire-and-forget: the history is a convenience, and
   * failing to write it must never break the search the user asked for.
   */
  const record = (q: string, f: SearchFilters): void => {
    if (!q.trim() && activeCount(f) === 0) return // "all papers" is not history
    void window.api
      .recordSearch({
        projectId,
        name: describe(q, f),
        query: q,
        // The WHOLE parameter set, so restoring reapplies the chips, the ranges,
        // the author list and the sort — not just the text.
        filters: JSON.stringify(f)
      })
      .then(() => {
        setHistoryUnwritten(false)
        saved.reload()
      })
      // The search itself already ran and its results are on screen — this is
      // only the note of it. But the list below it would go on showing the
      // PREVIOUS searches with the newest one missing, which reads as a history
      // that quietly forgets, so the panel says the last one was not filed.
      .catch(() => setHistoryUnwritten(true))
  }

  if (nothingToSearch) {
    return (
      <section className="pap" data-testid="papers-finder" aria-label="Search existing papers">
        <EmptyState
          title="No papers in this project yet."
          hint="This tab searches the papers you have already collected. There are two ways to get the first ones in."
          testid="search-no-results"
        >
          <div className="empty-state-actions">
            {/* REFUSES rather than disappearing when nothing can search. The
                offer is still the right one — this is how a scientist fills an
                empty project — so the button says why it cannot be taken and
                where to fix it, instead of leaving a reader wondering whether
                this app searches at all (hard rule 0.5). */}
            <button
              type="button"
              className="btn btn-primary"
              data-testid="papers-empty-find-new"
              aria-disabled={onFindNew === null}
              onClick={() => onFindNew?.()}
              data-tip={
                onFindNew === null
                  ? PAPER_SEARCH_OFF_SENTENCE
                  : 'Search the literature by title, DOI, PMID or arXiv id.'
              }
            >
              Search for new papers
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              data-testid="papers-empty-from-file"
              onClick={onFromFile}
              data-tip="Point at a PDF, or a folder of them, already on this machine."
            >
              Add from file
            </button>
          </div>
        </EmptyState>
      </section>
    )
  }

  return (
    <section className="pap" data-testid="papers-finder" aria-label="Search existing papers">
      <div className="pap-head">
        {/* The SAME search row every tab uses: a field with the magnifier inside
            it and a full-height primary button beside it. One shape across every
            tab, so moving between them does not move the control the user is
            already aiming at. */}
        <div className="ing-input-row">
          <span className="ing-field">
            <svg
              className="ing-field-icon"
              width="15"
              height="15"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.7}
              aria-hidden="true"
            >
              <circle cx="9" cy="9" r="5.5" />
              <path d="M13.5 13.5L17 17" />
            </svg>
            <input
              ref={inputRef}
              className="ing-input ing-input-iconed"
              data-testid="papers-search-input"
              type="search"
              aria-label="Search existing papers"
              placeholder={
                mode === 'meaning'
                  ? 'Describe what you are looking for — whole sentences work best (Ctrl+K)'
                  : 'Search existing papers — use | for either/or (Ctrl+K)'
              }
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') runSearch()
              }}
            />
          </span>
          <button
            type="button"
            className="ing-submit"
            data-testid="papers-search-submit"
            onClick={runSearch}
          >
            Search
          </button>
        </div>

        <SearchModeSwitch
          mode={mode}
          onChange={setMode}
          coverage={coverage.data}
          coverageLoading={coverage.loading}
          busy={mode === 'meaning' && semantic.loading}
        />

        {/* Range narrowing + order, in the same shape as the "By query" web
            search — the two searches answer the same kind of question, so they
            take the same kind of input. Committed on Enter or blur; the facet
            chips in the rail still apply immediately, since a chip is a
            selection rather than something part-typed.

            Absent in meaning mode: a vector query is not narrowed by a stored
            year or a citation count, and leaving controls on screen that quietly
            stop applying is worse than not offering them. */}
        {mode === 'keyword' && (
        <div className="ing-web-filters" data-testid="papers-filters">
          <label className="ing-web-filter">
            <span className="ing-web-filter-label">Years</span>
            <span className="ing-web-range">
              <input
                className="ing-web-num"
                data-testid="papers-year-from"
                inputMode="numeric"
                placeholder="from"
                aria-label="Published from year"
                value={yearFrom}
                onChange={(e) => setYearFrom(e.target.value.replace(/[^\d]/g, ''))}
                onBlur={commitRanges}
                onKeyDown={(e) => e.key === 'Enter' && commitRanges()}
              />
              <span className="ing-web-dash" aria-hidden="true">
                –
              </span>
              <input
                className="ing-web-num"
                data-testid="papers-year-to"
                inputMode="numeric"
                placeholder="to"
                aria-label="Published up to year"
                value={yearTo}
                onChange={(e) => setYearTo(e.target.value.replace(/[^\d]/g, ''))}
                onBlur={commitRanges}
                onKeyDown={(e) => e.key === 'Enter' && commitRanges()}
              />
            </span>
          </label>

          <label className="ing-web-filter">
            <span className="ing-web-filter-label">Min. citations</span>
            <input
              className="ing-web-num"
              data-testid="papers-min-citations"
              inputMode="numeric"
              placeholder="any"
              aria-label="Minimum citation count"
              value={minCites}
              onChange={(e) => setMinCites(e.target.value.replace(/[^\d]/g, ''))}
              onBlur={commitRanges}
              onKeyDown={(e) => e.key === 'Enter' && commitRanges()}
            />
          </label>

          <div className="ing-web-filter">
            <span className="ing-web-filter-label">Sort</span>
            <Select
              value={filters.sort ?? 'relevance'}
              options={CORPUS_SORTS}
              onChange={setSort}
              testid="papers-sort"
              ariaLabel="Sort results"
              className="ing-web-sort"
            />
          </div>

          {/* Author keeps `-grow` wherever it sits: it is the one free-text
              field here, so it takes the slack the fixed-width controls leave. */}
          <label className="ing-web-filter ing-web-filter-grow">
            <span className="ing-web-filter-label">Author</span>
            <input
              className="ing-web-text"
              data-testid="papers-author"
              placeholder="any name, comma-separated"
              aria-label="Author name contains"
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              onBlur={commitRanges}
              onKeyDown={(e) => e.key === 'Enter' && commitRanges()}
            />
          </label>
        </div>
        )}
      </div>

      {mode === 'meaning' ? (
        <SemanticResults
          state={semantic}
          query={query}
          coverage={coverage.data}
          onOpenWork={onOpenWork}
        />
      ) : (
      <div className="search-layout">
        <aside className="facet-panel" data-testid="facet-panel">
          <DataView
            state={facets}
            isEmpty={() => false}
            skeleton={<div className="empty">Loading facets…</div>}
          >
            {(f) => (
              <>
                {FACET_KEYS.map(({ key, label }) =>
                  key === 'year' ? (
                    <YearFacet
                      key={key}
                      buckets={f.year}
                      selected={facetValues(filters, 'year')}
                      onToggle={(v) => narrow('year', v)}
                    />
                  ) : (
                    <FacetGroup
                      key={key}
                      title={label}
                      buckets={f[key]}
                      selected={facetValues(filters, key)}
                      onToggle={(v) => narrow(key, v)}
                      format={key === 'work_type' ? workTypeLabel : undefined}
                    />
                  )
                )}
              </>
            )}
          </DataView>

          <div className="saved-searches">
            <div className="eyebrow">Search history</div>
            {historyUnwritten && (
              <div className="saved-unwritten" data-testid="search-history-unwritten" role="alert">
                <svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M10 2.6L18 16.6H2z" />
                  <path d="M10 8v3.6" />
                  <path d="M10 14.1v.1" />
                </svg>
                Your last search is not in this list — it could not be saved.
              </div>
            )}
            {saved.data && saved.data.length > 0 ? (
              saved.data.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="saved-row"
                  data-testid={`saved-search-${s.id}`}
                  data-tip="Run this search again, with the filters and sort it used."
                  onClick={() => restore(s)}
                >
                  {s.name}
                </button>
              ))
            ) : (
              <div className="empty">Searches you run appear here.</div>
            )}
          </div>
        </aside>

        <div className="search-results">
          <div className="pap-status">
            {/* Result counts change without moving focus (a chip stays focused),
                so the count line announces itself. */}
            <span className="pap-count" data-testid="papers-count" aria-live="polite">
              {matched.data === null
                ? 'Loading papers…'
                : isNarrowed
                  ? `${matched.data} of ${total.data ?? matched.data} papers match`
                  : `All ${matched.data} papers`}
            </span>
            {/* The list is paged; saying so is the honest alternative to a
                count that silently stops at the cap. */}
            {results.data && matched.data !== null && results.data.length < matched.data && (
              <span className="pap-capped" data-testid="papers-capped">
                showing the first {results.data.length}
              </span>
            )}
            {nActive > 0 && (
              <span className="pap-active" data-testid="papers-active-filters">
                {nActive} filter{nActive === 1 ? '' : 's'} active
              </span>
            )}
            {isNarrowed && (
              <>
                <button
                  type="button"
                  className="btn-link pap-clear"
                  data-testid="papers-clear-filters"
                  onClick={clearAll}
                >
                  Clear all
                </button>
              </>
            )}
          </div>

          <DataView
            state={results}
            isEmpty={(d) => d.length === 0}
            empty={
              <EmptyState
                title={isNarrowed ? 'No papers match.' : 'No papers in this project yet.'}
                hint={
                  isNarrowed
                    ? 'Relax a filter or clear all to widen the view.'
                    : 'Import papers below and they will appear here.'
                }
                testid="search-no-results"
              />
            }
          >
            {(list) => (
              <div className="result-list">
                {list.map((r) => (
                  <div
                    key={r.work_id}
                    className="result-row"
                    data-testid={`search-result-${r.work_id}`}
                  >
                    {/* Opening is a button stretched over the row rather than
                        the row itself, so the grid can lay the text and the
                        number rail out independently of the click target. */}
                    <button
                      type="button"
                      className="result-open"
                      data-testid={`search-open-${r.work_id}`}
                      aria-label={`Open ${plainText(r.title)}`}
                      onClick={() => onOpenWork(r.work_id)}
                    />
                    {/* Three tiers, not one run-on line: WHAT it is, WHO wrote
                        it, and the numbers that ordered the list — which sit in
                        their own rail so the eye can scan down them. */}
                    <div className="result-main">
                      <div className="result-title"><RichText text={r.title} /></div>
                      {r.authors.length > 0 && (
                        <div className="result-authors">{authorLine(r.authors)}</div>
                      )}
                      <div className="result-meta">
                        <span className="result-venue">{r.venue ?? 'no venue'}</span>
                        <span className="result-type">{workTypeLabel(r.work_type)}</span>
                      </div>
                      {r.snippet && <div className="result-snippet">{r.snippet}</div>}
                    </div>
                    <div className="result-side">
                      <span className="result-year mono">{r.year ?? '—'}</span>
                      <span
                        className="result-cites mono"
                        data-tip="How many papers in THIS corpus cite it."
                      >
                        {r.citation_count} cited
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </DataView>
        </div>
      </div>
      )}

    </section>
  )
}

/**
 * Year facet. A corpus of ~20 works produces ~13 year buckets each with count 1
 * — a wall of noise. Group them into decades by default (counts summed, so
 * nothing is hidden) with an explicit toggle to the exact years. Both the decade
 * label and an exact year are understood by the repository's year filter.
 */
function YearFacet({
  buckets,
  selected,
  onToggle
}: {
  buckets: { value: string; count: number }[]
  selected: string[]
  onToggle: (value: string) => void
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  if (buckets.length <= 6 || expanded) {
    return (
      <FacetGroup
        title="Year"
        buckets={buckets}
        selected={selected}
        onToggle={onToggle}
        action={
          buckets.length > 6 ? (
            <button type="button" className="btn-link facet-toggle" onClick={() => setExpanded(false)}>
              group
            </button>
          ) : undefined
        }
      />
    )
  }
  const byDecade = new Map<number, number>()
  for (const b of buckets) {
    const y = Number(b.value)
    if (!Number.isFinite(y)) continue
    const d = Math.floor(y / 10) * 10
    byDecade.set(d, (byDecade.get(d) ?? 0) + b.count)
  }
  const grouped = [...byDecade.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([d, count]) => ({ value: decadeLabel(d), count }))
  return (
    <FacetGroup
      title="Year"
      buckets={grouped}
      selected={selected}
      onToggle={onToggle}
      action={
        <button type="button" className="btn-link facet-toggle" onClick={() => setExpanded(true)}>
          all {buckets.length} years
        </button>
      }
    />
  )
}

/**
 * A multi-select facet. Each bucket is a real <button> with `aria-pressed`, so
 * it is keyboard-operable and its state is announced — the selection is NOT
 * signalled by colour alone: pressed chips also carry a check mark and the
 * result line reports how many filters are active.
 */
function FacetGroup({
  title,
  buckets,
  selected,
  onToggle,
  action,
  // The stored value is what gets filtered on; how it READS is a separate
  // question, and the work_type vocabulary answers it in one place.
  format = (v) => v
}: {
  title: string
  buckets: { value: string; count: number }[]
  selected: string[]
  onToggle: (value: string) => void
  action?: JSX.Element
  format?: (value: string) => string
}): JSX.Element {
  return (
    <div className="facet-group" role="group" aria-label={`Filter by ${title.toLowerCase()}`}>
      <div className="facet-group-head">
        <div className="eyebrow">{title}</div>
        {action}
      </div>
      {buckets.length === 0 && <div className="empty">—</div>}
      {buckets.map((b) => {
        const on = selected.includes(b.value)
        return (
          <button
            key={b.value}
            type="button"
            className={`facet-row ${on ? 'is-on' : ''}`}
            data-testid={`facet-chip-${b.value}`}
            aria-pressed={on}
            // The count is folded into the accessible name; a bare badge would
            // read as a naked number to a screen reader.
            aria-label={`${title}: ${format(b.value)}, ${b.count} paper${b.count === 1 ? '' : 's'}`}
            onClick={() => onToggle(b.value)}
          >
            <span className="facet-check" aria-hidden="true">
              {on ? '✓' : ''}
            </span>
            <span className="facet-value">{format(b.value)}</span>
            <span className="badge muted facet-count" aria-hidden="true">
              {b.count}
            </span>
          </button>
        )
      })}
    </div>
  )
}

// ------------------------------------------------------------ web search
//
// Describing a paper you do NOT have yet, as opposed to naming one you already
// found somewhere else — which is the identifier tab, and is core. This runs
// over EXTERNAL indexes through a search PLUGIN, so its hits carry no work_id
// and cannot be opened, only imported.
/**
 * The message main actually threw, without Electron's IPC wrapper.
 *
 * `ipcRenderer.invoke` rejects with `Error invoking remote method 'search:web':
 * Error: <real message>` — the part the user needs is at the END, behind two
 * layers of plumbing they cannot act on. When a search source is down the whole
 * value of the error is its instruction ("the web-search server at … is not
 * reachable"), so it must lead.
 */
function ipcMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return raw.replace(/^Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?/, '')
}

/**
 * Results of the external search, each importable in place.
 *
 * A row that has been imported STAYS in the list: the list is what the search
 * found, not a queue of pending work, and silently removing a row would hide
 * the fact that the import is still only queued. The in-flight control is the
 * spinner with an X in it — one shape for start, progress and cancel — so the
 * row never grows or reflows as its state changes.
 */
/**
 * EXPORTED so the setup questionnaire shows the same search, not a second one.
 *
 * Left in this file rather than moved to its own: it shares `authorLine`,
 * `WebSearchSkeleton` and `noteworthyType` with the corpus-side finder above it,
 * and hoisting one caller out would split those three across two modules for no
 * gain. What matters is that there is ONE search panel, and both callers mount
 * it — a copy on the setup page would drift the moment either was fixed.
 */
export /**
 * What one importing row is doing right now, in the reader's terms.
 *
 * `done` and `failed` are TERMINAL and take the row out of its spinner — the
 * absence of any such state is what left the old spinner turning forever.
 */
interface WebImportProgress {
  state: 'working' | 'done' | 'failed'
  /** Shown on the row. Short enough to sit in a button-sized slot. */
  label: string
  /** The longer version, on hover. Null when the label says it all. */
  tip: string | null
}

/**
 * The pipeline stage a paper is on, said plainly.
 *
 * NOT every stage: the reader of a search result cares whether their paper is
 * arriving, not that the app is embedding vectors or resolving citations. The
 * stages that mean something to them get a word; the rest fall back to a single
 * honest "Reading…", because a row that names `citation-contexts` at someone
 * who asked for a paper is noise wearing the clothes of detail.
 */
/**
 * The stages that decide whether the paper ARRIVES.
 *
 * Only a failure among these means "your paper is not there". Everything after
 * them operates on a paper already in the project — a refused extraction, a
 * summary that could not reach a model — and reporting those as a failed
 * IMPORT would be wrong about the one thing this row is claiming.
 */
const ARRIVAL_STAGES = new Set(['retrieve', 'download', 'optimize', 'extract-text', 'ocr'])

const IMPORT_STAGE_LABEL: Record<string, string> = {
  retrieve: 'Finding PDF…',
  download: 'Downloading…',
  optimize: 'Downloading…',
  'extract-text': 'Reading…',
  ocr: 'Reading…',
  segment: 'Reading…',
  embed: 'Indexing…',
  summarise: 'Summarising…'
}

/**
 * The page numbers to OFFER, given how many have been retrieved.
 *
 * Every page up to a handful; beyond that the first, the last, and a window
 * around where the reader is, with gaps marked. A row of forty numbers is not a
 * navigation aid — it is a wall the eye has to parse before it can find the one
 * number that matters, which is the current one.
 *
 * `more` — the indexes have not run out — extends the row with `PAGES_AHEAD`
 * REAL NUMBERS past what has been fetched. These numbers count what is in hand,
 * not what exists, so a row ending at the last fetched page is a claim that
 * there are no more: the reader who wants the next one has been told, in the
 * only place that addresses the question, that it is not there.
 *
 * NUMBERS RATHER THAN AN ELLIPSIS, which is what this first shipped as. A "⋯"
 * states that more exist while offering nothing to press, so the reader still
 * has to find Next and press it once per page; and at a glance it reads as a
 * rendering artefact next to the digits, which is exactly how it was received.
 * A number is the thing being asked for, and it is pressable.
 */
function pageWindow(page: number, count: number, more: boolean): (number | 'gap')[] {
  const last = more ? count + PAGES_AHEAD : count
  const out: (number | 'gap')[] = []
  if (last <= 7) {
    for (let i = 1; i <= last; i++) out.push(i)
    return out
  }
  out.push(1)
  const from = Math.max(2, Math.min(page - 1, last - 4))
  const to = Math.min(last - 1, Math.max(page + 1, 5))
  if (from > 2) out.push('gap')
  for (let i = from; i <= to; i++) out.push(i)
  if (to < last - 1) out.push('gap')
  out.push(last)
  return out
}

/**
 * Pages over the web-search results.
 *
 * The forward step means two different things and must not look like one: to a
 * page already retrieved it is instant, and past the last one it goes back to
 * the indexes — so it carries the busy and failed states, while the numbers
 * beside it never do.
 *
 * `pageCount` counts what has been RETRIEVED. While `exhausted` is false the
 * last number is not the last page there is, which is why forward stays
 * available past it and no total is claimed anywhere.
 */
function WebSearchPager({
  page,
  pageCount,
  exhausted,
  busy,
  failed,
  onGo
}: {
  page: number
  pageCount: number
  exhausted: boolean
  busy: boolean
  failed: boolean
  onGo: (n: number) => void
}): JSX.Element {
  const canBack = page > 1
  const canFwd = page < pageCount || !exhausted
  return (
    <nav className="ing-web-pager" data-testid="websearch-pager" aria-label="Result pages">
      <button
        type="button"
        className="btn ing-web-page-step"
        data-testid="websearch-page-prev"
        disabled={!canBack || busy}
        data-tip={canBack ? undefined : 'You are on the first page.'}
        onClick={() => onGo(page - 1)}
      >
        <span aria-hidden="true">‹</span> Back
      </button>
      <div className="ing-web-page-nums">
        {pageWindow(page, pageCount, !exhausted).map((p, i) => {
          if (p === 'gap') {
            return (
              <span className="ing-web-page-gap" aria-hidden="true" key={`gap-${i}`}>
                {/* U+22EF (MIDLINE HORIZONTAL ELLIPSIS), not U+2026. The
                    ordinary ellipsis sits ON THE BASELINE, which in a row of
                    digits centred in a 30px box renders as an underscore
                    dropped below the numbers. */}
                ⋯
              </span>
            )
          }
          // NOT YET FETCHED. Pressing it works — it fetches and goes there —
          // but it is drawn lighter, because it is a page the app expects to
          // find rather than one it is holding. The reader can see where the
          // known results end without that boundary being a wall.
          const unfetched = p > pageCount
          return (
            <button
              type="button"
              key={p}
              className={`ing-web-page-num ${p === page ? 'is-current' : ''} ${
                unfetched ? 'is-unfetched' : ''
              }`}
              data-testid={`websearch-page-${p}`}
              aria-current={p === page ? 'page' : undefined}
              disabled={busy}
              onClick={() => onGo(p)}
            >
              {p}
            </button>
          )
        })}
      </div>
      <button
        type="button"
        className={`btn ing-web-page-step ${busy ? 'is-busy' : ''} ${
          failed && !busy ? 'is-failed' : ''
        }`}
        data-testid="websearch-page-next"
        disabled={!canFwd || busy}
        data-tip={
          canFwd
            ? page >= pageCount
              ? 'Ask the indexes for more papers'
              : undefined
            : 'That is everything these indexes have for this search.'
        }
        onClick={() => onGo(page + 1)}
      >
        {busy && <span className="ing-web-more-spin" aria-hidden="true" />}
        {busy ? 'Searching…' : failed ? 'Try again' : 'Next'}
        {!busy && !failed && <span aria-hidden="true"> ›</span>}
      </button>
    </nav>
  )
}

export function WebSearchPanel({
  projectId,
  onQueued
}: {
  projectId: number
  onQueued: () => void
}): JSX.Element {
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  // external_id → the job id currently importing that row. Purely ephemeral UI
  // state: the durable record is the job row itself, read back by the queue.
  const [jobIds, setJobIds] = useState<Record<string, number>>({})
  const [pending, setPending] = useState<Record<string, true>>({})
  /**
   * WHAT EACH IMPORTING ROW IS ACTUALLY DOING, read from its job.
   *
   * The row used to show a spinner from the moment the job was queued and had
   * nothing that could ever take it down again: `jobIds` was set on queue and
   * cleared only by CANCEL. So a paper that downloaded, parsed and finished
   * perfectly still spun, forever, and the only reading available to the user
   * was that the import had hung — while the paper sat in their library.
   *
   * Keyed by external_id like the two above, and refreshed on the queue's own
   * change event rather than a timer: that event fires on every job transition,
   * which is exactly when this text changes.
   */
  const [progress, setProgress] = useState<Record<string, WebImportProgress>>({})
  /**
   * external_id → the work this row imported, and the job the import began at.
   *
   * THE JOB ID IS A WATERMARK, and it is what keeps this row's report about
   * THIS import. A paper the library already holds carries its whole history —
   * a `review-records` that failed yesterday, a stage cancelled last week — and
   * reading all of it announced "Failed" over a paper that had in fact just
   * arrived perfectly well. Job ids are monotonic, so "planned by this import"
   * is exactly "id >= the one `ingest` returned".
   */
  const [workIds, setWorkIds] = useState<Record<string, { workId: number; fromJobId: number }>>({})
  const [err, setErr] = useState<string | null>(null)

  // Filters are DRAFT state applied on submit, like the query itself: a search
  // is one deliberate act, so changing three fields must not fire three
  // searches. Sort is the exception — it reorders what is already on screen.
  const [yearFrom, setYearFrom] = useState('')
  const [yearTo, setYearTo] = useState('')
  const [minCites, setMinCites] = useState('')
  const [author, setAuthor] = useState('')
  const [sort, setSort] = useState<WebSearchSort>('relevance')
  /**
   * Which indexes to SHOW. Purely local: the search always asks every index, and
   * this narrows what came back. Making it a query parameter would mean a new
   * round trip to hide rows already in hand, and would change the meaning of the
   * page counter under the user.
   */
  const [pickedSources, setPickedSources] = useState<Set<string>>(new Set())
  /** The filters the CURRENT results were fetched with. */
  const [applied, setApplied] = useState<WebSearchFilters>({})

  const num = (s: string): number | undefined => {
    const n = Number.parseInt(s.trim(), 10)
    return Number.isFinite(n) ? n : undefined
  }

  const submit = (): void => {
    setApplied({
      yearFrom: num(yearFrom),
      yearTo: num(yearTo),
      minCitations: num(minCites),
      author: author.trim() || undefined
    })
    setQuery(draft)
  }

  const clearFilters = (): void => {
    setYearFrom('')
    setYearTo('')
    setMinCites('')
    setAuthor('')
    setApplied({})
    setPickedSources(new Set())
  }

  const activeFilters =
    (applied.yearFrom !== undefined ? 1 : 0) +
    (applied.yearTo !== undefined ? 1 : 0) +
    (applied.minCitations !== undefined ? 1 : 0) +
    (applied.author ? 1 : 0) +
    // Counted with the rest even though it never reaches the query, because the
    // user is told "N filters applied" about what they are LOOKING AT, and an
    // empty page whose cause is unlisted is the failure that count exists to
    // prevent.
    (pickedSources.size > 0 ? 1 : 0)

  const appliedKey = JSON.stringify(applied)
  const results = useAsync<WebSearchResultDTO[]>(
    () =>
      query.trim()
        ? window.api
            .searchWeb(query, { ...applied, sort, limit: FETCH_SIZE, page: 1, projectId })
            .catch((e: unknown) => Promise.reject(new Error(ipcMessage(e))))
        : Promise.resolve([]),
    [query, appliedKey, sort]
  )

  // Later fetches are APPENDED to the first rather than replacing it, so the
  // pager can walk back and forth over everything retrieved so far without
  // asking the indexes again. `useAsync` owns the first fetch only.
  const [more, setMore] = useState<WebSearchResultDTO[]>([])
  const [fetched, setFetched] = useState(1)
  /** Which PAGE of the merged list the reader is on, 1-based. */
  const [pageNo, setPageNo] = useState(1)
  const [loadingMore, setLoadingMore] = useState(false)
  /** Set once an upstream stops offering new papers, so the pager can stop. */
  const [exhausted, setExhausted] = useState(false)
  /**
   * The last fetch of further results failed.
   *
   * Distinct from `exhausted`: there may well be more papers — the fetch is what
   * broke. The pager keeps offering the step forward, relabelled, so the user is
   * not left pressing a control that looks like it did nothing.
   */
  const [moreFailed, setMoreFailed] = useState(false)
  /** Rows whose abstract the reader has opened. */
  const [openAbstracts, setOpenAbstracts] = useState<Record<string, true>>({})
  /**
   * The results list, so turning a page puts the reader at the TOP of it.
   *
   * Without it they keep the scroll offset of the page they left and land in the
   * middle of the new one — with the first rows of it above the fold, which
   * reads as a page that starts at paper 12.
   */
  const listRef = useRef<HTMLDivElement | null>(null)

  // A new search invalidates every accumulated page: they were fetched for the
  // OLD query/filters/sort and would otherwise linger below the new results.
  useEffect(() => {
    setMore([])
    setFetched(1)
    setPageNo(1)
    setExhausted(false)
    setOpenAbstracts({})
    // Cleared with the results it narrowed. A new query can perfectly well
    // return nothing from the index that was ticked, and carrying the choice
    // over would show the user an empty page for a search that found papers.
    setPickedSources(new Set())
    // The message belonged to the PREVIOUS search. Left standing it would sit
    // under the new results claiming a failure that did not happen.
    setErr(null)
    setMoreFailed(false)
  }, [query, appliedKey, sort])

  const firstPage = results.data ?? EMPTY_RESULTS
  /**
   * Every page merged, with duplicates removed.
   *
   * Paging offsets each INDEX independently, and the indexes overlap heavily —
   * the same paper routinely sits at a different offset in CrossRef than in
   * PubMed — so page 2 legitimately returns papers already shown on page 1.
   * Without this the list would repeat rows, and React would see duplicate keys.
   */
  const list = useMemo(() => {
    const seen = new Set<string>()
    const out: WebSearchResultDTO[] = []
    for (const r of [...firstPage, ...more]) {
      if (seen.has(r.external_id)) continue
      seen.add(r.external_id)
      // A paper is kept if ANY index that returned it is picked. The alternative
      // — requiring every index to be picked — would hide the papers with the
      // best provenance, since a hit confirmed by three indexes is the one most
      // likely to be dropped by an "all of" rule.
      if (pickedSources.size > 0 && !r.sources.some((s) => pickedSources.has(s))) continue
      out.push(r)
    }
    return out
  }, [firstPage, more, pickedSources])

  /**
   * The indexes these results came from, in name order.
   *
   * Built FROM THE RESULTS. Which indexes get queried belongs to
   * whichever plugin is doing the searching, so the app has no list to order by
   * — and a copy kept here could only ever be that plugin's list as it was on
   * the day someone typed it out.
   *
   * So the menu offers exactly what the results contain. An index that answered
   * with nothing for every page is therefore not offered, and the reader cannot
   * tell it from one that was never asked. Closing that needs the plugin to
   * report which indexes it QUERIED alongside the groups it got back; until it
   * does, the menu says less rather than guessing.
   */
  const sourceOptions = useMemo(() => {
    const present = new Set<string>()
    for (const r of [...firstPage, ...more]) for (const s of r.sources) present.add(s)
    return [...present]
      .sort((a, b) => searchSourceName(a).localeCompare(searchSourceName(b)))
      .map((s) => ({
        value: s,
        label: searchSourceName(s),
        disabled: false
      }))
  }, [firstPage, more])

  /** Of those, the ones that actually returned a paper. */
  const answeredSources = useMemo(
    () => sourceOptions.filter((o) => !o.disabled),
    [sourceOptions]
  )

  /**
   * Pages over what has been RETRIEVED, which is not the same as what the
   * indexes hold: the last page is only the last one there is once `exhausted`
   * says the upstreams have stopped offering papers. Until then, stepping off
   * the end fetches.
   *
   * THE REMAINDER IS NOT A PAGE while more may be coming. A hundred retrieved
   * makes three pages of thirty and ten papers over; offering those ten as
   * "page 4" shows a page a third full and — because it is a page that exists —
   * costs the fetch that would have filled it. It becomes the last page only
   * once there is nothing left to fill it with.
   */
  const pageCount = Math.max(
    1,
    exhausted ? Math.ceil(list.length / PAGE_SIZE) : Math.floor(list.length / PAGE_SIZE)
  )
  // A narrowing by source can shorten the list under the reader's feet, and a
  // page number pointing past the end renders as blank — which reads as "your
  // filter found nothing" over a list that has plenty.
  const currentPage = Math.min(pageNo, pageCount)
  const pageStart = (currentPage - 1) * PAGE_SIZE
  const pageRows = useMemo(
    () => list.slice(pageStart, pageStart + PAGE_SIZE),
    [list, pageStart]
  )

  // Page 1 is excluded: it is where a new search lands, and scrolling the
  // reader down to the results the moment they arrive takes the query field
  // they may want to edit off the screen.
  useEffect(() => {
    if (currentPage === 1) return
    listRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [currentPage])

  /**
   * Most fetches one press may make before giving the reader the screen back.
   *
   * A fetch is not guaranteed to add a whole page: the indexes overlap, so a
   * hundred rows can contain a handful of papers this list does not already
   * have. Filling the page therefore takes as many fetches as it takes — but
   * bounded, because the alternative is one press holding four public APIs for
   * as long as they keep answering with duplicates. Hitting the bound leaves the
   * reader on a genuinely short page with the forward step still offered, which
   * is the truth: there may be more, and asking again is one press.
   *
   * Sized for the FURTHEST press the pager offers, which is `PAGES_AHEAD` past
   * the end rather than one: a bound of four was set when every step was a
   * single page, and it would now stop a legitimate jump partway and land the
   * reader short of the number they pressed.
   */
  const MAX_FETCHES_PER_STEP = 4 + PAGES_AHEAD

  /**
   * Fetch until page `n` is FULL, or the indexes stop offering new papers.
   *
   * The reader asked for a page; whether it is in hand, one fetch away or four
   * is our problem, not theirs. Landing them on a page holding three papers
   * because that is what one round trip happened to add would make the page size
   * a property of the upstreams rather than of the app.
   *
   * The accumulators are LOCAL. `more` and `fetched` are state, and state read
   * inside this closure is the value from the render that created it — so a loop
   * driven by them would re-request the same upstream page every time round and
   * conclude, correctly and uselessly, that it was all duplicates.
   */
  const fetchThrough = async (n: number): Promise<void> => {
    if (loadingMore || exhausted) return
    setLoadingMore(true)
    setMoreFailed(false)
    let acc = [...firstPage, ...more]
    let known = new Set(acc.map((r) => r.external_id))
    let upstream = fetched
    let ranOut = false
    try {
      for (let i = 0; i < MAX_FETCHES_PER_STEP && acc.length < n * PAGE_SIZE; i++) {
        upstream += 1
        const rows = await window.api.searchWeb(query, {
          ...applied,
          sort,
          limit: FETCH_SIZE,
          page: upstream,
          projectId
        })
        setFetched(upstream)
        // Judge "more to come" by what is genuinely NEW, not by how many rows
        // came back: a fetch that is entirely duplicates adds nothing, and
        // offering the step forward again would spin without the list growing.
        const fresh = rows.filter((r) => !known.has(r.external_id))
        if (fresh.length === 0) {
          setExhausted(true)
          ranOut = true
          break
        }
        acc = [...acc, ...fresh]
        known = new Set(acc.map((r) => r.external_id))
        setMore((m) => [...m, ...fresh])
      }
      // Land on the furthest page that HAS papers. Asking for 5 and being given
      // 4 is the honest outcome when the indexes ran out mid-step; a blank
      // page 5 would read as a search that lost its results.
      //
      // The remainder counts as a page only if nothing more is coming — the same
      // rule `pageCount` applies, and it has to be the same one or this would
      // land the reader on a page the pager does not believe exists.
      const reachable = Math.max(
        1,
        ranOut ? Math.ceil(acc.length / PAGE_SIZE) : Math.floor(acc.length / PAGE_SIZE)
      )
      setPageNo(Math.min(n, reachable))
    } catch (e: unknown) {
      setErr(ipcMessage(e))
      setMoreFailed(true)
    } finally {
      setLoadingMore(false)
    }
  }

  /**
   * Go to `n`, fetching first if `n` is past what has been retrieved.
   *
   * A page already in hand costs no round trip, which is why one fetch fills
   * several pages: turning to page 2 of what was fetched must not ask the
   * indexes anything.
   */
  const goToPage = (n: number): void => {
    if (n < 1 || loadingMore) return
    if (n <= pageCount) {
      setPageNo(n)
      return
    }
    if (exhausted) return
    void fetchThrough(n)
  }

  /**
   * Follow every importing row's paper through the queue.
   *
   * Driven by `onJobsChanged`, which fires on each job transition — the exact
   * moments this text changes — so there is no timer to tune and no poll
   * running over a screen where nothing is importing.
   *
   * DONE means every stage of that paper has stopped, not that the last one
   * reported success: a paper whose extraction was refused for want of a schema
   * has still arrived, and telling its finder it failed would be a lie about
   * their paper. FAILED is reserved for a stage that genuinely broke.
   */
  const watching = Object.keys(workIds).length > 0
  const refreshProgress = useCallback(() => {
    const entries = Object.entries(workIds)
    if (entries.length === 0) return
    void window.api
      .listJobs(projectId)
      .then((jobs) => {
        setProgress((prev) => {
          const next = { ...prev }
          for (const [externalId, { workId, fromJobId }] of entries) {
            // THIS import's jobs, not the paper's whole history. See the
            // watermark note on `workIds`.
            const mine = jobs.filter((j) => j.work_id === workId && j.id >= fromJobId)
            if (mine.length === 0) continue
            // FAILED means the paper never ARRIVED, which is only the fetching
            // stages. Everything after them is work done ON a paper that is
            // already in the project, so a summary that failed or an extraction
            // refused for want of a schema must not tell the person who added
            // it that their paper is not there — it is, and the queue is where
            // those later failures are handled.
            const failed = mine.find((j) => isOutstandingFailure(j) && ARRIVAL_STAGES.has(j.stage ?? ''))
            if (failed) {
              next[externalId] = {
                state: 'failed',
                label: 'Failed',
                tip: failed.error ?? 'This paper could not be added. Open the queue to retry it.'
              }
              continue
            }
            // A job carrying an OUTCOME has finished, whatever its status says.
            //
            // The queue leaves rows at `status='queued'` with
            // `outcome='succeeded'` — work that ran and settled but was never
            // re-stamped. Reading `status` alone counted every one of those as
            // still in flight, so a row sat on "Reading…" indefinitely over a
            // paper that had completely finished. The outcome is written when
            // the stage actually ends, so it is the honest signal of "done".
            const live =
              mine.find((j) => j.status === 'running' && j.outcome === null) ??
              mine.find(
                (j) => (j.status === 'queued' || j.status === 'blocked') && j.outcome === null
              )
            if (!live) {
              next[externalId] = {
                state: 'done',
                label: 'Added',
                tip: 'This paper is in your project.'
              }
              continue
            }
            next[externalId] = {
              state: 'working',
              label: IMPORT_STAGE_LABEL[live.stage ?? ''] ?? 'Reading…',
              tip: null
            }
          }
          return next
        })
      })
      .catch(() => {
        /* A queue read that fails leaves the last known state on the row. An
           unreadable queue is not evidence that an import stopped. */
      })
  }, [projectId, workIds])

  useEffect(() => {
    if (!watching) return
    refreshProgress()
    return window.api.onJobsChanged(refreshProgress)
  }, [watching, refreshProgress])

  const importOne = (r: WebSearchResultDTO): void => {
    if (pending[r.external_id] || jobIds[r.external_id] !== undefined) return
    setPending((p) => ({ ...p, [r.external_id]: true }))
    setErr(null)
    // The hit is imported through the ORDINARY ingest path, addressed by its
    // DOI where it has one and by title otherwise — no parallel ingest route.
    void window.api
      .ingest({
        projectId,
        kind: r.doi ? 'doi' : 'title',
        value: r.doi ?? r.title
      })
      .then(({ jobId, workId }) => {
        setJobIds((m) => ({ ...m, [r.external_id]: jobId }))
        // THE PAPER, not the one job. `ingest` returns the first job of a chain
        // a dozen long — download, extract, segment, summarise — and watching
        // only that one would report "done" while the paper was still being
        // read. `workId` is what the whole chain hangs off.
        if (workId !== undefined) {
          setWorkIds((m) => ({ ...m, [r.external_id]: { workId, fromJobId: jobId } }))
        }
        // OPTIMISTIC, and replaced within a tick by the queue's own answer.
        // Without it the row shows nothing at all between the click and the
        // first `onJobsChanged`, which is exactly the gap that read as "nothing
        // happened".
        setProgress((m) => ({
          ...m,
          [r.external_id]: { state: 'working', label: 'Adding…', tip: null }
        }))
        onQueued()
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() =>
        setPending((p) => {
          const next = { ...p }
          delete next[r.external_id]
          return next
        })
      )
  }

  const cancelOne = (r: WebSearchResultDTO): void => {
    const id = jobIds[r.external_id]
    if (id === undefined) return
    void window.api
      .cancelJob(id)
      .then(() => {
        // The cancelled job REMAINS in the queue with status "cancelled"; only
        // this row's link to it is dropped, so it offers import again.
        setJobIds((m) => {
          const next = { ...m }
          delete next[r.external_id]
          return next
        })
        // The WATCH goes with it. Left standing, the next queue change would
        // read the cancelled paper's jobs — none of them running, none of them
        // an outstanding failure — and report "Added" about an import the user
        // had just stopped.
        setWorkIds((m) => {
          const next = { ...m }
          delete next[r.external_id]
          return next
        })
        setProgress((m) => {
          const next = { ...m }
          delete next[r.external_id]
          return next
        })
        onQueued()
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
  }

  return (
    <div className="ing-web" data-testid="websearch-panel">
      <div className="ing-input-row">
        {/* Same iconed field as the corpus search: both take words and return a
            list, so they must not look like different kinds of control. */}
        <span className="ing-field">
          <svg
            className="ing-field-icon"
            width="15"
            height="15"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.7}
            aria-hidden="true"
          >
            <circle cx="9" cy="9" r="5.5" />
            <path d="M13.5 13.5L17 17" />
          </svg>
          <input
            className="ing-input ing-input-iconed"
            data-testid="websearch-input"
            value={draft}
            aria-label="Search for new papers by query"
            placeholder="Describe the paper — e.g. directed evolution | thermostable lipase"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
          />
        </span>
        <button
          className="ing-submit"
          data-testid="websearch-submit"
          onClick={submit}
          disabled={draft.trim().length === 0}
        >
          Search
        </button>
      </div>

      {/* Narrowing, on its own row under the query. Enter in any field runs the
          same search the button does, so the whole bar is one form. */}
      <div className="ing-web-filters" data-testid="websearch-filters">
        <label className="ing-web-filter">
          <span className="ing-web-filter-label">Years</span>
          <span className="ing-web-range">
            <input
              className="ing-web-num"
              data-testid="websearch-year-from"
              inputMode="numeric"
              placeholder="from"
              aria-label="Published from year"
              value={yearFrom}
              onChange={(e) => setYearFrom(e.target.value.replace(/[^\d]/g, ''))}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
            <span className="ing-web-dash" aria-hidden="true">
              –
            </span>
            <input
              className="ing-web-num"
              data-testid="websearch-year-to"
              inputMode="numeric"
              placeholder="to"
              aria-label="Published up to year"
              value={yearTo}
              onChange={(e) => setYearTo(e.target.value.replace(/[^\d]/g, ''))}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </span>
        </label>

        <label className="ing-web-filter">
          <span className="ing-web-filter-label">Min. citations</span>
          <input
            className="ing-web-num"
            data-testid="websearch-min-citations"
            inputMode="numeric"
            placeholder="any"
            aria-label="Minimum citation count"
            value={minCites}
            onChange={(e) => setMinCites(e.target.value.replace(/[^\d]/g, ''))}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </label>

        {/* Sort is NOT a draft field: it reorders results already on screen, so
            it applies immediately rather than waiting for a new search. */}
        <div className="ing-web-filter">
          <span className="ing-web-filter-label">Sort</span>
          <Select
            value={sort}
            options={WEB_SORTS}
            onChange={setSort}
            testid="websearch-sort"
            ariaLabel="Sort results"
            className="ing-web-sort"
          />
        </div>

        {/* Present from the first search onward, since its rows are the indexes
            that were ASKED rather than the ones that answered. */}
        {sourceOptions.length > 1 && (
          <div className="ing-web-filter">
            <span className="ing-web-filter-label">Sources</span>
            <MultiSelect
              picked={pickedSources}
              options={sourceOptions}
              onChange={setPickedSources}
              allLabel="All sources"
              testid="websearch-sources"
              ariaLabel="Show results from these indexes only"
              className="ing-web-sort"
            />
          </div>
        )}

        {/* Author keeps `-grow` wherever it sits: it is the one free-text field
            here, so it takes the slack the fixed-width controls leave. */}
        <label className="ing-web-filter ing-web-filter-grow">
          <span className="ing-web-filter-label">Author</span>
          <input
            className="ing-web-text"
            data-testid="websearch-author"
            placeholder="any name, comma-separated"
            aria-label="Author name contains"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </label>

        {activeFilters > 0 && (
          <button
            type="button"
            className="btn-link ing-web-clear"
            data-testid="websearch-clear-filters"
            onClick={clearFilters}
          >
            Clear {activeFilters} filter{activeFilters === 1 ? '' : 's'}
          </button>
        )}
      </div>

      {/* A FAILURE, not a caption. Rendered as muted 11px text it read as an
          aside, so "the web-search server is not reachable" looked like a note
          rather than the reason the list stopped growing. `role="alert"`
          because the user is looking at the button they just pressed, not here. */}
      {err && (
        <p className="ing-web-fail" data-testid="websearch-msg" role="alert">
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinecap="round"
            aria-hidden="true"
          >
            <circle cx="8" cy="8" r="6.4" />
            <path d="M8 5v3.6M8 11h.01" />
          </svg>
          <span>{err}</span>
        </p>
      )}

      {/* One wrapper for every outcome — results, skeleton, empty, error — so
          the gap below the filters is set once and cannot drift apart between
          the states. */}
      {query.trim().length > 0 && (
        <div className="ing-web-out">
        {/* EVERY search shows the skeleton, not only the first.
            `DataView` renders its skeleton for `loading && data === null`, which
            is true once — after that the previous results are still in hand, so
            a second query sat on the old list with nothing moving and no way to
            tell a slow search from a finished one. The wait is the same wait;
            it is only our knowledge of the last answer that differs, and that is
            not a fact about the query being run. */}
        {results.loading && results.data !== null ? (
          <>
            <SearchProgress />
            <WebSearchSkeleton />
          </>
        ) : (
        <DataView
          state={results}
          isEmpty={(d) => d.length === 0}
          skeleton={
            <>
              <SearchProgress />
              <WebSearchSkeleton />
            </>
          }
          empty={
            <EmptyState
              title="Nothing found."
              // Names the likely cause: with filters on, an empty result is far
              // more often the filters than the wording.
              hint={
                activeFilters > 0
                  ? 'No paper matches both your words and these filters. Relax a filter, or clear them all.'
                  : 'Try broader wording — the search matches words in titles and abstracts.'
              }
              testid="websearch-no-results"
            />
          }
        >
          {() => (
            <div className="ing-web-list" ref={listRef}>
              <div className="ing-web-count" aria-live="polite" data-testid="websearch-count">
                {/* "found", not "found outside this project": some of these ARE
                    in the project and are marked as such, so the old wording
                    contradicted the rows underneath it. */}
                {/* "SO FAR" until the indexes have run out, and the two words
                    are the difference between a figure and a claim. This counts
                    what has been FETCHED, and the indexes hold more than one
                    fetch takes — so a bare "100 papers found" tells a reader
                    their search has a hundred results, which is exactly the
                    question they asked and exactly what we do not know. Once
                    `exhausted` says nothing further is offered, the number IS
                    the total and says so plainly. */}
                {list.length} paper{list.length === 1 ? '' : 's'}
                {exhausted ? ' found' : ' so far'}
                {/* Which of them is on screen. Without it, a page of 30 out of
                    100 retrieved reads as a search that found 30. */}
                {list.length > PAGE_SIZE &&
                  ` · showing ${pageStart + 1}–${pageStart + pageRows.length}`}
                {activeFilters > 0 && ` · ${activeFilters} filter${activeFilters === 1 ? '' : 's'} applied`}
              </div>
              {/* The search DID find papers; the Sources choice is hiding all of
                  them. `DataView`'s empty state cannot say this — it judges the
                  fetched rows, and this narrowing happens after. Saying
                  "nothing found" here would blame the query for the user's own
                  filter. */}
              {list.length === 0 && (
                <EmptyState
                  title="No paper from the indexes you picked."
                  hint={`These results came from ${listSearchSources(answeredSources.map((o) => o.value))}. Pick one of those, or show all sources.`}
                  testid="websearch-sources-empty"
                />
              )}
              {pageRows.map((r) => {
                const jobId = jobIds[r.external_id]
                const prog = progress[r.external_id]
                // WORKING, not merely started. The row used to spin on "a job id
                // exists", which nothing ever retracted.
                const inFlight =
                  pending[r.external_id] === true ||
                  (jobId !== undefined && (prog === undefined || prog.state === 'working'))
                // HELD BEFORE THIS SEARCH RAN. Answered in main against the
                // project's own papers, so a paper added in an earlier session
                // — or in another window — cannot be offered a second time.
                const alreadyHeld = r.in_project_work_id !== null && jobId === undefined
                // Already plain text: LaTeX and markup are resolved during
                // normalization in main, so the stored value and the dedup key
                // match what is shown here.
                const abstract = r.abstract
                const open = openAbstracts[r.external_id] === true
                const kind = noteworthyType(r.type)
                const sourceTip =
                  r.sources.length === 1
                    ? `Found in ${searchSourceName(r.sources[0])}`
                    : `The same paper was returned by ${r.sources.length} indexes: ${r.sources.map(searchSourceName).join(', ')}`
                return (
                  <div
                    className={`ing-web-row ${open ? 'is-open' : ''}`}
                    data-testid={`websearch-result-${r.external_id}`}
                    key={r.external_id}
                  >
                    <div className="ing-web-main">
                      {/* A transparent button stretched over the whole row, so
                          ANY of it toggles the abstract — the target is the
                          thing being read, not one word inside it. It is a
                          sibling rather than a wrapper because the row contains
                          its own interactive parts, and nesting a button inside
                          a button is invalid and breaks keyboard traversal.
                          The Import control sits in a later stacking context, so
                          it stays clickable. A paper with no abstract gets no
                          overlay: it would look interactive and then do nothing. */}
                      {abstract && (
                        <button
                          type="button"
                          className="ing-web-open"
                          data-testid={`websearch-expand-${r.external_id}`}
                          aria-expanded={open}
                          aria-label={open ? `Hide the abstract of ${r.title}` : `Read the abstract of ${r.title}`}
                          onClick={() =>
                            setOpenAbstracts((m) => {
                              const next = { ...m }
                              if (next[r.external_id]) delete next[r.external_id]
                              else next[r.external_id] = true
                              return next
                            })
                          }
                        />
                      )}
                      <div className="ing-web-title">
                        <RichText text={r.title} />
                        {abstract && (
                          <svg
                            className="ing-web-chev"
                            width="12"
                            height="12"
                            viewBox="0 0 12 12"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.7"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <path d="M3 4.5L6 7.5L9 4.5" />
                          </svg>
                        )}
                      </div>
                      <div className="ing-web-authors">
                        {authorLine(r.authors) || 'unknown authors'}
                      </div>
                      <div className="ing-web-meta">
                        {/* FIRST, next to the venue rather than exiled to the far
                            end of the row. Pushed right it sat past the DOI with a
                            gap of empty space in between, far enough from the
                            fields it belongs with that it read as unrelated to
                            them — and it answers the same question the venue does:
                            where this paper came from. */}
                        <span className="ing-web-sources" data-tip={sourceTip}>
                          {r.sources.map(searchSourceName).join(' · ')}
                        </span>
                        <span className="result-venue">{r.venue ?? 'no venue'}</span>
                        {/* Directly after the venue because it QUALIFIES it: "bioRxiv ·
                            preprint" is one thought about where this came from, and it
                            reads as a continuation of the venue rather than a new field.
                            Absent on an ordinary article, so most rows are unchanged. */}
                        {kind && <span className="ing-web-kind">{kind}</span>}
                        <span className="result-type">{r.year ?? '—'}</span>
                        <span className="result-type">{r.citation_count} cited</span>
                        {r.doi && <span className="ing-web-doi mono">{r.doi}</span>}
                      </div>
                      {abstract ? (
                        <div className={`ing-web-abstract ${open ? 'is-open' : ''}`}>
                          <RichText text={abstract} />
                        </div>
                      ) : (
                        <div className="ing-web-abstract is-absent">No abstract available.</div>
                      )}
                    </div>
                    <div className="ing-web-side">
                      {inFlight ? (
                        <div className="ing-web-doing">
                          {/* WHAT IS HAPPENING, beside the spinner rather than
                              instead of it. A bare spinner says only "wait",
                              which is indistinguishable from a hang — and this
                              chain runs for a minute or more. */}
                          <span
                            className="ing-web-doing-label"
                            data-testid={`websearch-progress-${r.external_id}`}
                            aria-live="polite"
                          >
                            {prog?.label ?? 'Adding…'}
                          </span>
                          <button
                            type="button"
                            className="ing-web-spin"
                            data-testid={`websearch-cancel-${r.external_id}`}
                            data-tip="Cancel this import"
                            aria-label={`Cancel import of ${plainText(r.title)}`}
                            disabled={jobId === undefined}
                            onClick={() => cancelOne(r)}
                          >
                            <span className="ing-web-spin-ring" aria-hidden="true" />
                            <svg
                              className="ing-web-spin-x"
                              width="12"
                              height="12"
                              viewBox="0 0 12 12"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.8"
                              strokeLinecap="round"
                              aria-hidden="true"
                            >
                              <path d="M3 3l6 6M9 3l-6 6" />
                            </svg>
                          </button>
                        </div>
                      ) : prog?.state === 'done' || alreadyHeld ? (
                        // NOT A BUTTON. The paper is in the project; offering
                        // "Add" again would invite a second copy of it.
                        //
                        // Two ways to be here, shown the same because they mean
                        // the same thing: added JUST NOW in this session, or
                        // already held when the search ran (`in_project_work_id`,
                        // matched in main by the very rule the import dedups
                        // on). Distinguishing them would be a distinction about
                        // WHEN, which is not what the reader is asking.
                        <span
                          className="ing-web-added"
                          data-testid={`websearch-added-${r.external_id}`}
                          data-tip={
                            prog?.tip ?? 'This paper is already in your project.'
                          }
                        >
                          <span className="ing-web-added-tick" aria-hidden="true">
                            ✓
                          </span>
                          {prog?.state === 'done' ? 'Added' : 'In project'}
                        </span>
                      ) : prog?.state === 'failed' ? (
                        // OFFERS THE RETRY, because the paper is not there and
                        // trying again is the only thing the reader can do from
                        // this row.
                        <button
                          type="button"
                          className="ing-web-import is-failed"
                          data-testid={`websearch-retry-${r.external_id}`}
                          data-tip={prog.tip ?? undefined}
                          onClick={() => {
                            setJobIds((m) => {
                              const next = { ...m }
                              delete next[r.external_id]
                              return next
                            })
                            setProgress((m) => {
                              const next = { ...m }
                              delete next[r.external_id]
                              return next
                            })
                            importOne(r)
                          }}
                        >
                          Failed — try again
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="ing-web-import"
                          data-testid={`websearch-import-${r.external_id}`}
                          data-tip="Add this paper to your project"
                          onClick={() => importOne(r)}
                        >
                          Add
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
              {/* The fetch that a step past the last retrieved page triggers.
                  Shown as skeleton rows so the wait sits where the papers will. */}
              {loadingMore && <WebSearchSkeleton rows={3} />}
              {(pageCount > 1 || !exhausted) && (
                <WebSearchPager
                  page={currentPage}
                  pageCount={pageCount}
                  exhausted={exhausted}
                  busy={loadingMore}
                  failed={moreFailed}
                  onGo={goToPage}
                />
              )}
              {exhausted && currentPage === pageCount && (
                <div className="ing-web-end" data-testid="websearch-end">
                  That is everything these indexes have for this search.
                </div>
              )}
            </div>
          )}
        </DataView>
        )}
        </div>
      )}
    </div>
  )
}

export function IngestScreen({
  projectId,
  onOpenWork,
  onFailedCountChanged
}: {
  projectId: number
  onOpenWork: (workId: number) => void
  /** Tell the shell to recompute the sidebar badge after a dismiss/restore. */
  onFailedCountChanged: () => void
}): JSX.Element {
  const [tabKey, setTabKey] = useState<string>(SOURCE_TABS[0].key)
  const [subTab, setSubTab] = useState<SubTab>('query')
  /**
   * Whether anything installed can search for new papers.
   *
   * A CAPABILITY, never a plugin id. Read once and then re-read whenever the
   * plugin host says something changed (`onSharesChanged`, which is the host's
   * one "read again" push and is not only about shares), so switching a search
   * plugin off makes the tab go while the screen is open rather than at the next
   * launch — a tab still there after the thing behind it stopped is a control
   * that fails when pressed.
   *
   * `null` while unknown, and it renders as ABSENT: showing the tab before the
   * answer arrives would make it flicker away on every visit to this screen.
   */
  const [canSearchWeb, setCanSearchWeb] = useState<boolean | null>(null)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  /**
   * The pending answer to "Zotero is connected but not running".
   *
   * Holds the import's own `resolve`, so the modal's buttons decide whether
   * queueing goes ahead rather than the import guessing on the user's behalf.
   * Null when nothing is waiting on that question.
   */
  const [zoteroOffline, setZoteroOffline] = useState<{
    resolve: (proceed: boolean) => void
  } | null>(null)
  const [filter, setFilter] = useState<FilterKey>('all')
  /**
   * Free-text narrowing of the queue by title or DOI.
   *
   * Lives here, ABOVE the `DataView` that renders the rows, so the live
   * `jobs:changed` push — which refetches the list on every queue transition —
   * replaces the DATA without touching the query. A search box owned by the
   * render callback would be remounted and cleared every few seconds on a busy
   * queue, which is exactly when the user needs it.
   */
  const [queueQuery, setQueueQuery] = useState('')
  const queueSearchRef = useRef<HTMLInputElement | null>(null)

  // Gates the pipeline's own explanations. Off for everyone not debugging it.
  const devView = useDevView()

  const jobs = useAsync<JobDTO[]>(() => window.api.listJobs(projectId), [projectId])
  /**
   * The pipeline's stages, from the main-process registry.
   *
   * Fetched ONCE (no project dependency, and deliberately NOT reloaded on
   * `jobs:changed`): the registry is a property of the running build, validated
   * at boot, and identical for every paper — refetching it on every queue
   * transition would be a per-tick round trip for a value that cannot have
   * changed.
   *
   * Until it arrives the rows draw against an empty registry, which yields
   * `legacy` cells for whatever jobs exist rather than a fabricated pipeline.
   */
  const stages = useAsync<StageDefDTO[]>(() => window.api.listStages(), [])
  const stageDefs = stages.data ?? []
  /**
   * Papers whose stored results were produced from inputs that have since
   * changed — an edited schema, a newly attached reference, a different model
   * or prompt. Main resolves the affected work into finished LABELS, so this
   * screen never has to know what a stage id means.
   */
  const stale = useAsync<StaleWorkDTO[]>(() => window.api.staleWorks(projectId), [projectId])
  const staleList = stale.data ?? []
  const staleByWork = useMemo(() => {
    const m = new Map<number, string[]>()
    for (const s of staleList) m.set(s.work_id, s.stages)
    return m
  }, [staleList])
  /**
   * The same rows keyed by stage ID rather than label.
   *
   * `staleByWork` holds what a reader is shown; `rerunStages` takes what the
   * registry calls them. Reusing the labels there would name stages the
   * scheduler has never heard of.
   */
  const staleIdsByWork = useMemo(() => {
    const m = new Map<number, string[]>()
    for (const s of staleList) m.set(s.work_id, s.stage_ids)
    return m
  }, [staleList])
  const reloadQueue = useCallback(() => {
    jobs.reload()
    stages.reload()
    stale.reload()
  }, [jobs.reload, stages.reload, stale.reload])
  const [refreshing, setRefreshing] = useState(false)
  const [retryingAll, setRetryingAll] = useState(false)
  /**
   * Whether the worker is claiming new jobs, and how many are past the point of
   * being stopped.
   *
   * Pausing only stops the queue CLAIMING work; a job already running has no
   * intermediate save point, so aborting it would throw away everything it had
   * done and spend an attempt for nothing. That makes `inFlight` after a pause a
   * fact the user has to be told, not an implementation detail.
   */
  const [queueState, setQueueState] = useState<{ running: boolean; inFlight: number } | null>(null)
  const [queueBusy, setQueueBusy] = useState(false)
  /**
   * A monotonic ticket, so a stale read cannot overwrite a newer one.
   *
   * `jobs:changed` fires this and the pause/resume buttons set the state
   * directly. Without ordering, a background read already in flight when the
   * user pressed Pause could land afterwards and flip the toggle back to
   * "Running" — telling the user their click did nothing.
   */
  const queueStateSeq = useRef(0)
  const applyQueueState = useCallback(
    (ticket: number, value: { running: boolean; inFlight: number } | null) => {
      if (ticket < queueStateSeq.current) return
      queueStateSeq.current = ticket
      setQueueState(value)
    },
    []
  )
  /**
   * The queue's running state could not be READ.
   *
   * `null` already meant "not answered yet", and routing a failure into it made
   * a permanent unknown look like a momentary one: the toggle sat disabled
   * saying "Checking…" forever, and processing that was actually paused was
   * indistinguishable from processing that had simply not been asked about. The
   * two are told apart here, and the unknown one offers a way out.
   */
  const [queueStateUnread, setQueueStateUnread] = useState(false)
  const refreshQueueState = useCallback(() => {
    const ticket = ++queueStateSeq.current
    void window.api
      .getQueueState()
      .then((s) => {
        applyQueueState(ticket, s)
        setQueueStateUnread(false)
      })
      .catch(() => {
        applyQueueState(ticket, null)
        setQueueStateUnread(true)
      })
  }, [applyQueueState])
  useEffect(refreshQueueState, [refreshQueueState])

  /**
   * Redo everything the changed inputs invalidated, one paper at a time.
   *
   * ONLY THE STAGES THAT WENT STALE, which the detector already named on each
   * row. This used to call `reprocessWork(force)`, and that discards EVERY
   * current run of a paper: a changed prompt on one model stage re-fetched the
   * PDF, re-OCR'd it, re-segmented it and re-ran every other model stage on ten
   * papers at once. The button said "Extract" and threw away the download.
   *
   * Narrowing is safe because the cascade from the named stages still retires
   * everything genuinely downstream of them — the pipeline works out what else
   * is affected from the capability graph, which is exactly what it is for.
   *
   * The count reported back counts papers whose stored answers were actually
   * DISCARDED (`superseded_run_ids`). Job ids are not that proof: the planner
   * hands back adopted jobs as readily as new ones, and a re-armed job whose
   * inputs turn out to match settles straight back to done without redoing
   * anything — so counting jobs would promise work that never happens.
   */
  const refreshStale = async (): Promise<void> => {
    if (refreshing || staleList.length === 0) return
    setRefreshing(true)
    setMsg(null)
    try {
      let redone = 0
      let unchanged = 0
      for (const s of staleList) {
        // A row with no stage ids cannot be acted on precisely, and a fallback
        // to the whole paper is the behaviour being removed — so it is counted
        // as nothing to do rather than redone the expensive way. Both halves of
        // a row are filled in one pass, so this should be unreachable; it is a
        // guard against a future shape where they are not.
        if (s.stage_ids.length === 0) {
          unchanged += 1
          continue
        }
        const res = await window.api.rerunStages(s.work_id, s.stage_ids, projectId)
        // A CREATED JOB COUNTS, and not only a discarded run.
        //
        // The most common staleness is a stage with NO run at all — a schema
        // attached since the paper was last processed. There is nothing to
        // supersede for it, so `superseded_run_ids` is empty while the call has
        // just queued the extraction. Counting only discards reported that
        // paper as "already being brought up to date", which is the button
        // claiming it did nothing at the moment it did the most.
        if (res.superseded_run_ids.length > 0 || res.created_job_ids.length > 0) redone += 1
        else unchanged += 1
      }
      // Says what it DID, and mentions the rest only when there was a rest.
      //
      // The old wording read "Redoing 2 papers; 18 turned out to be up to date"
      // under a button that said 20, which reads as the button not working.
      // Those 18 were papers the queue had already picked up between the label
      // being drawn and the button being pressed. The detector no longer counts
      // work already scheduled, so the two numbers agree now; this stays honest
      // for the one that can still slip through mid-press.
      setMsg(
        redone === 0
          ? 'Those papers were already being brought up to date.'
          : `Queued ${redone} paper${redone === 1 ? '' : 's'} to be redone${
              unchanged > 0 ? `; ${unchanged} was already under way.` : '.'
            }`
      )
      reloadQueue()
      refreshQueueState()
    } catch (e) {
      setMsg(`Could not invalidate: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRefreshing(false)
    }
  }

  /**
   * Put every outstanding failure back on the queue, in one press.
   *
   * Retry has always existed PER ROW, which is the wrong shape for the case it
   * is actually needed in: a gateway that was down, or an extension that was
   * disabled, fails every paper it touched, and clearing that meant finding and
   * pressing Retry on each of twenty rows. The failures are almost never
   * independent, so treating them one at a time is treating one event as twenty.
   *
   * DISMISSED FAILURES ARE LEFT ALONE. Dismissing is the user saying they have
   * decided about that paper; a bulk retry that silently un-decided it would
   * make dismissal worthless. `isOutstandingFailure` is the same predicate the
   * failed COUNT uses, so the button acts on exactly what the badge counts.
   */
  const retryAll = async (): Promise<void> => {
    // Failures AND refused retrievals. A paper with no PDF is the commonest
    // thing in this queue a user wants to run again, and it is not a failure —
    // so with only failures here the one bulk control sat disabled in front of
    // sixteen papers it could have fixed. Deduped: a paper can hold both.
    const ids = [...new Set([...failedJobIds, ...refusedRetrievalIds])]
    if (retryingAll || ids.length === 0) return
    setRetryingAll(true)
    setMsg(null)
    try {
      // Sequential, not `Promise.all`: each retry is a write that re-plans, and
      // firing twenty at once at the same tables is contention for no gain — the
      // work itself is done by the queue afterwards either way.
      let ok = 0
      for (const id of ids) {
        try {
          await window.api.retryJob(id)
          ok++
        } catch {
          // One job that will not re-queue must not strand the other nineteen.
          // The tally below reports the shortfall.
        }
      }
      setMsg(
        ok === ids.length
          ? `Queued ${ok} step${ok === 1 ? '' : 's'} to run again.`
          : `Queued ${ok} of ${ids.length} steps; the rest could not be restarted.`
      )
      reloadQueue()
      refreshQueueState()
    } finally {
      setRetryingAll(false)
    }
  }

  // The queue advances in main on its own schedule, so without this the list
  // showed whatever was true when the tab was opened — a job could finish while
  // the user watched it and still read "queued". The same signal fires on pause
  // and resume, which is what keeps the toggle's label honest.
  useJobsChanged(
    useCallback(() => {
      jobs.reload()
      refreshQueueState()
      // A finished stage is exactly when a paper stops needing a refresh, so
      // the label has to be re-derived here or it would linger on rows that
      // have just been brought up to date.
      stale.reload()
    }, [jobs.reload, refreshQueueState, stale.reload])
  )

  /**
   * Deleting a paper destroys its analyses and evidence with no undo, so the
   * first click ARMS the button and the second commits — the same two-step the
   * papers list uses, so the two deletes read as one feature. The armed state
   * expires on its own, which is what makes a mis-click free.
   */
  /**
   * The clock the queue's two timers are read against.
   *
   * Elapsed time is computed at render, so without a tick every duration and
   * every "4 min ago" would freeze at the moment the list was fetched — and the
   * queue refetches only on a job TRANSITION, which for a long-running stage
   * can be minutes apart. It only runs while the Queue tab is on screen — and,
   * once several screens can be mounted at once, only while THIS screen is the
   * one on screen, since a 1 Hz re-render of a subtree nobody is looking at
   * costs a full React pass over the whole queue for no visible change.
   */
  const now = useVisibleNow(tabKey === QUEUE_KEY ? 1000 : 0)

  // Which phase each row has open, keyed by row anchor. Held here rather than
  // inside the row so the panel can be drawn full-width beneath the grid: as a
  // grid child it stretched the chip column and squeezed the paper's title.
  const [openPhaseByRow, setOpenPhaseByRow] = useState<Record<string, string | null>>({})
  const [armedJobDelete, setArmedJobDelete] = useState<number | null>(null)
  // Which row has its source list open. ONE at a time, by row id: several
  // expanded eight-link lists turn the queue into a link farm, and the user is
  // chasing one paper at a time anyway.
  const [openWeb, setOpenWeb] = useState<number | null>(null)
  const [deletingWork, setDeletingWork] = useState<number | null>(null)
  /**
   * The row whose PDF is being attached, and the row a PDF is hovering over.
   *
   * Both keyed by row anchor and both single-valued: one file is being dropped on
   * one paper. `dropTarget` is what makes the drop DISCOVERABLE — a drag with no
   * target feedback is a user guessing whether the row will take the file.
   */
  const [attaching, setAttaching] = useState<number | null>(null)
  const [dropTarget, setDropTarget] = useState<number | null>(null)
  useEffect(() => {
    if (armedJobDelete === null) return
    const h = setTimeout(() => setArmedJobDelete(null), 4000)
    return () => clearTimeout(h)
  }, [armedJobDelete])

  // Narrowing the queue disarms a pending delete. Otherwise a row armed with
  // "Sure?", filtered out of view and brought back within the 4s window would
  // still be armed, and the user's FIRST click on a row they had lost sight of
  // would erase the paper outright.
  useEffect(() => setArmedJobDelete(null), [queueQuery, filter])

  /**
   * Jobs to call out as just-added, and the row to scroll to.
   *
   * Momentary by design: it answers "where did my paper go?" at the instant of
   * arrival. Left on, it would become a permanent decoration that stops meaning
   * "new" — so it clears itself, and the row keeps its ordinary appearance.
   */
  // Whether anything can search the outside world, kept current.
  //
  // The plugin host pushes on every install, enable, disable and removal, so the
  // tab appears and disappears with the thing behind it. A failure resolves to
  // NOT AVAILABLE: an install that cannot be read is one that cannot be relied
  // on, and offering a tab over it would fail on the first press instead.
  useEffect(() => {
    let alive = true
    const read = (): void => {
      void window.api
        .listPlugins()
        .then((list) => {
          if (!alive) return
          setCanSearchWeb(
            list.plugins.some((p) => p.enabled && p.capabilities.includes('paper-search'))
          )
        })
        .catch(() => {
          if (alive) setCanSearchWeb(false)
        })
    }
    read()
    const off = window.api.onSharesChanged(read)
    return () => {
      alive = false
      off()
    }
  }, [])

  const [highlightJobs, setHighlightJobs] = useState<number[]>([])
  const highlightKey = highlightJobs.join(',')
  useEffect(() => {
    if (highlightJobs.length === 0) return
    // Outlasts the CSS flash so the animation is never cut off mid-way.
    const h = setTimeout(() => setHighlightJobs([]), 2600)
    return () => clearTimeout(h)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightKey])

  // Bring the flagged row into view once it has actually rendered — the tab
  // switch and the job list arriving are separate frames, so scrolling at
  // submit time would target a row that does not exist yet.
  //
  // Scrolls ONCE per highlight. The effect re-runs on every job list refetch
  // (the array identity changes), and the queue refetches on every transition,
  // so without this guard a busy queue yanked the viewport back to the
  // highlighted row repeatedly and the user could not scroll away from it.
  const scrolledForRef = useRef<string | null>(null)
  useEffect(() => {
    if (highlightJobs.length === 0) return
    if (scrolledForRef.current === highlightKey) return
    // Found by the row's `data-job-ids` membership, not by a testid built from
    // one job: the row's testid anchors on the pipeline, and a freshly ingested
    // paper's highlighted job is usually NOT that anchor — so a lookup by the
    // highlighted id alone matched nothing and the scroll silently never
    // happened.
    const el = document.querySelector(`[data-job-ids~="${highlightJobs[0]}"]`)
    if (!el) return
    scrolledForRef.current = highlightKey
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightKey, jobs.data])

  const tabs = sourceTabs(canSearchWeb === true)
  // FALLS BACK when the selected tab is no longer there, which is exactly what
  // happens when a search plugin is switched off while this screen is open. The
  // `??` is the whole of the recovery: the user lands on the corpus search
  // rather than on a blank card belonging to a tab that no longer exists.
  const tab = tabs.find((t) => t.key === tabKey) ?? tabs[0]
  const isFileTab = tab.key === 'file'
  const isLibraryTab = tab.key === LIBRARY_KEY
  const isQueueTab = tab.key === QUEUE_KEY
  const isWebTab = tab.key === WEB_KEY
  const isWebQuery = isWebTab && subTab === 'query'

  // Counts only what the user can actually SEE and act on. With library-wide
  // maintenance hidden outside the developer view, a failed sweep would
  // otherwise put a red "1 failed" on the tab and lead to a queue where no
  // failed row exists — a badge pointing at nothing, which is worse than no
  // badge. A corpus sweep re-runs itself on the next batch anyway.
  // PAPERS, not jobs. The queue draws one row per paper and this badge sits
  // beside those rows, so counting jobs made it disagree with what it labels:
  // 20 papers produced "38 failed", because a paper whose download failed also
  // has a failed extraction, embed and segment behind it. The user reads that
  // as 38 things to deal with when there are 20, and the count exceeding the
  // corpus size makes the whole badge look broken.
  //
  // Keyed on `work_id`; a corpus-wide sweep has none and is counted on its own
  // (it is one unit of work, and is only visible in the developer view anyway).
  // The JOB ids behind those papers — what a bulk retry actually acts on. Kept
  // beside the paper count so the button and the badge can never be derived
  // from different sets: the badge says how many papers are affected, the
  // button re-queues every failed step of those papers.
  const failedJobIds = useMemo(
    () =>
      (jobs.data ?? [])
        .filter((j) => isOutstandingFailure(j) && (devView || j.work_id !== null))
        .map((j) => j.id),
    [jobs.data, devView]
  )

  const failedCount = useMemo(() => {
    const works = new Set<number>()
    let corpus = 0
    for (const j of jobs.data ?? []) {
      if (!isOutstandingFailure(j)) continue
      if (j.work_id === null) {
        if (devView) corpus++
        continue
      }
      works.add(j.work_id)
    }
    return works.size + corpus
  }, [jobs.data, devView])

  /**
   * Papers whose pipeline STOPPED ON PURPOSE and could be run again.
   *
   * Counted apart from `failedCount` because a refusal is not a failure — the
   * badge, the sidebar and the project card all agree on that, and widening the
   * failure predicate to cover these would put "16 failed" on a corpus where
   * nothing failed.
   *
   * But the header said "none failed" over sixteen papers with no PDF, and the
   * bulk Retry beside it was disabled and reported "Nothing has failed." Both
   * were true and both were useless: the queue's one bulk affordance sat inert
   * in front of the only thing the user had come to act on, and the sole way
   * forward was to press Retry on each row. So the button acts on failures AND
   * refusals, and says which it found.
   *
   * `retrieve` only. A refused extraction is waiting on a schema the user must
   * attach — re-running it changes nothing and would burn a model call per
   * paper on a conclusion the pipeline already reached. Retrieval is the stage
   * whose inputs the world can change underneath it: a mirror comes back, a
   * server stops 503-ing, an identifier gets added.
   *
   * REFUSALS ONLY, because a FAILED retrieval is already a failure and is
   * already counted and retried as one. `retrieve` fails when it asked every
   * source and got nothing, and refuses when there was nothing to ask; widening
   * this to both would put the same paper in "N failed" and "N without a PDF" at
   * once, so the header would announce more papers than the queue holds and the
   * button beside it would claim to retry each of them twice.
   */
  const refusedRetrievalIds = useMemo(
    () =>
      (jobs.data ?? [])
        .filter((j) => j.outcome === 'refused' && j.stage === 'retrieve' && !j.dismissed)
        .map((j) => j.id),
    [jobs.data]
  )
  const refusedCount = useMemo(() => {
    const works = new Set<number>()
    for (const j of jobs.data ?? []) {
      if (j.outcome !== 'refused' || j.stage !== 'retrieve' || j.dismissed) continue
      if (j.work_id !== null) works.add(j.work_id)
    }
    return works.size
  }, [jobs.data])

  /**
   * Work the queue will pick up, but has not started.
   *
   * Tells "on, and about to do something" apart from "on, with an empty queue" —
   * the difference between a user who should wait and one who should stop
   * waiting. `blocked` counts: it is waiting on a step ahead of it, so the queue
   * genuinely does have work in hand.
   */
  const waitingCount = useMemo(
    () =>
      (jobs.data ?? []).filter(
        (j) => j.status === 'queued' || j.status === 'blocked'
      ).length,
    [jobs.data]
  )

  /**
   * How many papers the text query keeps, out of how many the status tab shows.
   *
   * Computed from the SAME inputs the row list is built from, so the "3 of 24"
   * in the header can never disagree with the number of rows below it — a count
   * derived independently is a count that eventually lies.
   */
  /**
   * The rows, derived ONCE.
   *
   * Memoized on the data and the two filters — deliberately NOT on `now`, which
   * ticks every second while the tab is open. Rebuilding and re-sorting every
   * pipeline on each tick is work proportional to the whole queue, and the
   * standing rule here is that the list is never capped, so "the queue is big"
   * is the normal case rather than the edge one.
   */
  const queuePipelines = useMemo(() => {
    const byStatus = buildPipelines(jobs.data ?? [], stageDefs)
      // Library-wide maintenance is hidden unless the developer view is on.
      // This queue answers "what is happening to MY PAPERS", and a corpus sweep
      // is not about any of them: it is the app keeping its own indexes in
      // order, needs no decision, and sat among the papers as a row the user
      // could neither act on nor recognise.
      .filter((p) => devView || p.kind !== 'corpus')
      .filter((p) => p.jobs.some((j) => matchesFilter(j, filter)))
    const q = queueQuery.trim()
    if (q === '') return { byStatus, shown: byStatus }
    const folded = foldText(q)
    const doi = foldDoi(q)
    return { byStatus, shown: byStatus.filter((p) => matchesQuery(p, folded, doi)) }
  }, [jobs.data, stageDefs, filter, queueQuery, devView])

  // The header's "3 of 24" reads from the SAME derivation as the rows below it,
  // so the two can never disagree. It counts ROWS — including a corpus row —
  // because it sits beside the filter field and describes what that field is
  // narrowing. Counting only papers would let it read "0 of 24" while a row the
  // query plainly matched is on screen underneath it.
  const queueCounts = {
    shown: queuePipelines.shown.length,
    total: queuePipelines.byStatus.length
  }

  const selectTab = (t: SourceTab): void => {
    setTabKey(t.key)
    setMsg(null)
  }

  /**
   * Ask about Zotero BEFORE queueing, when this project sends papers to it.
   *
   * The gate lives here because `queuePaths` is the single funnel every import
   * on this screen goes through — pasted identifiers, dropped files, and the
   * retriever's results alike — so covering it covers all of them without each
   * caller having to remember. A project with no connection never sees any of
   * this: the check costs one loopback call and answers immediately.
   *
   * Asked BEFORE rather than reported after, because the point of the connection
   * is that a paper reaches the user's library. Finding out afterwards that
   * thirty did not, and having to work out which, is the outcome this prevents.
   *
   * Resolves to whether the import may proceed — decided by the modal's own
   * answers: a retry that found Zotero, or turning the connection off.
   */
  const zoteroGate = async (): Promise<boolean> => {
    const conn = await window.api.getZoteroConnection(projectId).catch(() => null)
    if (conn === null || !conn.connected || conn.running) return true
    return new Promise<boolean>((resolve) => {
      setZoteroOffline((pending) => {
        // A SECOND import while the question is still open is refused rather
        // than allowed to replace the first. Overwriting would strand the
        // earlier `resolve`, whose caller is still awaiting it: that import
        // would never settle and the screen would sit busy until a reload.
        // One question, one answer, and the loser is told nothing happened.
        if (pending !== null) {
          resolve(false)
          return pending
        }
        return { resolve }
      })
    })
  }

  /** Queue one ingest per line, classifying each line into a real ingest kind. */
  const queuePaths = async (items: string[], forcedKind?: Kind): Promise<void> => {
    if (items.length === 0) return
    if (!(await zoteroGate())) return
    setBusy(true)
    setMsg(null)
    try {
      const resolved: string[] = []
      const queued: number[] = []
      for (const v of items) {
        const k = forcedKind ?? (isFileTab ? kindForPath(v) : inferKind(v))
        const res = await window.api.ingest({ projectId, kind: k, value: v })
        if (res.resolvedTitle) resolved.push(res.resolvedTitle)
        queued.push(res.jobId)
      }
      // Says WHERE it went: the queue is its own tab now, so a bare "Queued 3
      // items" would name a place the user can no longer see from here.
      //
      // For a single identifier it also says WHICH paper was found. An
      // identifier is opaque — the user cannot tell a correct lookup from a
      // wrong one without seeing the title it resolved to.
      setMsg(
        resolved.length === 1 && items.length === 1
          ? `Found “${resolved[0]}” — queued.`
          : `Queued ${items.length} item${items.length === 1 ? '' : 's'}.`
      )
      jobs.reload()
      // Follow the work: the queue is where the paper now lives, and telling
      // the user to go look at another tab is a worse answer than taking them
      // there. The new rows are flagged so they can be picked out of a queue
      // that may already hold dozens.
      setHighlightJobs(queued)
      // Clear the text filter: queueing is an explicit "show me this paper",
      // and a filter left from an earlier search would hide the row the user
      // was just sent here to see — they would land on the queue, read a
      // success notice, and find nothing.
      setQueueQuery('')
      setTabKey(QUEUE_KEY)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const submit = async (): Promise<void> => {
    const items = value
      .split('\n')
      .map((v) => v.trim())
      .filter(Boolean)
    if (items.length === 0) return
    await queuePaths(items)
    setValue('')
  }

  // Shared by drop and by the native picker. A dropped DIRECTORY has no usable
  // File contents, so the paths are handed to main, which expands each one into
  // the PDFs it stands for (recursively) before anything is queued.
  const acceptFiles = (files: File[]): void => {
    if (files.length === 0) return
    const paths = files.map(filePath).filter((p): p is string => p !== null)
    if (paths.length === 0) {
      setMsg(
        `Could not read a filesystem path for "${files[0].name}". Paste its absolute path in the field below and press Import & analyze.`
      )
      return
    }
    setBusy(true)
    void window.api
      .expandIngestPaths(paths)
      .then((pdfs) => {
        if (pdfs.length === 0) {
          // Say WHAT was dropped rather than a generic failure: an empty folder
          // and an unreadable one look identical otherwise.
          setMsg(`No PDFs found in ${paths.length === 1 ? paths[0] : `${paths.length} dropped items`}.`)
          return
        }
        void queuePaths(pdfs, 'pdf')
      })
      .catch((e: unknown) => setMsg(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }

  // Ask MAIN to open the native picker. A hidden <input type=file> cannot be
  // used here: `ingest` addresses a PDF by absolute path, and since Electron 33
  // dropped the `File.path` augmentation the renderer never learns one — the
  // browse button would look functional and queue nothing. Main returns real
  // paths (and an empty list on cancel, which is not an error).
  const openPicker = (): void => {
    void window.api
      .pickIngestFiles()
      .then((paths) => {
        if (paths.length > 0) void queuePaths(paths, 'pdf')
        else setMsg(null)
      })
      .catch((err: unknown) => {
        setMsg(err instanceof Error ? err.message : String(err))
      })
  }

  /**
   * A RETRY ALWAYS ANSWERS. It never consumes the press and does nothing.
   *
   * This used to be `retryJob(id).then(jobs.reload)` with no catch. `retry()` in
   * the scheduler THROWS for two ordinary reasons — the job is gone, or it has
   * since settled into a status that cannot be re-queued — and on either the
   * rejection became an unhandled promise, `jobs.reload` never ran, and the
   * button swallowed the click with nothing on screen changing. Pressing it
   * again did the same, so the control read as dead.
   *
   * The row's state can be STALE, which is what makes this reachable rather than
   * theoretical: the list refreshes on a timer, so a job that finished, or was
   * retried from the bulk button, or was cancelled in another window, still
   * offers Retry until the next poll. The press is then genuinely too late — and
   * "too late" is a thing to be told, not a reason to go quiet.
   *
   * The list is reloaded on BOTH paths: after a failure it is the reload that
   * replaces the stale row with the truth, which is most of the answer.
   */
  const retry = (ids: readonly number[]): void => {
    if (ids.length === 0) return
    setMsg(null)
    void (async () => {
      let ok = 0
      let lastErr: unknown = null
      // AS GIVEN, and sequentially. The caller has already put these in PIPELINE
      // order, which is the order that matters: the earliest is retried first
      // and its cascade revives whatever downstream it cancelled, so by the time
      // a later one comes round it is usually already queued and the scheduler
      // rejects it. That rejection is expected rather than a fault, which is why
      // only a press that re-queued NOTHING is reported as a problem.
      //
      // NOT re-sorted by id here. An id says when a row was written, and a stage
      // added after a corpus was imported holds the highest ids in the table —
      // sorting by them ran the newest step last, after the steps that follow
      // it, which is the reverse of what this loop is for.
      for (const id of ids) {
        try {
          await window.api.retryJob(id)
          ok++
        } catch (err) {
          lastErr = err
        }
      }
      if (ok > 0) setMsg(`Queued ${ok} step${ok === 1 ? '' : 's'} to run again.`)
      else
        setMsg(
          `Could not restart this paper: ${
            lastErr instanceof Error ? lastErr.message : String(lastErr)
          }`
        )
      jobs.reload()
      refreshQueueState()
    })()
  }
  /**
   * Same contract as `retry` above, for the same reason: a press is answered.
   *
   * `cancel()` throws on a job that is already gone or already settled, and the
   * row offering the button can be a poll behind. Without a catch the rejection
   * was unhandled, the reload never ran, and the button looked broken at exactly
   * the moment the user most wanted it to work.
   */
  const cancel = (id: number): void => {
    setMsg(null)
    void window.api
      .cancelJob(id)
      .then(() => {
        setMsg('Cancelled.')
      })
      .catch((err: unknown) => {
        setMsg(
          `Could not cancel this step: ${err instanceof Error ? err.message : String(err)}`
        )
      })
      .finally(() => {
        jobs.reload()
        refreshQueueState()
      })
  }
  /**
   * First click arms, second erases the paper.
   *
   * Armed against the ROW's anchor id, never against the job the buttons happen
   * to address: the addressed job advances as the pipeline runs, so an arm
   * recorded under it would expire mid-window and flip the button back from
   * "Sure?" to "Delete" with no explanation.
   */
  const deletePaper = (rowId: number, workId: number, title: string): void => {
    if (armedJobDelete !== rowId) {
      setArmedJobDelete(rowId)
      return
    }
    setArmedJobDelete(null)
    setDeletingWork(workId)
    void window.api
      .deleteWork(workId)
      .then((existed) => {
        // Re-read rather than splice the row out: deleting the work cancels its
        // job in main, so this row's STATUS changed too, not just its presence.
        jobs.reload()
        onFailedCountChanged()
        setMsg(existed ? `Deleted “${title}” and everything derived from it.` : `“${title}” was already gone.`)
      })
      .catch((e: unknown) => setMsg(e instanceof Error ? e.message : String(e)))
      .finally(() => setDeletingWork(null))
  }
  const toggleQueue = (): void => {
    if (queueBusy) return
    setQueueBusy(true)
    const ticket = ++queueStateSeq.current
    const next = queueState?.running ? window.api.pauseQueue() : window.api.resumeQueue()
    void next
      .then((s) => applyQueueState(ticket, s))
      .catch((e: unknown) => setMsg(e instanceof Error ? e.message : String(e)))
      .finally(() => setQueueBusy(false))
  }
  /**
   * Dismissal is a WRITE to the job row (not renderer state), so the project
   * card, the sidebar badge and this screen all read the same number.
   *
   * It takes EVERY failed job in the row, not one. The row's dismissed
   * treatment requires all of them to be dismissed, so writing a single job
   * left a paper with two failed stages permanently in the failed strip and the
   * button reading as dead however often it was pressed.
   */
  const setDismissal = (ids: number[], on: boolean): void => {
    if (ids.length === 0) return
    void Promise.all(ids.map((id) => window.api.setJobDismissed(id, on, projectId))).then(() => {
      jobs.reload()
      onFailedCountChanged()
    })
  }
  const dismiss = (ids: number[]): void => setDismissal(ids, true)
  const restore = (ids: number[]): void => setDismissal(ids, false)
  /**
   * Give a paper the PDF the app could not fetch, from a file on this machine.
   *
   * ATTACHES to the existing work rather than importing the file as a new paper.
   * The row is here because retrieval failed for a paper the corpus already
   * holds, with metadata an index gave it; importing would create a second work
   * for the same paper and title it after the file.
   *
   * `workId` null is the one case this cannot serve: the import never resolved to
   * a paper, so there is nothing to attach to. Said plainly, because the control
   * is hidden for those rows and a reader who reaches this has found a path we
   * did not expect.
   */
  const attachPdf = (p: Pipeline, file: File | null | undefined): void => {
    if (!file) return
    if (p.workId === null) {
      setMsg('This import never resolved to a paper, so there is nothing to attach a PDF to.')
      return
    }
    const path = filePath(file)
    if (path === null) {
      setMsg(
        `Could not read a filesystem path for “${file.name}”. Drag it from your file manager rather than from an archive or another app.`
      )
      return
    }
    setAttaching(p.anchorId)
    setMsg(null)
    void window.api
      .attachPdfPath({ workId: p.workId, projectId, path })
      .then((res) => {
        setMsg(
          res.alreadyHadFile
            ? `“${p.title}” already has a PDF, so it was left as it is. Delete the paper and import this file if you meant to replace it.`
            : `Attached “${file.name}” to “${p.title}” — processing it now.`
        )
        jobs.reload()
        onFailedCountChanged()
      })
      .catch((e: unknown) => setMsg(e instanceof Error ? e.message : String(e)))
      .finally(() => setAttaching(null))
  }

  return (
    <div className="screen ingest" data-testid="screen-ingest">
      {/* The segment is the screen's top-level mode switch: searching what the
          project ALREADY has is one of the jobs, not a separate page
          stacked above the importer. The queue trails them behind a divider —
          it is where papers END UP, not another place they come from. */}
      {/* NOT DRAWN until it is known whether anything can search. The tab set
          depends on that answer, and rendering the strip first would insert a
          tab into it a frame later — the whole row shifting under a pointer
          already on its way to a control. `canSearchWeb` resolves from a local
          IPC call, so this is one frame, not a spinner's worth of waiting; the
          reserved height keeps the card below from jumping either. */}
      <div
        className="ing-segment ing-segment-top"
        data-testid="ingest-kind-tabs"
        role="tablist"
        style={canSearchWeb === null ? { visibility: 'hidden' } : undefined}
      >
        {tabs.map((t) => (
          <Fragment key={t.key}>
            {t.key === QUEUE_KEY && <span className="ing-seg-split" aria-hidden="true" />}
            <button
              type="button"
              role="tab"
              aria-selected={t.key === tab.key}
              className={`ing-seg-btn ${t.key === tab.key ? 'is-active' : ''}`}
              data-testid={`ingest-tab-${t.key}`}
              onClick={() => selectTab(t)}
            >
              {t.label}
              {/* The count belongs to the queue, so it rides the queue's own tab
                  rather than being stamped on every importer. */}
              {t.key === QUEUE_KEY && failedCount > 0 && (
                <span className="ing-tab-fail" data-testid={`ingest-tab-failed-${t.key}`}>
                  {failedCount} failed
                </span>
              )}
            </button>
          </Fragment>
        ))}
      </div>

      {isLibraryTab ? (
        <PapersFinder
          projectId={projectId}
          onOpenWork={onOpenWork}
          onFindNew={canSearchWeb === true ? () => setTabKey(WEB_KEY) : null}
          onFromFile={() => setTabKey('file')}
        />
      ) : (
        <>
      {!isQueueTab && (
      <div className="ing-card">
        {/* Query or identifier, INSIDE the tab the plugin brings. Both ask the
            outside world for a paper this corpus does not have, so they are two
            ways through one door rather than two doors. */}
        {isWebTab && (
          <div className="ing-subsegment" role="tablist">
            {SUB_TABS.map((s) => (
              <button
                key={s.key}
                type="button"
                role="tab"
                aria-selected={s.key === subTab}
                className={`ing-sub-btn ${s.key === subTab ? 'is-active' : ''}`}
                data-testid={`ingest-subtab-${s.key}`}
                onClick={() => {
                  setSubTab(s.key)
                  setMsg(null)
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
        {isWebQuery ? (
          <WebSearchPanel projectId={projectId} onQueued={jobs.reload} />
        ) : isFileTab ? (
          <PdfDropZone busy={busy} onFiles={acceptFiles} onPick={openPicker} />
        ) : (
          <div className="ing-input-row">
            <input
              className="ing-input"
              data-testid="ingest-input"
              value={value}
              placeholder={tab.placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void submit()
                }
              }}
            />
            <button
              className="ing-submit"
              data-testid="ingest-submit"
              onClick={() => void submit()}
              disabled={busy}
            >
              {busy ? 'Importing…' : 'Import & analyze'}
            </button>
          </div>
        )}

        {msg && (
          <p className="ing-msg" data-testid="ingest-msg" role="status">
            {msg}
          </p>
        )}
      </div>
      )}

      {/* ------------------------------------------------- processing queue */}
      {isQueueTab && (
        <>
      <div className="ing-queue-head" id="ing-queue">
        <h2 className="ing-queue-title">Processing queue</h2>
        {failedCount > 0 && (
          <span className="ing-failed-pill" data-testid="ingest-failed-pill">
            <span className="ing-failed-dot" />
            {failedCount} failed
          </span>
        )}
        {/* Its OWN pill, never folded into the failed count.
            A paper the retriever declined has not failed, and the header saying
            "none failed" above sixteen such papers was true and unhelpful — it
            described the one state the queue was not in and stayed silent about
            the one it was. Shown only when there are any, per the badge rule:
            this is a shortfall the reader can act on. */}
        {refusedCount > 0 && (
          <span className="ing-refused-pill" data-testid="ingest-refused-pill">
            <span className="ing-refused-dot" />
            {refusedCount} without a PDF
          </span>
        )}
        {/* Pausing stops the queue CLAIMING work; jobs already running finish,
            because they have no intermediate save point and killing one would
            discard its work and burn an attempt. The label says so while any
            are still in flight rather than claiming a stop that has not
            happened. */}
        <button
          type="button"
          className={`ing-queue-toggle ${queueState?.running === false ? 'is-paused' : ''} ${
            queueBusy ? 'is-busy' : ''
          } ${queueState === null && queueStateUnread ? 'is-unknown' : ''}`}
          data-testid="queue-toggle"
          aria-pressed={queueState?.running === false}
          disabled={(queueState === null && !queueStateUnread) || queueBusy}
          data-tip={
            queueState === null
              ? queueStateUnread
                ? 'Whether processing is running could not be read. Press to ask again.'
                : 'Checking whether processing is running…'
              : queueBusy
                ? 'Applying…'
                : queueState.running
                  ? queueState.inFlight === 0 && waitingCount === 0
                    ? // Nothing to stop. Says so rather than describing a halt
                      // that would have no visible effect, which is the reading
                      // that makes a user press it and then doubt the app.
                      'Processing is on, with nothing waiting. Pausing now only affects papers added later.'
                    : 'Stop starting new work. Anything already running will finish.'
                  : 'Start processing waiting papers again.'
          }
          // With no answer the button stops being a pause/resume and becomes the
          // way to ask again, which is the only useful thing it can do — and the
          // only alternative to a control that is dead until the screen is left.
          onClick={queueState === null && queueStateUnread ? refreshQueueState : toggleQueue}
        >
          <span className="ing-queue-toggle-glyph" aria-hidden="true">
            {queueState === null && queueStateUnread ? (
              <svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10 2.6L18 16.6H2z" />
                <path d="M10 8v3.6" />
                <path d="M10 14.1v.1" />
              </svg>
            ) : queueState?.running === false ? (
              <svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor">
                <path d="M3 1.6l7 4.4-7 4.4z" />
              </svg>
            ) : (
              <svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor">
                <rect x="2.2" y="1.8" width="2.9" height="8.4" rx="0.8" />
                <rect x="6.9" y="1.8" width="2.9" height="8.4" rx="0.8" />
              </svg>
            )}
          </span>
          <span className="ing-queue-toggle-label" data-testid="queue-toggle-label">
            {queueState === null
              ? queueStateUnread
                ? 'Try again'
                : 'Queue…'
              : queueState.running
                ? 'Pause'
                : 'Resume'}
          </span>
          {queueState === null && queueStateUnread && (
            <span className="ing-queue-toggle-state" data-testid="queue-toggle-state">
              State unknown
            </span>
          )}
          {/* "Running" is a claim about WORK, not about the scheduler.
              It said Running over an empty queue — nothing in flight, nothing
              waiting — which reads as "a paper is being processed right now" and
              sent the user looking for the row that was moving. There was none.
              The scheduler being switched on is a real state and the Pause
              button beside it still means something, but its name is IDLE:
              accepting work, with none to do. */}
          {queueState !== null && (
            <span className="ing-queue-toggle-state" data-testid="queue-toggle-state">
              {queueState.running
                ? queueState.inFlight > 0
                  ? `Running · ${queueState.inFlight} in flight`
                  : waitingCount > 0
                    ? `Starting · ${waitingCount} waiting`
                    : 'Idle · nothing to do'
                : queueState.inFlight > 0
                  ? `Paused · ${queueState.inFlight} still finishing`
                  : 'Paused'}
            </span>
          )}
        </button>
        {/* Only ever an offer to fix a real shortfall: with nothing stale it is
            present but inert, so the control does not appear and disappear
            under the user's pointer as papers finish. */}
        <button
          type="button"
          className={`ing-queue-refresh ${staleList.length > 0 ? 'has-stale' : ''} ${
            refreshing ? 'is-busy' : ''
          }`}
          data-testid="queue-refresh-stale"
          disabled={staleList.length === 0 || refreshing}
          data-tip={
            refreshing
              ? 'Redoing the affected papers…'
              : staleList.length === 0
                ? 'Everything is up to date.'
                : `Redo the reading of ${staleList.length} paper${
                    staleList.length === 1 ? '' : 's'
                  } whose results came from something you have since changed — only the parts affected are done again.`
          }
          onClick={() => void refreshStale()}
        >
          <span className="ing-queue-refresh-glyph" aria-hidden="true">
            <svg
              width="11"
              height="11"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.9}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M16.4 8.6A6.6 6.6 0 1 0 16 12.6" />
              <path d="M16.6 4.2v4.4h-4.4" />
            </svg>
          </span>
          <span className="ing-queue-refresh-label">
            {refreshing
              ? 'Invalidating…'
              : staleList.length === 0
                ? 'Up to date'
                : `Invalidate ${staleList.length} paper${staleList.length === 1 ? '' : 's'}`}
          </span>
        </button>
        {/* The same shape as Invalidate beside it, for the same reason: a bulk
            failure is one event (a gateway down, the extension disabled) and
            clearing it one row at a time treats it as twenty. Present but inert
            with nothing failed, so it does not appear and vanish under the
            pointer as the queue drains. */}
        <button
          type="button"
          // `has-failed` stays on while retrying: the count it is derived from
          // falls to zero the moment the jobs re-queue, and without it the
          // button would flip from red to amber mid-press — the in-flight state
          // of the OTHER button.
          // `has-failed` (red) only for real failures: a queue holding nothing
          // but refusals is not in a failed state, and colouring it as one would
          // make the alarm mean two different things.
          className={`ing-queue-refresh ${
            failedCount > 0 || (retryingAll && failedCount > 0) ? 'has-failed' : ''
          } ${retryingAll ? 'is-busy' : ''}`}
          data-testid="queue-retry-all"
          disabled={(failedCount === 0 && refusedCount === 0) || retryingAll}
          data-tip={
            retryingAll
              ? 'Putting them back on the queue…'
              : failedCount === 0 && refusedCount === 0
                ? 'Nothing has failed, and nothing stopped that could be run again.'
                : // NAMES THE TWO GROUPS SEPARATELY, because they are different
                  // claims about the corpus and the remedy differs: a failure may
                  // clear on its own, whereas a refusal usually needs the user to
                  // change something first (add a PDF, wait for a server).
                  [
                    failedCount > 0
                      ? `${failedCount} paper${failedCount === 1 ? '' : 's'} with a failed step`
                      : null,
                    refusedCount > 0
                      ? `${refusedCount} whose PDF could not be fetched`
                      : null
                  ]
                    .filter(Boolean)
                    .join(' and ') +
                  '. Run them again. Papers you dismissed are left alone.'
          }
          onClick={() => void retryAll()}
        >
          <span className="ing-queue-refresh-glyph" aria-hidden="true">
            {/* One stroke: an almost-closed circle, then the arrowhead drawn ON
                the end of that stroke. The previous glyph put the head at the
                bottom-left while the arc it belonged to swept the top-right, so
                the two pieces never met and it read as a broken shape rather
                than as "go round again". */}
            <svg
              width="12"
              height="12"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.9}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M16.5 10a6.5 6.5 0 1 1-1.9-4.6" />
              <path d="M16.5 3.2v3.6h-3.6" />
            </svg>
          </span>
          {/* The LABEL counts what the button will act on, which is failures
              plus refused retrievals — not failures alone. Keyed to
              `failedCount` it read "None failed" on a queue holding eight papers
              with no PDF, while the button beside it was enabled and would have
              retried all eight: the control denied the work it was about to do. */}
          <span className="ing-queue-refresh-label">
            {retryingAll
              ? 'Retrying…'
              : failedCount + refusedCount === 0
                ? 'Nothing to retry'
                : `Retry ${failedCount + refusedCount} paper${
                    failedCount + refusedCount === 1 ? '' : 's'
                  }`}
          </span>
        </button>
        <span className="ing-queue-rule" />
        {/* The same field idiom as "Search existing papers" — magnifier inside a
            bordered box — at the compact height the header's other controls use,
            so it reads as this queue's own control rather than a second search
            product. Filtering is client-side over rows already on screen. */}
        {/* `is-filled` tracks the TRIMMED query, the same value the rows are
            filtered by, so a field holding only spaces cannot claim a filter is
            applied while the list plainly shows everything. */}
        <span
          className={`ing-field ing-qsearch ${queueQuery !== '' ? 'is-clearable' : ''} ${
            queueQuery.trim() !== '' ? 'is-filled' : ''
          }`}
        >
          <svg
            className="ing-field-icon"
            width="14"
            height="14"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.7}
            aria-hidden="true"
          >
            <circle cx="9" cy="9" r="5.5" />
            <path d="M13.5 13.5L17 17" />
          </svg>
          <input
            ref={queueSearchRef}
            className="ing-input ing-input-iconed ing-qsearch-input"
            data-testid="queue-search-input"
            type="search"
            aria-label="Filter the queue by title or DOI"
            placeholder="Filter by title or DOI"
            value={queueQuery}
            onChange={(e) => setQueueQuery(e.target.value)}
            onKeyDown={(e) => {
              // Escape clears rather than blurs: the field is a filter over what
              // is on screen, so "get me back to everything" is the thing the
              // user actually wants from that key.
              if (e.key === 'Escape' && queueQuery !== '') {
                e.preventDefault()
                e.stopPropagation()
                setQueueQuery('')
              }
            }}
          />
          {queueQuery !== '' && (
            <button
              type="button"
              className="ing-qsearch-clear"
              data-testid="queue-search-clear"
              data-tip="Clear the filter (Esc)"
              aria-label="Clear the queue filter"
              onClick={() => {
                setQueueQuery('')
                queueSearchRef.current?.focus()
              }}
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M3 3l6 6M9 3l-6 6" />
              </svg>
            </button>
          )}
        </span>
        {queueQuery.trim() !== '' && (
          <span
            className={`ing-qsearch-count ${queueCounts.shown === 0 ? 'is-none' : ''}`}
            data-testid="queue-search-count"
            role="status"
          >
            {queueCounts.shown} of {queueCounts.total}
          </span>
        )}
        <div className="ing-filters" role="tablist" data-testid="ingest-filters">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={f.key === filter}
              className={`ing-filter ${f.key === filter ? 'is-active' : ''} ${
                f.tone === 'danger' ? 'is-danger' : ''
              }`}
              data-testid={`ingest-filter-${f.key}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {msg && (
        <div
          className={`ing-notice ${
            /^(failed|could not|error)/i.test(msg) ? 'ing-notice-bad' : 'ing-notice-ok'
          }`}
          data-testid="queue-msg"
          role="status"
        >
          <svg
            className="ing-notice-icon"
            width="14"
            height="14"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="10" cy="10" r="7.5" />
            {/^(failed|could not|error)/i.test(msg) ? (
              <path d="M10 6.5v4.2M10 13.5h.01" />
            ) : (
              <path d="M6.9 10.2l2.1 2.1 4.1-4.4" />
            )}
          </svg>
          <span className="ing-notice-text">{msg}</span>
          <button
            type="button"
            className="ing-notice-close"
            data-testid="queue-msg-dismiss"
            data-tip="Dismiss this message"
            aria-label="Dismiss this message"
            onClick={() => setMsg(null)}
          >
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
              <path d="M3 3l6 6M9 3l-6 6" />
            </svg>
          </button>
        </div>
      )}

      {/* The rows wait for the REGISTRY as well as the jobs. Drawing them with
          an unresolved registry would briefly paint every stage as unmapped —
          a state that is wrong rather than merely incomplete — and the registry
          is one small call that lands with the first list anyway.

          `loading` is reported only for the FIRST load. `jobs:changed` fires a
          refetch every few seconds on a busy queue, and DataView falls back to
          the skeleton whenever it is loading AND empty — so an empty queue
          strobed between "No jobs yet." and a shimmer for as long as anything
          was running. Once both sources have answered once, a re-read is a
          background update, not a reason to un-render the answer. */}
      <DataView
        state={{
          data: jobs.data === null || stages.data === null ? null : jobs.data,
          loading: (jobs.loading && jobs.data === null) || (stages.loading && stages.data === null),
          error: jobs.error ?? stages.error,
          reload: reloadQueue
        }}
        isEmpty={(d) => d.length === 0}
        empty={<EmptyState title="No jobs yet." hint="Ingested items appear here with live status." />}
      >
        {() => {
          // One ROW PER PAPER, from the memo above rather than rebuilt here.
          // A paper's stages are its jobs, so a filter that dropped jobs would
          // silently amputate stages from a pipeline the user is looking at.
          // The filter therefore selects PIPELINES — a row is shown when any of
          // its stages matches — and every stage of a shown row is drawn. The
          // text query narrows what the status tab already selected, and every
          // match is drawn: the list is never capped, because a search that
          // hides the paper you searched for is worse than no search.
          const { byStatus, shown: pipelines } = queuePipelines
          const q = queueQuery.trim()

          // A queue narrowed to nothing by a QUERY and a queue with nothing in
          // this status tab are different situations with different remedies,
          // so they must not share a message: one is fixed by clearing the
          // search, the other by switching tabs.
          if (pipelines.length === 0 && q !== '') {
            return (
              <EmptyState
                title={`No papers match “${q}”.`}
                hint={
                  byStatus.length > 0
                    ? `Searching titles and DOIs of the ${byStatus.length} paper${
                        byStatus.length === 1 ? '' : 's'
                      } in this view. Press Escape to clear the search.`
                    : 'Nothing is in this status tab to search. Switch filters, or press Escape to clear the search.'
                }
                testid="ingest-empty-search"
              />
            )
          }
          if (pipelines.length === 0) {
            return (
              <EmptyState
                title="Nothing in this view."
                hint="Switch filters to see queued, failed, or completed work."
                testid="ingest-empty-filtered"
              />
            )
          }
          return (
            <div className="ing-pipes" data-testid="ingest-pipelines">
              {pipelines.map((p) => {
                // The pipeline is laid out against the REGISTRY, so a stage
                // that has not run for this paper is drawn as pending rather
                // than being missing, and a stage registered in main appears
                // here with no change to this file.
                const cells = stageCells(stageDefs, p.jobs)
                // The stages, grouped for a reader. The cells behind them are
                // unchanged, so everything else on the row still measures the
                // real stages.
                const phases = phaseCells(cells)
                const openPhase = openPhaseByRow[p.anchorId] ?? null
                const openCells = phases.find((ph) => ph.id === openPhase) ?? null
                const roll = rollupState(cells)
                const progress = stageProgress(cells)
                const failed = roll === 'failed'
                // A run that stopped without finishing — killed mid-flight, or
                // superseded by a step redone beneath it. Not a failure, but
                // the same thing has to happen next: run it again.
                const stalled = roll === 'stalled'
                // A stage that stopped ON PURPOSE — no identifier to fetch
                // with, nothing the publisher would give us. Not a failure and
                // never painted as one, but the user can still change the facts
                // it decided on (add a PDF, add a DOI) and then wants to say
                // "try again". Without this the row offered nothing at all and
                // the paper was stuck for good.
                const refused = roll === 'refused'
                // A step the USER stopped. Not a failure and not painted as one,
                // but cancelling is how someone says "not now" — and the answer
                // to "not now" is being able to say "now" afterwards. `retryIds`
                // below has always included cancelled jobs; without this the
                // button holding them never rendered, so the row went quiet and
                // the only way back was to reprocess the whole paper.
                //
                // SUPERSEDED IS NOT CHECKED HERE, and that is the difference
                // between this and every other actionable state. Stopping a
                // stage retires the run it was part-way through, so a cancelled
                // job very often carries `stage_run_superseded` — filtering on
                // it removes precisely the jobs this is meant to find. The
                // status is the whole claim: the user stopped this, and stopping
                // it is why the run went.
                const cancelled = p.jobs.some((j) => j.status === 'cancelled')
                // Actions act on a JOB, and the row holds several. The
                // ACTIONABLE stage is the one the user means: the failure they
                // came to retry, else the stage that refused, else the one they
                // stopped, else whatever is still moving, else the last stage to
                // have run.
                const lead =
                  p.jobs.find((j) => isFailed(j.status)) ??
                  p.jobs.find((j) => j.outcome === 'refused') ??
                  p.jobs.find((j) => j.status === 'cancelled') ??
                  p.jobs.find((j) => j.status === 'running') ??
                  p.jobs.find((j) => j.status === 'queued') ??
                  p.jobs.find((j) => j.status === 'blocked') ??
                  p.jobs[p.jobs.length - 1]
                const failedIds = p.jobs.filter((j) => isFailed(j.status)).map((j) => j.id)
                /**
                 * EVERY outstanding step of the row, because Retry is a promise
                 * about the PAPER, not about one dot.
                 *
                 * This used to be `lead.id` alone. `lead` is a single job picked
                 * by a priority order, so a paper whose retrieval refused AND
                 * whose extraction failed got exactly one of them re-queued: the
                 * user pressed Retry, watched the row come back still broken, and
                 * had to press again — with no way to tell that the second press
                 * was addressing a different stage, or how many presses were
                 * left. A fan-out makes it worse, since one stage alone can hold
                 * a dozen sibling jobs and only one of them would move.
                 *
                 * Three statuses, matching what the scheduler accepts: `failed`,
                 * `cancelled`, and `review` ONLY when it refused. A `review` that
                 * settled `empty` or `skipped` is a real answer the stage gave
                 * about the paper, and re-running it spends a model call to reach
                 * the same conclusion. Superseded rows are history and are never
                 * addressed — the row that replaced them is here instead.
                 *
                 * EXCEPT A CANCELLED ONE, whose run is superseded BY the
                 * cancellation. Stopping a stage part-way retires the run it was
                 * in, so the superseded test throws away exactly the jobs a user
                 * pressing Retry after a cancel is asking about — and the button
                 * would offer the whole paper instead of the step they stopped.
                 */
                const retryIds = p.jobs
                  .filter(
                    (j) =>
                      j.status === 'cancelled' ||
                      (j.stage_run_superseded !== true &&
                        (isFailed(j.status) ||
                          (j.status === 'review' && j.outcome === 'refused')))
                  )
                  // IN PIPELINE ORDER, which is not id order. `retry` walks these
                  // in sequence so the earliest revives the ones after it, and a
                  // job's id says only when its ROW was written — a stage added
                  // after a corpus was imported holds the highest ids in the
                  // table, so sorting by id ran the new step last, after the
                  // steps that come after it. The registry's own order is the
                  // answer, and the row already has it.
                  .sort((a, b) => stageRank(a.stage, stageDefs) - stageRank(b.stage, stageDefs))
                  .map((j) => j.id)
                /**
                 * A STALLED row has no re-queueable job of its own: its stages
                 * either succeeded or were never planned, which is exactly what
                 * stalled means. Falling back to `lead` keeps the press ANSWERED
                 * — the scheduler says why a done job cannot be re-queued and the
                 * row reports it — rather than the button consuming the click in
                 * silence, which is the failure `retry`'s own header is about.
                 */
                const retryTargets = retryIds.length > 0 ? retryIds : [lead.id]
                /**
                 * Stages this paper is behind on, from the same staleness read
                 * the "Needs invalidation" badge renders.
                 *
                 * A stage ADDED after the corpus was processed has no job and no
                 * run, so `retryIds` is empty for it and `retryTargets` falls
                 * back to the lead job — re-queueing something that already ran
                 * while the missing step stays missing. `rerunStages` takes
                 * stage IDS rather than job ids and plans what has never run, so
                 * a stale row presses that instead.
                 */
                const staleStages = p.workId === null ? [] : (staleIdsByWork.get(p.workId) ?? [])
                // Over the jobs the actions would ACT ON, which is failures and
                // cancellations together. Asking it of failures alone made a row
                // with none — every cancelled row — vacuously dismissed, and the
                // button that had just been enabled for cancellation disappeared
                // again one line later.
                const isDismissed = p.jobs.every(
                  (j) => (!isFailed(j.status) && j.status !== 'cancelled') || j.dismissed
                )
                const showFailActions = (failed || cancelled) && !isDismissed
                /**
                 * Whether Retry is offered at all — ONE expression, because this
                 * condition was written out twice (the slot's `aria-hidden` and
                 * the button's own guard) and a third place, `showFailActions`,
                 * governed the recovery links beside it. Cancelling was added to
                 * that third one and the button still did not appear, which is
                 * what two copies of a rule are for.
                 *
                 * `isDismissed` gates only the outcomes a user can WAVE AWAY. A
                 * stall was never waved away, and a refusal is an answer rather
                 * than a complaint.
                 */
                //
                // A STALE ROW COUNTS TOO. The row already says "Needs
                // invalidation" — it knows a step must be redone, and for a
                // stage this paper has never run that is the ONLY thing that
                // says so, because a stage with no job has no dot to fail. A
                // row explaining what is outstanding while offering no way to
                // do it is the failure the retry header is about.
                const canRetry =
                  stalled ||
                  refused ||
                  staleStages.length > 0 ||
                  ((failed || cancelled) && !isDismissed)
                // Places to find the PAPER, which only answer a failure to GET
                // the paper. Offering Sci-Hub under a failed embedding step
                // proposes a fix for a problem the user does not have — the PDF
                // is already here — and the same is true of adding one by hand.
                // Both belong to retrieval alone.
                //
                // BOTH RETRIEVAL STAGES, AND BOTH OUTCOMES. This read
                // `failed && lead.stage === 'download'`, which missed the case
                // it exists for twice over: the stage that gives up on fetching
                // a PDF is `retrieve` (`download` merely resolves the file it
                // wrote), and giving up is reported as `refused` rather than
                // `failed` — deliberately, since "no source would serve this"
                // is an answer, not a broken step. So the one row a user comes
                // to this screen to fix, the paper whose PDF could not be got,
                // offered neither the recovery links nor a way to supply the
                // file, while a failed EMBEDDING would have offered both.
                // ASKED OF THE RETRIEVAL JOBS THEMSELVES, not of `lead`.
                //
                // `lead` is "the job the buttons address", chosen by a priority
                // order over the WHOLE row — so on a paper whose PDF is present
                // and whose SUMMARISE failed, `lead` is the summarise job, and
                // testing its stage was only accidentally the right answer.
                // Reading the retrieval jobs directly says the thing that
                // actually matters: did fetching the file end without one.
                //
                // `retrieve` gives up (refused/failed), or `download` could not
                // resolve a file. `download` cancelled BY an upstream refusal is
                // not its own verdict and is excluded — the refusal upstream is
                // the fact, and counting the cascade too would light this up on
                // any paper whose pipeline stopped for any reason at all.
                const retrievalJobs = p.jobs.filter(
                  (j) => j.stage === 'retrieve' || j.stage === 'download'
                )
                const fetchEndedWithoutPdf = retrievalJobs.some(
                  (j) =>
                    j.outcome === 'refused' ||
                    (isFailed(j.status) && j.error_kind !== 'upstream')
                )
                // THE PDF MAY HAVE ARRIVED SINCE, which makes the old verdict
                // history. A paper whose retrieval was refused and which then had
                // a file attached has a `retrieve` run that is now superseded;
                // offering "add the PDF" over a paper that already holds one is a
                // remedy for a problem it no longer has, and a drop there would
                // be declined anyway.
                const retrievalSettled = retrievalJobs.some(
                  (j) =>
                    j.stage === 'download' &&
                    j.status === 'done' &&
                    j.outcome !== 'skipped' &&
                    !j.stage_run_superseded
                )
                const retrievalIncomplete = fetchEndedWithoutPdf && !retrievalSettled
                const urls = retrievalIncomplete ? recoverySources(lead) : null
                /**
                 * Whether this row can be given a PDF by hand right now.
                 *
                 * A dismissed failure is excluded for the same reason its actions
                 * are: the user has said they are done with it. A row with no
                 * `workId` is excluded because there is no paper to attach to.
                 */
                const canAttachPdf =
                  retrievalIncomplete && p.workId !== null && !(failed && isDismissed)
                /**
                 * The drop handlers for the WHOLE queue item.
                 *
                 * Spread onto the row rather than onto the note or the failure
                 * panel: those are a thin band at the bottom of it, so a file
                 * aimed at the title, the thumbnail or the stage chips — at the
                 * paper — missed entirely and the browser navigated to it.
                 */
                const dropProps = canAttachPdf
                  ? {
                      onDragOver: (ev: React.DragEvent<HTMLDivElement>) => {
                        if (attaching !== null) return
                        // Must fire on EVERY dragover or the browser navigates
                        // away to the dropped file instead.
                        ev.preventDefault()
                        ev.stopPropagation()
                        setDropTarget(p.anchorId)
                      },
                      // Guarded on the drag leaving the BLOCK, not any child: it
                      // fires once per button crossed, and clearing on those
                      // flickered the highlight off and on under the pointer.
                      onDragLeave: (ev: React.DragEvent<HTMLDivElement>) => {
                        if (ev.currentTarget.contains(ev.relatedTarget as Node | null)) return
                        setDropTarget((cur) => (cur === p.anchorId ? null : cur))
                      },
                      onDrop: (ev: React.DragEvent<HTMLDivElement>) => {
                        ev.preventDefault()
                        ev.stopPropagation()
                        setDropTarget(null)
                        if (attaching !== null) return
                        const files = Array.from(ev.dataTransfer.files)
                        if (files.length === 0) return
                        // ONE paper, one file. A multi-file drop here is
                        // ambiguous rather than a bulk action — nothing can tell
                        // which of five PDFs is this paper — so it is refused
                        // with the reason instead of silently taking the first.
                        if (files.length > 1) {
                          setMsg(
                            `Drop ONE PDF on a paper — ${files.length} were dropped, and there is no way to tell which one is “${p.title}”. Use "Import from file" to add them all as new papers.`
                          )
                          return
                        }
                        attachPdf(p, files[0])
                      }
                    }
                  : {}
                const upId = `ing-upload-${p.anchorId}`
                const dur = pipelineDuration(p.jobs, now)
                // A paper's row reports when the paper ARRIVED, so it takes the
                // earliest stamp. A corpus row stands for many runs of a
                // repeating sweep, where the earliest stamp is the day the
                // sweep first ever ran — so it takes the LATEST, which is the
                // run whose status the row is reporting. Reporting the oldest
                // under a row that reports the newest would be a stamp that
                // belongs to a different run than the state beside it.
                const added = parseStamp(
                  p.jobs.reduce(
                    (acc, j) =>
                      acc === ''
                        ? j.created_at
                        : p.kind === 'corpus'
                          ? acc > j.created_at
                            ? acc
                            : j.created_at
                          : acc < j.created_at
                            ? acc
                            : j.created_at,
                    '' as string
                  ) || null
                )
                const isNew = p.jobs.some((j) => highlightJobs.includes(j.id))
                // `blocked` is cancellable: the scheduler's cancel sweep covers
                // running, queued AND blocked, and a row stuck behind a
                // dependency is precisely one a user wants to be able to stop.
                const canCancel = p.jobs.some(
                  (j) =>
                    j.status === 'queued' || j.status === 'running' || j.status === 'blocked'
                )
                const busyDelete = p.workId !== null && deletingWork === p.workId
                const notice = rowNotice(cells, roll)
                return (
                  <div
                    className={`ing-pipe is-${roll} ${isDismissed && failed ? 'is-dismissed' : ''} ${
                      isNew ? 'is-new' : ''
                    }${dropTarget === p.anchorId ? ' is-drop' : ''}`}
                    /* THE WHOLE QUEUE ITEM TAKES THE DROP, not a strip inside it.
                       The handlers first went on the note/failure block, which is
                       a ~40px band at the bottom of the row: the target was the
                       explanation of the problem rather than the paper, so a file
                       aimed at the title, the thumbnail or the stage chips — at
                       the row, in other words — landed on nothing and the browser
                       tried to navigate to it. The row is what a person is
                       pointing at, and it is the thing the PDF belongs to. */
                    {...dropProps}
                    data-testid={`job-row-${p.anchorId}`}
                    data-pipeline={p.key}
                    // Every job the row speaks for, so anything that needs to
                    // find a row by a job id (the just-added scroll) can, no
                    // matter which of them the row is anchored or tested by.
                    data-job-ids={p.jobs.map((j) => j.id).join(' ')}
                    key={p.key}
                  >
                    <div className="ing-pipe-grid">
                      {/* --- status cell: verdict pill + the two timers --- */}
                      <div className="ing-pipe-status">
                        <span
                          className={`ing-verdict is-${roll}`}
                          data-testid={`job-status-${p.anchorId}`}
                        >
                          <span className="ing-verdict-glyph" aria-hidden="true">
                            <StageIcon state={roll} size={12} />
                          </span>
                          {STAGE_LABEL[roll]}
                        </span>
                        <span
                          className={`ing-pipe-meta ${dur?.live ? 'is-live' : ''}`}
                          data-testid={`job-duration-${p.anchorId}`}
                          data-tip={
                            dur === null
                              ? 'Nothing has started on this paper yet, so there is no time to show.'
                              : dur.live
                                ? 'Time spent working on this paper so far.'
                                : 'Time spent working on this paper. Waiting in the queue is not counted.'
                          }
                        >
                          <svg width="11" height="11" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
                            <circle cx="10" cy="10" r="7.4" />
                            <path d="M10 5.8V10l2.9 1.9" />
                          </svg>
                          {dur === null ? 'no duration recorded' : formatDuration(dur.ms)}
                        </span>
                        <span
                          className="ing-pipe-meta"
                          data-testid={`job-added-${p.anchorId}`}
                          data-tip={
                            p.kind === 'corpus'
                              ? 'When this last ran across your whole library.'
                              : 'When this paper was added.'
                          }
                        >
                          <svg width="11" height="11" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
                            <rect x="3.2" y="4.6" width="13.6" height="12.2" rx="2" />
                            <path d="M3.2 8.4h13.6M7 3.2v2.8M13 3.2v2.8" />
                          </svg>
                          {added === null ? 'added — unknown' : formatRelative(added, now)}
                        </span>
                      </div>

                      {/* --- identity: thumbnail + title + stage summary --- */}
                      <div className="ing-pipe-id">
                        {/* A corpus sweep has no document, so it gets the
                            corpus mark rather than an empty page-1 thumbnail
                            that implies a PDF it will never have. */}
                        {p.kind === 'corpus' ? (
                          <span
                            className="ing-corpus-mark"
                            aria-hidden="true"
                            data-testid={`job-corpus-mark-${p.anchorId}`}
                          >
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
                              <circle cx="12" cy="12" r="8.2" />
                              <path d="M3.8 12h16.4M12 3.8c2.3 2.3 2.3 13.9 0 16.4-2.3-2.5-2.3-14.1 0-16.4z" />
                            </svg>
                          </span>
                        ) : p.workId !== null ? (
                          // The cover, as the way into the paper. Someone
                          // scanning the queue for the paper they just added
                          // recognises it by its first page long before they
                          // read the title, so the picture is the thing they
                          // reach for — and it was inert.
                          //
                          // A BUTTON, not a click handler on the span: this
                          // navigates, so it has to be reachable by keyboard
                          // and announce itself as an action. `PdfThumb` stays
                          // presentational, since it is also rendered in places
                          // that do not navigate.
                          <button
                            type="button"
                            className="ing-thumb-open"
                            data-testid={`job-open-${p.anchorId}`}
                            aria-label={`Open ${plainText(p.title)}`}
                            data-tip="Open this paper"
                            onClick={() => onOpenWork(p.workId as number)}
                          >
                            <PdfThumb documentId={p.documentId} alt={plainText(p.title)} />
                          </button>
                        ) : (
                          // No work row yet — an ingest that has not resolved
                          // to a paper. There is nothing to open, so the cover
                          // stays inert rather than offering a dead action.
                          <PdfThumb documentId={p.documentId} alt={plainText(p.title)} />
                        )}
                        <div className="ing-pipe-text">
                          <div className="ing-pipe-title" title={plainText(p.title)}>
                            <RichText text={p.title} />
                          </div>
                          <div className="ing-pipe-sub">
                            {p.kind === 'corpus' ? (
                              // Says what it IS and how much of it there is.
                              <>
                              <span
                                className="ing-pipe-corpus"
                                data-testid={`job-corpus-${p.anchorId}`}
                                data-tip={`Covers your whole library, not one paper — it runs again after each batch of new papers. Showing the most recent of ${p.runCount} time${p.runCount === 1 ? '' : 's'} it has run${
                                  p.failedRuns > 0
                                    ? `; ${p.failedRuns} earlier one${p.failedRuns === 1 ? '' : 's'} did not finish.`
                                    : '.'
                                }`}
                              >
                                whole corpus · {p.runCount} run
                                {p.runCount === 1 ? '' : 's'}
                              </span>
                              {/* A past failure is history, not the current
                                  state — but it is not nothing either, so it is
                                  stated beside the count instead of being
                                  folded into a pill that would claim the latest
                                  run failed when it succeeded. */}
                              {p.failedRuns > 0 && (
                                <>
                                  <span className="ing-pipe-dot" aria-hidden="true">
                                    ·
                                  </span>
                                  <span
                                    className="ing-pipe-corpus-failed"
                                    data-testid={`job-corpus-failed-${p.anchorId}`}
                                    data-tip={`${p.failedRuns} earlier attempt${p.failedRuns === 1 ? '' : 's'} did not finish. The status above is the most recent one.`}
                                  >
                                    {p.failedRuns} earlier failed
                                  </span>
                                </>
                              )}
                              </>
                            ) : p.workId === null ? (
                              <span className="ing-pipe-orphan">unattached job</span>
                            ) : (
                              <span className="ing-pipe-ref">#{p.workId}</span>
                            )}
                            <span className="ing-pipe-dot" aria-hidden="true">
                              ·
                            </span>
                            <span
                              data-testid={`job-progress-${p.anchorId}`}
                              data-tip={`${progress.done} of ${progress.total} processing steps finished, counting steps that correctly found nothing.`}
                            >
                              {progress.done}/{progress.total} steps done
                            </span>
                            {/* Only when it is a QUALIFICATION. A publisher's
                                text layer is the unremarkable case and badging
                                every row with it would turn the one row that
                                needs attention into noise; OCR and an
                                unclaimed source both change how far the
                                downstream extraction can be trusted. */}
                            {(() => {
                              if (p.textSource === null || p.textSource === 'pdf-text-layer') {
                                return null
                              }
                              const ts = textSourceMeta(
                                p.textSource,
                                p.textConfidence,
                                OCR_LOW_CONFIDENCE
                              )
                              if (!ts) return null
                              return (
                                <>
                                  <span className="ing-pipe-dot" aria-hidden="true">
                                    ·
                                  </span>
                                  <span
                                    className={`badge badge-${ts.cls} ing-pipe-textsrc`}
                                    data-testid={`job-text-source-${p.anchorId}`}
                                    data-tip={ts.hint}
                                  >
                                    {ts.label}
                                    {p.textSource === 'ocr' && p.textConfidence !== null && (
                                      <span className="ing-pipe-textsrc-num mono">
                                        {p.textConfidence.toFixed(0)}%
                                      </span>
                                    )}
                                  </span>
                                </>
                              )
                            })()}
                            {/* Says what must be READ AGAIN and why, and only
                                when there is a shortfall — a row whose results
                                still match its inputs says nothing at all. */}
                            {(() => {
                              if (p.workId === null) return null
                              const affected = staleByWork.get(p.workId)
                              if (!affected || affected.length === 0) return null
                              return (
                                <>
                                  <span className="ing-pipe-dot" aria-hidden="true">
                                    ·
                                  </span>
                                  <span
                                    className="badge badge-warn ing-pipe-stale"
                                    data-testid={`job-stale-${p.anchorId}`}
                                    data-tip={`Something these results were based on has changed since they were produced. To be redone: ${affected.join(', ')}.`}
                                  >
                                    Needs invalidation
                                  </span>
                                </>
                              )
                            })()}
                          </div>
                        </div>
                      </div>

                      {/* --- phase mini-graph --- */}
                      <StagePhases
                        phases={phases}
                        stages={stageDefs}
                        anchorId={p.anchorId}
                        open={openPhase}
                        onToggle={(id) =>
                          setOpenPhaseByRow((cur) => ({
                            ...cur,
                            [p.anchorId]: cur[p.anchorId] === id ? null : id
                          }))
                        }
                      />

                      {/* --- actions --- */}
                      <div className="ing-job-actions">
                        {/* STALLED OFFERS RETRY TOO, and that was the gap: a
                            paper reading "Stopped part-way" had no way to
                            resume. `failed` and `stalled` are different events
                            — one ran and broke, the other never finished — but
                            the remedy is identical and it is the only thing the
                            reader can do from here. Withholding the button
                            because the state was not literally `failed` left
                            the row describing a problem and offering nothing.
                            `isDismissed` gates only the FAILED case: it means
                            "the user has already waved this failure away", and
                            a stall was never waved away. */}
                        {/* The slot is ALWAYS here, empty or not. Rendering the
                            button only when it applies let every other action
                            slide left by its width, so Cancel and Delete sat in
                            a different place on each row and moved under the
                            pointer as a job changed state. A column of buttons
                            that will not hold still is harder to use than one
                            with a gap in it. */}
                        <span className="ing-act-slot" aria-hidden={!canRetry}>
                          {canRetry && (
                            <button
                              type="button"
                              className="ing-act"
                              data-testid={`job-retry-${p.anchorId}`}
                              // The tip names ONE stage only while there IS one.
                              // With several outstanding steps, naming the lead
                              // would understate what the press does — the user
                              // would read "try download again" and get the whole
                              // paper re-queued, which is right but not what they
                              // were told.
                              data-tip={
                                retryTargets.length > 1
                                  ? `Run all ${retryTargets.length} unfinished steps of this paper again.`
                                  : cancelled && !failed
                                    ? `You stopped “${leadLabel(lead, stageDefs)}”. Run it again.`
                                    : stalled && !failed
                                      ? `“${leadLabel(lead, stageDefs)}” stopped before it finished. Start it again.`
                                      : refused && !failed
                                        ? // Names the CONDITION, because retrying an
                                          // unchanged refusal just refuses again.
                                          `“${leadLabel(lead, stageDefs)}” stopped on purpose. Run it again once you have changed what it was waiting on.`
                                        : `Try “${leadLabel(lead, stageDefs)}” again.`
                              }
                              // A stale row goes through `rerunStages`, which
                              // takes stage ids and PLANS one that has never
                              // run. `retry` re-arms existing jobs, and a stage
                              // added after this paper was processed has none —
                              // the press would re-queue the lead job and leave
                              // the missing step missing.
                              onClick={() => {
                                const workId = p.workId
                                if (retryIds.length === 0 && staleStages.length > 0 && workId !== null) {
                                  void (async () => {
                                    try {
                                      await window.api.rerunStages(workId, staleStages, projectId)
                                      setMsg(
                                        `Queued ${staleStages.length} step${staleStages.length === 1 ? '' : 's'} to run again.`
                                      )
                                    } catch (err) {
                                      setMsg(
                                        `Could not restart this paper: ${
                                          err instanceof Error ? err.message : String(err)
                                        }`
                                      )
                                    }
                                    reloadQueue()
                                  })()
                                  return
                                }
                                retry(retryTargets)
                              }}
                            >
                              Retry
                            </button>
                          )}
                        </span>
                        <button
                          type="button"
                          className="ing-act ing-act-ghost"
                          data-testid={`job-cancel-${p.anchorId}`}
                          disabled={!canCancel}
                          data-tip={
                            canCancel
                              ? `Stop “${leadLabel(lead, stageDefs)}”.`
                              : 'Nothing is in progress here, so there is nothing to stop.'
                          }
                          onClick={() => {
                            if (canCancel) cancel(lead.id)
                          }}
                        >
                          Cancel
                        </button>
                        {/* A row that never resolved to a work has no paper to
                            erase. It still renders — a control that appears on
                            some rows and not others reads as a missing button
                            — but disabled, and it says why. */}
                        <button
                          type="button"
                          className={`ing-act ing-act-del ${
                            armedJobDelete === p.anchorId ? 'is-armed' : ''
                          } ${busyDelete ? 'is-busy' : ''}`}
                          data-testid={`job-delete-${p.anchorId}`}
                          aria-pressed={armedJobDelete === p.anchorId}
                          disabled={p.workId === null || busyDelete}
                          data-tip={
                            p.kind === 'corpus'
                              ? // "has not resolved to one" would promise this
                                // row a paper it is never going to get.
                                'Corpus-wide work — there is no paper here to delete.'
                              : p.workId === null
                                ? 'No paper yet — this job has not resolved to one.'
                                : busyDelete
                                ? 'Deleting…'
                                : armedJobDelete === p.anchorId
                                  ? 'Click again to erase it.'
                                  : `Delete ${p.title} and everything derived from it`
                          }
                          onClick={() => {
                            if (p.workId === null) return
                            deletePaper(p.anchorId, p.workId, p.title)
                          }}
                        >
                          {armedJobDelete === p.anchorId ? 'Sure?' : 'Delete'}
                        </button>
                      </div>
                    </div>

                    {openCells !== null && (
                      <PhaseSteps
                        phase={openCells}
                        stages={stageDefs}
                        anchorId={p.anchorId}
                      />
                    )}

                    {/* The zero-output and waiting states get their OWN strip,
                        deliberately not the red failure panel: a stage that
                        correctly found nothing, one refused by policy, one
                        waiting on its upstream, and one whose output an
                        upstream re-run invalidated are four different
                        situations with four different remedies, and none of
                        them is a crash. The reason comes from the stage's own
                        `outcome_note`, which the scheduler requires.

                        BEHIND THE DEVELOPER VIEW. These describe what the
                        PIPELINE did, and a scientist opening the queue is
                        asking whether their papers are ready. "citation-contexts
                        found no bibliography in this supplement" is correct
                        behaviour they cannot act on, and one strip per paper
                        becomes a wall of paragraphs about non-events — which
                        teaches people to scroll past the strip, so it fails on
                        the day it carries something real. A genuine FAILURE is
                        not gated: that panel and its remedies show regardless,
                        because that is something the user must act on.

                        `retrieve` IS NOT GATED, for exactly the reason the rest
                        are. Its refusal means the app never obtained the paper's
                        PDF — paywalled, no identifier to fetch with, or the
                        retriever could not reach a source — so every later step
                        has nothing to read and the paper holds no text at all.
                        That is not a non-event the reader can ignore: it is the
                        difference between "processed, nothing found" and "never
                        actually obtained", and the remedy (add the PDF yourself)
                        is theirs alone. Gated, this row read as ten completed
                        steps over an empty paper. */}
                    {(devView || notice?.cell.stage.id === 'retrieve') && notice !== null && (
                      <div
                        className={`ing-note is-${notice.state}`}
                        data-testid={`job-note-${p.anchorId}`}
                        data-state={notice.state}
                      >
                        <span className="ing-note-glyph" aria-hidden="true">
                          <StageIcon state={notice.state} size={13} />
                        </span>
                        <span className="ing-note-text">
                          <strong className="ing-note-stage">{notice.cell.stage.label}</strong>{' '}
                          {STAGE_MEANING[notice.state]}
                          {notice.cell.blockedBy.length > 0 && (
                            <>
                              {' '}
                              Waiting for{' '}
                              {notice.cell.blockedBy
                                .map((id) => stageDefs.find((s) => s.id === id)?.label ?? id)
                                .join(', ')}
                              .
                            </>
                          )}
                          {notice.cell.deadBlockers.length > 0 && (
                            <>
                              {' '}
                              {notice.cell.deadBlockers
                                .map((id) => stageDefs.find((s) => s.id === id)?.label ?? id)
                                .join(', ')}{' '}
                              did not finish, so this will not start on its own.
                            </>
                          )}
                          {/* The stage's own reason, as its OWN sentence. It was
                              appended inline, which produced "…the reason
                              follows. callout mapping below the confidence
                              gate: 7% of 213" — a promise of an explanation
                              followed by a lowercase fragment running on from
                              it. Capitalised and given a full stop, it reads as
                              the explanation the line just promised. */}
                          {notice.cell.note !== null && notice.cell.note !== '' && (
                            <>
                              {' '}
                              {capitalise(notice.cell.note.trim().replace(/\.$/, ''))}.
                            </>
                          )}
                        </span>
                        {/* THE REMEDY, BESIDE THE STATEMENT OF THE PROBLEM.
                            "No source would give us this paper" is a dead end
                            without it: the note explained the situation and then
                            offered nothing to do about it, so the only route was
                            to guess that importing the file separately would
                            somehow attach to this paper — which it would not, it
                            would make a second one.

                            Rendered only when the FAILURE panel is not also on
                            this row, so a paper with both a refusal and a
                            failure shows one of these, not two. */}
                      </div>
                    )}

                    {showFailActions && (
                      <div
                        className="ing-fail"
                      >
                        <div className="ing-fail-reason" data-testid={`job-error-${p.anchorId}`}>
                          <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="var(--danger)" strokeWidth="1.7">
                            <path d="M10 3l7 12H3z" />
                            <path d="M10 8v3M10 13h.01" />
                          </svg>
                          {/* The raw error is the extension's attempt log —
                              "unpaywall: not OA; publisher: 403; scihub: no
                              mirror served it". True, and exactly what is
                              needed when something is genuinely broken; but a
                              list of service names and HTTP codes under every
                              paywalled paper reads as a fault the reader
                              caused. Outside the developer view they get the
                              plain fact and the actions that resolve it.

                              NAMED BY THE STAGE THAT FAILED. One sentence about
                              paywalls used to be printed under every failure
                              whatever broke, so a paper that downloaded
                              perfectly and failed at extraction was reported as
                              paywalled — sending the reader to hunt for a PDF
                              already on disk. A step with nothing specific to
                              say now names itself rather than inventing a
                              cause. */}
                          {devView
                            ? (lead.error ?? 'Could not get this paper.')
                            : (STAGE_FAILURE_MEANING[lead.stage ?? ''] ??
                              `${stageDefs.find((s) => s.id === lead.stage)?.label ?? 'A step'} failed.`)}
                        </div>
                        <div className="ing-fail-actions">
                          {/* Both of these answer "we could not GET the paper",
                              so both appear only when that is what happened.
                              Under a failed embedding they would propose
                              fetching a PDF that is already on disk. */}
                          {retrievalIncomplete && (
                            <>
                              {/* COLLAPSED by default. Eight links under every
                                  failed paper is a wall; the button says the
                                  list exists and opens it for the one paper
                                  someone actually decides to chase. */}
                              <button
                                type="button"
                                className={`ing-fail-pill ing-fail-open${openWeb === p.anchorId ? ' is-on' : ''}`}
                                data-testid={`job-openweb-${p.anchorId}`}
                                aria-expanded={openWeb === p.anchorId}
                                data-tip="Places to look for this paper yourself — the same ones the app just tried."
                                onClick={() =>
                                  setOpenWeb((cur) => (cur === p.anchorId ? null : p.anchorId))
                                }
                              >
                                Open in web {openWeb === p.anchorId ? '▾' : '▸'}
                              </button>
                            </>
                          )}
                          <button
                            type="button"
                            className="ing-fail-dismiss"
                            data-testid={`job-dismiss-${p.anchorId}`}
                            onClick={() => dismiss(failedIds)}
                          >
                            Dismiss
                          </button>
                        </div>

                        {openWeb === p.anchorId && urls && (
                          <div className="ing-fail-sources" data-testid={`job-sources-${p.anchorId}`}>
                            <span className="ing-fail-lead">
                              {urls.length > 0
                                ? 'The app tried these automatically. Opening one yourself can get past a login or a check it could not.'
                                : 'This paper has no DOI or title recorded, so there is nothing to look it up by.'}
                            </span>
                            {urls.map((s) => (
                              <a
                                key={s.id}
                                className="ing-fail-pill"
                                data-testid={`job-source-${s.id}-${p.anchorId}`}
                                data-tip={s.tip}
                                href={s.url}
                                target="_blank"
                                rel="noopener"
                              >
                                {s.label} ↗
                              </a>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* BELOW the error container, and ONCE per row.
                        It was inside both the refusal note and the failure panel,
                        which made it a chip competing for width with a paragraph
                        of retriever log — the remedy read as one more piece of the
                        error text, on the very row where it is the only thing the
                        user can act on. Out here it spans the row and cannot be
                        drawn twice on a paper carrying a refusal AND a failure. */}
                    {canAttachPdf && (
                      <AddPdfManually
                        id={upId}
                        busy={attaching === p.anchorId}
                        over={dropTarget === p.anchorId}
                        onPick={(f) => attachPdf(p, f)}
                      />
                    )}

                    {failed && isDismissed && (
                      <div className="ing-dismissed">
                        <span className="ing-dismissed-note">
                          Dismissed — excluded from alerts. Retrieval still failed.
                        </span>
                        <button
                          type="button"
                          className="ing-restore"
                          data-testid={`job-restore-${p.anchorId}`}
                          onClick={() => restore(failedIds)}
                        >
                          Restore
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )
        }}
      </DataView>
        </>
      )}
        </>
      )}

      {/* Asked when an import is about to queue papers a connected Zotero
          cannot receive, because it is closed. Dismissing it is the same as
          cancelling the import: nothing is queued behind the user's back. */}
      {zoteroOffline && (
        <ZoteroOfflineModal
          onRetry={async () => {
            const up = await window.api.isZoteroRunning().catch(() => false)
            if (up) {
              zoteroOffline.resolve(true)
              setZoteroOffline(null)
            }
            return up
          }}
          onDisable={async () => {
            await window.api.disconnectZotero(projectId)
          }}
          onClose={() => {
            // The import proceeds once the connection is off — that was the
            // point of turning it off — and is abandoned when it is still on,
            // which is what dismissing an unanswered question means.
            void window.api
              .getZoteroConnection(projectId)
              .then((c) => zoteroOffline.resolve(!c.connected))
              .catch(() => zoteroOffline.resolve(false))
              .finally(() => setZoteroOffline(null))
          }}
        />
      )}
    </div>
  )
}
