// stage_run lifecycle: fingerprinting, the cache decision, supersede-then-insert,
// and the supersede cascade.

import { createHash } from 'node:crypto'
import type { DB } from '../db/connection'
import { deleteChunksForRun } from '../embedding/vectors'
import type { ResolvedRegistry } from './registry'
import { inputsOf } from './types'
import type { Capability, FanOutKey, StageDefinition, StagePlanContext } from './types'

export interface StageKey {
  stage: string
  workId: number
  documentId: number
  projectId: number
  schemaId: number
  fanoutKey: string
}

export interface StageRunRow {
  id: number
  stage: string
  stage_version: string
  status: string
  lease_epoch: number
  input_fingerprint: string
  outcome_note: string | null
  error: string | null
  result: string | null
  superseded: number
}

/** Terminal outcomes that are legitimately cacheable. */
const CACHEABLE = new Set(['succeeded', 'empty', 'skipped', 'refused'])

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

export function keyOf(stage: StageDefinition, ctx: StagePlanContext, fan: FanOutKey | null): StageKey {
  return {
    stage: stage.id,
    workId: stage.scope === 'corpus' ? 0 : ctx.workId,
    documentId: stage.scope === 'corpus' ? 0 : ctx.documentId,
    projectId: stage.scope === 'project' ? ctx.projectId : 0,
    schemaId: fan?.schemaId ?? 0,
    fanoutKey: fan?.key ?? ''
  }
}

/**
 * A stage_run key that disagrees with its stage's scope is unenforceable.
 *
 * THROWS rather than normalising. Silently rewriting the ids would let the
 * caller keep its wrong belief about which run it just created, and the next
 * lookup — which derives the ids from the scope — would find a different row
 * than the one that was written. A loud failure at the write is the only
 * version of this that stays true afterwards.
 */
export function assertKeyMatchesScope(
  key: StageKey,
  scope: 'document' | 'project' | 'corpus'
): void {
  if (scope === 'corpus' && (key.workId !== 0 || key.documentId !== 0)) {
    throw new Error(
      `stage_run key for corpus-scoped '${key.stage}' names work ${key.workId} / document ` +
        `${key.documentId}; a corpus sweep belongs to no paper`
    )
  }
  if (scope !== 'project' && key.projectId !== 0) {
    throw new Error(
      `stage_run key for ${scope}-scoped '${key.stage}' carries project_id ${key.projectId}; ` +
        'only a project-scoped stage may, and a non-zero one here occupies a separate ' +
        'ux_stage_run_current slot, so two runs stay current at once'
    )
  }
}

/**
 * Every current run of a stage for a subject, across its fan-out.
 *
 * A fanned-out stage has one run PER KEY, so looking up a single row with
 * `fanout_key = ''` finds nothing and a consumer would read the upstream as
 * absent forever — the fingerprint would freeze and the input would be
 * undefined however much work the stage had actually done. Ordered by key so
 * the fingerprint over them is stable.
 */
export function currentRunsOfStage(
  db: DB,
  stage: string,
  ctx: { workId: number; documentId: number; projectId: number },
  scope: 'document' | 'project' | 'corpus'
): StageRunRow[] {
  const workId = scope === 'corpus' ? 0 : ctx.workId
  const documentId = scope === 'corpus' ? 0 : ctx.documentId
  const projectId = scope === 'project' ? ctx.projectId : 0
  return db
    .prepare(
      `SELECT id, stage, stage_version, status, lease_epoch, input_fingerprint,
              outcome_note, error, result, superseded
         FROM stage_run
        WHERE stage = ? AND work_id = ? AND document_id = ? AND project_id = ?
          AND superseded = 0
        ORDER BY schema_id, fanout_key`
    )
    .all(stage, workId, documentId, projectId) as StageRunRow[]
}

/**
 * Every current run of a stage for this document, across EVERY project.
 *
 * The cascade needs this and `currentRunsOfStage` cannot give it. That function
 * derives `project_id` from the CALLER's context, and the caller here is the
 * origin run — a document-scoped stage such as `extract-text`, whose
 * `project_id` is the 0 sentinel. Asking it for a project-scoped downstream
 * therefore searches `project_id = 0` and finds nothing, so `schema-extract`
 * stayed current in every real project while the paragraph inventory it had
 * read was deleted underneath it. Reproduced before this was written.
 *
 * A cascade is invalidation, not interpretation: text that changed did not
 * change for one project only, so every project's derived run must be retired.
 */
