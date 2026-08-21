// Deterministic seed for the REAL "KE07 Kemp Eliminase Engineering" corpus.
//
// EVERYTHING lives in SQLite — no hardcoded paper data in the UI. The 20-paper
// KE07 dataset is INGESTED at seed time from scripts/data/ke07-corpus.json (via
// src/main/db/ke07-corpus.ts, main-process only) and inserted into the DB; the
// renderer reads ONLY from the DB through window.api (seed-only-DB rule).
//
// WHAT THIS SEEDS AND WHAT IT DOES NOT.
//
// It seeds FACTS ABOUT THE CORPUS — papers, authors, identifiers, venues, PDF
// locations, citation edges, project membership — and the project's own
// editorial judgements, which are the user's opinions and belong to nobody else.
// It seeds NO analysis: no facts extracted from a paper, no measurements, no
// evidence spans, no citation roles. Those are claims about what a paper says,
// and only a model that read the paper may make one. They are produced by
// `scripts/process-corpus.ts` driving the real pipeline against the real
// gateway, stamped with `run_origin` so a shipped analysis is never mistaken for
// one this machine computed.
//
// Explicit PKs (work ids = corpus order 1..20) and a fixed clock make e2e runs
// stable.

import type { DB } from './connection'
import { loadKe07Corpus, type CorpusPaper } from './ke07-corpus'
import { basename, isAbsolute, join } from 'node:path'
import { ensureStorageRoot, provisionLibrary } from './library'
import { MANAGED_STORAGE_LABEL } from './paths'
import { backfillSchemaHashes } from './schemaHash'
import { loadShippedAnalyses } from './shipped-analyses'

const NOW = process.env.CORPUS_FAKE_NOW ?? '2026-01-01T00:00:00Z'

interface SeedOpts {
  now?: string
}

// ------------------------------------------------------------------ helpers
const clamp01 = (x: number): number => Math.max(0, Math.min(1, x))
const round2 = (x: number): number => Math.round(x * 100) / 100
function tokenize(text: string | null | undefined): Set<string> {
  const out = new Set<string>()
  if (!text) return out
  for (const t of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) if (t.length >= 3) out.add(t)
  return out
}
function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0
  for (const t of a) if (b.has(t)) n++
  return n
}

/**
 * Map the corpus's semantic work_type onto the schema's work.work_type CHECK
 * enum. The corpus buckets (primary-research/foundational/method) are all in
 * fact journal articles by venue; only 'review' has a direct schema bucket.
 */
function schemaWorkType(wt: CorpusPaper['work_type']): string {
  switch (wt) {
    case 'review':
      return 'review'
    case 'preprint':
      return 'preprint'
    case 'dataset':
      return 'dataset'
    default:
      return 'journal-article' // primary-research | foundational | method
  }
}

/**
 * Where to READ one corpus paper's PDF from, before it is provisioned into the
 * managed library.
 *
 * `CORPUS_SEED_PDF_DIR` redirects the whole corpus to another directory by
 * basename, which is what lets a machine that does not have the original
 * assembly path still seed real bytes. Without it each paper's recorded
 * `pdf_path` is used as-is. Either way this is a SEED INPUT: no row records it,
 * and after seeding nothing refers to it again.
 */
function sourcePdfPath(p: CorpusPaper): string {
  const dir = process.env.CORPUS_SEED_PDF_DIR
  if (dir && dir.trim()) {
    const base = isAbsolute(dir) ? dir : join(process.cwd(), dir)
    return join(base, basename(p.pdf_path))
  }
  return p.pdf_path
}

