import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { userDataDir } from '../db/paths'
import { getDb } from '../db/connection'
import { getSetting, setSetting } from '../db/repositories'
import { registerSecret } from '../mcp/redact'
import { LIMITS, ManifestError, MANIFEST_VERSION } from './manifest'
import { extractPluginZip } from './unzip'
import type { SafeStorageLike } from './services'
import type { PluginRepositoryDTO } from '../../shared/contract/plugins'
import {
  installedPluginVersions,
  installPlugin,
  updatePlugin,
  anyPluginLifecycleBusy,
  isPluginRemoved
} from './host'
import { setRepositorySupplied, repositorySuppliedIds } from './source'

/**
 * A PLUGIN REPOSITORY: one address, one key, and the whole set it offers.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT CONNECTING MEANS. Not a catalogue and not a shop. A repository is a SET,
 * and connecting to one is consenting to take the set — everything it offers is
 * installed and kept current, without a prompt per plugin. There is no browsing
 * here because there is nothing to choose between.
 *
 * That is a real transfer of authority and it is stated as one on the card: the
 * plugins run with this app's full privileges (there is no trust boundary after
 * install — see `CLAUDE.md` in this folder), so whoever controls the repository
 * chooses what runs on the machine. What the user KEEPS is authority over what
 * EXECUTES: the Off toggle is untouched for a repository plugin, so one can be
 * installed, kept current and running nothing. What they give up is authority
 * over what is INSTALLED, which is the thing they were asked about.
 *
 * ONE REPOSITORY, not a list. Two would mean two sets that can offer the same
 * id, and the app would have to decide which supplier wins — a decision nobody
 * can be asked to make in a settings pane, and one whose wrong answer is a
 * silent substitution of somebody else's code.
 *
 * WHAT THIS FILE IS NOT ALLOWED TO CONTAIN is a second copy of the installer.
 * A downloaded archive is unpacked (`unzip.ts`) into a temporary directory and
 * then handed to the SAME `installPluginFolder`/`updatePluginFolder` a folder
 * the user picked goes through, so the symlink refusal, the hardlink check, the
 * re-accumulated byte total, the copy-time `lstat` and the 0600 mode exist in
 * exactly one place.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const ADDRESS_KEY = 'plugin.repository.address'
const LAST_CHECKED_KEY = 'plugin.repository.lastCheckedAt'
const ETAG_KEY = 'plugin.repository.etag'

/** Every four hours, per the design. Long, because a plugin release is not news. */
const CYCLE_INTERVAL_MS = 4 * 60 * 60 * 1000
/** After discovery has settled at launch, not at `whenReady`. */
const FIRST_CYCLE_DELAY_MS = 20_000

/** The index is a small JSON document; anything larger is not one. */
const INDEX_MAX_BYTES = 1024 * 1024
/** A whole archive can be no bigger than the tree it unpacks to. */
const ZIP_MAX_BYTES = LIMITS.totalBytes

const REQUEST_TIMEOUT_MS = 60_000

// ------------------------------------------------------------------ the key

/**
 * The read key, at rest.
 *
 * NOT in `setting`. The database is copied into project archives, read by every
 * plugin through `PluginCtx.db`, and opened by hand by developers; a bearer
 * credential in it is a credential in all of those. It goes into its own file
 * under userData, encrypted with the OS keyring through `safeStorage` when one
 * is available, and 0600 either way.
 *
 * `registerSecret` is called for it at every read path, so a value that reaches
 * a log line, an MCP response or an exported bug report inside somebody else's
 * error message is removed on the way out — an HTTP client echoing the request
 * it just failed is the ordinary way a bearer token escapes.
 */
function keyPath(): string {
  return join(userDataDir(), 'plugin-repository.key')
}

let safeStorage: SafeStorageLike | null = null

