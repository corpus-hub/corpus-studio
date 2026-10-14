// A run that never got an answer must not retire the run that did.
//
// Run via:
//   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron node_modules/.bin/tsx \
//     --test src/main/llm/supersede.test.ts
//
// The failure these pin down cost this corpus 305 facts. A provider or parse
// blow-up was suppressed, stamped `verifier_result = 'failed'` and persisted as
// a run with zero facts; the persist transaction's unconditional
// supersede-then-insert retired the previous run that HAD read the paper, and
// `schema-extract` — which decides its status by fact count alone — reported the
// whole thing `succeeded`. Work 9 went 27 facts to 0 that way, work 13 27 to 0,
// work 10 24 to 0.
//
// What must still work is the honest empty run: a model that read the paper and
// reports it carries nothing for this schema IS a finding, and it must supersede.
// The discriminator is therefore whether a validated answer was obtained at all,
// never the fact count and never the elapsed time.
//
// TWO INDEPENDENT DEFENCES, AND WHY EACH NEEDS ITS OWN TEST.
//
// A: the catch-all around the model call rethrows as `AnalysisUnusableError`
//    instead of suppressing into `verifier = 'failed'; facts = []`.
// B: the guard before the persist transaction refuses `failed` / `not-run`.
//
// They are in SERIES on the same path, so B catches everything A would have let
// through and vice versa. An earlier version of this file asserted only "the
// good run survived", which is true whenever EITHER defence holds — so removing
// one defence alone changed nothing observable and the suite passed on code
// carrying the original bug verbatim. Both mutations were tried; both were green.
//
// The discriminator that separates them is WHICH message comes back, because
// only B can produce its own text. `DEFENCE_B_MARKER` is matched by identity
// against the string `pipeline.ts` throws.
//
// WHAT IS AND IS NOT PINNED, stated plainly rather than implied by a test name:
//
//   A is pinned by mutation. Suppressing the catch-all back into
//   `verifier = 'failed'; facts = []` FAILS `DEFENCE A: a provider blow-up …`,
//   because the refusal then arrives carrying B's wording instead of the
//   provider's.
//
//   B CANNOT BE PINNED BY REMOVING B ALONE, and no test here claims to. B sits
//   behind A on the same path, so on healthy code nothing ever reaches it and
//   `if (false)` changes no observable behaviour — verified: all five still
//   pass under that mutation. B is a backstop assertion, and an unreachable
//   backstop is what it is supposed to be. What DOES demonstrate B is live is
//   the mutation-A run: with A suppressed, the run is stopped anyway and the
//   message that comes back is B's own, quoted in that test's failure. The
//   tests below therefore assert B's INVARIANT over the table — no `failed` or
//   `not-run` run is ever current — rather than pretending to detect its
//   removal.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type Database from 'better-sqlite3'
import { initDatabase, closeDatabase } from '../db/connection'
import { runPipeline, isAnalysisUnusable } from './pipeline'
import type { LlmProvider, LlmMessage } from './provider'
import { TruncatedLlmError } from './provider'

const NOW = '2026-01-01T00:00:00.000Z'

/**
 * The text only defence B writes. If the pipeline reaches persist with a
 * verifier that obtained no answer, this is what comes back; if defence A
 * stopped it earlier, the message is the provider's own and this is absent.
 */
const DEFENCE_B_MARKER = 'reached persist with verifier_result'

/** Answers one fixed string, or throws one fixed error, every time. */
class FixedProvider implements LlmProvider {
  readonly name = 'fixed-test-fixture'
  readonly model = 'fixed-test-fixture'
  constructor(private readonly answer: string | Error) {}
  async callLLM(_messages: LlmMessage[]): Promise<string> {
    if (this.answer instanceof Error) throw this.answer
    return this.answer
  }
}

interface Fixture {
  db: Database.Database
  dir: string
}

