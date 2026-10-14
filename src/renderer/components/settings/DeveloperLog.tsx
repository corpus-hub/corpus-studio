import { useCallback, useEffect, useRef, useState } from 'react'
import type { DevLogStatusDTO } from '@shared/contract'
import { setDevView, useDevView } from '../../lib/prefs'

/**
 * The developer-log section of Settings.
 *
 * WHY A USER-FACING SWITCH rather than an env var. The failures worth capturing
 * are the ones a scientist hits on their own corpus — an extracted value sitting
 * under evidence that does not support it — and they are the person who can
 * reproduce it. Asking them to relaunch the app from a terminal with a variable
 * set means the report arrives without the one artefact that would explain it.
 *
 * OFF is the honest default and is stated as such: this records the full text of
 * every prompt and every model response, which is their papers' content, and
 * nobody should discover after the fact that it was accumulating on disk.
 */
export function DeveloperLog(): JSX.Element {
  const devView = useDevView()
  const [status, setStatus] = useState<DevLogStatusDTO | null>(null)
  const [busy, setBusy] = useState(false)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(() => {
    void window.api.getDevLogStatus().then(setStatus)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Poll the size ONLY while recording. A log that never visibly grows looks
  // broken, and "it is on" is a much weaker statement than "it is on and has
  // written 240 KB". Stopped when off, so an idle Settings pane costs nothing.
  useEffect(() => {
    if (!status?.enabled) {
      if (timer.current) {
        clearInterval(timer.current)
        timer.current = null
      }
      return
    }
    timer.current = setInterval(refresh, 2000)
    return () => {
      if (timer.current) clearInterval(timer.current)
      timer.current = null
    }
  }, [status?.enabled, refresh])

  const on = status?.enabled ?? false

  const toggle = async (): Promise<void> => {
    setBusy(true)
    try {
      setStatus(await window.api.setDevLogEnabled(!on))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-section">
      <div className="settings-eyebrow mono">Developer</div>

      {/* FIRST, because it is the one a non-developer might reasonably want and
          the only one with no cost: it changes what the queue shows, records
          nothing, and can be turned off again with no trace. The log below it
          writes the full text of every paper to disk, which is a heavier thing
          to agree to and belongs after the cheap option. */}
      <div className="settings-pref-row">
        <div className="settings-pref-text">
          <div className="settings-pref-label" id="pref-devview-label">
            Show pipeline details in the queue
          </div>
          <div className="settings-pref-help" id="pref-devview-help">
            Why each step produced nothing, and what it was waiting on. Failures are always
            shown.
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={devView}
          aria-labelledby="pref-devview-label"
          aria-describedby="pref-devview-help"
          data-testid="pref-dev-view"
          className={`settings-switch${devView ? ' is-on' : ''}`}
          onClick={() => setDevView(!devView)}
        >
          <span className="settings-switch-track" aria-hidden="true">
            <span className="settings-switch-knob">{devView ? '✓' : '✕'}</span>
          </span>
          <span className="settings-switch-word" aria-hidden="true">
            {devView ? 'Shown' : 'Hidden'}
          </span>
        </button>
      </div>

      <div className="settings-pref-row">
        <div className="settings-pref-text">
          <div className="settings-pref-label" id="pref-devlog-label">
            Record a diagnostic log
          </div>
          <div className="settings-pref-help" id="pref-devlog-help">
            Every processing stage, every model conversation and how each quote was
            matched to a paragraph. Includes the full text of your papers, so leave
            it off unless you are chasing a problem.
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-labelledby="pref-devlog-label"
          aria-describedby="pref-devlog-help"
          data-testid="pref-dev-log"
          disabled={busy}
          data-tip={busy ? 'Applying…' : undefined}
          className={`settings-switch${on ? ' is-on' : ''}${busy ? ' is-busy' : ''}`}
          onClick={() => void toggle()}
        >
          <span className="settings-switch-track" aria-hidden="true">
            <span className="settings-switch-knob">{on ? '✓' : '✕'}</span>
          </span>
          <span className="settings-switch-word" aria-hidden="true">
            {on ? 'Recording' : 'Off'}
          </span>
        </button>
      </div>

      {/* Where it went and how big it is. A switch that reports nothing back
          leaves the user with no way to find what they just recorded, which is
          the only reason they turned it on. */}
      {status?.file && (
        <div className="settings-devlog-file" data-testid="dev-log-file">
          <code className="mono settings-devlog-path" title={status.file}>
            {status.file}
          </code>
          <span className="mono settings-devlog-size">{formatBytes(status.bytes)}</span>
          <button
            type="button"
            className="btn-link"
            data-testid="dev-log-reveal"
            onClick={() => void window.api.openDevLogDir()}
          >
            show in folder →
          </button>
        </div>
      )}
    </div>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
