import { useState } from 'react'
import { Modal } from './ui'

/**
 * Zotero is connected for this project but is not running, and papers are about
 * to be imported.
 *
 * ASKED BEFORE THE IMPORT, not reported after it. The point of the connection is
 * that a paper reaches the user's library; discovering afterwards that thirty of
 * them did not, and having to work out which, is the outcome this exists to
 * prevent. So the question is put while it can still be answered cheaply.
 *
 * TWO ANSWERS, and neither is "carry on quietly". `Retry` re-checks, for the
 * ordinary case where Zotero simply had not been started yet. `Disable
 * connection` is an explicit choice to stop sending, which then says plainly
 * what has changed and where to undo it — because a connection that silently
 * stopped working is indistinguishable from one that never worked.
 */
export function ZoteroOfflineModal({
  onRetry,
  onDisable,
  onClose
}: {
  /** Re-check. Resolves true when Zotero answered, false when it still does not. */
  onRetry: () => Promise<boolean>
  /** Turn the connection off for this project, then continue the import. */
  onDisable: () => Promise<void>
  onClose: () => void
}): JSX.Element {
  const [busy, setBusy] = useState<'retry' | 'disable' | null>(null)
  const [disabled, setDisabled] = useState(false)
  const [stillDown, setStillDown] = useState(false)
  /** A failed retry or a failed write, shown rather than swallowed. */
  const [failure, setFailure] = useState<string | null>(null)

  // The confirmation of turning it off. A separate screen rather than a line in
  // the first one, because it reports something that has ALREADY happened and
  // must not be mistaken for another question.
  if (disabled) {
    return (
      <Modal
        title="Zotero connection disabled"
        onClose={onClose}
        testid="zotero-disabled-modal"
        role="alertdialog"
      >
        <div className="form">
          <p className="wizard-help" data-testid="zotero-disabled-text">
            Zotero connection was disabled, publications won&apos;t be imported to it anymore. Go
            to Integrations to re-enable it.
          </p>
          <div className="form-actions">
            <button
              type="button"
              className="btn btn-primary"
              data-testid="zotero-disabled-ok"
              onClick={onClose}
            >
              OK
            </button>
          </div>
        </div>
      </Modal>
    )
  }

  return (
    <Modal
      title="Zotero isn’t running"
      onClose={onClose}
      testid="zotero-offline-modal"
      role="alertdialog"
    >
      <div className="form">
        <p className="wizard-help">
          This project adds every imported paper to your Zotero library, and Zotero has to be
          open for that. Start it, then try again.
        </p>

        {/* Only after a retry that failed. Saying it up front would describe a
            check the user has not asked for yet. */}
        {stillDown && (
          <div className="form-error" role="alert" data-testid="zotero-offline-still">
            Still no answer from Zotero.
          </div>
        )}

        {failure && (
          <div className="form-error" role="alert" data-testid="zotero-offline-failure">
            {failure}
          </div>
        )}

        <div className="form-actions">
          <button
            type="button"
            className="btn btn-secondary"
            data-testid="zotero-offline-disable"
            disabled={busy !== null}
            data-tip={
              busy === 'retry'
                ? 'Checking for Zotero first.'
                : busy === 'disable'
                  ? 'Turning the connection off…'
                  : 'Stop sending this project’s papers to Zotero. The import carries on.'
            }
            onClick={() => {
              setBusy('disable')
              // A REJECTION MUST RELEASE THE BUTTONS. Without the catch, a
              // failed write left `busy` set for ever: both buttons disabled,
              // the import still waiting on an answer, and no way out of the
              // dialog but a reload.
              void onDisable()
                .then(() => setDisabled(true))
                .catch((e: unknown) =>
                  setFailure(e instanceof Error ? e.message : String(e))
                )
                .finally(() => setBusy(null))
            }}
          >
            {busy === 'disable' ? 'Disabling…' : 'Disable connection'}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            data-testid="zotero-offline-retry"
            disabled={busy !== null}
            data-tip={
              busy === 'retry'
                ? 'Looking for Zotero…'
                : busy === 'disable'
                  ? 'Turning the connection off first.'
                  : undefined
            }
            onClick={() => {
              setBusy('retry')
              setStillDown(false)
              setFailure(null)
              void onRetry()
                .then((up) => {
                  if (!up) setStillDown(true)
                })
                .catch((e: unknown) => setFailure(e instanceof Error ? e.message : String(e)))
                .finally(() => setBusy(null))
            }}
          >
            {busy === 'retry' ? 'Checking…' : 'Retry'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
