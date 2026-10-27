import { useEffect, useRef, useState } from 'react'
import type { PluginRunState, SharedProjectDTO } from '@shared/contract'

/**
 * The sync indicator, in the sidebar foot directly above Settings.
 *
 * Rendered ONLY when the user is inside a project that is shared. On every other
 * screen, and on every install that shares nothing — which is every fresh one —
 * it renders nothing at all. That is why this file can be an app file rather
 * than a plugin file: with no share it is inert, not absent.
 *
 * IT IS TWO CONTROLS, and which one is decided by the SHARE, not by this file.
 * `onDemand` comes off the DTO because the renderer has no business knowing that
 * one plugin spells its setting "on-demand"; a second plugin offering the same
 * choice needs no change up here.
 *   - automatic: a `<div role="status">`, passive, a report on work already
 *     happening. Pointer feedback is deliberately faint — there is nothing to
 *     press.
 *   - on-demand: a real `<button>`, amber, asking to be pressed. It carries a
 *     resting ring and a chevron the passive form never has, so "you can click
 *     this" survives being read in greyscale.
 *
 * STATE SPACE (HARD RULE 0.5), all distinct on at least TWO channels — hue AND
 * glyph, plus a ring or a rule where hue and glyph would otherwise repeat:
 *   automatic × { ok, syncing, resync, failed, needs-credentials, idle,
 *                 incomplete }
 *   on-demand × { needs-sync, hover, active, focus-visible, busy, disabled,
 *                 failed, failed+hover, incomplete }
 * Every combination is resolved and compared by `scripts/check-sync-states.mjs`,
 * which fails if any two render identically.
 *
 * INCOMPLETE IS NOT A FAILURE, AND IT IS NOT HEALTH. `declinedRows > 0` means the
 * peer offered rows this version cannot store, so this copy is permanently short
 * — syncing is working and pressing again will not recover them. It therefore
 * gets its own hue-plus-dashed-edge treatment and a count, rather than borrowing
 * the red X (which promises a retry will help) or hiding under the green check
 * (which would be the corpus reporting itself whole while it is not).
 *
 * PRECEDENCE: needs-credentials > failed > syncing/resync > incomplete > ok/idle.
 * A live failure outranks the standing shortfall because it is the one the user
 * can act on NOW and because it stops every further row, including any that a
 * future version would accept; the shortfall is then carried in the tooltip so it
 * is never lost. The sharing modal, which has room for a row of badges, states
 * both at once.
 *
 * THE TOOLTIP IS A MAPPED SENTENCE, never an exception message. A raw undici
 * error carries the request URL and sometimes its headers, and this string is
 * rendered verbatim into the user's window.
 */
export function SyncStatusIcon({ share }: { share: SharedProjectDTO }): JSX.Element {
  return share.onDemand ? <SyncButton share={share} /> : <SyncIndicator share={share} />
}

/** Automatic mode: a report, not a control. */
function SyncIndicator({ share }: { share: SharedProjectDTO }): JSX.Element {
  const state = share.state
  const short = share.declinedRows > 0
  // A shortfall REPLACES the run state only where that state is content-free.
  // `ok` and `idle` both say "nothing is happening", so both collapse to the one
  // presented state `incomplete` — deliberately one state and not two, because
  // "finished, and short" and "waiting, and short" are the same thing to look at
  // and the same thing to do about it. `failed`, `syncing`, `resync` and
  // `needs-credentials` each describe something happening NOW, so they keep their
  // own look and take the shortfall as a modifier.
  const quiet = state === 'ok' || state === 'idle'
  const incomplete = short && quiet
  return (
    <div
      className={
        'sync-icon ' +
        (incomplete ? 'is-incomplete' : `is-${state}${short ? ' is-short' : ''}`)
      }
      data-testid="sync-status"
      data-state={state}
      data-mode="automatic"
      data-declined={share.declinedRows || undefined}
      role="status"
      aria-live="polite"
      tabIndex={0}
      data-tip={tip(share)}
    >
      <span className="sync-icon-glyph" aria-hidden="true">
        <Glyph state={incomplete ? 'incomplete' : state} />
      </span>
      <span className="sync-icon-label">{incomplete ? 'Incomplete' : label(state)}</span>
      <Shortfall count={share.declinedRows} />
    </div>
  )
}

