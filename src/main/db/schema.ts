// Full Corpus Studio schema (migration v1). Every table, CHECK enum, partial
// unique index, FK (CASCADE vs RESTRICT) and index per build-notes.md.
//
// Enum conventions are enforced via CHECK constraints. project_id sentinel: 0 =
// global/general analysis (NON-NULL because SQLite treats NULLs as distinct in
// unique indexes, which would break the "one current run per (work,project,type)"
// guarantee).

export const SCHEMA_V1 = /* sql */ `
-- ============================================================ base_dir
-- Storage roots (e.g. a NAS mount). NAS remap = update a single row.
CREATE TABLE base_dir (
  id            INTEGER PRIMARY KEY,
  label         TEXT NOT NULL,
  abs_path      TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'local'
                  CHECK (kind IN ('local','nas','cloud','removable')),
  created_at    TEXT NOT NULL
);

-- ============================================================ work
-- A scholarly WORK (the abstract intellectual output), distinct from its
-- concrete DOCUMENT manifestations.
--
-- work_type's "method" is in this vocabulary but in no bibliographic index's: a
-- catalogue record answers a cataloguing question and calls a tool paper a
-- journal article. It is written only by the general summary, from the document,
-- and only where the document plainly shows it -- see migration v66 and
-- WORK_KIND_MARKER in llm/prompts.ts. Note what is absent: "foundational" is a
-- relation between a paper and a corpus, not a kind of paper, and is measured
-- from citations rather than asserted here.
CREATE TABLE work (
  id                INTEGER PRIMARY KEY,
  title             TEXT NOT NULL,
  work_type         TEXT NOT NULL DEFAULT 'journal-article'
                      CHECK (work_type IN (
                        'journal-article','preprint','conference-paper',
                        'book','book-chapter','review','method','dataset','thesis','other')),
  publication_year  INTEGER,
  venue             TEXT,
  abstract          TEXT,
  language          TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- ============================================================ document
-- A concrete manifestation of a work (a specific PDF/version).
CREATE TABLE document (
  id             INTEGER PRIMARY KEY,
  work_id        INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  version_kind   TEXT NOT NULL
                   CHECK (version_kind IN (
                     'preprint','accepted-ms','publisher-PDF',
                     'published-version','supplementary','other')),
  title          TEXT,
  content_status TEXT NOT NULL DEFAULT 'unknown'
                   CHECK (content_status IN (
                     'unknown','missing','fulltext','abstract-only','metadata-only')),
  retrieval_status TEXT NOT NULL DEFAULT 'not-attempted'
                   CHECK (retrieval_status IN (
                     'not-attempted','pending','retrieved','failed','paywalled')),
  is_preferred   INTEGER NOT NULL DEFAULT 0 CHECK (is_preferred IN (0,1)),
  source_url     TEXT,
  created_at     TEXT NOT NULL
);
-- At most one preferred document per work.
CREATE UNIQUE INDEX ux_document_preferred
  ON document(work_id) WHERE is_preferred = 1;
CREATE INDEX ix_document_work ON document(work_id);

-- ============================================================ identifier
-- Dedup backbone. May attach to a work and/or a specific document. DOI NOT
-- mandatory. UNIQUE(scheme,value) globally.
CREATE TABLE identifier (
  id           INTEGER PRIMARY KEY,
  work_id      INTEGER REFERENCES work(id) ON DELETE CASCADE,
  document_id  INTEGER REFERENCES document(id) ON DELETE CASCADE,
  scheme       TEXT NOT NULL
                 CHECK (scheme IN (
                   'doi','arxiv','pmid','pmcid','openalex','isbn','issn',
                   's2','url','handle','other')),
  value        TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_identifier_scheme_value ON identifier(scheme, value);
CREATE INDEX ix_identifier_work ON identifier(work_id);
CREATE INDEX ix_identifier_scheme_value ON identifier(scheme, value);

-- ============================================================ author
CREATE TABLE author (
  id            INTEGER PRIMARY KEY,
  full_name     TEXT NOT NULL,
  given_name    TEXT,
  family_name   TEXT,
  orcid         TEXT,
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_author_orcid ON author(orcid) WHERE orcid IS NOT NULL;

-- ============================================================ affiliation
CREATE TABLE affiliation (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  country       TEXT,
  ror           TEXT,
  created_at    TEXT NOT NULL
);

-- ============================================================ work_author (join)
-- Authorship. Affiliation lives on the JOIN (an author's affiliation is
-- per-work).
CREATE TABLE work_author (
  id               INTEGER PRIMARY KEY,
  work_id          INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  author_id        INTEGER NOT NULL REFERENCES author(id) ON DELETE RESTRICT,
  affiliation_id   INTEGER REFERENCES affiliation(id) ON DELETE SET NULL,
  position         INTEGER NOT NULL,
  is_corresponding INTEGER NOT NULL DEFAULT 0 CHECK (is_corresponding IN (0,1))
);
CREATE UNIQUE INDEX ux_work_author ON work_author(work_id, author_id, position);
CREATE INDEX ix_work_author_work ON work_author(work_id);
CREATE INDEX ix_work_author_author ON work_author(author_id);

-- ============================================================ citation_edge
-- Deduped directed edge citing -> cited.
CREATE TABLE citation_edge (
  id             INTEGER PRIMARY KEY,
  citing_work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  cited_work_id  INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  edge_type      TEXT NOT NULL DEFAULT 'cites'
                   CHECK (edge_type IN (
                     'cites','extends','contradicts','uses-method','reviews','related')),
  created_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_citation_edge ON citation_edge(citing_work_id, cited_work_id, edge_type);
CREATE INDEX ix_citation_edge_cited ON citation_edge(cited_work_id);
CREATE INDEX ix_citation_edge_citing ON citation_edge(citing_work_id);

-- ============================================================ citation_context
-- 1..N evidence occurrences per edge. Raw bib text preserved verbatim.
CREATE TABLE citation_context (
  id                    INTEGER PRIMARY KEY,
  edge_id               INTEGER NOT NULL REFERENCES citation_edge(id) ON DELETE CASCADE,
  raw_bib_text          TEXT,
  section               TEXT,
  role                  TEXT
                          CHECK (role IN (
                            'background','method','comparison','support',
                            'contrast','data-source','motivation','other')),
  occurrence_kind       TEXT
                          CHECK (occurrence_kind IN (
                            'inline','footnote','table','figure','bibliography')),
  resolution_confidence REAL CHECK (resolution_confidence BETWEEN 0 AND 1),
  role_confidence       REAL CHECK (role_confidence BETWEEN 0 AND 1),
  created_at            TEXT NOT NULL
);
CREATE INDEX ix_citation_context_edge ON citation_context(edge_id);

-- ============================================================ unresolved_reference
-- A cited reference we could not resolve to a work. Never a null-target edge.
CREATE TABLE unresolved_reference (
  id             INTEGER PRIMARY KEY,
  citing_work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  raw_bib_text   TEXT NOT NULL,
  guessed_doi    TEXT,
  guessed_title  TEXT,
  section        TEXT,
  status         TEXT NOT NULL DEFAULT 'unresolved'
                   CHECK (status IN ('unresolved','pending','abandoned')),
  -- Which lettered part of a composite entry this row is ('a','b',...), or NULL
  -- when it is a whole printed entry. ACS and Angewandte put several papers
  -- under one number as "(11) (a) ... (b) ..."; the parser emits the composite
  -- AND one row per part so every cited paper can be resolved on its own, and
  -- all of them share ordinal. COUNTING ROWS THEREFORE OVERCOUNTS THE PRINTED
  -- BIBLIOGRAPHY — one paper in the KE07 corpus prints 44 references and yields
  -- 83 rows — so anything answering "how many references does this paper have",
  -- and anything using that as a denominator, must exclude the parts. Anything
  -- asking "how many distinct papers are cited" wants all of them.
  part_label     TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX ix_unresolved_reference_citing ON unresolved_reference(citing_work_id);

-- ============================================================ project
CREATE TABLE project (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  slug         TEXT NOT NULL,
  description  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_project_slug ON project(slug);

-- ============================================================ project_work (join)
-- Per-project interpretation of a work. STORE-ONCE: project-specific judgement
-- NEVER lives on the global work row.
CREATE TABLE project_work (
  id                  INTEGER PRIMARY KEY,
  project_id          INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  work_id             INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  relevance           REAL CHECK (relevance BETWEEN 0 AND 1),
  expansion_priority  REAL CHECK (expansion_priority BETWEEN 0 AND 1),
  inclusion_status    TEXT NOT NULL DEFAULT 'unread'
                        CHECK (inclusion_status IN (
                          'read','unread','included','excluded','uncertain')),
  exclusion_reason    TEXT,
  -- NO LONGER READ BY ANYTHING. It said what a paper was DOING in a project
  -- (primary / foundational / method / review), but only the dev seeder ever
  -- wrote it: every paper that arrived through import or the pipeline carried
  -- NULL while the screen displayed the field as though it were maintained.
  -- The column stays because dropping it means rebuilding the table on every
  -- installed database to delete values no code consults — a real risk to the
  -- user's rows bought for nothing. Do not read it; do not write it.
  project_role        TEXT,
  notes               TEXT,
  user_overrides      TEXT,   -- JSON blob of manual overrides
  ranking_explanation TEXT,
  reviewed            INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0,1)),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_project_work ON project_work(project_id, work_id);
CREATE INDEX ix_project_work_relevance ON project_work(project_id, relevance);
CREATE INDEX ix_project_work_expansion ON project_work(project_id, expansion_priority);

-- ============================================================ analysis_run
-- One LLM/analysis run with full provenance. project_id 0 = global/general.
-- RESTRICT delete: never silently lose provenance.
CREATE TABLE analysis_run (
  id                     INTEGER PRIMARY KEY,
  work_id                INTEGER NOT NULL REFERENCES work(id) ON DELETE RESTRICT,
  project_id             INTEGER NOT NULL DEFAULT 0,  -- 0 = global sentinel
  analysis_type          TEXT NOT NULL
                           CHECK (analysis_type IN (
                             'extraction','summary','classification','ranking',
                             'measurement','relation','dossier')),
  model                  TEXT NOT NULL,
  provider               TEXT NOT NULL,
  prompt_version         TEXT NOT NULL,
  schema_version         TEXT NOT NULL,
  run_timestamp          TEXT NOT NULL,
  verifier_result        TEXT
                           CHECK (verifier_result IN (
                             'passed','failed','partial','not-run')),
  deterministic_validation INTEGER NOT NULL DEFAULT 0
                           CHECK (deterministic_validation IN (0,1)),
  supplied_project_context TEXT,   -- JSON of context supplied to the model
  user_corrections       TEXT,     -- JSON of human corrections
  superseded             INTEGER NOT NULL DEFAULT 0 CHECK (superseded IN (0,1)),
  doc_input_hash         TEXT,
  prompt_input_hash      TEXT,
  schema_input_hash      TEXT,
  dossier_input_hash     TEXT,
  created_at             TEXT NOT NULL
);
-- One CURRENT run per (work, project, type). Sentinel project_id=0 keeps global
-- runs unique too (no NULL-distinctness escape hatch).
CREATE UNIQUE INDEX ux_analysis_run_current
  ON analysis_run(work_id, project_id, analysis_type) WHERE superseded = 0;
CREATE INDEX ix_analysis_run_work ON analysis_run(work_id);
CREATE INDEX ix_analysis_run_project ON analysis_run(project_id);

-- ============================================================ evidence_span
-- Where in a document a fact/claim was grounded. RESTRICT: keep provenance.
CREATE TABLE evidence_span (
  id               INTEGER PRIMARY KEY,
  analysis_run_id  INTEGER NOT NULL REFERENCES analysis_run(id) ON DELETE RESTRICT,
  document_id      INTEGER REFERENCES document(id) ON DELETE SET NULL,
  page             INTEGER,
  section          TEXT,
  paragraph        INTEGER,
  sentence         INTEGER,
  figure           TEXT,
  "table"          TEXT,
  "row"            TEXT,
  caption          TEXT,
  quote            TEXT,
  -- Was the quote actually FOUND in the source document, or is it only what
  -- the model asserted? The pipeline stores a quote even when it cannot locate
  -- it in the segmented text, so without this flag a paraphrased or fabricated
  -- sentence renders identically to a passage genuinely read from the PDF —
  -- exactly the misattribution the provenance ontology exists to prevent.
  -- 1 ONLY when an exact substring match against the document text succeeded.
  -- Rows predating the check stay 0 = "not verified"; nothing is ever
  -- retroactively promoted to verbatim.
  verbatim         INTEGER NOT NULL DEFAULT 0 CHECK (verbatim IN (0,1)),
  created_at       TEXT NOT NULL
);
CREATE INDEX ix_evidence_span_run ON evidence_span(analysis_run_id);

-- ============================================================ fact
-- Extracted fact/claim. kind = 4-enum epistemic status.
CREATE TABLE fact (
  id               INTEGER PRIMARY KEY,
  analysis_run_id  INTEGER NOT NULL REFERENCES analysis_run(id) ON DELETE RESTRICT,
  evidence_span_id INTEGER REFERENCES evidence_span(id) ON DELETE SET NULL,
  kind             TEXT NOT NULL
                     CHECK (kind IN (
                       'directly-reported','inferred','supplied-by-project-context',
                       'uncertain-conflicting')),
  predicate        TEXT NOT NULL,
  subject          TEXT,
  object           TEXT,
  value_text       TEXT,
  confidence       REAL CHECK (confidence BETWEEN 0 AND 1),
  created_at       TEXT NOT NULL
);
CREATE INDEX ix_fact_run ON fact(analysis_run_id);

-- ============================================================ measurement
-- Quantitative measurement extension of a fact.
CREATE TABLE measurement (
  id            INTEGER PRIMARY KEY,
  fact_id       INTEGER NOT NULL REFERENCES fact(id) ON DELETE CASCADE,
  quantity      TEXT NOT NULL,   -- e.g. 'kcat', 'Tm', 'kcat/KM'
  value_num     REAL,
  value_text    TEXT,
  unit          TEXT,
  error_num     REAL,
  conditions    TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX ix_measurement_fact ON measurement(fact_id);

-- ============================================================ fold_improvement
-- Comparative improvement (e.g. Nx over WT). comparability = 4-enum.
CREATE TABLE fold_improvement (
  id               INTEGER PRIMARY KEY,
  measurement_id   INTEGER NOT NULL REFERENCES measurement(id) ON DELETE CASCADE,
  baseline_label   TEXT NOT NULL,
  improved_label   TEXT NOT NULL,
  fold             REAL,
  comparability    TEXT NOT NULL
                     CHECK (comparability IN (
                       'directly','broadly','contextual','unclear')),
  created_at       TEXT NOT NULL
);
CREATE INDEX ix_fold_improvement_measurement ON fold_improvement(measurement_id);

-- ============================================================ file_location
-- Where a document's bytes live. base_dir + relative_path. UNIQUE per root.
CREATE TABLE file_location (
  id             INTEGER PRIMARY KEY,
  document_id    INTEGER NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  base_dir_id    INTEGER NOT NULL REFERENCES base_dir(id) ON DELETE RESTRICT,
  relative_path  TEXT NOT NULL,
  hash           TEXT,
  size_bytes     INTEGER,
  role           TEXT NOT NULL DEFAULT 'canonical'
                   CHECK (role IN ('canonical','cached','alternate','backup')),
  last_modified  TEXT,
  version        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_file_location_path ON file_location(base_dir_id, relative_path);
CREATE INDEX ix_file_location_document ON file_location(document_id);

-- ============================================================ processing_job
-- Async pipeline job queue.
CREATE TABLE processing_job (
  id           INTEGER PRIMARY KEY,
  job_type     TEXT NOT NULL
                 CHECK (job_type IN (
                   'retrieval','extraction','ranking','ingest','citation-parse','export')),
  status       TEXT NOT NULL DEFAULT 'queued'
                 CHECK (status IN (
                   'queued','running','done','failed','cancelled')),
  work_id      INTEGER REFERENCES work(id) ON DELETE CASCADE,
  project_id   INTEGER REFERENCES project(id) ON DELETE CASCADE,
  payload      TEXT,   -- JSON
  error        TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  -- "I have seen this failure, stop alerting me" (v8). Lives on the row so
  -- every failed-count in the app is the SAME predicate.
  dismissed    INTEGER NOT NULL DEFAULT 0 CHECK (dismissed IN (0,1)),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX ix_processing_job_status ON processing_job(status);

-- ============================================================ saved_search
CREATE TABLE saved_search (
  id           INTEGER PRIMARY KEY,
  project_id   INTEGER REFERENCES project(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  query        TEXT NOT NULL,
  filters      TEXT,   -- JSON
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX ix_saved_search_project ON saved_search(project_id);

-- ============================================================ saved_frontier
-- Persisted graph-exploration state so a session can be resumed.
CREATE TABLE saved_frontier (
  id           INTEGER PRIMARY KEY,
  project_id   INTEGER REFERENCES project(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  graph_state  TEXT NOT NULL,   -- JSON: seeds, expanded nodes, viewport
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX ix_saved_frontier_project ON saved_frontier(project_id);
`

