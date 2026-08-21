import { z } from 'zod/v4'
import { e, type Entry } from '../types'
import { getJobQueue, type RerunOutcome } from '../../pipeline/scheduler'
import { resolveRegistry } from '../../pipeline/registry'
import { STAGES } from '../../pipeline/stages'
import { broadcastJobsChanged } from '../../broadcast'
import type { DB } from '../../db/connection'
import type { RerunResultDTO, RerunState } from '@shared/contract'

/**
 * Re-running — the two capabilities that DISCARD an existing analysis and
 * schedule it to be produced again.
 *
 * THE FAILURE THIS FILE EXISTS TO PREVENT is a re-run that silently does
 * nothing. Both tools are backed by the planner, and the planner is CACHED:
 * `planPipeline` adopts the jobs a previous plan created, re-arms the finished
 * ones, and the claim then settles each straight back to done without executing
 * its stage, because the input fingerprint is unchanged. An agent that asked for
 * a re-run therefore receives a full, plausible list of job ids, watches them go
 * `queued -> done`, and reports the paper re-analysed when not one model call was
 * made.
 *
 * So a job id list is NOT the answer to "did anything happen", and neither is an
 * empty one. `supersededRunIds` is: it names the runs whose OUTPUT was deleted,
 * which is the only state change that forces the work to be redone. Every result
 * here leads with a `state` discriminator computed from that, and from the true
 * status of the jobs the plan left behind.
 *
 * THE SECOND FAILURE is a re-run that destroys a run it never saw. Neither tool
 * accepts a `stage_run` id: `supersedeCascade` re-resolves by KEY and ignores
 * `superseded`, so an id that was current when an agent read it, and has since
 * been retired, retires whatever holds that key NOW. Ids are resolved inside the
 * scheduler, in the same synchronous call that consumes them.
 */

const workId = z.number().int().positive()

/**
 * The project the caller is ACTING FOR, and never the 0 sentinel.
 *
 * 0 means "belongs to no project" on a stored row, and a work-scoped stage
 * really does store it. But it is not a project one can act on behalf of:
 * planning a project-scoped stage under 0 files it in a different
 * `ux_stage_run_current` slot from its real one, so two runs stay current at
 * once. `minimum: 1` is in the emitted JSON Schema, so an agent is refused
 * before the call rather than after.
 */
const projectId = z.number().int().min(1)

/**
 * The stage names, derived from the registry at module load.
 *
 * Never hardcoded: a newly registered stage would otherwise be invisible to
 * every agent until someone remembered this list. Corpus-scoped stages are
 * EXCLUDED rather than accepted and refused — they are keyed to work 0 and
 * belong to no paper, `planPipeline` skips them entirely, so "re-run this
 * paper's `resolve-references`" is a request with no referent. Excluding them
 * from the enum makes that a schema error the agent sees before it calls.
 */
const RERUNNABLE_STAGES = resolveRegistry(STAGES)
  .order.filter(({ stage }) => stage.scope !== 'corpus')
  .map(({ stage }) => stage.id)

const stageName = z.enum(RERUNNABLE_STAGES as [string, ...string[]])

/**
 * The jobs of this pipeline that still have somewhere to get to.
 *
 * `review` is INCLUDED even though the queue treats it as terminal: a job filed
 * for review has stopped because it made a claim a human should check, and an
 * agent given no id for it cannot tell that from having finished. It would poll
 * an empty list and report the paper done.
 */
function pendingJobIds(db: DB, jobIds: number[]): number[] {
  if (jobIds.length === 0) return []
  const holes = jobIds.map(() => '?').join(',')
  return (
    db
      .prepare(
        `SELECT id FROM processing_job
          WHERE id IN (${holes}) AND status NOT IN ('done','failed','cancelled')
          ORDER BY id ASC`
      )
      .all(...jobIds) as Array<{ id: number }>
  ).map((r) => r.id)
}

function workExists(db: DB, id: number): boolean {
  return db.prepare('SELECT 1 FROM work WHERE id = ?').get(id) !== undefined
}

