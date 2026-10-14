// Load the analyses a real model produced, and insert them as SHIPPED.
//
// The companion to `scripts/export-analyses.ts`. Everything inserted here came
// out of one genuine pipeline run against a real gateway — see that file for why
// that is categorically different from the replay cache this project removed.
//
// TWO INVARIANTS THIS FILE EXISTS TO HOLD.
//
// 1. `run_origin = 'shipped'` on EVERY row it writes, with an `origin_note`
//    naming the model and the date. There is no code path here that can write
//    'local'. A user must never look at an analysis and wrongly believe their
//    machine produced it — nor the reverse, which is why the pipeline's own
//    inserts default to 'local' and are never touched from here.
//
// 2. Provenance is copied VERBATIM. The model, provider, prompt and schema
//    versions, the input hashes and the original `run_timestamp` are inserted
//    exactly as recorded. Restamping any of them to the seed's fixed clock would
//    make the record describe a run that did not happen, and would break the
//    freshness comparison, which is a hash equality against those very fields.

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DB } from './connection'
import { canonicaliseMeasurement } from '../llm/units'

/** Mirrors `ShippedDataset` in scripts/export-analyses.ts. */
interface Dataset {
  format: number
  generated_at: string
  models: string[]
  runs: Run[]
  citation_roles: Role[]
}
interface Run {
  work_id: number
  project_id: number
  analysis_type: string
  schema_id: number
  model: string
  provider: string
  prompt_version: string
  schema_version: string
  run_timestamp: string
  verifier_result: string | null
  supplied_project_context: string | null
  superseded: number
  doc_input_hash: string | null
  prompt_input_hash: string | null
  schema_input_hash: string | null
  dossier_input_hash: string | null
  evidence: Evidence[]
  facts: Fact[]
}
interface Evidence {
  idx: number
  document_id: number | null
  page: number | null
  section: string | null
  paragraph: number | null
  sentence: number | null
  quote: string | null
  verbatim: number
}
interface Fact {
  evidence_idx: number | null
  kind: string
  predicate: string
  subject: string | null
  object: string | null
  value_text: string | null
  /**
   * Which schema field the fact answers — the binding site since v41.
   *
   * Optional in the TYPE because a shipped dataset exported before v41 has no
   * such key, and reading `undefined` as "no field" is exactly what it means.
   */
  field_id?: number | null
  measurements: Measurement[]
}
interface Measurement {
  field_id: number | null
  quantity: string | null
  value_num: number | null
  value_text: string | null
  unit: string | null
  error_num: number | null
  conditions: string | null
  fold: {
    baseline_label: string | null
    improved_label: string | null
    fold: number | null
    comparability: string
  } | null
}
interface Role {
  citing_work_id: number
  ordinal: number | null
  callout_offset: number | null
  occurrence_kind: string
  role: string
  role_source: string
  role_cue: string | null
}

/**
 * Where the dataset lives. Only ever inside a repo checkout: this is a dev/test
 * fixture read by the seed, and no install carries it.
 */
function datasetPath(): string | null {
  const candidates = [
    join(__dirname, '..', '..', '..', 'scripts', 'data', 'ke07-analyses.json'),
    join(process.cwd(), 'scripts', 'data', 'ke07-analyses.json')
  ]
  for (const p of candidates) {
    if (p && existsSync(p)) return p
  }
  return null
}

export interface ShippedLoadResult {
  runs: number
  facts: number
  measurements: number
  roles: number
  models: string[]
}

/**
 * Insert the shipped analyses. Returns null when no dataset is present, which
 * is a legitimate state — a checkout that has not run `corpus:process` yet has
 * a corpus and no analyses, and the app renders that correctly.
 *
 * Caller must already be inside the seed transaction.
 */
