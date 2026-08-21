import { z } from 'zod/v4'
import { e, type Entry } from '../types'
import {
  getRanking,
  countRanking,
  setInclusionStatus,
  overrideScore,
  markReferencePaper
} from '../../db/repositories'
import { getJobQueue } from '../../pipeline/scheduler'
import { cap, capOffset, CLAMP } from '../clamp'
import { listScope, scopeNote } from '../result'

/**
 * Ranking — and the dossier's reference set, which lives on the same row.
 *
 * TWO SCORES, NEVER ONE. `relevance` ("does this paper bear on the question")
 * and `expansion_priority` ("is following this paper's citations worth the
 * effort") measure different things and HARD RULE 3 forbids fusing them. They
 * are separate columns with separate meanings and each carries its own share of
 * one stored `ranking_explanation`. An agent told to "rank the papers" will
 * average them unless the tool description forbids it in words, so every
 * ranking summary below says so.
 *
 * PROJECT INTERPRETATION, NOT THE PAPER. Everything these channels write lands
 * on `project_work` — the same paper in another project carries different
 * numbers, a different inclusion status and a different reference flag. Nothing
 * here may be pooled across projects, and nothing here touches the global
 * `work` row.
 *
 * v3 -> zod/v4 re-authoring: `idSchema` was `z.number().int().nonnegative()`
 * (nonnegative because `project_id = 0` is the global sentinel), the sort enum
 * and the score bounds are field-identical. The optional TRAILING POSITIONAL
 * arguments (`sortBy`, `reason`) are `.nullish()` and not `.optional()`: the
 * registry loop turns a missing positional into a PRESENT `undefined` and a
 * passed `null` into a PRESENT `null`, and `.optional()` rejects the second.
 * The renderer really does call `getRanking(projectId)` with one argument.
 */

const nowIso = (): string => new Date().toISOString()

const projectId = z.number().int().nonnegative()
const workId = z.number().int().nonnegative()

/**
 * `limit`/`offset` are NOT in the preload's argument list and never reach the
 * channel — the renderer forwards `(projectId, sortBy)` and nothing else, so
 * these stay absent for every UI call and the repository's unpaged default
 * behaviour is preserved byte for byte. They exist for the MCP caller, which
 * passes one object and is clamped by `clampArgs`.
 */
const page = {
  limit: z.number().int().min(1).nullish(),
  offset: z.number().int().min(0).nullish()
}

