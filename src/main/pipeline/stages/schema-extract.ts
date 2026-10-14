// Extract structured facts under each extraction schema the project applies.
//
// ONE JOB PER SCHEMA, via `fanOut()`. That is the point: before `analysis_run`
// gained `schema_id`, N schemas over one (work, project) all collided on
// `ux_analysis_run_current`, so extracting under a second schema silently
// retired the first one's results. Fanning out per schema and keying the
// current-run index on it means N schemas produce N current analyses, each with
// its own provenance.
//
// It also closes a live gap: `PipelineInput.schemaId` has existed for some time
// and the old queue never passed it, so a schema-driven extraction ran the
// generic prompt and returned measurements bound to no field.
//
// INLINE, and it does NOT use `ctx.write`. `runPipeline` owns its own
// supersede-then-insert transaction across `analysis_run`, `evidence_span`,
// `fact`, `measurement` and `fold_improvement`, threading generated ids through
// all five — and it is async, which a synchronous terminal transaction cannot
// contain. Rather than pretend otherwise, the stage runs it in `execute` and
// records the resulting `analysis_run_id` on its `stage_run`, so the provenance
// chain from job to stage to analysis is complete even though the two
// transactions are distinct. The cost is honest and bounded: a kill between
// them leaves an analysis whose stage_run says `running`, which `resumePending`
// re-queues and the supersede-then-insert then replaces idempotently.
//
// ONE EXECUTION IS THE WHOLE READING, IN ORDER:
//
//   1. the table crops are rendered once (`renderTableCrops`), and every later
//      phase reads EXACTLY the pictures it produced — a second renderer would
//      produce a lookalike, and a lookalike is not evidence;
//   2. each crop is transcribed into a canonical grid under `table-grid@v1`
//      and published as `text.tables@v1`. The grid stores no facts: a cell
//      here is a transcription, never a claim about the paper, so the
//      one-current-run invariant and `analysis_run` provenance are untouched
//      by it;
//   3. one cheap call inventories the paper under `enumerate@v2` — its
//      tables, rows and prose subjects, with the quantity each is presented
//      under AS THE PAPER NAMES IT — and publishes `text.inventory@v1`. The
//      inventory is schema-AGNOSTIC on purpose: it runs wherever the paper
//      runs, and no schema has to reach the reader that makes it. Folding its
//      paper-named quantities onto schema fields is the job of the readers
//      that hold the schema. Its failure is logged, never fatal: an
//      enrichment's absence is not a reason to stop reading the paper;
//   4. the extraction answers against the inventory when one was made
//      (`runAnalysis` with `inventory`) and persists through the same
//      supersede-then-insert as every analysis;
//   5. a zero-fact answer on a paper whose inventory claims subjects is put
//      to one adjudication reader — the fields, the inventory and the paper,
//      never the extraction's answer;
//   6. every field of the schema the extraction left unanswered gets ONE
//      field-scoped re-read under `extraction-targeted@v1`, led by the
//      passages a semantic search of THIS paper returns for it, and the pass
//      is published as `text.targeted@v1`.
//
// WHAT THE EXECUTE CONTEXT MAY NOT DO, AND HOW EACH PHASE AVOIDS IT. A stage
// body has no database: `ctx.db` deliberately exposes no handle, and in a host
// process there is no database behind it at all — any read there is a
// guaranteed crash. So the schema's ordered field list travels INTO the stage
// as a dispatch-envelope input (`SCHEMA_FIELDS_INPUT`), resolved in MAIN by
// `resolveInputs` below, where the handle is real; the grids and the inventory
// are made without one; and the zero-fact gate is phrased over that same
// field list plus the inventory, never over a schema spec read from the
// database. The one reading that genuinely needs the database — which fields
// the extraction stored — is `runPipeline`'s own, returned on the result it
// hands back as `fieldsWithFacts`, so the unanswered set is a reading of the
// run's own rows and not a rule.

import { listProjectSchemas } from '../../db/repositories'
import {
  enumerateOutputSchema,
  getPrompt,
  inventoryAdjudicateSystem,
  inventoryAdjudicationSchema,
  SCHEMA_VERSION,
  tableGridOutputSchema,
  tableGridUserTurn,
  tagParagraphs,
  type EnumerationArtifact
} from '../../llm/prompts'
import { extractJson } from '../../llm/provider'
import type { DocumentFile, Paragraphs, TextPages, TextTables } from '../capabilities'
import { renderTableCrops, type TableCrops } from '../tableCrops'
import type {
  Capability,
  SemanticBlock,
  SemanticHandle,
  StageContext,
  StageDefinition
} from '../types'

/**
 * The dispatch-envelope input carrying THIS schema's fields, in schema order.
 *
 * Resolved in MAIN by `resolveInputs` below — the process where the database
 * handle is real — and consumed in `execute`, which must never open the
 * database for it. It exists because two phases need the schema's fields as
 * bare data rather than as a rendered spec: the targeted second look computes
 * the unanswered set as the full field list minus the fields the extraction
 * stored, and the zero-fact adjudicator is phrased over the fields
 * themselves.
 */
