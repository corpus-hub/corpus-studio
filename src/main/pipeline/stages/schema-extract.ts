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

import { listProjectSchemas } from '../../db/repositories'
import { getPrompt, SCHEMA_VERSION } from '../../llm/prompts'
import type { DocumentFile, Paragraphs, TextPages } from '../capabilities'
import { renderTableCrops } from '../tableCrops'
import type { StageDefinition } from '../types'

const schemaExtract: StageDefinition<{ analysisRunId: number; facts: number }> = {
  id: 'schema-extract',
  label: 'Extract',
  version: '1.9.0',
  rank: 8,
  scope: 'project',
  provides: ['analysis.extraction@v1'],
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

  fingerprint(ctx, fan) {
    // The PROMPT VERSION, because the prompt is an input to this stage in every
    // sense that matters: it decides what the model extracts and what it cites
    // as evidence. Left out, a prompt fix reached nothing — the planner queued
    // the work, the cache answered "identical inputs", and every paper kept the
    // extraction made under the old wording. A rule written to stop evidence
    // being cited to a paper's title shipped, was measured to work, and changed
    // not one stored row.
    const promptVersion = getPrompt('extraction').version

    // The OUTPUT schema version. `SCHEMA_VERSION` governs the shape the model
    // must answer in and is stamped into every run's provenance — so the record
    // said which shape produced a result while the cache served results made
    // under a different one.
    const outputVersion = SCHEMA_VERSION

    const base = `prompt=${promptVersion}|out=${outputVersion}`

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

    const res = await ctx.runAnalysis({
      analysisType: 'extraction',
      docText: body,
      schemaId: ctx.fanOut?.schemaId ?? null,
      documentId: ctx.documentId,
      images: crops.images,
      paragraphIndexMap
    })

    const prompt = getPrompt('extraction')

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
      return { status: 'not-needed', reason: scopeNote }
    }

    return {
      status: 'succeeded',
      result: { analysisRunId: res.analysisRunId, facts: res.factCount },
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
          : [])
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
