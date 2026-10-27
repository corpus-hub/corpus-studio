# Packaging & distribution

Corpus Studio is packaged with **electron-builder 25**, configured in
`electron-builder.yml`. Packaging is deliberately kept OUT of the normal build
path: `npm run build`, `npm start`, `scripts/relaunch.sh`, `npm run shot` and
`npm run seed` are unchanged and stay fast.

```bash
npm run package        # current platform, unpacked dir  -> release/linux-unpacked
npm run dist           # installers for the current platform
npm run dist:linux     # AppImage + deb
npm run dist:win       # nsis                 (cross-builds from Linux)
npm run dist:mac       # zip x64 + arm64      (cross-builds; dmg needs a Mac)
npm run icons          # regenerate the placeholder icon set
npm run payloads       # provision the shipped binaries (see below) — BUILD TIME
npm run verify:payloads # EXERCISE each payload against real input
npm run verify:resources -- release/linux-unpacked
npm run verify:offline  -- release/linux-unpacked
```

## Payloads — the shipped binaries

Four non-JS payloads ship in the installer: **qpdf** (the `optimize` stage),
**eng.traineddata** (the `ocr` stage), the **arctic-embed-s int8 ONNX model**
(semantic search) and the **sqlite-vec** loadable extension. They are not in
git. `resources/payloads.json` is the checked-in provenance manifest — URL,
version, licence and SHA-256 for every file — and `npm run payloads` populates
the gitignored `resources/` tree from it. See `resources/README.md` for the
layout and the per-payload degradation contract.

**Build time, never run time.** This is the load-bearing distinction. The fetch
happens on a developer's machine; the installer then contains everything the app
will ever need, and the app contains no URL from the manifest and no code that
reads it. `payloads.json` is deliberately EXCLUDED from the artifact: it is full
of upstream URLs, and shipping it would put CDN URLs inside the very tree
`npm run verify:offline` greps. Both facts are asserted, not assumed.

Hashes are verified before use — the archive before it is unpacked (so no parser
has consumed attacker-controlled bytes), then every extracted file. A mismatch
aborts. What that does and does not buy: it protects against a corrupted
transfer, a poisoned cache, and a release asset re-uploaded under a pinned URL.
It does **not** protect against an upstream project compromised before it
published. That residual risk is accepted and named rather than left implicit.

### qpdf is built, not downloaded, on Linux

The upstream `qpdf-12.3.2-bin-linux-x86_64.zip` ships a private
gnutls/nettle/p11-kit/idn2 TLS stack in `lib/` (verified: `ldd` resolves
`libgnutls.so.30` out of the zip). Bundling it would mean signing, notarizing and
CVE-patching a whole TLS implementation inside an app that never opens a socket.
`build/qpdf/Dockerfile` instead builds a **static musl binary with
`crypto=native`** — 4.6 MB, libc/libstdc++ only, zero network symbols.

The base image is pinned **by digest**, not by the `alpine:3.21` tag, which is
rebuilt for every CVE patch and would silently change the toolchain. That matters
because the build turned out to be **bit-reproducible**: a second
`docker build --no-cache` produced a byte-identical binary, so `payloads.json`
pins the OUTPUT hash too, not just the source tarball's. Measured on one host —
a different BuildKit could still perturb it, and if that hash ever mismatches the
answer is to investigate the toolchain, not to edit the number until it passes.

Windows qpdf IS fetched: the mingw64 release contains only `qpdf.exe`,
`qpdf30.dll` and three mingw runtime DLLs, with no TLS stack, so the objection
does not apply. The DLLs must sit beside the exe.

### Installer size

Shipping the payloads naively took `release/linux-unpacked` from **358 MB to
1.2 GB**. Almost all of that was dependency weight, not payload weight, and the
`files` allowlist now prunes it:

