// Add the paper to a RUNNING Zotero, once it has been fetched and optimized.
//
// LAST STEP OF THE FIRST PHASE, deliberately. The phase's job is "get the PDF",
// and this is the point at which the bytes exist and are final: pushing before
// `optimize` would hand Zotero a file the very next stage rewrites, and pushing
// later would hold a paper back from the user's library behind text extraction
// and a chain of LLM work it has nothing to do with.
//
// PROVIDES NOTHING, TRANSFORMS NOTHING. It is a pure side effect on another
// application, so no downstream stage can depend on it and its failure cannot
// starve anything: the pipeline is exactly as it would be if this stage did not
// exist. That is the whole reason it is safe to run a network call to a
// third-party app inside the pipeline at all.
//
// It never WRITES `zotero.sqlite` — see `outlets/zotero/connector.ts` for why
// that file is untouchable and why the connector is the safe path.

import { readZoteroConnection } from '../../outlets/settings'
import { pushItem, ZoteroUnreachableError, type ZoteroPushInput } from '../../outlets/zotero/connector'
import type { StageDefinition } from '../types'

/**
 * Corpus Studio's `work_type` in Zotero's vocabulary.
 *
 * A conservative map: anything without a clear counterpart becomes
 * `journalArticle`, Zotero's own default for a bibliographic record, rather than
 * a near-miss type that would misdescribe the paper in the user's library.
 */
const ITEM_TYPES: Record<string, string> = {
  'journal-article': 'journalArticle',
  preprint: 'preprint',
  'conference-paper': 'conferencePaper',
  book: 'book',
  'book-chapter': 'bookSection',
  review: 'journalArticle',
  dataset: 'dataset',
  thesis: 'thesis',
  other: 'document'
}

/**
 * Split a stored full name into the two halves Zotero wants.
 *
 * Corpus Studio keeps `given_name`/`family_name` when a source supplied them,
 * and only this fallback has to guess. The guess is the conventional one — last
 * whitespace-separated token is the family name — and a single-token name is
 * given to `lastName` whole rather than being torn in two, which is what keeps
 * mononyms and organisation names intact.
 */
function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/)
  if (parts.length <= 1) return { firstName: '', lastName: full.trim() }
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] }
}

/**
 * What the run records about itself. No rows are written; see `execute`.
 *
 * `attachedPdf` is a real measurement, not a constant: the file is uploaded when
 * this app holds one, Zotero is asked to find an open copy when it does not, and
 * a paywalled paper legitimately gets neither.
 */
interface PushResult {
  target: string
  attachedPdf: boolean
}

