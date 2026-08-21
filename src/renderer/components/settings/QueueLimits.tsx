import { useCallback, useEffect, useState } from 'react'
import type { QueueSettingsDTO } from '@shared/contract'

/**
 * Pipeline concurrency.
 *
 * NAMED FOR WHAT IT IS. An earlier draft called these "papers the AI reads at
 * the same time" and "other steps", on the theory that a scientist should be
 * spared the word "stage". That was wrong twice over: the user of this app
 * reads the Queue screen, which names its stages, so inventing a second
 * vocabulary here made the setting harder to connect to the thing it governs —
 * and softening a precise term does not make a control easier to use, it makes
 * it harder to trust. The units are stages, so the labels say stages.
 *
 * BOTH LIMITS ARE GLOBAL, and the pane says so out loud. Someone watching two
 * projects process at once has no way to tell whether each gets its own
 * allowance, and guessing wrong means either an unexpected bill or an
 * unexplained wait.
 *
 * TWO NUMBERS AND NOT ONE, because the two kinds of stage are bound by
 * different resources — an AI stage waits on a remote service and uses almost
 * no CPU, a local stage is the opposite. One shared number meant a stage
 * waiting on the AI held a slot that a local stage could have used, and the
 * machine sat idle while the queue looked full.
 *
 * ONLY THESE TWO are exposed. The poll interval, retry budget and lease
 * timeout are all tunable in principle, and none of them is a question anyone
 * can answer better than the default — offering them would bury the two that
 * change what actually happens.
 */

/** Kept in step with `QUEUE_LIMITS` in main; the IPC layer refuses anything else. */
const RANGE = { min: 1, max: 8 }

export function QueueLimits(): JSX.Element {
  const [settings, setSettings] = useState<QueueSettingsDTO | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    void window.api
      .queueSettings()
      .then(setSettings)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  useEffect(refresh, [refresh])

  const write = async (next: { llm?: number; local?: number }): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setSettings(await window.api.setQueueSettings(next))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      // Re-read rather than keep the value that failed: the pane must show what
      // the app is ACTUALLY doing, not what was asked for and refused.
      refresh()
    } finally {
      setBusy(false)
    }
  }

  const reset = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setSettings(await window.api.resetQueueSettings())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-section" data-testid="settings-queue">
      <div className="settings-eyebrow mono">Pipeline concurrency</div>
      <div className="settings-sub">
        Both limits are global, not per project. Papers from every project share them.
      </div>

      <Stepper
        id="queue-llm"
        label="Maximum parallel AI stages"
        help={
          'How many pipeline stages that call the AI may run simultaneously. Each is a request '
          + 'to the AI service, so raising this costs proportionally more and makes rate limiting '
          + 'more likely.'
        }
        value={settings?.llm ?? null}
        busy={busy}
        onChange={(n) => void write({ llm: n })}
      />

      <Stepper
        id="queue-local"
        label="Maximum parallel local stages"
        help={
          'How many pipeline stages that run on this machine may run simultaneously — retrieval, '
          + 'OCR, text extraction, segmentation, embedding. These are bound by CPU rather than by '
          + 'the AI service, and keep running while an AI stage waits.'
        }
        value={settings?.local ?? null}
        busy={busy}
        onChange={(n) => void write({ local: n })}
      />

      {error !== null && (
        <p className="settings-pref-help is-bad" role="alert" data-testid="queue-settings-error">
          {error}
        </p>
      )}

      {/* HARD RULE 0.6: offered only when there is something to undo. On an
          install that never changed anything it would be a button whose only
          possible effect is nothing. */}
      {settings !== null && !settings.is_default && (
        <div className="set-actions">
          <button
            type="button"
            className="btn btn-secondary"
            data-testid="queue-settings-reset"
            disabled={busy}
            onClick={() => void reset()}
          >
            Restore defaults
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * A number chosen with two buttons rather than typed.
 *
 * The range is 1–8 and every value is one press away, so a free-text field
 * would only add the chance to type something that gets rejected. The buttons
 * disable at the ends AND say why, rather than silently refusing.
 */
function Stepper({
  id,
  label,
  help,
  value,
  busy,
  onChange
}: {
  id: string
  label: string
  help: string
  value: number | null
  busy: boolean
  onChange: (n: number) => void
}): JSX.Element {
  const atMin = value !== null && value <= RANGE.min
  const atMax = value !== null && value >= RANGE.max
  return (
    <div className="settings-pref-row">
      <div className="settings-pref-text">
        <div className="settings-pref-label" id={`${id}-label`}>
          {label}
        </div>
        <div className="settings-pref-help" id={`${id}-help`}>
          {help}
        </div>
      </div>
      <div
        className="settings-stepper"
        role="group"
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-help`}
        data-testid={id}
      >
        <button
          type="button"
          className="settings-stepper-btn"
          data-testid={`${id}-down`}
          aria-label={`${label}: one fewer`}
          disabled={busy || value === null || atMin}
          data-tip={atMin ? 'One at a time is the lowest.' : undefined}
          onClick={() => value !== null && onChange(value - 1)}
        >
          −
        </button>
        <span className="settings-stepper-value mono" aria-live="polite" data-testid={`${id}-value`}>
          {value ?? '—'}
        </span>
        <button
          type="button"
          className="settings-stepper-btn"
          data-testid={`${id}-up`}
          aria-label={`${label}: one more`}
          disabled={busy || value === null || atMax}
          data-tip={atMax ? `${RANGE.max} at a time is the most.` : undefined}
          onClick={() => value !== null && onChange(value + 1)}
        >
          +
        </button>
      </div>
    </div>
  )
}
