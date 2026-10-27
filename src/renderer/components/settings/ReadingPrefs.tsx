import { setShowProvenance, useShowProvenance } from '../../lib/prefs'

/**
 * The reading-preferences section of Settings.
 *
 * "Show additional provenance" belongs HERE rather than on the paper it
 * affects: how much metadata a reader wants beside extracted claims is a
 * property of the reader, constant across every paper and every session, so a
 * per-paper control would have to be re-found and re-explained on each one.
 *
 * The explanation names exactly what appears, because "provenance" is a word a
 * scientist knows and an app can still mean anything by. What it does NOT do is
 * equally worth stating: turning it off hides metadata, never a warning — the
 * caveats strip on a paper (superseded, stale inputs, abstract-only, failed
 * checks) is unconditional. A setting a reader suspects of hiding problems is a
 * setting they leave on, and then it buys nothing.
 */
export function ReadingPrefs(): JSX.Element {
  const on = useShowProvenance()
  return (
    <div className="settings-section">
      <div className="settings-eyebrow mono">Reading</div>
      <div className="settings-pref-row">
        <div className="settings-pref-text">
          <div className="settings-pref-label" id="pref-provenance-label">
            Show additional provenance
          </div>
          {/* One line, not five. The detail lived here because the setting is
              hard to name; the answer is a better name, not a paragraph the
              reader must parse to decide on a switch. Warnings are never
              hidden by it, which is the only caveat worth stating. */}
          <div className="settings-pref-help" id="pref-provenance-help">
            Model, versions and freshness on each analysis. Warnings always show.
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-labelledby="pref-provenance-label"
          aria-describedby="pref-provenance-help"
          data-testid="pref-show-provenance"
          className={`settings-switch${on ? ' is-on' : ''}`}
          onClick={() => setShowProvenance(!on)}
        >
          <span className="settings-switch-track" aria-hidden="true">
            <span className="settings-switch-knob">{on ? '✓' : '✕'}</span>
          </span>
          {/* The state as a WORD, for anyone the knob's position and tint do not
              reach. Hidden from assistive tech, which already gets the state
              from `aria-checked` — and leaving it in the accessible name would
              make the spoken name "…provenance Shown", which no voice-control
              user would say. */}
          <span className="settings-switch-word" aria-hidden="true">
            {on ? 'Shown' : 'Hidden'}
          </span>
        </button>
      </div>
    </div>
  )
}
