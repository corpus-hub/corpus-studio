import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from 'react'
import type { WorkDetailDTO, CitationContextDTO } from '@shared/types'
import type {
  AnalysisFreshnessDTO,
  AnalysisInputFreshnessDTO,
  AnalysisRunDTO,
  DocumentDTO,
  EvidenceSpanDTO,
  ExtractionRowDTO,
  ParagraphTextDTO,
  FactDTO,
  UnresolvedReferenceDTO,
  CitationOutcomeDTO,
  RankingRowDTO,
  ReferenceRetrievalStatus,
  SemanticSearchResultDTO
} from '@shared/contract'
import { referenceLabel } from '@shared/referenceLabel'
import { useAsync } from '../lib/useAsync'
import { groupReadings, readingKey, type WorkReadings } from '../lib/readings'
import { useJobsChanged } from '../lib/useJobsChanged'
import { useShowProvenance, useFindMode, setFindMode, type FindMode } from '../lib/prefs'
import {
  FindByMeaning,
  FIND_MEANING_K,
  MEANING_LIST_ID,
  meaningRowId,
  type MeaningPick
} from '../components/FindByMeaning'
import { DataView, EmptyState, SkeletonRows } from '../components/States'
import { DossierToggle, RunOriginBadge } from '../components/ui'
import { AbstractButton, SummaryButtons } from '../components/SummaryButtons'
import { useSummariesWritten } from '../lib/summaries'
import {
  PdfDocView,
  PDF_DEFAULT_SCALE,
  PDF_MAX_SCALE,
  PDF_MIN_SCALE,
  PDF_SCALE_STEP,
  type PdfHighlight,
  type PdfFindApi,
  type PdfFindHit,
  type PdfTextState
} from '../components/PdfDocView'
import {
  CitationContextSection,
  citeAnnId,
  citeNeedle
} from '../components/CitationContexts'
import {
  contentStatusMeta,
  expansionForDisplay,
  factKindMeta,
  relevanceForDisplay,
  fmtTime,
  textSourceMeta
} from '../lib/format'
import { workTypeLabel } from '../lib/workType'
import { DOSSIER_PAPER_LIMIT, OCR_LOW_CONFIDENCE } from '@shared/contract'
import { useVisibleWindowListener } from '../lib/visibility'
import { RichText, plainText } from '../components/RichText'
import { ReadAbstractButton } from '../components/ReferenceAbstract'

// work_type -> the filled "Primary research"-style pill label.
/**
 * Why this paper's PDF panel is empty, in the user's terms.
 *
 * Answered from `document.retrieval_status`, which is a MECHANICAL record of
 * what the app tried — never a guess about the paper. The states are the four
 * the column's CHECK constraint allows, and each one has a different remedy,
 * which is the whole reason they are not collapsed into one sentence.
 *
 * `not-attempted` is the state that used to be invisible: the paper was
 * imported by identifier, no fetch had run, and the queue nevertheless reported
 * every step complete. It reads as the in-progress state it is.
 */
function retrievalMessage(docs: readonly DocumentDTO[]): string {
  // The most advanced answer any of this work's documents reached. A work with
  // one paywalled version and one never tried is not "never tried".
  const rank: Record<string, number> = {
    'not-attempted': 0,
    pending: 1,
    failed: 2,
    paywalled: 3,
    retrieved: 4
  }
  const best = docs.reduce<string | null>(
    (acc, d) => (acc === null || (rank[d.retrieval_status] ?? 0) > (rank[acc] ?? 0) ? d.retrieval_status : acc),
    null
  )
  switch (best) {
    case 'not-attempted':
    case 'pending':
      return 'No PDF yet — the full text has not been fetched for this paper.'
    case 'failed':
      return 'No PDF could be fetched for this paper. Add the file yourself to process its full text.'
    case 'paywalled':
      return 'No PDF: the publisher requires a subscription. Only the abstract and metadata are available.'
    case 'retrieved':
      // The column claims a file and none resolved — a moved or deleted library
      // file. Saying "not available" alone would hide that the app thinks it
      // HAS this, which is the part that needs fixing.
      return 'The PDF for this paper is recorded but its file could not be found; it may have been moved or deleted.'
    default:
      return 'PDF not available (no source document).'
  }
}

// Evidence palette (tokens declared in styles/paper.css). One hue per evidence
// span of the selected run: the colour is assigned by the span's RANK among the
// run's evidence ids sorted ascending, so it is a pure function of the run's
// data — identical across re-renders, zoom changes and run switches, and it
// never depends on render order or React keys. Fact kind is deliberately NOT
// used as the colour source: several facts share a kind, so the mapping
// claim <-> passage (the whole point) would be ambiguous.
const EVIDENCE_COLORS = [
  'var(--ev-1)',
  'var(--ev-2)',
  'var(--ev-3)',
  'var(--ev-4)',
  'var(--ev-5)',
  'var(--ev-6)'
]

// A x/10 score bar. `score01` is 0..1; null hides the bar. `strong` picks the
// darker EXPANSION gradient; otherwise the TOPIC RELEVANCE gradient.
function ScoreBar({
  label,
  score01,
  strong,
  tip
}: {
  label: string
  score01: number | null
  strong?: boolean
  /** What the score MEANS — the label alone reads as jargon. */
  tip?: string
}): JSX.Element | null {
  if (score01 === null || score01 === undefined) return null
  const clamped = Math.max(0, Math.min(1, score01))
  const outOf10 = Math.round(clamped * 10)
  return (
    <div className="pv-scorebar">
      <div className="pv-scorebar-head mono">
        <span data-tip={tip}>{label}</span>
        <span className={strong ? 'pv-score-val-strong' : 'pv-score-val'}>{outOf10}/10</span>
      </div>
      <div className="pv-scorebar-track">
        <div
          className={`pv-scorebar-fill ${strong ? 'pv-scorebar-fill-exp' : 'pv-scorebar-fill-rel'}`}
          style={{ width: `${clamped * 100}%` }}
        />
      </div>
    </div>
  )
}

/** References revealed per press of "Show N more". */
const REF_PAGE = 10
/**
 * References shown before the first press.
 *
 * ONE, not a page: these lists are reference material a reader consults rather
 * than reads, and a bibliography of 90 entries opened by default buried every
 * other section of the screen. One row proves the list is there and says how
 * much of it there is; the rest is a click away for the reader who wants it.
 */
const REF_INITIAL = 1

/**
 * ONE unresolved reference, as a LIST ROW: the printed bib line, one action.
 *
 * It used to be a full card — a warn-tinted panel, a `status` pill, a `section`
 * chip, a `doi …` chip, a guessed title, the clamped raw text with its own
 * expander and a full-width button — for a line of text nobody has read yet;
 * thirty of them was thirty stacked panels. The line is clamped to two lines
 * with the whole of it in the tooltip, because these are bibliography strings
 * rather than prose.
 *
 * The action is a BUTTON and must look like one: a solid filled surface, a real
 * press, and NO leading status dot. "Retry" beside a red dot reads as a report
 * that something failed rather than as a thing to press, so the VERB carries the
 * state instead — Import / Importing… / Retry.
 */
function UnresolvedRow({
  reference,
  state,
  onRetrieve
}: {
  reference: UnresolvedReferenceDTO
  state: ReferenceRetrievalStatus
  onRetrieve: () => void
}): JSX.Element {
  const busy = state === 'retrieving'
  const failed = state === 'failed'
  return (
    <div className="ur-row" data-testid={`unresolved-ref-${reference.id}`}>
      <span className="ur-raw" title={reference.raw_bib_text}>
        {reference.raw_bib_text}
      </span>
      {/* The number is printed only where there is one. An unscored row says so
          by sitting at the end of the list, not by carrying a "—" that reads as
          a measurement of nothing. The badge follows HARD RULE 0.6: a score read
          from a title alone is systematically lower for a reason that has nothing
          to do with the paper, and that shortfall is the only thing worth saying
          — an abstract-backed score is what the reader already expects. */}
      {reference.relevance !== null && (
        <span className="ur-rel" data-testid={`unresolved-ref-${reference.id}-relevance`}>
          {/* A WORD, NOT THE NUMBER. The number was printed to two significant
              figures because `toFixed(2)` had rendered thirty-one references as
              "0.00" — honest about the magnitude, and still unreadable. These
              are sigmoids off a cross-encoder: on this corpus the median is
              0.00044 and the 90th percentile 0.027, so 0.0038 looks like nothing
              and is in fact the top fifth. Nobody can be asked to read that.

              The band is a percentile within the corpus AND within the scale
              this row was scored on, so it means what a reader assumes it
              means. The raw score stays in the tooltip: it is the thing that
              actually orders the list, and hiding it entirely would make the
              ordering unexplainable. */}
          {/* NO FALLBACK BAND. `?? 'low'` labelled a reference whose band had
              not been computed "low relevancy" — a verdict nothing reached,
              printed in the same words as one that was. A band nobody assigned
              shows nothing. */}
          {reference.relevance_band !== null && (
            <span
              className={`ur-rel-band ur-rel-band-${reference.relevance_band}`}
              tabIndex={0}
              data-tip={
                (reference.scored_on === 'title'
                  ? 'How near this paper is to what this project says it is for, from the title alone — no abstract was found for it. '
                  : 'How near this paper is to what this project says it is for, from its title and abstract. ') +
                'Ranked against every other reference read the same way' +
                (reference.relevance === null
                  ? '.'
                  : `; its score is ${reference.relevance.toPrecision(2)}`) +
                ', which orders the list rather than measuring anything on its own.'
              }
            >
              {reference.relevance_band === 'high'
                ? 'high relevancy'
                : reference.relevance_band === 'medium'
                  ? 'medium relevancy'
                  : 'low relevancy'}
            </span>
          )}
          {reference.scored_on === 'title' && (
            <span
              className="badge badge-warn scored-on-badge"
              tabIndex={0}
              data-testid={`unresolved-ref-${reference.id}-scored-on-title`}
              data-tip="No abstract was found for this reference, so only the title it prints was compared against this project — a shorter read scores lower whatever the paper is worth."
            >
              title only
            </span>
          )}
        </span>
      )}
      {/* ABOVE the import, and stacked with it: reading what a paper says comes
          before deciding to fetch it, and the two are one column so a long
          bibliography does not grow a second one. */}
      <span className="ur-acts">
        <ReadAbstractButton
          state={reference.abstract_state}
          printedTitle={referenceLabel({
            index_title: reference.index_title,
            title: reference.guessed_title,
            authors: reference.guessed_authors,
            year: reference.guessed_year,
            venue: reference.guessed_venue,
            raw_bib_text: reference.raw_bib_text
          })}
          testid={`unresolved-ref-${reference.id}-abstract`}
        />
        <button
          type="button"
          className={`ur-act ${busy ? 'is-busy' : ''} ${failed ? 'is-failed' : ''}`}
          data-testid={`unresolved-ref-${reference.id}-retrieve`}
          disabled={busy}
          aria-busy={busy || undefined}
          data-tip={
            busy
              ? 'This reference is being looked up now. The row updates itself as it runs.'
              : failed
                ? `The last attempt failed${reference.retrieval_error ? `: ${reference.retrieval_error}` : ''}. Press to try again.`
                : 'Look this reference up and import it into the corpus.'
          }
          onClick={busy ? undefined : onRetrieve}
        >
          {busy && <span className="ur-spinner" aria-hidden="true" />}
          {busy ? 'Importing…' : failed ? 'Retry' : 'Import'}
        </button>
      </span>
    </div>
  )
}

/**
 * A reference list that opens on ONE row and reveals REF_PAGE more per press.
 *
 * Paging is the point: a bibliography of 90 entries rendered whole buries every
 * other section of the screen, and this list is reference material the reader
 * dips into rather than reads through.
 */
function ReferenceList({
  count,
  testid,
  children
}: {
  count: number
  testid: string
  children: (shown: number) => JSX.Element[]
}): JSX.Element {
  const [shown, setShown] = useState(REF_INITIAL)
  const visible = Math.min(shown, count)
  const rest = count - visible
  return (
    <>
      <div className="ur-list">{children(visible)}</div>
      {rest > 0 && (
        <button
          type="button"
          className="pv-ref-more"
          data-testid={`${testid}-more`}
          onClick={() => setShown((n) => n + REF_PAGE)}
        >
          Show {Math.min(REF_PAGE, rest)} more
          <span className="pv-ref-more-count mono">
            {visible} of {count}
          </span>
        </button>
      )}
    </>
  )
}

/** Where the reader's preferred PDF zoom is remembered. */
const PDF_SCALE_KEY = 'corpus.pdfScale'

/**
 * annId for the ONE highlight a `quote` deep link creates. A citation context
 * has no evidence_span row, so it has no `ev-<id>` to address; a fixed id is
 * enough because at most one such passage is ever focused at a time.
 */
const CITATION_ANN_ID = 'cite-focus'

/**
 * annId for the ONE passage a by-meaning pick highlights. Fixed for the same
 * reason as the citation one: a semantic candidate has no evidence_span row,
 * and only one candidate is ever the shown passage.
 */
const MEANING_ANN_ID = 'meaning-focus'

/**
 * The stored zoom, or the default.
 *
 * CLAMPED to the current bounds: a value saved under different limits (or a
 * hand-edited one) would otherwise sit outside them and leave both zoom buttons
 * permanently disabled, with no way back to a usable scale.
 */
function readStoredScale(): number {
  try {
    const raw = localStorage.getItem(PDF_SCALE_KEY)
    if (raw === null) return PDF_DEFAULT_SCALE
    const n = Number.parseFloat(raw)
    if (!Number.isFinite(n)) return PDF_DEFAULT_SCALE
    return Math.min(PDF_MAX_SCALE, Math.max(PDF_MIN_SCALE, n))
  } catch {
    return PDF_DEFAULT_SCALE
  }
}

