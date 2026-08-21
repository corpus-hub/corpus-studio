import { userInfo } from 'node:os'
import { z } from 'zod/v4'
import { e, type Entry } from '../types'
import { getReviewQueue, getReviewQueuePage, recordFactVerdict } from '../../db/repositories'
import { cap, CLAMP } from '../clamp'
import { listScope, scopeNote } from '../result'

/**
 * Review — the human judgement layer over extracted facts.
 *
 * APPEND-ONLY, AND THAT IS THE WHOLE STATE MODEL. Recording a verdict never
 * mutates the fact, its evidence spans or the `analysis_run` that produced it:
 * it inserts a row into `fact_verdict`. A verdict is RETRACTED by appending
 * another one with `verdict: 'unresolved'`, never by deleting. So nothing here
 * is destructive, and there is no second state machine to invent.
 *
 * v3 -> zod/v4 re-authoring of `verdictSchema`, field for field: `projectId`
 * and `factId` were `z.number().int().positive()` — POSITIVE, deliberately, and
 * not the app's `idSchema`: a verdict is always recorded FOR a real project and
 * `project_id = 0` is the global sentinel, which `fact_verdict`'s own CHECK also
 * refuses. `verdict` is the same 4-member enum. `correctedValue` keeps
 * `.trim().min(1).max(2000)` and `note` `.trim().max(2000)`. The `.refine()` is
 * kept — it is what makes the biconditional a readable message instead of
 * SQLITE_CONSTRAINT — and, because `z.toJSONSchema` silently DROPS refinements,
 * the rule it encodes is restated in the tool summary in words.
 */

const projectId = z.number().int().nonnegative()

