// The lexical (BM25) leg of hybrid retrieval.
//
// Run via:
//   ELECTRON_RUN_AS_NODE=1 npx electron --import tsx --test src/main/db/repos/lexical.test.ts
//
// (Electron-as-node because the module takes the corpus handle, and
// better-sqlite3 is built for Electron's ABI; plain `tsx --test` fails the
// ABI check. Same reason as supersede.test.ts.)
//
// WHAT IS PINNED, and why each pin earns its place:
//
// - The MATCH builder is INJECTION-PROOF by construction, and the gauntlet
//   proves the construction rather than trusting it: every input that carries
//   FTS5 syntax (`"`, parens, NEAR(, semicolons, comments) must come back as
//   either results or [] — a thrown SqliteError from any of them means a
//   token escaped its quotes. `DROP TABLE chunk` surviving intact in the
//   chunks table is the second half of the assertion: touching anything but
//   MATCH is a different bug with the same test.
// - bm25() ascends: smaller is the better match. An ordering flipped here
//   would still return results — just the WORST ones first.
// - The scope narrows, and narrows COMPOSABLY: a project that does not hold
//   the work returns nothing even when the work id is also given, because the
//   two narrowings are ANDed. It is the CALLER (runSemanticSearch) that applies
//   the dense leg's workId-precedence — a named work drops the project
//   narrowing before the scope is handed here — so both legs of one hybrid
//   query search the identical set.
// - The SPACE is named per query and REQUIRED: a model swap retires the old
//   embedding space without deleting its chunks, and the triggers keep those
//   rows indexed, so a space-free MATCH would answer with passages the dense
//   leg can never return. The caller passes the active space both legs search.
// - The token cap: one pasted document (a 1 MiB query) measures 115 s as
//   ~117k OR terms — a hang, not a slowdown. 64 terms is far past where an OR
//   union stops moving the top of a BM25 ranking. The per-term char cap closes
//   the separator-free paste, which segments to ONE segment and would bypass a
//   term count entirely.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initDatabase, closeDatabase } from '../connection'
import { unindexedLexical } from '../../embedding/vectors'
import { ftsMatchQuery, searchLexical, MAX_MATCH_TOKENS, MAX_TOKEN_CHARS } from './lexical'
import type { DB } from '../connection'

const dir = mkdtempSync(join(tmpdir(), 'lexical-'))
const db: DB = initDatabase(join(dir, 'corpus.sqlite'))

after(() => {
  closeDatabase(db)
  rmSync(dir, { recursive: true, force: true })
})

// Minimal embedding chain: a space and a stage_run to anchor chunks, two works
// each with a document, and a project holding only the FIRST work.
db.exec(`
INSERT INTO embedding_space (id, model_id, model_revision, model_file, dims, quantization,
  stored_quantization, pooling, normalized, query_prefix, doc_prefix, chunking_version,
  max_seq_length, text_extraction_version, runtime, config_hash, vec_table, status, created_at)
VALUES (1, 'test-model', 'rev-1', 'm.onnx', 4, 'none', 'none', 'mean', 1, '', '',
  'test-1', 512, 'test-1', 'test', 'test-hash-1', 'chunks_vec_test', 'active', '2026-01-01T00:00:00Z');
INSERT INTO stage_run (id, stage, stage_version, status, input_fingerprint, created_at)
VALUES (1, 'embed', 'test-1', 'succeeded', 'test-fp-1', '2026-01-01T00:00:00Z');
INSERT INTO work (id, title, created_at, updated_at) VALUES
  (101, 'alpha work', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  (102, 'beta work',  '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  (103, 'gamma work', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
INSERT INTO document (id, work_id, version_kind, created_at) VALUES
  (201, 101, 'publisher-PDF', '2026-01-01T00:00:00Z'),
  (202, 102, 'publisher-PDF', '2026-01-01T00:00:00Z'),
  (203, 103, 'publisher-PDF', '2026-01-01T00:00:00Z');
INSERT INTO project (id, name, slug, created_at, updated_at)
VALUES (301, 'test project', 'test-project', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
INSERT INTO project_work (project_id, work_id, created_at, updated_at)
VALUES (301, 101, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
`)

