// The ONE way an export reaches the disk.
//
// Every format goes through here, so the atomicity and honesty guarantees are
// stated once and cannot be half-implemented by a new format:
//
//  - dialog dismissed -> {canceled:true, path:null}. A caller literally cannot
//    render that as a success, because no path exists in the result.
//  - write fails      -> THROWS. There is no result shape that describes a file
//    which was not saved.
//  - partial write    -> unobservable. The bytes go to a temporary sibling which
//    is fsync'd and then rename()d into place, so a full disk or a dropped mount
//    never leaves a truncated file wearing the export's name.
//
// `revealExport` resolves only ids THIS module handed out, so "show in folder"
// can never be pointed at a path chosen by page script.

import { BrowserWindow, app, dialog, shell } from 'electron'
import { open, rename, rm, access } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ExportArtifact } from './types'

/** Result of a save attempt, mirroring `ExportFileResultDTO`. */
export interface WriteResult {
  canceled: boolean
  path: string | null
  bytes: number
  export_id: string | null
}

/** Paths this process actually wrote, keyed by the opaque id given out. */
const writtenExports = new Map<string, string>()
/** Bounded so a long session cannot accumulate handles indefinitely (FIFO). */
const MAX_TRACKED_EXPORTS = 32

/** Normalise an artifact body to bytes. */
function toBuffer(data: string | Buffer): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
}

/**
 * Write bytes to `path` such that the file never exists in a partial state.
 *
 * A UUID-suffixed temporary sibling is fsync'd and then renamed: a fixed '.tmp'
 * would silently clobber a pre-existing sibling and two concurrent exports to
 * one directory would race. The fsync precedes the rename so the rename cannot
 * land ahead of the data and leave a zero-length file wearing the export's name
 * after a crash.
 */
async function writeAtomic(path: string, payload: Buffer): Promise<void> {
  const tmp = `${path}.${randomUUID()}.corpus-tmp`
  try {
    const fh = await open(tmp, 'w')
    try {
      await fh.writeFile(payload)
      await fh.sync()
    } finally {
      await fh.close()
    }
    await rename(tmp, path)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw new Error(`could not write ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Dialog filter naming the one extension this artifact can sensibly have. */
function filterFor(extension: string): Electron.FileFilter[] {
  const names: Record<string, string> = {
    json: 'JSON',
    csv: 'CSV (comma-separated)',
    xlsx: 'Excel workbook',
    corpussettings: 'Corpus Studio settings'
  }
  return [{ name: names[extension] ?? extension.toUpperCase(), extensions: [extension] }]
}

/**
 * Ask where to save, then write the artifact there.
 *
 * The artifact must already be BUILT: serializing before prompting means a
 * format that cannot be produced fails before the user has picked a filename,
 * rather than after.
 */
export async function saveArtifact(
  sender: Electron.WebContents,
  artifact: ExportArtifact,
  dialogTitle: string
): Promise<WriteResult> {
  const defaultName = `${artifact.filenameStem}.${artifact.extension}`
  const win = BrowserWindow.fromWebContents(sender)
  const opts: Electron.SaveDialogOptions = {
    title: dialogTitle,
    defaultPath: join(app.getPath('downloads'), defaultName),
    filters: filterFor(artifact.extension)
  }
  const result = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)

  if (result.canceled || !result.filePath) {
    return { canceled: true, path: null, bytes: 0, export_id: null }
  }

  const target = result.filePath
  const payload = toBuffer(artifact.data)
  // The REAL encoded byte count. A UTF-8 string's byte length differs from its
  // JS string length, and the UI reports this figure as bytes on disk.
  const bytes = payload.byteLength

  await writeAtomic(target, payload)

  const exportId = randomUUID()
  writtenExports.set(exportId, target)
  while (writtenExports.size > MAX_TRACKED_EXPORTS) {
    const oldest = writtenExports.keys().next()
    if (oldest.done) break
    writtenExports.delete(oldest.value)
  }
  return { canceled: false, path: target, bytes, export_id: exportId }
}

/**
 * Show a previously written export in the OS file manager.
 *
 * False when the id is unknown or the file has since moved: the UI says so
 * rather than leaving a button that silently does nothing.
 */
export async function revealExport(exportId: string): Promise<boolean> {
  const path = writtenExports.get(exportId)
  if (!path) return false
  try {
    await access(path)
  } catch {
    return false
  }
  shell.showItemInFolder(path)
  return true
}
