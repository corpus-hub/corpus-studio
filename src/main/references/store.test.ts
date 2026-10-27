// What a `reference_abstract` row must survive, asserted on the transitions
// rather than on a happy-path insert.
//
// Each test here stands for a way the corpus starts lying about an abstract: a
// retry that appends instead of replacing leaves two answers with nothing but a
// timestamp to choose between; a promotion that does not carry the row destroys
// the provenance at the moment the abstract becomes visible; and a title-matched
// paragraph copied into `work.abstract` — a column with no provenance beside it
// — becomes indistinguishable from what the paper itself printed.
//
// better-sqlite3 is built against Electron's ABI here, so this runs under
// `ELECTRON_RUN_AS_NODE=1 electron --import tsx --test`, not bare `tsx`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import type { DB } from '../db/connection'
import {
  SCHEMA_V61_REFERENCE_ABSTRACT,
  SCHEMA_V62_REFERENCE_ABSTRACT_ASK_KEY,
  SCHEMA_V65_REFERENCE_ABSTRACT_RELEVANCE
} from '../db/schema'
import { promoteReferenceEntry } from '../citations/store'
import { abstractByAskKey, recordReferenceAbstract, referenceAbstractsFor } from './store'
import { ABSTRACT_FETCHER_VERSION } from './external/abstracts'
import { meanReferenceRelevance, scoringSets } from '../rerank/store'

/**
 * The narrowest DB the functions under test can run against.
 *
 * Only the columns they read: a wider copy of the real schema would drift from
 * it silently, and the migration is verified elsewhere. `foreign_keys` is ON
 * because the `ON DELETE SET NULL` is the behaviour half these tests assert.
 */
function makeDb(): DB {
  const db = new Database(':memory:') as unknown as DB
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE work (
      id INTEGER PRIMARY KEY,
      title TEXT,
      abstract TEXT
    );
    CREATE TABLE unresolved_reference (
      id INTEGER PRIMARY KEY,
      citing_work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
      raw_bib_text TEXT,
      -- Counted by scoringSets, which excludes the lettered parts of a
      -- composite entry so one publisher's typesetting does not inflate a
      -- bibliography. A fixture without it cannot exercise that query at all.
      part_label TEXT
    );
    CREATE TABLE citation_edge (
      id INTEGER PRIMARY KEY,
      citing_work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
      cited_work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
      edge_type TEXT NOT NULL
    );
    CREATE TABLE citation_context (
      id INTEGER PRIMARY KEY,
      edge_id INTEGER REFERENCES citation_edge(id) ON DELETE CASCADE,
      unresolved_reference_id INTEGER REFERENCES unresolved_reference(id) ON DELETE CASCADE
    );
  `)
  // The table at its CURRENT shape, not the version it was introduced at: a
  // fixture pinned to an older constant tests a schema no install has.
  db.exec(SCHEMA_V61_REFERENCE_ABSTRACT)
  db.exec(SCHEMA_V62_REFERENCE_ABSTRACT_ASK_KEY)
  db.exec(SCHEMA_V65_REFERENCE_ABSTRACT_RELEVANCE)
  return db
}

const LONG = 'A thermostable variant retained ninety percent of its activity after two hours.'

function seedCiting(db: DB): { citing: number; ref: number } {
  db.prepare('INSERT INTO work (id, title, abstract) VALUES (1, ?, NULL)').run('The citing paper')
  db.prepare(
    'INSERT INTO unresolved_reference (id, citing_work_id, raw_bib_text) VALUES (10, 1, ?)'
  ).run('Smith et al. 2019')
  return { citing: 1, ref: 10 }
}

function countRows(db: DB): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM reference_abstract').get() as { n: number }).n
}

test('re-fetching the same reference replaces its row rather than appending one', () => {
  const db = makeDb()
  const { citing, ref } = seedCiting(db)

  const first = recordReferenceAbstract(db, {
    unresolvedReferenceId: ref,
    citingWorkId: citing,
    outcome: 'absent',
    doi: '10.1/a'
  })
  const second = recordReferenceAbstract(db, {
    unresolvedReferenceId: ref,
    citingWorkId: citing,
    outcome: 'found',
    doi: '10.1/a',
    abstract: LONG,
    source: 'openalex',
    matchedBy: 'doi'
  })

  assert.equal(first, second, 'the upsert wrote a second row instead of updating the first')
  assert.equal(countRows(db), 1)
  const rows = referenceAbstractsFor(db, citing)
  assert.equal(rows[0].outcome, 'found')
  assert.equal(rows[0].abstract, LONG)
})

test('an ask_key written is an ask_key another paper can find', () => {
  const db = makeDb()
  const { citing, ref } = seedCiting(db)
  const key = '108:6823|designofaswitchableeliminase'

  recordReferenceAbstract(db, {
    unresolvedReferenceId: ref,
    citingWorkId: citing,
    outcome: 'found',
    doi: '10.1073/pnas.1018191108',
    matchedTitle: 'Design of a switchable eliminase',
    abstract: LONG,
    source: 'crossref',
    matchedBy: 'bibliographic',
    askKey: key
  })

  // The whole point of the column: the NEXT paper citing this one asks nothing.
  // The write once accepted `askKey` and dropped it before the INSERT, so every
  // lookup missed and the corpus re-asked a question it had already answered.
  const hit = abstractByAskKey(db, key, ABSTRACT_FETCHER_VERSION)
  assert.ok(hit, 'the key was not stored, so no other paper can reuse this answer')
  assert.equal(hit?.abstract, LONG)
  assert.equal(referenceAbstractsFor(db, citing)[0].askKey, key)

  // A row admitted under a different rule is not evidence about this one.
  assert.equal(abstractByAskKey(db, key, ABSTRACT_FETCHER_VERSION + 1), null)
})

test('only a found row is reusable — absent and unreachable are re-asked', () => {
  const db = makeDb()
  const { citing, ref } = seedCiting(db)
  const key = '34:938|thedepthofchemicaltime'

  for (const outcome of ['absent', 'unreachable'] as const) {
    recordReferenceAbstract(db, {
      unresolvedReferenceId: ref,
      citingWorkId: citing,
      outcome,
      askKey: key
    })
    assert.equal(
      abstractByAskKey(db, key, ABSTRACT_FETCHER_VERSION),
      null,
      `${outcome} was served from cache, freezing one afternoon's network into a fact`
    )
  }
})

