// FROZEN IPC CONTRACT — the single source of truth for the main<->renderer
// boundary. Both the backend (main/preload) and the renderer build against this.
// Every method reads/writes ONLY the SQLite DB (seed-only-DB rule). DTOs must be
// structured-clone safe (plain data). Channel names are the `key` prefixed by
// the domain, e.g. 'projects:list'.
//
// If you add a method: add it here first, then implement in main IPC + preload +
// repositories. The renderer imports ONLY types from this file.

import type {
  ProjectDTO,
  ProjectWorkDTO,
  WorkDetailDTO,
  CitationEdgeDTO,
  CitationContextDTO
} from './types'

// Sections that grew big enough to own a file. RE-EXPORTED here so that
// `@shared/contract` remains the one import path every consumer already uses —
// splitting a file must not become a rename touching every call site.
export type { BaseDirDTO, BaseDirInputDTO, BaseDirPatchDTO } from './contract/storage'
export type {
  OutletCheckDTO,
  OutletStatusDTO,
  OutletActionDTO,
  OutletActionResultDTO,
  OutletSettingsDTO,
  ZoteroCollectionDTO,
  ZoteroImportResultDTO,
  ZoteroExportResultDTO,
  ZoteroTargetDTO,
  ZoteroConnectionDTO
} from './contract/outlets'
export type { ExportOptionDTO, ExportFileResultDTO } from './contract/export'
export type {
  SettingsTransferItemDTO,
  SettingsTransferFileDTO,
  SettingsImportResultDTO
} from './contract/settingsTransfer'
export type {
  PluginCapability,
  PluginParamKind,
  PluginParamOptionDTO,
  PluginParamDTO,
  PluginRunState,
  PluginStatusDTO,
  PluginDTO,
  PluginRemovedDTO,
  PluginListDTO,
  PluginConfigureInputDTO,
  PluginConfigureResultDTO,
  PluginTestResultDTO,
  PluginInstallResultDTO,
  PluginRepositoryDTO,
  PluginRepositoryTestDTO,
  SyncNowResultDTO,
  SharedProjectDTO,
  ShareResultDTO,
  JoinProjectInputDTO
} from './contract/plugins'
// The navigation vocabulary is shared with MAIN (it owns the tab model), so the
// contract re-exports it rather than declaring a second Route type that could
// drift from the one both processes actually key tabs by.
export type { Route, RouteName, NavEntry } from './nav'
import type { Route } from './nav'

import type { BaseDirDTO, BaseDirInputDTO, BaseDirPatchDTO } from './contract/storage'
import type {
  OutletStatusDTO,
  OutletActionDTO,
  OutletActionResultDTO,
  OutletSettingsDTO,
  ZoteroCollectionDTO,
  ZoteroImportResultDTO,
  ZoteroExportResultDTO,
  ZoteroTargetDTO,
  ZoteroConnectionDTO
} from './contract/outlets'
import type { ExportOptionDTO, ExportFileResultDTO } from './contract/export'
import type {
  SettingsTransferItemDTO,
  SettingsTransferFileDTO,
  SettingsImportResultDTO
} from './contract/settingsTransfer'
import type {
  PluginDTO,
  PluginListDTO,
  PluginConfigureInputDTO,
  PluginConfigureResultDTO,
  PluginTestResultDTO,
  PluginInstallResultDTO,
  PluginRepositoryDTO,
  PluginRepositoryTestDTO,
  SyncNowResultDTO,
  SharedProjectDTO,
  ShareResultDTO,
  JoinProjectInputDTO
} from './contract/plugins'

// ----------------------------------------------------------------- graph
export interface GraphNodeDTO {
  id: number
  title: string
  work_type: string
  year: number | null
  venue: string | null
  relevance: number | null
  expansion_priority: number | null
  /**
   * Where `expansion_priority` sits in THIS PROJECT'S order, 1 highest and 0
   * lowest, with ties sharing a position. Null whenever the priority is.
   *
   * FOR DISPLAY, and it is not interchangeable with the value beside it. The
   * priorities are heavily right-skewed — this corpus spans 0.0007 to 0.1231
   * with half the field under 0.02 — so a x/10 rendering of the raw number
   * printed 0 against six of twenty papers that had all been scored perfectly
   * well. The rank spreads them across the scale a reader can actually see.
   *
   * It measures ORDER, NOT DISTANCE: two papers whose means are a hair apart
   * are a whole step apart here, and the gap between rank 1 and rank 2 says
   * nothing about how much better the first is. Anything comparing magnitudes,
   * asking how far apart two papers are, or reasoning across projects must use
   * `expansion_priority`. Never store a rank as though it were a measurement —
   * it changes when a neighbour is added and this paper did not move.
   */
  expansion_rank: number | null
  /**
   * Where `relevance` sits in THIS PROJECT'S order, 1 highest and 0 lowest,
   * with ties sharing a position. Null whenever the relevance is.
   *
   * FOR DISPLAY, exactly like `expansion_rank`, and for a sharper version of
   * the same reason. Relevances are ordinal sigmoids off a cross-encoder and
   * are extremely right-skewed — 678 scored rows on this corpus span 0.00004
   * to 0.98 with a median of 0.00044 — so a x/10 rendering of the raw number
   * printed 0 against nearly everything and drew every bar empty.
   *
   * ORDER, NOT DISTANCE. It shifts when a neighbour is added though this paper
   * did not move, and it means nothing outside its project. Sorting, filtering,
   * comparing magnitudes and the "why this rank" sentence all read `relevance`.
   */
  relevance_rank: number | null
  inclusion_status: string | null
  /**
   * WHICH TEXT the relevance score beside it was read from — `title+abstract`
   * or `title`. Null when nothing has scored the paper, or when the score was
   * written before the column existed.
   *
   * Carried because a paper with no abstract is scored on a fraction of the
   * text every other paper offered, so its number is systematically lower for a
   * reason that is about the corpus rather than about the paper. Without this
   * the reader compares the two as if they were the same measurement.
   */
  scored_on: string | null
  /**
   * INCOMING edges: how many works in this corpus cite it. Named "citations"
   * because that is what a citation count means — it says nothing about how
   * many references the paper itself makes.
   */
  citation_count: number
  /**
   * OUTGOING edges: how many of this paper's references RESOLVED to a work in
   * the corpus. This is what the graph actually draws out of the node, so a
   * node with 0 citations and 11 lines is no longer a contradiction.
   */
  reference_count: number
  /**
   * References parsed out of the bibliography that did NOT resolve to a work.
   * Kept separate from `reference_count` rather than summed: a resolved
   * reference is a drawable edge, an unresolved one is a retrieval candidate,
   * and collapsing them would make the graph look like it is hiding edges it
   * could draw. Together they are the paper's full bibliography size.
   */
  unresolved_count: number
  content_status: string | null // fulltext | abstract-only | metadata-only ...
  /** Author names in position order. Empty when none are recorded. */
  authors: string[]
  /**
   * The work's FIRST identifier by scheme, or null when it has none.
   *
   * The scheme travels with the value rather than being assumed to be a DOI: a
   * work may only carry a PMID or an arXiv id, and labelling one of those "doi"
   * would print an identifier this corpus never held.
   */
  identifier: { scheme: string; value: string } | null
}
export interface GraphEdgeDTO {
  id: number
  source: number // citing_work_id
  target: number // cited_work_id
  edge_type: string
}
export interface GraphDTO {
  nodes: GraphNodeDTO[]
  edges: GraphEdgeDTO[]
  total_works: number
  shown_works: number
}

// ----------------------------------------------------------- reference tree
// The References screen lays the project's works out as a horizontal citation
// tree, so it needs EVERY in-project work (an omitted work silently changes
// another work's depth) plus, per work, the id of the document whose page 1 is
// drawn as the node thumbnail. `getGraph` gives neither: it caps at 200 by
// relevance and carries no document id.
export interface ReferenceTreeNodeDTO {
  /** Discriminator against `UnresolvedReferenceNodeDTO`. */
  kind: 'work'
  id: number
  title: string
  work_type: string
  year: number | null
  venue: string | null
  relevance: number | null
  /** Order, not distance — see `GraphNodeDTO.relevance_rank`. Display only. */
  relevance_rank: number | null
  expansion_priority: number | null
  /**
   * Order, not distance — see `GraphNodeDTO.expansion_rank`. Display only.
   *
   * Carried HERE as well as on the graph node because the same paper is drawn
   * on both screens: without it this tree rendered the raw priority and showed
   * "0" beside the "EXP 7" the Ranking screen showed for that very paper.
   */
  expansion_rank: number | null
  inclusion_status: string | null
  citation_count: number
  content_status: string | null
  /** Preferred document for this work, or null when the work has none. */
  document_id: number | null
}
/**
 * A parsed bibliography entry that is NOT (yet) a work in Corpus Studio.
 *
 * These are real, cited papers — the parser read them out of the citing PDF's
 * reference list — so the DAG must show them rather than silently dropping a
 * citation. They have no document and therefore no page-1 preview, which is why
 * the renderer draws a "?" placeholder instead of a thumbnail.
 *
 * The `kind` discriminator is what separates these from `ReferenceTreeNodeDTO`:
 * `kind: 'unresolved'` here, `kind: 'work'` there. Discriminating on a field
 * rather than on "does it have a document_id" keeps a metadata-only WORK (which
 * also lacks a document) from being mistaken for an unresolved reference.
 *
 * `id` is the `unresolved_reference` row id and is NOT a work id — the two
 * spaces overlap numerically, so the UI must key off `kind`, never off `id`
 * alone.
 *
 * ONE NODE PER PAPER, not per bibliography entry. The same cited paper is parsed
 * out of every citing paper's reference list, so it has one row per citer; main
 * merges those rows (by DOI, else by normalized title) into a single node whose
 * `citing_work_ids` names every work that cited it — exactly how a KNOWN paper
 * is one node with several incoming edges. `id` is the representative row and is
 * what retrieval keys on; `member_ids` is the full set it stands for.
 */
export interface UnresolvedReferenceNodeDTO {
  kind: 'unresolved'
  /**
   * A title an outside INDEX supplied, for an entry whose style printed none.
   * Beside `title`, never merged into it; non-null only where `title` is not.
   */
  index_title?: string | null
  /** How that title was established. Null exactly when `index_title` is. */
  index_title_from?: string | null
  /** unresolved_reference.id of the REPRESENTATIVE row — NOT a work id. */
  id: number
  /** Every work whose bibliography named this paper. Never empty. */
  citing_work_ids: number[]
  /** Every unresolved_reference row this node stands for, `id` included. */
  member_ids: number[]
  /** Parsed title, or null when the citation style printed none. */
  title: string | null
  year: number | null
  venue: string | null
  authors: string | null
  doi: string | null
  /** Position in the printed bibliography, for stable ordering. */
  ordinal: number | null
  /** The entry exactly as printed — the ontology requires it be preserved. */
  raw_bib_text: string
  status: string
  /** Where the attempt to GO AND GET this paper stands. See the type's doc. */
  retrieval_status: ReferenceRetrievalStatus
  /** The failure as reported by the job — shown, never swallowed. */
  retrieval_error: string | null
  /**
   * The best identifier this reference offers, or null when it offers NONE.
   * Null is the only non-retrievable case, and it is why the retrieve button
   * can legitimately be disabled: a bibliography entry with no DOI, no title
   * and no venue names nothing that could be looked up.
   */
  retrieval_kind: ReferenceRetrievalKind | null
  /** The query that identifier produces — what would actually be sent. */
  retrieval_query: string | null
  /**
   * How near the paper this reference names is to the project's question, from
   * the same cross-encoder that ranks the corpus. Null when nothing scored it —
   * no reranker packaged, no question written down, or a reference offering
   * neither an abstract nor a usable title. Never 0.
   */
  relevance: number | null
  /** `'title+abstract'` or `'title'`. Null exactly when `relevance` is. */
  scored_on: string | null
  /**
   * `relevance` as a word, which is the only form of it a reader can act on.
   *
   * These scores are sigmoids off a cross-encoder: ordinal, and on a real
   * corpus spanning 0.00004 to 0.98 with a median of 0.00044. Two significant
   * figures showed the magnitude honestly and still told nobody whether 0.0038
   * was good (it is — top fifth). The band is a PERCENTILE within the corpus
   * and within the scale the score was measured on, so "high" means high among
   * references read the same way. Null exactly when `relevance` is.
   *
   * Bands are for reading. The ORDER still comes from `relevance`, which is why
   * the number is kept beside this rather than replaced by it.
   */
  relevance_band: 'high' | 'medium' | 'low' | null
  /**
   * What an index said when asked for this reference's abstract — the STATE
   * only, never the text. See `ReferenceAbstractStateDTO`.
   */
  abstract_state: ReferenceAbstractStateDTO
}

/**
 * The outcome of asking an index for one reference's abstract, verbatim from
 * `reference_abstract.outcome`.
 *
 * FIVE VALUES AND NOT A BOOLEAN, and the reason is the same one the table was
 * built for. 'absent' is "an index answered and holds no abstract for this
 * paper"; 'unreachable' is "we could not ask". Collapsed into one "no abstract"
 * the second becomes a claim about the paper that nothing made, and the user is
 * told to stop looking for something that is probably there.
 * 'nothing-to-ask-with' is a third distinct thing: the reference printed no DOI
 * and no usable title, so no question could be formed at all.
 */
export type ReferenceAbstractOutcome =
  | 'found'
  | 'absent'
  | 'ambiguous'
  | 'unreachable'
  | 'nothing-to-ask-with'

/**
 * Whether a reference's abstract can be READ, without carrying the abstract.
 *
 * THE STATE RIDES ALONG, THE TEXT DOES NOT. Every row in a 200-reference panel
 * needs this to label and explain its own button; at most one of them is ever
 * opened. An abstract runs to a couple of kilobytes, so shipping the text with
 * the reference tree would put hundreds of kilobytes of prose through the IPC
 * boundary on every draw to serve one click. The text is fetched by
 * `getReferenceAbstract` when a reader asks for it.
 *
 * `outcome: null` means NO ROW EXISTS — nothing has looked yet, which is the
 * state a corpus mid-sweep is in. It is deliberately not folded into 'absent':
 * "we have not asked" and "we asked and there is none" are different answers,
 * and only the second is about the paper.
 */
export interface ReferenceAbstractStateDTO {
  /**
   * WHICH unresolved_reference row this state was read from, and therefore the
   * id `getReferenceAbstract` must be given to open it.
   *
   * Usually the row's own id, and carried explicitly for the case where it is
   * not: the reference tree merges every bibliography line naming the same
   * paper into ONE node, and the abstract may have been fetched under a sibling
   * line. An abstract is a fact about the paper, not about the line that
   * printed it, so the node reports the sibling's answer — and then has to say
   * where to go and get it, or the button it just enabled opens nothing.
   */
  unresolved_id: number
  outcome: ReferenceAbstractOutcome | null
  /**
   * An abstract is really stored. Read from the column rather than inferred
   * from `outcome === 'found'`: the two agree today, and a button that opens an
   * empty panel is what an inference would ship the day they stop.
   */
  has_abstract: boolean
  /** Which index answered — the reader is entitled to know whose claim this is. */
  source: 'openalex' | 'crossref' | null
  /**
   * The title of the record the abstract was taken FROM, which is not
   * necessarily the title the bibliography printed. A fetched record is a CLAIM
   * that this reference is that paper, and the reader must be able to check it.
   */
  matched_title: string | null
}

/**
 * One reference's abstract, fetched on demand.
 *
 * Returned even when there is no text: the caller asked about a reference, and
 * "no row" and "a row that says the index holds nothing" are different answers
 * that the panel says differently. `null` is reserved for "no such unresolved
 * reference".
 */
export interface ReferenceAbstractDTO {
  unresolved_id: number
  abstract: string | null
  matched_title: string | null
  doi: string | null
  source: 'openalex' | 'crossref' | null
  outcome: ReferenceAbstractOutcome | null
  /** When the index was asked, so a stale answer can be recognised as one. */
  fetched_at: string | null
}

/**
 * The life of a retrieval attempt on a cited-but-absent paper.
 *
 *   none       — never attempted (the resting state)
 *   retrieving — a job is queued or running for it
 *   failed     — the job ended without producing a document for the paper
 *   retrieved  — a document was actually obtained
 *
 * 'failed' is a first-class, EXPECTED outcome: this app is offline, so most
 * retrievals cannot succeed, and reporting that plainly is the point. A job
 * that merely finished is NOT 'retrieved' — only a real document is.
 */
export type ReferenceRetrievalStatus = 'none' | 'retrieving' | 'failed' | 'retrieved'
/** Which identifier a reference is retrievable BY (best available wins). */
export type ReferenceRetrievalKind = 'doi' | 'title'

/** Live state of one reference's retrieval, as the tree reads it back. */
export interface ReferenceRetrievalDTO {
  unresolved_id: number
  retrieval_status: ReferenceRetrievalStatus
  retrieval_error: string | null
  /** The processing_job driving it, or null when none was ever spawned. */
  job_id: number | null
  /** The work the retrieval created, so the Papers screen can be reached. */
  work_id: number | null
}

export interface ReferenceTreeDTO {
  nodes: ReferenceTreeNodeDTO[]
  edges: GraphEdgeDTO[]
  /** In-project works that exist, whether or not they fit under the cap. */
  total_works: number
  /** How many are in `nodes` — the UI discloses any shortfall. */
  shown_works: number
  /**
   * Cited-but-unknown references, to be drawn to the LEFT of their citing paper
   * (a reference precedes the work that cites it).
   */
  unresolved: UnresolvedReferenceNodeDTO[]
  /** How many exist in total, so the UI can disclose what it is not drawing. */
  total_unresolved: number
}

// ----------------------------------------------------------------- ranking
export interface RankingRowDTO {
  work_id: number
  title: string
  year: number | null
  work_type: string
  relevance: number | null
  /** Order, not distance — see `GraphNodeDTO.relevance_rank`. For display only. */
  relevance_rank: number | null
  expansion_priority: number | null
  /** Order, not distance — see `GraphNodeDTO.expansion_rank`. For display only. */
  expansion_rank: number | null
  inclusion_status: string
  /**
   * The user marked this paper as a project REFERENCE — a source they trust
   * enough to feed the topic dossier (§8).
   */
  is_reference: boolean
  /**
   * WHICH TEXT `relevance` was read from — `title+abstract` or `title`. Null
   * when nothing has scored this paper, or when the score predates the column.
   * See `GraphNodeDTO.scored_on` for why a title-only score must be visible as
   * such rather than compared silently against a full one.
   */
  scored_on: string | null
  ranking_explanation: string | null
  reviewed: number
  user_overrides: string | null // JSON: {relevance?, expansion_priority?, reason?}
}

// ----------------------------------------------------------------- provenance
export interface EvidenceSpanDTO {
  id: number
  document_id: number | null
  page: number | null
  section: string | null
  paragraph: number | null
  sentence: number | null
  figure: string | null
  table: string | null
  row: string | null
  caption: string | null
  quote: string | null
  /**
   * True ONLY when `quote` was found verbatim in the source document. False
   * means the model asserted this wording but it could not be located in the
   * text — the quote is still carried (it is what the model claimed to be
   * citing) but must never be presented as something the paper actually says.
   */
  verbatim: boolean
}
export interface FactDTO {
  id: number
  kind: string // 5-enum
  predicate: string
  subject: string | null
  object: string | null
  value_text: string | null
  evidence: EvidenceSpanDTO | null
  measurement: MeasurementDTO | null
}
export interface MeasurementDTO {
  id: number
  quantity: string
  value_num: number | null
  value_text: string | null
  unit: string | null
  error_num: number | null
  conditions: string | null
  fold: FoldImprovementDTO | null
}
export interface FoldImprovementDTO {
  id: number
  baseline_label: string
  improved_label: string
  fold: number | null
  comparability: string // directly|broadly|contextual|unclear
}
/**
 * One question about a stored record, and the answer a READER gave it.
 *
 * Every verdict here was reached by a model shown the record, its evidence quote
 * and the page around it — never by a rule comparing strings. A rule can only
 * ever demonstrate that an answer differs from what it expected, which on real
 * papers is routinely the rule being wrong, and a panel that flags correct
 * values is one the reader stops reading. A failing verdict annotates the
 * extraction and never corrects it.
 */
export interface AnalysisCheckDTO {
  id: number
  /** Stable machine key, e.g. 'duplicate-record'. */
  check_key: string
  /** Human label for the key, resolved in main so the UI invents no wording. */
  label: string
  /** `skipped` = the reader could not settle it from the text; it does NOT fail a run. */
  status: 'passed' | 'failed' | 'skipped'
  /** Why it reached that verdict, in words a reviewer can act on. */
  reason: string
  /** The record the verdict is about, when the question was per-record. */
  fact_id: number | null
  measurement_id: number | null
  /** Which model answered. */
  model: string | null
  /** Which prompt version it answered under. */
  prompt_version: string | null
}

/**
 * WHERE a run happened: `local` (this installation computed it), `shipped`
 * (precomputed during corpus preparation and distributed with the app) or
 * `imported` (brought in from another installation).
 *
 * Distinct from `model`/`provider`, which say WHICH model answered and remain
 * the authority on that. A shipped run IS a real model's real output; what this
 * answers is whether the user's own machine produced it — something they cannot
 * otherwise tell, and which changes what they should go and check.
 *
 * Every surface that presents a run's OUTPUT carries this, not just the ones
 * that show a provenance block. A value the user reads as "the app worked this
 * out" when it in fact arrived in the download is the exact misreading the
 * field exists to prevent.
 */
export type RunOrigin = 'local' | 'shipped' | 'imported'

