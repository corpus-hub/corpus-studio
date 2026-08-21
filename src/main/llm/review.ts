// Questions about extracted records that only the PAPER can answer.
//
// WHY THIS FILE EXISTS. This is the ONLY engine that judges stored content. A
// question about an extracted record is put to a model that has the record, its
// evidence quote and the surrounding text in front of it — never to code that
// has not read the paper.
//
// THE RULE THIS IMPLEMENTS. A judgement that can be wrong in theory must not be
// rendered by a rule. Mechanical comparison of a model's words against a
// declared vocabulary flagged correct readings as errors ("CD spectroscopy"
// against the option `CD`), and a panel that flags correct values teaches the
// reader to ignore it — taking the genuine errors beside it down with it. So
// every such question is asked here, of a reader.
//
// Form, as opposed to content, is not judged at all: it is REQUIRED before
// storage. `repair.ts` hands a non-conforming answer back to the model until it
// conforms, and `pipeline.ts` drops any claim whose quote is not in the
// document. Neither is a verdict on stored data; both are preconditions for
// storing it.
//
// SELECTORS ARE NOT VERDICTS. The heuristics that used to FAIL a record now only
// decide which records get ASKED about. That is what makes them incapable of a
// false positive: a selector makes no claim. It costs a model call to be wrong,
// and the model's answer is what reaches the reader.
//
// A SEPARATE READING FROM THE EXTRACTION. The extractor is never handed its own
// output to grade — a model shown its own answer defends it. This runs as its
// own stage, with its own prompt version, over records that are already stored.
//
// THREE ANSWERS. `ok` / `problem` / `unclear` map onto the check vocabulary that
// already exists (`passed` / `failed` / `skipped`). An honest abstention is not
// a failure and does not fail a run.
//
// DOMAIN-NEUTRAL. Every question is built from the USER's field definitions and
// from the paper's own words. Nothing here names a discipline, a quantity or a
// unit.

import { createHash } from 'node:crypto'
import type { DB } from '../db/connection'
import { derivedColumnGaps, toDerivedRecords, type DerivedGap } from './derived'
import { canonicalUnit } from './units'

/** Which family a question belongs to — the same key its verdict is stored under. */
export type ReviewCheckKey =
  | 'field-type-number'
  | 'field-required-present'
  | 'field-unit-present'
  | 'field-unit-consistent'
  | 'field-unit-matches-quantity'
  | 'evidence-supports-value'
  | 'evidence-subject-match'
  | 'row-empty-cells'
  | 'duplicate-record'
  | 'cell-quantity-repeated'
  | 'cell-matches-page'
  | 'cell-second-reading'
  | 'cell-value-two-quantities'
  | 'error-bar-plausible'
  | 'value-outlier'
  | 'value-scale-consistent'
  | 'value-bound-not-figure'

/**
 * What each key ASKED, in the words a reader sees beside the verdict.
 *
 * Phrased as what a READING confirmed, not as what a rule asserted, because
 * that is what every one of these now is. Keys from retired engines may still
 * sit in `analysis_check`; a key absent here renders as itself rather than
 * nameless.
 */
export const CHECK_LABELS: Record<string, string> = {
  'evidence-supports-value': 'The paper states the value it is cited for',
  'evidence-subject-match': 'The passage is about the subject it is cited for',
  'field-type-number': 'The paper states a quantity for this field',
  'field-required-present': 'The paper reports the fields the schema requires',
  'field-unit-present': 'The paper states a unit for this value',
  'field-unit-consistent': 'The unit is the one the paper prints',
  'field-unit-matches-quantity': 'The unit measures the quantity the field names',
  'duplicate-record': 'The paper reports this measurement once',
  'cell-quantity-repeated': 'The paper states this quantity once for this subject and column',
  'cell-matches-page':
    'The page prints these figures at this subject and column, under these quantities',
  'cell-second-reading':
    'Two independent readings of this table agree about what is printed here',
  'cell-value-two-quantities': 'The paper states this number as one quantity, not two',
  'error-bar-plausible': 'The uncertainty is the one the paper prints',
  'value-outlier': 'The paper prints this number and unit',
  'value-scale-consistent': 'The paper states this scale for the column',
  'value-bound-not-figure': 'The paper states a figure, not a bound'
}

/**
 * One separately-answerable question about one record.
 *
 * `ask` states the question AND what shape a correct answer has, because vague
 * prompting is how the old checks got their confidence. `passage` is the paper's
 * own words around the record's evidence; without it the model would be guessing
 * exactly as the code was.
 */
export interface ReviewQuestion {
  /** Stable within one call. The model answers by this id. */
  id: string
  checkKey: ReviewCheckKey
  factId: number | null
  measurementId: number | null
  /** The question and its answer shape, already rendered. */
  ask: string
  /** The paper text the question is to be decided against, or null. */
  passage: string | null
  /**
   * True when the question is answered against the WHOLE paper, which the
   * conversation was opened with, rather than an excerpt of its own.
   *
   * Without this a null `passage` meant two different things — "no text could
   * be found for this record" and "the text is the document you already have" —
   * and `renderBatch` announced the first for both. A question about an EMPTY
   * cell was told the paper did not exist, and abstained while the paper sat one
   * turn above it.
   */
  usesConversationDocument?: boolean
  /**
   * Fingerprint of everything the answer depends on.
   *
   * NOT the record id — an id is stable across an edit that changes the answer,
   * and that is exactly backwards. What goes in is the check, the rendered
   * question (which carries the stored value, unit, subject and conditions) and
   * the paper text it is decided against, so re-extracting a value or
   * re-segmenting the page changes it and a mere re-plan does not.
   *
   * The prompt version is folded in by the CALLER, so a prompt edit reopens
   * every question without this file having to know about the registry.
   */
  inputHash: string
}

function questionHash(
  checkKey: string,
  factId: number | null,
  measurementId: number | null,
  ask: string,
  passage: string | null
): string {
  return createHash('sha256')
    .update(
      [checkKey, String(factId ?? ''), String(measurementId ?? ''), ask, passage ?? ''].join('\u0000')
    )
    .digest('hex')
    .slice(0, 32)
}

/**
 * The stored key for one asked question: its own fingerprint plus the prompt
 * that will answer it. A prompt edit must reopen every question, or the cache
 * serves answers made under wording that no longer exists.
 */
export function reviewInputHash(q: ReviewQuestion, promptVersion: string): string {
  return createHash('sha256')
    .update(`${q.inputHash}\u0000${promptVersion}`)
    .digest('hex')
    .slice(0, 32)
}

export interface ReviewVerdict {
  checkKey: ReviewCheckKey
  factId: number | null
  measurementId: number | null
  status: 'passed' | 'failed' | 'skipped'
  reason: string
}

// ------------------------------------------------------------------ row shapes
interface FactRow {
  id: number
  predicate: string
  kind: string
  subject: string | null
  object: string | null
  value_text: string | null
  /** Which schema field this fact answers. The fact's OWN link, not its measurement's. */
  field_id: number | null
  quote: string | null
  paragraph: number | null
  span_document_id: number | null
}

interface MeasRow {
  id: number
  fact_id: number
  field_id: number | null
  quantity: string
  value_num: number | null
  value_text: string | null
  unit: string | null
  error_num: number | null
  conditions: string | null
  subject: string | null
  quote: string | null
  paragraph: number | null
  span_document_id: number | null
  field_key: string | null
  field_label: string | null
  data_type: string | null
  field_unit: string | null
  required: number | null
}

/**
 * Words a paper puts in front of a magnitude without changing that a magnitude
 * follows. Used only to SELECT — a value that clearly reads as a quantity is not
 * worth a model call.
 */
const QUANTITY_QUALIFIER =
  /^(?:about|approx\.?|approximately|ca\.?|circa|around|up\s+to|at\s+least|at\s+most|over|under|less\s+than|greater\s+than|more\s+than|no\s+more\s+than)\s+/i

function readsAsQuantity(s: string): boolean {
  const t = s.trim()
  if (t !== '' && Number.isFinite(Number(t))) return true
  const stripped = t.replace(QUANTITY_QUALIFIER, '')
  const rest = stripped.replace(/^[~≈∼〜<>≤≥⩽⩾=±+\-\u2212\s]+/, '')
  return /^\d/.test(rest) || /^\.\d/.test(rest)
}

/**
 * A record REPORTING AN ABSENCE has no number because the paper found none.
 * Matched on the SHAPE of the phrase, never on a vocabulary of the domain, and
 * used only to skip asking — an absence is a result and there is no question.
 */
const ABSENCE_TEXT =
  /^(?:n\.?\s*d\.?|nd|no\s+[\w\s]*\b(?:detected|observed|activity|measured|conversion|turnover)\b[\w\s]*|not\s+(?:detected|detectable|observed|measurable|determined|reported|applicable|available|quantifiable)|below\s+(?:the\s+)?(?:limit|detection|quantitation)\b[\w\s]*|undetectable|absent|none\s+detected|n\/a)\.?$/i