// ---------------------------------------------------------------- migration v2
// Adds the project-card metadata the dashboard design needs:
//   - category: a short human category line (e.g. "Enzyme engineering")
//   - tags: JSON array of module/tag pills (e.g. ["Enzyme kinetics"])
// Both nullable → existing v1 project rows migrate without backfill; the seed
// populates real values (seed-only-DB: the UI never invents these).
export const SCHEMA_V2 = /* sql */ `
ALTER TABLE project ADD COLUMN category TEXT;
ALTER TABLE project ADD COLUMN tags TEXT;
`

// v3: app-owned UI/config settings, DB-backed per the seed-only-DB rule (NO
// hardcoded domain arrays in components). Two additive tables:
//   - `setting`   : generic key/value store. Used for `selected_model_id` (the
//                   chosen analysis model). Any future single-value app setting
//                   reuses this table.
//   - `llm_model` : the list of selectable analysis models. Seeded as real rows
//                   so the renderer NEVER hardcodes a model array; the Settings
//                   surface + the read-only topbar pill both read these.
// Both are pure config (no FK into corpus data) so they migrate cleanly and the
// seed can DELETE+re-insert them idempotently.
export const SCHEMA_V3 = /* sql */ `
CREATE TABLE setting (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE llm_model (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  sub         TEXT,
  provider    TEXT,
  sort_order  INTEGER NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX ix_llm_model_sort ON llm_model(sort_order);
`

// v4: FIRST-CLASS EXTRACTION SCHEMAS. A named, versioned definition of WHAT the
// AI extracts, so the app stays agnostic to the field it is pointed at: the
// Extraction screen builds its columns from these rows, the LLM prompt is built
// from them, and no domain shape is implied by code.
//
//   - `extraction_schema` : a named, versioned, domain-tagged definition of WHAT
//                           to extract. project_id=0 is the GLOBAL sentinel (the
//                           same convention analysis_run uses — never NULL,
//                           because SQLite treats NULLs as distinct in unique
//                           indexes, which would break key uniqueness).
//   - `extraction_field`  : the ordered field list of a schema (key, label, data
//                           type, target unit, required flag, enum options,
//                           extraction hint). This is the definition the LLM
//                           prompt is built from and the Extraction tab's
//                           columns are derived from.
//   - `measurement.field_id` : links an extracted value to the field it fills,
//                           so extraction results are schema-driven rather than
//                           enzyme-hardcoded.
//
// Deliberately NOT stored: `measurement.schema_id`. It would be a transitive
// dependency (field_id -> schema_id) that SQLite cannot enforce as a composite
// FK added via ALTER TABLE, so the schema is always DERIVED by joining
// extraction_field. `measurement.quantity`/`unit`/`value_num` keep the RAW,
// as-reported values (raw-preservation rule); extraction_field.unit is a
// TARGET/display unit and never rewrites them.
//
// `export_alias` lets a schema name its own export format as a DB row instead of
// a code literal, so exportProject() carries no domain-specific arm. Seeded
// NULL: naming an interchange format is the user's to do, and shipping one
// pre-named made a single field's convention look like a built-in capability.
//
// Additive + nullable throughout: existing v3 rows migrate with no backfill.
// ALTER TABLE ADD COLUMN with a REFERENCES clause is legal under foreign_keys=ON
// precisely BECAUSE the new column defaults to NULL — do not add NOT NULL here.
// ON DELETE SET NULL (never CASCADE): deleting a schema must degrade a
// measurement to "unassigned", never destroy extracted data or its provenance.
export const SCHEMA_V4 = /* sql */ `
CREATE TABLE extraction_schema (
  id           INTEGER PRIMARY KEY,
  project_id   INTEGER NOT NULL DEFAULT 0,   -- 0 = global/built-in sentinel
  key          TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT,
  -- Content-derived (migration v8): recomputed from the fields' param_hash on
  -- every write. NOT user-editable.
  version      TEXT NOT NULL DEFAULT 'v1',
  is_builtin   INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0,1)),
  export_alias TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_extraction_schema_key ON extraction_schema(project_id, key);
CREATE UNIQUE INDEX ux_extraction_schema_alias
  ON extraction_schema(export_alias) WHERE export_alias IS NOT NULL;
CREATE INDEX ix_extraction_schema_project ON extraction_schema(project_id);

CREATE TABLE extraction_field (
  id           INTEGER PRIMARY KEY,
  schema_id    INTEGER NOT NULL REFERENCES extraction_schema(id) ON DELETE CASCADE,
  key          TEXT NOT NULL,
  label        TEXT NOT NULL,
  data_type    TEXT NOT NULL CHECK (data_type IN ('number','text','enum','boolean')),
  unit         TEXT,
  required     INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0,1)),
  enum_options TEXT,   -- JSON array; REQUIRED when data_type='enum'
  description  TEXT,   -- extraction hint handed to the model
  -- Hash of this field's meaning-bearing params (v8). sort_order is NOT covered:
  -- moving a column changes nothing about the extracted values.
  param_hash   TEXT NOT NULL DEFAULT '',
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  CHECK (data_type <> 'enum' OR enum_options IS NOT NULL)
);
CREATE UNIQUE INDEX ux_extraction_field_key ON extraction_field(schema_id, key);
CREATE INDEX ix_extraction_field_schema ON extraction_field(schema_id, sort_order, id);

ALTER TABLE measurement ADD COLUMN field_id INTEGER
  REFERENCES extraction_field(id) ON DELETE SET NULL;
CREATE INDEX ix_measurement_field ON measurement(field_id);
`

// v5: SCHEMAS BECOME GLOBAL; PROJECTS *ATTACH* THE ONES THEY USE.
//
// v4 modelled a schema as project-owned with 0 as a "global built-in" escape
// hatch. In practice a schema is a reusable DEFINITION (what a kinetics paper
// reports doesn't change per project), so the user-facing concept moved to the
// app level. Two consequences are encoded here:
//
//   1. `extraction_schema.key` is now unique GLOBALLY, not per project. The
//      column `project_id` is deliberately KEPT (constant 0) rather than
//      dropped: dropping it requires a full table rebuild, and `extraction_field`
//      (and transitively `measurement.field_id`) hangs off this table — a
//      rebuild would have to re-point live FKs for zero functional gain. It is
//      simply gone from the API surface (`ExtractionSchemaDTO` no longer carries
//      it) and `createExtractionSchema` writes the literal 0, so non-zero values
//      cannot be reintroduced.
//
//   2. `project_schema` records WHICH schemas a project applies in its Extraction
//      view. This is the persistence for the add/remove control on that screen —
//      per the seed-only-DB rule the selection may not live in component state
//      or localStorage. Detaching is NOT deleting: the schema definition and
//      every measurement already extracted with it survive untouched (the
//      Extraction screen keeps rendering those rows in their own section).
//
// STEP ORDER MATTERS, which is why this migration is split in two around a
// JS-driven de-duplication step (see migrate.ts). A v4 DB may legitimately hold
// two schemas with the same key under different projects; creating the global
// unique index first — or flattening project_id first, while the old composite
// index is still live — would raise SQLITE_CONSTRAINT inside the migration
// transaction and leave the app permanently unable to open its own DB.
//
// So: PRE drops the old composite index → de-dup renames colliding keys → POST
// flattens project_id, creates the global unique index and adds project_schema.
export const SCHEMA_V5_PRE = /* sql */ `
DROP INDEX ux_extraction_schema_key;
`

export const SCHEMA_V5_POST = /* sql */ `
UPDATE extraction_schema SET project_id = 0 WHERE project_id <> 0;

CREATE UNIQUE INDEX ux_extraction_schema_key ON extraction_schema(key);
DROP INDEX ix_extraction_schema_project;

CREATE TABLE project_schema (
  project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  schema_id  INTEGER NOT NULL REFERENCES extraction_schema(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, schema_id)
);
CREATE INDEX ix_project_schema_schema ON project_schema(schema_id);
`

// ---------------------------------------------------------------- migration v6
// v6: HUMAN VERDICTS on extracted facts (`fact_verdict`).
//
// Until now the Review screen could show a reviewer everything needed to judge
// an escalated extraction but had NO way to record the judgement — the only
// persisted resolution was re-running the extraction, which is not a verdict at
// all. This table is that missing write surface.
//
// WHY A SEPARATE TABLE rather than `analysis_run.user_corrections`:
//   - A verdict is per-FACT, not per-run: one run yields many facts and a
//     reviewer accepts some and corrects others.
//   - A verdict is per-PROJECT: the SAME global (project_id = 0) fact is seen by
//     every project, and project A accepting it must not resolve it for B.
//   - `analysis_run` is PROVENANCE and provenance is immutable (§22). Writing
//     the human's opinion into the run row would make the AI's own record
//     mutable. Nothing in this feature ever UPDATEs `fact`, `evidence_span` or
//     `analysis_run`; the AI's `value_text` stays exactly as extracted and the
//     human's `corrected_value` is stored, and rendered, BESIDE it.
//
// APPEND-ONLY. The current verdict for a (fact, project) is the row with the
// highest id; every earlier row is the audit trail. Retraction is not a DELETE
// but another append with verdict = 'unresolved', so an undo is itself history.
//
// `project_id` carries a real FK and a `> 0` CHECK: unlike `analysis_run`, a
// verdict is NEVER global — someone always reviewed it FOR a project. (The
// project_id = 0 sentinel has no `project` row, so an FK alone would surface as
// an opaque SQLITE_CONSTRAINT; the CHECK makes the intent explicit.)
//
// `fact_id` is ON DELETE RESTRICT, matching `analysis_run`'s own RESTRICT: the
// human audit trail must not be erasable by deleting the thing it annotates.
//
// SURVIVING RE-RUNS. A re-run supersedes the old analysis_run and inserts NEW
// fact rows with NEW ids, so a verdict bound to a fact id alone would silently
// vanish from the reviewer's view. `fact_fingerprint` (a stable digest of
// work + analysis_type + predicate + subject + normalized value) lets the queue
// find a verdict recorded on a PREVIOUS run of the same claim. Such a match is
// reported as STALE and never auto-resolves the item: the UI says the claim was
// reviewed on an earlier run and asks for confirmation. `analysis_run_id`
// snapshots which run was reviewed so that message can name it.
export const SCHEMA_V6 = /* sql */ `
CREATE TABLE fact_verdict (
  id               INTEGER PRIMARY KEY,
  fact_id          INTEGER NOT NULL REFERENCES fact(id) ON DELETE RESTRICT,
  project_id       INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE
                     CHECK (project_id > 0),
  analysis_run_id  INTEGER NOT NULL REFERENCES analysis_run(id) ON DELETE RESTRICT,
  fact_fingerprint TEXT NOT NULL,
  verdict          TEXT NOT NULL
                     CHECK (verdict IN ('accepted','corrected','rejected','unresolved')),
  corrected_value  TEXT
                     CHECK ((verdict = 'corrected')
                            = (corrected_value IS NOT NULL AND trim(corrected_value) <> '')),
  note             TEXT,
  reviewer         TEXT NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX ix_fact_verdict_current ON fact_verdict(fact_id, project_id, id);
CREATE INDEX ix_fact_verdict_fingerprint ON fact_verdict(fact_fingerprint, project_id, id);
`

// ---------------------------------------------------------------- v7
// Mark whether an evidence quote was VERIFIED against the source document.
//
// The pipeline persists whatever quote the model returned even when it cannot
// find that text in the segmented document, so a paraphrase (or an outright
// fabrication) was stored and rendered exactly like a passage genuinely read
// from the PDF. The dossier now shows these as <blockquote>s, which makes the
// misattribution user-visible: the app was asserting "the paper says this"
// without having checked.
//
// Additive: existing rows default to 0 = NOT verified. That is the honest value
// — those quotes were never checked, and back-filling them by re-matching now
// would be guessing about a run that already happened.
export const SCHEMA_V7 = /* sql */ `
ALTER TABLE evidence_span
  ADD COLUMN verbatim INTEGER NOT NULL DEFAULT 0 CHECK (verbatim IN (0,1));
`

// ---------------------------------------------------------------- migration v8
// Schema identity becomes CONTENT-DERIVED, and `domain` is dropped.
//
// WHY. `extraction_schema.version` was a free-text string the user typed ('v1.2')
// and `domain` a free-text tag ('enzyme kinetics'). Both were pure ceremony: the
// version never changed unless someone remembered to bump it, so provenance
// could record 'v1.2' for two structurally different schemas, and the domain tag
// duplicated what the name already said.
//
// Instead each FIELD carries a `param_hash` over its own meaning-bearing
// parameters (key, label, data_type, unit, required, enum_options, description),
// and the schema's identity is the ordered composition of them. This makes
// versioning INCREMENTAL: editing one field changes exactly one field hash, so a
// run stamped against the untouched fields is still provably current. Under the
// old scheme any edit bumped the whole schema and invalidated every run against
// it, including runs that touched no changed field.
//
// `version` stays in the table (provenance rows reference the string that was
// current when they ran, and rewriting history would be a lie) but is no longer
// user-editable — it is recomputed from the hashes on every write.
//
// v8 also moves job DISMISSAL into the DB (`processing_job.dismissed`).
//
// It was renderer state, so "how many retrievals failed" had two answers: the
// Papers screen honoured dismissals, the project card's SQL did not, and the
// same corpus reported 1 and 2 at the same time. A dismissal is a judgement
// about a row, so it belongs ON the row — and then EVERY count is one predicate
// (`status IN ('failed','error') AND dismissed = 0`) evaluated in one place.
export const SCHEMA_V8 = /* sql */ `
ALTER TABLE extraction_field ADD COLUMN param_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE extraction_schema DROP COLUMN domain;
ALTER TABLE processing_job
  ADD COLUMN dismissed INTEGER NOT NULL DEFAULT 0 CHECK (dismissed IN (0,1));
`

