// Writing the row that makes a document's bytes FINDABLE.
//
// `file_location` is the only thing that connects a `document` to a file on
// disk: the pipeline resolves a PDF solely as `base_dir.abs_path +
// file_location.relative_path` with `role = 'canonical'` (`download.ts:61-72`).
// Without that row `download` reports `no-file-location`, every downstream stage
// skips, and the app holds a work with a title and no text — while the ingest
// that produced it looked entirely successful.
//
// Nothing outside the seeder and the Zotero importer has ever written one. So
// importing a PDF by BYTES is a new capability, not a re-exposure, and the three
// ways a naive version of it goes wrong are handled here rather than discovered
// later:
//
//   1. `ux_file_location_path` is UNIQUE(base_dir_id, relative_path) — per PATH,
//      not per document. One library file therefore backs exactly ONE document.
//      `storeLibraryBytes` reports `present` for identical bytes at a candidate
//      name, and that path may already belong to a DIFFERENT document. Repointing
//      it would silently detach the other document's PDF, so this module returns
//      the EXISTING owner instead and the caller reports a duplicate.
//   2. `createSeedWork` writes `retrieval_status = 'not-attempted'`, which is
//      false for a file that is already on disk. It is set to `retrieved` here.
//      `content_status` is NOT touched: whether the PDF actually yields full
//      text is a claim only extraction can make, and asserting `fulltext` at
//      import would badge an unextracted paper as full-text-backed.
//   3. THE FILE IS WRITTEN BEFORE THE TRANSACTION, never inside it. A rollback
//      cannot un-write a file, so a transaction that also wrote bytes leaves the
//      disk holding something the database has no record of. The same ordering,
//      for the same reason, is already used by the archive restore.

import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import type { DB } from '../connection'
import { MANAGED_STORAGE_LABEL, storageRootPath } from '../paths'
import { storeLibraryBytes } from '../library'

/**
 * The app-owned library's `base_dir` row, created if this install lacks one.
 *
 * Looked up by PATH and not by label: the label is a display string the user can
 * edit, while the path is what `ensureStorageRoot()` actually creates. Keying on
 * the label would mint a second managed root the moment someone renamed the
 * first, and the pipeline would then look for files under a directory nothing
 * writes to.
 */
export function managedBaseDirId(db: DB, now: string): number {
  const root = storageRootPath()
  const existing = db.prepare('SELECT id FROM base_dir WHERE abs_path = ?').get(root) as
    | { id: number }
    | undefined
  if (existing) return existing.id
  return Number(
    db
      .prepare(`INSERT INTO base_dir (label, abs_path, kind, created_at) VALUES (?, ?, 'local', ?)`)
      .run(MANAGED_STORAGE_LABEL, root, now).lastInsertRowid
  )
}

/**
 * Record that a document's bytes are present.
 *
 * Left at `not-attempted`, the `download` stage behaves as though it still has
 * work to do and the Queue shows a retrieval that will never happen for a PDF
 * the user is looking at. Only the three "no file yet" states are widened —
 * `paywalled` and an existing `retrieved` are answers already given, and
 * overwriting them would erase what the app learned from a real fetch.
 */
function markRetrieved(db: DB, documentId: number): void {
  db.prepare(
    `UPDATE document SET retrieval_status = 'retrieved'
      WHERE id = ? AND retrieval_status IN ('not-attempted','pending','failed')`
  ).run(documentId)
}

export interface LinkedFile {
  fileLocationId: number
  /** Which document owns this path. NOT necessarily the one that was asked for. */
  documentId: number
  relativePath: string
  /**
   * True when the path was already registered — to this document or another one.
   *
   * The caller must check `documentId`: `duplicate` alone does not say whether
   * the file it just wrote landed where it wanted.
   */
  duplicate: boolean
}

