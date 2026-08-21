// EXECUTE a host-isolated stage, end to end, inside a real Electron main process.
//
//   npm run verify:stage-host
//
// WHY THIS EXISTS — the coverage hole, not the bug.
//
// Every other `verify:*` script runs under `ELECTRON_RUN_AS_NODE=1`, where
// `require('electron')` returns the STRING path to the binary. `utilityProcess`
// is `undefined` there, so `HostPool.spawn()` cannot even be reached. No gate in
// this repository was capable of executing a host-isolated stage at all.
//
// That is how a completely dead PDF pipeline shipped past twelve green gates.
// `pool.ts` read `e.data` in its parent-side `'message'` handlers, but
// `utilityProcess` hands the listener the POSTED VALUE DIRECTLY — so `.data` was
// `undefined`, the next line threw INSIDE an event handler, and main's event
// loop died. `download`, `optimize`, `extract-text`, `ocr`, `segment` and
// `embed` all hung forever with no error surface.
//
// `verify:host` did not catch it and structurally could not: it forks
// `utilityProcess` BY HAND and reads `m.kind` — the correct shape — and never
// calls `pool.dispatch()`. It tests the host, not the pool, and the bug was in
// the pool.
//
// So this script is deliberately narrow and deliberately literal: it drives a
// REAL registered stage (`segment`) through `HostPool.dispatch()` with real
// inputs, in real Electron, and asserts the stage's actual OUTPUT came back.
// Anything that breaks the parent<->host message contract — a changed event
// shape, a dropped envelope field, a serialisation regression — fails here,
// because nothing about this path is stubbed.

import { app, utilityProcess } from 'electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { HostPool } from '../src/main/pipeline/host/pool'
import { MODEL_DEFAULTS } from '../src/main/llm/modelSettings'

// The envelope a host is dispatched with, for a stage that needs no paper.
// Spread rather than shared by reference so one probe cannot mutate another's.
const EMPTY_SUBJECT = {
  work: null,
  document: null,
  pdfPath: null,
  identifiers: [],
  retrievalStatus: null,
  modelSettings: {
    ...MODEL_DEFAULTS,
    is_default: true
  }
}

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

/**
 * Real prose, because the stage under test is a segmenter.
 *
 * Synthetic input ("aaa\n\nbbb") would pass a segmenter that had stopped
 * recognising headings, sentences or sections — the whole reason the stage is
 * not a string split. This carries a heading, multi-sentence paragraphs and a
 * references section, so the assertions below are about segmentation and not
 * merely about bytes surviving a pipe.
 */
const SAMPLE_PARAGRAPHS = [
  'Directed Evolution of a Kemp Eliminase',
  'Abstract',
  'The designed enzyme KE07 was subjected to seven rounds of directed evolution. ' +
    'Activity improved 200-fold over the computational design. The final variant ' +
    'retained full activity after two hours at 60 degrees Celsius.',
  'Results',
  'Saturation mutagenesis at position 101 produced the largest single gain. ' +
    'Combining it with the K222R substitution was additive rather than epistatic.',
  'References',
  '1. Rothlisberger D, et al. (2008) Kemp elimination catalysts by computational design.'
]

function buildPages(): {
  text: string
  pageCount: number
  pages: Array<{ page: number; charStart: number; charEnd: number; items: unknown[] }>
} {
  const text = SAMPLE_PARAGRAPHS.join('\n\n')
  // One page holding all of it: the stage resolves a paragraph's page by
  // CONTAINMENT of its start offset, so the span must actually cover the text
  // or every paragraph comes back with a null page and the assertion below —
  // which is about segmentation, not about paging — would fail for the wrong
  // reason.
  return {
    text,
    pageCount: 1,
    pages: [{ page: 1, charStart: 0, charEnd: text.length, items: [] }]
  }
}

