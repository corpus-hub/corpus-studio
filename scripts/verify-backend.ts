// Backend verification harness. Runs via electron-as-node (same better-sqlite3
// abi as the app). Seeds a FRESH throwaway DB (hermetic + idempotent — this
// harness MUTATES state: it runs the pipeline, resolves an unresolved ref,
// recomputes rankings, etc., so re-running against the same DB would fail on the
// second pass), calls a sampling of repository functions, asserts non-empty
// correctly-shaped data, then drives the LLM pipeline once end-to-end and
// asserts a NEW analysis_run + facts + evidence_span were inserted and the prior
// current run got superseded=1.
//
// Run: npm run verify:backend      (uses its own temp DB; nothing to pre-seed)
// CORPUS_DB_PATH still overrides the location if you want to inspect the result.

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { initDatabase, setDb, closeDb } from '../src/main/db/connection'
import { defaultDbPath } from '../src/main/db/paths'
import { seed } from '../src/main/db/seed'
import {
  listProjects,
  getGraph,
  getReferenceTree,
  getRanking,
  getWorkAnalyses,
  getReviewQueue,
  getExtractionRows,
  getFacets,
  search,
  countSearch,
  markReferencePaper,
  getDossier,
  getDossierStatus,
  getDossierStaleWorks,
  buildDossierContext,
  resolveUnresolvedReference,
  retrieveUnresolvedReferences,
  getReferenceRetrievals,
  settleReferenceRetrievals,
  referenceRetrievalTarget,
  getExtractionStatusSummary,
  overrideScore,
  listExtractionSchemas,
  createExtractionSchema,
  deleteExtractionSchema,
  createExtractionField,
  updateExtractionField,
  deleteExtractionField,
  listProjectSchemas,
  attachProjectSchema,
  detachProjectSchema,
  getSchemaCoverage,
  exportProject
} from '../src/main/db/repositories'
import { FACT_KINDS } from '../src/renderer/lib/format'
import { renderToHtml, unescapeMarkup } from '../src/shared/markup'
import { ScriptedLlmProvider } from './testing/recordedProvider'
import { runPipeline } from '../src/main/llm/pipeline'
import { buildDossier } from '../src/main/llm/dossier'
import { buildReviewQuestions } from '../src/main/llm/review'
import { segment } from '../src/main/llm/segment'
import { getPrompt } from '../src/main/llm/prompts'
import { hashInput } from '../src/main/adapters'
import { findStaleParses, rematchUnresolved, PARSER_VERSION } from '../src/main/citations/store'
import { referenceIdentityKey } from '../src/main/citations/normalize'
import { normalizeTitle } from '../src/main/search/normalize'
import { recordScores, scoringSets } from '../src/main/rerank/store'
import { plainText } from '../src/shared/markup'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++
    // eslint-disable-next-line no-console
    console.log(`PASS  ${name}${detail ? '  — ' + detail : ''}`)
  } else {
    fail++
    // eslint-disable-next-line no-console
    console.error(`FAIL  ${name}${detail ? '  — ' + detail : ''}`)
  }
}

// Guard against the renderer's fact-kind taxonomy drifting from the DB's CHECK
// constraint. They HAD drifted (the UI listed measured/reported/derived, none of
// which are storable), so three of the kinds silently rendered as the grey
// "unknown" fallback — an `inferred` claim looked identical to an unrecognised
// one, defeating the whole point of tagging epistemic status.
function checkFactKindsMatchSchema(): void {
  const stored = FACT_KINDS.map((f) => f.key).sort()
  const constraint = [
    'directly-reported',
    'inferred',
    'supplied-by-project-context',
    'uncertain-conflicting'
  ]
  check(
    'renderer FACT_KINDS match the fact.kind CHECK constraint',
    stored.length === constraint.length && stored.every((k, i) => k === constraint[i]),
    stored.join(',')
  )
}

/**
 * Upstream markup is stripped from prose fields — WITHOUT eating the maths.
 *
 * Crossref and PubMed embed real JATS/HTML in titles and abstracts, and React
 * escapes it, so the reader sees `<i>trans</i>` rather than italics. Stripping
 * happens at the normalisation boundary because the value is also stored, keyed
 * on for dedup, exported and fed to models.
 *
 * The SECOND half of these cases is the one that matters most. `<` is ordinary
 * prose in this domain — `p < 0.05`, `T < 4 K`, `<10 µM` — and the obvious
 * greedy `<[^>]*>` silently deletes from the first `<` to the next `>`, turning
 * "p < 0.05, n > 30" into "p 30". That is data corruption which nothing would
 * report, so the narrow pattern is asserted rather than assumed.
 */
function checkMarkupStripping(): void {
  const cases: Array<[string, string]> = [
    // The reported bug, verbatim from a real corpus row.
    [
      'A Saccharifying Pectate <i>trans</i> -Eliminase of <i>Erwinia aroideae</i>',
      'A Saccharifying Pectate trans -Eliminase of Erwinia aroideae'
    ],
    ['Kinetics of H<sub>2</sub>O<sub>2</sub> decay', 'Kinetics of H2O2 decay'],
    // JATS, which Crossref returns wholesale in abstracts.
    ['<jats:p>Structured abstract</jats:p>', 'Structured abstract'],
    ['<b>Bold</b> and <span class="x">span</span>', 'Bold and span'],
    ['Entities: &amp; &lt; &gt; &quot;', 'Entities: & < > "'],
    ['&#8212; em dash and &#x3bc;M', '\u2014 em dash and \u03bcM'],
    // ONE level of decoding: `&amp;lt;` is a literal `&lt;`, not a `<`.
    ['&amp;lt;not a tag&amp;gt;', '&lt;not a tag&gt;'],
    // Maths that MUST survive.
    ['Significant at p < 0.05, n > 30', 'Significant at p < 0.05, n > 30'],
    ['Stable below T < 4 K and above 10 K', 'Stable below T < 4 K and above 10 K'],
    ['Detection limit <10 µM', 'Detection limit <10 µM'],
    ['5<x<10 range', '5<x<10 range'],
    ['Plain title with no markup', 'Plain title with no markup']
  ]
  const bad = cases.filter(([input, want]) => plainText(input) !== want)
  check(
    'plainText removes upstream markup and leaves inequalities alone',
    bad.length === 0,
    bad.length === 0
      ? `${cases.length} cases`
      : bad.map(([i]) => `${JSON.stringify(i)} -> ${JSON.stringify(plainText(i))}`).join(' · ')
  )
  // The NEGATIVE CONTROL: prove the narrow pattern is doing real work, so a
  // later "simplification" to the obvious greedy form fails here rather than in
  // somebody's corpus.
  check(
    'the naive greedy pattern WOULD corrupt an inequality (why the rule is narrow)',
    'Significant at p < 0.05, n > 30'.replace(/<[^>]*>/g, '') !== 'Significant at p < 0.05, n > 30'
  )

  // THE DEDUP KEY MUST BE BLIND TO MARKUP.
  //
  // Titles are STORED with the publisher's formatting, so the same paper
  // arrives with JATS from Crossref and without it from PubMed. Folding
  // punctuation without stripping tags first turned `<i>trans</i>` into the
  // words `i trans i`, so those two copies keyed differently and entered the
  // corpus as two papers — splitting one paper's citations and analyses across
  // two rows, which is the exact failure `normalizeTitle` exists to prevent.
  const withMarkup = 'A Saccharifying Pectate <i>trans</i>-Eliminase of <i>Erwinia aroideae</i>'
  const withoutMarkup = 'A Saccharifying Pectate trans-Eliminase of Erwinia aroideae'
  check(
    'normalizeTitle keys a paper the same with or without upstream markup',
    normalizeTitle(withMarkup) === normalizeTitle(withoutMarkup),
    `${JSON.stringify(normalizeTitle(withMarkup))} vs ${JSON.stringify(normalizeTitle(withoutMarkup))}`
  )
  check(
    'normalizeTitle does not leak a tag name into the key',
    !normalizeTitle(withMarkup).split(' ').includes('i'),
    normalizeTitle(withMarkup)
  )

  // THE RENDERER'S ALLOWLIST — a security boundary, asserted here because there
  // is no renderer-side unit runner.
  //
  // Titles and abstracts are STORED with the publisher's markup and rendered as
  // real formatting. That is only safe because the parser builds React elements
  // from a closed list of inline tags and never touches `innerHTML`: the text
  // comes from an academic index or a SEARCH PLUGIN — a folder a stranger wrote
  // — so a title is untrusted input rendered into the app's own window.
  // Anything off the list must lose its tags and keep its text.
  const renderCases: Array<[string, string]> = [
    // Formatting that must be PRESERVED — this is why stripping was wrong.
    [
      'A Pectate <i>trans</i>-Eliminase of <i>Erwinia</i>',
      'A Pectate <i>trans</i>-Eliminase of <i>Erwinia</i>'
    ],
    ['H<sub>2</sub>O<sub>2</sub>', 'H<sub>2</sub>O<sub>2</sub>'],
    ['T<sub>m</sub> and x<sup>2</sup>', 'T<sub>m</sub> and x<sup>2</sup>'],
    ['<jats:italic>in vivo</jats:italic>', '<i>in vivo</i>'],
    ['<jats:p>Abstract text</jats:p>', '<span>Abstract text</span>'],
    // INJECTION: every one of these must come back inert.
    ['<script>alert(1)</script>', 'alert(1)'],
    ['<img src=x onerror=alert(1)>', ''],
    ['<a href="http://evil">link</a>', 'link'],
    ['<div onclick="x">text</div>', 'text'],
    ['<iframe src="x"></iframe>', ''],
    // An attribute on an ALLOWED tag is dropped too: the tag is rendered, its
    // attributes are never carried across.
    ['<i class="x" onclick="y">t</i>', '<i>t</i>'],
    // Maths, untouched.
    ['p < 0.05, n > 30', 'p < 0.05, n > 30'],
    ['Detection <10 µM', 'Detection <10 µM'],
    // Malformed markup is common upstream and must neither throw nor lose text.
    ['<i>unclosed', '<i>unclosed</i>'],
    ['stray </i> close', 'stray  close'],
    ['<i><sub>crossed</i></sub>', '<i><sub>crossed</sub></i>']
  ]
  // ESCAPED markup, which some indexes send instead of the real thing.
  //
  // Europe PMC HTML-encodes the JATS inside a title, so the field arrives as
  // `&lt;i&gt;…&lt;/i&gt;`. `TAG_TOKEN` finds no tag, the entities decode as
  // ordinary text, and the reader is shown `H<sub>2</sub>` verbatim in a result
  // row — which is how this reached a user. `unescapeMarkup` resolves it at the
  // ingest boundary so the stored value has ONE shape whichever way an index
  // spells it.
  //
  // The last three are the reason it decides about the WHOLE FIELD rather than
  // about each `&lt;`: promoting every escaped bracket would turn a statistic
  // into markup and let the tag stripper eat the clause after it. These are the
  // negative controls, and they are the point of the test.
  const escapedCases: Array<[string, string]> = [
    ['H&lt;sub&gt;2&lt;/sub&gt;', 'H<sub>2</sub>'],
    ['&lt;i&gt;Caecomyces churrovis&lt;/i&gt;', '<i>Caecomyces churrovis</i>'],
    ['&lt;jats:italic&gt;in vivo&lt;/jats:italic&gt;', '<i>in vivo</i>'],
    // NOT markup: the character. Must survive untouched.
    ['p &lt; 0.05, n &gt; 30', 'p < 0.05, n > 30'],
    // Off the allowlist, so `unescapeMarkup` never promotes it to a tag. What
    // comes back is the decoded TEXT of the tag — `renderToHtml` returns a
    // string rather than escaping for output, so this reads alarming and is
    // not: the renderer builds React elements from the same rules, and React
    // escapes text, so the reader sees the characters and the DOM gets no
    // element. The property being asserted is that it stayed TEXT.
    ['A &lt;script&gt;alert(1)&lt;/script&gt; title', 'A <script>alert(1)</script> title'],
    // Already real markup, so the escaped bracket beside it stays a character.
    ['A <i>real</i> tag and p &lt; 0.05', 'A <i>real</i> tag and p < 0.05']
  ]
  const badEscaped = escapedCases.filter(
    ([input, want]) => renderToHtml(unescapeMarkup(input)) !== want
  )
  check(
    'escaped upstream markup becomes markup, and escaped maths stays maths',
    badEscaped.length === 0,
    badEscaped.length === 0
      ? `${escapedCases.length} cases`
      : badEscaped
          .map(([i]) => `${JSON.stringify(i)} -> ${JSON.stringify(renderToHtml(unescapeMarkup(i)))}`)
          .join(' · ')
  )

  const badRender = renderCases.filter(([input, want]) => renderToHtml(input) !== want)
  check(
    'RichText renders scientific markup and neutralises everything else',
    badRender.length === 0,
    badRender.length === 0
      ? `${renderCases.length} cases`
      : badRender
          .map(([i]) => `${JSON.stringify(i)} -> ${JSON.stringify(renderToHtml(i))}`)
          .join(' · ')
  )
}

