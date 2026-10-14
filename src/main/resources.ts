// Single source of truth for locating SHIPPED, NON-JS payloads: bundled
// binaries (qpdf), wasm + model data (tesseract core, eng.traineddata), an
// embedding model file, and the Python sidecar.
//
// These cannot be `import`ed — they are spawned, dlopen'd or streamed — so
// their location differs between running from source and running from an
// installer, and a path that works in dev and breaks in the installer is the
// classic packaging failure. Every consumer MUST go through `resourcePath()`.
//
// Like `db/paths.ts` this module deliberately imports nothing from `electron`:
// the seed/verify/report scripts run under `ELECTRON_RUN_AS_NODE=1`, where the
// `app` object is undefined and `app.isPackaged` cannot be consulted.
//
// Layout:
//   dev       <repo>/resources/<segs>            (and scripts/data for corpus)
//   packaged  <process.resourcesPath>/app-resources/<segs>
// The packaged tree is produced by `extraResources` in electron-builder.yml,
// which places files OUTSIDE app.asar — deliberately, because an asar is not a
// real directory and nothing spawnable can be read from one.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

/** Subdirectory of `process.resourcesPath` that `extraResources` writes into. */
export const PACKAGED_RESOURCE_DIR = 'app-resources'

/**
 * True when this code is running from inside an installed application bundle.
 *
 * The test is "is my own module file located underneath `resourcesPath`", which
 * is true for app.asar, app.asar.unpacked and an `--dir` build's plain
 * `resources/app/`, and false both in dev and under `ELECTRON_RUN_AS_NODE`.
 * A bare `existsSync(process.resourcesPath)` would NOT work: under
 * ELECTRON_RUN_AS_NODE that variable is set and points at the vendored
 * electron's own resources dir, so every CLI script would claim to be packaged.
 */
export function isPackaged(): boolean {
  const rp = process.resourcesPath
  if (!rp) return false
  const root = resolve(rp) + sep
  return resolve(__dirname).startsWith(root)
}

/** Bound the upward walk so a bad start directory can never loop forever. */
const MAX_WALK_DEPTH = 12

/**
 * The repository root in dev — found by walking up from this module (and cwd)
 * looking for the manifest. `__dirname` is `<repo>/src/main` under tsx and
 * `<repo>/out/main` for the built bundle, so the walk covers both.
 */
function devRoot(): string {
  const seen: string[] = []
  for (const start of [__dirname, process.cwd()]) {
    let dir = resolve(start)
    for (let i = 0; i < MAX_WALK_DEPTH; i++) {
      if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'electron.vite.config.ts'))) {
        return dir
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    seen.push(start)
  }
  throw new Error(
    `Could not locate the repository root by walking up from ${seen.join(' or ')}. ` +
      `Set CORPUS_RESOURCES_DIR to the resources directory.`
  )
}

/**
 * The repository root, or null when there is none to find.
 *
 * Same walk as `devRoot()` but non-throwing, for callers that treat "not running
 * from a checkout" as an ordinary branch rather than an error — a packaged app
 * has no repo, and asking for one there is a question with a legitimate "no".
 */
export function repoRootOrNull(): string | null {
  try {
    return devRoot()
  } catch {
    return null
  }
}

/** The root of the shipped-resources tree for the current execution mode. */
export function resourcesRoot(): string {
  const override = process.env.CORPUS_RESOURCES_DIR
  if (override && override.trim()) return resolve(override)
  if (isPackaged()) return join(process.resourcesPath, PACKAGED_RESOURCE_DIR)
  return join(devRoot(), 'resources')
}

/**
 * Absolute path to a shipped resource, e.g.
 *   resourcePath('bin', process.platform, qpdfExe)
 *   resourcePath('tesseract', 'tessdata', 'eng.traineddata')
 *   resourcePath('models', 'all-MiniLM-L6-v2.q8.onnx')
 *
 * Returns a path whether or not the file exists — callers that treat a missing
 * payload as a `skipped` outcome need to distinguish "not shipped on this
 * platform" from "wrong path", so use `resourceExists()` rather than catching.
 */
export function resourcePath(...segments: string[]): string {
  return join(resourcesRoot(), ...segments)
}

/** Whether a shipped resource is actually present in this build. */
export function resourceExists(...segments: string[]): boolean {
  return existsSync(resourcePath(...segments))
}

