import type { JobDTO, StageDefDTO } from '@shared/contract'

/**
 * What one stage of one paper's pipeline is, resolved from the DB rows alone.
 *
 * Every member is a state the backend can actually be in, and no two mean the
 * same thing:
 *
 *   pending     the stage is registered but no job exists for this paper yet
 *   queued      a job exists and is waiting for a worker
 *   blocked     a job exists and is waiting on named upstream stages
 *   running     a worker is executing it now
 *   succeeded   it ran and produced output, OR correctly did nothing
 *   empty       it ran correctly and there was legitimately NOTHING to produce
 *   refused     it ran, and deliberately declined to state part of the answer
 *               rather than guess at it
 *   cancelled   a human stopped it
 *   failed      it broke
 *   superseded  it succeeded, but an upstream re-run invalidated its output
 *
 * THERE IS NO `skipped` STATE, deliberately. The backend still records one —
 * `processing_job.outcome` says 'skipped' when a precondition was absent — but
 * it is folded into `succeeded` by `jobState` below, because a stage that
 * correctly did nothing has not failed at anything. OCR declining a PDF that
 * already has a text layer is the pipeline working; surfacing it asked every
 * user to learn a word for a non-event and then judge, per paper, whether it
 * mattered. The reason is still on the job for the developer view to show.
 *
 * `empty` and `refused` are NOT failures either and must never be drawn as one:
 * a supplement whose bibliography lives in the main article is a correct
 * zero-output result this corpus really contains. If they read as red, the user
 * chases bugs that are not there and stops trusting the ones that are.
 */
export type StageState =
  | 'pending'
  | 'queued'
  | 'blocked'
  | 'running'
  | 'succeeded'
  | 'empty'
  | 'refused'
  | 'cancelled'
  | 'failed'
  | 'superseded'
  /**
   * ROLLUP ONLY — never a single stage. The pipeline has finished some stages
   * and has more to go, but nothing is queued, blocked or running for them: it
   * stopped part-way. A stage is `pending` or it is not; only the WHOLE row can
   * be stalled, and conflating the two told the user a half-processed paper had
   * never been touched.
   */
  | 'stalled'

/** States in which the stage has stopped for good — the basis of real progress. */
const TERMINAL: ReadonlySet<StageState> = new Set<StageState>([
  'succeeded',
  'empty',
  'refused',
  'cancelled',
  'failed',
  'superseded'
])

export const isTerminalStage = (s: StageState): boolean => TERMINAL.has(s)

/** The only state that paints the pipeline red. */
export const isFailureStage = (s: StageState): boolean => s === 'failed'

/** Still moving, or about to. */
export const isLiveStage = (s: StageState): boolean =>
  s === 'queued' || s === 'blocked' || s === 'running'

/**
 * Precedence when a fanned-out stage has several jobs under one dot.
 *
 * A failure outranks everything, because the one thing the user must not miss
 * is that a schema in the fan-out broke while the others were fine. Then the
 * live states (something is still happening here), then the zero-output
 * outcomes, and plain success LAST — a dot that says "succeeded" while one of
 * its five jobs failed is the exact misreport this ordering exists to prevent.
 */
const SEVERITY: Record<StageState, number> = {
  failed: 100,
  refused: 90,
  cancelled: 80,
  running: 70,
  blocked: 60,
  queued: 50,
  empty: 40,
  succeeded: 10,
  stalled: 8,
  // BELOW succeeded, deliberately. A re-run leaves the old job pointing at its
  // superseded run alongside the new job's current one; ranking superseded
  // higher made a stage that had just been successfully redone report
  // "Superseded", which is the precise opposite of the truth. A stage reads as
  // superseded only when superseded is ALL it has.
  superseded: 5,
  pending: 0
}