const insertChunk = db.prepare(
  `INSERT INTO chunk (stage_run_id, space_id, document_id, work_id, idx, para_ids,
     char_start, char_end, page, section, text, token_estimate, input_hash, config_hash,
     vector, embedded_at)
   VALUES (1, 1, ?, ?, ?, '[]', 0, 10, 1, 'test', ?, 10, 't', 't', x'00000000',
     '2026-01-01T00:00:00Z')`
)
// work 101 holds the fox; work 102 holds the double-'riverbank' erosion chunk
// and the catalyst chunk.
insertChunk.run(201, 101, 1, 'The quick brown fox jumps over the lazy dog near the riverbank')
insertChunk.run(202, 102, 1, 'Riverbank erosion accelerates where the riverbank is undercut')
insertChunk.run(202, 102, 2, 'Activation energy barriers fall when the catalyst is doped')
// Two IDENTICAL chunks: same terms, same length, so bm25() scores them exactly
// equal and nothing in the corpus distinguishes them but the chunk id.
insertChunk.run(203, 103, 1, 'The wobble damped slowly before the gyroscope settled completely level')
insertChunk.run(203, 103, 2, 'The wobble damped slowly before the gyroscope settled completely level')

const ids = (rows: Array<{ chunkId: number }>): number[] => rows.map((r) => r.chunkId)

test('a rare token finds exactly the chunk that carries it', () => {
  assert.deepEqual(ids(searchLexical(db, 'fox', { spaceId: 1 }, 10)), [1])
})

test('a two-token query ranks the chunk carrying BOTH terms first (bm25 ascending)', () => {
  const rows = searchLexical(db, 'riverbank erosion', { spaceId: 1 }, 10)
  assert.equal(rows[0].chunkId, 2)
  assert.ok(rows[0].score <= rows[rows.length - 1].score)
})

test('scores order ascending — smaller bm25 is the better match', () => {
  const rows = searchLexical(db, 'riverbank', { spaceId: 1 }, 10)
  assert.ok(rows.length >= 2)
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].score >= rows[i - 1].score)
})

test('an exact bm25 tie breaks by chunk id — the rank list is a total order', () => {
  const rows = searchLexical(db, 'gyroscope', { spaceId: 1 }, 10)
  assert.equal(rows.length, 2)
  assert.ok(rows[0].score === rows[1].score, `${rows[0].score} vs ${rows[1].score}`)
  assert.deepEqual(ids(rows), [4, 5])
})

test('project scope excludes work the project does not hold', () => {
  const rows = searchLexical(db, 'riverbank', { projectId: 301, spaceId: 1 }, 10)
  assert.deepEqual(ids(rows), [1])
})

test('work scope narrows to that work alone', () => {
  assert.deepEqual(ids(searchLexical(db, 'riverbank', { workId: 102, spaceId: 1 }, 10)), [2])
})

test('the narrowings compose with AND — a project miss beats a work hit', () => {
  assert.deepEqual(
    ids(searchLexical(db, 'riverbank', { projectId: 301, workId: 102, spaceId: 1 }, 10)),
    []
  )
})

test('a token-free or empty query returns [] without touching MATCH', () => {
  assert.deepEqual(searchLexical(db, '', { spaceId: 1 }, 10), [])
  assert.deepEqual(searchLexical(db, '  !!! ??? ... ', { spaceId: 1 }, 10), [])
})

test('the gauntlet never throws and never touches anything but MATCH', () => {
  const gauntlet = ['" chunk "); DROP TABLE chunk; --', 'NEAR(', 'a"*b', 'foo:bar', '"', 'OR AND NOT']
  for (const q of gauntlet) {
    const rows = searchLexical(db, q, { spaceId: 1 }, 10)
    assert.ok(Array.isArray(rows))
  }
  assert.equal(
    (db.prepare('SELECT count(*) AS n FROM chunk').get() as { n: number }).n,
    5,
    'the chunk table survived the gauntlet'
  )
})

test('limit bounds the answer, and limit 0 returns []', () => {
  assert.equal(searchLexical(db, 'riverbank OR fox OR catalyst', { spaceId: 1 }, 0).length, 0)
  assert.equal(searchLexical(db, 'riverbank OR fox OR catalyst', { spaceId: 1 }, 1).length, 1)
  assert.equal(searchLexical(db, 'riverbank OR fox OR catalyst', { spaceId: 1 }, 10).length, 3)
})

