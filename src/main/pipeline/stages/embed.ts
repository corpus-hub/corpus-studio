// Embedding a document's paragraphs into the active vector space.
//
// The space is DERIVED FROM THE BYTES ON DISK (`embedding/space.ts`), never
// named here: no model id and no dimensionality literal appears in this file,
// because a constant somebody forgets to bump is exactly how an index ends up
// half in one space and half in another, returning neighbours that are real for
// some rows and noise for others.
//
// That derivation is also the whole invalidation story. `fingerprint()` returns
// the space's `config_hash` — a digest over model, revision, weights file,
// dimensionality, quantisation, pooling, normalisation, both prefixes, the
// chunker version, the sequence limit and the text-extraction version. Swap the
// packaged model and the hash changes; the ORDINARY supersede cascade in
// `stageRun.ts` then retires every embed run and re-plans a re-embed, resumable
// because `stage_run` is per (work, document) and each commits alone. No
// special code path, which is the point of putting identity in the fingerprint
// rather than in a config flag.
//
// Vectors are written by `embedding/vectors.ts`, which is the only place a
// `vec0` row is created or destroyed — a virtual table takes no foreign key and
// no cascade, so vector lifetime cannot be left to the schema.

import { EMBED_BATCH, embedTexts } from '../../embedding/model'
import { chunkParagraphs } from '../../embedding/chunk'
import {
  configHashOf,
  EmbeddingSpaceError,
  ensureActiveSpace,
  ensureVecTable,
  resolveEmbeddingIdentity,
  type EmbeddingSpaceIdentity
} from '../../embedding/space'
import { insertChunks, type ChunkRecord } from '../../embedding/vectors'
import type { Paragraphs } from '../capabilities'
import type { StageDefinition } from '../types'

/**
 * The most chunks one document may contribute in a single run.
 *
 * A real ceiling, because a host-isolated stage's writes do NOT stream: they
 * accumulate in the host and cross to main in ONE terminal message, and
 * `MAX_ENVELOPE_BYTES` guards only the INPUT side of that boundary. At 384
 * dimensions a vector is 1.5 KB of Float32 and ~2 KB as base64, so this ceiling
 * is a few megabytes — comfortably inside the transport, and a document that
 * exceeds it is reported rather than silently producing a message that cannot
 * be delivered.
 */
const MAX_CHUNKS_PER_RUN = 2000

interface EmbedWrite {
  /**
   * The identity of the space these vectors were ACTUALLY produced under.
   *
   * Carried rather than re-derived, because `execute` runs in a host process
   * and `applyWrites` runs in main — two processes, and in principle two
   * different answers to "which model is packaged". Without this, vectors from
   * model A could be inserted into model B's table stamped with B's hash: the
   * exact cross-space mixing the registry exists to prevent, and afterwards
   * undetectable, because every row would agree with a hash that never
   * described it.
   */
  configHash: string
  chunks: Array<Omit<ChunkRecord, 'vector'> & { vectorB64: string }>
}

/**
 * The space this build would use, or null when no model is packaged.
 *
 * Never throws. `decideCache` calls `fingerprint()` OUTSIDE the stage's own
 * error handling, so a throw there escapes as an unhandled failure instead of
 * the `skipped` an unusable model deserves.
 */
function identityOrNull(): EmbeddingSpaceIdentity | null {
  try {
    return resolveEmbeddingIdentity()
  } catch {
    return null
  }
}