const SCHEMA_FIELDS_INPUT = 'schema.fields@v1'

interface SchemaFieldRef {
  key: string
  label: string
}

/**
 * Whether the inventory ITSELF claims anything for this paper — any table row
 * or prose subject listed at all.
 *
 * This decides only whether the silence question is worth a reader; the reader
 * decides the answer, including which fields the paper's quantities answer.
 * The inventory no longer names schema fields to match against, so a rule
 * here that compared claims to keys would have nothing to compare — and a
 * fact-count rule would re-arm the exact failure this gate exists to close,
 * where a number stood in for a reading.
 */
function inventoryClaimsSubjects(inv: EnumerationArtifact): boolean {
  return inv.prose_subjects.length > 0 || inv.tables.some((t) => t.subjects.length > 0)
}

type SilenceVerdict = {
  verdict: 'answers' | 'silent'
  tables: string[]
  reason: string
} | null

/**
 * The zero-fact adjudication. ONE reader call, blind to the extraction's
 * answer: given the schema's fields as a bare list, the inventory, and the
 * paper itself — text and table pictures, the same materials the extractor
 * had — it is asked whether the paper answers any field at all, folding the
 * inventory's paper-named quantities onto the fields itself. Any failure to
 * obtain or parse a verdict returns null, and the caller never lets a failed
 * adjudication stand in for a reading: an unadjudicated silence goes to review
 * rather than being blessed.
 */