const zoteroPush: StageDefinition<PushResult> = {
  id: 'zotero-push',
  label: 'Add to Zotero',
  // 1.1.0 SENDS THE FILE. 1.0.0 sent the bibliographic record alone, so a paper
  // pushed by it sits in Zotero with nothing to read. The bump is what reopens
  // those: `version` is in the fingerprint, so every paper this stage already
  // settled becomes stale and can be sent again, now with its PDF.
  version: '1.1.0',
  // After `optimize` (rank 2) within the same phase, so the file it announces is
  // the one that will survive.
  rank: 3,
  // PROJECT-SCOPED, because the destination is a per-project setting and this
  // stage cannot run without knowing which project's it is.
  //
  // `document` scope looked right — the thing being sent is one document — and
  // was silently wrong: the planner stamps `project_id = 0` on a document-scoped
  // job, so `ctx.db.zoteroConnection()` read the sentinel key at run time and
  // always answered "not connected", while `fingerprint()` — which runs during
  // planning, where the REAL project id is in scope — keyed on the destination.
  // Connecting therefore re-armed the stage, which then ran and skipped, for
  // ever, reporting nothing wrong.
  scope: 'project',
  provides: [],
  requires: ['document.file@v1'],
  usesLlm: false,
  runtime: 'node',
  // INLINE, because both the destination and the record are read from the
  // database at run time and a host process has none.
  isolation: 'inline',
  weight: 'light',

  /**
   * NO CONNECTION, NO JOB. A project that does not send papers to Zotero does
   * not have a Zotero step, and the Queue says nothing about one.
   *
   * Zero keys is the planner's "this stage does not apply here", and it is the
   * only honest shape for this stage: an install that never set Zotero up has
   * no destination, so there is no work to report on. Planning it anyway put an
   * "Add to Zotero · Skipped" row against every paper in the corpus — an
   * exception badge on the normal case, which is what §0.6 exists to stop, and
   * a queue whose steps describe an integration the reader never chose.
   *
   * NOT the same as returning `skipped` from `execute`: that answer is about a
   * paper, and reaching it requires having planned, claimed and run a job to
   * learn something the planner already knew.
   *
   * `zotero:connect` and `zotero:disconnect` re-plan this stage for the whole
   * project, which is what makes the queue follow the setting rather than the
   * next unrelated import.
   */
  fanOut(ctx) {
    if (readZoteroConnection(ctx.db, ctx.projectId) === null) return []
    // The empty key is the one an unfanned stage already wrote, so a corpus
    // pushed before this existed keeps its runs and is not re-sent.
    return [{ key: '' }]
  },

  /**
   * Keyed on the DESTINATION, so re-pointing this project re-arms the stage and
   * every paper is offered to the new library.
   *
   * Deliberately NOT keyed on whether Zotero is running: that changes every time
   * the user closes the app, and folding it in would mark every paper in the
   * corpus stale each time they quit Zotero.
   *
   * Reads `readZoteroConnection` directly where `execute` calls
   * `ctx.db.zoteroConnection()` — the SAME stored key through two different
   * handles, because planning gets a raw `DB` and a running stage gets the
   * narrowed `StageReadDb`. Not a second source of truth.
   */
  fingerprint(ctx) {
    const conn = readZoteroConnection(ctx.db, ctx.projectId)
    return conn === null ? 'zotero|off' : `zotero|${conn.targetId}`
  },

  async execute(ctx) {
    const conn = ctx.db.zoteroConnection()
    if (conn === null) {
      // `skipped`, never `failed`. Not having connected Zotero is a choice about
      // this machine, not a defect in the paper, and painting the pipeline red
      // for it would misstate how bad the situation is.
      return { status: 'skipped', reason: 'this project does not send papers to Zotero' }
    }

    const record = ctx.db.bibliographicRecord()
    if (!record) return { status: 'skipped', reason: 'no work row to send' }

    const ids = ctx.db.identifiers()
    const doi = ids.find((i) => i.scheme === 'doi')?.value ?? null
    const url = ids.find((i) => i.scheme === 'url')?.value ?? null

    const input: ZoteroPushInput = {
      title: record.title,
      doi,
      year: record.year,
      venue: record.venue,
      itemType: ITEM_TYPES[record.workType] ?? 'journalArticle',
      url,
      // THE FILE THIS APP READ, sent as bytes. `pdfPath()` validates the
      // location against its base dir and answers null when the document has no
      // resolvable file — a metadata-only paper, or one whose drive is not
      // mounted — in which case the connector falls back to asking Zotero to
      // find an open copy.
      pdfPath: ctx.db.pdfPath()?.absPath ?? null,
      creators: record.authors.map((a) =>
        // The stored halves are preferred over any guess; `splitName` runs only
        // when a source gave us nothing but a display name.
        a.family !== null && a.family.length > 0
          ? { firstName: a.given ?? '', lastName: a.family }
          : splitName(a.full)
      )
    }

    try {
      // NOTHING IS PERSISTED HERE. The effect of this stage lives in Zotero, and
      // the `stage_run` row already records that it ran, against which
      // destination (via the fingerprint) and when. A row of our own asserting
      // "this paper is in Zotero" would be a claim we cannot keep true — the
      // user can delete the item there and we would never know.
      //
      // `fetchPdf` stays on as the FALLBACK: it is consulted only when this app
      // has no file of its own, and asks Zotero to look for an open copy. A
      // paper we never retrieved is exactly the case where Zotero's resolvers
      // can still help.
      const res = await pushItem(input, conn.targetId, { fetchPdf: true })
      return {
        status: 'succeeded',
        result: { target: conn.targetId, attachedPdf: res.attachedPdf },
        // The SHORTFALL is named. "Added" over a record with no full text reads
        // as complete, and the user finds out by opening Zotero and finding
        // nothing to read.
        note: res.attachedPdf
          ? `added to ${conn.targetName} with its PDF`
          : `added to ${conn.targetName} — no PDF (${res.pdfNote ?? 'none available'})`
      }
    } catch (e) {
      if (e instanceof ZoteroUnreachableError) {
        // FAILED, not skipped — and the asymmetry with the not-connected branch
        // above is deliberate. Not connecting is a settled choice: there is
        // nowhere to send the paper and nothing went wrong. A connected Zotero
        // that is closed is an unmet expectation: the user said this paper
        // belongs in their library and it is not there. Reporting `skipped`
        // would record that as a non-event, and the paper would be missing from
        // Zotero with nothing anywhere saying so.
        //
        // `retryable`, so starting Zotero and re-running settles it. The import
        // screens ask BEFORE queueing, so this is reached mainly when Zotero
        // quits mid-run or a re-plan happens with it closed.
        return { status: 'failed', error: 'Zotero is not running.', retryable: true }
      }
      return {
        status: 'failed',
        error: e instanceof Error ? e.message : String(e),
        retryable: true
      }
    }
  }
}

export default zoteroPush
