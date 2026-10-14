// Reading citation-verification CANDIDATES and writing the verdicts.
//
// The SQL half of the two-sided citation claim, kept out of the stage for the
// reason every other store in this directory is: a stage body may execute in a
// host process that has no database, so what it may touch is a narrow set of
// named lookups rather than a handle. Both functions here are called from main —
// the candidate read through `ctx.db`, the write through `applyWrites`.

import { createHash } from 'node:crypto'
import type { DB } from '../db/connection'
import type { CitationCandidateRow } from '../pipeline/types'

/**
 * Passages awaiting verification, newest bibliography first.
 *
 * The predicate is the whole idempotence story, so it is worth reading closely:
 *
 * - `occurrence_kind = 'inline'`. A bibliography row is a printed reference
 *   line, not a statement about the cited paper; there is nothing in it for a
 *   model to verify and asking would spend a call to be told so.
 * - `edge_id IS NOT NULL`. A two-sided claim needs a second side. A reference
 *   that resolved to nothing names a paper we do not have, so there are no
 *   blocks to point at — those contexts stay exactly as they are, one-sided and
 *   honestly labelled, and are re-offered here the moment a retrieval promotes
 *   them (`promoteReferenceEntry` rewrites `edge_id` in place).
 * - `sentence IS NOT NULL` and long enough to BE a claim. `sentenceAt` heals a
 *   fragment by absorbing neighbours, but growth is bounded by the paragraph, so
 *   a paragraph that IS the string `9` still yields `9`. Verifying that would
 *   ask a model whether a page number references a paper.
 * - no current link, OR a link from a DIFFERENT prompt version. Without the
 *   second arm a prompt bump would move the fingerprint, re-run the sweep, and
 *   re-verify nothing — the upsert would be unreachable code.
 *
 * `cited_chunk_count` is computed here rather than discovered by a failed
 * search, because "the cited paper has no embedded text" is a verdict
 * (`unverifiable`) rather than an error, and deciding it costs one COUNT instead
 * of a worker round trip.
 */
/**
 * WHICH passages are candidates. ONE definition, used by both readers.
 *
 * The stage asks this question twice — once to fingerprint the pending set and
 * once to fetch it — and the two must not be able to disagree. They did, in the
 * first draft: the fingerprint's copy omitted the minimum length and the
 * self-citation guard, so it counted passages the fetch would never return, and
 * a sweep could be woken by a change it then had no work for. A shared fragment
 * makes that unrepresentable rather than merely unlikely.
 *
 * Both bind, in order: MIN_PASSAGE_CHARS, then the current prompt version.
 */
const CANDIDATE_WHERE = /* sql */ `
       WHERE c.occurrence_kind = 'inline'
         AND c.edge_id IS NOT NULL
         AND c.sentence IS NOT NULL
         AND LENGTH(TRIM(c.sentence)) >= ?
         AND (l.id IS NULL
              -- An 'unverifiable' verdict is a statement about the CORPUS at a
              -- moment ("that paper had no readable text"), not about the
              -- passage, so it must expire when the corpus changes. Without this
              -- arm the row is excluded forever: the cited paper embeds, the
              -- fingerprint moves, the sweep wakes — and finds nothing to do,
              -- which is precisely the case the user asked to be handled.
              OR l.verdict = 'unverifiable'
              OR l.prompt_version IS NULL
              OR l.prompt_version <> ?
              -- …OR the cited paper was RE-EMBEDDED after this verdict was
              -- reached. target_chunk_id references chunk(id) ON DELETE SET
              -- NULL, and a re-embed deletes every chunk and mints new ids, so
              -- the anchor is not stale — it is GONE, silently, while
              -- the verdict beside it still reads as current. Work 1 of this
              -- corpus re-embedded 33 minutes after its links were written and
              -- lost all 17 of its anchors that way, leaving 61 verified links
              -- and 0 anchors on the most-cited paper in the library.
              --
              -- The whole verdict is re-offered, not merely the anchor, because
              -- the blocks the model chose from no longer exist either: a
              -- judgement made against an inventory that has been replaced is a
              -- judgement about something else. Re-verifying rewrites
              -- created_at, so this settles after one pass rather than
              -- re-offering the same rows forever.
              OR l.created_at < (SELECT MAX(k.embedded_at) FROM chunk k
                                  WHERE k.work_id = e.cited_work_id))
         -- A paper does not cite itself, and a self-edge is a parse artefact
         -- rather than a claim worth a model call.
         AND c.citing_work_id <> e.cited_work_id`

