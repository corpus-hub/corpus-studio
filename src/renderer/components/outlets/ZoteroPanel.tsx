import { useCallback, useEffect, useState } from 'react'
import type {
  OutletSettingsDTO,
  OutletStatusDTO,
  ZoteroConnectionDTO
} from '@shared/contract'
import { OutletCard, ToggleRow } from './OutletCard'
import { ZoteroConnectModal } from '../ZoteroConnectModal'

/**
 * Zotero: send this project's papers to a running library, and hand notes back.
 *
 * EVERYTHING HERE GOES OVER HTTP. Papers are handed to a RUNNING Zotero through
 * its own local server, which performs every write itself — `zotero.sqlite` is
 * locked while Zotero runs and its schema shifts between versions, so this app
 * never writes it. Notes still leave as an RDF file the user imports, which is
 * the same principle by another route.
 *
 * NOTHING ON THIS PANEL NEEDS A FILE PATH. The data-folder picker and the
 * import-from-a-collection control were both here to read the library off the
 * disk, and both are gone: the connector addresses a collection by an id the
 * running app hands out, so a user with Zotero installed anywhere at all is
 * asked nothing.
 */
export function ZoteroPanel({
  projectId,
  status,
  settings,
  pending,
  onPatch,
  onChanged,
  onGoToPapers
}: {
  projectId: number
  status: OutletStatusDTO
  settings: OutletSettingsDTO['zotero']
  pending: string | null
  onPatch: (delta: Record<string, unknown>) => Promise<boolean>
  onChanged: () => void
  onGoToPapers: () => void
}): JSX.Element {
  const [connection, setConnection] = useState<ZoteroConnectionDTO | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [busy, setBusy] = useState<'export' | 'send' | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string; added?: number } | null>(
    null
  )

  /**
   * Papers this project holds that Zotero has not been sent.
   *
   * Read from the SAME staleness authority the Queue's refresh uses, never
   * counted here: `zotero-push` fingerprints on the destination, so a paper
   * imported while disconnected — or before the destination was changed —
   * carries a run whose key no longer matches and reports stale. Deriving a
   * second count would eventually disagree with the button that acts on it.
   */
  const [backlog, setBacklog] = useState<Array<{ work_id: number; stage_ids: string[] }>>([])

  const refreshBacklog = useCallback((): void => {
    void window.api
      .staleWorks(projectId)
      .then((rows) =>
        // ONLY papers whose Zotero step is the stale one. A paper waiting on a
        // re-summarise is not a paper missing from the library, and sweeping it
        // in here would make this button re-run model work nobody asked for.
        setBacklog(
          rows
            .filter((r) => r.stage_ids.includes('zotero-push'))
            .map((r) => ({ work_id: r.work_id, stage_ids: ['zotero-push'] }))
        )
      )
      .catch(() => setBacklog([]))
  }, [projectId])

  const refreshConnection = useCallback((): void => {
    void window.api
      .getZoteroConnection(projectId)
      .then(setConnection)
      .catch(() => setConnection(null))
  }, [projectId])

  // `running` is a fact about RIGHT NOW, so it is re-read on a timer rather than
  // once on mount: Zotero can be quit while this screen sits open, and a green
  // light left over from three minutes ago is exactly the lie the state is meant
  // to prevent. Five seconds is enough here — the one-second poll belongs to the
  // connect dialog, where somebody is actively waiting.
  useEffect(() => {
    refreshConnection()
    const timer = setInterval(refreshConnection, 5000)
    return () => clearInterval(timer)
  }, [refreshConnection])

  // The backlog moves only when the connection or the papers do, so it is read
  // on those events rather than polled: a staleness sweep walks every paper in
  // the project and is far too expensive to run every five seconds.
  useEffect(() => {
    if (connection?.connected === true) refreshBacklog()
    else setBacklog([])
  }, [connection?.connected, connection?.target_id, refreshBacklog])

  // The RDF carries this project's papers and the notes about them, so with no
  // papers there is nothing to hand back. This export bypasses the outlet-action
  // registry (it has its own IPC channel), so it does not inherit the
  // `disabledReason` guard the Obsidian mirror gets for free.
  const [noPapers, setNoPapers] = useState(false)
  useEffect(() => {
    void window.api.getProject(projectId).then((p) => setNoPapers(p != null && p.work_count === 0))
  }, [projectId])

  // A project WITH papers can still have nothing to send: with the PDFs switch
  // on, a paper whose file cannot be read is left out whole, and if that is
  // every paper the bundle would be empty. Read from the outlet's own check
  // rather than recounted here, so the button and the check can never disagree.
  const nothingToSend =
    !noPapers && status.checks.some((c) => c.label === 'Papers ready to send' && c.ok === false)

  /**
   * Send the papers Zotero has not been given yet.
   *
   * Re-runs `zotero-push` AND NOTHING ELSE. `rerunStages` takes the stage ids
   * to redo, and this passes exactly one — so a paper imported before the
   * connection existed is handed over without re-fetching its PDF, re-reading
   * its text or re-running a single model call. The stage provides no
   * capability, so the supersede cascade has nothing downstream to reach and
   * cannot widen this into a pipeline run.
   */
  const sendBacklog = async (): Promise<void> => {
    setBusy('send')
    setMessage(null)
    try {
      let sent = 0
      for (const row of backlog) {
        await window.api.rerunStages(row.work_id, row.stage_ids, projectId)
        sent += 1
      }
      setMessage({
        ok: true,
        text: `Queued ${sent} paper${sent === 1 ? '' : 's'} to be added to ${
          connection?.target_name ?? 'Zotero'
        }. Watch the queue for progress.`
      })
      refreshBacklog()
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(null)
    }
  }

  const runExport = async (): Promise<void> => {
    setBusy('export')
    setMessage(null)
    try {
      const res = await window.api.exportZoteroRdf(projectId)
      if (res.canceled) {
        setMessage({ ok: true, text: 'Cancelled — no file was written.' })
        return
      }
      // What actually went in, said plainly. A bundle is SELECTIVE — a paper
      // whose file could not be read is left out record and all — and a user
      // told only "saved" would find out by counting items in Zotero.
      const omitted =
        res.omitted > 0
          ? ` · ${res.omitted} left out (no readable PDF)`
          : ''
      const unpack = res.bundled ? 'unzip it, then import' : 'import it with'
      setMessage({
        ok: true,
        text:
          `Saved to ${res.path} · ${res.papers} paper${res.papers === 1 ? '' : 's'}${omitted}` +
          ` · ${unpack} File → Import in Zotero.`
      })
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(null)
    }
  }

  const connected = connection?.connected === true
  const live = connected ? (connection?.running === true ? 'live' : 'idle') : undefined

  return (
    <OutletCard status={status} pill="Library" avatar="Z" live={live}>
      {/* WHERE NEW PAPERS GO. Only shown once connected: with nothing set up
          there is no destination to describe, and the Connect button below is
          already the thing to do about that. */}
      {connected && (
        <div className="zc-live" data-testid="zotero-connection">
          {/* A BOUNDED BLOCK, not a fourth label-and-value row. A live link to
              another running application is a different kind of thing from a
              folder path or a dropdown, and rendering it at the same weight as
              its neighbours is what made this card read as an undifferentiated
              stack. The surface groups the destination with the actions that
              act on it, so the eye takes them as one subject. */}
          <div className="zc-live-head">
            <div className="zc-live-copy">
              <div className="zc-live-label">Sending new papers to Zotero</div>
              <div className="zc-live-name" data-testid="zotero-target-name">
                {connection?.target_name}
              </div>
            </div>
            <div className="zc-live-actions">
              <button
                type="button"
                className="btn btn-secondary int-btn-sm"
                data-testid="zotero-change-target"
                onClick={() => setConnecting(true)}
                data-tip="Pick a different collection. Papers already sent stay where they are."
              >
                Change…
              </button>
              <button
                type="button"
                className="btn btn-secondary int-btn-sm"
                data-testid="zotero-disconnect"
                data-tip="Stop sending this project’s papers. Papers already in Zotero stay there."
                onClick={() => {
                  void window.api.disconnectZotero(projectId).then(refreshConnection)
                }}
              >
                Disconnect
              </button>
            </div>
          </div>

          {/* THE EXCEPTIONS, on their own line beneath the destination rather
              than crowded against it. Both are silent in the ordinary case: a
              running Zotero with nothing outstanding shows neither. */}
          {(connection?.running !== true || backlog.length > 0) && (
            <div className="zc-live-notes">
              {connection?.running !== true && (
                <span className="badge badge-warn" data-testid="zotero-not-running">
                  Zotero is not running
                </span>
              )}
              {backlog.length > 0 && (
                <span className="zc-live-note" data-testid="zotero-backlog">
                  <span className="badge badge-warn">
                    {backlog.length} not sent yet
                  </span>
                  <button
                    type="button"
                    className="btn btn-secondary int-btn-sm"
                    data-testid="zotero-send-backlog"
                    disabled={busy !== null || connection?.running !== true}
                    data-tip={
                      connection?.running !== true
                        ? 'Start Zotero first — the papers are added while it runs.'
                        : 'Adds only these papers to Zotero. Nothing else about them is re-run.'
                    }
                    onClick={() => void sendBacklog()}
                  >
                    {busy === 'send' ? 'Queueing…' : 'Send them'}
                  </button>
                </span>
              )}
            </div>
          )}
        </div>
      )}

      <ToggleRow
        title="Include summary notes"
        sub="One note per item: authors, venue and extracted values"
        on={settings.summary_notes}
        busy={pending === 'zotero.summary_notes'}
        onToggle={(next) => void onPatch({ summary_notes: next })}
        testid="zotero-toggle-summary"
      />
      <ToggleRow
        title="Include project notes"
        sub="Relevance and expansion scores for this project"
        on={settings.project_notes}
        busy={pending === 'zotero.project_notes'}
        onToggle={(next) => void onPatch({ project_notes: next })}
        testid="zotero-toggle-project"
      />
      {/* The papers THEMSELVES. The sub-line names both consequences up front —
          a much larger file, and papers left out — because both are discovered
          otherwise only after a save the user has already waited through. */}
      <ToggleRow
        title="Include all papers"
        sub="Bundle the PDFs into the file. Papers with no readable PDF are left out entirely"
        on={settings.include_pdfs}
        busy={pending === 'zotero.include_pdfs'}
        onToggle={(next) => void onPatch({ include_pdfs: next })}
        testid="zotero-toggle-pdfs"
      />

      <div className="outlet-actions">
        <div className="outlet-action-row">
          <button
            type="button"
            className="btn btn-primary outlet-btn"
            data-testid="zotero-export-rdf"
            disabled={
              busy !== null ||
              noPapers ||
              nothingToSend ||
              (!settings.summary_notes && !settings.project_notes)
            }
            data-tip={
              noPapers
                ? 'This project has no papers yet, so there are no notes to hand back.'
                : nothingToSend
                  ? 'No paper in this project has a readable PDF, so a bundle would be empty. Turn off “Include all papers” to send the bibliography on its own.'
                  : !settings.summary_notes && !settings.project_notes
                    ? 'Turn on at least one kind of note first.'
                    : settings.include_pdfs
                      ? 'Writes a zip holding the papers and a file you import with File → Import in Zotero. Your library is never written to directly.'
                      : 'Writes a file you import with File → Import in Zotero. Your library is never written to directly.'
            }
            onClick={() => void runExport()}
          >
            {busy === 'export' ? 'Building…' : 'Export to Zotero'}
          </button>
          {/* The OTHER direction, and the only one that reaches a live library.
              Offered even when Zotero is closed: the dialog waits for it to
              appear, which is a better answer than a button that refuses to
              open and leaves the user to work out why. */}
          {!connected && (
            <button
              type="button"
              className="btn btn-secondary outlet-btn"
              data-testid="zotero-connect"
              onClick={() => setConnecting(true)}
            >
              Connect with Zotero
            </button>
          )}
        </div>
        <div className="int-export-status" role="status" aria-live="polite">
          {message && (
            <div className="mono export-msg" data-testid="zotero-result">
              <span className={`badge badge-${message.ok ? 'ok' : 'danger'}`}>
                {message.ok ? 'done' : 'failed'}
              </span>{' '}
              {message.text}
              {/* Importing 30 papers and staying on this screen is a dead end:
                  the user is told what arrived and has nowhere to go and look
                  at it. */}
              {message.added !== undefined && message.added > 0 && (
                <button
                  type="button"
                  className="btn-link int-export-reveal"
                  data-testid="zotero-see-papers"
                  onClick={onGoToPapers}
                >
                  See them
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {connecting && (
        <ZoteroConnectModal
          projectId={projectId}
          onClose={() => setConnecting(false)}
          onConnected={() => {
            setConnecting(false)
            refreshConnection()
          }}
        />
      )}
    </OutletCard>
  )
}
