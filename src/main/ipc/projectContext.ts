import type { Socket } from 'node:net'
import type { DossierContextDTO } from '../../shared/contract'
import type { DB } from '../db/connection'
import type { Ctx, DossierRequestState } from './types'
import { buildDossierContext, dossierMembershipHash } from '../db/repositories'
import { hashInput } from '../adapters'

/**
 * The project's background claims, handed to an EXTERNAL agent, once.
 *
 * WHAT PROBLEM THIS SOLVES. The app's own pipeline already injects a compact
 * slice of the topic dossier into every prompt it builds (`buildDossierContext`,
 * ~250 tokens). An agent reading the same paper over MCP got none of it, so it
 * answered questions about a paper with no idea what the rest of the collection
 * already establishes. Every read that an agent uses to ANSWER about a paper
 * therefore carries the dossier with it.
 *
 * WHY THERE IS STATE HERE AT ALL. The same agent reads one paper through five or
 * six tools in a row — `paper_get`, then the summary, then the extracted rows,
 * then the text. Repeating the same 250 tokens on each is pure waste, so a read
 * that would repeat a payload the agent demonstrably already has sends a MARKER
 * naming its hash instead.
 *
 * THE ONE INVARIANT. State may only ever SUPPRESS a repeat; it may NEVER withhold
 * from an agent that has not been given the payload. Everything below is
 * arranged so that every uncertain case — unknown client, changed token, changed
 * membership, changed content, evicted entry, expired entry, dropped connection,
 * a response that was truncated or never reached the socket — falls out on the
 * side of sending the full payload again. A miss costs 250 tokens; a wrong
 * suppression costs the answer.
 *
 * THE SESSION KEY IS THE TCP CONNECTION, and that is the load-bearing choice.
 * The transport is deliberately stateless (`sessionIdGenerator: undefined` in
 * `mcp/http.ts`): a fresh protocol server per request, so the `clientInfo` a client
 * gives at `initialize` is answered by a server object that is closed before the
 * next call and is NOT reachable from a later request. The obvious substitute —
 * bearer-token fingerprint plus remote address — is IDENTICAL for two Claude
 * Code sessions run by the same person against the same install, which is a
 * routine setup; the second one would then be told `already_sent` about a
 * payload only the first received. That is the forbidden direction. A socket, by
 * contrast, belongs to exactly one client process: keep-alive means a burst of
 * reads about one paper shares it (which is the whole saving), and a second
 * client, a reconnect or an idle timeout yields a new key and a full re-send.
 *
 * The KNOWN LIMITATION of that choice, stated rather than hidden: a client that
 * opens a new connection per request — or one idle longer than the 15s
 * keep-alive — is suppressed never and pays the 250 tokens on every read. That
 * is the correct failure.
 *
 * IN `ipc/` AND NOT `mcp/`, for the same reason as `ipc/result.ts`: registry
 * entries call `projectContextFor` from their `shape`, and `mcp/server.ts`
 * imports the registry, so a `registry -> mcp` edge would close a cycle over
 * live function bindings — one of which would be undefined at module-init time
 * depending on which side loaded first. `mcp/http.ts` reaches IN here, never out.
 *
 * MARKS ARE STAGED, NOT WRITTEN. `shape` runs inside the queue, long before
 * `serializeWithinBudget` and the socket write. So a payload is recorded as sent
 * only from `commitRequest`, called by `mcp/http.ts` after `handleRequest` has
 * resolved without throwing — and never at all if the response was truncated or
 * replaced by the over-budget refusal envelope.
 */

/** Max distinct client sessions tracked. Beyond this the oldest is dropped. */
const MAX_SESSIONS = 32
/** Idle sessions expire. A key is normally dropped on socket close long before this. */
const IDLE_MS = 30 * 60_000
/** Max (project, work) payloads remembered per session. */
const MAX_PER_SESSION = 64

interface Session {
  /** `${projectId}:${workId}` -> the payload hash this client was sent. */
  sent: Map<string, string>
  /** Which bearer token this client presented. A regenerated token is a new client. */
  fingerprint: string
  lastSeen: number
}

const sessions = new Map<string, Session>()

export function newRequestState(key: string | null, fingerprint: string): DossierRequestState {
  return { key, fingerprint, pending: [], poisoned: false }
}