function readKey(): string | null {
  let raw: Buffer
  try {
    raw = readFileSync(keyPath())
  } catch {
    return null
  }
  // The marker distinguishes the two forms rather than a heuristic on the bytes:
  // a keyring that becomes available later must not make the app try to decrypt
  // a plaintext file, and one that becomes unavailable must not make it hand a
  // ciphertext to a server as a bearer token.
  if (raw.subarray(0, 4).toString('latin1') === 'enc:') {
    if (!safeStorage?.isEncryptionAvailable()) return null
    try {
      return safeStorage.decryptString(raw.subarray(4))
    } catch {
      return null
    }
  }
  const s = raw.toString('utf8').trim()
  return s.length > 0 ? s : null
}

function writeKey(key: string): void {
  const path = keyPath()
  mkdirSync(dirname(path), { recursive: true })
  if (safeStorage?.isEncryptionAvailable()) {
    const cipher = safeStorage.encryptString(key)
    writeFileSync(path, Buffer.concat([Buffer.from('enc:', 'latin1'), cipher]), { mode: 0o600 })
    return
  }
  writeFileSync(path, `${key}\n`, { mode: 0o600 })
}

function clearKey(): void {
  try {
    unlinkSync(keyPath())
  } catch {
    /* absent is the outcome asked for */
  }
}

// ------------------------------------------------------------------- state

/**
 * The last thing that went wrong, as a code and a sentence.
 *
 * IN MEMORY, not persisted, because it describes the last ATTEMPT rather than
 * the connection: a repository that was unreachable on a laptop closed in a
 * train has nothing wrong with it, and a stored failure would greet the user at
 * the next launch as though it had just happened. Hard rule 0.6 governs what is
 * shown — a healthy repository says nothing at all.
 */
let lastFailure: { code: string; sentence: string } | null = null
/** Plugins skipped this cycle with a reason, e.g. built for a later app. */
let lastSkips: string[] = []
let cycleInFlight: Promise<void> | null = null
let timer: ReturnType<typeof setInterval> | null = null
let firstTimer: ReturnType<typeof setTimeout> | null = null
let notifySink: (() => void) | null = null

export function storedAddress(): string {
  return getSetting(getDb(), ADDRESS_KEY)?.trim() ?? ''
}

/** Whether a repository is connected at all. An address AND a key, never one. */
export function isConnected(): boolean {
  return storedAddress().length > 0 && readKey() !== null
}

/**
 * What the card renders.
 *
 * The KEY IS NEVER HERE, only whether one is stored — the same shape
 * `GatewayConfigDTO` uses, and for the same reason: an IPC payload is
 * structured-cloned into a renderer that can be opened with devtools.
 */
export function repositoryForUi(): PluginRepositoryDTO {
  return {
    address: storedAddress(),
    hasKey: readKey() !== null,
    connected: isConnected(),
    lastCheckedAt: getSetting(getDb(), LAST_CHECKED_KEY),
    sentence: lastFailure?.sentence ?? null,
    code: lastFailure?.code ?? null,
    skipped: [...lastSkips],
    supplied: repositorySuppliedIds().length
  }
}

// ----------------------------------------------------------------- address

/**
 * The address, normalised, or a refusal.
 *
 * PLAIN HTTP IS REFUSED except on the loopback interface, and that is not
 * caution about eavesdropping: what comes down this channel is executed on the
 * user's machine with the app's full privileges, so anyone able to rewrite the
 * response chooses what runs here. The sha256 check does not help — the digest
 * comes down the same rewritable channel. Loopback is exempt because a plugin
 * author running the versioner on their own box is not that threat, and there is
 * nothing on the path to rewrite.
 */
function normaliseAddress(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new ManifestError(
      'bad-address',
      'That is not a web address. It should look like https://plugins.example.org.'
    )
  }
  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new ManifestError(
      'insecure-address',
      'A plugin repository must be reached over https: its plugins run on this computer with the '
        + 'same access as the app, so anyone able to change what comes back would choose what runs here.'
    )
  }
  return trimmed
}

// ------------------------------------------------------------- the wire

/**
 * One entry of `index.json`, as the versioner publishes it.
 *
 * READ FIELD BY FIELD and bounded, exactly as a plugin-authored string is shaped
 * at the host boundary: this document comes from a server the app does not
 * control, and `name`/`blurb` reach nothing here but a log, while `id`,
 * `version` and `sha256` reach a filesystem path, a version comparison and a
 * digest check. An entry that fails any of it is DROPPED rather than repaired.
 */
