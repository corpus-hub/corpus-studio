# Corpus Studio — project instructions & architecture

Local-first **Electron** desktop app for scientific-literature exploration: a
scientific evidence & citation graph with provenance-tracked, versioned AI
analyses. Enzyme-engineering is the seed domain; the core is domain-general.

These instructions OVERRIDE default behavior. Read them before changing code.

**Deeper docs live next to their code and load when you open that tree** —
`src/main/plugins/CLAUDE.md` (the plugin host + trust model).
Each plugin carries its own, next to its source.
Packaging and cross-building are in `docs/packaging.md` — read it before
touching `electron-builder.yml` or anything in `scripts/` that it hooks.

---

## HARD RULES (enforced by audits + e2e — do not violate)

### 0. NEVER leave a comment describing removed code
When you delete something, delete it. No tombstones:

```tsx
// ✗ NEVER
{/* No schema filter chips: each schema already renders its own section. */}
{/* Zoom controls removed: they had no onClick. */}
// `provider` no longer has its own cell (it duplicated MODEL).
```

The rationale belongs in the COMMIT MESSAGE, which is where someone asking "why
did this go?" will actually look (`git log -S`, `git blame`). In the file it is
noise that describes code which is not there, ages badly, and grows until the
file is a changelog. Comments about non-obvious behaviour that IS present are
still welcome — this rule is only about narrating deletions.

### 0.5. Style EVERY state of an interactive element, unprompted
You own the WHOLE state space of anything you add or touch, not just the state
you were fixing: `default · hover · active/pressed · focus-visible · disabled ·
busy/in-flight · selected · error/failed` **and the meaningful combinations**
(selected+hover, failed+selected, in-scope+hover…).

- **Every state must be visually DISTINCT from every other.** Two states that
  render identically are a bug — hovering a selected card that looks exactly like
  a selected card tells the user their pointer is dead. Where the space is
  non-trivial, write a throwaway script that resolves the style for every
  combination and asserts no two are equal; this caught `picked+hover === picked`
  and `failed+picked === picked`, which eyeballing missed.
- **Nothing snaps.** Ease in-out, ~150ms for pointer-tracking feedback, ~250ms for
  ambient emphasis. CSS `transition`; on canvas a self-stopping rAF ticker whose
  velocity is smallest at both ends. An always-on rAF loop is not acceptable.
- **Never signal by colour alone** — pair with weight, ring, outline or opacity,
  so the state survives a colourblind reader and a low-contrast panel.
- **Reuse the existing tokens and base classes.** `className="btn-primary"`
  WITHOUT the base `btn` renders a raw unstyled browser button — this shipped. A
  colour that is not a token becomes a named token.
- Disabled must look disabled AND explain itself (`data-tip`), never just fail to
  respond.

A half-styled control is unfinished work, not a follow-up ticket. Do not wait to
be asked to "make it smooth".

### 0.6. A badge announces the EXCEPTION, never the normal case
If a state is what the user expects, say nothing.

```tsx
// ✗ NEVER — "full text" is what a summary is supposed to be read from
<span className="badge badge-ok">read: full text</span>
<span className="badge badge-ok">On this computer</span>

// ✓ the shortfall, and only the shortfall
{abstractOnly && <span className="badge badge-warn">read: abstract only</span>}
{dir.reachable !== true && <span className="badge badge-danger">Unreachable</span>}
```

