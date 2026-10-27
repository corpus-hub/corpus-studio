// Vault path handling.
//
// The one job here is CONTAINMENT: every file this outlet writes must land
// inside the folder the user chose, and nothing outside it may ever be touched.
// A note filename is derived from a paper title, and a paper title is data that
// arrived from a PDF — so treating it as trusted path input would let a crafted
// title write anywhere the user can write.

import { resolve, sep, join } from 'node:path'
import { stat, access } from 'node:fs/promises'
import { constants } from 'node:fs'

/** Where a vault's notes go, resolved and verified. */
export interface VaultTarget {
  /** The vault root the user picked. */
  root: string
  /** The folder within it that this app writes to. */
  dir: string
}

/**
 * Resolve `vaultPath` + `folder` into the directory notes are written to.
 *
 * Throws when the folder escapes the vault: `..`, an absolute path, or anything
 * else that resolves outside is refused rather than silently clamped, because
 * silently writing somewhere other than where the user was told is worse than
 * an error.
 */
export function resolveVaultTarget(vaultPath: string, folder: string): VaultTarget {
  const root = resolve(vaultPath)
  const dir = resolve(root, folder)
  if (dir !== root && !dir.startsWith(root + sep)) {
    throw new Error(`the notes folder must be inside the vault (got "${folder}")`)
  }
  return { root, dir }
}

/**
 * The absolute path for one note, guaranteed to sit directly inside `dir`.
 *
 * `filename` has already been sanitised by `noteFilename`, but this asserts the
 * result rather than trusting it: the check is one line and it is the difference
 * between a bug and an arbitrary-write.
 */
export function notePath(target: VaultTarget, filename: string): string {
  const path = resolve(target.dir, `${filename}.md`)
  if (!path.startsWith(target.dir + sep)) {
    throw new Error(`refusing to write outside the notes folder: ${filename}`)
  }
  return path
}

/** Why this vault cannot be written to right now, or null when it can. */
export async function vaultProblem(vaultPath: string | null): Promise<string | null> {
  if (!vaultPath) return 'No vault folder chosen yet.'
  try {
    const st = await stat(vaultPath)
    if (!st.isDirectory()) return 'The chosen vault path is not a folder.'
  } catch {
    return 'The chosen vault folder is not there any more.'
  }
  try {
    await access(vaultPath, constants.W_OK)
  } catch {
    return 'The vault folder cannot be written to by this app.'
  }
  return null
}

/**
 * Whether the folder looks like a real Obsidian vault.
 *
 * Reported, never ENFORCED: writing markdown into a plain folder is a perfectly
 * reasonable thing to want, and refusing it would be the app deciding it knows
 * better. The UI states what was found and lets the user proceed.
 */
export async function looksLikeVault(vaultPath: string): Promise<boolean> {
  try {
    const st = await stat(join(vaultPath, '.obsidian'))
    return st.isDirectory()
  } catch {
    return false
  }
}
