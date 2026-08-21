// The communicator gateway: where its credential comes from, and whether it is
// answering right now.
//
// Split out of `provider.ts` because these are the two questions asked BEFORE a
// batch starts — a pre-flight that fails once is worth a hundred papers each
// discovering the same outage on their own attempt budget — and because the
// credential wants a single, auditable read path that nothing else can widen.
//
// SECURITY CONTRACT, enforced by `verify:offline` and `verify:sidecar`:
//   - the key is read HERE and nowhere else;
//   - it is never written to a log, an error message, an IPC payload, or a
//     child process's environment (`hostEnv()` is a positive allow-list);
//   - a `GatewayCredential` stringifies to `[redacted]` in every path Node
//     might take (`toString`, `toJSON`, `util.inspect`), so a future
//     `console.log(cred)` or `JSON.stringify({cred})` cannot leak it.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { userDataDir } from '../db/paths'
import { registerSecret } from '../mcp/redact'
import { gatewayDispatcher, usingSystemTrustStore } from './dispatcher'

/**
 * Where the gateway lives: WHAT THE USER SAVED IN SETTINGS, or nothing.
 *
 * ONE SOURCE. There were four — two environment variables, a repo-local `.env`,
 * and a dev path under `docker/` — layered in a precedence order, and the top
 * of that order silently outranked the Settings field. A user who typed an
 * endpoint into the app and watched it have no effect has no way to discover
 * why: the UI shows what they saved, and the app talks to something else.
 * Configuration the user cannot see in the app is configuration they cannot
 * debug, and every one of those layers was a place a stale value could hide.
 *
 * NO LOOPBACK DEFAULT either. Guessing `127.0.0.1:10000` means an install with
 * nothing configured reports whatever happens to answer on that port — or, more
 * often, a connection failure phrased as though a gateway were expected there.
 * Null means "no endpoint is configured", which is a thing the app can SAY.
 *
 * USERINFO IS STRIPPED. `http://user:pass@host` is a legal URL and undici puts
 * the whole thing into its error messages — which this module then puts into a
 * `reason` string that crosses IPC to the renderer and is rendered verbatim.
 * That is a credential leak through the one field whose entire purpose is being
 * shown to the user. Auth belongs in the `Authorization` header, so dropping
 * userinfo costs nothing.
 */
export function gatewayUrl(): string | null {
  const raw = readStoredEndpoint()
  if (!raw) return null
  const base = raw.replace(/\/+$/, '')
  try {
    const u = new URL(base)
    u.username = ''
    u.password = ''
    return u.toString().replace(/\/+$/, '')
  } catch {
    // Unparseable: return it as given rather than inventing a default, so the
    // pre-flight fails with the URL the user actually configured.
    return base
  }
}

/**
 * Where Settings writes the endpoint and the key.
 *
 * The SAME file `resolveCredential` already reads, in the same dotenv shape, so
 * a key typed into Settings and a key placed there by hand are indistinguishable
 * downstream — there is one credential path, not two.
 *
 * It lives in userData rather than the DB deliberately. The database is copied,
 * inspected and exported (an outlet writes it, a bug report attaches it), and a
 * secret in a row is a secret in every one of those copies. A file outside the
 * DB stays out of them, and keeps the security contract at the top of this
 * module true: the key is read here and nowhere else.
 */
function envFilePath(): string {
  return join(userDataDir(), 'gateway.env')
}

