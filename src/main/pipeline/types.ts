// The stage contract. Normative: everything else in src/main/pipeline exists to
// serve these types, and a new stage is one file exporting one StageDefinition
// plus one line in stages/index.ts.
//
// Nothing here imports electron, so CLI scripts (`seed`, `verify:*`) can import
// the registry without loading a native runtime.

import type { DB } from '../db/connection'
import type { ModelSettings } from '../llm/modelSettings'
import type { PendingReview } from '../llm/review'
import type { SummaryKind, SummaryResult } from '../llm/summary'

/**
 * A capability token: `<name>@<version>`.
 *
 * Dependencies are declared against these, never against stage ids. That is
 * what makes inserting a stage between two existing ones a one-file change:
 * `segment` requires `text.pages@v2` and does not care whether `extract-text`
 * or a later `ocr` transformer produced it.
 *
 * The version suffix is part of the token because a token names a SHAPE, not a
 * table. When a producer starts emitting per-item geometry it provides
 * `text.pages@v2`; a consumer still requiring `@v1` then fails AT BOOT with the
 * token named, instead of its author quietly widening the producer.
 *
 * The union is documentation, not a closed set — `(string & {})` keeps the
 * literals in autocomplete while letting a new stage mint a token without
 * editing this file.
 */
export type Capability =
  | 'document.file@v1'
  | 'text.pages@v2'
  | (string & {})

export type StageScope = 'document' | 'project' | 'corpus'

/**
 * Every token a stage READS — required and optional alike.
 *
 * Ordering, dependency edges, `ctx.input` resolution, fingerprinting and
 * downstream retirement all ask this question, and for all of them an optional
 * input behaves exactly like a required one: it must be provided by somebody,
 * this stage must run after that somebody, and a change in it must reopen this
 * stage's answers. Only `upstreamSatisfied` distinguishes the two, and it asks
 * `requires` directly.
 *
 * Defined here rather than in each caller so adding a third kind of input is
 * one edit, not eight — and so no caller can quietly forget the optional half,
 * which is how an enrichment would become invisible to invalidation.
 */
export function inputsOf(stage: {
  readonly requires: readonly Capability[]
  readonly enriches?: readonly Capability[]
}): readonly Capability[] {
  return stage.enriches && stage.enriches.length > 0
    ? [...stage.requires, ...stage.enriches]
    : stage.requires
}

/**
 * What a stage did. Only `failed` is an error.
 *
 * The distinction between `empty` and `failed` is load-bearing and is the
 * reason this is a union rather than a boolean: a stage that legitimately found
 * nothing (a supplement with no bibliography) and a stage whose parser broke
 * must not be the same state. `empty` is cached and satisfies dependents, so a
 * bug wearing its clothes would leave a paper permanently and silently blank.
 */
/**
 * What a stage used to produce its answer, stamped onto its `stage_run`.
 *
 * Provenance on every AI result is a hard rule, and a stage that reaches a model
 * is an AI result. Recording it on the RUN (not only on a downstream
 * `analysis_run`) is what lets "which model produced this stage's output" be
 * answered for stages that write no analysis at all — `citation-contexts` writes
 * `citation_context` rows, not analyses, and its roles are just as model-derived.
 */
export interface StageProvenance {
  model?: string
  promptVersion?: string
  schemaVersion?: string
  /** Set when the stage's real output IS an analysis_run. */
  analysisRunId?: number
}