export interface AnalysisRunDTO {
  id: number
  work_id: number
  project_id: number // 0 = global
  analysis_type: string
  model: string
  provider: string
  prompt_version: string
  schema_version: string
  run_timestamp: string
  /**
   * OUTPUT/SCHEMA VALIDATION of the model's response: did it return parseable
   * JSON conforming to the declared output schema? 'partial' means some facts
   * were salvaged from a malformed response. This is NOT an independent
   * verification pass and must never be labelled as one — `checks` is what
   * judged the extracted content.
   */
  verifier_result: string | null
  /**
   * DERIVED: 1 exactly when no verdict in `checks` failed. Kept as the one-bit
   * summary; `checks` is the detail behind it. A run nobody has read reads 0.
   */
  deterministic_validation: number
  /** Every verdict reached about this run's records, in the order they came. */
  checks: AnalysisCheckDTO[]
  supplied_project_context: string | null
  user_corrections: string | null
  superseded: number
  /**
   * Which extraction schema this run targeted; 0 = the generic (schema-less)
   * extraction. Part of the one-current-run key since v15, so two runs of the
   * same type on the same paper are only distinguishable by it.
   */
  schema_id: number
  /**
   * The schema's NAME, or null for the generic (schema_id = 0) run.
   *
   * Carried because `schema_id` is part of the one-current-run key: two CURRENT
   * runs of the same `analysis_type` on one paper are legitimate and differ only
   * by it. Any surface that lists runs must therefore identify them by
   * something a human can read, or it shows the user two identical labels for
   * two different extractions.
   */
  schema_name: string | null
  /**
   * The INPUT HASHES this run was stamped with. They exist to answer "was this
   * computed from inputs that have since changed?" — see `freshness`, which is
   * the answer and is what the UI reads. They are carried raw as well because a
   * digest is the only thing that identifies WHICH input a disagreement is
   * about when the derived verdict is disputed.
   *
   * NULL means the run recorded no hash for that input, which is not the same
   * as the input being absent.
   */
  doc_input_hash: string | null
  prompt_input_hash: string | null
  schema_input_hash: string | null
  dossier_input_hash: string | null
  /** When the row was written, as distinct from when the analysis ran. */
  created_at: string
  /** WHERE this run happened. See {@link RunOrigin}. */
  run_origin: RunOrigin
  /** For a non-local run: when it was prepared and with what. Null for local. */
  origin_note: string | null
  /**
   * Whether this run's inputs still stand. Computed in MAIN (it must rehash
   * source text, which the renderer cannot reach) against the inputs THIS RUN
   * used — never against whatever document the screen happens to display.
   */
  freshness: AnalysisFreshnessDTO
  facts: FactDTO[]
  evidence: EvidenceSpanDTO[]
}

/**
 * Per-input freshness verdict.
 * - `current` — the input reproduces exactly what the run recorded.
 * - `stale` — the input demonstrably differs from what the run recorded.
 * - `unknown` — the input's present value cannot be recomputed (source text no
 *   longer stored, prompt version retired), so NEITHER answer is assertable.
 *   Never use this to mean "probably fine".
 * - `not-applicable` — the input never applied to this run (a project dossier
 *   for a global run). A statement, unlike `unknown`.
 */
export type InputFreshnessVerdict = 'current' | 'stale' | 'unknown' | 'not-applicable'

export interface AnalysisInputFreshnessDTO {
  input: 'document' | 'prompt' | 'schema' | 'dossier'
  /** Human label for the input, resolved in main so the UI invents no wording. */
  label: string
  verdict: InputFreshnessVerdict
  /** Why it reached that verdict, in words a reader can act on. */
  reason: string
  /** What the run stored. */
  recorded_hash: string | null
  /** What the same input hashes to today, or null when it cannot be computed. */
  current_hash: string | null
}

export interface AnalysisFreshnessDTO {
  /**
   * `partially-stale` = at least one input changed and at least one did not (or
   * could not be checked). `unknown` = nothing changed that could be proven AND
   * something could not be checked — the run is not being called current.
   */
  verdict: 'current' | 'stale' | 'partially-stale' | 'unknown'
  summary: string
  inputs: AnalysisInputFreshnessDTO[]
}

// ----------------------------------------------------------------- documents
export interface DocumentDTO {
  id: number
  work_id: number
  version_kind: string
  title: string | null
  content_status: string
  retrieval_status: string
  is_preferred: number
  source_url: string | null
  file: FileLocationDTO | null
  /**
   * HOW the text was obtained — a SEPARATE axis from `content_status`, which
   * says how MUCH of the paper we have.
   *
   * `pdf-text-layer` is characters the publisher embedded; `ocr` is characters a
   * recogniser guessed from pixels and can be wrong in ways that read as
   * plausible (a 5 for an S, a decimal point that vanished). A user weighing a
   * number lifted out of the paper needs both answers, so this is badged for the
   * same reason `abstract-only` is: an analysis must never be presented as
   * better-founded than it is.
   *
   * `unknown` = no run has claimed the text yet, or the claim was retracted when
   * its run was superseded. It is a real state and is shown as such rather than
   * being rounded to "text layer".
   */
  text_source: 'unknown' | 'pdf-text-layer' | 'ocr'
  /**
   * Mean per-word OCR confidence on the recogniser's own 0–100 scale, or null.
   *
   * Null for every non-OCR source — a text layer has no confidence to report,
   * and inventing 100 for it would put a real measurement and an assumption in
   * the same column. NOT rescaled to [0,1]: it is the number tesseract reported,
   * and quietly transforming a measurement is how a figure stops meaning what
   * its source said.
   */
  text_confidence: number | null
}

/**
 * Mean OCR confidence below which a document's text is called poorly read.
 *
 * Lives here rather than in the stage because BOTH sides need it: the stage
 * flags the run for review, and the badge downgrades from "OCR" to "OCR, poorly
 * read". Two copies of the number would drift and the UI would then contradict
 * the queue about the same document.
 */
export const OCR_LOW_CONFIDENCE = 70

/**
 * How many papers a project's context may be built from.
 *
 * The dossier is read WHOLE by a model before it reads any one paper, so its
 * size is a budget rather than a preference: every paper added lengthens the
 * briefing every later analysis carries, and past a point the background
 * crowds out the paper being read.
 *
 * A CEILING ON ADDING, NEVER A CULL. A project that already holds more — one
 * built before this limit, or a setup that imported thirty — keeps every one of
 * them and stays buildable. Silently dropping papers a user chose would be the
 * worst reading of a limit: the number they see would not be the number the
 * model was given.
 *
 * Shared because both sides need the same one: main refuses the write, and the
 * button explains itself before the user presses it. Two copies would drift and
 * the UI would then disagree with the refusal.
 */
export const DOSSIER_PAPER_LIMIT = 20

/** What to tell a reader who has reached it. Matched by identity on both sides. */
export const DOSSIER_LIMIT_SENTENCE =
  `A project\u2019s context is built from at most ${DOSSIER_PAPER_LIMIT} papers. ` +
  'Take one out to add another.'
export interface FileLocationDTO {
  id: number
  base_dir_label: string
  base_dir_kind: string
  relative_path: string
  hash: string | null
  size_bytes: number | null
  role: string
}

// ----------------------------------------------------------- extraction schemas
// A SCHEMA is a first-class, user-editable definition of WHAT the AI extracts.
// The Extraction surface derives its columns from these field definitions, the
// LLM prompt is built from them, and exports are generated from them — no domain
// literal in code, so the app is agnostic to the field it is pointed at.
// Provenance is unaffected: analysis_run / evidence_span / fact.kind /
// fold_improvement.comparability still record HOW a value was obtained.
export type ExtractionFieldType = 'number' | 'text' | 'enum' | 'boolean'

export interface ExtractionFieldDTO {
  id: number
  schema_id: number
  key: string
  label: string
  data_type: ExtractionFieldType
  /** TARGET/display unit. Never rewrites the raw measurement.unit/value_num. */
  unit: string | null
  required: boolean
  /** Parsed from the stored JSON array; non-null exactly when data_type='enum'. */
  enum_options: string[] | null
  /** Extraction hint handed to the model. */
  description: string | null
  /**
   * Hash of this field's meaning-bearing params. Editing one field moves ONLY
   * its own hash, which is what makes schema versioning incremental: a run made
   * against the untouched fields is still provably current.
   */
  param_hash: string
  sort_order: number
}

export interface ExtractionSchemaDTO {
  id: number
  // NOTE: no `project_id`. A schema is GLOBAL — one definition, reusable by every
  // project — so ownership is not part of the API surface. (The column survives
  // in SQLite as a constant-0 vestige only because dropping it would mean
  // rebuilding a table that `extraction_field` and, transitively,
  // `measurement.field_id` reference; see migration v5.)
  /** Slug DERIVED from `name` (kebab-case). Never entered by the user. */
  key: string
  name: string
  description: string | null
  /**
   * CONTENT-DERIVED (`s-<hash>`): the hash of this schema's ordered field
   * hashes, recomputed on every write. Not user-editable and not shown in the
   * UI — it exists so a provenance row can state exactly which field set a run
   * was made against.
   */
  version: string
  is_builtin: boolean
  /**
   * The name this schema's own export format goes by, or null.
   *
   * User-set: `exportProject` resolves an unknown format string against this
   * column, so a lab with an interchange format of its own can name it without a
   * code change. Nothing is seeded here.
   */
  export_alias: string | null
  fields: ExtractionFieldDTO[]
  /**
   * GLOBAL count of measurements linked to this schema's fields, across every
   * project and every non-superseded run. Global because the schema itself is:
   * a per-project number would be meaningless on a screen that no longer has a
   * project. Per-project figures come from `getSchemaCoverage`.
   */
  measurement_count: number
  /** Number of projects that currently attach this schema in their Extraction. */
  attached_project_count: number
}

/**
 * How much of ONE project's corpus has been extracted with ONE schema.
 *
 * `works_with_values` counts works with AT LEAST ONE measurement on any of the
 * schema's fields — partial extraction counts as "has values", which is why the
 * UI says "has at least one value" and never "complete".
 */
export interface SchemaCoverageDTO {
  schema_id: number
  /** Works linked to the project (project_work rows) — the denominator. */
  works_total: number
  works_with_values: number
  works_without_values: number
  /** Measurements on this schema's fields, scoped to this project's works. */
  measurement_count: number
}

/**
 * `key` and `version` are absent BY DESIGN: the key is slugified from `name`
 * and the version is hashed from the fields, so neither is something a caller
 * can assert.
 */
export interface SchemaInput {
  name: string
  description?: string | null
}

/**
 * A schema definition detached from any database.
 *
 * ONE type serves two jobs, because they are the same job: a PRESET is a
 * definition that came from us, a SHARED schema is one that came from a
 * colleague, and neither differs in what instantiating it means. Both travel
 * the same import path, so a divergence between the built-in catalogue and the
 * paste box is not expressible.
 *
 * No `id`, no `version`, no counts: nothing here identifies a row in anyone's
 * database. That is what makes it safe to put on a clipboard — the recipient's
 * app derives its own key and its own content hash on import, so a bundle can
 * never assert an identity in a database it has never seen.
 */
export interface SchemaBundleDTO {
  /** Bumped only when a change would make an older app misread a newer bundle. */
  format: number
  name: string
  description: string | null
  fields: SchemaBundleFieldDTO[]
}

export interface SchemaBundleFieldDTO {
  key: string
  label: string
  data_type: ExtractionFieldType
  unit: string | null
  required: boolean
  enum_options: string[] | null
  description: string | null
}

/**
 * What a project archive holds, read from its manifest alone.
 *
 * Answers "what am I about to import?" BEFORE anything is written. Cheap by
 * construction: one small entry is inflated, not the several hundred megabytes
 * of PDFs behind it.
 *
 * `path` comes back so the renderer can hand the same file to the import
 * without ever holding its bytes — the archive is read in main, where the
 * memory belongs.
 */
export interface ArchiveInfoDTO {
  path: string
  project_name: string
  project_description: string | null
  created_at: string
  works: number
  analyses: number
  facts: number
  summaries: number
  citation_edges: number
  has_pdfs: boolean
  pdfs: number
  /** The embedding model the search index was built with, when one travelled. */
  embedding_model: string | null
  /** Size of the file on disk, so the wait is predictable. */
  size_bytes: number
}

/** What an import actually did, in the terms the user asked about. */
export interface ImportResultDTO {
  project_id: number
  project_name: string
  works_created: number
  /** Papers already in the library, matched by their text and reused. */
  works_reused: number
  analyses: number
  facts: number
  measurements: number
  summaries: number
  pdfs_stored: number
  chunks: number
  vectors_kept: number
  /** Anything that could not be brought across, in the user's words. */
  warnings: string[]
}

/** A premade schema, as the picker lists it before anything exists in the DB. */
export interface SchemaPresetDTO {
  id: string
  /** The discipline the shape comes from, so the picker can group by it. */
  discipline: string
  bundle: SchemaBundleDTO
}

export interface FieldInput {
  /** Slug DERIVED from `label` when omitted. */
  key?: string
  label: string
  data_type: ExtractionFieldType
  unit?: string | null
  required?: boolean
  enum_options?: string[] | null
  description?: string | null
  sort_order?: number
}

// ----------------------------------------------------------------- extraction
/**
 * The pictures of a paper's tables, as the extractor was shown them.
 *
 * `png` is base64 rather than a Buffer: it crosses the contextBridge, which
 * structured-clones, and a Buffer arrives in the renderer as a plain object
 * whose numeric keys would have to be reassembled by hand.
 */
export interface TableCropsDTO {
  images: Array<{
    png: string
    caption: string | null
    page: number
    label: string | null
    widthPx: number
    heightPx: number
    /**
     * Where the cited wording sits ON THIS IMAGE, in the image's own pixels —
     * one box per line of it. Empty when no passage was asked for, when the page
     * has no run geometry (OCR), or when the wording could not be located: an
     * approximate box drawn over a table would assert the model cited a cell it
     * did not.
     */
    marks: Array<{ x: number; y: number; w: number; h: number }>
  }>
  /** Table regions the text layer located in this paper. */
  found: number
  /** The page(s) the cited wording sits on, at most two. */
  quotePages: number[]
  /** Why located tables could not be pictured — null when that did not happen. */
  unavailable: string | null
}

export interface ExtractionRowDTO {
  /**
   * Stable identity for this row — what React keys on and what the screen
   * addresses an expanded cell by.
   *
   * NOT `measurement_id`: a text/enum field (variant, mutations, substrate,
   * buffer) is carried by the fact alone and has no measurement row at all.
   * NOT `fact_id` either: one fact may carry several measurements, which would
   * collide. The pair is unique by construction.
   */
  row_key: string
  /** Null for a record with no measurement — i.e. every text/enum field. */
  measurement_id: number | null
  /** The fact this record belongs to — the key the Review queue is addressed by. */
  fact_id: number
  work_id: number
  work_title: string
  /**
   * RAW as-reported quantity label (preserved before any normalization). For a
   * record with no measurement this is the fact's predicate.
   */
  quantity: string
  value_num: number | null
  value_text: string | null
  unit: string | null
  conditions: string | null
  /**
   * WHAT the reading is about — the variant, sample or specimen the fact names.
   *
   * Carried because it is half of a reading's identity: a paper measuring four
   * variants against three substrates has twelve readings, and only
   * (subject, conditions) tells them apart. Without it the matrix lined values
   * up by position and showed one variant with four contradictory kcat values.
   */
  subject: string | null
  fact_kind: string
  fold: FoldImprovementDTO | null
  evidence: EvidenceSpanDTO | null
  status: 'validated' | 'review' | 'conflict' | 'invalid' // derived
  /** Origin of the run that produced this value. See {@link RunOrigin}. */
  run_origin: RunOrigin
  origin_note: string | null
  // Schema linkage (null when a measurement is not yet assigned to a field).
  // Derived by joining extraction_field -> extraction_schema; the measurement
  // row itself stores ONLY field_id (schema_id would be a transitive dep).
  field_id: number | null
  field_key: string | null
  field_label: string | null
  field_unit: string | null
  field_type: ExtractionFieldType | null
  /**
   * The field's position in its schema's display order.
   *
   * Carried on the ROW so a surface that has records but not the schema DTO —
   * the paper's readings list — can still present them in the order the user
   * arranged, instead of the order the extractor happened to emit them in. Null
   * exactly when `field_id` is: a value the schema never asked for has no place
   * in its order.
   */
  field_sort_order: number | null
  schema_id: number | null
  schema_key: string | null
  schema_name: string | null
  /**
   * The schema the RUN that produced this record was aimed at — not the schema
   * the value landed in, and present even when the value landed nowhere.
   *
   * A paper extracted under two schemas produces two runs over the same text, so
   * one number can legitimately appear twice: mapped under the schema that asked
   * for it, and unassigned under the run that was looking for something else.
   * The unassigned section names this run so the repeat reads as two analyses of
   * the same paper rather than as the same reading counted twice.
   */
  run_schema_id: number | null
  run_schema_name: string | null
}

// ----------------------------------------------------------------- work summaries
/**
 * WHICH of the two summaries. They answer the same question at two scopes and
 * are deliberately never merged:
 *
 * `general` — what the paper did and found, described to any scientist. A
 * property of the WORK, stored globally (`project_id = 0`) and reused by every
 * project that holds the paper.
 *
 * `project` — what the paper means for THIS collection, read against its topic
 * dossier. An INTERPRETATION, stored against the project, never on the work.
 * Serving one project's reading to another as though it were the paper's own
 * claim is the exact failure the split prevents.
 */
export type SummaryKind = 'general' | 'project'

/**
 * A summary the app HAS, or an honest account of why it does not.
 *
 * One shape for both answers, because "not written yet", "the last attempt
 * failed" and "here it is" are three states the UI must tell apart, and a
 * nullable body alone cannot express them — an empty string would render as a
 * summary of an empty paper.
 */
export interface WorkSummaryDTO {
  kind: SummaryKind
  work_id: number
  /** 0 for `general`; the real project id for `project`. */
  project_id: number
  /**
   * The prose, as paragraphs separated by a blank line. NULL unless `state` is
   * `ready`.
   */
  body: string | null
  /**
   * `missing`   — never requested.
   * `ready`     — prose exists.
   * `failed`    — a run exists but produced no usable prose. The run is kept so
   *               the failure stays visible instead of reading as `missing`,
   *               which would invite the user to press a button that just
   *               failed.
   * `no-source` — the paper has no text beyond its title, so there is nothing
   *               to summarise. Writing one anyway would be entirely the
   *               model's prior, and it reads exactly like a summary of a paper
   *               that was actually read.
   * `no-dossier` — (project only) the project has no topic dossier, so there is
   *               nothing to read the paper AGAINST; the result would be a
   *               general summary wearing a project label.
   * `dossier-self-only` — (project only) the project HAS a dossier and every
   *               claim in it came from THIS paper, which is excluded so nothing
   *               a paper reported is fed back to it as background. A separate
   *               state because "build the dossier" is the wrong remedy — it is
   *               built, and this paper is what it is built from.
   * `text-unreadable` — this paper's extracted text is STORED and cannot be
   *               read back: the artifact will not parse, or the query over it
   *               failed. Distinct from `no-source` because the paper is not
   *               textless — the text exists and is unreachable, and the remedy
   *               is to extract it again, not to go and find a PDF the library
   *               already has. Collapsed into the others this was invisible: a
   *               summary written from the abstract badged itself honestly and
   *               never mentioned the full text it could not open.
   *
   * The last four are REFUSALS, and they are states rather than thrown errors
   * because an Error crossing IPC arrives as a bare mangled string the renderer
   * cannot branch on — and they send the user to different ends of the app
   * (ingest a PDF vs. build the dossier vs. mark another reference vs. re-run
   * text extraction).
   */
  state:
    | 'missing'
    | 'ready'
    | 'failed'
    | 'no-source'
    | 'no-dossier'
    | 'dossier-self-only'
    | 'text-unreadable'
  /**
   * What the model was actually given, verbatim from the run: `full text`,
   * `abstract only`, `supplementary material only`, `metadata only` or
   * `text of unrecorded extent`. A summary written from anything less than the
   * paper states far less than one written from the whole of it, and the prose
   * reads equally fluently either way — so the reader is told which.
   *
   * Runs written before summaries were sent whole may also hold
   * `full text (truncated)`, and that value stays readable: it is provenance
   * about what a stored summary was actually given, and rewriting it to
   * `full text` would claim those runs read a paper they only read part of. It
   * is no longer WRITTEN — nothing truncates a document now.
   */
  source_scope: string | null
  /** Provenance of the run that wrote it. Null when `state` is `missing`. */
  run: AnalysisRunDTO | null
}

// ----------------------------------------------------------------- extraction status summary
// §12 review-prioritization panel: aggregate extraction-status counts + a small
// deterministic QC sample of otherwise-validated records awaiting spot-checks.
export interface ExtractionQcSampleDTO {
  /** Same identity as {@link ExtractionRowDTO.row_key}. */
  row_key: string
  /** Null for a record with no measurement — i.e. every text/enum field. */
  measurement_id: number | null
  /** The fact this record belongs to — the id the review queue works in. */
  fact_id: number
  work_id: number
  work_title: string
  quantity: string
  value_num: number | null
  value_text: string | null
  unit: string | null
}
export interface ExtractionStatusSummaryDTO {
  /**
   * Every extracted record, which is NOT the same as every measurement: a text
   * field is a record carrying no measurement. Equals
   * `getExtractionRows().length` (the A-M4 invariant).
   */
  total_records: number
  auto_validated: number
  needs_interpretation: number // status 'review' (partial / assumed etc.)
  conflicting: number // status 'conflict'
  structurally_invalid: number // status 'invalid'
  qc_sample: ExtractionQcSampleDTO[] // random sample of auto-validated records
}

