// Screen-local stylesheet. Imported from the component (rather than added to
// the shared styles.css @import list) because this screen was added alongside
// concurrent work on styles.css; SchemasScreen is statically imported by
// App.tsx, so Vite folds this into the SAME bundled stylesheet — no extra
// request, no CDN, CSP-safe.
import '../styles/schemas.css'
import { useEffect, useRef, useState } from 'react'
import type {
  ExtractionSchemaDTO,
  ExtractionFieldDTO,
  ExtractionFieldType,
  SchemaBundleDTO,
  SchemaPresetDTO,
  SchemaInput,
  FieldInput
} from '@shared/contract'
import { useAsync } from '../lib/useAsync'
import { DataView, EmptyState } from '../components/States'
import { ScreenHeader, Badge, Select, Modal } from '../components/ui'

/**
 * SCHEMAS — the definition surface for WHAT the AI extracts.
 *
 * A schema is a real DB entity (`extraction_schema` + `extraction_field`) that
 * the user creates, edits and deletes here; the Extraction screen derives its
 * columns from these definitions, the LLM prompt is built from them, and the
 * spreadsheet exports are generated from them. This is what makes the app
 * agnostic to any particular field of science: the shape of a measurement is
 * data the user owns, not a decision baked into the code.
 *
 * SEED-ONLY-DB: every schema, field, label, unit and enum option rendered below
 * comes from SQLite via `window.api.listSchemas()`. The ONLY literal
 * lists in this file are the four *data types*, which are a TYPE-LEVEL union
 * from the frozen contract (`ExtractionFieldType`) — machinery, not domain data.
 *
 * Mutations update state from the RETURN VALUE of the IPC call (no
 * read-after-write race), matching the settings/model convention.
 */

// The four storage kinds a field can take. This mirrors the contract's
// `ExtractionFieldType` union exactly (a compile error here if they diverge) —
// it is app machinery, NOT seedable domain data.
const FIELD_TYPES: { key: ExtractionFieldType; label: string }[] = [
  { key: 'number', label: 'number' },
  { key: 'text', label: 'text' },
  { key: 'enum', label: 'enum' },
  { key: 'boolean', label: 'boolean' }
]

// ---------------------------------------------------------------- field editor

interface FieldDraft {
  key: string
  label: string
  data_type: ExtractionFieldType
  unit: string
  required: boolean
  enum_options: string
  description: string
}

const EMPTY_FIELD: FieldDraft = {
  key: '',
  label: '',
  data_type: 'number',
  unit: '',
  required: false,
  enum_options: '',
  description: ''
}

function draftFromField(f: ExtractionFieldDTO): FieldDraft {
  return {
    key: f.key,
    label: f.label,
    data_type: f.data_type,
    unit: f.unit ?? '',
    required: f.required,
    enum_options: (f.enum_options ?? []).join(', '),
    description: f.description ?? ''
  }
}

/**
 * The key is NOT a user-facing concept — main slugifies it from the label. But
 * an EXISTING field's key is carried through unchanged: it is what the stored
 * model responses map their `field_key` onto, so re-deriving it from an edited
 * label would silently unlink already-extracted values.
 */
function draftToInput(d: FieldDraft): FieldInput {
  return {
    key: d.key.trim() ? d.key.trim() : undefined,
    label: d.label.trim(),
    data_type: d.data_type,
    unit: d.unit.trim() ? d.unit.trim() : null,
    required: d.required,
    enum_options:
      d.data_type === 'enum'
        ? d.enum_options
            .split(',')
            .map((o) => o.trim())
            .filter((o) => o.length > 0)
        : null,
    description: d.description.trim() ? d.description.trim() : null
  }
}

