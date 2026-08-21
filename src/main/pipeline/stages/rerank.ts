// How near each paper is to what its project actually asked, measured by the
// packaged cross-encoder, and how much unexplored literature each one opens.
//
// THE TWO NUMBERS ARE UNRELATED MEASUREMENTS AND ARE NEVER FUSED. Relevance is
// a model's answer about a (project question, THIS PAPER'S text) pair.
// Expansion priority is the MEAN relevance of the papers this one's bibliography
// names but the library does not hold — a different set of texts, judged
// separately, answering a different question: not "is this paper worth reading"
// but "is its reading list worth following".
//
// EXPANSION USED TO BE A COUNT, AND THE COUNT WAS THE BUG. Bibliography size
// asked how many references a paper prints without asking what any of them are,
// so a review with 200 references about everything outranked a paper citing 30
// that are exactly the project's subject. The mean asks how relevant the reading
// list is ON AVERAGE and is independent of its length, which is what "how much
// relevant territory would following these citations open" actually means. A SUM
// would have restored the length bias under a new name.
//
// THE MEAN IS ALREADY COMPUTED BY THE TIME THIS RUNS. `reference-abstracts`
// scores each reference beside the fetch that obtained its abstract, with the
// same model and the same query; this stage averages the numbers it finds. That
// division is why the per-reference work is paid once per paper instead of being
// re-done for the whole corpus whenever any project changes.
//
// WHY ONE RUN FOR A WHOLE PROJECT, AND THEREFORE `scope: 'corpus'`. Both numbers
// are project-specific and the scheduler gives exactly one shape that runs once
// over a set: the corpus singleton, with `work_id = 0`, debounced and
// generation-counted. So this sweeps every project in turn rather than being
// planned per (paper, project) — `scope: 'project'` would mean one job per paper
// per project, which is the thing that cannot work here.
//
// THE QUERY IS THE PROJECT'S DESCRIPTION AND NOTHING ELSE. Not the dossier:
// `buildDossier` never reads the description, so the two have separate
// freshnesses, and hashing one to invalidate the other would make an edited
// research question fail to reopen a single score. The description is composed
// from the onboarding goal and questions, so one hash covers an edit to either.
//
// INLINE. The reranker holds the JS thread for about 105 ms per pair with no
// event-loop tick inside a call, which is the profile `host` exists for — but
// this stage's work is a database read, a loop, and a database write, and a host
// process has no database at all. A 21-paper project is roughly two seconds of
// blocked thread spread over 21 separately-cancellable calls, and the signal is
// checked between every one. If a corpus grows to where that matters, the fix is
// to move the SCORING into a host and keep the reads and writes here, not to
// give the whole stage a database it cannot have.

import { createHash } from 'node:crypto'
import { rerankerConfigHash, resolveRerankerIdentity } from '../../rerank/identity'
import { scorePairs } from '../../rerank/model'
import { meanReferenceRelevance, recordScores, scoringSets, type ScoreRow } from '../../rerank/store'
import type { ProjectRanking } from '../capabilities'
import type { StageDefinition } from '../types'

/**
 * How far the user's own verdict moves a paper, in relevance units.
 *
 * The model does not know that the user read this paper and decided it belongs,
 * or read it and threw it out. Dropping that would make marking a paper excluded
 * a NO-OP in the one list where it should be visible — a paper the user has
 * personally rejected would keep sitting near the top because its abstract still
 * matches the question well.
 *
 * DELIBERATELY SMALL, and it is the only adjustment in this file. It is a
 * tie-break, not a verdict: two papers the model separates clearly stay
 * separated, and two it cannot tell apart are ordered by what the user already
 * decided. Nothing here was tuned against an outcome — 0.05 is one twentieth of
 * the range, chosen because it is small enough to be visibly a nudge.
 * `read` and `uncertain` move nothing: they record that the user LOOKED, not
 * what they concluded.
 */
const INCLUSION_SHIFT = 0.05

function shiftFor(inclusionStatus: string): number {
  if (inclusionStatus === 'included') return INCLUSION_SHIFT
  if (inclusionStatus === 'excluded') return -INCLUSION_SHIFT
  return 0
}

/**
 * The model's score, made room in for the user's verdict.
 *
 * THE HEADROOM IS THE WHOLE POINT, and clamping instead is what it replaces. A
 * cross-encoder's sigmoid SATURATES: on this corpus the two best papers came
 * back at 0.99997 and 0.99992 — a real ordering, clearly separated in the logit
 * the model actually emitted. Adding the shift to both and clamping to the
 * column's `BETWEEN 0 AND 1` made them BOTH exactly 1.0, so a nudge meant to
 * break ties invented one at the very top of the list, in the two rows a user
 * looks at first. The same happened at the bottom against 0.
 *
 * So the score is compressed into the interval that leaves the shift somewhere
 * to go, and then shifted. The map is affine and increasing, so it reorders
 * nothing within a status; the endpoints land exactly on 0 and 1; and no
 * clamping ever runs, because nothing can leave the range. It is arithmetic
 * about the SCALE, not a second opinion about the paper.
 */