// ----------------------------------------------------------------- review queue
/**
 * A HUMAN verdict recorded against one extracted fact, for one project.
 *
 * It ANNOTATES the AI's extraction; it never rewrites it. The `fact` row and the
 * `analysis_run` that produced it are immutable provenance, so `corrected_value`
 * is the human's replacement stored ALONGSIDE the model's `value_text` — both
 * are always rendered, never one in place of the other.
 *
 * Verdicts are append-only. `unresolved` is how a reviewer RETRACTS an earlier
 * verdict: the retraction is itself a new row, so history is never rewritten and
 * the item simply returns to the queue.
 */
export type FactVerdictKind = 'accepted' | 'corrected' | 'rejected' | 'unresolved'
export interface FactVerdictDTO {
  id: number
  fact_id: number
  project_id: number
  verdict: FactVerdictKind
  corrected_value: string | null
  note: string | null
  reviewer: string
  created_at: string
  /**
   * True when this verdict was recorded against a DIFFERENT (now superseded)
   * fact row for the same claim — matched by fingerprint after a re-run. A stale
   * verdict does NOT resolve the item: the reviewer is told the claim was judged
   * on an earlier run and asked to confirm against the fresh extraction.
   */
  stale: boolean
  /** The analysis_run the reviewer actually judged (lets the UI name the run). */
  analysis_run_id: number
}

export interface ReviewItemDTO {
  fact_id: number
  work_id: number
  work_title: string
  kind: string // uncertain-conflicting etc.
  predicate: string
  value_text: string | null
  /**
   * OUTPUT/SCHEMA VALIDATION of the model's response for the run that produced
   * this fact — 'partial' means facts had to be salvaged from a malformed
   * response. It says nothing about whether the CLAIM is right.
   */
  verifier_result: string | null
  /**
   * Verdicts that CONTRADICTED this fact (or the run it belongs to), so the
   * queue can say what a reader found rather than showing an opaque flag.
   */
  failed_checks: AnalysisCheckDTO[]
  reason: string // why it needs review
  /** Current verdict for THIS project, or null when nobody has judged it yet. */
  verdict: FactVerdictDTO | null
  /** Every verdict for this fact+project, oldest first — the audit trail. */
  verdict_history: FactVerdictDTO[]
}

// ----------------------------------------------------------------- queue
/**
 * A stage exactly as the main-process registry declares it, in the registry's
 * OWN resolved execution order.
 *
 * The Queue draws a paper's pipeline from this list, never from the jobs that
 * happen to exist for that paper: a registered stage that has not run yet is a
 * real, pending part of the pipeline, and a queue drawn only from
 * `processing_job` would show a pipeline that grows as the paper progresses —
 * so the user could never see what is still to come. Drawing from the registry
 * also means registering a stage in main makes it appear in the Queue with NO
 * renderer change, which is the point of having a registry at all.
 *
 * `index` is the registry's topological position, carried explicitly so the
 * renderer never re-derives an order from ids, labels or timestamps. Ordering
 * is a property of the capability graph and only main can compute it.
 */
export interface StageDefDTO {
  id: string
  /** The label the stage declares for itself. */
  label: string
  /** Stage code version; a bump supersedes this stage and everything downstream. */
  version: string
  index: number
  scope: 'document' | 'project' | 'corpus'
  /**
   * Execution is serialized behind the global LLM gate, so this stage can sit
   * queued for a long time without anything being wrong. Shown, so a user does
   * not read "waiting" as "stuck".
   */
  uses_llm: boolean
}

/**
 * One paper whose stored results were produced under inputs that have since
 * changed — an edited extraction schema, a newly attached one, a different
 * model, a reference paper added to the project dossier.
 *
 * `stages` carries LABELS, not stage ids: this is read aloud to a scientist,
 * and `schema-extract` is not a name anything outside the registry uses.
 */
export interface StaleWorkDTO {
  work_id: number
  /** Labels of the stages that would re-run, in pipeline order. Never empty. */
  stages: string[]
  /**
   * The SAME stages as ids, so the refresh re-runs exactly what it named.
   *
   * Both halves come from one pass over the pipeline, which is what stops the
   * button acting on a different set from the one the user was shown.
   */
  stage_ids: string[]
}

/**
 * How much work the queue does at once.
 *
 * BOTH LIMITS ARE ABSOLUTE, across the whole app — not per project and not per
 * paper. Two projects being processed at once share them.
 *
 * Two numbers rather than one, because the two kinds of work are limited by
 * different things: an AI step waits on a remote model and uses almost no CPU,
 * while reading a PDF or running OCR is pure local computation. A single
 * allowance could only ever suit one of them — and counting a call that is
 * merely waiting on the gateway against it left the machine idle while the
 * queue looked full.
 */
export interface QueueSettingsDTO {
  /** Max AI steps in flight at once. Ships at 1. */
  llm: number
  /** Max local (non-AI) steps in flight at once. Ships at 2. */
  local: number
  /** False once the user has changed either, so the UI can offer a reset. */
  is_default: boolean
}

/**
 * Which model each kind of work uses, and how much room it is given.
 *
 * TWO ROLES, deliberately separate. The extraction reads every paper and is the
 * volume cost; the review reads a table a second time to disagree with the
 * first reading, and its whole value is that it FAILS DIFFERENTLY — a reviewer
 * on the extractor's own model shares its blind spots and confirms rather than
 * checks.
 *
 * `extractionModel` empty means "whatever the gateway offers", which is what
 * this app has always done: it has never had a model selector, and the gateway
 * picks the cheapest model it serves.
 *
 * The context window is REPORTED, not enforced. A paper is never trimmed to fit
 * one — this app splits a document across messages rather than truncating it —
 * so the number is here to say what the model can hold, not to cut anything.
 */
export interface ModelSettingsDTO {
  extractionModel: string
  extractionMaxOutput: number
  extractionContext: number
  reviewModel: string
  reviewMaxOutput: number
  reviewContext: number
  /** False once the user has changed anything, so the UI can offer a reset. */
  is_default: boolean
}

export interface JobDTO {
  id: number
  job_type: string
  /**
   * The registry stage this job executes, or null for a row planned before the
   * stage system existed. Null is NOT "unknown": it is a legacy job, and the
   * Queue says so rather than dropping it or mapping it onto a stage it never
   * ran.
   */
  stage: string | null
  /**
   * Which key of a fanned-out stage this job is (one per extraction schema, per
   * file, …). `''` when the stage does not fan out.
   */
  fanout_key: string
  status: string
  /**
   * HOW a terminal job ended, which `status` alone cannot say: `done` covers
   * both a stage that produced output (`succeeded`) and one whose precondition
   * was absent (`skipped`), and those must not read alike. Null until terminal.
   */
  outcome: string | null
  /**
   * The stage's own explanation of a non-`succeeded` outcome. The scheduler
   * REQUIRES one for `empty`, because an unexplained empty result is
   * indistinguishable from a swallowed bug.
   */
  outcome_note: string | null
  /**
   * Why the job failed, in the scheduler's own terms. `upstream` and
   * `needs-user-action` are not the same failure as a crash and must not offer
   * the same remedy. Null when the job has not failed.
   */
  error_kind: string | null
  /**
   * The stages this job is WAITING ON — the unsatisfied half of its
   * `job_dependency` edges, by stage id. Empty when nothing blocks it.
   *
   * Carried rather than inferred, because "blocked" without naming the blocker
   * is indistinguishable from "stuck" to the person looking at it.
   */
  blocked_by: string[]
  /**
   * Upstream stages this job depends on that have FAILED or been cancelled —
   * dependencies that will never be satisfied.
   *
   * Separate from `blocked_by` because it is a different fact with a different
   * remedy: one is a wait that ends on its own, the other is a wait that never
   * does, and folding them together would tell a user to be patient about a
   * pipeline that has already stopped.
   */
  dead_blockers: string[]
  /** Live progress the running stage reported, 0-100. Null when it reported none. */
  progress_pct: number | null
  progress_note: string | null
  /**
   * The CURRENT `stage_run` for this job's key: how long the stage body
   * actually took, and whether a later run has since SUPERSEDED it.
   *
   * `stage_run_superseded` is why this is here at all: a job row can read `done`
   * forever while the output it produced has been invalidated by an upstream
   * re-run, and presenting that as current output would be a lie the user acts
   * on. Both are null when no current run exists for the key.
   */
  stage_run_duration_ms: number | null
  stage_run_superseded: boolean | null
  /**
   * The `stage_run` row this job executed. Null when it never claimed one.
   *
   * IDENTIFYING, not actionable: it names which execution produced this job's
   * output, so a reader can line the job up against the run history. It is NOT a
   * handle for re-running anything. A stage re-run resolves its own ids
   * server-side inside one call, because a run superseded since this id was read
   * no longer means what the reader thinks it means — and the scheduler's
   * re-resolution by key would then retire whatever holds that key instead.
   */
  stage_run_id: number | null
  work_id: number | null
  work_title: string | null
  /**
   * The work's DOI, so the queue can be searched by the identifier the user
   * pasted rather than only by a title they may never have seen. Null when the
   * job has not resolved to a work, or that work has no DOI — a DOI is NOT
   * mandatory in this ontology, so absence is normal and not an error.
   *
   * Stored bare (`10.xxxx/…`), the form the `identifier` table holds.
   */
  work_doi: string | null
  error: string | null
  attempts: number
  /**
   * The failure has been acknowledged and no longer counts as outstanding.
   * Persisted on the row so every failed-count in the app agrees.
   */
  dismissed: boolean
  updated_at: string
  /** When the job was ENQUEUED — the basis for "added N ago". */
  created_at: string
  /**
   * When the scheduler claimed the job, and when it reached a terminal status.
   *
   * Both are null for rows written before these stamps existed, and
   * `finished_at` is null while a job is still queued or running. A null means
   * "no duration recorded" — it is never reported as zero, and never derived
   * from `updated_at`, which moves on every write and would overstate the work.
   */
  started_at: string | null
  finished_at: string | null
  /**
   * Preferred document of the job's work, for a page-1 thumbnail. Null when the
   * job has not resolved to a work, or that work has no stored PDF.
   */
  document_id: number | null
  /**
   * How that document's text was obtained, and how well.
   *
   * On the JOB row because the Queue is where a user watches a paper being
   * read, and "this one arrived as a scan and was recognised at 88 %" is a fact
   * about the result they are watching arrive — not something to discover much
   * later on the Paper screen. Null when the job resolved to no document.
   */
  text_source: 'unknown' | 'pdf-text-layer' | 'ocr' | null
  /** Mean OCR confidence on the recogniser's 0–100 scale. Null for any non-OCR source. */
  text_confidence: number | null
}

// ----------------------------------------------------------------- dossier
export interface DossierEntryDTO {
  id: number
  work_id: number
  // Identity of the source paper, carried on the entry itself so the dossier is
  // self-sufficient (no second query just to resolve work_id -> title/year).
  work_title: string
  work_year: number | null
  predicate: string
  // WHAT the claim is about. A fact is a triple, and a value with no subject is
  // unattributed: "76" under `apparent melting temperature` is a property of
  // some named thing, not of the collection.
  subject: string | null
  value_text: string | null
  kind: string
  // True for contrary/uncertain material (uncertain-conflicting / inferred) so
  // the UI can label disagreements — the §8 anti-anchoring requirement.
  is_contrary: boolean
  // True when this fact comes from a work the user marked as a reference paper
  // (is_reference=1); false when it's a top-relevance fallback fact.
  from_reference: boolean
  // The anchored passage backing this fact, from the fact's evidence_span (a
  // fact may legitimately have none — then `quote` is null and the UI must say
  // so rather than imply a quote exists). Location fields are independently
  // nullable: a span can exist without a recorded page or section.
  quote: string | null
  // Whether `quote` was found VERBATIM in the source document. The pipeline
  // stores the model's quote even when it cannot locate that text, so false
  // means "the model asserted this wording" — it must be labelled as such and
  // never rendered as a passage the paper contains.
  evidence_verbatim: boolean
  evidence_page: number | null
  evidence_section: string | null
  // Which DOCUMENT (version) the page number refers to. A page is only
  // meaningful against a concrete version — a work can have a preprint and a
  // published version paginated differently — so a bare "p. 4" is never
  // presented as a property of the abstract work when the version is known.
  evidence_version: string | null
  /**
   * Which analysis produced this claim. `dossier` means it came from a dossier
   * BUILD (a synthesis pass over the reference papers); anything else means it
   * is a by-product of extracting that one paper. The UI must not present the
   * two as the same kind of statement.
   */
  analysis_type: string
  /**
   * Origin of the run behind this claim. See {@link RunOrigin}.
   *
   * A dossier reads as the app's own synthesis of the corpus, which makes it
   * the surface where "this arrived in the download rather than being computed
   * here" is easiest to miss and most misleading.
   */
  run_origin: RunOrigin
  origin_note: string | null
}

/**
 * The dossier slice relevant to ONE paper, as an AI READER is given it.
 *
 * Not a view of the dossier — `DossierEntryDTO[]` is that, with provenance and
 * quotes. This is the compact background the model actually receives: ranked by
 * relevance to the target paper, with the target's own claims removed so nothing
 * it reports is fed back to it as context, and capped.
 */
export interface DossierContextDTO {
  /** `'ready'` when there is background; `'none'` when the project has none to give. */
  state: 'ready' | 'none'
  /**
   * Identity of this exact payload. An agent is told this hash when the material
   * was sent earlier in its session, so it can tell "I have it" from "I was told
   * I have it and cannot find it" — the second case must re-ask rather than
   * answer.
   */
  dossier_hash: string | null
  note: string | null
  /**
   * Every entry carries a value: a claim whose value is null states nothing to
   * read a paper against, and is excluded rather than sent as though the
   * collection held it.
   */
  entries: Array<{
    /** What the claim is about; null when the extraction recorded none. */
    subject: string | null
    predicate: string
    value: string | null
    kind: string
    /** Material that DISAGREES with the rest; present to stop a reader anchoring. */
    contrary: boolean
    work_id: number
  }>
}

/** One paper feeding (or eligible to feed) the dossier. */
export interface DossierSourceDTO {
  work_id: number
  title: string
  year: number | null
  /** Claims this paper currently contributes to the dossier. */
  claim_count: number
  /** When this paper was last run through a dossier build; null = never. */
  built_at: string | null
}

/**
 * One work whose CURRENT analysis was produced against a different project
 * dossier than the one it would be given today (§21 stale detection). Nothing is
 * reprocessed automatically — this only reports the discrepancy.
 */
export interface DossierStaleWorkDTO {
  work_id: number
  title: string
  analysis_type: string
  run_timestamp: string
  /**
   * The dossier-context hash the run was made against. NULL means the run was
   * made with NO dossier context at all — a different statement from "the
   * dossier changed", and the UI says which.
   */
  built_against: string | null
  /** The dossier-context hash this work would be given now. */
  current: string | null
}

/** Authoring/provenance state of a project's topic dossier. */
export interface DossierStatusDTO {
  /** Papers the user marked as references. */
  references: DossierSourceDTO[]
  /**
   * ALWAYS FALSE. There is no fallback any more.
   *
   * The dossier used to substitute the top 8 works by relevance when nothing was
   * marked, and this flag said so. That fed a model background the user never
   * chose, so it was removed: with no reference paper marked the dossier is
   * simply empty. The field stays because it is part of the frozen contract and
   * a consumer may still read it; it can go at the next contract break.
   *
   * @deprecated Always false. Read `sources` — it is now exactly `references`.
   */
  fallback: boolean
  /** The papers feeding the dossier right now. Identical to `references`. */
  sources: DossierSourceDTO[]
  /** Most recent dossier BUILD over this project; null when never built. */
  built_at: string | null
  built_model: string | null
  built_prompt_version: string | null
  /** The papers the most recent build covered. */
  built_work_ids: number[]
  /** Works analysed against a dossier that has since changed. Never auto-fixed. */
  stale: DossierStaleWorkDTO[]
  /**
   * Whether a rebuild right now would read exactly what the stored build read.
   *
   * Computed from what `buildDossier` ACTUALLY CONSUMES: which papers are marked
   * as references, the text each of them still holds, the dossier prompt version
   * and the model. Nothing else may enter it — in particular NOT the project
   * description, which the build never reads and which drives the reranker
   * instead. Greying the button on a description edit would be a claim about a
   * dependency that does not exist.
   *
   * Deliberately NOT a permission. A build the app believes is redundant is
   * still offered, because "the inputs match" is an argument about inputs and
   * the user may be rebuilding for a reason the app cannot see.
   */
  current: boolean
}

/**
 * One paper as the dossier rail lists it.
 *
 * `paragraphs` is what distinguishes this from a `RankingRowDTO`, and it is the
 * number this screen is actually about: a dossier BUILD reads its chosen papers
 * in full, so how much text a paper HAS is both the cost of choosing it and —
 * when it is zero — the reason choosing it achieves nothing. Zero is a real
 * answer (a metadata-only import, a failed fetch), never "not counted yet".
 */
export interface DossierPaperDTO {
  work_id: number
  title: string
  year: number | null
  /** In the dossier: this paper is read by a build. */
  is_reference: boolean
  relevance: number | null
  /** Order, not distance — see `GraphNodeDTO.relevance_rank`. For display only. */
  relevance_rank: number | null
  /** Paragraphs stored for its preferred document. 0 = no text to read. */
  paragraphs: number
  /** Characters of that text, so a build can be priced without a second call. */
  chars: number
}

/** One term the project has defined, as the briefing states it. */
export interface DossierTermDTO {
  label: string
  unit: string | null
  data_type: string
  description: string | null
}

/** The terms of one attached schema. */
export interface DossierTermGroupDTO {
  schema_id: number
  name: string
  description: string | null
  terms: DossierTermDTO[]
}

/**
 * What one paper contributes, in prose — the FIRST PARAGRAPH of its
 * project-scoped summary.
 *
 * The first paragraph rather than the whole body: a project summary runs to
 * several hundred words and a briefing is a budget. `source_scope` rides along
 * because a summary written from an abstract is not the same claim as one
 * written from the full text, and only the DTO can tell them apart.
 */
export interface DossierContributionDTO {
  work_id: number
  title: string
  /** The opening paragraph, already sliced. Never the whole body. */
  opening: string
  /** 'full text', 'abstract only', … — badged only when it is NOT full text. */
  source_scope: string | null
}

/**
 * THE BRIEFING — what an AI is told about this project before it reads a single
 * paper, and what each part of that costs.
 *
 * Deliberately NOT a view of `fact` rows. Extracted measurements are what the
 * corpus KNOWS; a briefing is what a reader needs in order to understand what
 * the corpus is talking about — the project's own statement, the terms it has
 * defined, which papers matter and why, and what each one adds. A measurement
 * reaches a model when it reads the paper that reported it, not as background.
 *
 * Sizes are CHARACTERS, counted in main over exactly the strings carried here.
 * The renderer converts to a word estimate for display and must never re-derive
 * the count from what it happens to be rendering: a section the screen
 * collapses or truncates costs the model the same either way, and a size that
 * shrank when a disclosure closed would be measuring the UI, not the payload.
 */
export interface DossierBriefingDTO {
  /** The project's own statement of what it is for. Null when unwritten. */
  about: string | null
  /** Terms the project has defined, grouped by the schema that owns them. */
  terms: DossierTermGroupDTO[]
  /** Every paper in the project — the rail, and the briefing's index. */
  papers: DossierPaperDTO[]
  /** Per-paper prose, for the papers that have a project summary. */
  contributions: DossierContributionDTO[]
  /**
   * Characters per section, keyed as the screen renders them in order.
   * `compiled` is what a dossier BUILD has produced, and is 0 until one runs.
   */
  sizes: {
    about: number
    terms: number
    papers: number
    contributions: number
    compiled: number
  }
}

// ----------------------------------------------------------------- search
export interface SearchResultDTO {
  work_id: number
  title: string
  year: number | null
  venue: string | null
  work_type: string
  snippet: string | null
  /** How many works IN THE CORPUS cite this one — sortable, and shown on the row. */
  citation_count: number
  /** Author names in position order, for display and the author filter. */
  authors: string[]
}
/**
 * One hit from the external literature search. These papers are NOT
 * in the corpus — they are what the academic indexes hand back BEFORE anything is
 * imported, so they carry no work_id. `external_id` is the stable row key (the
 * DOI where there is one) used by the renderer to track an in-flight import.
 */
export interface WebSearchResultDTO {
  external_id: string
  title: string
  abstract: string
  authors: string[]
  year: number | null
  venue: string | null
  doi: string | null
  citation_count: number
  /**
   * Every index that returned this paper — "arxiv", "pubmed", "crossref".
   *
   * A list because the same paper routinely comes back from several indexes at once, and
   * that overlap is USEFUL: it says where the paper can be obtained, and a preprint server
   * among them means a copy that is not behind a paywall. Never empty.
   */
  sources: string[]
  /**
   * What KIND of document the index called it — "preprint", "review", "working-paper".
   *
   * Null when no index stated one, and never inferred by us. The UI shows this only when
   * it is NOT an ordinary journal article, so a plain article and an unstated type read
   * the same way: silence.
   */
  type: string | null
  /**
   * The paper in THIS PROJECT that this hit already is, or null.
   *
   * Answered in MAIN, which owns the corpus, and by the same DOI-then-title
   * rule the import itself dedups on — so "already added" here and "this is the
   * same paper" at import time can never disagree. Answered per SEARCH, not
   * cached: the project gains papers while its results are still on screen.
   *
   * The row is kept and MARKED rather than dropped. A hit that vanished would
   * read as the index having lost it, and the user would search again for a
   * paper they already have; the mark is also the fastest way to see that the
   * search found the right thing.
   *
   * NULL means "not in this project", never "we did not look" — an unreadable
   * corpus is a failed search, not a silently unmarked one.
   */
  in_project_work_id: number | null
}