function reportsAbsence(s: string | null | undefined): boolean {
  const t = (s ?? '').trim()
  return t !== '' && ABSENCE_TEXT.test(t)
}

/** Below this many comparators the corpus has no convention to compare against. */
const MIN_COMPARATORS = 5
/**
 * How many cells must agree on a shape before a shorter one is worth asking
 * about. Two or three cells agreeing is a coincidence, not a table's convention,
 * and a convention read off a coincidence puts a question behind every gap.
 */
const MIN_CELL_SHAPE = 4
/** How far outside the corpus's observed range a value must sit to be worth asking about. */
const OUTLIER_DECADES = 3
/** How far a whole run's median must sit from the corpus's to be worth asking about. */
const SCALE_DECADES = 2
/** Fewer values than this in a run is a coincidence, not a systematic shift. */
const MIN_SCALE_RUN_VALUES = 3

/** How much of the paper a question is decided against, around the cited paragraph. */
const PASSAGE_RADIUS = 1
/** A whole-paper question (a required field) may read this much of the body. */

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function describe(m: MeasRow): string {
  const bits = [`field "${m.field_label ?? m.quantity}"`]
  if ((m.subject ?? '').trim() !== '') bits.push(`subject "${(m.subject as string).trim()}"`)
  if ((m.conditions ?? '').trim() !== '')
    bits.push(`conditions "${(m.conditions as string).trim()}"`)
  return bits.join(', ')
}

// --------------------------------------------------------------- question build

/**
 * One run's measurements, with the field and span each belongs to.
 *
 * Shared by the question builder and by the blind-reading comparison, so the
 * two are matched over exactly the same rows: a second reading compared against
 * a differently-loaded set would disagree about records this review never asked
 * about.
 */
export function loadMeasurements(db: DB, analysisRunId: number): MeasRow[] {
  return db
    .prepare(
      /* sql */ `
      SELECT m.id, m.fact_id, m.field_id, m.quantity, m.value_num, m.value_text,
             m.unit, m.error_num, m.conditions AS conditions, f.subject AS subject,
             es.quote AS quote, es.paragraph AS paragraph,
             es.document_id AS span_document_id,
             ef.key AS field_key, ef.label AS field_label, ef.data_type AS data_type,
             ef.unit AS field_unit, ef.required AS required
      FROM measurement m
      JOIN fact f ON f.id = m.fact_id
      LEFT JOIN evidence_span es ON es.id = f.evidence_span_id
      LEFT JOIN extraction_field ef ON ef.id = m.field_id
      WHERE f.analysis_run_id = ?
      ORDER BY m.id ASC`
    )
    .all(analysisRunId) as MeasRow[]
}

/**
 * The fields of one extraction schema, in the order the user put them.
 *
 * One definition, used both to COMPOSE the row-shaped question and to resolve
 * the labels a finding comes back naming. A second query with its own ordering
 * would let the reviewer be shown one list and answer against another.
 */
function schemaFieldsOf(db: DB, schemaId: number | null): Array<{ id: number; label: string }> {
  if (schemaId == null) return []
  return db
    .prepare(
      `SELECT id, label FROM extraction_field WHERE schema_id = ? ORDER BY sort_order ASC, id ASC`
    )
    .all(schemaId) as Array<{ id: number; label: string }>
}

/**
 * Every question this run needs answered, with the paper text each is decided
 * against.
 *
 * Read-only. Producing NO questions is the normal outcome for a clean run and is
 * not a failure — nothing is stored for a question that was never worth asking.
 */
