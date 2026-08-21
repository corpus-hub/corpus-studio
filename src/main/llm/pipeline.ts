// Pipeline orchestrator — adapts ai-detector's run_pipeline/orchestrator flow to
// Node/TS + our SQLite, per port-map §3/§5 Phase C. Flow:
//   doc text -> segment -> build prompt -> provider.callLLM
//   -> extractJson -> zod-validate -> PERSIST analysis_run (+ evidence_span +
//      fact + measurement + fold_improvement) with full provenance
// `verifier_result` records ONLY whether the model's OUTPUT parsed and matched
// the declared schema. It is not an independent verification of the claims and
// is never presented as one.
// Honors the partial-unique current-run index: any prior current run for the
// same (work, project, type) is marked superseded=1 BEFORE inserting the new run,
// all inside ONE transaction.
// Defensive: any stage failure is suppressed and recorded on verifier_result;
// the app never crashes.

import type { DB } from '../db/connection'
import {
  addDevLogScope,
  isDevLogEnabled,
  logAnchor,
  logClaim,
  logClaimLedger,
  logRepair,
  withDevLogScope
} from '../devlog'
import { insistOnValid, SchemaRepairExhaustedError } from './repair'
import type { LlmProvider } from './provider'
import { isLlmUnavailable, isTruncated } from './provider'
import { emitAnalysisCommitted } from './events'
import {
  getPrompt,
  buildAnalysisOutputSchema,
  factSchema,
  renderSchemaSpec,
  SCHEMA_VERSION
} from './prompts'
import { segment } from './segment'
import { readModelSettings } from './modelSettings'
import { canonicaliseMeasurement, mangledBoundFigure } from './units'
import { hashInput } from '../adapters'
import type { AnalysisRunDTO } from '@shared/contract'
import { getWorkAnalyses, getExtractionSchema } from '../db/repositories'
import { currentRunFieldHashes, fieldsToReextract, schemaFieldDiff } from '../db/schemaFieldDiff'

export interface PipelineInput {
  workId: number
  projectId: number
  analysisType: string
  docText: string
  /**
   * Optional project context supplied to the model.
   *
   * Set ONLY by the dossier BUILD run, whose whole subject is the collection.
   * Extraction never sets it: an extraction is a reading of the paper and
   * nothing else, so nothing it produces can be anchored on the collection's
   * prior beliefs.
   */
  suppliedProjectContext?: string
  /** Optional document id to anchor evidence spans against. */
  documentId?: number | null
  /**
   * Optional TARGET EXTRACTION SCHEMA. When supplied, its DB-defined field list
   * is rendered into the prompt and returned `field_key`s are resolved to
   * `measurement.field_id`, making extraction schema-driven instead of
   * enzyme-hardcoded. Provenance is unaffected: prompt_version/schema_version
   * still record HOW; the schema records WHAT.
   */
  schemaId?: number | null
  /**
   * RE-ASK ABOUT THESE FIELDS ONLY, carrying every other field's values forward.
   *
   * Set when the user edited part of a schema rather than replacing it: the
   * prompt names only these fields, and the facts the current run holds for the
   * OTHER fields are copied into the new run unchanged, still naming the run
   * that actually produced them (`fact.origin_run_id`). Absent or empty means
   * the ordinary whole-schema extraction, which is what almost every run is.
   *
   * Keys, not ids — this crosses a process boundary as JSON and a key is what
   * the model answers with anyway.
   */
  onlyFields?: string[] | null
  /**
   * Pictures of regions the TEXT cannot be trusted for — a table, typically.
   *
   * The model reads VALUES from these and still cites its evidence by [pN] from
   * the text, so anchoring is unchanged. Sent only where a region was actually
   * found, so a paper with no tables costs exactly what it did before.
   */
  images?: import('./provider').LlmImage[]
  /**
   * WHICH `document_paragraph.idx` each [pN] of `docText` is.
   *
   * `docText` is not the document: `schema-extract` drops every `reference`
   * paragraph before sending it, so the model's `[p47]` is the 47th paragraph
   * OF THE PROSE, while `document_paragraph.idx` 47 is the 47th paragraph of the
   * whole paper — a bibliography entry, once a paper's references begin.
   * Everything that reads an anchor back (the Paper screen's evidence panel)
   * resolves it against `document_paragraph`, so
   * storing the prose index made `verbatim = 1` a claim about a paragraph the
   * reader is never shown. 13 of this corpus's 20 documents have the two spaces
   * diverging, the first at prose index 30 on document 1.
   *
   * Supplied by the caller that did the dropping, because only it knows what it
   * dropped. Absent means `docText` IS every paragraph and the two spaces are
   * the same, which is what an unfiltered caller has always meant.
   */
  paragraphIndexMap?: number[] | null
}

export interface PipelineResult {
  analysisRunId: number
  factCount: number
  evidenceCount: number
  /**
   * OUTPUT VALIDATION of the model's response — did it return parseable JSON
   * matching the declared schema? This is NOT an independent verification of
   * whether the extracted claims are correct, and must never be labelled as one.
   */
  verifierResult: 'passed' | 'failed' | 'partial' | 'not-run'
  /**
   * Measurements discarded for naming no field in the target schema. The one
   * number that explains an empty schema-targeted run: without it, a run that
   * found nothing and a run whose every value belonged to a different schema
   * report themselves identically.
   */
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
  /** True when the MODEL returned no facts, as opposed to us discarding them. */
  modelReturnedNothing: boolean
  /**
   * Claims the model made that could not be pointed at a place in the document,
   * and were therefore not persisted. Reported so a stage can say the run is
   * incomplete rather than letting the loss pass silently.
   */
  droppedUnanchored: number
  /**
   * What the model said it could NOT read, in its own words.
   *
   * The extraction prompt asks for a table to be read in full and — where it
   * genuinely cannot be — for ONE fact naming the table and the rows that were
   * missed. Carrying those up to the stage is the whole point: a table read two
   * rows out of six and a table that has two rows produce the same count, the
   * same evidence and the same air of completeness, and this is the only thing
   * that tells them apart.
   */
  shortfalls: string[]
}

/** The predicate the extraction prompt reserves for a self-declared shortfall. */
export const SHORTFALL_PREDICATE = 'extraction_shortfall'

/**
 * The canonical form a quote and the document must agree on: lowercased, with
 * everything that is not a letter or a decimal digit removed.
 *
 * This is deliberately the SAME ladder `PdfDocView`'s `locate()` already uses to
 * draw a highlight, and it exists because a raw `String.includes` compares the
 * model's quote against pdf.js output, where the identical sentence differs by
 * artefacts no reader would notice: a line break mid-sentence, `( T m )` spaced
 * out, hyphenation across a line, or `N` standing in for `>`. Those made the
 * checker call a perfect quotation a paraphrase — on this corpus, 455 of 514
 * such verdicts were wrong, and the viewer could highlight passages the checker
 * swore were absent.
 *
 * `\p{Nd}` rather than `\p{N}`: this corpus's PDFs encode `=` as `¼` (a `\p{No}`),
 * so keeping it would leave `kcat¼002` to be compared against `kcat002`.
 */
export const canonQuote = (s: string): string =>
  s.toLowerCase().replace(/[^\p{L}\p{Nd}]+/gu, '')

/** Below this many characters a candidate sentence is too short to scan for. */
const MIN_QUOTE_CHARS = 12

/**
 * How far apart a table row's cells may land once the page is linearised and
 * still count as the same row. Wide enough for a header and its cell, narrow
 * enough that a sentence assembled from across the paper does not qualify.
 */
const TABLE_WINDOW = 600

/**
 * Output ceiling for one extraction.
 *
 * 4096 was not enough for a real paper: a kinetics table of a dozen variants,
 * each fact carrying its own verbatim quote, runs past it and the answer is cut
 * off mid-string. Measured on this corpus's work 20, the model spent the full
 * 4096 and stopped inside a quote, so nothing parsed and the paper recorded
 * zero facts while having been read correctly.
 */
