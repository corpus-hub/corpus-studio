import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { buildServer, type ServerDeps } from './server'
import { checkBearer, isThrottled, noteAuthFailure, tokenFingerprint } from './auth'
import { audit } from './audit'
import { noteFailure } from './status'
import { commitRequest, newRequestState, sessionKeyForSocket } from '../ipc/projectContext'

/**
 * The HTTP front door.
 *
 * ORDER OF CHECKS, and every one of them before a single body byte is read:
 *   1. path and method
 *   2. throttle
 *   3. `Host` against the allowlist
 *   4. reject if an `Origin` header is present at all
 *   5. `Authorization`
 *
 * All of 3, 4 and 5 answer with a BYTE-IDENTICAL 401 and an empty body, so the
 * response cannot be used to tell "wrong host" from "wrong token" — which is
 * what makes an unauthenticated scan uninformative. Locally, the audit log
 * records which check it actually was, and `lastError` gets a distinct enum
 * member, because a user whose client is refused for sending an `Origin` must
 * not be left reading the troubleshooting entry for a bad token.
 *
 * WHY WE READ THE BODY OURSELVES. `transport.handleRequest(req, res)` consumes
 * the request stream when no pre-parsed body is passed, which would make both
 * "authenticate before any body byte" and the running byte cap unimplementable.
 * So this file owns the stream: auth, then a counted read, then `JSON.parse`,
 * then `handleRequest(req, res, parsed)`.
 *
 * REJECTING EVERY REQUEST WITH AN `Origin`. This is the check that actually
 * stops a web page on the user's machine from driving their corpus — a browser
 * always sends one, and no legitimate MCP client on this transport needs to. It
 * is our own, in this file, rather than the SDK's `allowedOrigins: []`, whose
 * semantics for an EMPTY array are "no restriction" (verified in
 * `webStandardStreamableHttp.js`: the check is skipped unless the array is
 * non-empty). Relying on that would have been a control that did nothing.
 */

const PATH = '/mcp'
/** Beyond this, the request is aborted unread. 1 MiB is orders above any tool call. */
const MAX_BODY_BYTES = 1024 * 1024
/** A blank 401 body, identical for every rejection reason. */
const UNAUTHORIZED_HEADERS = {
  'WWW-Authenticate': 'Bearer realm="mcp"',
  'Content-Length': '0',
  // The socket is dropped after this response so an unauthenticated body is
  // never drained. Announcing that in the header is what makes the drop an
  // orderly close rather than a reset the client reports as a transport error
  // instead of as an auth failure.
  Connection: 'close'
} as const

export interface HttpDeps extends ServerDeps {
  token: () => string
  allowedHosts: () => string[]
}

