import { rollupState, type StageCell, type StageState } from './stageState'

/**
 * PHASES — how the pipeline's stages are grouped FOR A READER.
 *
 * The registry's fourteen stages are split the way they are for caching and
 * scope reasons: each one has to stay independently re-runnable, which is what
 * makes `npm run rerun:works -- 16 --stage ocr` possible. Those splits are an
 * implementation fact, and a scientist reading the queue does not need to know
 * that `retrieve` finds a URL and `download` fetches it — they need to know
 * whether the app got the PDF.
 *
 * This map lives in the RENDERER, not in `src/shared`, on purpose: nothing in
 * main groups stages, and the grouping is a presentation choice that must be
 * changeable without touching the pipeline. Above all, a stage must never know
 * its phase — the dependency runs one way, from this file to a list of ids.
 *
 * `embed` is deliberately alone. It is the only producer of
 * `text.embeddings@v1`, `verify-citations` depends on it, and it also feeds
 * semantic search outside the pipeline, so folding it into a neighbour would
 * misreport what a failure there costs.
 */
export interface Phase {
  id: string
  label: string
  /** Stage ids, in the order the phase's own steps run. */
  stages: readonly string[]
}

export const PHASES: readonly Phase[] = [
  // `zotero-push` rides along in this phase rather than getting one of its own:
  // it acts on the PDF the phase exists to produce, and it is a side effect on
  // another application that nothing downstream depends on — a phase of its own
  // would give a step that changes nothing here the same weight as the ones that
  // do. It settles `skipped` when no Zotero is connected, which is the ordinary
  // case, and a skipped stage does not hold the phase back from complete.
  { id: 'pdf', label: 'Get the PDF', stages: ['retrieve', 'download', 'optimize', 'zotero-push'] },
  { id: 'text', label: 'Read the text', stages: ['extract-text', 'ocr', 'segment'] },
  { id: 'embed', label: 'Embed for search', stages: ['embed'] },
  // TWO PHASES, NOT ONE WITH TWO STEPS. The two summaries answer different
  // questions and fail for unrelated reasons, so a single chip covering both
  // has to average them into one verdict — and its tooltip ends up reciting
  // both, which is how "Summarise" came to describe two things at once. Split,
  // each gets its own dot, its own state and its own sentence.
  { id: 'summary-general', label: 'General summary', stages: ['summarise:general'] },
  // `rerank` sits here rather than getting a phase of its own because this
  // phase already means "what this paper adds to your question", and that is
  // exactly what a relevance score answers — in a number where the summary
  // answers it in prose. It is a corpus sweep, so one row stands for the whole
  // library rather than for this paper.
  { id: 'summary-project', label: 'Project summary', stages: ['summarise:project', 'rerank'] },
  { id: 'references', label: 'Parse references', stages: ['references', 'reference-abstracts', 'resolve-references'] },
  {
    id: 'citations',
    label: 'Citation contexts',
    stages: ['citation-contexts', 'verify-citations']
  },
  { id: 'evidence', label: 'Extract evidence', stages: ['schema-extract', 'review-records'] }
]

/** Which phase a stage id belongs to, or undefined if this map does not name it. */
const PHASE_OF: ReadonlyMap<string, string> = new Map(
  PHASES.flatMap((p) => p.stages.map((s) => [s, p.id] as const))
)

/** One phase of one paper's pipeline: its stages, and one verdict over them. */
export interface PhaseCell {
  id: string
  label: string
  cells: StageCell[]
  /** The phase's verdict — see `phaseCells` for the rule. */
  state: StageState
  /**
   * This group is a single stage the phase map does not name, shown on its own
   * under its OWN label rather than being dropped or guessed into a neighbour.
   */
  ungrouped: boolean
}

/**
 * Group a row's stage cells into phases.
 *
 * THE STATUS RULE. A phase's state is `rollupState` over its own stages —
 * the same function the whole row's verdict uses, so a phase cannot mean
 * something different from the pill beside it. What that gives, in the terms
 * this file cares about:
 *
 *   - A FAILURE anywhere in the phase makes the phase failed. A phase that hid
 *     a failed stage would be the worst outcome available here.
 *   - A phase is COMPLETE only when EVERY one of its stages has reached a
 *     terminal state. One unplanned stage leaves the phase `pending` (nothing
 *     has happened yet) or `stalled` (some finished, nothing is moving) — never
 *     `succeeded`.
 *   - Stages that legitimately did nothing settle correctly: `skipped` is
 *     already folded into `succeeded` upstream in `jobState`, and `refused` /
 *     `empty` are surfaced as the non-failure answers they are. A phase whose
 *     stages all settled correctly reads as complete, not as stuck.
 *
 * A stage this map does not name — a newly registered one, or a job the
 * registry itself does not know — is NEVER dropped. It becomes a group of one
 * under its own stage label, at the position the registry gave it. Inventing a
 * phase for it would assert a relationship nobody declared; hiding it would
 * make an added stage invisible in the one screen that exists to show the
 * pipeline. Equally, a phase whose stages are all absent from this build
 * (`summarise` before it ships) simply does not appear.
 */
export function phaseCells(cells: readonly StageCell[]): PhaseCell[] {
  const out: PhaseCell[] = []
  const byId = new Map<string, PhaseCell>()

  for (const c of cells) {
    const phaseId = c.unmapped ? undefined : PHASE_OF.get(c.stage.id)
    if (phaseId === undefined) {
      out.push({
        id: `stage:${c.stage.id}`,
        label: c.stage.label,
        cells: [c],
        state: c.state,
        ungrouped: true
      })
      continue
    }
    const existing = byId.get(phaseId)
    if (existing) {
      existing.cells.push(c)
      continue
    }
    const def = PHASES.find((p) => p.id === phaseId)
    const fresh: PhaseCell = {
      id: phaseId,
      label: def?.label ?? phaseId,
      cells: [c],
      state: 'pending',
      ungrouped: false
    }
    byId.set(phaseId, fresh)
    out.push(fresh)
  }

  for (const p of out) {
    if (!p.ungrouped) p.state = rollupState(p.cells)
  }
  return out
}

/**
 * What a phase's chip says on hover: what the phase is for, then how far its
 * own stages have got. The per-stage detail is not duplicated here — that is
 * what expanding the phase is for.
 */
export const PHASE_MEANING: Record<string, string> = {
  pdf: 'Finding the paper and getting a readable PDF of it.',
  text: 'Turning that PDF into text the app can work with.',
  embed: 'Indexing the text so you can search by meaning, not just by word.',
  'summary-general': 'What this paper says, on its own. The same for every project.',
  'summary-project':
    'What this paper adds to your question, in prose and as a relevance score. Needs a project ' +
    'context first — without one, this is skipped.',
  references:
    'Reading the reference list, matching it to papers you have, and looking up what the rest ' +
    'are about.',
  citations: 'Finding where the paper cites each reference, and checking what it claims.',
  evidence: 'Pulling out the values you asked for, and flagging anything worth a look.'
}
