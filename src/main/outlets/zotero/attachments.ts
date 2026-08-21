// Which papers the Zotero export may carry, and where each one's file sits
// inside the bundle.
//
// A note carries `pdfPath` — the canonical location the database believes in.
// That is a CLAIM about the filesystem, not a fact: the file may sit on a NAS
// that is not mounted, may have been deleted outside the app, or may never have
// arrived because retrieval failed or the publisher paywalled it. So the
// question this module answers is asked of the disk, once, before anything is
// written.
//
// A paper whose file cannot be read is excluded ENTIRELY — no attachment and no
// bibliography record. Exporting the metadata alone would put a row in the
// recipient's library that looks like a paper they have and is not, and the one
// thing worse than a missing paper is a present-looking one that opens nothing.
// The count of what was left out is returned rather than swallowed, because a
// user handed 40 papers when their project holds 47 must be told which fact
// they are looking at.

import { basename, extname } from 'node:path'
import { access, constants } from 'node:fs/promises'
import type { NoteInput } from '../../../shared/markdown'

export interface AttachmentPlan {
  /** The papers that may be exported, in the order given. */
  exportable: NoteInput[]
  /**
   * Work id -> path within the bundle, e.g. `files/[3] Kemp elimination….pdf`.
   *
   * Only for `exportable` entries, and only when the file was READ-checked.
   */
  paths: Map<number, string>
  /** Work id -> the absolute source path to copy from. */
  sources: Map<number, string>
  /** Papers left out because their file could not be read. */
  skipped: number
}

/**
 * Decide what goes in.
 *
 * `requirePdf` is the switch: with it off the bundle is a bibliography and every
 * paper belongs in it regardless of what is on disk; with it on the export is of
 * the papers themselves, and a paper is what its file is.
 */
export async function planAttachments(
  notes: NoteInput[],
  requirePdf: boolean
): Promise<AttachmentPlan> {
  if (!requirePdf) {
    return { exportable: notes, paths: new Map(), sources: new Map(), skipped: 0 }
  }

  const exportable: NoteInput[] = []
  const paths = new Map<number, string>()
  const sources = new Map<number, string>()
  let skipped = 0

  for (const n of notes) {
    const src = n.work.pdfPath
    if (!src || !(await readable(src))) {
      skipped += 1
      continue
    }
    // One flat folder, each file numbered by POSITION in the export.
    //
    // The number is what keeps two papers apart when their titles collide — a
    // preprint and its published version routinely share a title exactly, and
    // truncation makes near-collisions collide too. Without it the second one
    // silently overwrites the first inside the zip.
    //
    // POSITION, not the work's row id: the id is an internal database key, and
    // using it would make two exports of the same project lay out differently
    // after unrelated rows were deleted elsewhere in the corpus.
    exportable.push(n)
    paths.set(n.work.id, `files/${entryName(exportable.length, n.work.title, src)}`)
    sources.set(n.work.id, src)
  }

  return { exportable, paths, sources, skipped }
}

async function readable(path: string): Promise<boolean> {
  return access(path, constants.R_OK).then(
    () => true,
    () => false
  )
}

/**
 * A filename a person recognises, safe on every filesystem.
 *
 * Named after the TITLE, not after whatever the retriever happened to call the
 * download (`10.1021-acscatal.9b02089.pdf` tells a reader nothing). The
 * `[n]` prefix disambiguates identical titles and keeps the folder in export
 * order in any file browser, which sorts a bare title alphabetically instead.
 * The extension comes from the source file so a non-PDF document keeps its own.
 */
function entryName(position: number, title: string, sourcePath: string): string {
  const ext = extname(sourcePath) || '.pdf'
  const stem = title
    // The characters Windows refuses plus the separators every zip reader treats
    // as structure. Replaced rather than stripped, so words do not run together.
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Long enough to identify the paper, short enough that the whole path stays
    // under the 260-character limit a Windows extractor still enforces.
    .slice(0, 120)
    .trim()
  return `[${position}] ${stem || basename(sourcePath, ext) || 'paper'}${ext}`
}