/**
 * Register a file in the app-owned library against a document.
 *
 * IDEMPOTENT, and idempotent in the only way that is safe: an existing row for
 * this path is RETURNED, never repointed. Re-running the same import twice
 * therefore converges instead of throwing `SQLITE_CONSTRAINT` on the second
 * attempt or, worse, quietly stealing a file from another document.
 *
 * Always `role = 'canonical'` and `version = 1`. `download`'s resolution query
 * filters on the first and orders by the second, so a row written any other way
 * exists in the table and is invisible to the pipeline — the exact failure this
 * module was written to prevent, wearing a different hat.
 *
 * Caller's contract: the bytes are ALREADY on disk at `relativePath` under the
 * managed root. This function does not write files.
 */
export function linkManagedFile(
  db: DB,
  input: {
    documentId: number
    relativePath: string
    hash?: string | null
    sizeBytes?: number | null
    lastModified?: string | null
  },
  now: string
): LinkedFile {
  const baseDirId = managedBaseDirId(db, now)

  const existing = db
    .prepare(
      `SELECT id, document_id FROM file_location
        WHERE base_dir_id = ? AND relative_path = ?`
    )
    .get(baseDirId, input.relativePath) as { id: number; document_id: number } | undefined

  if (existing) {
    if (existing.document_id === input.documentId) {
      // The same document, the same path — a repeated import. Fill in the hash
      // and size if this call learned them and the row has none; never overwrite
      // values `download` computed, which are what its fingerprint compares.
      db.prepare(
        `UPDATE file_location
            SET hash = COALESCE(hash, ?),
                size_bytes = COALESCE(size_bytes, ?),
                last_modified = COALESCE(last_modified, ?)
          WHERE id = ?`
      ).run(input.hash ?? null, input.sizeBytes ?? null, input.lastModified ?? null, existing.id)
      markRetrieved(db, input.documentId)
    }
    return {
      fileLocationId: existing.id,
      documentId: existing.document_id,
      relativePath: input.relativePath,
      duplicate: true
    }
  }

  const id = Number(
    db
      .prepare(
        `INSERT INTO file_location
           (document_id, base_dir_id, relative_path, hash, size_bytes, role,
            last_modified, version, created_at)
         VALUES (?, ?, ?, ?, ?, 'canonical', ?, 1, ?)`
      )
      .run(
        input.documentId,
        baseDirId,
        input.relativePath,
        input.hash ?? null,
        input.sizeBytes ?? null,
        input.lastModified ?? null,
        now
      ).lastInsertRowid
  )

  markRetrieved(db, input.documentId)

  return { fileLocationId: id, documentId: input.documentId, relativePath: input.relativePath, duplicate: false }
}

/**
 * The document already backed by these exact bytes, if any.
 *
 * The FIRST question an import asks, and it is asked before anything is created:
 * discovering the duplicate afterwards means a work already exists to be cleaned
 * up, and a failed cleanup leaves a titled work with no text — indistinguishable
 * from a broken import.
 *
 * Matched on `file_location.hash`, which `download` writes as a sha256 hex
 * digest. A row whose hash is still null (registered but never downloaded)
 * cannot participate, and that is correct: the app does not know what those
 * bytes are.
 */
export function documentByContentHash(
  db: DB,
  hash: string
): { documentId: number; workId: number; relativePath: string } | null {
  const row = db
    .prepare(
      `SELECT fl.document_id AS documentId, d.work_id AS workId, fl.relative_path AS relativePath
         FROM file_location fl
         JOIN document d ON d.id = fl.document_id
        WHERE fl.hash = ?
        ORDER BY fl.id ASC
        LIMIT 1`
    )
    .get(hash) as { documentId: number; workId: number; relativePath: string } | undefined
  return row ?? null
}

/**
 * A work's current title, for reporting a duplicate import back to the caller.
 *
 * Falls back to the filename-derived title only if the row vanished between the
 * lookup and here, which one transaction makes impossible — but a `''` from a
 * missing row would read as "this paper has no title" rather than as a bug.
 */
function workTitle(db: DB, workId: number, fallback: string): string {
  const row = db.prepare('SELECT title FROM work WHERE id = ?').get(workId) as
    | { title: string }
    | undefined
  return row?.title ?? fallback
}

