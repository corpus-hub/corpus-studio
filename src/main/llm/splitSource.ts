// Sending a WHOLE document to a chat model, in order, across as many user
// messages as it takes.
//
// A summary is asked for the shape of an argument, which cannot be judged from
// a slice — so the paper is never shortened to fit. What varies is how many
// messages carry it.
//
// THE SPLIT IS ON PARAGRAPH BOUNDARIES, NEVER INSIDE ONE. The body arrives as
// the paragraph inventory, and a cut inside a paragraph lands inside a sentence,
// a number or a word — the exact damage OCR repair spends its time undoing, and
// the model has no way to tell a cut value from a printed one. So a paragraph is
// atomic here: one that is on its own larger than the target simply makes an
// oversized part, which is honest, where cutting it would be a silent edit of
// the paper.

/** One message's worth of document. */
export interface SourcePart {
  /** 1-based, for the label the model reads. */
  index: number
  total: number
  text: string
}

/**
 * How much document one message aims to carry.
 *
 * A target, not a cap: paragraph atomicity wins over it. Sized so an ordinary
 * paper (tens of thousands of characters) still arrives as ONE message and the
 * split is machinery that never fires, while a review or a thesis is delivered
 * whole instead of cut.
 */
export const SOURCE_PART_CHARS = 120_000

/**
 * The most messages one document may be split into.
 *
 * Exists so a pathological input — a corrupt inventory, a merged multi-volume
 * PDF — cannot issue an unbounded request. Reaching it is a REAL failure and is
 * thrown, never trimmed to fit: silently dropping the tail is the behaviour this
 * module was written to remove.
 */
export const MAX_SOURCE_PARTS = 12

/** Raised when a document cannot be sent whole within `MAX_SOURCE_PARTS`. */
export class SourceTooLargeError extends Error {
  constructor(
    readonly chars: number,
    readonly parts: number
  ) {
    super(
      `This document is ${chars.toLocaleString('en')} characters, which needs ${parts} messages to send whole — more than the ${MAX_SOURCE_PARTS} allowed. It was NOT summarised, because summarising part of it would report a reading of a paper nobody read. Split the document, or check its extracted text for corruption.`
    )
    this.name = 'SourceTooLargeError'
  }
}

export function isSourceTooLarge(err: unknown): boolean {
  return err instanceof SourceTooLargeError
}

/**
 * Group paragraphs into ordered parts.
 *
 * The invariant callers rely on: `splitSource(chunks).map(p => p.text).join(sep)
 * === chunks.join(sep)` for the same separator the body was assembled with.
 * Nothing is dropped, reordered or rewritten.
 */
export function splitSource(chunks: string[], separator = '\n\n'): SourcePart[] {
  const groups: string[][] = []
  let current: string[] = []
  let size = 0
  for (const chunk of chunks) {
    const added = current.length === 0 ? chunk.length : separator.length + chunk.length
    if (current.length > 0 && size + added > SOURCE_PART_CHARS) {
      groups.push(current)
      current = [chunk]
      size = chunk.length
      continue
    }
    current.push(chunk)
    size += added
  }
  if (current.length > 0) groups.push(current)
  if (groups.length === 0) return []

  const total = groups.length
  if (total > MAX_SOURCE_PARTS) {
    throw new SourceTooLargeError(
      chunks.join(separator).length,
      total
    )
  }
  return groups.map((g, i) => ({ index: i + 1, total, text: g.join(separator) }))
}

/**
 * Label a part so the model knows where it is in the document.
 *
 * Unlabelled, a model handed the first third of a paper summarises the first
 * third AS the paper — fluently, and with no sign in the prose that it did. So
 * every part states its number, the total, and whether more is coming, and only
 * the last one releases the model to write.
 *
 * A single-part document says none of this: there is no sequence to place it in,
 * and announcing "part 1 of 1" would spend the model's attention telling it that
 * nothing unusual happened (the same reason a badge announces only the
 * exception).
 */
export function labelPart(part: SourcePart): string {
  if (part.total === 1) return 'DOCUMENT TEXT:'
  if (part.index < part.total) {
    return (
      `DOCUMENT TEXT — PART ${part.index} OF ${part.total}. ` +
      `This is a section of ONE document, sent in order because it is too long for a single ` +
      `message. Do not answer yet and do not summarise this section: ` +
      `${part.total - part.index} more part${part.total - part.index === 1 ? '' : 's'} follow.`
    )
  }
  return (
    `DOCUMENT TEXT — PART ${part.total} OF ${part.total}, the final part. ` +
    `The whole document has now been sent. Write your answer about the COMPLETE document, ` +
    `all ${part.total} parts together, not about this part alone.`
  )
}
