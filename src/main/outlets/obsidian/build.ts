// Assemble the data one note needs, from the database.
//
// Separate from `render.ts` (which is pure and shared with the renderer's
// preview) and from `write.ts` (which touches the disk), so each can be reasoned
// about — and tested — on its own.

import type { DB } from '../../db/connection'
import type { NoteInput } from '../../../shared/markdown'
import { getProject, listProjectWorks } from '../../db/repositories'
import { plainText } from '../../../shared/markup'

interface AuthorRow {
  work_id: number
  full_name: string
}
interface DoiRow {
  work_id: number
  value: string
}
interface FactRow {
  work_id: number
  label: string
  value_num: number | null
  value_text: string | null
  unit: string | null
  kind: string
  quote: string | null
  retraction: string | null
}
interface CiteRow {
  citing_work_id: number
  cited_work_id: number
  title: string
  doi: string | null
}
interface RunRow {
  work_id: number
  model: string | null
  run_timestamp: string | null
}

/**
 * Build the note input for every work in a project.
 *
 * One pass of grouped queries rather than per-work lookups: a 500-paper project
 * would otherwise issue thousands of statements and make "write notes" feel
 * broken even though it was working.
 */
export function buildProjectNotes(db: DB, projectId: number): NoteInput[] {
  const project = getProject(db, projectId)
  if (!project) throw new Error(`project ${projectId} not found`)
  const works = listProjectWorks(db, projectId)
  if (works.length === 0) return []

  const ids = works.map((w) => w.work.id)
  const ph = ids.map(() => '?').join(',')

  const authors = new Map<number, string[]>()
  for (const r of db
    .prepare(
      `SELECT wa.work_id, a.full_name
         FROM work_author wa JOIN author a ON a.id = wa.author_id
        WHERE wa.work_id IN (${ph})
        ORDER BY wa.work_id, wa.position ASC`
    )
    .all(...ids) as AuthorRow[]) {
    const list = authors.get(r.work_id) ?? []
    list.push(r.full_name)
    authors.set(r.work_id, list)
  }

  const dois = new Map<number, string>()
  for (const r of db
    .prepare(
      `SELECT work_id, value FROM identifier WHERE scheme = 'doi' AND work_id IN (${ph})`
    )
    .all(...ids) as DoiRow[]) {
    if (!dois.has(r.work_id)) dois.set(r.work_id, r.value)
  }

  // Only CURRENT runs (superseded = 0). A note must describe what the app
  // believes now, not a claim that has since been replaced.
  const facts = new Map<number, NoteInput['facts']>()
  for (const r of db
    .prepare(
      // A RETRACTED value is exported, with the reason the reading gave for
      // withdrawing it (v52). Filtering it out would leave the vault quietly
      // disagreeing with the corpus, and this app's exports never hide extracted
      // data — the note says so instead.
      `SELECT r.work_id,
              COALESCE(ef.label, m.quantity) AS label,
              m.value_num, m.value_text, COALESCE(m.unit, ef.unit) AS unit,
              f.kind, es.quote, rc.reason AS retraction
         FROM measurement m
         JOIN fact f ON f.id = m.fact_id
         JOIN analysis_run r ON r.id = f.analysis_run_id
    LEFT JOIN extraction_field ef ON ef.id = m.field_id
    LEFT JOIN evidence_span es ON es.id = f.evidence_span_id
    LEFT JOIN analysis_check rc ON rc.id = f.retracted_by_check_id
        WHERE r.superseded = 0
          AND r.work_id IN (${ph})
          AND r.project_id IN (0, ?)
        ORDER BY r.work_id, ef.sort_order ASC, m.id ASC`
    )
    .all(...ids, projectId) as FactRow[]) {
    const list = facts.get(r.work_id) ?? []
    list.push({
      label: r.label,
      // The raw as-reported text wins when it says more than the number: ">95"
      // is not 95, and a note that showed only the number would launder a bound
      // into a measurement.
      value: r.value_text ?? (r.value_num !== null ? String(r.value_num) : ''),
      unit: r.unit,
      kind: r.kind,
      evidence: r.quote,
      retraction: r.retraction
    })
    facts.set(r.work_id, list)
  }

  const cites = new Map<number, string[]>()
  const citeRefs = new Map<number, Array<{ id: number; doi: string | null }>>()
  // Restricted to works IN THIS PROJECT (`cited_work_id IN ids`): a citation to
  // a paper the export does not contain cannot become a link to anything, and
  // in Zotero it would be a Related entry pointing at nothing.
  for (const r of db
    .prepare(
      `SELECT ce.citing_work_id, ce.cited_work_id, w.title,
              (SELECT i.value FROM identifier i
                WHERE i.work_id = w.id AND i.scheme = 'doi' LIMIT 1) AS doi
         FROM citation_edge ce JOIN work w ON w.id = ce.cited_work_id
        WHERE ce.citing_work_id IN (${ph}) AND ce.cited_work_id IN (${ph})
        ORDER BY ce.citing_work_id, w.title ASC`
    )
    .all(...ids, ...ids) as CiteRow[]) {
    const list = cites.get(r.citing_work_id) ?? []
    list.push(plainText(r.title))
    cites.set(r.citing_work_id, list)
    const refs = citeRefs.get(r.citing_work_id) ?? []
    refs.push({ id: r.cited_work_id, doi: r.doi })
    citeRefs.set(r.citing_work_id, refs)
  }

  // The PDF on disk, for consumers that attach the file itself (the Zotero RDF).
  // Only the CANONICAL location of the preferred document, and only as an
  // absolute path resolved through its base_dir — the same indirection readPdf
  // uses, so a moved library keeps working.
  const pdfs = new Map<number, string>()
  for (const r of db
    .prepare(
      `SELECT d.work_id, bd.abs_path || '/' || fl.relative_path AS path
         FROM document d
         JOIN file_location fl ON fl.document_id = d.id AND fl.role = 'canonical'
         JOIN base_dir bd ON bd.id = fl.base_dir_id
        WHERE d.work_id IN (${ph})
        ORDER BY d.work_id, d.is_preferred DESC, fl.version DESC`
    )
    .all(...ids) as Array<{ work_id: number; path: string }>) {
    if (!pdfs.has(r.work_id)) pdfs.set(r.work_id, r.path)
  }

  const runs = new Map<number, { model: string | null; runAt: string | null }>()
  for (const r of db
    .prepare(
      `SELECT work_id, model, run_timestamp
         FROM analysis_run
        WHERE superseded = 0 AND work_id IN (${ph}) AND project_id IN (0, ?)
        ORDER BY work_id, run_timestamp DESC`
    )
    .all(...ids, projectId) as RunRow[]) {
    if (!runs.has(r.work_id)) runs.set(r.work_id, { model: r.model, runAt: r.run_timestamp })
  }

  return works.map((pw) => ({
    work: {
      id: pw.work.id,
      // A note is MARKDOWN: HTML tags would render as formatting in some
      // Obsidian views and as literal text in others, and the title is also a
      // filename and a wiki-link target. Plain words are the only stable form.
      title: plainText(pw.work.title),
      venue: pw.work.venue,
      publication_year: pw.work.publication_year,
      doi: dois.get(pw.work.id) ?? null,
      authors: authors.get(pw.work.id) ?? [],
      abstract: pw.work.abstract,
      pdfPath: pdfs.get(pw.work.id) ?? null
    },
    projectName: project.name,
    relevance: pw.relevance,
    expansionPriority: pw.expansion_priority,
    relevanceRank: pw.relevance_rank,
    expansionRank: pw.expansion_rank,
    inclusionStatus: pw.inclusion_status,
    facts: facts.get(pw.work.id) ?? [],
    cites: cites.get(pw.work.id) ?? [],
    citeRefs: citeRefs.get(pw.work.id) ?? [],
    provenance: runs.get(pw.work.id) ?? null
  }))
}

/** The note for ONE work, or null when it is not in the project. */
export function buildWorkNote(db: DB, projectId: number, workId: number): NoteInput | null {
  return buildProjectNotes(db, projectId).find((n) => n.work.id === workId) ?? null
}