// ------------------------------------------------------- semantic search
/**
 * One PASSAGE that matched a semantic query, with the paper it came from.
 *
 * The passage is the unit, not the paper: a cosine is a statement about a chunk
 * of text, and showing only a title would ask the user to take on trust that
 * something in there matched. The quote IS the reason.
 */
export interface SemanticHitDTO {
  chunk_id: number
  work_id: number
  document_id: number
  title: string
  year: number | null
  venue: string | null
  authors: string[]
  /** 1-based PDF page, or null when the chunker could not attribute one. */
  page: number | null
  section: string
  /** The matching passage verbatim. Never summarised — a summary is not evidence. */
  text: string
  /**
   * Cosine similarity in [-1, 1]. NOT a probability and NOT a percentage of
   * confidence: 0.81 does not mean "81% sure". The UI shows the raw number to
   * two decimals plus a coarse band, and must never render it as `%`.
   */
  score: number
  /** The chunk was very short or was truncated, so its vector represents less than it appears to. */
  low_confidence: boolean
  /** How the paper's text was obtained — an OCR'd passage may be misquoted. */
  text_source: 'unknown' | 'pdf-text-layer' | 'ocr'
  /**
   * Mean OCR confidence, 0–100, or null for a non-OCR source.
   *
   * Carried on the HIT and not only on the document because a passage OCR'd at
   * 41 % and one at 95 % are different evidence, and a badge that could not tell
   * them apart rendered them identically.
   */
  text_confidence: number | null
  /**
   * The chunk's vector was written under a config that is no longer the active
   * space's, so this hit answers from an OLDER reading of the paper.
   *
   * Flagged per hit rather than only in the coverage summary: the k-NN does not
   * filter on `config_hash`, so a stale chunk sits in the ranked list looking
   * exactly like a current one, and a total elsewhere on screen does not tell
   * the user WHICH result it applies to.
   */
  stale_vector: boolean
}

/**
 * How much of the corpus the active embedding space actually covers.
 *
 * Every field here exists so a short result list can be told apart from a small
 * corpus. A search over 3 of 20 papers returns a plausible ranked list and no
 * error at all, which is the single most misleading thing this feature can do.
 */
export interface SemanticCoverageDTO {
  /** Null when no model is packaged or nothing has ever been embedded. */
  space: {
    id: number
    model_id: string
    dims: number
    /** 'active' answers searches; 'retired'/'comparison' do not. */
    status: string
    created_at: string
  } | null
  works_embedded: number
  /** Works that HAVE extracted text and could therefore be embedded. */
  works_with_text: number
  /**
   * Every paper in scope, extracted or not.
   *
   * The third number is what stops "all papers with text are searchable" from
   * being a comfortable lie: on a library of 20 papers where 3 have been read,
   * that sentence is TRUE and deeply misleading. Both denominators have to be
   * on screen, because a user asking "did the search see everything" means the
   * papers they added, not the ones a stage happened to finish.
   */
  works_total: number
  chunks: number
  /**
   * Chunks written under a config that is no longer this space's.
   *
   * They ARE still returned by a query — the k-NN does not filter on
   * `config_hash` — so this is not a count of rows being ignored. It is a count
   * of answers built from an older reading of the corpus, which is why it has
   * to be said out loud rather than left in the database.
   */
  stale_chunks: number
  /**
   * Works whose ONLY vectors are stale ones.
   *
   * Separated from `works_embedded` because "embedded" and "embedded under the
   * settings currently in force" are different claims, and reporting the first
   * as the second lets a project whose vectors are entirely out of date read as
   * fully covered.
   */
  works_stale_only: number
  /**
   * Whether this space has its vector index.
   *
   * False is an ERROR STATE, not a slower mode: sqlite-vec is required, so the
   * only way here is a space embedded without its `vec0` table. The remedy is
   * to re-run the embed stage.
   */
  indexed: boolean
  /**
   * Every paper with no vector in the active space. None of them can appear in
   * a result list, whatever the query.
   *
   * NAMED, not counted, and with the REASON: "5 papers are not searchable yet"
   * is something a user can only worry about, whereas a title plus "no text has
   * been extracted from it yet" is something they can act on. Silently omitting
   * these — which is what happens without this list — makes the library look
   * smaller than it is.
   *
   * `reason` is `no-text` when nothing has extracted the document's text (so
   * embedding was never possible) and `not-embedded` when it has text but the
   * embed stage has not run or was superseded. Different waits, different
   * remedies.
   */
  unembedded: { work_id: number; title: string; reason: 'no-text' | 'not-embedded' }[]
  /**
   * How many papers are unsearchable IN TOTAL, which may exceed `unembedded.length`.
   *
   * The list is capped so a 3000-work library does not travel through a
   * structured clone on every screen mount; the COUNT is not, because the number
   * is the part the user must not be given a rounded-down version of.
   */
  unembedded_total: number
}

/**
 * The answer to one semantic query, including the honest caveats.
 *
 * `error` is populated instead of throwing for the states that are the user's
 * business rather than a bug: no model packaged, no active space, a
 * dimensionality mismatch after a model swap. Each needs a sentence on screen,
 * not a red toast.
 */
export interface SemanticSearchResultDTO {
  hits: SemanticHitDTO[]
  /** Which space answered. Null when none could. */
  space_id: number | null
  /**
   * How this answer was ranked.
   *
   * `index` — the space's vector index. `exhaustive` — every passage in a
   * narrow scope was compared, which is the MORE accurate of the two and is
   * chosen deliberately for a single paper; it is not a shortfall and must not
   * be presented as one.
   *
   * Null when no query reached the index at all — an empty query string, no
   * embedded passages, or an error. There is no ranking to describe, and
   * naming one of the two would be an invented fact about work never done.
   */
  strategy: 'index' | 'exhaustive' | null
  /** Coverage AT THE TIME OF THE QUERY, so the caveat matches the results shown. */
  coverage: SemanticCoverageDTO
  /** Milliseconds spent in the worker. Shown because the two paths differ in cost. */
  took_ms: number
  /**
   * How many passages were ASKED FOR — a reading budget, not a claim about how
   * many matched.
   *
   * Surfaced so the UI can say "the closest 30" when the list is full. Without
   * it a count of what arrived reads as a count of what exists, and a truncated
   * list looks like the whole answer.
   */
  requested_k: number
  error: string | null
}

/**
 * How the web search is ordered. `relevance` is the query-match score.
 *
 * `year` is newest-first and `year-asc` oldest-first: finding the foundational
 * work in a field is a different question from finding the latest, and only one
 * of them can be the default.
 */
export type WebSearchSort = 'relevance' | 'year' | 'year-asc' | 'citations'

/**
 * Narrowing applied to a web search. Filters run BEFORE the result cap, so the
 * user gets the best N of what they asked for rather than the best N overall
 * reduced to whatever survived.
 */
export interface WebSearchFilters {
  yearFrom?: number
  yearTo?: number
  minCitations?: number
  /** Case-insensitive substring match against any author name. */
  author?: string
  /**
   * Keep only papers at least ONE of these indexes returned. Empty/absent = all.
   *
   * ANY, not every. A hit several indexes agree on is the best-attested one
   * there is, and an "all of" rule would be likeliest to drop exactly those —
   * so overlap is what is tested, which is also what the Ingest screen does.
   *
   * These are the ids that appear in a result's `sources` — the individual
   * indexes (`arxiv`, `pubmed`) — NOT the registry's own source ids. One
   * registry source, the extension, fans out to all of them, so this cannot be
   * answered by choosing which source to ASK; it narrows what came back. An id
   * nothing returned narrows to nothing rather than erroring: that is a
   * statement about this query's results, not a misuse of the API.
   */
  sources?: string[]
  sort?: WebSearchSort
  /** How many results to return. */
  limit?: number
  /**
   * Which page of results to fetch, 1-based.
   *
   * Paging happens UPSTREAM, at each index, rather than by slicing a bigger
   * local result set — the indexes hold far more than we could reasonably pull
   * in one request, so a later page must actually ask them for more.
   */
  page?: number
  /**
   * Mark hits this PROJECT already holds, by filling `in_project_work_id`.
   *
   * Not a filter — it narrows nothing and every index is asked the same
   * question either way. Omitted, every result comes back with a null there,
   * which is the honest answer to "we were not asked".
   *
   * Answered in main because the corpus lives there, and by the same
   * DOI-then-normalised-title rule the import dedups on: any looser test would
   * mark a paper as present that importing would then add anyway, and any
   * stricter one would offer a second copy of a paper already held.
   */
  projectId?: number
}
export interface FacetBucketDTO {
  value: string
  count: number
}
/**
 * Multi-select corpus filters. Values within a facet are OR-ed; facets are
 * AND-ed with each other and with the free-text query. An absent or empty array
 * means "this facet is not filtering".
 *
 * `year` accepts an exact year ("1998") or a decade label as produced by
 * `decadeLabel()` below; both compile to numeric SQL in the repository.
 *
 * This is also what `saved_search.filters` stores (as JSON), so saving and
 * restoring a search round-trips the query AND its filters.
 */
export interface SearchFilters {
  work_type?: string[]
  venue?: string[]
  year?: string[]
  inclusion_status?: string[]
  content_status?: string[]
  // ---- range / text narrowing, orthogonal to the facet chips above ----
  // A chip picks exact values; these express a bound. Both apply together.
  yearFrom?: number
  yearTo?: number
  minCitations?: number
  /** Case-insensitive substring match against any author name. */
  author?: string
  sort?: SearchSort
}

/**
 * Result order for the corpus search.
 *
 * `relevance` is the project's stored ranking, so it is only meaningful inside a
 * project; an unscoped search falls back to title order, which is what it
 * already did.
 */
export type SearchSort = 'relevance' | 'year' | 'citations' | 'title'
/**
 * The label for a decade bucket, e.g. `decadeLabel(1990) === '1990–1999'`.
 *
 * This is the ONE definition of that string. The renderer builds year buckets
 * with it and the repository parses them back into a numeric range, so the two
 * sides cannot drift — the separator is an EN DASH and is load-bearing.
 */
export function decadeLabel(startYear: number): string {
  return `${startYear}–${startYear + 9}`
}
export interface FacetsDTO {
  work_type: FacetBucketDTO[]
  venue: FacetBucketDTO[]
  year: FacetBucketDTO[]
  inclusion_status: FacetBucketDTO[]
  content_status: FacetBucketDTO[]
}
export interface SavedSearchDTO {
  id: number
  project_id: number | null
  name: string
  query: string
  filters: string | null
}
export interface SavedFrontierDTO {
  id: number
  project_id: number | null
  name: string
  graph_state: string
}

// ----------------------------------------------------------------- ocr geometry
/**
 * One recognised word: where it sits on the OCR raster, and what it reads as.
 *
 * The box is in RASTER pixels with y measured downwards — the space tesseract
 * reports in — and is converted to page coordinates by the viewer through the
 * page's `placement`. It is not pre-converted, because the conversion depends on
 * the render scale the reader has chosen, which the pipeline cannot know.
 */
export interface OcrWordDTO {
  /** Span in the canonical document text, the same offsets every anchor uses. */
  charStart: number
  charEnd: number
  /** The characters this box covers, so the geometry is self-contained. */
  text: string
  /**
   * The characters separating this word from the next, taken from the canonical
   * text. Absolutely positioned spans put nothing between themselves, so
   * without it a copied selection loses every space and line break.
   */
  gap: string
  x0: number
  y0: number
  x1: number
  y1: number
  /** Tesseract's per-word confidence, 0–100. */
  confidence: number
}

export interface OcrPageGeometryDTO {
  page: number
  rasterWidth: number
  rasterHeight: number
  /**
   * The PDF matrix mapping the raster's unit square onto page user space.
   *
   * Carried per page because a scan is not necessarily flush with its page box,
   * and assuming that it is puts every word off its glyphs by several points —
   * a text layer that selects the wrong letters looks correct and is worse than
   * none at all.
   */
  placement: [number, number, number, number, number, number]
  words: OcrWordDTO[]
}

export interface OcrWordBoxesDTO {
  documentId: number
  /** Mean character confidence of the recognition, 0–100. */
  meanConfidence: number
  pages: OcrPageGeometryDTO[]
}

// ----------------------------------------------------------------- pdf bytes
/**
 * WHY the viewer has no bytes, when it has none.
 *
 * Every member is a state the user can act on differently, and the whole point
 * of the enum is that they were once one answer. `null` meant all of them at
 * once, and the viewer read that single answer as a fact about the PAPER —
 * "PDF not available (metadata / abstract only)" — so a paper sitting on an
 * unmounted network drive was reported as one that has no full text. That is a
 * content-status claim, and it was false.
 *
 * - `none` — no file is recorded for this document at all. The genuine
 *   metadata-only case, and the only one that is a fact about the paper.
 * - `missing` — a file IS recorded and is not at its path. Deleted, moved, or a
 *   drive that is not mounted; the corpus still knows the paper has a document.
 * - `unreadable` — the file is there and this process cannot read it:
 *   permissions, an I/O error, a half-written download.
 * - `rejected` — the recorded path resolves outside its base directory. A
 *   corrupt row or a tampered library, never an ordinary state.
 */
export type PdfUnavailableReason = 'none' | 'missing' | 'unreadable' | 'rejected'

/**
 * The result of asking for a document's bytes.
 *
 * Discriminated on `ok` so a caller cannot read the failure branch as absence
 * by forgetting a check. `sentence` is a MAPPED display string chosen in main
 * from the reason alone — it never carries an errno message, a URL, or the
 * path, which contains the OS username.
 */
export type PdfReadResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: PdfUnavailableReason; sentence: string }

// ----------------------------------------------------------------- unresolved refs
export interface UnresolvedReferenceDTO {
  id: number
  citing_work_id: number
  raw_bib_text: string
  guessed_doi: string | null
  guessed_title: string | null
  /**
   * As printed. Null when the citation style or the text layer gave none.
   *
   * Carried so a reference whose style prints NO title can still be named by
   * the people who wrote it rather than by a placeholder — 200 of the 206
   * title-less references in one corpus have an author list.
   */
  guessed_authors: string | null
  guessed_venue: string | null
  guessed_year: number | null
  /**
   * A title an outside INDEX supplied, for an entry whose style printed none.
   *
   * BESIDE `guessed_title`, never merged into it: "what the page says" and
   * "what an index says" are different claims. Non-null only where the printed
   * side had no usable title, so the two never contend for one row.
   */
  index_title: string | null
  /** How that title was established. Null exactly when `index_title` is. */
  index_title_from: string | null
  section: string | null
  status: string
  /**
   * Live retrieval state of the paper this entry names, so the Paper screen can
   * offer "Resolve & Import" and then say truthfully what became of it.
   */
  retrieval_status: ReferenceRetrievalStatus
  retrieval_error: string | null
  /**
   * How this entry WOULD be looked up, or null when it names nothing that could
   * be searched for. Computed in main by the same function the enqueue uses, so
   * the button the renderer offers and the work main will actually do cannot
   * disagree about what is retrievable.
   */
  retrieval_kind: ReferenceRetrievalKind | null
  /**
   * How near the paper this entry names is to the project's question, as the
   * reference-abstract sweep scored it — the same [0,1] scale the Ranking screen
   * shows for papers already in the corpus, so the two read together.
   *
   * NULL means NOBODY SCORED IT: no reranker packaged, no research question
   * written down, or an entry offering neither a fetched abstract nor a printed
   * title. Never 0 — a 0 sorts as the worst thing in the list, and being
   * unreadable is not the same as being unpromising.
   */
  relevance: number | null
  /** 'title+abstract' or 'title'. Null exactly when `relevance` is. */
  scored_on: string | null
  /**
   * Whether this entry's abstract can be read, and from whom. The TEXT is not
   * here — see `ReferenceAbstractStateDTO` for why it is fetched on demand.
   */
  abstract_state: ReferenceAbstractStateDTO
}
// Target for resolving an unresolved reference: either an existing work id, or a
// minimal new-work spec (find-or-create by DOI / normalized title per §5).
export type ResolveReferenceTarget =
  | { workId: number }
  | { newWork: { title: string; doi?: string; year?: number; venue?: string } }
/**
 * Outcome of a retrieve request. `queued` and `skipped` together account for
 * EVERY id the caller passed — nothing is dropped silently, and the two skip
 * reasons are distinct because they mean different things to the user ("this
 * one is already on its way" vs "this one names nothing I could look up").
 */
export interface RetrieveReferencesResultDTO {
  queued: Array<{ unresolved_id: number; job_id: number; work_id: number }>
  skipped: Array<{ unresolved_id: number; reason: 'not-retrievable' | 'already-retrieving' }>
}
export interface ResolveReferenceResultDTO {
  /**
   * The edge the reference resolved to, or `null` when a self-citation was
   * refused and no edge was created.
   *
   * `null` rather than a `0` sentinel: an id no row has still reads as an id,
   * and a caller that passes it on attaches this reference's evidence to
   * nothing. A nullable type makes "no edge exists" a case the caller has to
   * handle rather than one it can walk past.
   */
  edgeId: number | null
  citingWorkId: number
  citedWorkId: number
  createdWork: boolean // true when a new work was inserted
  matchedBy: 'existing-id' | 'doi' | 'normalized-title' | 'created'
  /**
   * In-text contexts carried across onto the new edge. The evidence of where
   * the reference was cited survives the resolve on the same rows, rather than
   * being cascaded away with the `unresolved_reference` row.
   */
  contextsMoved: number
  /**
   * Contexts deliberately discarded because the resolve was a self-citation,
   * which produces no edge by policy and so leaves the evidence with nothing
   * to be evidence FOR. Counted and reported rather than lost silently.
   */
  contextsDiscardedSelfCite: number
}

// ----------------------------------------------------------------- integrations
/**
 * Integration status. Every field here is either a REAL local filesystem probe
 * or an explicit "cannot be determined" — nothing is derived from the mere
 * presence of a DB row any more, and nothing touches the network.
 *
 * `zotero_installed` is deliberately narrow: it means Zotero's DATA DIRECTORY
 * (`$ZOTERO_DATA_DIR` or `~/Zotero`) contains a `zotero.sqlite`. That is not the
 * same as "the application is installed", and the UI labels it as what it is.
 *
 * `zotero_running` is `null` — UNKNOWN, not false. There is no honest offline
 * way to tell: the presence of `zotero.sqlite-wal`/`-shm` survives a crash and
 * is absent while a cleanly-idle Zotero is running, so it would be a guess.
 */
/**
 * EVERY flag here is tri-state, and `null` always means the same thing: the
 * probe did not answer (a hung mount) so the state is genuinely UNKNOWN. It is
 * never collapsed into `false` — asserting "no Zotero library" about a machine
 * we merely failed to inspect is the fabricated negative this DTO exists to
 * avoid, and the UI renders `null` as a distinct "unknown", never as "no".
 */
export interface IntegrationsStatusDTO {
  /** A zotero.sqlite exists in the conventional data directory. */
  zotero_installed: boolean | null
  /** Always null — genuinely undeterminable offline (see above). */
  zotero_running: boolean | null
  /** …and THIS process may read it (R_OK). Independent of `installed`. */
  zotero_accessible: boolean | null
  /** Where we looked, so the user can check the claim (null = no such dir). */
  zotero_data_path: string | null
  /** A local base_dir was probed REACHABLE — not merely present as a row. */
  obsidian_enabled: boolean | null
}

// ----------------------------------------------------------------- settings
// A selectable analysis (LLM) model. The list + the current selection are
// DB-backed (seed-only-DB): the renderer NEVER hardcodes a model array. Both
// the Settings surface and the read-only topbar pill read these.
export interface LlmModelDTO {
  id: string
  label: string
  sub: string | null
  provider: string | null
}
/**
 * What the `citation-contexts` stage concluded for one paper.
 *
 * The distinction this carries cannot be recovered from the rows: a run that
 * DECLINED to link callouts and a run that linked none both write one
 * bibliography row per reference and no in-text rows. Only the stage's own
 * terminal record says which happened, and the two mean opposite things to a
 * reader — "we would not guess" versus "there was nothing".
 */
export interface CitationOutcomeDTO {
  /** The stage's terminal status: `succeeded` | `empty` | `skipped` | `refused` | `failed`. */
  status: string
  /** The stage's own words for why. Null only when it recorded none. */
  note: string | null
}

/**
 * Where the app is in getting a newer version of itself.
 *
 * `idle` and `uptodate` are deliberately NOT the same phase. "We have not asked"
 * and "we asked and there is nothing" are different things to tell a user, and
 * collapsing them makes a check that never ran — because the machine was
 * offline, or no feed is configured — read as reassurance.
 *
 * `ready-manual` is the unsigned-macOS case: the installer is downloaded, but
 * the app cannot replace itself, so the honest offer is to reveal the file
 * rather than a button that would do nothing.
 */
