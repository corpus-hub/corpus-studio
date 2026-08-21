// Parse a paper's bibliography and match it against the corpus.
//
// A THIN ADAPTER over `src/main/citations/*`, which is 4000+ lines including
// 1000 of tests, audited over several rounds against real papers, at
// `PARSER_VERSION 2.5.0`. This stage contributes no parsing logic and keeps no
// second staleness record: it maps the parser's existing outcomes onto stage
// outcomes and lets `findStaleParses` stay the single source of truth about
// what is stale.
//
// `PARSER_VERSION` is in the fingerprint, so bumping the parser supersedes
// every stored parse through the ordinary cascade — which is exactly what
// `findStaleParses` already wanted, now without asking.
//
// INLINE, deliberately. Its write is `storeParse`, which deletes and inserts
// across four tables and needs the `unresolved_reference` ids it mints in order
// to publish them. That is multi-step transactional work whose ids exist only
// where the SQL runs, and the audited function doing it is not being rewritten
// as a data plan to fit in a host. The expensive part — pdfjs — was already
// paid off the main thread by `extract-text`, whose output this reads.

import { readFile } from 'node:fs/promises'
import { PARSER_VERSION, loadCorpusWorks, storeParse, type StoredEntry } from '../../citations/store'
import type { DB } from '../../db/connection'
import { readPdfOutline } from '../../citations/pdfOutline'
import {
  OUTLINE_VERSION,
  calloutsFromOutline,
  entriesFromOutline,
  keySequenceGaps
} from '../../citations/outlineEntries'
import {
  matchReferences,
  parseEntry,
  parseReferences,
  printedReferenceCount,
  type ParseDiagnostics,
  type ParsedReference,
  type ReferenceMatch
} from '../../citations/parseReferences'
import type { DocumentFile, ParsedReferences, ReferenceEntry, TextPages } from '../capabilities'
import { fetchAllSources } from '../../references/external/sources'
import type { ExternalReferenceResult } from '../../references/external/types'
import { reconcile } from '../../references/external/reconcile'
import { TITLE_RULE_VERSION } from '../../references/external/adoptTitle'
import { doisFromFileName, queryFromFileName } from '../../identity/fromFileName'
import { verifyIdentity } from '../../identity/verify'
import { AcademicIdentifierResolver, searchByBibliographic } from '../../search/resolve'
import { applyResolvedIdentity, type ResolvedPaperInput } from '../../db/repositories'
import type { StageContext, StageDefinition } from '../types'

interface ReferencesWrite {
  documentId: number
  references: ParsedReference[]
  matches: ReferenceMatch[]
  diagnostics: ParseDiagnostics
  corpusSize: number
  /** In-text citation sites the FILE recorded, empty when it recorded none. */
  nativeCallouts: NativeCallout[]
  /**
   * What the indexes said about this paper's reference list, fetched during
   * `execute` because `applyWrites` is synchronous and this is a network call.
   * Empty when the paper has no DOI or nothing could be reached — both of which
   * mean "no titles to adopt", never "these references have no titles".
   */
  indexReplies: ExternalReferenceResult[]
  /**
   * The identity established for the PAPER ITSELF from its filename, when it
   * had none and one could be confirmed. Null in every other case, including a
   * candidate the gate refused.
   *
   * Travels in the payload for the same reason `indexReplies` does: it is the
   * fruit of a network call made in `execute`, and `applyWrites` is where it
   * may touch the database.
   */
  identity: { workId: number; paper: ResolvedPaperInput } | null
}

const identifier = new AcademicIdentifierResolver()

/**
 * Find out what paper a FILE-IMPORTED PDF actually is, from what it is called.
 *
 * Returns the confirmed record, or null — for a name that says nothing to ask
 * with, an index that could not be reached, or a candidate the gate refused.
 * All four are ordinary outcomes and none of them may fail the parse: naming
 * the paper is an enrichment of a bibliography that already stands.
 */
