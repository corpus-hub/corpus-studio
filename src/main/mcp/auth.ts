import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb } from '../db/connection'
import { getSetting, setSetting } from '../db/repositories'
import { userDataDir } from '../db/paths'
import { liveSecrets, registerSecret } from './redact'

/**
 * The bearer token, and every check made before a request body is read.
 *
 * THE TOKEN IS A FULL CAPABILITY over this corpus — whoever holds it can do
 * everything the user can do in the app — so it is treated like one:
 *
 * - It is NOT stored in the SQLite `setting` table. That file is mode 0644, sits
 *   in a predictable place, and is what a backup or a sync agent picks up. Only
 *   its SHA-256 goes in the DB; the token itself lives in `mcp.token` beside it,
 *   written 0600, the same shape `gateway.ts` already uses for the gateway key.
 * - It is never logged, never put in an Error message, and never on
 *   `McpStatusDTO` (which the Settings pane polls every 2s). `redactSecrets` is
 *   the belt to that braces and is applied to the process-wide error handlers,
 *   because `relaunch.sh` redirects stdout to a world-readable file in /tmp.
 * - Comparison is over fixed-length digests with `timingSafeEqual`, so the
 *   length-mismatch early return that leaks a byte of information disappears.
 */

const TOKEN_FILE = 'mcp.token'
const TOKEN_HASH_KEY = 'mcp_token_sha256'

