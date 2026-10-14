// A minimal ZIP writer, because an .xlsx IS a zip.
//
// Node ships DEFLATE (`zlib`) and CRC is twelve lines, so the only thing a zip
// library would add here is the record layout below — against ~170 transitive
// packages, several carrying live high-severity advisories. For writing a
// handful of small XML parts that trade is not worth making.
//
// Deliberately supports only stored or deflated entries: no encryption, no
// zip64, no directory entries.
//
// Zip64 is the one real limit — 4 GB per entry and 65535 entries. That was
// unreachable while this only wrote spreadsheet XML, but project archives now
// use it too and they carry a corpus of PDFs, so the limit is CHECKED rather
// than assumed. Silently emitting a truncated 32-bit field would produce an
// archive that looks fine and unpacks wrong, which is the worst way for a
// backup to fail.

import { deflateRawSync, crc32 } from 'node:zlib'

interface Entry {
  name: string
  data: Buffer
}

/** DOS date/time. Fixed, not `now`: a byte-identical input must zip identically. */
const DOS_TIME = 0 // 00:00:00
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1 // 2020-01-01

/**
 * Build a ZIP archive from a list of files.
 *
 * Entries are written in the order given, which matters for xlsx: readers
 * expect `[Content_Types].xml` first, and some are unhappy when it is not.
 */
export function zip(files: Array<{ name: string; data: string | Buffer }>): Buffer {
  const entries: Entry[] = files.map((f) => ({
    name: f.name,
    data: Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8')
  }))

  // The zip64 boundaries, refused rather than silently wrapped. Every size and
  // offset below is written into a 32-bit field, so exceeding either produces a
  // structurally valid archive holding wrong numbers.
  const ZIP32_MAX = 0xffffffff
  if (entries.length > 0xffff) {
    throw new Error(
      `zip: ${entries.length} entries exceeds the 65535 this writer supports (no zip64)`
    )
  }
  for (const e of entries) {
    if (e.data.length > ZIP32_MAX) {
      throw new Error(`zip: '${e.name}' is ${e.data.length} bytes, over the 4 GB limit (no zip64)`)
    }
  }

  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const crc = crc32(e.data)
    // Level 9, not the default 6. These archives are written once and then
    // copied around, so the trade the default makes — CPU for a few percent —
    // is the wrong one here. Measured on a real project: the JSON parts go
    // 13.7 MB -> 2.9 MB, and even the PDFs (already deflate-compressed
    // internally, so nominally incompressible) give up 6%.
    const compressed = deflateRawSync(e.data, { level: 9 })
    // Only deflate when it actually helps. A tiny XML part can inflate, and
    // storing it keeps the file marginally smaller and simpler to read.
    const useDeflate = compressed.length < e.data.length
    const body = useDeflate ? compressed : e.data
    const method = useDeflate ? 8 : 0

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // local file header signature
    local.writeUInt16LE(20, 4) // version needed (2.0)
    local.writeUInt16LE(0, 6) // flags — no data descriptor, sizes are known
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // extra field length
    chunks.push(local, nameBuf, body)

    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0) // central directory header signature
    dir.writeUInt16LE(20, 4) // version made by
    dir.writeUInt16LE(20, 6) // version needed
    dir.writeUInt16LE(0, 8) // flags
    dir.writeUInt16LE(method, 10)
    dir.writeUInt16LE(DOS_TIME, 12)
    dir.writeUInt16LE(DOS_DATE, 14)
    dir.writeUInt32LE(crc, 16)
    dir.writeUInt32LE(body.length, 20)
    dir.writeUInt32LE(e.data.length, 24)
    dir.writeUInt16LE(nameBuf.length, 28)
    dir.writeUInt16LE(0, 30) // extra
    dir.writeUInt16LE(0, 32) // comment
    dir.writeUInt16LE(0, 34) // disk number
    dir.writeUInt16LE(0, 36) // internal attrs
    dir.writeUInt32LE(0, 38) // external attrs
    dir.writeUInt32LE(offset, 42) // offset of local header
    central.push(dir, nameBuf)

    offset += local.length + nameBuf.length + body.length
    // The CUMULATIVE offset, not just each entry. A hundred 100 MB PDFs are
    // each well under the per-entry limit while their running total is not, and
    // it is the total that the next header's offset field has to hold.
    if (offset > ZIP32_MAX) {
      throw new Error(`zip: archive exceeds the 4 GB total this writer supports (no zip64)`)
    }
  }

  const centralBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0) // end of central directory
  end.writeUInt16LE(0, 4) // disk number
  end.writeUInt16LE(0, 6) // disk with central dir
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20) // comment length

  return Buffer.concat([...chunks, centralBuf, end])
}
