// Staleness of an analysis run's INPUTS.
//
// `analysis_run` records a hash of each input it was built from (document text,
// prompt, output schema, project dossier). Those hashes exist for exactly one
// purpose: to answer "is this stored result still valid for the inputs as they
// stand today?". This module answers it.
//
// The governing rule is that a verdict must be PROVABLE from what the DB still
// holds. Three verdicts are therefore possible per input, and the third is not
// a cop-out — it is the honest answer whenever the current value of an input
// cannot be reconstructed:
//
//   current         the input reproduces exactly what this run recorded
//   stale           the input demonstrably differs from what this run recorded
//   unknown         the input's present value cannot be recomputed, so neither
//                   'current' nor 'stale' can be asserted
//   not-applicable  the input never applied to this run (e.g. a project dossier
//                   for a global run), which is different from "unknown"
//
// The comparison is always against the inputs THAT RUN used, never against
// whatever the screen happens to be displaying. Concretely: the document hash is
// recomputed under the run's OWN stored `prompt_version` / `schema_version`, so
// a prompt bump cannot masquerade as a changed document; and the candidate text
// is drawn from the document(s) this run's own evidence spans point at, not from
// the work's preferred document.

import type { DB } from './connection'
import { hashInput } from '../adapters'
import { getPrompt, hasPrompt, summaryPromptName, SCHEMA_VERSION } from '../llm/prompts'
import { effectiveSummaryPrompt, parseSummaryPromptStamp } from '../llm/summaryPrompts'
import type { AnalysisFreshnessDTO, AnalysisInputFreshnessDTO } from '@shared/contract'

/** The columns of `analysis_run` this computation reads. */
export interface FreshnessRunInput {
  id: number
  work_id: number
  project_id: number
  analysis_type: string
  prompt_version: string
  schema_version: string
  /** The targeted extraction schema; 0 = the generic, schema-less extraction. */
  schema_id: number
  doc_input_hash: string | null
  prompt_input_hash: string | null
  schema_input_hash: string | null
  dossier_input_hash: string | null
}

export interface FreshnessDeps {
  /**
   * The dossier-context hash a work WOULD be analysed against right now.
   * Injected rather than imported so this module never depends on
   * `repositories.ts`, which depends on it.
   */
  currentDossierInputHash(db: DB, projectId: number, workId: number): string | null
}

/**
 * Per-call memo for the values that depend on the WORK rather than on the run.
 *
 * A paper's runs are checked in a batch and they share a work, so rebuilding
 * the project dossier and re-reading the document bodies once per run repeats
 * the same JOIN and the same text scan for an answer that cannot differ.
 * `getWorkAnalyses` was explicitly de-N+1'd once already; this keeps it that
 * way. The cache is created fresh per call and thrown away, so it can never
 * serve a value across a mutation.
 */
export interface FreshnessCache {
  docBody: Map<number, string | null>
  workBody: Map<number, string | null>
  dossier: Map<string, string | null>
}

export const newFreshnessCache = (): FreshnessCache => ({
  docBody: new Map(),
  workBody: new Map(),
  dossier: new Map()
})

/**
 * The document hash the run's own stamps would produce for `text`. Uses the
 * RUN's prompt/schema versions, not today's, so this expression isolates the
 * document: it is the same expression `runPipeline` evaluates at persist time.
 */
function docHashFor(run: FreshnessRunInput, text: string): string {
  return hashInput({
    workId: run.work_id,
    projectId: run.project_id,
    analysisType: run.analysis_type,
    promptVersion: run.prompt_version,
    schemaVersion: run.schema_version,
    doc: text
  })
}

