import { useCallback, useEffect, useRef, useState } from 'react'
import type { McpClientVariant, McpStatusDTO } from '@shared/contract'

/**
 * The MCP connector's whole Settings surface.
 *
 * WHAT IT IS. This app is offline and local-first, and an inbound listening
 * socket is a change of POSTURE rather than another feature. So this pane's job
 * is not "expose some options" — it is to make the posture legible: off by
 * default, loopback unless the user opts out, token-authenticated always, and
 * every one of those facts visible without expanding anything.
 *
 * LAYOUT ORDER IS THE ARTEFACT FIRST. The switch and its live status, then the
 * config block the user pastes into their agent, then the addresses, and only
 * then the advanced controls. The config block is the thing this whole pane
 * exists to hand over, and it is copied once and never looked at again — so it
 * sits above the controls a user will visit far less often.
 *
 * STATE SPACE (HARD RULE 0.5). Enumerated before it was written, and every one
 * is styled to be distinct from every other:
 *   switch      off · off+hover · off+focus · starting · on · on+hover ·
 *               on+focus · on+active(inFlight>0) · stopping · failed ·
 *               failed+hover · disabled
 *   status line stopped · starting · listening · listening+active ·
 *               stopping · failed(port-in-use, focuses the port input) ·
 *               failed(permission-denied · origin-refused · host-refused ·
 *               audit-unwritable · token-unreadable · other)
 *   config      idle · hover · focus · copied · copy-denied · stale
 *   addresses   idle · hover · copied · empty-LAN
 *   reveal      hidden · hidden+hover · revealed · revealed+hover · focus ·
 *               disabled-before-first-enable (with a data-tip saying why)
 *   regenerate  idle · hover · active · arming · arming-while-in-flight · busy ·
 *               done · focus
 *   port        idle · hover · focus · invalid · pending-restart · saved ·
 *               in-use
 *   LAN box     off · off+hover · on · on+hover · focus · pending-restart ·
 *               busy(this control) · disabled(another applying)
 *   write box   the same set
 *   delete box  the same set, plus disabled-because-write-is-off
 *
 * A CONTROL REFUSES WITH `aria-disabled`, NEVER `disabled`. Chromium dispatches
 * neither `pointerover` nor `focusin` on a disabled form control, and the
 * tooltip is delegated off exactly those — so a disabled button's `data-tip`
 * explains itself to nobody, which is worse than not explaining at all. The
 * click is refused in the handler and `.btn[aria-disabled='true']` carries the
 * look.
 * Nothing signals by colour alone: each carries a WORD as well, the switch knob
 * slides and carries a glyph, and the posture ring is a shape. Transitions are
 * 150ms on pointer feedback and 250ms on ambient emphasis.
 */

const POLL_MS = 2000