/**
 * The extraction schema this run is filed against could not be read.
 *
 * Its own type so the scheduler and the IPC layer can say what is wrong with
 * the SCHEMA — which the user can fix, by restoring or re-selecting it —
 * instead of reporting a paper that would not analyse.
 */
export class SchemaUnavailableError extends Error {
  constructor(
    readonly schemaId: number,
    readonly why: string
  ) {
    super(
      `The extraction schema (id ${schemaId}) this analysis is filed against could not be read ` +
        `(${why}), so the model was never told which fields to look for. Nothing was run and ` +
        'nothing was recorded. Restore or re-select the schema, then run it again.'
    )
    this.name = 'SchemaUnavailableError'
  }
}

export function isSchemaUnavailable(err: unknown): boolean {
  return err instanceof SchemaUnavailableError
}

/**
 * Recover the complete fact objects from a truncated JSON answer.
 *
 * The tail is a half-written object inside an unterminated array, so the whole
 * document cannot parse — but everything before the cut is intact. Scanning for
 * balanced top-level objects (string- and escape-aware, so a brace inside a
 * quoted value does not end one) returns exactly the records the model
 * finished. This is the same discipline as `extractJson`'s brace scan, applied
 * per element rather than to the document.
 */
function salvageFacts(partial: string): import('./prompts').ParsedFact[] {
  const start = partial.indexOf('"facts"')
  if (start === -1) return []
  const arr = partial.indexOf('[', start)
  if (arr === -1) return []
  const out: import('./prompts').ParsedFact[] = []
  let depth = 0
  let objStart = -1
  let inStr = false
  let esc = false
  for (let i = arr + 1; i < partial.length; i++) {
    const ch = partial[i]
    if (esc) {
      esc = false
      continue
    }
    if (inStr) {
      if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') {
      if (depth === 0) objStart = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && objStart !== -1) {
        try {
          const one = factSchema.safeParse(JSON.parse(partial.slice(objStart, i + 1)))
          if (one.success) out.push(one.data)
        } catch {
          /* a record that does not parse on its own is simply not salvaged */
        }
        objStart = -1
      }
    }
  }
  return out
}


/**
 * Find the paragraph a quote came from, or null.
 *
 * Returns the paragraph INDEX so the caller can anchor to it. A quote is
 * matched against each paragraph and, failing that, against the whole document
 * — a quotation that legitimately spans a paragraph break is still a quotation,
 * and answering "which paragraph" with the first one it starts in is better than
 * calling it fabricated.
 *
 * Ellipsis is honoured: a model writing `"...at 60 °C ... by the seventh round"`
 * is using an ordinary quoting convention, so every segment must be present, in
 * order, rather than the joined string.
 */
export const locateQuoteForTest = (
  quote: string,
  paragraphs: { text: string; index: number }[],
  claimed?: number | number[] | null
): number | null => locateQuote(quote, paragraphs, claimed)?.paragraph ?? null

/**
 * How the quote was matched — which is NOT the same question as where.
 *
 * `contiguous` means the quote occurs as one unbroken run in the paragraph the
 * model named: it can be shown to a reader as a quotation and they will find it.
 * `stitched` means every piece of it is present, in order, but the page never
 * printed it that way — a header joined to a cell across a column break. That is
 * a legitimate table reading and worth keeping, but it is NOT a verbatim quote,
 * and calling it one is a lie the whole design rests on not telling.
 */
export type QuoteMatch = 'contiguous' | 'stitched'

export interface QuoteLocation {
  paragraph: number
  match: QuoteMatch
  /**
   * The anchor occurs MORE THAN ONCE in the paragraphs the model named, so which
   * occurrence it means is unknowable.
   *
   * Carried on the result rather than collapsed into `null`, because the two are
   * different events with different remedies: a quote that is absent is a
   * fabrication and the fact goes, while a quote that is present many times is a
   * correct reading described too briefly, and the remedy is to ask for a longer
   * one. Every caller must decide; none may take the first match.
   */
  ambiguous: boolean
}

