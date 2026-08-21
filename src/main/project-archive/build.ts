// Reading one project out of the database and into an archive.
//
// The whole state of a project: its papers and their PDFs, the extracted text
// every analysis was run against, those analyses with their provenance intact,
// the summaries, the citation graph, the attached schemas and the semantic
// index. What comes back on the other side should be the project, not a report
// about it.
//
// SCOPE IS DECIDED BY THE PROJECT'S WORKS, and everything else follows from
// them. A project owns `project_work` rows; those name works; works own
// documents, analyses, citations and chunks. Walking outward from that one set
// is what keeps the export from either missing a paper's analyses or dragging
// in another project's.
//
// TWO KINDS OF ANALYSIS COME ALONG, deliberately. `analysis_run.project_id = 0`
// is the GLOBAL sentinel — a general summary or a domain-neutral extraction
// belongs to the paper, not to any project — and `project_id = <this project>`
// is this project's own reading of it. Exporting only the latter would produce
// an archive whose papers had lost their general summaries; exporting global
// runs for works NOT in this project would leak another project's corpus.

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DB } from '../db/connection'
import { exportSchemaBundle } from '../db/repositories'
import {
  ARCHIVE_FORMAT,
  PART,
  pdfPath,
  type AnalysesPart,
  type ArchiveManifest,
  type ChunksPart,
  type CitationsPart,
  type EmbeddingSpaceRow,
  type ProjectArchive,
  type ProjectPart,
  type Row,
  type TextPart,
  type WorksPart
} from './types'
import { zip } from '../export/serialize/zip'

/** `SELECT *` restricted to a set of ids, or nothing when the set is empty. */
function rowsIn(db: DB, table: string, column: string, ids: number[]): Row[] {
  if (ids.length === 0) return []
  // Chunked: SQLite's default parameter limit is 999, and a stress corpus has
  // thousands of works. A single oversized IN list throws rather than degrading.
  const out: Row[] = []
  for (let i = 0; i < ids.length; i += 900) {
    const slice = ids.slice(i, i + 900)
    const marks = slice.map(() => '?').join(',')
    out.push(
      ...(db
        .prepare(`SELECT * FROM ${table} WHERE ${column} IN (${marks})`)
        .all(...slice) as Row[])
    )
  }
  return out
}

const idsOf = (rows: Row[], key = 'id'): number[] =>
  rows.map((r) => r[key]).filter((v): v is number => typeof v === 'number')

/**
 * The archive would have been SHORT, so it was not written.
 *
 * A refusal rather than a warning because of what this file is for: it is the
 * export whose stated purpose is to move a project to another machine, and one
 * that is missing PDFs looks exactly like one that is not — same shape, same
 * counts, a plausible size. The user finds out when a paper will not open on
 * the far side, by which time the drive they should have reconnected may be
 * hundreds of miles away. Nothing else in the app filters exported data, and
 * this was the one place that did.
 *
 * `sentence` is built HERE and carries no path: a `base_dir` names a folder on
 * this machine, so it holds the OS username. Counts and a remedy only.
 */
export class ArchiveIncompleteError extends Error {
  readonly sentence: string
  constructor(
    readonly notFound: number,
    readonly unreadable: number
  ) {
    const total = notFound + unreadable
    const files = total === 1 ? 'one PDF' : `${total} PDFs`
    const parts: string[] = []
    if (notFound > 0) {
      parts.push(
        `${notFound === 1 ? 'One is' : `${notFound} are`} not at the location the library `
        + 'recorded — the drive holding them may not be connected'
      )
    }
    if (unreadable > 0) {
      parts.push(
        `${unreadable === 1 ? 'One' : `${unreadable}`} could not be read from this computer`
      )
    }
    const sentence =
      `This project's archive was not written, because ${files} it lists could not be included. `
      + `${parts.join('; ')}. `
      + 'An archive missing files looks complete, so it is refused rather than saved short. '
      + 'Reconnect the drive, or remove those papers from the project, and export again.'
    super(sentence)
    this.name = 'ArchiveIncompleteError'
    this.sentence = sentence
  }
}

/**
 * Build the archive for one project.
 *
 * Reads only; nothing here writes to the database or the filesystem. The bytes
 * go back to `writeFile.ts`, which owns the atomic save every export inherits.
 *
 * THROWS `ArchiveIncompleteError` when a recorded PDF cannot be included. See
 * that class for why a short archive is worse than none.
 */
