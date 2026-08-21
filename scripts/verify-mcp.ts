// MCP protocol verification harness — `npm run verify:mcp`.
//
// The whole MCP transport (auth, the admission queue, the response-budget
// serializer, the audit log) and the MCP-ONLY `shape`/`clampArgs` hooks are
// unreachable from `verify:backend` (which calls repositories directly) and from
// the e2e suite (which drives the renderer over IPC). This harness is the only
// thing that executes them: it binds a REAL socket against a throwaway seeded
// SQLite database and speaks REAL MCP over HTTP with `fetch`.
//
// It NEVER touches the user's database and NEVER opens a window: it points both
// CORPUS_DB_PATH and XDG_CONFIG_HOME (which is what `userDataDir()` derives the
// token file and the audit directory from) at a temp directory it deletes on the
// way out.
//
// Run: npm run verify:mcp

import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir, homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import type { AddressInfo } from 'node:net'

/** The channel's own ceiling on `papers_search.limit`; the MCP clamp sits below it. */
const SEARCH_LIMIT_MAX = 300

/** Per-request deadline. Generous for a slow tool, short enough that a hang is visible. */
const REQUEST_TIMEOUT_MS = 120_000

const TMP = mkdtempSync(join(tmpdir(), 'corpus-mcp-'))
// BEFORE any module that resolves a path. `paths.ts` reads these at call time,
// but the token file is minted on the first `D.auth.getOrCreateToken()` and the audit
// directory on `D.audit.openAudit()`, both of which happen inside this file — so setting
// them here is enough and keeps the user's real config untouched.
process.env.CORPUS_DB_PATH = join(TMP, 'corpus.sqlite')
process.env.XDG_CONFIG_HOME = join(TMP, 'config')
// This harness owns its own server; nothing here may auto-start a second one.
process.env.CORPUS_NO_MCP = '1'

// DYNAMICALLY, and inside a function, for two independent reasons. The repo's
// script runner transpiles to CJS, where a top-level `await import` is a syntax
// error. And a static import is HOISTED above the `process.env` assignments
// above — so `paths.ts` and everything that reaches it would resolve against the
// user's REAL config directory, which is the one thing this harness must never
// touch.
type Deps = {
  db: typeof import('../src/main/db/connection')
  seed: typeof import('../src/main/db/seed')
  http: typeof import('../src/main/mcp/http')
  net: typeof import('../src/main/mcp/net')
  auth: typeof import('../src/main/mcp/auth')
  audit: typeof import('../src/main/mcp/audit')
  registry: typeof import('../src/main/ipc/registry')
  result: typeof import('../src/main/ipc/result')
  queue: typeof import('../src/main/mcp/queue')
  clamp: typeof import('../src/main/ipc/clamp')
  scheduler: typeof import('../src/main/pipeline/scheduler')
  vector: typeof import('../src/main/search/current')
  redact: typeof import('../src/main/mcp/redact')
  projectContext: typeof import('../src/main/ipc/projectContext')
  repos: typeof import('../src/main/db/repositories')
}

let D: Deps

async function load(): Promise<void> {
  // ORDER MATTERS, and only for the first line: the scheduler is how
  // `src/main/index.ts` itself reaches these modules, so entering through it
  // initialises them in the same order the app does. Loading `db/connection`
  // first has left module-level constants in their temporal dead zone.
  const scheduler = await import('../src/main/pipeline/scheduler')
  D = {
    scheduler,
    db: await import('../src/main/db/connection'),
    seed: await import('../src/main/db/seed'),
    http: await import('../src/main/mcp/http'),
    net: await import('../src/main/mcp/net'),
    auth: await import('../src/main/mcp/auth'),
    audit: await import('../src/main/mcp/audit'),
    registry: await import('../src/main/ipc/registry'),
    result: await import('../src/main/ipc/result'),
    queue: await import('../src/main/mcp/queue'),
    clamp: await import('../src/main/ipc/clamp'),
    vector: await import('../src/main/search/current'),
    redact: await import('../src/main/mcp/redact'),
    projectContext: await import('../src/main/ipc/projectContext'),
    repos: await import('../src/main/db/repositories')
  }
}

type Level = 'read' | 'write' | 'delete'

// ------------------------------------------------------------------ assertions

let failures = 0
let checks = 0
const failed: string[] = []

function ok(label: string, condition: boolean, detail?: unknown): void {
  checks++
  if (condition) return
  failures++
  failed.push(label)
  // eslint-disable-next-line no-console
  console.error(`  FAIL  ${label}${detail === undefined ? '' : `\n        ${trim(detail)}`}`)
}

function eq(label: string, actual: unknown, expected: unknown): void {
  ok(label, Object.is(actual, expected), `expected ${trim(expected)}, got ${trim(actual)}`)
}

function trim(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return (s ?? String(v)).slice(0, 400)
}

function section(name: string): void {
  // eslint-disable-next-line no-console
  console.log(`\n── ${name}`)
}

// ------------------------------------------------------------------ transport

let port = 0
let token = ''
let level: Level = 'delete'
let quitting = false

/**
 * Every response body this harness has seen, for the leak sweep at the end.
 *
 * Checked in one pass rather than per call: a leak that only appears in the
 * eighteenth tool's payload is exactly the one a per-call assertion is not
 * written for.
 */
const seenBodies: Array<{ label: string; body: string }> = []

/**
 * The server caps every caller at 300 requests a minute and answers 429 past
 * that. This harness makes several hundred calls, so it paces itself against
 * the same window rather than tripping a limit it is meant to be testing.
 */
const requestTimes: number[] = []
async function pace(): Promise<void> {
  const now = Date.now()
  while (requestTimes.length && now - requestTimes[0] > 60_000) requestTimes.shift()
  if (requestTimes.length >= 240) {
    const waitMs = Math.max(60_000 - (now - requestTimes[0]) + 250, 0)
    // eslint-disable-next-line no-console
    console.log(`  (pacing: ${Math.round(waitMs / 1000)}s to stay under the server's 300/min limit)`)
    await new Promise((r) => setTimeout(r, waitMs))
    return pace()
  }
  requestTimes.push(now)
}

/**
 * A request written straight onto a socket.
 *
 * `fetch`/undici REFUSES to send a `Host` header you set — it derives it from the
 * URL and silently drops yours. So every Host-allowlist assertion made through
 * `fetch` was in fact testing the correct loopback Host over and over and passing
 * for the wrong reason. Speaking HTTP/1.1 by hand is the only way to present a
 * `Host` the server did not choose, and that check is the DNS-rebinding defence.
 */
function rawSocket(
  lines: string[],
  body: string,
  opts: { chunkBytes?: number } = {}
): Promise<{ status: number; head: string; body: string }> {
  return new Promise((resolve, reject) => {
    let settled = false
    const sock = connect({ host: '127.0.0.1', port }, () => {
      sock.write(`${lines.join('\r\n')}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n`)
      // Written in CHUNKS when asked, because the oversize cap is enforced
      // mid-stream: the server answers 413 and destroys the socket as soon as
      // the running byte counter trips, long before a megabyte handed to
      // `write()` in one go has drained. Pushing it all at once meant the reset
      // arrived while we were still writing and the 413 was never read — the
      // status came back 0, and the cap looked broken when it was working.
      const size = opts.chunkBytes
      if (size === undefined) {
        sock.write(body)
        return
      }
      let at = 0
      const pump = (): void => {
        while (at < body.length && !sock.destroyed) {
          const next = body.slice(at, at + size)
          at += size
          if (!sock.write(next)) {
            sock.once('drain', pump)
            return
          }
        }
      }
      pump()
    })
    let buf = ''
    const finish = (): void => {
      if (settled) return
      settled = true
      sock.destroy()
      const split = buf.indexOf('\r\n\r\n')
      const head = split === -1 ? buf : buf.slice(0, split)
      const status = Number(/^HTTP\/1\.\d (\d+)/.exec(head)?.[1] ?? 0)
      resolve({ status, head, body: split === -1 ? '' : buf.slice(split + 4) })
    }
    // The STATUS is the whole assertion here, and an ACCEPTED request answers on
    // the Streamable HTTP transport — which may hold the socket open for an
    // event stream. Waiting for `end` would then hang on exactly the case that
    // is supposed to succeed, so the response is complete for our purposes the
    // moment the headers have arrived.
    sock.on('data', (c: Buffer) => {
      buf += c.toString('utf8')
      if (buf.includes('\r\n\r\n')) finish()
    })
    sock.on('end', finish)
    sock.on('close', finish)
    sock.setTimeout(15_000, () => {
      if (buf.startsWith('HTTP/')) {
        finish()
        return
      }
      sock.destroy()
      if (!settled) {
        settled = true
        reject(new Error('socket timeout with no response headers'))
      }
    })
    // A RESET IS AN EXPECTED OUTCOME HERE, not an error. The server answers 401
    // (and 413) and then destroys the socket by design, so an oversized body is
    // never drained — and the RST can overtake the response in the local
    // receive buffer. `finish()` reports whatever arrived, which is either the
    // status line the assertion wants or a zero status the assertion will fail
    // on with a real number; rejecting instead turned a documented behaviour
    // into a harness crash.
    sock.on('error', () => finish())
  })
}

interface RawResponse {
  status: number
  headers: Headers
  text: string
}

async function raw(
  body: string | null,
  opts: {
    path?: string
    method?: string
    auth?: string | null
    origin?: string
    host?: string
    accept?: string
    pace?: boolean
  } = {}
): Promise<RawResponse> {
  if (opts.pace !== false) await pace()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: opts.accept ?? 'application/json, text/event-stream'
  }
  if (opts.auth !== null) headers.Authorization = opts.auth ?? `Bearer ${token}`
  if (opts.origin !== undefined) headers.Origin = opts.origin
  if (opts.host !== undefined) headers.Host = opts.host
  // A HARD deadline on every request. Without one a server that stops
  // answering wedges the whole harness with no output, which is indistinguishable
  // from the harness itself hanging — and a verification script that can hang is
  // one nobody will run. A stall becomes a reported failure instead.
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(`http://127.0.0.1:${port}${opts.path ?? '/mcp'}`, {
      method: opts.method ?? 'POST',
      headers,
      body,
      signal: ctrl.signal
    })
    return { status: res.status, headers: res.headers, text: await res.text() }
  } finally {
    clearTimeout(timer)
  }
}

let nextId = 1

/**
 * One JSON-RPC round trip.
 *
 * The Streamable HTTP transport may answer either `application/json` or an SSE
 * stream depending on how the SDK is feeling about the request, so both framings
 * are decoded here — a harness that only understood one would report a protocol
 * failure the moment the SDK changed its mind.
 */
async function rpc(
  method: string,
  params: unknown,
  label: string
): Promise<{ status: number; message: Record<string, unknown> | null; text: string }> {
  const id = nextId++
  const res = await raw(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  seenBodies.push({ label, body: res.text })
  let message: Record<string, unknown> | null = null
  const ct = res.headers.get('content-type') ?? ''
  try {
    if (ct.includes('text/event-stream')) {
      for (const line of res.text.split('\n')) {
        if (!line.startsWith('data:')) continue
        const parsed = JSON.parse(line.slice(5).trim()) as Record<string, unknown>
        if (parsed.id === id) message = parsed
      }
    } else if (res.text) {
      message = JSON.parse(res.text) as Record<string, unknown>
    }
  } catch {
    message = null
  }
  return { status: res.status, message, text: res.text }
}

interface ToolOutcome {
  /** The parsed JSON payload of the single text content block, when there is one. */
  value: unknown
  /** The raw text of that block, so a non-JSON error message survives. */
  text: string
  isError: boolean
  /** A JSON-RPC error object, when the call failed at the PROTOCOL level. */
  protocolError: { code: number; message: string } | null
  parsedOk: boolean
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
  const { message } = await rpc('tools/call', { name, arguments: args }, `tools/call ${name}`)
  const err = (message?.error ?? null) as { code: number; message: string } | null
  const result = (message?.result ?? null) as
    | { content?: Array<{ type: string; text: string }>; isError?: boolean }
    | null
  const text = result?.content?.[0]?.text ?? ''
  let value: unknown = undefined
  let parsedOk = false
  if (text) {
    try {
      value = JSON.parse(text)
      parsedOk = true
    } catch {
      parsedOk = false
    }
  }
  return { value, text, isError: result?.isError === true, protocolError: err, parsedOk }
}

// ------------------------------------------------------------------ helpers

function asList(v: unknown): {
  items: unknown[]
  total: number
  limit: number | null
  offset: number
  scope_note: string | null
} | null {
  const o = v as Record<string, unknown> | null
  if (!o || !Array.isArray(o.items) || typeof o.total !== 'number') return null
  return o as never
}

/**
 * A read tool call that must succeed and must come back in the list envelope.
 *
 * The envelope check is the point: a tool whose `shape` regressed would still
 * answer 200 with a bare array, and an assertion that only looked at the status
 * would pass while every agent reading `total` got `undefined`.
 */
async function expectList(
  label: string,
  name: string,
  args: Record<string, unknown>,
  opts: { minItems?: number } = {}
): Promise<ReturnType<typeof asList>> {
  const r = await callTool(name, args)
  ok(`${label}: no protocol error`, r.protocolError === null, r.protocolError)
  ok(`${label}: not isError`, !r.isError, r.text)
  ok(`${label}: body parses as JSON`, r.parsedOk, r.text.slice(0, 200))
  const list = asList(r.value)
  ok(`${label}: list envelope {items,total,limit,offset,scope_note}`, list !== null, r.text.slice(0, 200))
  if (!list) return null
  ok(
    `${label}: total >= items.length (total is a COUNT(*), not the page size)`,
    list.total >= list.items.length,
    { total: list.total, got: list.items.length }
  )
  ok(
    `${label}: scope_note present when empty`,
    list.items.length > 0 || typeof list.scope_note === 'string',
    list
  )
  if (opts.minItems !== undefined) {
    ok(
      `${label}: returned real seeded rows (>= ${opts.minItems})`,
      list.items.length >= opts.minItems,
      { got: list.items.length, note: list.scope_note }
    )
  }
  return list
}

/** A read tool that must succeed and return a non-list object with the named keys. */
async function expectObject(
  label: string,
  name: string,
  args: Record<string, unknown>,
  keys: string[]
): Promise<Record<string, unknown> | null> {
  const r = await callTool(name, args)
  ok(`${label}: no protocol error`, r.protocolError === null, r.protocolError)
  ok(`${label}: not isError`, !r.isError, r.text)
  ok(`${label}: body parses as JSON`, r.parsedOk, r.text.slice(0, 200))
  const o = r.value as Record<string, unknown> | null
  ok(`${label}: object returned`, !!o && typeof o === 'object' && !Array.isArray(o), r.text.slice(0, 200))
  if (!o) return null
  for (const k of keys) {
    ok(`${label}: has "${k}"`, Object.prototype.hasOwnProperty.call(o, k), Object.keys(o).slice(0, 25))
  }
  return o
}

/**
 * A tool the docs describe as returning a BARE array, not the list envelope.
 *
 * Asserted explicitly rather than accepted either way: whether a tool is
 * enveloped is part of its contract, and a harness that shrugged at both would
 * not have caught the generated reference claiming the envelope for thirteen
 * tools that do not produce it.
 */
async function expectRawArray(
  label: string,
  name: string,
  args: Record<string, unknown>,
  minItems = 0
): Promise<unknown[]> {
  const r = await callTool(name, args)
  ok(`${label}: no protocol error`, r.protocolError === null, r.protocolError)
  ok(`${label}: not isError`, !r.isError, r.text)
  ok(`${label}: body parses as JSON`, r.parsedOk, r.text.slice(0, 200))
  ok(`${label}: a bare array, as documented (NOT the list envelope)`, Array.isArray(r.value), r.text.slice(0, 200))
  const arr = Array.isArray(r.value) ? r.value : []
  if (minItems > 0) {
    ok(`${label}: returned real seeded rows (>= ${minItems})`, arr.length >= minItems, arr.length)
  }
  return arr
}

interface DossierStatusShape {
  references: Array<{ work_id: number }>
  sources: Array<{ work_id: number }>
  fallback: boolean
  built_at: string | null
  built_work_ids: number[]
}

/**
 * `DossierStatusDTO`, or null if the body is not one.
 *
 * Narrowed rather than cast: an assertion that reads `.references` off an
 * unchecked cast sees `undefined` for a tool that regressed to a bare array and
 * quietly compares `undefined` to `undefined`.
 */
function dossierStatusOf(v: unknown): DossierStatusShape | null {
  const o = v as Record<string, unknown> | null
  if (!o || typeof o !== 'object') return null
  if (!Array.isArray(o.references) || !Array.isArray(o.sources)) return null
  if (typeof o.fallback !== 'boolean' || !Array.isArray(o.built_work_ids)) return null
  if (o.built_at !== null && typeof o.built_at !== 'string') return null
  return o as never
}

/** A tool documented as returning a plain number. */
async function expectScalar(label: string, name: string, args: Record<string, unknown>): Promise<number | null> {
  const r = await callTool(name, args)
  ok(`${label}: no protocol error`, r.protocolError === null, r.protocolError)
  ok(`${label}: not isError`, !r.isError, r.text)
  ok(`${label}: a bare number, as documented`, typeof r.value === 'number', r.text.slice(0, 120))
  return typeof r.value === 'number' ? r.value : null
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`[verify:mcp] temp root ${TMP}`)

  const db = D.db.initDatabase(process.env.CORPUS_DB_PATH as string)
  D.db.setDb(db)
  D.seed.seed(db)
  D.audit.openAudit()
  token = D.auth.getOrCreateToken()

  // The queue and the vector index are wired the way `src/main/index.ts` wires
  // them, because `queue_state`/`queue_pause`/`queue_resume` and the semantic
  // tools reach for module singletons and throw a bare "not initialised"
  // otherwise. A harness that accepted that error as a pass would be asserting
  // that four of the user's mandated capabilities are allowed to be broken.
  D.vector.setVectorDbPath(process.env.CORPUS_DB_PATH as string)
  // NEVER `start()`. This harness must not run real stages against real files;
  // what the queue tools read is `isRunning()`/`inFlightCount()`, and pause and
  // resume must move `isRunning` between false and true, which they do on a
  // scheduler that was constructed but never claimed a job.
  const scheduler = new D.scheduler.JobQueue(db, {
    name: 'verify-mcp',
    model: 'none',
    complete: async () => {
      throw new Error('verify:mcp never runs a model')
    }
  } as never)
  D.scheduler.setJobQueue(scheduler)

  const server = D.http.createHttpServer({
    token: () => token,
    allowedHosts: () => D.net.allowedHosts('127.0.0.1', port),
    level: () => level,
    quitting: () => quitting
  })
  await D.net.listen(server, '127.0.0.1', 0, false)
  port = (server.address() as AddressInfo).port
  // eslint-disable-next-line no-console
  console.log(`[verify:mcp] listening on 127.0.0.1:${port}`)

  try {
    await runHandshake()
    const advertised = await runToolList()
    await runAuth()
    await runOriginAndHost()
    await runPermissions(advertised)
    const ids = await runCapabilities()
    const backgroundWorkId = await runProjectContext(ids)
    runProjectContextStagingUnit(ids, backgroundWorkId)
    await runClampAndShape(ids)
    await runBudget(ids)
    await runConcurrency()
    await runErrorShapes()
    await runQueueUnit()
    runBudgetUnit()
    runRedactorUnit()
    runLeakSweep()
    runAuditCheck()
  } finally {
    await new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
    scheduler.stop()
    D.vector.dropVectorSearch()
    D.audit.closeAudit()
    D.db.closeDb()
  }
}

