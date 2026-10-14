import { useEffect, useState } from 'react'
import type { ZoteroTargetDTO } from '@shared/contract'
import { Modal, Select } from './ui'

/**
 * Point this project's new papers at a collection in a RUNNING Zotero.
 *
 * WHY IT WAITS RATHER THAN REFUSING. The destinations can only be read from a
 * live Zotero — they are addressed by an id that exists nowhere on disk — so a
 * user who opens this with Zotero closed has to go and start it. Polling means
 * the dialog notices by itself; a "Try again" button would ask them to come back
 * and press something to learn what we could simply have watched for.
 *
 * CONNECT IS ABSENT, NOT DISABLED, until a destination is chosen. A greyed
 * button invites a click that does nothing and then has to explain itself. There
 * is no default selection for the same reason: guessing a collection would file
 * somebody's papers somewhere they did not choose.
 */
export function ZoteroConnectModal({
  projectId,
  onClose,
  onConnected
}: {
  projectId: number
  onClose: () => void
  onConnected: () => void
}): JSX.Element {
  const [running, setRunning] = useState<boolean | null>(null)
  const [targets, setTargets] = useState<ZoteroTargetDTO[]>([])
  const [chosen, setChosen] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ONE probe a second for as long as this is open, and it stops when it
  // closes. The interval is cleared on unmount, so a dialog dismissed while
  // waiting leaves nothing polling in the background.
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const probe = async (): Promise<void> => {
      try {
        const up = await window.api.isZoteroRunning().catch(() => false)
        if (cancelled) return
        setRunning(up)
        if (!up) {
          // Destinations belong to the Zotero that was running when we read
          // them. Keeping a stale list would offer a collection from a library
          // that is no longer open.
          setTargets([])
          return
        }
        try {
          const list = await window.api.listZoteroTargets()
          if (cancelled) return
          setTargets(list)
          // Cleared on SUCCESS, so a transient failure does not sit on screen
          // describing a problem that has since resolved itself.
          setError(null)
        } catch (e) {
          if (cancelled) return
          // A failure to LIST is reported, never rendered as "no collections" —
          // an empty list would be a fabricated fact about the user's library.
          setError(e instanceof Error ? e.message : String(e))
        }
      } finally {
        // SELF-SCHEDULING, not setInterval. An interval fires regardless of
        // whether the previous probe finished, and `listTargets` may take
        // seconds — so replies could land out of order and a stale list
        // overwrite a fresh one. Chaining the next tick to the end of this one
        // makes overlap impossible rather than merely unlikely.
        if (!cancelled) timer = setTimeout(() => void probe(), 1000)
      }
    }

    void probe()
    return () => {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
    }
  }, [])

  // A destination that disappears — the collection was deleted, or a different
  // library was opened — must not stay selected: Connect would then send papers
  // to an id Zotero no longer resolves.
  useEffect(() => {
    if (chosen !== '' && !targets.some((t) => t.id === chosen)) setChosen('')
  }, [targets, chosen])

  const connect = (): void => {
    const target = targets.find((t) => t.id === chosen)
    if (!target) return
    setBusy(true)
    setError(null)
    window.api
      .connectZotero(projectId, target.id, target.name)
      .then(onConnected)
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e))
        setBusy(false)
      })
  }

  return (
    <Modal title="Connect with Zotero" onClose={onClose} testid="zotero-connect-modal">
      <div className="form">
        {running === false && (
          <div className="zc-wait" role="status" data-testid="zotero-connect-waiting">
            <span className="zc-spinner" aria-hidden="true" />
            <div>
              <div className="zc-wait-title">Zotero isn’t running.</div>
              <div className="wizard-help">
                Start Zotero and leave it open — papers are added while it runs. This will
                carry on by itself as soon as it appears.
              </div>
            </div>
          </div>
        )}

        {running === null && (
          <div className="zc-wait" role="status">
            <span className="zc-spinner" aria-hidden="true" />
            <div className="zc-wait-title">Looking for Zotero…</div>
          </div>
        )}

        {running === true && (
          <>
            <label className="field">
              <span className="wizard-label">Send new papers to</span>
              {/* Both halves stated, because "with its PDF" alone would promise
                  a file for papers that have none. */}
              <span className="wizard-help">
                Every paper this project imports is added here with its PDF. Papers with no
                full text are added as a library entry.
              </span>
              <Select
                className="outlet-select"
                testid="zotero-connect-target"
                ariaLabel="Collection to send new papers to"
                value={chosen}
                options={[
                  { value: '', label: 'Choose a collection…' },
                  ...targets.map((t) => ({
                    value: t.id,
                    // Indented by depth so a child reads as belonging to its
                    // parent, which is the only cue Zotero's own list gives.
                    label: `${'\u00a0\u00a0'.repeat(t.level)}${t.name}`,
                    // A read-only group library takes items but refuses files.
                    // Named on the option, because discovering it after every
                    // paper arrives without its PDF is the worse way to learn.
                    tip: t.files_editable
                      ? undefined
                      : 'Zotero will not accept files here, so papers would arrive without their PDFs.'
                  }))
                ]}
                onChange={setChosen}
              />
            </label>

            {/* PER PROJECT, said before they choose. Corpus Studio projects each
                have their own destination, and someone who assumed this was an
                app-wide setting would find their next project sending nowhere. */}
            <p className="wizard-help" data-testid="zotero-connect-scope">
              This applies to this project only. Other projects keep their own choice.
            </p>
          </>
        )}

        {error && (
          <div className="form-error" role="alert" data-testid="zotero-connect-error">
            {error}
          </div>
        )}

        <div className="form-actions">
          {/* Both go inert only while the write is in flight, and both SAY so:
              a control that stops responding without a word is indistinguishable
              from a broken one. */}
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            disabled={busy}
            data-tip={busy ? 'Saving the connection — this will only take a moment.' : undefined}
          >
            Cancel
          </button>
          {chosen !== '' && (
            <button
              type="button"
              className="btn btn-primary"
              data-testid="zotero-connect-submit"
              disabled={busy}
              data-tip={busy ? 'Saving the connection…' : undefined}
              onClick={connect}
            >
              {busy ? 'Connecting…' : 'Connect'}
            </button>
          )}
        </div>
      </div>
    </Modal>
  )
}
