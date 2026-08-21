// The scheduler: claim, dispatch, and the job/stage state machine.
//
// ONE claimer for the whole `processing_job` table. Every job is a STAGE job:
// it names a registered StageDefinition and is recorded in `stage_run`. Two
// claimers on one table would each believe they held the row they claimed.

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { DB } from '../db/connection'
import {
  addDevLogScope,
  bindDevLogScope,
  isDevLogEnabled,
  logStageEnd,
  logStageFault,
  logStageStart,
  withDevLogScope
} from '../devlog'
import { isLlmUnavailable, UnavailableLlmProvider, type LlmProvider } from '../llm/provider'
import { readQueueSettings } from './queueSettings'
import { readModelSettings } from '../llm/modelSettings'
import { readZoteroConnection } from '../outlets/settings'
import { resolvePdfPath } from '../db/repositories'
import { runPipeline } from '../llm/pipeline'
import { generateSummary } from '../llm/summary'
import { loadCorpusWorks } from '../citations/store'
import { loadCitationCandidates } from '../citations/verifyStore'
import { loadPendingReviews } from '../llm/review'
import { contactEmail } from '../references/external/contact'
import { abstractByAskKey } from '../references/store'
import { projectQuestion, scoringSets } from '../rerank/store'
import { resolveInput, writeArtifact } from './artifacts'
import { planPipeline, planCorpusSweeps, onboardingStages } from './planner'
import { logRearm, summarize } from './rearmLog'
import { currentStageRunIds } from '../db/repos/stageRuns'
import { resolveRegistry, type ResolvedRegistry } from './registry'
import { STAGES } from './stages'
import { DEFAULT_CANCEL_GRACE_MS } from './host/pool'
import type { HostPool } from './host/pool'
import {
  beginRun,
  currentRun,
  decideCache,
  deleteRunOutput,
  finishRun,
  keyOf,
  supersedeCascade
} from './stageRun'
import { inputsOf } from './types'
import { plainText } from '../../shared/markup'
import type {
  BibliographicRecord,
  Capability,
  FanOutKey,
  SemanticHandle,
  StageContext,
  StageOutcome,
  StagePlanContext
} from './types'

interface JobRow {
  id: number
  job_type: string
  stage: string | null
  status: string
  work_id: number | null
  document_id: number | null
  project_id: number
  schema_id: number
  fanout_key: string
  payload: string | null
  attempts: number
  lease_epoch: number
  cancel_requested: number
}

/**
 * Retry ceiling. Overrides a stage's `retryable: true` UNCONDITIONALLY, so a
 * stage author cannot create an infinite retry loop by returning the wrong flag.
 */
const MAX_ATTEMPTS = 5

/**
 * How long a claim is good for without a heartbeat.
 *
 * A crash-restart backstop, not the reclaim trigger: the stages most likely to
 * outrun a lease are the ones blocked in a synchronous native call, which
 * cannot heartbeat, so expiry alone would re-dispatch a job whose executor is
 * alive and working. `lease_owner` (the process generation) is what actually
 * decides, and `lease_epoch` fences the write either way.
 */
const LEASE_MS = 5 * 60 * 1000

/**
 * How far PAST its lease a job must be before its slot is taken back.
 *
 * Three lease periods. A stage that paces network requests reports progress
 * between them and can legitimately go one or two periods without a heartbeat;
 * a process that died reports nothing ever again. Fifteen minutes of silence
 * tells those apart, where five minutes does not.
 */
const LEASE_GRACE_MS = 3 * LEASE_MS

/**
 * How long corpus-sweep wakeups are coalesced.
 *
 * Ingesting fifty papers fires fifty wakeups; each sweep re-matches every
 * unresolved reference in the corpus, so running fifty of them would do the
 * same work fifty times for one answer.
 */
const SWEEP_DEBOUNCE_MS = 750

/** Statuses that satisfy a dependent. `review` counts: it is terminal-ok. */
const DEP_SATISFIED = `('done','review')`

/**
 * The wait a rate limiter asked for, in ms, if this error carries one.
 *
 * Recovered by DUCK-TYPING rather than by importing `TransientLlmError`: a
 * stage reaches a model through `ctx.llm`, and by the time the error arrives
 * here it may have been re-thrown or wrapped by the stage. Reading the field
 * where it is present costs nothing and survives that; `instanceof` would not.
 */
function retryAfterOf(err: unknown): number | undefined {
  const sec = (err as { retryAfterSec?: unknown } | null)?.retryAfterSec
  return typeof sec === 'number' && sec > 0 ? sec * 1000 : undefined
}

/**
 * Is this exception a fault in OUR OWN code rather than something the world
 * did to us?
 *
 * The distinction decides whether the job is retried. A `TypeError` — calling a
 * method the object does not have, reading a field of undefined — will throw
 * identically on every attempt, so retrying it buys nothing and costs the model
 * call the stage made before reaching the broken line. A refused socket or a
 * dropped connection is the opposite: the same input may well succeed in a
 * minute, and those must stay retryable.
 *
 * Recognised by CONSTRUCTOR, because these are the runtime's own errors and the
 * runtime is what raises them. Anything else — including a plain `Error` a stage
 * threw deliberately — is treated as operational, which is the safe way round:
 * a misjudged retry wastes attempts, a misjudged permanent failure loses work.
 */
function isProgrammingFault(err: unknown): boolean {
  return (
    err instanceof TypeError ||
    err instanceof ReferenceError ||
    err instanceof RangeError ||
    err instanceof SyntaxError
  )
}

/**
 * Thrown to roll back an execution whose lease fence rejected its terminal
 * write. A dedicated type so the catch can tell "I am stale, discard" from a
 * genuine write failure, which must be reported.
 */
class StaleExecutionError extends Error {
  constructor() {
    super('stale execution: the lease fence rejected this run')
    this.name = 'StaleExecutionError'
  }
}

export interface SchedulerOpts {
  concurrency?: number
  idleMs?: number
  now?: () => string
  onChange?: () => void
  onSettled?: () => void
  registry?: ResolvedRegistry
  /**
   * Absent => every stage runs inline in main.
   *
   * Injectable rather than constructed here because the pool spawns real child
   * processes: a CLI verifier or a unit test must be able to drive the state
   * machine without one, and a scheduler that always spawned would make that
   * impossible.
   */
  hostPool?: HostPool
  /**
   * Vector search, for the stages whose question is about MEANING.
   *
   * Injected for the same reason the host pool is: the handle owns a worker
   * thread with its own database connection, and a CLI verifier or a unit test
   * must be able to drive the state machine without spawning one. Absent, the
   * stages that need it return `skipped`/`refused` and say why — they never
   * silently produce the half of their answer that needs no search.
   */
  semantic?: SemanticHandle
}

/** How one execution ended, carried from `settle` to the `stage-end` event. */
interface StageTrace {
  status: string
  note: string | null
  error: string | null
  cached: boolean
}

export class Scheduler {
  private running = false
  private stopped = false
  private readonly inFlightIds = new Map<number, number>()
  /**
   * job id -> the stage it is executing, so an in-flight job can be counted
   * against the AI budget or the local one. Kept beside `inFlightIds` and
   * cleared with it; the job row is no longer available when the count drops.
   */
  private readonly inFlightStages = new Map<number, string | null>()
  private readonly abortsByJob = new Map<number, AbortController>()
  /**
   * What each in-flight execution has settled as, for the developer log only.
   *
   * Populated by `settle` — the ONE place a job reaches a terminal status — so
   * the `stage-end` event reports the outcome that was actually filed rather
   * than one recomputed beside it. Empty whenever the log is off.
   */
  private readonly traceByJob = new Map<number, StageTrace>()
  /**
   * The dispatch ceiling, or null to read it from the database on every tick.
   *
   * Null is the app's case: `queueSettings` owns it, the user can change it in
   * Settings, and a value captured here at construction would mean a change
   * took effect only on the next launch. A test or verifier passes an explicit
   * number and gets exactly that, with no settings row involved.
   */
  private readonly fixedConcurrency: number | null
  private readonly idleMs: number
  private readonly now: () => string
  private readonly onChange: () => void
  private readonly onSettledCb: () => void
  private readonly registry: ResolvedRegistry
  private readonly hostPool: HostPool | null
  private readonly semantic: SemanticHandle | null
  /**
   * Corpus sweeps whose wakeup arrived while they were already running.
   *
   * A sweep reads its work set once at the start, so a bibliography parsed
   * halfway through is never swept by it. `INSERT … ON CONFLICT DO NOTHING`
   * alone loses that wakeup silently; the counter records it, and the sweep is
   * re-enqueued on completion if it advanced.
   */
  private readonly sweepGeneration = new Map<string, number>()
  private readonly sweepStartedAt = new Map<string, number>()
  private sweepDebounce: ReturnType<typeof setTimeout> | null = null
  /**
   * Identifies THIS run of the process.
   *
   * `resumePending` must re-queue rows abandoned by a previous generation while
   * leaving alone the rows this process is still executing. An in-memory set of
   * live ids can only answer the second half — after a crash it is empty, so
   * every abandoned row looks like someone else's. Stamping the generation on
   * the ROW answers both, and survives the process that wrote it.
   */
  private readonly generation = randomUUID()
  private loopHandle: ReturnType<typeof setTimeout> | null = null

  /**
   * How to reach the provider IN FORCE RIGHT NOW — never a captured object.
   *
   * A `LlmProvider` value here is what shipped, and it froze the outage the app
   * happened to launch in: the pre-flight re-runs when connectivity returns and
   * replaces the selection, but a queue holding the startup object went on
   * refusing every job with `UnavailableLlmProvider` until the next launch. The
   * user's remedy — fix the network — could not reach the thing it was meant to
   * fix.
   *
   * A function is accepted alongside a value so the app can pass
   * `getLlmProvider` and the verifiers can keep passing a stub directly.
   */
  private readonly resolveProvider: () => LlmProvider

  constructor(
    private readonly db: DB,
    provider: LlmProvider | (() => LlmProvider),
    opts: SchedulerOpts = {}
  ) {
    this.resolveProvider = typeof provider === 'function' ? provider : (): LlmProvider => provider
    this.fixedConcurrency = opts.concurrency ?? null
    this.idleMs = opts.idleMs ?? 500
    this.now = opts.now ?? ((): string => new Date().toISOString())
    this.onChange = opts.onChange ?? ((): void => {})
    this.onSettledCb = opts.onSettled ?? ((): void => {})
    // Validating at construction means a mis-declared stage fails when the app
    // starts, naming the token, rather than when a user's paper reaches it.
    this.registry = opts.registry ?? resolveRegistry(STAGES)
    this.hostPool = opts.hostPool ?? null
    this.semantic = opts.semantic ?? null
    this.sweepOrphans()
  }

  private notify(): void {
    try {
      this.onChange()
    } catch {
      /* a listener failure must never break job processing */
    }
  }

  private onSettled(): void {
    try {
      this.onSettledCb()
    } catch {
      /* a listener failure must never break job processing */
    }
  }

  /**
   * Delete control rows whose FK-free sentinel no longer resolves.
   *
   * `project_id`, `document_id` and `schema_id` are sentinels with no foreign
   * key (the one-current-run indexes need 0 to be a value, and SQLite treats
   * NULLs as distinct), so nothing cascades when their subject is deleted. A
   * `stage_run` for a deleted schema is worse than untidy: `schema_id` is part
   * of the current-run key, so it holds a cache slot that no re-plan can ever
   * address.
   */
  private sweepOrphans(): void {
    this.db.transaction(() => {
      this.db.exec(
        `DELETE FROM stage_run
          WHERE (project_id <> 0 AND project_id NOT IN (SELECT id FROM project))
             OR (document_id <> 0 AND document_id NOT IN (SELECT id FROM document))
             OR (schema_id <> 0 AND schema_id NOT IN (SELECT id FROM extraction_schema))
             OR (work_id <> 0 AND work_id NOT IN (SELECT id FROM work))`
      )
      this.db.exec(
        `DELETE FROM processing_job
          WHERE (project_id <> 0 AND project_id NOT IN (SELECT id FROM project))
             OR (schema_id <> 0 AND schema_id NOT IN (SELECT id FROM extraction_schema))`
      )
    }).immediate()
  }