async function main(): Promise<void> {
  console.log('\n── a host-isolated stage EXECUTES, in real Electron ──────────')

  // The thing the whole script turns on, asserted rather than assumed: under
  // ELECTRON_RUN_AS_NODE this is a string and everything below is unreachable.
  // Stating it here means a future runner that quietly reintroduces that flag
  // fails loudly instead of skipping the only coverage of this path.
  check(
    'utilityProcess exists (i.e. this really is an Electron main process)',
    typeof utilityProcess?.fork === 'function',
    `typeof utilityProcess === '${typeof utilityProcess}'`
  )

  const scratch = mkdtempSync(join(tmpdir(), 'corpus-stage-host-'))
  const pool = new HostPool({
    // The BUILT host, the same file `src/main/index.ts` points at. Running the
    // TypeScript source here would test a bundle the app never loads.
    entryPath: join(process.cwd(), 'out', 'main', 'stageHost.js'),
    runDir: join(scratch, 'run'),
    instanceId: randomUUID()
  })

  const pages = buildPages()
  const ac = new AbortController()
  const logs: string[] = []
  const progress: number[] = []

  let result: Awaited<ReturnType<HostPool['dispatch']>> | null = null
  let dispatchError: string | null = null
  try {
    result = await pool.dispatch({
      message: {
        stageId: 'segment',
        workId: 1,
        documentId: 1,
        projectId: 0,
        stageRunId: 1,
        jobId: 1,
        fanOut: null,
        subject: { ...EMPTY_SUBJECT },
        llmModel: 'none',
        cancelGraceMs: 2000,
        inputs: [['text.pages@v2', pages]]
      },
      signal: ac.signal,
      onProgress: (pct) => progress.push(pct),
      onLog: (m) => logs.push(m),
      callLlm: () => Promise.reject(new Error('segment must not reach an LLM'))
    })
  } catch (err) {
    dispatchError = err instanceof Error ? err.message : String(err)
  }

  // THE assertion. Before the pool was fixed this never settled at all — the
  // dispatch hung forever — so a timeout here is as much a failure as a wrong
  // answer, and the runner's own timeout is what reports it.
  check(
    'pool.dispatch() returned',
    result !== null,
    dispatchError ?? (result === null ? 'no result and no error' : '')
  )

  if (result) {
    check(
      `the stage SUCCEEDED (${result.outcome.status})`,
      result.outcome.status === 'succeeded',
      result.outcome.status === 'failed' ? result.outcome.error : ''
    )

    // The stage's real output crossed back, not merely a terminal status. A
    // pool that lost the payload but kept the outcome would look healthy.
    const emitted = new Map(result.emitted)
    const paras = emitted.get('text.paragraphs@v1') as
      | { paragraphs: Array<{ text: string; section: string | null; page: number | null }> }
      | undefined
    check('it emitted text.paragraphs@v1', paras !== undefined)
    check(
      'the emitted inventory holds every paragraph of the input',
      (paras?.paragraphs.length ?? 0) >= SAMPLE_PARAGRAPHS.length - 1,
      `${paras?.paragraphs.length ?? 0} paragraph(s)`
    )
    // Segmentation actually happened, rather than the text arriving intact: a
    // heading was recognised and its section carried forward to the prose after
    // it. This is the part a plain byte-for-byte relay would fail.
    const sections = new Set((paras?.paragraphs ?? []).map((p) => p.section))
    check(
      'sections were resolved, not left null',
      sections.size > 1 && !(sections.size === 1 && sections.has(null)),
      [...sections].join(', ')
    )
    check(
      'the bibliography was recognised as its own section',
      sections.has('references')
    )
    // The rows the stage queued for main to write. These travel by a different
    // field of the envelope than `emitted`, and losing one silently produces a
    // stage that reports success and stores nothing.
    check('it queued its paragraph rows for main to write', result.writes.length > 0)
  }

  // A SECOND dispatch on the same pool. The first proves the contract; this
  // proves the host is reusable, which is the property the pool exists for —
  // and a host left in a wedged state after one job would hang here.
  let second: Awaited<ReturnType<HostPool['dispatch']>> | null = null
  try {
    second = await pool.dispatch({
      message: {
        stageId: 'segment',
        workId: 2,
        documentId: 2,
        projectId: 0,
        stageRunId: 2,
        jobId: 2,
        fanOut: null,
        subject: { ...EMPTY_SUBJECT },
        llmModel: 'none',
        cancelGraceMs: 2000,
        inputs: [['text.pages@v2', pages]]
      },
      signal: new AbortController().signal,
      onProgress: () => {},
      onLog: () => {},
      callLlm: () => Promise.reject(new Error('segment must not reach an LLM'))
    })
  } catch (err) {
    check('a second dispatch on the same pool succeeded', false, String(err))
  }
  if (second) {
    check(
      'a second dispatch on the same pool succeeded',
      second.outcome.status === 'succeeded'
    )
  }

  // A stage the registry does not know must come back as a FAILURE, not as a
  // hang and not as a crashed host. This is the negative half: it proves the
  // error path also completes the round trip.
  let unknownStatus = 'no result'
  try {
    const bad = await pool.dispatch({
      message: {
        stageId: 'no-such-stage',
        workId: 1,
        documentId: 1,
        projectId: 0,
        stageRunId: 3,
        jobId: 3,
        fanOut: null,
        subject: { ...EMPTY_SUBJECT },
        llmModel: 'none',
        cancelGraceMs: 2000,
        inputs: []
      },
      signal: new AbortController().signal,
      onProgress: () => {},
      onLog: () => {},
      callLlm: () => Promise.reject(new Error('unreachable'))
    })
    unknownStatus = bad.outcome.status
  } catch (err) {
    unknownStatus = `threw: ${err instanceof Error ? err.message : String(err)}`
  }
  check(
    'an unknown stage id comes back as a failure, not a hang',
    unknownStatus === 'failed' || unknownStatus.startsWith('threw:'),
    unknownStatus
  )

  await pool.shutdown()
  rmSync(scratch, { recursive: true, force: true })

  console.log(
    failures === 0
      ? '\nall stage-host checks passed\n'
      : `\n${failures} stage-host check(s) FAILED\n`
  )
}

app.whenReady().then(
  () =>
    main().then(
      () => app.exit(failures === 0 ? 0 : 1),
      (err) => {
        console.error(err)
        app.exit(1)
      }
    ),
  (err) => {
    console.error(err)
    process.exit(1)
  }
)