export type StageOutcome<T = unknown> =
  | { status: 'succeeded'; result: T; note?: string; provenance?: StageProvenance }
  /**
   * Ran correctly; there was legitimately nothing. Terminal, cached, satisfies
   * dependents — and sets the JOB to `review`, not `done`, because an empty
   * result is a claim about the paper a human may want to check.
   *
   * `reason` is REQUIRED and is validated non-empty by the scheduler: an
   * unexplained `empty` is indistinguishable from a swallowed bug, and it is
   * the one outcome that is both invisible and permanent.
   */
  | { status: 'empty'; reason: string }
  /** A precondition is absent (no PDF, no text layer). Terminal, cached. */
  | { status: 'skipped'; reason: string }
  /**
   * The stage was NOT NEEDED, and that is a success.
   *
   * DISTINCT from `skipped`, which means something the stage needed was absent
   * — no PDF, no text to segment, no model packaged. That is a gap, and a user
   * looking at a half-processed paper may want to close it. This is the
   * opposite: the work was already done or was never applicable, so the right
   * outcome was to do nothing. OCR on a PDF that already has a text layer is
   * the canonical case — running it would have produced WORSE text, so
   * declining is the stage succeeding at its job.
   *
   * It reports as `succeeded` everywhere downstream: same DB status, same green
   * dot, same non-notice. Distinguishing it in the UI would put an explanation
   * under a paper where nothing went wrong and nothing is the user's to do,
   * which across a corpus becomes a wall of paragraphs announcing non-events.
   * `reason` is still recorded on the run, so "why did OCR not run" remains
   * answerable for anyone who asks.
   */
  | { status: 'not-needed'; reason: string }
  /**
   * A correct, deliberate refusal that must stop the pipeline for this work
   * (a licence check, a user policy). Terminal, cached, and CANCELS dependents
   * — but it is not an error and must not paint the pipeline red.
   */
  | { status: 'refused'; reason: string }
  /** Broke. `retryable: false` => permanent. */
  | {
      status: 'failed'
      error: string
      retryable: boolean
      /**
       * How long the SERVER asked us to wait, in ms, when it said so.
       *
       * Honoured over the scheduler's own exponential backoff. A rate limiter
       * naming a 15-minute window is not something four exponential retries can
       * outlast: without this a job burned its entire attempt budget inside the
       * first minute and failed, reporting a temporary rate limit as a dead end.
       *
       * Waited out HERE, at the job level, rather than inside the provider's
       * retry loop — that loop runs inside the single process-wide LLM slot, so
       * sleeping there would stop every other paper in the app as well.
       */
      retryAfterMs?: number
    }

export interface FanOutKey {
  /** Stable discriminator, stored on the job and in `stage_run.fanout_key`. */
  key: string
  /** Optional FK the job row carries natively (e.g. extraction_schema.id). */
  schemaId?: number
  label?: string
}

export interface StagePlanContext {
  /** Read-only by convention; the planner already holds a write transaction. */
  db: DB
  workId: number
  documentId: number
  /** 0 = global. */
  projectId: number
}

/**
 * The database a stage may touch.
 *
 * Deliberately NOT `DB`. A stage that wrote `FROM document_paragraph` by hand
 * would match every inventory in the table, including the one a transformer
 * superseded, and produce colliding ids — and fixing that per-consumer is
 * exactly the edit-your-neighbours coupling capabilities exist to remove. So
 * the raw handle never enters `StageContext`: reads go through `ctx.input`,
 * writes through `ctx.write`, and this interface exposes only the narrow
 * lookups a stage legitimately needs about its own subject.
 *
 * A grep rule alone would not do it — `FROM  document_paragraph`, a JOIN, an
 * alias or a template literal all evade one — so the boundary is the TYPE, and
 * the grep in verify:offline is a second net rather than the mechanism.
 */
