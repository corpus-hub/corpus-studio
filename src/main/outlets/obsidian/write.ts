// Write notes into the vault.
//
// TWO PROPERTIES THIS FILE OWES THE USER.
//
// 1. It reports what it ACTUALLY did — created / updated / unchanged, with the
//    real paths. "Unchanged" is its own outcome rather than being counted as an
//    update, because a run that rewrote nothing should say so; inflating it to
//    "12 notes written" would be a fabricated success.
//
// 2. It never destroys work. A note whose content already matches is not
//    rewritten (so the vault's modification times stay meaningful), and a note
//    the user has EDITED BY HAND is not silently overwritten — it is reported as
//    conflicted and left alone. Losing a scientist's own annotations to a mirror
//    job is the worst thing this outlet could do.

import { mkdir, readFile, writeFile, rename, rm, readdir } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { NoteInput } from '../../../shared/markdown'
import { noteFilename, renderNote } from '../../../shared/markdown'
import { notePath, resolveVaultTarget, type VaultTarget } from './vault'

export interface WriteOutcome {
  created: string[]
  updated: string[]
  unchanged: string[]
  /** Hand-edited notes we refused to overwrite. */
  conflicted: string[]
  failed: Array<{ path: string; error: string }>
}

/**
 * A content fingerprint stamped into the note.
 *
 * It lets a rewrite tell "this file is exactly what we last wrote" from "the
 * user has since edited it" — without keeping a shadow copy of the vault. The
 * hash covers the BODY only (everything after the stamp line), so the stamp
 * cannot influence its own value.
 */
const STAMP = 'corpus_hash'

function hashBody(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 16)
}

/** Insert the stamp into the frontmatter of a rendered note. */
function stamp(markdown: string): string {
  const lines = markdown.split('\n')
  // Frontmatter is delimited by the first two `---` lines; the stamp goes just
  // before the closing one.
  const close = lines.indexOf('---', 1)
  if (close < 0) return markdown
  const body = lines.slice(close + 1).join('\n')
  const front = lines.slice(0, close)
  return [...front, `${STAMP}: ${hashBody(body)}`, '---', body].join('\n')
}

/** Read the stamp a previous run left, or null if there is none. */
function readStamp(markdown: string): { hash: string; body: string } | null {
  const lines = markdown.split('\n')
  if (lines[0] !== '---') return null
  const close = lines.indexOf('---', 1)
  if (close < 0) return null
  const line = lines.slice(0, close).find((l) => l.startsWith(`${STAMP}:`))
  if (!line) return null
  return { hash: line.slice(STAMP.length + 1).trim(), body: lines.slice(close + 1).join('\n') }
}

/**
 * Write one note atomically.
 *
 * Same tmp→rename discipline the export uses: a vault is the user's own data,
 * and a half-written note after a crash would be worse than no note.
 */
async function writeAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.${randomUUID()}.corpus-tmp`
  try {
    await writeFile(tmp, content, 'utf8')
    await rename(tmp, path)
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw e
  }
}

/**
 * Mirror `notes` into the vault.
 *
 * `force` overwrites hand-edited notes; without it they are reported as
 * conflicts and left untouched. The UI asks before setting it.
 */
export async function writeNotes(
  vaultPath: string,
  folder: string,
  notes: NoteInput[],
  options: { backlinks: boolean; force?: boolean }
): Promise<WriteOutcome> {
  const target = resolveVaultTarget(vaultPath, folder)
  await mkdir(target.dir, { recursive: true })

  const outcome: WriteOutcome = {
    created: [],
    updated: [],
    unchanged: [],
    conflicted: [],
    failed: []
  }

  for (const note of notes) {
    const path = notePath(target, noteFilename(note.work.title))
    const content = stamp(renderNote(note, { backlinks: options.backlinks }))
    try {
      const existing = await readFile(path, 'utf8').catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return null
        throw e
      })

      if (existing === null) {
        await writeAtomic(path, content)
        outcome.created.push(path)
        continue
      }
      if (existing === content) {
        outcome.unchanged.push(path)
        continue
      }

      const prior = readStamp(existing)
      const handEdited = prior === null || prior.hash !== hashBody(prior.body)
      if (handEdited && !options.force) {
        outcome.conflicted.push(path)
        continue
      }
      await writeAtomic(path, content)
      outcome.updated.push(path)
    } catch (e) {
      outcome.failed.push({ path, error: e instanceof Error ? e.message : String(e) })
    }
  }

  return outcome
}

/**
 * Notes this outlet previously wrote that no longer correspond to a work.
 *
 * REPORTED, never deleted automatically. A paper removed from a project might
 * mean "delete the note" or might mean the user moved it deliberately, and the
 * app does not get to decide that on its own inside somebody's vault.
 */
export async function orphanNotes(
  vaultPath: string,
  folder: string,
  notes: NoteInput[]
): Promise<string[]> {
  let target: VaultTarget
  try {
    target = resolveVaultTarget(vaultPath, folder)
  } catch {
    return []
  }
  const expected = new Set(notes.map((n) => `${noteFilename(n.work.title)}.md`))
  const found = await readdir(target.dir).catch(() => [] as string[])
  const out: string[] = []
  for (const name of found) {
    if (!name.endsWith('.md') || expected.has(name)) continue
    // Only files WE wrote (they carry the stamp) count as orphans; anything else
    // in that folder is the user's and is none of our business.
    const text = await readFile(join(target.dir, name), 'utf8').catch(() => null)
    if (text && readStamp(text) !== null) out.push(join(target.dir, name))
  }
  return out
}
