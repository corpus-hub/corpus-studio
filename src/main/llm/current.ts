import type { LlmStatusDTO } from '../../shared/contract'
import type { LlmProvider } from './provider'
import type { ProviderSelection } from './select'

/**
 * The LLM provider currently in force, reachable WITHOUT importing `index.ts`.
 *
 * Two module-scope values, one home. `settings:setGatewayConfig` re-runs the
 * pre-flight and REPLACES both of them at runtime, so anything that captured the
 * provider object at import time would keep calling a provider the user has
 * already replaced — a run stamped with a model that is no longer the one the
 * app talks to. Every reader therefore goes through the getter, every time.
 *
 * `selection` is the WHY: which provider was chosen, whether it is live, and the
 * reason. The renderer reads it so a result never has to be taken on trust as a
 * model's, and it is a separate value because a provider can be swapped without
 * the explanation staying true.
 *
 * This module deliberately imports nothing but types: it is reached from IPC
 * registry entries, which must stay free of `electron`.
 */
let provider: LlmProvider | null = null
let selection: ProviderSelection | null = null

/**
 * Told whenever the selection is REPLACED, so nothing has to poll to find out.
 *
 * The renderer's indicator and main's own logging both need to hear this, and a
 * getter alone cannot tell them: a pill rendered once at mount keeps reporting
 * the outage it was born in long after the gateway came back. Listeners rather
 * than a direct `webContents.send` because this module may not import
 * `electron` — the window layer subscribes from where it is allowed to.
 */
type SelectionListener = (next: ProviderSelection) => void
const listeners = new Set<SelectionListener>()

/** Subscribe to selection changes. Returns its own unsubscribe. */
export function onLlmSelectionChanged(fn: SelectionListener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/**
 * The provider in force.
 *
 * THROWS rather than returning null when startup has not chosen one yet. A
 * caller reaching for the model before the pre-flight has run is a bug in the
 * startup order, and a null slipping through would surface much later as a
 * property access on undefined, far from its cause.
 */
export function getLlmProvider(): LlmProvider {
  if (!provider) throw new Error('the LLM provider is not selected yet')
  return provider
}

/** The provider, or null when startup has not chosen one — for status reads only. */
export function peekLlmProvider(): LlmProvider | null {
  return provider
}

/** Why this provider, or null before the first selection. */
export function getLlmSelection(): ProviderSelection | null {
  return selection
}

/**
 * The selection as the renderer reads it.
 *
 * ONE shaping, because there are now two ways it reaches a window — the
 * `settings:llmStatus` request and the push that follows a re-probe — and two
 * shapings that drift is how the pill and the Settings panel come to disagree
 * about whether a model can be reached.
 */
export function llmStatusNow(): LlmStatusDTO {
  const sel = getLlmSelection()
  if (!sel) {
    return {
      live: false,
      provider: 'none',
      model: 'none',
      reason: 'The analysis provider has not been resolved yet.',
      token_minutes: null
    }
  }
  return {
    live: sel.live,
    provider: sel.provider.name,
    model: sel.provider.model,
    reason: sel.reason,
    token_minutes: sel.health?.tokenMinutes ?? null
  }
}

/**
 * Record a completed selection. Both values move together, always — a provider
 * paired with the reasoning for a DIFFERENT provider is worse than no reasoning.
 */
export function setLlmSelection(next: ProviderSelection): void {
  selection = next
  provider = next.provider
  for (const fn of listeners) {
    try {
      fn(next)
    } catch {
      /* a listener failure must never break provider selection: the point of
         this call is that the app now has a working model, and dropping that
         because a window went away mid-notify would be the worse outcome. */
    }
  }
}