interface IndexEntry {
  id: string
  name: string
  version: string
  blurb: string
  sha256: string
  bytes: number
  /** Absent in the current wire format; a later one may declare it. */
  manifestVersion: number | null
}

const ID_RE = /^[a-z][a-z0-9-]{1,62}$/
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const SHA_RE = /^[0-9a-f]{64}$/

function readIndex(body: unknown): IndexEntry[] {
  const plugins = (body as { plugins?: unknown })?.plugins
  if (!Array.isArray(plugins)) {
    throw new ManifestError('bad-index', 'That address answered with something that is not a plugin repository.')
  }
  const out: IndexEntry[] = []
  for (const raw of plugins.slice(0, 200)) {
    const e = raw as Record<string, unknown>
    const id = typeof e.id === 'string' ? e.id : ''
    const version = typeof e.version === 'string' ? e.version : ''
    const sha256 = typeof e.sha256 === 'string' ? e.sha256.toLowerCase() : ''
    const bytes = typeof e.bytes === 'number' && Number.isFinite(e.bytes) ? Math.floor(e.bytes) : -1
    if (!ID_RE.test(id) || !VERSION_RE.test(version) || !SHA_RE.test(sha256)) continue
    if (bytes < 0 || bytes > ZIP_MAX_BYTES) continue
    out.push({
      id,
      name: typeof e.name === 'string' ? e.name.slice(0, 60) : id,
      version,
      blurb: typeof e.blurb === 'string' ? e.blurb.slice(0, 400) : '',
      sha256,
      bytes,
      manifestVersion:
        typeof e.manifestVersion === 'number' && Number.isFinite(e.manifestVersion)
          ? e.manifestVersion
          : null
    })
  }
  return out
}

/**
 * Is `offered` strictly newer than `installed`?
 *
 * NEWER ONLY, NEVER A DOWNGRADE, and that rule is the reason this is a
 * comparison rather than an inequality. A repository that publishes an older
 * version — by mistake, or because somebody with the publish token wants a fixed
 * hole back — must not be able to roll a whole fleet onto code its users have
 * already been moved off.
 *
 * Numeric on the three release components, then the PRE-RELEASE rule: a version
 * carrying a suffix is older than the same one without it, because `1.2.0-rc1`
 * precedes `1.2.0`. Compared as a string only when both carry one, which is
 * enough to order a repository's own sequence and is not asked to be semver.
 */
export function compareVersions(a: string, b: string): number {
  const partsOf = (v: string): { nums: number[]; pre: string } => {
    const [core, ...rest] = v.split('-')
    return { nums: core.split('.').map((n) => Number(n) || 0), pre: rest.join('-') }
  }
  const x = partsOf(a)
  const y = partsOf(b)
  for (let i = 0; i < 3; i += 1) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  if (x.pre === y.pre) return 0
  if (x.pre === '') return 1
  if (y.pre === '') return -1
  return x.pre < y.pre ? -1 : 1
}

/**
 * Read a response body under a hard cap, counting the bytes AS THEY ARRIVE.
 *
 * `content-length` is a claim, and on this path a client that lies about it is
 * the ordinary case rather than the exotic one — so the declared length is used
 * to refuse EARLY, and the counted length is what actually bounds the read.
 */
async function readBounded(res: Response, max: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > max) {
    throw new ManifestError('too-big', ARCHIVE_TOO_BIG_SENTENCE)
  }
  const body = res.body
  if (!body) return Buffer.alloc(0)
  const reader = body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      throw new ManifestError('too-big', ARCHIVE_TOO_BIG_SENTENCE)
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks, total)
}

const ARCHIVE_TOO_BIG_SENTENCE =
  'The repository sent more than a plugin is allowed to be, so nothing was installed.'

/**
 * One authenticated GET.
 *
 * EVERY failure becomes a sentence of ours. A fetch error carries the request
 * URL and sometimes the headers — which on this path include the bearer key —
 * and this string is rendered verbatim in Settings.
 */
