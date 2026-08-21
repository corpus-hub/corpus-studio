// Putting an archived project back into a database that already has its own.
//
// ONE TRANSACTION, and that is the central guarantee. A half-imported project —
// papers without their analyses, facts pointing at runs that were never
// inserted — would look like a successful import and be wrong in ways nobody
// could see. Either the whole project arrives or the database is untouched.
//
// EVERY ID IS REMAPPED. The archive carries the ids the rows had where they
// were written, purely so its parts can reference each other. The receiving
// database has its own rows at those numbers, so nothing may be inserted with
// its original id: each table is inserted, its new id recorded against the old
// one, and every reference rewritten through that map. A missed remap is the
// failure mode this file is shaped to prevent, which is why the maps are named
// after their tables and used consistently rather than inlined.
//
// PAPERS ARE DEDUPLICATED BY TEXT, not by bytes and not by DOI.
// The app re-processes PDFs to reduce their size, so the same paper legitimately
// has different bytes on two machines — a hash of the file would call every
// re-imported paper new. DOI is absent often enough to be unusable alone, and
// titles collide. What identifies a paper is what it SAYS, so the match is a
// hash of its extracted body, built by the same recipe `freshness.ts` uses to
// decide whether an analysis is stale. When a local work says the same thing,
// the ontology's rule applies: a work is global and stored ONCE, so the import
// attaches to it and contributes only this project's own reading.

import { createHash } from 'node:crypto'
import type { DB } from '../db/connection'
import { relayNow } from '../db/connection'
import { storeLibraryBytes } from '../db/library'
import { managedBaseDirId } from '../db/repos/fileLocations'
import { createProjectRow, importSchemaBundle } from '../db/repositories'
import { recomputeRanks } from '../rerank/store'
import { ensureActiveSpace, ensureVecTable } from '../embedding/space'
import type { ProjectArchive, Row } from './types'
import type { SchemaBundleDTO } from '@shared/contract'

/** What an import did, in the terms the user asked about. */
export interface ImportReport {
  projectId: number
  projectName: string
  worksCreated: number
  /** Papers already in the library, matched by their text and reused. */
  worksReused: number
  documents: number
  pdfsStored: number
  analyses: number
  facts: number
  measurements: number
  summaries: number
  citationEdges: number
  chunks: number
  /** Vectors kept, or the reason they were not. */
  vectors: { kept: number; reason: string | null }
  /** Anything that could not be brought across, in the user's words. */
  warnings: string[]
}

/** Old id -> new id, for one table. */
type IdMap = Map<number, number>

const num = (v: unknown): number | null => (typeof v === 'number' ? v : null)

/**
 * The text that identifies a paper.
 *
 * Deliberately the SAME recipe as `freshness.ts:readDocumentBody` — every
 * non-reference paragraph, in order, joined by blank lines. That function is
 * already the app's definition of "the text of this document" for deciding
 * whether an analysis is stale, and having two definitions of the same thing is
 * how they drift.
 *
 * Then normalised before hashing, because the question is whether two files SAY
 * the same thing, not whether they were typeset the same way: whitespace runs
 * collapse (a re-processed PDF re-flows lines), and case is folded. Ligatures
 * and hyphenation are deliberately NOT normalised — that is a rabbit hole, and
 * a false negative here is harmless (a duplicate work) while a false positive
 * would merge two different papers.
 */
