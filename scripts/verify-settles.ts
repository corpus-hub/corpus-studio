// Does a stage's cache key survive the pipeline doing its job?
//
// A stage whose fingerprint moves as a RESULT of running has no fixed point: it
// invalidates itself the moment it succeeds, and the Queue badges the paper
// "Needs invalidation" for work it has just finished. That shipped —
// `download` hashed the file's MTIME, and `optimize` rewrites those same bytes
// in place, so 45 of 119 works on a real corpus were permanently stale and
// dragged schema-extract, review-records and reference-abstracts behind them
// through the upstream chain.
//
// WHY IT IS NOT PART OF `verify:pipeline`. That harness never fetches over the
// network and never optimises a real PDF, so these conditions do not arise
// there and a check added to it passes whether the bug is present or not. This
// one needs a corpus that has actually processed papers, so it takes one by
// path — and a COPY, because it mutates inside a rolled-back transaction and a
// probe pointed at a live database races the app's own writer.
//
// It simulates the two events directly:
//   download: `optimize` rewrites identical bytes, moving only the mtime.
//   retrieve: a fetch succeeds — the file appears and the status settles.
//
// `retrieve` is REPORTED rather than asserted; the note at that check says why.
//
//   ELECTRON_RUN_AS_NODE=1 CORPUS_DB_PATH=<copy of a corpus> \
//     electron --import tsx scripts/verify-settles.ts

import { statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase, setDb } from '../src/main/db/connection'
import { resolveRegistry } from '../src/main/pipeline/registry'
import { STAGES } from '../src/main/pipeline/stages'
import { computeFingerprint } from '../src/main/pipeline/stageRun'
import type { StagePlanContext } from '../src/main/pipeline/types'

const db = initDatabase(process.env.CORPUS_DB_PATH as string) as never
setDb(db)
const registry = resolveRegistry(STAGES)

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

// ---------------------------------------------------------------- download
// `download` keys on the canonical file's path, size and mtime, and `optimize`
// rewrites exactly those bytes. The key is SUPPOSED to move — it describes the
// file. What must not happen is the earlier run being left behind holding a key
// nobody will ever recompute: `optimize.applyWrites` restamps it.
{
  const row = db
    .prepare(
      `SELECT fl.document_id, bd.abs_path, fl.relative_path
         FROM file_location fl JOIN base_dir bd ON bd.id = fl.base_dir_id
        WHERE fl.role = 'canonical' LIMIT 1`
    )
    .get() as { document_id: number; abs_path: string; relative_path: string } | undefined

  if (!row) {
    check('download: a canonical file exists to test with', false)
  } else {
    const stage = registry.byId('download')!.stage
    const optimize = registry.byId('optimize')!.stage
    const work = db
      .prepare('SELECT work_id FROM document WHERE id = ?')
      .get(row.document_id) as { work_id: number }
    const ctx: StagePlanContext = {
      db,
      workId: work.work_id,
      documentId: row.document_id,
      projectId: 0
    }
    const path = join(row.abs_path, row.relative_path)
    const st = statSync(path)

    db.exec('BEGIN')
    try {
      // Put a download run in the slot, keyed to the file as it stands.
      db.prepare(
        `UPDATE stage_run SET input_fingerprint = ?
          WHERE stage = 'download' AND document_id = ? AND superseded = 0`
      ).run(computeFingerprint(db, registry, stage, ctx, null), row.document_id)

      // Now `optimize` runs: it rewrites the same path, which moves the mtime
      // (and in reality the size too).
      const later = new Date(st.mtimeMs + 1_500)
      utimesSync(path, later, later)

      const strandedBefore = db
        .prepare(
          `SELECT input_fingerprint FROM stage_run
            WHERE stage = 'download' AND document_id = ? AND superseded = 0`
        )
        .get(row.document_id) as { input_fingerprint: string }
      const movedByRewrite =
        strandedBefore.input_fingerprint !== computeFingerprint(db, registry, stage, ctx, null)
      check(
        'rewriting the file really does move download’s key',
        movedByRewrite,
        movedByRewrite ? 'so the restamp below is doing real work' : 'the check is measuring nothing'
      )

      // The restamp, exactly as the stage performs it.
      optimize.applyWrites!(
        db,
        {
          relativePath: row.relative_path,
          sizeBytes: statSync(path).size,
          sha256: 'unchanged-for-this-probe'
        },
        {
          workId: work.work_id,
          documentId: row.document_id,
          projectId: 0,
          stageRunId: 0,
          fanOut: null
        }
      )

      const after = db
        .prepare(
          `SELECT input_fingerprint FROM stage_run
            WHERE stage = 'download' AND document_id = ? AND superseded = 0`
        )
        .get(row.document_id) as { input_fingerprint: string }
      const settled = after.input_fingerprint === computeFingerprint(db, registry, stage, ctx, null)
      check(
        'optimize restamps the download run it invalidated',
        settled,
        settled ? 'download is settled against the new bytes' : 'download left stale by optimize'
      )
    } finally {
      utimesSync(path, st.atime, st.mtime)
      db.exec('ROLLBACK')
    }
  }
}

