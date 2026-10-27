// Write the paper's prose summaries as part of processing it, rather than only
// when someone presses a button.
//
// TWO SUMMARIES, ONE JOB EACH, via `fanOut()`. The GENERAL summary is the paper
// on its own terms and is a property of the WORK, stored at the `project_id = 0`
// sentinel. The PROJECT summary reads the same paper against one project's topic
// dossier and is stored under that project.
//
// THEY FAIL FOR UNRELATED REASONS, WHICH IS WHY THEY ARE SEPARATE SLOTS. A
// general summary is blocked by the paper having no readable text; a project
// summary by the project having no dossier. Run as one job they shared a single
// verdict, so the commonest real case — general written, project declined for a
// dossier nobody has built yet — surfaced as one green tick plus a sentence, and
// a hard failure in the general half returned before the project half was even
// attempted. Now each is claimed, retried, cached and reported on its own: the
// Queue shows two rows that can disagree, and re-running the one that failed
// does not discard the one that worked.
//
// The cost is that the source text is resolved twice for a paper whose project
// summary also runs. That is the price of the two halves being independently
// re-runnable, and it is the same trade `schema-extract` makes per schema.
//
// PROJECT-SCOPED even though half its output is global. The project summary
// cannot be written without knowing which project, and a document-scoped stage
// has no project to ask. The general half is therefore guarded by
// `reuseIfCurrent`: a paper held by three projects runs that slot three times,
// and without that the model would be paid three times to produce three
// identical texts, each superseding the last.
//
// INLINE, and it does NOT use `ctx.write`. `generateSummary` owns a
// supersede-then-insert across `analysis_run` and `work_summary` and is async,
// which a synchronous terminal transaction cannot contain — the same trade
// `schema-extract` documents. The resulting `analysis_run_id` is recorded on the
// stage run, so the chain from job to stage to analysis is followable.

import { dossierMembershipHash } from '../../db/repositories'
import { SCHEMA_VERSION } from '../../llm/prompts'
import { effectiveSummaryPrompt } from '../../llm/summaryPrompts'
import { isNoDossier, isNoSourceText } from '../../llm/summary'
import { isSourceTooLarge } from '../../llm/splitSource'
import type { Paragraphs } from '../capabilities'
import type { StageDefinition } from '../types'

