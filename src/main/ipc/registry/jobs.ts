import { z } from 'zod/v4'
import { e, type Entry } from '../types'
import { listJobs, getJobById, setJobDismissed } from '../../db/repositories'
import { getJobQueue } from '../../pipeline/scheduler'
import { resolveRegistry } from '../../pipeline/registry'
import { STAGES } from '../../pipeline/stages'
import { staleWorkList } from '../../pipeline/staleness'
import {
  QUEUE_LIMITS,
  applyQueueSettings,
  readQueueSettings,
  resetQueueSettings,
  writeQueueSettings
} from '../../pipeline/queueSettings'
import {
  MODEL_LIMITS,
  readModelSettings,
  resetModelSettings,
  writeModelSettings
} from '../../llm/modelSettings'
import { getLlmSelection } from '../../llm/current'
import { noteQueueRunStateChanged } from '../../closeGuard'
import { broadcastJobsChanged } from '../../broadcast'
import { CLAMP, cap, capOffset } from '../clamp'
import { listScope } from '../result'
import { redactPath } from '../../mcp/redact'

/**
 * Jobs — the processing queue, which is how every asynchronous operation in this
 * app is followed.
 *
 * PAUSE IS NOT ABORT, and that distinction is stated in every summary that
 * touches it: `stop()` means "claim no new work", so a job already running runs
 * to completion and `inFlight` can stay above zero after a successful pause.
 *
 * `noteQueueRunStateChanged` moves WITH pause and resume. The close prompt
 * captures the queue's run state when it opens and restores it if the user
 * cancels; without this call a pause made while the prompt is open would be
 * undone by the cancel, silently resuming a queue the user just stopped.
 */

const projectId = z.number().int().nonnegative()
const jobId = z.number().int().nonnegative()

/**
 * A job row on its way to an agent.
 *
 * `error` is the stage's raw exception text, and the stages that fail most often
 * are the ones that touch files — extract-text, ocr, optimize all operate on a
 * document's absolute path, so their message names the user's PDF storage
 * layout. That is the standard route by which a "read-only" jobs poll discloses
 * a NAS mount and an account name. The sentence is what diagnoses the failure;
 * the location is not.
 */
const jobOut = (job: unknown): unknown => {
  const j = job as { error: string | null } | null
  if (!j) return j
  return { ...j, error: j.error === null ? null : redactPath(j.error) }
}

/** The v3 handler's closed-over helper, reproduced verbatim. */
const queueState = (): { running: boolean; inFlight: number } => ({
  running: getJobQueue().isRunning(),
  inFlight: getJobQueue().inFlightCount()
})