/**
 * The count of rows this copy will never hold, as a chip beside the label.
 *
 * RENDERS NOTHING AT ZERO (hard rule 0.6) — a healthy share is the ordinary case
 * and must say nothing at all. It is here rather than in the label because it
 * composes with every state of both controls: a failing share can also be short,
 * and the two facts are different answers.
 *
 * The number is the whole content; the words are in the tooltip, because this
 * slot is 246px wide and a sentence in it would be truncated into a lie.
 */
function Shortfall({ count }: { count: number }): JSX.Element | null {
  if (count <= 0) return null
  return (
    <span className="sync-icon-short mono" data-testid="sync-declined">
      <span aria-hidden="true">{count}</span>
      <span className="sync-icon-short-sr">
        {count === 1 ? '1 row not stored' : `${count} rows not stored`}
      </span>
    </span>
  )
}

/**
 * On-demand mode: the button the setting exists for.
 *
 * `busy` is LOCAL as well as remote. The share's own state goes to `syncing`
 * the moment a cycle starts, but that arrives through a round trip and an event,
 * and the gap between the click and the first repaint is exactly the window in
 * which a user presses again. So the click sets `busy` synchronously and the
 * share state keeps it set — either one alone leaves a moment where the control
 * looks pressable and is not.
 */
function SyncButton({ share }: { share: SharedProjectDTO }): JSX.Element {
  const [pending, setPending] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  // A resolution arriving after this row has gone — the user left the project,
  // or unshared it — must not set state on an unmounted component.
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const remoteBusy = share.state === 'syncing' || share.state === 'resync'
  const busy = pending || remoteBusy
  // The one state a click cannot fix. Everything else is worth another attempt,
  // including `failed` — a relay that was down may be up.
  const blocked = share.state === 'needs-credentials'
  const state: OnDemandState = blocked
    ? 'blocked'
    : busy
      ? 'busy'
      : refused || share.state === 'failed'
        ? 'failed'
        : 'needs-sync'

  // Guarded by a REF as well as by `busy`, because `busy` is the value this
  // render closed over. Two dispatches in one task — a double-click coalesced,
  // a test driving `el.click()` twice — both read the stale `false` and both
  // call through. Main's latch refuses the second, so nothing overlaps; this is
  // what stops the second call being made at all, so the state the button shows
  // is the state it is in.
  const firing = useRef(false)

  const click = async (): Promise<void> => {
    // Checked HERE and not only in `aria-disabled`. `aria-disabled` is a
    // promise to assistive technology, not an enforcement — the element still
    // receives the click, and a second cycle is the one thing the latch in main
    // exists to prevent.
    if (busy || blocked || firing.current) return
    firing.current = true
    setPending(true)
    setRefused(null)
    try {
      const r = await window.api.syncNow()
      // `started: false` means the latch in main refused this press because a
      // cycle was already running — the ordinary answer to an impatient second
      // click, not a failure. Clearing `pending` immediately is the honest
      // response: the spinner belongs to the cycle that IS running, and
      // `remoteBusy` is what keeps it up while that cycle lasts. Holding
      // `pending` instead would keep the button busy after somebody else's
      // cycle had finished.
      if (!r.started && alive.current) setPending(false)
    } catch (err) {
      // A SENTENCE, and only one of the FEW main wrote. Anything else becomes
      // the generic line rather than a raw message: `syncNow` rejects through
      // IPC, which prefixes the string with the channel name, and an error from
      // deeper down can carry a URL.
      setRefused(sentenceOf(err))
    } finally {
      firing.current = false
      if (alive.current) setPending(false)
    }
  }

  // ORTHOGONAL to the four button states, exactly as `is-stop-failed` is to the
  // share row's: a shortfall is true of the corpus and can hold while the button
  // is resting, busy, failed or blocked. It never replaces the button's own word,
  // because that word says what pressing will do and pressing is unaffected.
  const short = share.declinedRows > 0

  return (
    <button
      type="button"
      className={`sync-icon sync-icon-btn is-${state}${short ? ' is-short' : ''}`}
      data-testid="sync-status"
      data-state={share.state}
      data-mode="on-demand"
      data-demand-state={state}
      data-declined={share.declinedRows || undefined}
      aria-disabled={busy || blocked}
      aria-live="polite"
      data-tip={refused ?? demandTip(share, state)}
      onClick={() => void click()}
    >
      <span className="sync-icon-glyph" aria-hidden="true">
        {/* Driven by the BUTTON'S state, not the share's. `share.state` is the
            plugin's vocabulary, and passing it here rendered a green check
            beside the amber "Sync now" — three different glyphs under one
            enumerated state, and a settled tick asserting exactly the thing
            on-demand mode cannot know. */}
        <Glyph state={glyphFor(state, share)} />
      </span>
      <span className="sync-icon-label">{demandLabel(share, state)}</span>
      <Shortfall count={share.declinedRows} />
      {/* The affordance, present ONLY while the control can be pressed: a
          chevron beside a spinner would say "press me" at the one moment
          pressing does nothing. It is what carries "actionable" for a reader
          who cannot see the amber. */}
      {state !== 'busy' && state !== 'blocked' && (
        <span className="sync-icon-go" aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor">
            <path d="M7.5 4.5l6 5.5-6 5.5" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      )}
    </button>
  )
}