export interface StageReadDb {
  /** The stage's own work row, or null. */
  work(): { id: number; title: string; abstract: string | null } | null
  /** The stage's own document row, or null when the stage is not document-scoped. */
  document(): { id: number; work_id: number; content_status: string | null } | null
  /** Absolute path + base dir for the stage's document, validated inside base_dir. */
  pdfPath(): { baseDir: string; relativePath: string; absPath: string } | null
  /**
   * The stage's own work's identifiers (doi, arxiv, pmid, url, …).
   *
   * Metadata about the subject, in the same class as `work()` and `document()`
   * rather than in the class `ctx.input` governs: nothing produces it, no run
   * owns it, so there is no superseded-run ambiguity to resolve. `retrieve`
   * needs it because a DOI is the only thing that identifies a paper to a
   * source that might hold its PDF.
   */
  identifiers(): Array<{ scheme: string; value: string }>
  /**
   * `document.retrieval_status` for the stage's own document.
   *
   * Read separately from `document()` because it is the one column whose value
   * is a claim about what the app has ALREADY TRIED, and `retrieve` must not
   * overwrite an answer a real fetch already produced.
   */
  retrievalStatus(): string | null
  /**
   * Every work in the library, shaped for reference matching.
   *
   * A first-class lookup rather than something a stage reaches for a handle to
   * do, because "does this bibliography entry name a paper we already have" is
   * inherently a question about the WHOLE corpus and cannot be expressed as an
   * upstream capability of one document. It is metadata, never bulk stage
   * output, so it carries none of the superseded-run ambiguity `ctx.input`
   * exists to resolve.
   */
  corpus(): CorpusWorkRow[]
  /**
   * Every citing passage still awaiting a two-sided verification.
   *
   * A first-class lookup for the same reason `corpus()` is one: "which passages
   * in the whole library have not been checked against the paper they name" is
   * inherently a question about the CORPUS, and cannot be expressed as an
   * upstream capability of any one document. It is a join over rows another
   * stage already committed, never bulk output of a superseded run — the
   * ambiguity `ctx.input` exists to resolve does not arise.
   */
  citationCandidates(promptVersion: string): CitationCandidateRow[]
  /**
   * Every question this work's current extractions still owe an answer to.
   *
   * A first-class lookup for the same reason the two above are: building the
   * questions reads the schema, the document's paragraphs and the values other
   * papers recorded for the same field — none of which is expressible as an
   * upstream capability of one document — and it must exclude the rows a
   * superseded run owns, which a stage writing its own SQL would get wrong.
   */
  pendingReviews(promptVersion: string): PendingReview[]
  /**
   * Which model each kind of work uses, and how much room it has.
   *
   * Read HERE rather than captured when the scheduler was built, so a change in
   * Settings reaches the next stage that runs instead of the next launch.
   */
  modelSettings(): ModelSettings
  /**
   * This install's polite-pool contact address, for a stage that asks a public
   * index a question.
   *
   * Here, beside `modelSettings()`, for the same reason that one is: it is the
   * APP'S configuration rather than anything about the paper, it is generated
   * and stored in `setting`, and a stage may not open a database to read it.
   *
   * NOT A COURTESY. Measured against Crossref over 25 bibliography lines: an
   * anonymous caller was rate-limited on 12 of them and, even paced at 120 ms,
   * on 7; the same 25 with `mailto` set answered 25 of 25 at both paces. So
   * without this a stage that reads a bibliography records "no index could be
   * reached" across half a paper's references — an untrue claim about those
   * papers, produced by leaving one query parameter off.
   */
  contactEmail(): string
  /**
   * An abstract an earlier reference already obtained for the SAME paper, by
   * the printed identity `askKeyFor` derives. Null when nobody has asked yet.
   *
   * A first-class lookup because the alternative is a stage opening a database,
   * which this interface exists to forbid. It earns its place on the numbers:
   * one paper is cited by many of ours and stored once per bibliography, so 571
   * reference lines in this corpus name only 405 distinct papers and the
   * most-cited appears in ten of the twenty-three. Without it every one of those
   * ten costs a request against a rate limit shared with every future import.
   *
   * The version is part of the question. A row admitted under a different
   * matching rule is not evidence about what this build would decide, so asking
   * for one without saying which rule you are running is asking to inherit a
   * withdrawn gate's mistakes.
   */
  reusableAbstract(askKey: string, fetcherVersion: number): { doi: string | null; matchedTitle: string | null; abstract: string; source: 'crossref' | 'openalex' | null } | null
  /**
   * Every project's papers with the text to score them on and the size of the
   * bibliography each printed.
   *
   * A first-class lookup for the reason `corpus()` is one: it is a join plus two
   * correlated counts, and a stage assembling that from raw SQL is what this
   * interface exists to prevent. It has to be one call rather than a work
   * lookup per paper because expansion priority is normalised ACROSS a project
   * — the denominator is the largest bibliography in the set, so no paper can
   * be scored without seeing its neighbours.
   */
  scoringSets(): Array<{
    projectId: number
    description: string | null
    works: Array<{
      workId: number
      title: string
      abstract: string | null
      inclusionStatus: string | null
      unmatchedReferences: number
      referenceRelevances: number[]
    }>
  }>
  /**
   * The research question this stage's own job is running under, and the project
   * it belongs to. Null when the job is not scoped to a real project, or when
   * that project has not written down what it is for.
   *
   * A first-class lookup for the reason `modelSettings()` is one: it is the
   * project's configuration rather than anything about the paper, and a stage
   * may not open a database to read it. It returns the ID ALONGSIDE the text
   * because anything scored against this question has to record whose question
   * it was — a paper sits in as many projects as the user puts it in, and a
   * score stored without its project reads as a fact about the paper.
   *
   * BLANK IS NULL, deliberately. A project that has not said what it is for has
   * not said what relevance would MEAN, and scoring against an empty string
   * produces a column of confident-looking numbers measuring nothing.
   */
  projectQuestion(): { projectId: number; question: string } | null
  /**
   * The stage's own work as a CITABLE record: type, year, venue, authors in order.
   *
   * A first-class lookup for the same reason `corpus()` is one — it is a join
   * across `work` and `work_author`, and a stage assembling that from raw SQL is
   * what this interface exists to prevent. `work()` deliberately carries only
   * what most stages need (title, abstract); this is for the one job that hands
   * a whole bibliographic entry to another application, where a dropped author
   * or a wrong year is a defect the user sees in their own reference library.
   */
  bibliographicRecord(): BibliographicRecord | null
  /**
   * Where this project sends new papers, or null when it does not.
   *
   * Read HERE rather than captured at dispatch, for the same reason
   * `modelSettings()` is: the user can connect or disconnect while a queue is
   * draining, and a stage should act on what is configured when it runs rather
   * than on what was true when the job was claimed.
   */
  zoteroConnection(): { targetId: string; targetName: string } | null
}