| dropped | why | saved |
|---|---|---|
| `libonnxruntime_providers_cuda.so` | the app is CPU-only; this EP is never selected | 343 MB |
| a duplicated `onnxruntime-node` | transformers pins `1.21.0`; our `1.27.0` did not dedupe, so BOTH shipped | ~470 MB |
| foreign platform/arch ORT binaries | a Linux AppImage has no use for macOS dylibs | ~35 MB |
| `sharp` / `@napi-rs/canvas` | transformers needs them for IMAGE inputs; this pipeline is text-only (also drops an LGPL libvips obligation) | ~61 MB |
| unused `tesseract.js-core` wasm variants | the Node worker loads only the SIMD/LSTM pair | ~17 MB |

Final: **500 MB unpacked, +142 MB over the payload-free baseline**, of which
43 MB is the payload tree itself (34 MB model, 4.6 MB qpdf, 4.1 MB traineddata,
160 KB vec0) and the rest is the ONNX runtime. Pin `onnxruntime-node` to exactly
the version `@huggingface/transformers` depends on — a mismatch silently doubles
the installer.

## Cross-building from one Linux host

All three platforms are built here. Two things make that work, and both are
hooks rather than config, because the `files` allowlist cannot express either.

**`${platform}` is the HOST, not the target.** `expandMacro` resolves it to
`process.platform`, so `bin/${platform}-${arch}/**` shipped `bin/linux-x64/qpdf`
inside the *Windows* installer and no `qpdf.exe`. Only `${arch}` is per-target.
The per-platform payload filters therefore live in the `linux:`/`win:`/`mac:`
blocks with the platform spelled out, and those blocks use `extraResources`,
which is ADDITIVE to the root one.

Do **not** "fix" the equivalent `files` rule with a per-platform `files:` block:
`getFileMatchers` merges root and platform `files` into ONE matcher, and a
platform block containing only exclusions makes it `containsOnlyIgnore()` —
electron-builder then discards `out/**` and packs the entire working tree,
failing on the first venv symlink it meets. That is why the foreign-platform
onnxruntime prune is an `afterPack` hook (`scripts/prune-packed.cjs`) operating
on the packed output.

**Native modules are not rebuilt for a foreign target.**
`buildDependenciesFromSource: true` makes electron-builder skip the rebuild
whenever the target differs from the host, and nothing replaces the binary — a
Windows build would pack the host's ELF `better_sqlite3.node` and die on the
first `require`. `scripts/stage-native.cjs` (`beforePack`) downloads upstream's
prebuild for Electron's ABI (from `node-abi`, not hardcoded) and stages it. On a
native build it does nothing, leaving the locally compiled addon in place.

Verified in the artifacts: the Windows installer carries a `PE32+`
`better_sqlite3.node`, `qpdf.exe` with its mingw DLLs and `vec0.dll`; the two
mac bundles carry x86_64 and arm64 Mach-O addons with the matching
`vec0.dylib`; each ships only its own `onnxruntime-node` platform directory.

**The DMG still needs a Mac.** `dmg-builder` drives `hdiutil` (create/mount the
image) and `sips` (measure the background); neither exists off macOS and neither
has a faithful substitute — a real UDIF image needs HFS+ tooling this host does
not have. `scripts/run-builder.mjs` therefore drops the dmg from the target list
when `process.platform !== 'darwin'`, so a Linux run SUCCEEDS with the two zips
instead of writing both zips and then failing — an exit code that looks like a
build which produced nothing. On a Mac the same command still emits dmg + zip.
The zip is a complete `.app`: unzip, drag to Applications.

### Ad-hoc signing — required for the arm64 build to RUN, unrelated to trust

The app is deliberately **not** Apple-signed: there is no Developer ID and no
Apple account, so Gatekeeper quarantines it and a user must right-click → Open
the first time. That is accepted.

Ad-hoc signing is a different thing and is **not optional on Apple Silicon**,
where the kernel refuses to execute an arm64 binary with no valid signature —
not a prompt, an execution failure. electron-builder rewrites the bundle and
then, off macOS, logs `skipped macOS application code signing — supported only
on macOS` and leaves the main executable carrying **upstream Electron's** ad-hoc
signature, whose CodeDirectory still says `identifier: Electron` and hashes
contents that no longer exist. Measured on the first cross-build: the arm64 main
binary had `flags: ADHOC | LINKER_SIGNED, identifier: Electron`, the x64 one had
no signature at all, and neither bundle had a `_CodeSignature` directory. A
STALE signature is worse than none — macOS reports "the application is damaged
and can't be opened", which right-click → Open cannot bypass.

