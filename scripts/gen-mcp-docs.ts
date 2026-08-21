// Generates `docs/mcp-tools.md` from the IPC registry.
//
// 70-odd hand-written tool sections drift the first time a filter is added to a
// schema. The registry already holds the tool name, access level, summary,
// return line and zod schema, so the reference is derived from it and rewritten
// on demand: `npm run docs:mcp` (add `--check` to fail instead of writing).
//
// Runs under electron-as-node like the other scripts here, because the registry
// pulls in the repositories, which pull in better-sqlite3's Electron-ABI build.

import { writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ENTRIES, inputSchemaOf } from '../src/main/ipc/registry'
import type { Entry } from '../src/main/ipc/types'
import { CLAMP } from '../src/main/ipc/clamp'
import { RESPONSE_BUDGET_BYTES } from '../src/main/ipc/result'

const OUT = join(process.cwd(), 'docs', 'mcp-tools.md')

/** Domain sections, in reading order. A tool matches the first prefix that fits. */
const DOMAINS: Array<{ title: string; blurb: string; match: (tool: string) => boolean }> = [
  {
    title: 'Projects',
    blurb: 'A project is one line of enquiry. Most other tools take a `projectId`.',
    match: (t) => t.startsWith('project') && !t.startsWith('project_schema')
  },
  {
    title: 'Finding papers',
    blurb: 'Keyword search, meaning-based search, facets and saved searches.',
    match: (t) => t.startsWith('papers_') || t.startsWith('search_') || t.startsWith('semantic_')
  },
  {
    title: 'One paper',
    blurb: 'Everything hanging off a single `workId`. Start with `paper_resolve`.',
    match: (t) => t.startsWith('paper_') || t.startsWith('unresolved_ref_')
  },
  {
    title: 'Citation graph',
    blurb: 'Who cites whom, and pulling in the references of a paper you already have.',
    match: (t) => t.startsWith('graph_') || t.startsWith('reference')
  },
  {
    title: 'Extraction schemas',
    blurb: 'The field sets the model fills in per paper, and how much of the corpus they cover.',
    match: (t) => t.startsWith('schema') || t.startsWith('project_schema') || t.startsWith('extraction_')
  },
  {
    title: 'Review',
    blurb: 'The human verdict queue over extracted facts.',
    match: (t) => t.startsWith('review_')
  },
  {
    title: 'Ranking',
    blurb: 'Two separate scores per paper, plus inclusion decisions.',
    match: (t) => t.startsWith('ranking_')
  },
  {
    title: 'Dossier',
    blurb: 'The project-level synthesis built from papers marked as references.',
    match: (t) => t.startsWith('dossier_')
  },
  {
    title: 'Queue and jobs',
    blurb: 'The background pipeline: what is running, what failed, what is stale.',
    match: (t) => t.startsWith('job') || t.startsWith('queue_') || t.startsWith('stages_')
  },
  {
    title: 'Export and outlets',
    blurb: 'Reading what an export or an outlet would produce, and running one.',
    match: (t) => t.startsWith('export_') || t.startsWith('outlet')
  },
  {
    title: 'Install status',
    blurb: 'Is this connected to the corpus you think it is, and is the model reachable.',
    match: () => true
  }
]

// ------------------------------------------------------------------ schema → sketch

type Json = Record<string, unknown>

