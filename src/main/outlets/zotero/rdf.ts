// Render this project as Zotero RDF.
//
// This is how work gets INTO Zotero without writing to `zotero.sqlite`. The user
// saves the file and runs File → Import in Zotero, which creates the items and
// their child notes itself, through its own code, with its own validation. Slower
// than a direct write by exactly one manual step, and it cannot corrupt anything.
//
// The format is Zotero's own RDF export (RDF/XML with the Dublin Core, PRISM,
// FOAF and BIB vocabularies plus Zotero's `z:` namespace). Notes are attached as
// `bib:Memo` children, which is precisely what a Zotero child note is.

import type { NoteInput } from '../../../shared/markdown'
import type { ExtractionTable } from '../../export/data/extractionTable'
import {
  FACT_KIND,
  INCLUSION_STATUS,
  label,
  term
} from '../../../shared/vocabulary'

/** Escape text for XML content and attribute values. */
function xml(v: string): string {
  return v
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** Escape text that will sit inside a note's HTML body. */
function html(v: string): string {
  return xml(v).replaceAll("'", '&apos;')
}

/** Split a display name into Zotero's surname/given parts. */
function splitName(full: string): { given: string; surname: string } {
  const parts = full.trim().split(/\s+/)
  if (parts.length === 1) return { given: '', surname: parts[0] }
  return { given: parts.slice(0, -1).join(' '), surname: parts[parts.length - 1] }
}

/**
 * The extracted values, as a note.
 *
 * NOTHING IS DROPPED. Repeated pairs are kept: eight `Method: CD` rows are eight
 * real measurements (one per variant assayed), and collapsing them to one would
 * silently discard seven results — the note would then disagree with the table
 * beside it and with the app. What looks like stuttering is the corpus.
 *
 * The only tidying is presentational and lossless: the unit is appended just
 * once, since the as-reported text often already carries it and printing both
 * produced `122 M − 1 s − 1 M^-1 s^-1`.
 */
/**
 * Does `text` already end with this unit, however it was typeset?
 *
 * PDF text layers render exponents as spaced minus signs, Unicode minus, or
 * superscript characters — `M − 1 s − 1`, `M-1 s-1`, `M⁻¹ s⁻¹` — for what the
 * database stores canonically as `M^-1 s^-1`. Both sides are reduced to
 * lowercase alphanumerics so those spellings compare equal.
 */
function sameUnit(text: string, unit: string): boolean {
  const flat = (s: string): string =>
    s
      .replace(/[⁻−–—]/g, '-')
      .replace(/[¹]/g, '1')
      .replace(/[²]/g, '2')
      .replace(/[³]/g, '3')
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')
  const f = flat(text)
  const u = flat(unit)
  return u.length > 0 && f.endsWith(u)
}

function noteFacts(n: NoteInput): Array<{ label: string; value: string; kind: string }> {
  const out: Array<{ label: string; value: string; kind: string }> = []
  for (const f of n.facts) {
    const raw = (f.value ?? '').trim()
    // Only a genuinely EMPTY value is skipped — there is nothing to render. A
    // value of "ND" is the paper saying "not determined", which is a real thing
    // the paper said and is preserved verbatim.
    if (!raw) continue
    const unit = (f.unit ?? '').trim()
    // Compared on a NORMALISED form: the as-reported text carries the unit in
    // whatever typography the PDF used (`M − 1 s − 1`) while the stored unit is
    // canonical (`M^-1 s^-1`), so a literal `includes` saw two different strings
    // and printed both — `122 M − 1 s − 1 M^-1 s^-1`.
    const value = unit && !sameUnit(raw, unit) ? `${raw} ${unit}` : raw
    out.push({ label: f.label, value, kind: label(FACT_KIND, f.kind) ?? f.kind })
  }
  return out
}

/** The general summary note: what this paper is, in one block. */
function summaryNote(n: NoteInput): string {
  const bits: string[] = []
  const meta = [
    n.work.authors.length > 0 ? n.work.authors.join(', ') : null,
    n.work.venue,
    n.work.publication_year !== null ? String(n.work.publication_year) : null
  ].filter((x): x is string => Boolean(x))
  if (meta.length > 0) bits.push(`<p><em>${html(meta.join(' · '))}</em></p>`)
  const facts = noteFacts(n)
  if (facts.length > 0) {
    bits.push('<p><strong>Extracted</strong></p><ul>')
    for (const f of facts) {
      // The kind is SPELLED OUT: whether a number was stated by the paper or
      // worked out on its behalf is the single most important thing about it,
      // and the raw enum value does not say that to a reader.
      bits.push(`<li>${html(f.label)}: ${html(f.value)} <em>— ${html(f.kind)}</em></li>`)
    }
    bits.push('</ul>')
  }
  // Attribution, always — including when no model is recorded. A note sitting
  // in someone's Zotero library months from now must say where its numbers came
  // from, or it reads as something the user transcribed from the paper.
  //
  // The model is named EXACTLY as recorded, whatever it is. An earlier version
  // rewrote names that looked like development harnesses into "by a language
  // model" — which is a fabricated provenance, the precise failure this app
  // exists to prevent. If a run was made by something called
  // `scripted-test-fixture`, the note says so, and the reader gets to draw the
  // obvious conclusion. Data that looks wrong is fixed in the data.
  const by = n.provenance?.model ? `by ${html(n.provenance.model)}` : ''
  const on = n.provenance?.runAt ? ` on ${html(n.provenance.runAt.slice(0, 10))}` : ''
  bits.push(
    `<p><small>Extracted from the full text ${by}${on} via Corpus Studio. ` +
      'Check values against the source before relying on them.</small></p>'
  )
  return bits.join('')
}

/**
 * The project-specific note: this project's own judgement of the paper.
 *
 * Prose, not a list of scores. "Relevance: 5/10 · Expansion priority: 6/10" is
 * an unexplained number in an unexplained unit, and "expansion priority" is
 * this app's jargon arriving in a library with nothing to define it. What
 * survives is what a reader can use: where this paper stands in the project,
 * and one score named as this app's opinion rather than as a property of the
 * work.
 */
function projectNote(n: NoteInput): string {
  // THE RANK, not the raw score. Relevances are ordinal sigmoids with a median
  // near 0.0004 on a real corpus, so `round(raw * 10)` wrote "Rated 0 out of
  // 10" into the user's own Zotero library for nearly every paper — permanent,
  // outside the app, and wrong about papers it had scored perfectly well.
  const rank = n.relevanceRank ?? n.relevance
  const rel = rank === null ? null : Math.round(rank * 10)
  const bits: string[] = []
  const status = label(INCLUSION_STATUS, n.inclusionStatus)

  bits.push(
    `<p><strong>${html(n.projectName)}</strong>` +
      (status ? ` — ${html(status)}.` : '') +
      '</p>'
  )
  if (rel !== null) {
    // The score, not the ranker's arithmetic. `ranking_explanation` reads
    // "citation degree 16 +0.4 + co-citation 5 +0.25" — a trace of
    // how a number was computed, which belongs in the app where the weights can
    // be seen and changed, not in a note where it is unreadable and unarguable.
    bits.push(
      `<p>Ranked ${rel} out of 10 for relevance to this project, in Corpus Studio's own ranking — ` +
        `its position among the papers scored beside it, not a measurement of the paper.</p>`
    )
  }
  // These are THIS project's editorial judgements, not facts about the paper —
  // worth saying, because a relevance score with no owner reads like a property
  // of the work itself.
  bits.push(`<p><small>One project's own assessment, recorded in Corpus Studio.</small></p>`)
  return bits.join('')
}

/**
 * The identity an item is published under.
 *
 * A DOI when there is one — that is what lets Zotero MERGE an import into an
 * existing library instead of duplicating papers the user already has. The
 * collection references the same string, so the two agree by construction.
 */
function itemAbout(n: NoteInput): string {
  return n.work.doi ? `https://doi.org/${n.work.doi}` : `#item_${n.work.id}`
}

/**
 * The Zotero tags for one item.
 *
 * Prefixed (`status:`, `claim:`) because Zotero's tag selector is one
 * flat alphabetical list across the whole library: without a prefix our tags
 * would scatter among the user's own and be impossible to pick out.
 *
 * Claim tags are derived from the facts actually present, and DE-DUPLICATED —
 * a paper with forty directly-reported values gets one `claim: stated in paper`
 * tag, not forty.
 */
function itemTags(n: NoteInput): string[] {
  const tags = new Set<string>()
  const status = term(INCLUSION_STATUS, n.inclusionStatus)
  if (status) tags.add(status.tag)
  // Only the fact kinds worth FILTERING BY. `claim: stated in paper` was on
  // nearly every item, which is a tag that selects everything and therefore
  // says nothing; this one marks papers whose numbers need a second look, which
  // is a list a scientist would actually pull up.
  for (const f of n.facts) {
    if (f.kind === 'uncertain-conflicting') {
      const kind = term(FACT_KIND, f.kind)
      if (kind) tags.add(kind.tag)
    }
  }
  return [...tags].sort()
}

/**
 * A path relative to the .rdf, as the URI Zotero resolves against it.
 *
 * Each SEGMENT is encoded, not the whole string: `encodeURI` would leave `#`
 * and `?` intact, and a paper filed under "Kemp elimination #3.pdf" would then
 * import as a link truncated at the hash.
 */
function relativeUri(relPath: string): string {
  return relPath.split('/').map(encodeURIComponent).join('/')
}

/**
 * The extracted values as a Zotero note.
 *
 * An HTML `<table>` rather than preformatted CSV text: a Zotero note IS rich
 * text, so a real table renders as one in the note pane AND pastes into a
 * spreadsheet with its columns intact — which is what someone wanting "the data"
 * is actually going to do with it.
 *
 * Columns are dropped rather than emitted empty when NO row fills them, so a
 * project with no evidence quotes does not carry an empty Evidence column
 * through every one of its rows.
 */
function dataTableHtml(table: ExtractionTable): string {
  // A HUMAN subset. The full 22-column table carries internal state — schema
  // key, run origin, prompt version, verifier result — which is essential in the
  // spreadsheet export and meaningless in a reading note: nobody scanning a
  // library needs to know a run's prompt was `v3`. Those columns stay in the
  // CSV/XLSX exports, which is where someone auditing provenance will look.
  const wanted = new Set([
    'work_title',
    'work_year',
    'field_label',
    'value',
    'value_raw',
    'unit',
    'conditions',
    'fact_kind',
    'evidence_quote'
  ])
  // The human-readable COLUMNS, but every row and every value within them. A
  // column is chosen for what it means to a reader, not for whether this
  // particular corpus happens to fill it: dropping an all-empty or all-identical
  // column would make the table's shape depend on the data, so two exports of
  // the same project would disagree about what was even extracted.
  const used = table.columns.filter((c) => wanted.has(c.key))
  // EVERY row the extraction produced, gaps included. A blank cell is a fact
  // about the extraction — the model found a field it could not fill — and
  // hiding those rows would make the table look more complete than the data is.
  const rows = table.rows

  const bits: string[] = []
  bits.push(`<h1>Extracted data</h1>`)
  bits.push(
    `<p>${rows.length} measurement${rows.length === 1 ? '' : 's'} read out of these papers ` +
      `for ${html(table.projectName)}. Extracted by a language model via Corpus Studio — ` +
      'check any value against the paper before relying on it.</p>'
  )
  bits.push('<table>')
  bits.push(`<tr>${used.map((c) => `<th>${html(c.header)}</th>`).join('')}</tr>`)
  for (const row of rows) {
    const cells = used.map((c) => {
      const v = row[c.key]
      if (v === null || v === undefined) return '<td></td>'
      // The enum is spelled out here too, so the table does not leak
      // `directly-reported` into a note that explains nothing else.
      const text = c.key === 'fact_kind' ? (label(FACT_KIND, String(v)) ?? String(v)) : String(v)
      return `<td>${html(text)}</td>`
    })
    bits.push(`<tr>${cells.join('')}</tr>`)
  }
  bits.push('</table>')
  return bits.join('')
}

export interface RdfOptions {
  /** Include the general per-item summary note. */
  summaryNotes: boolean
  /** Include the project-specific relevance/priority note. */
  projectNotes: boolean
  /**
   * Where each work's PDF sits RELATIVE to this .rdf, for the works that carry
   * one — the layout Zotero's own exporter emits, and the reason it resolves
   * after the bundle has been moved or sent to somebody else.
   *
   * Absent means no attachments at all. NOT "link them where they live": an
   * absolute `file://` into this machine's library is a link that works for
   * exactly one person, and an export whose whole purpose is to travel should
   * not carry one silently.
   */
  attachments?: ReadonlyMap<number, string>
}

/**
 * Render the whole project as one importable RDF document.
 *
 * Every item carries a `dc:identifier` DOI when known, which is what lets Zotero
 * MERGE the import into an existing library rather than duplicating items the
 * user already has — the single most important property of this file in
 * practice.
 */
export function renderZoteroRdf(
  notes: NoteInput[],
  options: RdfOptions,
  collectionName?: string,
  /**
   * The extracted values, carried INSIDE this file as a note in the collection.
   *
   * Not a sibling .csv referenced by path: that made the export two files, and a
   * reference to an absolute path breaks the moment either is moved or the file
   * is sent to somebody else — which is most of the point of exporting. Zotero
   * RDF has no way to embed a binary attachment, but a standalone note is a
   * first-class collection member, so the table travels with the bibliography in
   * one self-contained file.
   */
  dataTable?: ExtractionTable | null
): string {
  // A CITABLE record only. An item with no author, no year and no identifier
  // cannot be cited and cannot be looked up — importing it puts a row in
  // somebody's library that they can neither use nor place, and one such row
  // makes them doubt the twenty beside it. This is a property of the RECORD, not
  // a guess about which papers are "real": anything with enough metadata to cite
  // is exported, whatever produced it.
  // EVERY paper in the project. An earlier version withheld records with no
  // author and no DOI, on the grounds that they could not be cited — which made
  // the export silently disagree with the app about what the project contains,
  // and hid bad rows instead of surfacing them. If a record is not worth
  // exporting it is not worth keeping, and that is a decision for the user in
  // the app, not for the exporter behind their back.
  const exportable = notes
  const exportedIds = new Set(exportable.map((n) => n.work.id))

  const out: string[] = []
  out.push('<?xml version="1.0" encoding="UTF-8"?>')
  out.push(
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"' +
      ' xmlns:z="http://www.zotero.org/namespaces/export#"' +
      ' xmlns:dc="http://purl.org/dc/elements/1.1/"' +
      ' xmlns:dcterms="http://purl.org/dc/terms/"' +
      ' xmlns:foaf="http://xmlns.com/foaf/0.1/"' +
      ' xmlns:bib="http://purl.org/net/biblio#"' +
      ' xmlns:link="http://purl.org/rss/1.0/modules/link/"' +
      ' xmlns:prism="http://prismstandard.org/namespaces/1.2/basic/">'
  )

  // A COLLECTION, so an import lands as a named folder in the user's library
  // rather than as N loose items they then have to find and group by hand. Every
  // item is listed as a part of it; Zotero creates the collection on import.
  if (collectionName) {
    out.push('  <z:Collection rdf:about="#collection_project">')
    out.push(`    <dc:title>${xml(collectionName)}</dc:title>`)
    for (const n of exportable) {
      out.push(`    <dcterms:hasPart rdf:resource="${xml(itemAbout(n))}"/>`)
    }
    if (dataTable) out.push('    <dcterms:hasPart rdf:resource="#data_table"/>')
    out.push('  </z:Collection>')
  }

  // The data table as a standalone NOTE in the collection — a sibling of the
  // papers rather than a child of any one of them, because it describes all of
  // them. The values are embedded here, so the export is one self-contained
  // file that can be moved or sent without losing its data.
  if (dataTable) {
    // Restricted to the papers this file actually contains, so the table never
    // reports measurements from an item the recipient cannot open.
    const titles = new Set(exportable.map((n) => n.work.title))
    const scoped = {
      ...dataTable,
      rows: dataTable.rows.filter((r) => titles.has(String(r.work_title)))
    }
    out.push('  <bib:Memo rdf:about="#data_table">')
    out.push(`    <rdf:value>${xml(dataTableHtml(scoped))}</rdf:value>`)
    out.push('  </bib:Memo>')
  }

  exportable.forEach((n, i) => {
    const about = itemAbout(n)
    const hasSummary = options.summaryNotes
    const noteIds: string[] = []
    if (hasSummary) noteIds.push(`#note_${i}_summary`)
    if (options.projectNotes) noteIds.push(`#note_${i}_project`)

    out.push(`  <bib:Article rdf:about="${xml(about)}">`)
    out.push('    <z:itemType>journalArticle</z:itemType>')
    if (n.work.venue) {
      out.push('    <dcterms:isPartOf>')
      out.push('      <bib:Journal>')
      out.push(`        <dc:title>${xml(n.work.venue)}</dc:title>`)
      out.push('      </bib:Journal>')
      out.push('    </dcterms:isPartOf>')
    }
    if (n.work.authors.length > 0) {
      out.push('    <bib:authors>')
      out.push('      <rdf:Seq>')
      for (const a of n.work.authors) {
        const { given, surname } = splitName(a)
        out.push('        <rdf:li>')
        out.push('          <foaf:Person>')
        out.push(`            <foaf:surname>${xml(surname)}</foaf:surname>`)
        if (given) out.push(`            <foaf:givenName>${xml(given)}</foaf:givenName>`)
        out.push('          </foaf:Person>')
        out.push('        </rdf:li>')
      }
      out.push('      </rdf:Seq>')
      out.push('    </bib:authors>')
    }
    out.push(`    <dc:title>${xml(n.work.title)}</dc:title>`)

    // TAGS. `dc:subject` becomes a real Zotero tag, so the recipient can filter
    // the collection with Zotero's own tag selector — "show me the papers whose
    // checks failed", "show me the ones I marked undecided" — without opening
    // this app. Zotero also allows colours on up to nine tags, and the ones
    // worth colouring (uncertain claims, failed checks) are exactly these.
    for (const tag of itemTags(n)) {
      out.push(`    <dc:subject>${xml(tag)}</dc:subject>`)
    }

    // `extra` is Zotero's catch-all, shown in the item pane. It carries the
    // project name — which means something to a reader — and NOT the internal
    // row id, which was a database key on display in somebody's library.
    out.push(`    <dc:description>Corpus Studio · ${xml(n.projectName)}</dc:description>`)
    if (n.work.abstract) out.push(`    <dcterms:abstract>${xml(n.work.abstract)}</dcterms:abstract>`)
    if (n.work.publication_year !== null) {
      out.push(`    <dc:date>${n.work.publication_year}</dc:date>`)
    }
    if (n.work.doi) {
      out.push(`    <dc:identifier>DOI ${xml(n.work.doi)}</dc:identifier>`)
      // The resolver URL as well as the bare DOI: Zotero shows it as a clickable
      // URL, and — more usefully — it is what the user clicks to pull the
      // complete record (volume, issue, pages) from the publisher, since this
      // app stores none of those and a citation without them is incomplete.
      out.push(
        `    <dc:identifier rdf:resource="https://doi.org/${xml(encodeURI(n.work.doi))}"/>`
      )
    }
    for (const id of noteIds) {
      out.push(`    <dcterms:isReferencedBy rdf:resource="${id}"/>`)
    }
    // The PDF, so an import brings the papers themselves rather than metadata
    // alone. Linked by a path RELATIVE to this .rdf, which is what Zotero's own
    // exporter emits when it writes files alongside — its importer resolves
    // those against the .rdf's own location and copies them into the user's
    // storage, so the bundle survives being moved or sent.
    const attachment = options.attachments?.get(n.work.id)
    if (attachment) {
      out.push(`    <link:link rdf:resource="#attachment_${i}"/>`)
    }
    // RELATED ITEMS. `dc:relation` populates Zotero's "Related" pane, so the
    // citation structure we already computed survives the trip: a reader can
    // walk from a paper to the ones it cites inside Zotero itself. Only
    // citations to papers in this same export are emitted, so no relation
    // points at an item the library does not have.
    for (const ref of n.citeRefs ?? []) {
      // Only to papers this file actually carries. A citation to one that was
      // filtered out as uncitable would be a Related entry pointing at nothing.
      if (!exportedIds.has(ref.id)) continue
      const target = ref.doi ? `https://doi.org/${ref.doi}` : `#item_${ref.id}`
      out.push(`    <dc:relation rdf:resource="${xml(target)}"/>`)
    }
    out.push('  </bib:Article>')

    if (attachment) {
      out.push(`  <z:Attachment rdf:about="#attachment_${i}">`)
      out.push('    <z:itemType>attachment</z:itemType>')
      out.push(`    <rdf:resource rdf:resource="${xml(relativeUri(attachment))}"/>`)
      out.push('    <dc:title>Full Text PDF</dc:title>')
      out.push('    <link:type>application/pdf</link:type>')
      out.push('  </z:Attachment>')
    }

    if (hasSummary) {
      out.push(`  <bib:Memo rdf:about="#note_${i}_summary">`)
      out.push(`    <rdf:value>${xml(summaryNote(n))}</rdf:value>`)
      out.push('  </bib:Memo>')
    }
    if (options.projectNotes) {
      out.push(`  <bib:Memo rdf:about="#note_${i}_project">`)
      out.push(`    <rdf:value>${xml(projectNote(n))}</rdf:value>`)
      out.push('  </bib:Memo>')
    }
  })

  out.push('</rdf:RDF>')
  out.push('')
  return out.join('\n')
}
