import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { ENTRIES } from './registry'
import type { Entry } from './types'
import { repoRootOrNull } from '../resources'

/**
 * The invariants a reviewer cannot hold in their head, checked mechanically.
 *
 * EVERY rule here exists because something specific nearly shipped:
 * - `search:query(query, projectId, filters)` and
 *   `search:facets(projectId, query, filters)` sit lines apart with the same
 *   property names in a DIFFERENT order. A permuted `order` type-checks and
 *   silently swaps arguments. So `order` is checked against the preload's own
 *   parameter names.
 * - `ingest:run`'s `value` is an absolute path when `kind` is `'pdf'`. No
 *   property-NAME blocklist catches a field called `value`. So exposed
 *   free-form strings are ALLOWLISTED, with a justification each, and the
 *   allowlist fails closed.
 * - Two input memos named `outlets:runOutletAction` and
 *   `outlets:updateOutletSettings`. Neither channel exists. So every expected
 *   set here is re-derived from `src/preload/index.ts`, never copied from prose.
 *
 * Run with `npm run verify:registry`. It is a plain script, not a gate: it is
 * run when asked for, like the other `verify:*` scripts.
 */

export interface SweepFailure {
  rule: string
  detail: string
}

const PATH_PROPERTY_NAMES = new Set([
  'path',
  'abspath',
  'dir',
  'directory',
  'file',
  'filepath',
  'vaultpath',
  'datadir',
  'folder',
  'basedir',
  'relativepath'
])

/**
 * Exposed free-form string properties, each with the reason it is safe.
 *
 * An ALLOWLIST and not a blocklist: a blocklist fails open, which is how
 * `ingest:run`'s `value` was nearly shipped as an arbitrary-path argument.
 * Adding a line here is a deliberate act with a justification attached.
 */
const FREEFORM_STRING_ALLOWLIST: Record<string, string> = {
  'search:query.query': 'a search term; reaches FTS5 as a bound parameter, never a path',
  'search:count.query': 'as above',
  'search:facets.query': 'as above',
  'search:semantic.query': 'embedded into a vector; never touches the filesystem',
  'review:verdict.correctedValue': "the human's corrected measurement, stored as text",
  'review:verdict.note': "the human's own note on a verdict",
  'ranking:setInclusion.reason': 'free-text justification stored against the project_work row',
  'ranking:override.reason': 'as above',
  'search:web.query':
    'a search term sent to the external literature indexes as a query parameter; it reaches no local path',
  'paper:findText.needle':
    'the string to find inside one paper; matched against stored text in JS, never a path or SQL',
  'ingest:run.value':
    'an identifier or title to resolve; the TOOL cannot select the pdf/folder kinds, so over MCP this is never a path',
  'ingest:pdfBytes.bytesBase64':
    'the PDF itself, base64; bounded before decoding and checked for the %PDF magic before it is stored',
  'ingest:pdfBytes.fileName':
    'the stored filename, but only after basename() and a [A-Za-z0-9._-] whitelist inside the library root',
  'ingest:pdfBytes.title': "the paper's title, stored as text",
  'search:record.name': "the human's own label for a saved search, stored as text",
  'search:record.query': 'the saved search term, stored verbatim so it can be replayed; never a path',
  'search:record.filters':
    'the saved filter set, stored as an opaque JSON string the renderer round-trips',
  'search:query.filters.author': 'an author name, bound into the SQL as a parameter',
  'search:count.filters.author': 'as above',
  'search:facets.filters.author': 'as above',
  'paper:resolve.paperRef':
    'a DOI, arXiv id, PMID or title, matched against stored columns as a bound parameter',
  'search:web.filters.author':
    'an author name, sent to the external indexes as a query parameter alongside the query itself'
}

/**
 * The channels that may carry `access: 'destructive'`, each because it discards
 * something a human cannot get back by asking again.
 *
 * An exact set in BOTH directions: an entry claiming destructive that is not
 * here fails, and a channel here declaring a lesser access fails. That is the
 * point — the level decides what an agent can reach with the destructive
 * checkbox OFF, so neither an author quietly widening a tool nor one quietly
 * narrowing a dangerous one should pass silently.
 */
