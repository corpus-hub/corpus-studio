import { z } from 'zod/v4'
import { DOSSIER_PAPER_LIMIT } from '@shared/contract'
import { e, type Entry } from '../types'
import {
  listProjects,
  getProject,
  listProjectWorks,
  createProjectRow,
  createSeedWork,
  updateProjectSetupRow,
  markProjectSetupDone,
  markReferencePaper,
  attachProjectSchema,
  countProjectWorks
} from '../../db/repositories'
import { buildDossier } from '../../llm/dossier'
import { getLlmProvider } from '../../llm/current'
import { getJobQueue } from '../../pipeline/scheduler'
import { trackBusy } from '../../busy'
import { listScope, scopeNote } from '../result'
import { CLAMP, cap, capOffset } from '../clamp'

/**
 * Projects — the reference domain.
 *
 * Every other domain file follows this shape; see `tmp/mcp-registry-contract.md`.
 *
 * The v3 originals these were re-authored from (`src/main/index.ts`, before the
 * migration) used `idSchema = z.number().int().nonnegative()`. `nonnegative`,
 * not `positive`: `project_id = 0` is the global-analysis sentinel and a
 * "tightened" schema would reject it.
 *
 * `.nullish()` where the v3 original was a bare positional scalar: the registry
 * loop turns a positional `null` into a PRESENT `null` property, which a plain
 * `.optional()` rejects. Here every id is required, so this note is for the
 * domains that have optional positional arguments.
 */

const projectId = z.number().int().nonnegative()

const nowIso = (): string => new Date().toISOString()

