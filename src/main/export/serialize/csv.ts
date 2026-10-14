// RFC 4180 CSV.
//
// Hand-written rather than pulled from a package: the whole format is the
// quoting rule below, and a dependency for it would be more surface than code.

import type { ExtractionTable } from '../data/extractionTable'

/**
 * Quote a single cell.
 *
 * A field is quoted when it contains a comma, a quote or a newline, and inner
 * quotes are doubled. Leading/trailing spaces also force quoting, because a
 * spreadsheet otherwise strips them and a value that was ' 95' silently becomes
 * '95'.
 *
 * null becomes EMPTY, never the text "null": a missing measurement must read as
 * absent, not as a value someone recorded.
 */
function cell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  if (s === '') return ''
  const needsQuote = /[",\r\n]/.test(s) || s !== s.trim()
  return needsQuote ? `"${s.replaceAll('"', '""')}"` : s
}

/**
 * Render a table as CSV text.
 *
 * CRLF line endings and a UTF-8 BOM: RFC 4180 specifies CRLF, and without the
 * BOM Excel on Windows decodes UTF-8 as the local codepage, which mangles every
 * µ, Δ and ° in a table of physical measurements.
 */
export function toCsv(table: ExtractionTable): string {
  const lines: string[] = []
  lines.push(table.columns.map((c) => cell(c.header)).join(','))
  for (const row of table.rows) {
    lines.push(table.columns.map((c) => cell(row[c.key])).join(','))
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n'
}