async function get(
  address: string,
  key: string,
  path: string,
  extraHeaders: Record<string, string> = {}
): Promise<Response> {
  const res = await fetch(`${address}${path}`, {
    headers: { authorization: `Bearer ${key}`, accept: '*/*', ...extraHeaders },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    // No caching layer of Electron's between the app and a signed artifact: a
    // 304 is asked for explicitly with an ETag we hold, which is a decision, and
    // an implicit cache would make it one nobody wrote down.
    cache: 'no-store'
  })
  return res
}

/** Turn a status into the ONE sentence for it. Never an exception message. */
function sentenceForStatus(status: number): { code: string; sentence: string } {
  if (status === 401 || status === 403) {
    return {
      code: 'refused-key',
      sentence: 'That repository refused this key. Check it, or ask whoever runs the repository for a new one.'
    }
  }
  if (status === 404) {
    return {
      code: 'not-a-repository',
      sentence: 'There is no plugin repository at that address.'
    }
  }
  if (status === 429) {
    return {
      code: 'rate-limited',
      sentence: 'That repository asked this computer to wait before checking again.'
    }
  }
  return { code: 'unreachable', sentence: 'That repository answered with an error.' }
}

function sentenceForThrow(err: unknown): { code: string; sentence: string } {
  if (err instanceof ManifestError) return { code: err.code, sentence: err.message }
  const raw = err instanceof Error ? err.message : ''
  if (/abort|timeout|timed out/i.test(raw)) {
    return { code: 'timeout', sentence: 'That repository did not answer in time.' }
  }
  if (/certificate|self.signed|SSL|TLS/i.test(raw)) {
    return { code: 'certificate', sentence: 'That repository’s certificate was not accepted.' }
  }
  return { code: 'unreachable', sentence: 'That repository could not be reached.' }
}

// ------------------------------------------------------------- the cycle

export interface CycleOutcome {
  /** Plugins installed or updated. A COUNT: the card reports a number, not a log. */
  applied: number
  /** Plugins that failed, per-plugin and never fatal. */
  failed: number
  /** Plugins deliberately not installed, each with a sentence. */
  skipped: string[]
  /** True when the index was unchanged and nothing needed doing. */
  unchanged: boolean
}

/**
 * Fetch, verify, unpack and apply — once.
 *
 * PER-PLUGIN FAILURES ARE NEVER FATAL. One archive that will not verify does not
 * stop the other nine, and the connection reports a COUNT rather than an
 * exception: nothing on this path may put a fetch error in front of the user.
 */