export const REVIEW_ENTRIES: Entry[] = [
  e({
    channel: 'review:queue',
    tool: 'review_queue_get',
    access: 'read',
    summary:
      'The facts in a project awaiting human judgement: what was extracted, why it was ' +
      'escalated (`reason`, `failed_checks`), the verdict already recorded if any, and that ' +
      'fact\u2019s verdict history. THIS QUEUE IS A SAMPLE-TOPPED LIST, NOT A PAGE-ABLE ONE \u2014 ' +
      'it folds in a random quality-control sample of auto-validated records, so the population ' +
      'differs between two calls and there is deliberately no offset. To see more, ask for a ' +
      'larger `limit` and re-read; do not try to page. `total` is the true size. A verdict ' +
      'marked `stale: true` was passed on an EARLIER extraction run, so the item stays in the ' +
      'queue. Use extraction_status_get for the queue\u2019s shape before reading it.',
    returns: 'ReviewItemDTO[]',
    params: z.object({
      projectId,
      limit: z.number().int().min(1).nullish()
    }),
    order: ['projectId'],
    run: (ctx, a) =>
      getReviewQueue(
        ctx.db,
        a.projectId,
        a.limit === null || a.limit === undefined ? {} : { limit: a.limit }
      ),
    clampArgs: (a) => ({ ...a, limit: cap(a.limit, CLAMP.limit) }),
    // Re-read through `getReviewQueuePage` rather than counting beside the list
    // already fetched. The QC sampler is RANDOM, so calling `getReviewQueue` and
    // `countReviewQueue` separately draws the sample twice and the count then
    // describes a different population from the items — a queue reporting 41 and
    // handing back 40, which reads as data loss. `getReviewQueuePage` draws the
    // sample ONCE and passes it to both. The extra query is the price of the two
    // numbers agreeing.
    shape: (_result, ctx, a) => {
      const paged = getReviewQueuePage(
        ctx.db,
        a.projectId,
        a.limit === null || a.limit === undefined ? {} : { limit: a.limit }
      )
      const items = paged.items as unknown as {
        verdict?: Record<string, unknown> | null
        verdict_history?: unknown[]
      }[]
      const total = paged.total
      // `verdict_history` is the FULL audit trail per item and is the single
      // largest thing in this reply. The five most RECENT are kept — the ones
      // that describe the current state — and `verdict_history_total` says how
      // many there were, so a caller can always see that earlier judgements
      // exist rather than concluding there were none.
      const trimmed = items.map((item) => {
        const history = Array.isArray(item.verdict_history) ? item.verdict_history : []
        return {
          ...item,
          verdict: attribute(item.verdict),
          verdict_history: history.slice(-5).map((v) => attribute(v as Record<string, unknown>)),
          verdict_history_total: history.length,
          verdict_history_truncated: history.length > 5
        }
      })
      return listScope(trimmed, total, {
        note: total === 0 ? scopeNote.emptyProject(ctx.db, a.projectId) : null,
        counts: null,
        limit: a.limit ?? null
      })
    }
  }),

  e({
    channel: 'review:verdict',
    tool: 'review_record_verdict',
    access: 'write',
    summary:
      'Record a human judgement on one extracted fact: accept it, correct its value, reject it, ' +
      'or return it to undecided. `correctedValue` is REQUIRED when verdict is "corrected" and ' +
      'REFUSED for every other verdict \u2014 that rule is enforced but cannot be expressed in ' +
      'this schema, so read it here. `projectId` must be a real project, never 0: a verdict is ' +
      'never global. This is APPEND-ONLY \u2014 it never alters the fact, its evidence or the ' +
      'analysis run that produced it, and a verdict is retracted by recording "unresolved", not ' +
      'by deleting. ATTRIBUTION IS RESOLVED BY THE APP, NOT BY YOU: the verdict is signed with ' +
      'the operating-system account of the person who owns this install, marked as having come ' +
      'through the agent connection. You are signing scientific judgement in their name \u2014 ' +
      'do not record a verdict you were not asked for. Get `factId`s from review_queue_get. If ' +
      'this call times out or your connection drops the write is NOT rolled back.',
    returns: 'FactVerdictDTO',
    params: z
      .object({
        projectId: z.number().int().positive(),
        factId: z.number().int().positive(),
        verdict: z.enum(['accepted', 'corrected', 'rejected', 'unresolved']),
        correctedValue: z.string().trim().min(1).max(2000).optional(),
        note: z.string().trim().max(2000).optional()
      })
      .refine((v) => (v.verdict === 'corrected') === (v.correctedValue !== undefined), {
        message: "a corrected value is required for verdict 'corrected' and rejected otherwise",
        path: ['correctedValue']
      }),
    run: (ctx, a) => {
      // Resolved HERE, in main, from the OS account. The caller never supplies
      // it, so an attribution in the audit trail cannot be forged — by page
      // script or by an agent.
      let reviewer = 'unknown'
      try {
        reviewer = userInfo().username || 'unknown'
      } catch {
        /* some sandboxes have no passwd entry — recorded honestly as 'unknown' */
      }
      // An agent's verdict is still the machine owner's responsibility, but it
      // is not the same act as a person reading the paper and clicking accept.
      // The trail says which it was, so a scientist re-reading their own review
      // history can tell the two apart.
      if (ctx.source === 'mcp') reviewer = `${reviewer}${AGENT_MARKER}`
      return recordFactVerdict(ctx.db, { ...a, reviewer })
    },
    // The stored `reviewer` is the operating-system account name. It is the
    // right thing to keep in the DB and the right thing to show the person whose
    // machine it is; it is not something to hand an external agent, which only
    // needs to know whether a human or an agent signed the judgement.
    shape: (result) => attribute(result as Record<string, unknown>)
  })
]

/** Marker appended to `reviewer` when the verdict arrived over the agent connection. */
const AGENT_MARKER = ' (via MCP agent)'

/**
 * Replace a verdict's `reviewer` with WHO KIND of reviewer it was.
 *
 * The account name is the machine owner's, and an agent that can read the review
 * queue at the lowest permission level would otherwise learn it from the first
 * call it makes. What an agent can act on is whether a person judged this or
 * another agent did — a verdict it recorded itself is not evidence that a
 * scientist agreed.
 */
function attribute(verdict: Record<string, unknown> | null | undefined): unknown {
  if (!verdict) return verdict ?? null
  const { reviewer, ...rest } = verdict
  return {
    ...rest,
    reviewer_kind:
      typeof reviewer === 'string' && reviewer.endsWith(AGENT_MARKER) ? 'agent' : 'human'
  }
}