// ------------------------------------------------------------------ 1 handshake

async function runHandshake(): Promise<void> {
  section('handshake')
  const { status, message } = await rpc(
    'initialize',
    {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'verify-mcp', version: '1.0.0' }
    },
    'initialize'
  )
  eq('initialize: HTTP 200', status, 200)
  const result = message?.result as Record<string, unknown> | undefined
  ok('initialize: has a result', !!result, message)
  if (!result) return
  ok(
    'initialize: negotiated a protocol version',
    typeof result.protocolVersion === 'string' && (result.protocolVersion as string).length > 0,
    result.protocolVersion
  )
  const info = result.serverInfo as { name?: string; version?: string } | undefined
  eq('initialize: serverInfo.name is corpus-studio', info?.name, 'corpus-studio')
  ok('initialize: serverInfo.version present', typeof info?.version === 'string', info)
  const caps = result.capabilities as Record<string, unknown> | undefined
  ok('initialize: declares the tools capability', !!caps && 'tools' in caps, caps)
  ok(
    'initialize: instructions carry the agent rules (they are the only docs an agent reads)',
    typeof result.instructions === 'string' &&
      (result.instructions as string).includes('scope_note') &&
      (result.instructions as string).includes('camelCase'),
    (result.instructions as string)?.slice(0, 80)
  )
}

// ------------------------------------------------------------------ 2 tool list

/**
 * A JSON Schema an MCP client can actually use.
 *
 * Not "is it an object": a client feeds this to its own validator and to the
 * model's tool-call formatter, so an `inputSchema` that is not a `type: object`
 * with a `properties` map breaks the tool silently — the model simply never
 * calls it correctly.
 */
function schemaProblems(schema: unknown, path = ''): string[] {
  const bad: string[] = []
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return [`${path || '<root>'} is not an object`]
  }
  const s = schema as Record<string, unknown>
  if (path === '') {
    if (s.type !== 'object') bad.push('root type is not "object"')
    if (s.properties !== undefined && (typeof s.properties !== 'object' || Array.isArray(s.properties))) {
      bad.push('root properties is not a map')
    }
    if (s.required !== undefined) {
      if (!Array.isArray(s.required)) bad.push('required is not an array')
      else {
        const props = (s.properties ?? {}) as Record<string, unknown>
        for (const r of s.required as unknown[]) {
          if (typeof r !== 'string') bad.push('required holds a non-string')
          else if (!(r in props)) bad.push(`required names "${r}" which is not in properties`)
        }
      }
    }
  }
  if (typeof s.$ref === 'string') bad.push(`${path} carries a $ref, which a client cannot resolve`)
  if (s.$defs !== undefined) bad.push(`${path} carries $defs, which a client cannot resolve`)
  for (const [k, v] of Object.entries((s.properties ?? {}) as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') {
      bad.push(`${path}/properties/${k} is not a schema object`)
      continue
    }
    bad.push(...schemaProblems(v, `${path}/properties/${k}`).filter((m) => !m.endsWith('is not "object"')))
  }
  if (s.items && typeof s.items === 'object') {
    bad.push(...schemaProblems(s.items, `${path}/items`).filter((m) => !m.endsWith('is not "object"')))
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const arr = s[key]
    if (Array.isArray(arr)) {
      arr.forEach((sub, i) =>
        bad.push(...schemaProblems(sub, `${path}/${key}/${i}`).filter((m) => !m.endsWith('is not "object"')))
      )
    }
  }
  return bad
}

interface Advertised {
  name: string
  description?: string
  inputSchema?: unknown
}

