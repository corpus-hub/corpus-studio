// The counterpart to `zip.ts`: reading an archive this app wrote, or one a user
// built themselves.
//
// Same trade as the writer records — Node ships INFLATE and CRC32, so a library
// would add only the record parsing below against a large dependency tree. The
// difference is that reading is the side that faces UNTRUSTED bytes: a user can
// hand us any file at all, including one deliberately malformed. So this parser
// treats every length and offset in the file as a claim to be checked rather
// than a fact, and refuses rather than reaching outside the buffer.
//
// SPECIFICALLY, IT READS THE CENTRAL DIRECTORY, NEVER THE LOCAL HEADERS.
// The local header's sizes are advisory: an entry may set a flag saying "the
// real sizes follow the data, in a descriptor", leaving zeros in the header.
// The central directory is the authority — it is what every correct reader uses
// and what `zip -F` repairs against — so a file whose two copies disagree is
// read the way the rest of the world reads it.
//
// Not supported, deliberately and symmetrically with the writer: zip64,
// encryption, multi-disk. Each is REFUSED with a sentence rather than
// misparsed.

import { inflateRawSync, crc32 } from 'node:zlib'

/** One file recovered from an archive. */
export interface UnzippedEntry {
  name: string
  data: Buffer
}

const SIG_EOCD = 0x06054b50
const SIG_CENTRAL = 0x02014b50
const EOCD_SIZE = 22
/** ZIP comments are a 16-bit length, so the EOCD sits within this of the end. */
const MAX_COMMENT = 0xffff

/**
 * Locate the end-of-central-directory record.
 *
 * Scanned BACKWARDS from the end because the record is last and its own length
 * is variable (it carries a trailing comment). Searching forwards would find
 * the signature inside compressed data long before the real record — those four
 * bytes occur naturally in any large file.
 */
function findEocd(buf: Buffer): number {
  const earliest = Math.max(0, buf.length - EOCD_SIZE - MAX_COMMENT)
  for (let i = buf.length - EOCD_SIZE; i >= earliest; i--) {
    if (buf.readUInt32LE(i) !== SIG_EOCD) continue
    // The signature can also occur by chance inside a comment or the data. The
    // record is only real if its comment length accounts for exactly the bytes
    // that follow it, which a coincidental match will not.
    const commentLen = buf.readUInt16LE(i + 20)
    if (i + EOCD_SIZE + commentLen === buf.length) return i
  }
  return -1
}

/**
 * Read every file out of a ZIP archive.
 *
 * Throws on anything it cannot read correctly — a truncated file, a CRC
 * mismatch, an unsupported compression method, zip64. A reader that returned
 * partial results would let a corrupt archive import as a project missing some
 * of its papers, with nothing on screen to say so.
 */
export function unzip(buf: Buffer): UnzippedEntry[] {
  if (buf.length < EOCD_SIZE) throw new Error('not a zip archive: too short')

  const eocd = findEocd(buf)
  if (eocd < 0) throw new Error('not a zip archive: no end-of-central-directory record')

  const disk = buf.readUInt16LE(eocd + 4)
  const cdDisk = buf.readUInt16LE(eocd + 6)
  if (disk !== 0 || cdDisk !== 0) throw new Error('multi-disk zip archives are not supported')

  const count = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)

  // 0xffff/0xffffffff in these fields is how a zip64 archive signals that the
  // real value lives in an extended record this reader does not parse. Read
  // literally it would mean "65535 entries starting at 4 GB", so it must be
  // named rather than attempted.
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error('zip64 archives are not supported')
  }
  if (cdOffset + cdSize > buf.length) {
    throw new Error('zip archive is truncated: the central directory runs past the end of the file')
  }

  const entries: UnzippedEntry[] = []
  let p = cdOffset

  for (let i = 0; i < count; i++) {
    if (p + 46 > cdOffset + cdSize) {
      throw new Error(`zip archive is truncated: entry ${i + 1} of ${count} has no header`)
    }
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) {
      throw new Error(`zip archive is malformed: entry ${i + 1} has no central-directory signature`)
    }

    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const crcExpected = buf.readUInt32LE(p + 16)
    const compSize = buf.readUInt32LE(p + 20)
    const rawSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)

    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen

    // Bit 0 is "encrypted". Inflating an encrypted entry yields garbage that
    // fails CRC, so this would be caught anyway — but "this archive is
    // encrypted" is an answer the user can act on and "CRC mismatch" is not.
    if (flags & 0x1) throw new Error(`'${name}' is encrypted; encrypted archives are not supported`)

    // A directory entry, which this writer never emits but other tools do.
    // Carries no data and needs none: the paths of the real entries imply the
    // structure, and creating empty folders is the caller's business.
    if (name.endsWith('/')) continue

    if (method !== 0 && method !== 8) {
      throw new Error(`'${name}' uses compression method ${method}; only store and deflate are supported`)
    }

    // The local header is skipped over, never trusted — but its variable
    // fields still have to be measured to find where the data begins.
    if (localOffset + 30 > buf.length) {
      throw new Error(`zip archive is truncated: '${name}' points past the end of the file`)
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26)
    const localExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    if (dataStart + compSize > buf.length) {
      throw new Error(`zip archive is truncated: '${name}' is cut short`)
    }

    const body = buf.subarray(dataStart, dataStart + compSize)
    let data: Buffer
    try {
      data = method === 8 ? inflateRawSync(body) : Buffer.from(body)
    } catch (err) {
      throw new Error(`'${name}' could not be decompressed: ${(err as Error).message}`)
    }

    // Both checks, because they catch different corruptions: a wrong LENGTH
    // survives a coincidental CRC match on a truncated stream, and a wrong BYTE
    // leaves the length intact. Together they are what makes "the archive is
    // intact" a claim rather than a hope.
    if (data.length !== rawSize) {
      throw new Error(`'${name}' unpacked to ${data.length} bytes, expected ${rawSize}`)
    }
    if (crc32(data) !== crcExpected) {
      throw new Error(`'${name}' failed its checksum; the archive is damaged`)
    }

    entries.push({ name, data })
  }

  return entries
}

/**
 * The entries as a lookup, which is how every caller here wants them: an
 * archive is a set of named parts to be pulled out by name, not a list to walk.
 */
export function unzipToMap(buf: Buffer): Map<string, Buffer> {
  const map = new Map<string, Buffer>()
  for (const e of unzip(buf)) map.set(e.name, e.data)
  return map
}
