import type { Server } from 'node:http'
import type { McpClientVariant, McpStatusDTO } from '@shared/contract'
import { getDb } from '../db/connection'
import { getSetting, setSetting } from '../db/repositories'
import type { PermissionLevel } from '../ipc/registry'
import { createHttpServer } from './http'
import { currentAllowedHosts, DEFAULT_PORT, lanAddresses, listen, urlsFor } from './net'
import {
  TokenUnreadableError,
  getOrCreateToken,
  hasToken,
  redactSecrets,
  regenerateToken,
  resetThrottle
} from './auth'
import { closeAudit, isAuditUnavailable, openAudit } from './audit'
import { scrubPaths } from './redact'
import { drain, mcpInFlight, mcpInFlightTotal } from './queue'
import { clearFailure, noteFailure, resetSession, sessionCounters } from './status'
import { markServerStart, toolCountFor } from './server'
import { clearDossierSessions } from '../ipc/projectContext'

/**
 * Start, stop and describe the embedded MCP server.
 *
 * The app's identity is offline and local-first, and an inbound listening socket
 * is a POSTURE CHANGE rather than a feature addition. So: off unless the user
 * turned it on, loopback unless they opted into more, token-authenticated
 * unconditionally, and the audit log always on while it is running. The app
 * still makes no outbound connection it did not already make — what changed is
 * that it can accept one.
 */

const KEY_ENABLED = 'mcp_enabled'
const KEY_PORT = 'mcp_port'
const KEY_BIND_LAN = 'mcp_bind_lan'
const KEY_ALLOW_WRITE = 'mcp_allow_write'
const KEY_ALLOW_DESTRUCTIVE = 'mcp_allow_destructive'

/**
 * Headless harnesses launch a SECOND main process against the user's real
 * database (`scripts/shot.ts` does exactly this). That instance auto-starting
 * the server would collide with the user's on the configured port, scan to a
 * free one, and — before this guard — persist it, silently repointing the config
 * the agent is holding. Deterministic env opt-out rather than a single-instance
 * lock: the lock is order-dependent (the shot wins it if the app is down) and
 * would be a whole-app behaviour change for an MCP-local problem.
 */
const SUPPRESSED = process.env.CORPUS_NO_MCP === '1' || process.env.CORPUS_NO_CLOSE_GUARD === '1'

type State = 'stopped' | 'starting' | 'listening' | 'stopping' | 'failed'

let state: State = 'stopped'
let http: Server | null = null
let boundPort: number | null = null
let boundBind: '127.0.0.1' | '0.0.0.0' = '127.0.0.1'
let quitting = false
let token: string | null = null

// ------------------------------------------------------------------ settings

/**
 * The five MCP settings, read through a cache.
 *
 * `level()` runs on EVERY tool dispatch and `status()` is polled every two
 * seconds by the Settings pane; between them that is a dozen synchronous SQLite
 * reads a second on the thread that also paints the window, for values only
 * this module ever writes. So it writes through: `setSetting` here always goes
 * with a cache update, and nothing outside can change these keys behind us.
 */
const cache = new Map<string, string | null>()
/**
 * Which connection the cache belongs to.
 *
 * `closeDb()` + `initDatabase()` is a real sequence — the quit path and the
 * tests both do it — and a cache carried across it would serve the OLD file's
 * settings against the new one, which is the same class of bug as the app and
 * the seeder disagreeing about the DB path.
 */
let cacheDb: unknown = null

function readSetting(key: string): string | null {
  const db = getDb()
  if (db !== cacheDb) {
    cache.clear()
    cacheDb = db
  }
  if (cache.has(key)) return cache.get(key) ?? null
  const raw = getSetting(db, key)
  cache.set(key, raw)
  return raw
}

function writeSetting(key: string, value: string): void {
  const db = getDb()
  if (db !== cacheDb) {
    cache.clear()
    cacheDb = db
  }
  setSetting(db, key, value)
  cache.set(key, value)
}

function readBool(key: string, fallback: boolean): boolean {
  const raw = readSetting(key)
  if (raw === null) return fallback
  return raw === '1'
}

function readPort(): number {
  const raw = readSetting(KEY_PORT)
  const n = raw === null ? NaN : Number(raw)
  return Number.isInteger(n) && n >= 1024 && n <= 65_535 ? n : DEFAULT_PORT
}

