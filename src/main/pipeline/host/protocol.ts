// The wire format between main and a stage host.
//
// Imported by BOTH sides, so it must stay free of anything that only exists in
// one of them: no `electron`, no `better-sqlite3`, no DB types. That constraint
// is the protocol's own documentation — a host has no database, and a message
// shape that could carry one would be the first crack in that.

import type { BibliographicRecord, Capability, FanOutKey, StageOutcome } from '../types'
import type { ModelSettings } from '../../llm/modelSettings'

/** Envelope size ceiling. Exceeded => the dispatch fails LOUDLY in main. */
export const MAX_ENVELOPE_BYTES = 64 * 1024 * 1024


export interface HostWorkSubject {
  /**
   * Which model each kind of work uses, and how much room it has.
   *
   * Shipped in the envelope like every other subject field: the host cannot
   * read the database, and that is the property making "one writer" structural
   * rather than a rule someone has to remember.
   */
  modelSettings: ModelSettings
  /**
   * The polite-pool contact address, shipped for the same reason
   * `modelSettings` is: it lives in `setting`, and a host has no database.
   */
  contactEmail: string
  work: { id: number; title: string; abstract: string | null } | null
  document: { id: number; work_id: number; content_status: string | null } | null
  pdfPath: { baseDir: string; relativePath: string; absPath: string } | null
  /**
   * The work's identifiers and retrieval state, resolved in main like everything else here.
   *
   * They belong in the envelope rather than behind an RPC for the same reason the rest does:
   * a hosted stage cannot look anything up, and that is what makes "one writer" structural.
   * Both are small, so eager costs nothing.
   */
  identifiers: Array<{ scheme: string; value: string }>
  retrievalStatus: string | null
  /** The work as a citable record, for a stage that hands it to another app. */
  bibliographicRecord: BibliographicRecord | null
}

/**
 * Everything a hosted stage could need, resolved EAGERLY in main.
 *
 * Eager rather than an RPC pull-back because the alternative buys nothing: the
 * inputs are already materialised in `stage_artifact` as JSON, so main is not
 * doing work it would otherwise avoid, and a lazy protocol would add a
 * round-trip plus a second failure mode to every `ctx.input` call. The measured
 * worst case for a 300-page paper is single-digit megabytes; `MAX_ENVELOPE_BYTES`
 * is the guard against a future stage whose input is not text.
 */
export interface DispatchMessage {
  kind: 'dispatch'
  /**
   * Monotonic per dispatch, NOT the job id.
   *
   * A killed host's last messages can still be in flight when its replacement
   * is dispatched for the same job. Discriminating on the job id alone would
   * let a dead execution's outcome be accepted as the live one's; the token
   * makes a late message unambiguously stale.
   */
  token: number
  stageId: string
  workId: number
  documentId: number
  projectId: number
  stageRunId: number
  jobId: number
  fanOut: FanOutKey | null
  subject: HostWorkSubject
  /** The model main will call on the host's behalf, for provenance. */
  llmModel: string
  /**
   * How long, in ms, this stage's host is given to stop cooperatively before it
   * is killed — the stage's own `cancelGraceMs`.
   *
   * It travels in the envelope because the pool holds no `StageDefinition` and
   * never should: it dispatches bodies, it does not interpret them. `0` means
   * kill immediately, which is right for a stage measured to be unable to
   * observe an abort at all — nothing inside a tesseract page or an ONNX batch
   * sees the cooperative message, so a grace period there is time spent waiting
   * for a cancel that cannot arrive.
   */
  cancelGraceMs: number
  /** Resolved values for every capability the stage requires. */
  inputs: Array<[Capability, unknown]>
}

export interface CancelMessage {
  kind: 'cancel'
  token: number
}

/** Main's answer to an `llm-request`. */
export interface LlmReplyMessage {
  kind: 'llm-reply'
  token: number
  callId: number
  ok: boolean
  text?: string
  error?: string
}

export type ToHostMessage = DispatchMessage | CancelMessage | LlmReplyMessage | { kind: 'shutdown' }

export interface ProgressMessage {
  kind: 'progress'
  token: number
  pct: number
  note?: string
}

export interface LogMessage {
  kind: 'log'
  token: number
  message: string
}

/**
 * The host asking main to make an LLM call on its behalf.
 *
 * The host has no gateway credential and no network primitive, so this is the
 * ONLY way it can reach a model — and main holds the size-1 gate for the
 * duration, so a hosted stage contends for the same single slot as an inline
 * one. Two gates would each read as satisfied while two requests were live.
 */
export interface LlmRequestMessage {
  kind: 'llm-request'
  token: number
  callId: number
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  opts?: { model?: string; maxTokens?: number }
}

export interface ResultMessage {
  kind: 'result'
  token: number
  outcome: StageOutcome
  /** `ctx.emit`ed capability values. */
  emitted: Array<[Capability, unknown]>
  /** `ctx.write`n payloads, applied in main by the stage's own `applyWrites`. */
  writes: unknown[]
}

export interface ReadyMessage {
  kind: 'ready'
  pid: number
}

export type FromHostMessage =
  | ReadyMessage
  | ProgressMessage
  | LogMessage
  | LlmRequestMessage
  | ResultMessage

/**
 * Environment variables a host is allowed to inherit.
 *
 * An ALLOW-LIST, because `utilityProcess.fork`'s `env` REPLACES the environment
 * rather than extending it. Two consequences that have to be got right at the
 * same time:
 *   - the gateway credential (`CORPUS_LLM_*`) must NOT be here. It is the
 *     fourth barrier in front of the size-1 gate: a host physically cannot
 *     construct a gateway request, so `ctx.llm` really is the only route.
 *   - `PATH`, `HOME`, `TMPDIR` and their Windows equivalents MUST be here.
 *     Omitting them does not harden anything — it breaks `spawn('qpdf')`,
 *     every temp file, and every library that resolves a cache directory.
 */
export const HOST_ENV_ALLOW = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TEMP',
  'TMP',
  'APPDATA',
  'LOCALAPPDATA',
  'SystemRoot',
  'windir',
  'LANG',
  'LC_ALL',
  'TZ',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'ELECTRON_RUN_AS_NODE'
] as const

export function hostEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of HOST_ENV_ALLOW) {
    const v = source[key]
    if (typeof v === 'string') out[key] = v
  }
  return out
}
