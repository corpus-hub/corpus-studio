// Running the embedding model. The library itself is reached only through
// `../ml/transformers`, which owns the offline settings and the
// never-in-the-renderer rule — read its header before touching model loading.

import { modelsDir } from '../resources'
import { transformersFor } from '../ml/transformers'
import type { EmbeddingSpaceIdentity } from './space'
import { dtypeFor } from './space'

/**
 * How many texts go into one `extractor()` call.
 *
 * Small ON PURPOSE. Measured on this machine: a 32-text batch takes ~560 ms and
 * yields ZERO event-loop ticks — onnxruntime-node holds the JS thread for the
 * whole call. So the batch size is the granularity of cancellation: the signal
 * is checked between batches and cannot be observed inside one. 16 keeps the
 * worst-case delay before a kill takes effect under a third of a second while
 * still amortising the per-call overhead.
 */
export const EMBED_BATCH = 16

type Extractor = ((
  texts: string[],
  opts: { pooling: string; normalize: boolean }
) => Promise<{ data: Float32Array; dims: number[] }>) & {
  /**
   * The pipeline's own tokenizer.
   *
   * Reached for one reason: TRUTHFUL TRUNCATION. Whether a chunk was truncated
   * is a claim about what its vector actually represents, and only the real
   * WordPiece tokenizer knows — a character heuristic gets it wrong in both
   * directions, and a chunk that silently stands for its first 512 tokens while
   * claiming to stand for all of it is precisely the fabrication this project
   * forbids.
   */
  tokenizer?: (texts: string[], opts: Record<string, unknown>) => {
    input_ids?: { dims?: number[] }
  }
}

/**
 * The loaded pipeline, memoised per PROCESS.
 *
 * Loading the int8 session costs ~1 s and a few hundred megabytes; paying that
 * per job would dominate the work for a short document. A host process is
 * exclusive to one dispatch at a time, so there is no concurrency hazard, and a
 * cancel `kill()`s the whole process — which takes the session with it. The
 * cost of holding it is stated rather than hidden: a host that has embedded
 * once carries the session for as long as it lives.
 */
let cached: { key: string; extractor: Extractor } | null = null

/** Identity that must match for the memoised session to be reusable. */
function cacheKey(identity: EmbeddingSpaceIdentity): string {
  return `${identity.modelId}|${identity.modelFile}|${identity.quantization}`
}

export async function loadExtractor(identity: EmbeddingSpaceIdentity): Promise<Extractor> {
  const key = cacheKey(identity)
  if (cached && cached.key === key) return cached.extractor

  const t = await transformersFor(modelsDir())

  const pipe = (await t.pipeline('feature-extraction', identity.modelId, {
    dtype: dtypeFor(identity.quantization) as never,
    local_files_only: true
  })) as unknown as Extractor
  cached = { key, extractor: pipe }
  return pipe
}

/** Release the memoised session. Used by the query worker on shutdown. */
export async function disposeExtractor(): Promise<void> {
  const held = cached as unknown as { extractor?: { dispose?: () => Promise<void> } } | null
  cached = null
  await held?.extractor?.dispose?.()
}

export interface EmbedResult {
  /** One Float32 buffer per input, `dims` values each. */
  vectors: Buffer[]
  /**
   * Per input: did the tokenizer truncate it? NULL on the QUERY side.
   *
   * Truncation is a property of a STORED vector — `chunk.truncated` is what a
   * later reader consults to decide whether a hit stands for the whole of its
   * text — and a query vector is never stored, so there is nothing for the
   * answer to be recorded against. Not measured at all, therefore, rather than
   * measured as `false`: `false` is the positive claim that the text fitted, and
   * inventing it is the optimistic answer this module exists to refuse.
   *
   * NULL and not `[]`, which is the same argument one level up. An empty array
   * is still an array, so `truncated[0]` on a query answers `undefined`, and
   * `undefined` is falsy — every natural way to read it ("was this truncated?")
   * silently returns the "no" that was never established. The absence has to be
   * in the TYPE, so a caller that has a query result cannot reach an element
   * without first saying what it means for there to be none. Today's callers are
   * safe by luck (`vectorWorker` destructures only `vectors`); the next one
   * would not have been.
   */
  truncated: boolean[] | null
}

