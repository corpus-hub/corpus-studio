/*
 * Drive the outlets against a REAL vault and a REAL database.
 *
 * These are the checks that matter for an outlet, and none of them can be made
 * by reading the code:
 *
 *   - a setting actually reaches SQLite (the whole point of the rewrite: the
 *     screen used to hold switch positions in React state behind a "not saved"
 *     badge, which is a control that controls nothing);
 *   - "write notes" writes real files whose content matches the database;
 *   - a second run is IDEMPOTENT and says so, rather than reporting 22 writes
 *     that did nothing;
 *   - a note the user EDITED BY HAND survives — the single worst thing this
 *     feature could do is silently destroy a scientist's own annotations;
 *   - a notes folder that escapes the vault is REFUSED, because a note filename
 *     derives from a paper title and a title is untrusted data out of a PDF;
 *   - the Zotero RDF parses as XML and carries DOI identifiers, which is what
 *     lets Zotero MERGE an import instead of duplicating the user's library.
 *
 *   npm run verify:outlets
 */
import { initDatabase } from '../src/main/db/connection'
import {
  readAllOutletSettings,
  readOutletRun,
  readOutletSettings,
  recordOutletRun,
  writeOutletSettings
} from '../src/main/outlets/settings'
import { outletActions, outletStatuses, runOutletAction } from '../src/main/outlets/registry'
import { buildProjectNotes } from '../src/main/outlets/obsidian/build'
import { renderZoteroRdf } from '../src/main/outlets/zotero/rdf'
import { planAttachments } from '../src/main/outlets/zotero/attachments'
import { listCollectionItems, listCollections } from '../src/main/outlets/zotero/library'
import { importItems } from '../src/main/outlets/zotero/import'
import { renderNote, noteFilename } from '../src/shared/markdown'
import Database from 'better-sqlite3'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultDbPath } from '../src/main/db/paths'

/**
 * A synthetic Zotero data directory: one collection, three items, each with a
 * STORED PDF attachment in its own `storage/<key>/` folder.
 *
 * Synthetic rather than the developer's own library so the check runs anywhere,
 * and because the per-item storage folder is precisely the shape that made the
 * import create a storage location per paper.
 */
function makeZoteroFixture(): { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'corpus-zotero-fixture-'))
  const z = new Database(join(dir, 'zotero.sqlite'))
  z.exec(`
    CREATE TABLE collections (collectionID INTEGER PRIMARY KEY, collectionName TEXT, key TEXT, parentCollectionID INTEGER);
    CREATE TABLE items (itemID INTEGER PRIMARY KEY, key TEXT);
    CREATE TABLE collectionItems (collectionID INT, itemID INT);
    CREATE TABLE deletedItems (itemID INT);
    CREATE TABLE fields (fieldID INTEGER PRIMARY KEY, fieldName TEXT);
    CREATE TABLE itemDataValues (valueID INTEGER PRIMARY KEY, value TEXT);
    CREATE TABLE itemData (itemID INT, fieldID INT, valueID INT);
    CREATE TABLE creators (creatorID INTEGER PRIMARY KEY, firstName TEXT, lastName TEXT);
    CREATE TABLE itemCreators (itemID INT, creatorID INT, orderIndex INT);
    CREATE TABLE itemAttachments (itemID INTEGER PRIMARY KEY, parentItemID INT, path TEXT, contentType TEXT);
    INSERT INTO collections VALUES (1,'Kemp eliminases','COLKEY1',NULL);
    INSERT INTO fields VALUES (1,'title'),(2,'DOI'),(3,'date'),(4,'publicationTitle');
  `)
  for (let i = 1; i <= 3; i++) {
    z.prepare('INSERT INTO items VALUES (?,?)').run(i, `ITEMKEY${i}`)
    z.prepare('INSERT INTO collectionItems VALUES (1,?)').run(i)
    z.prepare('INSERT INTO itemDataValues VALUES (?,?)').run(i * 10 + 1, `Synthetic fixture paper ${i}`)
    z.prepare('INSERT INTO itemData VALUES (?,1,?)').run(i, i * 10 + 1)
    z.prepare('INSERT INTO itemDataValues VALUES (?,?)').run(i * 10 + 2, `10.9999/fixture${i}`)
    z.prepare('INSERT INTO itemData VALUES (?,2,?)').run(i, i * 10 + 2)

    const attKey = `ATTKEY${i}`
    z.prepare('INSERT INTO items VALUES (?,?)').run(100 + i, attKey)
    z.prepare('INSERT INTO itemAttachments VALUES (?,?,?,?)').run(
      100 + i,
      i,
      'storage:paper.pdf',
      'application/pdf'
    )
    const storageDir = join(dir, 'storage', attKey)
    mkdirSync(storageDir, { recursive: true })
    writeFileSync(join(storageDir, 'paper.pdf'), '%PDF-1.4 fixture\n')
  }
  z.close()
  return { dir }
}

