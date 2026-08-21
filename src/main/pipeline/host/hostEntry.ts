// The stage host: a utilityProcess that executes stage bodies.
//
// It runs the SAME `StageDefinition.execute` main would run inline. That is the
// point — the host pool must not fork the stage contract in two, or every stage
// author would have to know which half they were writing for.
//
// What it does NOT have, deliberately:
//   - a database. `ctx.input` reads the dispatch envelope; `ctx.write` collects
//     payloads that main applies. `openDatabase` is never imported here, and a
//     build gate asserts it.
//   - the gateway credential. `hostEnv()` omits `CORPUS_LLM_*`, so `ctx.llm` is
//     an RPC to main and there is no second way out.
//   - any reason to survive its parent. When the parent port closes, this
//     process exits.

import { resolveRegistry } from '../registry'
import { STAGES } from '../stages'
import type { Capability, StageContext, StageOutcome } from '../types'
import type { DispatchMessage, FromHostMessage, ToHostMessage } from './protocol'

const registry = resolveRegistry(STAGES)

/** The dispatch currently executing, and how to abort it. */
let active: { token: number; abort: AbortController } | null = null

let nextCallId = 1
const pendingCalls = new Map<number, { resolve: (s: string) => void; reject: (e: Error) => void }>()

const send = (msg: FromHostMessage): void => {
  process.parentPort.postMessage(msg)
}