export interface UpdateStateDTO {
  phase:
    | 'idle'
    | 'checking'
    | 'uptodate'
    | 'available'
    | 'downloading'
    | 'ready'
    | 'ready-manual'
    | 'error'
  /** The version running right now. */
  currentVersion: string
  /** The version being offered, when there is one. */
  newVersion: string | null
  releaseNotes: string | null
  /** ISO 8601, as the feed reported it. */
  releaseDate: string | null
  /** 0-100 while downloading, else null. */
  percent: number | null
  bytesPerSecond: number | null
  /** Absolute path of the downloaded installer, once there is one. */
  file: string | null
  /** Already phrased for display; never a raw stack. */
  error: string | null
  /**
   * WHICH operation failed, when one has.
   *
   * Recorded rather than inferred: a failed check leaves the version an earlier
   * check found, so "there is a version" does not mean "the download is what
   * broke" — reading it that way badged a network failure as a failed download
   * and offered to retry a download nobody had started.
   */
  failed: 'check' | 'download' | 'install' | 'load' | null
  /** False when this build has no update feed at all, so the UI can say so. */
  configured: boolean
  /** Epoch ms of the last COMPLETED check, or null if none has finished. */
  checkedAt: number | null
}
/**
 * The gateway connection, as the SETTINGS surface is allowed to see it.
 *
 * `hasKey` is a boolean and never the key. The renderer's only legitimate
 * question is whether one is configured; returning the value would put a
 * credential in an IPC payload, which `llm/gateway.ts`'s security contract
 * forbids and `verify:offline` greps for.
 */
export interface GatewayConfigDTO {
  /** The endpoint the user saved, or '' when none is set. */
  endpoint: string
  /**
   * True when NOTHING is configured, in which case `endpoint` is ''.
   *
   * There is no default to fall back on: an install that has not been told
   * where its gateway lives talks to nothing, and says so. Guessing loopback
   * meant reporting whatever happened to answer on that port as the user's
   * gateway.
   */
  endpointIsDefault: boolean
  hasKey: boolean
}

export interface DevLogStatusDTO {
  enabled: boolean
  /** Absolute path of the current session file, or null when never enabled. */
  file: string | null
  /** Bytes written so far — so the screen can say the log is actually growing. */
  bytes: number
  /** The directory holding this session and the previous ones. */
  dir: string
}

/** One day's spend, split by direction, for the analytics chart. */
export interface TokenUsageBucketDTO {
  /** `YYYY-MM-DD`. */
  day: string
  /**
   * Input the model PROCESSED — disjoint from the two cache counts, not their
   * total. The three were summed once, and a conversation re-reading one cached
   * document across twenty turns then reported that document twenty times: 40
   * tokens of real input charted as 300k. What was worked on and what was merely
   * re-read are different questions, so they are different numbers.
   */
  promptTokens: number
  /** Input written INTO the cache: the prefix, paid for once. */
  cacheWriteTokens: number
  /** Input served FROM the cache — reused, never reprocessed. */
  cacheReadTokens: number
  completionTokens: number
}

/**
 * What the Analytics chart needs to draw itself, INCLUDING why it may be empty.
 *
 * `collecting` and `totalRows` are here because the chart has three distinct
 * nothings — not collecting at all, collecting but nothing has run yet, and
 * filtered down to nothing — and a single "no data" for all three sends the
 * reader to debug the wrong one. The renderer cannot tell them apart from
 * `buckets` alone.
 */
export interface TokenUsageSeriesDTO {
  buckets: TokenUsageBucketDTO[]
  /**
   * Every model the ledger holds, for the filter — NOT just the ones surviving
   * the current filter, which would drop the option the reader has to select to
   * get back.
   */
  models: string[]
  /** Whether the developer log, and so the attribution, is on. */
  collecting: boolean
  /** Rows in the ledger regardless of the current filter. */
  totalRows: number
}

export interface TokenUsageQuery {
  /** Inclusive `YYYY-MM-DD`, or null/absent for unbounded. */
  from?: string | null
  to?: string | null
  /** null/absent = every model. */
  model?: string | null
}

export interface LlmStatusDTO {
  /** `true` when a real model answers; `false` when none can be reached. */
  live: boolean
  /**
   * The provider name stamped onto runs: `communicator` when a model answers,
   * `unavailable` when none can be reached — in which case NO run is produced
   * and the name is never stamped on anything.
   */
  provider: string
  /** The model id stamped onto runs. */
  model: string
  /**
   * Why this provider, in words naming the remedy where there is one. Safe to
   * render verbatim — it never contains a credential.
   */
  reason: string
  /** Minutes of gateway OAuth token left, when it reported any. */
  token_minutes: number | null
}
// Per-project storage roll-up for the Settings modal's "Space consumption"
// section. Sizes are REAL (SUM of file_location.size_bytes); files with an
// unknown size contribute 0. Papers are the works whose documents have files.
export interface StoragePaperDTO {
  work_id: number
  title: string
  size_bytes: number
}
export interface StorageProjectDTO {
  project_id: number
  name: string
  size_bytes: number
  papers: StoragePaperDTO[]
}

/**
 * Which of the two prose briefs is being edited.
 *
 * The same two-way split `summaryPromptName` makes from `project_id` in main.
 * Named rather than derived from a project id here so the renderer's editor
 * cannot accidentally offer the corpus-wide brief on a project screen.
 */
export type SummaryPromptScopeDTO = 'general' | 'project'

/** One writing brief, as the editor needs to show it. */
export interface SummaryPromptDTO {
  scope: SummaryPromptScopeDTO
  /**
   * The text in force — the user's if they have written one, otherwise the
   * built-in. Always the prompt that would actually be sent, so the editor never
   * shows an empty box for a prompt that is doing work.
   */
  text: string
  /** The shipped text. What "restore the default" restores, shown alongside. */
  builtin: string
  /** Whether `text` is the user's rather than the built-in. */
  custom: boolean
  /** What a summary written now would record as its `prompt_version`. */
  stamp: string
}

// One attributed third-party component on the About → Third-party licences
// screen. GENERATED, never hand-written: `scripts/gen-licences.ts` builds
// resources/licences/index.json from resources/payloads.json (the bundled
// binaries and models) plus the installed production npm closure, and
// `npm run verify:licences` fails the build when that file has gone stale.
// Apache-2.0 §4 requires attribution and this app ships five Apache-2.0
// payloads, so a list that silently rots is a compliance defect, not untidiness.
export interface LicenceEntryDTO {
  /** Stable id — `payload:<id>` or `npm:<package>`. */
  id: string
  name: string
  /** A bundled binary/model payload, or a package from the npm tree. */
  kind: 'payload' | 'npm'
  version: string
  /** SPDX expression exactly as the upstream declares it. */
  license: string
  homepage: string | null
  /** Why the component is in the app — the reader's first question. */
  purpose: string | null
}
/**
 * The full licence text of one component, read from disk in MAIN and fetched
 * only when the reader expands that entry. Texts total ~400 KB; inlining them
 * in the bundle would parse on every launch to show something almost nobody
 * opens. Nothing is ever fetched over the network (CLAUDE.md §2).
 *
 * `text` is null when upstream ships no licence FILE; `note` then says so, so
 * the pane states a fact instead of rendering blank.
 */
export interface LicenceTextDTO {
  id: string
  text: string | null
  note: string | null
}

// ----------------------------------------------------------------- the API
// This interface is implemented by preload (exposeInMainWorld('api', ...)) and
// consumed by the renderer as window.api. Keep param/return types serializable.
export interface CorpusApi {
  // projects
  listProjects(): Promise<ProjectDTO[]>
  getProject(id: number): Promise<ProjectDTO | null>
  createProject(input: {
    name: string
    description: string
    seedTitles?: string[]
    /**
     * This project's own brief for its project summaries.
     *
     * Omitted, or blank, means the built-in — which is what the wizard sends
     * unless the user opened the editor and typed something else, so a project
     * created without a thought about prompts tracks future revisions of the
     * shipped brief instead of being frozen at the wording of its creation day.
     */
    summaryPrompt?: string | null
    /**
     * Start this project in its setup questionnaire.
     *
     * The dashboard's "new project" sends `true` and nothing else but a name:
     * everything the old dialog asked for is asked on the setup page instead.
     * DEFAULTS TO FALSE so that the paths which create a project ALREADY
     * complete — importing an archive, accepting a shared project, seeding a
     * test corpus — do not strand it behind a form asking questions its
     * contents have already answered.
     */
    onboarding?: boolean
  }): Promise<ProjectDTO>
  /**
   * Write one or more of the questionnaire's answers.
   *
   * Called on every field BLUR rather than from a save button: this form stays
   * open for as long as importing and reading a few papers takes, and one that
   * has to be re-typed after a crash is not persisted at all. Every field is
   * optional so a blur sends only what changed.
   *
   * Writing `goal` or `questions` RECOMPOSES `description`, which is the string
   * the prompts read. That happens in main, not here, so the two halves and the
   * composed whole can never drift apart across an IPC round trip.
   */
  updateProjectSetup(input: {
    projectId: number
    name?: string
    goal?: string
    questions?: string[]
    schemaIds?: number[]
  }): Promise<ProjectDTO>
  /**
   * Finish setup: make the papers imported during it the project's context — up
   * to `DOSSIER_PAPER_LIMIT` of them — build that context, and mark the project
   * done. A setup that imported more keeps the rest in the library; they can be
   * swapped in by hand.
   *
   * ONE call rather than three from the renderer, because a failure between
   * them is what leaves a project marked done with no context built. The state
   * only advances when the build has actually returned.
   *
   * THROWS when the project has no papers — the button offering this is
   * disabled until it does, and a build over an empty corpus would write a
   * context that says nothing and report success.
   */
  finishProjectSetup(projectId: number): Promise<ProjectDTO>
  /**
   * Ask the user for an archive and report what it holds — without importing.
   *
   * Returns null when the picker was dismissed; THROWS with a readable sentence
   * when the chosen file is not a project archive, which is a different outcome
   * from "changed my mind" and must not look like one.
   *
   * The file is opened in main and only its manifest is parsed, so choosing a
   * 400 MB archive costs a few milliseconds and no renderer memory.
   */
  pickProjectArchive(): Promise<ArchiveInfoDTO | null>
  /**
   * Import a previously inspected archive as a NEW project.
   *
   * `path` is one `pickProjectArchive` returned; main re-reads the file rather
   * than trusting a path the renderer composed. All-or-nothing: on any failure
   * the database is left exactly as it was.
   */
  importProjectArchive(path: string): Promise<ImportResultDTO>
  listProjectWorks(projectId: number): Promise<ProjectWorkDTO[]>

  // works / paper detail
  getWork(id: number): Promise<WorkDetailDTO | null>
  getCitations(id: number): Promise<CitationEdgeDTO[]>
  getWorkDocuments(id: number): Promise<DocumentDTO[]>
  getWorkAnalyses(id: number, projectId: number): Promise<AnalysisRunDTO[]>
  getUnresolvedReferences(workId: number): Promise<UnresolvedReferenceDTO[]>
  /**
   * Every in-text context of a paper's citations, resolved AND unresolved.
   *
   * `getCitations` is keyed by edge and so returns only the resolved half.
   * Most of this corpus's references resolve to nothing, and their in-text
   * evidence is exactly as real; without this method it would be stored and
   * unreachable, which a reader cannot tell apart from discarded.
   */
  getCitationContexts(workId: number): Promise<CitationContextDTO[]>
  /**
   * What the `citation-contexts` stage actually CONCLUDED for this paper.
   *
   * Needed because two very different outcomes write byte-identical rows: a
   * `refused` run (the numbering could not be trusted, so linking was declined)
   * and an `empty` one (the numbering WAS trusted and nothing linked) both
   * leave bibliography rows and no in-text rows. Inferring which from the rows
   * is therefore impossible, and guessing produces exactly the confidently
   * wrong label this method exists to prevent. Null when the stage has not run.
   */
  getCitationOutcome(workId: number): Promise<CitationOutcomeDTO | null>
  // Resolve an unresolved reference into a work + citation edge (find-or-create
  // by DOI / normalized title), removing the unresolved row. (A-M3.)
  resolveUnresolvedReference(input: {
    unresolvedId: number
    target: ResolveReferenceTarget
    edgeType?: string
  }): Promise<ResolveReferenceResultDTO>

  // graph
  getGraph(projectId: number, opts?: { limit?: number; minRelevance?: number }): Promise<GraphDTO>

  // reference tree — every in-project work + every in-project citation edge,
  // ordered oldest-first, with the preferred document id for the thumbnail.
  // `limit` defaults high (5000) and any shortfall is reported in shown_works.
  getReferenceTree(
    projectId: number,
    opts?: {
      limit?: number
      /**
       * Max unresolved reference nodes to return PER CITING WORK. The corpus
       * parses to ~840 unresolved references over 20 papers, which no DAG can
       * usefully draw at once, so the cap is per-paper (keeping every paper
       * represented) rather than global (which would starve the later papers).
       * Defaults to 0 — callers opt IN to unresolved nodes.
       */
      unresolvedPerWork?: number
    }
  ): Promise<ReferenceTreeDTO>

  /**
   * Queue a real ingest for each cited-but-absent reference given.
   *
   * PERMISSIVE BY DESIGN: every reference that names anything at all is
   * attempted. Ids that are NOT retrievable (no DOI, no title, no venue) or
   * that are already being retrieved are SKIPPED, not rejected — one dead entry
   * in a selection must not lose the user the other nine. The result reports
   * exactly which ids were queued and which were skipped, so the UI states what
   * happened rather than assuming the whole batch went through.
   */
  retrieveUnresolvedReferences(input: {
    projectId: number
    unresolvedIds: number[]
  }): Promise<RetrieveReferencesResultDTO>

  /**
   * Live retrieval state for the given references, read back from the jobs they
   * spawned. The tree polls this so a card stops saying "Retrieving…" when the
   * job it names actually ends — including across a restart, since the link
   * lives in the DB and not in the component.
   */
  getReferenceRetrievals(unresolvedIds: number[]): Promise<ReferenceRetrievalDTO[]>

  /**
   * The abstract fetched for ONE unresolved reference, read when a user asks to
   * see it.
   *
   * ON DEMAND, not on the DTO. Every list already carries the abstract's STATE,
   * which is what a row needs to label its own button; the prose is a couple of
   * kilobytes and a panel showing 200 references would ship all of it to serve
   * the one abstract anybody opens. Returns null only when no such unresolved
   * reference exists — a reference nothing has fetched for comes back as a row
   * with a null outcome, because "nobody asked" is an answer.
   */
  getReferenceAbstract(unresolvedId: number): Promise<ReferenceAbstractDTO | null>

  // ranking
  getRanking(
    projectId: number,
    sortBy?: 'relevance' | 'expansion' | 'year' | 'citations'
  ): Promise<RankingRowDTO[]>
  setInclusionStatus(
    projectId: number,
    workId: number,
    status: string,
    reason?: string
  ): Promise<void>
  overrideScore(
    projectId: number,
    workId: number,
    field: 'relevance' | 'expansion_priority',
    value: number,
    reason?: string
  ): Promise<void>
  /**
   * Ask for both ranking scores to be measured again.
   *
   * RESOLVES BEFORE THE NUMBERS MOVE. Scoring is a queued corpus sweep running
   * a local model per paper, so a caller must re-read the ranking rather than
   * render this call's result — which is why it returns what was QUEUED and not
   * a row. Scores a person set by hand are left alone.
   */
  recomputeRankings(projectId: number): Promise<{ queued: boolean; discardedRuns: number }>
  // Mark/unmark a work as a project reference paper (feeds the topic dossier).
  // Returns the refreshed ranking rows so the caller renders from the write's
  // result rather than a read-after-write. (A-B2.)
  markReference(
    projectId: number,
    workId: number,
    isReference: boolean
  ): Promise<RankingRowDTO[]>

  // extraction schemas — the user-owned definitions of WHAT to extract. GLOBAL:
  // a schema belongs to the app, not to a project, so none of these take a
  // project id. Fields come back ordered by (sort_order, id). Every mutation
  // returns the refreshed schema (or the refreshed list, for deletes) so the
  // renderer updates from the RETURN VALUE — no read-after-write race.
  listSchemas(): Promise<ExtractionSchemaDTO[]>
  createSchema(input: SchemaInput): Promise<ExtractionSchemaDTO>
  updateSchema(schemaId: number, input: SchemaInput): Promise<ExtractionSchemaDTO>
  /** Rejects built-in schemas. Linked measurements survive (field_id -> NULL). */
  deleteSchema(schemaId: number): Promise<ExtractionSchemaDTO[]>
  addSchemaField(schemaId: number, input: FieldInput): Promise<ExtractionSchemaDTO>
  updateSchemaField(fieldId: number, input: FieldInput): Promise<ExtractionSchemaDTO>
  deleteSchemaField(fieldId: number): Promise<ExtractionSchemaDTO>
  /**
   * Set the display order of a schema's fields — the column order everything
   * that reads the schema then follows.
   *
   * `fieldIds` must be a PERMUTATION of the schema's current field ids: every
   * one of them, each exactly once, and none belonging to another schema. A
   * partial list is refused rather than appended to, because the unnamed fields
   * would silently land wherever the previous order left them.
   *
   * Order is presentation only. `sort_order` is deliberately outside the field
   * param hash and outside the schema version, so reordering cannot mark a
   * single stored extraction stale.
   */
  reorderSchemaFields(schemaId: number, fieldIds: number[]): Promise<ExtractionSchemaDTO>
  /**
   * The premade schemas a user can start from. Read-only and DB-independent:
   * nothing exists until one is imported, so an install carries no opinion
   * about a discipline its owner does not work in.
   */
  listSchemaPresets(): Promise<SchemaPresetDTO[]>
  /** One schema as a portable bundle — what Share puts on the clipboard. */
  exportSchema(schemaId: number): Promise<SchemaBundleDTO>
  /**
   * Create a schema and all of its fields from a bundle, in ONE transaction:
   * a paste that fails halfway must leave no half-built schema behind.
   *
   * Never overwrites. An imported bundle whose name is taken arrives as a
   * second schema, because a shared definition is a colleague's opinion and
   * must not silently rewrite the recipient's own work.
   */
  importSchema(bundle: SchemaBundleDTO): Promise<ExtractionSchemaDTO>

  // per-project schema ATTACHMENTS — which global schemas a project applies in
  // its Extraction view. Detaching is not deleting: the definition and every
  // measurement already extracted with it survive (the Extraction screen keeps
  // rendering those rows in their own, clearly-labelled section).
  listProjectSchemas(projectId: number): Promise<ExtractionSchemaDTO[]>
  attachSchema(projectId: number, schemaId: number): Promise<ExtractionSchemaDTO[]>
  detachSchema(projectId: number, schemaId: number): Promise<ExtractionSchemaDTO[]>
  /** Real, DB-derived extraction coverage for each schema attached to a project. */
  getSchemaCoverage(projectId: number): Promise<SchemaCoverageDTO[]>

  // summaries
  /**
   * Read the CURRENT summary of one work, or an honest account of its absence.
   * Never writes and never calls a model — pressing a button is what does that.
   *
   * `projectId` is ignored for `kind: 'general'`, which always resolves the
   * global (`project_id = 0`) run.
   */
  getWorkSummary(input: {
    workId: number
    projectId: number
    kind: SummaryKind
  }): Promise<WorkSummaryDTO>
  /**
   * Write (or rewrite) one summary and return it.
   *
   * Supersede-then-insert, so there is exactly one current summary per
   * (work, kind) and the previous one stays as retired provenance. Rejects when
   * the work has no text beyond its title, and — for `project` — when the
   * project has no dossier to read the paper against; both name what is missing
   * rather than writing prose the model invented.
   */
  generateWorkSummary(input: {
    workId: number
    projectId: number
    kind: SummaryKind
  }): Promise<WorkSummaryDTO>
  /**
   * WHICH works in a project already have a summary, for each scope.
   *
   * A list screen needs this for every row at once. `getWorkSummary` answers
   * for one work and assembles the prose, its provenance and its freshness —
   * fifty of those to decide fifty button tints would be fifty analyses read
   * and thrown away. This returns only the ids, from one indexed query.
   *
   * Presence, NOT content: a work appears here when a current summary run left
   * prose behind. A run that failed and produced nothing is absent, which is
   * correct — there is no summary to read.
   */
  getWorksWithSummaries(projectId: number): Promise<{ general: number[]; project: number[] }>

  // extraction / review
  getExtractionRows(projectId: number): Promise<ExtractionRowDTO[]>
  /**
   * The table pictures a paper's extraction was READ OFF — the same images, from
   * the same renderer, that `schema-extract` puts in the model's prompt.
   *
   * Exists because a reviewer auditing an extracted value cannot do it from the
   * text layer: that layer stores `0 . 29 6 0 . 11` for `0.29 ± 0.11` and loses
   * cells that wrap, so — as `tableCrops.ts` puts it — a reviewer handed only
   * the flattened text is asked to find a fault in the one artefact where the
   * fault is invisible. Rendering a DIFFERENT picture would be a lookalike; this
   * is the same call, so what the reviewer sees is the evidence itself.
   *
   * `found` / `unavailable` travel with the images because "no picture" has
   * several causes that are not equally benign: a paper with no tables needs
   * none, while a paper whose tables were located and could NOT be rendered was
   * extracted from text the architecture does not trust for values.
   */
  getTableCrops(input: { workId: number; quote?: string | null }): Promise<TableCropsDTO>
  // §12 extraction-status summary + deterministic QC sample. (A-M4.)
  getExtractionStatusSummary(projectId: number): Promise<ExtractionStatusSummaryDTO>
  getReviewQueue(projectId: number): Promise<ReviewItemDTO[]>
  /**
   * Record a HUMAN verdict on one escalated fact, for one project. Append-only:
   * this NEVER updates the fact, its evidence spans or its analysis_run — the
   * AI's extraction and its provenance stay byte-identical. Returns the row that
   * was written (including the server-resolved reviewer and timestamp).
   *
   * `correctedValue` is REQUIRED when verdict = 'corrected' and REJECTED
   * otherwise; 'unresolved' retracts an earlier verdict by appending, so an undo
   * is itself part of the audit trail rather than a deletion of it.
   */
  recordFactVerdict(input: {
    projectId: number
    factId: number
    verdict: FactVerdictKind
    correctedValue?: string
    note?: string
  }): Promise<FactVerdictDTO>