test('an unreachable row is retryable — a later found replaces it', () => {
  const db = makeDb()
  const { citing, ref } = seedCiting(db)

  recordReferenceAbstract(db, {
    unresolvedReferenceId: ref,
    citingWorkId: citing,
    outcome: 'unreachable',
    doi: '10.1/a',
    error: 'the index did not answer'
  })
  assert.equal(referenceAbstractsFor(db, citing)[0].error, 'the index did not answer')

  recordReferenceAbstract(db, {
    unresolvedReferenceId: ref,
    citingWorkId: citing,
    outcome: 'found',
    doi: '10.1/a',
    abstract: LONG,
    source: 'crossref',
    matchedBy: 'doi'
  })

  const rows = referenceAbstractsFor(db, citing)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].outcome, 'found')
  assert.equal(rows[0].error, null, 'the failure sentence outlived the failure')
})

test('an absent row records the fact and is not an abstract', () => {
  const db = makeDb()
  const { citing, ref } = seedCiting(db)

  recordReferenceAbstract(db, {
    unresolvedReferenceId: ref,
    citingWorkId: citing,
    outcome: 'absent',
    doi: '10.1/a',
    matchedTitle: 'A paper the index holds without an abstract'
  })

  const [row] = referenceAbstractsFor(db, citing)
  assert.equal(row.outcome, 'absent')
  assert.equal(row.abstract, null)
  assert.equal(row.source, null)
  assert.equal(row.matchedBy, null)
  assert.equal(row.error, null, 'an answered question was recorded as a failure')
})

test('nothing-to-ask-with is stored, so the reference is not asked about again', () => {
  const db = makeDb()
  const { citing, ref } = seedCiting(db)

  recordReferenceAbstract(db, {
    unresolvedReferenceId: ref,
    citingWorkId: citing,
    outcome: 'nothing-to-ask-with'
  })

  const [row] = referenceAbstractsFor(db, citing)
  assert.equal(row.outcome, 'nothing-to-ask-with')
  assert.equal(row.doi, null)
  assert.equal(row.abstract, null)
})

