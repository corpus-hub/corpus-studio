// The two PROSE summaries of a work, and the one thing that separates them.
//
// GENERAL (`project_id = 0`) describes the paper as it would be described to
// anyone: question, method, results, caveats. It is a property of the WORK, so
// it is written once and every project that holds the paper reads the same
// text.
//
// PROJECT (`project_id = N`) reads the same paper through that project's
// dossier: what it contributes here, how its vocabulary maps onto the
// collection's, where it agrees or conflicts. It is an INTERPRETATION, so it
// is stored against the project and never against the work — the ontology rule
// that stops one project's framing being served to another as though it were
// the paper's own claim.
//
// WHY THIS DOES NOT GO THROUGH `runPipeline`. That function's entire subject is
// the fact: it segments so a quote can be anchored, validates against a fact
// schema, drops claims whose evidence cannot be pointed at, and runs the
// deterministic checks over the measurements it persisted. A summary has no
// quote to anchor and no measurement to check, so every one of those steps
// would either be skipped or, worse, would silently discard prose for failing a
// test written for structured claims. Bending it to carry prose would make it
// worse at both jobs. What IS shared is the part that matters — `analysis_run`
// — so a summary carries the same model, prompt_version, schema_version, input
// hashes, supersede-then-insert and freshness as every other analysis.

import type { DB } from '../db/connection'
import type { LlmProvider } from './provider'
import { isLlmUnavailable, isTruncated } from './provider'
import { getPrompt, summaryPromptName, SCHEMA_VERSION } from './prompts'
import { effectiveSummaryPrompt } from './summaryPrompts'
import { readModelSettings } from './modelSettings'
import { hashInput } from '../adapters'
import { buildDossierContext, dossierContextState } from '../db/repositories'
import { currentParagraphInventory, preferredDocumentId } from '../db/repos/text'
import { emitAnalysisCommitted } from './events'
import { plainText } from '../../shared/markup'

/** Which of the two summaries. The DTO-level name; storage keys on project_id. */
export type SummaryKind = 'general' | 'project'

export interface SummaryInput {
  workId: number
  /**
   * Ignored for `general`, which is always stored under the 0 sentinel. Kept in
   * the shape so a caller cannot forget to pass it for `project`.
   */
  projectId: number
  kind: SummaryKind
  /**
   * Return the summary that already exists when its inputs are byte-identical
   * to the ones this call would send, instead of writing it again.
   *
   * For the button on the Paper screen this is off: a user pressing "regenerate"
   * is asking for a fresh reading, and answering with the stored one would make
   * the button appear dead. The pipeline sets it, because a GENERAL summary is a
   * property of the work and its stage is project-scoped — a paper held by three
   * projects would otherwise be read three times by the model to produce three
   * identical paragraphs, each superseding the last.
   *
   * The comparison is over the four stored input hashes, so it is a claim about
   * rows and not a judgement: any difference in the document text, the prompt,
   * the output schema or the dossier fails it and the summary is rewritten.
   */
  reuseIfCurrent?: boolean
}

export interface SummaryResult {
  analysisRunId: number
  body: string
  sourceScope: string
  /** The stored summary was returned unchanged; no model was called. */
  reused: boolean
  /**
   * The stamp of the brief this summary was written under — the same value
   * stamped onto `analysis_run.prompt_version`.
   *
   * Returned rather than left to the caller to look up, because the caller is a
   * pipeline stage: it holds no database handle and must not acquire one to
   * report the provenance of work this function has already done. Two call
   * sites resolving the brief independently is also how a run's stamp drifts
   * from its own provenance.
   */
  promptStamp: string
  /**
   * The model this summary was actually written by.
   *
   * Reported for the SAME reason `promptStamp` is, and the note above applies
   * unchanged: the stage has no database handle, so it cannot resolve the
   * setting itself and was stamping `ctx.llm.model` — the provider's
   * constructor default — onto its `stage_run`. That disagreed with the
   * `analysis_run` this function writes, so one summary carried two different
   * claims about what read the paper.
   */
  modelUsed: string
}

