// Capture what a REAL model produced over the corpus, so it can be shipped.
//
//   npm run corpus:export        # after `npm run corpus:process`
//
// Writes `scripts/data/ke07-analyses.json`, which `src/main/db/seed.ts` loads
// and inserts with `run_origin = 'shipped'`.
//
// WHAT THIS IS, PRECISELY.
//
// A recording of one genuine run: every fact, quote, measurement, fold and
// citation role below was produced by a named model reading the actual PDFs
// through the actual pipeline. It is not a fixture that imitates model output —
// it IS model output, serialised.
//
// The distinction from the replay cache this project just deleted is not the
// file format, it is what the data is allowed to claim. The old cache let a
// LOOKUP stand in for an inference at request time, so a run could be
// manufactured on demand for a paper nothing had read, and the resulting
// `analysis_run` was indistinguishable from a real one. This ships the OUTPUT of
// an inference that actually happened, carries the model that made it, and is
// marked `shipped` in the database so no reader can mistake it for something
// their own machine computed.
//
// The export deliberately keeps `model`, `provider`, `prompt_version`,
// `schema_version` and `run_timestamp` exactly as recorded. Rewriting any of
// them — to a nicer model name, or to the seed's fixed clock — would make the
// provenance describe a run that never took place.

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { openDatabaseReadOnly, type DB } from '../src/main/db/connection'
import { defaultDbPath } from '../src/main/db/paths'

export const DATASET_PATH = join(__dirname, 'data', 'ke07-analyses.json')

export interface ShippedDataset {
  /** Bumped when the SHAPE changes, so a stale file fails loudly on load. */
  format: 1
  /** Free text for a human opening the file, never parsed. */
  about: string
  generated_at: string
  models: string[]
  runs: ShippedRun[]
  /** Citation roles, keyed by the edge + occurrence they belong to. */
  citation_roles: ShippedRole[]
}

export interface ShippedRun {
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
  evidence: ShippedEvidence[]
  facts: ShippedFact[]
}

export interface ShippedEvidence {
  /** Index into the run's own `evidence` array, for facts to point at. */
  idx: number
  document_id: number | null
  page: number | null
  section: string | null
  paragraph: number | null
  sentence: number | null
  quote: string | null
  verbatim: number
}

export interface ShippedFact {
  evidence_idx: number | null
  kind: string
  predicate: string
  subject: string | null
  object: string | null
  value_text: string | null
  /** Which schema field the fact answers — the binding site since v41. */
  field_id: number | null
  measurements: ShippedMeasurement[]
}

