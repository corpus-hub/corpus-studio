// One paper's whole story out of the developer log, in reading order.
//
//   npm run trace -- 13                  # the newest session
//   npm run trace -- 13 --session <path> # a specific one
//   npm run trace -- 13 --full           # prompts and raw answers UNCLIPPED
//   npm run trace -- --list              # what sessions exist
//
// WHY THIS EXISTS. The session file is JSONL holding whole documents inline: a
// single extraction prompt is 80 000 characters, so `grep`-ing it either drowns
// the reader or hides the very field they came for. And the events that answer
// "why did this paper produce nothing" are not adjacent — the stage boundary,
// the conversation, and the eleven per-claim dispositions sit hundreds of lines
// and several papers apart.
//
// So this narrows to ONE work id and prints the events in the order they
// happened, indented under the stage that produced them. Nothing is filtered
// out: `--full` decides how much of each long field is shown, never which
// events. A trace tool that quietly dropped an event class would recreate the
// exact failure it exists to fix.
//
// READ-ONLY, and touches no database at all. The app may be running.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { devLogDir } from '../src/main/devlog'

const out = (s: string): void => {
  // eslint-disable-next-line no-console
  console.log(s)
}

interface Event {
  at: string
  kind: string
  [k: string]: unknown
}

/** How much of a long field is printed without `--full`. */
const CLIP = 1200

function sessions(): string[] {
  const dir = devLogDir()
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((f) => f.startsWith('session-') && f.endsWith('.log'))
    .map((f) => join(dir, f))
    .sort()
}

function clip(s: string, full: boolean): string {
  if (full || s.length <= CLIP) return s
  return `${s.slice(0, CLIP)}\n      … [${s.length - CLIP} more characters — re-run with --full]`
}

/** Long text, indented so it cannot be mistaken for the event list. */
function block(label: string, text: string, full: boolean): string {
  const body = clip(text, full)
    .split('\n')
    .map((l) => `      ${l}`)
    .join('\n')
  return `    ${label}:\n${body}`
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null)

function describe(e: Event, full: boolean): string[] {
  const lines: string[] = []
  const t = e.at.slice(11, 23)

  switch (e.kind) {
    case 'stage-start': {
      const bits = [
        `schema=${e.schemaId ?? '-'}`,
        e.fanOut ? `fan=${String(e.fanOut)}` : null,
        e.isolation ? String(e.isolation) : null,
        e.cached ? 'CACHE HIT — nothing executed' : null,
        e.fingerprint ? `fp=${String(e.fingerprint).slice(0, 12)}` : null
      ].filter(Boolean)
      lines.push('')
      lines.push(`${t}  ▶ STAGE ${String(e.stage)}  ${bits.join('  ')}`)
      break
    }
    case 'stage-end': {
      const status = String(e.status)
      const mark = status === 'succeeded' ? '✓' : status === 'failed' ? '✗' : '·'
      lines.push(
        `${t}  ${mark} END   ${String(e.stage)} → ${status}  ${num(e.durationMs) ?? '?'}ms` +
          (e.cached ? '  (cached)' : '')
      )
      const note = str(e.note)
      if (note) lines.push(`      note: ${note}`)
      const err = str(e.error)
      if (err) lines.push(`      error: ${err}`)
      break
    }
    case 'llm-request': {
      const msgs = (e.messages as Array<{ role: string; content: string; images?: number }>) ?? []
      const imgs = num(e.images) ?? 0
      const bytes = (e.imageBytes as number[] | undefined) ?? []
      lines.push(
        `${t}  → LLM  ${String(e.model)} attempt ${e.attempt}  max_tokens=${e.maxTokens}` +
          (imgs > 0 ? `  images=${imgs} (${bytes.join(', ')} bytes)` : '') +
          (e.purpose ? `  for ${String(e.purpose)}` : '')
      )
      for (const m of msgs) lines.push(block(m.role.toUpperCase(), m.content, full))
      break
    }
    case 'llm-response': {
      lines.push(
        `${t}  ← LLM  ${num(e.durationMs) ?? '?'}ms  finish=${e.finishReason ?? '?'}  ` +
          `tokens ${e.promptTokens ?? '?'}→${e.completionTokens ?? '?'}`
      )
      lines.push(block('RAW', String(e.raw ?? ''), full))
      break
    }
    case 'llm-error':
      lines.push(`${t}  ✗ LLM  attempt ${e.attempt}: ${String(e.error)}`)
      if (str(e.partial)) lines.push(block('PARTIAL', String(e.partial), full))
      break
    case 'validation-failure':
      lines.push(
        `${t}  ✗ SCHEMA ${String(e.schemaName)} rejected answer ${e.attempt}` +
          (e.parsed ? '' : ' (not even JSON)')
      )
      lines.push(block('ISSUES', String(e.issues ?? ''), full))
      lines.push(block('RAW', String(e.raw ?? ''), full))
      break
    case 'schema-repair':
      lines.push(`${t}  ↻ REPAIR ${String(e.note).replace(/\n/g, ' ')}`)
      break
    case 'claim': {
      const kept = e.outcome === 'kept'
      const value = [str(e.value), str(e.unit)].filter(Boolean).join(' ')
      lines.push(
        `${t}  ${kept ? '+' : '−'} CLAIM ${String(e.outcome)}  ${String(e.predicate)}` +
          (str(e.fieldKey) ? ` [${String(e.fieldKey)}]` : '') +
          (value ? ` = ${value}` : '')
      )
      if (str(e.why)) lines.push(`      why: ${String(e.why)}`)
      if (str(e.quote)) lines.push(`      quote: ${clip(String(e.quote), full)}`)
      break
    }
    case 'claim-ledger': {
      const dropped =
        (num(e.droppedUnanchored) ?? 0) +
        (num(e.droppedOffSchema) ?? 0) +
        (num(e.droppedWrongDimension) ?? 0)
      lines.push(
        `${t}  = LEDGER ${String(e.analysisType)} run ${e.analysisRunId ?? '?'}: ` +
          `model returned ${e.modelReturned}, kept ${e.kept}, dropped ${dropped} ` +
          `(unanchored ${e.droppedUnanchored}, off-schema ${e.droppedOffSchema}, ` +
          `wrong-dimension ${e.droppedWrongDimension})  verifier=${e.verifier}` +
          (e.truncated ? '  TRUNCATED' : '')
      )
      // The whole point, said in words: an empty result has two very different
      // causes and the reader must not have to do the arithmetic themselves.
      if ((num(e.kept) ?? 0) === 0) {
        lines.push(
          (num(e.modelReturned) ?? 0) === 0
            ? '      ⇒ THE MODEL RETURNED NOTHING. The emptiness is the model’s answer.'
            : `      ⇒ THE MODEL RETURNED ${e.modelReturned} CLAIM(S) AND WE DROPPED EVERY ONE. ` +
              'The emptiness is ours — see the dropped claims above.'
        )
      }
      for (const s of (e.shortfalls as string[] | undefined) ?? []) {
        lines.push(`      shortfall: ${s}`)
      }
      break
    }
    case 'anchor':
      lines.push(
        `${t}  ⚓ ANCHOR ${String(e.predicate)} → p${e.resolvedParagraph ?? '?'} ` +
          `(model said p${JSON.stringify(e.claimedParagraph)})  ${e.located ? 'verbatim' : 'NOT verbatim'}`
      )
      break
    case 'citation-verdict':
      lines.push(
        `${t}  § CITE ctx ${e.contextId} ${e.citingWorkId}→${e.citedWorkId}: stored ${String(e.stored)}` +
          (e.anchor && e.anchor !== 'none' ? `, anchor ${String(e.anchor)}` : '')
      )
      if (str(e.sentence)) lines.push(`      passage: ${clip(String(e.sentence), full)}`)
      if (str(e.why)) lines.push(`      why: ${String(e.why)}`)
      break
    case 'session':
      lines.push(`${t}  ⌁ ${String(e.note)}`)
      break
    default:
      lines.push(`${t}  ? ${e.kind} ${JSON.stringify(e)}`)
  }
  return lines
}

