import { useEffect, useRef, useState } from 'react'
import type { QuitChoice, QuitStateDTO } from '@shared/contract'
import { Modal } from './ui'

// Asked when the user closes the app while a paper is still being read.
//
// Main holds the close open and drives `phase`; this only renders the question
// and reports the answer back. The count is pushed live, so a paper landing
// while the user reads the prompt updates the sentence rather than leaving it
// claiming work that has already finished.
//
// Wording is deliberately plain: the reader is a scientist, not the person who
// wrote the queue. Nothing here says job, queue, in-flight or drain.

/** After this long the wait stops pretending it is nearly over. */
const SLOW_MS = 45_000

export function CloseGuardModal(): JSX.Element | null {
  const [state, setState] = useState<QuitStateDTO>({ phase: 'idle', busy: 0, elapsedMs: 0 })
  // Which answer is being carried out. Between the click and the window going
  // away there is a real gap, and a button that looks untouched across it reads
  // as a dead click.
  const [pending, setPending] = useState<QuitChoice | null>(null)
  const stayRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    const off = window.api.window.onQuitState(setState)
    // A window that mounts while the prompt is already open (a reload during a
    // wait) must not render an empty shell.
    void window.api.window.getQuitState().then(setState)
    return off
  }, [])

  // Main acted on the answer, so the answer is no longer in flight. Keyed on any
  // phase change, not just the return to idle: choosing "Finish this paper
  // first" moves asking → finishing, and holding `pending` across that would
  // leave the wait's own Close now / Keep working buttons disabled forever —
  // exactly the trap the wait is supposed to have an exit from.
  useEffect(() => {
    setPending(null)
  }, [state.phase])

  if (state.phase === 'idle') return null

  const decide = (choice: QuitChoice): void => {
    // Guarded here rather than by the `disabled` attribute: Chromium fires no
    // pointer or focus events on a disabled control, so the tooltip explaining
    // WHY it is unavailable would never appear, and the modal's focus trap
    // would lose its anchor the moment all three went dead.
    if (pending !== null) return
    setPending(choice)
    void window.api.window.quitDecision(choice).catch(() => setPending(null))
  }

  const finishing = state.phase === 'finishing'
  const slow = finishing && state.elapsedMs >= SLOW_MS
  const n = state.busy
  const busy = pending !== null
  const tip =
    pending === 'cancel'
      ? 'Staying in the app…'
      : pending === 'finish'
        ? 'Waiting for this paper to finish…'
        : 'Closing…'

  return (
    <Modal
      title={finishing ? 'Finishing up' : 'Still reading papers'}
      role="alertdialog"
      hideDismiss
      // Escape is the safe answer, never the destructive one.
      onClose={() => !busy && decide('cancel')}
      initialFocusRef={stayRef}
      testid="close-guard-modal"
    >
      <div className={`cgd-body ${finishing ? 'cgd-body-finishing' : ''}`} key={state.phase}>
        {finishing ? (
          <>
            <div className="cgd-wait">
              <span className="cgd-spinner" aria-hidden="true" />
              <span className="cgd-wait-text">
                Corpus Studio will close on its own when it finishes.
              </span>
            </div>
            <div className="cgd-count mono" aria-live="polite" data-testid="close-guard-count">
              {n === 1 ? '1 paper still finishing' : `${n} papers still finishing`}
            </div>
            {slow && (
              <div className="cgd-slow" role="status" data-testid="close-guard-slow">
                This is taking longer than usual. You can close now — the paper starts over next
                time.
              </div>
            )}
          </>
        ) : (
          <p className="cgd-lede" data-testid="close-guard-lede">
            {n === 1
              ? 'Corpus Studio is reading a paper right now. Close now and it starts over next time.'
              : `Corpus Studio is reading ${n} papers right now. Close now and they start over next time.`}
          </p>
        )}
      </div>

      {/* Wrapped so the whole row (which loses a button between phases) fades
          rather than reflowing in one frame. */}
      <div className="modal-actions cgd-actions" key={`act-${state.phase}`}>
        <button
          type="button"
          className={`btn btn-danger ${pending === 'now' ? 'is-busy' : ''}`}
          data-testid="close-guard-now"
          aria-disabled={busy}
          data-tip={busy ? tip : undefined}
          onClick={() => decide('now')}
        >
          <span className="btn-glyph" aria-hidden="true">
            ⚠
          </span>
          {finishing ? 'Close now' : 'Close anyway'}
        </button>
        {!finishing && (
          <button
            type="button"
            className={`btn btn-secondary ${pending === 'finish' ? 'is-busy' : ''}`}
            data-testid="close-guard-finish"
            aria-disabled={busy}
            data-tip={busy ? tip : undefined}
            onClick={() => decide('finish')}
          >
            Finish this paper first
          </button>
        )}
        <button
          type="button"
          ref={stayRef}
          className={`btn btn-primary ${pending === 'cancel' ? 'is-busy' : ''}`}
          data-testid="close-guard-cancel"
          aria-disabled={busy}
          data-tip={busy ? tip : undefined}
          onClick={() => decide('cancel')}
        >
          Keep working
        </button>
      </div>
    </Modal>
  )
}
