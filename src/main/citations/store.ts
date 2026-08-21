// Persistence + invalidation for parsed citations.
//
// WHY PRE-BAKE. Parsing a bibliography means decoding every page of a PDF
// through pdfjs; for this corpus that is ~20 s of work. Doing it per render is
// unacceptable, so the parse result is written to the DB once and read back as
// ordinary rows.
//
// WHAT INVALIDATES A PARSE. Three inputs decide a work's parsed edges:
//
//   1. the DOCUMENT text        — tracked by `doc_sha`
//   2. the PARSER itself        — tracked by `parser_version`
//   3. the CORPUS it matched against — tracked by `corpus_size`
//
// (1) and (2) are obvious. (3) is the subtle one, and it is the reason a
// citation parse cannot simply be cached forever: matching is relative to the
// set of known works, so adding ONE paper can turn an existing UNRESOLVED
// reference into a real edge, in EVERY paper that cited it. A parse that was
// correct yesterday is incomplete today, through no change to its own PDF.
//
// The re-parse rule therefore is:
//
//   * document changed or parser changed -> re-parse THAT work.
//   * a work was ADDED to the corpus     -> re-match every OTHER work.
//
// Crucially the second case does NOT require re-reading any PDF. Parsing and
// matching are separate stages, and only matching depends on the corpus, so we
// re-run matching over the ALREADY-STORED reference rows (raw_bib_text and the
// parsed fields live in `unresolved_reference`). That is a pure in-memory pass
// over a few hundred rows — milliseconds — instead of 20 s of pdfjs. This is
// why `unresolved_reference` stores the parsed fields rather than only the raw
// text: it is both the UI's data source AND the re-match input.
//
// Re-matching only needs to consider references that are currently UNRESOLVED:
// an already-resolved edge cannot be improved by adding a work, because a
// reference resolves to at most one work and the existing match already cleared
// the threshold. So the work per newly-added paper is bounded by the number of
// unresolved references, not by the corpus size.

import type { DB } from '../db/connection'
import {
  matchReferences,
  printedReferenceCount,
  type CorpusWork,
  type ParsedReference,
  type ParseDiagnostics,
  type ReferenceMatch
} from './parseReferences'
import { extractSurnames } from './normalize'
import { volumeAndPages } from './entryFields'

/**
 * Bump this whenever the parser's OUTPUT could change for unchanged input.
 * A stored parse whose `parser_version` differs is stale by definition — that
 * is the only honest way to know a heuristic change has invalidated old rows.
 */
export const PARSER_VERSION = '2.7.0'

export interface StoreParseInput {
  workId: number
  documentId: number | null
  docSha: string | null
  references: ParsedReference[]
  matches: ReferenceMatch[]
  diagnostics: ParseDiagnostics
  corpusSize: number
}

/**
 * One stored bibliography entry, with the row it ended up in.
 *
 * Returned because a resolved reference's ORDINAL is otherwise destroyed:
 * `unresolved_reference` is deleted on resolution, and `citation_edge` has no
 * ordinal column and cannot have one — edges are deduped per (citing, cited,
 * type), and two bibliography entries may legitimately name the same paper.
 * Without this, nothing could map the callout `[17]` back to an edge for
 * exactly the references that DID resolve.
 */
export interface StoredEntry {
  ordinal: number
  rawBibText: string
  citedWorkId: number | null
  unresolvedReferenceId: number | null
  edgeId: number | null
  authors: string | null
  year: number | null
  title: string | null
  /** Where the entry is printed, or -1/-1 when it could not be located. */
  charStart: number
  charEnd: number
  /**
   * The lettered part of a composite this entry is, or null for a whole entry.
   *
   * Carried through storage because the ordinal cannot express it — a composite
   * and all its parts print under the same number — so without it the row count
   * reads as the reference count and overstates every ACS-style bibliography.
   */
  partLabel: string | null
}

/**
 * Replace a work's parsed citation data in ONE transaction.
 *
 * Deletes only rows this work OWNS and only those the parser created: hand-
 * asserted edges (`source='asserted'`) are left untouched, so re-parsing can
 * never destroy a curated claim. That is the whole point of the `source`
 * column.
 */
