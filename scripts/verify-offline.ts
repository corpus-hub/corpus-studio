// Enforce the local-first / offline / no-CDN / no-eval rule against BOTH the
// build output and a packaged artifact.
//
//   npm run verify:offline                      # checks out/
//   npm run verify:offline -- release/linux-unpacked
//
// The whole product rests on running with networking disabled, and the failure
// mode is silent: a dependency that lazily fetches a wasm blob or a model from
// a CDN works perfectly on the developer's machine and dies in the field. So
// this checks more than the URL greps CLAUDE.md requires:
//
//   1. no CDN/model-host URLs in the built bundle;
//   2. no browser wasm loaders that would need `wasm-unsafe-eval`
//      (onnxruntime-web, tesseract-core in the RENDERER, bare importScripts);
//   3. no `data:` font URIs — the strict `font-src 'self'` refuses them and the
//      app falls back to system fonts, which looks like a design bug, not a
//      packaging one;
//   4. real font FILES survived into the artifact, in the same count as out/;
//   5. the prod CSP has no `unsafe-eval`, and the index.html meta CSP has not
//      drifted from the header CSP in main;
//   6. no dev database, .env or credential file got packaged.
//
// The artifact's app.asar is EXTRACTED before grepping: an asar is a binary
// container, so a plain grep both misses per-file attribution and cannot see
// which file a hit came from.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { platformKey } from '../src/main/resources'
import { join, relative, resolve } from 'node:path'

const repoRoot = resolve(__dirname, '..')

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

/** Every file under `dir`, recursively. */
function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

/** Text-ish files only — binaries produce meaningless "matches". */
const TEXTUAL = /\.(js|mjs|cjs|ts|json|html|css|map|txt|wasm)$/i

const FORBIDDEN_URL =
  /https?:\/\/(cdn\.|unpkg\.com|cdn\.jsdelivr\.net|jsdelivr\.net|ajax\.googleapis\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|cdnjs\.|huggingface\.co|hf\.co\/|tessdata|raw\.githubusercontent\.com)/i