/**
 * The prose body of a document as the extraction stage assembles it: every
 * paragraph except the bibliography, in order, joined by blank lines. Mirrors
 * `pipeline/stages/schema-extract.ts` exactly — if the two ever diverge, this
 * check degrades to "unknown", never to a false "stale".
 *
 * Scoped to ONE segment run. `document_paragraph` rows are keyed by
 * `stage_run_id`, and `stages/segment.ts` deliberately does not delete by
 * document_id so a concurrent run's inventory can coexist — reading them all
 * would concatenate two inventories into a body no run ever saw and report a
 * confident "stale" about it. More than one live inventory means the current
 * body is genuinely ambiguous, so this returns null and the caller says
 * "unknown".
 */
function documentBody(db: DB, documentId: number, cache: FreshnessCache): string | null {
  const hit = cache.docBody.get(documentId)
  if (hit !== undefined) return hit
  const body = readDocumentBody(db, documentId)
  cache.docBody.set(documentId, body)
  return body
}

function readDocumentBody(db: DB, documentId: number): string | null {
  const runs = db
    .prepare(
      /* sql */ `
      SELECT DISTINCT sr.id
      FROM stage_run sr
      JOIN document_paragraph dp ON dp.stage_run_id = sr.id
      WHERE dp.document_id = ? AND sr.superseded = 0
    `
    )
    .all(documentId) as Array<{ id: number }>
  if (runs.length !== 1) return null

  const rows = db
    .prepare(
      /* sql */ `
      SELECT text FROM document_paragraph
      WHERE stage_run_id = ? AND kind != 'reference'
      ORDER BY idx ASC
    `
    )
    .all(runs[0].id) as Array<{ text: string }>
  if (rows.length === 0) return null
  return rows.map((r) => r.text).join('\n\n')
}

/** The title+abstract text an un-documented analysis is run over (`analysis:run`). */
function workBody(db: DB, workId: number, cache: FreshnessCache): string | null {
  const hit = cache.workBody.get(workId)
  if (hit !== undefined) return hit
  const body = readWorkBody(db, workId)
  cache.workBody.set(workId, body)
  return body
}

function readWorkBody(db: DB, workId: number): string | null {
  const w = db.prepare('SELECT title, abstract FROM work WHERE id = ?').get(workId) as
    | { title: string; abstract: string | null }
    | undefined
  if (!w) return null
  const text = [w.title, w.abstract ?? ''].filter(Boolean).join('\n\n')
  return text === '' ? null : text
}