export function buildReviewQuestions(
  db: DB,
  analysisRunId: number
): ReviewQuestion[] {
  const facts = db
    .prepare(
      /* sql */ `
      SELECT f.id, f.predicate, f.kind, f.subject, f.object, f.value_text,
             f.field_id AS field_id,
             es.quote AS quote, es.paragraph AS paragraph,
             es.document_id AS span_document_id
      FROM fact f
      LEFT JOIN evidence_span es ON es.id = f.evidence_span_id
      WHERE f.analysis_run_id = ?
      ORDER BY f.id ASC`
    )
    .all(analysisRunId) as FactRow[]

  const measurements = loadMeasurements(db, analysisRunId)

  // The schema this run answered, and the paper it read — both resolved from the
  // run itself rather than passed in, so a caller cannot hand the reviewer a
  // different schema or a differently-assembled document than the extraction
  // saw. The body is joined the way `schema-extract` joins it (non-reference
  // paragraphs, blank line between), because a question decided against other
  // text is a question about a document that was never read.
  const runRow = db
    .prepare(`SELECT schema_id, work_id FROM analysis_run WHERE id = ?`)
    .get(analysisRunId) as { schema_id: number | null; work_id: number } | undefined
  const schemaFields = schemaFieldsOf(db, runRow?.schema_id ?? null)

  // Fact -> its measurement, for any selector that needs the numeric side.
  const measByFact = new Map<number, MeasRow>()
  for (const m of measurements) if (!measByFact.has(m.fact_id)) measByFact.set(m.fact_id, m)

  if (facts.length === 0 && measurements.length === 0) return []

  // Paragraph text, so a question can carry the paper's own words. Loaded once
  // for every document this run's spans point into.
  const paras = db
    .prepare(
      `SELECT document_id, idx, text FROM document_paragraph
        WHERE document_id IN (
          SELECT DISTINCT document_id FROM evidence_span WHERE analysis_run_id = ?
        )
        ORDER BY document_id ASC, idx ASC`
    )
    .all(analysisRunId) as Array<{ document_id: number; idx: number; text: string }>
  const paraByKey = new Map<string, string>()
  for (const p of paras) paraByKey.set(`${p.document_id}:${p.idx}`, p.text)

  /**
   * The paper around the cited paragraph, never the paragraph alone.
   *
   * A value in a table row is decided by the header two paragraphs up, and a
   * subject by the sentence before. Handing over the quote on its own would
   * reproduce the blindness this file exists to remove.
   */
  const passageFor = (
    documentId: number | null,
    paragraph: number | null,
    quote: string | null
  ): string | null => {
    const parts: string[] = []
    if (documentId !== null && paragraph !== null) {
      for (let i = paragraph - PASSAGE_RADIUS; i <= paragraph + PASSAGE_RADIUS; i++) {
        const t = paraByKey.get(`${documentId}:${i}`)
        if (t !== undefined) parts.push(t)
      }
    }
    if (parts.length === 0) {
      return quote === null || quote.trim() === '' ? null : `CITED QUOTE ONLY: ${quote.trim()}`
    }
    const body = parts.join('\n\n')
    return quote === null || quote.trim() === ''
      ? body
      : `CITED QUOTE: ${quote.trim()}\n\nSURROUNDING TEXT:\n${body}`
  }

  const out: ReviewQuestion[] = []
  let seq = 0
  const add = (
    checkKey: ReviewCheckKey,
    factId: number | null,
    measurementId: number | null,
    ask: string,
    passage: string | null,
    usesConversationDocument = false
  ): void => {
    out.push({
      id: `q${++seq}`,
      checkKey,
      factId,
      measurementId,
      ask,
      passage,
      usesConversationDocument,
      inputHash: questionHash(checkKey, factId, measurementId, ask, passage)
    })
  }

  const factById = new Map<number, FactRow>()
  for (const f of facts) factById.set(f.id, f)
  /** What this record says, in whichever column the pipeline could put it. */
  const recordedText = (m: MeasRow): string | null =>
    m.value_text ?? factById.get(m.fact_id)?.value_text ?? null

  const typed = measurements.filter((m) => m.field_id !== null && m.data_type !== null)

  // ---------------------------------------------------- a numeric field's value
  //
  // The check that produced `"N 95 °C" states no quantity at all`. Whether that
  // text is a quantity is a question about what the paper printed, and the
  // record is only wrong if the paper prints a number this failed to capture.
  for (const m of typed) {
    if (m.data_type !== 'number' || m.value_num !== null) continue
    const t = recordedText(m)
    if (reportsAbsence(t)) continue
    if (t !== null && readsAsQuantity(t)) continue
    add(
      'field-type-number',
      m.fact_id,
      m.id,
      `This record fills ${describe(m)}, which the schema declares NUMERIC. It stored no number; ` +
        `the text it holds is ${t === null ? '(nothing)' : `"${t}"`}.\n` +
        'QUESTION: does the passage state a numeric quantity for this field and subject?\n' +
        'Answer "ok" if the stored text is a faithful reading of what the paper prints — including a ' +
        'bound, an approximation, a range, an order of magnitude, an uncertainty, or a value whose ' +
        'characters the text layer damaged — or if the paper reports no value here (a reported ' +
        'absence is a result, not a gap).\n' +
        'A DEFINITE QUANTITY is what the paper prints when a reader could copy one number out of it. ' +
        'A bound, an approximation or a range is NOT one: the paper deliberately did not commit to a ' +
        'figure, and storing the words rather than inventing a number is the right outcome. If your ' +
        'reason would have to say the stored text is a mangled rendering of what the paper prints, ' +
        'the answer is "ok".\n' +
        'THE TWO ABOVE COMBINE, and that is where this question is most often got wrong. A number the ' +
        'paper qualifies — with an approximation sign, a greater-than, a less-than, or any mark whose ' +
        'character the text layer replaced with a letter or dropped — is STILL a qualified number after ' +
        'you have worked out what the mark was. Recovering the mark makes the record MORE right, not ' +
        'less. If your note would name such a mark, or would say the paper prints the number ' +
        '"approximately" or "greater than", then the paper did not commit to a figure and the answer ' +
        'is "ok".\n' +
        'Answer "problem" ONLY if the paper prints a definite quantity for this field and subject that ' +
        'this record failed to capture. Say in your note what the paper printed.',
      passageFor(m.span_document_id, m.paragraph, m.quote)
    )
  }

  // ---------------------------------------------------------------- a bare unit
  for (const m of typed) {
    if ((m.field_unit ?? '').trim() === '') continue
    if ((m.unit ?? '').trim() !== '') continue
    if (m.value_num === null && reportsAbsence(recordedText(m))) continue
    add(
      'field-unit-present',
      m.fact_id,
      m.id,
      `This record fills ${describe(m)} with ` +
        `${m.value_num === null ? `"${recordedText(m) ?? ''}"` : String(m.value_num)} and carries NO unit, ` +
        `though the schema says this field is reported in "${m.field_unit}".\n` +
        'QUESTION: does the passage state a unit for this value?\n' +
        'Answer "problem" if the paper prints a unit here that the record dropped — say which. ' +
        'Answer "ok" if the paper states the value without a unit (a ratio, a count, a dimensionless ' +
        'quantity, or a unit given only in a table header you cannot see).',
      passageFor(m.span_document_id, m.paragraph, m.quote)
    )
  }

  // ------------------------------------------------- a unit unlike the corpus's
  //
  // The check that reported `"m  1 s  1"` as a different unit from `M^-1 s^-1`.
  // They are the same unit; the second one's superscripts did not survive the
  // text layer. Only a reader can tell that from a genuine unit disagreement.
  {
    const canonOf = (u: string | null): string => {
      const c = canonicalUnit(u)
      return c.recognised ? c.unit : (u ?? '').trim()
    }
    for (const m of typed) {
      if ((m.unit ?? '').trim() === '') continue
      const raw = db
        .prepare(
          /* sql */ `
          SELECT m2.unit AS unit, COUNT(*) AS c
          FROM measurement m2
          JOIN fact f2 ON f2.id = m2.fact_id
          JOIN analysis_run r2 ON r2.id = f2.analysis_run_id
          WHERE m2.field_id = ? AND f2.analysis_run_id <> ?
            AND r2.superseded = 0
            AND m2.unit IS NOT NULL AND trim(m2.unit) <> ''
          GROUP BY m2.unit ORDER BY c DESC, m2.unit ASC`
        )
        .all(m.field_id, analysisRunId) as Array<{ unit: string; c: number }>
      const grouped = new Map<string, { c: number; label: string }>()
      for (const r of raw) {
        const key = canonOf(r.unit)
        const prev = grouped.get(key)
        if (prev === undefined) grouped.set(key, { c: r.c, label: r.unit })
        else prev.c += r.c
      }
      const rows = [...grouped.entries()].sort((a, b) => b[1].c - a[1].c)
      const total = rows.reduce((s, r) => s + r[1].c, 0)
      if (total < MIN_COMPARATORS) continue
      const [dominantUnit, dominant] = rows[0]
      if (dominant.c / total < 0.8) continue
      if (dominantUnit === canonOf(m.unit)) continue
      add(
        'field-unit-consistent',
        m.fact_id,
        m.id,
        `This record fills ${describe(m)} with a unit stored as "${m.unit}". Everywhere else in this ` +
          `library the same field is recorded in "${dominant.label}".\n` +
          'QUESTION: is the stored unit the SAME unit as the one used elsewhere, or a genuinely different one?\n' +
          'Answer "ok" if the two are the same unit differently spelled. That includes: the stored ' +
          'spelling being what a PDF text layer leaves behind after destroying superscripts, signs or ' +
          'spacing; the terms being written in a DIFFERENT ORDER (a product of units is the same ' +
          'unit whichever way round its terms are printed); a different punctuation, casing or ' +
          'bracketing of the same terms.\n' +
          'Answer "problem" ONLY if the paper prints a unit that differs in SCALE (a different ' +
          'prefix) or in DIMENSION (it measures a different kind of quantity) from what was stored. ' +
          'If your reason would have to say the two mean the same thing, the answer is "ok". Say ' +
          'what the paper printed.',
        passageFor(m.span_document_id, m.paragraph, m.quote)
      )
    }
  }

  // ------------------------------------- the record disagrees with ITSELF
  //
  // A record whose UNIT contradicts the QUANTITY it was filed under. `230,000
  // M⁻¹s⁻¹` was stored as a Michaelis constant, a concentration, with the
  // catalytic efficiency printed in its own quote; twenty-four activation free
  // energies in kcal/mol were filed as turnover numbers in s⁻¹. Every one had a
  // verbatim quote, so nothing downstream had any reason to doubt it.
  //
  // The comparison only ADMITS the question — it never decides it. That
  // distinction is the whole reason the old `dimensionsCompatible` had to go:
  // deciding mechanically threw away four correct readings of a paper that
  // answered a `M^-1 s^-1` field with a fold-change, because a field's declared
  // unit is what the USER expects and not a law the paper agreed to. So the
  // reader is asked, holding the quote and the page, and a disagreement that
  // turns out to be the paper answering in its own terms is answered "ok" and
  // the record stands. What cannot happen any more is the contradiction
  // reaching a scientist with nobody having looked at it.
  //
  // `recognised` on BOTH sides is required: a unit this app cannot decompose
  // says nothing about dimensions, and asking about it would put a question
  // behind every unusual spelling.
  {
    for (const m of typed) {
      if ((m.unit ?? '').trim() === '' || (m.field_unit ?? '').trim() === '') continue
      const stored = canonicalUnit(m.unit)
      const declared = canonicalUnit(m.field_unit)
      if (!stored.recognised || !declared.recognised) continue
      if (stored.unit === declared.unit) continue
      add(
        'field-unit-matches-quantity',
        m.fact_id,
        m.id,
        `This record fills ${describe(m)} — a field the schema reports in ` +
          `"${m.field_unit}" — with ${m.value_num ?? recordedText(m) ?? ''} in "${m.unit}", which ` +
          'measures a different kind of quantity.\n' +
          'QUESTION: does the passage report this value AS the quantity that field names?\n' +
          'Answer "ok" if the paper genuinely answers this field in these terms — a comparison, a ' +
          'ratio, a fold-change or a related quantity the authors use in place of the one the field ' +
          'names — or if the two units are the same unit differently spelled or scaled. A field\u2019s ' +
          'declared unit is what the reader expects, not a rule the paper agreed to.\n' +
          'Answer "problem" if the passage is reporting a DIFFERENT quantity from the one this record ' +
          'claims — most often a neighbouring column, row or line of the same table. Say which ' +
          'quantity the passage actually states, and what its value is.',
        passageFor(m.span_document_id, m.paragraph, m.quote)
      )
    }
  }

  // ---------------------------------------------- the quote and the value agree
  //
  // Whether a passage states the value cited for it is a reading task: the same
  // number appears rounded, converted, spelled out, or with its separators eaten
  // by the text layer, and the code's ladder of tolerances is a list of the ways
  // it has been wrong so far.
  {
    for (const f of facts) {
      // NO LENGTH GATE. A short quote is the NORMAL shape of a table cell —
      // "123.2 ± 0.8" is eleven characters — so a 12-character floor silently
      // excused 26 of one paper's 35 unreviewed facts, and they were the
      // numeric cells the table is actually made of.
      if (f.quote === null || f.quote.trim() === '') continue
      // `supplied-by-project-context` does not claim to come from this document
      // at all, so its quote is context, not evidence for the number.
      if (f.kind === 'supplied-by-project-context') continue
      const m = measByFact.get(f.id)
      const value = m?.value_num ?? null
      const quote = f.quote
      // A TEXT VALUE IS A CLAIM TOO, AND WAS UNREACHABLE HERE.
      //
      // This selector read the measurement, so a fact without a NUMBER could not
      // be asked about by any path: on one paper 46 of 79 facts — every variant,
      // substrate and method — were structurally invisible, and the stage wrote
      // `problems: 0` beside a value that appears nowhere in the document. A
      // question never asked is indistinguishable from one that passed, which
      // makes a clean review report the most expensive kind of wrong.
      //
      // So the value under review is the number when there is one and the stored
      // text otherwise, and the arithmetic shortcut below stays keyed to the
      // number, because it is only ever about digits.
      const shown = value !== null ? String(value) : (f.value_text ?? f.object ?? '').trim()
      if (shown === '') continue
      // A QUOTE PRINTING THE NUMBER SETTLES THE DIGITS, NOT THE MEANING.
      //
      // This skipped every fact whose quote already showed its value, on the
      // reasoning that the digits are self-evident. They are — and the digits
      // were never the failure. What goes wrong is a number that is real,
      // printed, and correctly copied, standing for a DIFFERENT quantity than
      // the field it was filed under: a screening range recorded as an assay
      // condition, a molarity recorded as a temperature. Skipping the facts
      // whose quotes look convincing is skipping exactly the ones this check
      // exists for.
      //
      // The arithmetic trap it was protecting against is handled in the
      // question instead, which now tells the reader that a difference in
      // notation is not a difference in value.
      const unit = (m?.unit ?? '').trim()
      add(
        'evidence-supports-value',
        f.id,
        m?.id ?? null,
        `This record stores ${shown}${unit === '' ? '' : ` ${unit}`} ` +
          `as the ${m ? describe(m) : `"${f.predicate}"`}` +
          `${f.subject ? ` of "${f.subject}"` : ''}, citing the passage below.\n` +
          'QUESTION: is that what the passage says this is?\n' +
          'Two things have to hold, and the second is the one that fails.\n' +
          'FIRST, the value. Answer "ok" if the passage carries it in any form a reader ' +
          'would accept — rounded, spelled out, in another scale or unit, in the paper\u2019s ' +
          'own wording rather than this one, or with digits, separators and signs the text ' +
          'layer mangled. Scientific notation written out is the same number as its plain ' +
          'form. If your reason would have to say the two are equal, they are equal.\n' +
          'SECOND, and this is the point of the question: is the value being used for what ' +
          'the passage uses it for? A figure can be printed exactly, quoted exactly, and ' +
          'still be the WRONG QUANTITY — a range of settings that were tried is not the ' +
          'setting a result was obtained at; a concentration is not a temperature; a value ' +
          'reported for one specimen is not a value for its neighbour. Read what the ' +
          'sentence is doing with the number, and say whether this record is doing the ' +
          'same thing with it.\n' +
          'Answer "problem" if the passage does not support this reading — because it gives ' +
          'a different value, because the number it gives means something else, or because ' +
          'it does not speak about this subject. Say what the passage actually reports.\n' +
          'Answer "unclear" if the passage genuinely does not settle it. Do not reason from ' +
          'what is usual in the field; the passage is the only evidence.',
        passageFor(f.span_document_id, f.paragraph, quote)
      )
    }
  }

  // ---------------------------------------------------- a row's empty cells
  //
  // ONE QUESTION PER ROW, NOT PER CELL.
  //
  // Every check above judges a fact that EXISTS. Nothing asked about the cells
  // that do not — and an empty cell has two meanings a reader cannot tell apart:
  // the paper says nothing, or the reading missed it. On this corpus that was
  // seven subjects carrying a buffer with no pH beside it, and one subject
  // carrying a temperature its eleven neighbours also shared.
  //
  // Asked per ROW because a row is how the paper reads: the model judging an
  // empty pH can see that the same row already carries a buffer, and the
  // sentence that gave one usually gives the other. Sixty-seven separate
  // questions cost more and know less.
  //
  // NOTHING HERE NAMES A FIELD. The question is built from the schema's own
  // labels, so it asks the same thing of a kinetics table and a solar cell, and
  // the app never learns what any column means. It also states no expectation:
  // it does not say a value ought to be there, only asks whether the paper
  // gives one. A rule like "a value that applies to many rows should be on all
  // of them" would spread a footnote's exception across the table — this asks,
  // and the paper answers.
  //
  // ONE ROW IS ONE SET OF MEASUREMENTS, AND A SUBJECT MAY HAVE SEVERAL.
  //
  // Grouped on the subject ALONE, this composed a row that does not exist on the
  // page: a subject whose values were measured under two different sets of
  // circumstances — a table row plus a footnote giving another set for the same
  // label — was shown as one row carrying both, and the reader answering it
  // wrote a value belonging to one set beside facts from the other. The key is
  // therefore (subject, conditions), which is the key the second-reading
  // comparison already matches cells on, and one question carries one block per
  // set so the reader can see which is which. Splitting into separate QUESTIONS
  // instead would lose exactly what the row shape is for — a reader judging one
  // set can see what the other already holds.
  if (schemaFields.length > 0) {
    const bySubject = new Map<string, Map<string, Map<number, string>>>()
    for (const f of facts) {
      const subj = (f.subject ?? '').trim()
      if (subj === '' || f.field_id === null) continue
      const shown = (f.value_text ?? f.object ?? '').trim()
      const m = measByFact.get(f.id)
      const val = shown !== '' ? shown : m?.value_num != null ? String(m.value_num) : ''
      if (val === '') continue
      // A fact with no conditions forms its OWN block rather than joining one:
      // "measured under nothing stated" is a different claim from "measured
      // under these", and folding the first into the second would put a value
      // under circumstances nobody recorded for it.
      const cond = (m?.conditions ?? '').trim()
      let blocks = bySubject.get(subj)
      if (!blocks) bySubject.set(subj, (blocks = new Map()))
      let row = blocks.get(cond)
      if (!row) blocks.set(cond, (row = new Map()))
      if (!row.has(f.field_id)) row.set(f.field_id, val)
    }
    for (const [subj, blocks] of bySubject) {
      const rendered: string[] = []
      let anyEmpty = false
      for (const [cond, filled] of blocks) {
        const empty = schemaFields.filter((f: { id: number }) => !filled.has(f.id))
        if (empty.length > 0) anyEmpty = true
        const has = schemaFields
          .filter((f) => filled.has(f.id))
          .map((f) => `    ${f.label}: ${filled.get(f.id) as string}`)
          .join('\n')
        rendered.push(
          `  SET — conditions: ${cond === '' ? 'none recorded' : JSON.stringify(cond)}\n` +
            `  recorded:\n${has}\n` +
            `  recorded NOTHING for: ${
              empty.length === 0 ? '(nothing — every column is filled)' : empty.map((f) => f.label).join(', ')
            }`
        )
      }
      if (!anyEmpty) continue
      add(
        'row-empty-cells',
        null,
        null,
        `This reading of the paper recorded, for "${subj}":\n\n${rendered.join('\n\n')}\n\n` +
          `QUESTION: does the paper state a value for any cell recorded as empty above, for "${subj}"?\n` +
          'Answer "ok" if the paper does not give them. A paper that does not report ' +
          'something owes nothing, and an empty cell is the honest record of that — ' +
          'this is the ordinary answer and it is not a fault.\n' +
          'Answer "problem" ONLY for a value you can point at in the paper, and put ' +
          'each one in "found" — an array of objects, one per value:\n' +
          '  {"field": <the column label exactly as listed above>,\n' +
          `   "subject": "${subj}",\n` +
          '   "conditions": <the conditions of the block it belongs to, copied exactly, ' +
          'or the paper\u2019s own words for the circumstances>,\n' +
          '   "value": <the value as the PAGE prints it>,\n' +
          '   "quote": <the sentence that prints it, copied from the paper>,\n' +
          '   "basis": "stated" or "calculated"}\n' +
          'Use "stated" when the paper prints this value FOR THIS CELL — in the ' +
          'column being asked about, for this row. That is nearly always the answer.\n' +
          'Use "calculated" when the paper does not print it there but you worked it ' +
          'out in ONE easy step from what it does print — one subtraction, one ratio, ' +
          'or a value carried from a neighbouring cell because it must hold here too. ' +
          'Quote the words you worked from.\n' +
          'The second case is easy to miss when the words you would write are already ' +
          'on the page: a mark that covers several columns has an edge, and reading it ' +
          'as covering one more is a step you took, not something the paper printed. ' +
          'Where you carried a value across that edge, say "calculated" and say why in ' +
          'your reason. It is a claim a reader will confirm, and it is worth ' +
          'recording — but it is yours, not the paper\u2019s.\n' +
          'If getting to the value needs a real formula, or more than a step or two, ' +
          'do NOT report it at all: leave the cell empty and say so in your reason.\n' +
          'A finding without a quote is an assertion, so every one needs its own.\n' +
          // WHOSE VALUE IT IS. Both halves of this were one sentence, the second
          // hedging the first, and the hedge is what got acted on: four rows were
          // left empty with the reason "not restated for this row", about a value
          // the paper states once for everything it measured. Not repeating a
          // value is how papers are written; it is not a statement that the value
          // does not apply. Parallel now, and the disqualifier is positive
          // evidence — the paper attached it elsewhere — rather than the absence
          // of a repetition.
          'A value is THIS ROW\u2019S when the paper attaches it to this row: directly, ' +
          'or by a statement covering the set this row belongs to. A study naming ' +
          'one material, one instrument or one procedure for all its measurements ' +
          'has stated it for every row it made; it does not owe you a repetition ' +
          'beside each one, and the absence of a repetition is not the absence of ' +
          'the value.\n' +
          'A value is NOT this row\u2019s when the paper attaches it to something else — ' +
          'another row, or measurements made under conditions this row was not ' +
          'measured under. That is what disqualifies a value, and the only thing ' +
          'that does.\n' +
          // WHAT A ROW IS. The reader wrote values that are printed, quoted and
          // real, into rows that cannot hold them at the same time as what was
          // already there — because nothing said that the cells listed are one
          // simultaneous set rather than a shopping list of columns to fill.
          // States what the slot MEANS; it reaches no conclusion for the reader
          // and names no quantity.
          'The cells listed above are not a list of unrelated values. They are one row, and\n' +
          'a row describes one set of measurements: everything recorded there was true at\n' +
          'the same time, of the same thing. A value that cannot hold at the same time as\n' +
          'one already in the row is therefore not this row\u2019s value, however plainly the\n' +
          'paper prints it — it belongs to some other row, or to a set of measurements this\n' +
          'row is not part of, and you should leave the cell empty and say in your reason\n' +
          'where you think it belongs.\n' +
          '\n' +
          'Each block above is one such set, and its heading says which. A value you report\n' +
          'goes in "conditions" under the heading of the block it belongs to, copied as the\n' +
          'question printed it. Where the paper gives a value that fits none of the blocks\n' +
          'shown, put the paper\u2019s own words for its circumstances there instead. A finding\n' +
          'with no "conditions" is a claim that the value holds for every block listed, so\n' +
          'send that only when the paper says as much.\n' +
          // A field that RE-ASKS the subject: the reader filled it from a broader
          // label the page also prints, which manufactures a fact saying a row is
          // its own group. The extraction prompt carries the same rule; this is
          // the reviewer's half of it.
          'A field that names the row rather than measuring it is answered with the subject\n' +
          'exactly as this question names it above, never with a broader label the page also\n' +
          'prints; if it would say anything else, the cell is not empty for want of a value.\n' +
          'Do not reason from what is usual; the paper is the only evidence.',
        // No excerpt: this question is decided against the WHOLE paper, which
        // the conversation opened with. Attaching it here would send it again
        // per row — that is what turned one review into 984k tokens.
        null,
        true
      )
    }
  }

  // ------------------------------------------------ the quote is about this one
  {
    const family = (s: string): { stem: string; n: string } | null => {
      const flat = s.toLowerCase().replace(/[^a-z0-9]+/g, '')
      const mm = /^(.*?)(\d+)$/.exec(flat)
      return mm && mm[1].length >= 2 ? { stem: mm[1], n: mm[2] } : null
    }
    const flat = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '')
    for (const f of facts) {
      if (f.quote === null || f.subject === null) continue
      const own = family(f.subject)
      if (own === null) continue
      const q = flat(f.quote)
      if (q.includes(flat(f.subject))) continue
      const sibling = facts.find((g) => {
        if (g.subject === null || g.subject === f.subject) return false
        const fam = family(g.subject)
        return fam !== null && fam.stem === own.stem && fam.n !== own.n && q.includes(flat(g.subject))
      })
      if (!sibling) continue
      add(
        'evidence-subject-match',
        f.id,
        null,
        `This record attributes "${f.predicate}" to "${f.subject}", but the passage it cites names ` +
          `"${sibling.subject}" and not "${f.subject}".\n` +
          `QUESTION: reading the surrounding text, is the recorded claim about "${f.subject}"?\n` +
          'Answer "ok" if the surrounding text makes the claim apply to the recorded subject — a table ' +
          'row, a list, a comparison, a shared sentence, or a nearby line that names it — or if the ' +
          'cited passage simply does not settle which one it is about.\n' +
          `Answer "problem" ONLY if the text shows the claim belongs to "${sibling.subject}" and not to ` +
          `"${f.subject}".`,
        passageFor(f.span_document_id, f.paragraph, f.quote)
      )
    }
  }

  // -------------------------------------------------------------- a repeat row
  //
  // Two identical rows may be one observation recorded twice, or a replicate the
  // paper genuinely reports twice. The rows are identical either way, so the
  // table decides it and nothing else can.
  {
    const norm = (s: string | null): string => (s ?? '').trim().toLowerCase()
    const seen = new Map<string, number>()
    for (const m of measurements) {
      const key = [
        m.field_id ?? `q:${m.quantity.trim().toLowerCase()}`,
        norm(m.subject),
        norm(m.conditions),
        m.value_num ?? norm(recordedText(m)),
        norm(m.unit)
      ].join('\u0000')
      const first = seen.get(key)
      if (first === undefined) {
        seen.set(key, m.id)
        continue
      }
      add(
        'duplicate-record',
        m.fact_id,
        m.id,
        `This run stored the same value twice for ${describe(m)}: ` +
          `${m.value_num ?? recordedText(m) ?? ''}${(m.unit ?? '').trim() === '' ? '' : ` ${m.unit}`}.\n` +
          'QUESTION: does the paper report this measurement ONCE, or more than once?\n' +
          'Answer "problem" if the paper states it once and the second row is the same observation ' +
          'counted twice. Answer "ok" if the paper genuinely reports it more than once — a replicate, ' +
          'a repeat under a condition the record did not capture, or the same value restated in a ' +
          'second table — since counting a real repeat as a duplicate erases data.',
        passageFor(m.span_document_id, m.paragraph, m.quote)
      )
    }
  }

  // ------------------------------------------- a cell that disagrees with itself
  //
  // A table cell holds each quantity ONCE. When a reading of one comes back
  // saying otherwise, the reading went wrong somewhere and the record cannot be
  // right — but WHICH of the two rows is the wrong one is not decidable from the
  // rows, only from the page, so both are ASKED about and neither is judged.
  //
  // This is what the flattened text layer produces. Extraction serialises a
  // table one printed LINE at a time and drops a cell that spans several lines
  // from all but the first, so a run read from the text's order slides values
  // between columns: on one paper a single number arrived as both a Michaelis
  // constant and a catalytic efficiency, and one subject and column arrived with
  // two turnover numbers. Every row carried a verbatim quote, so nothing else
  // downstream had cause to doubt any of them.
  //
  // Neither selector can be a verdict, and neither uses a number's SIZE, a unit's
  // meaning or any expectation about what a quantity should look like. Both are
  // comparisons of the run against itself: a shape the reading cannot have if it
  // is right, whatever the discipline. `subject` and `conditions` must both be
  // present, because they are how a record says which cell it came from — a
  // record naming neither is not claiming a cell and there is nothing to compare.
  {
    const norm = (s: string | null): string => (s ?? '').trim().toLowerCase()
    const cell = (m: MeasRow): string | null => {
      if (norm(m.subject) === '' || norm(m.conditions) === '') return null
      return [norm(m.subject), norm(m.conditions)].join('\u0000')
    }
    const quantityOf = (m: MeasRow): string =>
      m.field_id !== null ? `f:${m.field_id}` : `q:${m.quantity.trim().toLowerCase()}`

    // The SAME quantity twice in one cell.
    {
      const seen = new Map<string, MeasRow>()
      for (const m of measurements) {
        const c = cell(m)
        if (c === null) continue
        const key = [c, quantityOf(m)].join('\u0000')
        const first = seen.get(key)
        if (first === undefined) {
          seen.set(key, m)
          continue
        }
        // An identical repeat is already the `duplicate-record` question, which
        // asks about a replicate. This one is about two DIFFERENT values, which
        // a replicate does not explain.
        if (
          (first.value_num ?? norm(recordedText(first))) === (m.value_num ?? norm(recordedText(m)))
        ) {
          continue
        }
        add(
          'cell-quantity-repeated',
          m.fact_id,
          m.id,
          `This run stored ${describe(m)} twice with different values: ` +
            `${first.value_num ?? recordedText(first) ?? ''} and ` +
            `${m.value_num ?? recordedText(m) ?? ''}.\n` +
            'QUESTION: does the paper report that quantity twice for this subject under this ' +
            'condition, or once?\n' +
            'Answer "ok" if the paper genuinely reports both — two conditions the record did not ' +
            'capture, a repeat, or two places in the paper stating different figures.\n' +
            'Answer "problem" if the paper states it once here, and say which of the two figures ' +
            'the paper actually prints for it and where the other one belongs.',
          passageFor(m.span_document_id, m.paragraph, m.quote)
        )
      }
    }

    // ONE number filed as two different quantities for one subject.
    {
      const seen = new Map<string, MeasRow>()
      for (const m of measurements) {
        if (norm(m.subject) === '') continue
        const printed = m.value_num ?? norm(recordedText(m))
        if (printed === '' || printed === null) continue
        const key = [norm(m.subject), String(printed)].join('\u0000')
        const first = seen.get(key)
        if (first === undefined) {
          seen.set(key, m)
          continue
        }
        if (quantityOf(first) === quantityOf(m)) continue
        add(
          'cell-value-two-quantities',
          m.fact_id,
          m.id,
          `This run stored the figure ${m.value_num ?? recordedText(m) ?? ''} for ` +
            `"${(m.subject ?? '').trim()}" as two different quantities: ` +
            `${describe(first)}, and ${describe(m)}.\n` +
            'QUESTION: does the paper print that same figure for both of those, or was it read ' +
            'once and recorded a second time under a quantity it does not belong to?\n' +
            'Answer "ok" if the paper does print the same figure for both — two quantities ' +
            'coinciding is uncommon but perfectly possible, and erasing a real coincidence loses ' +
            'a result.\n' +
            'Answer "problem" if the paper prints it for only one of them, and say which one, and ' +
            'what the paper prints for the other.',
          passageFor(m.span_document_id, m.paragraph, m.quote)
        )
      }
    }

    // A CELL SHORTER THAN THE TABLE'S OWN CONVENTION.
    //
    // The failure neither selector above can see, because it is SELF-CONSISTENT.
    // A cell stacking several quantities was read by closing the gaps ABOVE its
    // one number: the number was filed under the first quantity instead of the
    // last, and the unit was written to match, so the record agreed with itself
    // in every way a comparison of the run against itself can test. Nothing
    // repeated, no figure served two quantities, and unit and field agreed. Two
    // records reached a scientist asserting values for two quantities the page
    // prints as not determined, while the two real values were absent.
    //
    // What IS visible is that the cell is SHORT. The run itself establishes how
    // many quantities this table gives a cell — most of its cells carry that
    // many — so a cell carrying fewer either had a genuine gap on the page or
    // lost a line to a misread stack. Which of the two can only be answered by
    // LOOKING AT THE PAGE, and that is why this selector is here now and was
    // withdrawn before: asked against the flattened text alone its answers were
    // wrong in both directions, because the text is the artefact in which a
    // blank cell leaves no trace at all. The reviewer is now handed the same
    // table crop the extraction read its values off, so the question has an
    // artefact that can answer it.
    //
    // A SELECTOR, NEVER A VERDICT, built from the run's own shape alone: no
    // number's size, no unit's meaning, no expectation about a discipline. A gap
    // is the ordinary case in any table, so "ok" is the expected answer and
    // costs one call.
    //
    // The MODE, not the maximum: one over-read cell would otherwise make every
    // correct cell look short and put a question behind all of them. And enough
    // cells must agree on it, or the table has stated no convention to fall
    // short OF.
    {
      const byCell = new Map<string, { fields: Set<string>; sample: MeasRow; rows: MeasRow[] }>()
      for (const m of measurements) {
        const c = cell(m)
        if (c === null) continue
        const e = byCell.get(c)
        if (e === undefined)
          byCell.set(c, { fields: new Set([quantityOf(m)]), sample: m, rows: [m] })
        else {
          e.fields.add(quantityOf(m))
          e.rows.push(m)
        }
      }
      // EVERY CELL IS ASKED ABOUT, not only the ones that look odd.
      //
      // This used to fire only where a cell held FEWER quantities than the
      // table's usual shape — a self-inconsistency, like every other selector
      // here. That is a poor proxy for error on a table, and measurably so: on
      // one paper it asked 12 questions about 78 facts and left 13 of 24 cells
      // unexamined. A column SHIFT — the dominant failure on a flattened table
      // — preserves every internal consistency there is. The shifted cells hold
      // the right NUMBER of values, under the right quantity names, with the
      // right units; they are simply attached to the wrong column. Nothing a
      // record can be compared against ITSELF will ever reveal that.
      //
      // So the comparison has to be against the PAGE, and the unit of the
      // question is the cell: subject × column is exactly the place a reader
      // looks at, and asking about it catches a shift, a swap, a stolen value
      // and a missing one with one question. The reviewer is handed the same
      // table crop the extraction read, so the page is available to answer it.
      //
      // Cost is bounded by the table, not the fact count: a 8-row × 4-column
      // table is 24-32 questions however many quantities each cell stacks.
      if (byCell.size >= MIN_CELL_SHAPE) {
        for (const e of byCell.values()) {
          // What this reading claims is at this place, figure by figure. A
          // reader cannot check a number it was not told.
          const figures = e.rows
            .map(
              (r) =>
                `${r.value_num ?? recordedText(r) ?? ''}` +
                `${(r.unit ?? '').trim() === '' ? '' : ` ${r.unit}`} ` +
                `(${r.field_label ?? r.quantity})`
            )
            .join(', ')
          add(
            'cell-matches-page',
            e.sample.fact_id,
            e.sample.id,
            `For ${describe(e.sample)} this reading recorded: ${figures}.\n` +
              'QUESTION: find that exact place on the page — this subject\u2019s row, this ' +
              'column — and say whether the page prints those figures THERE, each under ' +
              'the quantity it is recorded as.\n' +
              'Answer "ok" if every figure recorded is printed at that place under that ' +
              'quantity, and nothing the page prints there as a VALUE is missing. A ' +
              'quantity the page marks not determined, not measured or below detection is ' +
              'not missing — recording nothing for it is the correct reading, and this is ' +
              'the ORDINARY case.\n' +
              'Answer "problem" if any figure is printed somewhere else, under a different ' +
              'quantity, or in a different column — or if the page prints a value there ' +
              'that this reading did not record. Say what the page prints and where.\n' +
              'THE FAILURE THIS MOST OFTEN FINDS. A column the page skips for this row, or ' +
              'a cell whose lines the reading counted from the wrong end, makes every ' +
              'figure after it slide one column across. Each cell then still looks ' +
              'complete and self-consistent — right count, right names, right units — so ' +
              'the ONLY way to see it is to look at where the numbers are actually ' +
              'printed. Read the column heading above the figures you find, and the row ' +
              'label beside them, before you answer.',
            passageFor(e.sample.span_document_id, e.sample.paragraph, e.sample.quote)
          )
        }
      }
    }
  }

  // --------------------------------------------------- an uncertainty too large
  //
  // A NEGATIVE uncertainty is malformed whatever the paper says and stays in
  // `checks.ts`. One merely larger than the value is a real and common result
  // near a detection limit, so only the paper can say whether it was printed.
  for (const m of measurements) {
    if (m.error_num === null || m.value_num === null) continue
    if (m.error_num < 0) continue
    if (Math.abs(m.error_num) <= Math.abs(m.value_num)) continue
    add(
      'error-bar-plausible',
      m.fact_id,
      m.id,
      `This record stores ${m.value_num} ± ${m.error_num} for ${describe(m)} — the uncertainty is ` +
        'larger than the value.\n' +
        'QUESTION: is that what the paper prints?\n' +
        'Answer "ok" if the paper reports that value with that uncertainty. A measurement near its ' +
        'detection limit legitimately has an uncertainty larger than itself, and reporting it as ' +
        'impossible would be wrong.\n' +
        'Answer "problem" ONLY if the second number is not an uncertainty at all — a neighbouring ' +
        'column, an exponent whose sign or superscript the text layer dropped, or a different ' +
        'quantity read into the uncertainty slot. Say what it actually is.',
      passageFor(m.span_document_id, m.paragraph, m.quote)
    )
  }

  // ------------------------------------------------ a value far from its peers
  for (const m of typed) {
    if (m.data_type !== 'number' || m.value_num === null) continue
    const others = (
      db
        .prepare(
          /* sql */ `
          SELECT m2.value_num AS v
          FROM measurement m2
          JOIN fact f2 ON f2.id = m2.fact_id
          JOIN analysis_run r2 ON r2.id = f2.analysis_run_id
          WHERE m2.field_id = ? AND f2.analysis_run_id <> ? AND m2.value_num IS NOT NULL
            AND r2.superseded = 0
            AND COALESCE(TRIM(LOWER(m2.unit)), '') = ?`
        )
        .all(m.field_id, analysisRunId, (m.unit ?? '').trim().toLowerCase()) as Array<{ v: number }>
    )
      .map((r) => Math.abs(r.v))
      .filter((v) => v > 0)
    if (others.length < MIN_COMPARATORS) continue
    const v = Math.abs(m.value_num)
    if (v === 0) continue
    const lo = Math.min(...others)
    const hi = Math.max(...others)
    const decades = Math.log10(v > hi ? v / hi : v < lo ? lo / v : 1)
    if (decades <= OUTLIER_DECADES) continue
    const high = v > hi
    add(
      'value-outlier',
      m.fact_id,
      m.id,
      `This record stores ${m.value_num}${(m.unit ?? '').trim() === '' ? '' : ` ${m.unit}`} for ` +
        `${describe(m)}. Every other record of this field in this library, in the same unit, lies ` +
        `between ${lo} and ${hi} (${others.length} of them), so this one is more than a thousand times ` +
        `${high ? 'larger' : 'smaller'} than any of them.\n` +
        'QUESTION: is that the number and unit the paper prints for this field and subject?\n' +
        'Answer "ok" if the paper prints it — an exceptional result is exactly what a paper is written ' +
        'to report, and a value being far from its peers is not a defect.\n' +
        'Answer "problem" ONLY if the paper prints a different number or a different unit here — a ' +
        'decimal point in another place, a prefix in the table header the record did not carry, an ' +
        'exponent the text layer flattened. Say what the paper prints.',
      passageFor(m.span_document_id, m.paragraph, m.quote)
    )
  }

  // -------------------------------- the paper's own columns disagree with each other
  //
  // Settled by ARITHMETIC before anything is put to a reader: a table that prints
  // a derived column carries its own proof, and the header a reader would consult
  // instead is the character a text layer destroys most reliably. Asked without
  // it, the reviewer read the header, ignored the row, and cleared a thousandfold
  // error — the one failure worse than the false positive this file replaced.
  //
  // A question is still ASKED, not a verdict asserted: the arithmetic goes over
  // as the finding, and the reader is asked only whether the paper says anything
  // that explains it away.
  const derivedGaps: DerivedGap[] = derivedColumnGaps(
    toDerivedRecords(
      measurements.map((m) => ({
        id: m.id,
        fact_id: m.fact_id,
        field_id: m.field_id,
        value_num: m.value_num,
        unit: m.unit,
        subject: m.subject,
        data_type: m.data_type
      }))
    )
  )
  const fieldLabel = new Map<number, string>()
  for (const m of typed) {
    if (m.field_id !== null) fieldLabel.set(m.field_id, m.field_label ?? m.quantity)
  }
  /** Fields a gap already accounts for; the corpus question below must not repeat it. */
  const gapFields = new Set<number>()
  for (const g of derivedGaps) {
    gapFields.add(g.numeratorField)
    gapFields.add(g.denominatorField)
    gapFields.add(g.resultField)
    const A = fieldLabel.get(g.numeratorField) ?? `field ${g.numeratorField}`
    const B = fieldLabel.get(g.denominatorField) ?? `field ${g.denominatorField}`
    const C = fieldLabel.get(g.resultField) ?? `field ${g.resultField}`
    const factor = Math.pow(10, Math.abs(g.decades))
    const gm = measurements.find((m) => m.id === g.sampleMeasurementId)
    const quotient = g.sample.a / g.sample.b
    add(
      'value-scale-consistent',
      g.sampleFactId,
      g.sampleMeasurementId,
      `This paper reports three related columns for the same subjects: "${A}", "${B}" and "${C}". ` +
        `Reduced to one scale, "${C}" is not "${A}" divided by "${B}" — it is that quotient times ` +
        `${factor}, in all ${g.records} of this paper's records, always by the SAME factor. The row for ` +
        `"${g.sample.key}" stores ${g.sample.a}, ${g.sample.b} and ${g.sample.c}, and ` +
        `${g.sample.a} ÷ ${g.sample.b} = ${quotient.toPrecision(3)}, which is ${factor} times ` +
        `${g.decades > 0 ? 'smaller than' : 'larger than'} the ${g.sample.c} stored.\n` +
        'This is the paper contradicting ITSELF as recorded, so one of the three columns is held at the ' +
        `wrong scale by a factor of ${factor}. A scale prefix is among the characters a PDF text layer ` +
        'destroys most reliably, INCLUDING IN A COLUMN HEADER.\n' +
        'QUESTION: does the passage explain the gap without any column being at the wrong scale?\n' +
        'Answer "ok" ONLY if the paper states these columns are not related by that division at all, or ' +
        'states a conversion that accounts for the factor exactly. A header that merely names a unit ' +
        'does NOT answer this — the arithmetic is what shows the header cannot be read as printed.\n' +
        'Answer "problem" if the arithmetic stands. Say which column must be at the other scale, and ' +
        'name the prefix the paper meant if the passage shows it.',
      gm === undefined ? null : passageFor(gm.span_document_id, gm.paragraph, gm.quote)
    )
  }

  // ------------------------------------------ a whole column away from the rest
  //
  // Asked ONCE for the field, not once per value: sixteen values agreeing with
  // each other and disagreeing with the corpus is ONE decision about a table
  // header, and reporting it sixteen times reads as sixteen unrelated problems.
  {
    interface Group {
      m: MeasRow
      vals: number[]
      unit: string
    }
    const groups = new Map<string, Group>()
    for (const m of typed) {
      if (m.data_type !== 'number' || m.value_num === null) continue
      const c = canonicalUnit(m.unit)
      if (!c.recognised) continue
      const key = `${m.field_id}\u0000${c.unit}`
      const val = Math.abs(m.value_num * c.scale + c.offset)
      if (val === 0) continue
      const g = groups.get(key)
      if (g) g.vals.push(val)
      else groups.set(key, { m, vals: [val], unit: c.unit })
    }
    for (const g of groups.values()) {
      if (g.vals.length < MIN_SCALE_RUN_VALUES) continue
      // Already asked, with better evidence. The corpus comparison says this
      // column disagrees with other papers; the arithmetic above says it
      // disagrees with its own neighbours, which is the stronger claim and the
      // same finding — two questions would read as two unrelated problems.
      if (g.m.field_id !== null && gapFields.has(g.m.field_id)) continue
      const rows = db
        .prepare(
          /* sql */ `
          SELECT m2.value_num AS v, m2.unit AS unit
          FROM measurement m2
          JOIN fact f2 ON f2.id = m2.fact_id
          JOIN analysis_run r2 ON r2.id = f2.analysis_run_id
          WHERE m2.field_id = ? AND f2.analysis_run_id <> ? AND m2.value_num IS NOT NULL
            AND r2.superseded = 0`
        )
        .all(g.m.field_id, analysisRunId) as Array<{ v: number; unit: string | null }>
      const otherVals: number[] = []
      for (const r of rows) {
        const c = canonicalUnit(r.unit)
        if (!c.recognised || c.unit !== g.unit) continue
        const val = Math.abs(r.v * c.scale + c.offset)
        if (val > 0) otherVals.push(val)
      }
      if (otherVals.length < MIN_COMPARATORS) continue
      const mineMed = median(g.vals)
      const otherMed = median(otherVals)
      const decades = Math.abs(Math.log10(mineMed / otherMed))
      if (decades <= SCALE_DECADES) continue
      const factor = Math.pow(10, Math.round(decades))
      add(
        'value-scale-consistent',
        g.m.fact_id,
        g.m.id,
        `All ${g.vals.length} values this paper reports for ${describe(g.m)} sit about ${factor} times ` +
          `${mineMed > otherMed ? 'higher' : 'lower'} than the ${otherVals.length} recorded for the same ` +
          'field elsewhere in this library, compared after reducing every unit to the same scale.\n' +
          'QUESTION: is the unit stored for these values the unit the paper states for them?\n' +
          'Answer "ok" if the paper really does report them at this scale — a paper whose whole result ' +
          'differs from the field by a round factor is a finding, not an error — or if you cannot see ' +
          'the table header that would decide it.\n' +
          'Answer "problem" ONLY if the paper states a different unit or prefix for this column from ' +
          'the one stored. Say what the paper states.',
        passageFor(g.m.span_document_id, g.m.paragraph, g.m.quote)
      )
    }
  }

  // ---------------------------------------------- an exact figure or a bound
  //
  // `>95 °C` reaches the extractor as `N 95` and is stored as an exact 95, which
  // then averages and ranks against real results. Whether the paper printed a
  // bound or a figure is settled by looking at the page, and the letter-for-sign
  // substitution is a guess about a text layer, not a fact about the record.
  for (const m of measurements) {
    if (m.value_num === null) continue
    const t = (m.value_text ?? '').trim()
    if (t === '') continue
    if (!/^[A-Za-z]\s*[~≈]?\s*\d/.test(t)) continue
    add(
      'value-bound-not-figure',
      m.fact_id,
      m.id,
      `This record stores the exact number ${m.value_num} for ${describe(m)}, read from the text ` +
        `"${t}".\n` +
        'QUESTION: does the paper state an exact value here, or a bound (a greater-than or less-than)?\n' +
        'Answer "problem" if the paper states a BOUND: stored as an exact figure it will be averaged ' +
        'and ranked against measured results. Say which bound.\n' +
        'Answer "ok" if the paper states the exact figure and the leading character belongs to ' +
        'something else — a label, a footnote marker, a column name.',
      passageFor(m.span_document_id, m.paragraph, m.quote)
    )
  }

  return out
}