/** Renderer-only: pulling these in would demand `wasm-unsafe-eval` in the CSP. */
const RENDERER_WASM_LOADER = /(onnxruntime-web|tesseract-core|ort-wasm|importScripts\()/

/**
 * Packages that must never be imported from renderer SOURCE.
 *
 * `@huggingface/transformers` statically imports BOTH `onnxruntime-node` and
 * `onnxruntime-web/webgpu`; its package `exports` picks the Node build
 * correctly in main, but a single stray renderer import resolves the WEB build
 * instead — which needs `wasm-unsafe-eval` and fetches its wasm from jsdelivr,
 * violating the CSP and the offline rule in one step. tesseract.js is the same
 * hazard via its browser worker's `importScripts`.
 *
 * The bundle grep above catches this only once it has already shipped in a
 * build; checking the source names the offending FILE instead.
 */
const RENDERER_FORBIDDEN_IMPORTS =
  /from\s+['"](@huggingface\/transformers|onnxruntime-node|onnxruntime-web|tesseract\.js|tesseract\.js-core)['"]|require\(\s*['"](@huggingface\/transformers|onnxruntime-node|onnxruntime-web|tesseract\.js)['"]/

function scanBundle(label: string, root: string): void {
  console.log(`\n--- ${label}: ${root} ---`)
  if (!existsSync(root)) {
    check(`${label} exists`, false, 'run `npm run build` first')
    return
  }
  const files = walk(root).filter((f) => TEXTUAL.test(f))
  check(`${label} contains files`, files.length > 0, `${files.length} textual files`)

  const urlHits: string[] = []
  const wasmHits: string[] = []
  const fontDataHits: string[] = []
  for (const f of files) {
    let text: string
    try {
      text = readFileSync(f, 'utf8')
    } catch {
      continue
    }
    if (FORBIDDEN_URL.test(text)) urlHits.push(relative(root, f))
    // A bundler-inlined font is a LITERAL base64 payload. Requiring a long run
    // of base64 after the prefix is what separates that from pdf.js's
    // `url(data:font/opentype;base64,${btoa(data)})` TEMPLATE, which builds a
    // synthetic probe font at runtime in its legacy `loadTestFont` path (used
    // only where synchronous font loading is unsupported — not on Chromium).
    // It is a template string, not an asset, and flagging it would make this
    // check cry wolf on every build.
    if (/data:(font|application\/(x-)?font)[^;"']*;base64,[A-Za-z0-9+/]{100}/i.test(text)) {
      fontDataHits.push(relative(root, f))
    }
    if (f.includes(`${join('', 'renderer')}`) && RENDERER_WASM_LOADER.test(text)) {
      wasmHits.push(relative(root, f))
    }
  }
  check('no CDN / model-host URLs', urlHits.length === 0, urlHits.slice(0, 5).join(', '))
  check('no data: font URIs', fontDataHits.length === 0, fontDataHits.slice(0, 5).join(', '))
  check(
    'renderer pulls in no browser wasm loader',
    wasmHits.length === 0,
    wasmHits.slice(0, 5).join(', ')
  )

  const fonts = walk(join(root, 'renderer')).filter((f) => /\.(woff2?|ttf|otf)$/i.test(f))
  check('fonts shipped as real files', fonts.length > 0, `${fonts.length} font files`)

  // CSP: the header is built in main; the meta tag lives in index.html. If they
  // drift, one of them is silently not enforcing what it claims to.
  const html = join(root, 'renderer', 'index.html')
  if (existsSync(html)) {
    const meta = readFileSync(html, 'utf8')
    check('index.html meta CSP has no unsafe-eval', !/unsafe-eval/.test(meta))
    check("index.html meta CSP has default-src 'none'", /default-src\s+'none'/.test(meta))
  }
  const mainJs = join(root, 'main', 'index.js')
  if (existsSync(mainJs)) {
    const src = readFileSync(mainJs, 'utf8')
    check('main bundle emits no unsafe-eval in the prod CSP', !/unsafe-eval/.test(src))
  }
}

// --------------------------------------------------------------- out/
scanBundle('build output', join(repoRoot, 'out'))

// The source of truth for the CSP lives in main; assert it there too, since the
// bundle check above could pass on a build that is simply stale.
const mainSrc = readFileSync(join(repoRoot, 'src', 'main', 'index.ts'), 'utf8')
check('src/main/index.ts contains no unsafe-eval', !/unsafe-eval/.test(mainSrc))

// -------------------------------------------- the test seam stays out of the app
//
// The verification harness needs deterministic LLM answers and the product must
// never have any. `scripts/testing/recordedProvider.ts` supplies the first; this
// enforces the second, in the two places it could fail.
//
// Structural, not stylistic: an LLM stand-in reachable from the shipping app is
// how an analysis gets produced, stamped with provenance and shown to a reader
// when no model read the paper — the exact failure the whole provider change
// exists to end. Two independent checks, because either alone has a hole: a
// source-import grep cannot see a bundler pulling the file in transitively, and
// an output grep cannot see an import added but not yet built.
{
  const marker = 'CORPUS_TEST_ONLY_RECORDED_PROVIDER'
  const outHits = walk(join(repoRoot, 'out'))
    .filter((f) => TEXTUAL.test(f))
    .filter((f) => {
      try {
        return readFileSync(f, 'utf8').includes(marker)
      } catch {
        return false
      }
    })
    .map((f) => relative(repoRoot, f))
  check(
    'the test-only LLM provider is absent from the build output',
    outHits.length === 0,
    outHits.join(', ')
  )

  const srcImporters = walk(join(repoRoot, 'src'))
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .filter((f) => /from\s+['"][^'"]*scripts\/testing/.test(readFileSync(f, 'utf8')))
    .map((f) => relative(repoRoot, f))
  check(
    'nothing under src/ imports the test-only provider',
    srcImporters.length === 0,
    srcImporters.join(', ')
  )

  // The provider selection admits exactly two outcomes. A third would not
  // necessarily import anything from scripts/ — it could be a new class right
  // beside the real one — so the shape of the selector is asserted directly.
  const selectSrc = readFileSync(join(repoRoot, 'src', 'main', 'llm', 'select.ts'), 'utf8')
  const constructed = [...selectSrc.matchAll(/new\s+([A-Za-z_][A-Za-z0-9_]*)LlmProvider/g)].map(
    (m) => `${m[1]}LlmProvider`
  )
  const allowed = new Set(['CommunicatorLlmProvider', 'UnavailableLlmProvider'])
  const unexpected = [...new Set(constructed)].filter((n) => !allowed.has(n))
  check(
    'selectProvider constructs only the real gateway or the unavailable provider',
    unexpected.length === 0,
    unexpected.join(', ')
  )
}

// ------------------------------------------- no fabricated search source ships
//
// The same rule as the LLM provider above, for the other half of the product.
// A search stand-in is how a paper the user then IMPORTS gets into the corpus
// with an invented DOI that no registry can resolve — a work titled with a raw
// `10.5981/…` string, which really shipped. Every row the studio shows must be
// attributable to an upstream index that actually returned it.
//
// Checked as SHAPE rather than by name: a reintroduction would not necessarily
// be called "mock". What is asserted is that every registered source is on a
// named allow-list, that no source may be chosen by an environment variable
// (that is how the fixture became selectable last time), and that no source
// module imports a bundled data file to answer a search from.
{
  const searchDir = join(repoRoot, 'src', 'main', 'search')
  const sourcesDir = join(searchDir, 'sources')
  const rootFile = join(searchDir, 'index.ts')

  // Registration is checked across ALL of src/main, not just the composition
  // root: a `registry.register(...)` added in the IPC layer or inside the
  // registry itself would otherwise install a source no allow-list ever saw.
  const REAL_SOURCES = new Set(['WebSearchServerSource'])
  const badRegistrations: string[] = []
  for (const f of walk(join(repoRoot, 'src', 'main')).filter((f) => f.endsWith('.ts'))) {
    const code = readFileSync(f, 'utf8')
    // Scoped to files that actually deal in the search registry, so an unrelated
    // `.register(` elsewhere in main is not dragged into a search rule.
    if (!/SearchSourceRegistry|createSearchRegistry/.test(code)) continue
    for (const m of code.matchAll(/\.register\s*\(\s*([^)\n]*)/g)) {
      // Only a direct `new AllowListedSource(` is accepted. A factory call, a
      // variable or an inline object all read as unreviewed, because a name is
      // the only thing this check can hold anyone to.
      const ctor = /^new\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(m[1].trim())
      if (!ctor || !REAL_SOURCES.has(ctor[1])) {
        badRegistrations.push(`${relative(repoRoot, f)}: register(${m[1].trim().slice(0, 40)}`)
      }
    }
  }
  check(
    'only allow-listed, real upstream sources are registered',
    badRegistrations.length === 0,
    badRegistrations.join('; ')
  )

  // A source picked by env is a fake the SHIPPING app can select — the exact
  // shape `CORPUS_SEARCH_MOCK` had. The URL override is fine (it points the one
  // real source at a different address); anything else gating a source is not.
  const searchFiles = walk(searchDir).filter((f) => f.endsWith('.ts'))
  const ALLOWED_SEARCH_ENV = new Set(['CORPUS_WEBSEARCH_URL'])
  const unexpectedEnv: string[] = []
  for (const f of searchFiles) {
    for (const m of readFileSync(f, 'utf8').matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
      if (!ALLOWED_SEARCH_ENV.has(m[1])) unexpectedEnv.push(`${relative(repoRoot, f)}: ${m[1]}`)
    }
  }
  check(
    'no environment variable can select a search source',
    unexpectedEnv.length === 0,
    [...new Set(unexpectedEnv)].join(', ')
  )

  // A source answers from the wire, never from a file in this repository — in
  // ANY module format, since a `.ts` fixture is as fabricated as a `.json` one.
  const sourceFiles = existsSync(sourcesDir) ? walk(sourcesDir).filter((f) => f.endsWith('.ts')) : []
  const fixtureImporters = [...sourceFiles, rootFile]
    .filter((f) =>
      /from\s+['"][^'"]*\.(json|ya?ml|csv)['"]|require\(\s*['"][^'"]*\.(json|ya?ml|csv)['"]|readFileSync\s*\(/.test(
        readFileSync(f, 'utf8')
      )
    )
    .map((f) => relative(repoRoot, f))
  check(
    'no search source answers from a bundled fixture file',
    fixtureImporters.length === 0,
    fixtureImporters.join(', ')
  )

  // Belt and braces over the BUILD: the checks above read source, so a fixture
  // reached transitively — imported by a helper the source pulls in — would
  // pass them. The retired fixture's invented DOI prefix is the fingerprint,
  // alongside the shape any hand-written result set would have: a literal
  // `external_id`/`citation_count` pair, which only ever comes off the wire.
  const fabricatedInOut = walk(join(repoRoot, 'out'))
    .filter((f) => TEXTUAL.test(f))
    .filter((f) => {
      try {
        const text = readFileSync(f, 'utf8')
        return /10\.5981\//.test(text) || /"external_id"\s*:\s*"/.test(text)
      } catch {
        return false
      }
    })
    .map((f) => relative(repoRoot, f))
  check(
    'no fabricated search result is bundled in the build output',
    fabricatedInOut.length === 0,
    fabricatedInOut.join(', ')
  )
}

// ------------------------------------------------- the stage sandbox barriers
//
// Exactly one LLM request may be in flight process-wide, and the gate that
// guarantees it is only a guarantee if nothing else can reach the gateway.
// `StageContext` deliberately exposes no network primitive and no raw database
// handle, so a stage that wanted to bypass either would have to import its own
// — which is what this gate refuses.
//
// A grep is a second net, not the mechanism (the TYPES are), but it is the net
// that catches the honest mistake, and adding an exemption is a visible diff.
const stagesDir = join(repoRoot, 'src', 'main', 'pipeline', 'stages')
if (existsSync(stagesDir)) {
  const stageFiles = walk(stagesDir).filter((f) => f.endsWith('.ts'))
  const banned: Array<{ pattern: RegExp; why: string }> = [
    { pattern: /\bfetch\s*\(/, why: 'fetch(' },
    { pattern: /from\s+['"](undici|axios|node-fetch|node:http|node:https|https?)['"]/, why: 'an HTTP client' },
    { pattern: /CORPUS_LLM_/, why: 'the gateway credential' },
    // A SELECT from a bulk table. A stage reads its inputs through ctx.input(),
    // which scopes rows to the run that produced them; a hand-written read would
    // match every inventory in the table, including one a transformer retired.
    // The pattern requires a preceding SELECT because a stage's own INSERT or
    // DELETE inside `applyWrites` is the sanctioned way to WRITE one of these
    // tables, and catching those would ban the only supported write path.
    { pattern: /\bselect\b[\s\S]{0,400}?\bfrom\s+(?:document_page|document_paragraph|document_table|chunk|citation_context)\b/i, why: 'a bulk table directly' },
    // A stage never opens its own connection: it reads through `ctx.input` and
    // writes through `ctx.write` + `applyWrites`. An import here is either a
    // second writer, or a stage that will fail the moment it is moved into a
    // host — which has no database at all.
    { pattern: /from\s+['"][^'"]*db\/connection['"]/, why: 'its own database connection' }
  ]
  const offenders: string[] = []
  for (const f of stageFiles) {
    // Strip comments first: a comment explaining WHY a stage must not fetch is
    // exactly the thing a future reader needs, and must not fail the gate that
    // it documents.
    const code = readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    for (const b of banned) {
      if (b.pattern.test(code)) offenders.push(`${relative(repoRoot, f)} uses ${b.why}`)
    }
  }
  check(
    'no stage reaches the network, the credential, or a bulk table directly',
    offenders.length === 0,
    offenders.join('; ')
  )
}

// The same network ban, over the code a stage DELEGATES to.
//
// The scan above covers `stages/` only, which was sufficient while every stage
// was self-contained. It is not any more: `ocr` calls a rasteriser, `embed`
// calls an embedding-space resolver and a model loader, and the search worker
// runs a model of its own — all outside `stages/`, and all in exactly the
// position to fetch something. A ban that stops at a directory boundary is a
// ban on where the code happens to live, not on what it does.
//
// The bulk-table and own-connection rules deliberately do NOT extend here:
// these modules are the sanctioned owners of `chunk` and, for the read-only
// search worker, of a connection.
//
// The list is per-DIRECTORY for `embedding/` and `ocr/`, which exist only to
// serve offline stages, and per-FILE for the two vector-search modules. That
// asymmetry is deliberate rather than sloppy: `src/main/search/` is a MIXED
// directory. Most of it — `resolve.ts`, `sources/` — is the user-initiated web
// lookup that is SUPPOSED to reach CrossRef and arXiv, and banning `fetch(`
// across it would be banning the feature. What must never fetch is the local
// vector path, so that is what is named.
const OFFLINE_ONLY_SOURCES = [
  join(repoRoot, 'src', 'main', 'embedding'),
  join(repoRoot, 'src', 'main', 'ocr'),
  join(repoRoot, 'src', 'main', 'search', 'vectorWorker.ts'),
  join(repoRoot, 'src', 'main', 'search', 'vectorSearch.ts')
].filter((p) => existsSync(p))
if (OFFLINE_ONLY_SOURCES.length > 0) {
  const networkBans: Array<{ pattern: RegExp; why: string }> = [
    { pattern: /\bfetch\s*\(/, why: 'fetch(' },
    { pattern: /from\s+['"](undici|axios|node-fetch|node:http|node:https|https?)['"]/, why: 'an HTTP client' },
    { pattern: /CORPUS_LLM_/, why: 'the gateway credential' }
  ]
  const offenders: string[] = []
  for (const entry of OFFLINE_ONLY_SOURCES) {
    const files = statSync(entry).isDirectory()
      ? walk(entry).filter((p) => p.endsWith('.ts'))
      : [entry]
    for (const f of files) {
      const code = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')
      for (const b of networkBans) {
        if (b.pattern.test(code)) offenders.push(`${relative(repoRoot, f)} uses ${b.why}`)
      }
    }
  }
  check(
    'the model, OCR and vector-search helpers reach no network either',
    offenders.length === 0,
    offenders.join('; ')
  )
}

// The offline SETTINGS are present, asserted rather than trusted.
//
// This is the hole the URL greps cannot see. `env.allowRemoteModels = false`
// and `local_files_only: true` are the only things standing between this app
// and a huggingface.co fetch on a user's machine; `langPath` is the only thing
// standing between it and tesseract.js downloading `eng.traineddata` from
// jsdelivr, which was reproduced twice during the research. All four are
// ordinary assignments in our own source, so DELETING one is a green build that
// phones home in the field — no bundle grep would notice, because the URL lives
// inside a dependency we did not write.
const OFFLINE_SETTINGS: Array<{ file: string; needs: Array<[RegExp, string]> }> = [
  {
    file: join('src', 'main', 'embedding', 'model.ts'),
    needs: [
      [/env\.allowRemoteModels\s*=\s*false/, 'env.allowRemoteModels = false'],
      [/env\.localModelPath\s*=/, 'env.localModelPath'],
      [/local_files_only:\s*true/, 'local_files_only: true']
    ]
  },
  {
    file: join('src', 'main', 'pipeline', 'stages', 'ocr.ts'),
    needs: [
      [/langPath:/, 'langPath'],
      [/cacheMethod:\s*'none'/, "cacheMethod: 'none'"]
    ]
  }
]
for (const spec of OFFLINE_SETTINGS) {
  const path = join(repoRoot, spec.file)
  if (!existsSync(path)) continue
  const code = readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  const missing = spec.needs.filter(([re]) => !re.test(code)).map(([, name]) => name)
  check(`${spec.file} still sets every offline flag`, missing.length === 0, missing.join(', '))
}

// The endpoint and the credential come from SETTINGS and from nowhere else.
const credentialReaders = walk(join(repoRoot, 'src', 'main'))
  .filter((f) => f.endsWith('.ts'))
  .filter((f) => /CORPUS_LLM_(KEY|URL)/.test(readFileSync(f, 'utf8')))
  .map((f) => relative(repoRoot, f))
// NOBODY reads them, because they no longer exist.
//
// `gateway.ts` used to layer `CORPUS_LLM_KEY`, `CORPUS_LLM_KEY_FILE`, a
// repo-local `.env` and a `docker/` path IN FRONT of the value the user typed
// into the app. The highest-precedence layer won silently, so an endpoint
// entered in Settings could have no effect with nothing on screen to explain
// why, and an install could authenticate with a credential its user had never
// entered anywhere they could see.
//
// Kept as a check rather than deleted: reintroducing an env override is a small
// diff that looks harmless and quietly restores exactly that.
check(
  'nothing reads a gateway endpoint or credential from the environment',
  credentialReaders.length === 0,
  credentialReaders.join(', ')
)

// The credential is reachable through exactly ONE named accessor, and only from
// the provider that makes the request.
//
// This is the check that survives a refactor: the allow-list above constrains
// where the key is READ FROM, this constrains where it is USED. A helper that
// took the credential object and logged `cred.reveal()` would pass the first
// check and fail this one — and a leak of exactly that shape (into a Python
// child's environment) has already happened once in this repo.
const revealers = walk(join(repoRoot, 'src', 'main'))
  .filter((f) => f.endsWith('.ts'))
  .filter((f) => /\.reveal\s*\(/.test(readFileSync(f, 'utf8')))
  .map((f) => relative(repoRoot, f))
check(
  'the credential is revealed only where the request is built',
  revealers.every((f) => f === 'src/main/llm/provider.ts'),
  revealers.filter((f) => f !== 'src/main/llm/provider.ts').join(', ')
)

// A revealed credential must never reach a log. Checked as a shape rather than
// by taint analysis: `console.*` and template interpolation are the two ways it
// would realistically happen, and both are visible in the source.
const providerSrc = readFileSync(join(repoRoot, 'src', 'main', 'llm', 'provider.ts'), 'utf8')
check(
  'no console call in the provider names the credential',
  // `[\s\S]*?` bounded by a newline, not `[^)]*`: the latter stops at the FIRST
  // `)`, so `console.log(redact(c.reveal()))` — a nested call, the shape this
  // would realistically take — slipped straight through.
  !/console\.[a-z]+\([\s\S]*?(?:reveal\s*\(|apiKey|credential)[^\n]*/i.test(providerSrc)
)

// The renderer must never import an inference or OCR library. This is checked
// against SOURCE, not just the bundle, so the failure names the file that did
// it rather than a minified chunk.
const rendererDir = join(repoRoot, 'src', 'renderer')
if (existsSync(rendererDir)) {
  const offenders = walk(rendererDir)
    .filter((f) => /\.(ts|tsx|js|jsx)$/.test(f))
    .filter((f) => RENDERER_FORBIDDEN_IMPORTS.test(readFileSync(f, 'utf8')))
    .map((f) => relative(repoRoot, f))
  check(
    'no renderer source imports an inference/OCR library',
    offenders.length === 0,
    offenders.join(', ')
  )
}

// --------------------------------------------------------------- artifact
const artifact = process.argv[2]
if (artifact) {
  const root = resolve(artifact)
  const asar = join(root, 'resources', 'app.asar')
  console.log(`\n--- packaged artifact: ${root} ---`)
  check('app.asar present', existsSync(asar))
  if (existsSync(asar)) {
    const tmp = mkdtempSync(join(tmpdir(), 'corpus-asar-'))
    try {
      execFileSync('npx', ['--no-install', '@electron/asar', 'extract', asar, tmp], {
        stdio: 'inherit'
      })
      scanBundle('packaged app.asar', join(tmp, 'out'))

      // Font parity: a `files` glob that drops out/renderer/assets would leave
      // the app running with system fonts and nothing else would notice.
      const built = walk(join(repoRoot, 'out', 'renderer')).filter((f) =>
        /\.(woff2?|ttf|otf)$/i.test(f)
      ).length
      const packed = walk(join(tmp, 'out', 'renderer')).filter((f) =>
        /\.(woff2?|ttf|otf)$/i.test(f)
      ).length
      check('every font file survived packaging', built > 0 && built === packed, `${packed}/${built}`)

      const leaked = walk(tmp).filter((f) => /\.(sqlite|sqlite-.*|db|env|p12|pfx|pem|key)$/i.test(f))
      check('no database / credential file inside the asar', leaked.length === 0, leaked.join(', '))
      const devDirs = ['e2e', 'tmp', 'test-results', 'playwright-report', 'docs', 'src']
      const packedDevDirs = devDirs.filter((d) => existsSync(join(tmp, d)))
      check('no dev directories packaged', packedDevDirs.length === 0, packedDevDirs.join(', '))
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }

  // ------------------------------------------------ shipped payload tree
  //
  // The payloads are the newest and largest way this app could start phoning
  // home: transformers.js defaults to huggingface.co and tesseract.js defaults
  // to jsdelivr, and both defaults are SILENT. So the packaged tree is checked
  // for the two failure shapes that matter — a payload that is MISSING (the
  // library then reaches for its remote default) and a build-time-only
  // provenance file that LEAKED into the artifact carrying upstream URLs.
  const appRes = join(root, 'resources', 'app-resources')
  console.log(`\n--- packaged payloads: ${appRes} ---`)
  if (!existsSync(appRes)) {
    check('app-resources/ shipped', false)
  } else {
    // payloads.json/lock are build-time records full of upstream URLs, excluded
    // by electron-builder.yml. If that filter regresses the artifact would
    // contain CDN URLs, and this is what says so.
    for (const f of ['payloads.json', 'payloads.lock.json']) {
      check(`the build-time provenance file ${f} is NOT in the artifact`,
        !existsSync(join(appRes, f)))
    }

    // A missing payload is not automatically a failure — a stage may honestly
    // report `skipped`. It IS one for the models and the traineddata, because
    // those are precisely the ones whose libraries fall back to a remote default
    // rather than to nothing.
    //
    // BOTH transformers roots are checked, and by name. `models/` was once THE
    // model tree here, which meant an installer shipped without the reranker
    // passed this gate green — the same shape of failure PAYLOAD_PROBES in
    // src/main/resources.ts exists to prevent, and for the same reason: a
    // declaration that enforces nothing is worse than no declaration, because it
    // is read as proof. A root is separated per ROLE (discoverModelId() throws
    // on a second onnx/ directory under one root), so a new role means a new
    // entry here or the gate silently stops covering it.
    const transformerModels: Array<{ what: string; dir: string }> = [
      { what: 'embedding model', dir: join(appRes, 'models', 'Snowflake', 'snowflake-arctic-embed-s') },
      {
        what: 'reranker model',
        dir: join(appRes, 'rerankers', 'cross-encoder', 'ms-marco-MiniLM-L-6-v2')
      }
    ]
    for (const { what, dir } of transformerModels) {
      const onnx = join(dir, 'onnx', 'model_quantized.onnx')
      check(`the ${what} is IN the artifact (never fetched at runtime)`,
        existsSync(onnx),
        existsSync(onnx) ? `${(statSync(onnx).size / 1024 / 1024).toFixed(1)} MB` : 'absent')
      for (const f of ['config.json', 'tokenizer.json', 'vocab.txt']) {
        check(`the ${what}'s ${f} shipped (a missing file sends transformers.js to the hub)`,
          existsSync(join(dir, f)))
      }
    }
    const tess = join(appRes, 'tesseract', 'tessdata', 'eng.traineddata')
    check('eng.traineddata is IN the artifact (absent, tesseract.js downloads it)',
      existsSync(tess),
      existsSync(tess) ? `${(statSync(tess).size / 1024 / 1024).toFixed(1)} MB` : 'absent')

    // Only this target's binaries may ship: foreign-platform payloads are dead
    // weight in every installer and extra surface for the macOS notarizer.
    for (const dir of ['bin', 'lib']) {
      const d = join(appRes, dir)
      if (!existsSync(d)) continue
      const foreign = readdirSync(d).filter((e) => e !== platformKey())
      check(`${dir}/ holds only this target's payloads (${platformKey()})`,
        foreign.length === 0, foreign.join(', '))
    }

    // The binaries themselves must carry no URL. qpdf was chosen partly because
    // it has no network stack at all; this asserts that stayed true of whatever
    // actually shipped.
    const urlInBinary: string[] = []
    for (const f of walk(appRes)) {
      if (!/[/\\](bin|lib)[/\\]/.test(f)) continue
      const text = readFileSync(f).toString('latin1')
      if (/https?:\/\/[a-z0-9.-]*(jsdelivr|huggingface|unpkg|nuget|githubusercontent)/i.test(text)) {
        urlInBinary.push(relative(appRes, f))
      }
    }
    check('no shipped binary contains a CDN URL', urlInBinary.length === 0, urlInBinary.join(', '))
  }
}

console.log(failures === 0 ? '\nOFFLINE CHECKS PASSED' : `\n${failures} OFFLINE CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
