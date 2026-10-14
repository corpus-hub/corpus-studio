# `resources/` — shipped non-JS payloads

Everything here is copied verbatim into the installer by `extraResources` in
`electron-builder.yml`, landing at `<app>/resources/app-resources/`. It is
**outside `app.asar` on purpose**: an asar is not a real directory, so nothing
that is `spawn`ed, `dlopen`ed or read by a wasm loader can live inside one.

**Resolve every path through `src/main/resources.ts`** — `resourcePath(...)`, or
better the named helpers `qpdfPath()`, `sqliteVecPath()`, `tessdataDir()`,
`modelsDir()`, `rerankersDir()`. Never hand-roll `__dirname`/`process.resourcesPath` arithmetic: a
path that works in dev and breaks in the installer is the classic packaging
failure, and these are verified against both modes by `npm run verify:resources`.

## Provisioning — build time only

The binaries are **not in git**. `resources/payloads.json` is the checked-in
provenance manifest — source URL, version, licence, SHA-256 and destination for
every file — and `npm run payloads` populates this (gitignored) tree from it.

```bash
npm run payloads                  # this host's platform
npm run payloads -- --all         # every platform, for a release matrix
npm run payloads -- --check       # verify what is here; fetch nothing
npm run verify:payloads           # EXERCISE each payload against real input
```

**The fetch happens on a developer's machine, never in the shipped app.** That
is the whole point: `CLAUDE.md` §2 requires the app to run with networking
disabled, so everything it will ever need is baked into the installer.
`payloads.json` itself is excluded from the artifact — it is full of upstream
URLs, and shipping it would put CDN URLs inside the very thing
`npm run verify:offline` greps.

Archive hashes are checked **before** extraction, and every extracted file is
hashed again afterwards. A mismatch aborts rather than warning: it means either
a corrupted transfer or an upstream asset replaced under a pinned URL, and
neither is something to build on.

## Layout

Binary payloads are keyed `<platform>-<arch>` — **arch is in the path**, because
macOS ships separate x64 and arm64 apps and upstream publishes a different
sqlite-vec dylib for each. A platform-only path loads the wrong binary on half
of all Macs, and does it as a `dlopen` failure far from the cause.

| slot | payload | notes |
|---|---|---|
| `bin/<platform>-<arch>/` | `qpdf` (+ `.exe`, `.dll`s on win32) | Linux is BUILT statically from source (`build/qpdf/Dockerfile`, musl, crypto=native) — the upstream Linux binary zip ships a private gnutls/nettle/p11-kit/idn2 stack that would then need signing, notarizing and CVE-patching. Windows is fetched from the mingw64 release, which carries no TLS stack. Mode 0755. |
| `lib/<platform>-<arch>/` | `vec0.{so,dylib,dll}` | sqlite-vec loadable extension, `db.loadExtension()`. |
| `tesseract/tessdata/` | `eng.traineddata` | **The offline-critical one.** With `langPath` unset, tesseract.js downloads this from jsdelivr on first use. Pass `langPath`/`cachePath` from `tessdataDir()`; absent, it then fails with ENOENT instead of fetching — keep it that way. |
| `models/<org>/<model>/` | arctic-embed-s int8 ONNX + tokenizer | Set `env.allowRemoteModels=false`, `env.localModelPath=modelsDir()`. Layout is dictated by transformers.js — do not flatten it. |
| `rerankers/<org>/<model>/` | ms-marco-MiniLM-L-6-v2 int8 ONNX + tokenizer | Same layout, a SEPARATE root. See below. |
| `sidecar/<platform>/` | Python sidecar | See `docs/packaging.md` §Python sidecar. |

### Why there are TWO transformers roots

`discoverModelId()` (`src/main/embedding/space.ts`) reads the tree under
`modelsDir()` and **throws** the moment it finds a second directory carrying an
`onnx/` folder — the model that is there is the model that is used, and it is
never chosen by a name written down in TypeScript. A reranker dropped into
`models/` would break the embedder outright.

So roots are separated by ROLE, one discovery per root: `models/` for the
embedding space, `rerankers/` for the cross-encoder, resolved by `modelsDir()`
and `rerankersDir()` respectively. That keeps "exactly one model lives here" a
STRUCTURAL fact rather than an exclusion list somebody has to remember to extend
every time a model arrives. A third role means a third root, not a special case
inside an existing one.

`env.localModelPath` is a mutable global, so neither root may be set inline at a
call site: `transformersFor(root)` (`src/main/ml/transformers.ts`) is the one
place it is assigned, and a caller that forgot would otherwise read a model out
of the wrong tree without erroring.

**`tesseract.js-core`'s wasm is NOT here.** In Node, `worker-script/node/getCore.js`
`require`s it from `node_modules`; `corePath` is a browser-only option. It ships
via `asarUnpack` instead, pruned to the SIMD/LSTM variants that file actually loads.

## Degradation

Every payload is optional in the sense that a missing one must never produce a
wrong answer — only an honest, visible absence:

- **qpdf absent** → the `optimize` stage reports `skipped` naming the binary;
  documents are stored unoptimized. Nothing is silently left un-compressed while
  claiming otherwise. **Not provisioned for macOS** (no build host), so this is
  macOS's permanent state until a Mac is available.
- **eng.traineddata absent** → the `ocr` stage reports `skipped`. It must never
  fall back to the CDN.
- **reranker absent** → the `rerank` stage reports `skipped` naming it and
  relevance stays NULL. Never 0: a 0 draws an empty bar, which reads as "judged,
  and found irrelevant" — a claim about the paper that nothing measured.
- **model or vec0 absent** → semantic search is unavailable and the results
  surface must SAY so. A semantic search that quietly returns keyword results is
  the worst outcome available: the user reads a ranked list and concludes the
  corpus holds nothing relevant.

## Licences

All payloads are Apache-2.0 (or Apache-2.0 OR MIT for sqlite-vec) — deliberately:
ghostscript was rejected for the optimize stage because it is AGPL.

Apache-2.0 §4 requires attribution, and the app discharges it at
**Settings → About → Third-party licences**. That screen reads
`resources/licences/index.json`, which is **generated**, never hand-written:

```bash
npm run licences          # regenerate from payloads.json + the npm closure
npm run verify:licences   # fail if what is on disk is stale (the anti-rot gate)
```

`scripts/gen-licences.ts` reads the payload half from `payloads.json` and the
package half from the installed production `node_modules`, so the list cannot
drift from what is actually shipped. Licence texts are content-addressed files
under `licences/texts/` (~400 KB), read in main and served over IPC — never
inlined in the bundle, and never fetched.

**Adding a payload requires adding its licence text** at
`resources/licences/payload-texts/<id>.txt`, verbatim from the pinned upstream
tag; the generator refuses to run without it.