// -------------------------------------------------------------------- batching

/**
 * How many questions one call carries.
 *
 * One call per record across a corpus of hundreds is too many calls; one call
 * per paper is too little precision, because a model asked twenty unrelated
 * things about one document answers the theme rather than the questions. The
 * grain is (run, check family, chunk) — one call asks one KIND of question, so
 * the instructions in front of the model are the ones the answers need, and the
 * batch stays small enough that each id is attended to.
 */
export const REVIEW_BATCH = 8

/** The paper the questions are decided against, sent ONCE to open a review. */
export function reviewDocBody(db: DB, analysisRunId: number): string | null {
  const row = db
    .prepare(`SELECT work_id FROM analysis_run WHERE id = ?`)
    .get(analysisRunId) as { work_id: number } | undefined
  if (!row) return null
  const span = db
    .prepare(
      `SELECT document_id AS id FROM evidence_span
        WHERE analysis_run_id = ? AND document_id IS NOT NULL LIMIT 1`
    )
    .get(analysisRunId) as { id: number } | undefined
  const docId =
    span?.id ??
    (db.prepare(`SELECT id FROM document WHERE work_id = ? LIMIT 1`).get(row.work_id) as
      | { id: number }
      | undefined)?.id
  if (docId === undefined) return null
  const body = (
    db
      .prepare(
        `SELECT text FROM document_paragraph
          WHERE document_id = ? AND kind <> 'reference' ORDER BY idx ASC`
      )
      .all(docId) as Array<{ text: string }>
  )
    .map((r) => r.text)
    .join('\n\n')
  return body.trim() === '' ? null : body
}