function documentFreshness(
  db: DB,
  run: FreshnessRunInput,
  cache: FreshnessCache
): AnalysisInputFreshnessDTO {
  const base = { input: 'document' as const, label: 'Source text', recorded_hash: run.doc_input_hash }
  if (run.doc_input_hash === null) {
    return {
      ...base,
      verdict: 'unknown',
      reason: 'This run recorded no hash of the text it read, so there is nothing to compare against.',
      current_hash: null
    }
  }

  // Documents this run DEMONSTRABLY read. Two independent records say so, and
  // both are used because either alone leaves a real gap:
  //   - `stage_run.analysis_run_id` — the stage that COMMISSIONED the run,
  //     which knows the document even when the model returned nothing, so a
  //     failed run is not left unattributable.
  //   - `evidence_span.document_id` — where the run anchored what it found,
  //     which covers runs made outside the stage machinery.
  //   - `work_summary.document_id` — the document a SUMMARY was written from.
  //     A summary produces prose rather than anchored claims, so it has no
  //     evidence spans at all; without this third record every summary in the
  //     app would report `unknown` forever, since none of them can ever name
  //     the text they read.
  // Anything beyond these three would be an assumption about which text it saw —
  // and assuming is how a run inherits credit for a document it never opened.
  const docIds = (
    db
      .prepare(
        `SELECT document_id FROM evidence_span
           WHERE analysis_run_id = ? AND document_id IS NOT NULL
         UNION
         SELECT document_id FROM stage_run
           WHERE analysis_run_id = ? AND document_id != 0
         UNION
         SELECT document_id FROM work_summary
           WHERE analysis_run_id = ? AND document_id IS NOT NULL
         ORDER BY document_id`
      )
      .all(run.id, run.id, run.id) as Array<{ document_id: number }>
  ).map((r) => r.document_id)

  const candidates: Array<{ label: string; text: string }> = []
  const unreadable: string[] = []
  for (const id of docIds) {
    const body = documentBody(db, id, cache)
    if (body === null) unreadable.push(`document ${id}`)
    else candidates.push({ label: `document ${id}`, text: body })
  }
  const wb = workBody(db, run.work_id, cache)
  if (wb !== null) candidates.push({ label: 'the work’s title and abstract', text: wb })

  for (const c of candidates) {
    const h = docHashFor(run, c.text)
    if (h === run.doc_input_hash) {
      return {
        ...base,
        verdict: 'current',
        reason: `${c.label} still hashes to exactly what this run recorded.`,
        current_hash: h
      }
    }
  }

  // No match. 'stale' costs a scientist a re-run, so it is asserted only when
  // the text this run read is UNAMBIGUOUS: exactly one document is linked to
  // the run, and its present text is fully reconstructible. Any ambiguity —
  // a second linked document, or one whose text is no longer stored — leaves
  // open that the missing text is the one that was hashed, and an open
  // possibility is 'unknown', not 'stale'.
  const proven = candidates.filter((c) => c.label.startsWith('document '))
  if (unreadable.length > 0) {
    return {
      ...base,
      verdict: 'unknown',
      reason: `This run read ${unreadable.join(
        ' and '
      )}, whose extracted text is no longer stored in full, so its present state cannot be compared.`,
      current_hash: null
    }
  }
  if (proven.length > 1) {
    return {
      ...base,
      verdict: 'unknown',
      reason: `This run is linked to ${proven
        .map((c) => c.label)
        .join(' and ')}, and none of them reproduces its hash — but which one it was actually given is not recorded, so it cannot be said which has changed.`,
      current_hash: null
    }
  }
  if (proven.length === 1) {
    return {
      ...base,
      verdict: 'stale',
      reason: `This run read ${proven[0].label}, whose text no longer hashes to what the run recorded — the source has been re-extracted or edited since.`,
      current_hash: docHashFor(run, proven[0].text)
    }
  }
  return {
    ...base,
    verdict: 'unknown',
    reason:
      'Which text this run read is not recorded, and no text still held for this paper reproduces its hash — it may have read a full text that is no longer stored.',
    current_hash: null
  }
}

/**
 * The prompt.
 *
 * `prompt_input_hash` covers the system prompt AND the rendered user message,
 * which embeds the whole document — so for a run whose source text is gone it
 * cannot be recomputed at all, and the mock adapter stamps the doc key into it
 * regardless. It is therefore NOT what the verdict rests on, and is not
 * reported as a comparison: `recorded_hash` is left null here so the card
 * cannot imply a digest comparison that did not happen.
 *
 * The registry version stamp is what can be checked. Membership is asked of the
 * registry directly (`hasPrompt`) rather than inferred from the returned
 * template: `getPrompt` serves a generic fallback under the REQUESTED version's
 * name, and several registered prompts share that same fallback text, so
 * neither the version nor the system text can distinguish "still defined" from
 * "retired". Comparing them would report every retired version as current.
 */
/**
 * Why a summary's brief no longer matches, in the terms the reader can act in.
 *
 * The three cases are genuinely different remedies — a shipped revision the user
 * did not make, an edit they made, and a return to the built-in — so one
 * sentence covering all of them would send them to the wrong place. Composed
 * entirely from the two stamps; nothing here is a judgement about the prose.
 */