async function main(): Promise<void> {
  checkFactKindsMatchSchema()
  checkMarkupStripping()
  // Seed a FRESH, isolated DB so this (state-mutating) harness is hermetic and
  // idempotent. If CORPUS_DB_PATH is set we honor it (so a dev can inspect the
  // post-run DB); otherwise use a throwaway temp file — NEVER the real userData
  // DB, so `npm run verify:backend` never clobbers `npm start`'s data.
  const explicit = process.env.CORPUS_DB_PATH
  const dbFile =
    explicit && explicit.trim()
      ? explicit
      : join(tmpdir(), `corpus-verify-${process.pid}-${Date.now()}.sqlite`)
  // Reseed from scratch every run for determinism.
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbFile + suffix
    if (existsSync(p)) rmSync(p)
  }
  mkdirSync(dirname(dbFile), { recursive: true })
  void defaultDbPath // (kept imported for parity/documentation of the shared path)

  const db = initDatabase(dbFile)
  setDb(db)
  // Populate via the REAL deterministic seed (no literals) before verifying.
  seed(db, { now: process.env.CORPUS_FAKE_NOW })

  // ---- repository shape checks ------------------------------------------
  const projects = listProjects(db)
  // Seed is EXACTLY one project: "KE07 Kemp Eliminase Engineering".
  check('listProjects has the single KE07 project', projects.length === 1, `${projects.length} projects`)
  check(
    'the single project is KE07',
    projects.length === 1 && projects[0].name === 'KE07 Kemp Eliminase Engineering',
    projects[0]?.name
  )
  check(
    'projects carry work_count',
    projects.every((p) => typeof p.work_count === 'number'),
    'work_count present'
  )
  const pid = projects[0]?.id ?? 1

  const graph = getGraph(db, 1, { limit: 200 })
  check('getGraph nodes non-empty', graph.nodes.length > 0, `${graph.nodes.length} nodes`)
  check('getGraph edges non-empty', graph.edges.length > 0, `${graph.edges.length} edges`)
  check('getGraph totals sane', graph.total_works >= graph.shown_works)

  const ranking = getRanking(db, 1, 'relevance')
  check('getRanking non-empty', ranking.length > 0, `${ranking.length} rows`)
  check(
    'ranking descending by relevance',
    ranking.length < 2 || (ranking[0].relevance ?? 0) >= (ranking[ranking.length - 1].relevance ?? 0)
  )

  const analyses = getWorkAnalyses(db, 2, 1)
  check('getWorkAnalyses non-empty (work 2 / proj 1)', analyses.length > 0, `${analyses.length} runs`)
  const current = analyses.find((a) => a.superseded === 0 && a.analysis_type === 'extraction')
  check('current extraction run present', !!current)
  check('current run has facts', !!current && current.facts.length > 0, `${current?.facts.length} facts`)
  check(
    'a fact carries a measurement',
    !!current && current.facts.some((f) => f.measurement != null)
  )
  // Across the CORPUS, not on one hand-picked paper.
  //
  // Whether work 2 in particular yielded a fold improvement is a fact about what
  // a model found in that paper, not about whether the DTO carries folds — and
  // pinning it to work 2 only held while the seed hand-wrote the answer. What
  // must be true is that a fold, where one exists, reaches the caller intact.
  const anyFold = db
    .prepare(
      `SELECT ar.work_id, ar.project_id FROM fold_improvement fi
         JOIN measurement m ON m.id = fi.measurement_id
         JOIN fact f ON f.id = m.fact_id
         JOIN analysis_run ar ON ar.id = f.analysis_run_id
        WHERE ar.superseded = 0 LIMIT 1`
    )
    .get() as { work_id: number; project_id: number } | undefined
  check('the corpus contains at least one fold_improvement', !!anyFold)
  if (anyFold) {
    const foldRuns = getWorkAnalyses(db, anyFold.work_id, anyFold.project_id || 1)
    check(
      'a measurement carries its fold_improvement through to the DTO',
      foldRuns.some((r) => r.facts.some((f) => f.measurement?.fold != null)),
      `work ${anyFold.work_id}`
    )
  }

  const review = getReviewQueue(db, 1)
  check('getReviewQueue non-empty', review.length > 0, `${review.length} items`)
  check('review items carry a reason', review.every((r) => !!r.reason))

  const extraction = getExtractionRows(db, 1)
  check('getExtractionRows non-empty', extraction.length > 0, `${extraction.length} rows`)
  // PRE-supersession coverage snapshot. The pipeline run further down supersedes
  // work 2's rich seeded extraction and replaces it with an unguided (and
  // therefore field-unlinked) run, which legitimately drops coverage to zero. The
  // seeded state is what the UI shows on a fresh install, so assert against this.
  const seedCoverage = getSchemaCoverage(db, 1)
  // Recompute each numerator with an INDEPENDENT query and demand an exact
  // match, here — while the numbers are still non-zero and the check has teeth.
  for (const c of seedCoverage) {
    const truth = (
      db
        .prepare(
          `SELECT COUNT(DISTINCT ar.work_id) AS c
           FROM measurement m
           JOIN fact f ON f.id = m.fact_id
           JOIN analysis_run ar ON ar.id = f.analysis_run_id
           JOIN extraction_field ef ON ef.id = m.field_id
           JOIN project_work pw ON pw.work_id = ar.work_id AND pw.project_id = 1
           WHERE ef.schema_id = ? AND ar.superseded = 0
             AND (ar.project_id = 1 OR ar.project_id = 0)`
        )
        .get(c.schema_id) as { c: number }
    ).c
    check(
      `COVERAGE: schema ${c.schema_id} numerator matches an independent query`,
      c.works_with_values === truth && truth > 0,
      `${c.works_with_values} vs ${truth}`
    )
  }
  check(
    'extraction rows have a derived status',
    extraction.every((r) => ['validated', 'review', 'conflict', 'invalid'].includes(r.status))
  )

  // A-M4 — the summary's counts, on the corpus as it actually is.
  //
  // The `conflicting` count needs an `uncertain-conflicting` fact carrying a
  // measurement, and whether a model happened to produce one is a property of
  // the papers, not of the counter under test. So the test SUPPLIES one when the
  // corpus has none, and the assertion afterwards is unconditional — which is
  // stronger than the old form, that merely trusted the seed to have hand-written
  // one and would have gone quiet the moment it stopped.
  // Its own timestamp: the shared `now` is declared further down, with the
  // pipeline section that first needs it.
  const probeNow = new Date().toISOString()
  const conflictingBefore = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM fact f
           JOIN measurement m ON m.fact_id = f.id
           JOIN analysis_run ar ON ar.id = f.analysis_run_id
          WHERE f.kind = 'uncertain-conflicting' AND ar.superseded = 0 AND ar.project_id = 1`
      )
      .get() as { c: number }
  ).c
  if (conflictingBefore === 0) {
    const host = db
      .prepare(
        `SELECT id FROM analysis_run WHERE project_id = 1 AND superseded = 0 ORDER BY id LIMIT 1`
      )
      .get() as { id: number } | undefined
    if (host) {
      const cf = Number(
        db
          .prepare(
            `INSERT INTO fact (analysis_run_id, kind, predicate, value_text, created_at)
             VALUES (?, 'uncertain-conflicting', 'conflict-probe', 'reported inconsistently', ?)`
          )
          .run(host.id, probeNow).lastInsertRowid
      )
      db.prepare(
        `INSERT INTO measurement (fact_id, quantity, value_num, unit, created_at)
         VALUES (?, 'conflict probe', 1.0, 'C', ?)`
      ).run(cf, probeNow)
    }
  }
  const seedSummary = getExtractionStatusSummary(db, 1)
  check('A-M4: seed summary total_records > 0', seedSummary.total_records > 0, `${seedSummary.total_records}`)
  check('A-M4: seed summary counts a conflicting record', seedSummary.conflicting > 0, `${seedSummary.conflicting} conflicting`)
  check('A-M4: seed summary counts auto-validated records', seedSummary.auto_validated > 0, `${seedSummary.auto_validated} validated`)
  check(
    'A-M4: seed summary QC sample non-empty + all validated',
    seedSummary.qc_sample.length > 0 &&
      seedSummary.qc_sample.every((s) =>
        extraction.some((r) => r.measurement_id === s.measurement_id && r.status === 'validated')
      ),
    `${seedSummary.qc_sample.length} sampled`
  )

  const facets = getFacets(db, 1)
  check('getFacets work_type non-empty', facets.work_type.length > 0)
  check('getFacets inclusion_status non-empty', facets.inclusion_status.length > 0)

  const results = search(db, 'kemp', 1)
  check('search returns results', results.length > 0, `${results.length} hits`)

  // An empty query is the whole project (the Papers list), not an empty result.
  const all = search(db, '', 1)
  check('empty query lists the project', all.length > 0, `${all.length} papers`)

  // Filters run in SQL and really narrow. Composition is AND across facets.
  const wt = facets.work_type[0]
  const byType = search(db, '', 1, { work_type: [wt.value] })
  check('work_type filter matches its facet count', byType.length === wt.count, `${byType.length}/${wt.count}`)
  const inc = facets.inclusion_status[0]
  const both = search(db, '', 1, { work_type: [wt.value], inclusion_status: [inc.value] })
  check(
    'filters compose with AND',
    both.length <= Math.min(wt.count, inc.count),
    `${both.length} <= min(${wt.count},${inc.count})`
  )
  // A decade label (en dash, as the year facet renders it) compiles to a range.
  const decade = search(db, '', 1, { year: ['2010–2019'] })
  check('decade year filter is understood', decade.length > 0, `${decade.length} in 2010s`)
  // countSearch counts in SQL and agrees with the (capped) row query.
  check('countSearch agrees with search', countSearch(db, '', 1) === all.length, `${countSearch(db, '', 1)}`)
  check(
    'countSearch respects filters',
    countSearch(db, '', 1, { work_type: [wt.value] }) === byType.length
  )
  // A filter that matches nothing yields zero rows, never a silently-widened query.
  check('unmatched filter yields nothing', search(db, '', 1, { work_type: ['nope-not-a-type'] }).length === 0)
  // Facet counts follow the OTHER facets, so they cannot lie once a chip is on.
  const narrowedFacets = getFacets(db, 1, '', { inclusion_status: [inc.value] })
  check(
    'facet counts respect other facets',
    narrowedFacets.work_type.every((b) => b.count <= (facets.work_type.find((x) => x.value === b.value)?.count ?? 0))
  )

  void pid

  // ---- pipeline end-to-end (segment + mock provider + persist) ----------
  const paras = segment('First heading\n\nThe kcat improved 200-fold. It was measured at 25C.\n\n- a list item')
  check('segment produces paragraphs', paras.length >= 2, `${paras.length} paragraphs`)
  check(
    'segment paragraphs have sentences',
    paras.every((p) => p.text.length > 0)
  )
  // exact-slice: re-slice the source and compare
  const src = 'First heading\n\nThe kcat improved 200-fold. It was measured at 25C.\n\n- a list item'
  check(
    'exact-slice: text.slice(start,end)===text',
    segment(src).every((p) => src.slice(p.charStart, p.charEnd) === p.text)
  )

  // The response the pipeline will be handed. SCRIPTED, not looked up: what is
  // under test here is what the pipeline DOES with a response — supersede then
  // insert in one transaction, anchor the evidence, link the measurement, run
  // the deterministic checks — so the input needs to be known, not realistic.
  const docText = 'Verification doc: kcat/KM improved 200-fold over wild-type; Tm ~52 C.'
  const now = new Date().toISOString()
  const scripted = JSON.stringify({
    facts: [
      {
        kind: 'directly-reported',
        predicate: 'reports-fold-improvement',
        subject: 'evolved variant',
        value_text: '200-fold kcat/KM',
        // Verbatim from `docText`, and NAMING the paragraph it came from. The
        // anchoring contract refuses an anchor whose [pN] is absent, so a fixture
        // without one exercises the rejection path rather than the persistence
        // path this section is about.
        anchor_quote: 'kcat/KM improved 200-fold over wild-type',
        paragraph: 0,
        value_num: 1230,
        unit: 'M^-1 s^-1',
        conditions: 'pH 7.0, 25C',
        fold: {
          baseline_label: 'WT',
          improved_label: 'evolved',
          fold: 200,
          comparability: 'directly'
        }
      },
      {
        kind: 'uncertain-conflicting',
        predicate: 'thermostability',
        subject: 'evolved variant',
        value_text: 'Tm ~52 C',
        anchor_quote: 'Tm ~52 C',
        paragraph: 0
      }
    ]
  })

  // The PRIOR current run, established by running the pipeline once — rather
  // than read from the seed, which no longer ships analyses because nothing had
  // read those papers. Producing it here makes the supersede assertion strictly
  // stronger: the row it retires was written by the same code path under test,
  // so the check can no longer pass merely because a hand-inserted fixture
  // happened to match the shape the query expects.
  const priorProvider = new ScriptedLlmProvider([scripted])
  const priorRes = await runPipeline(
    db,
    priorProvider,
    { workId: 2, projectId: 1, analysisType: 'extraction', docText },
    now
  )
  const priorCurrent = { id: priorRes.analysisRunId }
  check('a prior current extraction run was established', priorRes.analysisRunId > 0)

  const factCountBefore = (
    db.prepare('SELECT COUNT(*) AS c FROM fact').get() as { c: number }
  ).c
  const evCountBefore = (
    db.prepare('SELECT COUNT(*) AS c FROM evidence_span').get() as { c: number }
  ).c

  const provider = new ScriptedLlmProvider([scripted])
  const res = await runPipeline(
    db,
    provider,
    { workId: 2, projectId: 1, analysisType: 'extraction', docText },
    now
  )

  check('pipeline inserted a new analysis_run', res.analysisRunId > 0, `run ${res.analysisRunId}`)
  check(
    'pipeline output validation passed (model JSON matched the declared schema)',
    res.verifierResult === 'passed',
    res.verifierResult
  )
  check('pipeline persisted facts', res.factCount > 0, `${res.factCount} facts`)
  check('pipeline persisted evidence', res.evidenceCount > 0, `${res.evidenceCount} spans`)

  const factCountAfter = (
    db.prepare('SELECT COUNT(*) AS c FROM fact').get() as { c: number }
  ).c
  const evCountAfter = (
    db.prepare('SELECT COUNT(*) AS c FROM evidence_span').get() as { c: number }
  ).c
  check('fact rows increased', factCountAfter > factCountBefore, `${factCountBefore} -> ${factCountAfter}`)
  check('evidence rows increased', evCountAfter > evCountBefore, `${evCountBefore} -> ${evCountAfter}`)

  // The prior current run must now be superseded. Unconditional: `priorCurrent`
  // is produced above, so an `if` here could only hide its absence.
  const supRow = db
    .prepare('SELECT superseded FROM analysis_run WHERE id = ?')
    .get(priorCurrent.id) as { superseded: number }
  check('prior current run superseded=1', supRow.superseded === 1)
  // One current run PER SCHEMA — the actual invariant, and what the
  // partial-unique index enforces.
  //
  // `schema_id` joined the one-current-run key in v15 exactly so a paper can be
  // extracted under several target schemas at once. Counting current runs for
  // (work, project, type) alone therefore reads 2 on a corpus with two schemas
  // attached, and that is CORRECT — the old `=== 1` encoded an assumption about
  // how many schemas the fixture happened to carry. Written as a
  // duplicate-detecting GROUP BY so it asserts the invariant itself, and over
  // the whole table rather than one row, which makes it strictly stronger.
  const dupes = db
    .prepare(
      `SELECT work_id, project_id, analysis_type, schema_id, COUNT(*) AS c
         FROM analysis_run WHERE superseded = 0
        GROUP BY work_id, project_id, analysis_type, schema_id
       HAVING c > 1`
    )
    .all() as Array<Record<string, unknown>>
  check(
    'no (work, project, type, schema) has two current runs',
    dupes.length === 0,
    JSON.stringify(dupes)
  )
  const curCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM analysis_run WHERE work_id=2 AND project_id=1 AND analysis_type='extraction' AND superseded=0`
      )
      .get() as { c: number }
  ).c
  check('work 2 still has a current extraction run', curCount >= 1, `${curCount} current`)

  // The new run has a measurement + fold anchored.
  const newRun = getWorkAnalyses(db, 2, 1).find((r) => r.id === res.analysisRunId)
  check('new run readable via getWorkAnalyses', !!newRun)
  check('new run fact has measurement+fold', !!newRun && newRun.facts.some((f) => f.measurement?.fold != null))

  // The corpus-relative outlier rule must be COMPUTED from the DB, never from a
  // hardcoded range: plant a value orders of magnitude away from the other
  // values already recorded for the SAME field and require it to be NOTICED.
  //
  // A SELECTOR IS ASSERTED, NEVER A VERDICT. "This number is not what the paper
  // prints" is a claim about a page nothing here has read, and asserting it from
  // a ratio flagged a paper's headline result as a defect. What is decidable is
  // that the rule still SEES the planted value and turns it into a question for
  // a reader. A selector makes no claim, so it cannot be a false positive; it
  // can only be silent, and silence is what this proves it is not.
  {
    const outlierRun = db
      .prepare(
        `INSERT INTO analysis_run
           (work_id, project_id, analysis_type, model, provider, prompt_version, schema_version,
            run_timestamp, verifier_result, deterministic_validation, superseded, created_at)
         VALUES (7, 1, 'measurement', 'probe', 'probe', 'v1', 's1', ?, 'passed', 0, 0, ?)`
      )
      .run(now, now)
    const outlierRunId = Number(outlierRun.lastInsertRowid)
    const outlierFact = db
      .prepare(
        `INSERT INTO fact (analysis_run_id, kind, predicate, value_text, created_at)
         VALUES (?, 'directly-reported', 'thermostability', 'Tm 9.9e6 C', ?)`
      )
      .run(outlierRunId, now)
    // Enough comparators for the field to HAVE a distribution — the check
    // refuses to opine below a minimum sample, which is itself the point.
    const insTm = db.prepare(
      `INSERT INTO measurement (fact_id, field_id, quantity, value_num, unit, created_at)
       VALUES (?, 13, 'Tm', ?, 'C', ?)`
    )
    const comparatorFact = db
      .prepare(
        `INSERT INTO fact (analysis_run_id, kind, predicate, value_text, created_at)
         VALUES (?, 'directly-reported', 'thermostability-comparator', 'Tm series', ?)`
      )
      .run(Number(priorCurrent.id), now)
    for (const v of [48, 49, 50, 51, 52, 53]) {
      insTm.run(Number(comparatorFact.lastInsertRowid), v, now)
    }
    insTm.run(Number(outlierFact.lastInsertRowid), 9_900_000, now)
    const questions = buildReviewQuestions(db, outlierRunId)
    const outlier = questions.find((q) => q.checkKey === 'value-outlier')
    check(
      'REVIEW value-outlier: asks about a value far outside the range the corpus itself establishes',
      outlier !== undefined,
      outlier?.ask.slice(0, 160)
    )
    // THE RANGE THE CHECK ACTUALLY SAW, read from the database rather than
    // written down here.
    //
    // This asserted the literal string "between 48 and 53" — the six
    // comparators planted directly above. But the check compares against EVERY
    // current measurement of the field in the library, and the seed ships eight
    // of its own Tm readings spanning 76..95, which legitimately widen the
    // range. So the assertion described a corpus that no longer existed, and it
    // would break again on any seed that adds a Tm. The property under test is
    // that the question CARRIES the range it judged against — not what that
    // range happens to be — so the expectation is derived from the same rows
    // the check reads.
    const tmPeers = (
      db
        .prepare(
          `SELECT m2.value_num AS v
             FROM measurement m2
             JOIN fact f2 ON f2.id = m2.fact_id
             JOIN analysis_run r2 ON r2.id = f2.analysis_run_id
            WHERE m2.field_id = 13 AND f2.analysis_run_id <> ? AND m2.value_num IS NOT NULL
              AND r2.superseded = 0 AND COALESCE(TRIM(LOWER(m2.unit)), '') = 'c'`
        )
        .all(outlierRunId) as Array<{ v: number }>
    )
      .map((r) => Math.abs(r.v))
      .filter((v) => v > 0)
    const expectedRange = `between ${Math.min(...tmPeers)} and ${Math.max(...tmPeers)} (${tmPeers.length} of them)`
    check(
      'REVIEW: the question carries what the corpus establishes, so the reader is not asked blind',
      outlier !== undefined && outlier.ask.includes(expectedRange),
      `expected "${expectedRange}" · got ${outlier?.ask.slice(0, 200)}`
    )
    // The question must offer the reader the answer that the OLD check could not
    // give — that an extreme value can be exactly what the paper reports.
    check(
      'REVIEW: the question states that an exceptional value is not itself a defect',
      outlier !== undefined && /exceptional result/.test(outlier.ask)
    )
  }

  // ======================================================================
  // A-B1 — ranking STORAGE: two distinct scores, an honest explanation beside
  // them, and a column a person set by hand left alone.
  //
  // The SCORES themselves are the rerank sweep's, produced by a local
  // cross-encoder, and this script has no model and no queue. What it can and
  // must prove is the contract every one of those scores passes through:
  // `recordScores` writes both columns, writes the sentence that describes
  // them, and refuses to overwrite an override. A regression in any of those
  // silently rewrites a user's judgement.
  // ======================================================================
  const OVERRIDE_WORK = 4
  const OVERRIDE_VALUE = 0.11
  overrideScore(db, 1, OVERRIDE_WORK, 'relevance', OVERRIDE_VALUE, 'verify-backend override', now)

  const scoringSet = scoringSets(db).find((s) => s.projectId === 1)
  check('scoringSets returns project 1 with papers', !!scoringSet && scoringSet.works.length > 0,
    `${scoringSet?.works.length ?? 0} works`)
  const scored = (scoringSet?.works ?? []).map((w, i) => ({
    workId: w.workId,
    // Distinct per row and distinct from the expansion value, so a writer that
    // crossed the two columns cannot pass.
    relevance: 0.9 - i * 0.01,
    scoredOn: w.abstract?.trim() ? 'title+abstract' : 'title',
    expansionPriority: 0.2 + i * 0.01,
    explanation: `relevance ${(0.9 - i * 0.01).toFixed(2)} — a model compared its title and ` +
      `abstract against this project's description; expansion priority — its bibliography names ` +
      `${w.bibliographySize} paper(s)`
  }))
  recordScores(db, 1, scored, now)

  const afterScores = getRanking(db, 1, 'relevance')
  check(
    'A-B1: at least one row has relevance !== expansion_priority',
    afterScores.some(
      (r) => r.relevance != null && r.expansion_priority != null && r.relevance !== r.expansion_priority
    )
  )
  const explained = afterScores.filter((r) => (r.ranking_explanation ?? '').length > 0)
  check(
    'A-B1: every row has a non-empty ranking_explanation',
    explained.length === afterScores.length,
    `${explained.length}/${afterScores.length}`
  )
  // The sentence must say WHAT WAS MEASURED AND ON WHAT — the two things a
  // reader can check against the paper in front of them. Matched on the
  // reader's words, never on an implementation name.
  const SIGNAL_PHRASES = [
    'compared its title', // which text the model was shown
    'bibliography names', // the count expansion priority is normalised from
    'not scored' // the honest refusal when nothing looked
  ]
  const withSignal = explained.filter((r) =>
    SIGNAL_PHRASES.some((w) => (r.ranking_explanation ?? '').includes(w))
  )
  check(
    'A-B1: explanations name what was measured, in the reader\u2019s own words',
    withSignal.length === explained.length,
    `${withSignal.length}/${explained.length} \u00b7 ${explained[0]?.ranking_explanation?.slice(0, 70)}`
  )
  const overriddenRow = afterScores.find((r) => r.work_id === OVERRIDE_WORK)
  check(
    'A-B1: user override on relevance is PRESERVED by a scoring pass',
    !!overriddenRow && overriddenRow.relevance === OVERRIDE_VALUE,
    `relevance=${overriddenRow?.relevance}`
  )
  check(
    'A-B1: the overridden row\u2019s explanation says the score is the user\u2019s',
    !!overriddenRow && (overriddenRow.ranking_explanation ?? '').includes('set relevance by hand')
  )
  // Per COLUMN, not per row: overriding relevance says nothing about how much
  // following the bibliography is worth, and freezing that would leave it
  // describing a corpus that has moved.
  const expectedExpansion = scored.find((s) => s.workId === OVERRIDE_WORK)?.expansionPriority
  check(
    'A-B1: the overridden row\u2019s expansion_priority was still updated',
    !!overriddenRow && overriddenRow.expansion_priority === expectedExpansion,
    `expansion=${overriddenRow?.expansion_priority} expected ${expectedExpansion}`
  )
  // A score nothing produced is NULL, never 0 — a 0 draws an empty bar reading
  // as "judged, and found irrelevant", which is a claim no model made.
  const unscoredWork = scored[scored.length - 1]?.workId ?? 0
  recordScores(
    db,
    1,
    [{ ...scored[scored.length - 1], relevance: null, scoredOn: null,
       explanation: 'relevance not scored \u2014 no reranker model is packaged in this build' }],
    now
  )
  const unscoredRow = getRanking(db, 1, 'relevance').find((r) => r.work_id === unscoredWork)
  check(
    'A-B1: a pass with no model LEAVES a stored relevance rather than nulling it',
    !!unscoredRow && unscoredRow.relevance !== null,
    `relevance=${unscoredRow?.relevance}`
  )

  // ======================================================================
  // A-M1 — dossier INCLUDES contrary/conflicting findings (anti-anchoring).
  // ======================================================================
  const dossierAll = getDossier(db, 1)
  check('A-M1: getDossier non-empty', dossierAll.length > 0, `${dossierAll.length} entries`)
  const contrary = dossierAll.filter((d) => d.is_contrary)
  check(
    'A-M1: dossier includes contrary (uncertain-conflicting / inferred) findings',
    contrary.length > 0,
    `${contrary.length} contrary`
  )
  check(
    'A-M1: contrary entries are flagged by kind',
    contrary.every((d) => d.kind === 'uncertain-conflicting' || d.kind === 'inferred')
  )

  // ======================================================================
  // A-B2 — dossier from reference papers + fed to the pipeline.
  // ======================================================================
  // The seed marks a reference set; clear it so this section controls the
  // scoping it asserts rather than depending on the seed's choices.
  const seededRefs = getRanking(db, 1).filter((r) => r.is_reference)
  check('A-B2: the seed marks at least one reference paper', seededRefs.length > 0, `${seededRefs.length}`)
  for (const r of seededRefs) markReferencePaper(db, 1, r.work_id, false, now)
  check(
    'A-B2: unmarking a reference clears the flag on every seeded reference row',
    getRanking(db, 1)
      .filter((r) => seededRefs.some((s) => s.work_id === r.work_id))
      .every((r) => !r.is_reference)
  )

  markReferencePaper(db, 1, 2, true, now) // work 2 has the rich seeded facts
  check(
    'A-B2: markReference is reflected on the ranking row the UI reads',
    getRanking(db, 1).filter((r) => r.is_reference).map((r) => r.work_id).join(',') === '2'
  )
  const refDossier = getDossier(db, 1)
  check(
    'A-B2: after marking a reference, dossier is scoped to it (from_reference)',
    refDossier.length > 0 && refDossier.every((d) => d.from_reference && d.work_id === 2),
    `${refDossier.length} entries`
  )
  // Build the context a NEW work (id 3) would receive — must be relevant, compact,
  // reference-derived, and non-empty.
  const ctx = buildDossierContext(db, 1, 3)
  check('A-B2: buildDossierContext returns a non-empty context for a target work', ctx.length > 0)
  check(
    'A-B2: dossier context is JSON referencing reference-paper entries',
    (() => {
      try {
        const parsed = JSON.parse(ctx) as { entries?: unknown[] }
        return Array.isArray(parsed.entries) && parsed.entries.length > 0
      } catch {
        return false
      }
    })()
  )
  check(
    'A-B2: context excludes the target work’s OWN facts (only reference facts)',
    (() => {
      try {
        const parsed = JSON.parse(ctx) as { entries: Array<{ work_id: number }> }
        return parsed.entries.every((e) => e.work_id !== 3)
      } catch {
        return false
      }
    })()
  )
  // Prove the pipeline actually PERSISTS the dossier-derived context on a run:
  // feed the built dossier context (exactly what queue.runJob threads in) and
  // assert analysis_run.supplied_project_context is populated from it.
  const ctxRun = await runPipeline(
    db,
    provider,
    { workId: 3, projectId: 1, analysisType: 'summary', docText: 'Probe doc for dossier wiring.', suppliedProjectContext: ctx },
    now
  )
  const ctxRunRow = db
    .prepare('SELECT supplied_project_context FROM analysis_run WHERE id = ?')
    .get(ctxRun.analysisRunId) as { supplied_project_context: string | null }
  check(
    'A-B2: analysis_run persists the dossier-derived supplied_project_context',
    !!ctxRunRow.supplied_project_context && ctxRunRow.supplied_project_context.includes('entries')
  )

  // ======================================================================
  // Dossier AUTHORING — status, build, staleness (§8 / §21).
  // ======================================================================
  //
  // ITS OWN PROVIDER, scripted with a response per call this section makes.
  //
  // `provider` above was built with ONE response and has already spent it, so
  // every call here fell through to "scripted provider exhausted". The pipeline
  // treats that as a provider blowing up — which is correct: it records
  // `verifier_result = 'failed'`, persists zero facts, and does NOT throw. Both
  // dossier builds therefore "succeeded" with nothing in them, the context they
  // were supposed to change never moved, and the three §21 staleness checks
  // below asserted against a build that had not happened. Nothing was wrong
  // with the app; the fixture had run out.
  //
  // A CLAIM PER BUILD, and the section makes two (build, then rebuild). The
  // anchor is PARAGRAPH-ONLY: this build reads work 2's real extracted text,
  // not the short `docText` above, so a quote invented here could not be found
  // in it and the claim would be dropped as unanchorable — leaving a run with
  // zero facts again, by a different route. A paragraph-level anchor with no
  // quote is an honest answer the pipeline keeps by contract.
  const dossierClaim = (value: string): string =>
    JSON.stringify({
      facts: [
        {
          kind: 'directly-reported',
          predicate: 'establishes-background',
          subject: 'KE07 series',
          value_text: value,
          paragraph: 0
        }
      ]
    })
  // Two DIFFERENT values, so the rebuild genuinely changes the context rather
  // than writing the same claim twice — the staleness checks below turn on the
  // context hash MOVING, and identical claims would leave it where it was.
  const dossierProvider = new ScriptedLlmProvider([
    dossierClaim('the series is a computationally designed Kemp eliminase lineage'),
    dossierClaim('the series was subsequently optimised by directed evolution')
  ])

  const statusBefore = getDossierStatus(db, 1)
  check(
    'dossier: status reports the marked reference set',
    statusBefore.references.length === 1 && statusBefore.references[0].work_id === 2,
    `${statusBefore.references.length} references`
  )
  check('dossier: status is not in fallback while a reference is marked', !statusBefore.fallback)
  check('dossier: nothing built yet', statusBefore.built_at === null)
  check(
    'dossier: status reports zero builds for a never-built reference',
    statusBefore.references.every((r) => r.built_at === null)
  )

  const built = await buildDossier(db, dossierProvider, 1, now)
  check('dossier: build ran once per reference paper', built.runs.length === 1, `${built.runs.length} runs`)
  check('dossier: build stamped a build time', built.status.built_at !== null)
  check(
    'dossier: build recorded which papers it covered',
    built.status.built_work_ids.join(',') === '2'
  )
  const builtRun = db
    .prepare(
      `SELECT analysis_type, prompt_version, model, provider, superseded
         FROM analysis_run WHERE id = ?`
    )
    .get(built.runs[0].analysisRunId) as {
    analysis_type: string
    prompt_version: string
    model: string
    provider: string
    superseded: number
  }
  check(
    'dossier: the build persisted a real analysis_run with dossier provenance',
    builtRun.analysis_type === 'dossier' &&
      builtRun.prompt_version === getPrompt('dossier').version &&
      builtRun.superseded === 0,
    `${builtRun.model}/${builtRun.provider} ${builtRun.prompt_version}`
  )

  // Rebuild: exactly one CURRENT dossier run may survive per (work, project).
  const rebuilt = await buildDossier(db, dossierProvider, 1, now)
  const currentDossierRuns = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM analysis_run
          WHERE project_id = 1 AND analysis_type = 'dossier' AND superseded = 0`
      )
      .get() as { c: number }
  ).c
  check(
    'dossier: rebuild supersedes the prior run (one current run per paper)',
    currentDossierRuns === 1 && rebuilt.runs[0].analysisRunId !== built.runs[0].analysisRunId,
    `${currentDossierRuns} current`
  )

  // A build over no reference papers must REFUSE rather than silently persist
  // runs against a set the user never chose. It throws before reaching the
  // provider, which is why this one still takes the exhausted `provider`.
  markReferencePaper(db, 1, 2, false, now)
  let refused = false
  try {
    await buildDossier(db, provider, 1, now)
  } catch {
    refused = true
  }
  check('dossier: build refuses when no reference paper is marked', refused)
  // EMPTY, NOT FALLEN BACK.
  //
  // This asserted `fallback === true`: the dossier once substituted the top 8
  // works by relevance when nothing was marked, and the flag said so. That
  // behaviour was deliberately removed — it fed a model background the user
  // never chose — and `fallback` is now documented as ALWAYS FALSE, kept only
  // because the contract is frozen. So the check was asserting the presence of
  // the very thing whose removal was the fix. It now guards the replacement
  // rule: with nothing marked, the source set is empty.
  const unmarked = getDossierStatus(db, 1)
  check(
    'dossier: with nothing marked the source set is EMPTY, never a substituted one',
    unmarked.fallback === false &&
      unmarked.references.length === 0 &&
      unmarked.sources.length === 0,
    `fallback=${unmarked.fallback} refs=${unmarked.references.length} sources=${unmarked.sources.length}`
  )
  markReferencePaper(db, 1, 2, true, now)

  // §21 staleness: dossier_input_hash is READ, not just written. The probe run
  // above (work 3) was made against a context built while work 2 was the only
  // reference; the dossier build has since added claims, so its stored hash no
  // longer matches what work 3 would be given now.
  const stale = getDossierStaleWorks(db, 1)
  check('§21: stale detection finds analyses made against an older dossier', stale.length > 0, `${stale.length} stale`)
  check(
    '§21: stale rows report BOTH the hash they were built against and the current one',
    stale.every((s) => s.built_against !== s.current)
  )
  check(
    '§21: dossier BUILD runs are never reported as stale against themselves',
    stale.every((s) => s.analysis_type !== 'dossier')
  )
  check(
    '§21: currentDossierInputHash matches what the pipeline would stamp',
    (() => {
      const target = stale[0]
      if (!target) return false
      const expected = buildDossierContext(db, 1, target.work_id)
      return target.current === (expected ? hashInput({ dossier: expected }) : null)
    })()
  )
  check(
    '§21: staleness is REPORTED, never auto-fixed (the stale run is still current)',
    (() => {
      const target = stale[0]
      if (!target) return false
      const row = db
        .prepare(
          `SELECT superseded FROM analysis_run
            WHERE work_id = ? AND project_id = 1 AND analysis_type = ? AND superseded = 0`
        )
        .get(target.work_id, target.analysis_type) as { superseded: number } | undefined
      return row !== undefined && row.superseded === 0
    })()
  )

  // Clean the reference flag back off so it doesn't skew later reads.
  markReferencePaper(db, 1, 2, false, now)

  // ======================================================================
  // A-M4 — extraction status summary + deterministic QC sample.
  // ======================================================================
  const summary = getExtractionStatusSummary(db, 1)
  const extractionRows = getExtractionRows(db, 1)
  check('A-M4: summary total_records > 0', summary.total_records > 0, `${summary.total_records}`)
  check(
    'A-M4: total equals getExtractionRows count (same source of truth)',
    summary.total_records === extractionRows.length,
    `${summary.total_records} vs ${extractionRows.length}`
  )
  check(
    'A-M4: status counts sum to total',
    summary.auto_validated +
      summary.needs_interpretation +
      summary.conflicting +
      summary.structurally_invalid ===
      summary.total_records,
    `${summary.auto_validated}+${summary.needs_interpretation}+${summary.conflicting}+${summary.structurally_invalid} vs ${summary.total_records}`
  )
  // The summary counts must agree with the per-row derived statuses exactly (the
  // §12 panel is derived from getExtractionRows' status logic).
  const rowConflicts = extractionRows.filter((r) => r.status === 'conflict').length
  const rowValidated = extractionRows.filter((r) => r.status === 'validated').length
  check('A-M4: conflicting count matches per-row conflict statuses', summary.conflicting === rowConflicts, `${summary.conflicting} vs ${rowConflicts}`)
  check('A-M4: auto_validated count matches per-row validated statuses', summary.auto_validated === rowValidated, `${summary.auto_validated} vs ${rowValidated}`)
  check(
    'A-M4: QC sample is drawn from auto-validated records only',
    summary.qc_sample.length <= summary.auto_validated &&
      summary.qc_sample.every((s) =>
        extractionRows.some((r) => r.measurement_id === s.measurement_id && r.status === 'validated')
      ),
    `${summary.qc_sample.length} sampled`
  )
  // Determinism: two calls yield the SAME sample (seeded RNG).
  const summary2 = getExtractionStatusSummary(db, 1)
  check(
    'A-M4: QC sample is deterministic across calls',
    JSON.stringify(summary.qc_sample.map((s) => s.measurement_id)) ===
      JSON.stringify(summary2.qc_sample.map((s) => s.measurement_id))
  )

  // ======================================================================
  // SCHEMA ABSTRACTION — extraction schemas are first-class DB entities and the
  // extraction rows are schema-driven, so no field of science is baked into the
  // code. Also exercises the CRUD path and the export-alias resolution.
  // ======================================================================
  const seededSchemas = listExtractionSchemas(db)
  check('SCHEMA: at least two schemas are seeded', seededSchemas.length >= 2, `${seededSchemas.length}`)
  check(
    'SCHEMA: every seeded schema has ordered fields',
    seededSchemas.every(
      (s) =>
        s.fields.length > 0 &&
        s.fields.every((f, i, arr) => i === 0 || arr[i - 1].sort_order <= f.sort_order)
    )
  )
  check(
    'SCHEMA: enum fields always carry options',
    seededSchemas.every((s) =>
      s.fields.every((f) => f.data_type !== 'enum' || (f.enum_options?.length ?? 0) > 0)
    )
  )
  // NOTE: use the PRE-supersession snapshot (`extraction`, captured before the
  // pipeline run below superseded work 2's rich seeded extraction). The seeded,
  // schema-linked measurements hang off that run; after supersession only the
  // pipeline's own (unguided, and therefore unlinked) rows remain.
  const schemaLinked = extraction.filter((r) => r.schema_id != null && r.field_id != null)
  check('SCHEMA: extraction rows are schema-linked', schemaLinked.length > 0, `${schemaLinked.length} linked`)
  check(
    'SCHEMA: MORE THAN ONE schema carries real extracted data',
    new Set(schemaLinked.map((r) => r.schema_id)).size >= 2,
    `${new Set(schemaLinked.map((r) => r.schema_id)).size} schemas`
  )
  // `measurement_count` is GLOBAL now (schemas are global, so the Schemas screen
  // has no project to scope to). Compare it against a global query rather than
  // against project-1 extraction rows — the previous project-scoped equality
  // would have quietly broken the moment a second project held data.
  const liveRows = getExtractionRows(db, 1)
  const globalCounts = new Map(
    (
      db
        .prepare(
          `SELECT ef.schema_id AS sid, COUNT(*) AS c
           FROM measurement m
           JOIN fact f ON f.id = m.fact_id
           JOIN analysis_run ar ON ar.id = f.analysis_run_id
           JOIN extraction_field ef ON ef.id = m.field_id
           WHERE ar.superseded = 0
           GROUP BY ef.schema_id`
        )
        .all() as { sid: number; c: number }[]
    ).map((r) => [r.sid, r.c])
  )
  check(
    'SCHEMA: measurement_count is the GLOBAL non-superseded count',
    listExtractionSchemas(db).every((s) => s.measurement_count === (globalCounts.get(s.id) ?? 0))
  )
  check(
    'SCHEMA: raw quantity/unit preserved alongside the field link',
    schemaLinked.every((r) => r.quantity.length > 0)
  )
  // Built-ins are delete-protected (they back the seeded corpus + export alias).
  const builtin = seededSchemas.find((s) => s.is_builtin)
  let builtinProtected = false
  try {
    deleteExtractionSchema(db, builtin!.id)
  } catch {
    builtinProtected = true
  }
  check('SCHEMA: built-in schemas cannot be deleted', builtinProtected)

  // CRUD round-trip: create schema -> add field -> delete field -> delete schema.
  const made = createExtractionSchema(
    db,
    { name: 'Verify Backend Schema' },
    now
  )
  check('SCHEMA: createExtractionSchema persists a user schema', made.id > 0 && !made.is_builtin)
  check(
    'SCHEMA: key is slugified from the name (never supplied by the caller)',
    made.key === 'verify-backend-schema'
  )
  // Content-derived versioning: adding a field must move the schema version,
  // while every OTHER field's param_hash stays byte-identical — that is what
  // makes the versioning incremental rather than wholesale.
  const v0 = made.version
  const withField = createExtractionField(
    db,
    made.id,
    { key: 'round_number', label: 'Round number', data_type: 'number', required: true },
    now
  )
  check(
    'SCHEMA: createExtractionField appends an ordered field',
    withField.fields.length === 1 && withField.fields[0].key === 'round_number' && withField.fields[0].required
  )
  check('SCHEMA: adding a field changes the derived version', withField.version !== v0)
  const hash0 = withField.fields[0].param_hash
  const enumed = createExtractionField(
    db,
    made.id,
    { key: 'screening', label: 'Screening', data_type: 'enum', enum_options: ['plate', 'FACS'] },
    now
  )
  check(
    'SCHEMA: enum field round-trips its options',
    JSON.stringify(enumed.fields.find((f) => f.key === 'screening')?.enum_options) ===
      JSON.stringify(['plate', 'FACS'])
  )
  check(
    'SCHEMA: adding a SECOND field leaves the first field\'s hash untouched',
    enumed.fields.find((f) => f.key === 'round_number')?.param_hash === hash0 &&
      enumed.version !== withField.version
  )
  const renamed = updateExtractionField(
    db,
    enumed.fields.find((f) => f.key === 'round_number')!.id,
    { key: 'round_number', label: 'Evolution round', data_type: 'number', required: true },
    now
  )
  check(
    'SCHEMA: editing ONE field moves only its own hash',
    renamed.fields.find((f) => f.key === 'round_number')?.param_hash !== hash0 &&
      renamed.fields.find((f) => f.key === 'screening')?.param_hash ===
        enumed.fields.find((f) => f.key === 'screening')?.param_hash
  )
  const afterFieldDelete = deleteExtractionField(db, enumed.fields[0].id)
  check('SCHEMA: deleteExtractionField removes exactly one field', afterFieldDelete.fields.length === 1)
  const afterSchemaDelete = deleteExtractionSchema(db, made.id)
  check(
    'SCHEMA: deleteExtractionSchema removes the user schema',
    !afterSchemaDelete.some((s) => s.id === made.id)
  )
  check(
    'SCHEMA: deleting a schema did NOT destroy any extracted measurement',
    getExtractionRows(db, 1).length === liveRows.length
  )

  // ======================================================================
  // PER-PROJECT SCHEMA ATTACHMENTS + COVERAGE. Schemas are global; a project
  // chooses which of them its Extraction applies. Detaching must NOT delete the
  // definition or any measurement, and the coverage numbers must be real.
  // ======================================================================
  const attachedSeed = listProjectSchemas(db, 1)
  check(
    'ATTACH: the seed attaches both schemas to the KE07 project',
    attachedSeed.length === 2 && attachedSeed.every((s) => s.is_builtin),
    `${attachedSeed.length} attached`
  )
  check(
    'ATTACH: every attached schema is also in the GLOBAL schema list',
    attachedSeed.every((a) => listExtractionSchemas(db).some((g) => g.id === a.id))
  )
  check(
    'ATTACH: attached_project_count reflects the real project_schema rows',
    listExtractionSchemas(db)
      .filter((s) => attachedSeed.some((a) => a.id === s.id))
      .every((s) => s.attached_project_count === 1)
  )

  const rowsBeforeDetach = getExtractionRows(db, 1).length
  const detachTarget = attachedSeed[0]
  const afterDetach = detachProjectSchema(db, 1, detachTarget.id)
  check(
    'ATTACH: detach removes exactly one attachment',
    afterDetach.length === attachedSeed.length - 1 &&
      !afterDetach.some((s) => s.id === detachTarget.id)
  )
  check(
    'ATTACH: DETACH IS NOT DELETE — the schema definition survives globally',
    listExtractionSchemas(db).some((s) => s.id === detachTarget.id)
  )
  check(
    'ATTACH: DETACH IS NOT DELETE — no extracted measurement is lost',
    getExtractionRows(db, 1).length === rowsBeforeDetach
  )
  check(
    'ATTACH: coverage drops the detached schema (nothing to cover)',
    !getSchemaCoverage(db, 1).some((c) => c.schema_id === detachTarget.id)
  )
  const reattached = attachProjectSchema(db, 1, detachTarget.id, now)
  check(
    'ATTACH: re-attach restores the schema (idempotent second call)',
    reattached.some((s) => s.id === detachTarget.id) &&
      attachProjectSchema(db, 1, detachTarget.id, now).length === reattached.length
  )

  // COVERAGE must equal an independently computed truth, never an estimate.
  const coverage = getSchemaCoverage(db, 1)
  const worksInProject = (
    db.prepare('SELECT COUNT(*) AS c FROM project_work WHERE project_id = 1').get() as { c: number }
  ).c
  check(
    'COVERAGE: one row per attached schema',
    coverage.length === listProjectSchemas(db, 1).length,
    `${coverage.length} rows`
  )
  check(
    'COVERAGE: denominator is the project work count',
    coverage.every((c) => c.works_total === worksInProject),
    `${worksInProject} works`
  )
  check(
    'COVERAGE: with + without always partitions the corpus (never fabricated)',
    coverage.every(
      (c) =>
        c.works_with_values + c.works_without_values === c.works_total &&
        c.works_with_values >= 0 &&
        c.works_without_values >= 0
    )
  )
  // The exact-match-against-an-independent-query assertions live at the snapshot
  // point (see `seedCoverage` above), where the numbers are NON-ZERO. Asserting
  // them here would compare 0 against 0 and pass tautologically, because the
  // pipeline run in between superseded work 2's seeded extraction.
  check(
    'COVERAGE: on the SEEDED state, every schema genuinely covers some papers',
    seedCoverage.length > 0 && seedCoverage.every((c) => c.works_with_values > 0),
    seedCoverage.map((c) => `${c.works_with_values}/${c.works_total}`).join(' ')
  )
  check(
    'COVERAGE: the KE07 corpus is NOT fully covered (the pending count is real)',
    seedCoverage.every((c) => c.works_without_values > 0)
  )

  // Export is resolved through the DB `export_alias`, NOT a code literal.
  //
  // The seed deliberately ships NO alias (migration v23): naming your own
  // export format is a real feature but it is the user's to name, so a
  // pre-branded one made a single interchange format look like a built-in
  // capability. Both halves of that are asserted — the seed stays unbranded,
  // AND the resolution machinery still works for an alias that exists. The
  // alias is planted here for the same reason the unresolved-reference row is
  // below: the assertion is about exportProject's behaviour, not about how the
  // row came to exist.
  check(
    'SCHEMA: the seed ships no pre-branded export_alias',
    seededSchemas.every((s) => !s.export_alias),
    seededSchemas.map((s) => `${s.key}=${s.export_alias ?? 'null'}`).join(' ')
  )
  const aliasSchema = seededSchemas.find((s) => s.fields.length > 0)!
  db.prepare('UPDATE extraction_schema SET export_alias = ? WHERE id = ?').run(
    'gate-alias',
    aliasSchema.id
  )
  const exported = JSON.parse(exportProject(db, 1, 'gate-alias')) as {
    schema?: { key: string; fields: unknown[] }
  }
  check(
    'SCHEMA: alias export emits the DB-defined schema + its fields',
    exported.schema?.key === aliasSchema.key &&
      (exported.schema?.fields.length ?? 0) === aliasSchema.fields.length,
    `${exported.schema?.key} ${exported.schema?.fields.length}/${aliasSchema.fields.length}`
  )
  db.prepare('UPDATE extraction_schema SET export_alias = NULL WHERE id = ?').run(aliasSchema.id)
  let unknownFormatRejected = false
  try {
    exportProject(db, 1, 'definitely-not-a-format')
  } catch {
    unknownFormatRejected = true
  }
  check('SCHEMA: an unknown export format is rejected', unknownFormatRejected)

  // ======================================================================
  // A-M3 — resolve an unresolved reference into a work + citation edge.
  // ======================================================================
  // Unresolved references are produced by the CITATION PARSER reading real
  // PDFs, not by the seed, so this check no longer assumes the seed planted
  // one: on a DB where `parse:citations` has not run there are legitimately
  // zero. Insert the row this scenario needs so the resolve flow is exercised
  // either way — the assertion below is about resolveUnresolvedReference's
  // behaviour, not about how the row came to exist.
  const existingUnresolved = db
    .prepare('SELECT id, citing_work_id FROM unresolved_reference ORDER BY id ASC LIMIT 1')
    .get() as { id: number; citing_work_id: number } | undefined
  const unresolvedRow =
    existingUnresolved ??
    (() => {
      const ins = db
        .prepare(
          `INSERT INTO unresolved_reference (citing_work_id, raw_bib_text, guessed_title, section, status, created_at)
           VALUES (1, 'A-M3 fixture reference', 'A-M3 fixture reference', 'references', 'unresolved', ?)`
        )
        .run(now)
      return { id: Number(ins.lastInsertRowid), citing_work_id: 1 }
    })()
  check('A-M3: an unresolved_reference is available to resolve', !!unresolvedRow)
  if (unresolvedRow) {
    const edgesBefore = (
      db.prepare('SELECT COUNT(*) AS c FROM citation_edge').get() as { c: number }
    ).c
    const resolved = resolveUnresolvedReference(
      db,
      unresolvedRow.id,
      { newWork: { title: 'A brand new resolved reference work', doi: '10.9999/verify-backend-ref' } },
      now
    )
    check(
      'A-M3: resolve created/linked a citation edge',
      resolved.edgeId != null && resolved.edgeId > 0,
      `edge ${resolved.edgeId}`
    )
    check('A-M3: resolve created a new work (no dup existed)', resolved.createdWork)
    check('A-M3: resolve reports matchedBy=created', resolved.matchedBy === 'created', resolved.matchedBy)
    const edgesAfter = (
      db.prepare('SELECT COUNT(*) AS c FROM citation_edge').get() as { c: number }
    ).c
    check('A-M3: citation_edge count increased by 1', edgesAfter === edgesBefore + 1, `${edgesBefore} -> ${edgesAfter}`)
    const stillThere = db
      .prepare('SELECT 1 AS x FROM unresolved_reference WHERE id = ?')
      .get(unresolvedRow.id) as { x: number } | undefined
    check('A-M3: unresolved_reference row removed after resolve', !stillThere)
    const edgeRow = db
      .prepare('SELECT citing_work_id, cited_work_id FROM citation_edge WHERE id = ?')
      .get(resolved.edgeId) as { citing_work_id: number; cited_work_id: number }
    check(
      'A-M3: new edge links the citing work to the resolved target',
      edgeRow.citing_work_id === unresolvedRow.citing_work_id && edgeRow.cited_work_id === resolved.citedWorkId
    )
    // ---- the resolved transition, end to end ------------------------------
    // Resolving a reference DELETES its `unresolved_reference` row, and the
    // context's link to that row carries ON DELETE CASCADE — so without the
    // repoint, the GOOD outcome silently destroys every scrap of evidence
    // about where in the paper the reference was cited. This asserts the whole
    // row survives, not merely that some row does: the anchor, the printed
    // text and the role's provenance are each recorded separately and each
    // must come through the transition unchanged.
    {
      const citing = unresolvedRow.citing_work_id
      const u = db
        .prepare(
          `INSERT INTO unresolved_reference
             (citing_work_id, raw_bib_text, guessed_title, ordinal, status, created_at)
           VALUES (?, '[41] A paper that will resolve. J. Test 2021.',
                   'A paper that will resolve', 41, 'unresolved', ?)`
        )
        .run(citing, now)
      const uid = Number(u.lastInsertRowid)
      const ctxId = Number(
        db
          .prepare(
            `INSERT INTO citation_context
               (unresolved_reference_id, citing_work_id, ordinal, callout_offset, callout_end,
                para_id, page, sentence, section, raw_bib_text, occurrence_kind,
                role, role_source, role_cue, created_at)
             VALUES (?, ?, 41, 7710, 7714, 'p88', 6,
                     'These results corroborate the findings of [41].', 'discussion',
                     '[41] A paper that will resolve. J. Test 2021.', 'inline',
                     'support', 'rule', 'r5-support', ?)`
          )
          .run(uid, citing, now).lastInsertRowid
      )
      const beforeCtx = db.prepare('SELECT * FROM citation_context WHERE id = ?').get(ctxId) as Record<string, unknown>

      const promoted = resolveUnresolvedReference(
        db,
        uid,
        { newWork: { title: 'A paper that will resolve', doi: '10.9999/verify-backend-promote' } },
        now
      )
      check('the resolve reports the contexts it carried across', promoted.contextsMoved === 1, `${promoted.contextsMoved}`)

      const afterCtx = db.prepare('SELECT * FROM citation_context WHERE id = ?').get(ctxId) as Record<string, unknown> | undefined
      check('the context survived the resolve at all', !!afterCtx)
      if (afterCtx) {
        check('...and is the SAME row, not a copy', afterCtx.created_at === beforeCtx.created_at)
        check('...now pointing at the edge', afterCtx.edge_id === promoted.edgeId, `edge ${afterCtx.edge_id}`)
        check('...and no longer at the deleted unresolved row', afterCtx.unresolved_reference_id === null)
        // The anchor. Without these the context cannot be found in the PDF
        // again, which is the only thing that makes it evidence rather than a
        // quotation.
        const anchorKept =
          afterCtx.para_id === beforeCtx.para_id &&
          afterCtx.callout_offset === beforeCtx.callout_offset &&
          afterCtx.callout_end === beforeCtx.callout_end &&
          afterCtx.ordinal === beforeCtx.ordinal &&
          afterCtx.page === beforeCtx.page
        check('...with its anchor intact (para_id, offsets, ordinal, page)', anchorKept)
        check('...with the raw bibliography text intact', afterCtx.raw_bib_text === beforeCtx.raw_bib_text)
        check('...with the sentence intact', afterCtx.sentence === beforeCtx.sentence)
        check(
          '...and the role provenance intact',
          afterCtx.role === 'support' && afterCtx.role_source === 'rule' && afterCtx.role_cue === 'r5-support'
        )
      }
    }

    // A self-citation produces NO edge by policy, so its contexts have nothing
    // left to be evidence for. That loss must be deliberate and counted — and
    // the returned id must be null, never a `0` sentinel a caller could pass on
    // as though it named a row.
    {
      const selfWork = Number(
        db
          .prepare(
            `INSERT INTO work (title, work_type, publication_year, venue, created_at, updated_at)
             VALUES ('A paper that cites itself', 'journal-article', 2021, 'v', ?, ?)`
          )
          .run(now, now).lastInsertRowid
      )
      const u = db
        .prepare(
          `INSERT INTO unresolved_reference
             (citing_work_id, raw_bib_text, guessed_title, ordinal, status, created_at)
           VALUES (?, '[1] A paper that cites itself.', 'A paper that cites itself', 1, 'unresolved', ?)`
        )
        .run(selfWork, now)
      const uid = Number(u.lastInsertRowid)
      db.prepare(
        `INSERT INTO citation_context
           (unresolved_reference_id, citing_work_id, ordinal, callout_offset, callout_end,
            occurrence_kind, created_at)
         VALUES (?, ?, 1, 100, 103, 'inline', ?)`
      ).run(uid, selfWork, now)

      const edgesBeforeSelf = (db.prepare('SELECT COUNT(*) AS c FROM citation_edge').get() as { c: number }).c
      const selfRes = resolveUnresolvedReference(db, uid, { workId: selfWork }, now)
      const edgesAfterSelf = (db.prepare('SELECT COUNT(*) AS c FROM citation_edge').get() as { c: number }).c
      check('a self-citation returns edgeId null, never a 0 sentinel', selfRes.edgeId === null, `${selfRes.edgeId}`)
      check('a self-citation materialises no edge', edgesAfterSelf === edgesBeforeSelf)
      check(
        'a self-citation reports the contexts it discarded',
        selfRes.contextsDiscardedSelfCite === 1,
        `${selfRes.contextsDiscardedSelfCite}`
      )
    }

    // Idempotent dedup: resolving to the SAME target by DOI must reuse the work
    // (matchedBy=doi) and NOT create a duplicate edge.
    const dupUnresolved = db
      .prepare(
        `INSERT INTO unresolved_reference (citing_work_id, raw_bib_text, guessed_doi, status, created_at)
         VALUES (?, 'dup ref', '10.9999/verify-backend-ref', 'unresolved', ?)`
      )
      .run(unresolvedRow.citing_work_id, now)
    const resolved2 = resolveUnresolvedReference(
      db,
      Number(dupUnresolved.lastInsertRowid),
      { newWork: { title: 'totally different title', doi: '10.9999/verify-backend-ref' } },
      now
    )
    check('A-M3: DOI dedup reuses existing work (matchedBy=doi)', resolved2.matchedBy === 'doi', resolved2.matchedBy)
    check('A-M3: DOI dedup did not create a new work', !resolved2.createdWork)
  }

  // ======================================================================
  // CITATIONS — parsed-vs-asserted provenance, the reference-tree DTO, and
  // the corpus-growth invalidation path.
  // ======================================================================
  {
    const edgeCols = (db.pragma('table_info(citation_edge)') as Array<{ name: string }>).map(
      (c) => c.name
    )
    check(
      'CITATIONS: citation_edge carries parse provenance',
      ['source', 'match_confidence', 'match_method'].every((c) => edgeCols.includes(c))
    )

    const bySource = db
      .prepare(`SELECT source, COUNT(*) AS c FROM citation_edge GROUP BY source`)
      .all() as Array<{ source: string; c: number }>
    const asserted = bySource.find((r) => r.source === 'asserted')?.c ?? 0
    // >= 91 rather than == 91: the A-M3 scenario above resolves references into
    // additional asserted edges before this block runs. The invariant under test
    // is that the hand-authored edges are all present AND classified as
    // asserted, not that nothing else ever adds one.
    check(
      'CITATIONS: the 91 hand-authored edges are marked asserted, not parsed',
      asserted >= 91 && !bySource.some((r) => r.source !== 'asserted' && r.source !== 'parsed'),
      `asserted=${asserted}`
    )
    check(
      'CITATIONS: an asserted edge carries NO fabricated parser confidence',
      (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM citation_edge
              WHERE source='asserted' AND match_confidence IS NOT NULL`
          )
          .get() as { c: number }
      ).c === 0
    )

    // The reference tree must expose unresolved nodes ONLY when asked, and must
    // always report the true total so the UI can disclose what it omits.
    const treeDefault = getReferenceTree(db, 1, {})
    check(
      'CITATIONS: getReferenceTree omits unresolved nodes by default',
      treeDefault.unresolved.length === 0
    )
    check(
      'CITATIONS: every work node carries the kind discriminator',
      treeDefault.nodes.every((n) => n.kind === 'work')
    )

    // Plant unresolved references so this assertion holds whether or not the
    // PDF parse has been run against this DB.
    const insUnres = db.prepare(
      `INSERT INTO unresolved_reference
         (citing_work_id, raw_bib_text, guessed_title, guessed_year, section, status, created_at, ordinal)
       VALUES (?, ?, ?, ?, 'references', 'unresolved', ?, ?)`
    )
    for (let i = 1; i <= 3; i++) {
      insUnres.run(2, `verify fixture reference ${i}`, `Fixture reference ${i}`, 2000 + i, now, i)
    }

    const treeWith = getReferenceTree(db, 1, { unresolvedPerWork: 2 })
    check(
      'CITATIONS: unresolvedPerWork caps nodes PER CITING WORK',
      treeWith.unresolved.filter((u) => u.citing_work_ids.includes(2)).length === 2,
      `${treeWith.unresolved.filter((u) => u.citing_work_ids.includes(2)).length}`
    )
    check(
      'CITATIONS: total_unresolved reports the full count, not the capped one',
      treeWith.total_unresolved >= 3,
      `${treeWith.total_unresolved}`
    )
    check(
      'CITATIONS: every unresolved node is discriminated as unresolved',
      treeWith.unresolved.every((u) => u.kind === 'unresolved')
    )
    check(
      'CITATIONS: an unresolved node preserves its raw bib text verbatim',
      treeWith.unresolved.every((u) => typeof u.raw_bib_text === 'string' && u.raw_bib_text.length > 0)
    )

    // ---- MERGING one cited paper's many bibliography rows -----------------
    // The same paper cited by two works. Drawn one card per ROW it was
    // selectable — and therefore retrievable — twice over; a KNOWN paper cited
    // twice was always one node with two incoming edges, and this is what makes
    // the unknowns agree.
    const twoCiters = (
      db
        .prepare(
          `SELECT work_id FROM project_work WHERE project_id = 1 AND work_id <> 2
            ORDER BY work_id ASC LIMIT 1`
        )
        .get() as { work_id: number } | undefined
    )?.work_id
    if (twoCiters !== undefined) {
      const sharedA = Number(
        insUnres.run(2, 'Shared Ref, J. Merge 1999.', 'A Shared Cited Paper', 1999, now, 60)
          .lastInsertRowid
      )
      const sharedB = Number(
        insUnres.run(
          twoCiters,
          'Shared  Ref., J. Merge (1999)',
          'a  shared, cited paper!',
          1999,
          now,
          61
        ).lastInsertRowid
      )
      const merged = getReferenceTree(db, 1, { unresolvedPerWork: 200 }).unresolved
      const node = merged.find((u) => u.member_ids.includes(sharedA))
      check(
        'MERGE: two bibliography rows naming one paper collapse to ONE node',
        merged.filter((u) => u.member_ids.includes(sharedA) || u.member_ids.includes(sharedB))
          .length === 1
      )
      check(
        'MERGE: the merged node carries EVERY work that cited the paper',
        node?.citing_work_ids.includes(2) === true &&
          node?.citing_work_ids.includes(twoCiters) === true,
        `${node?.citing_work_ids.join('/')}`
      )
      check(
        'MERGE: the merged node names both rows it stands for',
        node?.member_ids.includes(sharedA) === true && node?.member_ids.includes(sharedB) === true
      )
      check(
        'MERGE: the representative id is a REAL row, not a synthesized one',
        node?.id === Math.min(sharedA, sharedB)
      )

      // ONE selection, ONE job. Retrieving the merged card must fetch the paper
      // once and leave every row it stands for reporting that same retrieval.
      const mergeJobs: number[] = []
      const mergePlan = (input: { workId: number; projectId: number }): number[] => {
        const id = Number(
          db
            .prepare(
              `INSERT INTO processing_job (job_type, stage, status, work_id, project_id, attempts, created_at, updated_at)
               VALUES ('retrieval', 'download', 'queued', ?, ?, 0, ?, ?)`
            )
            .run(input.workId, input.projectId, now, now).lastInsertRowid
        )
        mergeJobs.push(id)
        return [id]
      }
      const mergeBatch = retrieveUnresolvedReferences(db, 1, [node!.id], now, mergePlan)
      check(
        'MERGE: retrieving a merged card creates exactly ONE job',
        mergeBatch.queued.length === 1 && mergeJobs.length === 1,
        `${mergeBatch.queued.length} queued / ${mergeJobs.length} jobs`
      )
      const bothRows = db
        .prepare(
          `SELECT retrieval_status, retrieval_job_id FROM unresolved_reference
            WHERE id IN (?, ?)`
        )
        .all(sharedA, sharedB) as Array<{ retrieval_status: string; retrieval_job_id: number }>
      check(
        'MERGE: every row of the paper shares that one job and its status',
        bothRows.length === 2 &&
          bothRows.every(
            (r) => r.retrieval_status === 'retrieving' && r.retrieval_job_id === mergeJobs[0]
          )
      )
      // The OTHER row of the same paper is not a fresh choice either — the paper
      // is already being fetched, whichever bibliography it was reached through.
      const viaOther = retrieveUnresolvedReferences(db, 1, [sharedB], now, mergePlan)
      check(
        'MERGE: the same paper reached through another citer cannot be queued again',
        viaOther.queued.length === 0 && viaOther.skipped[0]?.reason === 'already-retrieving'
      )
      // Settling through the representative must settle the WHOLE group, or the
      // next merged read would resurrect a status the job has already left.
      db.prepare(
        `UPDATE processing_job SET status = 'failed', error = 'no network access' WHERE id = ?`
      ).run(mergeJobs[0])
      settleReferenceRetrievals(db, [node!.id])
      const settledRows = db
        .prepare(`SELECT retrieval_status FROM unresolved_reference WHERE id IN (?, ?)`)
        .all(sharedA, sharedB) as Array<{ retrieval_status: string }>
      check(
        'MERGE: settling the merged card settles every row it stands for',
        settledRows.every((r) => r.retrieval_status === 'failed')
      )

      db.prepare('DELETE FROM unresolved_reference WHERE id IN (?, ?)').run(sharedA, sharedB)
    }

    check(
      'MERGE: an entry naming neither DOI nor title stands alone, never fused',
      referenceIdentityKey({ id: 7, doi: null, title: null }) !== // an "ibid."
        referenceIdentityKey({ id: 8, doi: null, title: null })
    )
    check(
      'MERGE: DOI beats title — the same paper under two printed titles is one key',
      referenceIdentityKey({ id: 1, doi: '10.1/X', title: 'One Title' }) ===
        referenceIdentityKey({ id: 2, doi: 'https://doi.org/10.1/x', title: 'Other Title' })
    )

    // ---- RETRIEVAL of cited-but-absent papers ---------------------------
    // Three shapes, chosen so every branch of the retrievability rule is
    // exercised: a DOI (best identifier), a venue-only entry (the weakest
    // query the rule still accepts) and one that names NOTHING — the sole
    // non-retrievable case, and the reason the retrieve button can be disabled.
    const insBare = db.prepare(
      `INSERT INTO unresolved_reference
         (citing_work_id, raw_bib_text, guessed_doi, guessed_title, guessed_venue,
          guessed_year, section, status, created_at, ordinal)
       VALUES (?, ?, ?, ?, ?, ?, 'references', 'unresolved', ?, ?)`
    )
    const withDoi = Number(
      insBare.run(2, 'retrieval fixture, doi', '10.1234/verify-retrieval', null, null, 2015, now, 90)
        .lastInsertRowid
    )
    const venueOnly = Number(
      insBare.run(2, 'retrieval fixture, venue only', null, null, 'J. Verify Chem.', 2011, now, 91)
        .lastInsertRowid
    )
    const nameless = Number(
      insBare.run(2, 'ibid.', null, null, null, null, now, 92).lastInsertRowid
    )

    check(
      'RETRIEVE: a DOI is the chosen identifier when present',
      referenceRetrievalTarget({ doi: '10.1/x', title: 'T', venue: 'V', year: 2000 })?.kind === 'doi'
    )
    check(
      'RETRIEVE: a title is chosen when there is no DOI',
      referenceRetrievalTarget({ doi: null, title: 'T', venue: 'V', year: 2000 })?.query === 'T'
    )
    check(
      'RETRIEVE: a venue/year tuple stands in when there is neither DOI nor title',
      referenceRetrievalTarget({ doi: null, title: null, venue: 'J. V.', year: 2011 })?.query ===
        'J. V. 2011'
    )
    check(
      'RETRIEVE: a reference naming nothing at all is NOT retrievable',
      referenceRetrievalTarget({ doi: null, title: null, venue: null, year: null }) === null
    )

    const retreeNodes = getReferenceTree(db, 1, { unresolvedPerWork: 200 }).unresolved
    const nodeOf = (id: number): (typeof retreeNodes)[number] | undefined =>
      retreeNodes.find((u) => u.id === id)
    check(
      'RETRIEVE: the tree DTO exposes the derived retrieval kind',
      nodeOf(withDoi)?.retrieval_kind === 'doi' && nodeOf(venueOnly)?.retrieval_kind === 'title',
      `${nodeOf(withDoi)?.retrieval_kind}/${nodeOf(venueOnly)?.retrieval_kind}`
    )
    check(
      'RETRIEVE: a nameless reference reports a null retrieval kind',
      nodeOf(nameless)?.retrieval_kind === null
    )
    check(
      'RETRIEVE: an unattempted reference starts at retrieval_status none',
      retreeNodes.every((u) => u.retrieval_status === 'none')
    )

    const jobIds: number[] = []
    const fakePlan = (input: { workId: number; projectId: number }): number[] => {
      const info = db
        .prepare(
          `INSERT INTO processing_job (job_type, stage, status, work_id, project_id, attempts, created_at, updated_at)
           VALUES ('retrieval', 'download', 'queued', ?, ?, 0, ?, ?)`
        )
        .run(input.workId, input.projectId, now, now)
      const id = Number(info.lastInsertRowid)
      jobIds.push(id)
      return [id]
    }

    const batch = retrieveUnresolvedReferences(
      db,
      1,
      [withDoi, venueOnly, nameless],
      now,
      fakePlan
    )
    check(
      'RETRIEVE: only the retrievable members of a mixed batch are queued',
      batch.queued.length === 2 && batch.skipped.length === 1,
      `${batch.queued.length} queued / ${batch.skipped.length} skipped`
    )
    check(
      'RETRIEVE: the nameless reference is skipped as not-retrievable, not failed',
      batch.skipped[0]?.unresolved_id === nameless &&
        batch.skipped[0]?.reason === 'not-retrievable'
    )
    check(
      'RETRIEVE: each queued reference gets a real work AND a real job',
      batch.queued.every((q) => q.work_id > 0 && q.job_id > 0)
    )

    settleReferenceRetrievals(db)
    const afterQueue = getReferenceRetrievals(db, [withDoi, venueOnly, nameless])
    check(
      'RETRIEVE: a queued reference reads back as retrieving',
      afterQueue.filter((r) => r.retrieval_status === 'retrieving').length === 2
    )
    check(
      'RETRIEVE: a skipped reference is untouched by the batch',
      afterQueue.find((r) => r.unresolved_id === nameless)?.retrieval_status === 'none'
    )

    // ALREADY-IN-PROGRESS. Re-submitting an in-flight reference must be a skip,
    // never a second job — that is what makes the card un-selectable honest.
    const again = retrieveUnresolvedReferences(db, 1, [withDoi], now, fakePlan)
    check(
      'RETRIEVE: an in-flight reference cannot be queued twice',
      again.queued.length === 0 && again.skipped[0]?.reason === 'already-retrieving'
    )

    // FAILURE. The job ends without producing a document, which is what really
    // happens offline; the reference must say so rather than silently settling.
    db.prepare(
      `UPDATE processing_job SET status = 'failed', error = 'no network access' WHERE id = ?`
    ).run(jobIds[0])
    db.prepare(`UPDATE processing_job SET status = 'done' WHERE id = ?`).run(jobIds[1])
    settleReferenceRetrievals(db)
    const settled = getReferenceRetrievals(db, [withDoi, venueOnly])
    check(
      'RETRIEVE: a failed job marks its reference failed and carries the reason',
      settled.find((r) => r.unresolved_id === withDoi)?.retrieval_status === 'failed' &&
        settled.find((r) => r.unresolved_id === withDoi)?.retrieval_error === 'no network access'
    )
    check(
      'RETRIEVE: a job that merely FINISHED without a document is failed, not retrieved',
      settled.find((r) => r.unresolved_id === venueOnly)?.retrieval_status === 'failed',
      `${settled.find((r) => r.unresolved_id === venueOnly)?.retrieval_status}`
    )

    // A failure takes its placeholder work with it: the work exists only to be
    // filled in by the fetch, and an empty one would show up in the corpus as a
    // readable paper titled with raw bibliography text.
    check(
      'RETRIEVE: a failed retrieval deletes the placeholder work it created',
      db
        .prepare('SELECT COUNT(*) AS c FROM work WHERE id IN (?, ?)')
        .get(batch.queued[0].work_id, batch.queued[1].work_id) !== undefined &&
        (
          db
            .prepare('SELECT COUNT(*) AS c FROM work WHERE id IN (?, ?)')
            .get(batch.queued[0].work_id, batch.queued[1].work_id) as { c: number }
        ).c === 0
    )
    check(
      'RETRIEVE: the reference survives its deleted placeholder, keeping the failure',
      (
        db
          .prepare('SELECT retrieval_work_id AS w, retrieval_status AS s FROM unresolved_reference WHERE id = ?')
          .get(withDoi) as { w: number | null; s: string }
      ).w === null
    )

    // SUCCESS is defined by a real document. The earlier work is gone with its
    // failure, so re-queue to get a live one rather than planting a document on
    // a deleted row.
    const okBatch = retrieveUnresolvedReferences(db, 1, [venueOnly], now, fakePlan)
    const okWork = okBatch.queued[0].work_id
    db.prepare(
      `UPDATE document SET retrieval_status = 'retrieved' WHERE work_id = ?`
    ).run(okWork)
    db.prepare(`UPDATE processing_job SET status = 'done' WHERE id = ?`).run(
      okBatch.queued[0].job_id
    )
    settleReferenceRetrievals(db)
    check(
      'RETRIEVE: a reference whose work gained a document reads back as retrieved',
      getReferenceRetrievals(db, [venueOnly])[0]?.retrieval_status === 'retrieved'
    )
    check(
      'RETRIEVE: a SUCCEEDED retrieval keeps its work',
      (db.prepare('SELECT COUNT(*) AS c FROM work WHERE id = ?').get(okWork) as { c: number }).c ===
        1
    )

    // PERSISTENCE: the state is in SQLite, so a fresh read of the tree — the
    // same call a remounted screen makes — still reports it.
    const reread = getReferenceTree(db, 1, { unresolvedPerWork: 200 }).unresolved
    check(
      'RETRIEVE: retrieval state survives into a fresh reference-tree read',
      reread.find((u) => u.id === withDoi)?.retrieval_status === 'failed' &&
        reread.find((u) => u.id === withDoi)?.retrieval_error === 'no network access'
    )

    // INVALIDATION. Adding a work must NOT make an existing parse stale — a
    // PDF's bibliography does not change because the library around it grew —
    // and the re-match must still run without re-reading any PDF.
    const beforeStale = findStaleParses(db).length
    db.prepare(
      `INSERT INTO work_citation_parse
         (work_id, document_id, parser_version, doc_sha, corpus_size, reference_count,
          matched_count, section_strategy, entry_style, no_text_layer, parsed_at)
       VALUES (2, NULL, ?, 'sha', (SELECT COUNT(*) FROM work), 3, 0, 'heading', 'dot', 0, ?)
       ON CONFLICT(work_id) DO UPDATE SET corpus_size=excluded.corpus_size`
    ).run(PARSER_VERSION, now)
    check(
      'CITATIONS: a fresh parse row is NOT stale',
      !findStaleParses(db).some((s) => s.work_id === 2),
      `${beforeStale}`
    )

    db.prepare(
      `INSERT INTO work (title, work_type, publication_year, venue, created_at, updated_at)
       VALUES ('A newly ingested paper', 'journal-article', 2024, 'New Journal', ?, ?)`
    ).run(now, now)
    // THE REGRESSION THIS NOW GUARDS. Reporting corpus growth as a stale PARSE
    // marked every parsed paper for a full re-read after a single import — and
    // once `references` stopped hashing the corpus size, nothing re-ran a parse
    // on growth, so the complaint could never clear. Matching is the half that
    // depends on the corpus, and `rematchUnresolved` below is how it is served.
    check(
      'CITATIONS: adding a work does NOT make an existing parse stale',
      !findStaleParses(db).some((s) => s.work_id === 2)
    )

    const promoted = rematchUnresolved(db)
    check(
      'CITATIONS: re-match runs over STORED references and returns a count',
      Number.isInteger(promoted) && promoted >= 0,
      `promoted=${promoted}`
    )

    // A PARSER change is the one thing that must still reopen a parse.
    db.prepare(
      `UPDATE work_citation_parse SET parser_version = 'not-the-current-one' WHERE work_id = 2`
    ).run()
    check(
      'CITATIONS: a parser change DOES make the parse stale',
      findStaleParses(db).some((s) => s.work_id === 2 && s.reason === 'parser')
    )
    db.prepare(`UPDATE work_citation_parse SET parser_version = ? WHERE work_id = 2`).run(
      PARSER_VERSION
    )
  }

  closeDb()

  // Remove the throwaway temp DB (leave an explicit CORPUS_DB_PATH in place so a
  // dev can inspect the post-run state).
  if (!explicit) {
    for (const suffix of ['', '-wal', '-shm']) {
      const p = dbFile + suffix
      try {
        if (existsSync(p)) rmSync(p)
      } catch {
        /* best effort */
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('verify-backend crashed:', err)
  process.exit(1)
})