export interface ReviewBatch {
  checkKey: ReviewCheckKey
  questions: ReviewQuestion[]
}

export function batchQuestions(questions: ReviewQuestion[]): ReviewBatch[] {
  const byKey = new Map<ReviewCheckKey, ReviewQuestion[]>()
  for (const q of questions) {
    const l = byKey.get(q.checkKey)
    if (l) l.push(q)
    else byKey.set(q.checkKey, [q])
  }
  const out: ReviewBatch[] = []
  for (const [checkKey, list] of byKey) {
    for (let i = 0; i < list.length; i += REVIEW_BATCH) {
      out.push({ checkKey, questions: list.slice(i, i + REVIEW_BATCH) })
    }
  }
  return out
}

/** One current extraction and the questions it still owes an answer to. */
export interface PendingReview {
  runId: number
  workId: number
  schemaId: number | null
  /**
   * The fields of the schema this run answered, label and id.
   *
   * Carried here because a finding comes back naming a field by the LABEL the
   * question showed, and a fact is filed under an ID. Resolving it against THIS
   * run's schema is what stops a value being stored under a field of some other
   * schema that happens to share a label — and the stage cannot look it up
   * itself, since `StageReadDb` is deliberately narrow and holds no handle that
   * could reach `extraction_field`.
   */
  fields: Array<{ id: number; label: string }>
  questions: ReviewQuestion[]
  /**
   * The run's measurements, for comparing against a SECOND, blind reading of
   * the table. Carried here rather than re-queried by the caller so the two
   * readings are matched over exactly the rows this review is about.
   */
  cells: MeasRow[]
  /**
   * The paper, sent ONCE to open the review conversation.
   *
   * Assembled here rather than in the stage because a stage's `ctx.db` is the
   * narrow `StageReadDb` and cannot query paragraphs, and because it must be
   * the same body the extraction read — non-reference paragraphs, blank line
   * between — or the reviewer is deciding questions about a document nobody
   * extracted from.
   */
  body: string | null
}