/** Parse the whole dotenv-shaped file into a map. Missing file = empty. */
function readEnvFile(path: string): Map<string, string> {
  const out = new Map<string, string>()
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return out
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m) out.set(m[1], m[2].trim().replace(/^["']|["']$/g, ''))
  }
  return out
}

/** The endpoint the user last saved, or null. Safe to disclose. */
function readStoredEndpoint(): string | null {
  const v = readEnvFile(envFilePath()).get('BASE_URL')?.trim()
  return v && v.length > 0 ? v : null
}

/**
 * Persist the endpoint and/or the key, leaving anything not passed untouched.
 *
 * `undefined` means "leave alone" and `''` means "clear" — a distinction the UI
 * needs, because a user who opens Settings and saves an endpoint must not wipe
 * the key they never touched.
 *
 * Written 0600: it holds a credential, and the default umask would leave it
 * readable by every account on the machine.
 */
export function saveGatewayConfig(opts: { endpoint?: string; key?: string }): void {
  const path = envFilePath()
  const env = readEnvFile(path)
  if (opts.endpoint !== undefined) {
    const e = opts.endpoint.trim().replace(/\/+$/, '')
    if (e) env.set('BASE_URL', e)
    else env.delete('BASE_URL')
  }
  if (opts.key !== undefined) {
    const k = opts.key.trim()
    if (k) env.set('API_KEYS', k)
    else env.delete('API_KEYS')
  }
  const body = [...env.entries()].map(([k, v]) => `${k}=${v}`).join('\n')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body ? `${body}\n` : '', { mode: 0o600 })
}

/**
 * The endpoint and the key, for the settings EXPORT and nothing else.
 *
 * This is the one place besides the request path that reads the credential, and
 * it lives here rather than in `settings-transfer/` on purpose: the security
 * contract at the top of this file says the key is read HERE, so the export
 * borrows that read instead of opening a second one that `verify:offline` would
 * have to learn about.
 *
 * The returned string goes STRAIGHT into the encrypted file. It must never be
 * put in an IPC payload, a log line or an error message — which is why the
 * settings-transfer code keeps the decrypted payload in main and hands the
 * renderer only a description of it.
 *
 * The two travel together because they are one setting: an endpoint imported
 * without its key points a working install at a server it cannot authenticate
 * to, and a key without its endpoint authenticates to the wrong one.
 */
export function gatewayTransferValues(): {
  endpoint: string | null
  key: string | null
} {
  return { endpoint: readStoredEndpoint(), key: resolveCredential()?.reveal() ?? null }
}

/**
 * What the renderer is allowed to know: the endpoint, and WHETHER a key exists.
 *
 * Never the key itself. The UI's only legitimate question is "is one set", which
 * a boolean answers — returning the value would put the credential in an IPC
 * payload, which the contract at the top of this file forbids and
 * `verify:offline` greps for.
 */
export function gatewayConfigForUi(): {
  endpoint: string
  endpointIsDefault: boolean
  hasKey: boolean
} {
  const stored = readStoredEndpoint()
  return {
    // '' rather than a guessed loopback URL. There is no default any more, and
    // showing one in the field would invite the user to believe an endpoint is
    // configured when nothing is.
    endpoint: stored ?? '',
    endpointIsDefault: stored === null,
    hasKey: resolveCredential() !== null
  }
}

const REDACTED = '[redacted]'

/**
 * A gateway API key that cannot be printed by accident.
 *
 * The value is held in a closure rather than a field: a field survives
 * `JSON.stringify`, `util.inspect`, structured clone into a worker, and the
 * crash reporter's serialisation of a thrown object. A closure survives none of
 * them, so the only way to obtain the string is to call `reveal()` — which is
 * greppable, and grepped by `verify:offline`.
 */
export class GatewayCredential {
  private readonly get: () => string
  /** Where it came from, for the UI to state without disclosing the value. */
  readonly origin: string

  constructor(value: string, origin: string) {
    const held = value
    this.get = () => held
    this.origin = origin
    // The closure defeats every ACCIDENTAL serialisation, but not a key that
    // arrived inside somebody else's error message — an HTTP client echoing the
    // request it just failed, say. Handing the value to the redactor closes
    // that last route, and it stays a closure on both sides.
    registerSecret('gateway-api-key', () => held)
  }

  /** The raw key. The ONLY accessor, deliberately named to be searchable. */
  reveal(): string {
    return this.get()
  }

