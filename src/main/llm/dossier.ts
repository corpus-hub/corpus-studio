// Dossier BUILD — the authoring half of §8.
//
// `getDossier` is a passive SELECT: it reports whatever claims other analyses
// happened to leave behind. A BUILD is the deliberate act: for each paper the
// user marked as a reference, run the `dossier` analysis through the normal LLM
// pipeline, with the REST of the reference set supplied as background context,
// and persist the result with full provenance (supersede-then-insert). The
// claims that run produces then flow into `getDossier` like any other fact —
// there is no second, privileged store.
//
// WHY PER REFERENCE PAPER rather than one run over the whole set: `analysis_run`
// is keyed by (work, project, type), so a whole-corpus run would have no honest
// work_id to hang on, and every claim would lose the paper it came from. Running
// per paper keeps every claim traceable to one source document, which is the
// property the whole dossier rests on. The CROSS-paper element is the supplied
// context: each paper is read in the light of the others, and the model is asked
// to say where they agree, differ, or use the same term differently.
//
// EACH PAPER IS READ WHOLE. The source is `resolveSourceText`, the same resolver
// the two summaries use, so the dossier and the summaries are compiled from the
// same bytes and a re-extraction moves all three together.
//
// NOTHING here is domain-specific. The prompt asks for claims, their kind and
// their evidence; it never names a category, a unit or a field. Any structure
// beyond that comes from the extraction schemas, which are DB rows.

import type { DB } from '../db/connection'
import type { LlmProvider } from './provider'
import { runPipeline } from './pipeline'
import { resolveSourceText } from './summary'
import { buildDossierContext, getDossierStatus } from '../db/repositories'
import type { DossierStatusDTO } from '@shared/contract'

export interface DossierBuildResult {
  status: DossierStatusDTO
  /** One entry per reference paper the build ran over. */
  runs: Array<{ workId: number; analysisRunId: number; factCount: number }>
  /**
   * Reference papers the build did NOT read, and why.
   *
   * A paper with no text is passed over rather than failing the build: the other
   * references are readable and the user asked for the dossier they have. It is
   * REPORTED rather than passed over silently, because a reference contributing
   * nothing looks identical to a reference the model found nothing in.
   */
  skipped: Array<{ workId: number; reason: string }>
}

/**
 * Build (or rebuild) the project dossier from its reference papers.
 *
 * Throws when no reference paper is marked. The read path falls back to
 * top-relevance works so the screen is never blank, but WRITING analysis runs
 * against an implicit fallback set would persist provenance for a decision the
 * user never made — and the next time they marked a real reference, those runs
 * would silently still be there claiming to be the dossier.
 */
export async function buildDossier(
  db: DB,
  provider: LlmProvider,
  projectId: number,
  now: string
): Promise<DossierBuildResult> {
  const refs = db
    .prepare(
      `SELECT work_id FROM project_work
        WHERE project_id = ? AND is_reference = 1
        ORDER BY work_id ASC`
    )
    .all(projectId) as Array<{ work_id: number }>

  if (refs.length === 0) {
    throw new Error(
      'No reference papers are marked for this project. Mark at least one from the Ranking screen before building the project context.'
    )
  }

  const runs: DossierBuildResult['runs'] = []
  const skipped: DossierBuildResult['skipped'] = []
  for (const ref of refs) {
    // THE WHOLE PAPER, through the same resolver the summaries use.
    //
    // This used to be `title + abstract`, and the prompt above it asks for the
    // terminology and its synonyms, how a quantity is defined or measured, what
    // a value is compared against, and the conventions and caveats the paper
    // relies on — none of which an abstract contains. A dossier build therefore
    // read ~1 KB of a paper whose extracted prose runs to a hundred and more,
    // and every compile produced claims about the parts of a paper that exist
    // to be advertised. `resolveSourceText` is the same function the general
    // and project summaries read from, so a dossier is now compiled from
    // exactly the text a summary is written from, and a re-extraction moves
    // both.
    const source = resolveSourceText(db, ref.work_id)
    if (!source) {
      // A title is not a paper, and this is the same refusal `generateSummary`
      // makes for the same work — a dossier claim invented from a title would
      // be background the whole project is then read against.
      skipped.push({
        workId: ref.work_id,
        reason: 'this paper has no text yet — only its title'
      })
      continue
    }
    // The other reference papers' claims, as background. Empty on the first ever
    // build (nothing extracted yet) — the run then reads the paper alone, which
    // is the honest starting point rather than a fabricated context.
    const context = buildDossierContext(db, projectId, ref.work_id)
    const res = await runPipeline(
      db,
      provider,
      {
        workId: ref.work_id,
        projectId,
        analysisType: 'dossier',
        docText: source.text,
        // So a claim's `[pN]` lands on the paragraph the READER is shown. The
        // resolver drops the bibliography, which renumbers everything after it,
        // and an anchor is read back against `document_paragraph`.
        paragraphIndexMap: source.paragraphIndexMap,
        // The document the anchors belong to, so an evidence span carries the
        // file it was found in rather than a null the viewer cannot open.
        documentId: source.documentId,
        suppliedProjectContext: context || undefined
      },
      now
    )
    runs.push({
      workId: ref.work_id,
      analysisRunId: res.analysisRunId,
      factCount: res.factCount
    })
  }

  return { status: getDossierStatus(db, projectId), runs, skipped }
}