/** Which document, if any, already owns a path in the managed library. */
function documentAtManagedPath(
  db: DB,
  relativePath: string
): { fileLocationId: number; documentId: number; workId: number } | null {
  const root = storageRootPath()
  const row = db
    .prepare(
      `SELECT fl.id AS fileLocationId, fl.document_id AS documentId, d.work_id AS workId
         FROM file_location fl
         JOIN base_dir bd ON bd.id = fl.base_dir_id
         JOIN document d ON d.id = fl.document_id
        WHERE bd.abs_path = ? AND fl.relative_path = ?
        ORDER BY fl.id ASC
        LIMIT 1`
    )
    .get(root, relativePath) as
    | { fileLocationId: number; documentId: number; workId: number }
    | undefined
  return row ?? null
}

/**
 * The title a byte import gives a work when the caller supplied none.
 *
 * A FILENAME IS NOT A TITLE, and this app already refuses to pretend otherwise:
 * `ingest:run` declines to mint a work titled from a raw identifier string
 * precisely because such a title "pollutes the corpus and its dedup keys". The
 * hazard is the same here — a work titled `Otten 2020 Science` is matchable by
 * `resolveWorkRef`'s normalized-title path, so a later DOI import of the same
 * paper finds no match and creates a SECOND work for it, breaking the ontology's
 * "stored ONCE globally".
 *
 * A filename cannot simply be refused the way an identifier can: bytes are all
 * the caller gave us and there is nothing else to look up. So the filename is
 * what the work is called — but it is the file's NAME, not its address and not
 * its format. A directory prefix and `.pdf` are facts about where the bytes sit
 * on this one machine, and a title carrying either is wrong on the Papers list,
 * in an export and in every citation built from it.
 *
 * WHAT DROPPING `.pdf` COSTS, since it was there on purpose. With the extension
 * kept, a filename-derived title could never fold-match a real title, so it
 * could never be RESOLVED as one by `resolveWorkRef`'s normalized-title path.
 * Without it, a file named exactly after its paper now can — which is the
 * correct outcome (it IS that paper) but is a match made on a filename someone
 * chose, not on an identifier. The mismatch case is unchanged and is the common
 * one: `Otten_2020_Science` does not fold to the paper's real title either way,
 * so a later DOI import still creates the second work the note below warns
 * about. Only a DOI closes that, which is why `ingest:run` resolves one when it
 * has one and this path is the fallback for when it does not.
 *
 * The stem is otherwise kept VERBATIM — no case fixing, no underscore
 * substitution, no year stripping. Guessing at a human's naming scheme is how a
 * title stops being evidence of anything.
 */
function titleFromFileName(supplied: string | undefined, fileName: string): string {
  const given = (supplied ?? '').trim()
  if (given.length > 0) return given
  // `basename` first: a caller that passed a path must not get one as a title.
  const name = basename(fileName)
  const dot = name.lastIndexOf('.')
  // `dot > 0`, never `>= 0`: a dotfile is all extension and no stem, and
  // slicing at 0 would leave the empty string for a NOT NULL title column.
  const stem = dot > 0 ? name.slice(0, dot) : name
  const trimmed = stem.trim()
  return trimmed.length > 0 ? trimmed : name
}

/** The first five bytes every PDF starts with. */
const PDF_MAGIC = '%PDF-'
/** The largest PDF accepted. Beyond this the caller is not importing a paper. */
export const MAX_PDF_BYTES = 64 * 1024 * 1024

export interface IngestedPdf {
  workId: number
  documentId: number
  /** True when these exact bytes were already in the library under some document. */
  duplicate: boolean
  /**
   * The work's title as it now stands — the one this import gave it, or the one
   * the existing work already had when `duplicate`.
   *
   * Returned so the caller can NAME the paper it queued. An import that reports
   * only a job id makes the user go and look for what it did.
   */
  title: string
  relativePath: string
  /** The sha256 of the bytes, so a caller can key its own idempotency on it. */
  hash: string
}

/** Raised for bytes that are not a PDF. Never echoes the bytes. */
export class NotAPdfError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'NotAPdfError'
  }
}

