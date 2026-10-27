// When a paper's own columns settle a question, arithmetic answers it.
//
// WHY THIS FILE EXISTS. A table that prints A, B and a third column C computed
// from them carries its own proof. If C is not A/B but is off by a clean factor
// of ten — the same factor, in every row — then one of the three columns is
// stored at the wrong scale, and that is a statement about THREE NUMBERS THIS
// DATABASE HOLDS. It needs no reading of the paper, no convention of the field,
// and no other work in the library to compare against, so it cannot be a false
// positive about a paper nobody read.
//
// It matters because the alternative evidence is weaker than it looks. A column
// header states the prefix, and a prefix is exactly the character a PDF text
// layer destroys most reliably: `µM` reaches the extractor as `mM`, the header
// then says `mM`, and a reader — human or model — who trusts the header clears a
// thousandfold error while the row's own arithmetic disproves it. Arithmetic
// beats a header the text layer may have damaged.
//
// THE RELATION IS DISCOVERED, NEVER DECLARED. Nothing here knows which fields of
// which schema are related; it tries every ordered triple of numeric fields and
// keeps only those where the ratio C/(A/B) lands on the SAME power of ten in
// record after record. Values that are unrelated do not do that: a coincidence
// is one row, a relation is every row. So this stays domain-neutral — it learns
// the arithmetic of the user's own schema from the user's own records.
//
// A GAP IS NOT AN ACCUSATION OF ONE COLUMN. Which of the three is at fault is
// not decidable here, and this file never says. It reports that the three
// together cannot all be right, and by what factor.

import { canonicalUnit } from './units'

/** One record's numeric values, by field, already reduced to canonical units. */
export interface DerivedRecord {
  /** What ties these values together — normally the subject of the claim. */
  key: string
  /** field id → canonical value, and the measurement that carried it. */
  values: Map<number, { value: number; measurementId: number; factId: number; unit: string | null }>
}

/**
 * A relation C ≈ A/B that this run's own rows obey, up to a factor of ten.
 *
 * `decades` is the exponent, and it is never 0 — a relation that holds exactly
 * is the ordinary case and says nothing (HARD RULE 0.6).
 */
export interface DerivedGap {
  numeratorField: number
  denominatorField: number
  resultField: number
  /** log10 of C ÷ (A/B), rounded to the integer every row agreed on. */
  decades: number
  /** How many records agreed. */
  records: number
  /** A representative row, so a verdict can name a measurement. */
  sampleFactId: number
  sampleMeasurementId: number
  /** The rows, for the note: [A, B, C] as stored. */
  sample: { a: number; b: number; c: number; key: string }
}

/** How far a row's ratio may sit from the shared exponent and still count. */
const RATIO_TOLERANCE_DECADES = 0.05
/**
 * How many agreeing rows make a relation.
 *
 * Three numbers can line up by accident once, and twice is not much better. Four
 * rows all landing within 12% of the same power of ten is not a coincidence any
 * unrelated triple of columns produces.
 */
const MIN_RELATION_RECORDS = 4
/** Beyond this the "clean power of ten" reading is not the simplest explanation. */
const MAX_DECADES = 9

/**
 * Every derived-column relation this set of records obeys only up to a factor of
 * ten.
 *
 * Read-only and pure. Returns nothing for records that are internally consistent
 * — which is the normal outcome and the one worth no words.
 */
export function derivedColumnGaps(records: readonly DerivedRecord[]): DerivedGap[] {
  const fields = [...new Set(records.flatMap((r) => [...r.values.keys()]))].sort((a, b) => a - b)
  if (fields.length < 3) return []

  const out: DerivedGap[] = []
  for (const num of fields) {
    for (const den of fields) {
      if (den === num) continue
      for (const res of fields) {
        if (res === num || res === den) continue
        const logs: number[] = []
        let sampleFactId = 0
        let sampleMeasurementId = 0
        let sample: DerivedGap['sample'] | null = null
        for (const r of records) {
          const a = r.values.get(num)
          const b = r.values.get(den)
          const c = r.values.get(res)
          if (!a || !b || !c) continue
          if (a.value === 0 || b.value === 0 || c.value === 0) continue
          const expected = a.value / b.value
          if (!Number.isFinite(expected) || expected === 0) continue
          const ratio = c.value / expected
          if (!Number.isFinite(ratio) || ratio <= 0) continue
          logs.push(Math.log10(ratio))
          if (sample === null) {
            sampleFactId = c.factId
            sampleMeasurementId = c.measurementId
            sample = { a: a.value, b: b.value, c: c.value, key: r.key }
          }
        }
        if (logs.length < MIN_RELATION_RECORDS || sample === null) continue
        // EVERY row must agree, not most of them. A relation that holds in
        // eleven rows and not in the twelfth is not arithmetic the table is
        // doing — it is a pattern with an exception, and an exception is exactly
        // where a mechanical claim goes wrong.
        const decades = Math.round(logs[0])
        if (decades === 0 || Math.abs(decades) > MAX_DECADES) continue
        if (logs.some((l) => Math.abs(l - decades) > RATIO_TOLERANCE_DECADES)) continue
        out.push({
          numeratorField: num,
          denominatorField: den,
          resultField: res,
          decades,
          records: logs.length,
          sampleFactId,
          sampleMeasurementId,
          sample
        })
      }
    }
  }

  // The same three columns are related one way round; A/B and B/A both fitting
  // would report one finding twice with opposite signs. Keep the first — they
  // name the same rows and carry the same factor.
  const seen = new Set<string>()
  return out.filter((g) => {
    const k = [g.numeratorField, g.denominatorField, g.resultField].sort((a, b) => a - b).join(':')
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/**
 * Group a run's numeric measurements into records, in canonical units.
 *
 * Grouped by SUBJECT, because a derived column is computed row by row and a row
 * is one subject. A measurement whose unit this build cannot reduce is left out:
 * comparing an unreduced value against a reduced one would invent a factor.
 */
export function toDerivedRecords(
  rows: ReadonlyArray<{
    id: number
    fact_id: number
    field_id: number | null
    value_num: number | null
    unit: string | null
    subject: string | null
    data_type: string | null
  }>
): DerivedRecord[] {
  const byKey = new Map<string, DerivedRecord>()
  for (const m of rows) {
    if (m.field_id === null || m.value_num === null) continue
    if (m.data_type !== null && m.data_type !== 'number') continue
    const c = canonicalUnit(m.unit)
    if (!c.recognised) continue
    // An offset unit is not a scale, so a ratio of two of them is not a ratio of
    // the quantities. Only proportional units may take part in arithmetic.
    if (c.offset !== 0) continue
    const key = (m.subject ?? '').trim().toLowerCase()
    if (key === '') continue
    let rec = byKey.get(key)
    if (rec === undefined) {
      rec = { key, values: new Map() }
      byKey.set(key, rec)
    }
    // The FIRST value for a field wins: a subject with two rows for one column
    // is a repeat, and picking between them is a judgement this file does not make.
    if (rec.values.has(m.field_id)) continue
    rec.values.set(m.field_id, {
      value: m.value_num * c.scale,
      measurementId: m.id,
      factId: m.fact_id,
      unit: m.unit
    })
  }
  return [...byKey.values()]
}