async function identifyFromFileName(
  ctx: StageContext
): Promise<{ title: string; doi: string | null; paper: ResolvedPaperInput } | null> {
  const file = ctx.db.pdfPath()
  if (!file) return null
  const fileName = file.relativePath.split('/').pop() ?? file.relativePath

  let record = null
  let trusted = false
  try {
    // A DOI PRINTED IN THE NAME is the strong case: the file states an
    // identifier and an index confirms a paper under it. Each reading of an
    // ambiguous name is tried in turn — a trailing `-1` is a copy marker in one
    // library and part of the DOI in another, and the index settles it.
    for (const doi of doisFromFileName(fileName)) {
      record = await identifier.resolve({ kind: 'doi', value: doi }, ctx.signal)
      if (record) {
        trusted = true
        break
      }
    }
    if (!record) {
      const query = queryFromFileName(fileName)
      if (!query) return null
      record = await searchByBibliographic(query, {
        mailto: ctx.db.contactEmail(),
        signal: ctx.signal
      })
    }
  } catch {
    // Unreachable says nothing about this paper, and must not fail a parse that
    // succeeded. The next run asks again.
    return null
  }

  const verdict = verifyIdentity(record, fileName, { trusted })
  if (!verdict.accepted) return null
  const r = verdict.record
  return {
    title: r.title,
    doi: r.doi,
    paper: {
      title: r.title,
      abstract: r.abstract ?? '',
      authors: r.authors ?? [],
      year: r.year,
      venue: r.venue,
      doi: r.doi
    }
  }
}

