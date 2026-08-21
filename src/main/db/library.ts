// Provisioning for the app-owned PDF library (`storageRootPath()`).
//
// Corpus Studio owns exactly one storage location it creates and fills itself;
// every other location is one the user added in Settings and we only ever read.
// This module creates that directory and, at seed time, populates it from the
// corpus the seeder was pointed at.
//
// WHY HARDLINK RATHER THAN COPY. The seed corpus is a real 42 MB of PDFs that
// already exist on disk, and the e2e suite asserts real bytes (a `%PDF` magic
// check, text-layer overlap, evidence-span anchoring) — so the library cannot
// be empty and cannot hold placeholders. A hardlink gives the library its own
// directory entry for each paper at zero additional disk cost, which matters:
// these files are large and the source volume is nearly full. Content is
// identical by construction, so nothing downstream can tell the difference.
//
// Falls back to a copy when a link is impossible (different filesystem, or a
// filesystem with no link support), and reports files it could not provision
// rather than failing the whole seed: a missing source PDF is a fact about the
// corpus on this machine, and the app already renders "PDF not available".

import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, join } from 'node:path'
import { storageRootPath } from './paths'

/** Create the app-owned library directory if it is not there yet. Idempotent. */
export function ensureStorageRoot(): string {
  const root = storageRootPath()
  mkdirSync(root, { recursive: true })
  return root
}

/** What `provisionLibrary` did with one source file. */
export interface ProvisionedFile {
  /** Path inside the library, relative to its root — the `relative_path` value. */
  relativePath: string
  /** Byte size in the library, or null when the file could not be provisioned. */
  sizeBytes: number | null
  outcome: 'linked' | 'copied' | 'present' | 'missing-source' | 'failed'
  /** Why it could not be provisioned; null on success. */
  error: string | null
}

/**
 * Populate the library with `sources`, one directory entry per file.
 *
 * Returns one result per input in the SAME ORDER, so the caller can pair them
 * with the records it is inserting without re-deriving names. `relativePath` is
 * the file's basename: the library is flat because `relative_path` is what makes
 * a document findable again after the root moves, and a name that encodes the
 * source machine's directory layout would not survive that move.
 */
export function provisionLibrary(sources: string[]): ProvisionedFile[] {
  const root = ensureStorageRoot()
  return sources.map((src) => {
    const relativePath = basename(src)
    const dest = join(root, relativePath)

    if (existsSync(dest)) {
      // Already provisioned by an earlier seed. Re-linking would mean unlinking
      // a file the DB may already point at, so leave it and report its size.
      return { relativePath, sizeBytes: sizeOf(dest), outcome: 'present', error: null }
    }
    if (!existsSync(src)) {
      return {
        relativePath,
        sizeBytes: null,
        outcome: 'missing-source',
        error: `no file at ${src}`
      }
    }

    try {
      linkSync(src, dest)
      return { relativePath, sizeBytes: sizeOf(dest), outcome: 'linked', error: null }
    } catch {
      // EXDEV (different filesystem) or a filesystem without hardlinks. Copy,
      // and clean up a partial destination so a failed copy cannot leave a
      // truncated PDF that would render as a corrupt document rather than an
      // absent one.
      try {
        copyFileSync(src, dest)
        return { relativePath, sizeBytes: sizeOf(dest), outcome: 'copied', error: null }
      } catch (e) {
        try {
          if (existsSync(dest)) unlinkSync(dest)
        } catch {
          /* the cleanup of a failed copy is best-effort by nature */
        }
        return {
          relativePath,
          sizeBytes: null,
          outcome: 'failed',
          error: e instanceof Error ? e.message : String(e)
        }
      }
    }
  })
}

/**
 * Put BYTES into the library, for a file that has no source path on this
 * machine — a PDF unpacked from a project archive.
 *
 * The counterpart to `provisionLibrary`, which can only link or copy from a
 * path that already exists locally. Same flat-library convention, same
 * report-rather-than-throw contract, so a caller handles one shape of result
 * either way.
 *
 * `preferredName` is a suggestion, not a promise. It is sanitised (an archive is
 * user-supplied, and a `relative_path` carrying `../` would write outside the
 * library) and suffixed on collision — two projects can legitimately contain
 * different papers whose files were both named `paper.pdf`, and silently
 * overwriting one with the other would corrupt an import that appeared to
 * succeed. The name actually used comes back in `relativePath`.
 *
 * An existing file with IDENTICAL bytes is left alone and reported `present`:
 * re-importing an archive must not double the library's size on disk.
 */
export function storeLibraryBytes(preferredName: string, bytes: Buffer): ProvisionedFile {
  const root = ensureStorageRoot()
  // `basename` first, so a traversal attempt collapses to its last segment
  // before anything is joined; then a whitelist, because a name is metadata
  // from an untrusted file and the filesystem is the wrong place to find out.
  const safe =
    basename(preferredName).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 120) ||
    'paper.pdf'
  const dot = safe.lastIndexOf('.')
  const stem = dot > 0 ? safe.slice(0, dot) : safe
  const ext = dot > 0 ? safe.slice(dot) : ''

  for (let n = 0; n < 1000; n++) {
    const relativePath = n === 0 ? safe : `${stem}-${n}${ext}`
    const dest = join(root, relativePath)
    if (existsSync(dest)) {
      try {
        // Same bytes already here — the common case when re-importing.
        if (readFileSync(dest).equals(bytes)) {
          return { relativePath, sizeBytes: bytes.length, outcome: 'present', error: null }
        }
      } catch {
        /* unreadable: treat as a collision and try the next name */
      }
      continue
    }
    try {
      writeFileSync(dest, bytes)
      return { relativePath, sizeBytes: bytes.length, outcome: 'copied', error: null }
    } catch (e) {
      return {
        relativePath,
        sizeBytes: null,
        outcome: 'failed',
        error: e instanceof Error ? e.message : String(e)
      }
    }
  }
  return {
    relativePath: safe,
    sizeBytes: null,
    outcome: 'failed',
    error: `1000 files already share the name '${safe}'`
  }
}

function sizeOf(path: string): number | null {
  try {
    return statSync(path).size
  } catch {
    return null
  }
}