async function runToolList(): Promise<Advertised[]> {
  section('tools/list is honest')
  level = 'delete'
  const { status, message } = await rpc('tools/list', {}, 'tools/list')
  eq('tools/list: HTTP 200', status, 200)
  const tools = ((message?.result as { tools?: Advertised[] } | undefined)?.tools ?? []) as Advertised[]
  ok('tools/list: returned tools', tools.length > 0, message)

  const expected = new Set(['health', ...D.registry.mcpTools('delete').map((e) => e.tool as string)])
  const advertisedNames = new Set(tools.map((t) => t.name))
  eq('tools/list: count equals registry(delete) + health', tools.length, expected.size)
  for (const name of expected) {
    ok(`tools/list: advertises "${name}"`, advertisedNames.has(name))
  }
  for (const name of advertisedNames) {
    ok(`tools/list: "${name}" is a real registry entry`, expected.has(name))
  }
  ok('tools/list: no duplicate tool names', advertisedNames.size === tools.length)

  // The generated reference is the CONTRACT an agent's operator reads. If it
  // and the server disagree, one of them is wrong and the run must say so.
  const doc = readFileSync(join(import.meta.dirname, '..', 'docs', 'mcp-tools.md'), 'utf8')
  const documented = new Set(Array.from(doc.matchAll(/^#### `([a-z_]+)`$/gm), (m) => m[1]))
  for (const name of expected) {
    if (name === 'health') continue
    ok(`docs/mcp-tools.md documents "${name}"`, documented.has(name))
  }
  for (const name of documented) {
    ok(`docs/mcp-tools.md's "${name}" is a real tool`, expected.has(name))
  }
  const headline = /^(\d+) tools, plus `health`/m.exec(doc)
  eq('docs/mcp-tools.md headline count', Number(headline?.[1]), D.registry.mcpTools('delete').length)

  for (const t of tools) {
    ok(
      `tools/list: "${t.name}" has a description an agent can act on`,
      typeof t.description === 'string' && t.description.length >= 20,
      t.description
    )
    const problems = schemaProblems(t.inputSchema)
    ok(`tools/list: "${t.name}" inputSchema is well-formed`, problems.length === 0, problems)
  }

  // The schema an agent is shown must be the one the tool validates against.
  for (const entry of D.registry.mcpTools('delete')) {
    const shown = tools.find((t) => t.name === entry.tool)
    if (!shown) continue
    ok(
      `tools/list: "${entry.tool}" schema equals D.registry.inputSchemaOf(entry)`,
      JSON.stringify(shown.inputSchema) === JSON.stringify(D.registry.inputSchemaOf(entry))
    )
  }
  return tools
}

// ------------------------------------------------------------------ 3 auth

async function runAuth(): Promise<void> {
  section('auth')
  const body = JSON.stringify({ jsonrpc: '2.0', id: 9001, method: 'tools/list', params: {} })

  const none = await raw(body, { auth: null })
  eq('auth: no Authorization header → 401', none.status, 401)
  eq('auth: 401 body is blank', none.text, '')

  const wrong = await raw(body, { auth: 'Bearer not-the-token-at-all' })
  eq('auth: wrong token → 401', wrong.status, 401)
  eq('auth: wrong-token 401 body is blank (indistinguishable from every other refusal)', wrong.text, '')
  eq(
    'auth: wrong-token 401 headers are byte-identical to the no-token 401',
    `${wrong.headers.get('www-authenticate')}|${wrong.headers.get('content-length')}`,
    `${none.headers.get('www-authenticate')}|${none.headers.get('content-length')}`
  )

  const malformed = await raw(body, { auth: token })
  eq('auth: token without the "Bearer " prefix → 401', malformed.status, 401)

  const query = await raw(body, { auth: null, path: `/mcp?token=${encodeURIComponent(token)}` })
  eq('auth: token in a query parameter is REFUSED (header only)', query.status, 401)

  const good = await raw(body)
  eq('auth: correct token → 200', good.status, 200)

  // Path is checked AFTER authentication on purpose: an unauthenticated 404
  // would tell a scanner "something is here, wrong path" while a bad token said
  // nothing. Both halves of that are asserted.
  const badPathAuthed = await raw(body, { path: '/not-mcp' })
  eq('auth: authenticated request to a wrong path → 404', badPathAuthed.status, 404)
  const badPathAnon = await raw(body, { path: '/not-mcp', auth: null })
  eq('auth: UNauthenticated wrong path → 401, not 404 (no scan signal)', badPathAnon.status, 401)

  const get = await raw(null, { method: 'GET' })
  eq('auth: GET (POST-only transport) → 405', get.status, 405)
  eq('auth: 405 names the allowed method', get.headers.get('allow'), 'POST')

  // The throttle is keyed on address+fingerprint, so hammering ONE wrong token
  // blocks that fingerprint and leaves the real one working — which is both the
  // documented behaviour and what keeps the rest of this run alive.
  section('auth throttle')
  const badToken = 'Bearer throttle-me-throttle-me-throttle-me'
  let sawBlock = false
  for (let i = 0; i < 14; i++) {
    const r = await raw(body, { auth: badToken })
    if (r.status === 429) {
      sawBlock = true
      eq('throttle: 429 carries Retry-After 300', r.headers.get('retry-after'), '300')
      break
    }
    eq(`throttle: refusal ${i + 1} is a 401 until the limit`, r.status, 401)
  }
  ok('throttle: >10 refusals in a minute from one caller → 429', sawBlock)
  const stillGood = await raw(body)
  eq('throttle: the real token is unaffected by another fingerprint being blocked', stillGood.status, 200)
}

// ------------------------------------------------------------------ 4 origin/host

async function runOriginAndHost(): Promise<void> {
  section('DNS-rebinding / Origin protection')
  const body = JSON.stringify({ jsonrpc: '2.0', id: 9100, method: 'tools/list', params: {} })

  for (const origin of ['http://evil.example', 'http://localhost:3000', 'null']) {
    const r = await raw(body, { origin })
    eq(`origin: a request carrying Origin: ${origin} is refused`, r.status, 401)
    eq(`origin: that refusal is a blank 401`, r.text, '')
  }

  const hosts = D.net.allowedHosts('127.0.0.1', port)
  ok(
    'host: the loopback allowlist holds no LAN address',
    !hosts.some((h) => /^\d/.test(h) && !h.startsWith('127.0.0.1')),
    hosts
  )

  const withHost = async (host: string): Promise<number> => {
    await pace()
    const r = await rawSocket(
      [
        'POST /mcp HTTP/1.1',
        `Host: ${host}`,
        `Authorization: Bearer ${token}`,
        'Content-Type: application/json',
        'Accept: application/json, text/event-stream',
        'Connection: close'
      ],
      body
    )
    return r.status
  }

  for (const host of ['evil.example', `evil.example:${port}`, '10.0.0.1', `attacker.test:${port}`]) {
    eq(`host: Host: ${host} is refused (DNS-rebinding defence)`, await withHost(host), 401)
  }
  for (const host of ['127.0.0.1', `127.0.0.1:${port}`, 'localhost', `localhost:${port}`]) {
    eq(`host: Host: ${host} is accepted`, await withHost(host), 200)
  }
  // A missing Host is refused too — HTTP/1.0 has no such header, and an
  // allowlist that treated absence as "nothing to check" would be bypassed by
  // one line of telnet.
  await pace()
  const noHost = await rawSocket(
    [
      'POST /mcp HTTP/1.0',
      `Authorization: Bearer ${token}`,
      'Content-Type: application/json',
      'Connection: close'
    ],
    body
  )
  eq('host: a request with NO Host header is refused', noHost.status, 401)
}

// ------------------------------------------------------------------ 5 permissions

async function runPermissions(all: Advertised[]): Promise<void> {
  section('permission levels')
  const writeTools = D.registry.ENTRIES.filter((e) => e.tool && e.access === 'write').map((e) => e.tool as string)
  const destructiveTools = D.registry.ENTRIES.filter((e) => e.tool && e.access === 'destructive').map(
    (e) => e.tool as string
  )
  ok('permissions: there are write tools to gate', writeTools.length > 0)
  ok('permissions: there are destructive tools to gate', destructiveTools.length > 0)

  const listAt = async (l: Level): Promise<Set<string>> => {
    level = l
    const { message } = await rpc('tools/list', {}, `tools/list@${l}`)
    return new Set(((message?.result as { tools?: Advertised[] })?.tools ?? []).map((t) => t.name))
  }

  const read = await listAt('read')
  eq('read level: tool count matches the docs table (46)', read.size, D.registry.mcpTools('read').length + 1)
  for (const t of [...writeTools, ...destructiveTools]) {
    ok(`read level: "${t}" is absent from tools/list`, !read.has(t))
  }
  ok('read level: health is always listed', read.has('health'))

  // HIDDEN IS NOT ENOUGH. A tool absent from the list but still dispatchable by
  // name is a security hole, not a cosmetic one, so every gated tool is CALLED.
  level = 'read'
  for (const t of [...writeTools, ...destructiveTools]) {
    const r = await callTool(t, {})
    ok(
      `read level: calling "${t}" directly is refused as a protocol error`,
      r.protocolError?.code === -32601,
      r.protocolError ?? r.text
    )
    ok(
      `read level: the refusal for "${t}" says it is a PERMISSION problem, not a missing tool`,
      /permission level/i.test(r.protocolError?.message ?? ''),
      r.protocolError?.message
    )
    ok(`read level: "${t}" returned no data`, r.value === undefined)
  }

  const write = await listAt('write')
  eq('write level: tool count', write.size, D.registry.mcpTools('write').length + 1)
  for (const t of writeTools) ok(`write level: "${t}" appears`, write.has(t))
  for (const t of destructiveTools) ok(`write level: "${t}" stays hidden`, !write.has(t))

  level = 'write'
  for (const t of destructiveTools) {
    const r = await callTool(t, {})
    ok(
      `write level: destructive "${t}" is still refused when called by name`,
      r.protocolError?.code === -32601,
      r.protocolError ?? r.text
    )
  }

  const del = await listAt('delete')
  eq('delete level: tool count', del.size, D.registry.mcpTools('delete').length + 1)
  eq('delete level: equals the full advertised set', del.size, all.length)
  for (const t of destructiveTools) ok(`delete level: "${t}" appears`, del.has(t))

  // `search_web` is filed under write even though it changes nothing here — the
  // query text leaves the machine. The docs say so; assert the code agrees.
  ok('permissions: search_web is a WRITE tool (the query leaves the machine)', writeTools.includes('search_web'))
  for (const t of ['paper_reprocess', 'paper_stage_rerun', 'job_cancel']) {
    ok(`permissions: "${t}" is destructive (it throws away analysis output)`, destructiveTools.includes(t))
  }

  level = 'delete'
}

// ------------------------------------------------------------------ 6 capabilities

interface Ids {
  projectId: number
  workId: number
  documentId: number | null
  jobId: number | null
  schemaId: number | null
}

async function runCapabilities(): Promise<Ids> {
  section("the user's 18 mandated capabilities")
  level = 'delete'

  // -- health, and the ids everything else hangs off ------------------------
  const h = await expectObject('health', 'health', {}, [
    'app',
    'db_file',
    'schema_version',
    'projects',
    'works',
    'documents',
    'tool_count',
    'permission_level'
  ])
  ok('health: reports the seeded corpus, not an empty install', (h?.works as number) > 0, h)
  eq('health: names this app', h?.app, 'corpus-studio')
  eq('health: reports the level in force', h?.permission_level, 'delete')
  eq('health: tool_count matches the level', h?.tool_count, D.registry.mcpTools('delete').length + 1)
  ok('health: db_file is a BASENAME, never a path', !String(h?.db_file ?? '').includes('/'), h?.db_file)

  const projects = await expectList('projects_list', 'projects_list', {}, { minItems: 1 })
  const projectId = ((projects?.items[0] as Record<string, unknown>)?.id as number) ?? 1
  ok('projects_list: first project has a numeric id', typeof projectId === 'number')

  const papers = await expectList(
    'project_papers_list',
    'project_papers_list',
    { projectId },
    { minItems: 1 }
  )
  const first = papers?.items[0] as Record<string, unknown> | undefined
  const work = first?.work as Record<string, unknown> | undefined
  const workId = (work?.id as number) ?? 1
  ok('project_papers_list: rows carry the PROJECT interpretation, not just the paper',
    first !== undefined && 'relevance' in first && 'expansion_priority' in first && 'inclusion_status' in first,
    Object.keys(first ?? {}))
  ok('project_papers_list: the two rankings are separate fields, never fused',
    typeof first?.relevance === 'number' && typeof first?.expansion_priority === 'number')

  // -- 1. paper search, by KEYWORD -----------------------------------------
  const kw = await expectList('capability 1 · keyword paper search', 'papers_search', { query: '' }, { minItems: 1 })
  ok(
    'papers_search: hits carry real paper fields (work_id + title)',
    typeof (kw?.items[0] as Record<string, unknown>)?.work_id === 'number' &&
      typeof (kw?.items[0] as Record<string, unknown>)?.title === 'string',
    kw?.items[0]
  )
  // A query that matches the first paper's own title must find it.
  const title = String(work?.title ?? '')
  const needle = title.split(/\s+/).filter((w) => w.length > 5)[0] ?? ''
  if (needle) {
    const targeted = await expectList(
      `papers_search: a word from a known title ("${needle}") finds it`,
      'papers_search',
      { query: needle }
    )
    ok(
      `papers_search: "${needle}" actually matched something (the filter is applied, not ignored)`,
      (targeted?.items.length ?? 0) > 0,
      targeted?.scope_note
    )
  }
  const nonsense = await expectList('papers_search: nonsense query', 'papers_search', {
    query: 'zzzqqqxxnotaword'
  })
  eq('papers_search: a nonsense query returns nothing', nonsense?.items.length, 0)
  ok(
    'papers_search: an empty result explains itself in scope_note',
    typeof nonsense?.scope_note === 'string' && (nonsense?.scope_note as string).length > 0,
    nonsense?.scope_note
  )
  ok(
    'papers_search: total for a nonsense query is 0, not the corpus size',
    nonsense?.total === 0,
    nonsense?.total
  )

  await expectScalar('papers_search_count', 'papers_search_count', { query: '' })
  const facets = await callTool('papers_search_facets', { projectId, query: '' })
  ok('papers_search_facets: succeeds', !facets.isError && facets.protocolError === null, facets.text)
  ok('papers_search_facets: returns facet buckets', facets.parsedOk && !!facets.value, facets.text.slice(0, 200))

  // -- 2. paper search, by MEANING -----------------------------------------
  const sem = await callTool('papers_search_by_meaning', { query: 'enzyme activity improvement', k: 5 })
  ok('capability 2 · semantic search: no protocol error', sem.protocolError === null, sem.protocolError)
  ok('capability 2 · semantic search: not isError', !sem.isError, sem.text)
  ok('capability 2 · semantic search: body parses', sem.parsedOk, sem.text.slice(0, 200))
  const semv = sem.value as Record<string, unknown> | null
  ok(
    'semantic search: returns hits OR a non-null "error" STATE — never a bare empty answer',
    !!semv && Array.isArray(semv.hits) && (semv.hits.length > 0 || typeof semv.error === 'string'),
    { hits: (semv?.hits as unknown[])?.length, error: semv?.error }
  )
  ok('semantic search: carries coverage so an agent can tell "absent" from "unembedded"',
    !!semv && 'coverage' in semv, Object.keys(semv ?? {}))
  eq('semantic search: echoes the k it actually used, so the reading budget is not a guess', semv?.requested_k, 5)
  const corpusCov = semv?.coverage as Record<string, unknown> | null
  ok(
    'semantic search: coverage counts the corpus it searched, not a constant',
    typeof corpusCov?.works_total === 'number' && (corpusCov.works_total as number) > 1,
    corpusCov
  )
  // An empty result must be explained by coverage. Nothing in this harness is
  // embedded, so "no hits" is entirely accounted for by the unembedded count —
  // and an agent that reported the corpus silent on the topic would be wrong.
  ok(
    'semantic search: an empty answer is explained — every paper in scope is accounted for as unembedded',
    (semv?.hits as unknown[])?.length > 0 ||
      corpusCov?.unembedded_total === corpusCov?.works_total,
    corpusCov
  )

  // SCOPING. `workId` must narrow the population the search ran over, not filter
  // a corpus-wide answer after the fact — and the only externally visible proof
  // is that the coverage counts SHRINK to that one paper. Calling the tool with
  // a workId and asserting only that it succeeded passes for a server that drops
  // the argument on the floor.
  const semWork = await callTool('papers_search_by_meaning', { query: 'catalytic activity', workId, k: 5 })
  ok('semantic search: a workId-scoped call succeeds', !semWork.isError && semWork.protocolError === null, semWork.text)
  const workCov = (semWork.value as Record<string, unknown> | null)?.coverage as Record<string, unknown> | null
  eq('semantic search: workId narrows the searched population to exactly ONE paper', workCov?.works_total, 1)
  eq(
    'semantic search: and that one paper is the one asked for',
    JSON.stringify((workCov?.unembedded as Array<Record<string, unknown>>)?.map((u) => u.work_id)),
    JSON.stringify([workId])
  )
  ok(
    'semantic search: the in-paper scope really is narrower than the corpus one',
    (workCov?.works_total as number) < (corpusCov?.works_total as number),
    { in_paper: workCov?.works_total, corpus: corpusCov?.works_total }
  )
  // A workId with no paper behind it must scope to nothing, not fall back to the
  // whole corpus — the fallback is what would make an agent quote another paper.
  const semGhost = await callTool('papers_search_by_meaning', { query: 'catalytic activity', workId: 999_999, k: 5 })
  ok('semantic search: an unknown workId is answered, not thrown', !semGhost.isError, semGhost.text)
  const ghostCov = (semGhost.value as Record<string, unknown> | null)?.coverage as Record<string, unknown> | null
  eq(
    'semantic search: an unknown workId scopes to NOTHING — it never silently widens to the corpus',
    ghostCov?.works_total,
    0
  )
  eq(
    'semantic search: and it returns no hits from papers that were never in scope',
    ((semGhost.value as Record<string, unknown> | null)?.hits as unknown[])?.length,
    0
  )
  // projectId scoping is a different narrowing, and must be applied too.
  const semProject = await callTool('papers_search_by_meaning', { query: 'catalytic activity', projectId, k: 5 })
  ok('semantic search: a projectId-scoped call succeeds', !semProject.isError, semProject.text)
  const projCov = (semProject.value as Record<string, unknown> | null)?.coverage as Record<string, unknown> | null
  eq(
    'semantic search: projectId scopes to the papers of that project',
    projCov?.works_total,
    papers?.total
  )

  const cov = await callTool('semantic_coverage_get', {})
  ok('semantic_coverage_get: succeeds', !cov.isError && cov.protocolError === null, cov.text)
  const covv = cov.value as Record<string, unknown> | null
  // The two tools must agree, or "read coverage before concluding something is
  // absent" sends the agent to a second, contradictory number.
  eq(
    'semantic_coverage_get: agrees with the coverage ridden along on a search',
    covv?.works_total,
    corpusCov?.works_total
  )
  eq('semantic_coverage_get: agrees on how many papers are unsearchable', covv?.unembedded_total, corpusCov?.unembedded_total)
  ok(
    'semantic_coverage_get: carries the FULL unsearchable list, where the search reply truncates it',
    (covv?.unembedded as unknown[])?.length >= (corpusCov?.unembedded as unknown[])?.length,
    { full: (covv?.unembedded as unknown[])?.length, on_search: (corpusCov?.unembedded as unknown[])?.length }
  )
  ok(
    'semantic_coverage_get: names WHY each paper is unsearchable, so the agent knows what to fix',
    (covv?.unembedded as Array<Record<string, unknown>>).every((u) => typeof u.reason === 'string'),
    (covv?.unembedded as unknown[])?.[0]
  )
  const covWork = await callTool('semantic_coverage_get', { workId })
  eq(
    'semantic_coverage_get: it honours workId scoping the same way the search does',
    (covWork.value as Record<string, unknown> | null)?.works_total,
    1
  )

  // -- 3/4. in-paper search, by WORD and by MEANING ------------------------
  const inPaperMeaning = await callTool('papers_search_by_meaning', {
    query: 'catalytic activity',
    workId,
    k: 5
  })
  ok(
    'capability 3 · in-paper search BY MEANING (papers_search_by_meaning + workId)',
    !inPaperMeaning.isError && inPaperMeaning.protocolError === null,
    inPaperMeaning.text
  )
  const inPaperWord = await callTool('paper_citation_contexts_get', { workId })
  ok(
    'capability 4 · in-paper search BY WORD (citation contexts / spans within the paper)',
    !inPaperWord.isError && inPaperWord.protocolError === null,
    inPaperWord.text
  )

  // -- 5. review state ------------------------------------------------------
  const queue = await expectList('capability 5 · review state', 'review_queue_get', { projectId })
  ok('review_queue_get: envelope carries a true total', (queue?.total ?? -1) >= 0)

  // -- 6/7/8. accept / correct / reject ------------------------------------
  const factId = findReviewableFactId(queue?.items ?? [])
  if (factId !== null) {
    // Each verdict is READ BACK through review_queue_get before the next is
    // written. Writing all three and then asserting the queue "reflects the
    // writes" — which only checked the list came back at all — passes for a
    // write that was dropped, for one that stored the wrong verdict, and for one
    // that filed it against a different fact.
    let expectedHistory = 0
    for (const [n, verdict, extra] of [
      ['6 · accept', 'accepted', {}],
      ['7 · correct', 'corrected', { correctedValue: '1.5' }],
      ['8 · reject', 'rejected', {}]
    ] as Array<[string, string, Record<string, unknown>]>) {
      const r = await callTool('review_record_verdict', { projectId, factId, verdict, ...extra })
      ok(`capability ${n} a verdict: no protocol error`, r.protocolError === null, r.protocolError)
      ok(`capability ${n} a verdict: accepted by the server`, !r.isError, r.text)
      expectedHistory++

      const wrote = r.value as Record<string, unknown> | null
      eq(`capability ${n} a verdict: the reply names the verdict recorded`, wrote?.verdict, verdict)
      eq(`capability ${n} a verdict: it is filed against the fact asked about`, wrote?.fact_id, factId)
      eq(`capability ${n} a verdict: it is filed under this project, never globally`, wrote?.project_id, projectId)
      eq(
        `capability ${n} a verdict: a corrected value is stored only for "corrected"`,
        wrote?.corrected_value,
        verdict === 'corrected' ? '1.5' : null
      )
      // The attribution the registry resolves in main, so an agent cannot sign a
      // scientist's judgement as if a human had made it.
      eq(`capability ${n} a verdict: attributed to the AGENT connection, not to a person`, wrote?.reviewer_kind, 'agent')
      ok(
        `capability ${n} a verdict: the OS account name is not handed to the agent`,
        !Object.prototype.hasOwnProperty.call(wrote ?? {}, 'reviewer'),
        Object.keys(wrote ?? {})
      )

      // READ BACK through a DIFFERENT tool. The write's own echo proves only
      // that the server can build a reply object.
      const back = await expectList(
        `review_queue_get after the ${verdict} verdict`,
        'review_queue_get',
        { projectId, limit: 200 }
      )
      const row = (back?.items ?? [])
        .map((i) => i as Record<string, unknown>)
        .find((i) => i.fact_id === factId)
      ok(`capability ${n} a verdict: the fact is still in the queue and readable`, row !== undefined, factId)
      const rowVerdict = row?.verdict as Record<string, unknown> | null | undefined
      eq(
        `capability ${n} a verdict: read back through review_queue_get, the CURRENT verdict is "${verdict}"`,
        rowVerdict?.verdict,
        verdict
      )
      eq(
        `capability ${n} a verdict: the corrected value survived the round trip`,
        rowVerdict?.corrected_value,
        verdict === 'corrected' ? '1.5' : null
      )
      eq(
        `capability ${n} a verdict: APPEND-ONLY — the history now holds ${expectedHistory} judgement(s), none overwritten`,
        row?.verdict_history_total,
        expectedHistory
      )
      eq(
        `capability ${n} a verdict: the reply's id matches the row now current in the queue`,
        rowVerdict?.id,
        wrote?.id
      )
    }
    // The trail, in order, is what a scientist re-reading their own review sees.
    const finalBack = await expectList(
      'review_queue_get: the full verdict trail',
      'review_queue_get',
      { projectId, limit: 200 }
    )
    const finalRow = (finalBack?.items ?? [])
      .map((i) => i as Record<string, unknown>)
      .find((i) => i.fact_id === factId)
    const history = (finalRow?.verdict_history ?? []) as Array<Record<string, unknown>>
    eq(
      'review verdicts: all three judgements are in the history, oldest first',
      JSON.stringify(history.map((h) => h.verdict)),
      JSON.stringify(['accepted', 'corrected', 'rejected'])
    )
    ok(
      'review verdicts: every entry in the trail is marked as having come from the agent',
      history.length > 0 && history.every((h) => h.reviewer_kind === 'agent'),
      history.map((h) => h.reviewer_kind)
    )
    ok(
      'review verdicts: the trail is append-only — each judgement has its own id',
      new Set(history.map((h) => h.id)).size === history.length,
      history.map((h) => h.id)
    )
    // Retraction is recorded, never deleted.
    const retract = await callTool('review_record_verdict', { projectId, factId, verdict: 'unresolved' })
    ok('review verdicts: a verdict is retracted by recording "unresolved"', !retract.isError, retract.text)
    const retracted = await expectList(
      'review_queue_get after the retraction',
      'review_queue_get',
      { projectId, limit: 200 }
    )
    const retractedRow = (retracted?.items ?? [])
      .map((i) => i as Record<string, unknown>)
      .find((i) => i.fact_id === factId)
    // A RETRACTION IS NOT A RESOLUTION. `unresolved` is a real appended row, and
    // the item goes BACK into the queue — so the current verdict reads null,
    // which is what tells a reader the fact still needs judging. Asserting
    // `verdict.verdict === 'unresolved'` here would have demanded the opposite
    // of the documented behaviour.
    eq(
      'review verdicts: a retraction returns the fact to UNJUDGED — the current verdict reads null, not "unresolved"',
      retractedRow?.verdict ?? null,
      null
    )
    eq(
      'review verdicts: but the retraction itself is on the record as the newest entry',
      ((retractedRow?.verdict_history ?? []) as Array<Record<string, unknown>>).at(-1)?.verdict,
      'unresolved'
    )
    eq(
      'review verdicts: retracting APPENDS — the three earlier judgements are still on the record',
      retractedRow?.verdict_history_total,
      4
    )
    // The rule the schema cannot express, so an agent only learns it by being refused.
    const badCorrect = await callTool('review_record_verdict', { projectId, factId, verdict: 'corrected' })
    ok(
      'review_record_verdict: "corrected" without a corrected value is REFUSED',
      badCorrect.isError,
      badCorrect.text.slice(0, 200)
    )
    const badExtra = await callTool('review_record_verdict', {
      projectId,
      factId,
      verdict: 'accepted',
      correctedValue: 'nope'
    })
    ok(
      'review_record_verdict: a corrected value on a non-"corrected" verdict is REFUSED',
      badExtra.isError,
      badExtra.text.slice(0, 200)
    )
    const globalVerdict = await callTool('review_record_verdict', { projectId: 0, factId, verdict: 'accepted' })
    ok(
      'review_record_verdict: the 0 sentinel is refused — a verdict is never global (HARD RULE 3)',
      globalVerdict.isError,
      globalVerdict.text.slice(0, 200)
    )
    // Neither refusal may have written anything.
    const untouched = await expectList(
      'review_queue_get after the refused verdicts',
      'review_queue_get',
      { projectId, limit: 200 }
    )
    eq(
      'review_record_verdict: a refused verdict wrote NOTHING — the trail is still four long',
      (untouched?.items ?? [])
        .map((i) => i as Record<string, unknown>)
        .find((i) => i.fact_id === factId)?.verdict_history_total,
      4
    )
  } else {
    ok('capabilities 6-8 · accept/correct/reject: a reviewable fact exists in the seed', false, {
      hint: 'review_queue_get returned no row carrying a fact id'
    })
  }

  // -- 9/10. global vs project summary --------------------------------------
  //
  // The DISTINCTION is the capability, and `gsum.text !== ''` was true of two
  // identical replies, of two empty ones, and of a tool that ignored both
  // `projectId` and `kind` entirely. What is asserted instead is that the 0
  // sentinel and a real project id produce answers scoped to what was asked
  // (HARD RULE 3).
  const gsum = await callTool('paper_summary_get', { workId, projectId: 0, kind: 'general' })
  ok('capability 9 · GLOBAL summary (projectId 0 sentinel)', gsum.protocolError === null && !gsum.isError, gsum.text)
  const gv = gsum.value as Record<string, unknown> | null
  eq('summaries: the GLOBAL summary is filed under the 0 sentinel, never a project', gv?.project_id, 0)
  eq('summaries: the global call answers for the kind asked', gv?.kind, 'general')
  eq('summaries: it answers for the paper asked', gv?.work_id, workId)

  const psum = await callTool('paper_summary_get', { workId, projectId, kind: 'project' })
  ok('capability 10 · PROJECT summary', psum.protocolError === null && !psum.isError, psum.text)
  const pv = psum.value as Record<string, unknown> | null
  eq('summaries: the PROJECT summary is filed under the real project id', pv?.project_id, projectId)
  eq('summaries: the project call answers for the kind asked', pv?.kind, 'project')
  eq('summaries: it answers for the paper asked', pv?.work_id, workId)
  ok(
    'summaries: the two are DIFFERENT records — the global one is not the project one relabelled',
    gv?.project_id !== pv?.project_id && gv?.kind !== pv?.kind,
    { global: { project_id: gv?.project_id, kind: gv?.kind }, project: { project_id: pv?.project_id, kind: pv?.kind } }
  )
  // The 0 sentinel is a STORAGE key, not a project one can ask a project
  // question of. Asking for a project summary under it must be refused, or the
  // reading would be filed against a question nobody asked.
  const sentinelProject = await callTool('paper_summary_get', { workId, projectId: 0, kind: 'project' })
  ok(
    'summaries: a PROJECT summary under the 0 sentinel is REFUSED — 0 is not a project (HARD RULE 3)',
    sentinelProject.isError,
    sentinelProject.text.slice(0, 200)
  )
  // A general summary is global whatever project is passed: it is the paper on
  // its own terms. A tool that filed it under the caller's project would have
  // put project interpretation on the global work.
  const generalUnderProject = await callTool('paper_summary_get', { workId, projectId, kind: 'general' })
  ok('summaries: a general summary can be asked for from inside a project', !generalUnderProject.isError, generalUnderProject.text)
  eq(
    'summaries: a general summary is stored GLOBALLY even when a project asks for it (HARD RULE 3)',
    (generalUnderProject.value as Record<string, unknown> | null)?.project_id,
    0
  )
  eq(
    'summaries: asking from inside a project returns the SAME global record',
    JSON.stringify(generalUnderProject.value),
    JSON.stringify(gsum.value)
  )
  // Every summary reports a STATE, and an absent summary is an answer rather
  // than an empty body an agent would report as "the paper says nothing".
  for (const [label, v] of [
    ['global', gv],
    ['project', pv]
  ] as Array<[string, Record<string, unknown> | null]>) {
    ok(
      `summaries: the ${label} summary reports a STATE, so "not written yet" is never mistaken for "nothing to say"`,
      typeof v?.state === 'string' && (v.state as string).length > 0,
      v
    )
    ok(
      `summaries: the ${label} summary has no body unless its state says it is ready`,
      v?.state === 'ready' ? typeof v?.body === 'string' && (v.body as string).length > 0 : v?.body === null,
      { state: v?.state, body: v?.body }
    )
  }
  // A project summary needs the project's dossier, and this harness has no model
  // to build one — so `no-dossier` is the correct, documented answer here, and it
  // is a STATE rather than a thrown error.
  ok(
    'summaries: a project summary with no dossier answers state "no-dossier" — a route to take, not a failure',
    pv?.state !== 'missing',
    pv?.state
  )

  const have = await expectObject('papers_with_summaries_list', 'papers_with_summaries_list', { projectId }, [
    'general',
    'project'
  ])
  ok(
    'papers_with_summaries_list: general and project are two SEPARATE id lists, never one fused list',
    Array.isArray(have?.general) && Array.isArray(have?.project),
    have
  )
  // The cheap index must agree with the per-paper read: a paper it lists as
  // summarised whose summary is not ready would send an agent to fetch nothing.
  ok(
    'papers_with_summaries_list: it agrees with paper_summary_get about this paper',
    (have?.general as number[]).includes(workId) === (gv?.state === 'ready') &&
      (have?.project as number[]).includes(workId) === (pv?.state === 'ready'),
    { general: have?.general, project: have?.project, gstate: gv?.state, pstate: pv?.state }
  )

  // -- 11. evidence ---------------------------------------------------------
  const analyses = await expectList('capability 11 · evidence (analyses + spans)', 'paper_analyses_list', {
    workId,
    projectId
  })
  const analysis = analyses?.items[0] as Record<string, unknown> | undefined
  if (analysis) {
    ok(
      'paper_analyses_list: an analysis carries its provenance (model + prompt/schema version)',
      'model' in analysis || 'run' in analysis || 'prompt_version' in analysis,
      Object.keys(analysis)
    )
  }

  // -- 12. extraction configuration ----------------------------------------
  const schemas = await expectRawArray('capability 12 · extraction config (schemas)', 'schemas_list', {}, 1)
  const schemaId = ((schemas[0] as Record<string, unknown>)?.id as number) ?? null
  await expectRawArray('project_schemas_list', 'project_schemas_list', { projectId })
  if (schemaId !== null) {
    const cov2 = await callTool('schema_coverage_get', { projectId })
    ok('schema_coverage_get: succeeds', !cov2.isError && cov2.protocolError === null, cov2.text)
    const exported = await callTool('schema_export', { schemaId })
    ok('schema_export: succeeds', !exported.isError && exported.protocolError === null, exported.text)
  }
  await expectRawArray('schema_presets_list', 'schema_presets_list', {})

  // -- 13. extracted data per paper ----------------------------------------
  const rows = await expectList('capability 13 · extracted data per paper', 'extraction_rows_get', {
    projectId,
    workId
  })
  // `every` over an EMPTY array is true, and empty was the bug's symptom — so the
  // non-emptiness is asserted first and the membership only means something
  // after it.
  ok(
    'extraction_rows_get: a scoped request returns rows rather than a confident nothing',
    (rows?.items.length ?? 0) > 0,
    { workId, note: rows?.scope_note }
  )
  ok(
    'extraction_rows_get: every returned row belongs to the paper that was asked for',
    (rows?.items.length ?? 0) > 0 &&
      (rows?.items ?? []).every((r) => (r as Record<string, unknown>).work_id === workId),
    (rows?.items ?? []).slice(0, 3)
  )
  const status = await expectObject('extraction_status_get', 'extraction_status_get', { projectId }, [])
  ok(
    'extraction_status_get: reports real counts, not an empty shell',
    Object.values(status ?? {}).some((v) => typeof v === 'number' || Array.isArray(v)),
    status
  )

  // -- 14. import -----------------------------------------------------------
  // Importing a PAPER is deliberately not a tool (docs/mcp.md: "Importing new
  // papers is not a tool"). What an agent CAN import is a reference it has no
  // metadata for; assert the documented route exists and answers.
  const unresolved = await expectList(
    'paper_unresolved_refs_get (for reference retrieval ids)',
    'paper_unresolved_refs_get',
    { workId }
  )
  const unresolvedIds = (unresolved?.items ?? [])
    .map((u) => (u as Record<string, unknown>).id)
    .filter((v): v is number => typeof v === 'number')
    .slice(0, 5)
  const retr = await callTool('reference_retrievals_get', { unresolvedIds })
  ok('capability 14 · import (reference retrieval state)', retr.protocolError === null && !retr.isError, retr.text)
  // No tool may take a filesystem path — chained with an outlet action that is
  // arbitrary file write as the user. Checked on PROPERTY NAMES at any depth,
  // which is the same rule the registry sweep enforces; asserting it again here
  // proves it holds on the schemas the server actually advertised, not only on
  // the ones the sweep read from source.
  const pathNamed = /^(path|abspath|abs_path|dir|directory|file|filepath|vaultpath|datadir)$/i
  const offenders: string[] = []
  const walk = (node: unknown, tool: string): void => {
    if (!node || typeof node !== 'object') return
    const n = node as Record<string, unknown>
    for (const [k, v] of Object.entries((n.properties ?? {}) as Record<string, unknown>)) {
      if (pathNamed.test(k.replace(/_/g, ''))) offenders.push(`${tool}.${k}`)
      walk(v, tool)
    }
    for (const key of ['items', 'anyOf', 'oneOf', 'allOf']) {
      const sub = n[key]
      if (Array.isArray(sub)) sub.forEach((x) => walk(x, tool))
      else walk(sub, tool)
    }
  }
  for (const entry of D.registry.mcpTools('delete')) walk(D.registry.inputSchemaOf(entry), entry.tool as string)
  ok(
    'capability 14 · import: NO tool takes a filesystem path (paper import stays a human action)',
    offenders.length === 0,
    offenders
  )
  const importTools = D.registry.ENTRIES.filter((e) => e.tool && /^import/.test(e.tool))
  eq('capability 14 · import: paper import is NOT exposed as a tool, as documented', importTools.length, 0)

  // -- 15. queue stop / resume ---------------------------------------------
  const before = await expectObject('queue_state (before)', 'queue_state', {}, [])
  const paused = await callTool('queue_pause', {})
  ok('capability 15 · queue STOP', paused.protocolError === null && !paused.isError, paused.text)
  const during = await expectObject('queue_state (paused)', 'queue_state', {}, [])
  ok(
    'queue_pause: the state actually changed to paused',
    during?.paused === true || during?.running === false || during?.state === 'paused',
    during
  )
  const resumed = await callTool('queue_resume', {})
  ok('capability 15 · queue RESUME', resumed.protocolError === null && !resumed.isError, resumed.text)
  const after = await expectObject('queue_state (resumed)', 'queue_state', {}, [])
  ok(
    'queue_resume: the state came back — running is true again',
    after?.running === true && during?.running === false,
    { before, during, after }
  )
  ok(
    'queue_pause / queue_resume: the two states are actually DIFFERENT (the pause was not a no-op)',
    JSON.stringify(during) !== JSON.stringify(after),
    { during, after }
  )
  // Left running, the scheduler claims the seeded jobs and starts executing real
  // pipeline stages against a provider this harness deliberately does not have —
  // which wedged the run for minutes with no output. Resume is the capability
  // under test; owning the state it leaves behind is this harness's job.
  const repaused = await callTool('queue_pause', {})
  ok('queue: the harness leaves the queue paused, as it found it', !repaused.isError, repaused.text)
  const jobs = await expectList('jobs_list', 'jobs_list', { projectId })
  const jobId = pickJobId(jobs?.items ?? [])
  if (jobId !== null) {
    const job = await callTool('job_get', { jobId })
    ok('job_get: returns the job that was asked for', !job.isError && job.protocolError === null, job.text)
  }
  await expectList('papers_stale_list', 'papers_stale_list', { projectId })

  // -- 16. end-to-end re-run ------------------------------------------------
  //
  // The states are the assertion. `protocolError === null` is true of a refusal,
  // of a schema rejection and of a tool that returns `{}` — every failure this
  // capability can have. `paper_reprocess` leads with a `state` discriminator
  // precisely because a job id list is not evidence that anything happened, so
  // that is what is read.
  const RERUN_STATES = [
    'rerunning',
    'already-current',
    'no-current-runs',
    'already-queued',
    'queued-but-paused',
    'not-in-project'
  ]
  const reprocess = await callTool('paper_reprocess', { workId, projectId })
  ok(
    'capability 16 · end-to-end re-run (paper_reprocess)',
    reprocess.protocolError === null && !reprocess.isError,
    reprocess.text
  )
  const rp = reprocess.value as Record<string, unknown> | null
  ok(
    'paper_reprocess: leads with a documented RerunState, not a bare job list',
    typeof rp?.state === 'string' && RERUN_STATES.includes(rp.state as string),
    rp?.state ?? reprocess.text.slice(0, 200)
  )
  ok(
    'paper_reprocess: the state is not "not-in-project" — the paper really is in the project asked about',
    rp?.state !== 'not-in-project',
    rp?.note
  )
  for (const k of [
    'superseded_run_ids',
    'stale_run_ids',
    'created_job_ids',
    'requeued_job_ids',
    'pending_job_ids',
    'all_job_ids',
    'planned_project_ids'
  ]) {
    ok(`paper_reprocess: "${k}" is an array of ids, so the agent can act on it`, Array.isArray(rp?.[k]), rp?.[k])
  }
  ok(
    'paper_reprocess: the note names the real counts rather than a plausible sentence',
    typeof rp?.note === 'string' && (rp.note as string).length > 40,
    rp?.note
  )
  ok(
    'paper_reprocess: it planned THIS project (the projectId is honoured, not ignored)',
    (rp?.planned_project_ids as number[])?.includes(projectId),
    rp?.planned_project_ids
  )
  ok(
    'paper_reprocess: queue_running is reported, so a paused queue cannot look like progress',
    typeof rp?.queue_running === 'boolean',
    rp?.queue_running
  )
  // The queue in this harness is constructed and never started, so a state that
  // claims jobs will move is the server misreporting the only thing an agent
  // uses to decide whether to poll.
  ok(
    'paper_reprocess: with the queue paused it never claims "rerunning" — it says the jobs will not start',
    rp?.queue_running === true || rp?.state !== 'rerunning',
    { state: rp?.state, queue_running: rp?.queue_running }
  )
  ok(
    'paper_reprocess: pending_job_ids is a subset of all_job_ids (it cannot invent jobs to poll)',
    (rp?.pending_job_ids as number[])?.every((id) => (rp?.all_job_ids as number[])?.includes(id)),
    { pending: rp?.pending_job_ids, all: rp?.all_job_ids }
  )
  // The one refusal that is an ANSWER. Asserted because the alternative — a
  // re-run filed against a project the paper does not belong to — writes an
  // interpretation under a question nobody asked, and it must not throw either.
  const otherProject = ((projects?.items ?? [])
    .map((p) => (p as Record<string, unknown>).id as number)
    .find((id) => id !== projectId)) ?? null
  if (otherProject !== null) {
    const foreign = await callTool('paper_reprocess', { workId, projectId: otherProject })
    ok('paper_reprocess: a paper/project mismatch is answered, not thrown', !foreign.isError, foreign.text)
    const fv = foreign.value as Record<string, unknown> | null
    ok(
      'paper_reprocess: a paper outside the project is REFUSED with state "not-in-project", and nothing is planned',
      fv?.state !== 'not-in-project' ||
        ((fv?.superseded_run_ids as unknown[])?.length === 0 &&
          (fv?.created_job_ids as unknown[])?.length === 0),
      fv
    )
  }
  // A paper that does not exist must be an error the agent can read, never a
  // silent success over nothing.
  const ghost = await callTool('paper_reprocess', { workId: 999_999, projectId })
  ok(
    'paper_reprocess: a re-run of a paper that does not exist FAILS — it never reports success over nothing',
    ghost.isError || ghost.protocolError !== null,
    ghost.text.slice(0, 200)
  )

  // -- 17. per-stage re-run -------------------------------------------------
  //
  // The stage name comes from `stages_list`, never from a literal. `'extract'`
  // was passed here and is not a stage id: every call was rejected by the enum,
  // came back isError, and the assertions — which read only `protocolError` and
  // the body length — passed on the rejection. This capability was never
  // executed at all.
  const stages = await expectRawArray('stages_list (for the stage ids)', 'stages_list', {}, 1)
  const rerunnable = stages
    .map((s) => s as Record<string, unknown>)
    .filter((s) => s.scope !== 'corpus')
  ok(
    'stages_list: names the per-paper stages a re-run can be asked for',
    rerunnable.length > 0 && rerunnable.every((s) => typeof s.id === 'string'),
    stages.slice(0, 3)
  )
  const stageId = rerunnable[0]?.id as string
  const stageRerun = await callTool('paper_stage_rerun', { workId, projectId, stage: stageId })
  ok(
    `capability 17 · per-stage re-run (paper_stage_rerun, stage "${stageId}")`,
    stageRerun.protocolError === null && !stageRerun.isError,
    stageRerun.text
  )
  const sr = stageRerun.value as Record<string, unknown> | null
  ok(
    'paper_stage_rerun: leads with a documented RerunState',
    typeof sr?.state === 'string' && RERUN_STATES.includes(sr.state as string),
    sr?.state ?? stageRerun.text.slice(0, 200)
  )
  ok(
    'paper_stage_rerun: superseded_run_ids names exactly what was discarded — never absent',
    Array.isArray(sr?.superseded_run_ids),
    sr
  )
  ok(
    'paper_stage_rerun: a state of "rerunning" is backed by runs it actually discarded',
    sr?.state !== 'rerunning' || (sr?.superseded_run_ids as unknown[]).length > 0,
    sr
  )
  // A stage id `stages_list` does not report must be REFUSED by the schema. This
  // is the check the old `'extract'` literal was silently exercising while
  // claiming to test a working re-run.
  const badStage = await callTool('paper_stage_rerun', { workId, projectId, stage: 'extract' })
  ok(
    'paper_stage_rerun: a stage id that is not in stages_list is refused, and the refusal names the ids that exist',
    badStage.isError && /stage/i.test(badStage.text),
    badStage.text.slice(0, 200)
  )
  // Corpus-scoped stages belong to no paper, so they are excluded from the enum
  // rather than accepted and quietly doing nothing.
  const corpusStage = stages
    .map((s) => s as Record<string, unknown>)
    .find((s) => s.scope === 'corpus')?.id as string | undefined
  if (corpusStage) {
    const cs = await callTool('paper_stage_rerun', { workId, projectId, stage: corpusStage })
    ok(
      `paper_stage_rerun: the corpus-scoped stage "${corpusStage}" is refused — it belongs to no paper`,
      cs.isError,
      cs.text.slice(0, 200)
    )
  }

  // -- 18a. citation contexts ----------------------------------------------
  const ctxs = await expectList('capability 18a · citation contexts', 'paper_citation_contexts_get', { workId })
  ok('paper_citation_contexts_get: envelope carries a true total', (ctxs?.total ?? -1) >= 0)
  await expectList('paper_unresolved_refs_get', 'paper_unresolved_refs_get', { workId })
  await expectList('paper_citations_get', 'paper_citations_get', { workId })

  // -- 18b. ranking ---------------------------------------------------------
  const ranking = await expectList('capability 18b · ranking', 'ranking_get', { projectId }, { minItems: 1 })
  const rrow = ranking?.items[0] as Record<string, unknown> | undefined
  ok(
    'ranking_get: relevance and expansion_priority are SEPARATE fields (HARD RULE 3)',
    !!rrow && 'relevance' in rrow && 'expansion_priority' in rrow,
    Object.keys(rrow ?? {})
  )
  ok('ranking_get: carries the stored explanation', !!rrow && 'ranking_explanation' in rrow, Object.keys(rrow ?? {}))
  const setIncl = await callTool('ranking_set_inclusion', { projectId, workId, status: 'included', reason: 'verify:mcp' })
  ok('ranking_set_inclusion: accepted', setIncl.protocolError === null && !setIncl.isError, setIncl.text)
  const readBack = await expectList('ranking_get after inclusion write', 'ranking_get', { projectId })
  ok(
    'ranking_set_inclusion: the write is visible on read-back',
    (readBack?.items ?? []).some((r) => {
      const o = r as Record<string, unknown>
      const w = o.work as Record<string, unknown> | undefined
      return (o.work_id === workId || w?.id === workId) && o.inclusion_status === 'included'
    }),
    (readBack?.items ?? []).slice(0, 2)
  )
  const override = await callTool('ranking_override_score', {
    projectId,
    workId,
    field: 'relevance',
    value: 0.77
  })
  ok('ranking_override_score: accepted', override.protocolError === null && !override.isError, override.text)
  const recompute = await callTool('ranking_recompute', { projectId })
  ok('ranking_recompute: no protocol error', recompute.protocolError === null, recompute.protocolError)
  ok('ranking_recompute: not isError', !recompute.isError, recompute.text)
  ok('ranking_recompute: body parses as JSON', recompute.parsedOk, recompute.text.slice(0, 200))
  // Deliberately NOT the list envelope: it is shaped to `{recomputed}` so an
  // agent is not handed every row of a large project. The contract that matters
  // is that the count is real — a `{recomputed: 0}` beside 20 ranked papers
  // would be the recompute silently doing nothing.
  ok(
    'ranking_recompute: returns the documented { recomputed } count, not a bare row array',
    typeof (recompute.value as Record<string, unknown>)?.recomputed === 'number' &&
      !Array.isArray(recompute.value),
    recompute.text.slice(0, 200)
  )
  ok(
    'ranking_recompute: the count matches the papers actually ranked (the work really happened)',
    (recompute.value as Record<string, number>)?.recomputed === (ranking?.total ?? -1),
    { recomputed: (recompute.value as Record<string, number>)?.recomputed, ranked: ranking?.total }
  )

  // -- 18c. dossier ---------------------------------------------------------
  const dossierList = await expectList('capability 18c · dossier_get', 'dossier_get', { projectId })
  // The claims must come from the papers the status names as the dossier's
  // SOURCES. Asserting instead that the dossier contains a paper derived from
  // this same response is true however the source set is resolved — including
  // for a `dossierSourceWorkIds` that ignored its filter and returned the whole
  // project, which is the bug that would matter.
  const refWorkIds = (dossierStatusOf(
    (await callTool('dossier_status_get', { projectId })).value
  )?.sources ?? []).map((s) => s.work_id)
  const claimWorkIds = [
    ...new Set((dossierList?.items ?? []).map((i) => (i as Record<string, unknown>).work_id as number))
  ]
  ok(
    'dossier_get: every claim comes from a paper the status names as a SOURCE (the set is filtered, not the whole project)',
    claimWorkIds.length > 0 && claimWorkIds.every((w) => refWorkIds.includes(w)),
    { claims_from: claimWorkIds, sources: refWorkIds }
  )
  // `quote` is NULLABLE by contract — a fact may legitimately have no evidence
  // span — so what is asserted is that the field is PRESENT and never an empty
  // string. An absent quote and a `""` read identically to an agent, and the
  // second would be rendered as the paper having said nothing at all.
  ok(
    'dossier_get: claims are grounded — each names its paper, its predicate, and either a real quote or an explicit null',
    (dossierList?.items ?? []).every((i) => {
      const o = i as Record<string, unknown>
      return (
        typeof o.work_id === 'number' &&
        typeof o.predicate === 'string' &&
        (o.predicate as string).length > 0 &&
        (o.quote === null || (typeof o.quote === 'string' && (o.quote as string).length > 0))
      )
    }),
    dossierList?.items.find((i) => {
      const o = i as Record<string, unknown>
      return o.quote === ''
    }) ?? dossierList?.items[0]
  )
  ok(
    'dossier_get: at least one claim carries a real quote — the evidence is not universally missing',
    (dossierList?.items ?? []).some((i) => typeof (i as Record<string, unknown>).quote === 'string'),
    dossierList?.items.length
  )
  // A quote the pipeline could NOT find in the document must be marked as such,
  // or an agent quotes it as something the paper says.
  ok(
    'dossier_get: every quote says whether it was found VERBATIM in the document',
    (dossierList?.items ?? []).every((i) => {
      const o = i as Record<string, unknown>
      return o.quote === null || typeof o.evidence_verbatim === 'boolean'
    }),
    dossierList?.items[0]
  )
  ok(
    'dossier_get: is_contrary is carried per claim, so disagreeing material cannot be silently dropped',
    (dossierList?.items ?? []).every((i) => typeof (i as Record<string, unknown>).is_contrary === 'boolean'),
    dossierList?.items[0]
  )

  const dstatus = await callTool('dossier_status_get', { projectId })
  ok('capability 18c · dossier_status_get', dstatus.protocolError === null && !dstatus.isError, dstatus.text)
  const dossierBefore = dossierStatusOf(dstatus.value)
  ok(
    'dossier_status_get: carries references, sources and the build provenance the docs promise',
    dossierBefore !== null,
    dstatus.text.slice(0, 200)
  )

  // A paper that is NOT already a reference, so the write has somewhere to move
  // the state TO. Marking one that is already marked is a no-op whose "after"
  // equals its "before", and an assertion over it passes for a tool that does
  // nothing at all.
  const alreadyRefs = new Set((dossierBefore?.references ?? []).map((r) => r.work_id))
  const freshRef =
    ((papers?.items ?? [])
      .map((p) => ((p as Record<string, unknown>).work as Record<string, unknown> | undefined)?.id as number)
      .find((id) => typeof id === 'number' && !alreadyRefs.has(id))) ?? null
  ok('dossier: the seed holds a paper not yet marked as a reference, so the write is observable', freshRef !== null)

  if (freshRef !== null) {
    const dadd = await callTool('dossier_add_paper', { projectId, workId: freshRef, isReference: true })
    ok('capability 18c · dossier_add_paper', dadd.protocolError === null && !dadd.isError, dadd.text)
    const addv = dadd.value as Record<string, unknown> | null
    eq('dossier_add_paper: reports the paper as marked', addv?.is_reference, true)
    eq(
      'dossier_add_paper: the reference count grew by exactly one',
      addv?.references_total,
      (dossierBefore?.references.length ?? 0) + 1
    )
    ok(
      'dossier_add_paper: says marking alone does not fold the paper in (the build is a separate act)',
      typeof addv?.next_step === 'string' && (addv.next_step as string).includes('dossier_build'),
      addv?.next_step
    )

    const after = dossierStatusOf((await callTool('dossier_status_get', { projectId })).value)
    const afterRefs = (after?.references ?? []).map((r) => r.work_id)
    ok(
      `dossier_add_paper: paper ${freshRef} is now in the status's references — the write reached the DB`,
      afterRefs.includes(freshRef),
      afterRefs
    )
    eq(
      'dossier_add_paper: it added ONE reference and displaced none of the existing ones',
      afterRefs.length,
      (dossierBefore?.references.length ?? 0) + 1
    )
    ok(
      'dossier_add_paper: the papers already marked are all still marked',
      [...alreadyRefs].every((id) => afterRefs.includes(id)),
      { before: [...alreadyRefs], after: afterRefs }
    )
    eq(
      'dossier_add_paper: marking a reference does not retroactively claim a BUILD covered it',
      (after?.built_work_ids ?? []).includes(freshRef),
      false
    )

    // Unmarked again, and asserted, so the write is proved REVERSIBLE rather
    // than merely observed once — and the rest of this run sees the state it
    // found. A tool that ignored `isReference: false` would leave the paper in.
    const drm = await callTool('dossier_add_paper', { projectId, workId: freshRef, isReference: false })
    ok('dossier_add_paper: unmarking is accepted', drm.protocolError === null && !drm.isError, drm.text)
    eq('dossier_add_paper: unmarking reports the paper as no longer a reference', (drm.value as Record<string, unknown>)?.is_reference, false)
    const restored = dossierStatusOf((await callTool('dossier_status_get', { projectId })).value)
    const restoredRefs = (restored?.references ?? []).map((r) => r.work_id)
    ok(
      `dossier_add_paper: unmarking removed paper ${freshRef} again — the flag is real state, not append-only`,
      !restoredRefs.includes(freshRef),
      restoredRefs
    )
    eq(
      'dossier_add_paper: the reference set is back to what this run found',
      restoredRefs.length,
      dossierBefore?.references.length ?? -1
    )
  }

  // dossier_build drives the MODEL, and this harness has no provider selected,
  // so the honest outcome is the provider refusal — NOT a success. Asserting
  // only that "a body came back" passes for that refusal and would equally pass
  // for a build that threw on its first reference paper. What is asserted is
  // that the refusal is the PROVIDER one and that it changed nothing: a failed
  // build that had already superseded runs would leave the project worse off
  // than before it was called.
  const beforeBuild = dossierStatusOf((await callTool('dossier_status_get', { projectId })).value)
  const dbuild = await callTool('dossier_build', { projectId })
  ok('capability 18c · dossier_build answers (synchronously, per its contract)', dbuild.protocolError === null, dbuild.protocolError)
  ok('dossier_build: returned a body', dbuild.text.length > 0)
  ok(
    'dossier_build: with no model selected it REFUSES and says so — it does not report a build it never ran',
    dbuild.isError && /provider|model/i.test(dbuild.text),
    dbuild.text.slice(0, 200)
  )
  const afterBuild = dossierStatusOf((await callTool('dossier_status_get', { projectId })).value)
  eq(
    'dossier_build: a refused build claims no built_at — the dossier is not marked as having been produced',
    afterBuild?.built_at ?? null,
    beforeBuild?.built_at ?? null
  )
  eq(
    'dossier_build: a refused build covered no papers',
    JSON.stringify(afterBuild?.built_work_ids ?? []),
    JSON.stringify(beforeBuild?.built_work_ids ?? [])
  )
  eq(
    'dossier_build: a refused build did not discard the claims that were already there',
    (await expectList('dossier_get after the refused build', 'dossier_get', { projectId }))?.total,
    dossierList?.total
  )

  // -- the rest of the surface, so nothing is unexecuted --------------------
  section('remaining surface')
  const documents = await expectList('paper_documents_list', 'paper_documents_list', { workId })
  const documentId =
    ((documents?.items[0] as Record<string, unknown>)?.id as number) ?? null
  await expectObject('paper_get', 'paper_get', { workId }, [])
  const resolved = await callTool('paper_resolve', { kind: 'title', paperRef: title || 'x' })
  ok('paper_resolve: succeeds', !resolved.isError && resolved.protocolError === null, resolved.text)
  ok(
    'paper_resolve: reports a STATE (resolved/ambiguous/not-found), never a guess',
    typeof (resolved.value as Record<string, unknown>)?.state === 'string',
    resolved.value
  )
  await expectObject('graph_get', 'graph_get', { projectId }, [])
  await expectObject('reference_tree_get', 'reference_tree_get', { projectId }, [])
  await expectList('search_history_list', 'search_history_list', { projectId })
  const rec = await callTool('search_record', { projectId, name: 'verify:mcp', query: 'kcat' })
  ok('search_record: accepted', rec.protocolError === null && !rec.isError, rec.text)
  const hist = await expectList('search_history_list after record', 'search_history_list', { projectId })
  ok(
    'search_record: the saved search is readable back',
    (hist?.items ?? []).some((s) => (s as Record<string, unknown>).name === 'verify:mcp'),
    (hist?.items ?? []).slice(0, 3)
  )
  for (const [name, args] of [
    ['integrations_status', {}],
    ['outlets_list', { projectId }],
    ['outlet_actions_list', { projectId, outletId: 'obsidian' }],
    ['export_options_list', { projectId }],
    ['llm_status_get', {}],
    ['storage_usage_get', {}],
    ['paper_citation_outcome_get', { workId }],
    ['queue_state', {}],
    ['reference_retrievals_get', { unresolvedIds: [] }]
  ] as Array<[string, Record<string, unknown>]>) {
    const r = await callTool(name, args)
    ok(`${name}: no protocol error`, r.protocolError === null, r.protocolError)
    ok(`${name}: not isError`, !r.isError, r.text)
    ok(`${name}: body parses as JSON`, r.parsedOk || r.text === '', r.text.slice(0, 200))
  }

  return { projectId, workId, documentId, jobId, schemaId }
}

function findReviewableFactId(items: unknown[]): number | null {
  for (const it of items) {
    const o = it as Record<string, unknown>
    for (const key of ['fact_id', 'factId', 'id']) {
      const v = o[key]
      if (typeof v === 'number') return v
    }
    const fact = o.fact as Record<string, unknown> | undefined
    if (typeof fact?.id === 'number') return fact.id
  }
  return null
}

function pickJobId(items: unknown[]): number | null {
  for (const it of items) {
    const o = it as Record<string, unknown>
    if (typeof o.id === 'number') return o.id
    if (typeof o.job_id === 'number') return o.job_id
  }
  return null
}

// -------------------------------------------------- 6b project background

/**
 * One AGENT, on ONE connection, for as many calls as it likes.
 *
 * The re-send suppression keys on the TCP socket (see
 * `src/main/ipc/projectContext.ts` for why not the token), so nothing about it is
 * observable through `fetch`: undici owns its pool and will happily answer two
 * calls on two sockets, which makes "the second read is suppressed" untestable
 * and — worse — makes it look UNSUPPRESSED whether the feature works or not. So
 * this speaks HTTP/1.1 keep-alive by hand and holds the socket itself.
 */
class AgentSocket {
  private sock: import('node:net').Socket | null = null
  private buf = Buffer.alloc(0)
  private waiting: ((body: string) => void) | null = null
  private id = 10_000
  /** The status line of the last response, so a refusal cannot masquerade as an answer. */
  private status = 0

  constructor(private readonly bearer: () => string) {}

  private async ensure(): Promise<import('node:net').Socket> {
    if (this.sock && !this.sock.destroyed) return this.sock
    const sock = connect({ host: '127.0.0.1', port })
    await new Promise<void>((resolve, reject) => {
      sock.once('connect', () => resolve())
      sock.once('error', reject)
    })
    sock.setNoDelay(true)
    sock.on('data', (c: Buffer) => {
      this.buf = Buffer.concat([this.buf, c])
      this.drain()
    })
    sock.on('error', () => undefined)
    this.sock = sock
    return sock
  }

  /**
   * One complete response, or nothing yet.
   *
   * BOTH framings, because this transport really uses both: a short answer comes
   * back with a `Content-Length` and a longer one `Transfer-Encoding: chunked`.
   * The exact byte count matters either way — on a keep-alive connection the next
   * response follows immediately, and a scan for a blank line would stop at the
   * SSE frame boundary inside this body and leave the following response's head
   * inside it. Working on a Buffer rather than a string for the same reason: a
   * multi-byte character split across two TCP segments decodes to a replacement
   * character and throws every offset off by one.
   */
  private drain(): void {
    if (!this.waiting) return
    const split = this.buf.indexOf('\r\n\r\n')
    if (split === -1) return
    const head = this.buf.subarray(0, split).toString('latin1')
    this.status = Number(/^HTTP\/1\.\d (\d+)/.exec(head)?.[1] ?? 0)
    const bodyStart = split + 4
    const rest = this.buf.subarray(bodyStart)

    let body: string
    let consumed: number
    const declared = /content-length:\s*(\d+)/i.exec(head)?.[1]
    if (declared !== undefined) {
      const len = Number(declared)
      if (rest.length < len) return
      body = rest.subarray(0, len).toString('utf8')
      consumed = len
    } else if (/transfer-encoding:\s*chunked/i.test(head)) {
      const decoded = decodeChunked(rest)
      if (!decoded) return
      body = decoded.body
      consumed = decoded.consumed
    } else {
      return
    }

    this.buf = this.buf.subarray(bodyStart + consumed)
    const resolve = this.waiting
    this.waiting = null
    resolve(body)
  }

  /** Drop the connection. The next call opens a new one — a NEW agent, to the server. */
  reconnect(): void {
    this.sock?.destroy()
    this.sock = null
    this.buf = Buffer.alloc(0)
    this.waiting = null
  }

  close(): void {
    this.reconnect()
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    await pace()
    const sock = await this.ensure()
    const rpcId = this.id++
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: rpcId,
      method: 'tools/call',
      params: { name, arguments: args }
    })
    const raw = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`agent socket timeout on ${name}`)), 30_000)
      this.waiting = (b) => {
        clearTimeout(timer)
        resolve(b)
      }
      this.status = 0
      sock.write(
        `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
          `Authorization: Bearer ${this.bearer()}\r\n` +
          'Content-Type: application/json\r\n' +
          'Accept: application/json, text/event-stream\r\n' +
          'Connection: keep-alive\r\n' +
          `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
      )
      this.drain()
    })
    seenBodies.push({ label: `agent tools/call ${name}`, body: raw })
    // THE STATUS IS ASSERTED, not assumed, and this is not a formality: a 429
    // from the global rate limiter, or a 400, answers with an empty body, and a
    // silent `null` return would then satisfy EVERY assertion of the form "this
    // response carries no project_context". Those checks would pass against a
    // server that answered nothing at all.
    ok(`agent socket ${name}: HTTP 200`, this.status === 200, { status: this.status, head: raw.slice(0, 120) })
    let message: Record<string, unknown> | null = null
    for (const line of raw.split('\n')) {
      const text = line.startsWith('data:') ? line.slice(5).trim() : line.trim()
      if (!text.startsWith('{')) continue
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>
        if (parsed.id === rpcId) message = parsed
      } catch {
        /* not this line */
      }
    }
    const result = message?.result as { content?: Array<{ text?: string }> } | undefined
    const payload = result?.content?.[0]?.text
    // Likewise a reply with no text block: `null` is a legitimate VALUE for some
    // tools, so "there was no answer" must be reported here rather than handed on
    // as one.
    ok(
      `agent socket ${name}: the reply carries a text result block`,
      typeof payload === 'string',
      raw.slice(0, 200)
    )
    if (typeof payload !== 'string') return null
    try {
      return JSON.parse(payload)
    } catch {
      return payload
    }
  }
}