  // dossier
  getDossier(projectId: number): Promise<DossierEntryDTO[]>
  /**
   * Authoring state of the dossier: which papers are marked as references, which
   * are actually feeding it, when it was last BUILT, and which analyses are now
   * stale against it. Read-only — building is `buildDossier`.
   */
  getDossierStatus(projectId: number): Promise<DossierStatusDTO>
  /**
   * THE BRIEFING: what a model is told about this project before it reads a
   * paper, with each section's size.
   *
   * One call rather than five, because the five parts are read together as one
   * budget and are assembled from five different tables — issuing them
   * separately would put the sizes on screen at five different moments, each
   * briefly disagreeing with the total beside it.
   */
  getDossierBriefing(projectId: number): Promise<DossierBriefingDTO>
  /**
   * Build (or rebuild) the dossier: runs the `dossier` analysis through the LLM
   * pipeline once per reference paper, with full provenance and
   * supersede-then-insert. Returns the refreshed status. Throws when the project
   * has no reference papers — a build over an implicit fallback set would
   * persist runs the user never asked for.
   */
  buildDossier(projectId: number): Promise<DossierStatusDTO>
  /**
   * The slice of a project's dossier that is relevant to ONE paper — exactly the
   * background the app's own analyses of that paper were given, assembled by the
   * same function that builds their prompt context.
   *
   * Exists for the AGENT side (`dossier_context_get`), which is handed this
   * material alongside every project-scoped read and needs a way to ask for it
   * again when it cannot find it. `state` is `'none'` when the project has no
   * reference papers to draw from — an answer, not a failure.
   */
  getDossierContext(projectId: number, workId: number): Promise<DossierContextDTO>

  /**
   * Erase a paper and everything derived from it — analyses, evidence, facts,
   * citation edges, project membership — permanently and irreversibly.
   *
   * Resolves false when the work no longer exists, so deleting twice is not an
   * error. The caller is responsible for confirming with the user first: there
   * is no undo.
   */
  deleteWork(workId: number): Promise<boolean>
  /**
   * Take a paper OUT OF ONE PROJECT, without touching the paper itself.
   *
   * DISTINCT FROM `deleteWork`, and the distinction matters: a paper is stored
   * once globally and imports dedup by DOI, so the row someone removes from
   * their project may be the same one another project has been reading for
   * months. This drops only this project's membership and its own
   * interpretation of the paper — relevance, inclusion status, its reference
   * flag. Analyses are keyed by (work, project) and survive, so a re-add finds
   * them again.
   *
   * Resolves false when the paper was not in the project, so removing twice is
   * not an error.
   */
  removeWorkFromProject(projectId: number, workId: number): Promise<boolean>

  /**
   * Put a paper the library ALREADY HOLDS into a project.
   *
   * NOT an import. A work is stored once globally, so this creates only the
   * project's own interpretation of it — unscored and unread, because nothing
   * has judged this paper against THIS project's question, and a paper's scores
   * elsewhere are answers to a different one.
   *
   * What it is for: a citation reaches out of the project it was drawn in, and
   * the paper on the other end is real and already fetched. Bringing it in is
   * the ordinary act; re-importing it would be an attempt to store the same
   * paper twice.
   *
   * Resolves false when the paper was already a member, so adding twice is not
   * an error — mirroring `removeWorkFromProject`.
   */
  addWorkToProject(projectId: number, workId: number): Promise<boolean>

  // queue
  listJobs(projectId: number): Promise<JobDTO[]>
  /**
   * The pipeline's stages, in the registry's resolved execution order.
   *
   * Read ONCE per screen rather than per row: the registry is a property of the
   * running build, identical for every paper, and it cannot change while the
   * app is running (the graph is validated at boot). The Queue lays every row
   * out against this list, so a stage that has never run for a paper renders as
   * pending instead of being absent.
   */
  listStages(): Promise<StageDefDTO[]>
  /**
   * The papers in a project whose stored results were produced under inputs
   * that have since changed, and which stages would re-run.
   *
   * COMPUTED on every call, never stored. A persisted stale flag is a second
   * opinion about the stage cache, and when the two drift the user is told a
   * paper needs refreshing while the refresh runs nothing — so this asks the
   * same fingerprint the scheduler consults when it claims a job.
   *
   * A paper absent from the list is current. A paper with no results at all is
   * also absent: "produced under inputs that have since changed" is not a claim
   * that can be made about results which were never produced, and the queue
   * already shows unprocessed papers as pending.
   */
  staleWorks(projectId: number): Promise<StaleWorkDTO[]>

  /** How much work the queue does at once. See `QueueSettingsDTO`. */
  queueSettings(): Promise<QueueSettingsDTO>

  /** Which model each kind of work uses, and how much room it is given. */
  modelSettings(): Promise<ModelSettingsDTO>
  /** Change one or more. Omit a field to leave it as it is. */
  setModelSettings(next: Partial<Omit<ModelSettingsDTO, 'is_default'>>): Promise<ModelSettingsDTO>
  /** Forget every choice, returning the values the app ships with. */
  resetModelSettings(): Promise<ModelSettingsDTO>
  /** The models the gateway currently serves, for the pickers to offer. */
  availableModels(): Promise<string[]>
  /** Change one or both limits. Omit a field to leave it as it is. */
  setQueueSettings(next: { llm?: number; local?: number }): Promise<QueueSettingsDTO>
  /** Forget both choices, returning the values the app ships with. */
  resetQueueSettings(): Promise<QueueSettingsDTO>
  /**
   * Subscribe to job-queue changes. Returns an unsubscribe function.
   *
   * The signal carries NO payload deliberately: it means "something changed,
   * read again", so listeners refetch through the typed methods above. Pushing
   * the rows themselves would create a second, push-shaped copy of JobDTO that
   * could drift from the one every other call returns.
   *
   * Fires for every transition the queue makes — enqueue, claim, done, failed,
   * retry, cancel — coalesced in main so a burst arrives as one signal.
   */
  onJobsChanged(cb: () => void): () => void
  /**
   * Subscribe to summaries being written. Returns an unsubscribe function.
   *
   * Payload-free for the same reason `onJobsChanged` is: it means "a summary
   * changed, read again". It does not even name the work — a listener that
   * cares about one paper is cheaper to write as a refetch of what it already
   * knows how to read than as a filter it would have to keep in step with the
   * write side.
   *
   * NOT coalesced. The queue's signal is throttled because the queue moves
   * continuously; a summary is written once, deliberately, by a person waiting
   * to see it appear.
   */
  onSummariesChanged(cb: () => void): () => void

  // ---- tabs ------------------------------------------------------------------
  //
  // The window→tabs model lives in MAIN, so these are the renderer's only view of
  // it. The renderer NEVER mutates its own mirror: every op carries `expectedRev`
  // and a mismatch is rejected, because cross-window moves and closes interleave
  // with no ordering and an optimistically-updated mirror would diverge silently.
  //
  // No method takes a window id. The calling window is always resolved in main
  // from the sender, so one renderer cannot address another window's tabs.
  /** This window's tabs and which is active, or null before it is registered. */
  tabsState(): Promise<WindowTabsDTO | null>
  /**
   * Open a page as a tab here, or focus the tab that already shows it.
   *
   * Dedupe is per WINDOW. A sibling window holding the same page comes back in
   * `alsoOpenIn` rather than being focused: two windows exist so the user can read
   * two things side by side, and pulling focus to another monitor is the worst
   * outcome a click can have.
   */
  tabsOpen(input: {
    route: Route
    projectId: number | null
    title?: string
    /** Ctrl/Cmd-click: a second tab for the same page, deliberately. */
    forceNew?: boolean
    viewState?: string | null
    expectedRev?: number
  }): Promise<TabOpenResultDTO | null>
  tabsActivate(input: { key: string; expectedRev?: number }): Promise<TabOpResultDTO>
  /** Close a tab. Refused for the last one — a window always shows something. */
  tabsClose(input: { key: string; expectedRev?: number }): Promise<TabOpResultDTO>
  /** Set the tab order. Only a permutation of the current keys is accepted. */
  tabsReorder(input: { keys: string[]; expectedRev?: number }): Promise<TabOpResultDTO>
  /**
   * Move a tab to a different page after a navigation inside it.
   *
   * A tab's key never changes, but what it SHOWS does — following a citation
   * from the Connectome into a paper is one tab moving, not a new one. Main has
   * to be told, because main is what answers "is this page already open here":
   * a model still believing the tab held the Connectome would open a SECOND tab
   * for the paper the user is already reading, and would mark the wrong tab
   * stale when that paper was deleted.
   */
  /**
   * Drag a tab out into a NEW window, positioned at the cursor.
   *
   * The tab STAYS here, marked, until the new window claims it: the gap between
   * the two spans a window construction and a page load, and if either window
   * dies inside it the page would otherwise belong to nobody. A failure at any
   * point reverts the move rather than destroying the tab.
   */
  tabsDetach(input: { key: string; screenX: number; screenY: number }): Promise<boolean>
  /**
   * Claim the tab this window was created to receive.
   *
   * Called once by every window as it starts. Takes no key — main knows what it
   * promised this window — so a window cannot claim a page merely by naming it.
   * A window that was not opened by a detach gets `false` and carries on.
   */
  tabsAdopt(): Promise<boolean>
  tabsSetRoute(input: {
    key: string
    route: Route
    projectId: number | null
    title?: string
  }): Promise<boolean>
  /**
   * Rename a tab once its subject has loaded.
   *
   * Separate from `tabsOpen` because a paper's title is not known when its tab is
   * created — the strip has to draw something the moment it is clicked. Does not
   * bump the rev, so a rename cannot reject an op the user has in flight.
   */
  tabsSetTitle(input: { key: string; title: string }): Promise<boolean>
  /** Store a tab's opaque snapshot, for restoring it after a suspend or a move. */
  tabsSetViewState(input: { key: string; viewState: string | null }): Promise<boolean>
  /**
   * Subscribe to this window's tab model changing. Returns an unsubscribe.
   *
   * Payload-free like the other two signals, for the same reason: it means "your
   * mirror is stale, read again". Pushing the model would create a second
   * push-shaped copy able to drift from what `tabsState` returns.
   */
  onTabsChanged(cb: () => void): () => void

  retryJob(jobId: number): Promise<void>
  cancelJob(jobId: number): Promise<void>
  /**
   * Whether the queue is claiming work, and how many jobs are still finishing.
   *
   * `inFlight` matters because pausing does NOT abort a running job: a job has
   * no intermediate save point, so aborting it would discard everything it had
   * done and cost it an attempt when it was re-queued. "Paused" therefore means
   * "claiming nothing new", and the count says whether anything is still
   * landing.
   */
  getQueueState(): Promise<{ running: boolean; inFlight: number }>
  /** Pause claiming. Jobs already running are left to finish. */
  pauseQueue(): Promise<{ running: boolean; inFlight: number }>
  /** Resume claiming, re-queueing anything left running by a previous session. */
  resumeQueue(): Promise<{ running: boolean; inFlight: number }>
  /**
   * Acknowledge (or un-acknowledge) a failed job. Returns the project's job list
   * so the caller renders from the write's result. The failure itself is
   * untouched — only whether it still counts as outstanding.
   */
  setJobDismissed(jobId: number, dismissed: boolean, projectId: number): Promise<JobDTO[]>

  // ingest — enqueues a job; the pipeline creates the work and any analysis
  /**
   * Queue a paper for import.
   *
   * When the value is a recognised IDENTIFIER (DOI, arXiv id, PMID — in any of
   * the forms they get pasted in, including doi.org and arxiv.org URLs), main
   * first resolves it against the public metadata APIs and creates a work with
   * the paper's REAL title, authors, year, venue and abstract. In that case
   * `resolvedTitle` names the paper that was found, so the caller can confirm
   * the identifier meant what the user thought it meant.
   *
   * `resolvedTitle` is absent when the value was not an identifier, or when no
   * index could resolve it — the import still proceeds, it just has nothing but
   * the raw string to go on.
   *
   * `kind: 'pdf'` takes an ABSOLUTE PATH, reads those bytes into the managed
   * library, and titles the paper from the FILE'S NAME — no directory, no `.pdf`
   * — because a filename is the only thing a bare file offers. `resolvedTitle`
   * carries it back, so the caller can name what it queued.
   *
   * `kind: 'folder'` is REFUSED. Expand a folder with `expandIngestPaths` first
   * and import the PDFs it names: a folder is not a paper, and a work titled
   * after a directory is a row nothing can ever resolve or cite.
   */
  ingest(input: {
    projectId: number
    kind: 'doi' | 'pmid' | 'arxiv' | 'title' | 'url' | 'pdf' | 'folder'
    value: string
  }): Promise<{ jobId: number; workId?: number; resolvedTitle?: string }>
  /**
   * Attach a PDF ON THIS MACHINE to a paper the library ALREADY HOLDS, and
   * re-plan that paper so the stages a missing file blocked run now.
   *
   * DISTINCT FROM `ingest`, and the distinction is what keeps one paper one row:
   * `ingest` creates a paper from a file, this adds a file to a paper. The
   * answer to a retrieval that refused — no DOI, no URL, or every mirror failed
   * — is this one: the paper is known and its metadata is right, only the bytes
   * were missing. Importing the file instead would leave the library holding the
   * same paper twice.
   *
   * Metadata is NEVER touched. What an index reported about a paper beats what
   * someone's copy of the file happens to be called.
   *
   * `alreadyHadFile` true means the paper already had a PDF and it was LEFT
   * ALONE — replacing the bytes would invalidate the extracted text, the
   * segments and every fact anchored into them. Nothing was re-planned in that
   * case and `jobId` is 0.
   */
  attachPdfPath(input: {
    workId: number
    projectId: number
    path: string
  }): Promise<{
    jobId: number
    workId: number
    documentId: number
    alreadyHadFile: boolean
    relativePath: string
  }>
  /**
   * Native picker for files AND folders, returning ABSOLUTE paths already
   * expanded to the PDF files they stand for. Empty array = cancelled (never an
   * error). `ingest` addresses a PDF by absolute path, and since Electron 33 a
   * renderer cannot obtain one itself — only main can resolve it.
   */
  pickIngestFiles(): Promise<string[]>
  /**
   * Expand dropped paths into PDF files: a file is itself, a directory is every
   * .pdf beneath it, recursively. Only main can walk the filesystem.
   */
  expandIngestPaths(paths: string[]): Promise<string[]>
  /**
   * The absolute path of a dropped `File`. Since Electron 33 removed
   * `File.path` this is the ONLY way the renderer can learn one; returns '' if
   * the runtime will not resolve it.
   */
  getDroppedPath(file: File): string
  /**
   * Per-view UI preferences (e.g. the ranking sort + status filter).
   *
   * The project's real progression — inclusion status and score overrides — is
   * already written to SQLite as it changes. These keep the VIEW settings from
   * resetting on navigation, so the app has one continuously-saved state and
   * needs no explicit save/restore step.
   */
  getViewPref(key: string): Promise<string | null>
  setViewPref(key: string, value: string): Promise<void>
  /**
   * Developer mode: record every stage execution and every LLM conversation —
   * full prompt, full raw response, and how each quote was anchored to a
   * paragraph — to a session file on disk.
   *
   * It exists because the database keeps a verdict and input hashes but never
   * the conversation. When an extracted value ends up under evidence that does
   * not support it, nothing survives to say whether the model quoted the wrong
   * line or our anchoring matched the wrong paragraph.
   *
   * Off by default, and off is free: every log entry point returns on a boolean
   * before building a string.
   */
  getDevLogStatus(): Promise<DevLogStatusDTO>
  setDevLogEnabled(enabled: boolean): Promise<DevLogStatusDTO>
  /** Reveal the session log in the OS file manager. */
  openDevLogDir(): Promise<void>
  /**
   * Token spend per day, for the Analytics chart.
   *
   * Aggregated in SQL: the renderer receives day buckets and never the ledger
   * itself, which is one row per LLM call and grows with every corpus run.
   */
  getTokenUsage(q: TokenUsageQuery): Promise<TokenUsageSeriesDTO>
  /**
   * The writing brief for one of the two prose summaries, and the built-in it
   * replaces.
   *
   * `scope: 'general'` is corpus-wide and ignores `projectId`; `scope: 'project'`
   * is one project's and requires a real one. Both are returned together with
   * `builtin` because the user is editing a SYSTEM prompt: an empty box would
   * make them guess what they are overriding, and there would be no way back to
   * the shipped text once they had typed over it.
   */
  getSummaryPrompt(input: {
    scope: SummaryPromptScopeDTO
    projectId?: number
  }): Promise<SummaryPromptDTO>
  /**
   * Replace, or restore, that brief. `text: null` (or blank) removes the
   * override and returns the brief to the built-in.
   *
   * Saving re-writes nothing by itself: the new text changes the stamp the NEXT
   * summary records, and the summaries already stored become stale through the
   * same input hashes and stage fingerprint every other analysis is checked by.
   */
  setSummaryPrompt(input: {
    scope: SummaryPromptScopeDTO
    projectId?: number
    text: string | null
  }): Promise<SummaryPromptDTO>
  runAnalysis(input: {
    workId: number
    projectId: number
    analysisType: string
    /**
     * Optional target extraction schema. When supplied, the pipeline renders
     * that schema's DB-defined fields into the prompt and links the resulting
     * measurements back to those fields — this is how a user-authored schema
     * actually drives the AI. Omitted = unguided (previous behaviour).
     */
    schemaId?: number
  }): Promise<AnalysisRunDTO>

  // search
  // Filtering happens in SQL (repositories.search), never as a renderer-side
  // post-filter: the row LIMIT would otherwise be applied before the filter and
  // silently drop matches.
  search(query: string, projectId?: number, filters?: SearchFilters): Promise<SearchResultDTO[]>
  // How many papers match, counted in SQL and NOT capped by the row limit, so
  // the UI can state the true total rather than the size of the page it got.
  countSearch(query: string, projectId?: number, filters?: SearchFilters): Promise<number>
  // Facet counts respect the current query + the OTHER facets, so the numbers
  // stay true while each facet remains multi-selectable.
  getFacets(projectId: number, query?: string, filters?: SearchFilters): Promise<FacetsDTO>
  /**
   * Free-text search over papers OUTSIDE the corpus, served by main's search
   * registry over live academic indexes. Ranking is deterministic token overlap
   * over title+abstract. Importing a hit goes through the ordinary `ingest`
   * path — there is no second ingest.
   *
   * REJECTS when no source could answer. An unreachable index is not "no papers
   * found": the caller must render the failure, never an empty result.
   */
  searchWeb(query: string, filters?: WebSearchFilters): Promise<WebSearchResultDTO[]>
  /**
   * Search the corpus BY MEANING rather than by words.
   *
   * Answered by a read-only worker thread, never on main: better-sqlite3 is
   * synchronous, so a k-NN plus an ONNX forward pass for the query would freeze
   * the window for the duration (115 ms measured at stress scale).
   *
   * Never rejects for a state the user can act on — no model packaged, nothing
   * embedded yet, a model swapped under existing vectors — those come back in
   * `error` alongside the coverage that explains them.
   *
   * `workId` narrows the whole answer — hits AND coverage — to ONE paper, which
   * is what the in-document find bar's "By meaning" mode asks. It is a scope
   * pushed into the k-NN rather than a filter applied to a corpus-wide result:
   * filtering afterwards would discard most of the ranked list and leave a
   * handful of passages that look like everything the paper had to offer. And
   * because the coverage travels scoped too, "this paper has no embeddings" is
   * distinguishable from "this paper has nothing matching".
   */
  semanticSearch(
    query: string,
    projectId?: number,
    k?: number,
    workId?: number
  ): Promise<SemanticSearchResultDTO>
  /**
   * Embedding coverage, WITHOUT running a query.
   *
   * Separate from `semanticSearch` because the honest answer to "can I trust
   * semantic search here" has to be available BEFORE the first search, not only
   * as a footnote to its results.
   *
   * `workId` asks it of a single paper, so a surface that can only search one
   * document says "this paper is not embedded yet" instead of reporting a
   * library-wide ratio the reader cannot act on from where they are standing.
   */
  semanticCoverage(projectId?: number, workId?: number): Promise<SemanticCoverageDTO>
  /** Past searches, most recent first. */
  listSearchHistory(projectId: number): Promise<SavedSearchDTO[]>
  /**
   * Record an executed search in the history, with its FULL parameter set.
   * Re-running an identical search bumps it rather than adding a duplicate.
   */
  recordSearch(input: { projectId: number; name: string; query: string; filters?: string }): Promise<SavedSearchDTO>
  listFrontiers(projectId: number): Promise<SavedFrontierDTO[]>
  saveFrontier(input: { projectId: number; name: string; graphState: string }): Promise<SavedFrontierDTO>

  /**
   * Raw bytes for the viewer (read from `file_location` under its `base_dir`),
   * or WHY there are none.
   *
   * Never a bare null: absence, an unmounted drive, a permission error and a
   * rejected path are four different things the reader acts on differently, and
   * collapsing them let the viewer state a content-status fact it had not
   * established. See `PdfReadResult`.
   */
  readPdf(documentId: number): Promise<PdfReadResult>
  /**
   * Where each OCR'd word sits, so a SCANNED page can carry selectable text.
   *
   * Null for every document whose PDF has a real text layer — pdf.js supplies
   * their geometry directly, and the viewer only synthesises a layer when there
   * is none. Also null for a scan OCR'd before this geometry was captured;
   * re-running the stage is what fills it.
   */
  readOcrWordBoxes(documentId: number): Promise<OcrWordBoxesDTO | null>

