import { inflateRawSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname, isAbsolute } from 'node:path'
import { LIMITS, ManifestError } from './manifest'

/**
 * Unpacking an archive that came off the network, under refusals.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS THE ONE GENUINELY NEW ATTACK SURFACE ON THE REPOSITORY PATH.
 *
 * Everything else a downloaded plugin travels through already exists and has
 * already been written against a real failure: `stagePluginTree` refuses
 * symlinks and hardlinks, re-accumulates the byte total over what it actually
 * writes, re-`lstat`s at copy time to close the TOCTOU window, and chmods every
 * copy to 0600. NONE of that is reimplemented here or anywhere on the remote
 * path — this produces an ordinary directory of ordinary files and hands it to
 * the same installer a user's chosen folder goes through, because the copy of
 * that logic which gets dropped is the one somebody exploits.
 *
 * What IS new is reading a container format written by a stranger, so the
 * refusals that belong to the container live here and are applied before
 * `install.ts` ever sees a tree:
 *
 *   - no absolute member path, no `..` in any segment, no drive letter, no NUL,
 *     no backslash read as a separator;
 *   - only STORED and DEFLATE members, and only regular files and directories —
 *     a symlink, a device or anything else carrying unix mode bits that are not
 *     a regular file is refused rather than skipped, because "we ignored part of
 *     the archive" is not a state anyone can reason about;
 *   - member count, per-file bytes, total bytes and nesting depth bounded by the
 *     SAME `LIMITS` the local install path uses, so a repository cannot deliver
 *     a plugin a folder could not have been;
 *   - SIZES MEASURED AS PRODUCED, never read from the zip's own header. A zip
 *     declares each member's uncompressed size and a hostile one declares
 *     whatever it likes; a bound computed from that declaration bounds only the
 *     attacker's honesty, which is how a 40-byte archive becomes a full disk.
 *     `maxOutputLength` stops the inflate at the budget, and the budget is spent
 *     against what came out.
 *
 * The CENTRAL DIRECTORY is the authority for what the archive contains, and each
 * member's own local header is re-read for its variable-length fields only. The
 * two disagreeing is how the same archive is read as two different sets of files
 * by two different readers; nothing here trusts a local header for a name.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** The signatures, little-endian, as they appear on disk. */
const SIG_EOCD = 0x06054b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50

/** The last 22 bytes of an EOCD with no comment, and the largest comment it may carry. */
const EOCD_MIN = 22
const EOCD_MAX_COMMENT = 0xffff

/** The two methods a plugin archive may use. Anything else is refused by name. */
const METHOD_STORED = 0
const METHOD_DEFLATE = 8

/** Refused with a sentence, like every other refusal a user can be shown. */
function refuse(code: string, message: string): never {
  throw new ManifestError(code, message)
}

const ARCHIVE_BROKEN =
  'That plugin’s download could not be opened as an archive, so nothing was installed.'
const ARCHIVE_UNSAFE =
  'That plugin’s download contains a file that would be written outside its own folder, so nothing was installed.'
const ARCHIVE_TOO_BIG =
  'That plugin’s download is larger than a plugin is allowed to be, so nothing was installed.'

/**
 * Find the end-of-central-directory record.
 *
 * Scanned BACKWARDS from the end over the largest comment a zip may carry, which
 * is the only way it can be found: the record is at a variable offset because
 * the comment after it is variable-length. The scan is bounded by that maximum
 * rather than by the file size, so a large archive with no EOCD ends quickly.
 */
function findEocd(buf: Buffer): number {
  const start = Math.max(0, buf.length - EOCD_MIN - EOCD_MAX_COMMENT)
  for (let i = buf.length - EOCD_MIN; i >= start; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i
  }
  return refuse('archive-broken', ARCHIVE_BROKEN)
}