async function adjudicateZeroFacts(
  ctx: StageContext,
  fields: readonly SchemaFieldRef[],
  inventoryText: string,
  body: string,
  crops: TableCrops
): Promise<SilenceVerdict> {
  const question = [
    'THE FIELDS THIS READING WAS ASKED ABOUT (key — the schema\u2019s own label):',
    fields.map((f) => `- ${f.key} — ${f.label}`).join('\n'),
    '',
    'THE INVENTORY:',
    inventoryText,
    '',
    'DOCUMENT TEXT (each paragraph is tagged [pN]):',
    tagParagraphs(body)
  ].join('\n')
  try {
    const raw = await ctx.llm.call(
      [
        { role: 'system', content: inventoryAdjudicateSystem },
        { role: 'user', content: question, images: crops.images }
      ],
      { maxTokens: 2048 }
    )
    const parsed = inventoryAdjudicationSchema.safeParse(extractJson(raw))
    if (!parsed.success) {
      ctx.log('the adjudication answer was not in the expected shape')
      return null
    }
    return {
      verdict: parsed.data.verdict,
      tables: parsed.data.tables ?? [],
      reason: parsed.data.reason ?? ''
    }
  } catch (err) {
    ctx.log(`the adjudication call failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/** How many lead passages one field's search may contribute. */
const LEADS_K = 8

/**
 * The same normalisation the anchor contract uses everywhere: a PDF's text
 * layer breaks lines mid-word and spaces out symbols, so a search block
 * matches its paragraph only after both sides are reduced to letters and
 * digits.
 */
const canon = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{Nd}]+/gu, '')

/**
 * Resolve one field's search blocks to the document paragraphs they came
 * from. A block that resolves to nothing is dropped: a lead without a
 * paragraph has no entry in the paragraph map, and sending text the map
 * cannot name would let an anchor settle on a position that means nothing.
 * The LEADS RIDE THE DOCUMENT TEXT: a search block is only used as a lead
 * when it resolves to one of the document's own paragraphs, and its position
 * in the returned index names the paragraph it truly came from — the same
 * paragraph the paper carries it at further down. An anchor cited to a lead
 * is therefore an anchor to a real paragraph, never to a summary of one.
 */
function resolveLeads(
  blocks: readonly SemanticBlock[],
  kept: Paragraphs['paragraphs'],
  canonByPara: readonly string[]
): { leadIdx: number[]; leadText: string[]; lowConfidence: number } {
  const leadIdx: number[] = []
  const leadText: string[] = []
  const taken = new Set<number>()
  let lowConfidence = 0
  for (const b of blocks) {
    if (leadText.length >= LEADS_K) break
    if (b.lowConfidence) lowConfidence += 1
    const needle = canon(b.text)
    if (needle === '') continue
    let matched = -1
    for (let i = 0; i < kept.length; i++) {
      if (taken.has(i)) continue
      const hay = canonByPara[i]
      if (
        hay === needle ||
        (needle.length >= 40 && hay.includes(needle)) ||
        (hay.length >= 40 && needle.includes(hay))
      ) {
        matched = i
        break
      }
    }
    if (matched === -1) continue
    taken.add(matched)
    leadIdx.push(kept[matched].index)
    leadText.push(kept[matched].text)
  }
  return { leadIdx, leadText, lowConfidence }
}

/** What one field-targeted second look produced. */
interface TargetedPassResult {
  analysisRunId: number
  field: string
  facts: number
  leads: number
  model: string
  promptVersion: string
  truncated: boolean
}

/**
 * The per-field second look, for the fields the extraction left unanswered.
 *
 * THE UNANSWERED SET IS A READING, NOT A HEURISTIC. It is the schema's field
 * list minus the fields the extraction's own stored rows carry
 * (`fieldsWithFacts`, read by `runPipeline` from the run it just committed):
 * a field either has a stored answer or it does not, and the pass asks once
 * for each that does not. No coverage threshold, no expected count. The paper
 * answering nothing is a finding that settles as a success.
 *
 * TEXT ONLY. The first reading reads tables off pictures; this pass reads the
 * paper's own prose about the conditions those tables were measured under,
 * which the text layer carries. No crops are rendered and no pages are sent.
 */
async function runTargetedPass(
  ctx: StageContext,
  semantic: SemanticHandle,
  schemaId: number,
  fields: readonly SchemaFieldRef[],
  fieldsWithFacts: readonly string[],
  kept: Paragraphs['paragraphs']
): Promise<TargetedPassResult[]> {
  const answered = new Set(fieldsWithFacts)
  const unanswered = fields.filter((f) => !answered.has(f.key))
  const out: TargetedPassResult[] = []
  if (unanswered.length === 0) {
    ctx.log('every field of this schema has a stored answer; no second look is owed')
    return out
  }
  const targetedPrompt = getPrompt('extraction-targeted')
  const canonByPara = kept.map((p) => canon(p.text))
  for (const f of unanswered) {
    if (ctx.signal.aborted) throw new Error('cancelled')
    ctx.progress(
      30 + Math.round((out.length / unanswered.length) * 60),
      `second look: ${f.key}`
    )
    // THE LEADS. One search for this field over THIS paper. A single-paper
    // scope always gets the exhaustive scan, which is the more accurate of
    // the two strategies and not a degradation.
    const sem = await semantic(f.key, LEADS_K, [ctx.workId])
    const { leadIdx, leadText, lowConfidence } = resolveLeads(sem.blocks, kept, canonByPara)
    ctx.log(
      `second look at '${f.key}': ${sem.blocks.length} passage(s) searched, ` +
        `${leadText.length} resolved to document paragraph(s)` +
        (lowConfidence > 0 ? `, ${lowConfidence} low-confidence` : '')
    )

    // THE PAPER, WHOLE, WITH THE LEADS PLACED IN FRONT. The map carries the
    // document paragraph behind every [pN] of the joined text, leads first —
    // so an anchor the model cites to a lead lands on the paragraph that
    // really prints it, which the paper also carries further down.
    const docText = [...leadText, ...kept.map((p) => p.text)].join('\n\n')
    const paragraphIndexMap = [...leadIdx, ...kept.map((p) => p.index)]

    const res = await ctx.runAnalysis({
      analysisType: 'extraction-targeted',
      docText,
      schemaId,
      onlyFields: [f.key],
      documentId: ctx.documentId,
      paragraphIndexMap
    })
    out.push({
      analysisRunId: res.analysisRunId,
      field: f.key,
      facts: res.factCount,
      leads: leadText.length,
      model: res.model,
      promptVersion: targetedPrompt.version,
      truncated: res.truncated
    })
  }
  return out
}

const schemaExtract: StageDefinition<{
  analysisRunId: number
  facts: number
  targetedFields: number
  targetedFacts: number
}> = {
  id: 'schema-extract',
  label: 'Extract',
  // 1.12.0: the stage IS the whole reading now — the table grids, the
  // inventory and the per-field second look run as phases of this one
  // execution, the inventory is schema-agnostic (`enumerate@v2`), and the
  // schema's field list reaches the body as a dispatch-envelope input instead
  // of being read from the database inside it. Every cached answer was
  // reached by separate readings, under an inventory that named schema fields
  // and with no second look behind it in the same execution.
  // 1.11.0: the stage answers against `text.inventory@v1` when the enumerate
  // stage has produced one, and a zero-fact answer on a paper whose inventory
  // claims answerable subjects is put to an adjudication reader instead of
  // being blessed. Every cached answer was reached with no inventory to answer
  // and no gate on the empty one.
  // 1.10.0: the extraction read now answers through a forced tool (its
  // arguments are the answer) instead of JSON in prose. The request genuinely
  // changed, so every stored extraction is re-made under it — the stage
  // version is what re-arms them.
  version: '1.12.0',
  rank: 8,
  scope: 'project',
  provides: [
    'analysis.extraction@v1',
    'text.tables@v1',
    'text.inventory@v1',
    'text.targeted@v1'
  ],
  requires: ['text.paragraphs@v1', 'text.pages@v2', 'document.file@v1'],
  usesLlm: true,
  runtime: 'node',
  weight: 'light',

  fanOut(ctx) {
    // A project with no schema attached still gets ONE key, so the absence is
    // REPORTED rather than silently swallowed — `execute` refuses it below and
    // the paper appears in the Queue waiting on a schema. Returning zero keys
    // instead would leave a project extracting nothing, with nothing anywhere
    // saying why.
    const schemas = listProjectSchemas(ctx.db, ctx.projectId)
    if (schemas.length === 0) return [{ key: 'default', label: 'Default extraction' }]
    return schemas.map((s) => ({ key: s.key, schemaId: s.id, label: s.name }))
  },

  resolveInputs(db, _ctx, fan) {
    // THE FIELD LIST, RESOLVED IN MAIN. `execute` needs the schema's fields as
    // data — the unanswered set for the second look, the phrasing of the
    // zero-fact adjudicator — and a stage body has no database to read them
    // from; in a host process there is none at all. This hook runs where the
    // handle is real, and the list travels in the dispatch envelope. Schema
    // order (`sort_order`, then insertion), because the order the second look
    // asks fields in is the order a reader reads them in.
    if (fan?.schemaId == null) return []
    const fields = db
      .prepare(
        `SELECT f."key" AS key, f.label AS label
           FROM extraction_field f
          WHERE f.schema_id = ?
          ORDER BY f.sort_order, f.id`
      )
      .all(fan.schemaId) as SchemaFieldRef[]
    const inputs: Array<[Capability, unknown]> = [[SCHEMA_FIELDS_INPUT, fields]]
    return inputs
  },

  fingerprint(ctx, fan) {
    // The PROMPT VERSIONS, because every prompt this stage answers under is an
    // input in every sense that matters: it decides what the model extracts,
    // what the grid transcribes, what the inventory reports the paper to hold
    // and what the second look asks. Left out, a prompt fix reached nothing —
    // the planner queued the work, the cache answered "identical inputs", and
    // every paper kept the answer made under the old wording. A rule written
    // to stop evidence being cited to a paper's title shipped, was measured to
    // work, and changed not one stored row.
    const base =
      `prompt=${getPrompt('extraction').version}` +
      // The OUTPUT schema version. `SCHEMA_VERSION` governs the shape the
      // model must answer in and is stamped into every run's provenance — so
      // the record said which shape produced a result while the cache served
      // results made under a different one.
      `|out=${SCHEMA_VERSION}` +
      // The in-stage readings' prompt versions: the inventory's, the grids'
      // and the second look's. Each wording decides what its reading reports,
      // and a rewording that never reached a stored answer would leave
      // extraction and review answering against checklists nobody can read.
      `|enum=${getPrompt('enumerate').version}` +
      `|grid=${getPrompt('table-grid').version}` +
      `|targeted=${getPrompt('extraction-targeted').version}`

    // The schema's own version, so editing a field supersedes the extraction
    // that was made under the old definition. Without it, a user could add a
    // required field and see the previous run presented as satisfying it.
    if (!fan?.schemaId) return `schema=none|${base}`
    const row = ctx.db
      .prepare('SELECT version FROM extraction_schema WHERE id = ?')
      .get(fan.schemaId) as { version: string } | undefined
    return `schema=${fan.schemaId}@${row?.version ?? 'missing'}|${base}`
  },

  async execute(ctx) {
    // NO SCHEMA, NO EXTRACTION. This is the `fanOut` sentinel arriving here, and
    // it is refused rather than run.
    //
    // A schema-less extraction lets the model invent its own field names, and
    // what came back was one predicate per row of every table:
    // `variant_R2_2_7E_kcat`, `variant_R2_3_5G_kcat`… 641 distinct predicates
    // over 1255 facts, 526 of them used exactly once. No `field_id`, so nothing
    // can be filtered, exported, compared across papers or checked — the same
    // numbers the schema-targeted run stored as `kcat`, in a shape no query can
    // reach. It cost 20 model calls and padded the corpus 5x with rows a reader
    // cannot use, which is precisely what §3's "a value no schema asked for is
    // out of scope" exists to prevent.
    //
    // `refused` (not `skipped`) settles the job to `review`, so a project with
    // no schema is a question put to the user, not a silence.
    if (!ctx.fanOut?.schemaId) {
      return {
        status: 'refused',
        reason:
          'this project has no extraction schema attached, and extraction with no schema has ' +
          'no fields to bind values to — attach a schema, then re-run'
      }
    }

    const paras = ctx.input<Paragraphs>('text.paragraphs@v1')
    if (!paras) {
      return { status: 'skipped', reason: 'no text.paragraphs@v1 — nothing to extract from' }
    }

    // `reference` paragraphs are excluded: a bibliography is prose-shaped and
    // is not findings, and summarising one as if it were is exactly the failure
    // the paragraph `kind` was introduced to prevent.
    const kept = paras.paragraphs.filter((p) => p.kind !== 'reference')
    const body = kept.map((p) => p.text).join('\n\n')
    // WHICH document paragraph each [pN] of `body` is. Dropping the bibliography
    // renumbers everything after it, and an anchor is read back against
    // `document_paragraph` — so without this the model's `[p47]` is stored as
    // the document's paragraph 47, a different paragraph in 13 of this corpus's
    // 20 papers.
    const paragraphIndexMap = kept.map((p) => p.index)
    if (body.trim() === '') {
      return { status: 'empty', reason: 'the document has no prose outside its bibliography' }
    }

    // The schema's fields, resolved in MAIN and shipped in the envelope — see
    // `SCHEMA_FIELDS_INPUT`. Absent only when this execute was reached from
    // outside the scheduler's dispatch build; the phases that need it say so
    // and proceed without, the way a precondition's absence is always a
    // reported gap rather than a guessed zero.
    const fields = ctx.input<SchemaFieldRef[]>(SCHEMA_FIELDS_INPUT) ?? []

    // ---- 1. THE CROPS, RENDERED ONCE ------------------------------------
    const crops = await renderTableCrops(
      ctx.input<DocumentFile>('document.file@v1'),
      ctx.input<TextPages>('text.pages@v2'),
      ctx.log,
      (region) =>
        `Image: ${region.label ?? 'table'} (page ${region.page}). ` +
        'Read the VALUES from this picture — the extracted text mangles ' +
        'symbols such as plus-minus and superscripts. Cite the paragraph ' +
        'ids from the TEXT, not from this image.'
    )
    if (crops.images.length > 0) {
      ctx.log(`sending ${crops.images.length} table crop(s) as primary source`)
    }

    // ---- 2. THE GRIDS ----------------------------------------------------
    const gridNotes: string[] = []
    if (crops.found === 0) {
      // A paper that locates no table is not a gap: there was never anything
      // to transcribe, and a complete reading says nothing.
    } else if (crops.images.length === 0) {
      // Tables we LOCATED and could not picture are our failure, not the
      // paper's silence. The outcome notes below already carry the cost for
      // the extraction (INCOMPLETE, or `empty` on a zero-fact answer); the
      // grids simply do not exist for this paper.
      ctx.log(
        `${crops.found} table(s) were located but none could be rendered ` +
          `(${crops.unavailable ?? 'every located table failed to render'}); the tables were not gridded`
      )
    } else {
      // The EXTRACTION settings, not the review ones. This is the primary read
      // of the paper's tables, not a second independent one — the whole point
      // of publishing it is that the review stays free to fail differently.
      const models = ctx.db.modelSettings()
      const gridOpts = {
        model: models.extractionModel === '' ? undefined : models.extractionModel,
        maxTokens: models.extractionMaxOutput,
        // The grid is a faithful transcription read off a picture — the one
        // reading here that reasoning measurably serves. Stated explicitly so
        // it holds whatever the gateway env flag says.
        reasoningEffort: 'adaptive' as const
      }
      const gridTmpl = getPrompt('table-grid')
      const tables: TextTables['tables'] = []
      let read = 0
      let unread = 0
      for (const img of crops.images) {
        if (ctx.signal.aborted) return { status: 'failed', error: 'cancelled', retryable: true }
        ctx.progress(
          Math.round((tables.length / crops.images.length) * 20),
          `grid ${tables.length + 1} of ${crops.images.length}`
        )
        try {
          const text = await ctx.llm.call(
            [
              { role: 'system', content: gridTmpl.system },
              {
                role: 'user',
                content: gridTmpl.buildUser(tableGridUserTurn(img.page, img.label)),
                images: [
                  {
                    png: img.png,
                    caption:
                      `Image: ${img.label ?? 'table'} (page ${img.page}). ` +
                      'This picture is the table to transcribe — the grid describes what is ' +
                      'printed here, exactly as it is printed.'
                  }
                ]
              }
            ],
            gridOpts
          )
          const parsed = tableGridOutputSchema.safeParse(extractJson(text))
          if (!parsed.success) {
            unread++
            ctx.log(`a table on page ${img.page} came back out of shape; it is not gridded`)
            continue
          }
          read++
          for (const t of parsed.data.tables) {
            tables.push({
              // Page and label are OURS, from the region the crop was rendered
              // from — a fact about which picture was sent, not something to
              // take on the model's word. The caption is the page's own printed
              // text, which only the reader can see.
              page: img.page,
              label: img.label,
              caption: t.caption ?? null,
              columns: t.columns.map((c) => ({ header: c.header, unit: c.unit ?? null })),
              rows: t.rows.map((r) => ({ rowLabel: r.rowLabel ?? null, cells: r.cells })),
              unresolved: t.unresolved ?? null
            })
          }
        } catch (err) {
          // One unread table must not lose the others, but it must not count as
          // read either — the shortfall is reported below and carried on the
          // artifact, so "3 gridded" never quietly means "4 were attempted".
          unread++
          ctx.log(
            `reading the table on page ${img.page} failed: ${err instanceof Error ? err.message : String(err)}`
          )
        }
      }

      // NO READING HAPPENED AT ALL. A run that filed "this paper's tables are
      // unread" as a grid-shaped success would satisfy every downstream reader
      // with an empty answer — the one outcome this pipeline may not have.
      // Retryable: a malformed or unreachable model is nothing about the paper.
      if (read === 0) {
        return {
          status: 'failed',
          error:
            `none of this paper's ${crops.images.length} table picture(s) could be read into a ` +
            'grid; no reading of its tables exists',
          retryable: true
        }
      }

      const grids: TextTables = {
        documentId: ctx.documentId,
        readerVersion: `${gridTmpl.name}@${gridTmpl.version}`,
        model: ctx.llm.model,
        located: crops.found,
        rendered: crops.images.length,
        read,
        tables
      }
      ctx.emit('text.tables@v1', grids)

      const unrendered = crops.found - crops.images.length
      const partials = tables.filter((t) => t.unresolved !== null).length
      gridNotes.push(
        `${tables.length} table(s) gridded from ${read} picture(s)`,
        ...(unrendered > 0
          ? [`INCOMPLETE: ${unrendered} of ${crops.found} located table(s) failed to render`]
          : []),
        ...(unread > 0
          ? [`INCOMPLETE: ${unread} table picture(s) could not be read into a grid`]
          : []),
        ...(partials > 0
          ? [`INCOMPLETE: ${partials} table(s) reported a part their reader could not see`]
          : [])
      )
    }

    // ---- 3. THE INVENTORY ------------------------------------------------
    let inventory: EnumerationArtifact | null = null
    let inventoryNote: string | null = null
    const enumTmpl = getPrompt('enumerate')
    ctx.progress(20, 'inventorying the paper')
    try {
      const raw = await ctx.llm.call(
        [
          { role: 'system', content: enumTmpl.system },
          {
            role: 'user',
            content: enumTmpl.buildUser(body),
            images: crops.images.map((img) => ({
              png: img.png,
              caption:
                `Image: ${img.label ?? 'table'} (page ${img.page}). ` +
                'Read this picture\u2019s STRUCTURE for the inventory — its caption, its row labels ' +
                'and its column headings. It is not asked for values.'
            }))
          }
        ],
        { maxTokens: 16384, reasoningEffort: 'none' }
      )
      const parsed = enumerateOutputSchema.safeParse(extractJson(raw))
      if (!parsed.success) {
        inventoryNote =
          'the inventory answer was not in the expected shape; the extraction answered without it'
        ctx.log(inventoryNote)
      } else {
        inventory = parsed.data
        ctx.emit('text.inventory@v1', inventory)
        ctx.log(
          `inventory: ${inventory.tables.length} table(s), ` +
            `${inventory.prose_subjects.length} prose subject(s)`
        )
      }
    } catch (err) {
      inventoryNote = `the inventory reading failed (${err instanceof Error ? err.message : String(err)}); the extraction answered without it`
      ctx.log(inventoryNote)
    }
    const inventoryText = inventory ? JSON.stringify(inventory, null, 2) : null

    // ---- 4. THE EXTRACTION -----------------------------------------------
    ctx.progress(30, 'extracting')
    const res = await ctx.runAnalysis({
      analysisType: 'extraction',
      docText: body,
      schemaId: ctx.fanOut?.schemaId ?? null,
      documentId: ctx.documentId,
      images: crops.images,
      paragraphIndexMap,
      inventory: inventoryText
    })

    const prompt = getPrompt('extraction')

    // A CUT-OFF ANSWER IS AN UNFINISHED READING, AND THE JOB FAILS ON IT.
    //
    // The run is filed and its salvaged records are kept — they are correct, and
    // throwing them away costs whole papers' worth of extraction. But the model
    // never reached the end of the paper, so the count beside it describes a
    // fraction of a reading, and settling that as `succeeded` is the app
    // presenting part of a paper as the paper. RETRYABLE: nothing about the
    // document caused it, only the output budget, and the next attempt asks the
    // same question again with the run that survived already stored.
    if (res.truncated) {
      return {
        status: 'failed',
        error:
          `the model's answer was cut off before it finished reading this paper; ` +
          `${res.factCount} complete record(s) were salvaged and stored, but the reading is ` +
          'unfinished',
        retryable: true
      }
    }

    // A paper that carries nothing for THIS schema is not a failed extraction.
    //
    // Most papers in a corpus answer one schema and not another: a kinetics
    // study reports no melting temperature, and reading it against a
    // thermostability schema correctly yields nothing. That was reported
    // identically to a run whose model returned garbage — 27 of 40 runs on this
    // corpus came back "0 fact(s)" and 21 were stamped `failed`, when ~19 of
    // them were right. A scientist reading that concludes the tool is broken.
    //
    // `not-needed` is the outcome that already exists for exactly this shape of
    // claim (OCR declining a PDF that has a text layer): the stage ran, decided
    // the right amount of work was none, and settles as a success rather than
    // announcing itself.
    //
    // Deciding this on the FACT COUNT is only sound because `runAnalysis` now
    // throws rather than returning when no validated answer was ever obtained —
    // a dead socket, an unparseable reply, a truncation that salvaged nothing.
    // Those used to arrive here as a result with `factCount === 0`, so a paper
    // nothing had read reported itself as a paper carrying nothing, and the run
    // recording that non-reading had already retired the run that read it.
    if (res.factCount === 0) {
      // WHAT WAS READ, in the answer that says nothing was found.
      //
      // "The model reports this paper carries nothing" was returned by three
      // situations a reader must be able to tell apart: a paper that genuinely
      // holds nothing for this schema, a paper whose tables we could not picture
      // and therefore read only as mangled text, and a paper nothing had ever
      // been read from at all. Only the third was distinguishable (it settles
      // `skipped` above, for want of paragraphs), so an extraction that lost
      // ~60 values off two intact tables and one that correctly found no melting
      // temperature wrote the identical sentence.
      //
      // Naming the material makes them distinguishable without GUESSING which
      // one happened: these are counts of what we handed over, not a judgement
      // about what the paper should have yielded. A rule that inferred "this
      // paper has tables, so it ought to have answered" would fire on every
      // kinetics table read against a thermostability schema — a false positive
      // on a correct result, which is the failure mode this project removed a
      // whole deterministic layer to be rid of.
      const read =
        `${kept.length} paragraph(s) and ` +
        (crops.images.length > 0 ? `${crops.images.length} table picture(s)` : 'no table picture')
      const scopeNote =
        res.droppedOffSchema > 0
          ? `read ${read}: the model found ${res.droppedOffSchema} value(s) here, but none belong to any field of this schema`
          : `read ${read}: the model reports this paper carries nothing for this schema`
      // NOT `not-needed` when the emptiness is OUR doing. If every claim was
      // discarded for unanchorable evidence, something IS wrong and a human
      // should see it — that is what `empty` (which settles to `review`) is for.
      if (res.droppedUnanchored > 0 && !res.modelReturnedNothing) {
        return {
          status: 'empty',
          reason:
            `every one of the model's ${res.droppedUnanchored} claim(s) cited a passage that ` +
            'could not be found in this document, so none could be kept'
        }
      }
      // A TABLE WE LOCATED AND COULD NOT PICTURE is our failure, not the
      // paper's silence, so it goes to `empty` and reaches the review queue —
      // the values on that page were read from text the architecture does not
      // trust, and here they yielded nothing at all.
      if (crops.unavailable !== null) {
        return {
          status: 'empty',
          reason:
            `${crops.found} table(s) were located on this paper but none could be pictured ` +
            `(${crops.unavailable}), so it was read from extracted text alone — and ${scopeNote}`
        }
      }
      // THE BLESSED-EMPTY GATE. This is the failure the inventory exists to
      // catch: a paper full of answerable tables once answered `{"facts": []}`
      // and the emptiness was blessed, because the extractor's own report was
      // the only reader in the room. When the inventory claims subjects for
      // this paper, the silence is put to one adjudication reader — seeing the
      // fields, the inventory and the paper, never the extraction's answer —
      // and its verdict replaces the automatic decision. No fact count reaches
      // this branch: the trigger reads the inventory's claims, and everything
      // beyond it is the reader's judgement.
      //
      // An adjudication that cannot be OBTAINED never blesses the silence: the
      // run settles `empty` and reaches review, the same place a disagreement
      // does, because a silence nobody could check is not a silence somebody
      // verified.
      if (inventory && fields.length > 0 && inventoryClaimsSubjects(inventory)) {
        const verdict = await adjudicateZeroFacts(
          ctx,
          fields,
          inventoryText ?? '',
          body,
          crops
        )
        if (verdict?.verdict === 'silent') {
          return {
            status: 'not-needed',
            reason:
              `${scopeNote}; the zero-fact answer was put to an adjudication pass over the ` +
              'fields, the inventory and the paper, and it held that this paper answers no field of ' +
              'this schema' +
              (verdict.reason ? ` — "${verdict.reason}"` : '')
          }
        }
        if (verdict === null) {
          return {
            status: 'empty',
            reason:
              `${scopeNote}: whether this paper answers this schema could not be adjudicated ` +
              '(no usable verdict from the adjudication pass), so the silence is left for a ' +
              'human to check'
          }
        }
        return {
          status: 'empty',
          reason:
            `${scopeNote}: an adjudication pass disagrees — it names ` +
            `${verdict.tables.length > 0 ? verdict.tables.join(', ') : 'a table'} as ` +
            'answering this schema while no fact was stored'
        }
      }
      return { status: 'not-needed', reason: scopeNote }
    }

    // ---- 6. THE TARGETED SECOND LOOK --------------------------------------
    let targeted: TargetedPassResult[] = []
    if (fields.length === 0) {
      ctx.log('the schema field list did not reach this stage; the targeted second look is skipped')
    } else if (!ctx.semantic) {
      ctx.log(
        'no semantic-search worker is provisioned in this process; the targeted second look is skipped'
      )
    } else {
      try {
        targeted = await runTargetedPass(
          ctx,
          ctx.semantic,
          ctx.fanOut.schemaId,
          fields,
          res.fieldsWithFacts,
          kept
        )
        if (targeted.length > 0) ctx.emit('text.targeted@v1', targeted)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // A cancellation unwinds here as it unwinds everywhere: retryable, and
        // the next attempt starts the whole reading again.
        if (ctx.signal.aborted) {
          return { status: 'failed', error: 'cancelled', retryable: true }
        }
        return {
          status: 'failed',
          error: `the targeted second look failed: ${msg}`,
          retryable: true
        }
      }
    }

    const targetedFacts = targeted.reduce((n, t) => n + t.facts, 0)

    return {
      status: 'succeeded',
      result: {
        analysisRunId: res.analysisRunId,
        facts: res.factCount,
        targetedFields: targeted.length,
        targetedFacts
      },
      // INCOMPLETENESS IS MEASURED HERE, NEVER TAKEN ON THE MODEL'S WORD.
      //
      // The stage used to render `res.shortfalls` — the model's own
      // `extraction_shortfall` claims — as `INCOMPLETE: …`. Over this corpus it
      // fired exactly once, and what it said was "all rows successfully
      // extracted": a SUCCESS announced under an INCOMPLETE banner. In the same
      // run set, work 19 had 13 claims thrown away for citing no findable
      // passage and declared no shortfall at all. A model asked to grade its own
      // reading is wrong in both directions, and a warning that is wrong in both
      // directions is worse than none — the reader learns to skip it, and takes
      // the true warnings next to it down too.
      //
      // What replaces it is what the PIPELINE counted for itself. Both numbers
      // are facts about rows that exist or do not: `droppedUnanchored` is claims
      // discarded because their quote is not in this document,
      // `droppedOffSchema` is values discarded because no field of this schema
      // asked for them. Neither can lie, and either one being non-zero is a
      // genuine shortfall — the run reports less than the model produced.
      //
      // Per HARD RULE 0.6 the counts appear only when non-zero: a clean run says
      // nothing, so the exception keeps its force.
      note: [
        `${res.factCount} fact(s), ${res.evidenceCount} evidence span(s)`,
        ...gridNotes,
        ...(inventoryNote ? [inventoryNote] : []),
        // A TABLE WE LOCATED AND COULD NOT PICTURE.
        //
        // The architecture is that the page image is authoritative for a value
        // and the text layer only says where to cite it. When the picture is
        // missing, that guarantee is gone for this paper and nothing else says
        // so: the run reports its facts, its quotes resolve, and the OCR badge
        // beside them reads 92% confident. This corpus's scan lost every
        // decimal point that way and stored `137 mM` for `1.37 mM`.
        ...(crops.unavailable !== null
          ? [
              `INCOMPLETE: ${crops.found} table(s) were located but none could be pictured ` +
                `(${crops.unavailable}), so their values were read from extracted text alone`
            ]
          : []),
        ...(res.droppedUnanchored > 0
          ? [`INCOMPLETE: ${res.droppedUnanchored} dropped for citing no findable passage`]
          : []),
        ...(res.droppedOffSchema > 0
          ? [`INCOMPLETE: ${res.droppedOffSchema} value(s) matched no field of this schema`]
          : []),
        ...(res.droppedWrongDimension > 0
          ? [
              `INCOMPLETE: ${res.droppedWrongDimension} value(s) refused for carrying a unit ` +
                `the named field cannot hold`
            ]
          : []),
        ...(res.demangledBounds > 0
          ? [`${res.demangledBounds} value(s) held as bounds, not as figures`]
          : []),
        ...(targeted.length > 0
          ? [
              `the targeted second look re-read ${targeted.length} field(s)` +
                (targetedFacts > 0
                  ? `, storing ${targetedFacts} further fact(s)`
                  : ', finding nothing further')
            ]
          : []),
        ...targeted
          .filter((t) => t.truncated)
          .map((t) => `INCOMPLETE: the second look at '${t.field}' was cut off`)
      ].join('; '),
      provenance: {
        model: res.model,
        promptVersion: prompt.version,
        schemaVersion: SCHEMA_VERSION,
        analysisRunId: res.analysisRunId
      }
    }
  }
}

export default schemaExtract
