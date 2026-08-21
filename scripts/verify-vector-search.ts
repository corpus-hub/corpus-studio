// `npm run verify:vector` — sqlite-vec is REQUIRED, and the diagnostic that
// says which search path ran must tell the truth.
//
//   npm run verify:vector
//   CORPUS_RESOURCES_DIR=release/linux-unpacked/resources/app-resources npm run verify:vector
//
// Two silent failures are guarded here, and they are different failures.
//
// The FIRST is the extension not loading and something carrying on anyway. A
// corpus embedded without a `vec0` row looks indexed and is not; a
// `PRAGMA integrity_check` run without the module condemns a healthy file; a
// search with no index returns the same rows arbitrarily slowly. Each surfaces
// far from its cause, so `loadSqliteVec` throws — and this gate proves it
// throws, with an actionable message, by pointing a real host at a resources
// tree that does not contain it.
//
// The SECOND is a diagnostic that LIES about which path ran. A scoped search
// scans every vector in scope ON PURPOSE: the `vec0` index ranks the whole
// space and the work filter is applied to its answer, so a single paper's best
// passages can sit outside the library-wide top-N and be discarded. That scan
// is the accurate answer, not a shortfall — and reporting it as a missing
// dependency cost real debugging time once already. So the two paths are both
// exercised against a real corpus and the reported `strategy` is asserted, plus
// a negative control proving the index really would drop the rows the scan
// keeps.
//
// It runs under `ELECTRON_RUN_AS_NODE` because better-sqlite3 is built for the
// Electron ABI, and it spawns the probe under BOTH hosts because the two
// resolve `process.resourcesPath` differently and only one of them is the app.
//
// `npm run build` must have run: a worker thread does not inherit its parent's
// module loader, so the vector worker is only startable from `out/main`.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { closeDatabase, initDatabase, openDatabase } from '../src/main/db/connection'
import { holdsWriteLock } from '../src/main/db/lock'
import { SqliteVecUnavailableError } from '../src/main/db/sqliteVec'
import { platformKey, sqliteVecPath } from '../src/main/resources'
import { ensureActiveSpace, ensureVecTable, resolveEmbeddingIdentity } from '../src/main/embedding/space'
import { insertChunks, unindexedChunks, type ChunkRecord } from '../src/main/embedding/vectors'
import { embedTexts, disposeExtractor } from '../src/main/embedding/model'
import { VectorSearch } from '../src/main/search/vectorSearch'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const repo = resolve(__dirname, '..')
const probe = join(repo, 'scripts', 'probe-sqlite-vec.cjs')
const tmp = mkdtempSync(join(tmpdir(), 'corpus-vector-verify-'))

interface ProbeResult {
  ok: boolean
  host?: string
  path?: string
  vecVersion?: string
  vec0Table?: boolean
  errorName?: string
  error?: string
  status: number
  raw: string
}

/**
 * Run the loader probe in a REAL host process.
 *
 * `runAsNode` picks which of the two: the CLI scripts run under
 * `ELECTRON_RUN_AS_NODE=1`, where there is no `app` object, while the shipped
 * application does not. They resolve the extension by different paths, so a
 * gate that only ever tested one of them proves nothing about the other.
 */
function runProbe(runAsNode: boolean, env: Record<string, string> = {}): ProbeResult {
  const child = spawnSync(join(repo, 'node_modules', 'electron', 'dist', 'electron'), [probe], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...(runAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : { ELECTRON_RUN_AS_NODE: '' }),
      ...env
    }
  })
  const raw = `${child.stdout ?? ''}`.trim()
  const line = raw.split('\n').filter((l) => l.startsWith('{')).pop() ?? ''
  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(line) as Record<string, unknown>
  } catch {
    /* left empty; `ok` stays false and `raw` carries the evidence */
  }
  return { ...(parsed as unknown as ProbeResult), status: child.status ?? -1, raw: raw || `${child.stderr ?? ''}`.trim() }
}