export function isEnabled(): boolean {
  return readBool(KEY_ENABLED, false)
}

function bindLan(): boolean {
  return readBool(KEY_BIND_LAN, false)
}

/**
 * The permission level, derived from two independent opt-ins.
 *
 * Two checkboxes and not one slider, because the two decisions are genuinely
 * different in kind: write is what makes the feature useful (an agent that can
 * record a verdict and re-run a stage), and destructive is what makes it
 * dangerous (deleting a paper, writing files through an outlet). Read+write is
 * the default the user asked for; destructive stays off until it is chosen.
 */
export function level(): PermissionLevel {
  const write = readBool(KEY_ALLOW_WRITE, true)
  // Destructive is a widening of write, never a level of its own. Read alone
  // with deletion allowed is not a posture anyone means to be in, and reaching
  // it by turning write OFF — an action whose only intent can be to narrow —
  // would hand the agent the widest level available.
  if (!write) return 'read'
  return readBool(KEY_ALLOW_DESTRUCTIVE, false) ? 'delete' : 'write'
}

// ------------------------------------------------------------------ lifecycle

export function noteQuitIntent(intent: boolean): void {
  quitting = intent
}

/**
 * `mcpInFlight` — calls that could be mid-WRITE. `mcpInFlightTotal` — all of
 * them, reads included. The quit path wants the total (a read resuming on a
 * closed connection throws just as loudly as a write); the close GUARD wants
 * the narrow one, because a polling agent must not be able to hold the quit
 * prompt open. See `queue.ts`.
 */
export { mcpInFlight, mcpInFlightTotal }

/**
 * Every start and stop runs to completion before the next one begins.
 *
 * `start` is not atomic — it awaits `listen()` — so two overlapping enables
 * (a double click, or the IPC handler racing the launch-time auto-start) would
 * both pass the `if (http) return` guard, bind two sockets, and leak the first:
 * `http` would hold the second and nothing could ever close the first. Chaining
 * is also what makes "enable then immediately disable" converge on stopped
 * rather than on a listening socket with `mcp_enabled=0`.
 */
let lifecycleOp: Promise<void> = Promise.resolve()

function serialize(fn: () => Promise<void>): Promise<void> {
  const next = lifecycleOp.then(fn, fn)
  lifecycleOp = next.catch(() => undefined)
  return next
}

export async function startMcpIfEnabled(): Promise<void> {
  if (SUPPRESSED) return
  await serialize(async () => {
    // Re-read INSIDE the serialized slot: the user can have toggled it off
    // while an earlier operation was still running.
    if (!isEnabled()) return
    // Auto-start scans. The fear was a SECOND main process on the same corpus
    // walking to a free port and serving the same token twice, which is why
    // this used to fail closed. Two guards now make that unreachable: every
    // headless harness sets CORPUS_NO_CLOSE_GUARD/CORPUS_NO_MCP, which
    // `SUPPRESSED` honours before we get here, and the database holds a POSIX
    // fcntl lock, so a second instance never reaches `startMcpIfEnabled` at
    // all. What remained was the common case — some unrelated program holding
    // 51820 — failing the server outright and leaving the user to find a port
    // by hand.
    await start({ allowScan: true })
  })
}