const references: StageDefinition<{ references: number; matched: number }> = {
  id: 'references',
  label: 'Parse references',
  version: '1.0.0',
  rank: 6,
  scope: 'document',
  provides: ['refs.parsed@v1'],
  requires: ['text.pages@v2', 'document.file@v1'],
  usesLlm: false,
  runtime: 'node',
  weight: 'light',

  fingerprint() {
    // THE PARSER, AND NOTHING ELSE. This hashes the inputs to PARSING a
    // bibliography, and they are the PDF's text plus the parser reading it —
    // the text is already covered by the upstream stage's own fingerprint.
    //
    // It used to include `SELECT COUNT(*) FROM work`, on the argument that
    // matching a reference is relative to the set of known papers, so a parse
    // correct yesterday is incomplete today. The observation is true; the
    // conclusion does not follow. Growing the corpus does not change how this
    // paper's bibliography PARSES — only what its entries can later be matched
    // TO. Hashing it here meant EVERY import invalidated EVERY paper's parse:
    // importing eight papers left 44 of 55 reported stale, asking the user to
    // redo work whose output would be byte-identical, on a corpus where they
    // had changed nothing. Measured: 99 distinct fingerprints across 114 runs
    // of this one stage, i.e. almost every run had its own.
    //
    // Re-matching is a different question and already has its own answer:
    // `findStaleParses` reports exactly this as ADVICE, without claiming the
    // parse itself is invalid. A stage may only fingerprint what it consumes.
    //
    // `IDENTITY_RULE_VERSION` is deliberately NOT here either, for the same
    // reason: identifying the paper from its filename is an enrichment carried
    // by this stage, not an input to parsing, and hashing it would supersede
    // every stored bibliography in the corpus the day the gate is tightened.
    // Nothing is lost — the identification only ever runs for a paper that has
    // no DOI and no authors, so a paper it declined is retried by the next run
    // that happens for any reason, and one it identified is left alone.
    return `parser=${PARSER_VERSION}|outline=${OUTLINE_VERSION}`
  },

  async execute(ctx) {
    const pages = ctx.input<TextPages>('text.pages@v2')
    if (!pages) {
      // A paper we hold no text for is not a paper whose bibliography we failed
      // to parse. This is the parser's own `skipped_reason`, mapped.
      return { status: 'skipped', reason: 'no text.pages@v2 — no bibliography to parse' }
    }

    // THE PDF'S OWN RECORD FIRST, prose only when there is none.
    //
    // A LaTeX document states where each bibliography entry begins; reading
    // that is not a better heuristic than reading the prose, it is the end of
    // heuristics for those files. It is also the only way to be right about the
    // cases prose cannot see: one paper's located section was a page of
    // appendix figure captions and it reported five references where the file
    // records twenty-nine, and every check built on the text agreed with the
    // five because they really were entry-shaped prose.
    //
    // Publisher pipelines record nothing, so the prose parser stays and is
    // reached by `outline === null` — never by an empty outline, which would
    // make "this file does not say" and "this file says none" the same answer.
    const file = ctx.input<DocumentFile>('document.file@v1')
    let parsed: ParsedReference[] | null = null
    let diagnostics: ParseDiagnostics | null = null
    let source: 'pdf-outline' | 'prose' = 'prose'

    const outlined = file ? await readOutlineReferences(file.absPath, pages) : null
    const prose = parseReferences(pages.text)

    // BOTH SIDES IN PRINTED REFERENCES. Comparing row counts let the very
    // over-splitting this guard exists to detect inflate the prose side and
    // "win" the comparison, pushing an ACS paper off the typesetter's own
    // record onto the parse that mangled it.
    // The bibliography and the in-text citations are chosen SEPARATELY, because
    // a file can record one well and the other not at all. Here the entries may
    // come from prose while `outlined.nativeCallouts` still carries the exact
    // citation sites the file itself placed.
    // The outline is preferred, but not when it fields the entries markedly
    // worse than reading the prose does — see `fieldedRatio`.
    const outlineFieldsWorse =
      outlined !== null &&
      outlined.references.length > 0 &&
      fieldedRatio(prose.references) - fieldedRatio(outlined.references) > FIELDED_MARGIN

    if (
      outlined &&
      outlined.diagnostics &&
      outlined.references.length > 0 &&
      !outlineIsShort(outlined, printedReferenceCount(prose.references)) &&
      !outlineFieldsWorse
    ) {
      parsed = outlined.references
      diagnostics = outlined.diagnostics
      source = 'pdf-outline'
    } else {
      parsed = prose.references
      diagnostics = prose.diagnostics
    }

    if (diagnostics.no_text_layer) {
      return { status: 'empty', reason: 'the document has no usable text layer' }
    }
    if (parsed.length === 0) {
      // A real, checkable claim: there IS text and it holds no bibliography.
      // An editorial, a comment or a supplement legitimately prints none, and
      // for those the right amount of parsing was none — so this settles as a
      // success. `empty` painted the row amber and invited the reader to go
      // looking for a fault in a paper that simply has no reference list.
      return {
        status: 'not-needed',
        reason:
          'this document prints no reference list, so there was no bibliography to parse ' +
          `(section strategy: ${diagnostics.section_strategy})`
      }
    }

    const corpus = ctx.db.corpus()
    const matches = matchReferences(parsed, corpus, { excludeWorkId: ctx.workId })
    const matched = matches.filter((m) => m.work_id != null).length

    // Ask the indexes what the unmatched references are CALLED, while we may
    // still await. The rows do not exist yet — `applyWrites` writes them — so
    // the REPLIES travel in the payload and the adoption happens there.
    //
    // Quiet on failure by design: a title improves a reference that is already
    // parsed and already displayable, so an unreachable index must not fail a
    // parse that succeeded.
    let indexReplies: ExternalReferenceResult[] = []
    // `identifiers()`, NOT raw SQL: `ctx.db` is a narrow read surface with no
    // `prepare` on it. An earlier version reached for one, threw, and was
    // swallowed by the catch below — so this looked like "the indexes had
    // nothing" on every paper while never sending a request.
    let doi = ctx.db.identifiers().find((i) => i.scheme === 'doi')?.value

    // NO DOI, BUT A FILENAME. A paper imported from a file has neither DOI nor
    // authors — `ingestPdfBytes` can only name it after the file, because at
    // that moment a filename is all there is. Everything below this line needs
    // the paper's own DOI, so the identity is established HERE rather than in a
    // stage of its own: it is the same step as naming what the paper cites, and
    // a reader watching the queue should see one job, not two.
    //
    // The filename IS the query — `10.1021_acscatal.9b01339.pdf`, or
    // `Charmantray and Hecquet - 2025 - Extending the toolbox…` — and
    // `identity/verify.ts` decides whether what came back may be attached. It
    // refuses on weak evidence, because a wrong DOI is carried silently into
    // the citation graph, the exports and the Zotero push, while a missing one
    // is visibly missing and asks to be fixed.
    let identity: ReferencesWrite['identity'] = null
    let identifiedAs: string | null = null
    if (!doi && (ctx.db.bibliographicRecord()?.authors.length ?? 0) === 0) {
      const found = await identifyFromFileName(ctx)
      if (found) {
        identity = { workId: ctx.workId, paper: found.paper }
        identifiedAs = found.title
        doi = found.doi ?? undefined
      }
    }

    if (doi) {
      try {
        indexReplies = await fetchAllSources(doi, { mailto: ctx.db.contactEmail() })
      } catch {
        // Unreachable is not a parse failure; the bibliography still stands.
        indexReplies = []
      }
    }

    ctx.write({
      documentId: ctx.documentId,
      references: parsed,
      matches,
      diagnostics,
      corpusSize: corpus.length,
      // Carried whatever produced the bibliography: these are the file's own
      // record of where each citation is printed, and the prose scanner has no
      // way to reproduce them.
      nativeCallouts: outlined?.nativeCallouts ?? [],
      indexReplies,
      identity
    } satisfies ReferencesWrite)

    // What the PAGE shows, for a line the user reads. `parsed.length` counts a
    // lettered composite once for itself and again for each part, so it told
    // the reader of an ACS paper that it had 83 references when its
    // bibliography is numbered to 44.
    const printed = printedReferenceCount(parsed)


    return {
      status: 'succeeded',
      result: { references: printed, matched },
      // The SOURCE is named, because the two are not interchangeable evidence:
      // an outline entry's boundaries were recorded by the typesetter, a prose
      // entry's were inferred here.
      note:
        `${printed} reference(s), ${matched} matched to the corpus` +
        (source === 'pdf-outline' ? ' (boundaries from the PDF\'s own structure)' : '') +
        // Named only when it HAPPENED. A paper that already knew what it was
        // says nothing here, per the rule that a badge announces the exception.
        (identifiedAs ? `; this paper identified from its filename as "${identifiedAs}"` : '')
    }
  },

  applyWrites(db, payload, ctx) {
    const w = payload as ReferencesWrite

    // THE PAPER'S OWN IDENTITY, before its references: a file import arrives
    // named after its file, and everything stored below reads better against a
    // paper that knows what it is. `applyResolvedIdentity` returns false when
    // the DOI already belongs to a DIFFERENT work — this file is then a second
    // copy of a paper the library holds, and merging them is not this stage's
    // decision to make, so the paper keeps its filename and the parse proceeds.
    if (w.identity) {
      applyResolvedIdentity(db, w.identity.workId, w.identity.paper, new Date().toISOString())
    }

    const stored = storeParse(db, {
      workId: ctx.workId,
      documentId: w.documentId,
      // Left null: the stage's OWN fingerprint already chains off `download`'s
      // file hash, so a changed PDF supersedes this run without a second copy
      // of the same fact stored under a different name.
      docSha: null,
      references: w.references,
      matches: w.matches,
      diagnostics: w.diagnostics,
      corpusSize: w.corpusSize
    })

    // NAMING THE UNMATCHED REFERENCES, in this stage rather than beside it.
    //
    // Many citation styles print no title at all — ACS, RSC, Angewandte and
    // older JACS give authors, journal, year, volume and pages and nothing
    // else — so a card naming those references could do no better than list
    // their authors. The indexes hold a real title for most of them.
    //
    // It runs HERE because it is part of reading a bibliography, not a separate
    // step a user should have to think about: the rows were just written, their
    // ids exist only now, and a second stage would report its own line in the
    // queue for work that belongs to this one.
    //
    // Failure is deliberately quiet. A title is an improvement on a reference
    // that is already stored and already displayable; the network being down
    // must not fail a parse that succeeded, so anything thrown here is caught
    // and the stage returns its bibliography regardless.
    nameFromIndexes(db, w.indexReplies ?? [], stored)

    // Published from HERE rather than from `execute`, because the ordinals must
    // travel with the row ids and those ids did not exist until a moment ago.
    // Same transaction, so an artifact can never name a row that rolled back.
    const value: ParsedReferences = {
      workId: ctx.workId,
      documentId: w.documentId,
      parserVersion: PARSER_VERSION,
      // The paper's OWN count — what it printed — because that is what every
      // consumer of this field is asking. `entries` below is the row list and
      // still carries the parts; a consumer that wants those counts them there.
      referenceCount: printedReferenceCount(w.references),
      matchedCount: stored.filter((e) => e.citedWorkId != null).length,
      sectionCharStart: w.diagnostics.section_char_start,
      sectionCharEnd: w.diagnostics.section_char_end,
      entryStyle: w.diagnostics.entry_style,
      nativeCallouts: w.nativeCallouts,
      entries: stored.map(
        (e): ReferenceEntry => ({
          ordinal: e.ordinal,
          rawBibText: e.rawBibText,
          citedWorkId: e.citedWorkId,
          unresolvedReferenceId: e.unresolvedReferenceId,
          edgeId: e.edgeId,
          authors: e.authors,
          year: e.year,
          title: e.title,
          charStart: e.charStart,
          charEnd: e.charEnd,
          partLabel: e.partLabel
        })
      )
    }
    return [['refs.parsed@v1', value]]
  }
}