WHY. A badge that appears on everything stops being read, and takes the warning
next to it down with it: if nine summaries say "full text" in green, the tenth
saying "abstract only" is just another chip in a row of chips. Silence is what
gives the exception its force. Already applied to storage locations ("On this
computer"/"Reachable" removed; only `managed`, non-local and unreachable show)
and to the queue's skipped stages. Apply it to anything new WITHOUT being asked.

The exception to the exception: a state the user must ACT on may show even when
common — a failure count, an unresolved review. The test is not "is it rare" but
"does the reader have to do something about it".

### 0.7. EVERY commit subject declares a version category — or no build happens
The first stage of the pipeline reads the commit subject and bumps
`package.json`. A subject that declares no category **FAILS the pipeline**, so
nothing is versioned, tagged, built or mirrored. This is not a style preference:
it is the only input the release has.

```
breaking change: <what>   → MAJOR   an upgrading install may lose or change
                                    behaviour it relied on — schema, the IPC
                                    contract, on-disk layout, a removed capability
feat: <what>              → MINOR   new capability, nothing existing taken away
fix: <what>               → PATCH   existing behaviour made correct
chore: <what>             → PATCH   no behaviour change — docs, CI, deps, refactor
```

A scope is allowed (`feat(graph): …`) and `!` marks a breaking change of any
category (`fix!: …` → major), outranking the word in front of it. Matching is
case-insensitive. **The rest of the subject still has to say what changed** in
this repo's voice — the prefix is added to that sentence, it does not replace
it. `chore(release): x.y.z` is reserved for the commit CI writes itself, and is
the one subject that bumps nothing.

WHY the pipeline refuses rather than defaulting to a patch: a default is how a
breaking change ships as a patch. Every installed copy then takes it as routine,
and the first anyone hears of it is a user whose data no longer opens. A failed
pipeline costs one amended subject line.

The categories and the arithmetic live in `scripts/bump-version.mjs` — run
`node scripts/bump-version.mjs --print "<subject>"` to see what a subject would
produce without writing anything.

### 1. Seed-only-DB mock rule
ALL mock/sample data lives ONLY in the SQLite DB, inserted by `src/main/db/seed.ts`
(run via `scripts/run-seed.ts`) — the ONE place allowed to contain sample literals.
- NO hardcoded domain data in React components, NO `.json`/`.yaml`/`.js` fixture
  files standing in as "real data", NO inline sample arrays of works/papers/
  measurements/facts in the UI or in IPC handlers.
- The renderer reads data EXCLUSIVELY through `window.api` (typed IPC), which
  reads the DB in main. Tests get their data by seeding a fresh DB.
- Even the mock LLM pipeline PERSISTS to the DB (`analysis_run` + `evidence_span`
  + `fact` + `measurement` + `fold_improvement`) with full provenance and reads
  canned responses from `mock_llm_response` — it never returns literals to the UI.
- Enforcement: the audit gate greps `src/renderer` + main handlers for literal
  domain arrays.

### 2. Local-first / offline / no-CDN / no-eval
- Vendor ALL frontend deps locally (React, d3, pdfjs, fonts via `@fontsource`).
  NO CDN, NO Google Fonts, NO in-browser Babel, NO `eval`/`Function` app code.
- `pdf.worker.min.mjs` is bundled via
  `new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url)`.
- CSP (prod): `default-src 'none'; script-src 'self'; style-src 'self'
  'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self';
  object-src 'none'; base-uri 'none'; frame-ancestors 'none'`. **No
  `'unsafe-eval'`** — dev adds `ws://localhost` for HMR only. pdf.js probes
  `new Function("")` inside a try/catch, so under our CSP it simply disables its
  optional eval path and the viewer works.
- Fonts are file assets, never `data:`: `electron.vite.config.ts` forces
  `assetsInlineLimit=false` for `woff/woff2/ttf/otf`, because `font-src 'self'`
  would refuse an inlined `data:` URI and the app would silently fall back to
  system fonts.
- The app must run with networking disabled. Offline audit: grep built `out/` for
  `https?://(cdn|unpkg|jsdelivr|googleapis|fonts.google|cdnjs)` — must be empty.

### 3. Data ontology (implement faithfully)
- WORK (abstract output) vs DOCUMENT (a concrete PDF/version) are distinct.
- Paper stored ONCE globally; project-specific interpretation stored SEPARATELY in
  `project_work` (relevance, expansion_priority, inclusion_status, notes,
  overrides, ranking_explanation). `analysis_run.project_id = 0` is the global
  sentinel; a real project id = project-specific. Never put project interpretation
  on the global `work`.
- Provenance on every AI result: `analysis_run` carries model, provider,
  prompt_version, schema_version, run_timestamp, verifier_result,
  deterministic_validation, supplied_project_context, user_corrections,
  superseded, and input hashes (doc/prompt/schema/dossier) for stale detection.
- Analysis versioning: partial-unique index
  `UNIQUE(work_id, project_id, analysis_type) WHERE superseded=0` guarantees ONE
  current run per key. Regeneration = supersede-then-insert in ONE transaction
  (`src/main/llm/pipeline.ts`).
- `fact.kind` 4-enum: `directly-reported`, `inferred`,
  `supplied-by-project-context`, `uncertain-conflicting`. **If the paper does not
  state a value for a field, NO fact is emitted for it** — never a conventional
  or assumed one. There was a fifth kind, `assumed-from-field-convention`; it
  licensed the model to state a value the paper never printed inside a pipeline
  whose whole claim is that every value is anchored, and it was removed at v49.
- **An extraction-schema field `description` DECLARES WHAT THE FIELD IS** — its
  quantity, unit, basis and what distinguishes it from its neighbours. It is
  NEVER an instruction to the model, even though the string does reach the model.
  Behaviour belongs in `prompts.ts`, which is versioned and stamped onto every
  run; scattered across field descriptions it cannot be reviewed or applied
  consistently. One such line ("mark as assumed-from-field-convention if only
  implied") is how the corpus filled with temperatures no paper printed.
- `fold_improvement.comparability` 4-enum: `directly`, `broadly`, `contextual`,
  `unclear`. Preserve raw value/unit before normalization.
- Two DISTINCT rankings: `relevance` vs `expansion_priority` (never fused). Each
  has a stored `ranking_explanation`; user overrides persist in `user_overrides`.
- Raw citation text preserved (`citation_context.raw_bib_text`); unresolved
  references live in `unresolved_reference` and ARE surfaced in the Paper screen
  (never silently dropped). DOI is NOT mandatory.
- Content-status enum distinguishes fulltext / abstract-only / metadata-only;
  abstract-only analyses are badged, never presented as full-text-backed.

---

## Architecture

```
Electron main (Node)                 preload (contextBridge)      renderer (React)
─────────────────────                ──────────────────────      ────────────────
better-sqlite3 (WAL)                 exposes window.api  ───────► screens/* read
  src/main/db/{schema,migrate,          = CorpusApi                only via window.api
    connection,repositories,seed}                                 components/PdfDocView
  src/main/adapters (mock providers)                              (pdfjs, offline worker)
  src/main/llm/{provider,segment,     IPC channels 'domain:action'
    prompts,pipeline,queue}           zod-validated in main
  IPC handlers (src/main/index.ts)
```

- **DB boundary:** the renderer has no Node access (`contextIsolation:true`,
  `nodeIntegration:false`, `sandbox:true`). All data crosses via the typed,
  whitelisted `window.api`. The frozen contract is `src/shared/contract.ts`
  (`interface CorpusApi` + all DTOs) — add a method THERE first, then main IPC +
  preload + repositories.
- **DB file stays LOCAL, never on a NAS** (WAL corrupts on network FS). Only PDFs
  live on a NAS, addressed via `base_dir` (a mount root row) +
  `file_location.relative_path`, so a NAS remap is one row and differing OS mount
  points work later.
- **LLM pipeline** (`src/main/llm/`, ported in spirit from `ai-detector`, see
  `tmp/ai-detector-port-map.md`): `provider.ts` (pluggable; `MockLlmProvider`
  reads `mock_llm_response`; reused 1:1 — `extractJson` fence-strip +
  brace-balanced scan, `withRetry` 4 attempts with backoff, global
  `BoundedSemaphore(2)`); `segment.ts` (paragraphs with the exact-slice offset
  contract `text.slice(charStart,charEnd) === para.text`, `Intl.Segmenter` for
  sentences — this underpins evidence-span anchoring); `prompts.ts` (versioned
  prompt + zod schema registry, stamps `prompt_version`/`schema_version` onto
  every run); `pipeline.ts` (segment → prompt → callLLM → extractJson → validate →
  persist, supersede-then-insert txn); `queue.ts` (durable job queue on
  `processing_job`: claim/lease, `resumePending` on startup, retry/cancel).
- **PDF viewer** (`src/renderer/components/PdfDocView.tsx`, ported ~1:1 from
  ai-detector): pdfjs render loop, selectable text layer with `--scale-factor`,
  scroll-driven page badge via the `currentPageRef` no-render trick, whole-document
  canonical text index, `locate()` (text-probe + `frac` disambiguation + geometric
  `region` anchor), span-ownership `buildBands()` with `data-ann-ids` union,
  chunked cancelable draw, click hit-test, poll-scroll-to-active, and
  `onAnchoredIds` (the navigability invariant). Only change from source: bytes
  come from `window.api.readPdf(documentId)`; a null result renders a graceful
  "PDF not available". Highlights are built from the selected run's
  `EvidenceSpanDTO[]` (`quote` → needle, `page` → scope).

### Semantic search: sqlite-vec is REQUIRED, and `strategy` is a measurement

**sqlite-vec is a hard dependency of opening a corpus at all, not a feature.**
`loadSqliteVec()` runs on EVERY connection that opens a CORPUS — app handle,
read-only vector worker, electron-as-node scripts, fixtures and verify scripts —
and THROWS `SqliteVecUnavailableError` when it cannot. **Never add a degraded
path.** A Zotero library or a lock file is a different database and is not
covered. The reasoning is in the header of `src/main/db/sqliteVec.ts`; the short
version is that every fallback fails far from its cause.

**A scan of every vector in scope is CORRECT, not a degradation**, chosen by two
accuracy arguments. NARROW scope (`scopedChunks <= EXHAUSTIVE_SCAN_MAX_CHUNKS`):
`vec0` ranks the whole space and the work filter is applied to its answer, so one
paper's best passages can sit outside the library-wide top-N and be discarded —
over-fetching widens that window but cannot close it, and scanning is cheap
precisely because the scope is narrow. UNNORMALISED space, at any scope: `vec0`
recovers a true cosine from its L2 distance only for unit vectors. A corpus-wide
`exhaustive` therefore means the second condition, not a bug.

**`strategy` reports which path RAN** — two values rather than a boolean, because
one flag once stood for both "an index was used" and "an index exists", so a
deliberately exhaustive one-paper search logged that sqlite-vec was unavailable
and sent hours of debugging at a healthy extension. Never conflate a choice with a
capability in one field, and never default the value when absent: a guess
presented as a measurement is the same failure. `SemanticSearchResultDTO.strategy`
adds `null` meaning strictly "no query ran" (empty text, no space, an error) —
never "we did not look".

Coverage has the same trap: `spaceCoverage.indexed` says the `vec0` TABLE exists,
which is not the same as covering the corpus. `unindexedChunks()` compares the two
counts and startup names any shortfall — a chunk with no vector is invisible to
every query while the corpus reports itself embedded.

`npm run verify:vector` guards all of it, with two negative controls: the index's
over-fetch window really does drop the scoped paper, and the missing-vector
detector really does fire.

### Searching the outside world, and fetching PDFs, are PLUGIN capabilities

**The app cannot do either by itself, and says so.** Both happen inside the user's
own browser, through a plugin and a companion browser extension, because
publishers serve a JS challenge that cannot be satisfied from outside a real
browser and several indexes refuse a server outright.

- `paper-search` gates the Ingest screen's "Search for new papers" TAB and the
  `search_web` MCP tool. Both are ABSENT when nothing offers it — not disabled,
  not failing: absent, because that is what is true.
- `paper-retrieval` gates `document.retrieve@v1`, which reports `skipped` with a
  reason rather than `refused` — the latter is a claim about the paper, and an
  install that never looked has not made one.
- Importing by DOI/PMID/arXiv id and from a local PDF are CORE and need no
  plugin. They were once sub-tabs of the same tab as the web search; splitting
  them is what stops the capability taking offline DOI import away with it.

Both are DERIVED from the verbs the loaded module offers, dispatched by capability
at call time, and named by nothing in the app: `PAPER_SEARCH_OFF_SENTENCE` /
`PAPER_RETRIEVAL_OFF_SENTENCE` in the contract are matched by identity on both
sides. The plugin documents its own half; the extension is a SEPARATE repo with
MV3 constraints that are not guessable, and carries its own notes.

### Plugins

A plugin is a FOLDER the app `require`s into the MAIN process, so **there is no
trust boundary after install**. The renderer and main both gate on declared
CAPABILITIES, never on a plugin id, and every plugin-authored string is shaped at
the boundary. Full rules: `src/main/plugins/CLAUDE.md`.

**Every plugin can be removed, including the two the app ships.** A bundled folder
cannot be deleted — it is inside the installation, often root-owned, and replaced
wholesale by an update — so removing one writes `plugin.<id>.removed` and
discovery skips the id before reading its manifest. That survives a restart AND an
update that re-ships the folder, and Settings → Plugins has a "Removed" section to
put one back. There is no such thing here as a part of the app the user may not
take out; what differs is only what removal means on disk.

---

## How to run / seed / test

### GATES ARE OFF, AND BROWSER AUTOMATION IS FORBIDDEN

**Do NOT run `npm run test:e2e`, `npx playwright test`, `npm run typecheck`, or
any `verify:*` gate as part of normal work.** Run them ONLY when the user asks for
them by name, in that request. "I changed something risky" is not an exception;
neither is "it will only take a minute".

**TESTS ARE A FINAL TOUCH, NEVER A STEP IN THE LOOP.** They belong at the END of a
body of work, once the thing is built and the user has said they want it checked —
never after each iteration, never between the steps of one task. The
implement→test→implement rhythm turns a twenty-minute change into an afternoon
while the user waits on output they did not ask for.

**Do NOT use `playwright-mcp` or any browser-automation MCP tool here.** Those
servers open REAL browsers on the user's REAL `DISPLAY`, steal keyboard focus, and
nothing tears them down — the user found SIX alive at once, the oldest for 5.5
hours, all launched by agents who just wanted to "look at the app".

**Do NOT hand-roll e2e instrumentation** — no ad-hoc `_electron.launch` harnesses,
no throwaway specs to verify one change, no "probe"/"sweep" scripts driving the
UI. Unless the user directly asks.

**The whole verification loop, and it is enough:**
- `npm run build` — cheapest signal; run it first.
- `npm run shot <screen>` and then READ the PNG. It is xvfb-wrapped, so it never
  touches the user's display. Visual verification repeatedly caught bugs the suite
  missed — a blank UI from a DB-path mismatch, a decorative drag handle with no
  handler, fact-kind badges silently falling back to grey. Options and its two
  traps (it shows the BUILD, not the user's window; never relaunch from inside it)
  are in the header of `scripts/shot.ts`.
- `scripts/relaunch.sh` (= `npm run relaunch`) — ALWAYS use this to restart the app
  in the user's own window, as a SEPARATE command after a build they will look at.
  Never bare `npm start`, never `pkill … & npm start`. Why, in the script header.
- `npm run seed:fresh` when the schema/seed changed.

**Orphan hygiene.** If you used anything that spawns processes, check before
reporting done — orphaned `Xvfb` servers from parallel agent runs wedged this
machine and produced 59 phantom "flakes" in one run:

```bash
ps -eo pid,etime,cmd | grep -E 'playwright-mcp|Xvfb|playwright test' | grep -v grep
```

```bash
npm install                 # postinstall runs electron-rebuild for better-sqlite3

# Seed the DB (better-sqlite3 is Electron-ABI → seed runs via electron-as-node)
npm run seed                # into <userData>/corpus.sqlite (or $CORPUS_DB_PATH)
npm run seed:fresh          # delete + rebuild the SAME file `npm start` opens
npm run seed:stress         # 3000-work / 10000-edge corpus
CORPUS_DB_PATH=./data/corpus.sqlite npm run seed:fresh   # repo-local DB

npm run build               # electron-vite build → out/
npm run dev                 # launch with HMR (needs a display)
scripts/relaunch.sh         # rebuild + restart in the user's window
npm run shot <screen>       # headless screenshot of one screen

# Distributables. All three platforms build from THIS Linux host.
npm run dist:linux          # AppImage + deb
npm run dist:win            # nsis installer
npm run dist:mac            # zip x64 + arm64 (a dmg needs a Mac; the zip is a
                            # complete .app). Needs `cargo install apple-codesign`:
                            # without an ad-hoc signature macOS refuses to launch
                            # the arm64 build outright.

# ON REQUEST ONLY — never as part of normal work
npm run typecheck           # main+preload (node) and renderer (web)
npm run verify:backend      # repositories + LLM pipeline against the seeded DB
npm run verify:vector       # sqlite-vec loads in both hosts; `strategy` is honest
npm run verify:sharing      # the sharing plugin's own node --test suite
npm run test:e2e            # builds, then runs the suite on a virtual display
npm run test:e2e:headed     # opt in to watching it on YOUR display
```

If the user does ask for the suite, run it SERIAL (`-- --workers=1`): parallel
workers produce environmental launch-timeout flakes that look like real failures.
When a spec and the code disagree, work out which one is wrong — do NOT assume the
test is at fault and edit it to pass.

**The suite can never open a window on your screen.** `globalSetup` provisions a
virtual display before the workers fork and `launchApp` pins Electron to it rather
than inheriting `DISPLAY`, so a bare `npx playwright test`, a single spec from an
IDE and a debugger session are all covered; if none can be obtained the run FAILS
rather than falling back to your screen. `e2e/display.ts` has the details.
Watching it must be asked for (`CORPUS_E2E_HEADED=1`). `relaunch.sh` and
`npm start` are unaffected — those are for you to look at.

### The DB path, and empty vs broken

- **ONE default DB path.** App, `seed`/`seed:fresh` and `verify:backend` all
  resolve it via the shared `defaultDbPath()` (`src/main/db/paths.ts`) —
  userData/`corpus-studio`/`corpus.sqlite`, computed WITHOUT electron's `app` so
  it works under `ELECTRON_RUN_AS_NODE`. So `seed:fresh` seeds EXACTLY the file
  `npm start` opens. Do NOT reintroduce a bespoke path: app→userData,
  seed→`.corpus-data`, verify→`data/` once diverged and `npm start` rendered blank.
  `CORPUS_DB_PATH` overrides it (tests use this for isolation).
- **A fresh install starts EMPTY.** No projects, papers or analyses; launch seeds
  NOTHING. A scientist's install must contain their work and nobody else's, so the
  sample corpus is a DEVELOPMENT AND TEST fixture only — reachable via
  `npm run seed*` and the e2e fixtures, and NOT packaged (`electron-builder.yml`
  ships no `scripts/data/*.json`; `ke07-corpus.ts` and `shipped-analyses.ts`
  resolve only from a repo checkout).
  - So EVERY screen needs a designed empty state, and anything that cannot work
    without papers is disabled WITH a `data-tip` saying why (HARD RULE 0.5). Data a
    running install genuinely needs is not sample data and belongs in a MIGRATION —
    `llm_model` moved there (v24) after an empty install left the user with no
    selectable model.
- **Telling "correctly empty" from "broken empty".** The blank-UI regression is a
  WRONG PATH, not an empty screen, so launch LOGS what it opened:
  `[main] db ready path=… projects=N works=N`. Assert on the path and on the DB
  having been migrated (its tables exist), NEVER on row counts being non-zero.
  `e2e/smoke-real-launch.spec.ts` still asserts seeded projects and is therefore
  wrong: it must launch with no `CORPUS_DB_PATH` (temp `XDG_CONFIG_HOME` only),
  assert first-run state at `defaultDbPath()`, then assert that seeding THAT path
  and relaunching shows the data.
- E2E fixtures seed a fresh DB per test via the electron-as-node seed path;
  traces/videos/screenshots on failure go to `test-results/`. `e2e/stress.spec.ts`
  asserts the graph and ranking stay bounded on the stress corpus (no silent hide;
  ranking paginates at 50/page with "showing X of Y").

---

## Key decisions & WHY (running log: `tmp/build-notes.md`)

- **Electron + React + TS + electron-vite, better-sqlite3 in main.** One offline
  stack; synchronous SQLite in main is simplest for a local desktop app.
- **Ported ai-detector's PDF viewer + LLM pipeline** rather than rebuilding — the
  anchoring engine and the retry/extractJson/queue patterns are proven. Adapted
  Python→Node (`Intl.Segmenter`, queue Postgres→SQLite, requests→fetch) and
  IMPROVED with a versioned prompt/schema registry stamped onto provenance.
- **Frozen IPC contract** (`src/shared/contract.ts`) let backend and renderer be
  built in parallel and integrate cleanly.
- **project_id=0 sentinel** (not NULL) for global runs: SQLite treats NULLs as
  distinct in unique indexes, which would break the one-current-run guarantee.
- **CSP without `unsafe-eval`** kept even though pdf.js probes `new Function`.
- **DB local, PDFs on NAS via base_dir+relative_path** — WAL is unsafe on network
  filesystems; the indirection allows differing OS mount points later.
- **Single shared `defaultDbPath()`** so "seed once → launch → see data" always
  holds for a DEVELOPER, byte-identical between the GUI app and the CLI scripts.
  The launch log naming that path is what makes a mismatch visible now that an
  empty screen is a legitimate outcome.

## Where to add things
- New data view: DTO + method in `contract.ts` → repository fn → zod-validated IPC
  handler in `main/index.ts` → preload → a screen using the `DataView`/`useAsync`
  loading/empty/error pattern.
- New analysis type: register a prompt+schema version in `llm/prompts.ts`; the
  pipeline persists it with provenance automatically.
- Never bypass the DB, never fetch from a CDN, never add `eval`/`unsafe-eval`,
  never put project interpretation on the global `work`.