export function PaperScreen({
  workId,
  projectId,
  projectName,
  onOpenExtractionRow,
  onOpenReview,
  onGoToGraph,
  onGoToRanking,
  onOpenWork,
  focusEvidenceId,
  focusQuote,
  onSubjectTitle
}: {
  // Optional: the `paper` route can be reached from the sidebar with NO paper
  // selected (master-detail with no selection). When undefined we render an
  // empty state and NEVER call window.api.getWork(undefined) — the main-process
  // zod handler (correctly) rejects a non-number id, so guarding here is the fix.
  workId?: number
  projectId: number
  /**
   * The open project's name, so a project-scoped analysis can be attributed to
   * a project the reader recognises rather than to a bare row id.
   */
  projectName?: string | null
  /**
   * Open the Extraction matrix positioned on ONE of this paper's readings.
   * A reading shown here is the same record the matrix holds, so it links to
   * itself there rather than to the top of a screen the reader must search.
   */
  onOpenExtractionRow?: (rowKey: string, schemaId?: number) => void
  /** Open the Review queue positioned on one fact of this paper. */
  onOpenReview?: (factId: number) => void
  onGoToGraph?: () => void
  onGoToRanking?: () => void
  /** Open a cited paper this corpus holds, so references are navigable. */
  onOpenWork?: (workId: number) => void
  /**
   * Deep link to ONE evidence span: select the run that owns it and activate it,
   * so the quote is highlighted and scrolled to rather than the reader being
   * dropped at the top of the paper to find it themselves.
   */
  focusEvidenceId?: number
  /**
   * Deep link to a passage that has NO evidence_span row — a citation context
   * from the Connectome. There is no stored anchor to activate, so the passage
   * is located in the PDF text layer by its TEXT, reusing the find machinery
   * (which already locates, highlights and scrolls). The find bar opens showing
   * the passage, so the reader can see WHY the view jumped where it did.
   */
  focusQuote?: string
  /**
   * The loaded paper's title, reported up so the tab strip can label itself.
   *
   * The screen is the only thing that knows it — a tab is created the instant a
   * paper is clicked, long before the work has been fetched — and having the
   * strip fetch it a second time would put a second query per paper tab on the
   * one connection the ingest writes through, to learn something this screen
   * already has.
   */
  onSubjectTitle?: (title: string) => void
}): JSX.Element {
  const hasWork = workId !== undefined
  // `undefined` until known, so a summary that exists is never greyed out.
  const summariesWritten = useSummariesWritten(projectId, workId)
  // React forbids conditionally skipping hooks, so the loaders always run; each
  // one early-returns a resolved fallback when no work is selected, firing ZERO
  // IPC calls with an undefined id.
  const work = useAsync<WorkDetailDTO | null>(
    () => (workId === undefined ? Promise.resolve(null) : window.api.getWork(workId)),
    [workId]
  )
  // Reported up the moment it is known, so the tab stops calling itself by the
  // work's row id. Guarded on the loaded value rather than fired in the loader:
  // this must not announce a title for a work that failed to load.
  const reportTitle = onSubjectTitle
  const workTitle = work.data?.title ?? null
  useEffect(() => {
    if (reportTitle && workTitle) reportTitle(workTitle)
  }, [reportTitle, workTitle])

  const docs = useAsync<DocumentDTO[]>(
    () => (workId === undefined ? Promise.resolve([]) : window.api.getWorkDocuments(workId)),
    [workId]
  )
  const analyses = useAsync<AnalysisRunDTO[]>(
    () =>
      workId === undefined
        ? Promise.resolve([])
        : window.api.getWorkAnalyses(workId, projectId),
    [workId, projectId]
  )
  // Every place this paper cites something — resolved AND unresolved. Read via
  // `getCitationContexts`, not `getCitations`: the latter is keyed by EDGE and
  // therefore cannot return the contexts of a reference that resolved to
  // nothing, which on this corpus is most of them. Reading it here would leave
  // the unresolved majority stored and invisible.
  const citations = useAsync<CitationContextDTO[]>(
    () => (workId === undefined ? Promise.resolve([]) : window.api.getCitationContexts(workId)),
    [workId]
  )
  // The stage's own verdict, alongside its rows. Separate because the rows
  // cannot express it: a run that DECLINED to link callouts and one that linked
  // none write identical rows, and only this says which happened.
  const citationOutcome = useAsync<CitationOutcomeDTO | null>(
    () => (workId === undefined ? Promise.resolve(null) : window.api.getCitationOutcome(workId)),
    [workId]
  )
  const unresolved = useAsync<UnresolvedReferenceDTO[]>(
    () =>
      workId === undefined
        ? Promise.resolve([])
        : window.api.getUnresolvedReferences(workId),
    [workId]
  )
  const ranking = useAsync<RankingRowDTO[]>(() => window.api.getRanking(projectId), [projectId])
  // The SAME records the Extraction matrix lays out, so a reading shown here and
  // a row shown there are one record with one identity — which is what lets this
  // panel link into the matrix by `row_key` instead of dropping the reader at
  // the top of a screen to search for it. CURRENT runs only, by construction.
  const extraction = useAsync<ExtractionRowDTO[]>(
    () => window.api.getExtractionRows(projectId),
    [projectId]
  )

  // ------------------------------------------- retrieving absent references --
  /**
   * unresolved id -> retrieval status learned SINCE the last list read.
   *
   * The DB is the source of truth — a retrieval outlives this screen and this
   * process — and the DTO carries a snapshot of it. This overlay holds what the
   * write and the job signals have said since, so a card can flip to
   * "Retrieving…" and later to "Imported" without re-reading the whole list.
   */
  const [liveRetrieval, setLiveRetrieval] = useState<Map<number, ReferenceRetrievalStatus>>(
    () => new Map()
  )
  const [retrieveError, setRetrieveError] = useState<string | null>(null)
  /** What the last press actually achieved, since ids may be SKIPPED. */
  const [retrieveNote, setRetrieveNote] = useState<string | null>(null)

  // The overlay describes one paper's list; carrying it to the next paper would
  // paint a status onto whichever reference happened to reuse the id.
  useEffect(() => {
    setLiveRetrieval(new Map())
    setRetrieveError(null)
    setRetrieveNote(null)
  }, [workId])

  const retrievalStatusOf = useCallback(
    (r: UnresolvedReferenceDTO): ReferenceRetrievalStatus =>
      liveRetrieval.get(r.id) ?? r.retrieval_status,
    [liveRetrieval]
  )

  const unresolvedRefs = unresolved.data
  // So a citation-context group whose target did not resolve can offer the SAME
  // import control the Unresolved references list offers, reading the same live
  // state — rather than a second affordance that could disagree with the first.
  const unresolvedById = useMemo(
    () => new Map((unresolvedRefs ?? []).map((r) => [r.id, r])),
    [unresolvedRefs]
  )
  const inFlightIds = useMemo(
    () => (unresolvedRefs ?? []).filter((r) => retrievalStatusOf(r) === 'retrieving').map((r) => r.id),
    [unresolvedRefs, retrievalStatusOf]
  )
  // `inFlightIds` is a fresh array every render; the joined key is a total
  // function of it, so depending on the key keeps this callback (and the effect
  // below it) stable while still tracking every change of the set.
  const inFlightKey = inFlightIds.join(',')
  // Two signals can arrive close together and the SLOWER reply is the older
  // truth; applying it would flip a settled card back to "Retrieving…".
  const retrievalSeq = useRef(0)
  const refreshRetrievals = useCallback(async (): Promise<void> => {
    if (inFlightIds.length === 0) return
    const seq = ++retrievalSeq.current
    const rows = await window.api.getReferenceRetrievals(inFlightIds)
    if (seq !== retrievalSeq.current) return
    setLiveRetrieval((cur) => {
      const next = new Map(cur)
      for (const r of rows) next.set(r.unresolved_id, r.retrieval_status)
      return next
    })
    // Read from `rows`, not from inside the updater: React may defer a
    // functional update past this point, so a flag set in there is still unset
    // when the check runs and the reload silently never happens.
    if (rows.some((r) => r.retrieval_status !== 'retrieving')) {
      // A retrieval that SUCCEEDED added a real paper and a real edge, which
      // these lists only learn by re-reading.
      unresolved.reload()
      citations.reload()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inFlightKey])

  // Read once for whatever was already running when this paper opened: the
  // signal only reports FUTURE transitions, so a retrieval started elsewhere
  // would otherwise sit at "Retrieving…" until the next unrelated job moved.
  useEffect(() => {
    void refreshRetrievals()
  }, [refreshRetrievals])

  useJobsChanged(() => {
    if (inFlightIds.length > 0) {
      // Update the watched cards in place, which avoids re-reading (and
      // re-collapsing) the whole reference list on every job transition.
      void refreshRetrievals()
      return
    }
    // Nothing of ours is in flight, yet a job still finished — an ingest parses
    // citations and inserts new references and edges, which only a fresh read
    // can show.
    unresolved.reload()
    citations.reload()
  })

  const retrieveReference = useCallback(
    async (ref: UnresolvedReferenceDTO): Promise<void> => {
      setRetrieveError(null)
      setRetrieveNote(null)
      // Paint it busy before the await so the press has immediate feedback; the
      // result below corrects it if main declined to queue this id.
      setLiveRetrieval((cur) => new Map(cur).set(ref.id, 'retrieving'))
      try {
        const res = await window.api.retrieveUnresolvedReferences({
          projectId,
          unresolvedIds: [ref.id]
        })
        const skipped = res.skipped.find((s) => s.unresolved_id === ref.id)
        if (skipped) {
          // Say what actually happened rather than assuming the request went
          // through: 'already-retrieving' leaves the card busy (it truthfully
          // IS), 'not-retrievable' must not.
          setRetrieveNote(
            skipped.reason === 'already-retrieving'
              ? 'That paper is already being retrieved.'
              : 'That reference names nothing that could be looked up.'
          )
          if (skipped.reason === 'not-retrievable') {
            setLiveRetrieval((cur) => {
              const next = new Map(cur)
              next.delete(ref.id)
              return next
            })
          }
          return
        }
        if (res.queued.length === 0) {
          setLiveRetrieval((cur) => {
            const next = new Map(cur)
            next.delete(ref.id)
            return next
          })
          setRetrieveNote('Nothing was queued for that reference.')
          return
        }
        setRetrieveNote('Retrieval queued — this card updates itself as it runs.')
      } catch (e) {
        setLiveRetrieval((cur) => {
          const next = new Map(cur)
          next.delete(ref.id)
          return next
        })
        setRetrieveError(e instanceof Error ? e.message : String(e))
      }
    },
    [projectId]
  )

  // ------------------------------------------------------------- viewer UI --
  // Real zoom: this value is handed to PdfDocView, which re-renders every page
  // at that pdfjs scale (canvas + text layer `--scale-factor`) and re-measures
  // every evidence-highlight band afterwards.
  // PERSISTED across papers and sessions: zoom is a comfort setting about the
  // reader's eyes and screen, not about one document, so resetting it every time
  // a paper opened meant re-zooming on every single paper.
  const [scale, setScale] = useState(readStoredScale)
  useEffect(() => {
    try {
      localStorage.setItem(PDF_SCALE_KEY, String(scale))
    } catch {
      /* storage disabled — zoom simply stops persisting, never breaks reading */
    }
  }, [scale])
  // Set in Settings, obeyed here. Reading the shared store rather than holding
  // local state means flipping the switch reaches an open paper immediately.
  const showProvenance = useShowProvenance()

  const round2 = (n: number): number => Math.round(n * 100) / 100
  const canZoomOut = round2(scale) > PDF_MIN_SCALE
  const canZoomIn = round2(scale) < PDF_MAX_SCALE
  const zoomOut = useCallback(
    () => setScale((s) => round2(Math.max(PDF_MIN_SCALE, s - PDF_SCALE_STEP))),
    []
  )
  const zoomIn = useCallback(
    () => setScale((s) => round2(Math.min(PDF_MAX_SCALE, s + PDF_SCALE_STEP))),
    []
  )

  // Expanded viewer. We ask for the real Fullscreen API on the viewer pane and
  // ALSO flip an in-app class, so the control works even if the platform
  // refuses the request (the class alone makes the pane fill the window).
  const viewerRef = useRef<HTMLElement>(null)
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    const onFsChange = (): void => {
      if (!document.fullscreenElement) setExpanded(false)
    }
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [])
  const toggleExpanded = useCallback(() => {
    setExpanded((cur) => {
      const next = !cur
      const el = viewerRef.current
      if (next) {
        if (el?.requestFullscreen) void el.requestFullscreen().catch(() => undefined)
      } else if (document.fullscreenElement) {
        void document.exitFullscreen().catch(() => undefined)
      }
      return next
    })
  }, [])

  const [selectedRunId, setSelectedRunId] = useState<number | null>(null)
  // The evidence-linking "active span" — mirrors ai-detector ReportApp's
  // `active` + `activeRef` pair. The ref keeps the PDF click handler's identity
  // stable (it must not close over `active`, or every selection change would
  // recreate the callback and force PdfDocView to re-locate every span).
  const [activeSpan, setActiveSpan] = useState<string | null>(null)
  /** A refused context write, reported beside the control that attempted it. */
  const [dossierError, setDossierError] = useState<string | null>(null)
  const activeSpanRef = useRef<string | null>(null)
  useEffect(() => {
    activeSpanRef.current = activeSpan
  }, [activeSpan])
  const scrollRef = useRef<HTMLDivElement>(null)
  // The right-hand analysis column scroller — the claim card of a span clicked
  // in the PDF is smooth-centered inside it (ai-detector `focusInSidebar`).
  const analysisRef = useRef<HTMLDivElement>(null)

  /**
   * EXTRACTION RUNS ONLY — one tab per schema.
   *
   * This strip used to list every `analysis_run` the paper has, which meant
   * tabs labelled `ranking`, `dossier` and `summary` sitting beside the schema
   * names. They do not belong to the same question: this pane asks "what did
   * each schema pull out of this paper", and those three answer other ones that
   * already have their own surfaces — the Ranking screen, the Project context
   * screen, and the summary buttons above.
   *
   * They were also mostly EMPTY. `ranking` and `summary` runs carry no facts at
   * all (measured on this corpus: 0 of each), so their tab opened a pane with
   * nothing in it, and `ranking` additionally showed a freshness caveat about
   * inputs it cannot reconstruct — a warning about a run the reader never asked
   * to see. A tab that reliably shows nothing is a tab that teaches the reader
   * the strip is not worth reading.
   *
   * Filtered HERE rather than at the tab strip, so the default selection below
   * cannot land on a run that has no tab.
   */
  const runs = (analyses.data ?? []).filter((r) => r.analysis_type === 'extraction')
  // Default selection prefers a CURRENT run that actually carries evidence quotes
  // so the PDF evidence highlights render on first paint. Some current runs have
  // zero evidence spans; picking one of those would leave the viewer
  // un-highlighted even though another extraction run with quotes exists.
  const hasEvidence = (r: AnalysisRunDTO): boolean =>
    r.evidence.some((e) => e.quote && e.quote.trim().length > 0)
  const selectedRun =
    runs.find((r) => r.id === selectedRunId) ??
    runs.find((r) => !r.superseded && hasEvidence(r)) ??
    runs.find((r) => !r.superseded) ??
    runs.find((r) => hasEvidence(r)) ??
    runs[0] ??
    null

  /**
   * Honour a deep link to one evidence span.
   *
   * Two steps, because a span only exists inside a run: SELECT the run that owns
   * it (the default pick is "a current run with quotes", which is often a
   * different one), then activate the span so PdfDocView scrolls to and
   * highlights it.
   *
   * Guarded by a ref keyed on the requested id, so this runs ONCE per link. The
   * user is free to click elsewhere afterwards; re-applying on every render
   * would drag them back to the quote and make the paper unusable.
   */
  const honouredEvidenceRef = useRef<number | null>(null)
  useEffect(() => {
    if (focusEvidenceId === undefined) {
      honouredEvidenceRef.current = null
      return
    }
    if (honouredEvidenceRef.current === focusEvidenceId) return
    const owner = runs.find((r) => r.evidence.some((e) => e.id === focusEvidenceId))
    if (!owner) return // analyses not loaded yet, or the span is not on this work
    honouredEvidenceRef.current = focusEvidenceId
    setSelectedRunId(owner.id)
    setActiveSpan(`ev-${focusEvidenceId}`)
  }, [focusEvidenceId, runs])

  // ranking row for this work -> relevance / expansion_priority (x/10 bars).
  const rankRow = useMemo(
    () => (ranking.data ?? []).find((r) => r.work_id === workId) ?? null,
    [ranking.data, workId]
  )
  // From the SAME ranking the row above came from, which is the whole project
  // rather than a page of it — so this screen can tell whether its one paper
  // may still be added without asking for a count it would have to trust.
  const atDossierLimit = useMemo(
    () => (ranking.data ?? []).filter((r) => r.is_reference).length >= DOSSIER_PAPER_LIMIT,
    [ranking.data]
  )

  // pick a document to display in the PDF panel: preferred fulltext first.
  const pdfDoc = useMemo(() => {
    const list = docs.data ?? []
    return (
      list.find((d) => d.is_preferred && d.content_status === 'fulltext') ??
      list.find((d) => d.content_status === 'fulltext') ??
      list[0] ??
      null
    )
  }, [docs.data])

  // How much of the source THE SELECTED RUN could read. This is deliberately
  // not `pdfDoc.content_status`: the viewer shows the best document available
  // now, which may be a fulltext acquired AFTER an abstract-only run. Reading
  // the status off the viewer would let that older run inherit the newer
  // document's credit and present itself as full-text-backed. The run names the
  // document it read via its evidence spans, so that is the authority; only a
  // run with no spans at all falls back to the displayed document.
  const runContentStatus = useMemo<string | null>(() => {
    const list = docs.data ?? []
    const readDocId = selectedRun?.evidence.find((e) => e.document_id !== null)?.document_id ?? null
    if (readDocId !== null) {
      const read = list.find((d) => d.id === readDocId)
      if (read) return read.content_status
    }
    return pdfDoc?.content_status ?? null
  }, [selectedRun, docs.data, pdfDoc])

  // The displayed document's paragraphs, so an evidence highlight can be
  // scoped to the one its span names. A table cell is far too short to locate
  // across a whole paper — `0.528 ± 0.002` is eight canonical characters — and
  // without this it simply went unhighlighted, which reads as "not extracted".
  const paragraphs = useAsync<ParagraphTextDTO[]>(
    () => (pdfDoc ? window.api.paragraphTexts(pdfDoc.id) : Promise.resolve([])),
    [pdfDoc?.id]
  )
  const paraById = useMemo<Map<number, string>>(
    () => new Map((paragraphs.data ?? []).map((p) => [p.idx, p.text])),
    [paragraphs.data]
  )

  // spanId -> palette colour. Keyed by the evidence-span id sorted ascending so
  // the assignment is stable for a given run regardless of array order.
  const spanColors = useMemo<Map<string, string>>(() => {
    const map = new Map<string, string>()
    if (!selectedRun) return map
    // The SAME predicate the highlight builder uses. Ranking over a wider set
    // would leave gaps in the palette, so two bands that do paint could land on
    // one hue while an unused colour sat between them.
    const ids = selectedRun.evidence
      .filter((e) => e.verbatim && e.quote && e.quote.trim().length > 0)
      .map((e) => e.id)
      .sort((a, b) => a - b)
    ids.forEach((id, i) => map.set(`ev-${id}`, EVIDENCE_COLORS[i % EVIDENCE_COLORS.length]))
    return map
  }, [selectedRun])

  // ------------------------------------------------------------- find (^F) --
  /** Non-null while the find bar is open; the string is the live query. */
  const [findQuery, setFindQuery] = useState<string | null>(null)
  const [findHits, setFindHits] = useState<PdfFindHit[]>([])
  const [findAt, setFindAt] = useState(0)
  const findApiRef = useRef<PdfFindApi | null>(null)
  const findInputRef = useRef<HTMLInputElement | null>(null)
  /** The mode switch, so an arrow-key toggle can move focus to the new option. */
  const modesRef = useRef<HTMLDivElement | null>(null)
  // A counter, not a boolean: re-running the same query after the text layer
  // re-renders must still re-search, and a boolean would already be true.
  const [findEpoch, setFindEpoch] = useState(0)
  const handleFindApi = useCallback((api: PdfFindApi | null) => {
    findApiRef.current = api
    setFindEpoch((n) => n + 1)
  }, [])

  /**
   * Whether the document's text can be reasoned about, as the VIEWER sees it.
   *
   * Not derivable from `pdfDoc`: a document row can exist while its bytes are
   * missing or its render fails, and in that case nothing will ever be
   * locatable. Without this, anything waiting on the text index waited forever
   * — a "locating…" that never resolves, which is worse than a refusal.
   * `unavailable` when there is no document at all, for the same reason.
   */
  const [pdfTextState, setPdfTextState] = useState<PdfTextState>('pending')
  useEffect(() => {
    setPdfTextState(pdfDoc ? 'pending' : 'unavailable')
  }, [pdfDoc])

  /**
   * Verbatim or by meaning. The READER's habit, so it lives in `prefs` and
   * survives closing the bar, changing paper and quitting — a single source of
   * truth rather than a second copy in this screen's state, which is how a
   * remembered preference comes to disagree with what is stored.
   */
  const findMode = useFindMode()
  /**
   * The mode a query was RUN in.
   *
   * Held apart from `findMode` because the switch flips instantly while the
   * vector query takes an ONNX forward pass to answer. Without it the verbatim
   * hit list stayed on screen and stayed highlighted for the whole of that
   * pause, so the bar showed one mode's answer under the other mode's label.
   */
  const activeMode: FindMode | null = findQuery === null ? null : findMode

  // Re-run whenever the query changes OR the document becomes searchable, so
  // opening find before the PDF has rendered resolves as soon as it can.
  // Literal matching is unchanged; it simply does not run in the other mode,
  // where its hits would compete with the chosen passage for the same bands.
  useEffect(() => {
    const api = findApiRef.current
    if (findQuery === null || activeMode !== 'verbatim' || !api) {
      setFindHits([])
      return
    }
    const hits = api.find(findQuery)
    setFindHits(hits)
    setFindAt(0)
  }, [findQuery, findEpoch, activeMode])

  // ---- by meaning ----
  /**
   * The candidate the reader chose, as the whole pick rather than an id.
   *
   * The highlight needs the passage text and the probed `frac`; going back to
   * the result list to look them up would let the band outlive a re-query that
   * no longer contains that chunk.
   */
  const [meaningPick, setMeaningPick] = useState<MeaningPick | null>(null)
  /** Keyboard cursor into the candidate list, driven from the input. */
  const [meaningCursor, setMeaningCursor] = useState(0)
  /** chunk id -> probed position, so Enter cannot choose a row that has no place. */
  const meaningReachRef = useRef<Map<number, number>>(new Map())
  const handleMeaningReach = useCallback((byChunk: Map<number, number>) => {
    meaningReachRef.current = byChunk
  }, [])

  /**
   * Debounced query text for the vector search.
   *
   * Verbatim find runs per keystroke because an `indexOf` over an index that is
   * already built is free. A meaning search is an ONNX forward pass plus a k-NN
   * per call, so keystroke-rate queries would queue a forward pass per letter
   * and answer the reader's half-typed sentences.
   */
  const [meaningQuery, setMeaningQuery] = useState('')
  useEffect(() => {
    if (findQuery === null || findMode !== 'meaning') {
      setMeaningQuery('')
      return
    }
    const t = setTimeout(() => setMeaningQuery(findQuery), 220)
    return () => clearTimeout(t)
  }, [findQuery, findMode])

  const meaning = useAsync<SemanticSearchResultDTO | null>(
    () =>
      findMode === 'meaning' && meaningQuery.trim().length > 0
        ? window.api.semanticSearch(meaningQuery, undefined, FIND_MEANING_K, workId)
        : Promise.resolve(null),
    [meaningQuery, findMode, workId]
  )

  // A pick made against a previous query, paper or mode is a band with nothing
  // behind it — the row that justified it is no longer on screen. The reach map
  // is emptied with it: it is the list Enter chooses from, and a map left over
  // from the previous result set would let a keypress pick a chunk that is no
  // longer displayed.
  useEffect(() => {
    setMeaningPick(null)
    setMeaningCursor(0)
    meaningReachRef.current = new Map()
  }, [meaningQuery, findMode, workId])

  const closeFind = useCallback(() => {
    setFindQuery(null)
    setFindHits([])
    setFindAt(0)
    setMeaningPick(null)
    setMeaningCursor(0)
  }, [])

  /**
   * Whether the dropdown is currently showing a LISTBOX rather than a sentence.
   *
   * The panel renders prose for loading, for an unembedded paper, for an error
   * and for no close passages — in all of which `aria-expanded=true` and an
   * `aria-controls` pointing at the list's id would describe an element that is
   * not in the document.
   */
  const meaningListShown =
    findMode === 'meaning' &&
    !meaning.loading &&
    !meaning.error &&
    meaningQuery.trim().length > 0 &&
    meaning.data !== null &&
    meaning.data.error === null &&
    meaning.data.hits.length > 0
  /** The candidate the arrow keys are on, for `aria-activedescendant`. */
  const meaningCursorHit = meaningListShown
    ? (meaning.data?.hits[meaningCursor] ?? null)
    : null

  /**
   * The by-meaning line in the count slot.
   *
   * It never says "n of m": there is no cycle to be at position n of. It says
   * what the reader is looking at and, when the list is full, that ten is a
   * budget rather than a total — a bare "10" would read as "this paper contains
   * ten passages about that", which the search cannot know.
   */
  const meaningReadout = ((): string => {
    if (findQuery === null) return ''
    if (findQuery.trim().length === 0) return ''
    if (meaning.loading || meaningQuery !== findQuery) return 'comparing…'
    const hits = meaning.data?.hits ?? []
    if (meaning.data?.error) return 'unavailable here'
    if (hits.length === 0) return 'nothing close'
    if (meaningPick) {
      const at = hits.findIndex((h) => h.chunk_id === meaningPick.chunkId)
      return at >= 0
        ? `showing #${at + 1} · page ${meaningPick.page ?? '—'}`
        : `page ${meaningPick.page ?? '—'}`
    }
    return hits.length === FIND_MEANING_K ? `closest ${FIND_MEANING_K}` : `${hits.length} close`
  })()

  /**
   * Flip the mode. The bar keeps its text: the reader asked the SAME question a
   * different way, and clearing it would make the switch cost a retype.
   */
  const toggleFindMode = useCallback(
    (
      /**
       * Whether to return focus to the text field.
       *
       * True when the switch was operated from the field (Tab) or from a click,
       * where the reader's next act is typing. FALSE when the arrow keys drove
       * it from inside the group: pulling focus out of the control being
       * operated would make a second arrow press go somewhere else, and the
       * roving tabIndex re-points at the newly selected option, which is where
       * a radiogroup is supposed to leave focus.
       */
      refocusInput = true
    ) => {
      const next: FindMode = findMode === 'verbatim' ? 'meaning' : 'verbatim'
      setFindMode(next)
      setMeaningPick(null)
      setMeaningCursor(0)
      meaningReachRef.current = new Map()
      if (refocusInput) {
        findInputRef.current?.focus()
        return
      }
      // The option that just became selected is the one that is now tabbable;
      // the one holding focus is about to have tabIndex -1, which would drop
      // focus to the body when it re-renders.
      requestAnimationFrame(() => {
        modesRef.current
          ?.querySelector<HTMLButtonElement>(`[data-testid="pdf-find-mode-${next}"]`)
          ?.focus()
      })
    },
    [findMode]
  )

  const stepFind = useCallback(
    (delta: number) => {
      setFindAt((cur) => {
        if (findHits.length === 0) return 0
        // Wraps in both directions: reaching the end of a document and being
        // told "no more" is a dead end, whereas every find bar the user has
        // ever used cycles.
        return (cur + delta + findHits.length) % findHits.length
      })
    },
    [findHits.length]
  )

  // Ctrl/Cmd+F opens the bar and focuses it; Escape closes it. Bound on the
  // window so it works wherever focus sits within the paper view — but only
  // while this tab is the VISIBLE one. Several paper tabs are mounted at once
  // now, and an ungated window listener would have every one of them answer the
  // same Ctrl+F, putting the caret in a find box the user cannot see.
  useVisibleWindowListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault()
      setFindQuery((cur) => cur ?? '')
      // After the bar has mounted. Selecting the existing text means a second
      // Ctrl+F retypes rather than appends, which is the familiar behaviour.
      requestAnimationFrame(() => {
        findInputRef.current?.focus()
        findInputRef.current?.select()
      })
      return
    }
    if (e.key === 'Escape' && findQuery !== null) {
      e.preventDefault()
      closeFind()
    }
  })

  // ------------------------------------------------- selected citation place --
  // The ONE citation context whose passage is shown in the document. Held as the
  // whole DTO rather than an id because the highlight needs its text, and going
  // back to the list to look it up would let the highlight outlive a reload that
  // no longer contains it.
  const [selectedCite, setSelectedCite] = useState<CitationContextDTO | null>(null)
  /**
   * context id -> where in the document its passage was found (0..1).
   *
   * Reported by the list's reachability pass and handed straight back to the
   * viewer as `frac`. Without it the locator resolves a repeated sentence — a
   * bibliography line, a running header, a stock citance — against its own
   * running cursor, which has already advanced past the selected run's evidence
   * spans. The band would then land on a DIFFERENT occurrence depending on
   * which analysis run happened to be selected.
   */
  const citeFracRef = useRef<Map<number, number>>(new Map())
  const [citeFracVersion, setCiteFracVersion] = useState(0)
  const handleCiteLocated = useCallback((fracById: Map<number, number>) => {
    citeFracRef.current = fracById
    setCiteFracVersion((n) => n + 1)
  }, [])
  // A context selected on the previous paper (or before a reload dropped it)
  // would highlight a passage that is not on screen.
  useEffect(() => {
    setSelectedCite(null)
  }, [workId])
  const citeRows = citations.data
  useEffect(() => {
    if (!citeRows || !selectedCite) return
    if (!citeRows.some((c) => c.id === selectedCite.id)) setSelectedCite(null)
  }, [citeRows, selectedCite])

  const highlights: PdfHighlight[] = useMemo(() => {
    // A `quote` deep link (Connectome → citation context) is a passage with NO
    // evidence_span row, so there is no stored annId to activate. It becomes a
    // highlight in its own right, on the SAME path evidence spans use: the
    // viewer locates the text, draws a band, and the `active` id below scrolls
    // it into view. It takes precedence over the run's evidence because it is
    // the reason the reader was sent here.
    if (focusQuote && focusQuote.trim().length > 0) {
      return [
        {
          annId: CITATION_ANN_ID,
          text: focusQuote,
          severity: 'medium',
          domain: 'issue',
          color: 'var(--accent)'
        }
      ]
    }
    // Find results REPLACE evidence highlights while searching: showing both
    // would leave the reader unable to tell which tint is their search and which
    // is the model's claim, and the find bar is a deliberate, temporary mode.
    // By meaning: ONE passage, the one the reader chose. Not every candidate —
    // ten simultaneous bands would say the paper is ten places at once, and the
    // reader picked a place. `frac` is the position the probe actually found,
    // which is what stops the band landing on a different occurrence of a
    // passage that repeats.
    if (activeMode === 'meaning') {
      return meaningPick
        ? [
            {
              annId: MEANING_ANN_ID,
              text: meaningPick.text,
              severity: 'medium' as const,
              domain: 'issue' as const,
              color: 'var(--accent)',
              frac: meaningPick.frac
            }
          ]
        : []
    }
    if (findQuery !== null && findHits.length > 0) {
      return findHits.map((h, i) => ({
        annId: h.annId,
        text: h.text,
        severity: 'medium',
        domain: 'issue',
        // The current hit is distinguished from the rest by tint AND by the
        // "n of m" readout, so it survives a colourblind reader.
        color: i === findAt ? 'var(--accent)' : 'var(--ev-2)',
        // These are exact substrings of the document, so a short query must not
        // be rejected by the evidence locator's minimum-length guard.
        minMatch: 2,
        // The occurrence the search actually found. Without it every hit for a
        // repeated phrase resolves against the locator's shared cursor, and the
        // hits of a "4 of 12" readout stack onto the same few places.
        frac: h.frac
      }))
    }
    const ev: PdfHighlight[] = (selectedRun?.evidence ?? [])
      // `verbatim` is the pipeline's finding that the page printed this wording
      // as one unbroken run. A quote that failed it is usually STITCHED: every
      // fragment is present in the paragraph, in order, but across cells the
      // page never joined — so a band drawn from it stretches the full width of
      // the table, from the row label to a number in the last column, tinted
      // exactly like evidence. Seen on KE70's Table 2, where four such rows each
      // painted a line across six columns of values they do not cite.
      //
      // Scoping cannot catch this: those quotes ARE contiguous in the extracted
      // text and only the pdf.js layout reveals that the page disagrees. So the
      // flag is consulted, at the cost of 26 highlights across the corpus.
      .filter((e) => e.verbatim && e.quote && e.quote.trim().length > 0)
      .map((e) => ({
        annId: `ev-${e.id}`,
        text: e.quote as string,
        severity: 'medium',
        domain: 'issue',
        color: spanColors.get(`ev-${e.id}`) ?? 'var(--ev-1)',
        // The paragraph the span already names. Scoping is what lets a single
        // table cell anchor; unscoped the locator needs twelve canonical
        // characters and a kinetics cell has eight.
        scopeText: e.paragraph != null ? paraById.get(e.paragraph) : undefined
      }))
    // A citation place the reader picked joins the evidence spans rather than
    // replacing them: unlike find (a deliberate temporary mode over the whole
    // document) this is one passage, and blanking the run's evidence for it
    // would leave every claim card in the column pointing at nothing. It takes
    // the accent tint and is the `active` id, so it is the one that is scrolled
    // to and ringed.
    const cite = selectedCite ? citeNeedle(selectedCite) : null
    if (selectedCite && cite) {
      ev.push({
        annId: citeAnnId(selectedCite.id),
        text: cite,
        severity: 'medium',
        domain: 'issue',
        color: 'var(--accent)',
        // The occurrence the reachability pass actually found. `frac` also
        // takes the locator off its cursor-relative path, so the band no longer
        // depends on how far the evidence spans above it advanced the cursor.
        frac: citeFracRef.current.get(selectedCite.id)
      })
    }
    return ev
  }, [
    selectedRun,
    spanColors,
    findQuery,
    findHits,
    findAt,
    focusQuote,
    selectedCite,
    citeFracVersion,
    activeMode,
    meaningPick,
    paraById
  ])

  // ---------------------------------------------------------------- linking --
  // Which evidence spans ACTUALLY anchored to text in the PDF. PdfDocView
  // reports this via `onAnchoredIds` once its draw loop finishes (ai-detector's
  // `anchoredDomIds`). It is keyed by run+document so a stale set from the
  // previous run can never gate the new run's facts: on a key mismatch we fall
  // back to the OPTIMISTIC set (every highlight id) rather than an empty one,
  // so cards are never briefly-then-wrongly marked un-anchored while the
  // asynchronous locate pass is still running.
  const linkKey = `${selectedRun?.id ?? 'none'}:${pdfDoc?.id ?? 'none'}`
  /**
   * The same key, plus the selected citation.
   *
   * Selecting a citation ADDS a highlight, so an anchored set reported for the
   * PREVIOUS highlight list still matches `linkKey` — and the new band is
   * judged missing the instant it is requested, before the viewer has had a
   * chance to draw it. That dropped the selection within a frame of the press
   * and looked exactly like a dead button.
   *
   * It is a SECOND key rather than a widening of `linkKey` because the claim
   * cards must not be affected: putting the citation into `linkKey` made every
   * selection invalidate the evidence spans' anchored set too, so claims that
   * had already been refused briefly re-claimed traceability.
   */
  const citeLinkKey = `${linkKey}:${selectedCite?.id ?? 'none'}:${meaningPick?.chunkId ?? 'none'}`
  const [anchored, setAnchored] = useState<{ key: string; ids: Set<string> } | null>(null)
  // Assigned during RENDER, not in an effect: React flushes the CHILD's effects
  // before the parent's, so PdfDocView's synchronous `onAnchoredIds(new Set())`
  // (the no-file / error settle path) would otherwise be recorded under the
  // PREVIOUS key and then never corrected, leaving `anchorable` stuck on the
  // optimistic set with every claim falsely marked traceable.
  const linkKeyRef = useRef(citeLinkKey)
  linkKeyRef.current = citeLinkKey
  useEffect(() => {
    // A span selected under the previous run/document is meaningless now — EXCEPT
    // the one a deep link just asked for. Selecting its owning run is what
    // changes `linkKey` in the first place, so clearing unconditionally would
    // erase the very span that triggered the switch.
    setActiveSpan((cur) =>
      focusEvidenceId !== undefined && cur === `ev-${focusEvidenceId}` ? cur : null
    )
  }, [linkKey, focusEvidenceId])

  const handleAnchoredIds = useCallback((ids: Set<string>) => {
    const key = linkKeyRef.current
    setAnchored((prev) => {
      // Skip the state update when nothing changed — this setter runs from
      // PdfDocView's draw effect, whose deps include this very callback's
      // consumers, so an unconditional update would loop.
      if (prev && prev.key === key && prev.ids.size === ids.size) {
        let same = true
        for (const id of ids) if (!prev.ids.has(id)) { same = false; break }
        if (same) return prev
      }
      return { key, ids }
    })
  }, [])

  // Authoritative once reported for THIS key; optimistic (all ids) until then.
  // With no document at all nothing can ever anchor, so the set is empty and
  // every fact is honestly marked un-traceable.
  // Matched on the RUN+DOCUMENT prefix rather than the whole key: a citation
  // being selected or cleared changes nothing about which evidence spans
  // anchored, so treating that report as stale would flip every claim card back
  // to optimistically-traceable on each press.
  const anchorable = useMemo<Set<string>>(() => {
    if (!pdfDoc) return new Set()
    if (anchored && anchored.key.startsWith(`${linkKey}:`)) return anchored.ids
    return new Set(highlights.map((h) => h.annId))
  }, [pdfDoc, anchored, linkKey, highlights])

  // If the authoritative anchored set arrives AFTER the user clicked a card
  // during the optimistic window and excludes that span, drop the selection —
  // otherwise the card would render both active and inert with no PDF band.
  useEffect(() => {
    if (activeSpan && !anchorable.has(activeSpan)) setActiveSpan(null)
  }, [activeSpan, anchorable])

  /**
   * Citation contexts the viewer TRIED to draw and could not.
   *
   * The list's own reachability probe is a prediction made from the text index;
   * this is the viewer's report of what actually anchored, and it is the source
   * of truth. Accumulated rather than replaced because only the selected
   * context is ever a highlight, so each refusal is learned once and must
   * outlive the selection that revealed it — otherwise deselecting would make
   * the card look navigable again and the reader would press it forever.
   * Reset per document, since a different PDF is a different question.
   */
  const [unanchoredCites, setUnanchoredCites] = useState<Set<number>>(() => new Set())
  useEffect(() => {
    setUnanchoredCites(new Set())
  }, [pdfDoc?.id])
  useEffect(() => {
    if (!selectedCite) return
    if (!anchored || anchored.key !== citeLinkKey) return
    const annId = citeAnnId(selectedCite.id)
    // Only conclude anything about a context we actually ASKED the viewer to
    // draw. A context absent from `highlights` is absent from `anchored.ids`
    // for a trivial reason, and reading that as a refusal would mark every
    // unselected card inert.
    if (!highlights.some((h) => h.annId === annId)) return
    const failed = !anchored.ids.has(annId)
    setUnanchoredCites((cur) => {
      if (cur.has(selectedCite.id) === failed) return cur
      const next = new Set(cur)
      if (failed) next.add(selectedCite.id)
      else next.delete(selectedCite.id)
      return next
    })
  }, [anchored, citeLinkKey, selectedCite, highlights])

  // A context the viewer refused cannot stay selected: the card must go inert,
  // and a selected-but-inert card is the exact contradiction this screen is not
  // allowed to render.
  useEffect(() => {
    if (selectedCite && unanchoredCites.has(selectedCite.id)) setSelectedCite(null)
  }, [selectedCite, unanchoredCites])

  /**
   * By-meaning candidates the viewer TRIED to draw and could not.
   *
   * The dropdown's probe is a PREDICTION made from the text index; this is the
   * viewer's report of what actually anchored, and it is the source of truth.
   * Without it a passage the probe located but the locator then refused left the
   * row marked as the one being shown, the readout saying "showing #3 · page 5",
   * and no band anywhere in the document — a card claiming a place it never
   * reached, which is the failure this screen is not allowed to render.
   *
   * Accumulated rather than replaced, because only the PICKED candidate is ever
   * a highlight: each refusal is learned once and must outlive the selection
   * that revealed it, or re-picking would look navigable again forever. Reset
   * per document, since a different PDF is a different question.
   */
  const [unanchoredMeaning, setUnanchoredMeaning] = useState<Set<number>>(() => new Set())
  useEffect(() => {
    setUnanchoredMeaning(new Set())
  }, [pdfDoc?.id])
  useEffect(() => {
    if (!meaningPick) return
    if (!anchored || anchored.key !== citeLinkKey) return
    // Only conclude anything about a passage we actually ASKED the viewer to
    // draw; absence from a highlight list that never contained it is not a
    // refusal.
    if (!highlights.some((h) => h.annId === MEANING_ANN_ID)) return
    if (anchored.ids.has(MEANING_ANN_ID)) return
    setUnanchoredMeaning((cur) => {
      if (cur.has(meaningPick.chunkId)) return cur
      const next = new Set(cur)
      next.add(meaningPick.chunkId)
      return next
    })
  }, [anchored, citeLinkKey, meaningPick, highlights])

  // A refused passage cannot stay picked, for the same reason a refused citation
  // cannot stay selected.
  useEffect(() => {
    if (meaningPick && unanchoredMeaning.has(meaningPick.chunkId)) setMeaningPick(null)
  }, [meaningPick, unanchoredMeaning])

  // Opening find, or arriving on a deep link, hands the whole document to
  // something else. A citation left selected would go on saying it is the
  // passage on screen while its band had been replaced.
  const viewerTaken =
    (focusQuote !== undefined && focusQuote.trim().length > 0) || findQuery !== null
  useEffect(() => {
    if (viewerTaken) setSelectedCite(null)
  }, [viewerTaken])

  /** Smooth-center a claim card inside the analysis column (`smoothCenter`). */
  const focusInAnalysis = useCallback((spanId: string) => {
    requestAnimationFrame(() => {
      const container = analysisRef.current
      if (!container) return
      const el = container.querySelector<HTMLElement>(`[data-aid="${CSS.escape(spanId)}"]`)
      if (!el) return
      const cr = container.getBoundingClientRect()
      const er = el.getBoundingClientRect()
      const top =
        container.scrollTop + (er.top - cr.top) - (container.clientHeight / 2 - er.height / 2)
      container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
    })
  }, [])

  /** Claim card -> PDF. Activating a span makes PdfDocView scroll + focus it. */
  const activateSpan = useCallback(
    (spanId: string) => {
      setActiveSpan((cur) => (cur === spanId ? null : spanId))
      // Exactly ONE thing is "the passage being shown". Leaving a citation
      // selected while a claim takes the focus ring would give the reader two
      // cards both saying they are the one on screen.
      setSelectedCite(null)
      focusInAnalysis(spanId)
    },
    [focusInAnalysis]
  )

  /** A citation place -> PDF, on the same terms as a claim card. */
  const selectCite = useCallback((c: CitationContextDTO | null) => {
    setSelectedCite(c)
    if (c) setActiveSpan(null)
  }, [])

  /** PDF highlight -> claim card (ai-detector `onPdfHighlightClick`). A band can
   *  be shared by several spans (`data-ann-ids` union); repeated clicks step
   *  through them and then toggle off, so every co-located fact is reachable. */
  const handleHighlightClick = useCallback(
    (ids: string[]) => {
      if (!ids.length) return
      const cur = activeSpanRef.current
      const at = cur ? ids.indexOf(cur) : -1
      const next = at === -1 ? ids[0] : (at + 1 < ids.length ? ids[at + 1] : null)
      setActiveSpan(next)
      if (next) focusInAnalysis(next)
    },
    [focusInAnalysis]
  )

  // No paper selected (e.g. the sidebar "Paper detail" opened cold). Show a
  // guiding empty state instead of firing an IPC call with an undefined id.
  if (!hasWork) {
    return (
      <div className="screen paper-screen" data-testid="screen-paper">
        <EmptyState
          testid="paper-no-selection"
          title="Select a paper to view its evidence."
          hint="Open a paper from the connectome or the ranking to see its claims, provenance and citation contexts."
        >
          <div className="empty-state-actions">
            <button
              type="button"
              className="btn btn-primary"
              data-testid="paper-go-graph"
              onClick={onGoToGraph}
              disabled={!onGoToGraph}
            >
              Open the connectome
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              data-testid="paper-go-ranking"
              onClick={onGoToRanking}
              disabled={!onGoToRanking}
            >
              Open the ranking
            </button>
          </div>
        </EmptyState>
      </div>
    )
  }

  return (
    <div className="screen paper-screen" data-testid="screen-paper">
      <DataView state={work} isEmpty={(d) => d === null} empty={<EmptyState title="Work not found." />}>
        {(w) =>
          w && (
            <div className="pv-grid">
              {/* ============ LEFT: Evidence viewer ============ */}
              <section
                className={`pv-viewer ${expanded ? 'pv-viewer-expanded' : ''}`}
                ref={viewerRef}
                data-testid="paper-pdf-panel"
              >
                {/* Toolbar: REAL controls only. The former "Full text ·
                    Publisher PDF" pill moved into the paper header block next
                    to the title (R12: an abstract-only analysis must never be
                    presented as full-text-backed). */}
                <header className="pv-viewer-head">
                  <div className="pv-zoom-group" role="group" aria-label="Document zoom">
                    <button
                      type="button"
                      className="pv-zoom-tile"
                      data-testid="pdf-zoom-out"
                      aria-label="Zoom out"
                      onClick={zoomOut}
                      disabled={!canZoomOut}
                    >
                      <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                        <circle cx="9" cy="9" r="5.5" />
                        <path d="M6.6 9h4.8M13 13l4 4" />
                      </svg>
                    </button>
                    <span className="pv-zoom-level mono" data-testid="pdf-zoom-level" aria-live="polite">
                      {Math.round((scale / PDF_DEFAULT_SCALE) * 100)}%
                    </span>
                    <button
                      type="button"
                      className="pv-zoom-tile"
                      data-testid="pdf-zoom-in"
                      aria-label="Zoom in"
                      onClick={zoomIn}
                      disabled={!canZoomIn}
                    >
                      <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                        <circle cx="9" cy="9" r="5.5" />
                        <path d="M6.6 9h4.8M9 6.6v4.8M13 13l4 4" />
                      </svg>
                    </button>
                  </div>
                  <button
                    type="button"
                    className="pv-zoom-tile pv-viewer-expand"
                    data-testid="pdf-fullscreen"
                    aria-label={expanded ? 'Exit full screen document view' : 'Full screen document view'}
                    aria-pressed={expanded}
                    onClick={toggleExpanded}
                  >
                    <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                      {expanded ? (
                        <path d="M8 3v5H3M12 17v-5h5" />
                      ) : (
                        <path d="M7.5 3H3v4.5M12.5 17H17v-4.5M17 7.5V3h-4.5M3 12.5V17h4.5" />
                      )}
                    </svg>
                  </button>
                </header>
                {findQuery !== null && (
                  <div className="pv-find" data-testid="pdf-find" data-mode={findMode}>
                    {/* The switch sits BEFORE the text, because it changes what
                        typing into the box will mean. A control that reframes
                        the field it follows is read after the decision it
                        governs has already been made. */}
                    <div
                      ref={modesRef}
                      className="pv-find-modes"
                      role="radiogroup"
                      aria-label="How to match: verbatim or by meaning"
                      data-testid="pdf-find-modes"
                    >
                      {(['verbatim', 'meaning'] as const).map((m) => (
                        <button
                          key={m}
                          type="button"
                          className="pv-find-mode"
                          role="radio"
                          aria-checked={findMode === m}
                          data-testid={`pdf-find-mode-${m}`}
                          data-on={findMode === m ? '1' : undefined}
                          // Only the SELECTED option is in the tab order, which
                          // is how a radio group behaves everywhere: Tab moves
                          // past the whole group rather than through each of its
                          // options, and here Tab has a job of its own.
                          tabIndex={findMode === m ? 0 : -1}
                          data-tip={
                            m === 'verbatim'
                              ? 'Match the characters you type, exactly. Press Tab to switch.'
                              : 'Rank whole passages of this paper by closeness in meaning. Your words need not appear in them. Press Tab to switch.'
                          }
                          onClick={() => {
                            if (findMode !== m) toggleFindMode()
                          }}
                          onKeyDown={(e) => {
                            // A radiogroup is operated with the arrow keys, not
                            // by tabbing between its options — the roving
                            // tabIndex above takes Tab past the group, so
                            // without this the switch is announced as a
                            // radiogroup and then does not behave like one.
                            if (
                              e.key === 'ArrowRight' ||
                              e.key === 'ArrowLeft' ||
                              e.key === 'ArrowDown' ||
                              e.key === 'ArrowUp'
                            ) {
                              e.preventDefault()
                              // Two options, so any arrow means "the other
                              // one"; the group cannot be left unchanged by a
                              // key the user pressed to change it.
                              toggleFindMode(false)
                            }
                          }}
                        >
                          {m === 'verbatim' ? 'Verbatim' : 'By meaning'}
                        </button>
                      ))}
                    </div>
                    <svg
                      className="pv-find-icon"
                      width="14"
                      height="14"
                      viewBox="0 0 20 20"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.8}
                      aria-hidden="true"
                    >
                      {findMode === 'meaning' ? (
                        <>
                          <circle cx="9" cy="9" r="5.5" />
                          <path d="M6.4 9h5.2M9 6.4v5.2" strokeLinecap="round" />
                        </>
                      ) : (
                        <>
                          <circle cx="9" cy="9" r="5.5" />
                          <path d="M13 13l4 4" strokeLinecap="round" />
                        </>
                      )}
                    </svg>
                    <input
                      ref={findInputRef}
                      className="pv-find-input"
                      data-testid="pdf-find-input"
                      placeholder={
                        findMode === 'meaning'
                          ? 'Describe what this paper should be saying'
                          : 'Find in this paper'
                      }
                      aria-label={
                        findMode === 'meaning'
                          ? 'Search this paper by meaning'
                          : 'Find in this paper'
                      }
                      aria-describedby={
                        findMode === 'meaning' ? 'pdf-find-mode-hint' : undefined
                      }
                      // A listbox the arrow keys drive, announced as one. Only
                      // in meaning mode: verbatim has no list, and claiming a
                      // popup that is not there sends a screen-reader user
                      // looking for it.
                      //
                      // `aria-expanded` follows whether the LIST IS RENDERED,
                      // not merely whether the mode is on: the panel shows a
                      // sentence rather than a listbox while loading, while the
                      // paper is unembedded and when nothing came close, and a
                      // hardcoded `true` would point `aria-controls` at an id
                      // that does not exist in any of those states.
                      role={findMode === 'meaning' ? 'combobox' : undefined}
                      aria-expanded={findMode === 'meaning' ? meaningListShown : undefined}
                      aria-controls={meaningListShown ? MEANING_LIST_ID : undefined}
                      // Which option the arrow keys are on. The visual cursor
                      // is `data-cursor`; without this it is invisible to a
                      // screen reader, which was the largest gap here.
                      aria-activedescendant={
                        meaningListShown && meaningCursorHit
                          ? meaningRowId(meaningCursorHit.chunk_id)
                          : undefined
                      }
                      aria-autocomplete={findMode === 'meaning' ? 'list' : undefined}
                      value={findQuery}
                      onKeyDown={(e) => {
                        // Tab flips the mode WHILE THE INPUT ITSELF IS FOCUSED,
                        // and only unmodified. It is borrowed in exactly one
                        // element, not taken from the page:
                        //
                        //   · Shift+Tab is untouched, so backwards focus travel
                        //     out of the bar always works;
                        //   · Escape closes the bar entirely, from anywhere;
                        //   · every OTHER control in the bar — the mode switch,
                        //     the step buttons, close — tabs forwards normally,
                        //     because this handler is on the input alone.
                        //
                        // What it genuinely costs is the FORWARD hop from the
                        // input to the controls that follow it. Those are not
                        // stranded: Shift+Tab from the viewer body below reaches
                        // them, and every one of them also has a key of its own
                        // — Enter and Shift+Enter step the matches, Escape
                        // closes — so no function of this bar depends on landing
                        // on its button.
                        if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
                          e.preventDefault()
                          toggleFindMode()
                          return
                        }
                        if (findMode === 'meaning') {
                          // Arrow keys walk the candidates and Enter opens the
                          // one under the cursor — the list is a listbox, not a
                          // cycle of matches, so there is nothing for Enter to
                          // "step" through.
                          const rows = meaning.data?.hits ?? []
                          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                            if (rows.length === 0) return
                            e.preventDefault()
                            setMeaningCursor(
                              (c) =>
                                (c + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length
                            )
                            return
                          }
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            const hit = rows[meaningCursor]
                            if (!hit) return
                            const frac = meaningReachRef.current.get(hit.chunk_id)
                            // A candidate that could not be located has nowhere
                            // to go. Enter does nothing rather than selecting a
                            // row that would draw no band.
                            if (frac === undefined) return
                            setMeaningPick({
                              chunkId: hit.chunk_id,
                              text: hit.text,
                              frac,
                              page: hit.page
                            })
                            return
                          }
                          return
                        }
                        // Enter walks the results, Shift+Enter walks back — the
                        // same keys every find bar uses.
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          stepFind(e.shiftKey ? -1 : 1)
                        }
                      }}
                      onChange={(e) => setFindQuery(e.target.value)}
                    />
                    <span className="pv-find-count mono" aria-live="polite">
                      {findMode === 'meaning'
                        ? meaningReadout
                        : findQuery.trim().length === 0
                          ? ''
                          : findHits.length === 0
                            ? 'no matches'
                            : `${findAt + 1} of ${findHits.length} · page ${findHits[findAt]?.page ?? '—'}`}
                    </span>
                    {/* Stepping is a verbatim idea. A ranked list of passages
                        has no "next occurrence" to walk to, so rather than
                        leaving two buttons that would silently do nothing, the
                        mode shows the keys that DO apply to it. */}
                    {findMode === 'verbatim' ? (
                      <>
                        <button
                          type="button"
                          className="pv-find-step"
                          data-testid="pdf-find-prev"
                          data-tip="Previous match (Shift+Enter)"
                          aria-label="Previous match"
                          disabled={findHits.length === 0}
                          onClick={() => stepFind(-1)}
                        >
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M3 7.5L6 4.5L9 7.5" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className="pv-find-step"
                          data-testid="pdf-find-next"
                          data-tip="Next match (Enter)"
                          aria-label="Next match"
                          disabled={findHits.length === 0}
                          onClick={() => stepFind(1)}
                        >
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M3 4.5L6 7.5L9 4.5" />
                          </svg>
                        </button>
                      </>
                    ) : (
                      <span className="pv-find-keys" id="pdf-find-mode-hint">
                        <kbd>↑</kbd>
                        <kbd>↓</kbd> choose · <kbd>Tab</kbd> verbatim
                      </span>
                    )}
                    <button
                      type="button"
                      className="pv-find-close"
                      data-testid="pdf-find-close"
                      data-tip="Close find (Esc)"
                      aria-label="Close find"
                      onClick={closeFind}
                    >
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
                        <path d="M3 3l6 6M9 3l-6 6" />
                      </svg>
                    </button>
                  </div>
                )}
                {/* Below the bar rather than floating over the page: the
                    candidates ARE the answer in this mode, and an overlay would
                    cover the document they point into. */}
                {findQuery !== null && findMode === 'meaning' && (
                  <FindByMeaning
                    state={meaning}
                    query={meaningQuery.length > 0 ? meaningQuery : findQuery}
                    findApi={findApiRef.current}
                    findEpoch={findEpoch}
                    textState={pdfTextState}
                    pickedChunkId={meaningPick?.chunkId ?? null}
                    unanchored={unanchoredMeaning}
                    activeIndex={meaningCursor}
                    onActiveIndexChange={setMeaningCursor}
                    onPick={setMeaningPick}
                    onReachChange={handleMeaningReach}
                  />
                )}
                <div className="pv-viewer-body">
                  {pdfDoc ? (
                    <PdfDocView
                      key={pdfDoc.id}
                      documentId={pdfDoc.id}
                      scrollRef={scrollRef}
                      scale={scale}
                      highlights={highlights}
                      // While finding, the ACTIVE highlight is the current hit,
                      // so the viewer's existing scroll-to-active brings it into
                      // view — stepping through results needs no new machinery.
                      active={
                        focusQuote && focusQuote.trim().length > 0
                          ? CITATION_ANN_ID
                          : activeMode === 'meaning'
                            ? (meaningPick ? MEANING_ANN_ID : null)
                            : findQuery !== null && findHits.length > 0
                              ? (findHits[findAt]?.annId ?? null)
                              : selectedCite
                                ? citeAnnId(selectedCite.id)
                                : activeSpan
                      }
                      onHighlightClick={handleHighlightClick}
                      onAnchoredIds={handleAnchoredIds}
                      onFindApi={handleFindApi}
                      onTextState={setPdfTextState}
                    />
                  ) : (
                    <div className="pdf-col pdf-nofile" data-testid="pdf-nofile">
                      <div className="pdf-loading-box">
                        {/* WHY there is nothing here, not merely that there is
                            nothing. "No source document" is the same sentence
                            for a paper whose PDF is paywalled, one the retriever
                            could not reach a source for, and one nothing ever
                            tried to fetch — and those have different remedies.
                            Read from `retrieval_status`, which is the record of
                            what the app actually attempted. */}
                        <span className="pdf-loading-label" data-testid="pdf-nofile-label">
                          {retrievalMessage(docs.data ?? [])}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </section>

              {/* ============ RIGHT: Analysis + provenance ============ */}
              <section className="pv-analysis" ref={analysisRef} data-testid="paper-analysis">
                {/* header block: tags, title, authors, doi, x/10 bars */}
                <div className="pv-head-block">
                  <div className="pv-tags">
                    {/* Constant dark "primary" chip (design markup L176): the
                        filled chip is a category label, not the raw work_type +
                        inline colour. Mapped label falls back to the humanised
                        work_type; `.pv-tag-fill` supplies the --ink/white fill. */}
                    <span
                      className="pv-tag-fill"
                      data-tip="What kind of publication this is."
                    >
                      {workTypeLabel(w.work_type)}
                    </span>
                    {/* Evidence basis — the SHORTFALL only. Full text is what a
                        reader already assumes an analysis stood on, and a green
                        chip saying so on every paper takes the tenth paper's
                        "abstract only" down with it. An abstract-only or
                        metadata-only basis is never to be read as
                        full-text-backed, so that case still speaks. */}
                    {pdfDoc && pdfDoc.content_status !== 'fulltext' && (
                      <span
                        className={`badge badge-${contentStatusMeta(pdfDoc.content_status).cls} pv-basis-badge`}
                        data-testid="paper-content-basis"
                        data-tip="How much of the source every analysis below could actually read. The full text is NOT available, so these analyses saw only this much."
                      >
                        read: {contentStatusMeta(pdfDoc.content_status).label}
                      </span>
                    )}
                    {/* HOW the text was read, beside how much of it we have.
                        The two are orthogonal: an OCR'd scan is the full text,
                        imperfectly. A number lifted out of recognised
                        characters is materially less trustworthy than one read
                        from a publisher's text layer, and the user weighing it
                        cannot tell the difference from the analysis alone. */}
                    {pdfDoc &&
                      (() => {
                        const ts = textSourceMeta(
                          pdfDoc.text_source,
                          pdfDoc.text_confidence,
                          OCR_LOW_CONFIDENCE
                        )
                        if (!ts) return null
                        return (
                          <span
                            className={`badge badge-${ts.cls} pv-basis-badge`}
                            data-testid="paper-text-source"
                            data-tip={ts.hint}
                          >
                            {ts.label}
                            {pdfDoc.text_source === 'ocr' &&
                              pdfDoc.text_confidence !== null && (
                                <span className="pv-basis-num mono">
                                  {pdfDoc.text_confidence.toFixed(0)}%
                                </span>
                              )}
                          </span>
                        )
                      })()}
                    {/* Secondary chips are LOWERCASE topic tags (design L177-178),
                        not identifier schemes. The work DTO carries no topic /
                        keyword / concept field, so — per the no-fabrication rule —
                        render nothing rather than the DOI/PMID scheme names. */}
                  </div>
                  <h2 className="pv-title"><RichText text={w.title} /></h2>
                  {w.authors.length > 0 && (
                    <div className="pv-authors">
                      {w.authors
                        .slice()
                        .sort((a, b) => a.position - b.position)
                        .map((a) => a.full_name)
                        .join('; ')}
                    </div>
                  )}
                  {w.identifiers.length > 0 && (
                    <div className="pv-doi mono">
                      {w.identifiers[0].scheme}:{w.identifiers[0].value}
                    </div>
                  )}

                  {/* Actions get their own row, BELOW the identity of the paper
                      and away from the chips: a chip states a fact about the
                      work, this changes something. Sitting among the badges it
                      read as one more label. Offered here as well as on Ranking
                      because "do I trust this enough to read other papers
                      through it" is decided while reading, not while scanning a
                      list.

                      The dossier toggle needs a project_work row to write to,
                      so it is absent when the paper is not in this project. The
                      summaries are not: reading one changes nothing, and the
                      general summary is a property of the work itself. */}
                  <div className="pv-actions">
                    {rankRow && (
                      <DossierToggle
                        atLimit={atDossierLimit}
                        on={rankRow.is_reference}
                        title={plainText(w.title)}
                        testid={`paper-reference-toggle-${w.id}`}
                        onToggle={(next) => {
                          setDossierError(null)
                          void window.api
                            .markReference(projectId, w.id, next)
                            .then(() => ranking.reload())
                            // SHOWN, not swallowed. Main refuses this write when
                            // the project context is full, and the `atLimit`
                            // guard on the button is a courtesy rather than the
                            // rule — it reads a ranking this screen loaded, so
                            // another tab filling the context leaves it stale.
                            // Ignoring the rejection made the button look inert
                            // in exactly the case it has something to say.
                            .catch((e: unknown) => {
                              setDossierError(e instanceof Error ? e.message : String(e))
                            })
                        }}
                      />
                    )}
                    {dossierError !== null && (
                      <span className="pv-dossier-error" role="alert">
                        {dossierError}
                      </span>
                    )}
                    {/* FIRST of the three, because it is the paper's own words:
                        the two summaries beside it are a model's account of
                        them, and a reader deciding what to trust should meet
                        the source before the readings of it. */}
                    <AbstractButton abstract={w.abstract} title={plainText(w.title)} />
                    <SummaryButtons
                      workId={w.id}
                      projectId={projectId}
                      title={plainText(w.title)}
                      written={summariesWritten}
                    />
                  </div>

                  <div className="pv-scores">
                    <ScoreBar
                      label="TOPIC RELEVANCE"
                      score01={rankRow ? relevanceForDisplay(rankRow) : null}
                      tip="Where this paper sits among the papers scored beside it for how closely it bears on the project's question. An order, not a measurement."
                    />
                    <ScoreBar
                      label="EXPANSION PRIORITY"
                      score01={rankRow ? expansionForDisplay(rankRow) : null}
                      strong
                      tip="How much NEW territory reading it would open up. A distinct axis from relevance — the two are never fused."
                    />
                  </div>
                </div>

                {/* analysis runs + provenance + facts + citations */}
                {/* `runs`, NOT the DataView's own list: the list is every
                    analysis_run this paper has, and this pane asks only what
                    each SCHEMA pulled out of it. Rendering the raw list is what
                    put `summary`, `ranking` and `dossier` tabs back beside the
                    schema names — emptiness measured elsewhere in this file,
                    and the reason the filter exists. The emptiness check follows
                    it for the same reason: a paper with three summary runs and
                    no extraction has nothing to show HERE, whatever else it
                    holds. */}
                <DataView
                  state={analyses}
                  isEmpty={() => runs.length === 0}
                  empty={<div className="pv-empty">No analyses have been run for this work.</div>}
                  skeleton={<div className="pv-pad"><SkeletonRows rows={4} /></div>}
                >
                  {() => (
                    <AnalysisColumn
                      runs={runs}
                      selectedRun={selectedRun}
                      onSelectRun={setSelectedRunId}
                      activeSpan={activeSpan}
                      onActivateSpan={activateSpan}
                      anchorable={anchorable}
                      spanColors={spanColors}
                      contentStatus={runContentStatus}
                      projectName={projectName ?? null}
                      showProvenance={showProvenance}
                      extractionRows={(extraction.data ?? []).filter((r) => r.work_id === w.id)}
                      onOpenExtractionRow={onOpenExtractionRow}
                      onOpenReview={onOpenReview}
                    />
                  )}
                </DataView>

                {/* citation contexts */}
                <DataView
                  state={citations}
                  isEmpty={(d) => d.length === 0}
                  empty={
                    <div className="pv-section" data-testid="citation-contexts">
                      <div className="pv-section-eyebrow mono">Citation contexts</div>
                      <div className="pv-empty">
                        Nothing has read this paper’s callouts yet.
                      </div>
                    </div>
                  }
                  skeleton={
                    <div className="pv-section">
                      <div className="pv-section-eyebrow mono">Citation contexts</div>
                      <SkeletonRows rows={2} />
                    </div>
                  }
                >
                  {(rows) => (
                    <CitationContextSection
                      contexts={rows}
                      outcome={citationOutcome.data ?? null}
                      documentId={pdfDoc?.id ?? null}
                      textState={pdfDoc ? pdfTextState : 'unavailable'}
                      // The viewer can only show ONE thing across the whole
                      // document. While find or a deep link owns it, a citation
                      // selection would be discarded by the highlight list, so
                      // the cards must not offer a jump they cannot perform.
                      mode={
                        focusQuote && focusQuote.trim().length > 0
                          ? 'deep-link'
                          : findQuery !== null && findHits.length > 0
                            ? 'finding'
                            : 'free'
                      }
                      findApi={findApiRef.current}
                      findEpoch={findEpoch}
                      unanchored={unanchoredCites}
                      selectedId={selectedCite?.id ?? null}
                      onSelect={selectCite}
                      onLocated={handleCiteLocated}
                      onOpenWork={onOpenWork}
                      unresolvedById={unresolvedById}
                      retrievalStatusOf={retrievalStatusOf}
                      onRetrieve={(r) => void retrieveReference(r)}
                    />
                  )}
                </DataView>

                {/* unresolved references — honesty: non-resolving cites stay visible */}
                <DataView
                  state={unresolved}
                  isEmpty={(d) => d.length === 0}
                  empty={<></>}
                  skeleton={<></>}
                >
                  {(refs) => {
                    // TWO kinds of row are not rendered, and neither is dropped
                    // silently. `retrieved` is in the corpus now, so it is not
                    // unresolved and has no business in this list — showing an
                    // "Imported ✓" would keep a finished item occupying the
                    // space of an unfinished one, and this list only shrinks.
                    // `unretrievable` — an entry naming no DOI, title or venue
                    // ("ibid., pp. 44–47") — offers nothing to do and nothing to
                    // read; a row whose only content is a disabled button
                    // explaining its own uselessness is furniture. It is COUNTED
                    // in the heading instead.
                    // MOST RELEVANT FIRST, UNSCORED LAST — not first, and not
                    // interleaved. A null relevance means nothing looked at the
                    // entry, which is a different statement from a low score,
                    // and sorting the two together would either bury the best
                    // references under entries nobody has read or promote the
                    // unread ones above measured ones. A block at the end says
                    // "these are the ones with no judgement yet" by position
                    // alone, without a badge on every row above them.
                    const listed = refs
                      .filter(
                        (r) => retrievalStatusOf(r) !== 'retrieved' && r.retrieval_kind !== null
                      )
                      .slice()
                      .sort((a, b) => {
                        if (a.relevance === null && b.relevance === null) return a.id - b.id
                        if (a.relevance === null) return 1
                        if (b.relevance === null) return -1
                        // Ties keep bibliography order, so the list is stable
                        // between renders rather than reshuffling equal scores.
                        return b.relevance - a.relevance || a.id - b.id
                      })
                    const notLookupable = refs.filter((r) => r.retrieval_kind === null).length
                    if (listed.length === 0 && notLookupable === 0) return <></>
                    return (
                      <div className="pv-section" data-testid="unresolved-references">
                        <div className="pv-sec-head">
                          <div className="pv-section-eyebrow mono">Unresolved references</div>
                          <span
                            className="pv-sec-count mono"
                            data-testid="unresolved-count"
                            data-tip={
                              notLookupable > 0
                                ? 'Some entries name no DOI, title or venue, so there is nothing to look up. They are counted here rather than listed.'
                                : undefined
                            }
                          >
                            {listed.length}
                            {notLookupable > 0 && ` · ${notLookupable} not lookupable`}
                          </span>
                        </div>
                        {retrieveError && (
                          <div className="pv-ref-notice is-error" data-testid="unresolved-retrieve-error">
                            {retrieveError}
                          </div>
                        )}
                        {retrieveNote && (
                          <div className="pv-ref-notice" data-testid="unresolved-retrieve-note">
                            {retrieveNote}
                          </div>
                        )}
                        <ReferenceList count={listed.length} testid="unresolved">
                          {(n) =>
                            listed.slice(0, n).map((r) => (
                              <UnresolvedRow
                                key={r.id}
                                reference={r}
                                state={retrievalStatusOf(r)}
                                onRetrieve={() => void retrieveReference(r)}
                              />
                            ))
                          }
                        </ReferenceList>
                      </div>
                    )
                  }}
                </DataView>
              </section>
            </div>
          )
        }
      </DataView>
    </div>
  )
}