type OnDemandState = 'needs-sync' | 'busy' | 'failed' | 'blocked'

function glyphFor(state: OnDemandState, share: SharedProjectDTO): PluginRunState {
  switch (state) {
    case 'busy':
      return share.state === 'resync' ? 'resync' : 'syncing'
    case 'failed':
      return 'failed'
    case 'blocked':
      return 'needs-credentials'
    default:
      // The waiting clock, which is what `idle` draws. It is the honest shape
      // for "nothing has been checked since you last asked".
      return 'idle'
  }
}

function demandLabel(share: SharedProjectDTO, state: OnDemandState): string {
  switch (state) {
    case 'busy':
      return share.state === 'resync' ? 'Catching up' : 'Syncing'
    case 'failed':
      return 'Sync failed — try again'
    case 'blocked':
      return 'Sign in again'
    default:
      // Not "Synced" even after a successful cycle. The instant this install
      // stops asking, what it knows about the relay starts ageing, and a green
      // "Synced" in a mode where nothing is checked is a claim about the other
      // people's work that this computer cannot make.
      return 'Sync now'
  }
}

function demandTip(share: SharedProjectDTO, state: OnDemandState): string {
  const base = ((): string => {
    switch (state) {
      case 'busy':
        return 'A sync is already running. It will finish on its own.'
      case 'failed':
        return share.sentence
          ? `${share.sentence} Press to try again.`
          : 'The last sync did not finish. Press to try again.'
      case 'blocked':
        return 'Enter your relay credentials in Settings → Plugins.'
      default:
        return share.lastOkAt
          ? `Syncing happens only when you ask. Last in step ${relative(share.lastOkAt)}.`
          : 'Syncing happens only when you ask. Press to sync now.'
    }
  })()
  const short = shortfallSentence(share.declinedRows)
  return short ? `${base} ${short}` : base
}

/**
 * What a permanent decline means, in the user's words.
 *
 * IT SAYS RETRYING WILL NOT HELP, because that is the whole difference between
 * this and a failure: the other computer keeps offering these rows and this
 * version keeps being unable to store them, so a person who presses Sync now
 * fifty times gets the same corpus fifty times. Saying only "some rows are
 * missing" would leave pressing again as the obvious thing to try.
 *
 * The COUNT is interpolated; the rest is a constant. Nothing here comes from a
 * peer, from a row, or from an exception.
 */
