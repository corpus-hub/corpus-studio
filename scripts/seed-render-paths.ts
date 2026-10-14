// TEST-ONLY fixture for render paths the demo corpus cannot reach. NOT a
// corpus, and never shipped.
//
// Two surfaces of the Paper screen distinguish provenance the reader must be
// able to tell apart, and neither has data on the demo DB:
//   1. role_source — a rule's cue versus a model's judgement (below).
//   2. run scope   — a GLOBAL (project 0) run versus a project one (below).
// Both render paths are real product code. Without a fixture their assertions
// could only be deleted, which would retire the guard rather than satisfy it.
//
// WHY THIS EXISTS — role provenance
//
// `role_source` is the whole point of the citation-role feature: a regex match
// and a calibrated model must never be ranked against each other as though they
// were the same kind of claim. The Paper screen renders the two differently — a
// rule shows its CUE, a model judgement says it was a model — and an
// unclassified context must read as an ABSENCE rather than as the
// positive `other` class.
//
// The demo seed ships NO roles, deliberately and correctly: a role belongs to an
// INLINE occurrence, a specific sentence at a specific offset in a specific PDF,
// and that sentence is the citing author's prose. It cannot be derived from
// corpus metadata — only the `citation-contexts` stage reading the document
// produces it. So on the demo DB every context is unclassified, and the two
// classified render paths have no data to exercise.
//
// This fixture supplies that data WITHOUT fabricating a corpus:
//   - It classifies contexts the demo seed already created. No work, no edge and
//     no citation text is invented; only the role columns are written.
//   - It writes exactly the shapes the real stage writes — a `rule` row carries
//     a `role_cue`, an `llm` row carries no cue — so a drift in either shape fails the test rather than passing it.
//   - The rest stay unclassified, which is what the real stage leaves behind:
//     on a parsed corpus the unclassified residue is the MAJORITY case.
//   - Nothing here reaches the app. It lives under `scripts/`, outside `src/`
//     and outside the electron-vite build graph, like every other seed.
//
// WHY THIS EXISTS — global run scope
//
// `analysis_run.project_id = 0` is the GLOBAL sentinel: an analysis that is
// about the paper itself, shared by every project, made with no project
// context. The Paper screen marks such a run distinctly, because presenting a
// context-free result as a project-informed one misrepresents what was asked.
//
// No stage currently emits one — every stage is document, project or corpus
// scoped — so the demo corpus contains only project runs and the global branch
// has nothing to render. The sentinel and its branch are load-bearing (they are
// why project_id is 0 rather than NULL: SQLite treats NULLs as distinct in the
// one-current-run unique index), so the branch is asserted against a run that
// SUPERSEDES nothing and CLAIMS nothing: it carries no facts, its provider
// names this script, its verifier reads 'not-run' and its `run_origin` is
// 'imported', because no model produced it and 'local' would assert that one
// did. What is under test is the SCOPE label, and that is all it asserts.
//
//   ELECTRON_RUN_AS_NODE=1 electron --import tsx scripts/seed-render-paths.ts
//
// Honors CORPUS_DB_PATH (always fresh — the DB is recreated).

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { initDatabase, setDb, closeDb, type DB } from '../src/main/db/connection'
import { seed } from '../src/main/db/seed'

const NOW = process.env.CORPUS_FAKE_NOW ?? '2026-01-01T00:00:00Z'

/** The paper whose screen the role spec opens. */
export const ROLES_WORK_ID = 2

/** The paper whose screen the global-scope spec opens. */
export const GLOBAL_WORK_ID = 1

/** Names itself, so the row cannot be mistaken for a stage verdict. */
const CUE = 'fixture-cue-support'

function dbPath(): string {
  const base = process.env.CORPUS_DB_PATH
  if (base && base.trim()) return base
  return join(process.cwd(), '.corpus-data', 'corpus-render-paths.sqlite')
}

function seedRenderPaths(db: DB): void {
  const now = NOW
  seed(db, { now })

  const run = db.transaction(() => {
    const contexts = db
      .prepare(
        `SELECT id FROM citation_context
          WHERE citing_work_id = ? AND role IS NULL
          ORDER BY id ASC`
      )
      .all(ROLES_WORK_ID) as { id: number }[]

    // Three is the minimum that leaves a genuine unclassified residue after
    // taking one for each classified shape. Fewer means the demo seed changed
    // under this fixture, which must fail loudly rather than silently produce a
    // DB where the spec's assertions cannot run.
    if (contexts.length < 3) {
      throw new Error(
        `seed-render-paths: work ${ROLES_WORK_ID} has ${contexts.length} unclassified contexts, need >= 3`
      )
    }

    // A DETERMINISTIC rule verdict: names the cue that fired, stores no
    // probability, because a regex has none to report.
    db.prepare(
      `UPDATE citation_context
          SET role = 'support', role_source = 'rule', role_cue = ?
        WHERE id = ?`
    ).run(CUE, contexts[0].id)

    // A MODEL judgement: carries no cue, because nothing mechanical fired — a classifier weighed the sentence.
    db.prepare(
      `UPDATE citation_context
          SET role = 'contrast', role_source = 'llm', role_cue = NULL
        WHERE id = ?`
    ).run(contexts[1].id)

    // Everything from contexts[2] on stays NULL: the honest majority state.

    // ── the GLOBAL (project 0) run ──────────────────────────────────────────
    // Deliberately schema_id 0: the generic slot, so this cannot collide with
    // either per-schema current run on the same work.
    const existing = db
      .prepare(
        `SELECT COUNT(*) c FROM analysis_run WHERE work_id = ? AND project_id = 0`
      )
      .get(GLOBAL_WORK_ID) as { c: number }
    if (existing.c !== 0) {
      throw new Error(
        `seed-render-paths: work ${GLOBAL_WORK_ID} already has a global run; the demo seed changed`
      )
    }
    db.prepare(
      `INSERT INTO analysis_run
         (work_id, project_id, schema_id, analysis_type, model, provider, prompt_version,
          schema_version, run_timestamp, verifier_result, deterministic_validation,
          superseded, run_origin, origin_note, created_at)
       VALUES (@wid, 0, 0, 'summary', 'none', 'render-path-fixture', 'v1', 's1', @now,
               'not-run', 0, 0, 'imported',
               'Scope-label fixture from scripts/seed-render-paths.ts. No model produced this and it carries no facts.',
               @now)`
    ).run({ wid: GLOBAL_WORK_ID, now })
  })
  run()
}

function main(): void {
  const p = dbPath()
  mkdirSync(dirname(p), { recursive: true })
  for (const suffix of ['', '-wal', '-shm']) {
    const f = p + suffix
    if (existsSync(f)) rmSync(f)
  }
  const db = initDatabase(p)
  setDb(db)
  seedRenderPaths(db)
  closeDb()
  // eslint-disable-next-line no-console
  console.log(`[seed-render-paths] ok -> ${p}`)
}

main()