async function start(opts: { allowScan: boolean } = { allowScan: true }): Promise<void> {
  if (http) return
  state = 'starting'
  clearFailure()
  // Unconditionally, on the way IN as well as out. Nothing an earlier session
  // believed about which agent already holds which project's background may
  // survive into this one — the DB behind it can be a different corpus entirely.
  // Clearing is always the safe direction: it can only cause a re-send.
  clearDossierSessions()
  markServerStart()
  // BEFORE the socket, and fatal to the start if it fails.
  //
  // An MCP call is the one write to this corpus nobody confirms — there is no
  // human at the far end — so the log IS the control, and a server that answers
  // while the log silently no-ops hands the user an empty file they believe is
  // a complete record. Refusing to listen is recoverable in one step and
  // visible immediately; the alternative is discovered only when someone goes
  // looking for a call that was never written down.
  //
  // The exception's TEXT is logged (scrubbed) and never surfaced: `McpFailure`
  // is a closed enum precisely so nothing assembled near a request can reach a
  // DTO the Settings pane polls, and both of these messages name a path.
  //
  // But WHICH of the two happened does cross, as an enum member, because the
  // remedies are specific and opposite — fix the permissions on the audit
  // folder, or deal with an unreadable token file — and both used to arrive as
  // `internal`, whose sentence is "The server could not start." That is true and
  // useless: it sends a user with a one-step fix to look for a fault that is not
  // where they will look. Classified by ERROR TYPE, never by message text: the
  // message is the field carrying the path.
  //
  // `getOrCreateToken` shares the branch: it REFUSES an existing-but-unreadable
  // token file rather than minting over it, and an escaping throw here would
  // leave `state` on 'starting' forever behind an unhandled rejection — a
  // Settings pane spinning on "Starting…" with nothing to say.
  try {
    openAudit()
    token = getOrCreateToken()
  } catch (err) {
    state = 'failed'
    http = null
    boundPort = null
    noteFailure(
      isAuditUnavailable(err)
        ? 'audit-unwritable'
        : err instanceof TokenUnreadableError
          ? 'token-unreadable'
          : 'internal'
    )
    // eslint-disable-next-line no-console
    console.error(`[main] mcp refused to start: ${scrubPaths(redactSecrets(err))}`)
    closeAudit()
    clearDossierSessions()
    return
  }

  const wantLan = bindLan()
  const bind: '127.0.0.1' | '0.0.0.0' = wantLan ? '0.0.0.0' : '127.0.0.1'
  const wantPort = readPort()

  const server = createHttpServer({
    token: () => token ?? '',
    // Genuinely recomputed on every request (behind a 1s memo), not captured at
    // bind: a VPN coming up or a DHCP lease changing makes yesterday's list
    // wrong, and a stale allowlist does not fail loudly — it refuses the user's
    // own agent with the same blank 401 as an attacker.
    allowedHosts: () =>
      boundPort === null ? [] : currentAllowedHosts(boundBind, boundPort),
    level,
    quitting: () => quitting
  })

  try {
    const outcome = await listen(server, bind, wantPort, opts.allowScan)
    http = server
    boundPort = outcome.port
    boundBind = bind
    state = 'listening'
    // The port that actually bound is written back, scanned or not. A random
    // fallback held only in memory would be forgotten on the next launch, and
    // the user would be handed a fresh unfamiliar port every time the default
    // happened to be busy — the config they pasted into their agent has to keep
    // naming the port this app answers on.
    if (String(outcome.port) !== readSetting(KEY_PORT)) {
      writeSetting(KEY_PORT, String(outcome.port))
    }
    // eslint-disable-next-line no-console
    console.log(`[main] mcp listening bind=${bind} port=${outcome.port} level=${level()}`)
  } catch (err) {
    state = 'failed'
    http = null
    boundPort = null
    const code = (err as NodeJS.ErrnoException)?.code
    noteFailure(
      code === 'EADDRINUSE' ? 'port-in-use' : code === 'EACCES' ? 'permission-denied' : 'bind-failed'
    )
    // A bind that failed leaves no session, so the previous one's lockouts must
    // not survive into the next attempt.
    resetThrottle()
    closeAudit()
    clearDossierSessions()
    try {
      server.close()
    } catch {
      /* it never listened */
    }
  }
}

async function stop(): Promise<void> {
  const server = http
  if (!server) {
    state = 'stopped'
    return
  }
  state = 'stopping'
  // Stop ACCEPTING, then wait. In-flight calls are not aborted: a half-aborted
  // supersede-then-insert leaves rows that nothing owns, which is strictly
  // worse than a late shutdown.
  //
  // NOT `await server.close()` first. That callback only fires once every
  // socket is gone, and an agent holding an idle keep-alive connection would
  // delay it by the whole keep-alive timeout -- so a Settings toggle that reads
  // as instant would sit there for fifteen seconds with nothing running. Idle
  // sockets are dropped straight away; only the WORK is waited on.
  const closed = new Promise<void>((resolve) => server.close(() => resolve()))
  server.closeIdleConnections()
  const drained = await drain(5_000)
  server.closeAllConnections()
  await closed
  http = null
  boundPort = null
  state = 'stopped'
  resetThrottle()
  clearDossierSessions()
  // The audit file and the session counters outlive an incomplete drain.
  // Closing them under a call that is still executing would silently drop that
  // call's audit line — the one call most worth having a record of, since it is
  // the one that overran — and would report `inFlight > 0` beside a session
  // that claims to have made no calls. Tear them down when the work is really
  // over, or immediately when there is none.
  if (drained) {
    closeAudit()
    resetSession()
  } else {
    void (async () => {
      const settled = await drain(60_000)
      // Only when the work is REALLY over, and only if nothing started the
      // server again in the meantime (a restart owns its own audit file and
      // counters). A call still running after a further minute keeps its audit
      // line; the process exit reclaims the handle.
      if (settled && http === null) {
        closeAudit()
        resetSession()
      }
    })()
  }
}

