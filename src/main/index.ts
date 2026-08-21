import { app, BrowserWindow, session, ipcMain, shell, dialog, screen, Menu, safeStorage } from 'electron'
import { devLogStatus, setDevLogEnabled } from './devlog'

/** `setting` table key holding the developer-log flag ('1' / '0'). */
const DEV_LOG_SETTING_KEY = 'dev_log_enabled'
import { existsSync } from 'node:fs'
import type { UpdaterService } from './updater'
import { readPackagedFeed, describeUpdateError } from './updater'
import { join, resolve, sep, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdirSync } from 'node:fs'
import { readFile, realpath, access, readdir, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { initDatabase, setDb, getDb, closeDb } from './db/connection'
import { SqliteVecUnavailableError } from './db/sqliteVec'
import { DatabaseLockedError } from './db/lock'
import { defaultDbPath } from './db/paths'
import { readArchive, readArchiveManifest } from './project-archive/read'
import { restoreProjectArchive } from './project-archive/restore'
import { ArchiveIncompleteError } from './project-archive/build'
import { sweepVectorOrphans, unindexedChunks } from './embedding/vectors'
import { appIconPath, isPackaged, missingRequiredPayloads } from './resources'

/**
 * A build that was shipped without a component it was required to carry.
 *
 * Its own type, so the startup error dialog can tell the user their INSTALL is
 * incomplete rather than that their database could not be opened — the generic
 * branch would have sent someone to inspect a perfectly healthy corpus.
 */
class MissingPayloadError extends Error {}
import {
  getProject,
  getExtractionRows,
  listProjectSchemas,
  listFrontiers,
  saveFrontier,
  readOcrWordBoxes,
  resolvePdfPath,
  listModels,
  getSelectedModel,
  setSelectedModel,
  getSetting,
  setSetting,
  getWork
} from './db/repositories'
import {
  BASE_DIR_KINDS,
  addBaseDir,
  listBaseDirs,
  removeBaseDir,
  updateBaseDir
} from './db/repos/baseDirs'
import {
  buildExport,
  listExportOptions
} from './export/registry'
import { revealExport, saveArtifact } from './export/writeFile'
import {
  applySettingsFile,
  buildSettingsFile,
  closeSettingsFile,
  exportableItems,
  readSettingsFile
} from './settings-transfer'
import {
  readCollectionMap,
  readOutletSettings,
  readZoteroConnection,
  writeCollectionMap,
  writeZoteroConnection
} from './outlets/settings'
import {
  buildProjectNotes
} from './outlets/obsidian/build'
import { resolveVaultTarget } from './outlets/obsidian/vault'
import { listCollectionItems, listCollections } from './outlets/zotero/library'
import { importItems } from './outlets/zotero/import'
import { renderZoteroRdf } from './outlets/zotero/rdf'
import { planAttachments } from './outlets/zotero/attachments'
import { zip } from './export/serialize/zip'
import { buildCombinedExtractionTable } from './export/data/extractionTable'
import { zoteroDir } from './outlets/zotero'
import { ping as zoteroPing, listTargets as listZoteroTargets } from './outlets/zotero/connector'
import { startAutoMirror } from './outlets/autoMirror'
import { listLicences, getLicenceText } from './licences'
import { setVectorDbPath, getVectorSearch, dropVectorSearch } from './search/current'

import type {
  ArchiveInfoDTO,
  ImportResultDTO,
  UpdateStateDTO,
  PdfReadResult,
  PdfUnavailableReason
} from '../shared/contract'
import { selectProvider, GatewayUnavailableError } from './llm/select'
import { gatewayConfigForUi, saveGatewayConfig } from './llm/gateway'
import {
  summaryPromptDto,
  writeOverride as writeSummaryPromptOverride
} from './llm/summaryPrompts'
import { JobQueue, setJobQueue, getJobQueue } from './pipeline/scheduler'
import { applyQueueSettings } from './pipeline/queueSettings'
import { planUnplannedProjectWorks } from './pipeline/plan-missing'
import { HostPool } from './pipeline/host/pool'
import {
  busyCount
} from './busy'
import {
  setBroadcastSink,
  broadcastJobsChanged,
  flushPendingBroadcast
} from './broadcast'
import {
  getLlmProvider,
  getLlmSelection,
  setLlmSelection,
  onLlmSelectionChanged,
  llmStatusNow
} from './llm/current'
import { startLlmWatch, stopLlmWatch, refreshLlmSelection } from './llm/watch'
import { setTokenLedgerDb } from './llm/tokenLedger'
import { mcpInFlightTotal, noteQuitIntent, startMcpIfEnabled, stopMcpForQuit } from './mcp'
import { registerMcpIpc } from './mcp/ipc'
import { redactSecrets } from './mcp/auth'
import {
  dropPendingAdoption,
  getTabModel,
  notePendingAdoption,
  setDetachHandler,
  setTabPush
} from './tabs-service'
import { DETACH_LEASE_MS } from './tabs'
import { parseTabKey } from '../shared/tabKey'
import { TABS_SESSION_KEY, captureSession, parseSession, restoreWindow } from './tabs-session'
import type { SessionRead } from './tabs-session'
import { ENTRIES } from './ipc/registry'
import {
  installCloseGuard,
  guardWindow,
  quitState,
  decideQuit,
  refreshQuitState,
  onQuitIntentChange,
  setQuitFlush
} from './closeGuard'
import { listStageRuns } from './db/repos/stageRuns'
import { getTokenUsage } from './db/repos/tokenUsage'
import {
  initPluginHost,
  listPlugins,
  setPluginEnabled,
  configurePlugin,
  testPluginConnection,
  runPluginSetup,
  pluginCtx,
  startEnabledPlugins,
  stopPluginsForQuit,
  pluginsInFlightCount,
  pluginVerb,
  pluginActingVerb,
  pluginsWithCapability,
  enabledPluginsWithCapability,
  shapeSentence,
  shapeLabel,
  shapeCode,
  shapeIso,
  shapeRunState,
  runPluginTickNow,
  installPlugin,
  updatePlugin,
  removePlugin,
  restorePlugin
} from './plugins/host'
import {
  repositoryForUi,
  testRepository,
  connectRepository,
  disconnectRepository,
  syncRepositoryNow,
  startRepositorySchedule,
  stopRepositorySchedule
} from './plugins/repository'
import { isRepositorySupplied } from './plugins/source'
import type {
  SharedProjectDTO,
  ShareResultDTO,
  PluginInstallResultDTO,
  SyncNowResultDTO
} from '@shared/contract'
import { SHARING_OFF_SENTENCE, SHARING_UNREADABLE_SENTENCE } from '@shared/contract/plugins'
import { ManifestError as PluginManifestError } from './plugins/manifest'

/**
 * The sharing verbs are reached through the plugin host BY CAPABILITY, never
 * imported and never by a hard-coded id.
 *
 * A direct import would compile the plugin into the application, and "plugins
 * are folders" would be untrue for the one plugin that exists: the app could
 * load it from nowhere else, and deleting the folder would fail the BUILD
 * rather than degrade at runtime.
 *
 * The ID IS RESOLVED AT CALL TIME from `project-sharing`, which is the same
 * question the renderer's entry point is gated on. Naming one id here made the
 * two disagree: a second sharing plugin — or the in-tree one renamed — lit the
 * entry point and was then refused by every call, with a sentence telling the
 * user to enable a plugin they had never installed.
 *
 * ONE at a time, and the ENABLED one wins. Two plugins syncing the same project
 * through two relays would each keep overwriting the other's `updatedAt` merge,
 * so this is a genuine conflict rather than a routing choice — but only an
 * enabled plugin can do anything at all, so the ambiguity is real only when the
 * user has switched two on, and then it is theirs to resolve.
 */
/**
 * The closed set of sentences the viewer may show in place of a PDF.
 *
 * Written HERE rather than in the renderer so the reason and the words for it
 * cannot drift apart, and so nothing derived from the filesystem — an errno
 * string, or the path, which contains the OS username — can reach the screen.
 * Each one names the remedy, because "not available" was the whole defect.
 */
const PDF_UNAVAILABLE_SENTENCE: Record<PdfUnavailableReason, string> = {
  none: 'No PDF has been added for this paper — only its record is stored.',
  missing:
    'The PDF for this paper is not where the library recorded it. '
    + 'It may have been moved or deleted, or the drive holding it may not be connected.',
  unreadable:
    'The PDF for this paper could not be read. '
    + 'Check that you have permission to open it and that the file is not damaged.',
  rejected:
    'The PDF for this paper is recorded at a location outside its storage folder, '
    + 'so it was not opened. Re-add the file to repair the record.'
}

function pdfUnavailable(reason: PdfUnavailableReason): PdfReadResult {
  return { ok: false, reason, sentence: PDF_UNAVAILABLE_SENTENCE[reason] }
}

const SHARING_CAP = 'project-sharing' as const

/** The one literal both halves match by identity. See the contract. */
const SHARING_OFF = SHARING_OFF_SENTENCE

/** Likewise: nothing that shares could be asked. See the contract. */
const SHARING_UNREADABLE = SHARING_UNREADABLE_SENTENCE

/**
 * One plugin's shares, shaped, and never an exception — but never a LIE either.
 *
 * A plugin that RAISES when asked has nothing to report and its own status row
 * in Settings says why; letting the throw out would let one folder blank the
 * Projects screen for every other. `answered` is what stops the empty list that
 * results from being read as the answer "this plugin shares nothing", which is
 * a different and much more consequential statement: it is what decides whether
 * a project is ALREADY shared, and a false "no" mints a second room for a
 * project that already has one.
 *
 * The exception itself is discarded rather than logged, for the reason
 * `host.ts` gives: it is a stranger's, and may carry a relay URL or a
 * credential. The plugin id and the fact of the refusal are ours to record.
 */
function sharesOf(pluginId: string): { shares: SharedProjectDTO[]; answered: boolean } {
  let rows: unknown
  try {
    rows = pluginVerb<SharedProjectDTO[]>(pluginId, 'sharesFor')(pluginCtx(pluginId))
  } catch {
    // eslint-disable-next-line no-console
    console.error(`[main] plugin ${pluginId} could not report its shares`)
    return { shares: [], answered: false }
  }
  if (!Array.isArray(rows)) {
    // eslint-disable-next-line no-console
    console.error(`[main] plugin ${pluginId} answered sharesFor with something that is not a list`)
    return { shares: [], answered: false }
  }
  return {
    shares: rows.map(shapeShare).filter((s): s is SharedProjectDTO => s !== null),
    answered: true
  }
}

/**
 * WHICH plugin already shares this project — or that the question could not be
 * answered.
 *
 * `unshareProject` must reach the plugin that actually holds the share, not
 * whichever one sorts first: stopping a project shared through B by asking A
 * leaves it syncing on B's timer with the button reporting success. Asked of
 * every loaded plugin so that a share held by one the user has since switched
 * off can still be stopped — which is exactly when they most want to.
 *
 * `unknown` is the third answer, and it exists because the other two are both
 * claims. A plugin that refused to be asked has NOT said the project is
 * unshared, and treating it as if it had is how sharing the same project twice
 * and stopping the wrong plugin's copy both begin.
 */
function pluginSharingProject(projectId: number): { holder: string | null; unknown: boolean } {
  let unknown = false
  for (const id of pluginsWithCapability(SHARING_CAP)) {
    const { shares, answered } = sharesOf(id)
    if (!answered) {
      unknown = true
      continue
    }
    if (shares.some((s) => s.projectId === projectId)) return { holder: id, unknown: false }
  }
  return { holder: null, unknown }
}

/** Shape a plugin-authored share row before it reaches the renderer verbatim. */
function shapeShare(raw: unknown): SharedProjectDTO | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const projectId = typeof r.projectId === 'number' && Number.isInteger(r.projectId) ? r.projectId : null
  if (projectId === null) return null
  const declined = typeof r.declinedRows === 'number' ? Math.max(0, Math.floor(r.declinedRows)) : 0
  // BUILT FIELD BY FIELD, never spread from the plugin's object. A spread keeps
  // whatever else the plugin attached and makes "unshaped" the default for the
  // next field anyone adds to the DTO — the safe default has to be that a field
  // does not cross until someone writes down how it is bounded.
  return {
    projectId,
    role: r.role === 'replica' ? 'replica' : 'origin',
    state: shapeRunState(r.state),
    inSync: r.inSync === true,
    onDemand: r.onDemand === true,
    // A relay label names a machine and lands in a tooltip; a sentence is prose
    // in the navbar; a code keys styling. Each is bounded to what its use needs.
    relayLabel: shapeLabel(r.relayLabel),
    sentence: shapeSentence(r.sentence),
    code: shapeCode(r.code),
    lastOkAt: shapeIso(r.lastOkAt),
    declinedRows: Number.isFinite(declined) ? declined : 0
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

// The renderer-facing signal sink for `broadcast.ts`. Registered here because
// this is the only file that may touch `BrowserWindow`.
setBroadcastSink(
  (channel) => {
    for (const win of BrowserWindow.getAllWindows()) {
      // A window closing between the schedule and the send is ordinary, not an
      // error — checking beats an exception on a destroyed webContents.
      if (!win.isDestroyed()) win.webContents.send(channel)
    }
  },
  () => refreshQuitState()
)

const isDev = !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL

/** Whether a URL is on exactly this origin — scheme, host AND port. */
function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin
  } catch {
    return false
  }
}

/**
 * The one origin the updater is allowed to reach, or null.
 *
 * Derived from the SAME source the updater itself uses -- the baked
 * app-update.yml when packaged, the environment in development -- so the filter
 * cannot drift from what the app actually talks to and start blocking it again.
 * Only the origin, so the allowance is a host, not a URL prefix someone could
 * extend.
 */
function updateFeedOriginForFilter(): string | null {
  try {
    const raw = app.isPackaged
      ? readPackagedFeed(process.resourcesPath).url
      : process.env.CORPUS_UPDATE_URL
    if (!raw) return null
    const parsed = new URL(raw)
    // A packaged build refuses a non-https feed (see `resolveFeed`), so opening
    // the filter for one would widen the network allowance for an origin the
    // updater is never going to talk to.
    if (app.isPackaged && parsed.protocol !== 'https:') return null
    return parsed.origin
  } catch {
    return null
  }
}

/** Guard against a symlink loop turning the walk below into an infinite one. */
const MAX_WALK_DEPTH = 12

/**
 * Resolve a mixed list of dropped/picked paths into the PDF FILES they stand
 * for: a .pdf is itself, a DIRECTORY is every .pdf beneath it, recursively.
 *
 * This has to live in main — the renderer has no filesystem, so a dropped
 * folder previously reached `ingest` as a single opaque "folder" value and
 * queued one meaningless job instead of the papers inside it.
 *
 * Unreadable entries are SKIPPED rather than thrown: one permission-denied
 * subdirectory must not discard the hundred PDFs that were readable. The result
 * is de-duplicated (dropping a folder and a file inside it is one import) and
 * sorted so the queue order is deterministic.
 */
async function expandPdfPaths(paths: string[]): Promise<string[]> {
  const out = new Set<string>()
  const walk = async (p: string, depth: number): Promise<void> => {
    if (depth > MAX_WALK_DEPTH) return
    let st: Awaited<ReturnType<typeof stat>>
    try {
      st = await stat(p)
    } catch {
      return
    }
    if (st.isFile()) {
      if (/\.pdf$/i.test(p)) out.add(resolve(p))
      return
    }
    if (!st.isDirectory()) return
    // Annotated explicitly: `readdir` is overloaded, and `ReturnType` picks the
    // LAST overload (Dirent[]) rather than the no-options string[] we get here.
    let entries: string[]
    try {
      entries = await readdir(p)
    } catch {
      return
    }
    await Promise.all(entries.map((name) => walk(join(p, name), depth + 1)))
  }
  await Promise.all(paths.map((p) => walk(p, 0)))
  return [...out].sort()
}

