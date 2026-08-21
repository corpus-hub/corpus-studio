// A minimal OOXML (.xlsx) writer.
//
// The ONLY file in the app that knows the spreadsheet format. It writes the
// smallest workbook the specification allows for a grid of text and numbers:
// no formulas, no charts, no merged cells, no themes, no custom number formats.
// That restraint is the design — the boring path is the one every reader
// implements correctly, and everything fancy is where hand-written OOXML breaks.
//
// WHY NOT A LIBRARY. `exceljs` is built to reproduce all of Excel; we need a
// grid. It costs ~170 transitive packages, several with live high-severity
// advisories, in an app whose whole premise is local-first and offline. The
// parts below are ~120 lines and are verified against TWO independent
// implementations (openpyxl and LibreOffice) in `npm run verify:xlsx`, which is
// stronger evidence than trusting a dependency to be right.
//
// Strings are written INLINE (`t="inlineStr"`) rather than through the shared
// string table. A shared table is a size optimisation for repetitive sheets and
// an extra part to get wrong; inline strings are universally supported and make
// each cell independently readable.

import type { ExtractionTable } from '../data/extractionTable'
import { zip } from './zip'

/**
 * Escape text for XML content.
 *
 * Control characters are STRIPPED, not escaped: XML 1.0 cannot represent most
 * of them at all, and a stray 0x00 from a mis-parsed PDF would otherwise
 * produce a file that no reader can open. Tab/newline/carriage-return are legal
 * and kept.
 */
function xml(v: string): string {
  return v
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/** Column index (0-based) to spreadsheet letters: 0→A, 26→AA. */
function columnName(index: number): string {
  let n = index + 1
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

/**
 * A worksheet's name, sanitised to Excel's rules.
 *
 * Excel refuses `: \ / ? * [ ]`, refuses more than 31 characters, and refuses an
 * empty name — and it refuses by declaring the whole FILE corrupt rather than by
 * ignoring the sheet, so a schema called "kcat/KM" would produce an export
 * nobody can open.
 */
export function sheetName(raw: string, fallback = 'Sheet1'): string {
  const cleaned = raw.replace(/[:\\/?*[\]]/g, '-').trim().slice(0, 31)
  return cleaned.length > 0 ? cleaned : fallback
}

/** One `<c>` cell. */
function cell(ref: string, value: string | number | null, type: 'text' | 'number'): string {
  if (value === null || value === undefined || value === '') return ''
  if (type === 'number' && typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"><v>${value}</v></c>`
  }
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(String(value))}</t></is></c>`
}

/** The `<sheetData>` body for one table, with a bold header row. */
function sheetXml(table: ExtractionTable): string {
  const rows: string[] = []

  const header = table.columns
    .map((c, i) => `<c r="${columnName(i)}1" t="inlineStr" s="1"><is><t>${xml(c.header)}</t></is></c>`)
    .join('')
  rows.push(`<row r="1">${header}</row>`)

  table.rows.forEach((row, rIdx) => {
    const r = rIdx + 2 // 1-based, and row 1 is the header
    const cells = table.columns
      .map((c, i) => cell(`${columnName(i)}${r}`, row[c.key] ?? null, c.type))
      .join('')
    rows.push(`<row r="${r}">${cells}</row>`)
  })

  // `freezePane` on the header: a 300-row measurement table is unreadable once
  // the column names scroll away.
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetViews><sheetView workbookViewId="0">` +
    `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>` +
    `</sheetView></sheetViews>` +
    `<sheetData>${rows.join('')}</sheetData>` +
    `</worksheet>`
  )
}

/**
 * The style part.
 *
 * Exactly two cell formats: 0 = default, 1 = bold (the header row). Excel
 * requires the numFmts/fonts/fills/borders/cellStyleXfs scaffolding to be
 * present and well-formed even when empty, and omitting any of it is the
 * classic "file is corrupt" failure.
 */
const STYLES_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<fonts count="2">` +
  `<font><sz val="11"/><name val="Calibri"/></font>` +
  `<font><b/><sz val="11"/><name val="Calibri"/></font>` +
  `</fonts>` +
  `<fills count="2"><fill><patternFill patternType="none"/></fill>` +
  `<fill><patternFill patternType="gray125"/></fill></fills>` +
  `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="2">` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
  `</cellXfs>` +
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
  `</styleSheet>`

/**
 * Write one or more tables as a workbook, one sheet per table.
 *
 * Sheet names are de-duplicated: two schemas whose names collide after Excel's
 * 31-character truncation would otherwise produce a file Excel calls corrupt.
 */
export function toXlsx(tables: ExtractionTable[]): Buffer {
  if (tables.length === 0) throw new Error('a workbook needs at least one sheet')

  const used = new Set<string>()
  const names = tables.map((t, i) => {
    const base = sheetName(t.schemaName, `Sheet${i + 1}`)
    let name = base
    let n = 2
    while (used.has(name.toLowerCase())) {
      const suffix = ` (${n++})`
      name = base.slice(0, 31 - suffix.length) + suffix
    }
    used.add(name.toLowerCase())
    return name
  })

  const sheetFiles = tables.map((t, i) => ({
    name: `xl/worksheets/sheet${i + 1}.xml`,
    data: sheetXml(t)
  }))

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    tables
      .map(
        (_t, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
      )
      .join('') +
    `</Types>`

  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`

  // Sheet rIds start at 1 and styles takes the one after the last sheet.
  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    tables
      .map(
        (_t, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
      )
      .join('') +
    `<Relationship Id="rId${tables.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`

  const workbook =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets>` +
    names
      .map((n, i) => `<sheet name="${xml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('') +
    `</sheets></workbook>`

  return zip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
    { name: 'xl/styles.xml', data: STYLES_XML },
    ...sheetFiles
  ])
}
