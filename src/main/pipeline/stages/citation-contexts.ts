// Where in the paper each citation actually appears, and why it is there.
//
// The join is: callout char offset -> paragraph -> section + sentence -> a role.
// Most roles come from a deterministic cue table (`citations/roleRules.ts`);
// only the callouts no rule was entitled to an opinion about are batched into
// ONE LLM call per paper. `role_source` records which of the two decided, so a
// regex and a model are never mistaken for each other in the query that needs
// to tell them apart.
//
// It requires `text.pages@v2` as well as the paragraphs, and that is deliberate
// rather than incidental: re-running OCR changes the characters every offset
// here indexes, so the dependency must be visible to the supersede cascade. A
// stage that read the text without declaring it would keep contexts pointing
// into a document that no longer says those words.

import {
  CALLOUT_SCANNER_VERSION,
  calloutGate,
  scanCallouts,
  type Callout
} from '../../citations/callouts'
import { isFootnoteStyle } from '../../citations/parseReferences'
import { classifyRole, type CitationRole } from '../../citations/roleRules'
import { citationRoleItemSchema, citationRoleOutputSchema, getPrompt } from '../../llm/prompts'
import { isLlmUnavailable } from '../../llm/provider'
import { insistOnValid } from '../../llm/repair'
import type { z } from 'zod'
import type { ParsedReferences, Paragraphs, TextPages } from '../capabilities'
import type { StageDefinition } from '../types'

/**
 * The model that classifies a citation's role, from the user's settings.
 *
 * See the twin of this in `verify-citations.ts`: the model was not passed, so
 * the provider's own default answered and this stage ran on a model the user
 * had not chosen.
 */
function roleModel(ctx: { db: { modelSettings: () => { extractionModel: string } } }): string | undefined {
  const configured = ctx.db.modelSettings().extractionModel.trim()
  return configured === '' ? undefined : configured
}


/** How many residue items go in one call. Over this, the residue is CHUNKED. */
const RESIDUE_BATCH = 80

/** The database's role vocabulary. A label outside it is dropped, never coerced. */
const ROLES = new Set<string>([
  'background',
  'method',
  'comparison',
  'support',
  'contrast',
  'data-source',
  'motivation',
  'review',
  'other'
])

interface ContextRow {
  /**
   * The WORK this entry resolved to, not the edge that links it.
   *
   * `applyWrites` re-selects the edge from this on the unique key
   * (citing, cited, 'cites') at write time. Carrying an `edge_id` through the
   * plan instead would be a second source of truth for something authoritative
   * in `citation_edge`: every path that changes an edge without re-parsing —
   * curation, `deleteWork`, `storeParse`'s `source='parsed'` purge, and the
   * sweep that promotes a reference — would leave the copy stale, and a stale
   * edge id attaches this paper's evidence to an unrelated citation.
   */
  citedWorkId: number | null
  /** The other half of the edge's natural key. `cites` unless a resolve said so. */
  edgeType: string
  unresolvedReferenceId: number | null
  ordinal: number
  calloutOffset: number
  calloutEnd: number
  paraId: string | null
  page: number | null
  sentence: string | null
  /** Where the marker sits inside `sentence`. Null when it could not be pinned. */
  markerInSentence: number | null
  section: string | null
  rawBibText: string | null
  role: CitationRole | null
  roleSource: 'rule' | 'llm' | null
  roleCue: string | null
  occurrenceKind: 'inline' | 'bibliography'
}

interface ContextsWrite {
  rows: ContextRow[]
}