  toString(): string {
    return REDACTED
  }
  toJSON(): string {
    return REDACTED
  }
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `GatewayCredential(${this.origin}) ${REDACTED}`
  }
}

/** Pull `API_KEYS=<value>` out of a dotenv-shaped file, or null. */
function keyFromEnvFile(path: string, varName: string): string | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (!m || m[1] !== varName) continue
    // The gateway's `API_KEYS` is a comma-separated set; any member authenticates.
    const first = m[2].trim().replace(/^["']|["']$/g, '').split(',')[0].trim()
    return first.length > 0 ? first : null
  }
  return null
}

/**
 * The gateway credential the user saved in Settings, or null.
 *
 * ONE SOURCE, matching `gatewayUrl()` — and it must stay that way for a reason
 * beyond tidiness: the endpoint and the key have to come from the SAME place,
 * or an install ends up sending one deployment's key to another deployment's
 * URL. That combination belongs to neither, and both halves look right wherever
 * you inspect them.
 *
 * The env vars, the repo `.env` and the `docker/` path that used to sit in
 * front of this are gone. Each was a credential the app would use without the
 * user having entered it anywhere they could see, and the highest-precedence
 * one silently beat the Settings field they had.
 */
export function resolveCredential(): GatewayCredential | null {
  const fromUser = keyFromEnvFile(envFilePath(), 'API_KEYS')
  return fromUser ? new GatewayCredential(fromUser, 'Settings') : null
}

// ---------------------------------------------------------------- pre-flight

/**
 * The OpenSSL verification failures, as undici surfaces them.
 *
 * A closed set rather than a substring match on the message: the message is
 * rendered to the user and may carry the request URL, so it is never read.
 */
const TLS_FAILURE_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_SIGNATURE_FAILURE'
])

export interface GatewayHealth {
  ok: boolean
  /** Short, user-facing, and safe to log — never contains the credential. */
  reason: string
  /** The models the gateway says it can route to, when it said. */
  models: string[]
  /** Minutes of OAuth token left, when the gateway reported it. */
  tokenMinutes: number | null
}

/**
 * Ask the gateway whether a batch can start.
 *
 * Reads the BODY, not the status: `/api/health/detailed` answers HTTP 200 with
 * `tokenExpired: true` when the OAuth credential has lapsed, so a status-only
 * check reports a gateway that will fail every call as ready.
 *
 * IT CARRIES THE CREDENTIAL, even though the gateway's own health routes are
 * open. A reverse proxy publishing the gateway need not be: the deployment
 * behind nginx answers an unauthenticated probe with 404 — not 401 — so a probe
 * without the key reported "gateway answered HTTP 404" and the app refused to
 * run any analysis against a gateway that was healthy and reachable. An
 * authenticated probe cannot be worse: the open route ignores the header.
 *
 * It also uses the SAME dispatcher as the completion path, so it cannot pass
 * over a TLS trust configuration the real call does not have.
 */
