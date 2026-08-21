// The project-setup lifecycle, end to end against a real database.
//
// Runs via electron-as-node (same better-sqlite3 ABI as the app) on a FRESH
// throwaway DB, because it mutates: it creates a project, answers its
// questionnaire, and finishes it.
//
// WHAT IT IS GUARDING. The questionnaire has no exit — a project reaches its own
// screens by completing this and by nothing else — so two failures here are
// unrecoverable for a user rather than merely wrong:
//
//   * `setup_state` advancing before the context is actually built would leave a
//     project that says it is ready with nothing behind it, and no form left to
//     fix it in.
//   * `description` failing to recompose from the goal and questions would send
//     every prompt in that project a stale or empty account of what it is for,
//     silently, with the right words still visible in the form.
//
// Run: npm run verify:setup

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { initDatabase, setDb, closeDb } from '../src/main/db/connection'
import { seed } from '../src/main/db/seed'
import { DOSSIER_PAPER_LIMIT } from '../src/shared/contract'
import {
  createProjectRow,
  getProject,
  listProjects,
  updateProjectSetupRow,
  markProjectSetupDone,
  composeProjectDescription,
  listProjectWorks,
  markReferencePaper,
  getDossierStatus
} from '../src/main/db/repositories'

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

function main(): void {
  const explicit = process.env.CORPUS_DB_PATH
  const dbFile =
    explicit && explicit.trim()
      ? explicit
      : join(tmpdir(), `corpus-verify-setup-${process.pid}-${Date.now()}.sqlite`)
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbFile + suffix
    if (existsSync(p)) rmSync(p)
  }
  mkdirSync(dirname(dbFile), { recursive: true })

  const db = initDatabase(dbFile)
  setDb(db)
  seed(db, { now: process.env.CORPUS_FAKE_NOW })
  const now = '2026-08-19T00:00:00.000Z'

  try {
    // ---- the seeded corpus is NOT dragged into a questionnaire -----------
    //
    // The negative control for the migration's column default. Getting this
    // wrong reopens a form in front of every project already in a library.
    const seeded = listProjects(db)
    check(
      'projects that predate the questionnaire are already done',
      seeded.length > 0 && seeded.every((p) => p.setup_state === 'done'),
      seeded.map((p) => `${p.name}=${p.setup_state}`).join(', ')
    )
    check(
      'a project with no questionnaire reports no questions rather than failing',
      seeded.every((p) => Array.isArray(p.questions) && p.questions.length === 0)
    )

    // ---- creation ---------------------------------------------------------
    const pid = createProjectRow(
      db,
      { name: 'Kemp eliminase productivity', description: '', onboarding: true },
      now
    )
    const created = getProject(db, pid)
    check('a project created for onboarding starts in onboarding', created?.setup_state === 'onboarding')
    check('it starts with no goal and no questions', created?.goal === null && created?.questions.length === 0)

    // The DEFAULT matters as much: an archive import and a shared project both
    // create rows this way, and neither must be stranded behind a form.
    const plainId = createProjectRow(db, { name: 'Imported thing', description: 'x' }, now)
    check('a project created WITHOUT onboarding is done', getProject(db, plainId)?.setup_state === 'done')

    // ---- answering, one blur at a time ------------------------------------
    updateProjectSetupRow(db, { projectId: pid, goal: 'Explore kemp eliminase chemistry' }, now)
    const afterGoal = getProject(db, pid)
    check('the goal is stored', afterGoal?.goal === 'Explore kemp eliminase chemistry')
    check(
      'a goal alone composes a description with no empty question heading',
      afterGoal?.description === 'Explore kemp eliminase chemistry',
      JSON.stringify(afterGoal?.description)
    )

    // A blur that sends ONLY the questions must still compose against the goal
    // already stored — this is the drift the composition is written to prevent.
    updateProjectSetupRow(
      db,
      {
        projectId: pid,
        questions: ['What is the kinetic rate?', '  ', 'Which mutant is most productive?']
      },
      now
    )
    const afterQ = getProject(db, pid)
    check(
      'blank question rows are not stored as answers',
      afterQ?.questions.length === 2,
      JSON.stringify(afterQ?.questions)
    )
    check(
      'a partial write recomposes against the stored goal, not an empty one',
      afterQ?.description ===
        composeProjectDescription('Explore kemp eliminase chemistry', [
          'What is the kinetic rate?',
          'Which mutant is most productive?'
        ]),
      JSON.stringify(afterQ?.description)
    )
    check(
      'the composed description carries both halves',
      (afterQ?.description ?? '').includes('Explore kemp eliminase chemistry') &&
        (afterQ?.description ?? '').includes('Which mutant is most productive?')
    )
    check('answering does not finish setup', afterQ?.setup_state === 'onboarding')

    // Renaming from the form's own name field — the remedy for a mistyped name,
    // which is the only reason this page needs an escape at all.
    updateProjectSetupRow(db, { projectId: pid, name: 'Kemp eliminases' }, now)
    check('the name can be corrected from the form', getProject(db, pid)?.name === 'Kemp eliminases')
    check(
      'renaming leaves the description alone',
      getProject(db, pid)?.description === afterQ?.description
    )

    // ---- finishing --------------------------------------------------------
    //
    // Against the SEEDED project, which has papers — the real finish path marks
    // every paper in the project as a reference and then builds. The build
    // itself calls a model and is exercised by verify-backend; what is asserted
    // here is the bookkeeping around it, which is what strands a user.
    const seededId = seeded[0].id
    const works = listProjectWorks(db, seededId)
    check('the seeded project has papers to finish over', works.length > 0, `${works.length}`)
    // The SAME slice `finishSetup` takes, so this asserts what the app does
    // rather than what it did before the limit existed. Looping every paper
    // would now THROW past the twentieth — the seed corpus is exactly twenty,
    // so the old assertion passed on one row of luck and would have broken the
    // gate the moment the corpus grew.
    const chosen = works.slice(0, DOSSIER_PAPER_LIMIT)
    for (const w of chosen) markReferencePaper(db, seededId, w.work.id, true, now)
    const status = getDossierStatus(db, seededId)
    check(
      'setup fills the project context up to the limit',
      status.references.length === chosen.length,
      `${status.references.length} of ${chosen.length} (imported ${works.length})`
    )
    // The limit is a ceiling, so one more must be refused rather than silently
    // ignored — a limit that only the button draws is not a limit.
    if (works.length > DOSSIER_PAPER_LIMIT) {
      let refused = false
      try {
        markReferencePaper(db, seededId, works[DOSSIER_PAPER_LIMIT].work.id, true, now)
      } catch {
        refused = true
      }
      check('a paper past the limit is refused', refused, refused ? 'refused' : 'accepted')
    }

    markProjectSetupDone(db, seededId, now)
    check('the project is done once the build has returned', getProject(db, seededId)?.setup_state === 'done')
    check(
      'finishing one project does not finish another',
      getProject(db, pid)?.setup_state === 'onboarding'
    )

    // ---- an unrecognised state must never TRAP ----------------------------
    //
    // A row hand-edited, half-migrated or written by a future version reads as
    // 'done'. The opposite default would show a questionnaire with no exit over
    // a project that has one.
    db.prepare("UPDATE project SET setup_state = 'something-else' WHERE id = ?").run(plainId)
    check(
      'an unrecognised setup_state reads as done rather than trapping the user',
      getProject(db, plainId)?.setup_state === 'done'
    )
  } finally {
    closeDb()
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
  }

  // eslint-disable-next-line no-console
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main()