export function storeParse(db: DB, input: StoreParseInput): StoredEntry[] {
  const now = new Date().toISOString()
  const entries: StoredEntry[] = []

  const tx = db.transaction(() => {
    entries.length = 0
    // The contexts are NOT deleted here. A re-parse does not invalidate them:
    // a citation is identified by where it stands — (document_id,
    // callout_offset, ordinal) — and re-reading unchanged text finds the same
    // citations at the same offsets. Clearing them handed every survivor a new
    // id on re-insert, and `citation_link` cascades from that id, so verdicts
    // the model had already been paid to produce were destroyed to recompute a
    // scan whose output was identical. The contexts stage upserts on the site
    // key and deletes only the sites its new scan no longer finds.
    //
    // The parsed EDGES below are still replaced wholesale: an edge carries no
    // ordinal and is deduped per (citing, cited, type), so it has no identity a
    // re-parse could match it by. `applyWrites` re-resolves each context's
    // `edge_id` from the cited work at write time, which is what keeps the
    // surviving contexts attached to the edges this parse produces.
    db.prepare(`DELETE FROM citation_edge WHERE citing_work_id = ? AND source = 'parsed'`).run(
      input.workId
    )
    db.prepare('DELETE FROM unresolved_reference WHERE citing_work_id = ?').run(input.workId)

    const insertEdge = db.prepare(
      `INSERT OR IGNORE INTO citation_edge
         (citing_work_id, cited_work_id, edge_type, created_at, source, match_confidence, match_method)
       VALUES (?, ?, 'cites', ?, 'parsed', ?, ?)`
    )
    const insertUnresolved = db.prepare(
      `INSERT INTO unresolved_reference
         (citing_work_id, raw_bib_text, guessed_doi, guessed_title, section, status, created_at,
          guessed_year, guessed_authors, guessed_venue, ordinal, part_label)
       VALUES (?, ?, ?, ?, 'references', 'unresolved', ?, ?, ?, ?, ?, ?)`
    )

    let matched = 0
    for (const m of input.matches) {
      const r = m.reference
      if (m.work_id != null) {
        // A work may already be cited via a hand-asserted edge. INSERT OR
        // IGNORE keeps the asserted row (and its provenance) rather than
        // replacing it with a parsed duplicate — the unique index on
        // (citing, cited, type) makes them the same edge.
        insertEdge.run(input.workId, m.work_id, now, m.confidence, m.method)
        // Looked up by NATURAL KEY, never from `lastInsertRowid`: an
        // INSERT OR IGNORE that ignored reports the id of whatever ran before
        // it, so trusting it would attach this entry's contexts to an unrelated
        // edge — silently, and with a plausible-looking id.
        const edge = db
          .prepare(
            `SELECT id FROM citation_edge
              WHERE citing_work_id = ? AND cited_work_id = ? AND edge_type = 'cites'`
          )
          .get(input.workId, m.work_id) as { id: number } | undefined
        if (!edge) {
          throw new Error(
            `storeParse: entry ${r.ordinal} matched work ${m.work_id} but no citation_edge exists`
          )
        }
        entries.push({
          ordinal: r.ordinal,
          rawBibText: r.raw_bib_text,
          citedWorkId: m.work_id,
          unresolvedReferenceId: null,
          edgeId: edge.id,
          authors: r.authors,
          year: r.year,
          title: r.title,
          charStart: r.char_start,
          charEnd: r.char_end,
          partLabel: r.part_label
        })
        matched++
      } else {
        const info = insertUnresolved.run(
          input.workId,
          r.raw_bib_text,
          r.doi,
          r.title,
          now,
          r.year,
          r.authors,
          r.venue,
          r.ordinal,
          r.part_label
        )
        entries.push({
          ordinal: r.ordinal,
          rawBibText: r.raw_bib_text,
          citedWorkId: null,
          unresolvedReferenceId: Number(info.lastInsertRowid),
          edgeId: null,
          authors: r.authors,
          year: r.year,
          title: r.title,
          charStart: r.char_start,
          charEnd: r.char_end,
          partLabel: r.part_label
        })
      }
    }

    db.prepare(
      `INSERT INTO work_citation_parse
         (work_id, document_id, parser_version, doc_sha, corpus_size, reference_count,
          matched_count, section_strategy, entry_style, no_text_layer, parsed_at)
       VALUES (@work_id, @document_id, @parser_version, @doc_sha, @corpus_size, @reference_count,
               @matched_count, @section_strategy, @entry_style, @no_text_layer, @parsed_at)
       ON CONFLICT(work_id) DO UPDATE SET
         document_id=excluded.document_id, parser_version=excluded.parser_version,
         doc_sha=excluded.doc_sha, corpus_size=excluded.corpus_size,
         reference_count=excluded.reference_count, matched_count=excluded.matched_count,
         section_strategy=excluded.section_strategy, entry_style=excluded.entry_style,
         no_text_layer=excluded.no_text_layer, parsed_at=excluded.parsed_at`
    ).run({
      work_id: input.workId,
      document_id: input.documentId,
      parser_version: PARSER_VERSION,
      doc_sha: input.docSha,
      corpus_size: input.corpusSize,
      // What the paper PRINTED, not how many rows the parse made of it. This
      // column is read as "this paper has N references"; storing the row count
      // told an ACS paper's reader it had 83 when the page shows 44.
      reference_count: printedReferenceCount(input.references),
      // Rows, correctly: a matched PART is a real cited paper this corpus now
      // has an edge to, and hiding it would understate what actually resolved.
      matched_count: matched,
      section_strategy: input.diagnostics.section_strategy,
      entry_style: input.diagnostics.entry_style,
      no_text_layer: input.diagnostics.no_text_layer ? 1 : 0,
      parsed_at: now
    })
  })

  tx()
  return entries
}