function currentRunsOfStageAnyProject(
  db: DB,
  stage: string,
  ctx: { workId: number; documentId: number },
  scope: 'document' | 'project' | 'corpus'
): StageRunRow[] {
  const workId = scope === 'corpus' ? 0 : ctx.workId
  const documentId = scope === 'corpus' ? 0 : ctx.documentId
  return db
    .prepare(
      `SELECT id, stage, stage_version, status, lease_epoch, input_fingerprint,
              outcome_note, error, result, superseded
         FROM stage_run
        WHERE stage = ? AND work_id = ? AND document_id = ? AND superseded = 0
        ORDER BY project_id, schema_id, fanout_key`
    )
    .all(stage, workId, documentId) as StageRunRow[]
}

export function currentRun(db: DB, key: StageKey): StageRunRow | undefined {
  return db
    .prepare(
      `SELECT id, stage, stage_version, status, lease_epoch, input_fingerprint,
              outcome_note, error, result, superseded
         FROM stage_run
        WHERE stage = ? AND work_id = ? AND document_id = ? AND project_id = ?
          AND schema_id = ? AND fanout_key = ? AND superseded = 0`
    )
    .get(key.stage, key.workId, key.documentId, key.projectId, key.schemaId, key.fanoutKey) as
    | StageRunRow
    | undefined
}

/**
 * The input fingerprint: everything that, if changed, must invalidate this run.
 *
 * Upstream fingerprints are folded in, which is what makes cache invalidation
 * derive from capabilities rather than from a hardcoded downstream list: a new
 * mid-chain rewriter automatically supersedes everything after it without any
 * downstream stage knowing it exists.
 */
export function computeFingerprint(
  db: DB,
  registry: ResolvedRegistry,
  stage: StageDefinition,
  ctx: StagePlanContext,
  fan: FanOutKey | null
): string {
  const parts: string[] = [`stage=${stage.id}`, `version=${stage.version}`]

  // THE MODEL IS NOT FINGERPRINTED, and that is deliberate.
  //
  // There is no model selector any more: the app configures an API endpoint and
  // a key, and the gateway decides which model answers (`pickModel` in
  // `llm/select.ts`, from whatever that endpoint reports as available). Nothing
  // in the UI chooses one, and `selectProvider` is called with no model at all.
  //
  // Hashing `setting.selected_model_id` here therefore compared results against
  // a value no longer connected to anything. Its seeded default is `gpt-4.1`
  // while the gateway was actually answering with claude-haiku — so every
  // AI-produced result looked stale for a reason the user could neither see nor
  // act on. It marked 14 of 20 papers as needing a refresh that would have
  // changed nothing.
  //
  // Which model produced a result is still RECORDED: the scheduler stamps
  // `stage_run.model` and `analysis_run.model` on every run, so provenance can
  // still answer "what wrote this". It simply no longer drives invalidation,
  // because the user has no lever here to move.
  //
  // If a model selector returns, this is where it belongs — gated on
  // `stage.usesLlm`, so stages that never reach a model are untouched.

  const self = registry.byId(stage.id)
  if (self) {
    // Optional inputs are fingerprinted too. A crop that appears, changes, or
    // stops being renderable changes what the stage was shown, so an answer
    // reached without it must reopen — an enrichment outside the hash would be
    // read once and then cached against forever.
    for (const cap of [...inputsOf(stage)].sort()) {
      const chain = registry.providersFor(cap, self.index)
      for (const provider of chain) {
        // EVERY current run of the provider, not one: a fanned-out upstream has
        // one run per key, and folding only a `fanout_key = ''` lookup would
        // record `absent` forever and freeze this fingerprint against real
        // upstream change.
        const runs = currentRunsOfStage(db, provider.id, ctx, provider.scope)
        if (runs.length === 0) {
          parts.push(`${cap}<-${provider.id}:absent`)
          continue
        }
        for (const run of runs) {
          // The upstream's OUTPUT, not its input fingerprint.
          //
          // This is the difference between "my inputs changed" and "the reason
          // my upstream ran changed", and folding the latter made the pipeline
          // amplify every re-run into a full corpus rebuild. Measured on a
          // 20-document corpus: download held 21 distinct fingerprints,
          // extract-text 40, segment 60, citation-contexts 101, schema-extract
          // 332. Each stage inherited its upstream's churn and added its own,
          // so one changed hash at the top re-ran everything below it —
          // including model calls — even though the text those stages consume
          // was byte-identical every time.
          //
          // `result` is what the stage actually produced ({"pageCount":8,
          // "chars":54721}). Re-running extract-text over an unchanged PDF
          // yields the same result, so segment sees no change and stays cached.
          // That is what makes a re-run LOCAL: it stops at the first stage whose
          // output is genuinely different.
          //
          // `status` stays in: `empty` and `refused` are positive claims that
          // there is nothing, and a downstream must react when a provider
          // switches between having output and not.
          //
          // Falls back to the fingerprint when a run recorded no result — an
          // older row, or a stage whose output lives entirely in its own
          // tables. Conservative in the right direction: it may re-run a stage
          // that need not have, never skip one that must.
          const stamp = run.result ?? run.input_fingerprint
          parts.push(`${cap}<-${provider.id}:${sha(stamp)}:${run.status}`)
        }
      }
    }
  }
  if (stage.fingerprint) parts.push(`own=${stage.fingerprint(ctx, fan)}`)
  if (fan) parts.push(`fan=${fan.key}`)
  return sha(parts.join('|'))
}