  // integrations / settings
  getIntegrationsStatus(): Promise<IntegrationsStatusDTO>

  // outlets — where this project's work is mirrored to. Every setter PERSISTS
  // and returns the new state, so the renderer never holds a switch position the
  // database does not.
  listOutlets(projectId: number): Promise<OutletStatusDTO[]>
  listOutletActions(projectId: number, outletId: string): Promise<OutletActionDTO[]>
  /** Performs a REAL side effect and reports what it actually did. */
  runOutletAction(
    projectId: number,
    outletId: string,
    actionId: string
  ): Promise<OutletActionResultDTO>
  /**
   * Open the folder this outlet writes into, in the OS file manager.
   *
   * Takes the OUTLET ID, not a path — main resolves the folder from the
   * outlet's own stored settings, so the renderer cannot name an arbitrary
   * location to open. False when nothing is configured or the folder is gone.
   */
  revealOutletFolder(outletId: string): Promise<boolean>
  getOutletSettings(): Promise<OutletSettingsDTO>
  updateOutletSettings(outletId: string, patch: Record<string, unknown>): Promise<OutletSettingsDTO>
  /** Markdown exactly as the file would be written — same renderer, no drift. */
  previewOutletNote(projectId: number, workId: number): Promise<string | null>

  // zotero — READ-ONLY against a temp COPY of zotero.sqlite, so no lock is taken
  // and Zotero may stay open. Nothing is ever written to the user's library;
  // notes go back through an RDF file Zotero imports itself.
  listZoteroCollections(): Promise<ZoteroCollectionDTO[]>
  getZoteroCollectionMap(projectId: number): Promise<string | null>
  setZoteroCollectionMap(projectId: number, collectionKey: string | null): Promise<void>
  importZoteroCollection(projectId: number, collectionKey: string): Promise<ZoteroImportResultDTO>
  /**
   * Write the Zotero import file; same save-dialog contract as an export.
   *
   * A bare `.rdf`, or — when the outlet's `include_pdfs` is on — a `.zip`
   * holding that .rdf beside the papers it links by relative path.
   */
  exportZoteroRdf(projectId: number): Promise<ZoteroExportResultDTO>

  // zotero connection — the OTHER direction, and the only one that WRITES to a
  // library. Everything above reads a copy of zotero.sqlite; these hand a
  // request to a RUNNING Zotero over its local server and let Zotero do the
  // write itself. Never call these with a `ZoteroCollectionDTO.key`: a
  // destination is a treeViewID (see `ZoteroTargetDTO`).
  /** Is Zotero answering right now? Measured on every call, never cached. */
  isZoteroRunning(): Promise<boolean>
  /** Libraries and collections a running Zotero will accept papers into. */
  listZoteroTargets(): Promise<ZoteroTargetDTO[]>
  /** Stored destination for this project, plus whether Zotero is up. */
  getZoteroConnection(projectId: number): Promise<ZoteroConnectionDTO>
  /** Start sending this project's new papers to `targetId`. */
  connectZotero(projectId: number, targetId: string, targetName: string): Promise<void>
  /** Stop sending. The papers already in Zotero stay where they are. */
  disconnectZotero(projectId: number): Promise<void>

  // storage locations — the roots documents are addressed under. Every mutator
  // RETURNS the new list so the renderer never re-reads to find out what it just
  // did, and rejects with a message written for the user when the change is
  // refused (blank name, duplicate folder, or a location documents still need).
  listBaseDirs(): Promise<BaseDirDTO[]>
  /** Native folder chooser. Resolves null when the dialog was dismissed. */
  pickDirectory(): Promise<string | null>
  addBaseDir(input: BaseDirInputDTO): Promise<BaseDirDTO[]>
  updateBaseDir(id: number, patch: BaseDirPatchDTO): Promise<BaseDirDTO[]>
  removeBaseDir(id: number): Promise<BaseDirDTO[]>
  /** Open a location in the OS file manager. False = it is not there. */
  revealBaseDir(id: number): Promise<boolean>

  // settings — DB-backed analysis-model list + selection (no hardcoded array).
  // `setSelectedModel` RETURNS the newly-selected model so the renderer updates
  // from the return value (no read-after-write race); it REJECTS unknown ids.
  listModels(): Promise<LlmModelDTO[]>
  getSelectedModel(): Promise<LlmModelDTO | null>
  setSelectedModel(id: string): Promise<LlmModelDTO>
  /**
   * WHICH provider will answer the next analysis, and why.
   *
   * Distinct from `getSelectedModel`, which is the user's PREFERENCE. This is
   * what the app actually resolved after its last pre-flight against the
   * gateway. Offline the two disagree, and this is the honest one.
   *
   * A SNAPSHOT, and it moves: the app re-probes while it runs. Subscribe with
   * `onLlmStatusChanged` rather than reading this once.
   */
  getLlmStatus(): Promise<LlmStatusDTO>
  /**
   * Re-run the gateway pre-flight NOW, and answer with what it found.
   *
   * A user who has just fixed their connection is looking at a claim about a
   * moment that has passed. Without this their only remedy is to restart the
   * app, which nothing in the UI tells them to do.
   */
  recheckLlmStatus(): Promise<LlmStatusDTO>
  /**
   * Push updates to the status above. Returns its own unsubscribe.
   *
   * The status CHANGES UNDER A RUNNING SESSION. An indicator built on the
   * one-shot read reported the outage the app launched in for as long as the
   * session lasted, which is the failure this exists to end.
   */
  onLlmStatusChanged(cb: (status: LlmStatusDTO) => void): () => void
  /** The endpoint, and whether a key is set. Never the key. */
  getGatewayConfig(): Promise<GatewayConfigDTO>
  /**
   * Save the endpoint and/or the key.
   *
   * `undefined` leaves a field untouched; `''` clears it. The distinction
   * matters: saving an endpoint must not wipe a key the user never touched.
   * Returns the config as it now reads, so the UI never guesses.
   */
  setGatewayConfig(input: { endpoint?: string; key?: string }): Promise<GatewayConfigDTO>
  // Per-project storage roll-up for the Settings modal (real byte sums).
  getStorageUsage(): Promise<StorageProjectDTO[]>

  // --- settings transfer: carrying this install's configuration to another ---
  //
  // The decrypted values NEVER cross this boundary. `listExportableSettings`
  // describes what could go; `readSettingsFile` decrypts in main and returns a
  // description plus a handle; `applySettings` names ids against that handle.
  // One of these items is the gateway API key, so a design in which the renderer
  // held the values would put a credential in an IPC payload.
  /** What this install can export, each item with the tab it belongs to. */
  listExportableSettings(): Promise<SettingsTransferItemDTO[]>
  /**
   * Encrypt the chosen items and write them where the user picks.
   *
   * Same save-dialog contract as every other export: `canceled` is a first-class
   * outcome, and a failed write rejects rather than returning a success shape.
   */
  exportSettingsToFile(itemIds: string[]): Promise<ExportFileResultDTO>
  /**
   * Choose a file, decrypt it, and describe what it holds.
   *
   * Resolves null when the open dialog was dismissed. REJECTS with a message
   * written for the user when the file does not authenticate — a damaged or
   * foreign file is reported as such and nothing is applied, which the format
   * guarantees: the tag is checked before a single value is read.
   */
  readSettingsFile(): Promise<SettingsTransferFileDTO | null>
  /** Apply the chosen items from a file already read. Reports both outcomes. */
  applySettings(handle: string, itemIds: string[]): Promise<SettingsImportResultDTO>
  /** Forget the decrypted file, so its values do not outlive the modal. */
  closeSettingsFile(): Promise<void>

  // --- MCP connector (owned by workstream A — keep this block contiguous) ---
  /**
   * The inbound MCP server's live state, for the Settings pane.
   *
   * Polled every 2s while the server is not stopped, so it reads NO DB and
   * carries NO secret — the token is fetched separately and deliberately.
   */
  getMcpStatus(): Promise<McpStatusDTO>
  /** Start or stop the server. Resolves once the transition has settled. */
  setMcpEnabled(enabled: boolean): Promise<McpStatusDTO>
  /**
   * Change a persisted option. Editable while STOPPED — port, exposure and
   * permission level are settings, not properties of a live socket, and gating
   * them on the server running would force "copy the config, then invalidate
   * what you copied". Changing one while running marks `pendingRestart`.
   */
  setMcpOptions(o: {
    port?: number
    bindLan?: boolean
    allowWrite?: boolean
    allowDestructive?: boolean
  }): Promise<McpStatusDTO>
  /** The bearer token, on explicit request only. */
  getMcpToken(): Promise<string>
  /** Mint a new token, invalidating every config already pasted elsewhere. */
  regenerateMcpToken(): Promise<string>
  /** The exact JSON (or command line) to paste into a client, token included. */
  getMcpClientConfig(variant: McpClientVariant): Promise<string>
  /** Open the folder holding the MCP call log. */
  openMcpAuditDir(): Promise<void>
  // --- end MCP connector block ---

  /**
   * Getting a newer version of the app.
   *
   * The app CHECKS on its own once per launch; it never downloads or installs
   * without being told to. A download is bytes over someone's connection and an
   * install ends the session — neither is a thing to do behind a scientist's
   * back mid-analysis.
   */
  updateState(): Promise<UpdateStateDTO>
  checkForUpdate(): Promise<UpdateStateDTO>
  downloadUpdate(): Promise<UpdateStateDTO>
  cancelUpdateDownload(): Promise<UpdateStateDTO>
  /**
   * Quit and relaunch into the new version.
   *
   * On success the app is going away, so this does not resolve. It resolves
   * FALSE when the install could not be started, which is the only way the
   * panel can tell that apart from a restart already underway.
   */
  installUpdate(): Promise<boolean>
  /**
   * Reveal the downloaded installer, for the builds that cannot replace
   * themselves. False when the file is no longer there, so the panel can say so
   * rather than appearing to ignore the click.
   */
  revealUpdateFile(): Promise<boolean>
  /** Push updates to the state above. Returns its own unsubscribe. */
  onUpdateState(cb: (state: UpdateStateDTO) => void): () => void

  // Third-party attribution. The list is cheap; each full text is fetched only
  // when its entry is expanded.
  listLicences(): Promise<LicenceEntryDTO[]>
  getLicenceText(id: string): Promise<LicenceTextDTO>

  // export — 'json' and 'graph' are the two structural formats. ANY other string
  // is resolved as an extraction_schema.export_alias from the DB, so no domain
  // format name is hardcoded in the contract, the IPC zod guard, or the
  // repository. Unknown aliases are rejected in main.
  exportProject(projectId: number, format: string): Promise<string>
  /**
   * What this project can be exported as, in menu order.
   *
   * DERIVED in main from the format registry plus the project's own attached
   * schemas — which is why the renderer never names a format: it renders these
   * labels and echoes back an `id`. A project with three schemas offers three
   * table exports without a line of UI changing.
   */
  listExportOptions(projectId: number): Promise<ExportOptionDTO[]>
  /**
   * Build one export and WRITE IT TO DISK at a location the user picks in a
   * native save dialog. Takes the OPTION ID from `listExportOptions`, which main
   * resolves back to a spec — a renderer cannot describe an export of its own
   * devising.
   *
   * Returns the real path written and its real byte length, or
   * `{canceled:true, path:null}` when the dialog is dismissed. Write failures
   * REJECT — the caller can never mistake one for a success. The file is written
   * to a temporary sibling and atomically renamed, so a failed or partial write
   * leaves no truncated file behind claiming to be an export.
   */
  exportProjectToFile(projectId: number, optionId: string): Promise<ExportFileResultDTO>
  /**
   * Reveal a previously-exported file in the OS file manager. Takes the OPAQUE
   * id minted by `exportProjectToFile`, never a path: the renderer cannot name
   * an arbitrary filesystem location for the main process to open.
   */
  revealExport(exportId: string): Promise<boolean>

  // ---------------------------------------------------------------- window
  // The app window is FRAMELESS (no OS title bar); the topbar renders our own
  // minimize / maximize-restore / close controls, which drive these channels.
  // Main resolves the target window from the IPC sender, so the renderer can
  // only ever control its OWN window (no window id crosses the boundary).
  window: {
    minimize(): Promise<void>
    /** Toggles and RETURNS the re-queried real maximized state. */
    toggleMaximize(): Promise<boolean>
    close(): Promise<void>
    isMaximized(): Promise<boolean>
    /**
     * Subscribe to real maximize/unmaximize/restore/resize transitions so the
     * control icon reflects ACTUAL window state instead of guessing. Returns an
     * unsubscribe function for React cleanup.
     */
    onMaximizedChanged(cb: (maximized: boolean) => void): () => void
    /**
     * Frameless X11 windows have no WM resize border, so the renderer paints
     * its own edge grips and streams the desired bounds here. Main clamps to the
     * window's minimum size and ignores the call while maximized/fullscreen.
     */
    setBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<void>

    /**
     * State of the close guard.
     *
     * `asking` — the user tried to close while papers were being read, and main
     * has held the close open pending their answer.
     * `finishing` — they chose to let the current paper land; main has stopped
     * taking new papers and will quit by itself once the count reaches zero.
     * `busy` is how many papers are still being read; `elapsedMs` is how long
     * the finishing wait has run, so the UI can admit when it is taking long.
     */
    onQuitState(cb: (s: QuitStateDTO) => void): () => void
    /** Read the current guard state (for a window that mounted mid-prompt). */
    getQuitState(): Promise<QuitStateDTO>
    /**
     * Answer the close prompt. `now` abandons what is being read, `finish`
     * waits for it and then quits, `cancel` stays in the app.
     */
    quitDecision(choice: QuitChoice): Promise<void>
  }

  // --- paper text, resolution, stage runs, import (workstream D) ------------
  // Appended at the interface's END, in one block, on purpose: two workstreams
  // add methods to this interface and appending elsewhere is the merge conflict
  // neither of them can resolve without reading the other's diff.
  //
  // NONE of the reads below takes a `projectId`, and that is the ontology
  // speaking rather than an omission. A paper's TEXT, its identifiers and the
  // stage runs that produced them are properties of the WORK and the DOCUMENT,
  // which are global and stored once; only interpretation (relevance, inclusion,
  // notes) is project-scoped, and none of that is returned here. A project
  // filter would be inventing a scope the data does not have.
  //
  // The consequence is real and belongs to whoever exposes these outward: a
  // caller holding one project can read any paper in the install. For the
  // renderer that is already true of every work-scoped channel. For an agent
  // granted a single project it is a decision to take deliberately, at the layer
  // that grants it, not one to bury in a WHERE clause here.

  /**
   * LITERAL search inside one paper's extracted text.
   *
   * Case-insensitive by default, and NOT accent-folded: folding strips combining
   * marks, which changes string LENGTH, and every offset returned here has to
   * satisfy the app's slice contract so an agent (or the viewer) can anchor to
   * it. Matching is exact-with-case-folding; the offsets stay citable.
   *
   * `state` is not an error. A paper with no extracted text returns `no-text`
   * with its content status — abstract-only papers are a normal part of a
   * corpus, not a failure of the search.
   *
   * A needle is matched within ONE paragraph, never across a paragraph break.
   */
  findInPaper(input: {
    workId?: number
    documentId?: number
    needle: string
    caseSensitive?: boolean
    limit?: number
    offset?: number
  }): Promise<TextSearchDTO>

  /**
   * A range of a paper's text, by paragraph index or by page.
   *
   * Paged by PARAGRAPH and never by character: a character window would cut a
   * paragraph in half and return a quote that appears nowhere in the paper.
   * Capped at 20 000 characters and 400 paragraphs per call; `truncated` says
   * when the cap bit.
   */
  getPaperText(input: {
    workId?: number
    documentId?: number
    fromIdx?: number
    toIdx?: number
    page?: number
  }): Promise<DocumentTextDTO>

  /**
   * Every paragraph of one document, for anchoring an evidence highlight.
   *
   * The Paper screen searches for a quote inside the paragraph its evidence
   * span names rather than across the whole document, which is what lets a
   * value too short to place document-wide — a table cell of eight canonical
   * characters — be highlighted at all.
   *
   * Deliberately not `getPaperText`: that read is paged for a reader, and a
   * paragraph past its cap silently costs every highlight in it. Empty when the
   * document has no text stage, or when it has two and which one is meant is
   * unknowable.
   */
  paragraphTexts(documentId: number): Promise<ParagraphTextDTO[]>

  /**
   * Name a paper by DOI, arXiv id, PMID or title.
   *
   * `kind` is a hint and defaults to `'auto'`. Auto-detection is genuinely
   * ambiguous — any bare 5-9 digit string looks like a PMID, and a title quoting
   * a DOI looks like that DOI — so a caller that KNOWS what it holds should say.
   *
   * Refuses rather than guesses when several papers match.
   */
  resolvePaper(paperRef: string, kind?: WorkRefKind): Promise<ResolveWorkDTO>

  /** One job by id, in the same shape `listJobs` returns. Null when there is none. */
  getJob(jobId: number): Promise<JobDTO | null>

  /**
   * The pipeline's execution history, filtered.
   *
   * Includes SUPERSEDED runs by default: the history is the point, and a listing
   * that showed only current rows would answer "nothing ever ran" for a paper
   * whose failed extraction was later replaced by a skip.
   *
   * `projectId` matches the STORED value. A work-scoped stage stores the 0
   * sentinel, so filtering by a real project id correctly excludes those unless
   * `includeGlobal` is set — the two questions are different and are kept apart.
   */
  listStageRuns(filter: {
    workId?: number
    documentId?: number
    projectId?: number
    stage?: string
    status?: string
    currentOnly?: boolean
    includeGlobal?: boolean
    limit?: number
    offset?: number
  }): Promise<StageRunPageDTO>

  /**
   * Import a PDF supplied as BYTES, and plan its pipeline.
   *
   * Bytes rather than a path because the caller may not share a filesystem with
   * this app. The file is written into the app-owned library, registered so the
   * pipeline can find it, and the work is linked into the project.
   *
   * IDEMPOTENT by content: importing the same PDF twice returns the first work
   * with `duplicate: true` rather than creating a second one, so a retry after a
   * timeout converges. The bytes must begin `%PDF-` and be at most 64 MB.
   */
  importPdfBytes(input: {
    projectId: number
    bytes: Uint8Array
    fileName: string
    title?: string
  }): Promise<ImportPdfDTO>

  /**
   * Re-run a paper's whole pipeline.
   *
   * `force: false` plans against the STAGE CACHE and will legitimately execute
   * nothing when every stage is current against its inputs — the returned
   * `state` says so, and `superseded_run_ids` is empty. `force: true` discards
   * the paper's current stage runs first, so there is nothing left to hit.
   *
   * `projectId` must be a real project: 0 is the "belongs to no project"
   * sentinel, and planning a project-scoped stage under it would file that stage
   * in a separate `ux_stage_run_current` slot from its real one, leaving two runs
   * current for one key.
   */
  reprocessWork(workId: number, projectId: number, force?: boolean): Promise<RerunResultDTO>

  /**
   * Re-run ONE stage of one paper, across its whole fan-out.
   *
   * The stage is NAMED, never identified by a `stage_run` id: retiring a run
   * re-resolves the run's KEY with no `superseded` check, so an id read in one
   * call and used in another retires whatever holds that key by then — which may
   * be a run the caller never saw.
   *
   * `stage` is a stage id from `listStages()`, and only a paper-scoped one:
   * corpus-scoped stages belong to no paper and are refused by the schema rather
   * than answered with an empty no-op.
   */
  rerunStage(workId: number, stage: string, projectId: number): Promise<RerunResultDTO>

  /**
   * Re-run SEVERAL named stages of one paper, in one transaction.
   *
   * What the Queue's refresh uses, against `StaleWorkDTO.stage_ids`. It exists
   * because the alternative there was `reprocessWork(force)`, which discards
   * every current run of the paper: an edited prompt on one model stage
   * re-fetched the PDF and re-read its text on every affected paper. The
   * cascade from these stages still invalidates everything downstream of them.
   */
  rerunStages(workId: number, stages: string[], projectId: number): Promise<RerunResultDTO>

  // ---- plugins ---------------------------------------------------------------
  //
  // NONE of these is an MCP tool. `listPlugins` would disclose the relay address
  // and username to an agent, and the sharing calls would give one a foothold to
  // discover and publish a corpus. They are registered as plain `ipcMain.handle`
  // in `src/main/index.ts` for that reason, and the registry sweep asserts a
  // channel is never in both places.

  /**
   * Every registered plugin with its declared params, and every one the user has
   * removed. Never a secret VALUE.
   */
  listPlugins(): Promise<PluginListDTO>
  /**
   * Turn a plugin on or off.
   *
   * Refuses while `blockers` is non-empty rather than enabling something that
   * cannot work: the toggle is already disabled in the UI, and main must not
   * trust the renderer to have honoured that.
   */
  setPluginEnabled(pluginId: string, enabled: boolean): Promise<PluginDTO>
  /**
   * Write config. Secrets are WRITE-ONLY: an absent key means "leave alone" and
   * an empty string means "clear", the distinction a user correcting a URL
   * without retyping their password depends on.
   */
  configurePlugin(input: PluginConfigureInputDTO): Promise<PluginConfigureResultDTO>
  /** Probe the configured endpoint once, now. Returns a sentence, never an error. */
  testPluginConnection(pluginId: string): Promise<PluginTestResultDTO>
  /**
   * Run one of a plugin's own setup steps — whatever `setupActions` named.
   *
   * `actionId` is an id the PLUGIN listed and this app merely handed back; it is
   * never a URL, a path or an option the renderer composed. The app knows
   * nothing about what the step does. It resolves with a sentence either way,
   * never rejecting, exactly as `testPluginConnection` does: the step not
   * completing is an answer, and the plugin's own exception is not a thing to
   * put on screen.
   */
  runPluginSetup(pluginId: string, actionId: string): Promise<PluginTestResultDTO>