// ---------------------------------------------------------------- DB path
// Delegates to the SHARED defaultDbPath() (src/main/db/paths.ts) so the app,
// the seed runner and the verify script all resolve to the SAME file. Do NOT
// reintroduce a bespoke app.getPath('userData') path here — that is exactly the
// divergence that made `npm start` open an unseeded DB and render blank.
function resolveDbPath(): string {
  return defaultDbPath()
}

// ---------------------------------------------------------------- CSP
function cspValue(): string {
  const base = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    // `blob:` is listed because `'self'` does NOT cover it: a blob URL has an
    // opaque origin, so a raster the renderer itself produced is refused unless
    // the scheme is named. The paper thumbnails hand `canvas.toBlob` straight to
    // an <img>, deliberately rather than `toDataURL`, because only a blob URL
    // can be REVOKED — which is what makes their cache's eviction return the
    // memory instead of merely forgetting the entry. Without this every
    // thumbnail in the app rendered as a broken-image icon.
    "img-src 'self' data: blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'"
  ]
  // Dev: allow the vite HMR websocket + dev server origin only.
  if (isDev) {
    const devUrl = process.env.ELECTRON_RENDERER_URL ?? 'http://localhost:5173'
    base.push(`connect-src 'self' ${devUrl} ws://localhost:* http://localhost:*`)
    base.push(`script-src 'self' ${devUrl}`)
  } else {
    base.push("connect-src 'self'")
  }
  return base.join('; ')
}

/**
 * Silence Chromium's OWN background networking.
 *
 * The renderer CSP and the `onBeforeRequest` filter below only govern requests
 * the app makes. Chromium independently phones home beneath that layer, before
 * any window exists: its async DNS resolver queries 8.8.8.8 directly, and the
 * variations/component-update/domain-reliability/captive-portal services reach
 * gstatic. On a local-first app that claims to run offline those connections
 * are a broken promise, and `scripts/verify-packaged.sh` — which traces every
 * `connect(2)` the process tree makes — fails on them.
 *
 * These must be appended BEFORE `app.whenReady()`; Chromium reads its command
 * line once at network-service startup, so a call from `startup()` is too late.
 * The app's own deliberate outbound calls (CrossRef/arXiv/PubMed identifier
 * lookup, the optional web-search server) are unaffected — they go through
 * `fetch` in main, which none of these switches touch.
 */
function disableChromiumBackgroundNetworking(): void {
  app.commandLine.appendSwitch('disable-background-networking')
  app.commandLine.appendSwitch('disable-component-update')
  app.commandLine.appendSwitch('disable-domain-reliability')
  app.commandLine.appendSwitch('metrics-recording-only')
  app.commandLine.appendSwitch('no-pings')
  // AsyncDns is the one that bypasses the system resolver and talks to public
  // DNS servers itself; the rest are opportunistic service discovery.
  app.commandLine.appendSwitch(
    'disable-features',
    'AsyncDns,DnsOverHttps,DnsOverHttpsUpgrade,NetworkTimeServiceQuerying,MediaRouter,' +
      'DialMediaRouteProvider,OptimizationHints,AutofillServerCommunication,' +
      'NetworkServiceInProcess,SegmentationPlatform'
  )
  // Chromium AUTO-UPGRADES to DNS-over-HTTPS whenever the system resolver is a
  // provider it recognises. On a machine configured with 8.8.8.8 that produced
  // TLS connections to 2001:4860:4860::8888 before any window existed, which is
  // precisely the traffic this app promises never to make. `--disable-features`
  // alone does not cover it; the secure-DNS mode has to be pinned off too.
  app.commandLine.appendSwitch('dns-over-https-mode', 'off')
  app.commandLine.appendSwitch('dns-over-https-templates', '')
}

/**
 * Sessions and contents already hardened.
 *
 * `onHeadersReceived` and `onBeforeRequest` hold ONE listener each per session —
 * a second registration silently replaces the first rather than adding to it — so
 * a repeat call is not merely wasteful, it is the shape in which a future edit
 * would remove the protection it thought it was adding.
 */
const hardenedSessions = new WeakSet<Electron.Session>()
const guardedContents = new WeakSet<Electron.WebContents>()

/**
 * Apply the CSP and the scheme allowlist to ONE session.
 *
 * Factored out and driven from `app.on('session-created')` rather than applied to
 * `session.defaultSession` alone, because a session is not something only this
 * function can create: a `partition` on a `BrowserWindow`, or any
 * `session.fromPartition(…)`, produces a fresh one that inherits NOTHING. Such a
 * window would look and behave identically while running with no CSP and no
 * scheme filter at all — the failure is completely silent, which is exactly why
 * it cannot be left to a convention about who is allowed to pass `partition`.
 */
function hardenSession(ses: Electron.Session): void {
  if (hardenedSessions.has(ses)) return
  hardenedSessions.add(ses)

  // Inject CSP header on every response.
  ses.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [cspValue()]
      }
    })
  })

  // Defense-in-depth: cancel any request that is not a local/allowed scheme.
  const devOrigin = process.env.ELECTRON_RENDERER_URL ?? ''
  const updateFeedOrigin = updateFeedOriginForFilter()
  ses.webRequest.onBeforeRequest((details, cb) => {
    const url = details.url
    // A DOCUMENT is held to a stricter rule than a subresource. pdf.js fetches
    // its worker and its font data through `blob:`, and `img-src 'self' data:`
    // is deliberately permitted — but a `data:` or `blob:` URL loaded as a top
    // level or frame DOCUMENT is a page whose contents the app did not author,
    // running in this app's own origin. The navigation events below refuse those
    // too; this refuses them one layer lower, where nothing has to remember to
    // hook the right event.
    const isDocument = details.resourceType === 'mainFrame' || details.resourceType === 'subFrame'
    const allowed =
      url.startsWith('file:') ||
      url.startsWith('devtools:') ||
      (!isDocument && (url.startsWith('blob:') || url.startsWith('data:'))) ||
      // The update feed, and ONLY the update feed. electron-updater fetches
      // through Electron's own net session, so this filter cancelled it: the
      // offline guarantee was blocking the app's own updater, and the symptom
      // was a bare ERR_BLOCKED_BY_CLIENT naming nothing.
      //
      // Matched against the ONE origin this build was released with, never a
      // pattern — the point of the filter is that a compromised renderer cannot
      // reach an arbitrary host, and "anything https" would give that up.
      //
      // Compared as a PARSED origin, not a string prefix: `startsWith` on
      // `https://updates.example.com` also accepts
      // `https://updates.example.com.attacker.tld` and a different port on the
      // same name, which is precisely the widening this is meant to prevent.
      (!isDocument && updateFeedOrigin !== null && sameOrigin(url, updateFeedOrigin)) ||
      (isDev &&
        (url.startsWith('http://localhost:') ||
          url.startsWith('ws://localhost:') ||
          (devOrigin && url.startsWith(devOrigin))))
    cb({ cancel: !allowed })
  })

  // Nothing in this app needs a camera, a microphone, a location or a
  // notification, and the renderer is the only thing that could ask. Refusing
  // by policy means a future screen cannot acquire one by accident.
  ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false))
  ses.setPermissionCheckHandler(() => false)
}

/**
 * The guards every WebContents in this app gets, wherever it came from.
 *
 * On `app.on('web-contents-created')` rather than on the window the factory just
 * built: a guard wired inside the factory protects only contents that literally
 * traverse it, so any future window — a detached tab, a restored session, a
 * dialog someone adds — would silently lose navigation denial while looking
 * exactly like a window that has it. There is no failure to notice.
 */
/**
 * The canonical path of the ONE document this app ever loads.
 *
 * Computed once and compared exactly, so "is this our own page" is a decision
 * about a path rather than about whether a string appears somewhere in a URL.
 */
let appDocumentPathCache: string | null = null
function appDocumentPath(): string {
  if (appDocumentPathCache === null) {
    appDocumentPathCache = pathToFileURL(join(__dirname, '../renderer/index.html')).pathname
  }
  return appDocumentPathCache
}

function guardWebContents(wc: Electron.WebContents): void {
  // A `<webview>` guest, an offscreen contents or a background page is not a window
  // this app points anywhere, and `setWindowOpenHandler` on one is meaningless.
  // Guests specifically are covered by `will-attach-webview` below, which is what
  // makes excluding them here safe rather than a gap.
  //
  // NOTE devtools is NOT excluded by this: a devtools contents reports `window`. It
  // is guarded like any other, which is why `refuseNavigation` has to admit the
  // app's own document by exact path rather than refuse everything unfamiliar.
  if (wc.getType() !== 'window') return
  if (guardedContents.has(wc)) return
  guardedContents.add(wc)

  const openExternally = (url: string): void => {
    try {
      const parsed = new URL(url)
      // http/https ONLY. `file:`, `data:` and whatever custom scheme some other
      // installed application has registered are all things a link in this app
      // must not be able to reach.
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        void shell.openExternal(url)
      }
    } catch {
      // Not a URL we can hand anywhere; refusing it is the whole job.
    }
  }

  // No URL may ever open a window INSIDE the app — that window would be an
  // Electron renderer pointed at a page we do not control.
  //
  // But handing a plain http(s) link to the user's OWN browser is the opposite
  // of a risk, and denying that too is what made the "Open in web" source list
  // dead: eight links that looked like links, carried `target="_blank"`, and
  // did nothing whatsoever when clicked. The action stays `deny` in every case;
  // what changes is that a web URL is then passed to the desktop's handler.
  wc.setWindowOpenHandler(({ url }) => {
    openExternally(url)
    return { action: 'deny' }
  })

  // Navigation IN PLACE is always refused (outside the dev server): it would
  // replace the app itself with the page. A link that wants a new tab goes
  // through the handler above; this one has nowhere safe to send it.
  const refuseNavigation = (e: Electron.Event, url: string): void => {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (devUrl && url.startsWith(devUrl)) return
    // The app's OWN document, identified by exact canonical path.
    //
    // A substring test is not an identification: `includes('/renderer/index.html')`
    // also matches `file:///tmp/evil.html#/renderer/index.html`, any directory the
    // user happens to have named `renderer`, and the same text in a query string.
    // `onBeforeRequest` permits every `file:` URL, so this is the ONLY barrier — and
    // a document that gets through is loaded WITH the preload, and therefore with
    // the whole of `window.api`.
    //
    // `hash` and `search` are ignored deliberately: they are the app's own routing
    // and have no bearing on which file is loaded.
    try {
      const u = new URL(url)
      if (u.protocol === 'file:' && u.pathname === appDocumentPath()) return
    } catch {
      // Not parseable as a URL, so certainly not our document.
    }
    e.preventDefault()
    openExternally(url)
  }
  wc.on('will-navigate', (e, url) => refuseNavigation(e, url))
  // `will-navigate` covers the MAIN frame only. An iframe navigating itself to
  // `data:` or to another file needs its own event, and a redirect chain is decided
  // after the first request was already allowed — so neither is reachable from that
  // hook alone.
  //
  // Both read the url off the EVENT rather than from a positional argument:
  // `will-redirect`'s `url` parameter is deprecated, and a future Electron dropping
  // it would silently turn this guard into a no-op that refuses nothing.
  wc.on('will-frame-navigate', (e) => refuseNavigation(e, e.url))
  wc.on('will-redirect', (e) => refuseNavigation(e, e.url))
  // A `<webview>` cannot appear today (`webviewTag` defaults off), so this is
  // purely so that turning it on later cannot hand a guest full node access.
  wc.on('will-attach-webview', (_e, webPreferences, params) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    params.src = 'about:blank'
  })
}

function installSecurity(): void {
  // Fires for the default session too, so this is the ONLY place the hardening is
  // applied — there is no second, easily-forgotten call site.
  app.on('session-created', hardenSession)
  app.on('web-contents-created', (_e, wc) => guardWebContents(wc))
  // `session-created` does not fire retroactively, and `session.defaultSession`
  // may already exist by the time this runs.
  hardenSession(session.defaultSession)
}

// ---------------------------------------------------------------- IPC
const idSchema = z.number().int().nonnegative()
/** The registered outlets — a closed enum, so an unknown id cannot reach a handler. */
const outletIdSchema = z.enum(['zotero', 'obsidian'])

