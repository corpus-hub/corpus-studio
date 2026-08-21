import { z } from 'zod/v4'
import type { WorkSummaryDTO } from '../../../shared/contract'
import { e, type Entry } from '../types'
import {
  getWorkSummary,
  getWorksWithSummaries,
  getDossier,
  getDossierPage,
  getDossierStatus,
  getDossierBriefing,
  listProjectWorks
} from '../../db/repositories'
import { generateSummary, isNoSourceText, isNoDossier } from '../../llm/summary'
import { buildDossier } from '../../llm/dossier'
import { getLlmProvider } from '../../llm/current'
import { getJobQueue } from '../../pipeline/scheduler'
import { trackBusy } from '../../busy'
import { broadcastSummariesChanged } from '../../broadcast'
import { cap, capOffset, CLAMP } from '../clamp'
import { listScope } from '../result'
import { dossierPayload, withProjectContext } from '../projectContext'

/**
 * Summaries and the topic dossier.
 *
 * THE ONTOLOGY IS THE POINT HERE. A GENERAL summary is the paper's own account
 * of itself and is stored at `project_id = 0`, the global sentinel, where every
 * project reads it. A PROJECT summary is one project's reading of the paper,
 * stored under that project's real id, and is never served to another. Passing
 * `kind: 'project'` with `projectId: 0` would store a project's framing as
 * though it were the paper's own claim, so it is REFUSED at the boundary rather
 * than corrected — there is no way to guess which project was meant.
 *
 * `.refine()` IS SILENTLY DROPPED by `z.toJSONSchema`, so an agent never sees
 * that rule in the schema. It is therefore stated in words in both summaries
 * below; without that an agent retries the same invalid call forever.
 *
 * v3 -> zod/v4 re-authoring: `summaryArgs` was
 * `{ workId: idSchema, projectId: idSchema, kind: z.enum(['general','project']) }`
 * with the refine `kind === 'general' || projectId > 0`. Reproduced field for
 * field; `idSchema` is `z.number().int().nonnegative()`.
 */

const nowIso = (): string => new Date().toISOString()

const projectId = z.number().int().nonnegative()

const summaryArgs = z
  .object({
    workId: z.number().int().nonnegative(),
    projectId,
    kind: z.enum(['general', 'project'])
  })
  .refine((v) => v.kind === 'general' || v.projectId > 0, {
    message: 'a project summary needs a real project id; 0 is the global sentinel',
    path: ['projectId']
  })

const page = {
  limit: z.number().int().min(1).nullish(),
  offset: z.number().int().min(0).nullish()
}