function projectExists(db: DB, id: number): boolean {
  return db.prepare('SELECT 1 FROM project WHERE id = ?').get(id) !== undefined
}

function inProject(db: DB, work: number, project: number): boolean {
  return (
    db
      .prepare('SELECT 1 FROM project_work WHERE work_id = ? AND project_id = ?')
      .get(work, project) !== undefined
  )
}

/**
 * Turn a scheduler outcome into the discriminated answer an agent reads.
 *
 * THE ORDER OF THESE TESTS IS THE WHOLE CONTENT OF THE FUNCTION, and the
 * ordering that reads most naturally is wrong. "Are there jobs outstanding?"
 * looks like the obvious first question and is the trap: a re-plan of a
 * fully-current paper RE-ARMS every finished job back to `queued`, so the
 * outstanding-jobs test is true precisely in the case where nothing will run,
 * and putting it first tells the agent to poll jobs that will settle straight
 * back to done without a single model call. So the discard test comes first,
 * then the two "nothing could have happened" tests, and the queue-shaped tests
 * last, where they only ever describe work that is real.
 *
 * `queued-but-paused` outranks the plain pending state for a different reason:
 * an agent handed only `queue_running: false` will poll a job that cannot move
 * until `queue_resume` is called. A boolean is not an instruction.
 */
