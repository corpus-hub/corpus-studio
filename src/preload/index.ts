import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { CorpusApi, LlmStatusDTO, QuitStateDTO, UpdateStateDTO } from '@shared/contract'

// Typed, whitelisted IPC surface. The renderer NEVER sees raw ipcRenderer.
// Channel naming: 'domain:action'. The main process registers the SAME channels.
//
// EVERY forwarder's parameters are NAMED, and named for what the channel's own
// schema calls them. `src/main/ipc/registry.sweep.ts` parses this file and
// asserts those names and their count match the registry entry's `order` array
// exactly. That check exists because `search:query(query, projectId, filters)`
// and `search:facets(projectId, query, filters)` sit lines apart with the same
// property names in a different order: a permuted `order` type-checks and
// silently swaps arguments. So `(id) =>` is not acceptable here even where it
// reads fine — the entity must be named (`workId`, `projectId`, `baseDirId`),
// or the sweep has nothing to compare against.
const api: CorpusApi = {
  // projects
  listProjects: () => ipcRenderer.invoke('projects:list'),
  getProject: (projectId) => ipcRenderer.invoke('projects:get', projectId),
  createProject: (input) => ipcRenderer.invoke('projects:create', input),
  updateProjectSetup: (input) => ipcRenderer.invoke('projects:updateSetup', input),
  finishProjectSetup: (projectId) => ipcRenderer.invoke('projects:finishSetup', projectId),
  listProjectWorks: (projectId) => ipcRenderer.invoke('projects:works', projectId),

  // works / paper detail
  getWork: (workId) => ipcRenderer.invoke('works:get', workId),
  getCitations: (workId) => ipcRenderer.invoke('works:citations', workId),
  getWorkDocuments: (workId) => ipcRenderer.invoke('works:documents', workId),
  getWorkAnalyses: (workId, projectId) => ipcRenderer.invoke('works:analyses', workId, projectId),
  getUnresolvedReferences: (workId) => ipcRenderer.invoke('works:unresolved', workId),
  getCitationContexts: (workId) => ipcRenderer.invoke('works:citationContexts', workId),
  getCitationOutcome: (workId) => ipcRenderer.invoke('works:citationOutcome', workId),
  resolveUnresolvedReference: (input) => ipcRenderer.invoke('works:resolveRef', input),

  // graph
  getGraph: (projectId, opts) => ipcRenderer.invoke('graph:get', projectId, opts),
  getReferenceTree: (projectId, opts) =>
    ipcRenderer.invoke('graph:referenceTree', projectId, opts),
  retrieveUnresolvedReferences: (input) => ipcRenderer.invoke('graph:retrieveRefs', input),
  getReferenceRetrievals: (unresolvedIds) =>
    ipcRenderer.invoke('graph:referenceRetrievals', unresolvedIds),
  getReferenceAbstract: (unresolvedId) =>
    ipcRenderer.invoke('graph:referenceAbstract', unresolvedId),

  // ranking
  getRanking: (projectId, sortBy) => ipcRenderer.invoke('ranking:get', projectId, sortBy),
  setInclusionStatus: (projectId, workId, status, reason) =>
    ipcRenderer.invoke('ranking:setInclusion', projectId, workId, status, reason),
  overrideScore: (projectId, workId, field, value, reason) =>
    ipcRenderer.invoke('ranking:override', projectId, workId, field, value, reason),
  recomputeRankings: (projectId) => ipcRenderer.invoke('ranking:recompute', projectId),
  markReference: (projectId, workId, isReference) =>
    ipcRenderer.invoke('ranking:markReference', projectId, workId, isReference),

  // extraction schemas (GLOBAL definitions of WHAT to extract — no project id)
  listSchemas: () => ipcRenderer.invoke('schemas:list'),
  createSchema: (input) => ipcRenderer.invoke('schemas:create', input),
  updateSchema: (schemaId, input) => ipcRenderer.invoke('schemas:update', schemaId, input),
  deleteSchema: (schemaId) => ipcRenderer.invoke('schemas:delete', schemaId),
  addSchemaField: (schemaId, input) => ipcRenderer.invoke('schemas:addField', schemaId, input),
  updateSchemaField: (fieldId, input) => ipcRenderer.invoke('schemas:updateField', fieldId, input),
  deleteSchemaField: (fieldId) => ipcRenderer.invoke('schemas:deleteField', fieldId),
  reorderSchemaFields: (schemaId, fieldIds) =>
    ipcRenderer.invoke('schemas:reorderFields', schemaId, fieldIds),
  pickProjectArchive: () => ipcRenderer.invoke('archive:pick'),
  importProjectArchive: (archivePath) => ipcRenderer.invoke('archive:import', archivePath),
  listSchemaPresets: () => ipcRenderer.invoke('schemas:presets'),
  exportSchema: (schemaId) => ipcRenderer.invoke('schemas:export', schemaId),
  importSchema: (bundle) => ipcRenderer.invoke('schemas:import', bundle),

  // per-project schema attachments (which schemas Extraction applies here)
  listProjectSchemas: (projectId) => ipcRenderer.invoke('projectSchemas:list', projectId),
  attachSchema: (projectId, schemaId) =>
    ipcRenderer.invoke('projectSchemas:attach', projectId, schemaId),
  detachSchema: (projectId, schemaId) =>
    ipcRenderer.invoke('projectSchemas:detach', projectId, schemaId),
  getSchemaCoverage: (projectId) => ipcRenderer.invoke('projectSchemas:coverage', projectId),

  // extraction / review
  getExtractionRows: (projectId) => ipcRenderer.invoke('extraction:rows', projectId),
  getTableCrops: (input) => ipcRenderer.invoke('extraction:crops', input),
  getExtractionStatusSummary: (projectId) => ipcRenderer.invoke('extraction:summary', projectId),
  getReviewQueue: (projectId) => ipcRenderer.invoke('review:queue', projectId),
  recordFactVerdict: (input) => ipcRenderer.invoke('review:verdict', input),

  // dossier
  getDossier: (projectId) => ipcRenderer.invoke('dossier:get', projectId),
  getDossierStatus: (projectId) => ipcRenderer.invoke('dossier:status', projectId),
  getDossierBriefing: (projectId) => ipcRenderer.invoke('dossier:briefing', projectId),
  buildDossier: (projectId) => ipcRenderer.invoke('dossier:build', projectId),
  getDossierContext: (projectId, workId) =>
    ipcRenderer.invoke('dossier:context', projectId, workId),

  // summaries
  getWorkSummary: (input) => ipcRenderer.invoke('summary:get', input),
  generateWorkSummary: (input) => ipcRenderer.invoke('summary:generate', input),
  getWorksWithSummaries: (projectId) => ipcRenderer.invoke('summary:have', projectId),

  // queue
  deleteWork: (workId) => ipcRenderer.invoke('work:delete', workId),
  removeWorkFromProject: (projectId, workId) =>
    ipcRenderer.invoke('work:removeFromProject', projectId, workId),
  addWorkToProject: (projectId, workId) =>
    ipcRenderer.invoke('work:addToProject', projectId, workId),
  listJobs: (projectId) => ipcRenderer.invoke('jobs:list', projectId),
  listStages: () => ipcRenderer.invoke('jobs:stages'),
  staleWorks: (projectId) => ipcRenderer.invoke('jobs:staleWorks', projectId),
  queueSettings: () => ipcRenderer.invoke('jobs:settings'),
  modelSettings: () => ipcRenderer.invoke('llm:settings'),
  setModelSettings: (next) => ipcRenderer.invoke('llm:setSettings', next),
  resetModelSettings: () => ipcRenderer.invoke('llm:resetSettings'),
  availableModels: () => ipcRenderer.invoke('llm:models'),
  setQueueSettings: (next) => ipcRenderer.invoke('jobs:setSettings', next.llm, next.local),
  resetQueueSettings: () => ipcRenderer.invoke('jobs:resetSettings'),
  onJobsChanged: (cb) => {
    // The raw IpcRendererEvent never reaches the renderer callback — it carries
    // `sender`, which would hand the renderer a way back into main.
    const listener = (): void => cb()
    ipcRenderer.on('jobs:changed', listener)
    return () => ipcRenderer.removeListener('jobs:changed', listener)
  },
  onSummariesChanged: (cb) => {
    // Same event-dropping wrapper as above, and for the same reason: the raw
    // IpcRendererEvent carries `sender`.
    const listener = (): void => cb()
    ipcRenderer.on('summaries:changed', listener)
    return () => ipcRenderer.removeListener('summaries:changed', listener)
  },
  // tabs — main owns the model; none of these takes a window id, because the
  // calling window is resolved from the sender in main.
  tabsState: () => ipcRenderer.invoke('tabs:state'),
  tabsOpen: (input) => ipcRenderer.invoke('tabs:open', input),
  tabsActivate: (input) => ipcRenderer.invoke('tabs:activate', input),
  tabsClose: (input) => ipcRenderer.invoke('tabs:close', input),
  tabsReorder: (input) => ipcRenderer.invoke('tabs:reorder', input),
  tabsDetach: (input) => ipcRenderer.invoke('tabs:detach', input),
  tabsAdopt: () => ipcRenderer.invoke('tabs:adopt', {}),
  tabsSetRoute: (input) => ipcRenderer.invoke('tabs:setRoute', input),
  tabsSetTitle: (input) => ipcRenderer.invoke('tabs:setTitle', input),
  tabsSetViewState: (input) => ipcRenderer.invoke('tabs:setViewState', input),
  onTabsChanged: (cb) => {
    // Same event-dropping wrapper as the two signals above: the raw
    // IpcRendererEvent carries `sender`, which would hand the renderer a way back
    // into main.
    const listener = (): void => cb()
    ipcRenderer.on('tabs:changed', listener)
    return () => ipcRenderer.removeListener('tabs:changed', listener)
  },

  // plugins — none of these is an MCP tool; see the note at the handlers in
  // `src/main/index.ts`. Parameters are NAMED, as everywhere here.
  listPlugins: () => ipcRenderer.invoke('plugins:list'),
  setPluginEnabled: (pluginId, enabled) => ipcRenderer.invoke('plugins:setEnabled', pluginId, enabled),
  configurePlugin: (input) => ipcRenderer.invoke('plugins:configure', input),
  testPluginConnection: (pluginId) => ipcRenderer.invoke('plugins:testConnection', pluginId),
  runPluginSetup: (pluginId, actionId) => ipcRenderer.invoke('plugins:runSetup', pluginId, actionId),
  addPluginFromFolder: () => ipcRenderer.invoke('plugins:addFromFolder'),
  updatePluginFromFolder: (pluginId) => ipcRenderer.invoke('plugins:updateFromFolder', pluginId),
  removePlugin: (pluginId) => ipcRenderer.invoke('plugins:remove', pluginId),
  restorePlugin: (pluginId) => ipcRenderer.invoke('plugins:restore', pluginId),
  // The plugin repository. The key travels ONE WAY, in `connect` and `test`, and
  // is never in anything that comes back — `PluginRepositoryDTO` carries
  // `hasKey`, exactly as `GatewayConfigDTO` does.
  getPluginRepository: () => ipcRenderer.invoke('repository:get'),
  testPluginRepository: (input) => ipcRenderer.invoke('repository:test', input),
  connectPluginRepository: (input) => ipcRenderer.invoke('repository:connect', input),
  disconnectPluginRepository: () => ipcRenderer.invoke('repository:disconnect'),
  syncPluginRepository: () => ipcRenderer.invoke('repository:sync'),
  listShares: () => ipcRenderer.invoke('sharing:listShares'),
  shareProject: (projectId) => ipcRenderer.invoke('sharing:shareProject', projectId),
  joinProject: (input) => ipcRenderer.invoke('sharing:joinProject', input),
  unshareProject: (projectId) => ipcRenderer.invoke('sharing:unshareProject', projectId),
  syncNow: () => ipcRenderer.invoke('sharing:syncNow'),
  onSharesChanged: (cb) => {
    // The same event-dropping wrapper as the signals above, and for the same
    // reason: the raw IpcRendererEvent carries `sender`.
    const listener = (): void => cb()
    ipcRenderer.on('shares:changed', listener)
    return () => ipcRenderer.removeListener('shares:changed', listener)
  },

  retryJob: (jobId) => ipcRenderer.invoke('jobs:retry', jobId),
  cancelJob: (jobId) => ipcRenderer.invoke('jobs:cancel', jobId),
  getQueueState: () => ipcRenderer.invoke('jobs:state'),
  pauseQueue: () => ipcRenderer.invoke('jobs:pause'),
  resumeQueue: () => ipcRenderer.invoke('jobs:resume'),
  setJobDismissed: (jobId, dismissed, projectId) =>
    ipcRenderer.invoke('jobs:setDismissed', jobId, dismissed, projectId),

  // ingest / analysis
  ingest: (input) => ipcRenderer.invoke('ingest:run', input),
  attachPdfPath: (input) => ipcRenderer.invoke('ingest:attachPdfPath', input),
  pickIngestFiles: () => ipcRenderer.invoke('ingest:pickFiles'),
  expandIngestPaths: (paths) => ipcRenderer.invoke('ingest:expandPaths', paths),
  // Electron 33 removed the `File.path` augmentation, so a dropped file's real
  // path is ONLY reachable through webUtils — and only from the preload, which
  // is why this is bridged rather than read in the renderer. Returns '' for a
  // File the runtime will not locate (e.g. one synthesised in-page).
  getDroppedPath: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  getViewPref: (key) => ipcRenderer.invoke('settings:getViewPref', key),
  setViewPref: (key, value) => ipcRenderer.invoke('settings:setViewPref', key, value),
  getDevLogStatus: () => ipcRenderer.invoke('settings:devLogStatus'),
  setDevLogEnabled: (enabled) => ipcRenderer.invoke('settings:setDevLog', enabled),
  openDevLogDir: () => ipcRenderer.invoke('settings:openDevLogDir'),
  getTokenUsage: (q) => ipcRenderer.invoke('analytics:tokenUsage', q),
  getSummaryPrompt: (input) => ipcRenderer.invoke('settings:getSummaryPrompt', input),
  setSummaryPrompt: (input) => ipcRenderer.invoke('settings:setSummaryPrompt', input),
  runAnalysis: (input) => ipcRenderer.invoke('analysis:run', input),

  // search
  search: (query, projectId, filters) =>
    ipcRenderer.invoke('search:query', query, projectId, filters),
  countSearch: (query, projectId, filters) =>
    ipcRenderer.invoke('search:count', query, projectId, filters),
  getFacets: (projectId, query, filters) =>
    ipcRenderer.invoke('search:facets', projectId, query, filters),
  searchWeb: (query, filters) => ipcRenderer.invoke('search:web', query, filters),
  semanticSearch: (query, projectId, k, workId) =>
    ipcRenderer.invoke('search:semantic', query, projectId, k, workId),
  semanticCoverage: (projectId, workId) =>
    ipcRenderer.invoke('search:semanticCoverage', projectId, workId),
  listSearchHistory: (projectId) => ipcRenderer.invoke('search:listSaved', projectId),
  recordSearch: (input) => ipcRenderer.invoke('search:record', input),
  listFrontiers: (projectId) => ipcRenderer.invoke('frontier:list', projectId),
  saveFrontier: (input) => ipcRenderer.invoke('frontier:save', input),

  // pdf
  readPdf: (documentId) => ipcRenderer.invoke('pdf:read', documentId),
  readOcrWordBoxes: (documentId) => ipcRenderer.invoke('pdf:ocrWordBoxes', documentId),

  // integrations / settings
  getIntegrationsStatus: () => ipcRenderer.invoke('integrations:status'),

  // outlets
  listOutlets: (projectId) => ipcRenderer.invoke('outlets:list', projectId),
  listOutletActions: (projectId, outletId) =>
    ipcRenderer.invoke('outlets:actions', projectId, outletId),
  runOutletAction: (projectId, outletId, actionId) =>
    ipcRenderer.invoke('outlets:run', projectId, outletId, actionId),
  revealOutletFolder: (outletId) => ipcRenderer.invoke('outlets:revealFolder', outletId),
  getOutletSettings: () => ipcRenderer.invoke('outlets:getSettings'),
  updateOutletSettings: (outletId, patch) =>
    ipcRenderer.invoke('outlets:updateSettings', outletId, patch),
  previewOutletNote: (projectId, workId) =>
    ipcRenderer.invoke('outlets:previewNote', projectId, workId),

  // zotero — read-only; notes go back through an importable RDF file
  listZoteroCollections: () => ipcRenderer.invoke('zotero:collections'),
  getZoteroCollectionMap: (projectId) => ipcRenderer.invoke('zotero:getMap', projectId),
  setZoteroCollectionMap: (projectId, collectionKey) =>
    ipcRenderer.invoke('zotero:setMap', projectId, collectionKey),
  importZoteroCollection: (projectId, collectionKey) =>
    ipcRenderer.invoke('zotero:import', projectId, collectionKey),
  exportZoteroRdf: (projectId) => ipcRenderer.invoke('zotero:exportRdf', projectId),

  // zotero connection — the write direction, performed BY a running Zotero
  isZoteroRunning: () => ipcRenderer.invoke('zotero:isRunning'),
  listZoteroTargets: () => ipcRenderer.invoke('zotero:targets'),
  getZoteroConnection: (projectId) => ipcRenderer.invoke('zotero:getConnection', projectId),
  connectZotero: (projectId, targetId, targetName) =>
    ipcRenderer.invoke('zotero:connect', projectId, targetId, targetName),
  disconnectZotero: (projectId) => ipcRenderer.invoke('zotero:disconnect', projectId),

  // storage locations
  listBaseDirs: () => ipcRenderer.invoke('storage:baseDirs'),
  pickDirectory: () => ipcRenderer.invoke('storage:pickDirectory'),
  addBaseDir: (input) => ipcRenderer.invoke('storage:addBaseDir', input),
  updateBaseDir: (baseDirId, patch) =>
    ipcRenderer.invoke('storage:updateBaseDir', { id: baseDirId, patch }),
  removeBaseDir: (baseDirId) => ipcRenderer.invoke('storage:removeBaseDir', baseDirId),
  revealBaseDir: (baseDirId) => ipcRenderer.invoke('storage:revealBaseDir', baseDirId),

  listModels: () => ipcRenderer.invoke('settings:models'),
  getSelectedModel: () => ipcRenderer.invoke('settings:getSelectedModel'),
  setSelectedModel: (modelId) => ipcRenderer.invoke('settings:setSelectedModel', modelId),
  getLlmStatus: () => ipcRenderer.invoke('settings:llmStatus'),
  recheckLlmStatus: () => ipcRenderer.invoke('settings:llmRecheck'),
  onLlmStatusChanged: (cb) => {
    // The same event-dropping wrapper as the signals above, and for the same
    // reason: the raw IpcRendererEvent carries `sender`.
    const listener = (_e: unknown, status: LlmStatusDTO): void => cb(status)
    ipcRenderer.on('settings:llmStatusChanged', listener)
    return () => {
      ipcRenderer.removeListener('settings:llmStatusChanged', listener)
    }
  },
  getGatewayConfig: () => ipcRenderer.invoke('settings:gatewayConfig'),
  setGatewayConfig: (input) => ipcRenderer.invoke('settings:setGatewayConfig', input),
  getStorageUsage: () => ipcRenderer.invoke('settings:storageUsage'),

  // MCP connector — the INBOUND side (agents that call this app), as opposed to
  // the gateway fields above, which are the outbound one.
  getMcpStatus: () => ipcRenderer.invoke('mcp:status'),
  setMcpEnabled: (enabled) => ipcRenderer.invoke('mcp:setEnabled', enabled),
  setMcpOptions: (options) => ipcRenderer.invoke('mcp:setOptions', options),
  getMcpToken: () => ipcRenderer.invoke('mcp:token'),
  regenerateMcpToken: () => ipcRenderer.invoke('mcp:regenerateToken'),
  getMcpClientConfig: (variant) => ipcRenderer.invoke('mcp:clientConfig', variant),
  openMcpAuditDir: () => ipcRenderer.invoke('mcp:openAuditDir'),

  updateState: () => ipcRenderer.invoke('update:state'),
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  cancelUpdateDownload: () => ipcRenderer.invoke('update:cancel'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  revealUpdateFile: () => ipcRenderer.invoke('update:reveal'),
  onUpdateState: (cb) => {
    const listener = (_e: unknown, state: UpdateStateDTO): void => cb(state)
    ipcRenderer.on('update:state', listener)
    return () => {
      ipcRenderer.removeListener('update:state', listener)
    }
  },

  listLicences: () => ipcRenderer.invoke('settings:licences'),
  getLicenceText: (licenceId) => ipcRenderer.invoke('settings:licenceText', licenceId),

  // export
  exportProject: (projectId, format) => ipcRenderer.invoke('export:project', projectId, format),
  listExportOptions: (projectId) => ipcRenderer.invoke('export:options', projectId),
  exportProjectToFile: (projectId, optionId) =>
    ipcRenderer.invoke('export:projectToFile', projectId, optionId),
  // Takes the opaque id main minted for a file IT wrote — never a path, so the
  // renderer cannot ask the OS to open an arbitrary filesystem location.
  revealExport: (exportId) => ipcRenderer.invoke('export:reveal', exportId),

  // settings transfer. No decrypted value crosses here in either direction:
  // main describes the items and keys the file by an opaque handle.
  listExportableSettings: () => ipcRenderer.invoke('settings:listExportable'),
  exportSettingsToFile: (itemIds) => ipcRenderer.invoke('settings:exportToFile', itemIds),
  readSettingsFile: () => ipcRenderer.invoke('settings:readFile'),
  applySettings: (handle, itemIds) => ipcRenderer.invoke('settings:applyFile', handle, itemIds),
  closeSettingsFile: () => ipcRenderer.invoke('settings:closeFile'),

  // window controls for the frameless custom title bar. No window id is ever
  // sent: main resolves the window from the IPC sender.
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    onMaximizedChanged: (cb) => {
      // The raw IpcRendererEvent is NOT forwarded to the renderer callback (it
      // would leak `sender`); only the sanitized boolean crosses.
      const listener = (_e: unknown, maximized: unknown): void => cb(maximized === true)
      ipcRenderer.on('window:maximizedChanged', listener)
      return () => ipcRenderer.removeListener('window:maximizedChanged', listener)
    },
    setBounds: (bounds) => ipcRenderer.invoke('window:setBounds', bounds),
    onQuitState: (cb) => {
      // Only the sanitized state object crosses; the IpcRendererEvent (which
      // carries `sender`) is dropped, as everywhere else on this bridge.
      const listener = (_e: unknown, state: unknown): void => cb(state as QuitStateDTO)
      ipcRenderer.on('window:quitState', listener)
      return () => ipcRenderer.removeListener('window:quitState', listener)
    },
    getQuitState: () => ipcRenderer.invoke('window:quitState'),
    quitDecision: (choice) => ipcRenderer.invoke('window:quitDecision', choice)
  },

  // paper text, resolution, stage runs, byte import
  findInPaper: (input) => ipcRenderer.invoke('paper:findText', input),
  getPaperText: (input) => ipcRenderer.invoke('paper:text', input),
  paragraphTexts: (documentId) => ipcRenderer.invoke('paper:paragraphTexts', { documentId }),
  resolvePaper: (paperRef, kind) => ipcRenderer.invoke('paper:resolve', paperRef, kind),
  getJob: (jobId) => ipcRenderer.invoke('jobs:get', jobId),
  listStageRuns: (filter) => ipcRenderer.invoke('stageRuns:list', filter),
  importPdfBytes: (input) => ipcRenderer.invoke('ingest:pdfBytes', input),
  reprocessWork: (workId, projectId, force) =>
    ipcRenderer.invoke('jobs:reprocessWork', workId, projectId, force),
  rerunStage: (workId, stage, projectId) =>
    ipcRenderer.invoke('jobs:rerunStage', workId, stage, projectId),
  rerunStages: (workId, stages, projectId) =>
    ipcRenderer.invoke('jobs:rerunStages', workId, stages, projectId)
}