`scripts/adhoc-sign-mac.cjs` re-signs the bundle ad-hoc (a self-contained hash
of its own contents; no key material, no account). After it, the identifier is
`com.corpusstudio.app`, `Contents/_CodeSignature` exists, and the entitlements
are embedded. It runs from the `afterPack` hook **after** the onnxruntime prune,
because deleting files from a signed bundle invalidates the signature — that
ordering is why both steps share the single `afterPack` electron-builder allows.
It skips itself when a real identity is configured, so it can never overwrite a
Developer ID signature.

Which signer runs depends on the host:

| host | signer | install |
|---|---|---|
| macOS | Apple's `codesign -s -` | ships with the OS / Xcode CLT |
| anything else | `rcodesign` | `cargo install apple-codesign` |

`rcodesign` is a build-host tool, not an app dependency, so it is not vendored.
Without it a Linux build still succeeds and warns that the artifact will not
launch on Apple Silicon.

**The skip test asks the BUNDLE, not the environment.** On macOS
electron-builder finds a Developer ID by searching the keychain
(`findIdentity`), so `CSC_LINK`/`CSC_NAME` being unset does not mean "unsigned"
— an earlier version of this hook tested only those variables, which on the very
host the feature exists for (a Mac with a certificate installed) would have
re-signed ad-hoc over a real Developer ID signature and thrown it away along
with the notarization. The hook now runs `codesign --display -vv` and skips
itself when it sees an `Authority=` chain rather than `Signature=adhoc`.

## Running the build ON a Mac

Nothing extra is required — `npm run dist:mac` is the same command:

- **The dmg comes back.** `run-builder.mjs` only strips the dmg target when
  `process.platform !== 'darwin'`, so a Mac produces dmg + zip for both arches.
- **Signing takes care of itself.** With a certificate in the keychain
  electron-builder signs properly and the ad-hoc hook stands down; with no
  certificate the hook ad-hoc signs with Apple's `codesign`.
- **Notarization** still activates only when `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` are all set.
- **`better_sqlite3.node`:** an arm64 Mac building arm64 (or an Intel Mac
  building x64) uses `@electron/rebuild`'s locally compiled addon; the OTHER
  arch is cross-built, so `stage-native.cjs` fetches that arch's prebuild
  exactly as it does on Linux. Both arches are therefore correct from one Mac.
- **qpdf is still missing on darwin** — `resources/bin/darwin-*/` is empty
  because no macOS host has ever built one, so `optimize` reports `skipped`.
  Building it there is the one thing a Mac unlocks that this Linux host cannot;
  add both arch paths to `mac.binaries` in the same commit that provisions them.

## The update feed, and why `publish: null` is load-bearing

`publish: null` in `electron-builder.yml` means "this build ships no updater".
Omitting the key does NOT: with no provider configured electron-builder infers
one from the git remote and bakes `provider: github, owner: …` into
`app-update.yml`, so the app polls a source repo that publishes no releases
while reporting a healthy updater.

The feed is supplied by `scripts/run-builder.mjs`, which adds the publish config
only when `$CORPUS_UPDATE_URL` is set (and rejects a non-`https://` one, since a
packaged build refuses it at runtime anyway). It used to live in the YAML as
`url: ${env.CORPUS_UPDATE_URL}` under a comment promising an unset variable was
harmless — `expandMacro` throws on an undefined env var, so every build without
a feed failed. Setting the variables to empty strings is worse than the crash
and silent: `url: ''` is written to `app-update.yml`, and `readPackagedFeed`
reports a present-but-urlless file as `unreadable`, the state that means
"something is broken" rather than "no updater here".

```bash
npm run dist:linux                                   # no feed; no app-update.yml
CORPUS_UPDATE_URL=https://…/stable \
  CORPUS_UPDATE_CHANNEL=stable npm run dist:linux    # feed baked in
```

## Why `electron-builder.yml` and not `package.json`

