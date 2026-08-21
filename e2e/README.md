# Corpus Studio — E2E suite (Playwright for Electron)

End-to-end tests that drive the **built** Electron app (`out/main/index.js`) via
`_electron.launch`, asserting DB-backed state through `window.api`.

## Running

```bash
# Build once, then run the whole suite headlessly under xvfb (no display needed):
npm run test:e2e            # == npm run build && xvfb-run -a playwright test

# Local dev with a real display (no xvfb):
npm run test:e2e:headed

# A single spec:
xvfb-run -a npx playwright test e2e/shell.spec.ts
```

`CI=1` selects the CI reporter set. The suite runs with 2 workers.

## Fresh DB per test run

Every test seeds its **own** SQLite DB in a per-run temp path
(`test-results/db/<uuid>.sqlite`) and launches the app with `CORPUS_DB_PATH`
pointing at it. Seeding goes through the **electron-as-node** invocation
(`ELECTRON_RUN_AS_NODE=1 electron --import tsx scripts/run-seed.ts --fresh`) so
`better-sqlite3` uses the same Electron ABI as the app. The DB (and WAL sidecars)
is removed on teardown. See `e2e/helpers/electron.ts` (`seedDb`, `launchApp`,
`closeApp`, and the `launch` fixture).

The stress spec seeds a large corpus (thousands of works) via
`scripts/seed-stress.ts` (`launch('stress')`).

## Artefacts on failure

Configured in `playwright.config.ts`:

- **trace**: `retain-on-failure` — `test-results/**/trace.zip`
  (`npx playwright show-trace <path>`)
- **video**: `retain-on-failure`
- **screenshot**: `only-on-failure` — plus the fixture writes `failure.png`
- **HTML report**: `playwright-report/` (`npx playwright show-report`)

`test-results/` and `playwright-report/` are gitignored.

## Specs

| spec | asserts |
|------|---------|
| `shell` | launch, sidebar, title, navigate to every screen, no genuine console errors |
| `projects` | cards match `listProjects`, wizard creates + persists across reload |
| `graph` | bounded nodes, shown-of-total, legend, expand-node, save/resume frontier |
| `ranking` | relevance≠expansion columns, sort reorders, exclude persists, override persists |
| `paper` | provenance fields, superseded distinct, 5 fact kinds, citation raw bib + confidences, global/project split, abstract-only badge |
| `pdf` | `readPdf` null → graceful `pdf-nofile` state |
| `extraction` | rows + status chips, fold comparability class, show-more pagination |
| `review` | only uncertain/conflict facts; empty state for a clean project |
| `ingest` | ingest enqueues a job; retry/cancel change status + persist |
| `search` | known-term results, facet buckets+counts, no-results state, saved search |
| `integrations` | Zotero/Obsidian status, base dirs + reachability, export JSON parses |
| `empty-states` | new empty project renders empty states everywhere; `.sk` skeleton css present |
| `stress` | thousands of works: graph bounded, ranking not fully rendered, nav responsive |
| `regression` | seed-only DB returns data, one current run per key, two distinct scores |

## Known coverage gap: the external paper search

The `search` spec covers search over the CORPUS (the DB). Search for papers the
corpus does NOT have — the `websearch` panel on Papers — is asserted only as far
as `shell.spec` rendering its input. Nothing exercises a real query end to end.

That is deliberate. The only search source is `WebSearchServerSource`, which
talks to the MCP web-search server, which fans out to CrossRef/PubMed/arXiv. A
spec that drove it would need the network, and the suite must run offline. The
alternative — a fake source the app could select — is exactly what was removed,
and `verify:offline` now refuses to let one back in.

What is therefore NOT covered by any automated test:

- normalisation of a real upstream hit (`normalize.ts`) against live payloads;
- the registry's dedup / scoring / filter / sort / cap over real multi-source
  results;
- the honest-failure path: an unreachable server must reject with "Search
  unavailable — the web-search server at … is not reachable", and the panel must
  render `error-state` with a working Retry — NEVER the "Nothing found." empty
  state, which would claim the query was answered.

Closing this needs a canned-response seam under `scripts/testing/` (the pattern
the LLM verification harness uses) that the shipping app cannot reach — a
recorded MCP transport injected by the harness, not a registrable source.

## Known product finding

The renderer ships a CSP with `font-src 'self'` but bundles fonts as base64
`data:` URLs, so Chromium logs `Refused to load the font … font-src 'self'`.
This is cosmetic (fonts fall back) — `shell.spec` filters this specific message
and still fails on any genuine runtime error.
