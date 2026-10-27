// Ask the model to FIX an answer that did not match the schema, instead of
// silently discarding the parts that failed.
//
// WHY. Validation failures here are rarely the model being wrong about the
// paper — they are the model being wrong about the FORM. It answered a word
// where the schema wanted a number, and because the field sat on the fact, zod
// rejected the whole fact. On one paper that discarded all 23 facts, including
// the only melting temperatures in the corpus: a complete, correct extraction
// thrown away over an optional field nothing downstream depends on.
//
// The old behaviour hid this. `safeParse` failed, the salvage loop kept
// whatever validated individually, and a run that lost everything looked
// identical to a paper that reported nothing. Nobody was told which field was
// wrong — least of all the model, which could have fixed it in one sentence.
//
// So: tell it exactly what failed, where, and what was expected, and let it
// return a corrected answer. This is a REPAIR of a well-formed attempt, not a
// second guess at the paper: the retry carries the original answer and the
// errors, never a fresh read of the document.
//
// The model does NOT get to end the conversation with an invalid answer. It is
// told what is wrong and asked again, up to MAX_ERRORS_PER_CONVERSATION times
// within one conversation. Past that the thread is abandoned rather than
// extended: a conversation carrying twenty rejected answers is mostly a record
// of its own failure, and each further turn re-reads that instead of the task.
// So the conversation is DROPPED and redispatched from a clean first turn.
// After MAX_CONVERSATIONS such attempts the stage fails outright — honestly,
// as a failure, rather than persisting a run built from whatever happened to
// validate.

import type { z } from 'zod'
import { logValidationFailure } from '../devlog'
import { extractJson } from './provider'

/**
 * Just enough of an LLM to hold a conversation.
 *
 * Not `LlmProvider`: a STAGE never sees one — `ctx.llm.call` is deliberately
 * the only network primitive it is given — and this has to be usable from both
 * sides or the guarantee only covers half the pipeline.
 */
export type ChatFn = (
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  opts?: { maxTokens?: number; effort?: 'low' | 'medium' | 'high' }
) => Promise<string>

/** How many of the model's mistakes to quote back in one correction. */
const MAX_REPORTED_ISSUES = 25

/**
 * Invalid answers tolerated before the run is abandoned.
 *
 * The model does not get to end the exchange with an answer that does not
 * validate: each failure is named precisely and handed back. But it also does
 * not get to fail forever — after twenty rejected answers the run is discarded
 * as "could not produce a valid result", which is a FAILURE and is reported as
 * one. Never a run quietly assembled from whichever fragments happened to
 * validate, because that is indistinguishable from a good extraction.
 */
export const MAX_INVALID_ANSWERS = 20

/**
 * Corrections offered within one conversation before starting a fresh one.
 *
 * A thread carrying many rejected answers is mostly a record of its own
 * failure, and every further turn re-reads that instead of the task — models
 * entrench on a wrong form rather than escape it. Past this the history is the
 * problem, so the remaining budget is spent on a clean first turn instead.
 * This does NOT reset the error count: the twenty is a total.
 */
const ERRORS_PER_CONVERSATION = 5

/**
 * Render zod issues as instructions a model can act on.
 *
 * Addressed by PATH, because the answer is an array: "facts[7].value_text" tells
 * it which record to fix, where "Expected number, received string" alone does
 * not. The offending VALUE is quoted back for the same reason — the model has
 * to recognise its own output to correct it.
 */
export function describeIssues(issues: readonly z.ZodIssue[], payload: unknown): string {
  const lines: string[] = []
  const seen = new Set<string>()
  for (const issue of issues) {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
    // One line per distinct path+message. A 40-fact answer with the same
    // mistake in every record produces 40 identical issues, and repeating them
    // buries the other problems while spending the output budget.
    const key = `${path}|${issue.message}`
    if (seen.has(key)) continue
    seen.add(key)
    let actual = ''
    try {
      let cur: unknown = payload
      for (const seg of issue.path) {
        if (cur == null) break
        cur = (cur as Record<string | number, unknown>)[seg as string | number]
      }
      if (cur !== undefined) actual = ` (you sent ${JSON.stringify(cur)})`
    } catch {
      // Best effort. A path we cannot walk still has a useful message.
    }
    lines.push(`- ${path}: ${issue.message}${actual}`)
    if (lines.length >= MAX_REPORTED_ISSUES) {
      lines.push(`- …and ${issues.length - lines.length} more of the same kind`)
      break
    }
  }
  return lines.join('\n')
}

/**
 * The model produced twenty answers and none of them validated.
 *
 * A distinct error type because the caller must treat it as a FAILED STAGE and
 * not as "this paper had nothing" — the two are opposite claims and only one of
 * them is a reason to look at the paper again.
 */
export class SchemaRepairExhaustedError extends Error {
  constructor(
    readonly attempts: number,
    /** The violations from the final attempt, for the failure message. */
    readonly lastIssues: string
  ) {
    super(
      `the model produced ${attempts} answers and none matched the required schema; ` +
        `last problems:\n${lastIssues}`
    )
    this.name = 'SchemaRepairExhaustedError'
  }
}