export async function runRepositoryCycle(): Promise<CycleOutcome> {
  const address = storedAddress()
  const key = readKey()
  if (!address || !key) return { applied: 0, failed: 0, skipped: [], unchanged: true }
  registerSecret('plugin-repository-key', () => readKey())

  const etag = getSetting(getDb(), ETAG_KEY)
  let entries: IndexEntry[]
  let freshTag: string | null = null
  try {
    const res = await get(address, key, '/plugins-repository/index.json', etag ? { 'if-none-match': etag } : {})
    if (res.status === 304) {
      lastFailure = null
      setSetting(getDb(), LAST_CHECKED_KEY, new Date().toISOString())
      // A 304 says the INDEX has not changed. It does not say this install ever
      // finished acting on it — an install carrying an ETag stored by the older
      // code has plugins present and nothing claimed, and every check from here
      // would be a 304 that returns before the claim loop, so it could never
      // recover. Claiming nothing is the one state worth re-deriving from a
      // reply that carries no entries.
      if (repositorySuppliedIds().length === 0) {
        setSetting(getDb(), ETAG_KEY, '')
        return runRepositoryCycle()
      }
      return { applied: 0, failed: 0, skipped: lastSkips, unchanged: true }
    }
    if (!res.ok) {
      lastFailure = sentenceForStatus(res.status)
      return { applied: 0, failed: 0, skipped: [], unchanged: false }
    }
    const body = await readBounded(res, INDEX_MAX_BYTES)
    entries = readIndex(JSON.parse(body.toString('utf8')) as unknown)
    // HELD until the entries have been ACTED ON, not stored here.
    //
    // Recording it at the point the body parsed made every later check a 304
    // that returns before the loop below — so a cycle interrupted after the read
    // never ran the work, permanently. That is what left an install with the
    // repository's plugins present, the address saved, and nothing claimed:
    // "Supplies 0 plugins here", unrecoverable by checking again, because
    // checking again was exactly what the ETag skipped.
    freshTag = res.headers.get('etag')
  } catch (err) {
    lastFailure = sentenceForThrow(err)
    return { applied: 0, failed: 0, skipped: [], unchanged: false }
  }

  lastFailure = null
  setSetting(getDb(), LAST_CHECKED_KEY, new Date().toISOString())

  const installed = installedPluginVersions()
  let applied = 0
  let failed = 0
  const skipped: string[] = []

  for (const entry of entries) {
    // A PLUGIN FROM THE FUTURE IS SKIPPED, NOT INSTALLED. `manifestVersion` is
    // frozen at 1; a folder built for a later one cannot load, and installing it
    // anyway would put a permanently broken row in the table that the user
    // cannot tell from a bug in the app.
    if (entry.manifestVersion !== null && entry.manifestVersion > MANIFEST_VERSION) {
      skipped.push(`${entry.name} was built for a later version of this app, so it was not installed.`)
      continue
    }
    // A PLUGIN THE USER REMOVED STAYS REMOVED, and says so. Discovery skips a
    // tombstoned id in both roots, so installing one would land a folder that
    // never loads: no row, nothing to remove it with, and a repository quietly
    // overturning a decision the user made. Connecting hands over authority over
    // what is installed from here on, not over what was already refused.
    if (isPluginRemoved(entry.id)) {
      skipped.push(`${entry.name} is offered by the repository, but you removed it, so it was left out.`)
      continue
    }
    const have = installed.get(entry.id) ?? null
    if (have !== null && compareVersions(entry.version, have) <= 0) {
      // ALREADY CURRENT IS STILL A CLAIM. The repository offers this id, so it
      // supplies it from here on whether or not any bytes had to move — and the
      // ownership is what the removal lock and the "supplies N plugins" line are
      // both read from.
      //
      // Marking it only when something was DOWNLOADED meant a plugin the app
      // already had at the offered version was never claimed: connecting to a
      // repository serving exactly what was installed reported "supplies 0
      // plugins here" and left every row removable, so the set the user had just
      // handed over authority for was not, in fact, held by anything.
      setRepositorySupplied(entry.id, true)
      continue
    }
    try {
      await applyOne(address, key, entry, have !== null)
      applied += 1
    } catch {
      // The thrown value is DISCARDED. It is either a refusal already counted or
      // a fetch error carrying the request URL and its authorization header, and
      // neither belongs anywhere near a rendered string. That one plugin failed
      // is what the card reports.
      failed += 1
    }
  }

  lastSkips = skipped
  // THE ETAG IS STORED HERE, and only when nothing failed. Every entry has now
  // been applied, claimed or deliberately skipped, so a 304 next time truthfully
  // means "nothing more to do". Storing it after a failure would turn the retry
  // that sentence promises into a 304 that never looks again.
  if (failed === 0 && freshTag && freshTag.length < 200) {
    setSetting(getDb(), ETAG_KEY, freshTag)
  }
  if (failed > 0) {
    lastFailure = {
      code: 'partly-failed',
      sentence:
        failed === 1
          ? 'One plugin from the repository could not be installed. It will be tried again later.'
          : `${failed} plugins from the repository could not be installed. They will be tried again later.`
    }
  }
  if (applied > 0 || failed > 0) notifySink?.()
  return { applied, failed, skipped, unchanged: false }
}

/**
 * Fetch ONE archive, verify it against the digest from the index, unpack it and
 * hand the directory to the installer.
 *
 * THE DIGEST IS THE ONE FROM THE INDEX, which is why the versioner does not ship
 * it beside the bytes: a digest read out of the same response it is meant to
 * authenticate proves only that the response is internally consistent.
 *
 * A MISMATCH REFUSES AND CHANGES NOTHING. The installed copy is left exactly as
 * it was — the update path is only entered after the bytes have been verified,
 * so a bad download costs the user nothing at all.
 */
