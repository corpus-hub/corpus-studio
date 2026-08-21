// What each of this paper's unmatched references is ABOUT, from the two indexes
// that hold an abstract.
//
// The paper's bibliography is the one part of its content the app holds only as
// a printed line: a reference we already own resolves to a work with its own
// abstract, and every reference we do NOT own is a title and a coordinate. This
// stage asks Crossref for the paper behind each printed line, verified on the
// volume and first page that line already printed, and takes the abstract if the
// answer carries one. Where Crossref holds the paper but no abstract — which is
// most of chemistry — the verified DOIs go to OpenAlex in one batch.
//
// THE GATE IS NOT HERE. `bibliographicMatch` decides what counts as the right
// paper, on a printed coordinate that is equal or is not, and this file
// contributes no threshold and no second opinion about WHICH paper a line names.
// It orchestrates: it decides WHICH references to ask about, in what order, and
// what is recorded afterwards. Anything that looks like a matching judgement
// belongs one module down.
//
// IT DOES SCORE, and that is a different question from matching. Once a
// reference's abstract is settled, the packaged cross-encoder is asked how near
// that paper is to the project's own description — the same model, the same
// query and the same [0,1] scale the paper ranking uses, because expansion
// priority is now the MEAN of these numbers and a mean over two scales is not a
// mean. Scoring here rather than in the sweep is what keeps it a per-paper cost
// paid once beside the fetch, instead of a corpus-wide pass re-reading every
// bibliography every time a project's papers change.
//
// A ROW IS WRITTEN FOR EVERY REFERENCE, INCLUDING THE REFUSALS. "This entry
// printed no coordinate, so nothing was asked" and "the index answered and holds
// no abstract" are the records that stop the next run asking again; without them
// a corpus retries its whole bibliography forever and can never say how far it
// got. `unreachable` is the one outcome worth retrying, and it is the one this
// stage lets fail the run.
//
// THE POLITE-POOL ADDRESS IS NOT OPTIONAL HERE, and the measurement is why it
// reached `ctx.db.contactEmail()` rather than being left off. Twenty-five real
// bibliography lines sent to Crossref anonymously were rate-limited on 12; paced
// at 120 ms between requests, still 7. The same 25 with `mailto` set answered 25
// of 25, at both paces. Anonymity is what the shared pool objects to, not speed
// — so pacing is not the fix, and without the address this stage would write "no
// index could be reached" over half of every bibliography it read.
//
// INLINE, not host. The body needs `recordReferenceAbstract` — an upsert with
// two paths over a partial unique index — and it needs it once per reference,
// while the reads it works from (`refs.parsed@v1`) arrive as an artifact. A host
// has no database at all, so the writes would have to cross back as data anyway;
// they do exactly that here, through one `ctx.write` payload applied in the same
// transaction as the terminal `stage_run` row. The expense is network latency,
// which blocks nothing in main — there is no long synchronous native call to
// keep off the thread, which is what `host` exists for.

import {
  ABSTRACT_FETCHER_VERSION,
  askKeyFor,
  bibliographicMatch,
  openAlexAbstracts,
  type AbstractResult
} from '../../references/external/abstracts'
import { createHash } from 'node:crypto'

/**
 * Between two Crossref calls.
 *
 * Their polite pool documents 50 req/s as the ceiling; 100 ms is a twentieth of
 * that, which leaves the limit alone even with another window of this app
 * running. It costs ten seconds over a hundred-reference bibliography, on a
 * background stage nobody is watching — against a 429 that would be written
 * down as a fact about the paper.
 */
const CROSSREF_REQUEST_DELAY_MS = 100

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
import { scorePairs } from '../../rerank/model'
import { rerankerConfigHash, resolveRerankerIdentity } from '../../rerank/identity'
import { projectQuestion } from '../../rerank/store'
import { recordReferenceAbstract } from '../../references/store'
import type { ParsedReferences, ReferenceAbstracts } from '../capabilities'
import type { StageDefinition } from '../types'

/** One reference's answer, as the row it will become. */
interface AbstractWriteRow {
  unresolvedReferenceId: number
  doi: string | null
  matchedTitle: string | null
  abstract: string | null
  source: AbstractResult['source']
  outcome: AbstractResult['outcome']
  error: string | null
  /** `askKeyFor`, so the next bibliography naming this paper reuses the answer. */
  askKey: string | null
  /**
   * How near this reference is to the project's question, as the packaged
   * cross-encoder answered it. NULL when nothing scored it — no model, no
   * question, or a reference with neither abstract nor usable title. Never 0.
   */
  relevance: number | null
  scoredOn: 'title+abstract' | 'title' | null
  scoredForProjectId: number | null
}

interface AbstractsWrite {
  citingWorkId: number
  rows: AbstractWriteRow[]
}