/**
 * Ask the indexes what this paper's unmatched references are CALLED, and store
 * a title only where the printed authors vouch for it.
 *
 * `adoptTitle.ts` makes the decision; `reconcile.ts` decides which index record
 * a printed line refers to. This only orchestrates and writes.
 *
 * WRITES ALL FIVE COLUMNS OR NONE. A title without its provenance cannot be
 * rolled back by rule version, which is the only way to undo one rule's output
 * without touching a later one's.
 */
function nameFromIndexes(
  db: DB,
  results: ExternalReferenceResult[],
  stored: StoredEntry[]
): number {
  if (results.length === 0) return 0

  const targets = stored.filter((e) => e.unresolvedReferenceId != null && e.partLabel == null)
  if (targets.length === 0) return 0

  // Every source unreachable is the network, not three indexes that have never
  // heard of this paper. Write nothing so a later run asks again.
  if (results.every((r) => !r.ok)) return 0
  if (results.every((r) => r.references.length === 0)) return 0

  const printed = targets.map((e) =>
    parseEntry(e.rawBibText, e.ordinal, undefined, undefined, e.partLabel ?? undefined)
  )
  const byOrdinal = new Map<number, number>()
  for (const e of targets) {
    if (e.unresolvedReferenceId != null) byOrdinal.set(e.ordinal, e.unresolvedReferenceId)
  }

  const now = new Date().toISOString()
  const update = db.prepare(
    `UPDATE unresolved_reference
        SET index_title = ?, index_source = ?, index_title_from = ?,
            index_title_fetched_at = ?, index_title_rule_version = ?
      WHERE id = ?`
  )
  const written = new Set<number>()
  db.transaction(() => {
    for (const rr of reconcile(printed, results).references) {
      if (!rr.printed || rr.title_from === null || rr.title === null) continue
      const id = byOrdinal.get(rr.printed.ordinal)
      if (id === undefined || written.has(id)) continue
      written.add(id)
      update.run(rr.title, rr.title_source ?? 'unknown', rr.title_from, now, TITLE_RULE_VERSION, id)
    }
  })()
  return written.size
}