// ---------------------------------------------------------------- migration v9
// `analysis_check` — the ACTUAL results of the deterministic checks (§12).
//
// WHY. `analysis_run.deterministic_validation` was written as "the document had
// paragraphs", and the UI rendered that single bit as "deterministic validation
// passed". A reviewer relaxing on that guarantee was relaxing on nothing: no
// check had run. A boolean also cannot carry WHICH check passed, so even a real
// check engine would have been unreportable.
//
// This table is the missing detail: one row per check per run, carrying the
// machine key, the verdict, and the reason in words. `deterministic_validation`
// stays on the run as the derived conjunction — the one bit callers already read
// — but it is now DERIVED from these rows instead of standing in for them.
//
// APPEND-ONLY, PER-RUN, IMMUTABLE, like every other provenance row. A re-run
// supersedes the analysis_run and writes a fresh set; the old rows stay attached
// to the old run so the history of what was checked is not rewritten.
//
// NOTHING HERE MODIFIES THE AI'S OUTPUT. `fact_id` / `measurement_id` say which
// record a verdict is ABOUT; the record itself is never corrected by a check.
// Both are nullable because run-level checks (e.g. a required field that was
// never extracted) have no row to point at, and ON DELETE SET NULL so removing
// a record cannot erase the fact that it was checked.
export const SCHEMA_V9 = /* sql */ `
CREATE TABLE analysis_check (
  id              INTEGER PRIMARY KEY,
  analysis_run_id INTEGER NOT NULL REFERENCES analysis_run(id) ON DELETE RESTRICT,
  check_key       TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('passed','failed','skipped')),
  reason          TEXT NOT NULL,
  fact_id         INTEGER REFERENCES fact(id) ON DELETE SET NULL,
  measurement_id  INTEGER REFERENCES measurement(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX ix_analysis_check_run ON analysis_check(analysis_run_id, id);
CREATE INDEX ix_analysis_check_fact ON analysis_check(fact_id);
`

// ---------------------------------------------------------------- migration v10
// `project_work.is_reference` — the user's REFERENCE-PAPER mark (§8), on its own
// column instead of sharing `project_role`.
//
// WHY A NEW COLUMN. `project_role` at the time carried a DIFFERENT, orthogonal
// meaning: the paper's semantic role in the corpus (foundational / method /
// review / primary), which the graph read to categorise nodes. Storing
// "the user trusts this as a reference" in the same cell means marking a
// reference DESTROYS the role, and unmarking cannot restore it. The two facts
// are independent — a review paper can be a trusted reference — so they get
// independent storage.
//
// A 0/1 flag, not a role string: the dossier asks one question of this column
// ("is this work part of the reference set?"), and an enum of one value invites
// a taxonomy nobody needs. Defaults to 0, so an upgraded DB starts with an empty
// reference set — the honest state, since no user has marked anything yet.
export const SCHEMA_V10 = /* sql */ `
ALTER TABLE project_work
  ADD COLUMN is_reference INTEGER NOT NULL DEFAULT 0 CHECK (is_reference IN (0,1));
CREATE INDEX ix_project_work_reference ON project_work(project_id, is_reference);
`

// ---------------------------------------------------------------- migration v11
// PARSED CITATIONS. Edges may now be DERIVED by the reference parser rather than
// asserted by a human, and the two must never be confused.
//
// `citation_edge.source` records WHO created the edge:
//   'asserted' — a human/curated claim (the hand-authored corpus edges)
//   'parsed'   — the deterministic reference parser resolved a bibliography
//                entry to a work
// with `match_confidence` and `match_method` carrying the parser's own account
// of HOW sure it is and WHY. An asserted edge leaves those null: fabricating a
// confidence of 1.0 for a human claim would make the two indistinguishable in
// exactly the query that needs to tell them apart. Defaulting the column to
// 'asserted' is the honest classification for rows that predate the parser.
//
// `unresolved_reference` gains the parsed fields the References DAG needs to
// draw a reference that is NOT yet a work in the corpus: a year (so the node can
// be placed on the time axis), the ordinal (so entries render in bibliography
// order) and the citing document's parse provenance.
//
// `work_citation_parse` is the PRE-BAKED parse record — one row per work whose
// PDF has been parsed. It stores the inputs the parse depended on, which is what
// makes staleness detectable: if the document changed (`doc_sha`) or the parser
// itself changed (`parser_version`), the stored edges are known-stale without
// re-reading the PDF.
export const SCHEMA_V11 = /* sql */ `
ALTER TABLE citation_edge
  ADD COLUMN source TEXT NOT NULL DEFAULT 'asserted'
    CHECK (source IN ('asserted','parsed'));
ALTER TABLE citation_edge ADD COLUMN match_confidence REAL
  CHECK (match_confidence IS NULL OR match_confidence BETWEEN 0 AND 1);
ALTER TABLE citation_edge ADD COLUMN match_method TEXT
  CHECK (match_method IS NULL OR match_method IN ('doi','scored'));
CREATE INDEX ix_citation_edge_source ON citation_edge(source);

ALTER TABLE unresolved_reference ADD COLUMN guessed_year INTEGER;
ALTER TABLE unresolved_reference ADD COLUMN guessed_authors TEXT;
ALTER TABLE unresolved_reference ADD COLUMN guessed_venue TEXT;
ALTER TABLE unresolved_reference ADD COLUMN ordinal INTEGER;

CREATE TABLE work_citation_parse (
  work_id         INTEGER PRIMARY KEY REFERENCES work(id) ON DELETE CASCADE,
  document_id     INTEGER REFERENCES document(id) ON DELETE SET NULL,
  parser_version  TEXT NOT NULL,
  doc_sha         TEXT,
  corpus_size     INTEGER NOT NULL,
  reference_count INTEGER NOT NULL,
  matched_count   INTEGER NOT NULL,
  section_strategy TEXT NOT NULL,
  entry_style     TEXT NOT NULL,
  no_text_layer   INTEGER NOT NULL DEFAULT 0 CHECK (no_text_layer IN (0,1)),
  parsed_at       TEXT NOT NULL
);
`

// ---------------------------------------------------------------- migration v12
// RETRIEVAL OF CITED-BUT-ABSENT PAPERS. The References tree lets the user pick
// unresolved references and ask the app to go and get them; that attempt has to
// survive a navigation and a restart, so it is stored rather than held in React.
//
// A SEPARATE COLUMN, not a widened `status`. `unresolved_reference.status`
// answers "has this bibliography entry been turned into a work yet?"
// ('unresolved' / 'pending' / 'abandoned'). Whether a RETRIEVAL was attempted,
// and how it went, is a different question with a different lifetime — a
// retrieval can fail and be retried while the entry stays unresolved throughout.
// Folding both into one column would make "failed" ambiguous (failed to
// retrieve, or abandoned by the user?) and would force a table rebuild to widen
// a CHECK. Two columns keep each enum meaning exactly one thing, and this step
// stays purely additive.
//
// `retrieval_job_id` is the link to the `processing_job` the retrieval spawned:
// it is what makes "already being retrieved" a FACT read from the queue rather
// than a flag that can drift. `retrieval_work_id` is the work the ingest created,
// so a finished retrieval points at what it produced. `retrieval_error` carries
// the job's own message — an offline failure is reported, never hidden.
export const SCHEMA_V12 = /* sql */ `
ALTER TABLE unresolved_reference ADD COLUMN retrieval_status TEXT NOT NULL DEFAULT 'none'
  CHECK (retrieval_status IN ('none','retrieving','failed','retrieved'));
ALTER TABLE unresolved_reference ADD COLUMN retrieval_job_id INTEGER
  REFERENCES processing_job(id) ON DELETE SET NULL;
ALTER TABLE unresolved_reference ADD COLUMN retrieval_work_id INTEGER
  REFERENCES work(id) ON DELETE SET NULL;
ALTER TABLE unresolved_reference ADD COLUMN retrieval_error TEXT;
ALTER TABLE unresolved_reference ADD COLUMN retrieval_started_at TEXT;
CREATE INDEX ix_unresolved_reference_job ON unresolved_reference(retrieval_job_id);
`

// ============================================================ v14 — the stage pipeline
//
// A "pipeline" is not an entity: it is the set of `processing_job` rows sharing
// a `pipeline_id`. A STAGE is a TypeScript module registered in exactly one
// array; `stage_run` is its EXECUTION record (what ran, when, against which
// inputs) while `analysis_run` stays the PROVENANCE record for LLM output. The
// two are linked by `stage_run.analysis_run_id` and neither duplicates the
// other: the one-current-run invariant, the verifier result and `user_corrections`
// all keep living on `analysis_run`.
//
// `stage_run` is created BEFORE the `processing_job` rebuild because the rebuilt
// table's `stage_run_id` FK names it.
//
// Sentinels, not NULLs, for work_id/document_id/project_id/schema_id: SQLite
// treats NULLs as DISTINCT in a unique index, so a NULL project_id would let two
// "global" runs of the same stage both hold the current slot and silently break
// the one-current-run guarantee. This is the same reason `analysis_run` already
// uses project_id = 0.
export const SCHEMA_V14_STAGE_RUN = /* sql */ `
CREATE TABLE stage_run (
  id            INTEGER PRIMARY KEY,
  stage         TEXT NOT NULL,
  stage_version TEXT NOT NULL,
  work_id       INTEGER NOT NULL DEFAULT 0,
  document_id   INTEGER NOT NULL DEFAULT 0,
  project_id    INTEGER NOT NULL DEFAULT 0,
  schema_id     INTEGER NOT NULL DEFAULT 0,
  fanout_key    TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL
                CHECK (status IN ('running','succeeded','empty','skipped',
                                  'refused','failed')),
  lease_epoch   INTEGER NOT NULL DEFAULT 0,
  outcome_note  TEXT,
  error         TEXT,
  -- sha256 over: stage_version | every upstream stage_run's fingerprint |
  -- stage.fingerprint() | model | prompt_version | schema_version.
  -- An ATTRIBUTE checked inside the key, never part of the key: keying on it
  -- would keep one live row per fingerprint with no answer to "which is current".
  input_fingerprint TEXT NOT NULL,
  model         TEXT,
  prompt_version TEXT,
  schema_version TEXT,
  analysis_run_id INTEGER REFERENCES analysis_run(id) ON DELETE SET NULL,
  result        TEXT,
  superseded    INTEGER NOT NULL DEFAULT 0 CHECK (superseded IN (0,1)),
  superseded_by INTEGER REFERENCES stage_run(id) ON DELETE SET NULL,
  duration_ms   INTEGER,
  created_at    TEXT NOT NULL,
  finished_at   TEXT
);
CREATE UNIQUE INDEX ux_stage_run_current
  ON stage_run(stage, work_id, document_id, project_id, schema_id, fanout_key)
  WHERE superseded = 0;
CREATE INDEX ix_stage_run_work ON stage_run(work_id, stage);
CREATE INDEX ix_stage_run_fp   ON stage_run(input_fingerprint);

-- The generic artifact store. A stage whose output is only ever read back by
-- LATER stages (via ctx.input) writes here and needs no migration at all; only
-- output the RENDERER must query with its own SQL earns a real table. This is
-- what keeps "a new stage is one file plus one line" true for most stages.
CREATE TABLE stage_artifact (
  stage_run_id INTEGER NOT NULL REFERENCES stage_run(id) ON DELETE CASCADE,
  key          TEXT NOT NULL,
  json         TEXT NOT NULL,
  PRIMARY KEY (stage_run_id, key)
);
`

// The rebuilt `processing_job`. Three things force a full table rebuild rather
// than ALTER: the `job_type` CHECK must go (the TS stage registry is the enum
// now, and a DB migration per new stage would break the one-file rule), the
// `status` CHECK must gain 'blocked' and 'review', and `project_id` must become
// a NOT NULL sentinel with no FK (see above).
export const SCHEMA_V14_JOB_TABLE = /* sql */ `
CREATE TABLE processing_job_new (
  id           INTEGER PRIMARY KEY,
  job_type     TEXT NOT NULL,
  stage        TEXT,
  status       TEXT NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued','blocked','running','done','failed',
                                 'cancelled','review')),
  outcome      TEXT CHECK (outcome IS NULL OR
                           outcome IN ('succeeded','empty','skipped','refused')),
  outcome_note TEXT,
  work_id      INTEGER REFERENCES work(id) ON DELETE CASCADE,
  document_id  INTEGER REFERENCES document(id) ON DELETE CASCADE,
  project_id   INTEGER NOT NULL DEFAULT 0,
  schema_id    INTEGER NOT NULL DEFAULT 0,
  fanout_key   TEXT NOT NULL DEFAULT '',
  pipeline_id  TEXT,
  job_key      TEXT,
  stage_run_id INTEGER REFERENCES stage_run(id) ON DELETE SET NULL,
  payload      TEXT,
  error        TEXT,
  error_code   TEXT,
  error_kind   TEXT CHECK (error_kind IS NULL OR
                           error_kind IN ('transient','permanent','cancelled',
                                          'upstream','needs-user-action')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  lease_epoch  INTEGER NOT NULL DEFAULT 0,
  lease_owner  TEXT,
  lease_expires_at TEXT,
  progress_pct INTEGER,
  progress_note TEXT,
  priority     INTEGER NOT NULL DEFAULT 100,
  run_after    TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1)),
  dismissed    INTEGER NOT NULL DEFAULT 0 CHECK (dismissed IN (0,1)),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  started_at   TEXT,
  finished_at  TEXT
);
`

// Indexes are recreated AFTER the rename — creating them first would name the
// temporary table. `ux_processing_job_live` is the same partial-unique trick as
// `ux_analysis_run_current`: at most one LIVE job per logical key, so re-planning
// a pipeline is idempotent, while terminal rows are exempt so a re-run is legal.
//
// 'review' IS in the terminal exclusion list. It is a terminal status that
// satisfies dependents exactly as 'done' does, and leaving it live would make a
// reviewed job occupy its key forever — `forceRerun` would then throw on the
// unique index, which is the one thing `forceRerun` exists to make possible.
export const SCHEMA_V14_JOB_INDEXES = /* sql */ `
CREATE INDEX ix_processing_job_status  ON processing_job(status);
CREATE INDEX ix_processing_job_ready   ON processing_job(status, run_after, priority, id);
CREATE INDEX ix_processing_job_pipe    ON processing_job(pipeline_id);
CREATE INDEX ix_processing_job_project ON processing_job(project_id, updated_at DESC);
CREATE UNIQUE INDEX ux_processing_job_live ON processing_job(job_key)
  WHERE job_key IS NOT NULL
    AND status NOT IN ('done','failed','cancelled','review');

CREATE TABLE job_dependency (
  job_id            INTEGER NOT NULL REFERENCES processing_job(id) ON DELETE CASCADE,
  depends_on_job_id INTEGER NOT NULL REFERENCES processing_job(id) ON DELETE CASCADE,
  PRIMARY KEY (job_id, depends_on_job_id)
);
CREATE INDEX ix_job_dependency_dep ON job_dependency(depends_on_job_id);
`

// v15: `analysis_run.schema_id`.
//
// The minimal change that lets extraction fan out per attached schema WITHOUT
// inventing new `analysis_type` values — that enum stays a closed 7-value CHECK.
// Before this, N schemas over one (work, project) all collided on
// `ux_analysis_run_current`, so extracting under a second schema silently
// retired the first one's results.
//
// Existing rows take `schema_id = 0`, so the index is behaviourally identical
// for them and nothing is superseded by the migration itself.
export const SCHEMA_V15 = /* sql */ `
ALTER TABLE analysis_run ADD COLUMN schema_id INTEGER NOT NULL DEFAULT 0;
DROP INDEX ux_analysis_run_current;
CREATE UNIQUE INDEX ux_analysis_run_current
  ON analysis_run(work_id, project_id, analysis_type, schema_id) WHERE superseded = 0;
`

