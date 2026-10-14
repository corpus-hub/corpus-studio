// EXERCISE every shipped payload, rather than merely asserting it is on disk.
//
//   npm run verify:payloads
//   CORPUS_RESOURCES_DIR=release/linux-unpacked/resources/app-resources \
//     npm run verify:payloads          # against a packaged artifact
//
// `verify:resources` proves the files exist with the right bytes. That is not
// the same as proving they WORK: a binary can be present, correctly hashed and
// still fail to execute (wrong libc, lost mode bit), a dylib can be present and
// refuse to load into this build's SQLite, and a model can be present and still
// send transformers.js to the network for a file nobody noticed was missing.
// Every check below therefore runs the payload against real input and asserts
// on the OUTPUT.
//
// It is also the harness that lets wave-2's pipeline stages land already
// proven: whatever `optimize`, `ocr` and `embed` end up looking like, the
// payloads underneath them are exercised here first.
//
// Run this with networking disabled (`unshare -rn npm run verify:payloads`) and
// it must still pass — that is the offline rule, tested rather than asserted.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  modelsDir,
  payloadPreconditions,
  platformKey,
  qpdfPath,
  resourcesRoot,
  sqliteVecPath,
  tessdataDir
} from '../src/main/resources'

let failures = 0
let skips = 0
let checksRun = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  checksRun++
  if (!ok) failures++
}
function skip(label: string, why: string): void {
  console.log(`skip  ${label} — ${why}`)
  skips++
}

const repoRoot = resolve(__dirname, '..')
const tmp = mkdtempSync(join(tmpdir(), 'corpus-payload-verify-'))