export default references

/** Re-exported so a consumer imports the corpus loader from one place. */
export { loadCorpusWorks }

/**
 * Read a document's recorded bibliography, or null when it records none.
 *
 * Isolated here rather than inline so the stage body stays a decision and this
 * stays the I/O. Every failure mode collapses to null: a file that will not
 * open, a name tree that will not resolve, a structure with no `cite.*` entries
 * at all. That is deliberate — none of them is a reason to fail the stage when
 * a working prose parser is sitting behind it, and a caller that cannot tell
 * "no structure" from "structure I could not read" would fall back either way.
 */
/**
 * Is the file's record demonstrably missing entries the prose found?
 *
 * The outline is preferred because a recorded boundary beats a guessed one —
 * but only while the record is complete, and it is not always. One paper here
 * numbers its destinations `b1`..`b108` and omits eight of them, so the outline
 * yields 99 entries where the prose parser yields 104 and Crossref
 * independently reports 104. Preferring the outline there loses five real
 * references to a source that is provably incomplete.
 *
 * BOTH conditions are required, and neither alone would do. Prose finding more
 * is ordinary — it over-splits, which is the bug the outline exists to fix — so
 * on its own it would hand every paper back to the worse source. Gaps alone are
 * not enough either: a producer may legitimately skip a number, and if prose
 * cannot do better there is nothing to switch to. Together they say the
 * specific thing that matters: the record has holes AND something else read
 * more out of the same page.
 */