  /**
   * Re-enqueue work abandoned by a PREVIOUS process generation.
   *
   * Rows this process is still executing are identified by `lease_owner`, not
   * by an in-memory map: the close guard restarts the scheduler after a
   * cancelled quit while stages are still in flight, so an unqualified re-queue
   * would claim a live job a second time and execute it twice.
   */
  resumePending(): number {
    const now = this.now()
    const mine = this.generation
    return this.db.transaction((): number => {
      // A cancel requested just before quit must survive the restart. Resetting
      // the flag would resurrect a job the user had already dismissed.
      this.db
        .prepare(
          `UPDATE processing_job
              SET status = 'cancelled', error_kind = 'cancelled',
                  finished_at = COALESCE(finished_at, ?), updated_at = ?
            WHERE status IN ('running','queued','blocked') AND cancel_requested = 1
              AND (lease_owner IS NULL OR lease_owner <> ?)`
        )
        .run(now, now, mine)

      // GC every stage_run abandoned mid-execution, in the SAME transaction as
      // the re-queue. Leaving it `running` and `superseded = 0` would hold the
      // ux_stage_run_current slot against the job's own retry.
      const abandoned = this.db
        .prepare(
          `SELECT stage_run_id AS id FROM processing_job
            WHERE status = 'running' AND stage_run_id IS NOT NULL
              AND (lease_owner IS NULL OR lease_owner <> ?)`
        )
        .all(mine) as { id: number }[]
      for (const r of abandoned) {
        deleteRunOutput(this.db, r.id)
        // The epoch bump fences the run itself, matching `cancel`. This path is
        // already scoped to dead generations, so nothing should be able to
        // commit onto these rows — but "should" is not the guarantee, and the
        // two paths that retire a running run must not differ in how strongly
        // they do it.
        //
        // STATUS MOVES OFF `running` WITH `finished_at`, because the two are one
        // fact: a row that says it is executing AND says when it ended is a lie
        // about what happened, and provenance is the one place this app cannot
        // afford one. The process died underneath these runs, which is exactly
        // `failed` — and the error says so rather than leaving a reader of the
        // history to guess why a stage stopped. Only rows still `running` are
        // rewritten: a run that had already committed a terminal status before
        // the process went away keeps it.
        this.db
          .prepare(
            `UPDATE stage_run
                SET superseded = 1, finished_at = ?,
                    lease_epoch = lease_epoch + 1,
                    status = CASE WHEN status = 'running' THEN 'failed' ELSE status END,
                    error = CASE WHEN status = 'running'
                                 THEN COALESCE(error, 'the app closed while this stage was running')
                                 ELSE error END
              WHERE id = ?`
          )
          .run(now, r.id)
      }

      // The process went away underneath these jobs — they never got to fail,
      // so give back the attempt the claim charged them. Scoped to previous
      // generations, which is exactly the set with no terminal write, so this
      // cannot double-count with the abort decrement in `settle`.
      this.db
        .prepare(
          `UPDATE processing_job SET attempts = attempts - 1
            WHERE status = 'running' AND attempts > 0 AND error IS NULL
              AND (lease_owner IS NULL OR lease_owner <> ?)`
        )
        .run(mine)
      this.db
        .prepare(
          `UPDATE processing_job
              SET status = 'failed', error = 'exceeded max attempts (' || attempts || ')',
                  error_kind = 'permanent', finished_at = ?, updated_at = ?
            WHERE status = 'running' AND attempts >= ?
              AND (lease_owner IS NULL OR lease_owner <> ?)`
        )
        .run(now, now, MAX_ATTEMPTS, mine)
      // Read the subjects BEFORE the write, while they still match the WHERE:
      // afterwards they are `queued` and indistinguishable from every other
      // queued job, so the line could only say "some jobs".
      const doomed = this.db
        .prepare(
          `SELECT stage, work_id FROM processing_job
            WHERE status = 'running' AND attempts < ?
              AND (lease_owner IS NULL OR lease_owner <> ?)`
        )
        .all(MAX_ATTEMPTS, mine) as Array<{ stage: string | null; work_id: number | null }>
      const info = this.db
        .prepare(
          `UPDATE processing_job
              SET status = 'queued', lease_owner = NULL, stage_run_id = NULL,
                  started_at = NULL, finished_at = NULL, updated_at = ?
            WHERE status = 'running' AND attempts < ?
              AND (lease_owner IS NULL OR lease_owner <> ?)`
        )
        .run(now, MAX_ATTEMPTS, mine)
      logRearm('resume:orphan', info.changes, {
        stage: summarize(doomed.map((d) => d.stage)),
        why: `works=${summarize(doomed.map((d) => d.work_id))} generation=${mine}`
      })

      // A JOB WHOSE BLOCKER CAN NEVER RUN MUST NOT WAIT FOREVER.
      //
      // The claim query admits a job only when every blocker is `done` or
      // `review`. A blocker that ended `cancelled` or `failed` satisfies
      // neither, so the dependent stays `queued` and the queue reports itself
      // running with nothing in flight — which is what it looks like from the
      // outside: a hang.
      //
      // `cancelDependents` already handles this wherever a job dies WHILE this
      // process is watching. The hole is the restart: a cancel applied by the
      // sweep above (or by a previous generation that quit mid-flight) writes
      // the blocker without ever walking its dependents, and nothing afterwards
      // reconsiders them. One real pipeline sat this way for two days, 14 jobs
      // behind one cancelled head, ten of which had already done their work.
      //
      // Resolving it HERE rather than in the claim query is deliberate: making
      // the claim treat a dead blocker as satisfied would run a stage whose
      // input never arrived. The job cannot proceed; what it must not do is
      // stay silent about that.
      const findOrphans = this.db.prepare(
        `SELECT DISTINCT j.id, j.stage
           FROM processing_job j
           JOIN job_dependency d ON d.job_id = j.id
           JOIN processing_job b ON b.id = d.depends_on_job_id
          WHERE j.status IN ('queued','blocked')
            AND b.status IN ('cancelled','failed')`
      )
      const cancelOrphan = this.db.prepare(
        `UPDATE processing_job
            SET status = 'cancelled', error_kind = 'upstream',
                error = COALESCE(error, 'a stage this job depended on was cancelled or failed'),
                finished_at = COALESCE(finished_at, ?), updated_at = ?
          WHERE id = ? AND status IN ('queued','blocked')`
      )
      // TO A FIXED POINT, because the chain is transitive: cancelling a job
      // makes its OWN dependents unrunnable in turn. A single pass frees only
      // the first rank and leaves the rest queued behind a blocker that is now
      // cancelled — the same hang, one link further down. The real pipeline was
      // a chain of depth 12, and a one-pass sweep would have resolved one job
      // of it. Bounded by the number of jobs, since every round cancels at
      // least one and a cancelled job is never revisited.
      const deadStages: Array<string | null> = []
      for (;;) {
        const orphans = findOrphans.all() as Array<{ id: number; stage: string | null }>
        if (orphans.length === 0) break
        for (const o of orphans) {
          cancelOrphan.run(now, now, o.id)
          deadStages.push(o.stage)
        }
      }
      if (deadStages.length > 0) {
        logRearm('resume:dead-blocker', deadStages.length, {
          stage: summarize(deadStages),
          why: 'blocker ended cancelled or failed; dependent could never be claimed'
        })
      }

      this.notify()
      return info.changes
    }).immediate()
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.stopped = false
    this.resumePending()
    // A wakeup that arrived while the queue was paused would otherwise be lost:
    // the generation was bumped and the debounce fired into a stopped
    // scheduler, which enqueues nothing. Waking here also covers the launch
    // case, where the in-memory counters start empty but the corpus may have
    // changed since the last session.
    this.wakeCorpusSweeps()
    this.scheduleTick(0)
    this.notify()
  }

  stop(): void {
    this.stopped = true
    this.running = false
    if (this.loopHandle) {
      clearTimeout(this.loopHandle)
      this.loopHandle = null
    }
    // In-flight stages are NOT aborted: every stage commits its own bulk rows
    // and its own terminal record together, so letting one land loses nothing,
    // while killing it discards everything it had done. Pausing means "claim
    // nothing new".
    this.notify()
  }

  isRunning(): boolean {
    return this.running
  }

  inFlightCount(): number {
    let n = 0
    for (const c of this.inFlightIds.values()) n += c
    return n
  }

  /** True for a stage that spends its time waiting on the model gateway. */
  private isLlmStage(stageId: string | null): boolean {
    if (stageId === null) return false
    return this.registry.byId(stageId)?.stage.usesLlm === true
  }

  /** In-flight jobs of one kind. The two budgets are counted separately. */
  private inFlightOfKind(llm: boolean): number {
    let n = 0
    for (const [id, c] of this.inFlightIds) {
      if (this.isLlmStage(this.inFlightStages.get(id) ?? null) === llm) n += c
    }
    return n
  }

  /**
   * The dispatch ceilings, ABSOLUTE across every project — and SEPARATE for AI
   * work and everything else.
   *
   * TWO BUDGETS, because an AI step is not hardware-bound. It spends its whole
   * life waiting on the gateway, so counting it against the same allowance as
   * OCR meant a paper waiting on a model held a slot that a second paper's text
   * extraction could have used: the machine sat idle while the queue looked
   * full. Splitting them lets local work keep flowing at full speed no matter
   * how long the model takes, which is the whole point.
   *
   * Read per tick rather than captured, so raising a limit in Settings starts
   * more work immediately and lowering one stops claiming beyond the new number
   * without waiting for a restart. Jobs already in flight are never killed by a
   * lowered limit — the loop simply stops claiming until it is back under.
   *
   * Never scoped to a project: `claim()` has no project predicate, so these are
   * counts for the whole app. Two projects being processed at once share them
   * rather than each getting their own.
   */
  private currentLimits(): { llm: number; local: number } {
    if (this.fixedConcurrency !== null) {
      // An explicit number from a test or verifier means "this many jobs, full
      // stop" — the behaviour those callers were written against.
      return { llm: this.fixedConcurrency, local: this.fixedConcurrency }
    }
    const s = readQueueSettings(this.db)
    return { llm: s.llm, local: s.local }
  }

  private scheduleTick(delay: number): void {
    if (this.stopped) return
    this.loopHandle = setTimeout(() => void this.tick(), delay)
  }

  /**
   * Reclaim a job whose executor stopped reporting.
   *
   * `LEASE_MS` was written and renewed on every heartbeat but never READ while
   * the scheduler was running: the only reclaim was `resumePending`, which runs
   * at startup and matches on a foreign `lease_owner`. A stage wedged inside a
   * network call therefore held its slot indefinitely — three such jobs pinned
   * every slot for 28 minutes with 32 jobs queued behind them, and the app
   * reported itself running the whole time.
   *
   * ONLY ONES THIS PROCESS OWNS, and only well past expiry. A job whose owner
   * is a previous generation belongs to `resumePending`; the epoch bump fences
   * the abandoned executor out, so if it does wake its write matches no row.
   *
   * THE GRACE PERIOD IS NOT DECORATION. A stage that paces its own requests —
   * `reference-abstracts` sends one per reference with rate-limit backoff, and
   * a 45-entry bibliography takes many minutes — reports progress between
   * requests, not during them, so a gap longer than `LEASE_MS` is ORDINARY
   * there. Reclaiming at expiry alone killed three such jobs mid-flight and
   * re-ran them from the start, which is worse than the stall it was written to
   * cure: the work is lost AND the slot churns. Only a job silent for several
   * lease periods is actually gone.
   */
  private reclaimExpiredLeases(): number {
    const now = this.now()
    const deadline = new Date(Date.now() - LEASE_GRACE_MS).toISOString()
    const stale = this.db
      .prepare(
        `SELECT id, stage FROM processing_job
          WHERE status = 'running'
            AND lease_owner = ?
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at < ?`
      )
      .all(this.generation, deadline) as Array<{ id: number; stage: string | null }>
    if (stale.length === 0) return 0

    for (const j of stale) {
      this.db
        .prepare(
          `UPDATE processing_job
              SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL,
                  lease_epoch = lease_epoch + 1, stage_run_id = NULL,
                  started_at = NULL, updated_at = ?
            WHERE id = ? AND status = 'running'`
        )
        .run(now, j.id)
      // Stop the abandoned executor writing over the retry.
      this.abortsByJob.get(j.id)?.abort()
    }
    logRearm('lease:expired', stale.length, {
      stage: summarize(stale.map((j) => j.stage)),
      why: `no heartbeat for over ${Math.round((LEASE_MS + LEASE_GRACE_MS) / 60000)} minute(s); slot released`
    })
    this.notify()
    return stale.length
  }

  private async tick(): Promise<void> {
    if (this.stopped) return
    // BEFORE claiming, so a wedged job's slot is freed in the same pass that
    // would otherwise find no room.
    try {
      this.reclaimExpiredLeases()
    } catch {
      // A busy database is a reason to try again next tick, not to stall.
    }
    let dispatched = 0
    while (true) {
      const limits = this.currentLimits()
      // WHICH KINDS STILL HAVE ROOM, recomputed each pass. A full AI budget must
      // not stop the loop: the next queued job may be an OCR the machine is idle
      // for, and breaking here is exactly the stall the two budgets exist to
      // prevent. `claim` is told which kinds to skip, so a blocked kind is
      // stepped over in SQL rather than claimed and then rejected — claiming and
      // putting it back would burn an attempt on a job that never ran.
      const skip: string[] = []
      if (this.inFlightOfKind(true) >= limits.llm) skip.push('llm')
      if (this.inFlightOfKind(false) >= limits.local) skip.push('local')
      if (skip.length === 2) break

      let job: JobRow | null
      try {
        job = this.claim(skip)
      } catch (err) {
        // A busy database is a reason to come back on the next tick, not to
        // tear down the loop: better-sqlite3 is synchronous, so retrying in
        // place would block main for the whole busy_timeout.
        // eslint-disable-next-line no-console
        console.error('[scheduler] claim failed:', err)
        break
      }
      if (!job) break
      dispatched++
      this.inFlightIds.set(job.id, (this.inFlightIds.get(job.id) ?? 0) + 1)
      // Which KIND this job is, recorded alongside the count so the two budgets
      // can be told apart. Kept here rather than re-derived from the row later:
      // the row is gone by the time the `finally` runs.
      this.inFlightStages.set(job.id, job.stage)
      void this.process(job).finally(() => {
        const left = (this.inFlightIds.get(job.id) ?? 1) - 1
        if (left > 0) this.inFlightIds.set(job.id, left)
        else {
          this.inFlightIds.delete(job.id)
          this.inFlightStages.delete(job.id)
        }
        this.onSettled()
      })
    }
    this.scheduleTick(dispatched > 0 ? 0 : this.idleMs)
  }