function normaliseBody(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

function bodyHash(text: string): string {
  return createHash('sha256').update(normaliseBody(text)).digest('hex')
}

/**
 * Body hashes of every work already in this database, mapped to the work.
 *
 * Built once for the whole import rather than queried per paper: an archive of
 * a thousand papers against a library of a thousand would otherwise be a
 * million-row scan. Works whose text is ambiguous — more than one live
 * paragraph inventory, exactly the case `readDocumentBody` returns null for —
 * are left out, so an uncertain match never happens at all.
 */
function localBodyHashes(db: DB): Map<string, number> {
  const rows = db
    .prepare(
      /* sql */ `
      SELECT dp.document_id AS document_id, d.work_id AS work_id,
             dp.stage_run_id AS stage_run_id, dp.text AS text, dp.idx AS idx
        FROM document_paragraph dp
        JOIN stage_run sr ON sr.id = dp.stage_run_id AND sr.superseded = 0
        JOIN document d ON d.id = dp.document_id
       WHERE dp.kind != 'reference'
       ORDER BY dp.document_id, dp.idx
    `
    )
    .all() as Array<{
    document_id: number
    work_id: number
    stage_run_id: number
    text: string
    idx: number
  }>

  const byDoc = new Map<number, { workId: number; runs: Set<number>; parts: string[] }>()
  for (const r of rows) {
    let e = byDoc.get(r.document_id)
    if (!e) {
      e = { workId: r.work_id, runs: new Set(), parts: [] }
      byDoc.set(r.document_id, e)
    }
    e.runs.add(r.stage_run_id)
    e.parts.push(r.text)
  }

  const out = new Map<string, number>()
  for (const e of byDoc.values()) {
    // Two live inventories means the current body is genuinely ambiguous —
    // `readDocumentBody` refuses to answer in that case, and so does this.
    if (e.runs.size !== 1 || e.parts.length === 0) continue
    out.set(bodyHash(e.parts.join('\n\n')), e.workId)
  }
  return out
}

/** The same, for the works inside the archive. */
function archiveBodyHashes(a: ProjectArchive): Map<number, string> {
  const docWork = new Map<number, number>()
  for (const d of a.works.document) {
    const id = num(d.id)
    const wid = num(d.work_id)
    if (id !== null && wid !== null) docWork.set(id, wid)
  }

  const byDoc = new Map<number, { runs: Set<number>; parts: Array<{ idx: number; text: string }> }>()
  for (const p of a.text.document_paragraph) {
    if (p.kind === 'reference') continue
    const docId = num(p.document_id)
    const runId = num(p.stage_run_id)
    if (docId === null || typeof p.text !== 'string') continue
    let e = byDoc.get(docId)
    if (!e) {
      e = { runs: new Set(), parts: [] }
      byDoc.set(docId, e)
    }
    if (runId !== null) e.runs.add(runId)
    e.parts.push({ idx: num(p.idx) ?? 0, text: p.text })
  }

  const out = new Map<number, string>()
  for (const [docId, e] of byDoc) {
    if (e.runs.size !== 1 || e.parts.length === 0) continue
    const wid = docWork.get(docId)
    if (wid === undefined) continue
    const body = e.parts.sort((x, y) => x.idx - y.idx).map((x) => x.text).join('\n\n')
    // First document wins for a work with several; they are versions of one
    // paper and any of their bodies identifies it.
    if (!out.has(wid)) out.set(wid, bodyHash(body))
  }
  return out
}

/**
 * Insert a row verbatim minus `id`, returning the new one.
 *
 * Column names are DOUBLE-QUOTED. `evidence_span` has columns called `table`
 * and `row`, both SQL keywords, and an unquoted list is a syntax error the
 * moment an evidence span is inserted — which is to say, on every real import.
 */
function insertRow(db: DB, table: string, row: Row, overrides: Row = {}): number {
  const merged: Row = { ...row, ...overrides }
  delete merged.id
  const cols = Object.keys(merged)
  const info = db
    .prepare(
      `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(',')}) ` +
        `VALUES (${cols.map(() => '?').join(',')})`
    )
    .run(...cols.map((c) => merged[c] as never))
  return Number(info.lastInsertRowid)
}

/**
 * Restore an archive as a NEW project in this database.
 *
 * Never merges into an existing project: an archive is a snapshot of a project
 * as it was, and folding it into one that has moved on since would produce a
 * state neither of them was ever in, with no way back.
 */
export function restoreProjectArchive(db: DB, a: ProjectArchive, now: string): ImportReport {
  const warnings: string[] = []

  // PDFs land on DISK OUTSIDE the transaction, deliberately. A rollback cannot
  // unwrite a file, so writing them inside would leave orphans behind on
  // failure; written first, a failed import leaves at worst some unreferenced
  // bytes in the library, which `storeLibraryBytes` will reuse rather than
  // duplicate on the next attempt. Data loss is the thing being avoided, and an
  // unreferenced file is not that.
  const storedPdfs = new Map<string, { relativePath: string; sizeBytes: number | null }>()
  for (const [archivePath, bytes] of a.pdfs) {
    const preferred = archivePath.slice('pdfs/'.length)
    const res = storeLibraryBytes(preferred, bytes)
    if (res.outcome === 'failed') {
      warnings.push(`could not store ${preferred}: ${res.error ?? 'unknown error'}`)
      continue
    }
    storedPdfs.set(archivePath, { relativePath: res.relativePath, sizeBytes: res.sizeBytes })
  }

  const report = db.transaction((): ImportReport => {
    // ---- the project ----------------------------------------------------
    const srcProject = a.project.project
    const projectName = String(srcProject.name ?? 'Imported project')
    const projectId = createProjectRow(
      db,
      { name: projectName, description: String(srcProject.description ?? '') },
      now
    )
    // Carried over separately: `createProjectRow` owns name/slug/description
    // (it derives a unique slug), and these two are the project's own metadata
    // rather than its identity.
    // `updated_at` explicitly rather than left to v44's trigger, so a project
    // created a statement ago does not read as edited after import — but stamped
    // from `relayNow()`, NOT the local `now`. `updated_at` on a synced table is
    // read by the merge as RELAY time, so a machine whose clock runs fast would
    // otherwise win last-write-wins on this row against every peer. One clock, one
    // stamping path.
    db.prepare('UPDATE project SET category = ?, tags = ?, updated_at = ? WHERE id = ?').run(
      srcProject.category ?? null,
      srcProject.tags ?? null,
      relayNow(),
      projectId
    )

    // ---- schemas: the archive's KEY -> a local schema id -----------------
    //
    // Bundles and `schema_keys` are emitted in the same order by the builder,
    // so they pair by INDEX. Matching them by name or key instead would go
    // wrong exactly when a local schema of the same name already exists, which
    // is the common case this map has to get right.
    const schemaIdBySrcKey = new Map<string, number>()
    const bundles = a.schemas as SchemaBundleDTO[]
    for (const [i, bundle] of bundles.entries()) {
      const srcKey = a.project.schema_keys[i]
      const existing = db
        .prepare('SELECT id FROM extraction_schema WHERE name = ?')
        .get(bundle.name) as { id: number } | undefined
      // Reused by NAME when one is already here. A user who has "Enzyme
      // Kinetics" does not want a second per imported project; and where their
      // version has diverged, theirs is what their other analyses were run
      // against, so theirs wins.
      const id = existing ? existing.id : importSchemaBundle(db, bundle, now).id
      if (srcKey !== undefined) schemaIdBySrcKey.set(srcKey, id)
    }
    let order = 0
    for (const key of a.project.schema_keys) {
      const sid = schemaIdBySrcKey.get(key)
      if (sid === undefined) continue
      db.prepare(
        `INSERT OR IGNORE INTO project_schema (project_id, schema_id, sort_order, created_at)
         VALUES (?, ?, ?, ?)`
      ).run(projectId, sid, order++, now)
    }

    /**
     * A source `schema_id` as a local one, via the key the archive recorded.
     *
     * 0 is the GLOBAL sentinel and stays 0. An unresolvable id also becomes 0
     * rather than being guessed at: `analysis_run` is governed by a
     * partial-unique index that includes `schema_id`, so guessing collapses
     * several schemas' runs onto one id and aborts the whole import.
     */
    const localSchemaId = (srcId: unknown): number => {
      if (typeof srcId !== 'number' || srcId === 0) return 0
      const key = a.analyses.schema_keys?.[String(srcId)]
      if (key === undefined) return 0
      return schemaIdBySrcKey.get(key) ?? 0
    }

    /**
     * A source `field_id` as a local one, via the (schema key, field key) pair
     * the archive recorded.
     *
     * Null when it cannot be resolved — the measurement still arrives, and the
     * Extraction screen already renders an unlinked value under "Unassigned".
     * Dropping the row instead would destroy extracted data because a
     * definition could not be matched, which is exactly the trade
     * `ON DELETE SET NULL` on this column exists to refuse.
     */
    const localFieldId = (srcId: unknown): number | null => {
      if (typeof srcId !== 'number') return null
      const pair = a.analyses.field_keys?.[String(srcId)]
      if (!pair) return null
      const [schemaKey, fieldKey] = pair
      const schemaId = schemaIdBySrcKey.get(schemaKey)
      if (schemaId === undefined) return null
      const row = db
        .prepare('SELECT id FROM extraction_field WHERE schema_id = ? AND key = ?')
        .get(schemaId, fieldKey) as { id: number } | undefined
      return row?.id ?? null
    }

    // ---- works: reuse by text, else insert -------------------------------
    const localHashes = localBodyHashes(db)
    const archiveHashes = archiveBodyHashes(a)
    const workMap: IdMap = new Map()
    let worksCreated = 0
    let worksReused = 0
    // Works that already existed keep their own documents, text and chunks;
    // re-inserting those would duplicate a paper's paragraphs and leave the
    // freshness check with two live inventories, which it reads as "unknown".
    const reusedWorks = new Set<number>()

    for (const w of a.works.work) {
      const oldId = num(w.id)
      if (oldId === null) continue
      const hash = archiveHashes.get(oldId)
      const match = hash ? localHashes.get(hash) : undefined
      if (match !== undefined) {
        workMap.set(oldId, match)
        reusedWorks.add(oldId)
        worksReused++
        continue
      }
      workMap.set(oldId, insertRow(db, 'work', w))
      worksCreated++
    }
    if (worksReused > 0) {
      warnings.push(
        `${worksReused} paper(s) were already in your library and were reused rather than duplicated.`
      )
    }

    // Authors are global people, matched by ORCID then by name.
    const authorMap: IdMap = new Map()
    for (const au of a.works.author) {
      const oldId = num(au.id)
      if (oldId === null) continue
      const found = db
        .prepare(
          `SELECT id FROM author WHERE (orcid IS NOT NULL AND orcid = ?) OR full_name = ? LIMIT 1`
        )
        .get(au.orcid ?? null, au.full_name ?? '') as { id: number } | undefined
      authorMap.set(oldId, found ? found.id : insertRow(db, 'author', au))
    }
    for (const wa of a.works.work_author) {
      const wid = workMap.get(num(wa.work_id) ?? -1)
      const aid = authorMap.get(num(wa.author_id) ?? -1)
      if (wid === undefined || aid === undefined) continue
      if (reusedWorks.has(num(wa.work_id) ?? -1)) continue
      // `affiliation_id` is dropped: affiliations are not carried, and a
      // dangling FK would fail `foreign_key_check` after the migration runner.
      insertRow(db, 'work_author', { ...wa, affiliation_id: null }, { work_id: wid, author_id: aid })
    }
    for (const idf of a.works.identifier) {
      const wid = workMap.get(num(idf.work_id) ?? -1)
      if (wid === undefined || reusedWorks.has(num(idf.work_id) ?? -1)) continue
      db.prepare(
        `INSERT OR IGNORE INTO identifier (work_id, document_id, scheme, value, created_at)
         VALUES (?, NULL, ?, ?, ?)`
      ).run(wid, idf.scheme, idf.value, idf.created_at ?? now)
    }

    // ---- project_work: this project's own reading of each paper ----------
    for (const pw of a.project.project_work) {
      const wid = workMap.get(num(pw.work_id) ?? -1)
      if (wid === undefined) continue
      insertRow(db, 'project_work', pw, { project_id: projectId, work_id: wid })
    }
    // The archive's ranks were computed over the archive's population, and a
    // restore that skipped papers (a work already held, one whose file could
    // not be stored) has a different one. Recomputed here rather than carried
    // over, so the positions describe the project that now exists.
    recomputeRanks(db, projectId)
    for (const s of a.project.saved_search) insertRow(db, 'saved_search', s, { project_id: projectId })
    for (const f of a.project.saved_frontier) {
      insertRow(db, 'saved_frontier', f, { project_id: projectId })
    }

    // ---- documents and their files --------------------------------------
    const baseDirId = managedBaseDirId(db, now)
    const documentMap: IdMap = new Map()
    let pdfsStored = 0
    for (const d of a.works.document) {
      const oldWork = num(d.work_id) ?? -1
      const wid = workMap.get(oldWork)
      if (wid === undefined) continue
      if (reusedWorks.has(oldWork)) {
        // Point the archive's document id at the LOCAL document for this work,
        // so evidence spans and summaries still anchor to a real page.
        const local = db
          .prepare('SELECT id FROM document WHERE work_id = ? ORDER BY is_preferred DESC, id LIMIT 1')
          .get(wid) as { id: number } | undefined
        if (local && num(d.id) !== null) documentMap.set(num(d.id)!, local.id)
        continue
      }
      // `text_source_run_id` names a stage_run that has not been inserted yet;
      // it is repaired below once the run map exists.
      const newId = insertRow(db, 'document', d, { work_id: wid, text_source_run_id: null })
      if (num(d.id) !== null) documentMap.set(num(d.id)!, newId)
    }
    for (const loc of a.works.file_location) {
      const did = documentMap.get(num(loc.document_id) ?? -1)
      if (did === undefined) continue
      if (reusedWorks.has(num(a.works.document.find((d) => d.id === loc.document_id)?.work_id) ?? -1)) {
        continue
      }
      const stored = loc.pdf ? storedPdfs.get(loc.pdf) : undefined
      if (!stored) continue
      const { pdf: _pdf, ...rest } = loc
      insertRow(db, 'file_location', rest, {
        document_id: did,
        base_dir_id: baseDirId,
        relative_path: stored.relativePath,
        size_bytes: stored.sizeBytes
      })
      pdfsStored++
    }

    // ---- stage runs, then the text they own ------------------------------
    const stageRunMap: IdMap = new Map()
    for (const sr of a.text.stage_run) {
      const oldWork = num(sr.work_id)
      const wid = oldWork === null ? null : workMap.get(oldWork)
      if (oldWork !== null && wid === undefined) continue
      if (oldWork !== null && reusedWorks.has(oldWork)) continue
      const did = sr.document_id === null ? null : documentMap.get(num(sr.document_id) ?? -1)
      if (sr.document_id !== null && did === undefined) continue
      const newId = insertRow(db, 'stage_run', sr, {
        work_id: wid ?? null,
        document_id: did ?? null,
        // `project_id = 0` is the GLOBAL sentinel and must stay 0; anything
        // else was this project's and becomes the new project's.
        project_id: sr.project_id === 0 ? 0 : projectId,
        schema_id: localSchemaId(sr.schema_id),
        analysis_run_id: null,
        superseded_by: null
      })
      if (num(sr.id) !== null) stageRunMap.set(num(sr.id)!, newId)
    }
    for (const p of a.text.document_paragraph) {
      const did = documentMap.get(num(p.document_id) ?? -1)
      const srid = stageRunMap.get(num(p.stage_run_id) ?? -1)
      if (did === undefined || srid === undefined) continue
      insertRow(db, 'document_paragraph', p, { document_id: did, stage_run_id: srid })
    }
    for (const wcp of a.text.work_citation_parse) {
      const wid = workMap.get(num(wcp.work_id) ?? -1)
      const did = documentMap.get(num(wcp.document_id) ?? -1)
      if (wid === undefined || did === undefined) continue
      db.prepare(
        `INSERT OR IGNORE INTO work_citation_parse
           (work_id, document_id, parser_version, doc_sha, corpus_size, reference_count,
            matched_count, section_strategy, entry_style, no_text_layer, parsed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        wid,
        did,
        wcp.parser_version,
        wcp.doc_sha,
        wcp.corpus_size,
        wcp.reference_count,
        wcp.matched_count,
        wcp.section_strategy,
        wcp.entry_style,
        wcp.no_text_layer,
        wcp.parsed_at
      )
    }
    // Repair the document -> text_source_run_id link now that runs exist.
    for (const d of a.works.document) {
      const did = documentMap.get(num(d.id) ?? -1)
      const srid = stageRunMap.get(num(d.text_source_run_id) ?? -1)
      if (did === undefined || srid === undefined) continue
      db.prepare('UPDATE document SET text_source_run_id = ? WHERE id = ?').run(srid, did)
    }

    // ---- analyses, replayed verbatim -------------------------------------
    // Provenance is copied UNCHANGED — model, prompt and schema versions, the
    // input hashes, the original timestamp. Restamping any of it would make the
    // row describe a run that never happened, and would break the freshness
    // check, which is a hash equality over exactly those fields.
    const runMap: IdMap = new Map()
    // Runs that already existed locally and were adopted rather than inserted.
    // Their children (spans, facts, measurements) must NOT be re-inserted, or
    // every re-import would double a paper's extracted values.
    const adoptedRuns = new Set<number>()
    const currentRun = db.prepare(
      `SELECT id FROM analysis_run
        WHERE work_id = ? AND project_id = ? AND analysis_type = ? AND schema_id = ?
          AND superseded = 0`
    )
    for (const r of a.analyses.analysis_run) {
      const wid = workMap.get(num(r.work_id) ?? -1)
      if (wid === undefined) continue
      const pid = r.project_id === 0 ? 0 : projectId
      const sid = localSchemaId(r.schema_id)

      // A GLOBAL run (project_id = 0) belongs to the PAPER, not to a project.
      // When the paper was reused, its global runs are already here — and the
      // partial-unique index guarantees exactly one current run per
      // (work, project, type, schema), so inserting a second is not a duplicate
      // to be tolerated, it aborts the import. Adopt the local one instead: it
      // is the same claim about the same paper, and the local copy is what the
      // user's other projects are already reading.
      if (r.superseded === 0) {
        const existing = currentRun.get(wid, pid, r.analysis_type, sid) as
          | { id: number }
          | undefined
        if (existing) {
          if (num(r.id) !== null) {
            runMap.set(num(r.id)!, existing.id)
            adoptedRuns.add(num(r.id)!)
          }
          continue
        }
      }

      const newId = insertRow(db, 'analysis_run', r, {
        work_id: wid,
        project_id: pid,
        schema_id: sid,
        // Re-checked locally rather than trusting another machine's verdict —
        // the same decision `shipped-analyses.ts` records.
        deterministic_validation: 0
      })
      if (num(r.id) !== null) runMap.set(num(r.id)!, newId)
    }

    const spanMap: IdMap = new Map()
    for (const s of a.analyses.evidence_span) {
      const srcRun = num(s.analysis_run_id) ?? -1
      const rid = runMap.get(srcRun)
      // An ADOPTED run already owns its spans, facts and measurements locally.
      // Re-inserting them would attach a second copy of every extracted value
      // to the same run, which is how a re-import silently doubles a corpus.
      if (rid === undefined || adoptedRuns.has(srcRun)) continue
      const did = s.document_id === null ? null : documentMap.get(num(s.document_id) ?? -1)
      const newId = insertRow(db, 'evidence_span', s, {
        analysis_run_id: rid,
        document_id: did ?? null
      })
      if (num(s.id) !== null) spanMap.set(num(s.id)!, newId)
    }

    const factMap: IdMap = new Map()
    // Which facts arrived WITHDRAWN, by the source's check id. Cleared on insert
    // and repointed once the checks exist: the archive's id names a row in
    // ANOTHER database, and copied through it would either violate the foreign
    // key or — worse, since checks are inserted after facts and ids are dense —
    // attach a local verdict about some other record as the reason this one was
    // withdrawn. A retraction that names the wrong reason is unarguable-with.
    const retractedBySource = new Map<number, number>()
    for (const f of a.analyses.fact) {
      const srcRun = num(f.analysis_run_id) ?? -1
      const rid = runMap.get(srcRun)
      if (rid === undefined || adoptedRuns.has(srcRun)) continue
      const sid = f.evidence_span_id === null ? null : spanMap.get(num(f.evidence_span_id) ?? -1)
      const newId = insertRow(db, 'fact', f, {
        analysis_run_id: rid,
        evidence_span_id: sid ?? null,
        retracted_by_check_id: null
      })
      if (num(f.id) !== null) factMap.set(num(f.id)!, newId)
      const srcCheck = num(f.retracted_by_check_id)
      if (srcCheck !== null) retractedBySource.set(newId, srcCheck)
    }

    const measurementMap: IdMap = new Map()
    for (const m of a.analyses.measurement) {
      const fid = factMap.get(num(m.fact_id) ?? -1)
      if (fid === undefined) continue
      const newId = insertRow(db, 'measurement', m, {
        fact_id: fid,
        field_id: localFieldId(m.field_id)
      })
      if (num(m.id) !== null) measurementMap.set(num(m.id)!, newId)
    }
    for (const fi of a.analyses.fold_improvement) {
      const mid = measurementMap.get(num(fi.measurement_id) ?? -1)
      if (mid === undefined) continue
      insertRow(db, 'fold_improvement', fi, { measurement_id: mid })
    }
    const checkMap: IdMap = new Map()
    for (const c of a.analyses.analysis_check) {
      const srcRun = num(c.analysis_run_id) ?? -1
      const rid = runMap.get(srcRun)
      if (rid === undefined || adoptedRuns.has(srcRun)) continue
      const newId = insertRow(db, 'analysis_check', c, {
        analysis_run_id: rid,
        fact_id: c.fact_id === null ? null : (factMap.get(num(c.fact_id) ?? -1) ?? null),
        measurement_id:
          c.measurement_id === null ? null : (measurementMap.get(num(c.measurement_id) ?? -1) ?? null)
      })
      if (num(c.id) !== null) checkMap.set(num(c.id)!, newId)
    }
    // The retractions, now that both sides exist locally. A source check that did
    // not survive the import leaves the fact STANDING rather than withdrawn by
    // an unnamed reader — a withdrawal whose reason is unreachable is one nobody
    // can review, and this app's whole claim is that a judgement is traceable to
    // the reading that made it.
    if (retractedBySource.size > 0) {
      const mark = db.prepare('UPDATE fact SET retracted_by_check_id = ? WHERE id = ?')
      let unreachable = 0
      for (const [factId, srcCheck] of retractedBySource) {
        const local = checkMap.get(srcCheck)
        if (local === undefined) {
          unreachable++
          continue
        }
        mark.run(local, factId)
      }
      // ONE warning, counted. A per-fact message would fill the report with the
      // same sentence and bury the ones beside it.
      if (unreachable > 0) {
        warnings.push(
          `${unreachable} restored record(s) were withdrawn by a review verdict this archive ` +
            'does not carry; they are restored as standing'
        )
      }
    }
    for (const v of a.analyses.fact_verdict) {
      const fid = factMap.get(num(v.fact_id) ?? -1)
      const rid = runMap.get(num(v.analysis_run_id) ?? -1)
      if (fid === undefined || rid === undefined) continue
      insertRow(db, 'fact_verdict', v, {
        fact_id: fid,
        analysis_run_id: rid,
        project_id: projectId
      })
    }
    let summaries = 0
    for (const s of a.analyses.work_summary) {
      const srcRun = num(s.analysis_run_id) ?? -1
      const rid = runMap.get(srcRun)
      // `ux_work_summary_run` is unique on analysis_run_id, so an adopted run
      // already has its prose and a second row is a constraint violation.
      if (rid === undefined || adoptedRuns.has(srcRun)) continue
      const did = s.document_id === null ? null : documentMap.get(num(s.document_id) ?? -1)
      insertRow(db, 'work_summary', s, { analysis_run_id: rid, document_id: did ?? null })
      summaries++
    }

    // ---- citations -------------------------------------------------------
    const edgeMap: IdMap = new Map()
    for (const e of a.citations.citation_edge) {
      const citing = workMap.get(num(e.citing_work_id) ?? -1)
      const cited = workMap.get(num(e.cited_work_id) ?? -1)
      if (citing === undefined || cited === undefined) continue
      const existing = db
        .prepare('SELECT id FROM citation_edge WHERE citing_work_id = ? AND cited_work_id = ?')
        .get(citing, cited) as { id: number } | undefined
      // Reused when both papers were already here and already linked: an edge
      // is a fact about two papers, not about a project, so a second copy would
      // double every citation count in the graph.
      const newId = existing
        ? existing.id
        : insertRow(db, 'citation_edge', e, { citing_work_id: citing, cited_work_id: cited })
      if (num(e.id) !== null) edgeMap.set(num(e.id)!, newId)
    }
    const unresolvedMap: IdMap = new Map()
    for (const u of a.citations.unresolved_reference) {
      const citing = workMap.get(num(u.citing_work_id) ?? -1)
      if (citing === undefined) continue
      const newId = insertRow(db, 'unresolved_reference', u, {
        citing_work_id: citing,
        // A retrieval was another machine's in-flight job. Reset, or this
        // project would arrive with references permanently "retrieving".
        retrieval_job_id: null,
        retrieval_work_id:
          u.retrieval_work_id === null ? null : (workMap.get(num(u.retrieval_work_id) ?? -1) ?? null)
      })
      if (num(u.id) !== null) unresolvedMap.set(num(u.id)!, newId)
    }
    for (const c of a.citations.citation_context) {
      const citing = workMap.get(num(c.citing_work_id) ?? -1)
      if (citing === undefined) continue
      const eid = c.edge_id === null ? null : edgeMap.get(num(c.edge_id) ?? -1)
      const uid =
        c.unresolved_reference_id === null
          ? null
          : unresolvedMap.get(num(c.unresolved_reference_id) ?? -1)
      const did = c.document_id === null ? null : documentMap.get(num(c.document_id) ?? -1)
      const srid = c.stage_run_id === null ? null : stageRunMap.get(num(c.stage_run_id) ?? -1)
      if (srid === undefined) continue
      insertRow(db, 'citation_context', c, {
        citing_work_id: citing,
        edge_id: eid ?? null,
        unresolved_reference_id: uid ?? null,
        document_id: did ?? null,
        stage_run_id: srid ?? null
      })
    }

    // ---- chunks and vectors ----------------------------------------------
    // Vectors are kept ONLY when the archive's space is byte-identical to this
    // machine's. An embedding is a point in a space defined by a specific model
    // at a specific revision with specific pooling — importing one model's
    // vectors into another's index would not fail, it would silently return the
    // wrong papers for every semantic search from then on. That is precisely
    // what the space registry exists to prevent, so a mismatch drops the
    // vectors and says so.
    let chunksInserted = 0
    let vectorsKept = 0
    let vectorReason: string | null = null

    if (a.chunks.chunk.length > 0) {
      // The ACTIVE space if there is one, else the archive's own — matched by
      // `config_hash`, which is the identity of the model that produced these
      // vectors. Importing into a machine that has never embedded anything is
      // the normal case for a fresh install, and refusing there would throw
      // away a perfectly valid index because nothing had asked for one yet.
      let localSpace = db
        .prepare(
          `SELECT id, config_hash, dims, vec_table FROM embedding_space WHERE status = 'active' LIMIT 1`
        )
        .get() as { id: number; config_hash: string; dims: number; vec_table: string } | undefined

      if (!localSpace && a.chunks.space) {
        const s = a.chunks.space
        // Adopt the archive's space. `ensureActiveSpace` is given the identity
        // rather than the hash so it computes `config_hash` itself — if our
        // recreation disagreed with the archive's recorded hash by even one
        // field, the compatibility check below would (correctly) reject the
        // vectors, which is the honest outcome.
        const space = ensureActiveSpace(
          db,
          {
            modelId: s.model_id,
            modelRevision: s.model_revision,
            modelFile: s.model_file,
            dims: s.dims,
            quantization: s.quantization,
            storedQuantization: s.stored_quantization,
            pooling: s.pooling,
            normalized: s.normalized === 1,
            queryPrefix: s.query_prefix,
            docPrefix: s.doc_prefix,
            chunkingVersion: s.chunking_version,
            maxSeqLength: s.max_seq_length,
            textExtractionVersion: s.text_extraction_version,
            runtime: s.runtime
          },
          now
        )
        // The vec0 table has to exist before a vector can be indexed, so it is
        // created before any chunk is written.
        ensureVecTable(db, space)
        localSpace = {
          id: space.id,
          config_hash: space.configHash,
          dims: space.dims,
          vec_table: space.vecTable
        }
      }

      const compatible =
        a.vectors !== null &&
        a.chunks.space !== null &&
        localSpace !== undefined &&
        localSpace.config_hash === a.chunks.space.config_hash

      if (!compatible) {
        vectorReason =
          a.vectors === null
            ? 'the archive carried no vectors'
            : localSpace === undefined
              ? 'this machine has no embedding model set up yet'
              : 'the archive was embedded with a different model'
      }

      // A CHUNK CANNOT EXIST WITHOUT ITS VECTOR: `chunk.vector` and
      // `chunk.space_id` are both NOT NULL, by design — a row in the index that
      // has no embedding is not a partial index, it is a lie about what has
      // been indexed. So when the vectors cannot be used, the chunks go too.
      //
      // That is the right trade rather than a reluctant one. Chunks are DERIVED
      // data: re-running `embed` rebuilds them from text this archive already
      // carries, and until it does, search falls back to keyword matching over
      // the same papers. Keeping a foreign model's vectors instead would not
      // fail — it would quietly return the wrong papers for every semantic
      // search from then on, which is the failure the space registry exists to
      // make impossible.
      if (!compatible) {
        warnings.push(
          localSpace === undefined
            ? 'Semantic search index was not imported — set up an embedding model, then re-index this project.'
            : 'Semantic search index was not imported: it was built with a different embedding model. Re-index this project to rebuild it.'
        )
      }

      // Paragraph text, to rebuild each chunk's `text` from its char range —
      // the substring dropped at export because it duplicates text the archive
      // already carries.
      const bodyByDoc = new Map<number, string>()
      for (const [oldDocId] of documentMap) {
        const parts = a.text.document_paragraph
          .filter((p) => p.document_id === oldDocId)
          .sort((x, y) => (num(x.idx) ?? 0) - (num(y.idx) ?? 0))
        if (parts.length > 0) {
          bodyByDoc.set(oldDocId, parts.map((p) => String(p.text ?? '')).join('\n\n'))
        }
      }

      const dims = a.chunks.space?.dims ?? 0
      for (const [i, c] of compatible ? a.chunks.chunk.entries() : []) {
        const did = documentMap.get(num(c.document_id) ?? -1)
        const wid = workMap.get(num(c.work_id) ?? -1)
        const srid = stageRunMap.get(num(c.stage_run_id) ?? -1)
        if (did === undefined || wid === undefined || srid === undefined) continue

        const body = bodyByDoc.get(num(c.document_id) ?? -1) ?? ''
        const start = num(c.char_start) ?? 0
        const end = num(c.char_end) ?? 0
        const text = body.slice(start, end)

        // Non-null by construction: the loop only runs when `compatible`, and
        // that requires both the vectors and a matching local space.
        const vector = a.vectors!.subarray(i * dims * 4, (i + 1) * dims * 4)

        const newChunkId = insertRow(db, 'chunk', c, {
          stage_run_id: srid,
          document_id: did,
          work_id: wid,
          space_id: localSpace!.id,
          text,
          vector
        })
        chunksInserted++

        const stmt = db.prepare(`INSERT INTO ${localSpace!.vec_table}(chunk_id, v) VALUES (?, ?)`)
        // MANDATORY on a vec0 INTEGER column: better-sqlite3 binds a plain JS
        // number as SQLITE_FLOAT, which vec0 rejects.
        stmt.safeIntegers(true)
        stmt.run(BigInt(newChunkId), vector)
        vectorsKept++
      }
    }

    return {
      projectId,
      projectName,
      worksCreated,
      worksReused,
      documents: documentMap.size,
      pdfsStored,
      analyses: runMap.size,
      facts: factMap.size,
      measurements: measurementMap.size,
      summaries,
      citationEdges: edgeMap.size,
      chunks: chunksInserted,
      vectors: { kept: vectorsKept, reason: vectorReason },
      warnings
    }
  })

  return report.immediate()
}
