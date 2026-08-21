import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  ExtractionRowDTO,
  ExtractionStatusSummaryDTO,
  ExtractionSchemaDTO,
  ExtractionFieldDTO,
  SchemaCoverageDTO
} from '@shared/contract'
import { useAsync } from '../lib/useAsync'
import { DataView, EmptyState } from '../components/States'
import { ScreenHeader, Badge, RunOriginBadge } from '../components/ui'
import { factKindMeta, comparabilityMeta } from '../lib/format'
import { groupReadings } from '../lib/readings'
import { RichText, plainText } from '../components/RichText'

/**
 * EXTRACTION — SCHEMA-DRIVEN.
 *
 * One section per extraction schema, each section's MATRIX COLUMNS coming from
 * that schema's `extraction_field` rows in SQLite — so two (or twenty) schemas
 * render side by side with no code change, whatever field of science they
 * describe.
 *
 * SEED-ONLY-DB: every schema name, column label, unit and value below is read
 * through `window.api` (listSchemas + getExtractionRows). Nothing domain
 * specific is written in this file.
 *
 * The per-record list under each matrix is retained (and paginated GLOBALLY
 * across all sections) so the provenance columns — fact kind,
 * derived status, fold + comparability, evidence link — and their testids stay
 * exactly as they were.
 */

const PAGE_SIZE = 40

function statusCls(s: ExtractionRowDTO['status']): string {
  return s === 'validated' ? 'ok' : s === 'conflict' ? 'danger' : s === 'invalid' ? 'muted' : 'warn'
}

/**
 * Status as a GLYPH, not a word.
 *
 * A matrix cell is a number; the word "validated" trailing every one of them was
 * wider than the value it qualified and turned the table into a wall of repeated
 * text. The shape carries the meaning, colour reinforces it (both, never one
 * alone), and the word itself moves into the tooltip and the accessible name —
 * so nothing is lost, it is just no longer shouted 16 times per screen.
 */
const STATUS_ICON: Record<string, { path: string; label: string; tip: string }> = {
  validated: {
    path: 'M3.5 8.5l3 3 6-6.5',
    label: 'validated',
    tip: 'Validated: nothing has been found wrong with this value.'
  },
  conflict: {
    path: 'M8 3.2v5.6M8 11.6v.2',
    label: 'conflict',
    tip: 'Conflict: this value disagrees with another reading of the same field.'
  },
  invalid: {
    path: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
    label: 'invalid',
    tip: "Unusable: the model's reply did not conform to the output schema, so this value was salvaged from a malformed answer. Open the paper to enter it yourself."
  },
  // An arrow, because this one GOES somewhere — the shape states the action,
  // not just the state. It must not reuse the conflict glyph: two statuses that
  // draw the same mark are indistinguishable to anyone who cannot see the hue.
  review: {
    path: 'M3 8h9M8.5 4.5L12 8l-3.5 3.5',
    label: 'review',
    tip: 'Needs interpretation. Opens this record in the Review queue.'
  }
}

function StatusIcon({ status }: { status: string }): JSX.Element {
  const icon = STATUS_ICON[status] ?? STATUS_ICON.review
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={icon.path} />
    </svg>
  )
}

/**
 * `review` is not a label but a destination: the record is sitting in the Review
 * queue waiting to be judged, so it is a button that opens the queue ON it.
 * Every other status has nowhere to go and stays inert — a control that only
 * sometimes acts is honest, one that always looks clickable is not.
 */
function StatusChip({
  row,
  onOpenReview,
  testid
}: {
  row: ExtractionRowDTO
  onOpenReview: (factId: number) => void
  testid?: string
}): JSX.Element {
  const meta = STATUS_ICON[row.status] ?? STATUS_ICON.review
  const cls = `ext-mark ext-mark-${statusCls(row.status)}`

  if (row.status !== 'review') {
    return (
      <span
        className={cls}
        data-testid={testid}
        data-tip={meta.tip}
        role="img"
        aria-label={meta.label}
      >
        <StatusIcon status={row.status} />
      </span>
    )
  }
  return (
    <button
      type="button"
      className={`${cls} ext-mark-link`}
      data-testid={testid}
      data-tip={meta.tip}
      aria-label="Open this record in the Review queue"
      onClick={() => onOpenReview(row.fact_id)}
    >
      <StatusIcon status="review" />
    </button>
  )
}

// §12 status-summary stat cells. `cls` drives the accent colour; every number
// is read straight from the ExtractionStatusSummaryDTO — nothing is hardcoded.
const SUMMARY_STATS: { key: string; label: string; cls: string; pick: (s: ExtractionStatusSummaryDTO) => number }[] = [
  // "Records", not "measurements": a variant or substrate is an extracted record
  // that carries no measurement, and this count includes them.
  { key: 'total', label: 'Total records', cls: 'neutral', pick: (s) => s.total_records },
  { key: 'validated', label: 'Auto-validated', cls: 'ok', pick: (s) => s.auto_validated },
  { key: 'needs', label: 'Needs interpretation', cls: 'warn', pick: (s) => s.needs_interpretation },
  { key: 'conflicting', label: 'Conflicting', cls: 'danger', pick: (s) => s.conflicting },
  { key: 'invalid', label: 'Output unusable', cls: 'danger', pick: (s) => s.structurally_invalid },
  // §12's sixth line, "randomly sampled records awaiting quality control". The
  // records themselves live in the Review queue, where they can actually be
  // judged; here it is a count like the other five.
  { key: 'qc', label: 'Awaiting quality control', cls: 'neutral', pick: (s) => s.qc_sample.length }
]

