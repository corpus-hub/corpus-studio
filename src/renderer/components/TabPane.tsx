import { useEffect, useRef } from 'react'
import type { ProjectDTO } from '@shared/types'
import { PROJECT_LEVEL_ROUTES, type Route, type RouteName } from '@shared/nav'
import { TabVisibilityProvider } from '../lib/visibility'
import { ProjectsScreen } from '../screens/ProjectsScreen'
import { GraphScreen } from '../screens/GraphScreen'
import { ReferencesScreen } from '../screens/ReferencesScreen'
import { PaperScreen } from '../screens/PaperScreen'
import { RankingScreen } from '../screens/RankingScreen'
import { IngestScreen } from '../screens/IngestScreen'
import { SchemasScreen } from '../screens/SchemasScreen'
import { ExtractionScreen } from '../screens/ExtractionScreen'
import { ReviewScreen } from '../screens/ReviewScreen'
import { DossierScreen } from '../screens/DossierScreen'
import { ProjectSetupScreen } from '../screens/ProjectSetupScreen'
import { IntegrationsScreen } from '../screens/IntegrationsScreen'

/**
 * ONE tab's screen, mounted whether or not it is the one on screen.
 *
 * Keeping a tab mounted is what makes switching back to it instant and what
 * preserves its scroll, its find query and its filters — none of which survived
 * a navigation before, because the shell unmounted every screen on every route
 * change. It is also a real cost, which is why `HEAVY_ROUTES` and the live-set
 * policy above this exist: a mounted screen still holds its DOM, its data and
 * (for the paper view) its rasterized pages.
 */

/**
 * The routes expensive enough that only a few may be mounted at once.
 *
 * `paper` carries a pdf.js worker, a parsed document and rasterized page
 * canvases — roughly 13 MB per letter page. `graph` and `references` each drive
 * a canvas with their own scheduler. Everything else is DOM and rows: cheap
 * enough that suspending it would cost the user a re-fetch to save nothing.
 */
export const HEAVY_ROUTES: ReadonlySet<RouteName> = new Set<RouteName>([
  'paper',
  'graph',
  'references',
  // Not a canvas, but not cheap either: it loads EVERY extracted row for the
  // project in one unpaginated array (the pagination below it is display-only)
  // and renders a wide grid from it. On a large corpus that is tens of megabytes
  // of DTOs plus a heavy DOM, held per open project — which with several project
  // tabs is several independent copies of the same shape.
  'extraction'
])

/**
 * How many heavy tabs stay mounted at once.
 *
 * Three, because the user's actual working set is "the one I am reading and the
 * one or two I am comparing it to", and each of these holds enough GPU memory
 * that a dozen would exhaust it. Exhaustion is not a graceful failure here: a 2D
 * context that cannot allocate returns null, the render loop skips that page,
 * and the reader is shown a paper with BLANK pages and no error at all. A
 * suspended tab, by contrast, comes back from its stored view state at the
 * scroll position and page it was left on.
 */
export const HEAVY_LIVE_SET = 3

export interface TabPaneProps {
  route: Route
  projectId: number | null
  projects: ProjectDTO[]
  visible: boolean
  /**
   * Bumped when this tab is opened INTO rather than created.
   *
   * The screens' focus handling is latched on the id it last honoured, so
   * following "Evidence →" twice to the same span would appear to do nothing.
   * This is mixed into the focus props' identity to make those effects re-run.
   */
  focusNonce: number
  navigate: (route: Route, projectId?: number | null) => void
  onTitle: (title: string) => void
  onFailedCountChanged: () => void
  /**
   * A project row changed in a way the SHELL depends on.
   *
   * Only `setup_state` so far, and that is enough to need this: the shell reads
   * it to decide whether to draw a project's screens at all, so a project that
   * has just finished its setup would otherwise keep being shown the form it
   * completed — with nothing to press, because the form is gone.
   *
   * A caller holding the changed ROW passes it, so the shell has the project
   * before the re-read returns — see `reloadProjects` in `App.tsx`.
   */
  onProjectsChanged: (created?: ProjectDTO) => void
}