export function shortfallSentence(count: number): string | null {
  if (count <= 0) return null
  const n = count === 1 ? '1 row' : `${count} rows`
  return `${n} the other computer offered cannot be stored by this version of Corpus Studio, so this copy is incomplete. Syncing again will not bring them in — a newer version may.`
}

/** Coarse on purpose: a minute's precision on "when did I last sync" is noise. */
function relative(iso: string): string {
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return 'earlier'
  const mins = Math.floor((Date.now() - then) / 60_000)
  if (mins < 1) return 'a moment ago'
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

/** Every sentence `sharing:syncNow` may reject with. Mirrors the set in main. */
const SYNC_NOW_SENTENCES = new Set([
  'Turn the plugin that shares projects on in Settings → Plugins first.',
  'That plugin is switched off, so there is nothing to sync.',
  'That plugin has nothing to sync.',
  'That plugin is not installed.',
  'That sync could not be started. Check the plugin that shares projects in Settings → Plugins.'
])

/**
 * The sentence a rejected `syncNow` may show.
 *
 * Matched by IDENTITY against the closed set, not by shape. Main already maps
 * everything else to the last entry, so this is the second of two locks on the
 * same door — and it is the one that holds if a future edit up there forgets.
 * A "does this look like prose" regex would not be: it admits any
 * well-punctuated line, and undici's messages carry the request URL.
 *
 * The prefix strip is Electron's, not the message's: `ipcRenderer.invoke`
 * rejects with `Error invoking remote method '<channel>': <message>`.
 */
function sentenceOf(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '')
  const stripped = raw.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^Error:\s*/, '')
  return SYNC_NOW_SENTENCES.has(stripped)
    ? stripped
    : 'That sync could not be started. Check the plugin that shares projects in Settings → Plugins.'
}

function label(state: PluginRunState): string {
  switch (state) {
    case 'ok':
      return 'Synced'
    case 'syncing':
      return 'Syncing'
    case 'resync':
      return 'Catching up'
    case 'failed':
      return 'Sync failed'
    case 'needs-credentials':
      return 'Sign in again'
    case 'off':
      // Not "Shared", which would imply something is happening. Nothing is: the
      // plugin is not running, so this project is standing still.
      return 'Not syncing'
    default:
      return 'Shared'
  }
}

function tip(share: SharedProjectDTO): string {
  // FIRST, and it replaces rather than appends: the plugin's own sentence for a
  // decline says the same thing in fewer words, and the version here is the one
  // that carries the count and the "retrying will not help" the user needs.
  const short = shortfallSentence(share.declinedRows)
  if (share.state === 'needs-credentials') {
    const cred = 'Enter your relay credentials in Settings → Plugins.'
    return short ? `${cred} ${short}` : cred
  }
  if (share.state === 'failed') {
    const failed = share.sentence ?? 'The last sync did not finish.'
    return short ? `${failed} ${short}` : failed
  }
  if (share.state === 'off') {
    const off = 'The plugin that shares projects is switched off, so nothing is being synced. Turn it on in Settings → Plugins.'
    return short ? `${off} ${short}` : off
  }
  if (short) return short
  if (share.sentence) return share.sentence
  if (share.state === 'ok' && share.relayLabel) return `In step with ${share.relayLabel}.`
  if (share.relayLabel) return `Shared through ${share.relayLabel}.`
  return 'This project is shared.'
}

/**
 * `incomplete` is a GLYPH here and not a `PluginRunState`: the plugin's enum is
 * its lifecycle, and being permanently short is a property of the corpus that
 * outlives any one cycle. Drawing it as a broken ring — the settled circle of
 * `ok`, with a piece missing — says "finished, and not whole" in one shape.
 */
