// What a reranker LOGIT means, derived from the bytes on disk rather than
// asserted in code. The cross-encoder's counterpart to `embedding/space.ts`,
// and it exists for a slightly worse version of the same reason.
//
// A cosine between two embedding spaces is a number, not an error. A logit is
// worse: it is unbounded in both directions, uncalibrated, and only ORDINALLY
// comparable to logits from the same (weights, tokenizer, truncation regime).
// Two models' scores merged into one ranked list produce a list that is wrong
// while looking perfectly ordinary — and unlike a cosine there is not even a
// range check that would catch it. So the identity's hash is what a stage puts
// in its fingerprint, and a model swap retires every stored score through the
// ordinary supersede cascade instead of a special code path.
//
// No model id appears in TypeScript here either: the id is DISCOVERED under
// `rerankersDir()` and everything derivable comes from the model's own files.
//
// DELIBERATELY ABSENT, and they must not be copied over from
// `EmbeddingSpaceIdentity`: `dims`, `pooling`, `normalized`, `queryPrefix`,
// `docPrefix`, `storedQuantization`. A cross-encoder emits ONE logit, not a
// pooled vector — there is no dimensionality, no `vec0` table, nothing stored
// as a vector and nothing normalised, and carrying `dims` would invite someone
// to build an index over a scalar. The asymmetry a bi-encoder encodes in a
// prefix is STRUCTURAL here, in which member of the pair is `text` and which is
// `text_pair`, so there is no prefix to get wrong and an empty-string field
// would suggest there is. Each of those fields would assert an identity this
// model does not have.
//
// `chunkingVersion` and `textExtractionVersion` are absent for a different
// reason: they are real invalidators but they are not facts about the MODEL.
// The reranker scores whatever passages it is handed. A caller that needs them
// composes them into its own fingerprint beside this hash rather than merging
// them into "which model ranked this", which is what the user is told.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { rerankersDir } from '../resources'
import { quantizationOf } from '../embedding/space'

/** The identity tuple. Every field here changes the logits. */
export interface RerankerIdentity {
  modelId: string
  /** sha256 of the WEIGHTS. A model card re-uploaded under the same name is a
   *  different model, and this is the only thing that notices. */
  modelRevision: string
  modelFile: string
  quantization: string
  maxSeqLength: number
  /** How an over-long PAIR is trimmed. Not discoverable; see rerankers.json. */
  truncationSide: string
  /** What the number IS — a raw logit, plus its sigmoid. Never a probability. */
  scoreSemantics: string
  runtime: string
}

/** What `rerankers.json` records for a model, keyed by its id. */
interface RerankerDescriptor {
  truncationSide: string
  scoreSemantics: string
}

export class RerankerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RerankerError'
  }
}

/**
 * The reranker directory shipped in this build, as `<org>/<model>`, or null.
 *
 * A deliberate near-duplicate of `discoverModelId`, NOT a refactor target. The
 * two throws say different things to whoever reads them — a search that cannot
 * name its space is a different failure from a ranked list that cannot name
 * what ordered it — and the shared helper's next caller would be the one that
 * quietly parameterises away the "exactly one" rule that is the whole value.
 */
function discoverRerankerId(root: string): string | null {
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
    throw new RerankerError(
      `${found.length} rerankers are present under ${root} (${found.join(', ')}); ` +
        'exactly one may ship, or a ranked list cannot say which model ordered it'
    )
  }
  return found[0] ?? null
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

/**
 * The reranker the SHIPPED bytes describe, or null when none is packaged.
 *
 * Null and a throw mean different things and the caller must keep them apart:
 * null is "this build carries no reranker", which is an ordinary skip-with-a-
 * reason. A throw is "a model is here but cannot be characterised", and it is
 * the same refusal the embedder makes — a model we cannot describe must never
 * be run on guessed settings, because the output is an ordinary-looking ranked
 * list built from a truncation regime nobody chose.
 */
/**
 * The last weights hash, kept against the stat of the file it was taken from.
 *
 * `modelRevision` is a sha256 of the ENTIRE .onnx file — 23 MB for the packaged
 * cross-encoder — and this function is called from a `fingerprint()` hook, so a
 * staleness sweep of a 184-paper project re-read and re-hashed those bytes 184
 * times: 4 GB of hashing, 5.6 s of it, on the Electron main thread with every
 * renderer IPC queued behind it. That was 84% of the whole sweep.
 *
 * THE SLOT LIVES AS LONG AS THE PROCESS; WHAT EXPIRES IS ITS VALIDITY. Every
 * call still walks the directory and stats the file, and the hash is reused only
 * while the path, the size AND the mtime all still match — so a swapped, updated
 * or removed model is seen on the next call, not at the next launch. What this
 * hash exists to notice is a model card re-uploaded under the same name, which
 * rewrites the bytes and moves the mtime; a value trusted WITHOUT that check
 * would defeat exactly that, the trap `memoizeConstantHooks` avoids by scoping
 * to one sweep. Only the re-read of bytes a stat has already shown unchanged is
 * skipped, because hashing 23 MB to learn what the stat established is the part
 * with no value.
 */