  /**
   * Claim the next dependency-satisfied job.
   *
   * `.immediate()`, not deferred: a deferred transaction that starts as a
   * reader and upgrades to a writer gets SQLITE_BUSY_SNAPSHOT WITHOUT invoking
   * the busy handler, so `busy_timeout` does not help and the claim throws
   * intermittently whenever anything else is writing.
   */
  private claim(skipKinds: readonly string[] = []): JobRow | null {
    let changed = false
    // While the breaker is open, host-isolated jobs are not claimed AT ALL —
    // not claimed and failed. A crash loop is session state, so it must cost
    // those jobs no attempts and leave nothing cached; burning the budget would
    // retire papers permanently over a condition that clears by itself.
    const excluded =
      this.hostPool?.breakerOpen() === true
        ? this.registry.order.filter((r) => r.stage.isolation === 'host').map((r) => r.stage.id)
        : []
    // A KIND WHOSE BUDGET IS FULL IS SKIPPED IN THE QUERY, not claimed and put
    // back. `ORDER BY priority, id` means the head of the queue may well be an
    // AI job while the AI budget is full; without this the loop would claim it,
    // find no room, and either burn an attempt or spin. Excluding its stages
    // here lets the claim fall through to the next job of the OTHER kind, which
    // is what keeps local work moving while the model is busy.
    for (const kind of skipKinds) {
      for (const r of this.registry.order) {
        if ((r.stage.usesLlm === true) === (kind === 'llm')) excluded.push(r.stage.id)
      }
    }
    // A job with no stage at all (a legacy row) counts as local work: it reaches
    // no model, so it must not be held back by a full AI budget.
    const legacyBlocked = skipKinds.includes('local')
    // `stage NOT IN (…)` is NULL for a legacy row with no stage, which SQL
    // treats as not-true — so an unqualified exclusion silently hides every such
    // row the moment any stage is excluded. `IS NULL` restores them, except when
    // the local budget (the one they belong to) is itself full.
    const exclusion =
      excluded.length > 0
        ? ` AND (${legacyBlocked ? '' : 'stage IS NULL OR '}stage NOT IN (${excluded
            .map(() => '?')
            .join(',')}))`
        : ''
    // PIPELINE ORDER, NOT INSERTION ORDER. `id ASC` alone means a job runs in
    // the order its ROW was written, which is only the pipeline's order while
    // every stage has existed since the corpus was imported. Add a stage later
    // and its jobs carry the highest ids in the table, so a paper being caught
    // up runs the new step last — after the stages that come after it — and a
    // reader watching the queue sees the pipeline apparently run backwards.
    //
    // The registry has already sorted the stages topologically, so the position
    // it assigns is the true order; this projects it onto the rows. Dependency
    // edges still decide what MAY run — this only chooses among jobs that are
    // all eligible, which is exactly where the old tie-break was arbitrary.
    // `id ASC` stays as the final tie-break, so two jobs of one stage keep their
    // insertion order and the sort remains total.
    const stageOrderCase = `CASE stage${this.registry.order
      .map((r) => ` WHEN '${r.stage.id.replace(/'/g, "''")}' THEN ${r.index}`)
      .join('')} ELSE ${this.registry.order.length} END`
    const claimTxn = this.db.transaction((): JobRow | null => {
      const now = this.now()
      const row = this.db
        .prepare(
          `SELECT id, job_type, stage, status, work_id, document_id, project_id,
                  schema_id, fanout_key, payload, attempts, lease_epoch, cancel_requested
             FROM processing_job
            WHERE status = 'queued'
              AND cancel_requested = 0
              AND (run_after IS NULL OR run_after <= ?)${exclusion}
              AND NOT EXISTS (
                    SELECT 1 FROM job_dependency d
                      JOIN processing_job p ON p.id = d.depends_on_job_id
                     WHERE d.job_id = processing_job.id
                       AND p.status NOT IN ${DEP_SATISFIED})
            ORDER BY priority ASC, ${stageOrderCase} , id ASC LIMIT 1`
        )
        .get(now, ...excluded) as JobRow | undefined
      if (!row) return null

      if (row.attempts >= MAX_ATTEMPTS) {
        this.db
          .prepare(
            `UPDATE processing_job
                SET status = 'failed', error = 'exceeded max attempts (' || attempts || ')',
                    error_kind = 'permanent', finished_at = ?, updated_at = ?
              WHERE id = ? AND status = 'queued'`
          )
          .run(now, now, row.id)
        changed = true
        return null
      }

      this.db
        .prepare(
          `UPDATE processing_job
              SET status = 'running', attempts = attempts + 1,
                  lease_epoch = lease_epoch + 1, lease_owner = ?,
                  started_at = ?, finished_at = NULL,
                  error = NULL, error_code = NULL, error_kind = NULL,
                  outcome = NULL, outcome_note = NULL, updated_at = ?
            WHERE id = ? AND status = 'queued'`
        )
        .run(this.generation, now, now, row.id)
      changed = true
      return {
        ...row,
        status: 'running',
        attempts: row.attempts + 1,
        lease_epoch: row.lease_epoch + 1
      }
    })
    const claimed = claimTxn.immediate()
    if (changed) this.notify()
    return claimed
  }

  private async process(job: JobRow): Promise<void> {
    const controller = new AbortController()
    // Registered and removed by THIS execution, matched by identity.
    //
    // Two executions of one job id overlap routinely — a re-run requeues a job
    // whose executor is still winding down, and the next tick claims it
    // immediately; `inFlightIds` is refcounted for exactly that reason. An
    // unconditional `delete(job.id)` in the finishing execution therefore threw
    // away the controller the NEW one had just registered, and every later
    // `cancel` or re-run found nothing to abort for a job that was very much
    // running. The only symptom would be a stage that quietly ignored a cancel.
    this.abortsByJob.set(job.id, controller)
    const startedMs = Date.now()
    try {
      // FENCED ON THE EPOCH, not only on the status. A re-run requeues this job
      // and the next tick can re-claim it back to `running` before this read
      // happens, so `status = 'running'` alone lets a stale execution continue —
      // and it then calls `beginRun`, which supersedes and DELETES the output of
      // the replacement's run, and writes its own `stage_run_id` over the
      // replacement's. Comparing the epoch is what tells "still mine" from
      // "running again, for someone else".
      const fresh = this.db
        .prepare('SELECT status, cancel_requested, lease_epoch FROM processing_job WHERE id = ?')
        .get(job.id) as
        | { status: string; cancel_requested: number; lease_epoch: number }
        | undefined
      if (
        !fresh ||
        fresh.status !== 'running' ||
        fresh.cancel_requested === 1 ||
        fresh.lease_epoch !== job.lease_epoch
      )
        return

      if (!job.stage) {
        // Every job names a stage now. A row that does not is left over from a
        // schema older than the registry, and running it against a guessed
        // analysis type is how the old queue produced a title+abstract summary
        // for a job that asked for something else.
        this.settle(job, {
          status: 'failed',
          outcome: null,
          note: null,
          error: `job ${job.id} names no stage`,
          errorKind: 'permanent'
        })
        return
      }
      await this.runStageJob(job, controller.signal, startedMs)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // An uncaught throw is DEFINED rather than left to the stage author:
      // transient and retryable, with the attempts ceiling as the backstop.
      this.settle(job, {
        status: job.attempts >= MAX_ATTEMPTS ? 'failed' : 'queued',
        outcome: null,
        note: null,
        error: msg.slice(0, 500),
        errorKind: 'transient'
      })
    } finally {
      // Only if it is still ours — see the registration above.
      if (this.abortsByJob.get(job.id) === controller) this.abortsByJob.delete(job.id)
      this.notify()
    }
  }

  // ---------------------------------------------------------------- stage jobs
  /**
   * THE one place a stage execution begins, and therefore the only place stage
   * tracing belongs.
   *
   * Wrapping here rather than inside each stage is what makes the guarantee
   * structural: a stage added next year is traced without its author knowing
   * this file exists, and — because the scope is ambient — so is every LLM call
   * it makes, however many layers down. `logStageEnd` fires from the `finally`,
   * so the paths that return WITHOUT a terminal write (cancelled, stale,
   * superseded mid-flight) are recorded as what they are instead of vanishing.
   * Those are the executions whose disappearance is hardest to explain from the
   * database, which stores no row for them at all.
   */
  private async runStageJob(job: JobRow, signal: AbortSignal, startedMs: number): Promise<void> {
    if (!isDevLogEnabled()) return this.executeStageJob(job, signal, startedMs)
    const trace: StageTrace = {
      status: 'abandoned',
      note: null,
      error:
        'the execution ended without a terminal outcome — cancelled, superseded, or fenced out ' +
        'by a newer generation of the same job',
      cached: false
    }
    this.traceByJob.set(job.id, trace)
    return withDevLogScope(
      {
        stage: job.stage ?? undefined,
        jobId: job.id,
        workId: job.work_id ?? 0,
        documentId: job.document_id ?? 0,
        projectId: job.project_id,
        schemaId: job.schema_id === 0 ? null : job.schema_id,
        fanOut: job.fanout_key === '' ? null : job.fanout_key
      },
      async () => {
        try {
          await this.executeStageJob(job, signal, startedMs)
        } finally {
          this.traceByJob.delete(job.id)
          logStageEnd({
            stage: job.stage ?? '?',
            jobId: job.id,
            workId: job.work_id ?? 0,
            status: trace.status,
            durationMs: Date.now() - startedMs,
            note: trace.note,
            error: trace.error,
            cached: trace.cached
          })
        }
      }
    )
  }

  private async executeStageJob(
    job: JobRow,
    signal: AbortSignal,
    startedMs: number
  ): Promise<void> {
    const resolved = this.registry.byId(job.stage as string)
    if (!resolved) {
      this.settle(job, {
        status: 'failed',
        outcome: null,
        note: null,
        error: `stage '${job.stage}' is not registered`,
        errorKind: 'permanent'
      })
      return
    }
    const { stage } = resolved
    // ONE provider for the whole of this job, resolved at its start.
    //
    // Read per job rather than held for the process, so a gateway that comes
    // back mid-session is picked up by the next job instead of the next launch.
    // Bound once here rather than read at each of the call sites below, because
    // a job that reached the model under one provider and stamped a different
    // one into `analysis_run` would put a model in the provenance that never
    // read the paper — the exact claim this pipeline exists to be able to make.
    const provider = this.resolveProvider()
    if (stage.runtime !== 'node') {
      // Every registered stage runs in a Node host; no other runtime is wired
      // to the pool, and none is planned (see docs/packaging.md, "No Python
      // payload ships"). A stage declaring one would otherwise appear to run
      // and produce nothing, so refuse loudly rather than silently.
      this.settle(job, {
        status: 'failed',
        outcome: null,
        note: null,
        error: `stage '${stage.id}' declares runtime '${stage.runtime}', which this build cannot host`,
        errorKind: 'permanent'
      })
      return
    }

    const planCtx: StagePlanContext = {
      db: this.db,
      workId: job.work_id ?? 0,
      documentId: job.document_id ?? 0,
      projectId: job.project_id
    }
    const fan: FanOutKey | null =
      job.fanout_key === ''
        ? null
        : { key: job.fanout_key, schemaId: job.schema_id === 0 ? undefined : job.schema_id }

    const decision = decideCache(this.db, this.registry, stage, planCtx, fan)
    // Logged BEFORE the cache decision is acted on, so a paper that produced
    // nothing on this run still shows a `stage-start` naming the run it was
    // answered from. A trace with no entry for a stage that "ran" is the most
    // misleading shape this file can produce.
    logStageStart({
      stage: stage.id,
      stageVersion: stage.version,
      jobId: job.id,
      workId: planCtx.workId,
      documentId: planCtx.documentId,
      projectId: planCtx.projectId,
      schemaId: fan?.schemaId ?? null,
      fanOut: fan?.key ?? null,
      fingerprint: decision.fingerprint,
      isolation: stage.isolation,
      cached: decision.hit
    })
    if (decision.hit && decision.current) {
      const cur = decision.current
      addDevLogScope({ stageRunId: cur.id })
      // Fenced, like every other write this execution makes to its own job row:
      // a re-run may have requeued and re-claimed it, and an unfenced write
      // would point the NEW generation's job at the run this stale one read.
      this.db
        .prepare('UPDATE processing_job SET stage_run_id = ? WHERE id = ? AND lease_epoch = ?')
        .run(cur.id, job.id, job.lease_epoch)
      this.settle(job, {
        // The SAME mapping the fresh-run path uses. Two tables of outcome->job
        // status is how a cached abstention comes back as `done` while the run
        // that produced it was filed for review.
        status: cur.status === 'empty' || cur.status === 'refused' ? 'review' : 'done',
        outcome: cur.status as 'succeeded' | 'empty' | 'skipped' | 'refused',
        note: cur.outcome_note,
        error: null,
        errorKind: null,
        cached: true
      })
      if (cur.status === 'refused') {
        this.cancelDependents(
          job.id,
          stage.id,
          `upstream stage '${stage.id}' declined to produce this, so there is nothing to work from`
        )
      }
      return
    }

    const stageRunId = beginRun(this.db, {
      key: keyOf(stage, planCtx, fan),
      scope: stage.scope,
      stageVersion: stage.version,
      fingerprint: decision.fingerprint,
      leaseEpoch: job.lease_epoch,
      now: this.now()
    })
    addDevLogScope({ stageRunId })
    this.db
      .prepare('UPDATE processing_job SET stage_run_id = ? WHERE id = ? AND lease_epoch = ?')
      .run(stageRunId, job.id, job.lease_epoch)
    // Snapshot BEFORE the body runs, so a wakeup arriving during it compares
    // strictly greater and re-enqueues. Snapshotting afterwards would record
    // the wakeup as already handled — which is the swallow this exists to stop.
    if (stage.scope === 'corpus') {
      this.sweepStartedAt.set(stage.id, this.sweepGeneration.get(stage.id) ?? 0)
    }

    const subject = {
      // Resolved HERE, in main, and shipped as data — the host has no database,
      // which is what makes "one writer" structural rather than a convention.
      modelSettings: readModelSettings(this.db),
      contactEmail: contactEmail(this.db),
      work:
        (this.db
          .prepare('SELECT id, title, abstract FROM work WHERE id = ?')
          .get(planCtx.workId) as { id: number; title: string; abstract: string | null }) ?? null,
      document:
        (this.db.prepare('SELECT id, work_id, content_status FROM document WHERE id = ?').get(
          planCtx.documentId
        ) as { id: number; work_id: number; content_status: string | null }) ?? null,
      pdfPath: ((): { baseDir: string; relativePath: string; absPath: string } | null => {
        const loc = resolvePdfPath(this.db, planCtx.documentId)
        if (!loc) return null
        return { ...loc, absPath: join(loc.baseDir, loc.relativePath) }
      })(),
      identifiers: this.db
        .prepare('SELECT scheme, value FROM identifier WHERE work_id = ?')
        .all(planCtx.workId) as Array<{ scheme: string; value: string }>,
      bibliographicRecord: ((): BibliographicRecord | null => {
        const w = this.db
          .prepare('SELECT title, work_type, publication_year, venue FROM work WHERE id = ?')
          .get(planCtx.workId) as
          | { title: string; work_type: string; publication_year: number | null; venue: string | null }
          | undefined
        if (!w) return null
        return {
          title: w.title,
          workType: w.work_type,
          year: w.publication_year,
          venue: w.venue,
          authors: this.db
            .prepare(
              `SELECT a.full_name AS full, a.given_name AS given, a.family_name AS family
                 FROM work_author wa JOIN author a ON a.id = wa.author_id
                WHERE wa.work_id = ? ORDER BY wa.position ASC`
            )
            .all(planCtx.workId) as Array<{
            full: string
            given: string | null
            family: string | null
          }>
        }
      })(),
      retrievalStatus:
        (
          this.db
            .prepare('SELECT retrieval_status FROM document WHERE id = ?')
            .get(planCtx.documentId) as { retrieval_status: string } | undefined
        )?.retrieval_status ?? null
    }

    const progress = (pct: number, note?: string): void => {
      this.db
        .prepare(
          `UPDATE processing_job SET progress_pct = ?, progress_note = ?,
                  lease_expires_at = ?, updated_at = ?
            WHERE id = ? AND lease_epoch = ?`
        )
        .run(
          Math.max(0, Math.min(100, Math.round(pct))),
          note ?? null,
          // RENEWED, not stamped with the current time: writing `now` would
          // mark the lease already expired at the exact moment the stage
          // reported it was alive.
          new Date(Date.now() + LEASE_MS).toISOString(),
          this.now(),
          job.id,
          job.lease_epoch
        )
    }
    const log = (msg: string): void => {
      // eslint-disable-next-line no-console
      console.log(`[stage ${stage.id} job ${job.id}] ${msg}`)
    }
    // BOUND, because a hosted stage's calls come back over an IPC `message`
    // event, which is off this execution's async chain: unbound, exactly the
    // calls that cross a process boundary would be logged with no paper on
    // them, and those are the ones that cost money.
    const callLlm = bindDevLogScope((
      messages: Array<{
        role: 'system' | 'user' | 'assistant'
        content: string
        images?: Array<{ png: Buffer; caption?: string }>
      }>,
      opts?: { model?: string; maxTokens?: number }
    ): Promise<string> => {
      if (signal.aborted) return Promise.reject(new Error('cancelled'))
      // The signal goes THROUGH to the provider, which passes it to the gate.
      // Without it a cancelled job's in-flight call keeps the single
      // process-wide slot until the 15-minute wall-clock cap, which stops every
      // other LLM job in the app over a job the user already dismissed.
      return provider.callLLM(messages, { ...opts, signal })
    })

    const emitted = new Map<Capability, unknown>()
    const pendingWrites: unknown[] = []
    let outcome: StageOutcome

    /**
     * A STAGE THAT NEEDS A MODEL DOES NOT RUN WITHOUT ONE.
     *
     * Decided here, before `execute`, rather than left to each stage's own error
     * handling — because the stages did not agree and one of them lied.
     * `summarise` let the error out and showed as failed. `citation-contexts`
     * treats role classification as an optional refinement: it kept the rows it
     * had parsed, recorded the shortfall in its note and settled SUCCEEDED. A
     * green tick on a paper whose 48 citations were never classified is the
     * worst outcome available — the queue's failure count excludes it, Retry
     * does not offer it, nothing brings the user back when the gateway returns,
     * and the screen says the work is finished.
     *
     * Set BEFORE the host/inline branch so both are covered by one check: a
     * hosted stage would otherwise be dispatched to a child process to discover
     * the same thing, and its generic catch files it `failed` and retryable —
     * spending the paper's whole attempt budget on a model that is not there.
     */
    const modelMissing =
      stage.usesLlm && provider instanceof UnavailableLlmProvider
        ? `this step needs an AI model and none could be reached — ${provider.why}`
        : null

    if (modelMissing) {
      // `refused`, not `failed`: nothing broke, and retrying cannot help while
      // the answer is the same. It is terminal, it settles the job to `review`
      // so the paper is listed as needing attention rather than counted as
      // done, and re-running it once a model answers is the user's call.
      outcome = { status: 'refused', reason: modelMissing }
    } else if (stage.isolation === 'host' && this.hostPool) {
      // Inputs are resolved HERE, in main, and travel as data. The host has no
      // database, so there is exactly one writer and one path that can see a
      // superseded run's rows — this one.
      const inputs: Array<[Capability, unknown]> = []
      // Optional inputs travel too. The host has no database and cannot go and
      // look one up, so a token left out here is `undefined` inside the body —
      // which the stage reads as "this paper has none", a claim about the paper
      // made by the marshalling.
      for (const cap of inputsOf(stage)) {
        inputs.push([cap, resolveInput<unknown>(this.db, this.registry, stage, planCtx, cap)])
      }
      try {
        const res = await this.hostPool.dispatch({
          message: {
            stageId: stage.id,
            workId: planCtx.workId,
            documentId: planCtx.documentId,
            projectId: planCtx.projectId,
            stageRunId,
            jobId: job.id,
            fanOut: fan,
            subject,
            llmModel: provider.model,
            // Read from the DEFINITION and sent as data: the pool holds no
            // registry and must not need one to decide how long to wait before
            // killing a host it was told to cancel.
            cancelGraceMs: stage.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS,
            inputs
          },
          signal,
          onProgress: progress,
          onLog: log,
          callLlm
        })
        outcome = res.outcome
        for (const [cap, value] of res.emitted) {
          if (!stage.provides.includes(cap as Capability)) {
            outcome = {
              status: 'failed',
              error: `stage '${stage.id}' emitted '${cap}', which it does not declare providing`,
              retryable: false
            }
            break
          }
          emitted.set(cap as Capability, value)
        }
        pendingWrites.push(...res.writes)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        outcome = {
          status: 'failed',
          error: msg,
          retryable: !signal.aborted,
          retryAfterMs: retryAfterOf(err)
        }
      }
    } else {
      const ctx: StageContext = {
        workId: planCtx.workId,
        documentId: planCtx.documentId,
        projectId: planCtx.projectId,
        fanOut: fan,
        stageRunId,
        jobId: job.id,
        signal,
        llm: { model: provider.model, call: callLlm },
        semantic: this.semantic,
        db: {
          work: () => subject.work,
          document: () => subject.document,
          pdfPath: () => subject.pdfPath,
          identifiers: () => subject.identifiers,
          retrievalStatus: () => subject.retrievalStatus,
          bibliographicRecord: () => subject.bibliographicRecord,
          corpus: () => loadCorpusWorks(this.db),
          citationCandidates: (promptVersion) =>
            loadCitationCandidates(this.db, promptVersion),
          modelSettings: () => readModelSettings(this.db),
          contactEmail: () => contactEmail(this.db),
          reusableAbstract: (askKey, fetcherVersion) => {
            const row = abstractByAskKey(this.db, askKey, fetcherVersion)
            return row?.abstract
              ? {
                  doi: row.doi,
                  matchedTitle: row.matchedTitle,
                  abstract: row.abstract,
                  source: row.source
                }
              : null
          },
          scoringSets: () => scoringSets(this.db),
          projectQuestion: () => projectQuestion(this.db, planCtx.projectId, planCtx.workId),
          zoteroConnection: () => readZoteroConnection(this.db, planCtx.projectId),
          pendingReviews: (promptVersion) =>
            loadPendingReviews(this.db, planCtx.workId, planCtx.projectId, promptVersion)
        },
        write: (payload) => {
          pendingWrites.push(payload)
        },
        input: <T>(cap: Capability): T | undefined =>
          resolveInput<T>(this.db, this.registry, stage, planCtx, cap),
        emit: (cap, value) => {
          if (!stage.provides.includes(cap)) {
            throw new Error(
              `stage '${stage.id}' emitted '${cap}', which it does not declare providing`
            )
          }
          emitted.set(cap, value)
        },
        progress,
        log,
        runAnalysis: async (req) => {
          const res = await runPipeline(
            this.db,
            provider,
            {
              workId: planCtx.workId,
              projectId: planCtx.projectId,
              analysisType: req.analysisType,
              docText: req.docText,
              documentId: req.documentId ?? planCtx.documentId,
              schemaId: req.schemaId ?? null,
              onlyFields: req.onlyFields ?? null,
              images: req.images,
              paragraphIndexMap: req.paragraphIndexMap ?? null
            },
            this.now()
          )
          // LINKED THE MOMENT IT EXISTS, not at `finishRun`.
          //
          // `runPipeline` commits the `analysis_run` in its own transaction, and
          // `finishRun` — the last thing an execution does — is what used to
          // write this link. Everything in between is a window in which a
          // CURRENT analysis run exists that no stage run points at, and
          // `deleteRunOutput` retires an analysis by following exactly this
          // link. So an execution retired inside that window (which is what a
          // re-run does to it, on purpose) left its facts and evidence spans
          // reading as current while the paragraphs they quote had just been
          // deleted — a conclusion presented at full confidence over an evidence
          // base that is gone.
          //
          // Writing it here costs one UPDATE and closes the window to the width
          // of a single synchronous statement. `finishRun` still COALESCEs the
          // same value, so this is the earlier of two writes of one fact, not a
          // second source of truth.
          // Fenced on the run's own epoch: if this execution has been retired
          // mid-call the link must NOT be attached, or a current analysis run
          // would hang off a superseded stage run whose paragraphs are already
          // deleted. The write failing is the signal that the terminal write is
          // about to fail too, and the whole execution be discarded.
          this.db
            .prepare(
              `UPDATE stage_run SET analysis_run_id = ?
                WHERE id = ? AND lease_epoch = ? AND status = 'running'`
            )
            .run(res.analysisRunId, stageRunId, job.lease_epoch)
          return {
            analysisRunId: res.analysisRunId,
            factCount: res.factCount,
            evidenceCount: res.evidenceCount,
            model: provider.model,
            droppedUnanchored: res.droppedUnanchored,
            droppedOffSchema: res.droppedOffSchema,
            droppedWrongDimension: res.droppedWrongDimension,
            demangledBounds: res.demangledBounds,
            modelReturnedNothing: res.modelReturnedNothing,
            shortfalls: res.shortfalls
          }
        },
        runSummary: async (kind) => {
          const res = await generateSummary(
            this.db,
            provider,
            {
              workId: planCtx.workId,
              projectId: planCtx.projectId,
              kind,
              // The stage may be re-planned for every project that holds the
              // paper, and a general summary is one text shared by all of them.
              reuseIfCurrent: true
            },
            this.now()
          )
          // Linked here for the same reason `runAnalysis` links its run here
          // rather than at `finishRun`: between the summary's own commit and the
          // terminal record there is a window in which a current analysis run
          // exists that no stage run points at, and `deleteRunOutput` retires an
          // analysis by following exactly this link. Fenced on the lease epoch,
          // so a retired execution attaches nothing. A REUSED summary is not
          // linked — it belongs to the execution that wrote it, and re-pointing
          // it at this one would let this execution's retirement delete a
          // summary another project still reads.
          if (!res.reused) {
            this.db
              .prepare(
                `UPDATE stage_run SET analysis_run_id = ?
                  WHERE id = ? AND lease_epoch = ? AND status = 'running'`
              )
              .run(res.analysisRunId, stageRunId, job.lease_epoch)
          }
          return res
        }
      }
      try {
        outcome = await stage.execute(ctx)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // NO MODEL COULD BE REACHED is a stage-level REFUSAL, not a failure to
        // retry. The distinction is the whole reason the error has its own type.
        //
        // Retrying WITHIN this job cannot help: the provider is bound once at
        // its start, so every attempt asks the same dead socket and gets the
        // same answer. What helps is a LATER job, after the pre-flight has
        // re-run and put a live provider in force. Left in the generic branch
        // it arrives as
        // `retryable: true`, which spends each paper's entire attempt budget on
        // a dead socket and then files the paper `failed` — telling the user
        // their document could not be analysed when the truth is that nothing
        // tried to. `refused` says what actually happened, is terminal, and
        // names the remedy.
        if (isLlmUnavailable(err)) {
          // The CODE IS STRIPPED for the reader. `E_LLM_UNAVAILABLE` is how this
          // error is recognised after crossing a host boundary, where the class
          // is gone — it is machinery, and it was being printed to a scientist
          // in the middle of the one sentence telling them what to do about it.
          outcome = {
            status: 'refused',
            reason: `no AI model could be reached — ${msg.replace(/^E_LLM_UNAVAILABLE:\s*/, '')}`
          }
        } else if (isProgrammingFault(err)) {
          // A FAULT IN THIS APP, and the user is told exactly that. The raw JS
          // message ("db.prepare is not a function") describes our code to
          // someone who did not write it and cannot act on it; naming the stage
          // and the paper at least says what did not get done and to what. The
          // message and the stack go to the log and the dev log, which is where
          // a bug report collects them from.
          //
          // Never retryable: the same input reaches the same broken line, and
          // each attempt pays for the model call the stage made on the way
          // there. Twenty-seven identical failures over four attempts each is
          // what that costs when it is left in the generic branch.
          console.error(
            `[scheduler] internal fault in stage '${stage.id}' (job ${job.id}, work ${planCtx.workId}):`,
            err
          )
          logStageFault({
            stage: stage.id,
            jobId: job.id,
            workId: planCtx.workId,
            message: msg,
            stack: err instanceof Error ? err.stack : undefined
          })
          const title = subject.work?.title === undefined ? undefined : plainText(subject.work.title)
          outcome = {
            status: 'failed',
            error:
              `‘${stage.label}’ hit a fault inside Corpus Studio` +
              (title ? ` on “${title}”` : '') +
              '. This is a bug in the app, not something wrong with the paper, and ' +
              'retrying will not help. The technical detail is in the app log.',
            retryable: false
          }
        } else {
          outcome = {
            status: 'failed',
            error: msg,
            retryable: !signal.aborted,
            retryAfterMs: retryAfterOf(err)
          }
        }
      }
    }

    if (signal.aborted) {
      // Return WITHOUT a terminal write. `cancel()` already wrote the row,
      // superseded this run, deleted its output and refunded the attempt — and
      // it bumped the RUN's `lease_epoch`, so `finishRun` would reject anything
      // written here anyway. This return is the cheap path, not the guarantee.
      return
    }

    // An `empty` or `refused` with no reason is indistinguishable from a
    // swallowed bug, and these are the outcomes that are cached, satisfy or
    // stop dependents, and are invisible. Coerce to a failure so a segmentation
    // bug cannot present as "this paper legitimately has no prose", and an
    // abstention can never be filed without saying what it declined to do —
    // which is the entire content of an abstention.
    if (
      (outcome.status === 'empty' || outcome.status === 'refused') &&
      outcome.reason.trim() === ''
    ) {
      outcome = {
        status: 'failed',
        error: `stage '${stage.id}' returned '${outcome.status}' with no reason`,
        retryable: false
      }
    }

    // `not-needed` becomes a plain success HERE, before anything downstream
    // looks at it, so exactly one line in this file knows the mapping and the
    // commit path, `finishRun`, the settle switch and every renderer read see
    // an ordinary `succeeded`.
    //
    // It IS one: the stage decided the right amount of work was none, and OCR
    // declining a PDF that already has a text layer is the stage doing its job
    // rather than failing to. Storing it as a fifth outcome would need a
    // migration and would then have to be special-cased back into "this is
    // fine" at every read site.
    //
    // The reason survives as the run's note, so "why did OCR not run on this
    // paper" stays answerable from the row. It is recorded, not announced —
    // which is the whole distinction being drawn.
    //
    // `result: null` writes no artifact, and that is what keeps a transformer
    // transparent: `resolveInput` walks past a provider run that produced
    // nothing, so `segment` still sees `extract-text`'s pages exactly as it did
    // when this outcome was `skipped`.
    if (outcome.status === 'not-needed') {
      outcome = { status: 'succeeded', result: null, note: outcome.reason }
    }

    const durationMs = Date.now() - startedMs
    const note =
      outcome.status === 'succeeded'
        ? (outcome.note ?? null)
        : outcome.status === 'failed'
          ? null
          : outcome.reason

    // `skipped` means "I did not run at all": a precondition was absent, so
    // nothing was computed and there is nothing to write. A stage that queued
    // rows and then says that is contradicting itself, and dropping the rows
    // silently would leave the contradiction undetectable.
    //
    // `empty` and `refused` are NOT in that set, and the distinction is real
    // rather than pedantic. Both mean the stage RAN. `empty` is "I ran and part
    // of the answer is that there is nothing"; `refused` is "I ran, and I am
    // declining to state part of the answer because I would have to guess".
    // Either can legitimately have produced output for the part it IS willing
    // to stand behind. `citation-contexts` writes one bibliography row per
    // reference — the only surviving home for a resolved reference's printed
    // text — and then refuses the callout LINKING, which is a separate claim.
    // Both halves are true, the rows are owned by a terminal `stage_run` the
    // cascade can find, and forcing a choice between them would either destroy
    // the raw text or misreport an abstention as a successful linking.
    if (outcome.status === 'skipped' && pendingWrites.length > 0) {
      outcome = {
        status: 'failed',
        error:
          `stage '${stage.id}' queued ${pendingWrites.length} write(s) and then returned ` +
          `'${outcome.status}' — output and outcome disagree`,
        retryable: false
      }
    }

    if (pendingWrites.length > 0 && !stage.applyWrites) {
      outcome = {
        status: 'failed',
        error: `stage '${stage.id}' queued ${pendingWrites.length} write(s) but declares no applyWrites`,
        retryable: false
      }
    }

    // Bulk output and the terminal record commit TOGETHER. Split across two
    // transactions, a stop between them would discard completed work on resume
    // and "the blast radius of any stop is one stage" would be false.
    //
    // A PERMANENT failure commits its rows as well. The rows a stage queues
    // before failing are its record of WHAT WENT WRONG, written on the SUBJECT
    // rather than on the job — `retrieve` marks the document
    // `retrieval_status = 'failed'` so "no PDF could be fetched for this paper"
    // survives the job row being retried, dismissed or swept. It is the same
    // fact the run reports, in the place the Paper screen reads it; dropping it
    // left that screen saying the fetch had never been tried on a paper every
    // source had already declined.
    //
    // PERMANENT only. A retryable failure will run again, and rows committed by
    // an attempt that is about to be repeated would be written twice.
    const failedPermanently =
      outcome.status === 'failed' && (!outcome.retryable || job.attempts >= MAX_ATTEMPTS)

    let committed = false
    try {
      this.db.transaction((): void => {
        // `empty` and `refused` commit their rows too — see the note above; a
        // stage that ran may legitimately have produced output for the part it
        // stands behind while reporting nothing, or declining, for the rest.
        if (
          outcome.status === 'succeeded' ||
          outcome.status === 'empty' ||
          outcome.status === 'refused' ||
          failedPermanently
        ) {
          const writeCtx = {
            workId: planCtx.workId,
            documentId: planCtx.documentId,
            projectId: planCtx.projectId,
            stageRunId,
            fanOut: fan
          }
          for (const payload of pendingWrites) {
            const published = (stage.applyWrites as NonNullable<typeof stage.applyWrites>)(
              this.db,
              payload,
              writeCtx
            )
            for (const [cap, value] of published ?? []) {
              if (!stage.provides.includes(cap)) {
                throw new Error(
                  `stage '${stage.id}' published '${cap}' from applyWrites, ` +
                    'which it does not declare providing'
                )
              }
              emitted.set(cap, value)
            }
          }
          for (const [cap, value] of emitted) writeArtifact(this.db, stageRunId, cap, value)
        }
        const fenced = finishRun(this.db, {
          stageRunId,
          leaseEpoch: job.lease_epoch,
          status: outcome.status,
          note,
          error: outcome.status === 'failed' ? outcome.error.slice(0, 500) : null,
          result: outcome.status === 'succeeded' ? outcome.result : undefined,
          durationMs,
          now: this.now(),
          provenance: outcome.status === 'succeeded' ? outcome.provenance : undefined
        })
        // THROW, so the bulk writes above roll back with it. Returning false
        // here left them committed against a run that never reached a terminal
        // state — rows nothing owns, which the supersede cascade cannot find to
        // delete and the next run collides with.
        if (!fenced) throw new StaleExecutionError()
        committed = true
      }).immediate()
    } catch (err) {
      if (err instanceof StaleExecutionError) {
        // This execution is stale: its job was reclaimed and re-dispatched, or
        // cancelled. Discard everything rather than clobbering the
        // replacement's terminal record.
        return
      }
      // A write that throws is the stage's failure, not the scheduler's. Record
      // it as one instead of letting it escape as an uncaught scheduler error,
      // which would report the job as transiently broken forever.
      const msg = err instanceof Error ? err.message : String(err)
      this.settle(job, {
        status: job.attempts >= MAX_ATTEMPTS ? 'failed' : 'queued',
        outcome: null,
        note: null,
        error: `applying '${stage.id}' writes failed: ${msg}`.slice(0, 500),
        errorKind: 'transient'
      })
      // FENCED like every other write to this row. Without the epoch term a
      // dying execution stamps `failed` onto a run that a re-run has already
      // retired and handed to a replacement, and the replacement's own run then
      // reads as failed for a reason that belongs to a run nobody can see.
      this.db
        .prepare(
          `UPDATE stage_run SET status = 'failed', error = ?, finished_at = ?
            WHERE id = ? AND lease_epoch = ? AND status = 'running'`
        )
        .run(msg.slice(0, 500), this.now(), stageRunId, job.lease_epoch)
      return
    }
    if (!committed) return

    if (stage.scope === 'corpus') {
      // The sweep read its work set when it started. Anything that woke it
      // since then is unswept, so it must run again — the counter is the only
      // record of a wakeup the singleton index refused to insert.
      const started = this.sweepStartedAt.get(stage.id) ?? 0
      if ((this.sweepGeneration.get(stage.id) ?? 0) > started) this.wakeCorpusSweeps()
    }
    // A SEPARATE test, not an `else`, because a corpus sweep can be another
    // corpus sweep's producer: `resolve-references` promotes an unresolved
    // reference to a real edge, which mints citing passages for
    // `verify-citations` to check without either paper's document changing.
    // Folded into the branch above, that event woke nothing at all, and the
    // promoted citations were verified only if some unrelated import happened
    // to wake the sweep later. Derived from what the corpus stages REQUIRE, so
    // a future sweep over a different token wakes on the right event without
    // editing this line.
    if (stage.provides.some((c) => this.corpusSweepInputs().has(c))) {
      this.wakeCorpusSweeps()
    }

    switch (outcome.status) {
      case 'succeeded':
        this.settle(job, { status: 'done', outcome: 'succeeded', note, error: null, errorKind: null })
        break
      case 'empty':
        // `review`, not `done`. An empty result is a claim about the paper a
        // human may want to check; a silently green blank paper is the worst
        // failure this pipeline can have.
        this.settle(job, { status: 'review', outcome: 'empty', note, error: null, errorKind: null })
        break
      case 'skipped':
        this.settle(job, { status: 'done', outcome: 'skipped', note, error: null, errorKind: null })
        break
      case 'refused':
        // `review`, for the same reason `empty` is: an abstention is a claim
        // about the paper that a human may want to check, and it is the one
        // outcome the user is most likely to want to overrule. Settling it
        // `done` would file "I declined to answer" under "finished" — quieter
        // than the state it replaced, which is the wrong direction for the
        // change that made these papers honest.
        this.settle(job, { status: 'review', outcome: 'refused', note, error: null, errorKind: null })
        this.cancelDependents(
          job.id,
          stage.id,
          `upstream stage '${stage.id}' declined to produce this, so there is nothing to work from`
        )
        break
      case 'failed': {
        const permanent = !outcome.retryable || job.attempts >= MAX_ATTEMPTS
        this.settle(job, {
          status: permanent ? 'failed' : 'queued',
          outcome: null,
          note: null,
          error: outcome.error.slice(0, 500),
          // A permanent failure reports ITS OWN cause, never "exceeded max
          // attempts" — the ceiling is not why a non-retryable stage failed.
          errorKind: outcome.retryable ? 'transient' : 'permanent',
          // A deliberate non-retryable refusal did not consume an attempt in
          // any meaningful sense, and letting it count would make the ceiling
          // message the reported cause of the next run.
          refundAttempt: !outcome.retryable,
          // The SERVER's wait wins over ours when it named one. Our exponential
          // curve is a guess about an unknown condition; `retryAfter` is the
          // limiter stating the actual window, and retrying inside it simply
          // spends attempts to be told the same thing again.
          backoffMs: outcome.retryable
            ? Math.max(outcome.retryAfterMs ?? 0, 2 ** Math.min(job.attempts, 6) * 250)
            : undefined
        })
        if (permanent) this.cancelDependents(job.id, stage.id)
        break
      }
    }
  }

  /**
   * Cascade to dependents when a job cannot satisfy them.
   *
   * They are CANCELLED, not failed: retrying the root and re-planning should
   * re-queue them, and `error_kind = 'upstream'` keeps them distinguishable
   * from a job the user cancelled by hand.
   */
  /**
   * Stop everything waiting on a stage that will never produce what they need.
   *
   * `reason` is the ROOT's own, because the two callers mean different things.
   * A refusal DID complete — it ran and declined — so reporting "did not
   * complete" to its dependents states the opposite of what happened, and it is
   * the message the user reads when they ask why a paper stopped.
   *
   * Cancelling is nonetheless correct for a refusal: `resolveInput` treats a
   * refused run as producing no capability, so a dependent left queued would
   * wait for an input that is never coming.
   */
  private cancelDependents(jobId: number, rootStage: string, reason?: string): void {
    const now = this.now()
    this.db.transaction(() => {
      const frontier = [jobId]
      const seen = new Set<number>([jobId])
      while (frontier.length > 0) {
        const id = frontier.pop() as number
        const dependents = this.db
          .prepare('SELECT job_id FROM job_dependency WHERE depends_on_job_id = ?')
          .all(id) as { job_id: number }[]
        for (const d of dependents) {
          if (seen.has(d.job_id)) continue
          seen.add(d.job_id)
          this.db
            .prepare(
              `UPDATE processing_job
                  SET status = 'cancelled', error_kind = 'upstream',
                      error = ?, finished_at = ?, updated_at = ?
                WHERE id = ? AND status IN ('queued','blocked','running')`
            )
            .run(
              reason ?? `upstream stage '${rootStage}' did not complete`,
              now,
              now,
              d.job_id
            )
          frontier.push(d.job_id)
        }
      }
    }).immediate()
    this.notify()
  }

  /**
   * The single terminal write for a job. Fenced on `lease_epoch`, and the ONLY
   * place `attempts` is refunded, so pause, quit and cancel cannot each
   * decrement it and drift a crash-looping job below the ceiling forever.
   */
  private settle(
    job: JobRow,
    input: {
      status: string
      outcome: 'succeeded' | 'empty' | 'skipped' | 'refused' | null
      note: string | null
      error: string | null
      errorKind: string | null
      refundAttempt?: boolean
      backoffMs?: number
      cached?: boolean
    }
  ): void {
    const now = this.now()
    const terminal = input.status !== 'queued'
    const trace = this.traceByJob.get(job.id)
    if (trace) {
      // The OUTCOME, not the job status, when there is one: `empty` and
      // `refused` both file as `review`, and collapsing them here would erase
      // the distinction between "the paper has nothing" and "we declined to
      // say" — the pair this whole log exists to tell apart.
      trace.status = input.outcome ?? input.status
      trace.note = input.note
      trace.error = input.error
      trace.cached = input.cached ?? false
    }
    try {
      const info = this.db
        .prepare(
          `UPDATE processing_job
              SET status = ?, outcome = ?, outcome_note = ?, error = ?, error_kind = ?,
                  attempts = CASE WHEN ? = 1 AND attempts > 0 THEN attempts - 1 ELSE attempts END,
                  run_after = ?,
                  -- Always cleared: this job is no longer executing in this
                  -- generation whether it ended or went back to the queue, and
                  -- a row still naming a live owner is a row that resumePending
                  -- would decline to recover after a crash.
                  lease_owner = NULL, lease_expires_at = NULL,
                  finished_at = CASE WHEN ? = 1 THEN ? ELSE NULL END,
                  updated_at = ?
            WHERE id = ? AND lease_epoch = ?`
        )
        .run(
          input.status,
          input.outcome,
          input.note,
          input.error,
          input.errorKind,
          input.refundAttempt ? 1 : 0,
          input.backoffMs ? new Date(Date.now() + input.backoffMs).toISOString() : null,
          terminal ? 1 : 0,
          now,
          now,
          job.id,
          job.lease_epoch
        )
      // The one non-terminal outcome of an execution: the stage threw or
      // reported a retryable failure and the job goes back on the queue to be
      // claimed again. Named here because it is otherwise indistinguishable in
      // the log from a job that never ran — the queue simply grows by one.
      if (!terminal) {
        logRearm('stage:transient', info.changes, {
          workId: job.work_id,
          stage: job.stage,
          jobId: job.id,
          why: `attempt ${job.attempts}/${MAX_ATTEMPTS}: ${(input.error ?? 'no error given').slice(0, 120)}`
        })
      }
    } catch (err) {
      // Losing this write during shutdown is expected and safe — the row stays
      // 'running', which is exactly what `resumePending` recovers. Logged, not
      // silent, so the same catch cannot hide a real constraint bug as a job
      // that mysteriously re-runs every launch.
      // eslint-disable-next-line no-console
      console.error('[scheduler] terminal status write failed:', err)
    }
  }

  // ---------------------------------------------------------------- corpus sweeps
  /** Every capability a corpus-scoped stage consumes. Cheap; the set is tiny. */
  private corpusSweepInputs(): Set<Capability> {
    const out = new Set<Capability>()
    for (const { stage } of this.registry.order) {
      if (stage.scope !== 'corpus') continue
      for (const cap of inputsOf(stage)) out.add(cap)
    }
    return out
  }

  /**
   * Wake every corpus-scoped stage, coalesced.
   *
   * GENERAL, not a special case for one stage: the scheduler asks the registry
   * which stages are corpus-scoped and treats them all the same way. A
   * hardcoded `if (stage.id === 'resolve-references')` here would make the
   * SEVENTH stage harder to add than the sixth, which is the property this
   * pipeline is built to keep.
   *
   * Debounced, because ingesting 50 papers must schedule ONE sweep rather than
   * fifty; and generation-counted, because a wakeup arriving while the sweep is
   * already running would otherwise be swallowed by the singleton's
   * `ON CONFLICT DO NOTHING` — the running sweep has already read its work set,
   * so a bibliography parsed during it would never be swept at all.
   */
  wakeCorpusSweeps(): void {
    for (const { stage } of this.registry.order) {
      if (stage.scope !== 'corpus') continue
      this.sweepGeneration.set(stage.id, (this.sweepGeneration.get(stage.id) ?? 0) + 1)
    }
    if (this.sweepDebounce) return
    this.sweepDebounce = setTimeout(() => {
      this.sweepDebounce = null
      if (this.stopped) return
      const ids = planCorpusSweeps(this.db, this.registry, this.now())
      if (ids.length > 0 && this.running) this.scheduleTick(0)
      if (ids.length > 0) this.notify()
    }, SWEEP_DEBOUNCE_MS)
    if (typeof this.sweepDebounce.unref === 'function') this.sweepDebounce.unref()
  }

  // ---------------------------------------------------------------- mutations
  /**
   * Plan a work's pipeline, resolving its preferred document itself.
   *
   * The entry point for callers that hold a work and not a document — ingest,
   * and reference retrieval. It replaces the old free-form `enqueue(jobType,
   * payload)`, which let any caller invent a job type that the queue then
   * routed to one generic title+abstract analysis regardless of what was asked
   * for. A job is a STAGE now, so what runs is decided by the registry rather
   * than by a string a caller happened to pass.
   *
   * Returns EVERY job of the pipeline in dependency order — including ones a
   * previous plan already created. A caller linking a row to "the job that
   * stands for this paper" gets an answer on a re-plan too; returning only the
   * newly inserted ids gave `[]` there, and a caller defaulting that to 0 wrote
   * a link to a job that does not exist.
   */
  planForWork(workId: number, projectId: number): number[] {
    const doc = this.db
      .prepare(
        'SELECT id FROM document WHERE work_id = ? ORDER BY is_preferred DESC, id LIMIT 1'
      )
      .get(workId) as { id: number } | undefined
    const res = planPipeline(
      this.db,
      this.registry,
      {
        workId,
        documentId: doc?.id ?? 0,
        projectId,
        // A PROJECT STILL BEING SET UP GETS THE PDF AND ITS TEXT, NOTHING MORE.
        //
        // Someone adding their starting papers is waiting at a form, watching
        // each row, and the full pipeline made them wait for work the form does
        // not need: measured on this corpus, `schema-extract` averages 79s (one
        // run took 17 minutes) and `review-records` 53s, against about ten
        // seconds to fetch a paper and read its text. So a row sat on
        // "Reading…" for minutes after the paper had, in every sense the user
        // cared about, arrived.
        //
        // The rest is not cancelled or skipped — it is simply not planned yet,
        // and `finishProjectSetup` plans it for every paper once the user is
        // through. Deferred, not lost.
        onlyStages: onboardingStages(this.db, projectId)
      },
      this.now()
    )
    this.wakeCorpusSweeps()
    if (this.running) this.scheduleTick(0)
    this.notify()
    return res.allJobIds
  }

  /**
   * Plan every registered stage for a work. Idempotent: re-planning is a no-op.
   *
   * `onlyStages` narrows it to named stages, for reaching a stage that was added
   * after this paper was processed without re-arming the settled jobs beside it.
   */
  plan(input: {
    workId: number
    documentId: number
    projectId: number
    onlyStages?: readonly string[]
  }): number[] {
    const res = planPipeline(this.db, this.registry, input, this.now())
    // A new paper is a corpus event: it may resolve dangling references in
    // papers that cited it long before it arrived.
    this.wakeCorpusSweeps()
    if (this.running) this.scheduleTick(0)
    this.notify()
    return res.jobIds
  }

  /**
   * Re-plan ONE stage across a project, after a setting decided whether it
   * applies at all.
   *
   * A stage whose `fanOut` is empty is not planned, so the queue follows the
   * setting the moment it changes rather than at the next unrelated import:
   * connecting Zotero gives every paper already in the project its push job,
   * and disconnecting takes the outstanding ones away again.
   *
   * The withdrawal is a CANCEL, not a delete: a job that ran belongs to the
   * history whatever the user later switched off, and cancelling says the queue
   * stopped waiting on it. Only jobs with nothing to report are touched — a
   * settled row is a record of something that happened, and the setting cannot
   * unhappen it.
   *
   * `onlyStages` keeps this off every other job of every paper. Re-planning the
   * whole pipeline here would re-arm settled work across the corpus for the sake
   * of one toggle.
   */
  replanProjectStage(projectId: number, stageId: string): void {
    if (projectId <= 0) return
    if (!this.registry.order.some((s) => s.stage.id === stageId)) {
      throw new Error(`no such stage: ${stageId}`)
    }
    const now = this.now()
    const works = this.db
      .prepare('SELECT work_id FROM project_work WHERE project_id = ?')
      .all(projectId) as Array<{ work_id: number }>

    this.db.transaction(() => {
      /** The jobs the stage still wants, which is what makes the rest surplus. */
      const kept = new Set<number>()
      for (const { work_id } of works) {
        const documentId = this.preferredDocument(work_id)
        if (documentId <= 0) continue
        const res = planPipeline(
          this.db,
          this.registry,
          { workId: work_id, documentId, projectId, onlyStages: [stageId] },
          now
        )
        for (const id of res.allJobIds) kept.add(id)
      }

      // Everything else this stage holds in the project is withdrawn: a job the
      // fan-out no longer produces has nothing left to run for. Read as "not
      // planned this time" rather than from the setting itself, so the stage
      // stays the only thing that decides when it applies — the scheduler is not
      // told what Zotero is.
      const surplus = (
        this.db
          .prepare(
            `SELECT id FROM processing_job
              WHERE stage = ? AND project_id = ?
                AND status IN ('queued','blocked') AND outcome IS NULL`
          )
          .all(stageId, projectId) as Array<{ id: number }>
      )
        .map((r) => r.id)
        .filter((id) => !kept.has(id))

      if (surplus.length === 0) return
      // CANCELLED, not deleted: the row is the record that the queue held this
      // step and stopped waiting on it. A settled job is excluded above, because
      // a run that happened cannot be un-happened by a setting.
      const cancel = this.db.prepare(
        `UPDATE processing_job
            SET status = 'cancelled', error_kind = 'cancelled',
                error = 'this project no longer runs this step',
                cancel_requested = 1, lease_owner = NULL, lease_expires_at = NULL,
                finished_at = ?, updated_at = ?
          WHERE id = ?`
      )
      for (const id of surplus) cancel.run(now, now, id)
    }).immediate()

    if (this.running) this.scheduleTick(0)
    this.notify()
  }

  retry(jobId: number): void {
    const row = this.db
      .prepare('SELECT status, stage, work_id FROM processing_job WHERE id = ?')
      .get(jobId) as { status: string; stage: string | null; work_id: number | null } | undefined
    if (!row) throw new Error(`job ${jobId} not found`)
    // `review` IS retryable, and leaving it out stranded papers with no way
    // forward. A refused stage settles as `review`, not `failed` — correctly, it
    // is a deliberate stop rather than a fault — but that also put it outside
    // every retry path at once: the per-row button, the bulk "retry all" and
    // `job_retry` over MCP all end here. A corpus of papers refused for want of
    // an identifier the app could since resolve had no way to be asked again
    // except by deleting and re-importing each one.
    //
    // Retrying a refusal is not pointless, because the WORLD changes: an
    // identifier gets added, a PDF is dropped in, a paywalled paper appears on a
    // preprint server, a bug that hid the arXiv scheme is fixed. If the reason
    // still holds the stage simply refuses again, which costs one cheap run and
    // is exactly what the user asked to find out.
    if (row.status !== 'failed' && row.status !== 'cancelled' && row.status !== 'review') {
      throw new Error(
        `job ${jobId} is ${row.status}, only failed/cancelled/review can be retried`
      )
    }
    const now = this.now()
    this.db.transaction(() => {
      // RETIRE THE CACHED VERDICT, or this whole method is theatre.
      //
      // `refused`, `skipped` and `empty` are CACHEABLE (`stageRun.ts`), and a
      // cache hit is decided by the input fingerprint ALONE. Re-queueing the job
      // therefore did not re-run the stage: the claim recomputed the same
      // fingerprint, found the stored refusal still current, and settled the job
      // straight back without asking anything. The comment above promises the
      // opposite — "the stage simply refuses again, which costs one cheap run" —
      // and that run never happened.
      //
      // Measured on w#56 (`retrieve`, refused, `ids=doi=…|file=0|ret=1`): every
      // input the fingerprint covers is identical before and after the press, so
      // the button was inert BY CONSTRUCTION and no amount of pressing it could
      // reach the retriever. The paper was unrecoverable except by deleting and
      // re-importing it — the exact dead end the `review` case above was added
      // to remove.
      //
      // Superseded rather than deleted: the refusal is a real historical answer
      // with a real reason, and the provenance rules keep superseded runs. What
      // it may no longer do is answer for a future claim.
      //
      // ONLY this job's own stage, and only a CACHEABLE status. A `failed` run is
      // not a cache hit in the first place, so retiring it would discard history
      // to no effect; the dependents revived below re-decide their own caches
      // from their own fingerprints, which now genuinely change because this
      // stage is about to produce a new run.
      const retired = this.db
        .prepare(
          `UPDATE stage_run
              SET superseded = 1, superseded_by = NULL
            WHERE id = (
              SELECT sr.id FROM stage_run sr
                JOIN processing_job pj ON pj.stage = sr.stage
                 AND pj.work_id = sr.work_id
               WHERE pj.id = ? AND sr.superseded = 0
                 AND sr.status IN ('refused','skipped','empty')
               ORDER BY sr.id DESC LIMIT 1
            )`
        )
        .run(jobId)
      if (retired.changes > 0) {
        logRearm('user:retry:uncache', retired.changes, {
          workId: row.work_id,
          stage: row.stage,
          jobId,
          why: 'retired a cacheable verdict so the stage really runs'
        })
      }
      // Attempts reset to 0: a retry the user asked for starts the budget
      // again. Carrying the count over would let a sixth attempt re-fail
      // instantly with "exceeded max attempts", reporting the ceiling as the
      // cause of a failure they were explicitly trying to get past.
      const self = this.db
        .prepare(
          `UPDATE processing_job
              SET status = 'queued', attempts = 0, cancel_requested = 0,
                  error = NULL, error_code = NULL, error_kind = NULL,
                  outcome = NULL, outcome_note = NULL, run_after = NULL,
                  lease_owner = NULL, stage_run_id = NULL,
                  started_at = NULL, finished_at = NULL, updated_at = ?
            WHERE id = ?`
        )
        .run(now, jobId)
      logRearm('user:retry', self.changes, {
        workId: row.work_id,
        stage: row.stage,
        jobId,
        why: `was=${row.status}`
      })
      // Dependents cancelled BY this job's failure are re-queued with it;
      // otherwise retrying the root fixes nothing the user can see.
      //
      // TRANSITIVELY, through the whole dependency graph. A one-hop revival
      // stops at the stages that name THIS job, and the pipeline is a chain:
      // for a refused `retrieve`, the direct dependents are `download` and
      // `optimize`, while `extract-text` depends on THOSE. Measured on a real
      // paper (w#48): retrieve/download/optimize succeeded on retry at 21:50,
      // and extract-text and the eight stages behind it still carried a
      // cancellation written at 21:43 blaming an upstream refusal that had since
      // been reversed. The paper had a 3.3 MB PDF and never got read, and no
      // amount of pressing Retry could reach those rows — the edge they needed
      // pointed at a job that was not being retried.
      //
      // Walked with a recursive CTE rather than a loop of queries: it is one
      // statement inside the same transaction, so no other writer can see a
      // half-revived pipeline.
      //
      // Only the newest row on each `job_key`. `job_dependency` edges outlive
      // their jobs and a key can hold many terminal rows, so this set really can
      // contain an older row on a key whose newest row is already live —
      // reviving it puts two live rows on one key and `ux_processing_job_live`
      // throws, turning a retry the user asked for into an error.
      const dependentSql = `status = 'cancelled' AND error_kind = 'upstream'
              AND id IN (
                WITH RECURSIVE downstream(id) AS (
                  SELECT ?
                  UNION
                  SELECT d.job_id FROM job_dependency d
                    JOIN downstream ON d.depends_on_job_id = downstream.id
                )
                SELECT id FROM downstream
              )
              AND (processing_job.job_key IS NULL
                   OR processing_job.id =
                      (SELECT MAX(k.id) FROM processing_job k
                        WHERE k.job_key = processing_job.job_key))`
      const dependents = this.db
        .prepare(`SELECT stage FROM processing_job WHERE ${dependentSql}`)
        .all(jobId) as Array<{ stage: string | null }>
      const cascade = this.db
        .prepare(
          `UPDATE processing_job
              SET status = 'queued', error = NULL, error_kind = NULL,
                  finished_at = NULL, updated_at = ?
            WHERE ${dependentSql}`
        )
        .run(now, jobId)
      logRearm('cascade:upstream', cascade.changes, {
        workId: row.work_id,
        stage: summarize(dependents.map((d) => d.stage)),
        why: `dependents of job=${jobId} (user retry)`
      })
    }).immediate()
    if (this.running) this.scheduleTick(0)
    this.notify()
  }

  cancel(jobId: number): void {
    const row = this.db
      .prepare('SELECT status, stage, stage_run_id, lease_epoch FROM processing_job WHERE id = ?')
      .get(jobId) as
      | { status: string; stage: string | null; stage_run_id: number | null; lease_epoch: number }
      | undefined
    if (!row) throw new Error(`job ${jobId} not found`)
    if (row.status === 'cancelled') return
    const now = this.now()

    this.db.transaction(() => {
      // Bumping the epoch is what makes the cancel authoritative: an execution
      // still running when this lands can no longer commit its terminal write,
      // so it cannot put back the rows the cascade is about to delete.
      this.db
        .prepare(
          `UPDATE processing_job
              SET cancel_requested = 1, status = 'cancelled', error_kind = 'cancelled',
                  lease_epoch = lease_epoch + 1, lease_owner = NULL,
                  lease_expires_at = NULL,
                  -- The attempt is refunded HERE because this is the only write
                  -- that can reach the row: the epoch bump above fences out the
                  -- executor's own terminal write, so a job the user cancels
                  -- five times must not retire as "exceeded max attempts"
                  -- having never once errored.
                  attempts = CASE WHEN status = 'running' AND attempts > 0
                                  THEN attempts - 1 ELSE attempts END,
                  finished_at = ?, updated_at = ?
            WHERE id = ?`
        )
        .run(now, now, jobId)
      // Synchronously, not deferred to the next launch: a killed run left
      // holding ux_stage_run_current makes its OWN retry fail on the unique
      // index.
      //
      // The delete and the supersede carry the SAME `status = 'running'` guard,
      // because they must be one decision. Deleting unconditionally would let a
      // cancel arriving after a run had already succeeded strip that run's
      // paragraphs and contexts while leaving it `superseded = 0` — a permanent
      // cache hit over output that is gone, which is worse than either doing
      // both or doing neither. `cancel` is reachable for a terminal job: the
      // IPC handler accepts any id.
      if (row.stage_run_id != null) {
        // The RUN's epoch is bumped, not only the job's. `finishRun` fences on
        // the run's, and the executor captured its value at claim — so this is
        // what actually stops a stage that is still executing from committing
        // onto the row just retired here. Bumping the job's epoch alone leaves
        // that window guarded by nothing but the executor's own courtesy check
        // of `signal.aborted`.
        // `status` moves with `finished_at`: a row saying it is executing AND
        // saying when it ended describes nothing that can happen. The run was
        // cancelled, which for a stage is a failure to produce — its output is
        // deleted on the next line — so `failed` is what is true of it, and the
        // error says the user stopped it rather than leaving a reader of the
        // history to guess.
        const retired = this.db
          .prepare(
            `UPDATE stage_run
                SET superseded = 1, finished_at = ?, lease_epoch = lease_epoch + 1,
                    status = 'failed',
                    error = COALESCE(error, 'cancelled while running')
              WHERE id = ? AND status = 'running'`
          )
          .run(now, row.stage_run_id)
        if (retired.changes > 0) deleteRunOutput(this.db, row.stage_run_id)
      }
    }).immediate()

    // AFTER the transaction, never before: the epoch bump above is what stops
    // the dying execution committing over the rows the cascade just removed, so
    // killing first would open exactly the window it closes. The abort reaches
    // an inline stage's signal and, for a host-isolated one, the pool's abort
    // handler — which kills the child, because a stage wedged inside a
    // synchronous native call cannot observe a signal at all.
    this.abortsByJob.get(jobId)?.abort()
    this.cancelDependents(jobId, row.stage ?? row.status)
    this.notify()
  }

  /**
   * Re-run a TERMINAL stage run.
   *
   * `retry` accepts only failed/cancelled and a re-plan hits the cache, so
   * without this there is no way at all to re-run an `empty` or a `skipped` —
   * exactly the outcomes a user is most likely to disbelieve.
   */
  forceRerun(stageRunId: number): number {
    const run = this.db
      .prepare(
        `SELECT stage, work_id, document_id, project_id, schema_id, fanout_key, superseded
           FROM stage_run WHERE id = ?`
      )
      .get(stageRunId) as
      | {
          stage: string
          work_id: number
          document_id: number
          project_id: number
          schema_id: number
          fanout_key: string
          superseded: number
        }
      | undefined
    if (!run) throw new Error(`stage_run ${stageRunId} not found`)

    const retired = supersedeCascade(
      this.db,
      this.registry,
      {
        stage: run.stage,
        workId: run.work_id,
        documentId: run.document_id,
        projectId: run.project_id,
        schemaId: run.schema_id,
        fanoutKey: run.fanout_key
      },
      this.now()
    )

    // Re-planned for EVERY project the cascade touched, not just this one.
    //
    // The cascade walks downstream across all projects on purpose: a re-segment
    // changes the characters every `citation-contexts` offset indexes and every
    // `schema-extract` quote is anchored in, and that is true of the row no
    // matter whose project it was extracted for. But planning is project-scoped
    // (`planner.ts` files a project stage under `input.projectId`), so planning
    // only the origin's project deletes another project's extraction and then
    // schedules nothing to redo it — output invalidated with no path back,
    // which is precisely what §3 forbids of a supersede.
    //
    // The projects are read back from the rows the cascade actually retired
    // rather than from a list of every project, so a re-run enqueues work only
    // where something was really taken away.
    //
    // 0 is the corpus/global sentinel and is NEVER a planning target, the same
    // rule `rerunRuns` already applies. Planning project 0 runs the WHOLE
    // pipeline under a project that does not exist: a project-scoped stage is
    // then filed in a different `ux_stage_run_current` slot from its real one,
    // so two runs are current at once — and `schema-extract` in particular asks
    // `listProjectSchemas(0)`, gets nothing, fires its no-schema sentinel, and
    // gives every paper a second schema-less extraction nobody asked for.
    //
    // A retired project-0 row is a WORK-scoped stage (`segment`, `ocr`,
    // `extract-text`), and re-running it does have to reach the projects that
    // read this work downstream. Those are the projects the work is actually a
    // member of — not project 0, and not every project in the database.
    const projectIds = new Set<number>()
    const addProject = (id: number): void => {
      if (id > 0) projectIds.add(id)
    }
    const projectsHoldingWork = (): number[] =>
      (
        this.db
          .prepare('SELECT project_id FROM project_work WHERE work_id = ?')
          .all(run.work_id) as Array<{ project_id: number }>
      ).map((r) => r.project_id)

    if (run.project_id !== 0) addProject(run.project_id)
    else for (const id of projectsHoldingWork()) addProject(id)

    if (retired.length > 0) {
      const holes = retired.map(() => '?').join(',')
      for (const r of this.db
        .prepare(`SELECT DISTINCT project_id FROM stage_run WHERE id IN (${holes})`)
        .all(...retired) as Array<{ project_id: number }>) {
        if (r.project_id !== 0) addProject(r.project_id)
        else for (const id of projectsHoldingWork()) addProject(id)
      }
    }

    let planned = 0
    for (const projectId of projectIds) {
      planned += this.plan({
        workId: run.work_id,
        documentId: run.document_id,
        projectId
      }).length
    }
    return planned
  }

  // ------------------------------------------------------- re-run, as a whole
  /**
   * Requeue the jobs that owned runs the cascade just retired.
   *
   * MUST RUN INSIDE THE CALLER'S TRANSACTION, alongside the cascade, and this is
   * not a preference. `supersedeCascade` bumps each retired run's `lease_epoch`,
   * which fences the executor's `finishRun`; the executor then throws
   * `StaleExecutionError`, which `process` catches and returns from WITHOUT
   * settling. So the `processing_job` row is left `running` with a live
   * `lease_owner` — and `planPipeline` adopts a live row rather than planning
   * against it, so the re-plan that follows would enqueue NOTHING. The output is
   * destroyed with no path back, which is the one outcome a re-run may never
   * produce.
   *
   * Which statuses are taken:
   * - live → live cannot collide on `ux_processing_job_live`; the row already
   *   occupies its key, so nothing is inserted and no other row can hold it.
   * - `done` and `review` are re-armed by the planner too, so this is belt and
   *   braces for them rather than the only path.
   * - `failed` and `cancelled` ARE requeued here, unlike anywhere else, and that
   *   is the difference between this and an ordinary re-plan. The planner
   *   refuses them on purpose — they are the user's to retry, and silently
   *   re-queueing a paper that failed four times hides the failure the Queue
   *   exists to show. But this path has just DELETED that job's output on an
   *   explicit instruction to redo it, so leaving the job terminal means output
   *   destroyed with nothing scheduled to replace it: the one outcome a re-run
   *   may never produce. The user asked; that is the difference.
   *
   * Adapted from `retry`, which is the only other place a terminal job is
   * legitimately put back, and not from `cancel`, whose whole purpose is to
   * leave a row the planner will not revive.
   *
   * Returns the ids requeued, so the caller can abort their executors.
   */
  private requeueOwningJobs(
    workId: number,
    retiredRunIds: number[],
    documentIds: Set<number>,
    now: string
  ): number[] {
    const holes = retiredRunIds.length > 0 ? retiredRunIds.map(() => '?').join(',') : 'NULL'
    const docHoles = documentIds.size > 0 ? [...documentIds].map(() => '?').join(',') : 'NULL'
    // The second term covers a job that is `running` with no run to point at:
    // one claimed by a PREVIOUS generation that never reached `beginRun`, or one
    // whose run this call has just cleared. Claim and `beginRun` are one
    // synchronous macrotask within a generation, so nothing can interleave
    // between them today — but a job left in that state by a crash would
    // otherwise sit `running` forever, invisible to a re-run that has just
    // deleted everything it was going to build on.
    //
    // SCOPED TO THE DOCUMENTS THIS RE-RUN TOUCHED, not to the whole work: a work
    // can hold several documents, and requeueing a running job of a document
    // this call never invalidated would abort a live model call for no reason at
    // all.
    const candidates = this.db
      .prepare(
        `SELECT id, job_key, status FROM processing_job
          WHERE stage_run_id IN (${holes})
             OR (work_id = ? AND status = 'running' AND stage_run_id IS NULL
                 AND document_id IN (${docHoles}))
          ORDER BY id DESC`
      )
      .all(...retiredRunIds, workId, ...documentIds) as Array<{
      id: number
      job_key: string | null
      status: string
    }>
    // AT MOST ONE ROW PER `job_key`, AND ONLY IF IT IS THE NEWEST ON THAT KEY.
    //
    // `ux_processing_job_live` is partial on non-terminal statuses, so terminal
    // rows are exempt and a key can legitimately hold several of them — real
    // corpora do, from before the planner learnt to adopt rather than insert.
    // Reviving two puts two live rows on one key and the UNIQUE index throws,
    // from inside the transaction that has already retired the runs.
    //
    // "Newest on the key" rather than "newest among the candidates", because the
    // planner that runs next in this same transaction looks the key up with
    // `ORDER BY id DESC LIMIT 1` and re-arms THAT row. Reviving an older one
    // here would hand it a second live row to collide with — and the candidate
    // set does not necessarily contain the newest, since only rows this re-run
    // touched are in it.
    const newestOnKey = this.db.prepare(
      'SELECT MAX(id) AS id FROM processing_job WHERE job_key = ?'
    )
    const claimedKeys = new Set<string>()
    const ids: number[] = []
    for (const row of candidates) {
      // A row with no `job_key` predates the key and contends with nothing, so
      // it is always its own case: the partial index is `WHERE job_key IS NOT
      // NULL` and cannot see it.
      if (row.job_key === null) {
        ids.push(row.id)
        continue
      }
      if (claimedKeys.has(row.job_key)) continue
      claimedKeys.add(row.job_key)
      if ((newestOnKey.get(row.job_key) as { id: number | null }).id !== row.id) continue
      ids.push(row.id)
    }
    if (ids.length === 0) return []
    const owningStages = this.db
      .prepare(
        `SELECT stage FROM processing_job WHERE id IN (${ids.map(() => '?').join(',')})`
      )
      .all(...ids) as Array<{ stage: string | null }>
    const owning = this.db
      .prepare(
        `UPDATE processing_job
            SET status = 'queued', attempts = 0, cancel_requested = 0,
                error = NULL, error_code = NULL, error_kind = NULL,
                outcome = NULL, outcome_note = NULL, run_after = NULL,
                lease_owner = NULL, lease_expires_at = NULL,
                -- Cleared because the run it names has just been retired: a job
                -- pointing at a superseded run reports a stage that no longer
                -- stands for anything, and the reclaim path clears it for the
                -- same reason.
                stage_run_id = NULL,
                -- The JOB's epoch too, not only the run's. settle() fences on
                -- it, so this is what stops the dying executor's own terminal
                -- write from landing on the row we have just requeued and
                -- marking the fresh attempt done.
                lease_epoch = lease_epoch + 1,
                started_at = NULL, finished_at = NULL, updated_at = ?
          WHERE id IN (${ids.map(() => '?').join(',')})`
      )
      .run(now, ...ids)
    logRearm('cascade:owner', owning.changes, {
      workId,
      stage: summarize(owningStages.map((r) => r.stage)),
      why: `owned ${retiredRunIds.length} retired run(s)`
    })
    return ids
  }

  /**
   * Requeue jobs that were cancelled only because something upstream failed.
   *
   * Mirrors `retry`'s dependent re-queue. Without it, re-running the stage that
   * failed fixes the stage and leaves everything it fed cancelled forever — the
   * user re-runs the root and sees nothing change, which is the complaint
   * `retry` already answers for a single job.
   */
  private requeueUpstreamCancelled(workId: number, triggerJobIds: number[], now: string): number[] {
    if (triggerJobIds.length === 0) return []
    const holes = triggerJobIds.map(() => '?').join(',')
    const rows = this.db
      .prepare(
        `SELECT id, job_key, stage FROM processing_job
          WHERE status = 'cancelled' AND error_kind = 'upstream' AND work_id = ?
            AND id IN (SELECT job_id FROM job_dependency WHERE depends_on_job_id IN (${holes}))`
      )
      .all(workId, ...triggerJobIds) as Array<{
      id: number
      job_key: string | null
      stage: string | null
    }>
    if (rows.length === 0) return []
    // ONE ROW PER KEY, AND ONLY THE NEWEST — the same rule `requeueOwningJobs`
    // follows, for the same reason. `job_dependency` edges outlive their jobs,
    // so this set legitimately contains OLD rows on a key, and by the time this
    // runs `planPipeline` has already re-armed the newest row on each key in
    // this very transaction. Reviving an older one puts two live rows on one key
    // and `ux_processing_job_live` throws, rolling the whole re-run back — so
    // the paper would be permanently unreprocessable rather than merely
    // unhelpful.
    const newestOnKey = this.db.prepare(
      'SELECT MAX(id) AS id FROM processing_job WHERE job_key = ?'
    )
    const ids = rows
      .filter(
        (r) =>
          r.job_key === null ||
          (newestOnKey.get(r.job_key) as { id: number | null }).id === r.id
      )
      .map((r) => r.id)
    if (ids.length === 0) return []
    const revived = this.db
      .prepare(
        `UPDATE processing_job
            SET status = 'queued', attempts = 0, error = NULL, error_kind = NULL,
                -- Cleared and bumped like every other revival here: the row
                -- names a run that no longer stands for it, and a dependent
                -- cancelled while it was RUNNING still has an executor that must
                -- be fenced out rather than merely asked to stop.
                stage_run_id = NULL, lease_owner = NULL, lease_expires_at = NULL,
                lease_epoch = lease_epoch + 1,
                started_at = NULL, finished_at = NULL, updated_at = ?
          WHERE id IN (${ids.map(() => '?').join(',')})`
      )
      .run(now, ...ids)
    logRearm('cascade:upstream', revived.changes, {
      workId,
      stage: summarize(rows.filter((r) => ids.includes(r.id)).map((r) => r.stage)),
      why: `dependents of job(s) ${summarize(triggerJobIds)}`
    })
    return ids
  }

  /** The document a work's pipeline is planned against, or 0 when it has none. */
  private preferredDocument(workId: number): number {
    const doc = this.db
      .prepare('SELECT id FROM document WHERE work_id = ? ORDER BY is_preferred DESC, id LIMIT 1')
      .get(workId) as { id: number } | undefined
    return doc?.id ?? 0
  }

  /**
   * Retire a set of current runs and re-plan everything they served.
   *
   * ONE TRANSACTION for the whole set, and one abort pass after it. Calling
   * `forceRerun` in a loop instead is safe only for as long as it stays
   * synchronous: a single `await` introduced between two iterations would let a
   * second caller re-resolve the same key in between, and `supersedeCascade`
   * re-resolves by KEY with no `superseded` check — so the second caller would
   * destroy the run the first had just created.
   *
   * `origins` are rows read in the same synchronous call as this one. Each is
   * re-checked for `superseded = 0` INSIDE the transaction; an id that is no
   * longer current is skipped and reported rather than followed, because
   * following it would retire whatever now holds its key.
   */
  private rerunRuns(
    workId: number,
    actingProjectId: number,
    originIds: number[]
  ): Omit<RerunOutcome, 'hadOrigins'> {
    const now = this.now()

    const result = this.db.transaction((): {
      superseded: number[]
      stale: number[]
      requeued: number[]
      projectIds: Set<number>
      createdJobIds: number[]
      allJobIds: number[]
    } => {
      const superseded: number[] = []
      const supersededSet = new Set<number>()
      const stale: number[] = []
      const projectIds = new Set<number>()
      // The DOCUMENTS the retired runs actually belonged to.
      //
      // NOT the work's preferred document. The cascade retires runs for the
      // origin's own `document_id`, and a work can hold several documents — so
      // planning the preferred one would delete a non-preferred document's
      // output and schedule nothing to redo it. Seeded with the preferred
      // document so a work with no current runs at all still plans the pipeline
      // it would have planned on import.
      const documentIds = new Set<number>([this.preferredDocument(workId)])
      // The (project, document) PAIRS to re-plan, not their cross product.
      //
      // A work can hold several documents and be read by several projects, and
      // the pairs that actually exist are a small subset: planning the product
      // would schedule downloads and model calls for combinations nobody ever
      // created. The pairs are collected from the rows the cascade really
      // retired, plus the one pair the caller asked for.
      const pairs = new Set<string>()
      const addPair = (project: number, document: number): void => {
        if (project <= 0) return
        // 0 IS THE SENTINEL ON BOTH AXES, and only the project half was guarded.
        //
        // A corpus-scoped run — `resolve-references`, `verify-citations` —
        // belongs to no paper and stores `document_id = 0`. When the cascade
        // retired one, the pair `(actingProject, 0)` was planned as though 0
        // were a real document, minting a SECOND, complete pipeline for the
        // paper: thirteen jobs keyed `w3:d0:p1:*` beside the paper's real
        // `w3:d3:p1:*` ones. `retrieve` then ran with `ctx.documentId = 0`, and
        // its `applyWrites` failed `FOREIGN KEY constraint failed` against a
        // document row that does not exist — four attempts each, for two papers,
        // reported to the user as "Fetch PDF · Failed".
        //
        // `preferredDocument` returns 0 for a work that has no document at all,
        // so it reaches here by that route too.
        if (document <= 0) return
        projectIds.add(project)
        documentIds.add(document)
        pairs.add(`${project}:${document}`)
      }
      // 0 is the corpus/global sentinel and is never a planning target: those
      // stages are woken by `wakeCorpusSweeps()` below, and planning a
      // project-scoped stage under project 0 would file it in a SEPARATE
      // `ux_stage_run_current` slot from its real one, leaving two runs current
      // at once. Only a real project id is ever planned for.
      addPair(actingProjectId, this.preferredDocument(workId))

      for (const id of originIds) {
        const run = this.db
          .prepare(
            `SELECT stage, work_id, document_id, project_id, schema_id, fanout_key, superseded
               FROM stage_run WHERE id = ?`
          )
          .get(id) as
          | {
              stage: string
              work_id: number
              document_id: number
              project_id: number
              schema_id: number
              fanout_key: string
              superseded: number
            }
          | undefined
        // Retired by a cascade EARLIER IN THIS LOOP is not stale — it is this
        // call's own work, already done. `reprocessWork(force)` hands over every
        // current run of the paper, and retiring the first cascades over most of
        // the rest; reporting those as a lost race would tell the agent another
        // client had interfered when nothing of the sort happened.
        if (supersededSet.has(id)) continue
        // Not found, or retired by something else between resolution and here —
        // another MCP client, the app window, the queue's own re-run. Skipped,
        // never followed: the cascade would resolve this row's KEY to whatever
        // is current NOW and destroy a run this caller never saw.
        if (!run || run.superseded === 1) {
          stale.push(id)
          continue
        }
        // The document this origin belongs to, paired with the project the
        // caller is acting for — a work-scoped run stores project 0, and the
        // caller's project is the one that asked for it to be redone.
        addPair(actingProjectId, run.document_id)
        const retired = supersedeCascade(
          this.db,
          this.registry,
          {
            stage: run.stage,
            workId: run.work_id,
            documentId: run.document_id,
            projectId: run.project_id,
            schemaId: run.schema_id,
            fanoutKey: run.fanout_key
          },
          now
        )
        for (const r of retired) {
          superseded.push(r)
          supersededSet.add(r)
        }
        // Every project the cascade actually touched, read back from the rows it
        // retired. The cascade walks downstream across ALL projects — a
        // re-segment changes the characters every other project's extraction is
        // anchored in — but planning is project-scoped, so planning only the
        // acting project would delete another project's output and schedule
        // nothing to redo it.
        if (retired.length > 0) {
          const holes = retired.map(() => '?').join(',')
          for (const r of this.db
            .prepare(
              `SELECT DISTINCT project_id, document_id FROM stage_run WHERE id IN (${holes})`
            )
            .all(...retired) as Array<{ project_id: number; document_id: number }>) {
            // A retired run of a project-scoped stage names both halves of a
            // real pair. A work-scoped one names project 0, which is not a pair
            // — its document is redone under the acting project instead.
            if (r.project_id !== 0) addPair(r.project_id, r.document_id)
            else addPair(actingProjectId, r.document_id)
          }
        }
      }

      const requeued = this.requeueOwningJobs(workId, superseded, documentIds, now)

      // PLANNED INSIDE THE SAME TRANSACTION AS THE RETIREMENT, and this is the
      // whole safety property of the method. Retiring commits the deletion of a
      // paper's output; planning is what schedules it to be produced again. If
      // the process dies between the two — and a desktop app is killed
      // routinely — the paper is left with every run retired and NOTHING queued
      // to redo them, and nothing on the next launch detects it, because
      // `resumePending` looks only at `processing_job` and there would be no
      // row to find. One transaction makes "destroyed" and "scheduled" a single
      // fact. It is safe to nest: `planPipeline` opens its own transaction,
      // which better-sqlite3 turns into a SAVEPOINT under this one, and every
      // statement on both sides is synchronous.
      const createdJobIds: number[] = []
      const allJobIds: number[] = []
      for (const pair of pairs) {
        const [projectId, documentId] = pair.split(':').map(Number)
        const res = planPipeline(this.db, this.registry, { workId, documentId, projectId }, now)
        for (const jid of res.jobIds) createdJobIds.push(jid)
        for (const jid of res.allJobIds) allJobIds.push(jid)
      }
      for (const jid of this.requeueUpstreamCancelled(workId, [...requeued, ...allJobIds], now)) {
        requeued.push(jid)
      }

      return { superseded, stale, requeued, projectIds, createdJobIds, allJobIds }
    }).immediate()

    // AFTER the transaction, exactly as `cancel` does it. The epoch bumps above
    // are what stop a dying execution committing over the rows just removed, so
    // aborting first would open the window they close. Without the abort the
    // fenced-out executor still holds its slot and the size-1 LLM gate for the
    // whole remaining model call, and the replacement it was replaced by cannot
    // start.
    for (const jobId of result.requeued) this.abortsByJob.get(jobId)?.abort()

    // Planned through `planPipeline` directly rather than through `plan()`, so
    // the wake, the tick and the notify happen ONCE for the whole re-run instead
    // of once per project — a fan-out over four projects otherwise fires four
    // full job-list refetches in every open window.
    this.wakeCorpusSweeps()
    if (this.running) this.scheduleTick(0)
    this.notify()

    return {
      supersededRunIds: result.superseded,
      staleRunIds: result.stale,
      requeuedJobIds: result.requeued,
      createdJobIds: result.createdJobIds,
      allJobIds: result.allJobIds,
      plannedProjectIds: [...result.projectIds],
      queueRunning: this.running
    }
  }

  /**
   * Re-run ONE stage for one work, across its whole fan-out.
   *
   * Resolution and use are in one synchronous body, and the ids never leave it.
   * `supersedeCascade` re-resolves by key and ignores `superseded`, so an id
   * held across two calls is a way to destroy a run the holder never saw; the
   * only safe interface is one that resolves ids itself.
   *
   * `schema-extract` fans out one run per attached extraction schema. Resolving
   * a stage NAME to a single id would re-run one schema, leave the others stale,
   * and report success.
   */
  forceRerunStage(workId: number, stage: string, projectId: number): RerunOutcome {
    const runs = currentStageRunIds(this.db, workId, stage, projectId)
    return { ...this.rerunRuns(workId, projectId, runs.map((r) => r.id)), hadOrigins: runs.length > 0 }
  }

  /**
   * Re-run ONE corpus sweep, whether or not its inputs moved.
   *
   * SEPARATE FROM `forceRerunStage` because a sweep belongs to no paper. That
   * method resolves a work's runs and then re-plans the work's pipeline, and a
   * sweep has neither: its run is keyed to work 0 and document 0, and there is
   * no per-paper plan that would ever create it. Passing 0 to it would take the
   * planner down the path `addPair` explicitly refuses.
   *
   * WHY THE RUN IS RETIRED RATHER THAN THE JOB MERELY RE-ARMED. A re-armed job
   * is answered from the cache when its fingerprint is unchanged, and unchanged
   * is exactly the case a user pressing "recompute" is in — they are asking for
   * the work to be redone anyway. Retiring the current run leaves the slot with
   * nothing current, so the next claim misses and the stage really executes.
   * The cascade is used rather than a bare UPDATE so that anything downstream
   * of this sweep is retired with it, as it is on every other invalidation
   * path.
   *
   * Returns whether there was a current run to retire — `false` is not an
   * error, it is a sweep that has never run, and the wake below still queues it.
   */
  forceRerunSweep(stage: string): { supersededRunIds: number[]; hadOrigins: boolean } {
    const definition = this.registry.order.find((s) => s.stage.id === stage)?.stage
    if (!definition) throw new Error(`no such stage: ${stage}`)
    if (definition.scope !== 'corpus') {
      throw new Error(`stage '${stage}' is not a corpus sweep`)
    }
    const now = this.now()
    const superseded = this.db.transaction((): number[] => {
      const current = this.db
        .prepare(
          `SELECT id FROM stage_run
            WHERE stage = ? AND work_id = 0 AND document_id = 0 AND project_id = 0
              AND superseded = 0`
        )
        .all(stage) as Array<{ id: number }>
      if (current.length === 0) return []
      return supersedeCascade(
        this.db,
        this.registry,
        { stage, workId: 0, documentId: 0, projectId: 0, schemaId: 0, fanoutKey: '' },
        now
      )
    }).immediate()

    // After the transaction, for the reason `rerunRuns` gives: the epoch bumps
    // inside it are what stop a dying execution committing over what was just
    // retired, so aborting first would open the window they close.
    for (const jobId of this.retireOwningSweepJobs(superseded, now)) {
      this.abortsByJob.get(jobId)?.abort()
    }

    this.wakeCorpusSweeps()
    if (this.running) this.scheduleTick(0)
    this.notify()
    return { supersededRunIds: superseded, hadOrigins: superseded.length > 0 }
  }

  /**
   * Put the sweep jobs owning retired runs back on the queue.
   *
   * A `running` sweep fenced out by the cascade throws `StaleExecutionError`,
   * which the executor catches WITHOUT settling its job — so without this the
   * cascade leaves a zombie `running` row that the next plan adopts and nothing
   * ever re-runs. The same hazard `requeueOwningJobs` handles for papers.
   */
  private retireOwningSweepJobs(supersededRunIds: number[], now: string): number[] {
    if (supersededRunIds.length === 0) return []
    const holes = supersededRunIds.map(() => '?').join(',')
    const stages = (
      this.db
        .prepare(`SELECT DISTINCT stage FROM stage_run WHERE id IN (${holes})`)
        .all(...supersededRunIds) as Array<{ stage: string }>
    ).map((r) => r.stage)
    const requeued: number[] = []
    const rearm = this.db.prepare(
      `UPDATE processing_job
          SET status = 'queued', attempts = 0, error = NULL, error_kind = NULL,
              lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE job_key = ? AND status NOT IN ('queued')`
    )
    const find = this.db.prepare(
      `SELECT id FROM processing_job WHERE job_key = ? ORDER BY id DESC LIMIT 1`
    )
    for (const s of stages) {
      const row = find.get(`sweep:${s}`) as { id: number } | undefined
      if (!row) continue
      if (rearm.run(now, `sweep:${s}`).changes > 0) requeued.push(row.id)
    }
    return requeued
  }

  /**
   * Re-run SEVERAL named stages of one work, in one transaction.
   *
   * The refresh path. `reprocessWork(force)` is the wrong tool for it: that
   * discards every current run of the paper, so a changed prompt on one model
   * stage re-fetched the PDF and re-OCR'd it. The stages named here are the ones
   * staleness actually found, and the cascade still reaches everything genuinely
   * downstream of them — so this narrows what is thrown away without ever
   * leaving a paper half-updated.
   *
   * One call rather than a loop over `forceRerunStage`, for the reason
   * `rerunRuns` documents: two calls let a second client re-resolve a key in
   * between, and the cascade would destroy the run the first had just created.
   */
  forceRerunStages(workId: number, stages: readonly string[], projectId: number): RerunOutcome {
    const ids: number[] = []
    /** Named stages this paper has never run, so there is nothing to discard. */
    const unplanned: string[] = []
    for (const stage of stages) {
      const runs = currentStageRunIds(this.db, workId, stage, projectId)
      if (runs.length === 0) unplanned.push(stage)
      for (const r of runs) ids.push(r.id)
    }

    // A STAGE THAT HAS NEVER RUN CANNOT BE RE-RUN, only planned. Collecting run
    // ids answers "what should be thrown away", which is empty for a stage
    // ADDED after this corpus was processed — it has no job and no run
    // anywhere. The queue reports it as outstanding, the user presses the
    // button, and nothing happens: `rerunRuns` is handed an empty list and
    // truthfully says it re-queued nothing.
    //
    // `onlyStages` exists for this and is what the planner's own header
    // describes. It leaves every other job of the paper alone, so this cannot
    // become the full re-plan that once re-extracted a corpus for the sake of
    // one missing step.
    if (unplanned.length > 0) {
      const now = this.now()
      const documentId = this.preferredDocument(workId)
      this.db.transaction(() => {
        planPipeline(
          this.db,
          this.registry,
          { workId, documentId, projectId, onlyStages: unplanned },
          now
        )
      })()
    }

    // `hadOrigins` says the press had something to act on, and a newly planned
    // stage is that as much as a discarded run is. The loop picks the new job
    // up on its next tick, exactly as it does for a re-armed one.
    return {
      ...this.rerunRuns(workId, projectId, ids),
      hadOrigins: ids.length > 0 || unplanned.length > 0
    }
  }

  /**
   * Re-run a work's whole pipeline.
   *
   * `force: false` plans against the stage cache: every stage whose inputs are
   * unchanged is settled straight back to done without executing. That is the
   * correct default and it is NOT a failure — but it is indistinguishable from a
   * re-run to anyone reading only the job ids, which is why the caller is given
   * `supersededRunIds` (empty here) to tell them apart with.
   *
   * `force: true` retires every current run of the work first, so there is no
   * cache left to hit.
   */
  reprocessWork(workId: number, projectId: number, opts: { force: boolean }): RerunOutcome {
    if (!opts.force) {
      const now = this.now()
      const documentId = this.preferredDocument(workId)
      const planned = this.db.transaction(() => {
        const res = planPipeline(this.db, this.registry, { workId, documentId, projectId }, now)
        return { res, revived: this.requeueUpstreamCancelled(workId, res.allJobIds, now) }
      }).immediate()
      this.wakeCorpusSweeps()
      if (this.running) this.scheduleTick(0)
      this.notify()
      return {
        supersededRunIds: [],
        staleRunIds: [],
        requeuedJobIds: planned.revived,
        createdJobIds: planned.res.jobIds,
        allJobIds: planned.res.allJobIds,
        plannedProjectIds: [projectId],
        queueRunning: this.running,
        // Nothing was resolved because nothing NEEDED to be: this path plans
        // against the cache and never looks for an origin. Reported so the
        // caller does not read "no origins" as "this paper has never run".
        hadOrigins: null
      }
    }

    // Read in the same synchronous call that consumes them, like every other
    // resolution here. Corpus-scoped runs are keyed to work 0, so scoping to a
    // real work already excludes them; they belong to no paper and are not a
    // paper's to re-run.
    const origins = (
      this.db
        .prepare(
          `SELECT id FROM stage_run
            WHERE work_id = ? AND superseded = 0
            ORDER BY id ASC`
        )
        .all(workId) as Array<{ id: number }>
    ).map((r) => r.id)
    return { ...this.rerunRuns(workId, projectId, origins), hadOrigins: origins.length > 0 }
  }
}