async function applyOne(
  address: string,
  key: string,
  entry: IndexEntry,
  alreadyInstalled: boolean
): Promise<void> {
  const res = await get(
    address,
    key,
    `/plugins-repository/${encodeURIComponent(entry.id)}/${encodeURIComponent(entry.version)}/plugin.zip`
  )
  if (!res.ok) throw new ManifestError('fetch-failed', 'That plugin could not be downloaded.')
  // Bounded by the DECLARED length as well as by the archive cap, so an entry
  // that says it is 2 KB and streams 30 MB is cut off at its own claim.
  const zip = await readBounded(res, Math.min(ZIP_MAX_BYTES, Math.max(entry.bytes, 1)))
  const digest = createHash('sha256').update(zip).digest('hex')
  if (digest !== entry.sha256) {
    throw new ManifestError(
      'digest-mismatch',
      'A plugin download did not match what the repository said it should be, so it was discarded.'
    )
  }

  const temp = mkdtempSync(join(tmpdir(), 'corpus-plugin-'))
  try {
    extractPluginZip(zip, temp)
    // The SAME installer a folder the user picked goes through. Nothing about
    // the walk, the symlink refusal, the hardlink check or the staging rename is
    // repeated here; this path only produces a directory for it to judge.
    if (alreadyInstalled) await updatePlugin(entry.id, temp)
    else installPlugin(temp)
    setRepositorySupplied(entry.id, true)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

// -------------------------------------------------------------- the timer

/**
 * When a cycle runs, and what stops one.
 *
 * ONCE AT LAUNCH after discovery has settled, then every four hours. On the
 * host's own timer, and SKIPPED ENTIRELY while any plugin is mid-lifecycle, so a
 * sync never races a teardown: an update swaps a plugin's tree, and doing that
 * under an enable that is half-finished is the one ordering this path must not
 * be able to reach.
 *
 * A cycle is `pluginCapabilityVerb`-SHAPED rather than joining the `serialised`
 * chain, for the reason `host.ts` gives at length: that chain is strict FIFO, so
 * a slow download parked in it would leave the user's Off toggle unresponsive
 * for the whole download and suppress every tick while it ran. What it takes
 * from that shape is the part that matters — the conditions are read in one
 * synchronous turn before the work starts, and only one cycle is ever in flight.
 */
export function startRepositorySchedule(opts: {
  safeStorage: SafeStorageLike
  notify: () => void
}): void {
  safeStorage = opts.safeStorage
  notifySink = opts.notify
  if (readKey() !== null) registerSecret('plugin-repository-key', () => readKey())
  stopRepositorySchedule()
  firstTimer = setTimeout(() => {
    void tick()
  }, FIRST_CYCLE_DELAY_MS)
  firstTimer.unref?.()
  timer = setInterval(() => {
    void tick()
  }, CYCLE_INTERVAL_MS)
  timer.unref?.()
}

export function stopRepositorySchedule(): void {
  if (timer) clearInterval(timer)
  if (firstTimer) clearTimeout(firstTimer)
  timer = null
  firstTimer = null
}

/** One scheduled attempt: the conditions, then the work. Never two at once. */
async function tick(): Promise<void> {
  if (cycleInFlight !== null) return
  if (!isConnected()) return
  if (anyPluginLifecycleBusy()) return
  cycleInFlight = runRepositoryCycle().then(
    () => undefined,
    () => undefined
  )
  try {
    await cycleInFlight
  } finally {
    cycleInFlight = null
  }
}

/**
 * Ask for a cycle now, and say only whether one started.
 *
 * `started: false` is the ORDINARY answer to a second press while the first is
 * still running — the same judgement `SyncNowResultDTO` makes — so it carries no
 * sentence and the caller keeps showing the busy control.
 */
export async function syncRepositoryNow(): Promise<boolean> {
  if (cycleInFlight !== null) return false
  if (!isConnected()) return false
  await tick()
  return true
}

// ------------------------------------------------------- connect/disconnect

/**
 * Probe an address and key WITHOUT saving either.
 *
 * The whole point of Test is that it runs before consent: the user is deciding
 * whether to hand this repository the authority to install code here, and being
 * made to commit first in order to find out the address was mistyped is a design
 * that trains people to save credentials they have not checked.
 */
export async function testRepository(input: {
  address: string
  key: string
}): Promise<{ ok: boolean; sentence: string; code: string | null; plugins: number }> {
  let address: string
  try {
    address = normaliseAddress(input.address)
  } catch (err) {
    const s = sentenceForThrow(err)
    return { ok: false, sentence: s.sentence, code: s.code, plugins: 0 }
  }
  const key = input.key.trim() || readKey()
  if (!key) {
    return {
      ok: false,
      sentence: 'A repository needs the key you were given, so this app can read what it offers.',
      code: 'no-key',
      plugins: 0
    }
  }
  try {
    const res = await get(address, key, '/plugins-repository/index.json')
    if (!res.ok) {
      const s = sentenceForStatus(res.status)
      return { ok: false, sentence: s.sentence, code: s.code, plugins: 0 }
    }
    const body = await readBounded(res, INDEX_MAX_BYTES)
    const entries = readIndex(JSON.parse(body.toString('utf8')) as unknown)
    return {
      ok: true,
      code: null,
      plugins: entries.length,
      sentence:
        entries.length === 1
          ? 'That repository answered, and holds one plugin.'
          : `That repository answered, and holds ${entries.length} plugins.`
    }
  } catch (err) {
    const s = sentenceForThrow(err)
    return { ok: false, sentence: s.sentence, code: s.code, plugins: 0 }
  }
}

/**
 * Save the address and key, and run the first cycle immediately.
 *
 * CONNECTING IS THE CONSENT, and it is the only one asked for: there is no
 * per-plugin prompt afterwards, because a modal in front of a user who has
 * already said yes to the repository stalls an unattended install and teaches
 * them to dismiss whatever appears.
 *
 * AN EMPTY KEY MEANS "KEEP THE ONE ALREADY STORED", and only that. The key is
 * write-only — it never comes back over IPC, so the field is empty every time
 * the form is opened — and the form says as much: "Leave this empty to keep
 * it". Treating empty as a refusal made correcting a typo in the ADDRESS
 * impossible without retyping the key from wherever the user had kept it, and
 * treating it as a blank key would silently erase a working credential.
 *
 * It is a refusal only when there is nothing stored to keep, which is the one
 * case where "keep what you have" has no answer.
 */
export async function connectRepository(input: {
  address: string
  key: string
}): Promise<PluginRepositoryDTO> {
  const address = normaliseAddress(input.address)
  const typed = input.key.trim()
  const key = typed || readKey()
  if (!key) {
    throw new ManifestError(
      'no-key',
      'A repository needs the key you were given, so this app can read what it offers.'
    )
  }
  setSetting(getDb(), ADDRESS_KEY, address)
  // A NEW connection starts with no ETag. Keeping the previous one would make
  // the first check against a different repository a 304 against an index that
  // repository never sent.
  setSetting(getDb(), ETAG_KEY, '')
  if (typed) writeKey(typed)
  registerSecret('plugin-repository-key', () => readKey())
  lastFailure = null
  lastSkips = []
  await tick()
  return repositoryForUi()
}

/**
 * DISCONNECT: the escape hatch, and the only one.
 *
 * Every `plugin.<id>.source` is cleared and the key is deleted. The plugins stay
 * INSTALLED and become ordinary user plugins — Remove returns, updates stop.
 * Nothing the user relies on breaks at the moment they disconnect, and the
 * removal lock is released with the connection that justified it.
 *
 * Uninstalling them instead would mean a user escaping ONE plugin loses every
 * other one with it, which is why this is a plain button on the card rather than
 * something buried: it is the whole of the way out.
 */
export function disconnectRepository(): PluginRepositoryDTO {
  for (const id of repositorySuppliedIds()) setRepositorySupplied(id, false)
  setSetting(getDb(), ADDRESS_KEY, '')
  setSetting(getDb(), ETAG_KEY, '')
  setSetting(getDb(), LAST_CHECKED_KEY, '')
  clearKey()
  lastFailure = null
  lastSkips = []
  notifySink?.()
  return repositoryForUi()
}