function open(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'corpus-supersede-'))
  // Through `initDatabase`, not a bare `new Database`: the pipeline's persist
  // path calls SQL functions this app registers per connection, so a
  // hand-opened handle fails on `canonical_unit` long before reaching anything
  // these tests are about.
  const db = initDatabase(join(dir, 'corpus.sqlite'), { label: 'supersede.test' })
  db.prepare(
    `INSERT INTO work (id, title, work_type, publication_year, created_at, updated_at)
     VALUES (1, 'A paper', 'journal-article', 2020, ?, ?)`
  ).run(NOW, NOW)
  return { db, dir }
}

function close(f: Fixture): void {
  closeDatabase(f.db)
  rmSync(f.dir, { recursive: true, force: true })
}

/** The one current run for this key, with how many facts it holds. */
function current(db: Database.Database): { id: number; facts: number; verifier: string } | null {
  const row = db
    .prepare(
      `SELECT r.id, r.verifier_result AS verifier,
              (SELECT COUNT(*) FROM fact WHERE analysis_run_id = r.id) AS facts
         FROM analysis_run r
        WHERE r.work_id = 1 AND r.project_id = 0 AND r.analysis_type = 'extraction'
          AND r.superseded = 0`
    )
    .get() as { id: number; facts: number; verifier: string } | undefined
  return row ?? null
}

/** Every analysis_run row, so a test can say "no row was written at all". */
function allRuns(db: Database.Database): { id: number; verifier: string; superseded: number }[] {
  return db
    .prepare('SELECT id, verifier_result AS verifier, superseded FROM analysis_run ORDER BY id')
    .all() as { id: number; verifier: string; superseded: number }[]
}

const DOC = [
  'The purified enzyme was assayed at pH 7.4.',
  '',
  'The catalytic turnover was 12.5 per second under standard conditions.'
].join('\n')

/** An answer holding one anchorable fact. */
const POPULATED = JSON.stringify({
  facts: [
    {
      kind: 'directly-reported',
      predicate: 'turnover',
      value_text: '12.5 per second',
      value_num: 12.5,
      unit: 's^-1',
      anchor_quote: 'The catalytic turnover was 12.5 per second',
      paragraph: 1
    }
  ]
})

/** The model, having read the paper, reports it carries nothing. */
const HONESTLY_EMPTY = JSON.stringify({ facts: [] })

async function seedPopulated(db: Database.Database): Promise<number> {
  const res = await runPipeline(
    db,
    new FixedProvider(POPULATED),
    { workId: 1, projectId: 0, analysisType: 'extraction', docText: DOC },
    NOW
  )
  assert.equal(res.verifierResult, 'passed')
  assert.ok(res.factCount > 0, 'the fixture run must actually hold facts')
  return res.analysisRunId
}

/**
 * Run a doomed attempt and return what came back, having first checked that the
 * good run is intact. Returns the error message so a caller can say WHICH
 * defence answered.
 */
async function attemptAgainst(
  f: Fixture,
  answer: string | Error,
  good: number
): Promise<string> {
  const before = current(f.db)!.facts
  let message = ''
  await runPipeline(
    f.db,
    new FixedProvider(answer),
    { workId: 1, projectId: 0, analysisType: 'extraction', docText: DOC },
    NOW
  ).then(
    () => assert.fail('the doomed attempt resolved instead of refusing'),
    (err: unknown) => {
      assert.ok(isAnalysisUnusable(err), `expected AnalysisUnusableError, got ${String(err)}`)
      message = (err as Error).message
    }
  )

  // The property the user actually cares about, asserted on the DATABASE.
  const now = current(f.db)
  assert.equal(now?.id, good, 'the run that read the paper is still the current one')
  assert.equal(now?.facts, before, 'and it still holds every fact it held')
  const runs = allRuns(f.db)
  assert.equal(runs.length, 1, 'the failed attempt wrote no analysis_run at all')
  assert.equal(runs[0]!.superseded, 0, 'and the good run was never marked superseded')
  return message
}

