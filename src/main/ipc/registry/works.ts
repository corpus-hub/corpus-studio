import { z } from 'zod/v4'
import { parseTabKey } from '../../../shared/tabKey'
import { getTabModel } from '../../tabs-service'
import { e, type Entry } from '../types'
import {
  getWork,
  getCitationEdgesForWork,
  getWorkDocuments,
  getWorkAnalyses,
  getUnresolvedReferences,
  getCitationContextsForWork,
  countCitationContextsForWork,
  getCitationOutcomeForWork,
  resolveUnresolvedReference,
  deleteWork,
  removeWorkFromProject,
  addWorkToProject
} from '../../db/repositories'
import { MAX_WORK_REF, resolveWorkRef } from '../../db/repos/resolve'
import { broadcastJobsChanged } from '../../broadcast'
import { CLAMP, cap, capOffset } from '../clamp'
import { listScope } from '../result'
import { projectContextPointer, withProjectContext } from '../projectContext'

/**
 * Works — one paper, and everything hanging off it.
 *
 * Schemas RE-AUTHORED in zod/v4 from the v3 originals in `src/main/index.ts`.
 * The v3 atoms were `idSchema = z.number().int().nonnegative()` — `nonnegative`
 * and not `positive`, because `project_id = 0` is the global-analysis sentinel.
 *
 * Every channel here is POSITIONAL in the preload, so every one declares
 * `order`, INCLUDING the single-argument ones: without it the loop hands a bare
 * number to `z.object().parse`, which throws "expected object" on every call
 * forever. The property names are the PRELOAD's parameter names (`workId`, not
 * the `id` the old inline handler used for its local).
 */

const workId = z.number().int().nonnegative()
const projectId = z.number().int().nonnegative()

const nowIso = (): string => new Date().toISOString()