function describe(
  db: DB,
  out: RerunOutcome,
  ctx: { what: string; wholePaper: boolean; forced: boolean }
): RerunResultDTO {
  const pending = pendingJobIds(db, [...new Set([...out.allJobIds, ...out.requeuedJobIds])])
  const discarded = out.supersededRunIds.length
  const stale = out.staleRunIds.length
  const created = out.createdJobIds.length
  // Jobs this call did NOT create. Only these were "already outstanding" — a job
  // this call inserted was not adopted from anywhere.
  const adoptedPending = pending.filter((id) => !out.createdJobIds.includes(id))
  // Work that is definitely going to execute, whatever the cache decides:
  // a requeued job had its output deleted or was cancelled by an upstream
  // failure, so there is nothing left for its fingerprint to match.
  const willRun = out.requeuedJobIds.length

  const paused = out.queueRunning
    ? ''
    : ' THE QUEUE IS PAUSED, so none of these jobs will start: call queue_resume, then poll ' +
      'job_get.'
  const partial =
    stale > 0 && discarded > 0
      ? ` ${stale} further run(s) were NOT re-run: something else retired them between ` +
        'resolving them and using them, and following a retired id would have destroyed ' +
        'whichever run now holds its place. This re-run is therefore PARTIAL; call again to ' +
        'cover them.'
      : ''

  let state: RerunState
  let note: string

  if (discarded > 0) {
    state = out.queueRunning ? 'rerunning' : 'queued-but-paused'
    note =
      `Discarded ${discarded} stage run(s) for ${ctx.what} and re-planned project(s) ` +
      `${out.plannedProjectIds.join(', ')}.` +
      (out.requeuedJobIds.length > 0
        ? ` ${out.requeuedJobIds.length} job(s) that were mid-execution, blocked on one, or ` +
          'previously failed were put back on the queue.'
        : '') +
      partial +
      (out.queueRunning ? ' Poll job_get on pending_job_ids for the outcome.' : paused)
  } else if (stale > 0) {
    // Its own state, not `already-current`: this is a lost race and the remedy
    // is to call again, which is the opposite of what "everything is up to
    // date" would tell an agent to do.
    state = 'no-current-runs'
    note =
      `Nothing was re-run for ${ctx.what}: all ${stale} run(s) resolved had already been ` +
      'retired by something else — another client, the app window, or the pipeline itself — ' +
      'between resolving them and using them. They were NOT followed, because that would ' +
      'have destroyed whichever run now holds their place. Call again if it still looks stale.'
  } else if (out.hadOrigins === false) {
    state = 'no-current-runs'
    note = ctx.wholePaper
      ? `Nothing was discarded: ${ctx.what} has no current stage run at all, so there was ` +
        'nothing to throw away. ' +
        (created > 0
          ? `Its pipeline was planned instead and ${created} job(s) were created, so this is ` +
            'a FIRST run rather than a re-run. Poll job_get on pending_job_ids.'
          : 'Its pipeline was planned and every job it needs already existed; if ' +
            'pending_job_ids is not empty the paper is being processed right now, so poll ' +
            'job_get rather than calling again.') +
        paused
      : `Nothing was re-run: ${ctx.what} has no current stage run. Either that stage never ` +
        'ran for this paper, or its run was already superseded by a later one. To run the ' +
        'paper from the start, use paper_reprocess; stages_list names the stages that exist.'
  } else if (willRun > 0) {
    // Requeued jobs are the one case where "nothing was discarded" still means
    // real work: their output is gone, or they were cancelled by an upstream
    // failure that has now been redone, so no fingerprint can match and they
    // WILL execute. Tested before the un-forced branch, which would otherwise
    // tell the agent to force — and force would discard the replacement.
    state = out.queueRunning ? 'rerunning' : 'queued-but-paused'
    note =
      `Nothing was discarded, but ${willRun} job(s) for ${ctx.what} were put back on the ` +
      'queue and will execute.' +
      (out.queueRunning ? ' Poll job_get on pending_job_ids.' : paused)
  } else if (created > 0) {
    // CREATED IS NOT THE SAME AS "WILL RUN", and the note must not say it is: a
    // job is created whenever a (project, document) pipeline has no row for a
    // stage yet, which happens when a paper already processed under one project
    // is added to a second. The work-scoped stages then have brand-new jobs
    // whose stage runs are still current, and every one settles back to done
    // without executing.
    state = out.queueRunning ? 'already-queued' : 'queued-but-paused'
    note =
      `Nothing was discarded, and ${created} job(s) were created for ${ctx.what} to cover ` +
      'stages this pipeline had no job for yet. Whether each one EXECUTES is decided when it ' +
      'is claimed, from whether its inputs changed \u2014 a stage that is still current ' +
      'settles back to done without calling the model. Poll job_get on pending_job_ids, and ' +
      'pass force true if you need the analysis produced again regardless.' +
      paused
  } else if (!ctx.forced) {
    // BEFORE the adopted-pending test, and this is the ordering that matters. A
    // re-planned current pipeline has its finished jobs re-armed to `queued`,
    // so it looks outstanding while it will execute nothing at all.
    state = 'already-current'
    note =
      `PROBABLY NOTHING WILL BE RE-RUN. Nothing was discarded, and the pipeline for ` +
      `${ctx.what} was re-planned against the cache: each job decides at claim time whether ` +
      'its inputs changed, and every stage that is still current settles back to done ' +
      'without the model being called. Any job ids here may therefore complete without ' +
      'having re-analysed anything. Call again with force true to discard the existing ' +
      'analysis and produce it again unconditionally.'
  } else if (adoptedPending.length > 0) {
    state = out.queueRunning ? 'already-queued' : 'queued-but-paused'
    note =
      `Nothing was discarded — ${adoptedPending.length} job(s) for ${ctx.what} were already ` +
      'outstanding and this call adopted them rather than duplicating them.' +
      (out.queueRunning ? ' Poll job_get on pending_job_ids.' : paused)
  } else {
    state = 'already-current'
    note =
      `Nothing was re-run and nothing is outstanding for ${ctx.what}: its pipeline was ` +
      're-planned and every stage it needs is already current against its inputs.'
  }

  return {
    state,
    note,
    superseded_run_ids: out.supersededRunIds,
    stale_run_ids: out.staleRunIds,
    created_job_ids: out.createdJobIds,
    requeued_job_ids: out.requeuedJobIds,
    pending_job_ids: pending,
    all_job_ids: out.allJobIds,
    planned_project_ids: out.plannedProjectIds,
    queue_running: out.queueRunning
  }
}