export function loadCitationCandidates(db: DB, promptVersion: string): CitationCandidateRow[] {
  return db
    .prepare(
      /* sql */ `
      SELECT c.id                AS contextId,
             c.citing_work_id    AS citingWorkId,
             e.cited_work_id     AS citedWorkId,
             w.title             AS citedTitle,
             w.publication_year  AS citedYear,
             c.ordinal           AS ordinal,
             c.sentence          AS sentence,
             c.section           AS section,
             c.page              AS page,
             c.marker_in_sentence AS markerInSentence,
             c.callout_offset    AS calloutOffset,
             c.callout_end       AS calloutEnd,
             c.raw_bib_text      AS rawBibText,
             (SELECT COUNT(*) FROM chunk k WHERE k.work_id = e.cited_work_id)
                                 AS citedChunkCount
        FROM citation_context c
        JOIN citation_edge e ON e.id = c.edge_id
        JOIN work w          ON w.id = e.cited_work_id
        LEFT JOIN citation_link l ON l.citation_context_id = c.id
       ${CANDIDATE_WHERE}
       ORDER BY e.cited_work_id, c.citing_work_id, c.page, c.callout_offset`
    )
    .all(MIN_PASSAGE_CHARS, promptVersion) as CitationCandidateRow[]
}

/**
 * The pending set's IDENTITY, for the sweep's fingerprint.
 *
 * A COUNT alone is not enough, and the difference is not academic. Two pending
 * sets of equal size are a cache hit, so a deletion and an ingest coalesced into
 * one debounce window would silently skip the new paper — and the case the user
 * actually asked about produces exactly that shape. So the digest folds in each
 * pending passage WITH the work it names and how many blocks that work currently
 * has: embedding the cited paper changes the block count, which changes the
 * digest, which wakes the sweep with real work to do.
 *
 * `attempted` counts passages a sweep tried and got no verdict for — a torn
 * call, an unreadable answer, a search outage. Those write no row, so the
 * pending set is UNCHANGED and without this the outage would be cached as an
 * answer and never retried. It is read from the run's own result, so the next
 * fingerprint can see it.
 *
 * That buys exactly ONE retry per distinct failure count, and that is the
 * intended bound rather than a shortfall: the second attempt records the same
 * tally, the fingerprint stops moving, and the sweep settles instead of
 * re-spending model calls forever on a paper the model keeps declining. Any real
 * corpus change moves the digest and re-opens it.
 */
export function citationPendingDigest(
  db: DB,
  promptVersion: string
): { pending: number; attempted: number; digest: string } {
  const rows = db
    .prepare(
      /* sql */ `
      SELECT c.id AS id, e.cited_work_id AS cited,
             (SELECT COUNT(*) FROM chunk k WHERE k.work_id = e.cited_work_id) AS blocks
        FROM citation_context c
        JOIN citation_edge e ON e.id = c.edge_id
        LEFT JOIN citation_link l ON l.citation_context_id = c.id
        ${CANDIDATE_WHERE}
       ORDER BY c.id`
    )
    .all(MIN_PASSAGE_CHARS, promptVersion) as Array<{ id: number; cited: number; blocks: number }>

  // Read from the CURRENT run only. A superseded run's tally belongs to a set
  // that no longer exists, and counting the history would move this number on
  // every attempt — so the sweep could never settle and would re-spend calls on
  // each wake, which is the inverse of the guard's purpose.
  const last = db
    .prepare(
      `SELECT result FROM stage_run
        WHERE stage = 'verify-citations' AND superseded = 0
        ORDER BY id DESC LIMIT 1`
    )
    .get() as { result: string | null } | undefined
  let attempted = 0
  if (last?.result) {
    try {
      const parsed = JSON.parse(last.result) as { unresolvedAttempts?: number }
      attempted = typeof parsed.unresolvedAttempts === 'number' ? parsed.unresolvedAttempts : 0
    } catch {
      /* an unreadable result is not a reason to refuse to fingerprint */
    }
  }

  return {
    pending: rows.length,
    attempted,
    digest: createHash('sha256')
      .update(rows.map((r) => `${r.id}:${r.cited}:${r.blocks}`).join(','))
      .digest('hex')
      .slice(0, 16)
  }
}

/**
 * Shortest passage worth putting to a model.
 *
 * Matches `MIN_SENTENCE_CHARS` in `callouts.ts`, which is the length that module
 * grows a fragment TOWARDS. Anything still under it after healing is a passage
 * the paragraph could not supply — a table cell, a running head, a lone
 * ordinal — and asking about one produces a confident answer to a question that
 * was never a question.
 */