/**
 * A file inside a BUNDLED PLUGIN's own payload directory.
 *
 * Plugins are shipped beside the app's resources rather than inside them
 * (`electron-builder.yml` maps `plugins/` → `app-resources/plugins/`), and a
 * bundled plugin that carries a payload of its own — a browser extension, a
 * binary, a model — keeps it in its own folder. That is where it belongs: an
 * install without the plugin has no use for it.
 *
 * This exists so the app's own PAYLOAD GATE can still probe for it. That is not
 * a contradiction: a bundled plugin's payload is part of the installer, so a
 * build produced without running the sync script is a build that is short, and
 * the gate is what turns that into a build failure instead of a Settings panel
 * that can offer the user nothing and cannot say why.
 *
 * NOT a general "reach into a plugin" verb — it takes a plugin id and resolves
 * only inside that plugin's `resources/`, and nothing but the gate uses it. A
 * plugin reads its OWN payload from its own module path, which is what makes an
 * added plugin work identically to a bundled one.
 */
export function bundledPluginResourcePath(pluginId: string, ...segments: string[]): string {
  // `CORPUS_RESOURCES_DIR` FIRST, exactly as `resourcesRoot()` honours it, and
  // for the case it exists for: `verify:payloads` points it at a BUILT tree
  // (`release/linux-unpacked/resources/app-resources`) and runs under
  // ELECTRON_RUN_AS_NODE, where `isPackaged()` is false — so without this the
  // check would probe the developer's checkout and pass over a packaged build
  // that shipped nothing.
  const override = process.env.CORPUS_RESOURCES_DIR
  const root = override && override.trim()
    ? join(resolve(override), 'plugins')
    : isPackaged()
      ? join(process.resourcesPath, PACKAGED_RESOURCE_DIR, 'plugins')
      // NON-THROWING. This is called from a payload PROBE, whose whole job is to
      // answer "is this file here"; `devRoot()` throws outside a checkout, which
      // would turn a missing payload into a crashed gate that reports nothing.
      : join(repoRootOrNull() ?? '', 'plugins')
  return join(root, pluginId, 'resources', ...segments)
}

/**
 * The host's payload key, `<platform>-<arch>` — e.g. `linux-x64`,
 * `darwin-arm64`, `win32-x64`. It is the directory name under `bin/` and
 * `lib/` and the platform key in `resources/payloads.json`.
 *
 * ARCH IS PART OF THE KEY, deliberately. macOS ships separate x64 and arm64
 * applications and upstream publishes a different sqlite-vec dylib for each, so
 * a platform-only path would load the wrong binary on half of all Macs — and
 * would do it as a `dlopen` failure at first search, far from the cause.
 */
export function platformKey(): string {
  return `${process.platform}-${process.arch}`
}

/** The `optimize` stage's qpdf binary for this host, whether or not it exists. */
export function qpdfPath(): string {
  return resourcePath('bin', platformKey(), process.platform === 'win32' ? 'qpdf.exe' : 'qpdf')
}

/**
 * The WASM qpdf, for hosts where no native one exists. Path only; may not exist.
 *
 * macOS gets this and nothing else, because upstream publishes no macOS binary —
 * v12.3.2 ships linux-x86_64, mingw32/64, msvc32/64, an AppImage and source — and
 * this repo has no macOS build host to make one. The choice on a Mac is therefore
 * a wasm qpdf or no `optimize` stage at all, which is how it shipped until now:
 * every paper on every Mac was told, once each, that a tool the installer was
 * supposed to contain was missing.
 *
 * The glue is loaded beside its `.wasm`; Emscripten resolves the latter through
 * `locateFile`, so both names matter and both are pinned in `payloads.json`.
 */
export function qpdfWasmPath(): string {
  return resourcePath('bin', platformKey(), 'qpdf.js')
}

/**
 * The application mark, as a file a BrowserWindow can be given.
 *
 * The window is frameless, but a frameless X11 window still advertises
 * `_NET_WM_ICON`, and that is what a taskbar, an alt-tab switcher and a dock
 * draw. Electron's default there is its own logo, so without this the app is a
 * different product everywhere outside its own window. `.desktop`-based
 * launchers read the installed hicolor icon instead — both come from the same
 * `src/renderer/logo.png` via `scripts/make-icons.sh`.
 */
export function appIconPath(): string {
  return resourcePath('icon.png')
}

/** The sqlite-vec loadable extension for this host, whether or not it exists. */
export function sqliteVecPath(): string {
  const file =
    process.platform === 'win32' ? 'vec0.dll' : process.platform === 'darwin' ? 'vec0.dylib' : 'vec0.so'
  return resourcePath('lib', platformKey(), file)
}

/**
 * The directory holding `eng.traineddata`.
 *
 * This must be passed to tesseract.js as `langPath`. Left unset, tesseract.js
 * downloads the file from jsdelivr on first use (`worker-script/index.js`
 * defaults `langPath` to a `cdn.jsdelivr.net` URL) — which would silently break
 * the offline rule. With `langPath` local and the file absent it fails with
 * ENOENT instead, which is the behaviour we want: loud, not degraded.
 */
