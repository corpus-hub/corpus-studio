// The shape of a project archive: what one file has to contain for a project to
// come back whole on another machine.
//
// A PLAIN ZIP, named `.zip`. Not a bespoke extension — a user who double-clicks
// it gets a folder of readable JSON and their PDFs, and can repair it with the
// same tools they would use on any other archive. What makes it a PROJECT
// archive is `manifest.json` at the root, so identification survives a rename
// and a random zip is refused with a sentence instead of a parse error.
//
// IDS ARE THE SOURCE DATABASE'S, AND MEAN NOTHING TO THE IMPORTER.
// Every row is exported carrying the id it had where it was written, purely so
// the parts can reference each other (a fact names its run, a span names its
// document). The importer builds a map from those to freshly-inserted local
// ids and rewrites every reference as it goes. Nothing in the archive may be
// inserted with its original id: the receiving database has its own rows at
// those numbers.
//
// WHAT IS DELIBERATELY NOT STORED, and why:
//
//   `chunk.text` — a substring of the paragraph body, addressable by the
//       char_start/char_end the chunk already carries. On a real corpus it is
//       4.9 MB of the 13.7 MB of metadata, and it compresses badly (x2.8)
//       precisely because it is natural language the PDFs in the same archive
//       already contain. The importer reconstitutes it exactly. Deduplicating
//       beats compressing here.
//
//   `base_dir` rows — an absolute path on the exporting machine, which is
//       meaningless and possibly misleading on the importing one. PDFs arrive
//       as bytes and are re-registered against the receiving app's own managed
//       library.
//
//   `embedding_space.vec_table` — derived from the space's local row id
//       (`chunk_vec_${id}`). The importer resolves its own space through
//       `ensureActiveSpace` and must never be handed a table name.
//
//   `processing_job` rows — a job is work someone's machine intended to do.
//       Importing a queue would either replay another machine's backlog or
//       arrive permanently stuck; the importer plans fresh jobs for what is
//       genuinely missing instead.

/** Bumped only when a change would make an older app MISREAD a newer archive. */
export const ARCHIVE_FORMAT = 1

/** The file every archive is identified by. */
export const MANIFEST_NAME = 'manifest.json'

/**
 * `manifest.json` — enough to decide whether this app can read the archive, and
 * to tell the user what they are about to import BEFORE it is imported.
 *
 * The counts are what the import preview shows. They are recorded rather than
 * derived on open so the preview costs one small JSON parse instead of
 * inflating every part of a several-hundred-megabyte file.
 */
export interface ArchiveManifest {
  format: number
  /** Marks the file as ours beyond the format number alone. */
  kind: 'corpus-studio-project'
  /** For a human reading the file, and for a bug report. Never branched on. */
  app_version: string
  /** `user_version` of the exporting database, for diagnosing a bad import. */
  schema_version: number
  created_at: string
  project_name: string
  project_description: string | null
  counts: {
    works: number
    documents: number
    pdfs: number
    analyses: number
    facts: number
    measurements: number
    summaries: number
    citation_edges: number
    paragraphs: number
    chunks: number
  }
  /** Whether PDF bytes are present. A metadata-only archive is legitimate. */
  has_pdfs: boolean
  /** Whether vectors are present AND which space they belong to. */
  embedding: {
    config_hash: string
    model_id: string
    dims: number
    chunk_count: number
  } | null
}

/** A row exactly as SQLite holds it, with its source-database id. */
export type Row = Record<string, unknown>

/**
 * `project.json` — the project itself and its own opinions about its papers.
 *
 * `project_work` is the whole of the project-specific interpretation the
 * ontology insists is kept off the global `work`: relevance, expansion
 * priority, inclusion status, notes, overrides, ranking explanations. It is the
 * part that makes this a PROJECT rather than a pile of papers.
 */
export interface ProjectPart {
  project: Row
  project_work: Row[]
  saved_search: Row[]
  saved_frontier: Row[]
  /** Schema attachments, by schema KEY — ids differ between databases. */
  schema_keys: string[]
}

/** `works.json` — the papers, and everything that identifies them. */
export interface WorksPart {
  work: Row[]
  author: Row[]
  work_author: Row[]
  identifier: Row[]
  document: Row[]
  /**
   * `file_location` minus `base_dir_id`, plus the archive path of the bytes.
   * `pdf` is null for a document whose file was not available at export.
   */
  file_location: Array<Row & { pdf: string | null }>
}

/**
 * `text.json` — the extracted text, which is what every analysis was actually
 * run against and what the importer needs to match papers by content.
 *
 * `stage_run` rows come along because `document_paragraph` is keyed by them and
 * because the freshness check reads that key to decide whether an analysis is
 * still current. Without them every imported analysis would report "unknown".
 */
