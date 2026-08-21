// LLM provider — ported 1:1 in spirit from ai-detector's communicator client
// (app/ml/app/services/communicator.py).
//
// ONE provider reaches a model: `CommunicatorLlmProvider`, talking to the real
// gateway. When no gateway will answer, the app selects `UnavailableLlmProvider`,
// which REFUSES every call rather than answering it. There is deliberately no
// third option — an offline stand-in that returns well-formed JSON is
// indistinguishable, downstream, from a model that read the paper, and every
// provenance record it touches becomes a claim nobody can check.
//
// Which provider answered is recorded on every run (`analysis_run.provider`,
// `stage_run.model`) and surfaced, because a fixture presented as a model
// reading is the failure this whole app exists to prevent.

import { logLlmCall, logLlmError, logLlmResponse } from '../devlog'
import { recordTokenUsage } from './tokenLedger'
import { LLM_GATE } from '../pipeline/gate/llmGate'
import { gatewayDispatcher } from './dispatcher'
import { type GatewayCredential } from './gateway'

// ---------------------------------------------------------------- types
/**
 * One image attached to a message, as raw bytes.
 *
 * Kept as a Buffer rather than a data URL so the caller never has to think
 * about encoding, and so the size a request will actually carry is visible at
 * the call site: base64 inflates by a third, and an image is the one part of a
 * prompt that can silently dwarf everything else.
 */
export interface LlmImage {
  png: Buffer
  /** Shown to the model beside the picture, so it knows what it is looking at. */
  caption?: string
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  /**
   * Pictures the model should READ, when the text cannot be trusted.
   *
   * A table's text layer is not a faithful record of it: this corpus stores
   * `0 . 29 6 0 . 11` for `0.29 ± 0.11`. The crop is the primary source for the
   * VALUE; the text in `content` remains the source for WHERE the value sits,
   * so evidence is still cited by paragraph and still checked against the text.
   */
  images?: LlmImage[]
}

export interface CallOpts {
  model?: string
  maxTokens?: number
  effort?: 'low' | 'medium' | 'high'
  /**
   * The CALLER's cancellation, distinct from the gate's own wall-clock abort.
   *
   * Load-bearing rather than a nicety: without it a cancelled job's in-flight
   * call keeps the single process-wide slot until the 15-minute cap, so one
   * dismissed paper silently stops every other LLM job in the app. It also
   * splices a waiter out of the FIFO, so a job cancelled while QUEUED is never
   * handed a slot it no longer wants.
   */
  signal?: AbortSignal
}

export interface LlmProvider {
  readonly name: string
  readonly model: string
  /** Return raw text for a chat completion. */
  callLLM(messages: LlmMessage[], opts?: CallOpts): Promise<string>
}

// ---------------------------------------------------------------- extractJson
// Port of communicator._extract_json: strip ```json fences, else brace-balanced
// scan for the first top-level {}.

/**
 * Requote a `pN` paragraph token the model wrote as a bare word.
 *
 * The prompt names paragraphs `[p17]` and asks for the id back, and a model
 * regularly echoes the tag it was shown: `"paragraph": [p17]`. That is not
 * JSON, so the whole answer parsed as nothing — one 79-fact extraction became a
 * schema-repair round that re-sent a TRUNCATED document under "do not re-read",
 * and what came back was five paraphrases citing paragraph 0. Every one was
 * correctly discarded for unfindable evidence; 74 findable facts went with them.
 *
 * This runs ONLY after a strict parse has already failed, and only OUTSIDE
 * string literals — where valid JSON can never contain a bare `pN` — so it
 * cannot alter any document that parses, and cannot touch a quote. It recovers
 * an id the model literally wrote; it never supplies one it did not. If the
 * rewrite still does not parse, the answer is still rejected.
 */
function requoteBareParagraphTokens(text: string): string {
  let out = ''
  let inStr = false
  let esc = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      out += ch
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
      out += ch
      continue
    }
    if ((ch === 'p' || ch === 'P') && /[0-9]/.test(text[i + 1] ?? '')) {
      let j = i + 1
      while (j < text.length && /[0-9]/.test(text[j])) j++
      out += text.slice(i + 1, j)
      i = j - 1
      continue
    }
    out += ch
  }
  return out
}