/**
 * A chunked body, or null while the terminating zero-length chunk is still to
 * come. `consumed` counts the RAW bytes including the size lines, so the caller
 * can find where the next pipelined response begins.
 */
function decodeChunked(buf: Buffer): { body: string; consumed: number } | null {
  const parts: Buffer[] = []
  let at = 0
  for (;;) {
    const eol = buf.indexOf('\r\n', at)
    if (eol === -1) return null
    const size = Number.parseInt(buf.subarray(at, eol).toString('latin1').split(';')[0], 16)
    if (Number.isNaN(size)) return null
    const start = eol + 2
    if (size === 0) return { body: Buffer.concat(parts).toString('utf8'), consumed: start + 2 }
    if (buf.length < start + size + 2) return null
    parts.push(buf.subarray(start, start + size))
    at = start + size + 2
  }
}

interface Ctxish {
  dossier_hash?: unknown
  already_sent?: unknown
  entries?: unknown
  projects?: unknown
  note?: unknown
}

function contextOf(value: unknown): Ctxish | null {
  const o = value as Record<string, unknown> | null
  if (!o || typeof o !== 'object') return null
  const c = o.project_context
  if (!c || typeof c !== 'object') return null
  return c as Ctxish
}

function entriesOf(value: unknown): unknown[] {
  const c = contextOf(value)
  return Array.isArray(c?.entries) ? (c.entries as unknown[]) : []
}