const DESTRUCTIVE_CHANNELS = new Set([
  'work:delete',
  'schemas:delete',
  'schemas:deleteField',
  'outlets:run',
  // The re-run family. Their own summaries say it: the superseded runs' extracted
  // paragraphs, citation contexts and embeddings are DELETED, not archived, and
  // the effect cascades across every project that consumed the same output.
  // "Re-run" reads like a retry, which is exactly why it needs the stronger gate
  // rather than the weaker one its name suggests.
  'jobs:reprocessWork',
  'jobs:rerunStage',
  // Cancelling a RUNNING job deletes that stage's output, so it is not the pure
  // "stop what has not started yet" its name implies.
  'jobs:cancel'
])

export function sweep(): SweepFailure[] {
  const fail: SweepFailure[] = []
  const root = repoRootOrNull()
  if (!root) {
    return [{ rule: 'setup', detail: 'the sweep only runs from a repo checkout' }]
  }

  const preloadSrc = readFileSync(join(root, 'src/preload/index.ts'), 'utf8')
  const contractSrc = readFileSync(join(root, 'src/shared/contract.ts'), 'utf8')
  const preload = parsePreload(preloadSrc, contractSrc)
  // Both files that call `ipcMain.handle`. The MCP settings channels live in
  // their own module rather than in `registerIpc()` — they are the one part of
  // the feature the RENDERER talks to, and none of them may enter the registry
  // (an agent raising its own permission level would defeat the point of one).
  const inline = new Set([
    ...parseInlineChannels(readFileSync(join(root, 'src/main/index.ts'), 'utf8')),
    ...parseInlineChannels(readFileSync(join(root, 'src/main/mcp/ipc.ts'), 'utf8'))
  ])

  const registryChannels = new Set(ENTRIES.map((entry) => entry.channel))

  // --- §2.6 the set invariant -------------------------------------------
  // A shared integer literal (`ENTRIES.length + INLINE === 119`) is precisely
  // what four parallel workstreams cannot merge. Both sides are parsed instead.
  for (const channel of registryChannels) {
    if (inline.has(channel)) {
      fail.push({
        rule: 'registry ∩ inline = ∅',
        detail: `${channel} is registered twice — ipcMain.handle would throw at startup`
      })
    }
    if (!preload.has(channel)) {
      fail.push({
        rule: 'every registry channel is reachable',
        detail: `${channel} has no forwarder in src/preload/index.ts, so nothing can call it`
      })
    }
  }
  for (const channel of preload.keys()) {
    if (!registryChannels.has(channel) && !inline.has(channel)) {
      fail.push({
        rule: 'every preload channel is handled',
        detail: `${channel} is forwarded but registered nowhere — it would reject at runtime`
      })
    }
  }

  for (const entry of ENTRIES) {
    // --- §2.5 order vs the preload's parameter names ---------------------
    const forwarder = preload.get(entry.channel)
    if (forwarder) {
      const expected = entry.order ?? []
      if (entry.order) {
        if (expected.length !== forwarder.args.length) {
          fail.push({
            rule: 'order matches preload arity',
            detail: `${entry.channel}: order has ${expected.length}, preload passes ${forwarder.args.length}`
          })
        } else if (expected.some((name, i) => name !== forwarder.args[i])) {
          fail.push({
            rule: 'order matches preload argument names',
            detail: `${entry.channel}: order [${expected.join(', ')}] vs preload [${forwarder.args.join(', ')}]`
          })
        }
      } else if (!forwarder.objectLiteral && forwarder.args.length > 0) {
        // An entry with NO `order` receives `args[0]` and hands it straight to
        // `z.object(...).parse`. That is right when the preload forwards an
        // object literal, and catastrophic when it forwards a bare scalar: the
        // parse throws `expected object` on EVERY call, forever, for a channel
        // that used to work.
        //
        // The arity-2 version of this check missed the single-argument case
        // entirely — `invoke('projects:get', projectId)` — which is both the
        // commonest shape in the preload and the one a domain author is most
        // likely to forget an `order` for.
        fail.push({
          rule: 'positional channels declare an order',
          detail:
            `${entry.channel} has no order, but the preload forwards ` +
            `${forwarder.args.length} positional argument(s) [${forwarder.args.join(', ')}] ` +
            `— every call would fail with "expected object"`
        })
      }
    }

    // --- the positional-null trap ---------------------------------------
    // The loop turns a MISSING positional argument into a present `undefined`
    // and a positional `null` into a present `null`. A plain `.optional()`
    // accepts the first and REJECTS the second, and the renderer really does
    // pass `null` in places (`search:semantic`'s `k ?? undefined` was written to
    // coerce exactly that). So any optional slot in an `order` must be nullish.
    if (entry.order) {
      const shape = entry.params.shape as Record<string, { safeParse(v: unknown): { success: boolean } }>
      for (const name of entry.order) {
        const node = shape[name]
        if (!node) {
          fail.push({
            rule: 'order names real properties',
            detail: `${entry.channel}: order lists '${name}', which the schema does not define`
          })
          continue
        }
        const acceptsUndefined = node.safeParse(undefined).success
        const acceptsNull = node.safeParse(null).success
        if (acceptsUndefined && !acceptsNull) {
          fail.push({
            rule: 'optional positional arguments are nullish',
            detail: `${entry.channel}.${name}: .optional() rejects a positional null; use .nullish()`
          })
        }
      }
    }

    // --- §3.3 the destructive set is exactly the four -------------------
    if (entry.access === 'destructive' && !DESTRUCTIVE_CHANNELS.has(entry.channel)) {
      fail.push({
        rule: 'destructive set',
        detail: `${entry.channel} claims destructive but is not one of the four`
      })
    }
    if (DESTRUCTIVE_CHANNELS.has(entry.channel) && entry.access !== 'destructive') {
      fail.push({
        rule: 'destructive set',
        detail: `${entry.channel} is destructive but declares access '${entry.access}'`
      })
    }

    // --- §3.4 the tabs channels are never MCP tools ---------------------
    //
    // Enforced here rather than left to the comment in `registry/tabs.ts`,
    // because adding `tool:` to one of them would pass every other rule in this
    // file while handing a remote agent the power to open windows, rearrange the
    // pages the user is reading and steal their focus. No reading of the corpus
    // requires it, and `ctx.sender` is null over MCP anyway, so a tool here
    // could only ever be a mistake or an attack.
    if (entry.channel.startsWith('tabs:') && entry.tool) {
      fail.push({
        rule: '§3.4 tabs are not tools',
        detail: `${entry.channel} declares a tool — window and focus control must not be reachable over MCP`
      })
    }

    // --- documentation --------------------------------------------------
    if (entry.tool && entry.summary.trim().length < 20) {
      fail.push({
        rule: 'every tool explains itself',
        detail: `${entry.channel}: summary is what the agent reads at call time; give it a sentence`
      })
    }
    if (!entry.returns.trim()) {
      fail.push({ rule: 'returns is named', detail: `${entry.channel} has no returns line` })
    }

    if (!entry.tool) continue

    // --- §3.1b toolParams is a strict subset ----------------------------
    if (entry.toolParams) {
      const wide = z.toJSONSchema(entry.params, { io: 'input', reused: 'inline' })
      const narrow = z.toJSONSchema(entry.toolParams, { io: 'input', reused: 'inline' })
      fail.push(...subsetFailures(entry.channel, wide, narrow))
    }

    // --- §3.2 no path, and no escape-hatch schema node ------------------
    const exposed = z.toJSONSchema(entry.toolParams ?? entry.params, {
      io: 'input',
      reused: 'inline'
    }) as Record<string, unknown>
    fail.push(...schemaFailures(entry, exposed, ''))
  }

  fail.push(...expressFailures(root))
  fail.push(...windowFactoryFailures(root))

  return fail
}