/**
 * Move an unresolved reference's in-text contexts onto the edge it resolved to.
 *
 * Called BEFORE the `unresolved_reference` row is deleted, inside the caller's
 * own transaction. Without it, resolving a reference — the good outcome —
 * destroys every scrap of evidence about where in the paper it was cited, via
 * the `ON DELETE CASCADE` on `unresolved_reference_id`.
 *
 * The repoint touches no column of `ux_citation_context_site`
 * (`document_id, callout_offset, ordinal`), so it cannot collide: two
 * bibliography entries naming the same work share one edge but keep distinct
 * ordinals. The edge is proved to exist rather than assumed, because the
 * alternative is a context row whose XOR check passes while pointing nowhere.
 */
export function promoteReferenceEntry(
  db: DB,
  input: {
    unresolvedReferenceId: number
    citingWorkId: number
    citedWorkId: number
    /**
     * Passed rather than assumed `'cites'`. The user-driven resolve accepts an
     * edge type, and hard-coding one here would silently find no edge for any
     * other — leaving the contexts on a row about to be deleted, which is the
     * exact cascade this function exists to prevent.
     */
    edgeType?: string
  }
): { edgeId: number; movedContexts: number } {
  const edgeType = input.edgeType ?? 'cites'
  const edge = db
    .prepare(
      `SELECT id FROM citation_edge
        WHERE citing_work_id = ? AND cited_work_id = ? AND edge_type = ?`
    )
    .get(input.citingWorkId, input.citedWorkId, edgeType) as { id: number } | undefined
  if (!edge) {
    throw new Error(
      `promoteReferenceEntry: no citation_edge ${input.citingWorkId} -> ${input.citedWorkId} (${edgeType})`
    )
  }

  // Counted BEFORE the update and compared to what the update actually moved.
  // Scoped to ONE entry and read inside the caller's transaction, so it is
  // exact and immune to a concurrent parse of another document — a corpus-wide
  // before/after count would be satisfied by a delete plus an insert AND would
  // race a legitimate `storeParse` elsewhere. Throwing rolls the caller back:
  // a promotion that cannot carry its evidence does not happen at all.
  const expected = (
    db
      .prepare('SELECT COUNT(*) AS n FROM citation_context WHERE unresolved_reference_id = ?')
      .get(input.unresolvedReferenceId) as { n: number }
  ).n

  // ONE statement sets both columns, so the XOR check is never observed in a
  // violating state, and it touches no column of `ux_citation_context_site`
  // (`document_id, callout_offset, ordinal`) — so the repoint cannot collide
  // even when two bibliography entries resolved to the same deduped edge.
  const info = db
    .prepare(
      `UPDATE citation_context
          SET edge_id = ?, unresolved_reference_id = NULL
        WHERE unresolved_reference_id = ?`
    )
    .run(edge.id, input.unresolvedReferenceId)
  if (info.changes !== expected) {
    throw new Error(
      `promoteReferenceEntry: repointed ${info.changes} of ${expected} context(s) ` +
        `for unresolved reference ${input.unresolvedReferenceId}`
    )
  }

  adoptReferenceAbstract(db, {
    unresolvedReferenceId: input.unresolvedReferenceId,
    citedWorkId: input.citedWorkId
  })

  clearRefsArtifactEntry(db, {
    unresolvedReferenceId: input.unresolvedReferenceId,
    citingWorkId: input.citingWorkId,
    citedWorkId: input.citedWorkId,
    edgeType
  })
  return { edgeId: edge.id, movedContexts: info.changes }
}