export interface CacheDecision {
  hit: boolean
  current?: StageRunRow
  fingerprint: string
}

export function decideCache(
  db: DB,
  registry: ResolvedRegistry,
  stage: StageDefinition,
  ctx: StagePlanContext,
  fan: FanOutKey | null
): CacheDecision {
  const fingerprint = computeFingerprint(db, registry, stage, ctx, fan)
  const current = currentRun(db, keyOf(stage, ctx, fan))
  const hit =
    current !== undefined &&
    CACHEABLE.has(current.status) &&
    current.input_fingerprint === fingerprint
  return { hit, current, fingerprint }
}

/**
 * Open a run: supersede whatever currently holds the slot, then insert. ALWAYS,
 * in one immediate transaction.
 *
 * "Not a cache hit" is not "the slot is free": a `failed` or an abandoned
 * `running` row still has `superseded = 0` and still occupies
 * `ux_stage_run_current`, so an unconditional insert raises SQLITE_CONSTRAINT
 * on exactly the retry path that most needs to work.
 */
export function beginRun(
  db: DB,
  input: {
    key: StageKey
    /**
     * The stage's DECLARED scope, so the key can be checked against it.
     *
     * `ux_stage_run_current` keys on `project_id` among other columns, which
     * means it can only enforce one-current-run when every writer agrees on
     * what `project_id` a given stage uses. A document-scoped stage written
     * with a real project id occupies a DIFFERENT slot from the same stage
     * written with 0, so both stay current and the index is satisfied while the
     * invariant it exists for is broken. That happened: one document ended up
     * with two live paragraph inventories, and `freshness.readDocumentBody`
     * — correctly refusing to concatenate two inventories no run ever produced
     * — then reported that document's body as absent.
     *
     * `keyOf` derives the ids from the scope and so cannot produce the bad
     * shape; this is the backstop against any OTHER path reaching this
     * function, which is where that row actually came from.
     */
    scope: 'document' | 'project' | 'corpus'
    stageVersion: string
    fingerprint: string
    leaseEpoch: number
    now: string
  }
): number {
  assertKeyMatchesScope(input.key, input.scope)
  return db.transaction((): number => {
    // The outgoing run's OUTPUT goes with it, not just its flag.
    //
    // `supersedeCascade` deletes bulk rows, but it is not the only path that
    // retires a run: this one is, whenever a stage simply re-runs after a
    // fingerprint change. Leaving the rows here produced 652 stale
    // `document_paragraph` rows on a single real paper — a whole superseded
    // inventory whose positional `p0..pN` ids now name completely different
    // text, sitting in the table that every anchor resolves against. Found by
    // driving a real paper through twice, which is exactly why that check
    // exists rather than being trusted.
    const outgoing = db
      .prepare(
        `SELECT id FROM stage_run
          WHERE stage = ? AND work_id = ? AND document_id = ? AND project_id = ?
            AND schema_id = ? AND fanout_key = ? AND superseded = 0`
      )
      .all(
        input.key.stage,
        input.key.workId,
        input.key.documentId,
        input.key.projectId,
        input.key.schemaId,
        input.key.fanoutKey
      ) as Array<{ id: number }>
    for (const r of outgoing) deleteRunOutput(db, r.id)
    // Bumped for the same reason the cascade bumps it: an outgoing run may still
    // be EXECUTING — nothing here filters on status — and `finishRun`'s fence is
    // the only thing standing between that executor and a commit onto the row
    // this transaction is retiring. Two of the three retirement paths bumped;
    // this one did not, and a stage that simply re-runs after a fingerprint
    // change takes it.
    db.prepare(
      `UPDATE stage_run SET superseded = 1, lease_epoch = lease_epoch + 1
        WHERE stage = ? AND work_id = ? AND document_id = ? AND project_id = ?
          AND schema_id = ? AND fanout_key = ? AND superseded = 0`
    ).run(
      input.key.stage,
      input.key.workId,
      input.key.documentId,
      input.key.projectId,
      input.key.schemaId,
      input.key.fanoutKey
    )
    const info = db
      .prepare(
        `INSERT INTO stage_run
           (stage, stage_version, work_id, document_id, project_id, schema_id,
            fanout_key, status, lease_epoch, input_fingerprint, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`
      )
      .run(
        input.key.stage,
        input.stageVersion,
        input.key.workId,
        input.key.documentId,
        input.key.projectId,
        input.key.schemaId,
        input.key.fanoutKey,
        input.leaseEpoch,
        input.fingerprint,
        input.now
      )
    return Number(info.lastInsertRowid)
  }).immediate()
}