test('the lexical leg searches only the space it is given — a retired space never answers for the active one', () => {
  // A model swap RETIRES the old embedding space and leaves its chunks in the
  // table; the triggers keep those rows indexed. runSemanticSearch passes the
  // dense leg's active space, so a MATCH must answer from that space alone or
  // the fusion compares unlike things.
  db.exec(`
INSERT INTO embedding_space (id, model_id, model_revision, model_file, dims, quantization,
  stored_quantization, pooling, normalized, query_prefix, doc_prefix, chunking_version,
  max_seq_length, text_extraction_version, runtime, config_hash, vec_table, status, created_at)
VALUES (2, 'old-model', 'rev-0', 'old.onnx', 4, 'none', 'none', 'mean', 1, '', '',
  'test-1', 512, 'test-1', 'test', 'test-hash-2', 'chunks_vec_test_2', 'retired',
  '2026-01-01T00:00:00Z');
`)
  db.prepare(
    `INSERT INTO chunk (stage_run_id, space_id, document_id, work_id, idx, para_ids,
       char_start, char_end, page, section, text, token_estimate, input_hash, config_hash,
       vector, embedded_at)
     VALUES (1, 2, 202, 102, 3, '[]', 0, 10, 1, 'test', ?, 10, 't', 't', x'00000000',
       '2026-01-01T00:00:00Z')`
  ).run('the retired space keeps a qzzretired marker of its own')
  assert.deepEqual(
    ids(searchLexical(db, 'qzzretired', { spaceId: 1 }, 10)),
    [],
    'a retired-space chunk must not answer for the active space'
  )
  assert.equal(searchLexical(db, 'qzzretired', { spaceId: 2 }, 10).length, 1)
  assert.deepEqual(
    ids(searchLexical(db, 'riverbank', { spaceId: 2 }, 10)),
    [],
    'nor may the active space answer for the retired one'
  )
})

test('ftsMatchQuery ORs the word tokens; quotes are punctuation, not token bytes', () => {
  // The Segmenter strips the quotes BEFORE the builder sees the token, so the
  // quote-doubling inside the builder is defense against a tokenizer that ever
  // returned one — the gauntlet above is what proves end-to-end safety.
  assert.equal(ftsMatchQuery('say "hello" world'), '"say" OR "hello" OR "world"')
  assert.equal(ftsMatchQuery('!!!'), null)
  assert.equal(ftsMatchQuery(''), null)
})