export function loadShippedAnalyses(db: DB, now: string): ShippedLoadResult | null {
  const path = datasetPath()
  if (!path) return null
  const data = JSON.parse(readFileSync(path, 'utf8')) as Dataset
  if (data.format !== 1) {
    throw new Error(
      `shipped analyses at ${path} declare format ${data.format}, which this build does not read`
    )
  }
  if (data.runs.length === 0) return null

  const note =
    `Precomputed with ${data.models.join(', ')} on ${data.generated_at.slice(0, 10)} ` +
    `and distributed with the app.`

  const insRun = db.prepare(
    `INSERT INTO analysis_run
       (work_id, project_id, analysis_type, schema_id, model, provider, prompt_version,
        schema_version, run_timestamp, verifier_result, deterministic_validation,
        supplied_project_context, superseded, doc_input_hash, prompt_input_hash,
        schema_input_hash, dossier_input_hash, run_origin, origin_note, created_at)
     -- deterministic_validation 0: the checks are re-run below over the rows as
     -- they land here, so this starts at 0 rather than importing a verdict about
     -- rows in a different database.
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 'shipped', ?, ?)`
  )
  const insEv = db.prepare(
    `INSERT INTO evidence_span
       (analysis_run_id, document_id, page, section, paragraph, sentence, quote, verbatim, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const insFact = db.prepare(
    `INSERT INTO fact
       (analysis_run_id, evidence_span_id, kind, predicate, subject, object, value_text,
        field_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const insMeas = db.prepare(
    `INSERT INTO measurement
       (fact_id, field_id, quantity, value_num, value_text, unit, error_num, conditions,
        unit_canonical, value_canonical, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const insFold = db.prepare(
    `INSERT INTO fold_improvement
       (measurement_id, baseline_label, improved_label, fold, comparability, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )

  const known = new Set(
    (db.prepare('SELECT id FROM work').all() as Array<{ id: number }>).map((w) => w.id)
  )

  let facts = 0
  let measurements = 0
  let runs = 0
  for (const r of data.runs) {
    // A run naming a work this seed did not create is DROPPED, not repaired.
    // The dataset and the corpus can drift (a paper removed from
    // ke07-corpus.json), and attaching the analysis to a neighbouring id would
    // put one paper's findings on another's screen.
    if (!known.has(r.work_id)) continue
    const runId = Number(
      insRun.run(
        r.work_id,
        r.project_id,
        r.analysis_type,
        r.schema_id,
        r.model,
        r.provider,
        r.prompt_version,
        r.schema_version,
        r.run_timestamp,
        r.verifier_result,
        r.supplied_project_context,
        r.superseded,
        r.doc_input_hash,
        r.prompt_input_hash,
        r.schema_input_hash,
        r.dossier_input_hash,
        note,
        now
      ).lastInsertRowid
    )
    runs++

    const evIds: number[] = []
    for (const e of r.evidence) {
      evIds.push(
        Number(
          insEv.run(
            runId,
            e.document_id,
            e.page,
            e.section,
            e.paragraph,
            e.sentence,
            e.quote,
            e.verbatim,
            now
          ).lastInsertRowid
        )
      )
    }
    for (const f of r.facts) {
      const evId = f.evidence_idx != null ? (evIds[f.evidence_idx] ?? null) : null
      const factId = Number(
        insFact.run(
          runId,
          evId,
          f.kind,
          f.predicate,
          f.subject,
          f.object,
          f.value_text,
          f.field_id ?? null,
          now
        ).lastInsertRowid
      )
      facts++
      for (const m of f.measurements) {
        const canon = canonicaliseMeasurement(m.value_num, m.unit)
        const measId = Number(
          insMeas.run(
            factId,
            m.field_id,
            m.quantity,
            m.value_num,
            m.value_text,
            m.unit,
            m.error_num,
            m.conditions,
            canon.unit,
            canon.value,
            now
          ).lastInsertRowid
        )
        measurements++
        if (m.fold) {
          insFold.run(
            measId,
            m.fold.baseline_label,
            m.fold.improved_label,
            m.fold.fold,
            m.fold.comparability,
            now
          )
        }
      }
    }
  }

  // ---- citation roles ------------------------------------------------------
  //
  // Matched to the context rows the seed just created, by the identity of the
  // OCCURRENCE (citing work + ordinal + callout offset) rather than by row id,
  // which does not survive a reseed.
  //
  // In practice this matches NOTHING on a fresh seed, and that is correct rather
  // than a gap to be closed. Every role a model assigns belongs to an INLINE
  // occurrence — a specific sentence at a specific character offset in a
  // specific PDF — and the seed creates only bibliography rows, because the
  // sentence around a callout cannot be derived from corpus metadata. It is
  // found by the `citation-contexts` stage scanning the document's own text.
  //
  // Attaching these roles to bibliography rows instead, or synthesising inline
  // rows to receive them, would put a model's judgement about a sentence onto a
  // row that is not that sentence. So an unmatched role is DROPPED, the roles
  // appear once the stage has run, and until then the popover says the callouts
  // are unclassified — which is true of a corpus whose citations nobody has
  // read yet.
  const updRole = db.prepare(
    `UPDATE citation_context
        SET role = ?, role_source = ?, role_cue = ?
      WHERE citing_work_id = ?
        AND ordinal IS ?
        AND callout_offset IS ?
        AND occurrence_kind = ?`
  )
  let roles = 0
  for (const role of data.citation_roles) {
    const res = updRole.run(
      role.role,
      role.role_source,
      role.role_cue,
      role.citing_work_id,
      role.ordinal,
      role.callout_offset,
      role.occurrence_kind
    )
    roles += res.changes
  }

  return { runs, facts, measurements, roles, models: data.models }
}
