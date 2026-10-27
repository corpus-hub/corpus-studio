// A fact reaches the UI only when BOTH stages of its reading have settled.
//
// Run via:
//   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron node_modules/.bin/tsx \
//     --test src/main/db/factGate.test.ts
//
// WHAT IS PINNED. `RUN_FACTS_VISIBLE` is one SQL string applied at ten read
// sites, so the thing worth testing is the string itself over the state space of
// the `review-records` job, not any one of its callers. The three outcomes the
// requirement names are the three cases below, plus the two that would silently
// re-open the hole: a review that finished BEFORE the extraction it is supposed
// to vouch for, and a review belonging to another project.
//
// Asserted through `getExtractionRows` rather than by re-executing the predicate
// here: a test that pastes the SQL passes when the caller stops using it, which
// is exactly the drift a single shared predicate exists to prevent.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type Database from 'better-sqlite3'
import { initDatabase, closeDatabase } from './connection'
import { getExtractionRows } from './repositories'

const EXTRACTED_AT = '2026-01-01T00:00:00.000Z'
const AFTER = '2026-01-02T00:00:00.000Z'
const BEFORE = '2025-12-31T00:00:00.000Z'

interface Fixture {
  db: Database.Database
  dir: string
}

/**
 * One project, one paper, one extraction run holding one fact — and no review
 * job at all. Each test then writes the `review-records` row it is about.
 */
function open(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'corpus-factgate-'))
  const db = initDatabase(join(dir, 'corpus.sqlite'), { label: 'factGate.test' })
  db.exec(`
    INSERT INTO project (id, name, slug, created_at, updated_at)
      VALUES (1, 'P', 'p', '${EXTRACTED_AT}', '${EXTRACTED_AT}');
    INSERT INTO work (id, title, work_type, publication_year, created_at, updated_at)
      VALUES (1, 'A paper', 'journal-article', 2020, '${EXTRACTED_AT}', '${EXTRACTED_AT}');
    INSERT INTO project_work (project_id, work_id, inclusion_status, reviewed, created_at, updated_at)
      VALUES (1, 1, 'unread', 0, '${EXTRACTED_AT}', '${EXTRACTED_AT}');
    INSERT INTO analysis_run
      (id, work_id, project_id, analysis_type, schema_id, model, provider, prompt_version,
       schema_version, run_timestamp, verifier_result, superseded, run_origin, created_at)
      VALUES (1, 1, 1, 'extraction', 0, 'm', 'p', 'v1', 'v1',
              '${EXTRACTED_AT}', 'passed', 0, 'local', '${EXTRACTED_AT}');
    INSERT INTO fact (id, analysis_run_id, kind, predicate, subject, value_text, created_at)
      VALUES (1, 1, 'directly-reported', 'melting_temperature', 'variant A', '52 C',
              '${EXTRACTED_AT}');
  `)
  return { db, dir }
}

function close(f: Fixture): void {
  closeDatabase(f.db)
  rmSync(f.dir, { recursive: true, force: true })
}

/** Write the paper's `review-records` job in whatever state the test is about. */
function reviewJob(
  db: Database.Database,
  opts: { status: string; outcome?: string | null; at?: string; projectId?: number }
): void {
  db.prepare(
    `INSERT INTO processing_job
       (job_type, stage, status, outcome, work_id, project_id, created_at, updated_at)
     VALUES ('extraction', 'review-records', ?, ?, 1, ?, ?, ?)`
  ).run(
    opts.status,
    opts.outcome ?? null,
    opts.projectId ?? 1,
    EXTRACTED_AT,
    opts.at ?? AFTER
  )
}

/** How many of this paper's extracted rows the app would show. */
function visibleRows(db: Database.Database): number {
  return getExtractionRows(db, 1, { workId: 1 }).length
}

test('a completed review releases the facts', () => {
  const f = open()
  try {
    reviewJob(f.db, { status: 'done', outcome: 'succeeded' })
    assert.equal(visibleRows(f.db), 1)
  } finally {
    close(f)
  }
})

test('a review that had nothing left to review releases them too', () => {
  const f = open()
  try {
    // `not-needed` — the branch for a paper whose records the checks all
    // passed, or which produced nothing needing a reading — is mapped to
    // `succeeded` by the scheduler before anything downstream sees it, so on
    // the row it is indistinguishable from a review that answered questions.
    // That is deliberate: both are the review being DONE.
    reviewJob(f.db, { status: 'done', outcome: 'succeeded' })
    assert.equal(visibleRows(f.db), 1)
  } finally {
    close(f)
  }
})

test('a failed review suspends them', () => {
  const f = open()
  try {
    reviewJob(f.db, { status: 'failed' })
    assert.equal(visibleRows(f.db), 0)
  } finally {
    close(f)
  }
})

test('a cancelled review suspends them', () => {
  const f = open()
  try {
    reviewJob(f.db, { status: 'cancelled' })
    assert.equal(visibleRows(f.db), 0)
  } finally {
    close(f)
  }
})

test('a review that never ran suspends them', () => {
  const f = open()
  try {
    assert.equal(visibleRows(f.db), 0)
  } finally {
    close(f)
  }
})

test('a review that finished BEFORE the extraction does not vouch for it', () => {
  const f = open()
  try {
    // It answered questions about records that no longer exist. Without the
    // timestamp test, re-extracting a paper would inherit the old job's
    // blessing and ship an unreviewed reading under a finished review.
    reviewJob(f.db, { status: 'done', outcome: 'succeeded', at: BEFORE })
    assert.equal(visibleRows(f.db), 0)
  } finally {
    close(f)
  }
})

test("another project's completed review does not release this one's facts", () => {
  const f = open()
  try {
    reviewJob(f.db, { status: 'done', outcome: 'succeeded', projectId: 2 })
    assert.equal(visibleRows(f.db), 0)
  } finally {
    close(f)
  }
})

test('the rows are SUSPENDED, not deleted', () => {
  const f = open()
  try {
    reviewJob(f.db, { status: 'failed' })
    assert.equal(visibleRows(f.db), 0)
    const held = (
      f.db.prepare('SELECT COUNT(*) AS c FROM fact').get() as { c: number }
    ).c
    assert.equal(held, 1)
  } finally {
    close(f)
  }
})