export function seed(db: DB, opts: SeedOpts = {}): void {
  const now = opts.now ?? NOW
  const corpus = loadKe07Corpus()

  // Filesystem work happens BEFORE the transaction opens: a SQLite transaction
  // holds a write lock, and linking 20 files inside one would hold it across
  // filesystem latency we do not control (a slow or unresponsive source mount).
  // Nothing here writes to the DB, so a failure leaves no half-seeded state.
  const storageRoot = ensureStorageRoot()
  const provisioned = provisionLibrary(corpus.map(sourcePdfPath))

  const run = db.transaction(() => {
    // Idempotent: clear children-first (WAL-safe; no FK toggling inside txn).
    for (const t of [
      // Cleared FIRST: it points at analysis_run (RESTRICT) and, with SET NULL,
      // at fact/measurement — clearing it up front keeps the reseed free of
      // incidental cascade UPDATEs on rows that are about to go anyway.
      'analysis_check',
      'fold_improvement',
      'measurement',
      // Per-project schema attachments, cleared BEFORE the schemas (and before
      // `project`) they reference. Both FKs are ON DELETE CASCADE, so this is
      // belt-and-braces — but the reseed stays free of incidental cascade work.
      'project_schema',
      // Cleared AFTER measurement so no live field_id reference exists while the
      // definitions go away (the FK is ON DELETE SET NULL, but clearing in
      // dependency order keeps the reseed free of incidental UPDATEs).
      'extraction_field',
      'extraction_schema',
      'fact',
      'evidence_span',
      'analysis_run',
      'citation_context',
      'citation_edge',
      'unresolved_reference',
      'file_location',
      'project_work',
      'work_author',
      'identifier',
      'document',
      'saved_frontier',
      'saved_search',
      // Before processing_job, whose job_dependency rows reference it. A
      // stage_run left behind by a non-fresh reseed points at works that no
      // longer exist AND keeps holding its ux_stage_run_current slot, so every
      // subsequent re-plan would resolve to a cache hit for data that is gone.
      'job_dependency',
      'stage_artifact',
      'stage_run',
      'processing_job',
      'affiliation',
      'author',
      'work',
      'project',
      'base_dir',
      'setting',
      'llm_model'
    ]) {
      db.prepare(`DELETE FROM ${t}`).run()
    }

    // ----------------------------------------------------- settings + models
    // App-owned config, DB-backed (seed-only-DB rule): the selectable analysis
    // models + the default selection are REAL rows, not a hardcoded renderer
    // array. Model options mirror the design (Corpus.dc.html `models`). Fixed
    // ids + sort_order keep the seed deterministic.
    db.prepare(
      `INSERT INTO llm_model (id, label, sub, provider, sort_order, created_at) VALUES
        ('gpt-4.1',   'GPT-4.1',     'OpenAI',        'OpenAI',    0, @now),
        ('opus-med',  'Claude Opus', 'Medium effort', 'Anthropic', 1, @now),
        ('opus-high', 'Claude Opus', 'High effort',   'Anthropic', 2, @now),
        ('opus-max',  'Claude Opus', 'Max effort',    'Anthropic', 3, @now)`
    ).run({ now })
    db.prepare(
      `INSERT INTO setting (key, value, updated_at) VALUES ('selected_model_id', 'gpt-4.1', @now)`
    ).run({ now })

    // ------------------------------------------------- extraction schemas
    // The user-owned definitions of WHAT the AI extracts. The Extraction screen
    // builds its columns from these field rows and the LLM prompt is built from
    // them, so no domain literal survives in code — the app is agnostic to the
    // field it is pointed at, and these two are merely the shapes this corpus
    // happens to need. Both are seeded as GLOBAL built-ins (project_id=0, the
    // same sentinel analysis_run uses) because they are field-standard shapes;
    // a project chooses which to apply through the `project_schema` attachments.
    // Fixed ids + explicit sort_order keep `seed:fresh` reproducible.
    //
    // Schema 1 — Enzyme Kinetics. It deliberately does NOT define
    // fold/comparability fields: those remain first-class in the
    // `fold_improvement` table with its 4-enum, so there is exactly one source
    // of truth for comparability.
    //
    // Schema 2 — Protein Thermostability Characterization. A genuinely distinct
    // real-world shape for the same corpus: KE07 directed-evolution papers
    // report thermal tolerance (Tm / T50 / ΔΔG / half-life) with a stated
    // measurement method, which the kinetics schema cannot express.
    //
    // `export_alias` is seeded NULL on both. Naming your own export format is a
    // real feature of a schema, but it is the USER's to name: shipping one
    // pre-branded made a single interchange format look like a built-in
    // capability of an app that has no opinion about any particular field.
    db.prepare(
      // `version` is left empty here: backfillSchemaHashes() at the end of the
      // seed derives it from the fields actually inserted, so a seeded schema is
      // byte-identical to one built through the CRUD path.
      `INSERT INTO extraction_schema
         (id, project_id, key, name, description, version, is_builtin, export_alias, created_at, updated_at)
       VALUES
        (1, 0, 'enzyme-kinetics', 'Enzyme Kinetics',
         'Steady-state kinetic characterization of an enzyme variant under stated assay conditions.',
         '', 1, NULL, @now, @now),
        (2, 0, 'protein-thermostability', 'Protein Thermostability Characterization',
         'Thermal tolerance of a protein variant: melting/inactivation temperatures, unfolding free-energy change and residual-activity half-life, with the biophysical method used.',
         '', 1, NULL, @now, @now)`
    ).run({ now })

    // Field definitions. `unit` is the TARGET/display unit — it never rewrites a
    // measurement's raw value/unit (raw-preservation rule); `description` is the
    // extraction hint handed to the model.
    db.prepare(
      `INSERT INTO extraction_field
         (id, schema_id, key, label, data_type, unit, required, enum_options, description, sort_order, created_at, updated_at)
       VALUES
        -- Enzyme Kinetics
        (1,  1, 'variant', 'Variant', 'text', NULL, 1, NULL,
         'Name or identifier of the enzyme variant the kinetics belong to (e.g. KE07 R7 2/5B).', 0, @now, @now),
        (2,  1, 'mutations', 'Mutations', 'text', NULL, 0, NULL,
         'Substitutions carried by this variant relative to the stated parent, comma separated (e.g. K222G, S48G).', 1, @now, @now),
        (3,  1, 'substrate', 'Substrate', 'text', NULL, 0, NULL,
         'Substrate assayed (e.g. 5-nitrobenzisoxazole).', 2, @now, @now),
        (4,  1, 'kcat', 'kcat', 'number', 's^-1', 0, NULL,
         'Turnover number from a steady-state fit.', 3, @now, @now),
        (5,  1, 'km', 'KM', 'number', 'mM', 0, NULL,
         'Michaelis constant.', 4, @now, @now),
        (6,  1, 'kcat_km', 'kcat/KM', 'number', 'M^-1 s^-1', 0, NULL,
         'Catalytic efficiency, as reported rather than recomputed from kcat and KM.', 5, @now, @now),
        (7,  1, 'kcat_kuncat', 'kcat/kuncat', 'number', NULL, 0, NULL,
         'Rate enhancement over the uncatalyzed reaction; dimensionless.', 6, @now, @now),
        (8,  1, 'temperature', 'Temperature', 'number', 'C', 0, NULL,
         'Assay temperature in degrees Celsius.', 7, @now, @now),
        (9,  1, 'ph', 'pH', 'number', NULL, 0, NULL,
         'Assay pH.', 8, @now, @now),
        (10, 1, 'buffer', 'Buffer', 'text', NULL, 0, NULL,
         'Buffer composition and concentration used for the assay.', 9, @now, @now),
        (11, 1, 'evolution_round', 'Evolution round', 'number', NULL, 0, NULL,
         'Directed-evolution round or generation this variant came from, when the paper reports a trajectory.', 10, @now, @now),
        -- Protein Thermostability Characterization
        (12, 2, 'variant', 'Variant', 'text', NULL, 1, NULL,
         'Protein variant whose thermal stability is being characterized.', 0, @now, @now),
        (13, 2, 'tm', 'Tm', 'number', 'C', 0, NULL,
         'Midpoint melting temperature in degrees Celsius.', 1, @now, @now),
        (14, 2, 't50', 'T50', 'number', 'C', 0, NULL,
         'Temperature at which half of the initial activity is lost after a fixed incubation.', 2, @now, @now),
        (15, 2, 'ddg', 'ddG', 'number', 'kcal/mol', 0, NULL,
         'Change in unfolding free energy relative to the stated reference variant, signed as reported.', 3, @now, @now),
        (16, 2, 'half_life', 'Half-life', 'number', 'min', 0, NULL,
         'Residual-activity half-life at the incubation temperature recorded in half_life_temp.', 4, @now, @now),
        (17, 2, 'half_life_temp', 'Half-life temperature', 'number', 'C', 0, NULL,
         'Incubation temperature the half-life was measured at.', 5, @now, @now),
        (18, 2, 'method', 'Method', 'text', NULL, 0, NULL,
         'Biophysical method the measurement was made with.', 6, @now, @now),
        (19, 2, 'buffer_ph', 'Buffer pH', 'number', NULL, 0, NULL,
         'pH the stability measurement was performed at.', 7, @now, @now),
        (20, 2, 'reference_variant', 'Reference variant', 'text', NULL, 0, NULL,
         'The variant this measurement is compared against (parent, wild type, or original design).', 8, @now, @now)`
    ).run({ now })

    // ----------------------------------------------------------- base_dir
    // The app-owned library — the ONE storage location Corpus Studio creates and
    // manages itself. `readPdf` resolves base_dir.abs_path +
    // file_location.relative_path, so this row plus the basenames written below
    // is what makes a document openable.
    //
    // The seeder no longer names anybody's filesystem. Where the corpus PDFs are
    // READ FROM is an input (`CORPUS_SEED_PDF_DIR`, else each paper's recorded
    // pdf_path); where they LIVE is always this managed root. Any further
    // locations are the user's own, added in Settings — the seed inventing a
    // second one described a share that never existed on any machine.
    db.prepare(
      `INSERT INTO base_dir (id, label, abs_path, kind, created_at)
       VALUES (1, @label, @root, 'local', @now)`
    ).run({ now, label: MANAGED_STORAGE_LABEL, root: storageRoot })

    // ----------------------------------------------------------- project (ONE)
    const projectDescription =
      'Improve the catalytic efficiency (kcat/KM) of the KE07 Kemp eliminase via ' +
      'computational active-site design and directed evolution. Track the KE07 ' +
      'lineage from the 2008 de-novo design through the Tawfik directed-evolution ' +
      'series, and understand transition-state stabilization, electrostatic ' +
      'preorganization, and reorganization energy in designed Kemp eliminases.'
    db.prepare(
      `INSERT INTO project (id, name, slug, description, category, tags, created_at, updated_at) VALUES
        (1, 'KE07 Kemp Eliminase Engineering', 'ke07-kemp-eliminase', @desc,
         'Enzyme engineering', '["Enzyme kinetics","Directed evolution"]', @now, @now)`
    ).run({ now, desc: projectDescription })

    // ------------------------------------------------ project schema attachments
    // WHICH global schemas this project applies in its Extraction view. Inserted
    // here (not with the schema definitions above) because the FK needs the
    // project row to exist. Both seeded schemas are attached — the KE07 corpus
    // carries kinetics AND thermostability measurements, so both sections are
    // meaningful from a fresh seed. The user can detach either from Extraction.
    db.prepare(
      `INSERT INTO project_schema (project_id, schema_id, sort_order, created_at) VALUES
        (1, 1, 0, @now),
        (1, 2, 1, @now)`
    ).run({ now })

    // ----------------------------------------------------------- affiliations
    // Deduped by exact affiliation string, ids by first appearance in corpus order.
    const affIdByName = new Map<string, number>()
    const insAff = db.prepare(
      `INSERT INTO affiliation (id, name, country, ror, created_at) VALUES (?, ?, NULL, NULL, @now)`
    )
    let nextAffId = 1
    for (const p of corpus) {
      for (const a of p.authors) {
        const name = (a.affiliation ?? '').trim()
        if (!name) continue
        if (!affIdByName.has(name)) {
          const id = nextAffId++
          affIdByName.set(name, id)
          insAff.run(id, name, { now } as never)
        }
      }
    }

    // ----------------------------------------------------------- authors
    // Deduped by (given, family), ids by first appearance. orcid unknown -> NULL.
    const authorIdByName = new Map<string, number>()
    const insAuthor = db.prepare(
      `INSERT INTO author (id, full_name, given_name, family_name, orcid, created_at)
       VALUES (?, ?, ?, ?, NULL, @now)`
    )
    let nextAuthorId = 1
    const authorKey = (a: { given: string; family: string }): string =>
      `${(a.given ?? '').trim()}\u0000${(a.family ?? '').trim()}`
    for (const p of corpus) {
      for (const a of p.authors) {
        const key = authorKey(a)
        if (!authorIdByName.has(key)) {
          const id = nextAuthorId++
          authorIdByName.set(key, id)
          const given = (a.given ?? '').trim()
          const family = (a.family ?? '').trim()
          const full = [given, family].filter(Boolean).join(' ') || family || given || 'Unknown'
          insAuthor.run(id, full, given || null, family || null, { now } as never)
        }
      }
    }

    // ----------------------------------------------------------- works (20)
    const insWork = db.prepare(
      `INSERT INTO work (id, title, work_type, publication_year, venue, abstract, created_at, updated_at)
       VALUES (@id, @title, @wt, @year, @venue, @abstract, @now, @now)`
    )
    corpus.forEach((p, i) => {
      const id = i + 1
      const abstract = p.abstract && p.abstract.trim() ? p.abstract : null
      insWork.run({
        id,
        title: p.title,
        wt: schemaWorkType(p.work_type),
        year: p.year ?? null,
        venue: p.venue ?? null,
        abstract,
        now
      })
    })

    // ----------------------------------------------------------- work_author
    // Preserve per-paper author ORDER via position (1-based). Affiliation lives on
    // the join (per-work). Mark the first author corresponding (a field-convention
    // assumption — real corresponding data is not in the corpus).
    const insWa = db.prepare(
      `INSERT INTO work_author (work_id, author_id, affiliation_id, position, is_corresponding)
       VALUES (?, ?, ?, ?, ?)`
    )
    corpus.forEach((p, i) => {
      const workId = i + 1
      p.authors.forEach((a, idx) => {
        const authorId = authorIdByName.get(authorKey(a))!
        const affName = (a.affiliation ?? '').trim()
        const affId = affName ? (affIdByName.get(affName) ?? null) : null
        insWa.run(workId, authorId, affId, idx + 1, idx === 0 ? 1 : 0)
      })
    })

    // ----------------------------------------------------------- identifiers
    // DOI for all 20 (scheme='doi'); PMID where present. UNIQUE(scheme,value).
    const insId = db.prepare(
      `INSERT INTO identifier (work_id, scheme, value, created_at) VALUES (?, ?, ?, @now)`
    )
    corpus.forEach((p, i) => {
      const workId = i + 1
      insId.run(workId, 'doi', p.doi, { now } as never)
      if (p.pmid && String(p.pmid).trim()) insId.run(workId, 'pmid', String(p.pmid), { now } as never)
      if (p.arxiv && String(p.arxiv).trim()) insId.run(workId, 'arxiv', String(p.arxiv), { now } as never)
    })

    // ----------------------------------------------------------- documents + file_location
    // One preferred document per work pointing at the REAL PDF. Work 4
    // (Khersonsky 2012 PNAS) is modelled as abstract-only (analysis availability),
    // the rest fulltext — but every doc still has a real file_location so the
    // viewer can open the bytes.
    //
    // The bytes were placed in the managed library BEFORE this transaction
    // opened (see `provisioned` above), and `size_bytes` is measured on the file
    // that now exists there rather than on the source — the DB must describe the
    // library, not the machine the corpus happened to be assembled on.
    const insDoc = db.prepare(
      `INSERT INTO document (id, work_id, version_kind, title, content_status, retrieval_status, is_preferred, source_url, created_at)
       VALUES (?, ?, 'publisher-PDF', NULL, ?, ?, 1, ?, @now)`
    )
    const insFile = db.prepare(
      `INSERT INTO file_location (document_id, base_dir_id, relative_path, hash, size_bytes, role, last_modified, version, created_at)
       VALUES (?, 1, ?, NULL, ?, 'canonical', @now, 1, @now)`
    )
    corpus.forEach((p, i) => {
      const workId = i + 1
      const docId = i + 1 // 1:1 doc per work
      const absAbstractOnly = workId === 4
      const contentStatus = absAbstractOnly ? 'abstract-only' : 'fulltext'
      const retrievalStatus = absAbstractOnly ? 'paywalled' : 'retrieved'
      insDoc.run(docId, workId, contentStatus, retrievalStatus, `https://doi.org/${p.doi}`, {
        now
      } as never)
      const file = provisioned[i]
      insFile.run(docId, file.relativePath, file.sizeBytes, { now } as never)
    })

    // ----------------------------------------------------------- citation graph
    const doiToId = new Map<string, number>()
    corpus.forEach((p, i) => doiToId.set(p.doi, i + 1))
    const inDeg = new Map<number, number>()
    const outDeg = new Map<number, number>()
    const edgeList: Array<{ id: number; citing: number; cited: number }> = []
    let nextEdgeId = 1
    corpus.forEach((p, i) => {
      const citing = i + 1
      for (const citedDoi of p.cites ?? []) {
        const cited = doiToId.get(citedDoi)
        if (!cited || cited === citing) continue // only intra-set, no self-loops
        edgeList.push({ id: nextEdgeId++, citing, cited })
        outDeg.set(citing, (outDeg.get(citing) ?? 0) + 1)
        inDeg.set(cited, (inDeg.get(cited) ?? 0) + 1)
      }
    })
    // These 91 edges are HAND-AUTHORED claims, so they are stamped
    // source='asserted' and carry no match_confidence: a curated assertion has
    // no parser confidence, and inventing 1.0 would make it indistinguishable
    // from a DOI-exact parsed edge. The reference parser writes source='parsed'
    // rows alongside these and never deletes them.
    const insEdge = db.prepare(
      `INSERT INTO citation_edge (id, citing_work_id, cited_work_id, edge_type, created_at, source)
       VALUES (?, ?, ?, 'cites', @now, 'asserted')`
    )
    for (const e of edgeList) insEdge.run(e.id, e.citing, e.cited, { now } as never)

    // citation_context: the per-edge EVIDENCE — why this citation exists, where
    // in the citing paper it occurs, and in what rhetorical role. One edge can
    // carry SEVERAL occurrences (a paper that cites the same work in Methods and
    // again in Discussion is making two different claims about it), which is
    // what the graph's edge popover and the paper screen both read.
    //
    // Every edge gets at least one occurrence; edges out of work 2 get the full
    // three so that paper's screen shows the dense case. The count is derived
    // from the edge id so a reseed is deterministic.
    // NO ROLES. Every context is seeded unclassified, which is the honest state:
    // a role is a judgement about what a sentence is DOING, and nothing has
    // judged these yet.
    //
    // A role may arrive exactly two ways — the deterministic cue table in
    // `citations/roleRules.ts`, whose verdicts are reproducible and carry a
    // `role_cue`, or a model classifying the residue. Both run as the
    // `citation-contexts` stage over the actual PDFs, so both are answerable to
    // something a reader can check.
    const insCtx = db.prepare(
      `INSERT INTO citation_context
         (edge_id, citing_work_id, raw_bib_text, section, role, role_source, role_cue,
          occurrence_kind, resolution_confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, @now)`
    )
    const bibLine = (cited: number): string => {
      const cp = corpus[cited - 1]
      const first = cp.authors[0]
      const lead = first ? `${first.family} et al.` : 'Anon.'
      return `${lead} ${cp.venue ?? ''} (${cp.year ?? 'n.d.'}). ${cp.title}. doi:${cp.doi}`
    }
    for (const e of edgeList) {
      // ONE occurrence per edge: the printed bibliography line, which is the
      // only citation text derivable from corpus metadata without inventing it.
      //
      // Inline and footnote occurrences are NOT seeded, because an inline
      // occurrence stores the SENTENCE around the callout — the citing author's
      // own prose, which cannot be reconstructed from metadata. The
      // `citation-contexts` stage produces them by scanning the PDF's text and
      // storing what it finds, verbatim.
      //
      // `resolution_confidence` is NULL for the same reason the role is. It
      // states how sure the matcher was that this bibliography line names that
      // work, and no matcher ran: the seed KNOWS the pair, because it built the
      // line from the cited paper's own metadata. It used to be filled with
      // `0.6 + (edge.id % 4) / 10` — arithmetic on a row id, reaching the
      // Connectome popover as a number a reader would take for a measurement of
      // certainty. NULL is what the schema provides for saying nobody measured.
      insCtx.run(
        e.id,
        e.citing,
        bibLine(e.cited),
        'References',
        null,
        null,
        null,
        'bibliography',
        null,
        { now } as never
      )
    }

    // ----------------------------------------------------------- unresolved_reference
    // Left EMPTY by the seed on purpose. Unresolved references are now produced
    // by the reference parser reading the actual PDFs (`npm run parse:citations`,
    // which the seed runner invokes), and that parser OWNS every row for a
    // citing work — it deletes and rewrites them on each re-parse. Seeding
    // literals here would have them silently deleted on the first parse, and
    // until then they would misrepresent the corpus: the parser finds ~1000 real
    // external references, not two.

    // ----------------------------------------------------------- project_work (20)
    // relevance = TOPICAL fit (term overlap of project question vs title+abstract,
    // + primary-research bonus). expansion_priority = CITATION-FRONTIER centrality
    // (in+out degree within the set, + hub bonus). Two DISTINCT scores. Each row
    // gets a stored ranking_explanation naming the signals. A couple of manual
    // overrides are recorded in user_overrides.
    const descTokens = tokenize(projectDescription)
    const maxDeg = Math.max(1, ...corpus.map((_p, i) => (inDeg.get(i + 1) ?? 0) + (outDeg.get(i + 1) ?? 0)))
    // Deterministic inclusion-status assignment cycling through the enum so facets
    // + review UI have variety, but pin sensible statuses for the lineage anchors.
    const pinnedStatus: Record<number, string> = {
      1: 'included', // Rothlisberger 2008 design origin
      2: 'included', // Khersonsky 2010 directed-evolution series
      4: 'read', // Khersonsky 2012 PNAS (abstract-only)
      8: 'included', // Alexandrova 2008 mechanism
      14: 'included', // Blomberg 2013 precision
      18: 'excluded', // review — superseded by primaries
      20: 'uncertain' // 2025 distal mutations (frontier)
    }
    const statusCycle = ['unread', 'read', 'uncertain', 'included', 'unread']
    const overridesByWork: Record<number, string> = {
      2: '{"relevance":{"was":0.62,"now":0.97,"by":"user","reason":"canonical KE07 directed-evolution parent"}}',
      20: '{"inclusion_status":{"was":"excluded","now":"uncertain","by":"user","reason":"promising distal-mutation frontier"}}'
    }
    // Papers the (simulated) user marked as REFERENCES — the trusted sources the
    // topic dossier is compiled from (§8).
    const REFERENCE_WORK_IDS = new Set([1, 2])
    const insPw = db.prepare(
      `INSERT INTO project_work (project_id, work_id, relevance, expansion_priority, inclusion_status, exclusion_reason, is_reference, ranking_explanation, user_overrides, reviewed, created_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, @now, @now)`
    )
    corpus.forEach((p, i) => {
      const workId = i + 1
      const wtok = tokenize(`${p.title} ${p.abstract ?? ''}`)
      const ov = overlap(descTokens, wtok)
      const denom = Math.max(1, Math.min(descTokens.size, wtok.size))
      const lex = clamp01(ov / denom)
      let relevance = clamp01(0.6 * lex + (p.work_type === 'primary-research' ? 0.06 : 0))
      const deg = (inDeg.get(workId) ?? 0) + (outDeg.get(workId) ?? 0)
      const expansion = clamp01((deg / maxDeg) * 0.7 + ((inDeg.get(workId) ?? 0) >= 4 ? 0.1 : 0))
      // Manual override on work 2's relevance (recorded in user_overrides).
      if (workId === 2) relevance = 0.97
      const rel = round2(relevance)
      const exp = round2(expansion)
      const status = pinnedStatus[workId] ?? statusCycle[workId % statusCycle.length]
      const exclusion = status === 'excluded' ? 'Review superseded by the primary sources already included.' : null
      const explanation =
        `relevance ${rel}: term overlap with the KE07 research question (${ov} shared terms), ` +
        `${p.work_type} type weighting; expansion_priority ${exp}: citation degree ${deg} within the set` +
        ((inDeg.get(workId) ?? 0) >= 4 ? ' (highly-cited hub).' : '.')
      const reviewed = status === 'included' || status === 'excluded' || status === 'read' ? 1 : 0
      insPw.run(
        workId,
        rel,
        exp,
        status,
        exclusion,
        REFERENCE_WORK_IDS.has(workId) ? 1 : 0,
        explanation,
        overridesByWork[workId] ?? null,
        reviewed,
        { now } as never
      )
    })

    // ----------------------------------------------------------- analysis layer
    // THERE IS NONE, and that is deliberate.
    //
    // The seed's job is to establish what is FACTUAL about the corpus: the
    // papers, their authors, identifiers, PDFs, citation edges and the
    // project's own editorial judgements (relevance, inclusion, notes). None of
    // that requires a model, and all of it is either real bibliographic data or
    // the user's own opinion.
    //
    // An analysis is different in kind. A fact, an evidence span, a measurement,
    // a fold improvement and a citation role are all CLAIMS ABOUT WHAT A PAPER
    // SAYS, and the only thing entitled to make one is a model that read the
    // paper. So this seed INVENTS none of them. It loads the recorded output of
    // a genuine pipeline run (`scripts/process-corpus.ts` →
    // `scripts/export-analyses.ts`) and inserts it with `run_origin = 'shipped'`,
    // preserving the model, prompt and schema stamps exactly as recorded.
    //
    // When that dataset is absent — a checkout that has not processed the corpus
    // — nothing is inserted, and a corpus with no analyses is the honest state
    // of one nobody has analysed. Every screen already renders it.
    loadShippedAnalyses(db, now)

    // ----------------------------------------------------------- saved_search / frontier
    db.prepare(
      `INSERT INTO saved_search (project_id, name, query, filters, created_at, updated_at)
       VALUES (1, 'High-relevance KE07 primaries', 'kemp eliminase kcat', '{"inclusion_status":"included"}', @now, @now)`
    ).run({ now })
    db.prepare(
      `INSERT INTO saved_frontier (project_id, name, graph_state, created_at, updated_at)
       VALUES (1, 'KE07 lineage frontier', '{"seeds":[1,2],"expanded":[2,14],"viewport":{"x":0,"y":0,"k":1}}', @now, @now)`
    ).run({ now })

    // ----------------------------------------------------------- processing_job
    // All jobs scoped to project 1. TWO failed jobs (retrieval + citation-parse)
    // so the ingest queue's retry AND cancel flows both find a failed/cancellable
    // job, and the dashboard failed-retrievals pill is exercised. Plus a done and
    // a queued job for status variety. work_id must be in 1..20 (FK).
    //
    // Every TERMINAL job carries `started_at`/`finished_at`. A job that reads
    // as 'done' but was never claimed is an incoherent row, and the Queue can
    // only report it as "no duration recorded" — which reads as a claim about
    // the work rather than about the row. The spans are derived from `now` so
    // the seed stays reproducible, and differ per job so the column shows real
    // variety rather than one constant.
    //
    // Every row names a STAGE, because the scheduler resolves what to run from
    // the registry: a job that names none cannot be executed and is failed as
    // permanently broken, so a seeded `queued` row without one would turn red
    // on the first launch after seeding.
    const jobs: Array<
      [string, string, string, number | null, string | null, string | null, number, number]
    > = [
      // job_type, stage, status, work_id, payload, error, attempts, durationSec (0 = never ran)
      //
      // NO SEEDED FAILURES. These rows carry no `stage_run_id` — nothing ever
      // executed for them — so a seeded `failed` is a fabricated claim about a
      // real paper, and the pipeline contradicted both of the ones that used to
      // be here: "PDF text layer missing; OCR not enabled" sat on a paper whose
      // references stage had parsed 213 entries and matched 11, and "HTTP 403
      // paywalled" on one whose PDF had downloaded fine. The user read the red
      // badge as their corpus being broken and went hunting for a fault that
      // was never there.
      //
      // A failure is worth showing when it HAPPENED. Inventing one spends the
      // badge's credibility, and that badge is the one thing in the queue whose
      // job is to interrupt someone.
      ['extraction', 'schema-extract', 'done', 2, '{"analysisType":"extraction"}', null, 1, 47],
      ['retrieval', 'download', 'queued', 20, '{"url":"https://doi.org/10.1038/s41467-025-63802-7"}', null, 0, 0],
      ['ranking', 'schema-extract', 'done', 2, '{"scope":"project"}', null, 1, 3]
    ]
    const insJob = db.prepare(
      `INSERT INTO processing_job (job_type, stage, status, work_id, project_id, payload, error, attempts, created_at, updated_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, @now, @now, ?, ?)`
    )
    const nowMs = Date.parse(now)
    for (const j of jobs) {
      const seconds = j[7]
      const startedAt = seconds > 0 ? new Date(nowMs - seconds * 1000).toISOString() : null
      const finishedAt = seconds > 0 ? now : null
      insJob.run(j[0], j[1], j[2], j[3], j[4], j[5], j[6], startedAt, finishedAt, { now } as never)
    }
  })

  run()
  // The field rows above were inserted as literals, so they carry no param_hash
  // and their schemas no version. Derive both from what was actually written —
  // the SAME function the migration and the CRUD path use, so there is one
  // definition of schema identity rather than a seed-shaped copy of it.
  backfillSchemaHashes(db)
}
