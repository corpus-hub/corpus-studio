// Put the questions only the PAPER can answer to a model that has read it.
//
// WHAT THIS STAGE IS FOR. Eleven of the old deterministic checks asserted things
// about a paper they had never seen, and were therefore capable of a false
// positive in theory and guilty of several in practice. `review.ts` sets out the
// admission rule and builds the questions; this stage runs them.
//
// A SEPARATE CALL FROM EXTRACTION, and that is the whole point. The extractor is
// never handed its own output to grade: a model shown its own answer defends it,
// which is the failure `schema-extract` already documents about self-reported
// shortfalls ("all rows successfully extracted", announced under an INCOMPLETE
// banner). This runs afterwards, over rows that are already stored, with its own
// prompt version and its own provenance.
//
// AN ANSWER IS NOT A CORRECTION. Nothing here rewrites a fact, a measurement or
// an evidence span. A `problem` verdict annotates a record and sends it to the
// review queue; the record itself is untouched, exactly as a deterministic
// failure has always been.
//
// PROJECT-SCOPED, because the questions are about an extraction and an
// extraction belongs to a (work, project, schema). Running it corpus-wide would
// re-ask every paper's questions whenever any paper changed.

import { getPrompt } from '../../llm/prompts'
import {
  REVIEW_TURN_READ,
  REVIEW_TURN_WORDING,
  conflictAdjudicateOutputSchema,
  conflictAnswerSchema,
  recordReviewItemSchema,
  reviewFindingSchema,
  recordReviewOutputSchema,
  tableCellSchema,
  tableReadOutputSchema,
  tableValueSchema
} from '../../llm/prompts'
import { extractJson } from '../../llm/provider'
import type { LlmMessage } from '../../llm/provider'
import {
  CHECK_LABELS,
  batchQuestions,
  loadPendingReviews,
  renderBatch,
  reviewInputHash,
  settleVerdict
} from '../../llm/review'
import { compareReadings, describeDisagreement, foldLabel, wordingPair } from '../../llm/tableMatch'
import type { Disagreement, ReadCell, ReadValue, StoredCell } from '../../llm/tableMatch'

import type { DocumentFile, TextPages } from '../capabilities'
import { renderTableCrops } from '../tableCrops'
import type { StageContext, StageDefinition } from '../types'

/**
 * The prompt version this stage speaks, named ONCE.
 *
 * `fingerprint` and `execute` must never resolve it separately: they would
 * fingerprint one version and answer under another, and every stored verdict's
 * provenance would then be a lie about which wording produced it.
 */
const REVIEW_PROMPT_VERSION = 'v11'
const TABLE_READ_VERSION = 'v1'
const REVIEW_CONVO_VERSION = 'v1'

/**
 * How many batches one wake may spend.
 *
 * A bound, not a target. A corpus that has just been re-extracted can produce
 * hundreds of questions at once, and a stage that answers all of them in one
 * execution holds the process-wide LLM gate for the whole batch — every other
 * paper in the app stalls behind it. Unanswered questions are not lost: their
 * fingerprints are unchanged, so the next wake picks up exactly where this one
 * stopped, and the counter below is what makes that wake happen.
 */
const BATCH_BUDGET = 24

/**
 * A field label reduced to what two spellings of it have in common.
 *
 * A model asked to echo a column label reproduces it as prose — it changes the
 * case, drops a bracket, turns a hyphen into a space — and an exact comparison
 * then discards a finding whose field is unmistakable to a reader. Letters and
 * digits only, so nothing but the identity of the word survives.
 */
const fold = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{Nd}]+/gu, '')

/**
 * Drop the disagreements that are only two spellings of one name.
 *
 * Returns the ones to DISCARD, so every path that goes wrong — no candidates,
 * an unreachable model, a malformed answer, an `unsure` — returns an empty set
 * and leaves every disagreement standing. That direction is the whole safety
 * property: this can only remove a conflict the model positively identified as
 * a naming difference, and can never create one.
 */