/**
 * Prose is bounded by the writing brief (3–5 short paragraphs), not by the
 * model's patience. This is a guard against a runaway completion, not a target.
 *
 * DELIBERATELY NOT `extractionMaxOutput`, though the model beside it now is.
 * That setting exists because an extraction of a kinetics table is genuinely
 * long and a tight ceiling truncated whole runs — a real, measured failure. A
 * summary has a fixed shape the brief itself imposes, so the same number would
 * be a ceiling nothing approaches: raising it changes no output and only
 * removes the guard. Checked before deciding: this corpus has 108 summary runs
 * and not one is `partial`, which is the status a truncation produces.
 */
const MAX_OUTPUT_TOKENS = 4096

/**
 * Which model writes a summary.
 *
 * The SAME setting the extraction path reads, because a summary is the reading
 * half of the same job and the Settings screen offers no third control. Empty
 * means "whatever the provider defaults to", which is the one honest reading of
 * a blank field.
 *
 * This exists because the model was previously not passed at all, and the
 * provider's own default answered instead — a fallback that was invisible
 * everywhere except the `model` column of a stored run.
 */
function summaryModel(db: DB): string | undefined {
  const configured = readModelSettings(db).extractionModel.trim()
  return configured === '' ? undefined : configured
}

interface SourceText {
  /**
   * The WHOLE source, as one string, for the callers that want one.
   *
   * Never a prefix of the document: a summary is asked for the shape of an
   * argument, which cannot be judged from a slice, so nothing is dropped to make
   * the paper fit a request. A body too long for one message is sent across
   * several instead (`chunks` + `splitSource`).
   */
  text: string
  /**
   * The same text, still in the paragraphs it arrived as.
   *
   * This is what makes the multi-message split safe: a part boundary can only
   * fall between two of these, never inside one, so no sentence, number or word
   * is ever cut. `chunks.join('\n\n') === text`.
   */
  chunks: string[]
  /**
   * What the run is stale AGAINST: the whole source.
   *
   * Kept as its own field because the freshness check reconstructs the
   * document's full body and hashes that, and the two must be the same bytes by
   * construction rather than by coincidence.
   */
  hashText: string
  /** Recorded verbatim on the row; the reader is told what was actually read. */
  scope: string
  documentId: number | null
  /**
   * WHICH `document_paragraph.idx` each chunk of `text` is, for the callers that
   * ANCHOR rather than write prose.
   *
   * Null when there is no document behind the text (the abstract fallback), and
   * therefore nothing to anchor against. Otherwise it is the translation the
   * bibliography filter above makes necessary: dropping the references
   * renumbers every paragraph after them, so a run's `[p47]` is the 47th
   * paragraph of the PROSE while the reader's viewer resolves 47 against the
   * whole paper. `runPipeline` takes this as `paragraphIndexMap`.
   *
   * A summary ignores it — prose cites nothing — but it is resolved here rather
   * than by each caller, because the map is only correct alongside the exact
   * filter that produced the chunks, and the two drifting apart is silent.
   */
  paragraphIndexMap: number[] | null
  /**
   * WHICH PAPER this text is supposed to be, as the app records it.
   *
   * Sent to the model as the identity of the document, and deliberately NOT
   * folded into `text`/`hashText`: the hash must stay the document's own body so
   * `freshness.readDocumentBody` can reproduce it, and the title is not part of
   * the body.
   *
   * A scanned journal page carries whatever the printer put next to the article
   * — a running header, a notice, the first page of the NEXT paper — and a model
   * given the characters alone has nothing to tell it which of them is the work
   * it was asked about. It picked the wrong one: a 1973 paper on benzisoxazole
   * decomposition was summarised as the azoethane study whose opening page the
   * scan happened to end on.
   */
  title: string | null
}

/**
 * What the app RECORDS this document to be, phrased for the reader.
 *
 * A READ OF STORED PROVENANCE, never an inspection of the text. `'full text'`
 * used to be a literal written whenever any paragraphs existed, which made it an
 * assertion nothing stood behind: a supplementary-materials PDF, a correction and
 * a one-page erratum all reported that the summary had been written from the full
 * text of the work. Deriving it from the two columns that already answer the
 * question means the phrase can only ever repeat something the app was told.
 *
 * It cannot produce a false alarm, because it makes no judgement — a document
 * whose columns say `fulltext` + an ordinary version still reads `full text`,
 * exactly as before. What it CANNOT do is notice that a document recorded as an
 * article is really its appendix; that is a question about content, and it is the
 * model's to answer in the prose, under the brief's instruction to say what it
 * was actually given.
 */
