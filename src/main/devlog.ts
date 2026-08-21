// The developer log: what the app actually did, written to disk verbatim.
//
// WHY THIS EXISTS. An extracted value is only as good as the evidence under it,
// and when the two disagree — a variant list anchored to a sentence about
// enzyme NAMING — there is no way to tell from the database which step went
// wrong. The stored row keeps hashes and a verdict, never the conversation:
// `analysis_run` has `prompt_input_hash` but no prompt, and the raw completion
// is a local in `pipeline.ts` that is discarded the moment it is parsed. So the
// one artefact that would settle "did the model return this quote, or did our
// anchoring pick it?" is thrown away microseconds after it arrives.
//
// This module keeps it. When developer mode is ON every stage execution and
// every LLM conversation — the full system prompt, the full user message, the
// raw response, byte for byte, before any parsing — is appended to a session
// file. Truncating any of it would defeat the purpose: the bug is usually in
// the part someone judged uninteresting.
//
// OFF BY DEFAULT, and off is genuinely free: `isEnabled()` is a boolean read
// and every entry point returns before touching a string. A scientist's install
// does not silently accumulate copies of their papers on disk.
//
// NEVER LOGGED: the `Authorization` header and the gateway credential. Images
// are recorded by count and dimensions, never as base64 — a few table crops
// would otherwise bury the text they were meant to explain.

import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { userDataDir } from './db/paths'

export interface DevLogStatus {
  enabled: boolean
  /** Absolute path of the session file, or null when never enabled. */
  file: string | null
  /** Bytes written to the current session file. */
  bytes: number
  /** The directory holding this and previous sessions. */
  dir: string
}

/** How many session files to keep. Older ones are deleted when a new one opens. */
const KEEP_SESSIONS = 10

let enabled = false
let sessionFile: string | null = null

export function devLogDir(): string {
  return join(userDataDir(), 'devlogs')
}

/**
 * `CORPUS_DEV_LOG=1` arms the log HERE, at import, not at app bootstrap.
 *
 * It was armed in `main/index.ts`, which the CLI runners never execute — so
 * `CORPUS_DEV_LOG=1 npm run rerun:works` opened no session at all, and the one
 * command a developer would reach for to reproduce a bad extraction was the one
 * command that recorded nothing. Arming in the module every logger already
 * imports makes the variable mean the same thing from the app, from
 * `corpus:process`, from `rerun:works` and from the seed.
 *
 * Still off by default and still free when off: this is one string comparison
 * per process.
 */
function armFromEnv(): void {
  if (process.env.CORPUS_DEV_LOG !== '1') return
  try {
    setDevLogEnabled(true)
  } catch {
    // No writable userData (a sandboxed test) is not a reason to fail the run
    // the log was only meant to observe.
  }
}

export function isDevLogEnabled(): boolean {
  return enabled
}

/**
 * A new session file per enable, rather than one ever-growing log.
 *
 * A developer turns this on to capture ONE reproduction. Appending that to
 * yesterday's ten megabytes means finding it first, and the whole value of the
 * artefact is that it can be read start to finish.
 */
export function setDevLogEnabled(on: boolean): DevLogStatus {
  if (on && !enabled) {
    const dir = devLogDir()
    mkdirSync(dir, { recursive: true })
    pruneSessions(dir)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    sessionFile = join(dir, `session-${stamp}.log`)
    enabled = true
    write('session', {
      note: 'developer mode enabled — stages and LLM conversations are being recorded',
      platform: process.platform,
      pid: process.pid
    })
  } else if (!on && enabled) {
    write('session', { note: 'developer mode disabled' })
    enabled = false
  }
  return devLogStatus()
}

armFromEnv()

export function devLogStatus(): DevLogStatus {
  let bytes = 0
  if (sessionFile) {
    try {
      bytes = statSync(sessionFile).size
    } catch {
      // The user may have deleted it under us. Reporting 0 is honest; throwing
      // from a status read would take the Settings screen down with it.
      bytes = 0
    }
  }
  return { enabled, file: sessionFile, bytes, dir: devLogDir() }
}