The config is long — three platforms, target lists, an allowlisted file set,
asarUnpack rules, extraResources, signing hooks — and would triple the size of a
manifest that is currently scripts and dependencies. A separate file also keeps
it clear of tooling that rewrites `package.json` (`npm version`, `npm pkg set`).

There is a second, load-bearing reason: **`productName` must NOT appear in
`package.json`.** Electron's packaged boot loader sets `app.name` from the
packaged manifest's `productName ?? name`, and `app.name` determines
`app.getPath('userData')`. Keeping `productName: Corpus Studio` in the YAML
means `app.name` stays `corpus-studio`, so the packaged app resolves the same
`~/.config/corpus-studio/corpus.sqlite` that `defaultDbPath()` computes and an
existing user's corpus survives the upgrade. `npm run verify:resources` asserts
this, because a regression here silently orphans someone's whole library.

## Icons — PLACEHOLDERS

`build/icons/` is generated by `scripts/make-icons.sh` from
`build/icons/icon.svg`, which is a **placeholder mark**, not designed artwork.
It exists so the app does not ship the stock Electron icon. Replace the SVG and
re-run `npm run icons`. The `.icns` is assembled by `scripts/make-icns.py`
because ImageMagick's `convert x.png out.icns` silently writes a bare PNG that
macOS renders blank.

## Native modules

`better-sqlite3` is `dlopen`ed, so it cannot live inside `app.asar`:
`asarUnpack` covers `**/node_modules/better-sqlite3/**` and `**/*.node`.
`pdfjs-dist` is unpacked too — main loads the pdf worker by a resolved path and
Electron's ESM loader does not reliably import a specifier inside an asar.

`npmRebuild: true` + `buildDependenciesFromSource: true` force a compile against
Electron's ABI rather than letting `prebuild-install` drop in a Node-ABI
prebuild, which would fail only in the packaged build.

## Shipped resources — use `resourcePath()`

`src/main/resources.ts` is the ONLY place allowed to compute paths to shipped
non-JS payloads. It resolves:

| mode | root |
|---|---|
| dev / `ELECTRON_RUN_AS_NODE` scripts | `<repo>/resources/` |
| packaged | `<app>/resources/app-resources/` |

Consumers ask `resources.ts` for the payload BY NAME. They do not assemble the
path themselves:

```ts
import { qpdfPath } from '../resources'
import { existsSync } from 'node:fs'

const qpdf = qpdfPath()
if (!existsSync(qpdf)) return skipped('qpdf not shipped')
```

Two traps this avoids, both of which shipped:

- The directory is keyed `<platform>-<arch>` (`platformKey()`), not
  `process.platform`. `bin/linux/qpdf` is not where anything is provisioned, so
  a hand-built path found nothing while the binary sat correctly installed one
  directory away.
- `resourceExists(...segments)` takes SEGMENTS and joins them onto the resources
  root. Passing it an already-absolute path joins that path onto the root and
  can never be true.

`payloadPreconditions()` / `missingRequiredPayloads()` in `src/main/resources.ts`
declare which payloads a build on this platform is REQUIRED to carry. A packaged
build missing one refuses to start; `npm run verify:payloads` fails on one; and
every `dist*` script provisions and verifies before `electron-builder` runs.

