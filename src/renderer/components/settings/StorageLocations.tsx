import { useRef, useState } from 'react'
import type { BaseDirDTO } from '@shared/contract'
import { useAsync } from '../../lib/useAsync'
import { Select } from '../ui'

/**
 * The storage-locations section of Settings.
 *
 * A location is a ROOT that document files are addressed under
 * (`base_dir.abs_path` + `file_location.relative_path`). The indirection is the
 * point: when a share is remounted elsewhere, repointing ONE location makes
 * every document under it findable again — which is why this is an editor and
 * not a read-only list.
 *
 * Two honesty rules this component exists to keep:
 *  - Reachability is a REAL probe with THREE outcomes. A location that did not
 *    answer in time is "not verified" and looks different from one that is
 *    definitively gone; reporting a slow network mount as missing would send
 *    the user hunting for a share that is fine.
 *  - A refusal always says what it would cost. Removing a location that 20
 *    documents resolve through is not silently disabled — the button is
 *    disabled AND carries the count, because a control that just fails to
 *    respond reads as a broken app.
 */

/** Every reachability state, as data — so the badge cannot invent a fourth. */
const REACH = {
  yes: {
    word: 'Reachable',
    glyph: '✓',
    cls: 'ok',
    tip: 'Checked just now: the folder exists and is readable from this machine.'
  },
  no: {
    word: 'Unreachable',
    glyph: '✕',
    cls: 'danger',
    tip: 'Checked just now: the folder does not exist, or is not readable from this machine.'
  },
  unknown: {
    word: 'Not verified',
    glyph: '?',
    cls: 'warn',
    tip: 'Checking this folder took too long — often a network drive that is asleep. It may still be fine.'
  }
} as const

function reachOf(r: boolean | null): (typeof REACH)[keyof typeof REACH] {
  return r === true ? REACH.yes : r === false ? REACH.no : REACH.unknown
}

/** The `base_dir.kind` values, with the words a user reads. */
const KINDS = [
  { value: 'local', label: 'On this computer' },
  { value: 'nas', label: 'Network share' },
  { value: 'cloud', label: 'Cloud folder' },
  { value: 'removable', label: 'Removable drive' }
] as const
type Kind = (typeof KINDS)[number]['value']

function kindLabel(kind: string): string {
  return KINDS.find((k) => k.value === kind)?.label ?? kind
}