/**
 * How many times a canonical needle occurs in a canonical haystack.
 *
 * Mechanical — one string inside another — so it cannot produce a false positive.
 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let n = 0
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) n++
  return n
}

function locateQuote(
  quote: string,
  paragraphs: { text: string; index: number }[],
  /**
   * The [pN](s) the model said it copied from. Checked FIRST and, when given,
   * ONLY. An ARRAY is the table case: extraction scatters one row across
   * paragraphs, so the number, its row label and its column header land in
   * different [pN]s and no single one contains the evidence.
   */
  claimed?: number | number[] | null,
  /**
   * Allow the loose tiers when no id was given. ONLY for re-scoring runs made
   * under a prompt that never asked for one — never for a live extraction.
   */
  allowUnanchored = false
): QuoteLocation | null {
  const cq = canonQuote(quote)

  // THE CONTRACT. The model was shown tagged paragraphs and told to name the one
  // it copied from, so verification is a lookup in that paragraph — not a search
  // of the paper. Searching everywhere is what forced the progressively looser
  // tiers below, and those cannot tell a table read-out from a sentence
  // assembled out of words that merely occur nearby. A quote absent from the
  // paragraph it was attributed to is a fabrication, and saying so is the point.
  if (claimed !== null && claimed !== undefined) {
    const ids = (Array.isArray(claimed) ? claimed : [claimed]).filter((n) =>
      Number.isFinite(n)
    )
    if (ids.length === 0) return null
    const named = ids
      .map((i) => paragraphs.find((p) => p.index === i))
      .filter((p): p is { text: string; index: number } => p !== undefined)
    // A [pN] that does not exist is dropped from the set rather than killing the
    // claim. The model naming one good paragraph and one out-of-range id has
    // still pointed at real evidence, and refusing the pair discarded it.
    if (named.length === 0) return null
    // Concatenated IN THE ORDER GIVEN. The evidence for a table value is spread
    // over the paragraphs the model named — the cell, its row label, its column
    // header — and none of them holds it alone. Joining only those, rather than
    // searching the document, keeps the rule exactly as strict: the quote must
    // still be inside the paragraphs the model committed to, and naming extra
    // ones cannot help because the quote must appear in their sequence.
    const joined = named.map((p) => p.text).join('\n')
    // UNIQUENESS, restored and now reported rather than acted on.
    //
    // An earlier relaxation let a repeated anchor through to the first match, and
    // that is the one answer nobody can defend: work 2's paragraph 14 is a whole
    // table flattened into 700 characters, where a bare `95` occurs eight times,
    // so "the first one" is an arbitrary cell presented as verified evidence. The
    // count is mechanical and the verdict is handed to the caller — a live
    // extraction sends it back to the model to lengthen, and a re-derivation that
    // cannot ask anyone records it as un-anchorable.
    const ambiguous = countOccurrences(canonQuote(joined), cq) > 1
    let match: QuoteMatch = 'contiguous'
    if (!canonQuote(joined).includes(cq)) {
      // A table quote is often a HEADER plus a CELL that the page shows in one
      // column but the text layer stores far apart: the model writes
      // `k cat (s 2 1 ; mean 6 s.d.) 0 . 29 6 0 . 11`, and that exact string
      // exists nowhere even though both halves do, verbatim, in the paragraphs
      // it named. Refusing it discards a correct reading for a formatting
      // artefact of the extractor.
      //
      // ORDER IS NOT REQUIRED. A table quote pairs a header with a cell, and the
      // text layer stores columns in whatever sequence the extractor walked
      // them — so demanding the fragments appear in the model's order refused
      // correct readings for the extractor's layout. What is still required is
      // that every fragment REALLY BE THERE.
      const parts = quote
        .split(/[\s;,()[\]]+/)
        .map(canonQuote)
        .filter((s) => s.length > 0)
      const cj = canonQuote(joined)
      if (!parts.every((s) => cj.includes(s))) {
        // The quote is not in the paragraphs the model named. It may still be
        // elsewhere in the document, filed under the wrong [pN] — a citation
        // error, not a fabrication — so the anchor is corrected to a paragraph
        // that really does print it.
        // Not in the named paragraphs, so uniqueness is judged where it IS: a
        // string printed once in the whole document anchors, however the model
        // mis-cited it; printed many times it anchors nowhere.
        const holders = paragraphs.filter((p) => canonQuote(p.text).includes(cq))
        if (holders.length === 0) return null
        return {
          paragraph: holders[0].index,
          match: 'contiguous',
          ambiguous:
            holders.length > 1 ||
            countOccurrences(canonQuote(holders[0].text), cq) > 1
        }
      }
      // Every fragment present, but not as one unbroken run. Recorded as such
      // rather than being quietly promoted to a verbatim quotation.
      match = 'stitched'
    }
    // Anchor to the paragraph that HOLDS the quote, not to the first one named.
    //
    // The model names every paragraph a table row spans — `[9, 10]` — and the
    // check above joins them, so a quote living entirely in p10 verified
    // correctly and was then stored against p9. 101 of this corpus's 380 spans
    // pointed at a paragraph not containing their own quote, and a reader
    // following one landed on the wrong part of the paper. Since the join
    // already proved the quote is inside the named set, this only decides WHICH
    // of them to record.
    const holder = named.find((p) => canonQuote(p.text).includes(cq))
    if (holder) return { paragraph: holder.index, match, ambiguous }
    // No single named paragraph prints the quote as one run — it only looks
    // unbroken because the check above searched the paragraphs JOINED. The
    // evidence begins at the first named one, but a reader sent there will not
    // find the string, so this is `stitched` whatever the join said. Leaving
    // `match` alone here is how a cross-boundary quote earned `verbatim = 1`.
    return { paragraph: named[0].index, match: 'stitched', ambiguous }
  }

  // NO ID GIVEN. The prompt requires one, so its absence is the model declining
  // the contract — and the looser tiers below then become a way OUT of the
  // contract rather than a help: measured against the stored runs, the strict
  // path accepts 362 quotes and the fallback path 1 008, so omitting the field
  // was worth a 2.8x higher acceptance rate. A model that learns to leave it out
  // gets graded on the easy scale. An unanchored quote is unanchored.
  //
  // The tiers stay reachable only for `allowUnanchored`, which the RE-DERIVATION
  // path sets when re-scoring runs made under a prompt version that never asked
  // for an id. Those quotes are not the model dodging anything; they predate the
  // question.
  if (!allowUnanchored) return null

  for (const p of paragraphs) {
    if (canonQuote(p.text).includes(cq))
      return { paragraph: p.index, match: 'contiguous', ambiguous: false }
  }

  // Segments of an elided quote, each long enough to be meaningful on its own.
  const segs = quote
    .split(/\.{3}|…/)
    .map(canonQuote)
    .filter((s) => s.length >= MIN_QUOTE_CHARS)
  if (segs.length > 1) {
    for (const p of paragraphs) {
      const cp = canonQuote(p.text)
      let at = 0
      if (segs.every((s) => (at = cp.indexOf(s, at)) !== -1 && (at += s.length) > 0))
        return { paragraph: p.index, match: 'stitched', ambiguous: false }
    }
  }

  // Whole-document fall-back, for a quote that crosses a paragraph boundary.
  let cursor = 0
  const offsets: { start: number; index: number }[] = []
  let whole = ''
  for (const p of paragraphs) {
    const cp = canonQuote(p.text)
    offsets.push({ start: cursor, index: p.index })
    whole += cp
    cursor += cp.length
  }
  const at = whole.indexOf(cq)
  const ownerOf = (pos: number): number | null => {
    let owner = offsets[0]?.index ?? null
    for (const o of offsets) if (o.start <= pos) owner = o.index
    return owner
  }
  if (at !== -1) {
    const owner = ownerOf(at)
    return owner === null ? null : { paragraph: owner, match: 'stitched', ambiguous: false }
  }

  // TABLE READ-OUT. `R2 2/7E 0.23 ± 0.01` is a variant name beside its kinetic
  // values — adjacent in the printed table, but far apart once the page is
  // linearised, so no contiguous match can exist. The tokens are all really
  // there, so requiring them to appear TOGETHER within a window recognises the
  // row while still refusing a sentence quilted from across the paper: every
  // token must be present AND close, not merely present.
  const toks = (quote.match(/[0-9]+(?:[.,][0-9]+)?|[\p{L}]{3,}/gu) ?? [])
    .map(canonQuote)
    .filter((t) => t.length > 0)
  if (toks.length < 2) return null
  const rarest = toks.reduce((a, b) =>
    whole.split(b).length - 1 > 0 && whole.split(b).length < whole.split(a).length ? b : a
  )
  for (let i = whole.indexOf(rarest); i !== -1; i = whole.indexOf(rarest, i + 1)) {
    const lo = Math.max(0, i - TABLE_WINDOW)
    const win = whole.slice(lo, i + rarest.length + TABLE_WINDOW)
    if (toks.every((t) => win.includes(t))) {
      const owner = ownerOf(i)
      if (owner !== null) return { paragraph: owner, match: 'stitched', ambiguous: false }
    }
  }
  return null
}

/** One stored fact, with everything hanging off it, ready to be re-inserted. */
interface CarriedFact {
  originRunId: number
  fact: {
    evidence_span_id: number | null
    kind: string
    predicate: string
    subject: string | null
    object: string | null
    value_text: string | null
    field_id: number | null
    created_at: string
  }
  evidence: {
    document_id: number | null
    page: number | null
    section: string | null
    paragraph: number | null
    sentence: number | null
    quote: string | null
    verbatim: number
    created_at: string
  } | null
  measurements: Array<{
    id: number
    field_id: number | null
    quantity: string
    value_num: number | null
    value_text: string | null
    unit: string | null
    error_num: number | null
    conditions: string | null
    created_at: string
    fold: {
      baseline_label: string
      improved_label: string
      fold: number | null
      comparability: string
      created_at: string
    } | null
  }>
}

/**
 * The current run's facts for the fields this re-extraction is NOT asking about.
 *
 * WHICH FIELD A FACT BELONGS TO is the whole difficulty. `measurement.field_id`
 * answers it for numeric fields — and only for those. A text or enum field
 * (`variant`, `mutations`, `buffer`) produces a fact with NO measurement row at
 * all, so a filter written on `field_id` would judge every one of them to
 * belong to no field, carry none of them forward, and silently delete them on
 * the first partial re-extraction. That is the most destructive thing this
 * function could do, so it uses the SAME fallback the Extraction table uses to
 * attribute such a row: `fact.predicate` matched against `extraction_field.key`
 * COLLATE NOCASE (see `EXTRACTION_ROW_SQL` in repositories.ts).
 *
 * A fact that resolves to NO field is carried forward too. It was extracted
 * under this schema and is on screen now; dropping it because we cannot name
 * its column would make a re-read of two fields quietly destroy a value that
 * has nothing to do with either.
 */