`isPackaged()` tests whether this module's own file lives beneath
`process.resourcesPath`. A bare `existsSync(process.resourcesPath)` would be
wrong: under `ELECTRON_RUN_AS_NODE` that variable IS set (it points at the
vendored Electron's own resources), so every CLI script would claim to be
packaged. `CORPUS_RESOURCES_DIR` overrides the root for harnesses.

`resources/README.md` documents each payload slot (qpdf, tesseract core +
`eng.traineddata`, the embedding model, the Python sidecar).

**`scripts/data/` is NOT packaged.** The KE07 corpus and its recorded analyses
are development and test fixtures: an install starts with an empty library, so
nothing in a shipped artifact ever reads them. `src/main/db/ke07-corpus.ts` and
`src/main/db/shipped-analyses.ts` therefore resolve only from a repo checkout
(walk-up from `__dirname`, then `cwd`, with `$KE07_CORPUS_PATH` as an override),
and `scripts/verify-resources.ts` asserts a packaged artifact carries no
`app-resources/corpus/` at all.

## Python sidecar

**Verdict: `python-build-standalone`, not PyInstaller.**

PyInstaller cannot cross-compile — building a Windows sidecar requires a Windows
host and a macOS sidecar requires a Mac. That is true, but the deciding argument
is that **python-build-standalone ships redistributable per-platform interpreter
tarballs that can be downloaded and unpacked from ANY host**, so this Linux
machine can assemble all three sidecar payloads. Only macOS *signing* then needs
a Mac (and a Mac is already needed for the dmg because better-sqlite3 must be
compiled there). PyInstaller would add a bootloader that unpacks to a temp dir
at every start — extra startup cost, extra antivirus false-positive surface, and
a code path that is harder to reason about under the hardened runtime.

Mechanism, proven end-to-end on Linux by `scripts/build-sidecar.sh` and
`scripts/verify-sidecar.ts`:

1. `resources/sidecar/<platform>/` holds an interpreter tree plus
   `corpus_sidecar/` pure-Python sources.
2. Main resolves the interpreter with `resourcePath('sidecar', process.platform, …)`
   and spawns it with framed JSON on stdio.
3. `extraResources` copies the tree verbatim; nothing is in the asar, so the
   interpreter is a real executable file with its mode preserved.

Per-platform hosts needed for a release: Linux (here), a macOS runner (arm64 and
x64 dmg + signing), a Windows runner (nsis + better-sqlite3 rebuild). No host
is needed to *assemble* a sidecar payload, only to sign one.

### No Python payload ships, and the sidecar hosts no stage

The mechanism above is real and proven, but **nothing uses it**. The sidecar's
op table is `{"ping"}`; `resources/sidecar/<platform>/` carries no interpreter,
and `resources/payloads.json` has no Python entry. That is a decision, not an
unfinished task.

The one stage that was designed to need Python — `tables`, via `pdfplumber` —
is **closed, not deferred**. It is not registered in
`src/main/pipeline/stages/index.ts`, so no job for it exists and nothing about
it is visible to a user. `tmp/tables-decision.md` is the full record; the two
reasons, both of which a future implementer must re-test rather than assume:

1. **Nothing consumes `text.tables@v1`** — the token appears nowhere in the
   capability registry, the IPC contract, the DB schema or the renderer, and
   the kinetics numbers it would produce already arrive through
   `schema-extract`'s LLM pass over paragraph text. A second, differently-wrong
   source for the same numbers, with no reconciliation model behind it, is worth
   less than nothing.
2. **`pdfplumber` measurably loses to the existing 120-line Node spike on this
   corpus.** Against ~65 real tables in the 20-paper KE07 corpus: the spike
   found tables in 17/20 papers; pdfplumber's default ruling-lines strategy
   found 20 tables in 9/20 papers (these publishers do not stroke table rules),
   and its text strategy found 251 — ~4× over-extraction. The design
   (`tmp/pipeline-design.md` §14.1.2) made shipping conditional on beating the
   spike. It does not.

**The packaging blocker that justified the previous two deferrals is gone**, and
this round proved it rather than assuming it: a python-build-standalone
interpreter was provisioned and pdfplumber run against real papers. So if a
consumer for table data ever appears, the interpreter question is answered —
tag `20260718`, CPython 3.12.13, 104 MB unpacked and ~73 MB pruned, ~+98 MB
installer delta, no copyleft obligations. What is *not* answered is which
extractor is worth shipping, and two latent defects on the Python path — a
host-teardown mechanism the design describes but the code does not implement,
and a liveness watchdog that can be blocked by the GIL — which are reasoned from
the code rather than observed, and must be confirmed before any Python stage
runs. Both are itemised in `tmp/tables-decision.md` §5.

The sidecar's environment is an allow-list (`hostEnv()`), so the gateway
credential cannot reach a Python child; `npm run verify:sidecar` asserts this
from inside the child rather than trusting the call site.

## Signing — configured, never attempted here

Local unsigned builds work everywhere. Signing activates only when credentials
are present in the environment.

**macOS** — the user must supply:
- an **Apple Developer ID Application** certificate in the login keychain (or
  `CSC_LINK` = path/base64 of a `.p12` plus `CSC_KEY_PASSWORD`);
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` (an app-specific password, not the
  account password), `APPLE_TEAM_ID`;
- `npm i -D @electron/notarize`.

`scripts/notarize.cjs` (the `afterSign` hook) is a **no-op unless all three
env vars are set** — otherwise a Linux or unsigned build would fail on a
dependency it will never use. Hardened runtime is on and
`build/entitlements.mac.plist` grants `disable-library-validation` (needed for
runtime-loaded SQLite extensions and shipped helper binaries) plus the JIT
entitlements Electron requires. That entitlement is process-level and does NOT
weaken the renderer CSP. **Add every spawned helper binary to `mac.binaries`**
as it lands: the signer does not reliably find bare executables and a missed one
fails notarization late.

**Windows** — the user must supply a code-signing certificate: `WIN_CSC_LINK`
(path or base64 of a `.pfx`) and `WIN_CSC_KEY_PASSWORD`. Without them the nsis
installer is produced unsigned and SmartScreen will warn on first run.

Never commit certificates or keys; `.gitignore` refuses `*.p12/*.pfx/*.pem/*.key`
and the packaged `files` allowlist excludes them from the artifact as well.

## Verification status

| platform | target | status |
|---|---|---|
| Linux x64 | AppImage, deb | **BUILT AND LAUNCHED** — app opens onto its first-run state against an empty database (an install seeds nothing), and renders papers once one is seeded into that path; better-sqlite3 loads from `app.asar.unpacked`; offline checks pass; runs under `unshare -n`. **Payloads exercised in the packaged tree with the network blackholed**: qpdf optimized a real 8-page paper (13.8% saved, page count unchanged), vec0 loaded into this build's better-sqlite3 and returned correctly ordered k-NN, the model produced a normalised 384-dim vector ranking a related query above an unrelated one, tesseract read rendered text from the local traineddata with nothing downloaded. |
| Windows x64 | nsis | **BUILT, NOT RUN.** Cross-built from Linux; `corpus-studio-Setup-0.1.2.exe` produced. Contents verified: `better_sqlite3.node` is `PE32+ x86-64` (upstream's electron-v130 win32-x64 prebuild, staged by `beforePack` — electron-builder cannot rebuild it here), `vec0.dll`, and `qpdf.exe` beside its four DLLs. Only the win32 onnxruntime dir ships. NOT verified: nothing has been installed or launched on Windows. Known open item: `onnxruntime.dll` needs the **VC++ 2019+ redistributable**, which electron-builder does not bundle. Unsigned — SmartScreen will warn. |
| macOS x64/arm64 | zip (dmg needs a Mac) | **BUILT, NOT RUN, UNSIGNED.** Cross-built from Linux: `Corpus Studio-0.1.2-mac.zip` (x64) and `-arm64-mac.zip`. Contents verified per arch: `better_sqlite3.node` is `Mach-O x86_64` / `arm64` respectively, the matching `vec0.dylib` ships, only the darwin onnxruntime dir is present, and `CFBundleName` really is `corpus-studio` (so userData does not move). The **dmg is NOT produced here** — `dmg-builder` needs `hdiutil`/`sips`. **qpdf is still NOT provisioned** (building one needs a Mac), so `optimize` reports `skipped`; add both `bin/darwin-*/qpdf` paths to `mac.binaries` in the same commit that first provisions them. Unsigned and un-notarized, so Gatekeeper WILL quarantine it on another Mac. To re-check on a Mac: that the hardened runtime accepts the entitlements, and that `db.loadExtension()` accepts `vec0.dylib` — `disable-library-validation` is granted for that, but signing the dylib with the same Developer ID is preferable. |

Separate per-arch DMGs are used rather than a universal build on purpose: a
universal app requires lipo-merging `better_sqlite3.node`, which regularly fails
for native addons.