/**
 * Close a run. FENCED on `lease_epoch`: a stale executor whose job was reclaimed
 * and re-dispatched cannot commit over its replacement's work, however wrong
 * the reclaim decision was.
 *
 * Returns false when the write affected no row, which the caller must treat as
 * "I am stale, discard everything".
 */
export function finishRun(
  db: DB,
  input: {
    stageRunId: number
    leaseEpoch: number
    status: 'succeeded' | 'empty' | 'skipped' | 'refused' | 'failed'
    note?: string | null
    error?: string | null
    result?: unknown
    durationMs: number
    now: string
    provenance?: {
      model?: string
      promptVersion?: string
      schemaVersion?: string
      analysisRunId?: number
    }
  }
): boolean {
  const info = db
    .prepare(
      `UPDATE stage_run
          SET status = ?, outcome_note = ?, error = ?, result = ?,
              -- COALESCE, so a stage that reported no provenance does not ERASE
              -- what an earlier write recorded. These columns are the answer to
              -- "which model produced this", and a null written over a real
              -- value is indistinguishable from never having asked.
              model = COALESCE(?, model),
              prompt_version = COALESCE(?, prompt_version),
              schema_version = COALESCE(?, schema_version),
              analysis_run_id = COALESCE(?, analysis_run_id),
              duration_ms = ?, finished_at = ?
        WHERE id = ? AND lease_epoch = ? AND status = 'running'`
    )
    .run(
      input.status,
      input.note ?? null,
      input.error ?? null,
      input.result === undefined ? null : JSON.stringify(input.result),
      input.provenance?.model ?? null,
      input.provenance?.promptVersion ?? null,
      input.provenance?.schemaVersion ?? null,
      input.provenance?.analysisRunId ?? null,
      input.durationMs,
      input.now,
      input.stageRunId,
      input.leaseEpoch
    )
  return info.changes > 0
}

/**
 * Delete everything a run produced.
 *
 * EXPLICIT, not a cascade, and that distinction is the whole reason this
 * function exists. The supersede path does `UPDATE stage_run SET superseded = 1`
 * — the row is RETAINED, because `ux_stage_run_current` is partial on
 * `superseded = 0` and the history is the provenance — and **an UPDATE fires no
 * `ON DELETE CASCADE`**. So relying on the FK would leave a superseded run's
 * bulk rows in place: stale paragraphs whose positional `para_id` now names
 * different text, and stale contexts that then collide with the fresh run on
 * `ux_citation_context_site`. Both reproduced before this was written.
 *
 * Every table listed here is bulk output keyed by `stage_run_id`. Adding a
 * table to this list is the ONE thing a new stage with its own table must do
 * beyond its own file — the bounded carve-out, stated rather than hidden.
 *
 * All three paths that retire a run go through here (the cascade, the cancel,
 * and the abandoned-lease reclaim), so a cancelled run cannot leave rows that
 * make its own retry fail.
 */
