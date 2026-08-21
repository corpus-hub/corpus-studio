// A CONFIGURATION THAT COULD NOT BE READ IS NOT AN EMPTY CONFIGURATION.
//
// Every schema here defaults every field, so a row that would not parse used to
// fall through `safeJson` -> `{}` and validate cleanly into the defaults. The
// caller was then told, with no qualification, that this outlet had never been
// set up. Two things followed, and the second is the damaging one:
//
//   1. A user who HAD pointed Obsidian at their vault saw an empty path field.
//   2. `writeOutletSettings` merges a partial patch onto "current". With
//      "current" silently standing in as the defaults, toggling any unrelated
//      switch wrote those defaults into the row -- so the vault path was not
//      merely hidden, it was erased, by a gesture that had nothing to do with it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DB } from '../db/connection'
import { readOutletSettings, readOutletSettingsChecked, writeOutletSettings } from './settings'

/**
 * The smallest thing that behaves like the `setting` table.
 *
 * `getSetting`/`setSetting` are the only database surface this module touches,
 * and they are reached through `db.prepare(...)`. Standing a real SQLite file up
 * would test better-sqlite3, not the decision under test.
 */
function fakeDb(rows: Record<string, string> = {}): DB {
  return {
    prepare(sql: string) {
      if (/^\s*SELECT\s+value\s+FROM\s+setting/i.test(sql)) {
        return { get: (key: string) => (key in rows ? { value: rows[key] } : undefined) }
      }
      return {
        run: (key: string, value: string) => {
          rows[key] = value
        }
      }
    },
    // Exposed so a test can inspect what was actually persisted.
    __rows: rows
  } as unknown as DB
}

const rowsOf = (db: DB): Record<string, string> =>
  (db as unknown as { __rows: Record<string, string> }).__rows

test('an outlet with no row is unconfigured AND intact', () => {
  // Never set up is a real state, not a fault. Reporting it as damaged would put
  // a warning on every fresh install.
  const r = readOutletSettingsChecked(fakeDb(), 'obsidian')
  assert.equal(r.intact, true)
  assert.equal(r.settings.vault_path, null)
})

test('a stored configuration reads back as itself', () => {
  const db = fakeDb({
    'outlet.obsidian': JSON.stringify({ vault_path: '/v', folder: 'F', backlinks: false, auto_mirror: true })
  })
  const r = readOutletSettingsChecked(db, 'obsidian')
  assert.equal(r.intact, true)
  assert.equal(r.settings.vault_path, '/v')
  assert.equal(r.settings.folder, 'F')
})

test('a row that is not JSON is reported NOT intact, not as unconfigured', () => {
  const r = readOutletSettingsChecked(fakeDb({ 'outlet.obsidian': '{"vault_path":' }), 'obsidian')
  assert.equal(r.intact, false, 'this is the whole distinction that was missing')
  assert.equal(r.settings.vault_path, null, 'defaults still stand in, so the screen renders')
})

test('a row of the wrong shape is reported NOT intact', () => {
  const r = readOutletSettingsChecked(fakeDb({ 'outlet.zotero': '{"summary_notes":"yes"}' }), 'zotero')
  assert.equal(r.intact, false)
})

test('writing onto an unreadable row REFUSES rather than merging over it', () => {
  // The damaging path. Without the refusal this call succeeds and writes the
  // defaults -- the user toggled one switch and lost their vault path.
  const db = fakeDb({ 'outlet.obsidian': 'not json' })
  assert.throws(
    () => writeOutletSettings(db, 'obsidian', { backlinks: false }),
    /could not be read/,
    'a partial patch must not merge onto defaults that are standing in for real settings'
  )
})

test('the refusal clears the bad row, so the user is not stuck refusing forever', () => {
  const db = fakeDb({ 'outlet.obsidian': 'not json' })
  assert.throws(() => writeOutletSettings(db, 'obsidian', { backlinks: false }))
  // Second attempt merges onto honest defaults and goes through.
  const next = writeOutletSettings(db, 'obsidian', { vault_path: '/v' })
  assert.equal(next.vault_path, '/v')
  assert.equal(JSON.parse(rowsOf(db)['outlet.obsidian']).vault_path, '/v')
})

test('writing onto an INTACT row still merges, leaving untouched keys alone', () => {
  const db = fakeDb({
    'outlet.obsidian': JSON.stringify({ vault_path: '/v', folder: 'F', backlinks: true, auto_mirror: false })
  })
  const next = writeOutletSettings(db, 'obsidian', { backlinks: false })
  assert.equal(next.backlinks, false)
  assert.equal(next.vault_path, '/v', 'the key the patch did not name must survive')
  assert.equal(next.folder, 'F')
})

test('readOutletSettings stays the simple read for callers that only ACT', () => {
  // Writing a note or revealing a folder refuses on a corrupt row and on an
  // unconfigured one alike, so those callers need no third case.
  assert.equal(readOutletSettings(fakeDb({ 'outlet.obsidian': 'not json' }), 'obsidian').vault_path, null)
})