// Everything runs inside `main()` rather than at the top level: these scripts
// are transformed to CJS by tsx, where top-level await is not available.
async function main(): Promise<void> {
console.log(`resources root: ${resourcesRoot()}`)
console.log(`platform key:   ${platformKey()}\n`)

// ----------------------------------------------------- required-payload gate
// Ahead of the individual exercises, because "was this build supposed to carry
// it" is a different question from "does it work", and only the first can be
// answered at all when the file is absent. Previously a missing qpdf produced a
// `skip` here and the suite still reported success — so the one condition that
// later reached the user once per paper was the condition this gate waved
// through.
console.log('--- required payloads for this platform ---')
for (const p of payloadPreconditions()) {
  if (p.present) check(`${p.id} is present`, true, p.path)
  else if (p.required)
    check(`${p.id} is present`, false, `REQUIRED on ${platformKey()} — run \`npm run payloads\``)
  else skip(p.id, p.unavailableReason ?? `not required on ${platformKey()}`)
}
console.log('')

// ------------------------------------------------------------------ qpdf
console.log('--- qpdf (optimize stage) ---')
if (!existsSync(qpdfPath())) {
  skip('qpdf', `not provisioned for ${platformKey()} — the optimize stage reports skipped`)
} else {
  const version = execFileSync(qpdfPath(), ['--version'], { encoding: 'utf8' }).trim()
  check('qpdf executes', /^qpdf version /.test(version), version.split('\n')[0])

  // crypto=native is the reason this binary is 4 MB and not a bundled TLS
  // stack. If a rebuild ever links gnutls/openssl instead, this catches it.
  const crypto = execFileSync(qpdfPath(), ['--show-crypto'], { encoding: 'utf8' }).trim()
  check('qpdf uses its native crypto provider (no bundled TLS stack)',
    crypto.split('\n')[0].trim() === 'native', crypto.replace(/\n/g, ' '))

  // A real PDF, not a synthetic one: the 14.8% saving and the geometry-
  // preservation result that justified this stage were measured on these files.
  const candidates = [
    join(repoRoot, 'e2e', 'fixtures'),
    '/media/varingait/Lobotomite/Repository/Repository/KE07-corpus'
  ]
  let samplePdf = ''
  for (const dir of candidates) {
    if (!existsSync(dir)) continue
    const pdf = readdirSync(dir).find((f) => f.toLowerCase().endsWith('.pdf'))
    if (pdf) {
      samplePdf = join(dir, pdf)
      break
    }
  }
  if (!samplePdf) {
    // Never silently pass: a missing input means this check did not run.
    skip('qpdf optimizes a real PDF', 'no sample PDF found on this machine')
  } else {
    const out = join(tmp, 'optimized.pdf')
    execFileSync(qpdfPath(), [
      '--object-streams=generate',
      '--recompress-flate',
      '--compression-level=9',
      '--optimize-images',
      '--remove-unreferenced-resources=yes',
      samplePdf,
      out
    ])
    const before = statSync(samplePdf).size
    const after = statSync(out).size
    check('qpdf produces a readable optimized PDF', existsSync(out) && after > 0,
      `${(before / 1024).toFixed(0)} KiB → ${(after / 1024).toFixed(0)} KiB ` +
        `(${(((before - after) / before) * 100).toFixed(1)}% saved)`)
    // Page count must survive: every stored evidence anchor is page-scoped, so
    // an optimizer that re-paginated would silently invalidate the whole graph.
    const pagesBefore = execFileSync(qpdfPath(), ['--show-npages', samplePdf], { encoding: 'utf8' }).trim()
    const pagesAfter = execFileSync(qpdfPath(), ['--show-npages', out], { encoding: 'utf8' }).trim()
    check('page count is unchanged by optimization', pagesBefore === pagesAfter,
      `${pagesBefore} → ${pagesAfter}`)
  }
}

// ------------------------------------------------------------ sqlite-vec
console.log('\n--- sqlite-vec (vector search) ---')
// Required on EVERY platform (`REQUIRED_ON` in resources.ts), so absence is a
// FAILURE rather than a skip: there is no supported host on which the app is
// allowed to open a corpus without it.
if (!existsSync(sqliteVecPath())) {
  check(
    'sqlite-vec is provisioned for this platform',
    false,
    `no extension at ${sqliteVecPath()} for ${platformKey()} — run \`npm run payloads\``
  )
} else {
  const Database = (await import('better-sqlite3')).default
  const db = new Database(':memory:')
  try {
    db.loadExtension(sqliteVecPath())
    const { v } = db.prepare('select vec_version() as v').get() as { v: string }
    check('vec0 loads into this build of better-sqlite3', typeof v === 'string', `vec_version ${v}`)

    // vec0 INTEGER columns reject plain JS numbers — better-sqlite3 binds them
    // as SQLITE_FLOAT. safeIntegers + BigInt is mandatory, and proving it here
    // means wave-2 does not rediscover it.
    db.exec('create virtual table v using vec0(work_id integer primary key, embedding float[4])')
    const ins = db.prepare('insert into v(work_id, embedding) values (?, ?)')
    ins.safeIntegers(true)
    const vectors: Array<[bigint, number[]]> = [
      [1n, [1, 0, 0, 0]],
      [2n, [0, 1, 0, 0]],
      [3n, [0.9, 0.1, 0, 0]]
    ]
    for (const [id, vec] of vectors) ins.run(id, Buffer.from(new Float32Array(vec).buffer))
    const q = db.prepare(
      'select work_id, distance from v where embedding match ? and k = 2 order by distance'
    )
    q.safeIntegers(true)
    const rows = q.all(Buffer.from(new Float32Array([1, 0, 0, 0]).buffer)) as Array<{
      work_id: bigint
      distance: number
    }>
    check('a k-NN query returns the nearest vectors in order',
      rows.length === 2 && rows[0].work_id === 1n && rows[1].work_id === 3n,
      rows.map((r) => `${r.work_id}@${r.distance.toFixed(3)}`).join(' '))
  } catch (err) {
    check('sqlite-vec loads and queries', false, (err as Error).message)
  } finally {
    db.close()
  }
}

// ------------------------------------------------------- embedding model
console.log('\n--- embedding model (arctic-embed-s int8) ---')
const modelDir = join(modelsDir(), 'Snowflake', 'snowflake-arctic-embed-s')
if (!existsSync(join(modelDir, 'onnx', 'model_quantized.onnx'))) {
  skip('embedding model', 'not provisioned — semantic search must disclose the fallback')
} else {
  const t = await import('@huggingface/transformers')
  // The three settings that keep this offline. allowRemoteModels=false turns
  // any missing file into a hard error naming the path, instead of a silent
  // fetch from huggingface.co on a user's machine.
  t.env.allowRemoteModels = false
  t.env.allowLocalModels = true
  t.env.localModelPath = modelsDir()

  const extractor = await t.pipeline('feature-extraction', 'Snowflake/snowflake-arctic-embed-s', {
    dtype: 'q8',
    local_files_only: true
  })
  // A real paragraph from the seed domain, not "hello world": a tokenizer that
  // silently truncated or a pooling mistake shows up as a degenerate vector.
  const paragraph =
    'The designed Kemp eliminase HG3.17 achieves a kcat of 700 per second, a ' +
    '400-fold improvement over the parent enzyme HG3, largely through mutations ' +
    'distal to the active site that rigidify the catalytic conformation.'
  const out = await extractor(paragraph, { pooling: 'cls', normalize: true })
  const vec = Array.from(out.data as Float32Array)
  check('the model embeds a real paragraph', vec.length === 384, `${vec.length} dims`)
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0))
  check('the embedding is L2-normalised', Math.abs(norm - 1) < 1e-3, `‖v‖ = ${norm.toFixed(6)}`)
  check('the embedding is not degenerate', new Set(vec.map((x) => x.toFixed(4))).size > 100,
    `${new Set(vec.map((x) => x.toFixed(4))).size} distinct components`)

  // Semantics, not just shape: a related sentence must sit closer than an
  // unrelated one. This is what actually distinguishes a working model from a
  // model that loaded and emitted noise.
  const cos = (a: number[], b: number[]): number => a.reduce((s, x, i) => s + x * b[i], 0)
  const related = Array.from(
    (await extractor('enzyme catalytic rate enhancement from remote mutations', {
      pooling: 'cls',
      normalize: true
    })).data as Float32Array
  )
  const unrelated = Array.from(
    (await extractor('municipal parking regulations and permit fees', {
      pooling: 'cls',
      normalize: true
    })).data as Float32Array
  )
  const simRelated = cos(vec, related)
  const simUnrelated = cos(vec, unrelated)
  check('a related query scores above an unrelated one', simRelated > simUnrelated,
    `related ${simRelated.toFixed(3)} > unrelated ${simUnrelated.toFixed(3)}`)
}