function tokenPath(): string {
  return join(userDataDir(), TOKEN_FILE)
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

/**
 * The current token, minting one on first use.
 *
 * The file is the source of truth and the digest in the DB is the check. If they
 * disagree — a restored backup, a hand-edited file — the FILE wins and the
 * digest is rewritten, because the file is what the user has already pasted into
 * their agent's config.
 */
export class TokenUnreadableError extends Error {}

export function getOrCreateToken(): string {
  const path = tokenPath()
  if (existsSync(path)) {
    let value: string
    try {
      value = readFileSync(path, 'utf8').trim()
    } catch (e) {
      // A TOKEN THAT EXISTS AND CANNOT BE READ IS NOT A MISSING TOKEN.
      //
      // Falling through to `regenerateToken()` here mints a new credential
      // because of a transient EACCES or EIO — and minting is not a read-only
      // recovery: it OVERWRITES the file, so the value the user pasted into
      // every agent config is gone for good and every one of them starts
      // failing to authenticate with a blank 401. Refusing to start is
      // recoverable; rotating is not.
      throw new TokenUnreadableError(
        `the MCP token file exists but could not be read (${(e as NodeJS.ErrnoException)?.code ?? 'unknown error'}). ` +
          'Refusing to mint a new one: that would invalidate every agent config already holding this token. ' +
          'Fix the permissions on the file in the app data folder, or delete it to deliberately start over.'
      )
    }
    // An EMPTY file is a token that was never finished being written — nothing
    // is invalidated by replacing it, because it never authenticated anything.
    if (value) {
      // Re-assert the mode on every read: a token file that lost its 0600 to a
      // restore or an editor is a token anyone on the machine can read, and
      // this is the one place that notices.
      try {
        chmodSync(path, 0o600)
      } catch {
        /* a filesystem that cannot express the mode is not a reason to refuse */
      }
      syncDigest(value)
      cachedToken = value
      return value
    }
  }
  return regenerateToken()
}

/** Mint a new token, invalidating every config already pasted elsewhere. */
export function regenerateToken(): string {
  const value = randomBytes(32).toString('base64url')
  const dir = userDataDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, TOKEN_FILE)
  writeFileSync(path, value, { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    /* see above */
  }
  syncDigest(value)
  cachedToken = value
  return value
}

/** Whether a token has ever been minted, WITHOUT reading it. */
export function hasToken(): boolean {
  return existsSync(tokenPath())
}

/**
 * The token, cached, for the redactor's value pass.
 *
 * `redactSecrets` runs on every audit line and every tool result, so a reader
 * that hit `existsSync` + `readFileSync` each time would put a synchronous
 * filesystem round trip on the painting thread per log line. The cache is
 * written by everything that can change the value — mint, read, regenerate —
 * so there is no window in which it is behind.
 */
let cachedToken: string | null = null

registerSecret('mcp-token', () => {
  if (cachedToken !== null) return cachedToken
  try {
    const path = tokenPath()
    cachedToken = existsSync(path) ? readFileSync(path, 'utf8').trim() || null : null
  } catch {
    cachedToken = null
  }
  return cachedToken
})

function syncDigest(value: string): void {
  try {
    const want = sha256(value).toString('hex')
    if (getSetting(getDb(), TOKEN_HASH_KEY) !== want) setSetting(getDb(), TOKEN_HASH_KEY, want)
  } catch {
    /* the digest is a convenience; the file is authoritative */
  }
}

/**
 * Longest `Authorization` header we will even decode.
 *
 * `Buffer.from(x, 'base64url')` never throws — it silently drops invalid bytes —
 * so without a ceiling a megabyte of garbage in a header allocates a megabyte
 * before any check runs.
 */
const MAX_AUTH_HEADER = 8 * 1024

/** Constant-time check of a presented `Authorization` header against the token. */
export function checkBearer(header: string | undefined, expected: string): boolean {
  if (!header || header.length > MAX_AUTH_HEADER) return false
  const m = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (!m) return false
  // Digests, not the raw values: both sides are then exactly 32 bytes, so there
  // is no length branch to time and no early return that says "your token was
  // the wrong length".
  return timingSafeEqual(sha256(m[1]), sha256(expected))
}

/** A stable, non-reversible label for a presented token, for the throttle and the log. */
export function tokenFingerprint(header: string | undefined): string {
  const m = header ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null
  if (!m) return 'none'
  return sha256(m[1]).toString('hex').slice(0, 8)
}

// ------------------------------------------------------------------ throttle

interface Bucket {
  count: number
  windowStart: number
  blockedUntil: number
}

const FAILURE_WINDOW_MS = 60_000
const FAILURE_LIMIT = 10
const BLOCK_MS = 5 * 60_000
/**
 * A second, coarser ceiling per address.
 *
 * The fine-grained bucket is keyed on the presented token's fingerprint, which
 * is entirely caller-controlled — so a brute-forcer varying its token gets an
 * unlimited number of fresh buckets and is never throttled at all. The
 * fingerprint key exists to stop ONE buggy client locking out the user's real
 * agent on loopback, where every client is 127.0.0.1; this one is what actually
 * bounds an attack.
 */
const ADDRESS_FAILURE_LIMIT = 100

const buckets = new Map<string, Bucket>()

/**
 * Drop buckets that are both out of their window and out of their block.
 *
 * The fine-grained key includes the presented token's fingerprint, which is
 * caller-controlled — so without this a long-lived LAN session accumulates one
 * entry per token an attacker ever tried. Swept on write rather than on a timer,
 * because a timer would keep the event loop alive after the server stopped.
 */
function evict(now: number): void {
  if (buckets.size < 256) return
  for (const [key, b] of buckets) {
    if (b.blockedUntil <= now && now - b.windowStart > FAILURE_WINDOW_MS) buckets.delete(key)
  }
}

function bump(key: string, limit: number, now: number): boolean {
  evict(now)
  let b = buckets.get(key)
  if (!b) {
    b = { count: 0, windowStart: now, blockedUntil: 0 }
    buckets.set(key, b)
  }
  if (now - b.windowStart > FAILURE_WINDOW_MS) {
    b.windowStart = now
    b.count = 0
  }
  b.count++
  if (b.count > limit) {
    b.blockedUntil = now + BLOCK_MS
    return true
  }
  return false
}

/** Is this caller currently locked out? Checked before the token comparison. */
export function isThrottled(address: string, fingerprint: string): boolean {
  const now = Date.now()
  for (const key of [`a:${address}`, `t:${address}|${fingerprint}`]) {
    const b = buckets.get(key)
    if (b && b.blockedUntil > now) return true
  }
  return false
}

/** Record an authentication failure. */
export function noteAuthFailure(address: string, fingerprint: string): void {
  const now = Date.now()
  bump(`t:${address}|${fingerprint}`, FAILURE_LIMIT, now)
  bump(`a:${address}`, ADDRESS_FAILURE_LIMIT, now)
}

/** Forget every throttle bucket. Called on stop, so a restart is a clean slate. */
export function resetThrottle(): void {
  buckets.clear()
}

// ------------------------------------------------------------------ redaction

/**
 * Remove the secrets this process actually holds. Safe on ANY string.
 *
 * Value-based only, so it can be applied to data as well as to prose: an exact
 * match is never a false positive, and a corpus that happens to contain the
 * user's own token has bigger problems than a redaction.
 */
export function redactKnownSecrets(text: string): string {
  let s = text
  for (const secret of liveSecrets()) {
    if (secret.length >= 8) s = s.split(secret).join('[redacted]')
  }
  return s
}

/**
 * Strip anything token-SHAPED, as well as the secrets we hold.
 *
 * Belt to the braces of "never construct a message from a header value": this is
 * applied to the process-wide `unhandledRejection`/`uncaughtException` handlers,
 * which print raw to stdout, which `relaunch.sh` redirects to a world-readable
 * file in /tmp. The shape pass is what catches a PREVIOUS token, captured in an
 * error before a regenerate, that no value match can find.
 *
 * ONLY FOR PROSE — an error message, a log line, a stack. NEVER for data on its
 * way to a caller: the shape class also matches every 64-hex provenance digest
 * (`doc_input_hash` and friends), and those exist precisely so a reader can tell
 * WHICH input a disagreement is about. Use `redactKnownSecrets` there.
 */
export function redactSecrets(value: unknown): string {
  let s = typeof value === 'string' ? value : String((value as Error)?.stack ?? value)
  s = s.replace(/(Bearer|Authorization:?)\s+\S+/gi, '$1 [redacted]')
  // base64url of 32 bytes is 43 chars; anything of that class is treated as a
  // credential whether or not it is one. In PROSE a false positive costs a
  // debugging hint; a false negative costs the corpus.
  //
  // NO `\b` ANCHORS, and this is the whole point of the rule: `-` is not a word
  // character, so `\b…\b` splits a base64url token at every hyphen, and roughly
  // half of all 43-char tokens contain one. Half of every token ever minted
  // passed the anchored version intact.
  s = s.replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]')
  return redactKnownSecrets(s)
}