export async function probeGateway(
  baseUrl: string,
  timeoutMs = 5000,
  credential: GatewayCredential | null = resolveCredential()
): Promise<GatewayHealth> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const key = credential?.reveal()
    const init: RequestInit = {
      signal: ac.signal,
      // Both header spellings, for the same reason the completion path sends
      // both: which one survives depends on the proxy in front, not on us.
      ...(key ? { headers: { Authorization: `Bearer ${key}`, 'x-api-key': key } } : {})
    }
    ;(init as Record<string, unknown>).dispatcher = gatewayDispatcher()
    const res = await fetch(`${baseUrl}/api/health/detailed`, init)
    if (!res.ok) {
      // 404 and 401 mean the same thing here and neither means "no gateway":
      // an nginx in front answers 404 for a request it will not authenticate,
      // so naming the status alone sent the user to check a URL that was right.
      const reason =
        res.status === 404 || res.status === 401 || res.status === 403
          ? `the gateway refused the request (HTTP ${res.status})`
          : `the gateway answered HTTP ${res.status}`
      return { ok: false, reason, models: [], tokenMinutes: null }
    }
    const body = (await res.json()) as {
      dependencies?: { llmApi?: { status?: string; models?: string[] } }
      oauth?: { credentialsExist?: boolean; tokenExpired?: boolean; minutesUntilExpiry?: number }
    }
    const llm = body.dependencies?.llmApi
    const oauth = body.oauth
    const models = llm?.models ?? []
    const minutes =
      typeof oauth?.minutesUntilExpiry === 'number' ? oauth.minutesUntilExpiry : null
    // EVERY REASON BELOW REPORTS WHAT THE GATEWAY SAID ABOUT ITSELF, and says so.
    //
    // The gateway is a REMOTE service reached over HTTP. This app holds a URL
    // and an API key; it has no view of how that service authenticates, where
    // it runs, or who administers it. Earlier wording here diagnosed the
    // caller's own machine — "this computer is not signed in", "run any claude
    // command" — which is a guess about someone else's deployment stated as
    // fact, and it is wrong for every arrangement but one. What this app can
    // honestly say is which health field came back unhappy, attributed to the
    // gateway rather than asserted about the world.
    if (llm?.status !== 'healthy') {
      return {
        ok: false,
        reason: `the gateway reports its model provider as ${llm?.status ?? 'unknown'}`,
        models,
        tokenMinutes: minutes
      }
    }
    if (models.length === 0) {
      // A gateway calling itself healthy while serving no model would pass the
      // pre-flight and then fail the first paper with "unknown model", i.e. a
      // configuration error reported as a per-paper analysis failure — which is
      // exactly the fail-late behaviour a pre-flight exists to replace.
      return { ok: false, reason: 'the gateway offers no models', models, tokenMinutes: minutes }
    }
    if (!oauth?.credentialsExist) {
      return { ok: false, reason: 'the gateway reports no credentials', models, tokenMinutes: minutes }
    }
    if (oauth.tokenExpired) {
      return {
        ok: false,
        reason: 'the gateway reports its credentials as expired',
        models,
        tokenMinutes: minutes
      }
    }
    return { ok: true, reason: `ready${minutes === null ? '' : ` (token valid ${Math.round(minutes)} min)`}`, models, tokenMinutes: minutes }
  } catch (err) {
    // The CAUSE, not the raw message. `reason` is rendered verbatim in the UI,
    // and an undici error message can carry the request URL — which, if anyone
    // ever saves an endpoint with userinfo in it, carries a credential.
    // `gatewayUrl()` strips userinfo as well; this is the second net.
    const cause =
      err instanceof Error && typeof (err as { cause?: { code?: string } }).cause?.code === 'string'
        ? (err as { cause: { code: string } }).cause.code
        : err instanceof Error
          ? err.name
          : 'unknown error'
    // A CERTIFICATE the client will not verify is not an unreachable host, and
    // saying so cost an afternoon: the endpoint answers, the machine itself
    // trusts the CA, and only Electron's own root list does not. Named as what
    // it is, with the remedy, since "unreachable" sends the user to check a URL
    // and a firewall that are both fine.
    const isTls = TLS_FAILURE_CODES.has(cause)
    return {
      ok: false,
      reason: ac.signal.aborted
        ? `gateway did not answer within ${Math.round(timeoutMs / 1000)}s`
        : isTls
          ? `the gateway’s HTTPS certificate could not be verified (${cause})` +
            (usingSystemTrustStore()
              ? ' — its issuing CA is not trusted by this machine either; install that CA, or point NODE_EXTRA_CA_CERTS at it'
              : ' — this machine has no readable system CA bundle; point NODE_EXTRA_CA_CERTS at the issuing CA')
          : `gateway unreachable (${cause})`,
      models: [],
      tokenMinutes: null
    }
  } finally {
    clearTimeout(timer)
  }
}
