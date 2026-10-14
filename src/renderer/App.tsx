import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ProjectDTO } from '@shared/types'
import type { LlmStatusDTO } from '@shared/contract'
import logoUrl from './logo.png'
import { SettingsModal } from './components/SettingsModal'
import { LicencesModal } from './components/LicencesModal'
import { CloseGuardModal } from './components/CloseGuardModal'
import { WindowControls, WindowResizeGrips } from './components/WindowControls'
import { TabStrip } from './components/TabStrip'
import { HEAVY_LIVE_SET, HEAVY_ROUTES, TabPane } from './components/TabPane'
import { TabPaneScroll } from './components/TabPaneScroll'
import { useTabs } from './lib/useTabs'
import { useTabHistories } from './lib/useTabHistories'
import { PROJECT_LEVEL_ROUTES, type Route, type RouteName } from '@shared/nav'
import { isOutstandingFailure } from './lib/jobs'
import { TooltipHost } from './components/Tooltip'
import { SyncStatusIcon, SharedGlyph } from './components/SyncStatusIcon'
import type { SharedProjectDTO } from '@shared/contract'
// Stroked SVG marks from the design (Corpus.dc.html sidebar region). Each is
// 19x19, fill:none, stroke:currentColor so the active pill recolors the icon.
function Icon({ name }: { name: RouteName | 'allProjects' | 'settings' }): JSX.Element {
  const common = { width: 19, height: 19, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor' }
  switch (name) {
    case 'graph':
      return (
        <svg {...common} strokeWidth={1.6}>
          <circle cx="5" cy="6" r="2.3" />
          <circle cx="15" cy="5" r="2.3" />
          <circle cx="13" cy="15" r="2.3" />
          <path d="M7 7l6 6M7 6l6-1" />
        </svg>
      )
    case 'references':
      // A branching tree, drawn left-to-right like the screen itself: one
      // trunk node fanning into two, one of which forks again.
      return (
        <svg {...common} strokeWidth={1.6}>
          <circle cx="4" cy="10" r="1.8" />
          <circle cx="10.5" cy="5.5" r="1.8" />
          <circle cx="10.5" cy="14.5" r="1.8" />
          <circle cx="16.5" cy="14.5" r="1.8" />
          <path d="M5.6 9.2L8.9 6.3M5.6 10.8l3.3 2.9M12.3 14.5h2.4" />
        </svg>
      )
    case 'ranking':
      return (
        <svg {...common} strokeWidth={1.6}>
          <path d="M4 3v13.5h13" />
          <circle cx="8" cy="12" r="1.6" />
          <circle cx="12" cy="8" r="1.6" />
          <circle cx="15" cy="5.5" r="1.6" />
        </svg>
      )
    // Papers and Paper detail are the same subject, so they share one mark: the
    // document outline. `paper` has no sidebar item of its own any more.
    case 'ingest':
    case 'paper':
      return (
        <svg {...common} strokeWidth={1.6}>
          <rect x="4" y="2.5" width="12" height="15" rx="2" />
          <path d="M7 6.5h6M7 10h6M7 13.5h3.5" />
        </svg>
      )
    case 'schemas':
      // A stacked "definition" mark: a form outline with field rows.
      return (
        <svg {...common} strokeWidth={1.6}>
          <rect x="3.5" y="3.5" width="13" height="13" rx="1.8" />
          <path d="M6.5 7.5h7M6.5 10h7M6.5 12.5h4" />
        </svg>
      )
    case 'extraction':
      return (
        <svg {...common} strokeWidth={1.6}>
          <rect x="3" y="4" width="14" height="12" rx="1.6" />
          <path d="M3 8h14M8 8v8M12 8v8" />
        </svg>
      )
    case 'review':
      return (
        <svg {...common} strokeWidth={1.6}>
          <path d="M4 10.5l3.5 3.5L16 5.5" />
          <path d="M3 4.5h9" />
        </svg>
      )
    case 'dossier':
      return (
        <svg {...common} strokeWidth={1.6}>
          <path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H16v14H5.5A1.5 1.5 0 0 0 4 18.5z" />
          <path d="M8 3v14" />
        </svg>
      )
    case 'integrations':
      return (
        <svg {...common} strokeWidth={1.6}>
          <circle cx="7" cy="10" r="4.2" />
          <circle cx="13" cy="10" r="4.2" />
        </svg>
      )
    case 'allProjects':
      return (
        <svg {...common} strokeWidth={1.6}>
          <rect x="3" y="3" width="6" height="6" rx="1.5" />
          <rect x="11" y="3" width="6" height="6" rx="1.5" />
          <rect x="3" y="11" width="6" height="6" rx="1.5" />
          <rect x="11" y="11" width="6" height="6" rx="1.5" />
        </svg>
      )
    case 'settings':
      return (
        <svg
          width={19}
          height={19}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      )
    default:
      return <svg {...common} strokeWidth={1.6} />
  }
}

// In-project nav: design labels mapped to route names. testids stay keyed by
// ROUTE so the e2e contract (nav-graph, nav-ingest, …) keeps working even though
// the visible labels differ (Connectome=graph, Papers=ingest, etc.).
const IN_PROJECT_NAV: { route: RouteName; label: string }[] = [
  // Papers leads: it is the project's CONTENT. The Connectome, Ranking and
  // References are all views OVER that content, so they follow it.
  // NOTE: 'paper' is deliberately NOT here. Paper detail is not a destination
  // you pick, it is a paper you open — from the Connectome inspector, the
  // Ranking list, or the Papers list. The route is still reachable (openWork).
  { route: 'ingest', label: 'Papers' },
  { route: 'graph', label: 'Connectome' },
  { route: 'references', label: 'References' },
  { route: 'ranking', label: 'Ranking' },
  // NOTE: 'schemas' is deliberately NOT here. An extraction schema is a GLOBAL,
  // reusable definition shared by every project, so it lives one level up — in
  // the projects-level sidebar, next to "All projects". Inside a project the
  // user picks WHICH global schemas apply from the Extraction screen itself
  // (attach/detach), and Extraction links out to the global editor.
  { route: 'extraction', label: 'Extraction' },
  { route: 'review', label: 'Review' },
  { route: 'dossier', label: 'Project context' },
  { route: 'integrations', label: 'Integrations' }
]

// Per-route topbar copy. Density rule (ui-density-audit §1): the subtitle is
// ONLY carried where it adds information the screen does not already show.
// Every other route's subtitle restated its own title or the content directly
// below it, so it is empty — the topbar then renders the title alone.
function routeMeta(
  route: Route,
  project: ProjectDTO | null
): { title: string; subtitle: string } {
  const proj = project?.name ?? ''
  // A project still in its questionnaire shows the questionnaire whatever route
  // asked for it, so the topbar has to name THAT. Following the route named the
  // screen the guard declined to draw: a header reading "Literature Connectome
  // · 0 works" over a setup form describes a page that is not there, and the
  // "0 works" is a measurement of a corpus nobody has started.
  if (project?.setup_state === 'onboarding' && !PROJECT_LEVEL_ROUTES.has(route.name)) {
    return { title: 'Set up this project', subtitle: proj }
  }
  switch (route.name) {
    case 'projects':
      return { title: 'Projects', subtitle: '' }
    case 'setup':
      return { title: 'Set up this project', subtitle: proj }
    case 'graph':
      // The one kept subtitle: project name + total works. Neither is on the
      // graph canvas (the count there is "shown of total").
      return {
        title: 'Literature Connectome',
        subtitle: project ? `${proj} · ${project.work_count} works` : ''
      }
    case 'references':
      return { title: 'Reference Tree', subtitle: '' }
    case 'ranking':
      return { title: 'Relevance × Expansion', subtitle: '' }
    case 'ingest':
      return { title: 'Papers', subtitle: '' }
    case 'schemas':
      return { title: 'Extraction Schemas', subtitle: '' }
    case 'extraction':
      return { title: 'Measurements & Facts', subtitle: '' }
    case 'review':
      return { title: 'Review Queue', subtitle: '' }
    case 'dossier':
      return { title: 'Project Context', subtitle: '' }
    case 'integrations':
      return { title: 'Integrations', subtitle: '' }
    case 'paper':
      return { title: 'Paper Detail', subtitle: '' }
    default:
      return { title: 'Corpus Studio', subtitle: '' }
  }
}


/**
 * Do these two routes name the same page, at the same position within it?
 *
 * Compared field by field rather than by JSON, because key ORDER differs between
 * a route built by a screen and one that came back over IPC, and a JSON compare
 * would then report every tab as having moved on every render — an IPC call per
 * tab per render, forever.
 */
function sameRoute(a: Route, b: Route): boolean {
  if (a.name !== b.name) return false
  const x = a as Record<string, unknown>
  const y = b as Record<string, unknown>
  for (const k of ['workId', 'evidenceId', 'quote', 'rowKey', 'schemaId', 'factId']) {
    if (x[k] !== y[k]) return false
  }
  return true
}

/**
 * The window shell: a strip of open pages, and the pages themselves.
 *
 * The tab model lives in MAIN. This component MIRRORS it and never mutates its
 * own copy — see `useTabs` for why that is not merely cautious. What it does own
 * is everything below a tab: each pane's React subtree, each tab's navigation
 * history, and which panes are mounted at all.
 */
export default function App(): JSX.Element {
  const [projects, setProjects] = useState<ProjectDTO[]>([])
  const tabs = useTabs()
  const histories = useTabHistories()
  const [failedJobs, setFailedJobs] = useState(0)
  // Bumped by the Papers screen when it dismisses/restores a failed job, so the
  // sidebar badge updates without a route change.
  const [jobsNonce, setJobsNonce] = useState(0)
  const [llmStatus, setLlmStatus] = useState<LlmStatusDTO | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [licencesOpen, setLicencesOpen] = useState(false)

  const { tabs: tabList, activeKey, active } = tabs

  // Each tab's history is seeded from the tab main handed us, and dropped when
  // the tab goes. Seeding here rather than inside the pane keeps the stacks
  // alive across a suspend: a heavy tab that is unmounted to save memory must
  // come back with its trail intact, not at the top of it.
  useEffect(() => {
    for (const t of tabList) histories.ensure(t.key, { projectId: t.projectId, route: t.route })
    histories.prune(tabList.map((t) => t.key))
  }, [tabList, histories])

  /** Where a tab currently is: its own history if it has one, else the model. */
  const entryFor = useCallback(
    (key: string, fallback: { projectId: number | null; route: Route }) =>
      histories.get(key).current ?? fallback,
    [histories]
  )

  // Tell main where each tab has GOT to.
  //
  // The history stack is the renderer's, but main is what answers "is this page
  // already open in this window" and "did this tab's paper just get deleted".
  // Left un-reported, a tab opened on the Connectome and then steered to a paper
  // is still a Connectome tab as far as main knows: opening that paper would put
  // a SECOND tab on screen for the page the user is already reading, and
  // deleting it would strike through some other tab instead.
  //
  // Reconciled as a diff rather than pushed from `navigate`, because a tab moves
  // through back and forward too, and three call sites that must each remember
  // to report is three chances to forget. It converges: main answers with a push
  // and no rev bump, the next pass finds them equal and sends nothing.
  //
  // What was SENT is remembered, and a tab is not sent again for the same
  // destination. Comparing only against the model is not enough and produced a
  // live infinite loop: main NORMALISES an app-level route's `projectId` to
  // null, so a history entry of `{projects, projectId: 7}` came back as
  // `{projects, null}`, compared unequal, was re-sent, pushed, compared unequal
  // again — one IPC pair per microtask, forever, pinning a core. A refusal (a
  // project-scoped route with no project) has the same shape and is likewise
  // sent once rather than on every render.
  const sentRouteRef = useRef(new Map<string, string>())
  useEffect(() => {
    const sent = sentRouteRef.current
    for (const t of tabList) {
      const cur = histories.get(t.key).current
      if (!cur) continue
      if (cur.projectId === t.projectId && sameRoute(cur.route, t.route)) {
        // Agreed. Forgetting here is what lets the tab be re-sent if it later
        // navigates back to a destination it has been at before.
        sent.delete(t.key)
        continue
      }
      const want = JSON.stringify([cur.projectId, cur.route])
      if (sent.get(t.key) === want) continue
      sent.set(t.key, want)
      void window.api.tabsSetRoute({
        key: t.key,
        route: cur.route,
        projectId: cur.projectId
      })
    }
    // Tabs that have gone must not hold an entry: the map would otherwise grow
    // for the life of the window.
    for (const key of [...sent.keys()]) {
      if (!tabList.some((t) => t.key === key)) sent.delete(key)
    }
  }, [tabList, histories])

  const activeHistory = histories.get(activeKey)
  const activeEntry = active ? entryFor(activeKey, active) : null
  const projectId = activeEntry?.projectId ?? null
  const route: Route = activeEntry?.route ?? { name: 'projects' }

  /**
   * Re-read the project list.
   *
   * The shell needs this to be CURRENT, not merely loaded once: it is what
   * `TabPane` reads a project's `setup_state` from, so a list fixed at mount
   * would show a project created five seconds ago as absent — and a project
   * whose setup just finished as still in setup, which is a trap with no exit.
   *
   * A caller that has just been HANDED a row passes it, and the shell adopts it
   * before the re-read is asked for. Waiting for the round trip is what left a
   * newly created project's sidebar reading "Project" and its nav drawn as if
   * setup were finished: creating one navigates straight into it, so the shell
   * draws the project it does not yet have a row for, behind every request the
   * project's own screens make on their first render.
   */
  const reloadProjects = useCallback((created?: ProjectDTO): void => {
    if (created) {
      setProjects((prev) =>
        prev.some((p) => p.id === created.id)
          ? prev.map((p) => (p.id === created.id ? created : p))
          : [...prev, created]
      )
    }
    window.api
      .listProjects()
      .then(setProjects)
      .catch(() => {
        /* Projects screen surfaces its own error */
      })
  }, [])

  useEffect(() => reloadProjects(), [reloadProjects])

  // A project the shell has never heard of is one created since the last read —
  // and the shell must know whether it is still being set up BEFORE it draws a
  // screen for it.
  useEffect(() => {
    if (projectId !== null && !projects.some((p) => p.id === projectId)) reloadProjects()
  }, [projectId, projects, reloadProjects])

  // WHICH provider will answer — distinct from the model SELECTION, which is
  // only a preference. Resolved by a pre-flight against the gateway.
  //
  // READ ONCE AND SUBSCRIBED, because it DOES change under a running session:
  // main re-probes on a timer, so an app launched during an outage learns that
  // the network came back. Reading only at mount is what left this pill saying
  // "no model" at a healthy gateway for the rest of the session.
  useEffect(() => {
    let alive = true
    window.api
      .getLlmStatus()
      .then((s) => {
        if (alive) setLlmStatus(s)
      })
      .catch(() => {
        /* Left null, which renders NOTHING rather than a reassuring "live".
           Failing closed the other way would be the exact falsehood this
           indicator exists to prevent. */
      })
    const off = window.api.onLlmStatusChanged((s) => {
      if (alive) setLlmStatus(s)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  // A re-probe the USER asked for, for the moment they have just fixed
  // something and want to know now rather than at the next tick. In flight it
  // must look busy: a button that silently does nothing for a second reads as
  // broken, and this one can legitimately take the gateway's full timeout.
  const [recheckBusy, setRecheckBusy] = useState(false)
  const recheckLlm = useCallback(() => {
    if (recheckBusy) return
    setRecheckBusy(true)
    window.api
      .recheckLlmStatus()
      .then((s) => setLlmStatus(s))
      .catch(() => {
        /* The push from main is the authority; a failed request leaves the last
           known status alone rather than inventing a worse one. */
      })
      .finally(() => setRecheckBusy(false))
  }, [recheckBusy])

  // Failed-processing-job count for the "Papers" sidebar badge. Best-effort:
  // if the API is unavailable the badge is simply omitted (never hardcoded).
  useEffect(() => {
    if (projectId === null) {
      setFailedJobs(0)
      return
    }
    let alive = true
    // The SAME predicate the project card's SQL uses: a failure that has been
    // dismissed has been acknowledged and no longer counts as outstanding.
    window.api
      .listJobs(projectId)
      .then((jobs) => {
        if (!alive) return
        // PAPERS, not jobs — the same count the Papers screen's own badge shows.
        // A paper whose download failed also carries a failed extract, segment
        // and embed behind it, so counting jobs put "38" beside a twenty-paper
        // project: a number larger than the corpus, disagreeing with the queue
        // it sends the user to.
        const works = new Set<number>()
        let corpus = 0
        for (const j of jobs) {
          if (!isOutstandingFailure(j)) continue
          if (j.work_id === null) corpus++
          else works.add(j.work_id)
        }
        setFailedJobs(works.size + corpus)
      })
      .catch(() => {
        if (alive) setFailedJobs(0)
      })
    return () => {
      alive = false
    }
  }, [projectId, route, jobsNonce])

  /**
   * The shared projects this install has, or an empty list.
   *
   * Empty is the ordinary answer on a fresh install and on every install that
   * has never turned the plugin on, and it renders nothing — no icon, no chrome,
   * no placeholder. Read through `window.api` like everything else, and pushed
   * from main rather than polled: the sync state moves on a timer over there,
   * and a second timer here would race it.
   */
  const [shares, setShares] = useState<SharedProjectDTO[]>([])
  /**
   * True when the last read of that list THREW.
   *
   * An empty list and a failed read are not the same answer, and collapsing
   * them here was the worse of the two: the sharing chrome, the relay's name
   * and the sync indicator all disappear, so a project that is still syncing
   * with other people looks exactly like a private one. `[]` remains what is
   * rendered — inventing a share would be the opposite mistake — but the
   * sidebar says the state could not be read rather than saying nothing.
   */
  const [sharesUnread, setSharesUnread] = useState(false)
  useEffect(() => {
    let alive = true
    const read = (): void => {
      void window.api
        .listShares()
        .then((s) => {
          if (!alive) return
          setShares(s)
          setSharesUnread(false)
        })
        .catch(() => {
          if (!alive) return
          setShares([])
          setSharesUnread(true)
        })
    }
    read()
    const off = window.api.onSharesChanged(read)
    return () => {
      alive = false
      off()
    }
  }, [])
  const activeShare = shares.find((s) => s.projectId === projectId) ?? null

  /**
   * Navigate the ACTIVE tab.
   *
   * A navigation stays inside the tab it was made from — it does not open a new
   * one. Following a link inside a paper is the same movement it always was; a
   * new tab is something the user asks for with a modifier or from the strip.
   * The one exception is a route that has its own identity as a page (a
   * different paper), which still moves within the tab: the alternative is a
   * tab per click, which is how a strip becomes unusable in a minute.
   */
  const navigateActive = useCallback(
    (next: Route, pid?: number | null) => {
      if (!activeKey) return
      histories.navigate(activeKey, {
        // Undefined means "wherever this tab already is" — every navigation
        // stays in the same project unless it says otherwise. NORMALISED the
        // same way main normalises it, so the two never disagree about a
        // project-level route: `projects` and `schemas` are app-level and show
        // the same thing whichever project is open, so carrying one would be a
        // difference with no meaning that the reconciler would try forever to
        // resolve.
        projectId: PROJECT_LEVEL_ROUTES.has(next.name) ? null : pid === undefined ? projectId : pid,
        route: next
      })
    },
    [activeKey, histories, projectId]
  )

  /**
   * Open a page as its OWN tab, focusing the tab that already shows it.
   *
   * The dedupe is main's, and it is per WINDOW deliberately: a sibling window
   * holding the same page is reported, not focused, because two windows exist
   * precisely so the user can read one page beside another, and yanking focus to
   * a different monitor is the worst thing a click can do.
   */
  const openInTab = useCallback(
    (next: Route, pid: number | null, forceNew = false) => {
      void tabs.open(next, pid, { forceNew })
    },
    [tabs]
  )

  const go = (name: RouteName): void => navigateActive({ name } as Route)
  const openProject = (id: number): void => navigateActive({ name: 'graph' }, id)
  const backToProjects = (): void => navigateActive({ name: 'projects' }, null)

  /**
   * Which tabs are MOUNTED.
   *
   * Cheap tabs all stay: their cost is DOM and a few rows, and suspending one
   * would buy nothing while costing the user a refetch. Heavy tabs — the paper
   * viewer, the Connectome, the reference tree — are capped at a small live set,
   * because each holds rasterized canvases or a running canvas scheduler, and a
   * dozen of them exhausts video memory. Exhaustion is the reason the cap is not
   * a nicety: a canvas that fails to allocate renders BLANK rather than
   * throwing, so the failure would reach the user as a paper with no pages and
   * no explanation.
   */
  //
  // Recency is COMMITTED STATE advanced by an effect, not a ref rewritten during
  // render. The first version reordered a ref inside a `useMemo`, which is a
  // render-phase side effect: a render React discards — a StrictMode double
  // pass, an interrupted transition — still reordered it, so a pane the user was
  // using could be evicted on the strength of a render that never happened.
  //
  // It is keyed on ACTIVATION alone, deliberately. Recomputing recency from the
  // whole tab list would let an unrelated change (a title arriving, a sibling
  // opening) reshuffle the order and unmount a paper behind the user's back.
  const [heavyRecency, setHeavyRecency] = useState<string[]>([])
  useEffect(() => {
    if (!activeKey) return
    setHeavyRecency((prev) => {
      if (prev[0] === activeKey) return prev
      return [activeKey, ...prev.filter((k) => k !== activeKey)]
    })
  }, [activeKey])

  const mounted = useMemo(() => {
    const keys = new Set<string>()
    const heavyOpen: string[] = []
    for (const t of tabList) {
      const r = entryFor(t.key, t).route
      if (HEAVY_ROUTES.has(r.name)) heavyOpen.push(t.key)
      else keys.add(t.key)
    }
    // Most-recently-active first; anything never activated (so, never seen)
    // takes the remaining places in the order it appears in the strip.
    const order = heavyRecency.filter((k) => heavyOpen.includes(k))
    for (const k of heavyOpen) if (!order.includes(k)) order.push(k)
    // The active tab is live whatever the ordering says: unmounting what the
    // user is looking at is the one outcome that is always wrong, and the effect
    // above has not necessarily run yet on the render that first shows it.
    const liveHeavy = new Set<string>()
    if (heavyOpen.includes(activeKey)) liveHeavy.add(activeKey)
    for (const k of order) {
      if (liveHeavy.size >= HEAVY_LIVE_SET) break
      liveHeavy.add(k)
    }
    for (const k of liveHeavy) keys.add(k)
    return keys
  }, [tabList, activeKey, entryFor, heavyRecency])

  const activeProject = projects.find((p) => p.id === projectId) ?? null
  const inProject = projectId !== null
  const meta = routeMeta(route, activeProject)

  // Alt+Arrow and the mouse's dedicated back/forward buttons, matching what
  // every browser and file manager already trains users to expect. ONE listener
  // for the window, dispatching to the ACTIVE tab's history — a listener per
  // mounted pane would have every open tab walk its own history at once.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        if (e.key === 'ArrowLeft') {
          e.preventDefault()
          histories.back(activeKey)
        } else if (e.key === 'ArrowRight') {
          e.preventDefault()
          histories.forward(activeKey)
        }
        return
      }
      if (!e.ctrlKey && !e.metaKey) return
      const i = tabList.findIndex((t) => t.key === activeKey)
      if (e.key === 'Tab') {
        if (tabList.length < 2) return
        e.preventDefault()
        const step = e.shiftKey ? -1 : 1
        // Wraps, like every browser: reaching the last tab and being told "no
        // more" is a dead end in a cycle the user expects to be one.
        const n = tabList.length
        void tabs.activate(tabList[(i + step + n) % n].key)
        return
      }
      if (e.key === 'PageDown' || e.key === 'PageUp') {
        if (tabList.length < 2) return
        e.preventDefault()
        const step = e.key === 'PageDown' ? 1 : -1
        const n = tabList.length
        void tabs.activate(tabList[(i + step + n) % n].key)
        return
      }
      if (e.key.toLowerCase() === 'w') {
        e.preventDefault()
        // On the LAST tab this closes the window, not the tab: main refuses to
        // remove the last one (a window always shows something), so without this
        // the shortcut would simply do nothing and look broken.
        if (tabList.length <= 1) void window.api.window.close()
        else void tabs.close(activeKey)
        return
      }
      if (e.key >= '1' && e.key <= '9') {
        // 9 is LAST, not the ninth — the convention every browser uses, and the
        // only one that is useful once there are more than nine tabs.
        const n = e.key === '9' ? tabList.length - 1 : Number(e.key) - 1
        const t = tabList[n]
        if (!t) return
        e.preventDefault()
        void tabs.activate(t.key)
      }
    }
    const onMouse = (e: MouseEvent): void => {
      if (e.button === 3) histories.back(activeKey)
      else if (e.button === 4) histories.forward(activeKey)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mouseup', onMouse)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mouseup', onMouse)
    }
  }, [activeKey, tabList, histories, tabs])

  /**
   * Is this project still being set up?
   *
   * While it is, none of its own screens exist to go to — they read rows the
   * project has not got yet — so the nav is drawn and inert. Drawn, rather than
   * hidden, because the shape of the app is what tells a first-time user what
   * finishing the form will give them; each item then says why it is not
   * available yet, per the rule that a disabled control explains itself.
   */
  const setupLocked = activeProject?.setup_state === 'onboarding'

  const navItem = (route_: RouteName, label: string, extra?: ReactNode): JSX.Element => {
    // The sidebar's "you are here" follows the ACTIVE TAB's route, not the
    // window's: with several tabs open there is no such thing as the window's
    // route, and two competing here-markers that disagree is worse than none.
    const isActive = route.name === route_
    if (setupLocked) {
      return (
        <button
          key={route_}
          type="button"
          data-testid={`nav-${route_}`}
          className="side-nav-item is-setup-locked"
          disabled
          data-tip={`Finish setting up this project to use ${label}.`}
        >
          <Icon name={route_} />
          <span className="side-nav-label">{label}</span>
          {/* The extra is DROPPED: those badges count failures and queues over a
              corpus that does not exist yet, and a stale number beside a dead
              control is a claim about a project nothing has read. */}
        </button>
      )
    }
    return (
      <button
        key={route_}
        data-testid={`nav-${route_}`}
        className={`side-nav-item ${isActive ? 'active' : ''}`}
        // Ctrl/Cmd-click opens the destination as its OWN tab instead of moving
        // this one, matching what every browser has trained the user to expect
        // from a modifier on a navigation. A middle-click does the same, and is
        // handled through `onAuxClick` because a plain `onClick` never sees it.
        onClick={(e) => {
          if (e.ctrlKey || e.metaKey) openInTab({ name: route_ } as Route, projectId, e.shiftKey)
          else go(route_)
        }}
        onAuxClick={(e) => {
          if (e.button !== 1) return
          e.preventDefault()
          openInTab({ name: route_ } as Route, projectId)
        }}
      >
        <Icon name={route_} />
        <span className="side-nav-label">{label}</span>
        {extra}
      </button>
    )
  }

  return (
    <div className="app-shell">
      <aside className="sidebar" data-testid="sidebar">
        {/* Also a drag region: gives the frameless window a second, generous
            grab area (the app name block), like an OS title bar's left side. */}
        <div className="sidebar-head">
          <img className="sidebar-logo" src={logoUrl} alt="Corpus Studio" />
          <div className="sidebar-word">Corpus Studio</div>
        </div>

        <div className="sidebar-nav">
          {inProject ? (
            <>
              <button
                className="side-nav-item side-back"
                data-testid="nav-projects"
                onClick={backToProjects}
              >
                <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.9}>
                  <path d="M12 5l-5 5 5 5" />
                </svg>
                <span className="side-nav-label side-back-label">Back to projects</span>
              </button>
              <div className="side-project-eyebrow" data-tip={activeProject?.name}>
                {activeProject?.name ?? 'Project'}
              </div>
              {/* WHY the nav below it is dead. Eleven tooltips each say it for
                  one item; this says it once, where the reader looks after the
                  first item does not respond. */}
              {setupLocked && (
                <div className="side-project-setup" data-testid="nav-setup-locked">
                  Being set up
                </div>
              )}
              {/* Persistent chrome, not a chip: a shared project IS shared, the
                  way it has a name. The chips are spent on the exceptions, which
                  the status icon in the foot carries. */}
              {activeShare && (
                <div
                  className="side-project-shared"
                  // FOCUSABLE because it carries a `data-tip`, and the tooltip is
                  // delegated off `focusin` as well as `pointerover`. Without it
                  // the one place that names the relay is mouse-only, while every
                  // other tipped surface in this feature is reachable by tab.
                  //
                  // And an `aria-label` with it, per the contract `Tooltip.tsx`
                  // states: `data-tip` is not announced, so the relay's name
                  // would reach a sighted keyboard user and nobody else — a tab
                  // stop that costs a screen-reader user a keystroke and tells
                  // them only what the visible text already said. No `role`: a
                  // focusable div with a label is the honest encoding, `note` is
                  // not in ARIA 1.2, and `status` would announce on every
                  // project switch.
                  tabIndex={0}
                  aria-label={
                    activeShare.relayLabel
                      ? `Shared through ${activeShare.relayLabel}`
                      : 'Shared'
                  }
                  data-tip={activeShare.relayLabel ?? 'Shared'}
                >
                  <SharedGlyph />
                  Shared
                </div>
              )}
              {/* The one case where silence would be a claim: with no answer,
                  "not shared" is a guess, so the row says so instead. */}
              {sharesUnread && (
                <div
                  className="side-project-shared is-unknown"
                  data-testid="shares-unreadable"
                  tabIndex={0}
                  role="alert"
                  aria-label="Sharing state unknown — it could not be read"
                  data-tip="Whether this project is shared could not be read just now. If it is shared, it may still be syncing. Reopen the project to try again."
                >
                  <svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M10 2.6L18 16.6H2z" />
                    <path d="M10 8v3.6" />
                    <path d="M10 14.1v.1" />
                  </svg>
                  Sharing unknown
                </div>
              )}
              {IN_PROJECT_NAV.map((n) =>
                n.route === 'ingest'
                  ? navItem(
                      n.route,
                      n.label,
                      failedJobs > 0 ? (
                        <span className="side-nav-badge" data-testid="nav-ingest-badge">
                          <span className="side-nav-badge-dot" />
                          {failedJobs}
                        </span>
                      ) : undefined
                    )
                  : navItem(n.route, n.label)
              )}
            </>
          ) : (
            <>
              <button
                className={`side-nav-item ${route.name === 'projects' ? 'active' : ''}`}
                data-testid="nav-projects"
                onClick={() => go('projects')}
              >
                <Icon name="allProjects" />
                <span className="side-nav-label">All projects</span>
              </button>
              {/* Schemas is an APP-LEVEL surface: one definition list shared by
                  every project. It sits here (not in the in-project nav) so the
                  hierarchy tells the truth — editing a schema here changes it
                  for every project that uses it. */}
              {navItem('schemas', 'Schemas')}
            </>
          )}
        </div>

        <div className="sidebar-foot">
          {/* ABOVE Settings, and only inside a shared project: it reports on the
              project the user is looking at, so it belongs next to that project's
              chrome rather than in the app-level row. */}
          {inProject && activeShare && <SyncStatusIcon share={activeShare} />}
          <button
            className="side-nav-item side-settings"
            data-testid="nav-integrations-settings"
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen(true)}
          >
            <Icon name="settings" />
            <span className="side-nav-label">Settings</span>
          </button>
        </div>
      </aside>

      <div className="content-col">
        {/* THE WINDOW'S TITLE BAR. The window is frameless, so this row carries
            the tabs, the min/max/close controls at its right end, and between
            them a bare rectangle that is a drag region — dragging the empty
            space behind the tabs moves the window, and double-clicking it
            toggles maximize (handled by the browser process, not by us).

            The drag region is a SIBLING of the scrolling tab list, never its
            ancestor: see the note at the top of `styles/tabs.css`. */}
        <TabStrip
          trailing={<WindowControls />}
          tabs={tabList}
          activeKey={activeKey}
          onActivate={(k) => void tabs.activate(k)}
          onClose={(k) => void tabs.close(k)}
          onReorder={(k) => void tabs.reorder(k)}
          onDetach={(k, x, y) => void tabs.detach(k, x, y)}
          // Detach is always OFFERED here. The real limits — eight windows, and
          // no faster than one every 250ms — are enforced in main, which is the
          // only thing that can count windows; a renderer cannot see its siblings
          // and must not be handed a number about them. A refusal comes back as
          // `false`, and the tab simply stays where it is.
          detachBudget={1}
          // A new tab opens on the page a new window opens on. With a project
          // open that is its Papers list — the project's content, and where the
          // in-project nav starts — and without one it is the dashboard, which
          // is the only thing there is to show.
          // On a FRESH INSTALL there are no projects, so the only page a new
          // tab could show is the dashboard — which is already the tab they are
          // looking at. Disabled with the reason, rather than opening a second
          // identical Projects tab and leaving the user to work out why.
          newTabDisabledReason={
            projectId === null && projects.length === 0
              ? 'Create a project first — there is nothing else to open yet'
              : undefined
          }
          onNewTab={() =>
            openInTab(
              projectId === null ? { name: 'projects' } : { name: 'ingest' },
              projectId,
              // Forced, because otherwise pressing "+" while already on that
              // page would focus the tab the user pressed it FROM and read as
              // the button doing nothing at all.
              true
            )
          }
        />

        <header className="topbar" data-testid="topbar">
          <div className="topbar-nav">
            <button
              type="button"
              className="topbar-nav-btn"
              data-testid="nav-back"
              aria-label="Back"
              data-tip="Back"
              disabled={!activeHistory.canGoBack}
              onClick={() => histories.back(activeKey)}
            >
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 4l-6 6 6 6" />
              </svg>
            </button>
            <button
              type="button"
              className="topbar-nav-btn"
              data-testid="nav-forward"
              aria-label="Forward"
              data-tip="Forward"
              disabled={!activeHistory.canGoForward}
              onClick={() => histories.forward(activeKey)}
            >
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 4l6 6-6 6" />
              </svg>
            </button>
          </div>

          <div className="topbar-titles">
            <div className="topbar-title" data-testid="topbar-title">
              {meta.title}
            </div>
            {meta.subtitle && <div className="topbar-sub mono">{meta.subtitle}</div>}
          </div>

          {/* No search box here: corpus search lives on the Papers screen, the
              one place for everything paper-related. */}
          <div className="topbar-right">
            {/* Shown ONLY when no model can be reached, and shown in the app
                chrome rather than behind a disclosure.

                It no longer warns about what the user is READING — nothing is
                produced without a model any more, so there are no substituted
                answers to warn about. It warns about what they cannot DO: any
                analysis started now will be declined, with a reason. An
                asymmetric indicator is deliberate: a working gateway needs no
                notice, and a pill that is always present stops being read. */}
            {llmStatus && !llmStatus.live && (
              // A BUTTON, not a label. The app re-probes on its own, but the
              // person who just fixed their network is the one who knows it is
              // worth looking again — and a dead-looking pill was previously
              // the only thing an app that would never re-check showed them.
              <button
                type="button"
                className="topbar-llm mono"
                data-testid="topbar-llm-unavailable"
                onClick={recheckLlm}
                disabled={recheckBusy}
                aria-busy={recheckBusy}
                aria-label={
                  recheckBusy
                    ? 'Checking whether a model can be reached'
                    : `No model can be reached, so new analyses cannot run: ${llmStatus.reason}. Check again.`
                }
                data-tip={
                  recheckBusy ? 'Checking…' : `${llmStatus.reason} — click to check again`
                }
              >
                <span className="topbar-llm-glyph" aria-hidden="true">
                  {recheckBusy ? '◌' : '⊘'}
                </span>
                {recheckBusy ? 'checking…' : 'no model'}
              </button>
            )}
          </div>
        </header>

        <main className="route-area" data-testid="route-area">
          {/* A window with NO tabs. Reachable exactly one way: the user dragged
              its last tab out into a window of its own. It stays open — they
              moved a page, they did not ask to quit — so it needs somewhere to
              start from rather than an empty grey rectangle that looks broken. */}
          {tabList.length === 0 && (
            <div className="card empty-state" data-testid="no-tabs">
              <div className="empty-state-title">Nothing open in this window.</div>
              <div className="empty-state-hint">
                Its last page was moved to a window of its own.
              </div>
              <button
                className="btn btn-primary"
                style={{ marginTop: 12 }}
                onClick={() => openInTab({ name: 'projects' }, null, true)}
              >
                Open projects
              </button>
            </div>
          )}
          {tabList.map((t) => {
            if (!mounted.has(t.key)) return null
            const entry = entryFor(t.key, t)
            const visible = t.key === activeKey
            return (
              <div
                key={t.key}
                className={`tab-pane ${visible ? 'is-visible' : ''}`}
                // `visibility: hidden` + `position: absolute`, NOT
                // `display: none` (see tabs.css): a hidden canvas screen's
                // ResizeObserver reports 0x0 under `display:none` and tears its
                // scaffold down, so returning to it would rebuild the whole
                // layout instead of showing what the user left.
                aria-hidden={!visible}
                // A hidden pane must be out of the tab ORDER too: without this
                // a Tab press walks into controls the user cannot see, and the
                // focus ring goes somewhere off screen.
                {...(visible ? {} : { inert: '' })}
              >
                <TabPaneScroll
                  viewState={t.viewState ?? null}
                  onViewState={(v) => tabs.setViewState(t.key, v)}
                  visible={visible}
                >
                <TabPane
                  route={entry.route}
                  projectId={entry.projectId}
                  projects={projects}
                  visible={visible}
                  focusNonce={t.focusNonce}
                  navigate={(r, pid) => {
                    histories.navigate(t.key, {
                      // Normalised as main does — see `navigateActive`.
                      projectId: PROJECT_LEVEL_ROUTES.has(r.name)
                        ? null
                        : pid === undefined
                          ? entry.projectId
                          : pid,
                      route: r
                    })
                  }}
                  onTitle={(title) => void window.api.tabsSetTitle({ key: t.key, title })}
                  onFailedCountChanged={() => setJobsNonce((n) => n + 1)}
                  onProjectsChanged={reloadProjects}
                />
                </TabPaneScroll>
              </div>
            )
          })}
        </main>
      </div>

      {settingsOpen && (
        <SettingsModal
          project={activeProject ? { id: activeProject.id, name: activeProject.name } : null}
          // Settings closes as the licences modal opens: two stacked dialogs
          // would trap focus in the wrong one, and Escape would then dismiss
          // the layer the reader is not looking at.
          onOpenLicences={() => {
            setSettingsOpen(false)
            setLicencesOpen(true)
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {licencesOpen && <LicencesModal onClose={() => setLicencesOpen(false)} />}

      {/* Asked only when closing would throw away a paper mid-analysis; renders
          nothing at all otherwise. Driven entirely by main, which is holding the
          close open while it waits for the answer. */}
      <CloseGuardModal />

      {/* Frameless windows have no WM resize border on X11 — the app paints its
          own edge/corner grips (position:fixed, outside the flex flow, so the
          full-bleed height math is untouched). */}
      <WindowResizeGrips />

      {/* ONE delegated tooltip for the whole app: it adopts any `data-tip` or
          `title` in the tree, so every existing hint gains the app's own bubble
          without per-call-site wiring. */}
      <TooltipHost />
    </div>
  )
}