async function main(): Promise<void> {
console.log(`platform key: ${platformKey()}`)
console.log(`extension:    ${sqliteVecPath()}\n`)

// ------------------------------------------------ the extension loads, per host
console.log('--- sqlite-vec loads in every host that opens a corpus ---')
for (const runAsNode of [true, false]) {
  const host = runAsNode ? 'electron-as-node (seed/verify/repair)' : 'the Electron app'
  const r = runProbe(runAsNode)
  check(`${host} loads sqlite-vec`, r.ok === true, r.ok ? `${r.path} → ${r.vecVersion}` : r.raw)
  check(`${host} can create a vec0 virtual table`, r.vec0Table === true,
    // `vec_version()` is a scalar function and resolves from a partially
    // registered extension. The virtual-table module is what an embedding space
    // actually needs, so it is asked for separately.
    r.vec0Table === true ? '' : (r.error ?? r.raw))
}

// ---------------------------------------------- and REFUSES when it is absent
console.log('\n--- an absent or unusable extension stops, and says what to do ---')
{
  // A resources tree with no `lib/` at all: exactly the shape of a build that
  // was never provisioned, produced here rather than by moving the real one
  // aside — a gate must never be able to damage the checkout it is verifying.
  const bare = join(tmp, 'resources-empty')
  mkdirSync(bare, { recursive: true })
  for (const runAsNode of [true, false]) {
    const host = runAsNode ? 'electron-as-node' : 'the Electron app'
    const r = runProbe(runAsNode, { CORPUS_RESOURCES_DIR: bare })
    check(`${host} REFUSES to continue without sqlite-vec`, r.ok === false && r.status !== 0,
      `exit ${r.status}`)
    check(`${host} raises SqliteVecUnavailableError`, r.errorName === 'SqliteVecUnavailableError',
      r.errorName ?? r.raw)
    const msg = r.error ?? ''
    check(`${host}'s message names the file it looked for`, msg.includes(bare), msg.slice(0, 120))
    // An error the reader cannot act on is a stop with extra steps. The remedy
    // differs between a checkout and an installer, so either sentence counts.
    check(`${host}'s message states a remedy`,
      /npm run payloads|Reinstall Corpus Studio/.test(msg), msg.slice(0, 160))
  }

  // The OTHER failure: present but unloadable. It has a different fix — the
  // file is there, so `npm run payloads` will not replace it; it is the wrong
  // build for this ABI — and a loader that reported both as "missing" would
  // send the reader to re-download a file they already have.
  const wrong = join(tmp, 'resources-wrong-abi')
  mkdirSync(join(wrong, 'lib', platformKey()), { recursive: true })
  writeFileSync(join(wrong, 'lib', platformKey(), sqliteVecPath().split('/').pop() as string),
    'not an ELF shared object')
  const r = runProbe(true, { CORPUS_RESOURCES_DIR: wrong })
  check('a PRESENT but unloadable extension is refused too', r.ok === false && r.status !== 0,
    `exit ${r.status}`)
  check('and is distinguished from an absent one', /would not load|different ABI/.test(r.error ?? ''),
    (r.error ?? r.raw).slice(0, 160))
}

// ------------------------------------------- openDatabase itself cannot degrade
console.log('\n--- openDatabase refuses, and leaves no lock behind ---')
{
  const dbPath = join(tmp, 'refuse.sqlite')
  const bare = join(tmp, 'resources-empty')
  const saved = process.env.CORPUS_RESOURCES_DIR
  process.env.CORPUS_RESOURCES_DIR = bare
  let thrown: unknown = null
  try {
    const db = openDatabase(dbPath, { label: 'verify:vector' })
    closeDatabase(db)
  } catch (err) {
    thrown = err
  }
  if (saved === undefined) delete process.env.CORPUS_RESOURCES_DIR
  else process.env.CORPUS_RESOURCES_DIR = saved

  check('openDatabase throws rather than opening a handle that cannot read a vec table',
    thrown instanceof SqliteVecUnavailableError, thrown ? String((thrown as Error).name) : 'nothing thrown')
  // A refused open that kept the single-writer lock would lock the user out of
  // their own corpus until the process died — a provisioning fault escalated
  // into a data-access one.
  //
  // Asked of the LOCK, not by reopening. `acquireWriteLock` is re-entrant per
  // process (a second call for the same path bumps a refcount), so a successful
  // reopen is exactly what a leaked in-process lock also produces — the one
  // failure this check exists to catch is the one it could not see.
  check('the refused open released the write lock', holdsWriteLock(dbPath) === false)
}

// ----------------------------------------------------------- a real corpus
console.log('\n--- a corpus, embedded and indexed ---')
const identity = resolveEmbeddingIdentity()
if (!identity) {
  check('an embedding model is packaged', false, 'no model under resources/models — run `npm run payloads`')
  finish()
  return
}

const corpusPath = join(tmp, 'corpus.sqlite')
// Through `initDatabase`, not a hand-assembled connection: it is the open the
// app itself performs, so the extension load, the pragmas, the SQL registrars,
// the single-writer lock and the migrations are exercised in the same order and
// by the same code a user's corpus gets. A fixture built by hand can pass while
// the real path is broken.
const db = initDatabase(corpusPath, { label: 'verify:vector' })

const now = '2026-01-01T00:00:00Z'
const space = ensureActiveSpace(db, identity, now)
ensureVecTable(db, space)
check('the space has a vec0 index', Boolean(
  db.prepare(`SELECT name FROM sqlite_master WHERE name = ?`).get(space.vecTable)
), `${space.vecTable} @ ${space.dims} dims`)

/**
 * How many chunks the two DISTRACTOR papers carry between them.
 *
 * Sized above the worker's over-fetch window — `min(k * 20, 1000)` for a scoped
 * query — because that window is the whole reason the exhaustive scan exists.
 * Under it, the index would return every vector in the corpus, the work filter
 * would keep the scoped paper's rows, and a control built on a smaller fixture
 * would be proving a property of the `k` it chose rather than of the index.
 * With the distractors alone filling the window, the scoped paper is genuinely
 * unreachable through it.
 */
const DISTRACTOR_CHUNKS = 140

/** The `k` every search below asks for — a reading budget, as the app uses it. */
const SEARCH_K = 5

/**
 * The window a SCOPED index query would actually see: `min(k * 20, 1000)`, the
 * worker's over-fetch. Read from the same arithmetic rather than picked, so the
 * control below cannot accidentally prove a property of a convenient number.
 */
const SCOPED_FETCH_K = Math.min(SEARCH_K * 20, 1000)

/** A question the two enzyme papers answer and the third does not. */
const QUERY = 'how much did the enzyme rate improve'

/**
 * Three papers, each on its own subject, with the SCOPED one written so that
 * nothing in it is the library's best answer to the query below. That is what
 * makes the negative control real rather than a coincidence of ordering.
 *
 * The two distractors are padded to `DISTRACTOR_CHUNKS` with sentences drawn
 * from their own subject, so the padding competes for the query on merit rather
 * than being filler the ranker would put last anyway.
 */
const papers: Array<{ title: string; paragraphs: string[] }> = [
  {
    title: 'Directed evolution of a Kemp eliminase',
    paragraphs: [
      'The designed Kemp eliminase HG3.17 achieves a kcat of 700 per second, a 400-fold improvement over the parent enzyme HG3.',
      'Mutations distal to the active site rigidify the catalytic conformation and account for most of the rate enhancement.',
      'Rounds of directed evolution were screened by a fluorogenic assay at pH 7.0 and 25 degrees Celsius.'
    ]
  },
  {
    title: 'Thermostability engineering of a lipase',
    paragraphs: [
      'Consensus design raised the melting temperature of the lipase by eleven degrees without loss of specific activity.',
      'The stabilised variant retained ninety percent of its activity after two hours at sixty degrees Celsius.',
      'Molecular dynamics attributes the gain to a rigidified surface loop rather than to core repacking.'
    ]
  },
  {
    title: 'Municipal parking regulation and permit administration',
    paragraphs: [
      'Residential permit zones were introduced in 1994 and now cover two thirds of the inner districts.',
      'Enforcement patrols issue on average four hundred citations per week across the metropolitan area.',
      'Permit fees are indexed to the consumer price index and reviewed every third fiscal year.'
    ]
  }
]

// Pad the two distractors, alternating so neither dominates, until between them
// they can fill the over-fetch window on their own.
for (let i = 0; papers[0].paragraphs.length + papers[1].paragraphs.length < DISTRACTOR_CHUNKS; i++) {
  const target = papers[i % 2]
  target.paragraphs.push(
    i % 2 === 0
      ? `Variant ${i} of the eliminase raised kcat by a further ${10 + i} percent, measured as an enzyme rate improvement under the same assay conditions.`
      : `Round ${i} of lipase stabilisation improved the catalytic rate of the enzyme by ${5 + i} percent while holding the melting temperature.`
  )
}

const workIds: number[] = []
let chunkTotal = 0
/** The parking paper: nothing in it is among the library's best answers. */
let SCOPED_WORK = 0
for (const paper of papers) {
  const workId = Number(
    db.prepare(
      `INSERT INTO work (title, work_type, publication_year, created_at, updated_at)
       VALUES (?, 'journal-article', 2024, ?, ?)`
    ).run(paper.title, now, now).lastInsertRowid
  )
  workIds.push(workId)
  const documentId = Number(
    db.prepare(
      `INSERT INTO document (work_id, version_kind, content_status, created_at)
       VALUES (?, 'publisher-PDF', 'fulltext', ?)`
    ).run(workId, now).lastInsertRowid
  )
  const stageRunId = Number(
    db.prepare(
      `INSERT INTO stage_run (stage, stage_version, work_id, document_id, status, input_fingerprint, created_at)
       VALUES ('embed', 'v1', ?, ?, 'succeeded', ?, ?)`
    ).run(workId, documentId, `fp-${workId}`, now).lastInsertRowid
  )

  const { vectors, truncated } = await embedTexts(identity, paper.paragraphs, 'document')
  // `null` is the QUERY side's answer and this is the document side, so it is a
  // contradiction rather than a case to handle. Thrown rather than defaulted to
  // `false`: the fixture would otherwise record that every chunk fitted the
  // model when nothing measured it, which is exactly the claim this verifier
  // exists to keep honest.
  if (truncated === null) {
    throw new Error('embedTexts returned no truncation measurement for a document batch')
  }
  const chunks: ChunkRecord[] = paper.paragraphs.map((text, i) => ({
    idx: i,
    paraIds: [`p${i}`],
    charStart: 0,
    charEnd: text.length,
    page: 1,
    section: 'body',
    text,
    tokenEstimate: Math.ceil(text.length / 4),
    truncated: truncated[i],
    lowConfidence: false,
    inputHash: `h-${workId}-${i}`,
    vector: vectors[i]
  }))
  db.transaction(() => insertChunks(db, space, { stageRunId, documentId, workId }, chunks, now))()
  chunkTotal += chunks.length
}
SCOPED_WORK = workIds[2]
await disposeExtractor()

// The vec0 table is a derived index over `chunk.vector`, written in the same
// transaction. A count that has drifted means chunks exist that no k-NN can
// reach — a corpus that reports itself embedded while part of it is invisible.
const chunkRows = (db.prepare('SELECT COUNT(*) AS c FROM chunk').get() as { c: number }).c
const vecRows = (db.prepare(`SELECT COUNT(*) AS c FROM ${space.vecTable}`).get() as { c: number }).c
check('every chunk has a vec0 row', vecRows === chunkRows && chunkRows === chunkTotal,
  `${chunkRows} chunks, ${vecRows} indexed`)
// The fixture has to be big enough for the index to be able to lose a paper at
// all. Below the over-fetch window every vector comes back and the scoped
// filter keeps everything, so a smaller corpus would make the negative control
// below unfalsifiable — the same shape as a check that compares 0 to 0.
check('the corpus is larger than the over-fetch window it must defeat',
  chunkTotal > SCOPED_FETCH_K, `${chunkTotal} chunk(s) vs a window of ${SCOPED_FETCH_K}`)
check('integrity_check passes with the module loaded',
  (db.pragma('integrity_check', { simple: true }) as string) === 'ok')
check('nothing reports chunks the index cannot reach', unindexedChunks(db).length === 0,
  unindexedChunks(db).map((s) => `${s.vecTable}: ${s.indexed}/${s.chunks}`).join(', '))
{
  // NEGATIVE CONTROL for the detector itself. It reports "all indexed" about a
  // healthy corpus and about a corpus it is simply blind to, and only one of
  // those is worth having — so a row is removed from the index on purpose, in a
  // COPY, and the detector must see it.
  const probePath = join(tmp, 'unindexed-probe.sqlite')
  db.prepare('VACUUM INTO ?').run(probePath)
  const probeDb = initDatabase(probePath, { label: 'verify:vector probe' })
  const victim = (probeDb.prepare(`SELECT chunk_id FROM ${space.vecTable} LIMIT 1`).get() as {
    chunk_id: number
  }).chunk_id
  probeDb.prepare(`DELETE FROM ${space.vecTable} WHERE chunk_id = ?`).run(victim)
  const seen = unindexedChunks(probeDb)
  check('NEGATIVE CONTROL: a chunk whose vector is missing IS reported',
    seen.length === 1 && seen[0].chunks - seen[0].indexed === 1,
    seen.map((s) => `${s.vecTable}: ${s.indexed}/${s.chunks}`).join(', ') || 'nothing reported')
  closeDatabase(probeDb)
}

// ------------------------------------- the NEGATIVE CONTROL for `exhaustive`
// Without this, "a scoped search scans" is an unfalsifiable preference. The scan
// exists because vec0 ranks the WHOLE space and the work filter is applied to
// its answer, so a narrow scope's rows can be discarded before the filter ever
// sees them. Reproduced here through the SAME window the worker would use — the
// over-fetch `k`, not a number chosen to make the point — and the scoped
// paper's chunks must be absent from it.
{
  const { vectors } = await embedTexts(identity, [QUERY], 'query')
  await disposeExtractor()
  const qv = new Float32Array(vectors[0].buffer, vectors[0].byteOffset, vectors[0].length / 4)
  const stmt = db.prepare(
    `SELECT chunk_id FROM ${space.vecTable} WHERE v MATCH ? AND k = ? ORDER BY distance`
  )
  stmt.safeIntegers(true)
  const top = (stmt.all(
    Buffer.from(qv.buffer, qv.byteOffset, space.dims * 4),
    BigInt(SCOPED_FETCH_K)
  ) as Array<{ chunk_id: bigint }>).map((r) => Number(r.chunk_id))
  const kept = (db.prepare(
    `SELECT work_id FROM chunk WHERE id IN (${top.map(() => '?').join(',')}) AND work_id = ?`
  ).all(...top, SCOPED_WORK) as Array<{ work_id: number }>).length
  check('NEGATIVE CONTROL: the index over-fetch really does drop the scoped paper entirely',
    kept === 0,
    `${top.length} row window, ${kept} of them from work ${SCOPED_WORK}`)
  check('and the window really was the binding constraint', top.length === SCOPED_FETCH_K,
    `${top.length} of ${chunkTotal} chunk(s) returned`)
}
closeDatabase(db)

// ------------------------------------------ the reported strategy is the truth
console.log('\n--- the strategy reports which path actually ran ---')
if (!existsSync(join(repo, 'out', 'main', 'vectorWorker.js'))) {
  check('the vector worker was built', false, 'run `npm run build` first')
  finish()
  return
}
{
  const search = new VectorSearch(corpusPath)
  try {
    const whole = await search.query(QUERY, SEARCH_K)
    check('a whole-corpus search reports `index`', whole.strategy === 'index', whole.strategy)
    check('and it actually returned hits', whole.hits.length > 0, `${whole.hits.length} hit(s)`)
    // The other half of "the index answered": on this corpus its top hits are
    // the enzyme papers, so a whole-corpus search that came back with the
    // parking paper would be reporting `index` over a ranking nobody produced.
    check('and they are the papers the query is about',
      whole.hits.every((h) => h.workId !== SCOPED_WORK),
      `work(s) ${[...new Set(whole.hits.map((h) => h.workId))].join(', ')}`)

    const scoped = await search.query(QUERY, SEARCH_K, [SCOPED_WORK])
    check('a scoped search reports `exhaustive`', scoped.strategy === 'exhaustive', scoped.strategy)
    // The reason the scan exists, stated as a result rather than as a comment:
    // the paper the index's window dropped answers, because every one of its
    // vectors was scored.
    check('and the scan finds the passages the index discarded',
      scoped.hits.length > 0 && scoped.hits.every((h) => h.workId === SCOPED_WORK),
      `${scoped.hits.length} hit(s), all from work ${SCOPED_WORK}`)
  } catch (err) {
    check('the vector worker answered', false, String(err))
  } finally {
    await search.shutdown()
  }
}

// A worker that came up without the extension would answer every search by
// scanning the whole corpus. It must die instead, and the failure must reach
// the caller as a sentence naming the extension rather than as an empty list —
// an empty result reads as "the corpus holds nothing on this".
{
  const bare = join(tmp, 'resources-empty')
  const saved = process.env.CORPUS_RESOURCES_DIR
  process.env.CORPUS_RESOURCES_DIR = bare
  const search = new VectorSearch(corpusPath)
  let message = ''
  try {
    await search.query(QUERY, SEARCH_K)
  } catch (err) {
    message = String((err as Error).message)
  } finally {
    await search.shutdown()
    if (saved === undefined) delete process.env.CORPUS_RESOURCES_DIR
    else process.env.CORPUS_RESOURCES_DIR = saved
  }
  check('a worker with no sqlite-vec fails the query instead of scanning',
    message.includes('sqlite-vec'), message.slice(0, 160) || 'the query SUCCEEDED')
}

// ------------------------------------------------------- the packaged build
console.log('\n--- the installer carries it ---')
{
  const yml = readFileSync(join(repo, 'electron-builder.yml'), 'utf8')
  // The `resources/` filter excludes the whole `lib/` tree and then each
  // PLATFORM BLOCK re-includes its own target's directory. Drop a re-include
  // and that platform's installer ships without the extension while every dev
  // checkout still works — a regression invisible until someone runs the
  // artifact.
  //
  // ONE RULE PER PLATFORM, spelled out, and this used to assert the single
  // `lib/${platform}-${arch}/**` that replaced them. That form is WRONG for a
  // cross-build: `${platform}` expands to `process.platform`, the HOST, so a
  // Windows installer built on Linux carried `lib/linux-x64` and no DLL. The
  // exclusion widened from `!lib/*` to `!lib/**` at the same time. Both
  // assertions therefore demanded the shape whose removal was the fix — they
  // failed against a correct config, which is the worst way for a gate to be
  // wrong.
  check('electron-builder excludes the whole lib tree by default',
    /^\s*-\s*'!lib\/\*\*'\s*$/m.test(yml))
  for (const platform of ['linux', 'win32', 'darwin']) {
    check(`electron-builder re-includes lib/${platform}-\${arch} for its own target`,
      new RegExp(`^\\s*-\\s*'lib/${platform}-\\$\\{arch\\}/\\*\\*'\\s*$`, 'm').test(yml))
  }
  // The macro that must NOT come back. `${arch}` is resolved per target and is
  // fine; `${platform}` is the host and silently ships the wrong binaries.
  check('no lib rule expands ${platform}, which resolves to the build HOST',
    !/^\s*-\s*'!?lib\/\$\{platform\}/m.test(yml))

  const unpacked = join(repo, 'release', 'linux-unpacked', 'resources', 'app-resources')
  if (existsSync(unpacked)) {
    // The artifact itself, resolved through the SAME code the app uses. This is
    // the only check here that could catch a filter that matched in the yml and
    // produced nothing on disk.
    const r = runProbe(true, { CORPUS_RESOURCES_DIR: unpacked })
    check('the packaged resources tree loads sqlite-vec', r.ok === true,
      r.ok ? `${r.path} → ${r.vecVersion}` : r.raw)
  } else {
    console.log(`note  no unpacked build at ${unpacked} — run \`npm run package\` to check the artifact`)
  }
}

finish()
}

function finish(): void {
  rmSync(tmp, { recursive: true, force: true })
  console.log(failures === 0 ? '\nALL VECTOR-SEARCH CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  rmSync(tmp, { recursive: true, force: true })
  process.exit(1)
})