function registerIpc(): void {
  // ---------- the registry ----------
  //
  // Every entry in `src/main/ipc/registry` becomes an `ipcMain.handle` here, and
  // the SAME entry becomes an MCP tool in `src/main/mcp/server.ts`. One
  // definition, two callers — which is the only way a filter added to a channel
  // cannot drift away from the tool that exposes it.
  //
  // Behaviour of a migrated channel is UNCHANGED: same channel string, same
  // positional argument order, same accepted value space. `src/preload/index.ts`
  // is not touched by a migration, and `registry.sweep.ts` asserts the argument
  // names still line up.
  //
  // The migration is deliberately partial — see the header of
  // `registry/index.ts` for the three reasons it stops where it does. Channels
  // below this loop are the inline remainder and are not going anywhere.
  for (const entry of ENTRIES) {
    ipcMain.handle(entry.channel, (event, ...args: unknown[]) => {
      // `args.length === 0` and not `args[0] ?? {}`: a channel that takes no
      // argument is invoked with none, and `z.object({}).parse(undefined)`
      // throws — but a present `null` must still reach `.parse` and be refused
      // there, exactly as the inline handler refused it. Coalescing it to `{}`
      // would turn a rejected call into a silently accepted one.
      const obj = entry.order
        ? Object.fromEntries(entry.order.map((k, i) => [k, args[i]]))
        : ((args.length === 0 ? {} : args[0]) as Record<string, unknown>)
      const win = BrowserWindow.fromWebContents(event.sender)
      return entry.run(
        { db: getDb(), source: 'ipc', sender: win ? { id: win.id } : null },
        entry.params.parse(obj)
      )
    })
  }

  // --- updates ------------------------------------------------------------
  //
  // None of these take an argument, which is the whole of their input
  // validation. The state lives in ONE service so that a second window shows
  // the same download rather than starting its own.
  ipcMain.handle('update:state', () => updaterState())
  ipcMain.handle('update:check', () => (updater ? updater.check() : updaterState()))
  ipcMain.handle('update:download', () => (updater ? updater.download() : updaterState()))
  ipcMain.handle('update:cancel', () => (updater ? updater.cancelDownload() : updaterState()))
  ipcMain.handle('update:install', () => updater?.install() ?? false)
  // Returns whether it could. A button that silently does nothing when the file
  // has been moved or cleaned up reads as a broken app.
  ipcMain.handle('update:reveal', () => {
    const file = updaterState().file
    if (!file || !existsSync(file)) return false
    shell.showItemInFolder(file)
    return true
  })
  // ---------- project archives ----------
  // Read in MAIN, always. An archive is hundreds of megabytes of PDFs; handing
  // it to the renderer to parse would put a corpus in the page's heap for no
  // reason, and the renderer has no filesystem to read it from anyway.
  //
  // Two calls, not one: the user is shown what an archive contains BEFORE it is
  // imported. Folding the inspect into the import would mean the only way to
  // find out what a file held was to commit to it.
  ipcMain.handle('archive:pick', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.OpenDialogOptions = {
      title: 'Import a project',
      properties: ['openFile'],
      filters: [{ name: 'Project archive', extensions: ['zip'] }]
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    // Dismissal is its own state — null, never an error. Choosing the wrong
    // file IS an error and throws below, because those are different things
    // and a user who changed their mind must not be shown a failure.
    if (res.canceled || res.filePaths.length === 0) return null

    const path = res.filePaths[0]
    const bytes = await readFile(path)
    // Throws a readable sentence when this is not one of ours.
    const m = readArchiveManifest(bytes)
    return {
      path,
      project_name: m.project_name,
      project_description: m.project_description,
      created_at: m.created_at,
      works: m.counts.works,
      analyses: m.counts.analyses,
      facts: m.counts.facts,
      summaries: m.counts.summaries,
      citation_edges: m.counts.citation_edges,
      has_pdfs: m.has_pdfs,
      pdfs: m.counts.pdfs,
      embedding_model: m.embedding?.model_id ?? null,
      size_bytes: bytes.length
    } satisfies ArchiveInfoDTO
  })

  ipcMain.handle('archive:import', async (_e, path: unknown) => {
    // The path is re-validated and the file re-read rather than trusting a
    // handle the renderer kept: a page script must not be able to name an
    // arbitrary file and have main import it as a project.
    const p = z.string().min(1).max(4096).parse(path)
    const bytes = await readFile(p)
    const archive = readArchive(bytes)
    const rep = restoreProjectArchive(getDb(), archive, nowIso())
    // The new project's papers may need work the archive could not carry —
    // a re-embed above all — and every screen showing a project list is now
    // stale.
    broadcastJobsChanged()
    return {
      project_id: rep.projectId,
      project_name: rep.projectName,
      works_created: rep.worksCreated,
      works_reused: rep.worksReused,
      analyses: rep.analyses,
      facts: rep.facts,
      measurements: rep.measurements,
      summaries: rep.summaries,
      pdfs_stored: rep.pdfsStored,
      chunks: rep.chunks,
      vectors_kept: rep.vectors.kept,
      warnings: rep.warnings
    } satisfies ImportResultDTO
  })

  // ---------- ingest / analysis ----------
  /**
   * Native file/folder picker for the "Import from file" drop zone.
   *
   * `ingest:run` addresses a PDF by ABSOLUTE PATH, but a renderer cannot learn
   * one: Electron 33 removed the `File.path` augmentation, so a dropped or
   * picked File exposes only its name. Main is the only side that can resolve a
   * real path, hence this bridge — without it the drop zone could look
   * functional while being unable to queue anything.
   *
   * Returns paths only; no file contents cross the boundary, and the renderer
   * cannot choose what is opened beyond the mode it asks for.
   */
  ipcMain.handle('ingest:pickFiles', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    // ONE picker for both files and folders. Electron cannot combine
    // `openFile` + `openDirectory` on Windows/Linux, so the dialog is opened in
    // FILE mode and directories are reached by dropping them (or by selecting
    // one on macOS, where the combination IS honoured). Whatever comes back is
    // expanded below, so a directory selected on macOS behaves identically.
    const opts: Electron.OpenDialogOptions = {
      title: 'Choose PDF files or a folder',
      properties:
        process.platform === 'darwin'
          ? ['openFile', 'openDirectory', 'multiSelections']
          : ['openFile', 'multiSelections'],
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    // Cancel is its own state: an empty list, never an error and never a path
    // the caller could mistake for a chosen file.
    return res.canceled ? [] : await expandPdfPaths(res.filePaths)
  })

  /**
   * Expand dropped/picked paths into the PDF FILES they stand for: a file is
   * itself, a directory is every .pdf beneath it, recursively. The renderer
   * cannot do this — it has no filesystem — and without it a dropped folder
   * queued one meaningless "folder" job instead of its papers.
   */
  ipcMain.handle('ingest:expandPaths', async (_e, paths: unknown) =>
    expandPdfPaths(z.array(z.string().min(1)).max(2000).parse(paths))
  )

  ipcMain.handle('frontier:list', (_e, projectId: unknown) => {
    const pid = idSchema.parse(projectId)
    return listFrontiers(getDb(), pid)
  })

  ipcMain.handle('frontier:save', (_e, input: unknown) => {
    const parsed = z
      .object({ projectId: idSchema, name: z.string().min(1), graphState: z.string() })
      .parse(input)
    return saveFrontier(getDb(), parsed, nowIso())
  })

  // ---------- pdf ----------
  ipcMain.handle('pdf:read', async (_e, documentId: unknown): Promise<PdfReadResult> => {
    const id = idSchema.parse(documentId)
    const loc = resolvePdfPath(getDb(), id)
    if (!loc) return pdfUnavailable('none')
    // Resolve + assert the path stays inside base_dir (reject .. / abs / symlink escape).
    const baseDir = resolve(loc.baseDir)
    const target = resolve(baseDir, loc.relativePath)
    if (target !== baseDir && !target.startsWith(baseDir + sep)) return pdfUnavailable('rejected')
    try {
      const real = await realpath(target)
      const realBase = await realpath(baseDir)
      if (real !== realBase && !real.startsWith(realBase + sep)) return pdfUnavailable('rejected')
      const buf = await readFile(real)
      return { ok: true, bytes: new Uint8Array(buf) }
    } catch (err) {
      // ENOENT is the file (or a directory above it) not being there, which
      // covers both a deleted copy and an unmounted drive; everything else —
      // EACCES, EIO, EBUSY — is a file that exists and would not be read.
      // Neither is "this paper has no full text", which is what one null said.
      const code = (err as NodeJS.ErrnoException)?.code
      return pdfUnavailable(code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable')
    }
  })

  ipcMain.handle('pdf:ocrWordBoxes', (_e, documentId: unknown) =>
    readOcrWordBoxes(getDb(), idSchema.parse(documentId))
  )

  /**
   * Open the folder an outlet writes into.
   *
   * Takes the OUTLET ID, never a path: the folder is resolved here from the
   * outlet's own stored settings, so page script cannot ask the OS to open an
   * arbitrary location. Returns false when nothing has been configured or the
   * folder is not there, so the UI says so rather than appearing to do nothing.
   */
  ipcMain.handle('outlets:revealFolder', async (_e, outletId: unknown) => {
    const id = outletIdSchema.parse(outletId)
    if (id !== 'obsidian') return false
    const s = readOutletSettings(getDb(), 'obsidian')
    if (!s.vault_path) return false
    let dir: string
    try {
      dir = resolveVaultTarget(s.vault_path, s.folder).dir
    } catch {
      return false
    }
    try {
      await access(dir)
    } catch {
      return false
    }
    shell.openPath(dir)
    return true
  })

  // ---------- zotero ----------
  ipcMain.handle('zotero:collections', () =>
    listCollections(zoteroDir(getDb())).map((c) => ({
      key: c.key,
      name: c.name,
      path: c.path,
      item_count: c.itemCount
    }))
  )

  ipcMain.handle('zotero:getMap', (_e, projectId: unknown) => {
    const key = readCollectionMap(getDb(), idSchema.parse(projectId))
    return key && key.length > 0 ? key : null
  })

  ipcMain.handle('zotero:setMap', (_e, projectId: unknown, collectionKey: unknown) => {
    writeCollectionMap(
      getDb(),
      idSchema.parse(projectId),
      collectionKey === null ? null : z.string().min(1).max(64).parse(collectionKey)
    )
  })

  // ---------- zotero connection (the WRITE direction) ----------
  // Everything above reads a COPY of zotero.sqlite. These hand a request to a
  // RUNNING Zotero and let it perform the write itself, which is the only safe
  // way to add to a library: the file is locked while Zotero runs.
  ipcMain.handle('zotero:isRunning', () => zoteroPing())

  ipcMain.handle('zotero:targets', async () => {
    const targets = await listZoteroTargets()
    return targets.map((t) => ({
      id: t.id,
      name: t.name,
      level: t.level,
      files_editable: t.filesEditable
    }))
  })

  ipcMain.handle('zotero:getConnection', async (_e, projectId: unknown) => {
    const conn = readZoteroConnection(getDb(), idSchema.parse(projectId))
    // `running` is MEASURED on every call rather than remembered: Zotero can be
    // quit at any moment, and a cached answer is how a green light ends up
    // describing an app that closed an hour ago.
    return {
      connected: conn !== null,
      running: await zoteroPing(),
      target_id: conn?.targetId ?? null,
      target_name: conn?.targetName ?? null
    }
  })

  ipcMain.handle(
    'zotero:connect',
    (_e, projectId: unknown, targetId: unknown, targetName: unknown) => {
      const pid = idSchema.parse(projectId)
      writeZoteroConnection(getDb(), pid, {
        // A treeViewID, never a collection key — see `readZoteroConnection`.
        targetId: z
          .string()
          .regex(/^[LC]\d+$/, 'not a Zotero destination id')
          .parse(targetId),
        targetName: z.string().min(1).max(200).parse(targetName)
      })
      // The papers already here are offered to the library too. Without this
      // the step would exist only for papers imported AFTER connecting, and a
      // user who set Zotero up on an established project would watch nothing
      // arrive.
      getJobQueue().replanProjectStage(pid, 'zotero-push')
    }
  )

  ipcMain.handle('zotero:disconnect', (_e, projectId: unknown) => {
    const pid = idSchema.parse(projectId)
    writeZoteroConnection(getDb(), pid, null)
    // And the outstanding push jobs go with it: a queue still listing a step
    // for a library this project no longer sends to describes work that will
    // never happen.
    getJobQueue().replanProjectStage(pid, 'zotero-push')
  })

  ipcMain.handle('zotero:import', (_e, projectId: unknown, collectionKey: unknown) => {
    const db = getDb()
    const pid = idSchema.parse(projectId)
    const key = z.string().min(1).max(64).parse(collectionKey)
    const dir = zoteroDir(db)
    const items = listCollectionItems(dir, key)
    const summary = importItems(db, pid, items, dir)
    // A library landing changes what the corpus HOLDS, and this path writes its
    // rows in SQL rather than through the planner, so nothing else here tells
    // the scheduler. The rerank sweep counts a project's papers in its own
    // fingerprint, so without this wake the imported papers would sit unscored
    // until some unrelated action happened to wake it.
    getJobQueue().wakeCorpusSweeps()
    return { added: summary.added, skipped: summary.skipped, with_pdf: summary.withPdf }
  })

  // Notes leave for Zotero as a FILE the user imports — never as a write to
  // zotero.sqlite, which is locked while Zotero runs and whose schema shifts
  // between versions. Uses the same atomic save protocol as every export.
  ipcMain.handle('zotero:exportRdf', async (e, projectId: unknown) => {
    const db = getDb()
    const pid = idSchema.parse(projectId)
    const project = getProject(db, pid)
    if (!project) throw new Error(`project ${pid} not found`)
    const settings = readOutletSettings(db, 'zotero')
    const notes = buildProjectNotes(db, pid)
    const stem = (project.slug ?? `project-${pid}`).replace(/[^a-zA-Z0-9._-]+/g, '-')

    // The extracted data travels WITH the bibliography, EMBEDDED in the same
    // file as a note filed in the collection. One self-contained .rdf: a reader
    // who imports it gets the papers and the measurements together, and the
    // export survives being moved or sent to somebody else — which a sibling
    // file referenced by absolute path would not.
    const schemas = listProjectSchemas(db, pid)
    const dataTable =
      schemas.length > 0 && getExtractionRows(db, pid).length > 0
        ? buildCombinedExtractionTable(
            db,
            pid,
            schemas.map((s) => s.id)
          )
        : null

    // WHICH papers, decided against the disk before a byte is written. With
    // `include_pdfs` on, a paper whose file cannot be read is dropped WHOLE —
    // its record as well as its file — so the recipient never gets a library row
    // that looks like a paper they have and opens nothing.
    const plan = await planAttachments(notes, settings.include_pdfs)

    const rdf = renderZoteroRdf(
      plan.exportable,
      {
        summaryNotes: settings.summary_notes,
        projectNotes: settings.project_notes,
        attachments: settings.include_pdfs ? plan.paths : undefined
      },
      // Named after the project, so an import lands as one collection the user
      // recognises rather than as loose items mixed into a library.
      project.name,
      dataTable
    )

    // Bare .rdf when there are no files to carry; a zip when there are. Not
    // always a zip: without attachments the archive holds one text file and
    // buys nothing, while costing the user an unpack step before Zotero's
    // File → Import can see anything.
    const artifact = settings.include_pdfs
      ? {
          data: zip([
            { name: `${stem}-zotero.rdf`, data: rdf },
            ...(await Promise.all(
              plan.exportable.map(async (n) => ({
                name: plan.paths.get(n.work.id) as string,
                data: await readFile(plan.sources.get(n.work.id) as string)
              }))
            ))
          ]),
          extension: 'zip',
          filenameStem: `${stem}-zotero`
        }
      : { data: rdf, extension: 'rdf', filenameStem: `${stem}-zotero` }

    const saved = await saveArtifact(e.sender, artifact, 'Export for Zotero')
    return {
      ...saved,
      papers: plan.exportable.length,
      omitted: plan.skipped,
      bundled: settings.include_pdfs
    }
  })

  // ---------- storage locations ----------
  ipcMain.handle('storage:baseDirs', () => listBaseDirs(getDb()))

  /**
   * Choose a folder.
   *
   * Its own dialog rather than a mode of `ingest:pickFiles`: that one asks for
   * PDFs and can only offer `openDirectory` on macOS, because Windows and Linux
   * refuse to combine file and directory selection in one dialog. Here a
   * directory is the ONLY valid answer on every platform.
   *
   * Cancel returns null — a distinct outcome, never an empty string a caller
   * might store as a path.
   */
  ipcMain.handle('storage:pickDirectory', async (e): Promise<string | null> => {
    // Parented to the window that asked, so the chooser is modal to it rather
    // than floating free of the app — the same pattern as the save dialog.
    const parent = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.OpenDialogOptions = {
      title: 'Choose a folder',
      properties: ['openDirectory', 'createDirectory']
    }
    const res = parent
      ? await dialog.showOpenDialog(parent, opts)
      : await dialog.showOpenDialog(opts)
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })

  // The repository rejects a blank label, a duplicate path and (on remove) a
  // location documents still depend on. Those throws cross IPC as rejections
  // carrying the reason, which is what the UI shows — so the message is written
  // for a user to read, not for a log.
  ipcMain.handle('storage:addBaseDir', (_e, input: unknown) => {
    const parsed = z
      .object({
        label: z.string().min(1).max(200),
        abs_path: z.string().min(1).max(4096),
        kind: z.enum(BASE_DIR_KINDS)
      })
      .parse(input)
    addBaseDir(getDb(), parsed)
    return listBaseDirs(getDb())
  })

  ipcMain.handle('storage:updateBaseDir', (_e, input: unknown) => {
    const parsed = z
      .object({
        id: idSchema,
        patch: z
          .object({
            label: z.string().min(1).max(200).optional(),
            abs_path: z.string().min(1).max(4096).optional(),
            kind: z.enum(BASE_DIR_KINDS).optional()
          })
          .strict()
      })
      .parse(input)
    updateBaseDir(getDb(), parsed.id, parsed.patch)
    return listBaseDirs(getDb())
  })

  ipcMain.handle('storage:removeBaseDir', (_e, id: unknown) => {
    removeBaseDir(getDb(), idSchema.parse(id))
    return listBaseDirs(getDb())
  })

  // Opening the folder is how a user checks what is actually in a location.
  // Returns false when the directory is not there, so the caller can say so
  // rather than leaving a button that silently does nothing.
  ipcMain.handle('storage:revealBaseDir', async (_e, id: unknown) => {
    const row = getDb()
      .prepare(`SELECT abs_path FROM base_dir WHERE id = ?`)
      .get(idSchema.parse(id)) as { abs_path: string } | undefined
    if (!row) return false
    try {
      await access(row.abs_path)
    } catch {
      return false
    }
    shell.openPath(row.abs_path)
    return true
  })

  // settings — DB-backed model list + selection (no hardcoded array). The id is
  // a TEXT model key, so validate with a string schema (idSchema is numeric);
  // the repository additionally rejects ids not present in llm_model.
  ipcMain.handle('settings:models', () => listModels(getDb()))
  ipcMain.handle('settings:getSelectedModel', () => getSelectedModel(getDb()))
  ipcMain.handle('settings:setSelectedModel', (_e, id: unknown) => {
    const modelId = z.string().min(1).parse(id)
    return setSelectedModel(getDb(), modelId)
  })
  // Which provider will answer, and why. Read from the resolved SELECTION, not
  // recomputed: a fresh probe here could report a healthy gateway while the
  // queue is still running against the mock it was constructed with, which is
  // the precise falsehood this surface exists to prevent.
  //
  // Only derived, user-safe fields cross the boundary — never the credential,
  // and never the object holding it.
  ipcMain.handle('settings:gatewayConfig', () => gatewayConfigForUi())

  // ---------- plugins ----------
  //
  // Plain `ipcMain.handle`, NOT the registry, and that is deliberate rather than
  // an omission: an `Entry` is simultaneously an MCP tool, and NONE of these may
  // be one. `plugins:list` would disclose the relay address and username to an
  // agent, and `sharing:*` would hand one a foothold to discover a room and
  // publish an entire corpus to it. `registry.sweep.ts` asserts a channel is
  // never in both places, so this cannot drift into the tool surface unnoticed.
  ipcMain.handle('plugins:list', () => listPlugins())

  ipcMain.handle('plugins:setEnabled', async (_e, pluginId: unknown, enabled: unknown) => {
    const p = z.object({ pluginId: z.string().max(64), enabled: z.boolean() }).parse({ pluginId, enabled })
    return setPluginEnabled(p.pluginId, p.enabled)
  })

  ipcMain.handle('plugins:configure', async (_e, input: unknown) => {
    const p = z
      .object({
        pluginId: z.string().max(64),
        // A CLOSED value space and a bounded one. The values reach a credential
        // file and a URL parser, so an object of arbitrary shape here is an
        // object of arbitrary shape there.
        // Bounded in COUNT as well as in the size of each entry: a map capped
        // only per-key is still unbounded overall, and every entry reaches a
        // credential file that is rewritten whole.
        values: z
          .record(z.string().max(64), z.union([z.string().max(4096), z.number(), z.boolean()]))
          .refine((v) => Object.keys(v).length <= 32, 'too many settings')
      })
      .parse(input)
    return configurePlugin(p.pluginId, p.values)
  })

  ipcMain.handle('plugins:testConnection', async (_e, pluginId: unknown) => {
    const p = z.object({ pluginId: z.string().max(64) }).parse({ pluginId })
    return testPluginConnection(p.pluginId)
  })

  // The plugin's own setup step, whatever it is. The ONLY argument beyond the id
  // is WHICH of the steps the plugin itself listed was pressed — never a URL, a
  // path or an option, so this channel's surface cannot grow with what a plugin
  // would like to be asked to do. The host checks the id against the list the
  // plugin is offering right now before it dispatches, so the renderer is not
  // what constrains it.
  ipcMain.handle('plugins:runSetup', async (_e, pluginId: unknown, actionId: unknown) => {
    const p = z
      .object({ pluginId: z.string().max(64), actionId: z.string().max(48) })
      .parse({ pluginId, actionId })
    return runPluginSetup(p.pluginId, p.actionId)
  })

  /**
   * Choose a plugin folder and install it, in ONE channel.
   *
   * The renderer never sees or supplies a filesystem path. A
   * `plugins:install(path)` channel would be "copy any directory on this
   * computer into the app's own folder, chosen by the renderer" — and the
   * renderer is the one process here that is meant to be assumed compromised.
   * The path exists only inside this handler, between the native chooser (which
   * only the user can operate) and the installer.
   */
  ipcMain.handle('plugins:addFromFolder', async (e): Promise<PluginInstallResultDTO> => {
    const parent = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.OpenDialogOptions = {
      title: 'Choose a plugin folder',
      // No `createDirectory`: a plugin is a folder that already exists and has
      // something in it, so offering to make an empty one only leads to
      // "that folder has no plugin.json".
      properties: ['openDirectory']
    }
    const res = parent
      ? await dialog.showOpenDialog(parent, opts)
      : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return { cancelled: true, plugin: null, reason: null }
    try {
      return { cancelled: false, plugin: installPlugin(res.filePaths[0]), reason: null }
    } catch (err) {
      // EVERY refusal comes back as a sentence in `reason`, never as a rejected
      // promise. A rejection would surface as a raw `Error: …` in the renderer
      // and, for a filesystem failure, would carry the chosen path — which is a
      // path the renderer was deliberately never given.
      return {
        cancelled: false,
        plugin: null,
        reason:
          err instanceof PluginManifestError
            ? err.message
            : 'That folder could not be installed as a plugin.'
      }
    }
  })

  /**
   * Replace one plugin's folder. The chooser is opened HERE, as it is for adding,
   * so the renderer never learns or supplies a path — only the id of the row the
   * user pressed, which main re-checks against the chosen folder's own manifest.
   */
  ipcMain.handle('plugins:updateFromFolder', async (e, pluginId: unknown): Promise<PluginInstallResultDTO> => {
    const p = z
      .object({ pluginId: z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/) })
      .parse({ pluginId })
    // REFUSED IN MAIN, like the removal, and here rather than in `updatePlugin`
    // because the repository's own cycle IS `updatePlugin` — the rule is about
    // who asked, not about the verb. A folder chosen here would be replaced at
    // the next check with nothing having said so, which is worse than a refusal.
    if (isRepositorySupplied(p.pluginId)) {
      return {
        cancelled: false,
        plugin: null,
        reason:
          'That plugin comes from the repository this app is connected to, which keeps it up to '
          + 'date. Disconnect the repository, in Settings → Plugins, to replace it from a folder.'
      }
    }
    const parent = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.OpenDialogOptions = {
      title: 'Choose the folder to update this plugin from',
      properties: ['openDirectory']
    }
    const res = parent
      ? await dialog.showOpenDialog(parent, opts)
      : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return { cancelled: true, plugin: null, reason: null }
    try {
      return { cancelled: false, plugin: await updatePlugin(p.pluginId, res.filePaths[0]), reason: null }
    } catch (err) {
      // A sentence, never a rejection — same reason as adding: a raw rejection
      // reaches the renderer as `Error: …` and a filesystem failure carries the
      // chosen path, which is the one thing this handler exists to withhold.
      return {
        cancelled: false,
        plugin: null,
        reason:
          err instanceof PluginManifestError
            ? err.message
            : 'That plugin could not be updated from that folder.'
      }
    }
  })

  ipcMain.handle('plugins:remove', async (_e, pluginId: unknown) => {
    // The id is bounded and shape-checked here as well as in the installer: it
    // becomes a directory name, and a path segment that reaches the filesystem
    // having been validated only once is the shape of every traversal bug.
    const p = z
      .object({ pluginId: z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/) })
      .parse({ pluginId })
    await removePlugin(p.pluginId)
    return listPlugins()
  })

  ipcMain.handle('plugins:restore', async (_e, pluginId: unknown) => {
    // Same shape check as the removal it undoes. The id is read back out of a
    // settings key and joined onto a plugins root by discovery, so it is a path
    // segment on this path too.
    const p = z
      .object({ pluginId: z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/) })
      .parse({ pluginId })
    await restorePlugin(p.pluginId)
    return listPlugins()
  })

  // ---------- the plugin repository ----------
  //
  // Plain handles, not registry entries, and for a sharper reason than the rest
  // of this block: `repository:connect` hands an address and a bearer key to a
  // service whose replies are UNPACKED AND EXECUTED on this machine. An agent
  // able to call it could point this install at a repository of its own and have
  // the app install whatever that repository offers, without a prompt — which is
  // the whole design, and exactly why only the user may reach it.
  ipcMain.handle('repository:get', () => repositoryForUi())

  ipcMain.handle('repository:test', async (_e, input: unknown) => {
    // Guarded for the same reason `connect` is: a ZodError escaping a handler
    // is rendered verbatim, and a schema dump is not a sentence anyone can act
    // on. `testRepository` answers with `ok: false` rather than throwing, so
    // this only catches a malformed call.
    try {
      const p = z.object({ address: z.string().max(2048), key: z.string().max(4096) }).parse(input)
      return await testRepository(p)
    } catch {
      return {
        ok: false,
        sentence: 'That check could not be run.',
        code: 'bad-request',
        plugins: 0
      }
    }
  })

  ipcMain.handle('repository:connect', async (_e, input: unknown) => {
    try {
      // THE KEY MAY BE EMPTY, and `min(1)` here was a real bug: the key is
      // write-only, so the form opens with the field blank and says "leave this
      // empty to keep it". Requiring a character made re-saving an already
      // connected repository — to correct a typo in its address — fail every
      // time, with a schema dump for a sentence. `connectRepository` is what
      // decides, because only it knows whether a stored key exists to keep.
      const p = z
        .object({ address: z.string().min(1).max(2048), key: z.string().max(4096) })
        .parse(input)
      return await connectRepository(p)
    } catch (err) {
      // A REFUSAL IS OUR OWN SENTENCE, never the thrown value: on this path the
      // exception is a fetch error, and a fetch error carries the request URL
      // and its headers — which here include the key itself. A ZodError is no
      // better — it reached the user as a JSON dump of its own internals.
      // INSIDE the try for exactly that reason.
      throw new Error(
        err instanceof PluginManifestError ? err.message : 'That repository could not be connected.'
      )
    }
  })

  ipcMain.handle('repository:disconnect', () => disconnectRepository())

  ipcMain.handle('repository:sync', async () => syncRepositoryNow())

  /**
   * EVERY sharing plugin's shares, not one plugin's.
   *
   * An EMPTY LIST, not a throw, when nothing can share: the Projects screen asks
   * for this on every load and a fresh install has no plugins, so "none" is the
   * ordinary answer rather than an error to render.
   *
   * The UNION is what makes a second sharing plugin honest. Asking only the
   * first would hide the projects shared through the second while they went on
   * syncing on its own timer, with nothing on screen to stop them — a share that
   * exists and cannot be reached is worse than one that was never offered.
   * DISABLED plugins are asked too: the shares are in the database whether or
   * not anything is polling, and dropping them because the user turned syncing
   * off would look like the shares themselves had gone.
   *
   * A plugin that REFUSES to answer is not a plugin with no shares, and the
   * difference is the whole screen: its projects would render as private while
   * they went on syncing. So the same rule the search registry uses applies —
   * a partial answer is reported (the plugin's own Settings row says why it is
   * short), but when NOTHING that can share could be asked, the call REJECTS
   * with a sentence of ours rather than resolving to an empty list the screen
   * would draw as "nothing is shared".
   */
  ipcMain.handle('sharing:listShares', (): SharedProjectDTO[] => {
    const ids = pluginsWithCapability(SHARING_CAP)
    const answers = ids.map((id) => sharesOf(id))
    if (ids.length > 0 && answers.every((a) => !a.answered)) throw new Error(SHARING_UNREADABLE)
    return answers.flatMap((a) => a.shares)
  })

  /**
   * The plugin to act through, or a sentence saying why there is none.
   *
   * TWO distinct refusals, because they need two different actions from the
   * user: nothing installed that can share at all, and something installed but
   * switched off. Neither NAMES the plugin — a hard-coded plugin name once told
   * a user running a different sharing plugin to enable one they had never
   * installed, and Settings showed no such row for them to enable.
   *
   * Refusing while it is OFF matters because nothing polls then, so a share or a
   * join made then produces a project that is marked as syncing and never does —
   * a state whose only symptom is silence. The renderer already hides the entry
   * point; this is the check that holds when it does not.
   */
  const sharingTarget = (): string => {
    const enabled = enabledPluginsWithCapability(SHARING_CAP)[0]
    if (enabled) return enabled
    if (pluginsWithCapability(SHARING_CAP).length === 0) {
      throw new Error('That feature comes from a plugin that is not installed.')
    }
    throw new Error(SHARING_OFF)
  }

  /**
   * The ONLY strings `sharing:syncNow` may reject with — a closed set, matched
   * by identity, so the renderer's tooltip cannot be an exception message.
   *
   * Kept beside the throws it mirrors rather than derived from them, because a
   * derivation would have to reach into the host's internals and would then
   * silently widen whenever a new throw was added there. Adding a sentence here
   * is the deliberate act of saying "this one is showable".
   */
  const SYNC_NOW_SENTENCES = new Set([
    SHARING_OFF,
    'That plugin is switched off, so there is nothing to sync.',
    'That plugin has nothing to sync.',
    'That plugin is not installed.',
    // `sharingTarget()` throws this when NOTHING offers `project-sharing`, which
    // is a different answer from "it is off" and needs a different act from the
    // user. Omitting it mapped the honest sentence to a fallback naming a plugin
    // they do not have — the fault capability dispatch exists to remove.
    'That feature comes from a plugin that is not installed.'
  ])

  /** The ones the host itself throws; every sharing verb can hit them. */
  const HOST_SENTENCES = [
    SHARING_OFF,
    SHARING_UNREADABLE,
    'That feature comes from a plugin that is not installed.',
    'That feature comes from a plugin that does not offer it. It may be an older version.',
    'That plugin is not installed.'
  ]

  const SHARE_SENTENCES = new Set([
    ...HOST_SENTENCES,
    'That project is already shared.',
    'That project could not be read.'
  ])

  const JOIN_SENTENCES = new Set([
    ...HOST_SENTENCES,
    'That invitation is not one this app recognises.',
    'Give this project a name on this computer.',
    'That project is already on this computer.'
  ])

  const UNSHARE_SENTENCES = new Set(HOST_SENTENCES)

  /**
   * Run a sharing verb, and let ONLY a sentence from its own closed set out.
   *
   * The renderer renders these strings verbatim into `.form-error`, so anything
   * unrecognised becomes a sentence of ours. This is not paranoia about the
   * plugin's own deliberate throws — those are the allowlists above — it is
   * about everything else on the path: `fetch failed` and undici messages
   * carrying the relay URL, a zod `String must contain at most 512
   * character(s)`, a SQLite constraint name. Electron also prefixes a rejected
   * handler with `Error invoking remote method 'sharing:joinProject':`, so the
   * unmapped string the user saw was not even a bare exception message.
   */
  const sharingVerb = async <T>(
    allowed: ReadonlySet<string>,
    fallback: string,
    run: () => Promise<T>
  ): Promise<T> => {
    try {
      return await run()
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      throw new Error(allowed.has(message) ? message : fallback)
    }
  }

  ipcMain.handle('sharing:shareProject', async (_e, projectId: unknown) =>
    sharingVerb(SHARE_SENTENCES, 'That project could not be shared. Check the plugin that shares projects in Settings → Plugins.', async () => {
      const p = z.object({ projectId: z.number().int().positive() }).parse({ projectId })
      const id = sharingTarget()
      // Refused HERE when another plugin already shares it. Each plugin can only
      // check its own book, so two of them would each mint a room for the same
      // project and every edit would race between two relays.
      const { holder, unknown } = pluginSharingProject(p.projectId)
      // A plugin that could not be asked has NOT said this project is free. It
      // is refused rather than shared twice: a second room for a project that
      // already has one races every edit between two relays, and the user has
      // no way to see that it happened.
      if (unknown && holder === null) throw new Error(SHARING_UNREADABLE)
      if (holder !== null && holder !== id) throw new Error('That project is already shared.')
      const raw = await pluginActingVerb<ShareResultDTO>(
        id,
        'shareProject',
        pluginCtx(id),
        p.projectId
      )
      const share = shapeShare(raw?.share)
      // The INVITE is shaped too, though it is not prose: it is displayed for
      // copying and it is the one string here the user is asked to hand to
      // somebody else, so a control character hiding half of it would be handed
      // on unnoticed.
      const invite = shapeSentence(raw?.invite)
      if (!share || !invite) throw new Error('That project could not be read.')
      return { share, invite }
    })
  )

  // Joining takes the INVITATION, never a project id: it creates the local
  // project itself. There is deliberately no "browse the relay for projects"
  // channel — the room id is the read capability, so a directory endpoint would
  // hand every account on the relay read access to every project on it.
  ipcMain.handle('sharing:joinProject', async (_e, input: unknown) =>
    sharingVerb(JOIN_SENTENCES, 'That project could not be joined. Check the invitation, and the plugin that shares projects in Settings → Plugins.', async () => {
      const p = z
        .object({
          // Bounded on the way in. The invite reaches a regex and a database
          // write; `parseInvite` shape-checks both halves and refuses anything
          // else, and the cap here means a megabyte of it never gets that far.
          invite: z.string().min(1).max(512),
          name: z.string().min(1).max(200)
        })
        .parse(input)
      const id = sharingTarget()
      const share = shapeShare(
        await pluginActingVerb<SharedProjectDTO>(id, 'joinProject', pluginCtx(id), p.invite, p.name)
      )
      if (!share) throw new Error('That invitation is not one this app recognises.')
      return share
    })
  )

  ipcMain.handle('sharing:unshareProject', async (_e, projectId: unknown) => {
    await sharingVerb(UNSHARE_SENTENCES, 'That project could not be stopped. Check the plugin that shares projects in Settings → Plugins.', async () => {
      const p = z.object({ projectId: z.number().int().positive() }).parse({ projectId })
      // The plugin HOLDING it, falling back to the one that would take a new
      // share. Stopping a project the app cannot find a holder for is a no-op
      // the user would be told had worked, so it goes to `sharingTarget()` and
      // that plugin's own refusal is the answer.
      const { holder, unknown } = pluginSharingProject(p.projectId)
      // Falling back while the holder is merely UNKNOWN would ask the wrong
      // plugin to stop a share it does not hold, and that call succeeds — the
      // button reports the project stopped while it goes on syncing elsewhere.
      if (holder === null && unknown) throw new Error(SHARING_UNREADABLE)
      const id = holder ?? sharingTarget()
      await pluginActingVerb<void>(id, 'unshareProject', pluginCtx(id), p.projectId)
    })
  })

  /**
   * Sync now, because the user pressed the button.
   *
   * NO ARGUMENTS, and deliberately not a project id. A cycle is per-PLUGIN, not
   * per-project — the tick walks every share behind one deadline and one
   * re-entrancy latch — so an id here would be a parameter the implementation
   * could not honour, and a caller passing one would be entitled to think their
   * one project had been synced on its own. There is therefore nothing to
   * validate: the channel takes no input at all, which is the strongest form of
   * the check.
   *
   * EVERY enabled sharing plugin is ticked, for the same reason `listShares`
   * unions them: the button says "sync", and syncing half the user's shares
   * while the other half sat still would be a control that did less than it
   * said. `started` is true if ANY of them began a cycle — a plugin already
   * mid-cycle is the ordinary answer to a second press, not a failure.
   *
   * `sharingTarget()` first, for its refusal only: a plugin that is off has no
   * client and no timer, so without it the button would resolve having done
   * nothing — the failure whose only symptom is silence.
   */
  ipcMain.handle('sharing:syncNow', async (): Promise<SyncNowResultDTO> => {
    try {
      sharingTarget()
      const started = await Promise.all(
        enabledPluginsWithCapability(SHARING_CAP).map(async (id) => {
          try {
            return await runPluginTickNow(id)
          } catch {
            // One plugin refusing (it offers no `tick`, say) must not stop the
            // others: the press was about the user's shares, not about it.
            return false
          }
        })
      )
      return { started: started.some(Boolean) }
    } catch (err) {
      // MAPPED HERE, at the boundary, rather than filtered in the renderer.
      //
      // Everything this path throws deliberately is a sentence written for a
      // user, and `runTick` isolates the plugin's own exceptions — but not
      // every throw on the way is deliberate: building the ctx, or the notify
      // callback firing into a destroyed window, would reject with a message
      // nobody wrote for display. The renderer renders this string verbatim
      // into a tooltip, so an unrecognised shape becomes a sentence of ours
      // instead. A renderer-side regex on "does this look like prose" is not
      // the same guarantee: it admits any well-punctuated line, including one
      // carrying a URL.
      const message = err instanceof Error ? err.message : ''
      throw new Error(
        SYNC_NOW_SENTENCES.has(message)
          ? message
          : 'That sync could not be started. Check the plugin that shares projects in Settings → Plugins.'
      )
    }
  })

  ipcMain.handle('settings:setGatewayConfig', async (_e, input: unknown) => {
    const p = z
      .object({ endpoint: z.string().max(2048).optional(), key: z.string().max(4096).optional() })
      .parse(input)
    saveGatewayConfig(p)
    // Re-resolve immediately: the point of typing an endpoint is to use it, and
    // leaving the old provider in place until the next launch would report the
    // OLD gateway's health for the NEW address.
    setLlmSelection(await selectProvider())
    return gatewayConfigForUi()
  })

  // Developer log. The setting is PERSISTED so a reproduction survives the
  // relaunch it usually takes to trigger, and re-applied at startup below.
  ipcMain.handle('settings:devLogStatus', () => devLogStatus())
  ipcMain.handle('settings:setDevLog', (_e, enabled: unknown) => {
    const on = z.boolean().parse(enabled)
    setSetting(getDb(), DEV_LOG_SETTING_KEY, on ? '1' : '0')
    return setDevLogEnabled(on)
  })

  // What the model work has cost, per day.
  ipcMain.handle('analytics:tokenUsage', (_e, q: unknown) => {
    const parsed = z
      .object({
        // A plain `YYYY-MM-DD`, which is what the date inputs produce. Anything
        // else reaching DATE() compares as a string and silently matches
        // nothing — an empty chart that looks like an empty ledger.
        from: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullish(),
        to: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullish(),
        model: z.string().max(200).nullish()
      })
      .parse(q ?? {})
    return getTokenUsage(getDb(), parsed)
  })
  // The two writing briefs.
  //
  // READING a project brief without naming a project is legitimate and is what
  // the creation form does: there is no project yet, and the honest answer is
  // the built-in. WRITING one without a project is not — it would fall through
  // to the 0 sentinel, and that is the general summary's storage key, so one
  // project's edit would land on every project's papers. So the two channels
  // validate differently rather than sharing one permissive shape.
  const summaryPromptTarget = z.object({
    scope: z.enum(['general', 'project']),
    projectId: z.number().int().optional()
  })

  ipcMain.handle('settings:getSummaryPrompt', (_e, input: unknown) => {
    const p = summaryPromptTarget.parse(input)
    return summaryPromptDto(getDb(), p.scope, p.projectId ?? 0)
  })
  ipcMain.handle('settings:setSummaryPrompt', (_e, input: unknown) => {
    const p = summaryPromptTarget
      .extend({ text: z.string().nullable() })
      .refine((v) => v.scope === 'general' || (v.projectId !== undefined && v.projectId > 0), {
        message: 'a project summary prompt needs a real project id; 0 is the global sentinel'
      })
      .parse(input)
    const db = getDb()
    writeSummaryPromptOverride(db, p.scope, p.projectId ?? 0, p.text)
    // Nothing is superseded here. The edit reaches the summaries it governs
    // through the stage fingerprint and the stored input hashes — the mechanism
    // every other changed input already uses. A bespoke sweep would have to
    // decide by hand which runs a brief governs, and the general/project split
    // is exactly the thing it would get wrong.
    return summaryPromptDto(db, p.scope, p.projectId ?? 0)
  })

  ipcMain.handle('settings:openDevLogDir', async () => {
    const { file, dir } = devLogStatus()
    // Reveal the FILE when there is one: opening the folder leaves the user to
    // work out which of ten sessions is the one they just recorded.
    if (file) shell.showItemInFolder(file)
    else await shell.openPath(dir)
  })

  // Third-party attribution — read from the shipped, GENERATED resource tree,
  // never the database and never the network. The id is only ever matched
  // against the generated index, so it cannot name a path.
  ipcMain.handle('settings:licences', () => listLicences())
  ipcMain.handle('settings:licenceText', (_e, id: unknown) =>
    getLicenceText(z.string().min(1).max(200).parse(id))
  )

  /**
   * Per-view UI preferences (ranking sort, status filter, …).
   *
   * The app keeps ONE project state and persists it as it changes — inclusion
   * status and score overrides already write straight to SQLite. View settings
   * were the exception: they lived in component state and reset on every
   * navigation, which is why the graph grew a "save/resume frontier" feature to
   * snapshot them. Storing them here removes the need for any snapshot.
   *
   * Namespaced so a renderer cannot read or overwrite unrelated settings (the
   * selected-model key included) through this generic channel.
   */
  const VIEW_PREF_PREFIX = 'view_pref.'
  const viewPrefKey = z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9_.-]+$/i, 'view preference keys are alphanumeric')

  ipcMain.handle('settings:getViewPref', (_e, key: unknown) => {
    return getSetting(getDb(), VIEW_PREF_PREFIX + viewPrefKey.parse(key))
  })

  ipcMain.handle('settings:setViewPref', (_e, key: unknown, value: unknown) => {
    setSetting(
      getDb(),
      VIEW_PREF_PREFIX + viewPrefKey.parse(key),
      z.string().max(400).parse(value)
    )
  })

  // Build and WRITE one export. The option id is resolved back to a spec HERE
  // (specForOption), so page script cannot hand main a fabricated spec naming an
  // arbitrary schema or another project's data.
  //
  // The honesty contract — cancelled is not success, a failed write throws, a
  // partial write is unobservable — lives in `saveArtifact`, which every format
  // shares.
  ipcMain.handle('export:projectToFile', async (e, projectId: unknown, optionId: unknown) => {
    const pid = idSchema.parse(projectId)
    const id = z.string().min(1).max(120).parse(optionId)
    const db = getDb()

    const entry = listExportOptions(db, pid).find((o) => o.option.id === id)
    if (!entry) throw new Error(`unknown export option '${id}'`)

    // Built BEFORE prompting: a format that cannot be produced fails loudly
    // rather than after the user has already picked a filename — and an archive
    // that would have been SHORT is one of those. `ArchiveIncompleteError`
    // carries a sentence already free of any path (a base directory holds the
    // OS username), so it is re-thrown as that alone rather than as itself.
    let artifact
    try {
      artifact = await buildExport(db, pid, entry.spec)
    } catch (err) {
      if (err instanceof ArchiveIncompleteError) throw new Error(err.sentence)
      throw err
    }
    return saveArtifact(e.sender, artifact, `Export ${entry.option.label}`)
  })

  ipcMain.handle('export:reveal', async (_e, exportId: unknown) =>
    revealExport(z.string().min(1).max(64).parse(exportId))
  )

  // ---------- settings transfer (export / import of this install's config) ----------
  //
  // The decrypted values stay in THIS process. The renderer receives only
  // descriptions and an opaque handle, because one of the items is the gateway
  // API key and `llm/gateway.ts`'s security contract forbids putting it in an
  // IPC payload.
  const settingsItemIds = z.array(z.string().min(1).max(80)).max(64)

  ipcMain.handle('settings:listExportable', () => exportableItems(getDb()))

  ipcMain.handle('settings:exportToFile', async (e, itemIds: unknown) => {
    const ids = settingsItemIds.parse(itemIds)
    if (ids.length === 0) throw new Error('Choose at least one setting to export.')
    // Built BEFORE prompting, like every other export: a file that cannot be
    // produced fails before the user has picked a filename.
    const data = buildSettingsFile(getDb(), ids)
    const stamp = new Date().toISOString().slice(0, 10)
    return saveArtifact(
      e.sender,
      { data, extension: 'corpussettings', filenameStem: `corpus-studio-settings-${stamp}` },
      'Export settings'
    )
  })

  ipcMain.handle('settings:readFile', async (e) => {
    const parent = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.OpenDialogOptions = {
      title: 'Import settings',
      properties: ['openFile'],
      filters: [{ name: 'Corpus Studio settings', extensions: ['corpussettings'] }]
    }
    const res = parent
      ? await dialog.showOpenDialog(parent, opts)
      : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return null
    return readSettingsFile(res.filePaths[0])
  })

  ipcMain.handle('settings:applyFile', async (_e, handle: unknown, itemIds: unknown) => {
    return applySettingsFile(
      getDb(),
      z.string().min(1).max(64).parse(handle),
      settingsItemIds.parse(itemIds)
    )
  })

  ipcMain.handle('settings:closeFile', () => {
    closeSettingsFile()
  })

  // ---------- window controls (frameless custom title bar) ----------
  // The renderer can ONLY minimize / toggle-maximize / close / resize ITS OWN
  // window: every handler resolves the BrowserWindow from `event.sender`, so a
  // renderer can never address another window, and there is no id parameter to
  // forge. Payloads are zod-validated (the geometry one carries numbers).
  const senderWindow = (e: Electron.IpcMainInvokeEvent): BrowserWindow | null =>
    BrowserWindow.fromWebContents(e.sender)

  ipcMain.handle('window:minimize', (e) => {
    senderWindow(e)?.minimize()
    return null
  })
  ipcMain.handle('window:toggleMaximize', (e) => {
    const w = senderWindow(e)
    if (!w) return false
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
    // Re-query rather than assume: on X11 the WM may refuse the state change.
    return w.isMaximized()
  })
  ipcMain.handle('window:close', (e) => {
    senderWindow(e)?.close()
    return null
  })
  ipcMain.handle('window:isMaximized', (e) => senderWindow(e)?.isMaximized() ?? false)

  ipcMain.handle('window:quitState', (e) => quitState(senderWindow(e)?.id ?? null))
  ipcMain.handle('window:quitDecision', (e, choice: unknown) => {
    decideQuit(z.enum(['cancel', 'now', 'finish']).parse(choice), senderWindow(e)?.id ?? null)
    return null
  })

  // Frameless windows have no WM resize border on X11, so the renderer draws
  // its own edge/corner grips and streams the desired bounds here. Every field
  // is validated AND clamped, so a buggy (or compromised) renderer cannot drive
  // the window to a degenerate size or park it off every display — with no OS
  // frame and no application menu, an offscreen window would be unrecoverable.
  const boundsSchema = z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite(),
    height: z.number().finite()
  })
  // Minimum on-screen slice that must stay grabbable (topbar height).
  const KEEP_VISIBLE = 62
  ipcMain.handle('window:setBounds', (e, raw: unknown) => {
    const w = senderWindow(e)
    if (!w || w.isMaximized() || w.isFullScreen()) return null
    const parsed = boundsSchema.safeParse(raw)
    // Never reject: the renderer fires this from pointermove and `void`s the
    // promise, so a throw would surface as an unhandled rejection.
    if (!parsed.success) return null
    const b = parsed.data

    const cur = w.getBounds()
    const area = screen.getDisplayMatching(cur)?.workArea ?? { x: 0, y: 0, width: 4096, height: 2160 }
    const [minW, minH] = w.getMinimumSize()
    const maxW = Math.max(minW, area.width)
    const maxH = Math.max(minH, area.height)

    const width = Math.min(maxW, Math.max(minW, Math.round(b.width)))
    const height = Math.min(maxH, Math.max(minH, Math.round(b.height)))

    // Edge anchoring: when the LEFT/TOP edge is the one being dragged and the
    // size hit the minimum, keep the opposite edge pinned — otherwise the
    // window would "walk" right/down as the user keeps dragging inward.
    const wantX = Math.round(b.x)
    const wantY = Math.round(b.y)
    let x = wantX
    let y = wantY
    if (wantX !== cur.x) x = Math.round(b.x + b.width) - width
    if (wantY !== cur.y) y = Math.round(b.y + b.height) - height

    // Keep a grabbable slice on the display.
    x = Math.min(area.x + area.width - KEEP_VISIBLE, Math.max(area.x - width + KEEP_VISIBLE, x))
    y = Math.min(area.y + area.height - KEEP_VISIBLE, Math.max(area.y, y))

    w.setBounds({ x, y, width, height })
    return null
  })

  // ---------- paper text, resolution, stage runs, byte import ----------
  //
  // ONE CONTIGUOUS BLOCK, at the end, deliberately: these channels are written
  // alongside the registry migration that is moving the handlers above into
  // `src/main/ipc/registry`, and a block appended in one place is the only shape
  // two concurrent editors of this file can both land. They move into the
  // registry after that migration completes.
  //
  // NOTHING here takes or returns a filesystem path. A caller names a work or a
  // document; where the bytes actually live is the app's business and an
  // absolute path handed out is a fact about this machine that a remote agent
  // has no use for and every reason not to have.

  ipcMain.handle('stageRuns:list', (_e, input: unknown) => {
    const parsed = z
      .object({
        workId: idSchema.optional(),
        documentId: idSchema.optional(),
        projectId: idSchema.optional(),
        // Bounded strings, not free text: both are compared against stored
        // enum-like values, and an unbounded string is a pointless allocation.
        stage: z.string().min(1).max(120).optional(),
        status: z
          .enum(['running', 'succeeded', 'empty', 'skipped', 'refused', 'failed'])
          .optional(),
        currentOnly: z.boolean().optional(),
        includeGlobal: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional()
      })
      .strict()
      .parse(input ?? {})
    return listStageRuns(getDb(), parsed)
  })

}

