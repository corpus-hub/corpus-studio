// Running the cross-encoder. The library itself is reached only through
// `../ml/transformers`, which owns the offline settings and the
// never-in-the-renderer rule — read its header before touching model loading.
//
// THE MANUAL PATH IS DELIBERATE. `pipeline('text-classification')` softmaxes
// over the label axis, and this head has ONE label: softmax of a single logit
// is exactly 1.0, for every pair, forever. That failure is invisible — the
// scores are numbers, they sort, the list looks ordinary — so the pipeline
// helper must never be used here. `AutoTokenizer` + `AutoModelForSequence-
// Classification` with `text_pair` returns the raw logit, which is the only
// thing worth ranking on.
//
// LOAD ISOLATION IS LOAD-BEARING, not incidental. `transformersFor` sets
// `env.localModelPath`, a MUTABLE PROCESS GLOBAL, on every call. Two cold loads
// racing in one process therefore resolve against whichever root was set last:
// load the reranker, then load a cold embedder without re-pointing the global,
// and it looks for `rerankers/Snowflake/snowflake-arctic-embed-s/…` — an ENOENT
// naming a path nobody recognises, and one dropped `allowRemoteModels` line
// away from being a network fetch instead. The reranker is intended to run in
// its OWN host process for exactly this reason; the session memoised below is
// what keeps the window between setting the global and `from_pretrained`
// `await`-free after warm-up.

import { rerankersDir } from '../resources'
import { transformersFor } from '../ml/transformers'
import { dtypeFor } from '../embedding/space'
import { resolveRerankerIdentity, RerankerError } from './identity'
import type { RerankerIdentity } from './identity'

/**
 * How many pairs go into one model call. ONE, on purpose.
 *
 * Measured on this machine: 105 ms/pair at batch 1 against 85.6 ms/pair at
 * batch 32. A cross-encoder is COMPUTE-bound where the bi-encoder is not — it
 * runs the full transformer over every pair rather than amortising a matmul —
 * so batching buys about 20% and costs all cancellation granularity, because
 * onnxruntime-node yields zero event-loop ticks inside a call. At batch 32 a
 * kill is up to 2.7 s of unobservable time; at 1 it is a tenth of a second.
 * With no throughput worth defending, take the responsiveness.
 */
export const RERANK_BATCH = 1

/** One pair's answer. */
export interface PairScore {
  /** The RAW logit. Not a probability: rank it, never threshold it. */
  logit: number
  /** `sigmoid(logit)`, for readability only. Monotone in `logit`, so it changes
   *  no ordering and adds no information. */
  score: number
  /**
   * Tokens the QUERY lost to truncation. 0 means it was scored whole.
   *
   * SEPARATE from the passage's counter, and that separation is the point. One
   * boolean would merge the ordinary case — a long passage lost its tail, so
   * the score is a real answer about the paper's opening — with the alarming
   * one: the QUERY was cut, so the score answers a question the user did not
   * ask, and it will be sorted alongside scores that answered the real one.
   * Those are different facts and must not share a field.
   */
  queryTokensDropped: number
  /** Tokens the PASSAGE lost. 0 means it was scored whole. */
  passageTokensDropped: number
}

/**
 * The truncation of a pair could not be MEASURED.
 *
 * Its own type, following `TruncationUnknownError`, so a caller can name the
 * tokenizer as the obstacle — a broken reranker install, not a bad paper. Zero
 * is not the absence of a claim; it is the positive claim that nothing was cut.
 */
export class RerankTruncationUnknownError extends Error {
  constructor(readonly why: string) {
    super(
      `The reranker's tokenizer could not be asked how long a (query, passage) pair is ` +
        `(${why}), so whether either side was truncated is unknown. Reporting 0 dropped ` +
        'tokens would record that the model read the whole question and the whole passage ' +
        'when nothing checked. Nothing was scored. Re-provision the packaged reranker.'
    )
    this.name = 'RerankTruncationUnknownError'
  }
}

interface TokenizedPair {
  input_ids?: { dims?: number[]; data?: ArrayLike<number | bigint> }
}

type Tokenizer = ((texts: string[], opts: Record<string, unknown>) => TokenizedPair) & {
  sep_token_id?: number
  sep_token?: string
  model?: { tokens_to_ids?: Map<string, number> }
}

type Classifier = (inputs: TokenizedPair) => Promise<{ logits: { data: ArrayLike<number> } }>