/**
 * One job's state, from its own columns only.
 *
 * Exported because it is also how an UNMAPPED job — one whose `stage` names
 * nothing the registry knows — is read. Such a job is still a real job with a
 * real status, so it gets its real state; only its POSITION is unknown, and
 * `stageCells` handles that by placing it after the pipeline rather than by
 * flattening it into a status of its own. A previous cut of this gave every
 * unmapped job the state `legacy`, which erased its failures: a broken job
 * rendered as an inert historical curiosity and the row never offered Retry.
 */
export function jobState(job: JobDTO): StageState {
  if (job.status === 'failed' || job.status === 'error') return 'failed'
  if (job.status === 'cancelled') return 'cancelled'
  if (job.status === 'running') return 'running'
  if (job.status === 'blocked') return 'blocked'
  if (job.status === 'queued') {
    // A queued job with unsatisfied dependency edges IS blocked, whatever the
    // status column says. The planner enqueues everything as `queued` and lets
    // the claim query refuse it, so the `blocked` STATUS is currently rare —
    // but the dependency rows are real, and "waiting for a worker" and "waiting
    // for extract-text" are different answers to the only question the user is
    // asking. This is read from `job_dependency`, not guessed.
    return job.blocked_by.length > 0 ? 'blocked' : 'queued'
  }

  // Terminal-and-successful. `stage_run.superseded` is checked BEFORE the
  // outcome: a job row keeps saying `done` forever, so without this a paper
  // whose upstream was re-run would advertise output that has already been
  // invalidated and deleted.
  if (job.stage_run_superseded === true) return 'superseded'

  // `review` and `done` are both terminal and both satisfy dependents; what
  // separates them is the OUTCOME, which is why the outcome is read here rather
  // than the status being trusted on its own.
  if (job.status === 'review' || job.status === 'done') {
    if (job.outcome === 'empty') return 'empty'
    if (job.outcome === 'refused') return 'refused'
    // `skipped` is DELIBERATELY not a state of its own here, and this is the one
    // place that decides it.
    //
    // A skip means a precondition was absent, so the stage correctly did
    // nothing: OCR on a PDF that already has a text layer, `optimize` where
    // qpdf is not installed. The pipeline behaved exactly as designed, and
    // presenting that as a distinct outcome asked every user to learn a word
    // for a non-event and then decide, per paper, whether it was a problem. It
    // is not. It reads as completed, because it is.
    //
    // The distinction is not LOST — `processing_job.outcome` still records
    // 'skipped' and the stage's own note still says which precondition was
    // missing, which is what the developer view surfaces. It simply is not the
    // headline a scientist is shown.
    return 'succeeded'
  }
  return 'queued'
}

/** One dot in a row: a registry stage plus whatever the DB says about it here. */
export interface StageCell {
  stage: StageDefDTO
  state: StageState
  /** Every job for this stage, in id order. Empty when the stage has not been planned. */
  jobs: JobDTO[]
  /** The job the dot's actions and tooltip speak for. Null when there is none. */
  lead: JobDTO | null
  /**
   * Stage ids the lead job is still waiting on, whatever its status column says.
   *
   * NOT gated on `state === 'blocked'`: the planner currently enqueues every
   * job as `queued` and lets the dependency edges hold it back, so a job that
   * is genuinely waiting on an upstream stage carries the `blocked` STATUS only
   * once something sets it. Gating on the status would mean the blockers the
   * query went and fetched were never once shown.
   */
  blockedBy: string[]
  /**
   * Upstream stages that failed or were cancelled, so this stage's wait will
   * never end on its own. Shown separately from `blockedBy`: "waiting" and
   * "waiting forever" call for different actions from the user.
   */
  deadBlockers: string[]
  /** The reason a zero-output or refused stage gave. Null when it gave none. */
  note: string | null
  /**
   * This cell is a job the registry does not know — its stage id is absent, or
   * names a stage this build no longer registers. Its STATE is still its real
   * one; only its position in the pipeline is undefined.
   */
  unmapped: boolean
  /** Wall time of the stage BODY, from stage_run. Null when nothing recorded it. */
  durationMs: number | null
  attempts: number
}

