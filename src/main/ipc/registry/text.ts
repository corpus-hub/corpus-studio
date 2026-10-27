import { z } from 'zod/v4'
import { e, type Ctx, type Entry } from '../types'
import { findInDocument, getDocumentText, paragraphTexts, FIND_MAX_NEEDLE } from '../../db/repos/text'
import { projectContextPointer } from '../projectContext'

/**
 * Reading INSIDE one paper: literal find, and the text itself.
 *
 * The app's own find bar lives in the renderer, over the pdf.js text layer, so
 * nothing server-side could search a paper's body until these existed. They are
 * the by-word half of "search in paper" — the by-meaning half is
 * `papers_search_by_meaning` with a `workId`, which scopes the same embedding
 * index to a single document.
 *
 * A caller names the paper by `workId` OR `documentId`, never both and never
 * neither: a work can hold several documents (a preprint and its published
 * version), so which one was read is part of the answer, and guessing it would
 * quietly attribute a quotation to the wrong file. `.superRefine` is invisible
 * to `z.toJSONSchema`, so that rule is also stated in words in each summary —
 * without it an agent retries the same invalid call forever.
 */

/** Exactly one of `workId` / `documentId`, both optional in the schema itself. */
const paperRef = {
  workId: z.number().int().positive().optional(),
  documentId: z.number().int().positive().optional()
}

const exactlyOneRef = (
  v: { workId?: number; documentId?: number },
  ctx: z.RefinementCtx
): void => {
  if ((v.workId === undefined) === (v.documentId === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'Give exactly one of workId or documentId.' })
  }
}

export const TEXT_ENTRIES: Entry[] = [
  e({
    channel: 'paper:findText',
    tool: 'paper_find_text',
    access: 'read',
    summary:
      'Find a literal string inside ONE paper\u2019s extracted text \u2014 the by-word search in a ' +
      'paper. Give exactly one of workId or documentId (a work can hold several documents). ' +
      'Returns each hit with its paragraph index, page and character offsets, so a quotation can ' +
      'be cited back. Matching is a plain substring, not a regex and not stemmed: "eliminase" ' +
      'does not find "elimination". Case-insensitive unless caseSensitive is true. For meaning ' +
      'rather than spelling use papers_search_by_meaning with a workId. Requires the paper\u2019s ' +
      'text to have been extracted; one with only an abstract reports that rather than 0 hits.',
    returns:
      'TextSearchDTO { state, hits[], total, document_id, ... }  (MCP: plus project_context)',
    params: z
      .object({
        ...paperRef,
        // Bounded at BOTH ends, and non-blank AFTER trimming. An empty or
        // all-whitespace needle is not a search that found nothing, it is a
        // request that was never made: returning `0 hits` would read as "this
        // word is not in the paper".
        needle: z
          .string()
          .min(1)
          .max(FIND_MAX_NEEDLE)
          .refine((v) => v.trim().length > 0, { message: 'Enter something to search for.' }),
        caseSensitive: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional()
      })
      .strict()
      .superRefine(exactlyOneRef),
    run: (ctx, a) => findInDocument(ctx.db, a),
    shape: (result, ctx, a) => withTextProjectContext(result, ctx, a)
  }),

  e({
    channel: 'paper:text',
    tool: 'paper_text_get',
    access: 'read',
    summary:
      'Read a paper\u2019s extracted text. Give exactly one of workId or documentId. Paged, ' +
      'because a paper is far larger than one response: pass page for a specific page, or ' +
      'fromIdx/toIdx for a paragraph range, and the reply says how much is left. Returns the ' +
      'text layer the analyses were actually run against, not the PDF \u2014 so it is the right ' +
      'thing to quote when checking what a stage could have seen.',
    returns:
      'DocumentTextDTO { state, paragraphs[], from_idx, to_idx, total, ... }  (MCP: plus project_context)',
    params: z
      .object({
        ...paperRef,
        fromIdx: z.number().int().min(0).optional(),
        toIdx: z.number().int().min(0).optional(),
        page: z.number().int().min(1).optional()
      })
      .strict()
      .superRefine(exactlyOneRef),
    run: (ctx, a) => getDocumentText(ctx.db, a),
    shape: (result, ctx, a) => withTextProjectContext(result, ctx, a)
  }),

  e({
    channel: 'paper:paragraphTexts',
    // UI only. An agent reading a paper wants `paper_text_get`, which is paged
    // and says what it left out; this is the unbounded inventory the highlight
    // anchor needs, and as a tool it would be a way to pull a whole paper into
    // a context window in one call while looking like a different question.
    tool: null,
    access: 'read',
    summary: 'Every paragraph of one document, for anchoring an evidence highlight.',
    returns: 'ParagraphTextDTO[]',
    params: z.object({ documentId: z.number().int().positive() }).strict(),
    run: (ctx, a) => paragraphTexts(ctx.db, a.documentId)
  })
]

/**
 * Point an agent reading a paper's TEXT at the project background it is missing.
 *
 * Neither of these reads names a project, and none is inferred: a text read is a
 * read of the paper itself, and attaching one project's background to it would
 * present that project's framing as the document's own. So it names the
 * candidate projects and the tool that answers, and only while the caller has
 * not already been given them.
 *
 * A `documentId` is resolved to its work first, because the pointer is a
 * statement about the PAPER's project memberships and a document has none of its
 * own.
 */
function withTextProjectContext(
  result: unknown,
  ctx: Ctx,
  a: { workId?: number; documentId?: number }
): unknown {
  if (result === null || result === undefined) return result
  let workId = a.workId
  if (workId === undefined && a.documentId !== undefined) {
    const row = ctx.db
      .prepare('SELECT work_id FROM document WHERE id = ?')
      .get(a.documentId) as { work_id: number } | undefined
    workId = row?.work_id
  }
  const pointer = projectContextPointer(ctx, workId)
  if (!pointer) return result
  return { ...(result as Record<string, unknown>), project_context: pointer }
}
