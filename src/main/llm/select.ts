// WHICH provider answered, and why.
//
// There is only one provider that answers: the real gateway. When it cannot be
// reached, this returns `UnavailableLlmProvider`, which refuses every call — it
// does NOT substitute stored responses, because a stand-in that returns
// well-formed JSON produces runs whose provenance claims a model read a paper
// that no model ever saw.
//
// The pre-flight is a BATCH-level decision on purpose. Discovering an outage
// once, before any paper starts, is the difference between one honest message
// and twenty papers each burning their attempt budget on the same dead socket.

import { probeGateway, resolveCredential, gatewayUrl, type GatewayHealth } from './gateway'
import { CommunicatorLlmProvider, UnavailableLlmProvider, type LlmProvider } from './provider'

export interface ProviderSelection {
  provider: LlmProvider
  /** `true` when a real model will answer. */
  live: boolean
  /**
   * Why, in words a scientist can act on. Shown in the UI verbatim, so it names
   * the remedy where there is one and never contains the credential.
   */
  reason: string
  /** Where the credential came from, or null when there was none. */
  credentialOrigin: string | null
  health: GatewayHealth | null
}

/**
 * `CORPUS_LLM_MODE`:
 *   `auto`  (default) use the gateway when it answers; refuse LLM work when it
 *           does not, and say so
 *   `live`  refuse to START at all unless the gateway answers — for a batch run
 *           where discovering the outage twenty papers in is worse than not
 *           starting
 *
 * There is no offline-fixture mode. That is the point of this file.
 */
export type LlmMode = 'auto' | 'live'

/**
 * `CORPUS_LLM_MODE=live` was asked for and the gateway cannot serve it.
 *
 * Its own type rather than a plain Error so the startup handler can tell this
 * apart from a database failure — which it could not, and so reported an
 * unreachable gateway as a corrupt corpus.
 */
export class GatewayUnavailableError extends Error {
  constructor(readonly why: string) {
    super(`the LLM gateway is not usable and CORPUS_LLM_MODE=live: ${why}`)
    this.name = 'GatewayUnavailableError'
  }
}

/** Whether the endpoint is on this machine. Unparseable counts as remote. */
function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]'
  } catch {
    return false
  }
}

export function llmMode(): LlmMode {
  const raw = (process.env.CORPUS_LLM_MODE ?? 'auto').trim().toLowerCase()
  return raw === 'live' ? 'live' : 'auto'
}