export function tessdataDir(): string {
  return resourcePath('tesseract', 'tessdata')
}

/**
 * The root passed to `@huggingface/transformers` as `env.localModelPath`. The
 * library appends `<org>/<model>/…` itself, so this is the directory ABOVE the
 * org, not the model directory.
 */
export function modelsDir(): string {
  return resourcePath('models')
}

/**
 * The same root for the RERANKER, and a SIBLING of `models/` rather than a
 * directory inside it.
 *
 * `discoverModelId()` in `embedding/space.ts` walks `modelsDir()` and THROWS
 * when a second `<org>/<model>/onnx/` turns up, because "which space answered
 * this search" must have one derivable answer. Filing the cross-encoder under
 * `models/` would trip that throw, and the tempting repair — an exclusion list
 * — turns a structural guarantee ("this root holds exactly one model, by
 * construction") into a maintained one ("exactly one I have not listed"), which
 * the third model either ratchets or silently breaks. One root per ROLE keeps
 * the invariant a fact about the filesystem.
 */
export function rerankersDir(): string {
  return resourcePath('rerankers')
}

/**
 * Platform keys on which a payload is a BUILD REQUIREMENT rather than a nicety.
 *
 * `resources/payloads.json` marks qpdf `optional: true`, and that is true of the
 * ARCHITECTURE — the `optimize` stage is a transformer whose absence changes no
 * downstream input. It is NOT true of a build we ship. A user watching their own
 * papers being read must never be told, once per paper, that a tool the
 * installer was supposed to contain is missing; that is an unshipped build
 * leaking into a scientist's queue as if it were a fact about their document.
 *
 * A platform is required by being LISTED. qpdf now names its darwin keys: they
 * carry the WASM build (`payloads.json`), which is architecture-independent and
 * therefore needs no macOS build host — so the reason they were excluded is gone
 * and requiring them is no longer a lie that would fail every macOS build. It
 * names no `linux-arm64` key, and that is a REAL GAP rather than a decision —
 * see `PAYLOAD_PROBES` below, which reports it as an unavailable platform so it
 * is stated once rather than discovered per paper.
 */
const REQUIRED_ON: Record<string, readonly string[]> = {
  qpdf: ['linux-x64', 'win32-x64', 'darwin-x64', 'darwin-arm64'],
  'sqlite-vec': ['linux-x64', 'linux-arm64', 'win32-x64', 'darwin-x64', 'darwin-arm64'],
  'tessdata-eng': ['*'],
  'embedding-model': ['*'],
  'reranker-model': ['*']
}

/**
 * The file whose absence means a payload is not in this build, per payload id.
 *
 * Keyed by the SAME ids as `REQUIRED_ON`, and the two are cross-checked below:
 * an id required but never probed is a declaration that enforces nothing, which
 * is worse than no declaration at all because it reads like a guarantee. That
 * had already happened — `embedding-model` was marked required on every
 * platform while no probe existed for it, so the startup gate and
 * `verify:payloads` could not have caught a build shipped without the model,
 * and the user would have met it per paper as "no embedding model is packaged
 * in this build".
 *
 * A payload is many files; the probe is the one that cannot be missing if the
 * payload is really there (the executable, the extension, the weights).
 */
const PAYLOAD_PROBES: Record<string, () => string> = {
  // The probe follows the FLAVOUR this platform actually ships. macOS carries the
  // wasm glue and no `qpdf` executable, so probing for the executable there would
  // report a correctly provisioned build as missing its payload — the same class
  // of mistake as looking under `bin/linux` for a file provisioned to
  // `bin/linux-x64`, which once made a working qpdf invisible to every check.
  qpdf: () => (process.platform === 'darwin' ? qpdfWasmPath() : qpdfPath()),
  'sqlite-vec': sqliteVecPath,
  'tessdata-eng': () => join(tessdataDir(), 'eng.traineddata'),
  'embedding-model': () =>
    join(modelsDir(), 'Snowflake', 'snowflake-arctic-embed-s', 'onnx', 'model_quantized.onnx'),
  'reranker-model': () =>
    join(
      rerankersDir(),
      'cross-encoder',
      'ms-marco-MiniLM-L-6-v2',
      'onnx',
      'model_quantized.onnx'
    )
}

for (const id of Object.keys(REQUIRED_ON)) {
  if (!(id in PAYLOAD_PROBES)) {
    throw new Error(
      `resources.ts: payload '${id}' is declared in REQUIRED_ON but has no probe in ` +
        'PAYLOAD_PROBES, so nothing would ever check it.'
    )
  }
}

