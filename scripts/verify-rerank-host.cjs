// The reranker host, checked against the SHIPPED artefacts.
//
// WHAT THIS EXISTS TO CATCH. The app used to die with no window and nothing in
// its log, killed inside V8:
//
//   FATAL ERROR: HandleScope::HandleScope
//   Entering the V8 API without proper locking in place
//     OrtValueToNapiValue(...) [onnxruntime_binding.node]
//     onnxruntime-node/dist/backend.js:48
//
// The cause was two ONNX sessions in two V8 ISOLATES of one process: the
// reranker inline in main, the search embedder in a `worker_threads` Worker. A
// JS mutex cannot span that, so the reranker moved into a utilityProcess. This
// script asserts the property that bought — and does it in the app's own shape,
// forking `out/main/rerankHost.js` while an embedder runs in a worker thread of
// the parent, which is exactly the pair that used to abort.
//
// FIVE CHECKS, because "it answered" is not enough:
//   coexistence  host and worker both complete their rounds, parent survives
//   discrimination  a relevant passage outscores an irrelevant one by a margin.
//                   A constant is not an answer, and a wired-up-but-wrong model
//                   returns one just as happily as a working model returns a
//                   score.
//   cancel       a cancelled batch returns the scores actually taken and leaves
//                the host ALIVE. Warmed first ON PURPOSE: a cold host spends
//                about a second loading its session, so a cancel timed from the
//                request lands before the loop begins and proves nothing.
//   shipped window  one pool-10 request, warm, posted-to-scored through the
//                REAL host — the exact window the search's RERANK_TIMEOUT_MS
//                covers. The retrieval benchmark times scorePairs in-process
//                (its electron-as-node host cannot fork this child), so the
//                hop the shipped search always waits inside is outside that
//                measurement; this is the number that closes the gap.
//   negative control  the OLD shape — both models in one process — still
//                aborts. Without it a pass could mean the crash simply stopped
//                reproducing, and the whole diagnosis would be unsupported.
//
//   npm run verify:rerank
//
// `--timing-only` runs ONLY the shipped-window check against a fresh host and
// writes its samples as JSON to `--out <file>` (passages from `--passages
// <file>`, a JSON array of strings, else a synthetic pool). The retrieval
// benchmark's rerank stage calls it for exactly that file: it records the
// hosted latency beside its in-process rerankP50/P95 in tmp/bench-retrieval.json.

const { app, utilityProcess } = require('electron')
const { Worker } = require('node:worker_threads')
const { fork } = require('node:child_process')
const { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } = require('node:fs')
const { join } = require('node:path')

const REPO = join(__dirname, '..')
const HOST = join(REPO, 'out', 'main', 'rerankHost.js')
const MODELS = join(REPO, 'resources', 'models')
const ROUNDS = 20

const args = process.argv.slice(2)
const TIMING_ONLY = args.includes('--timing-only')
const argValue = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : null
}
const OUT = argValue('--out')
const PASSAGES_FILE = argValue('--passages')

// The shipped rerank budget and pool, READ out of src/main/search/semantic.ts
// at startup: a bare-electron .cjs imports no TS, and a copied literal would
// keep certifying the old numbers after the shipped ones moved — the pass/fail
// below and the bench report's budgetMs are both derived from these. A failed
// extraction is a hard error: this gate times the SHIPPED window, so it
// refuses to guess the numbers it asserts.
const semanticSrc = readFileSync(join(REPO, 'src', 'main', 'search', 'semantic.ts'), 'utf8')
function shippedConst(name) {
  const m = semanticSrc.match(new RegExp(`export const ${name} = ([0-9_]+)`))
  if (!m) {
    console.error(
      `could not read \`export const ${name}\` from src/main/search/semantic.ts — ` +
        'this gate times the shipped constants, not a copy of them'
    )
    process.exit(1)
  }
  return Number(m[1].replaceAll('_', ''))
}
const RERANK_TIMEOUT_MS = shippedConst('RERANK_TIMEOUT_MS')
const POOL = shippedConst('RERANK_POOL')
const TIMED_REQUESTS = 3

app.disableHardwareAcceleration()

const failures = []
const ok = (name, pass, detail) => {
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures.push(name)
}