test('the fetcher version is stamped from the fetcher, not from the caller', () => {
  const db = makeDb()
  const { citing, ref } = seedCiting(db)
  recordReferenceAbstract(db, {
    unresolvedReferenceId: ref,
    citingWorkId: citing,
    outcome: 'absent'
  })
  assert.equal(typeof referenceAbstractsFor(db, citing)[0].fetcherVersion, 'number')
})

/** Promote reference 10 to work 2, exactly as the sweep does. */
function promote(db: DB, opts: { abstract?: string; matchedBy?: 'doi' | 'title' } = {}): void {
  db.prepare('INSERT INTO work (id, title, abstract) VALUES (2, ?, NULL)').run('The cited paper')
  db.prepare(
    'INSERT INTO citation_edge (id, citing_work_id, cited_work_id, edge_type) VALUES (5, 1, 2, ?)'
  ).run('cites')
  if (opts.abstract !== undefined) {
    recordReferenceAbstract(db, {
      unresolvedReferenceId: 10,
      citingWorkId: 1,
      outcome: 'found',
      doi: opts.matchedBy === 'doi' ? '10.1/a' : null,
      abstract: opts.abstract,
      source: 'openalex',
      matchedBy: opts.matchedBy ?? 'doi',
      matchConfidence: opts.matchedBy === 'title' ? 0.97 : null
    })
  }
  promoteReferenceEntry(db, { unresolvedReferenceId: 10, citingWorkId: 1, citedWorkId: 2 })
  db.prepare('DELETE FROM unresolved_reference WHERE id = 10').run()
}

test('promotion names the work, and the abstract outlives the unresolved row', () => {
  const db = makeDb()
  seedCiting(db)
  promote(db, { abstract: LONG, matchedBy: 'doi' })

  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM unresolved_reference').get() as { n: number }).n,
    0
  )
  const rows = referenceAbstractsFor(db, 1)
  assert.equal(rows.length, 1, 'the promotion took the abstract with it')
  assert.equal(rows[0].workId, 2)
  assert.equal(rows[0].unresolvedReferenceId, null)
  assert.equal(rows[0].abstract, LONG)
})

test('a DOI-matched abstract fills an empty work.abstract', () => {
  const db = makeDb()
  seedCiting(db)
  promote(db, { abstract: LONG, matchedBy: 'doi' })

  const w = db.prepare('SELECT abstract FROM work WHERE id = 2').get() as { abstract: string | null }
  assert.equal(w.abstract, LONG)
})

test('a TITLE-matched abstract never reaches work.abstract', () => {
  const db = makeDb()
  seedCiting(db)
  promote(db, { abstract: LONG, matchedBy: 'title' })

  const w = db.prepare('SELECT abstract FROM work WHERE id = 2').get() as { abstract: string | null }
  assert.equal(w.abstract, null, 'an inferred abstract landed where nothing can qualify it')
  // It is not lost — it stays where its provenance travels with it.
  assert.equal(referenceAbstractsFor(db, 1)[0].abstract, LONG)
})

test('a non-empty work.abstract is never overwritten, even by a DOI match', () => {
  const db = makeDb()
  seedCiting(db)
  db.prepare('INSERT INTO work (id, title, abstract) VALUES (2, ?, ?)').run(
    'The cited paper',
    'What the import already knew.'
  )
  db.prepare(
    'INSERT INTO citation_edge (id, citing_work_id, cited_work_id, edge_type) VALUES (5, 1, 2, ?)'
  ).run('cites')
  recordReferenceAbstract(db, {
    unresolvedReferenceId: 10,
    citingWorkId: 1,
    outcome: 'found',
    doi: '10.1/a',
    abstract: LONG,
    source: 'openalex',
    matchedBy: 'doi'
  })
  promoteReferenceEntry(db, { unresolvedReferenceId: 10, citingWorkId: 1, citedWorkId: 2 })
  db.prepare('DELETE FROM unresolved_reference WHERE id = 10').run()

  const w = db.prepare('SELECT abstract FROM work WHERE id = 2').get() as { abstract: string }
  assert.equal(w.abstract, 'What the import already knew.')
})