/**
 * Keep an abstract fetched for a bibliography entry once that entry becomes a work.
 *
 * Called inside the promotion transaction and BEFORE the caller deletes the
 * `unresolved_reference` row. The row's `work_id` is filled here; its
 * `unresolved_reference_id` is then set NULL by the FK's `ON DELETE SET NULL`,
 * so there is no window in which the row names an id that no longer exists.
 * That window would not be a harmless dangle for the reason this file's header
 * gives at `forgetUnresolvedEntry`: SQLite REUSES a deleted row's id, so a
 * lingering reference is a future misattribution of one paper's abstract to a
 * different bibliography entry. `citing_work_id` is untouched throughout and
 * remains the anchor.
 *
 * The `reference_abstract` row is KEPT, never deleted. It is the record of what
 * an index said and when, and discarding it at promotion would make "where did
 * this abstract come from?" unanswerable at exactly the moment the abstract
 * became visible.
 *
 * COPYING INTO `work.abstract` — the rule, and why it is this narrow:
 *
 *   - A DOI-matched abstract may be copied, and ONLY if `work.abstract` is
 *     currently empty. A keyed lookup has no matching step in it: the index
 *     either holds that identifier or it does not, so the text belongs to that
 *     paper.
 *   - A TITLE-matched abstract is NEVER copied. `work` has no provenance
 *     column, so an inferred abstract sitting in it reads as established fact
 *     and nothing downstream can tell it apart from one that came from the
 *     paper itself. It stays in `reference_abstract`, where `matched_by` and
 *     `match_confidence` travel with it and the UI can badge it.
 *   - A non-empty `work.abstract` is never overwritten, by either path. What is
 *     already there came from an import that knew the paper's identity; ours
 *     came from a bibliography entry, which is the weaker claim even when the
 *     DOI matched.
 */
export function adoptReferenceAbstract(
  db: DB,
  input: { unresolvedReferenceId: number; citedWorkId: number }
): void {
  const haveTable = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reference_abstract'`)
    .get()
  if (!haveTable) return

  db.prepare('UPDATE reference_abstract SET work_id = ? WHERE unresolved_reference_id = ?').run(
    input.citedWorkId,
    input.unresolvedReferenceId
  )

  db.prepare(
    `UPDATE work
        SET abstract = (
              SELECT ra.abstract FROM reference_abstract ra
               WHERE ra.unresolved_reference_id = ?
                 AND ra.outcome = 'found'
                 AND ra.matched_by = 'doi'
                 AND ra.abstract IS NOT NULL AND ra.abstract <> '')
      WHERE id = ?
        AND (abstract IS NULL OR abstract = '')
        AND EXISTS (
              SELECT 1 FROM reference_abstract ra
               WHERE ra.unresolved_reference_id = ?
                 AND ra.outcome = 'found'
                 AND ra.matched_by = 'doi'
                 AND ra.abstract IS NOT NULL AND ra.abstract <> '')`
  ).run(input.unresolvedReferenceId, input.citedWorkId, input.unresolvedReferenceId)
}

/**
 * Retract a bibliography entry's claim on an `unresolved_reference` row that is
 * about to be deleted, WITHOUT resolving it to anything.
 *
 * Every path that deletes an unresolved row must call this or
 * `promoteReferenceEntry`, and the reason is sharper than housekeeping.
 * `unresolved_reference.id` is a bare INTEGER PRIMARY KEY, so SQLite REUSES a
 * deleted row's id for the next insert. An artifact still naming the dead id
 * therefore does not merely dangle — a later parse hands that id to a different
 * bibliography entry, and the next stage-7 run attaches this paper's callouts
 * to the WRONG reference. Misattributed evidence, not missing evidence, and
 * nothing in the output looks wrong.
 */