/**
 * The project background an agent is handed with every project-scoped read.
 *
 * THE INVARIANT UNDER TEST, and the reason this section is long: the session
 * state may only SUPPRESS a repeat, never withhold from an agent that has not
 * been given the material. Each assertion below is written so that it FAILS if
 * suppression happens in a case where the agent has not actually received the
 * payload — a full payload arriving where a marker was expected is cheap and
 * correct, and only the reverse is a bug.
 */
async function runProjectContext(ids: Ids): Promise<number> {
  section('project background over MCP (project_context)')
  level = 'delete'
  const db = D.db.getDb()

  // The seed's own reference papers are what make this section non-vacuous: with
  // none marked, `buildDossierContext` falls back and every assertion below
  // would be comparing null to null.
  const refs = db
    .prepare('SELECT work_id FROM project_work WHERE project_id = ? AND is_reference = 1 ORDER BY work_id')
    .all(ids.projectId) as Array<{ work_id: number }>
  ok('project_context: the seeded project has reference papers to draw background from', refs.length > 0, refs)

  // Two DIFFERENT papers, neither of them a reference paper, both with a
  // non-empty dossier slice. Two are needed for the whole point of the feature:
  // the second read must be suppressed even though it is about another paper.
  const refIds = new Set(refs.map((r) => r.work_id))
  const candidates = (
    db
      .prepare(
        'SELECT work_id FROM project_work WHERE project_id = ? AND inclusion_status IS NOT NULL ORDER BY work_id'
      )
      .all(ids.projectId) as Array<{ work_id: number }>
  )
    .map((r) => r.work_id)
    .filter((id) => !refIds.has(id))
  // THE PRECONDITION IS ESTABLISHED FROM SQL, not from the module under test.
  //
  // Selecting the probe papers with `dossierPayload()` would let a mutation that
  // fabricates payloads satisfy its own precondition and then satisfy every
  // "carries entries" assertion below. So the claims are counted directly, and a
  // paper qualifies when the dossier holds claims from OTHER works — which is
  // exactly the condition `buildDossierContext` selects on (it removes the
  // target's own facts, which is why a reference paper's slice is empty).
  const claimsByWork = db
    .prepare(
      /* sql */ `
      SELECT ar.work_id AS work_id, COUNT(*) AS n
      FROM fact f
      JOIN analysis_run ar ON ar.id = f.analysis_run_id
      WHERE ar.superseded = 0 AND (ar.project_id = ? OR ar.project_id = 0)
        AND ar.work_id IN (SELECT work_id FROM project_work WHERE project_id = ? AND is_reference = 1)
        AND f.kind IN ('directly-reported', 'supplied-by-project-context', 'uncertain-conflicting', 'inferred')
      GROUP BY ar.work_id`
    )
    .all(ids.projectId, ids.projectId) as Array<{ work_id: number; n: number }>
  const totalClaims = claimsByWork.reduce((n, r) => n + r.n, 0)
  ok(
    'project_context: the seeded dossier holds claims to hand over (counted in SQL, not asked of the code under test)',
    totalClaims > 0,
    { totalClaims, claimsByWork }
  )
  const withBackground = candidates.filter(
    (id) => claimsByWork.some((r) => r.work_id !== id && r.n > 0)
  )
  ok(
    'project_context: at least two non-reference papers therefore have a non-empty slice (the section is not vacuous)',
    withBackground.length >= 2,
    withBackground
  )
  if (withBackground.length < 2) return 0
  const [workA, workB] = withBackground

  const agent = new AgentSocket(() => token)
  // Declared out here so the cleanup in `finally` can remove it whichever
  // assertion threw.
  let bareProject: number | null = null
  try {
    // --- 1. THE FIRST READ CARRIES THE MATERIAL ITSELF ---------------------
    const first = await agent.call('paper_summary_get', {
      workId: workA,
      projectId: ids.projectId,
      kind: 'project'
    })
    const firstCtx = contextOf(first)
    ok('project_context: a first project-scoped read carries project_context', firstCtx !== null, first)
    ok(
      'project_context: the FIRST read carries the entries themselves, not a marker',
      entriesOf(first).length > 0 && firstCtx?.already_sent === undefined,
      firstCtx
    )
    ok(
      'project_context: it names a hash the agent can look for',
      typeof firstCtx?.dossier_hash === 'string' && (firstCtx.dossier_hash as string).length > 0,
      firstCtx
    )
    ok(
      'project_context: entries are dossier claims (predicate + kind + contrary flag)',
      entriesOf(first).every((e) => {
        const o = e as Record<string, unknown>
        return typeof o.predicate === 'string' && typeof o.kind === 'string' && 'contrary' in o
      }),
      entriesOf(first)[0]
    )
    ok(
      'project_context: the note tells the reader not to override what the paper itself reports',
      typeof firstCtx?.note === 'string' && /override/i.test(firstCtx.note as string),
      firstCtx?.note
    )
    const hashA = firstCtx?.dossier_hash as string

    // --- 2. REPEATING THE SAME READ IS SUPPRESSED --------------------------
    const again = await agent.call('paper_summary_get', {
      workId: workA,
      projectId: ids.projectId,
      kind: 'project'
    })
    const againCtx = contextOf(again)
    eq('project_context: re-reading the SAME paper is suppressed to a marker', againCtx?.already_sent, true)
    eq('project_context: the marker names the SAME hash it was sent under', againCtx?.dossier_hash, hashA)
    eq('project_context: the marker carries NO entries (the saving is real)', entriesOf(again).length, 0)

    // --- 3. A DIFFERENT PAPER GETS ITS OWN MATERIAL ------------------------
    //
    // NOT suppressed, and that is the design, not an oversight. The payload is
    // per-paper: entries are ranked by overlap with the target and the target's
    // own claims are removed, so paper B's background is material paper A's read
    // never contained. A marker here would tell the agent it holds something it
    // has never seen — the forbidden direction.
    const other = await agent.call('paper_summary_get', {
      workId: workB,
      projectId: ids.projectId,
      kind: 'project'
    })
    ok(
      'project_context: a DIFFERENT paper gets its own entries, never a marker for material it never saw',
      entriesOf(other).length > 0 && contextOf(other)?.already_sent === undefined,
      contextOf(other)
    )
    const hashB = contextOf(other)?.dossier_hash as string
    ok('project_context: the two papers\u2019 payloads are distinguishable by hash', hashA !== hashB, {
      hashA,
      hashB
    })

    // --- 4. SUPPRESSION IS PER-CLIENT, ACROSS TOOLS ------------------------
    //
    // The whole reason the state exists: an agent reads one paper through several
    // tools in a row, and only the first of them should carry the 250 tokens.
    const sameViaAnotherTool = await agent.call('extraction_rows_get', {
      projectId: ids.projectId,
      workId: workA
    })
    eq(
      'project_context: ANOTHER tool reading the same paper is suppressed (the state is per-client, not per-tool)',
      contextOf(sameViaAnotherTool)?.already_sent,
      true
    )
    eq(
      'project_context: that marker names the same hash',
      contextOf(sameViaAnotherTool)?.dossier_hash,
      hashA
    )
    const analyses = await agent.call('paper_analyses_list', {
      workId: workA,
      projectId: ids.projectId
    })
    eq(
      'project_context: paper_analyses_list is suppressed too, and beside items rather than inside them',
      contextOf(analyses)?.already_sent,
      true
    )
    const analysisItems = (analyses as Record<string, unknown>)?.items
    ok(
      'project_context: it is a SIBLING of items, so a truncated list still carries it — and is on NO row',
      Array.isArray(analysisItems) &&
        (analysisItems as Array<Record<string, unknown>>).every((row) => !('project_context' in row)),
      Object.keys((analyses ?? {}) as object)
    )

    // --- 5. THE INVARIANT: NO SESSION ENTRY MEANS SEND -------------------
    //
    // A new connection is a client we have never met. It MUST get the full
    // material, however recently another client was given the same bytes: this is
    // the assertion the whole design exists to keep true.
    agent.reconnect()
    const fresh = await agent.call('paper_summary_get', {
      workId: workA,
      projectId: ids.projectId,
      kind: 'project'
    })
    ok(
      'INVARIANT: a client with no session entry receives the FULL background, never a marker',
      entriesOf(fresh).length > 0 && contextOf(fresh)?.already_sent === undefined,
      contextOf(fresh)
    )
    eq('project_context: the same material hashes the same for a new client', contextOf(fresh)?.dossier_hash, hashA)

    // A SECOND, concurrent agent must also be told everything, even though the
    // first one holds identical state under an identical token from an identical
    // address. This is the case a token+address key would have got wrong.
    const second = new AgentSocket(() => token)
    try {
      const forSecond = await second.call('paper_summary_get', {
        workId: workA,
        projectId: ids.projectId,
        kind: 'project'
      })
      ok(
        'INVARIANT: a SECOND agent on the same token and address is told everything, not "already_sent"',
        entriesOf(forSecond).length > 0 && contextOf(forSecond)?.already_sent === undefined,
        contextOf(forSecond)
      )
    } finally {
      second.close()
    }

    // --- 6. CHANGING MEMBERSHIP RE-SENDS, UNASKED ------------------------
    //
    // The user marking or unmarking a reference paper is a DECISION, and an agent
    // holding the old background must be handed the new one without knowing to
    // ask. Suppress the read first, then move the membership, then read again.
    const membershipBefore = D.repos.dossierMembershipHash(db, ids.projectId, workA)
    const suppressedBefore = await agent.call('paper_summary_get', {
      workId: workA,
      projectId: ids.projectId,
      kind: 'project'
    })
    eq(
      'project_context: suppressed immediately before the membership change (the baseline for the next check)',
      contextOf(suppressedBefore)?.already_sent,
      true
    )
    // A paper that has facts of its own, or marking it as a reference changes
    // nothing about what the dossier contains and the re-send would be testing
    // nothing. Chosen in SQL for the same reason as the probes above.
    const newRef = (
      db
        .prepare(
          /* sql */ `
        SELECT pw.work_id AS work_id
        FROM project_work pw
        WHERE pw.project_id = ? AND pw.is_reference = 0
          AND EXISTS (
            SELECT 1 FROM fact f JOIN analysis_run ar ON ar.id = f.analysis_run_id
            WHERE ar.work_id = pw.work_id AND ar.superseded = 0
              AND f.kind IN ('directly-reported', 'supplied-by-project-context',
                             'uncertain-conflicting', 'inferred')
          )
        ORDER BY pw.work_id`
        )
        .all(ids.projectId) as Array<{ work_id: number }>
    )
      .map((r) => r.work_id)
      .find((id) => id !== workA && id !== workB)
    ok(
      'project_context: a further paper with facts of its own exists to mark as a reference',
      newRef !== undefined,
      candidates
    )
    if (newRef !== undefined) {
      // `is_reference` ALONE, which is now exactly what the hash keys on.
      // Touching `inclusion_status` alongside it would prove nothing: it is no
      // longer an input, so the re-send could pass without the marking having
      // been noticed at all.
      db.prepare(
        'UPDATE project_work SET is_reference = 1 WHERE project_id = ? AND work_id = ?'
      ).run(ids.projectId, newRef)
      const membershipMoved =
        D.repos.dossierMembershipHash(db, ids.projectId, workA) !== membershipBefore
      ok(
        'project_context: marking a reference paper MOVES the membership hash, so a summary ' +
          'produced before the marking is reopened by it',
        membershipMoved,
        { membershipBefore }
      )
      const afterChange = await agent.call('paper_summary_get', {
        workId: workA,
        projectId: ids.projectId,
        kind: 'project'
      })
      ok(
        'project_context: marking a new reference paper RE-SENDS the background without the agent asking',
        entriesOf(afterChange).length > 0 && contextOf(afterChange)?.already_sent === undefined,
        contextOf(afterChange)
      )
      ok(
        'project_context: and under a NEW hash, so the agent can tell it apart from what it holds',
        typeof contextOf(afterChange)?.dossier_hash === 'string' &&
          contextOf(afterChange)?.dossier_hash !== hashA,
        { before: hashA, after: contextOf(afterChange)?.dossier_hash }
      )
      // Unmarking must move it too, and back to a suppressible steady state.
      db.prepare('UPDATE project_work SET is_reference = 0 WHERE project_id = ? AND work_id = ?').run(
        ids.projectId,
        newRef
      )
      const afterRevert = await agent.call('paper_summary_get', {
        workId: workA,
        projectId: ids.projectId,
        kind: 'project'
      })
      ok(
        'project_context: UNmarking it re-sends as well \u2014 the change is what matters, not its direction',
        entriesOf(afterRevert).length > 0 && contextOf(afterRevert)?.already_sent === undefined,
        contextOf(afterRevert)
      )
    }

    // --- 7. THE RECOVERY TOOL ANSWERS INDEPENDENTLY ------------------------
    //
    // `dossier_context_get` is what an agent is TOLD to call when it cannot find
    // a hash it was told it holds. If it could ever answer "already_sent" the
    // instruction would lead into a dead end, so it consults no state at all —
    // asserted by calling it twice on a connection that has just been suppressed.
    const suppressNow = await agent.call('paper_summary_get', {
      workId: workA,
      projectId: ids.projectId,
      kind: 'project'
    })
    eq('project_context: suppressed, so the recovery tool is being asked by a client that "has" it',
      contextOf(suppressNow)?.already_sent, true)
    for (const attempt of [1, 2]) {
      const rec = (await agent.call('dossier_context_get', {
        projectId: ids.projectId,
        workId: workA
      })) as Record<string, unknown> | null
      eq(`dossier_context_get (call ${attempt}): state ready`, rec?.state, 'ready')
      ok(
        `dossier_context_get (call ${attempt}): returns the entries themselves, whatever the session believes`,
        Array.isArray(rec?.entries) && (rec?.entries as unknown[]).length > 0,
        rec
      )
      eq(`dossier_context_get (call ${attempt}): never answers with a marker`, rec?.already_sent, undefined)
      ok(
        `dossier_context_get (call ${attempt}): names the hash the reads use, so the two can be matched up`,
        typeof rec?.dossier_hash === 'string',
        rec?.dossier_hash
      )
    }

    // --- 8. NOTHING IS FABRICATED WHERE THERE IS NO DOSSIER ----------------
    //
    // A project with no reference papers has no background, and the read must be
    // SILENT about it rather than carrying a reassuring "none" on every response
    // (hard rule 0.6). project_id 0 is the global sentinel and names no project
    // at all, so it can never have one.
    const bare = (bareProject = db
      .prepare(
        "INSERT INTO project (name, slug, created_at, updated_at) " +
          "VALUES ('verify-mcp bare project', 'verify-mcp-bare', datetime('now'), datetime('now'))"
      )
      .run().lastInsertRowid as number)
    db.prepare(
      'INSERT OR IGNORE INTO project_work (project_id, work_id, relevance, expansion_priority, ' +
        "inclusion_status, created_at, updated_at) VALUES (?, ?, 0.5, 0.5, 'unread', datetime('now'), datetime('now'))"
    ).run(bare, workA)
    const noDossier = await agent.call('paper_summary_get', {
      workId: workA,
      projectId: bare,
      kind: 'project'
    })
    eq(
      'project_context: a project with NO dossier fabricates none \u2014 the field is absent, not a reassuring "none"',
      contextOf(noDossier),
      null
    )
    const recNone = (await agent.call('dossier_context_get', {
      projectId: bare,
      workId: workA
    })) as Record<string, unknown> | null
    eq('dossier_context_get: state "none" for a project with no reference papers', recNone?.state, 'none')
    eq('dossier_context_get: and no invented entries', (recNone?.entries as unknown[])?.length, 0)
    const recGlobal = (await agent.call('dossier_context_get', {
      projectId: 0,
      workId: workA
    })) as Record<string, unknown> | null
    eq(
      'dossier_context_get: project_id 0 is the GLOBAL sentinel and has no dossier',
      recGlobal?.state,
      'none'
    )
    const general = await agent.call('paper_summary_get', {
      workId: workA,
      projectId: 0,
      kind: 'general'
    })
    eq(
      'project_context: a GENERAL summary (projectId 0) carries no project background \u2014 it is the paper\u2019s own account',
      contextOf(general),
      null
    )

    // --- 9. THE GLOBAL READS GUESS NO PROJECT ------------------------------
    //
    // `paper_get` and the text reads are reads of the paper ITSELF. Attaching one
    // project's background would present that project's framing as the
    // document's own, so they name the candidate projects and the tool instead.
    // Asserted from a FRESH connection, because the pointer is only raised while
    // the client is actually missing something — the whole point is to send it
    // somewhere it can get what it does not have.
    agent.reconnect()
    const globalRead = await agent.call('paper_get', { workId: workA })
    const pointer = contextOf(globalRead)
    ok(
      'project_context: paper_get points at the projects holding background rather than guessing one',
      Array.isArray(pointer?.projects) && (pointer.projects as number[]).includes(ids.projectId),
      pointer
    )
    eq(
      'project_context: the pointer carries NO entries \u2014 it never attributes a project\u2019s reading to the paper',
      entriesOf(globalRead).length,
      0
    )
    ok(
      'project_context: and names the tool that answers',
      typeof pointer?.note === 'string' && (pointer.note as string).includes('dossier_context_get'),
      pointer?.note
    )
    // The text reads share that treatment, and resolve a documentId to its work
    // first — a document has no project memberships of its own.
    const textRead = await agent.call('paper_text_get', { workId: workA })
    ok(
      'project_context: paper_text_get points at the projects too, and asserts no project reading of the text',
      Array.isArray(contextOf(textRead)?.projects) && entriesOf(textRead).length === 0,
      contextOf(textRead)
    )
    // And it goes SILENT once the client has the material: a pointer to
    // something the agent already holds is the reassuring badge rule 0.6 forbids.
    const given = await agent.call('paper_summary_get', {
      workId: workA,
      projectId: ids.projectId,
      kind: 'project'
    })
    ok(
      'project_context: (precondition) the client has now been given project ' +
        `${ids.projectId}\u2019s background for this paper`,
      entriesOf(given).length > 0,
      contextOf(given)
    )
    const globalAfter = await agent.call('paper_get', { workId: workA })
    eq(
      'project_context: paper_get stops pointing once the agent holds every project\u2019s background for that paper',
      contextOf(globalAfter),
      null
    )
  } finally {
    agent.close()
    // EVERY row this section wrote is put back, and the throwaway project with
    // it. Later sections count papers and projects, and a stray membership or an
    // extra empty project would move a number they assert on — a section that
    // leaves the corpus different from how it found it makes the sections after
    // it lie about what they proved.
    db.prepare('UPDATE project_work SET is_reference = 0 WHERE project_id = ? AND work_id NOT IN ' +
      `(${[...refIds].map(() => '?').join(',') || '0'})`).run(ids.projectId, ...refIds)
    db.prepare('UPDATE project_work SET is_reference = 1 WHERE project_id = ? AND work_id IN ' +
      `(${[...refIds].map(() => '?').join(',') || '0'})`).run(ids.projectId, ...refIds)
    if (bareProject !== null) {
      db.prepare('DELETE FROM project_work WHERE project_id = ?').run(bareProject)
      db.prepare('DELETE FROM project WHERE id = ?').run(bareProject)
    }
    // And the per-client state, so the sections after this one see the server as
    // they would on a fresh start rather than mid-conversation.
    D.projectContext.clearDossierSessions()
  }
  // Handed to the staging unit below, which needs a paper that genuinely HAS
  // background: `ids.workId` is one of the reference papers, whose own claims are
  // excluded from its slice, so it has none and every unit assertion would be
  // comparing null to null.
  return workA
}

