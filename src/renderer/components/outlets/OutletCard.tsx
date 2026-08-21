import type { ReactNode } from 'react'
import type { OutletStatusDTO } from '@shared/contract'

/**
 * The shell every outlet panel is rendered in.
 *
 * Shared so a new outlet gets its header, problem line and action row for free —
 * the registry decides what exists, and this decides how it looks.
 *
 * NO CHECKLIST, AND NO PROBLEM BOX. Each outlet's `status.checks` used to render
 * as a row per probe ("Vault folder chosen ✕ no", …) — a diagnostic readout, not
 * an interface: it filled half the card with crosses restating one fact, that
 * nothing is set up yet, which the headline already says in a sentence.
 *
 * Collapsing it to "the first failing check" was worse. Those labels are phrased
 * as satisfied conditions so they can sit beside a yes/no badge, so without the
 * badge they assert the opposite of the truth: a user with no Zotero was told
 * "Zotero library found: looked for zotero.sqlite in ~/Zotero".
 *
 * The checks are still COMPUTED — they decide `ready`, which drives what the
 * headline says and which actions are available — they are simply not narrated.
 * The state of an outlet is one line at the top; what to DO about it is the
 * control right beside the thing that is missing.
 */

export function OutletCard({
  status,
  avatar,
  pill,
  live,
  children
}: {
  status: OutletStatusDTO
  avatar: ReactNode
  pill: string
  /**
   * A LIVE link to the other app, when this outlet has one.
   *
   * Three-valued rather than boolean, because "not set up" and "set up but the
   * app is closed" are different situations and only the second is worth a
   * reader's attention. `undefined` is for an outlet with no such notion —
   * writing files to a vault is not a connection that can be up or down.
   */
  live?: 'live' | 'idle'
  children: ReactNode
}): JSX.Element {
  return (
    <section className="int-card" aria-labelledby={`outlet-${status.id}-name`}>
      <div className="int-card-head">
        <div
          className={`int-avatar int-avatar-${status.id}${live ? ` is-${live}` : ''}`}
          data-testid={`outlet-${status.id}-avatar`}
          aria-hidden="true"
        >
          {avatar}
        </div>
        <div className="int-card-id">
          <div className="int-card-name" id={`outlet-${status.id}-name`}>
            {status.name}
          </div>
          <div
            className={`int-status-line${status.ready ? '' : ' is-off'}`}
            data-testid={`outlet-${status.id}-status`}
          >
            <span className="int-dot" aria-hidden="true" />
            {status.headline}
          </div>
        </div>
        <span className="int-pill">{pill}</span>
      </div>

      {/* A failure from the LAST run is surfaced until the next one succeeds.
          Swallowing it would leave a user believing their vault is in sync when
          the write actually failed hours ago. */}
      {status.last_error && (
        <div className="int-remedy int-remedy-error" role="alert">
          <span className="int-remedy-title">Last run failed.</span> {status.last_error}
        </div>
      )}
      {!status.last_error && status.last_run_at && (
        <div className="int-remedy" role="note">
          <span className="int-remedy-title">Last written</span>{' '}
          {new Date(status.last_run_at).toLocaleString()}.
        </div>
      )}

      {children}
    </section>
  )
}

/**
 * A pill switch bound to a REAL persisted setting.
 *
 * There is no "preview only" variant, deliberately: the previous screen had
 * switches that moved and saved nothing, badged "not saved". A control that
 * cannot persist is not a control, and this one cannot be constructed without an
 * `onToggle` that writes.
 */
export function ToggleRow({
  title,
  sub,
  on,
  busy,
  onToggle,
  testid
}: {
  title: string
  sub: string
  on: boolean
  busy?: boolean
  onToggle: (next: boolean) => void
  testid?: string
}): JSX.Element {
  return (
    <div className={`int-toggle-row${busy ? ' is-busy' : ''}`} data-testid={testid}>
      <div className="int-toggle-copy">
        <div className="int-toggle-title">{title}</div>
        <div className="int-toggle-sub">{sub}</div>
      </div>
      <button
        type="button"
        className={`int-switch${on ? ' on' : ''}`}
        role="switch"
        aria-checked={on}
        aria-label={`${title} — ${on ? 'on' : 'off'}`}
        disabled={busy}
        onClick={() => onToggle(!on)}
      >
        <span className="int-knob" />
      </button>
    </div>
  )
}
