// Bring items from a Zotero collection into a Corpus Studio project.
//
// Creates `work` + `project_work` rows (and a `document`/`file_location` when the
// item has a PDF we can actually see), so a user with a curated Zotero
// collection does not have to re-add twenty papers by hand.
//
// WHAT IT DOES NOT DO: invent analysis. An imported paper arrives with its
// bibliographic metadata and nothing else — no relevance, no extracted facts, no
// ranking. Those are claims that only a model that read the paper may make, and
// seeding them from an import would fabricate exactly the provenance this app
// exists to keep honest.

import { existsSync } from 'node:fs'
import { dirname, basename } from 'node:path'
import type { DB } from '../../db/connection'
import type { ZoteroItem } from './library'

export interface ImportSummary {
  added: number
  /** Already present (matched by DOI, or by title+year when no DOI). */
  skipped: number
  /** Added AND had a readable PDF attached. */
  withPdf: number
}

/**
 * Import `items` into `projectId`.
 *
 * Matching is by DOI first — the only identifier that is actually identifying —
 * and falls back to a normalised title+year, which is what catches the preprint
 * a user added before the DOI existed. A false match here means a paper is
 * silently not imported, so the fallback is deliberately strict.
 */
export function importItems(
  db: DB,
  projectId: number,
  items: ZoteroItem[],
  zoteroDataDir: string
): ImportSummary {
  const now = new Date().toISOString()
  const summary: ImportSummary = { added: 0, skipped: 0, withPdf: 0 }

  const findByDoi = db.prepare(
    `SELECT work_id FROM identifier WHERE scheme = 'doi' AND lower(value) = lower(?)`
  )
  const findByTitle = db.prepare(
    `SELECT id FROM work
      WHERE lower(replace(replace(title, ' ', ''), '-', '')) = ?
        AND (publication_year IS ? OR publication_year = ?)`
  )
  const insWork = db.prepare(
    `INSERT INTO work (title, work_type, publication_year, venue, abstract, created_at, updated_at)
     VALUES (?, 'journal-article', ?, ?, NULL, ?, ?)`
  )
  const insIdent = db.prepare(
    `INSERT OR IGNORE INTO identifier (work_id, scheme, value, created_at) VALUES (?, 'doi', ?, ?)`
  )
  const insAuthor = db.prepare(
    `INSERT INTO author (full_name, created_at) VALUES (?, ?) RETURNING id`
  )
  const findAuthor = db.prepare(`SELECT id FROM author WHERE full_name = ?`)
  const linkAuthor = db.prepare(
    `INSERT OR IGNORE INTO work_author (work_id, author_id, position, is_corresponding)
     VALUES (?, ?, ?, 0)`
  )
  const insProjectWork = db.prepare(
    `INSERT OR IGNORE INTO project_work
       (project_id, work_id, relevance, expansion_priority, inclusion_status, created_at, updated_at)
     VALUES (?, ?, NULL, NULL, 'candidate', ?, ?)`
  )
  const insDoc = db.prepare(
    `INSERT INTO document (work_id, version_kind, content_status, retrieval_status, is_preferred, created_at)
     VALUES (?, 'publisher-PDF', 'fulltext', 'retrieved', 1, ?) RETURNING id`
  )
  const findBaseDir = db.prepare(`SELECT id FROM base_dir WHERE abs_path = ?`)
  const insBaseDir = db.prepare(
    `INSERT INTO base_dir (label, abs_path, kind, created_at) VALUES (?, ?, 'local', ?) RETURNING id`
  )
  const insFile = db.prepare(
    `INSERT INTO file_location (document_id, base_dir_id, relative_path, role, version, created_at)
     VALUES (?, ?, ?, 'canonical', 1, ?)`
  )

  const run = db.transaction(() => {
    for (const item of items) {
      const existing = item.doi
        ? (findByDoi.get(item.doi) as { work_id: number } | undefined)?.work_id
        : (
            findByTitle.get(
              item.title.toLowerCase().replace(/[\s-]/g, ''),
              item.year,
              item.year
            ) as { id: number } | undefined
          )?.id

      if (existing !== undefined) {
        // Already known: still ensure it belongs to THIS project, which is the
        // point of importing a collection into it.
        insProjectWork.run(projectId, existing, now, now)
        summary.skipped++
        continue
      }

      const workId = Number(
        insWork.run(item.title, item.year, item.publication, now, now).lastInsertRowid
      )
      if (item.doi) insIdent.run(workId, item.doi, now)
      item.creators.forEach((name, i) => {
        if (!name) return
        const found = findAuthor.get(name) as { id: number } | undefined
        const authorId = found?.id ?? (insAuthor.get(name, now) as { id: number }).id
        linkAuthor.run(workId, authorId, i)
      })
      insProjectWork.run(projectId, workId, now, now)

      // A PDF is recorded only when the file is REALLY there. Zotero can list an
      // attachment whose file was never synced, and a file_location pointing at
      // nothing would surface as a document that mysteriously fails to open.
      if (item.attachmentPath && existsSync(item.attachmentPath)) {
        // ONE storage location for the whole library. A Zotero stored
        // attachment lives in its own `storage/<itemKey>/` folder, so deriving
        // a base dir from the file's parent would insert a location PER PAPER —
        // a 200-item import would fill Settings with 200 rows, none of them
        // removable (each has a document depending on it).
        //
        // A linked file that lives outside the data directory has no relative
        // path within it, so it keeps a location of its own; those are rare and
        // genuinely distinct roots.
        const isStored = item.attachmentRelPath !== null
        const dir = isStored ? zoteroDataDir : dirname(item.attachmentPath)
        const label = isStored ? 'Zotero library' : `Zotero — ${basename(dir)}`
        const relative = item.attachmentRelPath ?? basename(item.attachmentPath)

        const found = findBaseDir.get(dir) as { id: number } | undefined
        const baseDirId =
          found?.id ?? Number((insBaseDir.get(label, dir, now) as { id: number }).id)
        const docId = Number((insDoc.get(workId, now) as { id: number }).id)
        insFile.run(docId, baseDirId, relative, now)
        summary.withPdf++
      }
      summary.added++
    }
  })
  run()
  return summary
}