export function forgetUnresolvedEntry(
  db: DB,
  input: { unresolvedReferenceId: number; citingWorkId: number }
): void {
  clearRefsArtifactEntry(db, { ...input, citedWorkId: null })
}

/**
 * Keep the parse's published entry list true across a promotion.
 *
 * The sweep resolves a reference WITHOUT re-running the `references` stage, so
 * an untouched artifact keeps naming an `unresolved_reference` id that no
 * longer exists — and a later stage-7 run (a re-segment supersedes stage 7 but
 * not stage 6) would then try to attach a context to a deleted row and drop
 * every callout of that entry instead.
 *
 * A work with several documents has one current `references` run per document,
 * so this can match more than one artifact. Every match is patched and the
 * entry is found by `unresolved_reference_id`, which is globally unique — the
 * other documents' artifacts are no-ops rather than wrong.
 *
 * On a DB whose pipeline tables predate this it is a zero-row no-op.
 */
function clearRefsArtifactEntry(
  db: DB,
  input: {
    unresolvedReferenceId: number
    citingWorkId: number
    citedWorkId: number | null
    edgeType?: string
  }
): void {
  const haveArtifact = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stage_artifact'`)
    .get()
  if (!haveArtifact) return

  const rows = db
    .prepare(
      `SELECT a.stage_run_id AS runId, a.json AS json
         FROM stage_artifact a
         JOIN stage_run r ON r.id = a.stage_run_id
        WHERE a.key = 'refs.parsed@v1'
          AND r.stage = 'references'
          AND r.work_id = ?
          AND r.superseded = 0`
    )
    .all(input.citingWorkId) as Array<{ runId: number; json: string }>

  const update = db.prepare('UPDATE stage_artifact SET json = ? WHERE stage_run_id = ? AND key = ?')
  for (const row of rows) {
    let value: { entries?: Array<Record<string, unknown>> }
    try {
      value = JSON.parse(row.json)
    } catch {
      // A blob we cannot read is left exactly as it is. Rewriting it from a
      // guess would replace an unreadable artifact with a confidently wrong
      // one, and the parse it describes is regenerable.
      continue
    }
    const entries = value.entries
    if (!Array.isArray(entries)) continue
    let touched = false
    for (const entry of entries) {
      if (entry.unresolvedReferenceId !== input.unresolvedReferenceId) continue
      entry.unresolvedReferenceId = null
      entry.citedWorkId = input.citedWorkId
      // The edge TYPE travels with the work, because the re-select needs both
      // halves of the key. A resolve may create an `extends` or `refutes` edge
      // rather than a `cites` one, and a consumer that assumed `cites` would
      // find no edge and silently drop every callout of this entry.
      entry.edgeType = input.edgeType ?? null
      // `edgeId` is NOT written here. It is authoritative in `citation_edge`
      // and stage 7 re-selects it on the unique key at run time; carrying a
      // second copy would go stale on every path that changes an edge without
      // re-parsing (curation, `deleteWork`, the `source='parsed'` purge).
      entry.edgeId = null
      touched = true
    }
    if (touched) update.run(JSON.stringify(value), row.runId, 'refs.parsed@v1')
  }
}

/** Every work in the DB, shaped for the matcher. */
export function loadCorpusWorks(db: DB): CorpusWork[] {
  const rows = db
    .prepare(
      `SELECT w.id AS work_id, w.title, w.publication_year AS year, w.venue,
              (SELECT i.value FROM identifier i
                WHERE i.work_id = w.id AND i.scheme = 'doi' LIMIT 1) AS doi
         FROM work w`
    )
    .all() as Array<{
    work_id: number
    title: string
    year: number | null
    venue: string | null
    doi: string | null
  }>

  const authors = db
    .prepare(
      `SELECT wa.work_id, a.family_name AS family
         FROM work_author wa JOIN author a ON a.id = wa.author_id
        ORDER BY wa.work_id, wa.position`
    )
    .all() as Array<{ work_id: number; family: string | null }>

  const byWork = new Map<number, string[]>()
  for (const a of authors) {
    if (!a.family) continue
    const list = byWork.get(a.work_id) ?? []
    list.push(a.family)
    byWork.set(a.work_id, list)
  }

  return rows.map((r) => ({
    work_id: r.work_id,
    title: r.title,
    year: r.year,
    doi: r.doi,
    venue: r.venue,
    author_surnames: byWork.get(r.work_id) ?? []
  }))
}