export const RANKING_ENTRIES: Entry[] = [
  e({
    channel: 'ranking:get',
    tool: 'ranking_get',
    access: 'read',
    summary:
      'Both of a project\u2019s rankings for every paper in it, with the stored explanation ' +
      'for each and any human override. RELEVANCE and EXPANSION_PRIORITY MEASURE DIFFERENT ' +
      'THINGS \u2014 relevance is how much the paper bears on the question, expansion_priority ' +
      'is how worthwhile following its citations would be. Never average, blend or otherwise ' +
      'combine them; report them separately. `ranking_explanation` is the app\u2019s own stored ' +
      'reason for the score and `user_overrides` is a JSON string of the values a human set by ' +
      'hand, which take precedence over the computed ones. These numbers belong to THIS project: ' +
      'the same paper in another project has different ones. Paginated \u2014 read `total`.',
    returns: 'RankingRowDTO[]',
    params: z.object({
      projectId,
      sortBy: z.enum(['relevance', 'expansion', 'year', 'citations']).nullish(),
      ...page
    }),
    order: ['projectId', 'sortBy'],
    run: (ctx, a) =>
      getRanking(
        ctx.db,
        a.projectId,
        // `?? undefined` and not `?? 'relevance'`: the repository declares the
        // default in its own signature, and `null` does not trigger a default
        // parameter. Naming the value here would be a second definition of it.
        a.sortBy ?? undefined,
        a.limit === null || a.limit === undefined
          ? {}
          : { limit: a.limit, offset: a.offset ?? 0 }
      ),
    clampArgs: (a) => ({
      ...a,
      limit: cap(a.limit, CLAMP.limit),
      offset: capOffset(a.offset)
    }),
    shape: (result, ctx, a) => {
      const items = result as unknown[]
      const total = countRanking(ctx.db, a.projectId)
      return listScope(items, total, {
        note:
          total === 0
            ? scopeNote.emptyProject(ctx.db, a.projectId)
            : items.length === 0
              ? // This tool takes no filters, so an empty page can only mean the
                // offset is beyond the last row. Blaming "filters" would send an
                // agent looking for a constraint it never set.
                `${total} ranked paper(s) in project ${a.projectId}; offset ${
                  a.offset ?? 0
                } is past the last of them.`
              : null,
        counts: null,
        limit: a.limit ?? null,
        offset: a.offset ?? 0
      })
    }
  }),

  e({
    channel: 'ranking:setInclusion',
    tool: 'ranking_set_inclusion',
    access: 'write',
    summary:
      'Record whether a paper is included in, excluded from, or still undecided for a project, ' +
      'with an optional free-text reason. This is the scientist\u2019s editorial decision about ' +
      'THIS project and is stored on the project\u2019s own row \u2014 it does not change the ' +
      'paper, and it is invisible to every other project. Returns nothing; read it back with ' +
      'ranking_get. If this call times out or your connection drops the write is NOT rolled ' +
      'back \u2014 read the state back before retrying.',
    returns: 'void',
    params: z.object({
      projectId,
      workId,
      status: z.enum(['read', 'unread', 'included', 'excluded', 'uncertain']),
      // UNBOUNDED, matching the v3 original's bare `z.string().optional()`. A
      // `.max()` here would be a narrowing: the Ranking screen's reason box has
      // no length limit, so a long pasted justification that stores today would
      // start throwing. `.nullish()` rather than `.optional()` because a missing
      // trailing positional argument arrives as a PRESENT undefined and a passed
      // one as a present null, and `.optional()` rejects the second.
      reason: z.string().nullish()
    }),
    // The CHANNEL keeps the unbounded reason above; the TOOL gets a bounded one.
    // The sweep requires every string an agent can send to carry a ceiling — an
    // unbounded one is a memory amplifier — and `toolParams` is the sanctioned
    // way to say "the channel accepts more than the tool does" without narrowing
    // what the renderer may send.
    toolParams: z.object({
      projectId,
      workId,
      status: z.enum(['read', 'unread', 'included', 'excluded', 'uncertain']),
      reason: z.string().max(2000).nullish()
    }),
    order: ['projectId', 'workId', 'status', 'reason'],
    run: (ctx, a) =>
      setInclusionStatus(
        ctx.db,
        a.projectId,
        a.workId,
        a.status,
        a.reason ?? undefined,
        nowIso()
      )
  }),

  e({
    channel: 'ranking:override',
    tool: 'ranking_override_score',
    access: 'write',
    summary:
      'Set one of the two scores for one paper in one project BY HAND, overriding the computed ' +
      'value, with an optional reason. `field` is exactly one of relevance or expansion_priority ' +
      '\u2014 they are separate measures and setting one says nothing about the other. The ' +
      'override is recorded in the row\u2019s `user_overrides` JSON and SURVIVES every later ' +
      'scoring pass, which leaves an overridden column exactly as you set it. It does NOT ' +
      'rewrite the stored `ranking_explanation`, so until the next scoring pass the explanation ' +
      'still describes the measured number rather than yours. Returns nothing; read it back with ' +
      'ranking_get. If this call times out or your connection drops the write is NOT rolled back.',
    returns: 'void',
    params: z.object({
      projectId,
      workId,
      field: z.enum(['relevance', 'expansion_priority']),
      value: z.number().min(0).max(1),
      // UNBOUNDED, matching the v3 original's bare `z.string().optional()`. A
      // `.max()` here would be a narrowing: the Ranking screen's reason box has
      // no length limit, so a long pasted justification that stores today would
      // start throwing. `.nullish()` rather than `.optional()` because a missing
      // trailing positional argument arrives as a PRESENT undefined and a passed
      // one as a present null, and `.optional()` rejects the second.
      reason: z.string().nullish()
    }),
    // Bounded for the agent, unbounded for the renderer — see ranking:setInclusion.
    toolParams: z.object({
      projectId,
      workId,
      field: z.enum(['relevance', 'expansion_priority']),
      value: z.number().min(0).max(1),
      reason: z.string().max(2000).nullish()
    }),
    order: ['projectId', 'workId', 'field', 'value', 'reason'],
    run: (ctx, a) =>
      overrideScore(
        ctx.db,
        a.projectId,
        a.workId,
        a.field,
        a.value,
        a.reason ?? undefined,
        nowIso()
      )
  }),

  e({
    channel: 'ranking:recompute',
    tool: 'ranking_recompute',
    access: 'write',
    summary:
      'Ask for both rankings to be scored again, for EVERY project rather than only this one: ' +
      'the scoring pass is a single sweep over the whole library, and `projectId` names who is ' +
      'asking, not what is rescored. IT RETURNS BEFORE THE SCORES CHANGE \u2014 the work is ' +
      'queued and a local model reads each paper\u2019s title and abstract against its ' +
      'project\u2019s description, which takes about a tenth of a second per paper. Read the ' +
      'numbers back with ranking_get afterwards, and do not treat the ones you read immediately ' +
      'as the new ones. HUMAN OVERRIDES ARE RESPECTED: a score a person set by hand is left ' +
      'exactly as they set it. You RARELY need this \u2014 editing a project\u2019s description, ' +
      'importing a paper and resolving a reference each re-score the library on their own. Call ' +
      'it when you want the same inputs scored again.',
    returns: '{ queued: boolean, discardedRuns: number }',
    params: z.object({ projectId }),
    order: ['projectId'],
    // `projectId` is validated and then deliberately unused: the sweep covers
    // every project, and an entry that took no project at all could not be
    // scoped by the same permission checks as the rest of this file.
    run: () => {
      const out = getJobQueue().forceRerunSweep('rerank')
      return { queued: true, discardedRuns: out.supersededRunIds.length }
    }
  }),

  e({
    channel: 'ranking:markReference',
    // Named for what the AGENT is trying to do. In the app this control lives on
    // the Ranking screen and is called "mark as reference paper"; an agent asked
    // to "add this paper to the dossier" would never look for it under that
    // name. There is no separate `dossier:add` channel — this IS the mechanism.
    tool: 'dossier_add_paper',
    access: 'write',
    summary:
      'Mark (or unmark) a paper as a REFERENCE PAPER for a project \u2014 one of the papers the ' +
      'topic dossier is built from. Same action as "mark as reference paper" on the Ranking ' +
      'screen. Pass isReference: false to unmark. THIS DOES NOT REBUILD THE DOSSIER: the paper ' +
      'appears immediately in dossier_status_get\u2019s `references` but not in its `sources`, ' +
      'and no claim of it enters dossier_get, until you call dossier_build. Stopping here is ' +
      'the commonest way this sequence is left half-done. If this call times out or your ' +
      'connection drops the write is NOT rolled back.',
    returns: 'RankingRowDTO[]  (MCP: { paper, is_reference, references_total, next_step })',
    params: z.object({ projectId, workId, isReference: z.boolean() }),
    order: ['projectId', 'workId', 'isReference'],
    run: (ctx, a) => {
      const db = ctx.db
      markReferencePaper(db, a.projectId, a.workId, a.isReference, nowIso())
      // The refreshed rows, so the renderer paints from the write's result
      // instead of racing a re-read.
      return getRanking(db, a.projectId)
    },
    // The UI wants the whole refreshed table; an agent that marked ONE paper does
    // not, and on a 3000-work project the unshaped reply is the entire ranking
    // returned for a one-row change. It gets the row it touched plus the true
    // size of the reference set it just altered.
    shape: (result, _ctx, a) => {
      const rows = result as { work_id: number; is_reference?: boolean }[]
      const row = rows.find((r) => r.work_id === a.workId) ?? null
      return {
        paper: row,
        is_reference: a.isReference,
        references_total: rows.filter((r) => r.is_reference).length,
        next_step:
          'Call dossier_build to fold this paper into the dossier; marking alone does not.'
      }
    }
  })
]