function pruneSessions(dir: string): void {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.startsWith('session-') && f.endsWith('.log'))
      .sort()
    for (const f of files.slice(0, Math.max(0, files.length - (KEEP_SESSIONS - 1)))) {
      unlinkSync(join(dir, f))
    }
  } catch {
    // Pruning is housekeeping. A failure here must not stop the log opening —
    // the log is the thing the user asked for, the tidiness is not.
  }
}

// ------------------------------------------------------------- correlation
/**
 * Who is running, so every event can say which paper it belongs to.
 *
 * The reason this is ambient rather than a parameter is that the deepest and
 * most valuable events — the LLM conversations — happen in `provider.ts`, which
 * knows nothing about works, documents or stages and must not learn: it is the
 * one choke point EVERY call passes through, and threading a correlation
 * argument through it would mean every call site opting in, which is exactly
 * the situation that left nine LLM exchanges logged across ten sessions.
 *
 * Established once, by the scheduler, around each stage execution. A reader can
 * then `grep '"workId": 13'` and get that paper's whole story, prompts included.
 */
export interface DevLogScope {
  stage?: string
  stageRunId?: number
  jobId?: number
  workId?: number
  documentId?: number
  projectId?: number
  schemaId?: number | null
  fanOut?: string | null
  /** What this LLM call is FOR, when a stage makes several kinds. */
  purpose?: string
  analysisRunId?: number
}

const scopeStore = new AsyncLocalStorage<DevLogScope>()

/** Run `fn` with these ids attached to every event it emits, at any depth. */
export function withDevLogScope<T>(scope: DevLogScope, fn: () => T): T {
  if (!enabled) return fn()
  const parent = scopeStore.getStore()
  return scopeStore.run({ ...parent, ...scope }, fn)
}

/** The ids currently in force, for a caller that must pass them across a boundary. */
export function currentDevLogScope(): DevLogScope | undefined {
  return scopeStore.getStore()
}

/**
 * Capture the scope in force NOW and re-establish it whenever `fn` is called.
 *
 * `AsyncLocalStorage` follows the async chain, and a callback invoked from an
 * IPC `message` listener is not on it: the stage host's LLM calls arrive that
 * way, so without this the one class of call that costs money and crosses a
 * process boundary would be the one logged with no paper attached. The captured
 * value is the live scope OBJECT, so ids added later (`stageRunId`) are seen.
 */
export function bindDevLogScope<A extends unknown[], R>(
  fn: (...args: A) => R
): (...args: A) => R {
  if (!enabled) return fn
  const scope = scopeStore.getStore()
  if (!scope) return fn
  return (...args: A): R => scopeStore.run(scope, () => fn(...args))
}

/**
 * Add ids to the scope already in force — a run id that only exists once the
 * work has begun, and which every LATER event in the same execution should
 * carry. Mutates the current frame only: `withDevLogScope` copies the parent,
 * so nothing leaks outward.
 */
export function addDevLogScope(extra: DevLogScope): void {
  if (!enabled) return
  const scope = scopeStore.getStore()
  if (scope) Object.assign(scope, extra)
}

/**
 * One record. Synchronous by design: an async write can be lost when the
 * process exits, and a log that drops its last entries is worst precisely when
 * the app crashed — which is when it is being read.
 */
function write(kind: string, payload: unknown): void {
  if (!sessionFile) return
  const line = `${JSON.stringify({
    at: new Date().toISOString(),
    kind,
    ...scopeStore.getStore(),
    ...(payload as object)
  })}\n`
  try {
    appendFileSync(sessionFile, line)
  } catch {
    // A full or unwritable disk must not take the pipeline down. The run is the
    // user's work; the log is a diagnostic about it.
  }
}

// ------------------------------------------------------------------ stages