let weightsHashCache: { path: string; size: number; mtimeMs: number; hash: string } | null = null

function weightsHash(path: string): string {
  const stat = statSync(path)
  const hit =
    weightsHashCache !== null &&
    weightsHashCache.path === path &&
    weightsHashCache.size === stat.size &&
    weightsHashCache.mtimeMs === stat.mtimeMs
  if (hit) return (weightsHashCache as { hash: string }).hash
  const hash = createHash('sha256').update(readFileSync(path)).digest('hex')
  weightsHashCache = { path, size: stat.size, mtimeMs: stat.mtimeMs, hash }
  return hash
}

export function resolveRerankerIdentity(): RerankerIdentity | null {
  const root = rerankersDir()
  const modelId = discoverRerankerId(root)
  if (!modelId) return null

  const modelDir = join(root, modelId)
  const onnxDir = join(modelDir, 'onnx')
  const onnxFiles = readdirSync(onnxDir).filter((f) => f.endsWith('.onnx')).sort()
  if (onnxFiles.length !== 1) {
    throw new RerankerError(
      `${modelId} ships ${onnxFiles.length} .onnx files (${onnxFiles.join(', ')}); ` +
        'exactly one must, or the quantisation behind a recorded score is ambiguous'
    )
  }
  const modelFile = `onnx/${onnxFiles[0]}`

  const config = readJson<{ max_position_embeddings?: number }>(join(modelDir, 'config.json'))
  const tokenizer = readJson<{ model_max_length?: number }>(join(modelDir, 'tokenizer_config.json'))
  // The tokenizer's own limit, bounded by the position embeddings — some
  // tokenizer_configs ship 1e30 as a sentinel, and believing it would let the
  // stage report that nothing is ever truncated.
  const positional = config?.max_position_embeddings ?? 0
  const claimed = tokenizer?.model_max_length ?? 0
  const maxSeqLength =
    positional > 0 && (claimed <= 0 || claimed > positional) ? positional : claimed
  if (!Number.isFinite(maxSeqLength) || maxSeqLength <= 0) {
    throw new RerankerError(
      `${modelId} declares no usable maximum sequence length — the budget decides which ` +
        'half of a pair is cut, and a score whose query was cut answers a different ' +
        'question, so it cannot be assumed'
    )
  }

  const descriptors = readJson<{ rerankers?: Record<string, RerankerDescriptor> }>(
    join(root, 'rerankers.json')
  )
  const descriptor = descriptors?.rerankers?.[modelId]
  if (!descriptor) {
    throw new RerankerError(
      `no entry for '${modelId}' in resources/rerankers/rerankers.json. Which side of an ` +
        'over-long pair is truncated, and what the emitted number is, are not discoverable ' +
        "from a model's own files, and getting either wrong reorders a ranked list without " +
        'failing anywhere — so an undescribed reranker is refused rather than scored on a guess'
    )
  }

  return {
    modelId,
    modelRevision: weightsHash(join(onnxDir, onnxFiles[0])),
    modelFile,
    // Shared with the embedder ON PURPOSE rather than copied: the packaging
    // step names the weights `model_quantized.onnx` precisely so this reads
    // them honestly. A file whose name it does not recognise falls through to
    // 'fp32', which is why the vendored name is the local one and not
    // upstream's `model_qint8_avx512.onnx`.
    quantization: quantizationOf(onnxFiles[0]),
    maxSeqLength,
    truncationSide: descriptor.truncationSide,
    scoreSemantics: descriptor.scoreSemantics,
    runtime: 'node-onnx'
  }
}

/**
 * The identity's single derived hash.
 *
 * Every field, in a fixed order, so a field added to the interface and not to
 * this list is visible as a change that cannot invalidate anything.
 */
export function rerankerConfigHash(id: RerankerIdentity): string {
  const parts = [
    `model=${id.modelId}`,
    `revision=${id.modelRevision}`,
    `file=${id.modelFile}`,
    `quant=${id.quantization}`,
    `maxseq=${id.maxSeqLength}`,
    `trunc=${id.truncationSide}`,
    `score=${id.scoreSemantics}`,
    `runtime=${id.runtime}`
  ]
  return createHash('sha256').update(parts.join('|')).digest('hex')
}
