import { useRef, useState } from 'react'
import type { ExtractionSchemaDTO } from '@shared/contract'
import { Modal } from './ui'

/**
 * Create an extraction schema without leaving the page that asked for one.
 *
 * OVER the setup questionnaire rather than a trip to the Schemas screen: that
 * screen is app-level and closes the project, so sending someone there
 * mid-questionnaire would drop them somewhere with no way back to the form they
 * were halfway through.
 *
 * A NAME ONLY. The fields that make a schema useful are defined on the Schemas
 * screen, where there is room for them, and this says so rather than pretending
 * an empty schema is finished — an empty one extracts nothing, and a user who
 * thought they were done would find no values and no reason why.
 */
export function SchemaCreateModal({
  onClose,
  onCreated
}: {
  onClose: () => void
  onCreated: (schema: ExtractionSchemaDTO) => void
}): JSX.Element {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const create = (): void => {
    if (!name.trim()) return
    setBusy(true)
    setError(null)
    window.api
      .createSchema({ name: name.trim() })
      .then(onCreated)
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e))
        setBusy(false)
      })
  }

  return (
    <Modal title="New schema" onClose={onClose} testid="schema-create-modal" initialFocusRef={inputRef}>
      <div className="form">
        <label className="field">
          <span className="wizard-label">Schema name</span>
          <span className="wizard-help">
            A short name for the group of things you want collected.
          </span>
          <input
            ref={inputRef}
            className="input"
            data-testid="schema-create-name"
            value={name}
            placeholder="What this group of values is called."
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim() && !busy) {
                e.preventDefault()
                create()
              }
            }}
          />
        </label>

        {/* STATED, because an empty schema silently extracts nothing. */}
        <p className="wizard-help">
          This makes an empty schema. Nothing gets collected until you tell it what to look for —
          you do that on the Schemas screen once your project is open.
        </p>

        {error && (
          <div className="form-error" role="alert" data-testid="schema-create-error">
            {error}
          </div>
        )}

        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            data-testid="schema-create-submit"
            disabled={busy || !name.trim()}
            data-tip={name.trim() ? undefined : 'Give the schema a name first.'}
            onClick={create}
          >
            {busy ? 'Creating…' : 'Create schema'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