/**
 * `new BrowserWindow` lives in ONE place, and no caller supplies a `partition`.
 *
 * Both are silent failures, which is why they are checked mechanically rather than
 * left to review. A window constructed outside `createWindow` misses the cap, the
 * rate limit and the tab registration, and a `partition` hands a window a fresh
 * session with no CSP and no scheme filter — a window that looks and behaves
 * exactly like a hardened one while being neither.
 *
 * `app.on('session-created')` hardens any session that does appear, so this is the
 * second layer rather than the only one; it exists because a grep is the only thing
 * that can object to the code being WRITTEN.
 */
function windowFactoryFailures(root: string): SweepFailure[] {
  const fail: SweepFailure[] = []
  const files = sourceFilesUnder(join(root, 'src/main'))
  for (const file of files) {
    // COMMENTS STRIPPED FIRST, block and line alike. This rule reads source as
    // text, so without it the only way to satisfy it is to avoid naming
    // `new BrowserWindow` in prose — which penalises exactly the files that
    // explain why the factory is single, and would train the next person to
    // delete the explanation rather than the code.
    const src = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
    const rel = file.slice(root.length + 1)
    // This file itself carries the pattern in its own rule, and its rules live in
    // strings rather than in code that could construct anything.
    if (rel === 'src/main/ipc/registry.sweep.ts') continue
    if (rel !== 'src/main/index.ts' && /new\s+BrowserWindow\b/.test(src)) {
      fail.push({
        rule: '§5.2 one window factory',
        detail: `${rel}: constructs a BrowserWindow — use createWindow() in src/main/index.ts`
      })
    }
    // Anywhere an object LITERAL sets it — after `{`, after a `,`, or on its own
    // line. Anchoring to the start of a line missed `{ partition: 'tab-1' }`, which
    // is the shape someone would actually write inline.
    if (/(^|[{,(\s])partition\s*:/m.test(src)) {
      fail.push({
        rule: '§5.2 no partition',
        detail: `${rel}: sets a session partition — that session inherits no CSP and no scheme filter`
      })
    }
  }

  // --- §5.3 the four settings the renderer sandbox actually rests on ------
  //
  // Checking only WHERE a window is constructed says nothing about HOW. Every
  // guarantee in this app — that the renderer has no Node, that all data crosses
  // one typed IPC surface, that a compromised page cannot reach the file system —
  // reduces to these four booleans, and flipping any of them is a one-word edit
  // that breaks everything silently and passes every other gate here.
  const index = readFileSync(join(root, 'src/main/index.ts'), 'utf8').replace(/\/\/[^\n]*/g, '')
  for (const [key, want] of [
    ['contextIsolation', 'true'],
    ['nodeIntegration', 'false'],
    ['sandbox', 'true'],
    ['webSecurity', 'true']
  ] as const) {
    // The setting must be present AND set the way the whole design assumes.
    // Absence is a failure too: the defaults have changed between Electron
    // majors, so "it is the default" is not a property this can rely on.
    const re = new RegExp(`\\b${key}\\s*:\\s*(\\w+)`, 'g')
    const found = [...index.matchAll(re)].map((m) => m[1])
    if (found.length === 0) {
      fail.push({
        rule: '§5.3 window hardening is explicit',
        detail: `src/main/index.ts: does not set ${key} — state it rather than inheriting a default`
      })
    }
    for (const got of found) {
      if (got !== want) {
        fail.push({
          rule: '§5.3 window hardening is explicit',
          detail: `src/main/index.ts: ${key} is ${got}, must be ${want}`
        })
      }
    }
  }
  return fail
}

/** Every `.ts` under `dir`, recursively, excluding tests. */
function sourceFilesUnder(dir: string): string[] {
  const out: string[] = []
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name)
    if (ent.isDirectory()) out.push(...sourceFilesUnder(full))
    else if (ent.name.endsWith('.ts') && !ent.name.includes('.test.')) out.push(full)
  }
  return out
}