/**
 * Get a schema-valid answer out of the model, or fail loudly having tried.
 *
 * `ask` performs one FRESH conversation and returns the model's raw text. It is
 * a callback rather than a message array because the caller owns what a first
 * turn looks like — an extraction sends images, a summary does not — and
 * because starting over must genuinely start over.
 *
 * The loop:
 *   1. validate; return on success
 *   2. name every violation and hand the answer back for correction
 *   3. after ERRORS_PER_CONVERSATION corrections, abandon the thread and
 *      redispatch a clean one
 *   4. after MAX_INVALID_ANSWERS invalid answers in total, throw
 *
 * `systemPrompt` is resent on every correction so the schema and the grounding
 * rules stay in force — a repair that forgot the evidence contract would return
 * well-typed facts with fabricated quotes, which is worse than the type error.
 */
export async function insistOnValid<S extends z.ZodTypeAny>(
  schema: S,
  opts: {
    /** How to talk to the model. `provider.callLLM` or `ctx.llm.call`. */
    chat: ChatFn
    systemPrompt: string
    /** Runs one fresh conversation. Called again after a thread is abandoned. */
    ask: () => Promise<string>
    /** What the model was originally asked, for context in a correction turn. */
    originalUser: string
    maxTokens: number
    log?: (msg: string) => void
    /** Names the schema in the developer log, so a rejection says WHAT rejected it. */
    schemaName?: string
  }
): Promise<z.infer<S>> {
  let invalid = 0
  let lastIssues = 'the reply was not JSON'
  // Carried across corrections within one thread; cleared when it is abandoned.
  let history: Array<{ role: 'user' | 'assistant'; content: string }> = []
  let sinceFreshStart = 0

  // THE REQUEST IS RESENT WHOLE. It used to be cut to its first 4000 characters
  // on the theory that the model "has already seen" the paper — but a
  // correction is a new turn, and what it is being corrected about is almost
  // always a QUOTE: an anchor that occurs twice, or one the document does not
  // contain. Answering that means searching the text, and the text was the part
  // removed. So the loop asked for a string to be found in a document it had
  // just deleted, twenty times, and then failed the stage.
  //
  // The context window is not the constraint it was when that trim was written:
  // the models this app calls carry 200k and 1M tokens, against a paper of
  // perhaps 80k characters. Sending it again costs input tokens and buys the
  // one thing the correction needs.
  const askedFor = opts.originalUser

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let raw: string
    if (history.length === 0) {
      raw = await opts.ask()
    } else {
      raw = await opts.chat([{ role: 'system', content: opts.systemPrompt }, ...history], {
        maxTokens: opts.maxTokens,
        effort: 'medium'
      })
    }

    const parsed = extractJson(raw)
    if (parsed != null) {
      const res = schema.safeParse(parsed)
      if (res.success) {
        if (invalid > 0) opts.log?.(`valid after ${invalid} rejected answer(s)`)
        return res.data
      }
      lastIssues = describeIssues(res.error.issues, parsed)
    } else {
      lastIssues = 'the reply was not a JSON object'
    }

    invalid++
    // The rejected text AND the reasons, together. `opts.log` carries the app's
    // prose about the rejection; without the answer beside it nobody can tell a
    // model that is wrong from a schema that is, and by the time the question
    // is asked `raw` is long gone — which has meant re-running the corpus to
    // recover one bit of information.
    logValidationFailure({
      schemaName: opts.schemaName ?? 'unnamed',
      attempt: invalid,
      raw,
      parsed: parsed != null,
      issues: lastIssues
    })
    opts.log?.(`invalid answer ${invalid}/${MAX_INVALID_ANSWERS}:\n${lastIssues}`)
    // The ceiling is on ERRORS, not on conversations: twenty bad answers ends
    // the run however they were distributed across threads.
    if (invalid >= MAX_INVALID_ANSWERS) {
      throw new SchemaRepairExhaustedError(invalid, lastIssues)
    }

    sinceFreshStart++
    if (sinceFreshStart >= ERRORS_PER_CONVERSATION) {
      opts.log?.('abandoning this conversation and starting a clean one')
      history = []
      sinceFreshStart = 0
      continue
    }

    // Build (or extend) the correction thread. The FIRST correction has to
    // restate the request, because `ask` owns the opening turn and we do not
    // have its message list.
    if (history.length === 0) history = [{ role: 'user', content: askedFor }]
    history.push({ role: 'assistant', content: raw })
    history.push({
      role: 'user',
      content: [
        'Your answer did not match the required schema. These are the problems:',
        '',
        lastIssues,
        '',
        'Return the SAME content with only these problems fixed.',
        'Do not re-read the document, do not add or remove records, and do not',
        'change any value, quote or paragraph id that was not named above —',
        'correct only the fields listed.',
        'If a value cannot be expressed in the required type, omit that field',
        'rather than inventing one for it.',
        'Return ONLY the corrected JSON object, with no prose around it.'
      ].join('\n')
    })
  }
}