test('a promoted row re-fetched updates in place, with no unique index to lean on', () => {
  const db = makeDb()
  seedCiting(db)
  promote(db, { abstract: LONG, matchedBy: 'doi' })

  recordReferenceAbstract(db, {
    unresolvedReferenceId: null,
    citingWorkId: 1,
    workId: 2,
    outcome: 'found',
    doi: '10.1/a',
    abstract: `${LONG} A longer deposit.`,
    source: 'crossref',
    matchedBy: 'doi'
  })

  const rows = referenceAbstractsFor(db, 1)
  assert.equal(rows.length, 1, 'the promoted row accumulated a duplicate')
  assert.equal(rows[0].source, 'crossref')
})

test('two different papers keep their own rows under the same NULL reference id', () => {
  const db = makeDb()
  seedCiting(db)
  db.prepare('INSERT INTO work (id, title, abstract) VALUES (2, ?, NULL)').run('One cited')
  db.prepare('INSERT INTO work (id, title, abstract) VALUES (3, ?, NULL)').run('Another cited')

  recordReferenceAbstract(db, {
    unresolvedReferenceId: null,
    citingWorkId: 1,
    workId: 2,
    outcome: 'absent'
  })
  recordReferenceAbstract(db, {
    unresolvedReferenceId: null,
    citingWorkId: 1,
    workId: 3,
    outcome: 'found',
    abstract: LONG,
    source: 'openalex',
    matchedBy: 'doi'
  })

  const rows = referenceAbstractsFor(db, 1)
  assert.equal(rows.length, 2, 'the partial index collapsed two promoted references into one')
})

// ---------------------------------------------------------------- the mean
//
// Expansion priority is now the arithmetic mean of a paper's reference
// relevances, and every way that mean can lie has a test here. The distinction
// under all three is between a number and the ABSENCE of one: a reference nobody
// could score is not a reference that scored badly, and a paper whose whole
// bibliography is unscorable has an undefined mean rather than a bad one.

test('a known set yields the arithmetic mean and nothing else', () => {
  assert.equal(meanReferenceRelevance([0.2, 0.4, 0.6]), 0.4000000000000001)
  assert.equal(meanReferenceRelevance([1]), 1)
  assert.equal(meanReferenceRelevance([0, 1]), 0.5)
})

test('a length-independent mean: a long off-topic list loses to a short on-topic one', () => {
  // THE REGRESSION THE MEAN EXISTS TO FIX, as an assertion rather than as a
  // comment: under bibliography SIZE the first paper won by a factor of six.
  const sprawling = meanReferenceRelevance(new Array(180).fill(0.1)) as number
  const focused = meanReferenceRelevance(new Array(30).fill(0.8)) as number
  assert.ok(focused > sprawling)
})

test('an unscorable reference is excluded from the mean, not counted as zero', () => {
  // The caller passes only the scored ones — the store's query filters
  // `relevance IS NOT NULL` — so the assertion is that the excluded row would
  // have changed the answer had it been admitted as a 0.
  const scoredOnly = meanReferenceRelevance([0.8, 0.6]) as number
  const asIfZero = meanReferenceRelevance([0.8, 0.6, 0]) as number
  assert.equal(scoredOnly, 0.7)
  assert.ok(scoredOnly > asIfZero)
})

test('a paper whose references are all unscored has NO mean, not a mean of zero', () => {
  assert.equal(meanReferenceRelevance([]), null)
})

