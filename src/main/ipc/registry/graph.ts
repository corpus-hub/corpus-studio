import { z } from 'zod/v4'
import { e, type Entry } from '../types'
import {
  getGraph,
  getReferenceTree,
  retrieveUnresolvedReferences,
  getReferenceRetrievals,
  getReferenceAbstract
} from '../../db/repositories'
import { getJobQueue } from '../../pipeline/scheduler'
import type { DB } from '../../db/connection'
import { CLAMP, cap } from '../clamp'
import { listScope, scopeNote } from '../result'

/**
 * Graph — the citation network of a project, and the retrieval of references it
 * does not yet hold.
 *
 * The UI legitimately asks for thousands of nodes: the graph screen draws them
 * and solves readability with layout and zoom, and a ceiling in `params` would
 * silently drop references a paper really cites. So the CHANNEL keeps the v3
 * value space exactly, and the agent-facing cap lives in `clampArgs`, which runs
 * before the query — the only place a cap on a synchronous query is real. A cap
 * applied in `shape` would arrive after main had already been blocked for the
 * whole scan.
 */

const projectId = z.number().int().nonnegative()
const unresolvedId = z.number().int().nonnegative()

const nowIso = (): string => new Date().toISOString()

/**
 * Explain an empty graph, from real counts.
 *
 * A graph DTO is not a list, so it cannot carry a `ListScope` — but the failure
 * `scope_note` exists to prevent is exactly as available here: empty `nodes`
 * from a project id that does not exist looks identical to a project nobody has
 * added papers to, and an agent will report the second having done the first.
 */
function withEmptyNote(result: unknown, key: string, db: DB, projectId: number): unknown {
  const dto = result as Record<string, unknown>
  const nodes = dto?.[key]
  if (!Array.isArray(nodes) || nodes.length > 0) return result
  return { ...dto, scope_note: scopeNote.emptyProject(db, projectId) }
}