// ---------------------------------------------------------------- window
/**
 * How many windows may exist at once.
 *
 * Every window is a whole renderer process — a fresh JS heap for the entire
 * React + d3 + pdfjs bundle, its own glyph atlases, its own pdf worker — so an
 * unbounded count is an unbounded memory commitment made by a single IPC call. A
 * looping renderer, or a stuck key on the detach gesture, would otherwise take
 * the machine down.
 */
export const MAX_WINDOWS = 8

/**
 * The shortest gap between two window creations.
 *
 * The cap alone bounds how many windows EXIST, not how much work creating them
 * costs: a stuck detach gesture, or a renderer looping on the IPC, would spawn a
 * window, watch it close and spawn another as fast as the machine allows, each one
 * a fresh renderer process. No human creates windows faster than four a second, and
 * a caller that is refused simply does not get one.
 */
const MIN_WINDOW_INTERVAL_MS = 250
let lastWindowCreatedAt = 0

/**
 * The ONE place a window is constructed.
 *
 * `opts` covers GEOMETRY and the tab a detached window opens with, and nothing
 * else. In particular no caller may pass `webPreferences`, `preload`, `sandbox` or
 * `partition`: a `partition` would hand the window a fresh session with no CSP
 * and no scheme filter (see `hardenSession`) while looking identical, and the rest
 * are the isolation guarantees the whole IPC contract rests on. Keeping them
 * un-overridable here is what makes "every window in this app is hardened"
 * checkable by reading one function.
 *
 * Returns the window so a caller can position it, seed it, or refuse to create
 * it — `null` when the cap is reached.
 */
