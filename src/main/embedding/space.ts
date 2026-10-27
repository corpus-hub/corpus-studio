// The embedding-space registry: what a vector MEANS, derived from the bytes on
// disk rather than asserted in code.
//
// A cosine between vectors from two different models is a number, not an error.
// That is the whole reason this module exists: changing the model, its
// revision, its quantisation, its pooling, either prefix or the chunker
// invalidates every stored vector, and the change must be DETECTABLE and
// RESUMABLE rather than discovered by a user wondering why search got worse.
//
// Two rules the rest of the codebase depends on:
//
//   1. NO model id and NO dimensionality literal appears in TypeScript. `dims`
//      comes from the model's own `config.json`, `model_revision` from the
//      sha256 of the weights file. Swapping the packaged model therefore
//      changes `configHash` automatically — nobody has to remember to bump a
//      constant, which is the failure this replaces.
//   2. `configHash` IS `embed.fingerprint()`. So a space change supersedes
//      every embed run through the ORDINARY cascade in `stageRun.ts`, and the
//      re-embed is resumable because `stage_run` is per (work, document) and
//      each commits on its own. It is not a special code path; it is the
//      existing machinery, which is the point of putting the identity in the
//      fingerprint rather than in a config flag.
//
// `vec0` fixes dimensionality per TABLE, so the space's identity cannot live in
// a column — hence one `chunk_vec_<id>` per space, created lazily from the
// registry row.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DB } from '../db/connection'
import { modelsDir, resourcePath } from '../resources'

/**
 * Bump when the CHUNKER changes.
 *
 * Part of the space identity because chunk boundaries moving invalidates every
 * offset and every span the vectors were built over, exactly as a model change
 * does — a re-chunk with the same model still needs a full re-embed.
 */
export const CHUNKING_VERSION = 'paragraph/v1'

/**
 * Bump when the INPUT TEXT changes shape.
 *
 * The text a vector was built from is as much a part of its identity as the
 * model: re-extracting a document under a different pdfjs, or OCR'ing one that
 * previously had a text layer, produces different characters and therefore a
 * different vector for "the same" paragraph.
 */
export const TEXT_EXTRACTION_VERSION = 'pdfjs-legacy/v1'

export type SpaceStatus = 'active' | 'retired' | 'comparison'

/** The identity tuple. Every field here changes the vectors. */
export interface EmbeddingSpaceIdentity {
  modelId: string
  modelRevision: string
  modelFile: string
  dims: number
  quantization: string
  storedQuantization: string
  pooling: string
  normalized: boolean
  queryPrefix: string
  docPrefix: string
  chunkingVersion: string
  maxSeqLength: number
  textExtractionVersion: string
  runtime: string
}

export interface EmbeddingSpace extends EmbeddingSpaceIdentity {
  id: number
  configHash: string
  vecTable: string
  status: SpaceStatus
  createdAt: string
}

/** What `spaces.json` records for a model, keyed by its id. */
interface SpaceDescriptor {
  pooling: string
  normalized: boolean
  queryPrefix: string
  docPrefix: string
}

export class EmbeddingSpaceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EmbeddingSpaceError'
  }
}

/**
 * The model directory shipped in this build, as `<org>/<model>`, or null.
 *
 * DISCOVERED, not named. `@huggingface/transformers` resolves
 * `<localModelPath>/<org>/<model>/…`, so the layout is already two levels; this
 * walks it and returns the one directory that holds an ONNX file. More than one
 * is an ERROR rather than a pick, because "which model is this app using" would
 * then have no defensible answer and the wrong one is invisible.
 */
function discoverModelId(root: string): string | null {
  if (!existsSync(root)) return null
  const found: string[] = []
  for (const org of readdirSync(root)) {
    const orgDir = join(root, org)
    let entries: string[]
    try {
      if (!statSync(orgDir).isDirectory()) continue
      entries = readdirSync(orgDir)
    } catch {
      continue
    }
    for (const model of entries) {
      const onnxDir = join(orgDir, model, 'onnx')
      if (!existsSync(onnxDir)) continue
      if (readdirSync(onnxDir).some((f) => f.endsWith('.onnx'))) found.push(`${org}/${model}`)
    }
  }
  if (found.length > 1) {
    throw new EmbeddingSpaceError(
      `${found.length} embedding models are present under ${root} (${found.join(', ')}); ` +
        'exactly one may ship, or a search cannot say which space answered it'
    )
  }
  return found[0] ?? null
}