/**
 * A member's path, checked to be a relative path inside the destination.
 *
 * REFUSED, never sanitised. A name that has to be repaired to be safe is one
 * whose author meant something by it, and quietly rewriting it installs a
 * different tree from the one that was published — which is the same tree
 * divergence the central-directory rule above exists to prevent.
 */
function safeMemberPath(raw: string): string {
  if (raw.length === 0 || raw.length > 200) refuse('archive-unsafe', ARCHIVE_UNSAFE)
  if (raw.includes('\0')) refuse('archive-unsafe', ARCHIVE_UNSAFE)
  if (isAbsolute(raw) || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    refuse('archive-unsafe', ARCHIVE_UNSAFE)
  }
  // BOTH separators. A member written on Windows carries backslashes, and a
  // name checked for `..` only between forward slashes lets `a\..\..\b` past a
  // reader that then joins it on a platform where the backslash separates.
  const parts = raw.split(/[\\/]/)
  for (const p of parts) {
    if (p === '..') refuse('archive-unsafe', ARCHIVE_UNSAFE)
  }
  if (parts.length > LIMITS.depth) refuse('archive-unsafe', ARCHIVE_UNSAFE)
  return parts.filter((p) => p.length > 0 && p !== '.').join('/')
}

/**
 * The unix file type nibble out of a member's external attributes, or null when
 * the archive was not written by a unix packer.
 *
 * A zip records the mode in the HIGH 16 bits of `externalAttributes` when the
 * `versionMadeBy` host is unix (3). That is where a symlink is declared, and a
 * symlink extracted as a file is a plugin folder with a dangling text file in
 * it — which is harmless — while one extracted AS a symlink is an arbitrary
 * write. Refused rather than either.
 */
function unixFileType(versionMadeBy: number, externalAttributes: number): number | null {
  if (versionMadeBy >> 8 !== 3) return null
  const mode = (externalAttributes >>> 16) & 0xffff
  if (mode === 0) return null
  return mode & 0xf000
}

const S_IFREG = 0x8000
const S_IFDIR = 0x4000

export interface UnzipOutcome {
  /** Files actually written, relative to the destination. */
  files: number
  /** Bytes actually written, counted as they were produced. */
  bytes: number
}

/**
 * Extract `zip` into `dest`, which must already exist and be empty.
 *
 * `dest` is the caller's own temporary directory — never a plugins root. What
 * lands here is not a plugin yet; it becomes one only if `installPluginFolder`
 * accepts it, which is the step that reads and validates the manifest.
 */