function describeSummaryPromptChange(
  registryKey: string,
  recorded: string,
  todayStamp: string
): string {
  const was = parseSummaryPromptStamp(recorded)
  const now = parseSummaryPromptStamp(todayStamp)
  const whose = registryKey === 'summary-general' ? 'general summary' : 'project summary'
  if (was.customDigest === null && now.customDigest !== null) {
    return `Written with the built-in ${whose} instructions; those instructions have since been rewritten, and the new ones are what this summary would be written with today.`
  }
  if (was.customDigest !== null && now.customDigest === null) {
    return `Written with custom ${whose} instructions; they have since been returned to the built-in ${registryKey} ${now.baseVersion}.`
  }
  if (was.customDigest !== null && now.customDigest !== null) {
    return `Written with custom ${whose} instructions that have been edited since.`
  }
  return `Written with the ${registryKey} prompt ${was.baseVersion}; ${now.baseVersion} is what this analysis would use today.`
}

function promptFreshness(db: DB, run: FreshnessRunInput): AnalysisInputFreshnessDTO {
  const base = { input: 'prompt' as const, label: 'Prompt', recorded_hash: null, current_hash: null }
  // A summary's brief depends on WHERE the run is stored, not on its type
  // alone: the general and the project summary are both
  // `analysis_type = 'summary'` and are told apart by `project_id`. Asking the
  // registry for 'summary' would look up a prompt neither of them used, find
  // nothing, and report every summary in the app as having instructions that
  // cannot be recovered.
  const registryKey =
    run.analysis_type === 'summary' ? summaryPromptName(run.project_id) : run.analysis_type

  // A SUMMARY's brief may have been rewritten by the user, in which case its
  // stamp is `<version>+custom-<digest>` and no registry holds it. Reading that
  // as "retired" would report every customised summary as uncheckable — the
  // exact failure this function's own comment warns about, arriving through a
  // second door. So the stamp is split: the base half is still asked of the
  // registry, and the digest half is compared against the brief as it stands
  // now. Both halves are string comparisons over stored values, so the verdict
  // stays as mechanical as it was.
  if (run.analysis_type === 'summary') {
    const { baseVersion } = parseSummaryPromptStamp(run.prompt_version)
    if (!hasPrompt(registryKey, baseVersion)) {
      return {
        ...base,
        verdict: 'unknown',
        reason: `The registry no longer defines the ${registryKey} prompt ${baseVersion}, so the instructions this run was given cannot be recovered or compared.`
      }
    }
    const today = effectiveSummaryPrompt(db, run.project_id)
    if (today.stamp === run.prompt_version) {
      return {
        ...base,
        verdict: 'current',
        reason: today.custom
          ? `Written with this ${registryKey === 'summary-general' ? 'corpus' : 'project'}'s own summary instructions, and they have not been edited since.`
          : `The registry still defines ${registryKey} ${baseVersion} and still resolves to it, so this run's instructions are the current ones.`
      }
    }
    return {
      ...base,
      verdict: 'stale',
      reason: describeSummaryPromptChange(registryKey, run.prompt_version, today.stamp)
    }
  }

  if (!hasPrompt(registryKey, run.prompt_version)) {
    return {
      ...base,
      verdict: 'unknown',
      reason: `The registry no longer defines the ${registryKey} prompt ${run.prompt_version}, so the instructions this run was given cannot be recovered or compared.`
    }
  }
  const today = getPrompt(registryKey)
  if (today.version !== run.prompt_version) {
    return {
      ...base,
      verdict: 'stale',
      reason: `Written with the ${registryKey} prompt ${run.prompt_version}; ${today.version} is what this analysis would use today.`
    }
  }
  return {
    ...base,
    verdict: 'current',
    reason: `The registry still defines ${registryKey} ${run.prompt_version} and still resolves to it, so this run's instructions are the current ones.`
  }
}

/**
 * The schema — BOTH of them, because a run answers to two.
 *
 * `schema_version` is the OUTPUT envelope the model's reply was validated
 * against. `schema_id` names the user-authored EXTRACTION schema that decided
 * WHAT was asked for, and that one is editable: `stages/schema-extract.ts`
 * fingerprints `schema=<id>@<version>` precisely so that adding a required
 * field supersedes the run made before it existed. Checking only the envelope
 * would let a run made under an older field list read as satisfying today's.
 *
 * The verdict rests on the version stamps, not on `schema_input_hash`: the mock
 * adapter writes the document key into all three hash columns, so comparing
 * that digest would report staleness for a reason having nothing to do with any
 * schema. `recorded_hash` is therefore left null rather than shown next to a
 * comparison that was not made against it.
 */