type GlyphKind = PluginRunState | 'incomplete'

function Glyph({ state }: { state: GlyphKind }): JSX.Element {
  const common = { width: 16, height: 16, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor' }
  switch (state) {
    case 'ok':
      return (
        <svg {...common} strokeWidth={1.9}>
          <circle className="sync-ring" cx="10" cy="10" r="7.5" strokeWidth={1.2} />
          <path d="M6.4 10.3l2.4 2.4 4.8-5.1" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'syncing':
      return (
        <svg {...common} strokeWidth={1.9}>
          <circle cx="10" cy="10" r="7.5" strokeWidth={1.1} opacity={0.3} />
          <path className="sync-arc" d="M10 2.5a7.5 7.5 0 0 1 7.5 7.5" strokeLinecap="round" />
        </svg>
      )
    case 'resync':
      return (
        <svg {...common} strokeWidth={1.9}>
          <path className="sync-arc" d="M10 2.5a7.5 7.5 0 0 1 7.5 7.5" strokeLinecap="round" />
          <path
            className="sync-arc-2"
            d="M10 5.5a4.5 4.5 0 0 0-4.5 4.5"
            strokeLinecap="round"
            strokeWidth={1.5}
          />
        </svg>
      )
    case 'failed':
      return (
        <svg {...common} strokeWidth={2.1}>
          <circle cx="10" cy="10" r="7.5" strokeWidth={1.5} />
          <path d="M7.3 7.3l5.4 5.4M12.7 7.3l-5.4 5.4" strokeLinecap="round" />
        </svg>
      )
    case 'needs-credentials':
      return (
        <svg {...common} strokeWidth={1.7}>
          <circle cx="7" cy="9" r="3.2" />
          <path d="M10 10h7M14.5 10v3M16.6 10v2.2" strokeLinecap="round" />
        </svg>
      )
    case 'off':
      // A stopped square in a slack ring: nothing turning, nothing waiting.
      // Distinct from `idle`'s clock, which promises the next poll.
      return (
        <svg {...common} strokeWidth={1.4}>
          <circle cx="10" cy="10" r="7.5" opacity={0.45} />
          <rect x="7.4" y="7.4" width="5.2" height="5.2" rx="1" />
        </svg>
      )
    case 'incomplete':
      return (
        <svg {...common} strokeWidth={1.9}>
          <path
            className="sync-gap"
            d="M14.6 4.6a7.5 7.5 0 1 0 2.3 7.7"
            strokeWidth={1.4}
            strokeLinecap="round"
          />
          <path d="M10 6.6v4.1" strokeLinecap="round" />
          <circle cx="10" cy="13.4" r="0.5" fill="currentColor" stroke="none" />
        </svg>
      )
    default:
      return (
        <svg {...common} strokeWidth={1.4}>
          <circle cx="10" cy="10" r="7.5" />
          <path d="M10 6.4v3.9l2.6 1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
  }
}

/**
 * The shared-project glyph used as CHROME on a project card and in the sidebar
 * eyebrow — a small linked pair, not a status chip.
 *
 * Shared-ness is persistent: a shared project IS shared the way it has a name,
 * so it is drawn as part of how the project looks. Hard rule 0.6 reserves chips
 * for the exception, which here is "Not in sync", "Sync failed" and the count of
 * rows this copy will never hold.
 */
export function SharedGlyph(): JSX.Element {
  return (
    <svg
      className="project-shared-glyph"
      width="12"
      height="12"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      aria-hidden="true"
    >
      <path d="M8.4 11.6a3.5 3.5 0 0 1 0-5l1.8-1.8a3.5 3.5 0 0 1 5 5l-.9.9" strokeLinecap="round" />
      <path d="M11.6 8.4a3.5 3.5 0 0 1 0 5l-1.8 1.8a3.5 3.5 0 0 1-5-5l.9-.9" strokeLinecap="round" />
    </svg>
  )
}
