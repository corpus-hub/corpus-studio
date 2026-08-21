import { useEffect, useRef, useState } from 'react'
import type {
  SettingsImportResultDTO,
  SettingsTransferFileDTO,
  SettingsTransferItemDTO
} from '@shared/contract'
import { Modal } from '../ui'

/**
 * Taking this install's settings to another one, and receiving them.
 *
 * ONE component for both directions, because they are the same question asked
 * twice — "which of these things?" — over the same list, grouped by the same
 * tabs. Two components would be two chances for the export dialog to offer an
 * item the import dialog cannot show, and the user would have no way to tell
 * which of the two was lying.
 *
 * WHAT THE USER IS TOLD, and why it is stated rather than assumed: the file can
 * contain the gateway API key, and the encryption is done with a key that ships
 * inside the app. So the file is protected from being read BY ACCIDENT and from
 * nothing else. Anyone who has both the file and a copy of Corpus Studio can
 * read it. The sentence appears when a selected item is actually credential-
 * bearing — an unconditional warning on every export is a warning nobody reads,
 * and it would take this one down with it.
 */
type Direction = 'export' | 'import'

type Phase =
  | { phase: 'choosing' }
  | { phase: 'working' }
  | { phase: 'exported'; path: string | null; exportId: string | null; bytes: number }
  | { phase: 'canceled' }
  | { phase: 'imported'; result: SettingsImportResultDTO }
  | { phase: 'error'; message: string }