function schemaFreshness(db: DB, run: FreshnessRunInput): AnalysisInputFreshnessDTO {
  const base = {
    input: 'schema' as const,
    label: 'Output schema',
    recorded_hash: null,
    current_hash: null
  }
  if (run.schema_version !== SCHEMA_VERSION) {
    return {
      ...base,
      verdict: 'stale',
      reason: `Validated against output schema ${run.schema_version}; the current schema is ${SCHEMA_VERSION}.`
    }
  }
  // schema_id 0 is the generic extraction: no field list to have moved.
  if (run.schema_id !== 0) {
    const target = db
      .prepare('SELECT name, version FROM extraction_schema WHERE id = ?')
      .get(run.schema_id) as { name: string; version: string } | undefined
    if (!target) {
      return {
        ...base,
        verdict: 'unknown',
        reason: `The extraction schema this run targeted (id ${run.schema_id}) no longer exists, so the field list it was asked for cannot be compared with today's.`
      }
    }
    // The run does not store the schema's version, so the stage fingerprint is
    // what would have superseded it. Absence of a live fingerprint for this run
    // means nothing can be proven about the field list, so say so.
    const fp = db
      .prepare(
        `SELECT sr.input_fingerprint, sr.superseded
           FROM stage_run sr WHERE sr.analysis_run_id = ? ORDER BY sr.id DESC LIMIT 1`
      )
      .get(run.id) as { input_fingerprint: string; superseded: number } | undefined
    if (!fp) {
      return {
        ...base,
        verdict: 'unknown',
        reason: `This run targeted the “${target.name}” schema, but no stage record ties it to a field-list version, so whether that schema has been edited since cannot be established.`
      }
    }
    if (fp.superseded === 1) {
      return {
        ...base,
        verdict: 'stale',
        reason: `The “${target.name}” schema (now ${target.version}) has been edited since this run: the stage that produced it has been superseded by one built from the current field list.`
      }
    }
    return {
      ...base,
      verdict: 'current',
      reason: `Output schema ${SCHEMA_VERSION}, and the “${target.name}” extraction schema ${target.version} it targeted is still the live field list.`
    }
  }
  return {
    ...base,
    verdict: 'current',
    reason: `Validated against output schema ${SCHEMA_VERSION}, which is still the current one.`
  }
}

/**
 * The project dossier. Fully reconstructible from project state, so this is the
 * one input whose verdict really does rest on an end-to-end hash comparison —
 * the same comparison `getDossierStaleWorks` makes, by the same expression.
 *
 * A GLOBAL run was never given a project dossier, and a dossier BUILD run draws
 * its context from the reference set it feeds. Both are `not-applicable`, which
 * is a statement about the input, unlike `unknown`.
 */