export function extractJson(text: string): unknown | null {
  if (!text) return null
  const trimmed = text.trim()

  const parse = (candidate: string): unknown | null => {
    try {
      return JSON.parse(candidate)
    } catch {
      try {
        return JSON.parse(requoteBareParagraphTokens(candidate))
      } catch {
        return null
      }
    }
  }

  // 1) fenced ```json ... ``` (or bare ``` ... ```)
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence && fence[1]) {
    const parsed = parse(fence[1].trim())
    if (parsed !== null) return parsed
    /* fall through to brace scan */
  }

  // 2) brace-balanced scan for the first top-level object
  const start = trimmed.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return parse(trimmed.slice(start, i + 1))
    }
  }
  return null
}

// ---------------------------------------------------------------- gate
/**
 * The one gate every LLM call passes through, whoever is calling.
 *
 * ONE, not two: a `runPipeline` job and a pipeline stage must contend for the
 * SAME slot, or each would hold its own and two requests would be in flight
 * while both gates read as satisfied. So this delegates rather than counting
 * for itself — a provider is the only thing that acquires it, and a stage
 * reaches an LLM only by calling a provider.
 *
 * `fn` receives the gate's abort signal so a provider can cancel the request
 * itself when the wall-clock cap fires. `signal` is the CALLER's cancellation,
 * which the gate honours both while waiting and while holding.
 */
export const GLOBAL_LLM_SEMAPHORE = {
  async run<T>(fn: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return LLM_GATE.run(fn, { signal })
  }
}

// ---------------------------------------------------------------- retry
// 529 is Anthropic's "overloaded", passed through verbatim by the gateway, and
// is as retryable as a 503 — omitting it burns a job's whole attempt budget on
// a condition that clears by itself.
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504, 529])

export class TransientLlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /**
     * Seconds the SERVER asked us to wait, when it said. Honoured over our own
     * backoff: a 900 s window answered with a 100 ms retry is four wasted
     * attempts and then a failure the user is told to investigate.
     */
    readonly retryAfterSec?: number
  ) {
    super(message)
    this.name = 'TransientLlmError'
  }
}

/**
 * The model ran out of output budget mid-answer (`finish_reason: "length"`).
 *
 * Distinct from a malformed answer, because the cause and the remedy are
 * different: nothing is wrong with the model or the prompt, the ceiling is
 * simply too low for what was asked, and the fix is to raise it or ask for
 * less. Left undetected it arrives as unparseable JSON and gets recorded as the
 * model returning something unusable — an accusation aimed at the wrong party,
 * and one that hides a defect a person could have fixed in a line.
 */
export class TruncatedLlmError extends Error {
  constructor(
    readonly completionTokens: number,
    /** What did arrive, for a caller that can salvage whole records from it. */
    readonly partial: string
  ) {
    super(
      `the model's answer was cut off at the ${completionTokens}-token output limit; it is incomplete, not wrong`
    )
    this.name = 'TruncatedLlmError'
  }
}