function readCarryForward(
  db: DB,
  input: PipelineInput,
  asked: Set<string>
): CarriedFact[] {
  const current = db
    .prepare(
      `SELECT id FROM analysis_run
        WHERE work_id = ? AND project_id = ? AND analysis_type = ?
          AND schema_id = ? AND superseded = 0`
    )
    .get(input.workId, input.projectId, input.analysisType, input.schemaId ?? 0) as
    | { id: number }
    | undefined
  if (!current) return []

  const rows = db
    .prepare(
      `SELECT f.id, f.evidence_span_id, f.kind, f.predicate, f.subject, f.object,
              f.value_text, f.field_id, f.created_at,
              COALESCE(f.origin_run_id, f.analysis_run_id) AS origin_run_id
         FROM fact f
        WHERE f.analysis_run_id = ?`
    )
    .all(current.id) as Array<
    CarriedFact['fact'] & { id: number; origin_run_id: number }
  >
  if (rows.length === 0) return []

  // key -> the field keys a fact of this predicate could belong to. Read once;
  // the per-fact alternative is a query per fact per paper.
  const fieldKeys = (
    db
      .prepare(`SELECT id, key FROM extraction_field WHERE schema_id = ?`)
      .all(input.schemaId ?? 0) as Array<{ id: number; key: string }>
  )
  const keyById = new Map(fieldKeys.map((f) => [f.id, f.key]))
  const keyByLowerKey = new Map(fieldKeys.map((f) => [f.key.toLowerCase(), f.key]))

  const measStmt = db.prepare(
    `SELECT m.id, m.field_id, m.quantity, m.value_num, m.value_text, m.unit,
            m.error_num, m.conditions, m.created_at
       FROM measurement m WHERE m.fact_id = ?`
  )
  const foldStmt = db.prepare(
    `SELECT baseline_label, improved_label, fold, comparability, created_at
       FROM fold_improvement WHERE measurement_id = ?`
  )
  const evStmt = db.prepare(
    `SELECT document_id, page, section, paragraph, sentence, quote, verbatim, created_at
       FROM evidence_span WHERE id = ?`
  )

  const out: CarriedFact[] = []
  for (const r of rows) {
    const measurements = measStmt.all(r.id) as CarriedFact['measurements']
    for (const m of measurements) {
      m.fold = (foldStmt.get(m.id) as CarriedFact['measurements'][number]['fold']) ?? null
    }

    // Every field this fact touches. A fact with several measurements can span
    // more than one, and it is carried only if NONE of them is being re-asked —
    // splitting one fact's measurements across two runs would leave the fact
    // itself owned by neither.
    //
    // `fact.field_id` FIRST, because that is now the binding site. The
    // measurement's copy and the predicate fallback below remain for rows written
    // before the fact carried one: they ATTRIBUTE AN EXISTING ROW rather than
    // choosing a key for a model, and without them a stored fact whose field IS
    // being re-asked would be carried forward and then extracted again.
    const touched = new Set<string>()
    if (r.field_id != null) {
      const k = keyById.get(r.field_id)
      if (k) touched.add(k)
    }
    for (const m of measurements) {
      const k = m.field_id != null ? keyById.get(m.field_id) : undefined
      if (k) touched.add(k)
    }
    if (touched.size === 0) {
      const k = keyByLowerKey.get(r.predicate.trim().toLowerCase())
      if (k) touched.add(k)
    }
    if ([...touched].some((k) => asked.has(k))) continue

    out.push({
      originRunId: r.origin_run_id,
      fact: {
        evidence_span_id: r.evidence_span_id,
        kind: r.kind,
        predicate: r.predicate,
        subject: r.subject,
        object: r.object,
        value_text: r.value_text,
        field_id: r.field_id,
        created_at: r.created_at
      },
      evidence:
        r.evidence_span_id == null
          ? null
          : ((evStmt.get(r.evidence_span_id) as CarriedFact['evidence']) ?? null),
      measurements
    })
  }
  return out
}

/**
 * Run one analysis end-to-end and persist it. Returns the new analysis_run id.
 *
 * Never throws for expected/validation failures — records verifier_result and
 * persists an (empty) run so provenance always exists. It DOES throw when there
 * is nothing to have provenance ABOUT — `LlmUnavailableError` when no model
 * could be reached, `SchemaUnavailableError` when the schema the run is filed
 * against cannot be read. In both cases no run is written and the caller
 * reports the obstacle instead of an analysis.
 */
export function runPipeline(
  db: DB,
  provider: LlmProvider,
  input: PipelineInput,
  now: string
): Promise<PipelineResult> {
  // A scope of its own, rather than relying on the scheduler's: `runPipeline`
  // is also reachable from the CLI verifiers and the prompt lab, and a trace
  // that only names the paper when a stage happened to be the caller is a trace
  // with holes in exactly the situations someone is debugging.
  return withDevLogScope(
    {
      workId: input.workId,
      // `?? undefined`, because a null documentId is legitimate -- an abstract-only analysis
      // has no document -- while the scope's field is optional rather than nullable. Omitting
      // it says "no document" as clearly as a null would, and keeps the trace's shape uniform
      // for anything reading it back.
      documentId: input.documentId ?? undefined,
      projectId: input.projectId,
      schemaId: input.schemaId ?? null,
      purpose: `analysis:${input.analysisType}`
    },
    () => runPipelineTraced(db, provider, input, now)
  )
}

