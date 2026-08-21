import { useCallback, useEffect, useState } from 'react'
import type { SummaryPromptDTO, SummaryPromptScopeDTO } from '@shared/contract'

// The editor for one of the two summary-writing briefs.
//
// SHOWS THE DEFAULT RATHER THAN AN EMPTY BOX. The user is replacing a SYSTEM
// prompt, and an empty textarea would ask them to write from nothing against
// instructions they have never seen — and would leave no way back to the shipped
// text once they had typed over it. So the box opens on the brief in force,
// "restore the built-in" is a real control, and while a custom brief is in force
// the shipped one can be read beside it.
//
// BLANK IS NOT A BRIEF. Clearing the box and saving restores the built-in; it
// never ships an empty system message, which would hand the model a summary task
// with no instructions and return prose that looks exactly as confident.
//
// SAYS WHAT SAVING COSTS. Editing a brief makes the summaries it governs stale —
// every general summary in the corpus, or one project's — and that is a large
// enough consequence that it must be stated before the button is pressed, not
// discovered afterwards in the queue.

export function SummaryPromptEditor({
  scope,
  projectId,
  title,
  help,
  scopeWarning
}: {
  scope: SummaryPromptScopeDTO
  /** Required for `scope='project'`; ignored for the corpus-wide brief. */
  projectId?: number
  title: string
  help: string
  /** What saving will make stale, in the user's terms. */
  scopeWarning: string
}): JSX.Element {
  const [dto, setDto] = useState<SummaryPromptDTO | null>(null)
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showBuiltin, setShowBuiltin] = useState(false)

  const load = useCallback(async (): Promise<SummaryPromptDTO> => {
    const d = await window.api.getSummaryPrompt({ scope, projectId })
    setDto(d)
    setText(d.text)
    return d
  }, [scope, projectId])

  useEffect(() => {
    let dead = false
    void load().catch((e: unknown) => {
      if (!dead) setError(e instanceof Error ? e.message : String(e))
    })
    return () => {
      dead = true
    }
  }, [load])

  // What SAVE would change. Compared against the text in force rather than
  // against the built-in, so pressing save on an untouched box is correctly a
  // no-op and the button says so instead of offering work it will not do.
  const dirty = dto !== null && text !== dto.text
  const custom = dto?.custom ?? false
  // Restoring is only available when there is something to restore FROM. On the
  // built-in brief the control would do nothing and its presence would suggest
  // the current text is not the default.
  const canRestore = custom || (dto !== null && text.trim() !== dto.builtin.trim())

  const save = async (): Promise<void> => {
    if (!dto || saving || !dirty) return
    setSaving(true)
    setError(null)
    try {
      // Blank, or byte-identical to the built-in, is sent as null: storing the
      // shipped text as an override would pin this brief to today's wording and
      // silently opt the user out of every future revision of it.
      const next = text.trim() === '' || text.trim() === dto.builtin.trim() ? null : text
      const d = await window.api.setSummaryPrompt({ scope, projectId, text: next })
      setDto(d)
      setText(d.text)
      setSaved(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const restore = async (): Promise<void> => {
    if (!dto || saving) return
    setSaving(true)
    setError(null)
    try {
      const d = await window.api.setSummaryPrompt({ scope, projectId, text: null })
      setDto(d)
      setText(d.text)
      setSaved(true)
      setShowBuiltin(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="settings-section prompt-editor" data-testid={`summary-prompt-${scope}`}>
      <div className="settings-eyebrow mono">{title}</div>
      <p className="prompt-editor-help">{help}</p>

      {/* HARD RULE 0.6 — nothing is said while the built-in brief is in force,
          which is the ordinary state. Only a REPLACED brief is announced, and
          only because it is the state that explains why this app's summaries
          read unlike a fresh install's. */}
      {custom && (
        <div className="badge badge-warn prompt-editor-badge" data-testid={`summary-prompt-${scope}-custom`}>
          replaced with your own instructions
        </div>
      )}

      <textarea
        className="input textarea prompt-editor-text mono"
        data-testid={`summary-prompt-${scope}-text`}
        rows={14}
        spellCheck={false}
        value={text}
        disabled={dto === null}
        aria-busy={saving}
        onChange={(e) => {
          setText(e.target.value)
          setSaved(false)
        }}
      />

      <div className="prompt-editor-actions">
        <button
          type="button"
          className="btn btn-primary"
          data-testid={`summary-prompt-${scope}-save`}
          // `aria-disabled`, not `disabled`: a control that refuses has to be
          // able to say WHY, and Chromium dispatches no pointer events on a
          // disabled form control, so the tooltip would never be readable.
          aria-disabled={!dirty || saving || dto === null}
          data-tip={
            saving
              ? 'Saving…'
              : !dirty
                ? 'The instructions have not been changed.'
                : scopeWarning
          }
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save instructions'}
        </button>

        <button
          type="button"
          className="btn btn-secondary"
          data-testid={`summary-prompt-${scope}-restore`}
          aria-disabled={!canRestore || saving}
          data-tip={
            canRestore
              ? 'Discard these instructions and go back to the ones this app ships with.'
              : 'These are already the built-in instructions.'
          }
          onClick={() => void restore()}
        >
          Restore the built-in
        </button>

        {/* Only worth offering while the two DIFFER: on the built-in brief the
            comparison would show the same text twice. */}
        {custom && (
          <button
            type="button"
            className="btn-link prompt-editor-reveal"
            data-testid={`summary-prompt-${scope}-show-builtin`}
            aria-expanded={showBuiltin}
            onClick={() => setShowBuiltin((v) => !v)}
          >
            {showBuiltin ? 'hide the built-in ↑' : 'show the built-in ↓'}
          </button>
        )}

        {saved && !dirty && <span className="set-note set-note-ok">Saved</span>}
      </div>

      {error && (
        <div className="form-error mono" role="alert" data-testid={`summary-prompt-${scope}-error`}>
          {error}
        </div>
      )}

      {showBuiltin && dto && (
        <pre className="prompt-editor-builtin mono" data-testid={`summary-prompt-${scope}-builtin`}>
          {dto.builtin}
        </pre>
      )}
    </div>
  )
}