export function logStageStart(info: {
  stage: string
  stageVersion?: string
  jobId: number
  stageRunId?: number
  workId: number
  documentId: number
  projectId?: number
  schemaId?: number | null
  fanOut?: string | null
  /** The resolved input fingerprint — why this run was not served from cache. */
  fingerprint?: string
  isolation?: string
  /** True when the run was answered from `stage_run` instead of executing. */
  cached?: boolean
}): void {
  if (!enabled) return
  write('stage-start', info)
}

export function logStageEnd(info: {
  stage: string
  jobId: number
  stageRunId?: number
  workId: number
  documentId?: number
  projectId?: number
  schemaId?: number | null
  fanOut?: string | null
  status: string
  durationMs: number
  note?: string | null
  error?: string | null
  cached?: boolean
}): void {
  if (!enabled) return
  write('stage-end', info)
}

/**
 * An exception that is a fault in THIS APP, with the detail the user is not
 * shown.
 *
 * The queue tells the reader that a stage broke and that it is our bug, in
 * language they can act on — which means the message and the stack have to
 * live somewhere, and this is that somewhere. A bug report is assembled from
 * the dev log, so recording the raw error here is what makes the friendly text
 * affordable.
 */
export function logStageFault(info: {
  stage: string
  jobId: number
  workId: number
  message: string
  stack?: string
}): void {
  if (!enabled) return
  write('stage-fault', info)
}

// --------------------------------------------------------------------- llm

export interface DevLogLlmMessage {
  role: string
  content: string
  images?: number
}

/**
 * One LLM exchange, in full.
 *
 * `attempt` is present because `withRetry` sits INSIDE `callLLM`: one logical
 * call can be several conversations, and a truncated or rate-limited first
 * attempt is exactly the kind of thing this log exists to make visible.
 */
export function logLlmCall(info: {
  model: string
  attempt: number
  messages: DevLogLlmMessage[]
  maxTokens: number
  images: number
  /** Bytes of each attached image, so a bloated request is visible without them. */
  imageBytes?: number[]
}): void {
  if (!enabled) return
  write('llm-request', info)
}

export function logLlmResponse(info: {
  model: string
  attempt: number
  durationMs: number
  finishReason?: string | null
  /** ALL input, cache writes and reads included — not just the base-rate part. */
  promptTokens?: number | null
  cacheCreationTokens?: number | null
  cacheReadTokens?: number | null
  completionTokens?: number | null
  /** The completion EXACTLY as it arrived, before extractJson touches it. */
  raw: string
}): void {
  if (!enabled) return
  write('llm-response', info)
}

export function logLlmError(info: {
  model: string
  attempt: number
  durationMs: number
  error: string
  /** Whatever arrived before the failure, when there was any. */
  partial?: string | null
}): void {
  if (!enabled) return
  write('llm-error', info)
}

/**
 * A schema violation and what we did about it.
 *
 * Recorded because a repair is invisible otherwise: the run ends `partial` with
 * no trace of WHICH field the model got wrong, and that is exactly the thing
 * worth fixing in the prompt rather than papering over on every call.
 */
export function logRepair(info: {
  analysisType: string
  workId: number
  note: string
}): void {
  if (!enabled) return
  write('schema-repair', info)
}

/**
 * An answer that arrived and did not validate, with the text AND the reasons.
 *
 * `logRepair` records the app's own prose about a rejection; this records the
 * EVIDENCE for it. Reading "invalid answer 3/20" tells nobody whether the model
 * is wrong or the schema is, and by the time anyone asks, the raw text has been
 * discarded — so the question has only ever been answerable by paying for the
 * whole corpus again.
 */
export function logValidationFailure(info: {
  schemaName: string
  attempt: number
  /** The completion verbatim, exactly as `extractJson` received it. */
  raw: string
  /** Whether `extractJson` got a JSON object out of it at all. */
  parsed: boolean
  /** Every zod issue, path and message, not a count. */
  issues: string
}): void {
  if (!enabled) return
  write('validation-failure', info)
}