function contentScopeOf(db: DB, documentId: number): string {
  const doc = db
    .prepare('SELECT content_status, version_kind FROM document WHERE id = ?')
    .get(documentId) as { content_status: string; version_kind: string } | undefined
  if (!doc) return 'full text'

  if (doc.version_kind === 'supplementary') return 'supplementary material only'
  if (doc.content_status === 'abstract-only') return 'abstract only'
  if (doc.content_status === 'metadata-only') return 'metadata only'
  // `unknown`/`missing` on a document that nonetheless yielded paragraphs: text
  // exists, but nothing establishes it is the whole work, so the shortfall is
  // that the app does not know rather than that the text is short.
  if (doc.content_status !== 'fulltext') return 'text of unrecorded extent'
  return 'full text'
}

/**
 * The best text this work actually has, and an honest name for it.
 *
 * Ordered by how much of the paper each option really is. The name is not
 * decoration: a summary written from an abstract states far less than one
 * written from the full text, and the reader weighing it has no other way to
 * tell — the prose reads equally fluently either way. This is the same reason
 * `content_status` is badged rather than flattened.
 *
 * Paragraphs come from the pipeline's own `text.paragraphs@v1` artifact via the
 * stage run that published it, so a re-extraction or an OCR pass automatically
 * changes what a summary would be written from — and the input hash then makes
 * the existing summary stale, without a bespoke rule.
 */
export function resolveSourceText(db: DB, workId: number): SourceText | null {
  const documentId = preferredDocumentId(db, workId)
  // PLAIN TEXT for the model. Titles are STORED with the publisher's inline
  // markup — `<i>` around a species name, `<sub>` in a formula — which the UI
  // renders as formatting. A model given the raw string reads the tag names as
  // content: it has been shown papers whose title contains the word "jats", and
  // it will quote them back. The words are what it needs; the emphasis is for
  // the reader.
  const rawTitle =
    (
      db.prepare('SELECT title FROM work WHERE id = ?').get(workId) as
        | { title: string | null }
        | undefined
    )?.title ?? null
  const title = rawTitle === null ? null : plainText(rawTitle)

  if (documentId !== null) {
    // The paragraph inventory as published by whichever stage currently owns
    // it. `superseded = 0` is what keeps this honest: a retired inventory is
    // text the app no longer stands behind. Resolved by `repos/text.ts`, so the
    // in-paper find and this summary cannot disagree about which text is
    // current — a corrupt artifact still reads back null there, and falls
    // through to the abstract here exactly as before.
    const inventory = currentParagraphInventory(db, documentId)

    if (inventory) {
      // The bibliography is excluded on the same reasoning `schema-extract`
      // excludes it: a reference list is prose-shaped but is not the paper's
      // argument, and a model shown 80 citations will summarise the field
      // rather than the work. It stays HERE rather than in the shared helper:
      // someone SEARCHING a paper very often wants exactly the paragraphs a
      // summary must not be written from.
      const kept = inventory.paragraphs.filter(
        (p) => p.kind !== 'reference' && typeof p.text === 'string' && p.text.trim()
      )
      const chunks = kept.map((p) => p.text as string)
      const body = chunks.join('\n\n')
      if (body.trim()) {
        return {
          text: body,
          chunks,
          hashText: body,
          scope: contentScopeOf(db, documentId),
          documentId,
          // Positional when the artifact predates the index being stored on it,
          // which is what an unfiltered caller has always meant.
          paragraphIndexMap: kept.map((p, i) => p.index ?? i),
          title
        }
      }
    }
  }

  const work = db.prepare('SELECT title, abstract FROM work WHERE id = ?').get(workId) as
    | { title: string | null; abstract: string | null }
    | undefined
  if (!work) return null

  // Both stripped for the same reason the title above is: this text goes to a
  // model, and a stored abstract routinely carries whole JATS paragraphs.
  const abstract = plainText((work.abstract ?? '').trim())
  if (abstract) {
    const chunks = [work.title === null ? null : plainText(work.title), abstract].filter(
      (s): s is string => Boolean(s)
    )
    const text = chunks.join('\n\n')
    return {
      text,
      chunks,
      hashText: text,
      scope: 'abstract only',
      // NULL even when a document exists, because this summary did not read it.
      // `document_id` is the claim "the prose came from this document", and the
      // staleness check acts on it: pointed at a document whose text was never
      // used, it compares the abstract's hash against the document's body,
      // never matches, and asserts the source has changed. The honest answer is
      // that no document backs this summary — which is also exactly what
      // `source_scope` says.
      documentId: null,
      paragraphIndexMap: null,
      title
    }
  }

  // Title alone is not a paper. Refusing here is what stops the app inventing
  // three paragraphs about a work it has never read — a summary written from a
  // title is entirely the model's prior, and it reads exactly like one written
  // from the text.
  return null
}