// ---------------------------------------------------------------- IPC idle
//
// Every screen loads through `window.api`, so "the renderer has stopped working"
// is exactly "no api call is in flight, and none started in reply to the last
// one that finished". Counting the calls here — at the ONE place they all pass
// through — turns that into an observable fact.
//
// It exists for the console-error specs. Those flush pending errors before
// asserting, and a fixed sleep makes that a race in the direction that HIDES
// bugs: an error arriving 20 ms after a 300 ms sleep is never seen, so on a
// loaded machine the test passes precisely when there is something to report.
// `whenIdle()` waits for the work itself instead, so the wait cannot end while
// the app is still loading a screen.
//
// It is not a total-quiescence oracle, and should not be described as one: it
// tracks api calls, so a rejection from a bare `setTimeout` path is still
// outside its view, and React can commit from a `.then` on a scheduler
// macrotask AFTER the `.finally` decrement — which is why several consecutive
// quiet frames are required rather than one. It is a strictly stronger signal
// than a duration guess, not a proof.
//
// The counter wraps the api rather than living in the renderer because the
// renderer must not see raw `ipcRenderer`, and a renderer-side wrapper could be
// bypassed by any code holding the original function.
//
// ENABLED ONLY UNDER `CORPUS_TEST_HOOKS=1`, which the e2e fixture sets. A
// production build therefore pays no per-call promise hop and exposes no extra
// surface at all — the hook cannot be reached by anything the user runs.
const testHooks = process.env.CORPUS_TEST_HOOKS === '1'
let pending = 0
function counted<T extends (...a: never[]) => unknown>(fn: T): T {
  return ((...args: never[]) => {
    const out = fn(...args)
    if (out instanceof Promise) {
      pending++
      return out.finally(() => {
        pending--
      })
    }
    return out
  }) as T
}
if (testHooks) {
  for (const obj of [api, api.window] as unknown as Array<Record<string, unknown>>) {
    for (const key of Object.keys(obj)) {
      const v = obj[key]
      if (typeof v === 'function') obj[key] = counted(v as (...a: never[]) => unknown)
    }
  }

  contextBridge.exposeInMainWorld('corpusTest', {
    pendingCalls: () => pending,
    /**
     * Resolve once no api call has been in flight for `quietFrames` consecutive
     * animation frames. Frames rather than milliseconds because a frame is the
     * unit React actually commits in: a resolved call that schedules a re-render
     * which fires an effect which starts the NEXT call is caught, since `pending`
     * goes back above zero before the streak completes. `budgetMs` bounds a
     * pathological loop so a hung app fails as a timeout, never as a hang.
     */
    whenIdle: (quietFrames = 3, budgetMs = 15_000): Promise<void> =>
      new Promise((resolve, reject) => {
        // Preload is type-checked with tsconfig.node.json (it IS a Node context —
        // it may `require`), but it executes attached to the page, so the DOM
        // clock is genuinely there. Reaching for it through `globalThis` states
        // that rather than widening the whole preload's lib to the DOM, which
        // would let a real mistake — say `document` in main-adjacent code — pass.
        const raf = (globalThis as unknown as { requestAnimationFrame: (cb: () => void) => void })
          .requestAnimationFrame
        let done = false
        const finish = (err?: Error): void => {
          if (done) return
          done = true
          if (err) reject(err)
          else resolve()
        }
        // The budget is enforced by a TIMER as well as inside the tick, because
        // Chromium throttles rAF in an occluded or backgrounded window — and under
        // xvfb that happens. With the check only inside the tick, a throttled
        // frame loop would neither resolve nor reject, and the caller would hang
        // to the harness's own timeout with no explanation of why.
        const timer = setTimeout(
          () => finish(new Error(`whenIdle: still busy after ${budgetMs}ms (${pending} in flight)`)),
          budgetMs
        )
        let quiet = 0
        const tick = (): void => {
          if (done) return
          if (pending > 0) quiet = 0
          else quiet++
          if (quiet >= quietFrames) {
            clearTimeout(timer)
            return finish()
          }
          raf(tick)
        }
        raf(tick)
      })
  })
}

contextBridge.exposeInMainWorld('api', api)