function outlineIsShort(
  outlined: { references: ParsedReference[]; gaps: number },
  proseCount: number
): boolean {
  return outlined.gaps > 0 && proseCount > printedReferenceCount(outlined.references)
}

/**
 * How much of each entry the parse actually FIELDED: venue, volume and pages.
 *
 * Counting entries alone cannot separate a good split from a bad one. One paper
 * here yields 85 entries either way, so the count guard kept the typesetter's
 * boundaries — which put the coordinate inside the title on half of them, giving
 * 40 venues where the prose parse gives 75. Every consumer downstream wants that
 * coordinate: it is the retrieval ladder's second rung, and it is what an index
 * record is paired on.
 *
 * A ratio rather than a count, so the two are comparable when the splits differ.
 */
function fieldedRatio(references: ParsedReference[]): number {
  if (references.length === 0) return 0
  let filled = 0
  for (const r of references) {
    if (r.venue) filled++
    if (r.volume) filled++
    if (r.pages) filled++
  }
  return filled / (references.length * 3)
}

/**
 * Margin by which the prose parse must beat the outline before it displaces it.
 *
 * Not zero: the typesetter's own boundaries are better evidence than anything
 * inferred here, so a tie or a near-tie keeps them. 0.15 is wide enough that
 * only a real difference in kind — a whole coordinate present on one side and
 * absent on the other — flips the choice.
 */
const FIELDED_MARGIN = 0.15

/** One in-text citation the FILE placed: where it is printed, and what it names. */
export interface NativeCallout {
  key: string
  charStart: number
  charEnd: number
  page: number
}

async function readOutlineReferences(
  absPath: string,
  pages: TextPages
): Promise<{
  references: ParsedReference[]
  diagnostics?: ParseDiagnostics
  gaps: number
  nativeCallouts: NativeCallout[]
} | null> {
  // DYNAMIC import, never a static one. pdf.js ships ESM and the main bundle is
  // CJS, so a top-level `import` compiles to a `require()` that throws
  // ERR_REQUIRE_ESM at runtime — the app launches, this stage is unreachable,
  // and nothing says so until a paper fails to parse. `ocr.ts` and
  // `tableCrops.ts` already load it this way for the same reason.
  let doc: { destroy: () => Promise<void> } | null = null
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const bytes = new Uint8Array(await readFile(absPath))
    doc = await pdfjs.getDocument({ data: bytes, useSystemFonts: false }).promise
    const outline = await readPdfOutline(doc)
    if (!outline) return null

    // THE IN-TEXT CALLOUTS TRAVEL EVEN WHEN THE ENTRIES DO NOT.
    //
    // The two halves of a file's record are independent and the publishers here
    // carry only the second: their entry destinations name the page rather than
    // the line, so `entriesFromOutline` places nothing, while their link
    // rectangles pin all 619 in-text citations exactly. Returning null on empty
    // entries — which is right for the bibliography — used to take those with
    // it, discarding the one part of the record that works.
    const nativeCallouts = calloutsFromOutline(outline, pages)

    const { references } = entriesFromOutline(outline, pages)
    if (references.length === 0) {
      return nativeCallouts.length > 0 ? { references: [], gaps: 0, nativeCallouts } : null
    }

    return {
      references,
      nativeCallouts,
      gaps: keySequenceGaps(outline.entries),
      diagnostics: {
        // Not a guess this time: the section is exactly the span the recorded
        // entries occupy, so it is reported from them rather than searched for.
        section_strategy: 'heading',
        entry_style: 'author-year',
        citation_style: 'generic',
        style_confidence: 1,
        section_char_start: references[0].char_start,
        section_char_end: references[references.length - 1].char_end,
        no_text_layer: false
      }
    }
  } catch {
    return null
  } finally {
    await doc?.destroy().catch(() => {})
  }
}
