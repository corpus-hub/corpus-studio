// Stage 0 — obtain the bytes the rest of the pipeline needs, for a paper that
// was imported by IDENTIFIER and therefore arrived with no file at all.
//
// This is the front gate: it declares `before: ['document.file@v1']`, so it runs
// ahead of `download` (which only RESOLVES what the library already holds) and
// everything downstream of it depends on this one through that edge.
//
// The split between the two is the point. `download` answers "where are this
// document's bytes"; this answers "do we have any". Before this stage existed a
// paper imported by DOI ran the whole queue against a document with zero
// `file_location` rows: every stage correctly reported `skipped` ("no
// document.file@v1 to work from"), every job settled to `done`, and the user was
// shown ten green rows for a paper the app had never once tried to fetch. The
// statuses were each individually true and the sum of them was a lie.
//
// Retrieval runs through whatever PLUGIN can do it -- the same route the Ingest
// screen's search uses -- because publishers serve a JS challenge that cannot be
// satisfied from outside a real browser, and driving the user's own browser is
// not something this app does itself.
//
// With NO such plugin the stage is `skipped`, never `refused`. The difference is
// the whole of what this stage exists to keep honest: `refused` says this paper
// cannot be fetched, which would be a claim about the paper made by an install
// that never looked.

import { createHash } from 'node:crypto'
import { NoRetrievalPluginError, retrievePdfViaPlugins } from '../pluginRetrieval'
import { enabledPluginsWithCapability } from '../../plugins/host'
import { storeLibraryBytes } from '../../db/library'
import { linkManagedFile } from '../../db/repos/fileLocations'
import { RETRIEVAL_GATE } from '../gate/llmGate'
import type { StageDefinition } from '../types'

/** The first five bytes every PDF starts with. */
const PDF_MAGIC = '%PDF-'

interface RetrieveWrite {
  relativePath: string
  sha256: string
  sizeBytes: number
  source: string
}

/**
 * A filename derived from what identifies the paper, never from its title.
 *
 * Domain-neutral and collision-safe: `storeLibraryBytes` already de-duplicates
 * by name and compares bytes, so the only requirement here is stability.
 */
function fileNameFor(doi: string, workId: number): string {
  const stem = doi.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 100) || `work-${workId}`
  return `${stem}.pdf`
}

