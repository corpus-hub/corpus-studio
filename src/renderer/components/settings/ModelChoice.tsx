import { useCallback, useEffect, useState } from 'react'
import type { ModelSettingsDTO } from '@shared/contract'

/**
 * Which model does which work, and how much room it gets.
 *
 * TWO ROLES, and the separation is the setting rather than a convenience. The
 * reading pass runs on every paper and is the volume cost; the checking pass
 * reads a table a SECOND time to disagree with the first reading, and its whole
 * value is that it fails differently. Put both on one model and the second
 * reading becomes an echo — it shares the first's blind spots, so it confirms
 * instead of checking. That is not a hypothetical: with one model the checker
 * passed three cells it had just transcribed correctly and differently.
 *
 * A FREE TEXT FIELD, not a picker. The endpoint in the AI settings decides what
 * a model name means, and a list this app maintains would be stale the week a
 * provider ships anything — offering only names it has heard of would refuse a
 * model the user's own gateway serves. What is typed is passed through.
 *
 * The context window is SHOWN, never enforced. A paper is split across messages
 * rather than trimmed to fit, so this number describes the model rather than
 * bounding the work.
 */

/** Kept in step with `MODEL_LIMITS` in main; the IPC layer refuses anything else. */
const LIMITS = {
  maxOutput: { min: 1024, max: 128000 },
  context: { min: 8192, max: 2000000 }
}

