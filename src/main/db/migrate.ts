import type { Database } from 'better-sqlite3'
import type { DB } from './connection'
import {
  SCHEMA_V1,
  SCHEMA_V2,
  SCHEMA_V3,
  SCHEMA_V4,
  SCHEMA_V5_PRE,
  SCHEMA_V5_POST,
  SCHEMA_V6,
  SCHEMA_V7,
  SCHEMA_V9,
  SCHEMA_V10,
  SCHEMA_V14_STAGE_RUN,
  SCHEMA_V14_JOB_TABLE,
  SCHEMA_V14_JOB_INDEXES,
  SCHEMA_V15,
  SCHEMA_V16,
  SCHEMA_V17_TABLE,
  SCHEMA_V17_INDEXES,
  SCHEMA_V18_TEXT_SOURCE,
  SCHEMA_V18_EMBEDDING,
  SCHEMA_V20_DROP_MOCK,
  SCHEMA_V20_RUN_ORIGIN,
  SCHEMA_V25_CITATION_LINK,
  SCHEMA_V26_WORK_SUMMARY,
  SCHEMA_V27_SUMMARY_DOCUMENT,
  SCHEMA_V28_TEXT_INDEXES,
  SCHEMA_V29_FIELD_PROVENANCE,
  SCHEMA_V30_CANONICAL_UNITS,
  SCHEMA_V31_MARKER_IN_SENTENCE,
  SCHEMA_V33_CHECK_PROVENANCE,
  SCHEMA_V35_CANONICAL_TRIGGERS,
  SCHEMA_V37_LINK_CARRYOVER,
  SCHEMA_V40_CITATION_CONTEXT,
  SCHEMA_V40_CITATION_LINK,
  SCHEMA_V41_FACT_FIELD,
  SCHEMA_V42_PROJECT_SUMMARY_PROMPT,
  SCHEMA_V43_SYNC_IDENTITY,
  SCHEMA_V44_TRIGGERS,
  SCHEMA_V44_UPDATED_AT,
  SCHEMA_V47_TOKEN_USAGE,
  SCHEMA_V48_CACHE_TOKENS,
  SCHEMA_V49_FACT,
  SCHEMA_V52_FACT_RETRACTION,
  SCHEMA_V59_REFERENCE_ABSTRACT,
  SCHEMA_V60_REFERENCE_ABSTRACT,
  SCHEMA_V61_REFERENCE_ABSTRACT,
  SCHEMA_V62_REFERENCE_ABSTRACT_ASK_KEY,
  SCHEMA_V63_PROJECT_WORK_SCORED_ON,
  SCHEMA_V65_REFERENCE_ABSTRACT_RELEVANCE,
  SCHEMA_V69_INDEX_TITLE,

  SYNC_TOUCHED_TABLES
} from './schema'
import { canonicaliseMeasurement } from '../llm/units'
// `repositories` reaches back to `connection`, which imports this module — a
// cycle that resolves because the only use is inside a migration body, long
// after both modules have finished evaluating.
import { composeProjectDescription } from './repositories'
import { backfillSchemaHashes } from './schemaHash'
import { mkdirSync } from 'node:fs'
import { MANAGED_STORAGE_LABEL, storageRootPath } from './paths'

export interface Migration {
  version: number
  up: (db: Database, ctx: MigrationCtx) => void
}

/**
 * What a step can know about the RUN it is part of, as opposed to the database.
 *
 * There is exactly one such fact and it is not derivable inside the step: by the
 * time a migration runs, `user_version` has been advanced by every step before
 * it, so nothing in the file distinguishes "this database existed and is being
 * brought forward" from "this database was created a moment ago and every step
 * is running at once".
 *
 * That distinction decides whether a step may adopt a DEFAULT on the user's
 * behalf. Carrying a working install across an upgrade means preserving what it
 * was already doing; a fresh install must start empty and consent to everything
 * (root `CLAUDE.md`). A step that cannot tell them apart turns the first into
 * the second's opposite — it switches something on for a scientist who has just
 * installed the app and asked for nothing.
 */
export interface MigrationCtx {
  /** True when this database existed before this run — i.e. an UPGRADE, not a first launch. */
  upgrade: boolean
}