export function McpServer(): JSX.Element {
  const [status, setStatus] = useState<McpStatusDTO | null>(null)
  /**
   * WHICH control is applying, not merely THAT one is.
   *
   * `'enabled'` for the switch and the Apply-and-restart button, otherwise the
   * name of the option being patched (`port`, `bindLan`, `allowWrite`,
   * `allowDestructive`). Null when nothing is in flight.
   */
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const busy = busyKey !== null
  const [advanced, setAdvanced] = useState(false)
  const [variant, setVariant] = useState<McpClientVariant>('claude')
  const [config, setConfig] = useState('')
  const [configStale, setConfigStale] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [copyDenied, setCopyDenied] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  const [arming, setArming] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [regenerated, setRegenerated] = useState(false)
  const [portDraft, setPortDraft] = useState<string | null>(null)
  const [portSaved, setPortSaved] = useState(false)
  /**
   * Bumped by anything that changes what the config block SAYS but not what the
   * status DTO shows.
   *
   * Regeneration is the case that matters: it swaps the token and leaves the
   * variant, the port and `hasToken` all untouched, so a key built from those
   * three alone never moves and the block goes on displaying a token the server
   * now rejects — a credential the user copies and pastes already dead.
   */
  const [configEpoch, setConfigEpoch] = useState(0)
  /**
   * What the last action failed with, in words, or null.
   *
   * Every mutation here crosses IPC and can REJECT — the port is written to a
   * settings table, the socket is bound by the OS. Unhandled, a rejection let
   * the control un-dim with nothing changed, so the pane claimed the request had
   * succeeded by saying nothing at all.
   */
  const [actionError, setActionError] = useState<string | null>(null)
  const portRef = useRef<HTMLInputElement | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  // An armed destructive button DISARMS itself. Blur alone was the only way
  // back, so a user who armed it and looked away left a control that
  // invalidates every pasted config one stray click from firing.
  useEffect(() => {
    if (!arming) return
    const t = window.setTimeout(() => setArming(false), 5_000)
    return () => window.clearTimeout(t)
  }, [arming])

  // Guards every async setState below. The modal can close mid-flight, and a
  // 2s poll plus three timeouts is four ways to write to a dead component.
  //
  // Re-armed on mount and not only cleared on unmount: StrictMode mounts,
  // cleans up and remounts, so a ref that is only ever set false leaves EVERY
  // guard below permanently closed on a live component — no status, no config,
  // and a `busyKey` that can never clear.
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const refresh = useCallback(() => {
    // A failed poll is swallowed on purpose: it fires every 2s, the next one
    // will report, and turning a transient main-process hiccup into a banner
    // would flash one twice a minute for no action the user can take.
    void window.api.getMcpStatus().then(
      (s) => {
        if (alive.current) setStatus(s)
      },
      () => undefined
    )
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Poll while the server is NOT STOPPED, rather than while `enabled`: gating on
  // `enabled` would freeze the `starting` and `failed` states, which are exactly
  // the two a user is watching.
  const live = status !== null && status.state !== 'stopped'
  useEffect(() => {
    if (!live) {
      if (timer.current) clearInterval(timer.current)
      timer.current = null
      return
    }
    timer.current = setInterval(refresh, POLL_MS)
    return () => {
      if (timer.current) clearInterval(timer.current)
      timer.current = null
    }
  }, [live, refresh])

  // The config block carries the port and the token, so either changing makes
  // what is on screen WRONG rather than merely old — and a user who copied it
  // ten seconds ago has no way to know.
  //
  // NOT fetched before the server has ever been enabled: the config string
  // contains the token, and building it MINTS one. Writing a credential to disk
  // as a side effect of opening a Settings tab is not a thing this pane may do.
  //
  // Arriving fresh text does NOT clear `configStale`. The warning is about what
  // the user PASTED somewhere else, which no refetch here can repair — only
  // copying the new value can. Clearing it on arrival would make the one
  // warning that matters flash for a frame and vanish; `copy()` retires it.
  const configKey = `${variant}|${status?.boundPort ?? status?.configuredPort ?? 0}|${
    status?.hasToken ?? false
  }|${configEpoch}`
  useEffect(() => {
    if (!status?.hasToken) {
      setConfig('')
      return
    }
    let dead = false
    void window.api.getMcpClientConfig(variant).then(
      (text) => {
        if (dead || !alive.current) return
        setConfig(text)
      },
      (err: unknown) => {
        if (dead || !alive.current) return
        // Emptied, not left holding the previous variant's text: a Claude
        // config sitting under a "VS Code" tab is worse than a blank box.
        setConfig('')
        setActionError(
          `The configuration could not be built \u2014 ${err instanceof Error ? err.message : String(err)}`
        )
      }
    )
    return () => {
      dead = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configKey])

  const on = status?.enabled ?? false
  const state = status?.state ?? 'stopped'
  const inFlight = status?.inFlight ?? 0

  const failed = (verb: string, err: unknown): void => {
    if (!alive.current) return
    const detail = err instanceof Error ? err.message : String(err)
    setActionError(`${verb} failed \u2014 ${detail}`)
    // The server's own view is authoritative after a failure; the optimistic
    // one on screen is not.
    refresh()
  }

  const toggle = async (): Promise<void> => {
    setBusyKey('enabled')
    setActionError(null)
    try {
      const next = await window.api.setMcpEnabled(!on)
      if (alive.current) setStatus(next)
    } catch (err) {
      failed(on ? 'Stopping the server' : 'Starting the server', err)
    } finally {
      if (alive.current) setBusyKey(null)
    }
  }

  /**
   * Apply one setting.
   *
   * `busyKey` names WHICH control is in flight, so the pulse and the refusal
   * land on the one the user touched. A single shared flag dimmed all three
   * checkboxes at once — making "which is applying?" unanswerable — and
   * overwrote the destructive box's own permanent explanation with 'Applying…'.
   *
   * `staleConfig` is opt-in for the same reason: only `port` and `bindLan`
   * appear in the pasted config, so marking it stale after a permission change
   * told the user in warning weight that what they had pasted no longer worked.
   * It did. Crying wolf about it trains them past the one warning that is real.
   */
  const setOption = async (
    patch: Parameters<typeof window.api.setMcpOptions>[0],
    opts: { staleConfig?: boolean } = {}
  ): Promise<boolean> => {
    const key = Object.keys(patch)[0] ?? 'options'
    setBusyKey(key)
    setActionError(null)
    try {
      const next = await window.api.setMcpOptions(patch)
      if (!alive.current) return false
      setStatus(next)
      if (opts.staleConfig) {
        setConfigStale(true)
        setConfigEpoch((e) => e + 1)
      }
      return true
    } catch (err) {
      failed('Saving that setting', err)
      return false
    } finally {
      if (alive.current) setBusyKey(null)
    }
  }

  const copy = async (what: string, text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      if (!alive.current) return
      setCopyDenied(false)
      setCopied(what)
      // Copying the config IS the remedy the stale warning asks for, so it is
      // the one action allowed to retire it. Leaving it up afterwards left the
      // user no way to dismiss a warning they had already acted on.
      if (what === 'config') setConfigStale(false)
      window.setTimeout(() => {
        if (alive.current) setCopied((c) => (c === what ? null : c))
      }, 1400)
    } catch {
      // A denied clipboard is why the payload is rendered as SELECTABLE text and
      // not only behind a button: the fallback has to be a real one.
      if (alive.current) setCopyDenied(true)
    }
  }

  const doRegenerate = async (): Promise<void> => {
    setRegenerating(true)
    setActionError(null)
    try {
      const next = await window.api.regenerateMcpToken()
      if (!alive.current) return
      // Only while it is already on screen — minting must not REVEAL a token the
      // user chose to keep hidden. Read through the setter and not the captured
      // `token`, which is this render's value and may be a reveal old by the
      // length of the round trip.
      setToken((cur) => (cur === null ? null : next))
      setArming(false)
      setRegenerated(true)
      setConfigStale(true)
      // The config block carries the token and nothing in the status DTO moved,
      // so without this bump it would keep showing the dead one.
      setConfigEpoch((e) => e + 1)
      window.setTimeout(() => {
        if (alive.current) setRegenerated(false)
      }, 2000)
      refresh()
    } catch (err) {
      failed('Minting a new token', err)
    } finally {
      if (alive.current) setRegenerating(false)
    }
  }

  const switchWord =
    state === 'starting'
      ? 'Starting'
      : state === 'stopping'
        ? 'Stopping'
        : state === 'failed'
          ? 'Failed'
          : state === 'listening'
            ? // Idle and serving must differ in the WORD too. The distinction
              // otherwise lives entirely in the track's ring and its pulse, and
              // the pulse is off under reduced motion.
              inFlight > 0
              ? 'Serving'
              : 'Listening'
            : 'Off'

  /**
   * The switch refuses input while an operation is in flight — including the
   * `starting` and `stopping` the 2s poll surfaces without any click of ours
   * (a launch-time auto-start, or the far side of "Apply and restart"). Those
   * already RENDER as busy; accepting a click in that state would fire a
   * contradictory toggle at a server mid-transition.
   */
  const switchBusy = busy || state === 'starting' || state === 'stopping'

  // Only the two postures a reader must ACT on are named: reachable from the
  // network, and able to delete. Loopback and read+write are what this server is
  // unless someone changed it, and saying so would spend the row telling them
  // what they already assumed.
  const posture = status?.bind === '0.0.0.0' ? 'is-lan' : ''
  const levelClass = status?.allowDestructive ? 'lvl-delete' : ''
  const levelWord = 'can delete'

  return (
    <div className={`settings-section mcp-section ${posture} ${levelClass}`} data-testid="mcp-section">
      <div className="mcp-head">
        <div className="settings-eyebrow mono">AI agents that call this app</div>
        {/* In the eyebrow's own flow row, not floating over the section:
            absolutely positioned, a badge overlapped the heading at the width
            this modal actually opens at. */}
        <div className="mcp-badges">
          {status?.allowDestructive && (
            <span
              className={`mcp-badge mcp-badge-level ${levelClass}`}
              data-testid="mcp-level-badge"
            >
              {levelWord}
            </span>
          )}
          {status?.bind === '0.0.0.0' && (
            <span className="mcp-badge mcp-badge-lan" data-testid="mcp-lan-badge">
              network-exposed · unencrypted
            </span>
          )}
        </div>
      </div>

      {/* 1 — the switch and its live status, together. */}
      <div className="settings-pref-row">
        <div className="settings-pref-text">
          <div className="settings-pref-label" id="mcp-enable-label">
            Enable MCP server
          </div>
          <div className="settings-pref-help" id="mcp-enable-help">
            Lets an AI agent on this machine read and control your corpus over a local
            network connection. Off by default. Anyone holding the token below can do
            everything you can do in this app.
          </div>
          <McpStatusLine
            status={status}
            onFocusPort={() => {
              setAdvanced(true)
              window.setTimeout(() => portRef.current?.focus(), 0)
            }}
          />
        </div>
        <button
          type="button"
          role="switch"
          // The LIVE state, not the persisted flag. `aria-checked={on}` told a
          // screen-reader user "on" while the visible word said "Failed" —
          // asserting to the one reader who cannot see the contradiction that
          // the server is up when it is down.
          aria-checked={state === 'listening'}
          aria-labelledby="mcp-enable-label"
          aria-describedby="mcp-enable-help"
          data-testid="mcp-enable"
          // `aria-disabled` and NOT `disabled`: Chromium dispatches neither
          // `pointerover` nor `focusin` on a disabled control, and the tooltip is
          // delegated off exactly those — so a `disabled` button's `data-tip`
          // explains itself to nobody. The click is refused in the handler
          // instead, and `.btn[aria-disabled='true']` already carries the look.
          aria-disabled={switchBusy}
          data-tip={
            switchBusy
              ? state === 'starting'
                ? 'Starting the server\u2026'
                : state === 'stopping'
                  ? `Stopping\u2026${inFlight > 0 ? ` waiting for ${inFlight} call${inFlight === 1 ? '' : 's'}` : ''}`
                  : 'Applying\u2026'
              : undefined
          }
          className={
            'settings-switch mcp-switch' +
            (state === 'listening' ? ' is-on' : '') +
            (switchBusy ? ' is-busy' : '') +
            (state === 'failed' ? ' is-failed' : '') +
            (state === 'listening' && inFlight > 0 ? ' is-active' : '')
          }
          onClick={() => {
            if (switchBusy) return
            void toggle()
          }}
        >
          <span className="settings-switch-track" aria-hidden="true">
            <span className="settings-switch-knob">
              {state === 'listening' ? '\u2713' : state === 'failed' ? '!' : '\u2715'}
            </span>
          </span>
          <span className="settings-switch-word" aria-hidden="true">
            {switchWord}
          </span>
        </button>
      </div>

      {/* A request that was REFUSED. Distinct from the status line, which
          describes the server: this describes what the user just asked for and
          did not get, and is dismissible because it is about one past action
          rather than a current condition. */}
      {actionError && (
        <div className="mcp-error" role="alert" data-testid="mcp-action-error">
          <span className="mcp-note mcp-note-warn">
            <span aria-hidden="true">⚠</span> {actionError}
          </span>
          <button
            type="button"
            className="btn-link"
            data-testid="mcp-error-dismiss"
            onClick={() => setActionError(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* 2 — the artefact. Selectable AND copyable: the house pattern, and the
          only path that survives a browser denying the clipboard.
          Shown only once a token exists, because a config block with a blank
          token would be copied, pasted, and fail with a 401 the user has no way
          to explain. */}
      {status?.hasToken ? (
      <div className="mcp-config" data-testid="mcp-config">
        <div className="mcp-config-head">
          <div className="mcp-variants" role="group" aria-label="Client format">
            {(
              [
                ['claude', 'Claude'],
                ['vscode', 'VS Code'],
                ['stdio', 'stdio shim']
              ] as Array<[McpClientVariant, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`mcp-variant${variant === key ? ' is-on' : ''}`}
                aria-pressed={variant === key}
                data-testid={`mcp-variant-${key}`}
                onClick={() => setVariant(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={`btn btn-secondary btn-sm${copied === 'config' ? ' is-copied' : ''}`}
            data-testid="mcp-copy-config"
            // Refused until the text has actually arrived. The block is
            // `hasToken`-gated, so there is a real window in which `config` is
            // still empty — and a click inside it wrote an empty clipboard and
            // then announced "Copied — it contains your token", which is a false
            // success about a credential.
            aria-disabled={config === ''}
            data-tip={config === '' ? 'Building the configuration\u2026' : undefined}
            onClick={() => {
              if (config === '') return
              void copy('config', config)
            }}
          >
            {copied === 'config' ? 'Copied \u2014 it contains your token' : 'Copy'}
          </button>
        </div>
        <div className={`mcp-config-wrap${configStale ? ' is-stale' : ''}`}>
          <textarea
            aria-label="Configuration to paste into your agent"
            className={`mcp-config-text mono${configStale ? ' is-stale' : ''}`}
            data-testid="mcp-config-text"
            readOnly
            spellCheck={false}
            rows={8}
            value={config}
          />
        </div>
        {configStale && (
          <div className="mcp-note mcp-note-warn" data-testid="mcp-config-stale">
            <span aria-hidden="true">⚠</span> The port or token changed. Copy this again
            — anything you pasted earlier no longer works.
          </div>
        )}
        {copyDenied && (
          <div className="mcp-note" data-testid="mcp-copy-denied">
            Copying was refused by the system. Select the text above and copy it yourself.
          </div>
        )}
      </div>
      ) : (
        <div className="mcp-note mcp-config-pending" data-testid="mcp-config-pending">
          Turn the server on and the exact configuration to paste into your agent appears
          here, access token included.
        </div>
      )}

      {/* 3 — the addresses, each copyable on its own. */}
      <div className="mcp-addresses" data-testid="mcp-addresses">
        {status && status.urls.length > 0 ? (
          status.urls.map((url) => (
            <button
              key={url}
              type="button"
              className={`mcp-address${copied === url ? ' is-copied' : ''}`}
              aria-label={`Copy ${url}`}
              data-testid={`mcp-address-${url}`}
              onClick={() => void copy(url, url)}
            >
              <code className="mono">{url}</code>
              <span className="mcp-address-action" aria-hidden="true">
                {copied === url ? 'copied' : 'copy'}
              </span>
            </button>
          ))
        ) : (
          <div className="mcp-note" data-testid="mcp-addresses-empty">
            {status?.bind === '0.0.0.0' && status.lanAddresses.length === 0
              ? 'No network interface was found \u2014 only the loopback address would work.'
              : 'Addresses appear once the server is listening.'}
          </div>
        )}
      </div>

      {/* 4 — advanced, behind a disclosure. Everything here is a PERSISTED
          setting and is editable while stopped: gating them on the server
          running would force "copy the config, then invalidate what you
          copied". */}
      <button
        type="button"
        className="mcp-disclosure"
        aria-expanded={advanced}
        aria-controls="mcp-advanced"
        data-testid="mcp-advanced-toggle"
        onClick={() => setAdvanced((a) => !a)}
      >
        <span className={`settings-caret${advanced ? ' open' : ''}`} aria-hidden="true">
          ▶
        </span>
        Advanced — port, network exposure, permissions, token
      </button>

      {advanced && (
        <div className="mcp-advanced" id="mcp-advanced">
          <label className="set-field mcp-port">
            <span className="set-label">
              Port
              {status?.pendingPort && (
                <span className="mcp-pending" data-testid="mcp-port-pending">
                  restart to apply
                </span>
              )}
            </span>
            <input
              ref={portRef}
              className={
                'input' +
                (portInvalid(portDraft) ? ' is-invalid' : '') +
                (busyKey === 'port' ? ' is-busy' : '') +
                // Gated on the LIVE state, not on `lastError` alone: the error
                // is a session record that a later successful bind does not
                // clear, so on its own it would keep the field ringed in warning
                // while the server listens happily on the port beside it.
                (state === 'failed' && status?.lastError === 'port-in-use' ? ' is-in-use' : '')
              }
              data-testid="mcp-port"
              inputMode="numeric"
              aria-invalid={portInvalid(portDraft) || undefined}
              aria-describedby={portInvalid(portDraft) ? 'mcp-port-error' : undefined}
              value={portDraft ?? String(status?.configuredPort ?? '')}
              onChange={(e) => setPortDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setPortDraft(null)
                  e.currentTarget.blur()
                } else if (e.key === 'Enter') {
                  e.currentTarget.blur()
                }
              }}
              onBlur={() => {
                if (portDraft === null) return
                // An EMPTY field is not a port. `portInvalid('')` is false so
                // the range warning does not fire on a half-typed value — but
                // `Number('')` is 0, which sailed through as "the user asked
                // for port 0" and persisted an unbindable port.
                if (portDraft.trim() === '') {
                  setPortDraft(null)
                  return
                }
                // An INVALID draft is kept, not thrown away. Reverting on blur
                // wiped the value, the `is-invalid` ring and the sentence
                // explaining the range all in the same frame, so a user who
                // typed `80` and tabbed out was told nothing at all and had
                // saved nothing. Escape is the way out.
                if (portInvalid(portDraft)) return
                const n = Number(portDraft)
                if (n === status?.configuredPort) {
                  setPortDraft(null)
                  return
                }
                // The draft is cleared only once the write has SUCCEEDED.
                // Clearing it alongside the call would revert the field to the
                // old port the instant a rejected save came back, eating the
                // user's edit without a word.
                void setOption({ port: n }, { staleConfig: true }).then((ok) => {
                  if (!alive.current || !ok) return
                  setPortDraft(null)
                  setPortSaved(true)
                  window.setTimeout(() => {
                    if (alive.current) setPortSaved(false)
                  }, 1600)
                })
              }}
            />
            {portSaved && !portInvalid(portDraft) && (
              <span className="mcp-note mcp-note-ok" data-testid="mcp-port-saved">
                <span aria-hidden="true">✓</span> Saved.
              </span>
            )}
            {portInvalid(portDraft) && (
              <span
                className="mcp-note mcp-note-warn"
                id="mcp-port-error"
                data-testid="mcp-port-invalid"
              >
                Pick a number between 1024 and 65535. Below 1024 needs administrator rights.
              </span>
            )}
          </label>

          {status?.pendingRestart && (
            <div className="mcp-restart-row" data-testid="mcp-restart-row">
              <span className="mcp-note mcp-note-warn">
                The running server is still on the old settings.
              </span>
              <button
                type="button"
                className={`btn btn-secondary btn-sm${busyKey === 'restart' ? ' is-busy' : ''}`}
                data-testid="mcp-apply-restart"
                aria-disabled={busy}
                data-tip={
                  busyKey === 'restart'
                    ? 'Restarting\u2026'
                    : busy
                      ? 'Another setting is being applied\u2026'
                      : undefined
                }
                onClick={() => {
                  if (busy) return
                  // Off then on: the persisted settings are read at bind time,
                  // so a stop/start IS the apply. Sequenced rather than fired
                  // together, because the second would race the first's drain.
                  void (async () => {
                    setBusyKey('restart')
                    setActionError(null)
                    try {
                      await window.api.setMcpEnabled(false)
                      const next = await window.api.setMcpEnabled(true)
                      if (alive.current) setStatus(next)
                    } catch (err) {
                      failed('Restarting the server', err)
                    } finally {
                      if (alive.current) setBusyKey(null)
                    }
                  })()
                }}
              >
                {/* `.btn.is-busy .btn-glyph` animates a glyph, so a busy button
                    without one showed nothing at all. The label changes too:
                    the glyph is the second channel, not the only one. */}
                {busyKey === 'restart' && (
                  <span className="btn-glyph" aria-hidden="true">
                    ◌
                  </span>
                )}
                {busyKey === 'restart' ? 'Restarting\u2026' : 'Apply and restart'}
              </button>
            </div>
          )}

          <McpCheck
            id="mcp-lan"
            label="Accept connections from other machines on your network"
            help={
              'The connection is NOT encrypted \u2014 the token and your papers\u2019 text ' +
              'cross the network in the clear. Only do this on a network you trust. ' +
              'On macOS the system will ask for local-network permission.'
            }
            checked={status?.bind === '0.0.0.0'}
            // This control's OWN pending, not the section's: on the aggregate
            // flag the exposure switch would claim a restart was owed when the
            // only thing changed was the port.
            pending={status?.pendingBind ?? false}
            busy={busyKey === 'bindLan'}
            disabled={busy}
            disabledTip={
              busyKey === 'bindLan'
                ? 'Applying\u2026'
                : busy
                  ? 'Another setting is being applied\u2026'
                  : undefined
            }
            onChange={(next) => void setOption({ bindLan: next }, { staleConfig: true })}
          />

          <McpCheck
            id="mcp-write"
            label="Let the agent make changes"
            help={
              'Review verdicts, ranking overrides, imports, re-runs and schema edits. ' +
              'Without this the agent can read everything and change nothing.'
            }
            checked={status?.allowWrite ?? true}
            pending={false}
            busy={busyKey === 'allowWrite'}
            disabled={busy}
            disabledTip={
              busyKey === 'allowWrite'
                ? 'Applying\u2026'
                : busy
                  ? 'Another setting is being applied\u2026'
                  : undefined
            }
            onChange={(next) => void setOption({ allowWrite: next })}
          />

          <McpCheck
            id="mcp-destructive"
            label="Let the agent delete things and write files"
            help={
              'Additionally: delete a paper, delete a schema or one of its fields, and run ' +
              'an outlet action, which writes files outside this app. None of that is undoable.'
            }
            checked={status?.allowDestructive ?? false}
            pending={false}
            busy={busyKey === 'allowDestructive'}
            disabled={busy || !(status?.allowWrite ?? true)}
            disabledTip={
              !(status?.allowWrite ?? true)
                ? 'Turn on "Let the agent make changes" first \u2014 deleting is a kind of change.'
                : busyKey === 'allowDestructive'
                  ? 'Applying\u2026'
                  : 'Another setting is being applied\u2026'
            }
            danger
            onChange={(next) => void setOption({ allowDestructive: next })}
          />

          <div className="mcp-token" data-testid="mcp-token">
            <span className="set-label">Access token</span>
            <code className={`mono mcp-token-value${token ? ' is-revealed' : ''}`}>
              {token ?? '\u2022'.repeat(32)}
            </code>
            <div className="mcp-token-actions">
              <button
                type="button"
                className={`btn btn-secondary btn-sm mcp-reveal${token ? ' is-revealed' : ''}`}
                data-testid="mcp-reveal"
                aria-disabled={!status?.hasToken && !on}
                aria-label={
                  !status?.hasToken && !on
                    ? 'Reveal token — unavailable until the server has been enabled once'
                    : undefined
                }
                data-tip={
                  !status?.hasToken && !on
                    ? 'A token is minted the first time you enable the server.'
                    : undefined
                }
                onClick={() => {
                  if (!status?.hasToken && !on) return
                  if (token) {
                    setToken(null)
                    return
                  }
                  void window.api.getMcpToken().then(
                    (t) => {
                      if (alive.current) setToken(t)
                    },
                    (err: unknown) => failed('Reading the token', err)
                  )
                }}
              >
                <span className="btn-glyph" aria-hidden="true">
                  {token ? '\u25c9' : '\u25cc'}
                </span>
                {token ? 'Hide' : 'Reveal'}
              </button>
              <button
                type="button"
                className={
                  'btn btn-sm ' +
                  (arming ? 'btn-danger' : 'btn-secondary') +
                  (regenerating ? ' is-busy' : '') +
                  (regenerated ? ' is-copied' : '')
                }
                data-testid="mcp-regenerate"
                aria-disabled={regenerating}
                data-tip={regenerating ? 'Minting a new token\u2026' : undefined}
                onClick={() => {
                  if (regenerating) return
                  if (!arming) {
                    setArming(true)
                    return
                  }
                  void doRegenerate()
                }}
                onBlur={() => {
                  if (!regenerating) setArming(false)
                }}
              >
                {/* The danger tone never rests on colour alone; armed carries the
                    glyph the rest of the app's destructive buttons carry. */}
                {regenerating ? (
                  <span className="btn-glyph" aria-hidden="true">
                    ◌
                  </span>
                ) : arming ? (
                  <span className="btn-glyph" aria-hidden="true">
                    ⚠
                  </span>
                ) : null}
                {regenerated
                  ? 'New token minted'
                  : regenerating
                    ? 'Minting\u2026'
                    : arming
                      ? inFlight > 0
                        ? `Confirm \u2014 disconnects ${inFlight} call(s) in progress`
                        : 'Confirm \u2014 invalidates every config you pasted'
                      : 'Regenerate'}
              </button>
            </div>
          </div>

          <button
            type="button"
            className="btn-link mcp-audit-link"
            data-testid="mcp-audit-link"
            onClick={() =>
              void window.api
                .openMcpAuditDir()
                .catch((err: unknown) => failed('Opening the call log', err))
            }
          >
            Show the call log in folder →
          </button>
        </div>
      )}
    </div>
  )
}

function portInvalid(draft: string | null): boolean {
  if (draft === null || draft === '') return false
  const n = Number(draft)
  return !Number.isInteger(n) || n < 1024 || n > 65_535
}

/**
 * The live status line.
 *
 * Answers the question the user actually has after pasting the config, which is
 * "did it work?" — nothing else on this pane does. A port collision links
 * straight to the port input, because the fix is one field away and telling
 * someone a port is taken without showing them where to change it is half an
 * error message.
 */
function McpStatusLine({
  status,
  onFocusPort
}: {
  status: McpStatusDTO | null
  onFocusPort: () => void
}): JSX.Element | null {
  if (!status) return null
  const { state } = status

  if (state === 'failed') {
    if (status.lastError === 'port-in-use') {
      return (
        <div className="mcp-status is-failed" role="status" aria-live="polite" data-testid="mcp-status">
          <span aria-hidden="true">✖</span> Port {status.configuredPort} is already in
          use.{' '}
          <button type="button" className="btn-link" onClick={onFocusPort}>
            Choose another
          </button>
        </div>
      )
    }
    return (
      <div className="mcp-status is-failed" role="status" aria-live="polite" data-testid="mcp-status">
        <span aria-hidden="true">✖</span>{' '}
        {status.lastError === 'permission-denied'
          ? `Port ${status.configuredPort} needs administrator rights. Pick one above 1024.`
          : status.lastError === 'origin-refused'
            ? 'A browser-style client was refused \u2014 it sent an Origin header. Use an MCP client, not a web page.'
            : status.lastError === 'host-refused'
              ? 'A client was refused because the address it used is not one this server answers to.'
              : // The two causes with a one-step fix. Refusing to start is
                // deliberate in both cases and is explained, because "could not
                // start" over a permissions problem reads as a bug in the app.
                status.lastError === 'audit-unwritable'
                ? 'The record of what agents do to your library could not be written, so the server refused to start rather than answer with nothing keeping track. Check that the app\u2019s data folder can be written to \u2014 a full disk or a read-only drive will do this.'
                : status.lastError === 'token-unreadable'
                  ? 'The saved access key could not be read. The server refused to start rather than issue a new one, which would silently stop every agent already set up with the old key. Fix the key file\u2019s permissions in the app\u2019s data folder, or use Regenerate below to deliberately start over \u2014 which means updating every agent.'
                  : 'The server could not start.'}
      </div>
    )
  }

  if (state === 'starting') {
    return (
      <div className="mcp-status is-starting" role="status" aria-live="polite" data-testid="mcp-status">
        <span aria-hidden="true">◌</span> Starting…
      </div>
    )
  }

  if (state === 'stopping') {
    return (
      <div className="mcp-status is-stopping" role="status" aria-live="polite" data-testid="mcp-status">
        {/* Its own glyph. Sharing `◌` with `starting` left the two separated by
            hue and sentence alone — opposite transitions that looked alike. */}
        <span aria-hidden="true">◑</span> Stopping — waiting for {status.inFlight}{' '}
        call(s) to finish. Nothing in progress is aborted.
      </div>
    )
  }

  if (state === 'listening') {
    const active = status.inFlight > 0
    return (
      <div
        className={`mcp-status is-listening${active ? ' is-active' : ''}`}
        role="status"
        aria-live="polite"
        data-testid="mcp-status"
      >
        {/* Idle and serving must not differ by hue plus a pulse alone: under
            `prefers-reduced-motion` the pulse is off, and the two then read as
            the same sentence in two shades. Serving gets its own glyph and says
            HOW MANY calls are in it. */}
        <span aria-hidden="true">{active ? '◉' : '●'}</span> Listening on port{' '}
        {status.boundPort} — {status.toolCount} tools.{' '}
        {active
          ? `Serving ${status.inFlight} call${status.inFlight === 1 ? '' : 's'} right now.`
          : status.lastToolCalled
            ? `Last call ${ago(status.lastConnectedAt)} \u2014 ${status.lastToolCalled}.`
            : 'No agent has called it yet.'}
      </div>
    )
  }

  return (
    <div className="mcp-status is-stopped" role="status" aria-live="polite" data-testid="mcp-status">
      <span aria-hidden="true">○</span> Not running. Nothing can reach this app.
    </div>
  )
}

function ago(iso: string | null): string {
  if (!iso) return 'just now'
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

/** A labelled checkbox row, styled for every state including pending-restart. */
function McpCheck({
  id,
  label,
  help,
  checked,
  pending,
  busy,
  disabled,
  disabledTip,
  danger,
  onChange
}: {
  id: string
  label: string
  help: string
  checked: boolean
  pending: boolean
  /** In flight right now, as opposed to permanently unavailable. Distinct states. */
  busy: boolean
  disabled: boolean
  disabledTip?: string
  danger?: boolean
  onChange: (next: boolean) => void
}): JSX.Element {
  return (
    <div className="settings-pref-row mcp-check-row">
      <div className="settings-pref-text">
        <div className="settings-pref-label" id={`${id}-label`}>
          {label}
        </div>
        <div className="settings-pref-help" id={`${id}-help`}>
          {help}
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-help`}
        data-testid={id}
        // `aria-disabled`, never `disabled`: a disabled control receives no
        // `pointerover` and no `focusin`, and the tooltip is delegated off both
        // — so the reason it gives for refusing would be unreadable, which is
        // the one thing a refusal must not be.
        aria-disabled={disabled}
        data-tip={disabled ? disabledTip : undefined}
        className={
          'settings-switch' +
          (checked ? ' is-on' : '') +
          (busy ? ' is-busy' : '') +
          (danger ? ' is-danger' : '') +
          (pending ? ' is-pending' : '')
        }
        onClick={() => {
          if (disabled) return
          onChange(!checked)
        }}
      >
        <span className="settings-switch-track" aria-hidden="true">
          <span className="settings-switch-knob">{checked ? '\u2713' : '\u2715'}</span>
        </span>
        <span className="settings-switch-word" aria-hidden="true">
          {pending ? (checked ? 'On · pending' : 'Off · pending') : checked ? 'On' : 'Off'}
        </span>
      </button>
    </div>
  )
}