/** A work as another reference manager needs it. */
export interface BibliographicRecord {
  title: string
  workType: string
  year: number | null
  venue: string | null
  /** In `work_author.position` order. `family` is null when only a display name is known. */
  authors: Array<{ full: string; given: string | null; family: string | null }>
}

/** One unverified citing passage, with everything the pair needs to be judged. */
export interface CitationCandidateRow {
  contextId: number
  citingWorkId: number
  citedWorkId: number
  citedTitle: string
  citedYear: number | null
  /** Bibliography ordinal the callout named, e.g. 17 for `[17]`. */
  ordinal: number | null
  /** The healed passage around the callout. Never null — the query requires it. */
  sentence: string
  section: string | null
  page: number | null
  /**
   * Where the marker sits inside `sentence`, so the prompt can point at it
   * EXACTLY rather than by re-finding a bare number that occurs several times.
   *
   * Null on rows written before the scanner recorded it, and on passages whose
   * marker could not be pinned through sentence healing. Both mean the same
   * thing to a consumer: mark nothing rather than mark the wrong token.
   */
  markerInSentence: number | null
  /** The callout site in the CANONICAL DOCUMENT text — a different space. */
  calloutOffset: number | null
  calloutEnd: number | null
  /** The printed bibliography line this callout resolved through, when kept. */
  rawBibText: string | null
  /** How many embedded blocks the cited paper HAS. 0 => unverifiable. */
  citedChunkCount: number
}

export interface CorpusWorkRow {
  work_id: number
  title: string
  year: number | null
  doi: string | null
  venue?: string | null
  author_surnames: string[]
}

export interface AnalysisRequest {
  /** One of `analysis_run`'s closed 7-value type enum. */
  analysisType: string
  docText: string
  /** 0/null = the generic prompt; a real id renders that schema's field list. */
  schemaId?: number | null
  /**
   * Ask about these field keys ONLY, keeping the current run's values for every
   * other field. Null/absent is the ordinary whole-schema read. See
   * `PipelineInput.onlyFields`.
   */
  onlyFields?: string[] | null
  documentId?: number | null
  /**
   * Regions of the page the model should READ, when the text layer garbles them.
   *
   * A table's characters are not a faithful record of it. The crop is the source
   * for the VALUE; the paragraph text stays the source for WHERE it sits, so a
   * fact is still cited by [pN] and still checked against the text.
   */
  images?: Array<{ png: Buffer; caption?: string }>
  /**
   * The `document_paragraph.idx` behind each [pN] of `docText`.
   *
   * Required of any caller that sends a SUBSET of the document, because the
   * anchor it gets back is numbered in that subset and is read again against
   * the whole. See `PipelineInput.paragraphIndexMap`.
   */
  paragraphIndexMap?: number[] | null
}