function createWindow(opts?: {
  bounds?: Electron.Rectangle
  maximize?: boolean
  /**
   * Fill this window's tabs, instead of seeding it with a single Projects tab.
   *
   * For session restore, which has to put a whole set of pages back. Called with
   * the new window's id at exactly the point the default seed would have run, so
   * the strip is never momentarily wrong and no `tabs:changed` describing a tab
   * the user did not leave open is ever pushed.
   */
  seedTabs?: (windowId: number) => void
  /**
   * Exempt from the RATE limit (never from the window cap).
   *
   * The rate limit exists to stop a looping RENDERER spawning windows without
   * bound; it is not a property of opening windows as such. Session restore is
   * main opening a known, capped set in one synchronous pass, and applying the
   * limit to it silently dropped every window after the first — a three-window
   * session came back as one, and the next quit overwrote the row, so the rest
   * of the user's layout was gone for good.
   */
  trusted?: boolean
}): BrowserWindow | null {
  if (BrowserWindow.getAllWindows().length >= MAX_WINDOWS) return null
  const now = Date.now()
  if (!opts?.trusted) {
    if (now - lastWindowCreatedAt < MIN_WINDOW_INTERVAL_MS) return null
    lastWindowCreatedAt = now
  }

  // Full-bleed by default: start at the display work area (falls back to a
  // sane size if no display info is available) and maximize; still resizable.
  const workArea = screen.getPrimaryDisplay()?.workAreaSize
  const win = new BrowserWindow({
    ...(opts?.bounds ?? {}),
    width: opts?.bounds?.width ?? workArea?.width ?? 1440,
    height: opts?.bounds?.height ?? workArea?.height ?? 900,
    // FRAMELESS: the OS title bar (app name + minimize/maximize/close) is not
    // part of our design system, so we drop it and render our own controls in
    // the app's topbar. Linux/X11 is the target: `frame:false` is the portable
    // option (macOS-only `titleBarStyle`/traffic-light knobs are deliberately
    // NOT used). The window stays resizable; because a frameless X11 window has
    // no WM-drawn resize border, the renderer paints its own edge grips which
    // drive `window:setBounds` (clamped in main).
    frame: false,
    resizable: true,
    autoHideMenuBar: true,
    // …but a frameless window still carries `_NET_WM_ICON`, which is what the
    // taskbar and the alt-tab switcher draw. Left unset that is Electron's own
    // logo, so the app would look like a different product everywhere outside
    // its own window.
    icon: appIconPath(),
    // The paper screen is the widest layout: a 550px fixed analysis column plus
    // the PDF pane's 560px floor (.pv-grid) alongside the ~246px sidebar. Below
    // the sum the analysis column is silently CLIPPED rather than scrolled —
    // the pane drops its overflow for that split to stop scrollbar jitter — so
    // this must be raised whenever `grid-template-columns` in `paper.css` is.
    minWidth: 1380,
    minHeight: 700,
    backgroundColor: '#fffaf5',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  // F12 opens the inspector, in a packaged build as well as a dev one.
  //
  // The window is FRAMELESS and `autoHideMenuBar` is on, so Electron's own
  // accelerator has no menu to hang off and the app shipped with no way to look
  // at its own DOM. That matters for a local-first tool a user runs on their own
  // machine against their own data: when a panel renders wrongly, "open the
  // inspector and see" is the shortest path from a screenshot to a cause, and
  // shipping without it means the only person who can diagnose a layout bug is
  // whoever has a checkout.
  //
  // `before-input-event`, not `globalShortcut`: this must fire only while the
  // app's own window has focus, and it must not take F12 away from every other
  // application on the machine.
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return
    const f12 = input.key === 'F12'
    const inspect = input.control && input.shift && input.key.toLowerCase() === 'i'
    if (!f12 && !inspect) return
    if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools()
    else win.webContents.openDevTools({ mode: 'right' })
  })

  // On X11 a WM may ignore a state change on an unmapped window, so maximize as
  // part of the ready-to-show handshake (just before show) rather than at
  // construction. Stays user-resizable/unmaximizable.
  // A window created AT the cursor for a detached tab must keep the size and
  // position it was given; maximizing it would throw away the only thing the
  // gesture communicated.
  const shouldMaximize = opts?.maximize ?? opts?.bounds === undefined
  win.once('ready-to-show', () => {
    if (shouldMaximize) win.maximize()
    win.show()
  })

  // Keep the custom title bar's maximize/restore icon truthful. We never cache a
  // boolean: every notification re-queries `isMaximized()`. `maximize`/
  // `unmaximize` are WM-dependent on X11 and can be missed, so `resize`,
  // `restore` and the full-screen transitions are also used as triggers (a
  // half-screen snap reports isMaximized()===false, which is correct — the
  // control then offers "maximize").
  // `resize` fires per frame during a drag, so only emit on an actual TRANSITION
  // (the state is still re-queried every time — nothing is inferred).
  let lastMaximized: boolean | null = null
  const pushMaximized = (): void => {
    if (win.isDestroyed()) return
    const now = win.isMaximized()
    if (now === lastMaximized) return
    lastMaximized = now
    win.webContents.send('window:maximizedChanged', now)
  }
  // Ask before throwing away a paper that is halfway through being read. On the
  // window (not only on the custom title bar's IPC) so Alt-F4 and the window
  // manager's own close are covered too.
  guardWindow(win)

  // The window's tabs, in main. Registered with the ONE tab it opens showing: the
  // strip must never render zero tabs, or its row would collapse and the whole
  // layout would jump.
  const tabs = getTabModel()
  const winId = win.id
  if (opts?.seedTabs) opts.seedTabs(winId)
  else tabs.register(winId, { route: { name: 'projects' }, projectId: null, title: 'Projects' })

  // `closed`, NOT `close`: the close guard can and does `preventDefault()` a close,
  // so tearing the model down on `close` would delete the tabs of a window that
  // then stays open.
  //
  // A deliberate close FORGETS the tabs — the user closed this window and its
  // pages went with it on purpose, and re-homing them elsewhere would resurrect
  // pages they just dismissed.
  win.on('closed', () => {
    tabs.forget(winId)
  })
  // A CRASH is the opposite case. Those pages are authored work the user
  // assembled, and dropping them because a renderer died is silent data loss, so
  // they move into another live window. With no other window there is nothing to
  // show them on and the app is going anyway.
  win.webContents.on('render-process-gone', () => {
    tabs.rehome(winId)
  })

  win.on('maximize', pushMaximized)
  win.on('unmaximize', pushMaximized)
  win.on('restore', pushMaximized)
  win.on('resize', pushMaximized)
  win.on('enter-full-screen', pushMaximized)
  win.on('leave-full-screen', pushMaximized)

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

// ---------------------------------------------------------------- lifecycle
let hostPool: HostPool | null = null

// Defense-in-depth: surface (rather than silently swallow) any late failure in
// the main process instead of leaving a headless, window-less zombie.
// Both go through the scrubber: `relaunch.sh` redirects this process's stdout to
// a world-readable file in /tmp, so a rejection carrying a request header would
// put the MCP token — a full capability over this corpus — on disk in the clear.
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('[main] unhandledRejection:', redactSecrets(reason))
})
process.on('uncaughtException', (err) => {
  // eslint-disable-next-line no-console
  console.error('[main] uncaughtException:', redactSecrets(err))
})