export function isTruncated(err: unknown): err is TruncatedLlmError {
  return err instanceof TruncatedLlmError || (err as { name?: string })?.name === 'TruncatedLlmError'
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Longest one backoff may hold the single LLM slot. */
const MAX_BACKOFF_MS = 30_000

/** Port of communicator retry: 4 attempts, exponential backoff on transient errors. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      // A connection-level failure (the gateway container is stopped) is
      // TRANSIENT, and matched explicitly rather than left to the HTTP-status
      // set: a stopped gateway container never produces a status at all, and
      // treating "no connection" as permanent would fail every queued job in
      // seconds over the one condition most likely to clear on its own.
      const transient =
        err instanceof TransientLlmError ||
        (err instanceof Error &&
          // `UND_ERR_*` are undici's own: a headers/body timeout or a socket
          // torn down mid-response. They arrive as an ordinary Error whose
          // message names the code, and omitting them made a client-side
          // timeout the one network condition that was NOT retried.
          /ECONN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR_|socket hang up|network|fetch failed|terminated/i.test(
            err.message
          ))
      if (!transient || attempt === attempts - 1) throw err
      const asked =
        err instanceof TransientLlmError && err.retryAfterSec ? err.retryAfterSec * 1000 : 0
      // Capped: a limiter naming a 15-minute window would otherwise hold the
      // single process-wide slot for that whole window, stopping every other
      // paper. Past the cap the attempt is spent and the job's own backoff —
      // which does NOT hold the slot — takes over.
      await sleep(Math.min(Math.max(asked, 2 ** attempt * 100), MAX_BACKOFF_MS))
    }
  }
  throw lastErr
}

// ---------------------------------------------------------------- no provider

/**
 * No model can be reached, and this call will not pretend otherwise.
 *
 * A distinct type rather than a plain `Error` so every caller can tell "the
 * gateway is down" apart from "the model answered something unusable" — the two
 * demand opposite handling, and a stage that conflates them reports an outage as
 * a finding about the paper.
 *
 * Deliberately NOT a `TransientLlmError`: retrying costs a job its whole attempt
 * budget against a condition that no amount of waiting inside one call will
 * change. The pre-flight in `select.ts` is where reachability is re-decided.
 */
export class LlmUnavailableError extends Error {
  /**
   * A stable marker that survives serialisation.
   *
   * `instanceof` does not cross the stage-host boundary: a host rejects with a
   * plain `Error` rebuilt from a string, so the class is lost and the receiver
   * silently falls back to treating an outage as an ordinary failure. The code
   * is carried in the MESSAGE (the only field that survives) and matched by
   * `isLlmUnavailable`, which is the check every consumer should use.
   */
  static readonly CODE = 'E_LLM_UNAVAILABLE'

  constructor(readonly why: string) {
    super(`${LlmUnavailableError.CODE}: ${why}`)
    this.name = 'LlmUnavailableError'
  }
}

/**
 * Whether this error means "no model could be reached", however it travelled.
 *
 * Checks the class first (in-process) and the code second (across a host
 * boundary, where the class is gone). Use this rather than `instanceof`.
 */
export function isLlmUnavailable(err: unknown): boolean {
  if (err instanceof LlmUnavailableError) return true
  return err instanceof Error && err.message.includes(LlmUnavailableError.CODE)
}

/**
 * The provider selected when nothing will answer.
 *
 * It exists so the rest of the app keeps ONE shape — a `LlmProvider` is always
 * present, `ctx.llm.call` is always callable — while the honest outcome ("no
 * model could be reached") travels as a thrown error that stages already know
 * how to turn into a `failed`/`refused` status. The alternative, a nullable
 * provider, pushes an `if (!llm)` into every call site and each one of those is
 * a chance to silently do nothing and call it success.
 *
 * `model` and `name` are stamped nowhere, because no run is ever produced: the
 * call throws before any work happens. They exist for the status UI to render.
 */
export class UnavailableLlmProvider implements LlmProvider {
  readonly name = 'unavailable'
  readonly model = 'none'
  constructor(readonly why: string) {}

  async callLLM(): Promise<string> {
    throw new LlmUnavailableError(this.why)
  }
}

// ---------------------------------------------------------------- real provider

/**
 * What one completion cost, for the run that is about to be stamped.
 *
 * INPUT ARRIVES IN THREE PARTS, and `promptTokens` is only the first of them.
 * Anthropic reports uncached input, cache WRITES and cache READS separately, and
 * the gateway passes all three through; a client reading only `prompt_tokens`
 * sees the uncached remainder alone. On this corpus that meant a schema
 * extraction sending 66 KB of paper reported `promptTokens: 3` — the other
 * ~16,700 were a cache write nobody looked at.
 *
 * They are kept apart rather than summed because they are not billed alike: a
 * cache read is a small fraction of the base rate and a cache write is more than
 * it, so one merged integer cannot be turned back into a cost. `inputTokens()`
 * is the total for anything that just wants "how much went in".
 */
export interface LlmUsage {
  /** Input billed at the base rate — NOT the whole prompt. See above. */
  promptTokens: number
  /** Input written INTO the cache on this call. */
  cacheCreationTokens: number
  /** Input served FROM the cache on this call. */
  cacheReadTokens: number
  completionTokens: number
  totalTokens: number
}

/** Everything that went in, however it was billed. */
export function inputTokens(u: LlmUsage): number {
  return u.promptTokens + u.cacheCreationTokens + u.cacheReadTokens
}

/**
 * The real gateway client.
 *
 * Every call goes through `GLOBAL_LLM_SEMAPHORE`, exactly like the mock: the
 * one-in-flight guarantee is a property of the GATE, and a provider that
 * acquired its own would be a second slot wearing the same name.
 */
export class CommunicatorLlmProvider implements LlmProvider {
  readonly name = 'communicator'
  /** Usage of the most recent completion, for a caller that stamps provenance. */
  lastUsage: LlmUsage | null = null
  /**
   * Everything this provider has spent, since it was constructed.
   *
   * A batch's cost is a number the user is entitled to and a number a
   * verification run has to be able to report. Accumulated here rather than
   * summed from `analysis_run` because not every LLM call produces one — the
   * citation-role residue writes into `citation_context`, and a total that
   * silently omitted it would understate what the batch actually cost.
   */
  readonly totals: LlmUsage & { calls: number } = {
    calls: 0,
    promptTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    completionTokens: 0,
    totalTokens: 0
  }

  constructor(
    readonly model = 'claude-haiku-4-5-20251001',
    // REQUIRED. It used to default to `gatewayUrl()`, which itself defaulted to
    // loopback — so a provider could be built pointing at an address nobody
    // chose. `selectProvider` is the only thing that constructs one, and it has
    // already established that an endpoint is configured before it gets here.
    private readonly baseUrl: string,
    private readonly credential: GatewayCredential | null = null
  ) {}

  async callLLM(messages: LlmMessage[], opts: CallOpts = {}): Promise<string> {
    // Counts CONVERSATIONS, not calls: `withRetry` is inside the gate, so one
    // logical call can be several exchanges and the developer log has to be
    // able to tell a retried truncation from a clean first answer.
    let attempt = 0
    return GLOBAL_LLM_SEMAPHORE.run(
      async (signal) =>
        withRetry(async () => {
          const key = this.credential?.reveal() ?? ''
          attempt++
          const startedMs = Date.now()
          const model = opts.model ?? this.model
          logLlmCall({
            model,
            attempt,
            // The messages BEFORE `toWireMessages`, so the prompt reads as
            // written rather than as a parts array. Images are counted, never
            // inlined: a few base64 table crops would bury the text.
            messages: messages.map((m) => ({
              role: m.role,
              content: m.content,
              ...(m.images?.length ? { images: m.images.length } : {})
            })),
            maxTokens: opts.maxTokens ?? 4096,
            images: messages.reduce((n, m) => n + (m.images?.length ?? 0), 0),
            // SIZES, never the bytes. A request that is slow or refused for
            // being too large is otherwise indistinguishable from one the model
            // simply took a long time over, and base64 inflates by a third —
            // which is the difference the log has to be able to show.
            imageBytes: messages.flatMap((m) => (m.images ?? []).map((i) => i.png.byteLength))
          })
          // `dispatcher` is a Node/undici extension of `RequestInit`, whose
          // declared type names undici's `Dispatcher` — a type we deliberately
          // do not import. Widened to `unknown` here rather than typed, since
          // the only value ever assigned is the shared gateway Agent.
          const init: RequestInit = {
            method: 'POST',
            // The gate's wall-clock cap fires through here. Without it the cap
            // could only stop WAITING for the response while the socket stayed
            // open, so the slot would move on beside a live request.
            //
            // Note what this does NOT do: `chatRoutes.js` guards its upstream
            // abort on `!ctx.req.complete`, already true for a fully-read
            // non-streaming body, so aborting here frees OUR slot and leaves the
            // model generating. That is why the cap is 15 minutes and not 30
            // seconds — an eager client timeout abandons paid work rather than
            // saving it.
            signal,
            // BOTH auth headers, because which one is accepted depends on what
            // sits in FRONT of the gateway. The gateway takes either
            // (`apiKeyAuth.js` reads Authorization first, then x-api-key), but a
            // reverse proxy publishing it may forward only one: a deployment
            // behind nginx answered a Bearer-only request with 404 — not 401 —
            // so the endpoint read as a route that does not exist, while the
            // same request carrying `x-api-key` returned a completion. Sending
            // both costs nothing and removes a failure that disguises itself as
            // a wrong URL.
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${key}`,
              'x-api-key': key
            },
            body: JSON.stringify({
              model: opts.model ?? this.model,
              // Explicit rather than defaulted: `api` bills per token against an
              // ANTHROPIC_API_KEY this deployment does not set, so letting the
              // gateway choose would fail loudly on a config change made
              // elsewhere.
              api_mode: 'oauth',
              messages: toWireMessages(messages),
              max_tokens: opts.maxTokens ?? 4096,
              effort: opts.effort ?? 'medium',
              stream: false
            })
          }
          ;(init as Record<string, unknown>).dispatcher = gatewayDispatcher()

          const res = await fetch(`${this.baseUrl}/api/chat/completions`, init)

          if (TRANSIENT_STATUS.has(res.status)) {
            // `retryAfter` is in the BODY, in seconds. There is no `Retry-After`
            // header on this gateway, so a client that reads only headers backs
            // off on its own schedule and hammers a limiter that already told it
            // how long to wait.
            const retryAfter = await readRetryAfter(res)
            logLlmError({
              model,
              attempt,
              durationMs: Date.now() - startedMs,
              error: describeStatus(res.status)
            })
            throw new TransientLlmError(describeStatus(res.status), res.status, retryAfter)
          }
          if (!res.ok) {
            logLlmError({
              model,
              attempt,
              durationMs: Date.now() - startedMs,
              error: describeStatus(res.status)
            })
            throw new Error(describeStatus(res.status))
          }

          const data = (await res.json()) as {
            // RAW OpenAI shape. `/api/chat/completions` sets `ctx.body = result`
            // with no `{success,data}` envelope — that wrapper exists only on
            // `/api/prompts*`, and a client that unwraps `.data` here reads
            // undefined and reports every completion as empty.
            choices?: Array<{ message?: { content?: string }; finish_reason?: string }>
            usage?: {
              prompt_tokens?: number
              completion_tokens?: number
              total_tokens?: number
              // The rest of the input. Anthropic splits it three ways and the
              // gateway forwards all three; reading only `prompt_tokens` here
              // reported a 66 KB prompt as 3 tokens.
              cache_creation_input_tokens?: number
              cache_read_input_tokens?: number
            }
          }
          const u = data.usage
          this.lastUsage = u
            ? {
                promptTokens: u.prompt_tokens ?? 0,
                cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
                cacheReadTokens: u.cache_read_input_tokens ?? 0,
                completionTokens: u.completion_tokens ?? 0,
                // RECOMPUTED, never taken from `total_tokens`: the gateway sums
                // only the two fields it maps, so the reported total omits the
                // cache halves and is smaller than the parts it is made of.
                totalTokens:
                  (u.prompt_tokens ?? 0) +
                  (u.cache_creation_input_tokens ?? 0) +
                  (u.cache_read_input_tokens ?? 0) +
                  (u.completion_tokens ?? 0)
              }
            : null
          this.totals.calls++
          if (this.lastUsage) {
            this.totals.promptTokens += this.lastUsage.promptTokens
            this.totals.cacheCreationTokens += this.lastUsage.cacheCreationTokens
            this.totals.cacheReadTokens += this.lastUsage.cacheReadTokens
            this.totals.completionTokens += this.lastUsage.completionTokens
            this.totals.totalTokens += this.lastUsage.totalTokens
          }
          const choice = data.choices?.[0]
          const truncated = choice?.finish_reason === 'length'

          // Recorded BEFORE the throw below, because a response cut off at the
          // ceiling was paid for in full: a ledger that drops the expensive
          // failures reports the corpus as cheaper than the invoice.
          //
          // Only when the gateway actually reported usage. A transport failure
          // comes back with no `usage` at all, and writing zeros there would put
          // a fabricated number in the same column as a measured one — so those
          // calls get no row rather than a free-looking one.
          if (this.lastUsage) {
            recordTokenUsage({
              model,
              provider: this.name,
              attempt,
              ok: !truncated,
              failure: truncated ? 'truncated' : null,
              promptTokens: this.lastUsage.promptTokens,
              cacheCreationTokens: this.lastUsage.cacheCreationTokens,
              cacheReadTokens: this.lastUsage.cacheReadTokens,
              completionTokens: this.lastUsage.completionTokens,
              totalTokens: this.lastUsage.totalTokens,
              durationMs: Date.now() - startedMs
            })
          }

          // A response cut off at the token ceiling is NOT an answer. Its JSON
          // ends mid-string, so the caller's parse fails and the run is filed as
          // "the model returned something unusable" — which reads as the model's
          // fault and hides the real, fixable cause. On this corpus that was 29
          // of 40 extraction runs: a 12-variant kinetics table simply does not
          // fit in the ceiling, and every one of those papers reported
          // `succeeded — 0 fact(s)` while the model had been extracting
          // correctly right up to the guillotine.
          if (truncated) {
            logLlmError({
              model,
              attempt,
              durationMs: Date.now() - startedMs,
              error: 'response hit the output token ceiling and is incomplete',
              partial: choice?.message?.content ?? ''
            })
            throw new TruncatedLlmError(
              this.lastUsage?.completionTokens ?? opts.maxTokens ?? 0,
              choice?.message?.content ?? ''
            )
          }
          logLlmResponse({
            model,
            attempt,
            durationMs: Date.now() - startedMs,
            finishReason: choice?.finish_reason ?? null,
            // The WHOLE prompt, cache halves included. Logging `prompt_tokens`
            // alone is what made a 66 KB extraction read as 3 tokens.
            promptTokens: this.lastUsage ? inputTokens(this.lastUsage) : null,
            cacheCreationTokens: this.lastUsage?.cacheCreationTokens ?? null,
            cacheReadTokens: this.lastUsage?.cacheReadTokens ?? null,
            completionTokens: this.lastUsage?.completionTokens ?? null,
            // VERBATIM, before `extractJson` sees it. The fence-stripping and
            // brace-scanning are themselves candidates when an answer comes out
            // wrong, so a log of the post-parse value could not exonerate them.
            raw: choice?.message?.content ?? ''
          })
          return choice?.message?.content ?? ''
        }),
      opts.signal
    )
  }
}


/**
 * Put messages on the wire in the shape the gateway expects.
 *
 * A text-only message keeps its plain string `content`, byte for byte — this is
 * every existing call, and changing their shape would change `promptInputHash`
 * on every stored run for no reason. Only a message carrying images becomes the
 * multimodal array, with the TEXT FIRST so the model reads the instruction and
 * the paragraph tags before it looks at the picture.
 */
function toWireMessages(messages: LlmMessage[]): unknown[] {
  return messages.map((m) => {
    if (!m.images || m.images.length === 0) return { role: m.role, content: m.content }
    const parts: unknown[] = [{ type: 'text', text: m.content }]
    for (const img of m.images) {
      if (img.caption) parts.push({ type: 'text', text: img.caption })
      parts.push({
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${img.png.toString('base64')}` }
      })
    }
    return { role: m.role, content: parts }
  })
}

/** A status the user can act on, with no credential and no upstream body in it. */
function describeStatus(status: number): string {
  switch (status) {
    case 401:
    case 403:
      return `gateway ${status}: this app’s API key was rejected`
    case 429:
      return 'gateway 429: rate limited'
    case 500:
      // NOT an auth error to the user, and NOT a reason to restart anything.
      // The gateway is a remote service and a 500 is everything that went wrong
      // BEHIND it, so guessing at the cause — this used to name an expired
      // Claude token — describes one deployment's failure mode as though it
      // were the general case.
      return 'gateway 500: the gateway hit an error of its own'
    case 529:
      return 'gateway 529: the model is overloaded'
    default:
      return `gateway ${status}`
  }
}

async function readRetryAfter(res: Response): Promise<number | undefined> {
  try {
    const body = (await res.clone().json()) as { error?: { retryAfter?: number } }
    const n = body.error?.retryAfter
    return typeof n === 'number' && n > 0 ? n : undefined
  } catch {
    return undefined
  }
}