export function buildProjectArchive(db: DB, projectId: number): Buffer {
  const project = db.prepare('SELECT * FROM project WHERE id = ?').get(projectId) as Row | undefined
  if (!project) throw new Error(`project ${projectId} not found`)

  // ---- the works this project holds, and the rows hanging off them --------
  const projectWork = db
    .prepare('SELECT * FROM project_work WHERE project_id = ?')
    .all(projectId) as Row[]
  const workIds = [...new Set(idsOf(projectWork, 'work_id'))]

  const work = rowsIn(db, 'work', 'id', workIds)
  const document = rowsIn(db, 'document', 'work_id', workIds)
  const documentIds = idsOf(document)

  const workAuthor = rowsIn(db, 'work_author', 'work_id', workIds)
  const author = rowsIn(db, 'author', 'id', [...new Set(idsOf(workAuthor, 'author_id'))])
  const identifier = rowsIn(db, 'identifier', 'work_id', workIds)

  // ---- PDFs, content-addressed -------------------------------------------
  // Hashing the bytes rather than trusting `file_location.hash`: that column is
  // filled in after the fact by the download stage and is NULL for anything the
  // seed registered, so relying on it would silently drop files. It also means
  // two documents that are the same paper contribute one copy.
  const pdfs = new Map<string, Buffer>()
  const fileLocation: Array<Row & { pdf: string | null }> = []
  // Every file the library RECORDS and this run could not put in the archive.
  //
  // Counted, and then refused. A `file_location` row is not a wish — it is the
  // library saying this document's bytes are at that path — so a row whose
  // bytes do not travel is a file the archive is MISSING while its description
  // ("Everything: papers, PDFs, analyses…") and its manifest counts both say it
  // is complete. The user unplugs a drive, exports, sees a plausible zip, and
  // finds out on the other machine.
  //
  // Split by cause because the two remedies are different: reconnect the drive
  // or restore the file, versus fix a permission or a damaged copy.
  let notFound = 0
  let unreadable = 0
  for (const loc of rowsIn(db, 'file_location', 'document_id', documentIds)) {
    const base = db
      .prepare('SELECT abs_path FROM base_dir WHERE id = ?')
      .get(loc.base_dir_id) as { abs_path: string } | undefined
    let archived: string | null = null
    if (!base || typeof loc.relative_path !== 'string') {
      // A location with no resolvable path is a corrupt row, not an absent
      // file. It is counted with the unreadable ones: nothing about it can be
      // fixed by finding a drive.
      unreadable += 1
    } else {
      const abs = join(base.abs_path, loc.relative_path)
      try {
        if (statSync(abs).isFile()) {
          const bytes = readFileSync(abs)
          const sha = createHash('sha256').update(bytes).digest('hex')
          archived = pdfPath(sha)
          if (!pdfs.has(archived)) pdfs.set(archived, bytes)
        } else {
          notFound += 1
        }
      } catch (err) {
        // ENOENT covers a deleted copy and, above all, an unmounted drive —
        // the whole tree is simply not there. Anything else is a file that
        // exists and would not be read.
        const code = (err as NodeJS.ErrnoException)?.code
        if (code === 'ENOENT' || code === 'ENOTDIR') notFound += 1
        else unreadable += 1
      }
    }
    // `base_dir_id` is dropped: it names a directory on THIS machine.
    const { base_dir_id: _drop, ...rest } = loc
    fileLocation.push({ ...rest, pdf: archived })
  }
  if (notFound > 0 || unreadable > 0) throw new ArchiveIncompleteError(notFound, unreadable)

  // ---- extracted text ----------------------------------------------------
  const documentParagraph = rowsIn(db, 'document_paragraph', 'document_id', documentIds)
  const citationParse = rowsIn(db, 'work_citation_parse', 'work_id', workIds)

  // ---- analyses: this project's AND the global ones for these works -------
  const analysisRun = rowsIn(db, 'analysis_run', 'work_id', workIds).filter(
    (r) => r.project_id === projectId || r.project_id === 0
  )
  const runIds = idsOf(analysisRun)
  const evidenceSpan = rowsIn(db, 'evidence_span', 'analysis_run_id', runIds)
  const fact = rowsIn(db, 'fact', 'analysis_run_id', runIds)
  const factIds = idsOf(fact)
  const measurement = rowsIn(db, 'measurement', 'fact_id', factIds)
  const foldImprovement = rowsIn(db, 'fold_improvement', 'measurement_id', idsOf(measurement))
  const analysisCheck = rowsIn(db, 'analysis_check', 'analysis_run_id', runIds)
  const factVerdict = rowsIn(db, 'fact_verdict', 'fact_id', factIds).filter(
    (r) => r.project_id === projectId
  )
  const workSummary = rowsIn(db, 'work_summary', 'analysis_run_id', runIds)

  // `stage_run` rows are what `document_paragraph` is keyed by, and what the
  // freshness check reads to decide whether an analysis is still current.
  // Without them every imported analysis would report its state as "unknown".
  const stageRun = rowsIn(db, 'stage_run', 'work_id', workIds).filter(
    (r) => r.project_id === projectId || r.project_id === 0
  )

  // ---- citations ---------------------------------------------------------
  // Edges are kept only when BOTH ends are in this project. A half-edge would
  // name a work the archive does not carry, and the importer would have to
  // either invent it or drop the edge on arrival — better to be honest here.
  const inProject = new Set(workIds)
  const citationEdge = rowsIn(db, 'citation_edge', 'citing_work_id', workIds).filter((e) =>
    inProject.has(e.cited_work_id as number)
  )
  const unresolvedReference = rowsIn(db, 'unresolved_reference', 'citing_work_id', workIds)
  const edgeIds = new Set(idsOf(citationEdge))
  const unresolvedIds = new Set(idsOf(unresolvedReference))
  const citationContext = rowsIn(db, 'citation_context', 'citing_work_id', workIds).filter(
    (c) =>
      (c.edge_id === null || edgeIds.has(c.edge_id as number)) &&
      (c.unresolved_reference_id === null ||
        unresolvedIds.has(c.unresolved_reference_id as number))
  )
  const citationLink = rowsIn(db, 'citation_link', 'citing_work_id', workIds).filter((l) =>
    inProject.has(l.cited_work_id as number)
  )

  // ---- chunks and vectors ------------------------------------------------
  const chunkRows = rowsIn(db, 'chunk', 'work_id', workIds)
  // The FULL identity, so a machine that has never embedded anything can
  // recreate the space and keep these vectors. `vec_table` is excluded: it
  // names a table derived from the local row id.
  const spaceRow =
    chunkRows.length > 0
      ? (db
          .prepare(
            `SELECT config_hash, model_id, model_revision, model_file, dims, quantization,
                    stored_quantization, pooling, normalized, query_prefix, doc_prefix,
                    chunking_version, max_seq_length, text_extraction_version, runtime
               FROM embedding_space WHERE id = ?`
          )
          .get(chunkRows[0].space_id) as EmbeddingSpaceRow | undefined)
      : undefined

  // Vectors concatenated in chunk order, and `text` dropped from every row.
  //
  // `text` is a substring of the paragraph body this archive already carries,
  // addressable by the char range the chunk stores — 4.9 MB of a 13.7 MB
  // metadata set on a real corpus, and it compresses badly (x2.8) precisely
  // because it duplicates natural language already present. The importer slices
  // it back exactly. Dropping beats compressing.
  const vectorParts: Buffer[] = []
  const chunk: Row[] = []
  for (const c of chunkRows) {
    const { text: _text, vector, ...rest } = c
    chunk.push(rest)
    if (Buffer.isBuffer(vector)) vectorParts.push(vector)
  }
  // All or nothing: a partial vector file would misalign every chunk after the
  // first gap, silently pairing papers with other papers' embeddings.
  const vectors =
    spaceRow && vectorParts.length === chunkRows.length && vectorParts.length > 0
      ? Buffer.concat(vectorParts)
      : null

  // ---- schemas, as the portable bundles Share/Import already speaks -------
  const schemaIds = (
    db
      .prepare('SELECT schema_id FROM project_schema WHERE project_id = ? ORDER BY sort_order, schema_id')
      .all(projectId) as Array<{ schema_id: number }>
  ).map((r) => r.schema_id)
  const schemas = schemaIds.map((id) => exportSchemaBundle(db, id))
  const schemaKeys = schemaIds.map(
    (id) =>
      (db.prepare('SELECT key FROM extraction_schema WHERE id = ?').get(id) as { key: string }).key
  )

  const projectPart: ProjectPart = {
    project,
    project_work: projectWork,
    saved_search: db.prepare('SELECT * FROM saved_search WHERE project_id = ?').all(projectId) as Row[],
    saved_frontier: db
      .prepare('SELECT * FROM saved_frontier WHERE project_id = ?')
      .all(projectId) as Row[],
    schema_keys: schemaKeys
  }
  const worksPart: WorksPart = { work, author, work_author: workAuthor, identifier, document, file_location: fileLocation }
  const textPart: TextPart = {
    stage_run: stageRun,
    document_paragraph: documentParagraph,
    work_citation_parse: citationParse
  }
  // Schema and field ids, resolved to KEYS. Ids mean nothing in the receiving
  // database, and `analysis_run` is governed by a partial-unique index that
  // includes `schema_id` — so an importer that has to guess will collapse
  // several schemas' runs onto one id and violate it.
  const runSchemaKeys: Record<string, string> = {}
  for (const id of new Set(analysisRun.map((r) => r.schema_id).filter((v) => typeof v === 'number' && v !== 0))) {
    const row = db.prepare('SELECT key FROM extraction_schema WHERE id = ?').get(id) as
      | { key: string }
      | undefined
    if (row) runSchemaKeys[String(id)] = row.key
  }
  const fieldKeys: Record<string, [string, string]> = {}
  for (const id of new Set(measurement.map((m) => m.field_id).filter((v) => typeof v === 'number'))) {
    const row = db
      .prepare(
        `SELECT f.key AS field_key, s.key AS schema_key
           FROM extraction_field f JOIN extraction_schema s ON s.id = f.schema_id
          WHERE f.id = ?`
      )
      .get(id) as { field_key: string; schema_key: string } | undefined
    if (row) fieldKeys[String(id)] = [row.schema_key, row.field_key]
  }

  const analysesPart: AnalysesPart = {
    analysis_run: analysisRun,
    schema_keys: runSchemaKeys,
    field_keys: fieldKeys,
    evidence_span: evidenceSpan,
    fact,
    measurement,
    fold_improvement: foldImprovement,
    analysis_check: analysisCheck,
    fact_verdict: factVerdict,
    work_summary: workSummary
  }
  const citationsPart: CitationsPart = {
    citation_edge: citationEdge,
    citation_context: citationContext,
    citation_link: citationLink,
    unresolved_reference: unresolvedReference
  }
  const chunksPart: ChunksPart = { chunk, space: spaceRow ?? null }

  const manifest: ArchiveManifest = {
    format: ARCHIVE_FORMAT,
    kind: 'corpus-studio-project',
    app_version: String(process.env.npm_package_version ?? 'unknown'),
    schema_version: db.pragma('user_version', { simple: true }) as number,
    created_at: new Date().toISOString(),
    project_name: String(project.name ?? 'Project'),
    project_description: (project.description as string | null) ?? null,
    counts: {
      works: work.length,
      documents: document.length,
      pdfs: pdfs.size,
      analyses: analysisRun.length,
      facts: fact.length,
      measurements: measurement.length,
      summaries: workSummary.length,
      citation_edges: citationEdge.length,
      paragraphs: documentParagraph.length,
      chunks: chunk.length
    },
    has_pdfs: pdfs.size > 0,
    embedding:
      vectors && spaceRow
        ? {
            config_hash: spaceRow.config_hash,
            model_id: spaceRow.model_id,
            dims: spaceRow.dims,
            chunk_count: chunk.length
          }
        : null
  }

  const archive: ProjectArchive = {
    manifest,
    project: projectPart,
    works: worksPart,
    text: textPart,
    analyses: analysesPart,
    citations: citationsPart,
    chunks: chunksPart,
    schemas,
    pdfs,
    vectors
  }
  return packArchive(archive)
}