// ----------------------------------------------------------- claim disposition

/**
 * What became of ONE thing the model said.
 *
 * THE POINT OF THIS MODULE. The pipeline counts its rejections
 * (`droppedUnanchored`, `droppedOffSchema`, `droppedWrongDimension`) and keeps
 * only the integers, so a run reporting zero facts is indistinguishable from a
 * run that discarded everything the model correctly extracted — and settling
 * that has meant re-running the corpus, at hours and real money, to learn one
 * bit. One event per claim makes the ledger add up on paper: every claim the
 * model returned appears exactly once, either `kept` or dropped with the
 * specific rule that dropped it.
 */
export function logClaim(info: {
  /** `kept`, or the rule that discarded it. */
  outcome:
    | 'kept'
    | 'dropped-unanchored'
    | 'dropped-off-schema'
    | 'dropped-wrong-dimension'
    | 'lifted-shortfall'
  predicate: string
  kind?: string | null
  subject?: string | null
  object?: string | null
  value?: string | null
  unit?: string | null
  quote?: string | null
  fieldKey?: string | null
  /** The field's declared unit, when the drop was about dimensions. */
  fieldUnit?: string | null
  claimedParagraph?: number | number[] | null
  /** In the drop cases: why, in the terms of the rule that fired. */
  why?: string | null
}): void {
  if (!enabled) return
  write('claim', info)
}

/**
 * The ledger for one analysis: what the model returned and what survived.
 *
 * Emitted alongside the per-claim events rather than instead of them, because
 * the two answer different questions — this one says "zero facts, and the model
 * had said nothing" versus "zero facts, and we dropped eleven".
 */
export function logClaimLedger(info: {
  analysisType: string
  analysisRunId?: number
  schemaId?: number | null
  /** Facts in the model's validated answer, before any rule ran. */
  modelReturned: number
  kept: number
  droppedUnanchored: number
  droppedOffSchema: number
  droppedWrongDimension: number
  shortfalls: string[]
  verifier: string
  truncated?: boolean
}): void {
  if (!enabled) return
  write('claim-ledger', info)
}

// ------------------------------------------------------------------ citations

/**
 * One citation candidate: what the model was shown, what it said, what we stored.
 *
 * The same problem as `logClaim`, in the other LLM path. A verification that
 * stores nothing may be a model that declined, an answer that named a block we
 * never showed it, or a quote it could not copy — three different defects that
 * all present as a passage staying pending forever.
 */
export function logCitationVerdict(info: {
  contextId: number
  citingWorkId: number
  citedWorkId: number
  /** The passage the model was asked to judge. */
  sentence?: string | null
  /** Ids of the cited-paper blocks it was offered, in the order shown. */
  candidateBlockIds?: string[]
  topScore?: number | null
  /** What the model answered, before we judged it. */
  answered?: {
    references?: boolean | null
    blockId?: string | null
    quote?: string | null
    reason?: string | null
  } | null
  /** What we stored: a verdict, or the reason nothing was stored. */
  stored: 'verified' | 'rejected' | 'abstained' | 'not-stored'
  /** Whether an anchor into the cited paper survived, and if not why. */
  anchor?: 'targeted' | 'invented-block' | 'unsupported-quote' | 'none'
  why?: string | null
}): void {
  if (!enabled) return
  write('citation-verdict', info)
}

// ---------------------------------------------------------------- anchoring

/**
 * How one fact's quote was resolved to a paragraph — the step that produced the
 * bug this module was written for. A value whose evidence does not support it
 * is either a model that quoted the wrong line or a locator that matched the
 * wrong paragraph, and only the two side by side tell them apart.
 */
export function logAnchor(info: {
  predicate: string
  value: string | null
  quote: string | null
  claimedParagraph: number | number[] | null
  resolvedParagraph: number | null
  located: boolean
  /** The paragraph text the quote was ultimately anchored to. */
  resolvedText?: string | null
}): void {
  if (!enabled) return
  write('anchor', info)
}