export function StorageLocations(): JSX.Element {
  const dirs = useAsync<BaseDirDTO[]>(() => window.api.listBaseDirs(), [])
  // The list after a mutation. Every mutator RETURNS the new list, so this is
  // what main just told us is true — not a guess applied optimistically and not
  // a re-read that could race another change.
  const [rows, setRows] = useState<BaseDirDTO[] | null>(null)
  const [busyId, setBusyId] = useState<number | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [adding, setAdding] = useState<{ label: string; abs_path: string; kind: Kind } | null>(null)

  const list = rows ?? dirs.data ?? []

  /** Run a mutation, adopting the list it returns and surfacing any refusal. */
  const mutate = async (
    id: number | 'new',
    op: () => Promise<BaseDirDTO[]>
  ): Promise<boolean> => {
    setBusyId(id)
    setError(null)
    try {
      setRows(await op())
      return true
    } catch (e) {
      // Main's refusals are written for a person to read (a blank name, a
      // duplicate folder, a location documents still need), so they are shown
      // verbatim rather than replaced with a generic failure.
      setError(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setBusyId(null)
    }
  }

  const startAdd = async (): Promise<void> => {
    const picked = await window.api.pickDirectory()
    // A dismissed chooser is not an error and not an empty path — nothing opens.
    if (picked === null) return
    const leaf = picked.split(/[/\\]/).filter(Boolean).pop() ?? 'Papers'
    setAdding({ label: leaf, abs_path: picked, kind: 'local' })
    setError(null)
  }

  return (
    <div className="settings-section" data-testid="settings-storage-locations">
      <div className="settings-eyebrow mono">Storage locations</div>
      <div className="stor-intro">
        Where document files live. The database stays on this computer.
      </div>

      {dirs.loading && rows === null ? (
        <div className="settings-storage-hint mono">Reading storage locations…</div>
      ) : dirs.error && rows === null ? (
        <div className="stor-error" role="alert">
          Could not read the storage locations — {dirs.error}
        </div>
      ) : (
        <div className="stor-list">
          {list.map((d) =>
            editingId === d.id ? (
              <LocationEditor
                key={d.id}
                initial={d}
                busy={busyId === d.id}
                onCancel={() => setEditingId(null)}
                onSave={async (patch) => {
                  const ok = await mutate(d.id, () => window.api.updateBaseDir(d.id, patch))
                  if (ok) setEditingId(null)
                }}
              />
            ) : (
              <LocationRow
                key={d.id}
                dir={d}
                busy={busyId === d.id}
                onEdit={() => {
                  setEditingId(d.id)
                  setError(null)
                }}
                onReveal={async () => {
                  const shown = await window.api.revealBaseDir(d.id)
                  if (!shown) setError(`${d.label} is not there — nothing to open.`)
                }}
                onRemove={() => void mutate(d.id, () => window.api.removeBaseDir(d.id))}
              />
            )
          )}

          {adding ? (
            <LocationEditor
              initial={adding}
              busy={busyId === 'new'}
              onCancel={() => setAdding(null)}
              onSave={async (patch) => {
                const ok = await mutate('new', () =>
                  window.api.addBaseDir({
                    label: patch.label ?? adding.label,
                    abs_path: patch.abs_path ?? adding.abs_path,
                    kind: (patch.kind ?? adding.kind) as Kind
                  })
                )
                if (ok) setAdding(null)
              }}
            />
          ) : (
            <button
              type="button"
              className="btn btn-secondary stor-add"
              data-testid="storage-add"
              onClick={() => void startAdd()}
            >
              Add a folder…
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="stor-error" role="alert" data-testid="storage-error">
          {error}
        </div>
      )}
    </div>
  )
}

/** One location at rest. */
function LocationRow({
  dir,
  busy,
  onEdit,
  onReveal,
  onRemove
}: {
  dir: BaseDirDTO
  busy: boolean
  onEdit: () => void
  onReveal: () => void
  onRemove: () => void
}): JSX.Element {
  const reach = reachOf(dir.reachable)
  // Why removal is refused, computed the same way main computes it. The reason
  // is shown as the button's tooltip, so a disabled control always explains
  // itself rather than merely failing to respond.
  const blocked = dir.managed
    ? 'Corpus Studio keeps its own downloads here, so this folder cannot be removed.'
    : dir.document_count > 0
      ? `${dir.document_count} document file${dir.document_count === 1 ? '' : 's'} resolve through this folder and would become unopenable.`
      : null

  return (
    <div
      className={`stor-row${busy ? ' is-busy' : ''}`}
      data-testid={`basedir-${dir.id}`}
      aria-busy={busy || undefined}
    >
      <div className="stor-row-main">
        <div className="stor-row-head">
          <span className="stor-name">{dir.label}</span>
          {dir.managed && (
            <span
              className="badge badge-accent stor-managed"
              data-tip="Corpus Studio created this folder and puts the files it downloads here."
            >
              managed
            </span>
          )}
          {/* Both badges state the EXCEPTION only. A folder on this computer
              that is reachable is the ordinary case, and a mark on every row
              is noise the reader learns to skip — which then costs them the
              one row that genuinely needed attention. */}
          {dir.kind !== 'local' && (
            <span className="badge badge-muted stor-kind">{kindLabel(dir.kind)}</span>
          )}
          {dir.reachable !== true && (
            <span
              className={`badge badge-${reach.cls} stor-reach`}
              data-testid={`basedir-reachable-${dir.id}`}
              role="img"
              aria-label={`${dir.label}: ${reach.word} — ${reach.tip}`}
              data-tip={reach.tip}
            >
              <span aria-hidden="true" className="stor-reach-glyph">
                {reach.glyph}
              </span>
              <span aria-hidden="true">{reach.word}</span>
            </span>
          )}
        </div>
        <div className="mono stor-path" data-tip={dir.abs_path}>
          {dir.abs_path}
        </div>
        <div className="stor-count mono">
          {dir.document_count === 0
            ? 'no document files yet'
            : `${dir.document_count} document file${dir.document_count === 1 ? '' : 's'}`}
        </div>
        {/* An unreachable folder is the one case where the user must DO
            something, so it says what and points at the control that does it.
            Repointing is the common fix: the files did not move, the mount did,
            and every document under this root follows the row automatically. */}
        {dir.reachable === false && (
          <div className="stor-fix" data-testid={`basedir-fix-${dir.id}`}>
            {dir.document_count > 0
              ? `These ${dir.document_count} file${dir.document_count === 1 ? '' : 's'} will not open until the folder is back. `
              : 'This folder is not there right now. '}
            If it moved, use <strong>Edit</strong> to point at its new location — nothing needs
            re-importing.
          </div>
        )}
      </div>

      <div className="stor-actions">
        <button
          type="button"
          className="btn btn-secondary stor-btn"
          data-testid={`basedir-reveal-${dir.id}`}
          // Already known to be gone: offering to open it would be a button
          // whose only possible outcome is an error message.
          disabled={busy || dir.reachable === false}
          data-tip={
            dir.reachable === false
              ? 'This folder is not there, so there is nothing to open.'
              : 'Open this folder in your file manager.'
          }
          onClick={onReveal}
        >
          Open
        </button>
        <button
          type="button"
          className="btn btn-secondary stor-btn"
          data-testid={`basedir-edit-${dir.id}`}
          disabled={busy}
          onClick={onEdit}
        >
          Edit
        </button>
        <button
          type="button"
          className="btn btn-secondary stor-btn stor-btn-remove"
          data-testid={`basedir-remove-${dir.id}`}
          disabled={busy || blocked !== null}
          data-tip={blocked ?? 'Remove this storage location.'}
          onClick={onRemove}
        >
          Remove
        </button>
      </div>
    </div>
  )
}

/**
 * Add/edit form for one location.
 *
 * The path is chosen with the native folder chooser rather than typed: a typed
 * path is a claim about a filesystem the renderer cannot see, and a typo would
 * surface much later as documents that mysteriously stop opening.
 */
function LocationEditor({
  initial,
  busy,
  onCancel,
  onSave
}: {
  initial: { label: string; abs_path: string; kind: string }
  busy: boolean
  onCancel: () => void
  onSave: (patch: { label?: string; abs_path?: string; kind?: Kind }) => void | Promise<void>
}): JSX.Element {
  const [label, setLabel] = useState(initial.label)
  const [path, setPath] = useState(initial.abs_path)
  const [kind, setKind] = useState<Kind>(initial.kind as Kind)
  const nameRef = useRef<HTMLInputElement | null>(null)

  const dirty = label !== initial.label || path !== initial.abs_path || kind !== initial.kind
  const valid = label.trim().length > 0 && path.trim().length > 0

  return (
    <div className="stor-row stor-row-edit" data-testid="storage-editor" aria-busy={busy || undefined}>
      <div className="stor-edit-grid">
        <label className="stor-field">
          <span className="stor-field-label">Name</span>
          <input
            ref={nameRef}
            className="stor-input"
            data-testid="storage-edit-label"
            value={label}
            autoFocus
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>

        <div className="stor-field">
          <span className="stor-field-label">Kind</span>
          <Select<Kind>
            className="stor-select"
            testid="storage-edit-kind"
            ariaLabel="Kind"
            value={kind}
            options={KINDS.map((k) => ({ value: k.value, label: k.label }))}
            onChange={setKind}
          />
        </div>

        <div className="stor-field stor-field-wide">
          <span className="stor-field-label">Folder</span>
          <div className="stor-path-row">
            <span className="mono stor-path stor-path-chosen" data-tip={path}>
              {path}
            </span>
            <button
              type="button"
              className="btn btn-secondary stor-btn"
              data-testid="storage-edit-pick"
              disabled={busy}
              onClick={() => {
                void window.api.pickDirectory().then((p) => {
                  if (p !== null) setPath(p)
                })
              }}
            >
              Choose…
            </button>
          </div>
        </div>
      </div>

      <div className="stor-edit-actions">
        <button
          type="button"
          className="btn btn-secondary stor-btn"
          data-testid="storage-edit-cancel"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary stor-btn"
          data-testid="storage-edit-save"
          disabled={busy || !valid || !dirty}
          data-tip={
            busy
              ? 'Saving…'
              : !valid
                ? 'A storage location needs a name and a folder.'
                : !dirty
                  ? 'Nothing has changed yet.'
                  : 'Save this storage location.'
          }
          onClick={() => void onSave({ label, abs_path: path, kind })}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}