export interface AnalysisResult {
  analysisRunId: number
  factCount: number
  evidenceCount: number
  model: string
  /**
   * Claims the model made that could not be pointed at a passage, and were
   * therefore discarded rather than stored. A stage reports this so the loss is
   * visible: without it, a run that kept ten facts and one that kept ten while
   * throwing twenty away describe themselves identically.
   */
  droppedUnanchored: number
  /** Measurements discarded for belonging to no field of the target schema. */
  droppedOffSchema: number
  /**
   * Measurements refused because their unit is dimensionally incompatible with
   * the unit the field declares — an energy offered for a field of rates. Kept
   * separate from `droppedOffSchema` because the causes ask for different
   * answers: one means the schema does not want this value, the other means the
   * model mislabelled a value the schema might well want under another field.
   */
  droppedWrongDimension: number
  /**
   * Point values withdrawn because the text they came from is a bound whose
   * comparator the PDF text layer destroyed (`>95` extracted as `N 95`). The
   * raw text is untouched; only the derived number was withdrawn.
   */
  demangledBounds: number
  /** True when the MODEL returned nothing, as opposed to us discarding it. */
  modelReturnedNothing: boolean
  /**
   * Tables the model says it read only in part, in its own words.
   *
   * Empty is the ordinary case and means the reading was complete. A stage puts
   * these in its note because a partial table and a small table are otherwise
   * indistinguishable — same count, same evidence, same appearance of care.
   */
  shortfalls: string[]
}

export interface LlmHandle {
  /**
   * The model that will answer, for the stage to stamp on its provenance.
   *
   * Exposed because a stage that reaches a model owes an answer to "which
   * one" — and it cannot ask the provider directly, since `ctx.llm` is
   * deliberately the only thing it can see.
   */
  readonly model: string
  /**
   * The ONLY way to reach an LLM. Serialized process-wide behind a size-1 FIFO
   * gate; `StageContext` exposes no other network primitive.
   *
   * `images` carries page crops for the same reason `runAnalysis` does: a
   * table's text layer is not a faithful record of it, so a stage whose job is
   * to READ a value — or to check one already read — must be able to see the
   * page. Only an `inline` stage can send them; the host channel carries no
   * image field, because a Buffer does not survive its JSON hop intact.
   */
  call(
    messages: Array<{
      role: 'system' | 'user' | 'assistant'
      content: string
      images?: Array<{ png: Buffer; caption?: string }>
    }>,
    opts?: { model?: string; maxTokens?: number }
  ): Promise<string>
}

/** One block of a paper, as a semantic search returns it. */
export interface SemanticBlock {
  chunkId: number
  workId: number
  documentId: number
  page: number | null
  section: string
  text: string
  /** Cosine SIMILARITY in [-1, 1]; higher is nearer. */
  score: number
  /** The chunk was too short, or truncated, to be fully trusted. */
  lowConfidence: boolean
}

export interface SemanticResult {
  blocks: SemanticBlock[]
  /**
   * Which space answered. A caller comparing two result sets must check it —
   * a cosine between vectors from different spaces is a number, not an error.
   */
  spaceId: number
  /**
   * How the blocks were ranked. `exhaustive` means every passage in the scope
   * was compared, which is what a single-paper scope always gets and is the
   * more accurate of the two — a stage must not report it as a degradation.
   */
  strategy: 'index' | 'exhaustive'
}

/**
 * Finding the passages of a paper that MEAN something, by vector search.
 *
 * On the context rather than imported, for the same reason `ctx.llm` is: a stage
 * must not be able to open a database or start a worker of its own. The handle
 * runs the query in the existing READ-ONLY worker thread, off the thread that
 * draws the window — better-sqlite3 is synchronous, and a main-thread k-NN plus
 * an ONNX forward pass measured a 115 ms freeze at the stress scale.
 *
 * Null on the context when no worker was provisioned (a CLI, a build without the
 * bundled worker). A stage that needs it returns `skipped` and SAYS so; it never
 * silently produces the half of its answer that needs no search, because a
 * one-sided result presented as a whole one is the failure the type is shaped to
 * prevent.
 */
export type SemanticHandle = (
  text: string,
  k: number,
  workIds?: number[]
) => Promise<SemanticResult>