  /**
   * Open the native folder chooser, then validate and install what was picked.
   *
   * NO PATH ARGUMENT, deliberately. A `installPlugin(path)` method would be
   * "copy any directory on this computer into the app's own folder, chosen by
   * the renderer" — and the renderer is the process this architecture assumes
   * can be compromised. The chosen path exists only inside the main-process
   * handler, between a chooser only the user can operate and the installer.
   *
   * Refusals come back in `reason` as a whole sentence; this never rejects for
   * a bad folder.
   */
  addPluginFromFolder(): Promise<PluginInstallResultDTO>

  /**
   * Open the folder chooser, then replace THIS plugin's code with what was picked.
   *
   * NO PATH ARGUMENT, for the reason `addPluginFromFolder` gives: the chosen path
   * exists only in main, between a chooser the renderer cannot operate and the
   * installer. The id IS a parameter, and it is the safe half of the pair — it
   * names a row the user is looking at, and main refuses a folder declaring any
   * other id rather than trusting this one to match.
   *
   * WHAT SURVIVES: the plugin's configuration, its stored secrets, its data
   * directory, and its enabled state. An enabled plugin is drained, swapped and
   * started again; if the new code reports a blocker it is left OFF with the
   * blocker on its row. A disabled one stays disabled.
   *
   * WORKS ON A PLUGIN THAT CAME WITH THE APP. The new folder is written to the
   * user's own plugins directory — the app's copy is not writable — and is
   * preferred over it from then on. Removing it deletes that copy and the app's
   * own comes back.
   *
   * Refusals come back in `reason` as a whole sentence; this never rejects for a
   * bad folder.
   */
  updatePluginFromFolder(pluginId: string): Promise<PluginInstallResultDTO>

  /**
   * Remove a plugin. Works for one that came with the app as well as one added.
   *
   * Disables and tears it down FIRST, awaiting any in-flight work — a tick, a
   * search, a retrieval — so nothing resumes against a plugin that is gone.
   *
   * WHAT "REMOVE" DOES DIFFERS BY ORIGIN, and only in what happens on disk. An
   * added plugin's folder is deleted. A plugin that came with the app lives
   * inside the installation, is often root-owned and is replaced wholesale by an
   * upgrade, so it is recorded as removed instead: it is never loaded again,
   * across restarts and across updates that re-ship it, and `restorePlugin`
   * brings it back. Deleting it would be the app rewriting its own program
   * directory, and the next update would undo the user's decision anyway.
   *
   * The plugin's own data is KEPT either way, so removing and adding back does
   * not silently destroy a stored credential.
   */
  removePlugin(pluginId: string): Promise<PluginListDTO>
  /**
   * Undo the removal of a plugin that came with the app.
   *
   * It comes back DISABLED whatever it was before: removing it withdrew the
   * user's consent, and restoring is the smaller, separate act of making it
   * available again.
   */
  restorePlugin(pluginId: string): Promise<PluginListDTO>

  // ---- the plugin repository -------------------------------------------------
  //
  // Connecting to a repository installs everything it offers and keeps it up to
  // date, forever, with no browsing and no per-plugin prompt — a repository is a
  // SET, and connecting is taking the set. `REPOSITORY_CONSENT_SENTENCE` is what
  // the user is shown before the key is saved, and it is in the contract because
  // it IS the consent.
  //
  // THE KEY NEVER CROSSES BACK. It goes one way, in `connectRepository`, and the
  // DTO reports only `hasKey` — the same asymmetry `GatewayConfigDTO` has.

  /** The connected repository, or an empty address when there is none. */
  getPluginRepository(): Promise<PluginRepositoryDTO>
  /**
   * Probe an address and key WITHOUT saving either.
   *
   * Before consent on purpose: the user is deciding whether to give this
   * repository authority to install code here, and having to commit the
   * credential first in order to discover a typo trains people to save keys they
   * have not checked. An empty `key` re-uses the stored one, so Test still works
   * on a connected repository whose key the user cannot retype.
   */
  testPluginRepository(input: { address: string; key: string }): Promise<PluginRepositoryTestDTO>
  /**
   * Save the address and key, and apply the whole set at once.
   *
   * THIS IS THE CONSENT. There is no per-plugin prompt afterwards, because a
   * modal in front of a user who has already said yes to the repository stalls
   * an unattended install and teaches them to dismiss whatever appears.
   */
  connectPluginRepository(input: { address: string; key: string }): Promise<PluginRepositoryDTO>
  /**
   * Disconnect: the escape hatch, and the ONLY one.
   *
   * The key is deleted and every `supplier: 'repository'` marking is cleared, so
   * the plugins stay INSTALLED and become ordinary ones — Remove returns and
   * updates stop. Nothing the user depends on breaks at the moment they do it,
   * which is why it is the whole way out: uninstalling them instead would mean
   * escaping one plugin costs every other one with it.
   */
  disconnectPluginRepository(): Promise<PluginRepositoryDTO>
  /**
   * Check now, rather than at the next four-hourly cycle.
   *
   * `false` is the ORDINARY answer to a second press while a cycle is running,
   * not a failure — the same judgement `SyncNowResultDTO` makes.
   */
  syncPluginRepository(): Promise<boolean>

  /** Projects this install shares. Empty on a fresh install, which is ordinary. */
  listShares(): Promise<SharedProjectDTO[]>
  /**
   * Publish a project to the relay and mint its room.
   *
   * DESTRUCTIVE in the registry's sense even though it deletes nothing: it is an
   * irreversible disclosure of a whole corpus to whoever holds the invite.
   */
  shareProject(projectId: number): Promise<ShareResultDTO>
  /**
   * Join a colleague's project from the invitation they sent.
   *
   * Creates a NEW, EMPTY local project and makes it a replica; it never converts
   * one that already exists. Adopting the origin's identity onto a project the
   * user already has would re-key everything in it and publish that work to a
   * room they only meant to read — a disclosure with no undo. The new project
   * appears immediately, marked shared and out of step, and fills in from the
   * next poll.
   *
   * DESTRUCTIVE in the registry's sense, like `shareProject`: joining a room
   * announces this install to everyone else in it, and the invitation is a
   * secret that grants read access to the whole corpus behind it.
   */
  joinProject(input: JoinProjectInputDTO): Promise<SharedProjectDTO>
  /** Stop syncing a project. Local data is untouched. */
  unshareProject(projectId: number): Promise<void>
  /**
   * Run one sync cycle now, because the user asked for it.
   *
   * The verb a plugin in on-demand mode exists for. It resolves when the cycle
   * has finished, so the caller can show a busy control for exactly as long as
   * work is happening rather than guessing at a duration; the resulting share
   * state is read back through `listShares`, which the cycle's own notify has
   * already invalidated.
   *
   * Calling it while a cycle is in flight is not an error and starts NOTHING —
   * the host's one-in-flight latch is the same one the timer obeys. `started`
   * says which happened, so a caller can tell "your click ran a sync" from "a
   * sync was already running", and the button can say so too.
   */
  syncNow(): Promise<SyncNowResultDTO>
  /**
   * Subscribe to sync state moving. Payload-free, like `onJobsChanged`: it means
   * "read the shares again", and a listener that cares about one project is
   * cheaper as a refetch than as a filter kept in step with the write side.
   */
  onSharesChanged(cb: () => void): () => void
}

/**
 * What a re-run did — the discriminator first, because the job ids alone cannot
 * say.
 *
 * - `rerunning` — output was discarded, or jobs were put back on the queue with
 *   nothing left for their fingerprints to match, so work WILL execute.
 * - `already-current` — nothing was discarded and nothing is known to be due to
 *   run. On the un-forced path this is a re-plan against the cache: each job
 *   still decides at claim time whether its inputs changed, so this is "probably
 *   nothing", not a guarantee — pass `force` for one.
 * - `no-current-runs` — there was nothing current to act on. Three situations
 *   share it, distinguished by `note`: the named stage never ran for this paper;
 *   the paper has no runs at all (which may mean a first run was just planned);
 *   or every run resolved was retired by someone else before it could be used,
 *   in which case the remedy is to call again.
 * - `already-queued` — the work was outstanding already, and was adopted rather
 *   than duplicated.
 * - `queued-but-paused` — planned, but the queue is not claiming work; these
 *   jobs sit until it is resumed.
 * - `not-in-project` — the paper is real and is not in that project.
 */
export type RerunState =
  | 'rerunning'
  | 'already-current'
  | 'no-current-runs'
  | 'already-queued'
  | 'queued-but-paused'
  | 'not-in-project'

export interface RerunResultDTO {
  state: RerunState
  /** The same answer in a sentence, naming the real counts rather than a plausible one. */
  note: string
  /**
   * The runs whose output was DELETED.
   *
   * The only honest proof that anything must now be redone. A job id list is
   * not: the planner returns adopted jobs as readily as new ones, and a re-armed
   * job whose input fingerprint is unchanged settles straight back to done
   * without ever running its stage.
   */
  superseded_run_ids: number[]
  /** Runs that were current when resolved and retired before they could be used. Skipped, never followed. */
  stale_run_ids: number[]
  /** Jobs this call INSERTED. */
  created_job_ids: number[]
  /** Jobs put back on the queue: executors fenced out by the retirement, and dependents cancelled by an upstream failure. */
  requeued_job_ids: number[]
  /** Of everything this call planned, the jobs that have not reached a terminal status — what there is to poll. */
  pending_job_ids: number[]
  /** Every job the pipeline now consists of, created or adopted. */
  all_job_ids: number[]
  /** The projects re-planned. More than one means the invalidation crossed projects. */
  planned_project_ids: number[]
  /** False means the queue is paused and none of these jobs will start until it resumes. */
  queue_running: boolean
}

// ---------------------------------------------------------------- tabs

/** One page a window has open. */
export interface TabDTO {
  /** Identity, from the shared `tabKey` rules. Unique within a window. */
  key: string
  route: Route
  projectId: number | null
  title: string
  /**
   * Bumped every time this tab is opened INTO rather than created.
   *
   * The screens' focus handling is one-shot and latched on the id it focused, so
   * following "Evidence →" twice to the same span would appear dead. Including
   * this in those effects' dependencies is what makes them re-run.
   */
  focusNonce: number
  /** The renderer's own snapshot: scroll, find query, sub-tab, PDF page. */
  viewState?: string | null
  /**
   * Why this tab's target no longer exists, or absent while it does.
   *
   * A deleted paper or project is MARKED, never auto-closed: silently removing a
   * page the user opened is worse than showing them what happened to it.
   */
  stale?: string
  /**
   * This tab is on its way to a new window, and has not arrived yet.
   *
   * Detach is a two-phase handover: the tab STAYS here, marked, until the new
   * window claims it, so that a window which fails to open reverts the move
   * instead of destroying the page. While this is set the tab renders as
   * leaving and cannot be closed — closing it mid-flight would be the one way to
   * lose it for good.
   */
  detaching?: boolean
}

export interface WindowTabsDTO {
  tabs: TabDTO[]
  activeKey: string
  /** The version an op must match to be accepted. See `tabsOpen`. */
  rev: number
}

/**
 * The outcome of a tab op, ALWAYS carrying the model's current rev.
 *
 * The rev on a REJECTION is what makes the versioning self-correcting rather
 * than merely strict: a renderer whose `tabs:changed` push was dropped would
 * otherwise hold a stale rev that nothing would ever fix, since only a mutation
 * pushes, and every op it made from then on would be rejected forever. So a
 * rejection is never retried blind — it is RESYNCED from the rev it returns.
 */
export interface TabOpResultDTO {
  ok: boolean
  rev: number
}

export interface TabOpenResultDTO {
  /** Which window answered, so a caller can tell a move from a local open. */
  windowId: number
  /**
   * The key that now exists, or null when the op was REJECTED on a stale rev.
   *
   * Null rather than the key it would have been: a result shaped like a success
   * would have the strip draw a tab that does not exist, and every later op on
   * that key would then fail with nothing to explain why.
   */
  key: string | null
  /** The model's rev AFTER the op, so a rejected caller can resync at once. */
  rev: number
  /** Whether this focused an existing tab rather than creating one. */
  focusedExisting: boolean
  /**
   * Other windows that already hold this page.
   *
   * For a non-blocking HINT on the tab — the one exceptional case where a badge
   * is warranted, because "also open elsewhere" is not the ordinary state.
   */
  alsoOpenIn: number[]
}

export type QuitPhase = 'idle' | 'asking' | 'finishing'
export type QuitChoice = 'cancel' | 'now' | 'finish'

export interface QuitStateDTO {
  phase: QuitPhase
  /** Papers being read right now (queue jobs + directly-run analyses). */
  busy: number
  /** Milliseconds since the `finishing` wait began; 0 in other phases. */
  elapsedMs: number
}

// ---------------------------------------------------------------- MCP connector
// Owned by workstream A. Keep contiguous.

/** Which client the pasted config block is for. */
export type McpClientVariant = 'claude' | 'vscode' | 'stdio'

/**
 * The MCP server's live state.
 *
 * Polled every 2s by the Settings pane while the server is not stopped — so
 * assembling it must read no DB, and it deliberately carries no token.
 *
 * `lastError` is a CLOSED ENUM, not free text. Free text assembled from a
 * request would be the one field on this DTO that could carry a credential into
 * a payload the renderer receives twenty times a minute; a scrubber over it
 * would be a control that has to be right every time rather than a shape that
 * cannot be wrong.
 *
 * `internal` is the member with nothing to say — "The server could not start."
 * names no remedy — so a cause that HAS one gets a member of its own rather than
 * being flattened into it. Two did: an audit folder that will not accept a write
 * and an existing token file that cannot be read. Both throw excellent sentences
 * naming one action, and both reached the user as stderr nobody reads. The
 * REMEDY travels as an enum member, never as the exception's text, so the
 * renderer still owns every word and no path (which carries the OS username) or
 * errno can ride along.
 */
export type McpFailure =
  | 'port-in-use'
  | 'bind-failed'
  | 'permission-denied'
  | 'origin-refused'
  | 'host-refused'
  /** The audit log could not be opened, so no call could have been recorded. */
  | 'audit-unwritable'
  /** A token file exists and cannot be read; minting over it would rotate it. */
  | 'token-unreadable'
  | 'internal'

export interface McpStatusDTO {
  enabled: boolean
  state: 'stopped' | 'starting' | 'listening' | 'stopping' | 'failed'
  bind: '127.0.0.1' | '0.0.0.0'
  /**
   * The port the user asked for and that IS persisted — what the input edits.
   *
   * Distinct from `boundPort` on purpose. When the configured port is taken the
   * server scans forward, and that scanned port must never be written back:
   * a second instance of the app (`npm run shot` launches one) would otherwise
   * silently repoint the config the user's agent is holding.
   */
  configuredPort: number
  /** The port actually listening, or null when it is not. May differ from above. */
  boundPort: number | null
  /** True when ANY persisted option has changed since the running server bound. */
  pendingRestart: boolean
  /**
   * Which option is pending, so a control marks itself and not its neighbours.
   *
   * The aggregate flag alone made the network-exposure switch read "pending"
   * when the user had only changed the port — a claim about a setting they had
   * not touched.
   */
  pendingBind: boolean
  pendingPort: boolean
  /** Every URL this server can be reached on. Loopback first, always. */
  urls: string[]
  /** Real, non-internal IPv4s on this machine. Empty is a legitimate state. */
  lanAddresses: string[]
  /** Whether write tools are offered. Default ON. */
  allowWrite: boolean
  /** Whether delete/outlet-write tools are offered. Default OFF. */
  allowDestructive: boolean
  hasToken: boolean
  /** Agent calls executing right now. */
  inFlight: number
  callsThisSession: number
  /**
   * When an agent last actually called something, and what.
   *
   * The user's real question after pasting a config is "did it work?", and
   * nothing else on this screen answers it.
   */
  lastConnectedAt: string | null
  lastToolCalled: string | null
  lastError: McpFailure | null
  /** How many tools the current permission level exposes. */
  toolCount: number
}

// --- paper text, resolution and stage runs (owned by workstream D) ---------
//
// Everything below reads what the pipeline already produced. It is on the
// CONTRACT and not private to the MCP layer because the app needs it too: the
// find bar lives inside the PDF viewer, so a paper whose PDF will not render
// cannot currently be searched at all even though its text is in the database.

/**
 * Why a document's text could not be read. `ok` is the only readable state.
 *
 * Five states and not one, because the remedies differ: `no-document` means
 * nothing was ever ingested for this paper, while `no-text` means the file is
 * here and has not been through the pipeline yet. Telling a user to ingest a PDF
 * they are looking at is worse than saying nothing.
 */
export type DocumentTextState =
  | 'ok'
  | 'no-document'
  | 'no-text'
  | 'empty-text'
  /** Two live paragraph inventories. Which text is current is genuinely unknown. */
  | 'ambiguous-text'

/** One paragraph of a document, as the pipeline published it. */
export interface DocumentParagraphDTO {
  para_id: string
  /** Position in the document. The unit `fromIdx`/`toIdx` page by. */
  idx: number
  /**
   * Offsets into the document's canonical text.
   * `canonicalText.slice(char_start, char_end)` is exactly `text`.
   */
  char_start: number
  char_end: number
  page: number | null
  kind: string
  section: string
  text: string
}

export interface DocumentTextDTO {
  state: DocumentTextState
  /** The document actually read — a work may hold more than one. */
  document_id: number | null
  /**
   * The paragraph inventory these came from.
   *
   * Retiring a stage run DELETES its paragraphs, so a second page fetched after
   * a re-extraction is text with different offsets. Comparing this between pages
   * is how a caller notices; it is not decoration.
   */
  stage_run_id: number | null
  /** The document's content status, so `no-text` can be explained rather than asserted. */
  content_status: string | null
  paragraphs: DocumentParagraphDTO[]
  /** Every paragraph matching the filter, not just those returned. */
  total_paragraphs: number
  truncated: boolean
}

/** One paragraph's text, keyed by the index an evidence span cites. */
export interface ParagraphTextDTO {
  /** `document_paragraph.idx` — what `EvidenceSpanDTO.paragraph` refers to. */
  idx: number
  text: string
}

/** One literal match inside a paper. */
export interface TextHitDTO {
  para_id: string
  idx: number
  page: number | null
  kind: string
  section: string
  /** Document-canonical offsets — the same space an evidence span anchors in. */
  char_start: number
  char_end: number
  /** The matched text as the document holds it, not as it was typed. */
  quote: string
  before: string
  after: string
}

export interface TextSearchDTO {
  state: DocumentTextState
  document_id: number | null
  stage_run_id: number | null
  content_status: string | null
  hits: TextHitDTO[]
  /**
   * Matches counted, which is a FLOOR and not always the total.
   *
   * Counting stops shortly past what this page could return: an exact count for
   * a common word in a long paper means tens of thousands of regex executions on
   * the main thread, and the window stops repainting while they run. When
   * `truncated` is true, read this as "at least this many".
   */
  total: number
  /** True when matches remain beyond this page. */
  truncated: boolean
}

export type WorkRefKind = 'doi' | 'arxiv' | 'pmid' | 'title' | 'auto'

export interface WorkCandidateDTO {
  work_id: number
  title: string
  year: number | null
  doi: string | null
  matched_by: 'doi' | 'identifier' | 'exact-title' | 'normalized-title' | 'title-search'
}

/**
 * The result of naming a paper.
 *
 * `ambiguous` is the reason this exists. Two papers whose titles normalise
 * alike are a real occurrence, and a resolver that picked one would hand back an
 * id every caller then writes against — silently, and against the wrong paper.
 */
export type ResolveWorkDTO =
  | { state: 'resolved'; work_id: number; matched_by: WorkCandidateDTO['matched_by']; candidate: WorkCandidateDTO }
  | { state: 'not-found'; suggestions: WorkCandidateDTO[] }
  | {
      state: 'ambiguous'
      candidates: WorkCandidateDTO[]
      /**
       * True when MORE candidates matched than are listed.
       *
       * Carried because "exactly ten matches" and "at least eleven" are
       * different situations for a caller deciding whether narrowing the query
       * could help, and a truncated list alone cannot tell them apart.
       */
      more: boolean
    }
  | { state: 'invalid'; reason: string }

/**
 * One execution of one pipeline stage.
 *
 * `superseded` is never omitted: a retired run's output is still in the database
 * and reads exactly like current output without it.
 */
export interface StageRunDTO {
  id: number
  stage: string
  stage_version: string
  work_id: number
  document_id: number
  /** 0 is the GLOBAL sentinel, not "unset" — a work-scoped stage stores 0. */
  project_id: number
  schema_id: number
  /** Which key of a fanned-out stage this run is. `''` when it does not fan out. */
  fanout_key: string
  status: string
  outcome_note: string | null
  error: string | null
  model: string | null
  prompt_version: string | null
  schema_version: string | null
  analysis_run_id: number | null
  superseded: boolean
  superseded_by: number | null
  duration_ms: number | null
  created_at: string
  finished_at: string | null
}

export interface StageRunPageDTO {
  items: StageRunDTO[]
  /** A true COUNT(*) over the filter, never `items.length`. */
  total: number
  limit: number
  offset: number
}

/** What an import of PDF bytes did. */
export interface ImportPdfDTO {
  work_id: number
  document_id: number
  /**
   * True when these exact bytes were already in the library.
   *
   * The existing ids are returned rather than a second work, so a retried import
   * converges. The work is still linked into the requested project — the same
   * PDF legitimately belongs to two projects.
   */
  duplicate: boolean
}