function relevanceFor(score: number, inclusionStatus: string): number {
  return INCLUSION_SHIFT + score * (1 - 2 * INCLUSION_SHIFT) + shiftFor(inclusionStatus)
}

/**
 * Why no relevance was asked for, in the words the row will carry.
 *
 * The three cases are genuinely different to a reader deciding what to do:
 * nothing is packaged (nothing they can fix), the packaged thing is unreadable
 * (a broken install), or the project has not said what it is for (a form they
 * can go and fill in). Collapsing them to "unscored" would hide the only one
 * with an action behind it.
 */
function missingReason(
  identity: ReturnType<typeof resolveRerankerIdentity>,
  identityError: string | null,
  question: string
): string {
  if (identityError) return `the packaged reranker could not be described (${identityError})`
  if (identity === null) return 'no reranker model is packaged in this build'
  if (question === '') return 'this project has not written down what it is for'
  return 'the scoring pass did not finish for this paper'
}

/**
 * What this run actually did to one row, as one sentence.
 *
 * WHAT WAS MEASURED AND WHAT IT WAS MEASURED ON — never how the number was
 * arrived at, because there is no arithmetic left to narrate: a relevance is a
 * cross-encoder's answer about a pair, and printing "+0.16 for word overlap"
 * beside it is exactly the sentence-versus-score drift that retired the
 * previous ranker. So the score is named, the text it was read from is named,
 * and expansion priority names the COUNTS it was averaged over rather than
 * standing on the mean alone — a reader can check "24 of its 31 unmatched
 * references were scored" against the paper's own bibliography, and cannot check
 * "0.18". The two counts are both printed because their DIFFERENCE is the part
 * that would otherwise be invisible: a mean over 24 of 31 and a mean over 3 of
 * 31 print the same number and are not the same evidence.
 */
function explain(input: {
  relevance: number | null
  scoredOn: string | null
  /** The mean of `scoredReferences` relevances, or null when there were none. */
  expansion: number | null
  scoredReferences: number
  unmatchedReferences: number
  inclusionStatus: string
  unscoredBecause: string | null
}): string {
  const parts: string[] = []
  if (input.relevance === null) {
    parts.push(`relevance not scored — ${input.unscoredBecause ?? 'nothing looked at this paper'}`)
  } else {
    const read = input.scoredOn === 'title' ? 'its title alone' : 'its title and abstract'
    parts.push(
      `relevance ${input.relevance.toFixed(2)} — a model compared ${read} against this project's description`
    )
    if (input.inclusionStatus === 'included' || input.inclusionStatus === 'excluded') {
      parts.push(`nudged because you marked it ${input.inclusionStatus}`)
    }
  }
  // NOT SCORED rather than 0, and the wording the parser already knows. An
  // unscorable bibliography is not a bibliography worth nothing: "expansion
  // priority 0" would say this paper's references were read and found irrelevant,
  // which is the claim the whole NULL discipline in this file exists to avoid.
  if (input.expansion === null) {
    parts.push(
      input.unmatchedReferences === 0
        ? 'expansion priority not scored — every reference it makes already resolves to a paper in the corpus, so following them opens nothing new'
        : `expansion priority not scored — none of its ${input.unmatchedReferences} unmatched reference${
            input.unmatchedReferences === 1 ? '' : 's'
          } could be judged, so there is no average to take`
    )
  } else {
    parts.push(
      `expansion priority ${input.expansion.toFixed(2)} — the average relevance of the ` +
        `${input.scoredReferences} of its ${input.unmatchedReferences} unmatched reference${
          input.unmatchedReferences === 1 ? '' : 's'
        } a model could read`
    )
  }
  return parts.join('; ')
}

/** One project's decisions, as the rows they will become. */
interface RerankWrite {
  projectId: number
  rows: ScoreRow[]
}