const bySeverity = (a: StageState, b: StageState): number => SEVERITY[b] - SEVERITY[a]

/**
 * Stages whose FAN-OUT SLOTS are shown as separate rows, and what to call them.
 *
 * The default is to fold a stage's slots into one cell, which is right when the
 * slots are the same work over different inputs: a reader wants to know whether
 * extraction ran, not to count schemas. It is wrong when the slots answer
 * DIFFERENT QUESTIONS and can honestly disagree — then one verdict has to pick
 * a winner, and the other slot's outcome survives only as prose in a note.
 *
 * `summarise` is that case: the general summary is the paper on its own terms,
 * the project summary is the paper read against a project's dossier. Either can
 * exist without the other, and the everyday case — a project with no dossier yet
 * — is precisely the one the folded cell reported as a plain success.
 *
 * Keys must match the stage's `fanOut()` keys exactly; a slot named here that
 * the stage never emits renders as `pending` forever, which is why the extras
 * pass below also draws any key this map does NOT name.
 */
const SPLIT_BY_SLOT: Record<string, ReadonlyArray<{ key: string; label: string }>> = {
  summarise: [
    { key: 'general', label: 'General summary' },
    { key: 'project', label: 'Project summary' }
  ]
}

/**
 * Lay a paper's jobs out against the registry.
 *
 * The registry drives the loop, not the jobs: a stage with no job is `pending`,
 * which is the truth (it is planned to run and has not) rather than an absence.
 * Jobs whose `stage` matches nothing registered are appended AFTER the real
 * pipeline, flagged `unmapped` but carrying their true state: dropping them
 * would hide work the DB genuinely records, interleaving them would imply an
 * ordering the registry never declared, and flattening them to a single inert
 * "legacy" state would hide their failures — which in this corpus is every
 * failure the seeded DB contains.
 *
 * `corpus`-scoped stages are excluded. They do not run per paper (the planner
 * skips them), so drawing one on every row would show a stage permanently
 * pending on a paper it will never run for.
 *
 * A row that holds ONLY corpus-scoped work — the `resolve-references` sweep,
 * which has no `work_id` and belongs to no paper's pipeline — is laid out
 * against its own jobs instead of the per-paper registry. Measuring it against
 * ten stages it was never going to run reported a finished sweep as
 * "1/10 stages done · Stopped part-way", next to the green tick of the one
 * stage that actually ran: 74 completed sweeps in the user's DB each claimed
 * the pipeline had stalled at stage one.
 */