/**
 * Every question the current extractions of one (work, project) still owe an
 * answer to.
 *
 * A FIRST-CLASS LOOKUP, for the reason `citationCandidates` is one: a stage does
 * not hand-write SQL against a bulk table. It would match rows a superseded run
 * owns, and the offline gate bans it. Building the questions ALSO needs the
 * paragraphs, the schema and the corpus's other values for the same field —
 * none of which is expressible as an upstream capability of this document.
 *
 * The `answered` filter is the whole idempotence story: a verdict is stored with
 * the fingerprint of the question that produced it, so an unchanged question
 * finds its answer already there and costs nothing. Without it the reviewer
 * would re-read the corpus on every wake.
 */
export function loadPendingReviews(
  db: DB,
  workId: number,
  projectId: number,
  promptVersion: string
): PendingReview[] {
  const runs = db
    .prepare(
      `SELECT id, work_id, schema_id FROM analysis_run
        WHERE work_id = ? AND project_id = ? AND analysis_type = 'extraction'
          AND superseded = 0
        ORDER BY id ASC`
    )
    .all(workId, projectId) as Array<{ id: number; work_id: number; schema_id: number | null }>

  const answeredFor = db.prepare(
    `SELECT input_hash FROM analysis_check
      WHERE analysis_run_id = ? AND source = 'reviewed' AND input_hash IS NOT NULL`
  )

  const out: PendingReview[] = []
  for (const r of runs) {
    const questions = buildReviewQuestions(db, r.id)
    if (questions.length === 0) continue
    const cells = loadMeasurements(db, r.id)

    const answered = new Set(
      (answeredFor.all(r.id) as Array<{ input_hash: string }>).map((x) => x.input_hash)
    )
    const open = questions.filter((q) => !answered.has(reviewInputHash(q, promptVersion)))
    // A run with NO open question is still emitted when it has cells, because
    // the second, blind reading of the table is a different question with its
    // own answers. Gating that on the selector-built questions meant the whole
    // comparison never ran on a paper whose ordinary questions were settled —
    // which is every paper, the moment it has been reviewed once. The caller
    // skips the batch loop when `questions` is empty; it is the cells it wants.
    if (open.length > 0 || cells.length > 0) {
      out.push({
        runId: r.id,
        workId: r.work_id,
        schemaId: r.schema_id ?? null,
        fields: schemaFieldsOf(db, r.schema_id ?? null),
        questions: open,
        body: reviewDocBody(db, r.id),
        cells
      })
    }
  }
  return out
}

