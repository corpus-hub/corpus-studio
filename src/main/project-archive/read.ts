// Turning an archive's bytes back into parts, and deciding whether we can.
//
// SPLIT FROM `restore.ts` ON PURPOSE. Reading is what the import PREVIEW needs:
// the user is shown what an archive holds — its project name, how many papers,
// whether the PDFs came along — before anything is written. Folding that into
// the restore would mean the only way to find out what a file contained was to
// import it.
//
// Everything here treats the file as untrusted. It is the one input to this app
// that arrives whole from somewhere else, so every part is checked for presence
// and shape before a single row is inserted, and every refusal names what is
// wrong in a sentence a person can act on.

import { unzipToMap } from '../export/serialize/unzip'
import {
  ARCHIVE_FORMAT,
  PART,
  type AnalysesPart,
  type ArchiveManifest,
  type ChunksPart,
  type CitationsPart,
  type ProjectArchive,
  type ProjectPart,
  type TextPart,
  type WorksPart
} from './types'

/** Parse one JSON part, naming the part rather than the character offset. */
function part<T>(files: Map<string, Buffer>, name: string): T {
  const raw = files.get(name)
  if (!raw) throw new Error(`this archive is missing ${name}`)
  try {
    return JSON.parse(raw.toString('utf8')) as T
  } catch (e) {
    throw new Error(`${name} in this archive is not readable JSON: ${(e as Error).message}`)
  }
}

/**
 * Read the manifest, and nothing else.
 *
 * Cheap by design — the caller inflates one small entry to decide whether to
 * offer the import, rather than unpacking several hundred megabytes to find out
 * the file is a holiday photo album.
 */
export function readArchiveManifest(bytes: Buffer): ArchiveManifest {
  let files: Map<string, Buffer>
  try {
    files = unzipToMap(bytes)
  } catch (e) {
    throw new Error(`this file is not a readable ZIP archive: ${(e as Error).message}`)
  }

  const manifest = part<ArchiveManifest>(files, PART.manifest)

  // Identified by CONTENT, not by extension. The file is a plain `.zip` so it
  // may be renamed, unpacked and rezipped, or mailed through something that
  // strips the name — none of which changes what it is.
  if (manifest?.kind !== 'corpus-studio-project') {
    throw new Error('this ZIP is not a Corpus Studio project archive')
  }
  if (typeof manifest.format !== 'number') {
    throw new Error('this archive does not say which format it is in')
  }
  // A MAXIMUM, not equality: an archive written by an older version stays
  // readable, which is the whole point of a monotonic format number. Only a
  // newer one is refused, and with the sentence that tells the user what to do.
  if (manifest.format > ARCHIVE_FORMAT) {
    throw new Error(
      `this archive was written by a newer version of the app (format ${manifest.format}; ` +
        `this one reads up to ${ARCHIVE_FORMAT}). Update, then import it again.`
    )
  }
  return manifest
}

/** Read the whole archive. Throws with a stated reason on anything malformed. */
export function readArchive(bytes: Buffer): ProjectArchive {
  const files = unzipToMap(bytes)
  const manifest = readArchiveManifest(bytes)

  const project = part<ProjectPart>(files, PART.project)
  if (!project?.project || typeof project.project !== 'object') {
    throw new Error('this archive carries no project')
  }

  const chunks = part<ChunksPart>(files, PART.chunks)
  const vectors = files.get(PART.vectors) ?? null

  // The vector buffer is one flat float32 array whose length is implied by the
  // chunk count and the space's dimensionality. If those three do not agree,
  // every chunk after the discrepancy would be paired with another chunk's
  // embedding — a corruption that would never surface as an error, only as
  // semantic search quietly returning the wrong papers. Refuse the vectors,
  // keep the chunks: the importer re-embeds.
  let usableVectors = vectors
  if (vectors && chunks.space) {
    const expected = chunks.chunk.length * chunks.space.dims * 4
    if (vectors.length !== expected) {
      usableVectors = null
    }
  } else if (vectors && !chunks.space) {
    usableVectors = null
  }

  return {
    manifest,
    project,
    works: part<WorksPart>(files, PART.works),
    text: part<TextPart>(files, PART.text),
    analyses: part<AnalysesPart>(files, PART.analyses),
    citations: part<CitationsPart>(files, PART.citations),
    chunks,
    schemas: part<unknown[]>(files, PART.schemas),
    pdfs: new Map([...files].filter(([n]) => n.startsWith('pdfs/'))),
    vectors: usableVectors
  }
}