/** A stable id for this TCP connection, dropped when the socket closes. */
const SOCKET_KEY = Symbol('corpus.dossierSessionKey')
/**
 * MONOTONIC AND PROCESS-GLOBAL, and that is load-bearing rather than incidental.
 *
 * A key is never reused, so an entry written by a late `commitRequest` — after a
 * socket closed, or after a `stop()` cleared the map while its drain was still
 * running — is unreachable garbage the next sweep drops, and can never be found
 * by a LATER client and mistaken for its own. If this ever became per-server or
 * wrapped, "unreachable garbage" would become "another agent's suppression", the
 * one failure this module may not have.
 */
let socketSeq = 0

export function sessionKeyForSocket(socket: Socket): string | null {
  // A connection that is already gone gets NO key, which means every read on it
  // carries the full payload. Stamping one would register a `close` listener on a
  // socket that has already emitted `close`, leaving an entry nothing ever
  // deletes; and the request is one whose bytes may never have reached anyone.
  if (socket.destroyed) return null
  const holder = socket as unknown as Record<symbol, string | undefined>
  const existing = holder[SOCKET_KEY]
  if (existing !== undefined) return existing
  const key = `s${++socketSeq}`
  holder[SOCKET_KEY] = key
  // A closed connection is a client that is gone. Dropping its state here is
  // what keeps the map small in normal operation; the idle sweep is the backstop
  // for a socket whose close event never arrives.
  //
  // The listener closes over the KEY, a string — never the socket, the request or
  // the response. A closure capturing any of those would keep the connection's
  // buffers alive in the map for up to the idle timeout.
  socket.once('close', () => {
    sessions.delete(key)
    closed.add(key)
    // The tombstone set is bounded the same way the session map is: a key that
    // has been closed long enough that MAX_SESSIONS others have closed after it
    // cannot still have a request in flight.
    if (closed.size > MAX_SESSIONS * 4) {
      const oldest = closed.keys().next()
      if (!oldest.done) closed.delete(oldest.value)
    }
  })
  return key
}

/**
 * Keys whose connection has gone away, so a late `commitRequest` cannot
 * resurrect the entry the close handler just deleted.
 *
 * `handleRequest` resolving is not the same as the bytes reaching the client: a
 * client killed mid-flush emits `close` first and the commit lands after it.
 * Today that entry is merely unreachable (keys are never reused), but relying on
 * that makes a correctness property out of an allocation detail.
 */
const closed = new Set<string>()

function sweep(now: number): void {
  for (const [key, session] of sessions) {
    if (now - session.lastSeen > IDLE_MS) sessions.delete(key)
  }
  while (sessions.size > MAX_SESSIONS) {
    // Insertion order is touch order: `touch` re-inserts, so the first key is
    // the least recently used.
    const oldest = sessions.keys().next()
    if (oldest.done) break
    sessions.delete(oldest.value)
  }
}

/** Clear everything. Called when the server stops, so no state crosses a restart. */
export function clearDossierSessions(): void {
  sessions.clear()
  closed.clear()
}

/** For tests and audits only: how many client sessions are being tracked. */
export function dossierSessionCount(): number {
  return sessions.size
}

// --------------------------------------------------------------- the payload

export interface DossierPayload {
  dossier_hash: string
  note: string
  entries: DossierContextDTO['entries']
}

/**
 * The hash an agent is told to look for.
 *
 * TWO components, and both are needed. `dossierMembershipHash` is the app's own
 * cache key for the dossier and moves the instant the user changes which papers
 * feed it — the decision-shaped input. But it is a property of the project, and
 * the payload is a property of the project AND the target paper: entries are
 * ranked by overlap with that paper and the paper's own facts are removed. A
 * membership hash alone would therefore label paper B's never-seen payload with
 * paper A's hash. So the emitted hash also digests the payload text itself,
 * which makes it an identity of what was actually sent.
 *
 * Content-hashing is safe HERE in a way it was not for the pipeline: nothing is
 * reprocessed off this value. A moved hash costs one re-send.
 */
function payloadHash(db: DB, projectId: number, workId: number, context: string): string {
  return hashInput({
    membership: dossierMembershipHash(db, projectId, workId),
    context
  }).slice(0, 12)
}