// v16: the paragraph inventory the `segment` stage writes.
//
// It earns a real table rather than living as a `stage_artifact` because the
// RENDERER queries it (the Paper screen's outline and every anchor lookup), and
// the artifact store is deliberately reachable only from a later stage.
//
// `para_id` is POSITIONAL, so a re-segment renumbers it. That is why every row
// carries `stage_run_id ON DELETE CASCADE` and why `deleteRunOutput` deletes
// these rows explicitly: the supersede cascade UPDATEs `stage_run` rather than
// deleting it, and an UPDATE fires no cascade, so without the explicit delete a
// stale inventory would survive and stored anchors would silently name the
// wrong paragraph.
export const SCHEMA_V16 = /* sql */ `
CREATE TABLE document_paragraph (
  id            INTEGER PRIMARY KEY,
  stage_run_id  INTEGER NOT NULL REFERENCES stage_run(id) ON DELETE CASCADE,
  document_id   INTEGER NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  para_id       TEXT NOT NULL,
  idx           INTEGER NOT NULL,
  char_start    INTEGER NOT NULL,
  char_end      INTEGER NOT NULL,
  page          INTEGER,
  kind          TEXT NOT NULL
                  CHECK (kind IN ('prose','heading','list','caption','reference','table_row')),
  section       TEXT NOT NULL
                  CHECK (section IN (
                    'title','abstract','introduction','background','related-work',
                    'methods','results','discussion','conclusion','acknowledgements',
                    'references','supplementary','other')),
  text          TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
-- Per RUN, not per document: after a transformer there are legitimately two
-- inventories for one document, and a document-keyed unique index would reject
-- the second one rather than let the cascade retire the first.
CREATE UNIQUE INDEX ux_document_paragraph_run ON document_paragraph(stage_run_id, para_id);
CREATE INDEX ix_document_paragraph_doc ON document_paragraph(document_id, idx);
CREATE INDEX ix_document_paragraph_offset ON document_paragraph(document_id, char_start);
`

// v17: the `citation_context` rebuild.
//
// Three things force a rebuild rather than ALTERs: `edge_id` must become
// NULLABLE, a table-level XOR CHECK must be added, and the `role` CHECK must
// gain `review`. SQLite can do none of those in place.
//
// The XOR is the load-bearing part. ~840 unresolved references are first-class
// in this app — they are surfaced in the Paper screen and are the retrieval
// queue's input — so their in-text evidence must be storable; and a context row
// with no target at all must be UNREPRESENTABLE, which is what `<>` between two
// IS NULL tests gives.
export const SCHEMA_V17_TABLE = /* sql */ `
CREATE TABLE citation_context_new (
  id                      INTEGER PRIMARY KEY,

  -- Exactly one of these two is set.
  edge_id                 INTEGER REFERENCES citation_edge(id)        ON DELETE CASCADE,
  unresolved_reference_id INTEGER REFERENCES unresolved_reference(id) ON DELETE CASCADE,

  stage_run_id            INTEGER REFERENCES stage_run(id) ON DELETE CASCADE,
  document_id             INTEGER REFERENCES document(id)  ON DELETE CASCADE,
  citing_work_id          INTEGER REFERENCES work(id)      ON DELETE CASCADE,

  -- The callout site, in the canonical document text offset space. Half-open
  -- [start, end), matching the exact-slice convention used everywhere else, so
  -- the Paper screen can highlight the marker rather than guess its width.
  ordinal                 INTEGER,
  callout_offset          INTEGER,
  callout_end             INTEGER,

  para_id                 TEXT,
  page                    INTEGER,
  -- Captured TEXT, deliberately carrying NO offsets, so nobody mistakes it for
  -- a second anchor space. Sentence-level anchors are a later refinement.
  sentence                TEXT,
  section                 TEXT,

  raw_bib_text            TEXT,

  role                    TEXT CHECK (role IS NULL OR role IN (
                            'background','method','comparison','support',
                            'contrast','data-source','motivation','review','other')),
  role_source             TEXT CHECK (role_source IS NULL OR role_source IN ('rule','llm')),
  role_cue                TEXT,
  role_confidence         REAL CHECK (role_confidence IS NULL OR role_confidence BETWEEN 0 AND 1),

  occurrence_kind         TEXT CHECK (occurrence_kind IS NULL OR occurrence_kind IN (
                            'inline','footnote','table','figure','bibliography')),
  resolution_confidence   REAL CHECK (resolution_confidence IS NULL OR resolution_confidence BETWEEN 0 AND 1),

  created_at              TEXT NOT NULL,

  CHECK ((edge_id IS NULL) <> (unresolved_reference_id IS NULL)),

  -- Provenance completeness: a role with no stated origin is exactly what
  -- role_source exists to prevent, so the database refuses it. A rule either
  -- matched or it did not — there is no probability to report, and fabricating
  -- one would let a query rank a regex above a model's calibrated output.
  CHECK (role IS NULL OR role_source IS NOT NULL),
  CHECK (role_source IS NULL OR role_source <> 'rule'
         OR (role_cue IS NOT NULL AND role_confidence IS NULL)),
  CHECK (role_source IS NULL OR role_source <> 'llm' OR role_cue IS NULL)
);
`

// Created AFTER the rename — creating them first would name the temporary table.
//
// `ux_citation_context_site` keys on the SITE, not on the edge, and that is not
// a stylistic choice: a bibliography can hold two entries resolving to the SAME
// work, which share one `citation_edge` row because of `ux_citation_edge`. An
// edge-keyed index would reject the second entry's contexts outright.
//
// `AND ordinal IS NOT NULL` is likewise not cosmetic. SQLite treats NULLs as
// DISTINCT in a unique index, so without it two rows at (doc, offset, NULL)
// would both insert and the duplicate protection would be a fiction.
export const SCHEMA_V17_INDEXES = /* sql */ `
CREATE INDEX ix_citation_context_edge ON citation_context(edge_id);
CREATE INDEX ix_citation_context_unresolved
  ON citation_context(unresolved_reference_id) WHERE unresolved_reference_id IS NOT NULL;
CREATE INDEX ix_citation_context_run  ON citation_context(stage_run_id);
CREATE INDEX ix_citation_context_work ON citation_context(citing_work_id);
CREATE UNIQUE INDEX ux_citation_context_site
  ON citation_context(document_id, callout_offset, ordinal)
  WHERE document_id IS NOT NULL AND callout_offset IS NOT NULL
    AND ordinal IS NOT NULL;
`

// ============================================================ v18 — OCR provenance + the embedding-space registry
//
// TWO changes land together because they are one claim: what a document's text
// IS, and what was embedded from it. An embedding built from OCR'd characters
// is not the same evidence as one built from a publisher's text layer, and a
// reader must be able to tell without reading the pipeline's source.

// v18a — how a document's text was obtained.
//
// SEPARATE from `content_status`, deliberately. That column is a closed 5-value
// enum answering "how much of the paper do we have" (fulltext / abstract-only /
// metadata-only). OCR is orthogonal: an OCR'd scan IS the full text — at 89 %
// character confidence. Folding it into that enum would make "we only have the
// abstract" and "we have all of it, imperfectly read" indistinguishable, and
// both are things a user acts on differently.
//
// `text_source_run_id` is what makes the claim RETRACTABLE. Without it these
// columns are the one piece of OCR output `deleteRunOutput` cannot reach, so a
// superseded or cancelled OCR run would leave the document permanently badged
// with a confidence nothing currently stands behind. With it, retiring a run
// clears exactly the row that run wrote and no other.
export const SCHEMA_V18_TEXT_SOURCE = /* sql */ `
ALTER TABLE document ADD COLUMN text_source TEXT NOT NULL DEFAULT 'unknown'
  CHECK (text_source IN ('unknown','pdf-text-layer','ocr'));
ALTER TABLE document ADD COLUMN text_confidence REAL;
ALTER TABLE document ADD COLUMN text_source_run_id INTEGER;
-- Indexed because deleteRunOutput clears this column BY RUN, and that runs on
-- every supersede, cancel and lease reclaim — inside the scheduler's write
-- transaction. Unindexed it is a full document scan per retired run, which
-- makes a cascade over the 3000-work stress corpus quadratic.
CREATE INDEX ix_document_text_source_run
  ON document(text_source_run_id) WHERE text_source_run_id IS NOT NULL;
`

// v18b — the embedding-space registry.
//
// `vec0` fixes dimensionality PER TABLE, so the identity of a vector space
// cannot live in a column — it has to live in the table. Hence a registry row
// plus one `chunk_vec_<id>` virtual table per space, created lazily by the
// `embed` stage with `dims` read from the row rather than written as a literal.
//
// `config_hash` is the single derived identity over every field that changes a
// vector: model, revision, file, dims, quantisation, pooling, normalisation,
// both prefixes, chunker, max sequence length, and the text-extraction version.
// It is UNIQUE, so two rows can never claim the same space, and it is what
// `embed.fingerprint()` returns — which is how swapping the packaged model
// supersedes every embed run through the ORDINARY cascade instead of a special
// code path, and why the re-embed is resumable per (work, document).
//
// A cosine between two spaces is a number, not an error, which is exactly why
// the space is named on every chunk rather than assumed.
export const SCHEMA_V18_EMBEDDING = /* sql */ `
CREATE TABLE embedding_space (
  id                      INTEGER PRIMARY KEY,
  model_id                TEXT NOT NULL,
  model_revision          TEXT NOT NULL,
  model_file              TEXT NOT NULL,
  dims                    INTEGER NOT NULL,
  quantization            TEXT NOT NULL,
  stored_quantization     TEXT NOT NULL,
  pooling                 TEXT NOT NULL,
  normalized              INTEGER NOT NULL CHECK (normalized IN (0,1)),
  query_prefix            TEXT NOT NULL DEFAULT '',
  doc_prefix              TEXT NOT NULL DEFAULT '',
  chunking_version        TEXT NOT NULL,
  max_seq_length          INTEGER NOT NULL,
  text_extraction_version TEXT NOT NULL,
  runtime                 TEXT NOT NULL,
  config_hash             TEXT NOT NULL UNIQUE,
  vec_table               TEXT NOT NULL,
  status                  TEXT NOT NULL
                            CHECK (status IN ('active','retired','comparison')),
  created_at              TEXT NOT NULL
);
-- At most ONE active space, the same partial-unique trick as
-- ux_analysis_run_current. 'comparison' is deliberately exempt: that is how a
-- second model stays queryable for an A/B without ever answering a real search.
CREATE UNIQUE INDEX ux_embedding_space_active
  ON embedding_space(status) WHERE status = 'active';

-- AUTOINCREMENT, and it is load-bearing rather than tidy. vec0 is a VIRTUAL
-- table: it can carry no foreign key and no ON DELETE CASCADE, so a vector can
-- outlive its chunk on any path that deletes chunks without going through
-- deleteRunOutput — and three exist (the startup orphan sweep, deleteWork,
-- and the retrieval settle), each deleting a work or document and cascading.
-- Without AUTOINCREMENT SQLite reissues max(rowid)+1, so a LATER chunk would
-- inherit the dead one's id and, with it, its vector: a k-NN that returns a
-- confidently wrong neighbour instead of an error. AUTOINCREMENT makes the id
-- monotonic, so a stale vector can only ever point at nothing, which
-- sweepVectorOrphans() then removes.
CREATE TABLE chunk (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  stage_run_id   INTEGER NOT NULL REFERENCES stage_run(id) ON DELETE CASCADE,
  space_id       INTEGER NOT NULL REFERENCES embedding_space(id) ON DELETE CASCADE,
  document_id    INTEGER NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  work_id        INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  idx            INTEGER NOT NULL,
  -- The paragraphs this chunk was packed from, in order, as JSON. Positional
  -- para ids, so a re-segment invalidates them — which the fingerprint chain
  -- already guarantees, because a new inventory supersedes this run too.
  para_ids       TEXT NOT NULL,
  char_start     INTEGER NOT NULL,
  char_end       INTEGER NOT NULL,
  page           INTEGER,
  section        TEXT NOT NULL,
  text           TEXT NOT NULL,
  token_estimate INTEGER NOT NULL,
  -- The model truncates past max_seq_length. Recording it is the difference
  -- between "this chunk is embedded" and "the first 512 tokens of it are".
  truncated      INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0,1)),
  -- Too little text to carry meaning: a three-word paragraph embeds to a vector
  -- dominated by the model's priors rather than by the paper, so it surfaces as
  -- a confident neighbour for almost anything. The vector is stored and
  -- searchable, and it is FLAGGED, because presenting it as equal to a full
  -- paragraph is the fabrication this project forbids — while dropping it would
  -- silently lose text that may be the only place a number appears.
  --
  -- OCR confidence is a property of the DOCUMENT (document.text_confidence),
  -- not of a chunk, and is not folded in here.
  low_confidence INTEGER NOT NULL DEFAULT 0 CHECK (low_confidence IN (0,1)),
  input_hash     TEXT NOT NULL,
  config_hash    TEXT NOT NULL,
  -- THE VECTOR ITSELF, Float32 little-endian, exactly space.dims values.
  --
  -- The vec0 table is a derived INDEX over this column, not the store, and
  -- that ordering buys three things. A narrow scope is scored EXACTLY from
  -- these bytes, which is what a single-paper search does — the global index
  -- ranks the whole space, so a paper's best passages can sit outside the
  -- library-wide top-N and be dropped. The index can be rebuilt after a
  -- sqlite-vec upgrade without re-running the model over the whole corpus. And
  -- a vector always dies with its row, because this column cascades and a
  -- virtual table cannot.
  --
  -- The cost is honest duplication: at 384 dimensions a vector is 1.5 KB, so a
  -- 20-paper corpus of a few thousand chunks carries a handful of megabytes
  -- twice. That is a good trade against re-embedding, which costs CPU-minutes.
  vector         BLOB NOT NULL,
  embedded_at    TEXT NOT NULL
);
CREATE INDEX ix_chunk_run   ON chunk(stage_run_id);
CREATE INDEX ix_chunk_space ON chunk(space_id);
CREATE INDEX ix_chunk_doc   ON chunk(document_id, idx);
CREATE INDEX ix_chunk_work  ON chunk(work_id);
CREATE INDEX ix_chunk_stale ON chunk(config_hash);
`

// v20a — there is no longer any way to answer an analysis request without a
// model, and no table in which to keep one.
//
// Dropped rather than emptied: an empty table is an invitation, and the whole
// point is that a stored response keyed by an input hash must not be reachable
// as a substitute for a model reading the paper.
export const SCHEMA_V20_DROP_MOCK = /* sql */ `
DROP TABLE IF EXISTS mock_llm_response;
`

// v20b — WHERE a stored analysis came from: this machine, or the shipped corpus.
//
// `model` and `provider` already say WHICH model answered, and that stays the
// authority on attribution. What they cannot say is whether the run happened
// HERE. A precomputed corpus ships with genuine runs — real model, real
// provenance, real facts — and without this column those are byte-identical to
// runs the user's own machine produced moments ago. Both are honest about the
// model; only one is honest about the provenance chain the user can personally
// vouch for, and the difference matters the moment they wonder why an analysis
// exists for a paper they never processed.
//
// Three values:
//   'local'     produced by a model call from THIS installation
//   'shipped'   produced by a model call during corpus preparation, distributed
//               with the app, and labelled as such wherever it is shown
//   'imported'  brought in from another installation's export
//
// 'local' is the DEFAULT because the pipeline is the only writer that does not
// name it explicitly, and everything the pipeline writes is by definition local.
export const SCHEMA_V20_RUN_ORIGIN = /* sql */ `
ALTER TABLE analysis_run ADD COLUMN run_origin TEXT NOT NULL DEFAULT 'local'
  CHECK (run_origin IN ('local','shipped','imported'));
-- The seeded corpus stamps this at build time; a run that names a shipped
-- origin must also name WHEN the corpus was prepared, so "this is older than
-- your install" is answerable without guessing from run_timestamp.
ALTER TABLE analysis_run ADD COLUMN origin_note TEXT;
CREATE INDEX ix_analysis_run_origin ON analysis_run(run_origin);
`