export const JOB_ENTRIES: Entry[] = [
  e({
    channel: 'jobs:list',
    tool: 'jobs_list',
    access: 'read',
    summary:
      'The processing jobs for a project, newest activity first. THIS IS THE POLLING TOOL: ' +
      'every asynchronous operation (importing a paper, retrieving references, re-running a ' +
      'stage) returns job ids and finishes here — there is no push notification. Jobs with ' +
      'project_id 0 are global and are always included. "status" says where a job is; ' +
      '"outcome" says how a finished one ended, and they are different questions — a job can ' +
      'be done because it succeeded or done because its precondition was absent. Paginated: ' +
      `pass limit and offset (limit defaults to ${CLAMP.limit}); "total" is every job for the ` +
      'project, so compare it with how many items you received.',
    returns: 'JobDTO[]',
    params: z.object({
      projectId,
      limit: z.number().int().min(1).max(1000).nullish(),
      offset: z.number().int().nonnegative().nullish()
    }),
    order: ['projectId'],
    clampArgs: (a) => ({ ...a, limit: cap(a.limit, CLAMP.limit), offset: capOffset(a.offset) }),
    run: (ctx, a) => listJobs(ctx.db, a.projectId),
    shape: (result, _ctx, a) => {
      const rows = result as unknown[]
      const offset = a.offset ?? 0
      const limit = a.limit ?? rows.length
      return listScope(rows.slice(offset, offset + limit).map(jobOut), rows.length, {
        note:
          rows.length === 0
            ? `Project ${a.projectId} has no jobs — nothing has been queued for it, which is not the same as work having failed.`
            : null,
        counts: null,
        limit,
        offset
      })
    }
  }),

  e({
    channel: 'jobs:get',
    tool: 'job_get',
    access: 'read',
    summary:
      'One job by its id, in the same shape jobs_list returns, or null when no job has that ' +
      'id. Not scoped to a project — a job id is already the answer to "which job", and the ' +
      'row names its own project. This is the cheap way to poll a single asynchronous ' +
      'operation you started.',
    returns: 'JobDTO | null',
    params: z.object({ jobId }),
    order: ['jobId'],
    run: (ctx, a) => getJobById(ctx.db, a.jobId),
    shape: (result) => jobOut(result)
  }),

  e({
    channel: 'llm:settings',
    tool: 'model_settings_get',
    access: 'read',
    summary:
      'Which model each kind of work uses, and how much room it is given. TWO ROLES, kept '
      + 'separate on purpose: "extraction" reads every paper and is the volume cost, while '
      + '"review" reads a table a SECOND time to disagree with the first reading — its whole '
      + 'value is that it fails differently, so running it on the extractor\u2019s model would '
      + 'make it confirm rather than check. An empty extractionModel means the gateway chooses, '
      + 'which is what this app has always done. The context window is REPORTED, never enforced: '
      + 'a paper is split across messages rather than trimmed to fit one.',
    returns: 'ModelSettingsDTO',
    params: z.object({}),
    order: [],
    run: (ctx) => readModelSettings(ctx.db)
  }),

  e({
    channel: 'llm:setSettings',
    tool: 'model_settings_set',
    access: 'write',
    summary:
      'Change which model a kind of work uses, or how much room it has. Omit a field to leave '
      + 'it alone. A model named here must be one the gateway serves — model_list reports them '
      + '— and a request it cannot honour is refused by the gateway with an error naming the '
      + 'model rather than silently downgraded. Takes effect on the next stage that runs; work '
      + 'already in flight finishes under the setting it started with.',
    returns: 'ModelSettingsDTO',
    params: z.object({
      extractionModel: z.string().nullish(),
      reviewModel: z.string().nullish(),
      extractionMaxOutput: z.number().int().min(MODEL_LIMITS.maxOutput.min).max(MODEL_LIMITS.maxOutput.max).nullish(),
      reviewMaxOutput: z.number().int().min(MODEL_LIMITS.maxOutput.min).max(MODEL_LIMITS.maxOutput.max).nullish(),
      extractionContext: z.number().int().min(MODEL_LIMITS.context.min).max(MODEL_LIMITS.context.max).nullish(),
      reviewContext: z.number().int().min(MODEL_LIMITS.context.min).max(MODEL_LIMITS.context.max).nullish()
    }),
    // NO `order`. The preload sends ONE object (`invoke('llm:setSettings',
    // next)`), and `order` declares the opposite — that the channel is called
    // positionally — so the handler assigned `args[0]`, the whole settings
    // object, to `extractionModel` and every save failed with "expected string,
    // received object". `order` belongs only to channels the preload spreads.
    run: (ctx, a) =>
      writeModelSettings(ctx.db, {
        extractionModel: a.extractionModel ?? undefined,
        reviewModel: a.reviewModel ?? undefined,
        extractionMaxOutput: a.extractionMaxOutput ?? undefined,
        reviewMaxOutput: a.reviewMaxOutput ?? undefined,
        extractionContext: a.extractionContext ?? undefined,
        reviewContext: a.reviewContext ?? undefined
      })
  }),

  e({
    channel: 'llm:resetSettings',
    tool: 'model_settings_reset',
    access: 'write',
    summary:
      'Forget every model choice, so the app returns to what it ships with. The stored rows are '
      + 'removed rather than rewritten, so a later change to a default reaches this install too.',
    returns: 'ModelSettingsDTO',
    params: z.object({}),
    order: [],
    run: (ctx) => resetModelSettings(ctx.db)
  }),

  e({
    channel: 'llm:models',
    tool: 'model_list',
    access: 'read',
    summary:
      'The models the gateway currently serves. Read from the gateway\u2019s own health report at '
      + 'startup, so it is what this app can actually reach rather than a list someone typed. '
      + 'Empty when no gateway answered, which is the honest answer — not a guess at what might '
      + 'be available.',
    returns: 'string[]',
    params: z.object({}),
    order: [],
    run: () => getLlmSelection()?.health?.models ?? []
  }),

  e({
    channel: 'jobs:settings',
    tool: 'queue_settings_get',
    access: 'read',
    summary:
      'How much work the queue does at once. Two limits, both ABSOLUTE across the whole app '
      + 'rather than per project: "llm" caps the AI steps in flight and "local" caps everything '
      + 'else (reading a PDF, OCR, segmenting, embedding). They are separate because an AI step '
      + 'waits on the gateway and uses no CPU, so counting it against the same allowance as OCR '
      + 'would leave the machine idle while the queue looked full. "is_default" is false once '
      + 'the user has changed either one.',
    returns: 'QueueSettingsDTO',
    params: z.object({}),
    order: [],
    run: (ctx) => readQueueSettings(ctx.db)
  }),

  e({
    channel: 'jobs:setSettings',
    tool: 'queue_settings_set',
    access: 'write',
    summary:
      'Change how much work the queue does at once. Omit a field to leave it alone. Raising '
      + '"llm" costs proportionally more per run and makes a provider rate limit proportionally '
      + 'more likely, which is why it ships at 1. Takes effect on the next scheduling tick — no '
      + 'restart — and never interrupts a step already running: a lowered limit simply stops new '
      + 'work being claimed until the count is back under it.',
    returns: 'QueueSettingsDTO',
    params: z.object({
      llm: z.number().int().min(QUEUE_LIMITS.llm.min).max(QUEUE_LIMITS.llm.max).nullish(),
      local: z.number().int().min(QUEUE_LIMITS.local.min).max(QUEUE_LIMITS.local.max).nullish()
    }),
    order: ['llm', 'local'],
    run: (ctx, a) => {
      writeQueueSettings(ctx.db, {
        llm: a.llm ?? undefined,
        local: a.local ?? undefined
      })
      // The gate holds its capacity in memory, so a stored number nobody
      // applied is a setting the user changed and the app ignored.
      return applyQueueSettings(ctx.db)
    }
  }),

  e({
    channel: 'jobs:resetSettings',
    tool: 'queue_settings_reset',
    access: 'write',
    summary:
      'Forget every queue limit the user chose, so the app returns to the values it ships with. '
      + 'The stored rows are removed rather than rewritten, so a future change to a default '
      + 'reaches this install too.',
    returns: 'QueueSettingsDTO',
    params: z.object({}),
    order: [],
    run: (ctx) => {
      resetQueueSettings(ctx.db)
      return applyQueueSettings(ctx.db)
    }
  }),

  e({
    channel: 'jobs:stages',
    tool: 'stages_list',
    access: 'read',
    summary:
      'The pipeline stages, in the order they actually run, with each stage\u2019s id, version, ' +
      'scope and whether it calls the model. This is the vocabulary for anything that names a ' +
      'stage — read the ids from here rather than guessing them. Stages that use the model ' +
      'are serialized behind one global gate, so such a job can sit queued for a long time ' +
      'with nothing wrong.',
    returns: 'StageDefDTO[]',
    params: z.object({}),
    run: () =>
      // Recomputed per call through the same pure `resolveRegistry` the
      // scheduler uses, so the order reported is the order jobs run in and there
      // is no second ordering to drift.
      resolveRegistry(STAGES).order.map(({ stage, index }) => ({
        id: stage.id,
        label: stage.label,
        version: stage.version,
        index,
        scope: stage.scope,
        uses_llm: stage.usesLlm
      }))
  }),

  e({
    channel: 'jobs:staleWorks',
    tool: 'papers_stale_list',
    access: 'read',
    summary:
      'The papers in a project whose stored results were produced under inputs that have ' +
      'since changed — an extraction schema edited or newly attached, a different model ' +
      'selected, a reference paper added to the project dossier — with the labels of the ' +
      'stages that would re-run. COMPUTED from the same input fingerprint the scheduler ' +
      'consults when it claims a job, never read from a flag, so it cannot disagree with ' +
      'what a re-run would actually do. A paper that is absent is current; a paper that has ' +
      'never been processed is also absent, because results that were never produced cannot ' +
      'have been produced under stale inputs — read jobs_list for those. This re-runs ' +
      'nothing: call paper_reprocess to act on it. Paginated: pass limit and offset (limit ' +
      `defaults to ${CLAMP.limit}); "total" is every stale paper in the project.`,
    returns: 'StaleWorkDTO[]',
    // A real project id. 0 is the "belongs to no project" sentinel, and the
    // schemas and dossier that make a paper stale are project-scoped, so asking
    // about 0 is asking about an interpretation nobody holds.
    //
    // Editing one schema makes EVERY paper that used it stale at once, so this is
    // a whole-corpus list in exactly the situation an agent is most likely to ask
    // for it. Capped on the MCP path only; the renderer still receives all of it.
    params: z.object({
      projectId: z.number().int().min(1),
      limit: z.number().int().min(1).max(1000).nullish(),
      offset: z.number().int().nonnegative().nullish()
    }),
    order: ['projectId'],
    clampArgs: (a) => ({ ...a, limit: cap(a.limit, CLAMP.limit), offset: capOffset(a.offset) }),
    run: (ctx, a) => staleWorkList(ctx.db, resolveRegistry(STAGES), a.projectId),
    shape: (result, _ctx, a) => {
      const rows = result as unknown[]
      const offset = a.offset ?? 0
      const limit = a.limit ?? rows.length
      return listScope(rows.slice(offset, offset + limit), rows.length, {
        note: null,
        counts: null,
        limit,
        offset
      })
    }
  }),

  e({
    channel: 'jobs:retry',
    tool: 'job_retry',
    access: 'write',
    summary:
      'Re-queue one failed job so it runs again, without re-processing the whole paper. This ' +
      'is ASYNCHRONOUS: it returns nothing and the work happens later — poll job_get for the ' +
      'outcome. Retrying a job whose failure was "needs-user-action" or "upstream" will simply ' +
      'fail the same way — read the job\u2019s error_kind first and fix the cause. If this call ' +
      'times out the re-queue is NOT rolled back; read job_get back before retrying, or you ' +
      'will queue the same work twice.',
    returns: 'void',
    params: z.object({ jobId }),
    order: ['jobId'],
    run: (_ctx, a) => {
      getJobQueue().retry(a.jobId)
    }
  }),

  e({
    channel: 'jobs:cancel',
    tool: 'job_cancel',
    access: 'destructive',
    summary:
      'Cancel one job. A job that has not started is dropped; a job already running is fenced ' +
      'off so it cannot commit, and the output of THAT STAGE is deleted. Earlier stages\u2019 ' +
      'output and the paper itself are untouched. Returns nothing; poll job_get for the ' +
      'resulting state. If this call times out the cancel is NOT rolled back — read job_get ' +
      'back rather than assuming it did not happen.',
    returns: 'void',
    params: z.object({ jobId }),
    order: ['jobId'],
    run: (_ctx, a) => {
      getJobQueue().cancel(a.jobId)
    }
  }),

  e({
    channel: 'jobs:state',
    tool: 'queue_state',
    access: 'read',
    summary:
      'Whether the processing queue is claiming work, and how many jobs are in flight right ' +
      'now. "running: false" with "inFlight" above zero is a normal state, not a ' +
      'contradiction: pausing stops new claims and never aborts a job already underway.',
    returns: '{ running: boolean; inFlight: number }',
    params: z.object({}),
    run: () => queueState()
  }),

  e({
    channel: 'jobs:pause',
    tool: 'queue_pause',
    access: 'write',
    summary:
      'Pause the processing queue. Pause means "claim no new work" — a running job is NEVER ' +
      'aborted, so the returned inFlight can stay above 0 after a successful pause, and it ' +
      'will drain on its own. Returns the queue state. Remember to call queue_resume: a queue ' +
      'left paused silently stops everything the human queues afterwards too, and a timed-out ' +
      'call is NOT rolled back — read queue_state back rather than assuming the pause failed.',
    returns: '{ running: boolean; inFlight: number }',
    params: z.object({}),
    run: () => {
      getJobQueue().stop()
      // If the close prompt is open it would otherwise restore the run state it
      // captured when it opened, and resume a queue the user just paused.
      noteQueueRunStateChanged(false)
      return queueState()
    }
  }),

  e({
    channel: 'jobs:resume',
    tool: 'queue_resume',
    access: 'write',
    summary:
      'Resume the processing queue, so it starts claiming pending work again. Returns the ' +
      'queue state. Safe to call when already running, and a timed-out call is NOT rolled ' +
      'back — read queue_state back rather than calling it twice.',
    returns: '{ running: boolean; inFlight: number }',
    params: z.object({}),
    run: () => {
      getJobQueue().start()
      noteQueueRunStateChanged(true)
      return queueState()
    }
  }),

  e({
    channel: 'jobs:setDismissed',
    tool: 'job_dismiss',
    access: 'write',
    summary:
      'Mark a job dismissed (or undismissed), which clears it from the failed count without ' +
      'deleting the record or undoing anything it did. Use it to acknowledge a failure the ' +
      'human has decided not to act on — it is their queue, so do not clear failures they ' +
      'have not seen. Returns the project\u2019s refreshed job list, truncated like jobs_list. ' +
      'If this call times out the flag is NOT rolled back; read it back before retrying.',
    returns: 'JobDTO[]',
    params: z.object({ jobId, dismissed: z.boolean(), projectId }),
    order: ['jobId', 'dismissed', 'projectId'],
    run: (ctx, a) => {
      const rows = setJobDismissed(ctx.db, a.jobId, a.dismissed, a.projectId)
      // `processing_job` has writers outside JobQueue, and this is one: the
      // acting window gets the fresh list as the return value, but any OTHER
      // window would keep showing the old dismissed flag — and therefore a wrong
      // failed-count — until something unrelated moved the queue.
      broadcastJobsChanged()
      return rows
    },
    shape: (result) => {
      const all = result as unknown[]
      // `limit` is passed, not left null: `listScope` renders a null limit as
      // "this list is not paginated", which beside a truncated `items` tells the
      // agent it received all `total` rows when it holds a fraction of them.
      return listScope(all.slice(0, CLAMP.limit).map(jobOut), all.length, {
        limit: CLAMP.limit,
        offset: 0,
        note: null,
        counts: null
      })
    }
  })
]