test('scoringSets averages only the rows scored for THAT project', () => {
  // A work in two projects is the case the `scored_for_project_id` column
  // exists for: without it this paper's expansion priority under project 2
  // would be project 1's answer wearing project 2's label.
  const db = makeDb()
  db.exec(`
    CREATE TABLE project (id INTEGER PRIMARY KEY, description TEXT);
    CREATE TABLE project_work (
      project_id INTEGER NOT NULL,
      work_id INTEGER NOT NULL,
      inclusion_status TEXT
    );
  `)
  db.exec(`
    INSERT INTO project (id, description) VALUES (1, 'first question'), (2, 'second question');
    INSERT INTO work (id, title, abstract) VALUES (1, 'The citing paper', NULL);
    INSERT INTO project_work (project_id, work_id, inclusion_status)
      VALUES (1, 1, 'undecided'), (2, 1, 'undecided');
  `)
  // A ROW MUST HANG OFF A LIVE UNRESOLVED REFERENCE to count, so the fixture
  // gives each one — a bare `citing_work_id` models a reference that never
  // existed, and the query rightly ignores it.
  const ref = db.prepare(
    `INSERT INTO unresolved_reference (citing_work_id, raw_bib_text, part_label)
     VALUES (1, ?, NULL)`
  )
  const write = db.prepare(
    `INSERT INTO reference_abstract
       (unresolved_reference_id, citing_work_id, outcome, fetched_at, relevance,
        scored_for_project_id)
     VALUES (?, 1, 'found', '2026-01-01T00:00:00Z', ?, ?)`
  )
  const add = (rel: number, project: number): void => {
    const id = Number(ref.run(`ref ${rel}`).lastInsertRowid)
    write.run(id, rel, project)
  }
  add(0.9, 1)
  add(0.7, 1)
  add(0.1, 2)
  // Scored for nobody: present in the table, absent from both means.
  const noScore = Number(ref.run('unscored').lastInsertRowid)
  db.prepare(
    `INSERT INTO reference_abstract (unresolved_reference_id, citing_work_id, outcome, fetched_at)
     VALUES (?, 1, 'absent', '2026-01-01T00:00:00Z')`
  ).run(noScore)

  const sets = scoringSets(db)
  const first = sets.find((s) => s.projectId === 1)?.works[0]
  const second = sets.find((s) => s.projectId === 2)?.works[0]
  assert.deepEqual(first?.referenceRelevances, [0.9, 0.7])
  assert.deepEqual(second?.referenceRelevances, [0.1])
  assert.equal(meanReferenceRelevance(first?.referenceRelevances ?? []), 0.8)
  assert.equal(meanReferenceRelevance(second?.referenceRelevances ?? []), 0.1)
})

test('a reference that has been imported leaves the average', () => {
  // Expansion priority asks what following a paper's citations would OPEN. A
  // reference now in the library opens nothing, so its score must leave the
  // mean the moment it resolves — and its row SURVIVES promotion by design
  // (the abstract is kept, the FK goes NULL), so nothing else removes it.
  //
  // Left in, it also outlived the count beside it: `unmatchedReferences` reads
  // live unresolved rows, so the two disagreed and the explanation sentence
  // read "the 44 of its 30 unmatched references".
  const db = makeDb()
  db.exec(`
    CREATE TABLE project (id INTEGER PRIMARY KEY, description TEXT);
    CREATE TABLE project_work (
      project_id INTEGER NOT NULL,
      work_id INTEGER NOT NULL,
      inclusion_status TEXT
    );
    INSERT INTO project (id, description) VALUES (1, 'the question');
    INSERT INTO work (id, title, abstract) VALUES (1, 'The citing paper', NULL);
    INSERT INTO project_work (project_id, work_id, inclusion_status) VALUES (1, 1, 'undecided');
  `)
  const refId = Number(
    db
      .prepare(
        `INSERT INTO unresolved_reference (citing_work_id, raw_bib_text, part_label)
         VALUES (1, 'a printed line', NULL)`
      )
      .run().lastInsertRowid
  )
  db.prepare(
    `INSERT INTO reference_abstract
       (unresolved_reference_id, citing_work_id, outcome, fetched_at, relevance,
        scored_for_project_id)
     VALUES (?, 1, 'found', '2026-01-01T00:00:00Z', 0.9, 1)`
  ).run(refId)

  assert.deepEqual(scoringSets(db)[0]?.works[0]?.referenceRelevances, [0.9])

  // Promotion, as `adoptReferenceAbstract` performs it: the row keeps its
  // abstract, gains the work it became, and loses the reference it hung off.
  db.prepare('INSERT INTO work (id, title, abstract) VALUES (2, ?, NULL)').run('now imported')
  db.prepare(
    `UPDATE reference_abstract SET work_id = 2, unresolved_reference_id = NULL
      WHERE unresolved_reference_id = ?`
  ).run(refId)
  db.prepare('DELETE FROM unresolved_reference WHERE id = ?').run(refId)

  assert.deepEqual(
    scoringSets(db)[0]?.works[0]?.referenceRelevances,
    [],
    'an imported reference is still being averaged into expansion priority'
  )
})