export interface ShippedMeasurement {
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

export interface ShippedRole {
  citing_work_id: number
  ordinal: number | null
  callout_offset: number | null
  occurrence_kind: string
  role: string
  role_source: string
  role_cue: string | null
}

function exportAnalyses(db: DB): ShippedDataset {
  // Only what was explicitly marked for shipping.
  //
  // `corpus:process` leaves its runs `run_origin = 'local'` unless it is asked
  // for the export (`--ship`), because the same driver is also how a real
  // machine finishes its OWN corpus. Exporting every run regardless would sweep
  // that user's analyses into the dataset the app ships to everyone, and would
  // publish rows nobody decided to publish. The filter makes the decision
  // visible in the query: a row ships because someone said `--ship`.
  const runRows = db
    .prepare(
      `SELECT * FROM analysis_run
        WHERE provider != 'pagination-fixture'
          AND run_origin = 'shipped'
        ORDER BY work_id, project_id, analysis_type, id`
    )
    .all() as Array<Record<string, unknown>>
  if (runRows.length === 0) {
    const local = (
      db.prepare(`SELECT COUNT(*) AS c FROM analysis_run WHERE run_origin = 'local'`).get() as {
        c: number
      }
    ).c
    throw new Error(
      local > 0
        ? `no analysis is marked for shipping, but ${local} local run(s) exist — ` +
          're-run `npm run corpus:process -- --ship` to stamp them'
        : 'no analysis is marked for shipping — run `npm run corpus:process -- --ship` first'
    )
  }

  const runs: ShippedRun[] = runRows.map((r) => {
    const runId = r.id as number
    const evRows = db
      .prepare(
        `SELECT id, document_id, page, section, paragraph, sentence, quote, verbatim
           FROM evidence_span WHERE analysis_run_id = ? ORDER BY id`
      )
      .all(runId) as Array<Record<string, unknown>>
    const evIdxById = new Map<number, number>()
    const evidence: ShippedEvidence[] = evRows.map((e, i) => {
      evIdxById.set(e.id as number, i)
      return {
        idx: i,
        document_id: (e.document_id as number) ?? null,
        page: (e.page as number) ?? null,
        section: (e.section as string) ?? null,
        paragraph: (e.paragraph as number) ?? null,
        sentence: (e.sentence as number) ?? null,
        quote: (e.quote as string) ?? null,
        verbatim: (e.verbatim as number) ?? 0
      }
    })

    const factRows = db
      .prepare(
        `SELECT id, evidence_span_id, kind, predicate, subject, object, value_text, field_id
           FROM fact WHERE analysis_run_id = ? ORDER BY id`
      )
      .all(runId) as Array<Record<string, unknown>>

    const facts: ShippedFact[] = factRows.map((f) => {
      const measRows = db
        .prepare(
          `SELECT id, field_id, quantity, value_num, value_text, unit, error_num, conditions
             FROM measurement WHERE fact_id = ? ORDER BY id`
        )
        .all(f.id as number) as Array<Record<string, unknown>>
      const measurements: ShippedMeasurement[] = measRows.map((m) => {
        const fold = db
          .prepare(
            `SELECT baseline_label, improved_label, fold, comparability
               FROM fold_improvement WHERE measurement_id = ? ORDER BY id LIMIT 1`
          )
          .get(m.id as number) as Record<string, unknown> | undefined
        return {
          field_id: (m.field_id as number) ?? null,
          quantity: (m.quantity as string) ?? null,
          value_num: (m.value_num as number) ?? null,
          value_text: (m.value_text as string) ?? null,
          unit: (m.unit as string) ?? null,
          error_num: (m.error_num as number) ?? null,
          conditions: (m.conditions as string) ?? null,
          fold: fold
            ? {
                baseline_label: (fold.baseline_label as string) ?? null,
                improved_label: (fold.improved_label as string) ?? null,
                fold: (fold.fold as number) ?? null,
                comparability: (fold.comparability as string) ?? 'unclear'
              }
            : null
        }
      })
      const evId = f.evidence_span_id as number | null
      return {
        evidence_idx: evId != null ? (evIdxById.get(evId) ?? null) : null,
        kind: f.kind as string,
        predicate: f.predicate as string,
        subject: (f.subject as string) ?? null,
        object: (f.object as string) ?? null,
        value_text: (f.value_text as string) ?? null,
        field_id: (f.field_id as number) ?? null,
        measurements
      }
    })

    return {
      work_id: r.work_id as number,
      project_id: r.project_id as number,
      analysis_type: r.analysis_type as string,
      schema_id: (r.schema_id as number) ?? 0,
      model: r.model as string,
      provider: r.provider as string,
      prompt_version: r.prompt_version as string,
      schema_version: r.schema_version as string,
      run_timestamp: r.run_timestamp as string,
      verifier_result: (r.verifier_result as string) ?? null,
      supplied_project_context: (r.supplied_project_context as string) ?? null,
      superseded: (r.superseded as number) ?? 0,
      doc_input_hash: (r.doc_input_hash as string) ?? null,
      prompt_input_hash: (r.prompt_input_hash as string) ?? null,
      schema_input_hash: (r.schema_input_hash as string) ?? null,
      dossier_input_hash: (r.dossier_input_hash as string) ?? null,
      evidence,
      facts
    }
  })

  // Roles only. The CONTEXT rows themselves (the sentence, its offset) are
  // rebuilt by the citation-contexts stage from the PDFs, and are keyed here by
  // what identifies an occurrence rather than by row id, which does not survive
  // a reseed.
  const citation_roles = db
    .prepare(
      `SELECT citing_work_id, ordinal, callout_offset, occurrence_kind,
              role, role_source, role_cue
         FROM citation_context
        WHERE role IS NOT NULL
        ORDER BY citing_work_id, ordinal, callout_offset`
    )
    .all() as ShippedRole[]

  const models = [...new Set(runs.map((r) => r.model))].sort()

  return {
    format: 1,
    about:
      'Output of a real pipeline run over the KE07 corpus. Every fact, quote, ' +
      'measurement and citation role here was produced by the model named on its ' +
      'run, reading the actual PDFs. Loaded by the seed with run_origin = ' +
      "'shipped' so it is never presented as something the local machine computed.",
    generated_at: new Date().toISOString(),
    models,
    runs,
    citation_roles
  }
}

function main(): void {
  const dbPath = process.env.CORPUS_DB_PATH ?? defaultDbPath()
  const db = openDatabaseReadOnly(dbPath)
  const dataset = exportAnalyses(db)
  if (dataset.runs.length === 0) {
    throw new Error(
      `${dbPath} contains no analyses to export — run \`npm run corpus:process\` first`
    )
  }
  mkdirSync(dirname(DATASET_PATH), { recursive: true })
  writeFileSync(DATASET_PATH, `${JSON.stringify(dataset, null, 2)}\n`)
  const facts = dataset.runs.reduce((n, r) => n + r.facts.length, 0)
  const meas = dataset.runs.reduce(
    (n, r) => n + r.facts.reduce((m, f) => m + f.measurements.length, 0),
    0
  )
  // eslint-disable-next-line no-console
  console.log(
    `[export] ${dataset.runs.length} run(s), ${facts} fact(s), ${meas} measurement(s), ` +
      `${dataset.citation_roles.length} role(s) by ${dataset.models.join(', ')} -> ${DATASET_PATH}`
  )
}

if (require.main === module) main()