/**
 * §8.3: no module under `src/main/mcp/` may pull in `express` or `cors`.
 *
 * The SDK ships adapters for both and declares them as dependencies; importing
 * one would drag a web framework and a CORS policy into a process whose entire
 * security posture is "we wrote the front door ourselves and it rejects any
 * request carrying an Origin". Checked on the SOURCE, so it fails at the import
 * that introduced it rather than after a build.
 */
function expressFailures(root: string): SweepFailure[] {
  const fail: SweepFailure[] = []
  const dir = join(root, 'src/main/mcp')
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.ts')) continue
    const src = readFileSync(join(dir, name), 'utf8')
    for (const banned of ['express', 'cors']) {
      const re = new RegExp(`from ['"][^'"]*\\b${banned}(\\.js)?['"]`)
      if (re.test(src)) {
        fail.push({
          rule: 'the MCP layer imports no web framework',
          detail: `src/main/mcp/${name} imports ${banned}`
        })
      }
    }
  }
  return fail
}

interface Forwarder {
  args: string[]
  /** The forwarder passes one object literal, so there are no positional names. */
  objectLiteral: boolean
}

/**
 * Parse the preload's one-line `invoke` forwarders.
 *
 * The `on*` registrars do not match (they are multi-statement bodies, not
 * one-line invokes). `api.window.*` DOES match, and deliberately: those channels
 * belong to the inline set, and the set invariant below must account for them or
 * it would report every one of them as unhandled.
 *
 * The hard part is `(input) => invoke('c', input)`. Read as text it is
 * indistinguishable from `(projectId) => invoke('c', projectId)`, yet the two
 * want OPPOSITE verdicts: the first forwards ONE OBJECT, which the handler is
 * meant to `z.object(...).parse` directly and for which an `order` would be
 * WRONG; the second forwards a bare scalar, for which a missing `order` breaks
 * every call forever. The preload cannot tell them apart because the preload is
 * untyped at that point — but `CorpusApi` in `src/shared/contract.ts` declares
 * the parameter's TYPE, and that is the discriminator. So each forwarder is
 * matched to its interface method and classified by whether the corresponding
 * parameter is object-shaped.
 */