const retrieve: StageDefinition<{ source: string; sizeBytes: number }> = {
  id: 'retrieve',
  label: 'Fetch PDF',
  version: '1.0.0',
  rank: 0,
  scope: 'document',
  // Provides NOTHING. It writes the `file_location` row that `download` then
  // resolves and measures, rather than emitting `document.file@v1` itself —
  // `download` must stay the single originator of that token, and the file it
  // finds afterwards is indistinguishable from one the user dropped in.
  provides: [],
  requires: [],
  // The front-gate declaration: "I am a precondition of whoever provides the
  // document's bytes". This is what makes `refused` here cancel the entire
  // downstream chain instead of letting ten stages each skip on their own.
  before: ['document.file@v1'],
  usesLlm: false,
  runtime: 'node',
  weight: 'light',

  /**
   * Keyed on the stage's INPUTS — the identifiers it can fetch with — and on
   * nothing this stage itself writes.
   *
   * IT USED TO HASH ITS OWN OUTPUT. `document.retrieval_status` and the
   * presence of a canonical `file_location` were both in the key, and both are
   * written BY this stage's execution: the run is claimed while the status is
   * `not-attempted` and settles it to `failed` or `retrieved`. So the stored
   * fingerprint could never again equal the recomputed one, and every paper
   * that had ever attempted a fetch was permanently, irreversibly "stale" —
   * the queue offered to redo work that had already reached its final answer.
   * Measured: every refused paper in this corpus read `not-attempted` when its
   * run was claimed and `failed` afterwards. A stage may not fingerprint its
   * own effect; that is a loop, not a dependency.
   *
   * WHAT THIS DOES NOT BREAK. `retrieval_status` was there to stop a failed
   * fetch being retried on every launch, and it still is stopped — by the
   * CACHE, which is the mechanism for that: a `refused` run is cacheable, so
   * with a stable fingerprint the scheduler serves it and the publisher is not
   * touched again. The user's explicit retry re-arms the job and bypasses the
   * cache, which is the path that was always meant to reopen this.
   */
  fingerprint(ctx) {
    // EVERY scheme this stage can fetch with, not just the DOI.
    //
    // The key held the DOI alone, so for a paper whose only identifier is an
    // arXiv id the fingerprint was byte-identical before and after that id was
    // added — and the scheduler, seeing an unchanged key, replayed the stored
    // refusal instead of running the stage. The paper was then permanently
    // stuck: adding the very identifier that would fix it could not change the
    // input the decision was cached against. Ordered so the key is stable
    // regardless of insertion order.
    const ids = ctx.db
      .prepare(
        `SELECT scheme, value FROM identifier
          WHERE work_id = ? AND scheme IN ('doi','url','arxiv')
          ORDER BY scheme, value`
      )
      .all(ctx.workId) as { scheme: string; value: string }[]
    const idKey = ids.map((i) => `${i.scheme}=${i.value}`).join(',')
    // WHETHER A FILE IS PRESENT — and deliberately not `retrieval_status`.
    //
    // These look alike and are not. `retrieval_status` is this stage's own
    // VERDICT, moved by its own execution, so hashing it is the loop described
    // above. A file EXISTING is an input: it can appear without this stage
    // running at all — the user drops a PDF in, restores one that was deleted,
    // or remaps the base_dir of a NAS that was offline. Without it, a paper
    // refused as "recorded as retrieved but no file could be found" would stay
    // refused after the file came back, because the refusal is cacheable and
    // nothing in its key had changed. Presence only, never a path or an mtime,
    // so moving the library between mount points does not invalidate anything.
    const hasFile = ctx.db
      .prepare(
        `SELECT 1 FROM file_location WHERE document_id = ? AND role = 'canonical' LIMIT 1`
      )
      .get(ctx.documentId)
    // A paper that already HOLDS its file is finished with this stage: `execute`
    // returns `not-needed` on the first line without consulting anything else.
    // So nothing beyond the identifiers and the file can change its answer, and
    // the key stops here.
    if (hasFile) return `ids=${idKey}|file=1`

    // ONLY FOR A PAPER WITH NO FILE: whether anything can fetch at all.
    //
    // It belongs in the key for the same reason the file does — it is an input
    // that moves without this stage running. `skipped` is cacheable, so a corpus
    // processed with no retrieval plugin skips every paper, and installing one
    // afterwards would change nothing anybody could see if the key had not
    // moved.
    //
    // But it is the APP'S configuration, not a fact about the paper, and a key
    // that carries it unconditionally makes every paper in the corpus stale each
    // time a plugin is installed, removed or toggled — including the ones whose
    // PDF is already on disk and which such a change cannot possibly affect.
    // That is what put all 33 papers of a project up for reprocessing here.
    // Confining it to the case where it can alter the outcome keeps the signal
    // and drops the false alarm.
    //
    // Presence of the CAPABILITY, not which plugins offer it: swapping one
    // retriever for another is not a reason to re-fetch anything.
    const canRetrieve = enabledPluginsWithCapability('paper-retrieval').length > 0
    return `ids=${idKey}|file=0|ret=${canRetrieve ? 1 : 0}`
  },

  async execute(ctx) {
    // Already holds a file. Nothing to fetch, and that is a success, not a gap:
    // this is the ordinary case for every PDF the user imported directly.
    if (ctx.db.pdfPath()) {
      return { status: 'not-needed', reason: 'this document already has a local file' }
    }

    const status = ctx.db.retrievalStatus()
    if (status === 'retrieved') {
      // NOTHING WAS DECLINED HERE. The column says a fetch succeeded and the
      // file it names is not on disk, so the app's own record disagrees with
      // itself. That is a broken library, not an answer about the paper, and
      // `refused` renders as "Stopped on purpose" — which told the user that a
      // PDF disappearing from under them was intended behaviour.
      //
      // NOT retryable: the same lookup finds the same absent file, so the
      // attempt is refunded and the job waits for the user, whose remedy this
      // is — restore the file, remount the library, or attach the PDF again.
      //
      // The DOCUMENT keeps `retrieval_status = 'retrieved'`, which is why this
      // writes nothing. It really was fetched once, and a NAS that is merely
      // unmounted will mount again; overwriting a true fact to describe a
      // condition that may not outlast the afternoon is how the record starts
      // lying in the other direction.
      return {
        status: 'failed',
        error:
          'this document is recorded as retrieved but no file could be found for it — ' +
          'the library file may have been moved or deleted',
        retryable: false
      }
    }
    if (status === 'paywalled') {
      return {
        status: 'refused',
        reason:
          'no full text could be obtained for this paper: the publisher requires a ' +
          'subscription. Only its abstract and metadata are available.'
      }
    }

    const doi = ctx.db.identifiers().find((i) => i.scheme === 'doi')?.value
    const storedUrl = ctx.db.identifiers().find((i) => i.scheme === 'url')?.value
    // An arXiv id IS a way to fetch a PDF, and the most reliable one there is:
    // the file is open access at a URL derived from the id, with no paywall,
    // no mirror and no challenge in the way.
    //
    // Only `doi` and `url` used to be read, so seven papers imported by arXiv
    // id — Ethayarajh, All-but-the-Top, and every other arXiv import — were
    // refused with "no DOI or URL, add the PDF yourself" while their PDFs sat
    // one derived URL away. The identifier was in the row the whole time; the
    // stage simply did not look at the scheme it was stored under.
    //
    // The version suffix is kept when present (2202.00113v2 is a real file) and
    // absent otherwise, which is what arXiv serves as "latest".
    const arxivId = ctx.db.identifiers().find((i) => i.scheme === 'arxiv')?.value
    const url =
      storedUrl ?? (arxivId ? `https://arxiv.org/pdf/${encodeURIComponent(arxivId)}` : undefined)
    if (!doi && !url) {
      // A mechanical fact: no row of either scheme exists. Nothing to guess at,
      // and guessing from a title is exactly the false positive that would
      // attach the wrong paper's PDF to this record.
      return {
        status: 'refused',
        reason:
          'this paper has no DOI or URL, so there is no identifier to fetch a PDF with. ' +
          'Add the PDF yourself to process it.'
      }
    }

    ctx.progress(10, 'asking for the PDF')

    let got: { source: string; bytes: Buffer }
    try {
      // ONE AT A TIME, process-wide. Two of these in parallel are two callers on
      // the same free OA APIs, and that burst is what turned eight retrievable
      // papers into eight "no source produced a valid pdf" in one second. The
      // gate holds for the whole retrieval, not just the first request, because
      // one retrieval is a LADDER of requests — the OA APIs, then a publisher,
      // then the mirrors — and releasing after the first would let the ladders
      // interleave, which is the same burst one level down.
      //
      // The caller's cancellation is honoured while WAITING as well as while
      // holding, so a queued retrieval the user cancels does not sit in line for
      // a slot it will never use.
      got = await RETRIEVAL_GATE.run(
        () => retrievePdfViaPlugins({ doi, pdfUrl: url }, { signal: ctx.signal }),
        { signal: ctx.signal }
      )
    } catch (err) {
      if (ctx.signal.aborted) return { status: 'failed', error: 'cancelled', retryable: true }
      // NOTHING WAS ASKED. Not a fact about this paper, so not `refused` and not
      // written onto the document: an install with no retrieval plugin would
      // otherwise accumulate a permanent "no PDF could be retrieved" on every
      // paper in the corpus, which the user would have to clear one by one after
      // installing one.
      if (err instanceof NoRetrievalPluginError) {
        return { status: 'skipped', reason: err.message }
      }
      const msg = (err as Error).message
      // The attempt HAPPENED and produced no bytes. Recorded on the document so
      // the state survives the job row and the user can see it on the paper
      // itself, then `failed` — this is a fetch that did not work, not a
      // decision not to fetch.
      //
      // It was `refused`, which the Queue renders as "Stopped on purpose". That
      // is what the stage says when it DECLINES: no identifier to fetch with, a
      // publisher that requires a subscription — answers about the paper, given
      // without a failure. Every source erroring out is the opposite: the app
      // tried and could not, and "stopped on purpose" told the user their own
      // network, plugin or browser problem was intended behaviour and offered
      // them nothing to do about it.
      //
      // NOT retryable, so the attempt is refunded and the publisher is not hit
      // four more times on a curve. A `failed` job is the user's to retry, which
      // is the path that was always meant to reopen this.
      ctx.write({ failure: msg } satisfies { failure: string })
      return {
        status: 'failed',
        error: `no PDF could be retrieved for this paper — ${msg}`,
        retryable: false
      }
    }

    if (ctx.signal.aborted) return { status: 'failed', error: 'cancelled', retryable: true }

    // A source that answers with an HTML paywall interstitial rather than a PDF
    // is the common failure that would otherwise be stored as a document and
    // fail much later, in `extract-text`, as an unexplained parse error.
    if (got.bytes.subarray(0, 5).toString('latin1') !== PDF_MAGIC) {
      ctx.write({ failure: `${got.source} returned something that is not a PDF` } satisfies {
        failure: string
      })
      return {
        status: 'failed',
        error: `no PDF could be retrieved for this paper — ${got.source} returned a non-PDF response`,
        retryable: false
      }
    }

    ctx.progress(80, 'saving into the library')

    const sha256 = createHash('sha256').update(got.bytes).digest('hex')
    // Written BEFORE the transaction that registers it, for the same reason
    // `ingestPdfBytes` does it in that order: a rollback cannot un-write a file,
    // so an orphaned file is recoverable where a row naming absent bytes is not.
    const stored = storeLibraryBytes(fileNameFor(doi ?? `work-${ctx.workId}`, ctx.workId), got.bytes)
    if (stored.outcome === 'failed' || stored.outcome === 'missing-source') {
      return {
        status: 'failed',
        error: `could not save the retrieved PDF into the library: ${stored.error ?? stored.outcome}`,
        retryable: true
      }
    }

    ctx.write({
      relativePath: stored.relativePath,
      sha256,
      sizeBytes: got.bytes.length,
      source: got.source
    } satisfies RetrieveWrite)

    return {
      status: 'succeeded',
      result: { source: got.source, sizeBytes: got.bytes.length },
      note: `${got.source} (${Math.round(got.bytes.length / 1024)} KB)`
    }
  },

  applyWrites(db, payload, ctx) {
    const w = payload as RetrieveWrite | { failure: string }
    if ('failure' in w) {
      // `failed` only from the three states that mean "no answer yet";
      // `paywalled` and `retrieved` are answers already given and are never
      // overwritten by a later attempt that merely could not reach a source.
      db.prepare(
        `UPDATE document SET retrieval_status = 'failed'
          WHERE id = ? AND retrieval_status IN ('not-attempted','pending','failed')`
      ).run(ctx.documentId)
      return
    }
    // `linkManagedFile` sets `retrieval_status = 'retrieved'` itself, and is the
    // only place allowed to: it writes the `role='canonical'`/`version=1` row
    // that `download`'s resolution query is the mirror of.
    linkManagedFile(
      db,
      {
        documentId: ctx.documentId,
        relativePath: w.relativePath,
        hash: w.sha256,
        sizeBytes: w.sizeBytes,
        lastModified: new Date().toISOString()
      },
      new Date().toISOString()
    )
  }
}

export default retrieve