// ============================================================ v25 — citation_link
//
// The VERIFIED, TWO-SIDED citation claim: a passage in the citing paper, and the
// specific block in the CITED paper that it refers to.
//
// A separate table rather than columns on `citation_context`, and the reason is
// lifecycle rather than tidiness. A `citation_context` row is one document's
// deterministic callout inventory, rewritten every time that paper is
// re-segmented. A verification is about a PAIR of papers, costs a model call,
// and is produced by a corpus sweep. Folding it into the context row would make
// the sweep's own stage_run key wrong (a corpus run belongs to no document) and
// would tempt a writer to update rows another run owns.
//
// Hanging it off `citation_context(id) ON DELETE CASCADE` nonetheless gets the
// correct lifecycle for free: re-running the citing paper's contexts, deleting
// the cited work (edge cascades, context cascades) and deleting the citing work
// all remove the verification — because in every one of those cases the passage
// it judged has ceased to exist, and a judgement about a passage that is gone is
// not a judgement about anything.
//
// A REJECTION is a first-class row. "This passage does not really reference that
// paper" is a finding worth storing: it is what stops the next sweep paying for
// the same answer, and it must never be representable as a citation context.
export const SCHEMA_V25_CITATION_LINK = /* sql */ `
CREATE TABLE citation_link (
  id                   INTEGER PRIMARY KEY,

  citation_context_id  INTEGER NOT NULL REFERENCES citation_context(id) ON DELETE CASCADE,
  citing_work_id       INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  cited_work_id        INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,

  -- Three outcomes, and they are three because collapsing any two of them would
  -- state something false about a paper:
  --   'verified'     a model read the passage and confirmed it references the
  --                  cited paper. A target block may or may not be named.
  --   'rejected'     a model read it and said it does NOT. Never presented as a
  --                  citation context; stored so the answer is not re-bought.
  --   'unverifiable' nothing could be asked, because the cited paper has no
  --                  embedded blocks to point AT (a scan with no text layer).
  --                  This is the honest fourth state: not "no target found",
  --                  which would blame the model for a question never put.
  --   'abstained'    the model WAS shown the passage and returned no verdict for
  --                  it. Distinct from 'rejected', which is an answer, and from
  --                  no row at all, which means nobody has looked yet. Recorded
  --                  so an unreadable passage is not re-bought on every sweep —
  --                  the job a prose-shaped regex used to do by refusing to ASK,
  --                  which silently withheld real citing sentences from the
  --                  model instead of letting it judge them.
  verdict              TEXT NOT NULL
                         CHECK (verdict IN ('verified','rejected','unverifiable','abstained')),

  -- The CITED-side anchor. NULL is a legitimate outcome for a VERIFIED link: the
  -- passage really does reference that paper and none of the blocks shown was
  -- the referent. Inventing one would be exactly the fabrication this table
  -- exists to prevent, so the schema makes the honest answer representable.
  target_chunk_id      INTEGER REFERENCES chunk(id) ON DELETE SET NULL,
  target_document_id   INTEGER REFERENCES document(id) ON DELETE SET NULL,
  target_page          INTEGER,
  -- JSON array copied from chunk.para_ids, so the passage stays addressable in
  -- the cited paper's paragraph inventory after the chunk itself is re-embedded.
  target_para_ids      TEXT,
  target_char_start    INTEGER,
  target_char_end      INTEGER,
  -- Denormalised, deliberately: a re-embed deletes the chunk, and a claim whose
  -- text vanished is unreadable exactly when a reader most wants to check it.
  target_text          TEXT,
  target_source        TEXT
                         CHECK (target_source IS NULL OR target_source IN ('llm-selected')),

  -- How the candidates were produced, so a reader can tell a thorough search
  -- from a thin one without re-deriving it.
  candidate_count      INTEGER NOT NULL DEFAULT 0,
  top_score            REAL,
  space_id             INTEGER,

  -- Provenance on every AI result.
  stage_run_id         INTEGER REFERENCES stage_run(id) ON DELETE SET NULL,
  model                TEXT,
  prompt_version       TEXT,
  confidence           REAL CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  reason               TEXT,
  -- Passage + candidate ids + prompt version. What makes re-verification a
  -- decision rather than a habit: an unchanged hash is an answer we already have.
  input_hash           TEXT NOT NULL,
  created_at           TEXT NOT NULL,

  -- A verdict that answered "no" has no target, and neither has one that could
  -- not be asked. Without this the two could carry an anchor into the cited
  -- paper, which is a claim nobody made.
  CHECK (verdict = 'verified' OR (target_chunk_id IS NULL AND target_text IS NULL)),
  -- A target with no stated origin is precisely what target_source exists to
  -- prevent, on the same reasoning as role/role_source on citation_context.
  CHECK (target_chunk_id IS NULL OR target_source IS NOT NULL),
  -- A model verdict names the model that reached it. 'unverifiable' does not:
  -- no model was consulted, and stamping one would credit it with an answer.
  CHECK (verdict = 'unverifiable' OR model IS NOT NULL)
);
-- ONE verification per passage. This is what makes the sweep idempotent: a
-- second run cannot double the rows however it is interrupted.
CREATE UNIQUE INDEX ux_citation_link_context ON citation_link(citation_context_id);
CREATE INDEX ix_citation_link_cited  ON citation_link(cited_work_id);
CREATE INDEX ix_citation_link_citing ON citation_link(citing_work_id);
CREATE INDEX ix_citation_link_chunk  ON citation_link(target_chunk_id)
  WHERE target_chunk_id IS NOT NULL;
`

// ============================================================ v26: work_summary
//
// The PROSE a run produced, as opposed to the facts it produced.
//
// A summary is one continuous piece of writing whose value is that it reads as
// a whole. Shredding it into `fact` rows to reuse that table would destroy the
// only property it has — a paragraph is not five claims, and the ordering,
// hedging and connective tissue between them is the summary. So it gets a
// column of its own.
//
// It hangs off `analysis_run` and NOTHING else, which is what makes it cost so
// little: the run already carries model, prompt_version, schema_version, the
// four input hashes, `superseded`, and `project_id`. Therefore
//   - the GENERAL and the PROJECT summary are the same table, told apart by the
//     run's `project_id` (0 = global sentinel, N = that project's reading), per
//     the ontology rule that project interpretation never lands on the global
//     work;
//   - `ux_analysis_run_current` already guarantees ONE current summary per
//     (work, project), so regeneration is the existing supersede-then-insert
//     with no new concurrency rule to get wrong;
//   - staleness is the existing hash comparison, with no bespoke logic.
//
// CASCADE, uniquely among the analysis children: `fact` and `evidence_span` use
// RESTRICT because they are evidence and must outlive careless deletion. This
// is a rendering of evidence, regenerable from the run's own inputs, and a
// summary that survived its run would be prose attributed to a model nobody can
// name any more.
export const SCHEMA_V26_WORK_SUMMARY = /* sql */ `
CREATE TABLE work_summary (
  id               INTEGER PRIMARY KEY,
  analysis_run_id  INTEGER NOT NULL REFERENCES analysis_run(id) ON DELETE CASCADE,
  -- The summary itself, as markdown-free plain prose. Paragraphs are separated
  -- by a blank line; the renderer does not interpret anything else, so a model
  -- that emits syntax cannot smuggle formatting into the reader's view.
  body             TEXT NOT NULL,
  -- What the model was actually given. A summary written from an abstract is a
  -- different claim from one written from the full text, and a reader weighing
  -- it needs to know which — the same reason content_status is badged rather
  -- than flattened. Free text, not an enum: the honest answer is the name of
  -- the capability the stage resolved, which grows with the pipeline.
  source_scope     TEXT NOT NULL,
  created_at       TEXT NOT NULL
);
-- One summary per run. The run is already unique per (work, project, type)
-- while current, so this makes the whole chain single-valued and lets the read
-- path JOIN without a tie-break that could silently pick either row.
CREATE UNIQUE INDEX ux_work_summary_run ON work_summary(analysis_run_id);
`

// ==================================================== v27: work_summary.document_id
//
// WHICH document a summary's prose was written from.
//
// Added in its own step rather than folded into v26 because v26 has already
// been applied to a real database. Editing a migration that has run is how a
// schema and its `user_version` stop agreeing: the DB says 26 and would never
// re-run the step, so the column would exist only on machines that had not
// migrated yet — and every write would then fail on exactly the machines that
// were up to date. A migration is append-only once it has left the developer's
// hands.
//
// It exists because nothing else records the link. Every other analysis names
// its document through evidence_span.document_id, and a summary produces prose
// rather than anchored claims, so it has no evidence spans at all — leaving the
// staleness check unable to tell which text was read, and reporting "unknown"
// for every summary in the app permanently. Measured: the paragraph body the
// freshness check rebuilds and the body the summary was written from are
// byte-identical, so the comparison starts working the moment the link exists.
//
// SET NULL, not CASCADE: losing the document does not make the prose untrue, it
// makes its source uncheckable — which is exactly what a NULL here tells the
// freshness check to report.
export const SCHEMA_V27_SUMMARY_DOCUMENT = /* sql */ `
ALTER TABLE work_summary ADD COLUMN document_id INTEGER REFERENCES document(id) ON DELETE SET NULL;
`

// v28: the indexes the document-text reads need.
//
// Pure additions — no column, no table, no row touched. Each exists because a
// read on the SYNCHRONOUS main-process connection would otherwise scan, and a
// scan there does not merely take longer: it holds every other IPC channel and
// the window's own repaint until it finishes.
//
//  * `ix_stage_run_doc` — "which run currently owns this document's paragraphs"
//    filters `stage_run` by `document_id`, and the only indexes were
//    `(work_id, stage)` and `(input_fingerprint)`. Every summary, every in-paper
//    find and every text read asks that question.
//  * `ix_stage_artifact_key` — the same resolution joins `stage_artifact` on its
//    `key`, whose PRIMARY KEY leads with `stage_run_id`. A key-first lookup had
//    no usable index and scanned a table whose rows are whole-document JSON.
//  * `ix_document_paragraph_run_idx` — every paged text read and every in-paper
//    find selects a run's paragraphs `ORDER BY idx`. The existing indexes are
//    `(stage_run_id, para_id)` and `(document_id, idx)`, neither of which
//    provides that ordering, so each read sorted a whole document in a temp
//    b-tree.
//  * `ix_stage_run_stage` — listing runs by stage, or stage and status, without
//    naming a work.
//  * `ix_file_location_hash` — an import asks "are these exact bytes already
//    here?" before it creates anything. PARTIAL: a row whose hash is still null
//    has nothing to answer with and does not belong in the index.
export const SCHEMA_V28_TEXT_INDEXES = /* sql */ `
CREATE INDEX IF NOT EXISTS ix_stage_run_doc      ON stage_run(document_id, stage);
CREATE INDEX IF NOT EXISTS ix_stage_run_stage    ON stage_run(stage, status);
CREATE INDEX IF NOT EXISTS ix_stage_artifact_key ON stage_artifact(key, stage_run_id);
CREATE INDEX IF NOT EXISTS ix_document_paragraph_run_idx ON document_paragraph(stage_run_id, idx);
CREATE INDEX IF NOT EXISTS ix_file_location_hash ON file_location(hash) WHERE hash IS NOT NULL;
`

// ---------------------------------------------------------------- v29
// WHICH FIELD DEFINITIONS an extraction was produced under, and WHICH RUN
// actually produced each fact.
//
// `analysis_run.field_hashes` is a JSON object `{ fieldKey: param_hash }`
// covering the fields that run was asked about. Until now a run recorded the
// schema's COMPOSITE version and nothing else, so "the user edited one field —
// which of this run's values are still good?" had no answer at all and the only
// safe response was to redo the paper entirely. NULL on every pre-existing run
// and on unguided (schema-less) runs, and NULL reads as "unknown", which falls
// back to the whole-schema behaviour — never to a false claim of freshness.
//
// `fact.origin_run_id` names the run that actually produced a fact. A partial
// re-extraction copies the untouched fields' facts forward into the new current
// run (they MUST live on the current run — every read path filters
// `superseded = 0`, so a fact left behind on the retired run would simply
// disappear from the Extraction table and the exports, which is the exact data
// the feature exists to preserve). The copy is a new row with a new id, so
// without this column it would claim to have been produced by a model call that
// never looked at it. NULL means "this run made it", which is the ordinary case
// and stays the ordinary case.
export const SCHEMA_V29_FIELD_PROVENANCE = /* sql */ `
ALTER TABLE analysis_run ADD COLUMN field_hashes TEXT;
ALTER TABLE fact ADD COLUMN origin_run_id INTEGER REFERENCES analysis_run(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS ix_fact_origin_run ON fact(origin_run_id) WHERE origin_run_id IS NOT NULL;
`

// v30 — CANONICAL UNITS ALONGSIDE THE RAW ONES.
//
// The ontology requires the value and unit AS REPORTED to be preserved
// (CLAUDE.md §3), so `measurement.unit` and `measurement.value_num` are never
// rewritten. But stored only as printed they do not compare: this corpus holds
// kcat under `s^-1`, `1/s`, `s⁻¹`, `s−1`, `s 2 1` and `min^-1`, and KM under
// both `mM` and `µM` — a thousandfold apart with nothing marking the
// difference. Every corpus-wide question (is this an outlier, is this field
// reported consistently) then answers on spelling rather than on physics.
//
// Two nullable columns hold the reduced form derived by `llm/units.ts`. NULL
// means "not canonicalisable" — an unrecognised unit, which must stay
// unrecognised rather than be quietly folded into a unit it is not.
export const SCHEMA_V30_CANONICAL_UNITS = /* sql */ `
ALTER TABLE measurement ADD COLUMN unit_canonical TEXT;
ALTER TABLE measurement ADD COLUMN value_canonical REAL;
CREATE INDEX IF NOT EXISTS ix_measurement_canonical
  ON measurement(field_id, unit_canonical) WHERE unit_canonical IS NOT NULL;
`

// ---------------------------------------------------------------- migration v41
// `fact` gains `field_id`: ONE place a value is bound to a schema field.
//
// WHY. The binding lived only on `measurement.field_id`, and a measurement row
// exists only for a NUMBER — so a text- or enum-valued field had nowhere to
// land. Measured on the live DB's current runs, `variant`, `mutations` and
// `reference_variant` bound ZERO times each, `substrate` twice out of 28 facts
// reporting it, `buffer` twice out of 25, and 74 of 557 kept facts named no
// field at all. Every one of those values was extracted correctly and then made
// unreachable by the only screen meant to show it, which fell back to matching
// `fact.predicate` against a field key — a synonym rule in all but name, and one
// that could never match `enzyme variant` or `Enzyme variant name`.
//
// A fact answers ONE field of ONE schema, so the key belongs on the fact. The
// measurement keeps its own `field_id` (the two agree when both exist) because
// it is what `ix_measurement_canonical` and the canonical-unit reads index on.
//
// ON DELETE SET NULL, matching `measurement.field_id`: deleting a field must
// preserve the extraction and the review verdicts against it, not cascade them
// away.
export const SCHEMA_V41_FACT_FIELD = /* sql */ `
ALTER TABLE fact ADD COLUMN field_id INTEGER
  REFERENCES extraction_field(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ix_fact_field ON fact(field_id) WHERE field_id IS NOT NULL;
`

