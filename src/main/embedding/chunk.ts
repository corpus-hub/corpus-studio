// Paragraph chunking: `text.paragraphs@v1` -> the units that get embedded.
//
// PARAGRAPHS, not a sliding window, and that is measured rather than assumed:
// the benchmark over this repo's own corpus found paragraph chunking beat
// sliding-window for all five models tested. `segment` already produces the
// inventory every anchor in the app resolves against, so reusing it means a
// chunk's provenance is a list of `para_id`s that name real, addressable rows —
// a second chunker would have invented a second, unanchorable coordinate space.
//
// Pure: no model, no database, no I/O. That is what makes it unit-checkable and
// what lets `CHUNKING_VERSION` be a meaningful part of the space identity.

import { createHash } from 'node:crypto'
import type { ParagraphRecord, Paragraphs } from '../pipeline/capabilities'

export interface Chunk {
  idx: number
  paraIds: string[]
  charStart: number
  charEnd: number
  page: number | null
  section: string
  text: string
  tokenEstimate: number
  lowConfidence: boolean
  inputHash: string
}

/**
 * Characters per token, for BERT-family WordPiece on scientific English.
 *
 * An ESTIMATE, used only to pack paragraphs up to a budget — never to claim a
 * chunk was not truncated. Whether the model actually truncated is reported by
 * the model itself, because a heuristic that said "this fits" and was wrong
 * would mean a stored vector silently represents only part of its text.
 */
const CHARS_PER_TOKEN = 4

/**
 * Below this a chunk is flagged, not dropped.
 *
 * A three-word paragraph embeds to a vector that is dominated by the model's
 * priors rather than by the paper, so it will surface as a confident neighbour
 * for almost anything. Dropping it would silently lose real text (a short
 * caption may be the only place a number appears); presenting it as equal to a
 * full paragraph would fabricate confidence. So it is stored, searchable, and
 * marked.
 */
const LOW_CONFIDENCE_CHARS = 120

/**
 * Paragraph kinds that are never embedded.
 *
 * `reference` is a bibliography entry: prose-shaped, and not prose. Embedding
 * them makes every paper a near neighbour of every paper it cites, which is a
 * citation edge the graph already models exactly, and swamps semantic search
 * with matches on author names. `segment` already marks them.
 */
const EXCLUDED_KINDS = new Set(['reference'])

export interface ChunkOptions {
  /** The model's sequence limit, from the space. Never a literal here. */
  maxSeqLength: number
  /** Prepended to a chunk's text before embedding, from the space. */
  docPrefix: string
}

/**
 * Pack an inventory into chunks.
 *
 * Adjacent paragraphs in the SAME section are packed together up to the token
 * budget, because a lone two-line paragraph carries less retrievable meaning
 * than the passage it belongs to. A section boundary always breaks a chunk: a
 * chunk spanning Methods and Results would answer questions about neither
 * accurately, and `section` is a column a reader filters on.
 *
 * A paragraph LARGER than the budget becomes its own chunk and is not split:
 * splitting mid-sentence is what produces the truncation artefacts this design
 * avoids, and the model's own truncation is reported honestly instead.
 */
export function chunkParagraphs(paragraphs: Paragraphs, opts: ChunkOptions): Chunk[] {
  // The budget is in CHARACTERS, converted once from the model's token limit,
  // with headroom for the prefix and the special tokens the tokenizer adds.
  const budget = Math.max(
    LOW_CONFIDENCE_CHARS,
    (opts.maxSeqLength - 8) * CHARS_PER_TOKEN - opts.docPrefix.length
  )

  const eligible = paragraphs.paragraphs.filter(
    (p) => !EXCLUDED_KINDS.has(p.kind) && p.text.trim().length > 0
  )

  const out: Chunk[] = []
  let group: ParagraphRecord[] = []
  let groupChars = 0

  const flush = (): void => {
    if (group.length === 0) return
    const first = group[0]
    const last = group[group.length - 1]
    // Sliced from the CANONICAL text, so a chunk's span is exactly what its
    // offsets say — the same exact-slice discipline `segment` enforces. Joining
    // the paragraphs' own strings instead would silently drop the whitespace
    // between them and make char_start..char_end name different text.
    const text = paragraphs.text.slice(first.charStart, last.charEnd)
    out.push({
      idx: out.length,
      paraIds: group.map((p) => p.paraId),
      charStart: first.charStart,
      charEnd: last.charEnd,
      page: first.page,
      section: first.section,
      text,
      tokenEstimate: Math.ceil(text.length / CHARS_PER_TOKEN),
      lowConfidence: text.trim().length < LOW_CONFIDENCE_CHARS,
      inputHash: createHash('sha256').update(text).digest('hex')
    })
    group = []
    groupChars = 0
  }

  for (const p of eligible) {
    const len = p.charEnd - p.charStart
    const sectionChanged = group.length > 0 && group[0].section !== p.section
    // CONTIGUITY, and it is what makes the exclusion above mean anything. A
    // chunk's text is SLICED from the canonical string between the first and
    // last paragraph's offsets, so packing two paragraphs that are not
    // neighbours silently swallows everything between them — including the
    // bibliography entries `EXCLUDED_KINDS` just removed, exactly where
    // references interleave with prose. `para_ids` would then under-report the
    // chunk's own text, which is the kind of quiet wrongness this project
    // treats as worse than an error.
    const gapped = group.length > 0 && p.index !== group[group.length - 1].index + 1
    if (sectionChanged || gapped || (group.length > 0 && groupChars + len > budget)) flush()
    if (len > budget) {
      // Bigger than the budget on its own. It is its own chunk; the model
      // truncates it and says so, rather than this code guessing a split point.
      flush()
      group = [p]
      groupChars = len
      flush()
      continue
    }
    group.push(p)
    groupChars += len
  }
  flush()
  return out
}