const rerank: StageDefinition<{
  projectsScored: number
  worksScored: number
  /** False when no reranker is packaged: expansion was written, relevance was not. */
  relevanceMeasured: boolean
}> = {
  id: 'rerank',
  label: 'Score relevance',
  version: '1.0.0',
  rank: 11,
  scope: 'corpus',
  provides: ['project.ranking@v1'],
  // WHAT MOVES THE ANSWER, declared as tokens rather than as stage ids. A
  // resolved reference becomes a citation edge and changes a bibliography size;
  // a fetched abstract is text a promoted paper is later scored on. Both are
  // therefore events this sweep must wake on, and naming the tokens is what
  // lets a future producer of either wake it without editing this file.
  requires: ['refs.resolved@v1', 'refs.abstracts@v1'],
  usesLlm: false,
  runtime: 'node',
  weight: 'light',
  isolation: 'inline',

  /**
   * The question, the model, and the size of what is being ranked.
   *
   * The QUESTION as a digest of each project's description, because an edited
   * research goal makes every stored score an answer to a question nobody is
   * asking any more. The MODEL by its identity hash, because a logit is only
   * ordinally comparable to logits from the same weights and truncation regime —
   * swapping the packaged reranker must retire every score through the ordinary
   * supersede cascade rather than through a special case. The COUNTS because
   * a paper joining or leaving a project changes which rows are written at all,
   * and the reference totals because a reference parsed, promoted or newly
   * SCORED since the last sweep changes the mean this stage averages. The two
   * are summed separately rather than as one figure so that a reference moving
   * from unscored to scored — which leaves the unmatched count alone and changes
   * the answer — still moves the fingerprint.
   *
   * Called OUTSIDE this stage's error handling, so it must never throw:
   * `resolveRerankerIdentity` raises when a model is present but cannot be
   * characterised, and a planner brought down by that would take the whole queue
   * with it. The missing and the unreadable case therefore fall back to a
   * sentinel that is not a hash and cannot collide with one.
   *
   * THE PROJECT COUNTS ARE READ WITH `scoringSets(ctx.db)`, NOT
   * `ctx.db.scoringSets()`. `ctx` here is a `StagePlanContext`, whose `db` is a
   * raw better-sqlite3 handle — the accessor of that name exists only on
   * `StageReadDb`, which the scheduler builds for `execute`. The method call
   * therefore threw on EVERY plan, a blanket `catch` turned the throw into the
   * constant `'unreadable'`, and a constant is a fingerprint that can never
   * move: the sweep re-armed correctly on each new bibliography, hashed
   * identically, took the cache-hit path and settled `done` without running.
   * Twenty of twenty-one papers sat with a NULL expansion priority while the
   * queue reported the stage complete.
   *
   * So the read is no longer wrapped. A fingerprint that cannot see its inputs
   * must FAIL rather than report "nothing changed" — those are opposite claims,
   * and collapsing them is what made this silent. The plain-SQL read cannot
   * throw for any reason short of a corrupt database, which is not a condition
   * to paper over here.
   */
  fingerprint(ctx) {
    let model = 'absent'
    try {
      const identity = resolveRerankerIdentity()
      if (identity) model = rerankerConfigHash(identity)
    } catch {
      model = 'unreadable'
    }
    const projects = scoringSets(ctx.db)
      .map((s) => {
        const query = createHash('sha256').update(s.description ?? '').digest('hex')
        const biblio = s.works.reduce(
          (n, w) => n + w.unmatchedReferences + w.referenceRelevances.length,
          0
        )
        return `p${s.projectId}:query=${query}|works=${s.works.length}|biblio=${biblio}`
      })
      .join(';')
    return `model=${model}|${projects}`
  },

  async execute(ctx) {
    let identity: ReturnType<typeof resolveRerankerIdentity> = null
    let identityError: string | null = null
    try {
      identity = resolveRerankerIdentity()
    } catch (err) {
      // A model is present and cannot be described. Distinct from none being
      // packaged: the scores it would produce are real numbers from a truncation
      // regime nobody chose, so refusing to run it is the same refusal
      // `resolveRerankerIdentity` makes, carried up rather than swallowed.
      identityError = err instanceof Error ? err.message : String(err)
    }

    const sets = ctx.db.scoringSets()
    if (sets.length === 0) {
      return { status: 'not-needed', reason: 'there are no projects to rank papers for' }
    }

    const scorable = sets.filter((s) => s.works.length > 0)
    if (scorable.length === 0) {
      return { status: 'not-needed', reason: 'no project holds any papers yet' }
    }

    const totalWorks = scorable.reduce((n, s) => n + s.works.length, 0)
    let done = 0
    let scored = 0
    let projectsScored = 0
    const unasked: string[] = []

    for (const set of scorable) {
      if (ctx.signal.aborted) return { status: 'failed', error: 'cancelled', retryable: true }

      const question = (set.description ?? '').trim()
      // A project that has not said what it is for has not said what relevance
      // would MEAN. Scoring every paper against an empty string would produce a
      // full column of confident-looking numbers measuring nothing.
      const askable = question !== '' && identity !== null
      if (!askable && identity !== null) {
        unasked.push(`project ${set.projectId} has no research question written down`)
      }

      const rows: ScoreRow[] = []
      for (const work of set.works) {
        if (ctx.signal.aborted) return { status: 'failed', error: 'cancelled', retryable: true }

        // ALREADY IN [0,1], so nothing is normalised. Each reference relevance
        // is a sigmoid the same as a paper's, and the mean of numbers in [0,1]
        // is in [0,1] — the old division by the project's largest bibliography
        // existed only because a raw COUNT had no natural scale. Dropping it
        // also drops the coupling it created: one paper joining the project no
        // longer moves every other paper's expansion priority.
        const expansionPriority = meanReferenceRelevance(work.referenceRelevances)

        let relevance: number | null = null
        let scoredOn: string | null = null
        if (askable) {
          // TITLE AND ABSTRACT WHERE THERE IS ONE, TITLE ALONE WHERE THERE IS
          // NOT. Neither is refused: a paper the app holds only a title for is
          // still a paper the user has, and leaving it unscored would drop it
          // out of the ordering entirely — invisible rather than merely
          // uncertain. What is recorded is WHICH, because a title-only score is
          // systematically lower for a reason that has nothing to do with the
          // paper, and a reader comparing a thin score with a full one must be
          // able to see that.
          const passage = work.abstract?.trim()
            ? `${work.title}\n\n${work.abstract.trim()}`
            : work.title
          scoredOn = work.abstract?.trim() ? 'title+abstract' : 'title'

          const [pair] = await scorePairs(question, [passage], ctx.signal)
          if (pair) {
            // A RANK, NOT A PROBABILITY. `sigmoid(logit)` is monotone in the
            // logit, so it orders the papers exactly as the model does and adds
            // no information — it exists to put the number in [0,1] for a bar
            // to draw. 0.62 does not mean "62% relevant" and nothing may
            // threshold it; the only honest operation is ordering.
            relevance = relevanceFor(pair.score, work.inclusionStatus)
            scored++
          } else {
            // `scorePairs` returns what it took: an empty array means the abort
            // landed inside it, and there is no score to record.
            scoredOn = null
          }
        }

        rows.push({
          workId: work.workId,
          relevance,
          scoredOn,
          expansionPriority,
          explanation: explain({
            relevance,
            scoredOn,
            expansion: expansionPriority,
            scoredReferences: work.referenceRelevances.length,
            unmatchedReferences: work.unmatchedReferences,
            inclusionStatus: work.inclusionStatus,
            unscoredBecause: askable ? null : missingReason(identity, identityError, question)
          })
        })
        done++
        ctx.progress(Math.round((done / totalWorks) * 100), `paper ${done} of ${totalWorks}`)
      }

      if (askable) projectsScored++
      ctx.write({ projectId: set.projectId, rows } satisfies RerankWrite)
    }

    // ONE artifact for the whole sweep, emitted here rather than returned per
    // payload from `applyWrites`: this stage writes one payload per project, and
    // a token published from there would be overwritten by each project in turn
    // until the artifact described only whichever one happened to be last.
    ctx.emit('project.ranking@v1', {
      projects: scorable.map((s) => s.projectId),
      works: totalWorks,
      scored
    } satisfies ProjectRanking)

    // NO MODEL, BUT STILL A REAL ANSWER — and this is why the outcome is a
    // success rather than a skip. Every row is written with its explanation, and
    // an unmeasured column is written as NULL and SAID to be unmeasured.
    // `skipped` would be a lie about the pass that ran (and the scheduler rightly
    // fails any stage that queues writes and then claims to have skipped);
    // `empty` would claim nothing was found when a whole column was written. What
    // is owed to the user is the SENTENCE, which the note carries onto the run:
    // these papers are unscored because nothing looked, not because something
    // looked and found little.
    const missing = identityError
      ? `the packaged reranker could not be described (${identityError})`
      : identity === null
        ? 'no reranker model is packaged in this build'
        : null

    const parts: string[] = [
      `${totalWorks} paper(s) in ${scorable.length} project(s) ranked; expansion priority is ` +
        'the mean relevance of each paper\u2019s unmatched references'
    ]
    if (missing) {
      parts.push(`${missing}, so no paper was scored for relevance`)
    } else {
      parts.push(`${scored} scored for relevance`)
      if (unasked.length > 0) parts.push(unasked.join('; '))
    }

    return {
      status: 'succeeded',
      result: {
        projectsScored,
        worksScored: scored,
        relevanceMeasured: missing === null
      },
      note: parts.join('; ')
    }
  },

  applyWrites(db, payload) {
    const w = payload as RerankWrite
    // `now` is read here rather than passed from `execute`, because this is the
    // moment the row actually changes and `updated_at` is a claim about the row.
    recordScores(db, w.projectId, w.rows, new Date().toISOString())
  }
}

export default rerank