export interface StageContext {
  readonly workId: number
  readonly documentId: number
  /** 0 sentinel = global. */
  readonly projectId: number
  readonly fanOut: FanOutKey | null
  readonly stageRunId: number
  readonly jobId: number
  /** Aborts on cancel, pause-with-abort, and app quit. Check it in every loop. */
  readonly signal: AbortSignal
  readonly llm: LlmHandle
  /** Vector search over the corpus, or null when none was provisioned. */
  readonly semantic: SemanticHandle | null
  readonly db: StageReadDb
  /**
   * Queue a bulk write, as DATA rather than as a closure.
   *
   * QUEUED, not executed: every payload registered here is handed to this
   * stage's own `applyWrites` inside the ONE `.immediate()` transaction that
   * also writes the terminal `stage_run` row. They commit together or not at
   * all — running the bulk write eagerly and the terminal record afterwards
   * would make "the blast radius of any stop is one stage" false, because a
   * kill between the two discards completed work on resume.
   *
   * DATA, not a closure, because a stage body may execute in a host process
   * that has no database at all (`isolation: 'host'`). A closure cannot cross
   * that boundary; a JSON payload can. Keeping ONE shape for both isolations is
   * what stops the host pool forking the stage contract in two — the same
   * `execute` runs unchanged wherever it is dispatched.
   *
   * It returns nothing: a value read back from a write that has not committed
   * yet would be a lie the caller could act on. Payloads are applied in
   * registration order.
   */
  readonly write: (payload: unknown) => void
  /**
   * The value produced for a required capability by the provider current AS OF
   * THIS STAGE'S POSITION in the resolved order — not the global last provider,
   * which for a transformer would resolve to its own not-yet-written output.
   *
   * Resolution walks BACKWARDS through the provider chain: a transformer that
   * declined to run (`skipped`) is transparent, so `segment` still sees
   * `extract-text`'s pages when `ocr` had nothing to do. Without that fall-
   * through every no-op transformer would starve the whole pipeline behind it.
   *
   * Returns `undefined` when no provider in the chain produced anything. A
   * stage that needs an absent input returns `skipped`; it never throws.
   */
  readonly input: <T>(cap: Capability) => T | undefined
  /** Publish this stage's output for a capability it provides. */
  readonly emit: (cap: Capability, value: unknown) => void
  readonly progress: (pct: number, note?: string) => void
  readonly log: (msg: string) => void
  /**
   * Run the full analysis pipeline: prompt, model, validate, persist with
   * provenance, superseding the previous current run in ONE transaction.
   *
   * A NAMED operation rather than something a stage assembles, because the
   * supersede-then-insert across five tables IS the one-current-run invariant,
   * and there must be exactly one implementation of it. It is on the context
   * rather than imported directly so a host-isolated stage would RPC it back to
   * main instead of opening a database — the boundary holds either way.
   *
   * It commits separately from the stage's own terminal record; a stage using
   * it therefore reports the `analysis_run_id` in its provenance so the chain
   * is still followable.
   */
  readonly runAnalysis: (req: AnalysisRequest) => Promise<AnalysisResult>
  /**
   * Write one of the work's two prose summaries, with full provenance.
   *
   * On the context for exactly the reasons `runAnalysis` is: `generateSummary`
   * performs the supersede-then-insert across `analysis_run` and `work_summary`
   * in one transaction, and that invariant must have ONE implementation, reached
   * without the stage ever holding a database handle.
   *
   * It THROWS `NoSourceTextError` / `NoDossierError` unchanged. Those are
   * answers rather than faults and the stage settles them itself — flattening
   * them into a null here would leave the caller unable to say which of the two
   * happened, and they send the user to opposite ends of the app.
   */
  readonly runSummary: (kind: SummaryKind) => Promise<SummaryResult>
}

/** What `applyWrites` knows about the run whose payload it is applying. */
export interface StageWriteContext {
  readonly workId: number
  readonly documentId: number
  readonly projectId: number
  readonly stageRunId: number
  readonly fanOut: FanOutKey | null
}