export function deleteRunOutput(db: DB, stageRunId: number): void {
  // CITATION CONTEXTS ARE NOT LISTED HERE, and that is deliberate.
  //
  // A context is identified by its SITE — `ux_citation_context_site` keys on
  // (document_id, callout_offset, ordinal) — and a re-scan of text that did not
  // change rediscovers exactly the same sites. Deleting them per run therefore
  // destroyed rows that were about to be re-created identically, and took every
  // `citation_link` with them by cascade: paid model verdicts, discarded to
  // recompute a cheap deterministic scan.
  //
  // The contexts write upserts on that site key instead, so a re-run keeps the
  // row and its id, deletes only sites the new scan no longer finds, and never
  // fires the cascade for a citation that still exists.
  db.prepare('DELETE FROM document_paragraph WHERE stage_run_id = ?').run(stageRunId)
  // Vectors before chunks, and through the one helper that knows a `vec0` table
  // is VIRTUAL: it can carry no foreign key and no cascade, so nothing else in
  // the schema will remove a vector when its chunk goes.
  deleteChunksForRun(db, stageRunId)
  // `document.text_source` is the one claim a run makes about a row it does not
  // own. Clearing it HERE, keyed on the run, is what keeps it retractable: a
  // superseded or cancelled OCR run would otherwise leave the document badged
  // with a confidence nothing currently stands behind, and the badge would
  // outlive every trace of where it came from.
  //
  // `content_status` is retracted with them, on the same key. It is the claim
  // that decides whether an analysis is presented as full-text-backed, and it
  // was written by the same run on the same evidence; leaving it at 'fulltext'
  // after that run is retired badges a document with text nothing currently
  // stands behind — the precise overstatement the other three fields are
  // cleared to avoid.
  db.prepare(
    `UPDATE document
        SET content_status = 'unknown', text_source = 'unknown',
            text_confidence = NULL, text_source_run_id = NULL
      WHERE text_source_run_id = ?`
  ).run(stageRunId)
  db.prepare('DELETE FROM stage_artifact WHERE stage_run_id = ?').run(stageRunId)
  // The LLM RESULT of a retired run, superseded rather than deleted.
  //
  // `schema-extract` writes an `analysis_run` and links it back via
  // `stage_run.analysis_run_id`. Retiring the stage run without retiring that
  // row left the facts and evidence spans reading as CURRENT while the
  // paragraphs they quote had just been deleted above — a conclusion presented
  // with full confidence on top of an evidence base that no longer exists.
  //
  // Superseded, never deleted: `analysis_run` is the provenance record and its
  // children are `ON DELETE RESTRICT`. The one-current-run partial index keys on
  // `superseded = 0`, so flipping the flag is also what frees the slot for the
  // replacement run to claim.
  db.prepare(
    `UPDATE analysis_run SET superseded = 1
      WHERE id IN (SELECT analysis_run_id FROM stage_run
                    WHERE id = ? AND analysis_run_id IS NOT NULL)`
  ).run(stageRunId)
}

/**
 * Supersede a run and everything downstream of it.
 *
 * Walks CAPABILITIES, not a stage list, so a re-parse automatically invalidates
 * every consumer without any stage naming another.
 *
 * The recursion carries a visited set and skips self-edges: a transformer
 * requires AND provides the same token, so it is its own downstream and the
 * cascade would never terminate. The fingerprint side-condition does not save
 * it, because two providers of one token legitimately chain.
 */