// ------------------------------------------------------------- tesseract
console.log('\n--- tesseract (ocr stage) ---')
const traineddata = join(tessdataDir(), 'eng.traineddata')
if (!existsSync(traineddata)) {
  skip('tesseract eng.traineddata', 'not provisioned — the ocr stage reports skipped')
} else {
  check('eng.traineddata is present and non-trivial', statSync(traineddata).size > 1_000_000,
    `${(statSync(traineddata).size / 1024 / 1024).toFixed(1)} MB`)

  const { createWorker } = await import('tesseract.js')
  // langPath is the whole offline story: unset, tesseract.js defaults it to a
  // cdn.jsdelivr.net URL and downloads eng.traineddata on first use. cacheMethod
  // 'none' additionally stops it writing a copy next to the process cwd.
  const worker = await createWorker('eng', 1, {
    langPath: tessdataDir(),
    cachePath: tessdataDir(),
    cacheMethod: 'none',
    gzip: false,
    logger: () => {}
  })
  try {
    // Render a known string to a PNG and read it back, so the assertion is on
    // recognised TEXT rather than on the worker merely starting.
    const png = join(tmp, 'ocr-input.png')
    let havePng = false
    try {
      execFileSync('convert', [
        '-size', '900x160', 'xc:white', '-gravity', 'center',
        '-pointsize', '52', '-fill', 'black',
        '-annotate', '0', 'Kemp eliminase HG3',
        png
      ], { stdio: 'ignore' })
      havePng = true
    } catch {
      havePng = false
    }
    if (!havePng) {
      skip('tesseract recognises rendered text', 'ImageMagick `convert` is not installed')
    } else {
      const { data } = await worker.recognize(png)
      const text = data.text.trim()
      check('tesseract recognises rendered text from the local traineddata',
        /kemp/i.test(text) && /hg3/i.test(text), JSON.stringify(text.slice(0, 60)))
    }
  } finally {
    await worker.terminate()
  }
  // The worker must not have written a traineddata copy into the cwd — that is
  // the tell-tale of a CDN download having happened.
  check('no traineddata was downloaded into the working directory',
    !existsSync(join(process.cwd(), 'eng.traineddata')))
}

}

main()
  .then(() => {
    rmSync(tmp, { recursive: true, force: true })
    // "Everything was skipped" is not a pass. Reaching here with no check
    // executed means no payload was provisioned at all — a forgotten
    // `npm run payloads` or a mistyped CORPUS_RESOURCES_DIR — and reporting
    // success would let exactly that ship.
    if (checksRun === 0) {
      console.log(
        `\nNOTHING WAS VERIFIED — no payload is present for ${platformKey()} under ` +
          `${resourcesRoot()}. Run \`npm run payloads\` first.`
      )
      process.exit(1)
    }
    console.log(
      `\n${failures === 0 ? 'ALL PAYLOAD CHECKS PASSED' : `${failures} CHECK(S) FAILED`}` +
        ` · ${checksRun} check(s) run` +
        `${skips > 0 ? ` · ${skips} skipped (payload not provisioned here)` : ''}`
    )
    process.exit(failures === 0 ? 0 : 1)
  })
  .catch((err) => {
    rmSync(tmp, { recursive: true, force: true })
    // A throw here means a payload could not be exercised at all, which is a
    // failure of the thing being verified — never a reason to exit 0.
    console.error(`\nFAIL  payload verification threw: ${(err as Error).stack}`)
    process.exit(1)
  })