// ASYNC because the LLM pre-flight is a network round trip, and the job queue
// cannot be constructed until it is known which provider its runs will be
// stamped with. The cost is bounded: the probe is loopback with a 2.5 s cap, and
// the overwhelmingly common failure (nothing listening) is an instant
// ECONNREFUSED, so a machine with no gateway pays nothing at all.
async function startup(): Promise<void> {
  // BEFORE anything else, because a build that is missing a payload it was
  // required to carry is not a build that should quietly open and then explain
  // itself one paper at a time. This is where a provisioning mistake becomes
  // visible to whoever can fix it — a developer at a terminal — instead of to a
  // scientist reading a per-document "qpdf is not installed" in their queue.
  //
  // PACKAGED is fatal: an installer that shipped without qpdf is defective, and
  // launching it anyway converts a build error into twenty confusing rows. In
  // DEV it is a loud log, because a working tree legitimately exists between
  // `git clone` and `npm run payloads`, and refusing to start would make the
  // repo unusable for anyone working on a screen that never touches a PDF.
  const missing = missingRequiredPayloads()
  if (missing.length > 0) {
    const detail = missing.map((p) => `${p.id} (${p.path})`).join(', ')
    if (isPackaged()) {
      throw new MissingPayloadError(
        `This build is missing required component(s): ${detail}. ` +
          'The installer was built without running `npm run payloads`.'
      )
    }
    // eslint-disable-next-line no-console
    console.error(
      `[main] MISSING REQUIRED PAYLOAD(S): ${detail} — run \`npm run payloads\`. ` +
        'Stages that need them will report skipped.'
    )
  }

  const dbPath = resolveDbPath()
  // Ensure the userData dir exists on a truly fresh install (Electron creates
  // userData itself, but the seed/verify CLI paths and custom CORPUS_DB_PATH
  // temp dirs may not exist yet).
  mkdirSync(dirname(dbPath), { recursive: true })

  // Open + migrate the DB BEFORE creating any window.
  const db = initDatabase(dbPath)
  setDb(db)
  // The token ledger is PUSHED its handle rather than reaching for one, so that
  // `provider.ts` — the choke point every LLM call passes through — can go on
  // knowing nothing about storage. See tokenLedger.ts.
  setTokenLedgerDb(db)

  // An empty app and a MISDIRECTED app look identical on screen, and the second
  // is a real bug we have shipped before (the app opened a different file from
  // the one the seed scripts wrote). Since a fresh install is now legitimately
  // empty, "no data on screen" can no longer be the signal — so state the
  // identity of the file that was actually opened, and how much is in it.
  // A launch that names the wrong path, or names the right path while the
  // renderer shows nothing, are now distinguishable without guessing.
  try {
    const counts = db
      .prepare('SELECT (SELECT COUNT(*) FROM project) AS projects, (SELECT COUNT(*) FROM work) AS works')
      .get() as { projects: number; works: number }
    // eslint-disable-next-line no-console
    console.log(
      `[main] db ready path=${dbPath} projects=${counts.projects} works=${counts.works}`
    )
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[main] could not read db inventory:', err)
  }

  // Re-arm the developer log if it was left on. The failures worth capturing
  // are usually the ones that need a relaunch to reproduce, so a flag that
  // silently cleared itself on restart would be off for exactly the run the
  // user turned it on for. `CORPUS_DEV_LOG=1` forces it on for a CLI run
  // (corpus:process, seed) where there is no window to click a toggle in.
  try {
    const stored = getSetting(db, DEV_LOG_SETTING_KEY)
    if (process.env.CORPUS_DEV_LOG === '1' || stored === '1') {
      const s = setDevLogEnabled(true)
      // eslint-disable-next-line no-console
      console.log(`[main] developer log ON -> ${s.file}`)
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[main] could not restore developer log setting:', err)
  }

  // Auto-mirror subscribes to the pipeline's post-commit event. Wired up
  // unconditionally: the subscriber itself checks whether the Obsidian outlet is
  // enabled, so toggling it in Settings takes effect without a relaunch. It can
  // never fail an analysis — the emitter is fire-and-forget.
  startAutoMirror(getDb)

  // A `vec0` table is VIRTUAL: it takes no foreign key and no cascade, so a
  // vector survives every path that deletes its chunk without going through
  // `deleteRunOutput` — deleting a work, the retrieval settle, the stage_run
  // orphan sweep. A surviving vector is not untidy: a space-correct k-NN
  // returns it, pointing at a chunk id that no longer exists, which is a
  // confidently wrong neighbour rather than an error. This is the ONE backstop
  // that covers all of those paths, including ones not yet written.
  try {
    const removed = sweepVectorOrphans(db)
    if (removed > 0) {
      // eslint-disable-next-line no-console
      console.log(`[main] removed ${removed} orphan vector(s) whose chunks were deleted`)
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[main] vector orphan sweep failed:', err)
  }

  // The opposite drift, and the one nothing else can see. An orphan VECTOR is
  // dropped by the search when its chunk turns out to be gone; a chunk with no
  // vector is never a neighbour of anything, so the passage is missing from
  // every result and the corpus still reports itself embedded. Named at
  // startup, next to the path and the counts, because there is no screen on
  // which this state looks different from a corpus that simply holds nothing on
  // the subject.
  for (const s of unindexedChunks(db)) {
    // eslint-disable-next-line no-console
    console.error(
      `[main] embedding space ${s.spaceId} has ${s.chunks} chunk(s) but only ${s.indexed} ` +
        `row(s) in ${s.vecTable} — ${s.chunks - s.indexed} passage(s) cannot be found by ` +
        'meaning search; re-run the embed stage for the affected papers'
    )
  }

  // PLUGINS COME UP BEFORE THE QUEUE, THE IPC AND THE MCP SERVER, and the order
  // is load-bearing rather than tidy.
  //
  // Capabilities plugins provide are now on the critical path of ordinary work:
  // the retrieval stage asks which plugin can fetch a PDF, and `search_web` asks
  // which can search. `resumePending` restarts last session's jobs the moment
  // `queue.start()` runs, so with the host coming up afterwards a resumed
  // retrieval would resolve NOTHING and record a permanent `skipped` reading
  // "nothing installed can fetch PDFs" — about a plugin that finished loading
  // two seconds later. `startEnabledPlugins` is AWAITED for the same reason it
  // is moved: firing it and moving on reopens the window it was moved to close.
  //
  // This is after `whenReady` (this whole function runs from it) because
  // `safeStorage` throws before that, and after the DB is open because a
  // plugin's `onEnable` creates its own bookkeeping tables. Nothing is enabled
  // on a fresh install: the flag is absent from `setting`, and absent means off.
  initPluginHost({
    safeStorage,
    notify: () => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('shares:changed')
      }
    },
    openExternal: async (url) => {
      await shell.openExternal(url)
    }
  })
  await startEnabledPlugins()

  // AFTER discovery has settled, and its first cycle is on a delay of its own.
  // A repository check that ran during startup would be competing for the
  // network with the first window's own work, and would be reading the set of
  // installed plugins while `startEnabledPlugins` was still bringing them up —
  // so an enabled plugin might not yet report the version it is running.
  startRepositorySchedule({
    safeStorage,
    notify: () => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('shares:changed')
      }
    }
  })

  // Long CPU stages run in utilityProcess hosts, so a 300-page pdfjs pass
  // cannot freeze main's SYNCHRONOUS SQLite and, with it, every IPC reply. The
  // pool spawns lazily: a session that processes no paper never pays for it.
  hostPool = new HostPool({
    entryPath: join(__dirname, 'stageHost.js'),
    runDir: join(dirname(dbPath), 'run'),
    instanceId: randomUUID()
  })

  // Semantic search reads the SAME file, on its own read-only connection in a
  // worker thread. Read-only structurally, not by convention: main stays the
  // single writer, so a bug in the search path cannot corrupt anything. Only
  // the PATH is recorded here — the handle is built on first search and can be
  // rebuilt after a cancelled quit tore it down.
  setVectorDbPath(dbPath)

  // LLM pipeline: the real gateway, or nothing. When the pre-flight fails the
  // selection is `UnavailableLlmProvider`, which REFUSES every call — the app
  // runs, the corpus and every stored analysis stay readable, and only new model
  // work is declined, loudly and with a reason the user can act on.
  //
  // AWAITED before the queue starts, so no job can be handed a provider that is
  // about to be replaced: a batch half-answered under one provider and half
  // under another leaves nothing in the record saying where the boundary fell.
  setLlmSelection(await selectProvider())
  const llmProvider = getLlmProvider()
  // eslint-disable-next-line no-console
  console.log(
    `[main] LLM provider: ${llmProvider.name} (${llmProvider.model}) — ${getLlmSelection()?.reason}`
  )
  // The selection above is a SNAPSHOT, and this one is taken at the worst
  // possible moment: a laptop opened on a train launches the app before its
  // network is up. Watching re-resolves it, so connectivity coming back is
  // noticed by the app rather than only by the user.
  startLlmWatch()
  // Every window hears about it. The indicator is rendered from this, and a
  // renderer that only asked once at mount is what kept a recovered gateway
  // reported as an outage.
  onLlmSelectionChanged(() => {
    const state = llmStatusNow()
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('settings:llmStatusChanged', state)
    }
  })
  // Coming BACK to the app is the likeliest moment for the answer to have
  // changed: the user left to reconnect, or the machine has just woken. Only
  // when the last answer was "no model" — a working gateway needs no volley of
  // probes every time the window is clicked, and `refreshLlmSelection` collapses
  // this onto the timer's probe if one is already in flight.
  app.on('browser-window-focus', () => {
    if (getLlmSelection()?.live === false) void refreshLlmSelection()
  })
  // The GETTER, not the object. The pre-flight re-runs while the app is
  // running, and a queue holding this launch's provider would go on refusing
  // every job after the gateway came back — until the next launch.
  const queue = new JobQueue(db, getLlmProvider, {
    // No `concurrency` here ON PURPOSE. Omitting it is what makes the scheduler
    // read the user's Settings → Queue values on every tick, so a change takes
    // effect immediately instead of at the next launch. A literal here would
    // silently override them.
    hostPool,
    // The SAME worker the search box uses — one embedding model in memory, not
    // two. `verify-citations` locates the block of a cited paper that a citing
    // passage points at, and it must do that off the main thread for the reason
    // the worker exists at all: a synchronous k-NN plus an ONNX forward pass
    // measured a 115 ms freeze, which in a stage looping over pairs would be a
    // window that stops repainting.
    semantic: async (text, k, workIds) => {
      const res = await getVectorSearch().query(text, k, workIds)
      return { blocks: res.hits, spaceId: res.spaceId, strategy: res.strategy }
    },
    now: nowIso,
    onChange: broadcastJobsChanged,
    // The close prompt waits on THIS, not on onChange: only a settled job means
    // the paper is finished and written, which is what "finish, then close"
    // promises.
    onSettled: refreshQuitState
  })
  setJobQueue(queue)
  // The stored AI limit into the gate that enforces it, BEFORE the queue starts.
  // The gate holds its capacity in memory and defaults to 1, so without this a
  // user who raised the limit would find the app quietly ignoring it until they
  // changed it again in this session.
  applyQueueSettings(db)
  // Left STOPPED under `CORPUS_NO_PIPELINE`, for tests whose subject is not the
  // pipeline. A launch plans a job for every unplanned paper in the corpus and
  // each running stage rasterises PDF pages in a child host; the two-peer sync
  // test runs two instances at once, and the resulting 34 concurrent analyses
  // exhausted memory and killed BOTH windows 68 seconds in — reported as
  // "Target page has been closed", which reads as a sync bug. The jobs are still
  // PLANNED below, so the queue's rows are exactly what a normal launch records;
  // only the execution is withheld.
  if (process.env.CORPUS_NO_PIPELINE !== '1') queue.start()

  // A paper is planned when it is IMPORTED and at no other moment, so anything
  // that puts one in a project by another route leaves it with no job — and the
  // queue, which can only show rows that exist, then reports a fraction of the
  // corpus with no way through the UI to repair it.
  planUnplannedProjectWorks(db, queue)

  setQuitFlush(flushPendingBroadcast)
  installCloseGuard()
  // A quit the guard PREVENTED and the user then cancelled must not leave MCP
  // refusing writes for the rest of a session they chose to keep — the same
  // failure the vector-search handle is rebuilt to avoid. So the intent is a signal with
  // both edges, not a one-way latch.
  onQuitIntentChange(noteQuitIntent)
  installSecurity()
  // Wired BEFORE the first window, so the registration that window performs is
  // already able to reach its renderer. Addressed to the ONE window whose model
  // changed, not broadcast: a window told to resync a model that did not move
  // would reject its own next op on the stale rev it re-read.
  //
  // COALESCED per window on a microtask, in the spirit of `broadcast.ts`. A single
  // gesture is many ops — a drag-reorder issues one per pointer frame — and each
  // push has the renderer read the model back, so an uncoalesced signal turns a
  // 60 Hz drag into some 180 IPC round trips a second. A microtask rather than a
  // timer because the strip is under the user's pointer: it must not see its own
  // change land late.
  const tabPushPending = new Set<number>()
  setTabPush((windowId) => {
    if (tabPushPending.has(windowId)) return
    tabPushPending.add(windowId)
    queueMicrotask(() => {
      tabPushPending.delete(windowId)
      const w = BrowserWindow.fromId(windowId)
      if (!w || w.isDestroyed() || w.webContents.isDestroyed()) return
      w.webContents.send('tabs:changed')
    })
  })
  // Dragging a tab out of the strip into a window of its own.
  //
  // Two-phase, and the phases are separated by a window construction and a page
  // load — a span in which either window can die. So this only ever PROMISES the
  // tab; the new window's own `tabs:adopt` completes the move, and
  // `reconcileDetaches` hands it back if that never happens. A single IPC here
  // would have a failed window open leave the user's page belonging to nobody.
  setDetachHandler((fromWindowId, key, screenX, screenY) => {
    const tabs = getTabModel()
    const source = BrowserWindow.fromId(fromWindowId)
    if (!source || source.isDestroyed()) return false
    if (!tabs.tracks(fromWindowId)) return false

    // Positioned at the CURSOR, on the display the cursor is actually on: a
    // window that opened on the primary monitor when the tab was dropped on the
    // secondary would have thrown away the only thing the gesture said. Clamped
    // to that display's work area so a drop near an edge cannot put the title
    // bar — and so the whole window — out of reach.
    const display = screen.getDisplayNearestPoint({ x: screenX, y: screenY })
    const area = display.workArea
    const width = Math.min(1280, area.width)
    const height = Math.min(860, area.height)
    const bounds = {
      x: Math.round(Math.min(Math.max(screenX - width / 2, area.x), area.x + area.width - width)),
      y: Math.round(Math.min(Math.max(screenY - 24, area.y), area.y + area.height - height)),
      width,
      height
    }

    // The window FIRST: it is the thing that can be refused — the eight-window
    // cap and the rate limit both live in the factory — and promising a tab to a
    // window that was never created would strand it for a whole lease period.
    const win = createWindow({ bounds, maximize: false })
    if (!win) return false

    const lease = tabs.beginDetach(fromWindowId, key, win.id)
    if (!lease) {
      // The tab was already promised elsewhere, or has gone. The window we just
      // opened has nothing to show, so it goes with it rather than sitting there
      // empty as evidence of a move that did not happen.
      win.destroy()
      return false
    }
    // Recorded against the new window BEFORE it can ask: `tabs:adopt` carries no
    // arguments, so this map is the only thing that tells main which promise the
    // claim is answering.
    notePendingAdoption(win.id, lease.nonce)

    // Reverted if the new window dies before it adopts — a crash during load, or
    // the user closing it the moment it appears. `closed` rather than `close`,
    // because a close can still be prevented.
    win.once('closed', () => {
      dropPendingAdoption(win.id)
      tabs.reconcileDetaches((id) => {
        const w = BrowserWindow.fromId(id)
        return w !== null && !w.isDestroyed()
      })
    })
    // And on a deadline, for the case no event covers: a window that opens but
    // whose renderer never reaches the point of asking to adopt.
    setTimeout(() => {
      tabs.reconcileDetaches((id) => {
        const w = BrowserWindow.fromId(id)
        return w !== null && !w.isDestroyed()
      })
    }, DETACH_LEASE_MS + 500).unref?.()

    return true
  })
  registerIpc()
  registerMcpIpc()
  // No application menu: the app is fully driven by its own in-app chrome, and
  // Electron's default File/Edit/View/Window/Help bar steals vertical space from
  // the full-bleed layout. Removing it (rather than autoHideMenuBar) also stops
  // the bar reappearing on Alt. Set ONCE for the process rather than inside the
  // window factory — it is not a property of a window.
  Menu.setApplicationMenu(null)
  restoreSessionOrOpenBlank()
  // AFTER the window: a server that is listening before there is any surface
  // showing that it is listening is the state the Settings pane exists to make
  // impossible.
  void startMcpIfEnabled()

  void startUpdater()

  // Docking/relaunching with no window RESTORES rather than opening a blank
  // one: the pages the user left are what they are coming back to, and a fresh
  // Projects tab discards them silently.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) restoreSessionOrOpenBlank()
  })
}