function runDispatch(msg: DispatchMessage): void {
  const resolved = registry.byId(msg.stageId)
  if (!resolved) {
    send({
      kind: 'result',
      token: msg.token,
      outcome: { status: 'failed', error: `stage '${msg.stageId}' is not registered in the host`, retryable: false },
      emitted: [],
      writes: []
    })
    return
  }
  const { stage } = resolved
  const abort = new AbortController()
  active = { token: msg.token, abort }

  const inputs = new Map<Capability, unknown>(msg.inputs)
  const emitted = new Map<Capability, unknown>()
  const writes: unknown[] = []

  const ctx: StageContext = {
    workId: msg.workId,
    documentId: msg.documentId,
    projectId: msg.projectId,
    fanOut: msg.fanOut,
    stageRunId: msg.stageRunId,
    jobId: msg.jobId,
    signal: abort.signal,
    llm: {
      model: msg.llmModel,
      call: (messages, opts) =>
        new Promise<string>((resolve, reject) => {
          if (abort.signal.aborted) {
            reject(new Error('cancelled'))
            return
          }
          const callId = nextCallId++
          pendingCalls.set(callId, { resolve, reject })
          send({ kind: 'llm-request', token: msg.token, callId, messages, opts })
        })
    },
    db: {
      // Resolved in main before dispatch. The host cannot look anything up, and
      // that is the property that makes "one writer" structural rather than a
      // rule somebody has to remember.
      work: () => msg.subject.work,
      document: () => msg.subject.document,
      pdfPath: () => msg.subject.pdfPath,
      identifiers: () => msg.subject.identifiers,
      retrievalStatus: () => msg.subject.retrievalStatus,
      bibliographicRecord: () => msg.subject.bibliographicRecord,
      zoteroConnection: () => {
        // Read at RUN time from the settings table, which a host cannot reach.
        // Shipping it in the envelope would freeze it at dispatch and defeat the
        // reason it is a lookup at all.
        throw new Error(
          `stage '${msg.stageId}' called ctx.db.zoteroConnection() in a host; declare isolation 'inline'`
        )
      },
      corpus: () => {
        // Not shipped in the envelope, and not silently empty either: an empty
        // corpus would make every bibliography entry look unresolvable, which
        // is a confidently wrong answer rather than an error. A stage that
        // needs the whole library is asking a question about the database, so
        // it belongs inline.
        throw new Error(
          `stage '${msg.stageId}' called ctx.db.corpus() in a host; declare isolation 'inline'`
        )
      },
      citationCandidates: () => {
        throw new Error(
          `stage '${msg.stageId}' called ctx.db.citationCandidates() in a host; declare isolation 'inline'`
        )
      },
      pendingReviews: () => {
        throw new Error(
          `stage '${msg.stageId}' called ctx.db.pendingReviews() in a host; declare isolation 'inline'`
        )
      },
      // Shipped in the envelope rather than refused, because a host-isolated
      // stage that calls a model needs the same budget an inline one gets — and
      // resolving it here would mean reading the database from the host, which
      // is the one thing this boundary exists to prevent.
      modelSettings: () => msg.subject.modelSettings,
      contactEmail: () => msg.subject.contactEmail,
      // NOT proxied, and not answered with null. The key is derived from a
      // bibliography line the stage is reading as it goes, so the answer cannot
      // be resolved into the envelope before the run starts — and a null here
      // does not mean "not available", it means "nobody has asked about this
      // paper yet". A host stage taking that at face value would re-ask a
      // question the corpus already has the answer to, every time, and report a
      // saving it never made. A stage that needs this runs inline.
      reusableAbstract: () => {
        throw new Error(
          'reusableAbstract() needs the database and cannot be answered from a host process; ' +
            'run this stage inline'
        )
      },
      // Not shipped in the envelope for the same reason: it is a sweep over
      // every project's papers, and a host has no database to sweep. An empty
      // array would read as "this install holds no papers", which would rank a
      // whole corpus at nothing and look like a considered result.
      scoringSets: () => {
        throw new Error(
          'scoringSets() needs the database and cannot be answered from a host process; ' +
            'run this stage inline'
        )
      },
      // Refused rather than shipped in the envelope, even though it is one row.
      // A document-scoped job carries no project, so answering it means walking
      // `project_work` and choosing among the projects that hold this paper — a
      // decision, not a lookup, and one whose answer is stamped onto every score
      // the stage writes. A null here would read as "this project has not said
      // what it is for", and a stage taking that at face value would record a
      // whole bibliography as unscorable on an install where the question is
      // written down.
      projectQuestion: () => {
        throw new Error(
          'projectQuestion() needs the database and cannot be answered from a host process; ' +
            'run this stage inline'
        )
      }
    },
    // Not proxied, for the same reason `corpus()` is not: the search worker owns
    // its own read-only database connection, and a host has no database. A
    // silent null here would be worse than the throw — the stage would report
    // that semantic search is unavailable on a machine where it works perfectly,
    // and the user would go looking for a missing model.
    semantic: null,
    write: (payload) => {
      writes.push(payload)
    },
    input: <T,>(cap: Capability): T | undefined => inputs.get(cap) as T | undefined,
    emit: (cap, value) => {
      if (!stage.provides.includes(cap)) {
        throw new Error(`stage '${stage.id}' emitted '${cap}', which it does not declare providing`)
      }
      emitted.set(cap, value)
    },
    runAnalysis: () =>
      // Not proxied. `runPipeline` supersedes and inserts across five tables in
      // one transaction; RPC-ing that from a host would put the analysis and
      // the stage's terminal record in two processes as well as two
      // transactions, which is the split §7.2 exists to forbid. A stage that
      // writes an analysis is inline, and says so.
      Promise.reject(
        new Error(`stage '${msg.stageId}' called ctx.runAnalysis in a host; declare isolation 'inline'`)
      ),
    // Not proxied, for the same reason: `generateSummary` supersedes and inserts
    // across two tables in one transaction and needs a database to do it.
    runSummary: () =>
      Promise.reject(
        new Error(`stage '${msg.stageId}' called ctx.runSummary in a host; declare isolation 'inline'`)
      ),
    progress: (pct, note) => {
      send({ kind: 'progress', token: msg.token, pct, note })
    },
    log: (message) => {
      send({ kind: 'log', token: msg.token, message })
    }
  }

  void (async () => {
    let outcome: StageOutcome
    try {
      outcome = await stage.execute(ctx)
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      outcome = { status: 'failed', error: text, retryable: !abort.signal.aborted }
    }
    // Every outstanding LLM promise belongs to a dispatch that is over. Left
    // pending they would hold their entries forever and a later reply keyed on
    // a reused id would resolve the wrong caller.
    for (const [, p] of pendingCalls) p.reject(new Error('stage finished'))
    pendingCalls.clear()
    active = null
    send({
      kind: 'result',
      token: msg.token,
      outcome,
      emitted: [...emitted],
      writes: outcome.status === 'succeeded' ? writes : []
    })
  })()
}

process.parentPort.on('message', (e) => {
  const msg = e.data as ToHostMessage
  switch (msg.kind) {
    case 'dispatch':
      runDispatch(msg)
      break
    case 'cancel':
      // Cooperative half only. A stage wedged in a synchronous native call
      // cannot observe this, which is why the pool follows it with kill() —
      // the graceful path is an optimisation, never the guarantee.
      if (active && active.token === msg.token) active.abort.abort()
      break
    case 'llm-reply': {
      const pending = pendingCalls.get(msg.callId)
      if (!pending) break
      pendingCalls.delete(msg.callId)
      if (msg.ok) pending.resolve(msg.text ?? '')
      else pending.reject(new Error(msg.error ?? 'llm call failed'))
      break
    }
    case 'shutdown':
      process.exit(0)
  }
})

// The parent went away. Exiting immediately is what stops a host outliving the
// app when main is SIGKILLed — the kernel closes the port, this fires, and the
// process does not wait to be asked twice.
const port = process.parentPort as unknown as NodeJS.EventEmitter
port.on('close', () => {
  process.exit(0)
})

send({ kind: 'ready', pid: process.pid })
