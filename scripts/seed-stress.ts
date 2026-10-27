// Stress seed: builds the canonical corpus, then bulk-inserts THOUSANDS of works
// + tens of thousands of citation edges + project_work rows into a dedicated
// large project, using fast prepared-statement transactions. Proves the app
// stays responsive and bounds/paginate/virtualizes rather than rendering all
// rows. Runs via electron-as-node (same better-sqlite3 ABI as the app):
//
//   ELECTRON_RUN_AS_NODE=1 electron --import tsx scripts/seed-stress.ts
//
// Honors CORPUS_DB_PATH (always fresh — the DB is recreated).

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { initDatabase, setDb, closeDb, type DB } from '../src/main/db/connection'
import { seed } from '../src/main/db/seed'

const N_WORKS = Number(process.env.STRESS_WORKS ?? 3000)
const N_EDGES = Number(process.env.STRESS_EDGES ?? 10000)
const NOW = process.env.CORPUS_FAKE_NOW ?? '2026-01-01T00:00:00Z'
// A high, previously-unused project id so we never collide with the demo seed.
export const STRESS_PROJECT_ID = 900

function dbPath(): string {
  const base = process.env.CORPUS_DB_PATH
  if (base && base.trim()) return base
  return join(process.cwd(), '.corpus-data', 'corpus-stress.sqlite')
}

const WORK_TYPES = [
  'journal-article',
  'preprint',
  'conference-paper',
  'review',
  'book-chapter'
]

function seedStress(db: DB): void {
  const now = NOW
  // First lay down the canonical corpus so base_dir/projects/etc all exist.
  seed(db, { now })

  // The largest existing work id from the demo seed is 50; start above it.
  const BASE_ID = 100000

  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO project (id, name, slug, description, created_at, updated_at)
       VALUES (@id, 'Stress Corpus', 'stress-corpus',
               'Programmatically generated large corpus for scale testing.', @now, @now)`
    ).run({ id: STRESS_PROJECT_ID, now })

    const insWork = db.prepare(
      `INSERT INTO work (id, title, work_type, publication_year, venue, abstract, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, @now, @now)`
    )
    const insDoc = db.prepare(
      `INSERT INTO document (id, work_id, version_kind, content_status, retrieval_status, is_preferred, source_url, created_at)
       VALUES (?, ?, 'publisher-PDF', ?, 'retrieved', 1, NULL, @now)`
    )
    const insPw = db.prepare(
      `INSERT INTO project_work
         (project_id, work_id, relevance, expansion_priority, inclusion_status,
          ranking_explanation, reviewed, created_at, updated_at)
       VALUES (@pid, @wid, @rel, @exp, @status, @expl, 0, @now, @now)`
    )
    const contentStatuses = ['fulltext', 'abstract-only', 'metadata-only']
    const inclusion = ['unread', 'read', 'included', 'excluded', 'uncertain']

    for (let i = 0; i < N_WORKS; i++) {
      const wid = BASE_ID + i
      const docId = BASE_ID + i
      const wt = WORK_TYPES[i % WORK_TYPES.length]
      const year = 1990 + (i % 35)
      insWork.run(
        wid,
        `Stress work ${i} — engineered enzyme variant study`,
        wt,
        year,
        `Journal of Synthetic Enzymology vol ${i % 200}`,
        `Abstract for stress work ${i}: directed evolution and kinetics.`,
        { now }
      )
      insDoc.run(docId, wid, contentStatuses[i % contentStatuses.length], { now })
      // Distinct relevance vs expansion so the ranking axes stay separate.
      const rel = Number(((i * 37) % 100) / 100)
      const exp = Number(((i * 53 + 11) % 100) / 100)
      insPw.run({
        pid: STRESS_PROJECT_ID,
        wid,
        rel,
        exp,
        status: inclusion[i % inclusion.length],
        expl: `Auto-generated ranking for stress work ${i}.`,
        now
      })
    }

    const insEdge = db.prepare(
      `INSERT OR IGNORE INTO citation_edge (citing_work_id, cited_work_id, edge_type, created_at)
       VALUES (?, ?, 'cites', @now)`
    )
    for (let e = 0; e < N_EDGES; e++) {
      const citing = BASE_ID + (e % N_WORKS)
      const cited = BASE_ID + ((e * 7 + 3) % N_WORKS)
      if (citing === cited) continue
      insEdge.run(citing, cited, { now })
    }
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
  seedStress(db)
  closeDb()
  // eslint-disable-next-line no-console
  console.log(`[seed-stress] ok -> ${p} (works=${N_WORKS}, edges=${N_EDGES}, project=${STRESS_PROJECT_ID})`)
}

main()