/**
 * The ONE update service for the process.
 *
 * Per-window would mean two windows each running their own check and, worse,
 * each starting their own download of the same installer.
 */
let updater: UpdaterService | null = null

/** Why the updater could not be constructed, if it could not. */
let updaterLoadError: string | null = null

/**
 * Whether the app is already on its way out.
 *
 * The updater consults this before blaming an install for not starting: this
 * app guards its own `before-quit` to protect work in progress, so a successful
 * install can sit at that prompt for far longer than any deadline.
 */
let quitUnderWay = false
onQuitIntentChange((intent) => {
  const wasQuitting = quitUnderWay
  quitUnderWay = intent
  // A quit that was asked for and then abandoned ends any install waiting on
  // it: the app is still here, so it never started.
  if (wasQuitting && !intent) updater?.quitCancelled()
})

/** The state to answer with, including before the service exists. */
function updaterState(): UpdateStateDTO {
  if (updater) return updater.getState()
  return {
    // `error` when the updater could not be built, so the panel RENDERS the
    // reason. Reported as `idle`, it printed "this app has not checked yet"
    // and the cause was visible nowhere.
    phase: updaterLoadError ? 'error' : 'idle',
    currentVersion: app.getVersion(),
    newVersion: null,
    releaseNotes: null,
    releaseDate: null,
    percent: null,
    bytesPerSecond: null,
    file: null,
    error: updaterLoadError,
    failed: updaterLoadError ? 'load' : null,
    configured: false,
    checkedAt: null
  }
}

/**
 * Start checking for new versions.
 *
 * A failure here must never take the app down with it: not being able to look
 * for an update is a thing to report in Settings, not a reason a scientist
 * cannot open their corpus.
 */