/** Ordered migration steps. Each wrapped in a transaction by the runner. */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(SCHEMA_V1)
    }
  },
  {
    // v2: project.category + project.tags for the dashboard cards (design). Both
    // nullable so existing v1 rows migrate cleanly; the seed populates real
    // values. ADD COLUMN is idempotent under the version guard.
    version: 2,
    up: (db) => {
      db.exec(SCHEMA_V2)
    }
  },
  {
    // v3: `setting` (key/value) + `llm_model` (selectable analysis models). App
    // config that MUST live in the DB (seed-only-DB rule) rather than a
    // hardcoded array in the renderer. Additive tables; the seed inserts the
    // model rows + the default selected_model_id.
    version: 3,
    up: (db) => {
      db.exec(SCHEMA_V3)
    }
  },
  {
    // v4: `extraction_schema` + `extraction_field` (first-class, user-editable
    // definitions of WHAT to extract) + `measurement.field_id` linking each
    // extracted value to the field it fills. Schemas are DB rows the user owns,
    // so the Extraction surface and the exports are schema-driven rather than
    // specific to any one field of science.
    // Purely additive; the new measurement column is nullable so existing rows
    // migrate with no backfill and foreign_key_check passes trivially.
    version: 4,
    up: (db) => {
      db.exec(SCHEMA_V4)
    }
  },
  {
    // v5: schemas become GLOBAL (key unique app-wide; project_id kept as a
    // constant-0 vestige rather than rebuilt away) and `project_schema` records
    // which schemas each project applies in its Extraction view.
    //
    // The de-dup and the attachment backfill live HERE rather than in the SQL
    // constant because both need care that a single statement cannot express.
    version: 5,
    up: (db) => {
      // Snapshot the ORIGINAL owner of every schema before anything is rewritten
      // — the backfill below needs it, and the flattening destroys it.
      const owners = db
        .prepare('SELECT id, project_id FROM extraction_schema')
        .all() as { id: number; project_id: number }[]

      db.exec(SCHEMA_V5_PRE)

      // De-duplicate schema keys before the GLOBAL unique index goes on. v4
      // scoped keys per project, so two projects may legitimately hold the same
      // key.
      //
      // Done in JS rather than as one UPDATE because the obvious
      // `key || '-dup' || id` can itself collide with a row that literally holds
      // that name; that would abort the transaction and leave the DB stuck at v4
      // — permanently unopenable. Here the suffix is re-applied until the key is
      // unique across the WHOLE table. Deterministic: rows are processed in id
      // order and the lowest id for a key always keeps the original.
      const rows = db
        .prepare('SELECT id, key FROM extraction_schema ORDER BY id ASC')
        .all() as { id: number; key: string }[]
      const taken = new Set<string>()
      const rename = db.prepare('UPDATE extraction_schema SET key = ? WHERE id = ?')
      for (const r of rows) {
        if (!taken.has(r.key)) {
          taken.add(r.key)
          continue
        }
        let candidate = `${r.key}-dup${r.id}`
        while (taken.has(candidate)) candidate = `${candidate}-dup${r.id}`
        rename.run(candidate, r.id)
        taken.add(candidate)
      }

      db.exec(SCHEMA_V5_POST)

      // Backfill the attachments so an upgraded DB renders EXACTLY what it did
      // before. v4's `listExtractionSchemas` showed a project its OWN schemas
      // PLUS the global (project_id = 0) ones — that predicate, not a blind
      // cross join, is what must be reproduced. A cross join would silently hand
      // every project every other project's private schemas.
      //
      // Deterministic: projects and schemas are both iterated in id order, and
      // `created_at` is copied from the schema row so no clock value enters here.
      const projects = db.prepare('SELECT id FROM project ORDER BY id ASC').all() as {
        id: number
      }[]
      const created = new Map(
        (
          db.prepare('SELECT id, created_at FROM extraction_schema').all() as {
            id: number
            created_at: string
          }[]
        ).map((r) => [r.id, r.created_at])
      )
      const attach = db.prepare(
        `INSERT INTO project_schema (project_id, schema_id, sort_order, created_at)
         VALUES (?, ?, ?, ?)`
      )
      const ownedOrGlobal = owners
        .filter((o) => o.project_id === 0 || projects.some((p) => p.id === o.project_id))
        .sort((a, b) => a.id - b.id)
      for (const p of projects) {
        for (const o of ownedOrGlobal) {
          if (o.project_id !== 0 && o.project_id !== p.id) continue
          attach.run(p.id, o.id, o.id, created.get(o.id) ?? '')
        }
      }
    }
  },
  {
    // v6: `fact_verdict` — the human review verdict the Review screen previously
    // had no way to record. Purely additive (one new table + two indexes, no
    // column added to and no row touched in any existing table), so an upgraded
    // DB renders EXACTLY what it did before until a reviewer records something.
    // See the long rationale on SCHEMA_V6 in schema.ts.
    version: 6,
    up: (db) => {
      db.exec(SCHEMA_V6)
    }
  },
  {
    // Adds evidence_span.verbatim: was the stored quote actually FOUND in the
    // document, or merely asserted by the model? One added column with a
    // DEFAULT, so every existing row keeps its data and reads as "not
    // verified" — which is the truth about quotes that were never checked.
    // See the rationale on SCHEMA_V7 in schema.ts.
    version: 7,
    up: (db) => {
      // A FRESH database already has `verbatim`: it is part of the base
      // evidence_span DDL, and the runner still walks every version to stamp
      // user_version. Only an OLD database needs the ALTER, so re-adding it
      // blindly aborts a first-ever seed with "duplicate column name".
      const hasVerbatim = (
        db.pragma('table_info(evidence_span)') as Array<{ name: string }>
      ).some((c) => c.name === 'verbatim')
      if (!hasVerbatim) db.exec(SCHEMA_V7)
    }
  },
  {
    // Content-derived schema identity: extraction_field.param_hash + dropping
    // extraction_schema.domain. See the rationale on SCHEMA_V8 in schema.ts.
    version: 8,
    up: (db) => {
      const cols = (t: string): string[] =>
        (db.pragma(`table_info(${t})`) as Array<{ name: string }>).map((c) => c.name)
      if (!cols('extraction_field').includes('param_hash')) {
        db.exec(`ALTER TABLE extraction_field ADD COLUMN param_hash TEXT NOT NULL DEFAULT ''`)
      }
      if (cols('extraction_schema').includes('domain')) {
        db.exec(`ALTER TABLE extraction_schema DROP COLUMN domain`)
      }
      if (!cols('processing_job').includes('dismissed')) {
        db.exec(
          `ALTER TABLE processing_job
             ADD COLUMN dismissed INTEGER NOT NULL DEFAULT 0 CHECK (dismissed IN (0,1))`
        )
      }
      // Back-fill the hashes so an upgraded DB is immediately consistent with a
      // freshly-seeded one; then recompute every schema's version from them.
      backfillSchemaHashes(db)
    }
  },
  {
    // v9: `analysis_check` — per-run results of the real deterministic checks.
    // Purely additive (one table + two indexes). Existing runs get no rows,
    // which is the honest state: no check was ever performed on them, and
    // fabricating retroactive verdicts would be exactly the false guarantee
    // this table exists to remove.
    version: 9,
    up: (db) => {
      db.exec(SCHEMA_V9)
    }
  },
  {
    // v10: `project_work.is_reference` — the reference-paper mark gets its own
    // column instead of overloading project_role. See the rationale on
    // SCHEMA_V10 in schema.ts. Guarded like v7/v8: a fresh DB built by an older
    // SCHEMA_V1 may already be at this shape in a future consolidation, and
    // re-running ADD COLUMN would abort the migration with "duplicate column".
    version: 10,
    up: (db) => {
      const cols = (db.pragma('table_info(project_work)') as Array<{ name: string }>).map(
        (c) => c.name
      )
      if (!cols.includes('is_reference')) db.exec(SCHEMA_V10)
    }
  },
  {
    // v11: parsed-citation provenance + the pre-baked parse record. See the
    // rationale on SCHEMA_V11 in schema.ts.
    //
    // Guarded per-statement rather than all-or-nothing: this step adds columns
    // to TWO tables and creates one more, so a half-applied v11 (possible only
    // if a future consolidation folds part of it into SCHEMA_V1) would abort on
    // "duplicate column" and strand the DB. Checking each object independently
    // makes the step idempotent on a fresh DB as well as an upgraded one.
    version: 11,
    up: (db) => {
      const colsOf = (t: string): string[] =>
        (db.pragma(`table_info(${t})`) as Array<{ name: string }>).map((c) => c.name)

      const edge = colsOf('citation_edge')
      if (!edge.includes('source')) {
        db.exec(`ALTER TABLE citation_edge ADD COLUMN source TEXT NOT NULL DEFAULT 'asserted'
                   CHECK (source IN ('asserted','parsed'))`)
        db.exec('CREATE INDEX IF NOT EXISTS ix_citation_edge_source ON citation_edge(source)')
      }
      if (!edge.includes('match_confidence')) {
        db.exec(`ALTER TABLE citation_edge ADD COLUMN match_confidence REAL
                   CHECK (match_confidence IS NULL OR match_confidence BETWEEN 0 AND 1)`)
      }
      if (!edge.includes('match_method')) {
        db.exec(`ALTER TABLE citation_edge ADD COLUMN match_method TEXT
                   CHECK (match_method IS NULL OR match_method IN ('doi','scored'))`)
      }

      const unres = colsOf('unresolved_reference')
      if (!unres.includes('guessed_year')) {
        db.exec('ALTER TABLE unresolved_reference ADD COLUMN guessed_year INTEGER')
      }
      if (!unres.includes('guessed_authors')) {
        db.exec('ALTER TABLE unresolved_reference ADD COLUMN guessed_authors TEXT')
      }
      if (!unres.includes('guessed_venue')) {
        db.exec('ALTER TABLE unresolved_reference ADD COLUMN guessed_venue TEXT')
      }
      if (!unres.includes('ordinal')) {
        db.exec('ALTER TABLE unresolved_reference ADD COLUMN ordinal INTEGER')
      }

      db.exec(`CREATE TABLE IF NOT EXISTS work_citation_parse (
        work_id         INTEGER PRIMARY KEY REFERENCES work(id) ON DELETE CASCADE,
        document_id     INTEGER REFERENCES document(id) ON DELETE SET NULL,
        parser_version  TEXT NOT NULL,
        doc_sha         TEXT,
        corpus_size     INTEGER NOT NULL,
        reference_count INTEGER NOT NULL,
        matched_count   INTEGER NOT NULL,
        section_strategy TEXT NOT NULL,
        entry_style     TEXT NOT NULL,
        no_text_layer   INTEGER NOT NULL DEFAULT 0 CHECK (no_text_layer IN (0,1)),
        parsed_at       TEXT NOT NULL
      )`)
    }
  },
  {
    // v12: retrieval state for an unresolved reference. See SCHEMA_V12.
    //
    // Guarded per-column like v11: the runner must not re-apply a column that a
    // future consolidation may have folded into SCHEMA_V1, which would abort the
    // step with "duplicate column" and strand the DB.
    version: 12,
    up: (db) => {
      const cols = (db.pragma('table_info(unresolved_reference)') as Array<{ name: string }>).map(
        (c) => c.name
      )
      if (!cols.includes('retrieval_status')) {
        db.exec(`ALTER TABLE unresolved_reference ADD COLUMN retrieval_status TEXT NOT NULL
                   DEFAULT 'none'
                   CHECK (retrieval_status IN ('none','retrieving','failed','retrieved'))`)
      }
      if (!cols.includes('retrieval_job_id')) {
        db.exec(`ALTER TABLE unresolved_reference ADD COLUMN retrieval_job_id INTEGER
                   REFERENCES processing_job(id) ON DELETE SET NULL`)
      }
      if (!cols.includes('retrieval_work_id')) {
        db.exec(`ALTER TABLE unresolved_reference ADD COLUMN retrieval_work_id INTEGER
                   REFERENCES work(id) ON DELETE SET NULL`)
      }
      if (!cols.includes('retrieval_error')) {
        db.exec('ALTER TABLE unresolved_reference ADD COLUMN retrieval_error TEXT')
      }
      if (!cols.includes('retrieval_started_at')) {
        db.exec('ALTER TABLE unresolved_reference ADD COLUMN retrieval_started_at TEXT')
      }
      db.exec(
        'CREATE INDEX IF NOT EXISTS ix_unresolved_reference_job ON unresolved_reference(retrieval_job_id)'
      )
    }
  },
  {
    // v13: per-job start/finish stamps so the queue can report a real duration.
    //
    // `created_at` is when the job was ENQUEUED and `updated_at` moves on every
    // write, so neither answers "how long did this take" — a job that waited an
    // hour behind others would report an hour of work. These are written once
    // each: when the scheduler claims the job, and at its terminal write.
    //
    // Guarded per-column like v11/v12, so a later consolidation into SCHEMA_V1
    // cannot make this step abort with "duplicate column".
    version: 13,
    up: (db) => {
      const cols = (db.pragma('table_info(processing_job)') as Array<{ name: string }>).map(
        (c) => c.name
      )
      if (!cols.includes('started_at')) {
        db.exec('ALTER TABLE processing_job ADD COLUMN started_at TEXT')
      }
      if (!cols.includes('finished_at')) {
        db.exec('ALTER TABLE processing_job ADD COLUMN finished_at TEXT')
      }
    }
  },
  {
    // v14: the stage pipeline. `stage_run` + `stage_artifact` + `job_dependency`,
    // and a REBUILD of `processing_job` to drop the `job_type` CHECK (the stage
    // registry is the enum now), widen `status`, and turn `project_id` into a
    // NOT NULL sentinel. See the long rationale on the SCHEMA_V14_* constants.
    //
    // ── The trap this step exists to survive ──────────────────────────────────
    // `DROP TABLE processing_job` fires the implicit `DELETE FROM`, which runs
    // `unresolved_reference`'s `ON DELETE SET NULL` IMMEDIATELY.
    // `PRAGMA defer_foreign_keys` defers VIOLATION CHECKING, not ACTION CLAUSES,
    // so it does not help — and `foreign_key_check` comes back EMPTY afterwards,
    // meaning `runMigrations`' post-assertion passes while every
    // reference-retrieval link has been silently destroyed. Measured on this
    // repo's SQLite 3.49.2: `retrieval_job_id` went 7 -> null with no error.
    //
    // So the column is saved to a TEMP table and restored after the rename, and
    // the step ASSERTS ITS OWN SUCCESS by re-counting. Relying on
    // `foreign_key_check` alone would protect nobody.
    version: 14,
    up: (db) => {
      // Guarded like v7-v13: a fresh DB walks every version, and a future
      // consolidation may fold this shape into SCHEMA_V1.
      const jobCols = (db.pragma('table_info(processing_job)') as Array<{ name: string }>).map(
        (c) => c.name
      )
      if (jobCols.includes('stage')) return

      // Belt-and-braces for the restore UPDATE below; transaction-scoped.
      db.pragma('defer_foreign_keys = ON')

      db.exec(SCHEMA_V14_STAGE_RUN)

      // Snapshot the child links BEFORE anything is dropped, in JS as well as in
      // the TEMP table: the TEMP table performs the restore, the JS copy is what
      // the assertion compares against, and having them independent is the point
      // — an assertion that reads the same row the restore wrote proves nothing.
      const savedLinks = db
        .prepare(
          `SELECT id, retrieval_job_id FROM unresolved_reference
            WHERE retrieval_job_id IS NOT NULL`
        )
        .all() as Array<{ id: number; retrieval_job_id: number }>
      const jobCountBefore = (
        db.prepare('SELECT COUNT(*) AS c FROM processing_job').get() as { c: number }
      ).c

      db.exec(SCHEMA_V14_JOB_TABLE)
      db.exec(
        `INSERT INTO processing_job_new
           (id, job_type, status, work_id, project_id, payload, error, attempts,
            dismissed, created_at, updated_at, started_at, finished_at)
         SELECT id, job_type, status, work_id, COALESCE(project_id, 0), payload,
                error, attempts, dismissed, created_at, updated_at,
                started_at, finished_at
           FROM processing_job`
      )

      db.exec(
        `CREATE TEMP TABLE ur_save AS
           SELECT id, retrieval_job_id FROM unresolved_reference
            WHERE retrieval_job_id IS NOT NULL`
      )

      db.exec('DROP TABLE processing_job')
      // This direction, never the reverse. With `legacy_alter_table` at its
      // modern default (OFF), RENAME rewrites FK clauses in tables that
      // reference the RENAMED name — there are none pointing at
      // `processing_job_new`, and `unresolved_reference`'s existing
      // `REFERENCES processing_job(id)` is left untouched. Renaming old->tmp
      // first would have repointed that clause at the temporary name.
      db.exec('ALTER TABLE processing_job_new RENAME TO processing_job')

      db.exec(
        `UPDATE unresolved_reference
            SET retrieval_job_id = (SELECT s.retrieval_job_id FROM ur_save s
                                     WHERE s.id = unresolved_reference.id)
          WHERE id IN (SELECT id FROM ur_save)`
      )
      db.exec('DROP TABLE ur_save')

      db.exec(SCHEMA_V14_JOB_INDEXES)

      // ── The self-assertion. Throwing here rolls the whole step back to v13. ──
      const jobCountAfter = (
        db.prepare('SELECT COUNT(*) AS c FROM processing_job').get() as { c: number }
      ).c
      if (jobCountAfter !== jobCountBefore) {
        throw new Error(
          `v14: processing_job row count changed ${jobCountBefore} -> ${jobCountAfter}`
        )
      }
      const restored = new Map(
        (
          db
            .prepare(
              `SELECT id, retrieval_job_id FROM unresolved_reference
                WHERE retrieval_job_id IS NOT NULL`
            )
            .all() as Array<{ id: number; retrieval_job_id: number }>
        ).map((r) => [r.id, r.retrieval_job_id])
      )
      if (restored.size !== savedLinks.length) {
        throw new Error(
          `v14: unresolved_reference.retrieval_job_id links ${savedLinks.length} -> ${restored.size}` +
            ' (the DROP TABLE fired ON DELETE SET NULL and the restore did not recover them)'
        )
      }
      for (const link of savedLinks) {
        if (restored.get(link.id) !== link.retrieval_job_id) {
          throw new Error(
            `v14: unresolved_reference ${link.id}.retrieval_job_id ` +
              `${link.retrieval_job_id} -> ${String(restored.get(link.id))}`
          )
        }
        const target = db
          .prepare('SELECT id FROM processing_job WHERE id = ?')
          .get(link.retrieval_job_id)
        if (!target) {
          throw new Error(
            `v14: restored retrieval_job_id ${link.retrieval_job_id} names no processing_job row`
          )
        }
      }
    }
  },
  {
    // v15: `analysis_run.schema_id` joins the one-current-run key, so extraction
    // can fan out one run per attached schema. See SCHEMA_V15.
    version: 15,
    up: (db) => {
      const cols = (db.pragma('table_info(analysis_run)') as Array<{ name: string }>).map(
        (c) => c.name
      )
      if (cols.includes('schema_id')) return

      // PRE-CHECK, so a conflict reports WHICH rows conflict rather than an
      // opaque "UNIQUE constraint failed" from inside CREATE INDEX. The step is
      // in BEGIN IMMEDIATE either way, so the DB is never half-migrated — but a
      // migration that fails without naming the offending row leaves a user
      // with an unopenable app and no way to act.
      const dupes = db
        .prepare(
          `SELECT work_id, project_id, analysis_type, COUNT(*) AS n
             FROM analysis_run WHERE superseded = 0
            GROUP BY work_id, project_id, analysis_type HAVING n > 1`
        )
        .all() as Array<{ work_id: number; project_id: number; analysis_type: string; n: number }>
      if (dupes.length > 0) {
        throw new Error(
          `v15: ${dupes.length} duplicate current analysis_run key(s) already violate ` +
            `ux_analysis_run_current: ${dupes
              .map((d) => `w${d.work_id}/p${d.project_id}/${d.analysis_type} x${d.n}`)
              .join(', ')}`
        )
      }

      const before = (db.prepare('SELECT COUNT(*) AS c FROM analysis_run').get() as { c: number }).c
      const currentBefore = (
        db.prepare('SELECT COUNT(*) AS c FROM analysis_run WHERE superseded = 0').get() as {
          c: number
        }
      ).c

      db.exec(SCHEMA_V15)

      // The new index is a strict superset of the old one's columns with a
      // constant backfill, so it can only ACCEPT a superset of row sets — but
      // asserting that is cheap and the alternative (finding out later that a
      // run was silently retired) is not.
      const after = (db.prepare('SELECT COUNT(*) AS c FROM analysis_run').get() as { c: number }).c
      const currentAfter = (
        db.prepare('SELECT COUNT(*) AS c FROM analysis_run WHERE superseded = 0').get() as {
          c: number
        }
      ).c
      if (after !== before || currentAfter !== currentBefore) {
        throw new Error(
          `v15: analysis_run changed ${before}/${currentBefore} -> ${after}/${currentAfter} rows/current`
        )
      }
    }
  },
  {
    // v16: `document_paragraph`, the inventory the `segment` stage writes and
    // every downstream anchor resolves against. Purely additive.
    version: 16,
    up: (db) => {
      const exists = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get('document_paragraph')
      if (exists) return
      db.exec(SCHEMA_V16)
    }
  },
  {
    // v17: rebuild `citation_context` so a context can belong to an UNRESOLVED
    // reference, carry its callout site, and name the run that produced it.
    //
    // ── What this step has to survive ────────────────────────────────────────
    // v14 established that `foreign_key_check` and `integrity_check` are BLIND
    // to a rebuild that loses data: they came back clean while every retrieval
    // link had been silently NULLed. So this step asserts its own success in JS
    // against an independent snapshot, exactly as v14 does.
    //
    // The failure mode here is different from v14's and worth naming, because
    // it is the one that would actually bite: `citation_context` is a pure
    // CHILD (verified — nothing in the schema references it), so DROP TABLE
    // fires no action clause in any other table. What CAN go wrong is the copy
    // itself, and specifically the new CHECKs rejecting existing rows.
    //
    // The seeded rows carry `role` AND `role_confidence` but have no
    // `role_source`, which the new `role IS NULL OR role_source IS NOT NULL`
    // check forbids. Every way of keeping the role is a fabricated provenance
    // claim: 'rule' additionally requires role_confidence to be NULL (it is
    // not), and 'llm' asserts a model produced a judgement that in fact came
    // out of the seeder. So the ROLE IS DROPPED for rows with no owning run.
    // That is the honest reading — those rows never recorded where their role
    // came from — and `stage_run_id IS NULL` keeps them distinguishable from a
    // row a real analysis left genuinely unlabelled.
    version: 17,
    up: (db) => {
      const cols = (db.pragma('table_info(citation_context)') as Array<{ name: string }>).map(
        (c) => c.name
      )
      if (cols.includes('unresolved_reference_id')) return

      // A FK naming a table that does not exist makes EVERY statement on the
      // rebuilt table fail with `no such table` at RUNTIME, not here — so the
      // dependency is asserted rather than assumed.
      for (const t of ['stage_run', 'unresolved_reference', 'citation_edge', 'document', 'work']) {
        const found = db
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
          .get(t)
        if (!found) throw new Error(`v17 requires table '${t}', which does not exist`)
      }

      db.pragma('defer_foreign_keys = ON')

      // The independent snapshot. In JS, NOT read back from the table the
      // restore wrote — an assertion that reads its own output proves nothing.
      const saved = db
        .prepare(
          `SELECT id, edge_id, raw_bib_text, section, occurrence_kind,
                  resolution_confidence, created_at
             FROM citation_context ORDER BY id`
        )
        .all() as Array<{
        id: number
        edge_id: number
        raw_bib_text: string | null
        section: string | null
        occurrence_kind: string | null
        resolution_confidence: number | null
        created_at: string
      }>

      db.exec(SCHEMA_V17_TABLE)
      db.exec(
        `INSERT INTO citation_context_new
           (id, edge_id, unresolved_reference_id, stage_run_id, document_id, citing_work_id,
            ordinal, callout_offset, callout_end, para_id, page, sentence, section,
            raw_bib_text, role, role_source, role_cue, role_confidence,
            occurrence_kind, resolution_confidence, created_at)
         SELECT id, edge_id, NULL, NULL, NULL, NULL,
                NULL, NULL, NULL, NULL, NULL, NULL, section,
                raw_bib_text, NULL, NULL, NULL, NULL,
                occurrence_kind, resolution_confidence, created_at
           FROM citation_context`
      )

      db.exec('DROP TABLE citation_context')
      // This direction, never the reverse — the same rule v14 documents. With
      // `legacy_alter_table` at its modern default, RENAME rewrites FK clauses
      // in tables referencing the renamed name; nothing points at
      // `citation_context_new`, and renaming old->tmp first would have
      // repointed any future reference at a temporary name.
      db.exec('ALTER TABLE citation_context_new RENAME TO citation_context')
      db.exec(SCHEMA_V17_INDEXES)

      // ── Self-assertion. Throwing here rolls the whole step back to v16. ────
      const restored = db
        .prepare(
          `SELECT id, edge_id, unresolved_reference_id, raw_bib_text, section,
                  occurrence_kind, resolution_confidence, created_at
             FROM citation_context ORDER BY id`
        )
        .all() as Array<{
        id: number
        edge_id: number | null
        unresolved_reference_id: number | null
        raw_bib_text: string | null
        section: string | null
        occurrence_kind: string | null
        resolution_confidence: number | null
        created_at: string
      }>
      if (restored.length !== saved.length) {
        throw new Error(`v17: citation_context rows ${saved.length} -> ${restored.length}`)
      }
      for (let i = 0; i < saved.length; i++) {
        const a = saved[i]
        const b = restored[i]
        if (
          a.id !== b.id ||
          a.edge_id !== b.edge_id ||
          a.raw_bib_text !== b.raw_bib_text ||
          a.section !== b.section ||
          a.occurrence_kind !== b.occurrence_kind ||
          a.resolution_confidence !== b.resolution_confidence ||
          a.created_at !== b.created_at
        ) {
          throw new Error(`v17: citation_context ${a.id} did not survive the rebuild intact`)
        }
      }
      // Every surviving row must satisfy the XOR, and every edge_id must still
      // name a real edge. `foreign_key_check` would report the second; it would
      // NOT report the first, because a CHECK is not a foreign key.
      const badXor = (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM citation_context
              WHERE (edge_id IS NULL) = (unresolved_reference_id IS NULL)`
          )
          .get() as { c: number }
      ).c
      if (badXor > 0) throw new Error(`v17: ${badXor} citation_context row(s) violate the XOR`)
      const dangling = (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM citation_context c
               LEFT JOIN citation_edge e ON e.id = c.edge_id
              WHERE c.edge_id IS NOT NULL AND e.id IS NULL`
          )
          .get() as { c: number }
      ).c
      if (dangling > 0) {
        throw new Error(`v17: ${dangling} citation_context row(s) name a missing citation_edge`)
      }
    }
  },
  {
    // v18: OCR provenance on `document`, plus the embedding-space registry and
    // its chunk table.
    //
    // Guarded like v7-v17: a fresh DB walks every version, and re-running an
    // ADD COLUMN would abort the migration with "duplicate column". The two
    // halves are checked independently because a DB that took one and failed
    // the other is exactly the state a re-run has to be able to finish.
    version: 18,
    up: (db) => {
      const docCols = (db.pragma('table_info(document)') as Array<{ name: string }>).map(
        (c) => c.name
      )
      if (!docCols.includes('text_source')) db.exec(SCHEMA_V18_TEXT_SOURCE)

      const haveChunk = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chunk'`)
        .get()
      if (!haveChunk) {
        // `chunk` names stage_run, document and work in its foreign keys. A FK
        // to a table that does not exist fails at RUNTIME with `no such table`
        // rather than here, so the dependency is asserted rather than assumed —
        // the same guard v17 uses for the same reason.
        for (const t of ['stage_run', 'document', 'work']) {
          const found = db
            .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
            .get(t)
          if (!found) throw new Error(`v18 requires table '${t}', which does not exist`)
        }
        db.exec(SCHEMA_V18_EMBEDDING)
      }

      // No `chunk_vec_*` table is created here. `vec0` fixes dimensionality per
      // table and the dimensionality comes from a registry row that does not
      // exist yet — so the vector tables are created lazily by the `embed`
      // stage, from the row, and never from a literal in a migration.
    }
  },
  {
    // v19: RETIRE stage_run rows whose project_id contradicts their stage's
    // scope.
    //
    // `ux_stage_run_current` includes `project_id`, so it can only enforce
    // one-current-run-per-key while every writer agrees which project_id a
    // stage uses. A DOCUMENT-scoped stage written with a real project id takes
    // a different slot from the same stage written with 0 — both satisfy the
    // index, both stay current, and the invariant is quietly gone. In the
    // user's real database this produced two live paragraph inventories for
    // document 20, and `readDocumentBody` (which correctly refuses to
    // concatenate two inventories no single run ever produced) then reported
    // that document's body as ABSENT. A paper with a full text reading as
    // having none, with nothing on screen saying why.
    //
    // `beginRun` now rejects the shape at the write. This retires the rows
    // already written, which the guard cannot reach.
    //
    // SUPERSEDED, never deleted: these rows are provenance and are named by
    // `document_paragraph.stage_run_id`, `chunk`, `analysis_run` and the job
    // table. Superseding retires the CLAIM while leaving the record of it, and
    // frees the index slot so the legitimate run is unambiguous.
    version: 19,
    up: (db) => {
      // Scope is a property of the stage DEFINITION, which SQL cannot see, so
      // the one project-scoped stage is named here explicitly. Naming the
      // project-scoped set (rather than the document-scoped one) is the safe
      // direction: a stage added later and forgotten here is merely checked
      // more strictly than it needs to be, and will fail loudly at its first
      // write instead of silently keeping a second current row.
      const PROJECT_SCOPED = ['schema-extract']
      const placeholders = PROJECT_SCOPED.map(() => '?').join(',')

      const offenders = db
        .prepare(
          `SELECT id, stage, work_id, document_id, project_id FROM stage_run
            WHERE superseded = 0 AND project_id != 0 AND stage NOT IN (${placeholders})`
        )
        .all(...PROJECT_SCOPED) as Array<{
        id: number
        stage: string
        work_id: number
        document_id: number
        project_id: number
      }>
      if (offenders.length === 0) return

      const res = db
        .prepare(
          `UPDATE stage_run SET superseded = 1
            WHERE superseded = 0 AND project_id != 0 AND stage NOT IN (${placeholders})`
        )
        .run(...PROJECT_SCOPED)
      if (res.changes !== offenders.length) {
        throw new Error(
          `v19: found ${offenders.length} scope-contradicting run(s) but retired ${res.changes}`
        )
      }

      // ── The self-assertion. Throwing rolls the whole step back to v18. ──
      //
      // Retiring the WRONG row would leave a subject with NO current inventory
      // rather than two, which reads to the user identically. So the repair is
      // accepted only if every subject now has exactly one live inventory — the
      // condition the fix exists for, checked directly rather than inferred
      // from the update count.
      //
      // EVERY bulk table keyed by `stage_run_id`, not just paragraphs.
      //
      // Checking only `document_paragraph` would have been near-vacuous: its
      // sole writer is the `segment` stage, so on a database whose offending
      // rows belonged to any OTHER document-scoped stage (`embed`, `ocr`,
      // `citation-contexts`, `references`…) the assertion passes while proving
      // nothing about the rows it just retired. The failure mode is the same in
      // every one of these tables — two live runs owning one subject's rows —
      // so all of them are checked.
      const ambiguity: Array<{ table: string; owner: string }> = [
        { table: 'document_paragraph', owner: 'document_id' },
        { table: 'chunk', owner: 'document_id' },
        { table: 'citation_context', owner: 'citing_work_id' }
      ]
      for (const { table, owner } of ambiguity) {
        const exists = db
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
          .get(table)
        if (!exists) continue
        const cols = (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(
          (c) => c.name
        )
        if (!cols.includes(owner) || !cols.includes('stage_run_id')) continue
        const still = db
          .prepare(
            `SELECT b.${owner} AS subject, COUNT(DISTINCT sr.id) AS runs
               FROM ${table} b
               JOIN stage_run sr ON sr.id = b.stage_run_id
              WHERE sr.superseded = 0 AND b.${owner} IS NOT NULL
              GROUP BY b.${owner}
             HAVING runs != 1`
          )
          .all() as Array<{ subject: number; runs: number }>
        if (still.length > 0) {
          throw new Error(
            `v19: ${still.length} subject(s) in '${table}' still have an ambiguous ` +
              `inventory after the repair: ${still
                .map((r) => `${owner} ${r.subject} has ${r.runs} current run(s)`)
                .join('; ')}`
          )
        }
      }

      const survivors = db
        .prepare(
          `SELECT COUNT(*) AS c FROM stage_run
            WHERE superseded = 0 AND project_id != 0 AND stage NOT IN (${placeholders})`
        )
        .get(...PROJECT_SCOPED) as { c: number }
      if (survivors.c !== 0) {
        throw new Error(
          `v19: ${survivors.c} scope-contradicting stage_run row(s) survived the retirement`
        )
      }
    }
  },
  {
    // v20: retire the offline replay path, and DESTROY what it produced.
    //
    // Two separable things happen here, and both are necessary.
    //
    // (a) `mock_llm_response` is dropped and `analysis_run` gains `run_origin`,
    //     so a stored analysis states whether it was computed on this machine or
    //     shipped with the corpus.
    //
    // (b) Every analysis that a mock produced is DELETED. This is the part that
    //     deletes user-visible data, so it is worth being explicit about why
    //     nothing weaker will do. Those rows carry `provider = 'mock-provider'`,
    //     `model = 'mock-model'`, and facts, quotes, measurements and fold
    //     improvements that no model ever derived from the paper they name. They
    //     are presented in the UI beside genuine runs, they feed the graph, the
    //     ranking explanations and the dossier, and they satisfy the
    //     one-current-run index — so leaving them means a "current" analysis of
    //     a paper remains fabricated, which is the exact thing this change
    //     exists to end. Badging them harder was considered and rejected: a
    //     label does not stop them being the newest analysis of that paper, and
    //     the honest state for a paper nobody has analysed is NO analysis, which
    //     the UI already renders. They are regenerated by a real run.
    version: 20,
    up: (db) => {
      db.exec(SCHEMA_V20_DROP_MOCK)
      db.exec(SCHEMA_V20_RUN_ORIGIN)

      const doomed = db
        .prepare(
          `SELECT id FROM analysis_run WHERE provider = 'mock-provider' OR model = 'mock-model'`
        )
        .all() as Array<{ id: number }>
      if (doomed.length === 0) return
      const ids = doomed.map((r) => r.id)
      const holes = ids.map(() => '?').join(',')

      // The USER'S OWN REVIEW VERDICTS, preserved before anything is deleted.
      //
      // `fact_verdict` holds a human's accept/correct/reject on a specific fact,
      // and both its FKs are ON DELETE RESTRICT — so without this the DELETE
      // below aborts, the migration rolls back, and the app cannot start for
      // anyone who ever reviewed a mock-produced fact.
      //
      // They are ARCHIVED, not dropped. The fabricated fact a verdict was passed
      // on has to go, but the verdict is the user's own work and the reviewer's
      // reasoning may be the only record of why a number looked wrong. It is
      // copied out with the fact's text so it remains readable, and
      // `fact_fingerprint` is what lets a verdict be re-attached if the same
      // claim reappears in a real run.
      db.exec(/* sql */ `
        CREATE TABLE IF NOT EXISTS fact_verdict_orphaned (
          id               INTEGER PRIMARY KEY,
          project_id       INTEGER NOT NULL,
          fact_fingerprint TEXT NOT NULL,
          verdict          TEXT NOT NULL,
          corrected_value  TEXT,
          note             TEXT,
          reviewer         TEXT NOT NULL,
          created_at       TEXT NOT NULL,
          -- What the verdict was ABOUT, denormalised, because the rows that
          -- carried it are about to stop existing.
          fact_predicate   TEXT,
          fact_value_text  TEXT,
          work_id          INTEGER,
          archived_reason  TEXT NOT NULL
        );
      `)
      db.prepare(
        `INSERT INTO fact_verdict_orphaned
           (project_id, fact_fingerprint, verdict, corrected_value, note, reviewer,
            created_at, fact_predicate, fact_value_text, work_id, archived_reason)
         SELECT fv.project_id, fv.fact_fingerprint, fv.verdict, fv.corrected_value,
                fv.note, fv.reviewer, fv.created_at, f.predicate, f.value_text,
                ar.work_id,
                'the analysis it judged was produced by a mock, not a model, and was removed in v20'
           FROM fact_verdict fv
           JOIN fact f ON f.id = fv.fact_id
           JOIN analysis_run ar ON ar.id = fv.analysis_run_id
          WHERE fv.analysis_run_id IN (${holes})`
      ).run(...ids)
      db.prepare(`DELETE FROM fact_verdict WHERE analysis_run_id IN (${holes})`).run(...ids)

      // Children first, deepest first: `fold_improvement` hangs off
      // `measurement`, which hangs off `fact`. `analysis_run` is referenced by
      // `analysis_check` with RESTRICT, so that goes before the runs too.
      db.prepare(
        `DELETE FROM fold_improvement WHERE measurement_id IN (
           SELECT m.id FROM measurement m JOIN fact f ON f.id = m.fact_id
            WHERE f.analysis_run_id IN (${holes}))`
      ).run(...ids)
      db.prepare(
        `DELETE FROM measurement WHERE fact_id IN (
           SELECT id FROM fact WHERE analysis_run_id IN (${holes}))`
      ).run(...ids)
      db.prepare(`DELETE FROM analysis_check WHERE analysis_run_id IN (${holes})`).run(...ids)
      db.prepare(`DELETE FROM fact WHERE analysis_run_id IN (${holes})`).run(...ids)
      db.prepare(`DELETE FROM evidence_span WHERE analysis_run_id IN (${holes})`).run(...ids)
      db.prepare(`DELETE FROM analysis_run WHERE id IN (${holes})`).run(...ids)

      // Citation roles a mock decided are fabrications of the same kind, and
      // they are not reachable from `analysis_run` — the stage writes them onto
      // `citation_context` directly. Cleared to NULL rather than deleted,
      // because the CONTEXT (the sentence, its offset, the edge it belongs to)
      // is real parser output worth keeping; only the role judgement was
      // invented. `role_source` NULL is the schema's own way of saying nobody
      // has classified this, which is now true again.
      db.prepare(
        `UPDATE citation_context
            SET role = NULL, role_source = NULL, role_cue = NULL, role_confidence = NULL
          WHERE role_source = 'llm'`
      ).run()

      // ── Self-assertion. Throwing rolls the whole step back to v19. ──
      const left = db
        .prepare(
          `SELECT COUNT(*) AS c FROM analysis_run
            WHERE provider = 'mock-provider' OR model = 'mock-model'`
        )
        .get() as { c: number }
      if (left.c !== 0) {
        throw new Error(`v20: ${left.c} mock-produced analysis_run row(s) survived the purge`)
      }
      const orphanFacts = db
        .prepare(
          `SELECT COUNT(*) AS c FROM fact
            WHERE analysis_run_id NOT IN (SELECT id FROM analysis_run)`
        )
        .get() as { c: number }
      if (orphanFacts.c !== 0) {
        throw new Error(`v20: ${orphanFacts.c} fact row(s) outlived the run that produced them`)
      }
    }
  },
  {
    // Re-queue the `optimize` runs that reported a tool this build DOES have.
    //
    // `optimize` resolved its bundled binary by hand as `bin/<platform>/qpdf`
    // while payload provisioning writes `bin/<platform>-<arch>/qpdf`, so on a
    // correctly installed machine it found nothing and filed every document
    // `skipped — qpdf is not installed`. That sentence is now false, and it is
    // recorded 40 times where the user reads it.
    //
    // The rows cannot be left to heal themselves. A `done` job is terminal: the
    // scheduler never revisits it, and the stage's own `fingerprint()` — which
    // WOULD invalidate the cache, since it moves from `qpdf|absent` to
    // `qpdf|<path>|<version>` — is only consulted when a job runs. So the false
    // statement would sit there permanently while every new paper optimised
    // correctly beside it.
    //
    // Re-QUEUED, not rewritten. Rewriting the note to something true would
    // claim an optimisation that never happened; the honest repair is to let
    // the stage actually run and report what it really did. `optimize` is a
    // transformer over `document.file@v1` and is idempotent — qpdf on an
    // already-optimal file returns `after >= before` and the stage keeps the
    // original — so re-running costs a little CPU and changes nothing else.
    //
    // Scoped by the exact note the bug wrote. A user who genuinely has no qpdf
    // (macOS, where it is `unavailable`) will re-run, skip again, and record
    // the same note — correct, and not a loop, because the row ends terminal.
    version: 21,
    up: (db) => {
      const stale = db
        .prepare(
          `SELECT COUNT(*) AS c FROM processing_job
            WHERE stage = 'optimize' AND outcome = 'skipped'
              AND outcome_note LIKE 'qpdf is not installed%'`
        )
        .get() as { c: number }
      if (stale.c === 0) return

      // The NEWEST row per `job_key` only. `ux_processing_job_live` permits one
      // live job per key, and this corpus holds two terminal `optimize` rows for
      // several documents (an earlier wave and a later one), so re-queueing the
      // set wholesale trips the unique index and rolls the migration back. The
      // older duplicates are history and stay terminal; re-running one would
      // re-do work the newer row already superseded.
      db.prepare(
        `UPDATE processing_job
            SET status = 'queued', attempts = 0, cancel_requested = 0,
                outcome = NULL, outcome_note = NULL,
                error = NULL, error_code = NULL, error_kind = NULL,
                run_after = NULL, lease_owner = NULL, lease_expires_at = NULL,
                stage_run_id = NULL, started_at = NULL, finished_at = NULL,
                updated_at = datetime('now')
          WHERE id IN (
            SELECT MAX(id) FROM processing_job
             WHERE stage = 'optimize' AND outcome = 'skipped'
               AND outcome_note LIKE 'qpdf is not installed%'
             GROUP BY COALESCE(job_key, 'id:' || id)
          )`
      ).run()

      // The stage_run rows carry the fingerprint that would otherwise serve the
      // same `skipped` straight back out of the cache without qpdf ever being
      // consulted again. Deleting them forces a real decision on re-run.
      db.prepare(
        `DELETE FROM stage_run
          WHERE stage = 'optimize' AND status = 'skipped'
            AND outcome_note LIKE 'qpdf is not installed%'`
      ).run()

      // ── Self-assertion. Throwing rolls the whole step back to v20. ──
      // Every job_key that carried the false note must now have a live row.
      // Counting the CURRENT rows rather than all rows is the point: the older
      // duplicates are meant to survive, so a bare "zero remain" would fail on
      // correct behaviour and tempt someone to weaken the assertion.
      const left = db
        .prepare(
          `SELECT COUNT(*) AS c
             FROM processing_job j
            WHERE j.stage = 'optimize'
              AND j.outcome_note LIKE 'qpdf is not installed%'
              AND j.id = (SELECT MAX(k.id) FROM processing_job k
                           WHERE k.stage = 'optimize'
                             AND COALESCE(k.job_key, 'id:' || k.id)
                                 = COALESCE(j.job_key, 'id:' || j.id))`
        )
        .get() as { c: number }
      if (left.c !== 0) {
        throw new Error(`v21: ${left.c} job_key(s) still lead with the false "qpdf" note`)
      }
      const cached = db
        .prepare(
          `SELECT COUNT(*) AS c FROM stage_run
            WHERE stage = 'optimize' AND status = 'skipped'
              AND outcome_note LIKE 'qpdf is not installed%'`
        )
        .get() as { c: number }
      if (cached.c !== 0) {
        throw new Error(`v21: ${cached.c} stale optimize stage_run(s) would still serve from cache`)
      }
    }
  },
  {
    // Give every database the app-owned library, and drop the storage location
    // that never existed.
    //
    // The seed used to insert TWO base_dir rows: the machine-specific folder the
    // corpus happened to be assembled in, and `/mnt/nas/ke07-corpus` — a share
    // that was on no machine, seeded only to keep the base-dir abstraction
    // looking non-trivial. It reached the UI as a storage location with a real
    // path and an "Unreachable" badge, which is a fabricated fact about the
    // user's filesystem: it tells them to go mount something that never existed.
    //
    // EXISTING ROWS ARE LEFT ALONE. A user whose documents resolve through the
    // folder they already have must keep opening them, so the managed library is
    // added ALONGSIDE rather than by repointing an existing row — repointing
    // would silently make every `relative_path` under it describe a file that is
    // not there. The fictional row goes only if nothing references it; if
    // something somehow does, it stays and keeps those documents addressable.
    version: 22,
    up: (db) => {
      const managedPath = storageRootPath()
      mkdirSync(managedPath, { recursive: true })

      const existing = db.prepare(`SELECT id FROM base_dir WHERE abs_path = ?`).get(managedPath) as
        | { id: number }
        | undefined
      if (!existing) {
        db.prepare(
          `INSERT INTO base_dir (label, abs_path, kind, created_at)
           VALUES (?, ?, 'local', datetime('now'))`
        ).run(MANAGED_STORAGE_LABEL, managedPath)
      }

      // Matched by PATH, not by id: ids differ between databases, and the path
      // is what made the row a false claim in the first place.
      db.prepare(
        `DELETE FROM base_dir
          WHERE abs_path = '/mnt/nas/ke07-corpus'
            AND id NOT IN (SELECT DISTINCT base_dir_id FROM file_location)`
      ).run()

      // ── Self-assertion. Throwing rolls the whole step back to v21. ──
      const managed = db
        .prepare(`SELECT COUNT(*) AS c FROM base_dir WHERE abs_path = ?`)
        .get(managedPath) as { c: number }
      if (managed.c !== 1) {
        throw new Error(`v22: expected exactly one managed library row, found ${managed.c}`)
      }
      // Nothing may have been orphaned: every file_location must still resolve
      // to a base_dir row.
      const orphans = db
        .prepare(
          `SELECT COUNT(*) AS c FROM file_location fl
            WHERE NOT EXISTS (SELECT 1 FROM base_dir bd WHERE bd.id = fl.base_dir_id)`
        )
        .get() as { c: number }
      if (orphans.c !== 0) {
        throw new Error(`v22: ${orphans.c} document file(s) lost their storage location`)
      }
    }
  },
  {
    // Stop shipping one interchange format as if the app were built for it.
    //
    // Extraction schemas are a real, plural, user-owned feature and none of that
    // changes here. What changes is the BRANDING of the seeded built-in: it was
    // called "EnzymeML Kinetics" and shipped with `export_alias='enzymeml'`,
    // which made a single format look like a native capability of an app that is
    // deliberately agnostic to any particular field. The shape it describes —
    // steady-state kinetics — is unchanged, so this renames rather than
    // replaces, and every measurement keeps its `field_id`.
    //
    // `export_alias` is CLEARED, not dropped: naming your own export format is a
    // real feature, it just is not ours to pre-name. A user who has since set
    // their own alias keeps it — only the seeded value goes.
    version: 23,
    up: (db) => {
      db.prepare(
        `UPDATE extraction_schema
            SET key = 'enzyme-kinetics',
                name = 'Enzyme Kinetics',
                description = 'Steady-state kinetic characterization of an enzyme variant under stated assay conditions.',
                export_alias = NULL,
                updated_at = datetime('now')
          WHERE key = 'enzymeml-kinetics'`
      ).run()

      // Only the seeded alias, so a user's own naming is untouched.
      db.prepare(
        `UPDATE extraction_schema SET export_alias = NULL WHERE export_alias = 'enzymeml'`
      ).run()

      // The seeded project's tag pills named the format too.
      db.prepare(
        `UPDATE project
            SET tags = '["Enzyme kinetics","Directed evolution"]', updated_at = datetime('now')
          WHERE tags = '["Enzyme","EnzymeML"]'`
      ).run()

      // ── Self-assertion. Throwing rolls the whole step back to v22. ──
      const branded = db
        .prepare(
          `SELECT COUNT(*) AS c FROM extraction_schema
            WHERE key = 'enzymeml-kinetics' OR export_alias = 'enzymeml'`
        )
        .get() as { c: number }
      if (branded.c !== 0) {
        throw new Error(`v23: ${branded.c} schema(s) still carry the shipped format branding`)
      }
      // The rename must not have cost any extracted value its field.
      const orphaned = db
        .prepare(
          `SELECT COUNT(*) AS c FROM measurement
            WHERE field_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM extraction_field f WHERE f.id = measurement.field_id)`
        )
        .get() as { c: number }
      if (orphaned.c !== 0) {
        throw new Error(`v23: ${orphaned.c} measurement(s) lost their extraction field`)
      }
    }
  },
  {
    version: 24,
    // The selectable analysis models are APP CONFIG, not sample data: without a
    // row here the Settings modal renders a heading over nothing and no analysis
    // can be run at all. They lived in the seed only because the app used to
    // seed itself on first launch; now that a fresh install stays empty, an
    // install that never seeds must still arrive with its model list.
    //
    // Idempotent (`INSERT OR IGNORE`) and it never touches the current
    // selection if one exists, so an existing corpus keeps the model its user
    // picked and a re-seed still owns these rows exactly as before.
    up: (db) => {
      const now = new Date().toISOString()
      db.prepare(
        `INSERT OR IGNORE INTO llm_model (id, label, sub, provider, sort_order, created_at) VALUES
          ('gpt-4.1',   'GPT-4.1',     'OpenAI',        'OpenAI',    0, @now),
          ('opus-med',  'Claude Opus', 'Medium effort', 'Anthropic', 1, @now),
          ('opus-high', 'Claude Opus', 'High effort',   'Anthropic', 2, @now),
          ('opus-max',  'Claude Opus', 'Max effort',    'Anthropic', 3, @now)`
      ).run({ now })
      db.prepare(
        `INSERT OR IGNORE INTO setting (key, value, updated_at)
         VALUES ('selected_model_id', 'gpt-4.1', @now)`
      ).run({ now })

      // ── Self-assertion. Throwing rolls the whole step back to v23. ──
      const models = db.prepare('SELECT COUNT(*) AS c FROM llm_model').get() as { c: number }
      if (models.c === 0) {
        throw new Error('v24: llm_model is still empty, so no analysis could be run')
      }
    }
  },
  {
    // `citation_link` — the verified, two-sided citation claim.
    //
    // ADDITIVE. A `CREATE TABLE` and four indexes; no existing table is touched,
    // no column is rewritten, nothing is copied. That is why this step does not
    // use the TEMP-table save/restore rebuild pattern v17 needed: there is
    // nothing to save. The rebuild pattern exists because SQLite cannot change a
    // column's nullability in place — and a naive rebuild silently NULLs FK
    // columns while `foreign_key_check` returns empty — but neither hazard is
    // reachable from a step that only adds a table.
    //
    // The self-assertion below is therefore about the thing that CAN go wrong
    // here: a FK naming a table that does not exist. SQLite accepts that at
    // CREATE time and fails every statement on the table at RUNTIME with `no
    // such table`, so the dependency is asserted rather than assumed — the same
    // reasoning v17 records.
    version: 25,
    up: (db) => {
      for (const t of ['citation_context', 'work', 'chunk', 'document', 'stage_run']) {
        const found = db
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
          .get(t)
        if (!found) throw new Error(`v25 requires table '${t}', which does not exist`)
      }

      // Counted BEFORE, in JS, so the assertion below compares against an
      // independent number rather than reading back its own output.
      const contextsBefore = (
        db.prepare('SELECT COUNT(*) AS c FROM citation_context').get() as { c: number }
      ).c
      const edgesBefore = (
        db.prepare('SELECT COUNT(*) AS c FROM citation_edge').get() as { c: number }
      ).c

      db.exec(SCHEMA_V25_CITATION_LINK)

      // ── Self-assertion. Throwing rolls the whole step back to v24. ──
      // The table must be USABLE, not merely present: an unresolvable FK is
      // invisible until the first insert, which is long after this migration
      // could have refused. So a row is written and rolled back.
      const probeCtx = db
        .prepare('SELECT id, citing_work_id FROM citation_context WHERE citing_work_id IS NOT NULL LIMIT 1')
        .get() as { id: number; citing_work_id: number } | undefined
      if (probeCtx) {
        db.prepare(
          `INSERT INTO citation_link
             (citation_context_id, citing_work_id, cited_work_id, verdict,
              candidate_count, input_hash, created_at)
           VALUES (?, ?, ?, 'unverifiable', 0, 'v25-probe', datetime('now'))`
        ).run(probeCtx.id, probeCtx.citing_work_id, probeCtx.citing_work_id)
        db.prepare(`DELETE FROM citation_link WHERE input_hash = 'v25-probe'`).run()
        const left = (
          db
            .prepare(`SELECT COUNT(*) AS c FROM citation_link WHERE input_hash = 'v25-probe'`)
            .get() as { c: number }
        ).c
        if (left !== 0) throw new Error(`v25: the write probe left ${left} row(s) behind`)
      }

      // Nothing that already existed may have moved. An additive step that
      // changed a count is not additive, and this is the check that would have
      // caught the FK-nulling a naive rebuild causes.
      const contextsAfter = (
        db.prepare('SELECT COUNT(*) AS c FROM citation_context').get() as { c: number }
      ).c
      const edgesAfter = (
        db.prepare('SELECT COUNT(*) AS c FROM citation_edge').get() as { c: number }
      ).c
      if (contextsAfter !== contextsBefore) {
        throw new Error(`v25: citation_context rows ${contextsBefore} -> ${contextsAfter}`)
      }
      if (edgesAfter !== edgesBefore) {
        throw new Error(`v25: citation_edge rows ${edgesBefore} -> ${edgesAfter}`)
      }
      // The links a context owns must die with it. Asserted from the schema
      // rather than trusted, because the whole lifecycle argument for putting
      // this table behind `citation_context` rests on this one clause.
      const fks = db.pragma('foreign_key_list(citation_link)') as Array<{
        table: string
        on_delete: string
      }>
      const ctxFk = fks.find((f) => f.table === 'citation_context')
      if (!ctxFk || ctxFk.on_delete !== 'CASCADE') {
        throw new Error(
          'v25: citation_link does not cascade from citation_context, so a verification ' +
            'would outlive the passage it judged'
        )
      }
    }
  },
  {
    // `work_summary` — the prose a summary run produced.
    //
    // ADDITIVE, on the same reasoning v25 records: one CREATE TABLE and one
    // index, no column rewritten, nothing copied, so the FK-nulling hazard the
    // rebuild pattern exists to survive is not reachable from here.
    //
    // Note what this step does NOT do: it does not widen
    // `analysis_run.analysis_type`. 'summary' has been in that CHECK list since
    // v1, so both the general and the project summary are storable today with
    // no rebuild of the most FK-entangled table in the schema. That is the
    // whole reason the feature costs one table.
    version: 26,
    up: (db) => {
      const found = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'analysis_run'`)
        .get()
      if (!found) throw new Error(`v26 requires table 'analysis_run', which does not exist`)

      // Counted BEFORE, in JS, so the assertion below compares against an
      // independent number rather than reading back its own output.
      const runsBefore = (
        db.prepare('SELECT COUNT(*) AS c FROM analysis_run').get() as { c: number }
      ).c
      const worksBefore = (db.prepare('SELECT COUNT(*) AS c FROM work').get() as { c: number }).c

      db.exec(SCHEMA_V26_WORK_SUMMARY)

      // ── Self-assertion. Throwing rolls the whole step back to v25. ──
      //
      // The table must be USABLE, not merely present: an unresolvable FK is
      // accepted at CREATE time and fails every statement at RUNTIME, long
      // after this migration could have refused.
      //
      // And the prose must DIE WITH the run that wrote it. That is the entire
      // argument for storing a summary as a child of `analysis_run` rather than
      // on `work`, so it is exercised rather than trusted: reading
      // `foreign_key_list` back and asserting `on_delete = 'CASCADE'` would only
      // re-read the DDL string executed three lines above, and cannot fail
      // unless SQLite misparses its own CREATE TABLE. Deleting the parent and
      // observing the child vanish is the real test.
      //
      // The probe builds its OWN work and run instead of borrowing existing
      // rows. A fresh install is the normal case for this app (CLAUDE.md: a new
      // install starts empty), so a probe conditional on `analysis_run` already
      // having rows would assert nothing at all on exactly the machines where a
      // broken migration does the most damage. Everything it creates is removed
      // by the cascade it is testing, and the row-count check below proves it.
      const probeWorkId = Number(
        db
          .prepare(
            `INSERT INTO work (title, work_type, created_at, updated_at)
             VALUES ('v26-probe', 'other', datetime('now'), datetime('now'))`
          )
          .run().lastInsertRowid
      )
      const probeRunId = Number(
        db
          .prepare(
            `INSERT INTO analysis_run
               (work_id, project_id, analysis_type, schema_id, model, provider,
                prompt_version, schema_version, run_timestamp, superseded, created_at)
             VALUES (?, 0, 'summary', 0, 'v26-probe', 'v26-probe', 'v26', 'v26',
                     datetime('now'), 1, datetime('now'))`
          )
          .run(probeWorkId).lastInsertRowid
      )
      db.prepare(
        `INSERT INTO work_summary (analysis_run_id, body, source_scope, created_at)
         VALUES (?, 'v26-probe', 'v26-probe', datetime('now'))`
      ).run(probeRunId)

      // Deleting the RUN must take the summary with it.
      db.prepare('DELETE FROM analysis_run WHERE id = ?').run(probeRunId)
      const orphans = (
        db
          .prepare('SELECT COUNT(*) AS c FROM work_summary WHERE analysis_run_id = ?')
          .get(probeRunId) as { c: number }
      ).c
      if (orphans !== 0) {
        throw new Error(
          `v26: deleting an analysis_run left ${orphans} work_summary row(s) behind, so a ` +
            'summary would outlive the provenance that names who wrote it'
        )
      }
      db.prepare('DELETE FROM work WHERE id = ?').run(probeWorkId)

      // Nothing that already existed may have moved, and the probe must have
      // taken itself with it. An additive step that changed a count is not
      // additive — and this is also what proves the probe cleaned up, since
      // the count is the one taken before any of it was written.
      const runsAfter = (
        db.prepare('SELECT COUNT(*) AS c FROM analysis_run').get() as { c: number }
      ).c
      if (runsAfter !== runsBefore) {
        throw new Error(`v26: analysis_run rows ${runsBefore} -> ${runsAfter}`)
      }
      const worksAfter = (db.prepare('SELECT COUNT(*) AS c FROM work').get() as { c: number }).c
      if (worksAfter !== worksBefore) {
        throw new Error(`v26: work rows ${worksBefore} -> ${worksAfter}`)
      }
      const summariesLeft = (
        db.prepare('SELECT COUNT(*) AS c FROM work_summary').get() as { c: number }
      ).c
      if (summariesLeft !== 0) {
        throw new Error(`v26: the probe left ${summariesLeft} work_summary row(s) behind`)
      }
    }
  },
  {
    // `work_summary.document_id` — which document a summary was written from.
    //
    // A SEPARATE STEP rather than an edit to v26, which has already run on a
    // real database. A migration is append-only once it has been applied: that
    // DB's `user_version` is 26 and it would never re-run the step, so an
    // edited v26 would create the column only on machines that had not migrated
    // yet, and every summary write would fail on precisely the machines that
    // were up to date.
    //
    // ADDITIVE, and the narrowest kind: `ALTER TABLE ... ADD COLUMN`, which
    // SQLite performs by rewriting only the table header. No rebuild, no copy,
    // so the FK-nulling hazard v25 documents is unreachable.
    version: 27,
    up: (db) => {
      const found = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'work_summary'`)
        .get()
      if (!found) throw new Error(`v27 requires table 'work_summary', which does not exist`)

      const summariesBefore = (
        db.prepare('SELECT COUNT(*) AS c FROM work_summary').get() as { c: number }
      ).c

      db.exec(SCHEMA_V27_SUMMARY_DOCUMENT)

      // ── Self-assertions. Throwing rolls the whole step back to v26. ──
      // The column must be PRESENT and NULLABLE: existing summaries predate the
      // link and must survive without one, and a NOT NULL column added to a
      // populated table is rejected outright.
      const cols = db.pragma('table_info(work_summary)') as Array<{
        name: string
        notnull: number
      }>
      const col = cols.find((c) => c.name === 'document_id')
      if (!col) throw new Error('v27: work_summary.document_id was not created')
      if (col.notnull !== 0) {
        throw new Error(
          'v27: work_summary.document_id is NOT NULL, so summaries written before this step ' +
            'could not keep their prose'
        )
      }

      // The reference must RESOLVE. SQLite accepts a FK naming a missing table
      // at definition time and fails only at runtime, long after this migration
      // could have refused.
      const fks = db.pragma('foreign_key_list(work_summary)') as Array<{
        table: string
        from: string
      }>
      if (!fks.some((f) => f.table === 'document' && f.from === 'document_id')) {
        throw new Error('v27: work_summary.document_id does not reference document')
      }

      // No prose may have been lost. Adding a column cannot drop rows, and this
      // is the check that says so rather than assuming it.
      const summariesAfter = (
        db.prepare('SELECT COUNT(*) AS c FROM work_summary').get() as { c: number }
      ).c
      if (summariesAfter !== summariesBefore) {
        throw new Error(`v27: work_summary rows ${summariesBefore} -> ${summariesAfter}`)
      }
    }
  },
  {
    // v28: indexes for the document-text reads.
    //
    // The safest kind of step there is — `CREATE INDEX IF NOT EXISTS`, four
    // times. No column, no table, no row is touched, so there is no data to
    // lose and nothing to roll back beyond the indexes themselves.
    //
    // It is still a MIGRATION and not a startup `db.exec`: an index is part of
    // the schema, and a schema change that only some installs received is the
    // thing `user_version` exists to make impossible.
    version: 28,
    up: (db) => {
      db.exec(SCHEMA_V28_TEXT_INDEXES)

      // ── Self-assertions. Throwing rolls the whole step back to v27. ──
      // Each index must EXIST. The exec above cannot create an index whose name
      // is already taken by a DIFFERENT definition — `IF NOT EXISTS` accepts
      // that silently — so this catches a name collision with anything an
      // earlier version, or a hand-edited database, left behind.
      const want = [
        'ix_stage_run_doc',
        'ix_stage_run_stage',
        'ix_stage_artifact_key',
        'ix_document_paragraph_run_idx',
        'ix_file_location_hash'
      ]
      const have = new Set(
        (
          db
            .prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`)
            .all() as Array<{ name: string }>
        ).map((r) => r.name)
      )
      const missing = want.filter((n) => !have.has(n))
      if (missing.length > 0) {
        throw new Error(`v28: index(es) not created: ${missing.join(', ')}`)
      }

      // Whether the planner USES the partial index is checked but NOT enforced.
      // `hash = ?` does imply `hash IS NOT NULL`, so SQLite will take it on a
      // stat-free database — but with `sqlite_stat1` present it may reasonably
      // prefer a scan of a small table, and a migration that threw on that would
      // roll back to v27 and stop the app from starting over a PERFORMANCE
      // judgement. A slow query is not a corrupt database; it is worth a line in
      // the log and nothing more.
      const plan = db
        .prepare(`EXPLAIN QUERY PLAN SELECT id FROM file_location WHERE hash = ?`)
        .all('probe') as Array<{ detail: string }>
      if (!plan.some((r) => r.detail.includes('ix_file_location_hash'))) {
        // eslint-disable-next-line no-console
        console.warn(
          '[migrate] v28: the planner is not using ix_file_location_hash; importing a PDF ' +
            'will scan file_location'
        )
      }
    }
  },
  {
    // v29: per-field provenance — which field definitions a run covered, and
    // which run produced each fact. See SCHEMA_V29_FIELD_PROVENANCE.
    //
    // Two nullable columns and an index; no existing row is rewritten. Every
    // pre-existing run keeps `field_hashes = NULL`, which the diff reads as
    // "unknown" and answers by re-extracting the whole schema — exactly what
    // the app did before this step, so nothing regresses on an old database.
    //
    // STORED SCHEMA VERSIONS ARE LEFT EXACTLY AS THEY ARE, deliberately.
    //
    // v29 ships alongside a fix to `recomputeSchemaVersion`, which used to join
    // the field hashes in `sort_order` — so dragging a column moved the schema
    // version, which `schema-extract.fingerprint` keys on, and re-read every
    // paper in the corpus for a cosmetic change. Sorting by hash instead makes
    // reordering free from now on.
    //
    // But it also means the new derivation produces a DIFFERENT string for the
    // same unchanged schema (measured: both of this corpus's schemas move). So
    // recomputing here would be a single write that invalidates every
    // extraction in the database at upgrade time — the precise event this
    // feature exists to prevent, performed by the migration that introduces it.
    //
    // The version is opaque and is only ever compared against a previously
    // stored copy of itself, so an old-derivation value is perfectly serviceable
    // until something genuinely changes the schema. At that point it is
    // recomputed the new way and the run is invalidated — which is correct,
    // because a field really did change.
    version: 29,
    up: (db) => {
      db.exec(SCHEMA_V29_FIELD_PROVENANCE)

      const cols = (t: string): Set<string> =>
        new Set(
          (db.pragma(`table_info(${t})`) as Array<{ name: string }>).map((c) => c.name)
        )
      if (!cols('analysis_run').has('field_hashes')) {
        throw new Error('v29: analysis_run.field_hashes was not created')
      }
      if (!cols('fact').has('origin_run_id')) {
        throw new Error('v29: fact.origin_run_id was not created')
      }
    }
  },
  {
    // v30 — a canonical unit and value ALONGSIDE the raw ones, never instead.
    //
    // Backfilled here because the columns are pure derived data: recomputing
    // them from `unit`/`value_num` reproduces them exactly, so a wrong
    // derivation is fixable by a later migration without any information
    // having been lost. Nothing existing is rewritten — `unit` and `value_num`
    // are read and never written, which is what keeps the as-reported value
    // intact (CLAUDE.md §3).
    //
    // A unit `canonicalUnit` does not recognise leaves both columns NULL. That
    // is deliberate: an unrecognised spelling folded into the nearest known
    // unit would be a silent unit conversion, the exact failure this exists to
    // prevent.
    version: 30,
    up: (db) => {
      db.exec(SCHEMA_V30_CANONICAL_UNITS)

      const cols = new Set(
        (db.pragma('table_info(measurement)') as Array<{ name: string }>).map((c) => c.name)
      )
      if (!cols.has('unit_canonical') || !cols.has('value_canonical')) {
        throw new Error('v30: measurement canonical columns were not created')
      }

      const rows = db
        .prepare(
          `SELECT id, value_num, unit FROM measurement
            WHERE unit IS NOT NULL AND TRIM(unit) <> ''`
        )
        .all() as Array<{ id: number; value_num: number | null; unit: string }>
      const upd = db.prepare(
        'UPDATE measurement SET unit_canonical = ?, value_canonical = ? WHERE id = ?'
      )
      for (const r of rows) {
        const c = canonicaliseMeasurement(r.value_num, r.unit)
        if (c.unit === null) continue
        upd.run(c.unit, c.value, r.id)
      }
    }
  },
  {
    // v31 — the marker's position inside the stored sentence. See
    // SCHEMA_V31_MARKER_IN_SENTENCE.
    //
    // NOT backfilled, and that is the honest choice: the value cannot be
    // recovered from what is stored. `callout_offset` names a position in the
    // canonical document text, and turning it into a position in the healed
    // sentence needs the paragraph the sentence was built from. Deriving it
    // instead by searching the sentence for the ordinal would reproduce exactly
    // the ambiguous match this column exists to replace — and would do it
    // silently, writing a guess into a column every reader will trust as exact.
    //
    // NULL therefore means "not pinned", which every consumer already handles
    // by leaving the passage unmarked. `CALLOUT_SCANNER_VERSION` moved in the
    // same change, so the contexts stage re-runs and fills these rows properly.
    version: 31,
    up: (db) => {
      db.exec(SCHEMA_V31_MARKER_IN_SENTENCE)
      const cols = new Set(
        (db.pragma('table_info(citation_context)') as Array<{ name: string }>).map((c) => c.name)
      )
      if (!cols.has('marker_in_sentence')) {
        throw new Error('v31: citation_context.marker_in_sentence was not created')
      }
    }
  },
  {
    // RETIRE the schema-less extractions a re-run bug created.
    //
    // `Scheduler.forceRerun` seeded its re-plan with the origin run's own
    // `project_id`, and a work-scoped origin (`segment`, `ocr`) carries the
    // project-0 sentinel. Planning project 0 ran the WHOLE pipeline under a
    // project that does not exist, and `schema-extract` there asked
    // `listProjectSchemas(0)`, got nothing, and fired its no-schema sentinel —
    // so every paper gained a second extraction bound to no schema. Twenty of
    // them, holding 1255 of the corpus's 1711 current facts.
    //
    // Those facts have no `field_id`. They cannot be filtered, exported,
    // compared across papers or checked against a schema: the model named its
    // own predicates and produced 641 distinct ones over 1255 facts, 526 used
    // exactly once (`variant_R2_2_7E_kcat` where the schema run stored `kcat`).
    // Left current they pad every count the app reports with rows no query can
    // reach, which §3 forbids of a value no schema asked for.
    //
    // SUPERSEDED, never deleted. The rows stay readable as history and the facts
    // keep their evidence and provenance; they simply stop being the current
    // answer. `superseded_at` is only set where the column exists, because a
    // supersede must not depend on a column added later than these rows.
    version: 32,
    up: (db) => {
      const runCols = new Set(
        (db.pragma('table_info(analysis_run)') as Array<{ name: string }>).map((c) => c.name)
      )
      db.prepare(
        `UPDATE analysis_run
            SET superseded = 1
                ${runCols.has('superseded_at') ? ", superseded_at = COALESCE(superseded_at, run_timestamp)" : ''}
          WHERE superseded = 0
            AND analysis_type = 'extraction'
            AND schema_id = 0`
      ).run()

      // The stage_runs that produced them, so the Queue does not present a
      // retired analysis as a paper's current extraction outcome.
      db.prepare(
        `UPDATE stage_run
            SET superseded = 1
          WHERE superseded = 0
            AND stage = 'schema-extract'
            AND (schema_id = 0 OR project_id = 0)`
      ).run()

      const left = db
        .prepare(
          `SELECT COUNT(*) AS n FROM analysis_run
            WHERE superseded = 0 AND analysis_type = 'extraction' AND schema_id = 0`
        )
        .get() as { n: number }
      if (left.n > 0) {
        throw new Error(`v32: ${left.n} schema-less extraction run(s) are still current`)
      }
    }
  },
  {
    // Provenance on a check verdict, and the retirement of every verdict the
    // current code would no longer make.
    //
    // TWO STEPS, ONE MIGRATION, because the second is only correct given the
    // first: the new `source` column is what distinguishes a verdict produced by
    // arithmetic from one produced by a reading, and it is the deterministic
    // ones under a now-REVIEWED key that have to go.
    //
    // WHY THEY GO. Those rows were written by code that asserted things about
    // the paper without having read it. This corpus holds `"N 95 °C" states no
    // quantity at all` (the paper prints `>95 °C`; the `>` did not survive the
    // text layer) and `"m  1 s  1" is not interchangeable with M^-1 s^-1` (it is
    // the same unit with its superscripts shredded). Left in place they would
    // keep accusing correct records forever, because nothing re-derives a stored
    // verdict — and a panel that flags correct data teaches the reader to
    // dismiss the true findings printed next to it.
    //
    // DELETED, not superseded, and this is the one place in the app where that
    // is right. Every other provenance row records something that HAPPENED and
    // stays readable as history. These record a JUDGEMENT the app has withdrawn:
    // there is no version of the product where "this value states no quantity"
    // is the correct answer about `>95 °C`, so keeping it is not history, it is
    // a live accusation with no author. The rows the reviewer writes in their
    // place carry the model and prompt version that produced them.
    //
    // `deterministic_validation` is then recomputed from what remains, since it
    // is defined as the conjunction of the run's stored verdicts and would
    // otherwise still be 0 because of a verdict that no longer exists.
    version: 33,
    up: (db) => {
      db.exec(SCHEMA_V33_CHECK_PROVENANCE)

      // Transcribed rather than imported: a migration must apply the same way
      // forever, and importing the live set would make this step's behaviour
      // change whenever a check moves between the engines.
      const reviewed = [
        'field-type-number',
        'field-required-present',
        'field-unit-present',
        'field-unit-consistent',
        'evidence-supports-value',
        'evidence-subject-match',
        'duplicate-record',
        'error-bar-plausible',
        'value-outlier',
        'value-scale-consistent',
        'value-bound-not-figure'
      ]
      const list = reviewed.map(() => '?').join(',')
      db.prepare(
        `DELETE FROM analysis_check
          WHERE source = 'deterministic' AND check_key IN (${list})`
      ).run(...reviewed)

      db.prepare(
        `UPDATE analysis_run
            SET deterministic_validation = CASE
              WHEN EXISTS (
                SELECT 1 FROM analysis_check c
                 WHERE c.analysis_run_id = analysis_run.id AND c.status = 'failed'
              ) THEN 0 ELSE 1 END`
      ).run()
    }
  },
  {
    // v34 — re-derive every canonical unit and value from the raw columns.
    //
    // v30 said a wrong derivation is fixable by a later migration because the
    // canonical columns are pure derived data. This is that migration. The unit
    // parser was case-insensitive, and SI symbols are case-significant, so it
    // read `µm` as micromolar and gave measurement 1855's Michaelis constant a
    // molarity it never had — a confidently wrong number, worse than none. It
    // also collapsed `%`, `fold`, `ratio` and `pH` onto one empty dimension
    // tag, which made any two of them compare as interchangeable.
    //
    // EVERY row is recomputed, not just the ones known to be wrong. Deriving
    // the whole column from the current parser is the only formulation that
    // stays correct for whatever the parser does next; a hand-listed set of bad
    // units would have to be extended by every future fix and would silently
    // miss the ones nobody thought to list.
    //
    // A row the parser no longer recognises is CLEARED to NULL. Keeping the old
    // number because a new one is unavailable is the precise failure this
    // exists to remove: `mm`, `um` and `Ml` are real spellings whose meaning is
    // genuinely ambiguous, and the honest answer is no canonical value at all.
    //
    // Reads `unit` and `value_num`; writes only `unit_canonical` and
    // `value_canonical`. The as-reported value is untouched (CLAUDE.md §3).
    version: 34,
    up: (db) => {
      const rows = db
        .prepare('SELECT id, value_num, unit FROM measurement')
        .all() as Array<{ id: number; value_num: number | null; unit: string | null }>
      const upd = db.prepare(
        'UPDATE measurement SET unit_canonical = ?, value_canonical = ? WHERE id = ?'
      )
      for (const r of rows) {
        const c =
          r.unit !== null && r.unit.trim() !== ''
            ? canonicaliseMeasurement(r.value_num, r.unit)
            : { unit: null, value: null }
        upd.run(c.unit, c.value, r.id)
      }
    }
  },
  {
    // v35 — the canonical pair becomes the DATABASE's job. See
    // SCHEMA_V35_CANONICAL_TRIGGERS for why, and for what the triggers do.
    //
    // Not backfilled, because v34 immediately above has already re-derived every
    // stored row from the current parser and this migration cannot run without
    // it having run first. What v35 adds is the guarantee going FORWARD: v34
    // fixed the rows, v35 stops them being written wrong again.
    version: 35,
    up: (db) => {
      db.exec(SCHEMA_V35_CANONICAL_TRIGGERS)

      // The triggers call `canonical_unit`/`canonical_value`, which are
      // registered on the CONNECTION rather than stored in the file. A migration
      // that installed a trigger calling a function this connection lacks would
      // leave every later insert failing, so the call is proved to work here,
      // where the failure is a refused migration rather than a broken app.
      const probe = db.prepare('SELECT canonical_unit(?) AS u').get('mM') as { u: string | null }
      if (probe.u !== 'M') {
        throw new Error(
          `v35: canonical_unit() is not registered on this connection (got ${String(probe.u)})`
        )
      }
      const names = new Set(
        (
          db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?")
            .all('measurement') as Array<{ name: string }>
        ).map((t) => t.name)
      )
      for (const t of ['trg_measurement_canonical_insert', 'trg_measurement_canonical_update']) {
        if (!names.has(t)) throw new Error(`v35: ${t} was not created`)
      }
    }
  },
  {
    // v36 — `abstained` becomes a storable verdict.
    //
    // The sweep offered every inline passage to the model and, when the model
    // returned nothing for one, wrote no row. A passage with no row is pending,
    // so the same passage came back on every wake and was paid for again. The
    // guard against that was a regex on the candidate query that refused to ASK
    // about anything not shaped like prose — which is judgement, and it was
    // wrong: it withheld 24 of this corpus's 317 inline passages from the model,
    // among them real citing sentences ("[171] Rather than expressing and
    // characterizing…", "[185] The improvement resulted from a 2.6-…") whose
    // only defect was that extraction had clipped them short.
    //
    // Recording the abstention does the same job without the judgement: the
    // model decides, and its "I cannot say" is stored once instead of re-bought.
    // The row also makes the outcome VISIBLE — a passage nobody could judge is
    // now distinguishable from one nobody looked at.
    //
    // A CHECK cannot be altered in place, so the table is rebuilt. Every column,
    // index and constraint is reproduced from SCHEMA_V25_CITATION_LINK with the
    // verdict CHECK widened; the rows are copied by name.
    version: 36,
    up: (db) => {
      const before = (
        db.prepare('SELECT COUNT(*) AS c FROM citation_link').get() as { c: number }
      ).c

      db.exec(`
        ALTER TABLE citation_link RENAME TO citation_link_v35;
        DROP INDEX IF EXISTS ux_citation_link_context;
        DROP INDEX IF EXISTS ix_citation_link_cited;
        DROP INDEX IF EXISTS ix_citation_link_citing;
        DROP INDEX IF EXISTS ix_citation_link_chunk;
      `)
      db.exec(SCHEMA_V25_CITATION_LINK)
      db.exec(`
        INSERT INTO citation_link
          (id, citation_context_id, citing_work_id, cited_work_id, verdict,
           target_chunk_id, target_document_id, target_page, target_para_ids,
           target_char_start, target_char_end, target_text, target_source,
           candidate_count, top_score, space_id, stage_run_id, model,
           prompt_version, confidence, reason, input_hash, created_at)
        SELECT
           id, citation_context_id, citing_work_id, cited_work_id, verdict,
           target_chunk_id, target_document_id, target_page, target_para_ids,
           target_char_start, target_char_end, target_text, target_source,
           candidate_count, top_score, space_id, stage_run_id, model,
           prompt_version, confidence, reason, input_hash, created_at
          FROM citation_link_v35;
        DROP TABLE citation_link_v35;
      `)

      // Not one verdict may have been lost to a rebuild whose only purpose was
      // to widen a CHECK. Throwing rolls the step back to v35.
      const after = (
        db.prepare('SELECT COUNT(*) AS c FROM citation_link').get() as { c: number }
      ).c
      if (after !== before) {
        throw new Error(`v36: citation_link went from ${before} to ${after} row(s)`)
      }

      // The widened CHECK must actually ACCEPT the new value — a rebuild that
      // reproduced the old constraint would leave every abstention failing at
      // the first insert, long after this migration could have refused.
      // Probed on a row of our OWN, inserted and deleted here, rather than by
      // flipping a real verdict and putting it back: a throw between the two
      // updates would commit nothing but would still have been a migration that
      // rewrote a model's answer, and the rollback is the only thing standing
      // between that and a corpus of abstentions.
      const anchor = db
        .prepare(
          `SELECT c.id AS ctx, c.citing_work_id AS work FROM citation_context c
            WHERE c.citing_work_id IS NOT NULL
              AND c.id NOT IN (SELECT citation_context_id FROM citation_link)
            LIMIT 1`
        )
        .get() as { ctx: number; work: number } | undefined
      if (anchor) {
        db.prepare(
          `INSERT INTO citation_link
             (citation_context_id, citing_work_id, cited_work_id, verdict,
              candidate_count, model, input_hash, created_at)
           VALUES (?, ?, ?, 'abstained', 0, 'v36-probe', 'v36-probe', datetime('now'))`
        ).run(anchor.ctx, anchor.work, anchor.work)
        db.prepare(`DELETE FROM citation_link WHERE input_hash = 'v36-probe'`).run()
        const left = (
          db
            .prepare(`SELECT COUNT(*) AS c FROM citation_link WHERE input_hash = 'v36-probe'`)
            .get() as { c: number }
        ).c
        if (left !== 0) throw new Error(`v36: the write probe left ${left} row(s) behind`)
      }
    }
  },
  {
    // A re-scan of a document must not destroy the model verdicts on the
    // passages it rediscovers.
    //
    // `citation_link` cascades from `citation_context`, and the citation-
    // contexts stage rewrites its whole inventory by delete-then-insert. So a
    // re-run for any reason — here, a changed cache key — silently took 290
    // verified/rejected verdicts with it, at real model cost, with no error
    // anywhere. The cascade itself is right; what was missing is a place for a
    // verdict to WAIT while its context row is being rewritten identically.
    version: 37,
    up: (db) => {
      db.exec(SCHEMA_V37_LINK_CARRYOVER)

      // The table is worthless unless it can hold a stash AND its site index
      // really is unique — the whole scheme rests on a stashed verdict matching
      // at most one new context row. Both are probed here, on rows of our own,
      // rather than discovered by a corpus run.
      const stash = db.prepare(
        `INSERT INTO citation_link_carryover
           (citing_work_id, document_id, callout_offset, ordinal, cited_work_id,
            sentence, link_json, captured_at)
         VALUES (?, -1, -1, -1, ?, NULL, '{}', datetime('now'))`
      )
      stash.run(-1, -1)
      let collided = false
      try {
        stash.run(-2, -2)
      } catch {
        collided = true
      }
      db.prepare('DELETE FROM citation_link_carryover WHERE document_id = -1').run()
      if (!collided) {
        throw new Error('v37: citation_link_carryover accepted two stashes for one site')
      }
      const left = (
        db.prepare('SELECT COUNT(*) AS c FROM citation_link_carryover').get() as { c: number }
      ).c
      if (left !== 0) throw new Error(`v37: the write probe left ${left} row(s) behind`)
    }
  },
  {
    // v38 — retire every verdict a RULE reached.
    //
    // The deterministic engine is gone. It compared a model's words against a
    // declared vocabulary and reported the difference as an error: a paper
    // saying "CD spectroscopy" against the option `CD` produced eight failures
    // on one run, every one of them a correct reading. A panel that flags
    // correct values is one the reader learns to skip, and it takes the genuine
    // findings beside it down with it.
    //
    // SWEPT rather than left in place. These rows are not history a reader can
    // evaluate — they are the output of code that no longer exists and that
    // nothing can re-derive, and each is still rendered as a live finding about
    // the extraction. Leaving them means the user keeps seeing "8 checks
    // failed" from an engine this release deleted. `source = 'reviewed'`
    // survives: those verdicts were reached with the paper in front of a
    // reader, and the review stage can re-ask them.
    //
    // `deterministic_validation` is restamped from what survives, because it is
    // defined as the conjunction of a run's verdicts and would otherwise still
    // be 0 on account of a verdict that no longer exists.
    version: 38,
    up: (db) => {
      db.prepare(`DELETE FROM analysis_check WHERE source = 'deterministic'`).run()
      db.prepare(
        `UPDATE analysis_run
            SET deterministic_validation = CASE
              WHEN EXISTS (
                SELECT 1 FROM analysis_check c
                 WHERE c.analysis_run_id = analysis_run.id AND c.status = 'failed'
              ) THEN 0 ELSE 1 END`
      ).run()
      const left = (
        db
          .prepare(`SELECT COUNT(*) AS c FROM analysis_check WHERE source = 'deterministic'`)
          .get() as { c: number }
      ).c
      if (left !== 0) throw new Error(`v38: ${left} rule-authored verdict(s) survived`)
    }
  },
  {
    // v39 — the verdict stash goes, because nothing destroys verdicts any more.
    //
    // v37 added `citation_link_carryover` to rescue paid model verdicts from a
    // delete that ran on every re-scan. The delete was the defect: a citation is
    // identified by its site, an unchanged document yields the same sites, and
    // the contexts write now UPSERTS on that key instead of clearing the table.
    // With the cascade no longer firing there is nothing to rescue.
    //
    // The stash was also invisible to the rest of the pipeline: with 307
    // verdicts held here, `verify-citations` reported every citation "already
    // checked" and did no work, because the rows it looks for were parked in a
    // table it does not read. Any verdict still stashed is therefore re-attached
    // to its site FIRST — losing it would silently un-verify a citation nobody
    // asked to re-verify.
    version: 39,
    up: (db) => {
      const stashed = (
        db.prepare(`SELECT COUNT(*) AS c FROM citation_link_carryover`).get() as { c: number }
      ).c
      if (stashed > 0) {
        db.prepare(
          `INSERT OR IGNORE INTO citation_link
             (citation_context_id, citing_work_id, cited_work_id, verdict,
              target_chunk_id, target_document_id, target_page, target_para_ids,
              target_char_start, target_char_end, target_text, target_source,
              candidate_count, top_score, space_id, stage_run_id, model,
              prompt_version, confidence, reason, input_hash, created_at)
           SELECT cc.id, k.citing_work_id, k.cited_work_id,
                  json_extract(k.link_json, '$.verdict'),
                  NULL, NULL,
                  json_extract(k.link_json, '$.target_page'),
                  json_extract(k.link_json, '$.target_para_ids'),
                  json_extract(k.link_json, '$.target_char_start'),
                  json_extract(k.link_json, '$.target_char_end'),
                  json_extract(k.link_json, '$.target_text'),
                  json_extract(k.link_json, '$.target_source'),
                  json_extract(k.link_json, '$.candidate_count'),
                  json_extract(k.link_json, '$.top_score'),
                  json_extract(k.link_json, '$.space_id'),
                  NULL,
                  json_extract(k.link_json, '$.model'),
                  json_extract(k.link_json, '$.prompt_version'),
                  json_extract(k.link_json, '$.confidence'),
                  json_extract(k.link_json, '$.reason'),
                  json_extract(k.link_json, '$.input_hash'),
                  json_extract(k.link_json, '$.created_at')
             FROM citation_link_carryover k
             JOIN citation_context cc
               ON cc.document_id = k.document_id
              AND cc.callout_offset = k.callout_offset
              AND cc.ordinal = k.ordinal
              AND cc.citing_work_id = k.citing_work_id`
        ).run()
      }
      db.exec(`
        DROP INDEX IF EXISTS ux_citation_link_carryover_site;
        DROP INDEX IF EXISTS ix_citation_link_carryover_work;
        DROP TABLE IF EXISTS citation_link_carryover;
      `)
      const gone = db
        .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get('citation_link_carryover')
      if (gone) throw new Error('v39: citation_link_carryover survived the drop')
    }
  },
  {
    // v40 — every number a model reported about its OWN answer is deleted.
    //
    // `fact.confidence`, `citation_link.confidence` and
    // `citation_context.role_confidence` were all the model's self-assessment.
    // An audit of all 290 citation verdicts settled what they are worth: the
    // figure was ABSENT on roughly half the rows, present values spanned only
    // 0.7–0.98, and every case that turned out wrong carried no figure at all
    // while the one graded at 0.85 was correct. It does not order the corpus by
    // correctness, which is the only thing a reader would use it for, and a
    // number rendered beside a claim is read as a warrant for that claim.
    //
    // Engine-computed scores stay, because a program measured something:
    // `document.text_confidence` (the recogniser's own character score),
    // `citation_edge.match_confidence` (deterministic bibliography matching),
    // the OCR/layout internals on `chunk`, and `resolution_confidence`.
    //
    // Two tables can DROP COLUMN; `citation_context` cannot, because two of its
    // CHECKs name the column, so it is rebuilt the way v36 rebuilt
    // `citation_link`. Row counts are snapshotted before and asserted after: a
    // rebuild that silently drops rows passes integrity_check (v14's lesson),
    // and the rows here are 24 893 facts and 316 audited verdicts.
    version: 40,
    up: (db) => {
      const count = (t: string): number =>
        (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c
      const before = {
        fact: count('fact'),
        citation_link: count('citation_link'),
        citation_context: count('citation_context')
      }

      db.exec('ALTER TABLE fact DROP COLUMN confidence')

      // `citation_context` has to be REBUILT (two of its CHECKs name the column),
      // and `citation_link` REFERENCES it ON DELETE CASCADE. That cascade is the
      // trap v14 already documents: `DROP TABLE` fires the implicit DELETE and
      // runs ON DELETE actions IMMEDIATELY, which `defer_foreign_keys` does not
      // affect. The first run of this step destroyed all 316 audited verdicts
      // that way, silently — `foreign_key_check` came back clean — and the
      // row-count assertion below is the only thing that reported it.
      //
      // So the verdicts are moved OUT of reach first: stashed in a TEMP table,
      // their table dropped, `citation_context` rebuilt with nothing referencing
      // it, then `citation_link` rebuilt (without its own `confidence`, which is
      // the same self-report) and the stash copied back by name.
      db.pragma('defer_foreign_keys = ON')

      const linkCols = [
        'id',
        'citation_context_id',
        'citing_work_id',
        'cited_work_id',
        'verdict',
        'target_chunk_id',
        'target_document_id',
        'target_page',
        'target_para_ids',
        'target_char_start',
        'target_char_end',
        'target_text',
        'target_source',
        'candidate_count',
        'top_score',
        'space_id',
        'stage_run_id',
        'model',
        'prompt_version',
        'reason',
        'input_hash',
        'created_at'
      ].join(', ')

      db.exec(`
        CREATE TEMP TABLE citation_link_v40_stash AS
          SELECT ${linkCols} FROM citation_link;
      `)
      const stashed = (
        db.prepare('SELECT COUNT(*) AS c FROM citation_link_v40_stash').get() as { c: number }
      ).c
      if (stashed !== before.citation_link) {
        throw new Error(`v40: stashed ${stashed} of ${before.citation_link} verdict(s)`)
      }

      db.exec(`
        DROP INDEX IF EXISTS ux_citation_link_context;
        DROP INDEX IF EXISTS ix_citation_link_cited;
        DROP INDEX IF EXISTS ix_citation_link_citing;
        DROP INDEX IF EXISTS ix_citation_link_chunk;
        DROP TABLE citation_link;

        ALTER TABLE citation_context RENAME TO citation_context_v39;
        DROP INDEX IF EXISTS ux_citation_context_site;
        DROP INDEX IF EXISTS ix_citation_context_edge;
        DROP INDEX IF EXISTS ix_citation_context_unresolved;
        DROP INDEX IF EXISTS ix_citation_context_run;
        DROP INDEX IF EXISTS ix_citation_context_work;
      `)
      db.exec(SCHEMA_V40_CITATION_CONTEXT)
      db.exec(`
        INSERT INTO citation_context
          (id, edge_id, unresolved_reference_id, stage_run_id, document_id, citing_work_id,
           ordinal, callout_offset, callout_end, para_id, page, sentence, section,
           raw_bib_text, role, role_source, role_cue,
           occurrence_kind, resolution_confidence, created_at, marker_in_sentence)
        SELECT
           id, edge_id, unresolved_reference_id, stage_run_id, document_id, citing_work_id,
           ordinal, callout_offset, callout_end, para_id, page, sentence, section,
           raw_bib_text, role, role_source, role_cue,
           occurrence_kind, resolution_confidence, created_at, marker_in_sentence
          FROM citation_context_v39;
        DROP TABLE citation_context_v39;
      `)
      db.exec(SCHEMA_V17_INDEXES)

      db.exec(SCHEMA_V40_CITATION_LINK)
      db.exec(`
        INSERT INTO citation_link (${linkCols})
          SELECT ${linkCols} FROM citation_link_v40_stash;
        DROP TABLE citation_link_v40_stash;
      `)

      for (const [table, was] of Object.entries(before)) {
        const now = count(table)
        if (now !== was) throw new Error(`v40: ${table} went from ${was} to ${now} row(s)`)
      }

      // The whole point of the step, asserted rather than assumed: a rebuild
      // that reproduced the old column would leave every read still selecting it.
      for (const [table, column] of [
        ['fact', 'confidence'],
        ['citation_link', 'confidence'],
        ['citation_context', 'role_confidence']
      ] as const) {
        const cols = (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(
          (c) => c.name
        )
        if (cols.includes(column)) throw new Error(`v40: ${table}.${column} survived`)
      }
    }
  },
  {
    // v41 — `fact.field_id`: ONE binding site between a value and a schema field.
    //
    // The reasoning is in `SCHEMA_V41_FACT_FIELD`. Nothing is BACKFILLED: the
    // obvious backfill is `fact.predicate` matched against `extraction_field.key`,
    // which is exactly the synonym rule this change exists to delete — it is what
    // left `enzyme variant` and `Enzyme variant name` unbound while looking as
    // though the binding worked. Existing rows keep NULL and are bound when the
    // paper is re-extracted under `extraction@v20`, which asks for the key
    // directly. Copying `measurement.field_id` up is likewise skipped: the two
    // reads that need it already resolve through the measurement, and a partial
    // backfill would make a NULL mean two different things.
    version: 41,
    up: (db) => {
      const count = (t: string): number =>
        (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c
      // ADD COLUMN does not rewrite rows, but v14 and v40 both lost rows to a
      // step that looked incapable of it, and `integrity_check` came back clean
      // each time. 24 893 facts and the review verdicts hanging off them are
      // worth two counts.
      const before = { fact: count('fact'), measurement: count('measurement') }

      db.exec(SCHEMA_V41_FACT_FIELD)

      for (const [table, was] of Object.entries(before)) {
        const now = count(table)
        if (now !== was) throw new Error(`v41: ${table} went from ${was} to ${now} row(s)`)
      }
      // Asserted rather than assumed, the way v40 asserts its drops: a step whose
      // column did not arrive leaves every write silently binding nothing.
      const cols = (db.pragma('table_info(fact)') as Array<{ name: string }>).map((c) => c.name)
      if (!cols.includes('field_id')) throw new Error('v41: fact.field_id was not added')
    }
  },
  {
    // v42 — `project.summary_prompt`: the collection's own brief for its
    // project summaries.
    //
    // The reasoning is in `SCHEMA_V42_PROJECT_SUMMARY_PROMPT`. Nothing is
    // backfilled and nothing is invalidated: every existing project keeps NULL,
    // which resolves to the built-in brief, so every summary already written
    // resolves to the same `prompt_version` stamp it carries and stays current.
    // A step that wrote the built-in text into each row would look identical and
    // would leave the corpus pinned to today's wording forever.
    version: 42,
    up: (db) => {
      const count = (t: string): number =>
        (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c
      // Projects, and the summaries hanging off them. ADD COLUMN cannot lose
      // either, but v14, v40 and v41 all asserted the same thing about steps
      // that looked equally incapable of it.
      const before = {
        project: count('project'),
        analysis_run: count('analysis_run'),
        work_summary: count('work_summary')
      }

      db.exec(SCHEMA_V42_PROJECT_SUMMARY_PROMPT)

      for (const [table, was] of Object.entries(before)) {
        const now = count(table)
        if (now !== was) throw new Error(`v42: ${table} went from ${was} to ${now} row(s)`)
      }

      // ── Self-assertion. Throwing rolls the whole step back to v41. ────────
      const cols = (db.pragma('table_info(project)') as Array<{ name: string }>)
      const col = cols.find((c) => c.name === 'summary_prompt')
      if (!col) throw new Error('v42: project.summary_prompt was not added')

      // NULL, on every existing row, is the whole invalidation contract of this
      // change: it is what makes "the user has never customised anything" mean
      // "resolve the built-in", and it is what stops an upgrade re-writing a
      // corpus of summaries. A column that arrived carrying text would supersede
      // every project summary in the app on first launch.
      const nonNull = (
        db.prepare('SELECT COUNT(*) AS c FROM project WHERE summary_prompt IS NOT NULL').get() as {
          c: number
        }
      ).c
      if (nonNull !== 0) {
        throw new Error(`v42: ${nonNull} project(s) arrived with a non-NULL summary_prompt`)
      }
    }
  },
  {
    // v43 — SYNC IDENTITY. The reasoning is in `SCHEMA_V43_SYNC_IDENTITY`.
    //
    // APP schema, not plugin schema, and it stays in this list forever whether
    // a sharing plugin is installed or not. A plugin-owned step here
    // would mean deleting `plugins/` drops the target below the DB's
    // `user_version` and `runMigrations` refuses to open the file at all.
    //
    // Nothing is backfilled and nothing can be: a uuid is minted when a project
    // is first shared, and inventing one for every existing row would tell the
    // relay this corpus is already shared.
    version: 43,
    up: (db) => {
      const count = (t: string): number =>
        (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c
      const touched = [
        'project',
        'work',
        'analysis_run',
        'saved_search',
        'saved_frontier',
        'fact_verdict',
        'project_work'
      ] as const
      // ADD COLUMN cannot lose rows, and v14, v40, v41 and v42 all asserted the
      // same thing about steps that looked equally incapable of it.
      const before = Object.fromEntries(touched.map((t) => [t, count(t)]))

      db.exec(SCHEMA_V43_SYNC_IDENTITY)

      for (const [table, was] of Object.entries(before)) {
        const now = count(table)
        if (now !== was) throw new Error(`v43: ${table} went from ${was} to ${now} row(s)`)
      }

      // ── Self-assertions. Throwing rolls the whole step back to v42. ───────
      for (const table of touched) {
        const column = table === 'project_work' ? 'removed_at' : 'sync_uuid'
        const cols = (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(
          (c) => c.name
        )
        if (!cols.includes(column)) throw new Error(`v43: ${table}.${column} was not added`)
        // NULL on every existing row is the whole contract of this change: NULL
        // is what "this row has never been shared" MEANS, and it is what the
        // partial-unique indexes rely on to let unshared rows coexist. A column
        // that arrived carrying values would present the entire corpus to the
        // first relay it ever met as already published.
        const nonNull = (
          db
            .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${column} IS NOT NULL`)
            .get() as { c: number }
        ).c
        if (nonNull !== 0) {
          throw new Error(`v43: ${nonNull} ${table} row(s) arrived with a non-NULL ${column}`)
        }
      }

      // The indexes are the identity guarantee, not decoration: without them two
      // peers could both claim one uuid and every later join would pick one of
      // them arbitrarily.
      const indexes = new Set(
        (
          db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
            .all() as Array<{ name: string }>
        ).map((r) => r.name)
      )
      for (const ix of [
        'ux_project_sync_uuid',
        'ux_work_sync_uuid',
        'ux_analysis_run_sync_uuid',
        'ux_saved_search_sync_uuid',
        'ux_saved_frontier_sync_uuid',
        'ux_fact_verdict_sync_uuid'
      ]) {
        if (!indexes.has(ix)) throw new Error(`v43: index ${ix} was not created`)
      }
    }
  },
  {
    // v44 — `updated_at` COVERAGE + THE STAMPING TRIGGERS. Reasoning in
    // `SCHEMA_V44_UPDATED_AT` and `SCHEMA_V44_TRIGGERS`.
    //
    // No backfill: NULL means "never edited since it was created" and the
    // comparator falls back to `created_at`. A `created_at` backfill would be
    // byte-indistinguishable from every row in the corpus having been edited.
    version: 44,
    up: (db) => {
      const count = (t: string): number =>
        (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c
      const added = ['analysis_run', 'fact_verdict', 'project_schema'] as const
      const before = Object.fromEntries(
        [...added, 'project', 'work', 'project_work'].map((t) => [t, count(t)])
      )

      db.exec(SCHEMA_V44_UPDATED_AT)
      db.exec(SCHEMA_V44_TRIGGERS)

      for (const [table, was] of Object.entries(before)) {
        const now = count(table)
        if (now !== was) throw new Error(`v44: ${table} went from ${was} to ${now} row(s)`)
      }

      for (const table of added) {
        const cols = (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(
          (c) => c.name
        )
        if (!cols.includes('updated_at')) {
          throw new Error(`v44: ${table}.updated_at was not added`)
        }
        const nonNull = (
          db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE updated_at IS NOT NULL`).get() as {
            c: number
          }
        ).c
        if (nonNull !== 0) {
          throw new Error(`v44: ${nonNull} ${table} row(s) arrived with a non-NULL updated_at`)
        }
      }

      // Every synced table has its trigger, and every trigger stamps through
      // `relay_now()`. The second half is the load-bearing one: a trigger that
      // slipped back to `'now'` would stamp local time into a column the sync
      // comparator reads as relay time, and a peer with a fast clock would then
      // win every tie on every row. Checked here rather than only in a test,
      // because this step is also the one a later edit to the constant runs
      // through.
      const triggers = new Map(
        (
          db
            .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'")
            .all() as Array<{ name: string; sql: string | null }>
        ).map((r) => [r.name, r.sql ?? ''])
      )
      for (const table of SYNC_TOUCHED_TABLES) {
        const name = `trg_sync_touch_${table}`
        const sql = triggers.get(name)
        if (sql === undefined) throw new Error(`v44: trigger ${name} was not created`)
        if (!sql.includes('relay_now()')) {
          throw new Error(`v44: trigger ${name} does not stamp through relay_now()`)
        }
        if (/\bstrftime\s*\(|'now'/.test(sql)) {
          throw new Error(`v44: trigger ${name} uses the local clock`)
        }
      }

      // The triggers FIRE, asserted against a real row rather than assumed from
      // their presence in `sqlite_master`. A `WHEN` clause that never matches is
      // indistinguishable from a working trigger until a peer's older row
      // silently wins — and on an empty install there is no row to try, which is
      // a legitimate outcome and not a reason to fail the migration.
      const probe = db.prepare('SELECT id, updated_at FROM project LIMIT 1').get() as
        | { id: number; updated_at: string }
        | undefined
      if (probe) {
        db.prepare('UPDATE project SET description = description WHERE id = ?').run(probe.id)
        const after = (
          db.prepare('SELECT updated_at FROM project WHERE id = ?').get(probe.id) as {
            updated_at: string
          }
        ).updated_at
        if (after === probe.updated_at) {
          throw new Error('v44: trg_sync_touch_project did not stamp updated_at')
        }
        // Put it back. The probe must not present as an edit to a peer, and this
        // step runs inside the migration's own transaction, so an explicit write
        // (which the `IS NOT` guard lets through) restores it exactly.
        db.prepare('UPDATE project SET updated_at = ? WHERE id = ?').run(probe.updated_at, probe.id)
        const restored = (
          db.prepare('SELECT updated_at FROM project WHERE id = ?').get(probe.id) as {
            updated_at: string
          }
        ).updated_at
        if (restored !== probe.updated_at) {
          throw new Error('v44: an explicit updated_at write did not survive the trigger')
        }
      }
    }
  },
  {
    // THERE IS NO PIPELINE WITHOUT A DOCUMENT. Remove the ones that exist.
    //
    // `rerunRuns` paired the acting project with a retired run's `document_id`,
    // and a CORPUS-scoped run — `resolve-references`, `verify-citations` —
    // stores 0 there because it belongs to no paper. Only the project half of
    // that pair was guarded against the sentinel, so `(project, 0)` was planned
    // as though 0 were a real document and minted a second, complete pipeline
    // for the paper: thirteen jobs keyed `w3:d0:p1:*` beside its real
    // `w3:d3:p1:*` ones. `retrieve` then executed with `documentId = 0` and its
    // writes died on `FOREIGN KEY constraint failed`, four attempts deep, which
    // the user read as "Fetch PDF · Failed" on a paper already holding its PDF.
    //
    // The cause is fixed in `rerunRuns` and refused outright in `planPipeline`.
    // This clears what was already written, because those rows cannot ever run:
    // every one of them names a document that does not exist, so leaving them
    // is leaving a queue full of permanent failures.
    //
    // Matched on `document_id IS NULL` AND a real work: `planPipeline` writes
    // NULL for a document it could not resolve, while a legitimate corpus sweep
    // also has a NULL work. The pairing is what identifies the ghost.
    version: 45,
    up: (db) => {
      const ghosts = db
        .prepare(
          `SELECT id FROM processing_job
            WHERE work_id IS NOT NULL AND document_id IS NULL AND stage IS NOT NULL
              AND job_key LIKE '%:d0:%'`
        )
        .all() as Array<{ id: number }>
      for (const g of ghosts) {
        db.prepare('DELETE FROM job_dependency WHERE job_id = ? OR depends_on_job_id = ?').run(
          g.id,
          g.id
        )
        db.prepare('DELETE FROM processing_job WHERE id = ?').run(g.id)
      }

      // Their stage runs go too, for the same reason: a run keyed to document 0
      // holds a `ux_stage_run_current` slot that the paper's REAL run for that
      // stage should hold, so leaving them current would keep the paper looking
      // half-processed forever.
      db.prepare(
        `DELETE FROM stage_run
          WHERE work_id <> 0 AND document_id = 0`
      ).run()
    }
  },
  {
    // A TERMINAL ROW THAT SAYS `running` IS A LIE ABOUT WHAT HAPPENED.
    //
    // THREE paths retire a run without ever finishing it: `resumePending`
    // sweeping what a dead process abandoned, the supersede cascade a re-run
    // walks, and `cancel`. Each deletes the run's output, supersedes it, bumps
    // the lease epoch and stamps `finished_at` — and none moved `status` off
    // `running`. So a retired run kept claiming to be executing while also
    // recording when it ended, and a reader of the provenance could only
    // conclude that a stage both finished and did not.
    //
    // All three writers are fixed. This settles the rows already written: they
    // ended without producing anything, which is `failed`, and the error says so
    // rather than leaving the reason to be guessed. Scoped to rows that are BOTH
    // superseded and finished — a genuinely live run has no `finished_at`, and
    // must not be shot by a schema change.
    version: 46,
    up: (db) => {
      db.prepare(
        `UPDATE stage_run
            SET status = 'failed',
                error = COALESCE(error, 'the app closed while this stage was running')
          WHERE status = 'running' AND finished_at IS NOT NULL AND superseded = 1`
      ).run()
    }
  },
  {
    // v47 — the token ledger. See SCHEMA_V47_TOKEN_USAGE for why it carries no
    // foreign key to the paper it was spent on.
    version: 47,
    up: (db) => {
      db.exec(SCHEMA_V47_TOKEN_USAGE)

      // ── Self-assertions. Throwing rolls the whole step back to v46. ──
      const t = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='llm_token_usage'`)
        .get()
      if (!t) throw new Error('v47: llm_token_usage was not created')

      const cols = new Set(
        (db.pragma('table_info(llm_token_usage)') as Array<{ name: string }>).map((c) => c.name)
      )
      for (const c of [
        'at',
        'model',
        'stage',
        'work_id',
        'ok',
        'prompt_tokens',
        'completion_tokens',
        'total_tokens'
      ]) {
        if (!cols.has(c)) throw new Error(`v47: llm_token_usage.${c} was not created`)
      }
    }
  },
  {
    // v48 — the two thirds of the input v47 threw away. See
    // SCHEMA_V48_CACHE_TOKENS.
    version: 48,
    up: (db) => {
      db.exec(SCHEMA_V48_CACHE_TOKENS)

      // ── Self-assertions. Throwing rolls the whole step back to v47. ──
      const cols = new Set(
        (db.pragma('table_info(llm_token_usage)') as Array<{ name: string }>).map((c) => c.name)
      )
      for (const c of ['cache_creation_tokens', 'cache_read_tokens']) {
        if (!cols.has(c)) throw new Error(`v48: llm_token_usage.${c} was not created`)
      }
    }
  },
  {
    // v49 — `fact.kind` loses `assumed-from-field-convention`.
    //
    // The kind licensed the model to state a value the paper never printed,
    // inside a pipeline whose whole claim is that every value is anchored to the
    // paper. On this corpus not one of its 38 rows was a legitimate use: most
    // carried a verbatim quote and were simply mislabelled, and the rest had no
    // quote at all.
    //
    // The existing rows are split by whether an evidence span backs them, and
    // NEITHER half is promoted to `directly-reported`. Two of the quoted rows are
    // misreads — a 25 °C taken from `25 mM Hepes` and one from an induction
    // temperature — so promoting the set would launder a wrong value into the
    // strongest kind this app has. `uncertain-conflicting` is the one remaining
    // kind that means "a human must decide", and it routes them into the review
    // queue, which is where a claim of unknown standing belongs.
    //
    // An unquoted row is deleted: it is a bare number with nothing behind it, and
    // the rule going forward is that no fact is emitted for a field the paper
    // does not state. A row a reviewer has already ruled on is reclassified
    // instead — their verdict is data we did not create and may not destroy.
    version: 49,
    up: (db) => {
      const count = (sql: string): number =>
        (db.prepare(`SELECT COUNT(*) AS c ${sql}`).get() as { c: number }).c
      const factsBefore = count('FROM fact')

      db.exec(`
        CREATE TEMP TABLE fact_v49_unevidenced AS
          SELECT f.id FROM fact f
           LEFT JOIN evidence_span e ON e.id = f.evidence_span_id
           WHERE f.kind = 'assumed-from-field-convention'
             AND (e.id IS NULL OR e.quote IS NULL OR TRIM(e.quote) = '')
             AND NOT EXISTS (SELECT 1 FROM fact_verdict v WHERE v.fact_id = f.id);
      `)
      const deleting = count('FROM fact_v49_unevidenced')

      db.exec(`
        DELETE FROM analysis_check
         WHERE fact_id IN (SELECT id FROM fact_v49_unevidenced);
        DELETE FROM fact WHERE id IN (SELECT id FROM fact_v49_unevidenced);
        DROP TABLE fact_v49_unevidenced;

        UPDATE fact SET kind = 'uncertain-conflicting'
         WHERE kind = 'assumed-from-field-convention';
      `)

      // The CHECK itself. SQLite cannot alter a constraint in place, and `fact`
      // is referenced ON DELETE CASCADE by `measurement` and ON DELETE RESTRICT
      // by `fact_verdict` — v14 and v40's lesson is that DROP TABLE fires those
      // actions immediately, whatever `defer_foreign_keys` says. So the children
      // are stashed in TEMP tables, dropped, and copied back by name.
      db.pragma('defer_foreign_keys = ON')

      const measCols =
        'id, fact_id, quantity, value_num, value_text, unit, error_num, conditions, ' +
        'created_at, field_id, unit_canonical, value_canonical'
      const verdictCols =
        'id, fact_id, project_id, analysis_run_id, fact_fingerprint, verdict, ' +
        'corrected_value, note, reviewer, created_at, sync_uuid, updated_at'
      const factCols =
        'id, analysis_run_id, evidence_span_id, kind, predicate, subject, object, ' +
        'value_text, created_at, origin_run_id, field_id'
      const measBefore = count('FROM measurement')
      const verdictsBefore = count('FROM fact_verdict')
      const checksBefore = count('FROM analysis_check')

      db.exec(`
        CREATE TEMP TABLE fact_v49_rows AS SELECT ${factCols} FROM fact;
        CREATE TEMP TABLE measurement_v49 AS SELECT ${measCols} FROM measurement;
        CREATE TEMP TABLE fact_verdict_v49 AS SELECT ${verdictCols} FROM fact_verdict;
        CREATE TEMP TABLE analysis_check_v49_fact AS
          SELECT id, fact_id FROM analysis_check WHERE fact_id IS NOT NULL;
      `)
      if (count('FROM measurement_v49') !== measBefore)
        throw new Error('v49: measurement stash is short')
      if (count('FROM fact_verdict_v49') !== verdictsBefore)
        throw new Error('v49: fact_verdict stash is short')

      const measIndexes = (
        db
          .prepare(
            `SELECT sql FROM sqlite_master
              WHERE type='index' AND tbl_name='measurement' AND sql IS NOT NULL`
          )
          .all() as Array<{ sql: string }>
      ).map((r) => r.sql)
      const verdictIndexes = (
        db
          .prepare(
            `SELECT sql FROM sqlite_master
              WHERE type='index' AND tbl_name='fact_verdict' AND sql IS NOT NULL`
          )
          .all() as Array<{ sql: string }>
      ).map((r) => r.sql)
      const measTable = (
        db
          .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='measurement'`)
          .get() as { sql: string }
      ).sql
      const verdictTable = (
        db
          .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='fact_verdict'`)
          .get() as { sql: string }
      ).sql
      const measTriggers = (
        db
          .prepare(
            `SELECT sql FROM sqlite_master
              WHERE type='trigger' AND tbl_name='measurement' AND sql IS NOT NULL`
          )
          .all() as Array<{ sql: string }>
      ).map((r) => r.sql)
      const verdictTriggers = (
        db
          .prepare(
            `SELECT sql FROM sqlite_master
              WHERE type='trigger' AND tbl_name='fact_verdict' AND sql IS NOT NULL`
          )
          .all() as Array<{ sql: string }>
      ).map((r) => r.sql)

      db.exec(`
        UPDATE analysis_check SET fact_id = NULL WHERE fact_id IS NOT NULL;
        DROP TABLE measurement;
        DROP TABLE fact_verdict;
        DROP TABLE fact;
      `)
      db.exec(SCHEMA_V49_FACT)
      db.exec(`
        INSERT INTO fact
          (id, analysis_run_id, evidence_span_id, kind, predicate, subject, object,
           value_text, created_at, origin_run_id, field_id)
        SELECT id, analysis_run_id, evidence_span_id, kind, predicate, subject, object,
               value_text, created_at, origin_run_id, field_id
          FROM fact_v49_rows;
      `)
      db.exec(measTable)
      for (const sql of [...measIndexes, ...measTriggers]) db.exec(sql)
      db.exec(`INSERT INTO measurement (${measCols}) SELECT ${measCols} FROM measurement_v49;`)
      db.exec(verdictTable)
      for (const sql of [...verdictIndexes, ...verdictTriggers]) db.exec(sql)
      db.exec(
        `INSERT INTO fact_verdict (${verdictCols}) SELECT ${verdictCols} FROM fact_verdict_v49;`
      )
      db.exec(`
        UPDATE analysis_check
           SET fact_id = (SELECT s.fact_id FROM analysis_check_v49_fact s
                           WHERE s.id = analysis_check.id)
         WHERE id IN (SELECT id FROM analysis_check_v49_fact);
        DROP TABLE measurement_v49;
        DROP TABLE fact_verdict_v49;
        DROP TABLE analysis_check_v49_fact;
        DROP TABLE fact_v49_rows;
      `)

      // ── Self-assertions. Throwing rolls the whole step back to v48. ──
      if (count('FROM fact') !== factsBefore - deleting)
        throw new Error(`v49: fact went from ${factsBefore} to ${count('FROM fact')} (-${deleting})`)
      if (count('FROM measurement') !== measBefore)
        throw new Error('v49: measurement rows were lost in the rebuild')
      if (count('FROM fact_verdict') !== verdictsBefore)
        throw new Error('v49: fact_verdict rows were lost in the rebuild')
      if (count('FROM analysis_check') !== checksBefore)
        throw new Error('v49: analysis_check rows were lost in the rebuild')
      if (count(`FROM fact WHERE kind = 'assumed-from-field-convention'`) !== 0)
        throw new Error('v49: the removed kind survived')
      try {
        db.prepare(
          `INSERT INTO fact (analysis_run_id, kind, predicate, created_at)
             VALUES (0, 'assumed-from-field-convention', 'v49 probe', '')`
        ).run()
        throw new Error('v49: the CHECK still accepts the removed kind')
      }
      catch (e) {
        if (!/CHECK constraint failed/i.test(String(e))) throw e
      }
    }
  },
  {
    // v50 — sync the SHIPPED field descriptions to the cleaned presets.
    //
    // `schemaPresets.ts` was reworded and nothing carried that to the ROWS: a
    // preset seeds a NEW schema and never revisits an existing one, so every
    // corpus built before the edit still sends the old text on every
    // extraction. That is drift in data the APP shipped, and this repairs it.
    //
    // It is NOT a claim that a description may not be phrased as a direction.
    // Descriptions are written by whoever builds the schema — a scientist
    // describing their own column, not a prompt author — and "record it exactly
    // as reported" is an ordinary way to describe one. The app cannot police
    // that text and does not try to; `renderSchemaSpec` instead quotes every
    // description under an explicit attribution so none of them can speak in
    // the instruction voice. The two shipped lines that did real damage
    // (`method` reading as a DEFAULT, `temperature` naming the fact kind v49
    // deleted) are fixed BOTH ways: the wording here, and the framing there.
    //
    // Rows are matched on (key, description), so a description the user has
    // since written or edited is never touched — only text byte-identical to
    // what the preset shipped is replaced. `backfillSchemaHashes` then
    // recomputes `param_hash` and each schema version, marking runs made under
    // the old text stale, which is correct: they answered a different question.
    version: 50,
    up: (db) => {
      const repairs: Array<{ key: string; from: string; to: string }> = [
        {
          key: 'kcat',
          from: 'Turnover number from a steady-state fit. Record the value exactly as reported.',
          to: 'Turnover number from a steady-state fit.'
        },
        {
          key: 'km',
          from: 'Michaelis constant. Convert only if the paper states the unit ambiguously.',
          to: 'Michaelis constant.'
        },
        {
          key: 'kcat_km',
          from:
            'Catalytic efficiency. Prefer the reported value over one recomputed from kcat and KM.',
          to: 'Catalytic efficiency, as reported rather than recomputed from kcat and KM.'
        },
        {
          key: 'temperature',
          from:
            'Assay temperature in degrees Celsius. Mark as assumed-from-field-convention if only implied.',
          to: 'Assay temperature in degrees Celsius.'
        },
        {
          key: 'ddg',
          from:
            'Change in unfolding free energy relative to the stated reference variant. Preserve the sign as reported.',
          to: 'Change in unfolding free energy relative to the stated reference variant, signed as reported.'
        },
        {
          key: 'method',
          from:
            'Biophysical method used. Use thermal-challenge for activity-loss assays with no spectroscopic melt.',
          to: 'Biophysical method used. thermal-challenge is an activity-loss assay with no spectroscopic melt.'
        }
      ]
      const update = db.prepare(
        `UPDATE extraction_field SET description = ? WHERE key = ? AND description = ?`
      )
      let repaired = 0
      for (const r of repairs) repaired += update.run(r.to, r.key, r.from).changes

      // Only when something moved. The recompute marks every run made under the
      // old text stale, and a corpus that never carried the drift must not have
      // its provenance disturbed by a migration that found nothing to repair.
      if (repaired > 0) backfillSchemaHashes(db)

      // ── Self-assertions. Throwing rolls the whole step back to v49. ──
      //
      // `assumed-from-field-convention` only: v49 removed that kind from the
      // `fact.kind` CHECK, so a shipped description still naming it asks for
      // something the database cannot store. Nothing here asserts on PHRASING —
      // a user's own description may say whatever they like.
      const stale = db
        .prepare(
          `SELECT id, key FROM extraction_field
            WHERE description LIKE '%assumed-from-field-convention%'`
        )
        .all() as Array<{ id: number; key: string }>
      if (stale.length > 0) {
        throw new Error(
          `v50: a description still names the fact kind v49 removed: ${stale
            .map((f) => `${f.id} (${f.key})`)
            .join(', ')}`
        )
      }
      if (repaired > 0) {
        const unhashed = (
          db.prepare(`SELECT COUNT(*) AS c FROM extraction_field WHERE param_hash = ''`).get() as {
            c: number
          }
        ).c
        if (unhashed > 0) throw new Error(`v50: ${unhashed} field(s) left with no param_hash`)
      }
    }
  },
  {
    // v51 — no field constrains its value to a list of options.
    //
    // A field could declare `one of: A | B | C`; the list was printed into the
    // prompt and enforced at validation. Where a paper named a listed value that
    // worked. Where a paper named NOTHING it manufactured one — the nearest
    // option, stored with a real quote beside it. Twelve fabrications on one
    // paper, then a different wrong option on each of three following prompt
    // versions, each quoting a passage that names no such thing. Rewording
    // changed WHICH option was invented, never whether one was.
    //
    // A number can report partial knowledge; one of N strings cannot, so the
    // pressure to answer had nowhere to go. The field now takes what the page
    // prints, or takes no fact at all. Grouping synonyms is a job for reading
    // the results, where it decides nothing about what the paper said.
    //
    // SEPARATE FROM v50 deliberately: this corpus reached user_version 50 while
    // that step was still being written, and a migration already applied never
    // runs again — so an edit folded back into v50 would be dead on exactly the
    // databases that need it.
    //
    // Stored values are KEPT. They are what a reading produced, and a migration
    // may not restate a reading; the hash recompute marks their runs stale,
    // which is the honest outcome.
    //
    // `required` goes with it. A field marked required told the model a paper
    // owed it an answer, and a paper owes nothing — the prompt no longer says
    // it, and a stored flag that contradicts the prompt is the same demand
    // wearing a different hat.
    version: 51,
    up: (db) => {
      const demoted = db
        .prepare(
          `UPDATE extraction_field SET data_type = 'text', enum_options = NULL
            WHERE data_type = 'enum'`
        )
        .run().changes
      const unrequired = db
        .prepare(`UPDATE extraction_field SET required = 0 WHERE required = 1`)
        .run().changes
      if (demoted > 0 || unrequired > 0) backfillSchemaHashes(db)

      // ── Self-assertions. Throwing rolls the whole step back to v50. ──
      const left = (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM extraction_field
              WHERE data_type = 'enum' OR enum_options IS NOT NULL OR required = 1`
          )
          .get() as { c: number }
      ).c
      if (left > 0) throw new Error(`v51: ${left} field(s) still constrain or demand an answer`)
    }
  },
  {
    // v52 — `fact.retracted_by_check_id`: the reviewer may say a record should
    // not exist.
    //
    // The reasoning is in `SCHEMA_V52_FACT_RETRACTION`. Nothing is BACKFILLED,
    // and the tempting backfill is the dangerous one: a `failed` review verdict
    // means "the paper does not support this", which is a record a human must
    // settle, not one the reader has withdrawn. Marking those retracted would
    // withdraw every contradicted record this corpus holds on the strength of a
    // judgement nobody made. NULL means "nobody has retracted this", which is
    // the state every existing row is genuinely in.
    version: 52,
    up: (db) => {
      const count = (t: string): number =>
        (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c
      // v14, v40 and v41 each asserted this about a step that looked equally
      // incapable of losing a row, and v14 and v40 were both right to.
      const before = { fact: count('fact'), analysis_check: count('analysis_check') }

      db.exec(SCHEMA_V52_FACT_RETRACTION)

      for (const [table, was] of Object.entries(before)) {
        const now = count(table)
        if (now !== was) throw new Error(`v52: ${table} went from ${was} to ${now} row(s)`)
      }
      // ── Self-assertions. Throwing rolls the whole step back to v51. ──
      //
      // A column that did not arrive leaves every retraction write silently
      // failing, and every reader's `IS NULL` predicate referring to nothing.
      const cols = (db.pragma('table_info(fact)') as Array<{ name: string }>).map((c) => c.name)
      if (!cols.includes('retracted_by_check_id'))
        throw new Error('v52: fact.retracted_by_check_id was not added')
      // Nothing may arrive retracted. The step adds a column and writes no row;
      // a non-zero count here would mean something backfilled a judgement.
      const marked = (
        db
          .prepare(`SELECT COUNT(*) AS c FROM fact WHERE retracted_by_check_id IS NOT NULL`)
          .get() as { c: number }
      ).c
      if (marked > 0) throw new Error(`v52: ${marked} fact(s) arrived already retracted`)
    }
  },
  {
    /**
     * Carry a working install's paper search across the release that turned the
     * browser extension into a plugin.
     *
     * Before this release, searching for new papers and fetching PDFs were built
     * into the app: a user with the extension installed simply had them. They are
     * now a plugin, and a plugin nobody has switched on does nothing — so without
     * this step the upgrade would silently take search away from an install where
     * it was working, and the only symptom would be a tab that is no longer
     * there. That is the one outcome this refactor may not have.
     *
     * ONLY ON AN UPGRADE. `runMigrations` applies every step above
     * `user_version`, and a fresh database starts at 0, so an unguarded write
     * here would run on a brand-new install too — switching a plugin on for a
     * scientist who has just opened the app and consented to nothing, against the
     * rule that a fresh install starts empty.
     *
     * NEVER OVER AN EXISTING DECISION, including a removal. The row is written
     * only when there is no answer recorded either way, so this is an initial
     * value rather than an override: a user who removes the plugin, or switches
     * it off, stays where they put it if a later release ever re-runs a step like
     * this one.
     *
     * It discloses nothing new — the extension was already running for exactly
     * these users — so adopting it on their behalf bypasses no consent.
     */
    version: 53,
    up: (db, ctx) => {
      if (!ctx.upgrade) return
      const id = 'corpus-retriever'
      const has = (key: string): boolean =>
        db.prepare('SELECT 1 FROM setting WHERE key = ?').get(key) !== undefined
      if (has(`plugin.${id}.enabled`) || has(`plugin.${id}.removed`)) return
      db.prepare('INSERT INTO setting (key, value, updated_at) VALUES (?, ?, ?)').run(
        `plugin.${id}.enabled`,
        '1',
        new Date().toISOString()
      )
    }
  },
  {
    /**
     * Tell a lettered SUB-REFERENCE apart from the entry that printed it.
     *
     * ACS and Angewandte pack several papers into one number — `(11) (a) … (b)
     * … (c) …` — and the parser emits the composite BESIDE one row per part, so
     * each cited paper can be matched and retrieved on its own. Every one of
     * them carries the parent's ordinal, and nothing recorded which was which.
     *
     * So the row count silently stopped being the reference count: work 21 of
     * the KE07 corpus prints 44 references and stores 83 rows. Nine call sites
     * read it as the reference count anyway — most damagingly a confidence gate
     * that divided distinct cited ordinals (at most 44) by rows (83) and
     * refused to link the citations of a paper whose citations it had in fact
     * found, and an outline-vs-prose comparison that exists to catch prose
     * over-splitting and was itself fooled by it.
     *
     * NULLABLE and BACKFILLED TO NULL, which is the honest state: null means
     * "not a part", and every row that predates this column was stored without
     * the distinction being knowable. The parse is re-run per paper by the
     * ordinary staleness cascade — `PARSER_VERSION` moved with this change — so
     * the rows correct themselves as each paper is re-read rather than being
     * guessed at here from text this migration would have to re-parse.
     */
    version: 54,
    up: (db) => {
      // Guarded per-column like v11/v12/v13: `part_label` is ALREADY in
      // SCHEMA_V1, so on a fresh database this step ran against a table that
      // had the column and aborted the whole migration with "duplicate column
      // name". Every new install failed to open at all; only databases created
      // before the consolidation got this far.
      const cols = (
        db.pragma('table_info(unresolved_reference)') as Array<{ name: string }>
      ).map((c) => c.name)
      if (!cols.includes('part_label')) {
        db.exec(`ALTER TABLE unresolved_reference ADD COLUMN part_label TEXT`)
      }
    }
  },
  {
    /**
     * A project's own account of what it is for, and whether it has given one.
     *
     * Creating a project used to be a dialog: a name, a one-line research
     * question, a schema picker, and then an empty app. Everything that makes
     * the collection answerable — the questions it puts, the material its
     * answers are read against — was left to be found later on four different
     * screens, and most projects never acquired any of it. The questionnaire
     * that replaces the dialog needs somewhere to live between sessions, since
     * it stays open for as long as importing and reading a handful of papers
     * takes.
     *
     * `description` is UNCHANGED and still the only string the prompts read;
     * `goal` and `questions` are composed into it on every write. Storing the
     * two halves as well is what lets the form reopen with the user's own words
     * in the fields they typed them into.
     *
     * `questions` is a JSON ARRAY, not a blob. The form renders one row per
     * question and the model is handed them as a list, so the boundaries
     * between them are load-bearing; stored as prose, recovering those later
     * means splitting on punctuation and guessing where a question ended.
     *
     * Every existing row is 'done' by the column default. The alternative
     * reopens a form in front of every project already in a library, and that
     * form has no exit by design.
     */
    version: 55,
    up: (db) => {
      // Guarded per-column, like the steps above it. The step directly before
      // this one was NOT, and a later consolidation of its column into
      // SCHEMA_V1 stopped every fresh database from opening.
      const cols = (db.pragma('table_info(project)') as Array<{ name: string }>).map((c) => c.name)
      if (!cols.includes('setup_state')) {
        db.exec(`ALTER TABLE project ADD COLUMN setup_state TEXT NOT NULL DEFAULT 'done'`)
      }
      if (!cols.includes('goal')) db.exec('ALTER TABLE project ADD COLUMN goal TEXT')
      if (!cols.includes('questions')) db.exec('ALTER TABLE project ADD COLUMN questions TEXT')
    }
  },
  {
    /**
     * WITHDRAWN. This step is deliberately empty.
     *
     * It stripped JATS/HTML out of stored titles and abstracts, on the reasoning
     * that React escapes markup so the reader sees `<i>trans</i>` rather than
     * italics. Removing the tags was the wrong half of that sentence: the markup
     * is INFORMATION the publisher encoded — italics mark a species name and
     * distinguish `trans` as stereochemistry, and a subscript is part of a
     * formula. `T<sub>m</sub>` flattened to `Tm` is a different string from the
     * one the paper prints, in an app whose entire claim is fidelity to the
     * source. The answer was always to RENDER it (`RichText` in the renderer)
     * and to strip only for the consumers that genuinely need plain words.
     *
     * EMPTIED RATHER THAN DELETED, and rather than edited. `user_version` had
     * already reached 56 on databases that ran it, so a deleted step would drop
     * the target below the number on disk and `runMigrations` refuses to open
     * the file at all; an edited step would simply never execute there. The
     * repair for the rows it damaged is step 57, which every database reaches
     * whether or not it ever ran this one.
     */
    version: 56,
    up: () => {
      /* withdrawn — see above */
    }
  },
  {
    /**
     * Repair the one artefact step 56 left that IS reconstructible.
     *
     * That step deleted inline markup from `work.title`, `work.abstract` and
     * `work.venue`. The tags are gone from those rows and cannot be recovered
     * from the text that remains — a title is not re-derivable from itself, and
     * this migration deliberately does NOT go to the network to fetch one.
     * Re-importing the paper is what restores the publisher's string, and that
     * is the user's decision to make, not a migration's.
     *
     * NOR IS THE SPACING SCAR WORTH CHASING. Stripping `<i>trans</i>` from
     * `Pectate <i>trans</i>-Eliminase` leaves a stranded space before the
     * hyphen, and collapsing `' -'` to `'-'` looks like a safe repair. It is
     * not: tested against ordinary titles it turned `Enzyme design - a review`
     * into `Enzyme design- a review`, damaging a row that was never touched by
     * the strip. A repair that corrupts correct data to tidy incorrect data is
     * worse than the artefact.
     *
     * So this step is a NO-OP, and exists only to hold the version number and
     * this explanation. The affected titles remain readable — they have lost
     * their italics and gained a stray space. Re-importing such a paper
     * restores the publisher's string, and that is the user's call.
     */
    version: 57,
    up: () => {
      /* nothing is safely repairable here — see above */
    }
  },
  {
    /**
     * A step with nothing left to do, kept so the version numbers stay dense.
     *
     * It re-scored every project under a scoring rule that has since been
     * withdrawn entirely: relevance is now a local cross-encoder's answer about
     * a (project description, paper) pair, written by the `rerank` sweep, and
     * the arithmetic this step re-ran no longer exists to re-run.
     *
     * DOING NOTHING IS CORRECT ON BOTH KINDS OF DATABASE, which is the claim
     * worth checking rather than assuming. An install that already passed 58 has
     * had this applied, and the scores it produced are superseded by the sweep's
     * on the first run either way. A database that has NOT passed 58 is one
     * being created now, and a fresh corpus has no projects and no `project_work`
     * rows at all — so the loop this held would have iterated zero times. There
     * is no third case: the migration runner never skips a version.
     *
     * NOT DELETED. Removing it would renumber nothing but would leave `59` as
     * the successor of `57`, and a runner comparing stored version against the
     * list's length has one fewer step to reach — a gap is cheaper to read than
     * a renumbering is to get right.
     */
    version: 58,
    up: () => {
      /* see above — the ranker this re-ran no longer exists */
    }
  },
  {
    /**
     * Somewhere to keep an abstract fetched for a reference this corpus has only
     * ever seen printed.
     *
     * A paper's own relevance can be judged because the corpus holds its
     * abstract. A reference it cites usually has nothing but the characters the
     * bibliography printed, so it cannot be judged at all — and those references
     * are precisely the papers a user is deciding whether to go and read. An
     * outside index will supply the missing paragraph; this table is where that
     * answer lands, with the provenance that says which index gave it and how it
     * was matched.
     *
     * SEPARATE FROM `unresolved_reference`, not four more columns on it. That
     * table records what the PAPER printed; this records what an INDEX believes,
     * which is the same line `references/external/types.ts` draws and for the
     * same reason. It is also the only shape that survives the good outcome:
     * promotion DELETES the unresolved row, so an abstract stored on it would be
     * destroyed at the moment the reference finally became a real paper.
     *
     * The FK's nullability, `ON DELETE SET NULL`, the four-value `outcome` and
     * the two indexes are each load-bearing and each argued at
     * `SCHEMA_V59_REFERENCE_ABSTRACT`. The one worth repeating here, because it
     * is what a reader of this list would otherwise assume was an oversight: the
     * FK is released rather than cascaded because SQLite REUSES a deleted
     * `unresolved_reference.id`, so a row left holding one would later attach
     * this paper's abstract to an unrelated reference — and cascading instead
     * would delete the record exactly when it succeeded.
     *
     * NOTHING IS BACKFILLED. The table is empty on every install until the fetch
     * runs, and an empty table is the truthful state: no index has been asked
     * about any of these references yet. Writing a placeholder row per reference
     * would mean inventing an `outcome` for a request that never happened.
     */
    version: 59,
    up: (db) => {
      db.exec(SCHEMA_V59_REFERENCE_ABSTRACT)
    }
  },
  {
    /**
     * Finish `reference_abstract` — the four columns, the uniqueness and the
     * fifth outcome that v59 was written without.
     *
     * v59 was built from an abbreviated column list rather than from the design
     * it was implementing, so the table can say WHICH local reference an
     * abstract hangs off but not WHAT was fetched, WHAT came back, HOW close the
     * match was, or UNDER WHICH rules it was accepted — and nothing stops two
     * rows claiming one reference. Each addition is argued at
     * `SCHEMA_V60_REFERENCE_ABSTRACT`; the short version is that a title match
     * with no `matched_title` and no `match_confidence` is a claim no human can
     * check, and a table with no `fetcher_version` cannot be told when the rules
     * that accepted it are withdrawn.
     *
     * The four columns and the index could be added in place. `outcome` cannot:
     * SQLite has no way to alter a CHECK, and 'ambiguous' — a title search
     * returned more than one plausible paper — must be storable, because it is
     * the one outcome a user can act on by correcting the title, and the only
     * non-network case where retrying is right. So the whole table is rebuilt
     * the way v14, v40 and v49 rebuild one.
     *
     * NO CHILD TABLE STASHING IS NEEDED HERE, which is what makes this the short
     * version of that pattern rather than the long one: nothing references
     * `reference_abstract`, so the DROP fires no ON DELETE action anywhere. It
     * is only ever a child, of `unresolved_reference` and of `work` twice, and
     * dropping a child touches neither parent. `defer_foreign_keys` is still set
     * because the copy re-inserts rows naming those parents.
     *
     * The rebuild copies rows rather than assuming none: v59 has been live, and
     * a migration that is only correct on an empty table is a migration that is
     * correct until someone runs the fetcher first. The row count is asserted
     * across the swap, and the new CHECK is probed at the end — throwing rolls
     * the step back to v59 whole.
     */
    version: 60,
    up: (db) => {
      const count = (sql: string): number =>
        (db.prepare(`SELECT COUNT(*) AS c ${sql}`).get() as { c: number }).c
      const before = count('FROM reference_abstract')

      // The v59 column list, verbatim. Named rather than `SELECT *` so that a
      // future column added to the old table cannot silently change the order
      // the copy is written in.
      const oldCols =
        'id, unresolved_reference_id, citing_work_id, work_id, abstract, source, ' +
        'matched_by, outcome, fetched_at, error'

      db.pragma('defer_foreign_keys = ON')
      db.exec(`CREATE TEMP TABLE reference_abstract_v60 AS SELECT ${oldCols} FROM reference_abstract;`)
      if (count('FROM reference_abstract_v60') !== before)
        throw new Error('v60: the reference_abstract stash is short')

      db.exec('DROP TABLE reference_abstract;')
      db.exec(SCHEMA_V60_REFERENCE_ABSTRACT)
      // `doi`, `matched_title`, `match_confidence` are left NULL and
      // `fetcher_version` takes its default: no existing row recorded any of
      // them, and there is nothing to derive them from. A backfilled value here
      // would be an invention about a fetch that already happened.
      db.exec(`
        INSERT INTO reference_abstract (${oldCols})
        SELECT ${oldCols} FROM reference_abstract_v60;
      `)
      db.exec('DROP TABLE reference_abstract_v60;')

      if (count('FROM reference_abstract') !== before)
        throw new Error(`v60: reference_abstract went from ${before} rows to ${count('FROM reference_abstract')}`)
      if (count(`FROM reference_abstract WHERE fetcher_version IS NULL`) !== 0)
        throw new Error('v60: fetcher_version did not take its default')

      const probeCiting = (
        db.prepare(`SELECT id FROM work ORDER BY id LIMIT 1`).get() as { id: number } | undefined
      )?.id
      if (probeCiting !== undefined) {
        const probe = db.transaction(() => {
          db.prepare(
            `INSERT INTO reference_abstract (citing_work_id, outcome, fetched_at)
               VALUES (?, 'ambiguous', '')`
          ).run(probeCiting)
          let rejected = false
          try {
            db.prepare(
              `INSERT INTO reference_abstract (citing_work_id, outcome, fetched_at)
                 VALUES (?, 'no-identifier', '')`
            ).run(probeCiting)
          }
          catch (e) {
            if (!/CHECK constraint failed/i.test(String(e))) throw e
            rejected = true
          }
          if (!rejected) throw new Error('v60: the outcome CHECK accepts a value it should not')
          throw new Error('v60-probe-rollback')
        })
        try {
          probe()
        }
        catch (e) {
          if (String(e).indexOf('v60-probe-rollback') < 0) throw e
        }
      }
    }
  },
  {
    /**
     * `matched_by` learns the word for the rule that actually runs.
     *
     * The title gate is gone. A reference without a DOI is now matched by
     * sending its whole printed bibliography line to Crossref's reference
     * matcher and comparing the volume and first page that come back against
     * the ones the line itself printed — equal or not, nothing to tune. So the
     * evidence behind such a row is the bibliographic entry, and the column
     * that exists to tell a reader WHAT admitted it must not still say 'title'.
     * The argument for the value, and for keeping the old one, is at
     * `SCHEMA_V61_REFERENCE_ABSTRACT`.
     *
     * v60's rebuild, verbatim in structure and for the same reason: SQLite has
     * no way to alter a CHECK. Nothing references `reference_abstract`, so the
     * DROP fires no ON DELETE action; `defer_foreign_keys` is still set because
     * the copy re-inserts rows naming `work` and `unresolved_reference`. Rows
     * are copied rather than assumed absent, the count is asserted across the
     * swap, and the new CHECK is probed at the end — throwing rolls the step
     * back to v60 whole.
     */
    version: 61,
    up: (db) => {
      const count = (sql: string): number =>
        (db.prepare(`SELECT COUNT(*) AS c ${sql}`).get() as { c: number }).c
      const before = count('FROM reference_abstract')

      // v60's column list, verbatim and named, so a column added later cannot
      // silently change the order the copy is written in.
      const cols =
        'id, unresolved_reference_id, citing_work_id, work_id, doi, matched_title, ' +
        'abstract, source, matched_by, match_confidence, outcome, fetcher_version, ' +
        'fetched_at, error'

      db.pragma('defer_foreign_keys = ON')
      db.exec(`CREATE TEMP TABLE reference_abstract_v61 AS SELECT ${cols} FROM reference_abstract;`)
      if (count('FROM reference_abstract_v61') !== before)
        throw new Error('v61: the reference_abstract stash is short')

      db.exec('DROP TABLE reference_abstract;')
      db.exec(SCHEMA_V61_REFERENCE_ABSTRACT)
      db.exec(`
        INSERT INTO reference_abstract (${cols})
        SELECT ${cols} FROM reference_abstract_v61;
      `)
      db.exec('DROP TABLE reference_abstract_v61;')

      if (count('FROM reference_abstract') !== before)
        throw new Error(
          `v61: reference_abstract went from ${before} rows to ${count('FROM reference_abstract')}`
        )

      const probeCiting = (
        db.prepare(`SELECT id FROM work ORDER BY id LIMIT 1`).get() as { id: number } | undefined
      )?.id
      if (probeCiting !== undefined) {
        const probe = db.transaction(() => {
          db.prepare(
            `INSERT INTO reference_abstract (citing_work_id, outcome, matched_by, fetched_at)
               VALUES (?, 'found', 'bibliographic', '')`
          ).run(probeCiting)
          let rejected = false
          try {
            db.prepare(
              `INSERT INTO reference_abstract (citing_work_id, outcome, matched_by, fetched_at)
                 VALUES (?, 'found', 'title-search', '')`
            ).run(probeCiting)
          }
          catch (e) {
            if (!/CHECK constraint failed/i.test(String(e))) throw e
            rejected = true
          }
          if (!rejected) throw new Error('v61: the matched_by CHECK accepts a value it should not')
          throw new Error('v61-probe-rollback')
        })
        try {
          probe()
        }
        catch (e) {
          if (String(e).indexOf('v61-probe-rollback') < 0) throw e
        }
      }
    }
  },
  {
    /**
     * `ask_key` — which question a row is the answer to, so the next paper
     * citing the same reference does not ask it again.
     *
     * The reasoning for the column and for the shape of the key is at
     * `SCHEMA_V62_REFERENCE_ABSTRACT_ASK_KEY`. The short version: one paper is
     * cited by many of ours and stored once per bibliography, so the corpus
     * asks a public index the same question up to ten times.
     *
     * AN ADD COLUMN, not v60's rebuild: no CHECK changes, and SQLite alters a
     * table by appending a nullable column without touching a row. Existing rows
     * get NULL, which is the correct value for them rather than a placeholder —
     * NULL means "not reusable", and a row fetched before the key existed cannot
     * be matched to a later reference without re-deriving a key from a
     * bibliography line this step does not have. They keep their abstracts and
     * are simply never reused; the next reference that shares their identity
     * asks once and writes a keyed row that IS reused thereafter.
     */
    version: 62,
    up: (db) => {
      const has = (col: string): boolean =>
        (db.prepare(`PRAGMA table_info(reference_abstract)`).all() as Array<{ name: string }>).some(
          (c) => c.name === col
        )
      if (has('ask_key')) return
      db.exec(SCHEMA_V62_REFERENCE_ABSTRACT_ASK_KEY)
      if (!has('ask_key')) throw new Error('v62: reference_abstract.ask_key was not added')
    }
  },
  {
    /**
     * `project_work.scored_on` — WHICH text a relevance score was read from.
     *
     * A relevance score is about to stop being an arithmetic of invented weights
     * and start being a cross-encoder's answer about a (project question, paper
     * text) pair. That answer is a statement about the text the model was shown,
     * and the app cannot show it the same amount of text for every paper: some
     * papers have an abstract on record and some are a title. A title-only score
     * is lower for a reason that is nothing to do with the paper's relevance, and
     * without this column the two sit in one sorted list with nothing to tell
     * them apart. The argument in full is at `SCHEMA_V63_PROJECT_WORK_SCORED_ON`.
     *
     * ADD COLUMN, no rebuild: no CHECK constrains it. The values a writer may put
     * there are the stage's business, and pinning them in a CHECK would make the
     * next kind of passage — a paper scored on its full text — a table rebuild.
     * Existing rows get NULL, which reads as "no reranker has looked at this
     * yet" and is exactly true of every row in every database today.
     */
    version: 63,
    up: (db) => {
      const has = (col: string): boolean =>
        (db.prepare(`PRAGMA table_info(project_work)`).all() as Array<{ name: string }>).some(
          (c) => c.name === col
        )
      if (has('scored_on')) return
      db.exec(SCHEMA_V63_PROJECT_WORK_SCORED_ON)
      if (!has('scored_on')) throw new Error('v63: project_work.scored_on was not added')
    }
  },
  {
    /**
     * Give a project written before the questionnaire something to edit.
     *
     * `goal` and `questions` arrived with the setup form; a project created
     * before it has both NULL and carries its whole self-description as free
     * prose in `description`. That was harmless while `description` was only
     * displayed. It is not harmless now: the description is the reranker's
     * query, the Project context tab is about to offer an Edit control, and
     * that control writes `goal` and `questions` — so an older project would
     * open its editor onto two empty fields and a Save would replace a
     * paragraph the user wrote with nothing.
     *
     * `goal = description`, and questions stay EMPTY. `composeProjectDescription`
     * never produced this prose, so no parse recovers real questions from it —
     * splitting on a heading it does not contain would either fail or invent
     * questions the user never asked, and a question nobody asked steers every
     * later ranking. An empty list is the true statement, and the new editor is
     * where the user fills it in.
     *
     * The description is then RECOMPOSED rather than left as it was, so the row
     * is structurally identical to a form-authored one. With no questions the
     * composition is the trimmed goal, so this is a no-op on the text for every
     * row it touches — and stops being one the moment the user adds a question.
     *
     * Only rows where `goal IS NULL`: a project that has been through the form
     * already holds the authored version, and copying a composed description
     * back over its own goal would fold the questions into it and duplicate
     * them on the next write.
     */
    version: 64,
    up: (db) => {
      const rows = db
        .prepare(
          `SELECT id, description FROM project
            WHERE goal IS NULL AND description IS NOT NULL AND trim(description) <> ''`
        )
        .all() as Array<{ id: number; description: string }>
      const write = db.prepare(
        `UPDATE project SET goal = ?, questions = '[]', description = ? WHERE id = ?`
      )
      for (const r of rows) {
        const goal = r.description.trim()
        write.run(goal, composeProjectDescription(goal, []), r.id)
      }
    }
  },
  {
    /**
     * `reference_abstract.relevance` — how near each reference is to a project's
     * question, and whose question that was.
     *
     * Expansion priority is about to stop being a bibliography COUNT and become
     * the mean of these numbers. Size counts references without caring what they
     * are, so a paper with 200 off-topic references outranked one with 30
     * on-topic ones; the mean asks how relevant a paper's reading list is on
     * average, which is what "how much relevant territory would following these
     * citations open" actually means. That mean needs a per-reference score to
     * average, and this is where it lives. The argument for the third column —
     * why a score must name the project it answers for — is at
     * `SCHEMA_V65_REFERENCE_ABSTRACT_RELEVANCE`.
     *
     * THREE ADD COLUMNs, no rebuild: no CHECK changes and no index moves.
     * Existing rows get NULL for all three, which is exactly true of them — an
     * abstract fetched before a reranker ever looked has not been scored, and
     * writing a 0 would put a verdict on every reference in every corpus.
     */
    version: 65,
    up: (db) => {
      const has = (col: string): boolean =>
        (
          db.prepare(`PRAGMA table_info(reference_abstract)`).all() as Array<{ name: string }>
        ).some((c) => c.name === col)
      if (has('relevance')) return
      db.exec(SCHEMA_V65_REFERENCE_ABSTRACT_RELEVANCE)
      for (const col of ['relevance', 'scored_on', 'scored_for_project_id']) {
        if (!has(col)) throw new Error(`v65: reference_abstract.${col} was not added`)
      }
    }
  },
  {
    /**
     * `work_type` learns the word `method`.
     *
     * The Connectome filters papers by kind, and `work_type` is the column it
     * reads. Everything that column has ever held came from a bibliographic
     * index, which answers a CATALOGUING question — Crossref calls a review, a
     * software paper and a primary study `journal-article` alike, and does so
     * for 22 of the 23 works in this corpus. `review` was already a permitted
     * value and is occasionally reported; the tool paper has never had a word
     * at all, so the filter for it could not match a single row of any database
     * this app has written. The general summary now supplies both, from the
     * document, and it needs somewhere to put the second.
     *
     * `foundational` is NOT added, though a chip asks for it. It is not a kind
     * of paper: a work is foundational TO a body of work, which makes it a
     * relation between a paper and a corpus and not a property of the paper —
     * the same ontology rule that keeps a project's reading of a paper off the
     * global `work` row. The graph already answers it by counting how often the
     * corpus actually cites the paper, which is a measurement of the relation
     * rather than a label asserting it.
     *
     * ── WHY THIS REWRITES THE CHECK IN PLACE AND DOES NOT REBUILD ────────────
     * The 12-step rebuild v60 and v61 perform is correct for a LEAF table. On
     * `work` it is destructive: 25 tables reference it, most ON DELETE CASCADE,
     * and `DROP TABLE work` fires the implicit DELETE and runs those cascades
     * IMMEDIATELY — `defer_foreign_keys` defers violation CHECKING, not action
     * clauses (v14's and v40's lesson). Measured here on a copy of the live
     * corpus: the rebuild took `document` 23 -> 0, `project_work` 24 -> 0 and
     * `citation_link` 256 -> 0, and `foreign_key_check` came back EMPTY
     * afterwards, so `runMigrations`' own post-assertion would have passed over
     * an emptied database. Stashing 25 children and restoring them is a great
     * deal of machinery whose failure mode is silent data loss.
     *
     * Nothing about the table's CONTENT changes — no column, no type, no index,
     * no row — only the set of strings one CHECK admits. So the stored DDL is
     * edited and `schema_version` bumped so every connection reparses it. The
     * edit is a substitution on the exact text of the v1 CHECK: if the table
     * does not read as expected the step THROWS rather than writing a schema it
     * composed itself, because a malformed `sqlite_master` row is a database
     * that will not open. The new CHECK is then probed — `method` accepted, a
     * value outside the list still rejected — and the row counts of the four
     * largest children asserted, which is the check that would have caught the
     * rebuild.
     */
    version: 66,
    up: (db) => {
      const table = (
        db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='work'`).get() as
          | { sql: string }
          | undefined
      )?.sql
      if (!table) throw new Error('v66: there is no `work` table')
      if (/'method'/.test(table)) return

      // The v1 text, verbatim. Anchored on the tail of the list so the
      // substitution can land in exactly one place; anything else means this
      // database's `work` is not the shape this step was written against, and
      // guessing at it would write a schema nobody has read.
      const OLD_TAIL = `'book','book-chapter','review','dataset','thesis','other')`
      const NEW_TAIL = `'book','book-chapter','review','method','dataset','thesis','other')`
      if (table.split(OLD_TAIL).length !== 2) {
        throw new Error(
          "v66: `work`'s work_type CHECK is not the shape this migration was written for; " +
            'refusing to rewrite a schema it cannot read'
        )
      }
      const rewritten = table.replace(OLD_TAIL, NEW_TAIL)

      const count = (t: string): number =>
        (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c
      const before = {
        work: count('work'),
        document: count('document'),
        project_work: count('project_work'),
        citation_link: count('citation_link'),
        analysis_run: count('analysis_run')
      }

      const schemaVersion = db.pragma('schema_version', { simple: true }) as number
      // better-sqlite3 refuses a write to `sqlite_master` outright unless this
      // is set, and it is right to: it is exactly the operation that turns a
      // database into one that will not open. It is turned back off in the
      // `finally` so the rest of the run has the guard back, whether this step
      // succeeds or throws.
      db.unsafeMode(true)
      db.pragma('writable_schema = ON')
      try {
        db.prepare(`UPDATE sqlite_master SET sql = ? WHERE type='table' AND name='work'`).run(
          rewritten
        )
        // Without this every connection that already has the schema cached — and
        // this one — keeps enforcing the OLD CHECK, so the migration would report
        // success and `method` would still be refused until the next restart.
        db.pragma(`schema_version = ${schemaVersion + 1}`)
      }
      finally {
        db.pragma('writable_schema = OFF')
        db.unsafeMode(false)
      }

      for (const [t, n] of Object.entries(before)) {
        if (count(t) !== n) throw new Error(`v66: ${t} went from ${n} rows to ${count(t)}`)
      }

      // The CHECK as it now stands, exercised on a real row and rolled back. A
      // migration that edits a constraint by string substitution has to prove
      // the constraint it produced, or the proof is that the string looked right.
      const probeId = (
        db.prepare('SELECT id, work_type FROM work ORDER BY id LIMIT 1').get() as
          | { id: number; work_type: string }
          | undefined
      )
      if (probeId) {
        const probe = db.transaction(() => {
          db.prepare('UPDATE work SET work_type = ? WHERE id = ?').run('method', probeId.id)
          let rejected = false
          try {
            db.prepare('UPDATE work SET work_type = ? WHERE id = ?').run(
              'not-a-work-type',
              probeId.id
            )
          }
          catch (e) {
            if (!/CHECK constraint failed/i.test(String(e))) throw e
            rejected = true
          }
          if (!rejected) throw new Error('v66: the work_type CHECK accepts a value it should not')
          throw new Error('v66-probe-rollback')
        })
        try {
          probe()
        }
        catch (e) {
          if (String(e).indexOf('v66-probe-rollback') < 0) throw e
        }
      }
    }
  },
  {
    /**
     * `expansion_rank` — expansion priority's place in its project's order.
     *
     * A SECOND COLUMN RATHER THAN A REWRITE, because the two answer different
     * questions and only one of them is a measurement. `expansion_priority` is
     * the mean relevance of a paper's unmatched references: a real quantity,
     * comparable across projects and stable as the library grows. This is its
     * RANK among the papers scored beside it, which is none of those things —
     * it moves when a neighbour is added and means nothing outside its project.
     * Normalising in place would have destroyed the measurement to fix a
     * display, and there would then be no way back to the number the reranker
     * actually produced.
     *
     * WHY A RANK AND NOT MIN-MAX. Measured on this corpus's 20 real scores:
     * they span 0.0007 to 0.1231 and are heavily right-skewed, one paper at
     * 0.123 with the next at 0.059 and half the field under 0.02. Min-max hands
     * the whole scale to that outlier — six of twenty still round to 0.0 on a
     * x/10 display, which is the complaint it was meant to answer. A rank
     * spaces them evenly and exactly one lands on 0.0, the genuine last place.
     * The cost is honest and worth stating: a rank says NOTHING about distance,
     * so two papers a hair apart can sit a whole point apart. That is why the
     * raw value stays in the column beside it and the explanation still quotes
     * the mean.
     *
     * NULL is preserved as NULL. A paper whose references could none of them be
     * judged has no place in the order — ranking it would put an unmeasured
     * paper above a measured one.
     */
    version: 67,
    up: (db) => {
      const cols = db.prepare(`PRAGMA table_info(project_work)`).all() as Array<{ name: string }>
      if (cols.some((c) => c.name === 'expansion_rank')) return
      db.exec(`ALTER TABLE project_work ADD COLUMN expansion_rank REAL`)
    }
  },
  {
    /**
     * `relevance_rank` — relevance's place in its project's order.
     *
     * THE SAME COLUMN AS `expansion_rank`, FOR THE OTHER SCORE, and added
     * separately for the same reason that one was: `relevance` is what the
     * cross-encoder actually produced and is what ORDERS every list and what
     * "Why this rank" quotes; this is only where that value sits among the
     * papers scored beside it.
     *
     * WHY IT WAS NEEDED. The scores are ordinal sigmoids and are far more
     * skewed than the expansion priorities ever were: 678 scored rows on this
     * corpus span 0.00004 to 0.98 with a MEDIAN of 0.00044. `Math.round(v*10)`
     * therefore printed "0" against almost the whole library and drew every bar
     * at 0 % width, so a screen full of perfectly well scored papers reported
     * that nothing in it was relevant. A rank spreads the same ORDER across the
     * scale a reader can see.
     *
     * IT IS NOT A MEASUREMENT. A rank says nothing about distance — two papers
     * a hair apart can sit a whole step apart — and it MOVES when a neighbour
     * is added, though neither paper changed. So nothing may threshold it,
     * average it, compare it across projects or store it as a score. The raw
     * value stays in the column beside it for all of that.
     *
     * NULL is preserved as NULL. A paper nothing has scored has no place in the
     * order, and ranking it last would state a verdict no model reached.
     */
    version: 68,
    up: (db) => {
      const cols = db.prepare(`PRAGMA table_info(project_work)`).all() as Array<{ name: string }>
      if (cols.some((c) => c.name === 'relevance_rank')) return
      db.exec(`ALTER TABLE project_work ADD COLUMN relevance_rank REAL`)
    }
  },
  {
    /**
     * A title an outside INDEX supplied, for a reference whose style printed
     * none — see `SCHEMA_V69_INDEX_TITLE` for what each column is and why the
     * provenance three are not optional.
     */
    version: 69,
    up: (db) => {
      const cols = db
        .prepare(`PRAGMA table_info(unresolved_reference)`)
        .all() as Array<{ name: string }>
      if (cols.some((c) => c.name === 'index_title')) return
      db.exec(SCHEMA_V69_INDEX_TITLE)
    }
  }
]

/**
 * Hand-written migration runner using PRAGMA user_version. Each pending step
 * runs inside BEGIN IMMEDIATE. After all steps, runs integrity_check +
 * foreign_key_check and throws on any failure.
 */
export interface MigrateOptions {
  /**
   * The caller has already taken the single-writer lock for this file (which is
   * what `initDatabase` does). Migrations REFUSE to run without it: applying
   * schema DDL while another process writes the same tables is what corrupted
   * the live database, and "whoever opened the file happens to migrate it" is
   * how that concurrency became a schema change.
   */
  hasExclusiveLock?: boolean
}

export function runMigrations(db: Database, opts: MigrateOptions = {}): number {
  const current = db.pragma('user_version', { simple: true }) as number
  const target = MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0)

  if (current > target) {
    throw new Error(
      `DB user_version ${current} is newer than app target ${target}. Refusing to downgrade.`
    )
  }

  const pending = MIGRATIONS.filter((m) => m.version > current)
  if (pending.length > 0 && !opts.hasExclusiveLock) {
    throw new Error(
      `Refusing to migrate ${db.name} from user_version ${current} to ${target} without ` +
        `exclusive access.\n\n` +
        `Schema changes applied while another process is writing this file is what ` +
        `corrupted it before. Open the database through initDatabase(), which takes the ` +
        `single-writer lock first, or pass { hasExclusiveLock: true } only when you have ` +
        `verified that this process is the sole writer.`
    )
  }

  // Captured BEFORE the loop, because every step after the first would otherwise
  // see a non-zero `user_version` its own predecessor had just written and
  // conclude it was upgrading a database that did not exist a second ago.
  const ctx: MigrationCtx = { upgrade: current > 0 }

  for (const migration of pending) {
    const tx = db.transaction(() => {
      migration.up(db, ctx)
      db.pragma(`user_version = ${migration.version}`)
    })
    tx.immediate()
  }

  // Post-migration integrity assertions.
  const integrity = db.pragma('integrity_check', { simple: true }) as string
  if (integrity !== 'ok') {
    throw new Error(`integrity_check failed: ${integrity}`)
  }
  const fkViolations = db.pragma('foreign_key_check') as unknown[]
  if (fkViolations.length > 0) {
    throw new Error(`foreign_key_check failed: ${JSON.stringify(fkViolations)}`)
  }

  return db.pragma('user_version', { simple: true }) as number
}
