// Drives a full citation parse for one work: locate its PDF, extract text,
// parse the bibliography, match against the corpus, persist with provenance.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'

import type { DB } from '../db/connection'
import { extractPdfText } from './extractText'
import {
  parseReferences,
  matchReferences,
  printedReferenceCount,
  type CorpusWork
} from './parseReferences'
import { loadCorpusWorks, storeParse, PARSER_VERSION } from './store'

export interface ParseWorkResult {
  work_id: number
  reference_count: number
  matched_count: number
  unresolved_count: number
  section_strategy: string
  entry_style: string
  no_text_layer: boolean
  /** Null when the work has no readable PDF on disk. */
  skipped_reason: string | null
}

/**
 * Resolve a work's PDF via the base-dir + relative-path indirection, so a NAS
 * remount only ever requires updating one `base_dir` row.
 */
export function resolvePdfPath(db: DB, workId: number): { path: string; documentId: number } | null {
  const row = db
    .prepare(
      `SELECT d.id AS document_id, fl.relative_path, bd.abs_path AS base_path
         FROM document d
         JOIN file_location fl ON fl.document_id = d.id
         LEFT JOIN base_dir bd ON bd.id = fl.base_dir_id
         -- base_dir.abs_path + file_location.relative_path is the NAS
         -- indirection: a remount updates one base_dir row, not every path.
        WHERE d.work_id = ? AND fl.role = 'canonical'
        ORDER BY d.is_preferred DESC, d.id
        LIMIT 1`
    )
    .get(workId) as
    | { document_id: number; relative_path: string | null; base_path: string | null }
    | undefined

  if (!row?.relative_path) return null
  const path = isAbsolute(row.relative_path)
    ? row.relative_path
    : join(row.base_path ?? '', row.relative_path)
  return existsSync(path) ? { path, documentId: row.document_id } : null
}

/**
 * Parse one work's references and persist them.
 *
 * `corpus` is accepted rather than reloaded so a batch caller pays the corpus
 * query once instead of once per work.
 */
export async function parseWorkCitations(
  db: DB,
  workId: number,
  corpus?: CorpusWork[]
): Promise<ParseWorkResult> {
  const works = corpus ?? loadCorpusWorks(db)
  const located = resolvePdfPath(db, workId)

  if (!located) {
    // Record the attempt anyway. A work with no PDF is a legitimate state
    // (metadata-only), and storing the parse row keeps it out of the stale set
    // instead of retrying a missing file on every startup.
    storeParse(db, {
      workId,
      documentId: null,
      docSha: null,
      references: [],
      matches: [],
      diagnostics: {
        section_strategy: 'none',
        entry_style: 'none',
        // Nothing was read, so no style was detected — 'generic' at zero
        // confidence, not a claim that the document is generically styled.
        citation_style: 'generic',
        style_confidence: 0,
        section_char_start: -1,
        section_char_end: -1,
        no_text_layer: true
      },
      corpusSize: works.length
    })
    return {
      work_id: workId,
      reference_count: 0,
      matched_count: 0,
      unresolved_count: 0,
      section_strategy: 'none',
      entry_style: 'none',
      no_text_layer: true,
      skipped_reason: 'no readable PDF for this work'
    }
  }

  const bytes = readFileSync(located.path)
  const docSha = createHash('sha256').update(bytes).digest('hex')
  const { text } = await extractPdfText(new Uint8Array(bytes))

  const { references, diagnostics } = parseReferences(text)
  const matches = matchReferences(references, works, { excludeWorkId: workId })

  storeParse(db, {
    workId,
    documentId: located.documentId,
    docSha,
    references,
    matches,
    diagnostics,
    corpusSize: works.length
  })

  const matched = matches.filter((m) => m.work_id != null).length
  return {
    work_id: workId,
    // The paper's PRINTED count, matching what `work_citation_parse` stores.
    reference_count: printedReferenceCount(references),
    // Rows: every lettered part that matched is a real cited paper.
    matched_count: matched,
    // Rows on both sides of the subtraction. Taking `matched` off the PRINTED
    // count would mix the two units and can go negative — a paper whose parts
    // all matched subtracts more matches than it has printed references.
    unresolved_count: references.length - matched,
    section_strategy: diagnostics.section_strategy,
    entry_style: diagnostics.entry_style,
    no_text_layer: diagnostics.no_text_layer,
    skipped_reason: null
  }
}

/** Parse every work that has never been parsed, or whose parse is stale. */
export async function parseAllWorks(
  db: DB,
  opts: { workIds?: number[]; onProgress?: (r: ParseWorkResult) => void } = {}
): Promise<ParseWorkResult[]> {
  const corpus = loadCorpusWorks(db)
  const ids =
    opts.workIds ?? (db.prepare('SELECT id FROM work ORDER BY id').all() as Array<{ id: number }>).map((r) => r.id)

  const out: ParseWorkResult[] = []
  for (const id of ids) {
    const r = await parseWorkCitations(db, id, corpus)
    out.push(r)
    opts.onProgress?.(r)
  }
  return out
}

export { PARSER_VERSION }