export const PROJECT_ENTRIES: Entry[] = [
  e({
    channel: 'projects:list',
    tool: 'projects_list',
    access: 'read',
    summary:
      'Every project in this install. A project is a research question; papers are ' +
      'interpreted per project, so almost every other tool needs a project_id from here. ' +
      'An empty list means the install has no projects yet, not that the call failed.',
    returns: 'ProjectDTO[]',
    params: z.object({}),
    run: (ctx) => listProjects(ctx.db),
    shape: (result, ctx) => {
      const items = result as unknown[]
      return listScope(items, items.length, {
        note:
          items.length === 0
            ? 'This install has no projects yet. Create one in the app before importing papers.'
            : null,
        counts: scopeNote.installCounts(ctx.db)
      })
    }
  }),

  e({
    channel: 'projects:get',
    tool: 'project_get',
    access: 'read',
    summary:
      'One project by its numeric id, or null when no project has that id. ' +
      'Project 0 is the sentinel used for analyses that belong to no project and is ' +
      'not a real project row.',
    returns: 'ProjectDTO | null',
    params: z.object({ projectId }),
    order: ['projectId'],
    run: (ctx, a) => getProject(ctx.db, a.projectId)
  }),

  e({
    channel: 'projects:create',
    tool: null,
    access: 'write',
    summary:
      'Create a project. Not exposed as a tool: a project is the frame a scientist ' +
      'states their own question in, and an agent inventing one would put every ' +
      'later interpretation under a question nobody asked.',
    returns: 'ProjectDTO',
    params: z.object({
      name: z.string().min(1),
      description: z.string(),
      seedTitles: z.array(z.string()).optional(),
      summaryPrompt: z.string().nullable().optional(),
      onboarding: z.boolean().optional()
    }),
    run: (ctx, a) => {
      const db = ctx.db
      const now = new Date().toISOString()
      // ONE transaction for the row and its seeds: a project that exists with
      // half its seed papers is a state the user cannot tell from a complete
      // one, and would have to diff by hand.
      const pid = db.transaction(() => {
        const id = createProjectRow(
          db,
          {
            name: a.name,
            description: a.description,
            summaryPrompt: a.summaryPrompt ?? null,
            onboarding: a.onboarding ?? false
          },
          now
        )
        for (const t of a.seedTitles ?? []) {
          if (t.trim()) createSeedWork(db, id, t.trim(), now)
        }
        return id
      })()
      const created = getProject(db, pid)
      if (!created) throw new Error('project create failed')
      return created
    }
  }),

  e({
    channel: 'projects:updateSetup',
    tool: null,
    access: 'write',
    summary:
      'Write one answer from the creation questionnaire. Not exposed as a tool for the ' +
      'same reason creating a project is not: what a project is for is the scientist\u2019s ' +
      'own statement, and an agent editing it would restate the question every later ' +
      'interpretation is read against.',
    returns: 'ProjectDTO',
    params: z.object({
      projectId,
      name: z.string().min(1).optional(),
      goal: z.string().optional(),
      questions: z.array(z.string()).optional(),
      schemaIds: z.array(z.number().int().positive()).optional()
    }),
    run: (ctx, a) => {
      const db = ctx.db
      const now = nowIso()
      db.transaction(() => {
        updateProjectSetupRow(
          db,
          { projectId: a.projectId, name: a.name, goal: a.goal, questions: a.questions },
          now
        )
        // The picker sends the WHOLE selection, so this is a set-to, not an
        // add. Detaching what is no longer picked is the only way unticking a
        // schema can mean anything.
        if (a.schemaIds !== undefined) {
          const want = new Set(a.schemaIds)
          const have = new Set(
            (
              db
                .prepare('SELECT schema_id AS id FROM project_schema WHERE project_id = ?')
                .all(a.projectId) as { id: number }[]
            ).map((r) => r.id)
          )
          for (const id of want) if (!have.has(id)) attachProjectSchema(db, a.projectId, id, now)
          for (const id of have) {
            if (!want.has(id)) {
              db.prepare('DELETE FROM project_schema WHERE project_id = ? AND schema_id = ?').run(
                a.projectId,
                id
              )
            }
          }
        }
      })()
      const p = getProject(db, a.projectId)
      if (!p) throw new Error(`No project with id ${a.projectId}.`)
      return p
    }
  }),

  e({
    channel: 'projects:finishSetup',
    tool: null,
    access: 'write',
    slow: true,
    summary:
      'Finish a project\u2019s setup: make the papers imported during it the project\u2019s ' +
      'context \u2014 up to the twenty a context may hold \u2014 build that context from them, ' +
      'and mark the project ready. Not a tool: it completes a form only a person fills in.',
    returns: 'ProjectDTO',
    params: z.object({ projectId }),
    order: ['projectId'],
    run: async (ctx, a) => {
      const db = ctx.db
      // REFUSED, not quietly skipped. The build reads the papers marked here,
      // so with none the context would be empty — and a setup reported finished
      // over an empty context is the one outcome the user cannot see.
      if (countProjectWorks(db, a.projectId) === 0) {
        throw new Error(
          'This project has no papers yet, so there is nothing to build its context from. ' +
            'Import at least one paper first.'
        )
      }
      // EVERY paper in the project, because during setup every paper in it was
      // imported INTO the project-context section and that is what the section
      // said it was for. Papers added later, from Ingest, are ordinary corpus
      // papers and are marked by hand.
      // CAPPED, and the cap is applied by taking the first papers rather than
      // by failing the finish. Setup imports into the project-context section,
      // so every paper is a candidate — but the dossier is read whole by a
      // model and `DOSSIER_PAPER_LIMIT` is what that budget allows.
      //
      // THE ORDER IS ALPHABETICAL, NOT BY RELEVANCE, and that is worth stating
      // plainly rather than dressing up. `rerank` is not in `ONBOARDING_STAGES`
      // and every import writes `relevance` as NULL, so at this moment every
      // row ties and `listProjectWorks`'s tiebreak — title — is the real order.
      // Scoring first would mean running the reranker before the form finishes,
      // which is the wait this whole deferral exists to avoid.
      //
      // So the user is TOLD which papers went in rather than left to infer it:
      // `contextPaperCount` and `papersLeftOut` come back on the reply, and the
      // screen says so. A cap that silently drops a third of what someone
      // imported, with the number they see no longer being the number the model
      // was given, is the failure this is avoiding.
      const now = nowIso()
      const works = listProjectWorks(db, a.projectId)
      const chosen = works.slice(0, DOSSIER_PAPER_LIMIT)
      const leftOut = works.length - chosen.length
      db.transaction(() => {
        for (const w of chosen) markReferencePaper(db, a.projectId, w.work.id, true, now)
      })()

      // Counted as busy so closing the window prompts rather than discarding a
      // build the user is watching — this is the slowest thing setup does.
      await trackBusy(
        () => buildDossier(db, getLlmProvider(), a.projectId, nowIso()),
        ctx.sender?.id ?? null
      )
      // LAST, and only once the build has returned. Marked before it, a build
      // that threw would leave a project that says it is ready with no context
      // behind it, and no way back into the form that would have fixed that.
      markProjectSetupDone(db, a.projectId, nowIso())

      // THE DEFERRED STAGES, now that the wait is nobody's to sit through.
      //
      // While the project was in setup, `planForWork` planned only the stages
      // that get a paper's text — the model-calling ones would have kept
      // someone waiting at a form for analyses it never shows. Those stages
      // were not skipped, only left unplanned, and this is where they are
      // asked for. It MUST come after `markProjectSetupDone`, because the
      // planner reads that same flag to decide what to plan; before it, this
      // would plan the identical short list again and the analyses would never
      // be reached at all.
      //
      // Per paper rather than one sweep: `planForWork` is idempotent and each
      // paper is its own pipeline. Failures are swallowed deliberately — the
      // setup is finished and the project is open either way, and an
      // unplannable paper is a queue problem the Papers screen already shows.
      for (const w of works) {
        try {
          getJobQueue().planForWork(w.work.id, a.projectId)
        } catch {
          /* see above */
        }
      }

      const p = getProject(db, a.projectId)
      if (!p) throw new Error(`No project with id ${a.projectId}.`)
      // PROVEN, not assumed. `reference_paper_count` on the reply is what the
      // context actually holds, so a caller can say "20 of 30 went in" without
      // a second round trip — and if the cap ever failed to hold, this says so
      // here rather than letting a project claim a context it does not have.
      if (leftOut > 0 && p.reference_paper_count !== DOSSIER_PAPER_LIMIT) {
        throw new Error(
          `Project context should hold ${DOSSIER_PAPER_LIMIT} papers after capping ` +
            `${works.length}, but holds ${p.reference_paper_count}.`
        )
      }
      return p
    }
  }),

  e({
    channel: 'projects:works',
    tool: 'project_papers_list',
    access: 'read',
    summary:
      'Every paper in a project, with that project\u2019s own interpretation of it — ' +
      'relevance, expansion priority, inclusion status. Those are project-specific: the ' +
      'same paper in another project carries different numbers, and they must never be ' +
      'pooled across projects. Paginated: pass limit and offset (limit defaults to ' +
      `${CLAMP.limit}); "total" is every paper in the project, so compare it with how many ` +
      'items you received before concluding the project is small.',
    returns: 'ProjectWorkDTO[]',
    // `limit`/`offset` are nullish rather than defaulted, so the RENDERER — which
    // passes neither and draws the whole project — is unchanged. The cap lives in
    // `clampArgs`, which only the MCP path runs; a corpus is thousands of papers
    // and an agent asking for "the project" should not be handed all of them.
    params: z.object({
      projectId,
      limit: z.number().int().min(1).max(1000).nullish(),
      offset: z.number().int().nonnegative().nullish()
    }),
    order: ['projectId'],
    clampArgs: (a) => ({ ...a, limit: cap(a.limit, CLAMP.limit), offset: capOffset(a.offset) }),
    run: (ctx, a) => listProjectWorks(ctx.db, a.projectId),
    shape: (result, ctx, a) => {
      const items = result as unknown[]
      const offset = a.offset ?? 0
      const limit = a.limit ?? items.length
      return listScope(items.slice(offset, offset + limit), items.length, {
        note: items.length === 0 ? scopeNote.emptyProject(ctx.db, a.projectId) : null,
        counts: null,
        limit,
        offset
      })
    }
  })
]