/**
 * Synchronous best-effort teardown for `will-quit`.
 *
 * That listener cannot await, so this only stops accepting and drops the
 * sockets. Whatever is still executing keeps its slot, and the quit path's
 * `mcpInFlight()` predicate term is what stops `closeDb()` landing under it.
 */
export function stopMcpForQuit(): void {
  quitting = true
  try {
    http?.close()
    http?.closeAllConnections()
  } catch {
    /* nothing here may prevent the app from exiting */
  }
  http = null
  state = 'stopped'
  clearDossierSessions()
  // The audit file stays OPEN if anything is still executing. The quit path
  // deliberately defers `closeDb()` under an in-flight call, so those calls do
  // finish — and a call that outlives the quit is the one most worth a record
  // of, not the one to silently drop.
  if (mcpInFlightTotal() === 0) closeAudit()
}

// ------------------------------------------------------------------ IPC-facing

export async function setEnabled(enabled: boolean): Promise<McpStatusDTO> {
  writeSetting(KEY_ENABLED, enabled ? '1' : '0')
  await serialize(async () => {
    // The persisted flag, not the argument: if a later toggle landed while this
    // one was queued, the last thing the user asked for is what should happen,
    // and doing both in order would end on the wrong one.
    if (isEnabled()) await start()
    else await stop()
  })
  return status()
}

export async function setOptions(o: {
  port?: number
  bindLan?: boolean
  allowWrite?: boolean
  allowDestructive?: boolean
}): Promise<McpStatusDTO> {
  if (o.port !== undefined) writeSetting(KEY_PORT, String(o.port))
  if (o.bindLan !== undefined) writeSetting(KEY_BIND_LAN, o.bindLan ? '1' : '0')
  // The pair is RESOLVED before either is written, and `allowWrite: false`
  // dominates whatever destructive says. Writing them one at a time, each
  // fixing up the other, made `{allowWrite: false, allowDestructive: true}`
  // land on `delete` — a request that can only mean "narrow this" ending on the
  // widest level there is.
  if (o.allowWrite !== undefined || o.allowDestructive !== undefined) {
    const write = o.allowWrite ?? readBool(KEY_ALLOW_WRITE, true)
    const destructive =
      write && (o.allowDestructive ?? readBool(KEY_ALLOW_DESTRUCTIVE, false))
    writeSetting(KEY_ALLOW_WRITE, write ? '1' : '0')
    writeSetting(KEY_ALLOW_DESTRUCTIVE, destructive ? '1' : '0')
  }
  return status()
}

/**
 * The MCP settings as the settings EXPORT carries them, and their re-application.
 *
 * These go through this module rather than through `setSetting` directly, and
 * that is correctness rather than tidiness: the five keys are served from a
 * write-through cache above, so a row written behind its back would be ignored
 * until the process restarts — the import would report success and the pane
 * would keep showing the old port.
 *
 * The token is NOT here. `mcp_token_sha256` is the digest of a bearer credential
 * minted for THIS install, and carrying it to another machine would silently
 * give both the same one; the receiving install mints its own on first use.
 */
export function mcpTransferValues(): {
  enabled: boolean
  port: number
  bindLan: boolean
  allowWrite: boolean
  allowDestructive: boolean
} {
  return {
    enabled: isEnabled(),
    port: readPort(),
    bindLan: bindLan(),
    allowWrite: readBool(KEY_ALLOW_WRITE, true),
    allowDestructive: readBool(KEY_ALLOW_DESTRUCTIVE, false)
  }
}