// v42 — THIS PROJECT'S OWN BRIEF FOR ITS PROJECT SUMMARIES.
//
// The project summary reads a paper against this collection, so what it should
// look for is a property of the collection and not of the app. A NULL means
// "use the built-in brief", which is why the column has no default text: a
// default copied into every row would freeze today's wording into projects
// created before the next revision of it, and the built-in would then only ever
// reach projects made after a release.
//
// No index: it is read one row at a time, by id, whenever a summary is written.
export const SCHEMA_V42_PROJECT_SUMMARY_PROMPT = /* sql */ `
ALTER TABLE project ADD COLUMN summary_prompt TEXT;
`

// ================================================================ v43 — sync identity
//
// An EXPLICIT identity for the rows that can travel between two installs of
// this app, so a paper that arrives twice is recognised as the same paper.
//
// This is APP schema and stays here whether a sharing plugin is
// present or not. Putting a plugin's steps in this list would make deleting the
// plugin drop the target `user_version` below the one on disk, and
// `runMigrations` then refuses to open the database at all — a plugin folder
// nobody wanted any more would be a hard launch failure. The plugin's own
// bookkeeping tables are created by the plugin with CREATE TABLE IF NOT EXISTS
// and no version bump, for the same reason.
//
// WHY NOT THE ARCHIVE'S NATURAL KEYS, which already identify a work across
// machines: they identify it well enough to insert it ONCE. Continuous sync
// needs identity to hold on every poll, and the archive's body-hash rule yields
// a hash only for a document with exactly one live `stage_run` and at least one
// non-reference paragraph — so a metadata-only or abstract-only work has no key
// at all, and the key it does have changes when the PDF version or the text
// extraction version changes. A miss is harmless once; ten seconds later it is a
// duplicate work, and ten seconds after that another one. The natural keys are
// kept, demoted to a dedupe HINT for the first join.
//
// PARTIAL-UNIQUE, mirroring `ux_analysis_run_current`. NULL means "this row has
// never been shared", and SQLite treats NULLs as distinct in a unique index, so
// every unshared row coexists rather than colliding on a single NULL. Two users
// who independently share their own local project number 3 is a non-event:
// identity is the uuid, which neither of them can collide with.
//
// `project_work.removed_at` is RESERVED and unwritten. Deletes are out of scope,
// which has a consequence the UI has to state — a paper removed from a shared
// project is resurrected by the peer on the next poll — and reserving the column
// now means the eventual fix needs no second migration on a populated corpus.
export const SCHEMA_V43_SYNC_IDENTITY = /* sql */ `
ALTER TABLE project        ADD COLUMN sync_uuid TEXT;
ALTER TABLE work           ADD COLUMN sync_uuid TEXT;
ALTER TABLE analysis_run   ADD COLUMN sync_uuid TEXT;
ALTER TABLE saved_search   ADD COLUMN sync_uuid TEXT;
ALTER TABLE saved_frontier ADD COLUMN sync_uuid TEXT;
ALTER TABLE fact_verdict   ADD COLUMN sync_uuid TEXT;
ALTER TABLE project_work   ADD COLUMN removed_at TEXT;

CREATE UNIQUE INDEX ux_project_sync_uuid        ON project(sync_uuid)        WHERE sync_uuid IS NOT NULL;
CREATE UNIQUE INDEX ux_work_sync_uuid           ON work(sync_uuid)           WHERE sync_uuid IS NOT NULL;
CREATE UNIQUE INDEX ux_analysis_run_sync_uuid   ON analysis_run(sync_uuid)   WHERE sync_uuid IS NOT NULL;
CREATE UNIQUE INDEX ux_saved_search_sync_uuid   ON saved_search(sync_uuid)   WHERE sync_uuid IS NOT NULL;
CREATE UNIQUE INDEX ux_saved_frontier_sync_uuid ON saved_frontier(sync_uuid) WHERE sync_uuid IS NOT NULL;
CREATE UNIQUE INDEX ux_fact_verdict_sync_uuid   ON fact_verdict(sync_uuid)   WHERE sync_uuid IS NOT NULL;
`

// ============================================== v44 — updated_at coverage + triggers
//
// LAST-WRITE-WINS NEEDS A LAST WRITE TIME, on every row that can travel, and it
// needs it to be maintained by something no writer can forget.
//
// Three tables gain the column: `analysis_run`, `fact_verdict`, `project_schema`.
// Nothing is BACKFILLED. NULL means "never edited since it was created", which
// the comparator resolves by falling back to `created_at`; writing `created_at`
// into the column instead would be indistinguishable from a real edit, and every
// row in the corpus would present as freshly touched on first launch.
//
// `analysis_run` gets one even though it already carries `run_timestamp`, which
// looks like the same thing and is not: `user_corrections`, `evidence_span`
// edits and the v35 canonical triggers all mutate a run AFTER it ran, so a
// derivation from `run_timestamp` would freeze every one of those edits at the
// moment of the model call and lose them to a peer's older copy.
//
// `document` gets nothing: documents are filesystem paths on the sender's disk
// and are never synced.
//
// WHY TRIGGERS AND NOT DISCIPLINE. Two live statements already omit
// `updated_at` today — `repositories.ts` updating `work.publication_year/venue`
// after a retrieval, and `project-archive/restore.ts` updating
// `project.category/tags` — and both edits would therefore be silently
// discarded by LWW in favour of a peer's older row. Those two are fixed
// explicitly as well, but a column any caller can forget will be forgotten by
// the caller who has never read this file, so the invariant is moved to the one
// place every writer passes through. v35 established the idiom on `measurement`.
//
// ONE CLOCK. Every trigger calls `relay_now()`, registered per connection in
// `db/connection.ts`, which returns the wall clock plus the offset the sync
// plugin last measured against the relay — in the same `%Y-%m-%dT%H:%M:%fZ`
// format SQLite's own `strftime` produces, so a corpus that has never synced is
// byte-identical to one written by `'now'`. No code path may use `'now'` for a
// table in this list: triggers stamping local time while the comparator reasons
// in relay time is how a peer three minutes fast wins every tie forever, and it
// is asserted by a test rather than left as a convention.
//
// GUARDED with `IS NOT` (SQLite has no `IS NOT DISTINCT FROM`), so an explicit
// write of `updated_at` still wins and the trigger does not re-fire on its own
// UPDATE.
export const SCHEMA_V44_UPDATED_AT = /* sql */ `
ALTER TABLE analysis_run   ADD COLUMN updated_at TEXT;
ALTER TABLE fact_verdict   ADD COLUMN updated_at TEXT;
ALTER TABLE project_schema ADD COLUMN updated_at TEXT;
`

// The triggers, separate so the runner installs them after the columns exist and
// so a later step can DROP and re-create the whole set from one constant.
//
// One AFTER UPDATE trigger per synced table, each stamping only when the row
// changed for a reason other than the stamp itself. No INSERT triggers: every
// insert path already writes `created_at`, and for the three tables above a NULL
// `updated_at` at insert time is the correct and meaningful value.
export const SCHEMA_V44_TRIGGERS = /* sql */ `
DROP TRIGGER IF EXISTS trg_sync_touch_project;
DROP TRIGGER IF EXISTS trg_sync_touch_work;
DROP TRIGGER IF EXISTS trg_sync_touch_project_work;
DROP TRIGGER IF EXISTS trg_sync_touch_analysis_run;
DROP TRIGGER IF EXISTS trg_sync_touch_fact_verdict;
DROP TRIGGER IF EXISTS trg_sync_touch_project_schema;
DROP TRIGGER IF EXISTS trg_sync_touch_saved_search;
DROP TRIGGER IF EXISTS trg_sync_touch_saved_frontier;

CREATE TRIGGER trg_sync_touch_project
AFTER UPDATE ON project
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
  UPDATE project SET updated_at = relay_now() WHERE id = NEW.id;
END;

CREATE TRIGGER trg_sync_touch_work
AFTER UPDATE ON work
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
  UPDATE work SET updated_at = relay_now() WHERE id = NEW.id;
END;

CREATE TRIGGER trg_sync_touch_project_work
AFTER UPDATE ON project_work
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
  UPDATE project_work SET updated_at = relay_now() WHERE id = NEW.id;
END;

CREATE TRIGGER trg_sync_touch_analysis_run
AFTER UPDATE ON analysis_run
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
  UPDATE analysis_run SET updated_at = relay_now() WHERE id = NEW.id;
END;

CREATE TRIGGER trg_sync_touch_fact_verdict
AFTER UPDATE ON fact_verdict
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
  UPDATE fact_verdict SET updated_at = relay_now() WHERE id = NEW.id;
END;

CREATE TRIGGER trg_sync_touch_project_schema
AFTER UPDATE ON project_schema
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
  UPDATE project_schema SET updated_at = relay_now()
   WHERE project_id = NEW.project_id AND schema_id = NEW.schema_id;
END;

CREATE TRIGGER trg_sync_touch_saved_search
AFTER UPDATE ON saved_search
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
  UPDATE saved_search SET updated_at = relay_now() WHERE id = NEW.id;
END;

CREATE TRIGGER trg_sync_touch_saved_frontier
AFTER UPDATE ON saved_frontier
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
  UPDATE saved_frontier SET updated_at = relay_now() WHERE id = NEW.id;
END;
`

/**
 * The tables v44's triggers cover. Exported so a test can assert the set and the
 * constant cannot drift apart from it, and so the `relay_now()`-not-`'now'`
 * audit has one list to sweep.
 */
export const SYNC_TOUCHED_TABLES = [
  'project',
  'work',
  'project_work',
  'analysis_run',
  'fact_verdict',
  'project_schema',
  'saved_search',
  'saved_frontier'
] as const

// v31 — WHERE THE MARKER SITS INSIDE THE STORED SENTENCE.
//
// `callout_offset` indexes the canonical document; `sentence` is a healed,
// dehyphenated join whose own start is not a document offset. So a consumer
// holding only the sentence — which is what the citation verifier sends to the
// model — had to re-find the marker by its printed form, and a superscript
// callout is a BARE NUMBER. Measured on this corpus: 104 of 1176 passages
// contain their ordinal more than once, and taking the first occurrence points
// at the wrong token in 89 of them. A model asked "does this passage reference
// paper B" while the marker is drawn around a measurement is being asked the
// wrong question, and its answer is stored as a verified citation.
//
// Nullable, and NULL is a real state: a passage whose marker could not be
// pinned is sent UNMARKED rather than marked wrongly, exactly as before.
// Existing rows keep NULL and are re-derived when the scanner re-runs — its
// version moved in the same change, so they will.
export const SCHEMA_V31_MARKER_IN_SENTENCE = /* sql */ `
ALTER TABLE citation_context ADD COLUMN marker_in_sentence INTEGER;
`

// ---------------------------------------------------------------- migration v33
// `analysis_check` gains PROVENANCE and an INPUT HASH.
//
// WHY. A check verdict used to be the output of one thing — code in the same
// process, on the same rows, at the same instant as the run. Nothing needed to
// be recorded about WHO answered because there was only ever one answerer.
//
// That is no longer true. The checks that assert something about THE PAPER now
// go to a model, because code that has not read the paper cannot answer them
// without being wrong sometimes, and one wrong flag costs the reader's trust in
// every true one beside it. A model answer is an AI result, and this app's hard
// rule is that every AI result carries provenance: which model, under which
// prompt version, over which input.
//
// `source` is the load-bearing column. `deterministic` means a search, a lookup
// or a piece of arithmetic; `reviewed` means a reading. A reader deciding how
// hard to push back on a verdict needs to know which they are looking at, and
// so does the code that decides whether a failure is a STRUCTURAL defect (only
// a mechanical check may make that claim).
//
// `input_hash` is what makes the review idempotent. It fingerprints the QUESTION
// — the record, its stored value and the words it was asked about — so a wake
// that would ask the same question again finds the answer already stored and
// spends no call. Without it the reviewer would re-read the whole corpus every
// time anything upstream twitched.
//
// NULLABLE, all four, and no backfill: rows written before this migration were
// produced by the deterministic engine and their absent `source` is not a
// mystery — the DEFAULT supplies it. Model and prompt version are legitimately
// absent on a deterministic verdict and must not be invented for one.
export const SCHEMA_V33_CHECK_PROVENANCE = /* sql */ `
ALTER TABLE analysis_check ADD COLUMN source TEXT NOT NULL DEFAULT 'deterministic'
  CHECK (source IN ('deterministic','reviewed'));
ALTER TABLE analysis_check ADD COLUMN model TEXT;
ALTER TABLE analysis_check ADD COLUMN prompt_version TEXT;
ALTER TABLE analysis_check ADD COLUMN input_hash TEXT;
CREATE INDEX ix_analysis_check_input ON analysis_check(input_hash);
`

// ---------------------------------------------------------------- migration v35
// The canonical pair is DERIVED BY THE DATABASE, not by whoever inserts a row.
//
// WHY. `unit_canonical`/`value_canonical` are what make a measurement
// comparable with the same quantity read from another paper — every unit-aware
// ranking, outlier check and cross-paper comparison reads them, and a row where
// they are NULL is simply absent from all of it. They arrived in v30 as plain
// nullable columns that each writer was trusted to populate, and the trust did
// not hold: of the three paths that insert a measurement, `llm/pipeline.ts` and
// `db/shipped-analyses.ts` call `canonicaliseMeasurement`, while
// `project-archive/restore.ts` copies whatever columns the archive happens to
// carry — so an archive built before v30, or by a machine whose parser abstained
// on a spelling this one recognises, restores rows that are invisible to every
// comparison, silently and with no error anywhere.
//
// A DERIVED COLUMN THAT CALLERS POPULATE IS A COLUMN THAT WILL BE MISSED. The
// invariant is therefore moved to the one place every writer passes through:
// triggers on the table itself. AFTER INSERT derives the pair for a new row;
// AFTER UPDATE re-derives it whenever the raw `value_num`/`unit` change, so a
// correction to what the paper said can never leave a stale canonical value
// beside it. Both are guarded (`WHEN`) so the trigger does not re-fire on its
// own write.
//
// The RAW columns are read and never written, by either trigger. What the paper
// reported survives untouched — CLAUDE.md §3 — and only the derived pair is
// computed, which is exactly the guarantee that lets v30 and v34 recompute the
// whole column at will.
//
// `canonical_unit`/`canonical_value` are registered per connection by
// `registerCanonicalUnit` in `db/connection.ts`, so the parser stays in ONE
// place: SQL calls the same TypeScript the pipeline calls, and a future fix to
// unit parsing reaches inserts and backfills together rather than drifting.
//
// NULL remains a real, correct answer. A unit the parser does not recognise
// leaves both columns NULL rather than being folded into the nearest known unit,
// which would be a silent unit conversion — the precise failure this whole
// mechanism exists to prevent.
export const SCHEMA_V35_CANONICAL_TRIGGERS = /* sql */ `
DROP TRIGGER IF EXISTS trg_measurement_canonical_insert;
DROP TRIGGER IF EXISTS trg_measurement_canonical_update;

CREATE TRIGGER trg_measurement_canonical_insert
AFTER INSERT ON measurement
WHEN NEW.unit IS NOT NULL AND TRIM(NEW.unit) <> ''
BEGIN
  UPDATE measurement
     SET unit_canonical  = canonical_unit(NEW.unit),
         value_canonical = canonical_value(NEW.value_num, NEW.unit)
   WHERE id = NEW.id;
END;

CREATE TRIGGER trg_measurement_canonical_update
AFTER UPDATE OF value_num, unit ON measurement
WHEN NEW.value_num IS NOT OLD.value_num OR NEW.unit IS NOT OLD.unit
BEGIN
  UPDATE measurement
     SET unit_canonical  =
           CASE WHEN NEW.unit IS NULL OR TRIM(NEW.unit) = '' THEN NULL
                ELSE canonical_unit(NEW.unit) END,
         value_canonical =
           CASE WHEN NEW.unit IS NULL OR TRIM(NEW.unit) = '' THEN NULL
                ELSE canonical_value(NEW.value_num, NEW.unit) END
   WHERE id = NEW.id;
END;
`

