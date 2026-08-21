// Comparing two INDEPENDENT readings of the same table.
//
// WHY THIS EXISTS. Every earlier reviewer was shown what the extraction had
// stored and asked whether it was right, and that question cannot be answered
// honestly. Handed `0.0185 / 1.03 / 5.84` and asked "does the page print these
// here", the reviewer replied "All match" for a cell the page prints as
// `0.0185 / 0.435 / 42.3`; in the next cell it transcribed the printed row
// CORRECTLY and still passed the stored one. It was not misreading the picture.
// It was agreeing with the answer contained in the question.
//
// So the second reading is taken blind — `table-read@v1` sees the crop and
// nothing else — and the two readings are compared HERE, mechanically. A
// disagreement between two readers who could not see each other is evidence; a
// reader agreeing with what it was shown is not.
//
// This file makes no judgement about which reading is RIGHT. It reports where
// they differ and what each says, and the difference is what reaches a human.

/** One figure a blind reading found printed in a cell. */
export interface ReadValue {
  quantity: string
  value: string
  unit: string | null
}

/** One cell of a blind reading: a row/column place and what is printed there. */
export interface ReadCell {
  row: string
  column: string
  /** What the page prints INSTEAD of a figure — `ND`, `not measured`, `blank`. */
  marked: string | null
  values: ReadValue[]
}

/** One stored record, reduced to the same shape for comparison. */
export interface StoredValue {
  factId: number
  measurementId: number
  quantity: string
  value: string
  unit: string | null
}

export interface StoredCell {
  row: string
  column: string
  values: StoredValue[]
}

export type DisagreementKind =
  /** The stored figure is not printed at this place at all. */
  | 'value-not-printed'
  /** The page prints a figure here that nothing was stored for. */
  | 'value-not-stored'
  /** The page marks this place unmeasured, yet a figure was stored for it. */
  | 'stored-where-page-marks-absent'
  /** The stored figure IS printed in this row, but under a different column. */
  | 'value-belongs-to-another-column'

export interface Disagreement {
  kind: DisagreementKind
  row: string
  column: string
  quantity: string
  /** What the extraction stored, where there is one. */
  stored: string | null
  /** What the blind reading found, where there is one. */
  printed: string | null
  /** For a shifted value: the column the blind reading found it under. */
  printedUnderColumn?: string
  factId: number | null
  measurementId: number | null
}

/**
 * Fold a label to compare it across two readings.
 *
 * Two readers copying the same heading differ in case, spacing and the dash
 * they reach for; none of that is a disagreement about the table. Everything
 * else is kept — `6-chloro` and `5,7-dichloro` must stay distinct, which is the
 * entire point of the comparison.
 */
export function foldLabel(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Fold a figure to compare it across two readings.
 *
 * A number is the same number whether it is written `1,833 ± 75` or `1833±75`,
 * and the two readers will not agree on the separator or the spacing. The
 * UNCERTAINTY is kept: `0.98 ± 0.16` and `0.98 ± 0.02` are different readings
 * of a table and must not fold together. So is a bound: `> 95` is not `95`.
 */
export function foldFigure(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u2212\u2013\u2014]/g, '-')
    .replace(/[\u00b1]/g, '+-')
    .replace(/,(?=\d{3}\b)/g, '')
    .replace(/\s+/g, '')
    .trim()
}

/**
 * The figure without its uncertainty.
 *
 * The two readings are not symmetric about this: the blind reading is asked for
 * the figure AS PRINTED and gives `42.3 ± 0.3`, while the extraction splits the
 * uncertainty into its own column and stores `42.3`. Comparing those strings
 * whole would report every correct value in the corpus as a disagreement.
 *
 * So a match is tried on the full figure FIRST — that is the strict comparison
 * and the one that distinguishes `0.98 ± 0.16` from `0.98 ± 0.02` — and only
 * then on the central value alone. The looser test can confuse two readings
 * that share a value and differ in error, which is rare; reporting a real shift
 * matters more, and a human sees both figures in the note either way.
 */