export interface TextPart {
  stage_run: Row[]
  document_paragraph: Row[]
  work_citation_parse: Row[]
}

/**
 * `analyses.json` — the AI results and their full provenance.
 *
 * Replayed VERBATIM on import, exactly as `shipped-analyses.ts` replays the
 * shipped dataset: model, prompt and schema versions, the input hashes and the
 * original run timestamp are all copied unchanged. Restamping any of them would
 * make the record describe a run that never happened, and would break the
 * freshness comparison, which is a hash equality over those very fields.
 */
export interface AnalysesPart {
  analysis_run: Row[]
  /**
   * Source `schema_id` -> that schema's KEY, for every schema an analysis or a
   * measurement names.
   *
   * Ids are meaningless across databases, and `analysis_run` is governed by a
   * partial-unique index on `(work_id, project_id, analysis_type, schema_id)`
   * that guarantees ONE current run per key. Without this map an importer has
   * to guess the schema, and guessing collapses several schemas' runs onto one
   * id — which does not corrupt anything quietly, it violates that index and
   * aborts the import. (It did, on the first run of the round-trip probe.)
   *
   * A JSON object, so integer keys arrive as strings.
   */
  schema_keys: Record<string, string>
  /** Source `field_id` -> `[schema key, field key]`, for the same reason. */
  field_keys: Record<string, [string, string]>
  evidence_span: Row[]
  fact: Row[]
  measurement: Row[]
  fold_improvement: Row[]
  analysis_check: Row[]
  fact_verdict: Row[]
  /** `work_summary` rows; their prose hangs off the runs above. */
  work_summary: Row[]
}

/** `citations.json` — the citation graph, both resolved and not. */
export interface CitationsPart {
  citation_edge: Row[]
  citation_context: Row[]
  citation_link: Row[]
  unresolved_reference: Row[]
}

/**
 * `chunks.json` — the semantic-search index, minus the text and the vectors.
 *
 * `vectors.bin` holds the vectors as one float32 buffer in this array's order;
 * `text` is rebuilt from each chunk's character range. Both omissions are
 * reconstructions, not losses.
 */
export interface ChunksPart {
  chunk: Row[]
  /**
   * The exporting space's FULL identity — every field `configHashOf` hashes,
   * and never its `vec_table`.
   *
   * The whole identity rather than just the hash, because a machine that has
   * never embedded anything has no space to match against, and a fresh install
   * importing an archive is the normal case. Carrying the identity lets the
   * importer recreate the space exactly and keep the vectors; carrying only the
   * hash would mean throwing away a valid index because nothing local had
   * asked for one yet.
   *
   * `vec_table` is excluded deliberately: it is derived from the space's LOCAL
   * row id (`chunk_vec_${id}`) and names a table that does not exist elsewhere.
   */
  space: EmbeddingSpaceRow | null
}

/** Mirrors `EmbeddingSpaceIdentity` in `embedding/space.ts`, in DB spelling. */
export interface EmbeddingSpaceRow {
  config_hash: string
  model_id: string
  model_revision: string
  model_file: string
  dims: number
  quantization: string
  stored_quantization: string
  pooling: string
  normalized: number
  query_prefix: string
  doc_prefix: string
  chunking_version: string
  max_seq_length: number
  text_extraction_version: string
  runtime: string
}

/** Every part, as the builder assembles it and the reader hands it over. */
export interface ProjectArchive {
  manifest: ArchiveManifest
  project: ProjectPart
  works: WorksPart
  text: TextPart
  analyses: AnalysesPart
  citations: CitationsPart
  chunks: ChunksPart
  /** Schemas as portable bundles — the same shape Share/Import already uses. */
  schemas: unknown[]
  /** archive path -> bytes, for `pdfs/<sha256>.pdf`. */
  pdfs: Map<string, Buffer>
  /** float32 LE, `chunk.length * dims * 4` bytes, or null when absent. */
  vectors: Buffer | null
}

/** The names of the JSON parts, so writer and reader cannot disagree. */
export const PART = {
  manifest: MANIFEST_NAME,
  project: 'project.json',
  works: 'works.json',
  text: 'text.json',
  analyses: 'analyses.json',
  citations: 'citations.json',
  chunks: 'chunks.json',
  schemas: 'schemas.json',
  vectors: 'vectors.bin'
} as const

/** Where a PDF lives inside the archive, addressed by its content hash. */
export function pdfPath(sha256: string): string {
  return `pdfs/${sha256}.pdf`
}