// ---------------------------------------------------------------- retrieve
// A paper with no file and no attempt, fetched successfully: the file appears
// and `retrieval_status` settles to `retrieved`.
{
  const stage = registry.byId('retrieve')!.stage
  const doc = db
    .prepare(
      `SELECT d.id, d.work_id, d.retrieval_status
         FROM document d
        WHERE EXISTS (SELECT 1 FROM identifier i WHERE i.work_id = d.work_id AND i.scheme='doi')
        LIMIT 1`
    )
    .get() as { id: number; work_id: number; retrieval_status: string | null }

  const ctx: StagePlanContext = { db, workId: doc.work_id, documentId: doc.id, projectId: 0 }

  // Put the document into the pre-fetch state, inside a transaction that is
  // rolled back — the copy is disposable, but a probe that mutates is a probe
  // that lies to the next probe.
  db.exec('BEGIN')
  try {
    db.prepare(`UPDATE document SET retrieval_status = 'not-attempted' WHERE id = ?`).run(doc.id)
    const saved = db
      .prepare(`SELECT * FROM file_location WHERE document_id = ? AND role='canonical'`)
      .all(doc.id) as Array<Record<string, unknown>>
    db.prepare(`DELETE FROM file_location WHERE document_id = ? AND role='canonical'`).run(doc.id)

    const beforeFetch = computeFingerprint(db, registry, stage, ctx, null)

    // The fetch succeeds: file row back, status settled.
    for (const s of saved) {
      const cols = Object.keys(s)
      db.prepare(
        `INSERT INTO file_location (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
      ).run(...cols.map((c) => s[c]))
    }
    db.prepare(`UPDATE document SET retrieval_status = 'retrieved' WHERE id = ?`).run(doc.id)

    const afterFetch = computeFingerprint(db, registry, stage, ctx, null)
    // The key MUST move here — the file it describes did not exist a moment
    // ago. Asserted so the restamp below is known to be doing real work rather
    // than agreeing with a key that never moved.
    check(
      'a successful fetch really does move retrieve’s key',
      beforeFetch !== afterFetch,
      beforeFetch !== afterFetch ? '' : 'the restamp check would be measuring nothing'
    )

    // Simulate the run that did the fetching, then let the stage restamp it.
    db.prepare(
      `UPDATE stage_run SET input_fingerprint = ?
        WHERE stage = 'retrieve' AND document_id = ? AND superseded = 0`
    ).run(beforeFetch, doc.id)
    stage.applyWrites!(
      db,
      { relativePath: 'probe.pdf', sha256: 'probe', sizeBytes: 1, source: 'probe' },
      { workId: doc.work_id, documentId: doc.id, projectId: 0, stageRunId: 0, fanOut: null }
    )
    const stamped = db
      .prepare(
        `SELECT input_fingerprint FROM stage_run
          WHERE stage = 'retrieve' AND document_id = ? AND superseded = 0`
      )
      .get(doc.id) as { input_fingerprint: string } | undefined
    const settled =
      stamped?.input_fingerprint === computeFingerprint(db, registry, stage, ctx, null)
    check(
      'retrieve restamps the run its own fetch invalidated',
      settled,
      settled ? 'settled against the file it fetched' : 'left stale by its own success'
    )

    // The property the file was in the key FOR: a PDF appearing with no fetch
    // having been attempted must still reopen the stage.
    db.prepare(`DELETE FROM file_location WHERE document_id = ? AND role='canonical'`).run(doc.id)
    db.prepare(`UPDATE document SET retrieval_status = 'not-attempted' WHERE id = ?`).run(doc.id)
    const noFileNoAttempt = computeFingerprint(db, registry, stage, ctx, null)
    for (const s of saved) {
      const cols = Object.keys(s)
      db.prepare(
        `INSERT INTO file_location (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
      ).run(...cols.map((c) => s[c]))
    }
    const fileDroppedIn = computeFingerprint(db, registry, stage, ctx, null)
    check(
      'a PDF dropped in without a fetch still reopens retrieve',
      noFileNoAttempt !== fileDroppedIn,
      'key moves when the file appears unattended'
    )
  } finally {
    db.exec('ROLLBACK')
  }
}

console.log(failures === 0 ? '\nRESULT: PASS' : `\nRESULT: FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