/**
 * The full payload for one project and one target paper, or null when the
 * project has no dossier to give.
 *
 * `buildDossierContext` is the SAME function the internal pipeline feeds its own
 * prompts, and its JSON is parsed rather than reassembled: an agent and the app
 * then reason over byte-identical background, which is the only version of this
 * feature worth having.
 */
export function dossierPayload(db: DB, projectId: number, workId: number): DossierPayload | null {
  // project_id 0 is the GLOBAL sentinel: it names no project, so it has no
  // reference papers and no dossier. Asking for one would fabricate a project
  // reading of a paper and present it as global.
  if (projectId <= 0 || workId <= 0) return null
  let context: string
  try {
    context = buildDossierContext(db, projectId, workId)
  } catch {
    return null
  }
  if (!context) return null
  let parsed: { note?: unknown; entries?: unknown }
  try {
    parsed = JSON.parse(context) as { note?: unknown; entries?: unknown }
  } catch {
    return null
  }
  const entries = (
    Array.isArray(parsed.entries) ? parsed.entries : []
  ) as DossierContextDTO['entries']
  if (entries.length === 0) return null
  return {
    dossier_hash: payloadHash(db, projectId, workId, context),
    // The pipeline's own wording, taken verbatim rather than rewritten: the whole
    // point is that the agent and the app are reading the same background under
    // the same caveat.
    note:
      typeof parsed.note === 'string'
        ? parsed.note
        : 'Background from this project\u2019s reference papers; do not override values the ' +
          'document itself reports.',
    entries
  }
}

export interface DossierMarker {
  dossier_hash: string
  already_sent: true
}

/**
 * What a project-scoped read attaches: the full payload the first time this
 * client is given it, a marker naming its hash afterwards, and NOTHING when the
 * project has no dossier.
 *
 * The empty case is silent on purpose. A project with no reference papers is the
 * ordinary state of most projects, and a field on every response saying so would
 * be read exactly as often as a green "everything is fine" badge — which is to
 * say never, taking the markers that matter down with it.
 */
export function projectContextFor(
  ctx: Ctx,
  projectId: number | null | undefined,
  workId: number | null | undefined
): DossierPayload | DossierMarker | null {
  // The renderer never gets this: the UI shows the dossier on its own screen,
  // and `shape` is an MCP-only hook in the first place.
  if (ctx.source !== 'mcp') return null
  if (projectId === null || projectId === undefined) return null
  if (workId === null || workId === undefined) return null

  const payload = dossierPayload(ctx.db, projectId, workId)
  if (!payload) return null

  const state = ctx.dossier ?? null
  const slot = `${projectId}:${workId}`

  // EVERY uncertain path lands here, on the full payload: no request state
  // (nothing threaded it), no identifiable connection, a session we have never
  // seen, one whose token changed under us, one evicted or expired, or a
  // recorded hash that does not match what we would send now.
  const suppress =
    state !== null &&
    state.key !== null &&
    (hasSent(state, slot, payload.dossier_hash) ||
      // Already emitted IN THIS RESPONSE. Two tool calls arriving in one
      // JSON-RPC batch about the same paper would otherwise embed the same
      // kilobyte twice, and this is the one case where "sent" is certain: the
      // second copy travels in the same bytes as the first.
      state.pending.some((p) => p.slot === slot && p.hash === payload.dossier_hash))

  if (suppress) return { dossier_hash: payload.dossier_hash, already_sent: true }

  if (state !== null && state.key !== null) {
    state.pending.push({ slot, hash: payload.dossier_hash })
  }
  return payload
}

/**
 * Attach the project background to a result object, or return it untouched.
 *
 * A SIBLING of `items`, never a field on each row: the budget's truncation
 * halves `items` while preserving every sibling key, so the background survives
 * a cut list — and 200 copies of the same 1 KB would be what caused the cut.
 */
export function withProjectContext<T>(
  result: T,
  ctx: Ctx,
  projectId: number | null | undefined,
  workId: number | null | undefined
): T {
  const context = projectContextFor(ctx, projectId, workId)
  if (!context) return result
  return { ...(result as Record<string, unknown>), project_context: context } as T
}