/** A one-line type sketch for a JSON Schema node. Nested objects are inlined, depth-capped. */
function sketch(node: unknown, depth = 0): string {
  if (node === null || typeof node !== 'object') return 'any'
  const s = node as Json

  if (Array.isArray(s.enum)) return (s.enum as unknown[]).map((v) => JSON.stringify(v)).join(' | ')
  if (s.const !== undefined) return JSON.stringify(s.const)

  const union = (s.anyOf ?? s.oneOf) as unknown[] | undefined
  if (Array.isArray(union)) {
    return [...new Set(union.map((u) => sketch(u, depth)))].join(' | ')
  }

  const type = Array.isArray(s.type) ? (s.type as string[]).join(' | ') : (s.type as string | undefined)

  if (type === 'array') return `${sketch(s.items, depth + 1)}[]`

  if (type === 'object') {
    const props = (s.properties ?? {}) as Json
    const names = Object.keys(props)
    if (names.length === 0) return 'object'
    if (depth >= 2) return `{…${names.length} fields}`
    const required = new Set((s.required as string[] | undefined) ?? [])
    const body = names
      .map((n) => `${n}${required.has(n) ? '' : '?'}: ${sketch(props[n], depth + 1)}`)
      .join(', ')
    return `{ ${body} }`
  }

  return type ?? 'any'
}

/**
 * The constraints worth printing beside a parameter.
 *
 * `z.number().int()` emits `maximum: 9007199254740991` — the safe-integer
 * ceiling, which is true of every integer field and therefore tells a reader
 * nothing. Printing it put a 16-digit number in a hundred table cells.
 */
const SAFE_INT = Number.MAX_SAFE_INTEGER

function constraints(node: unknown): string {
  if (node === null || typeof node !== 'object') return ''
  const s = node as Json
  const bits: string[] = []
  const num = (k: string, label: string): void => {
    const v = s[k]
    if (typeof v !== 'number') return
    if (Math.abs(v) === SAFE_INT) return
    bits.push(`${label} ${v}`)
  }
  num('minimum', '≥')
  num('exclusiveMinimum', '>')
  num('maximum', '≤')
  num('exclusiveMaximum', '<')
  num('minLength', 'min length')
  num('maxLength', 'max length')
  num('minItems', 'min items')
  num('maxItems', 'max items')
  if (s.default !== undefined) bits.push(`default ${JSON.stringify(s.default)}`)
  if (typeof s.description === 'string') bits.push(s.description)
  return bits.join(', ')
}

/**
 * A markdown table cell.
 *
 * A type sketch is full of `|` — every union and every nullable field — and an
 * unescaped one ends the cell, so the whole table collapses into gibberish.
 */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|')
}

/**
 * The object node inside a possibly-nullable wrapper, or null.
 *
 * `projectId: z.number().nullish()` and `filters: z.object({…}).nullish()` both
 * arrive as an `anyOf`, so the object has to be dug out of the union before its
 * fields can be listed.
 */
function objectNode(node: unknown): Json | null {
  if (node === null || typeof node !== 'object') return null
  const s = node as Json
  if (s.type === 'object' && s.properties) return s
  const union = (s.anyOf ?? s.oneOf) as unknown[] | undefined
  if (!Array.isArray(union)) return null
  for (const u of union) {
    const found = objectNode(u)
    if (found) return found
  }
  return null
}

/** Fields of a nested object get their own rows past this width; below it the sketch reads fine. */
const INLINE_SKETCH_LIMIT = 90

function rowsFor(props: Json, required: Set<string>, prefix: string): string[] {
  const out: string[] = []
  for (const name of Object.keys(props)) {
    const node = props[name]
    const label = `${prefix}${name}`
    const type = sketch(node)
    const nested = prefix === '' && type.length > INLINE_SKETCH_LIMIT ? objectNode(node) : null
    if (nested) {
      const optional = type.includes('null') ? 'object \\| null' : 'object'
      out.push(`| \`${label}\` | \`${optional}\` | ${required.has(name) ? 'yes' : 'no'} | fields below |`)
      out.push(
        ...rowsFor(
          (nested.properties ?? {}) as Json,
          new Set((nested.required as string[] | undefined) ?? []),
          `${label}.`
        )
      )
      continue
    }
    out.push(
      `| \`${label}\` | \`${cell(type)}\` | ${required.has(name) ? 'yes' : 'no'} | ${cell(constraints(node)) || '—'} |`
    )
  }
  return out
}