/**
 * Words a reviewer uses when it is not sure.
 *
 * Only ever applied to a `problem`, and only ever to DEMOTE it. That direction
 * is what makes this safe: demoting can remove a flag the reader should not have
 * been given, and can never add one.
 */
const HEDGE =
  /\b(?:appears?\s+to|appear|may\s+be|might\s+be|seems?\s+to|seems|suggests?|possibly|probably|likely|perhaps|unclear|cannot\s+tell|hard\s+to\s+tell|not\s+certain|uncertain|presumably|apparently|could\s+be)\b/i

/**
 * The verdict as STORED, after refusing a flag the reviewer hedged.
 *
 * The prompt already forbids it — "if your reason admits you are not sure, the
 * verdict is unclear" — and the reviewer mostly obeys, which is exactly why the
 * exceptions matter: one record was flagged with the note "this appears to be
 * mangled PDF text", which is a reader thinking aloud, not a finding. A reader
 * cannot act on a hedged flag. They must either check the record or trust it,
 * and a flag that hedges asks them to do both, so it costs the attention of a
 * real flag and buys nothing.
 *
 * `ok` is never touched. A hedged "ok" is a record nobody is being asked to look
 * at, so the hedge changes nothing a reader does — and demoting it would move
 * work INTO the queue on the strength of a word, which is the failure being
 * removed, in the other direction.
 */
