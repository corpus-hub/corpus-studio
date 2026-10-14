import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { userDataDir } from '../db/paths'
import { redactSecrets } from './auth'

/**
 * The MCP call log — append-only, always on while MCP is enabled.
 *
 * DELIBERATELY NOT the developer log. That one is OFF by default and prunes
 * itself to ten sessions, so routing the audit trail through it would mean the
 * trail did not exist on the installs that matter. We cannot show a confirmation
 * dialog for an agent's write — there is no human at the other end of the call —
 * so a record of what was done, kept unconditionally, is the substitute.
 *
 * Written 0600 in a 0700 directory: write-tool arguments are truncated to 500
 * characters, and 500 characters of a review verdict is the user's own judgement
 * about their own papers.
 *
 * Never contains a token: auth failures record the address and a digest
 * fingerprint, never the presented bytes.
 */

export type AuditOutcome = 'ok' | 'error' | 'refused'

export interface AuditRecord {
  tool: string
  access: string
  address: string
  outcome: AuditOutcome
  ms: number
  /** Only for write/destructive calls, truncated. */
  args?: unknown
  error?: string
  reason?: string
}

let dir: string | null = null
let file: string | null = null

export function auditDir(): string {
  return join(userDataDir(), 'mcp-audit')
}

/**
 * The audit trail could not be opened, so the server must not serve.
 *
 * Its own type so the start path can refuse rather than report a bind problem.
 */
export class AuditUnavailableError extends Error {
  constructor(readonly why: string) {
    super(
      `the MCP call log could not be opened (${why}). Refusing to serve: an agent's writes to ` +
        'this corpus are never confirmed by a human, so the record of what was done IS the ' +
        'control, and serving without it would leave the user an empty log they believe is ' +
        'complete. Fix the permissions on the mcp-audit folder in the app data folder.'
    )
    this.name = 'AuditUnavailableError'
  }
}

export function isAuditUnavailable(err: unknown): boolean {
  return err instanceof AuditUnavailableError
}

/**
 * Open the log for this session. Called once when the server starts.
 *
 * THROWS rather than continuing, and the directory is PROVEN writable by an
 * actual append rather than by the absence of an error from `mkdirSync`. An
 * unwritable log used to leave every later `audit()` a no-op while the server
 * answered normally — so the one artefact that records what an agent did to the
 * corpus was empty, and nothing said so. There is no human at the other end of
 * an MCP call to confirm a write; the trail is the whole of the accountability,
 * and a security log that silently does not exist is worse than one that is
 * missing loudly. `mkdirSync` succeeding does not establish writability either:
 * a directory can exist, be ours, and still refuse a write on a read-only mount
 * or a full disk, which is exactly the case that produced the empty log.
 */
export function openAudit(): void {
  dir = auditDir()
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch (e) {
    throw new AuditUnavailableError(
      (e as NodeJS.ErrnoException)?.code ?? 'the folder could not be created'
    )
  }
  const day = new Date().toISOString().slice(0, 10)
  const path = join(dir, `mcp-${day}.jsonl`)
  try {
    appendFileSync(path, '', { encoding: 'utf8', mode: 0o600 })
  } catch (e) {
    throw new AuditUnavailableError(
      (e as NodeJS.ErrnoException)?.code ?? 'the file could not be appended to'
    )
  }
  file = path
}

export function closeAudit(): void {
  file = null
}

/** Append one line. Never throws — a logging failure must not fail a call. */
export function audit(record: AuditRecord): void {
  if (!file) return
  try {
    const line = {
      t: new Date().toISOString(),
      ...record,
      args: record.args === undefined ? undefined : truncate(record.args),
      error: record.error === undefined ? undefined : redactSecrets(record.error).slice(0, 500)
    }
    appendFileSync(file, `${JSON.stringify(line)}\n`, { encoding: 'utf8', mode: 0o600 })
  } catch {
    /* see above */
  }
}

function truncate(args: unknown): string {
  try {
    return redactSecrets(JSON.stringify(args) ?? '').slice(0, 500)
  } catch {
    return '[unserializable]'
  }
}