function paramTable(schema: Json): string {
  const props = (schema.properties ?? {}) as Json
  if (Object.keys(props).length === 0) return '_No arguments._'
  const required = new Set((schema.required as string[] | undefined) ?? [])
  return [
    '| field | type | required | notes |',
    '|---|---|---|---|',
    ...rowsFor(props, required, '')
  ].join('\n')
}

// ------------------------------------------------------------------ response DTOs

/**
 * The DTO field lists, read out of `src/shared`.
 *
 * A bare `RerunResultDTO` tells an agent nothing, and every entry whose summary
 * says "READ state" is naming a field the reader has no way to see. There is no
 * runtime value to reflect over — these are TypeScript interfaces, erased before
 * anything runs — so the declarations are parsed out of the source text.
 *
 * Deliberately shallow: field name and its type as written, comments dropped. A
 * full type expansion would reproduce the contract file, which is not what a
 * caller needs to know what came back.
 */
function collectDtos(): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const root = join(process.cwd(), 'src', 'shared')

  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.ts')) files.push(path)
    }
  }
  walk(root)

  for (const file of files) {
    const src = readFileSync(file, 'utf8')
    const re = /export interface (\w+DTO)\s*(?:extends [\w\s,]+)?\{([\s\S]*?)\n\}/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src)) !== null) {
      const fields = parseFields(m[2])
      if (fields.length > 0) out.set(m[1], fields)
    }
  }
  return out
}

/** `name: type` lines of an interface body, with comments and nested braces skipped. */
function parseFields(body: string): string[] {
  const fields: string[] = []
  let depth = 0
  let inBlockComment = false
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false
      continue
    }
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) inBlockComment = true
      continue
    }
    if (line.startsWith('//') || line === '') continue

    if (depth === 0) {
      const m = /^(readonly\s+)?(\w+)(\?)?:\s*(.+?);?$/.exec(line)
      if (m) fields.push(`${m[2]}${m[3] ?? ''}: ${m[4].replace(/;$/, '')}`)
    }
    // Counted AFTER matching, so the line that OPENS a nested object still
    // registers as that object's own field before its members are skipped.
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length
  }
  return fields
}

const DTOS = collectDtos()

/**
 * The DTO name inside a `returns` line, if there is exactly one to look up.
 *
 * `returns` is hand-written prose — `WorkDetailDTO | null`, `ProjectWorkDTO[]`,
 * `number (rows recomputed)` — so the name is extracted rather than assumed.
 */
function returnedDto(returns: string): string | null {
  const names = [...new Set(returns.match(/\b\w+DTO\b/g) ?? [])]
  return names.length === 1 && DTOS.has(names[0]) ? names[0] : null
}

function responseBlock(entry: Entry): string {
  const name = returnedDto(entry.returns)
  const lines = [`\`${entry.returns}\``]
  if (name) {
    lines.push('', `\`${name}\` fields: ${DTOS.get(name)!.map((f) => `\`${f}\``).join(', ')}`)
  }
  if (entry.shape) {
    // WHICH reshaping, not merely that there is one. Half the entries with a
    // `shape` do not produce a list at all — they redact a path down to a
    // boolean (`outlets_list`), trim a sub-array (`papers_search_by_meaning`) or
    // return a count (`ranking_recompute`) — and telling an agent that all of
    // them "arrive in the envelope" is a promise the server does not keep. An
    // agent that believed it reads `total` off a value that has none, gets
    // `undefined`, and reports zero. Read from the source of the closure rather
    // than asserted by hand, so it cannot drift from what the code does.
    lines.push(
      '',
      entry.shape.toString().includes('listScope')
        ? 'Reshaped over MCP — a list arrives in the [envelope](./mcp.md#what-comes-back).'
        : 'Reshaped over MCP — this is NOT the list envelope; it is trimmed or redacted in place, and has no `total`/`offset`.'
    )
  }
  return lines.join('\n')
}

// ------------------------------------------------------------------ rendering

function section(entry: Entry): string {
  const tool = entry.tool as string
  const schema = inputSchemaOf(entry) as Json
  const flags = [
    `access **${entry.access}**`,
    entry.slow === true ? 'long-running' : null,
    entry.toolParams ? 'narrower arguments over MCP than in the app' : null,
    entry.clampArgs ? 'arguments are capped' : null
  ].filter(Boolean)

  const lines = [
    `#### \`${tool}\``,
    '',
    entry.summary,
    '',
    `${flags.join(' · ')} · channel \`${entry.channel}\``,
    '',
    '**Request**',
    '',
    paramTable(schema),
    '',
    '**Response**',
    '',
    responseBlock(entry),
    ''
  ]
  return lines.join('\n')
}