export function createHttpServer(deps: Omit<HttpDeps, 'remoteAddress'>): Server {
  const server = createServer((req, res) => {
    void handle(req, res, deps).catch(() => {
      // Nothing request-derived may reach the renderer or the console; the audit
      // log already has the detail.
      noteFailure('internal')
      if (!res.headersSent) res.writeHead(500, { 'Content-Length': '0' })
      if (!res.writableEnded) res.end()
    })
  })

  // Slowloris is cheap and there is no reverse proxy in front of this.
  server.headersTimeout = 10_000
  server.requestTimeout = 60_000
  server.keepAliveTimeout = 15_000
  server.maxHeadersCount = 64
  server.maxConnections = 32

  return server
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: Omit<HttpDeps, 'remoteAddress'>
): Promise<void> {
  const address = req.socket.remoteAddress ?? 'unknown'
  const url = req.url ?? ''
  const path = url.split('?')[0]

  // THE FIRST THING, before the throttle and long before authentication.
  //
  // Everything below this line costs something an attacker can make us pay: two
  // SHA-256s, and a synchronous `appendFileSync` to the audit log, on the
  // thread that paints the window. Putting the limiter after the throttle left
  // the throttled branch — the one an attacker is IN, and stays in for five
  // minutes — doing exactly that at line rate while growing the log without
  // bound.
  //
  // It is also not the same control as the concurrency cap: three-at-a-time
  // says nothing about rate, so an agent looping strictly serial calls never
  // queues and never trips the depth limit. A legitimate client is nowhere near
  // 300 a minute.
  if (!takeGlobalToken()) {
    res.writeHead(429, { 'Retry-After': '1', 'Content-Length': '0' })
    res.end()
    return
  }

  const fingerprint = tokenFingerprint(req.headers.authorization)

  if (isThrottled(address, fingerprint)) {
    res.writeHead(429, { 'Retry-After': '300', 'Content-Length': '0' })
    res.end()
    return
  }

  const reject = (reason: 'host-refused' | 'origin-refused' | 'bad-token'): void => {
    noteAuthFailure(address, fingerprint)
    audit({ tool: '-', access: '-', address, outcome: 'refused', ms: 0, reason })
    // The status DTO gets the CATEGORY only, and only for the two a legitimate
    // user can hit by accident — a wrong token is diagnosed by the 401 itself.
    if (reason !== 'bad-token') noteFailure(reason)
    res.writeHead(401, UNAUTHORIZED_HEADERS)
    // Destroyed only once the 401 has actually flushed. Destroying alongside
    // `end()` races it, and the client then sees ECONNRESET rather than the
    // status — which both hides the real cause and reintroduces exactly the
    // observable difference the byte-identical 401 exists to remove.
    res.end(() => req.destroy())
  }

  const host = req.headers.host
  if (!host || !deps.allowedHosts().includes(host)) {
    reject('host-refused')
    return
  }

  if (req.headers.origin !== undefined) {
    reject('origin-refused')
    return
  }

  if (!checkBearer(req.headers.authorization, deps.token())) {
    reject('bad-token')
    return
  }

  // The path is checked AFTER authentication, and answers the same 401 as every
  // other refusal. A pre-auth 404 for `/` would tell an unauthenticated scanner
  // "something is here, wrong path" while a bad token said nothing — precisely
  // the discrimination the byte-identical 401 exists to remove.
  if (path !== PATH) {
    res.writeHead(404, { 'Content-Length': '0' })
    res.end()
    return
  }


  if (req.method === 'GET' || req.method === 'DELETE') {
    // Stateless: there is no standalone notification stream and no session to
    // delete. Answering 405 is what tells a client to stop asking, rather than
    // leaving it holding a stream that will never carry anything.
    res.writeHead(405, { Allow: 'POST', 'Content-Length': '0' })
    res.end()
    return
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST', 'Content-Length': '0' })
    res.end()
    return
  }

  let body: string
  try {
    body = await readBody(req)
  } catch (err) {
    // A client that went away is not a client that sent too much. Answering 413
    // either way sends whoever reads the log after an ordinary disconnect off
    // to look for a size problem that never existed.
    if (!(err instanceof BodyTooLargeError)) return
    res.writeHead(413, { 'Content-Length': '0' })
    // Destroyed from the flush callback, never alongside `end()`. Destroying
    // first races the response, and the client then reports ECONNRESET instead
    // of the 413 that told it what was wrong — the same mistake `reject()`
    // above exists to avoid.
    res.end(() => req.destroy())
    return
  }

  if (body.length === 0) {
    // Answer here rather than handing an empty body to the transport: with no
    // pre-parsed body it would try to read the stream we have already consumed
    // and fail with a less useful error.
    res.writeHead(400, { 'Content-Length': '0' })
    res.end()
    return
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    res.writeHead(400, { 'Content-Length': '0' })
    res.end()
    return
  }

  // A fresh transport and protocol server PER REQUEST, which is what stateless
  // mode means: there is no cross-request state to leak between two connected
  // agents, and a client that disappears mid-call leaves nothing behind.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  // Which agent connection this is, for the project-background re-send
  // suppression. The SOCKET and not the token+address pair: two Claude Code
  // sessions run by one person share a token and share 127.0.0.1, and telling
  // the second "you already have this" about a payload only the first received
  // is the one failure this feature may not have. A socket belongs to one client
  // process, so the worst it can do is make a client re-read its own background.
  const dossier = newRequestState(sessionKeyForSocket(req.socket), fingerprint)
  const mcp = buildServer({ ...deps, remoteAddress: address, dossier })
  try {
    await mcp.connect(transport)
    await transport.handleRequest(req, res, parsed)
    // ONLY here, and only on the way out. `shape` built the payload minutes of
    // queue time earlier; between then and now the result passes the 4 MiB
    // budget (which can replace it wholesale with a refusal envelope) and the
    // socket write. Recording at build time would mark as delivered a payload
    // the agent may never have been shown.
    commitRequest(dossier)
  } finally {
    // `handleRequest` has resolved by now, so the order is free; transport
    // first simply mirrors the order they were connected in.
    await transport.close().catch(() => undefined)
    await mcp.close().catch(() => undefined)
  }
}

/**
 * A global token bucket: 300 requests a minute across every client.
 *
 * Refilled continuously rather than on a timer, so nothing keeps the event loop
 * alive after the server stops. The burst allowance is the full minute's worth,
 * because a legitimate agent listing tools and then fetching a page of results
 * arrives in a burst and a smooth-only limiter would refuse it.
 */
const RATE_PER_MINUTE = 300
let tokens = RATE_PER_MINUTE
let lastRefill = Date.now()

function takeGlobalToken(): boolean {
  const now = Date.now()
  tokens = Math.min(RATE_PER_MINUTE, tokens + ((now - lastRefill) * RATE_PER_MINUTE) / 60_000)
  lastRefill = now
  if (tokens < 1) return false
  tokens -= 1
  return true
}

/**
 * Read the body with a RUNNING counter.
 *
 * Not `Content-Length`: it is absent under `Transfer-Encoding: chunked` (which
 * is legal HTTP/1.1 and some clients use by default) and it is attacker-
 * controlled anyway. Counting what actually arrives is the only cap that holds
 * for both framings.
 */
class BodyTooLargeError extends Error {}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    // `destroy()` below emits `'error'`, which would reject a second time with a
    // socket error and make the oversize case indistinguishable from an abort
    // at the call site — which is the whole reason the two are separate types.
    let done = false
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) {
        if (done) return
        done = true
        reject(new BodyTooLargeError('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (done) return
      done = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (err) => {
      if (done) return
      done = true
      reject(err)
    })
  })
}
