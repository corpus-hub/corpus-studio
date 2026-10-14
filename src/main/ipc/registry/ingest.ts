import { basename } from 'node:path'
import { readFileSync, statSync } from 'node:fs'
import { z } from 'zod/v4'
import { e, type Entry } from '../types'
import { createSeedWork, upsertResolvedWork } from '../../db/repositories'
import { AcademicIdentifierResolver, parseIdentifier } from '../../search/resolve'
import {
  attachPdfBytesToWork,
  ingestPdfBytes,
  MAX_PDF_BYTES,
  NotAPdfError
} from '../../db/repos/fileLocations'
import { getJobQueue } from '../../pipeline/scheduler'

/**
 * Adding a paper to the library.
 *
 * NO TOOL HERE TAKES A FILESYSTEM PATH. The renderer's own ingest accepts a
 * `pdf` kind naming a file by absolute path, which is fine for a person sitting
 * at the machine and is an arbitrary-file-read primitive for anything reachable
 * over a socket. An agent supplies the BYTES instead, so the only files it can
 * add are ones it already has; where they come to rest is this app's business.
 *
 * THREE WAYS IN, and they are not interchangeable:
 *   - an IDENTIFIER, resolved against the indexes first, so the paper lands with
 *     real metadata;
 *   - a FILE, which becomes a new paper titled from its filename because a
 *     filename is all there is to go on;
 *   - a FILE FOR A PAPER ALREADY HERE (`ingest:attachPdf`), which adds bytes to
 *     an existing work and never touches its metadata.
 * Mixing the last two is how one paper becomes two.
 *
 * Every one of them ENDS by planning the pipeline, so an import is not "queued
 * for later" in any sense the caller must chase — the returned jobId is already
 * live, and `job_get` follows it.
 */

const identifierResolver = new AcademicIdentifierResolver()
const nowIso = (): string => new Date().toISOString()

/**
 * Import a PDF the user named by ABSOLUTE PATH, and start its pipeline.
 *
 * Reads the bytes HERE rather than handing the path further in: the library, the
 * dedup hash and the `file_location` row all key on bytes, and a path is only
 * how this one caller — the app's own drop zone, with a person at the keyboard —
 * happens to have them. Nothing reachable over a socket can call this (see the
 * header): the MCP tool sends bytes.
 *
 * The size is checked with `stat` BEFORE the read, because the point of a cap is
 * to refuse the file without first pulling 2 GB of it into memory.
 */
function ingestPdfPath(
  db: Parameters<typeof ingestPdfBytes>[0],
  projectId: number,
  path: string,
  now: string
): { jobId: number; workId: number; resolvedTitle: string } {
  const bytes = readPdfAtPath(path)
  let res: ReturnType<typeof ingestPdfBytes>
  try {
    // `fileName`, not the path: `storeLibraryBytes` takes a basename anyway, and
    // the title derives from this string — a full path is not a title.
    res = ingestPdfBytes(db, { projectId, bytes, fileName: basename(path) }, now)
  } catch (err) {
    if (err instanceof NotAPdfError) throw new Error(err.message)
    throw err
  }

  // Planned AFTER the file is registered, so `retrieve` sees the file on its
  // first run and settles `not-needed` instead of refusing and having to be
  // re-armed later.
  const jobId = getJobQueue().planForWork(res.workId, projectId)[0] ?? 0
  return { jobId, workId: res.workId, resolvedTitle: res.title }
}

/**
 * Read a PDF the user named by absolute path, refusing what is not one.
 *
 * The size is checked with `stat` BEFORE the read, because the point of a cap is
 * to refuse the file without first pulling 2 GB of it into memory. Errors NAME
 * THE PATH: "could not read the file" is unactionable when a drop carried forty
 * of them, and the path is the user's own, so there is nothing to withhold.
 */
