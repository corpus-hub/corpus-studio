import assert from 'node:assert/strict'
import { test } from 'node:test'

import Database from 'better-sqlite3'

import type { DB } from '../../db/connection'
import reviewRecords from './review-records'

/**
 * WHY THIS TEST EXISTS.
 *
 * On a corpus with 121 failed checks, exactly 2 facts carried
 * `retracted_by_check_id`, and the obvious reading is that the link is dropped
 * somewhere. It is not: `remedy: 'retract'` is a SEPARATE claim the reader makes
 * beside its verdict, and a failed check that did not ask for it is a record
 * flagged for a human, not one withdrawn. These cases pin that apart, so a
 * future change that silently starts retracting on `failed` alone — withdrawing
 * a corpus on a judgement nobody made — fails here.
 *
 * Only the four tables `applyWrites` touches: the real schema needs sqlite-vec
 * and the full migration chain, and neither bears on which verdicts retract.
 */
function fresh(): DB {
  const db = new Database(':memory:') as unknown as DB
  db.exec(`
    CREATE TABLE analysis_run (id INTEGER PRIMARY KEY, deterministic_validation INTEGER);
    CREATE TABLE analysis_check (
      id INTEGER PRIMARY KEY, analysis_run_id INTEGER NOT NULL, check_key TEXT NOT NULL,
      status TEXT NOT NULL, reason TEXT, fact_id INTEGER, measurement_id INTEGER,
      created_at TEXT NOT NULL, source TEXT, model TEXT, prompt_version TEXT,
      input_hash TEXT);
    CREATE TABLE fact (
      id INTEGER PRIMARY KEY, analysis_run_id INTEGER NOT NULL, evidence_span_id INTEGER,
      kind TEXT, predicate TEXT, subject TEXT, value_text TEXT, object TEXT,
      field_id INTEGER, origin_run_id INTEGER, created_at TEXT,
      retracted_by_check_id INTEGER);
    CREATE TABLE evidence_span (
      id INTEGER PRIMARY KEY, analysis_run_id INTEGER, document_id INTEGER,
      paragraph INTEGER, quote TEXT, verbatim INTEGER, created_at TEXT);
    CREATE TABLE measurement (
      id INTEGER PRIMARY KEY, fact_id INTEGER, field_id INTEGER, quantity TEXT,
      value_num REAL, value_text TEXT, unit TEXT, error_num REAL, conditions TEXT,
      created_at TEXT);
    CREATE TABLE extraction_field (id INTEGER PRIMARY KEY, label TEXT);
    CREATE TABLE document_paragraph (
      document_id INTEGER, idx INTEGER, text TEXT, kind TEXT, stage_run_id INTEGER);
    CREATE TABLE stage_run (
      id INTEGER PRIMARY KEY, stage TEXT, analysis_run_id INTEGER, outcome_note TEXT,
      superseded INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE processing_job (id INTEGER PRIMARY KEY, stage_run_id INTEGER, outcome_note TEXT);
    INSERT INTO analysis_run (id) VALUES (1);
    INSERT INTO fact (id, analysis_run_id, kind, predicate, value_text)
      VALUES (10, 1, 'directly-reported', 'Mutations', 'G131S'),
             (11, 1, 'directly-reported', 'Buffer pH', '7.25'),
             (12, 1, 'directly-reported', 'kcat', '1.2');
  `)
  return db
}

const base = { runId: 1, measurementId: null, reason: 'r', model: 'm', promptVersion: 'v11' }

function retractedIds(db: DB): number[] {
  return (
    db
      .prepare(`SELECT id FROM fact WHERE retracted_by_check_id IS NOT NULL ORDER BY id`)
      .all() as Array<{ id: number }>
  ).map((r) => r.id)
}

test('a failed verdict that asked to retract withdraws its fact, naming the check', () => {
  const db = fresh()
  reviewRecords.applyWrites?.(db, {
    model: 'm',
    promptVersion: 'v11',
    verdicts: [
      {
        ...base,
        checkKey: 'evidence-supports-value',
        factId: 10,
        status: 'failed',
        inputHash: 'h1',
        retract: true
      }
    ]
  })
  assert.deepEqual(retractedIds(db), [10])
  const row = db.prepare(`SELECT retracted_by_check_id AS c FROM fact WHERE id = 10`).get() as {
    c: number
  }
  const check = db.prepare(`SELECT check_key AS k FROM analysis_check WHERE id = ?`).get(row.c) as {
    k: string
  }
  assert.equal(check.k, 'evidence-supports-value')
})

test('a failed verdict that did not ask to retract leaves its fact live', () => {
  const db = fresh()
  reviewRecords.applyWrites?.(db, {
    model: 'm',
    promptVersion: 'v11',
    verdicts: [
      { ...base, checkKey: 'evidence-supports-value', factId: 11, status: 'failed', inputHash: 'h2' }
    ]
  })
  assert.deepEqual(retractedIds(db), [])
  // It is still recorded as failed, so the human review queue reaches it.
  const n = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM analysis_check WHERE status='failed' AND fact_id=11`)
      .get() as { n: number }
  ).n
  assert.equal(n, 1)
})

test('the retract flag alone cannot withdraw a fact the verdict did not fail', () => {
  const db = fresh()
  reviewRecords.applyWrites?.(db, {
    model: 'm',
    promptVersion: 'v11',
    verdicts: [
      {
        ...base,
        checkKey: 'evidence-supports-value',
        factId: 12,
        status: 'skipped',
        inputHash: 'h3',
        retract: true
      }
    ]
  })
  assert.deepEqual(retractedIds(db), [])
})