const embed: StageDefinition<{ chunks: number; dims: number; configHash: string }> = {
  id: 'embed',
  label: 'Embed for search',
  version: '1.0.0',
  rank: 5,
  scope: 'document',
  provides: ['text.embeddings@v1'],
  requires: ['text.paragraphs@v1'],
  usesLlm: false,
  runtime: 'node',
  // The ONNX session holds the JS thread for the whole of every batch —
  // measured: a 32-text batch took 561 ms with ZERO event-loop ticks. In main
  // that is a frozen window and a frozen synchronous SQLite for the length of
  // the document.
  isolation: 'host',
  weight: 'heavy',
  // Kill-only, for the same measured reason: nothing inside a batch can observe
  // an AbortSignal, so a grace period is time spent waiting for a cancel that
  // cannot arrive. The batch size is what bounds the delay before the kill.
  cancelGraceMs: 0,

  // THE SPACE IS THE FINGERPRINT. Everything that changes a vector is folded
  // into `config_hash` by `configHashOf`, so a model swap supersedes every run
  // through the existing cascade. 'absent' is stable, so a build with no model
  // caches its `skipped` — and provisioning one changes the hash and re-runs it.
  fingerprint() {
    const identity = identityOrNull()
    return identity ? `space=${configHashOf(identity)}` : 'space=absent'
  },

  async execute(ctx) {
    const paragraphs = ctx.input<Paragraphs>('text.paragraphs@v1')
    if (!paragraphs) {
      return { status: 'skipped', reason: 'no text.paragraphs@v1 — nothing to embed' }
    }

    let identity: EmbeddingSpaceIdentity | null
    try {
      identity = resolveEmbeddingIdentity()
    } catch (err) {
      if (err instanceof EmbeddingSpaceError) {
        // A model we cannot CHARACTERISE must never be embedded on a guess:
        // wrong pooling or a missing prefix produces a plausible ranked list
        // built from silently worse vectors, which is the failure mode this
        // whole registry exists to prevent. Refusing is the honest answer.
        return { status: 'skipped', reason: err.message }
      }
      throw err
    }
    if (!identity) {
      return {
        status: 'skipped',
        reason: 'no embedding model is packaged in this build; search stays keyword-only'
      }
    }

    const chunks = chunkParagraphs(paragraphs, {
      maxSeqLength: identity.maxSeqLength,
      docPrefix: identity.docPrefix
    })
    if (chunks.length === 0) {
      // A real claim about the paper: it segmented, and every paragraph in it
      // was a bibliography entry or blank. Terminal, cached, and `review`
      // rather than green, because that is unusual enough to be worth a look.
      return {
        status: 'empty',
        reason: `${paragraphs.paragraphs.length} paragraph(s) yielded no embeddable text`
      }
    }
    if (chunks.length > MAX_CHUNKS_PER_RUN) {
      return {
        status: 'failed',
        error:
          `${chunks.length} chunks exceeds the ${MAX_CHUNKS_PER_RUN} per-run ceiling; ` +
          'a host stage returns its writes in one message and this would not fit',
        retryable: false
      }
    }

    const records: EmbedWrite['chunks'] = []
    let truncatedCount = 0
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      // BETWEEN batches, which is the only place a cancel can be observed. The
      // kill is what makes it real inside one.
      if (ctx.signal.aborted) return { status: 'failed', error: 'cancelled', retryable: true }

      const batch = chunks.slice(i, i + EMBED_BATCH)
      const { vectors, truncated } = await embedTexts(
        identity,
        batch.map((c) => c.text),
        'document'
      )
      // `null` is the QUERY side's answer and cannot happen here — but the
      // column this fills is `NOT NULL` two-valued, so a defaulted `false` would
      // record that every chunk fitted when nothing measured it. Named as a
      // fault rather than narrowed with a `?? false`.
      if (truncated === null) {
        return {
          status: 'failed',
          error: 'the embedder returned no truncation measurement for a document batch',
          retryable: false
        }
      }
      for (let j = 0; j < batch.length; j++) {
        const c = batch[j]
        if (truncated[j]) truncatedCount++
        records.push({
          idx: c.idx,
          paraIds: c.paraIds,
          charStart: c.charStart,
          charEnd: c.charEnd,
          page: c.page,
          section: c.section,
          text: c.text,
          tokenEstimate: c.tokenEstimate,
          truncated: truncated[j],
          lowConfidence: c.lowConfidence,
          inputHash: c.inputHash,
          // base64, not an array of numbers: a 384-dimension vector is 1.5 KB
          // of Float32 and ~11 KB as JSON, and the whole document's writes
          // cross the host boundary in ONE message.
          vectorB64: vectors[j].toString('base64')
        })
      }
      ctx.progress(((i + batch.length) / chunks.length) * 100, `${i + batch.length}/${chunks.length} chunks`)
    }

    // The space ROW is not resolved here. A host process has no database, and
    // the id is only knowable once the row exists — so `applyWrites` resolves
    // it in main, inside the one transaction that also writes the vectors. What
    // travels is the space's IDENTITY, which main then checks against its own.
    ctx.write({ configHash: configHashOf(identity), chunks: records } satisfies EmbedWrite)

    const lowConfidence = records.filter((r) => r.lowConfidence).length
    const flags: string[] = []
    if (truncatedCount > 0) flags.push(`${truncatedCount} truncated`)
    if (lowConfidence > 0) flags.push(`${lowConfidence} too short to be reliable`)

    return {
      status: 'succeeded',
      // The space's HASH, not its row id: the id is assigned in main and
      // reporting a placeholder `0` here would store a number that names a real
      // space and is not the one this run used.
      result: { chunks: records.length, dims: identity.dims, configHash: configHashOf(identity) },
      note:
        `${records.length} chunk(s) at ${identity.dims} dimensions` +
        (flags.length > 0 ? ` — ${flags.join(', ')}` : '')
    }
  },

  applyWrites(db, payload, ctx) {
    const w = payload as EmbedWrite
    // A throw here rolls the whole transaction back and the scheduler re-queues
    // the job as transient — the vectors are recomputed rather than committed
    // under a space that did not produce them.
    let identity: EmbeddingSpaceIdentity | null
    try {
      identity = resolveEmbeddingIdentity()
    } catch (err) {
      throw new Error(
        `the embedding model became undescribable between execution and commit: ${(err as Error).message}`
      )
    }
    if (!identity) {
      // The model vanished between the host embedding it and main committing
      // it. Refusing is the only honest option: the vectors exist but nothing
      // can say what space they belong to, and storing them under a guess is
      // the corruption the registry exists to prevent.
      throw new Error('the embedding model disappeared between execution and commit')
    }
    // THE CHECK the payload's `configHash` exists for. Main and the host are
    // two processes and could, in principle, see two different packaged models;
    // committing under a mismatch would mix spaces invisibly, because every row
    // would then agree with a hash that never described it.
    const mainHash = configHashOf(identity)
    if (mainHash !== w.configHash) {
      throw new Error(
        `these vectors were produced under space ${w.configHash.slice(0, 12)} but this ` +
          `process now resolves ${mainHash.slice(0, 12)} — refusing to mix two vector spaces`
      )
    }
    const space = ensureActiveSpace(db, identity, new Date().toISOString())
    // Lazily, from the REGISTRY ROW: `vec0` fixes FLOAT[n] per table, so the
    // dimensionality comes from the row and never from a literal.
    ensureVecTable(db, space)

    insertChunks(
      db,
      space,
      { stageRunId: ctx.stageRunId, documentId: ctx.documentId, workId: ctx.workId },
      w.chunks.map((c) => ({
        idx: c.idx,
        paraIds: c.paraIds,
        charStart: c.charStart,
        charEnd: c.charEnd,
        page: c.page,
        section: c.section,
        text: c.text,
        tokenEstimate: c.tokenEstimate,
        truncated: c.truncated,
        lowConfidence: c.lowConfidence,
        inputHash: c.inputHash,
        vector: Buffer.from(c.vectorB64, 'base64')
      })),
      new Date().toISOString()
    )

    // Published from HERE, not from `execute`, because the space id does not
    // exist until the row does. A later stage asking what was embedded gets the
    // id in the same transaction that created it, so an artifact can never name
    // a space that was rolled back.
    return [
      [
        'text.embeddings@v1',
        {
          documentId: ctx.documentId,
          spaceId: space.id,
          configHash: space.configHash,
          dims: space.dims,
          chunkCount: w.chunks.length
        }
      ]
    ]
  }
}

export default embed
