/**
 * The shell's navigation vocabulary, SHARED between main and the renderer.
 *
 * It lives in `src/shared` rather than in the renderer because main is the
 * authority on which tabs exist in which window: it has to be able to validate a
 * route arriving over IPC, decide whether a tab's target still exists, and hand a
 * new window the tab it was seeded with. None of that is possible if the only
 * definition of a route is a type inside a React component.
 *
 * The renderer keeps ownership of what a route LOOKS like — which screen renders
 * it, which icon and label it carries. This module says only what a route IS.
 */

/** Every screen the shell can show. */
export const ROUTE_NAMES = [
  'projects',
  'setup',
  'graph',
  'references',
  'ranking',
  'ingest',
  'schemas',
  'extraction',
  'review',
  'dossier',
  'integrations',
  'paper'
] as const

export type RouteName = (typeof ROUTE_NAMES)[number]

/**
 * The routes that render WITHOUT a project open.
 *
 * `projects` is the dashboard. `schemas` is app-level — a schema is a global
 * definition, not a property of one project — so it must not fall into the shell's
 * "No project selected" guard.
 *
 * Everything else interprets a paper through `project_work` (relevance, inclusion
 * status, the user's overrides), so it is meaningless without one.
 */
export const PROJECT_LEVEL_ROUTES: ReadonlySet<RouteName> = new Set<RouteName>([
  'projects',
  'schemas'
])

export type Route =
  | { name: 'projects' }
  // The creation questionnaire. Project-scoped — the project row exists from the
  // moment a name is given, so the answers have somewhere to be written as they
  // are typed — but it is not a sidebar destination: it is where a project that
  // has not been set up is shown INSTEAD of its own screens.
  | { name: 'setup' }
  | { name: 'graph' }
  | { name: 'references' }
  | { name: 'ranking' }
  | { name: 'ingest' }
  | { name: 'schemas' }
  // rowKey/schemaId are OPTIONAL: the sidebar opens the whole matrix, while a
  // reading on the Paper screen opens Extraction ON that record. Carried on the
  // route (not passed once) so the deep link survives back/forward.
  | { name: 'extraction'; rowKey?: string; schemaId?: number }
  // factId is OPTIONAL: the sidebar opens the whole queue, while an Extraction
  // "review" status chip opens the queue ON that record.
  | { name: 'review'; factId?: number }
  | { name: 'dossier' }
  | { name: 'integrations' }
  // workId is OPTIONAL. `paper` is not a sidebar destination — it is opened via
  // openWork(id) from the Connectome, the Ranking list and the Papers list — but
  // it can still be entered without a selection (e.g. a restored route), and
  // PaperScreen then renders an empty state and fires no IPC instead of crashing
  // on getWork(undefined).
  // `evidenceId` addresses ONE evidence span inside the paper. Carried on the
  // route so a deep link into a specific quote survives back/forward — the
  // Extraction screen's "evidence →" promised the quote and delivered only the
  // paper.
  // `quote` addresses a passage that is NOT an evidence_span row: the Connectome
  // links to a citation context, whose text lives on citation_context and has no
  // span id. The paper screen locates it in the PDF text layer the same way the
  // find bar does, so a passage without a stored anchor is still navigable.
  | { name: 'paper'; workId?: number; evidenceId?: number; quote?: string }

/**
 * Is `v` one of the route names?
 *
 * Written as a scan of the frozen list rather than a `Set.has` or an `in` check
 * so that inherited object properties — `__proto__`, `constructor`, `toString` —
 * can never answer true for a value arriving over IPC.
 */
export function isRouteName(v: unknown): v is RouteName {
  return typeof v === 'string' && (ROUTE_NAMES as readonly string[]).includes(v)
}

/** Does this route require a project to be selected? */
export function needsProject(name: RouteName): boolean {
  return !PROJECT_LEVEL_ROUTES.has(name)
}

/**
 * One navigation state: the route AND the project it is being read in.
 *
 * They travel together because they change together. Opening a project changes
 * `projectId`, and going back to a paper inside a project the user has since left
 * must restore that project too — keeping them in one record makes every step
 * reversible by construction.
 */
export interface NavEntry {
  projectId: number | null
  route: Route
}