async function startUpdater(): Promise<void> {
  try {
    const { createUpdaterService } = await import('./updater')
    updater = await createUpdaterService(
      (state) => {
        // Every live window, resolved at push time. A window opened later — or
        // one that outlives the window this started with — must still see the
        // download it is being shown.
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) w.webContents.send('update:state', state)
        }
      },
      {
        currentVersion: app.getVersion(),
        packaged: app.isPackaged,
        // Signing is configured but not performed by any build host here, so
        // claiming a signature would produce exactly the failure
        // canInstallInPlace exists to avoid: a whole download, then a refusal
        // to swap the bundle.
        signed: process.env.CORPUS_UPDATE_SIGNED === '1',
        resourcesPath: process.resourcesPath,
        isQuitting: () => quitUnderWay
      }
    )
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[main] updater unavailable:', err)
    // REPORTED, not merely logged. Leaving `updater` null made the panel say
    // "this build has no update server configured" — telling the user a
    // configuration is absent when in fact the updater failed to load, which
    // sends them looking for the wrong thing entirely.
    // Phrased, like every other error that reaches the panel: the DTO promises
    // a display sentence, never a raw module-resolution message.
    updaterLoadError = describeUpdateError(err)
  }
  // Push once the service exists (or has failed to). `startUpdater` is awaited
  // by nobody, so a Settings pane opened during that window read the
  // pre-service sentinel and said "no update server configured" until the
  // automatic check ten seconds later corrected it.
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('update:state', updaterState())
  }
}

/**
 * Say that open pages were lost, once, at the moment they are lost.
 *
 * A DIALOG rather than anything in a window, for two reasons. The loss happens
 * BEFORE any renderer exists — it is what decides which windows get created —
 * so there is nothing yet to put a banner in. And a blank window is precisely
 * what a first install looks like, so the one surface the user actually reads
 * cannot distinguish "you left it this way" from "your thirty tabs are gone".
 *
 * Stated as a fact and a consequence, with no remedy offered, because there is
 * none: the stored session is unrecoverable and re-opening the papers is the
 * user's own work. It is not an error box — nothing is broken, the app is
 * running normally — so it does not carry a failure title.
 *
 * Nothing about the stored value is quoted. The row is user-editable text that
 * has just been shown not to parse, and it would reach the screen verbatim.
 */
function reportLostSession(lostTabs: number | 'all', lostWindows = 0): void {
  const detail =
    lostTabs === 'all'
      ? 'The record of which papers you had open could not be read, so this window has started empty. '
        + 'Nothing in your library has been lost — only the list of open pages.'
      : `${lostTabs === 1 ? 'One page' : `${lostTabs} pages`}`
        + `${lostWindows > 0 ? ` and ${lostWindows === 1 ? 'one window' : `${lostWindows} windows`}` : ''}`
        + ' you had open could not be reopened. Nothing in your library has been lost — '
        + 'only those pages, which you can open again.'
  // Not awaited: startup must not wait on the user reading it, and no branch
  // below depends on the answer.
  void dialog.showMessageBox({
    type: 'info',
    title: 'Corpus Studio',
    message: 'Your open pages could not be restored',
    detail,
    buttons: ['OK'],
    noLink: true
  })
}

/**
 * Reopen the windows and tabs the user left, or a single fresh window.
 *
 * A restore is best-effort by design: a session that cannot be read must start
 * the app, not fail to. Every path here that gives up falls through to one blank
 * window — but never SILENTLY, because that window is indistinguishable from a
 * first install and the tabs it replaces were authored work.
 */
function restoreSessionOrOpenBlank(): void {
  let read: SessionRead = { outcome: 'none' }
  try {
    read = parseSession(getSetting(getDb(), TABS_SESSION_KEY))
  } catch {
    // The row could not be REACHED at all. A first launch does not land here —
    // `getSetting` answers null against a migrated database with no such key —
    // so this is a read that failed, and the tabs it would have named are gone.
    read = { outcome: 'unreadable' }
  }
  if (read.outcome === 'none') {
    createWindow()
    return
  }
  if (read.outcome === 'unreadable') {
    // The tabs the user left are gone and nothing on screen would otherwise
    // say so — a blank window is exactly what a first install looks like. See
    // `reportLostSession`.
    createWindow()
    reportLostSession('all')
    return
  }
  if (read.outcome === 'partial') reportLostSession(read.lostTabs, read.lostWindows)
  const session = read.session
  let opened = 0
  for (const win of session.windows) {
    const created = createWindow({
      trusted: true,
      bounds: clampToDisplay(win.bounds),
      // Restored geometry is honoured EXCEPT when the window was maximized,
      // which is the state the user actually left it in and which a stored
      // rectangle only approximates.
      maximize: win.maximized === true,
      seedTabs: (windowId) => restoreWindow(getTabModel(), windowId, win)
    })
    if (created) opened++
  }
  // Nothing came back, from a session that named windows — every one of them
  // was refused by `createWindow` or held no tab whose key this build can
  // parse. The user still asked for an app, and is still told what went.
  if (opened === 0) {
    createWindow()
    reportLostSession('all')
    return
  }
  validateRestoredTabs()
}

/**
 * Strike through every restored tab whose subject is no longer in the corpus.
 *
 * A paper can be deleted while the app is CLOSED — through the MCP server, by a
 * sync, on another machine — and nothing in the running app would ever notice:
 * `work:delete` marks tabs only when it is the thing doing the deleting. Without
 * this, such a tab comes back looking perfectly ordinary and then renders
 * "Work not found." for the rest of the session, with nothing saying why.
 *
 * Once, at startup, over at most a couple of dozen keys. Cheap enough to do
 * synchronously and far cheaper than the alternative of re-validating on every
 * push.
 */
function validateRestoredTabs(): void {
  try {
    const db = getDb()
    // Memoised across tabs: the same paper is frequently open in more than one
    // window, and this is the one place a query per tab would be per WINDOW too.
    const alive = new Map<number, boolean>()
    getTabModel().markStale((key) => {
      const parsed = parseTabKey(key)
      if (parsed === null || parsed.name !== 'paper' || parsed.workId === null) return false
      const workId = parsed.workId
      let ok = alive.get(workId)
      if (ok === undefined) {
        ok = getWork(db, workId) !== null
        alive.set(workId, ok)
      }
      return !ok
    }, 'This paper is no longer in the corpus')
  } catch {
    /* No DB, or a read that failed. An unmarked tab shows its own empty state,
       which is the behaviour before this existed — never a failure to start. */
  }
}

/**
 * Put a stored rectangle back on a display that actually exists.
 *
 * A saved window is restored on hardware that may have changed: the monitor it
 * was on can be unplugged, the arrangement can differ, the resolution can be
 * smaller. And the row is a `setting` a user can edit. Because these windows are
 * FRAMELESS there is no WM title bar to drag one back with, so a rectangle
 * off-screen is a window that cannot be reached at all — the detach path already
 * clamps for this reason, and restore must too.
 */
function clampToDisplay(bounds?: Electron.Rectangle): Electron.Rectangle | undefined {
  if (!bounds) return undefined
  const area = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y }).workArea
  const width = Math.min(bounds.width, area.width)
  const height = Math.min(bounds.height, area.height)
  return {
    width,
    height,
    x: Math.round(Math.min(Math.max(bounds.x, area.x), area.x + area.width - width)),
    y: Math.round(Math.min(Math.max(bounds.y, area.y), area.y + area.height - height))
  }
}

/**
 * Write the open pages down, so a restart returns to them.
 *
 * On `will-quit` rather than on every change: this is a whole-session snapshot,
 * and writing it on each activate would put a synchronous DB write on the
 * hottest interaction the strip has.
 */
function saveSession(): void {
  try {
    const session = captureSession(getTabModel(), (windowId) => {
      const w = BrowserWindow.fromId(windowId)
      if (!w || w.isDestroyed()) return {}
      const maximized = w.isMaximized()
      // The NORMAL bounds while maximized: `getBounds()` would return the full
      // screen, so restoring and then un-maximizing would drop the window at
      // display size rather than back to the shape the user had given it.
      const b = maximized ? w.getNormalBounds() : w.getBounds()
      return {
        bounds: {
          x: Math.round(b.x),
          y: Math.round(b.y),
          width: Math.round(b.width),
          height: Math.round(b.height)
        },
        maximized
      }
    })
    setSetting(getDb(), TABS_SESSION_KEY, JSON.stringify(session))
  } catch {
    /* Quitting is not the moment to fail. A session that cannot be written
       costs the user their tab layout; anything thrown here would cost them a
       clean shutdown of the queue and the database behind it. */
  }
}

disableChromiumBackgroundNetworking()

/**
 * A second launch RAISES the running app instead of failing to open.
 *
 * `db/lock.ts` already refuses a second process — WAL and a second connection
 * from another process do not mix — and that refusal is correct. But it reaches
 * the user as an error dialog, and once "windows" are something they deliberately
 * create, double-clicking the launcher expecting another window and being told the
 * database is in use is a hostile answer to a reasonable request. The lock is
 * claimed BEFORE `whenReady` so the second process exits before it has opened
 * anything, and the first one answers by giving them the window they asked for.
 */
if (!app.requestSingleInstanceLock()) {
  app.exit(0)
} else {
  app.on('second-instance', () => {
    // A NEW window, because that is what launching the app again asks for now
    // that a window is a place the user puts tabs. When the cap refuses one,
    // raising what is already there is the honest fallback — silently doing
    // nothing would read as the launcher being broken.
    const created = createWindow()
    if (created) return
    const existing = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    if (!existing) return
    if (existing.isMinimized()) existing.restore()
    existing.focus()
  })
}

app.whenReady().then(startup).catch((err) => {
  // A DB/migration failure throws here; without this catch the promise rejects
  // unhandled and the app hangs with no window and no diagnostic (C-M1).
  // eslint-disable-next-line no-console
  console.error('[main] fatal startup error:', err)
  try {
    // The cause is NAMED, not assumed. This dialog said "The local database
    // could not be opened" for every startup failure — so a user whose only
    // problem was an unreachable LLM gateway was told their corpus was corrupt,
    // and would go looking for the wrong thing entirely.
    const message = String((err as Error)?.message ?? err)
    const isGateway = err instanceof GatewayUnavailableError
    // An unloadable sqlite-vec is an INCOMPLETE INSTALL, not a bad database.
    // It reaches here from `openDatabase`, so without this it would land in the
    // generic branch and send the user to inspect a corpus that is fine.
    const isPayload =
      err instanceof MissingPayloadError || err instanceof SqliteVecUnavailableError
    const isLocked = err instanceof DatabaseLockedError
    dialog.showErrorBox(
      // A database that is HEALTHY and in use by another process is not a
      // failure to start in the sense the other branches mean, and telling the
      // user their corpus could not be opened would send them to inspect a file
      // that is fine.
      isLocked ? 'Corpus Studio is already open' : 'Corpus Studio failed to start',
      isLocked
        ? message
        : isGateway
        ? `The analysis gateway is not available, and this app was started in ` +
            `live-only mode, which refuses to start without a model.\n\n${message}\n\n` +
            `Start the gateway, or unset CORPUS_LLM_MODE to open the app anyway — ` +
            `your corpus and every stored analysis stay readable, and only new ` +
            `analyses will be declined until a model is reachable.`
        : isPayload
          ? // NOT the database message. This installer is incomplete, which is
            // nothing to do with the user's corpus — telling them their data
            // could not be opened would send them to inspect a healthy DB.
            `This installation is incomplete: a component that should have been ` +
              `packaged with the application is missing.\n\n${message}\n\n` +
              `Your corpus is not affected. Reinstall from a complete build.`
          : `The local database could not be opened.\n\n${message}`
    )
  } catch {
    /* dialog may be unavailable if the failure is very early */
  }
  app.exit(1)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/**
 * Kill every stage host. Idempotent, and hooked THREE ways on purpose.
 *
 * `will-quit` does not fire on `app.exit()`, which this file itself calls on a
 * fatal startup error — so relying on it alone leaves a host running with no
 * parent on exactly the path where something has already gone wrong.
 * `before-quit` covers the ordinary quit earlier, and `process.on('exit')` is
 * the last synchronous chance on any path that reaches it.
 *
 * None of the three is the guarantee. The guarantee is the host's own
 * `parentPort` close handler, which exits the child when the kernel closes the
 * port — that one survives a SIGKILL of main, which no handler here can.
 */
function killHosts(): void {
  try {
    hostPool?.shutdown()
  } catch {
    /* nothing here may prevent the app from exiting */
  }
  // The search worker holds a read-only handle on the same file, so it can be
  // dropped at any moment without risking the database. Fire-and-forget for the
  // same reason: waiting on it could only delay the quit, never protect data.
  try {
    dropVectorSearch()
  } catch {
    /* nothing here may prevent the app from exiting */
  }
}
app.on('before-quit', killHosts)
process.on('exit', killHosts)

app.on('will-quit', () => {
  // FIRST, while the windows still exist: their geometry and their tabs are
  // both gone by the time the teardown below has run.
  saveSession()
  // Nothing the updater scheduled may outlive the app -- in particular the
  // deadline that would otherwise accuse an install of never starting.
  updater?.stop()
  // Nor the gateway watch: a probe fired during teardown resolves against a
  // renderer that is already gone.
  stopLlmWatch()
  let inFlight = 0
  try {
    const q = getJobQueue()
    q.stop()
    inFlight = q.inFlightCount()
  } catch {
    /* queue may not be initialised */
  }
  // `will-quit` and not `before-quit`: a bare `before-quit` fires even when the
  // close guard prevents the quit and the user then cancels, which would leave
  // the socket shut while the app kept running and Settings still said
  // "listening". `will-quit` fires once, and only when the quit is real.
  stopMcpForQuit()
  // Started, not awaited: this listener is synchronous, so awaiting here would
  // prevent the very event-loop turns the teardown needs. The plugin host aborts
  // its in-flight tick first, and the DB close below is already deferred while
  // anything is in flight — so a tick that has not finished keeps the file open
  // for the moment it needs rather than resuming on a nulled connection.
  // The repository timer is cleared BEFORE the plugins are torn down: a cycle
  // fired during the teardown would try to swap a tree under a plugin that is
  // draining. A cycle already in flight is left to finish — the DB close below
  // is deferred while anything is working, and it holds no lifecycle of its own.
  stopRepositorySchedule()
  void stopPluginsForQuit()
  killHosts()
  flushPendingBroadcast()
  // Closing the connection under a pipeline that is still mid-transaction tears
  // that transaction down uncommitted and makes every subsequent statement on
  // the way out throw. The user chose to abandon that work, so leaving the file
  // to be released by the exiting process is both correct and quieter; the
  // abandoned row stays 'running' and `resumePending` re-queues it next launch.
  //
  // `busyCount` as well as the queue: `analysis:run`/`ingest:run`/`dossier:build`
  // drive the pipeline straight from their IPC handlers, and those have no
  // terminal-write guard to survive the connection vanishing.
  //
  // `mcpInFlight` too, and as a PREDICATE TERM rather than a wait: this listener
  // is synchronous, so blocking here to drain would prevent the very event-loop
  // turns that would drain it. Not closing is already a supported outcome (the
  // comment above says why), so deferring the close is the cheap correct answer.
  // EVERY in-flight MCP call counts here, reads included: a read that is
  // awaiting resumes on a nulled connection and throws from a finalized
  // statement. The narrower `mcpInFlight()` exists for the close GUARD, where a
  // polling agent must not be able to hold the quit prompt open; that argument
  // does not apply to a predicate that only defers a file close.
  // `pluginsInFlightCount` is the fourth term for the same reason the other
  // three are there: a plugin's merge transaction resumes after an inter-chunk
  // yield, and a connection nulled underneath it throws from a finalized
  // statement — which the host swallows, leaving a half-applied batch and no
  // sign of it anywhere.
  if (inFlight === 0 && busyCount() === 0 && mcpInFlightTotal() === 0 && pluginsInFlightCount() === 0) {
    closeDb()
  }
})

// Silence unused import lint (shell reserved for future external-open policy).
void shell
