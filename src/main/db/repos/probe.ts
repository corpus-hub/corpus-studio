// Time-boxed filesystem probes, shared by every surface that reports whether
// something on disk is really there.
//
// All three are TRI-STATE: true / false / null, where null means the probe did
// not answer within the timeout. That distinction is the point of this module.
// A storage location on an unresponsive network mount is genuinely UNKNOWN, and
// collapsing it into `false` would report "this directory does not exist" about
// a filesystem we merely failed to inspect — a fabricated negative that sends a
// user looking for a share that is fine.
//
// Every probe is independently time-boxed so a single hung mount cannot delay
// the answer for the local roots probed alongside it.

import { access, stat } from 'node:fs/promises'
import { constants } from 'node:fs'

/**
 * How long a probe may take before its result is reported as unknown.
 *
 * Long enough for a healthy network mount to answer, short enough that a dead
 * one does not stall a screen. A hung NFS/SMB stat can otherwise block for the
 * kernel's own timeout, which is measured in minutes.
 */
export const PROBE_TIMEOUT_MS = 1200

/** Race `work` against the timeout, resolving null if the timeout wins. */
async function timeBoxed(work: Promise<boolean>): Promise<boolean | null> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<null>((res) => {
    timer = setTimeout(() => res(null), PROBE_TIMEOUT_MS)
    // Never hold the process open just to answer a probe.
    timer.unref?.()
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** The path is a directory AND this process may read it. */
export async function probeDirectory(absPath: string): Promise<boolean | null> {
  return timeBoxed(
    (async () => {
      const st = await stat(absPath)
      if (!st.isDirectory()) return false
      await access(absPath, constants.R_OK)
      return true
    })().catch(() => false)
  )
}

/** The path is a file. Existence only — says nothing about readability. */
export async function probeFileExists(absPath: string): Promise<boolean | null> {
  return timeBoxed(
    stat(absPath)
      .then((st) => st.isFile())
      .catch(() => false)
  )
}

/** The path is a file AND this process may read it (R_OK). */
export async function probeFileReadable(absPath: string): Promise<boolean | null> {
  return timeBoxed(
    (async () => {
      const st = await stat(absPath)
      if (!st.isFile()) return false
      await access(absPath, constants.R_OK)
      return true
    })().catch(() => false)
  )
}

/**
 * Fold many probe results into one tri-state answer to "is at least one of
 * these reachable?".
 *
 * The null case is what this exists for: if nothing answered true but something
 * timed out, the honest answer is UNKNOWN rather than "none". Only when every
 * probe answered, and all answered false, may the result be false.
 */
export function anyReachable(results: Array<boolean | null>): boolean | null {
  if (results.some((r) => r === true)) return true
  if (results.some((r) => r === null)) return null
  return false
}
