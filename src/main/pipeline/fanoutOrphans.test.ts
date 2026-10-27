import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import type { DB } from '../db/connection'
import { reconcileFanout } from './fanoutOrphans'
import type { StageDefinition, StagePlanContext } from './types'

const NOW = '2026-01-01T00:00:00.000Z'

/**
 * Only the tables these two functions read or write.
 *
 * The real schema needs sqlite-vec and a full migration chain, and neither is
 * part of what is being asserted: the question here is purely whether a run on
 * a key that left the fan-out stops being current, and whether the jobs its
 * refusal cancelled come back. `ux_stage_run_current` is included verbatim
 * because the whole bug is a slot that nothing ever frees.
 */
function fresh(): DB {
  const db = new Database(':memory:') as unknown as DB
  db.exec(`
    CREATE TABLE stage_run (
      id INTEGER PRIMARY KEY, stage TEXT NOT NULL, stage_version TEXT NOT NULL DEFAULT '1',
      work_id INTEGER NOT NULL DEFAULT 0, document_id INTEGER NOT NULL DEFAULT 0,
      project_id INTEGER NOT NULL DEFAULT 0, schema_id INTEGER NOT NULL DEFAULT 0,
      fanout_key TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
      lease_epoch INTEGER NOT NULL DEFAULT 0, outcome_note TEXT, error TEXT,
      input_fingerprint TEXT NOT NULL DEFAULT '', analysis_run_id INTEGER,
      result TEXT, superseded INTEGER NOT NULL DEFAULT 0, superseded_by INTEGER,
      duration_ms INTEGER, created_at TEXT NOT NULL DEFAULT '', finished_at TEXT);
    CREATE UNIQUE INDEX ux_stage_run_current
      ON stage_run(stage, work_id, document_id, project_id, schema_id, fanout_key)
      WHERE superseded = 0;
    CREATE TABLE processing_job (
      id INTEGER PRIMARY KEY, stage TEXT, status TEXT NOT NULL, work_id INTEGER,
      document_id INTEGER, project_id INTEGER NOT NULL DEFAULT 0,
      fanout_key TEXT NOT NULL DEFAULT '', job_key TEXT, attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT, error_kind TEXT, stage_run_id INTEGER, lease_owner TEXT,
      lease_expires_at TEXT, lease_epoch INTEGER NOT NULL DEFAULT 0,
      started_at TEXT, finished_at TEXT, updated_at TEXT);
    CREATE TABLE job_dependency (job_id INTEGER, depends_on_job_id INTEGER);
    CREATE TABLE document_paragraph (stage_run_id INTEGER);
    CREATE TABLE chunk (id INTEGER PRIMARY KEY, space_id INTEGER, stage_run_id INTEGER);
    CREATE TABLE embedding_space (id INTEGER PRIMARY KEY, vec_table TEXT);
    CREATE TABLE document (id INTEGER PRIMARY KEY, content_status TEXT, text_source TEXT,
      text_confidence REAL, text_source_run_id INTEGER);
    CREATE TABLE stage_artifact (stage_run_id INTEGER);
    CREATE TABLE analysis_run (id INTEGER PRIMARY KEY, superseded INTEGER NOT NULL DEFAULT 0);
  `)
  return db
}

const EXTRACT = {
  id: 'schema-extract',
  version: '1',
  scope: 'project',
  fanOut: () => []
} as unknown as StageDefinition

const PIPELINE = 'w1:d1:p1'

/** A refused extraction on `key`, its job, and one review job it cancelled. */
function seedRefusal(db: DB, key: string): { runId: number; jobId: number; reviewId: number } {
  db.prepare(
    `INSERT INTO stage_run (stage, work_id, document_id, project_id, fanout_key, status, created_at)
     VALUES ('schema-extract', 1, 1, 1, ?, 'refused', ?)`
  ).run(key, NOW)
  const runId = db.prepare('SELECT MAX(id) AS id FROM stage_run').get() as { id: number }
  db.prepare(
    `INSERT INTO processing_job (stage, status, work_id, document_id, project_id, fanout_key,
        job_key, error, error_kind) VALUES ('schema-extract', 'review', 1, 1, 1, ?, ?, NULL, NULL)`
  ).run(key, `${PIPELINE}:schema-extract:${key}`)
  const jobId = (db.prepare('SELECT MAX(id) AS id FROM processing_job').get() as { id: number }).id
  db.prepare(
    `INSERT INTO processing_job (stage, status, work_id, document_id, project_id, fanout_key,
        job_key, error, error_kind)
     VALUES ('review-records', 'cancelled', 1, 1, 1, '', ?, 'upstream declined', 'upstream')`
  ).run(`${PIPELINE}:review-records:${key}`)
  const reviewId = (db.prepare('SELECT MAX(id) AS id FROM processing_job').get() as { id: number })
    .id
  db.prepare('INSERT INTO job_dependency VALUES (?, ?)').run(reviewId, jobId)
  return { runId: runId.id, jobId, reviewId }
}

const isCurrent = (db: DB, runId: number): boolean =>
  (db.prepare('SELECT superseded FROM stage_run WHERE id = ?').get(runId) as { superseded: number })
    .superseded === 0