/**
 * Import a PDF supplied as BYTES: file, document, work, project link, in that
 * order and with the file first.
 *
 * Ordering is the substance of this function. The bytes are written to the
 * library BEFORE the transaction opens, because a rollback cannot un-write a
 * file — putting the write inside would trade a recoverable orphaned file for an
 * unrecoverable inconsistency. The duplicate check runs before either, so a
 * repeat import never creates a work it then has to clean up.
 *
 * Does NOT plan the pipeline. Planning belongs to the caller, which holds the
 * scheduler; keeping it out means this function has no `await` in it and can be
 * called from inside a caller's own transaction without violating better-sqlite3's
 * synchronous-transaction rule.
 */
export function ingestPdfBytes(
  db: DB,
  input: { projectId: number; bytes: Buffer; fileName: string; title?: string },
  now: string
): IngestedPdf {
  if (input.bytes.length === 0) throw new NotAPdfError('That file is empty.')
  if (input.bytes.length > MAX_PDF_BYTES) {
    throw new NotAPdfError(
      `That file is ${Math.round(input.bytes.length / 1_048_576)} MB; the limit is ${MAX_PDF_BYTES / 1_048_576} MB.`
    )
  }
  // A magic check and nothing more. It rejects the obvious mistake — an image, a
  // Word file, an HTML error page saved as `.pdf` — without pretending to
  // validate the format: a structurally broken PDF still imports, and the
  // `extract-text` stage is where that becomes visible, with a stage error
  // naming it, rather than here with a guess.
  if (input.bytes.subarray(0, 5).toString('latin1') !== PDF_MAGIC) {
    throw new NotAPdfError('That file is not a PDF.')
  }

  const hash = createHash('sha256').update(input.bytes).digest('hex')
  const derivedTitle = titleFromFileName(input.title, input.fileName)

  // Already here. Return the existing ids rather than a second work for the same
  // paper — an agent retrying a timed-out import must converge, not duplicate.
  const known = documentByContentHash(db, hash)
  if (known) {
    // The work may not be in THIS project: the same PDF can legitimately be
    // imported into a second project, and that link is the one thing a repeat
    // import still has to do. It is an INSERT OR IGNORE, so a genuine repeat
    // within one project changes nothing.
    db.prepare(
      `INSERT OR IGNORE INTO project_work
         (project_id, work_id, relevance, expansion_priority, inclusion_status, reviewed, created_at, updated_at)
       VALUES (?, ?, NULL, NULL, 'unread', 0, ?, ?)`
    ).run(input.projectId, known.workId, now, now)
    return {
      workId: known.workId,
      documentId: known.documentId,
      duplicate: true,
      // The EXISTING work's title, not the one this filename would have given
      // it: nothing was renamed, and reporting the new name for a paper that
      // kept its old one would send the user looking for a row that says
      // something else.
      title: workTitle(db, known.workId, derivedTitle),
      relativePath: known.relativePath,
      hash
    }
  }

  const stored = storeLibraryBytes(input.fileName, input.bytes)
  if (stored.outcome === 'failed' || stored.outcome === 'missing-source') {
    // `storeLibraryBytes` REPORTS rather than throws, so an unchecked call reads
    // as success and the DB rows go in against a file that was never written.
    throw new Error(`Could not save the PDF into the library: ${stored.error ?? stored.outcome}`)
  }

  // A file already at that name with identical bytes whose `file_location` row
  // carries NO hash escapes the lookup above. Those rows are real: the Zotero
  // importer writes a location without one, and `download` is what fills it in.
  // So the path is checked BEFORE anything is created, and its existing owner is
  // returned as a duplicate. Discovering it after the inserts would mean the
  // only honest response was to roll back — turning "you already have this
  // paper" into a hard error the user has no way to clear.
  const owner = documentAtManagedPath(db, stored.relativePath)
  if (owner) {
    // Teach the row its hash on the way past. Without this the cheap lookup
    // above never starts working for a location registered by an importer that
    // did not compute one, and every future import of this paper repeats the
    // write-then-probe. COALESCE, so a hash `download` computed is never
    // overwritten by one derived here.
    db.prepare(
      `UPDATE file_location SET hash = COALESCE(hash, ?), size_bytes = COALESCE(size_bytes, ?)
        WHERE id = ?`
    ).run(hash, input.bytes.length, owner.fileLocationId)
    db.prepare(
      `INSERT OR IGNORE INTO project_work
         (project_id, work_id, relevance, expansion_priority, inclusion_status, reviewed, created_at, updated_at)
       VALUES (?, ?, NULL, NULL, 'unread', 0, ?, ?)`
    ).run(input.projectId, owner.workId, now, now)
    return {
      workId: owner.workId,
      documentId: owner.documentId,
      duplicate: true,
      title: workTitle(db, owner.workId, derivedTitle),
      relativePath: stored.relativePath,
      hash
    }
  }

  return db.transaction((): IngestedPdf => {
    const title = derivedTitle
    const workId = Number(
      db
        .prepare(
          `INSERT INTO work (title, work_type, created_at, updated_at) VALUES (?, 'other', ?, ?)`
        )
        .run(title, now, now).lastInsertRowid
    )
    const documentId = Number(
      db
        .prepare(
          `INSERT INTO document
             (work_id, version_kind, content_status, retrieval_status, is_preferred, created_at)
           VALUES (?, 'other', 'unknown', 'retrieved', 1, ?)`
        )
        .run(workId, now).lastInsertRowid
    )
    db.prepare(
      `INSERT OR IGNORE INTO project_work
         (project_id, work_id, relevance, expansion_priority, inclusion_status, reviewed, created_at, updated_at)
       VALUES (?, ?, NULL, NULL, 'unread', 0, ?, ?)`
    ).run(input.projectId, workId, now, now)

    const link = linkManagedFile(
      db,
      {
        documentId,
        relativePath: stored.relativePath,
        hash,
        sizeBytes: stored.sizeBytes,
        lastModified: now
      },
      now
    )
    if (link.documentId !== documentId) {
      // The path belongs to another document. Nothing this transaction created
      // may survive — rolling back is what stops a work existing with no file.
      throw new Error(
        `That file name is already registered to another document; the import was not applied.`
      )
    }
    return { workId, documentId, duplicate: false, title, relativePath: stored.relativePath, hash }
  })()
}