export function SettingsTransfer(): JSX.Element {
  const [open, setOpen] = useState<Direction | null>(null)
  return (
    <div className="settings-section">
      <div className="settings-eyebrow mono">Moving these settings</div>
      <div className="settings-sub">
        Take this install&rsquo;s configuration to another computer, or bring one in. You choose
        item by item in both directions.
      </div>
      <div className="set-actions">
        <button
          type="button"
          className="btn btn-secondary"
          data-testid="settings-export-open"
          onClick={() => setOpen('export')}
        >
          Export settings…
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          data-testid="settings-import-open"
          onClick={() => setOpen('import')}
        >
          Import settings…
        </button>
      </div>
      {open !== null && <TransferModal direction={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

function TransferModal({
  direction,
  onClose
}: {
  direction: Direction
  onClose: () => void
}): JSX.Element {
  const [items, setItems] = useState<SettingsTransferItemDTO[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [handle, setHandle] = useState<string | null>(null)
  const [exportedAt, setExportedAt] = useState<string | null>(null)
  const [unrecognised, setUnrecognised] = useState(0)
  const [state, setState] = useState<Phase>({ phase: 'choosing' })
  // The import flow opens a native dialog before it has anything to show, so it
  // must not fire twice if React mounts the effect twice (StrictMode does).
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    void (async () => {
      try {
        if (direction === 'export') {
          const list = await window.api.listExportableSettings()
          setItems(list)
          // EVERYTHING AVAILABLE, pre-selected. The user opened a dialog called
          // "export settings"; asking them to tick seven boxes to express that
          // makes the common case the laborious one. Deselecting is the
          // deliberate act here, which is the right way round.
          setPicked(new Set(list.filter((i) => i.present).map((i) => i.id)))
        } else {
          const file: SettingsTransferFileDTO | null = await window.api.readSettingsFile()
          if (file === null) {
            onClose()
            return
          }
          setItems(file.items)
          setHandle(file.handle)
          setExportedAt(file.exported_at)
          setUnrecognised(file.unrecognised)
          setPicked(new Set(file.items.map((i) => i.id)))
        }
      } catch (e) {
        setState({ phase: 'error', message: e instanceof Error ? e.message : String(e) })
      }
    })()
  }, [direction, onClose])

  const close = (): void => {
    // Drop the decrypted file in main. Without this its values — one of which
    // can be the API key — would sit in memory for the rest of the session.
    if (direction === 'import') void window.api.closeSettingsFile()
    onClose()
  }

  const toggle = (id: string): void => {
    setPicked((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const run = async (): Promise<void> => {
    setState({ phase: 'working' })
    const ids = [...picked]
    try {
      if (direction === 'export') {
        const res = await window.api.exportSettingsToFile(ids)
        if (res.canceled) {
          setState({ phase: 'canceled' })
          return
        }
        setState({
          phase: 'exported',
          path: res.path,
          exportId: res.export_id,
          bytes: res.bytes
        })
      } else {
        if (handle === null) return
        const result = await window.api.applySettings(handle, ids)
        setState({ phase: 'imported', result })
      }
    } catch (e) {
      setState({ phase: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }

  const title = direction === 'export' ? 'Export settings' : 'Import settings'
  const available = (items ?? []).filter((i) => i.present)
  const busy = state.phase === 'working'

  return (
    <Modal title={title} onClose={close} testid={`settings-transfer-${direction}`}>
      <div className="set-transfer">
        {state.phase === 'error' ? (
          <div className="set-transfer-outcome is-bad" role="alert">
            <div className="set-transfer-outcome-title">{state.message}</div>
          </div>
        ) : state.phase === 'exported' ? (
          <Outcome
            title="Settings exported."
            body={
              <>
                <div className="set-transfer-note">
                  {state.bytes} bytes{state.path ? ` · ${state.path}` : ''}
                </div>
              </>
            }
            onClose={close}
            reveal={state.exportId}
          />
        ) : state.phase === 'canceled' ? (
          <Outcome title="Nothing was saved." body={null} onClose={close} reveal={null} />
        ) : state.phase === 'imported' ? (
          <ImportOutcome result={state.result} onClose={close} />
        ) : items === null ? (
          <div className="set-transfer-loading mono">
            {direction === 'export' ? 'Reading this install…' : 'Opening the file…'}
          </div>
        ) : available.length === 0 ? (
          <>
            <div className="set-transfer-loading mono">
              {direction === 'export'
                ? 'Nothing here has been configured yet, so there is nothing to export.'
                : 'This file holds nothing this version can apply.'}
            </div>
            <div className="set-transfer-foot">
              <button type="button" className="btn btn-secondary" onClick={close}>
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="settings-sub">
              {direction === 'export'
                ? 'Untick anything you would rather not take.'
                : 'Only what you tick is applied.'}
              {exportedAt !== null && (
                <span className="set-transfer-when"> Exported {exportedAt.slice(0, 10)}.</span>
              )}
            </div>

            {/* The EXCEPTION only: a file from a newer version carrying items
                this build has no idea what to do with. Silence when it is 0. */}
            {unrecognised > 0 && (
              <div className="set-transfer-warn">
                {unrecognised === 1 ? 'One setting in' : `${unrecognised} settings in`} this file
                {unrecognised === 1 ? ' is' : ' are'} from a newer version of Corpus Studio and
                cannot be applied here.
              </div>
            )}

            <TabbedList items={available} picked={picked} onToggle={toggle} disabled={busy} />

            <div className="set-transfer-foot">
              <button type="button" className="btn btn-secondary" onClick={close} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className={`btn btn-primary${busy ? ' is-busy' : ''}`}
                data-testid={`settings-transfer-${direction}-run`}
                onClick={() => void run()}
                disabled={busy || picked.size === 0}
                data-tip={
                  picked.size === 0
                    ? 'Tick at least one setting first.'
                    : busy
                      ? 'Working…'
                      : undefined
                }
              >
                {busy
                  ? direction === 'export'
                    ? 'Exporting…'
                    : 'Applying…'
                  : direction === 'export'
                    ? `Export ${picked.size}`
                    : `Apply ${picked.size}`}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}

/** The list, grouped by the Settings tab each item is configured on. */
function TabbedList({
  items,
  picked,
  onToggle,
  disabled
}: {
  items: SettingsTransferItemDTO[]
  picked: Set<string>
  onToggle: (id: string) => void
  disabled: boolean
}): JSX.Element {
  const groups: Array<{ label: string; items: SettingsTransferItemDTO[] }> = []
  for (const item of items) {
    const g = groups.find((x) => x.label === item.tab_label)
    if (g) g.items.push(item)
    else groups.push({ label: item.tab_label, items: [item] })
  }
  return (
    <div className="set-transfer-groups">
      {groups.map((g) => (
        <div className="set-transfer-group" key={g.label}>
          <div className="set-transfer-group-head">{g.label}</div>
          {g.items.map((item) => {
            const on = picked.has(item.id)
            return (
              <label
                key={item.id}
                className={`set-transfer-item${on ? ' is-on' : ''}${disabled ? ' is-disabled' : ''}`}
                data-testid={`settings-transfer-item-${item.id}`}
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={disabled}
                  onChange={() => onToggle(item.id)}
                />
                <span className="set-transfer-item-text">
                  <span className="set-transfer-item-label">{item.label}</span>
                  <span className="set-transfer-item-desc">{item.description}</span>
                  {/* Only where the item is more than its label implies. */}
                  {item.note !== null && (
                    <span className="set-transfer-item-note">{item.note}</span>
                  )}
                </span>
              </label>
            )
          })}
        </div>
      ))}
    </div>
  )
}

function Outcome({
  title,
  body,
  onClose,
  reveal
}: {
  title: string
  body: JSX.Element | null
  onClose: () => void
  reveal: string | null
}): JSX.Element {
  const [revealFailed, setRevealFailed] = useState(false)
  return (
    <div className="set-transfer-outcome">
      <div className="set-transfer-outcome-title">{title}</div>
      {body}
      {revealFailed && (
        <div className="set-transfer-note">That file is no longer where it was saved.</div>
      )}
      <div className="set-transfer-foot">
        {reveal !== null && (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              void window.api.revealExport(reveal).then((ok) => setRevealFailed(!ok))
            }}
          >
            Show in folder
          </button>
        )}
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  )
}

/**
 * What the import actually did — both lists, never a count.
 *
 * `skipped` is rendered whenever it is non-empty even though it is the
 * unhappy half, because it is the half the user has to act on: a storage
 * folder that is not on this machine is a thing they can go and create.
 */
function ImportOutcome({
  result,
  onClose
}: {
  result: SettingsImportResultDTO
  onClose: () => void
}): JSX.Element {
  const nothing = result.applied.length === 0
  return (
    <div className={`set-transfer-outcome${nothing ? ' is-bad' : ''}`} data-testid="settings-import-result">
      <div className="set-transfer-outcome-title">
        {nothing
          ? 'Nothing was changed.'
          : result.applied.length === 1
            ? 'One setting applied.'
            : `${result.applied.length} settings applied.`}
      </div>
      {result.applied.length > 0 && (
        <ul className="set-transfer-list">
          {result.applied.map((label) => (
            <li key={label}>{label}</li>
          ))}
        </ul>
      )}
      {result.skipped.length > 0 && (
        <>
          <div className="set-transfer-outcome-sub">Not applied</div>
          <ul className="set-transfer-list is-skipped">
            {result.skipped.map((s) => (
              <li key={s.label}>
                {s.label} — {s.reason}
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="set-transfer-foot">
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  )
}
