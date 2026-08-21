import type { ExtractionRowDTO } from '@shared/contract'

/**
 * WHAT A "READING" IS — one definition, shared by every surface that shows one.
 *
 * The Extraction matrix and the Paper sidebar both lay extracted records out as
 * readings of a paper. If they grouped differently the same paper would report a
 * different number of measurements depending on which screen you were looking
 * at, so the grouping lives here and both import it.
 */

/**
 * WHAT MAKES TWO READINGS THE SAME MEASUREMENT.
 *
 * A sub-row was previously the i-th reading of every field, lined up by
 * position — so the i-th kcat sat beside the i-th Km with nothing
 * guaranteeing they described the same experiment. A paper measuring one
 * variant against four substrates therefore rendered one variant with four
 * contradictory kcat values and no way to tell which belonged to which.
 *
 * The subject (which variant) and the conditions (which substrate, which
 * temperature) are what identify a reading, and both are already stored on
 * every record. Grouping on them makes a sub-row one coherent measurement
 * by construction rather than by hoping the orders match.
 */
export function readingKey(r: ExtractionRowDTO): string {
  return `${(r.subject ?? '').trim().toLowerCase()}|${(r.conditions ?? '').trim().toLowerCase()}`
}

export interface WorkReadings {
  work_id: number
  work_title: string
  /** Every record of this work, in the order the query returned them. */
  rows: ExtractionRowDTO[]
  /**
   * fieldId -> readingKey -> the record filling that cell.
   *
   * ITERATION ORDER IS THE SCHEMA'S FIELD ORDER (`field_sort_order`, id as the
   * tiebreak), not the order the records arrived in. The matrix takes its
   * columns from the schema DTO and so never depended on this, but the paper's
   * readings list walks this map directly — so before it was sorted, a field the
   * user dragged to the front still appeared in whatever sequence the extractor
   * happened to emit its values.
   */
  cells: Map<number, Map<string, ExtractionRowDTO>>
  /** One entry per DISTINCT reading, in first-seen order. */
  order: string[]
  /**
   * How many DATAPOINTS this paper contributed: the largest number of readings
   * any single field carries. A paper reporting two thermal melts occupies two
   * sub-rows, and every other field lines its readings up against them — so a
   * row is one coherent measurement rather than a bag of values.
   *
   * Fields whose readings are FEWER than `depth` do not line up one-to-one, and
   * the sub-rows past their last reading are not missing data. The commonest
   * shape is a field stated ONCE for the whole paper — a variant name, a
   * substrate, a buffer — against many kinetic readings; those are marked
   * paper-level so the cell can say "stated once, applies throughout" instead
   * of rendering the "—" that means "this was never reported".
   */
  depth: number
  /**
   * Fields carrying exactly ONE value across many readings: stated once for the
   * paper — a substrate, a buffer, a variant name — and holding for all of them.
   */
  paperLevel: Set<number>
  /**
   * Records with NO field link (`field_id` is null): a value the run produced
   * that the schema never asked for. They take no part in the matrix — there is
   * no column for them — but they are real extracted data and are surfaced here
   * so a caller can render them rather than drop them on the floor.
   */
  unassigned: ExtractionRowDTO[]
}

/**
 * Group a flat record list into one entry per work, preserving the (title, id)
 * order `getExtractionRows` returns.
 */
export function groupReadings(rows: ExtractionRowDTO[]): WorkReadings[] {
  const byWork = new Map<number, { work_id: number; work_title: string; rows: ExtractionRowDTO[] }>()
  for (const r of rows) {
    const entry = byWork.get(r.work_id) ?? { work_id: r.work_id, work_title: r.work_title, rows: [] }
    entry.rows.push(r)
    byWork.set(r.work_id, entry)
  }

  return [...byWork.values()].map((w) => {
    // One bucket per DISTINCT reading, in first-seen order.
    const order: string[] = []
    const seen = new Set<string>()
    for (const r of w.rows) {
      if (r.field_id == null) continue
      const k = readingKey(r)
      if (!seen.has(k)) {
        seen.add(k)
        order.push(k)
      }
    }
    // fieldId -> readingKey -> the record filling that cell.
    const cells = new Map<number, Map<string, ExtractionRowDTO>>()
    const unassigned: ExtractionRowDTO[] = []
    for (const r of w.rows) {
      if (r.field_id == null) {
        unassigned.push(r)
        continue
      }
      const perField = cells.get(r.field_id) ?? new Map<string, ExtractionRowDTO>()
      // First write wins. A field genuinely reported twice for the SAME
      // subject under the SAME conditions is a duplicate extraction, not a
      // second datapoint, and showing both invites the reader to reconcile
      // two numbers that describe one measurement.
      if (!perField.has(readingKey(r))) perField.set(readingKey(r), r)
      cells.set(r.field_id, perField)
    }
    // Re-key the map in the schema's display order. A Map iterates in insertion
    // order, and the insertions above follow the query's row order — so the only
    // way for a consumer that walks `cells` to honour a reorder is for the map
    // itself to be rebuilt sorted. `id` breaks ties exactly as the SQL
    // `ORDER BY sort_order, id` does, so two fields sharing a position resolve
    // the same way here as in the matrix header.
    const orderOf = new Map<number, number>()
    for (const r of w.rows) {
      if (r.field_id != null && !orderOf.has(r.field_id)) {
        orderOf.set(r.field_id, r.field_sort_order ?? Number.MAX_SAFE_INTEGER)
      }
    }
    const orderedCells = new Map(
      [...cells.entries()].sort(
        ([a], [b]) =>
          (orderOf.get(a) ?? 0) - (orderOf.get(b) ?? 0) || a - b
      )
    )
    const depth = Math.max(1, order.length)
    // A field carrying exactly ONE value across many readings was stated once
    // for the paper — a substrate, a buffer, a variant name — and holds for
    // all of them. Marked so the cell can say "stated once, applies
    // throughout" instead of the "—" that means "never reported".
    const paperLevel = new Set<number>()
    for (const [fieldId, perField] of orderedCells) {
      if (perField.size === 1 && depth > 1) paperLevel.add(fieldId)
    }
    return { ...w, cells: orderedCells, order, depth, paperLevel, unassigned }
  })
}
