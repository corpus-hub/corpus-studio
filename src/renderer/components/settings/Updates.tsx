import { useCallback, useEffect, useState } from 'react'
import type { UpdateStateDTO } from '@shared/contract'

/**
 * Getting a newer version of the app.
 *
 * The panel holds NO phase of its own: main owns the state machine and pushes
 * it here. A second copy of "are we downloading" in the renderer is how a
 * cancelled download leaves a progress bar turning forever, and how two windows
 * disagree about whether an update exists.
 *
 * Being up to date earns no badge. That is the answer the user expects, and a
 * green chip on every visit is a chip nobody reads by the time it matters —
 * taking the one that says "could not reach the update server" down with it.
 */

/** Every phase as data, so a branch cannot be forgotten when one is added. */
const PHASES = {
  idle: {
    title: 'Updates',
    body: 'This app has not checked yet.',
    badge: null
  },
  checking: {
    title: 'Updates',
    body: 'Checking for a newer version…',
    badge: null
  },
  uptodate: {
    title: 'Updates',
    body: 'This is the newest version.',
    badge: null
  },
  available: {
    title: 'Updates',
    body: null,
    badge: { word: 'Update available', cls: 'badge-accent' }
  },
  downloading: {
    title: 'Updates',
    body: null,
    badge: null
  },
  ready: {
    title: 'Updates',
    body: null,
    badge: { word: 'Ready to install', cls: 'badge-accent' }
  },
  'ready-manual': {
    title: 'Updates',
    body: null,
    badge: { word: 'Needs installing by hand', cls: 'badge-warn' }
  },
  error: {
    title: 'Updates',
    body: null,
    // Worded at render time: the same phase covers a failed CHECK and a failed
    // DOWNLOAD, and naming the wrong one sends the reader after the wrong
    // problem. A download failure is the case that still has a version.
    badge: { word: 'Failed', cls: 'badge-danger' }
  }
} as const

function ago(at: number | null): string | null {
  if (!at) return null
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 60) return 'checked just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `checked ${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `checked ${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `checked ${days} day${days === 1 ? '' : 's'} ago`
}

/**
 * A release date as `7 July 2026`.
 *
 * Spelled out rather than `toLocaleDateString()`, which renders `7/30/2026` —
 * ambiguous to most of the world, since only a few countries read that as the
 * 30th of July. A month name cannot be misread whatever the reader's locale.
 */
function releaseDay(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}

function rate(bytesPerSecond: number | null): string | null {
  if (!bytesPerSecond || bytesPerSecond <= 0) return null
  const mb = bytesPerSecond / (1024 * 1024)
  if (mb >= 1) return `${mb.toFixed(1)} MB/s`
  return `${Math.round(bytesPerSecond / 1024)} KB/s`
}