/**
 * Which stored parses need PARSING again, and why.
 *
 * A PARSE is stale when the parser changed or when there is none — and for no
 * other reason. It used to also report `corpus`, comparing the stored
 * `corpus_size` against the current one, on the argument that adding a paper
 * can turn an unresolved reference into a real edge.
 *
 * That is true and it is not a fact about the PARSE. Re-reading the same PDF
 * with the same parser produces the same bibliography however large the library
 * has grown; what changes is only what those entries can be MATCHED to, and
 * matching has its own mechanism — `rematchUnresolved`, which the corpus-scoped
 * `resolve-references` stage runs on every import and which touches no PDF at
 * all.
 *
 * Keeping it here made a permanent false alarm. Once `references` stopped
 * hashing the corpus size (it was invalidating every paper on every import),
 * nothing re-runs a parse on corpus growth, so `corpus_size` stays frozen at
 * whatever it was and the complaint never clears. Measured on the real corpus:
 * one import took this from 0 to 36 papers reported `corpus`-stale, and
 * `parse:citations --stale` would have re-read every one of those PDFs, on
 * every invocation, for ever.
 *
 * `corpus_size` is still STORED — it is a true record of the library the parse
 * was taken against, and cheap — it just no longer means the parse is wrong.
 */
export function findStaleParses(
  db: DB
): Array<{ work_id: number; reason: 'parser' | 'missing' }> {
  const rows = db
    .prepare(
      `SELECT w.id AS work_id, p.parser_version
         FROM work w LEFT JOIN work_citation_parse p ON p.work_id = w.id`
    )
    .all() as Array<{ work_id: number; parser_version: string | null }>

  const out: Array<{ work_id: number; reason: 'parser' | 'missing' }> = []
  for (const r of rows) {
    if (r.parser_version == null) out.push({ work_id: r.work_id, reason: 'missing' })
    else if (r.parser_version !== PARSER_VERSION) out.push({ work_id: r.work_id, reason: 'parser' })
  }
  return out
}

/**
 * Re-match the STORED unresolved references of every work against the current
 * corpus, WITHOUT touching a single PDF.
 *
 * This is the cheap half of invalidation — the one that runs when a paper is
 * added. It promotes references that now resolve into real `citation_edge`
 * rows and leaves the rest unresolved.
 *
 * Returns the number of references promoted, so callers can report the effect
 * of an ingest honestly ("adding this paper revealed 7 existing citations").
 */