export function stageCells(
  allStages: readonly StageDefDTO[],
  jobs: readonly JobDTO[]
): StageCell[] {
  const perPaper = allStages.filter((s) => s.scope !== 'corpus')
  const corpusOnly =
    jobs.length > 0 &&
    jobs.every((j) => {
      const def = allStages.find((s) => s.id === j.stage)
      return def?.scope === 'corpus'
    })
  const stages = corpusOnly ? allStages.filter((s) => s.scope === 'corpus') : perPaper
  const byStage = new Map<string, JobDTO[]>()
  const unmapped: JobDTO[] = []
  const known = new Set(stages.map((s) => s.id))
  for (const j of jobs) {
    if (j.stage !== null && known.has(j.stage)) {
      const list = byStage.get(j.stage)
      if (list) list.push(j)
      else byStage.set(j.stage, [j])
    } else {
      unmapped.push(j)
    }
  }

  const cellFor = (stage: StageDefDTO, list: JobDTO[]): StageCell => {
    if (list.length === 0) {
      return {
        stage,
        state: 'pending',
        jobs: [],
        lead: null,
        blockedBy: [],
        deadBlockers: [],
        note: null,
        unmapped: false,
        durationMs: null,
        attempts: 0
      }
    }
    // Only the CURRENT attempt at each fan-out slot competes to lead the cell.
    //
    // A stage can hold several jobs for the same slot: re-planning a pipeline
    // over a corpus that has already run leaves the earlier terminal job in
    // place beside the new one. Both are real history, but only the newest is
    // the current result — and `bySeverity` does not know that, so a superseded
    // `skipped` from an earlier wave outranked the `succeeded` that replaced it
    // and the row reported a stale outcome as though it were today's. That is
    // how "qpdf is not installed" kept being shown for documents qpdf had just
    // successfully compressed.
    //
    // The superseded attempts stay in `jobs` — the cell still accounts for
    // them, and their duration is still summed — they simply cannot speak for
    // the slot. Grouping is by `fanout_key` because within one cell the stage,
    // work and document are already fixed, so the slot IS the fan-out key.
    const sorted = [...list].sort((a, b) => a.id - b.id)
    const currentBySlot = new Map<string, JobDTO>()
    for (const j of sorted) currentBySlot.set(j.fanout_key, j)
    const current = [...currentBySlot.values()]
    const ranked = [...current].sort((a, b) => bySeverity(jobState(a), jobState(b)) || a.id - b.id)
    const lead = ranked[0]
    const state = jobState(lead)
    // Summed, not maxed: a fanned-out stage's cost to the user is all of its
    // jobs, and reporting only the longest would understate a stage that ran
    // twelve cheap extractions.
    const durations = sorted
      .map((j) => j.stage_run_duration_ms)
      .filter((d): d is number => d !== null)
    return {
      stage,
      state,
      jobs: sorted,
      lead,
      blockedBy: lead.blocked_by,
      deadBlockers: lead.dead_blockers,
      note: lead.outcome_note ?? null,
      unmapped: false,
      durationMs: durations.length === 0 ? null : durations.reduce((a, b) => a + b, 0),
      attempts: Math.max(...sorted.map((j) => j.attempts))
    }
  }

  const cells = stages.flatMap((s) => {
    const list = byStage.get(s.id) ?? []
    const slots = SPLIT_BY_SLOT[s.id]
    if (!slots) return [cellFor(s, list)]
    // ONE CELL PER SLOT, for a stage whose slots answer different questions.
    //
    // `cellFor` folds a fan-out into a single verdict by severity, which is
    // right when the slots are the same work repeated over different inputs —
    // twelve schemas either extracted or did not. It is wrong for `summarise`,
    // whose two slots fail for unrelated reasons with unrelated remedies: a
    // general summary blocked by the paper having no text, a project summary by
    // the project having no dossier. Folded, the commonest real case showed one
    // tick and buried "no project summary" in a note.
    //
    // Split HERE and not in the registry: which slots deserve their own row is
    // a presentation judgement, and `stagePhases.ts` already establishes that a
    // stage must never know how it is grouped. A slot the map does not name
    // still gets a cell, so a new fan-out key is never silently dropped.
    const named = new Set(slots.map((sl) => sl.key))
    // A job with NO KEY ran before this stage was split, when one job did the
    // work of both. It belongs to the FIRST slot — that is the kind such a job
    // always produced — rather than to a row of its own: drawn separately it
    // appeared as a nameless extra step ("Summarise · ") that no phase claimed,
    // which told the reader the app had an unexplained fourteenth step.
    const fallback = slots[0].key
    const keyOf = (k: string): string => (k === '' ? fallback : k)
    const extras = [...new Set(list.map((j) => keyOf(j.fanout_key)))].filter((k) => !named.has(k))
    return [
      ...slots.map((sl) =>
        cellFor(
          { ...s, id: `${s.id}:${sl.key}`, label: sl.label },
          list.filter((j) => keyOf(j.fanout_key) === sl.key)
        )
      ),
      // A key this map does not name is still drawn, so a slot added to the
      // stage without being added here is never silently dropped.
      ...extras.map((k) =>
        cellFor(
          { ...s, id: `${s.id}:${k}`, label: `${s.label} · ${k}` },
          list.filter((j) => keyOf(j.fanout_key) === k)
        )
      )
    ]
  })

  for (const j of unmapped) {
    cells.push({
      stage: {
        id: `unmapped:${j.id}`,
        label: legacyLabel(j),
        version: '—',
        index: stages.length + cells.length,
        scope: 'document',
        uses_llm: false
      },
      state: jobState(j),
      jobs: [j],
      lead: j,
      blockedBy: j.blocked_by,
      deadBlockers: j.dead_blockers,
      note: j.outcome_note ?? null,
      unmapped: true,
      durationMs: j.stage_run_duration_ms,
      attempts: j.attempts
    })
  }
  return cells
}