export function TabPane({
  route,
  projectId,
  projects,
  visible,
  focusNonce,
  navigate,
  onTitle,
  onFailedCountChanged,
  onProjectsChanged
}: TabPaneProps): JSX.Element {
  const activeProject = projects.find((p) => p.id === projectId) ?? null
  const pid = projectId ?? 0

  const go = (name: RouteName): void => navigate({ name } as Route)
  const openWork = (workId: number): void => navigate({ name: 'paper', workId })
  const openEvidence = (workId: number, evidenceId: number): void =>
    navigate({ name: 'paper', workId, evidenceId })
  const openQuote = (workId: number, quote: string): void =>
    navigate({ name: 'paper', workId, quote })
  const openReview = (factId: number): void => navigate({ name: 'review', factId })
  const openExtractionRow = (rowKey: string, schemaId?: number): void =>
    navigate({ name: 'extraction', rowKey, schemaId })
  const openProject = (id: number): void => navigate({ name: 'graph' }, id)
  // Schemas are global, so opening them CLOSES the project: the sidebar then
  // shows the projects-level nav and the hierarchy stays honest.
  const goToSchemas = (): void => navigate({ name: 'schemas' }, null)

  // The tab's label follows its subject. Reported up rather than derived in the
  // strip, because only the screen knows a paper's title, and it only knows it
  // once the work has loaded.
  // Named for what the tab actually SHOWS. While the project is being set up
  // that is the questionnaire, whatever route the tab holds — a tab reading
  // "Connectome" that opens a setup form is a tab the reader cannot find again.
  const label =
    activeProject?.setup_state === 'onboarding' && !PROJECT_LEVEL_ROUTES.has(route.name)
      ? `Set up · ${activeProject.name}`
      : tabLabel(route, activeProject)
  const lastTitle = useRef<string | null>(null)
  useEffect(() => {
    if (lastTitle.current === label) return
    lastTitle.current = label
    onTitle(label)
  }, [label, onTitle])

  const needsProject = !PROJECT_LEVEL_ROUTES.has(route.name) && projectId === null

  /**
   * A project still in its questionnaire shows THAT, whatever route asked for it.
   *
   * Enforced here rather than at the dashboard's click handler, because the
   * dashboard is only one of the ways in: a restored session, a tab left open
   * from last time, a "go to papers" from somewhere else, all address the
   * project directly. Guarding one entrance leaves the others open onto screens
   * that read `project_work` rows the project does not have yet.
   *
   * `projects` and `schemas` are exempt for the reason they are exempt
   * everywhere: neither is about this project. Leaving for the dashboard, or for
   * the global schema list, was never an escape from setting this one up.
   */
  const inSetup =
    activeProject?.setup_state === 'onboarding' && !PROJECT_LEVEL_ROUTES.has(route.name)

  return (
    <TabVisibilityProvider value={visible}>
      {needsProject ? (
        <div className="card empty-state" data-testid="no-project">
          <div className="empty-state-title">No project selected.</div>
          <div className="empty-state-hint">Create or pick a project to continue.</div>
          <button
            className="btn btn-primary"
            style={{ marginTop: 12 }}
            onClick={() => navigate({ name: 'projects' }, null)}
          >
            Go to projects
          </button>
        </div>
      ) : inSetup ? (
        <ProjectSetupScreen
          projectId={pid}
          onOpenWork={openWork}
          onFailedCountChanged={onFailedCountChanged}
          onFinished={() => {
            // The shell FIRST, then the move. Navigating while it still
            // believes this project is in setup would land on the guard again
            // and re-render the questionnaire over a project that has one.
            onProjectsChanged()
            navigate({ name: 'graph' }, pid)
          }}
        />
      ) : (
        <>
          {route.name === 'projects' && (
            <ProjectsScreen onOpenProject={openProject} onProjectsChanged={onProjectsChanged} />
          )}
          {/* The route survives the state it was made for. A tab left on `setup`
              from before the build finished addresses a project that is now set
              up, and there is no questionnaire left to draw — so it resolves to
              where finishing would have sent it. */}
          {route.name === 'setup' && (
            <SetupFinished projectId={pid} onGo={() => navigate({ name: 'graph' }, pid)} />
          )}
          {route.name === 'graph' && (
            <GraphScreen
              projectId={pid}
              onOpenWork={openWork}
              onOpenQuote={openQuote}
              onAddPapers={() => go('ingest')}
            />
          )}
          {route.name === 'references' && (
            <ReferencesScreen
              projectId={pid}
              onOpenWork={openWork}
              onOpenQuote={openQuote}
              onAddPapers={() => go('ingest')}
            />
          )}
          {route.name === 'ranking' && (
            <RankingScreen projectId={pid} onOpenWork={openWork} onAddPapers={() => go('ingest')} />
          )}
          {route.name === 'ingest' && (
            <IngestScreen
              projectId={pid}
              onOpenWork={openWork}
              onFailedCountChanged={onFailedCountChanged}
            />
          )}
          {route.name === 'schemas' && <SchemasScreen />}
          {route.name === 'extraction' && (
            <ExtractionScreen
              // The nonce is part of the KEY, not a prop, for the focus-carrying
              // screens: their focus effects latch on the id they honoured and
              // return early when it is unchanged, so re-opening a tab at the
              // same row would silently do nothing. Remounting is the one thing
              // that is correct for every one of those latches at once, without
              // reaching into five screens to thread a nonce through each.
              key={`extraction-${focusNonce}`}
              projectId={pid}
              onOpenWork={openWork}
              onOpenEvidence={openEvidence}
              onEditSchemas={goToSchemas}
              onOpenReview={openReview}
              onAddPapers={() => go('ingest')}
              focusRowKey={route.rowKey}
              focusSchemaId={route.schemaId}
            />
          )}
          {route.name === 'review' && (
            <ReviewScreen
              key={`review-${focusNonce}`}
              projectId={pid}
              onOpenWork={openWork}
              focusFactId={route.factId}
              onAddPapers={() => go('ingest')}
            />
          )}
          {route.name === 'dossier' && (
            <DossierScreen projectId={pid} onOpenWork={openWork} onAddPapers={() => go('ingest')} />
          )}
          {route.name === 'integrations' && (
            <IntegrationsScreen projectId={pid} onGoToPapers={() => go('ranking')} />
          )}
          {route.name === 'paper' && (
            <PaperScreen
              key={`paper-${focusNonce}`}
              workId={route.workId}
              projectId={pid}
              projectName={activeProject?.name ?? null}
              onGoToGraph={() => go('graph')}
              onGoToRanking={() => go('ranking')}
              onOpenWork={openWork}
              onOpenExtractionRow={openExtractionRow}
              onOpenReview={openReview}
              focusEvidenceId={route.evidenceId}
              focusQuote={route.quote}
              onSubjectTitle={onTitle}
            />
          )}
        </>
      )}
    </TabVisibilityProvider>
  )
}