/**
 * The staging contract, at the seam the wire cannot reach.
 *
 * Over HTTP a payload is committed only after `handleRequest` resolves, and the
 * two ways that can fail to happen — the tool threw, or the response was cut by
 * the 4 MiB budget — are both marked by a `poisoned` flag that no successful
 * request ever sets. Forcing either over the wire would mean manufacturing a
 * 4 MiB dossier or an error inside a `shape`, so the flag's OWN contract is
 * asserted directly: staged-then-poisoned must leave nothing behind, so the very
 * next read still receives the material.
 *
 * WHAT THIS THEREFORE DOES NOT COVER, stated rather than implied: the two lines
 * in `mcp/server.ts` that SET the flag — on a thrown handler, and on a response
 * the budget truncated. Deleting either leaves every assertion here green. An
 * over-the-wire version was written and withdrawn: inflating a paper's evidence
 * quotes past 4 MiB reproduces the same stall `runBudget`'s own probe already
 * hits on this transport, so it tested the transport rather than this feature. A
 * shipped test that hangs is worse than a documented gap.
 */
function runProjectContextStagingUnit(ids: Ids, workId: number): void {
  section('project background: staged marks are only committed on delivery')
  const db = D.db.getDb()
  const P = D.projectContext

  P.clearDossierSessions()
  eq('staging: cleared state tracks no sessions', P.dossierSessionCount(), 0)

  const payload = P.dossierPayload(db, ids.projectId, workId)
  ok('staging: the probe paper has background to stage (otherwise this proves nothing)', payload !== null)
  if (!payload) return

  const ctxFor = (state: ReturnType<typeof P.newRequestState>): never =>
    ({ db, source: 'mcp', sender: null, dossier: state }) as never
  // `length > 0`, not merely "is an array": an empty entries array is not the
  // material, and a mutation emitting one would pass an `Array.isArray` check.
  const entriesIn = (v: unknown): boolean => {
    const e = (v as { entries?: unknown })?.entries
    return Array.isArray(e) && e.length > 0
  }
  const markerIn = (v: unknown): unknown => (v as { already_sent?: unknown })?.already_sent

  // A delivered response: staged, committed, and the next read is suppressed.
  const good = P.newRequestState('unit-a', 'fp-a')
  ok('staging: the first read of a session yields the entries',
    entriesIn(P.projectContextFor(ctxFor(good), ids.projectId, workId)))
  P.commitRequest(good)
  eq('staging: once committed, the next read is suppressed',
    markerIn(P.projectContextFor(ctxFor(P.newRequestState('unit-a', 'fp-a')), ids.projectId, workId)), true)

  // A response that was NOT delivered: poisoned, so nothing is remembered.
  P.clearDossierSessions()
  const poisoned = P.newRequestState('unit-b', 'fp-b')
  P.projectContextFor(ctxFor(poisoned), ids.projectId, workId)
  poisoned.poisoned = true
  P.commitRequest(poisoned)
  const afterPoison = P.projectContextFor(ctxFor(P.newRequestState('unit-b', 'fp-b')), ids.projectId, workId)
  ok(
    'INVARIANT: a response that was truncated or errored is NOT remembered \u2014 the next read gets everything',
    entriesIn(afterPoison) && markerIn(afterPoison) === undefined,
    afterPoison
  )

  // A build that was never committed at all (the connection went away).
  P.clearDossierSessions()
  const abandoned = P.newRequestState('unit-c', 'fp-c')
  P.projectContextFor(ctxFor(abandoned), ids.projectId, workId)
  const afterAbandon = P.projectContextFor(ctxFor(P.newRequestState('unit-c', 'fp-c')), ids.projectId, workId)
  ok(
    'INVARIANT: building a payload is not delivering it \u2014 an uncommitted request leaves no mark',
    markerIn(afterAbandon) === undefined,
    afterAbandon
  )

  // An unidentifiable client can never be suppressed, however often it calls.
  P.clearDossierSessions()
  for (const attempt of [1, 2, 3]) {
    const anon = P.newRequestState(null, 'fp-d')
    const got = P.projectContextFor(ctxFor(anon), ids.projectId, workId)
    P.commitRequest(anon)
    ok(
      `INVARIANT: a client with no identifiable connection is sent everything (attempt ${attempt})`,
      entriesIn(got),
      got
    )
  }
  eq('staging: an unidentifiable client is never recorded either', P.dossierSessionCount(), 0)

  // A token that changed is a client we have never met, whatever the connection.
  P.clearDossierSessions()
  const before = P.newRequestState('unit-e', 'fp-old')
  P.projectContextFor(ctxFor(before), ids.projectId, workId)
  P.commitRequest(before)
  const rotated = P.projectContextFor(ctxFor(P.newRequestState('unit-e', 'fp-new')), ids.projectId, workId)
  ok(
    'INVARIANT: a regenerated token means a client we have never met \u2014 send everything',
    markerIn(rotated) === undefined,
    rotated
  )

  // Bounded: many clients must not grow the map without limit.
  P.clearDossierSessions()
  for (let i = 0; i < 200; i++) {
    const s = P.newRequestState(`bulk-${i}`, 'fp-bulk')
    P.projectContextFor(ctxFor(s), ids.projectId, workId)
    P.commitRequest(s)
  }
  // EXACTLY the cap, not "at most": `<=` also passes at zero, which is what a
  // `commitRequest` that recorded nothing at all would produce.
  eq('staging: 200 distinct clients settle at exactly the 32-session cap', P.dossierSessionCount(), 32)
  P.clearDossierSessions()
  eq('staging: clearing (as the server stop path does) leaves nothing behind', P.dossierSessionCount(), 0)
}