interface Session {
  key: string
  identity: RerankerIdentity
  tokenizer: Tokenizer
  model: Classifier
  /** Special tokens the PAIR encoding adds, measured from the empty pair. */
  overhead: number
  /** The id of the separator that closes each side, read from the tokenizer. */
  sepId: number
}

/**
 * The loaded session, memoised per PROCESS.
 *
 * Same argument as `loadExtractor`: the int8 session costs about a second to
 * build and paying that per dispatch would dominate a short run. A host process
 * serves one dispatch at a time, so there is no concurrency hazard, and a
 * cancel kills the process and takes the session with it.
 */
let cached: Session | null = null

function cacheKey(id: RerankerIdentity): string {
  return `${id.modelId}|${id.modelFile}|${id.quantization}`
}

async function loadReranker(identity: RerankerIdentity): Promise<Session> {
  if (cached && cached.key === cacheKey(identity)) return cached

  const t = await transformersFor(rerankersDir())
  const tokenizer = (await t.AutoTokenizer.from_pretrained(identity.modelId, {
    local_files_only: true
  })) as unknown as Tokenizer
  const model = (await t.AutoModelForSequenceClassification.from_pretrained(identity.modelId, {
    dtype: dtypeFor(identity.quantization) as never,
    local_files_only: true
  })) as unknown as Classifier

  cached = {
    key: cacheKey(identity),
    identity,
    tokenizer,
    model,
    overhead: pairOverhead(tokenizer),
    sepId: sepTokenId(tokenizer)
  }
  return cached
}

/** Release the memoised session. */
export async function disposeReranker(): Promise<void> {
  const held = cached as unknown as { model?: { dispose?: () => Promise<void> } } | null
  cached = null
  await held?.model?.dispose?.()
}

/**
 * How many special tokens the PAIR encoding adds, from the empty pair.
 *
 * MEASURED, never hardcoded. `[CLS] q [SEP] p [SEP]` is 3 for this BERT-family
 * model and 4 for a RoBERTa-family one (`</s></s>`), so a literal 3 is a claim
 * about one specific tokenizer inside a module whose whole discipline is
 * deriving from the bytes on disk — and it is wrong silently, in the direction
 * that under-reports truncation.
 */
function pairOverhead(tokenizer: Tokenizer): number {
  let length: number | undefined
  try {
    length = tokenizer([''], { text_pair: [''], padding: false, truncation: false }).input_ids
      ?.dims?.[1]
  } catch (err) {
    throw new RerankTruncationUnknownError(err instanceof Error ? err.message : String(err))
  }
  if (typeof length !== 'number') {
    throw new RerankTruncationUnknownError(
      'the tokenizer returned no input_ids length for the empty pair'
    )
  }
  return length
}

/** One side's own length, unpadded, untruncated, without special tokens. */
function bareTokens(tokenizer: Tokenizer, text: string): number {
  let length: number | undefined
  try {
    length = tokenizer([text], {
      padding: false,
      truncation: false,
      add_special_tokens: false
    }).input_ids?.dims?.[1]
  } catch (err) {
    throw new RerankTruncationUnknownError(err instanceof Error ? err.message : String(err))
  }
  if (typeof length !== 'number') {
    throw new RerankTruncationUnknownError('the tokenizer returned no input_ids length')
  }
  return length
}

/**
 * The QUERY alone did not fit, so the model was shown no passage.
 *
 * Its own type rather than a large `passageTokensDropped`, because the caller
 * must not treat what came back as a weak match. The encoding contains no
 * separator at all: the sequence is the head of the question and nothing else,
 * and the logit is the model's answer to "how relevant is this query to the
 * empty string". That sorts perfectly happily among real scores, which is the
 * whole danger — a paper would be ranked by a number that never read it.
 */
export class RerankQueryOverflowError extends Error {
  constructor(
    readonly queryTokens: number,
    readonly budget: number
  ) {
    super(
      `the query alone is ${queryTokens} tokens against a ${budget}-token budget, so the ` +
        'encoded pair contains no passage at all. A logit computed against an absent ' +
        'passage is not a low relevance score, it is not a relevance score. Nothing was ' +
        'scored. Shorten the text being asked about.'
    )
    this.name = 'RerankQueryOverflowError'
  }
}

/**
 * The separator id, READ from the tokenizer rather than written down.
 *
 * 102 is `[SEP]` for exactly this vocabulary; the same literal is `</s>` for a
 * RoBERTa-family reranker and an ordinary word piece for a third. Hardcoding it
 * would make the kept-length measurement below silently locate the wrong index
 * and report a truncation that never happened.
 */
