// Writing, deleting and sweeping vectors. The ONE place a `vec0` row is
// created or destroyed.
//
// A `vec0` table is VIRTUAL: it can carry no foreign key and no
// `ON DELETE CASCADE`. So every rule that keeps `chunk` consistent with the
// rest of the database — the supersede cascade, `deleteWork`, the startup
// orphan sweep, the retrieval settle — leaves its vectors behind unless
// something explicitly removes them. An orphan vector is not merely untidy: a
// space-correct k-NN query returns it, pointing at a chunk id that no longer
// exists, which is a confidently wrong neighbour rather than an error.
//
// Two mechanisms, deliberately overlapping:
//
//   1. `deleteChunksForRun` — EXACT, on the path that retires a run. Vectors
//      first, then the chunks, in the caller's transaction.
//   2. `sweepVectorOrphans` — a BACKSTOP at startup, over every space's table,
//      for the deletion paths that never see a stage_run at all. There are
//      three of those today and the next one will be written by somebody who
//      has not read this file, which is precisely why the backstop exists
//      rather than a fourth call site.
//
// `chunk.id` is AUTOINCREMENT so an orphan can only ever point at NOTHING. Were
// ids reused, a later chunk would inherit a dead one's vector and the sweep
// would have nothing to find.

// TYPE-ONLY, deliberately. `stageRun.ts` imports this module and is itself
// bundled into the stage host, which has no database at all — a value import
// from `db/connection` would drag better-sqlite3 into that bundle and break the
// property that makes "one writer" structural rather than a rule.
import type { DB } from '../db/connection'
import { allVecTables, type EmbeddingSpace } from './space'

/**
 * Which papers a coverage question is about.
 *
 * An object rather than positional arguments because the two narrowings compose
 * — a paper is normally open INSIDE a project — and because a bare
 * `f(db, space, 5)` at a call site reads as neither one. Empty means the whole
 * library.
 */
export interface CoverageScope {
  projectId?: number
  workId?: number
}

/**
 * Papers with CURRENT extracted text, under an arbitrary scope.
 *
 * Shared by `spaceCoverage` and by the no-space branch of `semanticCoverage`,
 * which asks the same question without a space to ask it of. Two copies of this
 * SQL is how the no-space branch came to report zero papers read while the user
 * could watch extraction succeed in the Queue.
 */
export function countWorksWithTextScoped(db: DB, scope: CoverageScope = {}): number {
  const { projectId, workId } = scope
  const joins =
    projectId !== undefined
      ? 'JOIN project_work pw ON pw.work_id = d.work_id AND pw.project_id = ?'
      : ''
  const args: number[] = projectId !== undefined ? [projectId] : []
  const where = workId !== undefined ? 'AND d.work_id = ?' : ''
  if (workId !== undefined) args.push(workId)
  return (
    db
      .prepare(
        `SELECT COUNT(DISTINCT d.work_id) AS c
           FROM document_paragraph p
           JOIN stage_run r ON r.id = p.stage_run_id
           JOIN document d ON d.id = p.document_id
           ${joins}
          WHERE r.superseded = 0 ${where}`
      )
      .get(...args) as { c: number }
  ).c
}

export interface ChunkRecord {
  idx: number
  paraIds: string[]
  charStart: number
  charEnd: number
  page: number | null
  section: string
  text: string
  tokenEstimate: number
  truncated: boolean
  lowConfidence: boolean
  inputHash: string
  /** Float32 little-endian, `space.dims` values. */
  vector: Buffer
}

/**
 * Insert a batch of chunks and their vectors.
 *
 * Runs inside the caller's transaction — the scheduler's single `.immediate()`
 * that also writes the terminal `stage_run` row — so a stop between the vectors
 * and the chunk rows is impossible.
 *
 * `safeIntegers(true)` and BigInt binding are MANDATORY on a vec0 INTEGER
 * column: better-sqlite3 binds a plain JS number as SQLITE_FLOAT, which vec0
 * rejects. Proven in `verify:payloads` before any of this was written.
 */