// ------------------------------------------------------------------ 7 clamp/shape

async function runClampAndShape(ids: Ids): Promise<void> {
  section('clampArgs and shape (MCP-only code paths)')
  level = 'delete'
  const db = D.db.getDb()

  // THE CORPUS IS ENLARGED SO THE CAPS CAN BITE.
  //
  // On the seed alone every clamp assertion is vacuous: 20 papers come back
  // whether the limit is clamped to 200 or honoured at 5000, so a `clampArgs`
  // that had been deleted outright would pass. A cap is only observable when
  // there is more data than the cap.
  const pad = db.prepare(
    'INSERT INTO work (title, abstract, work_type, created_at, updated_at) ' +
      "VALUES (?, 'clamp probe abstract', 'journal-article', datetime('now'), datetime('now'))"
  )
  const link = db.prepare(
    'INSERT OR IGNORE INTO project_work (project_id, work_id, relevance, expansion_priority, ' +
      "inclusion_status, created_at, updated_at) VALUES (?, ?, 0.5, 0.5, 'unread', datetime('now'), datetime('now'))"
  )
  db.transaction(() => {
    for (let i = 0; i < 400; i++) {
      const id = pad.run(`clamp probe paper ${i}`).lastInsertRowid as number
      link.run(ids.projectId, id)
    }
  })()

  // `limit` is clamped BEFORE the query runs. Asking for far more than the cap
  // must return AT MOST the cap — and, with 400+ papers present, EXACTLY the
  // cap, which is what distinguishes a working clamp from a small corpus.
  const big = await expectList('clamp: papers_search asks for 300, the channel maximum', 'papers_search', {
    query: '',
    limit: SEARCH_LIMIT_MAX
  })
  if (big) {
    eq(
      `clamp: exactly ${D.clamp.CLAMP.limit} rows came back, not the ${SEARCH_LIMIT_MAX} asked for`,
      big.items.length,
      D.clamp.CLAMP.limit
    )
    eq(
      'clamp: the envelope reports the CLAMPED limit, so the agent is not told it reached the end',
      big.limit,
      D.clamp.CLAMP.limit
    )
    ok(
      'clamp: the true total still exceeds the clamped page (the cap trims the PAYLOAD, not the count)',
      big.total > big.items.length,
      { total: big.total, returned: big.items.length }
    )
  }

  // Omitting `limit` must also land on the cap rather than on "unbounded".
  const omitted = await expectList('clamp: papers_search with no limit at all', 'papers_search', {
    query: ''
  })
  if (omitted) {
    eq(
      `clamp: an omitted limit defaults to the cap (${D.clamp.CLAMP.limit}), never to unbounded`,
      omitted.items.length,
      D.clamp.CLAMP.limit
    )
  }

  // The schema floor is `min(1)`, so a zero or negative limit is a SCHEMA
  // rejection — an isError result the agent can read — and never a value that
  // reaches SQL.
  for (const bad of [0, -5]) {
    const r = await callTool('papers_search', { query: '', limit: bad })
    ok(
      `clamp: limit ${bad} is refused as a readable error, never passed through to SQL`,
      r.isError && r.protocolError === null,
      r.text.slice(0, 160)
    )
  }

  // Semantic `k` is clamped to CLAMP.k; each neighbour is an ONNX forward pass.
  // The count of hits is the observable, so it is asserted rather than the
  // absence of an error.
  const bigK = await callTool('papers_search_by_meaning', { query: 'kinetics', k: 200 })
  ok('clamp: an over-cap semantic k is accepted and clamped, not refused', !bigK.isError, bigK.text.slice(0, 160))
  const hits = (bigK.value as { hits?: unknown[] } | null)?.hits
  if (Array.isArray(hits)) {
    ok(
      `clamp: semantic search returned at most k=${D.clamp.CLAMP.k} passages`,
      hits.length <= D.clamp.CLAMP.k,
      hits.length
    )
  }

  // Graph nodes.
  const graph = await callTool('graph_get', { projectId: ids.projectId, opts: { limit: 5000 } })
  ok('clamp: graph_get with limit 5000 succeeds', !graph.isError && graph.protocolError === null, graph.text.slice(0, 160))
  const g = graph.value as { nodes?: unknown[] } | null
  ok('clamp: graph_get returned nodes to count', Array.isArray(g?.nodes), Object.keys(g ?? {}))
  if (Array.isArray(g?.nodes)) {
    eq(
      `clamp: graph nodes capped at ${D.clamp.CLAMP.graphNodes} despite 400+ papers in the project`,
      g.nodes.length,
      D.clamp.CLAMP.graphNodes
    )
  }

  // Unresolved references per paper in a reference tree.
  const tree = await callTool('reference_tree_get', {
    projectId: ids.projectId,
    opts: { limit: 20000, unresolvedPerWork: 500 }
  })
  ok('clamp: reference_tree_get with an over-cap request succeeds', !tree.isError, tree.text.slice(0, 160))
  const treeNodes = (tree.value as { nodes?: Array<Record<string, unknown>> } | null)?.nodes
  if (Array.isArray(treeNodes)) {
    ok(
      `clamp: no paper in the tree carries more than ${D.clamp.CLAMP.unresolvedPerWork} unresolved references`,
      treeNodes.every((n) => {
        const u = n.unresolved
        return !Array.isArray(u) || u.length <= D.clamp.CLAMP.unresolvedPerWork
      }),
      treeNodes.length
    )
    ok(
      `clamp: the tree's own node budget held at ${D.clamp.CLAMP.graphNodes}`,
      treeNodes.length <= D.clamp.CLAMP.graphNodes,
      treeNodes.length
    )
  }

  // Pagination is REAL: page 2 must not repeat page 1, and `total` must be the
  // corpus count on both.
  const p1 = await expectList('shape: page 1', 'papers_search', { query: '', limit: 2, offset: 0 })
  const p2 = await expectList('shape: page 2', 'papers_search', { query: '', limit: 2, offset: 2 })
  if (p1 && p2) {
    eq('shape: total is identical across pages (it is a COUNT(*), not the page size)', p1.total, p2.total)
    ok(
      'shape: total is the CORPUS count, far above one page — not the page size wearing its name',
      p1.total > p1.items.length && p1.total > 400,
      { total: p1.total, page: p1.items.length }
    )
    eq('shape: page 1 honoured the requested page size', p1.items.length, 2)
    const idsOf = (l: typeof p1): unknown[] =>
      l.items.map((i) => (i as Record<string, unknown>).work_id)
    const overlap = idsOf(p1).filter((i) => idsOf(p2).includes(i))
    eq('shape: page 2 does not repeat page 1', overlap.length, 0)
    eq('shape: the envelope echoes the offset it served', p2.offset, 2)
  }
  const past = await expectList('shape: offset past the end', 'ranking_get', {
    projectId: ids.projectId,
    limit: 5,
    offset: 100_000
  })
  if (past) {
    eq('shape: an offset past the end returns no items', past.items.length, 0)
    ok('shape: total is still honest past the end', past.total > 0, past.total)
    ok(
      'shape: an empty page past the end SAYS it is past the end rather than implying emptiness',
      typeof past.scope_note === 'string' && /past the last/i.test(past.scope_note),
      past.scope_note
    )
  }

  db.prepare("DELETE FROM work WHERE title LIKE 'clamp probe paper %'").run()

  // THE REGRESSION THIS WHOLE SUITE EXISTS FOR.
  //
  // A `workId` filter applied AFTER `LIMIT` made a paper past row 200 report a
  // confident, wrong "no values". The symptom was an EMPTY result — so an
  // assertion that only checks "every row returned is the right paper" is
  // vacuously true on exactly the failure, and would have passed throughout the
  // bug's life. It has to prove three things instead: a paper whose rows sit
  // past the clamp is found at all, the rows come back, and the scoped total is
  // genuinely narrower than the unscoped one.
  const unscoped = await expectList('shape: extraction rows, whole project', 'extraction_rows_get', {
    projectId: ids.projectId,
    limit: D.clamp.CLAMP.limit
  })
  const deepWorkId = findWorkPastRow(unscoped, D.clamp.CLAMP.limit)
  ok(
    'shape: the seeded corpus has extracted rows past the clamp, so this test can bite',
    deepWorkId !== null,
    { total: unscoped?.total, limit: D.clamp.CLAMP.limit }
  )
  if (deepWorkId !== null && unscoped) {
    const scoped = await expectList(
      `shape: extraction rows scoped to paper ${deepWorkId}, whose rows sit past row ${D.clamp.CLAMP.limit}`,
      'extraction_rows_get',
      { projectId: ids.projectId, workId: deepWorkId, limit: D.clamp.CLAMP.limit }
    )
    if (scoped) {
      ok(
        'shape: a paper past the first page STILL RETURNS ITS ROWS (the filter is applied in SQL, not after LIMIT)',
        scoped.items.length > 0,
        { workId: deepWorkId, note: scoped.scope_note }
      )
      ok(
        'shape: every row of the scoped result really is that paper',
        scoped.items.length > 0 &&
          scoped.items.every((r) => (r as Record<string, unknown>).work_id === deepWorkId),
        scoped.items.slice(0, 3)
      )
      ok(
        'shape: the scoped total counts THAT PAPER only — strictly fewer than the whole project',
        scoped.total > 0 && scoped.total < unscoped.total,
        { scoped: scoped.total, project: unscoped.total }
      )
    }
  }
}

/**
 * A work whose extracted rows begin AFTER the first page.
 *
 * Read from the unscoped list rather than assumed, because which paper that is
 * depends on the seed — and a test that hard-coded an id would quietly stop
 * testing the thing the moment the fixture changed.
 */
function findWorkPastRow(list: ReturnType<typeof asList>, limit: number): number | null {
  const items = list?.items ?? []
  if (items.length < limit) return null
  const seenEarly = new Set<number>()
  for (let i = 0; i < items.length; i++) {
    const wid = (items[i] as Record<string, unknown>).work_id
    if (typeof wid !== 'number') continue
    if (i < limit / 2) seenEarly.add(wid)
    else if (!seenEarly.has(wid)) return wid
  }
  return null
}

// ------------------------------------------------------------------ 7b budget

/**
 * Push a real tool over the 4 MiB budget.
 *
 * The seed is deliberately small, so the corpus is enlarged HERE — in the
 * throwaway DB — with rows big enough that one page genuinely overflows. Testing
 * the serializer in isolation would not prove that the budget is wired into the
 * response path at all, which is the thing that has never run.
 */
async function runBudget(ids: Ids): Promise<void> {
  section('response budget (live, over the wire)')
  const db = D.db.getDb()

  // `unresolved_reference.raw_bib_text` is UNCAPPED — the raw bibliography line
  // is preserved verbatim by HARD RULE 3 — and `paper_unresolved_refs_get`
  // returns it in a list envelope. So it is the tool that can genuinely overflow
  // the budget on real data, unlike `papers_search`, whose snippet is cut to 200
  // characters in SQL and therefore never could. Testing the budget on a tool
  // that cannot reach it would have been a green line proving nothing.
  const filler = `A very long bibliography line ${'x'.repeat(120_000)}`
  const insert = db.prepare(
    "INSERT INTO unresolved_reference (citing_work_id, raw_bib_text, status, created_at) " +
      "VALUES (?, ?, 'unresolved', datetime('now'))"
  )
  const many = db.transaction(() => {
    for (let i = 0; i < 60; i++) insert.run(ids.workId, `${i} ${filler}`)
  })
  many()

  // eslint-disable-next-line no-console
  console.log(`  (budget probe: ${(db.prepare('SELECT COUNT(*) n FROM unresolved_reference WHERE citing_work_id = ?').get(ids.workId) as {n:number}).n} rows on work ${ids.workId}; calling…)`)
  const began = Date.now()
  const r = await callTool('paper_unresolved_refs_get', { workId: ids.workId })
  // eslint-disable-next-line no-console
  console.log(`  (budget probe returned in ${Date.now() - began}ms, ${r.text.length} bytes)`)
  ok('budget: no protocol error at the boundary', r.protocolError === null, r.protocolError)
  ok('budget: not isError', !r.isError, r.text.slice(0, 200))
  ok('budget: the body is still VALID JSON at the boundary', r.parsedOk, r.text.slice(0, 200))
  ok(
    `budget: the response is within ${D.result.RESPONSE_BUDGET_BYTES} bytes`,
    r.text.length <= D.result.RESPONSE_BUDGET_BYTES,
    r.text.length
  )
  const v = r.value as Record<string, unknown> | null
  ok(
    'budget: the probe really did overflow the budget (otherwise this section proves nothing)',
    (v?.total as number) * 120_000 > D.result.RESPONSE_BUDGET_BYTES,
    { total: v?.total, bytes: r.text.length }
  )
  ok('budget: an overflowing list is FLAGGED truncated, not silently short', v?.truncated === true, {
    bytes: r.text.length,
    keys: Object.keys(v ?? {})
  })
  ok(
    'budget: a truncated list still reports the TRUE total, so the agent knows what it did not see',
    typeof v?.total === 'number' && (v.total as number) >= 60,
    v?.total
  )
  ok(
    'budget: a truncated list says how many rows it actually returned',
    typeof v?.returned === 'number' && (v.returned as number) === (v?.items as unknown[])?.length,
    { returned: v?.returned, items: (v?.items as unknown[])?.length }
  )
  ok('budget: a truncated list tells the agent how to narrow', typeof v?.hint === 'string', v?.hint)
  ok(
    'budget: the rows it DID return are whole — cut at a row boundary, never mid-string',
    (v?.items as Array<Record<string, unknown>> | undefined)?.every(
      (row) => typeof row.raw_bib_text === 'string' && (row.raw_bib_text as string).length > 120_000
    ) ?? false,
    (v?.items as unknown[])?.length
  )

  db.prepare('DELETE FROM unresolved_reference WHERE citing_work_id = ? AND length(raw_bib_text) > 1000').run(
    ids.workId
  )
}

function runBudgetUnit(): void {
  section('response budget (serializer boundaries)')
  const small = D.result.serializeWithinBudget({ a: 1 })
  ok('budget unit: an in-budget value is untouched', small.truncated === false && small.json === '{"a":1}')

  const rows = Array.from({ length: 400 }, (_, i) => ({ i, blob: 'y'.repeat(20_000) }))
  const list = D.result.serializeWithinBudget({ items: rows, total: 400, limit: 400, offset: 0, scope_note: null })
  ok('budget unit: an oversized LIST is truncated', list.truncated)
  ok('budget unit: the truncated list is valid JSON', parses(list.json))
  ok(`budget unit: it fits the budget`, list.json.length <= D.result.RESPONSE_BUDGET_BYTES, list.json.length)
  const parsed = JSON.parse(list.json) as Record<string, unknown>
  ok('budget unit: rows are cut at a ROW boundary, never mid-string',
    Array.isArray(parsed.items) && (parsed.items as unknown[]).every((r) => typeof (r as Record<string, unknown>).blob === 'string' && ((r as Record<string, unknown>).blob as string).length === 20_000))
  eq('budget unit: the true total survives truncation', parsed.total, 400)
  ok('budget unit: truncated:true is set', parsed.truncated === true)

  const blob = D.result.serializeWithinBudget({ text: 'z'.repeat(D.result.RESPONSE_BUDGET_BYTES + 10) })
  ok('budget unit: an oversized NON-list is refused rather than returned broken', blob.truncated)
  ok('budget unit: the refusal is valid JSON', parses(blob.json))
  const b = JSON.parse(blob.json) as Record<string, unknown>
  ok('budget unit: the refusal explains itself', typeof b.error === 'string' && typeof b.hint === 'string', b)

  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  const cyc = D.result.serializeWithinBudget(cyclic)
  ok('budget unit: an unserializable value still yields valid JSON', parses(cyc.json), cyc.json)
}