/**
 * The run switcher, as a real TAB BAR.
 *
 * What makes it read as tabs rather than as a row of chips: one enclosing
 * container with its own surface, the selected tab sharing the panel's fill and
 * overlapping its border by 1px so tab and content are visibly ONE object, the
 * unselected tabs sitting on a recessed strip, and a sliding underline that
 * eases between them.
 *
 * The strip NEVER wraps — a wrapped tab bar stops reading as one switch — so
 * with several schemas it scrolls sideways. Three things stop that scrolling
 * from hiding tabs: a fade and an arrow at whichever edge actually has strip
 * behind it (never a permanent pair with one of them always dead), the total
 * printed beside it so the count is knowable without scrolling to find out, and
 * auto-scrolling the selected tab into view.
 */
function SchemaTabs({
  runs,
  selectedRun,
  onSelectRun,
  showProvenance,
  children
}: {
  runs: AnalysisRunDTO[]
  selectedRun: AnalysisRunDTO | null
  onSelectRun: (id: number) => void
  showProvenance: boolean
  /** The selected tab's contents. Rendered INSIDE the tab container, so the
      active tab and the readings it names read as one object rather than as a
      chip row floating above unrelated text. */
  children?: ReactNode
}): JSX.Element {
  const stripRef = useRef<HTMLDivElement | null>(null)
  const activeRef = useRef<HTMLButtonElement | null>(null)
  const [edges, setEdges] = useState<{ left: boolean; right: boolean }>({
    left: false,
    right: false
  })

  const syncEdges = useCallback(() => {
    const el = stripRef.current
    if (!el) return
    const more = el.scrollWidth - el.clientWidth
    setEdges({ left: el.scrollLeft > 2, right: el.scrollLeft < more - 2 })
  }, [])

  // A vertical wheel over a horizontally-overflowing strip does NOTHING by
  // default — the browser looks for a vertical scrollport, finds the sidebar,
  // and scrolls the whole panel away under the pointer. So deltaY is mapped
  // onto scrollLeft, and the event is only swallowed while the strip can still
  // move that way: at either end the wheel is handed back to the sidebar rather
  // than trapped. React's own onWheel is registered PASSIVE, where
  // preventDefault is ignored, so the listener is attached natively.
  useEffect(() => {
    const el = stripRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
      if (!d) return
      const max = el.scrollWidth - el.clientWidth
      const next = Math.max(0, Math.min(max, el.scrollLeft + d))
      if (next === el.scrollLeft) return
      e.preventDefault()
      // Assigned directly rather than via scrollBy: `scroll-behavior: smooth`
      // turns every wheel notch into a 300ms animation, so a fast scroll lags
      // behind the hand. Smooth is for the arrows, where a jump would jar.
      el.style.scrollBehavior = 'auto'
      el.scrollLeft = next
      el.style.scrollBehavior = ''
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  useEffect(() => {
    const el = stripRef.current
    if (!el) return
    syncEdges()
    const ro = new ResizeObserver(syncEdges)
    ro.observe(el)
    return () => ro.disconnect()
  }, [syncEdges, runs.length, showProvenance])

  // Arriving on a paper whose current schema is tab 5 must not open on an
  // apparently empty switcher.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  }, [selectedRun?.id])

  const nudge = (dir: -1 | 1): void =>
    stripRef.current?.scrollBy({ left: dir * 180, behavior: 'smooth' })

  // CURRENT runs only, unless provenance is open. A superseded run is history,
  // not a place to go; it is reachable through the provenance disclosure, which
  // is where a reader asking "what did this used to say" already is.
  //
  // The run being READ is always among them, superseded or not. A paper whose
  // every run has been replaced would otherwise draw an EMPTY tab bar above a
  // panel full of that run's readings — a switcher with no tabs reads as a
  // rendering failure, and it hides the one thing the reader needs to know,
  // which is that what they are looking at is out of force.
  const shown = runs.filter(
    (r) => showProvenance || r.superseded === 0 || r.id === selectedRun?.id
  )
  const at = shown.findIndex((r) => r.id === selectedRun?.id)

  return (
    <div className="pv-tabwrap">
      <div
        className={`pv-tabrow${edges.left ? ' has-left' : ''}${edges.right ? ' has-right' : ''}`}
      >
        {edges.left && (
          <button
            type="button"
            className="pv-tabscroll is-left"
            aria-label="Scroll tabs left"
            onClick={() => nudge(-1)}
          >
            ◀
          </button>
        )}
        <div
          className="pv-tabstrip"
          data-testid="run-tabs"
          role="tablist"
          ref={stripRef}
          onScroll={syncEdges}
        >
          {shown.map((r) => {
            const active = selectedRun?.id === r.id
            return (
              <button
                key={r.id}
                type="button"
                role="tab"
                aria-selected={active}
                ref={active ? activeRef : undefined}
                className={`pv-tab ${active ? 'is-active' : ''} ${
                  r.superseded ? 'is-superseded' : ''
                }`}
                data-testid={`run-tab-${r.id}`}
                title={r.schema_name ?? r.analysis_type}
                data-tip={
                  r.superseded
                    ? 'An older run, replaced by a newer one. Kept so the record of what was extracted, and when, is never rewritten.'
                    : undefined
                }
                onClick={() => onSelectRun(r.id)}
              >
                {/* The analysis_type is the SAME WORD on every tab, so it must
                    never be the part that shrinks: an "extr…" spends width to
                    say nothing. It keeps its natural size and the schema name —
                    the only thing telling one tab from another — takes whatever
                    width is left. The type is the label outright only when
                    there is no schema to name the run by. */}
                {(showProvenance || !r.schema_name) && (
                  <span className="pv-tab-type" data-testid={`run-tab-type-${r.id}`}>
                    {r.analysis_type}
                  </span>
                )}
                {r.schema_name && (
                  <span className="pv-tab-name" data-testid={`run-tab-schema-${r.id}`}>
                    {r.schema_name}
                  </span>
                )}
                {/* Superseded is a CAVEAT, not a version label. The glyph and
                    the strike-through carry it for a sighted reader and neither
                    reaches a screen reader, so it is also spelled out in a word
                    only assistive tech reads. A current run says nothing.

                    `!== 0`, not a bare truthiness test: `superseded` is a SQLite
                    integer, and React renders a falsy `0` from `0 && <x/>` as
                    the visible character "0". */}
                {r.superseded !== 0 && (
                  <>
                    <span className="pv-tab-supers" aria-hidden="true">
                      ⟲
                    </span>
                    <span className="visually-hidden">: superseded</span>
                  </>
                )}
              </button>
            )
          })}
        </div>
        {edges.right && (
          <button
            type="button"
            className="pv-tabscroll is-right"
            aria-label="Scroll tabs right"
            onClick={() => nudge(1)}
          >
            ▶
          </button>
        )}
        {shown.length > 1 && (
          <span className="pv-tabcount mono" data-testid="run-tabs-count">
            {at >= 0 ? at + 1 : '–'}/{shown.length}
          </span>
        )}
      </div>
      <div className="pv-tabpanel" role="tabpanel">
        {children}
      </div>
    </div>
  )
}

/** One field line of a reading. */
interface FieldLineVM {
  /** Stable per-line key AND the `fact-<id>` testid the line is addressed by. */
  factId: number
  label: string
  value: string
  unit: string | null
  kind: string
  evidence: EvidenceSpanDTO | null
  /**
   * Stated ONCE for the whole paper and holding for this reading too. Restated
   * in full rather than dittoed — see the `paper-level` mark.
   */
  carried: boolean
}

/** One reading — a coherent measurement of one subject under one condition. */
interface ReadingVM {
  key: string
  /** The subject that identifies this reading; the container's caption. */
  caption: string | null
  fields: FieldLineVM[]
  /** Addresses this reading in the Extraction matrix; null when it has none. */
  rowKey: string | null
  schemaId: number | null
  /** The reading's Review state, and the fact the queue is addressed by. */
  review: { tone: 'review' | 'conflict'; factId: number } | null
}

/** The printed form of a value, or null when there is nothing to print. */
function valueOf(value_text: string | null, value_num: number | null): string | null {
  if (value_text !== null && value_text.trim().length > 0) return value_text
  if (value_num !== null) return String(value_num)
  return null
}

/**
 * The unit to print AFTER a value, or null when printing it would say it twice.
 *
 * `value_text` is the extractor's verbatim reading, and it frequently carries
 * its own unit ("95 °C"); the schema's `field_unit` then carries the same one,
 * and appending it unconditionally rendered "95 °C °C". The value is never
 * rewritten to strip the unit out of it — that is the extracted text and
 * exports must see it whole — so the SEPARATE unit is what gets suppressed.
 */
function unitToPrint(value: string, unit: string | null): string | null {
  if (unit === null) return null
  const u = unit.trim()
  if (u.length === 0) return null
  const v = value.trim()
  return v.toLowerCase().endsWith(u.toLowerCase()) ? null : u
}

/**
 * Readings built from the EXTRACTION RECORDS of one work under one schema.
 *
 * The same `groupReadings` the Extraction matrix uses, so a reading here and a
 * row there are one record with one identity — which is what lets a line link
 * into the matrix by `row_key` rather than dropping the reader at the top of a
 * screen to search for it.
 */
function readingsFromRecords(w: WorkReadings): { readings: ReadingVM[]; unassigned: ReadingVM | null } {
  const readings: ReadingVM[] = w.order.map((k) => {
    const mine = w.rows.filter((r) => r.field_id != null && readingKey(r) === k)
    const caption = mine[0]?.subject ?? null
    const fields: FieldLineVM[] = []
    for (const [fieldId, perField] of w.cells) {
      const carried = w.paperLevel.has(fieldId)
      const row = perField.get(k) ?? (carried ? [...perField.values()][0] : undefined)
      if (!row) continue
      const value = valueOf(row.value_text, row.value_num)
      // A field the paper never reported is NOT listed. The matrix needs the
      // "—" placeholder to keep its columns aligned across papers; this list has
      // no columns to hold open, so a row saying nothing happened is a row spent.
      if (value === null) continue
      // The subject is already the caption; printing it again as a field would
      // state the same thing twice in adjacent lines.
      if (caption && value.trim() === caption.trim()) continue
      fields.push({
        factId: row.fact_id,
        label: row.field_label ?? row.field_key ?? row.quantity,
        value,
        unit: unitToPrint(value, row.unit ?? row.field_unit),
        kind: row.fact_kind,
        evidence: row.evidence,
        carried: carried && !perField.has(k)
      })
    }
    const conflict = mine.find((r) => r.status === 'conflict')
    const flagged = mine.find((r) => r.status === 'review' || r.status === 'invalid')
    return {
      key: k,
      caption,
      fields,
      rowKey: mine[0]?.row_key ?? null,
      schemaId: mine[0]?.schema_id ?? null,
      review: conflict
        ? { tone: 'conflict', factId: conflict.fact_id }
        : flagged
          ? { tone: 'review', factId: flagged.fact_id }
          : null
    }
  })

  // Values the run produced that the schema never asked for. They take no part
  // in the matrix — there is no column for them — but they are real extracted
  // data, so they are shown in their own group rather than dropped.
  const un = w.unassigned
    .map<FieldLineVM | null>((r) => {
      const value = valueOf(r.value_text, r.value_num)
      return value === null
        ? null
        : {
            factId: r.fact_id,
            label: r.quantity,
            value,
            unit: unitToPrint(value, r.unit),
            kind: r.fact_kind,
            evidence: r.evidence,
            carried: false
          }
    })
    .filter((f): f is FieldLineVM => f !== null)

  return {
    readings: readings.filter((r) => r.fields.length > 0),
    unassigned:
      un.length === 0
        ? null
        : {
            key: '__unassigned__',
            caption: 'Not in this schema',
            fields: un,
            rowKey: w.unassigned[0]?.row_key ?? null,
            schemaId: null,
            review: null
          }
  }
}

/**
 * Readings built from a RUN's own facts.
 *
 * `getExtractionRows` returns CURRENT runs only, so a superseded run has no
 * records to group and would otherwise render an empty panel — its facts are
 * still stored and still readable, and hiding them would rewrite what the app
 * says the run found. Grouped on the same (subject, conditions) key, so a
 * reading means the same thing here as everywhere else.
 */
function readingsFromFacts(facts: FactDTO[]): ReadingVM[] {
  const buckets = new Map<string, FactDTO[]>()
  for (const f of facts) {
    const k = `${(f.subject ?? '').trim().toLowerCase()}|${(
      f.measurement?.conditions ?? ''
    )
      .trim()
      .toLowerCase()}`
    buckets.set(k, [...(buckets.get(k) ?? []), f])
  }
  return [...buckets.entries()].map(([k, fs]) => {
    const caption = fs.find((f) => f.subject)?.subject ?? null
    return {
      key: k,
      caption,
      fields: fs
        .map<FieldLineVM | null>((f) => {
          const value =
            valueOf(f.value_text, null) ??
            f.object ??
            valueOf(f.measurement?.value_text ?? null, f.measurement?.value_num ?? null)
          if (value === null) return null
          if (caption && value.trim() === caption.trim()) return null
          return {
            factId: f.id,
            label: f.measurement?.quantity ?? f.predicate,
            value,
            unit: unitToPrint(value, f.measurement?.unit ?? null),
            kind: f.kind,
            evidence: f.evidence,
            carried: false
          }
        })
        .filter((f): f is FieldLineVM => f !== null),
      rowKey: null,
      schemaId: null,
      review: null
    }
  })
}

function AnalysisColumn({
  runs,
  selectedRun,
  onSelectRun,
  activeSpan,
  onActivateSpan,
  anchorable,
  spanColors,
  contentStatus,
  projectName,
  showProvenance,
  extractionRows,
  onOpenExtractionRow,
  onOpenReview
}: {
  runs: AnalysisRunDTO[]
  selectedRun: AnalysisRunDTO | null
  onSelectRun: (id: number) => void
  activeSpan: string | null
  onActivateSpan: (id: string) => void
  /** Evidence-span ids that actually anchored to text in the PDF. */
  anchorable: Set<string>
  /** spanId -> the hue its PDF band is tinted with. */
  spanColors: Map<string, string>
  /** How much of the source the runs below could read (`fulltext` | …). */
  contentStatus: string | null
  /** The open project's name, for attributing a project-scoped run. */
  projectName: string | null
  /** Whether the full provenance block and the analysis-type label are shown. */
  showProvenance: boolean
  /** This work's records as the Extraction matrix holds them. */
  extractionRows: ExtractionRowDTO[]
  onOpenExtractionRow?: (rowKey: string, schemaId?: number) => void
  onOpenReview?: (factId: number) => void
}): JSX.Element {
  // SHUT on arrival, on every paper. The expanded card is taller than the
  // sidebar, so opening on it means the readings — the thing the panel exists
  // to show — start below the fold. The caveats that qualify those readings do
  // NOT wait for the disclosure: they are in the bar beside this control.
  const [provOpen, setProvOpen] = useState(false)
  const grouped = useMemo(() => {
    if (!selectedRun) return null
    // One schema's records, so the readings under a tab are the readings that
    // tab's run produced — not every schema's records piled together.
    const mine = extractionRows.filter(
      (r) => selectedRun.schema_id === 0 || r.schema_id === selectedRun.schema_id
    )
    return groupReadings(mine)[0] ?? null
  }, [extractionRows, selectedRun])

  const { readings, unassigned } = useMemo(() => {
    if (grouped) return readingsFromRecords(grouped)
    return {
      readings: selectedRun ? readingsFromFacts(selectedRun.facts) : [],
      unassigned: null
    }
  }, [grouped, selectedRun])

  const all = unassigned ? [...readings, unassigned] : readings

  const caveated = selectedRun !== null && hasCaveats(selectedRun, contentStatus)

  return (
    <>
      <SchemaTabs
        runs={runs}
        selectedRun={selectedRun}
        onSelectRun={onSelectRun}
        showProvenance={showProvenance}
      >
        {/* Two gates, and they answer different questions.

            WHETHER THE READER ASKED FOR METADATA is `showProvenance`, set in
            Settings. Off — the default — the toggle and the card are not here
            at all. They used to render unconditionally, which made the setting
            look broken: a reader who had turned provenance off still met a
            provenance control on every paper, and the only thing the switch
            actually did was reveal superseded tabs.

            WHETHER THIS RUN QUALIFIES ITS CLAIMS is the caveat strip, and that
            is not the reader's to switch off. The setting hides METADATA —
            model, versions, hashes; it must never hide the reasons a result
            stands on less than it appears to, which is what the Settings copy
            promises ("Warnings always show"). So the bar survives the setting
            being off, and disappears only when the run has nothing to warn
            about — an empty bordered strip on every paper is the badge-on-
            everything failure in another shape.

            Provenance stays a DISCLOSURE even when it is switched on. Expanded
            it is a card taller than the panel, and it sat between the reader
            and the readings they came for. */}
        {selectedRun && (showProvenance || caveated) && (
          <div className="pv-prov-bar">
            <RunCaveats run={selectedRun} contentStatus={contentStatus} />
            <span className="pv-prov-bar-spacer" />
            {showProvenance && (
              <button
                type="button"
                className={`pv-prov-toggle mono${provOpen ? ' is-open' : ''}`}
                data-testid={`provenance-toggle-${selectedRun.id}`}
                aria-expanded={provOpen}
                aria-controls={`provenance-${selectedRun.id}`}
                data-tip={
                  provOpen
                    ? 'Hide how this reading was produced.'
                    : 'Which model produced this reading, when, against which prompt and schema, and what a second reading of the paper found.'
                }
                onClick={() => setProvOpen((v) => !v)}
              >
                <span className="pv-prov-toggle-caret" aria-hidden="true">
                  ▸
                </span>
                provenance
              </button>
            )}
          </div>
        )}
        {selectedRun && showProvenance && (
          <div className={`pv-prov-reveal${provOpen ? ' is-open' : ''}`}>
            <div>
              <ProvenanceCard
                run={selectedRun}
                contentStatus={contentStatus}
                projectName={projectName}
              />
            </div>
          </div>
        )}
        {selectedRun &&
          (all.length === 0 ? (
            <div className="pv-tabpanel-empty" data-testid="paper-claims">
              <div className="pv-empty">No facts extracted.</div>
            </div>
          ) : (
            <div className="pv-rows" data-testid="paper-claims">
              {all.map((r) => (
                <ReadingBlock
                  key={r.key}
                  reading={r}
                  activeSpan={activeSpan}
                  onActivateSpan={onActivateSpan}
                  anchorable={anchorable}
                  spanColors={spanColors}
                  onOpenExtractionRow={onOpenExtractionRow}
                  onOpenReview={onOpenReview}
                />
              ))}
            </div>
          ))}
      </SchemaTabs>
    </>
  )
}

/**
 * The caveats that must survive the provenance card being collapsed.
 *
 * Collapsing provenance hides METADATA — which model, which prompt version,
 * when. It must never hide the reasons a result stands on less than it appears
 * to. Six of them qualify the claims below and so are restated inline whenever
 * the card is shut:
 *
 *   superseded      the run is out of force; a newer one supplies the facts
 *   shipped/imported it was not computed on this machine
 *   stale inputs    the paper, prompt or schema has changed since it ran
 *   partial basis   it read less than the full text (abstract/metadata only)
 *   output ≠ schema the model's response did not conform to the declared schema
 *   contradicted    a reader with the paper open found a record wrong
 *
 * The last two are the ones a collapse most easily loses, because on the card
 * they sit inside a further `<details>`. Both are findings about THESE claims,
 * not about the build: a run whose output never parsed cleanly, or whose values
 * a second reading contradicted, is exactly a result standing on less than it
 * appears to. Two disclosures deep is indistinguishable from absent.
 *
 * A silent `verifier_result` of `not-run`/null is NOT one of them: unvalidated
 * is the ordinary case, so badging it would badge nearly everything.
 *
 * The GLOBAL-vs-project scope pill is likewise absent by design. "Carries no
 * project context" is a property of the run's KIND, uniform across every global
 * run, so a permanent badge for it would train the reader to skip the strip —
 * it is metadata a reader consults, and it stays behind the toggle.
 *
 * A run with none of these needs no strip: silence is the honest rendering of
 * "current, local, full text, inputs unchanged", and a badge asserting that on
 * every paper would train the reader to ignore the row that matters. Nor is the
 * silence an unearned claim of quality — the paper header still states the
 * document's own basis and OCR provenance unconditionally.
 *
 * Each caveat carries its own GLYPH and word as well as its tone, so none of
 * them rests on colour, and each is focusable with the sentence a reader needs
 * on the tooltip — the detail is one keystroke away, not gone.
 */
/**
 * Whether this run qualifies its own claims — the one test for both the strip
 * and the bar that holds it.
 *
 * ONE definition, called from both places, because the two failures either way
 * are silent. If the bar's test were the looser of the pair it would draw an
 * empty bordered row on every clean paper; if it were the tighter, a real
 * warning would have nowhere to render and would simply vanish. Neither shows
 * up as an error — a missing warning looks exactly like a paper with nothing
 * wrong with it, which is precisely the state it exists to deny.
 */
function hasCaveats(run: AnalysisRunDTO, contentStatus: string | null): boolean {
  return (
    run.superseded !== 0 ||
    run.run_origin !== 'local' ||
    run.freshness.verdict !== 'current' ||
    (contentStatus !== null && contentStatus !== 'fulltext') ||
    didOutputFailSchema(run) ||
    run.checks.some((c) => c.status === 'failed')
  )
}

function RunCaveats({
  run,
  contentStatus
}: {
  run: AnalysisRunDTO
  contentStatus: string | null
}): JSX.Element | null {
  const basis = contentStatusMeta(contentStatus)
  const partialBasis = contentStatus !== null && contentStatus !== 'fulltext'
  const freshMeta = FRESHNESS_META[run.freshness.verdict]
  const unfresh = run.freshness.verdict !== 'current'
  const schemaFail = didOutputFailSchema(run)
  const failedChecks = run.checks.filter((c) => c.status === 'failed')
  if (!hasCaveats(run, contentStatus)) return null
  return (
    <div className="pv-caveats" data-testid={`run-caveats-${run.id}`}>
      {run.superseded !== 0 && (
        <span
          className="badge badge-warn pv-caveat is-superseded"
          data-testid={`caveat-superseded-${run.id}`}
          tabIndex={0}
          aria-label="This run is superseded: a newer run has replaced it, and its facts are not the ones the rest of the app uses."
          data-tip="An earlier reading of this paper, kept for the record. The current results are on the newest tab."
        >
          <span className="pv-caveat-glyph" aria-hidden="true">
            ⟲
          </span>
          superseded
        </span>
      )}
      {run.run_origin !== 'local' && (
        <RunOriginBadge
          origin={run.run_origin}
          note={run.origin_note}
          testid={`caveat-origin-${run.id}`}
        />
      )}
      {unfresh && (
        <span
          className={`badge pv-caveat is-fresh-${run.freshness.verdict}`}
          data-testid={`caveat-freshness-${run.id}`}
          data-verdict={run.freshness.verdict}
          tabIndex={0}
          aria-label={`Input freshness: ${freshMeta.label}`}
          data-tip={freshMeta.tip}
        >
          <span className="pv-caveat-glyph" aria-hidden="true">
            {freshMeta.glyph}
          </span>
          {freshMeta.label}
        </span>
      )}
      {partialBasis && (
        <span
          className={`badge badge-${basis.cls} pv-caveat is-basis`}
          data-testid={`caveat-basis-${run.id}`}
          tabIndex={0}
          aria-label={`This run read ${basis.label} only. The full text was not available to it, so its claims are not full-text-backed.`}
          data-tip="The full text was NOT available to this run. Everything below was extracted from this much of the source alone."
        >
          <span className="pv-caveat-glyph" aria-hidden="true">
            ◐
          </span>
          read {basis.label}
        </span>
      )}
      {schemaFail && (
        <span
          className="badge badge-danger pv-caveat is-schema-fail"
          data-testid={`caveat-schema-${run.id}`}
          tabIndex={0}
          aria-label="The model's output did not conform to the declared schema. The claims below were salvaged from a response that failed validation."
          data-tip="The model's response did NOT match the output schema it was asked for. Whatever is shown below was recovered from a malformed answer — treat every field as unverified."
        >
          <span className="pv-caveat-glyph" aria-hidden="true">
            ✕
          </span>
          output ≠ schema
        </span>
      )}
      {failedChecks.length > 0 && (
        <span
          className="badge badge-danger pv-caveat is-checks-failed"
          data-testid={`caveat-checks-${run.id}`}
          tabIndex={0}
          aria-label={`${failedChecks.length} record${
            failedChecks.length === 1 ? ' was' : 's were'
          } contradicted by a second reading of this paper: ${failedChecks
            .map((c) => c.label)
            .join('; ')}`}
          data-tip={`A second reading of this paper contradicted what was extracted: ${failedChecks
            .map((c) => c.label)
            .join('; ')}. These are findings about the claims below, and you may disagree with them.`}
        >
          <span className="pv-caveat-glyph" aria-hidden="true">
            ⚠
          </span>
          {failedChecks.length} contradicted
        </span>
      )}
    </div>
  )
}

/**
 * Whether the model's response failed to conform to the schema it was asked for.
 *
 * Shared by the caveat strip and the provenance card so the two can never
 * disagree about what counts as a failure. `not-run`/null is NOT a failure: an
 * unvalidated run is the ordinary case, and conflating the two would raise an
 * alarm on nearly every run in the corpus.
 */
function didOutputFailSchema(run: AnalysisRunDTO): boolean {
  if (run.verifier_result === null || run.verifier_result === 'not-run') return false
  return !run.verifier_result.toLowerCase().includes('pass')
}

function ProvenanceCard({
  run,
  contentStatus,
  projectName
}: {
  run: AnalysisRunDTO
  contentStatus: string | null
  projectName: string | null
}): JSX.Element {
  const isGlobal = run.project_id === 0
  // `verifier_result` records whether the MODEL'S RESPONSE parsed against the
  // declared output schema — nothing about whether the claims are right. The
  // content is judged by the reader's verdicts, listed separately below.
  const outputValid = (run.verifier_result ?? '').toLowerCase().includes('pass')
  const outputText =
    run.verifier_result === null || run.verifier_result === 'not-run'
      ? 'Model output not validated'
      : outputValid
        ? 'Model output matched the schema'
        : run.verifier_result === 'partial'
          ? 'Model output partly matched the schema'
          : 'Model output did not match the schema'
  const failedChecks = run.checks.filter((c) => c.status === 'failed')
  const passedChecks = run.checks.filter((c) => c.status === 'passed')
  const basis = contentStatusMeta(contentStatus)
  // Only a full-text run needs no caveat; everything else saw less than the
  // paper and must say so on the card that vouches for it.
  const partialBasis = contentStatus !== null && contentStatus !== 'fulltext'
  return (
    <div className="pv-section">
      <div
        className={`pv-prov ${run.superseded ? 'provenance-superseded pv-prov-superseded' : ''} ${
          isGlobal ? 'pv-prov-global' : ''
        }`}
        id={`provenance-${run.id}`}
        data-testid={`provenance-${run.id}`}
        data-scope={isGlobal ? 'global' : 'project'}
      >
        <div className="pv-prov-head">
          <svg
            className="pv-prov-icon"
            width="15"
            height="15"
            viewBox="0 0 20 20"
            fill="none"
            stroke="#e2600f"
            strokeWidth="1.7"
          >
            <path d="M10 2.5l6 2.5v5c0 3.5-2.6 6.3-6 7.5-3.4-1.2-6-4-6-7.5v-5z" />
            <path d="M7.5 10l1.8 1.8L13 8" />
          </svg>
          <span className="pv-prov-eyebrow mono">Provenance</span>
          {/* Scope is stated in words, with its own shape and weight, because
              the absence of a project name is not a signal a reader can see. */}
          <span
            className={`pv-prov-scope mono ${isGlobal ? 'is-global' : 'is-project'}`}
            data-testid={`provenance-scope-${run.id}`}
            tabIndex={0}
            aria-label={
              isGlobal
                ? 'Scope: global analysis, shared by every project, with no project context'
                : `Scope: analysis run for the project ${projectName ?? run.project_id} alone`
            }
            data-tip={
              isGlobal
                ? 'A GLOBAL analysis: run once for this paper, shared by every project. It carries no project context and is not tailored to this project’s question.'
                : 'A PROJECT analysis: run for this project alone, with its context supplied. Other projects see their own.'
            }
          >
            {isGlobal ? 'global · all projects' : (projectName ?? `project ${run.project_id}`)}
          </span>
          <span
            className={`pv-prov-verify ${outputValid ? 'is-pass' : ''}`}
            tabIndex={0}
            aria-label={`${outputText}. This reports schema conformance of the model's response only, not whether the extracted claims are correct.`}
            data-tip="Confirms the AI's answer came back in the expected form. It says nothing about whether the values are correct."
          >
            <span className={`pv-dot ${outputValid ? 'pv-dot-ok' : 'pv-dot-muted'}`} />
            {outputText}
          </span>
        </div>
        {/* The two RISK-BEARING signals (when it ran, whether it still counts)
            sit in the summary; the build detail a scientist reads once lives
            behind the disclosure. */}
        <div className="pv-prov-summary">
          {fmtTime(run.run_timestamp)}
          {run.superseded ? ' · superseded' : ' · current'}
        </div>
        {/* WHERE this run happened, on the card that vouches for it — not only
            behind the disclosure below, where it is closed by default and a
            reader skimming extracted facts never sees it.

            Per-RUN rather than per-app, and that distinction is load-bearing: a
            database holds shipped and locally-computed analyses side by side, so
            an app-level indicator cannot answer "where did THIS come from".

            NEUTRAL, not a warning. A shipped run is a real model's real reading
            of this paper — the badge exists so nobody assumes their own machine
            produced it, not to cast doubt on it. Styled as information for that
            reason; the warning treatment belongs to claims that stand on less
            than they appear to, which this is not. */}
        {run.run_origin !== 'local' && (
          <div className="pv-prov-basis">
            <RunOriginBadge
              origin={run.run_origin}
              note={run.origin_note}
              testid={`provenance-origin-${run.id}`}
            />
          </div>
        )}
        <FreshnessBanner runId={run.id} freshness={run.freshness} />
        {/* An abstract-only or metadata-only run must never read as
            full-text-backed, so the caveat rides on the card that vouches for
            the run, not only on the paper header. */}
        {partialBasis && (
          <div className="pv-prov-basis">
            <span
              className={`badge badge-${basis.cls} pv-prov-basis-badge`}
              data-testid={`provenance-basis-${run.id}`}
              tabIndex={0}
              aria-label={`This run read ${basis.label} only. The full text was not available to it, so its claims are not full-text-backed.`}
              data-tip="The full text was NOT available to this run. Everything below was extracted from this much of the source alone."
            >
              read {basis.label}
            </span>
          </div>
        )}
        {/* A contradicted record is a finding about the extracted content, so
            it rides on the card body. The full roster — what a reading
            confirmed, what was asked at all — stays in the details below, where
            a reader goes deliberately. */}
        {failedChecks.length > 0 && (
          <div className="pv-prov-basis">
            <span
              className="badge badge-danger pv-prov-checks-badge"
              data-testid={`provenance-checks-failed-${run.id}`}
              tabIndex={0}
              aria-label={`${failedChecks.length} record${
                failedChecks.length === 1 ? ' was' : 's were'
              } contradicted by a second reading: ${failedChecks
                .map((c) => c.label)
                .join('; ')}`}
              data-tip={`A second reading of this paper contradicted what was extracted: ${failedChecks
                .map((c) => c.label)
                .join('; ')}.`}
            >
              <span className="pv-caveat-glyph" aria-hidden="true">
                ⚠
              </span>
              {failedChecks.length} contradicted
            </span>
          </div>
        )}
        <details className="pv-prov-more">
          <summary className="mono">Run details</summary>
          <div className="pv-prov-grid">
            <div className="pv-prov-cell">
              <div className="pv-prov-key mono">MODEL</div>
              <div className="pv-prov-val">
                {run.model} · {run.provider}
              </div>
            </div>
            <div className="pv-prov-cell">
              <div className="pv-prov-key mono">PROMPT / SCHEMA</div>
              <div className="pv-prov-val">
                {run.prompt_version} · {run.schema_version}
              </div>
            </div>
            {/* Names what a reading CONTRADICTED, not just a count: a reviewer
                needs to know WHAT to look at, and a run nobody has read back
                must say so rather than read as confirmed. */}
            <div className="pv-prov-cell">
              <div className="pv-prov-key mono">SECOND READING</div>
              <div className="pv-prov-val" data-testid={`provenance-checks-${run.id}`}>
                {run.checks.length === 0
                  ? 'not read back yet'
                  : failedChecks.length === 0
                    ? `${passedChecks.length} confirmed, none contradicted`
                    : `${failedChecks.length} contradicted: ${failedChecks
                        .map((c) => c.label)
                        .join('; ')}`}
              </div>
            </div>
            {run.supplied_project_context && (
              <div className="pv-prov-cell">
                <div className="pv-prov-key mono">PROJECT CONTEXT</div>
                <div className="pv-prov-val">supplied</div>
              </div>
            )}
            {/* A run a human has edited is no longer purely the model's output.
                The column holds a JSON blob, so its PRESENCE is reported and
                the raw structure is not leaked into the reading surface. */}
            {run.user_corrections && (
              <div className="pv-prov-cell">
                <div className="pv-prov-key mono">USER CORRECTIONS</div>
                <div className="pv-prov-val" data-testid={`provenance-corrections-${run.id}`}>
                  recorded
                </div>
              </div>
            )}
          </div>
          {/* The digests behind the verdict above. Kept because when a reader
              disputes a "changed" verdict, the pair of hashes is the only thing
              that identifies WHICH input the disagreement is about — and a
              digest that cannot be selected and pasted into a bug report is no
              use for that, hence the plain selectable text. */}
          <div className="pv-fresh-hashes" data-testid={`provenance-hashes-${run.id}`}>
            <div className="pv-prov-key mono">INPUT HASHES</div>
            {run.freshness.inputs.map((i) => (
              <div className="pv-fresh-hash-row" key={i.input}>
                <span className="pv-fresh-hash-name mono">{i.input}</span>
                <span className="pv-fresh-hash-val mono">{i.recorded_hash ?? '—'}</span>
                <span className="pv-fresh-hash-arrow" aria-hidden="true">
                  →
                </span>
                <span className="pv-fresh-hash-val mono">{i.current_hash ?? '—'}</span>
              </div>
            ))}
            <div className="pv-fresh-hash-legend">
              recorded by this run → what the same input hashes to now. “—” means
              no hash exists to compare, not that the inputs agree.
            </div>
          </div>
        </details>
      </div>
    </div>
  )
}

/** Icon + wording per freshness verdict. Colour is never the only carrier. */
const FRESHNESS_META: Record<
  AnalysisFreshnessDTO['verdict'],
  { label: string; glyph: string; tip: string }
> = {
  current: {
    label: 'inputs unchanged',
    glyph: '✓',
    tip: 'Every input this run recorded a hash for still hashes to the same value, so the result below reflects the paper, prompt and schema as they stand now.'
  },
  stale: {
    label: 'inputs changed',
    glyph: '!',
    tip: 'Every checkable input has changed since this run was made. The result below was computed from something other than what is in front of you — re-run before relying on it.'
  },
  'partially-stale': {
    label: 'some inputs changed',
    glyph: '≠',
    tip: 'At least one input this run used has changed since. The result below is not wholly out of date, but it no longer rests on the inputs as they stand.'
  },
  unknown: {
    label: 'cannot be checked',
    glyph: '?',
    tip: 'One or more of this run’s inputs cannot be reconstructed, so whether the result is still valid is UNPROVEN. This is not the same as unchanged.'
  }
}

/**
 * States the freshness verdict on the card that vouches for the run.
 *
 * Each verdict carries its own GLYPH, border style and weight in addition to
 * its hue, so the four are told apart without colour: a tick on a solid quiet
 * edge, a bang on a heavy edge, a not-equals on a doubled edge, a query on a
 * dashed edge. The per-input reasons are always listed — a verdict a reader
 * cannot audit is just another assertion.
 */
function FreshnessBanner({
  runId,
  freshness
}: {
  runId: number
  freshness: AnalysisFreshnessDTO
}): JSX.Element {
  const meta = FRESHNESS_META[freshness.verdict]
  return (
    <div
      className={`pv-fresh is-${freshness.verdict}`}
      data-testid={`provenance-freshness-${runId}`}
      data-verdict={freshness.verdict}
    >
      {/* The label alone would leave a screen reader without the caveat the
          tooltip carries, and the summary is rendered visibly right below, so
          the accessible name states the verdict and defers the rest. */}
      <span
        className="pv-fresh-pill mono"
        tabIndex={0}
        aria-label={`Input freshness: ${meta.label}`}
        data-tip={meta.tip}
      >
        <span className="pv-fresh-glyph" aria-hidden="true">
          {meta.glyph}
        </span>
        {meta.label}
      </span>
      <span className="pv-fresh-summary">{freshness.summary}</span>
      <ul className="pv-fresh-list" aria-label="Freshness of each input this run used">
        {freshness.inputs.map((i) => (
          <li className={`pv-fresh-item is-${i.verdict}`} key={i.input}>
            {/* The glyph and the hue carry the per-input verdict for a sighted
                reader; neither reaches a screen reader, so the verdict is also
                spelled out in a word only assistive tech reads. */}
            <span className="pv-fresh-item-glyph" aria-hidden="true">
              {INPUT_GLYPH[i.verdict]}
            </span>
            <span className="pv-fresh-item-label mono">
              {i.label}
              <span className="visually-hidden">: {INPUT_VERDICT_WORD[i.verdict]}</span>
            </span>
            <span className="pv-fresh-item-reason">{i.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

const INPUT_GLYPH: Record<AnalysisInputFreshnessDTO['verdict'], string> = {
  current: '✓',
  stale: '!',
  unknown: '?',
  'not-applicable': '–'
}

/** What each per-input glyph MEANS, for readers who never receive the glyph. */
const INPUT_VERDICT_WORD: Record<AnalysisInputFreshnessDTO['verdict'], string> = {
  current: 'unchanged',
  stale: 'changed since this run',
  unknown: 'cannot be checked',
  'not-applicable': 'does not apply to this run'
}

/**
 * Which non-plain fact kinds earn a mark, and what that mark says.
 *
 * `directly-reported` renders NOTHING: it is what a reader assumes an extracted
 * value is, and a pill on every line would spend the panel's width to confirm
 * the ordinary case — and take the one line that is NOT ordinary down with it.
 */
const KIND_PILL: Record<string, string> = {
  inferred: 'k-inferred',
  'supplied-by-project-context': 'k-context',
  'uncertain-conflicting': 'k-conflict'
}

/**
 * ONE reading — a coherent measurement of one subject under one condition —
 * with one LINE per field beneath its caption.
 *
 * The subject IDENTIFIES the reading, so it is the caption and is never also
 * printed as a field: a container captioned "KE07" whose first line reads
 * "Variant KE07" states the same thing twice in adjacent rows.
 */
function ReadingBlock({
  reading,
  activeSpan,
  onActivateSpan,
  anchorable,
  spanColors,
  onOpenExtractionRow,
  onOpenReview
}: {
  reading: ReadingVM
  activeSpan: string | null
  onActivateSpan: (id: string) => void
  anchorable: Set<string>
  spanColors: Map<string, string>
  onOpenExtractionRow?: (rowKey: string, schemaId?: number) => void
  onOpenReview?: (factId: number) => void
}): JSX.Element {
  // Where this reading lives elsewhere — TWO destinations, both always offered.
  // They answer different questions and are not alternatives: Extraction is
  // "how does this compare across the corpus", Review is "is this settled". A
  // reader wanting the matrix must not first have to clear a flag to reach it,
  // and a reader wanting the flag must not lose the matrix.
  const canExtraction = reading.rowKey !== null && onOpenExtractionRow !== undefined
  const review = reading.review
  return (
    <div className="evrow" data-testid={`reading-${reading.key}`}>
      <div className="evrow-head">
        {reading.caption ?? 'Reading'}
        <span className="evrow-spacer" />
        <span className="evrow-nav">
          {/* `getExtractionRows` returns CURRENT runs only, so a superseded
              run's readings have no record in the matrix to open. The button is
              absent rather than dead — there is genuinely nowhere to go. */}
          {canExtraction && (
            <button
              type="button"
              className="evrow-btn"
              data-testid={`reading-extraction-${reading.key}`}
              data-tip="Open this reading in the Extraction matrix, beside every other paper's answer for these fields."
              onClick={() =>
                onOpenExtractionRow!(reading.rowKey!, reading.schemaId ?? undefined)
              }
            >
              extraction ↗
            </button>
          )}
          {/* The Review button CARRIES the state, so the flag and the way to act
              on it are one control rather than a badge beside a button
              repeating it. A clean reading is the one ineligible case, and it is
              dimmed IN PLACE rather than removed, so the pair never shifts
              position from row to row and the absence explains itself. */}
          {review && onOpenReview ? (
            <button
              type="button"
              className={`evrow-btn ${review.tone === 'conflict' ? 'conflict' : 'review'}`}
              data-testid={`reading-review-${reading.key}`}
              data-tip={
                review.tone === 'conflict'
                  ? 'This reading disagrees with another for the same subject. Opens it in the Review queue, where the conflict can be settled.'
                  : 'A second reading of the paper contradicted this. Opens it in the Review queue, where it can be confirmed or corrected.'
              }
              onClick={() => onOpenReview(review.factId)}
            >
              {review.tone === 'conflict' ? 'conflicting ↗' : 'needs review ↗'}
            </button>
          ) : (
            <span
              className="evrow-btn is-clear"
              aria-disabled="true"
              data-testid={`reading-review-clear-${reading.key}`}
              data-tip="Nothing was flagged on this reading, so it has no entry in the Review queue."
            >
              review
            </span>
          )}
        </span>
      </div>
      <div className="evrow-fields">
        {reading.fields.map((f) => (
          <FieldLine
            key={`${f.factId}-${f.label}`}
            field={f}
            activeSpan={activeSpan}
            onActivateSpan={onActivateSpan}
            anchorable={anchorable}
            spanColors={spanColors}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * One field of one reading: `[label] [value] [evidence dot]`.
 *
 * The coloured DOT is the evidence affordance — it wears the exact hue of this
 * span's band in the PDF, so the mapping claim <-> passage is readable without
 * a repeated "evidence →" label on every one of twenty lines. The arrow that
 * label carried surfaces on hover, where a label is actually read.
 *
 * A quote that could not be anchored leaves the line VISIBLE and inert, marked
 * with a hollow dashed dot and a tip saying why: evidence that could not be
 * located is never silently dead.
 */
function FieldLine({
  field,
  activeSpan,
  onActivateSpan,
  anchorable,
  spanColors
}: {
  field: FieldLineVM
  activeSpan: string | null
  onActivateSpan: (id: string) => void
  anchorable: Set<string>
  spanColors: Map<string, string>
}): JSX.Element {
  const spanId = field.evidence ? `ev-${field.evidence.id}` : null
  const traceable = spanId !== null && anchorable.has(spanId)
  const active = spanId !== null && activeSpan === spanId
  const evColor = traceable && spanId ? spanColors.get(spanId) ?? null : null
  const pill = KIND_PILL[field.kind]
  const kindMeta = pill ? factKindMeta(field.kind) : null
  const loc = field.evidence
    ? [field.evidence.section, field.evidence.page ? `p.${field.evidence.page}` : null]
        .filter(Boolean)
        .join(' · ')
    : ''
  return (
    <>
      <div
        className={`pv-claim evfield ${active ? 'is-showing' : ''} ${
          traceable ? '' : 'pv-claim-inert is-unanchored'
        } ${field.carried ? 'is-carried' : ''}`}
        data-testid={`fact-${field.factId}`}
        data-aid={spanId ?? undefined}
        data-anchored={traceable ? 'yes' : 'no'}
        style={evColor ? ({ '--ev-color': evColor } as CSSProperties) : undefined}
        role={traceable ? 'button' : undefined}
        tabIndex={traceable ? 0 : undefined}
        onClick={traceable ? () => onActivateSpan(spanId!) : undefined}
        onKeyDown={
          traceable
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onActivateSpan(spanId!)
                }
              }
            : undefined
        }
      >
        <span className="evfield-label mono">{field.label}</span>
        <span className="evfield-value mono">
          {field.value}
          {field.unit && <span className="u"> {field.unit}</span>}
          {kindMeta && (
            <span className={`k ${pill}`} data-tip={kindMeta.hint}>
              {kindMeta.label}
            </span>
          )}
          {/* NO "↑" ditto here. In the matrix the dittoed cell sits a few pixels
              under its source; in a stacked sidebar that row may be scrolled
              away, so withholding the value would leave a hole. It is restated
              in full and the fact that it was stated once is a quiet mark. */}
          {field.carried && (
            <span
              className="carried"
              data-tip="Stated once for the whole paper and applies to this reading too. Restated in full here rather than dittoed, because the row it was stated in may be scrolled out of view."
            >
              paper-level
            </span>
          )}
        </span>
        <span className="evfield-ev">
          {traceable ? (
            <span
              className="pv-claim-trace ev-dot"
              data-testid={`fact-evidence-${field.factId}`}
              role="img"
              aria-label="Show this value's evidence in the document."
              data-tip="Show this value's evidence in the document."
            />
          ) : (
            <span
              className="pv-claim-unanchored ev-none"
              data-testid={`fact-unanchored-${field.factId}`}
              // Two different events, and the second is not an omission: a
              // value read from a table or figure IMAGE has no quote because
              // there was no text to quote, which "no quote was recorded" reads
              // as somebody having failed to record one.
              data-tip={
                spanId
                  ? 'This value has an evidence quote, but it could not be located in the document text.'
                  : 'This value was read from a table or figure image, so there is no text in the document to point at.'
              }
            />
          )}
        </span>
      </div>
      {/* The quote opens directly under the LINE that was clicked, tinted to
          that span's hue — the same hue as its band in the document. */}
      {active && field.evidence?.quote && (
        <blockquote
          className="evquote"
          data-testid={`fact-quote-${field.factId}`}
          style={evColor ? ({ borderLeftColor: evColor } as CSSProperties) : undefined}
        >
          {field.evidence.quote}
          {loc && <div className="evquote-meta mono">{loc}</div>}
        </blockquote>
      )}
    </>
  )
}