// ================================================ v37 — citation_link_carryover
//
// DROPPED AGAIN BY v39. Retained only so a database that stopped at v37 can be
// migrated forward through the step that created it.
//
// It held paid citation verdicts across a re-scan, because the contexts stage
// deleted and re-inserted its whole inventory and `citation_link`'s cascade
// could not tell a passage that had genuinely disappeared from one that had been
// rewritten identically. The delete was the defect, and it is gone: the write
// upserts on the site key, so a rediscovered citation keeps its row, its id and
// its verdict, and nothing needs rescuing.
export const SCHEMA_V37_LINK_CARRYOVER = /* sql */ `
CREATE TABLE citation_link_carryover (
  id              INTEGER PRIMARY KEY,
  citing_work_id  INTEGER NOT NULL,
  document_id     INTEGER NOT NULL,
  callout_offset  INTEGER NOT NULL,
  ordinal         INTEGER NOT NULL,
  cited_work_id   INTEGER NOT NULL,
  sentence        TEXT,
  -- The whole citation_link payload as JSON rather than 19 mirrored columns:
  -- a mirror drifts from the table it mirrors on the next ALTER, and this one
  -- would drift silently, at the exact moment it is asked to restore a verdict.
  link_json       TEXT NOT NULL,
  captured_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_citation_link_carryover_site
  ON citation_link_carryover(document_id, callout_offset, ordinal);
CREATE INDEX ix_citation_link_carryover_work
  ON citation_link_carryover(citing_work_id);
`

// ============================================================ v40 — citation_context without a model's self-report
//
// `role_confidence` was the model's own number about its own role label. It is
// not a quality signal — half the corpus's rows had none, and the ones that did
// spanned 0.7–0.98 with no relation to whether the label was right — so a reader
// shown it is being invited to rank labels by a figure that ranks nothing.
//
// A rebuild rather than DROP COLUMN: two of this table's CHECK constraints NAME
// `role_confidence` (the 'rule' provenance rule required it to be NULL), so
// SQLite refuses the drop. The rule survives without the column — a rule role
// still has to carry a cue — and `role_source` alone now tells the two apart.
export const SCHEMA_V40_CITATION_CONTEXT = /* sql */ `
CREATE TABLE citation_context (
  id                      INTEGER PRIMARY KEY,

  edge_id                 INTEGER REFERENCES citation_edge(id)        ON DELETE CASCADE,
  unresolved_reference_id INTEGER REFERENCES unresolved_reference(id) ON DELETE CASCADE,

  stage_run_id            INTEGER REFERENCES stage_run(id) ON DELETE CASCADE,
  document_id             INTEGER REFERENCES document(id)  ON DELETE CASCADE,
  citing_work_id          INTEGER REFERENCES work(id)      ON DELETE CASCADE,

  ordinal                 INTEGER,
  callout_offset          INTEGER,
  callout_end             INTEGER,

  para_id                 TEXT,
  page                    INTEGER,
  sentence                TEXT,
  section                 TEXT,

  raw_bib_text            TEXT,

  role                    TEXT CHECK (role IS NULL OR role IN (
                            'background','method','comparison','support',
                            'contrast','data-source','motivation','review','other')),
  role_source             TEXT CHECK (role_source IS NULL OR role_source IN ('rule','llm')),
  role_cue                TEXT,

  occurrence_kind         TEXT CHECK (occurrence_kind IS NULL OR occurrence_kind IN (
                            'inline','footnote','table','figure','bibliography')),
  resolution_confidence   REAL CHECK (resolution_confidence IS NULL OR resolution_confidence BETWEEN 0 AND 1),

  created_at              TEXT NOT NULL,
  marker_in_sentence      INTEGER,

  CHECK ((edge_id IS NULL) <> (unresolved_reference_id IS NULL)),

  CHECK (role IS NULL OR role_source IS NOT NULL),
  CHECK (role_source IS NULL OR role_source <> 'rule' OR role_cue IS NOT NULL),
  CHECK (role_source IS NULL OR role_source <> 'llm' OR role_cue IS NULL)
);
`

// v40b — `citation_link` without the model's self-reported confidence.
//
// Rebuilt rather than DROP COLUMN'd only because the column sits inside a CHECK
// this table also has to shed, and because v40 must re-create it anyway: it is
// the one table that REFERENCES citation_context ON DELETE CASCADE, so it has to
// be out of the way while that table is rebuilt (see the note in migrate.ts).
export const SCHEMA_V40_CITATION_LINK = /* sql */ `
CREATE TABLE citation_link (
  id                   INTEGER PRIMARY KEY,
  citation_context_id  INTEGER NOT NULL REFERENCES citation_context(id) ON DELETE CASCADE,
  citing_work_id       INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  cited_work_id        INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  verdict              TEXT NOT NULL
                         CHECK (verdict IN ('verified','rejected','unverifiable','abstained')),
  target_chunk_id      INTEGER REFERENCES chunk(id) ON DELETE SET NULL,
  target_document_id   INTEGER REFERENCES document(id) ON DELETE SET NULL,
  target_page          INTEGER,
  target_para_ids      TEXT,
  target_char_start    INTEGER,
  target_char_end      INTEGER,
  target_text          TEXT,
  target_source        TEXT
                         CHECK (target_source IS NULL OR target_source IN ('llm-selected')),
  candidate_count      INTEGER NOT NULL DEFAULT 0,
  top_score            REAL,
  space_id             INTEGER,
  stage_run_id         INTEGER REFERENCES stage_run(id) ON DELETE SET NULL,
  model                TEXT,
  prompt_version       TEXT,
  reason               TEXT,
  input_hash           TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  CHECK (verdict = 'verified' OR (target_chunk_id IS NULL AND target_text IS NULL)),
  CHECK (target_chunk_id IS NULL OR target_source IS NOT NULL),
  CHECK (verdict = 'unverifiable' OR model IS NOT NULL)
);
CREATE UNIQUE INDEX ux_citation_link_context ON citation_link(citation_context_id);
CREATE INDEX ix_citation_link_cited  ON citation_link(cited_work_id);
CREATE INDEX ix_citation_link_citing ON citation_link(citing_work_id);
CREATE INDEX ix_citation_link_chunk  ON citation_link(target_chunk_id)
  WHERE target_chunk_id IS NOT NULL;
`

/**
 * The token ledger: what every LLM call cost, and what it was spent on.
 *
 * NO FOREIGN KEY to `work` or `document`, and no cascade, deliberately. This is
 * a record of money spent and it outlives the paper it was spent on — a cascade
 * would let deleting one paper silently rewrite last month's totals, and a
 * chart whose history changes underneath the reader is worse than one that
 * admits the paper is gone. The ids are stored as the plain integers they were
 * and joined opportunistically; a join that finds nothing IS the answer.
 *
 * The ids are nullable because not every call belongs to a paper. A row that
 * invented a `work_id` to satisfy NOT NULL would attribute spend to a paper
 * that never saw it.
 *
 * `ok = 0` means usage WAS reported and the answer was unusable anyway
 * (truncated at the ceiling, refused downstream) — never "the call failed and
 * we assumed it was free". A transport failure reports no usage and writes no
 * row at all, because a fabricated zero in a ledger is a guess wearing a
 * measurement's clothes.
 */
export const SCHEMA_V47_TOKEN_USAGE = /* sql */ `
CREATE TABLE IF NOT EXISTS llm_token_usage (
  id                INTEGER PRIMARY KEY,
  at                TEXT    NOT NULL,
  model             TEXT    NOT NULL,
  provider          TEXT    NOT NULL,
  stage             TEXT,
  purpose           TEXT,
  work_id           INTEGER,
  document_id       INTEGER,
  project_id        INTEGER,
  schema_id         INTEGER,
  analysis_run_id   INTEGER,
  stage_run_id      INTEGER,
  job_id            INTEGER,
  attempt           INTEGER NOT NULL,
  ok                INTEGER NOT NULL,
  failure           TEXT,
  prompt_tokens     INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  total_tokens      INTEGER NOT NULL,
  duration_ms       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_llm_token_usage_at    ON llm_token_usage(at);
CREATE INDEX IF NOT EXISTS ix_llm_token_usage_work  ON llm_token_usage(work_id, at);
CREATE INDEX IF NOT EXISTS ix_llm_token_usage_model ON llm_token_usage(model);
`

/**
 * INPUT IS THREE NUMBERS, not one.
 *
 * Anthropic reports uncached input, cache WRITES and cache READS separately, and
 * v47 stored only the first — so `prompt_tokens` held the base-rate remainder
 * while the bulk of the prompt went unrecorded. Measured on this corpus: a
 * schema extraction sending 66 KB of paper reported 3.
 *
 * They stay in three columns rather than being summed on the way in because
 * they are not billed alike — a cache read is a fraction of the base rate, a
 * cache write is more than it — so one merged integer cannot be turned back
 * into a cost, and this table exists to answer what the work cost.
 *
 * DEFAULT 0 on both, which is honest for the rows v47 already wrote: those calls
 * really did have their cache figures discarded, and the alternative — leaving
 * them NULL — would make every later SUM() return NULL for any window touching
 * them. Their `total_tokens` stays as recorded and so understates the input;
 * that cannot be repaired, because the numbers were never stored.
 */
export const SCHEMA_V48_CACHE_TOKENS = /* sql */ `
ALTER TABLE llm_token_usage ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE llm_token_usage ADD COLUMN cache_read_tokens     INTEGER NOT NULL DEFAULT 0;
`

/**
 * `fact` with the four-value `kind` CHECK, for the v49 rebuild.
 *
 * Column-for-column the shape a v48 database already holds — `confidence` gone
 * at v40, `origin_run_id` and `field_id` added at v38/v41 — written out here as
 * one CREATE because a CHECK constraint cannot be altered in place.
 */
export const SCHEMA_V49_FACT = /* sql */ `
CREATE TABLE fact (
  id               INTEGER PRIMARY KEY,
  analysis_run_id  INTEGER NOT NULL REFERENCES analysis_run(id) ON DELETE RESTRICT,
  evidence_span_id INTEGER REFERENCES evidence_span(id) ON DELETE SET NULL,
  kind             TEXT NOT NULL
                     CHECK (kind IN (
                       'directly-reported','inferred','supplied-by-project-context',
                       'uncertain-conflicting')),
  predicate        TEXT NOT NULL,
  subject          TEXT,
  object           TEXT,
  value_text       TEXT,
  created_at       TEXT NOT NULL,
  origin_run_id    INTEGER REFERENCES analysis_run(id) ON DELETE RESTRICT,
  field_id         INTEGER REFERENCES extraction_field(id) ON DELETE SET NULL
);
CREATE INDEX ix_fact_run ON fact(analysis_run_id);
CREATE INDEX ix_fact_origin_run ON fact(origin_run_id) WHERE origin_run_id IS NOT NULL;
CREATE INDEX ix_fact_field ON fact(field_id) WHERE field_id IS NOT NULL;
`

// ---------------------------------------------------------------- v52
// A REVIEWER MAY NOW SAY A RECORD SHOULD NOT EXIST.
//
// The record reviewer could only ever ADD. It failed three checks correctly —
// values recorded in a column the page's merged cell does not cover — and
// repaired none of them, because the only writes it had were a verdict and a new
// fact. A reader who can see that a row is wrong and cannot say so is a reader
// whose findings a human has to re-derive.
//
// MARKED, NEVER DELETED. `retracted_by_check_id` names the `analysis_check` row
// that made the judgement, so the retraction arrives with its reason, its model
// and its prompt version attached, and an export still carries the value beside
// the reading that withdrew it. A boolean would have said a row is wrong with
// nobody's name on it.
//
// NOT INFERRED FROM A FAILED CHECK, which is why it is a column of its own.
// "The passage does not support this value" and "this row should not exist" are
// different judgements: the first sends a record to a human, the second says the
// correct state is no record. A `failed` status has always meant the first, on
// thousands of stored rows, and reading retraction out of it would retract every
// one of them retroactively.
//
// ON DELETE SET NULL rather than CASCADE: deleting the verdict must not delete
// the fact. A fact whose retracting check has gone stands again, which is the
// state it was in before anyone judged it.
//
// The partial index is what makes the reader-side exclusions cheap — retracted
// facts are a handful in a corpus of thousands, and every aggregate now carries
// an `IS NULL` predicate.
export const SCHEMA_V52_FACT_RETRACTION = /* sql */ `
ALTER TABLE fact ADD COLUMN retracted_by_check_id INTEGER REFERENCES analysis_check(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ix_fact_retracted ON fact(retracted_by_check_id) WHERE retracted_by_check_id IS NOT NULL;
`

// ---------------------------------------------------------------- v59
// WHAT AN OUTSIDE INDEX SAID ABOUT A REFERENCE THIS PAPER PRINTED.
//
// A parse writes `unresolved_reference` rows carrying only what the bibliography
// printed. To be scored for relevance against a project, a reference needs an
// ABSTRACT, and no abstract is printed in a bibliography — it has to be fetched
// from OpenAlex or Crossref. That fetch is a claim by an index, not by the
// paper, so it is stored apart from the printed row for the same reason
// `references/external/types.ts` keeps `ExternalReference` apart from
// `ParsedReference`: widening the printed row into a record of what a third
// party believes lets one be mistaken for the other.
//
// THE FK IS NULLABLE, WITH ON DELETE SET NULL, AND THAT IS THE POINT.
// `unresolved_reference.id` is a bare INTEGER PRIMARY KEY, so SQLite REUSES a
// deleted row's id for the next insert — `citations/store.ts` documents this on
// `forgetUnresolvedEntry`, where the same hazard already bit. A row here still
// naming a dead id therefore does not dangle harmlessly: the next parse hands
// that id to a DIFFERENT bibliography entry, and this paper's abstract silently
// reappears under someone else's reference, reading perfectly. CASCADE would
// avoid that by destroying the record at the moment it succeeds — promotion
// deletes the unresolved row — so neither deleting nor keeping the id is right,
// and the FK is released instead.
//
// `citing_work_id` IS THE DURABLE ANCHOR. The reference belongs to a paper in
// this corpus whether or not it ever resolves, and that is also what the fetch
// job scopes by, so a row whose reference has been promoted or abandoned still
// tells the truth about which paper's bibliography was looked up and when.
// `work_id` is written at promotion and points at the real paper from then on.
//
// `outcome` HAS FOUR VALUES BECAUSE THERE ARE FOUR FACTS, and a boolean would
// merge three of them:
//   'found'                — an abstract, with `source` and `matched_by` saying
//                            which index answered and how it was matched.
//   'absent'               — the index HOLDS this paper and has no abstract for
//                            it. Permanent; asking again asks the same question.
//   'unreachable'          — HTTP failure, timeout, rate limit after backoff.
//                            The ONLY retryable outcome.
//   'nothing-to-ask-with'  — no DOI and no title good enough to search on. Only
//                            a better parse or a user-supplied identifier changes
//                            this; the network is irrelevant to it.
// Flattened to "no abstract", ONE network outage writes the permanent answer
// across an entire bibliography and suppresses retry forever. This is the same
// discipline `ExternalReferenceResult` states for reference lists, one level
// finer, because here the "we never asked" case is common rather than rare.
//
// `abstract`, `source` and `matched_by` are all nullable and are NULL together
// unless `outcome = 'found'`. None of them is defaulted when absent — a stored
// 'doi' on a row where no match happened is a guess wearing a measurement's
// clothes, which is the failure the `strategy` field exists to warn about.
//
// The two indexes serve the two reads that exist: the fetch job and the paper's
// reference panel both scope by `citing_work_id`, and promotion and the
// per-reference read look a row up by `unresolved_reference_id` — partial,
// because every promoted or abandoned row shares NULL there and none of them is
// ever fetched that way.
export const SCHEMA_V59_REFERENCE_ABSTRACT = /* sql */ `
CREATE TABLE IF NOT EXISTS reference_abstract (
  id                      INTEGER PRIMARY KEY,
  unresolved_reference_id INTEGER REFERENCES unresolved_reference(id) ON DELETE SET NULL,
  citing_work_id          INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  work_id                 INTEGER REFERENCES work(id) ON DELETE SET NULL,
  abstract                TEXT,
  source                  TEXT CHECK (source IN ('openalex','crossref')),
  matched_by              TEXT CHECK (matched_by IN ('doi','title')),
  outcome                 TEXT NOT NULL
                            CHECK (outcome IN (
                              'found','absent','unreachable','nothing-to-ask-with')),
  fetched_at              TEXT NOT NULL,
  error                   TEXT
);
CREATE INDEX IF NOT EXISTS ix_reference_abstract_citing
  ON reference_abstract(citing_work_id);
CREATE INDEX IF NOT EXISTS ix_reference_abstract_ref
  ON reference_abstract(unresolved_reference_id)
  WHERE unresolved_reference_id IS NOT NULL;
`