/**
 * The path redactor: correct, and LINEAR.
 *
 * Both halves matter and only one of them is obvious. The redactor runs on every
 * string of every response, synchronously, on the thread that paints the window
 * — so a pattern that is quadratic in the subject's length is a denial of
 * service reachable with one ordinary read, and it shipped: an unbounded URL
 * scheme made 8 KiB cost 75 ms and a page of long bibliography lines never
 * return at all.
 */
function runRedactorUnit(): void {
  section('path redactor (correctness and cost)')
  const { redactPath, scrubPaths } = D.redact

  for (const [input, expected] of [
    // A DOI or a publisher link is the PAYLOAD, not a leak. Collapsing it is
    // silent corruption of the answer in the name of protecting it.
    ['see https://doi.org/10.1038/nature12345', 'see https://doi.org/10.1038/nature12345'],
    ['http://arxiv.org/abs/1234.5678', 'http://arxiv.org/abs/1234.5678'],
    // A unit string is not a path. Redacting `/mg/mL` turns a measurement into
    // nonsense, which is worse than the leak it would prevent.
    ['kcat 5 /mg/mL and 3 /min/mg', 'kcat 5 /mg/mL and 3 /min/mg'],
    ['sections 2026/07/28 and s/foo/bar/g', 'sections 2026/07/28 and s/foo/bar/g'],
    // Real paths of every root this app writes to, including the NAS case.
    ['open /home/someone/x.pdf failed', 'open a folder failed'],
    ['open /media/someone/Disk/papers/x.pdf', 'open a folder'],
    ['open /mnt/nas/lib/x.pdf', 'open a folder'],
    // A file:// URL is a path in a URL's costume.
    ['at file:///home/someone/x.pdf', 'at a folder'],
    ['C:\\Users\\someone\\x.pdf', 'a folder'],
    ['~/Documents/corpus/x.pdf', 'a folder']
  ] as Array<[string, string]>) {
    eq(`redactor: ${JSON.stringify(input).slice(0, 46)}`, redactPath(input), expected)
  }

  // A path on the SECOND line of a stack trace sits after a literal `\n`, and an
  // anchored pattern stopped matching there — every continuation line went out
  // intact.
  ok(
    'redactor: a path after a newline is still collapsed',
    !scrubPaths('Error: nope\n    at /home/someone/app/x.js:1:1').includes('/home/'),
    scrubPaths('Error: nope\n    at /home/someone/app/x.js:1:1')
  )

  // COST. Measured as a ratio rather than an absolute, so it is a statement
  // about complexity and not about this machine's speed on this afternoon.
  const time = (n: number): number => {
    const subject = `A long bibliography line ${'x'.repeat(n)}`
    const began = process.hrtime.bigint()
    for (let i = 0; i < 20; i++) redactPath(subject)
    return Number(process.hrtime.bigint() - began) / 1e6
  }
  const small = Math.max(time(2_000), 0.5)
  const large = time(16_000)
  ok(
    `redactor: cost grows about LINEARLY with length (8x the input cost ${(large / small).toFixed(1)}x, not ~64x)`,
    large / small < 16,
    { ms2k: small.toFixed(2), ms16k: large.toFixed(2) }
  )
}

function parses(s: string): boolean {
  try {
    JSON.parse(s)
    return true
  } catch {
    return false
  }
}

// ------------------------------------------------------------------ 9 concurrency

async function runConcurrency(): Promise<void> {
  section('concurrency (live)')
  level = 'delete'
  const n = 24
  const started = Date.now()
  const results = await Promise.all(
    Array.from({ length: n }, (_, i) => callTool('projects_list', {}).then((r) => ({ i, r })))
  )
  ok(
    `concurrency: all ${n} parallel calls were answered (queued, not refused)`,
    results.every(({ r }) => r.protocolError === null && !r.isError),
    results.filter(({ r }) => r.protocolError || r.isError).slice(0, 3)
  )
  ok(
    'concurrency: every parallel response is valid JSON',
    results.every(({ r }) => r.parsedOk)
  )
  ok(
    'concurrency: every parallel response carries the same true total (no interleaving corruption)',
    new Set(results.map(({ r }) => asList(r.value)?.total)).size === 1,
    results.map(({ r }) => asList(r.value)?.total).slice(0, 5)
  )
  eq('concurrency: the admission counter returned to zero afterwards', D.queue.mcpInFlightTotal(), 0)
  eq('concurrency: nothing is left waiting in the queue', D.queue.mcpQueueDepth(), 0)
  // eslint-disable-next-line no-console
  console.log(`  (${n} parallel calls in ${Date.now() - started}ms)`)
}

/**
 * The admission queue's own invariants.
 *
 * Driven in-process because the properties that matter — "never more than three
 * at once", "never more than one slow one", "the 33rd waiter is refused" — are
 * not observable from outside a socket that answers correctly either way.
 */
async function runQueueUnit(): Promise<void> {
  section('admission queue (invariants)')
  let concurrent = 0
  let peak = 0
  let peakSlow = 0
  let slowConcurrent = 0
  const gates: Array<() => void> = []

  // How many of the twelve bodies ever STARTED. The cap is a statement about
  // this number, and the two peaks below are only meaningful beside it: a queue
  // that admitted nobody at all would report peak 0 and satisfy `peak <= 3`.
  let entered = 0
  let enteredSlow = 0

  const make = (slow: boolean): Promise<unknown> =>
    D.queue.admit({ slow, mutating: false }, async () => {
      concurrent++
      entered++
      if (slow) {
        slowConcurrent++
        enteredSlow++
      }
      peak = Math.max(peak, concurrent)
      peakSlow = Math.max(peakSlow, slowConcurrent)
      await new Promise<void>((resolve) => gates.push(resolve))
      concurrent--
      if (slow) slowConcurrent--
      return null
    })

  // THE SLOW CALLS GO FIRST, and the order is the whole point. Admission is
  // greedy and first-come: eight fast calls submitted ahead of the slow ones
  // take all three slots, no slow call ever starts, and `peakSlow` is 0 — which
  // satisfies "at most 1" without the sub-limit having been consulted once. Four
  // slow calls at the head of the queue force it to be the thing that binds.
  const inFlight = [
    ...Array.from({ length: 4 }, () => make(true)),
    ...Array.from({ length: 8 }, () => make(false))
  ]

  // AWAITED before any peak is read. `admit` is async: a caller it can serve
  // immediately still resumes a microtask later, so every body was still
  // unentered at the end of the synchronous loop above. Sampling there read
  // peak 0 and peakSlow 0 — which satisfy `<= 3` and `<= 1` for a queue with no
  // cap at all, and would have passed for one that admitted nothing whatsoever.
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()

  // The peaks only bound something once work has actually started, so the
  // saturation is asserted FIRST and the caps are read against it.
  eq('queue: the cap is saturated — exactly 3 of the 12 calls are running', concurrent, 3)
  eq('queue: exactly 1 of them is a slow call, though 4 were offered first', slowConcurrent, 1)
  eq('queue: the other two slots went to fast calls, not to the waiting slow ones', concurrent - slowConcurrent, 2)
  // Everything above the cap must be WAITING, not running.
  ok(`queue: at most 3 calls run at once (peak ${peak})`, peak === 3, peak)
  ok(`queue: at most 1 slow call runs at once (peak ${peakSlow})`, peakSlow === 1, peakSlow)
  eq('queue: exactly 3 bodies were entered, and the other 9 were held', entered, 3)
  eq('queue: exactly 1 slow body was entered, and the other 3 were held', enteredSlow, 1)
  // The reads got in AROUND the blocked slow calls rather than queueing behind
  // them — the reservation exists so an agent can still look at anything while
  // one extraction runs, and a strict FIFO would have starved them.
  eq('queue: the fast calls were let past the 3 slow ones still waiting', entered - enteredSlow, 2)
  eq('queue: the rest are queued, not dropped', D.queue.mcpQueueDepth(), 9)
  eq('queue: the in-flight counter agrees with the bodies that ran', D.queue.mcpInFlightTotal(), 3)
  eq('queue: a gate exists per running body (nothing entered and returned early)', gates.length, 3)

  // Depth: past 32 waiters, a call is REFUSED with a retry hint rather than pooled.
  const overflow: Array<Promise<unknown>> = []
  const refusals: unknown[] = []
  for (let i = 0; i < 40; i++) {
    overflow.push(
      D.queue
        .admit({ slow: false, mutating: false }, async () => {
          await new Promise<void>((resolve) => gates.push(resolve))
          return null
        })
        .catch((err) => {
          refusals.push(err)
          return null
        })
    )
  }
  // AWAITED. `admit` is async, so its throw becomes a REJECTED PROMISE and the
  // `catch` runs a microtask later — asserting straight after the loop read an
  // empty array and would have passed for a queue with no depth limit at all.
  await Promise.resolve()
  await Promise.resolve()
  const refused = refusals[0]
  ok('queue: a caller past the depth limit is refused', refused instanceof D.queue.McpBusyError, refused)
  ok(
    'queue: the refusal names a retry delay the agent can act on',
    (refused as InstanceType<typeof D.queue.McpBusyError>)?.retryAfterMs > 0,
    (refused as InstanceType<typeof D.queue.McpBusyError>)?.retryAfterMs
  )
  // EXACT, not "some were refused". 9 of the twelve above are already waiting,
  // so the queue has room for 23 more before it reaches its depth of 32 and the
  // remaining 17 are turned away. A range check passes for a queue that refuses
  // the very first caller and for one whose limit is off by twenty.
  eq('queue: the queue filled to its documented depth of 32', D.queue.mcpQueueDepth(), 32)
  eq(
    'queue: only the callers PAST the limit are refused — 23 admitted to the queue, 17 turned away',
    refusals.length,
    17
  )
  ok(
    'queue: every refusal is an McpBusyError carrying a retry delay, not a generic throw',
    refusals.every(
      (r) =>
        r instanceof D.queue.McpBusyError &&
        (r as InstanceType<typeof D.queue.McpBusyError>).retryAfterMs > 0
    ),
    refusals.filter((r) => !(r instanceof D.queue.McpBusyError)).slice(0, 2)
  )
  // Refusal must not have disturbed what was already running: a depth limit that
  // dropped or displaced an in-flight call would be a data-loss bug, not a cap.
  eq('queue: refusing the overflow did not disturb the 3 running calls', concurrent, 3)

  // Let everything go and confirm the counters come back to zero.
  // AWAITED, not fired and forgotten: a `void promise.then(assert)` records its
  // result after the summary has already been printed, so the assertion could
  // never fail the run.
  while (gates.length || D.queue.mcpInFlightTotal() > 0) {
    const g = gates.shift()
    if (g) g()
    await new Promise((r) => setTimeout(r, 0))
  }
  await Promise.all([...inFlight, ...overflow])
  eq('queue: every slot is released once the work settles', D.queue.mcpInFlightTotal(), 0)
  eq('queue: no waiter is left stranded', D.queue.mcpQueueDepth(), 0)
}

// ------------------------------------------------------------------ 10 error shapes

async function runErrorShapes(): Promise<void> {
  section('error shapes')
  level = 'delete'

  // "You asked wrong" is an isError RESULT the agent can read and act on.
  const badParams = await callTool('project_get', { projectId: 'not-a-number' })
  ok('errors: a bad argument type is an isError RESULT, not a protocol error', badParams.isError, badParams)
  ok('errors: it carries a readable message', badParams.text.length > 0, badParams.text)
  ok('errors: the message is not a raw stack trace', !/\n\s+at /.test(badParams.text), badParams.text.slice(0, 200))

  const missingRequired = await callTool('project_get', {})
  ok('errors: a missing required argument is an isError result', missingRequired.isError, missingRequired)

  const nonexistentWork = await callTool('paper_get', { workId: 999_999_999 })
  ok(
    'errors: a nonexistent workId answers (null or isError), it does not crash the transport',
    nonexistentWork.protocolError === null,
    nonexistentWork.protocolError
  )

  const unknownTool = await callTool('there_is_no_such_tool', {})
  eq('errors: an unknown tool is a PROTOCOL error (MethodNotFound)', unknownTool.protocolError?.code, -32601)
  ok(
    'errors: the unknown-tool message says the tool does not exist, not that permission is missing',
    /no tool called/i.test(unknownTool.protocolError?.message ?? ''),
    unknownTool.protocolError?.message
  )

  // Transport-level malformations never reach the protocol server.
  const malformed = await raw('{ this is not json')
  eq('errors: a malformed JSON body → 400', malformed.status, 400)
  const empty = await raw('')
  eq('errors: an empty body → 400', empty.status, 400)
  // Sent on a raw socket: the server answers 413 and then DESTROYS the
  // connection (documented, so an oversized body is never drained), and undici
  // surfaces that reset as a transport failure instead of the status — so a
  // `fetch` here throws rather than reporting the 413 that proves the cap works.
  await pace()
  const oversized = await rawSocket(
    [
      'POST /mcp HTTP/1.1',
      `Host: 127.0.0.1:${port}`,
      `Authorization: Bearer ${token}`,
      'Content-Type: application/json',
      'Connection: close'
    ],
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { pad: 'p'.repeat(2 * 1024 * 1024) }
    }),
    { chunkBytes: 64 * 1024 }
  )
  eq('errors: a body over 1 MiB → 413', oversized.status, 413)

  // Once a quit is under way, writes are refused with a message that says
  // nothing was written; reads keep working.
  quitting = true
  const writeDuringQuit = await callTool('search_record', { projectId: 1, name: 'q', query: 'q' })
  ok('errors: a write during shutdown is refused as an isError result', writeDuringQuit.isError, writeDuringQuit)
  ok(
    'errors: the shutdown refusal states that nothing was written',
    /nothing was written/i.test(writeDuringQuit.text),
    writeDuringQuit.text
  )
  const readDuringQuit = await callTool('projects_list', {})
  ok('errors: reads keep working during shutdown', !readDuringQuit.isError, readDuringQuit.text)
  quitting = false
}

// ------------------------------------------------------------------ 8 leaks

function runLeakSweep(): void {
  section('leak sweep over every response body received')
  const user = userInfo().username
  const home = homedir()
  const probes: Array<[string, string]> = [
    ['the bearer token', token],
    ['the OS username', user],
    ['the home directory', home],
    ['the temp root of this run', TMP],
    ['the database path', process.env.CORPUS_DB_PATH as string],
    ['the userData directory', process.env.XDG_CONFIG_HOME as string]
  ]
  ok('leak sweep: there are response bodies to check', seenBodies.length > 20, seenBodies.length)

  for (const [label, value] of probes) {
    if (!value || value.length < 3) continue
    const hits = seenBodies.filter((b) => b.body.includes(value))
    ok(
      `leak sweep: no response contains ${label}`,
      hits.length === 0,
      hits.slice(0, 3).map((h) => `${h.label}: …${h.body.slice(Math.max(0, h.body.indexOf(value) - 60), h.body.indexOf(value) + 60)}…`)
    )
  }

  // Anything still shaped like an absolute path, beyond the named prefixes.
  const pathish = /(?:^|[^\w:/])\/(?:home|Users|media|mnt|Volumes|var|tmp|opt|srv|etc|usr|root|private)\//
  const leaked = seenBodies.filter((b) => pathish.test(b.body))
  ok(
    'leak sweep: no response carries an absolute filesystem path of any root',
    leaked.length === 0,
    leaked.slice(0, 3).map((h) => `${h.label}: ${(pathish.exec(h.body) ?? [''])[0]}`)
  )

  // A gateway key would be the other capability on this machine.
  const keyish = /"(?:api_key|apiKey|gateway_key|token|secret)"\s*:\s*"[^"]{8,}"/i
  const keys = seenBodies.filter((b) => keyish.test(b.body))
  ok(
    'leak sweep: no response carries a credential-shaped field',
    keys.length === 0,
    keys.slice(0, 3).map((h) => `${h.label}: ${(keyish.exec(h.body) ?? [''])[0]}`)
  )
}

function runAuditCheck(): void {
  section('audit log')
  const dir = D.audit.auditDir()
  ok('audit: the log directory was created', existsSync(dir), dir)
  if (!existsSync(dir)) return
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
  ok('audit: one JSONL file for the day exists', files.length === 1, files)
  if (files.length === 0) return
  const lines = readFileSync(join(dir, files[0]), 'utf8').trim().split('\n').filter(Boolean)
  ok('audit: calls were recorded', lines.length > 20, lines.length)
  let parsedAll = true
  const outcomes = new Set<string>()
  const tools = new Set<string>()
  let argsOnRead = 0
  for (const line of lines) {
    try {
      const o = JSON.parse(line) as Record<string, unknown>
      outcomes.add(String(o.outcome))
      tools.add(String(o.tool))
      if (o.access === 'read' && o.args !== undefined) argsOnRead++
    } catch {
      parsedAll = false
    }
  }
  ok('audit: every line is valid JSON', parsedAll)
  ok('audit: refusals are recorded, not only successes', outcomes.has('refused'), [...outcomes])
  ok('audit: successful calls are recorded', outcomes.has('ok'), [...outcomes])
  ok('audit: the tools that were called are named', tools.size > 10, tools.size)
  eq("audit: a read's arguments are never logged (they are the user's search terms)", argsOnRead, 0)
  const body = readFileSync(join(dir, files[0]), 'utf8')
  ok('audit: the token never appears in the log', !body.includes(token))
  ok('audit: no presented token bytes appear in the log', !body.includes('throttle-me-throttle-me'))
}

// ------------------------------------------------------------------ run

async function run(): Promise<void> {
  try {
    await load()
    await main()
  } catch (err) {
    failures++
    // eslint-disable-next-line no-console
    console.error('[verify:mcp] harness threw:', err)
  } finally {
    try {
      rmSync(TMP, { recursive: true, force: true })
    } catch {
      /* a temp directory that will not go is not a test failure */
    }
  }

  // eslint-disable-next-line no-console
  console.log(`\n[verify:mcp] ${checks - failures}/${checks} checks passed`)
  if (failures > 0) {
    // eslint-disable-next-line no-console
    console.error(`[verify:mcp] ${failures} FAILED:\n  - ${failed.join('\n  - ')}`)
    process.exit(1)
  }
  // eslint-disable-next-line no-console
  console.log('[verify:mcp] clean')
  process.exit(0)
}

void run()