function ExtractionSummary({ projectId }: { projectId: number }): JSX.Element | null {
  const state = useAsync<ExtractionStatusSummaryDTO>(
    () => window.api.getExtractionStatusSummary(projectId),
    [projectId]
  )
  // Silently hide until loaded/valid — never invent numbers, never block the table.
  const s = state.data
  if (!s) return null
  // The strip is a BREAKDOWN of the records, and there is nothing to break down
  // before the first one exists. Six zeroes under an "Extraction status"
  // heading read as a report on work that was done and yielded nothing, rather
  // than on work that has not started; the empty state below says the true thing.
  if (s.total_records === 0) return null

  return (
    <div className="card ext-summary" data-testid="extraction-summary">
      <div className="ext-summary-head">
        <span className="eyebrow">Extraction status</span>
      </div>
      <div className="ext-summary-grid">
        {SUMMARY_STATS.map((st) => (
          <div className={`ext-stat ext-stat-${st.cls}`} key={st.key}>
            <span className="ext-stat-value" data-testid={`extraction-summary-${st.key}`}>
              {st.pick(s)}
            </span>
            <span className="ext-stat-label mono">{st.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- value cell

/**
 * Render one extracted value the way its FIELD DEFINITION says to. The
 * formatting branch is chosen by `field.data_type` (a DB value), so a
 * user-authored enum/boolean field displays correctly with no code change.
 * The RAW reported unit wins over the schema's target unit — the schema never
 * rewrites what the paper actually said.
 */
function CellValue({
  row,
  field
}: {
  row: ExtractionRowDTO
  field: ExtractionFieldDTO | null
}): JSX.Element {
  const type = field?.data_type ?? row.field_type
  const raw = row.value_text ?? (row.value_num != null ? String(row.value_num) : null)

  if (type === 'boolean') {
    const truthy = raw != null && /^(1|true|yes)$/i.test(raw.trim())
    return <Badge cls={truthy ? 'ok' : 'muted'}>{truthy ? 'yes' : 'no'}</Badge>
  }
  if (type === 'enum') {
    // Plain text, not a badge: an enum value IS the datum (a method name, a
    // variant), so boxing it made real data look like a status marker.
    return <span className="ext-cell-text">{raw ?? '—'}</span>
  }
  if (type === 'number') {
    return (
      <span className="mono">
        {row.value_num ?? row.value_text ?? '—'} {row.unit ?? field?.unit ?? ''}
      </span>
    )
  }
  return <span className="ext-cell-text">{raw ?? '—'}</span>
}

// ---------------------------------------------------------------- matrix

/**
 * How ONE value was obtained: the provenance that will not fit in a matrix cell
 * — fact kind, the raw as-reported quantity and unit, assay
 * conditions, fold improvement with its comparability class, and the way
 * through to the evidence.
 *
 * It lives WITH the value rather than in a second table below. A flat list of
 * every measurement restated the matrix row-for-row, with no paper column to
 * say whose reading you were looking at.
 *
 * Empty fields are omitted, not printed as "—": most of these are optional, and
 * a column of dashes reads as missing data rather than as "not applicable here".
 */
function CellProvenance({
  row,
  onOpenWork,
  onOpenEvidence,
  onOpenReview,
  onClose
}: {
  row: ExtractionRowDTO
  onOpenWork: (id: number) => void
  /** Open the paper focused on ONE evidence span. */
  onOpenEvidence: (workId: number, evidenceId: number) => void
  /** Open the review queue focused on THIS reading. */
  onOpenReview: (factId: number) => void
  onClose: () => void
}): JSX.Element {
  const k = factKindMeta(row.fact_kind)
  // What the paper SAID, with the value in it.
  //
  // This line printed the quantity and the unit and left the number out, so
  // expanding a cell to ask "what exactly was reported" answered "mutations" —
  // the name of the thing, not the reading. On a text field, where there is no
  // unit either, it was the label alone.
  //
  // The value comes first because it is the answer; the quantity follows as the
  // paper's own name for it, which is worth keeping precisely where it differs
  // from the schema's label. The schema never rewrites what the paper said.
  const reportedValue = row.value_text ?? (row.value_num != null ? String(row.value_num) : null)
  const raw = [reportedValue, row.unit].filter(Boolean).join(' ')
  // Only when it ADDS something: repeating the column header under the value it
  // already sits beneath is noise.
  const quantityNote =
    row.quantity && row.quantity.toLowerCase() !== (row.field_label ?? '').toLowerCase()
      ? row.quantity
      : null
  return (
    <div className="ext-prov" data-testid={`extraction-prov-${row.row_key}`} role="group">
      <div className="ext-prov-row">
        <Badge cls={k.cls} title={k.hint}>
          {k.label}
        </Badge>
        {/* Same badge, same wording, as the Paper and Review provenance blocks.
            Every value in this table came from an analysis run, and a reader
            expanding a cell to ask "where did this come from" must be able to
            learn that their own machine did not produce it — the CSV export of
            this very table already carried the origin, so the file was more
            honest than the screen. */}
        <RunOriginBadge
          origin={row.run_origin}
          note={row.origin_note}
          testid={`extraction-origin-${row.row_key}`}
        />
      </div>
      {raw && (
        <div className="ext-prov-line">
          <span className="ext-prov-key mono">AS REPORTED</span>
          <span className="mono" data-testid={`extraction-prov-value-${row.row_key}`}>
            {raw}
            {quantityNote && <span className="ext-prov-quantity"> · {quantityNote}</span>}
          </span>
        </div>
      )}
      {row.conditions && (
        <div className="ext-prov-line">
          <span className="ext-prov-key mono">CONDITIONS</span>
          <span>{row.conditions}</span>
        </div>
      )}
      {row.fold && (
        <div className="ext-prov-line">
          <span className="ext-prov-key mono">FOLD</span>
          <span className="ext-prov-fold">
            <span className="mono">{row.fold.fold ?? '—'}×</span>
            <Badge cls={comparabilityMeta(row.fold.comparability).cls}>
              {comparabilityMeta(row.fold.comparability).label}
            </Badge>
            <span className="mono ext-prov-fold-detail">
              {row.fold.baseline_label} → {row.fold.improved_label}
            </span>
          </span>
        </div>
      )}
      {/* TWO DESTINATIONS, EACH NAMED. One button read "evidence →" and opened
          the paper — a label describing what it showed rather than where it
          went, so the only way to learn it was a navigation was to press it and
          be moved. Both places a reader wants from a value are now offered and
          say so: the paper, with the wording highlighted, and the review queue,
          where a verdict is recorded. */}
      <div className="ext-prov-actions">
        <button
          className="btn-link"
          data-testid={`extraction-prov-open-${row.row_key}`}
          onClick={() =>
            row.evidence
              ? onOpenEvidence(row.work_id, row.evidence.id)
              : onOpenWork(row.work_id)
          }
          data-tip={
            row.evidence
              ? 'Open the paper with this wording highlighted'
              : 'No wording was stored, so the paper opens at the top'
          }
        >
          Go to paper →
        </button>
        <button
          className="btn-link"
          data-testid={`extraction-prov-review-${row.row_key}`}
          onClick={() => onOpenReview(row.fact_id)}
          data-tip="Open this reading in the review queue"
        >
          Go to review →
        </button>
        <button className="btn-link ext-prov-close" onClick={onClose}>
          close
        </button>
      </div>
    </div>
  )
}

/**
 * The per-schema matrix: COLUMNS are the schema's fields (from the DB), ROWS are
 * the works that have at least one record for this schema. Cells hold the
 * measurement filling that field, badged with its derived status.
 */
function SchemaMatrix({
  schema,
  rows,
  onOpenWork,
  onOpenEvidence,
  onOpenReview,
  expanded,
  onExpand
}: {
  schema: ExtractionSchemaDTO
  rows: ExtractionRowDTO[]
  onOpenWork: (id: number) => void
  onOpenEvidence: (workId: number, evidenceId: number) => void
  onOpenReview: (factId: number) => void
  /** row_key whose provenance is open, or null. */
  expanded: string | null
  onExpand: (key: string | null) => void
}): JSX.Element | null {
  // Group by work, preserving the (title, id) order getExtractionRows returns.
  // The grouping itself is SHARED with the paper sidebar (`lib/readings`) so the
  // two surfaces can never disagree about what one reading is.
  const works = useMemo(() => groupReadings(rows), [rows])

  if (schema.fields.length === 0) return null

  // Column template is inlined because the column COUNT is data-driven (it comes
  // from the DB field list), which a static stylesheet cannot express.
  // `1fr` is shorthand for `minmax(auto, 1fr)`, and `auto` floors a track at its
  // largest item — so one long value (a mutation list, a titled paper) grew its
  // column past its share and shoved every other column sideways. `minmax(0,…)`
  // lets tracks shrink below their content so the widths stay proportional and
  // the overflow is handled inside the cell instead.
  // The row is title + datapoint stack; the stack lays the FIELD columns out.
  // Header and sub-rows share `fieldGrid` so the columns stay aligned.
  // A real FLOOR per field column: `minmax(0, 1fr)` let the whole stack collapse
  // to whatever width was left over, crushing the headers into an illegible
  // smear. Below the floor the matrix scrolls sideways instead of shrinking.
  // Equal shares of the SAME leftover width for the header and every sub-row —
  // that shared basis is what keeps them aligned. (Sizing each grid to its own
  // `max-content` made the header's longer labels ~32px wider than the body's.)
  // The floor lets the matrix scroll rather than crush the columns when a schema
  // has more fields than the pane can hold.
  const fieldGrid = {
    gridTemplateColumns: `repeat(${schema.fields.length}, minmax(96px, 1fr))`
  }

  return (
    <div className="ext-matrix" data-testid={`extraction-matrix-${schema.id}`}>
      {/* The header mirrors the ROW's two-level split — title column, then the
          field columns one level down — so the two grids resolve to identical
          track widths. A flat header would drift out of alignment. */}
      <div className="ext-matrix-head mono">
        <span className="ext-head-title">Paper</span>
        <div className="ext-subrow ext-head-fields" style={fieldGrid}>
          {schema.fields.map((f) => (
            <span key={f.id} data-testid={`extraction-col-${f.id}`} data-tip={f.description ?? undefined}>
              {f.label}
              {f.unit && <span className="ext-col-unit"> ({f.unit})</span>}
            </span>
          ))}
        </div>
      </div>
      {works.length === 0 ? (
        <div className="ext-matrix-empty mono" data-testid={`extraction-matrix-empty-${schema.id}`}>
          no records extracted against this schema yet
        </div>
      ) : (
        /* A body wrapper so row banding can count rows. Without it the header
           is a sibling of the rows and shifts the parity of every one of them. */
        <div className="ext-matrix-body">
        {works.map((w) => {
          // The open panel is a SIBLING of the row, not a child of a cell:
          // `.ext-matrix-row > *` clips its children to one nowrap line, which
          // would flatten the panel to an invisible sliver.
          const openRow = w.rows.find((r) => r.row_key === expanded) ?? null
          return (
            <div key={w.work_id}>
              <div
                className="ext-matrix-row"
                data-testid={`extraction-matrix-row-${schema.id}-${w.work_id}`}
              >
                {/* Title | datapoints. The row is a 2-column flex: the title
                    once for the whole paper, and a stack of SUB-ROW ELEMENTS
                    beside it. They must be real elements — as bare grid rows
                    there was nothing to hover, nothing to border, and a rule
                    element between them consumed a grid row so the title's
                    `span` no longer covered them. */}
                <button
                  className="btn-link ext-matrix-work"
                  onClick={() => onOpenWork(w.work_id)}
                  data-tip={plainText(w.work_title)}
                >
                  <RichText text={w.work_title} />
                </button>
                <div className="ext-subrows">
                  {Array.from({ length: w.depth }, (_, i) => {
                  // The provenance panel belongs to the READING, so it opens
                  // directly beneath the sub-row that was clicked. Rendered once
                  // per paper it appeared under the LAST reading however far up
                  // the click was, which on a paper with a dozen variants put
                  // the explanation nowhere near the number it explained.
                  const openHere = schema.fields.some(
                    (f) => (w.cells.get(f.id)?.get(w.order[i] ?? '')?.row_key ?? null) === expanded
                  )
                  return (
                    <div key={`sub-${i}`} className="ext-subrow-group">
                    <div
                      className="ext-subrow"
                      style={fieldGrid}
                      data-testid={`extraction-subrow-${schema.id}-${w.work_id}-${i}`}
                    >
                      {schema.fields.map((f) => {
                        const hit = w.cells.get(f.id)?.get(w.order[i] ?? '') ?? null
                        if (!hit) {
                          // A paper-level field past its single reading is not
                          // missing — it was stated once and covers this row
                          // too. A "—" here says the paper never reported it,
                          // which for a variant or a buffer is simply false.
                          if (w.paperLevel.has(f.id) && i > 0) {
                            return (
                              <span className="ext-cell" key={f.id}>
                                <span
                                  className="mono ext-cell-inherited"
                                  data-tip={`Stated once for this paper and applies to every reading below it — see the ${f.label} cell in the first row.`}
                                  aria-label={`${f.label}: same as above`}
                                >
                                  ↑
                                </span>
                              </span>
                            )
                          }
                          return (
                            <span className="ext-cell" key={f.id}>
                              <span
                                className="mono ext-cell-missing"
                                data-tip={`${f.label} was not reported for this reading.`}
                              >
                                —
                              </span>
                            </span>
                          )
                        }
                        const open = expanded === hit.row_key
                        return (
                          <span className="ext-cell" key={f.id}>
                            <button
                              type="button"
                              className={`ext-cell-inner${open ? ' is-open' : ''}`}
                              data-testid={`extraction-cell-${hit.row_key}`}
                              aria-expanded={open}
                              aria-label={
                                `${f.label} for ${plainText(w.work_title)}` +
                                // With repeats the label alone is ambiguous, so
                                // the conditions that tell them apart go in it.
                                (w.depth > 1 && hit.conditions ? ` (${hit.conditions})` : '') +
                                ': show how this value was obtained'
                              }
                              onClick={() => onExpand(open ? null : hit.row_key)}
                            >
                              <CellValue row={hit} field={f} />
                              <StatusChip
                                row={hit}
                                onOpenReview={onOpenReview}
                                testid={`extraction-status-${hit.row_key}`}
                              />
                            </button>
                          </span>
                        )
                      })}
                    </div>
                    {openHere && openRow && (
                      <CellProvenance
                        row={openRow}
                        onOpenWork={onOpenWork}
                        onOpenEvidence={onOpenEvidence}
                        onOpenReview={onOpenReview}
                        onClose={() => onExpand(null)}
                      />
                    )}
                    </div>
                  )
                  })}
                </div>
              </div>
            </div>
          )
        })}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- coverage

/**
 * How much of THIS project's corpus carries values from THIS schema.
 *
 * Every number is read from `window.api.getSchemaCoverage(projectId)` — works in
 * `project_work` as the denominator, works with >= 1 measurement on one of the
 * schema's fields as the numerator. Nothing here is estimated or hardcoded.
 *
 * WORDING IS DELIBERATE. A work counts as covered when it has AT LEAST ONE value
 * from the schema, so a paper that filled 1 of 12 fields is counted — saying
 * "extracted" (let alone "complete") would overclaim. Hence "have at least one
 * value from this schema".
 */
function SchemaCoverage({ cov }: { cov: SchemaCoverageDTO | null }): JSX.Element | null {
  // No coverage row yet (still loading, or the schema is not attached) — say
  // nothing rather than render a fabricated 0.
  if (!cov) return null

  const testid = `extraction-coverage-${cov.schema_id}`
  if (cov.works_total === 0) {
    return (
      <div className="ext-coverage" role="status" data-testid={testid}>
        <span className="ext-coverage-text">No papers in this project yet — nothing to extract.</span>
      </div>
    )
  }
  if (cov.works_with_values === 0) {
    return (
      <div className="ext-coverage ext-coverage-pending" role="status" data-testid={testid}>
        <span className="ext-coverage-text">
          No papers have values from this schema yet · {cov.works_total} pending
        </span>
      </div>
    )
  }
  if (cov.works_without_values === 0) {
    return (
      <div className="ext-coverage ext-coverage-done" role="status" data-testid={testid}>
        <span className="ext-coverage-text">
          All {cov.works_total} papers have at least one value from this schema
        </span>
      </div>
    )
  }
  return (
    <div className="ext-coverage ext-coverage-pending" role="status" data-testid={testid}>
      <span className="ext-coverage-text">
        {cov.works_with_values} of {cov.works_total} papers have at least one value from this
        schema · {cov.works_without_values} with none
      </span>
    </div>
  )
}

// ---------------------------------------------------------------- record row

/**
 * One extracted record with its FULL provenance: fact kind, derived
 * status, fold improvement + comparability class, and the evidence link. Testids
 * are unchanged from the pre-schema table so existing specs keep passing.
 */
function RecordRow({
  r,
  onOpenWork,
  onOpenEvidence,
  onOpenReview
}: {
  r: ExtractionRowDTO
  onOpenWork: (id: number) => void
  onOpenEvidence: (workId: number, evidenceId: number) => void
  onOpenReview: (factId: number) => void
}): JSX.Element {
  const k = factKindMeta(r.fact_kind)
  return (
    <div className="ext-row" data-testid={`extraction-row-${r.row_key}`}>
      <span className="ext-qty">
        {r.quantity}
        {r.field_label && <span className="ext-qty-field mono"> · {r.field_label}</span>}
      </span>
      <span className="mono ext-value">
        {r.value_num ?? r.value_text ?? '—'} {r.unit ?? ''}
      </span>
      <span className="ext-cond">{r.conditions ?? '—'}</span>
      <Badge cls={k.cls}>{k.label}</Badge>
      <StatusChip
        row={r}
        onOpenReview={onOpenReview}
        testid={`extraction-status-${r.row_key}`}
      />
      <span className="ext-fold">
        {r.fold ? (
          <>
            <span className="mono">{r.fold.fold ?? '—'}×</span>
            <Badge cls={comparabilityMeta(r.fold.comparability).cls}>
              {comparabilityMeta(r.fold.comparability).label}
            </Badge>
            <span className="mono ext-fold-detail">
              {r.fold.baseline_label} → {r.fold.improved_label}
            </span>
          </>
        ) : (
          '—'
        )}
      </span>
      <button
        className="btn-link"
        // Goes to the QUOTE when there is one, not merely to the paper.
        onClick={() =>
          r.evidence ? onOpenEvidence(r.work_id, r.evidence.id) : onOpenWork(r.work_id)
        }
        data-tip={r.evidence ? 'Show this quote highlighted in the PDF' : r.work_title}
        aria-label={
          r.evidence
            ? `Show the evidence for this value in ${plainText(r.work_title)}`
            : `Open ${plainText(r.work_title)}`
        }
      >
        {r.evidence ? 'evidence →' : 'open →'}
      </button>
    </div>
  )
}

function RecordTable({
  rows,
  onOpenWork,
  onOpenEvidence,
  onOpenReview
}: {
  rows: ExtractionRowDTO[]
  onOpenWork: (id: number) => void
  onOpenEvidence: (workId: number, evidenceId: number) => void
  onOpenReview: (factId: number) => void
}): JSX.Element {
  return (
    <div className="table-card ext-table">
      <div className="ext-head mono">
        <span>Quantity</span>
        <span>Value</span>
        <span>Conditions</span>
        <span>Kind</span>
        <span>Status</span>
        <span>Fold</span>
        <span />
      </div>
      {rows.map((r) => (
        <RecordRow
          r={r}
          key={r.row_key}
          onOpenWork={onOpenWork}
          onOpenEvidence={onOpenEvidence}
          onOpenReview={onOpenReview}
        />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- screen

export function ExtractionScreen({
  projectId,
  onOpenWork,
  onOpenEvidence,
  onEditSchemas,
  onOpenReview,
  onAddPapers,
  focusRowKey,
  focusSchemaId
}: {
  projectId: number
  onOpenWork: (id: number) => void
  /** Leave for the Papers screen, for the state where there is nothing to
   *  extract FROM. */
  onAddPapers: () => void
  /** Open a paper focused on ONE evidence span, for the "evidence →" links. */
  onOpenEvidence: (workId: number, evidenceId: number) => void
  /** Leave the project for the app-level (global) Schemas editor. */
  onEditSchemas: () => void
  /** Open the Review queue positioned on one fact. */
  onOpenReview: (factId: number) => void
  /**
   * Arrive ON one record: its row_key, as carried by the route when a paper's
   * reading links here. Honoured ONCE — after that the screen is the user's, so
   * a schema tab they pick or a cell they collapse is not overridden by where
   * they came from.
   */
  focusRowKey?: string
  /** Which schema tab to show it in. Derived from the record when omitted. */
  focusSchemaId?: number
}): JSX.Element {
  const state = useAsync<ExtractionRowDTO[]>(() => window.api.getExtractionRows(projectId), [projectId])
  // With no rows, the next step depends on what the project is MISSING: papers,
  // or a run over the papers it has. Telling someone to run an analysis on a
  // corpus of nothing is an instruction that cannot be followed.
  const project = useAsync(() => window.api.getProject(projectId), [projectId])
  // The schemas THIS PROJECT applies (project_schema rows). Loaded independently
  // so a schema failure can never hide the extracted records (they still render
  // in the fallback section).
  const attachedState = useAsync<ExtractionSchemaDTO[]>(
    () => window.api.listProjectSchemas(projectId),
    [projectId]
  )
  // Every schema in the app — the pool the "Add schema" picker offers.
  const allState = useAsync<ExtractionSchemaDTO[]>(() => window.api.listSchemas(), [])
  const [shown, setShown] = useState(PAGE_SIZE)
  // row_key whose provenance is expanded. ONE at a time: several open cells
  // would push the matrix rows apart and destroy the column alignment that
  // makes it readable.
  const [expandedCell, setExpandedCell] = useState<string | null>(null)
  /**
   * The schema being looked at. ONE at a time — stacking every schema's matrix
   * on one page meant scrolling past tables you were not reading to reach the
   * one you were. `null` means "not chosen yet" and resolves to the first
   * schema once the list loads.
   */
  const [activeSchemaId, setActiveSchemaId] = useState<number | null>(null)

  /**
   * Arriving on a specific record (a paper sidebar's reading link).
   *
   * The route is known before the records are, so this cannot run on mount: it
   * waits for `state.data` and then resolves the record to its schema tab, opens
   * its provenance and scrolls it into view. The ref makes it fire ONCE per
   * route value — a re-render caused by the user collapsing that very cell must
   * not re-open it.
   */
  const focusedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!focusRowKey || !state.data) return
    if (focusedRef.current === focusRowKey) return
    const hit = state.data.find((r) => r.row_key === focusRowKey)
    if (!hit) return
    focusedRef.current = focusRowKey
    const schemaId = focusSchemaId ?? hit.schema_id
    if (schemaId != null) setActiveSchemaId(schemaId)
    setExpandedCell(focusRowKey)
    // After the tab switch and the expansion have painted — the cell does not
    // exist to scroll to until then.
    const raf = requestAnimationFrame(() => {
      document
        .querySelector(`[data-testid="extraction-cell-${CSS.escape(focusRowKey)}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
    return () => cancelAnimationFrame(raf)
  }, [focusRowKey, focusSchemaId, state.data])

  // Local mirror of the ATTACHED list so attach/detach render instantly from the
  // mutation's RETURN VALUE (no read-after-write race), matching the Schemas
  // screen convention. The DB remains the only source of truth: this mirror is
  // seeded from, and replaced by, values that came out of `window.api`.
  const [attached, setAttached] = useState<ExtractionSchemaDTO[] | null>(null)
  const [coverage, setCoverage] = useState<SchemaCoverageDTO[] | null>(null)
  const [picking, setPicking] = useState(false)
  const [attachError, setAttachError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (attachedState.data) setAttached(attachedState.data)
  }, [attachedState.data])

  // The menu is PORTALLED to <body>: the screen scrolls inside its own stacking
  // context, so an absolutely-positioned popover is painted under the sidebar no
  // matter how high its z-index. Position is therefore fixed and measured from
  // the trigger's viewport rect.
  const addRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null)
  useEffect(() => {
    if (!picking) {
      setMenuPos(null)
      return
    }
    const place = (): void => {
      const r = addRef.current?.getBoundingClientRect()
      if (r) setMenuPos({ top: r.bottom + 6, right: window.innerWidth - r.right })
    }
    place()
    window.addEventListener('resize', place)
    // A scroll moves the trigger but not a fixed popover, so re-measure (capture
    // phase: the screen's own scroller does not bubble).
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [picking])

  // A menu that only closes by re-pressing its own trigger is a trap once the
  // user's attention has moved on: dismiss on outside click and on Escape.
  useEffect(() => {
    if (!picking) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (!addRef.current?.contains(t) && !menuRef.current?.contains(t)) setPicking(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPicking(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [picking])

  // Coverage is refetched after every attach/detach (a newly attached schema has
  // no coverage row until it is attached). `nonce` forces the refetch.
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let alive = true
    window.api
      .getSchemaCoverage(projectId)
      .then((c) => {
        if (alive) setCoverage(c)
      })
      .catch(() => {
        // Never invent coverage: leave it null and render no coverage line.
        if (alive) setCoverage(null)
      })
    return () => {
      alive = false
    }
  }, [projectId, nonce])

  const schemas = attached ?? attachedState.data ?? []
  const allSchemas = allState.data ?? []
  const attachedIds = new Set(schemas.map((s) => s.id))
  /**
   * The schema in view. Resolved rather than stored so it stays valid when the
   * list changes: detaching the selected schema, or arriving before the list has
   * loaded, falls back to the first one instead of showing an empty page.
   */
  const currentSchemaId =
    activeSchemaId !== null && attachedIds.has(activeSchemaId)
      ? activeSchemaId
      : (schemas[0]?.id ?? null)
  const attachable = allSchemas.filter((s) => !attachedIds.has(s.id))
  const covById = new Map((coverage ?? []).map((c) => [c.schema_id, c]))

  const applyAttachment = (p: Promise<ExtractionSchemaDTO[]>): void => {
    setBusy(true)
    setAttachError(null)
    p.then((list) => {
      setAttached(list)
      setNonce((n) => n + 1)
    })
      .catch((e: unknown) => setAttachError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }

  return (
    <div className="screen" data-testid="screen-extraction">
      <ScreenHeader
        eyebrow="Extraction"
        actions={
          <>
            <div className="ext-add-schema" ref={addRef}>
              <button
                className="btn btn-primary"
                data-testid="extraction-add-schema"
                aria-expanded={picking}
                aria-haspopup="menu"
                aria-controls="extraction-schema-picker"
                disabled={busy}
                onClick={() => setPicking((v) => !v)}
              >
                Add schema
              </button>
              {picking &&
                menuPos &&
                createPortal(
                  <div
                    className="menu ext-add-menu"
                    id="extraction-schema-picker"
                    role="menu"
                    data-testid="extraction-schema-picker"
                    ref={menuRef}
                    style={{ top: menuPos.top, right: menuPos.right }}
                  >
                    <button
                      className="menu-item"
                      role="menuitem"
                      data-testid="extraction-create-schema"
                      onClick={() => {
                        setPicking(false)
                        onEditSchemas()
                      }}
                    >
                      Create new schema…
                    </button>
                    {attachable.length > 0 && <div className="menu-sep" role="separator" />}
                    {attachable.map((s) => (
                      <button
                        key={s.id}
                        className="menu-item"
                        role="menuitem"
                        data-testid={`extraction-attach-${s.id}`}
                        disabled={busy}
                        data-tip={s.description ?? undefined}
                        onClick={() => {
                          applyAttachment(window.api.attachSchema(projectId, s.id))
                          setPicking(false)
                        }}
                      >
                        {s.name}
                        <span className="menu-item-meta mono">{s.fields.length} fields</span>
                      </button>
                    ))}
                  </div>,
                  document.body
                )}
            </div>
            <button className="btn btn-secondary" data-testid="extraction-edit-schemas" onClick={onEditSchemas}>
              Edit schemas
            </button>
          </>
        }
      />

      {attachError && (
        <div className="card ext-attach-error mono" role="alert" data-testid="extraction-attach-error">
          {attachError}
        </div>
      )}

      {schemas.length === 0 && (
        <div className="card ext-attach-empty mono" data-testid="extraction-attach-empty">
          no schemas applied in this project — add one to structure the extraction
        </div>
      )}

      <ExtractionSummary projectId={projectId} />

      {/* Schema switcher. Horizontal, single-select: everything below is derived
          from the ONE schema chosen here, so the page answers a question about
          one schema instead of stacking every schema's table on top of the next. */}
      {schemas.length > 1 && (
        <div className="ext-schema-switch" role="tablist" data-testid="extraction-schema-switch">
          {schemas.map((s) => {
            const on = s.id === currentSchemaId
            return (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={on}
                className={`ext-schema-tab${on ? ' is-active' : ''}`}
                data-testid={`extraction-schema-tab-${s.id}`}
                data-tip={s.description ?? undefined}
                onClick={() => setActiveSchemaId(s.id)}
              >
                {s.name}
              </button>
            )
          })}
        </div>
      )}

      <DataView
        state={state}
        isEmpty={(d) => d.length === 0}
        empty={
          <EmptyState
            title="Nothing extracted yet."
            hint={
              project.data && project.data.work_count === 0
                ? 'This screen tabulates the values a model pulled out of your papers, one row per paper.'
                : 'This screen tabulates the values a model pulled out of your papers, one row per paper. Apply a schema above, then run an analysis from a paper.'
            }
          >
            {project.data && project.data.work_count === 0 && (
              <div className="empty-state-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  data-testid="extraction-empty-add-papers"
                  onClick={onAddPapers}
                >
                  Add papers
                </button>
              </div>
            )}
          </EmptyState>
        }
      >
        {(rows) => {
          // Which schemas actually have records here. Schemas with no records
          // are still listed (with a 0 count) so the user can see the shape
          // exists — but only when at least one schema is defined at all.
          const bySchema = new Map<number, ExtractionRowDTO[]>()
          for (const r of rows) {
            if (r.schema_id == null) continue
            const list = bySchema.get(r.schema_id) ?? []
            list.push(r)
            bySchema.set(r.schema_id, list)
          }
          // ONE schema at a time — the switcher above chooses it.
          const visibleSchemas = schemas.filter((s) => s.id === currentSchemaId)

          // The sections must always PARTITION `rows` — nothing extracted may
          // silently vanish, and the flat 40-row pagination arithmetic depends
          // on it. Rows not shown by an attached-schema section fall into ONE of
          // two clearly distinct buckets:
          //
          //   DETACHED  — the measurement IS linked to a schema field, but the
          //               project no longer applies that schema. Labelling these
          //               "unassigned" would be false, so they get their own
          //               section (named from the global schema list) with a
          //               re-attach action.
          //   UNASSIGNED — genuinely no field link (field_id NULL), e.g. the
          //               schema was deleted globally or the model returned a
          //               field key we don't know.
          // Based on EVERY attached schema, not just the one on screen: a record
          // belonging to an attached schema the user is not currently looking at
          // is still accounted for. Deriving this from `visibleSchemas` would
          // dump the other schemas' records into "unassigned", which is false —
          // they are field-linked, merely not in view.
          const covered = new Set(
            schemas.flatMap((s) => (bySchema.get(s.id) ?? []).map((r) => r.row_key))
          )
          const leftover = rows.filter((r) => !covered.has(r.row_key))
          const globalById = new Map(allSchemas.map((s) => [s.id, s]))
          const detachedGroups = new Map<number, ExtractionRowDTO[]>()
          for (const r of leftover) {
            // DETACHED — a record belonging to a schema this project no longer
            // has attached. It is still field-linked and still real, so it is
            // shown with a way to re-attach.
            //
            // A record linked to NO field is not shown at all. It used to get an
            // "Unassigned" table, which surfaced values no schema had asked for
            // — 84 of 192 measurements on this corpus, mostly activation
            // energies from computational papers — under a note claiming they
            // also appeared above under the schema that wanted them. No schema
            // wanted them, so they appeared nowhere else, and the note taught
            // the reader to dismiss real data as a duplicate. The fix is at the
            // source: the extractor now reports only what its target schema
            // asks for, so these rows are not produced in the first place.
            if (r.schema_id != null && globalById.has(r.schema_id) && !attachedIds.has(r.schema_id)) {
              const list = detachedGroups.get(r.schema_id) ?? []
              list.push(r)
              detachedGroups.set(r.schema_id, list)
            }
          }
          // Pagination now bounds ONLY the detached record tables —
          // the matrices show every row, since a paper's line is one row however
          // many measurements it carries. Counting all rows here would offer
          // "Show more" for records that are not paginated at all.
          const flatVisible = [...detachedGroups.values()].flat()
          const pageIds = new Set(flatVisible.slice(0, shown).map((r) => r.row_key))
          const page = (list: ExtractionRowDTO[]): ExtractionRowDTO[] =>
            list.filter((r) => pageIds.has(r.row_key))

          return (
            <>
              {visibleSchemas.map((s) => {
                const secRows = bySchema.get(s.id) ?? []
                return (
                  <div className="card ext-schema-section" data-testid={`extraction-schema-${s.id}`} key={s.id}>
                    <div className="ext-schema-head">
                      <div className="ext-schema-titles">
                        <div className="ext-schema-name" data-testid={`extraction-schema-name-${s.id}`}>
                          {s.name}
                        </div>
                      </div>
                      {/* Removal sits on the thing it removes. The wording says
                          "from project" because the schema and every record
                          extracted with it are kept — only this project stops
                          applying it. */}
                      <button
                        className="btn-link ext-schema-remove"
                        data-testid={`extraction-detach-${s.id}`}
                        disabled={busy}
                        onClick={() => applyAttachment(window.api.detachSchema(projectId, s.id))}
                      >
                        Remove schema from project
                      </button>
                    </div>

                    <SchemaCoverage cov={covById.get(s.id) ?? null} />

                    <SchemaMatrix
                      schema={s}
                      rows={secRows}
                      onOpenWork={onOpenWork}
                      onOpenEvidence={onOpenEvidence}
                      onOpenReview={onOpenReview}
                      expanded={expandedCell}
                      onExpand={setExpandedCell}
                    />
                  </div>
                )
              })}

              {/* DETACHED — the schema still exists globally, this project just
                  stopped applying it. The records are kept and shown, honestly
                  labelled, with a one-click way back. */}
              {[...detachedGroups.entries()].map(([sid, secRows]) => {
                  const s = globalById.get(sid)
                  if (!s) return null
                  return (
                    <div
                      className="card ext-schema-section ext-schema-detached"
                      data-testid={`extraction-schema-detached-${sid}`}
                      key={`detached-${sid}`}
                    >
                      <div className="ext-schema-head">
                        <div className="ext-schema-titles">
                          <span className="eyebrow">Detached schema</span>
                          <div className="ext-schema-name">
                            {s.name} — no longer applied in this project
                          </div>
                        </div>
                        <span className="ext-schema-meta mono">{secRows.length} records · kept</span>
                      </div>
                      <button
                        className="btn btn-secondary ext-reattach"
                        data-testid={`extraction-reattach-${sid}`}
                        disabled={busy}
                        onClick={() => applyAttachment(window.api.attachSchema(projectId, sid))}
                      >
                        Re-attach to this project
                      </button>
                      <RecordTable rows={page(secRows)} onOpenWork={onOpenWork} onOpenEvidence={onOpenEvidence} onOpenReview={onOpenReview} />
                    </div>
                  )
              })}


              {shown < flatVisible.length && (
                <button
                  className="btn btn-secondary show-more"
                  data-testid="extraction-show-more"
                  onClick={() => setShown((s) => s + PAGE_SIZE)}
                >
                  Show more ({flatVisible.length - shown} remaining)
                </button>
              )}
            </>
          )
        }}
      </DataView>
    </div>
  )
}
