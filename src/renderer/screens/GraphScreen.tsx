import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import * as d3 from 'd3'
import type {
  GraphDTO,
  GraphNodeDTO,
  RankingRowDTO,
  ReferenceRetrievalStatus,
  UnresolvedReferenceNodeDTO
} from '@shared/contract'
import type { CitationEdgeDTO } from '@shared/types'
import { PAPER_RETRIEVAL_OFF_SENTENCE } from '@shared/contract/plugins'
import { referenceLabel } from '@shared/referenceLabel'
import { useAsync } from '../lib/useAsync'
import { expansionForDisplay, relevanceForDisplay } from '../lib/format'
import {
  HIGH_CITATION,
  RING_EXCLUDED,
  RING_HIGHLY_CITED,
  RING_METHOD,
  RING_PRIMARY,
  RING_REVIEW,
  isMethodType,
  isReviewType,
  ringCategory,
  ringCategoryColor
} from '../lib/workType'
import { parseWhyRank } from '../lib/whyRank'
import { useTabVisible, useVisibleInterval } from '../lib/visibility'
import { DataView, EmptyState } from '../components/States'
import { Select, SwitchField, cardStyle } from '../components/ui'
import { ReadAbstractButton } from '../components/ReferenceAbstract'
import {
  EvidenceBody,
  occurrenceCount,
  shownContexts
} from '../components/EvidenceCard'

/**
 * A node on the canvas, which is NOT the same set as the works in the project.
 *
 * The exploration walks citation edges, and a citation crosses project
 * boundaries — a work is stored ONCE globally and only its interpretation is
 * per-project — so an endpoint is often a work this project's pool does not
 * contain. Such a node is built from the edge alone, and `has_text` is what the
 * edge reported about it: whether anything was ever FETCHED for that paper.
 *
 * THE TWO FACTS ARE SEPARATE and must not be conflated. "This project does not
 * contain it" says nothing about whether its PDF is on disk; a paper sitting in
 * another project is fully retrieved and opens perfectly. Treating absence from
 * the pool as absence from the corpus drew exactly that paper as a grey dashed
 * dead end next to an "Open paper detail" button that showed its full text.
 *
 * `off_pool` marks WHICH SOURCE a node came from, and is carried explicitly
 * rather than sniffed from some field being absent. The two origins populate
 * different fields, and a null means a different thing in each: a pool node's
 * null `content_status` is a read that RAN and found no document, while an
 * off-pool node's absent `has_text` is a question nobody asked. A reader of a
 * node cannot interpret either field without first knowing which kind it holds.
 *
 * `authors` and `identifier` are OPTIONAL here though the DTO requires them,
 * for the same reason `has_text` is: a node built from an edge is answered by
 * whatever the edge carried, and an older main carries neither. Undefined means
 * NOT ASKED and renders nothing; an empty list would be a claim that the paper
 * has no authors, which is a different sentence and not one anyone verified.
 */
type CanvasNode = Omit<GraphNodeDTO, 'authors' | 'identifier'> & {
  off_pool?: true
  has_text?: boolean
  authors?: string[]
  identifier?: { scheme: string; value: string } | null
}
type SimNode = CanvasNode & d3.SimulationNodeDatum
type SimLink = {
  source: number | SimNode
  target: number | SimNode
  edge_type: string
  /**
   * The citation this line draws, and the evidence behind it.
   *
   * NULL for a line to a cited-but-absent paper. Those come from a parsed
   * bibliography entry, not from a `citation_edge` row: there is no verified
   * link, no role and no passage to show, so there is no card to open. Typing
   * it nullable rather than faking an edge is what keeps the popover from
   * offering evidence that does not exist.
   */
  edge: CitationEdgeDTO | null
}

// Chip filter keys shown in the toolbar (design: All / Reviews / Methods / Primary / High relevance).
type ChipKey = 'all' | 'review' | 'method' | 'primary' | 'high'

// Papers-rail sort. Mirrors the reference tree's SORTS so the two rails offer
// the same vocabulary; 'cited-here' is omitted because this screen draws one
// paper's neighbourhood rather than the whole in-corpus tree.
const SORTS = [
  { key: 'relevance', label: 'relevance', tip: "How closely the paper bears on this project's question." },
  { key: 'expansion', label: 'expansion', tip: 'How much new territory reading it would open up.' },
  { key: 'year', label: 'year', tip: 'Publication year, newest first.' },
  { key: 'citations', label: 'citations', tip: 'Citation count recorded in the corpus metadata (world-wide, not just this project).' },
  { key: 'title', label: 'title', tip: 'Alphabetical by title.' }
] as const
type SortKey = (typeof SORTS)[number]['key']

/**
 * Cited but not in the corpus. Deliberately the palette's lightest grey — these
 * are the only nodes on the canvas that carry no assessment, and giving one a
 * saturated ring would let a paper nobody has evaluated draw more attention
 * than one that has been. The ring is also DASHED, so the distinction is not
 * carried by tone alone.
 */
const RING_UNKNOWN = '#a89e91'

/**
 * The shape the cluster filter compares in: accent-blind, case-blind, and
 * blind to which separator a compound was printed with.
 *
 * Mirrors `foldForSearch` in `db/connection.ts`, which does this for the corpus
 * search — a bibliography is exactly where "Röthlisberger" and "off-the-shelf"
 * turn up, and a filter that made the reader reproduce the diacritics would be
 * the same bug that one fixed.
 */