function dossierFreshness(
  db: DB,
  run: FreshnessRunInput,
  deps: FreshnessDeps,
  cache: FreshnessCache
): AnalysisInputFreshnessDTO {
  const base = {
    input: 'dossier' as const,
    label: 'Project context',
    recorded_hash: run.dossier_input_hash
  }
  if (run.project_id === 0) {
    return {
      ...base,
      verdict: 'not-applicable',
      reason: 'A global run is given no project context, so there is none to have changed.',
      current_hash: null
    }
  }
  if (run.analysis_type === 'dossier') {
    return {
      ...base,
      verdict: 'not-applicable',
      reason:
        'This run is part of BUILDING the project context. Its context is drawn from the same reference set it feeds, so measuring it against the finished project context would only compare the work to itself.',
      current_hash: null
    }
  }
  // The project summary is the ONE analysis given the dossier. Everything else
  // — extraction above all — reads the paper alone, so the project's background
  // is not one of its inputs and cannot have gone stale under it. Judged by the
  // analysis type rather than by whether a hash happens to be stored, so a run
  // made back when extraction WAS given the dossier answers the same as one
  // made today: the input does not apply, whatever the old row recorded.
  if (run.analysis_type !== 'summary') {
    return {
      ...base,
      verdict: 'not-applicable',
      reason:
        'Only the project summary is given the project context. This analysis reads the paper alone, so the project context is not one of its inputs.',
      current_hash: null
    }
  }
  const memoKey = `${run.project_id}:${run.work_id}`
  const cached = cache.dossier.get(memoKey)
  const current =
    cached !== undefined
      ? cached
      : (() => {
          const v = deps.currentDossierInputHash(db, run.project_id, run.work_id)
          cache.dossier.set(memoKey, v)
          return v
        })()
  if (current === run.dossier_input_hash) {
    return {
      ...base,
      verdict: 'current',
      reason:
        current === null
          ? 'No project context was supplied, and none would be supplied today either.'
          : 'The project context this run was given is the one it would be given today.'
    ,
      current_hash: current
    }
  }
  return {
    ...base,
    verdict: 'stale',
    reason:
      run.dossier_input_hash === null
        ? 'This run was given no project context; the project now has one to supply.'
        : current === null
          ? 'This run was given project context; the project has none to supply today.'
          : 'The project context has changed since this run was made.',
    current_hash: current
  }
}

/**
 * Whether a stored analysis still reflects the inputs it was built from.
 *
 * Computed in MAIN because it reads the DB and rehashes source text — the
 * renderer has neither. Nothing is reprocessed and nothing is written: this
 * only reports the discrepancy, exactly like `getDossierStaleWorks`.
 *
 * `superseded` is deliberately not folded in. A superseded run being out of
 * force is a different fact from its inputs having moved, and the card states
 * both separately rather than letting one imply the other.
 */
export function computeAnalysisFreshness(
  db: DB,
  run: FreshnessRunInput,
  deps: FreshnessDeps,
  cache: FreshnessCache = newFreshnessCache()
): AnalysisFreshnessDTO {
  const inputs: AnalysisInputFreshnessDTO[] = [
    documentFreshness(db, run, cache),
    promptFreshness(db, run),
    schemaFreshness(db, run),
    dossierFreshness(db, run, deps, cache)
  ]
  const considered = inputs.filter((i) => i.verdict !== 'not-applicable')
  const stale = considered.filter((i) => i.verdict === 'stale')
  const unknown = considered.filter((i) => i.verdict === 'unknown')
  const current = considered.filter((i) => i.verdict === 'current')

  const names = (list: AnalysisInputFreshnessDTO[]): string =>
    list.map((i) => i.label.toLowerCase()).join(', ')

  if (stale.length > 0 && unknown.length === 0 && current.length === 0) {
    return {
      verdict: 'stale',
      summary: `Every input this run can be checked against has changed since: ${names(stale)}.`,
      inputs
    }
  }
  if (stale.length > 0) {
    return {
      verdict: 'partially-stale',
      summary: `Changed since this run: ${names(stale)}.${
        unknown.length > 0 ? ` Not checkable: ${names(unknown)}.` : ''
      }`,
      inputs
    }
  }
  if (unknown.length > 0) {
    return {
      verdict: 'unknown',
      summary: `Cannot be checked against ${names(unknown)}, so whether this run is still valid is unproven.${
        current.length > 0 ? ` Unchanged: ${names(current)}.` : ''
      }`,
      inputs
    }
  }
  if (current.length > 0) {
    return {
      verdict: 'current',
      summary: `Every input this run recorded still matches: ${names(current)}.`,
      inputs
    }
  }
  return {
    verdict: 'unknown',
    summary: 'None of this run’s inputs apply to a freshness check, so nothing can be said about it.',
    inputs
  }
}