/**
 * What a re-run did, in the terms its caller has to distinguish.
 *
 * `supersededRunIds` is the only honest proof that anything was actually
 * discarded and must be redone: a job id list is not, because the planner
 * returns adopted jobs as readily as new ones and a re-armed job whose
 * fingerprint is unchanged settles straight back to done without running its
 * stage.
 */
export interface RerunOutcome {
  /** Runs retired by the cascade, output deleted. Empty means nothing was discarded. */
  supersededRunIds: number[]
  /** Ids that were current when resolved and had been retired by the time they were used. */
  staleRunIds: number[]
  /** Jobs put back on the queue: the executors that were fenced out, plus upstream-cancelled dependents. */
  requeuedJobIds: number[]
  /** Jobs this call INSERTED. */
  createdJobIds: number[]
  /** Every job the work's pipeline now consists of, created or adopted. */
  allJobIds: number[]
  /** The projects re-planned. Never contains 0. */
  plannedProjectIds: number[]
  /** Whether the queue will claim any of it. False means these jobs sit until it is resumed. */
  queueRunning: boolean
  /**
   * Whether there was any current run to act on.
   *
   * `false` and `true` are different answers and neither is an error: `false`
   * means this stage (or this paper) has nothing current to discard, which a
   * caller must not report as "re-run, nothing to do". `null` is the cached
   * plan, which never resolves an origin at all — so "no origins" would be a
   * category error rather than a small number.
   */
  hadOrigins: boolean | null
}

// Module-level singleton wired up in main/index.ts.
let schedulerSingleton: Scheduler | null = null
export function setJobQueue(q: Scheduler): void {
  schedulerSingleton = q
}
export function getJobQueue(): Scheduler {
  if (!schedulerSingleton) throw new Error('Scheduler not initialised')
  return schedulerSingleton
}

/**
 * The queue, under the name the IPC layer and the close guard address it by.
 * They care that one object owns job lifecycle, not which class implements it.
 */
export { Scheduler as JobQueue }
export { currentRun, keyOf, supersedeCascade }