export const GRAPH_ENTRIES: Entry[] = [
  e({
    channel: 'graph:get',
    tool: 'graph_get',
    access: 'read',
    summary:
      'The citation graph of a project: papers as nodes with their relevance, and the ' +
      'resolved citation edges between them. Only edges BETWEEN papers in this corpus appear ' +
      '— a paper\u2019s references to work the corpus does not hold are not edges here, so this ' +
      'is not a picture of what the papers cite, it is a picture of what they cite that you ' +
      `also have. limit is the node budget (clamped to ${CLAMP.graphNodes} for tools; the ` +
      'response also carries the true total) and minRelevance drops nodes below a 0..1 ' +
      'relevance floor. For what a paper cites that is MISSING, use reference_tree_get.',
    returns: 'GraphDTO',
    params: z.object({
      projectId,
      opts: z
        .object({
          limit: z.number().int().positive().optional(),
          minRelevance: z.number().min(0).max(1).optional()
        })
        .nullish()
    }),
    order: ['projectId', 'opts'],
    clampArgs: (a) => ({
      ...a,
      opts: { ...(a.opts ?? {}), limit: cap(a.opts?.limit, CLAMP.graphNodes) }
    }),
    run: (ctx, a) => getGraph(ctx.db, a.projectId, a.opts ?? {}),
    shape: (result, ctx, a) => withEmptyNote(result, 'nodes', ctx.db, a.projectId)
  }),

  e({
    channel: 'graph:referenceTree',
    tool: 'reference_tree_get',
    access: 'read',
    summary:
      'The project\u2019s papers together with the references they make that are NOT in the ' +
      'corpus — the frontier of what you are missing. unresolvedPerWork is how many unmatched ' +
      'references to return per paper (0 = none, the default; a tool call is capped at 5, and ' +
      'paper_unresolved_refs_get gives you all of one paper\u2019s). Each carries an unresolved id ' +
      `you can feed to references_retrieve. Node budget clamped to ${CLAMP.graphNodes} for ` +
      'tools; "total_works" and "total_unresolved" are the true counts, so compare them with ' +
      'what you received rather than assuming you saw everything.',
    returns: 'ReferenceTreeDTO',
    params: z.object({
      projectId,
      opts: z
        .object({
          limit: z.number().int().positive().max(20000).optional(),
          // NOT capped in `params`: a review in this corpus cites 213 papers,
          // and a ceiling of 200 would silently drop thirteen of them. Whether a
          // drawing is readable is the renderer's problem to solve with layout
          // and zoom — it must not be solved by hiding references the paper
          // really cites.
          unresolvedPerWork: z.number().int().nonnegative().optional()
        })
        .nullish()
    }),
    order: ['projectId', 'opts'],
    clampArgs: (a) => ({
      ...a,
      opts: {
        ...(a.opts ?? {}),
        limit: cap(a.opts?.limit, CLAMP.graphNodes),
        // An agent reading JSON needs a handful of references per paper, not a
        // whole bibliography times every paper in the project. 300 nodes times a
        // full bibliography is tens of thousands of raw citation strings, and a
        // reference tree is NOT list-shaped, so the 4 MiB budget cannot truncate
        // it at a row boundary — it would refuse the whole answer instead.
        unresolvedPerWork: Math.min(a.opts?.unresolvedPerWork ?? 0, CLAMP.unresolvedPerWork)
      }
    }),
    run: (ctx, a) => getReferenceTree(ctx.db, a.projectId, a.opts ?? {}),
    shape: (result, ctx, a) => withEmptyNote(result, 'nodes', ctx.db, a.projectId)
  }),

  e({
    channel: 'graph:retrieveRefs',
    tool: 'references_retrieve',
    access: 'write',
    slow: true,
    summary:
      'Go and FETCH the real metadata for unresolved references from the external indexes, ' +
      'and queue the resulting papers for processing. Takes up to 200 unresolved ids from ' +
      'paper_unresolved_refs_get or reference_tree_get. This is ASYNCHRONOUS: it returns ' +
      'immediately with what it queued, and you poll jobs_list or job_get for the outcome — ' +
      'do not treat the return value as the finished import. It goes over the network and it ' +
      'ADDS PAPERS to the corpus. Retrieval progress is readable with ' +
      'reference_retrievals_get. If this call times out the queued work is NOT rolled back.',
    returns: 'RetrieveReferencesResultDTO',
    params: z.object({
      projectId,
      // Bounded at 200 for the same reason every other list handler is bounded:
      // a caller bug must not be able to spawn an unbounded number of jobs.
      unresolvedIds: z.array(unresolvedId).min(1).max(200)
    }),
    run: (ctx, a) => {
      // The planner is passed in so the repository stays a pure DB function,
      // drivable by the headless backend harness. `getJobQueue()` is called here
      // and not captured: the queue is a startup singleton this module must not
      // pin at import time.
      const queue = getJobQueue()
      return retrieveUnresolvedReferences(ctx.db, a.projectId, a.unresolvedIds, nowIso(), (job) =>
        queue.planForWork(job.workId, job.projectId)
      )
    }
  }),

  e({
    channel: 'graph:referenceRetrievals',
    tool: 'reference_retrievals_get',
    access: 'read',
    summary:
      'The retrieval status of specific unresolved references — whether a fetch was attempted, ' +
      'succeeded, or failed and why. This is how you follow up a references_retrieve call ' +
      'per reference, rather than inferring it from the queue. Pass the unresolved ids you ' +
      `submitted; a tool call reports on at most ${CLAMP.limit} of them per call and says in ` +
      'scope_note how many ids it dropped, so ask again for the rest rather than assuming the ' +
      'unreported ones have no retrieval.',
    returns: 'ReferenceRetrievalDTO[]',
    params: z.object({ unresolvedIds: z.array(unresolvedId).max(2000) }),
    order: ['unresolvedIds'],
    clampArgs: (a) => ({ ...a, unresolvedIds: a.unresolvedIds.slice(0, CLAMP.limit) }),
    run: (ctx, a) => getReferenceRetrievals(ctx.db, a.unresolvedIds),
    shape: (result, _ctx, a) => {
      const items = result as unknown[]
      // `a` is the CLAMPED argument list, so its length is what was actually
      // asked about — the drop is disclosed by the summary's cap, and the note
      // says when a row simply has no retrieval rather than having been dropped.
      const asked = a.unresolvedIds.length
      return listScope(items, items.length, {
        limit: CLAMP.limit,
        offset: 0,
        note:
          items.length < asked
            ? `${asked} ids were looked up and ${items.length} have a retrieval on record; the ` +
              'rest have never been fetched.'
            : null,
        counts: null
      })
    }
  }),

  e({
    channel: 'graph:referenceAbstract',
    tool: 'reference_abstract_get',
    access: 'read',
    summary:
      'The abstract an index returned for ONE unresolved reference — a paper this corpus ' +
      'cites but does not hold — together with the title the index matched, its DOI and which ' +
      'index answered. READ "outcome" BEFORE "abstract", because the four non-"found" values ' +
      'mean different things and only one of them is about the paper: "absent" is an index ' +
      'that answered and holds no abstract; "unreachable" means the index could not be reached ' +
      'and says NOTHING about whether an abstract exists; "ambiguous" means several records ' +
      'fit the printed reference and none was trusted; "nothing-to-ask-with" means the entry ' +
      'prints no DOI and no usable title. A null outcome means nothing has looked yet. ' +
      'matched_title is a CLAIM that this reference is that paper — compare it with the ' +
      'reference before relying on the text. Returns null only when no such unresolved id ' +
      'exists.',
    returns: 'ReferenceAbstractDTO | null',
    params: z.object({ unresolvedId }),
    order: ['unresolvedId'],
    run: (ctx, a) => getReferenceAbstract(ctx.db, a.unresolvedId)
  })
]