export interface StageDefinition<TResult = unknown> {
  readonly id: string
  /** Shown in the Queue screen. */
  readonly label: string
  /** Bump => supersede this stage and everything downstream of it. */
  readonly version: string
  /** Deterministic tie-break WITHIN a topological layer only. Orders nothing. */
  readonly rank?: number
  readonly scope: StageScope
  readonly provides: readonly Capability[]
  readonly requires: readonly Capability[]
  /**
   * Tokens this stage READS IF THEY ARE THERE and runs without if they are not.
   *
   * `requires` is a PRECONDITION everywhere it is consulted, and the strongest
   * of those consultations is invisible from the stage: `upstreamSatisfied`
   * refuses to judge a stage stale until every required token has a satisfying
   * run, so declaring an enrichment there removes the stage from the staleness
   * sweep entirely for any paper that lacks it. The paper then shows nothing
   * pending — indistinguishable from having been done and found clean, which is
   * a failure presented as a success and the one outcome this pipeline may not
   * have.
   *
   * An enrichment is otherwise treated exactly like a required token: it is
   * resolvable at boot or the graph is rejected, it ORDERS this stage after its
   * providers, it becomes a `job_dependency` so this stage waits for it rather
   * than racing it, `ctx.input` resolves it the same way, and it is folded into
   * the fingerprint and the downstream-retirement walk — so an enrichment that
   * appears, changes or goes away reopens the answers reached without it.
   *
   * The single difference is the one above: its ABSENCE is not a reason to stop
   * asking whether this stage is owed a run.
   */
  readonly enriches?: readonly Capability[]
  /**
   * Rewrites a token it also consumes. Must appear in BOTH `requires` and
   * `provides`; the registry rejects it otherwise, because a `transforms` the
   * graph cannot see silently degrades into a plain second provider.
   */
  readonly transforms?: Capability
  /** "I am a precondition of whoever provides these." Front-gate stages. */
  readonly before?: readonly Capability[]
  /** true => execution is serialized behind the global LLM gate. */
  readonly usesLlm: boolean
  /**
   * WHICH LANGUAGE the body is written in. `'python'` is declared for forward
   * compatibility and the scheduler refuses it rather than pretending a sidecar
   * exists.
   */
  readonly runtime: 'node' | 'python'
  /**
   * WHERE the body runs, and it is deliberately NOT `weight`.
   *
   * `weight` says "this is expensive"; this says "this executes in a process
   * with no database". Overloading one field on the other would make a pure
   * performance re-label ('light' -> 'heavy') silently change a stage's
   * execution semantics and break it at runtime, which is exactly the kind of
   * action-at-a-distance the capability graph exists to remove.
   *
   * `'host'` runs the body in a utilityProcess so a long synchronous native
   * call cannot freeze main's synchronous SQLite and IPC — and so a cancel can
   * `kill()` it, which is the only thing that interrupts a wedged native call.
   * `'inline'` (the default) runs in main and is right for a stage that is
   * short, or that must thread generated row ids through multi-step
   * transactional work.
   */
  readonly isolation?: 'inline' | 'host'
  /** Cost hint for pool sizing. Decides nothing about correctness. */
  readonly weight?: 'light' | 'heavy'
  /**
   * Grace period before a host is killed on cancel.
   *
   * `0` means KILL-ONLY, and several stages genuinely are: tesseract cannot
   * observe an AbortSignal mid-page and qpdf is a child process. For those the
   * graceful path is documented as not applying rather than pretended.
   */
  readonly cancelGraceMs?: number
  /**
   * Apply one `ctx.write` payload. Runs IN MAIN, inside the single transaction
   * that also writes the terminal `stage_run` row, whatever isolation the body
   * ran under.
   *
   * This is the seam that lets a host-isolated stage still perform multi-step
   * transactional writes that thread `lastInsertRowid` from one insert into the
   * next: the DECISIONS are made in the host and travel as data, the SQL runs
   * where the ids are. A flat `{sql, params}` list could not express that
   * without inventing a placeholder mini-language, which would be a worse thing
   * to own than this one method.
   *
   * Required for any stage that calls `ctx.write`; the scheduler fails the run
   * loudly if writes were queued and there is no applier, because silently
   * dropping them is the shape of bug the `empty`/`failed` split exists to
   * prevent.
   *
   * It may RETURN capability values, which are written as artifacts in the same
   * transaction and OVERRIDE anything `ctx.emit`ed for the same token. That is
   * how a stage publishes row ids it could not know before the write happened —
   * `references` cannot put an `unresolved_reference.id` in its artifact from
   * inside `execute`, because the row does not exist yet. Emitting the ids from
   * here keeps them in the one transaction that also created them, so an
   * artifact can never name a row that was rolled back.
   */
  applyWrites?(
    db: DB,
    payload: unknown,
    ctx: StageWriteContext
  ): void | Array<[Capability, unknown]>
  /** Absent => a single run. Present => one job per returned key. */
  fanOut?(ctx: StagePlanContext): FanOutKey[]
  /**
   * Extra invalidation inputs beyond version + upstream fingerprints.
   *
   * MUST include external tool identity where the stage depends on one.
   * Otherwise a `skipped` "tool not found" is cached forever: the user installs
   * the tool and nothing ever re-runs.
   */
  fingerprint?(ctx: StagePlanContext, fan: FanOutKey | null): string
  execute(ctx: StageContext): Promise<StageOutcome<TResult>>
}

/** A stage plus its resolved position, as the registry returns it. */
export interface ResolvedStage {
  readonly stage: StageDefinition
  readonly index: number
}