export async function selectProvider(
  opts: { model?: string; mode?: LlmMode } = {}
): Promise<ProviderSelection> {
  const mode = opts.mode ?? llmMode()

  const credential = resolveCredential()
  // Capped, but not equally: this runs on the startup path, before the window
  // exists. A gateway on LOOPBACK answers in milliseconds and an absent one
  // refuses instantly, so the only case that can reach 2.5 s is a process
  // listening and wedged. A REMOTE one has a DNS lookup, a round trip and a TLS
  // handshake to do first, and 2.5 s is inside the range a healthy one takes —
  // which would report a working gateway as unreachable on every cold start.
  const url = gatewayUrl()
  // NOTHING CONFIGURED is its own answer, and it is reached WITHOUT a probe.
  // There is no default endpoint to fall back on, so there is nothing to ask —
  // and a connection error against a guessed address would describe a gateway
  // the user never named as unreachable, sending them to debug a URL that is
  // not theirs. This says the true thing: the app has not been told where to
  // look, which is a setting they can go and fill in.
  if (!url || !credential) {
    const why = !url
      ? 'no gateway endpoint is configured — set one in Settings'
      : 'no gateway API key is configured — set one in Settings'
    if (mode === 'live') throw new GatewayUnavailableError(why)
    return {
      provider: new UnavailableLlmProvider(why),
      live: false,
      reason: `No model can be reached — ${why}. Analyses cannot be run; nothing will be produced in the meantime.`,
      credentialOrigin: credential?.origin ?? null,
      health: null
    }
  }
  // The CREDENTIAL goes in too: what publishes a remote gateway may refuse an
  // unauthenticated probe outright, and a pre-flight failing for a reason the
  // real call would not have refuses a gateway that works.
  const health = await probeGateway(url, isLoopback(url) ? 2500 : 8000, credential)

  if (!health.ok) {
    const why = health.reason
    if (mode === 'live') {
      // A DISTINCT error type, so the startup handler can name this cause
      // instead of reporting every failure as a database problem.
      throw new GatewayUnavailableError(why)
    }
    return {
      // Everything else in the app keeps working — the corpus, the reader, the
      // graph, every analysis already stored. Only NEW model work is refused,
      // and it is refused loudly at the point of the call.
      provider: new UnavailableLlmProvider(why),
      live: false,
      // The CONDITION and its CONSEQUENCE, with no remedy attached: the gateway
      // is someone else's service and this app cannot know what fixing it takes.
      reason: `No model can be reached — ${why}. Analyses cannot be run; nothing will be produced in the meantime.`,
      credentialOrigin: credential.origin,
      health
    }
  }

  // The model the gateway will actually route to, resolved against what it says
  // it serves. Sending an id it does not know fails the whole batch on the first
  // paper with an error about the config rather than about the science.
  //
  // When it cannot be resolved the answer is the SAME refusal as an unreachable
  // gateway, and for the same reason: the alternative is a run stamped with a
  // model that never read the paper. It is a batch-level decision, so it is
  // taken here rather than discovered per paper, and in `live` mode it stops
  // the run from starting at all.
  let model: string
  try {
    model = pickModel(opts.model, health.models)
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    if (mode === 'live') throw new GatewayUnavailableError(why)
    return {
      provider: new UnavailableLlmProvider(why),
      live: false,
      reason: `No model can be used — ${why}. Analyses cannot be run; nothing will be produced in the meantime.`,
      credentialOrigin: credential.origin,
      health
    }
  }
  return {
    provider: new CommunicatorLlmProvider(model, url, credential),
    live: true,
    // NOT "the local gateway". The gateway is reached over HTTP at a
    // configurable URL and is not assumed to run anywhere in particular.
    reason: `Live model via the gateway — ${health.reason}.`,
    credentialOrigin: credential.origin,
    health
  }
}

/** The default when nothing is configured: cheapest of the models on offer. */
const PREFERRED = [
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-6',
  'claude-sonnet-5',
  'claude-opus-4-6'
]

/**
 * A model was asked for by name and the gateway does not serve it.
 *
 * Its own type so the caller can map it to a sentence naming the remedy, rather
 * than letting a raw exception reach a screen.
 */
export class ModelUnavailableError extends Error {
  constructor(
    readonly requested: string,
    readonly available: string[]
  ) {
    super(
      available.length > 0
        ? `the model '${requested}' was requested, but the gateway serves only ` +
          `${available.join(', ')} — choose one of those in Settings, or make the gateway ` +
          `route '${requested}'`
        : `the model '${requested}' was requested, but the gateway lists no models at all — ` +
          'it is answering without serving anything, so no analysis can be attributed to a model'
    )
    this.name = 'ModelUnavailableError'
  }
}

/**
 * WHICH model answers, and never a different one than was asked for.
 *
 * A substituted model is stamped into `analysis_run` as provenance, so a silent
 * fallback writes down that a paper was read by a model that never saw it. An
 * explicit request is therefore honoured or refused — never approximated.
 *
 * Choosing automatically is legitimate ONLY when nothing was requested, and only
 * from what the gateway says it serves. An empty list is not a licence to guess
 * the first `PREFERRED`: that id is a hope about someone else's routing table.
 */
export function pickModel(requested: string | undefined, available: string[]): string {
  if (requested) {
    if (available.includes(requested)) return requested
    throw new ModelUnavailableError(requested, available)
  }
  for (const p of PREFERRED) if (available.includes(p)) return p
  const first = available[0]
  if (first) return first
  throw new Error(
    'the gateway is reachable but lists no models, so there is nothing to attribute an ' +
      'analysis to. Check that the gateway has at least one model configured.'
  )
}