/**
 * Quantisation, read from the weights FILENAME.
 *
 * transformers.js names its exports by dtype (`model_quantized.onnx`,
 * `model_fp16.onnx`, `model.onnx`), and fp32 and int8 of the SAME model produce
 * different vectors — so this is part of the identity and is not derivable from
 * the model id.
 */
export function quantizationOf(file: string): string {
  if (/_quantized\.onnx$/.test(file)) return 'q8'
  if (/_fp16\.onnx$/.test(file)) return 'fp16'
  if (/_int8\.onnx$/.test(file)) return 'int8'
  if (/_uint8\.onnx$/.test(file)) return 'uint8'
  if (/_q4\.onnx$/.test(file)) return 'q4'
  return 'fp32'
}

/** transformers.js's `dtype` option for a quantisation we detected. */
export function dtypeFor(quantization: string): string {
  return quantization === 'fp32' ? 'fp32' : quantization === 'q8' ? 'q8' : quantization
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

/**
 * The space the SHIPPED bytes describe, or null when no model is packaged.
 *
 * Throws only when a model is present but cannot be characterised — a model we
 * cannot describe must never be embedded under guessed settings, because the
 * result is a plausible ranked list built from silently wrong pooling.
 */
export function resolveEmbeddingIdentity(): EmbeddingSpaceIdentity | null {
  const root = modelsDir()
  const modelId = discoverModelId(root)
  if (!modelId) return null

  const modelDir = join(root, modelId)
  const onnxDir = join(modelDir, 'onnx')
  const onnxFiles = readdirSync(onnxDir).filter((f) => f.endsWith('.onnx')).sort()
  if (onnxFiles.length !== 1) {
    throw new EmbeddingSpaceError(
      `${modelId} ships ${onnxFiles.length} .onnx files (${onnxFiles.join(', ')}); ` +
        'exactly one must, or the quantisation of a stored vector is ambiguous'
    )
  }
  const modelFile = `onnx/${onnxFiles[0]}`

  const config = readJson<{ hidden_size?: number; max_position_embeddings?: number }>(
    join(modelDir, 'config.json')
  )
  if (!config || typeof config.hidden_size !== 'number') {
    throw new EmbeddingSpaceError(
      `${modelId} has no readable config.json hidden_size — the vector dimensionality is ` +
        'what `vec0` fixes per table, so guessing it would build an index of the wrong shape'
    )
  }

  const tokenizer = readJson<{ model_max_length?: number }>(join(modelDir, 'tokenizer_config.json'))
  // The tokenizer's own limit, bounded by the position embeddings: a
  // tokenizer_config that claims a huge length (some ship 1e30 as a sentinel)
  // would let the stage believe nothing is ever truncated.
  const positional = config.max_position_embeddings ?? 0
  const claimed = tokenizer?.model_max_length ?? 0
  const maxSeqLength =
    positional > 0 && (claimed <= 0 || claimed > positional) ? positional : claimed
  if (!Number.isFinite(maxSeqLength) || maxSeqLength <= 0) {
    throw new EmbeddingSpaceError(
      `${modelId} declares no usable maximum sequence length — truncation governs what a ` +
        'vector actually represents, so it cannot be assumed'
    )
  }

  const descriptors = readJson<{ spaces?: Record<string, SpaceDescriptor> }>(
    resourcePath('models', 'spaces.json')
  )
  const descriptor = descriptors?.spaces?.[modelId]
  if (!descriptor) {
    throw new EmbeddingSpaceError(
      `no entry for '${modelId}' in resources/models/spaces.json. Pooling and the ` +
        'query/document prefixes are not discoverable from a model\'s own files, and ' +
        'getting either wrong degrades search silently rather than failing — so an ' +
        'undescribed model is refused rather than embedded on a guess'
    )
  }

  return {
    modelId,
    // The WEIGHTS' hash, not a version string. A model card re-uploaded under
    // the same name is a different model, and this is the only thing that
    // notices.
    modelRevision: createHash('sha256')
      .update(readFileSync(join(onnxDir, onnxFiles[0])))
      .digest('hex'),
    modelFile,
    dims: config.hidden_size,
    quantization: quantizationOf(onnxFiles[0]),
    // What lands in the vec0 column. FLOAT[n] today; a future int8 vec0 column
    // is a different space because the stored precision changes the neighbours.
    storedQuantization: 'fp32',
    pooling: descriptor.pooling,
    normalized: descriptor.normalized,
    queryPrefix: descriptor.queryPrefix,
    docPrefix: descriptor.docPrefix,
    chunkingVersion: CHUNKING_VERSION,
    maxSeqLength,
    textExtractionVersion: TEXT_EXTRACTION_VERSION,
    runtime: 'node-onnx'
  }
}

/**
 * The identity's single derived hash.
 *
 * Every field, in a fixed order, so adding one to the interface without adding
 * it here is visible: a field that does not reach the hash is a change that
 * cannot invalidate anything.
 */
export function configHashOf(id: EmbeddingSpaceIdentity): string {
  const parts = [
    `model=${id.modelId}`,
    `revision=${id.modelRevision}`,
    `file=${id.modelFile}`,
    `dims=${id.dims}`,
    `quant=${id.quantization}`,
    `stored=${id.storedQuantization}`,
    `pooling=${id.pooling}`,
    `normalized=${id.normalized ? 1 : 0}`,
    `qprefix=${id.queryPrefix}`,
    `dprefix=${id.docPrefix}`,
    `chunking=${id.chunkingVersion}`,
    `maxseq=${id.maxSeqLength}`,
    `textver=${id.textExtractionVersion}`,
    `runtime=${id.runtime}`
  ]
  return createHash('sha256').update(parts.join('|')).digest('hex')
}

const ROW_COLUMNS = `id, model_id, model_revision, model_file, dims, quantization,
  stored_quantization, pooling, normalized, query_prefix, doc_prefix,
  chunking_version, max_seq_length, text_extraction_version, runtime,
  config_hash, vec_table, status, created_at`

interface SpaceRow {
  id: number
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
  config_hash: string
  vec_table: string
  status: string
  created_at: string
}

function toSpace(row: SpaceRow): EmbeddingSpace {
  return {
    id: row.id,
    modelId: row.model_id,
    modelRevision: row.model_revision,
    modelFile: row.model_file,
    dims: row.dims,
    quantization: row.quantization,
    storedQuantization: row.stored_quantization,
    pooling: row.pooling,
    normalized: row.normalized === 1,
    queryPrefix: row.query_prefix,
    docPrefix: row.doc_prefix,
    chunkingVersion: row.chunking_version,
    maxSeqLength: row.max_seq_length,
    textExtractionVersion: row.text_extraction_version,
    runtime: row.runtime,
    configHash: row.config_hash,
    vecTable: row.vec_table,
    status: row.status as SpaceStatus,
    createdAt: row.created_at
  }
}

/** The space currently answering searches, or null. */
export function activeSpace(db: DB): EmbeddingSpace | null {
  const row = db
    .prepare(`SELECT ${ROW_COLUMNS} FROM embedding_space WHERE status = 'active'`)
    .get() as SpaceRow | undefined
  return row ? toSpace(row) : null
}

export function spaceById(db: DB, id: number): EmbeddingSpace | null {
  const row = db.prepare(`SELECT ${ROW_COLUMNS} FROM embedding_space WHERE id = ?`).get(id) as
    | SpaceRow
    | undefined
  return row ? toSpace(row) : null
}

/**
 * Find or create the row for an identity, and make it the active space.
 *
 * RETIRED, not deleted, when another space takes over: a switch must be
 * A/B-comparable before its predecessor's vectors are thrown away, and the old
 * `vec0` table survives until an explicit reclaim. Retiring first is also what
 * keeps `ux_embedding_space_active` satisfiable — the index permits exactly one
 * active row, so the demotion and the promotion are one transaction or neither.
 *
 * A `comparison` space is never promoted by this: it exists precisely to be
 * written and queried explicitly without answering a real search.
 */
export function ensureActiveSpace(
  db: DB,
  identity: EmbeddingSpaceIdentity,
  now: string
): EmbeddingSpace {
  const configHash = configHashOf(identity)
  return db.transaction((): EmbeddingSpace => {
    const existing = db
      .prepare(`SELECT ${ROW_COLUMNS} FROM embedding_space WHERE config_hash = ?`)
      .get(configHash) as SpaceRow | undefined

    if (existing && existing.status === 'active') return toSpace(existing)

    db.prepare(
      `UPDATE embedding_space SET status = 'retired'
        WHERE status = 'active' AND config_hash <> ?`
    ).run(configHash)

    if (existing) {
      if (existing.status === 'comparison') return toSpace(existing)
      db.prepare(`UPDATE embedding_space SET status = 'active' WHERE id = ?`).run(existing.id)
      return toSpace({ ...existing, status: 'active' })
    }

    const info = db
      .prepare(
        `INSERT INTO embedding_space
           (model_id, model_revision, model_file, dims, quantization, stored_quantization,
            pooling, normalized, query_prefix, doc_prefix, chunking_version, max_seq_length,
            text_extraction_version, runtime, config_hash, vec_table, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 'active', ?)`
      )
      .run(
        identity.modelId,
        identity.modelRevision,
        identity.modelFile,
        identity.dims,
        identity.quantization,
        identity.storedQuantization,
        identity.pooling,
        identity.normalized ? 1 : 0,
        identity.queryPrefix,
        identity.docPrefix,
        identity.chunkingVersion,
        identity.maxSeqLength,
        identity.textExtractionVersion,
        identity.runtime,
        configHash,
        now
      )
    const id = Number(info.lastInsertRowid)
    // The table name is DERIVED from the id, so it can only be written once the
    // row exists. Storing it rather than recomputing it everywhere means a
    // query names the table the row says, not the one a helper reconstructed.
    const vecTable = `chunk_vec_${id}`
    db.prepare('UPDATE embedding_space SET vec_table = ? WHERE id = ?').run(vecTable, id)
    return {
      ...identity,
      id,
      configHash,
      vecTable,
      status: 'active',
      createdAt: now
    }
  }).immediate()
}

/**
 * Create the space's `vec0` table if it is absent.
 *
 * The dimensionality comes from the REGISTRY ROW. There is no numeric literal
 * here and there must never be one: `vec0` fixes `FLOAT[n]` per table, so a
 * hardcoded n would build an index of the wrong shape for any future model and
 * fail as an opaque bind error far from the cause.
 *
 * THROWS if the table cannot be created. sqlite-vec is loaded on every
 * connection, so the only way to fail here is a real fault — and writing the
 * chunks anyway would leave a corpus that reports itself embedded while every
 * search over it scans the whole library.
 */
export function ensureVecTable(db: DB, space: EmbeddingSpace): void {
  const exists = db
    .prepare(`SELECT name FROM sqlite_master WHERE name = ?`)
    .get(space.vecTable)
  if (exists) return
  try {
    db.exec(
      `CREATE VIRTUAL TABLE ${space.vecTable} USING vec0(
         chunk_id INTEGER PRIMARY KEY,
         v FLOAT[${space.dims}]
       )`
    )
  } catch (err) {
    throw new Error(
      `could not create the vector index ${space.vecTable} for embedding space ${space.id} ` +
        `(${space.dims} dimensions): ${(err as Error).message}`
    )
  }
}

/** Every space's `vec_table`, so a sweep can visit tables no space is using. */
export function allVecTables(db: DB): string[] {
  return (
    db.prepare(`SELECT vec_table FROM embedding_space WHERE vec_table <> ''`).all() as Array<{
      vec_table: string
    }>
  )
    .map((r) => r.vec_table)
    .filter((name) => db.prepare(`SELECT name FROM sqlite_master WHERE name = ?`).get(name))
}