const citationContexts: StageDefinition<{
  contexts: number
  inline: number
  ruleClassified: number
  llmCalls: number
  danglingCallouts: number
  malformedMarkers: number
  ambiguousCallouts: number
}> = {
  id: 'citation-contexts',
  label: 'Citation contexts',
  version: '1.1.0',
  rank: 7,
  scope: 'document',
  provides: ['refs.contexts@v1'],
  requires: ['text.pages@v2', 'text.paragraphs@v1', 'refs.parsed@v1'],
  usesLlm: true,
  runtime: 'node',
  weight: 'light',

  fingerprint() {
    // The prompt is an INPUT to this stage's output, so a prompt change must
    // supersede every run of it. Stamping it only on the run would record what
    // happened without ever causing a re-run.
    const p = getPrompt('citation-role')
    // The CALLOUT SCANNER is an input too, and a bigger one than the prompt: it
    // decides which markers exist at all. Teaching it round-bracket citations
    // changed nothing until this moved, because the planner queued the work and
    // the cache answered "identical inputs" — five papers stayed refused
    // reporting 0 markers while the scanner found 19-40 of them.
    return `prompt=${p.name}@${p.version}|callouts=${CALLOUT_SCANNER_VERSION}`
  },

  async execute(ctx) {
    const pages = ctx.input<TextPages>('text.pages@v2')
    const paras = ctx.input<Paragraphs>('text.paragraphs@v1')
    const refs = ctx.input<ParsedReferences>('refs.parsed@v1')
    if (!pages || !paras || !refs) {
      return {
        status: 'skipped',
        reason: 'no text, paragraphs or parsed references — nothing to anchor citations to'
      }
    }

    const rows: ContextRow[] = []

    // ONE bibliography row per entry, unconditionally, BEFORE any callout work.
    //
    // This is the only surviving home for a resolved reference's printed text:
    // `citation_edge` has no raw-text column and the `unresolved_reference` row
    // that does is deleted the moment the reference resolves. Writing it here
    // makes raw-text preservation structural rather than a side effect of
    // whether a callout happened to be found — it survives the confidence gate
    // below, and it survives an author-year paper whose callouts cannot be
    // linked at all.
    const bibParagraph = paras.paragraphs.find((p) => p.section === 'references')
    for (const [index, entry] of refs.entries.entries()) {
      if (entry.citedWorkId == null && entry.unresolvedReferenceId == null) continue
      rows.push({
        citedWorkId: entry.citedWorkId,
        edgeType: entry.edgeType ?? 'cites',
        unresolvedReferenceId: entry.unresolvedReferenceId,
        ordinal: entry.ordinal,
        // The entry's own site. Negative offsets keep these rows out of the way
        // of every real in-text callout, whose offsets are non-negative by
        // construction, and keying on the entry's POSITION rather than its
        // ordinal keeps them distinct even when a mis-split bibliography emits
        // the same ordinal several times — which really happens on this corpus
        // (one paper printed ordinal 22 five times) and which keying on the
        // ordinal turned into a UNIQUE-constraint failure that took the whole
        // stage down, losing the 49 entries that parsed correctly.
        calloutOffset: -(index + 1),
        calloutEnd: -(index + 1),
        paraId: bibParagraph?.paraId ?? null,
        page: bibParagraph?.page ?? null,
        // NULL: a bibliography entry is not a sentence, and putting one here
        // would place a citation-free string where the UI shows evidence.
        sentence: null,
        markerInSentence: null,
        section: 'references',
        rawBibText: entry.rawBibText,
        // An ENTRY has no role; only a callout does.
        role: null,
        roleSource: null,
        roleCue: null,
        occurrenceKind: 'bibliography'
      })
    }

    /**
     * How many references this paper PRINTED — what every count below reports
     * and what the gate divides by.
     *
     * Counted from the rows rather than read from `refs.referenceCount` so an
     * artifact written before sub-references were labelled is handled by the
     * same arithmetic: `partLabel` is absent on those, `!= null` is false, and
     * the count degrades to the row count, which is what that artifact meant.
     * A paper re-parsed under the current parser gets the true figure. Reading
     * the stored field instead would mix the two definitions silently.
     */
    const printedCount = refs.entries.reduce((n, e) => (e.partLabel == null ? n + 1 : n), 0)

    if (refs.entryStyle === 'author-year') {
      // The bibliography rows above are still written — the entries were parsed
      // even though their callouts cannot be linked to them.
      ctx.write({ rows } satisfies ContextsWrite)
      return {
        status: 'refused',
        reason:
          `author-year citation style (${printedCount} entries parsed): in-text callouts ` +
          'are names and years, not numbers, so none can be linked to an entry without guessing'
      }
    }

    const knownOrdinals = new Set(refs.entries.map((e) => e.ordinal))
    // A reference SECTION covering most of the paper is not a section — it is a
    // paper whose references are printed as footnotes on the page that cites
    // them, which older journals do. Fencing that span off excludes the whole
    // document from scanning: on one paper here it hid 60 of 71 paragraphs,
    // including `Experimental Section` and the Materials paragraph, and the
    // paper then reported almost no citations and was refused.
    //
    // What replaces it is not "exclude nothing". The entries are printed
    // SOMEWHERE, and each one carries its own span — so the footnote lines are
    // fenced off exactly where they stand, and the body text between them is
    // scanned. Excluding nothing was the other half of the same mistake: 33 of
    // this paper's 44 stored citing sentences were its own reference list.
    const docChars = paras.paragraphs.reduce((n, p) => n + p.text.length, 0)
    const footnoteStyle = isFootnoteStyle(refs.sectionCharStart, refs.sectionCharEnd, docChars)
    // Entries whose span the parser could locate. An entry written before spans
    // existed, or a sub-entry of a lettered composite, reports -1/-1 and simply
    // contributes no region — the same meaning `-1` carries everywhere else here.
    const printedEntries = refs.entries
      .map((e): [number, number] => [e.charStart ?? -1, e.charEnd ?? -1])
      .filter(([a, b]) => a >= 0 && b > a)
    if (footnoteStyle) {
      // Against the PRINTED count, not the row count: a lettered sub-reference
      // is a substring of a body that was already folded, so it never has a
      // span of its own and can never be "located". Measuring against rows
      // would report a parser that found every entry as having missed half.
      ctx.log(
        `references are printed as footnotes through the body rather than as a section; ` +
          `${printedEntries.length} of ${printedCount} entries were located and are ` +
          'excluded where they stand'
      )
    }
    // A footnote-style paper whose entries could not be located has nothing to
    // fence off and no honest way to tell its references from its prose. Scanning
    // it anyway is what produced the fabricated contexts; refusing loses the
    // paper's callouts, which is a visible gap rather than a confident error.
    if (footnoteStyle && printedEntries.length === 0) {
      ctx.write({ rows } satisfies ContextsWrite)
      return {
        status: 'refused',
        reason:
          `this paper prints its ${printedCount} references as footnotes through the ` +
          'body, and none of them could be located in the text — so a scan cannot tell a ' +
          'callout from a printed reference number'
      }
    }
    const scan = scanCallouts({
      paragraphs: paras.paragraphs,
      knownOrdinals,
      bibliography: {
        range: footnoteStyle ? [-1, -1] : [refs.sectionCharStart, refs.sectionCharEnd],
        entries: printedEntries
      },
      // Geometry, when the producer had any. Without it only bracket markers
      // are findable, which on this corpus means 2 papers of 20.
      items: pages.pages.flatMap((p) => p.items ?? []),
      // THE FILE'S OWN CITATION SITES, where it recorded any.
      //
      // A link annotation's rectangle is where the typesetter printed the
      // marker, so these are measurements and the scan is an inference. Where
      // both exist the file wins: on the five papers here that carry them, the
      // file records 619 sites and the scan finds roughly a third as many.
      //
      // Only the POSITION is taken. Which entry a site names is read from the
      // digits inside the rectangle, exactly as the scan reads them, because
      // the destination's key encodes the ordinal for some publishers and a
      // stride of five for others — agreeing with the printed marker on 0 of
      // 139 Elsevier links measured here.
      nativeSites: (refs.nativeCallouts ?? []).map((c) => ({
        charStart: c.charStart,
        charEnd: c.charEnd
      }))
    })

    // THE DENOMINATOR IS THE PAPER'S OWN REFERENCE COUNT, NOT THE ROW COUNT.
    //
    // The numerator is distinct cited ORDINALS, which can never exceed the
    // number of references the bibliography prints. `entries` holds one row per
    // lettered sub-reference as well, so dividing by its length compares two
    // different populations: work 21 prints 44 references, parses to 83 rows,
    // and a scan that correctly located 32 of the 44 scored 38% instead of 73%
    // and was refused. Worse, the ratio then has a CEILING below the threshold
    // — 44/83 is 53% — so a bibliography averaging more than two papers per
    // number could never pass however well the scan ran, and the gate stopped
    // measuring the scan and started measuring the publisher's house style.
    const gate = calloutGate(scan, printedCount)
    if (!gate.ok) {
      // REFUSED, not empty. The bibliography was parsed and its raw text is
      // being written; what the stage declines to do is say which entry each
      // in-text marker names, because the numbering scheme it detected is not
      // trustworthy enough to be wrong about. `empty` is the UI's wording for
      // "ran correctly and there was genuinely nothing here", which is a
      // different, and false, claim about a paper that cites 40 works.
      ctx.write({ rows } satisfies ContextsWrite)
      return { status: 'refused', reason: gate.reason }
    }

    // Ordinals a mis-split bibliography printed more than once. A callout that
    // says `[22]` when five entries call themselves 22 names no one entry, and
    // picking the first would attach this sentence's evidence to whichever
    // fragment the splitter happened to emit first — a confident wrong citation
    // the reader cannot tell from a right one. They are dropped, and counted.
    const ordinalCounts = new Map<number, number>()
    for (const e of refs.entries) ordinalCounts.set(e.ordinal, (ordinalCounts.get(e.ordinal) ?? 0) + 1)
    const ambiguousOrdinals = new Set(
      [...ordinalCounts].filter(([, n]) => n > 1).map(([ordinal]) => ordinal)
    )
    const byOrdinal = new Map(
      refs.entries.filter((e) => !ambiguousOrdinals.has(e.ordinal)).map((e) => [e.ordinal, e])
    )
    let ambiguousCallouts = 0
    const residue: Array<{ id: string; callout: Callout; row: ContextRow }> = []
    let ruleClassified = 0

    for (const callout of scan.callouts) {
      if (ambiguousOrdinals.has(callout.ordinal)) {
        ambiguousCallouts++
        continue
      }
      const entry = byOrdinal.get(callout.ordinal)
      if (!entry) continue
      if (entry.citedWorkId == null && entry.unresolvedReferenceId == null) continue
      const verdict = callout.sentence ? classifyRole(callout.sentence, callout.section) : null
      const row: ContextRow = {
        citedWorkId: entry.citedWorkId,
        edgeType: entry.edgeType ?? 'cites',
        unresolvedReferenceId: entry.unresolvedReferenceId,
        ordinal: callout.ordinal,
        calloutOffset: callout.offset,
        calloutEnd: callout.end,
        paraId: callout.paraId,
        page: callout.page,
        sentence: callout.sentence,
        markerInSentence: callout.markerInSentence,
        section: callout.section,
        rawBibText: entry.rawBibText,
        role: verdict?.role ?? null,
        roleSource: verdict ? 'rule' : null,
        roleCue: verdict?.cue ?? null,
        occurrenceKind: 'inline'
      }
      if (verdict) ruleClassified++
      else residue.push({ id: `c${residue.length}`, callout, row })
      rows.push(row)
    }

    // The residue, in chunks. CHUNKED rather than truncated: a truncated
    // residue leaves roles NULL for a reason the user cannot see, and a silent
    // gap is worse than the cost of a second call.
    let llmCalls = 0
    // How the residue actually fared, counted rather than inferred.
    //
    // `llmCalls` counts requests SENT, so it cannot answer the question a reader
    // looking at an unclassified quote actually has: was it unclassified because
    // a model judged it so, because the answer was unreadable, or because no
    // model could be reached? Each of those is counted separately here and named
    // separately in the note.
    let residueUnreachable = false
    let residueUnusable = 0
    let residueSkipped = 0
    let residueClassified = 0
    const prompt = getPrompt('citation-role')
    for (let i = 0; i < residue.length; i += RESIDUE_BATCH) {
      if (ctx.signal.aborted) return { status: 'failed', error: 'cancelled', retryable: true }
      const batch = residue.slice(i, i + RESIDUE_BATCH)
      const payload = batch.map((r) => ({
        id: r.id,
        section: r.callout.section,
        sentence: r.callout.sentence
      }))
      let text: string
      try {
        text = await ctx.llm.call(
          [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.buildUser(JSON.stringify(payload)) }
          ],
          // Passed NO options at all before, so the provider's constructor
          // default answered — this stage classified citation roles on a model
          // the user had not chosen, and only the `model` column of a stored
          // run ever said so.
          { model: roleModel(ctx) }
        )
      } catch (err) {
        // The rule-classified rows and the bibliography rows are real work and
        // are kept; the residue simply stays unclassified, which `role_source`
        // NULL states honestly. Failing the stage would throw away a correct
        // parse over an optional refinement.
        //
        // The SHORTFALL is recorded and reported, so a success note cannot omit
        // the callouts an outage cost.
        if (isLlmUnavailable(err)) residueUnreachable = true
        residueSkipped += residue.length - i
        ctx.log(`residue classification failed: ${(err as Error).message}`)
        break
      }
      llmCalls++
      // An answer that arrived and could not be read is NOT the same as an
      // answer saying "none of these" — `roles` is a required key precisely so
      // that stays distinguishable. Rather than discard the batch, the model is
      // told exactly which field was wrong and asked to correct it.
      let roleData: z.infer<typeof citationRoleOutputSchema>
      try {
        roleData = await insistOnValid(citationRoleOutputSchema, {
          // Same model on the repair turn as on the first ask: see the note
          // at the call above.
          chat: (m, o) =>
            ctx.llm.call(m, { ...(o as { maxTokens?: number }), model: roleModel(ctx) }),
          systemPrompt: prompt.system,
          ask: async () => text,
          originalUser: prompt.buildUser(JSON.stringify(payload)),
          maxTokens: 8192,
          log: (m) => ctx.log(`role classification: ${m}`),
          schemaName: 'citation-role'
        })
      } catch {
        residueUnusable++
        residueSkipped += batch.length
        continue
      }
      const parsed = { success: true as const, data: roleData }
      const byId = new Map(batch.map((r) => [r.id, r.row]))
      const claimed = new Set<string>()
      for (const raw of parsed.data.roles) {
        // Parsed ONE AT A TIME, on purpose. Validating the array as a whole
        // discards every correct classification in the batch to punish one
        // malformed element — up to 79 of them here — and does it silently,
        // because a batch that classified nothing looks exactly like a batch
        // the model declined to answer.
        const item = citationRoleItemSchema.safeParse(raw)
        if (!item.success) continue
        // DROPPED, never repaired. An id we did not show it names no callout,
        // and a role outside the vocabulary is a label we cannot store — in
        // both cases coercing to the nearest thing would invent a judgement the
        // model did not make.
        const row = byId.get(item.data.id)
        if (!row || claimed.has(item.data.id)) continue
        if (!ROLES.has(item.data.role)) continue
        claimed.add(item.data.id)
        row.role = item.data.role as CitationRole
        row.roleSource = 'llm'
        row.roleCue = null
        residueClassified++
      }
      // The batch was answered and understood; whatever it did not name, the
      // model declined to classify. That is a judgement, not a gap, and is not
      // counted as skipped.
    }

    const inline = rows.filter((r) => r.occurrenceKind === 'inline').length
    if (inline === 0) {
      // `empty` is right HERE and nowhere else in this stage: the gate was
      // passed, the scan was trusted, it ran to completion, and the answer it
      // arrived at is that nothing linked. That is a finding, not an abstention.
      ctx.write({ rows } satisfies ContextsWrite)
      return {
        status: 'empty',
        reason: `no in-text callout resolved to a bibliography entry (${scan.danglingCallouts} dangling)`
      }
    }

    ctx.write({ rows } satisfies ContextsWrite)
    ctx.emit('refs.contexts@v1', { documentId: ctx.documentId, count: rows.length })

    return {
      status: 'succeeded',
      result: {
        contexts: rows.length,
        inline,
        ruleClassified,
        llmCalls,
        // The residue's fate, itemised. A consumer asking "why is this callout
        // unclassified?" can answer it from the run record alone.
        residueTotal: residue.length,
        residueClassified,
        residueSkipped,
        residueUnusableResponses: residueUnusable,
        residueUnreachable,
        danglingCallouts: scan.danglingCallouts,
        malformedMarkers: scan.malformedMarkers,
        ambiguousCallouts
      },
      note:
        `${inline} in-text citation(s), ${ruleClassified} classified by rule, ` +
        `${llmCalls} LLM call(s)` +
        (residue.length > 0
          ? `; ${residueClassified}/${residue.length} residue callout(s) classified by the model`
          : '') +
        // The shortfall is NAMED and its cause distinguished. Silence here is
        // what let "the gateway was down" and "the model classified none of
        // them" render as the same unclassified quote in the reader's popover.
        (residueUnreachable
          ? `; ${residueSkipped} left unclassified — no model could be reached`
          : residueSkipped > 0
            ? `; ${residueSkipped} left unclassified — ` +
              // The count is only stated when there IS one. A request that
              // failed for some other reason (a timeout, a torn socket) leaves
              // `residueUnusable` at 0, and "0 unreadable response(s)" reads as
              // a contradiction of the sentence it is in.
              (residueUnusable > 0
                ? `${residueUnusable} unreadable response(s) from the model`
                : 'the classification request did not complete')
            : '') +
        // Named in the note, not only in the JSON: a paper whose bibliography
        // mis-split is a paper whose citation contexts are partly missing, and
        // the user should learn that from the run rather than from a silence.
        (ambiguousCallouts > 0
          ? `; ${ambiguousCallouts} callout(s) dropped — the bibliography prints those entry numbers more than once`
          : ''),
      // Provenance on every AI result, and a citation role IS one for every row
      // this stage marked `role_source = 'llm'`. Recorded on the run rather than
      // only in the fingerprint, so "which model decided this citation was a
      // contrast" is answerable from the data instead of by re-deriving a hash.
      // Stamped even when the residue was empty: the run genuinely was performed
      // under this prompt, and a NULL would read as "nobody asked".
      // WHAT ANSWERED, not what the provider was built with. `ctx.llm.model`
      // is the constructor default, chosen before any setting was read, so a
      // run under the configured model recorded the other one — provenance
      // that disagrees with reality is worse than none.
      provenance: { model: roleModel(ctx) ?? ctx.llm.model, promptVersion: prompt.version }
    }
  },

  applyWrites(db, payload, ctx) {
    const w = payload as ContextsWrite
    // No delete-first. `beginRun` retires the previous run and deletes its
    // output before this one exists, so the slot is already clear — and a
    // delete scoped by `document_id` would additionally destroy a CONCURRENT
    // run's rows, which is the same reason `segment` does not do it either.
    // Two sibling stages must not carry opposite reasoning about the same
    // situation; if the cascade is trustworthy neither needs the belt, and if
    // it is not, both need it.
    // UPSERT ON THE SITE, so a re-scan keeps the row it is about to re-describe.
    //
    // A citation is identified by where it stands: `ux_citation_context_site`
    // keys on (document_id, callout_offset, ordinal). Re-reading unchanged text
    // finds the same citation at the same offset, so replacing the row would
    // hand it a new id — and `citation_link` cascades from that id, so every
    // verdict the model had already paid to reach was destroyed to recompute a
    // scan that produced identical rows.
    //
    // Updating in place leaves the id alone, so the verdict stays attached to
    // the citation it was actually about. `id` is never written, and the site
    // columns are the conflict target rather than assignments, so nothing can
    // migrate a verdict to a different citation.
    const insert = db.prepare(
      `INSERT INTO citation_context
         (edge_id, unresolved_reference_id, stage_run_id, document_id, citing_work_id,
          ordinal, callout_offset, callout_end, para_id, page, sentence,
          marker_in_sentence, section,
          raw_bib_text, role, role_source, role_cue,
          occurrence_kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (document_id, callout_offset, ordinal)
         WHERE document_id IS NOT NULL AND callout_offset IS NOT NULL
           AND ordinal IS NOT NULL
       DO UPDATE SET
         edge_id                 = excluded.edge_id,
         unresolved_reference_id = excluded.unresolved_reference_id,
         stage_run_id            = excluded.stage_run_id,
         callout_end             = excluded.callout_end,
         para_id                 = excluded.para_id,
         page                    = excluded.page,
         sentence                = excluded.sentence,
         marker_in_sentence      = excluded.marker_in_sentence,
         section                 = excluded.section,
         raw_bib_text            = excluded.raw_bib_text,
         role                    = excluded.role,
         role_source             = excluded.role_source,
         role_cue                = excluded.role_cue,
         occurrence_kind         = excluded.occurrence_kind`
    )
    // Sites this document no longer has. The scan is authoritative about what
    // the text contains, so a row it did not produce describes a citation that
    // is gone — and its verdict goes with it, because a judgement about a
    // passage that no longer exists is not a judgement about anything.
    const deleteVanished = db.prepare(
      `DELETE FROM citation_context
        WHERE document_id = ? AND id NOT IN (SELECT value FROM json_each(?))`
    )
    // The edge is resolved HERE, from the cited work, at write time — never
    // taken from the plan. Between planning and writing, a sweep may have
    // promoted a reference or a curation may have removed an edge, and an id
    // captured earlier would attach this evidence to whatever now holds it.
    const selectEdge = db.prepare(
      `SELECT id FROM citation_edge
        WHERE citing_work_id = ? AND cited_work_id = ? AND edge_type = ?`
    )
    // Likewise for the unresolved arm: the row may have been resolved or the
    // reference deleted since. A row naming a dead parent would fail the FK,
    // and inserting it with both links NULL would fail the XOR — so it is
    // dropped, which is the same treatment a dangling callout already gets.
    const selectUnresolved = db.prepare('SELECT id FROM unresolved_reference WHERE id = ?')

    // The row that stands at a site, whether this write created it or updated
    // one that was already there.
    const selectSite = db.prepare(
      `SELECT id FROM citation_context
        WHERE document_id = ? AND callout_offset = ? AND ordinal = ?`
    )

    const now = new Date().toISOString()
    const survivors: number[] = []
    let kept = 0
    for (const r of w.rows) {
      let edgeId: number | null = null
      let unresolvedId: number | null = null
      if (r.citedWorkId != null) {
        const edge = selectEdge.get(ctx.workId, r.citedWorkId, r.edgeType) as
          | { id: number }
          | undefined
        if (!edge) continue
        edgeId = edge.id
      } else if (r.unresolvedReferenceId != null) {
        if (!selectUnresolved.get(r.unresolvedReferenceId)) continue
        unresolvedId = r.unresolvedReferenceId
      } else {
        continue
      }
      const info = insert.run(
        edgeId,
        unresolvedId,
        ctx.stageRunId,
        ctx.documentId,
        ctx.workId,
        r.ordinal,
        r.calloutOffset,
        r.calloutEnd,
        r.paraId,
        r.page,
        r.sentence,
        r.markerInSentence,
        r.section,
        r.rawBibText,
        r.role,
        r.roleSource,
        r.roleCue,
        r.occurrenceKind,
        now
      )
      // `lastInsertRowid` names the row an INSERT created, but an upsert that
      // UPDATED did not create one — so the surviving id is read back from the
      // site itself, which is the only thing that identifies this citation.
      const row = selectSite.get(ctx.documentId, r.calloutOffset, r.ordinal) as
        | { id: number }
        | undefined
      const id = row?.id ?? Number(info.lastInsertRowid)
      if (id) survivors.push(id)
      kept++
    }

    // Everything the scan did not produce. Counted BEFORE the delete, because
    // afterwards there is nothing left to count — and a verdict lost to a
    // citation that genuinely disappeared is the one outcome here worth the
    // reader's attention.
    const lost = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM citation_link cl
             JOIN citation_context cc ON cc.id = cl.citation_context_id
            WHERE cc.document_id = ?
              AND cc.id NOT IN (SELECT value FROM json_each(?))`
        )
        .get(ctx.documentId, JSON.stringify(survivors)) as { n: number }
    ).n
    deleteVanished.run(ctx.documentId, JSON.stringify(survivors))
    // Announced only when there IS a loss: a re-run that kept everything is the
    // ordinary case, and saying so every time would bury the run that did cost
    // the user model calls.
    if (lost > 0) {
      console.warn(
        `[citation-contexts] document ${ctx.documentId}: ${lost} verified citation ` +
          `link(s) dropped because the new scan no longer finds their callout ` +
          `(${kept} citation site(s) kept). Re-verification will have to pay for them again.`
      )
    }
  }
}

export default citationContexts