async function runPipelineTraced(
  db: DB,
  provider: LlmProvider,
  input: PipelineInput,
  now: string
): Promise<PipelineResult> {
  // ---- 1. segment (offset-anchored) --------------------------------------
  const paragraphs = segment(input.docText)
  // Exact-slice self-check (defensive; never throws to caller).
  for (const p of paragraphs) {
    if (input.docText.slice(p.charStart, p.charEnd) !== p.text) {
      // Segmentation invariant broke — degrade gracefully (no anchoring).
      paragraphs.length = 0
      break
    }
  }

  /**
   * A [pN] of `docText` as the id the DOCUMENT knows it by.
   *
   * Anchoring happens in the prose the model was shown; anchoring is READ back
   * against `document_paragraph`, which also holds the paragraphs the caller
   * dropped. The two indexings coincide only until the first dropped paragraph,
   * so a translation that is the identity for most of a paper silently diverges
   * exactly where a bibliography starts — which is why the one span that got
   * through named a reference entry.
   *
   * An index the map cannot place is stored as NULL rather than guessed: an
   * anchor pointing at an unknown paragraph is not evidence, and a plausible
   * wrong number is worse than an admitted absence.
   */
  const idxMap = input.paragraphIndexMap ?? null
  const toDocumentParagraphIdx = (i: number | null): number | null => {
    if (i === null) return null
    if (!idxMap) return i
    return idxMap[i] ?? null
  }

  // The MODEL and the room it is given, from the user's settings.
  //
  // Read here rather than captured when the provider was built, so a change in
  // Settings reaches the next analysis instead of the next launch. An empty
  // model means "whatever the gateway offers", which is what this app has
  // always done — `pickModel` picks the cheapest it serves.
  const settings = readModelSettings(db)
  const budget = {
    model: settings.extractionModel === '' ? undefined : settings.extractionModel,
    maxOutput: settings.extractionMaxOutput
  }

  // ---- 2. build prompt ---------------------------------------------------
  const prompt = getPrompt(input.analysisType)
  const docHash = hashInput({
    workId: input.workId,
    projectId: input.projectId,
    analysisType: input.analysisType,
    promptVersion: prompt.version,
    schemaVersion: SCHEMA_VERSION,
    doc: input.docText
  })
  // Load the target schema (if any) and render its DB-defined fields into the
  // prompt. `fieldIdByKey` then maps the model's `field_key` back to a real
  // extraction_field id at persist time. All read from SQLite — no literals.
  let schemaSpec: string | undefined
  const fieldIdByKey = new Map<string, number>()
  // The unit each field DECLARES, so persist can refuse a value whose dimensions
  // the field cannot hold. Read from the same schema definition the user owns —
  // nothing here knows what any particular field measures.
  const fieldUnitByKey = new Map<string, string | null>()
  // The label the SCHEMA gives each field, which is what a fact answering it is
  // called. The model used to be asked for that name as well, in `predicate`,
  // and wrote prose: one field arrived as "turnover number", "Turnover number"
  // and its own key across one corpus, another as "substitutions" where the
  // column is called Mutations, and one field's facts under a NEIGHBOURING
  // field's name. Anything grouping by predicate therefore saw columns that do
  // not exist, and a check comparing predicate to a field name never matched, so
  // it asked every run whether a field filled on every row was missing.
  //
  // `field_id` already says which column a fact answers, so the name is a lookup
  // and not an answer. Asking for it invited a second, unchecked opinion about a
  // question already settled.
  const fieldLabelByKey = new Map<string, string>()
  // WHAT A FACT IS CALLED: the schema's label wherever the fact names a field,
  // the model's own wording only where there is no field to look up (a summary,
  // or a run made with no schema). Resolved in ONE place so the ledger, the
  // anchor log and the stored row cannot disagree about the name of one fact.
  const nameOf = (f: { field_key?: string | null; predicate?: string }): string =>
    (f.field_key ? fieldLabelByKey.get(f.field_key) : null) ?? f.predicate ?? ''
  // The exact strings each enum field admits, so an answer outside them is a
  // VALIDATION failure the repair loop hands back rather than something stored
  // and then judged. Read from the user's own field definitions.
  const fieldEnumByKey = new Map<string, readonly string[]>()
  // The field map this run is produced under, recorded on the run so a later
  // edit can tell which of its values the edit actually affects. Covers the
  // WHOLE schema even on a narrowed re-ask, because the run that results does
  // hold values for every field — the untouched ones carried forward — and a
  // map naming only the re-asked ones would report the carried values as made
  // under unknown definitions the next time someone edits the schema.
  let fieldHashes: string | null = null
  // The narrowing, resolved against fields that actually exist. A key naming no
  // field is dropped here rather than reaching the prompt as an empty section.
  let narrowed: Set<string> | null = null
  if (input.schemaId != null) {
    try {
      const target = getExtractionSchema(db, input.schemaId)
      for (const f of target.fields) {
        fieldIdByKey.set(f.key, f.id)
        fieldUnitByKey.set(f.key, f.unit ?? null)
        fieldLabelByKey.set(f.key, f.label)
        if (f.enum_options && f.enum_options.length > 0) {
          fieldEnumByKey.set(f.key, f.enum_options)
        }
      }

      const hashes: Record<string, string> = {}
      for (const f of target.fields) hashes[f.key] = f.param_hash
      fieldHashes = JSON.stringify(hashes)

      // WHAT ACTUALLY CHANGED about this schema since the stored extraction.
      //
      // Decided HERE and not in the stage, because the stage's execute context
      // deliberately hands out no database handle — `StageReadDb` exposes the
      // few lookups a stage legitimately makes about its own subject, and
      // "which fields did the current analysis run cover" is not one of them.
      // This function already holds the handle, the schema and the run key.
      //
      // The stage re-runs whenever the schema's version moves, which is right:
      // the definitions the paper was read under are no longer the ones in
      // force. But that has meant re-reading all eleven columns because the
      // hint on one was reworded, discarding ten correct extractions and the
      // review verdicts recorded against them.
      const chosen =
        input.onlyFields ??
        (() => {
          const current = currentRunFieldHashes(
            db,
            input.workId,
            input.projectId,
            input.schemaId as number
          )
          if (!current) return null
          const diff = schemaFieldDiff(db, input.schemaId as number, current.fieldHashes)
          return fieldsToReextract(diff, target.fields.length)
        })()

      const want = new Set(chosen ?? [])
      const asked = want.size > 0 ? target.fields.filter((f) => want.has(f.key)) : target.fields
      // Narrowing to NOTHING is not narrowing, it is a run with no question.
      // Falls back to the whole schema, which is the answer that is never wrong.
      const fields = asked.length > 0 ? asked : target.fields
      if (fields.length < target.fields.length) narrowed = new Set(fields.map((f) => f.key))

      schemaSpec = renderSchemaSpec({
        key: target.key,
        name: target.name,
        version: target.version,
        description: target.description,
        fields: fields.map((f) => ({
          key: f.key,
          label: f.label,
          data_type: f.data_type,
          unit: f.unit,
          required: f.required,
          enum_options: f.enum_options,
          description: f.description
        })),
        // Named so the model is not left inferring why a schema it may have
        // seen before has lost most of its columns.
        partialOf: narrowed ? target.fields.length : undefined
      })
    } catch (err) {
      // AN UNGUIDED EXTRACTION IS A DIFFERENT ANALYSIS, not a degraded one.
      //
      // Without the rendered spec the model is never told which fields exist,
      // what they are called, what units they carry or which values an enum
      // admits — so it answers whatever it likes, nothing binds to a
      // `field_key`, and the run lands looking like a paper that simply held
      // nothing for this schema. The record then names a schema that never
      // reached the model.
      //
      // Nothing has been sent yet at this point, so failing here costs no model
      // call and the paper can be re-run the moment the schema is restored.
      throw new SchemaUnavailableError(
        input.schemaId,
        err instanceof Error ? err.message : String(err)
      )
    }
  }
  const userMsg = prompt.buildUser(
    input.docText,
    input.suppliedProjectContext,
    docHash,
    schemaSpec
  )

  // Provenance hashes (stamped whether or not the LLM call succeeds).
  const promptInputHash = hashInput({ system: prompt.system, user: userMsg })
  const schemaInputHash = hashInput({ schema: SCHEMA_VERSION })
  const dossierInputHash = input.suppliedProjectContext
    ? hashInput({ dossier: input.suppliedProjectContext })
    : null

  // ---- 3. call provider + parse + validate (all defensive) ---------------
  let verifier: 'passed' | 'failed' | 'partial' | 'not-run' = 'not-run'
  let facts: import('./prompts').ParsedFact[] = []
  let truncated = false
  let droppedUnanchored = 0
  try {
    // The model does NOT get to end this with an answer that does not validate.
    // Every violation is named and handed back; after MAX_INVALID_ANSWERS bad
    // answers the run is abandoned as "could not produce a valid result", which
    // is a real failure and is reported as one.
    //
    // Truncation is handled INSIDE the asking closure, because a guillotined
    // answer is not a schema violation — it is a complete answer we only have
    // part of, and salvaging its finished records beats asking again.
    const askOnce = async (): Promise<string> => {
      try {
        return await provider.callLLM(
          [
            { role: 'system', content: prompt.system },
            { role: 'user', content: userMsg, images: input.images }
          ],
          // A kinetics table of a dozen variants, each fact carrying its own
          // verbatim quote, does not fit in 4096 output tokens — the answer was
          // guillotined mid-JSON and filed as unusable on 29 of this corpus's 40
          // extraction runs, losing whole papers' worth of correct extraction.
          { maxTokens: budget.maxOutput, model: budget.model, effort: 'medium' }
        )
      } catch (err) {
        if (isTruncated(err)) {
          facts = salvageFacts(err.partial)
          verifier = 'partial'
          truncated = true
          return ''
        }
        throw err
      }
    }

    const out = await insistOnValid(
      buildAnalysisOutputSchema(
        fieldEnumByKey,
        [...fieldIdByKey.keys()],
        // An anchor that cannot be located is a REPAIR-LOOP FAULT too, not only
        // an ambiguous one. `locateQuote` answers null for "not there at all",
        // and asking `?.ambiguous !== true` of null reads as "no fault" — so a
        // quote that exists nowhere passed validation, was stored, and was then
        // dropped at persist time for being unanchorable. The model was never
        // told, though it was the one thing it could have fixed: 30 claims in a
        // run went that way, every one of them a table header stitched to a cell
        // from a different paragraph (`Enzyme KE 07`, where `Enzyme` is the
        // column head in p9 and `KE 07` a row label in p10).
        //
        // Skipped when segmentation degraded (`paragraphs` empty): with nothing
        // to search, every anchor would read as missing.
        (quote, paragraph) => {
          if (paragraphs.length === 0) return null
          const hit = locateQuote(quote, paragraphs, paragraph)
          if (hit === null) return 'missing'
          if (hit.ambiguous === true) return 'ambiguous'
          // A `stitched` match is a FAULT the model must repair, not a result
          // to store. Every piece of it is in the paragraphs named, so
          // `locateQuote` finds it and the fact is KEPT — but the page never
          // printed that run, so it stores `verbatim = 0` and no highlight can
          // be drawn. Reported as no fault at all, it was the commonest anchor
          // failure a flattened table produces and it filled the corpus with
          // records whose evidence cannot be shown.
          return hit.match === 'stitched' ? 'stitched' : null
        }
      ),
      {
        // The repair turn is the SAME reading, so it is the same model. Passing
        // no model here let every retry fall back to the provider's default
        // while the first attempt used the configured one — one analysis read by
        // two models, with nothing recording the split.
        chat: (m, o) => provider.callLLM(m, { ...o, model: budget.model }),
        systemPrompt: prompt.system,
        ask: askOnce,
        originalUser: userMsg,
        maxTokens: budget.maxOutput,
        schemaName: `analysis:${input.analysisType}`,
        log: (m: string) =>
          logRepair({ analysisType: input.analysisType, workId: input.workId, note: m })
      }
    )
    if (!truncated) {
      facts = out.facts
      // `passed` even when the list is EMPTY. The model answered, the answer
      // parsed and it validated — the verifier's subject is whether the OUTPUT
      // was usable, and "this paper reports nothing for this schema" is a
      // usable answer. Grading it `partial` made every honest abstention look
      // degraded: most papers here carry no thermostability data at all, so 17
      // of 20 such runs were filed as problems when each was correct.
      verifier = 'passed'
    }
  } catch (err) {
    // NO MODEL WAS REACHED — so there is no run to record, and this rethrows.
    //
    // Every other failure here is a failure OF an analysis: a model answered and
    // the answer was unusable, which is a real event worth a row with
    // `verifier_result = 'failed'` and honest provenance. An unreachable gateway
    // is not that. Persisting it would write an `analysis_run` stamped with a
    // provider that answers nothing and a model named `none`, and the Paper
    // screen would show the user a failed analysis of their paper when in fact
    // their paper was never looked at. The caller (a stage, the queue) turns
    // this into a job-level outcome that names the outage.
    if (isLlmUnavailable(err)) throw err
    // TWENTY invalid answers is not an analysis either. The model was reached,
    // was told precisely what was wrong each time, and never produced a
    // conforming answer — so there is nothing to persist and nothing to show.
    // Rethrown so the STAGE fails, visibly and retryably, rather than writing a
    // run with zero facts that reads exactly like a paper reporting nothing.
    if (err instanceof SchemaRepairExhaustedError) throw err
    // Provider/network/parse blew up — suppress, record failure, still persist.
    verifier = 'failed'
    facts = []
  }

  // ---- 3b. DROP any claim whose evidence cannot be pointed at ------------
  //
  // A fact the reader cannot follow back to a place in the paper has no use in
  // an evidence tool: it asks to be believed on the model's word, which is the
  // one thing this app exists not to do. So an unanchorable claim is discarded
  // rather than shown with an "evidence not located" caption — a caption is an
  // apology, and shipping hundreds of them trains the reader to ignore the
  // anchor entirely.
  //
  // Kept deliberately: a fact the model itself marks as NOT directly reported.
  // `supplied-by-project-context` is an honest statement that the value came from
  // the dossier, and it is not a claim about what the document says, so it has
  // nothing to anchor and must not be judged as if it did.
  // What the MODEL said, before we start discarding. Everything below reduces
  // this number, and without it an empty run cannot say whether the model found
  // nothing or we rejected everything it found.
  const modelFactCount = facts.length

  if (paragraphs.length > 0) {
    const anchorable = (f: (typeof facts)[number]): boolean => {
      if (f.kind === 'supplied-by-project-context') return true
      // NO ANCHOR, BUT A PARAGRAPH, IS AN HONEST ANSWER — so it is kept.
      //
      // The text layer loses whole table rows: work 2's paragraph 14 has no
      // `T m app` row at all, though the page image prints `T m app (°C) > 95`.
      // There is then no text to quote, and the previous rule — anchor or die —
      // is precisely what made the model manufacture one, which is how the
      // corpus filled with `e N 95`. A paragraph-level anchor is coarser than a
      // phrase, not less true, and the reader is shown the paragraph.
      if (!f.anchor_quote) return f.paragraph != null
      return locateQuote(f.anchor_quote, paragraphs, f.paragraph) !== null
    }
    const kept = facts.filter(anchorable)
    if (kept.length !== facts.length) {
      droppedUnanchored = facts.length - kept.length
      if (isDevLogEnabled()) {
        // One event per DISCARDED claim, with the quote that could not be
        // found. The integer above says how many were lost; only this says
        // which, and whether they were real findings or noise — the question
        // that has cost two days and a corpus re-run to leave unanswerable.
        const keptSet = new Set(kept)
        for (const f of facts) {
          if (keptSet.has(f)) continue
          logClaim({
            outcome: 'dropped-unanchored',
            predicate: nameOf(f),
            kind: f.kind,
            subject: f.subject ?? null,
            object: f.object ?? null,
            value: f.value_text ?? null,
            unit: f.unit ?? null,
            quote: f.anchor_quote ?? null,
            claimedParagraph: f.paragraph ?? null,
            why: f.anchor_quote
              ? 'the anchor text could not be located in the document text'
              : 'the fact claims the document reports it but cites no paragraph'
          })
        }
      }
      facts = kept
      // The run no longer reports everything the model said, and says so.
      if (verifier === 'passed') verifier = 'partial'
    }
  }

  // ---- 3c. LIFT the model's self-declared shortfalls out of the facts ----
  //
  // A shortfall is a statement ABOUT the reading, not a finding OF the paper.
  // Left in `fact` it would appear in the extraction table as a row with no
  // value, be exported as data, and be counted in "N fact(s)" — so the very
  // thing announcing that the run is incomplete would pad the number that says
  // how complete it is. Lifted here, it reaches the reader where the run's
  // outcome is reported, which is where someone deciding whether to trust the
  // extraction is looking.
  const shortfalls: string[] = []
  if (facts.some((f) => f.predicate === SHORTFALL_PREDICATE)) {
    for (const f of facts) {
      if (f.predicate !== SHORTFALL_PREDICATE) continue
      const said = (f.value_text ?? f.object ?? f.subject ?? '').trim()
      if (said !== '') shortfalls.push(said)
      logClaim({
        outcome: 'lifted-shortfall',
        predicate: f.predicate,
        kind: f.kind,
        value: said,
        quote: f.anchor_quote ?? null,
        why: 'a statement about the reading, reported as the run outcome rather than as a finding'
      })
    }
    facts = facts.filter((f) => f.predicate !== SHORTFALL_PREDICATE)
  }

  // ---- 4. persist + CHECK in ONE transaction (supersede-then-insert) -----
  interface Persisted {
    runId: number
    evCount: number
    /** Measurements discarded for naming no field in the target schema. */
    droppedOffSchema: number
    droppedWrongDimension: number
    demangledBounds: number
  }
  const persist = db.transaction((): Persisted => {
    // The facts of the OUTGOING run that this run did not ask about, read
    // BEFORE it is superseded.
    //
    // A narrowed run re-reads two of nine fields. The other seven were
    // extracted correctly and the whole point is not to redo them — but they
    // cannot simply be left on the outgoing run, because EVERY read path in the
    // app filters `superseded = 0`, so a value left behind would vanish from
    // the Extraction table and the exports the moment the new run committed.
    // That is the opposite of preserving it. So they are copied onto the new
    // run, and `fact.origin_run_id` keeps each copy pointing at the run that
    // actually produced it, so no row claims to be the output of a model call
    // that never saw it.
    const carried = narrowed ? readCarryForward(db, input, narrowed) : []

    // Mark any prior CURRENT run for (work,project,type,schema) superseded BEFORE
    // insert so the partial-unique index (superseded=0) never conflicts.
    //
    // `schema_id` joined the key in v15, and the supersede must name it too:
    // without it, extracting under a second schema would supersede the FIRST
    // schema's run, so a fan-out over N schemas would leave one surviving
    // analysis instead of N — the exact thing the column was added to allow.
    db.prepare(
      `UPDATE analysis_run SET superseded = 1
         WHERE work_id = ? AND project_id = ? AND analysis_type = ?
           AND schema_id = ? AND superseded = 0`
    ).run(input.workId, input.projectId, input.analysisType, input.schemaId ?? 0)

    const runInfo = db
      .prepare(
        `INSERT INTO analysis_run
           (work_id, project_id, analysis_type, schema_id, model, provider, prompt_version,
            schema_version, run_timestamp, verifier_result, deterministic_validation,
            supplied_project_context, superseded, doc_input_hash, prompt_input_hash,
            schema_input_hash, dossier_input_hash, field_hashes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.workId,
        input.projectId,
        input.analysisType,
        input.schemaId ?? 0,
        // THE MODEL THAT ANSWERED, not the one the provider was built with.
        //
        // `provider.model` is whatever the gateway offered when the provider was
        // constructed; the model the settings name is passed per CALL and
        // overrides it. Storing the construction default meant a run could claim
        // a model that never read the paper — provenance asserting the opposite
        // of what happened, in the one field that must never be a guess. It also
        // made a model change invisible: two runs under different models were
        // stamped identically and read as the same experiment.
        budget.model ?? provider.model,
        provider.name,
        prompt.version,
        SCHEMA_VERSION,
        now,
        verifier,
        // 0: nothing has judged this run's content yet. The `review-records`
        // stage restamps it once a reader has answered its questions.
        0,
        input.suppliedProjectContext ?? null,
        docHash,
        promptInputHash,
        schemaInputHash,
        dossierInputHash,
        fieldHashes,
        now
      )
    const runId = Number(runInfo.lastInsertRowid)
    // From here every anchor and every claim carries the run they belong to, so
    // one paper's trace can be split by run rather than read as one long list
    // of facts from two schemas that happen to be adjacent in the file.
    addDevLogScope({ analysisRunId: runId })

    const insEvidence = db.prepare(
      `INSERT INTO evidence_span
         (analysis_run_id, document_id, page, section, paragraph, sentence, quote, verbatim, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const insFact = db.prepare(
      `INSERT INTO fact
         (analysis_run_id, evidence_span_id, kind, predicate, subject, object, value_text,
          field_id, origin_run_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const insMeasStmt = db.prepare(
      `INSERT INTO measurement
         (fact_id, field_id, quantity, value_num, value_text, unit, error_num, conditions,
          unit_canonical, value_canonical, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    /**
     * Every measurement is written twice over: once exactly as the paper
     * reported it, and once reduced to a canonical unit so it can be compared
     * with the same quantity from another paper. The raw columns are the
     * record; the canonical ones are derived and may be recomputed at will.
     */
    const insMeas = {
      run: (
        factId: number,
        fieldId: number | null,
        quantity: string,
        valueNum: number | null,
        valueText: string | null,
        unit: string | null,
        errorNum: number | null,
        conditions: string | null,
        createdAt: string
      ) => {
        const c = canonicaliseMeasurement(valueNum, unit)
        return insMeasStmt.run(
          factId,
          fieldId,
          quantity,
          valueNum,
          valueText,
          unit,
          errorNum,
          conditions,
          c.unit,
          c.value,
          createdAt
        )
      }
    }
    const insFold = db.prepare(
      `INSERT INTO fold_improvement
         (measurement_id, baseline_label, improved_label, fold, comparability, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )

    let evCount = 0
    let droppedOffSchema = 0
    let droppedWrongDimension = 0
    let demangledBounds = 0
    for (const f of facts) {
      // WHICH FIELD, from the ONE place that binds it.
      //
      // `field_key` is on the fact, and `buildAnalysisOutputSchema` has already
      // refused any fact that did not name a declared key, so this lookup is
      // exact and case-sensitive with nothing to fall back to. The former
      // fallback — reading the key out of `predicate` — was a synonym rule in
      // disguise; the model is asked instead.
      const fieldKey = f.field_key ?? null
      const fieldId = (fieldKey ? fieldIdByKey.get(fieldKey) : undefined) ?? null
      // A SCHEMA-TARGETED run stores only what that schema asked for. Unguided
      // runs (`schemaId` null) keep everything: with no schema there is no scope
      // to be outside of.
      const outOfScope = input.schemaId != null && fieldId === null
      if (outOfScope) {
        droppedOffSchema++
        logClaim({
          outcome: 'dropped-off-schema',
          predicate: nameOf(f),
          kind: f.kind,
          subject: f.subject ?? null,
          object: f.object ?? null,
          value: f.value_text ?? (f.value_num == null ? null : String(f.value_num)),
          unit: f.unit ?? null,
          quote: f.anchor_quote ?? null,
          fieldKey,
          fieldUnit: fieldKey ? fieldUnitByKey.get(fieldKey) ?? null : null,
          claimedParagraph: f.paragraph ?? null,
          why: fieldKey
            ? `no field of the target schema is named '${fieldKey}', so the value is out of this run's scope`
            : 'the fact named no schema field, so there is nothing to file it under'
        })
        continue
      }

      let evidenceSpanId: number | null = null
      if (f.anchor_quote || f.section || f.page != null || f.paragraph != null) {
        // Anchor the quote to a paragraph/sentence offset when possible, and
        // RECORD WHETHER THAT SUCCEEDED. The model's anchor is stored either way
        // (dropping it would lose what the model claimed to be citing), but text
        // we could not find in the document is NOT verbatim evidence and must
        // never be displayed as though the paper said it. `verbatim` is the
        // exact-substring result and nothing else — no fuzzy or normalised match
        // is allowed to set it, because a near-match is precisely the case where
        // the model has silently reworded the source.
        //
        // A fact with NO anchor and a paragraph is the honest image-only case:
        // `verbatim` stays 0, `quote` stays NULL, and the span points at the
        // paragraph, which is what the UI highlights instead of a phrase.
        let paraIdx: number | number[] | null = f.paragraph ?? null
        let verbatim = 0
        if (f.anchor_quote) {
          const hit = locateQuote(f.anchor_quote, paragraphs, f.paragraph)
          if (hit !== null) {
            // ONLY a contiguous, UNAMBIGUOUS run earns `verbatim`. A `stitched`
            // match found every piece of the anchor inside the paragraphs the
            // model named — a real table reading, worth keeping — but the page
            // never printed that string, so a reader sent to find it will not.
            // An `ambiguous` one is printed in several places at once, so a
            // highlight drawn from it would land somewhere arbitrary; the repair
            // loop asks for a longer anchor, and anything that still arrives here
            // ambiguous is recorded as unverified rather than as evidence.
            verbatim = hit.match === 'contiguous' && !hit.ambiguous ? 1 : 0
            // The LOCATED paragraph wins over the model's claim, always.
            // locateQuote has already proved the anchor is inside the set the
            // model named; this only records WHICH member holds it.
            paraIdx = hit.paragraph
          }
        }
        // The anchor, the paragraph the model CLAIMED, and the paragraph we
        // actually resolved to — together, because a value whose evidence does
        // not support it is either a model that cited the wrong line or a
        // locator that matched the wrong paragraph, and neither field alone
        // distinguishes them.
        logAnchor({
          predicate: nameOf(f),
          value: f.value_text ?? f.object ?? null,
          quote: f.anchor_quote ?? null,
          claimedParagraph: f.paragraph ?? null,
          resolvedParagraph: typeof paraIdx === 'number' ? paraIdx : null,
          located: verbatim === 1,
          resolvedText:
            typeof paraIdx === 'number' && paragraphs[paraIdx]
              ? paragraphs[paraIdx].text.slice(0, 400)
              : null
        })
        // ONE paragraph id, never the array. `evidence_span.paragraph` is a
        // single INTEGER, and better-sqlite3 SPREADS an array into extra bind
        // parameters — so a fact citing [14, 34] threw "Too many parameter
        // values were provided" and took the whole transaction, and therefore
        // the whole paper, with it. The FIRST id is where the evidence begins,
        // which is what locateQuote already anchors to; the full claim survives
        // in the dev log.
        const paraCol = toDocumentParagraphIdx(
          Array.isArray(paraIdx) ? (paraIdx[0] ?? null) : paraIdx
        )
        const ev = insEvidence.run(
          runId,
          input.documentId ?? null,
          f.page ?? null,
          f.section ?? null,
          paraCol,
          f.sentence ?? null,
          f.anchor_quote ?? null,
          verbatim,
          now
        )
        evidenceSpanId = Number(ev.lastInsertRowid)
        evCount++
      }

      // A comparator the text layer destroyed is still a comparator.
      //
      // `>95 °C` reaches us as `N 95`, and read as a bare figure the bound
      // becomes a point measurement that ranks, averages and compares against
      // real results. The RAW text stays exactly as the model reported it — the
      // ontology requires what the paper said to survive — and only the derived
      // `value_num` is withdrawn, which is the same treatment an intact `≥ 160`
      // already gets.
      const mangledFigure = mangledBoundFigure(f.value_text ?? null)
      const isMangledBound =
        f.value_num !== null &&
        f.value_num !== undefined &&
        mangledFigure !== null &&
        Math.abs(mangledFigure - f.value_num) < 1e-9
      if (isMangledBound) demangledBounds++

      const factInfo = insFact.run(
        runId,
        evidenceSpanId,
        f.kind,
        nameOf(f),
        f.subject ?? null,
        f.object ?? null,
        f.value_text ?? null,
        fieldId,
        // NULL: this run produced it, which is the ordinary case.
        null,
        now
      )
      const factId = Number(factInfo.lastInsertRowid)

      // The fate of every claim, one event. `kept` is logged as loudly as a drop
      // because the ledger has to ADD UP: a reader must be able to see that
      // every claim the model returned is accounted for exactly once, or an
      // absent event is ambiguous between "not returned" and "silently lost by a
      // path nobody instrumented".
      logClaim({
        outcome: 'kept',
        predicate: nameOf(f),
        kind: f.kind,
        subject: f.subject ?? null,
        object: f.object ?? null,
        value: f.value_text ?? (f.value_num == null ? null : String(f.value_num)),
        unit: f.unit ?? null,
        quote: f.anchor_quote ?? null,
        fieldKey,
        fieldUnit: fieldKey ? fieldUnitByKey.get(fieldKey) ?? null : null,
        claimedParagraph: f.paragraph ?? null
      })

      // The `measurement` ROW, derived from the fact.
      //
      // The nested `measurement` object the model used to send is gone — one
      // binding site, on the fact — but the TABLE stays: it carries
      // `unit_canonical`/`value_canonical`, maintained by the v35 triggers, and
      // many reads join it. So a row is written whenever the fact carries
      // anything quantitative. A purely textual fact (a variant name, a buffer)
      // gets none, and needs none: its value is on the fact.
      const isQuantitative =
        f.value_num != null || f.unit != null || f.error_num != null || f.fold != null
      if (isQuantitative) {
        const measInfo = insMeas.run(
          factId,
          fieldId,
          nameOf(f),
          isMangledBound ? null : f.value_num ?? null,
          f.value_text ?? null,
          f.unit ?? null,
          f.error_num ?? null,
          f.conditions ?? null,
          now
        )
        if (f.fold) {
          insFold.run(
            Number(measInfo.lastInsertRowid),
            f.fold.baseline_label,
            f.fold.improved_label,
            f.fold.fold ?? null,
            f.fold.comparability ?? 'unclear',
            now
          )
        }
      }
    }
    // The kept fields, re-attached to the run that is now current.
    //
    // Timestamps are the ORIGINALS. A copy made to preserve a value must not
    // restate when it was extracted — `created_at` is the only record of how
    // old a claim is, and stamping it `now` would make every carried value look
    // freshly read from the paper.
    for (const c of carried) {
      let evId: number | null = null
      if (c.evidence) {
        evId = Number(
          insEvidence.run(
            runId,
            c.evidence.document_id,
            c.evidence.page,
            c.evidence.section,
            c.evidence.paragraph,
            c.evidence.sentence,
            c.evidence.quote,
            c.evidence.verbatim,
            c.evidence.created_at
          ).lastInsertRowid
        )
        evCount++
      }
      const fId = Number(
        insFact.run(
          runId,
          evId,
          c.fact.kind,
          c.fact.predicate,
          c.fact.subject,
          c.fact.object,
          c.fact.value_text,
          c.fact.field_id,
          c.originRunId,
          c.fact.created_at
        ).lastInsertRowid
      )
      for (const m of c.measurements) {
        const mId = Number(
          insMeas.run(
            fId,
            m.field_id,
            m.quantity,
            m.value_num,
            m.value_text,
            m.unit,
            m.error_num,
            m.conditions,
            m.created_at
          ).lastInsertRowid
        )
        if (m.fold) {
          insFold.run(
            mId,
            m.fold.baseline_label,
            m.fold.improved_label,
            m.fold.fold,
            m.fold.comparability,
            m.fold.created_at
          )
        }
      }
    }

    return {
      runId,
      evCount,
      droppedOffSchema,
      droppedWrongDimension,
      demangledBounds
    }
  })

  const {
    runId,
    evCount,
    droppedOffSchema,
    droppedWrongDimension,
    demangledBounds
  } = persist()

  // The ledger, once the numbers are final. It answers the summary question —
  // "zero facts, and the model said nothing" versus "zero facts, and we
  // discarded eleven" — that the per-claim events answer in detail.
  logClaimLedger({
    analysisType: input.analysisType,
    analysisRunId: runId,
    schemaId: input.schemaId ?? null,
    modelReturned: modelFactCount,
    kept: facts.length,
    droppedUnanchored,
    droppedOffSchema,
    droppedWrongDimension,
    shortfalls,
    verifier,
    truncated
  })

  // AFTER the transaction commits, never inside it: a subscriber must only ever
  // see a run that is durable, and a mirror write inside a write transaction
  // would hold the DB lock across filesystem latency we do not control.
  // Fire-and-forget — a failing outlet cannot fail an analysis.
  emitAnalysisCommitted({
    workId: input.workId,
    projectId: input.projectId,
    analysisRunId: runId,
    analysisType: input.analysisType
  })

  return {
    analysisRunId: runId,
    factCount: facts.length,
    evidenceCount: evCount,
    verifierResult: verifier,
    droppedUnanchored,
    // Counted since the out-of-scope guard was written, and until now thrown
    // away — so the one number that explains an empty schema-targeted run was
    // the one number nobody could see. A run that read a kinetics paper against
    // a thermostability schema, found 19 kinetics values and kept none of them,
    // reported "0 fact(s)" indistinguishably from a run that read nothing.
    droppedOffSchema,
    droppedWrongDimension,
    demangledBounds,
    // Did the MODEL say the paper carries nothing for this schema, as opposed
    // to us discarding everything it said? The two look identical downstream
    // and mean opposite things about whether anything is wrong.
    modelReturnedNothing: modelFactCount === 0,
    shortfalls
  }
}

/** Convenience: run the pipeline then return the persisted run as a DTO. */
export async function runPipelineToDto(
  db: DB,
  provider: LlmProvider,
  input: PipelineInput,
  now: string
): Promise<AnalysisRunDTO> {
  const res = await runPipeline(db, provider, input, now)
  const runs = getWorkAnalyses(db, input.workId, input.projectId)
  const dto = runs.find((r) => r.id === res.analysisRunId)
  if (!dto) throw new Error(`analysis_run ${res.analysisRunId} not found after persist`)
  return dto
}