export function ModelChoice(): JSX.Element {
  const [settings, setSettings] = useState<ModelSettingsDTO | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** What the gateway told us it serves, as a hint — never a restriction. */
  const [known, setKnown] = useState<string[]>([])

  const refresh = useCallback(() => {
    void window.api
      .modelSettings()
      .then(setSettings)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
    void window.api
      .availableModels()
      .then(setKnown)
      .catch(() => setKnown([]))
  }, [])

  useEffect(refresh, [refresh])

  const write = async (next: Partial<Omit<ModelSettingsDTO, 'is_default'>>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setSettings(await window.api.setModelSettings(next))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      // Re-read rather than keep the value that failed: the pane must show what
      // the app is ACTUALLY using, not what was asked for and refused.
      refresh()
    } finally {
      setBusy(false)
    }
  }

  const reset = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setSettings(await window.api.resetModelSettings())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-section" data-testid="settings-models">
      <div className="settings-eyebrow mono">Which models do the work</div>
      <div className="settings-sub">
        Sent to the endpoint above, as typed. Reading and checking are kept separate on purpose:
        the checker is only worth running if it can disagree with the reader, and a model rarely
        disagrees with itself.
      </div>

      <ModelRow
        id="model-extraction"
        label="Reading papers"
        help="Extracting facts, measurements, citation contexts and summaries. This runs on every paper, so it is where the cost is."
        model={settings?.extractionModel ?? null}
        maxOutput={settings?.extractionMaxOutput ?? null}
        context={settings?.extractionContext ?? null}
        known={known}
        busy={busy}
        placeholder="e.g. claude-haiku"
        onModel={(v) => void write({ extractionModel: v })}
        onMaxOutput={(n) => void write({ extractionMaxOutput: n })}
        onContext={(n) => void write({ extractionContext: n })}
      />

      <ModelRow
        id="model-review"
        label="Checking what was read"
        help="Reading a paper's tables a second time, without being shown the first reading, so the two can be compared. Give it a different — ideally stronger — model than the one above."
        model={settings?.reviewModel ?? null}
        maxOutput={settings?.reviewMaxOutput ?? null}
        context={settings?.reviewContext ?? null}
        known={known}
        busy={busy}
        placeholder="e.g. claude-sonnet-5"
        onModel={(v) => void write({ reviewModel: v })}
        onMaxOutput={(n) => void write({ reviewMaxOutput: n })}
        onContext={(n) => void write({ reviewContext: n })}
      />

      {/* THE ONE COMBINATION WORTH WARNING ABOUT. Not a refusal — a user may
          have exactly one model available and still want the second reading,
          which catches a transcription slip even from the same model. But the
          comparison is much weaker, and nothing else on this pane would say so. */}
      {settings !== null &&
        settings.reviewModel !== '' &&
        settings.reviewModel === settings.extractionModel && (
          <p className="settings-pref-help is-warn" data-testid="model-same-warning">
            Both passes are on the same model, so the check is unlikely to catch a mistake the
            reading made — a model that misreads a cell one way usually misreads it the same way
            twice.
          </p>
        )}

      {error !== null && (
        <p className="settings-pref-help is-bad" role="alert" data-testid="model-settings-error">
          {error}
        </p>
      )}

      {/* HARD RULE 0.6: offered only when there is something to undo. */}
      {settings !== null && !settings.is_default && (
        <div className="set-actions">
          <button
            type="button"
            className="btn btn-secondary"
            data-testid="model-settings-reset"
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
 * One role: its model, and the two sizes that go with it.
 *
 * The model commits on blur or Enter rather than per keystroke — a write per
 * character would store a dozen half-typed model names, and one of them would
 * be what the next stage asked the gateway for.
 */
function ModelRow({
  id,
  label,
  help,
  model,
  maxOutput,
  context,
  known,
  busy,
  placeholder,
  onModel,
  onMaxOutput,
  onContext
}: {
  id: string
  label: string
  help: string
  model: string | null
  maxOutput: number | null
  context: number | null
  known: string[]
  busy: boolean
  placeholder: string
  onModel: (v: string) => void
  onMaxOutput: (n: number) => void
  onContext: (n: number) => void
}): JSX.Element {
  const [draft, setDraft] = useState(model ?? '')
  useEffect(() => setDraft(model ?? ''), [model])
  const commit = (): void => {
    if (draft.trim() !== (model ?? '')) onModel(draft.trim())
  }
  // A name the gateway did not list. NOT an error — the list is what one
  // gateway reported at startup, and the user may be pointing at another, or at
  // a model released since. Said quietly, as a fact rather than a refusal.
  //
  // AN ALIAS IS NOT AN UNKNOWN MODEL. A gateway lists the models it serves by
  // their full names (`claude-haiku-4-5-20251001`) while accepting short forms
  // that resolve to them (`claude-haiku`) — and the short form is the better
  // thing to store, because it survives a model rollover. Warning on those
  // would put a caution under the app's own default, which is how a warning
  // stops being read. So a name that PREFIXES a listed one is treated as
  // known.
  const typed = draft.trim()
  const unknown =
    typed !== '' &&
    known.length > 0 &&
    !known.some((m) => m === typed || m.startsWith(`${typed}-`))

  return (
    <div className="settings-pref-row settings-pref-stack" data-testid={id}>
      <div className="settings-pref-text">
        <div className="settings-pref-label" id={`${id}-label`}>
          {label}
        </div>
        <div className="settings-pref-help" id={`${id}-help`}>
          {help}
        </div>
      </div>
      <div className="settings-model-fields">
        <label className="settings-model-field settings-model-field-grow">
          <span className="settings-model-cap">Model</span>
          <input
            className="settings-text"
            data-testid={`${id}-name`}
            aria-labelledby={`${id}-label`}
            aria-describedby={`${id}-help`}
            list={known.length > 0 ? 'settings-known-models' : undefined}
            placeholder={placeholder}
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commit()
              }
            }}
          />
        </label>
        <NumField
          id={`${id}-output`}
          cap="Max output"
          value={maxOutput}
          min={LIMITS.maxOutput.min}
          max={LIMITS.maxOutput.max}
          busy={busy}
          tip="The longest answer this model may return. A whole table read cell by cell is a long answer, and one cut short is discarded rather than shortened."
          onCommit={onMaxOutput}
        />
        <NumField
          id={`${id}-context`}
          cap="Context"
          value={context}
          min={LIMITS.context.min}
          max={LIMITS.context.max}
          busy={busy}
          tip="How much this model can hold at once. Recorded for reference — a paper is split across messages rather than trimmed to fit."
          onCommit={onContext}
        />
      </div>
      {unknown && (
        <p className="settings-pref-help" data-testid={`${id}-unknown`}>
          The endpoint did not list this model at startup. It is still sent as typed — the list is
          only what one gateway reported.
        </p>
      )}
      {known.length > 0 && (
        <datalist id="settings-known-models">
          {known.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      )}
    </div>
  )
}

/** A whole number, committed on blur or Enter and never per keystroke. */
function NumField({
  id,
  cap,
  value,
  min,
  max,
  busy,
  tip,
  onCommit
}: {
  id: string
  cap: string
  value: number | null
  min: number
  max: number
  busy: boolean
  tip: string
  onCommit: (n: number) => void
}): JSX.Element {
  const [draft, setDraft] = useState(value === null ? '' : String(value))
  useEffect(() => setDraft(value === null ? '' : String(value)), [value])
  const commit = (): void => {
    const n = Number.parseInt(draft.replace(/[^\d]/g, ''), 10)
    if (!Number.isFinite(n) || n === value) {
      setDraft(value === null ? '' : String(value))
      return
    }
    onCommit(Math.min(max, Math.max(min, n)))
  }
  return (
    <label className="settings-model-field" data-tip={tip}>
      <span className="settings-model-cap">{cap}</span>
      <input
        className="settings-text settings-text-num"
        data-testid={id}
        inputMode="numeric"
        aria-label={cap}
        value={draft}
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          }
        }}
      />
    </label>
  )
}