const statusOf = (db: DB, jobId: number): string =>
  (db.prepare('SELECT status FROM processing_job WHERE id = ?').get(jobId) as { status: string })
    .status

const ctx = (db: DB): StagePlanContext => ({ db, workId: 1, documentId: 1, projectId: 1 })

test('a run on a key that left the fan-out stops being current, and its dependents come back', () => {
  const db = fresh()
  const { runId, reviewId } = seedRefusal(db, 'default')
  assert.ok(isCurrent(db, runId))
  assert.equal(statusOf(db, reviewId), 'cancelled')

  // Schemas attached: the stage now fans out to one key per schema, and
  // `default` is not among them.
  const retired = reconcileFanout(db, EXTRACT, ctx(db), ['kinetics', 'thermostability'], PIPELINE, NOW)

  assert.deepEqual(
    retired.map((r) => r.fanoutKey),
    ['default']
  )
  assert.equal(isCurrent(db, runId), false, 'the orphaned refusal must not stay current')
  assert.equal(statusOf(db, reviewId), 'queued', 'the review it cancelled must be runnable again')
  // Retired, not deleted: the row is the provenance of what the stage concluded.
  const row = db.prepare('SELECT status, finished_at FROM stage_run WHERE id = ?').get(runId) as {
    status: string
    finished_at: string | null
  }
  assert.equal(row.status, 'refused')
  assert.equal(row.finished_at, NOW)
})

test('the slot the orphan held is free, so the same key can be planned again', () => {
  const db = fresh()
  seedRefusal(db, 'default')
  reconcileFanout(db, EXTRACT, ctx(db), ['kinetics'], PIPELINE, NOW)
  assert.doesNotThrow(() =>
    db
      .prepare(
        `INSERT INTO stage_run (stage, work_id, document_id, project_id, fanout_key, status, created_at)
         VALUES ('schema-extract', 1, 1, 1, 'default', 'running', ?)`
      )
      .run(NOW)
  )
})

test('an honest refusal on a key STILL in the fan-out keeps refusing and keeps its dependents cancelled', () => {
  const db = fresh()
  const { runId, reviewId } = seedRefusal(db, 'kinetics')
  const retired = reconcileFanout(db, EXTRACT, ctx(db), ['kinetics', 'thermostability'], PIPELINE, NOW)
  assert.deepEqual(retired, [])
  assert.ok(isCurrent(db, runId), 'a refusal on a live key is an answer, not an orphan')
  assert.equal(statusOf(db, reviewId), 'cancelled')
})

test('an empty fan-out set retires nothing — an absence of keys is not evidence keys are gone', () => {
  const db = fresh()
  const { runId, reviewId } = seedRefusal(db, 'default')
  assert.deepEqual(reconcileFanout(db, EXTRACT, ctx(db), [], PIPELINE, NOW), [])
  assert.ok(isCurrent(db, runId))
  assert.equal(statusOf(db, reviewId), 'cancelled')
})

test('a stage that does not fan out at all is never reconciled', () => {
  const db = fresh()
  const { runId } = seedRefusal(db, 'default')
  const noFan = { id: 'schema-extract', version: '1', scope: 'project' } as unknown as StageDefinition
  assert.deepEqual(reconcileFanout(db, noFan, ctx(db), ['kinetics'], PIPELINE, NOW), [])
  assert.ok(isCurrent(db, runId))
})

test('only the NEWEST job on a key is revived, so two live rows can never share one key', () => {
  const db = fresh()
  const { jobId, reviewId } = seedRefusal(db, 'default')
  // An older cancelled row on the same review key, still reachable through an
  // edge that outlived it.
  db.prepare(
    `INSERT INTO processing_job (id, stage, status, work_id, document_id, project_id, fanout_key,
        job_key, error, error_kind)
     VALUES (99, 'review-records', 'cancelled', 1, 1, 1, '', ?, 'upstream declined', 'upstream')`
  ).run(`${PIPELINE}:review-records:default`)
  db.prepare('INSERT INTO job_dependency VALUES (99, ?)').run(jobId)
  db.prepare('UPDATE processing_job SET id = 100 WHERE id = ?').run(reviewId)
  db.prepare('UPDATE job_dependency SET job_id = 100 WHERE job_id = ?').run(reviewId)

  reconcileFanout(db, EXTRACT, ctx(db), ['kinetics'], PIPELINE, NOW)
  assert.equal(statusOf(db, 100), 'queued')
  assert.equal(statusOf(db, 99), 'cancelled')
})

test('a job cancelled by the USER is not revived — only an upstream cancellation is', () => {
  const db = fresh()
  const { jobId } = seedRefusal(db, 'default')
  db.prepare(
    `INSERT INTO processing_job (stage, status, work_id, document_id, project_id, fanout_key,
        job_key, error, error_kind)
     VALUES ('review-records', 'cancelled', 1, 1, 1, '', 'w1:d1:p1:review-records:user', NULL, NULL)`
  ).run()
  const userId = (db.prepare('SELECT MAX(id) AS id FROM processing_job').get() as { id: number }).id
  db.prepare('INSERT INTO job_dependency VALUES (?, ?)').run(userId, jobId)
  reconcileFanout(db, EXTRACT, ctx(db), ['kinetics'], PIPELINE, NOW)
  assert.equal(statusOf(db, userId), 'cancelled')
})