function sepTokenId(tokenizer: Tokenizer): number {
  const fromMap = tokenizer.sep_token
    ? tokenizer.model?.tokens_to_ids?.get(tokenizer.sep_token)
    : undefined
  const id = typeof tokenizer.sep_token_id === 'number' ? tokenizer.sep_token_id : fromMap
  if (typeof id !== 'number') {
    throw new RerankTruncationUnknownError('the tokenizer names no separator token')
  }
  return id
}

/**
 * What each side ACTUALLY kept, read off the encoding the model was given.
 *
 * NOT arithmetic. transformers.js does not balance the two halves of an
 * over-long pair — it right-truncates the CONCATENATED sequence — so a closed
 * form derived from any truncation strategy answers a different question than
 * the one the model was asked, and answers it with an ordinary-looking number
 * that nothing contradicts. The layout is `[CLS] query [SEP] passage [SEP]`, so
 * the separators are the only witnesses to where one side ended: the first is
 * one past the query's last token, and the gap between the two is the passage.
 *
 * Fewer than two separators is not a parse failure, it is truncation reaching
 * the tail. With ONE, the cut landed inside the passage and took its closing
 * separator with it — the passage is still mostly present, so its kept length
 * is everything after the first separator, NOT zero. Reading it as zero would
 * report a 600-token abstract as entirely unread when the model in fact saw its
 * first five hundred tokens, which is the same species of invented number this
 * measurement replaced, merely erring the other way. With NONE, the query
 * itself overflowed and there is no pair left to describe.
 *
 * `ids` must be ONE sequence with no padding — true here because a pair is
 * encoded alone (see `RERANK_BATCH`), and a pad token after the tail would
 * otherwise be counted as passage.
 */
function keptFromEncoding(
  ids: readonly number[],
  sepId: number
): { qKept: number; pKept: number } | null {
  const seps: number[] = []
  for (let i = 0; i < ids.length; i++) if (ids[i] === sepId) seps.push(i)
  if (seps.length === 0) return null
  if (seps.length === 1) return { qKept: seps[0] - 1, pKept: ids.length - seps[0] - 1 }
  return { qKept: seps[0] - 1, pKept: seps[1] - seps[0] - 1 }
}

/** The encoded ids, as plain numbers — the tensor's data may be BigInt64. */
function idsOf(encoded: TokenizedPair): number[] {
  const data = encoded.input_ids?.data
  if (!data) {
    throw new RerankTruncationUnknownError('the tokenizer returned no input_ids for the pair')
  }
  const out: number[] = []
  for (let i = 0; i < data.length; i++) out.push(Number(data[i]))
  return out
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x))
}

/**
 * Score each passage against the query.
 *
 * ONE PAIR AT A TIME (see `RERANK_BATCH`), with the abort signal checked
 * between pairs — nothing inside a model call can observe it, so between calls
 * is the only place the check means anything. An aborted run returns the scores
 * it actually took rather than a partial array padded with invented ones.
 */
export async function scorePairs(
  query: string,
  passages: readonly string[],
  signal?: AbortSignal
): Promise<PairScore[]> {
  const identity = resolveRerankerIdentity()
  if (!identity) {
    throw new RerankerError(
      'no reranker model is packaged in this build, so no pair can be scored'
    )
  }
  const session = await loadReranker(identity)
  const budget = identity.maxSeqLength - session.overhead
  if (budget <= 0) {
    throw new RerankerError(
      `${identity.modelId} has a ${identity.maxSeqLength}-token limit and its pair encoding ` +
        `already spends ${session.overhead} of it, leaving no room for text`
    )
  }

  const queryTokens = bareTokens(session.tokenizer, query)
  const out: PairScore[] = []

  for (const passage of passages) {
    if (signal?.aborted) break

    const passageTokens = bareTokens(session.tokenizer, passage)

    const inputs = session.tokenizer([query], {
      text_pair: [passage],
      padding: true,
      truncation: true
    })
    const kept = keptFromEncoding(idsOf(inputs), session.sepId)
    if (!kept) throw new RerankQueryOverflowError(queryTokens, budget)
    const { qKept, pKept } = kept

    const { logits } = await session.model(inputs)
    const logit = Number(logits.data[0])

    out.push({
      logit,
      score: sigmoid(logit),
      queryTokensDropped: queryTokens - qKept,
      passageTokensDropped: passageTokens - pKept
    })
  }

  return out
}