export function trace(argv: string[] = process.argv.slice(2)): void {
  const full = argv.includes('--full')
  const sessIdx = argv.indexOf('--session')
  const files = sessions()

  if (argv.includes('--list')) {
    if (files.length === 0) {
      out(`no session files in ${devLogDir()} — turn developer mode on and run something`)
      return
    }
    for (const f of files) out(`${f}  ${statSync(f).size} bytes`)
    return
  }

  const flagValues = new Set([sessIdx].filter((i) => i >= 0).map((i) => i + 1))
  const workArg = argv.find((a, i) => /^\d+$/.test(a) && !flagValues.has(i))
  if (!workArg) {
    throw new Error('name one work id, e.g. `npm run trace -- 13` (or --list)')
  }
  const workId = Number(workArg)

  const file = sessIdx >= 0 ? argv[sessIdx + 1] : files[files.length - 1]
  if (!file) {
    throw new Error(
      `no developer-log session in ${devLogDir()}. Turn developer mode on (Settings, or ` +
        'CORPUS_DEV_LOG=1) and re-run the work.'
    )
  }

  const events: Event[] = []
  // Line by line, tolerating a torn last line: the log is appended
  // synchronously and may be read while a run is still writing it, which is
  // precisely when someone most wants to look.
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line) as Event)
    } catch {
      continue
    }
  }

  const mine = events.filter((e) => e.workId === workId)
  out(`session: ${file}`)
  out(`work ${workId}: ${mine.length} event(s) of ${events.length} in this session`)
  if (mine.length === 0) {
    const seen = [...new Set(events.map((e) => e.workId).filter((w) => typeof w === 'number'))]
    out(`works present in this session: ${seen.length ? seen.join(', ') : 'none'}`)
    return
  }
  const kinds = new Map<string, number>()
  for (const e of mine) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1)
  out(
    `events: ${[...kinds.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k} ${n}`)
      .join(', ')}`
  )
  out('─'.repeat(78))
  for (const e of mine) for (const l of describe(e, full)) out(l)
}

// `import.meta.url` is not available under `ELECTRON_RUN_AS_NODE` + tsx in the
// same shape as a plain node ESM entry, so the guard other scripts use is the
// argv one: this file is only ever invoked directly.
if (process.argv[1]?.endsWith('trace.ts')) {
  try {
    trace()
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}