export function supersedeCascade(
  db: DB,
  registry: ResolvedRegistry,
  origin: StageKey,
  now: string
): number[] {
  const superseded: number[] = []
  const visited = new Set<number>()
  // Per STAGE as well as per run: the capability graph is a DAG, not a tree, so
  // a stage reachable by two paths would otherwise be walked twice and the cost
  // would be exponential in the graph's width.
  const walkedStages = new Set<string>()

  const subject = { workId: origin.workId, documentId: origin.documentId, projectId: origin.projectId }

  const walk = (stageId: string, runs: StageRunRow[]): void => {
    if (walkedStages.has(stageId)) return
    walkedStages.add(stageId)
    // A stage with NOTHING to supersede is still walked THROUGH: a gap in the
    // middle of the chain — a stage that never ran — must not shelter
    // everything after it from the invalidation.
    const fresh = runs.filter((r) => !visited.has(r.id))
    for (const run of fresh) {
      visited.add(run.id)
      // THE EPOCH BUMP IS WHAT MAKES THE RETIREMENT AUTHORITATIVE.
      //
      // This walk has no `status` filter — it retires a `running` run as
      // readily as a finished one, and must, because the whole point is to
      // invalidate everything downstream of a changed input. But `finishRun`
      // fences only on `id + lease_epoch + status='running'`, so without this
      // bump an executor still awaiting its model call commits its terminal
      // write and its bulk rows onto the row just retired here — output owned
      // by a superseded run, no current run for the key, and every downstream
      // fingerprint reading the input as absent.
      //
      // `lease_epoch` on `stage_run` has exactly one reader, that fence, so the
      // bump is inert on every other path. `cancel` (scheduler) and the
      // abandoned-lease reclaim already bump it for the same reason; this was
      // the one retirement path that did not, and it is the path a re-run takes.
      //
      // The fenced-out executor then throws `StaleExecutionError`, which the
      // scheduler catches WITHOUT settling its job — so the caller must also
      // requeue the owning job, or the cascade leaves a zombie `running` row
      // that the next plan adopts and nothing ever re-runs. `Scheduler`
      // owns that half; see `retireOwningJobs`.
      //
      // AND THE STATUS MOVES OFF `running` IN THE SAME BREATH. The pair
      // (`status`, `finished_at`) is one fact about a row, and this walk stamps
      // the second a few lines below — so leaving the first alone published runs
      // that claimed to be executing and to have ended, which is not a state a
      // stage can be in. The run did end, and it ended without producing
      // anything: its output has just been deleted and its lease fenced, so
      // `failed` is the only terminal value that is true of it. The error names
      // the cause, because "why did this stop" is otherwise unanswerable from
      // the row. A run that had already committed a terminal status keeps it —
      // this retires it, it did not undo it.
      db.prepare(
        `UPDATE stage_run
            SET superseded = 1, lease_epoch = lease_epoch + 1,
                status = CASE WHEN status = 'running' THEN 'failed' ELSE status END,
                error = CASE WHEN status = 'running'
                             THEN COALESCE(error, 'retired while running: an input this stage depends on changed')
                             ELSE error END
          WHERE id = ? AND superseded = 0`
      ).run(run.id)
      deleteRunOutput(db, run.id)
      superseded.push(run.id)
    }

    const self = registry.byId(stageId)
    if (!self) return
    // A TRANSFORMER IS NOT AN ORIGIN, so re-running one invalidates nothing
    // beyond itself.
    //
    // `transforms` means the stage rewrites a token it did not create: qpdf
    // recompresses a PDF and hands back the same pages, the same text and the
    // same numbers. Treating that like production made every consumer of the
    // token downstream of it, so rebuilding the qpdf BINARY -- a fingerprint
    // change that no document can observe -- retired the summaries, extractions
    // and review records of 26 papers that had not changed at all.
    //
    // Only ORIGINATED tokens fan out. The transformer still supersedes itself
    // above, which is what keeps "qpdf appeared, re-run the skip" working; what
    // it no longer does is drag the rest of the pipeline with it. A stage that
    // genuinely changes meaning originates a token to say so, and the registry
    // already guarantees exactly one originator per capability.
    const provided = new Set<Capability>(
      self.stage.transforms === undefined
        ? self.stage.provides
        : self.stage.provides.filter((c) => c !== self.stage.transforms)
    )
    for (const other of registry.order) {
      // Self-edges are skipped and the index strictly increases, so the
      // recursion terminates even for a transformer — which requires AND
      // provides the same token and would otherwise be its own downstream
      // forever. The fingerprint alone does not save it, because two providers
      // of one token legitimately chain.
      if (other.stage.id === stageId) continue
      if (other.index <= self.index) continue
      if (!inputsOf(other.stage).some((c) => provided.has(c))) continue
      // All of the downstream stage's runs, across its fan-out: a per-schema
      // extraction is as invalidated by a re-parse as a single-run stage is,
      // and addressing only `fanout_key = ''` would leave every fanned-out run
      // current against inputs that no longer exist.
      walk(other.stage.id, currentRunsOfStageAnyProject(db, other.stage.id, subject, other.stage.scope))
    }
  }

  db.transaction(() => {
    const originRun = currentRun(db, origin)
    walk(origin.stage, originRun ? [originRun] : [])
    if (superseded.length > 0) {
      db.prepare(
        `UPDATE stage_run SET finished_at = COALESCE(finished_at, ?)
          WHERE id IN (${superseded.map(() => '?').join(',')})`
      ).run(now, ...superseded)
    }
  }).immediate()

  return superseded
}
