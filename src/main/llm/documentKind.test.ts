// A supplement must not stand as the paper it is an appendix to.
//
// Run via:
//   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron node_modules/.bin/tsx \
//     --test src/main/llm/documentKind.test.ts
//
// The failure: work 7's PDF was ONLY the supplementary materials of a Science
// paper — first paragraph "Submitted Manuscript: Confidential", page numbering
// starting at 20, the article absent — and it reported `content_status =
// 'fulltext'`, passed every stage green and contributed 33 facts attributed to a
// body nothing had read. Every value was honestly anchored to text that really
// exists; what lied was the provenance.
//
// The pipeline had already MEASURED the answer. The summariser's
// `DOCUMENT-IS: supplementary` marker was parsed, used to word one summary's
// scope string and then discarded, while `document.version_kind` — which has had
// a `supplementary` member all along, and which `contentScopeOf` was already
// reading — was never written.
//
// WHAT IS PINNED, and each case exists because a different wrong write is
// cheap to reintroduce:
//
//   1. The marker LANDS. Removing the `recordDocumentKind` call leaves the
//      summary's prose identical and the scope string identical — the whole bug
//      was invisible in everything except this column.
//   2. A value NOTHING OBSERVED is what may be replaced: `publisher-PDF` is
//      stamped by retrieval on whatever bytes a link returned, without opening
//      the file.
//   3. A REAL report is not overruled. `preprint` here stands for anything a
//      person or an index established; a model's reading does not get to
//      rewrite it.
//   4. A PROJECT run writes nothing. What a document IS belongs to the
//      document; decided per project, the last project to summarise the paper
//      would win.
//   5. AN ORDINARY DOCUMENT IS UNTOUCHED — the silence that hard rule 0.6
//      depends on. A summary with no marker leaves the column exactly as it was,
//      so no badge appears on a normal paper.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type Database from 'better-sqlite3'
import { initDatabase, closeDatabase } from '../db/connection'
import { generateSummary } from './summary'
import type { LlmProvider, LlmMessage } from './provider'

const NOW = '2026-01-01T00:00:00.000Z'

const PARAGRAPHS = [
  'Supplementary Materials for a study of the energy landscape.',
  'Purified HG3 was assayed at 16.6 micromolar in activity buffer at pH 7.0.'
]

class FixedProvider implements LlmProvider {
  readonly name = 'fixed-test-fixture'
  readonly model = 'fixed-test-fixture'
  constructor(private readonly answer: string) {}
  async callLLM(_messages: LlmMessage[]): Promise<string> {
    return this.answer
  }
}

interface Fixture {
  db: Database.Database
  dir: string
  documentId: number
}

/** A work with one document whose paragraphs are published by a text run. */
function open(versionKind: string): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'corpus-doc-kind-'))
  const db = initDatabase(join(dir, 'corpus.sqlite'), { label: 'documentKind.test' })
  db.prepare(
    `INSERT INTO work (id, title, work_type, publication_year, created_at, updated_at)
     VALUES (1, 'Energy landscape of a designed enzyme', 'journal-article', 2020, ?, ?)`
  ).run(NOW, NOW)
  const documentId = Number(
    db
      .prepare(
        `INSERT INTO document (work_id, version_kind, content_status, retrieval_status,
                               is_preferred, created_at)
         VALUES (1, ?, 'fulltext', 'retrieved', 1, ?)`
      )
      .run(versionKind, NOW).lastInsertRowid
  )
  const stageRunId = Number(
    db
      .prepare(
        `INSERT INTO stage_run (stage, stage_version, work_id, document_id, status,
                                input_fingerprint, created_at)
         VALUES ('extract-text', 'v1', 1, ?, 'succeeded', 'fixture', ?)`
      )
      .run(documentId, NOW).lastInsertRowid
  )
  db.prepare(
    `INSERT INTO stage_artifact (stage_run_id, key, json) VALUES (?, ?, ?)`
  ).run(
    stageRunId,
    'text.paragraphs@v1',
    JSON.stringify({
      paragraphs: PARAGRAPHS.map((text, index) => ({ index, kind: 'body', text }))
    })
  )
  return { db, dir, documentId }
}

function close(f: Fixture): void {
  closeDatabase(f.db)
  rmSync(f.dir, { recursive: true, force: true })
}