const referenceAbstracts: StageDefinition<{
  asked: number
  withAbstract: number
}> = {
  id: 'reference-abstracts',
  label: 'Fetch reference abstracts',
  version: '1.0.0',
  rank: 10,
  // ONE PAPER'S BIBLIOGRAPHY is the unit, exactly as `references` scopes itself:
  // the set of lines to ask about is this document's, the rows are anchored on
  // `citing_work_id`, and a corpus-wide sweep would make one long network run
  // out of work that belongs to each paper separately.
  scope: 'document',
  provides: ['refs.abstracts@v1'],
  // BY TOKEN. What this stage consumes is a parsed bibliography with its
  // unresolved row ids in it; that `references` is what currently produces one
  // is not something this file knows or should.
  requires: ['refs.parsed@v1'],
  usesLlm: false,
  runtime: 'node',
  weight: 'light',

  /**
   * The reference set, and how strictly a match is admitted.
   *
   * Those are the two inputs. The bibliography can change under this stage —
   * a re-parse of a better PDF splits a composite differently — and the gate
   * can be tightened, in which case rows written under the older rule were
   * admitted on evidence this build would refuse. Nothing else moves the
   * answer: which papers the library holds does not, because a reference that
   * RESOLVES is not asked about here at all and its promotion is
   * `resolve-references`' business.
   *
   * The count, not the ids: ids churn on every re-parse without the set of
   * printed lines changing, and this is called outside error handling, so it
   * also swallows a failed read rather than taking the planner down with it.
   */
  fingerprint(ctx) {
    let unresolved = -1
    try {
      unresolved = (
        ctx.db
          .prepare(
            `SELECT COUNT(*) AS n FROM unresolved_reference
              WHERE citing_work_id = ? AND part_label IS NULL`
          )
          .get(ctx.workId) as { n: number }
      ).n
    } catch {
      // -1 is not a count and cannot collide with one, so a read that failed
      // reads as its own state rather than as "this paper has no references".
      unresolved = -1
    }
    // THE QUESTION, because this stage now scores as well as fetches. An edited
    // research goal makes every stored reference relevance an answer to a
    // question nobody is asking, and the mean built from them is what ranks the
    // corpus — so the description is hashed in exactly as `rerank` hashes it.
    // Reading it must never throw: this runs outside the stage's error handling,
    // and a planner brought down here takes the whole queue with it.
    let question = 'unreadable'
    try {
      const q = projectQuestion(ctx.db, ctx.projectId, ctx.workId)
      question = q === null ? 'none' : createHash('sha256').update(q.question).digest('hex')
    } catch {
      question = 'unreadable'
    }
    // AND THE MODEL. A logit is only ordinally comparable to logits from the
    // same weights and truncation regime, so swapping the packaged reranker must
    // retire these scores through the ordinary supersede cascade rather than
    // leave a mean averaging two models' answers together.
    let model = 'absent'
    try {
      const identity = resolveRerankerIdentity()
      if (identity) model = rerankerConfigHash(identity)
    } catch {
      model = 'unreadable'
    }
    return (
      `unresolved=${unresolved}|fetcher=${ABSTRACT_FETCHER_VERSION}` +
      `|question=${question}|model=${model}`
    )
  },

  async execute(ctx) {
    const parsed = ctx.input<ParsedReferences>('refs.parsed@v1')
    if (!parsed) {
      return {
        status: 'skipped',
        reason: 'this paper\u2019s bibliography has not been parsed yet, so there is nothing to ask about'
      }
    }

    // WHOLE ENTRIES ONLY. A composite ("(11) (a) … (b) …") is stored as the
    // parent AND one row per part, all sharing an ordinal, so counting or
    // fetching both sides asks the same question twice and reports one paper's
    // bibliography as half again as long as it is.
    const targets = parsed.entries.filter(
      (e) => e.unresolvedReferenceId != null && (e.partLabel ?? null) === null
    )

    if (targets.length === 0) {
      return {
        status: 'not-needed',
        reason:
          'every reference in this bibliography already resolves to a paper in the library, ' +
          'so there is nothing to look up'
      }
    }

    // Read HERE rather than captured at dispatch, like `modelSettings()`: it is
    // generated on first use, so the very first stage to ask is the one that
    // mints it.
    const mailto = ctx.db.contactEmail()

    const results = new Map<number, AbstractResult>()
    const askKeys = new Map<number, string | null>()
    // Verified DOIs whose Crossref record carried no abstract. OpenAlex holds
    // one for a good half of these, and asking it is what took the measured
    // saturation from a quarter of a bibliography to nearly half.
    const secondPass: Array<{ refId: number; doi: string }> = []
    // Answers this run has already obtained, so a bibliography that names the
    // same paper twice asks once. The cross-RUN half of the same saving is
    // `abstractByAskKey` below.
    const seen = new Map<string, AbstractResult>()
    /** Requests actually SENT, so the pace is not spent on cache hits. */
    let asked = 0

    for (let i = 0; i < targets.length; i++) {
      if (ctx.signal.aborted) return { status: 'failed', error: 'cancelled', retryable: true }
      const entry = targets[i]

      const refId = entry.unresolvedReferenceId as number
      const askKey = askKeyFor(entry.rawBibText, entry.title ?? null)
      askKeys.set(refId, askKey)

      // REUSE BEFORE ASKING. One paper is cited by many of ours and stored once
      // per bibliography: 571 lines here name 405 distinct papers, and the
      // most-cited appears in ten of the twenty-three. Every hit is a request
      // not made against a rate limit shared with every future import.
      //
      // A null key is not reusable and must ask for itself — see `askKeyFor`,
      // where a coordinate without a title is a collision waiting to hand one
      // paper's DOI to another.
      const reused =
        askKey === null
          ? null
          : (seen.get(askKey) ??
            (() => {
              const row = ctx.db.reusableAbstract(askKey, ABSTRACT_FETCHER_VERSION)
              return row
                ? ({
                    outcome: 'found',
                    doi: row.doi,
                    matchedTitle: row.matchedTitle,
                    abstract: row.abstract,
                    source: row.source,
                    error: null
                  } as AbstractResult)
                : null
            })())
      if (reused) {
        results.set(refId, reused)
        ctx.progress(
          Math.round(((i + 1) / targets.length) * 90),
          `reference ${i + 1} of ${targets.length}`
        )
        continue
      }

      // PACED, because this is the only unbatched request in the stage and it
      // runs once per reference — a hundred-entry bibliography is a hundred
      // Crossref calls back to back from one address. The polite pool is
      // generous rather than unlimited, and a 429 here is not a fact about the
      // paper: it would be recorded as "no index could be reached" against a
      // reference the index knows perfectly well.
      //
      // AFTER THE CACHE CHECK, so a reference answered from `seen` or from an
      // earlier run costs nothing — pacing work that never leaves the process
      // would spend a minute a paper waiting on nothing.
      if (asked > 0) await sleep(CROSSREF_REQUEST_DELAY_MS)
      asked++
      const r = await bibliographicMatch(
        { rawBibText: entry.rawBibText, guessedTitle: entry.title ?? null },
        { mailto }
      )
      results.set(refId, r)
      if (askKey !== null && r.outcome === 'found' && r.abstract) seen.set(askKey, r)
      if (r.outcome === 'absent' && r.doi) {
        secondPass.push({ refId, doi: r.doi })
      }

      // 90% of the bar is the per-reference loop, the rest is the batch below.
      // A hundred references is the better part of a minute, and a queue that
      // shows nothing for that long is a queue the user reads as wedged.
      ctx.progress(
        Math.round(((i + 1) / targets.length) * 90),
        `reference ${i + 1} of ${targets.length}`
      )
    }

    if (secondPass.length > 0) {
      if (ctx.signal.aborted) return { status: 'failed', error: 'cancelled', retryable: true }
      ctx.progress(92, `asking OpenAlex about ${secondPass.length} more`)
      const byDoi = await openAlexAbstracts(secondPass.map((s) => s.doi), { mailto })
      for (const { refId, doi } of secondPass) {
        const alt = byDoi.get(doi)
        // Only an IMPROVEMENT is taken. OpenAlex answering `absent` for a DOI
        // Crossref also had nothing for changes no fact, and overwriting the
        // Crossref row with it would lose the title Crossref matched — the one
        // thing on that row a user can check the choice against.
        if (alt?.outcome === 'found') {
          const first = results.get(refId)
          results.set(refId, {
            ...alt,
            // The title stays the one the verified match was made on.
            matchedTitle: first?.matchedTitle ?? alt.matchedTitle
          })
        }
      }
    }

    // THE SAME MODEL THAT RANKS THE PAPERS, asked the same way. Expansion
    // priority is the mean of these numbers, and a mean is only meaningful over
    // scores from one scale — a reference scored by a different model, or
    // against a different question, is not comparable to the paper relevances a
    // reader will see it beside. So the query is the project's description
    // verbatim and the model is the packaged reranker, exactly as `rerank` does.
    //
    // BEST TEXT AVAILABLE, and it is recorded which. An abstract that came back
    // is read with its matched title; a reference nothing was found for is read
    // on the title the bibliography line itself printed, because a printed title
    // is still a statement of what the paper is about and dropping it would make
    // an unindexed paper invisible rather than merely uncertain. A reference
    // with neither — "ibid., pp. 44–47" — is left NULL, which is the one honest
    // answer: nothing could look at it.
    const question = ctx.db.projectQuestion()
    let reranker: ReturnType<typeof resolveRerankerIdentity> = null
    try {
      reranker = resolveRerankerIdentity()
    } catch {
      // A model that cannot be described produces scores from a truncation
      // regime nobody chose. Leaving every relevance NULL says nothing looked,
      // which is what this build should do rather than average numbers it cannot
      // account for.
      reranker = null
    }

    const scores = new Map<number, { relevance: number; scoredOn: 'title+abstract' | 'title' }>()
    if (question && reranker) {
      for (let i = 0; i < targets.length; i++) {
        if (ctx.signal.aborted) return { status: 'failed', error: 'cancelled', retryable: true }
        const entry = targets[i]
        const refId = entry.unresolvedReferenceId as number
        const r = results.get(refId) as AbstractResult
        const abstract = r.outcome === 'found' ? r.abstract?.trim() : null
        const title = (r.matchedTitle ?? entry.title ?? '').trim()
        const passage = abstract ? `${title}\n\n${abstract}` : title
        if (passage === '') continue

        const [pair] = await scorePairs(question.question, [passage], ctx.signal)
        // An empty array means the abort landed inside the call; there is no
        // score, and inventing one would put a number in a mean.
        if (pair) {
          scores.set(refId, {
            relevance: pair.score,
            scoredOn: abstract ? 'title+abstract' : 'title'
          })
        }
        ctx.progress(
          95 + Math.round(((i + 1) / targets.length) * 5),
          `scoring reference ${i + 1} of ${targets.length}`
        )
      }
    }

    const rows: AbstractWriteRow[] = targets.map((e) => {
      const refId = e.unresolvedReferenceId as number
      const r = results.get(refId) as AbstractResult
      const s = scores.get(refId) ?? null
      return {
        unresolvedReferenceId: refId,
        doi: r.doi,
        matchedTitle: r.matchedTitle,
        abstract: r.abstract,
        source: r.source,
        outcome: r.outcome,
        error: r.error,
        askKey: askKeys.get(refId) ?? null,
        relevance: s?.relevance ?? null,
        scoredOn: s?.scoredOn ?? null,
        scoredForProjectId: s ? (question as { projectId: number }).projectId : null
      }
    })

    const tally = (o: AbstractResult['outcome']): number =>
      rows.filter((r) => r.outcome === o).length
    const withAbstract = tally('found')
    const noQuestion = tally('nothing-to-ask-with')
    const unreachable = tally('unreachable')

    // NOTHING WAS REACHED. Every line that had a question to ask failed to get
    // an answer, which is the network being down rather than a bibliography
    // nobody indexes — and reporting it as success would write "no abstract on
    // record" across a whole corpus from an offline laptop. Nothing is written:
    // `unreachable` is the retryable outcome and there is no other kind here.
    if (unreachable > 0 && unreachable === rows.length - noQuestion) {
      return {
        status: 'failed',
        error: 'no index could be reached for any reference in this bibliography',
        retryable: true
      }
    }

    ctx.write({ citingWorkId: ctx.workId, rows } satisfies AbstractsWrite)

    // EVERY line refused before a socket opened. A real, checkable claim about
    // this bibliography: books, theses and "(in press)" print no volume and page
    // for an answer to be checked against, so there was no question to ask.
    if (noQuestion === rows.length) {
      return {
        status: 'empty',
        reason:
          `none of this paper's ${rows.length} unmatched reference(s) prints a volume and page, ` +
          'so no lookup could be verified against anything'
      }
    }

    return {
      status: 'succeeded',
      result: { asked: rows.length - noQuestion, withAbstract },
      note: `${withAbstract} abstract(s) for ${rows.length} unmatched reference(s)`
    }
  },

  applyWrites(db, payload, ctx) {
    const w = payload as AbstractsWrite
    for (const r of w.rows) {
      recordReferenceAbstract(db, {
        unresolvedReferenceId: r.unresolvedReferenceId,
        citingWorkId: w.citingWorkId,
        doi: r.doi,
        matchedTitle: r.matchedTitle,
        abstract: r.abstract,
        source: r.source,
        // The rule that admitted the row, and the only one this stage runs: a
        // printed coordinate matched against the one that came back.
        matchedBy: 'bibliographic',
        outcome: r.outcome,
        error: r.error,
        askKey: r.askKey,
        relevance: r.relevance,
        scoredOn: r.scoredOn,
        scoredForProjectId: r.scoredForProjectId
      })
    }

    const value: ReferenceAbstracts = {
      citingWorkId: ctx.workId,
      fetcherVersion: ABSTRACT_FETCHER_VERSION,
      asked: w.rows.length,
      withAbstract: w.rows.filter((r) => r.outcome === 'found').length
    }
    return [['refs.abstracts@v1', value]]
  }
}

export default referenceAbstracts