/**
 * Lay the parts out as zip entries.
 *
 * The manifest goes FIRST so a reader can identify the file without inflating
 * anything else — the same reasoning that puts `[Content_Types].xml` first in
 * an xlsx.
 *
 * The JSON is not pretty-printed. It is machine-read on import, and indenting
 * several megabytes of rows costs real bytes to serve a reader who, for these
 * parts, is a program. `manifest.json` IS indented: that one is meant to be
 * opened by a person wondering what the file is.
 */
function packArchive(a: ProjectArchive): Buffer {
  const files: Array<{ name: string; data: string | Buffer }> = [
    { name: PART.manifest, data: JSON.stringify(a.manifest, null, 2) },
    { name: PART.project, data: JSON.stringify(a.project) },
    { name: PART.works, data: JSON.stringify(a.works) },
    { name: PART.text, data: JSON.stringify(a.text) },
    { name: PART.analyses, data: JSON.stringify(a.analyses) },
    { name: PART.citations, data: JSON.stringify(a.citations) },
    { name: PART.chunks, data: JSON.stringify(a.chunks) },
    { name: PART.schemas, data: JSON.stringify(a.schemas) }
  ]
  if (a.vectors) files.push({ name: PART.vectors, data: a.vectors })
  for (const [name, bytes] of a.pdfs) files.push({ name, data: bytes })
  return zip(files)
}
