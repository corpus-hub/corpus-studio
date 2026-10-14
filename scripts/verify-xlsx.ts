/*
 * Prove the hand-written .xlsx writer produces files real spreadsheet software
 * actually opens.
 *
 * This gate is the ENTIRE justification for not depending on a spreadsheet
 * library. Writing OOXML by hand is only defensible if the output is checked
 * against independent implementations rather than against my own assumptions
 * about the format — so the workbook is read back by:
 *
 *   1. openpyxl   (Python, an independent OOXML implementation)
 *   2. LibreOffice (converts to CSV headlessly — a third implementation, and
 *                   the one most likely to reject a malformed part)
 *
 * and every cell is compared against the table that went in.
 *
 * KNOWN GAP, stated rather than hidden: neither reader is Microsoft Excel,
 * which is stricter than both. Excel cannot be run on the Linux build host. The
 * writer therefore sticks to the most boring subset of the format (inline
 * strings, two cell formats, no shared-string table) precisely because that
 * subset is what every reader implements correctly.
 *
 *   npm run verify:xlsx
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toXlsx, sheetName } from '../src/main/export/serialize/xlsx'
import { toCsv } from '../src/main/export/serialize/csv'
import type { ExtractionTable } from '../src/main/export/data/extractionTable'

let failures = 0
function check(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`ok    ${name}`)
  } catch (e) {
    failures++
    console.log(`FAIL  ${name}\n      ${e instanceof Error ? e.message : String(e)}`)
  }
}
function eq(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) {
    throw new Error(`${what}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
}

// A table exercising everything that breaks hand-written OOXML: XML
// metacharacters, quotes, non-ASCII scientific notation, a value that looks
// numeric but is text, nulls, a newline inside a cell, and a very long string.
const TRICKY: ExtractionTable = {
  schemaName: 'Enzyme Kinetics',
  schemaKey: 'enzyme-kinetics',
  schemaVersion: 'v1',
  projectName: 'Test project',
  columns: [
    { key: 'paper', header: 'Paper', type: 'text' },
    { key: 'value', header: 'Value', type: 'number' },
    { key: 'raw', header: 'Value (as reported)', type: 'text' },
    { key: 'unit', header: 'Unit', type: 'text' },
    { key: 'note', header: 'Note & <caveat>', type: 'text' }
  ],
  rows: [
    { paper: 'Röthlisberger 2008', value: 12.5, raw: null, unit: 's^-1', note: 'ΔΔG ≈ 1.2 kcal/mol' },
    { paper: 'A & B <et al>', value: 95, raw: '>95', unit: '°C', note: 'quote: "greater than"' },
    { paper: "O'Brien 2011", value: null, raw: 'not reported', unit: null, note: 'line1\nline2' },
    { paper: 'Long'.repeat(200), value: -0.5, raw: null, unit: 'µM', note: null }
  ]
}

const dir = mkdtempSync(join(tmpdir(), 'corpus-xlsx-'))
const xlsxPath = join(dir, 'tricky.xlsx')

check('the writer produces a non-trivial buffer starting with the ZIP magic', () => {
  const buf = toXlsx([TRICKY])
  writeFileSync(xlsxPath, buf)
  if (buf.length < 500) throw new Error(`only ${buf.length} bytes`)
  eq(buf.subarray(0, 2).toString('latin1'), 'PK', 'zip magic')
})

// ---------------------------------------------------------------- openpyxl
const PY = `
import sys, json
from openpyxl import load_workbook
wb = load_workbook(sys.argv[1])
out = {"sheets": wb.sheetnames, "cells": []}
ws = wb[wb.sheetnames[0]]
for row in ws.iter_rows():
    out["cells"].append([c.value for c in row])
print(json.dumps(out, default=str))
`

check('openpyxl opens the workbook and reads every cell back correctly', () => {
  const pyFile = join(dir, 'read.py')
  writeFileSync(pyFile, PY)
  const raw = execFileSync('python3', [pyFile, xlsxPath], { encoding: 'utf8' })
  const got = JSON.parse(raw) as { sheets: string[]; cells: unknown[][] }

  eq(got.sheets.length, 1, 'sheet count')
  eq(got.sheets[0], sheetName(TRICKY.schemaName), 'sheet name')

  // Header row.
  eq(got.cells[0].length, TRICKY.columns.length, 'header column count')
  TRICKY.columns.forEach((c, i) => eq(got.cells[0][i], c.header, `header ${i}`))

  // Body: every value round-trips, including the ones that break naive writers.
  eq(got.cells.length, TRICKY.rows.length + 1, 'row count')
  TRICKY.rows.forEach((row, r) => {
    TRICKY.columns.forEach((c, i) => {
      const expected = row[c.key]
      const actual = got.cells[r + 1][i]
      if (expected === null || expected === '') {
        if (actual !== null) throw new Error(`r${r} ${c.key}: expected empty, got ${actual}`)
        return
      }
      if (typeof expected === 'number') {
        eq(Number(actual), expected, `r${r} ${c.key}`)
        return
      }
      eq(actual, expected, `r${r} ${c.key}`)
    })
  })
})

check('numbers are written as NUMBERS, not text (so a spreadsheet can sum them)', () => {
  const pyFile = join(dir, 'types.py')
  writeFileSync(
    pyFile,
    `
import sys, json
from openpyxl import load_workbook
ws = load_workbook(sys.argv[1]).worksheets[0]
print(json.dumps([type(c.value).__name__ for c in ws[2]]))
`
  )
  const kinds = JSON.parse(
    execFileSync('python3', [pyFile, xlsxPath], { encoding: 'utf8' })
  ) as string[]
  // Column 1 (0-based) is `value` = 12.5.
  if (!['int', 'float'].includes(kinds[1])) {
    throw new Error(`value cell came back as ${kinds[1]}, not a number`)
  }
})

// ------------------------------------------------------------- LibreOffice
check('LibreOffice opens the workbook (a third, stricter implementation)', () => {
  const soffice = ['/usr/bin/soffice', '/usr/bin/libreoffice'].find((p) => existsSync(p))
  // A MISSING READER FAILS, exactly as a missing python3 or openpyxl already
  // does one check up. This gate's only claim is that hand-written OOXML was
  // read back by implementations that are not mine; a host without the second
  // one cannot make that claim, and printing `ok` for a check that never ran is
  // the worst thing a verifier can do — the line is indistinguishable from the
  // workbook actually having been opened.
  if (!soffice) {
    throw new Error(
      'no LibreOffice at /usr/bin/soffice or /usr/bin/libreoffice — the independent reader ' +
        'this check exists to run is not installed, so the workbook was NOT verified. ' +
        'Install it (apt install libreoffice-calc) and run `npm run verify:xlsx` again.'
    )
  }
  const outDir = join(dir, 'lo')
  execFileSync(
    soffice,
    [
      '--headless',
      '--convert-to',
      'csv:Text - txt - csv (StarCalc):44,34,76,1',
      '--outdir',
      outDir,
      xlsxPath
    ],
    { encoding: 'utf8', stdio: 'pipe', timeout: 120_000, env: { ...process.env, HOME: dir } }
  )
  const csvPath = join(outDir, 'tricky.csv')
  if (!existsSync(csvPath)) throw new Error('LibreOffice produced no output — it rejected the file')
  const text = readFileSync(csvPath, 'utf8')
  // Spot-check that content survived a full independent parse + re-render.
  for (const needle of ['Röthlisberger 2008', '12.5', 'ΔΔG', '>95', 'Note & <caveat>']) {
    if (!text.includes(needle)) throw new Error(`LibreOffice output is missing ${needle}`)
  }
})

// -------------------------------------------------------------------- CSV
check('CSV quotes exactly the cells that need it, and never writes "null"', () => {
  const csv = toCsv(TRICKY)
  const lines = csv.replace(/^\uFEFF/, '').split('\r\n')
  eq(lines[0], 'Paper,Value,Value (as reported),Unit,Note & <caveat>', 'header line')
  // A quoted cell containing a quote doubles it; an empty value is empty.
  if (!lines[2].includes('"quote: ""greater than"""')) {
    throw new Error(`inner quotes not doubled: ${lines[2]}`)
  }
  if (csv.includes('null')) throw new Error('the literal text "null" reached the CSV')
  // A cell containing a newline must be quoted, so the row count is preserved.
  if (!csv.includes('"line1\nline2"')) throw new Error('embedded newline was not quoted')
})

check('a sheet name that Excel would reject is sanitised', () => {
  eq(sheetName('kcat/KM [raw]'), 'kcat-KM -raw-', 'illegal characters replaced')
  eq(sheetName('x'.repeat(50)).length, 31, 'truncated to 31')
  eq(sheetName('   '), 'Sheet1', 'empty falls back')
})

check('two schemas with colliding truncated names still produce a valid file', () => {
  const a = { ...TRICKY, schemaName: 'A'.repeat(40) }
  const b = { ...TRICKY, schemaName: 'A'.repeat(40) }
  const p = join(dir, 'dup.xlsx')
  writeFileSync(p, toXlsx([a, b]))
  const pyFile = join(dir, 'names.py')
  writeFileSync(
    pyFile,
    `
import sys, json
from openpyxl import load_workbook
print(json.dumps(load_workbook(sys.argv[1]).sheetnames))
`
  )
  const names = JSON.parse(
    execFileSync('python3', [pyFile, p], { encoding: 'utf8' })
  ) as string[]
  eq(names.length, 2, 'sheet count')
  if (names[0] === names[1]) throw new Error(`sheet names collided: ${names.join(', ')}`)
  for (const n of names) if (n.length > 31) throw new Error(`sheet name too long: ${n}`)
})

rmSync(dir, { recursive: true, force: true })

console.log(
  failures === 0 ? '\nALL XLSX CHECKS PASSED' : `\n${failures} XLSX CHECK(S) FAILED`
)
process.exit(failures === 0 ? 0 : 1)