function FieldForm({
  draft,
  setDraft,
  onSubmit,
  onCancel,
  submitLabel,
  busy
}: {
  draft: FieldDraft
  setDraft: (d: FieldDraft) => void
  onSubmit: () => void
  onCancel?: () => void
  submitLabel: string
  busy: boolean
}): JSX.Element {
  const valid = draft.label.trim().length > 0
  return (
    <div className="sch-field-form" data-testid="field-form">
      <div className="sch-form-grid">
        <label className="sch-label">
          <span className="mono">Label</span>
          <input
            className="input"
            data-testid="field-label-input"
            value={draft.label}
            placeholder="Field label"
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          />
        </label>
        <label className="sch-label">
          <span className="mono">Type</span>
          <Select<ExtractionFieldType>
            testid="field-type-select"
            ariaLabel="Field data type"
            value={draft.data_type}
            options={FIELD_TYPES.map((t) => ({ value: t.key, label: t.label }))}
            onChange={(v) => setDraft({ ...draft, data_type: v })}
          />
        </label>
        <label className="sch-label">
          <span className="mono">Unit</span>
          <input
            className="input mono"
            data-testid="field-unit-input"
            value={draft.unit}
            placeholder="unit"
            onChange={(e) => setDraft({ ...draft, unit: e.target.value })}
          />
        </label>
      </div>

      {draft.data_type === 'enum' && (
        <label className="sch-label sch-label-wide">
          <span className="mono">Options (comma separated)</span>
          <input
            className="input mono"
            data-testid="field-enum-input"
            value={draft.enum_options}
            placeholder="option A, option B"
            onChange={(e) => setDraft({ ...draft, enum_options: e.target.value })}
          />
        </label>
      )}

      <label className="sch-label sch-label-wide">
        <span className="mono">Extraction hint</span>
        <input
          className="input"
          data-testid="field-desc-input"
          value={draft.description}
          placeholder="What the model should look for, and how to report it."
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        />
      </label>

      <div className="sch-form-actions">
        <label className="sch-check">
          <input
            type="checkbox"
            data-testid="field-required-input"
            checked={draft.required}
            onChange={(e) => setDraft({ ...draft, required: e.target.checked })}
          />
          <span className="mono">required</span>
        </label>
        <div className="sch-form-buttons">
          {onCancel && (
            <button className="btn btn-secondary" data-testid="field-cancel" onClick={onCancel}>
              Cancel
            </button>
          )}
          <button
            className="btn btn-primary"
            data-testid="field-save"
            disabled={!valid || busy}
            onClick={onSubmit}
          >
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------- share / import

/**
 * A schema, as text a colleague can be sent.
 *
 * PRETTY-PRINTED rather than minified. The clipboard is the transport, but a
 * person is the intermediary: this text gets pasted into chat, mail and issue
 * trackers, where a reader must be able to see what they are about to run
 * before they run it. A wall of minified JSON asks them to trust it blind.
 */
function bundleToText(bundle: SchemaBundleDTO): string {
  return JSON.stringify(bundle, null, 2)
}

/**
 * The share panel: the text, on the clipboard AND on screen.
 *
 * SHOWN, not merely copied. A copy that only reports success gives the user
 * nothing to fall back on when the clipboard is claimed by something else, and
 * nothing to check when a colleague says the paste did not work. The textarea
 * is read-only and pre-selected, so the manual path is one Ctrl+C away.
 */
function SharePanel({
  schema,
  onClose
}: {
  schema: ExtractionSchemaDTO
  onClose: () => void
}): JSX.Element {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Null while we have not tried yet, so the line can say "copied" or "could
  // not copy" and never guess. A denied clipboard is a normal outcome, not a
  // failure of the share.
  const [copied, setCopied] = useState<boolean | null>(null)
  const boxRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    let dead = false
    window.api
      .exportSchema(schema.id)
      .then((b) => {
        if (dead) return
        const t = bundleToText(b)
        setText(t)
        return navigator.clipboard
          .writeText(t)
          .then(() => !dead && setCopied(true))
          .catch(() => !dead && setCopied(false))
      })
      .catch((e: unknown) => {
        if (!dead) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      dead = true
    }
  }, [schema.id])

  // Selected on arrival: the user's next action here is almost always to copy
  // it again by hand, and pre-selecting removes the drag across a scroll box.
  useEffect(() => {
    if (text) boxRef.current?.select()
  }, [text])

  return (
    <div className="card sch-transfer" data-testid="schema-share-panel">
      <div className="sch-transfer-head">
        <span className="eyebrow">Share “{schema.name}”</span>
        <button className="btn-link" data-testid="schema-share-close" onClick={onClose}>
          close
        </button>
      </div>

      {error ? (
        <div className="sch-transfer-note sch-transfer-bad mono" role="alert">
          {error}
        </div>
      ) : text === null ? (
        <div className="sch-transfer-note mono">Reading the schema…</div>
      ) : (
        <>
          <div
            className={`sch-transfer-note ${copied === false ? 'sch-transfer-warn' : ''}`}
            data-testid="schema-share-status"
          >
            {copied === null
              ? 'Copying…'
              : copied
                ? 'Copied. Send it to a colleague — they paste it into Import.'
                : 'Could not reach the clipboard. Select the text below and copy it, then send it to a colleague to paste into Import.'}
          </div>
          <textarea
            ref={boxRef}
            className="input mono sch-transfer-box"
            data-testid="schema-share-text"
            readOnly
            spellCheck={false}
            value={text}
            onFocus={(e) => e.currentTarget.select()}
          />
        </>
      )}
    </div>
  )
}

/**
 * The import modal.
 *
 * IT TRIES THE CLIPBOARD SILENTLY. On open it reads the clipboard and, if what
 * it finds is a schema, imports it and closes — the overwhelmingly common case
 * is a share that arrived seconds ago, and asking a user to paste something the
 * machine can already see is a step for its own sake.
 *
 * WHEN THAT ATTEMPT FAILS, NOTHING IS SAID. A denied clipboard, an empty one,
 * or one holding a shopping list are all ordinary — the user did not ask for
 * their clipboard to be imported, so its contents not being a schema is not
 * their mistake and must not be reported as one. The attempt is an optimisation;
 * a failed optimisation that announces itself is worse than one that stays
 * quiet. The paste box simply appears, which is what the user came here for.
 *
 * An error IS shown for an explicit press of Import, because there the user did
 * assert that the text is a schema and is owed the reason it was refused.
 *
 * PARSING IS LOCAL. What crosses IPC is a parsed object, validated by zod in
 * main, so nothing pasted reaches the database unchecked.
 */
function ImportModal({
  onImported,
  onClose
}: {
  onImported: (s: ExtractionSchemaDTO) => void
  onClose: () => void
}): JSX.Element {
  const [text, setText] = useState('')
  // Null until the silent attempt has resolved: the modal shows nothing but a
  // waiting line in that window, so a successful auto-import never flashes a
  // paste box the user did not need to see.
  const [tried, setTried] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const boxRef = useRef<HTMLTextAreaElement>(null)

  /**
   * `announce` is the whole difference between the two entry points. The silent
   * clipboard attempt passes false and simply gives up; the button passes true
   * and reports why.
   */
  const attempt = (raw: string, announce: boolean): void => {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      setTried(true)
      if (announce) {
        setError(
          'That is not a schema. Paste the whole text a colleague sent you, including the outer braces.'
        )
      }
      return
    }
    setBusy(true)
    setError(null)
    window.api
      .importSchema(parsed as SchemaBundleDTO)
      .then((s) => onImported(s))
      .catch((e: unknown) => {
        setTried(true)
        if (announce) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => setBusy(false))
  }

  useEffect(() => {
    let dead = false
    navigator.clipboard
      .readText()
      .then((t) => {
        if (dead) return
        if (t.trim().length === 0) {
          setTried(true)
          return
        }
        attempt(t, false)
      })
      .catch(() => {
        if (!dead) setTried(true)
      })
    return () => {
      dead = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (tried) boxRef.current?.focus()
  }, [tried])

  return (
    <Modal title="Import a schema" onClose={onClose} testid="schema-import-modal">
      <div className="sch-transfer">
        {!tried ? (
          <div className="sch-transfer-note mono" data-testid="schema-import-status">
            Checking the clipboard…
          </div>
        ) : (
          <>
            <div
              className={`sch-transfer-note ${error ? 'sch-transfer-bad' : ''}`}
              role={error ? 'alert' : undefined}
              data-testid="schema-import-status"
            >
              {error ?? 'Paste the text a colleague sent you. They get it from the Share button.'}
            </div>
            <textarea
              ref={boxRef}
              className="input mono sch-transfer-box"
              data-testid="schema-import-text"
              spellCheck={false}
              placeholder="Paste the shared schema here"
              value={text}
              onChange={(e) => {
                setText(e.target.value)
                // The old refusal describes text that is no longer in the box.
                setError(null)
              }}
            />
            <div className="sch-form-actions sch-transfer-actions">
              <button
                className="btn btn-primary"
                data-testid="schema-import-submit"
                disabled={busy || text.trim().length === 0}
                data-tip={text.trim().length === 0 ? 'Paste a shared schema first' : undefined}
                onClick={() => attempt(text, true)}
              >
                {busy ? 'Importing…' : 'Import schema'}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}

/**
 * Move the item at `from` into the GAP at `to`, where gaps are numbered 0..n —
 * gap `i` being "before the item currently at i" and gap `n` "at the end".
 *
 * Gaps, not indices, because a drop target is a position BETWEEN rows: with
 * plain indices the last slot is unreachable (there is no row after it to aim
 * at) and dragging down by one is a no-op, since removing the item first shifts
 * every later index back by one. Removing before adjusting is exactly why `to`
 * is decremented when the item came from above it.
 */
function moveField<T>(list: T[], from: number, to: number): T[] {
  const next = [...list]
  const [item] = next.splice(from, 1)
  if (item === undefined) return list
  next.splice(to > from ? to - 1 : to, 0, item)
  return next
}

// ---------------------------------------------------------------- detail pane

function SchemaDetail({
  schema,
  onChanged,
  onDeleted,
  onShare,
  onImport,
  setError
}: {
  schema: ExtractionSchemaDTO
  onChanged: (s: ExtractionSchemaDTO) => void
  onDeleted: (list: ExtractionSchemaDTO[]) => void
  onShare: () => void
  onImport: () => void
  setError: (m: string | null) => void
}): JSX.Element {
  const [meta, setMeta] = useState<SchemaInput>({
    name: schema.name,
    description: schema.description
  })
  const [addOpen, setAddOpen] = useState(false)
  const [addDraft, setAddDraft] = useState<FieldDraft>(EMPTY_FIELD)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState<FieldDraft>(EMPTY_FIELD)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  /**
   * The order shown RIGHT NOW, which leads the database.
   *
   * A reorder must land under the pointer that made it, so the new order is
   * applied here first and the IPC call follows. `null` means "no local opinion"
   * — the schema's own order is authoritative, which is the state after every
   * reconcile and after any other edit reloads the schema.
   */
  const [pending, setPending] = useState<ExtractionFieldDTO[] | null>(null)
  const [reordering, setReordering] = useState(false)
  const [dragId, setDragId] = useState<number | null>(null)
  /** The GAP the dragged row would land in: 0..fields.length. */
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  /** The row that just moved, briefly, so a keyboard move is visible at all. */
  const [movedId, setMovedId] = useState<number | null>(null)

  const fields = pending ?? schema.fields

  // Re-sync the editable header whenever a different schema is selected.
  useEffect(() => {
    setMeta({ name: schema.name, description: schema.description })
    setAddOpen(false)
    setAddDraft(EMPTY_FIELD)
    setEditingId(null)
    setConfirmDelete(false)
    setPending(null)
    setDragId(null)
    setDropIndex(null)
  }, [schema.id, schema.name, schema.description])

  // A keyboard move is instantaneous and leaves the pointer nowhere near the
  // row, so without a mark the only evidence it worked is that two lines swapped
  // somewhere on screen. The mark is cleared on a timer rather than on blur:
  // holding ↓ moves the row repeatedly and the emphasis should follow it.
  useEffect(() => {
    if (movedId === null) return
    const t = window.setTimeout(() => setMovedId(null), 700)
    return () => window.clearTimeout(t)
  }, [movedId])

  // Every mutation funnels through here: run the IPC call, adopt the RETURNED
  // schema (no read-after-write race), and surface any rejection as a message.
  const mutate = (fn: () => Promise<ExtractionSchemaDTO>, after?: () => void): void => {
    setBusy(true)
    setError(null)
    fn()
      .then((s) => {
        onChanged(s)
        after?.()
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }

  /**
   * Apply an order optimistically, then reconcile with what main returns.
   *
   * The RETURNED schema is adopted (via `onChanged`) and the local override
   * dropped, so if the write is refused — or lands differently from what was
   * predicted — the list snaps back to the truth rather than showing an order
   * the database does not hold.
   */
  const commitOrder = (next: ExtractionFieldDTO[], movedFieldId: number): void => {
    setPending(next)
    setMovedId(movedFieldId)
    setReordering(true)
    setError(null)
    window.api
      .reorderSchemaFields(
        schema.id,
        next.map((f) => f.id)
      )
      .then((s) => onChanged(s))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        setPending(null)
        setReordering(false)
      })
  }

  const saveMeta = (): void =>
    mutate(() =>
      window.api.updateSchema(schema.id, {
        name: meta.name,
        description: meta.description ?? null
      })
    )

  // Deleting is GLOBAL and affects every project that attached this schema, so
  // it is a two-step action whose warning quotes the REAL counts from the DTO
  // (attached projects, extracted measurements) — never a generic "are you sure".
  const removeSchema = (): void => {
    setBusy(true)
    setError(null)
    window.api
      .deleteSchema(schema.id)
      .then((list) => onDeleted(list))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }

  return (
    <div className="card sch-detail" data-testid={`schema-detail-${schema.id}`}>
      <div className="sch-detail-head">
        <div className="sch-detail-titles">
          <span className="eyebrow">Schema definition</span>
          <div className="sch-detail-name" data-testid="schema-detail-name">
            {schema.name}
          </div>
          <div className="sch-detail-sub mono">
            {schema.fields.length} fields · {schema.measurement_count} records
          </div>
        </div>
        <div className="sch-detail-actions">
          {schema.is_builtin && <Badge cls="ok">built-in</Badge>}
          {schema.export_alias && (
            <Badge cls="muted" title="Exports of this schema are labelled with this name.">
              export: {schema.export_alias}
            </Badge>
          )}
          {/* Share and Import sit together because they are two ends of one
              act: the sender presses one, the receiver presses the other, and
              the text between them is the same text. Splitting them across the
              screen would leave a recipient hunting for the half they need. */}
          <button
            className="btn btn-secondary"
            data-testid={`schema-share-${schema.id}`}
            data-tip="Copy this schema as text you can send to a colleague"
            onClick={onShare}
          >
            Share
          </button>
          <button
            className="btn btn-secondary"
            data-testid="schema-import"
            data-tip="Add a schema a colleague shared with you"
            onClick={onImport}
          >
            Import
          </button>
          <button
            className="btn btn-secondary"
            data-testid={`schema-delete-${schema.id}`}
            disabled={schema.is_builtin || busy}
            // No aria-expanded: this is not a disclosure widget. Clicking it
            // raises an alert asking for confirmation, which announces itself.
            data-tip={
              schema.is_builtin
                ? 'Schemas that come with Corpus Studio cannot be deleted. Copy one and edit the copy instead.'
                : 'Delete this schema for every project'
            }
            onClick={() => setConfirmDelete((v) => !v)}
          >
            {confirmDelete ? 'Cancel delete' : 'Delete schema'}
          </button>
        </div>
      </div>

      {confirmDelete && !schema.is_builtin && (
        <div className="sch-confirm" role="alert" data-testid={`schema-delete-confirm-${schema.id}`}>
          <span className="sch-confirm-text">
            Delete “{schema.name}” for every project? It is attached to{' '}
            {schema.attached_project_count}{' '}
            {schema.attached_project_count === 1 ? 'project' : 'projects'} and{' '}
            {schema.measurement_count}{' '}
            {schema.measurement_count === 1 ? 'measurement has' : 'measurements have'} been
            extracted with it. The measurements are KEPT, but will no longer be linked to a field
            and will appear under “Unassigned” in Extraction.
          </span>
          <button
            className="btn btn-secondary sch-danger"
            data-testid={`schema-delete-confirm-btn-${schema.id}`}
            disabled={busy}
            onClick={removeSchema}
          >
            Delete permanently
          </button>
        </div>
      )}

      <div className="sch-form-grid">
        <label className="sch-label">
          <span className="mono">Name</span>
          <input
            className="input"
            data-testid="schema-name-input"
            value={meta.name}
            onChange={(e) => setMeta({ ...meta, name: e.target.value })}
          />
        </label>
      </div>
      <label className="sch-label sch-label-wide">
        <span className="mono">Description</span>
        <input
          className="input"
          data-testid="schema-desc-input"
          value={meta.description ?? ''}
          onChange={(e) => setMeta({ ...meta, description: e.target.value })}
        />
      </label>
      <div className="sch-form-actions">
        <span className="sch-hint mono">
          Fields below are handed to the model as the extraction target.
        </span>
        <button className="btn btn-primary" data-testid="schema-save" disabled={busy} onClick={saveMeta}>
          Save schema
        </button>
      </div>

      {/* ----------------------------------------------------------- fields */}
      <div className="sch-fields" data-testid="schema-fields">
        <div className="sch-fields-head">
          <span className="eyebrow">Fields</span>
          <button
            className="btn btn-secondary"
            data-testid="field-add"
            onClick={() => {
              setAddDraft(EMPTY_FIELD)
              setAddOpen((v) => !v)
            }}
          >
            {addOpen ? 'Close' : 'Add field'}
          </button>
        </div>

        {addOpen && (
          <FieldForm
            draft={addDraft}
            setDraft={setAddDraft}
            busy={busy}
            submitLabel="Add field"
            onCancel={() => setAddOpen(false)}
            onSubmit={() =>
              mutate(
                () => window.api.addSchemaField(schema.id, draftToInput(addDraft)),
                () => {
                  setAddDraft(EMPTY_FIELD)
                  setAddOpen(false)
                }
              )
            }
          />
        )}

        {schema.fields.length === 0 ? (
          <EmptyState
            title="No fields yet."
            hint="Add the values this schema should extract from a paper."
            testid="schema-fields-empty"
          />
        ) : (
          <div className="sch-field-table">
            <div className="sch-field-head mono">
              <span className="sch-field-head-order">Order</span>
              <span>Field</span>
              <span>Type</span>
              <span>Unit</span>
              <span>Req.</span>
              <span>Hint</span>
              <span />
            </div>
            {fields.map((f, i) =>
              editingId === f.id ? (
                <FieldForm
                  key={f.id}
                  draft={editDraft}
                  setDraft={setEditDraft}
                  busy={busy}
                  submitLabel="Save field"
                  onCancel={() => setEditingId(null)}
                  onSubmit={() =>
                    mutate(
                      () => window.api.updateSchemaField(f.id, draftToInput(editDraft)),
                      () => setEditingId(null)
                    )
                  }
                />
              ) : (
                <div
                  className="sch-field-row"
                  data-testid={`field-row-${f.id}`}
                  key={f.id}
                  draggable={!busy && !reordering}
                  data-dragging={dragId === f.id ? '' : undefined}
                  data-dropbefore={dropIndex === i && dragId !== f.id ? '' : undefined}
                  data-droplast={dropIndex === fields.length && i === fields.length - 1 ? '' : undefined}
                  data-justmoved={movedId === f.id ? '' : undefined}
                  onDragStart={(e) => {
                    setDragId(f.id)
                    e.dataTransfer.effectAllowed = 'move'
                    // Firefox refuses to start a drag with no payload set. The
                    // id is carried in state, not read back from here — the drop
                    // target is a row of THIS list either way.
                    e.dataTransfer.setData('text/plain', String(f.id))
                  }}
                  onDragEnd={() => {
                    setDragId(null)
                    setDropIndex(null)
                  }}
                  onDragOver={(e) => {
                    if (dragId === null) return
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                    // The gap the row would land in, decided by which HALF of
                    // this row the pointer is over. Snapping to the row's index
                    // alone makes the last slot unreachable by pointer.
                    const box = e.currentTarget.getBoundingClientRect()
                    setDropIndex(e.clientY - box.top > box.height / 2 ? i + 1 : i)
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    if (dragId === null || dropIndex === null) return
                    const from = fields.findIndex((x) => x.id === dragId)
                    commitOrder(moveField(fields, from, dropIndex), dragId)
                    setDragId(null)
                    setDropIndex(null)
                  }}
                >
                  <span className="sch-field-order">
                    <span
                      className="sch-drag-handle"
                      aria-hidden="true"
                      data-tip="Drag to reorder, or use the arrows"
                    >
                      ⠿
                    </span>
                    {/* THE KEYBOARD PATH. Two ordinary buttons rather than an
                        aria-grabbed/arrow-key grab-and-move: a grab mode is a
                        mode, and it has to be announced, entered, escaped and
                        explained before a screen-reader user can use it at all,
                        while a button that says "move up" needs none of that and
                        is reachable by Tab like everything else in this row.
                        Both ends are disabled with a reason rather than silently
                        inert — the row is already where the button would take it. */}
                    {/* `aria-disabled`, NOT `disabled`, per this app's
                        convention: Chromium dispatches no pointer events to a
                        disabled button, so its tooltip never opens — and a
                        control that refuses without saying why is exactly what
                        the rule forbids. The click is refused in the handler. */}
                    <button
                      type="button"
                      className="btn-icon sch-move"
                      data-testid={`field-move-up-${f.id}`}
                      aria-label={`Move ${f.label} earlier`}
                      aria-disabled={busy || reordering || i === 0}
                      data-tip={
                        i === 0
                          ? `“${f.label}” is already the first field.`
                          : busy || reordering
                            ? 'Saving the last change first…'
                            : `Move “${f.label}” before “${fields[i - 1]?.label}”`
                      }
                      onClick={() => {
                        if (busy || reordering || i === 0) return
                        commitOrder(moveField(fields, i, i - 1), f.id)
                      }}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn-icon sch-move"
                      data-testid={`field-move-down-${f.id}`}
                      aria-label={`Move ${f.label} later`}
                      aria-disabled={busy || reordering || i === fields.length - 1}
                      data-tip={
                        i === fields.length - 1
                          ? `“${f.label}” is already the last field.`
                          : busy || reordering
                            ? 'Saving the last change first…'
                            : `Move “${f.label}” after “${fields[i + 1]?.label}”`
                      }
                      onClick={() => {
                        if (busy || reordering || i === fields.length - 1) return
                        commitOrder(moveField(fields, i, i + 2), f.id)
                      }}
                    >
                      ↓
                    </button>
                  </span>
                  <span className="sch-field-label">{f.label}</span>
                  <span>
                    <Badge cls="muted">{f.data_type}</Badge>
                  </span>
                  <span className="mono sch-field-unit">{f.unit ?? '—'}</span>
                  <span className="mono sch-field-req">{f.required ? 'yes' : '—'}</span>
                  <span className="sch-field-desc" data-tip={f.description ?? ''}>
                    {f.enum_options ? f.enum_options.join(' | ') : (f.description ?? '—')}
                  </span>
                  <span className="sch-field-tools">
                    <button
                      className="btn-link"
                      data-testid={`field-edit-${f.id}`}
                      onClick={() => {
                        setEditDraft(draftFromField(f))
                        setEditingId(f.id)
                      }}
                    >
                      edit
                    </button>
                    <button
                      className="btn-link sch-danger"
                      data-testid={`field-delete-${f.id}`}
                      disabled={busy}
                      onClick={() => mutate(() => window.api.deleteSchemaField(f.id))}
                    >
                      delete
                    </button>
                  </span>
                </div>
              )
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- screen

export function SchemasScreen(): JSX.Element {
  // No projectId: schemas are GLOBAL, and this screen is reachable with no
  // project open at all (it lives in the projects-level sidebar).
  const state = useAsync<ExtractionSchemaDTO[]>(() => window.api.listSchemas(), [])
  // Local mirror of the loaded list so mutations render instantly from their
  // RETURN VALUE instead of forcing a reload round-trip.
  const [list, setList] = useState<ExtractionSchemaDTO[] | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [importing, setImporting] = useState(false)
  const [newName, setNewName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // The catalogue is DB-independent — nothing exists until one is picked — so
  // it loads once with the screen rather than on every open of the panel.
  const presets = useAsync<SchemaPresetDTO[]>(() => window.api.listSchemaPresets(), [])

  useEffect(() => {
    const loaded = state.data
    if (!loaded) return
    setList(loaded)
    // Keep the current selection if it still exists, else fall back to the first.
    setSelectedId((cur) =>
      cur != null && loaded.some((s) => s.id === cur) ? cur : (loaded[0]?.id ?? null)
    )
  }, [state.data])

  const schemas = list ?? state.data
  const selected = schemas?.find((s) => s.id === selectedId) ?? null

  const applyUpdated = (s: ExtractionSchemaDTO): void => {
    setList((cur) => (cur ?? []).map((x) => (x.id === s.id ? s : x)))
    setSelectedId(s.id)
  }

  const createSchema = (): void => {
    setBusy(true)
    setError(null)
    window.api
      .createSchema({ name: newName.trim() })
      .then((s) => {
        setList((cur) => [...(cur ?? []), s])
        setSelectedId(s.id)
        setCreating(false)
        setNewName('')
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }

  // A preset takes the SAME path a pasted schema takes. One import route means
  // the catalogue is exercised by every import, and a preset that would not
  // survive being shared cannot exist.
  const usePreset = (p: SchemaPresetDTO): void => {
    setBusy(true)
    setError(null)
    window.api
      .importSchema(p.bundle)
      .then((s) => {
        setList((cur) => [...(cur ?? []), s])
        setSelectedId(s.id)
        setCreating(false)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }

  return (
    <div className="screen" data-testid="screen-schemas">
      <ScreenHeader
        eyebrow="Schemas"
        actions={
          <button
            className="btn btn-primary"
            data-testid="schema-create"
            onClick={() => setCreating((v) => !v)}
          >
            {creating ? 'Cancel' : 'New schema'}
          </button>
        }
      />

      {/* Schemas are app-level. A user editing a field here must know it changes
          for every project that attached the schema — stated, not implied. */}
      <div className="card sch-global-note" data-testid="schema-global-note">
        <span className="sch-global-title">These schemas are global.</span>
        <span className="sch-global-text">
          One definition list, shared by every project. Editing or deleting a schema here changes
          it everywhere. Each project chooses which of these to apply from its Extraction screen.
        </span>
      </div>

      {error && (
        <div className="card sch-error" role="alert" data-testid="schema-error">
          <span className="mono">{error}</span>
        </div>
      )}

      {creating && (
        <div className="card sch-create" data-testid="schema-create-form">
          {/* Naming a blank one comes FIRST. A user who pressed "New schema"
              has a schema in mind; offering the catalogue before the name box
              answers a question they did not ask. The premade list below is the
              shortcut for when they would rather not start from nothing. */}
          <div className="sch-create-blank">
            <label className="sch-label sch-label-wide">
              <span className="mono">Name</span>
              <input
                className="input"
                data-testid="schema-new-name"
                value={newName}
                placeholder="Schema name"
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newName.trim().length > 0 && !busy) createSchema()
                }}
              />
            </label>
            <div className="sch-form-actions">
              <span className="sch-hint mono">
                A blank schema starts with no fields — add them once created.
              </span>
              <button
                className="btn btn-primary"
                data-testid="schema-create-submit"
                disabled={busy || newName.trim().length === 0}
                data-tip={newName.trim().length === 0 ? 'Name the schema first' : undefined}
                onClick={createSchema}
              >
                Create schema
              </button>
            </div>
          </div>

          {/* A premade schema is a STARTING POINT, not a commitment: what it
              creates is an ordinary schema the user can rename, extend and
              delete. Saying so is what makes picking one a low-stakes choice
              rather than a decision about their whole corpus. */}
          <div className="sch-presets-block">
            <span className="eyebrow">Or start from a premade schema</span>
            <div className="sch-hint mono sch-preset-hint">
              Each one arrives as your own schema — rename it, add fields, delete what you do not
              use.
            </div>

            {presets.loading ? (
              <div className="sch-hint mono">Loading…</div>
            ) : (
              <div className="sch-presets" data-testid="schema-presets">
                {(presets.data ?? []).map((p) => (
                  <button
                    key={p.id}
                    className="sch-preset"
                    data-testid={`schema-preset-${p.id}`}
                    disabled={busy}
                    onClick={() => usePreset(p)}
                  >
                    <span className="sch-preset-disc mono">{p.discipline}</span>
                    <span className="sch-preset-name">{p.bundle.name}</span>
                    <span className="sch-preset-desc">{p.bundle.description}</span>
                    <span className="sch-preset-count mono">{p.bundle.fields.length} fields</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {sharing && selected && (
        <SharePanel schema={selected} onClose={() => setSharing(false)} />
      )}

      {importing && (
        <ImportModal
          onClose={() => setImporting(false)}
          onImported={(s) => {
            setList((cur) => [...(cur ?? []), s])
            setSelectedId(s.id)
            setImporting(false)
          }}
        />
      )}

      <DataView
        state={state}
        isEmpty={() => (schemas ?? []).length === 0}
        empty={
          // Import is offered HERE as well as beside a selected schema. It
          // lives on the detail pane, which does not exist until something is
          // selected — so on a fresh install, the one state where a colleague's
          // schema is the fastest way to start, the button a user needs would
          // otherwise be behind the schema they do not have.
          <EmptyState
            title="No extraction schemas yet."
            hint="Start from a premade schema, or import one a colleague shared."
          >
            <div className="sch-empty-actions">
              <button
                className="btn btn-primary"
                data-testid="schema-empty-create"
                onClick={() => {
                  setImporting(false)
                  setCreating(true)
                }}
              >
                Browse premade schemas
              </button>
              <button
                className="btn btn-secondary"
                data-testid="schema-empty-import"
                onClick={() => {
                  setCreating(false)
                  setImporting(true)
                }}
              >
                Import
              </button>
            </div>
          </EmptyState>
        }
      >
        {() => (
          <div className="sch-layout">
            <div className="card sch-list" data-testid="schema-list">
              <span className="eyebrow">Schemas</span>
              {(schemas ?? []).map((s) => (
                <button
                  key={s.id}
                  className={`sch-item ${s.id === selectedId ? 'active' : ''}`}
                  data-testid={`schema-item-${s.id}`}
                  onClick={() => setSelectedId(s.id)}
                >
                  <span className="sch-item-name">{s.name}</span>
                  <span className="sch-item-sub mono">
                    {s.fields.length} fields
                  </span>
                </button>
              ))}
            </div>
            {selected ? (
              <SchemaDetail
                key={selected.id}
                schema={selected}
                onChanged={applyUpdated}
                onDeleted={(l) => {
                  setList(l)
                  setSelectedId(l[0]?.id ?? null)
                }}
                onShare={() => {
                  setImporting(false)
                  setSharing((v) => !v)
                }}
                onImport={() => {
                  setSharing(false)
                  setImporting((v) => !v)
                }}
                setError={setError}
              />
            ) : (
              <EmptyState title="Select a schema." hint="Pick one on the left to edit it." />
            )}
          </div>
        )}
      </DataView>
    </div>
  )
}