function readPdfAtPath(path: string): Buffer {
  let size: number
  try {
    const st = statSync(path)
    if (st.isDirectory()) throw new NotAPdfError(`“${path}” is a folder, not a PDF file.`)
    size = st.size
  } catch (err) {
    if (err instanceof NotAPdfError) throw new Error(err.message)
    throw new Error(
      `Could not read “${path}”: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  if (size > MAX_PDF_BYTES) {
    throw new Error(
      `“${basename(path)}” is ${Math.round(size / 1_048_576)} MB; the limit is ` +
        `${MAX_PDF_BYTES / 1_048_576} MB.`
    )
  }
  try {
    return readFileSync(path)
  } catch (err) {
    throw new Error(
      `Could not read “${path}”: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/**
 * Attach bytes to an existing work and RE-PLAN it, however the caller got them.
 *
 * The re-plan is the half that makes this useful. Attaching a file to a paper
 * whose `retrieve` already refused changes an INPUT that stage hashes (its key
 * carries `file=0|1` for exactly this case), so the refusal is no longer valid —
 * but nothing re-examines a settled pipeline on its own, and without this the
 * user would attach the PDF, watch the row go on saying "no PDF could be
 * retrieved", and reasonably conclude the drop did nothing.
 */
function attachPdfToWork(
  db: Parameters<typeof attachPdfBytesToWork>[0],
  workId: number,
  projectId: number,
  bytes: Buffer,
  fileName: string
): { jobId: number; workId: number; documentId: number; alreadyHadFile: boolean; relativePath: string } {
  let res: ReturnType<typeof attachPdfBytesToWork>
  try {
    res = attachPdfBytesToWork(db, { workId, bytes, fileName }, nowIso())
  } catch (err) {
    if (err instanceof NotAPdfError) throw new Error(err.message)
    throw err
  }
  // Nothing changed, so nothing is re-planned: a paper that already had its file
  // has an already-correct pipeline, and re-planning it would put a settled
  // paper back through the queue for no reason.
  const jobId = res.alreadyHadFile
    ? 0
    : (getJobQueue().reprocessWork(workId, projectId, { force: false }).allJobIds[0] ?? 0)
  return {
    jobId,
    workId: res.workId,
    documentId: res.documentId,
    alreadyHadFile: res.alreadyHadFile,
    relativePath: res.relativePath
  }
}

export const INGEST_ENTRIES: Entry[] = [
  e({
    channel: 'ingest:run',
    tool: 'paper_import',
    access: 'write',
    // Resolving an identifier calls out to the academic indexes.
    slow: true,
    summary:
      'Add a paper to a project by IDENTIFIER: doi, pmid, arxiv, url, or a title to look up. ' +
      'The identifier is resolved against the academic indexes FIRST, so the paper lands with ' +
      'real metadata (authors, year, venue, abstract) and the reply names the paper the ' +
      'identifier turned out to be \u2014 check it, an identifier that resolves is not always ' +
      'the one you meant. An identifier no index recognises is REFUSED rather than stored as a ' +
      'placeholder. Importing the same paper twice updates the existing record instead of ' +
      'duplicating it. Processing starts immediately; follow the returned jobId with job_get. ' +
      'To add a PDF you already hold, use paper_import_pdf \u2014 this tool never takes a file path.',
    returns: '{ jobId, workId?, resolvedTitle? }',
    // The CHANNEL keeps all seven kinds: the app's own drop zone passes `pdf`
    // and `folder` with an absolute path, and narrowing here would break it.
    params: z.object({
      projectId: z.number().int().nonnegative(),
      kind: z.enum(['doi', 'pmid', 'arxiv', 'title', 'url', 'pdf', 'folder']),
      value: z.string().min(1)
    }),
    // The TOOL drops the two kinds whose `value` is a path. An agent that wants
    // to add a file it holds sends the bytes to paper_import_pdf instead.
    toolParams: z.object({
      projectId: z.number().int().positive(),
      kind: z.enum(['doi', 'pmid', 'arxiv', 'title', 'url']),
      value: z.string().min(1).max(2000)
    }),
    run: async (ctx, a) => {
      const now = nowIso()

      // A `pdf` value is a PATH TO BYTES WE MUST READ, not a name to record.
      //
      // This used to fall through to the seed-work branch below, which stored a
      // work titled `pdf:/home/me/paper.pdf` and NO `file_location` row. The
      // file was never opened. `retrieve` then found no file and no identifier
      // and refused with "this paper has no DOI or URL… add the PDF yourself" —
      // about the very PDF the user had just imported. So an import that
      // reported success produced a paper with a path for a title and no text,
      // and the one honest reading of it, "it can't find anything", was right.
      //
      // `ingestPdfBytes` is the ONE correct implementation: magic-byte check,
      // content-hash dedup, the file copied into the managed library, and the
      // `file_location` row plus `retrieval_status='retrieved'` that make the
      // bytes findable. It only ever lacked a caller on this path.
      if (a.kind === 'pdf') {
        return ingestPdfPath(ctx.db, a.projectId, a.value, now)
      }

      // A `folder` value is a path too, and one that reaches here is a BUG
      // rather than a thing to store: the renderer expands a dropped folder
      // into its PDFs (`ingest:expandPaths`) before queueing any of them, so
      // this kind should never arrive. Naming it beats minting a work titled
      // `folder:/home/me/papers`.
      if (a.kind === 'folder') {
        throw new Error(
          `“${a.value}” is a folder. Expand it into the PDF files it holds before importing.`
        )
      }

      const identifier = parseIdentifier(a.value)
      if (identifier) {
        const record = await identifierResolver.resolve(identifier).catch(() => null)
        if (!record) {
          throw new Error(
            `No paper found for ${identifier.kind.toUpperCase()} \u201C${identifier.value}\u201D. ` +
              `Check the identifier, or pass the paper's title instead.`
          )
        }
        const { workId } = upsertResolvedWork(
          ctx.db,
          a.projectId,
          {
            title: record.title,
            abstract: record.abstract,
            authors: record.authors,
            year: record.year,
            venue: record.venue,
            doi: record.doi,
            identifiers:
              identifier.kind === 'doi' ? [] : [{ scheme: identifier.kind, value: identifier.value }]
          },
          now
        )
        const jobId = getJobQueue().planForWork(workId, a.projectId)[0] ?? 0
        return { jobId, workId, resolvedTitle: record.title }
      }

      // Not a recognisable identifier: a title to search for later. Seeded as a
      // real work + document so the pipeline has something to fill in.
      //
      // Every kind that can still reach here (`doi`/`pmid`/`arxiv`/`title`/`url`
      // that `parseIdentifier` did not claim) carries prose the user typed, so
      // the value stands on its own. The old `${kind}:${value}` prefix was for
      // the two path kinds, which now never arrive.
      const title = a.value
      // `workId` is returned on THIS path too, because a caller watching an
      // import watches the PAPER: `jobId` names the first job of a chain a dozen
      // long, and a title import that withheld the work left its caller with
      // nothing to follow the rest of the chain by.
      const planned = ctx.db.transaction(() => {
        const workId = createSeedWork(ctx.db, a.projectId, title, now)
        return { workId, jobId: getJobQueue().planForWork(workId, a.projectId)[0] ?? 0 }
      })()
      return { jobId: planned.jobId, workId: planned.workId, resolvedTitle: title }
    }
  }),

  e({
    channel: 'ingest:pdfBytes',
    tool: 'paper_import_pdf',
    access: 'write',
    summary:
      'Add a PDF you already have to a project, by sending its BYTES base64-encoded. Use this ' +
      'rather than a path \u2014 no tool here reads the filesystem. The bytes must really be a ' +
      `PDF (checked by magic bytes) and at most ${MAX_PDF_BYTES / 1_048_576} MB. fileName names ` +
      'the stored file, reduced to plain characters inside the library folder \u2014 it cannot ' +
      'point anywhere else. Re-sending identical bytes under the same name reuses the one copy ' +
      'rather than duplicating it. Text extraction and analysis start immediately \u2014 follow ' +
      'the returned jobId with job_get.',
    returns: '{ jobId, workId, documentId, ... }',
    params: z.object({
      projectId: z.number().int().positive(),
      // JSON cannot carry a Uint8Array, so the wire form is base64. Bounded
      // BEFORE decoding: base64 inflates by 4/3, and the point of a size cap is
      // to refuse the payload without first materialising it.
      bytesBase64: z
        .string()
        .min(1)
        .max(Math.ceil((MAX_PDF_BYTES * 4) / 3) + 1024),
      fileName: z.string().min(1).max(255),
      title: z.string().max(1000).optional()
    }),
    run: (ctx, a) => {
      const now = nowIso()
      const bytes = Buffer.from(a.bytesBase64, 'base64')
      if (bytes.length === 0 || bytes.length > MAX_PDF_BYTES) {
        throw new Error(
          `The PDF must be between 1 byte and ${MAX_PDF_BYTES / 1_048_576} MB after decoding.`
        )
      }
      let res: ReturnType<typeof ingestPdfBytes>
      try {
        res = ingestPdfBytes(
          ctx.db,
          { projectId: a.projectId, bytes, fileName: a.fileName, title: a.title },
          now
        )
      } catch (err) {
        // The message, never the bytes and never a path.
        if (err instanceof NotAPdfError) throw new Error(err.message)
        throw err
      }
      // PLANNED HERE. This entry's own summary promises extraction and analysis
      // start immediately and that `jobId` can be followed with `job_get`, and
      // nothing planned anything — so the id was absent, an agent polling it got
      // nothing, and the paper sat in the library unprocessed until some other
      // action happened to plan it.
      const jobId = getJobQueue().planForWork(res.workId, a.projectId)[0] ?? 0
      return { ...res, jobId }
    }
  }),

  e({
    channel: 'ingest:attachPdf',
    tool: 'paper_attach_pdf',
    access: 'write',
    summary:
      'Attach a PDF to a paper THIS LIBRARY ALREADY HOLDS, by sending its BYTES base64-encoded. ' +
      'Use this \u2014 not paper_import_pdf \u2014 whenever the paper already has a workId: ' +
      'importing the file as a new paper would leave the library holding the same paper twice. ' +
      'This is the answer to a retrieval that reported refused or skipped: the paper is known, ' +
      'its metadata is right, and only the file was missing. It NEVER changes the title, ' +
      'authors or any other metadata \u2014 what an index reported beats what a file is called. ' +
      'A paper that already has a PDF is left ALONE and the reply says so with ' +
      'already_had_file true, because replacing the bytes would invalidate the text, segments ' +
      'and every extracted fact anchored into them. Processing starts immediately \u2014 follow ' +
      'the returned jobId with job_get.',
    returns: '{ jobId, workId, documentId, alreadyHadFile, ... }',
    params: z.object({
      workId: z.number().int().positive(),
      projectId: z.number().int().positive(),
      bytesBase64: z
        .string()
        .min(1)
        .max(Math.ceil((MAX_PDF_BYTES * 4) / 3) + 1024),
      fileName: z.string().min(1).max(255)
    }),
    run: (ctx, a) => {
      const bytes = Buffer.from(a.bytesBase64, 'base64')
      if (bytes.length === 0 || bytes.length > MAX_PDF_BYTES) {
        throw new Error(
          `The PDF must be between 1 byte and ${MAX_PDF_BYTES / 1_048_576} MB after decoding.`
        )
      }
      return attachPdfToWork(ctx.db, a.workId, a.projectId, bytes, a.fileName)
    }
  }),

  e({
    /**
     * The same attach, for a file the USER dropped and which the app therefore
     * knows only by path. Separate from the bytes entry and permanently
     * `tool: null`, for the reason in this file's header: a path is an
     * arbitrary-file-read primitive for anything reachable over a socket.
     */
    channel: 'ingest:attachPdfPath',
    tool: null,
    access: 'write',
    summary:
      'Attach a PDF on this machine, named by absolute path, to a paper the library already ' +
      'holds. The UI\u2019s drop-onto-a-failed-row path; agents use paper_attach_pdf.',
    returns: '{ jobId, workId, documentId, alreadyHadFile, ... }',
    params: z.object({
      workId: z.number().int().positive(),
      projectId: z.number().int().positive(),
      path: z.string().min(1)
    }),
    run: (ctx, a) => {
      const bytes = readPdfAtPath(a.path)
      return attachPdfToWork(ctx.db, a.workId, a.projectId, bytes, basename(a.path))
    }
  })
]