export function Updates(): JSX.Element {
  const [state, setState] = useState<UpdateStateDTO | null>(null)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  /** A failure of THIS panel's own action, which main knows nothing about. */
  const [localError, setLocalError] = useState<string | null>(null)
  /**
   * Ticks so the relative timestamp ages.
   *
   * Main pushes only on a transition, and "checked just now" is true for sixty
   * seconds — a panel left open would go on claiming it for the rest of the
   * session.
   */
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 30_000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    let alive = true
    window.api
      .updateState()
      .then((s) => {
        if (alive) setState(s)
      })
      .catch(() => undefined)
    // Main pushes every transition, so there is nothing to poll: a progress bar
    // driven by a timer here would lag the download it claims to describe.
    const off = window.api.onUpdateState((s) => {
      // Release "Restarting…" as soon as main says the install is not still
      // under way. Success does NOT mean the app goes away -- the close guard
      // can stop it and the user can cancel -- so a button left disabled until
      // the process exits stays disabled for the session. Anything other than a
      // silent `ready` means the install is accounted for: a phase change, or a
      // sentence explaining why it did not happen.
      if (s.phase !== 'ready' || s.error !== null) {
        setBusy((b) => (b.install ? { ...b, install: false } : b))
      }
      // A local complaint describes the state it was raised in; once main moves
      // on it is answering a question nobody is asking any more.
      setState((prev) => {
        if (prev && prev.phase !== s.phase) setLocalError(null)
        return s
      })
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  /**
   * Mark ONE control busy while its call is in flight.
   *
   * Keyed by control rather than a single flag, because these calls overlap by
   * design: `downloadUpdate()` does not resolve until the whole download has,
   * and a shared flag therefore disabled "Stop downloading" for exactly as long
   * as there was something to stop.
   */
  const run = useCallback((key: string, fn: () => Promise<unknown>) => {
    setBusy((b) => ({ ...b, [key]: true }))
    fn()
      .catch(() => undefined)
      .finally(() => setBusy((b) => ({ ...b, [key]: false })))
  }, [])

  // `aria-disabled` keeps a control hoverable so it can explain itself, which
  // means it does NOT block the click — each handler refuses for itself.
  const check = useCallback(() => {
    if (busy.check || !state?.configured || state?.phase === 'checking') return
    run('check', () => window.api.checkForUpdate())
  }, [run, busy.check, state?.configured, state?.phase])
  const download = useCallback(() => {
    if (busy.download) return
    run('download', () => window.api.downloadUpdate())
  }, [run, busy.download])
  // Not marked busy: it resolves in a millisecond, and the phase change is the
  // feedback. A spinner that outlives the action it describes is noise.
  const cancel = useCallback(() => {
    void window.api.cancelUpdateDownload().catch(() => undefined)
  }, [])
  const install = useCallback(() => {
    if (busy.install) return
    setBusy((b) => ({ ...b, install: true }))
    const failed = (): void => {
      setBusy((b) => ({ ...b, install: false }))
      setLocalError('The installer could not be started. The download may need repeating.')
    }
    // `false` is a refusal that has to be said. But success does NOT mean the
    // app goes away either: it may stop at the close guard's prompt, which the
    // user can cancel. Leaving the button on "Restarting…" for ever is the
    // failure that state was introduced to prevent, so it is released once main
    // reports that nothing is installing any more.
    void window.api.installUpdate().then((ok) => {
      if (!ok) failed()
    }, failed)
  }, [busy.install])
  const reveal = useCallback(() => {
    void window.api.revealUpdateFile().then(
      (ok) => {
        // A button that quietly does nothing when the file has been cleaned up
        // reads as a broken app, so the shortfall is said out loud.
        setLocalError(ok ? null : 'The downloaded file is no longer where it was put.')
      },
      () => setLocalError('The downloaded file could not be opened.')
    )
  }, [])

  if (!state) {
    return (
      <section className="set-sec">
        <header className="upd-head">
          <h3>Updates</h3>
        </header>
        <p className="set-meta">Loading…</p>
      </section>
    )
  }

  const meta = PHASES[state.phase]
  const checked = ago(state.checkedAt)
  const speed = rate(state.bytesPerSecond)

  return (
    <section className={`set-sec is-${state.phase}`} data-testid="settings-updates">
      <header className="upd-head">
        <h3>{meta.title}</h3>
        {meta.badge && (
          <span className={`badge ${meta.badge.cls} upd-badge`}>
            {state.phase === 'error'
              ? state.failed === 'download'
                ? 'Download failed'
                : state.failed === 'install'
                  ? 'Install failed'
                  : state.failed === 'load'
                    ? 'Updates unavailable'
                    : 'Check failed'
              : meta.badge.word}
          </span>
        )}
        <span className="set-code upd-version">v{state.currentVersion}</span>
      </header>

      {meta.body && <p className="set-help">{meta.body}</p>}

      {/* Named on the retry card too: "Try the download again" with nothing
          saying what is being downloaded is a button without an object. */}
      {(state.phase === 'available' ||
        (state.phase === 'error' && state.failed === 'download' && state.newVersion)) && (
        <p className="set-help">
          Version {state.newVersion} is available
          {state.releaseDate ? ` (${releaseDay(state.releaseDate)})` : ''}.
        </p>
      )}

      {state.phase === 'ready' && (
        <p className="set-help">
          Version {state.newVersion} is downloaded. Installing closes this app and reopens it
          on the new version, so finish anything in progress first.
        </p>
      )}

      {state.phase === 'ready-manual' && (
        <p className="set-help">
          Version {state.newVersion} is downloaded, but this build is not signed, so it cannot
          replace itself. Open the file to install it.
        </p>
      )}

      {state.releaseNotes && (state.phase === 'available' || state.phase === 'ready') && (
        <div className="upd-notes">{state.releaseNotes}</div>
      )}

      {state.phase === 'downloading' && (
        <div className="upd-progress" role="progressbar" aria-valuenow={Math.round(state.percent ?? 0)} aria-valuemin={0} aria-valuemax={100}>
          <div className="upd-progress-bar" style={{ width: `${state.percent ?? 0}%` }} />
        </div>
      )}
      {state.phase === 'downloading' && (
        <p className="set-meta upd-progress-text">
          {Math.round(state.percent ?? 0)}%{speed ? ` · ${speed}` : ''}
        </p>
      )}

      {/* Already phrased for a reader by main; the panel never invents its own
          account of a failure it did not diagnose. */}
      {/* Shown whenever there IS one, not only in the error phase: a failed
          check from `ready` keeps the downloaded update on purpose, and the
          reason it failed still has to reach the reader. */}
      {/* Danger when something FAILED, neutral when it did not -- keyed on
          `failed`, not on the phase. A downloaded update KEEPS its phase
          through a failed check, so `ready` covers both "could not reach the
          update server" and "you chose not to close the app", and only the
          failure kind tells them apart. */}
      {state.error && (
        <p className={state.failed !== null ? 'upd-error' : 'upd-note'}>{state.error}</p>
      )}
      {localError && <p className="upd-error">{localError}</p>}

      <div className="upd-row">
        {/* A failed DOWNLOAD still names a version, so the retry is another
            download, not another check — which is what the shared error phase
            would otherwise offer. */}
        {(state.phase === 'available' ||
          (state.phase === 'error' && state.failed === 'download' && state.newVersion !== null)) && (
          <button
            type="button"
            className={`btn btn-primary${busy.download ? ' is-busy' : ''}`}
            onClick={download}
            aria-disabled={busy.download || undefined}
            data-tip={busy.download ? 'Starting the download.' : undefined}
          >
            {/* The pulsing glyph is what makes busy MOVE; the ring alone is a
                static state indistinguishable from a stylistic border. */}
            {busy.download && (
              <span className="btn-glyph" aria-hidden="true">
                ↓
              </span>
            )}
            {state.phase === 'error' ? 'Try the download again' : 'Download update'}
          </button>
        )}
        {state.phase === 'downloading' && (
          <button type="button" className="btn btn-secondary" onClick={cancel}>
            Stop downloading
          </button>
        )}
        {state.phase === 'ready' && (
          <button
            type="button"
            className={`btn btn-primary${busy.install ? ' is-busy' : ''}`}
            onClick={install}
            aria-disabled={busy.install || undefined}
            data-tip={busy.install ? 'Closing this app to install.' : undefined}
          >
            {busy.install && (
              <span className="btn-glyph" aria-hidden="true">
                ⟳
              </span>
            )}
            {busy.install ? 'Restarting…' : 'Install and restart'}
          </button>
        )}
        {state.phase === 'ready-manual' && (
          <button type="button" className="btn btn-primary" onClick={reveal}>
            Show the file
          </button>
        )}

        {state.phase !== 'downloading' && (
          <button
            type="button"
            className={`btn btn-secondary${busy.check || state.phase === 'checking' ? ' is-busy' : ''}`}
            onClick={check}
            // `aria-disabled`, not `disabled`: a refusal that must EXPLAIN
            // itself has to stay hoverable, and the real attribute kills the
            // pointer events the tooltip is delegated from.
            aria-disabled={!state.configured || busy.check || state.phase === 'checking' || undefined}
            data-tip={
              // A refused feed is NOT an absent one, and saying "none
              // configured" above an error explaining that one was rejected
              // leaves the reader with two contradictory accounts.
              !state.configured && state.failed === 'load'
                ? 'This build could not start its updater, so it cannot check.'
                : !state.configured && state.error
                  ? 'This build cannot use the update server it was given.'
                  : !state.configured
                    ? 'This build has no update server configured, so there is nothing to check.'
                    : state.phase === 'checking' || busy.check
                      ? 'Asking the update server now.'
                      : undefined
            }
          >
            {(state.phase === 'checking' || busy.check) && (
              <span className="btn-glyph" aria-hidden="true">
                ⟳
              </span>
            )}
            {state.phase === 'checking' ? 'Checking…' : 'Check for updates'}
          </button>
        )}

        {checked && state.phase !== 'downloading' && state.phase !== 'checking' && (
          <span className="set-meta upd-checked">{checked}</span>
        )}
      </div>
    </section>
  )
}