/** A refusal that is an ANSWER, not an error: the paper is real, the pairing is not. */
function notInProject(work: number, project: number): RerunResultDTO {
  return {
    state: 'not-in-project',
    note:
      `Nothing was re-run: paper ${work} is not in project ${project}. A paper is ` +
      'interpreted per project, so re-running it on behalf of a project it does not belong ' +
      'to would file the result under a question nobody asked. Call project_papers_list for ' +
      'the papers this project holds.',
    superseded_run_ids: [],
    stale_run_ids: [],
    created_job_ids: [],
    requeued_job_ids: [],
    pending_job_ids: [],
    all_job_ids: [],
    planned_project_ids: [],
    queue_running: getJobQueue().isRunning()
  }
}

/**
 * The paragraph both tools end their description with.
 *
 * Every clause here is a rule that is enforced but cannot be expressed in JSON
 * Schema, so an agent that reads only the schema would never learn it.
 */
const SHARED_WARNING =
  'WHEN IT DISCARDS ANYTHING IT DISCARDS IT FOR GOOD: the superseded runs\u2019 extracted paragraphs, ' +
  'citation contexts and embeddings are DELETED and their facts marked superseded. They are ' +
  'not archived and there is no undo — the only way back is to let the pipeline produce them ' +
  'again. It also cascades DOWNSTREAM AND ACROSS PROJECTS: any other project that consumed ' +
  'the same output has its work invalidated and re-planned too, and planned_project_ids says ' +
  'which. ASYNCHRONOUS: it returns job ids, not results; poll job_get. The write is NOT ' +
  'rolled back if this call times out or the connection drops \u2014 read the state back with ' +
  'jobs_list rather than retrying, because a retry would discard the replacement too.'