function parsePreload(src: string, contractSrc: string): Map<string, Forwarder> {
  const params = parseContractParamTypes(contractSrc)
  const out = new Map<string, Forwarder>()
  const re = /^\s*(\w+):\s*\(([^)]*)\)\s*=>\s*\n?\s*ipcRenderer\.invoke\(\s*'([^']+)'([^)]*)\)/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const [, method, declared, channel, rest] = m
    const declaredNames = splitArgs(declared)

    // An object literal in the argument list (`invoke('c', { id, patch })`)
    // cannot be split on commas -- doing so yields `["{ id", "patch }"]` and
    // every arity and name comparison against it is nonsense. Such a forwarder
    // passes ONE object, which is exactly the `order`-less case.
    if (rest.includes('{')) {
      out.set(channel, { objectLiteral: true, args: [] })
      continue
    }

    const passed = splitArgs(rest)
    // The NAMES as passed, which is what `order` must match — a forwarder that
    // reorders its own parameters on the way through is exactly the footgun.
    const args = passed.length ? passed : declaredNames

    // Exactly one argument is the ambiguous case, and only the contract resolves
    // it. Anything the contract does not declare (the `api.window.*` helpers)
    // keeps the textual reading, which is the conservative one: it demands an
    // `order`, and those channels are inline rather than registry entries.
    const objectLiteral =
      args.length === 1 && isObjectShaped(params.get(`${method}#0`))

    out.set(channel, { objectLiteral, args: objectLiteral ? [] : args })
  }
  return out
}

function splitArgs(src: string): string[] {
  return src
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
}

/**
 * `true` when a `CorpusApi` parameter's declared type is an object the handler
 * is meant to parse as its whole input: an inline `{ … }` literal, or a named
 * `…DTO`/`…Input`/`…Bundle` interface. A scalar, an array, a union of string
 * literals or an unknown name is NOT object-shaped, so the channel stays
 * positional and still has to declare an `order`.
 */