/** Raised when there is nothing to summarise. Distinct from an LLM outage. */
export class NoSourceTextError extends Error {
  constructor(readonly workId: number) {
    super(
      'This paper has no text yet — only its title. Ingest the PDF (or add an abstract) before asking for a summary.'
    )
    this.name = 'NoSourceTextError'
  }
}

export function isNoSourceText(err: unknown): boolean {
  return err instanceof NoSourceTextError
}

/**
 * Raised when a PROJECT summary is asked for and the project has no dossier.
 *
 * Deliberately NOT folded into `NoSourceTextError`: the two send the reader to
 * opposite ends of the app. Missing text is fixed by ingesting a PDF; a missing
 * dossier is fixed on the Topic dossier screen. One message covering both would
 * name neither.
 */
export class NoDossierError extends Error {
  constructor(
    readonly projectId: number,
    /**
     * TRUE when the project HAS a dossier and every claim in it came from this
     * very paper.
     *
     * The two are the same refusal and completely different news. "Build the
     * dossier" is wrong advice for a project whose dossier is built — it sends
     * the user to a screen that already shows what they were told is missing,
     * and it describes their project as empty when it is not. It happens
     * whenever a reference paper is asked for its own project summary, which on
     * a small collection is most of them.
     */
    readonly selfOnly = false
  ) {
    super(
      selfOnly
        ? 'Every claim in this project’s context comes from this paper, so there is nothing else to read it against. A paper cannot be its own background — mark another paper as a reference, and this summary can be written.'
        : 'This project has no project context yet, so there is nothing to read the paper against. Mark a few papers as references and build the project context first.'
    )
    this.name = 'NoDossierError'
  }
}

export function isNoDossier(err: unknown): boolean {
  return err instanceof NoDossierError
}

/**
 * Strip the wrapper a chat model puts around prose however plainly it is told
 * not to: a leading "Here is the summary:", a markdown heading, surrounding
 * code fences. Everything removed here is packaging, never content — the body
 * itself is stored exactly as written, because rewriting a model's prose and
 * then attributing it to that model is the misattribution this app exists to
 * prevent.
 */
/**
 * What the model said the document turned out to be, taken off the front of its
 * answer.
 *
 * The marker is EMITTED ONLY FOR THE EXCEPTION, so `null` — the ordinary case —
 * means the reader is told nothing and the recorded scope stands as the app's
 * own columns describe it. This is the one thing in the pipeline that can notice
 * a retrieval brought back the supplementary PDF instead of the paper: no
 * upstream stage reads the document as a whole, and `extract-text` reports
 * `fulltext` on the strength of having found characters, which an appendix has
 * just as many of.
 *
 * A CLOSED vocabulary, matched on the whole first line. Anything else is left in
 * the prose untouched: an unrecognised marker must never be silently swallowed,
 * because a line deleted from a summary is content the reader was meant to see.
 */
const DOCUMENT_KIND_SCOPE: Record<string, string> = {
  supplementary: 'supplementary material only',
  partial: 'part of the paper only',
  'other-work': 'a different work'
}

