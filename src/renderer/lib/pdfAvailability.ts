// What the screen says when a document's bytes could not be had.
//
// The sentence is chosen HERE, from the reason alone, not taken from whatever
// string arrived over IPC. Main already maps its own; this is the second lock
// on the same door, and it is the one that holds if a future edit up there
// forgets — an errno message, a path (which carries the OS username) or a URL
// can never reach the window through this function.

import type { PdfReadResult, PdfUnavailableReason } from '@shared/contract'

/**
 * Whether the absence of bytes is a fact about the PAPER or about this machine.
 *
 * Only `none` licenses "metadata / abstract only": it is the one reason that
 * says the corpus holds no document for this work. The other three describe a
 * document the corpus DOES know about, which this computer could not open —
 * a claim about a drive, a permission or a corrupt row, and one the reader can
 * act on. Conflating them is how a paper on an unmounted network share was
 * reported as having no full text.
 */
export function isContentAbsence(reason: PdfUnavailableReason): boolean {
  return reason === 'none'
}

export function pdfUnavailableSentence(reason: PdfUnavailableReason): string {
  switch (reason) {
    case 'none':
      return 'PDF not available (metadata / abstract only).'
    case 'missing':
      return 'This paper has a PDF on record, but the file is not where it was stored. The drive it lives on may not be connected.'
    case 'unreadable':
      return 'This paper’s PDF is where it should be, but this computer could not read it. Check the file’s permissions, or whether the drive is still responding.'
    case 'rejected':
      return 'This paper’s PDF is recorded at a location outside its library folder, so it was not opened. Re-add the file to fix the record.'
    default:
      return 'This paper’s PDF could not be opened on this computer.'
  }
}

/** The short label a thumbnail-sized surface can carry. */
export function pdfUnavailableLabel(reason: PdfUnavailableReason): string {
  switch (reason) {
    case 'none':
      return 'No PDF'
    case 'missing':
      return 'PDF missing'
    case 'unreadable':
      return 'PDF unreadable'
    case 'rejected':
      return 'PDF path rejected'
    default:
      return 'PDF unavailable'
  }
}

/**
 * A rejection of the CALL itself — the IPC never answered.
 *
 * Distinct from every `reason`: nothing was learned about the file at all, so
 * saying anything about the paper would be inventing it.
 */
export const PDF_CALL_FAILED: PdfUnavailableReason = 'unreadable'

/**
 * Narrow a `readPdf` answer, treating a thrown IPC call as an unreadable
 * document rather than as an absent one. Callers that only need the bytes use
 * this so the `ok:false` branch cannot be silently read as absence.
 */
export function bytesOf(res: PdfReadResult): Uint8Array | null {
  return res.ok ? res.bytes : null
}