function render(): string {
  const tools = ENTRIES.filter((e) => e.tool !== null).sort((a, b) =>
    (a.tool as string).localeCompare(b.tool as string)
  )

  const assigned = new Set<string>()
  const groups = DOMAINS.map((d) => {
    const list = tools.filter((e) => {
      const t = e.tool as string
      if (assigned.has(t)) return false
      if (!d.match(t)) return false
      assigned.add(t)
      return true
    })
    return { ...d, list }
  }).filter((g) => g.list.length > 0)

  const counts = {
    read: tools.filter((e) => e.access === 'read').length,
    write: tools.filter((e) => e.access === 'write').length,
    destructive: tools.filter((e) => e.access === 'destructive').length
  }

  const out: string[] = [
    '# MCP tool reference',
    '',
    '<!-- GENERATED by `npm run docs:mcp` from src/main/ipc/registry. Do not edit. -->',
    '',
    `${tools.length} tools, plus \`health\`, which every level can call.`,
    `${counts.read} read · ${counts.write} write · ${counts.destructive} destructive.`,
    'A tool above the connection\u2019s permission level is not listed and not callable —',
    'see [docs/mcp.md](./mcp.md) for turning the server on and choosing that level.',
    '',
    `Caps applied to arguments before a tool runs: \`limit\` ≤ ${CLAMP.limit}, \`k\` ≤ ${CLAMP.k},`,
    `graph nodes ≤ ${CLAMP.graphNodes}, unresolved references per paper in a`,
    `reference tree ≤ ${CLAMP.unresolvedPerWork}.`,
    `Any response over ${RESPONSE_BUDGET_BYTES / 1024 / 1024} MiB is truncated at a row boundary and flagged \`truncated: true\`.`,
    '',
    '## Contents',
    '',
    ...groups.map(
      (g) =>
        `- [${g.title}](#${g.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}) — ${g.list.length} tool(s)`
    ),
    ''
  ]

  for (const g of groups) {
    out.push(`## ${g.title}`, '', g.blurb, '')
    for (const entry of g.list) out.push(section(entry))
  }

  // The UI-only channels are worth naming: an agent that cannot find a way to
  // create a project should learn that there deliberately is none, rather than
  // keep looking.
  const uiOnly = ENTRIES.filter((e) => e.tool === null)
  out.push(
    '## Not exposed as tools',
    '',
    'These capabilities exist in the app and deliberately have no tool. Ask the person',
    'using the app to do them.',
    '',
    '| channel | why |',
    '|---|---|',
    ...uiOnly.map((e) => `| \`${e.channel}\` | ${e.summary.replace(/\s+/g, ' ')} |`),
    ''
  )

  return out.join('\n')
}

const markdown = render()

if (process.argv.includes('--check')) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : ''
  if (current !== markdown) {
    // eslint-disable-next-line no-console
    console.error('[docs:mcp] docs/mcp-tools.md is stale — run `npm run docs:mcp`')
    process.exit(1)
  }
  // eslint-disable-next-line no-console
  console.log('[docs:mcp] up to date')
} else {
  writeFileSync(OUT, markdown, 'utf8')
  // eslint-disable-next-line no-console
  console.log(`[docs:mcp] wrote ${OUT}`)
}