export const SUMMARY_ENTRIES: Entry[] = [
  e({
    channel: 'summary:get',
    tool: 'paper_summary_get',
    access: 'read',
    summary:
      'Read a paper\u2019s stored prose summary. TWO DIFFERENT THINGS LIVE BEHIND THIS ONE ' +
      'TOOL and you must choose: kind "general" is the paper\u2019s own account of itself, ' +
      'shared by every project (pass projectId 0); kind "project" is ONE project\u2019s reading ' +
      'of the paper in light of its own question, and REQUIRES a real projectId greater than 0 ' +
      '\u2014 kind "project" with projectId 0 is refused, because a project\u2019s framing must ' +
      'never be served to other projects as the paper\u2019s own claim. Never quote a project ' +
      'summary as what the paper says. `state` tells you what you got: "ready" (there is prose), ' +
      '"missing" (nothing written yet \u2014 call paper_summary_generate), "failed", "no-source" ' +
      '(the paper has no readable text) or "no-dossier" (a project summary needs a built ' +
      'dossier first). `run` carries the model, prompt version and timestamp behind the prose.',
    returns: 'WorkSummaryDTO  (MCP: plus project_context when the project has background)',
    params: summaryArgs,
    run: (ctx, a) => getWorkSummary(ctx.db, a.workId, a.projectId, a.kind),
    // A `projectId` of 0 is the GLOBAL sentinel and names no project, so it has
    // no reference papers and no background; `projectContextFor` refuses it, and
    // a general summary correctly carries nothing.
    shape: (result, ctx, a) => withProjectContext(result, ctx, a.projectId, a.workId)
  }),

  e({
    channel: 'summary:have',
    tool: 'papers_with_summaries_list',
    access: 'read',
    summary:
      'Which papers in a project already have a summary, as two lists of work ids: `general` ' +
      '(the paper\u2019s own summary, shared across projects) and `project` (this project\u2019s ' +
      'own reading). Cheap \u2014 use it instead of calling paper_summary_get once per paper.',
    returns: '{ general: number[]; project: number[] }',
    params: z.object({ projectId }),
    order: ['projectId'],
    run: (ctx, a) => getWorksWithSummaries(ctx.db, a.projectId)
  }),

  e({
    channel: 'summary:generate',
    tool: 'paper_summary_generate',
    access: 'write',
    slow: true,
    summary:
      'Write a paper\u2019s summary with the model, and store it with full provenance. ' +
      'SYNCHRONOUS: it returns when the summary is finished and there is NO job to poll. ' +
      'kind "general" summarises the paper on its own terms and is stored globally ' +
      '(projectId 0); kind "project" summarises it against one project\u2019s question, ' +
      'REQUIRES a real projectId greater than 0, and REQUIRES that project\u2019s topic dossier ' +
      'to have been built first \u2014 without one it returns state "no-dossier", which is an ' +
      'answer and not a failure: call dossier_build and try again. A paper with no readable ' +
      'text returns state "no-source"; ingest its PDF or add an abstract. This SUPERSEDES the ' +
      'previous current summary of the same kind and inserts the new one in a single ' +
      'transaction, so there is never more than one current summary per paper per project. If ' +
      'this call times out or your connection drops the write is NOT rolled back and may still ' +
      'be running \u2014 read the state back with paper_summary_get before retrying.',
    returns: 'WorkSummaryDTO',
    params: summaryArgs,
    run: async (ctx, a) => {
      const db = ctx.db
      try {
        // Counted as busy: this drives a model OUTSIDE the job queue, so the
        // close guard would otherwise see an idle queue and wave the user
        // through a quit that discards the summary they are watching be written.
        // Attributed to the WINDOW that asked (null over MCP, which has none), so
        // closing that one window of several still prompts about its own work.
        await trackBusy(
          () => generateSummary(db, getLlmProvider(), a, nowIso()),
          ctx.sender?.id ?? null
        )
      } catch (err) {
        // The two REFUSALS come back as states, not as thrown errors. An Error
        // crossing IPC arrives in the renderer as a mangled string that cannot
        // be branched on, and these two send the user to opposite ends of the
        // app — ingest a PDF, versus build the topic dossier. Everything else
        // (an LLM outage above all) still throws: those are genuine faults, not
        // answers.
        if (isNoSourceText(err) || isNoDossier(err)) {
          return {
            kind: a.kind,
            work_id: a.workId,
            project_id: a.kind === 'general' ? 0 : a.projectId,
            body: null,
            state: isNoDossier(err) ? 'no-dossier' : 'no-source',
            source_scope: null,
            run: null
          } satisfies WorkSummaryDTO
        }
        throw err
      }
      // Re-read rather than mapping the runner's return value: the DTO the
      // caller gets is then the SAME shape `summary:get` serves, assembled by
      // one function. A hand-built reply here would be a second definition of
      // the same object, free to drift from it.
      const written = getWorkSummary(db, a.workId, a.projectId, a.kind)
      // Announced only once prose actually EXISTS. A run that produced nothing
      // changed no summary, and telling every screen to refetch after it would
      // spend a round trip per surface to redisplay what they already show.
      if (written.state === 'ready') broadcastSummariesChanged()
      return written
    }
  }),

  e({
    channel: 'dossier:get',
    tool: 'dossier_get',
    access: 'read',
    summary:
      'The claims in a project\u2019s topic dossier \u2014 what its reference papers assert, ' +
      'each with the paper it came from and the quote backing it. `is_contrary: true` marks ' +
      'material that DISAGREES with the rest and exists specifically to stop a reader anchoring ' +
      'on one view: never drop or downweight those when summarising. `analysis_type` of ' +
      '"dossier" means the claim came from a dossier BUILD; any other value means it is a ' +
      'by-product of extracting that one paper. `evidence_verbatim: false` means the model ' +
      'asserted that wording and it could NOT be found in the document \u2014 do not quote it as ' +
      'something the paper says. Paginated; read `total`.',
    returns: 'DossierEntryDTO[]  (MCP: run yields { items, total }, shaped to a ListScope)',
    params: z.object({ projectId, ...page }),
    order: ['projectId'],
    // Paged IN SQL, and the page and its true `total` come from ONE resolution of
    // the dossier's source-work set — that set is itself a query, so reading the
    // two separately runs it twice on the main thread. The
    // renderer passes neither argument and still gets the whole dossier, as the
    // ARRAY the contract declares — the pairing is an MCP-side shape only.
    run: (ctx, a) => {
      const window =
        a.limit === null || a.limit === undefined
          ? {}
          : { limit: a.limit, offset: a.offset ?? 0 }
      if (ctx.source === 'ipc') return getDossier(ctx.db, a.projectId, window)
      return getDossierPage(ctx.db, a.projectId, window)
    },
    clampArgs: (a) => ({
      ...a,
      limit: cap(a.limit, CLAMP.limit),
      offset: capOffset(a.offset)
    }),
    shape: (result, _ctx, a) => {
      const paged = result as { items: unknown[]; total: number }
      const offset = a.offset ?? 0
      const limit = a.limit ?? null
      return listScope(paged.items, paged.total, {
        note:
          paged.total === 0
            ? 'This project has no dossier claims yet. Mark reference papers with ' +
              'dossier_add_paper, then call dossier_build.'
            : paged.items.length === 0
              ? `This dossier holds ${paged.total} claim(s); offset ${offset} is past the last of them.`
              : null,
        counts: null,
        limit,
        offset
      })
    }
  }),

  e({
    channel: 'dossier:context',
    tool: 'dossier_context_get',
    access: 'read',
    summary:
      'THE BACKGROUND ITSELF, on demand: the slice of a project\u2019s topic dossier that is ' +
      'relevant to ONE paper \u2014 the same material the app\u2019s own analyses of that paper ' +
      'were given. CALL THIS whenever a read handed you a project_context saying ' +
      '"already_sent" whose dossier_hash you cannot actually find earlier in your context: a ' +
      'new conversation, a compacted history or an inherited summary all leave you without it, ' +
      'and answering from background you cannot see is guessing. Idempotent, read-only and ' +
      'always safe to call. Returns state "none" when the project has no reference papers to ' +
      'draw background from \u2014 an answer, not a failure. projectId 0 is the GLOBAL sentinel ' +
      'and names no project, so it has no dossier. This is BACKGROUND: never let it override a ' +
      'value the paper itself reports, and never quote it as something that paper says.',
    returns: 'DossierContextDTO { state, dossier_hash, note, entries[] }',
    params: z.object({ projectId, workId: z.number().int().nonnegative() }),
    order: ['projectId', 'workId'],
    // Reads the DB directly and unconditionally. It NEVER consults or updates the
    // per-connection send state: this is the recovery path an agent is told to
    // take when it cannot find what it was told it has, so a "you already have
    // this" from here would be a dead end with nowhere left to go.
    run: (ctx, a) => {
      const payload = dossierPayload(ctx.db, a.projectId, a.workId)
      if (!payload) {
        return {
          state: 'none' as const,
          dossier_hash: null,
          note: null,
          entries: []
        }
      }
      return { state: 'ready' as const, ...payload }
    }
  }),

  e({
    channel: 'dossier:status',
    tool: 'dossier_status_get',
    access: 'read',
    summary:
      'The state of a project\u2019s topic dossier. READ `references` AND `sources` AS TWO ' +
      'DIFFERENT THINGS: `references` are the papers MARKED as sources of the dossier, and ' +
      '`sources` are the papers the current build actually read. A paper you just marked with ' +
      'dossier_add_paper appears in the first and NOT the second until you call dossier_build ' +
      '\u2014 that gap is the expected state, not a failure. `stale` lists papers whose ' +
      'analyses have changed since the build, and `built_at`/`built_model`/' +
      '`built_prompt_version` say what produced the current one. A project with NO reference ' +
      'paper marked has an EMPTY dossier and supplies no background to any analysis: nothing ' +
      'is substituted for it, so emptiness is a fact about the project rather than a gap to ' +
      'work around. (`fallback` is always false; it is kept only for compatibility.)',
    returns: 'DossierStatusDTO',
    params: z.object({ projectId }),
    order: ['projectId'],
    run: (ctx, a) => getDossierStatus(ctx.db, a.projectId)
  }),

  e({
    channel: 'dossier:briefing',
    tool: 'dossier_briefing_get',
    access: 'read',
    summary:
      'THE BRIEFING: what a model is told about this project before it reads any single paper. ' +
      'Four parts the project already holds \u2014 `about` (the project\u2019s own statement of ' +
      'what it is for), `terms` (the definitions written on its attached extraction schemas), ' +
      '`papers` (every paper with its role and how much text it has), `contributions` (the ' +
      'opening paragraph of each paper\u2019s project-scoped summary) \u2014 plus `sizes`, the ' +
      'characters each part costs. THIS IS NOT A LIST OF EXTRACTED VALUES: a measurement is ' +
      'quoted to you when you read the paper that reported it, and is not background. ' +
      '`sizes.compiled` is 0 until dossier_build has run, and a 0 there means the one part ' +
      'that reads the chosen papers TOGETHER does not exist yet.',
    returns: 'DossierBriefingDTO',
    params: z.object({ projectId }),
    order: ['projectId'],
    run: (ctx, a) => getDossierBriefing(ctx.db, a.projectId)
  }),

  e({
    channel: 'dossier:build',
    tool: 'dossier_build',
    access: 'write',
    slow: true,
    summary:
      'Build (or rebuild) a project\u2019s topic dossier from the papers marked as its ' +
      'reference papers, and return the refreshed status. Mark papers with dossier_add_paper ' +
      'FIRST \u2014 with none marked this fails with a message saying so. SYNCHRONOUS and slow: ' +
      'it calls the model once per reference paper, serialized, so ten reference papers can run ' +
      'for many minutes and there is NO job to poll. If the call times out the build may STILL ' +
      'BE RUNNING \u2014 read dossier_status_get rather than retrying, because a second build ' +
      'started on top of a running one can supersede its results. Each paper\u2019s claims are ' +
      'stored under this project\u2019s id, never globally. A project summary ' +
      '(paper_summary_generate with kind "project") requires this to have run.',
    returns: 'DossierStatusDTO',
    params: z.object({ projectId }),
    order: ['projectId'],
    run: async (ctx, a) => {
      // Counted as busy so the close guard prompts rather than discarding a
      // build the user is watching.
      const { status } = await trackBusy(
        () => buildDossier(ctx.db, getLlmProvider(), a.projectId, nowIso()),
        ctx.sender?.id ?? null
      )
      // A REBUILT DOSSIER DOES NOT MOVE A SINGLE SCORE, and nothing is asked to
      // re-rank here. Relevance is a paper's fit against the PROJECT
      // DESCRIPTION, which `buildDossier` never reads and never writes — the
      // two have separate freshnesses on purpose. What does move a score is an
      // edited description, a paper joining or leaving, or a bibliography
      // growing, and the `rerank` stage's own fingerprint covers all three, so
      // the scheduler re-runs it without being told. Re-ranking from here would
      // spend a model pass per paper to arrive at the numbers already stored.
      //
      // AND IT UNBLOCKS EVERY PROJECT SUMMARY THAT REFUSED FOR WANT OF IT.
      //
      // A project summary reads a paper AGAINST the project context. With no
      // context there is nothing to read against, so `summarise` declines that
      // slot with `not-needed` and its own sentence — correct, and deliberately
      // not a failure. But `not-needed` is TERMINAL: the job is settled, so
      // building the context afterwards re-armed nothing and the refusal stood
      // for good. A paper imported before the build had no project summary and
      // never would, while one imported after had a real one, and nothing on
      // screen explained the difference.
      //
      // This is not hypothetical: it is exactly what the setup questionnaire
      // produces. Papers are added first and the context is built at the end,
      // so on a fresh project EVERY paper hits the refusal and only a later
      // rebuild would have fixed them.
      //
      // `forceRerunStage` is the existing "this stage's inputs changed" path
      // and is idempotent per paper. Failures are swallowed: the build itself
      // succeeded, the status has already been read, and a paper whose summary
      // cannot be re-planned is a queue problem the Papers screen shows.
      for (const w of listProjectWorks(ctx.db, a.projectId)) {
        try {
          getJobQueue().forceRerunStage(w.work.id, 'summarise', a.projectId)
        } catch {
          /* see above */
        }
      }
      return status
    }
  })
]