function versionKind(f: Fixture): string {
  return (
    f.db.prepare('SELECT version_kind FROM document WHERE id = ?').get(f.documentId) as {
      version_kind: string
    }
  ).version_kind
}

const SUPPLEMENT_ANSWER =
  'DOCUMENT-IS: supplementary\nThis file contains the supporting figures and methods only.'
const PLAIN_ANSWER = 'The paper reports the energy landscape of a designed enzyme.'

async function summarise(
  f: Fixture,
  answer: string,
  kind: 'general' | 'project' = 'general'
): Promise<void> {
  if (kind === 'project') {
    // A project summary REFUSES to run without a dossier, so the fixture gives
    // it the minimum one: a second work marked as a reference of the project,
    // carrying one grounded claim.
    f.db
      .prepare(
        `INSERT INTO project (id, name, slug, created_at, updated_at)
         VALUES (7, 'P', 'p', ?, ?)`
      )
      .run(NOW, NOW)
    f.db
      .prepare(
        `INSERT INTO work (id, title, work_type, created_at, updated_at)
         VALUES (2, 'A reference paper', 'journal-article', ?, ?)`
      )
      .run(NOW, NOW)
    f.db
      .prepare(
        `INSERT INTO project_work (project_id, work_id, inclusion_status, reviewed,
                                   is_reference, created_at, updated_at)
         VALUES (7, 2, 'unread', 0, 1, ?, ?)`
      )
      .run(NOW, NOW)
    const runId = Number(
      f.db
        .prepare(
          `INSERT INTO analysis_run (work_id, project_id, analysis_type, schema_id, model,
                                     provider, prompt_version, schema_version, run_timestamp,
                                     superseded, created_at)
           VALUES (2, 0, 'extraction', 0, 'm', 'p', 'v1', 'v1', ?, 0, ?)`
        )
        .run(NOW, NOW).lastInsertRowid
    )
    f.db
      .prepare(
        `INSERT INTO fact (analysis_run_id, kind, predicate, subject, value_text, created_at)
         VALUES (?, 'directly-reported', 'has turnover', 'the reference enzyme', '12.5 per second', ?)`
      )
      .run(runId, NOW)
  }
  await generateSummary(f.db, new FixedProvider(answer), {
    workId: 1,
    projectId: kind === 'project' ? 7 : 0,
    kind
  }, NOW)
}

test('a general summary reporting DOCUMENT-IS: supplementary lands version_kind', async () => {
  const f = open('publisher-PDF')
  try {
    await summarise(f, SUPPLEMENT_ANSWER)
    assert.equal(versionKind(f), 'supplementary')
    // The MEASUREMENT is intact: `extract-text` really did find those
    // characters, and expressing a later conclusion by overwriting what a stage
    // observed would destroy the observation and be undone by a re-extraction.
    const status = (
      f.db.prepare('SELECT content_status FROM document WHERE id = ?').get(f.documentId) as {
        content_status: string
      }
    ).content_status
    assert.equal(status, 'fulltext')
  } finally {
    close(f)
  }
})

test('an uninformative `other` is replaced too', async () => {
  const f = open('other')
  try {
    await summarise(f, SUPPLEMENT_ANSWER)
    assert.equal(versionKind(f), 'supplementary')
  } finally {
    close(f)
  }
})

test('a value someone established is NOT overwritten', async () => {
  const f = open('preprint')
  try {
    await summarise(f, SUPPLEMENT_ANSWER)
    assert.equal(versionKind(f), 'preprint')
  } finally {
    close(f)
  }
})

test('a project summary writes nothing to the document', async () => {
  const f = open('publisher-PDF')
  try {
    await summarise(f, SUPPLEMENT_ANSWER, 'project')
    assert.equal(versionKind(f), 'publisher-PDF')
  } finally {
    close(f)
  }
})

test('an ordinary document is untouched, so no badge appears on it', async () => {
  const f = open('publisher-PDF')
  try {
    await summarise(f, PLAIN_ANSWER)
    assert.equal(versionKind(f), 'publisher-PDF')
    const scope = (
      f.db.prepare('SELECT source_scope FROM work_summary ORDER BY id DESC LIMIT 1').get() as {
        source_scope: string
      }
    ).source_scope
    assert.equal(scope, 'full text')
  } finally {
    close(f)
  }
})