export function extractPluginZip(zip: Buffer, dest: string): UnzipOutcome {
  if (zip.length < EOCD_MIN) refuse('archive-broken', ARCHIVE_BROKEN)
  const eocd = findEocd(zip)
  const entryCount = zip.readUInt16LE(eocd + 10)
  const centralSize = zip.readUInt32LE(eocd + 12)
  const centralStart = zip.readUInt32LE(eocd + 16)
  if (entryCount > LIMITS.files) refuse('archive-too-big', ARCHIVE_TOO_BIG)
  if (centralStart + centralSize > zip.length) refuse('archive-broken', ARCHIVE_BROKEN)

  let cursor = centralStart
  let files = 0
  let bytes = 0

  for (let i = 0; i < entryCount; i += 1) {
    if (cursor + 46 > centralStart + centralSize) refuse('archive-broken', ARCHIVE_BROKEN)
    if (zip.readUInt32LE(cursor) !== SIG_CENTRAL) refuse('archive-broken', ARCHIVE_BROKEN)
    const versionMadeBy = zip.readUInt16LE(cursor + 4)
    const flags = zip.readUInt16LE(cursor + 8)
    const method = zip.readUInt16LE(cursor + 10)
    const compressedSize = zip.readUInt32LE(cursor + 20)
    const nameLen = zip.readUInt16LE(cursor + 28)
    const extraLen = zip.readUInt16LE(cursor + 30)
    const commentLen = zip.readUInt16LE(cursor + 32)
    const externalAttrs = zip.readUInt32LE(cursor + 38)
    const localOffset = zip.readUInt32LE(cursor + 42)
    const rawName = zip.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8')
    cursor += 46 + nameLen + extraLen + commentLen

    // ENCRYPTED members are refused rather than attempted: bit 0 of the flags
    // means the data needs a password this app has no way to hold, and an
    // inflate of ciphertext is a failure with a much worse sentence.
    if ((flags & 0x1) !== 0) refuse('archive-broken', ARCHIVE_BROKEN)
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      refuse('archive-broken', ARCHIVE_BROKEN)
    }

    const type = unixFileType(versionMadeBy, externalAttrs)
    const isDirName = rawName.endsWith('/') || rawName.endsWith('\\')
    if (type !== null && type !== S_IFREG && type !== S_IFDIR) {
      // A symlink, a fifo, a socket, a device. Named as unsafe rather than
      // broken: the archive is well-formed and is asking for something a plugin
      // folder may not contain.
      refuse('archive-unsafe', ARCHIVE_UNSAFE)
    }

    const rel = safeMemberPath(rawName)
    if (rel.length === 0) continue
    if (isDirName || type === S_IFDIR) {
      mkdirSync(join(dest, ...rel.split('/')), { recursive: true, mode: 0o700 })
      continue
    }

    files += 1
    if (files > LIMITS.files) refuse('archive-too-big', ARCHIVE_TOO_BIG)

    // THE LOCAL HEADER IS RE-READ ONLY FOR ITS OWN VARIABLE LENGTHS. Its name
    // and its sizes are ignored: the central directory is the authority for what
    // the archive contains, and a reader that takes the name from here reads a
    // different set of files than one that does not.
    if (localOffset + 30 > zip.length) refuse('archive-broken', ARCHIVE_BROKEN)
    if (zip.readUInt32LE(localOffset) !== SIG_LOCAL) refuse('archive-broken', ARCHIVE_BROKEN)
    const localNameLen = zip.readUInt16LE(localOffset + 26)
    const localExtraLen = zip.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    if (dataStart + compressedSize > zip.length) refuse('archive-broken', ARCHIVE_BROKEN)
    const payload = zip.subarray(dataStart, dataStart + compressedSize)

    // The budget for THIS member: its own cap, and whatever is left of the
    // archive's total. Spent against what is produced, so a member declaring
    // four bytes and inflating to four gigabytes stops at the budget rather than
    // at its declaration.
    const remaining = LIMITS.totalBytes - bytes
    if (remaining <= 0) refuse('archive-too-big', ARCHIVE_TOO_BIG)
    const budget = Math.min(LIMITS.fileBytes, remaining)

    let out: Buffer
    if (method === METHOD_STORED) {
      if (payload.length > budget) refuse('archive-too-big', ARCHIVE_TOO_BIG)
      out = Buffer.from(payload)
    } else {
      try {
        // `maxOutputLength` is the bound that is actually enforced on the bytes
        // zlib produces; it throws rather than truncating, which is what makes
        // it a refusal rather than a silently half-written file.
        out = inflateRawSync(payload, { maxOutputLength: budget })
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code
        if (code === 'ERR_BUFFER_TOO_LARGE') refuse('archive-too-big', ARCHIVE_TOO_BIG)
        refuse('archive-broken', ARCHIVE_BROKEN)
      }
    }

    bytes += out.length
    if (bytes > LIMITS.totalBytes) refuse('archive-too-big', ARCHIVE_TOO_BIG)

    const to = join(dest, ...rel.split('/'))
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 })
    // 0600, as `stagePluginTree` writes its own copies: nothing extracted from a
    // stranger's archive is executable or group-readable in this app's own
    // directories, whatever mode the archive asked for.
    writeFileSync(to, out, { mode: 0o600 })
  }

  return { files, bytes }
}