export function insertChunks(
  db: DB,
  space: EmbeddingSpace,
  subject: { stageRunId: number; documentId: number; workId: number },
  chunks: readonly ChunkRecord[],
  now: string
): void {
  const insertChunk = db.prepare(
    `INSERT INTO chunk
       (stage_run_id, space_id, document_id, work_id, idx, para_ids, char_start, char_end,
        page, section, text, token_estimate, truncated, low_confidence, input_hash,
        config_hash, vector, embedded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const insertVec = db.prepare(`INSERT INTO ${space.vecTable}(chunk_id, v) VALUES (?, ?)`)
  insertVec.safeIntegers(true)

  for (const c of chunks) {
    if (c.vector.length !== space.dims * 4) {
      // A dimensionality mismatch is a FAILURE, never a coerced insert. A
      // vector of the wrong width in the right table is the corruption the
      // whole space registry exists to make impossible.
      throw new Error(
        `chunk ${c.idx} carries ${c.vector.length / 4} dimensions, but space ${space.id} ` +
          `is ${space.dims}-dimensional`
      )
    }
    const info = insertChunk.run(
      subject.stageRunId,
      space.id,
      subject.documentId,
      subject.workId,
      c.idx,
      JSON.stringify(c.paraIds),
      c.charStart,
      c.charEnd,
      c.page,
      c.section,
      c.text,
      c.tokenEstimate,
      c.truncated ? 1 : 0,
      c.lowConfidence ? 1 : 0,
      c.inputHash,
      space.configHash,
      c.vector,
      now
    )
    // The vec0 row is the INDEX over the blob just stored, written in the same
    // transaction as the chunk so the two can never disagree about what has
    // been indexed.
    insertVec.run(BigInt(Number(info.lastInsertRowid)), c.vector)
  }
}

/**
 * Delete a run's chunks and their vectors. Vectors FIRST.
 *
 * Order matters and is not a preference: deleting the chunks first destroys the
 * only record of which vectors belonged to the run, so the vector delete would
 * have nothing to select on and would silently remove nothing.
 */
export function deleteChunksForRun(db: DB, stageRunId: number): void {
  const rows = db.prepare('SELECT id, space_id FROM chunk WHERE stage_run_id = ?').all(stageRunId) as
    | Array<{ id: number; space_id: number }>
  if (rows.length === 0) return
  const bySpace = new Map<number, number[]>()
  for (const r of rows) {
    const list = bySpace.get(r.space_id) ?? []
    list.push(r.id)
    bySpace.set(r.space_id, list)
  }
  for (const [spaceId, ids] of bySpace) {
    const row = db.prepare('SELECT vec_table FROM embedding_space WHERE id = ?').get(spaceId) as
      | { vec_table: string }
      | undefined
    if (!row || row.vec_table === '') continue
    if (!db.prepare(`SELECT name FROM sqlite_master WHERE name = ?`).get(row.vec_table)) continue
    const del = db.prepare(`DELETE FROM ${row.vec_table} WHERE chunk_id = ?`)
    del.safeIntegers(true)
    for (const id of ids) del.run(BigInt(id))
  }
  db.prepare('DELETE FROM chunk WHERE stage_run_id = ?').run(stageRunId)
}

/**
 * Delete every vector whose chunk is gone, across every space.
 *
 * The backstop for the deletion paths that never touch a `stage_run`: the
 * startup orphan sweep, `deleteWork`, and the retrieval settle all cascade
 * `chunk` away through its foreign keys and cannot reach the virtual table.
 *
 * Deliberately not a `DELETE … WHERE chunk_id NOT IN (SELECT id FROM chunk)`:
 * `vec0` does not support an arbitrary WHERE on a non-indexed scan of that
 * shape, so the ids are read out and deleted individually. That is why this is
 * a startup sweep and not something on a hot path.
 *
 * Returns how many it removed, so a caller can report a number rather than a
 * reassurance.
 */
/** A space holding chunks the search index cannot reach. */
export interface UnindexedChunks {
  spaceId: number
  vecTable: string
  chunks: number
  indexed: number
}

/**
 * Spaces whose `vec0` table holds fewer rows than the space has chunks.
 *
 * The OTHER direction from `sweepVectorOrphans`, and the silent one. An orphan
 * vector surfaces as a hit with no chunk, which the search already drops; a
 * chunk with no vector surfaces as nothing at all — the passage is simply never
 * a neighbour, and the corpus reports itself embedded while part of it is
 * invisible to every query. `spaceCoverage.indexed` cannot see this: it asks
 * whether the TABLE exists, which is a different question from whether it
 * covers the corpus.
 *
 * Counted rather than repaired. The vectors themselves are in `chunk.vector`,
 * so the index is rebuildable, but doing that silently at startup would hide
 * how the two came to disagree — and a write path that can lose an index row is
 * a bug to find rather than a condition to absorb.
 */
export function unindexedChunks(db: DB): UnindexedChunks[] {
  const out: UnindexedChunks[] = []
  for (const space of db
    .prepare(`SELECT id, vec_table FROM embedding_space WHERE vec_table <> ''`)
    .all() as Array<{ id: number; vec_table: string }>) {
    if (!db.prepare(`SELECT name FROM sqlite_master WHERE name = ?`).get(space.vec_table)) continue
    const chunks = (
      db.prepare('SELECT COUNT(*) AS c FROM chunk WHERE space_id = ?').get(space.id) as { c: number }
    ).c
    const indexed = (
      db.prepare(`SELECT COUNT(*) AS c FROM ${space.vec_table}`).get() as { c: number }
    ).c
    if (indexed < chunks) {
      out.push({ spaceId: space.id, vecTable: space.vec_table, chunks, indexed })
    }
  }
  return out
}

export function sweepVectorOrphans(db: DB): number {
  let removed = 0
  for (const table of allVecTables(db)) {
    // Read unguarded. `allVecTables` has already established the table is in
    // `sqlite_master`, and every connection carries sqlite-vec, so a failure
    // here is a real fault rather than a build without the module. A table
    // skipped in silence keeps its orphan vectors, and a k-NN returns those as
    // confident neighbours belonging to a paper that no longer exists.
    const stmt = db.prepare(`SELECT chunk_id FROM ${table}`)
    stmt.safeIntegers(true)
    const ids = (stmt.all() as Array<{ chunk_id: bigint }>).map((r) => r.chunk_id)
    if (ids.length === 0) continue
    const alive = new Set(
      (db.prepare('SELECT id FROM chunk').all() as Array<{ id: number }>).map((r) => r.id)
    )
    const dead = ids.filter((id) => !alive.has(Number(id)))
    if (dead.length === 0) continue
    const del = db.prepare(`DELETE FROM ${table} WHERE chunk_id = ?`)
    del.safeIntegers(true)
    db.transaction(() => {
      for (const id of dead) {
        del.run(id)
        removed++
      }
    }).immediate()
  }
  return removed
}

/**
 * How much of the corpus the active space actually covers.
 *
 * A partial corpus is NORMAL after a model switch — works are re-embedded
 * progressively — and it is the one state that must never be invisible. A
 * search over 12 % of the library returns a plausible, short, ranked list and
 * no error at all, so the surface asking the question gets the numbers and
 * badges the gap.
 */
export function spaceCoverage(
  db: DB,
  space: EmbeddingSpace,
  /**
   * Restrict every count to one project's papers, or to one paper.
   *
   * Both sides of the ratio move together or not at all. A corpus-wide "3 of 20
   * embedded" shown above a project holding 5 papers is a number about a
   * different set than the one on screen, and the user has no way to tell — so
   * the scope is a parameter rather than something a caller mixes afterwards.
   *
   * `workId` exists for surfaces that can only search ONE document (the paper
   * view's find bar). There the library-wide ratio is not merely imprecise, it
   * answers a question the reader did not ask: "18 of 20 papers embedded" says
   * nothing about whether the paper open in front of them is one of the two.
   */
  scope: CoverageScope = {}
): {
  worksEmbedded: number
  worksWithText: number
  chunks: number
  stale: number
  worksStaleOnly: number
  indexed: boolean
} {
  const { projectId, workId } = scope
  // Fragments, not a boolean: the two scopes are independent narrowings and a
  // caller may hold both (a paper opened inside a project), so they compose.
  const chunkParts: string[] = []
  const scopeArgs: number[] = []
  if (projectId !== undefined) {
    chunkParts.push(
      'AND EXISTS (SELECT 1 FROM project_work pw WHERE pw.work_id = chunk.work_id AND pw.project_id = ?)'
    )
    scopeArgs.push(projectId)
  }
  if (workId !== undefined) {
    chunkParts.push('AND chunk.work_id = ?')
    scopeArgs.push(workId)
  }
  const chunkScope = chunkParts.join(' ')

  const worksEmbedded = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT work_id) AS c FROM chunk WHERE space_id = ? ${chunkScope}`
      )
      .get(space.id, ...scopeArgs) as { c: number }
  ).c
  // WORKS on both sides of the ratio. Counting documents here and works there
  // would make a work with two documents look like two-thirds coverage of
  // itself.
  const worksWithText = countWorksWithTextScoped(db, scope)
  const chunks = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM chunk WHERE space_id = ? ${chunkScope}`)
      .get(space.id, ...scopeArgs) as { c: number }
  ).c
  // Chunks written under a config that is no longer this space's. Detectable
  // with one comparison precisely because the hash travels on every row.
  const stale = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM chunk
          WHERE space_id = ? AND config_hash <> ? ${chunkScope}`
      )
      .get(space.id, space.configHash, ...scopeArgs) as { c: number }
  ).c
  // Works whose ONLY vectors are stale. A separate count because "embedded" and
  // "embedded under the settings currently in force" are different claims: a
  // work re-embedded halfway is partly current, whereas one whose every chunk
  // predates the config change answers queries entirely from an older reading of
  // itself — and counting it in `worksEmbedded` alone lets a project whose
  // vectors are all out of date report as fully covered.
  const worksStaleOnly = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM (
           SELECT work_id FROM chunk
            WHERE space_id = ? ${chunkScope}
            GROUP BY work_id
           HAVING SUM(CASE WHEN config_hash = ? THEN 1 ELSE 0 END) = 0
         )`
      )
      .get(space.id, ...scopeArgs, space.configHash) as { c: number }
  ).c
  // Whether this space's index actually exists and can be read. sqlite-vec is
  // required on every connection, so false here is not "a platform without the
  // extension" but a space whose `vec0` table was never built — a state the
  // user has to fix by re-embedding, and one that would otherwise show up only
  // as searches that keep getting slower.
  //
  // Asked of `sqlite_master` rather than by catching a failed SELECT: the
  // question is whether the table EXISTS, and a catch would answer "no" to any
  // other fault as well — an unloadable module, a corrupt page — turning a
  // problem the user cannot see into a re-embed that would not fix it.
  const indexed =
    db.prepare(`SELECT name FROM sqlite_master WHERE name = ?`).get(space.vecTable) !== undefined
  return { worksEmbedded, worksWithText, chunks, stale, worksStaleOnly, indexed }
}