/** Fork the host and resolve once it reports ready. */
function startHost() {
  const child = utilityProcess.fork(HOST, [], { stdio: 'inherit' })
  const ready = new Promise((resolve, reject) => {
    child.on('message', (m) => {
      const msg = (m && m.data) || m
      if (msg && msg.kind === 'ready') resolve()
    })
    child.once('exit', () => reject(new Error('the host exited before it was ready')))
    setTimeout(() => reject(new Error('the host did not report ready within 60s')), 60_000)
  })
  return { child, ready }
}

let nextId = 1
function score(child, query, passages) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const on = (m) => {
      const msg = (m && m.data) || m
      if (!msg || msg.id !== id) return
      child.off('message', on)
      if (msg.kind === 'scored') resolve(msg.pairs)
      else reject(new Error(`${msg.name}: ${msg.message}`))
    }
    child.on('message', on)
    child.postMessage({ kind: 'score', id, query, passages })
  })
  // The id is captured above so a cancel can name the same request.
}

/**
 * The passages a shipped-window timing runs on, when the caller supplies none.
 * The cost being measured is tokenization + inference, which scale with
 * passage length, so each sits in the length class a chunk of extracted paper
 * text lands in; content is irrelevant — discrimination is checked separately.
 */
function syntheticPool() {
  const fill = 'directed evolution rounds shifted the optimum upward '.repeat(13)
  return Array.from({ length: POOL }, (_, i) => `Passage ${i}: ${fill}`)
}

/** Time `count` warm pool-N requests end to end on an ALREADY-RUNNING host. */
async function timedPool(child, passages, count = TIMED_REQUESTS) {
  const requests = []
  for (let i = 0; i < count; i++) {
    const t0 = Date.now()
    const pairs = await score(child, 'thermostability', passages)
    requests.push(Date.now() - t0)
    if (pairs.length !== passages.length) {
      throw new Error(`timed request answered ${pairs.length} of ${passages.length} pairs`)
    }
  }
  return requests
}

/** Fork a fresh host, warm the session off the clock, then time the pool. */
async function timeHostedPool(passages) {
  const { child, ready } = startHost()
  await ready
  try {
    // The app prewarms at startup and its budget is set from warmed timings,
    // so the session load must not sit inside a timed request here either.
    await score(child, 'warm', ['warm the session', 'with two passages'])
    return await timedPool(child, passages)
  } finally {
    child.kill()
  }
}

/** The embedder, in a worker THREAD of this process. */
function startEmbedder(rounds) {
  const state = { done: 0, error: null }
  const worker = new Worker(
    `
    const { parentPort } = require('node:worker_threads')
    ;(async () => {
      const t = await import('@huggingface/transformers')
      t.env.allowRemoteModels = false
      t.env.allowLocalModels = true
      t.env.localModelPath = ${JSON.stringify(MODELS)}
      const pipe = await t.pipeline('feature-extraction', 'Snowflake/snowflake-arctic-embed-s', {
        dtype: 'q8', local_files_only: true,
        session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 }
      })
      for (let i = 0; i < ${rounds}; i++) {
        await pipe(['a passage about enzyme thermostability'], { pooling: 'cls', normalize: true })
        parentPort.postMessage({ done: i + 1 })
      }
    })().catch((e) => parentPort.postMessage({ error: String((e && e.stack) || e) }))
    `,
    { eval: true }
  )
  worker.on('message', (m) => {
    if (m.done) state.done = m.done
    if (m.error) state.error = m.error
  })
  return { worker, state }
}

/**
 * The OLD shape, in a child process so its abort cannot take this run with it.
 * A non-zero exit (SIGABRT) is the EXPECTED result.
 */