export function rematchUnresolved(db: DB): number {
  const corpus = loadCorpusWorks(db)
  const corpusSize = corpus.length
  const now = new Date().toISOString()

  const citing = db
    .prepare('SELECT DISTINCT citing_work_id AS id FROM unresolved_reference')
    .all() as Array<{ id: number }>

  let promoted = 0

  const tx = db.transaction(() => {
    const insertEdge = db.prepare(
      `INSERT OR IGNORE INTO citation_edge
         (citing_work_id, cited_work_id, edge_type, created_at, source, match_confidence, match_method)
       VALUES (?, ?, 'cites', ?, 'parsed', ?, ?)`
    )
    const delUnresolved = db.prepare('DELETE FROM unresolved_reference WHERE id = ?')

    for (const { id: workId } of citing) {
      const rows = db
        .prepare(
          `SELECT id, raw_bib_text, guessed_doi, guessed_title, guessed_year,
                  guessed_authors, guessed_venue, ordinal, part_label
             FROM unresolved_reference WHERE citing_work_id = ? ORDER BY ordinal, id`
        )
        .all(workId) as Array<{
        id: number
        raw_bib_text: string
        guessed_doi: string | null
        guessed_title: string | null
        guessed_year: number | null
        guessed_authors: string | null
        guessed_venue: string | null
        ordinal: number | null
        part_label: string | null
      }>

      // Rebuild ParsedReference values from storage.
// `surnames`, `volume` and `pages` are derived rather than stored: each is
      // a pure function of text we already have, and storing a derived field
      // invites the two drifting apart.
      const refs: ParsedReference[] = rows.map((r) => ({
        ordinal: r.ordinal ?? 0,
        raw_bib_text: r.raw_bib_text,
        // NO REGION. Re-matching reads the stored TEXT of a reference, never the
        // document it came from, so where it was printed is not recoverable
        // here — and only matching is being redone, which does not care. The
        // sentinel says so; a zero would fence off the top of the paper.
        char_start: -1,
        char_end: -1,
        // READ BACK, not re-derived. This is why the column exists: the -1
        // above is now shared by "re-hydrated" and "part of a composite", so
        // the span can no longer hint at which this is, and the stored letter
        // is the only thing that still knows.
        part_label: r.part_label,
        authors: r.guessed_authors,
        surnames: r.guessed_authors ? extractSurnames(r.guessed_authors) : [],
        year: r.guessed_year,
        title: r.guessed_title,
        venue: r.guessed_venue,
        ...volumeAndPages(r.raw_bib_text),
        doi: r.guessed_doi
      }))

      // Works a reference of THIS bibliography already claimed — and only
      // those. `matchReferences` gives each work to at most one reference of
      // the batch it is handed, but this paper's references are matched across
      // TWO batches: the ones `storeParse` resolved, and the residue re-offered
      // here. A PARSED edge is exactly the record of the first batch's result,
      // so honouring it extends that one-work-per-reference rule across the
      // split rather than restating it.
      //
      // An ASSERTED edge is not that record and must not be read as one. It is
      // a curated claim about two papers, corresponding to no reference at all,
      // and treating it as a consumed match made a resolvable reference
      // permanently unresolvable: w19's entry 11 (Zanghellini 2006) parses
      // perfectly, names a paper in this library, and stayed in
      // `unresolved_reference` with its two in-text callouts hanging off a row
      // that should not exist — because a seeded edge to that paper happened to
      // be there.
      //
      // Dropping the filter altogether is the other error, and it is worse: it
      // frees a work whose reference genuinely was matched to be claimed a
      // SECOND time by a near-miss. w11 cites Kemp & Casey twice — part I in
      // J. Org. Chem. (entry 26, matched) and part III in JACS (entry 6, whose
      // title the text layer truncated to the series stem, so the series veto
      // cannot fire) — and with nothing withheld, entry 6 takes part I's work.
      const claimed = new Set(
        (
          db
            .prepare(
              `SELECT cited_work_id AS id FROM citation_edge
                WHERE citing_work_id = ? AND source = 'parsed'`
            )
            .all(workId) as Array<{ id: number }>
        ).map((x) => x.id)
      )
      const available = corpus.filter((w) => w.work_id !== workId && !claimed.has(w.work_id))

      const matches = matchReferences(refs, available, { excludeWorkId: workId })
      matches.forEach((m, i) => {
        if (m.work_id == null) return
        insertEdge.run(workId, m.work_id, now, m.confidence, m.method)
        // BEFORE the delete: the row's `ON DELETE CASCADE` would otherwise take
        // this reference's in-text contexts with it, so resolving a reference
        // — the thing we wanted — would destroy the evidence of where it was
        // cited. Same transaction, so the move and the delete are atomic.
        promoteReferenceEntry(db, {
          unresolvedReferenceId: rows[i].id,
          citingWorkId: workId,
          citedWorkId: m.work_id
        })
        delUnresolved.run(rows[i].id)
        promoted++
      })

      // The stored parse is now consistent with this corpus size.
      db.prepare(
        `UPDATE work_citation_parse
            SET corpus_size = ?,
                matched_count = (SELECT COUNT(*) FROM citation_edge
                                  WHERE citing_work_id = ? AND source = 'parsed')
          WHERE work_id = ?`
      ).run(corpusSize, workId, workId)
    }

    // Works with no unresolved rows still need their corpus_size refreshed, or
    // they would be reported stale forever.
    db.prepare('UPDATE work_citation_parse SET corpus_size = ? WHERE corpus_size != ?').run(
      corpusSize,
      corpusSize
    )
  })

  tx()
  return promoted
}