export function foldCentral(s: string): string {
  return foldFigure(s).split('+-')[0]
}

/**
 * The number inside a figure, or null when there is not exactly one.
 *
 * Parsing rather than string-folding is what makes `0.0060`, `6.0e-3` and
 * `.006` one reading instead of three, and it is the only comparison that does
 * not need a new rule every time a journal invents a notation.
 */
function figureNumber(s: string): number | null {
  const central = foldCentral(s)
    // A footnote marker is printed ON the figure and belongs to neither reader's
    // claim about its value: `∼ 160*` and `160` are the same number.
    .replace(/[*†‡§¶#\u2020\u2021]/g, '')
    // Approximation and bound signs, in the several forms a page and a model
    // each reach for. The SIGN is not dropped from the comparison — it is
    // compared separately below — only from the number.
    .replace(/^[~\u223c\u2248\u2264\u2265<>=]+/, '')
  const m = central.match(/^-?\d*\.?\d+(?:e[+-]?\d+)?$/)
  if (!m) return null
  const n = Number.parseFloat(central)
  return Number.isFinite(n) ? n : null
}

/** `>`, `<`, `≥`, `≤`, `~` — normalised, because a bound is part of the claim. */
function figureSign(s: string): string {
  const m = foldCentral(s)
    .replace(/[*†‡§¶#\u2020\u2021]/g, '')
    .match(/^[~\u223c\u2248\u2264\u2265<>=]+/)
  if (!m) return ''
  const t = m[0]
  if (/[~\u223c\u2248]/.test(t)) return '~'
  if (/[\u2265]|>=/.test(t)) return '>='
  if (/[\u2264]|<=/.test(t)) return '<='
  if (t.includes('>')) return '>'
  if (t.includes('<')) return '<'
  return ''
}

/**
 * Do two figures name the same reading?
 *
 * Three tests, loosening in order. The string comparison is strict and settles
 * most; the split-uncertainty one handles the extraction storing `42.3` where
 * the page prints `42.3 ± 0.3`; the NUMERIC one is what stops two spellings of
 * one number reading as a conflict.
 *
 * A bound or approximation is compared but not required to match exactly in
 * KIND: `∼ 160*` and `~160` are the same claim, and `≥ 160` against `∼ 160` is
 * a difference of interpretation the two readers can legitimately have about
 * the same printed figure — so it is not reported as a value conflict, which is
 * about WHICH NUMBER is at a place.
 */
export function sameFigure(a: string, b: string): boolean {
  if (foldFigure(a) === foldFigure(b)) return true
  if (foldCentral(a) === foldCentral(b)) return true
  const na = figureNumber(a)
  const nb = figureNumber(b)
  if (na === null || nb === null) return false
  if (na !== nb) return false
  // Both bare, or both qualified in some way: the same number. One bare and one
  // bounded is a real difference — `95` and `> 95` are not the same claim.
  return (figureSign(a) === '') === (figureSign(b) === '')
}

/**
 * Is this string the page saying "no number here" rather than a figure?
 *
 * The words vary by journal and by reader — `ND`, `n.d.`, `not determined`,
 * `not measured`, `below detection limit`, an em dash, or nothing at all — and
 * a printed footnote marker rides along with them (`ND†`). They all mean the
 * authors reported no number, which is a RESULT and is why a cell with no
 * stored value is usually correct.
 */
export function isAbsenceMark(s: string | null | undefined): boolean {
  const m = (s ?? '')
    .toLowerCase()
    // Footnote markers attach to the mark itself: `ND†`, `ND*`, `ND‡`.
    .replace(/[*†‡§¶#\u2020\u2021]/g, '')
    .trim()
  if (m === '') return true
  return /^(n\.?\s*d\.?|not\s|below\s|blank|absent|none|-|—|–|\u2014|\u2013)$|^(n\.?\s*d\.?|not\s|below\s)/.test(
    m
  )
}

/**
 * Does this reading say the place carries no figure?
 *
 * A MARK MAY ARRIVE AS A VALUE, and that is the common case rather than the
 * exception. The blind reader is asked to report figures in `values` and what
 * the page prints instead in `marked`, and it frequently does the reasonable
 * thing instead: puts `ND†` in `values` with the quantity it belongs to,
 * because that IS what is printed at that place. Reading only `marked` counted
 * those as figures the extraction had missed, and produced fourteen
 * disagreements on one table — every one of them the two readings agreeing that
 * nothing was measured.
 */
export function marksAbsent(cell: ReadCell): boolean {
  if (cell.values.some((v) => !isAbsenceMark(v.value))) return false
  return isAbsenceMark(cell.marked)
}

/** The figures in a cell, with any absence marks removed. */
function realValues(cell: ReadCell): ReadValue[] {
  return cell.values.filter((v) => !isAbsenceMark(v.value))
}

const key = (row: string, column: string): string => `${foldLabel(row)}\u0000${foldLabel(column)}`

/**
 * Where two readings of one table disagree.
 *
 * ONLY over cells BOTH readings cover. A cell the blind reading never reported
 * says nothing about the stored one — the picture may not show it, the reader
 * may have stopped early — and treating that silence as "not printed" would
 * manufacture a disagreement out of a gap in coverage. The same in reverse: a
 * printed cell nothing was stored for is reported, because that IS a finding,
 * but only when the blind reading actually saw the row.
 */
export function compareReadings(
  stored: StoredCell[],
  read: ReadCell[]
): Disagreement[] {
  // ONE ENTRY PER PLACE, and the richer reading wins.
  //
  // A paper's crops overlap: Table 1 and Table 2 of one page are rendered
  // separately, and a reader given each reports the same row twice. Keeping the
  // last silently preferred whichever crop happened to be rendered second, and
  // when that one saw the cell only as a header fragment it read as absent —
  // producing a disagreement against a correct extraction. Preferring the
  // reading that actually found figures is the honest tie-break: a crop that
  // shows the values saw more of the page than one that did not.
  const readByCell = new Map<string, ReadCell>()
  for (const c of read) {
    const k = key(c.row, c.column)
    const had = readByCell.get(k)
    if (had === undefined || realValues(had).length < realValues(c).length) {
      readByCell.set(k, c)
    }
  }
  // Row -> every figure the blind reading found anywhere in it, so a stored
  // figure that is absent HERE can be reported as belonging to another column
  // rather than as absent from the paper.
  const readByRow = new Map<string, Array<{ column: string; v: ReadValue }>>()
  for (const c of read) {
    const r = foldLabel(c.row)
    const list = readByRow.get(r) ?? []
    for (const v of realValues(c)) list.push({ column: c.column, v })
    readByRow.set(r, list)
  }

  const out: Disagreement[] = []
  for (const sc of stored) {
    const rc = readByCell.get(key(sc.row, sc.column))
    if (rc === undefined) continue

    if (marksAbsent(rc)) {
      for (const sv of sc.values) {
        const elsewhere = (readByRow.get(foldLabel(sc.row)) ?? []).find((x) =>
          sameFigure(x.v.value, sv.value)
        )
        out.push({
          kind: elsewhere
            ? 'value-belongs-to-another-column'
            : 'stored-where-page-marks-absent',
          row: sc.row,
          column: sc.column,
          quantity: sv.quantity,
          stored: sv.value,
          printed: rc.marked ?? 'nothing',
          printedUnderColumn: elsewhere?.column,
          factId: sv.factId,
          measurementId: sv.measurementId
        })
      }
      continue
    }

    const printed = realValues(rc)
    for (const sv of sc.values) {
      if (printed.some((v) => sameFigure(v.value, sv.value))) continue
      const elsewhere = (readByRow.get(foldLabel(sc.row)) ?? []).find(
        (x) => sameFigure(x.v.value, sv.value) && foldLabel(x.column) !== foldLabel(sc.column)
      )
      out.push({
        kind: elsewhere ? 'value-belongs-to-another-column' : 'value-not-printed',
        row: sc.row,
        column: sc.column,
        quantity: sv.quantity,
        stored: sv.value,
        printed: printed.map((v) => v.value).join(', ') || null,
        printedUnderColumn: elsewhere?.column,
        factId: sv.factId,
        measurementId: sv.measurementId
      })
    }

    // A figure the page prints here that nothing was stored for. Reported last
    // because it is the weaker finding: the schema may simply not have a field
    // for that quantity, which is not an error.
    for (const rv of printed) {
      if (sc.values.some((v) => sameFigure(v.value, rv.value))) continue
      out.push({
        kind: 'value-not-stored',
        row: sc.row,
        column: sc.column,
        quantity: rv.quantity,
        stored: null,
        printed: rv.value,
        factId: sc.values[0]?.factId ?? null,
        measurementId: null
      })
    }
  }
  return out
}

/**
 * Is this disagreement one a WORDING question could dissolve?
 *
 * Only some can. A disagreement where the two readings hold different NUMBERS
 * is settled: `42.3` and `5.84` are not two spellings of one figure, and asking
 * a model about them invites it to explain away a real error. What is worth
 * asking about is a disagreement where the numbers agree — or there is only one
 * — and the LABELS differ, because `6-Cl BI` and `6-chloro BI` are one column
 * written two ways and no amount of string folding will say so.
 *
 * The test is therefore about the SHAPE of the disagreement rather than about
 * its content: a value that exists in the row under a differently-named column,
 * or a place whose row or column name differs from what the other reading
 * called it. Everything else is left alone.
 */
export function isWordingCandidate(d: Disagreement): boolean {
  return wordingPair(d) !== null
}

/**
 * The two pieces of text a wording question is about, or null.
 *
 * ONE CASE, deliberately. A value found elsewhere in the row under a different
 * column name is exactly the disagreement that dissolves if the two names mean
 * one thing: the figure is right, the row is right, and only the label differs.
 *
 * The other kinds are left alone on purpose. `stored-where-page-marks-absent`
 * is about what is PRINTED, not what it is called. `value-not-printed` and
 * `value-not-stored` are about a figure being present or missing, and inviting
 * a model to explain those away as a naming difference is inviting it to bury a
 * real error. If a quantity-renaming case turns up in practice it can be added
 * with an example in front of us; guessing at one now is how the last three
 * regressions started.
 */
export function wordingPair(d: Disagreement): { a: string; b: string } | null {
  if (d.kind !== 'value-belongs-to-another-column') return null
  if (d.printedUnderColumn === undefined) return null
  return { a: d.column, b: d.printedUnderColumn }
}

/** One disagreement, in the words a scientist reads beside the record. */
export function describeDisagreement(d: Disagreement): string {
  const place = `${d.row} × ${d.column}`
  switch (d.kind) {
    case 'stored-where-page-marks-absent':
      return (
        `A second reading of this table found ${place} marked "${d.printed}" — ` +
        `no figure is printed there — but ${d.stored} was recorded for ${d.quantity}.`
      )
    case 'value-belongs-to-another-column':
      return (
        `A second reading of this table found ${d.stored} printed under ` +
        `"${d.printedUnderColumn}", not "${d.column}", in the ${d.row} row. ` +
        `It was recorded here as ${d.quantity}.`
      )
    case 'value-not-printed':
      return (
        `A second reading of this table did not find ${d.stored} at ${place}` +
        `${d.printed === null ? '' : `; it read ${d.printed} there`}. ` +
        `It was recorded as ${d.quantity}.`
      )
    case 'value-not-stored':
      return (
        `A second reading of this table found ${d.printed} printed at ${place} ` +
        `for ${d.quantity}, and nothing was recorded for it.`
      )
  }
}
