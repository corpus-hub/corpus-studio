// Fetching a PDF through whatever plugin can do it.
//
// NAMES NO PLUGIN. The set is `enabledPluginsWithCapability('paper-retrieval')`,
// asked at the moment of the call, so a second retrieval plugin is reached on
// the same path the first is and a disabled one is not reached at all.
//
// EVERY plugin is tried, in id order, and the first that produces bytes wins.
// Picking only the first installed one would let a plugin that cannot reach a
// particular publisher speak for every plugin that can — and the user's only
// symptom would be a paper that "cannot be retrieved" while something on their
// own machine could have retrieved it.

import {
  enabledPluginsWithCapability,
  pluginCapabilityVerb,
  pluginCtx,
  pluginSignal
} from '../plugins/host'
import { PAPER_RETRIEVAL_OFF_SENTENCE } from '../../shared/contract/plugins'

/** What a retrieval produced. `source` is provenance, and is bounded before storage. */
export interface RetrievedPdf {
  source: string
  bytes: Buffer
}

/**
 * Largest file a retrieval may hand back.
 *
 * Generous — scanned theses and supplementary-heavy chemistry papers really do
 * reach hundreds of megabytes — and bounded because nothing downstream is. The
 * bytes are held whole in main's heap, hashed, written, and then READ BACK WHOLE
 * for a collision comparison (`storeLibraryBytes`), so an unbounded answer is
 * several copies of it in memory at once. A plugin need not be hostile for this:
 * a resolver that followed a redirect to a video is the ordinary version.
 */
const MAX_PDF_BYTES = 512 * 1024 * 1024

/** Raised when nothing installed can even be asked. Distinct from "asked and failed". */
export class NoRetrievalPluginError extends Error {
  constructor() {
    super(PAPER_RETRIEVAL_OFF_SENTENCE)
    this.name = 'NoRetrievalPluginError'
  }
}

/**
 * A provenance label, bounded to what it is used as.
 *
 * It is stored on the document and rendered, so it is held to a short printable
 * line: no control or bidi characters, nothing unbounded, and never a URL —
 * a resolver's URL can carry an API key, and this string outlives the run.
 */
function shapeSource(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback
  const s = raw.trim()
  if (s.length === 0 || s.length > 64) return fallback
  return /^[A-Za-z0-9][A-Za-z0-9 ._:-]*$/.test(s) && !s.includes('://') ? s : fallback
}

/**
 * A plugin's whole account of why it found nothing.
 *
 * A retrieval plugin's message is not one sentence: it is a per-source log, and the sources
 * are in ladder order, so the LAST of them are the mirrors — the ones that decide whether a
 * paywalled paper is obtainable at all. A head-first cut removes exactly those. It did:
 * a ScienceDirect refusal carrying its debug page-probe filled 200 characters on its own,
 * and the user was shown a paywall and nothing about the three mirrors that were also asked,
 * which reads as a retrieval that gave up at the publisher.
 *
 * So this bounds the message WITHOUT choosing which end survives — the plugin has already
 * bounded each of its own entries, and the scheduler stores 500. If a message is somehow
 * still longer than anything a person will read, keep both ends and say how much went: the
 * first sources and the last sources are both load-bearing and the middle is the only part
 * that can be spared.
 */
const FAILURE_MAX = 480

function shapeFailure(msg: string): string {
  if (msg.length <= FAILURE_MAX) return msg
  const half = Math.floor((FAILURE_MAX - 24) / 2)
  const dropped = msg.length - half * 2
  return `${msg.slice(0, half)} ...[${dropped} chars]... ${msg.slice(-half)}`
}

/**
 * Ask each plugin in turn until one produces bytes.
 *
 * Throws `NoRetrievalPluginError` when there is nothing to ask — which the
 * caller must distinguish from a failed attempt, because "we tried and could
 * not" and "there was nothing here to try" are different things to tell a user
 * and only one of them is about the paper.
 *
 * The signal is combined with each plugin's own, so disabling a plugin
 * mid-retrieval stops the call rather than leaving it running against a plugin
 * the host has already torn down.
 */
export async function retrievePdfViaPlugins(
  request: { doi?: string; pdfUrl?: string },
  opts: { signal?: AbortSignal } = {}
): Promise<RetrievedPdf> {
  const ids = enabledPluginsWithCapability('paper-retrieval')
  if (ids.length === 0) throw new NoRetrievalPluginError()

  const failures: string[] = []
  let wentAway = 0
  for (const id of ids) {
    if (opts.signal?.aborted) throw new Error('cancelled')
    const own = pluginSignal(id)
    const both = [opts.signal, own].filter((s): s is AbortSignal => s != null)
    const signal = both.length > 1 ? AbortSignal.any(both) : both[0]
    try {
      const got = await pluginCapabilityVerb<unknown>(
        id,
        'retrievePdf',
        PAPER_RETRIEVAL_OFF_SENTENCE,
        pluginCtx(id),
        request,
        { signal }
      )
      const bytes = (got as { bytes?: unknown } | null)?.bytes
      // A plugin that answered with something that is not bytes has NOT
      // retrieved anything, and treating its answer as a document would store a
      // file the rest of the pipeline then fails to parse, far from here.
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        failures.push(`${id}: answered with no file`)
        continue
      }
      if (bytes.length > MAX_PDF_BYTES) {
        // Reported per plugin and the loop CONTINUES: another plugin may find a
        // sane copy of the same paper, and refusing the whole retrieval over one
        // resolver's runaway answer would lose that.
        failures.push(
          `${id}: answered with ${Math.round(bytes.length / 1024 / 1024)} MB, which is too large to be a paper`
        )
        continue
      }
      return { source: shapeSource((got as { source?: unknown }).source, id), bytes }
    } catch (err) {
      // The user's cancellation is not a plugin failure and must not be recorded
      // as one, nor should it send the loop on to the next plugin.
      if (opts.signal?.aborted) throw err
      const msg = err instanceof Error ? err.message : String(err)
      // THE PLUGIN WENT AWAY WHILE WE WERE ASKING — switched off, removed, or
      // torn down by the host between the capability query above and the call.
      // That is still "there was nothing here to try" and must not be counted
      // as an attempt: the list was non-empty when we looked, but nobody ever
      // answered about this paper, and recording `refused` would put a claim
      // about the paper on the document that no retrieval ever supported.
      if (msg === PAPER_RETRIEVAL_OFF_SENTENCE) {
        wentAway += 1
        continue
      }
      failures.push(`${id}: ${shapeFailure(msg)}`)
    }
  }
  // Every plugin we had disappeared mid-flight, so no attempt was made at all.
  if (failures.length === 0 && wentAway > 0) throw new NoRetrievalPluginError()
  throw new Error(failures.join('; ') || 'no plugin produced a file')
}