/** What attaching a file to a paper that already exists did. */
export interface AttachedPdf {
  workId: number
  documentId: number
  relativePath: string
  hash: string
  /**
   * True when this work ALREADY had a canonical file and it was left alone.
   *
   * The honest answer to "attach this PDF" for a paper that has one is to
   * decline: replacing it would silently invalidate the text, the segments, the
   * embeddings and every extracted fact anchored into the old bytes. The caller
   * says so rather than reporting a success that changed nothing.
   */
  alreadyHadFile: boolean
}

/**
 * Attach a PDF to a paper THAT ALREADY EXISTS, by bytes.
 *
 * The counterpart to `ingestPdfBytes`, and the distinction is the whole point:
 * that one is "here is a paper I have as a file", this one is "here is the file
 * for the paper you already know about and could not fetch". The retrieval
 * refusal a user hits — no DOI, no URL, or every mirror failed — leaves a real
 * work with real metadata and no bytes, and the only thing missing is the file
 * on their disk. Routing that through `ingestPdfBytes` would mint a SECOND work
 * for a paper the corpus already holds, which is what the ontology's "stored
 * ONCE globally" forbids.
 *
 * IT NEVER TOUCHES THE TITLE. The work's metadata came from an index and is
 * better than anything a filename can say, so a file named `download (3).pdf`
 * must not rename a paper. This is the opposite default from `ingestPdfBytes`,
 * where the filename is all there is.
 *
 * Writes the file BEFORE the transaction, for the reason at the top of this file.
 */