function takeDocumentKind(raw: string): { kind: string | null; rest: string } {
  const m = /^[ \t]*DOCUMENT-IS:[ \t]*([a-z-]+)[ \t]*(?:\r?\n|$)/i.exec(raw.trimStart())
  if (!m) return { kind: null, rest: raw }
  const kind = m[1].toLowerCase()
  if (!(kind in DOCUMENT_KIND_SCOPE)) return { kind: null, rest: raw }
  const started = raw.trimStart()
  return { kind, rest: started.slice(m[0].length) }
}

/**
 * The two kinds the model may name, and nothing else.
 *
 * A CLOSED vocabulary, exactly as `DOCUMENT_KIND_SCOPE` is, and for the same
 * reason: an unrecognised marker is left in the prose rather than swallowed,
 * because a line silently deleted from a summary is content the reader was meant
 * to see. Both values are also permitted by `work.work_type`'s CHECK, so nothing
 * here can propose a word the column would refuse.
 */
const WORK_KIND_TYPE: Record<string, string> = {
  review: 'review',
  method: 'method'
}

/**
 * What kind of work the model said this is, taken off the front of its answer.
 *
 * `null` — the ordinary case — is a REFUSAL TO CLAIM, not a vote for the
 * default. The brief offers no marker for "primary research" and none for "I
 * cannot tell", so silence covers both, and both mean the same thing to the
 * caller: leave the stored type alone. That is what keeps a model's impression
 * from overwriting an index's report.
 */
function takeWorkKind(raw: string): { kind: string | null; rest: string } {
  const m = /^[ \t]*WORK-IS:[ \t]*([a-z-]+)[ \t]*(?:\r?\n|$)/i.exec(raw.trimStart())
  if (!m) return { kind: null, rest: raw }
  const kind = m[1].toLowerCase()
  if (!(kind in WORK_KIND_TYPE)) return { kind: null, rest: raw }
  const started = raw.trimStart()
  return { kind, rest: started.slice(m[0].length) }
}

/**
 * Record what kind of work this is, WHEN THE MODEL SAID SO AND THE ROW DISAGREES.
 *
 * Three conditions, and each of them exists to stop a different wrong write.
 *
 * GENERAL SUMMARIES ONLY. What kind of work a paper is belongs to the WORK — a
 * review is a review in every collection — so it is settled once, at the
 * `project_id = 0` sentinel. Written from a project run it would be re-decided
 * per project, and the last project to process the paper would win.
 *
 * ONLY OVER A VALUE AN INDEX CANNOT HAVE MEANT. `journal-article` is what
 * Crossref returns for a review, a software paper and a primary study alike; it
 * is the column's default and carries no observation. Every other value is a
 * real report — `preprint`, `thesis`, `book`, or a `review` somebody already
 * established — and a model's reading does not get to overrule one. So a paper
 * catalogued as a preprint stays a preprint even if the model calls it a method
 * paper: what it IS bibliographically is not in doubt, and the tool was cheaper
 * to believe than the index would be to disbelieve.
 *
 * AND ONLY WHEN IT DIFFERS, so a run that agrees with the row writes nothing —
 * which matters because `work` carries an `updated_at` trigger and a no-op
 * UPDATE would mark the paper changed on every summary.
 */
function recordWorkKind(db: DB, workId: number, kind: string | null, storedProjectId: number): void {
  if (kind === null || storedProjectId !== 0) return
  const next = WORK_KIND_TYPE[kind]
  if (!next) return
  const current = (
    db.prepare('SELECT work_type FROM work WHERE id = ?').get(workId) as
      | { work_type: string }
      | undefined
  )?.work_type
  if (current !== 'journal-article' || current === next) return
  db.prepare('UPDATE work SET work_type = ? WHERE id = ?').run(next, workId)
}