function negativeControl() {
  const src = `
    const { Worker, isMainThread } = require('node:worker_threads')
    const load = async (root, id, kind) => {
      const t = await import('@huggingface/transformers')
      t.env.allowRemoteModels = false; t.env.allowLocalModels = true; t.env.localModelPath = root
      const so = { session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 }, dtype: 'q8', local_files_only: true }
      if (kind === 'embed') {
        const p = await t.pipeline('feature-extraction', id, so)
        for (let i = 0; i < 60; i++) await p(['a passage about enzymes'], { pooling: 'cls', normalize: true })
      } else {
        const tok = await t.AutoTokenizer.from_pretrained(id, { local_files_only: true })
        const m = await t.AutoModelForSequenceClassification.from_pretrained(id, so)
        for (let i = 0; i < 60; i++) {
          await m(tok(['q'], { text_pair: ['p'], padding: true, truncation: true }))
        }
      }
    }
    if (isMainThread) {
      new Worker(__filename)
      load(${JSON.stringify(MODELS)}, 'Snowflake/snowflake-arctic-embed-s', 'embed').catch(() => {})
    } else {
      load(${JSON.stringify(join(REPO, 'resources', 'rerankers'))}, 'cross-encoder/ms-marco-MiniLM-L-6-v2', 'rerank').catch(() => {})
    }
  `
  return new Promise((resolve) => {
    // Written into the repo and run from there, NOT `/tmp`: node resolves
    // `@huggingface/transformers` from the script's own directory, so a control
    // living outside the tree dies with ERR_MODULE_NOT_FOUND — a non-zero exit
    // that looks exactly like the crash and measures nothing. That happened.
    const file = join(REPO, 'tmp', 'rerank-negative-control.cjs')
    mkdirSync(join(REPO, 'tmp'), { recursive: true })
    writeFileSync(file, src)
    // 'ipc' is REQUIRED by electron's fork even though no message is sent:
    // without it the call throws and the whole check hangs on a rejected
    // promise nobody awaited.
    const child = fork(file, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    let stderr = ''
    child.stderr.on('data', (b) => {
      stderr += String(b)
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ crashed: false, why: 'survived the window' })
    }, 180_000)
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      try {
        unlinkSync(file)
      } catch {
        /* the control file is derived; failing to remove it changes nothing */
      }
      // SIGABRT SPECIFICALLY, and the V8 message with it. Any other non-zero
      // exit is the control being broken rather than the crash reproducing —
      // the whole point of this check is that it fails for THIS reason.
      const fatal = /Entering the V8 API without proper locking/.test(stderr)
      resolve({
        crashed: signal === 'SIGABRT' && fatal,
        why: fatal
          ? `signal=${signal}`
          : `exited ${signal ?? `code ${code}`} without the V8 fatal: ${stderr.trim().split('\n')[0] ?? '(no output)'}`
      })
    })
  })
}