const summarise: StageDefinition<{
  /** Which of the two summaries this job wrote. */
  kind: 'general' | 'project'
  analysisRunId: number
  /** True when an earlier project's run of the same slot already had it. */
  reused: boolean
}> = {
  id: 'summarise',
  label: 'Summarise',
  version: '1.0.0',
  rank: 5.5,
  scope: 'project',
  provides: ['analysis.summary@v1'],
  // The paragraphs, and only those. A summary is written from the paper's prose;
  // it cites nothing, measures nothing, and needs neither the page geometry nor
  // the PDF itself. Requiring more would strand a paper whose text arrived from
  // an abstract rather than from a document.
  requires: ['text.paragraphs@v1'],
  usesLlm: true,
  runtime: 'node',
  weight: 'light',
  isolation: 'inline',

  /**
   * Both prompt versions, the output schema version, and the project's dossier
   * BY MEMBERSHIP.
   *
   * The prompt versions because the brief is what decides what the summary says:
   * left out, the v1 -> v2 rewrite would have reached no paper, since the cache
   * would answer "identical inputs" for every one of them. That failure has
   * happened repeatedly in this pipeline and is why `schema-extract` hashes its
   * prompt too.
   *
   * The EFFECTIVE stamps, not the registry versions, because either brief may
   * have been replaced by the user — the general one for the whole corpus in
   * Settings, the project one on the project. A custom brief carries a digest of
   * its own text in its stamp, so editing it moves this fingerprint and the
   * stage reopens exactly the summaries that brief governs: every general
   * summary in the corpus, or this project's alone. That is the whole
   * invalidation mechanism; there is no second one. Reading the registry version
   * here instead would make an edited brief reach no paper that already had a
   * summary, which is the identical failure the paragraph above records.
   *
   * The dossier by MEMBERSHIP rather than content, for the reason
   * `schema-extract` sets out at length: the dossier's content is analysis
   * output, so hashing it would make every paper's fingerprint depend on every
   * other paper's results and the corpus would rebuild itself without end.
   * Membership still moves when a paper is marked as a reference, which is the
   * event that should reopen a project summary.
   */
  /**
   * The two kinds, as two slots. Fixed rather than computed: every paper has
   * both, and a project with no dossier still gets its project slot so the
   * absence is REPORTED there — `execute` declines it and the Queue shows a
   * paper waiting on a dossier, rather than a slot that silently never existed.
   */
  fanOut() {
    return [
      { key: 'general', label: 'General summary' },
      { key: 'project', label: 'Project summary' }
    ]
  },

  /**
   * PER SLOT, so editing one brief reopens only the summaries it governs.
   *
   * Hashing both briefs into both slots would make a change to the project brief
   * supersede every general summary in the corpus — work the model is paid for
   * and whose output is identical, which is exactly the failure the paragraph
   * above records in the other direction. The dossier belongs to the project
   * slot alone for the same reason: marking a reference paper says nothing about
   * how a paper reads on its own terms.
   */
  fingerprint(ctx, fan) {
    // Resolved through the same function the runner uses, and with the same
    // argument: 0 is the general summary's stored project id, `ctx.projectId`
    // the project one's. Two call sites disagreeing about which brief applies
    // would put a run's fingerprint out of step with its own provenance.
    if (fan?.key === 'project') {
      const project = effectiveSummaryPrompt(ctx.db, ctx.projectId)
      const dossier = dossierMembershipHash(ctx.db, ctx.projectId, ctx.workId)
      return `project=${project.stamp}|out=${SCHEMA_VERSION}|dossier=${dossier}`
    }
    const general = effectiveSummaryPrompt(ctx.db, 0)
    return `general=${general.stamp}|out=${SCHEMA_VERSION}`
  },

  async execute(ctx) {
    const paras = ctx.input<Paragraphs>('text.paragraphs@v1')
    if (!paras) {
      return { status: 'skipped', reason: 'no text.paragraphs@v1 — nothing to summarise' }
    }

    // WHICH summary this job is. The key is the slot's own name, so a job that
    // somehow arrives without one is treated as the general summary — the kind
    // every paper has regardless of any project's state.
    const kind: 'general' | 'project' = ctx.fanOut?.key === 'project' ? 'project' : 'general'

    let res: Awaited<ReturnType<typeof ctx.runSummary>>
    try {
      res = await ctx.runSummary(kind)
    } catch (err) {
      // The paper has only a title. A precondition is absent, so this is
      // `skipped` and not a fault: nothing broke, and the remedy is the user's.
      if (isNoSourceText(err)) {
        return {
          status: 'skipped',
          reason:
            'this paper has no readable text yet — only its title. Ingest its PDF, or add ' +
            'an abstract, and it can be summarised.'
        }
      }
      // NO DOSSIER IS AN ANSWER, NOT A FAILURE — and on a project that has not
      // built one it is the answer for every paper at once. A project summary
      // reads the paper against what the collection already holds; with nothing
      // to read it against, the only thing that could be written is a general
      // summary wearing a project's label, which the reader could not tell apart
      // from the real thing. So this slot declines, and the general slot beside
      // it is untouched — which is the whole reason the two are separate jobs.
      //
      // The refusal's OWN sentence, not a second copy written here. It
      // distinguishes "this project has no dossier" from "this project's dossier
      // is entirely this paper", and a paraphrase at this call site would report
      // the first for both — telling the user to build what they already built.
      if (isNoDossier(err)) {
        return { status: 'not-needed', reason: (err as Error).message }
      }
      // The document cannot be sent whole. NOT retryable and NOT skipped: the
      // same input would fail identically, and the only way past it is to
      // shorten the paper — which is exactly what this stage is forbidden to do.
      // Reported as a failure so it is visible, rather than quietly summarising
      // the part that fitted.
      if (isSourceTooLarge(err)) {
        return { status: 'failed', error: (err as Error).message, retryable: false }
      }
      throw err
    }

    if (!res.reused && res.body.trim() === '') {
      // A run committed with no prose. The row exists and says `failed`, which
      // is what makes it visible — but the stage must not report success over
      // it, or a paper with no summary would show a green dot. NAMED per kind,
      // so a reader of the Queue knows which of the two came back empty.
      return {
        status: 'failed',
        error: `the model returned no prose for this paper’s ${kind} summary`,
        retryable: true
      }
    }

    return {
      status: 'succeeded',
      result: { kind, analysisRunId: res.analysisRunId, reused: res.reused },
      // Only the exception, per HARD RULE 0.6. A summary that was written says
      // nothing; one served from an earlier project's identical run says so,
      // because a reader watching the model work is owed the reason this slot
      // finished without it.
      note: res.reused ? 'reused the summary already written for this paper' : undefined,
      provenance: {
        // From the WRITER, not from `ctx.llm`: the stage has no database handle
        // and so cannot resolve the setting — the same reason `promptVersion`
        // below is taken from the result. Stamping the provider default here
        // made one summary carry two different claims about what wrote it.
        model: res.modelUsed ?? ctx.llm.model,
        // Taken from the summary's own result rather than resolved here: a stage
        // holds no database handle (`ctx.db` is the narrow read wrapper), and
        // the value it wants is the one already stamped onto the analysis run,
        // so asking the writer for it is both possible and the only way the two
        // cannot disagree.
        promptVersion: res.promptStamp ?? undefined,
        schemaVersion: SCHEMA_VERSION,
        // A REUSED general summary is not this run's output. It is shared with
        // every other project holding the paper, and linking it here would let
        // this run's retirement delete a summary another project still reads.
        analysisRunId: res.reused ? undefined : res.analysisRunId
      }
    }
  }
}

export default summarise