function cleanProse(raw: string): string {
  let s = raw.trim()
  // Whole-answer code fence.
  const fenced = /^```(?:\w+)?\s*\n([\s\S]*?)\n?```$/.exec(s)
  if (fenced) s = fenced[1].trim()
  // A single lead-in line that announces the answer rather than being it.
  s = s.replace(/^(?:here(?:'|\u2019)?s|here is|summary)\b[^\n]{0,60}:\s*\n+/i, '')
  // A markdown heading on the first line only.
  s = s.replace(/^#{1,6}\s+[^\n]*\n+/, '')
  // Normalise paragraph separation to exactly one blank line; the renderer
  // splits on that and nothing else.
  s = s.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

/**
 * Write (or rewrite) one summary, with full provenance.
 *
 * Throws `LlmUnavailableError` WITHOUT persisting anything when no model could
 * be reached — the same contract `runPipeline` keeps, and for the same reason:
 * a row stamped with a provider that answered nothing would show the user a
 * failed summary of their paper when their paper was never read.
 *
 * Throws `NoSourceTextError` when the work has no text. Also nothing persisted:
 * there is no analysis to have provenance about.
 *
 * Any OTHER failure (an empty completion, a truncated one) persists a run whose
 * `verifier_result` says so, because a model that answered badly is a real
 * event worth recording.
 */
export async function generateSummary(
  db: DB,
  provider: LlmProvider,
  input: SummaryInput,
  now: string
): Promise<SummaryResult> {
  // Refused HERE as well as at the IPC boundary, because this is the function
  // that writes the row: 0 is the global sentinel, so a 'project' summary
  // carrying it would be stored AS the general summary — one project's framing
  // of a paper served to every other project as the paper's own claim. A guard
  // at the boundary alone protects only the callers that go through it.
  if (input.kind === 'project' && input.projectId <= 0) {
    throw new Error(
      `generateSummary: a project summary needs a real project id (got ${input.projectId}); 0 is the global sentinel`
    )
  }

  const source = resolveSourceText(db, input.workId)
  if (!source) throw new NoSourceTextError(input.workId)

  // The general summary is a property of the work and is stored globally; the
  // project summary is an interpretation and is stored against its project.
  // This single line is the whole storage difference between the two.
  const storedProjectId = input.kind === 'general' ? 0 : input.projectId

  const promptName = summaryPromptName(storedProjectId)
  const prompt = getPrompt(promptName)
  // The brief the USER is having written, which is the registry's unless they
  // have replaced it. `buildUser` still comes from the registry: the user edits
  // the instructions, not how the document and the dossier are laid out in the
  // message, and a custom brief must not be able to stop the document being
  // sent at all.
  const effective = effectiveSummaryPrompt(db, storedProjectId)

  // A project summary with no dossier would be a general summary wearing a
  // project's label — it would have nothing to relate the paper TO, and the
  // reader could not tell the difference from the prose. Refusing names the
  // missing thing and points at where to make it.
  let dossierContext: string | undefined
  if (input.kind === 'project') {
    const ctx = buildDossierContext(db, input.projectId, input.workId)
    if (!ctx.trim()) {
      throw new NoDossierError(
        input.projectId,
        dossierContextState(db, input.projectId, input.workId) === 'self-only'
      )
    }
    dossierContext = ctx
  }

  // Keyed exactly as `docHashFor` in db/freshness.ts recomputes it — same field
  // names, same order, and `analysisType` is the STORED type ('summary'), not
  // the prompt name. The staleness check hashes the current document body with
  // that recipe and compares; any divergence here would make every summary read
  // as permanently stale against a paper that never changed.
  const docHash = hashInput({
    workId: input.workId,
    projectId: storedProjectId,
    analysisType: 'summary',
    // The EFFECTIVE stamp, so that editing the brief moves the document key
    // too. Without it a customised brief would leave `doc_input_hash`
    // unchanged, `reuseIfCurrent` would answer with the summary written under
    // the OLD instructions, and the edit would reach no paper that already had
    // one — the same shape of failure `getPrompt`'s comment records.
    promptVersion: effective.stamp,
    schemaVersion: SCHEMA_VERSION,
    doc: source.hashText
  })
  // The document as one or more user messages, in reading order. Several only
  // when the paper does not fit one — see `splitSource`. `buildUserMessages` is
  // what makes "never truncate" structural: the builder is handed the paragraphs
  // and cannot express a shortened document.
  const userMsgs = prompt.buildUserMessages
    ? prompt.buildUserMessages(source.chunks, dossierContext, docHash, source.title)
    : [prompt.buildUser(source.text, dossierContext, docHash)]
  // Hashed over ALL the messages, so how the document was divided is part of the
  // prompt key: a change to the split changes what the model was asked, and a
  // stored summary written under a different division must not be reused as
  // though the request were the same.
  const promptInputHash = hashInput({ system: effective.system, user: userMsgs })
  const schemaInputHash = hashInput({ schema: SCHEMA_VERSION })
  const dossierInputHash = dossierContext ? hashInput({ dossier: dossierContext }) : null

  if (input.reuseIfCurrent) {
    const current = db
      .prepare(
        `SELECT r.id AS id, s.body AS body, s.source_scope AS source_scope
           FROM analysis_run r
           JOIN work_summary s ON s.analysis_run_id = r.id
          WHERE r.work_id = ? AND r.project_id = ? AND r.analysis_type = 'summary'
            AND r.schema_id = 0 AND r.superseded = 0
            AND r.doc_input_hash IS ? AND r.prompt_input_hash IS ?
            AND r.schema_input_hash IS ? AND r.dossier_input_hash IS ?`
      )
      .get(
        input.workId,
        storedProjectId,
        docHash,
        promptInputHash,
        schemaInputHash,
        dossierInputHash
      ) as { id: number; body: string; source_scope: string } | undefined
    if (current) {
      return {
        analysisRunId: current.id,
        body: current.body,
        sourceScope: current.source_scope,
        reused: true,
        promptStamp: effective.stamp,
        // The model of the run being REUSED, read back from it — not the one
        // configured now. This branch serves an existing summary rather than
        // writing one, so reporting today's setting would claim a model that
        // never saw this paper.
        modelUsed:
          (
            db.prepare('SELECT model FROM analysis_run WHERE id = ?').get(current.id) as
              | { model: string }
              | undefined
          )?.model ?? provider.model
      }
    }
  }

  let verifier: 'passed' | 'failed' | 'partial' | 'not-run' = 'not-run'
  let body = ''
  // What the reader is told was read. The app's own columns by default; the
  // model's marker overrides them, because it is the only thing here that has
  // seen the document and can tell the paper from its appendix.
  let scope = source.scope
  // What kind of work the model said this is, or null for "it did not say" —
  // which is the ordinary answer and leaves the stored type untouched.
  let workKind: string | null = null
  try {
    let raw: string
    try {
      raw = await provider.callLLM(
        [
          { role: 'system', content: effective.system },
          ...userMsgs.map((content) => ({ role: 'user' as const, content }))
        ],
        // THE CONFIGURED MODEL, named explicitly.
        //
        // Omitting it fell through to `LiveLlmProvider`'s constructor default —
        // `claude-haiku-4-5-20251001` — so every summary in this install ran on
        // haiku while Settings said sonnet and the extraction path (which does
        // pass a model) used sonnet correctly. 42 stored summaries carry the
        // wrong model in their provenance because of it, and provenance that
        // does not match what ran is worse than no provenance: the whole point
        // of stamping it is to know what read the paper.
        //
        // `extractionModel` because there is no summary-specific setting: the
        // Settings screen offers extraction and review, and a summary is the
        // reading half of the same job. A third control nobody asked for would
        // be a worse answer than honouring the one that exists.
        { maxTokens: MAX_OUTPUT_TOKENS, effort: 'medium', model: summaryModel(db) }
      )
      verifier = 'passed'
    } catch (err) {
      // Prose degrades gracefully where JSON does not: a summary cut off after
      // two paragraphs is still two true paragraphs, so it is kept and marked
      // `partial` rather than thrown away.
      if (isTruncated(err)) {
        raw = err.partial ?? ''
        verifier = 'partial'
      } else throw err
    }
    // Both markers, in either order. The brief names one before the other, but
    // which line a model puts first is not something it can be relied upon to
    // get right, and a marker left in place is printed to the reader as though
    // it were the summary's first sentence. Each is taken at most once.
    let rest = raw
    for (let pass = 0; pass < 2; pass++) {
      const doc = takeDocumentKind(rest)
      if (doc.kind) {
        scope = DOCUMENT_KIND_SCOPE[doc.kind]
        rest = doc.rest
      }
      const kind = takeWorkKind(rest)
      if (kind.kind) {
        workKind = kind.kind
        rest = kind.rest
      }
      if (!doc.kind && !kind.kind) break
    }
    body = cleanProse(rest)
    if (!body) verifier = 'failed'
  } catch (err) {
    // No model was reached: there is nothing to have provenance about, so
    // nothing is written and the caller reports an outage, not an analysis.
    if (isLlmUnavailable(err)) throw err
    verifier = 'failed'
    body = ''
  }

  const runId = db.transaction((): number => {
    // Supersede-then-insert, honouring the partial-unique current-run index.
    // `schema_id` is part of that key and a summary has no schema, so the 0
    // sentinel is named explicitly rather than left to a default that could
    // drift.
    db.prepare(
      `UPDATE analysis_run SET superseded = 1
         WHERE work_id = ? AND project_id = ? AND analysis_type = 'summary'
           AND schema_id = 0 AND superseded = 0`
    ).run(input.workId, storedProjectId)

    const info = db
      .prepare(
        `INSERT INTO analysis_run
           (work_id, project_id, analysis_type, schema_id, model, provider, prompt_version,
            schema_version, run_timestamp, verifier_result, deterministic_validation,
            supplied_project_context, superseded, doc_input_hash, prompt_input_hash,
            schema_input_hash, dossier_input_hash, created_at)
         VALUES (?, ?, 'summary', 0, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?, ?, ?)`
      )
      .run(
        input.workId,
        storedProjectId,
        // WHAT WAS ASKED FOR, falling back to the provider's own default only
        // when nothing was configured. `provider.model` alone was a claim about
        // the provider, not about this run: it reported the constructor default
        // even when a different model had been named in the call, which is how
        // 42 summaries came to be stamped `claude-haiku` on an install
        // configured for sonnet. Provenance has to name what actually read the
        // paper, or it is worse than absent.
        summaryModel(db) ?? provider.model,
        provider.name,
        // The EFFECTIVE stamp: the registry version alone while the built-in
        // brief is in force, and `<version>+custom-<digest>` once the user has
        // replaced it.
        //
        // It is NOT a name — `summary-general@v2` here would be a label in no
        // registry, and `hasPrompt` would then report every summary in the app
        // as having instructions that cannot be recovered. WHICH brief was used
        // stays derived from `project_id` by `summaryPromptName`. What the
        // suffix adds is WHOSE text it was: `freshness.ts` splits the stamp,
        // looks the base version up as before, and compares the digest against
        // the brief as it stands now, so a customised run is checkable rather
        // than unknown. A corpus written under the built-in default keeps the
        // byte-identical stamp it has today and nothing goes stale on upgrade.
        effective.stamp,
        SCHEMA_VERSION,
        now,
        verifier,
        dossierContext ?? null,
        docHash,
        promptInputHash,
        schemaInputHash,
        dossierInputHash,
        now
      )
    const id = Number(info.lastInsertRowid)

    // A failed run still gets its row — that is what makes the failure
    // visible — but it gets no `work_summary`, because there is no prose. The
    // read path reports "the last attempt produced nothing" rather than
    // rendering an empty card that looks like a summary of an empty paper.
    if (body) {
      db.prepare(
        `INSERT INTO work_summary (analysis_run_id, body, source_scope, document_id, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(id, body, scope, source.documentId, now)
    }

    // In the SAME transaction as the run that decided it, so the type on the
    // work and the analysis that established it can never be committed apart —
    // a `work_type` with no run behind it is a value with no provenance, which
    // is the one thing this pipeline may not produce.
    //
    // Under `body` because a run that came back with no prose came back with
    // nothing: a marker line alone is not a reading of the paper, and taking a
    // classification out of a failed run would let the weakest answer the model
    // ever gives be the one that rewrites the record.
    if (body) recordWorkKind(db, input.workId, workKind, storedProjectId)

    return id
  })()

  emitAnalysisCommitted({
    workId: input.workId,
    projectId: storedProjectId,
    analysisRunId: runId,
    analysisType: 'summary'
  })

  return {
    analysisRunId: runId,
    body,
    sourceScope: scope,
    reused: false,
    promptStamp: effective.stamp,
    modelUsed: summaryModel(db) ?? provider.model
  }
}