function isObjectShaped(type: string | undefined): boolean {
  if (!type) return false
  const t = type.trim()
  if (t.startsWith('{')) return true
  if (/\[\]$/.test(t) || t.includes('|') || t.includes("'")) return false
  return /(DTO|Input|Bundle|Options|Filter|Patch)$/.test(t)
}

/**
 * Map `method#<index>` → the declared type text of that parameter, read from
 * `interface CorpusApi`. Brace/bracket/paren depth is tracked so an inline
 * object type containing commas is not split apart.
 */
function parseContractParamTypes(src: string): Map<string, string> {
  const out = new Map<string, string>()
  const start = src.indexOf('interface CorpusApi')
  if (start < 0) return out

  const body = src.slice(start)
  const re = /^ {2}(\w+)\(/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    const method = m[1]
    let i = m.index + m[0].length
    let depth = 1
    let list = ''
    while (i < body.length && depth > 0) {
      const c = body[i]
      if (c === '(' || c === '{' || c === '[' || c === '<') depth++
      else if (c === ')' || c === '}' || c === ']' || c === '>') depth--
      if (depth > 0) list += c
      i++
    }
    splitTopLevel(list).forEach((param, index) => {
      const colon = param.indexOf(':')
      if (colon < 0) return
      out.set(`${method}#${index}`, param.slice(colon + 1).replace(/\s+/g, ' ').trim())
    })
  }
  return out
}

/** Split a parameter list on commas that are not nested inside a type. */
function splitTopLevel(list: string): string[] {
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (const c of list) {
    if (c === '(' || c === '{' || c === '[' || c === '<') depth++
    else if (c === ')' || c === '}' || c === ']' || c === '>') depth--
    if (c === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  if (cur.trim()) parts.push(cur)
  return parts.map((p) => p.trim()).filter(Boolean)
}

/** Channels still registered inline in `src/main/index.ts`. */
function parseInlineChannels(src: string): Set<string> {
  const out = new Set<string>()
  const re = /ipcMain\.handle\(\s*'([^']+)'/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) out.add(m[1])
  return out
}

/** Walk an emitted JSON Schema for path names and escape-hatch nodes. */
function schemaFailures(
  entry: Entry,
  node: Record<string, unknown>,
  prefix: string
): SweepFailure[] {
  const fail: SweepFailure[] = []
  const props = node.properties as Record<string, Record<string, unknown>> | undefined
  if (props) {
    for (const [name, child] of Object.entries(props)) {
      const label = prefix ? `${prefix}.${name}` : name
      if (PATH_PROPERTY_NAMES.has(name.toLowerCase().replace(/_/g, ''))) {
        fail.push({
          rule: 'no filesystem path in a tool argument',
          detail: `${entry.channel}.${label}: chained with an outlet action this is arbitrary file write as the user`
        })
      }
      fail.push(...nodeFailures(entry, child, label))
      fail.push(...schemaFailures(entry, child, label))
    }
  }
  const items = node.items as Record<string, unknown> | undefined
  if (items) fail.push(...schemaFailures(entry, items, `${prefix}[]`))
  // A union branch is a subtree like any other. zod emits `.optional()`,
  // `.nullish()` and `z.union` all as `anyOf`, so without this the walk stopped
  // at the FIRST optional property — and every optional filter object went
  // unchecked for path names, free-form strings and `z.any()`. Three allowlist
  // lines were already dead because of it: the entries existed, the properties
  // they named were never reached, and the allowlist "fails closed" only for the
  // properties the walk happens to visit.
  for (const branch of branchesOf(node)) {
    fail.push(...schemaFailures(entry, branch, prefix))
  }
  return fail
}

/** The `anyOf`/`oneOf`/`allOf` subtrees of a node, ignoring the bare null arm. */
function branchesOf(node: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const arm = node[key]
    if (!Array.isArray(arm)) continue
    for (const b of arm as Record<string, unknown>[]) {
      // `.nullish()` adds a `{type:'null'}` arm that carries no value space of
      // its own; checking it would report every optional property as untyped.
      if (b && b.type !== 'null') out.push(b)
    }
  }
  return out
}