/**
 * A readable name for a job the registry does not know. Its `job_type` is the
 * only description it has, so it is shown as-is rather than guessed at.
 */
export function legacyLabel(job: JobDTO): string {
  const t = (job.stage ?? job.job_type).replace(/[_-]+/g, ' ').trim()
  if (t === '') return `Job #${job.id}`
  return t.charAt(0).toUpperCase() + t.slice(1)
}

/**
 * Real progress: stages that have reached a terminal state, over stages there
 * are. Never derived from ids or timestamps — a bar that moves without work
 * happening is worse than no bar.
 */
export function stageProgress(cells: readonly StageCell[]): { done: number; total: number } {
  return {
    done: cells.filter((c) => isTerminalStage(c.state)).length,
    total: cells.length
  }
}

/**
 * The row's headline verdict.
 *
 * Precedence is by consequence, not by count: a failure anywhere is what the
 * user must act on, a refusal stopped the pipeline deliberately, anything still
 * moving is the next thing to watch, and `review` outranks plain completion
 * because an empty result is a claim about the paper somebody should read.
 */
export function rollupState(cells: readonly StageCell[]): StageState {
  const states = cells.map((c) => c.state)
  if (states.includes('failed')) return 'failed'
  if (states.includes('refused')) return 'refused'
  if (states.includes('running')) return 'running'
  if (states.includes('blocked')) return 'blocked'
  if (states.includes('queued')) return 'queued'
  if (states.includes('superseded')) return 'superseded'
  if (states.includes('empty')) return 'empty'
  // Cancelled is checked BEFORE pending: a row the user stopped, whose later
  // stages consequently never got planned, is CANCELLED. Reading the unplanned
  // tail first made it report "Not started", which is both wrong and the
  // opposite of what the user just did.
  if (states.includes('cancelled')) return 'cancelled'
  if (states.includes('pending')) {
    // Nothing is moving and stages remain. Whether that is "not started" or
    // "stalled part-way" depends on whether ANY stage has finished, and the two
    // are not the same news: a paper that has run three stages and stopped is
    // not waiting its turn, it is a pipeline that needs re-planning. Reporting
    // both as "Not started" told the user a paper mid-way through was untouched.
    return states.some((s) => isTerminalStage(s)) ? 'stalled' : 'pending'
  }
  return 'succeeded'
}

/** Label + glyph for a state. The glyph is what carries it for a colourblind reader. */
export const STAGE_LABEL: Record<StageState, string> = {
  pending: 'Not started',
  queued: 'Queued',
  // NOT "Blocked", which reads as a fault the user has to clear. A stage
  // waiting for the step before it is the pipeline working — it will start on
  // its own the moment its input exists, and nothing is required of anybody.
  // The tooltip still names WHICH step it is waiting for, so the extra
  // precision is kept where a curious reader can reach it.
  blocked: 'Waiting',
  running: 'Running',
  succeeded: 'Completed',
  empty: 'Nothing found',
  // NOT "Declined to guess". `refused` is every deliberate, terminal stop, and
  // most of them are not about guessing at all: a paper with no DOI or URL has
  // nothing to fetch a PDF WITH, and a paywalled one was refused by a publisher.
  // Telling the user that fetching a PDF "declined to guess" describes an LLM
  // abstaining, on a step that never asks a model anything — so the sentence
  // read as nonsense exactly where it needed to be plainest.
  refused: 'Stopped on purpose',
  cancelled: 'Cancelled',
  failed: 'Failed',
  superseded: 'Out of date',
  stalled: 'Stopped part-way'
}