export function attachPdfBytesToWork(
  db: DB,
  input: { workId: number; bytes: Buffer; fileName: string },
  now: string
): AttachedPdf {
  if (input.bytes.length === 0) throw new NotAPdfError('That file is empty.')
  if (input.bytes.length > MAX_PDF_BYTES) {
    throw new NotAPdfError(
      `That file is ${Math.round(input.bytes.length / 1_048_576)} MB; the limit is ${MAX_PDF_BYTES / 1_048_576} MB.`
    )
  }
  if (input.bytes.subarray(0, 5).toString('latin1') !== PDF_MAGIC) {
    throw new NotAPdfError('That file is not a PDF.')
  }

  // The document to attach to: the preferred one, which is the same row
  // `planForWork` builds the pipeline against. A work with no document at all
  // gets one — `upsertResolvedWork` always writes one, but a work restored from
  // an older archive may not have.
  const doc = db
    .prepare('SELECT id FROM document WHERE work_id = ? ORDER BY is_preferred DESC, id LIMIT 1')
    .get(input.workId) as { id: number } | undefined

  const existingFile = doc
    ? db
        .prepare(
          `SELECT 1 FROM file_location WHERE document_id = ? AND role = 'canonical' LIMIT 1`
        )
        .get(doc.id)
    : undefined
  if (doc && existingFile) {
    const loc = db
      .prepare(
        `SELECT relative_path AS relativePath, hash FROM file_location
          WHERE document_id = ? AND role = 'canonical' LIMIT 1`
      )
      .get(doc.id) as { relativePath: string; hash: string | null }
    return {
      workId: input.workId,
      documentId: doc.id,
      relativePath: loc.relativePath,
      hash: loc.hash ?? '',
      alreadyHadFile: true
    }
  }

  const hash = createHash('sha256').update(input.bytes).digest('hex')
  const stored = storeLibraryBytes(input.fileName, input.bytes)
  if (stored.outcome === 'failed' || stored.outcome === 'missing-source') {
    throw new Error(`Could not save the PDF into the library: ${stored.error ?? stored.outcome}`)
  }

  // The path may already back a DIFFERENT document — `storeLibraryBytes` reports
  // `present` for identical bytes at a candidate name. Repointing it would
  // detach that document's PDF, so this refuses and names the situation.
  const owner = documentAtManagedPath(db, stored.relativePath)
  if (owner && (!doc || owner.documentId !== doc.id)) {
    throw new Error(
      `Those exact bytes are already the PDF for another paper in this library ` +
        `(“${workTitle(db, owner.workId, stored.relativePath)}”), so they were not attached here. ` +
        `If these really are two papers, re-export one of them from its source.`
    )
  }

  return db.transaction((): AttachedPdf => {
    const documentId =
      doc?.id ??
      Number(
        db
          .prepare(
            `INSERT INTO document
               (work_id, version_kind, content_status, retrieval_status, is_preferred, created_at)
             VALUES (?, 'other', 'unknown', 'retrieved', 1, ?)`
          )
          .run(input.workId, now).lastInsertRowid
      )

    // `linkManagedFile` is what sets `retrieval_status = 'retrieved'`, and is the
    // only place allowed to.
    const link = linkManagedFile(
      db,
      {
        documentId,
        relativePath: stored.relativePath,
        hash,
        sizeBytes: stored.sizeBytes,
        lastModified: now
      },
      now
    )
    if (link.documentId !== documentId) {
      throw new Error(
        `That file name is already registered to another document; the PDF was not attached.`
      )
    }
    return { workId: input.workId, documentId, relativePath: stored.relativePath, hash, alreadyHadFile: false }
  })()
}

/**
 * Files in the managed library that no `file_location` row names.
 *
 * The recovery path for the ordering above: bytes are written before the
 * transaction, so a transaction that rolls back leaves the file behind. Reported
 * rather than deleted — this returns names, and deciding to remove them is a
 * separate act. An age gate is the caller's responsibility: a file written
 * milliseconds ago by an import whose transaction has not committed yet is
 * indistinguishable from an orphan, and sweeping it would break the very import
 * that is in flight.
 */
export function managedFileNames(db: DB): { registered: Set<string>; baseDirId: number | null } {
  const root = storageRootPath()
  const bd = db.prepare('SELECT id FROM base_dir WHERE abs_path = ?').get(root) as
    | { id: number }
    | undefined
  if (!bd) return { registered: new Set(), baseDirId: null }
  const rows = db
    .prepare('SELECT relative_path FROM file_location WHERE base_dir_id = ?')
    .all(bd.id) as Array<{ relative_path: string }>
  return { registered: new Set(rows.map((r) => r.relative_path)), baseDirId: bd.id }
}