export const RERUN_ENTRIES: Entry[] = [
  e({
    channel: 'jobs:reprocessWork',
    tool: 'paper_reprocess',
    access: 'destructive',
    slow: true,
    summary:
      'Re-run ONE paper through its WHOLE processing pipeline \u2014 every stage stages_list ' +
      'reports, from fetching the file through text extraction and segmentation to extraction ' +
      'against each attached schema. ' +
      'READ "state" FIRST, NOT THE JOB IDS. With force false (the default) this plans against ' +
      'the stage cache: every stage whose inputs are unchanged is settled straight back to ' +
      'done WITHOUT running, so you get a full list of job ids and nothing is actually ' +
      're-analysed — that is state "already-current", and the way to get a re-run you can ' +
      'rely on is to call again with force true. force true discards the paper\u2019s current stage runs ' +
      'first, so there is no cache left to hit; superseded_run_ids then names exactly what ' +
      'was thrown away, and an empty superseded_run_ids always means nothing was. projectId ' +
      'is the project you are acting for and must be a real project id: 0 is the sentinel for ' +
      '"belongs to no project" and is not something a re-run can be performed on behalf of. ' +
      'NOTE THAT force true IS PAPER-WIDE, NOT PROJECT-WIDE: it discards every current run of ' +
      'this paper, including analyses another project made of it that your project never ' +
      'touched. They are re-planned, so nothing is lost permanently, but that project pays ' +
      'for the re-analysis. Use paper_stage_rerun when only one step is wrong. ' +
      SHARED_WARNING,
    returns: 'RerunResultDTO',
    params: z.object({
      workId,
      projectId,
      // `.nullish()`, not `.optional()`: this channel is positional, and the
      // registry loop turns an absent positional argument into a PRESENT
      // `undefined` property while the renderer may legitimately pass `null`.
      force: z.boolean().nullish()
    }),
    order: ['workId', 'projectId', 'force'],
    run: (ctx, a) => {
      if (!workExists(ctx.db, a.workId)) {
        throw new Error(`no paper has id ${a.workId}; call papers_search or project_papers_list`)
      }
      if (!projectExists(ctx.db, a.projectId)) {
        throw new Error(`no project has id ${a.projectId}; call projects_list for the ids that exist`)
      }
      if (!inProject(ctx.db, a.workId, a.projectId)) return notInProject(a.workId, a.projectId)

      const force = a.force === true
      const out = getJobQueue().reprocessWork(a.workId, a.projectId, { force })
      // `processing_job` moved, and every open window shows a job count derived
      // from it. Without this only the window that acted would see the change —
      // and over MCP there is no acting window at all, so no window would.
      broadcastJobsChanged()
      return describe(ctx.db, out, { what: `paper ${a.workId}`, wholePaper: true, forced: force })
    }
  }),

  e({
    channel: 'jobs:rerunStages',
    tool: 'paper_stages_rerun',
    access: 'destructive',
    slow: true,
    summary:
      'Re-run SEVERAL named stages of one paper in a single transaction, discarding what each ' +
      'produced. This is what papers_stale_list is for: it reports the stages whose inputs ' +
      'changed, and this re-runs exactly those. Prefer it to paper_reprocess with force, which ' +
      'discards EVERY current run of the paper — including fetching the file and reading its ' +
      'text again — when only a later stage went stale. The cascade still reaches everything ' +
      'genuinely downstream of the stages named, so nothing is left half-updated. Each stage ' +
      'fans out where the pipeline does. One call rather than several: two calls let something ' +
      'else re-resolve a key in between, and the second would destroy what the first created. ' +
      SHARED_WARNING,
    returns: 'RerunResultDTO',
    params: z.object({ workId, stages: z.array(stageName).min(1), projectId }),
    order: ['workId', 'stages', 'projectId'],
    run: (ctx, a) => {
      if (!workExists(ctx.db, a.workId)) {
        throw new Error(`no paper has id ${a.workId}; call papers_search or project_papers_list`)
      }
      if (!projectExists(ctx.db, a.projectId)) {
        throw new Error(`no project has id ${a.projectId}; call projects_list for the ids that exist`)
      }
      if (!inProject(ctx.db, a.workId, a.projectId)) return notInProject(a.workId, a.projectId)

      const out = getJobQueue().forceRerunStages(a.workId, a.stages, a.projectId)
      broadcastJobsChanged()
      return describe(ctx.db, out, {
        what: `${a.stages.length} stage(s) of paper ${a.workId}`,
        wholePaper: false,
        forced: true
      })
    }
  }),

  e({
    channel: 'jobs:rerunStage',
    tool: 'paper_stage_rerun',
    access: 'destructive',
    slow: true,
    summary:
      'Re-run ONE named pipeline stage for one paper, discarding what it produced. Use this ' +
      'when a specific step is wrong — a bad text extraction, a schema extraction to redo ' +
      'against the paper\u2019s full text — rather than reprocessing the whole paper. Call ' +
      'stages_list for the stage ids. The named stage FANS OUT where the pipeline does: ' +
      '"schema-extract" has one run per attached extraction schema and ALL of them are ' +
      're-run, because re-running one and leaving the rest stale would report success over a ' +
      'half-updated paper. Stages that run over the whole corpus rather than a paper are not ' +
      'accepted here; they belong to no paper. READ "state": ' +
      '"rerunning" means output was discarded and will be produced again, ' +
      '"no-current-runs" means the stage has no current run for this paper so nothing ' +
      'happened, and "already-queued" means the work was outstanding already. projectId is ' +
      'the project you are acting for and must be a real project id, because the ' +
      'invalidation is re-planned per project and the caller must say which one it is acting ' +
      'for; work-scoped stages store the 0 sentinel and are still matched. ' +
      SHARED_WARNING,
    returns: 'RerunResultDTO',
    params: z.object({ workId, stage: stageName, projectId }),
    order: ['workId', 'stage', 'projectId'],
    run: (ctx, a) => {
      if (!workExists(ctx.db, a.workId)) {
        throw new Error(`no paper has id ${a.workId}; call papers_search or project_papers_list`)
      }
      if (!projectExists(ctx.db, a.projectId)) {
        throw new Error(`no project has id ${a.projectId}; call projects_list for the ids that exist`)
      }
      if (!inProject(ctx.db, a.workId, a.projectId)) return notInProject(a.workId, a.projectId)

      const out = getJobQueue().forceRerunStage(a.workId, a.stage, a.projectId)
      broadcastJobsChanged()
      return describe(ctx.db, out, {
        what: `stage '${a.stage}' of paper ${a.workId}`,
        wholePaper: false,
        forced: true
      })
    }
  })
]