test('DEFENCE A: a provider blow-up is refused before it can reach persist', async () => {
  const f = open()
  try {
    const good = await seedPopulated(f.db)
    const msg = await attemptAgainst(f, new Error('socket hang up'), good)

    // The whole point of this test. If A is removed, the blow-up is suppressed
    // into `verifier = 'failed'; facts = []` and travels on to B, which refuses
    // it with ITS OWN wording — the good run still survives, so every assertion
    // above still holds and only this one can tell that A is gone.
    assert.ok(
      !msg.includes(DEFENCE_B_MARKER),
      `the catch-all must refuse this itself, not leave it to the persist guard; got: ${msg}`
    )
    assert.ok(
      msg.includes('socket hang up'),
      `and the reason the user reads must be the provider's own; got: ${msg}`
    )
  } finally {
    close(f)
  }
})

test('DEFENCE A: an answer cut off before one complete record is refused too', async () => {
  const f = open()
  try {
    const good = await seedPopulated(f.db)
    // A guillotine that landed inside the first record: `salvageFacts` recovers
    // nothing, so this is not a partial reading, it is no reading.
    const msg = await attemptAgainst(
      f,
      new TruncatedLlmError(4096, '{"facts": [{"kind": "directly-rep'),
      good
    )
    assert.ok(
      !msg.includes(DEFENCE_B_MARKER),
      `the truncation branch must refuse this itself; got: ${msg}`
    )
    assert.ok(
      msg.includes('cut off before a single complete record'),
      `and must say the answer was cut off, not restate it as a verifier value; got: ${msg}`
    )
  } finally {
    close(f)
  }
})

test("INVARIANT: no run with a verifier that obtained no answer is ever current", async () => {
  const f = open()
  try {
    const good = await seedPopulated(f.db)
    await attemptAgainst(f, new Error('ECONNRESET'), good)

    // The exact condition the 305-fact loss violated, asserted over the table.
    // Not a mutation detector for B — A stops the attempt first — but the
    // standing property both defences exist to hold.
    const bad = f.db
      .prepare(
        `SELECT COUNT(*) AS c FROM analysis_run
          WHERE superseded = 0 AND verifier_result IN ('failed', 'not-run')`
      )
      .get() as { c: number }
    assert.equal(bad.c, 0)
    assert.equal(current(f.db)?.id, good)
  } finally {
    close(f)
  }
})

test('INVARIANT: no failure mode, by any door, leaves a zero-fact run current', async () => {
  const f = open()
  try {
    const good = await seedPopulated(f.db)

    // Three DIFFERENT exits, to show the property does not depend on which one
    // a failure takes: a transport blow-up (the catch-all), a reply that is not
    // JSON and a reply that is JSON but violates the schema (both exhaust the
    // repair loop and leave by `SchemaRepairExhaustedError`).
    for (const answer of [
      new Error('ECONNRESET'),
      'not json at all',
      '{"facts": [{"kind": "not-a-kind"}]}'
    ] as (string | Error)[]) {
      await runPipeline(
        f.db,
        new FixedProvider(answer),
        { workId: 1, projectId: 0, analysisType: 'extraction', docText: DOC },
        NOW
      ).catch(() => undefined)

      const now = current(f.db)
      assert.equal(now?.id, good, 'the good run stayed current through every failure mode')
      assert.ok((now?.facts ?? 0) > 0, 'and never lost its facts')
    }
    assert.equal(allRuns(f.db).length, 1, 'and not one failed attempt was filed')
  } finally {
    close(f)
  }
})

test('a model that read the paper and found nothing DOES supersede', async () => {
  const f = open()
  try {
    const good = await seedPopulated(f.db)
    const res = await runPipeline(
      f.db,
      new FixedProvider(HONESTLY_EMPTY),
      { workId: 1, projectId: 0, analysisType: 'extraction', docText: DOC },
      NOW
    )
    assert.equal(res.factCount, 0)
    assert.equal(res.verifierResult, 'passed')
    assert.equal(res.modelReturnedNothing, true)

    const now = current(f.db)
    assert.equal(now?.id, res.analysisRunId, 'the honest empty reading is now current')
    assert.notEqual(now?.id, good)
    const sup = f.db
      .prepare('SELECT superseded FROM analysis_run WHERE id = ?')
      .get(good) as { superseded: number }
    assert.equal(sup.superseded, 1, 'and the earlier run was retired by it')
  } finally {
    close(f)
  }
})