app.whenReady().then(async () => {
  if (!existsSync(HOST)) {
    console.error(`the reranker host is not built at ${HOST} — run \`npm run build\` first`)
    app.exit(1)
    return
  }

  const passages = PASSAGES_FILE
    ? JSON.parse(readFileSync(PASSAGES_FILE, 'utf8'))
    : syntheticPool()

  if (TIMING_ONLY) {
    try {
      const requests = await timeHostedPool(passages)
      // poolSize travels with the numbers: a timing summary that names no pool
      // would let a short pool be read as the shipped pool-10 window later,
      // with nothing in the artifact to contradict the reader.
      const summary = {
        poolSize: passages.length,
        requests,
        maxMs: Math.max(...requests),
        budgetMs: RERANK_TIMEOUT_MS
      }
      console.log(
        `shipped-window: pool-${passages.length} x${requests.length} through the real host: ` +
          `${requests.join(' / ')} ms (max ${summary.maxMs}, budget ${RERANK_TIMEOUT_MS} ms)`
      )
      if (OUT) writeFileSync(OUT, JSON.stringify(summary, null, 1))
      app.exit(0)
    } catch (err) {
      console.error(`shipped-window timing failed: ${err.message}`)
      app.exit(1)
    }
    return
  }

  const { child, ready } = startHost()
  const embedder = startEmbedder(ROUNDS)

  try {
    await ready
  } catch (err) {
    ok('coexistence', false, err.message)
    app.exit(1)
    return
  }

  // 1 — coexistence.
  let scored = 0
  let coexistError = null
  try {
    for (let i = 0; i < ROUNDS; i++) {
      const pairs = await score(child, 'what makes an enzyme thermostable', [
        'Directed evolution improved the half-life at 60 C by tenfold.'
      ])
      if (!pairs.length || typeof pairs[0].logit !== 'number') {
        throw new Error(`round ${i} returned no usable score`)
      }
      scored++
    }
  } catch (err) {
    coexistError = err.message
  }
  // Let the worker's rounds overlap the host's rather than following them.
  await new Promise((r) => setTimeout(r, 5_000))
  ok(
    'coexistence',
    scored === ROUNDS && embedder.state.done > 0 && !coexistError && !embedder.state.error,
    `scored ${scored}/${ROUNDS}, embedded ${embedder.state.done}/${ROUNDS}` +
      (coexistError || embedder.state.error ? ` — ${coexistError ?? embedder.state.error}` : '')
  )

  // 2 — discrimination.
  const q = 'what makes an enzyme thermostable'
  const relevant = await score(child, q, [
    'Thermostability of the enzyme was improved by directed evolution: the half-life at 60 C rose tenfold.'
  ])
  const irrelevant = await score(child, q, [
    'The Ottoman fleet withdrew from the Adriatic in the spring of 1538 after a failed siege.'
  ])
  const margin = relevant[0].logit - irrelevant[0].logit
  ok('discrimination', margin > 1, `relevant beats irrelevant by ${margin.toFixed(2)} logits`)

  // 3 — cancel.
  //
  // The batch is SIZED FROM A MEASURED PACE rather than guessed. A fixed 40
  // pairs against a fixed delay is a race with the machine: the batch finished
  // first and the check reported 40/40, which reads as "cancel did nothing"
  // when in truth there was nothing left to cancel. So time one pair, then
  // build a batch long enough that the cancel lands a quarter of the way in.
  await score(child, 'warm', ['warm the session'])
  const PACE_PAIRS = 10
  const paceStart = Date.now()
  await score(
    child,
    'thermostability',
    Array.from({ length: PACE_PAIRS }, (_, i) => `pace passage ${i} about protein stability`)
  )
  const perPair = (Date.now() - paceStart) / PACE_PAIRS
  const CANCEL_AT_MS = 1_000
  // Ten times the cancel point, so the cancel lands early in the batch even if
  // the host speeds up between the measurement and the run.
  const count = Math.max(50, Math.ceil((CANCEL_AT_MS * 10) / Math.max(perPair, 0.5)))
  const many = Array.from({ length: count }, (_, i) => `Passage ${i} about protein stability under heat.`)
  const cancelId = nextId
  const cancelled = new Promise((resolve, reject) => {
    const on = (m) => {
      const msg = (m && m.data) || m
      if (!msg || msg.id !== cancelId) return
      child.off('message', on)
      if (msg.kind === 'scored') resolve(msg.pairs)
      else reject(new Error(msg.message))
    }
    child.on('message', on)
    child.postMessage({ kind: 'score', id: cancelId, query: 'thermostability', passages: many })
    setTimeout(() => child.postMessage({ kind: 'cancel', id: cancelId }), CANCEL_AT_MS)
  })
  nextId++
  const partial = await cancelled
  const after = await score(child, 'thermostability', ['a short passage'])
  ok(
    'cancel',
    partial.length > 0 && partial.length < many.length && after.length === 1,
    `${partial.length}/${many.length} scores kept, host still answering`
  )

  // 5 — shipped window. The retrieval benchmark times scorePairs IN-PROCESS
  // (its electron-as-node host cannot fork this child), so the utilityProcess
  // hop the shipped search always waits inside — the RPC round trip and the
  // host's serialisation queue — is outside that measurement. This times what
  // the app actually waits on: one pool-10 request, warm, posted to scored. A
  // pool that misses the budget loses its rerank in the shipped search
  // (rerank: null, fusion order), whatever the benchmark claimed.
  const hostRequests = await timedPool(child, passages)
  ok(
    'shipped window',
    Math.max(...hostRequests) < RERANK_TIMEOUT_MS,
    `pool-${passages.length} through the real host: ${hostRequests.join(' / ')} ms ` +
      `(budget ${RERANK_TIMEOUT_MS} ms)`
  )

  child.kill()
  await embedder.worker.terminate()

  // 4 — negative control.
  const control = await negativeControl()
  ok(
    'negative control',
    control.crashed,
    control.crashed
      ? `one process with both models still aborts (${control.why})`
      : `the control did not reproduce the crash — ${control.why}`
  )

  console.log(failures.length === 0 ? '\nRESULT: PASS' : `\nRESULT: FAIL (${failures.join(', ')})`)
  app.exit(failures.length === 0 ? 0 : 1)
})