/**
 * The sentence the dot's tooltip leads with — what this state MEANS, in the
 * user's terms. A state name alone ("Empty") does not tell somebody whether
 * they are looking at a bug.
 */
// Each of these FOLLOWS the state's label in the tooltip, so none of them may
// begin by restating it: the dot read "Completed Finished." until this was
// fixed. They continue the sentence the label started.
export const STAGE_MEANING: Record<StageState, string> = {
  pending: 'Not started yet.',
  queued: 'Waiting its turn. It will start on its own.',
  blocked: 'Waiting for an earlier step to finish.',
  running: 'Working on this now.',
  succeeded: 'Done — either it produced something, or there was nothing to do.',
  empty: 'It looked and there was nothing here. Not a problem.',
  // The second sentence is CONDITIONAL because the scheduler makes it
  // conditional: cancelling dependents really does happen, but on the step that
  // produces most refusals nothing depends on its output, so "stops the rest"
  // would be false there. "Anything that needed it" is true in both cases.
  refused: 'It stopped on purpose — the reason is below. Steps that needed it stopped too.',
  cancelled: 'You stopped this.',
  failed: 'It broke. The error is below.',
  // No promise that it re-runs on its own: the supersede path marks the old row
  // and does NOT re-plan the step, so saying it would be a lie the user would
  // wait on.
  superseded: 'An earlier step was redone, so this result is out of date.',
  stalled: 'This paper stopped part-way and will not carry on by itself.'
}

/**
 * WHAT FAILED, in the user's terms, for the stage that actually failed.
 *
 * The queue used to print one sentence under every failed paper — "it may be
 * paywalled or behind a login" — no matter which step broke. That is only ever
 * true of retrieval. A paper whose PDF was fetched perfectly and whose
 * EXTRACTION then failed was told it was paywalled, which is both false and
 * unactionable: the reader goes looking for the paper on Sci-Hub, finds it
 * already downloaded, and learns the message cannot be trusted.
 *
 * Only stages that fail in a way a PERSON can do something about are listed.
 * Anything absent falls back to naming the step and showing its error, which
 * says less but says nothing false.
 */
export const STAGE_FAILURE_MEANING: Record<string, string> = {
  // Says only that the file was not obtained, because this stage fails for two
  // unrelated reasons — every source was asked and none produced the PDF, or the
  // library file this paper already had is no longer where it is recorded. A
  // sentence naming either cause would be false on the other half of the papers
  // it appears under, and the remedies beside it (add the PDF, look for it
  // yourself) are the same for both.
  retrieve: 'The PDF for this paper could not be obtained.',
  download: 'Could not get this paper — it may be paywalled or behind a login.',
  optimize: 'The PDF arrived but could not be opened. The file may be damaged.',
  'extract-text': 'The PDF has no text in it that could be read.',
  ocr: 'This PDF is scanned pictures, and reading the words off them did not work.',
  segment: 'The text was read but could not be split into paragraphs.',
  embed: 'The text was read, but it could not be indexed for search.',
  references: 'Could not read this paper’s reference list.',
  'resolve-references': 'Read the reference list, but could not match its entries to papers.',
  'citation-contexts': 'Could not find where in the text this paper cites its references.',
  'verify-citations': 'Could not check this paper’s citations against the papers they name.',
  'schema-extract': 'Could not pull out the values your extraction form asks for.'
}

/**
 * Appended to the tooltip of a cell the registry does not know, so the user is
 * told WHY it sits outside the pipeline instead of being left to wonder why one
 * dot has no place in the sequence.
 */
export const UNMAPPED_MEANING = 'This step is not part of the current sequence, so it sits at the end.'