function hasSent(state: DossierRequestState, slot: string, hash: string): boolean {
  if (state.key === null) return false
  const session = sessions.get(state.key)
  if (!session) return false
  if (Date.now() - session.lastSeen > IDLE_MS) {
    sessions.delete(state.key)
    return false
  }
  // A regenerated token means the person revoked this client's access and it
  // reconnected with a new one. Treat it as a client we have never met.
  if (session.fingerprint !== state.fingerprint) {
    sessions.delete(state.key)
    return false
  }
  if (session.sent.get(slot) !== hash) return false
  // A HIT counts as activity, in both dimensions. An agent whose reads are all
  // being suppressed is a live agent, and without this it ages out at thirty
  // minutes and loses its place in both LRUs — the paper it keeps coming back to
  // being exactly the one evicted first. Only ever costs a re-send, but this is
  // the cheap way not to pay it.
  session.lastSeen = Date.now()
  sessions.delete(state.key)
  sessions.set(state.key, session)
  session.sent.delete(slot)
  session.sent.set(slot, hash)
  return true
}

/**
 * Record what this response actually delivered.
 *
 * Called from `mcp/http.ts` AFTER `handleRequest` resolved, and skipped entirely when
 * the response was truncated or refused for size — in either of those cases the
 * agent may never have seen the payload, and the whole point of staging is that
 * "we built it" is not "it arrived".
 */
export function commitRequest(state: DossierRequestState | null | undefined): void {
  if (!state || state.key === null || state.poisoned || state.pending.length === 0) return
  // The connection went away. `handleRequest` resolving is not the bytes arriving,
  // so this response may have died in the socket's write buffer — and recording it
  // would resurrect the entry the close handler just deleted.
  if (closed.has(state.key)) return
  const now = Date.now()
  sweep(now)
  let session = sessions.get(state.key)
  if (session && session.fingerprint !== state.fingerprint) session = undefined
  if (!session) {
    session = { sent: new Map(), fingerprint: state.fingerprint, lastSeen: now }
  } else {
    // Re-inserted so insertion order stays touch order for the LRU above.
    sessions.delete(state.key)
  }
  session.lastSeen = now
  for (const { slot, hash } of state.pending) {
    session.sent.delete(slot)
    session.sent.set(slot, hash)
  }
  while (session.sent.size > MAX_PER_SESSION) {
    const oldest = session.sent.keys().next()
    if (oldest.done) break
    session.sent.delete(oldest.value)
  }
  sessions.set(state.key, session)
  // Trimmed AFTER the insert, not only before it. Sweeping first leaves the map
  // at MAX+1 forever, which is a cap that is off by one every time it is reached.
  sweep(now)
  state.pending.length = 0
}

/**
 * Which projects hold this paper and have background to give — for the reads
 * that name no project.
 *
 * `paper_get`, `paper_find_text` and `paper_text_get` are reads of the GLOBAL
 * work. Guessing a project for them would hand one project's interpretation to a
 * caller who asked about the paper itself, and pooling several would invent a
 * consensus across projects that never agreed. So they guess nothing: they name
 * the candidate projects and the one tool that answers. Emitted ONLY while there
 * is background the client has not been given — once it has it, silence.
 */
export function projectContextPointer(
  ctx: Ctx,
  workId: number | null | undefined
): { projects: number[]; note: string } | null {
  if (ctx.source !== 'mcp') return null
  if (workId === null || workId === undefined || workId <= 0) return null

  let rows: Array<{ project_id: number }>
  try {
    rows = ctx.db
      .prepare('SELECT project_id FROM project_work WHERE work_id = ? ORDER BY project_id ASC')
      .all(workId) as Array<{ project_id: number }>
  } catch {
    return null
  }

  const state = ctx.dossier ?? null
  const projects: number[] = []
  for (const { project_id: projectId } of rows) {
    if (projectId <= 0) continue
    const payload = dossierPayload(ctx.db, projectId, workId)
    if (!payload) continue
    if (
      state !== null &&
      state.key !== null &&
      hasSent(state, `${projectId}:${workId}`, payload.dossier_hash)
    ) {
      continue
    }
    projects.push(projectId)
  }
  if (projects.length === 0) return null

  return {
    projects,
    note:
      'This paper belongs to project(s) that hold background claims from their own reference ' +
      'papers, and you have not been given them. This read names no project, so none was ' +
      'assumed \u2014 call dossier_context_get with one of these projectId values and this ' +
      'workId before answering a question the background could change.'
  }
}