export const MIN_PASSAGE_CHARS = 40

/** The stable identity of a verification's INPUTS. An equal hash is an answer we hold. */
export function verificationHash(input: {
  sentence: string
  citedWorkId: number
  rawBibText: string | null
  candidateChunkIds: number[]
  promptVersion: string
}): string {
  return createHash('sha256')
    .update(
      [
        input.sentence,
        String(input.citedWorkId),
        input.rawBibText ?? '',
        // SORTED: the search returns blocks in score order, and a re-run whose
        // scores tie differently would otherwise look like different evidence.
        [...input.candidateChunkIds].sort((a, b) => a - b).join(','),
        input.promptVersion
      ].join('\u0000')
    )
    .digest('hex')
}

export interface CitationLinkWrite {
  contextId: number
  citingWorkId: number
  citedWorkId: number
  verdict: 'verified' | 'rejected' | 'unverifiable' | 'abstained'
  /** The chunk the model named, already checked to be one we showed it. */
  targetChunkId: number | null
  candidateCount: number
  topScore: number | null
  spaceId: number | null
  model: string | null
  promptVersion: string
  reason: string | null
  inputHash: string
}

/**
 * Write one verdict, resolving the cited-side anchor AT WRITE TIME.
 *
 * The anchor is re-read from `chunk` here rather than carried through the plan,
 * and the read is scoped by BOTH the chunk id and the cited work. Between the
 * search and this transaction a re-embed may have deleted the chunk or a
 * different paper's re-embed may have taken the id, and an anchor captured
 * earlier would then point a reader into the wrong paper — the exact failure
 * `citation-contexts` re-selects its edge to avoid. A chunk that no longer
 * resolves leaves the target NULL, which the schema permits for a verified link
 * and which is the honest state: the passage does reference that paper, and the
 * block we found is gone.
 *
 * `ON CONFLICT DO UPDATE` on the unique passage key, so a sweep interrupted and
 * resumed replaces its own partial answer rather than colliding with it.
 */
export function writeCitationLink(db: DB, w: CitationLinkWrite, stageRunId: number, now: string): void {
  let chunk:
    | {
        id: number
        document_id: number
        page: number | null
        para_ids: string | null
        char_start: number | null
        char_end: number | null
        text: string
      }
    | undefined
  if (w.targetChunkId != null && w.verdict === 'verified') {
    chunk = db
      .prepare(
        `SELECT id, document_id, page, para_ids, char_start, char_end, text
           FROM chunk WHERE id = ? AND work_id = ?`
      )
      .get(w.targetChunkId, w.citedWorkId) as typeof chunk
  }

  db.prepare(
    `INSERT INTO citation_link
       (citation_context_id, citing_work_id, cited_work_id, verdict,
        target_chunk_id, target_document_id, target_page, target_para_ids,
        target_char_start, target_char_end, target_text, target_source,
        candidate_count, top_score, space_id, stage_run_id, model,
        prompt_version, reason, input_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(citation_context_id) DO UPDATE SET
       verdict            = excluded.verdict,
       target_chunk_id    = excluded.target_chunk_id,
       target_document_id = excluded.target_document_id,
       target_page        = excluded.target_page,
       target_para_ids    = excluded.target_para_ids,
       target_char_start  = excluded.target_char_start,
       target_char_end    = excluded.target_char_end,
       target_text        = excluded.target_text,
       target_source      = excluded.target_source,
       candidate_count    = excluded.candidate_count,
       top_score          = excluded.top_score,
       space_id           = excluded.space_id,
       stage_run_id       = excluded.stage_run_id,
       model              = excluded.model,
       prompt_version     = excluded.prompt_version,
       reason             = excluded.reason,
       input_hash         = excluded.input_hash,
       created_at         = excluded.created_at`
  ).run(
    w.contextId,
    w.citingWorkId,
    w.citedWorkId,
    w.verdict,
    chunk?.id ?? null,
    chunk?.document_id ?? null,
    chunk?.page ?? null,
    chunk?.para_ids ?? null,
    chunk?.char_start ?? null,
    chunk?.char_end ?? null,
    chunk?.text ?? null,
    chunk ? 'llm-selected' : null,
    w.candidateCount,
    w.topScore,
    w.spaceId,
    stageRunId,
    w.model,
    w.promptVersion,
    w.reason,
    w.inputHash,
    now
  )
}