let failures = 0
async function check(name: string, fn: () => unknown | Promise<unknown>): Promise<void> {
  try {
    await fn()
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

async function main(): Promise<void> {
  const db = initDatabase(defaultDbPath())
  const vault = mkdtempSync(join(tmpdir(), 'corpus-vault-'))
  const projectId = 1
  const noteDir = join(vault, 'Corpus Studio')

  // Restored at the end: this script drives the user's real DB, and leaving
  // their Obsidian outlet pointed at a temp directory would be a side effect
  // they did not ask for.
  const original = readOutletSettings(db, 'obsidian')
  const originalRun = readOutletRun(db, 'obsidian')

  const zoteroFixture = makeZoteroFixture()
  const countBaseDirs = (): number =>
    (db.prepare('SELECT COUNT(*) AS c FROM base_dir').get() as { c: number }).c
  /** Undo the fixture import so the developer's own DB is left as it was found. */
  const cleanupImportedFixture = (): void => {
    db.exec(`
      DELETE FROM file_location WHERE base_dir_id IN
        (SELECT id FROM base_dir WHERE label LIKE 'Zotero%');
      DELETE FROM document WHERE work_id IN
        (SELECT id FROM work WHERE title LIKE 'Synthetic fixture paper%');
      DELETE FROM project_work WHERE work_id IN
        (SELECT id FROM work WHERE title LIKE 'Synthetic fixture paper%');
      DELETE FROM identifier WHERE work_id IN
        (SELECT id FROM work WHERE title LIKE 'Synthetic fixture paper%');
      DELETE FROM work_author WHERE work_id IN
        (SELECT id FROM work WHERE title LIKE 'Synthetic fixture paper%');
      DELETE FROM work WHERE title LIKE 'Synthetic fixture paper%';
      DELETE FROM base_dir WHERE label LIKE 'Zotero%';
    `)
  }

  await check('an unconfigured outlet returns defaults rather than throwing', () => {
    const s = readAllOutletSettings(db)
    eq(typeof s.zotero.summary_notes, 'boolean', 'summary_notes')
    // Off by default: turning it on changes a text file into a copy of the
    // corpus, which is not something to happen to a user who never asked.
    eq(s.zotero.include_pdfs, false, 'include_pdfs default')
  })

  await check('a setting PERSISTS, and the setter returns the new state', () => {
    const next = writeOutletSettings(db, 'obsidian', {
      vault_path: vault,
      folder: 'Corpus Studio'
    })
    eq(next.vault_path, vault, 'returned state')
    eq(readOutletSettings(db, 'obsidian').vault_path, vault, 'value re-read from SQLite')
  })

  await check('an unknown settings key is REJECTED, keeping the row parseable', () => {
    try {
      writeOutletSettings(db, 'obsidian', { not_a_real_setting: 1 })
    } catch {
      return
    }
    throw new Error('an unknown key was accepted')
  })

  const notes = buildProjectNotes(db, projectId)
  await check('notes are built from the database, carrying real extracted facts', () => {
    if (notes.length === 0) throw new Error('no notes built')
    if (!notes.some((n) => n.facts.length > 0)) throw new Error('no note carries any fact')
  })

  await check('every outlet reports a status without throwing', async () => {
    const statuses = await outletStatuses(db, projectId)
    eq(statuses.length, 2, 'outlet count')
    for (const s of statuses) {
      if (!s.status.headline) throw new Error(`${s.id} has no headline`)
      // Tri-state discipline: a check may be null, but never undefined.
      for (const c of s.status.checks) {
        if (c.ok === undefined) throw new Error(`${s.id}/${c.label} is undefined, not tri-state`)
        if (!c.detail) throw new Error(`${s.id}/${c.label} has no detail to justify its claim`)
      }
    }
  })

  await check('an UNCONFIGURED outlet answers "no", never "unknown"', async () => {
    // `null` means "the probe could not be answered" — a hung mount, a directory
    // we may not read. "Nothing has been configured yet" IS an answer, and
    // reporting it as unknown drains the meaning from the state that exists to
    // flag genuine uncertainty. This shipped twice (both outlets) before being
    // caught by looking at the screen, so it is pinned here.
    writeOutletSettings(db, 'obsidian', { vault_path: null })
    const [, obsidian] = await outletStatuses(db, projectId)
    for (const c of obsidian.status.checks) {
      if (c.ok === null) {
        throw new Error(`"${c.label}" reports unknown when nothing is configured`)
      }
    }
    writeOutletSettings(db, 'obsidian', { vault_path: vault })
  })

  await check('writing notes creates real files that match the database', async () => {
    const res = await runOutletAction(db, projectId, 'obsidian', 'write')
    if (!res.ok) throw new Error(res.error ?? res.message)
    const files = readdirSync(noteDir)
    eq(files.length, notes.length, 'files written')
    // The file on disk IS what the shared renderer produces — the same function
    // the UI previews with, so a preview cannot promise a different file.
    const note = notes[0]
    const path = join(noteDir, `${noteFilename(note.work.title)}.md`)
    const onDisk = readFileSync(path, 'utf8')
    const expected = renderNote(note, { backlinks: readOutletSettings(db, 'obsidian').backlinks })
    if (!onDisk.includes(expected.split('\n').slice(-3).join('\n').trim())) {
      throw new Error('the file body does not match the shared renderer')
    }
    if (!onDisk.includes(`corpus_work_id: ${note.work.id}`)) {
      throw new Error('no stable identity stamped into the note')
    }
  })

  await check('a second run is idempotent and REPORTS that nothing changed', async () => {
    const res = await runOutletAction(db, projectId, 'obsidian', 'write')
    if (!res.message.includes('already up to date')) {
      throw new Error(`a no-op run reported: ${res.message}`)
    }
  })

  await check('a HAND-EDITED note is never silently overwritten', async () => {
    const file = join(noteDir, readdirSync(noteDir)[0])
    const mine = '\n\nMy own reading notes.\n'
    writeFileSync(file, readFileSync(file, 'utf8') + mine)
    const res = await runOutletAction(db, projectId, 'obsidian', 'write')
    if (!res.message.includes('edited by hand')) {
      throw new Error(`conflict not reported: ${res.message}`)
    }
    if (!readFileSync(file, 'utf8').includes('My own reading notes.')) {
      throw new Error('THE USER EDIT WAS DESTROYED')
    }
  })

  await check('...but the overwrite action does replace it, as its label says', async () => {
    const file = join(noteDir, readdirSync(noteDir)[0])
    await runOutletAction(db, projectId, 'obsidian', 'overwrite')
    if (readFileSync(file, 'utf8').includes('My own reading notes.')) {
      throw new Error('overwrite left the hand edit in place')
    }
  })

  await check("cleanup removes OUR stale notes and nothing of the user's", async () => {
    // A note we wrote for a paper that has since left the project.
    const stale = join(noteDir, 'A paper that left this project.md')
    const ourNote = readdirSync(noteDir).find((f) => f.endsWith('.md'))!
    writeFileSync(stale, readFileSync(join(noteDir, ourNote), 'utf8'))
    // ...and a file that is the user's own, which must survive untouched.
    const mine = join(noteDir, 'My literature review.md')
    writeFileSync(mine, '# my own thoughts\n')

    const res = await runOutletAction(db, projectId, 'obsidian', 'cleanup')
    if (!res.ok) throw new Error(res.error ?? res.message)
    if (existsSync(stale)) throw new Error('the stale note was not removed')
    if (!existsSync(mine)) throw new Error("THE USER'S OWN FILE WAS DELETED")
    // Every real note is still there.
    if (readdirSync(noteDir).filter((f) => f !== 'My literature review.md').length !== notes.length) {
      throw new Error('cleanup removed notes that still match a paper')
    }
    rmSync(mine)
  })

  await check('cleanup is idempotent and says so when there is nothing to do', async () => {
    const res = await runOutletAction(db, projectId, 'obsidian', 'cleanup')
    if (!res.message.toLowerCase().includes('nothing to remove')) {
      throw new Error(`a no-op cleanup reported: ${res.message}`)
    }
  })

  await check('a notes folder that escapes the vault is refused', async () => {
    writeOutletSettings(db, 'obsidian', { folder: '../../escaped' })
    const res = await runOutletAction(db, projectId, 'obsidian', 'write')
    if (res.ok) throw new Error('a path escaping the vault was allowed')
    writeOutletSettings(db, 'obsidian', { folder: 'Corpus Studio' })
  })

  await check('an action is refused when its precondition is gone', async () => {
    writeOutletSettings(db, 'obsidian', { vault_path: null })
    const acts = outletActions(db, projectId, 'obsidian')
    if (!acts.every((a) => a.disabledReason)) {
      throw new Error('actions still enabled with no vault')
    }
    // And main ENFORCES it rather than trusting the UI to have disabled it.
    const res = await runOutletAction(db, projectId, 'obsidian', 'write')
    if (res.ok) throw new Error('an action ran with no vault configured')
    writeOutletSettings(db, 'obsidian', { vault_path: vault })
  })

  // ---- Zotero: reading a real library, and importing from it ---------------
  // Driven against a SYNTHETIC zotero.sqlite rather than the developer's own, so
  // the check runs on any machine and exercises the schema we actually query.
  await check('a Zotero library can be read at all', () => {
    const collections = listCollections(zoteroFixture.dir)
    eq(collections.length, 1, 'collection count')
    eq(collections[0].path, 'Kemp eliminases', 'collection path')
    eq(collections[0].itemCount, 3, 'item count')
    // This is the regression guard for a real shipped bug: the reader passed
    // `file:<path>?immutable=1` to better-sqlite3, which has no `uri` option and
    // treated the whole string as a filename — so EVERY read failed with
    // "directory does not exist" and no test noticed.
  })

  await check('importing a collection creates ONE storage location, not one per PDF', () => {
    const items = listCollectionItems(zoteroFixture.dir, 'COLKEY1')
    eq(items.length, 3, 'items read')
    eq(items.filter((i) => i.attachmentPath).length, 3, 'items with a PDF')

    const before = countBaseDirs()
    const summary = importItems(db, projectId, items, zoteroFixture.dir)
    const added = countBaseDirs() - before
    eq(summary.added, 3, 'works added')
    eq(summary.withPdf, 3, 'PDFs recorded')
    // A Zotero STORED attachment lives in `storage/<itemKey>/`, a folder unique
    // to that item. Deriving a base dir from the file's parent therefore added
    // one storage location PER PAPER: a 200-item import filled Settings with 200
    // rows, none removable (each had a document depending on it).
    eq(added, 1, 'storage locations added')
    const rel = db
      .prepare(
        `SELECT relative_path FROM file_location
          WHERE base_dir_id = (SELECT id FROM base_dir WHERE label = 'Zotero library')`
      )
      .all() as Array<{ relative_path: string }>
    if (!rel.every((r) => r.relative_path.startsWith('storage/'))) {
      throw new Error(`relative paths are not library-relative: ${JSON.stringify(rel)}`)
    }
    cleanupImportedFixture()
  })

  await check('the Zotero RDF imports as a COLLECTION, with the PDFs attached', async () => {
    const plan = await planAttachments(notes, true)
    const rdf = renderZoteroRdf(
      plan.exportable,
      { summaryNotes: true, projectNotes: true, attachments: plan.paths },
      'Fixture collection'
    )
    // Without the collection an import scattered N loose items into the user's
    // library, leaving them to find and group 22 papers by hand.
    eq((rdf.match(/<z:Collection/g) ?? []).length, 1, 'collection elements')
    eq(
      (rdf.match(/<dcterms:hasPart/g) ?? []).length,
      plan.exportable.length,
      'collection members'
    )
    // Every member must resolve to an item in the same file, or the collection
    // imports empty. The data note is a Memo rather than an Article, so it is a
    // legitimate member with no bib:Article of its own.
    const ids = new Set(Array.from(rdf.matchAll(/<bib:Article rdf:about="([^"]+)"/g), (m) => m[1]))
    ids.add('#data_table')
    for (const [, target] of rdf.matchAll(/<dcterms:hasPart rdf:resource="([^"]+)"/g)) {
      if (!ids.has(target)) throw new Error(`collection references a missing item: ${target}`)
    }
    // Every paper in the bundle brings its file: with this switch on, the ones
    // that could not is precisely the set that was dropped.
    eq(
      (rdf.match(/<z:Attachment/g) ?? []).length,
      plan.exportable.length,
      'attachments'
    )
  })

  await check('a bundled export links its PDFs RELATIVELY, never by machine path', async () => {
    const plan = await planAttachments(notes, true)
    const rdf = renderZoteroRdf(
      plan.exportable,
      { summaryNotes: true, projectNotes: true, attachments: plan.paths },
      'Fixture collection'
    )
    // The whole reason the bundle exists. An absolute `file://` resolves for
    // exactly one person on one machine, which is a link that silently stops
    // working the moment the export is used for what an export is for.
    if (/rdf:resource="(file:|\/)/.test(rdf)) {
      throw new Error('an attachment is linked by absolute path')
    }
    for (const [, target] of rdf.matchAll(
      /<z:Attachment[\s\S]*?<rdf:resource rdf:resource="([^"]+)"/g
    )) {
      if (!target.startsWith('files/')) throw new Error(`attachment outside files/: ${target}`)
    }
  })

  await check('a paper with no readable PDF is dropped WHOLE, not left as a stub', async () => {
    const missing: typeof notes = notes.map((n, i) =>
      i === 0 ? { ...n, work: { ...n.work, pdfPath: '/nonexistent/never-retrieved.pdf' } } : n
    )
    const plan = await planAttachments(missing, true)
    eq(plan.skipped, 1, 'papers left out')
    eq(plan.exportable.length, missing.length - 1, 'papers kept')
    const rdf = renderZoteroRdf(
      plan.exportable,
      { summaryNotes: true, projectNotes: true, attachments: plan.paths },
      'Fixture collection'
    )
    // The record must be gone too. A bibliography row with no file is a paper
    // the recipient believes they have and cannot open — worse than an absence.
    if (rdf.includes(missing[0].work.title)) {
      throw new Error('an unretrieved paper still has a bibliography record')
    }
  })

  await check('with the switch OFF nothing is dropped and nothing is attached', async () => {
    const plan = await planAttachments(notes, false)
    eq(plan.exportable.length, notes.length, 'every paper kept')
    eq(plan.skipped, 0, 'nothing dropped')
    const rdf = renderZoteroRdf(plan.exportable, { summaryNotes: true, projectNotes: true })
    // No attachment at all rather than a machine-local link: the switch is the
    // whole of the user's choice about whether papers travel.
    eq((rdf.match(/<z:Attachment/g) ?? []).length, 0, 'attachments')
  })

  await check('the Zotero export uses Zotero\'s own features, not just text', () => {
    const rdf = renderZoteroRdf(notes, { summaryNotes: true, projectNotes: true }, 'Fixture')
    // Tags: prefixed so they do not scatter among the user's own in Zotero's
    // flat tag selector, and de-duplicated per item.
    const tags = Array.from(rdf.matchAll(/<dc:subject>([^<]+)</g), (m) => m[1])
    if (tags.length === 0) throw new Error('no tags emitted')
    if (!tags.every((t) => /^(role|status|claim|checks|fold|source): /.test(t))) {
      throw new Error(`unprefixed tag: ${tags.find((t) => !t.includes(': '))}`)
    }
    // Related items must never point at an item this file does not contain.
    const ids = new Set(Array.from(rdf.matchAll(/<bib:Article rdf:about="([^"]+)"/g), (m) => m[1]))
    for (const [, target] of rdf.matchAll(/<dc:relation rdf:resource="([^"]+)"/g)) {
      if (!ids.has(target)) throw new Error(`relation points at a missing item: ${target}`)
    }
    // `extra` names the PROJECT, which means something to a reader — and not the
    // internal row id, which was a database key on display in someone's library.
    if (!/<dc:description>Corpus Studio · /.test(rdf)) {
      throw new Error('the extra field does not name the project')
    }
  })

  await check('exported notes explain their terms instead of leaking enum keys', () => {
    const rdf = renderZoteroRdf(notes, { summaryNotes: true, projectNotes: true })
    const md = notes.map((n) => renderNote(n, { backlinks: true })).join('\n')
    // A stored key is a term of art with no definition attached, arriving in a
    // library where nothing explains it. The BODY must spell them out; the
    // frontmatter deliberately keeps raw keys for querying.
    const body = md.replace(/^---[\s\S]*?\n---/gm, '')
    for (const raw of [
      'directly-reported',
      'supplied-by-project-context',
      'uncertain-conflicting'
    ]) {
      if (body.includes(raw)) throw new Error(`raw key "${raw}" reached the note body`)
      if (rdf.includes(`— ${raw}`)) throw new Error(`raw key "${raw}" reached a Zotero note`)
    }
    if (!rdf.includes('Stated directly in the paper')) {
      throw new Error('fact kinds are not spelled out in the Zotero note')
    }
    // And every note says WHERE its numbers came from.
    if (!rdf.includes('via Corpus Studio')) throw new Error('no attribution in the Zotero note')
  })

  await check('the export withholds nothing and invents nothing', () => {
    const rdf = renderZoteroRdf(notes, { summaryNotes: true, projectNotes: true }, 'Fixture')

    // EVERY paper, whatever its metadata. An earlier version withheld records
    // with no author and no DOI because they "could not be cited", which made
    // the export silently disagree with the app about what the project holds.
    // Deciding a record is not worth having is the user's call, in the app.
    eq((rdf.match(/<bib:Article/g) ?? []).length, notes.length, 'articles exported')

    // And the model is named EXACTLY as recorded. Rewriting names that looked
    // like development harnesses into "by a language model" was a fabricated
    // provenance — the precise failure this app exists to prevent.
    const models = new Set(
      notes.map((n) => n.provenance?.model).filter((m): m is string => Boolean(m))
    )
    for (const m of models) {
      if (!rdf.includes(`by ${m}`)) throw new Error(`model "${m}" is not credited verbatim`)
    }

    // Internal machine state is a different matter: it is not withheld data, it
    // is a detail of HOW the app ran, and it belongs in the CSV/XLSX exports
    // where someone auditing provenance will look.
    for (const leak of ['prompt_version', 'Run origin', 'Prompt version', 'Corpus Studio work ']) {
      if (rdf.includes(leak)) throw new Error(`internal detail "${leak}" reached the export`)
    }
  })

  await check('the Zotero RDF is valid XML carrying one item per paper', () => {
    const rdf = renderZoteroRdf(notes, { summaryNotes: true, projectNotes: true })
    const articles = (rdf.match(/<bib:Article/g) ?? []).length
    eq(articles, notes.length, 'article count')
    // Every item that HAS a DOI must carry it: that identifier is what lets
    // Zotero merge an import into an existing library instead of duplicating it.
    const withDoi = notes.filter((n) => n.work.doi).length
    const identifiers = (rdf.match(/<dc:identifier>DOI /g) ?? []).length
    eq(identifiers, withDoi, 'DOI identifiers')
    if (!rdf.startsWith('<?xml')) throw new Error('no XML declaration')
    // A stray unescaped `&` is the classic way to produce a file Zotero rejects.
    const stray = rdf.match(/&(?!(amp|lt|gt|quot|apos|#\d+);)/g)
    if (stray) throw new Error(`${stray.length} unescaped ampersand(s)`)
  })

  await check('note filenames are safe for the filesystem AND for wiki links', () => {
    eq(noteFilename('a/b:c*d?e"f<g>h|i'), 'a-b-c-d-e-f-g-h-i', 'illegal characters')
    // Every character that would break a wiki link is replaced 1:1, so `[[` ->
    // `--`; the trailing `-` from `^ref` is then trimmed with the whitespace.
    eq(noteFilename('[[wiki]] #tag ^ref'), '--wiki-- -tag -ref', 'link syntax')
    eq(noteFilename('   '), 'Untitled', 'empty falls back')
    if (noteFilename('x'.repeat(300)).length > 120) throw new Error('not truncated')
  })

  // Leave the user's own configuration exactly as it was found. The last-run
  // record is cleared too: this script deliberately provokes failures, and
  // leaving one behind would show the user a "last run failed" banner about a
  // vault that only ever existed inside this test.
  writeOutletSettings(db, 'obsidian', {
    vault_path: original.vault_path,
    folder: original.folder
  })
  recordOutletRun(db, 'obsidian', { at: originalRun.at, error: originalRun.error })
  rmSync(vault, { recursive: true, force: true })
  rmSync(zoteroFixture.dir, { recursive: true, force: true })

  console.log(
    failures === 0 ? '\nALL OUTLET CHECKS PASSED' : `\n${failures} OUTLET CHECK(S) FAILED`
  )
  process.exit(failures === 0 ? 0 : 1)
}

void main()