test('ftsMatchQuery caps the token stream at MAX_MATCH_TOKENS', () => {
  const wall = Array.from({ length: 5000 }, (_, i) => `w${i}x`).join(' ')
  const q = ftsMatchQuery(wall)
  assert.ok(q)
  assert.equal((q.match(/"/g) as string[]).length, MAX_MATCH_TOKENS * 2)
})

test('a whitespace-free paste cannot bypass the cap — the long segment is dropped whole', () => {
  // The 115 s hang shape: one word-like segment, no separators. It contributes
  // no term at all rather than one phrase the tokenizer would explode into
  // every query token it holds, so `lexical: null` stays the truth it reports.
  assert.equal(ftsMatchQuery('a'.repeat(1_000_000)), null)
  assert.deepEqual(searchLexical(db, 'a'.repeat(1_000_000), { spaceId: 1 }, 10), [])
  // The drop must not take the legitimate terms after it down with it.
  assert.equal(ftsMatchQuery(`${'a'.repeat(100_000)} catalyst`), '"catalyst"')
})

test('a term is kept up to MAX_TOKEN_CHARS and dropped past it', () => {
  assert.equal(ftsMatchQuery('x'.repeat(MAX_TOKEN_CHARS)), `"${'x'.repeat(MAX_TOKEN_CHARS)}"`)
  assert.equal(ftsMatchQuery('x'.repeat(MAX_TOKEN_CHARS + 1)), null)
})

test('ftsMatchQuery keeps one OR term per distinct token — repeats are not double-weighted', () => {
  assert.equal(ftsMatchQuery('fox fox'), '"fox"')
  assert.equal(ftsMatchQuery('riverbank riverbank erosion'), '"riverbank" OR "erosion"')
  // unicode61 folds case before porter stems, so case variants are the same
  // indexed term — the seen-set keys on the folded form, and the FIRST
  // occurrence's bytes are the term the MATCH string keeps.
  assert.equal(ftsMatchQuery('Riverbank riverbank'), '"Riverbank"')
  assert.equal(ftsMatchQuery('EROSION Riverbank riverbank erosion'), '"EROSION" OR "Riverbank"')
  // unicode61 also strips diacritics (remove_diacritics 2 — every LATIN block,
  // so the fold the seen-set applies to Latin tokens is the fold the index
  // applies), so accent variants are one indexed term too — without the fold
  // the second OR term would double-weight it in bm25().
  assert.equal(ftsMatchQuery('café cafe'), '"café"')
  assert.equal(ftsMatchQuery('Aleș Ales'), '"Aleș"')
  // But the index's fold stops at Latin: 'мой' (й NFD-decomposes to и plus a
  // breve) and 'мои' are DISTINCT unicode61 tokens, and keying both on the
  // mark-stripped form would drop the second arm from the OR union — every
  // passage matching only 'мои' would be unreachable. Outside Latin the key is
  // the plain lowercased token and both arms survive.
  assert.equal(ftsMatchQuery('мой мои'), '"мой" OR "мои"')
  // U+017F (long s): the index's SIMPLE case fold maps it to 's', which JS's
  // toLowerCase leaves alone and NFD cannot produce — without the hand fold
  // in ftsMatchQuery these two would pass the seen-set as distinct and
  // double-weight one indexed term.
  assert.equal(ftsMatchQuery('\u017F s'), '"\u017F"')
})

test('the index folds diacritics like the MATCH builder does — a plain-form query finds accented text', () => {
  // Level 2 strips every Latin mark, the way the query-side seen-set does.
  // Level 1 — what a bare `porter unicode61` ships — stops short of Latin
  // Extended Additional: on the bundled SQLite it folds Latin-1 through
  // Extended-B ('așezare' finds 'asezare' either way) but keeps 'dế' and 'de'
  // distinct, so only level 2 leaves no Latin token the builder folds but the
  // index keeps distinct. Probed against this live index, not read off a
  // version table.
  const { lastInsertRowid } = insertChunk.run(
    201,
    101,
    2,
    'the așezare probe marks the settlement by the river'
  )
  assert.deepEqual(ids(searchLexical(db, 'asezare', { spaceId: 1 }, 10)), [
    Number(lastInsertRowid)
  ])
  // And the fold the query-side key reaches the OTHER way: U+0130 (İ) — its
  // full case fold is two characters, so the seen-set reaches 'i' through the
  // NFD mark-strip, and the index must fold the precomposed character the
  // same way or the merged key would be dropping a real OR arm. The plain-form
  // query finding the accented text pins that agreement (probed: unicode61
  // remove_diacritics 2 folds İ→i and keeps the dotless 'ı' distinct).
  const { lastInsertRowid: izmirRow } = insertChunk.run(
    201,
    101,
    4,
    'the \u0130zmir probe records the city by the gulf'
  )
  assert.deepEqual(ids(searchLexical(db, 'Izmir', { spaceId: 1 }, 10)), [Number(izmirRow)])
  assert.deepEqual(ids(searchLexical(db, '\u0130zmir', { spaceId: 1 }, 10)), [Number(izmirRow)])
  // And the long s, BOTH directions: the hand fold in ftsMatchQuery is only
  // safe because the index really does fold ſ→s. If it did not, the merged
  // key would be silently dropping a real OR arm — a passage whose text
  // carries the plain 's' word would be unreachable whenever the query kept
  // the 'ſ' bytes, and nothing in the pure-builder assertion above would
  // notice.
  const { lastInsertRowid: sharpRow } = insertChunk.run(
    201,
    101,
    5,
    'the \u017Fharp probe keeps the long s of the manuscript'
  )
  assert.deepEqual(ids(searchLexical(db, 'sharp', { spaceId: 1 }, 10)), [Number(sharpRow)])
  assert.deepEqual(ids(searchLexical(db, '\u017Fharp', { spaceId: 1 }, 10)), [Number(sharpRow)])
})

test('the index keeps the non-Latin diacritics the builder keys plain — Cyrillic stays distinct', () => {
  // The one fold claim a Latin pin cannot settle. The builder keys NON-Latin
  // tokens on the plain lowercased form because the index keeps their
  // diacritics: й (и plus a breve) is NOT folded onto и the way NFD
  // mark-stripping would, so keying on the stripped form would collapse two
  // real index tokens onto one key and silently drop the second OR arm.
  // Pinned both ways against the live index — probed, not reasoned: the
  // accented token is findable, and its mark-stripped sibling does not answer
  // for it.
  const { lastInsertRowid } = insertChunk.run(
    201,
    101,
    6,
    'мой дом стоит рядом с рекой — запись из полевого журнала'
  )
  assert.deepEqual(ids(searchLexical(db, 'мой', { spaceId: 1 }, 10)), [Number(lastInsertRowid)])
  assert.deepEqual(
    ids(searchLexical(db, 'мои', { spaceId: 1 }, 10)),
    [],
    'и must not answer for й: the index keeps the breve, so the plain lowercased key is right'
  )
})

test('a CASCADE delete through the parent de-indexes the chunk — shadow tables included', () => {
  // On its OWN database: the deletion here is destructive and the shared
  // fixture's works are other tests' data. A fresh initDatabase runs the same
  // migrations, so the triggers under test are the shipped ones.
  const dir = mkdtempSync(join(tmpdir(), 'lexical-cascade-'))
  const pdb: DB = initDatabase(join(dir, 'corpus.sqlite'))
  try {
    const token = `zzcascade${Date.now()}`
    pdb.exec(`
INSERT INTO embedding_space (id, model_id, model_revision, model_file, dims, quantization,
  stored_quantization, pooling, normalized, query_prefix, doc_prefix, chunking_version,
  max_seq_length, text_extraction_version, runtime, config_hash, vec_table, status, created_at)
VALUES (1, 'test-model', 'rev-1', 'm.onnx', 4, 'none', 'none', 'mean', 1, '', '',
  'test-1', 512, 'test-1', 'test', 'test-hash-cascade', 'chunks_vec_cascade', 'active',
  '2026-01-01T00:00:00Z');
INSERT INTO stage_run (id, stage, stage_version, status, input_fingerprint, created_at)
VALUES (1, 'embed', 'test-1', 'succeeded', 'test-fp-cascade', '2026-01-01T00:00:00Z');
INSERT INTO work (id, title, created_at, updated_at)
VALUES (501, 'cascade work', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
INSERT INTO document (id, work_id, version_kind, created_at)
VALUES (601, 501, 'publisher-PDF', '2026-01-01T00:00:00Z');
`)
    pdb
      .prepare(
        `INSERT INTO chunk (stage_run_id, space_id, document_id, work_id, idx, para_ids,
           char_start, char_end, page, section, text, token_estimate, input_hash, config_hash,
           vector, embedded_at)
         VALUES (1, 1, 601, 501, 1, '[]', 0, 10, 1, 'test', ?, 10, 't', 't', x'00000000',
           '2026-01-01T00:00:00Z')`
      )
      .run(`the cascade probe carries the ${token} marker`)
    assert.equal(searchLexical(pdb, token, { spaceId: 1 }, 5).length, 1)
    // ONE live chunk, ONE index row — the detector must call that healthy. The
    // read is what pins the detector's column mapping: the docsize rowid is
    // selected under an explicit alias, because SQLite reports a bare `rowid`
    // column under the PRIMARY KEY's name, and undefined on every row would
    // name every chunk missing on every database — quiet about nothing, blind
    // to every ghost. (Deleting everything below would make this pass vacuous:
    // an empty docsize is null under any mapping.)
    assert.equal(
      unindexedLexical(pdb),
      null,
      'a corpus with one indexed chunk and no ghosts is healthy'
    )
    pdb.prepare('DELETE FROM work WHERE id = 501').run()
    assert.equal(
      (pdb.prepare('SELECT COUNT(*) AS c FROM chunk WHERE work_id = 501').get() as { c: number })
        .c,
      0,
      'the cascade reached the chunks'
    )
    assert.deepEqual(
      searchLexical(pdb, token, { spaceId: 1 }, 5),
      [],
      'a ghost row would still answer MATCH'
    )
    assert.equal(
      unindexedLexical(pdb),
      null,
      'the shadow tables must be empty too: ghost rows skew BM25 doc statistics and a reused rowid would double-index'
    )
  } finally {
    closeDatabase(pdb)
    rmSync(dir, { recursive: true, force: true })
  }
})