async function settleWording(
  raw: Disagreement[],
  ctx: StageContext,
  models: { reviewModel: string; reviewMaxOutput: number },
  // The conversation this review has been having. Appended to rather than
  // replaced, so the system prompt and the table crops are not sent again — and
  // so the answer comes from the reader that already committed to a reading of
  // this table, which is the only reader whose opinion about its own wording
  // means anything.
  convo: LlmMessage[]
): Promise<Set<Disagreement>> {
  const out = new Set<Disagreement>()
  const asks: Array<{ id: string; d: Disagreement; a: string; b: string }> = []
  for (const d of raw) {
    const pair = wordingPair(d)
    // Two names that already fold to one string are settled in code; only a
    // genuine difference of wording is worth a model call.
    if (pair === null || foldLabel(pair.a) === foldLabel(pair.b)) continue
    asks.push({ id: `w${asks.length + 1}`, d, a: pair.a, b: pair.b })
  }
  // No conversation means turn 1 never happened — the paper had no crop, or the
  // reading failed. There is then no reader to ask, and every disagreement
  // stands.
  if (asks.length === 0 || ctx.signal.aborted || convo.length === 0) return out

  const body =
    `${REVIEW_TURN_WORDING}\n\n` +
    asks
      .map(
        (q) =>
          `--- QUESTION ${q.id} ---\n` +
          `You called this column: ${JSON.stringify(q.b)}\n` +
          `The earlier reading calls it: ${JSON.stringify(q.a)}\n` +
          'Do these name the same column of the table, or two different ones?'
      )
      .join('\n\n')

  try {
    convo.push({ role: 'user', content: body })
    const text = await ctx.llm.call(convo, {
      model: models.reviewModel === '' ? undefined : models.reviewModel,
      maxTokens: models.reviewMaxOutput
    })
    convo.push({ role: 'assistant', content: text })
    const parsed = conflictAdjudicateOutputSchema.safeParse(extractJson(text))
    if (!parsed.success) {
      ctx.log('the wording answer was not in the expected shape; every difference stands')
      return out
    }
    const byId = new Map(asks.map((q) => [q.id, q]))
    for (const rawAnswer of parsed.data.answers) {
      const a = conflictAnswerSchema.safeParse(rawAnswer)
      if (!a.success) continue
      // ONLY `same` removes anything. `different` and `unsure` both leave the
      // disagreement standing, which is what a human needs to see.
      if (a.data.verdict !== 'same') continue
      const q = byId.get(a.data.id)
      if (q === undefined) continue
      ctx.log(`"${q.a}" and "${q.b}" name the same column — that difference is dropped`)
      out.add(q.d)
    }
  } catch (err) {
    // A question that was never answered settles nothing. The disagreements
    // stand, which is the state this stage would be in without asking.
    ctx.log(`the wording question failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  return out
}

const reviewRecords: StageDefinition<{
  runs: number
  questions: number
  answered: number
  problems: number
  unclear: number
  llmCalls: number
}> = {
  id: 'review-records',
  label: 'Review records',
  // 1.1.0: the scale question is now settled by arithmetic over the paper's own
  // columns before it is put to a reader, so the question this stage asks is a
  // different one and every cached answer to the old one must be reopened.
  // 1.2.0: nothing outstanding settles as `not-needed` rather than `empty`, so
  // a paper with no open question is done instead of parked awaiting a
  // decision. A cached `empty` would keep the old verdict and the old queue
  // state, so it has to be reopened.
  // 1.4.0: the reviewer is handed the same table crops the extractor read the
  // values off. Every cached answer was reached without them.
  // 1.14.0: a value the reader found is WRITTEN as a fact, and the question now
  // asks whether the paper printed it or the reader derived it. Every cached
  // answer was reached under a question that had no such key.
  // 1.15.0: the reader may RETRACT a record it judged, a row question is split
  // by the conditions its values were measured under, and a found value carries
  // the conditions it belongs to and gets its own measurement row. Every cached
  // answer was reached over a row that merged two sets of measurements and under
  // a question that offered no remedy.
  version: '1.17.0',
  rank: 9,
  scope: 'project',
  provides: ['analysis.reviewed@v1'],
  // The extraction, obviously — but ALSO the paragraphs, because a question is
  // decided against the paper's own words and a run whose document has been
  // re-segmented is being asked about text that has moved.
  requires: ['analysis.extraction@v1', 'text.paragraphs@v1'],
  // The page geometry and the file are what the table crops are rendered from:
  // the extractor read its values off those pictures, so an auditor given only
  // the flattened text is looking at the one artefact where a column shift
  // leaves no trace. They are OPTIONAL because the crops are an addition to the
  // evidence and never a precondition — and `requires` is a precondition at the
  // planner level whatever a comment beside it says. Declared there, a paper
  // whose retrieval was refused (paywalled, no identifier) or which never had a
  // readable PDF dropped out of the staleness sweep entirely: its extracted
  // records were never audited and its queue row showed nothing pending, which
  // reads exactly like "reviewed and clean". `enriches` keeps everything the
  // declaration was for — the ordering, the dependency edge, the fingerprint,
  // the retirement cascade — and gives up only the gate.
  enriches: ['text.pages@v2', 'document.file@v1'],
  usesLlm: true,
  runtime: 'node',
  weight: 'light',
  // INLINE: the work is a bounded number of gated LLM calls plus SQL, not CPU,
  // and a host process has no database to build the questions from.
  isolation: 'inline',

  /**
   * The OPEN QUESTIONS, by identity — never their count.
   *
   * A count is the trap `verify-citations` documents: two pending sets of equal
   * size are a cache hit, so one record's question closing as another opens
   * would coalesce into "nothing changed" and the new one would never be asked.
   * Hashing the set means the fingerprint moves whenever any question does.
   *
   * The PROMPT VERSION is in every question's own hash (`reviewInputHash`), so a
   * prompt edit reopens all of them and this fingerprint moves with them —
   * which is what stops the failure this project has hit five times, where a
   * prompt fix shipped, was measured, and changed zero stored rows because the
   * cache answered first.
   */
  fingerprint(ctx) {
    const prompt = getPrompt('record-review', REVIEW_PROMPT_VERSION)
    // The planner hands a raw `DB` rather than the stage-facing read handle, so
    // the SAME loader is called directly here. One definition of "what is still
    // open" across both, deliberately: a fingerprint computed from a different
    // set from the one `execute` answers is a cache that hits on work that was
    // never done.
    const pending = loadPendingReviews(ctx.db, ctx.workId, ctx.projectId, prompt.version)
    const ids = pending
      .flatMap((p) => p.questions.map((q) => reviewInputHash(q, prompt.version)))
      .sort()
    // The SECOND READING's state belongs here too, and its absence was a bug
    // waiting to happen: a run with no open question now still reaches
    // `execute` (it has cells to compare), so a fingerprint built only from
    // open questions would be constant across a completed review and the stage
    // would re-read every table on every wake, for ever. Keyed to the recorded
    // second reading rather than to a flag: once the comparison has been made
    // and its verdicts stored, this stops moving.
    const seconds = ctx.db
      .prepare(
        `SELECT COUNT(*) AS n FROM analysis_check
          WHERE check_key = 'cell-second-reading'
            AND analysis_run_id IN (${pending.map(() => '?').join(',') || 'NULL'})`
      )
      .get(...pending.map((p) => p.runId)) as { n: number } | undefined
    const cells = pending.reduce((n, p) => n + p.cells.length, 0)
    return (
      `prompt=${prompt.name}@${prompt.version}+read@${TABLE_READ_VERSION}` +
      `|open=${ids.length}|set=${ids.join(',')}|cells=${cells}|second=${seconds?.n ?? 0}`
    )
  },

  async execute(ctx) {
    const prompt = getPrompt('record-review', REVIEW_PROMPT_VERSION)
    const pending = ctx.db.pendingReviews(prompt.version)
    if (pending.length === 0) {
      // COMPLETE, not `empty`. Nothing is outstanding — either every question
      // has already been answered, or this paper produced no record that needs
      // a reading to settle. Both are the review being DONE, and `empty`
      // settled the job to `review`, so a finished paper sat in the queue
      // asking for a decision nobody had to make.
      //
      // The old wording explained the mechanism ("records that needed a reading
      // to judge") to a reader who wanted the outcome. It also could not tell
      // the two causes apart, and they are not the same event.
      return {
        status: 'not-needed',
        reason: 'there is nothing left to review on this paper'
      }
    }

    // THE SAME PICTURES THE EXTRACTOR READ THE VALUES OFF.
    //
    // Rendered ONCE for the paper, not per batch: the crops are identical for
    // every question about this document, and re-rendering them per call would
    // decode the PDF dozens of times for one paper.
    //
    // An ADDITION to the evidence, never a precondition: a paper with no table,
    // no page geometry or no readable PDF is reviewed from text exactly as
    // before, and the prompt tells the reader not to describe a cell it cannot
    // see.
    const crops = await renderTableCrops(
      ctx.input<DocumentFile>('document.file@v1'),
      ctx.input<TextPages>('text.pages@v2'),
      ctx.log,
      (region) =>
        `Image: ${region.label ?? 'table'} (page ${region.page}) of the paper these records ` +
        'were extracted from. This is the SAME picture the extraction read its values off. ' +
        'Where a question is about a cell you can see here, the picture decides it — the ' +
        'text below destroyed the table\u2019s columns and its blanks.'
    )
    if (crops.images.length > 0) {
      ctx.log(`reviewing against ${crops.images.length} table crop(s)`)
    }

    // A SECOND READING OF THE TABLE, TAKEN BLIND — and then compared in code.
    //
    // Everything below asks "is this stored value right?", and measured, that
    // question cannot be answered honestly: shown `0.0185 / 1.03 / 5.84` and
    // asked whether the page prints them, the reviewer answered "All match" for
    // a cell printed as `0.0185 / 0.435 / 42.3`, and in the next cell it
    // transcribed the printed row CORRECTLY and still passed the stored one. It
    // was agreeing with the answer contained in the question, which is what any
    // reader does.
    //
    // `table-read` is never told what was stored. It reads the picture and
    // reports what is printed; `compareReadings` then matches the two readings
    // mechanically. A disagreement between two readers who could not see each
    // other is evidence. A reader agreeing with what it was shown is not.
    // The user's choice of model and budget, read at execute time so a change
    // in Settings reaches the next paper rather than the next launch.
    const models = ctx.db.modelSettings()
    const blind: ReadCell[] = []
    let llmCallsBlind = 0
    // THE CONVERSATION, carried across every turn of this review.
    //
    // The system prompt and the table crops go over ONCE, in the first turn,
    // and every turn appended after them is a cache READ of that prefix rather
    // than a fresh send. Three separate calls used to pay full price for the
    // same picture three times.
    //
    // It is also what keeps the reading honest: the table is read and committed
    // to in turn 1, before a single stored value is mentioned. That ordering is
    // the blindness — not a separate prompt kept isolated by hand — so nothing
    // below may be moved above the first answer.
    const convo: LlmMessage[] = []
    const reviewOpts = {
      // A DIFFERENT, STRONGER MODEL than the extraction used. Two readings from
      // one model share its blind spots, and the whole value here is that the
      // second reader fails differently from the first.
      model: models.reviewModel === '' ? undefined : models.reviewModel,
      // A whole table, cell by cell, is a LONG answer — eight rows against four
      // columns is thirty-two cells, each with up to three figures and their
      // units. At the 4096-token default the reply was cut off mid-table and
      // discarded entirely, so the comparison saw ten cells of one crop and
      // none of the other.
      maxTokens: models.reviewMaxOutput
    }
    if (crops.images.length > 0) {
      const convoPrompt = getPrompt('review-conversation', REVIEW_CONVO_VERSION)
      convo.push({ role: 'system', content: convoPrompt.system })
      // EVERY crop in ONE turn. Sent separately they were separate
      // conversations, so a paper with three tables paid for three system
      // prompts and its own pictures three times over.
      convo.push({
        role: 'user',
        content: REVIEW_TURN_READ,
        images: crops.images
      })
      {
        try {
          llmCallsBlind++
          const text = await ctx.llm.call(convo, reviewOpts)
          convo.push({ role: 'assistant', content: text })
          const parsed = tableReadOutputSchema.safeParse(extractJson(text))
          if (!parsed.success) {
            ctx.log('blind table reading was not in the expected shape; it is discarded')
          } else
          for (const raw of parsed.data.cells) {
            const cell = tableCellSchema.safeParse(raw)
            if (!cell.success) continue
            const values: ReadValue[] = []
            for (const rv of cell.data.values) {
              const v = tableValueSchema.safeParse(rv)
              if (v.success) {
                values.push({
                  quantity: v.data.quantity,
                  value: v.data.value,
                  unit: v.data.unit ?? null
                })
              }
            }
            blind.push({
              row: cell.data.row,
              column: cell.data.column,
              marked: cell.data.marked ?? null,
              values
            })
          }
        } catch (err) {
          // A reading that never happened is not a disagreement. The stored
          // records stand and the ordinary questions below still run.
          ctx.log(
            `blind table reading failed: ${err instanceof Error ? err.message : String(err)}`
          )
        }
      }
      if (blind.length > 0) ctx.log(`blind reading covered ${blind.length} table cell(s)`)
    }

    interface Verdict {
      runId: number
      checkKey: string
      factId: number | null
      measurementId: number | null
      status: 'passed' | 'failed' | 'skipped'
      reason: string
      inputHash: string
      /**
       * The reader asked for this record to be withdrawn.
       *
       * Carried BESIDE the status rather than derived from it, because `failed`
       * has always meant "a reader contradicted this" over thousands of stored
       * rows and means it still. "The passage does not support this value" sends
       * a record to a human; "this record should not exist" is a different
       * judgement that only the reader can make, and inferring one from the
       * other would retract the whole corpus's contradicted rows at once.
       */
      retract?: boolean
    }
    const verdicts: Verdict[] = []
    // Values the reader found that the extraction missed. Collected here and
    // written by `applyWrites`, which owns the transaction — a stage never
    // writes directly, and a fact is not an exception to that.
    const foundOut: Array<{
      runId: number
      fieldId: number
      subject: string | null
      /**
       * Which set of measurements the value belongs to, in the reader's words.
       *
       * NULL is the reader's own claim that it holds across every set the
       * question listed, never a value this stage failed to carry.
       */
      conditions: string | null
      value: string
      quote: string
      basis: 'stated' | 'calculated'
    }> = []
    let llmCalls = 0
    let findings = 0
    let retracted = 0
    let problems = 0
    let unclear = 0
    let asked = 0
    let batchesLeft = BATCH_BUDGET
    let budgetHit = false

    for (const p of pending) {
      // ONE CONVERSATION PER RUN, not one request per batch.
      //
      // Every batch used to rebuild the whole message — system prompt, table
      // crops and each question's own excerpt of the paper — so nothing was
      // paid for once. The same footnote travelled twelve times because twelve
      // facts cited it. Appending instead means the expensive head is sent on
      // the first turn and read from cache on every turn after it, and the
      // model keeps what it has already read: a later question about the same
      // row is answered by a reader that has seen the earlier ones.
      //
      // The assistant's replies are appended too. Without them the turns are
      // not a conversation, and the provider has no prefix to match.
      //
      // THE PAPER IS THE FIRST TURN, and the only one that carries it. Each
      // question used to bring its own excerpt, so a footnote twelve facts cite
      // travelled twelve times and a row-shaped question brought the whole
      // document again — one review cost 984k tokens. Sent once, it is a cache
      // WRITE on the opening turn and a cache READ on every turn after: measured
      // at 15,214 written then 15,214 and 15,323 read back, with the new
      // question costing 109 and 23. It also gives the reader the whole paper
      // rather than the paragraphs one fact happened to cite, which is what a
      // question about an EMPTY cell needs — the value it is looking for is, by
      // definition, not in the passage the extraction quoted.
      const body = p.body
      const convo: LlmMessage[] = [{ role: 'system', content: prompt.system }]
      if (body !== null) {
        convo.push({
          role: 'user',
          content:
            'Here is the paper every question in this conversation is about. Read it ' +
            'now; the questions follow.\n\nPAPER TEXT:\n' +
            body
        })
        convo.push({ role: 'assistant', content: 'Read. Send the questions.' })
      }
      let first = true
      for (const batch of batchQuestions(p.questions)) {
        if (ctx.signal.aborted) return { status: 'failed', error: 'cancelled', retryable: true }
        if (batchesLeft <= 0) {
          budgetHit = true
          break
        }
        batchesLeft--
        asked += batch.questions.length

        let text: string
        try {
          llmCalls++
          // The crops ride on the FIRST turn only — they are the same pictures
          // for every question about this paper, and resending them would be
          // the whole saving thrown away.
          convo.push({
            role: 'user',
            content: prompt.buildUser(renderBatch(batch)),
            ...(first ? { images: crops.images } : {})
          })
          first = false
          text = await ctx.llm.call(convo, reviewOpts)
          convo.push({ role: 'assistant', content: text })
        } catch (err) {
          // NOT recorded as `unclear`. A call that never happened is not an
          // abstention by a reader — storing it as one would close the question
          // permanently on the strength of an outage. It writes no row, its
          // fingerprint is unchanged, and the next wake asks it again.
          // The user turn that was just pushed is REMOVED. Left in place it
          // would be resent on the next batch with no assistant reply behind
          // it, so the model would see two questions in a row and answer the
          // stale one — and the ids would not match the batch that asked.
          convo.pop()
          ctx.log(
            `review call failed: ${err instanceof Error ? err.message : String(err)}`
          )
          continue
        }

        const parsed = recordReviewOutputSchema.safeParse(extractJson(text))
        if (!parsed.success) {
          ctx.log('review answer was not in the expected shape; its questions stay open')
          continue
        }
        const byId = new Map(batch.questions.map((q) => [q.id, q]))
        for (const raw of parsed.data.reviews) {
          const item = recordReviewItemSchema.safeParse(raw)
          if (!item.success) continue
          const q = byId.get(item.data.id)
          // An id the batch did not contain. DROPPED rather than stored against
          // a guess: a verdict attached to the wrong record is worse than none.
          if (q === undefined) continue
          byId.delete(item.data.id)
          // WHAT THE READER FOUND, in the shape a fact is stored in.
          //
          // Kept beside the note rather than replacing it: the note says why,
          // the findings say what, and a verdict that has lost either is harder
          // to act on than one carrying both. Each is validated on its own, so
          // one malformed finding does not discard the others.
          const found = (item.data.found ?? [])
            .map((raw) => reviewFindingSchema.safeParse(raw))
            .flatMap((r) => (r.success ? [r.data] : []))
          findings += found.length
          for (const f of found) {
            // The label the model was shown, resolved against the schema this
            // run answered. Matched case- and punctuation-insensitively because
            // a model reproduces a label as prose; anything that resolves to no
            // field of this schema is dropped rather than filed under a guess.
            const want = fold(f.field)
            const field = p.fields.find((x) => fold(x.label) === want)
            if (field === undefined) {
              ctx.log(
                `the reading found "${f.field}" = ${f.value}, which names no field of this ` +
                  'schema; it is not stored'
              )
              continue
            }
            foundOut.push({
              runId: p.runId,
              fieldId: field.id,
              subject: f.subject ?? null,
              // Trimmed only. An empty string and an absent key both mean the
              // reader named no set, and the two must not become different
              // stored values of one claim.
              conditions:
                f.conditions === null || f.conditions === undefined || f.conditions.trim() === ''
                  ? null
                  : f.conditions.trim(),
              value: f.value,
              quote: f.quote,
              basis: f.basis === 'calculated' ? 'calculated' : 'stated'
            })
          }
          const rendered = found
            .map(
              (f) =>
                `${f.field}${f.subject ? ` (${f.subject})` : ''} = ${f.value}` +
                // Only a DERIVED value says how it was arrived at. Saying
                // "stated" on the rest would put the word on nearly every
                // finding, and the one that matters would read as another chip.
                `${f.basis === 'calculated' ? ' (worked out from the paper)' : ''}` +
                ` — "${f.quote}"`
            )
            .join('; ')
          const note = [(item.data.note ?? '').trim(), rendered]
            .filter((x) => x !== '')
            .join(' | ')
          const status = settleVerdict(item.data.verdict, note)
          if (status === 'failed') problems++
          if (status === 'skipped') unclear++
          // A RETRACTION HAS TO POINT AT SOMETHING, AND MUST NOT BE HEDGED.
          //
          // `q.factId` is the record the question named; a row-shaped question
          // names none, so a remedy from it would withdraw nothing and is
          // dropped rather than applied to a guess. `status === 'failed'` is the
          // second gate and it is deliberately the SETTLED status, not the
          // model's raw verdict: `settleVerdict` demotes a `problem` whose own
          // reason hedges, and a reader who is not sure a record is wrong is
          // certainly not sure it should be deleted.
          const retract =
            item.data.remedy === 'retract' && q.factId !== null && status === 'failed'
          if (retract) retracted++
          verdicts.push({
            runId: p.runId,
            checkKey: q.checkKey,
            factId: q.factId,
            measurementId: q.measurementId,
            status,
            reason:
              note === ''
                ? `${CHECK_LABELS[q.checkKey] ?? q.checkKey}: the reading returned no reason.`
                : note,
            inputHash: reviewInputHash(q, prompt.version),
            retract
          })
        }
        // Questions the model declined to answer at all stay OPEN. An omission
        // is not an abstention: the model was not asked to be exhaustive by
        // silence, and closing a question it never addressed would record a
        // verdict nobody reached.
      }
      if (budgetHit) break
    }

    // THE TWO READINGS, COMPARED. Mechanically, and only where both cover the
    // same cell — a cell the blind reading never reached says nothing about the
    // stored one, and treating its silence as "not printed" would manufacture a
    // disagreement out of a gap in coverage.
    //
    // These verdicts are not the model judging a stored value; they are two
    // independent readings differing about what is printed. That is why they
    // carry `unclear` rather than `problem`: the disagreement is real and a
    // human must settle it, but nothing here establishes WHICH reading is
    // right, and recording one as wrong on the strength of the other would just
    // move the confirmation bias to the other side.
    // PER RUN, not once over the paper. A paper is extracted once per schema,
    // and merging their cells compared a kinetics reading against a
    // thermostability one at the same row and column — two different questions
    // about the same place. Worse, every verdict was then filed under
    // `pending[0]`, so the kinetics run's disagreements were recorded against
    // the thermostability run and the kinetics run got none at all: the
    // comparison ran, found the real errors, and stored them where nothing
    // reads them.
    for (const p of blind.length > 0 ? pending : []) {
      const byCell = new Map<string, StoredCell>()
      for (const m of p.cells ?? []) {
        const k = `${m.subject ?? ''}\u0000${m.conditions ?? ''}`
        const cell = byCell.get(k) ?? {
          row: m.subject ?? '',
          column: m.conditions ?? '',
          values: []
        }
        cell.values.push({
          factId: m.fact_id,
          measurementId: m.id,
          quantity: m.field_label ?? m.quantity,
          value: m.value_text ?? (m.value_num === null ? '' : String(m.value_num)),
          unit: m.unit
        })
        byCell.set(k, cell)
      }
      if (byCell.size === 0) continue
      const raw = compareReadings([...byCell.values()], blind)
      if (raw.length > 0) {
        ctx.log(
          `run ${p.runId}: the two readings of this paper's table(s) differ on ` +
            `${raw.length} value(s)`
        )
      }

      // ONE LAST QUESTION, ABOUT WORDING ONLY.
      //
      // Some of what is left is not a disagreement about the table at all: the
      // two readers called one column `6-Cl BI` and `6-chloro BI`, and no
      // amount of string folding will say those are the same substrate while
      // keeping `6-chloro` and `5,7-dichloro` apart. That needs to know what
      // the words mean, so it is asked — and asked NARROWLY. The question is
      // never "is the extraction right"; both readings are already fixed and
      // the only thing in doubt is whether two names denote one thing.
      //
      // Failure is silent and safe: an unreachable model, a malformed answer or
      // an `unsure` all leave the disagreement standing, which is the outcome
      // this stage would have produced without asking.
      const sameWording = await settleWording(raw, ctx, models, convo)
      const disagreements = raw.filter((d) => !sameWording.has(d))
      if (sameWording.size > 0) {
        ctx.log(
          `${sameWording.size} of them were the same thing written two ways, and are dropped`
        )
      }

      for (const d of disagreements) {
        unclear++
        verdicts.push({
          runId: p.runId,
          checkKey: 'cell-second-reading',
          factId: d.factId,
          measurementId: d.measurementId,
          status: 'skipped',
          reason: describeDisagreement(d),
          // Keyed to the disagreement itself, so re-extracting the value or
          // re-reading the table reopens it and a mere re-plan does not.
          inputHash: reviewInputHash(
            {
              id: '',
              checkKey: 'cell-second-reading',
              factId: d.factId,
              measurementId: d.measurementId,
              ask: `${d.kind}|${d.row}|${d.column}|${d.quantity}|${d.stored}|${d.printed}`,
              passage: null,
              inputHash: `${d.kind}|${d.row}|${d.column}|${d.quantity}|${d.stored}|${d.printed}`
            },
            `${prompt.version}+${TABLE_READ_VERSION}`
          )
        })
      }
    }

    // NOTHING TO ASK IS NOT A FAILURE, and retrying it is a loop. A paper whose
    // records the checks all passed, or whose table reading found nothing to
    // put a question about, produces no verdicts because there was no question
    // — and a re-run asks the same nothing again. This retried five times over
    // a paper where the reading had in fact covered 156 table cells and agreed
    // with every one.
    //
    // Asked-and-unanswered is the different case, and the one worth retrying:
    // questions went to the model and none came back, which is a model or a
    // gateway that was not there.
    if (verdicts.length === 0) {
      if (asked === 0) {
        // `not-needed`, NOT `empty`. Empty means the stage looked and the paper
        // held nothing — a shortfall a reader might want to close, painted as
        // such and blocking what comes after. This is the opposite: every check
        // that ran agreed with what was extracted, so there WAS no question to
        // put, and the stage did its job by asking nothing. It reports as
        // succeeded, which is what it is.
        return {
          status: 'not-needed',
          reason:
            'nothing about this paper\u2019s records needed a second opinion — the checks that ' +
            'ran agreed with what was extracted'
        }
      }
      return {
        status: 'failed',
        error:
          `${asked} question(s) about this paper's records went to the reviewer and none came ` +
          'back answered',
        retryable: true
      }
    }

    ctx.write({
      verdicts,
      found: foundOut,
      // The model the questions were PUT TO, not the one the provider was built
      // with. `ctx.llm.model` is the gateway's default, chosen before any
      // setting was read, so a review run under the configured model recorded
      // the other one — and a verdict is only worth as much as the reader it
      // came from, which makes this the wrong field to guess in.
      model: reviewOpts.model ?? ctx.llm.model,
      promptVersion: prompt.version
    })

    return {
      status: 'succeeded',
      result: {
        runs: pending.length,
        questions: asked,
        answered: verdicts.length,
        problems,
        unclear,
        llmCalls
      },
      // HARD RULE 0.6: the ordinary outcome says nothing. A count of problems is
      // the exception, and `unclear` is reported because a reader who sees three
      // records judged and two abstained-on must know the second number exists.
      note: [
        `${verdicts.length} record(s) read`,
        ...(problems > 0 ? [`${problems} contradicted by the paper`] : []),
        ...(retracted > 0 ? [`${retracted} withdrawn as records the paper does not support`] : []),
        ...(findings > 0 ? [`${findings} value(s) the paper states and the reading missed`] : []),
        ...(unclear > 0 ? [`${unclear} could not be settled from the text`] : []),
        ...(budgetHit ? ['more remain; they are asked on the next pass'] : [])
      ].join('; '),
      // WHAT ANSWERED, not what the provider was built with. `ctx.llm.model`
      // is the constructor default, chosen before any setting was read, so a
      // run under the configured model recorded the other one — provenance
      // that disagrees with reality is worse than none.
      provenance: { model: reviewOpts.model ?? ctx.llm.model, promptVersion: prompt.version }
    }
  },

  applyWrites(db, payload) {
    const p = payload as {
      verdicts: Array<{
        runId: number
        checkKey: string
        factId: number | null
        measurementId: number | null
        status: 'passed' | 'failed' | 'skipped'
        reason: string
        inputHash: string
        /** The reader asked for this record to be withdrawn. See the write below. */
        retract?: boolean
      }>
      /**
       * Values the reader found in the paper that the extraction had missed.
       * Written as facts against the run they correct — see the insert below
       * for how `basis` becomes a kind and why they carry `origin_run_id`.
       */
      found?: Array<{
        runId: number
        fieldId: number
        subject: string | null
        conditions: string | null
        value: string
        quote: string
        basis: 'stated' | 'calculated'
      }>
      model: string
      promptVersion: string
    }
    const now = new Date().toISOString()
    const ins = db.prepare(
      `INSERT INTO analysis_check
         (analysis_run_id, check_key, status, reason, fact_id, measurement_id, created_at,
          source, model, prompt_version, input_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'reviewed', ?, ?, ?)`
    )
    // A verdict REPLACES the one it supersedes for the same question. Not
    // append-only, and deliberately so: `analysis_check` is keyed by run and
    // question, and two live answers to one question is a state the UI cannot
    // render — it would show a record as both judged sound and contradicted.
    // The rows this displaces are answers to a question whose fingerprint no
    // longer exists, so nothing can reach them.
    // KEYED ON THE QUESTION, not on the record it is about.
    //
    // `(run, check, fact, measurement)` is unique only while every question of a
    // kind names a distinct record. A row-shaped question names a SUBJECT and
    // carries neither id, so twelve of them shared one key and each insert
    // deleted the one before it — eleven answers destroyed after the stage had
    // already counted them, which is why it reported eighty records read and
    // twenty-eight findings while two rows existed.
    //
    // `input_hash` is the fingerprint of the question itself, so it replaces the
    // answer to THIS question and nothing else. The old key survives only for
    // rows written before hashes were stored; without that branch a re-review
    // would double them rather than displace them.
    const del = db.prepare(
      `DELETE FROM analysis_check
        WHERE analysis_run_id = ? AND check_key = ? AND source = 'reviewed'
          AND input_hash = ?`
    )
    const delLegacy = db.prepare(
      `DELETE FROM analysis_check
        WHERE analysis_run_id = ? AND check_key = ? AND source = 'reviewed'
          AND input_hash IS NULL
          AND COALESCE(fact_id, -1) = ? AND COALESCE(measurement_id, -1) = ?`
    )
    // WITHDRAWING A RECORD, BY NAMING THE VERDICT THAT WITHDREW IT.
    //
    // Marked, never deleted. The value stays exactly as the extraction stored it
    // — an export still carries it, with the reading that withdrew it beside it
    // — while every aggregate and the dossier stop counting it. A DELETE would
    // make a model's judgement unreviewable by the human it was written for, and
    // this app never destroys what a reading produced.
    //
    // The check id is the one this loop JUST inserted for that verdict, so the
    // retraction arrives already carrying its reason, its model and its prompt
    // version. A `retracted` boolean would have said a record is wrong with
    // nobody's name against it, and a later reader could not tell which reading
    // to argue with.
    //
    // Guarded on `retracted_by_check_id IS NULL`: the first verdict to withdraw
    // a record is the one recorded. A second reading of an already-withdrawn
    // record adds nothing, and overwriting would silently repoint the reason a
    // human has already read.
    const retract = db.prepare(
      `UPDATE fact SET retracted_by_check_id = ?
        WHERE id = ? AND retracted_by_check_id IS NULL`
    )
    const touched = new Set<number>()
    for (const v of p.verdicts) {
      del.run(v.runId, v.checkKey, v.inputHash)
      delLegacy.run(v.runId, v.checkKey, v.factId ?? -1, v.measurementId ?? -1)
      const checkId = Number(
        ins.run(
          v.runId,
          v.checkKey,
          v.status,
          v.reason,
          v.factId,
          v.measurementId,
          now,
          p.model,
          p.promptVersion,
          v.inputHash
        ).lastInsertRowid
      )
      // Both gates re-applied HERE and not trusted from the payload: a write
      // path that withdraws a record on a flag alone is one bad payload away
      // from withdrawing a corpus. Only a `failed` verdict that names a fact can
      // retract it, which is the same pair `execute` checked.
      if (v.retract === true && v.factId !== null && v.status === 'failed') {
        retract.run(checkId, v.factId)
      }
      touched.add(v.runId)
    }

    // WHAT THE READER FOUND, written as facts.
    //
    // `uncertain-conflicting` unless the reader says it CALCULATED the value.
    // A found value is usually one the paper directly reports — that is the
    // whole basis for adding it — but `directly-reported` is what the
    // EXTRACTION's readings claim, and a reviewer-added value wearing that kind
    // is indistinguishable from one the extractor found. The first agent is
    // checked by the reviewer; the reviewer is checked by nobody, so its
    // additions are claims a human must confirm, and this kind is the one that
    // already routes them there.
    //
    // `inferred` is the other half, and only when the reader answered
    // `calculated`: the paper never printed this value, it came out of one easy
    // arithmetic step over values that were printed. That is a different claim
    // from a transcription and a human settles it differently, so collapsing
    // the two would hide the derivation behind a kind that says a page states
    // it.
    //
    // `origin_run_id` names the run that produced the fact. Extractor facts
    // leave it NULL, so this column is what tells a reader which values came
    // from the second reading rather than the first.
    //
    // The quote is anchored the same way an extraction's is: located in the
    // document, `verbatim` set only on a real contiguous match. A reviewer that
    // could assert its own evidence would be worth less than one that cannot.
    const insSpan = db.prepare(
      `INSERT INTO evidence_span
         (analysis_run_id, document_id, paragraph, quote, verbatim, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    const insFact = db.prepare(
      `INSERT INTO fact
         (analysis_run_id, evidence_span_id, kind, predicate, subject, value_text,
          field_id, origin_run_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    // A FACT WITHOUT A MEASUREMENT IS A VALUE NOTHING CAN SEE.
    //
    // Every extractor fact carries one; not one of the reviewer's 33 did, and the
    // consequences were all silent. The Obsidian outlet drives from `measurement`
    // with an INNER JOIN, so it omitted every reviewer-found value while
    // reporting a complete note. `getSchemaCoverage` and the per-schema counts
    // undercounted by exactly those rows. Worst, the next review's own selectors
    // — the duplicate check and every cell-* question — iterate the measurements,
    // so a reviewer-written value was structurally unreviewable: the one class of
    // value in this app that no reader ever checks was the one written by the
    // reader nobody checks.
    //
    // `value_num`, `unit` and `error_num` are LEFT NULL, deliberately. The reader
    // returns the value as the page prints it and says nothing about its parts,
    // and pulling a number out of that string is a parser standing in for a
    // reading — the failure mode this whole file exists to avoid. NULL there
    // means "this reading did not state one", which is true. The canonical pair
    // follows from it: the v35 triggers derive them from `unit`, and with no unit
    // they correctly stay NULL rather than being invented.
    const insMeas = db.prepare(
      `INSERT INTO measurement
         (fact_id, field_id, quantity, value_num, value_text, unit, error_num, conditions,
          created_at)
       VALUES (?, ?, ?, NULL, ?, NULL, NULL, ?, ?)`
    )
    const fieldLabel = db.prepare(`SELECT label FROM extraction_field WHERE id = ?`)
    const docOf = db.prepare(
      `SELECT document_id AS id FROM evidence_span
        WHERE analysis_run_id = ? AND document_id IS NOT NULL LIMIT 1`
    )
    const paras = db.prepare(
      `SELECT idx, text FROM document_paragraph
        WHERE document_id = ? AND kind <> 'reference' ORDER BY idx ASC`
    )
    // CONDITIONS ARE PART OF THE IDENTITY, because they are part of the claim.
    // One subject may carry the same field under two sets of circumstances — the
    // reason the row question is split at all — and those are two values, not a
    // repeat. Keyed without them, the second would be discarded as a duplicate
    // of the first and the set it belongs to would stay empty forever. The join
    // is LEFT because the reviewer facts written before this had no measurement
    // row at all; those match only a finding that names no conditions, which is
    // the claim they were stored as.
    const existing = db.prepare(
      `SELECT f.id FROM fact f
       LEFT JOIN measurement m ON m.fact_id = f.id
        WHERE f.analysis_run_id = ? AND f.origin_run_id IS NOT NULL
          AND f.field_id = ? AND COALESCE(f.subject, '') = COALESCE(?, '')
          AND COALESCE(f.value_text, '') = ?
          AND COALESCE(m.conditions, '') = COALESCE(?, '')
        LIMIT 1`
    )
    // The same normalisation the anchor contract uses everywhere: a PDF's text
    // layer breaks lines mid-word and spaces out symbols, so a quote that reads
    // correctly matches only after both sides are reduced to letters and digits.
    const canon = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{Nd}]+/gu, '')
    for (const f of p.found ?? []) {
      const doc = docOf.get(f.runId) as { id: number } | undefined
      let paragraph: number | null = null
      let verbatim = 0
      if (doc) {
        const needle = canon(f.quote)
        for (const row of paras.all(doc.id) as Array<{ idx: number; text: string }>) {
          if (needle !== '' && canon(row.text).includes(needle)) {
            paragraph = row.idx
            verbatim = row.text.includes(f.quote) ? 1 : 0
            break
          }
        }
      }
      const label = (fieldLabel.get(f.fieldId) as { label: string } | undefined)?.label
      // A finding naming no field of this schema is DROPPED. It cannot be filed,
      // and storing it under a guess is the one thing worse than losing it.
      if (label === undefined) continue
      // ALREADY WRITTEN? A question reopens whenever the values it was asked
      // about change, so the same finding legitimately arrives more than once,
      // and an unguarded insert would stack duplicate rows claiming one value.
      // The quote is not part of the identity: a later pass may cite the same
      // value from a different sentence, which is the same claim.
      const already = existing.get(f.runId, f.fieldId, f.subject, f.value, f.conditions) as
        | { id: number }
        | undefined
      if (already !== undefined) continue
      const spanId = doc
        ? Number(insSpan.run(f.runId, doc.id, paragraph, f.quote, verbatim, now).lastInsertRowid)
        : null
      const factId = Number(
        insFact.run(
          f.runId,
          spanId,
          f.basis === 'calculated' ? 'inferred' : 'uncertain-conflicting',
          label,
          f.subject,
          f.value,
          f.fieldId,
          f.runId,
          now
        ).lastInsertRowid
      )
      // `quantity` is the field's own label, which is what the extractor's
      // measurements carry when the model names no other name for the quantity,
      // and it is the only name this finding has: the reader answered by the
      // label the question showed it.
      insMeas.run(factId, f.fieldId, label, f.value, f.conditions, now)
      touched.add(f.runId)
    }
    // `deterministic_validation` is the conjunction of a run's verdicts and now
    // has two contributors, so it is recomputed from the table rather than from
    // either engine's own array.
    const restamp = db.prepare(
      `UPDATE analysis_run
          SET deterministic_validation = CASE
            WHEN EXISTS (
              SELECT 1 FROM analysis_check c
               WHERE c.analysis_run_id = analysis_run.id AND c.status = 'failed'
            ) THEN 0 ELSE 1 END
        WHERE id = ?`
    )
    for (const runId of touched) restamp.run(runId)
  }
}

export default reviewRecords