/**
 * A `setup` route over a project that is no longer in setup.
 *
 * Reached only by a tab or a restored session that outlived the questionnaire —
 * while the project IS in setup, the guard above renders the form and this is
 * never asked for. It states what happened rather than redirecting on its own:
 * a tab that silently became a different screen is one the reader cannot
 * account for, and the work it describes did finish.
 */
function SetupFinished({
  projectId,
  onGo
}: {
  projectId: number
  onGo: () => void
}): JSX.Element {
  return (
    <div className="card empty-state" data-testid="setup-finished">
      <div className="empty-state-title">This project is ready.</div>
      <div className="empty-state-hint">Setup is done — there is nothing left to fill in here.</div>
      <button
        className="btn btn-primary"
        style={{ marginTop: 12 }}
        data-testid="setup-finished-go"
        disabled={projectId === 0}
        onClick={onGo}
      >
        Open the project
      </button>
    </div>
  )
}

/**
 * What this tab calls itself in the strip.
 *
 * Short, because a tab is at most a couple of dozen characters wide before it
 * truncates, and because the label has to distinguish this tab from its
 * siblings rather than describe the screen — which is what the topbar does. The
 * project is carried where several projects can be open at once, since "Papers"
 * three times over names nothing.
 */
function tabLabel(route: Route, project: ProjectDTO | null): string {
  const suffix = project ? ` · ${project.name}` : ''
  switch (route.name) {
    case 'projects':
      return 'Projects'
    case 'setup':
      return `Set up${suffix}`
    case 'schemas':
      return 'Schemas'
    case 'graph':
      return `Connectome${suffix}`
    case 'references':
      return `References${suffix}`
    case 'ranking':
      return `Ranking${suffix}`
    case 'ingest':
      return `Papers${suffix}`
    case 'extraction':
      return `Extraction${suffix}`
    case 'review':
      return `Review${suffix}`
    case 'dossier':
      return `Project context${suffix}`
    case 'integrations':
      return `Integrations${suffix}`
    case 'paper':
      // Named by its work id until the screen reports the real title: a paper tab
      // labelled just "Paper" is indistinguishable from every other paper tab,
      // which is the one thing a strip of them must not be.
      return route.workId === undefined ? 'Paper' : `Paper #${route.workId}`
    default:
      return 'Corpus Studio'
  }
}