/**
 * Apply imported MCP settings, starting or stopping the server to match.
 *
 * The options land BEFORE the enabled flag so a server that is about to start
 * starts on the imported port rather than on the old one and then restarting.
 */
export async function applyMcpTransfer(v: {
  enabled: boolean
  port: number
  bindLan: boolean
  allowWrite: boolean
  allowDestructive: boolean
}): Promise<void> {
  await setOptions({
    port: v.port,
    bindLan: v.bindLan,
    allowWrite: v.allowWrite,
    allowDestructive: v.allowDestructive
  })
  await setEnabled(v.enabled)
}

export function tokenValue(): string {
  token = getOrCreateToken()
  return token
}

export async function regenerate(): Promise<string> {
  const next = regenerateToken()
  token = next
  // A running server keeps serving on the new value immediately — `token` is
  // read through a closure per request — so nothing needs restarting, and any
  // agent holding the old one is disconnected at its next call. That is the
  // point of the button.
  return next
}

/**
 * Whether a persisted option differs from what the running socket is doing.
 *
 * Options are editable while STOPPED on purpose: gating them on the server
 * running would force "copy the config, then invalidate what you copied".
 *
 * Reported PER OPTION as well as in aggregate, because the pane marks
 * individual controls pending: one shared flag made the network-exposure switch
 * announce it was waiting on a restart when the only thing the user had changed
 * was the port.
 */
function pendingBind(): boolean {
  if (state !== 'listening') return false
  return (bindLan() ? '0.0.0.0' : '127.0.0.1') !== boundBind
}

function pendingPort(): boolean {
  if (state !== 'listening') return false
  // Against the port actually BOUND, not the one asked for. A scan writes the
  // port it landed on back to settings, so comparing with `requestedPort` would
  // read the app's own successful fallback as an unapplied user edit and leave
  // "restart to apply" showing forever, on a server already serving that port.
  return readPort() !== boundPort
}

export function status(): McpStatusDTO {
  const s = sessionCounters()
  const configuredPort = readPort()
  return {
    enabled: isEnabled(),
    state,
    bind: state === 'listening' ? boundBind : bindLan() ? '0.0.0.0' : '127.0.0.1',
    configuredPort,
    boundPort,
    pendingRestart: pendingBind() || pendingPort(),
    pendingBind: pendingBind(),
    pendingPort: pendingPort(),
    urls: boundPort === null ? [] : urlsFor(boundBind, boundPort),
    lanAddresses: lanAddresses(),
    // Derived from `level()`, never read raw: an install that persisted
    // `write=0, destructive=1` before those two were made consistent would
    // otherwise show a ticked destructive box beside a server that is in fact
    // read-only. The pane must state what the server DOES.
    allowWrite: level() !== 'read',
    allowDestructive: level() === 'delete',
    hasToken: hasToken(),
    inFlight: mcpInFlightTotal(),
    callsThisSession: s.callsThisSession,
    lastConnectedAt: s.lastConnectedAt,
    lastToolCalled: s.lastToolCalled,
    lastError: s.lastError,
    toolCount: toolCountFor(level())
  }
}

/**
 * The exact text to paste into a client.
 *
 * Three shapes because "MCP config" is not one format, and pasting the wrong one
 * is the highest-probability failure in this whole feature. The URL is the one
 * the socket is ACTUALLY bound to — never a discovered address it is not
 * listening on, which costs a debugging session every time.
 */
export function clientConfig(variant: McpClientVariant): string {
  const port = boundPort ?? readPort()
  const url = `http://127.0.0.1:${port}/mcp`
  const value = tokenValue()

  if (variant === 'vscode') {
    return JSON.stringify(
      {
        servers: {
          'corpus-studio': { type: 'http', url, headers: { Authorization: `Bearer ${value}` } }
        }
      },
      null,
      2
    )
  }
  if (variant === 'stdio') {
    return [
      '# For a client that only speaks stdio. Needs Node on PATH.',
      `npx -y mcp-remote ${url} --header "Authorization: Bearer ${value}"`
    ].join('\n')
  }
  return JSON.stringify(
    {
      mcpServers: {
        'corpus-studio': { type: 'http', url, headers: { Authorization: `Bearer ${value}` } }
      }
    },
    null,
    2
  )
}