/**
 * Why a payload cannot exist on a platform at all. A build that cannot carry
 * something must say so ONCE, as a property of the platform, rather than
 * letting every document discover it separately.
 */
const UNAVAILABLE_ON: Record<string, Record<string, string>> = {
  qpdf: {
    'darwin-x64': 'no macOS build host; see docs/packaging.md',
    'darwin-arm64': 'no macOS build host; see docs/packaging.md',
    'linux-arm64': 'not provisioned for linux-arm64; see docs/packaging.md'
  }
}

export interface PayloadPrecondition {
  id: string
  /** The file whose absence is the failure. */
  path: string
  present: boolean
  /** True when this host's build is required to carry it. */
  required: boolean
  /** Set when the platform genuinely cannot have it — a condition, not a bug. */
  unavailableReason: string | null
}

/**
 * Every payload precondition for THIS host, as data.
 *
 * One function, consulted by all three enforcement points (the packaging gate,
 * `verify:payloads`, and the main process at startup) so they cannot drift into
 * disagreeing about what a complete build contains — which is exactly how the
 * `optimize` stage came to look for qpdf in a directory nothing provisions.
 */
export function payloadPreconditions(): PayloadPrecondition[] {
  const key = platformKey()
  const own = Object.entries(PAYLOAD_PROBES).map(([id, probe]) => {
    const on = REQUIRED_ON[id] ?? []
    const path = probe()
    return {
      id,
      path,
      present: existsSync(path),
      required: on.includes('*') || on.includes(key),
      unavailableReason: UNAVAILABLE_ON[id]?.[key] ?? null
    }
  })
  return [...own, ...bundledPluginPayloads()]
}

/**
 * The payloads BUNDLED PLUGINS declare, read from their manifests.
 *
 * DISCOVERED, never listed. This gate once carried a plugin's id in two tables
 * of its own, which made the app's packaging favour one plugin by name: swap
 * that plugin for another and the gate went on demanding a folder nothing
 * shipped, while the replacement's payload was checked by nobody.
 *
 * Required on EVERY platform, because a plugin the installer carries is part of
 * the installer: if its payload is absent the build is short, whatever the
 * plugin turns out to do. A plugin the user ADDED is not here — that folder is
 * their business and its absence is not a defect in this build.
 *
 * Reads the manifest as JSON rather than through the plugin host: this runs in
 * the packaging gate and in `verify:payloads`, neither of which has an app, a
 * database or a loaded plugin, and none of which should load a stranger's code
 * to find out whether a file exists.
 */
function bundledPluginPayloads(): PayloadPrecondition[] {
  // Resolved HERE rather than imported from `plugins/paths.ts`, which imports
  // this module — the cycle would be real, and the two lines it saves are the
  // same two lines that file spends.
  const env = process.env.CORPUS_BUNDLED_PLUGINS_DIR
  const dir =
    env !== undefined
      ? env.trim() || null
      : isPackaged()
        ? join(process.resourcesPath, PACKAGED_RESOURCE_DIR, 'plugins')
        : repoRootOrNull() === null
          ? null
          : join(repoRootOrNull() as string, 'plugins')
  if (dir === null || !existsSync(dir)) return []
  const out: PayloadPrecondition[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(dir, entry.name, 'plugin.json')
    if (!existsSync(manifestPath)) continue
    let declared: unknown
    try {
      declared = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch {
      // Not this gate's business to report. A manifest that will not parse is a
      // plugin that will not load, which the host says in the pane the user is
      // looking at — saying it again here as a missing PAYLOAD would name the
      // wrong fault.
      continue
    }
    const m = declared as { id?: unknown; payload?: unknown }
    if (typeof m.payload !== 'string' || m.payload.length === 0) continue
    // The id names the FOLDER's plugin, so a manifest claiming someone else's id
    // cannot point this gate at a path outside its own directory.
    const id = typeof m.id === 'string' && m.id.length > 0 ? m.id : entry.name
    // Contained by construction: joined under the plugin's own folder and
    // rejected if it climbs out, which the manifest schema also refuses.
    const path = join(dir, entry.name, m.payload)
    const root = join(dir, entry.name)
    if (!path.startsWith(root + sep)) continue
    out.push({ id, path, present: existsSync(path), required: true, unavailableReason: null })
  }
  return out
}

/**
 * The payloads this build was required to carry and does not.
 *
 * Empty is the only acceptable answer for a shipped build. A non-empty result
 * means the tree was never provisioned (`npm run payloads`) — a developer-side
 * mistake, which belongs in a build failure and a startup log, never in the
 * queue.
 */
export function missingRequiredPayloads(): PayloadPrecondition[] {
  return payloadPreconditions().filter((p) => p.required && !p.present)
}
