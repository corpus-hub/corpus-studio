import { useState } from 'react'
import type { OutletActionDTO, OutletActionResultDTO } from '@shared/contract'

/**
 * The buttons an outlet offers, and the honest report of what one did.
 *
 * Two rules this component exists to keep:
 *
 *  - A DESTRUCTIVE action confirms first. `writes: true` actions that can lose
 *    the user's own work (overwriting hand-edited notes) ask before running;
 *    the confirmation names the consequence rather than saying "are you sure?".
 *  - The result line reports what ACTUALLY happened, including "nothing to
 *    write". A run that changed nothing says so — inflating it into a success
 *    message would be a fabricated outcome.
 */
export function OutletActions({
  projectId,
  outletId,
  actions,
  onDone
}: {
  projectId: number
  outletId: 'zotero' | 'obsidian'
  actions: OutletActionDTO[]
  onDone: () => void
}): JSX.Element | null {
  const [running, setRunning] = useState<string | null>(null)
  const [result, setResult] = useState<(OutletActionResultDTO & { label: string }) | null>(null)
  const [confirming, setConfirming] = useState<OutletActionDTO | null>(null)
  const [revealFailed, setRevealFailed] = useState(false)

  if (actions.length === 0) return null

  const run = async (action: OutletActionDTO): Promise<void> => {
    setConfirming(null)
    setRunning(action.id)
    setResult(null)
    setRevealFailed(false)
    try {
      const res = await window.api.runOutletAction(projectId, outletId, action.id)
      setResult({ ...res, label: action.label })
    } catch (e) {
      setResult({
        ok: false,
        message: e instanceof Error ? e.message : String(e),
        label: action.label
      })
    } finally {
      setRunning(null)
      // The status block above shows the last-run time and any error, so it is
      // refreshed whether the action succeeded or not.
      onDone()
    }
  }

  return (
    <div className="outlet-actions">
      <div className="outlet-action-row">
        {actions.map((a) => {
          const busy = running === a.id
          const blocked = a.disabled_reason
          // Actions that can destroy the user's own work confirm first and are
          // styled as destructive; the plain write only ever adds or updates
          // notes it wrote itself, so it runs immediately.
          const destructive = a.id === 'overwrite' || a.id === 'cleanup'
          return (
            <button
              key={a.id}
              type="button"
              className={`btn ${destructive ? 'btn-secondary outlet-btn-danger' : 'btn-primary'} outlet-btn`}
              data-testid={`outlet-${outletId}-${a.id}`}
              disabled={busy || running !== null || blocked !== null}
              data-tip={blocked ?? a.description}
              onClick={() => (destructive ? setConfirming(a) : void run(a))}
            >
              {busy ? 'Working…' : a.label}
            </button>
          )
        })}
      </div>

      {confirming && (
        <div className="outlet-confirm" role="alertdialog" data-testid="outlet-confirm">
          <div className="outlet-confirm-copy">
            <strong>{confirming.label}?</strong> {confirming.description}
          </div>
          <div className="outlet-confirm-actions">
            <button
              type="button"
              className="btn btn-secondary int-btn-sm"
              data-testid="outlet-confirm-cancel"
              onClick={() => setConfirming(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger int-btn-sm"
              data-testid="outlet-confirm-go"
              onClick={() => void run(confirming)}
            >
              {confirming.label}
            </button>
          </div>
        </div>
      )}

      <div className="int-export-status" role="status" aria-live="polite">
        {result && (
          <div className="mono export-msg" data-testid={`outlet-${outletId}-result`}>
            <span className={`badge badge-${result.ok ? 'ok' : 'danger'}`}>
              {result.ok ? 'done' : 'failed'}
            </span>{' '}
            {result.label} — {result.message}
            {result.paths && result.paths.length > 0 && (
              <span className="outlet-result-count">
                {' '}
                · {result.paths.length} file{result.paths.length === 1 ? '' : 's'}
              </span>
            )}
            {/* Without this a finished write is a dead end: the user is told
                files were written and has no way to go and look at them. */}
            {result.ok && (
              <button
                type="button"
                className="btn-link int-export-reveal"
                data-testid={`outlet-${outletId}-reveal`}
                onClick={() => {
                  void window.api.revealOutletFolder(outletId).then((shown) => {
                    if (!shown) setRevealFailed(true)
                  })
                }}
              >
                Show in folder
              </button>
            )}
            {revealFailed && (
              <span className="int-export-gone">— that folder is no longer there</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