export function settleVerdict(
  verdict: 'ok' | 'problem' | 'unclear',
  note: string | null | undefined
): 'passed' | 'failed' | 'skipped' {
  if (verdict === 'ok') return 'passed'
  if (verdict === 'unclear') return 'skipped'
  return HEDGE.test(note ?? '') ? 'skipped' : 'failed'
}

/**
 * What a reader may ask to HAPPEN to a record it has judged, offered once per
 * batch.
 *
 * Only where the questions name a stored record. A row-shaped question names no
 * record at all, so a retraction from it would point at nothing, and offering
 * the key there invites an answer the caller must then throw away.
 *
 * Once per BATCH rather than per question: a batch holds up to twenty questions
 * of one kind, and the same paragraph twenty times is paid for on every turn and
 * read as boilerplate by the third.
 *
 * It states what the slot MEANS and reaches no conclusion. Nothing here says
 * when a record is wrong — that is the question above it, and this only gives
 * the answer somewhere to go.
 */
const REMEDY_OFFER = [
  'THESE QUESTIONS NAME A RECORD THAT EXISTS, SO YOU MAY ALSO SAY WHAT SHOULD HAPPEN TO IT.',
  '',
  'Send "remedy": "retract" on a "problem" verdict when the record should not be',
  'there at all — when what it claims is not something the paper says of this',
  'subject, so no correction of its value would make it right. Sent alone, that',
  'says the correct state is no record. Sent beside "found", it says the value in',
  '"found" takes its place.',
  '',
  'Leave "remedy" out for everything else, which is nearly every answer. A verdict',
  'without it judges the record and says nothing about its fate: a value a reader',
  'must check, a passage that does not settle the question, a figure you disagree',
  'with but cannot rule out. Withdrawing a record is the strong claim, and the',
  'reason you give is what a person will read before acting on it, so say there',
  'why the record cannot stand.'
].join('\n')

/** Render one batch as the user message the reviewer prompt expects. */
export function renderBatch(batch: ReviewBatch): string {
  const parts: string[] = [
    `You are answering ${batch.questions.length} question(s) of one kind about records extracted from a single paper.`,
    ''
  ]
  if (batch.questions.some((q) => q.factId !== null)) {
    parts.push(REMEDY_OFFER, '')
  }
  for (const q of batch.questions) {
    parts.push(`--- QUESTION ${q.id} ---`)
    parts.push(q.ask)
    parts.push(
      q.usesConversationDocument === true
        ? 'PAPER TEXT: the whole paper, sent at the start of this conversation. Decide this question against it.'
        : q.passage === null
          ? 'PAPER TEXT: none is available for this record. If that leaves the question undecided, answer "unclear".'
          : `PAPER TEXT:\n${q.passage}`
    )
    parts.push('')
  }
  parts.push(
    `Answer every question above by its id (${batch.questions.map((q) => q.id).join(', ')}), and no others.`
  )
  return parts.join('\n')
}