function nodeFailures(
  entry: Entry,
  node: Record<string, unknown>,
  label: string
): SweepFailure[] {
  const fail: SweepFailure[] = []
  const key = `${entry.channel}.${label}`

  // An empty schema is `z.any()`/`z.unknown()`: no type, no enum, no properties.
  // Those pass a name-and-value-space allowlist while smuggling anything at all.
  const hasShape =
    node.type !== undefined ||
    node.enum !== undefined ||
    node.const !== undefined ||
    node.anyOf !== undefined ||
    node.oneOf !== undefined ||
    node.allOf !== undefined ||
    node.$ref !== undefined
  if (!hasShape) {
    fail.push({
      rule: 'no unconstrained schema node',
      detail: `${key}: z.any()/z.unknown() in an exposed schema can carry anything, including a path`
    })
    return fail
  }

  if (node.type === 'object' && node.properties === undefined) {
    fail.push({
      rule: 'no open record in a tool argument',
      detail: `${key}: a record/passthrough object accepts arbitrary keys`
    })
  }

  if (node.type === 'string' && node.enum === undefined && node.const === undefined) {
    if (!(key in FREEFORM_STRING_ALLOWLIST)) {
      fail.push({
        rule: 'free-form strings are allowlisted',
        detail: `${key}: add it to FREEFORM_STRING_ALLOWLIST with a one-line justification, or make it an enum`
      })
    } else if (node.maxLength === undefined) {
      fail.push({
        rule: 'allowlisted strings are bounded',
        detail: `${key}: give it a .max() — an unbounded string is a memory amplifier`
      })
    }
  }

  // An OPTIONAL string is `anyOf: [{type:'string'}, {type:'null'}]`, so the
  // checks above — which read `node.type` — see nothing at all on it. Recursing
  // into the branches under the SAME label is what makes an optional property
  // answer to the same rules as a required one; the allowlist is keyed by label,
  // not by which arm of a union the string arrived in.
  for (const branch of branchesOf(node)) {
    fail.push(...nodeFailures(entry, branch, label))
  }

  return fail
}

/** `toolParams` may only ever NARROW `params`. Fails closed on anything wider. */
function subsetFailures(
  channel: string,
  wide: unknown,
  narrow: unknown
): SweepFailure[] {
  const fail: SweepFailure[] = []
  const w = wide as Record<string, unknown>
  const n = narrow as Record<string, unknown>
  const wp = (w.properties ?? {}) as Record<string, Record<string, unknown>>
  const np = (n.properties ?? {}) as Record<string, Record<string, unknown>>

  for (const [name, node] of Object.entries(np)) {
    const base = wp[name]
    if (!base) {
      fail.push({
        rule: 'toolParams ⊆ params',
        detail: `${channel}.${name} exists only on toolParams — the channel would reject it`
      })
      continue
    }
    if (base.type !== node.type) {
      fail.push({
        rule: 'toolParams ⊆ params',
        detail: `${channel}.${name}: type ${String(node.type)} vs the channel's ${String(base.type)}`
      })
    }
    if (Array.isArray(base.enum) && Array.isArray(node.enum)) {
      const extra = node.enum.filter((v) => !(base.enum as unknown[]).includes(v))
      if (extra.length) {
        fail.push({
          rule: 'toolParams ⊆ params',
          detail: `${channel}.${name}: enum members ${extra.join(', ')} the channel does not accept`
        })
      }
    }
    if (
      typeof base.maxLength === 'number' &&
      typeof node.maxLength === 'number' &&
      node.maxLength > base.maxLength
    ) {
      fail.push({
        rule: 'toolParams ⊆ params',
        detail: `${channel}.${name}: maxLength ${node.maxLength} is wider than the channel's ${base.maxLength}`
      })
    }
  }
  return fail
}
