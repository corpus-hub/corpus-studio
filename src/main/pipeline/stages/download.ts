// Stage 1 — materialise the bytes: resolve a document to a readable local PDF
// and publish its path as `document.file@v1`.
//
// Actually FETCHING over the network is a separate feature with its own
// rate-limit and licensing questions; this stage resolves what the library
// already holds, records the file's real identity (`hash`, `size_bytes`,
// `last_modified` are all null on rows the seeder wrote), and is the single
// place a later stage learns where a document's bytes live. The two same-named
// `resolvePdfPath` helpers in the codebase are a documented trap, and a stage
// author never picks between them: `ctx.input('document.file@v1')` is the only
// answer.

import { createHash } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { DocumentFile } from '../capabilities'
import type { StageDefinition } from '../types'

/** What `ctx.write` carries for this stage: the file identity it measured. */
interface DownloadWrite {
  relativePath: string
  sha256: string
  sizeBytes: number
  lastModified: string
}

/**
 * This stage's `own=` segment, for the document's current canonical file.
 *
 * EXPORTED because `optimize` rewrites those bytes and must restamp this run
 * with the value they now produce. Two copies of the formula would drift, and a
 * restamp computed from a stale copy is worse than no restamp: it would write a
 * fingerprint the stage itself never agrees with, and the run would be stale
 * against a key nothing can reproduce.
 */
export function downloadFileKey(db: DB, documentId: number): string {
  const row = db
    .prepare(
      `SELECT bd.abs_path AS base_dir, fl.relative_path AS relative_path
         FROM file_location fl JOIN base_dir bd ON bd.id = fl.base_dir_id
        WHERE fl.document_id = ? AND fl.role = 'canonical'
        ORDER BY fl.version DESC, fl.id DESC LIMIT 1`
    )
    .get(documentId) as { base_dir: string; relative_path: string } | undefined
  if (!row) return 'no-file-location'
  try {
    const st = statSync(join(row.base_dir, row.relative_path))
    return `${row.relative_path}|${st.size}|${st.mtimeMs}`
  } catch {
    // Absent is a stable, legitimate state: the cached `skipped` stays valid
    // until the file appears, at which point the stat succeeds and the
    // fingerprint changes on its own.
    return `${row.relative_path}|absent`
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (c) => hash.update(c))
    stream.on('error', reject)
    stream.on('end', () => resolve())
  })
  return hash.digest('hex')
}

const download: StageDefinition<{ sha256: string; sizeBytes: number }> = {
  id: 'download',
  label: 'Locate PDF',
  version: '1.0.0',
  rank: 1,
  scope: 'document',
  provides: ['document.file@v1'],
  requires: [],
  usesLlm: false,
  runtime: 'node',
  weight: 'light',

  // Keyed on the BYTES ON DISK, so replacing the PDF re-runs this stage and —
  // through the upstream-fingerprint chain — everything after it.
  //
  // Read from the filesystem, NOT from the `file_location` columns, even though
  // those hold the same numbers: this stage WRITES `size_bytes`/`last_modified`,
  // so a fingerprint derived from them changes as a result of the stage running
  // and every run invalidates itself. The cache would then never hit and every
  // launch would re-extract every paper. (Caught by verify:pipeline, which is
  // why the cache assertion is in there rather than trusted.)
  //
  // `optimize` REWRITES THESE BYTES, AND RESTAMPS THIS RUN WHEN IT DOES.
  //
  // It recompresses the PDF in place: same path, smaller file, new mtime. Both
  // halves of this key therefore moved as a consequence of a stage that runs
  // AFTER this one, so every paper carrying a PDF was badged "Needs
  // invalidation" the moment its pipeline finished — 45 of 119 works on the
  // user's corpus, dragging schema-extract, review-records and
  // reference-abstracts behind them through the upstream chain.
  //
  // The remedy is not a weaker key. It is that the stage which changed the file
  // says so: `optimize.applyWrites` recomputes this fingerprint against the
  // bytes it just wrote and stamps it onto this run, in the same transaction
  // that records the new size. So the key still describes the file exactly, and
  // still moves the instant anything ELSE replaces it — which is what it is
  // for.
  fingerprint(ctx) {
    return downloadFileKey(ctx.db, ctx.documentId)
  },

  async execute(ctx) {
    const loc = ctx.db.pdfPath()
    if (!loc) {
      return {
        status: 'skipped',
        reason: `document ${ctx.documentId} has no canonical file_location inside a known base dir`
      }
    }

    let size: number
    let mtime: string
    try {
      const st = await stat(loc.absPath)
      if (!st.isFile()) {
        return { status: 'skipped', reason: `${loc.relativePath} is not a regular file` }
      }
      size = st.size
      mtime = st.mtime.toISOString()
    } catch (err) {
      // A path recorded but absent is a MISSING PRECONDITION, not a broken
      // stage: the library simply does not hold these bytes. Retrying cannot
      // help, and failing would paint the pipeline red for a paper the user
      // never downloaded.
      return {
        status: 'skipped',
        reason: `no readable file at ${loc.relativePath} (${(err as Error).message})`
      }
    }

    if (ctx.signal.aborted) return { status: 'failed', error: 'cancelled', retryable: true }
    const sha256 = await sha256File(loc.absPath)

    const file: DocumentFile = {
      documentId: ctx.documentId,
      baseDir: loc.baseDir,
      relativePath: loc.relativePath,
      absPath: loc.absPath,
      sizeBytes: size,
      sha256
    }
    ctx.emit('document.file@v1', file)

    ctx.write({
      relativePath: loc.relativePath,
      sha256,
      sizeBytes: size,
      lastModified: mtime
    } satisfies DownloadWrite)

    return { status: 'succeeded', result: { sha256, sizeBytes: size }, note: loc.relativePath }
  },

  applyWrites(db, payload, ctx) {
    const w = payload as DownloadWrite
    db.prepare(
      `UPDATE file_location SET hash = ?, size_bytes = ?, last_modified = ?
        WHERE document_id = ? AND relative_path = ?`
    ).run(w.sha256, w.sizeBytes, w.lastModified, ctx.documentId, w.relativePath)
  }
}

export default download