export const WORK_ENTRIES: Entry[] = [
  e({
    channel: 'paper:resolve',
    tool: 'paper_resolve',
    access: 'read',
    summary:
      'Turn a DOI, arXiv id, PMID or title into the work_id every other paper tool needs. ' +
      'START HERE when all you have is an identifier or a name — no other tool accepts one. ' +
      'This searches only what is ALREADY in this corpus; it fetches nothing and imports ' +
      'nothing, so a paper that exists in the world but not here comes back "not-found". ' +
      'READ "state" BEFORE ANYTHING ELSE, because only one of the four carries a work_id: ' +
      '"resolved" has it and says what it matched on; "ambiguous" means several papers fit ' +
      'and you must choose between the candidates rather than guess, with "more" true when ' +
      'even more matched than are listed; "not-found" carries near misses as suggestions, ' +
      'which are NOT matches; "invalid" means the reference itself could not be read. ' +
      'kind narrows the interpretation and defaults to "auto", which infers it.',
    returns: 'ResolveWorkDTO',
    params: z.object({
      paperRef: z.string().min(1).max(MAX_WORK_REF),
      kind: z.enum(['doi', 'arxiv', 'pmid', 'title', 'auto']).nullish()
    }),
    order: ['paperRef', 'kind'],
    run: (ctx, a) => resolveWorkRef(ctx.db, a.paperRef, { kind: a.kind ?? undefined })
  }),

  e({
    channel: 'works:get',
    tool: 'paper_get',
    access: 'read',
    summary:
      'One paper by its numeric work_id: title, abstract, year, venue, authors, identifiers ' +
      'and content status. Call paper_resolve first if all you have is a DOI or a title. ' +
      'Returns null when no work has that id. A WORK is the abstract output; the concrete ' +
      'PDFs it has are DOCUMENTS, listed by paper_documents_list.',
    returns: 'WorkDetailDTO | null  (MCP: plus project_context, see below)',
    params: z.object({ workId }),
    order: ['workId'],
    run: (ctx, a) => getWork(ctx.db, a.workId),
    // A read of the GLOBAL work, so it names no project and NONE IS GUESSED.
    // Attaching the dossier of "the paper's only project" would hand one
    // project's interpretation to a caller who asked what the paper itself says,
    // and pooling several would invent a consensus those projects never reached.
    // So this points at the projects that HAVE background for this paper and at
    // the tool that serves it, and says nothing once the caller has it.
    shape: (result, ctx, a) => {
      if (result === null || result === undefined) return result
      const pointer = projectContextPointer(ctx, a.workId)
      if (!pointer) return result
      return { ...(result as Record<string, unknown>), project_context: pointer }
    }
  }),

  e({
    channel: 'works:citations',
    tool: 'paper_citations_get',
    access: 'read',
    summary:
      'The RESOLVED citation edges touching this paper — references it makes to papers that ' +
      'are in this corpus, and papers in this corpus that cite it. References the app could ' +
      'not match to a corpus paper are NOT here; read paper_unresolved_refs_get for those, ' +
      'or the reference list is silently short. A hub paper can have thousands of edges, so ' +
      `a tool call returns at most ${CLAMP.limit} of them with the true total beside them.`,
    returns: 'CitationEdgeDTO[]',
    params: z.object({ workId }),
    order: ['workId'],
    run: (ctx, a) => getCitationEdgesForWork(ctx.db, a.workId),
    shape: (result) => {
      const all = result as unknown[]
      const items = all.slice(0, CLAMP.limit)
      return listScope(items, all.length, {
        limit: CLAMP.limit,
        offset: 0,
        note:
          items.length === 0
            ? 'No resolved citation edges. Check paper_citation_outcome_get for whether the ' +
              'references were ever analysed, and paper_unresolved_refs_get for parsed-but-unmatched ones.'
            : null,
        counts: null
      })
    }
  }),

  e({
    channel: 'works:documents',
    tool: 'paper_documents_list',
    access: 'read',
    summary:
      'The concrete documents (PDF versions) of this paper. A WORK is the abstract paper; a ' +
      'DOCUMENT is one stored file of it, and tools that read text take a document_id. Each ' +
      'carries a content status of fulltext, abstract-only or metadata-only — an analysis ' +
      'over an abstract-only document is NOT full-text-backed, however confident it reads — ' +
      'and a text_source of pdf-text-layer, ocr or unknown, where "ocr" means characters a ' +
      'recogniser guessed from pixels and can be wrong in ways that read as plausible. ' +
      'Where the file lives on disk is deliberately not disclosed; "file" reduces to whether ' +
      'a stored file exists and how big it is.',
    returns: 'DocumentDTO[]',
    params: z.object({ workId }),
    order: ['workId'],
    run: (ctx, a) => getWorkDocuments(ctx.db, a.workId),
    shape: (result) => {
      // `DocumentDTO.file` carries `base_dir_label` and `relative_path`: the
      // user's own directory layout, which on a Zotero-imported base dir is
      // named after the folder they keep their library in. That is their
      // filesystem — and their OS username, often enough — handed to an external
      // agent that asked about a paper. The presence and the size are the whole
      // of what an agent can act on, so that is all it gets.
      const items = (result as Array<Record<string, unknown>>).map((doc) => {
        const file = doc.file as { size_bytes: number | null; role: string } | null
        return {
          ...doc,
          file: file ? { present: true, size_bytes: file.size_bytes, role: file.role } : null
        }
      })
      return listScope(items, items.length, {
        note:
          items.length === 0
            ? 'This paper has no document yet — it exists as metadata only, so there is no full text to read.'
            : null,
        counts: null
      })
    }
  }),

  e({
    channel: 'works:analyses',
    tool: 'paper_analyses_list',
    access: 'read',
    summary:
      'Every AI analysis run recorded for this paper in this project, with full provenance: ' +
      'model, provider, prompt and schema version, run timestamp, verifier result and ' +
      'freshness. project_id 0 is the GLOBAL sentinel — analyses belonging to no project. ' +
      'Superseded runs are included and flagged; exactly one run per analysis type is current.',
    returns: 'AnalysisRunDTO[]  (MCP: run yields a ListScope, plus project_context)',
    params: z.object({ workId, projectId }),
    order: ['workId', 'projectId'],
    run: (ctx, a) => getWorkAnalyses(ctx.db, a.workId, a.projectId),
    shape: (result, ctx, a) => {
      const all = result as unknown[]
      const items = all.slice(0, CLAMP.limit)
      return withProjectContext(listScope(items, all.length, {
        limit: CLAMP.limit,
        offset: 0,
        note:
          all.length === 0
            ? 'Nothing has been analysed for this paper in this project yet. Note that project_id 0 ' +
              'holds the global runs, so try that id too before concluding the paper is unread.'
            : null,
        counts: null
      }), ctx, a.projectId, a.workId)
    }
  }),

  e({
    channel: 'works:unresolved',
    tool: 'paper_unresolved_refs_get',
    access: 'read',
    summary:
      'References this paper makes that the app parsed but could NOT match to a paper in the ' +
      'corpus, with their raw bibliography text and any guessed DOI, title, venue or year. ' +
      'These are never silently dropped; use unresolved_ref_resolve to attach one to a work, ' +
      'or references_retrieve to go and fetch its metadata. References naming the same paper ' +
      'from different bibliographies are merged, so one entry can stand for several. A review ' +
      `can cite hundreds, so a tool call returns at most ${CLAMP.limit} with the true total.`,
    returns: 'UnresolvedReferenceDTO[]',
    params: z.object({ workId }),
    order: ['workId'],
    run: (ctx, a) => getUnresolvedReferences(ctx.db, a.workId),
    shape: (result) => {
      const all = result as unknown[]
      return listScope(all.slice(0, CLAMP.limit), all.length, {
        limit: CLAMP.limit,
        offset: 0,
        note:
          all.length === 0
            ? 'No unmatched references. That means either every reference resolved to a paper in ' +
              'the corpus, or the references were never parsed — paper_citation_outcome_get says which.'
            : null,
        counts: null
      })
    }
  }),

  e({
    channel: 'works:citationContexts',
    tool: 'paper_citation_contexts_get',
    access: 'read',
    summary:
      'Where in this paper each reference is actually cited: the callout sentence, its ' +
      'section, the role the citation plays, and the raw bibliography text as printed. ' +
      'Paginated — pass limit and offset; total is a true COUNT(*), not the page size. ' +
      'Some fields are absent rather than null when the app never analysed them; read ' +
      'paper_citation_outcome_get rather than treating a missing key as "no value found".',
    returns: 'CitationContextDTO[]',
    params: z.object({
      workId,
      // MCP-only paging. The UI passes nothing and gets today's unpaged list —
      // the repository's defaults are unchanged, so this widens nothing.
      limit: z.number().int().min(1).max(1000).nullish(),
      offset: z.number().int().nonnegative().nullish()
    }),
    order: ['workId'],
    clampArgs: (a) => ({
      ...a,
      limit: cap(a.limit, CLAMP.limit),
      offset: capOffset(a.offset)
    }),
    run: (ctx, a) =>
      getCitationContextsForWork(ctx.db, a.workId, {
        limit: a.limit ?? undefined,
        offset: a.offset ?? undefined
      }),
    shape: (result, ctx, a) => {
      const items = result as unknown[]
      const total = countCitationContextsForWork(ctx.db, a.workId)
      return listScope(items, total, {
        note:
          total === 0
            ? 'No citation contexts recorded. paper_citation_outcome_get says whether the references ' +
              'were never analysed or genuinely have none.'
            : null,
        counts: null,
        limit: a.limit ?? null,
        offset: a.offset ?? 0
      })
    }
  }),

  e({
    channel: 'works:citationOutcome',
    tool: 'paper_citation_outcome_get',
    access: 'read',
    summary:
      'WHY this paper has the citation contexts it has — in particular whether its references ' +
      'were never analysed at all versus analysed and genuinely empty. An empty context list ' +
      'means nothing until you have read this. Returns null when the install predates ' +
      'stage tracking.',
    returns: 'CitationOutcomeDTO | null',
    params: z.object({ workId }),
    order: ['workId'],
    run: (ctx, a) => getCitationOutcomeForWork(ctx.db, a.workId)
  }),

  e({
    channel: 'works:resolveRef',
    tool: 'unresolved_ref_resolve',
    access: 'write',
    summary:
      'Attach one unresolved reference to a paper ALREADY IN THIS CORPUS, creating the ' +
      'citation edge. Find the target with paper_resolve or papers_search first and pass its ' +
      'work_id. edgeType defaults to "cites". This is a permanent claim that paper A cites ' +
      'paper B — do not guess: if the raw bibliography text is ambiguous, leave it ' +
      'unresolved. If this call times out or your connection drops the write is NOT rolled ' +
      'back; read the state back with paper_unresolved_refs_get before retrying.',
    returns: 'ResolveReferenceResultDTO',
    params: z.object({
      unresolvedId: z.number().int().nonnegative(),
      target: z.union([
        z.object({ workId }),
        z.object({
          newWork: z.object({
            title: z.string().min(1),
            doi: z.string().optional(),
            year: z.number().int().optional(),
            venue: z.string().optional()
          })
        })
      ]),
      edgeType: z
        .enum(['cites', 'extends', 'contradicts', 'uses-method', 'reviews', 'related'])
        .optional()
    }),
    // The tool gets the EXISTING-WORK branch only. The `newWork` branch mints a
    // metadata-only paper from strings the caller supplies, which is a corpus an
    // agent can grow by inventing citations that were never verified against
    // anything — and it is unnecessary, because references_retrieve fetches the
    // real metadata for an unresolved reference from the indexes instead.
    toolParams: z.object({
      unresolvedId: z.number().int().nonnegative(),
      // A union of ONE, not a bare object: `params` emits `anyOf` here, and the
      // sweep's subset check compares `type` node for node — a bare object would
      // read as `object` vs the channel's absent type and be reported as a
      // widening, which it is the exact opposite of.
      target: z.union([z.object({ workId })]),
      edgeType: z
        .enum(['cites', 'extends', 'contradicts', 'uses-method', 'reviews', 'related'])
        .optional()
    }),
    run: (ctx, a) =>
      // The 'cites' default lives HERE, in the body, exactly as the v3 handler
      // had it — moving it into the schema would change what the emitted JSON
      // Schema tells an agent about an omitted field.
      resolveUnresolvedReference(ctx.db, a.unresolvedId, a.target, nowIso(), a.edgeType ?? 'cites')
  }),

  e({
    channel: 'work:delete',
    tool: 'paper_delete',
    access: 'destructive',
    summary:
      'Delete a paper and everything derived from it — documents, analyses, facts, ' +
      'measurements, evidence spans, citation edges and queued jobs — from EVERY project, ' +
      'not just one. There is no undo and no archive. Returns false when no work had that id. ' +
      'Ask the human before calling this.',
    returns: 'boolean',
    params: z.object({ workId }),
    order: ['workId'],
    run: (ctx, a) => {
      const ok = deleteWork(ctx.db, a.workId)
      if (!ok) return false
      // The delete cancels any job for that paper, and the queue view must not
      // go on offering to retry work whose subject no longer exists.
      broadcastJobsChanged()
      // Any tab SHOWING that paper is marked, in place, wherever it is.
      //
      // Marked rather than closed: a page the user opened vanishing on its own,
      // because of something that happened in another window, is worse than
      // being shown what became of it. Without this the tab renders "Work not
      // found." for the rest of the session with nothing saying why.
      //
      // Told the id directly rather than re-validating every tab against the
      // database: the delete already knows exactly what went, and a scan would
      // put a query per open tab on the one connection the ingest writes through.
      markWorkTabsStale(a.workId)
      return true
    }
  }),

  e({
    channel: 'work:removeFromProject',
    tool: 'paper_remove_from_project',
    access: 'write',
    summary:
      'Take a paper OUT OF ONE PROJECT, leaving the paper and every other project that ' +
      'holds it untouched. This is the one to use when a paper does not belong in a ' +
      'collection — paper_delete erases it everywhere and cannot be undone. Removes this ' +
      'project\u2019s own reading of the paper (relevance, inclusion status, reference flag); ' +
      'analyses are keyed by paper AND project and survive, so re-adding finds them again. ' +
      'Returns false when the paper was not in that project.',
    returns: 'boolean',
    params: z.object({ projectId: z.number().int().nonnegative(), workId }),
    order: ['projectId', 'workId'],
    run: (ctx, a) => {
      const ok = removeWorkFromProject(ctx.db, a.projectId, a.workId)
      // Every count on the dashboard and in the setup form is derived from
      // project membership, so they all move on this write.
      if (ok) broadcastJobsChanged()
      return ok
    }
  }),

  e({
    channel: 'work:addToProject',
    tool: 'paper_add_to_project',
    access: 'write',
    summary:
      'Put a paper the library ALREADY HOLDS into a project. This does NOT import or fetch ' +
      'anything — a paper is stored once and this adds only this project\u2019s own reading of ' +
      'it, which starts unscored and unread. Use it to bring a paper reached through a ' +
      'citation into the project looking at it. Returns false when the paper was already a ' +
      'member, so adding twice is not an error.',
    returns: 'boolean',
    params: z.object({ projectId: z.number().int().positive(), workId }),
    order: ['projectId', 'workId'],
    run: (ctx, a) => {
      const ok = addWorkToProject(ctx.db, a.projectId, a.workId, new Date().toISOString())
      if (ok) broadcastJobsChanged()
      return ok
    }
  })
]

/**
 * Strike through every tab whose current page is this now-deleted work.
 *
 * Matched on the tab's CURRENT route, which is what `markStale` passes: a tab
 * that merely started on this paper and has since been navigated elsewhere is
 * fine, and a tab that arrived at it from somewhere else is not.
 */
function markWorkTabsStale(workId: number): void {
  getTabModel().markStale((key) => {
    const parsed = parseTabKey(key)
    return parsed !== null && parsed.name === 'paper' && parsed.workId === workId
  }, 'This paper was deleted')
}