// ---------------------------------------------------------------- v60
// THE SAME TABLE, SAYING WHAT IT FETCHED AND HOW SURE IT IS.
//
// Everything argued at `SCHEMA_V59_REFERENCE_ABSTRACT` still holds; this is the
// shape that was designed and only partly built. What v59 could not say is the
// part a human needs when an abstract looks wrong:
//
// `doi` — THE IDENTIFIER ACTUALLY FETCHED AGAINST, normalised. Without it a row
// records which local reference it hangs off and nothing about what was asked
// for. `unresolved_reference.guessed_doi` is a guess and can be corrected by a
// later parse or by the user, at which point the stored abstract belongs to a
// question nobody can reconstruct.
//
// `matched_title` — WHAT THE INDEX CALLED THE PAPER. When the match was made on
// a title rather than a DOI, the only way anyone can check it is to read the
// title that came back beside the one that was sent. Without it a wrong
// abstract is not merely wrong, it is undiagnosable: it reads as fluently as a
// right one.
//
// `match_confidence` — HOW INFERRED AN INFERRED MATCH IS. A title match is
// accepted only above the gate, and the UI badges it as inferred; a badge that
// cannot say how close the match was is asking the reader to trust a number
// nobody kept. NULL MEANS MATCHED BY DOI — an identifier is either the same
// string or it is not, so there is no similarity to record and inventing 1.0
// would put a measurement's clothes on a certainty of a different kind.
//
// `fetcher_version` — WHICH RULES THIS ROW WAS ACCEPTED UNDER. The title gate
// will move. Without a version stamp, tightening it leaves every loose match
// already stored exactly where it is, silently blessed by rules that no longer
// exist; with one, the old cohort is identifiable and can be re-asked.
//
// THE UNIQUE PARTIAL INDEX is what makes "the abstract for this reference"
// a well-formed phrase. Nothing otherwise stops a second fetch inserting
// alongside the first, and two rows with different outcomes for one reference
// have no tie-breaker that is not arbitrary. Partial because promotion releases
// the FK to NULL (v59's argument) and many rows legitimately share that NULL.
//
// `outcome` GAINS 'ambiguous': a title search came back with more than one
// plausible paper and the gate refused to choose. That is not
// 'nothing-to-ask-with' — there WAS something to ask with, and the index
// answered. It is also the one outcome where retrying is legitimate without a
// network change, because a user correcting `guessed_title` alters the
// question. Folded into either neighbour, the retry rule loses the only case it
// applies to.
//
// THE VOCABULARY IS v59's, NOT THE DESIGN DOC'S. The doc wrote
// `ok|none|ambiguous|no-identifier|unreachable` and `match_method`; the table
// shipped `found|absent|unreachable|nothing-to-ask-with` and `matched_by`.
// Nothing reads or writes either yet, so this is a free choice, and it is
// settled on the shipped names: 'found'/'absent' say which of the two questions
// was answered ("is there an abstract" vs "does the index hold the paper")
// where 'ok'/'none' say only that something did or did not happen, and 'ok' in
// particular is a status word that will be read as "the fetch succeeded" — which
// is also true of 'absent'. 'nothing-to-ask-with' names the missing INPUT rather
// than a missing identifier, and the input can be a title as well as a DOI, so
// 'no-identifier' would be narrower than the condition it stands for. Keeping
// the shipped names also costs no rewrite of rows that exist and no second
// migration for the same field.
export const SCHEMA_V60_REFERENCE_ABSTRACT = /* sql */ `
CREATE TABLE reference_abstract (
  id                      INTEGER PRIMARY KEY,
  unresolved_reference_id INTEGER REFERENCES unresolved_reference(id) ON DELETE SET NULL,
  citing_work_id          INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  work_id                 INTEGER REFERENCES work(id) ON DELETE SET NULL,
  doi                     TEXT,
  matched_title           TEXT,
  abstract                TEXT,
  source                  TEXT CHECK (source IN ('openalex','crossref')),
  matched_by              TEXT CHECK (matched_by IN ('doi','title')),
  match_confidence        REAL,
  outcome                 TEXT NOT NULL
                            CHECK (outcome IN (
                              'found','absent','ambiguous','unreachable',
                              'nothing-to-ask-with')),
  fetcher_version         INTEGER NOT NULL DEFAULT 1,
  fetched_at              TEXT NOT NULL,
  error                   TEXT
);
CREATE INDEX ix_reference_abstract_citing
  ON reference_abstract(citing_work_id);
CREATE INDEX ix_reference_abstract_ref
  ON reference_abstract(unresolved_reference_id)
  WHERE unresolved_reference_id IS NOT NULL;
CREATE UNIQUE INDEX ux_reference_abstract_ref
  ON reference_abstract(unresolved_reference_id)
  WHERE unresolved_reference_id IS NOT NULL;
`

// ---------------------------------------------------------------- v61
// THE SAME TABLE, NAMING THE MATCH RULE THAT ACTUALLY RUNS.
//
// Everything argued at v59 and v60 still holds. One value changes:
// `matched_by` was `('doi','title')`, and 'title' names a gate that no longer
// exists. A reference with no DOI is now matched by handing its printed line to
// Crossref's reference matcher and checking the volume and first page that come
// back against the ones the bibliography itself printed — so what admitted the
// row is the whole bibliographic entry, not its title, and 'bibliographic' is
// what it must say.
//
// THE NAME IS NOT COSMETIC. `matched_by` is what a reader consults when an
// abstract looks wrong, and it is the difference between "this was accepted
// because two strings looked alike" and "this was accepted because a printed
// coordinate matched". Leaving the old word in place would describe every new
// row by the evidence of the rule it replaced; `fetcher_version` separates the
// COHORTS but cannot correct a column that names the wrong rule.
//
// SQLite cannot alter a CHECK, so this is v60's rebuild again, over v60's
// column list. Rows written under the old gate keep 'title': they really were
// admitted that way, and rewriting them would erase the only record that the
// corpus contains two kinds of evidence. The CHECK therefore admits all three,
// and only 'doi' and 'bibliographic' are ever written from here on.
export const SCHEMA_V61_REFERENCE_ABSTRACT = /* sql */ `
CREATE TABLE reference_abstract (
  id                      INTEGER PRIMARY KEY,
  unresolved_reference_id INTEGER REFERENCES unresolved_reference(id) ON DELETE SET NULL,
  citing_work_id          INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  work_id                 INTEGER REFERENCES work(id) ON DELETE SET NULL,
  doi                     TEXT,
  matched_title           TEXT,
  abstract                TEXT,
  source                  TEXT CHECK (source IN ('openalex','crossref')),
  matched_by              TEXT CHECK (matched_by IN ('doi','bibliographic','title')),
  match_confidence        REAL,
  outcome                 TEXT NOT NULL
                            CHECK (outcome IN (
                              'found','absent','ambiguous','unreachable',
                              'nothing-to-ask-with')),
  fetcher_version         INTEGER NOT NULL DEFAULT 1,
  fetched_at              TEXT NOT NULL,
  error                   TEXT
);
CREATE INDEX ix_reference_abstract_citing
  ON reference_abstract(citing_work_id);
CREATE INDEX ix_reference_abstract_ref
  ON reference_abstract(unresolved_reference_id)
  WHERE unresolved_reference_id IS NOT NULL;
CREATE UNIQUE INDEX ux_reference_abstract_ref
  ON reference_abstract(unresolved_reference_id)
  WHERE unresolved_reference_id IS NOT NULL;
`

// ---------------------------------------------------------------- v62
// THE SAME TABLE, SAYING WHICH QUESTION A ROW IS THE ANSWER TO.
//
// Everything argued at v59, v60 and v61 still holds. One column is added:
// `ask_key`, the printed identity of the paper a row was fetched for, so the
// next paper citing the same reference can find the answer instead of asking
// for it again.
//
// THE SAME PAPER IS CITED BY MANY OF OURS, and each bibliography stores it as
// its own `unresolved_reference` row. Measured on the live corpus: 798 whole
// entries, 571 printing a coordinate, 405 distinct — the most-cited appearing
// ten times. With no key to look up by, that is ten identical requests to a
// rate-limited public index for one answer.
//
// A ROW STILL EXISTS PER REFERENCE. This column deduplicates the QUESTION, not
// the record: every reference keeps its own row, so the UI can say what happened
// to that bibliography entry and `referenceAbstractsFor` returns the right set.
// Two rows carrying one `ask_key` and one answer is correct.
//
// THE KEY IS THE COORDINATE AND THE TITLE, NOT THE COORDINATE ALONE. The
// coordinate is what `bibliographicMatch` verifies on, which makes it tempting
// as the identity too, but a volume and first page are unique only WITHIN a
// journal: `66:5866` in this corpus is two different papers. Keyed on the
// coordinate alone, the answer fetched for the first would be handed to the
// second — attaching a DOI to a paper that does not have it, which is the one
// error this subsystem exists to refuse. Qualifying with the title the parser
// already extracted costs 58 of the 166 saved calls and buys back the identity.
// `bibliographicMatch` still verifies each fetched answer on the coordinate;
// this column only decides which rows may SHARE one.
//
// NULL MEANS NOT REUSABLE, never "not yet computed". A reference printing no
// coordinate has nothing to ask or match on, and one whose title the parser
// could not read has nothing to tell it from its coordinate-mates — both must
// ask for themselves. NULLs cannot collide, because the lookup requires a
// non-null key.
export const SCHEMA_V62_REFERENCE_ABSTRACT_ASK_KEY = /* sql */ `
ALTER TABLE reference_abstract ADD COLUMN ask_key TEXT;
CREATE INDEX ix_reference_abstract_ask_key
  ON reference_abstract(ask_key)
  WHERE ask_key IS NOT NULL;
`

// ============================================================ v63
// WHAT THE RELEVANCE SCORE WAS READ FROM.
//
// A cross-encoder scores a (question, passage) pair, so the number it returns is
// a statement about the text it was shown and about nothing else. A paper whose
// abstract we hold is scored on title AND abstract; a paper we hold only a title
// for is scored on that title. The second is SYSTEMATICALLY LOWER — there is
// simply less text for the question to match — and the two land in one sorted
// column, where 0.31 and 0.74 look like a verdict about the papers rather than
// about how much of each one the model got to read.
//
// So the column is not a diagnostic: it is the qualifier that makes the score
// readable. Without it the honest thing would be to refuse to score a paper with
// no abstract, which would hide the papers a user most needs to notice.
//
// NULL means NOT SCORED — no reranker packaged, or this paper has not been
// through the stage yet. It is deliberately not defaulted to 'title', which
// would state that a reading happened.
export const SCHEMA_V63_PROJECT_WORK_SCORED_ON = /* sql */ `
ALTER TABLE project_work ADD COLUMN scored_on TEXT;
`

// ============================================================ v65
// HOW RELEVANT EACH REFERENCE IS, AND TO WHOSE QUESTION.
//
// Expansion priority stops being a COUNT here and becomes a mean over these
// numbers, so a `reference_abstract` row has to be able to say how near the
// paper it names is to what a project asked.
//
// `scored_for_project_id` IS THE LOAD-BEARING COLUMN, and it is why this is
// three ALTERs rather than two. A reference belongs to a citing WORK, and a work
// sits in as many projects as the user puts it in — each with a different
// research question. "The relevance of this reference" is therefore not a
// property of the reference at all; it is a property of a (reference, question)
// pair, exactly as `project_work.relevance` is a property of a (paper, project)
// pair rather than of the paper. Storing a bare number here without saying whose
// question produced it is how a second project silently inherits the first
// one's ranking: the row would read as a fact about the paper, and a mean built
// from it would order project 2's bibliography by project 1's interests.
//
// So the row carries ONE score at a time and names the project it answers for.
// The alternative — one row per (reference, project) — cannot be reached by an
// ALTER: `ux_reference_abstract_ref` is UNIQUE on `unresolved_reference_id`,
// which is the index that makes "the abstract for this reference" a well-formed
// phrase, and widening it to a pair would mean a table rebuild and one fetched
// abstract duplicated per project. The abstract is genuinely a fact about the
// paper and belongs on one row; only the score is project-relative. A corpus
// where the same paper is ranked under several projects at once wants a separate
// (reference, project) score table, and that day this column is what tells the
// migration which project each existing number came from.
//
// NULL relevance means NOBODY SCORED IT — no reranker packaged, the project has
// not said what it is for, or the reference offers neither an abstract nor a
// usable title. Never 0: a 0 is a verdict, and no verdict was reached.
//
// `scored_on` mirrors `project_work.scored_on` for the same reason it exists
// there — 'title+abstract' and 'title' are systematically different reads, and a
// mean that mixes them owes the reader the ability to see which.
// ================================================ v69 — an index-supplied title
//
// Many citation styles print NO title — ACS, RSC, Angewandte and older JACS set
// a reference as authors, journal, year, volume, pages and nothing else. The
// indexes hold a real title for most of those papers, and these columns are
// where an adopted one goes.
//
// BESIDE the printed fields, never over them. "What the page says" and "what an
// index says" are different claims, and a reader may need to tell them apart —
// the same reason `raw_bib_text` is preserved verbatim.
//
// `index_title_from` records HOW the title was established ('corroborated' is
// its only legal value today). `index_title_rule_version` is what makes a bad
// vintage targetable: `UPDATE ... WHERE index_title_rule_version <= N` undoes
// one rule's output without touching a later one's, exactly as `analysis_run`
// carries `prompt_version`. Writing the title without them is how a corpus of
// wrong titles becomes unrollbackable.
export const SCHEMA_V69_INDEX_TITLE = /* sql */ `
ALTER TABLE unresolved_reference ADD COLUMN index_title TEXT;
ALTER TABLE unresolved_reference ADD COLUMN index_source TEXT;
ALTER TABLE unresolved_reference ADD COLUMN index_title_from TEXT;
ALTER TABLE unresolved_reference ADD COLUMN index_title_fetched_at TEXT;
ALTER TABLE unresolved_reference ADD COLUMN index_title_rule_version INTEGER;
`

export const SCHEMA_V65_REFERENCE_ABSTRACT_RELEVANCE = /* sql */ `
ALTER TABLE reference_abstract ADD COLUMN relevance REAL;
ALTER TABLE reference_abstract ADD COLUMN scored_on TEXT;
ALTER TABLE reference_abstract ADD COLUMN scored_for_project_id INTEGER;
`