const foldPlain = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[-\u2013\u2014_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

/**
 * Would printing the raw bibliography line under this title just repeat it?
 *
 * True when the title already covers most of the line — which happens when the
 * parser could not separate the two, and the "title" is the whole citation. The
 * comparison is on the FOLDED forms so punctuation and spacing differences do
 * not make two copies of the same text look distinct.
 */
const addsNothing = (title: string, raw: string): boolean => {
  const t = foldPlain(title)
  const r = foldPlain(raw)
  return r.includes(t) && t.length > 0.7 * r.length
}


// Edge stroke — matches the design's connectome edges (a hair lighter than the
// --border-2 token). Mirrors the local `--cg-edge` CSS var in graph.css. D3 sets
// SVG stroke as a concrete value, so the token is duplicated here as a constant.
const CG_EDGE = '#e0d9cf'
// Edges incident to the SELECTED node: a darker neutral, never the accent. The
// accent belongs to the single hovered edge (the one whose evidence popover is
// open), so the two emphases stay tellable apart.
const CG_EDGE_ON = '#b7ab9b'
// In-node citation label — design uses --muted-2 (#8a8073).
const NODE_LABEL = '#8a8073'
// The focused paper (chosen in the papers rail) is the root of the exploration,
// so it is ringed in the accent regardless of its category colour.
const RING_FOCUS = '#e2600f'

/**
 * Whether a node stands for a paper NOTHING HAS BEEN FETCHED FOR.
 *
 * The question is about the paper, not about this project. Two ways to be one,
 * and they get the same mark because they are one fact to a reader — "there is
 * nothing here to open yet":
 *
 *  - a cluster of unresolved references (a negative synthetic id);
 *  - a work row that exists only because a bibliography named it. Resolving a
 *    reference creates a real `work` and a real edge, which is right — the
 *    citation is a fact — but nothing was retrieved, so the row holds a title
 *    and no content. These took the ordinary solid orange primary ring,
 *    identical to a paper whose full text is on disk.
 *
 * ANSWERED BY WHICHEVER SOURCE THE NODE CAME FROM, and the two are NOT
 * interchangeable — which is why `off_pool` exists rather than a test on some
 * field being absent.
 *
 * A POOL node is one `getGraph` returned, and its `content_status` is a read
 * that RAN: `null` there means the work has no document row at all, which is
 * "nothing was ever fetched" just as surely as `unknown` is. Treating pool-null
 * as "we did not look" is the original bug, kept alive for works that never got
 * so far as a document.
 *
 * An OFF-POOL node was built from an edge, and only `has_text` can speak for
 * it. `undefined` there is genuinely "not asked" — an older main omits the
 * field — and must stay silent. Absence from the pool is NOT itself a
 * shortfall: it usually means the paper belongs to another project, where it
 * may be sitting fully retrieved.
 *
 * `abstract-only` counts as HELD — an abstract is text the app fetched and can
 * analyse, and it is already badged as the shortfall it is. `metadata-only`,
 * `unknown` and null are not.
 */
const HELD_CONTENT = new Set(['fulltext', 'abstract-only'])
const isNotInCorpus = (n: CanvasNode): boolean => {
  if (isUnknownId(n.id)) return true
  if (n.off_pool) return n.has_text === false
  return !HELD_CONTENT.has(n.content_status ?? '')
}

const isReview = (n: CanvasNode): boolean => isReviewType(n.work_type)
const isMethod = (n: CanvasNode): boolean => isMethodType(n.work_type)
const isPrimary = (n: CanvasNode): boolean => !isReview(n) && !isMethod(n)

const ringColor = (n: CanvasNode): string => {
  // Checked FIRST. A cited-but-absent paper has no role, no type and no
  // assessment, so every test below would fall through to `primary` and paint
  // it as an ordinary paper of this corpus — which is exactly what it is not.
  if (isNotInCorpus(n)) return RING_UNKNOWN
  return ringCategoryColor(
    ringCategory(n.work_type, n.citation_count, n.inclusion_status === 'excluded')
  )
}

// A d3 link endpoint is a node id before the force layout resolves it and a
// SimNode object after; normalise to the numeric work id either way.
const edgeId = (endpoint: number | SimNode): number =>
  typeof endpoint === 'number' ? endpoint : endpoint.id

/**
 * How far a node or line recedes when a search excludes it.
 *
 * Faint enough to drop out of the reading order, not so faint it vanishes: the
 * excluded papers are still the SHAPE of the graph, and a reader needs to see
 * that a match sits in a dense region rather than alone.
 */
const DIM_OPACITY = 0.18

/** Papers in the top `HIGH_RELEVANCE_SHARE` of the canvas count as "high". */
const HIGH_RELEVANCE_SHARE = 1 / 3

/**
 * The score a paper must beat to count as highly relevant HERE.
 *
 * A RANK, NOT A FIXED CUT. A relevance is a cross-encoder logit through a
 * sigmoid: it orders papers and is not calibrated, so a constant like 0.6 means
 * nothing on its own and means something different under every project
 * description — one corpus would have every paper above it and another none.
 * Taking the top third of what is actually on the canvas is the only reading
 * the number supports.
 *
 * UNSCORED PAPERS ARE NOT IN THE POPULATION. Nothing has looked at them, which
 * is a different fact from having looked and found little, so they neither set
 * the floor nor sit under it.
 *
 * IT RANKS THE RAW SCORES rather than reading the stored `relevance_rank`, and
 * that is not a duplication. The stored rank orders the whole PROJECT; this chip
 * says "the top third of what is on this canvas", and the canvas is a filtered,
 * capped subset. Reading the project rank here would leave a filtered view where
 * the chip selects a tenth of it, or all of it, depending on which papers the
 * cap happened to admit.
 */
const highRelevanceFloor = (nodes: readonly CanvasNode[]): number | null => {
  const scored = nodes
    .map((n) => n.relevance)
    .filter((r): r is number => r !== null)
    .sort((a, b) => b - a)
  if (scored.length === 0) return null
  // At least one paper, so the chip never refuses a canvas that HAS scores.
  const take = Math.max(1, Math.round(scored.length * HIGH_RELEVANCE_SHARE))
  return scored[take - 1]
}

const matchesChip = (n: CanvasNode, chip: ChipKey, floor: number | null): boolean => {
  switch (chip) {
    case 'review':
      return isReview(n)
    case 'method':
      return isMethod(n)
    case 'primary':
      return isPrimary(n)
    case 'high':
      // Never `?? 0`: that would read "nobody has scored this" as "this scored
      // zero", and hide a paper under a judgement nothing made.
      return floor !== null && n.relevance !== null && n.relevance >= floor
    default:
      return true
  }
}

// Render a 0..1 score as the design's "x/10" (one decimal).
//
// An UNSCORED paper renders NOTHING, matching the Ranking screen: these columns
// are null until something computes them, and a dash sitting in a column of
// numbers still reads as a value to be compared against them.
const toTen = (v: number | null | undefined): string =>
  v === null || v === undefined ? '' : String(Math.round(v * 10 * 10) / 10)
const isScored = (v: number | null | undefined): boolean => v !== null && v !== undefined
const toPct = (v: number | null | undefined): string =>
  v === null || v === undefined ? '0%' : `${Math.max(0, Math.min(100, Math.round(v * 100)))}%`
// Roles arrive as raw DB enum members. Render the shared label when the value is
// one we know, and the RAW STRING otherwise — an unrecognised role means the
// vocabulary was widened without this map being updated, and showing the raw
// value makes that visible instead of silently flattening it to "other".

// A node the exploration reached through a citation edge but which the project
// graph does not carry (an out-of-project cited work). It still deserves a node
// and a title; the scores it genuinely does not have stay null rather than 0, so
// the inspector prints "—" instead of inventing a rank.
/**
 * The node standing for everything ONE work cites that the corpus does not
 * hold, collapsed into a single mark.
 *
 * ONE PER CITING WORK, not one per reference. This corpus parses 874 unresolved
 * entries (765 after merging duplicates) across 19 papers — drawn individually
 * they were a haze that buried the works the graph exists to show, and no
 * reader was ever going to inspect them one at a time. Collapsed, each paper
 * gains a single companion node whose SIZE and printed COUNT say how much of
 * its bibliography is missing, which is the question actually being asked.
 *
 * THE ID IS NEGATED, and that is the whole mechanism. `work.id` is a positive
 * AUTOINCREMENT, so negating the citing work's id lands in a space no work can
 * occupy, and `isUnknownId` recovers which kind any id is without a lookup —
 * necessary because every map, selection, force link and D3 join on this screen
 * keys on one `number`, and a collision would silently make two different
 * things the same node.
 *
 * Deriving the id from the CITING WORK (rather than from an unresolved-row id,
 * as this did when there was a node per reference) also keeps it stable and
 * collision-free by construction: one work, one cluster, and the two id spaces
 * cannot overlap because both are keyed on `work.id`.
 *
 * These ids never leave this screen — nothing here sends one to main.
 */
const unknownClusterId = (citingWorkId: number): number => -citingWorkId
const isUnknownId = (id: number): boolean => id < 0
/** The work whose missing references a cluster stands for. */
const clusterWorkId = (nodeId: number): number => -nodeId

/**
 * The D3 join key for a line.
 *
 * A citation has a `citation_edge` id; a line to a cited-but-absent paper has
 * no edge at all, so it is identified by its endpoints — which is unique,
 * because one bibliography entry yields at most one line per citing work.
 * Prefixed so the two spaces cannot collide on a bare number.
 */
const linkKey = (l: SimLink): string =>
  l.edge ? `e${l.edge.id}` : `u${edgeId(l.source)}:${edgeId(l.target)}`

/**
 * A `GraphNodeDTO` standing for one work's cluster of cited-but-absent papers.
 *
 * Every SCORE is null rather than 0. Nothing here was ever assessed — these
 * papers are not in the corpus — and a 0 would draw an empty relevance bar that
 * reads as "judged, and found irrelevant". `work_type: 'unknown'` is what the
 * ring colour and the inspector key off to say so.
 *
 * `citation_count` carries the SIZE OF THE CLUSTER, which is what the ring
 * scale and the printed label both read. That is a deliberate reuse of the
 * degree channel: for an ordinary node the number means "how connected is
 * this", and here it means "how many missing papers is this" — in both cases
 * the mark's size answers "how much is attached to the paper beside it", which
 * is the only reading the canvas offers.
 */
const unknownClusterNode = (citingWorkId: number, count: number): GraphNodeDTO => ({
  id: unknownClusterId(citingWorkId),
  title: `${count} cited paper${count === 1 ? '' : 's'} not in corpus`,
  work_type: 'unknown',
  year: null,
  venue: null,
  relevance: null,
  relevance_rank: null,
  expansion_priority: null,
  expansion_rank: null,
  inclusion_status: null,
  scored_on: null,
  citation_count: count,
  reference_count: 0,
  unresolved_count: count,
  content_status: null,
  authors: [],
  identifier: null
})

/**
 * A node for a citation endpoint the project's own pool does not carry.
 *
 * USUALLY A PAPER IN ANOTHER PROJECT, not a paper that does not exist. The pool
 * is one project's works; a citation is not scoped to a project, so following
 * one out of the project is ordinary. `hasText` is the edge's answer about that
 * work globally, and it is the only thing here that may be read as a shortfall.
 *
 * `authors` and `identifier` likewise come FROM THE EDGE, and are passed
 * through undefined when it did not carry them. They were hardcoded empty once,
 * which named a paper in another project by its title alone while the same
 * paper opened from its own project printed its authors and its DOI.
 *
 * `work_type: 'unknown'` states what the POOL knows, which is nothing — the
 * type is a column this caller never fetched. It is not a claim about the paper
 * and nothing keys a shortfall off it.
 */
const stubNode = (
  id: number,
  title: string,
  hasText: boolean | undefined,
  authors: string[] | undefined,
  identifier: { scheme: string; value: string } | null | undefined
): CanvasNode => ({
  id,
  title,
  off_pool: true,
  has_text: hasText,
  authors,
  identifier,
  work_type: 'unknown',
  year: null,
  venue: null,
  relevance: null,
  relevance_rank: null,
  expansion_priority: null,
  expansion_rank: null,
  inclusion_status: null,
  scored_on: null,
  citation_count: 0,
  reference_count: 0,
  unresolved_count: 0,
  content_status: null
})

// What the node RING measures. `citation_count` alone is incoming-only, so a
// paper that cites eleven others and is cited by none was drawn tiny with a "0"
// in it while eleven lines ran out of it — the number contradicted the picture.
// Sizing on total degree makes the ring mean "how connected is this node in the
// graph you are looking at", which is what the lines already show.
const degreeOf = (n: CanvasNode): number =>
  (n.citation_count || 0) + (n.reference_count || 0)

export function GraphScreen({
  projectId,
  onOpenWork,
  onOpenQuote,
  onAddPapers
}: {
  projectId: number
  onOpenWork: (id: number) => void
  /** Open a paper scrolled to the passage carrying this citation text. */
  onOpenQuote?: (workId: number, quote: string) => void
  /** Leave for the Papers screen. Opening a project lands here, so on an empty
   *  project this screen owns the first action. */
  onAddPapers: () => void
}): JSX.Element {
  // The whole project is fetched ONCE as the node pool the exploration draws
  // from. Nothing is rendered from it directly: the canvas shows only the
  // focused paper plus whatever the user has expanded.
  /**
   * Bumped when this screen's own write changes who is IN the project.
   *
   * The pool is fetched once per project, which is right — it is the node
   * library the exploration draws from and nothing on the canvas changes it.
   * Adding a paper to the project IS such a change, and without a refetch the
   * node keeps the off-pool reading it was built with: still grey, still
   * offering an import that has already happened.
   */
  const [poolNonce, setPoolNonce] = useState(0)
  const state = useAsync<GraphDTO>(
    () => window.api.getGraph(projectId, { limit: 5000, minRelevance: 0 }),
    [projectId, poolNonce]
  )
  const [pool, setPool] = useState<GraphDTO | null>(null)
  useEffect(() => {
    if (state.data) setPool(state.data)
  }, [state.data])

  // ---- exploration state ----
  // `focusId` is the paper chosen in the rail: the root of this exploration.
  // `expanded` is every work whose citations have been pulled onto the canvas.
  // `edgesByWork` caches the fetched citation edges so re-expanding is free and
  // collapsing/re-selecting never refetches.
  const [focusId, setFocusId] = useState<number | null>(null)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [edgesByWork, setEdgesByWork] = useState<Map<number, CitationEdgeDTO[]>>(new Map())
  const [expanding, setExpanding] = useState<Set<number>>(new Set())

  /**
   * Whether cited-but-absent papers join the canvas.
   *
   * OFF by default, the opposite of the References tree. There the unknowns are
   * the subject — that screen exists to show what a bibliography rests on, and
   * offers retrieval. Here they are context: the Connectome is for tracing
   * argument between papers you HAVE, and ~840 dead-end nodes would bury the
   * dozen that carry evidence. So this screen asks for them, and that screen
   * puts them away.
   */
  const [showUnknowns, setShowUnknowns] = useState(false)
  /**
   * The unresolved references, fetched ONCE and only when first asked for.
   *
   * `getGraph` cannot supply these — it returns works and carries only an
   * `unresolved_count`. `getReferenceTree` already returns exactly what is
   * needed, and returns it MERGED: one node per cited paper with every citing
   * work named, which is what makes a shared reference show as one node with
   * several lines rather than as five separate dead ends.
   */
  const [unknowns, setUnknowns] = useState<UnresolvedReferenceNodeDTO[] | null>(null)
  const [unknownsLoading, setUnknownsLoading] = useState(false)
  /** The cited-but-absent list could not be READ — not the same as there being none. */
  const [unknownsUnread, setUnknownsUnread] = useState(false)
  /**
   * Whether a fetch is already in flight, as a REF rather than as state.
   *
   * `unknownsLoading` cannot guard the effect: it is state the effect sets, so
   * naming it in the deps re-runs the effect, and the re-run's cleanup sets
   * `cancelled = true` on the fetch that had just started. The result was a
   * switch stuck on "Loading…" forever — every attempt cancelled itself.
   * Observed, not theorised.
   */
  const unknownsInFlight = useRef(false)
  useEffect(() => {
    if (!showUnknowns || unknowns !== null || unknownsInFlight.current) return
    unknownsInFlight.current = true
    setUnknownsLoading(true)
    window.api
      .getReferenceTree(projectId, { limit: 5000, unresolvedPerWork: 5000 })
      .then((t) => {
        setUnknowns(t.unresolved ?? [])
        setUnknownsUnread(false)
      })
      // A failed fetch must not leave the switch claiming to show something —
      // and it must not draw the OTHER conclusion either. `[]` renders exactly
      // as "every reference in this project resolves", which is the one claim
      // the app is forbidden to make on no evidence: an unresolved reference
      // that is never surfaced is a paper the corpus silently dropped. So the
      // canvas stays as it was and the switch says the list is unread.
      .catch(() => {
        setUnknowns([])
        setUnknownsUnread(true)
      })
      .finally(() => {
        unknownsInFlight.current = false
        setUnknownsLoading(false)
      })
  }, [showUnknowns, unknowns, projectId])
  /**
   * Whether anything installed can go and FETCH a PDF, kept current.
   *
   * DERIVED FROM THE CAPABILITY, never from a plugin id — `paper-retrieval` is
   * a verb some module offers, and naming the module that happens to offer it
   * here would put a product's name in the app's own prose. The plugin host
   * pushes on every install, enable, disable and removal, so the button appears
   * and disappears with the thing behind it.
   *
   * A failure resolves to NOT AVAILABLE: an install that cannot be read is one
   * that cannot be relied on, and offering the action over it would fail on the
   * first press instead of saying so up front.
   */
  const [canRetrieve, setCanRetrieve] = useState(false)
  useEffect(() => {
    let alive = true
    const read = (): void => {
      void window.api
        .listPlugins()
        .then((list) => {
          if (!alive) return
          setCanRetrieve(
            list.plugins.some((p) => p.enabled && p.capabilities.includes('paper-retrieval'))
          )
        })
        .catch(() => {
          if (alive) setCanRetrieve(false)
        })
    }
    read()
    const off = window.api.onSharesChanged(read)
    return () => {
      alive = false
      off()
    }
  }, [])

  // A different project's unknowns are not these; drop them with the project.
  // The in-flight flag goes too, or a fetch that resolves after the switch
  // would leave the next project unable to start its own.
  useEffect(() => {
    setUnknowns(null)
    setUnknownsUnread(false)
    unknownsInFlight.current = false
  }, [projectId])

  /**
   * Live retrieval state per unresolved reference, learned SINCE the tree
   * snapshot the DTO carried.
   *
   * The DB is the source of truth — a retrieval must survive navigating away
   * and restarting — and this overlay holds what has been learned since,
   * so a row can flip to "importing" and later to "failed" without re-fetching
   * every reference in the project.
   */
  const [retrieveLive, setRetrieveLive] = useState<Map<number, ReferenceRetrievalStatus>>(
    () => new Map()
  )
  const [retrieveError, setRetrieveError] = useState<string | null>(null)
  /** Narrows the cluster list. A 202-entry bibliography needs one. */
  const [unknownFilter, setUnknownFilter] = useState('')
  const [bulkImporting, setBulkImporting] = useState(false)

  /** The work whose fetch this screen has just asked for, if any. */
  const [importingWork, setImportingWork] = useState<number | null>(null)

  /**
   * Go and get the paper behind a work the corpus knows only by name.
   *
   * `rerunStage('retrieve')` rather than `reprocessWork`: the paper's whole
   * pipeline is not stale, it simply never had a file — and re-running the lot
   * would re-read and re-analyse the papers this one is already linked to. The
   * cascade from `retrieve` carries the rest along on its own once a PDF lands.
   *
   * THE RESULT IS READ, NOT JUST AWAITED. `rerunStage` reports refusal by
   * RETURNING a `state` and almost never by throwing, so a `try/catch` alone
   * sees a resolved promise and reports success for a call that planned
   * nothing. `not-in-project` is the case that matters here and it is not
   * exotic: an off-pool node is by definition a paper this project does not
   * contain, which is exactly when this button is offered.
   *
   * So the two are done in order — join the project, then run the fetch. Adding
   * the membership is what the user pressing "Import paper" on this canvas is
   * asking for anyway; without it the stage has no project to plan under.
   */
  const importWork = useCallback(
    async (workId: number): Promise<void> => {
      setRetrieveError(null)
      setImportingWork(workId)
      try {
        await window.api.addWorkToProject(projectId, workId)
        const res = await window.api.rerunStage(workId, 'retrieve', projectId)
        // `note` names the real counts rather than a plausible sentence, so it
        // is shown verbatim instead of being re-worded here. Only the states
        // that planned NOTHING are surfaced: the others are the button doing
        // its job, and the queue is where their progress belongs.
        if (res.state === 'not-in-project' || res.state === 'no-current-runs') {
          setRetrieveError(res.note)
        }
        // A paper that just joined this project must appear in the pool, or the
        // node keeps its off-pool reading and the button keeps offering an
        // import that has already happened.
        setPoolNonce((n) => n + 1)
      } catch (e) {
        setRetrieveError(e instanceof Error ? e.message : String(e))
      } finally {
        setImportingWork(null)
      }
    },
    [projectId]
  )

  const statusOfRef = useCallback(
    (u: UnresolvedReferenceNodeDTO): ReferenceRetrievalStatus =>
      retrieveLive.get(u.id) ?? u.retrieval_status,
    [retrieveLive]
  )

  /**
   * Queue a real ingest for one cited-but-absent paper.
   *
   * Single-id calls into the same endpoint the References screen uses in bulk,
   * so both paths share one definition of what retrieval means — and the row is
   * painted from the WRITE'S OWN RESULT rather than from what was asked for,
   * because main skips ids that name nothing retrievable or are already in
   * flight. Claiming "importing" for a reference main declined would be a lie
   * the row never recovers from.
   */
  const importOne = useCallback(
    async (u: UnresolvedReferenceNodeDTO): Promise<void> => {
      setRetrieveError(null)
      setRetrieveLive((cur) => new Map(cur).set(u.id, 'retrieving'))
      try {
        const res = await window.api.retrieveUnresolvedReferences({
          projectId,
          unresolvedIds: [u.id]
        })
        setRetrieveLive((cur) => {
          const next = new Map(cur)
          for (const q of res.queued) next.set(q.unresolved_id, 'retrieving')
          // A skipped id is NOT being retrieved; put it back to what it was so
          // the row stops claiming otherwise.
          for (const s of res.skipped) next.set(s.unresolved_id, u.retrieval_status)
          return next
        })
        if (res.queued.length === 0 && res.skipped.length > 0) {
          setRetrieveError(
            res.skipped[0].reason === 'not-retrievable'
              ? 'That reference names nothing that could be looked up — no DOI, no title.'
              : 'That reference is already being retrieved.'
          )
        }
      } catch (e) {
        setRetrieveLive((cur) => new Map(cur).set(u.id, u.retrieval_status))
        setRetrieveError(e instanceof Error ? e.message : String(e))
      }
    },
    [projectId]
  )

  /**
   * Queue every reference the filter is currently showing that can be fetched.
   *
   * ONE call, not a loop of single-id calls: main takes a list, and firing 46
   * separate requests would race the queue and give 46 chances to half-fail.
   * The whole batch is painted in flight up front, then corrected from the
   * result — main returns exactly which ids it queued and which it skipped.
   */
  const importMany = useCallback(
    async (list: UnresolvedReferenceNodeDTO[]): Promise<void> => {
      if (list.length === 0) return
      setBulkImporting(true)
      setRetrieveError(null)
      const prior = new Map(list.map((u) => [u.id, u.retrieval_status]))
      setRetrieveLive((cur) => {
        const next = new Map(cur)
        for (const u of list) next.set(u.id, 'retrieving')
        return next
      })
      try {
        const res = await window.api.retrieveUnresolvedReferences({
          projectId,
          unresolvedIds: list.map((u) => u.id)
        })
        setRetrieveLive((cur) => {
          const next = new Map(cur)
          for (const q of res.queued) next.set(q.unresolved_id, 'retrieving')
          for (const s of res.skipped) {
            next.set(s.unresolved_id, prior.get(s.unresolved_id) ?? 'none')
          }
          return next
        })
        const notRetrievable = res.skipped.filter((s) => s.reason === 'not-retrievable').length
        if (notRetrievable > 0) {
          setRetrieveError(
            `${res.queued.length} queued. ${notRetrievable} could not be looked up — those entries name no DOI, title or venue.`
          )
        }
      } catch (e) {
        setRetrieveLive((cur) => {
          const next = new Map(cur)
          for (const u of list) next.set(u.id, prior.get(u.id) ?? 'none')
          return next
        })
        setRetrieveError(e instanceof Error ? e.message : String(e))
      } finally {
        setBulkImporting(false)
      }
    },
    [projectId]
  )

  // Poll whatever is in flight until it settles, so a row stops saying
  // "importing" when the job it names actually ends — including across a
  // restart, since the link lives in the DB and not in this component.
  const inFlightIds = useMemo(
    () =>
      [...retrieveLive.entries()].filter(([, s]) => s === 'retrieving').map(([id]) => id).sort(),
    [retrieveLive]
  )
  const inFlightKey = inFlightIds.join(',')
  /**
   * Which set of ids the answers currently in flight were asked about.
   *
   * A response that arrives after the set changed describes retrievals that are
   * no longer the ones being watched, and merging it would put a stale status
   * back on a row that had already settled.
   */
  const pollRef = useRef<{ key: string; ids: number[] }>({ key: inFlightKey, ids: inFlightIds })
  /**
   * The last status this poll OBSERVED per reference, so a landing can be told
   * from a row that has simply been retrieved for a while. Separate from the
   * rendered map because that one is also written by the import actions.
   */
  const seenRef = useRef<Map<number, string>>(new Map())
  useEffect(() => {
    pollRef.current = { key: inFlightKey, ids: inFlightIds }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inFlightKey])
  const tick = useCallback(async (): Promise<void> => {
    const { key, ids } = pollRef.current
    if (ids.length === 0) return
    const rows = await window.api.getReferenceRetrievals(ids)
    if (pollRef.current.key !== key) return
    // Decided BEFORE the update and outside the updater, which must stay a pure
    // function of its argument: React may call it twice, and a side effect in it
    // would fire the refetch twice for one landing.
    const landed = rows.some(
      (r) => r.retrieval_status === 'retrieved' && seenRef.current.get(r.unresolved_id) !== 'retrieved'
    )
    for (const r of rows) seenRef.current.set(r.unresolved_id, r.retrieval_status)
    setRetrieveLive((cur) => {
      const next = new Map(cur)
      for (const r of rows) next.set(r.unresolved_id, r.retrieval_status)
      return next
    })
    // A retrieval that SUCCEEDED added a real paper, which the canvas only learns
    // by re-reading — the reference should leave the cluster. Only when a row
    // this tick saw actually CHANGED to retrieved: a row stays retrieved for as
    // long as it is on screen, so testing the status alone would discard and
    // re-read the whole unknown-reference map every 1.5s indefinitely.
    if (landed) setUnknowns(null)
  }, [])
  // Only while something is actually in flight AND this screen is on screen. The
  // status it maintains lives in the DB, so a poll suspended while the user reads
  // something else loses nothing — the first tick after the graph is revealed
  // reports whatever happened in between.
  useVisibleInterval(() => void tick(), inFlightIds.length > 0 ? 1500 : 0)

  /**
   * Citing work id -> the references IT names that the corpus does not hold,
   * in bibliography order. What the inspector lists when a cluster is picked.
   *
   * Keyed by the citing work rather than by cluster node id so the inspector
   * can also name the paper the cluster belongs to without a second lookup.
   */
  const unknownsByCiter = useMemo(() => {
    const m = new Map<number, UnresolvedReferenceNodeDTO[]>()
    for (const u of unknowns ?? []) {
      for (const citer of u.citing_work_ids) {
        const list = m.get(citer)
        if (list) list.push(u)
        else m.set(citer, [u])
      }
    }
    // BY RELEVANCE, unscored last, then by the ordinal the bibliography printed.
    // A cluster runs to 202 entries here and the reader is working through them
    // to decide what to import, which is the question relevance answers —
    // bibliography order answers "where was it printed", which nobody is asking
    // of a list they came to triage. An unscored reference sorts to the end
    // rather than among the low scores: nothing looked at it, which is not the
    // same as having looked and found little.
    for (const list of m.values()) {
      list.sort(
        (a, b) =>
          (b.relevance ?? -1) - (a.relevance ?? -1) ||
          (a.ordinal ?? Infinity) - (b.ordinal ?? Infinity) ||
          a.id - b.id
      )
    }
    return m
  }, [unknowns])

  const [selectedId, setSelectedId] = useState<number | null>(null)
  // Clear the cluster filter when a DIFFERENT node is picked: a query typed
  // against one paper's references would silently hide most of the next one's
  // and read as an empty cluster.
  useEffect(() => setUnknownFilter(''), [selectedId])
  const [search, setSearch] = useState('')
  const [railQuery, setRailQuery] = useState('')
  const [railSort, setRailSort] = useState<SortKey>('relevance')
  const [chip, setChip] = useState<ChipKey>('all')
  // Hovercards carry VIEWPORT coordinates (clientX/clientY), not canvas-local
  // ones, because they render `position: fixed`. The canvas sits inside three
  // nested `overflow: hidden` boxes (.cg-grid > .cg-left > .cg-canvas-wrap), so
  // an absolutely-positioned card is CLIPPED at the canvas edge no matter how
  // high its z-index — clipping is not a stacking problem. Fixed positioning
  // takes the card out of that clip chain entirely.
  const [hover, setHover] = useState<{ node: CanvasNode; x: number; y: number } | null>(null)
  const [edgeHover, setEdgeHover] = useState<{ edge: CitationEdgeDTO; x: number; y: number } | null>(
    null
  )
  // CLICKING an edge PINS its card: it stops tracking the pointer, gains a
  // header you can drag it by and a close button, and its links become
  // clickable. The hover card is transient and non-interactive by design — you
  // cannot move the mouse onto something that follows the mouse — so the pinned
  // card is a separate piece of state rather than a mode flag on the hover one.
  const [pinned, setPinned] = useState<{ edge: CitationEdgeDTO; x: number; y: number } | null>(null)
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  // MEASURED canvas size. The force layout is computed against these numbers, so
  // the graph is never built (and therefore never painted) while the SVG still
  // measures 0×0 — a zero-size first pass would centre the layout on 0,0.
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })

  // Persistent D3 selections + lookups so the SELECTED-node highlight can
  // re-style existing DOM (orange halo ring, incident edges, title chip)
  // WITHOUT rebuilding/restarting the force simulation on every click.
  const nodeSelRef = useRef<d3.Selection<SVGGElement, SimNode, SVGGElement, unknown> | null>(null)
  const linkSelRef = useRef<d3.Selection<SVGLineElement, SimLink, SVGGElement, unknown> | null>(null)
  const selectedRef = useRef<number | null>(null)
  // ---- state that must SURVIVE a data update ----
  // Expanding a node adds nodes/edges; it must not feel like a page reload. The
  // simulation, the SVG groups and the zoom behaviour are therefore created ONCE
  // (per canvas size) and the data is joined into them incrementally. These refs
  // are what make that possible.
  const simRef = useRef<d3.Simulation<SimNode, SimLink> | null>(null)
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null)
  // Last committed zoom/pan. Re-applied after a rebuild so growing the graph
  // never yanks the viewport back to the identity transform.
  const transformRef = useRef<d3.ZoomTransform>(d3.zoomIdentity)
  // Node positions by work id, carried across joins so an existing node stays
  // exactly where it was when new neighbours arrive around it.
  const posRef = useRef<Map<number, { x: number; y: number }>>(new Map())
  const kickRef = useRef<() => void>(() => {})

  // "WHY THIS RANK" text lives on the ranking rows, not on graph nodes. Fetch
  // once per project and index by work_id; render gracefully if absent.
  const ranking = useAsync<RankingRowDTO[]>(() => window.api.getRanking(projectId), [projectId])
  const explanationById = useMemo(() => {
    const m = new Map<number, string>()
    for (const r of ranking.data ?? []) {
      if (r.ranking_explanation) m.set(r.work_id, r.ranking_explanation)
    }
    return m
  }, [ranking.data])
  const poolById = useMemo(() => {
    const m = new Map<number, GraphNodeDTO>()
    for (const n of pool?.nodes ?? []) m.set(n.id, n)
    return m
  }, [pool])

  // ---- pull one work's citations onto the canvas ----
  const expandWork = useCallback(
    async (workId: number): Promise<void> => {
      if (edgesByWork.has(workId)) {
        setExpanded((cur) => new Set(cur).add(workId))
        return
      }
      setExpanding((cur) => new Set(cur).add(workId))
      try {
        const edges = await window.api.getCitations(workId)
        setEdgesByWork((cur) => new Map(cur).set(workId, edges))
        setExpanded((cur) => new Set(cur).add(workId))
      } finally {
        setExpanding((cur) => {
          const next = new Set(cur)
          next.delete(workId)
          return next
        })
      }
    },
    [edgesByWork]
  )

  // Choosing a paper in the rail RESETS the exploration to that paper: a fresh
  // root, its own citations, nothing inherited from the previous focus.
  const focusPaper = useCallback(
    (id: number): void => {
      setFocusId(id)
      setSelectedId(id)
      setExpanded(new Set())
      setEdgeHover(null)
      setHover(null)
      void expandWork(id)
    },
    [expandWork]
  )

  // ---- the visible sub-graph ----
  // Nodes = the focus plus every endpoint reached from an expanded work. Edges =
  // every cached edge whose BOTH endpoints are visible, deduped by edge id (the
  // same edge is returned by both of its endpoints' getCitations calls).
  const view = useMemo(() => {
    if (focusId === null)
      return { nodes: [] as CanvasNode[], links: [] as SimLink[], candidates: [] as CanvasNode[] }
    const titleById = new Map<number, string>()
    // What the EDGES said about each endpoint's text. The only source for an
    // endpoint outside this project's pool, which the pool cannot answer for.
    const hasTextById = new Map<number, boolean>()
    // Likewise who wrote each endpoint and what it is called elsewhere. Only set
    // when the edge actually carried them, so an endpoint an older main did not
    // describe stays undefined — unasked — rather than authorless.
    const authorsById = new Map<number, string[]>()
    const identifierById = new Map<number, { scheme: string; value: string } | null>()
    const visible = new Set<number>([focusId])
    const edges = new Map<number, CitationEdgeDTO>()

    for (const workId of expanded) {
      for (const e of edgesByWork.get(workId) ?? []) {
        visible.add(e.citing_work_id)
        visible.add(e.cited_work_id)
        titleById.set(e.citing_work_id, e.citing_title)
        titleById.set(e.cited_work_id, e.cited_title)
        if (e.citing_has_text !== undefined) hasTextById.set(e.citing_work_id, e.citing_has_text)
        if (e.cited_has_text !== undefined) hasTextById.set(e.cited_work_id, e.cited_has_text)
        if (e.citing_authors !== undefined) authorsById.set(e.citing_work_id, e.citing_authors)
        if (e.cited_authors !== undefined) authorsById.set(e.cited_work_id, e.cited_authors)
        if (e.citing_identifier !== undefined)
          identifierById.set(e.citing_work_id, e.citing_identifier)
        if (e.cited_identifier !== undefined) identifierById.set(e.cited_work_id, e.cited_identifier)
        edges.set(e.id, e)
      }
    }

    const nodes: CanvasNode[] = [...visible].map(
      (id) =>
        poolById.get(id) ??
        stubNode(
          id,
          titleById.get(id) ?? `Work ${id}`,
          hasTextById.get(id),
          authorsById.get(id),
          identifierById.get(id)
        )
    )
    // The floor is taken over the WHOLE canvas before any chip narrows it, so
    // selecting "high relevance" cannot re-rank what is left and shrink the set
    // again on the next render.
    const floor = highRelevanceFloor(nodes)
    const keep = new Set(nodes.filter((n) => matchesChip(n, chip, floor)).map((n) => n.id))
    const links: SimLink[] = [...edges.values()]
      .filter((e) => keep.has(e.citing_work_id) && keep.has(e.cited_work_id))
      .map((e) => ({
        source: e.citing_work_id,
        target: e.cited_work_id,
        edge_type: e.edge_type,
        edge: e
      }))

    const shownNodes = nodes.filter((n) => keep.has(n.id))

    // ---- cited-but-absent papers, when asked for ----
    // Attached only to works ALREADY on the canvas: an unknown floating with no
    // line would be a dead end with nothing to say, and the whole reason to
    // draw one is to show which paper here rests on something missing.
    //
    // The chip filter is deliberately not applied to them. Every chip asks a
    // question about a work's assessment (review / method / primary / high
    // relevance) and an unresolved reference has been assessed for none of
    // them, so any chip would silently drop all of them and read as a bug.
    if (showUnknowns && unknowns) {
      // Counted PER CITING WORK. A reference cited by several works on the
      // canvas is counted in each of their clusters — it really is missing from
      // each of those bibliographies, and dropping it from all but one would
      // make a paper's cluster understate what that paper is missing. The
      // inspector says so rather than leaving the sums to look inconsistent.
      const byCiter = new Map<number, number>()
      for (const u of unknowns) {
        for (const citer of u.citing_work_ids) {
          if (keep.has(citer)) byCiter.set(citer, (byCiter.get(citer) ?? 0) + 1)
        }
      }
      for (const [citer, count] of byCiter) {
        const node = unknownClusterNode(citer, count)
        shownNodes.push(node)
        links.push({
          source: citer,
          target: node.id,
          edge_type: 'cites-unknown',
          edge: null
        })
      }
    }

    // `candidates` is the UNFILTERED set the chips are asked about. A chip's
    // population has to be counted before its own filter runs, or every chip
    // would report the size of the selection it just made.
    return { nodes: shownNodes, links, candidates: nodes }
  }, [focusId, expanded, edgesByWork, poolById, chip, showUnknowns, unknowns])

  const selected = useMemo(
    () => (selectedId === null ? null : view.nodes.find((n) => n.id === selectedId) ?? null),
    [selectedId, view.nodes]
  )

  // ---- measure the canvas (ResizeObserver) ----
  // Publishes the SVG's real pixel size into state. The render effect below is
  // gated on a NON-ZERO size, which is what guarantees the very first painted
  // frame is already centred: with a 0×0 measurement `forceCenter(w/2,h/2)`
  // would centre on 0,0 and every node would be drawn in the top-left corner.
  // Resizes are debounced so dragging the window doesn't relayout per frame.
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const measure = (): void => {
      const w = el.clientWidth
      const h = el.clientHeight
      setSize((cur) => (cur.w === w && cur.h === h ? cur : { w, h }))
    }
    measure() // synchronous first read — usually already non-zero
    const ro = new ResizeObserver(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(measure, 120)
    })
    ro.observe(el)
    return () => {
      if (timer) clearTimeout(timer)
      ro.disconnect()
    }
  }, [state.data, pool, focusId])

  // ---- D3 scaffold: built ONCE per canvas size ----------------------------
  // Everything that must SURVIVE a data change lives here: the <defs>, the
  // zoomable layer, the zoom behaviour and the simulation itself. Expanding a
  // node adds data to these — it does not recreate them — so the zoom/pan the
  // user set, and the positions the physics already found, both persist.
  useEffect(() => {
    if (!svgRef.current) return
    // HARD GATE: never build the graph before the canvas has real dimensions.
    // With a 0×0 measurement `forceCenter(w/2,h/2)` would centre on 0,0.
    if (size.w <= 0 || size.h <= 0) return
    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()
    const width = size.w
    const height = size.h

    // Soft drop-shadows on nodes (design: rings float above the canvas; the
    // selected/hovered node casts a stronger shadow). Two reusable SVG filters
    // live in defs and are referenced by url(); they are not part of the zoom
    // transform so they stay crisp at any scale.
    const defs = svg.append('defs')
    const rest = defs.append('filter').attr('id', 'node-shadow').attr('x', '-40%').attr('y', '-40%').attr('width', '180%').attr('height', '180%')
    rest
      .append('feDropShadow')
      .attr('dx', 0)
      .attr('dy', 1)
      .attr('stdDeviation', 1.5)
      .attr('flood-color', 'rgba(33,26,18,.18)')
    const strong = defs.append('filter').attr('id', 'node-shadow-strong').attr('x', '-60%').attr('y', '-60%').attr('width', '220%').attr('height', '220%')
    strong
      .append('feDropShadow')
      .attr('dx', 0)
      .attr('dy', 2)
      .attr('stdDeviation', 3.5)
      .attr('flood-color', 'rgba(33,26,18,.30)')



    // The node/link layer carries `cg-layer`, an OPACITY-ONLY fade-in (see
    // graph.css). It must never animate `transform`: on SVG elements a CSS
    // transform OVERRIDES the `transform` presentation attribute d3 writes, so a
    // scale()-based pop-in pins every node at the SVG origin (0,0) for the whole
    // animation — that was the original "nodes flash at 0,0" artifact.
    const g = svg.append('g').attr('class', 'cg-layer')
    g.append('g').attr('class', 'cg-links').attr('fill', 'none')
    g.append('g').attr('class', 'cg-nodes')

    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 4])
      .on('zoom', (ev) => {
        // Remember the transform so a later data join can restore it. Without
        // this, growing the graph snaps the viewport back to identity.
        transformRef.current = ev.transform
        g.attr('transform', ev.transform.toString())
      })
    svg.call(zoom)
    // Re-apply whatever zoom/pan was in force before this rebuild (a resize).
    svg.call(zoom.transform, transformRef.current)
    zoomRef.current = zoom

    const sim = d3
      .forceSimulation<SimNode>([])
      .force('link', d3.forceLink<SimNode, SimLink>([]).id((d) => d.id).distance(150).strength(0.22))
      // Repulsion is deliberately strong and given a wide max distance: the
      // default falls off so fast that a dense expansion collapses into an
      // unreadable knot. distanceMax caps the O(n²) reach so this stays cheap.
      .force('charge', d3.forceManyBody().strength(-1400).distanceMin(20).distanceMax(900))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('x', d3.forceX(width / 2).strength(0.03))
      .force('y', d3.forceY(height / 2).strength(0.03))
      .stop() // we drive the clock ourselves; d3's internal timer stays off
    simRef.current = sim

    return () => {
      sim.stop()
      simRef.current = null
      zoomRef.current = null
      nodeSelRef.current = null
      linkSelRef.current = null
    }
  }, [size.w, size.h])

  // ---- D3 data join: INCREMENTAL, never a teardown ------------------------
  // Runs whenever the visible sub-graph changes (expand, chip filter, focus).
  // Existing nodes keep their coordinates, the zoom transform is untouched, and
  // only the arrivals are seeded — so an expansion reads as growth rather than
  // a reload.
  useEffect(() => {
    const sim = simRef.current
    if (!sim || !svgRef.current) return
    if (size.w <= 0 || size.h <= 0) return
    const svg = d3.select(svgRef.current)
    const g = svg.select<SVGGElement>('g.cg-layer')
    const linkLayer = g.select<SVGGElement>('g.cg-links')
    const nodeLayer = g.select<SVGGElement>('g.cg-nodes')
    if (g.empty()) return

    const width = size.w
    const height = size.h
    const cx0 = width / 2
    const cy0 = height / 2

    // Carry over the live coordinates of every node still on screen. New
    // arrivals are seeded NEXT TO the node that pulled them in (or on a ring
    // around the centre for the very first paint), so they slide outward from
    // their parent instead of flying in from a corner.
    const prev = posRef.current
    for (const n of sim.nodes()) {
      if (n.x !== undefined && n.y !== undefined) prev.set(n.id, { x: n.x, y: n.y })
    }
    const anchor = (focusId !== null && prev.get(focusId)) || { x: cx0, y: cy0 }
    const nodes: SimNode[] = view.nodes.map((n, i) => {
      const at = prev.get(n.id)
      if (at) return { ...n, x: at.x, y: at.y }
      if (n.id === focusId) return { ...n, x: cx0, y: cy0 }
      const a = (i / Math.max(1, view.nodes.length)) * Math.PI * 2
      const r = 60 + Math.random() * 40
      return { ...n, x: anchor.x + r * Math.cos(a), y: anchor.y + r * Math.sin(a) }
    })
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const links: SimLink[] = view.links.map((l) => ({ ...l }))

    // Radius scaled by TOTAL degree across the visible set (in + out), so the
    // ring agrees with the number of lines actually attached to it.
    const maxDeg = Math.max(1, ...nodes.map(degreeOf))
    const rScale = d3.scaleSqrt().domain([0, maxDeg]).range([15, 32])
    const sizeOf = (n: CanvasNode): number =>
      n.id === focusId ? Math.max(26, rScale(degreeOf(n))) : rScale(degreeOf(n))
    const labelInside = (n: CanvasNode): boolean => sizeOf(n) >= 13
    const labelSize = (n: CanvasNode): number =>
      Math.max(9, Math.min(12, Math.round(sizeOf(n) * 0.5)))

    // ---- join edges (painted line + invisible hit line) ----
    // ONE straight line per citation. The direction lives in the popover, which
    // names the citing and cited paper explicitly; drawing it twice, or hanging
    // arrowheads on a hairline, added strokes without adding information.
    const px = (d: SimNode | number | undefined): number =>
      typeof d === 'number' || d === undefined ? 0 : (d.x ?? 0)
    const py = (d: SimNode | number | undefined): number =>
      typeof d === 'number' || d === undefined ? 0 : (d.y ?? 0)

    const link = linkLayer
      .selectAll<SVGLineElement, SimLink>('line.cg-edge')
      .data(links, (d) => linkKey(d as SimLink))
      .join(
        (enter) =>
          enter
            .append('line')
            .attr('class', 'cg-edge')
            .attr('stroke', CG_EDGE)
            .attr('stroke-width', 1),
        (update) => update,
        (exit) => exit.remove()
      )
    // A line to a cited-but-absent paper is DASHED, and that is not decoration:
    // a solid line here would claim the same standing as a verified citation
    // edge, when this one is a parsed bibliography entry that resolved to
    // nothing. The dash is the second channel beside the node's own treatment,
    // so the distinction survives a colourblind reader.
    link.attr('stroke-dasharray', (d) => (d.edge ? null : '3 3'))

    // A 1px line is far too thin to hover reliably, so an invisible fat line
    // rides on top of each edge and owns the pointer events.
    const hit = linkLayer
      .selectAll<SVGLineElement, SimLink>('line.cg-edge-hit')
      // Only lines that HAVE evidence get a hit target. A dashed line to an
      // unknown has no citation_edge, so there is no card to open — and a
      // pointer-cursor that opens nothing is worse than no affordance at all.
      .data(links.filter((l) => l.edge !== null), (d) => linkKey(d as SimLink))
      .join(
        (enter) =>
          enter
            .append('line')
            .attr('class', 'cg-edge-hit')
            .attr('stroke', 'transparent')
            .attr('stroke-width', 14)
            .style('cursor', 'pointer'),
        (update) => update,
        (exit) => exit.remove()
      )

    // Handlers are re-bound on every join so they close over the CURRENT link
    // selection (the old one is stale after an expansion adds elements).
    hit
      .on('mouseenter', (ev: MouseEvent, d) => {
        if (!d.edge) return
        // The ACCENT is the hover state and only the hover state: exactly one
        // edge is orange at a time — the one whose evidence card is open.
        link
          .filter((l) => linkKey(l) === linkKey(d))
          .attr('stroke', RING_REVIEW)
          .attr('stroke-width', 2.6)
        setEdgeHover({ edge: d.edge, x: ev.clientX, y: ev.clientY })
      })
      .on('mousemove', (ev: MouseEvent, d) => {
        if (!d.edge) return
        setEdgeHover({ edge: d.edge, x: ev.clientX, y: ev.clientY })
      })
      .on('mouseleave', (_ev, d) => {
        // Restore the RESTING look, which depends on whether this edge touches
        // the current selection — read from the ref so the handler never closes
        // over a stale selection.
        const selId = selectedRef.current
        link
          .filter((l) => linkKey(l) === linkKey(d))
          .attr('stroke', (l) =>
            selId !== null && (edgeId(l.source) === selId || edgeId(l.target) === selId)
              ? CG_EDGE_ON
              : CG_EDGE
          )
          .attr('stroke-width', (l) =>
            selId !== null && (edgeId(l.source) === selId || edgeId(l.target) === selId) ? 1.8 : 1
          )
        setEdgeHover(null)
      })
      // CLICK PINS the card: it stops following the pointer and becomes a real
      // popover the user can drag, read links out of, and close.
      .on('click', (ev: MouseEvent, d) => {
        ev.stopPropagation()
        if (!d.edge) return
        setPinned({ edge: d.edge, x: ev.clientX, y: ev.clientY })
        setEdgeHover(null)
      })

    // ---- join nodes ----
    const node = nodeLayer
      .selectAll<SVGGElement, SimNode>('g.gnode')
      .data(nodes, (d) => (d as SimNode).id)
      .join(
        (enter) => {
          // NOTE: deliberately NOT the global `nodePop` class — its keyframe
          // animates a CSS `transform: scale()`, which overrides the SVG
          // transform attribute and parks every node at 0,0 for its duration.
          const gn = enter
            .append('g')
            .attr('class', 'gnode')
            .attr('transform', (d) => `translate(${d.x ?? 0},${d.y ?? 0})`)
          // Halo sits BEHIND the ring and is only shown for the selection.
          gn.append('circle')
            .attr('class', 'cg-halo')
            .attr('fill', 'none')
            .attr('stroke', RING_REVIEW)
            .attr('stroke-width', 3)
            .attr('opacity', 0)
            .attr('pointer-events', 'none')
          gn.append('circle').attr('class', 'cg-ring-c').attr('fill', '#fff')
          gn.append('circle')
            .attr('class', 'cg-expanded-ring')
            .attr('fill', 'none')
            .attr('stroke', NODE_LABEL)
            .attr('stroke-width', 1)
            .attr('stroke-dasharray', '2 3')
            .attr('pointer-events', 'none')
          gn.append('text')
            .attr('class', 'cg-count-label')
            .attr('text-anchor', 'middle')
            .attr('dominant-baseline', 'central')
            .attr('font-family', 'Geist Mono, ui-monospace, monospace')
            .attr('fill', NODE_LABEL)
            .attr('pointer-events', 'none')
          return gn
        },
        (update) => update,
        (exit) => exit.remove()
      )

    // Attributes that depend on DATA are set on the merged selection, so an
    // existing node picks up a changed size / focus ring / expanded state
    // without being torn down and re-appended.
    node
      .attr('data-title', (d) => d.title)
      // Addressable from outside the canvas. The two kinds are named apart
      // because their ids come from different tables and only the prefix says
      // which space a number belongs to.
      .attr('data-testid', (d) =>
        isUnknownId(d.id)
          ? // Named by the work whose missing references it collects, since
            // that is what identifies a cluster.
            `graph-unknowns-of-${clusterWorkId(d.id)}`
          : `graph-node-${d.id}`
      )
      .style('cursor', 'pointer')
      .on('click', (ev: MouseEvent, d) => {
        ev.stopPropagation()
        setSelectedId(d.id)
      })
      .on('mouseenter', function (ev: MouseEvent, d) {
        if (d.id !== selectedRef.current)
          d3.select(this).select('circle.cg-ring-c').attr('filter', 'url(#node-shadow-strong)')
        setHover({ node: d, x: ev.clientX, y: ev.clientY })
      })
      .on('mousemove', function (ev: MouseEvent, d) {
        setHover({ node: d, x: ev.clientX, y: ev.clientY })
      })
      .on('mouseleave', function (_ev, d) {
        if (d.id !== selectedRef.current)
          d3.select(this).select('circle.cg-ring-c').attr('filter', 'url(#node-shadow)')
        setHover(null)
      })
    node.select('circle.cg-halo').attr('r', (d) => sizeOf(d as SimNode) + 4)
    node
      .select('circle.cg-ring-c')
      .attr('r', (d) => sizeOf(d as SimNode))
      .attr('stroke', (d) => ((d as SimNode).id === focusId ? RING_FOCUS : ringColor(d as SimNode)))
      .attr('stroke-width', (d) =>
        (d as SimNode).id === focusId
          ? 3.4
          : (d as SimNode).inclusion_status === 'excluded'
            ? 3
            : 2.4
      )
      // The second, non-colour channel for "this paper is not in the corpus":
      // an outline the eye reads as provisional. Set on the merged selection so
      // a node keeps it across re-joins.
      // The second, non-colour channel for an EXCLUDED paper: exclusion is the
      // reader's verdict, a different axis from work type, and sharing only the
      // colour channel with it left the two indistinguishable to a colourblind
      // reader.
      .attr('stroke-dasharray', (d) =>
        isNotInCorpus(d as SimNode)
          ? '3 3'
          : (d as SimNode).inclusion_status === 'excluded'
            ? '3 2'
            : null
      )
      .attr('filter', 'url(#node-shadow)')
    // An expanded node has already contributed its neighbourhood; a dotted outer
    // ring says so without competing with the role colour.
    node
      .select('circle.cg-expanded-ring')
      .attr('r', (d) => sizeOf(d as SimNode) + 6)
      .attr('opacity', (d) => (expanded.has((d as SimNode).id) ? 0.75 : 0))
    node
      .select('text.cg-count-label')
      .attr('font-size', (d) => labelSize(d as SimNode))
      .text((d) => (labelInside(d as SimNode) ? degreeOf(d as SimNode) : ''))

    nodeSelRef.current = node
    linkSelRef.current = link

    const paint = (): void => {
      link
        .attr('x1', (d) => px(d.source as SimNode))
        .attr('y1', (d) => py(d.source as SimNode))
        .attr('x2', (d) => px(d.target as SimNode))
        .attr('y2', (d) => py(d.target as SimNode))
      hit
        .attr('x1', (d) => px(d.source as SimNode))
        .attr('y1', (d) => py(d.source as SimNode))
        .attr('x2', (d) => px(d.target as SimNode))
        .attr('y2', (d) => py(d.target as SimNode))
      node.attr('transform', (d) => `translate(${d.x ?? 0},${d.y ?? 0})`)
    }

    // ---- hand the new data to the RUNNING simulation ----
    sim.nodes(nodes)
    sim.force<d3.ForceLink<SimNode, SimLink>>('link')?.links(links)
    // Collision radius must track the current sizes.
    sim.force('collide', d3.forceCollide<SimNode>().radius((d) => sizeOf(d) + 22).strength(0.9))

    const SETTLED_ALPHA = 0.015
    let raf: number | null = null
    const loop = (): void => {
      raf = null
      // Several ticks per frame: alpha decays per TICK, not per frame, so one
      // tick per frame makes convergence feel sluggish on a large expansion.
      sim.tick()
      sim.tick()
      paint()
      if (sim.alpha() > SETTLED_ALPHA || sim.alphaTarget() > 0) {
        raf = requestAnimationFrame(loop)
      }
    }
    const kick = (): void => {
      if (raf === null) raf = requestAnimationFrame(loop)
    }
    kickRef.current = kick
    // A GENTLE reheat, not a restart: alpha(1) would fling the settled part of
    // the graph across the canvas. 0.55 is enough for the newcomers to find
    // room while the existing layout only relaxes around them.
    sim.alpha(Math.max(sim.alpha(), 0.55))
    paint()
    kick()

    node.call(
      d3
        .drag<SVGGElement, SimNode>()
        .on('start', (ev, d) => {
          if (!ev.active) {
            sim.alphaTarget(0.3)
            kick()
          }
          d.fx = d.x
          d.fy = d.y
        })
        .on('drag', (ev, d) => {
          d.fx = ev.x
          d.fy = ev.y
          kick()
        })
        .on('end', (ev, d) => {
          // alphaTarget back to 0 lets alpha decay again; the loop then stops
          // itself on the next frame that falls under the threshold.
          if (!ev.active) sim.alphaTarget(0)
          d.fx = null
          d.fy = null
        })
    )

    // Persist positions for the NEXT join.
    posRef.current = new Map(
      nodes.map((n) => [n.id, { x: n.x ?? cx0, y: n.y ?? cy0 }])
    )
    void byId

    return () => {
      if (raf !== null) cancelAnimationFrame(raf)
    }
    // `search` is intentionally NOT a dep: it only dims non-matching nodes, and
    // re-joining on every keystroke would be janky. A dedicated effect applies it.
  }, [view, focusId, expanded, size.w, size.h])

  // ---- search dimming (no sim rebuild) ----
  useEffect(() => {
    const node = nodeSelRef.current
    const link = linkSelRef.current
    if (!node) return
    const q = search.trim().toLowerCase()
    // Resolved by ID against the current view, not by reading the endpoint
    // object: d3 rewrites a link's `source`/`target` from ids to node objects
    // only on the first tick, so an endpoint is still a bare number whenever
    // this runs before the layout has settled — which it does on every fresh
    // expansion.
    const titleById = new Map(view.nodes.map((n) => [n.id, n.title.toLowerCase()]))
    const isDim = (id: number): boolean => {
      if (!q) return false
      const t = titleById.get(id)
      return t !== undefined && !t.includes(q)
    }
    node.attr('opacity', (d) => (isDim(d.id) ? DIM_OPACITY : 1))

    // A line dims WITH the papers it joins. Left at full strength while its
    // endpoints faded, the citation between two pushed-away papers became one
    // of the strongest marks on the canvas — the graph read as broken rather
    // than filtered.
    //
    // EITHER endpoint dims the line, because a citation is only fully relevant
    // when both papers it joins are; a line running from a match out into the
    // background still asserts a connection the reader did not ask about.
    //
    // Applied to the painted line only. The invisible hit-line keeps its own
    // pointer events, so a dimmed edge can still be hovered for its evidence —
    // dimming is a change of EMPHASIS, not a removal of function.
    if (!link) return
    link.attr('opacity', (d) =>
      isDim(edgeId(d.source)) || isDim(edgeId(d.target)) ? DIM_OPACITY : 1
    )
  }, [search, view, size.w, size.h])

  // ---- selection highlight (no sim rebuild) ----
  // Keep `selected` OUT of the render effect's deps; instead re-style the
  // existing DOM by id whenever the selection changes: orange halo on the node,
  // accent (dashed for non-`cites`) on incident edges.
  useEffect(() => {
    selectedRef.current = selectedId
    const node = nodeSelRef.current
    const link = linkSelRef.current
    if (!node || !link) return
    const selId = selectedId

    node
      .select<SVGCircleElement>('circle.cg-halo')
      .attr('opacity', (d) => (d.id === selId ? 1 : 0))

    // Selected node carries the stronger drop-shadow (design's selected glow);
    // all others revert to the resting shadow.
    node
      .select<SVGCircleElement>('circle.cg-ring-c')
      .attr('filter', (d) => (d.id === selId ? 'url(#node-shadow-strong)' : 'url(#node-shadow)'))

    // Edges incident to the selection are DARKENED, not accented: the accent is
    // reserved for the one edge under the pointer, so "what am I about to read
    // the evidence for?" is never ambiguous. A non-`cites` edge stays dashed so
    // the emphasis does not rest on colour alone.
    const incident = (d: SimLink): boolean =>
      selId !== null && (edgeId(d.source) === selId || edgeId(d.target) === selId)

    link
      .attr('stroke', (d) => (incident(d) ? CG_EDGE_ON : CG_EDGE))
      .attr('stroke-width', (d) => (incident(d) ? 1.8 : 1))
      .attr('stroke-dasharray', (d) => (incident(d) && d.edge_type !== 'cites' ? '5 4' : null))
  }, [selectedId, view, size.w, size.h])

  /**
   * The chips, each carrying HOW MANY papers on the canvas it would keep.
   *
   * Counted against the unfiltered candidates, and shown rather than left to be
   * discovered by clicking: a chip whose population is zero used to answer with
   * an empty canvas, which is indistinguishable from a broken graph. `Methods`
   * did that on every corpus for as long as it existed, because the type it
   * tests for could not be stored.
   *
   * A zero chip is kept VISIBLE and refuses, instead of being hidden: the row is
   * also how a reader learns which kinds this corpus is sorted into, and a chip
   * that appears and disappears as the graph grows is a moving target. `All`
   * carries no count — the canvas caption already states the total.
   */
  const chips: { key: ChipKey; label: string; count: number | null; testid?: string }[] = useMemo(
    () => {
      const floor = highRelevanceFloor(view.candidates)
      const count = (k: ChipKey): number =>
        view.candidates.filter((n) => matchesChip(n, k, floor)).length
      return [
        { key: 'all', label: 'All', count: null },
        { key: 'review', label: 'Reviews', count: count('review') },
        { key: 'method', label: 'Methods', count: count('method') },
        { key: 'primary', label: 'Primary', count: count('primary') },
        {
          key: 'high',
          label: 'High relevance',
          count: count('high'),
          testid: 'graph-high-relevance'
        }
      ]
    },
    [view.candidates]
  )

  // A chip can lose its last paper while it is the active one — collapse a node
  // and the graph empties behind the filter. Standing down to `All` keeps the
  // canvas showing what is actually there rather than a filter nothing meets.
  const activeChipEmpty = chips.some((c) => c.key === chip && c.count === 0)
  useEffect(() => {
    if (activeChipEmpty) setChip('all')
  }, [activeChipEmpty])

  const emptyChipTip = (label: string): string =>
    `No paper on this canvas counts as ${label.toLowerCase()}. Nothing is wrong — there are none to show.`

  const rail = useMemo(() => {
    const q = railQuery.trim().toLowerCase()
    const cmp: Record<SortKey, (a: CanvasNode, b: CanvasNode) => number> = {
      relevance: (a, b) => (b.relevance ?? -1) - (a.relevance ?? -1),
      // THE RAW VALUE ORDERS, the rank only draws. A rank shares a position
      // between ties, so sorting by it collapses an order the scores really
      // make — and `?? 0` would file an unscored paper as if it had scored
      // zero. Matches the `relevance` comparator directly above.
      expansion: (a, b) => (b.expansion_priority ?? -1) - (a.expansion_priority ?? -1),
      year: (a, b) => (b.year ?? 0) - (a.year ?? 0),
      citations: (a, b) => (b.citation_count ?? 0) - (a.citation_count ?? 0),
      title: (a, b) => a.title.localeCompare(b.title)
    }
    // Title is the tie-break for every numeric sort, so the order is stable
    // rather than dependent on the DB's row order.
    const all = [...(pool?.nodes ?? [])].sort(
      (a, b) => cmp[railSort](a, b) || a.title.localeCompare(b.title)
    )
    return q ? all.filter((n) => n.title.toLowerCase().includes(q)) : all
  }, [pool, railQuery, railSort])

  // The number the rail row prints on the right tracks whatever it is sorted by,
  // so the ordering is always legible instead of being sorted by an invisible
  // value. Titles have no number of their own — fall back to relevance.
  const railMetric = useMemo(() => {
    switch (railSort) {
      case 'expansion':
        return { value: (n: CanvasNode) => toTen(expansionForDisplay(n)), tip: 'Expansion priority' }
      case 'year':
        return { value: (n: CanvasNode) => String(n.year ?? '—'), tip: 'Publication year' }
      case 'citations':
        return { value: (n: CanvasNode) => String(n.citation_count ?? 0), tip: 'Citation count' }
      default:
        return { value: (n: CanvasNode) => toTen(relevanceForDisplay(n)), tip: 'Topic relevance' }
    }
  }, [railSort])

  // Open on the rail's top paper instead of an empty canvas.
  //
  // `rail[0]`, not "the highest relevance in the pool": the rail is what the
  // user is looking at, so the paper that loads is the one their eye lands on,
  // whichever sort is active.
  //
  // Once only, and never again for the rest of the visit — `focusId !== null`
  // is not the guard, because the user may legitimately return to no selection,
  // and re-running then would drag them back to the top of the list. The ref
  // records that the choice was already made for them.
  const autoFocused = useRef(false)
  useEffect(() => {
    if (autoFocused.current) return
    const first = rail[0]
    if (!first) return
    autoFocused.current = true
    focusPaper(first.id)
  }, [rail, focusPaper])

  const selectedExpanded = selectedId !== null && expanded.has(selectedId)
  const selectedExpanding = selectedId !== null && expanding.has(selectedId)

  // ---- pinned card: drag by its header, close on Escape ----
  // A pinned card OUTLIVES the tab losing focus — it is deliberate state, not a
  // transient hover — so a Connectome tab sitting behind another one would keep
  // answering Escape and swallow it from whatever the user is actually reading.
  const tabVisible = useTabVisible()
  useEffect(() => {
    if (!pinned || !tabVisible) return
    const move = (e: MouseEvent): void => {
      const d = dragRef.current
      if (!d) return
      setPinned((cur) => (cur ? { ...cur, x: e.clientX - d.dx, y: e.clientY - d.dy } : cur))
    }
    const up = (): void => {
      dragRef.current = null
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPinned(null)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      window.removeEventListener('keydown', key)
    }
  }, [pinned, tabVisible])

  // The evidence body is shared by the hover card and the pinned card. The only
  // difference is INTERACTIVITY: a card that follows the pointer cannot hold
  // links (you can never reach them), so `interactive` gates the links rather
  // than the layout being written twice and drifting apart.
  return (
    <div className="screen screen-graph" data-testid="screen-graph">
      <DataView
        state={state}
        isEmpty={(d) => d.nodes.length === 0}
        empty={
          <EmptyState
            title="No papers in this project yet."
            hint="The connectome draws the citations between the papers you collect — who builds on whom. It fills in as papers arrive."
          >
            {/* Opening a project lands HERE, so on a new project this is the
                first screen anyone sees and it has to carry the first action
                rather than describe it. */}
            <div className="empty-state-actions">
              <button
                type="button"
                className="btn btn-primary"
                data-testid="graph-empty-add-papers"
                onClick={onAddPapers}
              >
                Add papers
              </button>
            </div>
          </EmptyState>
        }
      >
        {() => (
          <div className="cg-grid">
            {/* RAIL: every paper in the project; picking one roots the exploration */}
            <aside className="cg-papers" data-testid="graph-papers">
              <div className="cg-papers-head">
                <span className="eyebrow">Papers</span>
                <span className="cg-papers-n mono">{rail.length}</span>
              </div>
              <div className="cg-papers-filter">
                <input
                  className="input input-sm cg-papers-input"
                  data-testid="graph-papers-search"
                  placeholder="Find a paper"
                  value={railQuery}
                  onChange={(e) => setRailQuery(e.target.value)}
                />
                <Select<SortKey>
                  testid="graph-papers-sort"
                  ariaLabel="Sort papers by"
                  className="input-sm"
                  value={railSort}
                  format={(l) => `Sort: ${l}`}
                  options={SORTS.map((o) => ({ value: o.key, label: o.label, tip: o.tip }))}
                  onChange={setRailSort}
                />
                <SwitchField
                  label="Unknown papers"
                  on={showUnknowns}
                  onWord={unknownsLoading ? 'Loading…' : 'Shown'}
                  offWord="Hidden"
                  tip="Papers cited by the ones on the canvas but not in this corpus. Shown as dashed, unscored nodes — they are dead ends until retrieved."
                  testid="graph-show-unknowns"
                  onToggle={setShowUnknowns}
                />
                {showUnknowns && unknownsUnread && !unknownsLoading && (
                  <div className="cg-unknowns-unread" role="alert">
                    <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M10 2.6L18 16.6H2z" />
                      <path d="M10 8v3.6" />
                      <path d="M10 14.1v.1" />
                    </svg>
                    <span>
                      The cited-but-absent papers could not be read, so none are drawn. This
                      project may still have some.
                    </span>
                    <button
                      type="button"
                      className="btn btn-secondary cg-unknowns-retry"
                      data-testid="graph-unknowns-retry"
                      onClick={() => {
                        setUnknownsUnread(false)
                        setUnknowns(null)
                      }}
                    >
                      Try again
                    </button>
                  </div>
                )}
              </div>
              <div className="cg-papers-rows">
                {rail.length === 0 ? (
                  <div className="cg-papers-none">No paper matches that.</div>
                ) : (
                  rail.map((n) => {
                    const on = n.id === focusId
                    return (
                      <button
                        key={n.id}
                        type="button"
                        className={`cg-paper-row${on ? ' is-on' : ''}`}
                        data-testid={`graph-paper-${n.id}`}
                        aria-pressed={on}
                        data-tip={n.title}
                        onClick={() => focusPaper(n.id)}
                      >
                        <span className="cg-paper-dot" style={{ background: ringColor(n) }} />
                        <span className="cg-paper-title">{n.title}</span>
                        <span className="cg-paper-rel mono" data-tip={railMetric.tip}>
                          {railMetric.value(n)}
                        </span>
                      </button>
                    )
                  })
                )}
              </div>
            </aside>

            {/* CENTRE: toolbar + canvas + legend */}
            <div className="cg-left">
              <div className="cg-toolbar">
                <label className="cg-search">
                  <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                    <circle cx="9" cy="9" r="5.5" />
                    <path d="M13.5 13.5L17 17" />
                  </svg>
                  <input
                    className="cg-search-input"
                    data-testid="graph-search"
                    placeholder="Search within graph"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>

                <div className="cg-chips">
                  {chips.map((c) => {
                    const empty = c.count === 0
                    return (
                      <button
                        key={c.key}
                        type="button"
                        className={`cg-chip ${chip === c.key ? 'cg-chip-active' : ''}`}
                        data-testid={c.testid}
                        // `aria-disabled`, not `disabled`: a disabled button takes
                        // no pointer events, so its tooltip — the only thing that
                        // explains the zero — would never open.
                        aria-disabled={empty || undefined}
                        aria-label={empty ? `${c.label} — none on this canvas` : undefined}
                        // The relevance chip explains its rule even when it has
                        // papers: "high" is a RANK over this canvas, not a bar a
                        // paper clears on its own, and a reader comparing two
                        // projects would otherwise read the same word as the
                        // same threshold.
                        data-tip={
                          empty
                            ? emptyChipTip(c.label)
                            : c.key === 'high'
                              ? 'The third of the papers here that a model judged nearest to this project’s description. A rank over what is on the canvas — not a fixed score, which a relevance is not calibrated to give.'
                              : undefined
                        }
                        onClick={() => {
                          if (empty) return
                          setChip((cur) => (cur === c.key ? 'all' : c.key))
                        }}
                      >
                        {c.label}
                        {c.count !== null && <span className="cg-chip-count mono">{c.count}</span>}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="cg-canvas-wrap">
                <div className="cg-count mono" data-testid="graph-count">
                  {focusId === null
                    ? 'No paper selected'
                    : `${view.nodes.length} works · ${view.links.length} citations · ${expanded.size} expanded`}
                </div>
                <svg ref={svgRef} className="cg-canvas" data-testid="graph-svg" />
                {focusId === null && (
                  <div className="cg-canvas-empty" data-testid="graph-canvas-empty">
                    <div className="cg-canvas-empty-title">Pick a paper to start</div>
                    <div className="cg-canvas-empty-hint">
                      Its references are drawn around it. Expand any node to grow the graph.
                    </div>
                  </div>
                )}
                {hover &&
                  !edgeHover &&
                  createPortal(
                    <div
                      className="cg-hovercard"
                      data-testid="graph-hovercard"
                      style={cardStyle(hover.x, hover.y, 240, 70)}
                    >
                      <div className="cg-hovercard-title">{hover.node.title}</div>
                      <div className="cg-hovercard-stats mono">
                        {isScored(hover.node.relevance) && (
                          <span>REL {toTen(relevanceForDisplay(hover.node))}</span>
                        )}
                        {isScored(hover.node.expansion_priority) && (
                          <span>EXP {toTen(expansionForDisplay(hover.node))}</span>
                        )}
                      </div>
                    </div>,
                    document.body
                  )}
                {edgeHover &&
                  !pinned &&
                  createPortal(
                    <div
                      className="cg-edgecard"
                      data-testid="graph-edgecard"
                      style={cardStyle(
                        edgeHover.x,
                        edgeHover.y,
                        460,
                        // Rough height estimate: the header/paper block, plus one
                        // row per shown occurrence, capped by the list's own
                        // max-height. Only used to decide whether to flip, so an
                        // approximation is enough — but it has to be the right
                        // order of magnitude. A row is now labelled marks + a
                        // four-line quote + an expander + a jump (~112px), not
                        // the ~62px of the old two-chip row, so the old estimate
                        // ran ~30% short and a card near the bottom of the
                        // viewport failed to flip and was clipped.
                        150 +
                          Math.min(112 * shownContexts(edgeHover.edge).length, 260)
                      )}
                    >
                      <div className="cg-edgecard-head mono">
                        <span className="cg-edgecard-type">{edgeHover.edge.edge_type}</span>
                        <span className="cg-edgecard-n">{occurrenceCount(edgeHover.edge)}</span>
                      </div>
                      <EvidenceBody edge={edgeHover.edge} interactive={false} onOpenWork={onOpenWork} onOpenQuote={onOpenQuote} />
                      <div className="cg-edgecard-hint mono">click to pin</div>
                    </div>,
                    document.body
                  )}
              </div>

              <div className="cg-legend" data-testid="graph-legend">
                <span className="legend-item">
                  <span className="cg-ring" style={{ borderColor: RING_PRIMARY }} />
                  Primary
                </span>
                <span className="legend-item">
                  <span className="cg-ring" style={{ borderColor: RING_REVIEW }} />
                  Review
                </span>
                <span
                  className="legend-item"
                  data-tip={`Cited by ${HIGH_CITATION} or more papers in this corpus.`}
                >
                  <span className="cg-ring" style={{ borderColor: RING_HIGHLY_CITED }} />
                  Highly cited
                </span>
                <span className="legend-item">
                  <span className="cg-ring" style={{ borderColor: RING_METHOD }} />
                  Method
                </span>
                {/* A user verdict, not a type — named only when one is drawn. */}
                {view.nodes.some((n) => n.inclusion_status === 'excluded') && (
                  <span
                    className="legend-item"
                    data-tip="You excluded this paper from the project; it is still drawn so the shape of the corpus stays intact."
                  >
                    <span
                      className="cg-ring"
                      style={{ borderColor: RING_EXCLUDED, borderStyle: 'dashed' }}
                    />
                    Excluded
                  </span>
                )}
                {/* Only when they are on the canvas: a legend entry for
                    something not drawn sends the reader looking for it. */}
                {view.nodes.some(isNotInCorpus) && (
                  <span
                    className="legend-item"
                    data-tip="Nothing has been fetched for this paper — either a bibliography entry never matched to a paper, or a paper known only by the citation that named it. There is no text here to read."
                  >
                    <span
                      className="cg-ring cg-ring-unknown"
                      style={{ borderColor: RING_UNKNOWN }}
                    />
                    Not in corpus
                  </span>
                )}
                <span
                  className="legend-item cg-legend-note"
                  data-tip="Incoming citations plus outgoing references — i.e. the lines attached to it"
                >
                  ◯ size = connections
                </span>
                <span className="legend-item cg-legend-note">⌁ dotted = expanded</span>
              </div>
            </div>

            {/* RIGHT: always-visible inspector */}
            <aside className="cg-inspector" data-testid="graph-node-detail">
              {/* A cited-but-absent paper gets its OWN body rather than the
                  work inspector with empty fields. Relevance and expansion bars
                  reading 0/10, a status of "unread" and an Expand button that
                  can fetch nothing would each assert something about a paper
                  this app has never seen. What it can honestly show is what the
                  bibliography printed and which papers here cite it. */}
              {selected && isUnknownId(selected.id) ? (
                <div className="cg-inspector-body" data-testid="graph-unknown-detail">
                  <h3 className="cg-node-title">{selected.title}</h3>
                  <div className="cg-node-meta mono">
                    cited by {poolById.get(clusterWorkId(selected.id))?.title ?? 'this paper'}
                  </div>
                  <div className="cg-unknown-note">
                    Parsed out of that paper’s bibliography and never matched to a paper in
                    this corpus. The graph can show that they are missing, but nothing about
                    what they say.
                  </div>
                  {/* EVERY reference, not a sample. A cluster runs to 202 here,
                      and a truncated list makes the panel a teaser for a screen
                      the user is already looking at — they came here to work
                      through these. The list scrolls; the filter above it is
                      what makes 202 tractable.

                      Each row leads with the PARSED title, because that is what
                      a reader recognises. The raw bibliography line is kept —
                      the ontology requires it, and for an entry the parser could
                      not read it is the only thing there is — but it moves to a
                      second line where it informs without being the thing to
                      scan. */}
                  {(() => {
                    const all = unknownsByCiter.get(clusterWorkId(selected.id)) ?? []
                    const q = foldPlain(unknownFilter)
                    const shown = q
                      ? all.filter((u) =>
                          foldPlain(`${u.title ?? ''} ${u.raw_bib_text} ${u.venue ?? ''}`).includes(q)
                        )
                      : all
                    const importable = shown.filter(
                      (u) => u.retrieval_kind !== null && statusOfRef(u) === 'none'
                    )
                    return (
                      <div className="cg-unknown-bib">
                        <div className="cg-unknown-toolbar">
                          <input
                            className="input input-sm cg-unknown-filter"
                            data-testid="graph-unknown-filter"
                            placeholder={`Filter ${all.length} reference${all.length === 1 ? '' : 's'}`}
                            value={unknownFilter}
                            onChange={(e) => setUnknownFilter(e.target.value)}
                          />
                          <button
                            type="button"
                            className={`btn btn-primary cg-unknown-importall${
                              bulkImporting ? ' is-busy' : ''
                            }`}
                            data-testid="graph-import-all-unknowns"
                            aria-disabled={importable.length === 0 || bulkImporting}
                            data-tip={
                              importable.length === 0
                                ? 'Nothing here can be looked up right now — every entry is already imported, in flight, or names no identifier.'
                                : `Fetch all ${importable.length} papers and add them to your library. They arrive one by one.`
                            }
                            onClick={() => {
                              if (importable.length === 0 || bulkImporting) return
                              void importMany(importable)
                            }}
                          >
                            {bulkImporting ? 'Importing…' : `Import all (${importable.length})`}
                          </button>
                        </div>

                        {shown.length === 0 && (
                          <div className="cg-unknown-none">No reference matches that.</div>
                        )}

                        <ol className="cg-unknown-list" data-testid="graph-unknown-list">
                          {shown.map((u) => {
                            const st = statusOfRef(u)
                            const dead = u.retrieval_kind === null
                            // The button never disappears: a row whose action is
                            // unavailable has to say WHY, and an absent control
                            // reads as an oversight rather than an answer.
                            const canImport = !dead && st !== 'retrieving' && st !== 'retrieved'
                            return (
                              <li
                                key={u.id}
                                className={`cg-unknown-item${dead ? ' is-dead' : ''}`}
                                data-testid={`graph-unknown-row-${u.id}`}
                              >
                                <div className="cg-unknown-main">
                                  <div className="cg-unknown-title">
                                    {referenceLabel(u)}
                                  </div>
                                  <div className="cg-unknown-meta mono">
                                    {[
                                      u.ordinal !== null ? `#${u.ordinal}` : null,
                                      u.year !== null ? String(u.year) : null,
                                      u.venue
                                    ]
                                      .filter(Boolean)
                                      .join(' · ') || 'no year or venue printed'}
                                  </div>
                                  {/* Kept, but subordinate — and shown only when
                                      it ADDS something. For 15% of entries the
                                      parser could not separate a title from the
                                      citation, so the headline already IS the
                                      raw line and printing it again is the same
                                      text twice in two typefaces. Compared
                                      against the RENDERED label rather than the
                                      title, because the label may itself have
                                      fallen through to the raw line. */}
                                  {!addsNothing(referenceLabel(u), u.raw_bib_text) && (
                                    <div className="cg-unknown-raw" title={u.raw_bib_text}>
                                      {u.raw_bib_text}
                                    </div>
                                  )}
                                  {st === 'failed' && u.retrieval_error && (
                                    <div className="cg-unknown-err">{u.retrieval_error}</div>
                                  )}
                                </div>
                                {/* THE SAME SCORE THE PAPER SCREEN SHOWS, and
                                    the same shape: the figure over the badge,
                                    printed only where there is one. A reference
                                    nothing has scored says so by carrying
                                    nothing — a "—" here would be a measurement
                                    of nothing, and this list is long enough
                                    that a column of them would read as the
                                    scoring having failed rather than not having
                                    run. */}
                                {u.relevance !== null && (
                                  <span
                                    className="ur-rel"
                                    data-testid={`graph-unknown-relevance-${u.id}`}
                                  >
                                    {/* The same band the Paper screen shows, from
                                        the same field — a reference cannot be
                                        "high" in one panel and a bare 0.0038 in
                                        the other. */}
                                    {/* NO FALLBACK BAND. `?? 'low'` painted
                                        "low relevancy" onto a reference whose
                                        band had not been computed — a verdict
                                        nothing reached, dressed as one that
                                        was. A band nobody assigned shows
                                        nothing at all. */}
                                    {u.relevance_band !== null && (
                                      <span
                                        className={`ur-rel-band ur-rel-band-${u.relevance_band}`}
                                        tabIndex={0}
                                        data-tip={
                                          (u.scored_on === 'title'
                                            ? 'How near this paper is to what this project says it is for, from the title alone — no abstract was found for it. '
                                            : 'How near this paper is to what this project says it is for, from its title and abstract. ') +
                                          'Ranked against every other reference read the same way' +
                (u.relevance === null
                  ? '.'
                  : `; its score is ${u.relevance.toPrecision(2)}`) +
                ', which orders the list rather than measuring anything on its own.'
                                        }
                                      >
                                        {u.relevance_band === 'high'
                                          ? 'high relevancy'
                                          : u.relevance_band === 'medium'
                                            ? 'medium relevancy'
                                            : 'low relevancy'}
                                      </span>
                                    )}
                                    {u.scored_on === 'title' && (
                                      <span
                                        className="badge badge-warn scored-on-badge"
                                        tabIndex={0}
                                        data-tip="No abstract was found for this reference, so only the title it prints was compared against this project — a shorter read scores lower whatever the paper is worth."
                                      >
                                        title only
                                      </span>
                                    )}
                                  </span>
                                )}
                                {/* ABOVE the import, and stacked with it:
                                    reading what the paper says is how a reader
                                    decides whether to fetch it, so it comes
                                    first in the same column. */}
                                <span className="cg-unknown-acts">
                                <ReadAbstractButton
                                  state={u.abstract_state}
                                  printedTitle={referenceLabel(u)}
                                  testid={`graph-abstract-unknown-${u.id}`}
                                />
                                <button
                                  type="button"
                                  className={`btn btn-secondary cg-unknown-import${
                                    st === 'retrieving' ? ' is-busy' : ''
                                  }${st === 'retrieved' ? ' is-done' : ''}`}
                                  data-testid={`graph-import-unknown-${u.id}`}
                                  aria-disabled={!canImport}
                                  data-tip={
                                    dead
                                      ? 'This entry names nothing that could be looked up — no DOI, no title, no venue.'
                                      : st === 'retrieving'
                                        ? 'Being fetched and analysed now.'
                                        : st === 'retrieved'
                                          ? 'Already in the corpus.'
                                          : st === 'failed'
                                            ? `The last attempt failed${u.retrieval_error ? `: ${u.retrieval_error}` : ''}. Press to try again.`
                                            : `Fetch this paper by its ${u.retrieval_kind} and run it through the pipeline.`
                                  }
                                  onClick={() => {
                                    if (!canImport) return
                                    void importOne(u)
                                  }}
                                >
                                  {st === 'retrieving'
                                    ? 'Importing…'
                                    : st === 'retrieved'
                                      ? '✓ Imported'
                                      : st === 'failed'
                                        ? 'Retry'
                                        : dead
                                          ? 'No identifier'
                                          : 'Import'}
                                </button>
                                </span>
                              </li>
                            )
                          })}
                        </ol>
                      </div>
                    )
                  })()}
                  {retrieveError && (
                    <div className="cg-unknown-err" role="alert" data-testid="graph-import-error">
                      {retrieveError}
                    </div>
                  )}
                </div>
              ) : selected ? (
                <div className="cg-inspector-body">
                  <h3 className="cg-node-title">{selected.title}</h3>
                  {selected.authors !== undefined && selected.authors.length > 0 && (
                    <div className="cg-node-authors">{selected.authors.join('; ')}</div>
                  )}
                  {selected.identifier && (
                    <div className="cg-node-doi mono">
                      {selected.identifier.scheme}:{selected.identifier.value}
                    </div>
                  )}
                  <div className="cg-node-meta mono">
                    {selected.year ?? '—'} · {selected.work_type}
                  </div>

                  {/* Each bar is present only once its score is. A track drawn
                      at 0% is a score of zero rendered to scale, which is the
                      one reading an unscored paper must not produce. */}
                  <div className="cg-bars">
                    {isScored(selected.relevance) && (
                      <div className="cg-bar">
                        <div className="cg-bar-head mono">
                          <span>
                            TOPIC RELEVANCE
                            {/* ONLY the shortfall speaks. A paper with no
                                abstract was scored on a fraction of the text
                                every other paper offered, so its number is low
                                for a reason that is not about the paper; a
                                badge on the full ones too would be noise this
                                one has to shout over. */}
                            {selected.scored_on === 'title' && (
                              <span
                                className="badge badge-warn cg-scored-on"
                                tabIndex={0}
                                data-tip="This paper has no abstract here, so only its title was compared against the project — a shorter read scores lower whatever the paper is worth."
                              >
                                title only
                              </span>
                            )}
                          </span>
                          <span className="cg-bar-val-rel">{toTen(relevanceForDisplay(selected))}/10</span>
                        </div>
                        <div className="cg-bar-track">
                          <div className="cg-bar-fill cg-bar-fill-rel" style={{ width: toPct(relevanceForDisplay(selected)) }} />
                        </div>
                      </div>
                    )}
                    {isScored(selected.expansion_priority) && (
                      <div className="cg-bar">
                        <div className="cg-bar-head mono">
                          <span>EXPANSION PRIORITY</span>
                          <span className="cg-bar-val-exp">{toTen(expansionForDisplay(selected))}/10</span>
                        </div>
                        <div className="cg-bar-track">
                          <div className="cg-bar-fill cg-bar-fill-exp" style={{ width: toPct(expansionForDisplay(selected)) }} />
                        </div>
                      </div>
                    )}
                  </div>

                  {/* The two directions are shown SEPARATELY. A single
                      "citations" figure counted only incoming edges, so a paper
                      that cites eleven others and is cited by none read as
                      "0" beside eleven lines. */}
                  <div className="cg-stats">
                    <div className="cg-stat" data-tip="Works in this corpus that cite it">
                      <div className="cg-stat-label mono">CITED BY</div>
                      <div className="cg-stat-val">{selected.citation_count}</div>
                    </div>
                    <div
                      className="cg-stat"
                      data-tip={
                        selected.unresolved_count > 0
                          ? `${selected.reference_count} references resolved to a paper here; ${selected.unresolved_count} more were parsed but not matched`
                          : 'Its references that resolved to a paper in this corpus'
                      }
                    >
                      <div className="cg-stat-label mono">REFERENCES</div>
                      <div className="cg-stat-val">
                        {selected.reference_count}
                        {selected.unresolved_count > 0 && (
                          <span className="cg-stat-sub mono">+{selected.unresolved_count}</span>
                        )}
                      </div>
                    </div>
                    <div className="cg-stat">
                      <div className="cg-stat-label mono">STATUS</div>
                      <div className="cg-stat-val cg-stat-status">{selected.inclusion_status ?? 'unread'}</div>
                    </div>
                  </div>

                  <div className="cg-actions">
                    {/* WHICH ACTION, not whether the action is enabled. A paper
                        nothing has been fetched for is not a paper whose
                        citations could be expanded: it has no text, so no
                        bibliography was ever parsed and the button could only
                        ever add nothing to the canvas. What it needs is the
                        fetch — so that is the button it gets. */}
                    {isNotInCorpus(selected) ? (
                      <button
                        // `aria-disabled`, NOT `disabled`. A disabled button
                        // receives no pointer events, so the tip saying WHY it
                        // cannot be pressed would never open — and "nothing
                        // installed can fetch PDFs" is the entire content of
                        // this state. The click guard below is what makes it
                        // inert.
                        className={`cg-btn-expand${
                          importingWork === selected.id ? ' is-busy' : ''
                        }`}
                        data-testid="graph-import-paper"
                        aria-disabled={!canRetrieve || importingWork === selected.id}
                        data-tip={
                          canRetrieve
                            ? importingWork === selected.id
                              ? 'Being fetched now. It joins the queue like any other paper.'
                              : 'This paper is known only from a citation. Go and get it, then run it through the pipeline.'
                            : PAPER_RETRIEVAL_OFF_SENTENCE
                        }
                        onClick={() => {
                          if (!canRetrieve || importingWork === selected.id) return
                          void importWork(selected.id)
                        }}
                      >
                        {importingWork === selected.id ? 'Importing…' : 'Import paper'}
                      </button>
                    ) : (
                      <button
                        className="cg-btn-expand"
                        data-testid="graph-expand-citations"
                        disabled={selectedExpanded || selectedExpanding}
                        data-tip={
                          selectedExpanded
                            ? 'This paper’s citations are already on the canvas'
                            : undefined
                        }
                        onClick={() => void expandWork(selected.id)}
                      >
                        {selectedExpanding
                          ? 'Expanding…'
                          : selectedExpanded
                            ? 'Citations expanded'
                            : 'Expand citations'}
                      </button>
                    )}
                    <button className="cg-btn-open" onClick={() => onOpenWork(selected.id)}>
                      Open paper detail
                    </button>
                  </div>

                  {/* The import's own refusal, BESIDE THE BUTTON THAT CAUSED
                      IT. `rerunStage` reports "I planned nothing" by returning
                      a state, so without this the button flips back to its
                      resting label and the press reads as having worked. */}
                  {retrieveError && (
                    <div className="cg-unknown-err" role="alert" data-testid="graph-import-error">
                      {retrieveError}
                    </div>
                  )}

                  {explanationById.get(selected.id) &&
                    (() => {
                      const raw = explanationById.get(selected.id) as string
                      const parts = parseWhyRank(raw)
                      return (
                        <div className="cg-why">
                          <div className="cg-why-label mono">Why this rank</div>
                          {parts ? (
                            <div className="why-rank">
                              {(
                                [
                                  ['Relevance', 'rel', parts.relevance],
                                  ['Expansion priority', 'exp', parts.expansion]
                                ] as const
                              ).map(([name, tone, side]) => (
                                <div className="why-rank-row" key={tone}>
                                  <div className="why-rank-head">
                                    <span className="why-rank-name mono">{name}</span>
                                    {side.score !== null && (
                                      <span
                                        className={`why-rank-score why-rank-score-${tone} mono`}
                                      >
                                        {side.score}
                                      </span>
                                    )}
                                  </div>
                                  <div className="why-rank-reason">{side.reason}</div>
                                </div>
                              ))}
                              {parts.notes.map((n, i) => (
                                <div className="why-rank-reason why-rank-note" key={`${n}-${i}`}>
                                  {n}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="cg-why-body">{raw}</div>
                          )}
                        </div>
                      )
                    })()}
                </div>
              ) : (
                <div className="cg-inspector-empty">
                  <div className="cg-inspector-hint">
                    {focusId === null
                      ? 'Pick a paper on the left to root the graph.'
                      : 'Click a node to inspect it.'}
                  </div>
                </div>
              )}
            </aside>
          </div>
        )}
      </DataView>

      {/* PINNED evidence card. Rendered at the SCREEN root, not inside the
          canvas, so it is outside every `overflow: hidden` ancestor and can be
          dragged anywhere in the window. */}
      {pinned &&
        createPortal(
          <div
            className="cg-edgecard cg-edgecard-pinned"
            data-testid="graph-edgecard-pinned"
            style={{ left: pinned.x, top: pinned.y }}
          >
            <div
              className="cg-edgecard-head cg-edgecard-grab mono"
              data-testid="edgecard-drag"
              onMouseDown={(e) => {
                // Offset from the card's own origin, so the card does not jump to
                // centre itself under the cursor on the first mousemove.
                dragRef.current = { dx: e.clientX - pinned.x, dy: e.clientY - pinned.y }
                e.preventDefault()
              }}
            >
              <span className="cg-edgecard-type">{pinned.edge.edge_type}</span>
              <span className="cg-edgecard-n">{occurrenceCount(pinned.edge)}</span>
              <button
                type="button"
                className="cg-edgecard-close"
                data-testid="edgecard-close"
                aria-label="Close citation evidence"
                data-tip="Close (Esc)"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => setPinned(null)}
              >
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
                  <path d="M3 3l6 6M9 3l-6 6" />
                </svg>
              </button>
            </div>
            <div className="cg-edgecard-scroll">
              <EvidenceBody edge={pinned.edge} interactive onOpenWork={onOpenWork} onOpenQuote={onOpenQuote} />
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}