/**
 * Embed a batch, applying the space's own prefix and pooling.
 *
 * The PREFIX IS ASYMMETRIC for some families — a query is prefixed and a
 * passage is not — and applying the wrong one silently costs retrieval quality
 * without erroring anywhere. So the caller says which side it is on and the
 * text is never prefixed by guesswork here.
 *
 * The side also decides whether truncation is MEASURED at all, and that is a
 * blast-radius decision rather than an optimisation. `truncationOf` refuses when
 * the tokenizer cannot answer, which is right for `document`: the measurement is
 * about to be written into a `NOT NULL` two-valued column, so not taking it must
 * stop the write. On the QUERY side nothing is stored and no column needs
 * filling — asking anyway would let a broken tokenizer turn every search in the
 * app into an error, failing the read path over a fact only the write path
 * needs.
 */
export async function embedTexts(
  identity: EmbeddingSpaceIdentity,
  texts: readonly string[],
  side: 'query' | 'document'
): Promise<EmbedResult> {
  const extractor = await loadExtractor(identity)
  const prefix = side === 'query' ? identity.queryPrefix : identity.docPrefix
  const prefixed = texts.map((t) => prefix + t)

  const out = await extractor(prefixed, {
    pooling: identity.pooling,
    normalize: identity.normalized
  })

  const dims = identity.dims
  if (out.data.length !== texts.length * dims) {
    throw new Error(
      `the model returned ${out.data.length} values for ${texts.length} text(s) at ${dims} ` +
        'dimensions — the space and the loaded weights disagree'
    )
  }

  const vectors: Buffer[] = []
  for (let i = 0; i < texts.length; i++) {
    const slice = out.data.subarray(i * dims, (i + 1) * dims)
    // COPIED, not a view: `subarray` shares the batch's backing store, so
    // keeping the views alive would pin the whole batch's memory and the buffer
    // handed to SQLite would alias data the next batch overwrites.
    vectors.push(Buffer.from(new Float32Array(slice).buffer))
  }

  return {
    vectors,
    truncated:
      side === 'document'
        ? await truncationOf(extractor, prefixed, identity.maxSeqLength)
        : null
  }
}

/**
 * The truncation of a chunk could not be MEASURED.
 *
 * Its own type so the stage can name the tokenizer as the obstacle — this is a
 * broken embedding install, not a bad paper — rather than reporting a document
 * that would not embed.
 */
export class TruncationUnknownError extends Error {
  constructor(readonly why: string) {
    super(
      `The embedding tokenizer could not be asked how long a chunk is (${why}), so whether ` +
        'the model truncated it is unknown. `chunk.truncated` is stored as a yes/no and ' +
        'answering "no" here would record that a vector represents its whole text when ' +
        'nothing checked. Nothing was embedded. Re-provision the packaged embedding model.'
    )
    this.name = 'TruncationUnknownError'
  }
}

export function isTruncationUnknown(err: unknown): boolean {
  return err instanceof TruncationUnknownError
}

/**
 * Which of these texts the model actually truncated.
 *
 * Asked of the REAL tokenizer, one text at a time and unpadded, so the answer
 * is that text's own length rather than the batch's longest. A character-count
 * heuristic was tried and is not good enough: WordPiece splits scientific text
 * — chemical names, units, numbers — far harder than prose, so any single
 * chars-per-token constant is wrong in both directions, and being wrong in the
 * optimistic direction means a chunk stands for its first N tokens while
 * claiming to stand for all of it.
 *
 * A tokenizer that cannot answer therefore RAISES. `false` is not the absence
 * of a claim, it is the optimistic claim — the one that says this vector stands
 * for the whole chunk — and it is stored as provenance and read back by search
 * to decide whether a hit can be trusted. `chunk.truncated` is `NOT NULL` and
 * two-valued, so there is nowhere to put "unknown"; the honest move is to
 * embed nothing rather than to write down a measurement that was not taken.
 */
export async function truncationOf(
  extractor: Extractor,
  texts: readonly string[],
  maxSeqLength: number
): Promise<boolean[]> {
  const tokenizer = extractor.tokenizer
  if (!tokenizer) {
    throw new TruncationUnknownError(
      'the loaded feature-extraction pipeline exposes no tokenizer'
    )
  }
  return texts.map((t) => {
    let length: number | undefined
    try {
      length = tokenizer([t], { padding: false, truncation: false }).input_ids?.dims?.[1]
    } catch (err) {
      throw new TruncationUnknownError(err instanceof Error ? err.message : String(err))
    }
    if (typeof length !== 'number') {
      throw new TruncationUnknownError('the tokenizer returned no input_ids length')
    }
    return length > maxSeqLength
  })
}
